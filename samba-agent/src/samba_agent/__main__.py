"""`python -m samba_agent` — 실행 진입점. 배선만 한다(새 로직 없음, 스펙 §10-2).

순서: 설정 로딩 → 추적 설정 → 큐·등록부·브릿지·에이전트·그래프(gate=True) → 봇 → API.
`Worker.run_forever` 와 API 서버는 데몬 스레드로, `SambaBot.start()` 는 주 스레드에서 돈다.
"""

import functools
import json
import logging
import signal
import sqlite3
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from langgraph.checkpoint.sqlite import SqliteSaver
from slack_bolt import App

from samba_agent.agents.buyer import BuyerAgent
from samba_agent.agents.factory import build_agents
from samba_agent.agents.payer import PayerAgent
from samba_agent.agents.recorder import RecorderAgent
from samba_agent.agents.registry import Registry
from samba_agent.agents.verifier import VerifierAgent
from samba_agent.api.server import build_app, serve
from samba_agent.bridge.client import BridgeClient, BridgeError
from samba_agent.export.notify import ExportNotifier
from samba_agent.export.routing import ExportRouting
from samba_agent.export.stage import (
    ExportFn,
    make_cancel_exporter,
    make_exporter,
    make_lookup_requester,
)
from samba_agent.export.store import ExportQueue
from samba_agent.gateway.slack_bot import SambaBot
from samba_agent.llm.decide import make_decide
from samba_agent.ops.dewu_order import make_shihuo_handler
from samba_agent.ops.diagnose import diagnose
from samba_agent.ops.events import EventLog
from samba_agent.ops.masking import mask_text
from samba_agent.ops.releases import ReleaseStore
from samba_agent.ops.site_scripts import install_missing
from samba_agent.ops.ssg_gift_accept import make_after_done
from samba_agent.ops.tracing import configure_tracing
from samba_agent.queue.db import Job, JobQueue
from samba_agent.queue.intake import Intake
from samba_agent.queue.orders import LOOKUP_TOOLS, parse_order_fn
from samba_agent.queue.tabs import TAB_TOOLS, TabJanitor
from samba_agent.queue.worker import Worker, WorkerDeps
from samba_agent.repair import (
    FileScriptSource,
    ScriptHistory,
    ScriptRepairer,
    app_supports_pay_guard,
)
from samba_agent.settings import Settings, load_settings
from samba_agent.supervisor.graph import build_supervisor
from samba_agent.version import harness_version
from samba_agent.wave.client import WaveClient
from samba_agent.wave.flags import FlagMarker

log = logging.getLogger(__name__)

# 하네스가 결과를 기다리지 않는 외부 프로그램 — 사람이 PC 를 쓰지 않을 때만 만진다
EXPORT_DEFERRED = ('emp',)

ReportFn = Callable[[Job, str], None]
ApprovalReportFn = Callable[[Job, str, str, str], None]


def make_reporters(get_bot: 'Callable[[], SambaBot]') -> tuple[ReportFn, ApprovalReportFn]:
    """실행기가 쓸 보고 통로 두 개(진행 보고 · 승인 요청)를 만든다.

    승인 요청은 반드시 버튼이 달린 경로로 나가야 한다 — 버튼이 없으면 사람이 승인할 방법이
    없어 결제·기록 단계가 영구 정지한다(리뷰 지적 — Critical 1). 봇은 나중에 만들어지므로
    콜러블로 받아 호출 시점에 푼다.
    """

    def report(job: Job, line: str) -> None:
        if not get_bot().post(job.thread_ts, line):
            log.info('%s', mask_text(line))

    def approval_report(job: Job, order_no: str, stage: str, summary: str) -> None:
        if not get_bot().post_approval(job.thread_ts, order_no, stage, summary):
            log.info('승인 요청(슬랙 없음) %s %s\n%s', order_no, stage, mask_text(summary))

    return report, approval_report


def make_wave(settings: 'Settings') -> WaveClient | None:
    """삼바웨이브 내부 API 클라이언트. 토큰·테넌트가 둘 다 있어야 만든다(값은 로그에 남기지 않는다)."""
    if not (settings.wave_internal_token and settings.wave_tenant_id):
        return None
    return WaveClient(
        settings.wave_url,
        settings.wave_internal_token.get_secret_value(),
        settings.wave_tenant_id,
    )


def make_export(settings: 'Settings') -> tuple[ExportQueue, ExportFn] | None:
    """외부 기입 큐와 export 단계 함수. 꺼져 있으면 None — 그래프에 export 노드가 붙지 않는다."""
    if not settings.export_enabled:
        return None
    queue = ExportQueue(settings.export_db_path)
    routing = ExportRouting.load(settings.export_routing_file)
    return queue, make_exporter(
        queue, routing, wait_s=settings.export_wait_s, deferred=EXPORT_DEFERRED
    )


def _alipay_approve(bridge: BridgeClient) -> Callable[[int], str]:
    """알리페이 결제창 비밀번호 — 앱의 phone_approve_payment(provider='alipay')가 키마스터에서 넣는다."""

    def approve(amount_krw: int) -> str:
        try:
            return bridge.call(
                'phone_approve_payment',
                provider='alipay',
                amountKrw=max(int(amount_krw), 1),
                merchant='得物',
                methodLabel='알리페이',
            ).result
        except BridgeError as e:
            return f'refused: {e}'

    return approve


def make_cancel_export(
    settings: 'Settings', wave: WaveClient
) -> Callable[[str], str | None] | None:
    """취소중으로 바꾼 주문을 샵마인·EMP 에도 알리는 함수. 외부 기입이 꺼져 있으면 None."""
    if not settings.export_enabled:
        return None
    queue = ExportQueue(settings.export_db_path)
    routing = ExportRouting.load(settings.export_routing_file)
    return make_cancel_exporter(
        queue,
        routing,
        lambda order_no: wave.get_order(order_no).seller,
        wait_s=settings.export_wait_s,
        deferred=EXPORT_DEFERRED,
    )


def make_lookup(settings: 'Settings') -> Callable[[str, str | None], str | None] | None:
    """소싱처 미등록 주문의 판매자상품코드 읽기를 큐에 넣는 함수. 꺼져 있으면 None."""
    if not (settings.export_enabled and settings.link_by_seller_code):
        return None
    queue = ExportQueue(settings.export_db_path)
    return make_lookup_requester(queue, ExportRouting.load(settings.export_routing_file))


def make_linker(wave: WaveClient) -> Callable[[str, str], str]:
    """읽어 온 수집상품 번호로 주문을 잇고 결과 한 줄을 돌려준다. 이어지면 다음 수집 때 주문이 들어온다."""

    def link(order_no: str, collected_product_id: str) -> str:
        out = wave.link_collected(order_no, collected_product_id)
        return (
            f'{order_no} 소싱처 미등록 → 수집상품 {collected_product_id} 에 연결'
            f'({out.get("source_url") or "주소 없음"}) — 다음 수집 때 처리한다'
        )

    return link


def _bridge_ready(bridge: BridgeClient) -> bool:
    """브릿지 /health 가 200 이면 참. busy(409)·연결 실패는 거짓 — 작업을 실패시키지 말고 기다린다."""
    try:
        bridge.health()
    except BridgeError as e:
        log.info('브릿지 대기: %s', e)
        return False
    return True


def main() -> None:
    settings = load_settings()
    # 시각을 붙인다 — 도구 호출 사이 간격으로 어느 단계가 느린지 잰다(2026-09-26 주문 1건 수 분 문제)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s.%(msecs)03d %(levelname)s:%(name)s:%(message)s', datefmt='%H:%M:%S')
    configure_tracing(settings)

    reg = Registry.load(settings.root)
    queue = JobQueue(settings.db_path)
    releases = ReleaseStore(settings.root / 'releases.sqlite')
    events = EventLog(settings.root / 'events.sqlite')

    bridge = BridgeClient(
        settings.bridge_url,
        settings.bridge_token.get_secret_value(),
        allowed=(),  # 최상위 클라이언트는 도구를 직접 부르지 않는다 — 에이전트마다 scoped() 로 좁힌다
        # 앱 채팅이 도는 동안(409 busy) 작업 중간에 실패하지 않도록 최대 10분 기다린다(실기: 3초 만에 bridge_down)
        busy_retries=120,
        busy_wait_s=5.0,
    )
    # 주문 조회 = 삼바웨이브 탭 앞에 두기(list_tabs·switch_tab·new_tab·wait) + 저장 스크립트 1회
    lookup_bridge = bridge.scoped(list(LOOKUP_TOOLS))

    # 저장소의 스크립트 묶음 중 앱에 없는 것을 넣는다 — 앱이 아직 안 떴으면 건너뛰고 다음 시작 때 다시 본다
    def _install_scripts() -> None:
        try:
            added = install_missing(settings.bridge_token.get_secret_value(), settings.bridge_url)
        except Exception as e:  # noqa: BLE001 — 스크립트 설치 실패가 하네스 시작을 막으면 안 된다
            log.warning('사이트 스크립트 자동 설치를 건너뛴다: %s', e)
            return
        if added:
            log.info('사이트 스크립트 %d개를 앱에 넣었다(저장소 묶음)', added)

    threading.Thread(target=_install_scripts, name='site-scripts', daemon=True).start()

    # 삼바웨이브 내부 API — 토큰·테넌트가 둘 다 있을 때만 만든다. 없으면 앱 저장 스크립트로 돈다
    wave = make_wave(settings)
    if wave is None:
        log.warning('삼바웨이브 내부 API 설정이 없다 — 조회·기록·검증은 앱 저장 스크립트로 돈다')

    # 모델명은 settings 에 없다 — llm.decide 의 상수(claude-sonnet-5) 를 그대로 쓴다
    decide = make_decide()

    # 이행하지 못한 주문의 가격X·재고X 표시 — 삼바웨이브 API 로 태그를 읽고 앱 저장 스크립트로 버튼을 누른다
    flag_bridge = bridge.scoped(['run_script'])
    flagger = (
        FlagMarker(
            wave,
            lambda name, args: flag_bridge.call(
                'run_script', name=name, args=json.dumps(args, ensure_ascii=False)
            ).result,
            on_cancelled=make_cancel_export(settings, wave),
        )
        if wave is not None
        else None
    )

    # 조회 통로: 삼바웨이브 API 우선, 실패하면 앱 저장 스크립트
    _parse_order = parse_order_fn(wave, lookup_bridge)

    def _source_sku_of(job: Job) -> tuple[str, str]:
        order = _parse_order(job.order_no, job.options)
        return order.source, order.sku

    agents = build_agents(reg, bridge, decide, wave, settings.compare_accounts_max)
    repair_on = settings.repair_enabled
    if repair_on and not app_supports_pay_guard(bridge.scoped(['run_js'])):
        # 앱이 run_js safety:no_pay(결제 버튼 클릭 차단)를 모르면 AI 수리를 켜지 않는다 — 예전 앱은 이 값을
        # 조용히 무시해 가드 없이 돈다(2026-09-24 실결제 사고). 앱을 재시작하면 켜진다
        log.warning(
            '앱이 결제 버튼 차단(safety no_pay)을 지원하지 않아 AI 스크립트 수리를 끈다 — 앱 재시작 필요'
        )
        repair_on = False
    if repair_on:
        # 스크립트 자가 수리 — 구매 에이전트가 저장 스크립트 실패를 AI 로 고쳐 이어 간다
        repairer = ScriptRepairer(model=settings.repair_model, timeout_s=settings.repair_timeout_s)
        script_source = FileScriptSource(settings.site_scripts_file)
        script_history = ScriptHistory(settings.root / 'script-history')
        for agent in agents.values():
            if isinstance(agent, BuyerAgent | PayerAgent | RecorderAgent | VerifierAgent):
                agent.repairer = repairer
                agent.script_source = script_source
                agent.script_history = script_history
    if bridge.supports_lanes():
        # 앱이 레인을 알면 계정 비교를 동시에 돌린다(모르면 예전처럼 순서대로 — 한 탭을 서로 건드린다)
        for agent in agents.values():
            if isinstance(agent, BuyerAgent):
                agent.parallel_accounts = True
        log.info('앱이 레인을 지원한다 — 계정 비교를 동시에 돌린다')
    else:
        log.warning('앱이 레인을 모른다 — 계정 비교를 순서대로 돌린다(앱 재시작 필요)')
    allowed_pay = {x.strip() for x in settings.allowed_pay_providers.split(',') if x.strip()}
    if allowed_pay:
        # 결제에 쓸 수 있는 수단을 좁힌다(사용자 설정) — 구매 에이전트의 결제수단 견적이 이 안에서만 고른다
        for agent in agents.values():
            if hasattr(agent, 'allowed_pay_providers'):
                agent.allowed_pay_providers = allowed_pay

    version_fn = functools.partial(harness_version, settings.root, {})
    # from_conn_string 은 컨텍스트 매니저라 __enter__ 만 꺼내 쓰면 매니저가 버려지는 순간 연결이 닫힌다
    # (실기: "Cannot operate on a closed database"). 연결을 직접 열어 프로세스가 사는 동안 유지한다.
    # 워커 스레드와 봇 스레드가 같이 쓰므로 스레드 제약을 푼다(SqliteSaver 는 내부 잠금으로 직렬화)
    checkpointer = SqliteSaver(
        sqlite3.connect(str(settings.root / 'checkpoints.sqlite'), check_same_thread=False)
    )

    # 결제 진입 표시를 큐에 남기려면 실행기가 필요하다 — 아래에서 만들고 콜백으로 잇는다
    def _record_agent(
        state: dict, stage: str, agent: str, result: object, duration_ms: int, attempt: int
    ) -> None:
        """에이전트 1회 실행 → kind='agent' 이벤트. ops.diagnose 가 이 종류만 집계한다."""
        status = str(getattr(result, 'status', ''))
        fail_reason = getattr(result, 'fail_reason', None)
        # 교차 비교(SSG ↔ H몰 등) 결론 — 근거는 체크포인트에만 있어 이벤트로는 어느 쪽을 왜 골랐는지 못 봤다(job 258)
        cross = [
            mask_text(str(getattr(e, 'detail', '')))[:200]
            for e in getattr(result, 'evidence', ()) or ()
            if getattr(e, 'label', '') == '교차 비교'
        ][:4]
        events.write(
            job_id=int(state.get('job_id', 0)),
            version=version_fn(),
            env=settings.harness_env,
            agent=agent,
            kind='agent',
            payload={
                'step': stage,
                'ok': status == 'ok',
                'status': status,
                'fail_reason': str(fail_reason) if fail_reason else None,
                'duration_ms': duration_ms,
                'retries': attempt - 1,
                'order_no': str(getattr(state.get('order'), 'order_no', '')),
                'reason': mask_text(str(getattr(result, 'reason', '')))[:200],
                **({'cross': cross} if cross else {}),
            },
        )

    export = make_export(settings)
    if export is None:
        log.info('외부 기입(EMP·샵마인)은 꺼져 있다 — SAMBA_EXPORT_ENABLED')

    graph = build_supervisor(
        reg,
        agents,
        checkpointer=checkpointer,
        gate=True,
        on_stage_start=lambda state, stage: worker.mark_stage(state, stage),
        on_agent_result=_record_agent,
        exporter=export[1] if export is not None else None,
    )

    _report, _approval_report = make_reporters(lambda: bot)

    worker = Worker(
        WorkerDeps(
            queue=queue,
            graph=graph,
            version=version_fn,  # 콜러블 그대로 넘긴다 — tick 마다 다시 불러 규칙 변경을 반영한다
            report=_report,
            parse_order=lambda job: _parse_order(job.order_no, job.options),
            # 같은 주문을 취소 뒤 다시 접수하면 job id(=스레드)가 같다 — 끝난 실행의 attempts·results 가
            # 남은 채 새 입력이 들어가면 재시도 횟수가 이어져 버린다(실기). 끝난 스레드는 지우고 시작한다
            reset_thread=checkpointer.delete_thread,
            approval_report=_approval_report,
            dry_run=settings.dry_run,
            dry_run_digits=settings.dry_run_digits,
            keep_tabs=settings.keep_tabs,
            auto_approve=settings.auto_approve,
            manual_approve_methods=tuple(
                x.strip() for x in settings.manual_approve_methods.split(',') if x.strip()
            ),
            # 관측 배선 — 실행 1건이 LangSmith span + 로컬 이벤트로 남는다(리뷰 지적 — I3)
            events=events,
            env=settings.harness_env,
            prompt_commit=settings.prompt_commit,
            prune=events.prune,
            # 작업이 연 탭은 끝날 때 닫는다 — 옛 주문서 탭을 다음 작업이 읽던 문제(실기)
            tabs=TabJanitor(bridge.scoped(list(TAB_TOOLS))),
            # 앱 채팅이 도는 동안(409 busy)·앱이 꺼진 동안은 큐를 집지 않는다
            ready=lambda: _bridge_ready(bridge),
            flag_order=flagger.mark if flagger is not None else None,
            add_memo=wave.add_memo if wave is not None else None,
            # SSG 선물 주문은 결제 뒤 폰 카카오톡에서 선물을 받아야 발송된다(사용자 2026-10-01 하네스 이식)
            after_done=make_after_done(_source_sku_of),
            # 중국 크림(식화) 주문은 폰 得物 앱으로 산다 — 알리페이 비밀번호는 앱 폰 결제 도구가 키마스터에서 넣는다
            phone_sources=(
                {'SHIHUO': make_shihuo_handler(wave, _alipay_approve(bridge))} if wave is not None else {}
            ),
            sources=frozenset(
                x.strip().upper() for x in settings.intake_sources.split(',') if x.strip()
            ),
        )
    )

    def _diagnose_text(version: str | None) -> str:
        v = version or version_fn()
        return diagnose(events, version=v).to_markdown()

    slack_app: App | None = None
    if settings.slack_bot_token and settings.slack_app_token:
        slack_app = App(token=settings.slack_bot_token.get_secret_value())

    bot = SambaBot(slack_app, worker, queue, settings, _diagnose_text)

    # 자동 수집 — 삼바웨이브 클라이언트가 있고 켜져 있을 때만 돈다. 슬랙이 없으면 스레드 없이 큐에만 쌓인다
    intake: Intake | None = None
    if wave is not None and settings.intake_enabled:
        intake = Intake(
            wave,
            queue,
            reg,
            bot.post_new,
            bot.post,
            days=settings.intake_days,
            max_new=settings.intake_max_new,
            sources=frozenset(x.strip() for x in settings.intake_sources.split(',') if x.strip()),
            poison_only=settings.intake_poison_only,
            all_sellers_sources=frozenset(
                x.strip() for x in settings.intake_all_sellers_sources.split(',') if x.strip()
            ),
            # 이행 불가(소싱처 상품 삭제) — 재고X 표시 + 취소요청
            on_unfulfillable=flagger.mark if flagger is not None else None,
            # 소싱처를 추정도 못 한 주문 — 샵마인·EMP 에서 판매자상품코드를 읽어 온다
            on_unlinked=make_lookup(settings),
        )
        bot.intake = intake

    app = build_app(
        reg=reg,
        queue=queue,
        releases=releases,
        root=settings.root,
        version=version_fn,
        report_dir=settings.report_dir,
        # 슬랙이 없을 때 사람이 승인을 넣는 경로(POST /approve) — 슬랙 버튼과 같은 worker.resume
        approve=worker.resume,
    )

    # 이벤트 하나로 통일한다(리뷰 지적 — Minor) — SIGINT/SIGTERM 이 이걸 세우면
    # 워커 고리와(봇 없을 때의) 대기가 함께 풀린다.
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_a: stop.set())
    signal.signal(signal.SIGTERM, lambda *_a: stop.set())

    worker_thread = threading.Thread(
        target=worker.run_forever, args=(stop.is_set,), daemon=True, name='worker'
    )
    api_thread = threading.Thread(target=serve, args=(app,), daemon=True, name='api')
    worker_thread.start()
    api_thread.start()

    if export is not None:
        # 실패한 외부 기입을 그 주문의 슬랙 스레드에 알린다(입력 작업자는 큐에 결과만 적는다)
        def _thread_of(order_no: str) -> str | None:
            job = queue.get(order_no)
            return job.thread_ts if job is not None else None

        notifier = ExportNotifier(
            export[0],
            _thread_of,
            lambda ts, text: bot.post(ts, text),
            post_new=bot.post_new,
            done_targets=[
                *(t for d in EXPORT_DEFERRED for t in (d, f'{d}_cancel')),
                *(('shopmine_lookup', 'emp_lookup') if settings.link_by_seller_code else ()),
            ],
            link=make_linker(wave) if settings.link_by_seller_code and wave is not None else None,
            # 하네스가 다시 떠도 하루 안의 결과는 알린다 — 알린 것은 표시가 남아 되풀이하지 않는다
            since=(datetime.now(UTC) - timedelta(days=1)).isoformat(timespec='seconds'),
        )
        threading.Thread(
            target=notifier.run_forever, args=(stop.is_set,), daemon=True, name='export-notify'
        ).start()

    if intake is not None:
        threading.Thread(
            target=intake.run_forever,
            args=(stop.is_set, float(settings.intake_interval_s)),
            daemon=True,
            name='intake',
        ).start()
    else:
        log.warning('자동 수집을 띄우지 않는다 — 삼바웨이브 설정이 없거나 꺼져 있다')

    if slack_app is not None:
        # start() 안에서 Socket Mode 핸들러를 직접 띄운다 — 여기서 또 띄우지 않는다(리뷰 지적 — Minor)
        bot.start()
    else:
        log.warning('슬랙 토큰이 없다 — 봇 없이 큐/API 만 돈다')
        stop.wait()


if __name__ == '__main__':
    main()
