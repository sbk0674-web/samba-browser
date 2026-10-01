"""중국 크림 得物 주문 송장 수집 — 폰 得物 앱 주문 상세에서 택배사·운송장을 읽어 삼바 해외송장에 넣는다.

사용자 2026-10-01: "크림 중국계정 삼바 송장수집 및 허브넷 전송에 더우도 추가". 得物은 앱 전용이라 삼바웨이브(도커)가
읽을 수 없다 — 하네스(호스트)가 폰으로 읽는다. 허브넷 전송은 삼바웨이브의 CN 루프가 해외송장 있는 주문을 그대로 보낸다.

주문 찾기: 得物 → 我 → 订单 목록의 검색칸('品牌名/商品名/订单号')에 得物 주문번호 → 결과 → 상세.
송장 읽기: 상세 글자에서 '택배사 이름 + 운송장'(웨이핀후이 수집기와 같은 택배사 목록). 발송 전이면 아무것도 안 한다.
"""

import logging
import re
import threading
import time
from collections.abc import Callable

from samba_agent.ops.ssg_gift_accept import Node, Phone, find_text

log = logging.getLogger(__name__)

DEWU = 'com.shizhuang.duapp'
CARRIERS = (
    '顺丰速运',
    '顺丰',
    '京东物流',
    '京东快递',
    '中通快递',
    '圆通速递',
    '申通快递',
    '韵达快递',
    '极兔速递',
    '德邦快递',
    '邮政快递包裹',
    'EMS',
    '百世快递',
)
_TRK = re.compile(r'(' + '|'.join(CARRIERS) + r')\s*[|｜:：]?\s*(?:运单号|快递单号)?\s*[:：]?\s*([A-Z]{0,3}\d{8,24})')
SEARCH_HINT = '品牌名/商品名/订单号'
INTERVAL_S = 30 * 60


def tracking_of(nodes: list[Node]) -> tuple[str, str] | None:
    """상세 화면 글자에서 (택배사, 운송장). 없으면 None."""
    joined = ' | '.join(n.text for n in nodes if n.text)
    m = _TRK.search(joined)
    if not m:
        return None
    carrier = '顺丰速运' if m.group(1) == '顺丰' else m.group(1)
    return carrier, m.group(2)


def read_dewu_tracking(phone: Phone, order_no: str, *, sleep: Callable[[float], None] = time.sleep) -> tuple[str, str] | None:
    """得物 주문 한 건의 송장. 발송 전·못 찾으면 None."""
    phone.launch(DEWU)
    sleep(4)
    for _ in range(6):
        nodes = phone.nodes()
        if any(n.text == SEARCH_HINT or n.desc == SEARCH_HINT for n in nodes):
            break
        tab = find_text(nodes, '我')
        if tab is not None and tab.y > 1400:
            phone.tap(tab.x, tab.y)
            sleep(3)
            orders = find_text(phone.nodes(), '全部订单') or find_text(phone.nodes(), '待收货')
            if orders is not None:
                phone.tap(orders.x, orders.y)
                sleep(3)
            continue
        phone.key('4')
        sleep(1.5)
    nodes = phone.nodes()
    box = next((n for n in nodes if n.text == SEARCH_HINT or n.desc == SEARCH_HINT), None)
    if box is None:
        return None
    phone.tap(box.x, box.y)
    sleep(2)
    phone._run('shell', 'input', 'keyevent', *(['67'] * 30))
    phone._run('shell', 'input', 'text', order_no)
    phone.key('66')  # ENTER — 검색
    sleep(4)
    nodes = phone.nodes()
    first = next((n for n in sorted(nodes, key=lambda n: n.y) if '实付款' in n.text), None)
    if first is None:
        return None
    phone.tap(360, max(first.y - 40, 300))
    sleep(3)
    for _ in range(4):
        got = tracking_of(phone.nodes())
        if got:
            phone.key('4')
            return got
        phone._run('shell', 'input', 'swipe', '360', '1200', '700', '300')
        sleep(1)
    phone.key('4')
    return None


def collect_dewu_tracking(wave: object, phone: Phone, *, sleep: Callable[[float], None] = time.sleep) -> dict[str, int]:
    """대상 주문들의 송장을 읽어 삼바에 넣는다. 결과 {'checked', 'updated'}."""
    targets = wave.dewu_tracking_targets()  # type: ignore[attr-defined]
    out = {'checked': 0, 'updated': 0}
    for t in targets:
        out['checked'] += 1
        got = read_dewu_tracking(phone, t['sourcing_order_number'], sleep=sleep)
        if not got:
            continue
        carrier, number = got
        wave.write_overseas_tracking(t['order_number'], carrier, number)  # type: ignore[attr-defined]
        out['updated'] += 1
        log.info('[得物 송장] %s → %s %s', t['order_number'], carrier, number)
    phone.key('3')  # HOME
    return out


def start_dewu_tracking_loop(
    wave: object, idle: Callable[[], bool], *, adb: str | None = None, phone_serial: str | None = None
) -> threading.Thread:
    """30분마다(하네스 작업이 없을 때만) 得物 송장을 모은다. 폰이 없으면 그 바퀴는 건너뛴다."""
    import os

    from samba_agent.ops.ssg_gift_accept import DEFAULT_ADB, DEFAULT_PHONE, find_phone_serial

    adb_path = adb or os.environ.get('SAMBA_ADB') or DEFAULT_ADB
    want = phone_serial or os.environ.get('SAMBA_PAY_PHONE') or DEFAULT_PHONE

    def loop() -> None:
        while True:
            time.sleep(INTERVAL_S)
            try:
                if not idle():
                    continue
                if not wave.dewu_tracking_targets():  # type: ignore[attr-defined]
                    continue
                serial = find_phone_serial(adb_path, want)
                if serial is None:
                    continue
                res = collect_dewu_tracking(wave, Phone(adb_path, serial))
                log.info('[得物 송장] 조회 %d · 기입 %d', res['checked'], res['updated'])
            except Exception:
                log.exception('[得物 송장] 수집 실패 — 다음 바퀴에 다시')

    th = threading.Thread(target=loop, name='dewu-tracking', daemon=True)
    th.start()
    return th
