"""입력 작업자 — 큐에서 한 건씩 꺼내 어댑터로 기입한다.

관리자 권한으로 따로 도는 프로세스다(EMP 가 관리자 권한이라 일반 권한으로는 입력이 막힌다).
규칙: 먼저 읽는다 → 같은 값이면 입력하지 않는다 → 다른 값이 있으면 덮어쓰지 않는다 →
입력한 뒤에는 되읽어 확인한다.
"""

import logging
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal

from samba_agent.export.adapters import (
    Adapter,
    AdapterReject,
    AdapterRetry,
    BatchAdapter,
    CellValues,
)
from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportQueue, ExportRequest

log = logging.getLogger(__name__)

# 사람·창 상태를 기다리는 사유 — 시도 횟수에 넣지 않는다(5번 만에 실패로 끝나 몇 시간 방치되지 않게).
# 대화상자(BLOCKED)·인증 창은 윈도우 알림으로 사람에게 알린다
_WAIT_REASONS = (ExportFail.BUSY, ExportFail.AUTH_REQUIRED, ExportFail.BLOCKED)


@dataclass(frozen=True)
class _Outcome:
    """어댑터를 다 부른 뒤 정한 결과 — 큐에는 이걸 한 번만 쓴다(리뷰 지적 — M2).

    done 뒤의 fail_reason 은 없다. fail·retry 는 반드시 있다.
    """

    kind: Literal['done', 'fail', 'retry']
    detail: str
    reason: ExportFail | None = None


def _same(current: CellValues, req: ExportRequest) -> bool:
    """이미 기입할 값이 들어 있는가. 빈 셀과 0 은 같게 본다."""
    return (current.cost or 0) == req.cost and (current.shipping_fee or 0) == req.shipping_fee


def _conflict(current: CellValues, req: ExportRequest) -> str | None:
    """덮어쓰면 안 되는 값이 있으면 그 설명. 비어 있거나 같은 값이면 None."""
    found: list[str] = []
    if (current.cost or 0) not in (0, req.cost):
        found.append(f'원가 {current.cost:,}(기입할 값 {req.cost:,})')
    if (current.shipping_fee or 0) not in (0, req.shipping_fee):
        found.append(f'배송비 {current.shipping_fee:,}(기입할 값 {req.shipping_fee:,})')
    return ' · '.join(found) or None


class ExportWorker:
    """외부 기입 작업자. 한 번에 1건만 처리한다(프로그램 창이 하나다)."""

    def __init__(
        self,
        queue: ExportQueue,
        adapters: Mapping[str, Adapter | BatchAdapter],
        *,
        user_idle_s: Callable[[], float],
        min_idle_s: float = 20.0,
        min_idle_by_target: Mapping[str, float] | None = None,
        on_auth_required: Callable[[str, str], object] | None = None,
        max_attempts: int = 5,
        retry_delay_s: float = 60.0,
    ) -> None:
        self._queue = queue
        self._adapters = dict(adapters)
        self._user_idle_s = user_idle_s
        self._min_idle_s = min_idle_s
        # 대상마다 다른 기준 — 화면을 앞으로 가져오는 프로그램(EMP)은 사람이 자리를 비웠을 때만 만진다
        self._min_idle_by_target = dict(min_idle_by_target or {})
        # 인증 창이 떠 있을 때 사람에게 알리는 함수(프로그램 이름, 설명). 같은 프로그램은 30분에 한 번만
        self._on_auth_required = on_auth_required
        self._auth_alerted: dict[str, float] = {}
        self._max_attempts = max_attempts
        self._retry_delay_s = retry_delay_s

    @property
    def targets(self) -> tuple[str, ...]:
        return tuple(self._adapters)

    def ready_targets(self) -> tuple[str, ...]:
        """지금 만져도 되는 대상 — 사람이 입력을 멈춘 지 그 대상의 기준 시간 이상 지난 것."""
        idle = self._user_idle_s()
        return tuple(
            t for t in self._adapters if idle >= self._min_idle_by_target.get(t, self._min_idle_s)
        )

    def run_once(self) -> ExportRequest | None:
        """요청 1건을 처리하고 그 최종 상태를 돌려준다. 할 일이 없으면 None."""
        if not self._adapters:
            return None
        # 사람이 PC 를 쓰는 중이면 집지도 않는다 — 시도 횟수를 헛되이 쓰지 않는다
        ready = self.ready_targets()
        if not ready:
            return None
        req = self._queue.claim_next(ready)
        if req is None:
            return None
        self._process(req, self._adapters[req.target])
        return self._queue.get(req.id)

    def _process(self, req: ExportRequest, adapter: Adapter | BatchAdapter) -> None:
        batch = isinstance(adapter, BatchAdapter)
        completed: set[str] = set()
        if batch:
            outcome, completed = self._decide_batch(req, adapter)
        else:
            outcome = self._decide(req, adapter)
        # 큐 기록은 어댑터 try 바깥에서 한 번만 한다 — 기입은 성공했는데 그 뒤 큐 쓰기가
        # 실패하면(예: sqlite 오류) 리뷰 지적 M2 이전에는 UNKNOWN 실패로 잘못 남았다.
        # 여기서 나는 예외는 run_once 밖으로 그대로 나가고, running 인 행은 재시작 때
        # recover_running 이 되돌린다(같은 값이면 다시 입력하지 않으니 안전하다).
        if batch and completed:
            # 일괄 처리가 찾아서 끝낸 다른 대기 요청도 함께 성공으로 적는다(집은 요청은 아래서)
            self._queue.done_orders(
                req.target, sorted(completed - {req.order_no}), outcome.detail, except_id=req.id
            )
        if outcome.kind == 'done':
            self._queue.done(req.id, outcome.detail)
        elif outcome.kind == 'retry':
            assert outcome.reason is not None
            self._queue.retry_later(
                req.id,
                outcome.reason,
                outcome.detail,
                self._retry_delay_s,
                count_attempt=outcome.reason not in _WAIT_REASONS,
            )
            if outcome.reason in (ExportFail.AUTH_REQUIRED, ExportFail.BLOCKED):
                self._alert_auth(req.target, outcome.detail)
        else:
            assert outcome.reason is not None
            self._queue.fail(req.id, outcome.reason, outcome.detail)

    def _alert_auth(self, target: str, detail: str) -> None:
        program = target.split('_', 1)[0]
        now = time.monotonic()
        if self._on_auth_required is None or now - self._auth_alerted.get(program, -1e9) < 1800:
            return
        self._auth_alerted[program] = now
        try:
            self._on_auth_required(program, detail)
        except Exception:
            log.exception('인증 창 알림 실패')

    def _decide(self, req: ExportRequest, adapter: Adapter) -> _Outcome:
        """어댑터를 불러 결과를 정한다. 큐는 건드리지 않는다(어댑터 계약 밖 예외만 여기서 잡는다)."""
        try:
            current = adapter.read(req.order_no)
            if _same(current, req):
                return _Outcome('done', '이미 같은 값이 들어 있어 입력하지 않았다')
            conflict = _conflict(current, req)
            if conflict is not None:
                return _Outcome('fail', f'덮어쓰지 않았다 — {conflict}', ExportFail.VALUE_CONFLICT)
            adapter.write(req.order_no, req.cost, req.shipping_fee)
            after = adapter.read(req.order_no)
            if not _same(after, req):
                return _Outcome(
                    'fail',
                    f'되읽은 값이 다르다 — 원가 {after.cost} · 배송비 {after.shipping_fee}',
                    ExportFail.VERIFY_MISMATCH,
                )
            return _Outcome('done', f'원가 {req.cost:,} · 배송비 {req.shipping_fee:,} 기입 확인')
        except AdapterRetry as e:
            if e.reason not in _WAIT_REASONS and req.attempts >= self._max_attempts:
                return _Outcome('fail', f'재시도 {req.attempts}회 모두 실패 — {e.detail}', e.reason)
            return _Outcome('retry', e.detail, e.reason)
        except AdapterReject as e:
            return _Outcome('fail', e.detail, e.reason)
        except Exception as e:
            # 어댑터 계약(AdapterRetry·AdapterReject) 밖의 예외다 — 입력이 어디까지 됐는지
            # 모르니 자동으로 다시 하지 않고 사람이 본다(중간에 멈춘 경우만이 아니라 어떤
            # 예상 못한 오류든 여기로 온다)
            log.exception('외부 기입 중 오류: %s(%s)', req.order_no, req.target)
            return _Outcome('fail', f'{type(e).__name__}: {e}'[:200], ExportFail.UNKNOWN)

    def _decide_batch(self, req: ExportRequest, adapter: BatchAdapter) -> tuple[_Outcome, set[str]]:
        """일괄형 어댑터 — 집은 요청과 같은 대상의 대기 주문번호를 모두 넘기고, 처리된 집합을 받는다.

        집은 요청의 주문번호가 처리 집합에 없으면(아직 화면에 수집되지 않음) 시간을 두고 다시 한다.
        실패 분류는 _decide 와 같다. 돌려주는 집합은 호출부가 다른 대기 요청을 끝내는 데 쓴다.
        """
        # 주문 1건 단위로 도는 어댑터는 집은 주문만 넘긴다 — 하네스가 그 주문의 결과를 기다리고,
        # 한 건 때문에 묶음 전체가 실패하지 않는다(사용자 결정 2026-09-29)
        if getattr(adapter, 'one_at_a_time', False):
            order_nos = [req.order_no]
        else:
            order_nos = [req.order_no, *self._queue.pending_order_nos(req.target)]
        try:
            completed = set(adapter.complete_pending(order_nos))
        except AdapterRetry as e:
            if e.reason not in _WAIT_REASONS and req.attempts >= self._max_attempts:
                return _Outcome(
                    'fail', f'재시도 {req.attempts}회 모두 실패 — {e.detail}', e.reason
                ), set()
            return _Outcome('retry', e.detail, e.reason), set()
        except AdapterReject as e:
            return _Outcome('fail', e.detail, e.reason), set()
        except Exception as e:
            log.exception('외부 일괄 처리 중 오류: %s(%s)', req.order_no, req.target)
            return _Outcome('fail', f'{type(e).__name__}: {e}'[:200], ExportFail.UNKNOWN), set()
        detail = f'처리 {len(completed)}건'
        # 읽기 작업은 읽은 값을 결과로 남긴다(하네스가 그 값으로 다음 일을 한다)
        found = getattr(adapter, 'detail_for', None)
        if callable(found) and req.order_no in completed:
            detail = str(found(req.order_no) or detail)
        if req.order_no in completed:
            return _Outcome('done', detail), completed
        # 화면(필터)에 아직 없는 주문 — 수집이 늦을 수 있으니 시간을 두고 다시 본다
        if req.attempts >= self._max_attempts:
            return (
                _Outcome(
                    'fail',
                    f'재시도 {req.attempts}회 동안 화면에서 주문을 찾지 못했다',
                    ExportFail.NOT_FOUND,
                ),
                completed,
            )
        return _Outcome(
            'retry', '화면(필터)에 아직 없다 — 나중에 다시', ExportFail.NOT_FOUND
        ), completed

    def run_forever(
        self,
        should_stop: Callable[[], bool],
        poll_s: float = 3.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """멈추라고 할 때까지 돈다. 일을 했으면 쉬지 않고 바로 다음 건을 본다."""
        while not should_stop():
            worked = False
            try:
                # 살아 있다는 표시는 실제로 집을 수 있을 때만 남긴다 — 사람이 PC 를 쓰는 중에도
                # beat 를 남기면 export 단계가 alive() 만 보고 주문마다 대기 시간을 통째로 쓴다
                ready = self.ready_targets()
                if ready:
                    self._queue.beat(ready)
                worked = self.run_once() is not None
            except Exception:
                log.exception('입력 작업자 고리 오류 — 계속한다')
            if not worked:
                sleep(poll_s)
