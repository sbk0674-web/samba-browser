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
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from tools.daangn.order_record import match_owned_order, read_pickup_date
from tools.daangn.pickup_dates import (
    MissingDateBounds,
    calendar_dates,
    choose_pickup_date,
    detect_radio_rows,
    map_radio_rows,
)


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
                for _ in range(3):
                    _xml, room = self._screen()
                    texts = [n.get('text', '').strip() for n in room.iter('node')]
                    if title in texts and f'{price:,}원' in texts:
                        return True
                    time.sleep(1)
                return False
            if attempt < 4:
                self._run('shell', 'input', 'swipe', '500', '1750', '500', '650', '500')
                time.sleep(0.7)
        return False

    def source_for(self, candidate, sale_price: int) -> dict:
        found = []
        for path in glob.iglob(str(self.attachments / '*' / 'listing.json')):
            try:
                with open(path, encoding='utf8') as f:
                    item = json.load(f)
                if (item.get('phone_owner') == candidate.account and item.get('title') == candidate.product_title
                        and str(item.get('status', '')).startswith(('published_verified', 'hidden_sold_source_verified'))):
                    found.append(item)
            except (OSError, ValueError, TypeError):
                continue
        if found and any(x.get('price') != sale_price or (
                not x.get('source_url') and x.get('source_site') != '보유재고') for x in found):
            raise ValueError('원본 상품 가격 또는 링크 확인 필요')
        owned = [x for x in found if x.get('source_site') == '보유재고' and not x.get('source_url')]
        if owned:
            if len(owned) != len(found):
                raise ValueError('소싱과 보유재고 근거가 충돌합니다')
            return {'source_site': '보유재고', 'source_verified': True}
        urls = {x.get('source_url') for x in found if x.get('source_url')}
        if len(urls) > 1:
            raise ValueError('원본 상품이 여러 개입니다')
        return {'source_url': next(iter(urls))} if urls else {}

    def progress(self, account: str, title: str, price: int, today: date,
                 payment_event_at: datetime | None = None) -> dict | None:
        xml, root = self._screen()
        texts = [n.get('text', '').strip() for n in root.iter('node')]
        desc = [n.get('content-desc', '').strip() for n in root.iter('node')]
        if '날짜 선택하기' in texts + desc and '수거 번호' not in texts:
            if (texts.count(title) != 1 or f'{price:,}원' not in texts
                    or any(re.search(r'판매\s*취소\s*완료|거래\s*취소\s*완료|환불\s*완료', t)
                           for t in texts)):
                raise ValueError('예약 전 채팅카드 상품 또는 취소 상태 확인 실패')
            paid_date = None
            if isinstance(payment_event_at, datetime) and payment_event_at.utcoffset() is not None:
                paid_date = payment_event_at.astimezone(timezone(timedelta(hours=9))).date()
            else:
                paid = [t for t in texts if re.fullmatch(r'결제완료\s*\d{1,2}월\s*\d{1,2}일\s*결제완료', t)]
                if len(paid) == 1:
                    match = re.search(r'(\d{1,2})월\s*(\d{1,2})일', paid[0])
                    month, day = map(int, match.groups())
                    paid_date = date(today.year, month, day)
                    if paid_date > today:
                        paid_date = date(today.year - 1, month, day)
            if paid_date is None or paid_date > today:
                raise ValueError('예약 전 채팅카드 결제일 확인 필요')
            return {'awaiting_pickup': True, 'payment_confirmed': True, 'sales_account': account,
                    'product_name': title, 'sale_price': price, 'paid_date': paid_date}
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

    def _visual_pickup_date(self, xml: str, *, is_musinsa: bool, today: date) -> date:
        dates = calendar_dates(xml, today=today)
        target = len(dates) - 1 if is_musinsa else 0
        chosen = dates[target][0]
        if is_musinsa and chosen <= today + timedelta(days=1):
            raise ValueError('무신사 수거 최후일 확인 필요 — 오늘/내일은 예약하지 않습니다')
        known, previous = None, None
        for _attempt in range(6):
            image = self._run('exec-out', 'screencap', '-p')
            if image == previous:
                raise ValueError('수거일 스크롤 이동 확인 실패')
            rows, known = map_radio_rows(detect_radio_rows(image), len(dates), known)
            row = next((r for r in rows if r['index'] == target), None)
            if row is not None:
                # 원의 실제 경계 중앙을 누른다. XML의 0 좌표나 기기 비율을 쓰지 않는다.
                x1, y1, x2, y2 = row['bounds']
                self._tap_bounds(f'[{x1},{y1}][{x2},{y2}]')
                selected, _ = map_radio_rows(
                    detect_radio_rows(self._run('exec-out', 'screencap', '-p')), len(dates), known)
                if [r['index'] for r in selected if r['selected']] != [target]:
                    raise ValueError('수거 최후일 실제 선택 표시 확인 실패')
                return chosen
            if target < rows[0]['index']:
                raise ValueError('수거일 첫 화면 위치 확인 필요')
            # 실제 보이는 카드들의 공통 내부에서 위로 스크롤한다(고정 좌표 없음).
            left, right = max(r['card'][0] for r in rows), min(r['card'][2] for r in rows)
            x = (left + right) // 2
            start = (rows[-1]['bounds'][1] + rows[-1]['bounds'][3]) // 2
            end = (rows[0]['bounds'][1] + rows[0]['bounds'][3]) // 2
            if right <= left or start <= end:
                raise ValueError('수거일 스크롤 영역 확인 실패')
            self._run('shell', 'input', 'swipe', str(x), str(start), str(x), str(end), '500')
            time.sleep(0.7)
            after, _root = self._screen()
            if calendar_dates(after, today=today) != dates:
                raise ValueError('스크롤 후 수거일 목록 불일치')
            previous = image
        raise ValueError('수거 최후일 스크롤 확인 필요')

    def _visual_pickup_location(self):
        rows = detect_radio_rows(self._run('exec-out', 'screencap', '-p'))
        if len(rows) != 3:
            raise ValueError('수거 장소 시각 행 확인 필요')
        # 호출부에서 XML의 문 앞/경비실/직접 입력 순서를 먼저 검증한다.
        if [i for i, r in enumerate(rows) if r['selected']] == [0]:
            return
        x1, y1, x2, y2 = rows[0]['bounds']
        self._tap_bounds(f'[{x1},{y1}][{x2},{y2}]')
        selected = detect_radio_rows(self._run('exec-out', 'screencap', '-p'))
        if (len(selected) != 3
                or [r['fingerprint'] for r in rows] != [r['fingerprint'] for r in selected]
                or [i for i, r in enumerate(selected) if r['selected']] != [0]):
            raise ValueError('문 앞 실제 선택 표시 확인 실패')

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
        try:
            chosen, bounds = choose_pickup_date(xml, today=today, is_musinsa=is_musinsa)
        except MissingDateBounds:
            chosen = self._visual_pickup_date(xml, today=today, is_musinsa=is_musinsa)
        else:
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
        doors = [n for n in root.iter('node') if '문 앞' in
                 (n.get('text', '').strip(), n.get('content-desc', '').strip())]
        if not doors:
            raise ValueError('문 앞 위치 확인 실패')
        # 같은 선택지의 컨테이너와 글자가 중첩되어도 _tap_unique가 겹침을 검증한다.
        valid = [[int(x) for x in re.findall(r'\d+', n.get('bounds', ''))] for n in doors]
        valid = [b for b in valid if len(b) == 4 and b[2] > b[0] and b[3] > b[1]]
        if not valid:
            self._visual_pickup_location()
        else:
            xy = min(valid, key=lambda b: (b[2]-b[0])*(b[3]-b[1]))
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
