"""스크립트 수리 에이전트.

흐름(스크립트 1건):
1. 하네스가 저장 스크립트를 돌렸는데 실패했거나 결과가 검증을 통과하지 못했다.
2. AI(claude-agent-sdk, Claude 구독)가 도구 세 개만으로 일한다.
   - run_js: 지금 화면을 살펴본다(앱 run_js 와 같은 샌드박스).
   - test_script: 고친 스크립트를 이번 주문의 인자 그대로 돌리고 **하네스의 검증 함수**로 채점한다.
   - report_genuine: 스크립트 문제가 아니라 진짜로 불가능(품절·옵션 없음·배송지 없음)함을 근거와 함께 알린다.
3. test_script 가 통과한 코드만 결과로 쓰고, 그 코드로 저장 스크립트를 갈아 끼운다(이전 판은 이력 폴더에).

안전
- AI 는 결제·비밀번호에 닿는 도구가 없다(fill_secret·결제 승인 없음). run_js 코드에서도 결제 확정 버튼·
  결제창 도메인·비밀번호 글자를 막는다 — 수리 대상은 상품 확인·주문서 정돈·견적·배송지 스크립트뿐이다.
- 통과 여부는 AI 가 아니라 하네스 검증 함수가 정한다. AI 가 "고쳤다"고 말해도 검증을 못 넘으면 쓰지 않는다.
- 프롬프트·화면 원문은 로그로 남기지 않는다.
"""

import asyncio
import concurrent.futures
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from samba_agent.agents.base import split_page_dialogs

# 도구 이름 → 결과 문자열. 호출부(에이전트)의 브릿지에 그대로 잇는다
BridgeCall = Callable[[str, dict[str, object]], str]
# 결과 JSON → 문제 문장(None 이면 통과)
Validate = Callable[[dict[str, object]], str | None]

# SDK 내장 CLI 가 아는 모델이어야 한다(실기: claude-opus-5-5 는 'does not support this model')
DEFAULT_REPAIR_MODEL = 'claude-opus-5-5'
DEFAULT_MAX_TURNS = 70  # 40 이면 화면을 살피다 시험 전에 끝나는 일이 잦았다(실기 로그)
DEFAULT_TIMEOUT_S = 900.0
# 앱 run_js·저장 스크립트 코드 상한(RUN_JS_MAX_CODE)
CODE_MAX = 8000
# AI 에게 돌려주는 화면·결과 길이 상한
_RESULT_MAX = 12000

# AI 가 쓰는 코드에 있으면 안 되는 것 — 결제 확정·결제창·비밀번호·삭제
_BLOCKED: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r'결제하기|입력완료|구매확정|결제\s*승인'), '결제 확정 버튼'),
    (
        re.compile(r'musinsapayments|nicepay|inicis|kcp\.co|tosspayments', re.IGNORECASE),
        '결제창 도메인',
    ),
    (re.compile(r'password|비밀번호|fill_secret', re.IGNORECASE), '비밀번호'),
    (re.compile(r'삭제하기|주문\s*취소'), '삭제·취소 버튼'),
)
# 결제창 진입 스크립트에서도 막는 확정 버튼(결제하기는 허용)
_CONFIRM_ONLY = re.compile(r'입력완료|구매확정|결제\s*승인')
# 앱 저장 규칙: 9자리 이상 숫자(주문번호 등)를 코드에 박으면 저장이 거절된다
_HARDCODED_ID_RE = re.compile(r'\d{9,}')


def blocked_reason(code: str, allow_pay_button: bool = False) -> str | None:
    """막힌 글자가 있으면 그 사유, 없으면 None.

    allow_pay_button: 결제창 진입 스크립트(주문서 '결제하기' → 결제창)만 True. 결제는 비밀번호·폰 승인이
    있어야 끝나고 AI 는 그 도구가 없으므로 '결제하기' 글자만 풀어 준다(입력완료·결제창 도메인·비밀번호는 그대로 막힘).
    """
    for pattern, label in _BLOCKED:
        if allow_pay_button and label == '결제 확정 버튼':
            pattern = _CONFIRM_ONLY
        if pattern.search(code):
            return f'금지: {label}은(는) 수리 스크립트에서 다룰 수 없다'
    return None


@dataclass
class RepairOutcome:
    """수리 결과. fixed 면 output 이 검증을 통과한 결과이고 code 가 새 스크립트다."""

    status: Literal['fixed', 'genuine', 'gave_up']
    reason: str
    output: dict[str, object] | None = None
    code: str | None = None
    tests: int = 0


@dataclass
class _State:
    tests: int = 0
    passed_code: str | None = None
    passed_output: dict[str, object] | None = None
    genuine: str | None = None
    last_problem: str = ''
    notes: list[str] = field(default_factory=list)


def parse_output(raw: str) -> tuple[dict[str, object] | None, str]:
    """스크립트 결과 문자열 → (JSON 객체, 문제). 앱이 붙이는 page dialog 줄은 떼어 낸다."""
    body, _dialogs = split_page_dialogs(raw)
    try:
        parsed = json.loads(body)
    except ValueError:
        return None, f'결과가 JSON 이 아니다: {body[:300]}'
    if not isinstance(parsed, dict):
        return None, '결과가 JSON 객체가 아니다'
    return parsed, ''


def args_prefix(args: dict[str, object]) -> str:
    """시험 실행 때 코드 앞에 붙이는 줄 — 샌드박스의 args 는 전역 속성이라 대입으로 이번 주문 인자를 넣는다."""
    return f'args={json.dumps(args, ensure_ascii=False)};\n'


def hardcoded_amounts(code: str, output: dict[str, object]) -> list[str]:
    """결과의 금액(1,000 이상 숫자)이 코드에 그대로 박혀 있으면 그 값들 — 화면을 읽지 않고 검증만 통과하는 꼼수다."""
    found: list[str] = []
    for value in output.values():
        if isinstance(value, bool) or not isinstance(value, int | float) or value < 1000:
            continue
        n = int(value)
        for text in (str(n), f'{n:,}'):
            if re.search(rf'(?<![\d,]){re.escape(text)}(?![\d,])', code):
                found.append(text)
                break
    return found


def check_candidate(code: str, allow_pay_button: bool = False) -> str | None:
    """시험 전에 거를 것(금지 글자·길이·박힌 번호). 문제 없으면 None."""
    blocked = blocked_reason(code, allow_pay_button)
    if blocked:
        return blocked
    if len(code) > CODE_MAX:
        return f'코드가 {len(code)}자 — {CODE_MAX}자 이하로 줄여라'
    if _HARDCODED_ID_RE.search(code):
        return '9자리 이상 숫자를 코드에 박지 마라 — args 에서 읽어라'
    return None


def app_supports_pay_guard(bridge: Any) -> bool:
    """앱의 run_js 가 safety:no_pay(결제 버튼 클릭 차단)를 아는가 — safety:probe 에 지원 문구로 답해야 참.

    브릿지는 도구 스키마 검사를 거치지 않아 예전 앱은 모르는 값을 무시하고 코드를 그냥 돌린다(실기).
    """
    try:
        out = bridge.call('run_js', code='return "probe-ran"', safety='probe').result
    except Exception:  # noqa: BLE001 — 연결 실패 등은 지원 안 함으로 본다(안전 쪽)
        return False
    return 'no_pay supported' in out


class ScriptRepairer:
    """저장 스크립트 1건을 고친다. 에이전트끼리 공유해도 된다(상태는 호출마다 새로 만든다)."""

    def __init__(
        self,
        *,
        model: str = DEFAULT_REPAIR_MODEL,
        max_turns: int = DEFAULT_MAX_TURNS,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        query_fn: Any = None,
    ) -> None:
        self.model = model
        self.max_turns = max_turns
        self.timeout_s = timeout_s
        self._query_fn = query_fn

    def repair(
        self,
        *,
        call: BridgeCall,
        name: str,
        args: dict[str, object],
        goal: str,
        problem: str,
        last_output: str,
        validate: Validate,
        current: dict[str, object] | None,
        allow_pay_button: bool = False,
    ) -> RepairOutcome:
        """AI 로 고친다. 검증을 통과한 코드가 나오면 fixed, 진짜 불가면 genuine, 아니면 gave_up."""
        state = _State()
        prompt = build_prompt(name, args, goal, problem, last_output, current)
        try:
            _run_sync(
                asyncio.wait_for(
                    self._loop(prompt, call, args, validate, state, allow_pay_button),
                    timeout=self.timeout_s,
                )
            )
        except TimeoutError:
            state.notes.append('시간 초과')
        except Exception as e:  # noqa: BLE001 — SDK·CLI 오류 형식이 정해져 있지 않다
            state.notes.append(f'수리 에이전트 오류: {type(e).__name__}: {str(e)[:120]}')
        if state.passed_code is not None and state.passed_output is not None:
            return RepairOutcome(
                'fixed', '검증 통과', state.passed_output, state.passed_code, state.tests
            )
        if state.genuine:
            return RepairOutcome('genuine', state.genuine, tests=state.tests)
        parts = [*state.notes, state.last_problem]
        detail = '; '.join(p for p in parts if p) or '고친 스크립트가 검증을 통과하지 못함'
        return RepairOutcome('gave_up', detail[:300], tests=state.tests)

    async def _loop(
        self,
        prompt: str,
        call: BridgeCall,
        args: dict[str, object],
        validate: Validate,
        state: _State,
        allow_pay_button: bool = False,
    ) -> None:
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, tool
        from claude_agent_sdk import query as default_query

        def text(body: str) -> dict[str, Any]:
            return {'content': [{'type': 'text', 'text': body[:_RESULT_MAX]}]}

        async def run(code: str) -> str:
            # 앱이 결제 확정 버튼 클릭·Enter 제출을 요소 단위로 거절한다(글자 차단만으로는 요소 번호 클릭을 못 막는다 —
            # 2026-09-24 수리 시험 중 결제하기 클릭으로 실결제 발생)
            return await asyncio.to_thread(call, 'run_js', {'code': code, 'safety': 'no_pay'})

        @tool(
            'run_js',
            'Inspect or drive the current browser page. Same sandbox as the saved scripts: '
            'page.get({query,selector,interactive}) -> {tree,...}, page.click(id), page.clickNative(id), '
            'page.clickText(text,nth), page.type(id,text), page.select(id,value), page.text(id), '
            'page.url(), page.dismissOverlay(), tabs.list()/switch(id)/open({url,profile})/close(id), '
            'sleep(ms), log(). Return a value to see it.',
            {'code': str},
        )
        async def run_js(inp: dict[str, Any]) -> dict[str, Any]:
            code = str(inp.get('code', ''))
            blocked = blocked_reason(code, allow_pay_button)
            if blocked:
                return text(blocked)
            return text(await run(code))

        @tool(
            'test_script',
            "Run a candidate full script with THIS order's args (the global `args` is set for you) and "
            'grade its returned JSON with the harness validator. Returns PASS or FAIL with the reason. '
            'Only a PASS counts; the last passing code replaces the saved script.',
            {'code': str},
        )
        async def test_script(inp: dict[str, Any]) -> dict[str, Any]:
            code = str(inp.get('code', ''))
            problem = check_candidate(code, allow_pay_button)
            prefix = args_prefix(args)
            if not problem and len(prefix) + len(code) > CODE_MAX:
                # 시험 때는 인자 줄이 앞에 붙는다 — 그만큼 여유를 둬야 앱 run_js 상한에 걸리지 않는다
                problem = f'코드가 {len(code)}자 — 이번 인자 줄을 붙여도 {CODE_MAX}자 이하가 되게 {CODE_MAX - len(prefix)}자 이하로 줄여라'
            if problem:
                return text(f'FAIL: {problem}')
            state.tests += 1
            raw = await run(prefix + code)
            parsed, problem = parse_output(raw)
            if parsed is not None:
                problem = validate(parsed) or ''
                baked = hardcoded_amounts(code, parsed)
                if not problem and baked:
                    problem = f'금액 {baked} 을 코드에 박았다 — 화면에서 읽어라'
            if problem:
                state.last_problem = problem[:200]
                return text(f'FAIL: {problem}\n--- 결과 ---\n{raw[:4000]}')
            state.passed_code = code
            state.passed_output = parsed
            return text('PASS — 이 코드로 저장한다. 더 할 일이 없으면 끝내라.')

        @tool(
            'report_genuine',
            'Call ONLY when the script is not the problem and the goal is truly impossible on this page '
            '(e.g. the ordered option is really sold out, the office address really is not in the list). '
            'Give concrete evidence you saw on the page.',
            {'reason': str},
        )
        async def report_genuine(inp: dict[str, Any]) -> dict[str, Any]:
            state.genuine = str(inp.get('reason', '')).strip()[:300] or '불가(근거 없음)'
            return text('기록했다. 끝내라.')

        server = create_sdk_mcp_server(
            name='repair', version='1.0.0', tools=[run_js, test_script, report_genuine]
        )
        options = ClaudeAgentOptions(
            tools=[],  # 내장 도구(파일·셸) 전부 끈다 — 브라우저 세 도구만 쓴다
            mcp_servers={'repair': server},
            allowed_tools=[
                'mcp__repair__run_js',
                'mcp__repair__test_script',
                'mcp__repair__report_genuine',
            ],
            permission_mode='bypassPermissions',
            system_prompt=SYSTEM_PROMPT,
            model=self.model,
            max_turns=self.max_turns,
        )
        query_fn = self._query_fn or default_query
        async for _message in query_fn(prompt=prompt, options=options):
            # 응답 원문은 담지 않는다 — 결과는 도구가 state 에 남긴다
            pass


def build_prompt(
    name: str,
    args: dict[str, object],
    goal: str,
    problem: str,
    last_output: str,
    current: dict[str, object] | None,
) -> str:
    """수리 요청문. 원본 코드·실패 사유·이번 인자를 싣는다."""
    cur = current or {}
    return '\n'.join(
        [
            f'# 고칠 저장 스크립트: {name}',
            f'설명: {cur.get("description", "(없음)")}',
            f'인자 설명: {cur.get("params", [])}',
            f'## 목표\n{goal}',
            f'## 이번 실패\n{problem}',
            f'## 마지막 결과(앞부분)\n{last_output[:3000]}',
            f'## 이번 주문 인자(args)\n{json.dumps(args, ensure_ascii=False)[:1500]}',
            f'## 이 스크립트의 지난 수리(이 경우들도 계속 통해야 한다)\n{cur.get("past_repairs") or "(없음)"}',
            '## 지금 코드',
            '```js',
            str(cur.get('code', '(원본을 읽지 못함 — 처음부터 작성)')),
            '```',
        ]
    )


SYSTEM_PROMPT = """너는 SAMBA 브라우저의 저장 스크립트 수리공이다. 한국어로 생각하고 도구만 쓴다.
저장 스크립트는 쇼핑몰 화면을 읽고 조작해 JSON 을 돌려주는 짧은 JavaScript(async 본문)다.
하네스가 이 스크립트를 돌렸는데 실패했다. 할 일:
1. run_js 로 지금 탭·화면을 살펴 왜 실패했는지 찾는다(탭 목록, 옵션 드롭다운, 버튼 글자, 금액 위치).
2. 원래 코드의 반환 형식(키 이름)을 그대로 지키면서 고친 전체 코드를 만든다.
   - 기존 코드가 처리하던 경우(다른 상품·다른 화면 표기)를 지우지 말고 새 경우를 덧붙인다 — 이 스크립트는 모든 상품에 쓰인다.
   - 고정 sleep(2~3초) 대신 await page.waitFor('기다릴 글자', 8000) 을 쓴다 — 화면이 뜨면 바로 넘어가 빨라진다.
   - 입력은 전역 args 에서만 읽는다. 주문번호·금액·요소 번호를 코드에 박지 않는다(요소는 글자로 찾는다).
     금액·옵션 결과는 반드시 화면에서 읽는다 — 이번 값을 코드에 적으면 다음 주문에서 틀린 값을 낸다.
   - 4000자 이하. 사이트가 조금 바뀌어도 버티게 여러 표기(예: 컬러/색상, 사이즈 표기 차이)를 받아 준다.
3. test_script 로 이번 주문 인자 그대로 돌려 본다. FAIL 이면 사유를 보고 고쳐 다시 시험한다. PASS 가 나오면 끝낸다.
4. 스크립트 문제가 아니라 진짜로 불가능하면(주문 옵션이 실제 품절, 사무실 배송지가 실제로 없음 등) 화면 근거를 들어
   report_genuine 을 부른다. 추측으로 부르지 마라 — 옵션 표기 차이·드롭다운을 안 연 것·다른 탭을 읽은 것은 스크립트 문제다.
금지: 결제하기·입력완료 같은 결제 확정 버튼, 결제창, 비밀번호, 삭제·취소 버튼. 주문서까지만 다룬다.
옵션 매칭 요령: 주문 옵션 문자열(예: '상아색 S', 'EU 그린 EU 44 · KR 285')은 사이트 표기와 다를 수 있다 —
색상·사이즈를 나눠 각각 가장 가까운 선택지를 고르고, 선택 후 화면에 담긴 옵션을 되읽어 돌려준다."""


def _run_sync(coro: Any) -> Any:
    """이미 도는 이벤트 루프가 있으면 다른 스레드에서 새 루프로 돌린다(llm.decide 와 같은 방식)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()
