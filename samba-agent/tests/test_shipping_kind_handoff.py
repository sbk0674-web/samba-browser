from types import SimpleNamespace

import pytest

from samba_agent.supervisor.assign import _expected, _handoff


@pytest.mark.parametrize('kind', ['direct', 'kkadaegi', 'gift'])
def test_verifier_receives_the_same_shipping_kind_as_the_recorder(kind):
    state = {
        'order': SimpleNamespace(order_type='direct'),
        'results': {
            'buyer.musinsa': SimpleNamespace(payload={'order_type': kind}),
            'payer': SimpleNamespace(payload={'source_order_no': 'paid-order'}),
        },
    }
    assert _expected(state)['order_type'] == kind
    assert _handoff(state)['order_type'] == kind


def test_missing_shipping_kind_is_not_invented():
    state = {'results': {'buyer.musinsa': SimpleNamespace(payload={})}}
    assert 'order_type' not in _handoff(state)
