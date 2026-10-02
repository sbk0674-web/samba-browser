"""롯데ON 선물 주문 송장 수집 — 폰 카카오톡 '롯데ON' 알림톡에서 택배사·송장을 읽어 삼바에 넣고 마켓으로 보낸다.

사용자 2026-10-02: "롯데온 선물하기 주문은 송장이 카카오톡 모바일로만 와서 웹에서 못 긁는다 … 삼바에 송장전송".
PC 카카오톡 화면을 OCR 로 읽던 방식은 숫자를 자주 틀렸다 — 여기서는 폰 화면의 글자(uiautomator)를 그대로 읽는다.

알림 두 가지가 짝으로 온다(실기 2026-10-02, 결제 폰 한 대가 보내는 사람·받는 사람 번호를 겸한다).
- 받는 사람 쪽 '[롯데ON] <보낸이>님의 선물 배송시작 안내'(배송완료 안내도 같다): 상품명 · 택배사 · 송장번호
- 보낸 사람 쪽 '[롯데ON] 선물 배송시작 안내': 상품명 · 주문번호(= 삼바의 소싱주문번호) · 주문일자
받는 사람 이름과 상품명이 같은 짝에서 주문번호를 얻어 삼바 주문을 정한다. 짝이 없으면 이름·품번으로 찾는다
(주문 정하기와 '정확히 1건일 때만' 규칙은 삼바웨이브 PUT /lotteon-gift-tracking 이 한다).

폰은 결제 승인에도 쓴다 — 대기·실행 중인 주문 작업이 없을 때만 돌고, 도는 중에 작업이 생기면 바로 손을 뗀다.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from samba_agent.ops.ssg_gift_accept import (
    DEFAULT_ADB,
    DEFAULT_PHONE,
    KAKAO,
    PHONE_BUSY,
    Node,
    Phone,
    find_phone_serial,
)

log = logging.getLogger(__name__)

ROOM = '롯데ON'
PREFIX = '[롯데ON]'
INTERVAL_S = 20 * 60
# 방을 위로 올려 보는 쪽 수 — 한 쪽에 알림 두세 개가 보인다
MAX_PAGES = 14
# 새 알림이 없는 쪽이 이만큼 이어지면 그만 올린다
QUIET_PAGES = 3
# 삼바가 '맞는 주문 없음'으로 건너뛴 송장을 다시 보내 보는 횟수(이름·품번이 안 맞는 건 다시 해도 같다)
MAX_TRIES = 3
SEEN_FILE = 'lotteon_gift_seen.json'

_FIELD = re.compile(r'^\s*▶\s*([^:：]+?)\s*[:：]\s*(.+?)\s*$', re.MULTILINE)
_GREETING = re.compile(r'안녕하세요[,.\s]*(.+?)님')
_TO = re.compile(r'^\s*(.+?)님께 선물하신', re.MULTILINE)
_TITLE_SENDER = re.compile(r'\]\s*(.+?)님의 선물 배송')


@dataclass(frozen=True)
class GiftNotice:
    """알림 한 개. number 가 있으면 송장 알림, order_no 가 있으면 보낸 사람 쪽 알림."""

    recipient: str
    product: str
    carrier: str = ''
    number: str = ''
    order_no: str = ''


def name_key(name: str) -> str:
    """이름 비교용 — 빈칸을 없애고, 가려진 글자('*')는 주문서에 넣은 'O'로 본다."""
    return re.sub(r'\s+', '', name).replace('*', 'O').upper()


def parse_notice(text: str) -> GiftNotice | None:
    """알림 글 → 선물 배송 알림. 다른 알림(주문완료·도착·상담·일반 배송)은 None."""
    if not text.startswith(PREFIX):
        return None
    title = text.split('\n', 1)[0]
    if '선물 배송시작 안내' not in title and '선물 배송완료 안내' not in title:
        return None
    fields = {k.strip(): v.strip() for k, v in _FIELD.findall(text)}
    product = fields.get('상품명', '')
    if not product:
        return None
    greeting = _GREETING.search(text)
    to = _TO.search(text)
    number = re.sub(r'\D', '', fields.get('송장번호', ''))
    if number:
        # 받는 사람 쪽 알림 — 제목의 이름이 보낸 사람이고, 인사말의 이름이 받는 사람이다
        sender = _TITLE_SENDER.search(title)
        names = [m.group(1).strip() for m in (greeting, to) if m]
        others = [n for n in names if not sender or name_key(n) != name_key(sender.group(1))]
        recipient = others[0] if others else (names[0] if names else '')
        return GiftNotice(
            recipient=recipient, product=product, carrier=fields.get('택배사', ''), number=number
        )
    order_no = re.sub(r'\D', '', fields.get('주문번호', ''))
    if not order_no or to is None:
        return None
    return GiftNotice(recipient=to.group(1).strip(), product=product, order_no=order_no)


def pair_order_no(notice: GiftNotice, all_notices: list[GiftNotice]) -> str:
    """송장 알림의 짝(받는 사람·상품명이 같은 보낸 사람 쪽 알림)에서 주문번호. 없거나 둘 이상이면 빈 글.

    상품명만으로는 짝짓지 않는다 — 같은 상품을 여러 고객이 사면 남의 주문번호를 집는다.
    """
    key = (name_key(notice.recipient), notice.product)
    found = {
        n.order_no for n in all_notices if n.order_no and (name_key(n.recipient), n.product) == key
    }
    return next(iter(found)) if len(found) == 1 and notice.recipient else ''


def open_room(phone: Phone, *, sleep: Callable[[float], None] = time.sleep) -> bool:
    """카카오톡 '롯데ON' 방을 맨 아래(최근 알림)에서 연다."""
    phone.launch(KAKAO)
    sleep(3)
    for _ in range(5):
        nodes = phone.nodes()
        room = _room_row(nodes)
        if room is not None:
            phone.tap(room.x, room.y)
            sleep(3)
            return any(n.text.startswith(PREFIX) for n in phone.nodes())
        # 다른 방·다른 화면이면 채팅 목록까지 뒤로 나온다(이미 그 방 안이어도 나갔다 들어와 맨 아래로 간다)
        phone.key('4')
        sleep(1.5)
        if phone.top_package() != KAKAO:
            phone.launch(KAKAO)
            sleep(3)
    return False


def _room_row(nodes: list[Node]) -> Node | None:
    """채팅 목록의 '롯데ON' 줄. 방 안(알림 글이 보이는 화면)의 제목은 치지 않는다."""
    if any(n.text.startswith(PREFIX) for n in nodes):
        return None
    return next((n for n in nodes if n.text == ROOM), None)


def read_notices(
    phone: Phone,
    *,
    idle: Callable[[], bool] | None = None,
    max_pages: int = MAX_PAGES,
    known: Callable[[str], bool] = lambda number: False,
    sleep: Callable[[float], None] = time.sleep,
) -> list[GiftNotice] | None:
    """방을 위로 올려 가며 선물 배송 알림을 모은다. 방을 못 열었거나 도중에 주문 작업이 시작되면 None.

    known(송장번호)가 참인 알림만 나오는 쪽이 QUIET_PAGES 번 이어지면 멈춘다 — 이미 처리한 옛 알림이다.
    """
    if not open_room(phone, sleep=sleep):
        return None
    texts: set[str] = set()
    out: list[GiftNotice] = []
    quiet = 0
    for _ in range(max_pages):
        if idle is not None and not idle():
            return None
        fresh = False
        for node in phone.nodes():
            if not node.text.startswith(PREFIX) or node.text in texts:
                continue
            texts.add(node.text)
            notice = parse_notice(node.text)
            if notice is None:
                continue
            out.append(notice)
            if notice.number and not known(notice.number):
                fresh = True
        quiet = 0 if fresh else quiet + 1
        if quiet >= QUIET_PAGES:
            break
        # 옛 알림 쪽으로 — 손가락을 아래로 끈다
        phone._run('shell', 'input', 'swipe', '360', '500', '360', '1300', '400')
        sleep(1.2)
    return out


class SeenStore:
    """끝난 송장(넣었거나, 이미 들어 있거나, 여러 번 해도 안 맞는 것)을 기억한다 — 같은 알림을 매번 보내지 않게."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._data: dict[str, dict[str, object]] = {}
        try:
            raw = json.loads(path.read_text(encoding='utf-8'))
            if isinstance(raw, dict):
                self._data = {str(k): v for k, v in raw.items() if isinstance(v, dict)}
        except (OSError, ValueError):
            pass

    def done(self, number: str) -> bool:
        row = self._data.get(number)
        return bool(row and (row.get('done') or int(str(row.get('tries') or 0)) >= MAX_TRIES))

    def mark(self, number: str, *, done: bool, note: str) -> None:
        row = self._data.setdefault(number, {'tries': 0})
        row['tries'] = int(str(row.get('tries') or 0)) + 1
        row['done'] = done
        row['note'] = note[:80]
        row['at'] = int(time.time())
        try:
            self._path.write_text(json.dumps(self._data, ensure_ascii=False), encoding='utf-8')
        except OSError:
            log.exception('[롯데ON 선물 송장] 처리 기록 저장 실패')


def collect_lotteon_gift_tracking(
    wave: object,
    phone: Phone,
    seen: SeenStore,
    *,
    idle: Callable[[], bool] | None = None,
    dry_run: bool = False,
    max_pages: int = MAX_PAGES,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, int] | None:
    """알림을 읽어 새 송장을 삼바에 넣는다. 결과 {'read', 'sent', 'skipped'} — 폰을 못 읽었으면 None."""
    notices = read_notices(phone, idle=idle, max_pages=max_pages, known=seen.done, sleep=sleep)
    phone.key('4')
    phone.key('3')  # HOME
    if notices is None:
        return None
    out = {'read': 0, 'sent': 0, 'skipped': 0}
    numbers: set[str] = set()
    for notice in notices:
        if not notice.number or notice.number in numbers:
            continue  # 배송시작·배송완료 알림은 같은 송장을 두 번 알린다
        numbers.add(notice.number)
        out['read'] += 1
        if seen.done(notice.number):
            continue
        res = wave.write_lotteon_gift_tracking(  # type: ignore[attr-defined]
            company=notice.carrier or '롯데택배',
            number=notice.number,
            sourcing_order_number=pair_order_no(notice, notices),
            customer_name=notice.recipient,
            product_text=notice.product,
            dry_run=dry_run,
        )
        action = str(res.get('action') or '')
        reason = str(res.get('reason') or '')
        order_no = str(res.get('order_number') or '')
        if action == 'shipped':
            out['sent'] += 1
            sent = bool(res.get('market_sent'))
            seen.mark(
                notice.number, done=True, note=f'{order_no} 마켓전송 {"성공" if sent else "실패"}'
            )
            # 고객 이름은 로그에 남기지 않는다 — 주문번호·송장만
            log.info(
                '[롯데ON 선물 송장] %s ← %s %s (%s로 찾음) 마켓전송 %s%s',
                order_no, notice.carrier, notice.number, reason, '성공' if sent else '실패',
                '' if sent else f' — {res.get("message") or ""}',
            )  # fmt: skip
        elif action == 'dry_run':
            out['sent'] += 1
            log.info(
                '[롯데ON 선물 송장] (시험) %s ← %s %s (%s로 찾음)',
                order_no,
                notice.carrier,
                notice.number,
                reason,
            )
        else:
            out['skipped'] += 1
            if not dry_run:
                seen.mark(notice.number, done=bool(res.get('ok')), note=reason)
            log.info(
                '[롯데ON 선물 송장] 건너뜀 %s — %s (%s)', notice.number, reason, notice.product[:30]
            )
    return out


def start_lotteon_gift_tracking_loop(
    wave: object,
    idle: Callable[[], bool],
    *,
    state_dir: Path,
    adb: str | None = None,
    phone_serial: str | None = None,
) -> threading.Thread:
    """20분마다(주문 작업이 없을 때만) 롯데ON 선물 송장을 모은다. 폰이 없으면 그 바퀴는 건너뛴다."""
    adb_path = adb or os.environ.get('SAMBA_ADB') or DEFAULT_ADB
    want = phone_serial or os.environ.get('SAMBA_PAY_PHONE') or DEFAULT_PHONE
    seen = SeenStore(state_dir / SEEN_FILE)

    def loop() -> None:
        # 켜자마자 한 번 돈다 — 재시작이 잦은 날에도 밀리지 않게
        wait = 90.0
        while True:
            time.sleep(wait)
            wait = INTERVAL_S
            try:
                if not idle():
                    wait = 120.0  # 작업이 끝나는 대로 다시 본다
                    continue
                serial = find_phone_serial(adb_path, want)
                if serial is None:
                    continue
                with PHONE_BUSY:
                    res = collect_lotteon_gift_tracking(
                        wave, Phone(adb_path, serial), seen, idle=idle
                    )
                if res is None:
                    wait = 120.0
                    log.info(
                        '[롯데ON 선물 송장] 방을 못 열었거나 주문 작업이 시작돼 멈춤 — 곧 다시'
                    )
                else:
                    log.info(
                        '[롯데ON 선물 송장] 읽음 %d · 기입 %d · 건너뜀 %d',
                        res['read'],
                        res['sent'],
                        res['skipped'],
                    )
            except Exception:
                log.exception('[롯데ON 선물 송장] 수집 실패 — 다음 바퀴에 다시')

    th = threading.Thread(target=loop, name='lotteon-gift-tracking', daemon=True)
    th.start()
    return th


def main() -> None:
    """손으로 한 번 돌린다: python -m samba_agent.ops.lotteon_gift_tracking [--send] [쪽수]. 기본은 시험(넣지 않음)."""
    import sys

    from samba_agent.__main__ import make_wave
    from samba_agent.settings import load_settings

    logging.basicConfig(level=logging.INFO, format='%(message)s')
    send = '--send' in sys.argv[1:]
    pages = next((int(a) for a in sys.argv[1:] if a.isdigit()), MAX_PAGES)
    settings = load_settings()
    wave = make_wave(settings)
    serial = find_phone_serial(
        os.environ.get('SAMBA_ADB') or DEFAULT_ADB,
        os.environ.get('SAMBA_PAY_PHONE') or DEFAULT_PHONE,
    )
    if wave is None or serial is None:
        raise SystemExit('삼바웨이브 설정 또는 폰이 없다')
    seen = SeenStore(settings.db_path.parent / SEEN_FILE)
    with PHONE_BUSY:
        res = collect_lotteon_gift_tracking(
            wave,
            Phone(os.environ.get('SAMBA_ADB') or DEFAULT_ADB, serial),
            seen,
            dry_run=not send,
            max_pages=pages,
        )
    print(res)


if __name__ == '__main__':
    main()
