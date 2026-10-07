"""SSG 선물 수락 — 카카오톡 SSG닷컴 방에서 주문번호로 대화를 검색해 그 주문의 수락 알림을 찾아 받는다.

스크롤로 알림을 넘기며 찾던 방식은 알림이 쌓이면 못 찾고 엉뚱한 방을 넘겼다(실기 2026-10-06). 사람이 한 순서 그대로:
SSG닷컴 방 → 검색(주문번호 끝 6자리, 영문·숫자라 폰에 입력된다) → 그 주문의 '전달해드릴게요' 알림에서 받는 분 이름을 읽고
→ 더 최근 알림 중 '임성희님이 〈받는 분〉님에게 보내신 선물을 확인해 주세요' 의 '선물 받으러 가기' → 옵션/배송지 확인 →
'부재 시 문앞에 놓아주세요' → '선물 받기' → 완료 화면.

SSG 결제 화면(인앱 브라우저 웹뷰)의 버튼은 접근성 글자로 안 잡혀 좌표(720×1600 기준)로 누른다. 완료는 화면 제목
('선물 받기 완료, …')으로 확인한다. 고객 이름·주소는 로그·결과에 남기지 않는다.
"""

import re
import time
from collections.abc import Callable

from samba_agent.ops.ssg_gift_accept import (
    CHANNEL,
    DONE,
    GO_LABELS,
    KAKAO,
    GiftAcceptError,
    Node,
    SSG_APP,
    Phone,
    _close_browser,
    find_text,
    has_text,
)

# 720×1600 기준 좌표
SEARCH_ICON = (588, 104)
CHECK_BTN_XY = (360, 1460)  # '옵션/배송지 확인'(웹뷰 맨 아래 고정 버튼)
DOOR_XY = (200, 875)  # '부재 시 문앞에 놓아주세요'(폼을 끝까지 내렸을 때)
ACCEPT_XY = (360, 1375)  # '선물 받기'
LATER_XY = (200, 1092)  # 리뷰 팝업 '다음에 할게요!'
MAX_PAGES = 10

_RECIPIENT_RE = re.compile(r'(\S+?)님에게')
_NOTICE_TITLE = '보내신 선물을 확인해'


def order_code_of(order_no: str) -> str:
    """검색어 — SSG 주문번호('20261004DCB6EC' · '2026-10-04-DCB6EC')의 끝 6자리(영문·숫자)."""
    clean = re.sub(r'[^0-9A-Za-z]', '', order_no or '')
    return clean[-6:] if len(clean) >= 6 else ''


def recipient_of(text: str) -> str | None:
    """'이은채님에게 임성희님의 마음을 담은 선물을 전달해드릴게요!' 에서 받는 분 이름."""
    m = _RECIPIENT_RE.search(text or '')
    return m.group(1) if m else None


def accept_ssg_gift_by_search(
    phone: Phone,
    order_no: str,
    *,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """주문번호로 SSG 선물 수락 알림을 찾아 받는다. 성공하면 결과 한 줄, 실패하면 GiftAcceptError."""
    code = order_code_of(order_no)
    if not code:
        raise GiftAcceptError('SSG 주문번호를 몰라 카카오톡에서 검색할 수 없다')

    def wait_for(
        check: Callable[[list[Node]], bool], seconds: float, step: float = 1.5
    ) -> list[Node]:
        end = time.monotonic() + seconds
        nodes = phone.nodes()
        while not check(nodes) and time.monotonic() < end:
            sleep(step)
            nodes = phone.nodes()
        return nodes

    def has_any_text(ns: list[Node]) -> bool:
        return any(n.text for n in ns)

    def in_ssg_room(ns: list[Node]) -> bool:
        # 방 안은 위 막대의 '알림톡 차단'이 있고 말풍선 보낸 이 이름이 'SSG닷컴'이다(방 제목은 덤프에 안 나온다, 실기 2026-10-06)
        return any(n.text == '알림톡 차단' for n in ns) and any(n.text == CHANNEL for n in ns)

    # 1) 카카오톡 → SSG닷컴 방(다른 방·검색창이 열려 있으면 뒤로 나온다). 앞에 SSG 앱·토스 같은 다른 앱이 있으면
    # 카카오톡이 앞으로 안 올 수 있어 홈으로 나간 뒤 연다(실기 2026-10-06)
    phone.key('3')  # HOME
    sleep(1)
    phone.launch(KAKAO)
    sleep(3)
    nodes = wait_for(has_any_text, 25)
    for _ in range(5):
        if in_ssg_room(nodes):
            break
        room = find_text(nodes, CHANNEL)
        if room is not None and room.y > 200:
            phone.tap(room.x, room.y)
            sleep(3)
        else:
            phone.key('4')  # BACK
            sleep(1.5)
        nodes = wait_for(has_any_text, 10)
    else:
        raise GiftAcceptError('카카오톡에서 SSG닷컴 방을 열지 못했다')

    # 2) 방 안 검색 — 주문번호가 들어 있는 '전달해드릴게요' 알림으로 간다
    phone.tap(*SEARCH_ICON)
    sleep(1.5)
    phone.input_text(code)
    sleep(1)
    phone.key('66')  # ENTER
    sleep(3)
    nodes = phone.nodes()
    hit = next((n for n in nodes if code in n.text and '전달해드릴게요' in n.text), None)
    if hit is None:
        # 검색 결과로 이동했지만 알림이 화면 밖일 수 있다 — 조금만 올려 본다
        phone.swipe_down()
        sleep(1.2)
        nodes = phone.nodes()
        hit = next((n for n in nodes if code in n.text and '전달해드릴게요' in n.text), None)
    if hit is None:
        _leave(phone, sleep)
        raise GiftAcceptError('카카오톡 SSG닷컴 방에서 이 주문번호의 알림을 못 찾았다')
    who = recipient_of(hit.text)
    if not who:
        _leave(phone, sleep)
        raise GiftAcceptError('알림에서 받는 분을 읽지 못했다')

    # 3) 더 최근 알림에서 그 받는 분의 수락 알림('선물 받으러 가기')을 찾는다 — 아래(최근) 쪽으로 넘기며 본다
    button: Node | None = None
    for _ in range(MAX_PAGES):
        screen = phone.nodes()
        target = next((n for n in screen if _NOTICE_TITLE in n.text and f'{who}님에게' in n.text), None)
        if target is not None:
            below = [b for b in screen if b.text in GO_LABELS and b.y > target.y]
            if below:
                button = min(below, key=lambda b: b.y)
                break
        phone.swipe_up()
        sleep(1.2)
    if button is None:
        _leave(phone, sleep)
        raise GiftAcceptError('이 받는 분의 수락 알림(선물 받으러 가기)을 못 찾았다')

    # 4) 수락 화면 — 웹뷰 버튼은 좌표로 누른다
    phone.tap(button.x, button.y)
    sleep(4)
    if phone.top_package() == SSG_APP:
        # '선물 확인하기'류는 SSG 앱으로 열린다 — 이 화면은 좌표로 받지 않고 사람에게 넘긴다(받았다고 하지 않는다)
        phone.key('3')
        raise GiftAcceptError('수락 알림이 SSG 앱으로 열렸다 — 이미 받았거나 앱 화면이라 사람이 확인')
    nodes = wait_for(lambda ns: any('선물 받기' in n.text or '배송정보' in n.text for n in ns), 40)
    if has_text(nodes, DONE):
        _close_browser(phone, sleep)
        return '이미 받은 선물(완료 화면) — 브라우저 닫음'
    sleep(3)
    phone.tap(*CHECK_BTN_XY)
    nodes = wait_for(lambda ns: any('배송정보' in n.text for n in ns), 25)
    if not any('배송정보' in n.text for n in nodes):
        _close_browser(phone, sleep)
        raise GiftAcceptError('옵션/배송지 확인 뒤 배송정보 입력 화면이 안 떴다')
    sleep(2)
    phone.swipe_up()
    sleep(1.5)
    phone.tap(*DOOR_XY)
    sleep(1.2)
    phone.tap(*ACCEPT_XY)
    nodes = wait_for(lambda ns: has_text(ns, DONE), 25)
    if not has_text(nodes, DONE):
        _close_browser(phone, sleep)
        raise GiftAcceptError('"선물 받기"를 눌렀지만 완료 화면이 안 떴다 — 사람이 확인')
    phone.tap(*LATER_XY)  # 리뷰 팝업
    sleep(1.5)
    _close_browser(phone, sleep)
    return '선물 받기 완료(부재 시 문앞, 카톡 검색) — 브라우저 닫음'


def _leave(phone: Phone, sleep: Callable[[float], None]) -> None:
    """검색 창을 닫고 홈으로 나간다."""
    phone.key('4')
    sleep(1)
    phone.key('3')
