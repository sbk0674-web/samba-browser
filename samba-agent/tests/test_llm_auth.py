"""Claude 호출 계정 넘김 — 기본 로그인이 막히면 예비 토큰으로 같은 요청을 다시 보낸다."""

import asyncio
from dataclasses import dataclass, field

import pytest

from samba_agent.llm import auth


@dataclass
class _Opts:
    env: dict[str, str] = field(default_factory=dict)


def _collect(gen) -> list[object]:
    async def run() -> list[object]:
        return [m async for m in gen]

    return asyncio.run(run())


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    auth._preferred = 0
    monkeypatch.setattr(auth, '_dotenv', dict)  # 로컬 .env 에 물들지 않게
    monkeypatch.setenv('SAMBA_CLAUDE_OAUTH_TOKENS', 'tokA, tokB')


def _fake(blocked: set[str | None], seen: list[str | None]):
    async def q(*, prompt, options):
        token = options.env.get(auth.TOKEN_ENV)
        seen.append(token)
        if token in blocked:
            raise RuntimeError('Claude Code returned an error result: Not logged in · Please run /login')
        yield f'ok:{token}'

    return q


def test_기본_로그인이_막히면_첫_예비_토큰으로_넘어간다() -> None:
    seen: list[str | None] = []
    out = _collect(auth.with_fallback(_fake({None}, seen))(prompt='x', options=_Opts()))
    assert out == ['ok:tokA']
    assert seen == ['tokA']


def test_통한_계정을_기억해_다음_호출은_바로_그_계정으로_간다() -> None:
    seen: list[str | None] = []
    wrapped = auth.with_fallback(_fake({None}, seen))
    _collect(wrapped(prompt='x', options=_Opts()))
    seen.clear()
    _collect(wrapped(prompt='y', options=_Opts()))
    assert seen == ['tokA']


def test_예비_토큰도_막히면_다음_토큰으로() -> None:
    seen: list[str | None] = []
    out = _collect(auth.with_fallback(_fake({None, 'tokA'}, seen))(prompt='x', options=_Opts()))
    assert out == ['ok:tokB']


def test_모든_계정이_막히면_마지막_오류를_그대로_올린다() -> None:
    seen: list[str | None] = []
    with pytest.raises(RuntimeError, match='Not logged in'):
        _collect(auth.with_fallback(_fake({None, 'tokA', 'tokB'}, seen))(prompt='x', options=_Opts()))
    assert seen == ['tokA', 'tokB']


def test_인증과_무관한_오류는_넘기지_않고_그대로_올린다() -> None:
    async def q(*, prompt, options):
        raise ValueError('schema mismatch')
        yield  # pragma: no cover

    with pytest.raises(ValueError):
        _collect(auth.with_fallback(q)(prompt='x', options=_Opts()))


def test_응답이_시작된_뒤의_인증_오류는_같은_요청을_다시_보내지_않는다() -> None:
    calls: list[str | None] = []

    class AssistantMessage:
        pass

    async def q(*, prompt, options):
        calls.append(options.env.get(auth.TOKEN_ENV))
        yield AssistantMessage()
        raise RuntimeError('401 unauthorized')

    with pytest.raises(RuntimeError):
        _collect(auth.with_fallback(q)(prompt='x', options=_Opts()))
    assert calls == ['tokA']


def test_구독이_모두_막히면_API키까지_시도한다(monkeypatch) -> None:
    monkeypatch.setenv('SAMBA_ANTHROPIC_API_KEY', 'sk-ant-api-test')
    seen: list[str | None] = []

    async def q(*, prompt, options):
        seen.append(options.env.get(auth.API_KEY_ENV) or options.env.get(auth.TOKEN_ENV))
        raise RuntimeError('Not logged in')
        yield  # pragma: no cover

    with pytest.raises(RuntimeError):
        _collect(auth.with_fallback(q)(prompt='x', options=_Opts()))
    assert seen == ['tokA', 'tokB', 'sk-ant-api-test']


def test_워크스페이스_ID가_있으면_API_키_슬롯에_헤더를_붙인다(monkeypatch) -> None:
    monkeypatch.setenv('SAMBA_ANTHROPIC_WORKSPACE_ID', 'wrkspc_test')
    assert auth.api_key_env('k') == {
        auth.API_KEY_ENV: 'k',
        auth.HEADERS_ENV: 'anthropic-workspace-id: wrkspc_test',
    }
    monkeypatch.delenv('SAMBA_ANTHROPIC_WORKSPACE_ID')
    assert auth.api_key_env('k') == {auth.API_KEY_ENV: 'k'}


def test_시작_알림만_온_뒤의_인증_오류도_다음_계정으로_넘긴다() -> None:
    """실기 2026-10-10: 'Not logged in' 은 시스템 시작 메시지가 먼저 오고 그 뒤에 오류가 난다."""

    class SystemMessage:
        pass

    seen: list[str | None] = []

    async def q(*, prompt, options):
        token = options.env.get(auth.TOKEN_ENV)
        seen.append(token)
        yield SystemMessage()
        if token is None:
            raise RuntimeError('Claude Code returned an error result: Not logged in')
        yield 'ok'

    out = _collect(auth.with_fallback(q)(prompt='x', options=_Opts()))
    assert out[-1] == 'ok'
    assert seen == ['tokA']


def test_인증_오류_글이_담긴_AssistantMessage_뒤에도_다음_계정으로_넘긴다() -> None:
    """실기 2026-10-10: 'Not logged in' 은 AssistantMessage 로 오고 그 뒤에 결과 오류가 난다."""

    class TextBlock:
        def __init__(self, text: str) -> None:
            self.text = text

    class AssistantMessage:
        def __init__(self, text: str) -> None:
            self.content = [TextBlock(text)]

    seen: list[str | None] = []

    async def q(*, prompt, options):
        token = options.env.get(auth.TOKEN_ENV)
        seen.append(token)
        if token is None:
            yield AssistantMessage('Not logged in · Please run /login')
            raise RuntimeError('Claude Code returned an error result: Not logged in')
        yield AssistantMessage('ok')

    out = _collect(auth.with_fallback(q)(prompt='x', options=_Opts()))
    assert out[-1].content[0].text == 'ok'
    assert seen == ['tokA']


def test_ResultMessage_한도_오류도_다음_계정으로_넘긴다() -> None:
    """실기 2026-10-11: weekly limit 이 ResultMessage 로 오면 수리·대행이 바로 human 으로 빠졌다."""

    class ResultMessage:
        is_error = True
        api_error_status = None

        def __init__(self, result: str) -> None:
            self.result = result

    seen: list[str | None] = []

    async def q(*, prompt, options):
        token = options.env.get(auth.TOKEN_ENV)
        seen.append(token)
        if token == 'tokA':
            yield ResultMessage(
                "Claude Code returned an error result: You've hit your weekly limit"
            )
            return
        yield f'ok:{token}'

    out = _collect(auth.with_fallback(q)(prompt='x', options=_Opts()))
    assert out == ['ok:tokB']
    assert seen == ['tokA', 'tokB']


def test_구독한도_초과뒤_API키로_넘긴다(monkeypatch):
    monkeypatch.setenv('SAMBA_ANTHROPIC_API_KEY', 'keyA')
    seen = []

    async def q(*, prompt, options):
        seen.append(dict(options.env))
        if auth.TOKEN_ENV in options.env:
            raise RuntimeError("You've hit your weekly limit")
        yield 'api-ok'

    assert _collect(auth.with_fallback(q)(prompt='x', options=_Opts())) == ['api-ok']
    assert len(seen) == 3
    assert seen[-1][auth.API_KEY_ENV] == 'keyA'
    assert auth.TOKEN_ENV not in seen[-1]


def test_도구실행뒤에는_API로_재호출하지_않는다(monkeypatch):
    monkeypatch.setenv('SAMBA_ANTHROPIC_API_KEY', 'keyA')
    seen = []

    class ToolUseBlock:
        pass

    class AssistantMessage:
        content = [ToolUseBlock()]

    async def q(*, prompt, options):
        seen.append(options.env)
        yield AssistantMessage()
        raise RuntimeError("You've hit your weekly limit")

    with pytest.raises(RuntimeError):
        _collect(auth.with_fallback(q)(prompt='x', options=_Opts()))
    assert len(seen) == 1
