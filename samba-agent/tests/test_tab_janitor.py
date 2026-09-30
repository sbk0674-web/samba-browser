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
    bridge.tabs = [{'id': 'old'}, {'id': 'mine'}, {'id': 'fp1', 'lane': 'fp'}, {'id': 'pop', 'lane': 'fp'}]
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
