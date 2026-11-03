import pytest

from samba_agent.agents.buyer import shipping_fee_for
from samba_agent.agents.contracts import OrderRef


@pytest.mark.parametrize('order_type', ['kkadaegi', 'direct'])
def test_direct_sale_has_no_forwarding_charge(order_type):
    order = OrderRef(order_no='당근 237', source='MUSINSA', seller='당근마켓(김귀옥)', sku='7580605')
    assert shipping_fee_for(order, order_type) == 0


@pytest.mark.parametrize('number,seller', [('manual-237', '당근마켓'), ('당근 237', '쿠팡')])
def test_other_shipping_charges_are_preserved(number, seller):
    order = OrderRef(order_no=number, source='MUSINSA', seller=seller, sku='7580605')
    assert shipping_fee_for(order, 'kkadaegi') == 2300
