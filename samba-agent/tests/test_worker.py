# 실행기 — 1건 처리 / 승인 대기 / 재개 / 거부 / 중복 요청 / 브릿지 죽음
import threading

import pytest
from langgraph.checkpoint.memory import MemorySaver

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.ops.events import EventLog
from samba_agent.ops.gate import _observe_ok
from samba_agent.queue.db import JobQueue
from samba_agent.queue.worker import Worker, WorkerDeps
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.graph import build_supervisor


def order_of(job) -> OrderRef:
    return OrderRef(order_no=job.order_no, source='무신사', seller='포이즌', sku='S1', qty=1)


def agents(log, fail_at=None):
    def mk(name, **payload):
        def fn(_a):
            log.append(name)
            if fail_at == name:
                return AgentResult(
                    status='fail', reason='브릿지 끊김', fail_reason=FailReason.BRIDGE_DOWN
                )
            return AgentResult(status='ok', reason=f'{name} 정상', payload=payload)

        return fn

    return {
        'buyer.musinsa': mk('buy', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5),
        'payer': mk('pay', paid=True),
        'recorder': mk('record', saved=True),
        'verifier': mk('verify'),
    }


@pytest.fixture()
def setup(tmp_path):
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    log: list[str] = []
    sent: list[str] = []

    def make(gate: bool, fail_at=None) -> Worker:
        graph = build_supervisor(reg, agents(log, fail_at), checkpointer=MemorySaver(), gate=gate)
        return Worker(
            WorkerDeps(
                queue=q,
                graph=graph,
                version='vtest',
                report=lambda job, line: sent.append(line),
                parse_order=order_of,
            )
        )

    return q, log, sent, make


def test_게이트_없이_한_건을_끝까지_돌린다(setup):
    q, log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    job = make(gate=False).tick()
    assert job.state == 'done'
    assert log == ['buy', 'pay', 'record', 'verify']
    assert q.get('A1').state == 'done'
    assert q.get('A1').harness_version == 'vtest'
    assert any('vtest' in s for s in sent)
    assert any('done' in s or '완료' in s for s in sent)


def test_승인_대기에서_멈추고_요약을_보고한다(setup):
    q, log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    job = make(gate=True).tick()
    assert job.state == 'needs_human'
    assert '승인 대기' in q.get('A1').step
    assert any('승인 요청' in s for s in sent)
    assert log == ['buy']


def test_승인하면_이어서_끝난다(setup):
    q, log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=True)
    w.tick()
    job = w.resume('A1', approved=True, by='U9')  # 결제 승인 하나로 끝까지 간다
    assert job.state == 'done'
    assert log == ['buy', 'pay', 'record', 'verify']


def test_거부하면_사람에게_남는다(setup):
    q, log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=True)
    w.tick()
    job = w.resume('A1', approved=False, by='U9')
    assert job.state == 'needs_human'
    assert log == ['buy']


def test_끝난_주문의_재개는_무시한다(setup):
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)
    w.tick()
    assert w.resume('A1', approved=True, by='U9') is None


def test_같은_주문을_두_번_넣어도_한_번만_돈다(setup):
    q, log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    q.enqueue('A1', 'U2', {}, 'ts2')  # 중복 — 새 행이 생기지 않는다
    w = make(gate=False)
    assert w.tick() is not None
    assert w.tick() is None
    assert log.count('buy') == 1


def test_브릿지가_죽으면_사람에게_넘기고_사유를_남긴다(setup):
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    job = make(gate=False, fail_at='buy').tick()
    assert job.state == 'needs_human'
    assert 'bridge_down' in q.get('A1').error


def test_그래프가_예외를_던지면_needs_human으로_마감하고_사유를_가린다(setup):
    q, _log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)

    def boom(*_a, **_k):
        raise RuntimeError('디비 연결 실패: hong@example.com')

    w.d.graph.invoke = boom  # type: ignore[method-assign]
    job = w.tick()

    assert job is not None
    assert job.state == 'needs_human'  # running 으로 남지 않는다
    assert q.get('A1').error == 'unknown'
    assert any('***' in s and 'hong@example.com' not in s for s in sent)


def test_run_forever는_tick_예외에도_계속_돈다(setup):
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)

    calls = {'n': 0}

    def tick_boom():
        calls['n'] += 1
        raise RuntimeError('예상 못한 오류')

    w.tick = tick_boom  # type: ignore[method-assign]
    ticks = iter([False, False, True])
    w.run_forever(stop=lambda: next(ticks), interval_s=0)

    assert calls['n'] == 2  # 프로세스가 살아서 다음 주기로 계속 돈다


def test_동시에_두번_resume해도_그래프는_한번만_불린다(setup):
    # 리뷰 지적 — Important 3: 읽기→running 전환을 트랜잭션으로 원자화했는지 확인
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=True)
    w.tick()
    assert q.get('A1').step == '승인 대기: pay'

    lock = threading.Lock()
    invoke_calls: list[int] = []
    real_invoke = w.d.graph.invoke

    def counting_invoke(state, config):
        with lock:
            invoke_calls.append(1)
        return real_invoke(state, config)

    w.d.graph.invoke = counting_invoke  # type: ignore[method-assign]

    barrier = threading.Barrier(2)
    results: list[object] = []
    results_lock = threading.Lock()

    def call_resume() -> None:
        barrier.wait()
        r = w.resume('A1', approved=True, by='U9', stage='pay')
        with results_lock:
            results.append(r)

    threads = [threading.Thread(target=call_resume) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(invoke_calls) == 1
    assert sum(1 for r in results if r is not None) == 1


def test_version이_콜러블이면_tick마다_다시_불러_새_버전을_기록한다(setup):
    # 리뷰 지적 — Important 1: 규칙 파일을 PUT 으로 고쳐 harness_version 이 바뀌면
    # 다음 tick 은 옛 버전이 아니라 새 버전을 큐에 남겨야 한다.
    q, _log, sent, _make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    q.enqueue('A2', 'U1', {}, 'ts2')
    reg = Registry.load(DEFAULT_ROOT)
    graph = build_supervisor(reg, agents([]), checkpointer=MemorySaver(), gate=False)
    versions = iter(['v1', 'v2'])
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version=lambda: next(versions),
            report=lambda job, line: sent.append(line),
            parse_order=order_of,
        )
    )
    w.tick()
    w.tick()
    assert q.get('A1').harness_version == 'v1'
    assert q.get('A2').harness_version == 'v2'


def test_dry_run_False로_주입하면_state에_반영된다(setup):
    q, _log, _sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)
    seen = {}
    real_invoke = w.d.graph.invoke

    def spy(state, config):
        seen['dry_run'] = state.get('dry_run') if isinstance(state, dict) else None
        return real_invoke(state, config)

    w.d.graph.invoke = spy  # type: ignore[method-assign]
    w.d.dry_run = False
    w.tick()

    assert seen['dry_run'] is False


def test_승인_요청은_approval_report로_나간다(setup):
    # 리뷰 지적 — Critical 1: 승인 대기는 평문이 아니라 버튼을 달 수 있는 콜백으로 나간다
    q, _log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=True)
    asked: list[tuple[str, str, str]] = []
    w.d.approval_report = lambda job, order_no, stage, summary: asked.append(
        (order_no, stage, summary)
    )
    w.tick()
    assert len(asked) == 1
    order_no, stage, summary = asked[0]
    assert (order_no, stage) == ('A1', 'pay')
    assert '승인 요청' in summary
    # 평문 보고로 중복해서 나가지 않는다
    assert not any('승인 요청' in s for s in sent)


def test_approval_report가_없으면_평문_보고로_떨어진다(setup):
    q, _log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    make(gate=True).tick()
    assert any('승인 요청' in s for s in sent)


def test_결제_중_죽어도_재시작_뒤_결제를_다시_하지_않는다(tmp_path):
    # 리뷰 지적 — Critical 2: 폰 승인이 나간 뒤 프로세스가 죽어도 재결제 경로가 없어야 한다
    reg = Registry.load(DEFAULT_ROOT)
    path = tmp_path / 'jobs.sqlite'
    q = JobQueue(path)
    q.enqueue('A1', 'U1', {}, 'ts1')
    paid = {'n': 0}

    def dying_payer(_a):
        paid['n'] += 1
        raise KeyboardInterrupt('폰 승인 직후 프로세스 급사')

    log: list[str] = []
    w = Worker(
        WorkerDeps(
            queue=q, graph=None, version='vtest', report=lambda j, s: None, parse_order=order_of
        )
    )
    graph = build_supervisor(
        reg,
        agents(log) | {'payer': dying_payer},
        checkpointer=MemorySaver(),
        gate=False,
        on_stage_start=w.mark_stage,  # 결제 진입을 큐에 적는 배선
    )
    w.d.graph = graph
    with pytest.raises(KeyboardInterrupt):
        w.tick()

    restarted = JobQueue(path)  # 프로세스 재시작
    assert restarted.get('A1').state == 'needs_human'
    w2 = Worker(
        WorkerDeps(
            queue=restarted,
            graph=graph,
            version='vtest',
            report=lambda j, s: None,
            parse_order=order_of,
        )
    )
    assert w2.tick() is None  # 집을 게 없다 — payer 가 다시 불리지 않는다
    assert paid['n'] == 1


def test_실행마다_추적_이벤트를_남긴다(tmp_path):
    # 리뷰 지적 — I3: Observe 가 실행 경로에 배선돼 있어야 gate 의 observe 조건이 선다
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    q.enqueue('A1', 'U1', {}, 'ts1')
    events = EventLog(tmp_path / 'events.sqlite')
    graph = build_supervisor(reg, agents([]), checkpointer=MemorySaver(), gate=False)
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda j, s: None,
            parse_order=order_of,
            events=events,
            env='dev',
            prompt_commit='c0ffee',
        )
    )
    job = w.tick()
    rows = events.of_job(job.id)
    assert rows, '실행 경로에서 이벤트가 하나도 남지 않았다'
    assert _observe_ok(rows, version='vtest')


def test_이벤트_정리를_기동_시_1회와_주기마다_부른다(setup):
    # 리뷰 지적 — Minor: EventLog.prune() 을 아무도 부르지 않았다
    _q, _log, _sent, make = setup
    w = make(gate=False)
    calls = {'n': 0}

    def prune() -> int:
        calls['n'] += 1
        return 0

    w.d.prune = prune
    w.d.prune_interval_s = 0.0  # 매 주기 확인
    ticks = iter([False, False, True])
    w.run_forever(stop=lambda: next(ticks), interval_s=0)
    assert calls['n'] == 3  # 기동 1회 + 주기 2회


def test_이벤트_정리_주기가_안_됐으면_다시_부르지_않는다(setup):
    _q, _log, _sent, make = setup
    w = make(gate=False)
    calls = {'n': 0}
    w.d.prune = lambda: calls.__setitem__('n', calls['n'] + 1) or 0
    w.d.prune_interval_s = 3600.0
    ticks = iter([False, False, True])
    w.run_forever(stop=lambda: next(ticks), interval_s=0)
    assert calls['n'] == 1  # 기동 시 1회뿐


def test_이벤트_정리가_실패해도_고리는_계속_돈다(setup):
    _q, _log, _sent, make = setup
    w = make(gate=False)

    def boom() -> int:
        raise RuntimeError('디스크 오류')

    w.d.prune = boom
    ticks = iter([False, True])
    w.run_forever(stop=lambda: next(ticks), interval_s=0)  # 예외가 새지 않는다


def test_주문_조회가_실패하면_running으로_남기지_않고_사람에게_넘긴다(setup):
    q, _log, sent, make = setup
    q.enqueue('A1', 'U1', {}, 'ts1')
    w = make(gate=False)

    def bad_lookup(_job):
        raise ValueError('허용 목록 밖 도구: run_script (hong@example.com)')

    w.d.parse_order = bad_lookup  # type: ignore[method-assign]
    job = w.tick()

    assert job is not None
    assert job.state == 'needs_human'
    assert '주문 조회 실패' in (q.get('A1').error or '')
    assert all('hong@example.com' not in s for s in sent)


def test_같은_주문을_다시_접수하면_끝난_스레드를_지우고_새로_돈다(setup):
    q, _log, _sent, make = setup
    w = make(gate=False)
    wiped: list[str] = []
    w.d.reset_thread = wiped.append
    q.enqueue('A1', 'U1', {}, 'ts1')
    assert w.tick().state == 'done'
    # 끝난 주문을 다시 접수하면 같은 행(id) 이 되살아난다 — 스레드도 같다
    job, fresh = q.enqueue('A1', 'U1', {}, 'ts2')
    assert fresh and job.id == 1
    assert w.tick().state == 'done'
    assert wiped == ['job:1', 'job:1']


def test_승인_대기로_멈춘_스레드는_지우지_않는다(setup):
    q, _log, _sent, make = setup
    w = make(gate=True)
    wiped: list[str] = []
    w.d.reset_thread = wiped.append
    q.enqueue('A1', 'U1', {}, 'ts1')
    assert w.tick().state == 'needs_human'
    assert '승인 대기' in q.get('A1').step
    wiped.clear()
    w._reset_finished_thread(1)  # 다음 노드(승인 뒤 결제)가 남아 있다
    assert wiped == []


class _FakeTabs:
    """열린 탭 집합을 흉내 낸다. 작업 중 새 탭이 생겼다고 치고, 닫힌 것을 기록한다."""

    def __init__(self) -> None:
        self.open = {'t-samba'}
        self.closed: list[str] = []

    def snapshot(self):
        return frozenset(self.open)

    def close_new(self, before):
        new = [t for t in self.open if t not in before]
        self.closed.extend(new)
        self.open -= set(new)
        return len(new)


def test_작업이_끝나면_그_작업이_연_탭을_닫는다(setup):
    q, _log, _sent, make = setup
    w = make(gate=False)
    tabs = _FakeTabs()
    w.d.tabs = tabs
    orig = w.d.graph.invoke

    def invoke_and_open_tab(*a, **k):
        tabs.open.add('t-order')  # 구매 에이전트가 주문서 탭을 열었다
        return orig(*a, **k)

    w.d.graph.invoke = invoke_and_open_tab  # type: ignore[method-assign]
    q.enqueue('A1', 'U1', {}, 'ts1')
    assert w.tick().state == 'done'
    assert tabs.closed == ['t-order'] and 't-samba' in tabs.open


def test_승인_대기_중에는_탭을_닫지_않고_재개_뒤에_닫는다(setup):
    q, _log, _sent, make = setup
    w = make(gate=True)
    tabs = _FakeTabs()
    w.d.tabs = tabs
    orig = w.d.graph.invoke

    def invoke_and_open_tab(*a, **k):
        tabs.open.add('t-order')
        return orig(*a, **k)

    w.d.graph.invoke = invoke_and_open_tab  # type: ignore[method-assign]
    q.enqueue('A1', 'U1', {}, 'ts1')
    job = w.tick()
    assert '승인 대기' in (job.step or '') and tabs.closed == []
    done = w.resume('A1', True, 'U1', stage='pay')
    assert done is not None and done.state == 'done'
    assert tabs.closed == ['t-order']


def test_브릿지가_바쁘면_큐를_집지_않는다(setup):
    q, log, _sent, make = setup
    w = make(gate=False)
    ready = {'v': False}
    w.d.ready = lambda: ready['v']
    q.enqueue('A1', 'U1', {}, 'ts1')
    assert w.tick() is None and q.get('A1').state == 'queued' and log == []
    ready['v'] = True
    assert w.tick().state == 'done'


def test_소싱처가_범위_밖으로_바뀐_주문은_돌리지_않는다(tmp_path):
    """무신사로 접수됐다가 삼바웨이브에서 롯데온으로 바뀐 주문 — 시작 직전에 건너뛴다(실기 2026-09-25)."""
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    log: list[str] = []
    sent: list[str] = []
    graph = build_supervisor(reg, agents(log, None), checkpointer=MemorySaver(), gate=False)
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda job, line: sent.append(line),
            parse_order=lambda job: OrderRef(order_no=job.order_no, source='LOTTEON', seller='포이즌', sku='티셔츠', qty=1),
            sources=frozenset({'MUSINSA', '29CM'}),
        )
    )
    q.enqueue('L1', 'U1', {}, 'ts1')
    job = w.tick()
    assert job.state == 'needs_human'
    assert log == []
    assert '범위 밖' in (job.error or '')


def test_마진_미달로_멈춰도_가격X_표시를_부르지_않는다(setup):
    """마진 미달은 쿠폰·적립 빠진 견적일 수 있다 — 자동 가격X·취소요청 금지(실기 2026-09-28)."""
    q, log, sent, _make = setup
    reg = Registry.load(DEFAULT_ROOT)
    marked: list[tuple[str, str | None]] = []
    graph = build_supervisor(reg, agents(log, None), checkpointer=MemorySaver(), gate=False)
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda job, line: sent.append(line),
            parse_order=order_of,
            dry_run=False,
            flag_order=lambda no, err: marked.append((no, err)) or '가격X 표시함',
        )
    )
    job, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    w._apply(job, {'outcome': 'needs_human', 'fail_reason': 'margin'})
    assert marked == []
    assert any('가격X 보류' in s for s in sent)


@pytest.mark.parametrize(
    ('reason', 'flagged'),
    [
        ('확정 품절: buyer01 — buyer01: 주문 옵션 품절 표시 [...]', False),
        ('판매 종료 및 중지된 상품', False),
        ("모든 계정에서 살 수 없다(품절·실패): a — a: 옵션 불일치 ['65838704']", False),
        ('모든 계정에서 살 수 없다(품절·실패): a — a: 원가 못 읽음(None)', False),
    ],
)
def test_품절_실패는_자동으로_재고X_를_붙이지_않는다(setup, reason, flagged):
    """품절로 보여도 워커가 재고X·취소요청을 자동으로 찍지 않는다 — 검수자가 페이지 근거를 보고 적는다(2026-09-28)."""
    q, log, sent, _make = setup
    reg = Registry.load(DEFAULT_ROOT)
    marked: list[tuple[str, str | None]] = []
    graph = build_supervisor(reg, agents(log, None), checkpointer=MemorySaver(), gate=False)
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda job, line: sent.append(line),
            parse_order=order_of,
            dry_run=False,
            flag_order=lambda no, err: marked.append((no, err)) or '재고X 표시함',
        )
    )
    job, _ = q.enqueue('S1', 'U1', {}, 'ts1')
    result = AgentResult(status='fail', reason=reason, fail_reason=FailReason.OUT_OF_STOCK)
    w._apply(job, {'outcome': 'needs_human', 'fail_reason': 'out_of_stock', 'results': {'buyer.musinsa': result}})
    assert (marked == [('S1', 'out_of_stock')]) is flagged
    if not flagged:
        assert any('재고X 보류' in s for s in sent)


def _auto_worker(setup, marked):
    q, log, sent, _make = setup
    reg = Registry.load(DEFAULT_ROOT)
    graph = build_supervisor(reg, agents(log, None), checkpointer=MemorySaver(), gate=False)
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda job, line: sent.append(line),
            parse_order=order_of,
            dry_run=False,
            flag_order=lambda no, err, ev=None: marked.append((no, err, ev)) or '표시함',
        )
    )
    return q, sent, w


def _ref(seller: str) -> OrderRef:
    return OrderRef(
        order_no='X1', source='MUSINSA', seller=seller, sku='상품', revenue=43600,
        product_url='https://www.musinsa.com/products/1',
    )


def test_확정_품절은_근거를_적고_자동으로_취소중(setup):
    """사용자 2026-09-29: 페이지에서 확인한 품절은 사람 검수 없이 취소중 — 근거(사유 글자)를 메모에 싣는다."""
    marked: list = []
    q, sent, w = _auto_worker(setup, marked)
    job, _ = q.enqueue('X1', 'U1', {}, 'ts1')
    result = AgentResult(
        status='fail', reason='확정 품절: a — a: 주문 옵션 품절 표시 [95 품절]', fail_reason=FailReason.OUT_OF_STOCK
    )
    w._apply(
        job,
        {'outcome': 'needs_human', 'fail_reason': 'out_of_stock', 'order': _ref('KT알파쇼핑'), 'results': {'buyer.musinsa': result}},
    )
    assert len(marked) == 1 and marked[0][1] == 'out_of_stock'
    assert '품절 확인' in marked[0][2] and '95 품절' in marked[0][2]
    assert any('자동 취소중' in s for s in sent)


def test_포이즌_품절도_자동으로_취소중(setup):
    """패널티 금액 확인은 보류 — 포이즌도 근거가 있으면 바로 취소중(사용자 2026-09-30)."""
    marked: list = []
    q, sent, w = _auto_worker(setup, marked)
    job, _ = q.enqueue('X1', 'U1', {}, 'ts1')
    result = AgentResult(status='fail', reason='확정 품절: a — a: 품절', fail_reason=FailReason.OUT_OF_STOCK)
    w._apply(
        job,
        {'outcome': 'needs_human', 'fail_reason': 'out_of_stock', 'order': _ref('poison(x)'), 'results': {'buyer.musinsa': result}},
    )
    assert len(marked) == 1
    assert any('자동 취소중' in s for s in sent)


def test_마진_미달은_주문서_원가가_있으면_자동으로_취소중(setup):
    marked: list = []
    q, sent, w = _auto_worker(setup, marked)
    job, _ = q.enqueue('X1', 'U1', {}, 'ts1')
    buy = AgentResult(status='ok', reason='ok', payload={'cost': 48480, 'margin_pct': -9.0, 'account': 'buyer01', 'card': '무신사페이'})
    w._apply(
        job,
        {'outcome': 'needs_human', 'fail_reason': 'margin', 'order': _ref('KT알파쇼핑'), 'results': {'buyer.musinsa': buy}},
    )
    assert len(marked) == 1 and marked[0][1] == 'margin'
    assert '48,480' in marked[0][2] and '43,600' in marked[0][2]


@pytest.mark.parametrize(
    ('export_status', 'expect_alert'),
    [
        ('conflict', True),
        ('error', True),
        ('done', False),
        ('pending', False),
        ('skipped', False),
    ],
)
def test_외부_기입_conflict_error는_보고에_남는다(setup, export_status, expect_alert):
    # 리뷰 지적 — I1: conflict·error 는 report 만으로 완료 문구에 묻혀 운영자에게 안 보였다
    q, _log, sent, _make = setup
    reg = Registry.load(DEFAULT_ROOT)
    graph = build_supervisor(reg, agents([], None), checkpointer=MemorySaver(), gate=False)
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda job, line: sent.append(line),
            parse_order=order_of,
        )
    )
    job, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    exporter_result = AgentResult(
        status='ok', reason=f'외부 기입 {export_status} 사유', payload={'export': export_status}
    )
    w._apply(job, {'outcome': 'done', 'results': {'exporter': exporter_result}})
    alerts = [s for s in sent if '외부 기입' in s and export_status in s]
    assert (len(alerts) == 1) is expect_alert


def test_검증_전_결제수단은_자동_승인하지_않는다(tmp_path):
    """페이코처럼 실결제 검증 전 수단이 뽑히면 사람 승인을 기다린다(2026-09-25)."""
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    log: list[str] = []
    sent: list[str] = []
    graph = build_supervisor(reg, agents(log, None), checkpointer=MemorySaver(), gate=True)
    w = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda job, line: sent.append(line),
            parse_order=order_of,
            auto_approve=True,
            manual_approve_methods=('현대',),
        )
    )
    q.enqueue('A1', 'U1', {}, 'ts1')
    job = w.tick()
    assert job.state == 'needs_human'
    assert 'pay' not in log
    assert any('수동 승인 필요' in s for s in sent)
