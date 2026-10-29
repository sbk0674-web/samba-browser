"""이미 열려 있는 올바른 당근 계정의 채팅과 주문을 확인한다.

다른 계정 실행·전환은 하지 않는다. 그 경우 공유 계정 전환 절차가 따로
필요하므로 실패로 반환한다. 화면 XML·스크린샷은 메모리에만 둔다.
"""

import glob
import importlib.util
import io
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

from tools.daangn.order_record import match_owned_order, read_pickup_date
from tools.daangn.pickup_dates import choose_pickup_date


class AndroidPhone:
    def __init__(self, *, adb: str, transport: str, serial: str, owner: str,
                 nickname: str, lock_owner: str, attachments: str,
                 journal=None, room_id: str = ''):
        self.adb, self.transport, self.serial = adb, transport, serial
        self.owner, self.nickname, self.lock_owner = owner, nickname, lock_owner
        self.attachments = Path(attachments)
        self.journal, self.room_id = journal, room_id
        spec = importlib.util.spec_from_file_location('shared_phone_lock',
                    r'C:\Users\canno\workspace\phone-locks\phone_lock.py')
        self._locks = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self._locks)

    def _run(self, *args, timeout=20) -> bytes:
        p = subprocess.run([self.adb, '-s', self.transport, *args], capture_output=True, timeout=timeout)
        if p.returncode:
            raise RuntimeError('폰 연결 또는 조작 실패')
        return p.stdout

    def assert_lock(self):
        if self._locks.holder(self.serial) != self.lock_owner:
            raise RuntimeError('폰 공유 잠금 확인 실패')

    def assert_connected(self):
        devices = subprocess.run([self.adb, 'devices'], capture_output=True, timeout=10)
        if devices.returncode or not any(row.split()[:2] == [self.transport, 'device']
                for row in devices.stdout.decode('utf8', 'replace').splitlines()):
            raise RuntimeError('폰 연결 확인 실패')
        if self._run('shell', 'getprop', 'ro.serialno').decode().strip() != self.serial:
            raise RuntimeError('폰 일련번호 불일치')

    def _screen(self) -> tuple[str, ET.Element]:
        text = self._run('exec-out', 'uiautomator', 'dump', '/dev/tty', timeout=20).decode('utf8', 'replace')
        begin, end = text.find('<?xml'), text.rfind('</hierarchy>')
        if begin < 0 or end < 0:
            raise RuntimeError('폰 화면 확인 실패')
        xml = text[begin:end + len('</hierarchy>')]
        return xml, ET.fromstring(xml)

    def _tap_unique(self, root: ET.Element, label: str):
        nodes = [n for n in root.iter('node') if label in (n.get('text', '').strip(), n.get('content-desc', '').strip())]
        # 접근성 트리에 같은 버튼의 텍스트와 컨테이너가 중첩된 경우에는 작은 유효 영역만 사용한다.
        bounds = []
        for n in nodes:
            xy = [int(x) for x in re.findall(r'\d+', n.get('bounds', ''))]
            if len(xy) == 4 and xy[2] > xy[0] and xy[3] > xy[1]:
                bounds.append(xy)
        if not bounds:
            raise RuntimeError('버튼 위치 확인 실패')
        # 서로 겹치지 않는 여러 일치 항목은 선택하지 않는다.
        bounds.sort(key=lambda b: (b[2]-b[0])*(b[3]-b[1]))
        small = bounds[0]
        if any(not (b[0] <= small[0] and b[1] <= small[1] and b[2] >= small[2] and b[3] >= small[3]) for b in bounds[1:]):
            raise RuntimeError('동일 버튼이 여러 개입니다')
        self._run('shell', 'input', 'tap', str((small[0]+small[2])//2), str((small[1]+small[3])//2))
        time.sleep(1)

    def _tap_bounds(self, bounds: str):
        xy = [int(x) for x in re.findall(r'\d+', bounds)]
        if len(xy) != 4 or xy[2] <= xy[0] or xy[3] <= xy[1]:
            raise ValueError('선택 위치 확인 실패')
        self._run('shell', 'input', 'tap', str((xy[0]+xy[2])//2), str((xy[1]+xy[3])//2))
        time.sleep(1)

    def _selected_ring(self, y: int) -> bool:
        """실기에서 확인된 S23 화면의 검은 선택 표시를 읽는다. 다른 배치는 보류한다."""
        from PIL import Image
        with Image.open(io.BytesIO(self._run('exec-out', 'screencap', '-p'))) as src:
            image = src.convert('RGB')
        if image.size != (1080, 2340) or not 50 <= y < 2200:
            raise ValueError('폰 선택 표시 확인 실패')
        # 검은 화면·다크 모드는 확인하지 않는다.
        if min(image.getpixel((20, 300))) < 200:
            raise ValueError('폰 화면 배치 확인 실패')
        x, r = int(image.width * 0.9), 25
        dark = sum(1 for yy in range(y-r, y+r) for xx in range(x-r, x+r)
                   if max(image.getpixel((xx, yy))) < 80)
        return dark >= 250

    def verify_account(self, account: str) -> bool:
        if account != self.owner:
            return False
        focus = self._run('shell', 'dumpsys', 'window').decode('utf8', 'replace')
        current = next((x for x in focus.splitlines() if 'mCurrentFocus=' in x), '')
        # 다른 화면에서 앱·계정을 새로 열어야 하면 반드시 계정 전환 절차로 보낸다.
        if 'com.towneers.www' not in current:
            return False
        _xml, root = self._screen()
        for attempt in range(4):
            labels = [(n.get('text', '') + ' ' + n.get('content-desc', '')).strip() for n in root.iter('node')]
            names = [n for n in root.iter('node') if n.get('text', '').strip() == self.nickname]
            if len(names) == 1 and any(n.get('content-desc', '').strip() == '프로필 보기' for n in root.iter('node')):
                return True
            if any(x in labels for x in ('저장 안 함', '저장하지 않고 나가기', '결제하기', '주문하기')):
                return False
            if any('나의 당근' == (n.get('text', '').strip() or n.get('content-desc', '').strip()) for n in root.iter('node')):
                break
            if attempt == 3:
                return False
            self._run('shell', 'input', 'keyevent', 'KEYCODE_BACK')
            time.sleep(1)
            _xml, root = self._screen()
        self._tap_unique(root, '나의 당근')
        _xml, root = self._screen()
        names = [n for n in root.iter('node') if n.get('text', '').strip() == self.nickname]
        return len(names) == 1

    def open_chat(self, peer: str, title: str, price: int) -> bool:
        _xml, root = self._screen()
        self._tap_unique(root, '채팅')
        for attempt in range(5):
            _xml, root = self._screen()
            found = [n for n in root.iter('node') if n.get('text', '').strip() == peer]
            if found:
                self._tap_unique(root, peer)
                _xml, room = self._screen()
                texts = [n.get('text', '').strip() for n in room.iter('node')]
                return title in texts and f'{price:,}원' in texts
            if attempt < 4:
                self._run('shell', 'input', 'swipe', '500', '1750', '500', '650', '500')
                time.sleep(0.7)
        return False

    def source_for(self, candidate, sale_price: int) -> dict:
        found = []
        for path in glob.iglob(str(self.attachments / 'musinsa-*' / 'listing.json')):
            try:
                with open(path, encoding='utf8') as f:
                    item = json.load(f)
                if (item.get('phone_owner') == candidate.account and item.get('title') == candidate.product_title
                        and str(item.get('status', '')).startswith(('published_verified', 'hidden_sold_source_verified'))):
                    found.append(item)
            except (OSError, ValueError, TypeError):
                continue
        if found and any(x.get('price') != sale_price or not x.get('source_url') for x in found):
            raise ValueError('원본 상품 가격 또는 링크 확인 필요')
        urls = {x.get('source_url') for x in found if x.get('source_url')}
        if len(urls) > 1:
            raise ValueError('원본 상품이 여러 개입니다')
        return {'source_url': next(iter(urls))} if urls else {}

    def progress(self, account: str, title: str, price: int, today: date) -> dict | None:
        xml, root = self._screen()
        texts = [n.get('text', '').strip() for n in root.iter('node')]
        desc = [n.get('content-desc', '').strip() for n in root.iter('node')]
        if '바로구매 진행 현황' not in texts:
            if '진행 현황 보기' in texts or '진행 현황 보기' in desc:
                self._tap_unique(root, '진행 현황 보기')
                xml, root = self._screen()
                texts = [n.get('text', '').strip() for n in root.iter('node')]
            else:
                raise ValueError('바로구매 진행 현황 확인 필요')
        if '수거 번호' not in texts:
            paid = [t for t in texts if re.fullmatch(r'결제완료\s*\d{1,2}월\s*\d{1,2}일\s*결제완료', t)]
            if (len(paid) == 1 and texts.count(title) == 1 and f'{price:,}원' in texts
                    and any('수거' in t and ('선택' in t or '예약' in t) for t in texts)
                    and not any(re.search(r'판매\s*취소\s*완료|거래\s*취소\s*완료|환불\s*완료', t) for t in texts)):
                match = re.search(r'(\d{1,2})월\s*(\d{1,2})일', paid[0])
                month, day = map(int, match.groups())
                paid_date = date(today.year, month, day)
                if paid_date > today:
                    paid_date = date(today.year - 1, month, day)
                return {'awaiting_pickup': True, 'payment_confirmed': True, 'sales_account': account,
                        'product_name': title, 'sale_price': price, 'paid_date': paid_date}
            raise ValueError('수거번호 확인 필요')
        out = match_owned_order(xml, account=account, chat_title=title, chat_price=price)
        out['pickup_date'] = read_pickup_date(xml, now=today)
        match = re.search(r'(\d{1,2})월\s*(\d{1,2})일', out['payment_date_text'])
        if not match:
            raise ValueError('결제일 확인 필요')
        month, day = map(int, match.groups())
        paid = date(today.year, month, day)
        if paid > today:
            paid = date(today.year - 1, month, day)
        out['paid_date'] = paid
        return out

    def reserve_pickup(self, *, is_musinsa: bool, today: date, location: str) -> date:
        if location != '문 앞' or self.journal is None or not self.room_id:
            raise ValueError('수거 장소 또는 중복 방지 기록 확인 필요')
        _xml, root = self._screen()
        texts = [n.get('text', '').strip() for n in root.iter('node')]
        if '바로구매 진행 현황' in texts:
            self._run('shell', 'input', 'keyevent', 'KEYCODE_BACK')
            time.sleep(1)
            _xml, root = self._screen()
        self._tap_unique(root, '날짜 선택하기')
        xml, root = self._screen()
        chosen, bounds = choose_pickup_date(xml, today=today, is_musinsa=is_musinsa)
        xy = [int(x) for x in re.findall(r'\d+', bounds)]
        self._tap_bounds(bounds)
        if not self._selected_ring((xy[1] + xy[3]) // 2):
            raise ValueError('수거일 선택 확인 실패')
        _xml, root = self._screen()
        self._tap_unique(root, '다음')
        _xml, root = self._screen()
        labels = [n.get('text', '').strip() for n in root.iter('node')]
        if not all(x in labels for x in ('어디에서 수거할까요?', '문 앞', '경비실', '직접 입력', '완료')):
            raise ValueError('수거 장소 화면 확인 실패')
        if not labels.index('문 앞') < labels.index('경비실') < labels.index('직접 입력'):
            raise ValueError('수거 장소 배치 확인 실패')
        doors = [n for n in root.iter('node') if n.get('text', '').strip() == '문 앞']
        if len(doors) != 1:
            raise ValueError('문 앞 위치 확인 실패')
        xy = [int(x) for x in re.findall(r'\d+', doors[0].get('bounds', ''))]
        if len(xy) != 4 or xy[2] <= xy[0] or xy[3] <= xy[1]:
            raise ValueError('문 앞 위치 확인 실패')
        y = (xy[1] + xy[3]) // 2
        self._tap_unique(root, '문 앞')
        time.sleep(1)
        if not self._selected_ring(y):
            raise ValueError('문 앞 선택 확인 실패')
        _xml, root = self._screen()
        if not self.journal.begin(self.owner, self.room_id):
            raise ValueError('이미 시도한 수거 예약입니다. 진행 현황 확인 필요')
        self._tap_unique(root, '완료')
        _xml, root = self._screen()
        labels = [n.get('text', '').strip() for n in root.iter('node')]
        if '택배 접수가 완료됐어요' not in labels or not any(f'{chosen.month}월 {chosen.day}일' in t for t in labels):
            raise ValueError('수거 완료 응답 불명확. 진행 현황 확인 필요')
        self._tap_unique(root, '진행 현황 보기')
        return chosen
