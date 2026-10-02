"""SSG 선물 수락(폰) — 실기 2026-10-01 순서를 가짜 폰으로 따라간다."""

import pytest

from samba_agent.agents.contracts import AgentResult
from samba_agent.ops.ssg_gift_accept import (
    CLOSE_ID,
    GiftAcceptError,
    Node,
    accept_ssg_gift,
    gift_order_of,
    parse_nodes,
)


def n(text: str, y: int = 100, rid: str = '') -> Node:
    return Node(text=text, desc='', rid=rid, x=360, y=y)


CHAT_LIST = [n('채팅'), n('SSG닷컴', 750)]
ROOM = [n('SSG닷컴', 90), n('선물 받으러 가기', 600), n('선물 받으러 가기', 1318)]
GIFT_HOME = [n('선물받기', 225), n('옵션/배송지 확인', 1460)]
FORM_TOP = [n('배송지', 815), n('아동 나이키 리액트X리주버네이트 IF1746-001', 505)]
FORM_BOTTOM = [n('부재 시 문앞에 놓아주세요', 875), n('선물 받기', 1375), n('배송지', 300)]
DONE = [n('선물 받기 완료, 믿고 사는 즐거움 SSG.COM', 118), n('다음에 할게요!', 1093), n('', 131, CLOSE_ID)]
AFTER = [n('', 131, CLOSE_ID)]


class FakePhone:
    def __init__(self, screens: list[list[Node]]) -> None:
        self.screens = screens
        self.i = 0
        self.taps: list[tuple[int, int]] = []
        self.keys: list[str] = []

    def nodes(self) -> list[Node]:
        s = self.screens[min(self.i, len(self.screens) - 1)]
        self.i += 1
        return s

    def tap(self, x: int, y: int) -> None:
        self.taps.append((x, y))

    def swipe_up(self) -> None:
        pass

    def key(self, code: str) -> None:
        self.keys.append(code)

    def launch(self, package: str) -> None:
        pass

    def top_package(self) -> str:
        return 'com.kakao.talk'


def test_채팅목록부터_선물받기_완료와_브라우저_닫기까지():
    phone = FakePhone([CHAT_LIST, ROOM, GIFT_HOME, FORM_TOP, FORM_BOTTOM, DONE, AFTER, []])
    out = accept_ssg_gift(phone, 'IF1746-001', sleep=lambda s: None)  # type: ignore[arg-type]
    assert '선물 받기 완료' in out
    # SSG닷컴 방 → 맨 아래 '선물 받으러 가기'(y=1318) → 옵션/배송지 → 문앞 → 선물 받기 → 다음에 할게요 → X
    assert phone.taps[:6] == [(360, 750), (360, 1318), (360, 1460), (360, 875), (360, 1375), (360, 1093)]
    assert (360, 131) in phone.taps[6:]
    assert phone.keys[-1] == '3'  # 홈으로 나간다


def test_다른_주문의_선물이면_받지_않고_닫는다():
    phone = FakePhone([CHAT_LIST, ROOM, GIFT_HOME, FORM_TOP, AFTER, []])
    with pytest.raises(GiftAcceptError, match='이 주문'):
        accept_ssg_gift(phone, 'HF5441-100', sleep=lambda s: None)  # type: ignore[arg-type]
    assert (360, 1375) not in phone.taps  # '선물 받기'를 누르지 않았다


def test_알림톡이_안_오면_시간_뒤_실패():
    phone = FakePhone([CHAT_LIST, [n('SSG닷컴', 90)]])
    with pytest.raises(GiftAcceptError, match='선물 받으러 가기'):
        accept_ssg_gift(phone, '', sleep=lambda s: None, wait_message_s=0)  # type: ignore[arg-type]


def test_덤프_파싱():
    xml = (
        "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">"
        '<node text="선물 받기" resource-id="" content-desc="" bounds="[30,1333][691,1419]" />'
        f'<node text="" resource-id="{CLOSE_ID}" content-desc="닫기 버튼" bounds="[0,90][98,173]" /></hierarchy>'
    )
    nodes = parse_nodes(xml)
    assert nodes[0] == Node('선물 받기', '', '', 360, 1376)
    assert nodes[1].rid == CLOSE_ID and (nodes[1].x, nodes[1].y) == (49, 131)


def test_선물_주문만_뒤처리_대상():
    gift = {'results': {'buyer.ssg': AgentResult(status='ok', reason='ok', payload={'order_type': 'gift'})}}
    direct = {'results': {'buyer.ssg': AgentResult(status='ok', reason='ok', payload={'order_type': 'direct'})}}
    assert gift_order_of(gift) is True
    assert gift_order_of(direct) is False


def test_선물_확인하기_알림과_기한이_붙은_버튼_비회원_동의까지_받는다():
    """실기 2026-10-02: 버튼이 '선물 확인하기', 확인 버튼 뒤에 기한 글자, 비회원 양식은 동의 칸을 켜야 받아진다."""
    room = [n('SSG닷컴', 90), n('선물 확인하기', 721)]
    home = [n('선물받기', 225), n('옵션/배송지 확인 10/9(금) 23:59까지 꼭 확인해 주세요', 934)]
    form_top = [
        n('배송지', 817), n('아동 나이키 플렉스 러너 4 (리틀키즈) IF2894-002', 524),
        # 화면 밖 요소는 좌표 0 으로 섞여 나온다 — 누르면 안 된다
        Node(text='부재 시 문앞에 놓아주세요', desc='', rid='', x=0, y=0),
        Node(text='선물 받기', desc='', rid='', x=0, y=0),
    ]  # fmt: skip
    form_bottom = [
        n('부재 시 문앞에 놓아주세요', 1139), n('배송에 필요한 개인정보수집에 모두 동의', 1204), n('선물 받기', 1376),
    ]  # fmt: skip
    phone = FakePhone([CHAT_LIST, room, home, form_top, form_bottom, DONE, AFTER, []])
    out = accept_ssg_gift(phone, 'IF2894', sku='매장정품 나이키 아동 플렉스 러너 4 리틀키즈 IF2894 002', sleep=lambda s: None)  # type: ignore[arg-type]
    assert '선물 받기 완료' in out
    ys = [y for _, y in phone.taps]
    assert 0 not in ys  # 화면 밖 좌표를 누르지 않았다
    assert ys.index(1139) < ys.index(1204) < ys.index(1376)  # 문앞 → 동의 → 선물 받기


def test_품번_끝_글자가_없거나_상품명_낱말이_맞으면_같은_상품이다():
    from samba_agent.ops.ssg_gift_accept import same_product

    screen = ['다이나핏 YMM23342[다이나핏]남성 네오 피스테 여름 냉감 기능성 슬림 조거 밴딩팬츠']
    assert same_product('YMM23342CT', '', screen)
    assert same_product('', '매장정품 다이나핏 DYNAFIT YMM23342CT 남성 피스테 여름 냉감 기능성 슬림 조거', screen)
    assert not same_product('IF2894', '매장정품 나이키 아동 플렉스 러너 4 리틀키즈 IF2894 002', screen)
    assert same_product('', '', screen)  # 견줄 값이 없으면 막지 않는다
