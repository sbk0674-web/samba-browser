from samba_agent.agents.buyer import quotes_problem

ALLOWED = {'kakao', 'naver', 'payco', 'site', 'toss'}
OFFERED = ['신용카드', '카카오페이', '네이버페이', '토스페이', '간편결제']


def _out(*rows: dict[str, object]) -> dict[str, object]:
    return {'quotes': list(rows), 'base_cost': 113430}


def test_간편결제_롯데카드_줄이_없으면_문제로_돌려준다():
    out = _out({'method': '카카오페이', 'card': None, 'cost': 102090})
    problem = quotes_problem(out, OFFERED, ALLOWED, None, '롯데카드')
    assert problem is not None
    assert '간편결제' in problem and 'L.PAY 카드' in problem


def test_간편결제_줄의_금액이_비어도_문제():
    out = _out(
        {'method': '카카오페이', 'card': None, 'cost': 102090},
        {'method': '간편결제', 'card': None, 'cost': None},
    )
    assert quotes_problem(out, OFFERED, ALLOWED, None, '롯데카드') is not None


def test_간편결제_줄이_있으면_통과():
    out = _out(
        {'method': '카카오페이', 'card': None, 'cost': 102090},
        {'method': '간편결제', 'card': '롯데카드', 'cost': 102090},
    )
    assert quotes_problem(out, OFFERED, ALLOWED, None, '롯데카드') is None


def test_easy_pay_card_없는_소싱처는_간편결제_줄을_요구하지_않는다():
    out = _out({'method': '카카오페이', 'card': None, 'cost': 102090})
    assert quotes_problem(out, OFFERED, ALLOWED, None, None) is None


def test_주문서에_간편결제가_없으면_요구하지_않는다():
    out = _out({'method': '카카오페이', 'card': None, 'cost': 102090})
    offered = ['신용카드', '카카오페이', '네이버페이']
    assert quotes_problem(out, offered, ALLOWED, None, '롯데카드') is None


def test_site_결제가_허용되지_않으면_요구하지_않는다():
    out = _out({'method': '카카오페이', 'card': None, 'cost': 102090})
    assert quotes_problem(out, OFFERED, {'kakao', 'naver'}, None, '롯데카드') is None
