from types import SimpleNamespace

import pytest

from samba_agent.agents.buyer import BuyerAgent
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.settings import DEFAULT_ROOT


@pytest.mark.parametrize('fail', [False, True])
@pytest.mark.parametrize('parallel', [False, True])
def test_quick_rank_cleans_only_comparison_lanes_on_success_and_failure(fail, parallel):
    calls = []

    class Bridge:
        def __init__(self, lane='user'):
            self.lane = lane

        def with_lane(self, lane):
            return Bridge(lane)

        def scoped(self, _tools):
            return self

        def call(self, name, /, **kwargs):
            calls.append((self.lane, name, kwargs))
            if name == 'run_script' and fail:
                raise RuntimeError('bridge disconnected')
            return SimpleNamespace(result='{"my_price": 10000, "max_reward": 0}')

    spec = Registry.load(DEFAULT_ROOT)['buyer.musinsa']
    agent = BuyerAgent(spec=spec, bridge=Bridge(), decide=lambda *_: None)
    agent.parallel_accounts = parallel
    agent.step = lambda *_: None
    agent.note = lambda *_: None
    task = Assignment(
        rules='', allowed_tools=spec.tools,
        order=OrderRef(order_no='Q1', source='MUSINSA', seller='쿠팡', sku='1234567',
                       product_url='https://www.musinsa.com/products/1234567', qty=1),
    )
    ranked = agent._quick_rank(task, ['first', 'second'])
    assert ranked == (None if fail else ['first', 'second'])
    cleanups = [c for c in calls if c[1] == 'run_js']
    if not parallel:
        assert cleanups == []
        return
    assert {c[0] for c in cleanups} == {'musinsa-q-first', 'musinsa-q-second'}
    assert len(cleanups) == 2
    assert all(c[2]['safety'] == 'no_pay' for c in cleanups)
