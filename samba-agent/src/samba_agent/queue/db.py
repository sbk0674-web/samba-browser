"""주문 큐 — SQLite. 잠금은 작업 키 유일성 + BEGIN IMMEDIATE 트랜잭션으로 건다(스펙 §4.2).

손발(앱)이 하나라 실행은 한 번에 1건이다. 같은 주문 재요청은 새 행을 만들지 않고
기존 행을 돌려준다 — 봇이 "이미 ○○님이 처리 중" 이라고 답한다.

작업 키: 삼바웨이브 주문 행 id(`wave_id`, `ord_…`) 가 있으면 그것, 없으면(슬랙 수동 접수·옛 행) 상품주문번호.
한 상품주문번호에 삼바웨이브 행이 여럿일 수 있어(한 주문의 사이즈 2개 — 실기 2026-10-05 20261005DFA7D9:
230 발주·210 주문접수) order_no 는 더 이상 UNIQUE 가 아니다. wave_id 가 있는 행끼리만 유일하다.
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
# 삼바웨이브 주문 행 id 머리말 — 슬랙 명령이 이 모양의 키를 주면 행 id 로 본다
WAVE_ID_PREFIX = 'ord_'

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL,
  wave_id TEXT,
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
CREATE INDEX IF NOT EXISTS jobs_order_no ON jobs(order_no);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_wave_id ON jobs(wave_id) WHERE wave_id IS NOT NULL;
"""
# 옛 표(order_no UNIQUE, wave_id 없음)에서 새 표로 옮길 때 그대로 복사하는 열 — id 를 지켜야 체크포인트
# 스레드(job:<id>)가 이어진다
_LEGACY_COLUMNS = (
    'id, order_no, requester, options, state, assignee_agent, step, thread_ts, '
    'harness_version, attempts, error, created_at, updated_at'
)


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
    # 삼바웨이브 주문 행 id(ord_…). 자동 수집이 채운다. 슬랙 수동 접수·옛 행은 None
    wave_id: str | None = None

    @property
    def key(self) -> str:
        """삼바웨이브·큐를 부를 때 쓰는 키 — 행 id 가 있으면 그것, 없으면 상품주문번호."""
        return self.wave_id or self.order_no


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec='seconds')


def is_wave_id(key: str) -> bool:
    """키가 삼바웨이브 주문 행 id 모양인가."""
    return key.startswith(WAVE_ID_PREFIX)


class JobQueue:
    """주문 큐. 한 프로세스(실행기)만 쓴다."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # 여러 연결이 동시에 BEGIN IMMEDIATE 로 부딪히면 즉시 실패하지 않고
        # 앞선 트랜잭션이 끝날 때까지 기다린다
        self._db.execute('PRAGMA busy_timeout=5000')
        self._migrate_legacy()
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

    def _migrate_legacy(self) -> None:
        """옛 표(order_no UNIQUE·wave_id 없음)를 새 표로 옮긴다. 행·id 는 그대로, wave_id 는 비워 둔다.

        SQLite 는 UNIQUE 제약을 떼지 못해 표를 새로 만들어 복사한다. 옛 행은 wave_id 가 없어
        같은 상품주문번호의 다른 삼바웨이브 행과 구분이 안 된다 — `find` 가 '끝난(done) 옛 행은 다른 행을
        막지 않는다' 로 다룬다.
        """
        row = self._db.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'"
        ).fetchone()
        if row is None:
            return
        cols = {r[1] for r in self._db.execute('PRAGMA table_info(jobs)')}
        if 'wave_id' in cols and 'UNIQUE' not in str(row['sql']).upper():
            return
        self._db.executescript(
            'BEGIN;\n'
            'ALTER TABLE jobs RENAME TO jobs_legacy;\n'
            'DROP INDEX IF EXISTS jobs_state;\n'
            + _SCHEMA
            + f'INSERT INTO jobs({_LEGACY_COLUMNS}) SELECT {_LEGACY_COLUMNS} FROM jobs_legacy;\n'
            'DROP TABLE jobs_legacy;\n'
            'COMMIT;'
        )

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
        self,
        order_no: str,
        requester: str,
        options: dict[str, object],
        thread_ts: str | None,
        *,
        wave_id: str | None = None,
    ) -> tuple[Job, bool]:
        """접수. 살아 있는 같은 작업이 있으면 그 행과 False 를 준다(중복 거절).

        ``wave_id`` 는 삼바웨이브 주문 행 id — 자동 수집은 반드시 준다(같은 상품주문번호의 다른 행과 구분).
        슬랙 수동 접수는 상품주문번호만 주고, 키가 행 id 모양(ord_…)이면 그것을 wave_id 로도 쓴다.
        """
        if wave_id is None and is_wave_id(order_no):
            wave_id = order_no
        with self._immediate():
            existing = self._find_row(order_no, wave_id)
            if existing is not None:
                if existing['state'] in LIVE_STATES:
                    return self._job(existing), False
                # 끝난 작업의 재요청 — 같은 행을 되살린다(이력·attempts 유지). 옛 행이면 행 id 를 이때 채운다
                self._db.execute(
                    'UPDATE jobs SET state=?, thread_ts=?, options=?, error=NULL, '
                    'assignee_agent=NULL, step=NULL, wave_id=COALESCE(wave_id, ?), updated_at=? '
                    'WHERE id=?',
                    (
                        'queued',
                        thread_ts,
                        json.dumps(options, ensure_ascii=False),
                        wave_id,
                        _now(),
                        existing['id'],
                    ),
                )
                return self._job(self._by_id(existing['id'])), True
            now = _now()
            try:
                cur = self._db.execute(
                    'INSERT INTO jobs(order_no, wave_id, requester, options, state, thread_ts, '
                    'created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
                    (
                        order_no,
                        wave_id,
                        requester,
                        json.dumps(options, ensure_ascii=False),
                        'queued',
                        thread_ts,
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError:
                # wave_id UNIQUE 충돌 — 그 사이 다른 연결이 먼저 넣었다.
                # 새로 만들지 않고 그 행을 중복 거절로 돌려준다
                winner = self._find_row(order_no, wave_id)
                if winner is None:
                    raise
                return self._job(winner), False
            return self._job(self._by_id(int(cur.lastrowid))), True

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
            return self._job(self._by_id(row['id']))

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
        row = self._by_id(job_id)
        if row is None:
            raise ValueError(f'없는 작업: {job_id}')
        if row['attempts'] + 1 >= MAX_ATTEMPTS:
            raise ValueError(f'재시도 상한({MAX_ATTEMPTS})에 닿았다: {row["order_no"]}')
        self._db.execute(
            "UPDATE jobs SET state='queued', attempts=attempts+1, error=NULL, updated_at=? "
            'WHERE id=?',
            (_now(), job_id),
        )
        return self._job(self._by_id(job_id))

    def try_start_resume(self, key: str, *, stage: str | None) -> Job | None:
        """승인 재개 — 읽기(needs_human·단계 확인)와 running 전환을 한 트랜잭션으로 묶는다.

        두 스레드가 동시에 같은 승인 버튼을 눌러도 BEGIN IMMEDIATE 가 뒤엣놈을 기다리게 하고,
        먼저 커밋된 쪽이 state 를 running 으로 바꿔놔서 뒤엣놈은 조건에 걸려 None 을 받는다
        (스펙 리뷰 지적 — Important 3). 키는 행 id 또는 상품주문번호 — 상품주문번호에 승인 대기 행이
        여럿이면 먼저 접수된 것부터.
        """
        with self._immediate():
            rows = [r for r in self._rows_by_key(key) if r['state'] == 'needs_human']
            row = next((r for r in rows if _waiting(r['step'], stage)), None)
            if row is None:
                return None
            self._db.execute(
                "UPDATE jobs SET state='running', updated_at=? WHERE id=? AND state='needs_human'",
                (_now(), row['id']),
            )
            return self._job(self._by_id(row['id']))

    def cancel(self, key: str) -> Job | None:
        """살아 있는 건만 취소한다. 결제 진입 뒤 취소는 감독자가 막는다(스펙 §6).

        상품주문번호로 부르면 그 번호의 살아 있는 행 전부를 취소한다(마지막 행을 돌려준다).
        """
        live = [r for r in self._rows_by_key(key) if r['state'] in LIVE_STATES]
        if not live:
            return None
        for row in live:
            self._db.execute(
                "UPDATE jobs SET state='cancelled', updated_at=? WHERE id=?", (_now(), row['id'])
            )
        return self._job(self._by_id(live[-1]['id']))

    def get(self, key: str) -> Job | None:
        """키(행 id 또는 상품주문번호)로 한 행. 상품주문번호에 행이 여럿이면 살아 있는 것 > 최근 것."""
        rows = self._rows_by_key(key)
        if not rows:
            return None
        live = [r for r in rows if r['state'] in LIVE_STATES]
        return self._job((live or rows)[-1])

    def get_by_id(self, job_id: int) -> Job | None:
        row = self._by_id(job_id)
        return self._job(row) if row is not None else None

    def find(self, order_no: str, wave_id: str | None) -> Job | None:
        """자동 수집용 — 이 삼바웨이브 행을 이미 맡은 작업(어떤 상태든). 없으면 None.

        행 id 가 같은 작업이 있으면 그것. 없으면 상품주문번호가 같고 행 id 가 없는 옛·수동 행을 본다 —
        그 행이 끝나지(done) 않았으면 같은 주문으로 쳐서 막고, done 이면 이미 기입한 다른 행이므로 막지 않는다
        (실기 20261005DFA7D9: 230 행 done 뒤 210 행이 영영 큐에 안 들어갔다).
        """
        row = self._find_row(order_no, wave_id)
        return self._job(row) if row is not None else None

    def live(self) -> list[Job]:
        q = ','.join('?' * len(LIVE_STATES))
        rows = self._db.execute(
            f'SELECT * FROM jobs WHERE state IN ({q}) ORDER BY id', LIVE_STATES
        ).fetchall()
        return [self._job(r) for r in rows]

    def _find_row(self, order_no: str, wave_id: str | None) -> sqlite3.Row | None:
        if wave_id:
            row = self._db.execute('SELECT * FROM jobs WHERE wave_id=?', (wave_id,)).fetchone()
            if row is not None:
                return row
            return self._db.execute(
                "SELECT * FROM jobs WHERE order_no=? AND wave_id IS NULL AND state!='done' "
                'ORDER BY id DESC LIMIT 1',
                (order_no,),
            ).fetchone()
        rows = self._rows_by_key(order_no)
        if not rows:
            return None
        live = [r for r in rows if r['state'] in LIVE_STATES]
        return (live or rows)[-1]

    def _rows_by_key(self, key: str) -> list[sqlite3.Row]:
        """키와 맞는 행 전부(id 오름차순) — 행 id 로 하나, 또는 상품주문번호로 여럿."""
        return self._db.execute(
            'SELECT * FROM jobs WHERE wave_id=? OR order_no=? ORDER BY id', (key, key)
        ).fetchall()

    def _by_id(self, job_id: int) -> sqlite3.Row | None:
        return self._db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()

    @staticmethod
    def _job(row: sqlite3.Row) -> Job:
        return Job(
            id=row['id'],
            order_no=row['order_no'],
            wave_id=row['wave_id'],
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


def _waiting(step: str | None, stage: str | None) -> bool:
    """이 행이 지금 그 단계의 승인 대기인가(stage 가 None 이면 어느 승인 대기든)."""
    text = step or ''
    if stage is not None:
        return text == f'승인 대기: {stage}'
    return text.startswith('승인 대기')
