"""전문 에이전트 공통 껍데기(스펙 §4.3).

에이전트가 밖으로 낼 수 있는 것은 AgentResult 하나다. 도중의 실패는 AgentFailure 로 던지고
run_agent 가 그것을 결과로 바꾼다 — 감독자는 예외를 보지 않는다.
"""

import json
import logging
import re
import threading
from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, Field

from samba_agent.agents.contracts import AgentResult, Evidence
from samba_agent.agents.refusal import classify_refusal
from samba_agent.agents.registry import AgentSpec
from samba_agent.bridge.client import BridgeClient, BridgeError
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text

# 앱 도구가 캡차·2단계 인증에서 돌려주는 표시(docs/bridge.md)
NEEDS_USER_MARKERS = ('needs_user', '캡차', 'captcha')
# 표식 검사에서 뺄 결과 머리 — login 도구의 정상 응답 'submitted: check the page for success or
# captcha/2FA' 가 'captcha' 글자만으로 캡차로 읽혀 로그인마다 사람에게 넘어갔다(실기)
_MARKER_EXEMPT_PREFIXES = ('submitted:',)
# 구조화 출력은 한 번만 다시 묻는다(스펙 §6)
DECIDE_RETRIES = 1

log = logging.getLogger(__name__)

# 스크립트 결과 JSON → 문제 문장(None 이면 통과)
ScriptCheck = Callable[[dict[str, object]], str | None]
# 스크립트마다 수리 잠금 — 계정 레인이 동시에 돌 때 같은 스크립트를 서로 덮어쓰며 고치지 않게
_REPAIR_LOCKS: dict[str, threading.Lock] = {}
_REPAIR_LOCKS_GUARD = threading.Lock()


def _repair_lock(name: str) -> threading.Lock:
    with _REPAIR_LOCKS_GUARD:
        return _REPAIR_LOCKS.setdefault(name, threading.Lock())


# 앱 run_script 가 그 이름의 스크립트가 없을 때 돌려주는 문구
_MISSING_SCRIPT = 'no saved script named'
# 이 사유의 실패는 스크립트를 고쳐도 소용없다 — 수리하지 않고 그대로 던진다
_NO_REPAIR_REASONS = frozenset(
    {
        FailReason.CAPTCHA,
        FailReason.PERMISSION_DENIED,
        FailReason.BRIDGE_DOWN,
        FailReason.DUPLICATE,
        FailReason.PAY_INTERRUPTED,
    }
)


class Decision(BaseModel):
    """LLM 판단의 공통 모양. reason 없는 판단은 만들 수 없다."""

    choice: str
    reason: str = Field(min_length=1)


DecideFn = Callable[[str, type[BaseModel]], BaseModel]


class AgentFailure(Exception):
    """에이전트 중단. 감독자가 보는 것은 이걸 바꾼 AgentResult 다."""

    def __init__(
        self, status: Literal['fail', 'needs_human'], reason: str, fail_reason: FailReason
    ) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason
        self.fail_reason = fail_reason


# 수리 전에 한 번 더 돌려 볼 읽기 전용 스크립트(이름 끝). 배송지 저장·주문서 정돈처럼 화면을 바꾸는 스크립트는
# 두 번 돌리면 배송지가 두 번 생길 수 있어 넣지 않는다
READ_ONLY_SCRIPT_SUFFIXES = (
    '_product_snapshot',
    '_payment_quotes',
    '_pay_card_quote',
    '_normal_price',
    'source_order_detail',
    '_order_detail',
)


def is_read_only_script(name: str) -> bool:
    return name.endswith(READ_ONLY_SCRIPT_SUFFIXES)


class AgentBase:
    """도구 호출과 LLM 판단의 공통 부분."""

    def __init__(self, spec: AgentSpec, bridge: BridgeClient, decide: DecideFn) -> None:
        self.spec = spec
        # 등록부의 허용 목록으로 좁힌 클라이언트만 쥔다 — 목록 밖은 나가지도 않는다
        self.bridge = bridge.scoped(spec.tools)
        self._decide = decide
        self.evidence: list[Evidence] = []
        # 진행 보고 횟수 — 앱 progress 도구는 done/total 정수가 필수다(실기: label 만 보내 거절당함)
        self._steps = 0

    def tool(self, name: str, /, **args: object) -> str:
        """도구 1건. 캡차 표시는 사람에게, 브릿지 오류는 사유 그대로 실패로 바꾼다."""
        try:
            out = self.bridge.call(name, **args)
        except BridgeError as e:
            # 항상 fail 로 던진다. 권한 부족·중복은 감독자의 NO_RETRY_REASONS 가
            # 재시도 없이 바로 needs_human 으로 넘긴다(스펙 §6) — 여기서 판단하지 않는다
            raise AgentFailure('fail', str(e), e.reason) from e
        # 앱이 남긴 단계 기록(성공 여부 포함) — 실패 원인을 가를 때 호출부가 읽는다
        self.last_steps = out.steps
        if not out.result.lstrip().startswith(_MARKER_EXEMPT_PREFIXES) and any(
            m in out.result for m in NEEDS_USER_MARKERS
        ):
            raise AgentFailure('needs_human', f'사람 확인 필요: {name}', FailReason.CAPTCHA)
        # 앱은 거절을 HTTP 오류가 아니라 200 + 'refused: …' 로 돌려준다 — 성공으로 읽으면
        # 잠긴 금고·읽기 전용 모드에서도 다음 단계로 넘어간다(리뷰 지적 — I5)
        verdict = classify_refusal(out.result)
        if verdict is not None:
            status, reason = verdict
            raise AgentFailure(
                status, f'{name} 거절: {mask_text(out.result.strip()[:120])}', reason
            )
        return out.result

    def json_tool(self, name: str, /, **args: object) -> dict[str, object]:
        """결과가 JSON 인 저장 스크립트용. 형식이 깨지면 unknown 실패다.

        앱은 실행 중 자동으로 닫은 페이지 대화상자(alert)를 결과 앞에 `page dialog: "…"` 줄로
        붙여 준다(실기: 무신사 "옵션을 선택해 주세요") — 근거로 남기고 JSON 만 읽는다.
        """
        raw = self.tool(name, **args)
        body, dialogs = split_page_dialogs(raw)
        for d in dialogs:
            self.note('페이지 알림', mask_text(d)[:120])
        try:
            parsed = json.loads(body)
        except ValueError as e:
            # 원문 앞부분을 남겨 원인(도구 오류·시간 초과·안내 문구)을 가를 수 있게 한다(마스킹)
            raise AgentFailure(
                'fail',
                f'{name} 결과가 JSON 이 아니다: {mask_text(body.strip()[:160])}',
                FailReason.UNKNOWN,
            ) from e
        if not isinstance(parsed, dict):
            raise AgentFailure('fail', f'{name} 결과가 객체가 아니다', FailReason.UNKNOWN)
        if dialogs and PAGE_DIALOGS_KEY not in parsed:
            # 검증·호출부가 사이트 알림(예: 무신사 '최대 구매수량을 이미 구매') 으로 실패 사유를 가를 수 있게 싣는다
            parsed[PAGE_DIALOGS_KEY] = dialogs
        return parsed

    # ---- 저장 스크립트 자가 수리(사용자 2026-09-24) ----
    # 배선은 factory 가 한다. repairer 가 None 이면 예전처럼 실패·결과를 그대로 돌려준다
    repairer: Any = None
    # 원본 코드 읽기(FileScriptSource)·교체 이력(ScriptHistory)
    script_source: Any = None
    script_history: Any = None
    # 이번 작업에서 이미 수리를 시도한 스크립트 — 같은 작업 안에서 두 번 고치지 않는다
    _repair_tried: dict[str, str]

    def reset_repairs(self) -> None:
        """작업 시작 때 부른다 — 수리 시도 기록을 비운다. 기록 사전은 계정 레인 사본들이 함께 쓴다."""
        self._repair_tried = {}
        self._repair_fixed: set[str] = set()
        # 이 작업에서 AI 가 '스크립트 문제 아님'으로 판정한 스크립트 — 같은 사유로 다시 수리하지 않는다
        self._repair_genuine: set[str] = set()

    def script_json(
        self,
        name: str,
        args: dict[str, object],
        *,
        goal: str,
        check: ScriptCheck,
        allow_pay_button: bool = False,
    ) -> dict[str, object]:
        """저장 스크립트를 돌리고 check 로 결과를 본다. 실패하면 AI 가 고쳐 이어 간다.

        - 통과: 결과 그대로.
        - 실패(예외·검증 불통): 수리 에이전트가 화면을 보고 고친 스크립트를 이번 인자로 시험해 check 를
          통과하면 그 결과를 돌려주고 저장 스크립트를 갈아 끼운다(이전 판은 이력 폴더).
        - 수리도 못 하면 예전과 똑같이 원래 예외를 던지거나 원래 결과를 돌려준다 — 호출부 판단은 그대로다.
        """
        raw_args = json.dumps(args, ensure_ascii=False)
        try:
            out = self.json_tool('run_script', name=name, args=raw_args)
        except AgentFailure as e:
            # 저장 스크립트가 아예 없으면 앱은 권한 거절 문구로 답한다 — 이건 AI 가 새로 만들 수 있다
            # (실기: 29CM 직배에 cm29_set_shipping 이 없어 멈춤)
            missing = _MISSING_SCRIPT in e.reason
            if e.fail_reason in _NO_REPAIR_REASONS and not missing:
                raise
            problem = '저장 스크립트가 없다 — 처음부터 만들어라' if missing else e.reason
            fixed = self._repair(name, args, goal, check, problem, '', allow_pay_button)
            if fixed is None:
                raise
            return fixed
        problem = check(out)
        if problem is None:
            return out
        if is_read_only_script(name):
            # 읽기 전용 스크립트는 한 번 더 돌려 본다 — 페이지가 덜 떠서 빈 결과가 나온 것을 스크립트 고장으로
            # 보고 AI 수리를 돌리던 것이 '작업마다 수리 반복'의 주원인이었다(실기 2026-09-25: 같은 인자 두 번째는 정상)
            try:
                again = self.json_tool('run_script', name=name, args=raw_args)
            except AgentFailure:
                again = None
            if again is not None and check(again) is None:
                self.note('스크립트 재시도', f'{name}: 두 번째 실행에서 통과(수리 안 함)')
                return again
        fixed = self._repair(
            name, args, goal, check, problem, json.dumps(out, ensure_ascii=False), allow_pay_button
        )
        return fixed if fixed is not None else out

    def _repair(
        self,
        name: str,
        args: dict[str, object],
        goal: str,
        check: ScriptCheck,
        problem: str,
        last_output: str,
        allow_pay_button: bool = False,
    ) -> dict[str, object] | None:
        """AI 수리 1회. 검증 통과 결과를 돌려주거나 None(못 고침·진짜 불가·꺼짐)."""
        if self.repairer is None:
            return None
        with _repair_lock(name):
            return self._repair_locked(
                name, args, goal, check, problem, last_output, allow_pay_button
            )

    def _repair_locked(
        self,
        name: str,
        args: dict[str, object],
        goal: str,
        check: ScriptCheck,
        problem: str,
        last_output: str,
        allow_pay_button: bool = False,
    ) -> dict[str, object] | None:
        """잠금 안에서 수리. 다른 레인이 이 작업에서 이미 고쳤으면 고친 스크립트로 먼저 다시 돌려 본다."""
        fixed = getattr(self, '_repair_fixed', None)
        if fixed is None:
            fixed = self._repair_fixed = set()
        if name in fixed:
            try:
                again = self.json_tool(
                    'run_script', name=name, args=json.dumps(args, ensure_ascii=False)
                )
            except AgentFailure:
                again = None
            if again is not None and check(again) is None:
                self.note('스크립트 수리', f'{name}: 다른 계정에서 고친 스크립트로 통과')
                return again
        tried = getattr(self, '_repair_tried', None)
        if tried is None:
            tried = self._repair_tried = {}
        # 계정(프로필)마다 따로 센다 — 한 계정에서 포기해도 다른 계정은 고칠 수 있다
        key = f'{name}|{args.get("profile") or ""}'
        if key in tried:
            return None
        tried[key] = 'running'
        current = self.script_source.get(name) if self.script_source is not None else None
        if self.script_history is not None:
            # 지난 수리 사례를 같이 준다 — 이번 상품만 맞추다 예전에 고친 경우를 깨지 않게(실기: 무신사 스냅샷 2회 수리)
            past = self.script_history.recent_problems(name)
            if past:
                current = {**(current or {}), 'past_repairs': past}
        self.step(f'{self.spec.name}: AI 스크립트 수리({name})')
        self.note('스크립트 수리', mask_text(f'{name}: 시작 — {problem[:120]}'))
        log.info('스크립트 수리 시작: %s', name)

        def call(tool: str, tool_args: dict[str, object]) -> str:
            try:
                return self.bridge.call(tool, **tool_args).result
            except BridgeError as e:
                return f'Error: {e}'

        outcome = self.repairer.repair(
            call=call,
            name=name,
            args=args,
            goal=goal,
            problem=problem,
            last_output=last_output,
            validate=check,
            current=current,
            allow_pay_button=allow_pay_button,
        )
        tried[key] = outcome.status
        log.info(
            '스크립트 수리 결과: %s %s (시험 %d회) — %s',
            name,
            outcome.status,
            outcome.tests,
            mask_text(str(outcome.reason))[:200],
        )
        if outcome.status == 'genuine':
            genuine = getattr(self, '_repair_genuine', None)
            if isinstance(genuine, set):
                genuine.add(name)
            self.note(
                '스크립트 수리', mask_text(f'{name}: 스크립트 문제 아님 — {outcome.reason[:160]}')
            )
            return None
        if outcome.status != 'fixed' or outcome.output is None or not outcome.code:
            self.note('스크립트 수리', mask_text(f'{name}: 못 고침 — {outcome.reason[:160]}'))
            return None
        self._save_repaired(name, outcome.code, current, goal, problem, outcome.tests)
        fixed.add(name)
        return outcome.output

    def _save_repaired(
        self,
        name: str,
        code: str,
        current: dict[str, object] | None,
        goal: str,
        problem: str,
        tests: int,
    ) -> None:
        """검증 통과한 코드로 저장 스크립트를 갈아 끼운다. 이전 판은 이력 폴더에 먼저 남긴다."""
        cur = current or {}
        if self.script_history is not None:
            try:
                self.script_history.record(
                    name,
                    str(cur.get('code') or ''),
                    code,
                    {'agent': self.spec.name, 'problem': mask_text(problem[:300]), 'tests': tests},
                )
            except OSError as e:
                log.warning('스크립트 이력 저장 실패: %s %s', name, e)
        params = cur.get('params')
        try:
            self.tool(
                'save_script',
                name=name,
                host=str(cur.get('host') or ''),
                description=str(cur.get('description') or goal)[:240],
                params=[str(p) for p in params] if isinstance(params, list) else [],
                code=code,
            )
        except AgentFailure as e:
            # 저장이 막혀도(dry_run·거절) 이번 결과는 검증을 통과했으니 쓴다 — 다음 작업이 다시 고친다
            self.note('스크립트 수리', mask_text(f'{name}: 고쳤지만 저장 못 함 — {e.reason[:100]}'))
            return
        self.note('스크립트 수리', f'{name}: 고친 스크립트로 교체(시험 {tests}회)')

    def decide_once(self, prompt: str, model: type[BaseModel]) -> BaseModel:
        """구조화 출력. 실패하면 한 번만 다시 묻고, 또 실패하면 사람에게 넘긴다."""
        last: Exception | None = None
        for _ in range(DECIDE_RETRIES + 1):
            try:
                return self._decide(prompt, model)
            except Exception as e:  # noqa: BLE001 — 판단 함수가 던지는 형식은 정해져 있지 않다
                last = e
        raise AgentFailure('needs_human', f'구조화 출력 실패: {last}', FailReason.UNKNOWN) from last

    def note(self, label: str, detail: str) -> None:
        """근거 조각을 남긴다. 결과에 함께 실려 진단·검수 큐가 본다.

        하네스 로그에도 한 줄 남긴다(가린 값) — 계정별 견적·쿠폰·로그인 실패 원인을 나중에 찾는다(2026-09-28)."""
        self.evidence.append(Evidence(label=label, detail=detail))
        log.info('%s 근거 [%s] %s', self.spec.name, label, mask_text(detail)[:300])

    def step(self, label: str) -> None:
        """진행 보고 — 슬랙 스레드에 한 줄로 뜬다.

        앱의 progress 도구는 0 <= done <= total, total >= 1 을 요구한다. 단계 총수는 미리 모르니
        n번째 보고를 'n-1 / n'(n번째 진행 중)으로 보낸다.
        """
        if 'progress' in self.spec.tools:
            self._steps += 1
            self.tool('progress', label=label, done=self._steps - 1, total=self._steps)


# json_tool 이 결과 객체에 싣는 페이지 대화상자 문구 목록의 키
PAGE_DIALOGS_KEY = '_page_dialogs'

# 앱이 도구 결과 앞에 붙이는 대화상자 안내 줄(src/main/browser/dialogs.ts)
_PAGE_DIALOG_RE = re.compile(r'^page dialog: "(.*)"\s*$')


def split_page_dialogs(raw: str) -> tuple[str, list[str]]:
    """결과 문자열 머리의 `page dialog: "…"` 줄들을 떼어 (본문, 대화상자 문구들) 로 나눈다."""
    dialogs: list[str] = []
    lines = raw.split('\n')
    while lines:
        m = _PAGE_DIALOG_RE.match(lines[0])
        if not m:
            break
        dialogs.append(m.group(1))
        lines.pop(0)
    return '\n'.join(lines).strip(), dialogs


def run_agent(
    fn: Callable[[], AgentResult], evidence: Callable[[], list[Evidence]] | None = None
) -> AgentResult:
    """AgentFailure 를 AgentResult 로 바꾼다. 감독자는 예외를 보지 않는다.

    ``evidence`` 를 주면 실패 결과에도 그때까지의 근거를 싣는다 — 실기에서 실패 사유만 남고
    어느 단계까지 갔는지(옵션 목록·계정·배송지) 알 수 없어 진단이 막혔다.
    """
    try:
        return fn()
    except AgentFailure as e:
        return AgentResult(
            status=e.status,
            reason=e.reason,
            fail_reason=e.fail_reason,
            evidence=tuple(evidence()) if evidence is not None else (),
        )
