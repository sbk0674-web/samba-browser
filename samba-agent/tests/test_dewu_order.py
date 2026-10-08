"""중국 크림(식화) 得物 구매 — 실기 2026-10-01 화면을 가짜 폰으로 따라간다."""

from types import SimpleNamespace

import pytest

from samba_agent.ops import dewu_order
from samba_agent.ops.dewu_order import (
    ALIPAY,
    DEWU,
    DewuOrderError,
    buy_on_dewu,
    header_price,
    make_shihuo_handler,
    order_no_after_label,
)
from samba_agent.ops.ssg_gift_accept import Node


def n(text: str, y: int = 100, x: int = 360) -> Node:
    return Node(text=text, desc='', rid='', x=x, y=y)


HOME = [n('fj9488100', 94, 120), n('搜索', 94, 555)]
SEARCH = [n('', 94, 200), n('搜索', 96, 655)]
RESULT = [n('商品', 355, 50), n('adidas originals Bermuda', 680, 170), n('¥332', 720, 50)]
PRODUCT = [n('¥ 3 3 2', 895, 90), n('立即购买', 1447, 547)]
SHEET = [
    n('HUBNET-manol 收 皇冠街道海埠路...', 178),
    n('¥604', 264, 260),
    n('41⅓', 879, 270),
    n('¥604', 921, 270),
    n(' 再领¥40享最佳优惠', 316, 420),
    n('¥604', 1438, 310),
]
SHEET2 = [
    n('HUBNET-manol 收', 178),
    n('¥564', 264, 260),
    n('41⅓', 879, 270),
    n('¥564', 921, 270),
    n('支付方式', 1000, 100),
    n('支付宝', 1000, 600),
    n('¥564', 1438, 310),
]
PAID = [n('支付成功', 300), n('580.92', 380), n('완료', 1438)]
MY = [n('我', 1490, 630)]
ORDERS = [n('待发货', 200, 360)]
LIST = [n('adidas originals Bermuda 潮流', 385, 400), n('实付款', 415, 655)]
DETAIL = [n('订单编号', 900), n('全部信息', 900, 600), n('', 940), n('110213474374883854', 960)]


class FakePhone:
    def __init__(self, screens: list[list[Node]], packages: list[str]) -> None:
        self.screens, self.packages = screens, packages
        self.i = self.p = 0
        self.taps: list[tuple[int, int]] = []
        self.typed: list[str] = []

    def nodes(self) -> list[Node]:
        s = self.screens[min(self.i, len(self.screens) - 1)]
        self.i += 1
        return s

    def top_package(self) -> str:
        s = self.packages[min(self.p, len(self.packages) - 1)]
        self.p += 1
        return s

    def tap(self, x: int, y: int) -> None:
        self.taps.append((x, y))

    def key(self, code: str) -> None:
        pass

    def launch(self, package: str) -> None:
        pass

    def _run(self, *args: str, timeout: float = 20) -> str:
        if args[:3] == ('shell', 'input', 'text'):
            self.typed.append(args[3])
        return ''


ALIPAY_SCREEN = [Node('订单金额', '', '', 80, 200), Node('¥ 564.00', '', '', 300, 200)]
ALIPAY_SCREEN_HIGH = [Node('订单金额', '', '', 80, 200), Node('¥ 1,090.00', '', '', 300, 200)]


def test_가격과_주문번호_읽기():
    assert header_price(SHEET2) == 564
    assert order_no_after_label(DETAIL) == '110213474374883854'


def test_검색부터_알리페이_결제와_주문번호까지():
    phone = FakePhone(
        [
            HOME,
            SEARCH,
            RESULT,
            PRODUCT,
            SHEET,
            SHEET,
            SHEET2,
            ALIPAY_SCREEN,
            PAID,
            PAID,
            MY,
            ORDERS,
            LIST,
            DETAIL,
        ],
        [ALIPAY],
    )
    paid: list[int] = []
    res = buy_on_dewu(
        phone,  # type: ignore[arg-type]
        'IE7426',
        '41⅓',
        max_cny=900,
        approve=lambda krw: paid.append(krw) or 'ok',
        rate=202.16,
        sleep=lambda s: None,
    )
    assert phone.typed == ['IE7426']
    assert (270, 879) in phone.taps  # EU 41⅓ 칸
    assert (420, 316) in phone.taps  # 쿠폰 받기
    assert paid == [round(564 * 1.03 * 202.16)]
    assert (res.order_no, res.paid_cny, res.item_cny) == ('110213474374883854', 580.92, 564)
    assert res.cost_krw == round(580.92 * 202.16 * 0.973)


def test_상한을_넘으면_결제하지_않는다():
    phone = FakePhone([HOME, SEARCH, RESULT, PRODUCT, SHEET, SHEET, SHEET2], [DEWU])
    with pytest.raises(DewuOrderError, match='마진'):
        buy_on_dewu(
            phone,  # type: ignore[arg-type]
            'IE7426',
            '41⅓',
            max_cny=500,
            approve=lambda krw: pytest.fail('결제하면 안 된다'),
            rate=202.16,
            sleep=lambda s: None,
        )


def test_得物_외_판매처도_得物을_검색한다(monkeypatch):
    """사용자 2026-10-06: 식화 판매처가 唯品会 라도 得物에서 살 수 있다(조던 IB7256-010) — 판매처로 거르지 않는다."""
    wave = SimpleNamespace(
        get_order=lambda no: SimpleNamespace(
            source_seller='唯品会',
            registered_option='41⅓',
            source_product_code='IE7426',
            revenue=202070,
        )
    )
    monkeypatch.setattr('samba_agent.ops.ssg_gift_accept.find_phone_serial', lambda adb, want: None)
    handle = make_shihuo_handler(wave, lambda krw: 'ok', rate_of=lambda: 202.16)
    outcome, _fail, line = handle(None, SimpleNamespace(order_no='A1'))
    # 판매처 게이트를 지나 폰 연결 단계까지 간다
    assert outcome == 'needs_human' and '폰' in line and '판매처' not in line


def test_성공하면_원가와_배송비_8500을_기록한다(monkeypatch):
    recorded: dict = {}
    wave = SimpleNamespace(
        get_order=lambda no: SimpleNamespace(
            source_seller='得物',
            registered_option='41⅓',
            source_product_code='IE7426',
            revenue=202070,
        ),
        record_sourcing=lambda no, **kw: recorded.update(no=no, **kw),
        only_sourcing_account_id=lambda site: 'sa_DEWU' if site == 'DEWU' else None,
    )
    monkeypatch.setattr(
        dewu_order, 'buy_on_dewu', lambda *a, **k: dewu_order.DewuResult('110', 580.92, 564, 202.16)
    )
    monkeypatch.setattr('samba_agent.ops.ssg_gift_accept.find_phone_serial', lambda adb, want: 'S1')
    handle = make_shihuo_handler(wave, lambda krw: 'ok', rate_of=lambda: 202.16)
    outcome, _fail, _line = handle(None, SimpleNamespace(order_no='A1'))
    assert outcome == 'done'
    assert recorded['sourcing_order_number'] == '110' and recorded['shipping_fee'] == 8500
    assert recorded['sourcing_account_id'] == 'sa_DEWU'  # 주문계정이 있어야 배송대기중으로 넘어간다
    assert recorded['cost'] == round(580.92 * 202.16 * 0.973)


def test_판매처가_得物이_아니면_품절이어도_재고X_하지_않고_사람에게_넘긴다(monkeypatch):
    flagged: list = []
    wave = SimpleNamespace(
        get_order=lambda no: SimpleNamespace(
            source_seller='淘宝',
            source_price_cny=240.0,
            registered_option='36',
            source_product_code='1203A547-020',
            revenue=100000,
        ),
        only_sourcing_account_id=lambda site: None,
    )

    def soldout(*a, **k):
        raise dewu_order.DewuOrderError('暂时缺货', out_of_stock=True)

    monkeypatch.setattr(dewu_order, 'buy_on_dewu', soldout)
    monkeypatch.setattr(
        'samba_agent.wave.flags.FlagMarker',
        lambda w: SimpleNamespace(mark=lambda *a, **k: flagged.append(a)),
    )
    monkeypatch.setattr('samba_agent.ops.ssg_gift_accept.find_phone_serial', lambda adb, want: 'S1')
    handle = make_shihuo_handler(wave, lambda krw: 'ok', rate_of=lambda: 202.16)
    outcome, _fail, line = handle(None, SimpleNamespace(order_no='A1'))
    assert outcome == 'needs_human' and '淘宝' in line
    assert flagged == []


def test_구매_확인_화면의_결제수단을_읽는다():
    from samba_agent.ops.dewu_order import pay_method_of
    from samba_agent.ops.ssg_gift_accept import Node

    nodes = [
        Node('确认订单', '', '', 360, 80),
        Node('支付方式', '', '', 100, 900),
        Node('云闪付', '', '', 600, 900),
        Node('切换更多支付方式', '', '', 360, 960),
        Node('¥ 4 1 3', '', '', 500, 1500),
    ]
    assert pay_method_of(nodes) == '云闪付'
    assert (
        pay_method_of([Node('支付方式', '', '', 100, 900), Node('支付宝', '', '', 600, 900)])
        == '支付宝'
    )
    assert pay_method_of([]) == ''


def test_size_cell_의류는_설명이_붙고_2XL은_XXL로_표기된다():
    """실기 2026-10-05 나이키 자켓: 'L(身高178-182cm)' · 'XXL(身高185-188cm)'."""
    from samba_agent.ops.dewu_order import size_cell
    from samba_agent.ops.ssg_gift_accept import Node

    def node(t, x=100, y=100):
        return Node(text=t, desc='', rid='', x=x, y=y)

    nodes = [
        node('XL(身高182-185cm)'),
        node('L(身高178-182cm)', 447, 1170),
        node('XXL(身高185-188cm)', 466, 1263),
        node('42.5'),
    ]
    assert size_cell(nodes, 'L').x == 447
    assert size_cell(nodes, '2XL').x == 466
    assert size_cell(nodes, 'XXL').x == 466
    assert size_cell(nodes, 'S') is None
    assert size_cell(nodes, '42.5') is not None


def test_정산이_판매가_그대로면_크림_수수료를_빼고_마진을_본다(monkeypatch):
    """실기 2026-10-06 뉴발란스 880: revenue 92,000(=판매가)로 보고 사서 실제 정산 84,640 < 원가 90,883 역마진."""
    seen: dict = {}

    def fake_buy(phone, model, eu, *, max_cny, approve, rate):
        seen['max_cny'] = max_cny
        raise DewuOrderError('시험 중단')

    monkeypatch.setattr('samba_agent.ops.dewu_order.buy_on_dewu', fake_buy)
    monkeypatch.setattr(
        'samba_agent.ops.ssg_gift_accept.find_phone_serial', lambda adb, want: 'SERIAL'
    )
    wave = SimpleNamespace(
        get_order=lambda no: SimpleNamespace(
            source_seller='得物',
            registered_option='40',
            source_product_code='MW880BD7',
            revenue=92000,
            sale_price=92000,
        )
    )
    handle = make_shihuo_handler(wave, lambda krw: 'ok', rate_of=lambda: 200.0)
    handle(None, SimpleNamespace(order_no='A1'))
    # (92,000 × 0.92 − 8,500) / (200 × 0.973) / 1.03
    assert round(seen['max_cny'], 1) == round((92000 * 0.92 - 8500) / (200 * 0.973) / 1.03, 1)


def test_상품_머리글이_暂时缺货면_확정_품절로_멈춘다():
    """실기 2026-10-07 리복 클럽씨 85 EU 43 — 전 사이즈 ¥-- 인데 '가격을 못 읽었다'(unknown)로 네 번 끝났다."""
    sold_out = [
        n('暂时缺货', 560, 300),
        n('43', 1120, 790),
        n('¥--', 1170, 790),
        n('请选择', 1800, 460),
    ]
    phone = FakePhone([HOME, SEARCH, RESULT, PRODUCT, sold_out], [DEWU])
    with pytest.raises(DewuOrderError, match='확정 품절') as err:
        buy_on_dewu(
            phone,  # type: ignore[arg-type]
            'GZ1605',
            '43',
            max_cny=900,
            approve=lambda krw: pytest.fail('결제하면 안 된다'),
            rate=199.68,
            sleep=lambda s: None,
        )
    assert err.value.out_of_stock is True
    assert err.value.paid is False


def test_보조금_실명인증_팝업은_再想想로_닫고_去实名은_누르지_않는다():
    from samba_agent.ops.ssg_gift_accept import Node

    taps: list[tuple[int, int]] = []
    nodes = [
        Node('领取补贴', '', '', 360, 672),
        Node('再想想', '', '', 241, 872),
        Node('去实名', '', '', 478, 872),
    ]
    phone = SimpleNamespace(nodes=lambda: nodes, tap=lambda x, y: taps.append((x, y)))
    assert dewu_order.dismiss_subsidy_dialog(phone, lambda s: None) is True  # type: ignore[arg-type]
    assert taps == [(241, 872)]
    # 팝업이 없으면 아무것도 누르지 않는다
    taps.clear()
    phone2 = SimpleNamespace(
        nodes=lambda: [Node('立即支付', '', '', 360, 1450)], tap=lambda x, y: taps.append((x, y))
    )
    assert dewu_order.dismiss_subsidy_dialog(phone2, lambda s: None) is False  # type: ignore[arg-type]
    assert taps == []


def test_알리페이_결제창의_주문금액을_읽는다():
    from samba_agent.ops.ssg_gift_accept import Node

    korean = [
        Node('CVV를 입력하세요', '', '', 360, 60),
        Node('¥', '', '', 100, 120),
        Node('576.80', '', '', 160, 120),
        Node('주문금액:', '', '', 80, 200),
        Node('¥ 560.00', '', '', 300, 200),
        Node('국제카드 수수료(3%)', '', '', 80, 240),
        Node('+¥ 16.80', '', '', 300, 240),
    ]
    assert dewu_order.alipay_order_amount(korean) == 560.0
    chinese = [Node('订单金额', '', '', 80, 200), Node('¥ 214.20', '', '', 300, 200)]
    assert dewu_order.alipay_order_amount(chinese) == 214.2
    assert dewu_order.alipay_order_amount([Node('다른 화면', '', '', 0, 0)]) is None
    # 천 단위 쉼표
    big = [Node('订单金额', '', '', 80, 200), Node('¥ 1,090.00', '', '', 300, 200)]
    assert dewu_order.alipay_order_amount(big) == 1090.0


def test_결제창_금액이_구매창_가격과_다르면_비밀번호를_넣지_않는다():
    """실기 2026-10-08 아식스 카야노 14: 구매창은 ¥674 였는데 결제창은 ¥1090 이라 상한(¥681)을 넘어 샀다."""
    phone = FakePhone(
        [HOME, SEARCH, RESULT, PRODUCT, SHEET, SHEET, SHEET2, ALIPAY_SCREEN_HIGH],
        [ALIPAY],
    )
    with pytest.raises(DewuOrderError, match='결제창 금액'):
        buy_on_dewu(
            phone,  # type: ignore[arg-type]
            'IE7426',
            '41⅓',
            max_cny=900,
            approve=lambda krw: pytest.fail('결제하면 안 된다'),
            rate=202.16,
            sleep=lambda s: None,
        )


def test_하단_결제_버튼이_둘이면_싼_일반배송_가격을_쓴다():
    """실기 2026-10-08: 품牌官方 ¥1090(왼쪽) / 일반배송 ¥631(오른쪽) — 왼쪽을 눌러 ¥1090 을 결제했다."""
    from samba_agent.ops.ssg_gift_accept import Node

    nodes = [Node('¥1090', '', '', 240, 1540), Node('¥631', '', '', 760, 1548)]
    assert dewu_order.header_price(nodes) == 631.0


def test_최저가_판매처가_淘宝이면_得物을_열지_않고_사람에게_넘긴다(monkeypatch):
    def boom(*a, **k):
        raise AssertionError('得物을 열면 안 된다')

    monkeypatch.setattr('samba_agent.ops.dewu_order.buy_on_dewu', boom)
    monkeypatch.setattr(
        'samba_agent.ops.ssg_gift_accept.find_phone_serial', lambda adb, want: 'SERIAL'
    )
    wave = SimpleNamespace(
        get_order=lambda no: SimpleNamespace(
            source_seller='淘宝',
            source_price_cny=520,
            registered_option='37',
            source_product_code='1203A667-100',
            revenue=144760,
            sale_price=157000,
        )
    )
    handle = make_shihuo_handler(wave, lambda krw: 'ok', rate_of=lambda: 200.0)
    result, code, line = handle(None, SimpleNamespace(order_no='A1'))
    assert result == 'needs_human' and code == 'unknown' and '淘宝' in line
