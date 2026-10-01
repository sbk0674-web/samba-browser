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
