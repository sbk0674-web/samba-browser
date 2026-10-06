# 주문 큐 — 접수 / 중복 거절·병합 / 한 번에 1건 / 재시도 상한 / 취소 / 재시작 복구
import threading

import pytest

from samba_agent.failures import FailReason
from samba_agent.queue.db import PAY_STARTED_STEP, JobQueue


@pytest.fixture()
def q(tmp_path):
    return JobQueue(tmp_path / 'jobs.sqlite')


def test_접수하면_queued_다(q):
    job, created = q.enqueue('734501000740906', 'U1', {'card': '현대'}, 'ts1')
    assert created is True
    assert job.state == 'queued'
    assert job.options == {'card': '현대'}
    assert job.attempts == 0


def test_같은_주문_재요청은_거절하고_기존_건을_준다(q):
    first, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    again, created = q.enqueue('A1', 'U2', {}, 'ts2')
    assert created is False
    assert again.id == first.id
    assert again.requester == 'U1'  # 처음 사람이 임자다
    assert len(q.live()) == 1


def test_처리중인_주문도_재요청은_거절한다(q):
    q.enqueue('A1', 'U1', {}, 'ts1')
    q.claim()
    _, created = q.enqueue('A1', 'U2', {}, 'ts2')
    assert created is False


def test_끝난_주문은_같은_행을_되살린다(q):
    job, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    q.claim()
    q.finish(job.id, 'failed', error='out_of_stock')
    again, created = q.enqueue('A1', 'U2', {}, 'ts9')
    assert created is True
    assert again.id == job.id
    assert again.state == 'queued'
    assert again.thread_ts == 'ts9'


def test_한_번에_한_건만_집는다(q):
    q.enqueue('A1', 'U1', {}, 'ts1')
    q.enqueue('A2', 'U1', {}, 'ts2')
    first = q.claim()
    assert first is not None and first.order_no == 'A1'
    assert q.claim() is None  # 손발이 하나라 동시에 못 돈다
    q.finish(first.id, 'done')
    second = q.claim()
    assert second is not None and second.order_no == 'A2'


def test_진행_상태를_기록한다(q):
    job, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    q.claim()
    q.progress(job.id, agent='buyer.musinsa', step='3/5 배송지')
    got = q.get('A1')
    assert got is not None
    assert (got.assignee_agent, got.step) == ('buyer.musinsa', '3/5 배송지')


def test_재시도는_상한을_넘지_못한다(q):
    job, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    q.claim()
    q.finish(job.id, 'needs_human', error='bridge_down')
    again = q.retry(job.id)
    assert (again.state, again.attempts) == ('queued', 1)
    q.claim()
    q.finish(job.id, 'needs_human', error='bridge_down')
    with pytest.raises(ValueError, match='재시도 상한'):
        q.retry(job.id)


def test_하네스_버전을_기록한다(q):
    job, _ = q.enqueue('A1', 'U1', {}, 'ts1')
    q.claim()
    q.set_version(job.id, 'v1.2.3')
    assert q.get('A1').harness_version == 'v1.2.3'


def test_취소는_살아_있는_건만(q):
    q.enqueue('A1', 'U1', {}, 'ts1')
    cancelled = q.cancel('A1')
    assert cancelled is not None and cancelled.state == 'cancelled'
    assert q.cancel('A1') is None
    assert q.cancel('없는주문') is None


def test_재시작하면_running_은_queued_로_돌아온다(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    q1 = JobQueue(path)
    job, _ = q1.enqueue('A1', 'U1', {}, 'ts1')
    q1.claim()
    assert q1.get('A1').state == 'running'
    q2 = JobQueue(path)  # 실행기 재시작 — 끊긴 running 을 되살린다
    got = q2.get('A1')
    assert got.state == 'queued'
    assert got.id == job.id


def test_같은_주문을_두_연결이_동시에_접수해도_행은_하나(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    # 각 스레드가 자기 연결을 쓴다 — 실제 여러 프로세스/스레드가 동시에
    # enqueue 를 부를 때와 같은 조건으로 BEGIN IMMEDIATE 경합을 검증한다
    q1 = JobQueue(path)
    q2 = JobQueue(path)
    errors: list[BaseException] = []
    results: list[bool] = []

    def _enqueue(q: JobQueue, requester: str, thread_ts: str) -> None:
        try:
            _, created = q.enqueue('DUP1', requester, {}, thread_ts)
            results.append(created)
        except BaseException as exc:  # noqa: BLE001 — 스레드 예외를 모아서 검사한다
            errors.append(exc)

    t1 = threading.Thread(target=_enqueue, args=(q1, 'U1', 'ts1'))
    t2 = threading.Thread(target=_enqueue, args=(q2, 'U2', 'ts2'))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert errors == []
    assert sorted(results) == [False, True]  # 한쪽만 새로 만들고 한쪽은 거절
    assert len(q1.live()) == 1


def test_결제_진행_중_재시작은_큐로_돌리지_않고_사람에게_넘긴다(tmp_path):
    # 리뷰 지적 — Critical 2: 결제 승인이 나간 뒤 죽으면 다시 돌려 재결제하면 안 된다
    path = tmp_path / 'jobs.sqlite'
    first = JobQueue(path)
    first.enqueue('A1', 'U1', {}, 'ts1')
    job = first.claim()
    first.progress(job.id, agent='payer', step=PAY_STARTED_STEP)

    restarted = JobQueue(path)  # 프로세스 재시작
    recovered = restarted.get('A1')
    assert recovered.state == 'needs_human'
    assert recovered.error == FailReason.PAY_INTERRUPTED.value
    assert restarted.claim() is None  # 실행기가 다시 집지 않는다


def test_결제_전_단계에서_죽었으면_다시_큐에_들어간다(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    first = JobQueue(path)
    first.enqueue('A1', 'U1', {}, 'ts1')
    job = first.claim()
    first.progress(job.id, agent='buyer.musinsa', step='옵션 선택')

    restarted = JobQueue(path)
    assert restarted.get('A1').state == 'queued'
    assert restarted.claim() is not None


def test_COMMIT_이_잠금에_막히면_되돌려_다음_트랜잭션이_열린다(tmp_path):
    import sqlite3

    from samba_agent.queue.db import JobQueue

    path = tmp_path / 'jobs.sqlite'
    q = JobQueue(path)
    q.enqueue('A1', 'u', {}, None)
    # 다른 연결이 읽기 잠금을 쥔 채 놓지 않는다(실기 2026-09-29: 조회 중 느린 HTTP 로 잠금이 길어졌다)
    reader = sqlite3.connect(path, isolation_level=None)
    reader.execute('BEGIN')
    reader.execute('SELECT * FROM jobs').fetchall()
    with pytest.raises(sqlite3.OperationalError):
        with q._lock:
            q._db.execute('BEGIN IMMEDIATE')
            q._db.execute("UPDATE jobs SET step='x'")
            q._commit(tries=2, wait_s=0)
    reader.execute('COMMIT')
    # 되돌렸으니 다음 집기가 된다
    assert q.claim() is not None


# ==================== 같은 상품주문번호 두 행(삼바웨이브 행 id) ====================


def test_같은_주문번호라도_행_id_가_다르면_따로_접수한다(q):
    """실기 20261005DFA7D9 — 230(ord_A)·210(ord_B). 예전엔 order_no UNIQUE 라 둘째 행이 영영 안 들어갔다."""
    a, created_a = q.enqueue('X', 'intake', {}, 'ts1', wave_id='ord_A')
    b, created_b = q.enqueue('X', 'intake', {}, 'ts2', wave_id='ord_B')
    assert created_a and created_b
    assert a.id != b.id
    assert (a.key, b.key) == ('ord_A', 'ord_B')
    assert len(q.live()) == 2
    # 행 id 로 각각 찾는다
    assert q.get('ord_A').id == a.id
    assert q.get('ord_B').id == b.id
    assert q.get_by_id(b.id).wave_id == 'ord_B'
    # 같은 행 재접수는 거절
    again, created = q.enqueue('X', 'U2', {}, 'ts3', wave_id='ord_A')
    assert created is False and again.id == a.id


def test_행_id_없는_옛_행은_done_이_아니면_같은_주문번호를_막는다(q):
    legacy, _ = q.enqueue('X', 'U1', {}, 'ts1')  # 슬랙 수동 접수 — wave_id 없음
    q.claim()
    q.finish(legacy.id, 'needs_human', error='margin')
    assert q.find('X', 'ord_A').id == legacy.id  # 사람이 정리하기 전까지 막는다
    q.finish(legacy.id, 'done')
    assert q.find('X', 'ord_A') is None  # 기입이 끝난 옛 행은 다른 행(다른 사이즈)을 막지 않는다
    assert q.find('X', 'ord_B') is None


def test_옛_행_재접수에_행_id_가_오면_그_행에_채운다(q):
    legacy, _ = q.enqueue('X', 'U1', {}, 'ts1')
    q.claim()
    q.finish(legacy.id, 'failed')
    again, created = q.enqueue('X', 'intake', {}, 'ts2', wave_id='ord_A')
    assert created is True and again.id == legacy.id
    assert again.wave_id == 'ord_A'
    # 이제 그 행 id 로 찾힌다
    assert q.find('X', 'ord_A').id == legacy.id


def test_주문번호_키는_살아_있는_행을_먼저_준다(q):
    a, _ = q.enqueue('X', 'intake', {}, 'ts1', wave_id='ord_A')
    q.claim()
    q.finish(a.id, 'done')
    b, _ = q.enqueue('X', 'intake', {}, 'ts2', wave_id='ord_B')
    assert q.get('X').id == b.id  # 살아 있는 쪽
    q.finish(b.id, 'done')
    assert q.get('X').id == b.id  # 둘 다 끝났으면 최근 것


def test_행_id_모양의_키는_wave_id_로도_쓴다(q):
    job, _ = q.enqueue('ord_A', 'U1', {}, 'ts1')  # 슬랙 `주문 처리 ord_A`
    assert (job.order_no, job.wave_id, job.key) == ('ord_A', 'ord_A', 'ord_A')


def test_주문번호로_취소하면_살아_있는_행_전부(q):
    a, _ = q.enqueue('X', 'intake', {}, 'ts1', wave_id='ord_A')
    b, _ = q.enqueue('X', 'intake', {}, 'ts2', wave_id='ord_B')
    q.cancel('X')
    assert q.get_by_id(a.id).state == 'cancelled'
    assert q.get_by_id(b.id).state == 'cancelled'
    c, _ = q.enqueue('X', 'intake', {}, 'ts3', wave_id='ord_C')
    q.cancel('ord_C')
    assert q.get_by_id(c.id).state == 'cancelled'


def test_승인_재개는_행_id_로_그_행만(q):
    a, _ = q.enqueue('X', 'intake', {}, 'ts1', wave_id='ord_A')
    b, _ = q.enqueue('X', 'intake', {}, 'ts2', wave_id='ord_B')
    for job in (a, b):
        q.progress(job.id, agent='approval.pay', step='승인 대기: pay')
        q.finish(job.id, 'needs_human')
    resumed = q.try_start_resume('ord_B', stage='pay')
    assert resumed is not None and resumed.id == b.id and resumed.state == 'running'
    assert q.get_by_id(a.id).state == 'needs_human'
    # 주문번호로 부르면 먼저 접수된 대기 행
    resumed = q.try_start_resume('X', stage='pay')
    assert resumed is not None and resumed.id == a.id


def test_옛_표_order_no_UNIQUE_는_행_id_표로_옮기고_행과_id_를_지킨다(tmp_path):
    """하네스 재시작 때 jobs.sqlite 가 옛 모양이면 새 표로 옮긴다 — id 가 바뀌면 체크포인트 스레드(job:<id>)가 끊긴다."""
    import sqlite3

    path = tmp_path / 'jobs.sqlite'
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_no TEXT NOT NULL UNIQUE,
          requester TEXT NOT NULL,
          options TEXT NOT NULL DEFAULT '{}',
          state TEXT NOT NULL DEFAULT 'queued',
          assignee_agent TEXT, step TEXT, thread_ts TEXT, harness_version TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
        INSERT INTO jobs(id, order_no, requester, options, state, step, thread_ts, attempts, created_at, updated_at)
          VALUES (7, 'X', 'intake', '{"card":"현대"}', 'done', NULL, 'ts7', 1, 't', 't');
        INSERT INTO jobs(id, order_no, requester, state, created_at, updated_at)
          VALUES (9, 'Y', 'U1', 'needs_human', 't', 't');
        """
    )
    db.commit()
    db.close()

    q = JobQueue(path)
    old = q.get_by_id(7)
    assert old is not None
    assert (old.order_no, old.wave_id, old.options, old.state, old.thread_ts, old.attempts) == (
        'X',
        None,
        {'card': '현대'},
        'done',
        'ts7',
        1,
    )
    assert q.get_by_id(9).state == 'needs_human'
    # 옮긴 뒤에는 같은 주문번호의 둘째 행이 들어간다(옛 행은 done)
    b, created = q.enqueue('X', 'intake', {}, 'ts2', wave_id='ord_B')
    assert created is True and b.id > 9
    # 다시 열어도 또 옮기지 않는다(멱등)
    q2 = JobQueue(path)
    assert q2.get_by_id(b.id).wave_id == 'ord_B'
    assert q2.find('X', 'ord_B').id == b.id
