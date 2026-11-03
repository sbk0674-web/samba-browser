"""감독자 그래프 — 구매 → 결제 → 기록 → 검증 순으로 넘기고 결과를 검사한다.

각 단계는 노드 하나다. 노드는 등록부에서 에이전트를 고르고(코드 배정),
`agents` 에 등록된 함수를 부르고, 결과를 검사해 다음 단계로 갈지 사람에게 넘길지 정한다.
"""

import logging
import time
from collections.abc import Callable, Mapping

from langgraph.graph import END, StateGraph
from langgraph.types import Command, interrupt

from samba_agent.agents.contracts import AgentResult
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeError
from samba_agent.failures import FailReason
from samba_agent.supervisor.approval import approval_request
from samba_agent.supervisor.assign import build_assignment
from samba_agent.supervisor.policy import KIND_OF_STAGE, STAGES, check_buyer, should_retry
from samba_agent.supervisor.state import RunState, sanitize_result

_log = logging.getLogger(__name__)

AgentFn = Callable[..., AgentResult]

# 사람 승인 없이는 들어가지 않는 단계 — 돈이 나가는 결제 하나뿐이다(계획 Task D).
# 기록은 삼바웨이브 우리 DB 에 소싱주문번호를 적는 것이라 되돌릴 수 있고, 매 건 승인을 받으면
# 자동 수집이 사람 손에 다시 묶인다. 잘못 적힌 값은 검증 단계가 잡는다
EXTERNAL_STAGES = ('pay',)
# 단계 진입을 밖(큐)에 알리는 콜백. 결제 진입 표시를 큐에 남겨 재시작 재결제를 막는다
StageHook = Callable[[RunState, str], None]


def _stop(state: RunState, name: str, result: AgentResult) -> RunState:
    """사람에게 넘기고 멈춘다."""
    results = {**state.get('results', {}), name: sanitize_result(result)}
    # 불변조건: status != 'ok' 인 AgentResult 는 fail_reason 이 반드시 있다
    # (AgentResult._check_fail_reason 모델 검증기가 보장한다). None 폴백은 필요 없다.
    return {
        **state,
        'results': results,
        'stage': 'done',
        'outcome': 'needs_ai',
        'fail_reason': result.fail_reason,
    }


# 에이전트 1회 실행 결과 훅 — (state, stage, 에이전트 이름, 결과, 소요 ms, 몇 번째 시도)
AgentResultHook = Callable[[RunState, str, str, AgentResult, int, int], None]


def _run_stage(
    reg: Registry,
    agents: Mapping[str, AgentFn],
    stage: str,
    state: RunState,
    on_agent_result: 'AgentResultHook | None' = None,
) -> RunState:
    """한 단계 — 배정 → 실행 → 검사 → (필요하면) 재시도 1회.

    실행(재시도 포함) 한 번마다 ``on_agent_result`` 를 부른다 — 진단 표(ops.diagnose)는
    에이전트·단계별 실패율·재시도·소요를 이 기록으로 만든다. 훅 오류가 실행을 막지는 않는다.
    """
    spec = reg.pick(KIND_OF_STAGE[stage], state['order'], state.get('options', {}))
    if spec is None:
        return _stop(
            state,
            'supervisor',
            AgentResult(
                status='needs_ai',
                reason=f'unsupported: {state["order"].source} 를 맡을 {stage} 에이전트가 없다',
                fail_reason=FailReason.UNKNOWN,
            ),
        )
    fn = agents.get(spec.name)
    if fn is None:
        return _stop(
            state,
            spec.name,
            AgentResult(
                status='needs_ai',
                reason=f'등록부에 있으나 구현이 없다: {spec.name}',
                fail_reason=FailReason.UNKNOWN,
            ),
        )
    attempts = dict(state.get('attempts', {}))
    while True:
        attempts[spec.name] = attempts.get(spec.name, 0) + 1
        started = time.monotonic()
        try:
            result = fn(build_assignment(reg, spec, state))
        except BridgeError as e:
            result = AgentResult(status='fail', reason=f'브릿지 오류: {e}', fail_reason=e.reason)
        if stage == 'buy':
            result = check_buyer(result, state['order'].seller)
        if on_agent_result is not None:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            try:
                on_agent_result(state, stage, spec.name, result, elapsed_ms, attempts[spec.name])
            except Exception:  # noqa: BLE001 — 기록 실패가 주문 처리를 막으면 안 된다
                _log.exception('에이전트 결과 기록 실패 — 계속한다: %s', spec.name)
        if result.status == 'ok':
            break
        if should_retry(spec, result, attempts[spec.name]):
            continue
        return _stop({**state, 'attempts': attempts}, spec.name, result)
    result = sanitize_result(result)
    return {
        **state,
        'results': {**state.get('results', {}), spec.name: result},
        'attempts': attempts,
        'evidence': [*state.get('evidence', []), *result.evidence],
        'stage': stage,
    }


# 외부 기입 결과가 state 에 담기는 이름
EXPORTER_NAME = 'exporter'
# export 노드 함수 — 검증까지 끝난 state 를 받아 결과 하나를 돌려준다
ExportFn = Callable[[RunState], AgentResult]


def _run_export(
    exporter: ExportFn,
    state: RunState,
    on_agent_result: 'AgentResultHook | None' = None,
) -> RunState:
    """외부 기입 — 주문 결과를 바꾸지 않는다.

    결제·기록·검증이 끝난 주문이다. 외부 프로그램 기입이 실패하거나 예외가 나도 outcome 은
    건드리지 않는다 — 여기서 멈추면 이미 산 주문이 사람 대기로 남는다.
    """
    started = time.monotonic()
    try:
        result = exporter(state)
    except Exception:  # noqa: BLE001 — 외부 기입 오류가 주문 처리를 막으면 안 된다
        _log.exception('외부 기입 요청 실패 — 주문은 완료로 둔다')
        result = AgentResult(
            status='ok',
            reason='외부 기입 요청 중 오류 — 주문은 완료로 둔다',
            payload={'export': 'error'},
        )
    if result.status != 'ok':
        # 계약 위반(export 는 항상 ok 를 돌려준다) — 주문을 멈추지 않고 사유만 남긴다
        result = AgentResult(
            status='ok',
            reason=f'외부 기입 결과 이상 — {result.reason}',
            payload={'export': 'error'},
            evidence=result.evidence,
        )
    if on_agent_result is not None:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        try:
            on_agent_result(state, 'export', EXPORTER_NAME, result, elapsed_ms, 1)
        except Exception:  # noqa: BLE001 — 기록 실패가 주문 처리를 막으면 안 된다
            _log.exception('에이전트 결과 기록 실패 — 계속한다: %s', EXPORTER_NAME)
    result = sanitize_result(result)
    return {
        **state,
        'results': {**state.get('results', {}), EXPORTER_NAME: result},
        'evidence': [*state.get('evidence', []), *result.evidence],
    }


def _finish(state: RunState) -> RunState:
    """끝. 이미 멈춘 상태면 그대로 두고, 아니면 done."""
    if state.get('outcome') is not None:
        return {**state, 'stage': 'done'}
    return {**state, 'stage': 'done', 'outcome': 'done', 'fail_reason': None}


class _ResumeSafeGraph:
    """체크포인터가 있을 때, 같은 스레드로 평범한 입력을 다시 넣어도 처음부터 다시 돌지 않게 막는다.

    LangGraph 는 진행 중(중단 포함)인 스레드에 dict 입력을 다시 주면 그 입력으로 새로
    시작해버린다. 승인 대기 중에 같은 요청이 중복으로 들어와도(예: 재시도 큐, 재배포) 이미 한
    구매·결제를 다시 돌리지 않도록, 대기 중인 스레드에는 입력을 무시하고 그냥 재개한다.

    invoke 뿐 아니라 stream·ainvoke·astream 도 같은 진입점이다 — 하나만 감싸면 나머지
    경로로 같은 스레드를 다시 부를 때(예: `.stream()` 두 번) 중복 실행이 그대로 샌다.
    `get_state`/`aget_state` 는 LangGraph 공개 API 다(비공개 아님).
    """

    def __init__(self, compiled: object) -> None:
        self._compiled = compiled

    def _resume_in_place(self, input_: object, config: object | None) -> bool:
        if config is None or isinstance(input_, Command) or input_ is None:
            return False
        snapshot = self._compiled.get_state(config)  # type: ignore[attr-defined]
        return bool(snapshot.next)

    async def _aresume_in_place(self, input_: object, config: object | None) -> bool:
        if config is None or isinstance(input_, Command) or input_ is None:
            return False
        snapshot = await self._compiled.aget_state(config)  # type: ignore[attr-defined]
        return bool(snapshot.next)

    def invoke(self, input_: object, config: object | None = None, **kwargs: object) -> object:
        if self._resume_in_place(input_, config):
            input_ = None
        return self._compiled.invoke(input_, config, **kwargs)  # type: ignore[attr-defined]

    def stream(self, input_: object, config: object | None = None, **kwargs: object) -> object:
        if self._resume_in_place(input_, config):
            input_ = None
        return self._compiled.stream(input_, config, **kwargs)  # type: ignore[attr-defined]

    async def ainvoke(
        self, input_: object, config: object | None = None, **kwargs: object
    ) -> object:
        if await self._aresume_in_place(input_, config):
            input_ = None
        return await self._compiled.ainvoke(input_, config, **kwargs)  # type: ignore[attr-defined]

    async def astream(self, input_: object, config: object | None = None, **kwargs: object):
        if await self._aresume_in_place(input_, config):
            input_ = None
        async for chunk in self._compiled.astream(input_, config, **kwargs):  # type: ignore[attr-defined]
            yield chunk

    def __getattr__(self, name: str) -> object:
        return getattr(self._compiled, name)


def build_supervisor(
    reg: Registry,
    agents: Mapping[str, AgentFn],
    *,
    checkpointer: object | None = None,
    gate: bool = False,
    on_stage_start: 'StageHook | None' = None,
    on_agent_result: 'AgentResultHook | None' = None,
    exporter: 'ExportFn | None' = None,
):
    """감독자 그래프를 만든다. agents 는 이름 → 함수(실제 에이전트 또는 테스트용 가짜).

    exporter 를 주면 검증 뒤에 외부 기입 노드가 붙는다(verify → export → finish).
    """
    if gate and checkpointer is None:
        raise ValueError('게이트를 쓰려면 체크포인터가 필요하다')

    graph: StateGraph = StateGraph(RunState)

    def make(stage: str) -> Callable[[RunState], RunState]:
        def node(state: RunState) -> RunState:
            if state.get('outcome') is not None:
                return state
            # 결제 노드 재진입 — 재시작이든 중복 재개든 폰 승인이 이미 나갔을 수 있다.
            # 여기서 payer 를 다시 부르면 결제 2회다(리뷰 지적 — Critical 2 ②)
            if stage == 'pay' and state.get('pay_started'):
                return _stop(
                    state,
                    'payer',
                    AgentResult(
                        status='needs_ai',
                        reason='결제 진행 중 재시작 — 결제 여부를 사람이 확인한다(재결제 금지)',
                        fail_reason=FailReason.PAY_INTERRUPTED,
                    ),
                )
            # 외부를 바꾸는 단계는 여기서 멈춘다. 슬랙 승인 버튼이 Command(resume=...) 로 깨운다
            if gate and stage in EXTERNAL_STAGES:
                answer = interrupt(approval_request(stage, state).as_dict())
                by = str(answer.get('by', '')) if isinstance(answer, dict) else ''
                approved = bool(answer.get('approved')) if isinstance(answer, dict) else False
                if not approved:
                    return _stop(
                        state,
                        f'approval.{stage}',
                        AgentResult(
                            status='needs_ai',
                            reason=f'{stage} 단계를 사용자가 승인하지 않았다',
                            fail_reason=FailReason.PERMISSION_DENIED,
                        ),
                    )
                state = {**state, 'approvals': {**state.get('approvals', {}), stage: by}}
            if stage == 'pay':
                # 승인이 끝난 뒤, payer 를 부르기 전에 먼저 적는다 — 체크포인트와 큐 양쪽에
                state = {**state, 'pay_started': True}
            if on_stage_start is not None:
                on_stage_start(state, stage)
            return _run_stage(reg, agents, stage, state, on_agent_result)

        return node

    for stage in STAGES:
        graph.add_node(stage, make(stage))
    graph.add_node('finish', _finish)
    # 마지막 단계 다음 — 외부 기입이 있으면 거쳐 가고, 없으면 바로 끝낸다
    after_last = 'finish'
    if exporter is not None:

        def export_node(state: RunState) -> RunState:
            if state.get('outcome') is not None:
                return state
            return _run_export(exporter, state, on_agent_result)

        graph.add_node('export', export_node)
        graph.add_edge('export', 'finish')
        after_last = 'export'
    graph.set_entry_point(STAGES[0])
    for i, stage in enumerate(STAGES):
        nxt = STAGES[i + 1] if i + 1 < len(STAGES) else after_last
        graph.add_conditional_edges(
            stage,
            lambda s, nxt=nxt: 'finish' if s.get('outcome') is not None else nxt,
            {nxt: nxt, 'finish': 'finish'},
        )
    graph.add_edge('finish', END)
    if checkpointer:
        checkpointer = _with_pydantic_allowlist(checkpointer)
        return _ResumeSafeGraph(graph.compile(checkpointer=checkpointer))
    return graph.compile()


# state 에 그대로 저장되는 pydantic 모델 — 체크포인터 msgpack 직렬화기에 등록해 두지 않으면
# 재개할 때마다 "Deserializing unregistered type" 경고가 난다(LangGraph JsonPlusSerializer).
_PYDANTIC_MODULES_IN_STATE = (
    ('samba_agent.agents.contracts', 'OrderRef'),
    ('samba_agent.agents.contracts', 'Evidence'),
    ('samba_agent.agents.contracts', 'AgentResult'),
)


def _with_pydantic_allowlist(checkpointer: object) -> object:
    """체크포인터가 지원하면(BaseCheckpointSaver.with_allowlist) 위 모듈을 허용 목록에 더한다."""
    with_allowlist = getattr(checkpointer, 'with_allowlist', None)
    if callable(with_allowlist):
        return with_allowlist(_PYDANTIC_MODULES_IN_STATE)
    return checkpointer
