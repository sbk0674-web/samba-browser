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
    ACCEPT,
    CHANNEL,
    CHECK_BTN,
    CLOSE_ID,
    CONSENT,
    DONE,
    DOOR,
    GO_LABELS,
    KAKAO,
    LATER,
    SSG_APP,
    GiftAcceptError,
    Node,
    Phone,
    _close_browser,
    find_text,
    has_text,
    same_product,
    wait_foreground,
)

# 720×1600 기준 좌표
SEARCH_ICON = (588, 104)
CHAT_TAB_XY = (220, 1435)
GLOBAL_SEARCH_XY = (512, 104)
GLOBAL_SEARCH_INPUT_XY = (160, 105)
SSG_SEARCH_WORD = 'SSG'
DOOR_XY = (55, 1060)  # '부재 시 문앞에 놓아주세요'
ACCEPT_XY = (360, 1375)  # '선물 받기'
LATER_XY = (200, 1092)  # 리뷰 팝업 '다음에 할게요!'
MAX_PAGES = 10
BUBBLE_BUTTON_GAP_Y = 310


class UserPhoneScreenInUse(OSError):
    """사용자 화면 보호 중단은 검색 실패의 옛 수락 경로로 재시도하지 않는다."""

_RECIPIENT_RE = re.compile(r'(\S+?)님에게')
_NOTICE_TITLE = '보내신 선물을 확인해'
_ARRIVAL_TITLE = '도착했어요'
_DETAIL_LABEL = '선물 자세히 보기'
_GENERIC_PRODUCT_WORDS = frozenset(
    {'매장정품', '정품', '남성', '여성', '공용', '아동', '키즈', '신발', '의류', '선물'}
)


def order_code_of(order_no: str) -> str:
    """검색어 — SSG 주문번호('20261004DCB6EC' · '2026-10-04-DCB6EC')의 끝 6자리(영문·숫자)."""
    clean = re.sub(r'[^0-9A-Za-z]', '', order_no or '')
    return clean[-6:] if len(clean) >= 6 else ''


def recipient_of(text: str) -> str | None:
    """'이은채님에게 임성희님의 마음을 담은 선물을 전달해드릴게요!' 에서 받는 분 이름."""
    m = _RECIPIENT_RE.search(text or '')
    return m.group(1) if m else None


def product_words_of(text: str) -> set[str]:
    """카톡 알림 상품명에서 비교에 쓸 낱말을 뽑는다."""
    m = re.search(r'상품명\s*[:：]\s*([^\n]+)', text or '')
    if not m:
        return set()
    return {
        w
        for w in re.split(r'[^0-9A-Za-z가-힣]+', m.group(1))
        if len(w) >= 2 and w not in _GENERIC_PRODUCT_WORDS
    }


def same_bubble_button(nodes: list[Node], target: Node, labels: tuple[str, ...]) -> Node | None:
    """대상 알림 바로 아래 같은 말풍선 버튼만 고른다. 멀리 떨어진 다른 주문 버튼은 누르지 않는다."""
    buttons = [
        n
        for n in nodes
        if n.text in labels
        and 0 < n.y - target.y <= BUBBLE_BUTTON_GAP_Y
        and abs(n.x - target.x) <= 180
    ]
    return min(buttons, key=lambda n: n.y) if buttons else None


def room_node(nodes: list[Node]) -> Node | None:
    """카카오 검색 결과의 SSG닷컴 방. 행 전체 글자에 대화 미리보기가 붙어도 잡는다."""
    exact = find_text(nodes, CHANNEL)
    if exact is not None:
        return exact
    return next((n for n in nodes if CHANNEL in n.text and n.y > 200), None)


def in_ssg_room(nodes: list[Node]) -> bool:
    return any(n.text == '알림톡 차단' for n in nodes) and any(
        n.text == CHANNEL
        or (n.desc == CHANNEL and n.rid.endswith(':id/toolbar_default_title_text'))
        for n in nodes
    )


def matching_notice(nodes: list[Node], who: str, words: set[str]) -> Node | None:
    notices = [
        n
        for n in nodes
        if (_NOTICE_TITLE in n.text or _ARRIVAL_TITLE in n.text)
        and f'{who}님에게' in n.text
        and _DETAIL_LABEL not in n.text
    ]
    if not words:
        return notices[0] if notices else None
    for n in notices:
        if product_words_of(n.text) & words:
            return n
    return None


def gift_overlay(nodes: list[Node]) -> bool:
    return any(node.desc.lower() in ('close', '닫기') and node.rid != CLOSE_ID for node in nodes)


def gift_check_button(phone: Phone, nodes: list[Node]) -> Node | None:
    if gift_overlay(nodes):
        raise GiftAcceptError('광고 팝업이 선물 화면을 가림 — AI 화면 복구 필요')
    check = next((node for node in nodes if CHECK_BTN in node.text and 150 < node.y < 1510), None)
    if check is not None and phone.top_package() == SSG_APP:
        def overlaps(ns: list[Node], btn: Node) -> bool:
            navigation = [node for node in ns if '홈으로 이동' in node.desc]
            return any(abs(node.x - btn.x) < 120 and abs(node.y - btn.y) < 80 for node in navigation)

        if overlaps(nodes, check):
            # SSG 앱 아래 메뉴 막대가 버튼과 겹친다 — 조금 올려 막대를 숨기고 다시 본다(accept_ssg_gift 와 같은 방법).
            # 그래도 겹치면 홈을 잘못 누를 수 있어 멈춘다(실기 2026-11-04 53B45C: 겹침으로 수락 못 함)
            phone.swipe_up()
            time.sleep(1.5)
            nodes = phone.nodes()
            check = next((node for node in nodes if CHECK_BTN in node.text and 150 < node.y < 1510), None)
            if check is not None and overlaps(nodes, check):
                raise GiftAcceptError('선물 버튼과 SSG 하단 홈 좌표가 겹침 — AI 화면 복구 필요')
    return check


def accept_ssg_gift_by_search(
    phone: Phone,
    order_no: str,
    *,
    sku: str = '',
    model_code: str = '',
    verify_only: bool = False,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """주문번호로 SSG 선물 수락 알림을 찾아 받는다. 성공하면 결과 한 줄, 실패하면 GiftAcceptError."""
    code = order_code_of(order_no)
    if not code:
        raise GiftAcceptError('SSG 주문번호를 몰라 카카오톡에서 검색할 수 없다')
    foreground = phone.top_package()
    if 'alipay' in foreground.lower():
        raise UserPhoneScreenInUse('알리페이 복구 화면 사용 중 — 폰 조작 중단')
    if foreground not in (KAKAO, SSG_APP, 'com.sec.android.app.launcher', 'com.android.launcher', 'com.android.launcher3', 'launcher'):
        raise UserPhoneScreenInUse('사용자 폰 화면 사용 중 — 선물 수락 조작 중단')

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

    def require_kakao() -> None:
        if phone.top_package() != KAKAO:
            raise GiftAcceptError('폰이 다른 앱으로 전환됨 — 추가 조작 중단')

    def find_part(ns: list[Node], part: str) -> Node | None:
        return next((n for n in ns if part in n.text), None)

    def open_ssg_room_from_chat_list() -> list[Node]:
        # 카카오가 친구 탭에서 뜨면 SSG 방을 못 찾는다. 채팅 탭에서 보이는 방을 먼저 누르고,
        # 안 보이면 카카오 검색에 SSG 를 입력해 SSG닷컴 방을 연다.
        require_kakao()
        phone.tap(*CHAT_TAB_XY)
        sleep(1.5)
        ns = wait_for(has_any_text, 8)
        room = room_node(ns)
        if room is not None and room.y > 200:
            phone.tap(room.x, room.y)
            sleep(2.5)
            return wait_for(has_any_text, 8)
        require_kakao()
        phone.tap(*GLOBAL_SEARCH_XY)
        sleep(1)
        phone.tap(*GLOBAL_SEARCH_INPUT_XY)
        sleep(0.3)
        phone.input_text(SSG_SEARCH_WORD)
        sleep(2)
        ns = wait_for(lambda ns: room_node(ns) is not None, 12)
        room = room_node(ns)
        if room is not None:
            phone.tap(room.x, room.y)
            sleep(2.5)
        return wait_for(has_any_text, 8)

    # 1) 카카오톡 → SSG닷컴 방(다른 방·검색창이 열려 있으면 뒤로 나온다). 앞에 SSG 앱·토스 같은 다른 앱이 있으면
    # 카카오톡이 앞으로 안 올 수 있어 홈으로 나간 뒤 연다(실기 2026-10-06)
    phone.key('3')  # HOME
    sleep(1)
    phone.wake()
    phone._run('shell', 'am', 'start', '-n', KAKAO + '/.activity.SplashActivity')
    if not wait_foreground(phone, KAKAO, 25, sleep):
        phone.launch(KAKAO)
        if not wait_foreground(phone, KAKAO, 25, sleep):
            _leave(phone, sleep)
            raise GiftAcceptError('카카오톡을 앞으로 열지 못했다 — 다른 앱에서 수락하지 않음')
    nodes = wait_for(has_any_text, 25)
    if not in_ssg_room(nodes):
        nodes = open_ssg_room_from_chat_list()
    for _ in range(5):
        if in_ssg_room(nodes):
            break
        require_kakao()
        room = room_node(nodes)
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
    require_kakao()
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
    product_words = product_words_of(hit.text)

    # 3) 더 최근 알림에서 그 받는 분의 수락 알림('선물 받으러 가기')을 찾는다 — 아래(최근) 쪽으로 넘기며 본다
    button: Node | None = None
    for _ in range(MAX_PAGES):
        screen = phone.nodes()
        target = matching_notice(screen, who, product_words)
        if target is not None:
            button = same_bubble_button(screen, target, GO_LABELS)
            if button is not None:
                break
        phone.swipe_up()
        sleep(1.2)
    if button is None:
        detail = same_bubble_button(phone.nodes(), hit, (_DETAIL_LABEL,))
        _leave(phone, sleep)
        if detail is not None:
            raise GiftAcceptError('받는 사람 수락 알림 없음 — 현재 보이는 건 보낸 사람 주문상세 버튼뿐이다')
        raise GiftAcceptError('이 받는 분의 수락 알림(선물 받으러 가기)을 못 찾았다')

    # 4) 수락 화면 — 웹뷰 버튼은 좌표로 누른다
    require_kakao()
    phone.tap(button.x, button.y)
    sleep(4)
    nodes = wait_for(
        lambda ns: any(
            '선물 받기' in n.text or '배송정보' in n.text or n.text.strip() == LATER for n in ns
        ),
        40,
    )
    # '선물 받기 완료' 화면 위에 "SSG닷컴의 선물도 받아보세요 … 다음에 할게요! / 선물함 담기" 안내가 덮여
    # 완료 글자가 안 읽힌다 — 안내를 닫고 다시 읽는다(실기 2026-10-14 E746D6: 이미 받은 선물을 '버튼 없음'으로 오판)
    later = next((n for n in nodes if n.text.strip() == LATER and n.y > 0), None)
    if later is not None:
        phone.tap(later.x, later.y)
        sleep(2)
        nodes = phone.nodes()
    if sku and not same_product(model_code, sku, [n.text for n in nodes]):
        _close_browser(phone, sleep)
        raise GiftAcceptError('열린 선물 화면의 상품이 이 주문 상품과 다르다 — 수락 중단')
    if has_text(nodes, DONE):
        _close_browser(phone, sleep)
        return '이미 받은 선물(상품 대조·완료 화면) — 브라우저 닫음'
    if verify_only:
        _close_browser(phone, sleep)
        raise GiftAcceptError('독립 재확인에서 선물 수락 완료 미확인 — 수락 동작 없이 종료')
    sleep(3)
    # 버튼 글자 뒤에 기한 안내가 붙고('옵션/배송지 확인 10/18(일) 23:59까지 …') 화면이 늦게 그려진다 —
    # 다시 읽으며 기다리고, 화면 아래라 좌표가 0 이면 올려서 찾는다(실기 2026-10-14: 3일째 미수락 F3E61B)
    check = None
    for _ in range(5):
        nodes = phone.nodes()
        check = gift_check_button(phone, nodes)
        if check is not None:
            break
        if any(CHECK_BTN in n.text for n in nodes):
            phone.swipe_up()
        sleep(2)
    if check is None:
        raise GiftAcceptError('"옵션/배송지 확인" 버튼 미확인 — 배송지와 수락 버튼을 임의로 누르지 않음')
    phone.tap(check.x, check.y)
    # 배송지가 저장된 받는 분은 '배송정보 입력' 제목 없이 '선물을 쓱-배송해 드릴게요 … 배송지 : 우리집' 화면이 뜬다
    # (실기 2026-10-14: 000D89·0A6DEC 가 이 화면에서 멈춤) — 선물 받기 버튼이 있는 화면이면 같은 단계로 본다
    on_form = lambda ns: any(
        '배송정보' in n.text or '선물을 쓱-배송해' in n.text or n.text.strip() == ACCEPT for n in ns
    )
    nodes = wait_for(on_form, 25)
    if not on_form(nodes):
        raise GiftAcceptError('옵션/배송지 확인 뒤 배송정보 입력 화면이 안 떴다')
    sleep(2)
    # 문앞 배송·개인정보 동의·'선물 받기' 는 화면 아래에 있어 좌표가 0 으로 읽힌다 — 보일 때까지 올린다
    visible = lambda ns, part: next((n for n in ns if part in n.text and 150 < n.y < 1510), None)
    for _ in range(4):
        nodes = phone.nodes()
        if visible(nodes, DOOR) is not None and visible(nodes, ACCEPT) is not None:
            break
        phone.swipe_up()
        sleep(1.5)
    nodes = phone.nodes()
    door = visible(nodes, DOOR)
    if door is not None:
        phone.tap(door.x, door.y)
    else:
        raise GiftAcceptError('배송 요청사항 문앞 버튼 미확인 — AI 화면 복구 필요')
    sleep(1.5)
    # 개인정보 수집 동의가 안 찍혀 있으면 '선물 받기' 를 눌러도 완료 화면이 안 뜬다(실기 2026-10-14)
    consent = visible(phone.nodes(), CONSENT)
    if consent is not None:
        phone.tap(consent.x, consent.y)
        sleep(1.2)
    nodes = phone.nodes()
    accept = next((n for n in nodes if n.text.strip() == ACCEPT and 150 < n.y < 1510), None)
    if accept is None:
        raise GiftAcceptError('선물 받기 버튼 미확인 — AI 화면 복구 필요')
    phone.tap(accept.x, accept.y)
    nodes = wait_for(lambda ns: has_text(ns, DONE), 25)
    if not has_text(nodes, DONE):
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
