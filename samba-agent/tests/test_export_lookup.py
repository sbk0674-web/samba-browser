# 소싱처 미등록 주문 — 판매자상품코드 읽기 요청·읽기·연결
from pathlib import Path

import pytest

from samba_agent.export.desktop.emp import EmpLookupAdapter
from samba_agent.export.desktop.shopmine import ShopMineLookupAdapter
from samba_agent.export.notify import ExportNotifier
from samba_agent.export.routing import ExportRouting
from samba_agent.export.stage import make_lookup_requester
from samba_agent.export.store import ExportQueue
from samba_agent.export.worker import ExportWorker

CODE = 'cp_01KWDQWDMH050PXDY0KNRTPHA1_A01246741'


@pytest.fixture()
def queue(tmp_path: Path) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite')


class ShopUi:
    def __init__(self, codes: dict[str, str]) -> None:
        self.codes = codes
        self.calls: list[str] = []

    def ensure_ready(self) -> None:
        self.calls.append('ready')

    def set_period(self) -> None:
        self.calls.append('period')

    def collect(self) -> None:
        self.calls.append('collect')

    def wait_collected(self, _timeout_s: float) -> None:
        self.calls.append('wait')

    def set_filters(self) -> None:
        self.calls.append('filters')

    def seller_codes(self, order_nos) -> dict[str, str]:
        return {o: self.codes[o] for o in order_nos if o in self.codes}


def test_판매처에_맞는_읽기_대상으로_한_번만_넣는다(queue):
    request = make_lookup_requester(queue, ExportRouting(emp=['현대H몰'], skip=['poison']))
    assert request('S1', '신세계몰(chanol06)') == 'shopmine_lookup'
    assert request('S1', '신세계몰(chanol06)') is None  # 이미 넣었다
    assert request('H1', '현대H몰(MANOL06)') == 'emp_lookup'
    assert request('P1', 'poison(x@y)') is None
    assert queue.pending_order_nos('shopmine_lookup') == ['S1']
    assert queue.pending_order_nos('emp_lookup') == ['H1']


def test_샵마인에서_읽은_코드를_요청의_결과로_남긴다(queue):
    queue.enqueue('S1', 'shopmine_lookup', 0, 0)
    ui = ShopUi({'S1': CODE})
    worker = ExportWorker(
        queue, {'shopmine_lookup': ShopMineLookupAdapter(ui)}, user_idle_s=lambda: 999.0
    )
    done = worker.run_once()
    assert done is not None and done.status == 'done'
    assert done.detail == CODE
    # 읽기만 한다 — 상태를 바꾸는 호출이 없다
    assert ui.calls == ['ready', 'period', 'collect', 'wait', 'filters']


def test_목록에_없거나_코드가_비면_나중에_다시_본다(queue):
    queue.enqueue('S1', 'shopmine_lookup', 0, 0)
    worker = ExportWorker(
        queue,
        {'shopmine_lookup': ShopMineLookupAdapter(ShopUi({'S1': '  '}))},
        user_idle_s=lambda: 999.0,
    )
    out = worker.run_once()
    assert out is not None and out.status == 'pending'


class EmpUi:
    def __init__(self, codes: dict[str, str]) -> None:
        self.codes = codes
        self.calls: list[str] = []

    def ensure_ready(self) -> None:
        self.calls.append('ready')

    def show_only(self, order_no: str) -> None:
        self.calls.append(f'show {order_no}')

    def clear_keyword(self) -> None:
        self.calls.append('clear')

    def seller_code(self, order_no: str) -> str:
        return self.codes.get(order_no, '')


def test_EMP_는_그_주문만_띄워_읽고_목록을_되돌린다():
    ui = EmpUi({'H1': CODE})
    adapter = EmpLookupAdapter(ui)
    assert adapter.complete_pending(['H1']) == {'H1'}
    assert adapter.detail_for('H1') == CODE
    assert ui.calls == ['ready', 'show H1', 'clear']


def _finished(queue: ExportQueue, order_no: str, detail: str) -> None:
    req = queue.enqueue(order_no, 'shopmine_lookup', 0, 0)
    assert queue.claim_next(['shopmine_lookup']) is not None
    queue.done(req.id, detail)


def _notifier(queue: ExportQueue, posts: list[str], link) -> ExportNotifier:
    def post(_thread_ts, text: str) -> bool:
        posts.append(text)
        return True

    return ExportNotifier(
        queue, lambda _o: 't1', post, done_targets=('shopmine_lookup',), link=link
    )


def test_읽어_온_코드의_수집상품_번호로_주문을_잇는다(queue):
    _finished(queue, 'S1', CODE)
    linked: list[tuple[str, str]] = []
    posts: list[str] = []

    def link(order_no: str, collected_product_id: str) -> str:
        linked.append((order_no, collected_product_id))
        return f'{order_no} 연결'

    notifier = _notifier(queue, posts, link)
    assert notifier.tick() == 1
    assert linked == [('S1', 'cp_01KWDQWDMH050PXDY0KNRTPHA1')]
    assert posts == ['S1 연결']
    assert notifier.tick() == 0  # 두 번 잇지 않는다


def test_코드에_수집상품_번호가_없으면_잇지_않고_알린다(queue):
    _finished(queue, 'S1', 'A01246741')
    posts: list[str] = []

    def link(_order_no: str, _collected_product_id: str) -> str:
        raise AssertionError('이으면 안 된다')

    assert _notifier(queue, posts, link).tick() == 1
    assert '수집상품 번호가 없다' in posts[0]


def test_연결이_실패해도_알림_고리는_이어_간다(queue):
    _finished(queue, 'S1', CODE)
    posts: list[str] = []

    def link(_order_no: str, _collected_product_id: str) -> str:
        raise RuntimeError('삼바웨이브 404')

    assert _notifier(queue, posts, link).tick() == 1
    assert '연결 실패' in posts[0]
