"""H몰 진입 경로 — 다나와 경유와 애드픽 적립 링크를 결제액으로 비교한다(사용자 2026-09-27)."""

import pytest

from samba_agent.agents import buyer as buyer_mod
from samba_agent.agents.buyer import BuyerAgent
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.sources import default_sources

URL = 'http://127.0.0.1:47811'
PRODUCT = 'https://www.hmall.com/md/pda/itemPtc?slitmCd=2224155443'


@pytest.fixture()
def hmall(monkeypatch) -> BuyerAgent:
    row = default_sources().by_id('HMALL')
    assert row is not None and 'adpick' in row.routes
    monkeypatch.setattr(buyer_mod, 'source_of', lambda name: row)
    spec = Registry.load(DEFAULT_ROOT)['buyer.musinsa']
    agent = BuyerAgent(spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), lambda p, m: None)  # type: ignore[arg-type,return-value]
    agent._dry_run = False
    agent.evidence = []
    agent._quote_errors = []
    monkeypatch.setattr(BuyerAgent, '_unusable', lambda self, a, s: None)
    monkeypatch.setattr(BuyerAgent, '_entry_extra', lambda self, a, acc: {'route': 'danawa', 'entry_url': 'https://danawa'})
    monkeypatch.setattr(BuyerAgent, '_adpick_link', lambda self, u, acc: ('https://deg.kr/x', 1.15))
    return agent


def _assignment() -> Assignment:
    order = OrderRef(order_no='O1', source='HMALL', seller='x', sku='나이키 덩크 DD1391-100', option='270', product_url=PRODUCT)
    return Assignment(order=order, allowed_tools=('run_script', 'progress'), rules='', dry_run=False)


def _run(monkeypatch, agent: BuyerAgent, danawa: int, adpick: int) -> tuple[dict[str, object], list[str]]:
    routes: list[str] = []

    def once(self, a, account, extra=None, probe=False):
        route = str((extra or {}).get('route'))
        routes.append(route)
        paid = adpick if route == 'adpick' else danawa
        return {'cost': paid, 'pay_amount': paid, 'product_url': PRODUCT}

    monkeypatch.setattr(BuyerAgent, '_snapshot_once', once)
    return agent._snapshot(_assignment(), 'edelvise06'), routes


def test_결제액이_같으면_애드픽으로_사고_적립은_원가에_넣지_않는다(hmall, monkeypatch):
    snap, routes = _run(monkeypatch, hmall, 100000, 100000)
    assert routes == ['danawa', 'adpick']
    assert snap['route'] == 'adpick'
    assert snap['cost'] == 100000  # 애드픽 적립(1,150원)은 원가 밖
    assert snap['adpick_reward'] == 1150


def test_다나와가_싸면_다나와로_다시_들어가_산다(hmall, monkeypatch):
    snap, routes = _run(monkeypatch, hmall, 95000, 100000)
    assert routes == ['danawa', 'adpick', 'danawa']  # 제휴코드는 마지막 진입이 덮어쓴다 — 다시 들어간다
    assert snap['route'] == 'danawa' and snap['cost'] == 95000
