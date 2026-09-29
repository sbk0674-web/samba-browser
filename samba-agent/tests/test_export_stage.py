# export 단계 — 대상 결정 · 큐 적재 · 결과 대기. 어떤 경우에도 주문 결과는 ok 다
from pathlib import Path

import pytest

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.export.failures import ExportFail
from samba_agent.export.routing import ExportRouting
from samba_agent.export.stage import export_values, make_exporter
from samba_agent.export.store import ExportQueue

ROUTING = ExportRouting(emp=('GS이숍',), skip=('포이즌',), default='shopmine')


def order(seller: str) -> OrderRef:
    return OrderRef(order_no='A1', source='무신사', seller=seller, sku='S1', qty=1)


def recorded(real_price: object = 62470.0, shipping_fee: object = 2300) -> AgentResult:
    return AgentResult(
        status='ok',
        reason='기록 완료',
        payload={
            'saved': True,
            'values': {'real_price': real_price, 'shipping_fee': shipping_fee},
        },
    )


def state(seller: str = 'GS이숍(캐논)', dry_run: bool = False, **results: AgentResult) -> dict:
    return {
        'order': order(seller),
        'options': {},
        'job_id': 1,
        'dry_run': dry_run,
        'results': results or {'recorder': recorded()},
    }


@pytest.fixture()
def queue(tmp_path: Path) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite')


def test_기록한_원가와_배송비를_정수로_꺼낸다():
    assert export_values(state()) == (62470, 2300)


def test_소수_원가는_반올림한다():
    assert export_values(state(recorder=recorded(62469.6, 0))) == (62470, 0)


def test_배송비가_없으면_0():
    assert export_values(state(recorder=recorded(62470, None))) == (62470, 0)


def test_dry_run_기록의_계획값도_읽는다():
    planned = AgentResult(
        status='ok',
        reason='dry-run',
        payload={'saved': False, 'planned': {'real_price': 50000, 'shipping_fee': 3000}},
    )
    assert export_values(state(recorder=planned)) == (50000, 3000)


@pytest.mark.parametrize('cost', [None, 0, -1, '62470', True])
def test_원가가_없거나_숫자가_아니면_값이_없다(cost):
    assert export_values(state(recorder=recorded(cost, 2300))) is None


def test_기록_결과가_없으면_값이_없다():
    buyer = AgentResult(status='ok', reason='구매', payload={'cost': 62470})
    assert export_values(state(**{'buyer.musinsa': buyer})) is None


def test_작업자가_끝내면_done(queue):
    queue.beat(['emp'])

    def sleep(_s: float) -> None:
        req = queue.claim_next(['emp'])
        assert req is not None
        queue.done(req.id, '기입 완료')

    out = make_exporter(queue, ROUTING, wait_s=10, sleep=sleep)(state())
    assert out.status == 'ok'
    assert out.payload == {
        'export': 'done',
        'target': 'emp',
        'cost': 62470,
        'shipping_fee': 2300,
        'detail': '기입 완료',
    }
    assert out.fail_reason is None


def test_작업자가_실패해도_주문_결과는_ok(queue):
    queue.beat(['emp'])

    def sleep(_s: float) -> None:
        req = queue.claim_next(['emp'])
        assert req is not None
        queue.fail(req.id, ExportFail.VALUE_CONFLICT, '이미 다른 값 50,000')

    out = make_exporter(queue, ROUTING, wait_s=10, sleep=sleep)(state())
    assert out.status == 'ok'
    assert out.payload['export'] == 'failed'
    assert out.payload['fail_reason'] == 'value_conflict'
    assert 'value_conflict' in out.reason


def test_작업자가_없으면_기다리지_않고_pending(queue):
    slept: list[float] = []
    out = make_exporter(queue, ROUTING, wait_s=10, sleep=slept.append)(state())
    assert out.status == 'ok'
    assert out.payload['export'] == 'pending'
    assert slept == []
    assert queue.find('A1', 'emp') is not None  # 요청은 큐에 남는다
    assert '대기' in out.reason


def test_대기열에_더_먼저_온_요청이_있으면_기다리지_않고_pending(queue):
    # 리뷰 지적 — I4 (b): alive() 만 보면 대기열이 밀려 있어도 제한 시간을 통째로 쓴다
    queue.beat(['emp'])
    queue.enqueue('B9', 'emp', 1000, 0)  # 이 요청보다 먼저 온 대기 건
    slept: list[float] = []
    out = make_exporter(queue, ROUTING, wait_s=10, sleep=slept.append)(state())
    assert out.payload['export'] == 'pending'
    assert slept == []


def test_나머지_판매처는_샵마인으로_넣는다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state(seller='스마트스토어'))
    assert out.payload['target'] == 'shopmine'
    assert queue.find('A1', 'shopmine') is not None


def test_제외_판매처는_큐에_넣지_않는다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state(seller='포이즌'))
    assert out.status == 'ok'
    assert out.payload['export'] == 'skipped'
    assert queue.recent() == []


def test_원가가_없으면_큐에_넣지_않는다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state(recorder=recorded(None, 0)))
    assert out.status == 'ok'
    assert out.payload['export'] == 'skipped'
    assert queue.recent() == []


def test_dry_run_은_계획만_돌려준다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state(dry_run=True))
    assert out.status == 'ok'
    assert out.payload == {
        'export': 'planned',
        'target': 'emp',
        'cost': 62470,
        'shipping_fee': 2300,
    }
    assert queue.recent() == []


def test_dry_run_표시가_없으면_dry_run_으로_본다(queue):
    s = state()
    del s['dry_run']
    out = make_exporter(queue, ROUTING, wait_s=0)(s)
    assert out.payload['export'] == 'planned'
    assert queue.recent() == []


def test_이미_기입한_주문을_다른_값으로_다시_넣으면_conflict(queue):
    req = queue.enqueue('A1', 'emp', 50000, 2300)
    queue.claim_next(['emp'])
    queue.done(req.id, '기입 완료')
    out = make_exporter(queue, ROUTING, wait_s=0)(state())
    assert out.status == 'ok'
    assert out.payload['export'] == 'conflict'
    assert queue.get(req.id).cost == 50000


def test_근거를_남긴다(queue):
    out = make_exporter(queue, ROUTING, wait_s=0)(state())
    assert [e.label for e in out.evidence] == ['외부 기입']
    assert 'emp' in out.evidence[0].detail


def test_취소한_주문은_판매처에_맞는_취소_대상으로_넣는다(queue):
    from samba_agent.export.stage import make_cancel_exporter

    sellers = {'A1': '쿠팡(seller02)', 'G1': 'GS이숍(캐논)', 'P1': 'poison(x@y)'}
    routing = ExportRouting(emp=['GS이숍'], skip=['poison'])
    export_cancel = make_cancel_exporter(queue, routing, sellers.get)
    assert export_cancel('A1') == 'shopmine 취소 연동 요청함'
    assert export_cancel('G1') == 'emp 취소 연동 요청함'
    assert export_cancel('P1') is None
    assert queue.pending_order_nos('shopmine_cancel') == ['A1']
    assert queue.pending_order_nos('emp_cancel') == ['G1']


def test_취소_연동_요청이_실패해도_예외를_내지_않는다(queue):
    from samba_agent.export.stage import make_cancel_exporter

    def broken(_order_no: str) -> str:
        raise RuntimeError('조회 실패')

    export_cancel = make_cancel_exporter(queue, ExportRouting(), broken)
    assert export_cancel('A1') == '외부 취소 연동 요청 실패: RuntimeError'


def test_구매까지_끝낸_주문은_취소_연동하지_않는다(queue):
    from samba_agent.export.stage import make_cancel_exporter

    queue.enqueue('A1', 'shopmine', 50000, 0)
    export_cancel = make_cancel_exporter(queue, ExportRouting(), lambda _o: '쿠팡(unclehg)')
    assert export_cancel('A1') == '구매까지 끝낸 주문 — 취소 연동하지 않음'
    assert queue.find('A1', 'shopmine_cancel') is None


def test_나중에_하는_대상은_기다리지_않고_예약으로_끝낸다(queue):
    queue.beat(['emp'])
    slept: list[float] = []
    out = make_exporter(queue, ROUTING, wait_s=240, sleep=slept.append, deferred=('emp',))(state())
    assert out.payload['export'] == 'pending'
    assert slept == []
    assert '예약' in out.reason
    assert queue.find('A1', 'emp') is not None


def test_한_번_시도한_대기_요청은_기다림을_막지_않는다(queue):
    queue.beat(['emp'])
    old = queue.enqueue('B9', 'emp', 1000, 0)
    claimed = queue.claim_next(['emp'])
    assert claimed is not None and claimed.id == old.id
    queue.retry_later(old.id, ExportFail.NOT_FOUND, '아직 없다', 600)

    def sleep(_s: float) -> None:
        req = queue.claim_next(['emp'])
        assert req is not None
        queue.done(req.id, '기입 완료')

    out = make_exporter(queue, ROUTING, wait_s=10, sleep=sleep)(state())
    assert out.payload['export'] == 'done'


def test_취소_연동은_작업자가_끝내면_완료로_알린다(queue):
    from samba_agent.export.stage import make_cancel_exporter

    queue.beat(['shopmine_cancel'])

    def sleep(_s: float) -> None:
        req = queue.claim_next(['shopmine_cancel'])
        assert req is not None
        queue.done(req.id, '처리 1건')

    export_cancel = make_cancel_exporter(
        queue, ExportRouting(), lambda _o: '쿠팡(unclehg)', wait_s=10, sleep=sleep
    )
    assert export_cancel('A1') == 'shopmine 취소 연동 완료'


def _with_memo(memo: str) -> AgentResult:
    return AgentResult(
        status='ok',
        reason='기록 완료',
        payload={
            'saved': True,
            'values': {'real_price': 62470, 'shipping_fee': 0, 'arrival_memo': memo},
        },
    )


def test_도착예정_메모는_샵마인_요청에_함께_넣는다(queue):
    make_exporter(queue, ROUTING, wait_s=0)(
        state(seller='스마트스토어', recorder=_with_memo('[도착예정] 10/05(일)'))
    )
    assert queue.find('A1', 'shopmine').memo == '[도착예정] 10/05(일)'


def test_EMP_요청에는_메모를_넣지_않는다(queue):
    make_exporter(queue, ROUTING, wait_s=0, deferred=('emp',))(
        state(seller='GS이숍(캐논)', recorder=_with_memo('[도착예정] 10/05(일)'))
    )
    assert queue.find('A1', 'emp').memo == ''
