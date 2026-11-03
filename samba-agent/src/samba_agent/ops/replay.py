"""오프라인 재생기 — 브라우저 없이 스냅샷으로 에이전트를 한 번 돌린다(스펙 §4.5 2단계, Task 13 Step 6).

buyer.* 데이터셋은 실제 `agents.buyer.BuyerAgent` 를 가짜 BridgeClient(httpx.MockTransport)로
1회 실행한다(Task 13 리뷰 지적 1) — 시드의 `snapshot` 을 브릿지의 `run_script` 응답으로 그대로
흘려 넣는다. `agents/buyer.py`·`agents/base.py` 는 다른 워크트리가 동시에 고치는 중이라 이
파일에서는 손대지 않고 import 만 한다.

payer/recorder/verifier 는 아직 전문 에이전트 구현이 이 워크트리에 없어(Task 7 계열의 나머지),
시드가 이미 담고 있는 `snapshot`/`bridge`/`tool`/`dry_run` 필드를 그대로 판정하는 참조
재생기로 둔다 — 데이터셋 작성자가 seed 를 만들 때 쓴 것과 같은 규칙이다(정답을 베끼는 게
아니라 조건을 재계산한다). `ds.supervisor.assign` 도 실제 배정 로직(`agents.registry.Registry.pick`)
을 그대로 쓴다 — 이건 이미 구현돼 있다.

`ops/eval.py` 는 `runner_for(name)` 으로 데이터셋별 실행 경로(`agents`/`reference-simulator`)를
요약 JSON 에 적어, 이 결과가 실제 에이전트 없이 나온 것인지 구분해 promote 근거로 잘못
쓰이지 않게 한다(요약 JSON 의 `gate_eligible: false` 참고).

payer/recorder/verifier 실제 에이전트가 이 브랜치에 합류하면 `_replay_payer` 류 함수들을
지우고 이 파일의 buyer 경로와 같은 모양(Assignment + BridgeClient(MockTransport) + 진짜
에이전트 호출)으로 바꿔 끼우면 된다 — 공개 API(`replay_example(example) -> Run`, `.outputs`/
`.extra` 모양, `runner_for(name) -> str`)는 그대로 유지된다.
"""

import ast
import json
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass, field

import httpx

from samba_agent.agents.buyer import BuyerAgent
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient, BridgeError
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT

_registry_cache: Registry | None = None
_FAKE_URL = 'http://127.0.0.1:47811'
_FAKE_TOKEN = 'a' * 64
_CANDIDATE_RE = re.compile(r'\[.*?\]')


@dataclass
class Run:
    """evaluators 가 기대하는 최소 인터페이스 — outputs + extra(duration_ms·tool_calls·tools_called)."""

    outputs: dict[str, object]
    extra: dict[str, object] = field(default_factory=dict)


def runner_for(name: str) -> str:
    """이 데이터셋이 실제 에이전트로 도는지(`agents`) 참조 재생기로 도는지
    (`reference-simulator`). `ops/eval.py` 가 요약 JSON 의 `runner` 표시에 그대로 쓴다.

    buyer.* 만 실제 `BuyerAgent` 를 돈다(Task 13 리뷰 지적 1) — 나머지는 아직 전문 에이전트가
    없어 시드 규칙을 재계산하는 참조 재생기다.
    """
    return 'agents' if name.startswith('ds.buyer.') else 'reference-simulator'


def replay_example(example: object) -> Run:
    """스냅샷 하나를 판정해 Run 을 만든다. 실제 소요 시간을 재서 duration_ms 로 남긴다."""
    started = time.perf_counter()
    inputs: Mapping[str, object] = getattr(example, 'inputs', {}) or {}
    name = str(getattr(example, 'name', ''))
    outputs, tools_called = _dispatch(name, inputs)
    duration_ms = (time.perf_counter() - started) * 1000
    return Run(
        outputs=outputs,
        extra={
            'duration_ms': duration_ms,
            'tool_calls': len(tools_called),
            'tools_called': tools_called,
        },
    )


def _dispatch(name: str, inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    kind = name.split('.')[1] if name.count('.') >= 1 else ''
    if name == 'ds.supervisor.assign' or kind == 'supervisor':
        return _replay_assign(inputs)
    if kind == 'payer':
        return _replay_payer(inputs)
    if kind == 'recorder':
        return _replay_recorder(inputs)
    if kind == 'verifier':
        return _replay_verifier(inputs)
    # buyer.* — 실제 BuyerAgent 를 가짜 브릿지로 1회 실행한다
    return _replay_buyer_real(name, inputs)


def _bridge_and_tool_checks(
    inputs: Mapping[str, object],
) -> tuple[dict[str, object], list[str]] | None:
    """참조 재생기(payer/recorder/verifier)가 공유하는 선행 조건 — 브릿지 끊김 / 허용 밖 도구 / 중복."""
    tools_called: list[str] = ['get_page']
    if inputs.get('bridge') == 'down':
        return {'status': 'fail', 'fail_reason': FailReason.BRIDGE_DOWN.value}, tools_called
    tool = inputs.get('tool')
    if tool:
        tools_called.append(str(tool))
        return {'status': 'fail', 'fail_reason': FailReason.PERMISSION_DENIED.value}, tools_called
    snapshot = inputs.get('snapshot')
    if isinstance(snapshot, Mapping) and snapshot.get('samba_source_order_no'):
        return {'status': 'fail', 'fail_reason': FailReason.DUPLICATE.value}, tools_called
    return None


def _reference_decide(prompt: str, model: type) -> object:
    """실제 LLM 판단 대신 프롬프트 속 후보 목록(파이썬 리스트 표기)의 첫 값을 고른다.

    재생기 전용 스텁이다 — reason 에 그 사실을 그대로 적어 채점기가 "LLM 판단"으로
    착각하지 않게 한다.
    """
    match = _CANDIDATE_RE.search(prompt)
    choice = ''
    if match:
        try:
            candidates = ast.literal_eval(match.group(0))
            if candidates:
                choice = str(candidates[0])
        except (ValueError, SyntaxError):
            choice = ''
    return model(choice=choice, reason='재생기 참조 결정 — 후보 중 첫 값(실제 LLM 판단 아님)')


def _buyer_transport(inputs: Mapping[str, object], tools_called: list[str]):
    """`run_script` 요청에 시드의 `snapshot` 을 그대로 응답으로 돌려주는 가짜 전송."""
    snapshot = inputs.get('snapshot')

    def handler(request: httpx.Request) -> httpx.Response:
        tool_name = request.url.path.rsplit('/', 1)[-1]
        tools_called.append(tool_name)
        if tool_name == 'run_script':
            if isinstance(snapshot, Mapping) and isinstance(snapshot.get('raw'), str):
                result = snapshot['raw']
            else:
                body = {
                    k: v for k, v in dict(snapshot or {}).items() if k != 'samba_source_order_no'
                }
                result = json.dumps(body, ensure_ascii=False)
            return httpx.Response(200, json={'ok': True, 'result': result, 'steps': []})
        return httpx.Response(200, json={'ok': True, 'result': 'ok', 'steps': []})

    return handler


def _replay_buyer_real(
    name: str, inputs: Mapping[str, object]
) -> tuple[dict[str, object], list[str]]:
    """실제 `BuyerAgent` 를 가짜 브릿지로 1회 실행한다."""
    reg = _registry()
    spec = reg[name.split('.', 1)[1]]  # 'ds.buyer.musinsa' → 'buyer.musinsa'
    order_row = dict(inputs.get('order', {}))
    order_row.setdefault('sku', 'SKU-1')
    order_row.setdefault('qty', 1)
    order = OrderRef.model_validate(order_row)
    assignment = Assignment(
        order=order,
        options=dict(inputs.get('options', {})),
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=True,
    )
    tools_called: list[str] = []

    # 권한 부족 — 등록부 허용 밖 도구를 실제 BridgeClient 로 불러 본다(가짜 응답이라 네트워크는
    # 안 나간다: 허용 목록 검사가 HTTP 호출보다 먼저다)
    tool = inputs.get('tool')
    if tool:
        tools_called.append(str(tool))
        probe = BridgeClient(_FAKE_URL, _FAKE_TOKEN, allowed=spec.tools)
        try:
            probe.call(str(tool))
        except BridgeError as e:
            return {'status': 'fail', 'reason': str(e), 'fail_reason': e.reason.value}, tools_called
        return {
            'status': 'ok',
            'reason': f'허용 목록 안 도구 — 실제로 불렀다: {tool}',
        }, tools_called

    # 중복 — 감독자가 에이전트를 부르기 전에 걸러낸다. buyer 자체의 판단이 아니라서
    # 실제 에이전트를 부르지 않는다
    snapshot = inputs.get('snapshot')
    if isinstance(snapshot, Mapping) and snapshot.get('samba_source_order_no'):
        return {
            'status': 'fail',
            'reason': f'이미 처리된 주문: {snapshot["samba_source_order_no"]}',
            'fail_reason': FailReason.DUPLICATE.value,
        }, tools_called

    if inputs.get('bridge') == 'down':

        def _down(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError('브릿지 연결 끊김(재생기 시뮬레이션)', request=request)

        transport = httpx.MockTransport(_down)
    else:
        transport = httpx.MockTransport(_buyer_transport(inputs, tools_called))

    bridge = BridgeClient(
        _FAKE_URL,
        _FAKE_TOKEN,
        allowed=spec.tools,
        busy_wait_s=0.0,
        client=httpx.Client(transport=transport, timeout=5.0),
    )
    agent = BuyerAgent(spec, bridge, _reference_decide)
    result = agent(assignment)
    outputs: dict[str, object] = {
        'status': result.status,
        'reason': result.reason,
        **result.payload,
    }
    if result.fail_reason is not None:
        outputs['fail_reason'] = result.fail_reason.value
    return outputs, tools_called


def _replay_assign(inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    """배정은 흉내가 아니라 실제 Registry.pick 을 쓴다 — 이 로직은 이미 구현돼 있다."""
    tool = inputs.get('tool')
    if tool:
        return {'status': 'fail', 'fail_reason': FailReason.PERMISSION_DENIED.value}, [str(tool)]
    order_row = dict(inputs.get('order', {}))
    order_row.setdefault('sku', 'SKU-1')
    order_row.setdefault('qty', 1)
    order = OrderRef.model_validate(order_row)
    options = dict(inputs.get('options', {}))
    spec = _registry().pick('buyer', order, options)
    if spec is None:
        return {'status': 'needs_ai', 'fail_reason': FailReason.UNKNOWN.value}, []
    return {'status': 'ok', 'agent': spec.name}, []


def _replay_payer(inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    early = _bridge_and_tool_checks(inputs)
    if early is not None:
        return early
    tools_called: list[str] = ['get_page']
    snapshot = inputs.get('snapshot')
    if isinstance(snapshot, Mapping):
        raw = snapshot.get('raw')
        if isinstance(raw, str) and '캡차' in raw:
            return {'status': 'needs_ai', 'fail_reason': FailReason.CAPTCHA.value}, tools_called

    options = inputs.get('options')
    card = options.get('card') if isinstance(options, Mapping) else None
    if isinstance(snapshot, Mapping):
        methods = snapshot.get('methods')
        if card and isinstance(methods, list) and card not in methods:
            return {'status': 'fail', 'fail_reason': FailReason.CARD_MISSING.value}, tools_called

    if inputs.get('dry_run'):
        return {'status': 'ok', 'payload': {'dry_run': True, 'paid': False}}, tools_called

    if isinstance(snapshot, Mapping) and snapshot.get('approval_confirmed') is False:
        return {'status': 'needs_ai', 'fail_reason': FailReason.UNKNOWN.value}, tools_called

    tools_called.append('phone_approve_payment')
    result: dict[str, object] = {'status': 'ok', 'payload': {'paid': True}}
    if card:
        result['card'] = card
    return result, tools_called


def _replay_recorder(inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    early = _bridge_and_tool_checks(inputs)
    if early is not None:
        return early
    tools_called: list[str] = ['get_page']
    if inputs.get('dry_run'):
        return {'status': 'ok', 'payload': {'dry_run': True}}, tools_called
    snapshot = inputs.get('snapshot')
    if not isinstance(snapshot, Mapping):
        return {'status': 'needs_ai', 'fail_reason': FailReason.UNKNOWN.value}, tools_called
    expected = snapshot.get('expected', {})
    actual = snapshot.get('actual', {})
    if expected == actual:
        return {'status': 'ok'}, tools_called
    return {'status': 'fail', 'fail_reason': FailReason.VERIFY_MISMATCH.value}, tools_called


def _replay_verifier(inputs: Mapping[str, object]) -> tuple[dict[str, object], list[str]]:
    early = _bridge_and_tool_checks(inputs)
    if early is not None:
        return early
    tools_called: list[str] = ['get_page']
    snapshot = inputs.get('snapshot')
    if not isinstance(snapshot, Mapping):
        return {'status': 'needs_ai', 'fail_reason': FailReason.UNKNOWN.value}, tools_called
    if not snapshot.get('found', True):
        return {'status': 'fail', 'fail_reason': FailReason.UNKNOWN.value}, tools_called
    expected = snapshot.get('expected', {})
    observed = snapshot.get('observed', {})
    if expected == observed:
        return {'status': 'ok'}, tools_called
    return {'status': 'fail', 'fail_reason': FailReason.VERIFY_MISMATCH.value}, tools_called


def _registry() -> Registry:
    global _registry_cache
    if _registry_cache is None:
        _registry_cache = Registry.load(DEFAULT_ROOT)
    return _registry_cache
