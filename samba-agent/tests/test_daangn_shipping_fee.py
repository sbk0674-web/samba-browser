import pytest

from samba_agent.agents.buyer import shipping_fee_for
from samba_agent.agents.contracts import OrderRef


@pytest.mark.parametrize('order_type', ['kkadaegi', 'direct'])
def test_direct_sale_has_no_forwarding_charge(order_type):
    order = OrderRef(order_no='당근 237', source='MUSINSA', seller='당근마켓(김귀옥)', sku='7580605')
    assert shipping_fee_for(order, order_type) == 0


@pytest.mark.parametrize('number', ['FMIB261121004021J2REXZ', 'manual-237'])
@pytest.mark.parametrize('order_type', ['kkadaegi', 'direct'])
def test_daangn_seller_never_gets_forwarding_charge_regardless_of_order_number(number, order_type):
    # 당근마켓 무신사 유즈드 주문은 까대기여도 배송비를 적지 않는다(사용자 2026-11-23, 상품주문번호 FMIB… 2건에 2,300원이 적혔다)
    order = OrderRef(order_no=number, source='MUSINSA', seller='당근마켓', sku='7754116')
    assert shipping_fee_for(order, order_type) == 0


@pytest.mark.parametrize('number,seller', [('당근 237', '쿠팡'), ('A-1', '스마트스토어')])
def test_other_shipping_charges_are_preserved(number, seller):
    order = OrderRef(order_no=number, source='MUSINSA', seller=seller, sku='7580605')
    assert shipping_fee_for(order, 'kkadaegi') == 2300
