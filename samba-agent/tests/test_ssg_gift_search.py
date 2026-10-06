"""SSG 선물 수락(카톡 검색) — 주문번호에서 검색어·받는 분 이름을 뽑는 순수 함수와 방 안 판정."""

import pytest

from samba_agent.ops.ssg_gift_accept import GiftAcceptError, source_order_no_of
from samba_agent.ops.ssg_gift_search import accept_ssg_gift_by_search, order_code_of, recipient_of


def test_검색어는_주문번호_끝_6자리():
    assert order_code_of('2026-10-04-DCB6EC') == 'DCB6EC'
    assert order_code_of('20261004DB7BCE') == 'DB7BCE'
    assert order_code_of('abc') == ''
    assert order_code_of('') == ''


def test_받는_분_이름을_알림에서_읽는다():
    assert recipient_of('이은채님에게 임성희님의 마음을 담은 선물을 전달해드릴게요!') == '이은채'
    assert recipient_of('받는 분 없음') is None


def test_결제_결과의_소싱_주문번호를_꺼낸다():
    out = {'results': {'payer': {'payload': {'source_order_no': '20261004DCB6EC'}}, 'buyer.ssg': {'payload': {}}}}
    assert source_order_no_of(out) == '20261004DCB6EC'
    assert source_order_no_of({'results': {}}) == ''


def test_주문번호를_모르면_검색하지_않고_실패한다():
    class _Phone:  # 호출되면 안 된다
        def __getattr__(self, name):
            raise AssertionError(f'폰을 만지면 안 된다: {name}')

    with pytest.raises(GiftAcceptError, match='주문번호'):
        accept_ssg_gift_by_search(_Phone(), '')  # type: ignore[arg-type]
