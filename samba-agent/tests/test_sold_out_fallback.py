# 품절 대체 — 짝 → 대체 소싱처 순서로 찾고, 찾으면 그쪽 결과를 돌려준다(사용자 2026-11-05)
from types import SimpleNamespace

from samba_agent.agents.buyer import BuyerAgent
from samba_agent.agents.base import AgentFailure
from samba_agent.failures import FailReason


def _agent(name: str) -> BuyerAgent:
    ag = BuyerAgent.__new__(BuyerAgent)
    ag.spec = SimpleNamespace(name=name)
    ag.sibling = None
    ag.fallbacks = []
    ag.notes = []
    ag.note = lambda *x: ag.notes.append(x)
    return ag


def test_tries_sibling_then_fallbacks_and_restores_sibling(monkeypatch):
    import samba_agent.agents.buyer as buyer

    monkeypatch.setattr(buyer, 'source_of', lambda name: SimpleNamespace(id=name.upper()))
    me, sib, fb = _agent('musinsa'), _agent('cm29'), _agent('lotteon')
    me.sibling, me.fallbacks = sib, [fb]
    tried = []

    def cross(a, account, snap):
        tried.append(me.sibling)
        return 'bought' if me.sibling is fb else None

    me._cross_compare = cross
    a = SimpleNamespace(options={})
    err = AgentFailure('fail', '확정 품절', FailReason.OUT_OF_STOCK)
    assert me._sold_out_fallback(a, err) == 'bought'
    assert tried == [sib, fb]
    assert me.sibling is sib


def test_no_cross_option_skips_fallback():
    me = _agent('musinsa')
    me.fallbacks = [_agent('lotteon')]
    err = AgentFailure('fail', '확정 품절', FailReason.OUT_OF_STOCK)
    assert me._sold_out_fallback(SimpleNamespace(options={'no_cross': True}), err) is None
