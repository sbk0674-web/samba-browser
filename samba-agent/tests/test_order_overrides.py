from samba_agent.agents.contracts import OrderRef
from samba_agent.queue.orders import with_overrides


def test_job_options_override_option_and_product_url():
    ref = OrderRef(
        order_no='A1', source='LOTTEON', seller='포이즌', sku='S', qty=1, option='블랙 XL', product_url='u1'
    )
    out = with_overrides(ref, {'option': '3IE(블랙) 006(110)', 'product_url': 'u2', 'card': '현대'})
    assert (out.option, out.product_url) == ('3IE(블랙) 006(110)', 'u2')
    assert with_overrides(ref, {}) is ref
