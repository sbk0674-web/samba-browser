"""`DecideFn`(프롬프트 → pydantic 모델) 을 claude-agent-sdk 로 구현한다.

`agents/base.py` 의 `DecideFn = Callable[[str, type[BaseModel]], BaseModel]` 과 모양을 맞춘다.
도구는 쓰지 않는다 — `allowed_tools=[]` 는 빈 리스트를 그냥 무시하고(SDK 는 이를
"자동 승인 목록 없음" 으로만 읽는다), `allowed_tools` 자체가 승인 목록일 뿐 도구를
막는 옵션이 아니다. 도구를 아예 끄려면 `tools=[]`(CLI 로는 `--tools ""`) 를 써야 한다.
헤드리스 실행이 권한 프롬프트에 멎지 않도록 `permission_mode='bypassPermissions'` 도
같이 준다 — 도구가 하나도 없어 실제로 승인할 호출은 없지만, CLI 가 다른 사유로
프롬프트를 띄워 멎는 상황 자체를 막는다.
Claude 구독 로그인(로컬 Claude Code 인증)을 그대로 쓴다 — API 키는 쓰지 않는다.
그 계정 구독이 만료·차단되면(인증 오류) `SAMBA_CLAUDE_OAUTH_TOKENS`(쉼표 구분,
`claude setup-token` 으로 만든 다른 계정 토큰)를 차례로 써서 다시 묻는다.

비밀·개인정보 보호를 위해 프롬프트와 응답 원문은 어디에도 로그로 남기지 않는다.
"""

import asyncio
import concurrent.futures
import re
from collections.abc import AsyncIterator, Callable
from typing import Any

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, TextBlock
from claude_agent_sdk import query as _default_query
from pydantic import BaseModel, ValidationError

from samba_agent.agents.base import DecideFn

DEFAULT_MODEL = 'claude-sonnet-5-5'
# 구조화 출력 재요청은 base.decide_once 가 1 회 한다 — 여기서는 재시도하지 않는다
DEFAULT_MAX_TURNS = 1

# query() 와 같은 모양(비동기 제너레이터를 돌려주는 호출 가능 객체) — 테스트는 가짜로 주입한다
QueryFn = Callable[..., AsyncIterator[Any]]

# 구독 만료·차단·로그인 풀림 — 다른 계정으로 넘어가야 하는 오류
_AUTH_ERROR_RE = re.compile(
    r'subscription access|disabled|not logged in|login|unauthori[sz]ed|usage limit|limit reached|hit your .{0,20}limit|weekly limit|'
    r'authentication|oauth|token.*(expired|invalid)|credit balance|401|403',
    re.IGNORECASE,
)


class _AuthError(Exception):
    """현재 계정으로는 호출할 수 없다 — 다음 계정으로 넘긴다."""


def fallback_tokens() -> list[str]:
    """기본 로그인이 막혔을 때 차례로 쓸 다른 계정의 OAuth 토큰."""
    from samba_agent.llm.auth import env_value

    raw = env_value('SAMBA_CLAUDE_OAUTH_TOKENS')
    return [t.strip() for t in raw.split(',') if t.strip()]


def make_decide(
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
    query_fn: QueryFn | None = None,
) -> DecideFn:
    """DecideFn 을 만든다. `query_fn` 을 주입하면 실제 Claude 호출 없이 테스트할 수 있다."""
    qf = query_fn or _default_query

    def decide(prompt: str, schema: type[BaseModel]) -> BaseModel:
        # 구독: 기본 로그인 → 막히면 다른 계정 토큰 순서로(Claude Code 프로그램 경유)
        # 예비 토큰이 있으면 그것만 쓴다(기본 로그인은 로그아웃된 죽은 칸). 없을 때만 기본 로그인
        envs: list[dict[str, str]] = [
            {'CLAUDE_CODE_OAUTH_TOKEN': t} for t in fallback_tokens()
        ] or [{}]
        for env in envs:
            try:
                return _run(_ask(qf, prompt, schema, model, max_turns, env))
            except _AuthError:
                continue
        # 구독이 모두 막혔으면 Console API 키로 Messages API 를 직접 부른다 —
        # Max 플랜 API 크레딧은 Claude Code 에는 적용되지 않고 API 직접 호출에만 적용된다(공식 문서, 실측 2026-10-10)
        from samba_agent.llm.auth import env_value, fallback_api_keys

        for i, key in enumerate(fallback_api_keys()):
            suffix = '' if i == 0 else f'_{i + 1}'
            workspace = env_value(f'SAMBA_ANTHROPIC_WORKSPACE_ID{suffix}') or env_value(
                'SAMBA_ANTHROPIC_WORKSPACE_ID'
            )
            try:
                return _ask_api(prompt, schema, model, key, workspace)
            except _AuthError:
                continue
        raise ValueError('Claude 인증 실패 — 모든 계정이 막혔다')

    return decide


def _run(coro: Any) -> BaseModel:
    """코루틴을 돌려 결과를 받는다.

    이미 실행 중인 이벤트 루프 안에서는 ``asyncio.run`` 이 바로 죽는다
    (``RuntimeError: asyncio.run() cannot be called from a running event loop``).
    그런 경우엔 별도 스레드를 하나 띄워 그 안에서 새 루프로 돌린다.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # 실행 중인 루프가 없다 — 평소대로 돌린다
        return asyncio.run(coro)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(asyncio.run, coro)
        return future.result()


async def _ask(
    query_fn: QueryFn,
    prompt: str,
    schema: type[BaseModel],
    model: str,
    max_turns: int,
    env: dict[str, str] | None = None,
) -> BaseModel:
    """한 번 물어서 스키마에 맞는 모델을 돌려준다. 실패는 전부 ValueError 로 바꾼다."""
    options = ClaudeAgentOptions(
        tools=[],  # 도구 전체 비활성화(--tools ""). allowed_tools=[] 는 도구를 막지 못한다
        permission_mode='bypassPermissions',  # 헤드리스에서 권한 프롬프트로 멎지 않게
        system_prompt=(
            f'JSON 만 출력하라. 다른 말은 붙이지 마라. 스키마: {schema.model_json_schema()}'
        ),
        model=model,
        max_turns=max_turns,
        env=env or {},
    )
    text = ''
    auth_error = False
    try:
        async for message in query_fn(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        text += block.text
            elif isinstance(message, ResultMessage):
                if message.is_error and (
                    message.api_error_status in (401, 403)
                    or _AUTH_ERROR_RE.search(str(message.result or ''))
                ):
                    auth_error = True
                    # SDK 스트림을 끝까지 비워 종료 중 재진입 오류를 막는다.
                    continue
                if message.result:
                    text += message.result
    except _AuthError:
        raise
    except Exception as e:
        if _AUTH_ERROR_RE.search(str(e)):
            raise _AuthError() from None
        raise
    if auth_error:
        raise _AuthError()

    raw = _extract_first_json_object(text)
    if raw is None:
        raise ValueError('응답에서 JSON 객체를 찾지 못했다')
    try:
        return schema.model_validate_json(raw)
    except ValidationError as e:
        # 응답 원문(e 의 input_value)은 개인정보를 담을 수 있어 메시지에 넣지 않는다 —
        # 오류 개수와 필드 경로만 남긴다
        paths = ', '.join('.'.join(str(p) for p in err['loc']) for err in e.errors())
        raise ValueError(
            f'응답이 스키마와 맞지 않다: 오류 {e.error_count()}건, 필드 [{paths}]'
        ) from None


API_URL = 'https://api.anthropic.com/v1/messages'
API_MAX_TOKENS = 4096


def _parse_schema_json(text: str, schema: type[BaseModel]) -> BaseModel:
    raw = _extract_first_json_object(text)
    if raw is None:
        raise ValueError('응답에서 JSON 객체를 찾지 못했다')
    try:
        return schema.model_validate_json(raw)
    except ValidationError as e:
        paths = ', '.join('.'.join(str(p) for p in err['loc']) for err in e.errors())
        raise ValueError(
            f'응답이 스키마와 맞지 않다: 오류 {e.error_count()}건, 필드 [{paths}]'
        ) from None


def _ask_api(
    prompt: str, schema: type[BaseModel], model: str, api_key: str, workspace: str = ''
) -> BaseModel:
    """Messages API 를 직접 불러 스키마에 맞는 모델을 돌려준다(API 크레딧 사용). 인증·크레딧 문제는 _AuthError."""
    import httpx

    headers = {
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
    }
    if workspace:
        headers['anthropic-workspace-id'] = workspace
    body = {
        'model': model,
        'max_tokens': API_MAX_TOKENS,
        'system': f'JSON 만 출력하라. 다른 말은 붙이지 마라. 스키마: {schema.model_json_schema()}',
        'messages': [{'role': 'user', 'content': prompt}],
    }
    try:
        r = httpx.post(API_URL, headers=headers, json=body, timeout=120)
    except httpx.HTTPError as e:
        raise ValueError(f'API 호출 실패: {type(e).__name__}') from None
    if r.status_code in (401, 403) or (
        r.status_code == 400 and _AUTH_ERROR_RE.search(r.text)
    ):
        raise _AuthError()
    if r.status_code != 200:
        raise ValueError(f'API 응답 오류: HTTP {r.status_code}')
    blocks = r.json().get('content') or []
    text = ''.join(str(b.get('text', '')) for b in blocks if b.get('type') == 'text')
    return _parse_schema_json(text, schema)


def _extract_first_json_object(text: str) -> str | None:
    """텍스트에서 첫 JSON 객체를 뽑는다. 코드펜스(```json ... ```) 안에 있어도 된다."""
    start = text.find('{')
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None
