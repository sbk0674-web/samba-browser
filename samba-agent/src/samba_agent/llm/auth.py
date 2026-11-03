"""Claude 호출의 계정 넘김 — 기본 로그인이 막히면 등록된 예비 구독 토큰으로 이어서 부른다.

결정 호출(decide.py)만 예비 토큰을 썼고, 수리 에이전트·AI 대행·폰 구매·폰 연결은 기본 로그인만 써서 로그인이 풀리면
전부 "Not logged in" 으로 멈췄다(실기 2026-10-09 롯데온 배송지·SSG 선물 — 예비 토큰 2개는 멀쩡했다).
이 모듈은 query() 와 같은 모양의 호출 객체를 감싸 같은 규칙을 모든 호출에 적용한다.
"""

import dataclasses
import os
import re
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

# 구독 만료·차단·로그인 풀림 — 다른 계정으로 넘어가야 하는 오류(decide.py 와 같은 기준)
AUTH_ERROR_RE = re.compile(
    r'subscription access|disabled|not logged in|login|unauthori[sz]ed|'
    r'authentication|oauth|token.*(expired|invalid)|credit balance|usage limit|limit reached|hit your .{0,20}limit|weekly limit|401|403',
    re.IGNORECASE,
)
TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN'
API_KEY_ENV = 'ANTHROPIC_API_KEY'
HEADERS_ENV = 'ANTHROPIC_CUSTOM_HEADERS'

# 마지막으로 통한 계정 번호(0 = 기본 로그인, 1.. = 예비 토큰). 막힌 계정을 매번 다시 두드리지 않는다
_preferred = 0

QueryFn = Callable[..., AsyncIterator[Any]]


def _dotenv() -> dict[str, str]:
    """`.env` 를 직접 읽는다 — Settings(pydantic)는 값을 읽어도 os.environ 으로 내보내지 않아, 환경변수만 보면 비어 있다
    (실기 2026-10-10: .env 의 예비 토큰·API 키가 하네스에서 한 번도 안 쓰였다)."""
    out: dict[str, str] = {}
    root = Path(__file__).resolve().parents[3]
    for path in (Path.cwd() / '.env', root / '.env'):
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            continue
        for line in text.splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, _, value = line.partition('=')
                out.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return out


def env_value(name: str) -> str:
    """환경변수 → .env 순으로 값을 찾는다. 없으면 빈 문자열."""
    return os.environ.get(name, '').strip() or _dotenv().get(name, '').strip()


def fallback_tokens() -> list[str]:
    """기본 로그인이 막혔을 때 차례로 쓸 다른 계정의 OAuth 토큰."""
    raw = env_value('SAMBA_CLAUDE_OAUTH_TOKENS')
    return [t.strip() for t in raw.split(',') if t.strip()]


def fallback_api_keys() -> list[str]:
    """구독 계정이 모두 막혔을 때 마지막으로 쓸 Anthropic API 키들(Console 크레딧으로 결제). SAMBA_ANTHROPIC_API_KEY, _2, _3 …"""
    out: list[str] = []
    for name in ('SAMBA_ANTHROPIC_API_KEY', 'SAMBA_ANTHROPIC_API_KEY_2', 'SAMBA_ANTHROPIC_API_KEY_3'):
        v = env_value(name)
        if v and v not in out:
            out.append(v)
    return out


def api_key_env(api_key: str, index: int = 0) -> dict[str, str]:
    """API 키 슬롯의 환경변수. 워크스페이스에 묶이지 않은 키(sk-ant-usr-)는 요청마다 워크스페이스 ID 헤더가 필요하다.
    index 번째 키는 SAMBA_ANTHROPIC_WORKSPACE_ID(첫째), _2, _3 … 을 쓰고 없으면 첫째 값을 쓴다(키마다 조직이 다를 수 있다)."""
    env = {API_KEY_ENV: api_key}
    suffix = '' if index == 0 else f'_{index + 1}'
    workspace = env_value(f'SAMBA_ANTHROPIC_WORKSPACE_ID{suffix}') or env_value('SAMBA_ANTHROPIC_WORKSPACE_ID')
    if workspace:
        env[HEADERS_ENV] = f'anthropic-workspace-id: {workspace}'
    return env


def is_auth_error(error: BaseException) -> bool:
    return AUTH_ERROR_RE.search(f'{type(error).__name__} {error}') is not None


def _counts_as_started(message: Any) -> bool:
    """도구가 실행됐을 수 있는 메시지인가. 'Not logged in' 도 AssistantMessage 로 오므로(실기 2026-10-10) 인증 오류 글은 제외한다."""
    kind = type(message).__name__
    if kind == 'UserMessage':
        return True
    if kind != 'AssistantMessage':
        return False
    if getattr(message, 'error', None):
        return False
    texts: list[str] = []
    for block in getattr(message, 'content', None) or []:
        if type(block).__name__ == 'ToolUseBlock':
            return True
        texts.append(str(getattr(block, 'text', '') or ''))
    return not AUTH_ERROR_RE.search(' '.join(texts))


def _message_text(message: Any) -> str:
    """SDK 메시지에 담긴 텍스트만 모은다."""
    parts: list[str] = []
    for attr in ('result', 'error', 'message'):
        value = getattr(message, attr, None)
        if value:
            parts.append(str(value))
    for block in getattr(message, 'content', None) or []:
        text = getattr(block, 'text', None)
        if text:
            parts.append(str(text))
    return ' '.join(parts)


def _is_auth_result(message: Any) -> bool:
    """Claude SDK 가 예외 대신 ResultMessage 로 인증·한도 오류를 돌려준 경우."""
    if type(message).__name__ != 'ResultMessage' or not getattr(message, 'is_error', False):
        return False
    status = getattr(message, 'api_error_status', None)
    return status in (401, 403) or AUTH_ERROR_RE.search(_message_text(message)) is not None


def with_fallback(query_fn: QueryFn) -> QueryFn:
    """query_fn 을 감싼다. 응답이 한 줄도 오기 전에 인증 오류가 나면 다음 계정으로 같은 요청을 다시 보낸다."""

    async def run(*, prompt: Any, options: Any) -> AsyncIterator[Any]:
        global _preferred
        tokens = fallback_tokens()
        keys = fallback_api_keys()
        # 슬롯: 0 = 기본 로그인, 1..n = 예비 구독 토큰, 마지막 = API 키(있을 때만)
        # 예비 구독 토큰이 있으면 그것만 쓴다 — 기본 로그인(~/.claude)은 로그아웃돼 있어 매번 실패하는 죽은 칸이다(사용자 2026-10-10 "기본 없애").
        # 토큰이 하나도 없을 때만 기본 로그인을 쓴다
        slots = list(range(1, len(tokens) + 1)) if tokens else [0]
        slots += list(range(len(tokens) + 1, len(tokens) + len(keys) + 1))
        start = _preferred if _preferred in slots else slots[0]
        order = slots[slots.index(start) :] + slots[: slots.index(start)]
        last: BaseException | None = None
        for slot in order:
            slot_error: BaseException | None = None
            env = dict(getattr(options, 'env', None) or {})
            env.pop(TOKEN_ENV, None)
            env.pop(API_KEY_ENV, None)
            env.pop(HEADERS_ENV, None)
            if 0 < slot <= len(tokens):
                env[TOKEN_ENV] = tokens[slot - 1]
            elif slot > len(tokens):
                key_index = slot - len(tokens) - 1
                env.update(api_key_env(keys[key_index], key_index))
            tried = dataclasses.replace(options, env=env)
            started = False
            try:
                async for message in query_fn(prompt=prompt, options=tried):
                    if not started and _is_auth_result(message):
                        slot_error = RuntimeError(_message_text(message) or 'Claude 인증 실패')
                        continue
                    # 시작 알림(SystemMessage)은 도구가 실행됐다는 뜻이 아니다 — 모델 응답·도구 결과가 온 뒤부터 '시작'으로 본다
                    if _counts_as_started(message):
                        started = True
                    yield message
                if slot_error is not None and slot != order[-1] and is_auth_error(slot_error):
                    last = slot_error
                    continue
                if slot_error is not None and is_auth_error(slot_error):
                    raise slot_error
                _preferred = slot
                return
            except Exception as e:
                # 이미 응답이 오기 시작했으면(도구가 실행됐을 수 있다) 같은 요청을 다시 보내지 않는다
                if started or not is_auth_error(e):
                    raise
                last = e
        assert last is not None
        raise last

    return run
