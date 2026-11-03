import json
from types import SimpleNamespace

import pytest

from samba_agent.agents.buyer import BuyerAgent, parse_account_labels


@pytest.mark.parametrize('no_cross', [True, 'True'])
def test_repaired_order_skips_cross_source_before_any_site_call(no_cross):
    agent = SimpleNamespace(sibling=object())
    assignment = SimpleNamespace(options={'no_cross': no_cross})
    assert BuyerAgent._cross_compare(agent, assignment, None, None) is None


def test_masked_username_is_not_used_as_buying_account():
    raw = json.dumps({'accounts': [{'label': 'account-a', 'username': '***'}]})
    labels, locked = parse_account_labels(raw)
    assert labels == ['account-a']
    assert locked is False
