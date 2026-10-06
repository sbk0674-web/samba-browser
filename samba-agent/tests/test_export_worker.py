# 입력 작업자 — 읽기 → (필요하면) 쓰기 → 되읽기. 덮어쓰지 않고, 한 번에 한 건만
from pathlib import Path

import pytest

from samba_agent.export.adapters import AdapterReject, AdapterRetry, CellValues
from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportQueue
from samba_agent.export.worker import ExportWorker


class FakeAdapter:
    """메모리 위의 주문 표. 실제 화면 대신 쓴다."""

    def __init__(self, rows: dict[str, CellValues] | None = None) -> None:
        self.rows = dict(rows or {})
        self.calls: list[str] = []
        self.read_error: Exception | None = None
        self.write_error: Exception | None = None
        # 쓰기가 값을 다르게 저장하는 고장(되읽기 불일치 시험용)
        self.corrupt = False

    def read(self, order_no: str) -> CellValues:
        self.calls.append(f'read {order_no}')
        if self.read_error is not None:
            raise self.read_error
        if order_no not in self.rows:
            raise AdapterReject(ExportFail.NOT_FOUND, f'{order_no} 없음')
        return self.rows[order_no]

    def write(self, order_no: str, cost: int, shipping_fee: int, memo: str = '') -> None:
        self.calls.append(f'write {order_no} {cost} {shipping_fee}' + (f' {memo}' if memo else ''))
        if self.write_error is not None:
            raise self.write_error
        self.rows[order_no] = CellValues(
            cost + 1 if self.corrupt else cost,
            shipping_fee,
            memo or self.rows.get(order_no, EMPTY).memo,
        )


EMPTY = CellValues(None, None)


@pytest.fixture()
def queue(tmp_path: Path) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite')


def worker(queue, adapter, idle: float = 999.0, **kw) -> ExportWorker:
    return ExportWorker(queue, {'emp': adapter}, user_idle_s=lambda: idle, **kw)


def test_빈_셀에_기입하고_되읽어_확인한다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    out = worker(queue, adapter).run_once()
    assert out is not None
    assert out.id == req.id
    assert out.status == 'done'
    assert adapter.rows['A1'] == CellValues(62470, 2300)
    assert adapter.calls == ['read A1', 'write A1 62470 2300', 'read A1']


def test_0_은_빈_셀로_본다(queue):
    adapter = FakeAdapter({'A1': CellValues(0, 0)})
    queue.enqueue('A1', 'emp', 62470, 2300)
    assert worker(queue, adapter).run_once().status == 'done'
    assert adapter.rows['A1'] == CellValues(62470, 2300)


def test_이미_같은_값이면_입력하지_않는다(queue):
    adapter = FakeAdapter({'A1': CellValues(62470, 2300)})
    queue.enqueue('A1', 'emp', 62470, 2300)
    out = worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert adapter.calls == ['read A1']
    assert '이미' in (out.detail or '')


def test_배송비_0_과_빈_셀은_같은_값이다(queue):
    adapter = FakeAdapter({'A1': CellValues(62470, None)})
    queue.enqueue('A1', 'emp', 62470, 0)
    out = worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert adapter.calls == ['read A1']


def test_한쪽만_비어_있으면_기입한다(queue):
    adapter = FakeAdapter({'A1': CellValues(None, 2300)})
    queue.enqueue('A1', 'emp', 62470, 2300)
    assert worker(queue, adapter).run_once().status == 'done'
    assert adapter.rows['A1'] == CellValues(62470, 2300)


@pytest.mark.parametrize(
    'current', [CellValues(50000, 2300), CellValues(62470, 3000), CellValues(50000, None)]
)
def test_다른_값이_있으면_덮어쓰지_않는다(queue, current):
    adapter = FakeAdapter({'A1': current})
    queue.enqueue('A1', 'emp', 62470, 2300)
    out = worker(queue, adapter).run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'value_conflict'
    assert adapter.rows['A1'] == current
    assert adapter.calls == ['read A1']


def test_되읽은_값이_다르면_실패하고_재시도하지_않는다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.corrupt = True
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'verify_mismatch'
    assert w.run_once() is None  # 다시 집히지 않는다


def test_주문이_없으면_실패하고_재시도하지_않는다(queue):
    adapter = FakeAdapter({})
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'not_found'
    assert w.run_once() is None


def test_창이_없으면_나중에_다시_한다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.read_error = AdapterRetry(ExportFail.WINDOW_MISSING, 'EMP 창 없음')
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter, retry_delay_s=0)
    out = w.run_once()
    assert out.status == 'pending'
    assert out.fail_reason == 'window_missing'
    adapter.read_error = None
    assert w.run_once().status == 'done'


def test_재시도_한도를_넘으면_실패로_끝낸다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    # 대화상자(BLOCKED)는 기다리는 사유라 횟수에 넣지 않는다 — 한도는 시간 초과 같은 실패에만
    adapter.read_error = AdapterRetry(ExportFail.TIMEOUT, '화면이 늦게 떴다')
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter, retry_delay_s=0, max_attempts=3)
    assert w.run_once().status == 'pending'
    assert w.run_once().status == 'pending'
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'timeout'
    assert out.attempts == 3
    assert '재시도' in (out.detail or '')


def test_쓰기_도중_모르는_오류는_재시도하지_않는다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    adapter.write_error = RuntimeError('알 수 없는 오류')
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter, retry_delay_s=0)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'unknown'
    assert w.run_once() is None


def test_사람이_쓰는_중이면_집지_않는다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    assert worker(queue, adapter, idle=3.0).run_once() is None
    assert queue.get(req.id).status == 'pending'
    assert queue.get(req.id).attempts == 0
    assert adapter.calls == []


def test_어댑터가_없는_대상은_집지_않는다(queue):
    req = queue.enqueue('A1', 'shopmine', 62470, 2300)
    assert worker(queue, FakeAdapter({'A1': EMPTY})).run_once() is None
    assert queue.get(req.id).status == 'pending'


def test_어댑터가_하나도_없으면_아무것도_하지_않는다(queue):
    queue.enqueue('A1', 'emp', 62470, 2300)
    w = ExportWorker(queue, {}, user_idle_s=lambda: 999.0)
    assert w.run_once() is None


def test_한_번에_한_건만_처리한다(queue):
    adapter = FakeAdapter({'A1': EMPTY, 'A2': EMPTY})
    queue.enqueue('A1', 'emp', 1000, 0)
    queue.enqueue('A2', 'emp', 2000, 0)
    w = worker(queue, adapter)
    assert w.run_once().order_no == 'A1'
    assert adapter.rows['A2'] == EMPTY
    assert w.run_once().order_no == 'A2'
    assert w.run_once() is None


def test_기입_성공_뒤_큐_기록이_실패하면_예외가_나가고_행은_running으로_남는다(queue):
    # 리뷰 지적 — M2: 기입은 성공했는데 그 뒤 queue.done() 이 실패하면 UNKNOWN 실패로
    # 잘못 기록되면 안 된다 — 예외가 그대로 나가고, 행은 running 그대로 남아야 한다
    # (재시작 때 recover_running 이 되돌린다).
    adapter = FakeAdapter({'A1': EMPTY})
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    w = worker(queue, adapter)

    real_done = queue.done
    calls = {'n': 0}

    def boom_once(request_id, detail):
        calls['n'] += 1
        if calls['n'] == 1:
            raise RuntimeError('디스크 오류')
        real_done(request_id, detail)

    queue.done = boom_once  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match='디스크 오류'):
        w.run_once()

    queue.done = real_done  # type: ignore[method-assign]
    assert queue.get(req.id).status == 'running'
    assert adapter.rows['A1'] == CellValues(62470, 2300)  # 기입 자체는 이미 성공했다


def test_run_forever_는_생존_표시를_남기고_멈춘다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    queue.enqueue('A1', 'emp', 62470, 2300)
    stops = iter([False, False, True])
    slept: list[float] = []
    worker(queue, adapter).run_forever(lambda: next(stops), poll_s=3.0, sleep=slept.append)
    assert queue.alive('emp') is True
    assert queue.find('A1', 'emp').status == 'done'
    assert slept == [3.0]  # 첫 바퀴는 일을 했으니 쉬지 않고, 둘째 바퀴는 할 일이 없어 쉰다


def test_run_forever_는_사람이_바쁘면_생존_표시도_남기지_않는다(queue):
    # 리뷰 지적 — I4 (a): alive() 는 '처리 가능'이 아니라 '살아 있음'이다 — 집을 수 없을 때
    # beat 를 남기면 export 단계가 alive() 만 보고 기다려 주문마다 대기 시간을 통째로 쓴다
    adapter = FakeAdapter({'A1': EMPTY})
    queue.enqueue('A1', 'emp', 62470, 2300)
    stops = iter([False, True])
    slept: list[float] = []
    worker(queue, adapter, idle=3.0).run_forever(
        lambda: next(stops), poll_s=3.0, sleep=slept.append
    )
    assert queue.alive('emp') is False
    assert queue.find('A1', 'emp').status == 'pending'  # 바빠서 집지도 않았다


def test_run_forever_는_고리_오류로_죽지_않는다(queue):
    class Broken(FakeAdapter):
        def read(self, order_no: str) -> CellValues:
            raise AdapterRetry(ExportFail.TIMEOUT, '응답 없음')

    queue.enqueue('A1', 'emp', 62470, 2300)
    stops = iter([False, True])
    worker(queue, Broken(), retry_delay_s=0).run_forever(lambda: next(stops), sleep=lambda _s: None)
    assert queue.find('A1', 'emp').status == 'pending'


class FakeBatch:
    """배치형 어댑터 가짜 — 넘겨받은 주문번호 중 `present` 에 있는 것만 처리했다고 답하거나 예외를 낸다."""

    def __init__(self, present: tuple[str, ...] = ()) -> None:
        self.present = set(present)
        self.calls: list[list[str]] = []
        self.error: Exception | None = None

    def complete_pending(self, order_nos) -> set[str]:
        self.calls.append(list(order_nos))
        if self.error is not None:
            raise self.error
        return {o for o in order_nos if o in self.present}


def batch_worker(queue, adapter, idle: float = 999.0, **kw) -> ExportWorker:
    return ExportWorker(queue, {'shopmine': adapter}, user_idle_s=lambda: idle, **kw)


def test_배치_어댑터는_대기_주문번호를_모두_넘기고_처리된_것만_끝낸다(queue):
    adapter = FakeBatch(present=('A1', 'A3'))
    a = queue.enqueue('A1', 'shopmine', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    c = queue.enqueue('A3', 'shopmine', 3000, 0)
    out = batch_worker(queue, adapter).run_once()
    assert out is not None and out.id == a.id
    assert out.status == 'done'
    assert out.detail == '처리 2건'
    assert adapter.calls == [['A1', 'A2', 'A3']]
    assert queue.get(b.id).status == 'pending'  # 화면에 없던 주문은 남는다
    assert queue.get(c.id).status == 'done'
    assert queue.get(c.id).detail == '처리 2건'


def test_집은_주문이_화면에_없으면_나중에_다시_한다(queue):
    adapter = FakeBatch(present=('A2',))
    a = queue.enqueue('A1', 'shopmine', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    out = batch_worker(queue, adapter, retry_delay_s=0).run_once()
    assert out.status == 'pending'
    assert out.fail_reason == 'not_found'
    assert queue.get(b.id).status == 'done'  # 함께 넘긴 다른 주문은 처리됐다
    assert queue.get(a.id).attempts == 1


def test_집은_주문을_끝내_못_찾으면_실패로_끝낸다(queue, monkeypatch):
    adapter = FakeBatch(present=())
    queue.enqueue('A1', 'shopmine', 1000, 0)
    w = batch_worker(queue, adapter, retry_delay_s=0, max_attempts=2)
    assert w.run_once().status == 'pending'
    # 하루가 지나기 전에는 횟수를 넘겨도 다시 본다(수집이 늦는 주문, 2026-10-01)
    assert w.run_once().status == 'pending'
    monkeypatch.setattr('samba_agent.export.worker._age_s', lambda _req: 25 * 3600)
    out = w.run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'not_found'
    assert out.attempts == 3


def test_배치_어댑터의_재시도_사유는_대기_요청을_건드리지_않는다(queue):
    adapter = FakeBatch()
    adapter.error = AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 창 없음')
    queue.enqueue('A1', 'shopmine', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    out = batch_worker(queue, adapter, retry_delay_s=0).run_once()
    assert out.status == 'pending'
    assert out.fail_reason == 'window_missing'
    assert queue.get(b.id).status == 'pending'
    assert queue.get(b.id).attempts == 0


def test_배치_어댑터의_거절은_집은_요청만_실패시킨다(queue):
    adapter = FakeBatch()
    adapter.error = AdapterReject(ExportFail.VERIFY_MISMATCH, '완료됨 뒤에도 2건 남음')
    queue.enqueue('A1', 'shopmine', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    out = batch_worker(queue, adapter).run_once()
    assert out.status == 'failed'
    assert out.fail_reason == 'verify_mismatch'
    assert queue.get(b.id).status == 'pending'  # 다음 요청이 다시 일괄 처리를 돌린다


def test_배치_어댑터와_셀_어댑터가_함께_등록돼도_대상별로_고른다(queue):
    cell = FakeAdapter({'E1': EMPTY})
    batch = FakeBatch(present=('S1',))
    queue.enqueue('E1', 'emp', 62470, 2300)
    queue.enqueue('S1', 'shopmine', 1000, 0)
    w = ExportWorker(queue, {'emp': cell, 'shopmine': batch}, user_idle_s=lambda: 999.0)
    first = w.run_once()
    second = w.run_once()
    assert {first.target, second.target} == {'emp', 'shopmine'}
    assert cell.rows['E1'] == CellValues(62470, 2300)
    assert batch.calls == [['S1']]


def test_대상마다_기다리는_시간이_다르다(queue):
    cell = FakeAdapter()
    batch = FakeBatch(present=('S1',))
    queue.enqueue('E1', 'emp', 1000, 0)
    queue.enqueue('S1', 'shopmine', 1000, 0)
    idle = {'s': 10.0}
    w = ExportWorker(
        queue,
        {'emp': cell, 'shopmine': batch},
        user_idle_s=lambda: idle['s'],
        min_idle_s=0.0,
        min_idle_by_target={'emp': 180.0},
    )
    # 사람이 쓰는 중 — 샵마인만 집는다
    assert w.ready_targets() == ('shopmine',)
    done = w.run_once()
    assert done is not None and done.target == 'shopmine'
    assert w.run_once() is None
    assert queue.find('E1', 'emp').status == 'pending'
    # 3분 넘게 멈췄다 — EMP 도 집는다
    idle['s'] = 200.0
    done = w.run_once()
    assert done is not None and done.target == 'emp'


def test_사람이_돌아와_멈춘_것은_시도_횟수에_넣지_않는다(queue):
    adapter = FakeAdapter()
    adapter.read_error = AdapterRetry(ExportFail.BUSY, '사람이 PC 를 쓰기 시작해 멈췄다')
    queue.enqueue('E1', 'emp', 1000, 0)
    w = worker(queue, adapter, retry_delay_s=0)
    for _ in range(8):
        w.run_once()
    req = queue.find('E1', 'emp')
    assert req.status == 'pending'
    assert req.attempts == 0
    assert req.fail_reason == 'busy'


def test_인증_창은_시도_횟수에_넣지_않고_한_번만_알린다(queue):
    adapter = FakeAdapter()
    adapter.read_error = AdapterRetry(ExportFail.AUTH_REQUIRED, '샵마인 관리자 추가인증 창')
    queue.enqueue('E1', 'emp', 1000, 0)
    alerts: list[tuple[str, str]] = []
    w = worker(
        queue,
        adapter,
        retry_delay_s=0,
        on_auth_required=lambda program, detail: alerts.append((program, detail)),
    )
    for _ in range(8):
        w.run_once()
    req = queue.find('E1', 'emp')
    assert req.status == 'pending'
    assert req.attempts == 0
    assert alerts == [('emp', '샵마인 관리자 추가인증 창')]


def test_메모가_있으면_함께_넣고_되읽어_확인한다(queue):
    adapter = FakeAdapter({'A1': EMPTY})
    queue.enqueue('A1', 'emp', 62470, 2300, '202609291041430002')
    out = worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert adapter.calls[1] == 'write A1 62470 2300 202609291041430002'
    assert '메모 202609291041430002' in out.detail


def test_값은_같고_메모만_없으면_메모를_넣는다(queue):
    adapter = FakeAdapter({'A1': CellValues(62470, 2300, '')})
    queue.enqueue('A1', 'emp', 62470, 2300, 'S123')
    out = worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert 'write A1 62470 2300 S123' in adapter.calls


def test_메모가_이미_들어_있으면_쓰지_않는다(queue):
    adapter = FakeAdapter({'A1': CellValues(62470, 2300, '사람 메모 / S123')})
    queue.enqueue('A1', 'emp', 62470, 2300, 'S123')
    out = worker(queue, adapter).run_once()
    assert out.status == 'done'
    assert not any(c.startswith('write') for c in adapter.calls)


class FakeCancelAdapter:
    """취소 연동(일괄형) 대역 — 넘겨받은 주문을 전부 처리했다고 답한다."""

    one_at_a_time = False

    def __init__(self) -> None:
        self.seen: list[list[str]] = []

    def complete_pending(self, order_nos):
        self.seen.append(list(order_nos))
        return list(order_nos)


def test_취소_연동은_주문이_지금도_취소_상태일_때만_실행한다(queue):
    """실기 2026-10-01: 취소중으로 돌렸다가 나중에 이행된 주문에 EMP 취소가 대기로 남아 있었다."""
    from samba_agent.export.adapters import BatchAdapter

    adapter = FakeCancelAdapter()
    assert isinstance(adapter, BatchAdapter)
    state = {'A1': False, 'A2': True, 'A3': None}
    w = ExportWorker(
        queue, {'emp_cancel': adapter}, user_idle_s=lambda: 999.0, still_cancelling=lambda no: state[no]
    )
    for no in ('A1', 'A2', 'A3'):
        queue.enqueue(no, 'emp_cancel', 0, 0)
    first = w.run_once()  # A1 — 이미 이행된 주문: 프로그램을 건드리지 않고 끝낸다
    assert first.order_no == 'A1' and first.status == 'failed'
    assert adapter.seen == []
    second = w.run_once()  # A2 — 취소 상태. 확인 못 한 A3 은 묶음에 태우지 않는다
    assert second.order_no == 'A2' and second.status == 'done'
    assert adapter.seen == [['A2']]
    third = w.run_once()  # A3 — 상태를 확인 못 했다: 실행하지 않고 미룬다
    assert third.order_no == 'A3' and third.status == 'pending'
    assert adapter.seen == [['A2']]


def test_EMP_취소는_몇_번_시도해도_화면에_없으면_사람이_처리한_것으로_보고_완료로_닫는다(queue):
    adapter = FakeBatch(present=())
    queue.enqueue('A1', 'emp_cancel', 0, 0)
    w = ExportWorker(queue, {'emp_cancel': adapter}, user_idle_s=lambda: 999.0, retry_delay_s=0, max_attempts=2)
    assert w.run_once().status == 'pending'
    # 하루를 기다리지 않는다 — 횟수만 채우면 처리완료(사용자 2026-10-06)
    out = w.run_once()
    assert out.status == 'done'
    assert '사람이 이미 처리' in out.detail
    assert out.attempts == 2


def test_EMP_취소가_아닌_대상은_못_찾아도_실패로_남는다(queue, monkeypatch):
    adapter = FakeBatch(present=())
    queue.enqueue('A1', 'shopmine', 1000, 0)
    w = batch_worker(queue, adapter, retry_delay_s=0, max_attempts=2)
    w.run_once()
    assert w.run_once().status == 'pending'
    monkeypatch.setattr('samba_agent.export.worker._age_s', lambda _req: 25 * 3600)
    assert w.run_once().status == 'failed'
