"""AI 대행 실행기 — 막힌 작업을 백그라운드로 판단시키고, 판단을 큐·삼바웨이브에 반영한다.

판단은 AI(OperatorAgent) 가, 실행은 이 코드가 한다. AI 는 큐·삼바웨이브에 닿는 도구가 없다.
한 번에 한 건만 판단한다(브라우저 레인 하나를 쓰므로). 작업당 한 번만 — 같은 작업을 되풀이해 판단하지 않는다.
"""

import json
import logging
import sqlite3
import threading
from collections.abc import Callable
from pathlib import Path

from samba_agent.operator.agent import BridgeCall, OperatorAgent, Verdict
from samba_agent.ops.masking import mask_text
from samba_agent.queue.db import Job, JobQueue

log = logging.getLogger(__name__)

OPERATOR_KEY = '_operator'
# AI 에게 맡기지 않는 오류 코드 — 돈·중복·로그인 문제는 사람이 본다
_SKIP_FAILS = {'pay_interrupted', 'verify_mismatch', 'duplicate', 'permission_denied', 'margin'}
# 결제가 됐을 수 있는 말 — 하나라도 있으면 맡기지 않는다(worker.PAID_RISK_MARKS 와 같은 뜻)
_PAID_RISK = (
    '결제 비밀번호',
    'verify-failed',
    '결제됐는지',
    '승인 실패',
    '결제는 됐는데',
    '결제 완료',
)


def eligible(job: Job, fail: str | None, reason: str) -> bool:
    """AI 대행에 맡길 수 있는 멈춤인가 — 결제 전·미판단·알 수 없는 사유만."""
    if job.options.get(OPERATOR_KEY):
        return False
    if (fail or 'unknown') in _SKIP_FAILS or (fail or 'unknown') != 'unknown':
        return False
    return not any(m in (reason or '') for m in _PAID_RISK)


def events_tail(path: Path, job_id: int, limit: int = 6) -> str:
    """작업의 마지막 에이전트 이벤트 몇 줄(사유 위주). 읽기 전용."""
    try:
        db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        rows = db.execute(
            "SELECT agent, payload FROM events WHERE job_id=? AND kind='agent' ORDER BY id DESC LIMIT ?",
            (job_id, limit),
        ).fetchall()
        db.close()
    except sqlite3.Error:
        return ''
    out: list[str] = []
    for agent, payload in reversed(rows):
        try:
            d = json.loads(payload)
        except ValueError:
            continue
        out.append(f'{agent} {d.get("step")} {d.get("status")}: {str(d.get("reason") or "")[:300]}')
    return '\n'.join(out)


class OperatorService:
    def __init__(
        self,
        agent: OperatorAgent,
        *,
        call: BridgeCall,
        queue: JobQueue,
        flag_order: Callable[..., str | None] | None,
        report: Callable[[Job, str], None],
        describe: Callable[[Job], tuple[str, str]] | None = None,
        events_path: Path | None = None,
        run_async: bool = True,
    ) -> None:
        self._agent = agent
        self._call = call
        self._queue = queue
        self._flag = flag_order
        self._report = report
        # 작업 → (소싱처, 상품 요약) — 없으면 작업의 주문번호만 알려 준다
        self._describe = describe
        self._events_path = events_path
        self._run_async = run_async
        self._busy = threading.Lock()

    def submit(self, job: Job, fail: str | None, reason: str) -> bool:
        """맡을 수 있으면 백그라운드로 판단을 시작한다. 시작했으면 True."""
        if not eligible(job, fail, reason):
            return False
        if not self._busy.acquire(blocking=False):
            return False  # 이미 한 건을 판단 중 — 이 건은 사람에게 남는다
        if self._run_async:
            threading.Thread(
                target=self._run, args=(job, reason), daemon=True, name='operator'
            ).start()
        else:
            self._run(job, reason)
        return True

    def _run(self, job: Job, reason: str) -> None:
        try:
            source, summary = self._describe(job) if self._describe else ('', job.order_no)
            ctx = {
                'order': summary,
                'source': source,
                'account': str(job.options.get('account') or ''),
                'reason': mask_text(reason)[:600],
                'tries': f'결제 전 일시 오류 재시도 {job.options.get("_transient_retry") or 0}회',
                'events': mask_text(events_tail(self._events_path, job.id))
                if self._events_path
                else '',
            }
            self._report(job, f'{job.order_no} AI 대행이 막힌 이유를 보고 판단한다')
            verdict = self._agent.judge(call=self._call, ctx=ctx)
            self.apply(job, verdict)
        except Exception:
            log.exception('AI 대행 실패: %s', job.order_no)
        finally:
            self._busy.release()

    def apply(self, job: Job, verdict: Verdict) -> str:
        """판단을 실행한다. 결과 한 줄."""
        line = f'{job.order_no} AI 대행 판단 {verdict.action}: {mask_text(verdict.reason)[:160]}'
        if verdict.action == 'retry':
            self._queue.finish(job.id, 'failed', error='unknown')
            self._queue.enqueue(
                job.order_no,
                job.requester,
                {**job.options, OPERATOR_KEY: 1},
                job.thread_ts,
                wave_id=job.wave_id,
            )
            line += ' — 처음부터 다시 한다'
        elif verdict.action == 'cancel' and self._flag is not None:
            key = job.wave_id or job.order_no
            done = self._flag(key, 'out_of_stock', f'[AI 대행 확인] {verdict.evidence}')
            line += f' — 근거 "{mask_text(verdict.evidence)[:100]}" 로 취소중 정리({done or "표시 실패"})'
        else:
            line += ' — 사람 확인 필요'
        log.info(line)
        self._report(job, line)
        return line
