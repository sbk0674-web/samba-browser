"""AI 대행 — 하네스가 막혔을 때 사람이 하던 상황 판단을 대신한다(사용자 2026-10-08).

스크립트 수리(`repair`)는 저장 스크립트 한 개를 고치는 일뿐이다. 주문서 탭이 사라지거나 처음 보는 화면이 떠서
작업이 결제 전에 멈추면 "스크립트 문제 아님"으로 끝나고 사람이 이어서 하라고 해야 했다. 이 대행은 그 판단을 한다.

흐름(작업 1건):
1. 작업이 결제 전에 사람 확인으로 멈췄다(결제됐을 수 있는 사유는 오기 전에 걸러진다).
2. AI 가 읽기 전용으로 소싱처 화면을 보고 셋 중 하나를 고른다.
   - retry: 일시 상태(탭·로그인·팝업·늦게 뜬 화면) 때문이다 → 하네스가 작업을 처음부터 다시 한다.
   - cancel: 화면에서 직접 본 근거로 살 수 없다(품절·판매 종료·옵션 없음) → 근거를 남겨 취소중으로 정리한다.
   - human: 위 둘이 아니다 → 사람이 본다.
3. 판단을 실행하는 것은 하네스 코드다. AI 는 큐·삼바웨이브에 닿는 도구가 없다.

안전
- 결제·비밀번호·삭제·취소 버튼·결제창은 코드 수준에서 막는다(repair.agent.blocked_reason 재사용). 읽기 전용이다.
- cancel 은 AI 가 화면에서 본 글자를 근거로 적어야 하고, 근거가 없거나 짧으면 human 으로 바꾼다.
- 프롬프트·화면 원문은 로그로 남기지 않는다.
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from samba_agent.repair.agent import (
    _RESULT_MAX,
    DEFAULT_REPAIR_MODEL,
    _run_sync,
    blocked_reason,
)

BridgeCall = Callable[[str, dict[str, object]], str]

DEFAULT_OPERATOR_MODEL = DEFAULT_REPAIR_MODEL
DEFAULT_MAX_TURNS = 40
DEFAULT_TIMEOUT_S = 480.0
# cancel 근거로 인정하는 최소 길이 — 화면에서 본 글자를 인용해야 한다
MIN_EVIDENCE_CHARS = 20

Action = Literal['retry', 'cancel', 'human']


@dataclass
class Verdict:
    action: Action
    reason: str = ''
    evidence: str = ''


@dataclass
class _State:
    verdict: Verdict | None = None
    notes: list[str] = field(default_factory=list)


SYSTEM_PROMPT = """너는 SAMBA 주문 하네스의 운영 대행이다. 한국어로 생각하고 도구만 쓴다.
하네스가 소싱처(무신사·ABC마트·SSG·롯데온 등)에서 주문을 사다가 결제 전에 멈췄다. 사람이 하던 상황 판단을 네가 한다.
할 일:
1. 실패 사유와 이벤트 기록을 읽는다. run_js 로 지금 화면(탭 목록·상품 페이지)을 읽기만 한다 — 클릭·입력으로 주문·장바구니를 바꾸지 않는다.
   상품 페이지는 tabs.open({url, profile}) 로 새 탭에 열어 본다(profile 은 주문 계정).
2. 판단은 decide 도구 하나로 끝낸다.
   - retry: 일시 상태 때문이다(탭이 닫힘·로그인 풀림·팝업·화면이 늦게 뜸·네트워크). 상품은 살 수 있어 보인다.
   - cancel: 화면에서 직접 본 근거로 살 수 없다(주문 옵션이 품절 표시·판매 종료 안내·옵션 목록에 그 사이즈가 없음).
     evidence 에 화면에서 읽은 글자를 그대로 인용한다(예: '240 (품절)', '판매가 종료된 상품입니다'). 추측이면 cancel 하지 마라.
   - human: 위 둘이 아니다(가격·마진 문제, 주소·결제 문제, 판단 불가).
3. 의심스러우면 human 이다. 결제가 됐을 수 있는 정황이 보이면 반드시 human.
금지: 결제하기·입력완료·구매확정 등 결제 버튼, 결제창, 비밀번호, 삭제·주문취소 버튼."""


def build_prompt(ctx: dict[str, object]) -> str:
    """대행 요청문 — 주문 요약·실패 사유·이벤트 끝부분."""
    lines = ['# 막힌 작업']
    for key in ('order', 'source', 'account', 'reason', 'tries', 'events'):
        if ctx.get(key):
            lines.append(f'## {key}\n{str(ctx[key])[:3000]}')
    return '\n'.join(lines)


class OperatorAgent:
    """막힌 작업 1건에 대해 retry·cancel·human 중 하나를 고른다. 에이전트끼리 공유해도 된다."""

    def __init__(
        self,
        *,
        model: str = DEFAULT_OPERATOR_MODEL,
        max_turns: int = DEFAULT_MAX_TURNS,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        query_fn: Any = None,
    ) -> None:
        self.model = model
        self.max_turns = max_turns
        self.timeout_s = timeout_s
        self._query_fn = query_fn

    def judge(self, *, call: BridgeCall, ctx: dict[str, object]) -> Verdict:
        """AI 로 판단한다. 도구가 결정을 못 남기면 human."""
        state = _State()
        try:
            _run_sync(
                asyncio.wait_for(self._loop(build_prompt(ctx), call, state), timeout=self.timeout_s)
            )
        except TimeoutError:
            state.notes.append('시간 초과')
        except Exception as e:  # noqa: BLE001 — SDK·CLI 오류 형식이 정해져 있지 않다
            state.notes.append(f'대행 오류: {type(e).__name__}: {str(e)[:120]}')
        if state.verdict is None:
            return Verdict('human', '; '.join(state.notes) or '판단을 남기지 못함')
        return normalize(state.verdict)

    async def _loop(self, prompt: str, call: BridgeCall, state: _State) -> None:
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, tool
        from claude_agent_sdk import query as default_query

        def text(body: str) -> dict[str, Any]:
            return {'content': [{'type': 'text', 'text': body[:_RESULT_MAX]}]}

        @tool(
            'run_js',
            'Read the current browser state (read-only). page.get({query,selector,interactive}) -> {tree}, '
            'page.url(), tabs.list()/open({url,profile})/switch(id)/close(id), sleep(ms). '
            'Do not click or type to change orders. Return a value to see it.',
            {'code': str},
        )
        async def run_js(inp: dict[str, Any]) -> dict[str, Any]:
            code = str(inp.get('code', ''))
            blocked = blocked_reason(code)
            if blocked:
                return text(blocked)
            out = await asyncio.to_thread(call, 'run_js', {'code': code, 'safety': 'no_pay'})
            return text(out)

        @tool(
            'decide',
            'Finish with your judgement. action is retry, cancel or human. For cancel, evidence must quote '
            'the text you read on the live page.',
            {'action': str, 'reason': str, 'evidence': str},
        )
        async def decide(inp: dict[str, Any]) -> dict[str, Any]:
            action = str(inp.get('action', '')).strip().lower()
            if action not in ('retry', 'cancel', 'human'):
                return text('action 은 retry·cancel·human 중 하나다.')
            state.verdict = Verdict(
                action,  # type: ignore[arg-type]
                str(inp.get('reason', '')).strip()[:300],
                str(inp.get('evidence', '')).strip()[:300],
            )
            return text('기록했다. 끝내라.')

        server = create_sdk_mcp_server(name='operator', version='1.0.0', tools=[run_js, decide])
        options = ClaudeAgentOptions(
            tools=[],
            mcp_servers={'operator': server},
            allowed_tools=['mcp__operator__run_js', 'mcp__operator__decide'],
            permission_mode='bypassPermissions',
            system_prompt=SYSTEM_PROMPT,
            model=self.model,
            max_turns=self.max_turns,
        )
        query_fn = self._query_fn or default_query
        async for _message in query_fn(prompt=prompt, options=options):
            pass


def normalize(verdict: Verdict) -> Verdict:
    """AI 판단의 안전 점검 — 근거 없는 cancel 은 human 으로 바꾼다."""
    if verdict.action == 'cancel' and len(verdict.evidence.strip()) < MIN_EVIDENCE_CHARS:
        return Verdict('human', f'cancel 근거가 부족해 사람 확인으로 바꿈: {verdict.reason}')
    return verdict
