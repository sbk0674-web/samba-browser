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


def test_가격과_주문번호_읽기():
    assert header_price(SHEET2) == 564
    assert order_no_after_label(DETAIL) == '110213474374883854'


def test_검색부터_알리페이_결제와_주문번호까지():
    phone = FakePhone(
        [HOME, SEARCH, RESULT, PRODUCT, SHEET, SHEET, SHEET2, PAID, PAID, MY, ORDERS, LIST, DETAIL],
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
    assert res.cost_krw == round(580.92 * 202.16)


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


def test_得物_외_판매처는_사람에게(monkeypatch):
    wave = SimpleNamespace(
        get_order=lambda no: SimpleNamespace(
            source_seller='淘宝',
            registered_option='41⅓',
            source_product_code='IE7426',
            revenue=202070,
        )
    )
    handle = make_shihuo_handler(wave, lambda krw: 'ok', rate_of=lambda: 202.16)
    outcome, _fail, line = handle(None, SimpleNamespace(order_no='A1'))
    assert outcome == 'needs_human' and '淘宝' in line


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
    assert recorded['cost'] == round(580.92 * 202.16)


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
