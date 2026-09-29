# 외부 기입 큐 — 중복 방지 · 상태 전이 · 재시도 예약 · 작업자 생존 표시
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportConflict, ExportQueue


class Clock:
    """시험용 시계 — 마음대로 앞으로 돌린다."""

    def __init__(self) -> None:
        self.now = datetime(2026, 9, 28, 12, 0, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def forward(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture()
def clock() -> Clock:
    return Clock()


@pytest.fixture()
def queue(tmp_path: Path, clock: Clock) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite', clock=clock)


def test_새_요청은_pending_으로_들어간다(queue):
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    assert (req.order_no, req.target, req.cost, req.shipping_fee) == ('A1', 'emp', 62470, 2300)
    assert req.status == 'pending'
    assert req.attempts == 0
    assert req.notified is False


def test_같은_요청은_새_행을_만들지_않는다(queue):
    first = queue.enqueue('A1', 'emp', 62470, 2300)
    second = queue.enqueue('A1', 'emp', 62470, 2300)
    assert second.id == first.id
    assert len(queue.recent()) == 1


def test_대상이_다르면_다른_요청이다(queue):
    a = queue.enqueue('A1', 'emp', 62470, 2300)
    b = queue.enqueue('A1', 'shopmine', 62470, 2300)
    assert a.id != b.id


def test_done_인_요청과_값이_다른_재요청은_거절한다(queue):
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.done(req.id, '기입 완료')
    with pytest.raises(ExportConflict):
        queue.enqueue('A1', 'emp', 70000, 2300)
    assert queue.get(req.id).cost == 62470


def test_running_중에는_값을_바꿀_수_없다(queue):
    queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    with pytest.raises(ExportConflict):
        queue.enqueue('A1', 'emp', 70000, 2300)


def test_실패한_요청은_새_값으로_다시_넣을_수_있다(queue):
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    queue.mark_notified(req.id)
    again = queue.enqueue('A1', 'emp', 70000, 2300)
    assert again.id == req.id
    assert again.status == 'pending'
    assert again.cost == 70000
    assert again.attempts == 0
    assert again.fail_reason is None
    assert again.notified is False


def test_claim_은_오래된_것부터_running_으로_바꾼다(queue, clock):
    first = queue.enqueue('A1', 'emp', 1000, 0)
    clock.forward(1)
    queue.enqueue('A2', 'emp', 2000, 0)
    got = queue.claim_next(['emp'])
    assert got is not None
    assert got.id == first.id
    assert got.status == 'running'
    assert got.attempts == 1


def test_claim_은_맡은_대상만_집는다(queue):
    queue.enqueue('A1', 'shopmine', 1000, 0)
    assert queue.claim_next(['emp']) is None
    assert queue.claim_next([]) is None
    assert queue.claim_next(['shopmine']) is not None


def test_재시도_예약은_시간이_지나야_다시_집힌다(queue, clock):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    queue.claim_next(['emp'])
    queue.retry_later(req.id, ExportFail.BUSY, '창 사용 중', delay_s=60)
    assert queue.get(req.id).status == 'pending'
    assert queue.get(req.id).fail_reason == 'busy'
    assert queue.claim_next(['emp']) is None
    clock.forward(61)
    got = queue.claim_next(['emp'])
    assert got is not None
    assert got.attempts == 2


def test_done_과_fail_은_결과를_남긴다(queue):
    a = queue.enqueue('A1', 'emp', 1000, 0)
    b = queue.enqueue('A2', 'emp', 2000, 0)
    queue.claim_next(['emp'])
    queue.done(a.id, '기입 완료')
    queue.claim_next(['emp'])
    queue.fail(b.id, ExportFail.VERIFY_MISMATCH, '되읽기 불일치')
    assert queue.get(a.id).status == 'done'
    assert queue.get(a.id).detail == '기입 완료'
    assert queue.get(a.id).fail_reason is None
    assert queue.get(b.id).status == 'failed'
    assert queue.get(b.id).fail_reason == 'verify_mismatch'


def test_죽은_작업자가_남긴_running_은_되돌린다(queue):
    a = queue.enqueue('A1', 'emp', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    queue.claim_next(['emp'])
    queue.claim_next(['shopmine'])
    assert queue.recover_running(['emp']) == 1
    assert queue.get(a.id).status == 'pending'
    assert queue.get(b.id).status == 'running'


def test_requeue_는_실패한_요청만_되살린다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    assert queue.requeue('A1', 'emp') is None  # pending 은 건드리지 않는다
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    again = queue.requeue('A1', 'emp')
    assert again is not None
    assert again.status == 'pending'
    assert again.attempts == 0
    assert queue.requeue('A9', 'emp') is None


def test_wait_는_끝난_요청을_바로_돌려준다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    queue.claim_next(['emp'])
    queue.done(req.id, '기입 완료')
    slept: list[float] = []
    out = queue.wait(req.id, 10, sleep=slept.append)
    assert out.status == 'done'
    assert slept == []


def test_wait_는_기다리는_동안_끝나면_결과를_돌려준다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)

    def sleep(_s: float) -> None:
        queue.claim_next(['emp'])
        queue.done(req.id, '기입 완료')

    ticks = iter([0.0, 0.0, 1.0, 2.0])
    out = queue.wait(req.id, 10, sleep=sleep, monotonic=lambda: next(ticks))
    assert out.status == 'done'


def test_wait_는_시간이_지나면_pending_그대로_돌려준다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    ticks = iter([0.0, 5.0, 11.0])
    slept: list[float] = []
    out = queue.wait(req.id, 10, sleep=slept.append, monotonic=lambda: next(ticks))
    assert out.status == 'pending'
    assert slept == [1.0]


def test_wait_시간이_0_이면_한_번만_본다(queue):
    req = queue.enqueue('A1', 'emp', 1000, 0)
    slept: list[float] = []
    out = queue.wait(req.id, 0, sleep=slept.append)
    assert out.status == 'pending'
    assert slept == []


def test_알림_대상은_알리지_않은_실패뿐이다(queue):
    a = queue.enqueue('A1', 'emp', 1000, 0)
    b = queue.enqueue('A2', 'emp', 2000, 0)
    queue.enqueue('A3', 'emp', 3000, 0)
    queue.claim_next(['emp'])
    queue.fail(a.id, ExportFail.NOT_FOUND, '주문 없음')
    queue.claim_next(['emp'])
    queue.done(b.id, '기입 완료')
    assert [r.id for r in queue.unnotified_failed()] == [a.id]
    queue.mark_notified(a.id)
    assert queue.unnotified_failed() == []


def test_더_먼저_온_대기_요청이_있으면_has_older_pending(queue):
    # 리뷰 지적 — I4 (b): alive() 만 보면 대기열이 밀려 있어도 export 단계가 기다린다
    first = queue.enqueue('A1', 'emp', 1000, 0)
    second = queue.enqueue('A2', 'emp', 2000, 0)
    assert queue.has_older_pending('emp', second.id) is True  # A1 이 먼저 있다
    assert queue.has_older_pending('emp', first.id) is False  # A1 앞에는 아무도 없다


def test_다른_대상의_대기는_안_본다(queue):
    queue.enqueue('A1', 'shopmine', 1000, 0)
    later = queue.enqueue('A2', 'emp', 2000, 0)
    assert queue.has_older_pending('emp', later.id) is False


def test_running_이나_done_은_older_pending에_안_들어간다(queue):
    first = queue.enqueue('A1', 'emp', 1000, 0)
    queue.claim_next(['emp'])  # A1 은 이제 running
    second = queue.enqueue('A2', 'emp', 2000, 0)
    assert queue.has_older_pending('emp', second.id) is False
    queue.done(first.id, '기입 완료')
    assert queue.has_older_pending('emp', second.id) is False


def test_작업자_생존_표시는_시간이_지나면_꺼진다(queue, clock):
    assert queue.alive('emp') is False
    queue.beat(['emp'])
    assert queue.alive('emp') is True
    assert queue.alive('shopmine') is False
    clock.forward(31)
    assert queue.alive('emp') is False


def test_두_연결이_같은_파일을_본다(tmp_path: Path, clock):
    path = tmp_path / 'exports.sqlite'
    harness = ExportQueue(path, clock=clock)
    worker = ExportQueue(path, clock=clock)
    req = harness.enqueue('A1', 'emp', 1000, 0)
    got = worker.claim_next(['emp'])
    assert got is not None
    worker.done(got.id, '기입 완료')
    assert harness.get(req.id).status == 'done'


def test_없는_요청을_찾으면_KeyError(queue):
    with pytest.raises(KeyError):
        queue.get(999)
    assert queue.find('A1', 'emp') is None


def test_ROLLBACK_자체가_실패해도_원래_COMMIT_오류가_전파된다(queue):
    """리뷰 지적 — M3: ROLLBACK 예외가 원래 COMMIT 오류를 가리지 않고, 큐는 계속 쓸 수 있다."""

    class DbWrapper:
        def __init__(self, db):
            self._db = db
            self._fail_commit_once = True
            self._fail_rollback_once = True

        def __getattr__(self, name):
            return getattr(self._db, name)

        def execute(self, sql, params=()):
            if self._fail_commit_once and sql == 'COMMIT':
                self._fail_commit_once = False
                raise sqlite3.OperationalError('simulated commit failure')
            if self._fail_rollback_once and sql == 'ROLLBACK':
                self._fail_rollback_once = False
                # 실제 되돌리기는 되지만(연결은 살아 있다), 드라이버가 오류를 보고하는 경우를 흉내낸다
                self._db.execute(sql, params)
                raise sqlite3.OperationalError('simulated rollback failure')
            return self._db.execute(sql, params)

    original_db = queue._db
    queue._db = DbWrapper(original_db)
    try:
        with pytest.raises(sqlite3.OperationalError, match='simulated commit failure'):
            queue.enqueue('A1', 'emp', 1000, 0)
    finally:
        queue._db = original_db
    req = queue.enqueue('A1', 'emp', 1000, 0)
    assert req.status == 'pending'


def test_COMMIT_실패_때도_롤백_해_연결을_산다(queue):
    """COMMIT이 실패해도 ROLLBACK이 실행되므로 다음 트랜잭션이 가능하다."""

    class DbWrapper:
        """sqlite3.Connection을 감싸서 COMMIT을 조작한다."""

        def __init__(self, db, fail_commit_once=True):
            self._db = db
            self._fail_commit_once = fail_commit_once

        def __getattr__(self, name):
            return getattr(self._db, name)

        def execute(self, sql, params=()):
            if self._fail_commit_once and sql == 'COMMIT':
                self._fail_commit_once = False
                raise sqlite3.OperationalError('simulated commit failure')
            return self._db.execute(sql, params)

    original_db = queue._db
    queue._db = DbWrapper(original_db)
    try:
        with pytest.raises(sqlite3.OperationalError, match='simulated commit failure'):
            queue.enqueue('A1', 'emp', 1000, 0)
    finally:
        queue._db = original_db
    # 트랜잭션이 제대로 롤백되었다면 다음 enqueue가 성공해야 한다
    req = queue.enqueue('A1', 'emp', 1000, 0)
    assert req.status == 'pending'


def test_done_orders_는_그_대상의_대기_요청_중_목록에_있는_것만_끝낸다(queue):
    a = queue.enqueue('A1', 'shopmine', 1000, 0)
    b = queue.enqueue('A2', 'shopmine', 2000, 0)
    c = queue.enqueue('A3', 'shopmine', 3000, 0)
    d = queue.enqueue('A2', 'emp', 4000, 0)
    claimed = queue.claim_next(['shopmine'])  # a 가 running
    assert claimed is not None and claimed.id == a.id
    assert queue.pending_order_nos('shopmine') == ['A2', 'A3']
    n = queue.done_orders('shopmine', ['A1', 'A2'], '일괄 완료됨 2건', except_id=a.id)
    assert n == 1
    assert queue.get(a.id).status == 'running'  # 집은 행은 호출부가 따로 끝낸다
    assert queue.get(b.id).status == 'done'
    assert queue.get(b.id).detail == '일괄 완료됨 2건'
    assert queue.get(c.id).status == 'pending'
    assert queue.get(d.id).status == 'pending'


def test_done_orders_는_빈_목록이면_0(queue):
    req = queue.enqueue('A1', 'shopmine', 1000, 0)
    queue.claim_next(['shopmine'])
    assert queue.done_orders('shopmine', [], '일괄', except_id=req.id) == 0
    assert queue.pending_order_nos('shopmine') == []


def test_메모를_함께_넣고_나중에_메모만_바꿀_수_있다(tmp_path):
    q = ExportQueue(tmp_path / 'm.sqlite')
    r = q.enqueue('A1', 'shopmine', 100, 0, '[도착예정] 10/05(일)')
    assert r.memo == '[도착예정] 10/05(일)'
    r2 = q.enqueue('A1', 'shopmine', 100, 0, '[도착예정] 10/06(월)')
    assert r2.id == r.id and r2.memo == '[도착예정] 10/06(월)' and r2.status == 'pending'
    assert q.enqueue('B1', 'emp', 1, 0).memo == ''


def test_memo_칸이_없던_옛_파일도_연다(tmp_path):
    import sqlite3

    path = tmp_path / 'old.sqlite'
    db = sqlite3.connect(path)
    db.executescript(
        'CREATE TABLE export_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT NOT NULL, '
        'target TEXT NOT NULL, cost INTEGER NOT NULL, shipping_fee INTEGER NOT NULL, '
        "status TEXT NOT NULL DEFAULT 'pending', fail_reason TEXT, detail TEXT, "
        'attempts INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, '
        'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(order_no, target));'
    )
    db.close()
    q = ExportQueue(path)
    assert q.enqueue('A1', 'shopmine', 1, 0, '메모').memo == '메모'
