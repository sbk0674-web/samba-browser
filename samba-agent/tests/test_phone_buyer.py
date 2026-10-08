# 폰 구매 AI 의 결제 안전장치 — 돈이 나가는 길은 pay 하나, 코드가 점검한다

from samba_agent.operator.phone_buyer import PhoneToolbox
from samba_agent.ops.ssg_gift_accept import Node

ALIPAY_PKG = 'com.eg.android.AlipayGphone'


class FakePhone:
    def __init__(self, top: str, nodes: list[Node]) -> None:
        self.top = top
        self._nodes = nodes
        self.taps: list[tuple[int, int]] = []
        self.adb = 'adb'
        self.serial = 'S'

    def top_package(self) -> str:
        return self.top

    def nodes(self) -> list[Node]:
        return self._nodes

    def tap(self, x: int, y: int) -> None:
        self.taps.append((x, y))

    def key(self, code: str) -> None:
        pass

    def input_text(self, text: str) -> None:
        pass


def _alipay(amount: str) -> list[Node]:
    return [Node('订单金额', '', '', 100, 400), Node(amount, '', '', 600, 400)]


def _box(phone, approved: list[int], max_cny: float = 700.0) -> PhoneToolbox:
    def approve(krw: int) -> str:
        approved.append(krw)
        return 'ok'

    return PhoneToolbox(phone, approve, max_cny=max_cny, rate=200.0, sleep=lambda s: None)


def test_화이트리스트가_아닌_가게는_결제하지_않는다():
    approved: list[int] = []
    tb = _box(FakePhone(ALIPAY_PKG, _alipay('¥214.20')), approved)
    assert '화이트리스트' in tb.pay('아무개운동화점', 214.2)
    assert approved == [] and not tb.state.paid


def test_알리페이_창이_앞에_없으면_결제하지_않는다():
    approved: list[int] = []
    tb = _box(FakePhone('com.taobao.taobao', []), approved)
    assert '결제창이 앞에 없다' in tb.pay('后浪潮品奥莱折扣店', 214.2)
    assert approved == []


def test_결제창_금액이_상한이나_AI가_본_가격과_다르면_결제하지_않는다():
    approved: list[int] = []
    tb = _box(FakePhone(ALIPAY_PKG, _alipay('¥1090.00')), approved, max_cny=700)
    assert '상한' in tb.pay('后浪潮品奥莱折扣店', 214.2)
    tb2 = _box(FakePhone(ALIPAY_PKG, _alipay('¥600.00')), approved, max_cny=700)
    assert '다르다' in tb2.pay('后浪潮品奥莱折扣店', 214.2)
    assert approved == []


def test_금액과_가게가_맞으면_결제하고_주문번호는_결제_뒤에만_받는다():
    approved: list[int] = []
    tb = _box(FakePhone(ALIPAY_PKG, _alipay('¥214.20')), approved)
    assert '결제하지 않았다' in tb.finish('123456789012345')
    assert '완료' in tb.pay('后浪潮品奥莱折扣店', 214.2)
    assert approved == [round(214.2 * 1.03 * 200.0)] and tb.state.paid
    assert tb.finish('abc').startswith('주문번호는')
    assert tb.finish('2026100812345678') == '기록했다. 끝내라.'
    assert tb.state.order_no == '2026100812345678'
    # 결제 뒤에는 다시 결제하지 못한다
    assert '이미 결제' in tb.pay('后浪潮品奥莱折扣店', 214.2)


def test_알리페이_창이_앞이면_누르기와_입력이_막힌다():
    phone = FakePhone(ALIPAY_PKG, _alipay('¥214.20'))
    tb = _box(phone, [])
    assert '막혀' in tb.tap(300, 300)
    assert '막혀' in tb.text('123456')
    assert '막혀' in tb.key('home')
    assert phone.taps == []


def test_조작_횟수가_한도를_넘으면_멈춘다():
    phone = FakePhone('com.hupu.shihuo', [])
    tb = _box(phone, [])
    out = ''
    for _ in range(170):
        out = tb.tap(10, 10)
    assert '넘었다' in out


def test_淘宝_앱_안_결제창의_설명_글자에서도_주문금액을_읽는다():
    """실기 2026-10-08: 淘宝 결제창은 글자가 content-desc 에만 있다('订单金额,¥ 549.00')."""
    from samba_agent.ops.dewu_order import alipay_order_amount

    nodes = [
        Node('', '支付金额565.47元', '', 359, 255),
        Node('', '订单金额,¥ 549.00', '', 359, 456),
        Node('', '国际卡手续费(3%),+¥ 16.47', '', 359, 508),
        Node('', '密码共6位，已输入0位', '', 359, 978),
    ]
    assert alipay_order_amount(nodes) == 549.0
    phone = FakePhone('com.taobao.taobao', nodes)
    approved: list[int] = []
    tb = _box(phone, approved, max_cny=680)
    out = tb.pay('后浪潮品奥莱折扣店', 549.0)
    assert '완료' in out and approved == [round(549.0 * 1.03 * 200.0)]


def test_승인_응답이_실패여도_화면에_支付成功이_뜨면_결제된_것으로_본다():
    """실기 2026-10-08: phone_approve_payment 가 verify-failed 를 돌려줬지만 실제로는 결제됐다."""
    nodes = _alipay('¥214.20')
    phone = FakePhone(ALIPAY_PKG, nodes)
    approved: list[int] = []

    def approve(krw: int) -> str:
        approved.append(krw)
        phone._nodes = [Node('', '支付成功', '', 360, 200)]
        return 'refused: verify-failed'

    tb = PhoneToolbox(phone, approve, max_cny=700, rate=200.0, sleep=lambda s: None)
    assert '완료' in tb.pay('后浪潮品奥莱折扣店', 214.2)
    assert tb.state.paid and not tb.state.uncertain


def test_승인_응답이_실패이고_화면도_확인_못_하면_불확실로_표시한다():
    phone = FakePhone(ALIPAY_PKG, _alipay('¥214.20'))
    tb = PhoneToolbox(
        phone, lambda krw: 'refused: verify-failed', max_cny=700, rate=200.0, sleep=lambda s: None
    )
    out = tb.pay('后浪潮品奥莱折扣店', 214.2)
    assert '재결제 금지' in out and tb.state.uncertain and not tb.state.paid
