import json

from samba_agent.agents.payer import single_order_tab


def _tabs(*urls: str) -> str:
    return json.dumps([{'id': f't{i}', 'kind': 'tab', 'url': u} for i, u in enumerate(urls)])


def test_single_checkout_tab_found() -> None:
    out = _tabs('https://www.29cm.co.kr/products/1', 'https://order.29cm.co.kr/order/checkout?x=1')
    assert single_order_tab(out) == 't1'


def test_multiple_or_none_returns_none() -> None:
    assert (
        single_order_tab(_tabs('https://a.com/order/checkout', 'https://b.com/order/order-form'))
        is None
    )
    assert single_order_tab(_tabs('https://a.com/')) is None
    assert single_order_tab('not json') is None


def test_글자_사이즈가_다르게_담긴_주문서는_막는다():
    """주문 M 인데 S 로 담긴 주문서가 숫자 사이즈 대조만으로 통과해 결제됐다(실기 2026-10-18 무신사 지오다노 2건)."""
    from samba_agent.agents.payer import order_form_mismatch

    opt = '01아이보리+미드헤더그레이 / M'
    name = '지오다노 캠핑티셔츠 라운드넥티셔츠'
    page = '지오다노 캠핑티셔츠 라운드넥티셔츠 01아이보리+미드헤더그레이 S 1개'
    assert order_form_mismatch(page, name, opt, '01아이보리+미드헤더그레이 S')
    assert order_form_mismatch(page, name, opt, '')  # 담긴 옵션을 못 넘겨도 화면의 S 로 막는다
    ok = page.replace(' S ', ' M ')
    assert order_form_mismatch(ok, name, opt, '01아이보리+미드헤더그레이 M') is None
    assert order_form_mismatch(ok, name, opt, '') is None


def test_프리사이즈_주문은_화면의_다른_사이즈_글자로_막지_않는다():
    """주문 FREE 인데 주문서의 다른 'S' 글자(문구 일부)를 사이즈로 읽어 결제를 막았다(실기 2026-10-21 SSG 라코스테 양말)."""
    from samba_agent.agents.payer import order_form_mismatch

    page = '라코스테 삭스 031(블랙) 1개 S 쇼핑백 신청 14,595원'
    assert (
        order_form_mismatch(page, '라코스테 삭스', '031(블랙) FREE RA195E-56G', '031(블랙)') is None
    )
    assert order_form_mismatch(page, '라코스테 삭스', '031(블랙) FREE RA195E-56G', '') is None


def test_상품명_속_글자_M_Logo_때문에_S_주문을_막지_않는다():
    """상품명 'M Logo' 의 M 이 선택 글자에 섞여 ['M','S'] 로 읽혀 S 주문이 멈췄다(실기 2026-10-21 무신사 지프 맨투맨)."""
    from samba_agent.agents.payer import order_form_mismatch

    name = '매장정품 지프 JEEP JR5TSU838BT 360g M Logo 반집업 맨투맨 스웨트셔츠'
    page = f'{name} S / 1개 74,000원'
    assert order_form_mismatch(page, name, 'S', f'{name} S') is None
    # 진짜 다른 사이즈(주문 S 인데 L 이 담김)는 여전히 막는다
    assert order_form_mismatch(page.replace(' S / ', ' L / '), name, 'S', f'{name} L')


def test_multiple_checkout_tabs_narrowed_by_profile() -> None:
    out = json.dumps(
        [
            {
                'id': 't1',
                'kind': 'tab',
                'profile': 'a',
                'url': 'https://www.29cm.co.kr/order/checkout?x=1',
            },
            {
                'id': 't2',
                'kind': 'tab',
                'profile': 'b',
                'url': 'https://www.29cm.co.kr/order/checkout?x=2',
            },
        ]
    )
    assert single_order_tab(out) is None
    assert single_order_tab(out, 'b') == 't2'
    assert single_order_tab(out, 'c') is None
