"""실행기 — 큐에서 1건 집어 감독자 그래프를 돌리고, 결과를 큐와 슬랙에 쓴다.

손발(앱)이 하나라 한 번에 1건이다. 승인 대기(interrupt)에서 멈추면 큐 상태를
needs_human 으로 두고 사람이 슬랙에서 승인할 때까지 기다린다(스펙 §10-1).
"""

import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from samba_agent.agents.contracts import OrderRef
from samba_agent.failures import FailReason
from samba_agent.ops.events import EventLog
from samba_agent.ops.masking import mask_text
from samba_agent.ops.tracing import run_metadata, traced
from samba_agent.queue.db import PAY_STARTED_STEP, Job, JobQueue
from samba_agent.queue.tabs import TabJanitor
from samba_agent.supervisor.approval import resume_command
from samba_agent.wave.flags import auto_cancel_evidence

THREAD_PREFIX = 'job:'
# 카카오페이 비밀번호를 사람이 끝내 안 넣어 멈춘 결제(payer 문구) — 다른 수단으로 사지 않고 메모만 남긴다
KAKAO_FALLBACK_MARK = '카카오페이 폰 비밀번호를 기다렸지만'
# 배송지를 저장했는데 목록에 바로 안 보여 멈춘 결제 전 실패(구매 문구) — 한 번 다시 돌린다
SHIP_RETRY_MARK = '저장 뒤 목록에 없음'
SHIP_RETRY_KEY = '_ship_retry'

_log = logging.getLogger(__name__)


@dataclass
class WorkerDeps:
    """실행기가 쓰는 것들. 테스트는 여기에 가짜를 넣는다.

    ``version`` 은 tick 마다 다시 불러야 한다 — 규칙 파일을 PUT 으로 고치면
    harness_version 이 바뀌는데, 기동 시점 문자열로 고정하면 워커가 옛 버전을
    계속 기록한다(리뷰 지적 — Important 1). 기존 테스트 호환을 위해 문자열이
    오면 ``__post_init__`` 에서 상수를 돌려주는 콜러블로 감싼다.
    """

    queue: JobQueue
    graph: object  # CompiledGraph
    version: Callable[[], str] | str
    report: Callable[[Job, str], None]
    parse_order: Callable[[Job], OrderRef]
    # 승인 요청 전용 통로 — 슬랙 버튼을 달아 보낸다(리뷰 지적 — Critical 1).
    # 주입하지 않으면 평문 보고(report)로 떨어진다.
    approval_report: Callable[[Job, str, str, str], None] | None = None
    # settings.dry_run 이 아직 여기까지 안 들어와서 당장은 기본값 True 로 주입한다.
    dry_run: bool = True
    # dry-run 에서 결제 비밀번호를 몇 자리만 눌러 보고 취소할지(0 이면 결제창까지만)
    dry_run_digits: int = 0
    # 관측(스펙 §4.5 1단계) — 주입하면 실행 1건이 LangSmith span + 로컬 이벤트로 남는다.
    # 없으면 추적 없이 그냥 돈다(테스트·오프라인)
    events: EventLog | None = None
    env: str = 'dev'
    prompt_commit: str = '-'
    # 이행하지 못한 주문 표시(가격X·재고X) — (주문번호, 실패 사유) → 결과 한 줄(붙일 게 없으면 None).
    # dry-run 에서는 부르지 않는다
    flag_order: Callable[..., str | None] | None = None
    # 주문 메모 한 줄 덧붙이기(주문번호, 글) — 카카오페이 최저가인데 비밀번호를 못 받은 주문에 쓴다. 없으면 보고만 한다
    add_memo: Callable[[str, str], bool] | None = None
    # 끝난(done) 작업 뒤처리 — (작업, 그래프 결과) → 보고할 한 줄(할 일 없으면 None). SSG 선물 수락(폰)에 쓴다
    after_done: Callable[[Job, dict], str | None] | None = None
    # 브라우저 그래프 대신 폰으로 사는 소싱처(대문자 id → 처리기). 처리기는 (작업, 주문) → (결과, 오류 코드, 보고)
    # 중국 크림(SHIHUO) 주문 — 得物 앱 구매(사용자 2026-10-01)
    phone_sources: dict[str, Callable[[Job, OrderRef], tuple[str, str | None, str]]] = field(default_factory=dict)
    # 처리할 소싱처 범위(대문자 id). 비어 있으면 거르지 않는다. 접수 뒤 삼바웨이브에서 소싱처가 바뀐 주문을
    # 시작 직전에 한 번 더 거른다(실기 2026-09-25: 무신사로 접수된 주문이 롯데온으로 바뀌어 돌았다)
    sources: frozenset[str] = frozenset()
    # 자동 승인에서 빼는 결제수단 표시 이름(승인 요약의 '카드:' 에 들어 있으면 사람 승인을 기다린다)
    manual_approve_methods: tuple[str, ...] = ()
    # 보관 기간 지난 이벤트 정리(EventLog.prune). 기동 시 1회 + 주기마다 부른다(리뷰 지적 — Minor)
    prune: Callable[[], int] | None = None
    prune_interval_s: float = 6 * 60 * 60
    # 끝난 실행의 체크포인트 스레드를 지운다(체크포인터의 delete_thread). 같은 job id 로 다시 접수될 때
    # 지난 실행의 attempts·results 가 새 실행에 섞이지 않게 한다. 없으면 지우지 않는다(테스트)
    reset_thread: Callable[[str], None] | None = None
    # 작업이 연 브라우저 탭을 끝날 때 닫는다(실기: 옛 주문서 탭을 다음 작업이 읽어 원가 오독).
    # 없으면 닫지 않는다(테스트)
    tabs: TabJanitor | None = None
    # True 면 작업이 끝나도 탭을 바로 닫지 않고 **다음 작업이 시작할 때** 닫는다 — 사용자가 결과 화면(주문서·
    # 실패 화면)을 눈으로 확인할 수 있어야 한다(사용자 지시 2026-09-24). 옛 주문서 오독은 다음 작업 시작 전 정리로 막는다
    keep_tabs: bool = False
    # True 면 결제 승인 요청을 즉시 승인한다(SAMBA_AUTO_APPROVE — 사용자가 자동 이행을 켠 경우)
    auto_approve: bool = False
    # 브릿지가 지금 일을 받을 수 있는가(앱 채팅이 도는 동안은 409 busy). 거짓이면 큐를 집지 않고
    # 다음 주기를 기다린다 — 실기: 사용자가 앱에서 채팅을 돌리는 동안 5건이 전부 bridge_down 으로 사람에게 넘어갔다
    ready: Callable[[], bool] | None = None

    def __post_init__(self) -> None:
        if isinstance(self.version, str):
            fixed = self.version
            self.version = lambda: fixed


class Worker:
    """큐 ↔ 감독자 그래프."""

    def __init__(self, deps: WorkerDeps) -> None:
        self.d = deps
        self._last_prune: float | None = None
        # 작업 id → 시작 시점 탭 목록. 승인 대기로 멈춘 작업은 재개 뒤 닫으려고 남겨 둔다
        self._tab_marks: dict[int, frozenset[str]] = {}
        # keep_tabs 일 때 아직 안 닫은 지난 작업의 시작 시점 탭 목록(가장 오래된 것 하나면 충분하다)
        self._deferred_mark: frozenset[str] | None = None

    def tick(self) -> Job | None:
        """queued 1건을 집어 끝까지(또는 승인 대기까지) 돌린다. 없으면 None."""
        if self.d.ready is not None and not self.d.ready():
            return None
        job = self.d.queue.claim()
        if job is None:
            return None
        version = self.d.version()
        self.d.queue.set_version(job.id, version)
        self.d.report(job, f'접수: {job.order_no} 처리 시작(하네스 {version})')
        # 주문 조회(브릿지)도 예외가 날 수 있다 — running 으로 남기지 않고 사람에게 넘긴다
        try:
            order = self.d.parse_order(job)
        except Exception as e:  # noqa: BLE001 — 조회 실패 사유는 다양하다(브릿지·JSON·누락 필드)
            msg = mask_text(str(e))[:300]
            self.d.queue.finish(job.id, 'needs_human', error=f'주문 조회 실패: {msg}')
            self.d.report(job, f'주문 조회 실패 — 사람 확인 필요: {msg}')
            return self.d.queue.get(job.order_no)
        if self.d.sources and order.source.upper() not in self.d.sources:
            why = f'처리 범위 밖 소싱처: {order.source or "(없음)"} — 범위 {sorted(self.d.sources)}'
            self.d.queue.finish(job.id, 'needs_human', error=why)
            self.d.report(job, f'{job.order_no} 건너뜀 — {why}')
            return self.d.queue.get(job.order_no)
        handler = self.d.phone_sources.get(order.source.upper())
        if handler is not None:
            return self._run_phone_order(job, order, handler)
        self._reset_finished_thread(job.id)
        if self.d.tabs is not None:
            self._close_deferred(job)
            self._close_leftovers(job.order_no)
            self._tab_marks[job.id] = self.d.tabs.snapshot()
        state = {
            'order': order,
            'options': {str(k): str(v) for k, v in job.options.items()},
            'job_id': job.id,
            'dry_run': self.d.dry_run,
            'dry_run_digits': self.d.dry_run_digits,
        }
        return self._cleanup_tabs(self._invoke(job, state))

    def _run_phone_order(
        self, job: Job, order: OrderRef, handler: Callable[[Job, OrderRef], tuple[str, str | None, str]]
    ) -> Job | None:
        """폰으로 사는 소싱처 — 그래프 없이 처리기 하나로 끝낸다. dry-run 이면 사지 않고 사람에게 넘긴다."""
        if self.d.dry_run:
            self.d.queue.finish(job.id, 'needs_human', error='dry_run')
            self.d.report(job, f'{job.order_no} 폰 구매 소싱처({order.source}) — dry-run 이라 사지 않음')
            return self.d.queue.get(job.order_no)
        self.d.queue.progress(job.id, agent=f'phone.{order.source.lower()}', step='폰 구매')
        try:
            outcome, fail, line = handler(job, order)
        except Exception as exc:  # noqa: BLE001 — 처리기 예외는 사람에게 넘긴다(결제 여부는 보고 줄로 확인)
            outcome, fail, line = 'needs_human', 'unknown', f'폰 구매 오류: {mask_text(str(exc))[:200]}'
        self.d.queue.progress(job.id, agent=None, step=None)
        self.d.queue.finish(job.id, outcome, error=fail)
        self.d.report(job, mask_text(f'{job.order_no} {outcome} — {line}')[:300])
        return self.d.queue.get(job.order_no)

    def _close_leftovers(self, label: str) -> None:
        """작업 시작 직전 — 지난 작업(죽은 하네스·시간 초과)이 남긴 탭을 닫는다. 화면을 남기는 설정이면 건너뛴다."""
        if self.d.tabs is None or self.d.keep_tabs:
            return
        if self._tab_marks:
            return  # 승인 대기로 멈춘 작업의 주문서가 살아 있어야 한다
        try:
            closed = self.d.tabs.close_leftovers()
        except Exception:  # noqa: BLE001 — 정리 실패가 새 작업을 막으면 안 된다
            _log.exception('남은 탭 정리 실패 — 그대로 둔다: %s', label)
            return
        if closed:
            _log.info('%s 시작 전 남은 탭 %d개 닫음', label, closed)

    def _close_deferred(self, job: Job) -> None:
        """keep_tabs 로 남겨 둔 지난 작업의 탭을 새 작업 시작 직전에 닫는다(옛 주문서 오독 방지)."""
        if self._deferred_mark is None or self.d.tabs is None:
            return
        mark, self._deferred_mark = self._deferred_mark, None
        try:
            closed = self.d.tabs.close_new(mark)
        except Exception:  # noqa: BLE001 — 정리 실패가 새 작업을 막으면 안 된다
            _log.exception('지난 작업 탭 정리 실패 — 그대로 둔다: %s', job.order_no)
            return
        if closed:
            _log.info('%s 시작 전 지난 작업 탭 %d개 닫음', job.order_no, closed)

    def _cleanup_tabs(self, job: Job | None) -> Job | None:
        """작업이 끝났으면(승인 대기가 아니면) 그 작업이 연 탭을 닫는다."""
        if job is None or self.d.tabs is None:
            return job
        if (job.step or '').startswith('승인 대기'):
            return job  # 결제 직전 주문서가 살아 있어야 한다
        before = self._tab_marks.pop(job.id, None)
        if before is None:
            return job
        if self.d.keep_tabs:
            # 화면을 남긴다 — 다음 작업 시작 때 닫는다(가장 오래된 표식을 유지해야 그 뒤 탭이 전부 닫힌다)
            if self._deferred_mark is None:
                self._deferred_mark = before
            _log.info('%s 작업이 연 탭을 남겨 둔다(다음 작업 시작 때 정리)', job.order_no)
            return job
        try:
            closed = self.d.tabs.close_new(before)
        except Exception:  # noqa: BLE001 — 정리 실패가 결과를 바꾸면 안 된다
            _log.exception('탭 정리 실패 — 그대로 둔다: %s', job.order_no)
            return job
        if closed:
            _log.info('%s 작업이 연 탭 %d개 닫음', job.order_no, closed)
        return job

    def resume(
        self, order_no: str, approved: bool, by: str, stage: str | None = None
    ) -> Job | None:
        """슬랙 승인 버튼 → 멈춘 그래프를 깨운다.

        끝난 주문이거나(중복 클릭 등) 이미 다른 단계로 넘어갔으면 None.
        ``stage`` 를 주면 지금 큐가 그 단계(``승인 대기: {stage}``)에 멈춰 있을 때만 재개한다 —
        같은 버튼을 두 번 눌러도 두 번째는 여기서 걸린다(스펙 리뷰 지적 — Critical 2).
        읽기→running 전환은 JobQueue 트랜잭션으로 원자화돼 있어 동시 호출도 하나만 통과한다.
        """
        job = self.d.queue.try_start_resume(order_no, stage=stage)
        if job is None:
            return None
        return self._cleanup_tabs(self._invoke(job, resume_command(approved, by)))

    def run_forever(self, stop: Callable[[], bool], interval_s: float = 2.0) -> None:
        """봇과 함께 도는 고리. stop() 이 참이 될 때까지 큐를 본다."""
        self._maybe_prune()  # 기동 시 1회
        while not stop():
            self._maybe_prune()
            try:
                caught_none = self.tick() is None
            except Exception:  # noqa: BLE001 — 고리는 개별 tick 예외로 멈추지 않는다
                _log.exception('tick 처리 중 예외 — 다음 주기로 계속한다')
                caught_none = True
            if caught_none:
                time.sleep(interval_s)

    def _maybe_prune(self) -> None:
        """보관 기간이 지난 이벤트를 치운다. 정리 실패가 실행 고리를 멈추지는 않는다."""
        if self.d.prune is None:
            return
        now = time.monotonic()
        if self._last_prune is not None and now - self._last_prune < self.d.prune_interval_s:
            return
        self._last_prune = now
        try:
            removed = self.d.prune()
        except Exception:  # noqa: BLE001 — 정리 실패는 로그만 남기고 계속 돈다
            _log.exception('이벤트 정리 실패 — 계속 돈다')
            return
        if removed:
            _log.info('오래된 이벤트 %d줄 정리', removed)

    def mark_stage(self, state: object, stage: str) -> None:
        """감독자가 단계에 들어갈 때 부른다 — 결제 진입만 큐에 적는다.

        이 표시가 남은 채로 프로세스가 죽으면 큐가 그 행을 다시 집지 않고 사람에게 넘긴다
        (리뷰 지적 — Critical 2 ①②). 결제 이외 단계는 부수효과가 없어 적지 않는다.
        """
        if stage != 'pay' or not isinstance(state, dict):
            return
        job_id = state.get('job_id')
        if job_id is None:
            return
        self.d.queue.progress(int(job_id), agent='payer', step=PAY_STARTED_STEP)

    def _reset_finished_thread(self, job_id: int) -> None:
        """이 job 의 스레드에 끝난(다음 노드가 없는) 체크포인트만 남아 있으면 지운다.

        중단(승인 대기·비정상 종료)으로 다음 노드가 남아 있으면 건드리지 않는다 — 그 경우는
        _ResumeSafeGraph 가 입력을 무시하고 이어서 돌린다.
        """
        if self.d.reset_thread is None:
            return
        thread_id = f'{THREAD_PREFIX}{job_id}'
        get_state = getattr(self.d.graph, 'get_state', None)
        if callable(get_state):
            try:
                if get_state(self._config(job_id)).next:
                    return
            except Exception:  # noqa: BLE001 — 상태를 못 읽으면 지우지 않는 쪽이 안전하다
                _log.debug('체크포인트 상태를 읽지 못해 스레드를 지우지 않는다: %s', thread_id)
                return
        try:
            self.d.reset_thread(thread_id)
        except Exception:  # noqa: BLE001 — 정리 실패가 실행을 막지는 않는다
            _log.exception('끝난 스레드 정리 실패 — 그대로 진행한다: %s', thread_id)

    def _config(self, job_id: int) -> dict[str, object]:
        return {'configurable': {'thread_id': f'{THREAD_PREFIX}{job_id}'}}

    def _source_of(self, job: Job, arg: object) -> str:
        """추적 메타데이터용 소싱처. 새 실행은 입력 state 에, 재개는 체크포인트에 있다."""
        if isinstance(arg, dict):
            order = arg.get('order')
            if order is not None:
                return str(getattr(order, 'source', '-'))
        get_state = getattr(self.d.graph, 'get_state', None)
        if callable(get_state):
            try:
                values = get_state(self._config(job.id)).values
                return str(getattr(values.get('order'), 'source', '-'))
            except Exception:  # noqa: BLE001 — 추적 메타데이터 때문에 실행을 막지 않는다
                _log.debug('체크포인트에서 소싱처를 읽지 못했다', exc_info=True)
        return '-'

    def _runner(self, job: Job, arg: object) -> Callable[..., object]:
        """그래프 호출을 추적으로 감싼다(리뷰 지적 — I3). events 가 없으면 그대로 부른다."""
        if self.d.events is None:
            return self.d.graph.invoke
        metadata = run_metadata(
            job_id=job.id,
            order_no=job.order_no,
            source=self._source_of(job, arg),
            requester=job.requester,
            agent='supervisor',
            version=self.d.version(),
            env=self.d.env,
            prompt_commit=self.d.prompt_commit,
        )
        return traced('supervisor.run', metadata=metadata, events=self.d.events)(
            self.d.graph.invoke
        )

    def _invoke(self, job: Job, arg: object) -> Job:
        """그래프를 부르고, 예외가 나면 사람에게 넘긴다(스펙 리뷰 지적 — Important 1)."""
        try:
            out = self._runner(job, arg)(arg, self._config(job.id))
        except Exception as exc:  # noqa: BLE001 — 그래프 내부 예외는 감독자가 아니라 여기서 받는다
            return self._on_exception(job, exc)
        return self._apply(job, out)

    def _on_exception(self, job: Job, exc: Exception) -> Job:
        """그래프가 예외를 던지면 큐를 needs_human 으로 마감하고 사유를 남긴다."""
        masked = mask_text(str(exc))
        _log.exception('그래프 실행 중 예외 — %s', job.order_no)
        self.d.queue.progress(job.id, agent=None, step=None)
        self.d.queue.finish(job.id, 'needs_human', error=str(FailReason.UNKNOWN))
        self.d.report(job, f'{job.order_no} 처리 중 오류로 사람에게 넘긴다 — {masked}')
        return self.d.queue.get(job.order_no)  # type: ignore[return-value]

    def _apply(self, job: Job, out: dict) -> Job:
        """그래프 결과를 큐와 슬랙에 옮긴다."""
        interrupts = out.get('__interrupt__') or []
        if interrupts:
            req = interrupts[0].value
            stage = str(req['stage'])
            summary = str(req['summary'])
            order_no = str(req.get('order_no') or job.order_no)
            self.d.queue.progress(job.id, agent=f'approval.{stage}', step=f'승인 대기: {stage}')
            self.d.queue.finish(job.id, 'needs_human')
            if self.d.approval_report is not None:
                self.d.approval_report(job, order_no, stage, summary)
            else:
                # 버튼을 달 통로가 없을 때의 폴백 — 사람이 `@삼바` 명령으로 이어가야 한다
                self.d.report(job, f'승인 요청\n{summary}')
            manual = next(
                (m for m in self.d.manual_approve_methods if m and m.lower() in summary.lower()),
                None,
            )
            if manual and stage == 'pay':
                self.d.report(job, f'수동 승인 필요: {order_no} — 검증 전 결제수단({manual})')
            if self.d.auto_approve and not (manual and stage == 'pay'):
                # 사용자가 자동 이행을 켰다 — 요약을 남긴 채 곧바로 승인해 이어 간다
                self.d.report(job, f'자동 승인: {order_no} {stage}')
                resumed = self.resume(order_no, True, 'auto-approve', stage)
                return resumed if resumed is not None else self.d.queue.get(job.order_no)  # type: ignore[return-value]
            return self.d.queue.get(job.order_no)  # type: ignore[return-value]
        outcome = out['outcome']
        fail = out.get('fail_reason')
        self.d.queue.progress(job.id, agent=None, step=None)
        self.d.queue.finish(job.id, outcome, error=str(fail) if fail else None)
        self.d.report(
            job,
            f'{job.order_no} {outcome}' + (f' — 사유 {fail}' if fail else ' — 완료'),
        )
        if outcome == 'done' and not self.d.dry_run and self.d.after_done is not None:
            try:
                line = self.d.after_done(job, out)
            except Exception as exc:  # noqa: BLE001 — 뒤처리 실패가 끝난 주문을 되돌리지 않는다
                line = f'뒤처리 실패: {mask_text(str(exc))[:120]}'
            if line:
                self.d.report(job, f'{job.order_no} {line}')
        if outcome == 'needs_human' and not self.d.dry_run and not job.options.get(SHIP_RETRY_KEY):
            reason = _failed_reason(out)
            if SHIP_RETRY_MARK in reason:
                # 롯데온 선물: 새 배송지를 저장했는데 목록에 바로 안 보여 멈춘 경우 — 다시 돌리면 저장된 배송지를
                # 기존 항목으로 골라 통과한다(실기 2026-09-30~10-01, 3건 모두 두 번째에 이행). 한 번만 다시 산다
                self.d.queue.finish(job.id, 'failed', error=str(fail) if fail else None)
                self.d.queue.enqueue(
                    job.order_no, job.requester, {**job.options, SHIP_RETRY_KEY: 1}, job.thread_ts
                )
                self.d.report(job, f'{job.order_no} 배송지 저장 뒤 목록 미반영 — 한 번 다시 산다')
                return self.d.queue.get(job.order_no)  # type: ignore[return-value]
        if outcome == 'needs_human' and not self.d.dry_run and not job.options.get('card'):
            reason = _failed_reason(out)
            if KAKAO_FALLBACK_MARK in reason:
                # 카카오페이가 최저가라 결제를 시도하고 PC 알림을 줬지만 폰 비밀번호를 끝내 못 받았다 — 다른 수단으로
                # 사지 않고 삼바 메모만 남긴다. 사람이 카카오페이로 산다(사용자 2026-10-01 "네이버페이 사지 말고 메모만")
                paid = re.search(r'\[카카오페이 ([^\]]+)\]', reason)
                memo = (
                    f'카카오페이 최저가({paid.group(1) if paid else "금액 미확인"}) — 결제 시도·알림했지만 '
                    '폰 비밀번호 미입력. 사람이 카카오페이로 결제해 주세요'
                )
                note = '메모 남김'
                if self.d.add_memo is not None:
                    try:
                        self.d.add_memo(job.order_no, memo)
                    except Exception as exc:  # noqa: BLE001 — 메모 실패가 작업 결과를 바꾸지 않는다
                        note = f'메모 실패: {mask_text(str(exc))[:80]}'
                self.d.report(job, f'{job.order_no} 카카오페이 최저가·비밀번호 미입력 — {note}(사람이 결제)')
                return self.d.queue.get(job.order_no)  # type: ignore[return-value]
        export_alert = _export_alert(out)
        if export_alert is not None:
            self.d.report(job, mask_text(f'{job.order_no} 외부 기입 {export_alert}')[:200])
        if fail and outcome != 'done' and self.d.flag_order is not None and not self.d.dry_run:
            reason = _failed_reason(out)
            if str(fail) in (str(FailReason.OUT_OF_STOCK), str(FailReason.MARGIN)):
                # 품절·마진 미달: 페이지에서 확인한 근거(확정 품절 문구, 주문서 원가·마진)가 있으면 그 근거를 메모에 적고
                # 바로 취소중으로 돌린다(사용자 2026-09-29 "멈춘 주문 자동 처리"). 근거가 없거나 포이즌이면 예전처럼
                # 사람이 본다(사용자 2026-09-28: 근거 없는 취소 금지)
                kind = '재고X' if str(fail) == str(FailReason.OUT_OF_STOCK) else '가격X'
                evidence = auto_cancel_evidence(
                    out.get('order'), str(fail), reason, _buy_payload(out), time.strftime('%m/%d %H:%M')
                )
                if evidence:
                    flagged = self.d.flag_order(job.order_no, str(fail), evidence)
                    self.d.report(job, f'{job.order_no} {kind} 자동 취소중 — {flagged or "결과 없음"}')
                else:
                    self.d.report(job, f'{job.order_no} {kind} 보류 — 검수 필요({mask_text(reason)[:80]})')
            else:
                flagged = self.d.flag_order(job.order_no, str(fail))
                if flagged:
                    self.d.report(job, f'{job.order_no} {flagged}')
        return self.d.queue.get(job.order_no)  # type: ignore[return-value]


def _export_alert(out: dict) -> str | None:
    """exporter 결과가 conflict·error 면 '{상태}: {사유}', 아니면 None.

    ``out['results']`` 는 ``AgentResult`` 객체지만 체크포인트를 거치면 dict 로 올 수도
    있다(``_failed_reason`` 과 같은 이유) — 둘 다 받는다.
    """
    result = (out.get('results') or {}).get('exporter')
    if result is None:
        return None
    if isinstance(result, dict):
        payload = result.get('payload') or {}
        reason = result.get('reason')
    else:
        payload = result.payload
        reason = result.reason
    status = payload.get('export')
    if status not in ('conflict', 'error'):
        return None
    return f'{status}: {reason or ""}'


def _buy_payload(out: dict) -> dict[str, object] | None:
    """구매 에이전트 결과의 payload(원가·마진·계정·수단). 없으면 None."""
    for name, r in (out.get('results') or {}).items():
        if not str(name).startswith('buyer'):
            continue
        payload = getattr(r, 'payload', None) if not isinstance(r, dict) else r.get('payload')
        if isinstance(payload, dict) and payload.get('cost') is not None:
            return payload
    return None


def _failed_reason(out: dict) -> str:
    """그래프 결과에서 실패한 에이전트의 사유 글자(없으면 빈 문자열)."""
    for r in (out.get('results') or {}).values():
        status = getattr(r, 'status', None) if not isinstance(r, dict) else r.get('status')
        if status and status != 'ok':
            reason = getattr(r, 'reason', None) if not isinstance(r, dict) else r.get('reason')
            return str(reason or '')
    return ''
