"""주문 큐 — SQLite. 잠금은 order_no UNIQUE + BEGIN IMMEDIATE 트랜잭션으로 건다(스펙 §4.2).

손발(앱)이 하나라 실행은 한 번에 1건이다. 같은 주문 재요청은 새 행을 만들지 않고
기존 행을 돌려준다 — 봇이 "이미 ○○님이 처리 중" 이라고 답한다.
"""

import contextlib
import json
import sqlite3
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from samba_agent.failures import FailReason

JobState = Literal['queued', 'running', 'done', 'failed', 'needs_human', 'cancelled']
# 살아 있는 상태 — 이 중 하나면 같은 주문의 새 요청을 거절한다
LIVE_STATES: tuple[JobState, ...] = ('queued', 'running', 'needs_human')
# 최초 1회 + 재시도 1회(스펙 §4.3-4)
MAX_ATTEMPTS = 2
# 결제 노드에 들어갔다는 표시. 이 단계에서 죽은 행은 재시작해도 다시 돌리지 않는다
# (폰 승인이 이미 나갔을 수 있다 — 재결제 금지, 스펙 §6)
PAY_STARTED_STEP = '결제 진행 중'
# COMMIT 이 잠금에 막힐 때 다시 해 보는 횟수·간격
COMMIT_TRIES = 5
COMMIT_WAIT_S = 1.0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  requester TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'queued',
  assignee_agent TEXT,
  step TEXT,
  thread_ts TEXT,
  harness_version TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
"""


@dataclass(frozen=True)
class Job:
    """큐의 한 행."""

    id: int
    order_no: str
    requester: str
    options: dict[str, object]
    state: JobState
    assignee_agent: str | None
    step: str | None
    thread_ts: str | None
    harness_version: str | None
    attempts: int
    error: str | None
    created_at: str
    updated_at: str


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec='seconds')


class JobQueue:
    """주문 큐. 한 프로세스(실행기)만 쓴다."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # 여러 연결이 동시에 BEGIN IMMEDIATE 로 부딪히면 즉시 실패하지 않고
        # 앞선 트랜잭션이 끝날 때까지 기다린다
        self._db.execute('PRAGMA busy_timeout=5000')
        self._db.executescript(_SCHEMA)
        # 실행기가 도중에 죽었다면 running 인 행이 남는다. 결제 진행 중이던 행은
        # 다시 집으면 재결제가 되므로(리뷰 지적 — Critical 2) 사람에게 넘긴다.
        self._db.execute(
            "UPDATE jobs SET state='needs_human', error=?, updated_at=? "
            "WHERE state='running' AND step=?",
            (FailReason.PAY_INTERRUPTED.value, _now(), PAY_STARTED_STEP),
        )
        # 그 밖의 단계는 부수효과가 없으니 다시 집을 수 있게 되돌린다
        self._db.execute(
            "UPDATE jobs SET state='queued', updated_at=? WHERE state='running'", (_now(),)
        )
        # sqlite3 커넥션 하나를 여러 스레드가 공유한다(check_same_thread=False). BEGIN 과
        # COMMIT 이 서로 다른 execute() 호출이라, 락 없이는 스레드 A 의 BEGIN 과 B 의 BEGIN 이
        # 같은 커넥션 위에서 겹쳐 "cannot commit - no transaction is active" 로 깨진다
        # (스펙 리뷰 지적 — Important 3 를 스레드로 테스트하다 드러남). SQLite 자체 잠금은
        # 여러 커넥션 사이의 얘기라 이 경우엔 못 막아준다 — 파이썬 쪽에서 직접 막는다.
        self._lock = threading.Lock()

    @contextlib.contextmanager
    def _immediate(self) -> Iterator[None]:
        """SELECT → INSERT/UPDATE 를 진짜 한 트랜잭션으로 묶는다.

        ``isolation_level=None`` (오토커밋) 상태라 BEGIN 을 직접 열지 않으면
        조회와 쓰기 사이에 다른 연결이 끼어들 수 있다. BEGIN IMMEDIATE 로
        쓰기 잠금을 즉시 잡아 그 틈을 없앤다. 커넥션을 공유하는 스레드끼리는
        ``self._lock`` 으로 BEGIN~COMMIT/ROLLBACK 구간 자체를 직렬화한다.
        """
        with self._lock:
            self._db.execute('BEGIN IMMEDIATE')
            try:
                yield
            except BaseException:
                self._db.execute('ROLLBACK')
                raise
            else:
                self._commit()

    def _commit(self, tries: int = COMMIT_TRIES, wait_s: float = COMMIT_WAIT_S) -> None:
        """COMMIT — 다른 연결이 읽기 잠금을 오래 쥐면 'database is locked' 로 실패한다. 몇 번 더 해 보고,
        끝내 안 되면 되돌린다. 열린 채 두면 이 연결의 다음 BEGIN 이 전부 실패해 워커가 멈춘다(실기 2026-09-29)."""
        for i in range(tries):
            try:
                self._db.execute('COMMIT')
                return
            except sqlite3.OperationalError:
                if i == tries - 1:
                    self._db.execute('ROLLBACK')
                    raise
                time.sleep(wait_s)

    def enqueue(
        self, order_no: str, requester: str, options: dict[str, object], thread_ts: str | None
    ) -> tuple[Job, bool]:
        """접수. 살아 있는 같은 주문이 있으면 그 행과 False 를 준다(중복 거절)."""
        with self._immediate():
            existing = self._row(order_no)
            if existing is not None:
                if existing['state'] in LIVE_STATES:
                    return self._job(existing), False
                # 끝난 주문의 재요청 — 같은 행을 되살린다(이력·attempts 유지)
                self._db.execute(
                    'UPDATE jobs SET state=?, thread_ts=?, options=?, error=NULL, '
                    'assignee_agent=NULL, step=NULL, updated_at=? WHERE id=?',
                    (
                        'queued',
                        thread_ts,
                        json.dumps(options, ensure_ascii=False),
                        _now(),
                        existing['id'],
                    ),
                )
                return self._job(self._row(order_no)), True
            now = _now()
            try:
                self._db.execute(
                    'INSERT INTO jobs(order_no, requester, options, state, thread_ts, '
                    'created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
                    (
                        order_no,
                        requester,
                        json.dumps(options, ensure_ascii=False),
                        'queued',
                        thread_ts,
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError:
                # order_no UNIQUE 충돌 — 그 사이 다른 연결이 먼저 넣었다.
                # 새로 만들지 않고 그 행을 중복 거절로 돌려준다
                winner = self._row(order_no)
                if winner is None:
                    raise
                return self._job(winner), False
            return self._job(self._row(order_no)), True

    def claim(self) -> Job | None:
        """queued 1건을 running 으로. 이미 도는 게 있으면 None."""
        with self._immediate():
            running = self._db.execute(
                "SELECT 1 FROM jobs WHERE state='running' LIMIT 1"
            ).fetchone()
            if running is not None:
                return None
            row = self._db.execute(
                "SELECT * FROM jobs WHERE state='queued' ORDER BY id LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            self._db.execute(
                "UPDATE jobs SET state='running', updated_at=? WHERE id=?", (_now(), row['id'])
            )
            return self._job(
                self._db.execute('SELECT * FROM jobs WHERE id=?', (row['id'],)).fetchone()
            )

    def progress(self, job_id: int, *, agent: str | None, step: str | None) -> None:
        """지금 어느 에이전트의 어느 단계인지 — 슬랙 보고와 앱 화면이 읽는다."""
        self._db.execute(
            'UPDATE jobs SET assignee_agent=?, step=?, updated_at=? WHERE id=?',
            (agent, step, _now(), job_id),
        )

    def finish(self, job_id: int, state: JobState, *, error: str | None = None) -> None:
        """실행 종료 상태 기록."""
        self._db.execute(
            'UPDATE jobs SET state=?, error=?, updated_at=? WHERE id=?',
            (state, error, _now(), job_id),
        )

    def set_version(self, job_id: int, version: str) -> None:
        """이 작업을 어느 하네스 버전이 돌렸는지 남긴다(claim 직후 실행기가 부른다)."""
        self._db.execute(
            'UPDATE jobs SET harness_version=?, updated_at=? WHERE id=?',
            (version, _now(), job_id),
        )

    def retry(self, job_id: int) -> Job:
        """`이어서` — 실패·사람 넘김 건을 다시 큐에 넣는다. 상한을 넘으면 거부한다."""
        row = self._db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        if row is None:
            raise ValueError(f'없는 작업: {job_id}')
        if row['attempts'] + 1 >= MAX_ATTEMPTS:
            raise ValueError(f'재시도 상한({MAX_ATTEMPTS})에 닿았다: {row["order_no"]}')
        self._db.execute(
            "UPDATE jobs SET state='queued', attempts=attempts+1, error=NULL, updated_at=? "
            'WHERE id=?',
            (_now(), job_id),
        )
        return self._job(self._db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone())

    def try_start_resume(self, order_no: str, *, stage: str | None) -> Job | None:
        """승인 재개 — 읽기(needs_human·단계 확인)와 running 전환을 한 트랜잭션으로 묶는다.

        두 스레드가 동시에 같은 승인 버튼을 눌러도 BEGIN IMMEDIATE 가 뒤엣놈을 기다리게 하고,
        먼저 커밋된 쪽이 state 를 running 으로 바꿔놔서 뒤엣놈은 조건에 걸려 None 을 받는다
        (스펙 리뷰 지적 — Important 3).
        """
        with self._immediate():
            row = self._row(order_no)
            if row is None or row['state'] != 'needs_human':
                return None
            step = row['step'] or ''
            if stage is not None:
                if step != f'승인 대기: {stage}':
                    return None
            elif not step.startswith('승인 대기'):
                return None
            self._db.execute(
                "UPDATE jobs SET state='running', updated_at=? WHERE id=? AND state='needs_human'",
                (_now(), row['id']),
            )
            return self._job(self._row(order_no))

    def cancel(self, order_no: str) -> Job | None:
        """살아 있는 건만 취소한다. 결제 진입 뒤 취소는 감독자가 막는다(스펙 §6)."""
        row = self._row(order_no)
        if row is None or row['state'] not in LIVE_STATES:
            return None
        self._db.execute(
            "UPDATE jobs SET state='cancelled', updated_at=? WHERE id=?", (_now(), row['id'])
        )
        return self._job(self._row(order_no))

    def get(self, order_no: str) -> Job | None:
        row = self._row(order_no)
        return self._job(row) if row is not None else None

    def live(self) -> list[Job]:
        q = ','.join('?' * len(LIVE_STATES))
        rows = self._db.execute(
            f'SELECT * FROM jobs WHERE state IN ({q}) ORDER BY id', LIVE_STATES
        ).fetchall()
        return [self._job(r) for r in rows]

    def _row(self, order_no: str) -> sqlite3.Row | None:
        return self._db.execute('SELECT * FROM jobs WHERE order_no=?', (order_no,)).fetchone()

    @staticmethod
    def _job(row: sqlite3.Row) -> Job:
        return Job(
            id=row['id'],
            order_no=row['order_no'],
            requester=row['requester'],
            options=json.loads(row['options']),
            state=row['state'],
            assignee_agent=row['assignee_agent'],
            step=row['step'],
            thread_ts=row['thread_ts'],
            harness_version=row['harness_version'],
            attempts=row['attempts'],
            error=row['error'],
            created_at=row['created_at'],
            updated_at=row['updated_at'],
        )
