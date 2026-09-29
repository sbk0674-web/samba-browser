"""외부 기입 요청 큐 — SQLite. 하네스(일반 권한)와 입력 작업자(관리자 권한)의 유일한 접점이다.

두 프로세스가 같은 파일을 연다 — WAL + busy_timeout + BEGIN IMMEDIATE 로 겹침을 막는다.
개인정보는 담지 않는다(주문번호·금액·상태뿐).
"""

import contextlib
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from samba_agent.export.failures import ExportFail

ExportStatus = Literal['pending', 'running', 'done', 'failed']
# 더 바뀌지 않는 상태
TERMINAL: tuple[ExportStatus, ...] = ('done', 'failed')

_SCHEMA = """
CREATE TABLE IF NOT EXISTS export_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL,
  target TEXT NOT NULL,
  cost INTEGER NOT NULL,
  shipping_fee INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  memo TEXT NOT NULL DEFAULT '',
  fail_reason TEXT,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_no, target)
);
CREATE INDEX IF NOT EXISTS export_requests_status ON export_requests(status, next_at);
CREATE TABLE IF NOT EXISTS export_heartbeat (
  target TEXT PRIMARY KEY,
  beat_at TEXT NOT NULL
);
"""


class ExportConflict(Exception):
    """이미 기입했거나 기입 중인 요청과 값이 다르다 — 덮어쓰기는 사람이 한다."""


@dataclass(frozen=True)
class ExportRequest:
    """큐의 한 행."""

    id: int
    order_no: str
    target: str
    cost: int
    shipping_fee: int
    status: ExportStatus
    fail_reason: str | None
    detail: str | None
    attempts: int
    notified: bool
    next_at: str
    created_at: str
    updated_at: str
    # 샵마인 추가메모에 넣을 글(도착예정 등, 2026-09-30). 없으면 빈 문자열
    memo: str = ''


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _to_request(row: sqlite3.Row) -> ExportRequest:
    return ExportRequest(
        id=row['id'],
        order_no=row['order_no'],
        target=row['target'],
        cost=row['cost'],
        shipping_fee=row['shipping_fee'],
        status=row['status'],
        fail_reason=row['fail_reason'],
        detail=row['detail'],
        attempts=row['attempts'],
        notified=bool(row['notified']),
        next_at=row['next_at'],
        created_at=row['created_at'],
        updated_at=row['updated_at'],
        memo=row['memo'] or '',
    )


class ExportQueue:
    """외부 기입 큐. 하네스와 입력 작업자가 각자 연결을 하나씩 연다."""

    def __init__(self, path: Path, clock: Callable[[], datetime] | None = None) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._clock = clock or _utc_now
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # 다른 프로세스가 쓰는 중이면 즉시 실패하지 않고 기다린다
        self._db.execute('PRAGMA busy_timeout=5000')
        # 읽는 쪽(하네스 대기)과 쓰는 쪽(작업자)이 서로 막지 않게 한다
        self._db.execute('PRAGMA journal_mode=WAL')
        self._db.executescript(_SCHEMA)
        # 예전 파일에는 memo 칸이 없다 — 붙인다(2026-09-30)
        cols = {r[1] for r in self._db.execute('PRAGMA table_info(export_requests)')}
        if 'memo' not in cols:
            self._db.execute("ALTER TABLE export_requests ADD COLUMN memo TEXT NOT NULL DEFAULT ''")
        # 한 연결을 여러 스레드가 쓴다(그래프 노드·알림 고리) — BEGIN~COMMIT 구간을 직렬화한다
        self._lock = threading.Lock()

    def _iso(self, offset_s: float = 0) -> str:
        return (self._clock() + timedelta(seconds=offset_s)).isoformat(timespec='seconds')

    @contextlib.contextmanager
    def _immediate(self) -> Iterator[None]:
        """조회 → 쓰기를 한 트랜잭션으로 묶는다. 예외가 나면 되돌린다.

        ROLLBACK 자체가 실패해도(예: 그 사이 연결이 끊김) 원래 예외를 가리지 않는다 —
        되돌리기 실패는 부수적인 정보라 로그로만 남긴다(리뷰 지적 — M3).
        """
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                yield
                self._db.execute('COMMIT')
            except BaseException:
                with contextlib.suppress(sqlite3.Error):
                    self._db.execute('ROLLBACK')
                raise

    def _row(self, request_id: int) -> sqlite3.Row | None:
        return self._db.execute(
            'SELECT * FROM export_requests WHERE id=?', (request_id,)
        ).fetchone()

    def enqueue(
        self, order_no: str, target: str, cost: int, shipping_fee: int, memo: str = ''
    ) -> ExportRequest:
        """요청을 넣는다. 같은 (주문번호, 대상) 이 있으면 새 행을 만들지 않는다.

        값이 같으면 기존 행을 그대로 돌려준다. 값이 다르면 — 이미 기입했거나(done) 기입 중(running)
        이면 거절하고, 아직 안 했거나 실패한 요청이면 새 값으로 바꿔 다시 대기시킨다.
        실패한(failed) 요청을 같은 값으로 다시 요청하면 새로 바꿀 것도 없이 그 행을 그대로
        돌려준다 — 다시 대기시키려면(requeue) ``requeue()`` 를 따로 부른다.
        """
        now = self._iso()
        with self._immediate():
            row = self._db.execute(
                'SELECT * FROM export_requests WHERE order_no=? AND target=?',
                (order_no, target),
            ).fetchone()
            if row is None:
                cur = self._db.execute(
                    'INSERT INTO export_requests '
                    '(order_no, target, cost, shipping_fee, memo, next_at, created_at, updated_at) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    (order_no, target, cost, shipping_fee, memo, now, now, now),
                )
                row = self._row(int(cur.lastrowid or 0))
            elif (row['cost'], row['shipping_fee']) != (cost, shipping_fee):
                if row['status'] in ('done', 'running'):
                    raise ExportConflict(
                        f'{order_no}({target}) 는 이미 {row["status"]} 다 — '
                        f'기존 {row["cost"]}/{row["shipping_fee"]}, 요청 {cost}/{shipping_fee}'
                    )
                self._db.execute(
                    "UPDATE export_requests SET cost=?, shipping_fee=?, status='pending', "
                    'fail_reason=NULL, detail=NULL, attempts=0, notified=0, next_at=?, '
                    'updated_at=? WHERE id=?',
                    (cost, shipping_fee, now, now, row['id']),
                )
                row = self._row(row['id'])
            if memo and row is not None and row['memo'] != memo and row['status'] != 'done':
                # 메모만 새로 왔다 — 값·상태는 그대로 두고 메모만 바꾼다
                self._db.execute(
                    'UPDATE export_requests SET memo=?, updated_at=? WHERE id=?',
                    (memo, now, row['id']),
                )
                row = self._row(row['id'])
        assert row is not None
        return _to_request(row)

    def get(self, request_id: int) -> ExportRequest:
        with self._lock:
            row = self._row(request_id)
        if row is None:
            raise KeyError(request_id)
        return _to_request(row)

    def find(self, order_no: str, target: str) -> ExportRequest | None:
        with self._lock:
            row = self._db.execute(
                'SELECT * FROM export_requests WHERE order_no=? AND target=?',
                (order_no, target),
            ).fetchone()
        return _to_request(row) if row is not None else None

    def claim_next(self, targets: Sequence[str]) -> ExportRequest | None:
        """맡은 대상의 대기 요청 중 가장 오래된 것을 running 으로 바꿔 돌려준다."""
        if not targets:
            return None
        now = self._iso()
        marks = ','.join('?' for _ in targets)
        with self._immediate():
            row = self._db.execute(
                f"SELECT * FROM export_requests WHERE status='pending' AND next_at<=? "
                f'AND target IN ({marks}) ORDER BY created_at, id LIMIT 1',
                (now, *targets),
            ).fetchone()
            if row is None:
                return None
            self._db.execute(
                "UPDATE export_requests SET status='running', attempts=attempts+1, updated_at=? "
                'WHERE id=?',
                (now, row['id']),
            )
            row = self._row(row['id'])
        assert row is not None
        return _to_request(row)

    def done(self, request_id: int, detail: str) -> None:
        with self._immediate():
            self._db.execute(
                "UPDATE export_requests SET status='done', fail_reason=NULL, detail=?, "
                'updated_at=? WHERE id=?',
                (detail, self._iso(), request_id),
            )

    def pending_order_nos(self, target: str) -> list[str]:
        """그 대상의 대기(pending) 요청 주문번호(오래된 순) — 일괄형 어댑터에 한꺼번에 넘긴다."""
        with self._lock:
            rows = self._db.execute(
                "SELECT order_no FROM export_requests WHERE target=? AND status='pending' "
                'ORDER BY created_at, id',
                (target,),
            ).fetchall()
        return [r['order_no'] for r in rows]

    def done_orders(
        self, target: str, order_nos: Sequence[str], detail: str, *, except_id: int
    ) -> int:
        """그 대상의 대기(pending) 요청 중 주문번호가 목록에 있는 것을 성공으로 끝낸다.

        일괄형 어댑터가 한 번에 처리한 주문들이다. except_id(집어서 running 인 행)는 호출부가
        따로 끝낸다. 바꾼 행 수를 돌려준다.
        """
        if not order_nos:
            return 0
        marks = ','.join('?' for _ in order_nos)
        now = self._iso()
        with self._immediate():
            cur = self._db.execute(
                f"UPDATE export_requests SET status='done', fail_reason=NULL, detail=?, "
                f"updated_at=? WHERE target=? AND status='pending' AND id<>? "
                f'AND order_no IN ({marks})',
                (detail, now, target, except_id, *order_nos),
            )
        return int(cur.rowcount)

    def fail(self, request_id: int, reason: ExportFail, detail: str) -> None:
        with self._immediate():
            self._db.execute(
                "UPDATE export_requests SET status='failed', fail_reason=?, detail=?, "
                'updated_at=? WHERE id=?',
                (reason.value, detail, self._iso(), request_id),
            )

    def retry_later(
        self,
        request_id: int,
        reason: ExportFail,
        detail: str,
        delay_s: float,
        *,
        count_attempt: bool = True,
    ) -> None:
        """다시 대기시킨다. delay_s 가 지나야 다시 집힌다.

        count_attempt 가 거짓이면 이번 시도를 횟수에서 뺀다(사람이 돌아와 멈춘 것은 실패가 아니다).
        """
        back = 0 if count_attempt else 1
        with self._immediate():
            self._db.execute(
                "UPDATE export_requests SET status='pending', fail_reason=?, detail=?, "
                'attempts=MAX(attempts-?, 0), next_at=?, updated_at=? WHERE id=?',
                (reason.value, detail, back, self._iso(delay_s), self._iso(), request_id),
            )

    def recover_running(self, targets: Sequence[str]) -> int:
        """작업자가 도중에 죽어 남은 running 을 되돌린다.

        다시 돌려도 안전하다 — 작업자는 입력 전에 먼저 읽고, 값이 이미 같으면 입력하지 않는다.
        """
        if not targets:
            return 0
        marks = ','.join('?' for _ in targets)
        now = self._iso()
        with self._immediate():
            cur = self._db.execute(
                f"UPDATE export_requests SET status='pending', next_at=?, updated_at=? "
                f"WHERE status='running' AND target IN ({marks})",
                (now, now, *targets),
            )
        return int(cur.rowcount)

    def requeue(self, order_no: str, target: str) -> ExportRequest | None:
        """실패한 요청을 같은 값으로 다시 대기시킨다(사람이 원인을 고친 뒤)."""
        now = self._iso()
        with self._immediate():
            row = self._db.execute(
                "SELECT * FROM export_requests WHERE order_no=? AND target=? AND status='failed'",
                (order_no, target),
            ).fetchone()
            if row is None:
                return None
            self._db.execute(
                "UPDATE export_requests SET status='pending', fail_reason=NULL, detail=NULL, "
                'attempts=0, notified=0, next_at=?, updated_at=? WHERE id=?',
                (now, now, row['id']),
            )
            row = self._row(row['id'])
        assert row is not None
        return _to_request(row)

    def wait(
        self,
        request_id: int,
        timeout_s: float,
        *,
        poll_s: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> ExportRequest:
        """요청이 끝나길 기다린다. 제한 시간이 지나면 그때 상태 그대로 돌려준다."""
        if timeout_s <= 0:
            return self.get(request_id)
        deadline = monotonic() + timeout_s
        while True:
            req = self.get(request_id)
            if req.status in TERMINAL or monotonic() >= deadline:
                return req
            sleep(poll_s)

    def unnotified_failed(self) -> list[ExportRequest]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM export_requests WHERE status='failed' AND notified=0 ORDER BY id"
            ).fetchall()
        return [_to_request(r) for r in rows]

    def unnotified_done(self, targets: Sequence[str], since: str) -> list[ExportRequest]:
        """그 대상들에서 since 뒤에 들어와 성공으로 끝났고 아직 알리지 않은 요청."""
        if not targets:
            return []
        marks = ','.join('?' for _ in targets)
        with self._lock:
            rows = self._db.execute(
                f"SELECT * FROM export_requests WHERE status='done' AND notified=0 "
                f'AND created_at>=? AND target IN ({marks}) ORDER BY id',
                (since, *targets),
            ).fetchall()
        return [_to_request(r) for r in rows]

    def mark_notified(self, request_id: int) -> None:
        with self._immediate():
            self._db.execute(
                'UPDATE export_requests SET notified=1, updated_at=? WHERE id=?',
                (self._iso(), request_id),
            )

    def recent(self, limit: int = 20) -> list[ExportRequest]:
        with self._lock:
            rows = self._db.execute(
                'SELECT * FROM export_requests ORDER BY updated_at DESC, id DESC LIMIT ?',
                (limit,),
            ).fetchall()
        return [_to_request(r) for r in rows]

    def beat(self, targets: Sequence[str]) -> None:
        """입력 작업자가 살아 있고 이 대상을 맡고 있다는 표시."""
        now = self._iso()
        with self._immediate():
            for target in targets:
                self._db.execute(
                    'INSERT INTO export_heartbeat (target, beat_at) VALUES (?, ?) '
                    'ON CONFLICT(target) DO UPDATE SET beat_at=excluded.beat_at',
                    (target, now),
                )

    def has_older_pending(self, target: str, before_id: int) -> bool:
        """이 대상에 ``before_id`` 보다 먼저 들어온 대기 요청이 있는가.

        있으면 이 요청은 한참 뒤에나 집힐 테니 export 단계가 기다려도 소용없다.
        한 번 시도하고 다시 대기 중인 요청(화면에 아직 없음 등)은 세지 않는다 — 그런 요청은
        정해진 시각까지 집히지 않아 이 요청을 막지 않는다
        (리뷰 지적 — I4 (b): alive() 만 보면 대기열이 밀려 있어도 주문마다 대기 시간을 다 쓴다).
        """
        with self._lock:
            row = self._db.execute(
                "SELECT 1 FROM export_requests WHERE target=? AND status='pending' "
                'AND attempts=0 AND id<? LIMIT 1',
                (target, before_id),
            ).fetchone()
        return row is not None

    def alive(self, target: str, within_s: float = 30.0) -> bool:
        """이 대상을 맡은 작업자가 최근에 표시를 남겼는가."""
        with self._lock:
            row = self._db.execute(
                'SELECT beat_at FROM export_heartbeat WHERE target=?', (target,)
            ).fetchone()
        if row is None:
            return False
        return row['beat_at'] >= self._iso(-within_s)
