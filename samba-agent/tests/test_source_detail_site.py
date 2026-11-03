from types import SimpleNamespace

import pytest

from samba_agent.agents.source_detail import detail_args, site_of


@pytest.mark.parametrize('source,url,override,expected', [
    ('ABCmart', 'https://grandstage.a-rt.com/product?prdtNo=1020109440', None, 'GrandStage'),
    ('ABCmart', 'https://abcmart.a-rt.com/product?prdtNo=1010109772', None, 'ABCmart'),
    ('ABCmart', 'https://grandstage.a-rt.com.evil.test/product', None, 'ABCmart'),
    ('MUSINSA', 'https://grandstage.a-rt.com/product', None, 'MUSINSA'),
    ('ABCmart', 'https://grandstage.a-rt.com/product', 'LOTTEON', 'LOTTEON'),
    ('ABCmart', 'https://grandstage.a-rt.com/product', 'ABCmart', 'ABCmart'),
])
def test_detail_uses_exact_designated_abc_host_unless_purchase_source_is_known(source, url, override, expected):
    a = SimpleNamespace(
        handoff={'buy_source': override} if override else {},
        order=SimpleNamespace(source=source, product_url=url, order_no='A1', account='buyer01'),
    )
    assert site_of(a) == expected
    args = detail_args(a, '2026092327465')
    assert args['site'] == expected
    assert args['source_order_no'] == '2026092327465'
    assert args['profile'] == 'buyer01'
