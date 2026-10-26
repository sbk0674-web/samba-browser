"""작업이 연 탭 정리 — 다른 레인이 연 탭(lane 표시)은 닫지 않는다."""

import json
from types import SimpleNamespace

from samba_agent.queue.tabs import TabJanitor


class _Bridge:
    def __init__(self, tabs: list[dict[str, object]]) -> None:
        self.tabs = tabs
        self.closed: list[str] = []

    def call(self, name: str, **kw: object) -> SimpleNamespace:
        if name == 'list_tabs':
            return SimpleNamespace(result=json.dumps(self.tabs))
        if name == 'close_tab':
            self.closed.append(str(kw['id']))
            return SimpleNamespace(result='ok')
        raise AssertionError(name)


def test_다른_레인_탭은_닫지_않는다():
    # 실기 2026-09-27: 하네스 작업이 끝나며 사람이 fp 레인에서 진행하던 패션플러스 주문서를 닫았다
    bridge = _Bridge([{'id': 'old'}])
    janitor = TabJanitor(bridge)  # type: ignore[arg-type]
    before = janitor.snapshot()
    bridge.tabs = [
        {'id': 'old'},
        {'id': 'mine'},
        {'id': 'fp1', 'lane': 'fp'},
        {'id': 'pop', 'lane': 'fp'},
    ]
    assert janitor.close_new(before) == 1
    assert bridge.closed == ['mine']


def test_시작_전_정리도_다른_레인_탭은_닫지_않는다(monkeypatch):
    # 실기 2026-09-30: 새 작업 시작 때 수동 재현 중이던 주문서 탭(mine 레인)이 닫혔다
    monkeypatch.delenv('SAMBA_KEEP_TAB_HOSTS', raising=False)
    bridge = _Bridge(
        [
            {'id': 'a', 'url': 'https://www.fashionplus.co.kr/order/1'},
            {'id': 'b', 'url': 'https://www.fashionplus.co.kr/order/2', 'lane': 'mine'},
        ]
    )
    assert TabJanitor(bridge).close_leftovers(keep_hosts=()) == 1  # type: ignore[arg-type]
    assert bridge.closed == ['a']


def test_하네스_소유_타오바오_탭도_끝나면_닫는다():
    bridge = _Bridge([{'id': 'tb', 'lane': 'taobao'}, {'id': 'user', 'lane': 'user'}])
    janitor = TabJanitor(bridge, owned_lanes=frozenset({'taobao'}))
    assert janitor.close_new(frozenset()) == 1
    assert bridge.closed == ['tb']


def test_harness_lane_cleanup_preserves_user_and_other_lanes():
    bridge = _Bridge(
        [
            {'id': 'h1', 'lane': 'harness'},
            {'id': 'tb', 'lane': 'taobao'},
            {'id': 'user', 'lane': 'user'},
            {'id': 'audit', 'lane': 'codex-audit'},
        ]
    )
    janitor = TabJanitor(bridge, owned_lanes=frozenset({'taobao', 'harness'}))
    assert janitor.close_new(frozenset()) == 2
    assert bridge.closed == ['h1', 'tb']


def test_하네스가_만든_레인의_탭은_닫는다():
    # 실기 2026-10-26: buyer 레인(musinsa-edelvise06)·operator 탭이 소유 목록에 없어 한 번도 안 닫혀 44개까지 쌓였다
    from samba_agent.bridge.client import BridgeClient

    root = BridgeClient('http://127.0.0.1:1', 't', allowed=('list_tabs',))
    root.with_lane('musinsa-edelvise06')
    root.with_lane('operator')
    bridge = _Bridge([{'id': 'old'}])
    janitor = TabJanitor(bridge)  # type: ignore[arg-type]
    before = janitor.snapshot()
    bridge.tabs = [
        {'id': 'old'},
        {'id': 'b1', 'lane': 'musinsa-edelvise06'},
        {'id': 'op', 'lane': 'operator'},
        {'id': 'fp1', 'lane': 'fp'},
        {'id': 'me', 'lane': 'user'},
    ]
    assert janitor.close_new(before) == 2
    assert sorted(bridge.closed) == ['b1', 'op']
    bridge.closed.clear()
    bridge.tabs = [
        {
            'id': 'b2',
            'lane': 'musinsa-edelvise06',
            'url': 'https://www.musinsa.com/products/3259540',
        },
        {'id': 'me', 'lane': 'user', 'url': 'https://www.musinsa.com/'},
    ]
    assert janitor.close_leftovers(keep_hosts=()) == 1
    assert bridge.closed == ['b2']
