# DecideFn 구현 — 정상 JSON / 코드펜스 안 JSON / JSON 없음 / 스키마 불일치 / 빈 응답
# 실제 Claude 호출은 하지 않는다 — query_fn 을 가짜 비동기 제너레이터로 주입한다.
import asyncio
import threading

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

from samba_agent.agents.base import Decision
from samba_agent.llm import auth
from samba_agent.llm.decide import make_decide


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """로컬 .env·환경의 실제 토큰·API 키로 진짜 호출이 나가지 않게 한다."""
    monkeypatch.setattr(auth, '_dotenv', dict)
    for name in (
        'SAMBA_CLAUDE_OAUTH_TOKENS',
        'SAMBA_ANTHROPIC_API_KEY',
        'SAMBA_ANTHROPIC_API_KEY_2',
        'SAMBA_ANTHROPIC_API_KEY_3',
        'SAMBA_ANTHROPIC_WORKSPACE_ID',
    ):
        monkeypatch.delenv(name, raising=False)


def assistant_text(text: str) -> AssistantMessage:
    return AssistantMessage(content=[TextBlock(text=text)], model='claude-sonnet-5')


def result_message(text: str) -> ResultMessage:
    return ResultMessage(
        subtype='success',
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id='s1',
        result=text,
    )


def fake_query(*texts: str):
    """텍스트 조각들을 AssistantMessage 로 하나씩 내는 가짜 query_fn."""

    async def _query(*, prompt: str, options: object):
        for t in texts:
            yield assistant_text(t)

    return _query


async def _empty_query(*, prompt: str, options: object):
    return
    yield  # pragma: no cover — 제너레이터로 만들기 위한 도달 불가 yield


def test_정상_JSON_은_그대로_파싱된다():
    decide = make_decide(query_fn=fake_query('{"choice":"260","reason":"사이즈 일치"}'))
    got = decide('옵션을 고르라', Decision)
    assert (got.choice, got.reason) == ('260', '사이즈 일치')


def test_코드펜스_안_JSON_도_파싱된다():
    decide = make_decide(query_fn=fake_query('```json\n{"choice":"S","reason":"재고 있음"}\n```'))
    got = decide('옵션을 고르라', Decision)
    assert got.choice == 'S'


def test_JSON_이_없으면_ValueError():
    decide = make_decide(query_fn=fake_query('그냥 텍스트다, JSON 없음'))
    with pytest.raises(ValueError):
        decide('옵션을 고르라', Decision)


def test_스키마_불일치는_ValueError():
    decide = make_decide(query_fn=fake_query('{"choice":"260"}'))  # reason 없음
    with pytest.raises(ValueError):
        decide('옵션을 고르라', Decision)


def test_빈_응답은_ValueError():
    decide = make_decide(query_fn=_empty_query)
    with pytest.raises(ValueError):
        decide('옵션을 고르라', Decision)


def test_ResultMessage_의_result_텍스트도_읽는다():
    async def _query(*, prompt: str, options: object):
        yield result_message('{"choice":"M","reason":"결과 메시지"}')

    decide = make_decide(query_fn=_query)
    got = decide('옵션을 고르라', Decision)
    assert got.choice == 'M'


def test_도구가_전부_비활성화되고_헤드리스_권한모드다():
    """tools=[] 로 도구를 완전히 막아야 한다 — allowed_tools=[] 는 이를 막지 못한다."""
    seen_options: list[object] = []

    async def _query(*, prompt: str, options: object):
        seen_options.append(options)
        yield assistant_text('{"choice":"260","reason":"확인"}')

    decide = make_decide(query_fn=_query)
    decide('옵션을 고르라', Decision)

    assert len(seen_options) == 1
    options = seen_options[0]
    assert options.tools == []
    assert options.permission_mode == 'bypassPermissions'


def test_스키마_불일치_예외_메시지에_응답_원문이_없다():
    """응답 원문(전화번호 등 개인정보 포함 가능)을 예외 메시지에 남기지 않는다."""
    phone = '010-1234-5678'
    decide = make_decide(
        query_fn=fake_query(f'{{"choice":"260","phone":"{phone}"}}')  # reason 없음
    )
    with pytest.raises(ValueError) as exc_info:
        decide('옵션을 고르라', Decision)

    message = str(exc_info.value)
    assert phone not in message
    assert '1건' in message or 'error' in message.lower() or '오류' in message


def test_실행중인_이벤트루프_안에서도_동작한다():
    """asyncio.run 을 실행 중인 루프 안에서 부르면 죽는다 — 스레드 폴백으로 살아야 한다."""
    decide = make_decide(query_fn=fake_query('{"choice":"260","reason":"루프 안"}'))
    result: dict[str, object] = {}

    async def _call_from_running_loop() -> None:
        # decide 는 동기 함수지만, 이미 실행 중인 이벤트 루프 안에서 호출된다
        result['decision'] = decide('옵션을 고르라', Decision)

    def _run_in_thread() -> None:
        asyncio.run(_call_from_running_loop())

    thread = threading.Thread(target=_run_in_thread)
    thread.start()
    thread.join(timeout=5)

    assert not thread.is_alive()
    assert result['decision'].choice == '260'


def _auth_error_result() -> ResultMessage:
    return ResultMessage(
        subtype='success',
        duration_ms=1,
        duration_api_ms=1,
        is_error=True,
        num_turns=1,
        session_id='s1',
        result='Your organization has disabled Claude subscription access',
    )


def test_auth_error_falls_back_to_next_account_token(monkeypatch):
    # 예비 토큰이 있으면 기본 로그인은 쓰지 않고, 첫 토큰이 막히면 다음 토큰으로 다시 묻는다
    monkeypatch.setenv('SAMBA_CLAUDE_OAUTH_TOKENS', 'tok-a, tok-b')
    seen: list[str | None] = []

    async def _query(*, prompt: str, options):
        tok = options.env.get('CLAUDE_CODE_OAUTH_TOKEN')
        seen.append(tok)
        if tok != 'tok-b':
            yield _auth_error_result()
            return
        yield assistant_text('{"choice": "ok", "reason": "r"}')

    result = make_decide(query_fn=_query)('p', Decision)
    assert seen == ['tok-a', 'tok-b']
    assert result.choice == "ok"


def test_auth_error_drains_stream_before_fallback(monkeypatch):
    monkeypatch.setenv('SAMBA_CLAUDE_OAUTH_TOKENS', 'tok-a, tok-b')
    drained = []

    async def _query(*, prompt: str, options):
        token = options.env.get('CLAUDE_CODE_OAUTH_TOKEN')
        if token == 'tok-a':
            yield _auth_error_result()
            drained.append(token)
            return
        assert drained == ['tok-a']
        yield assistant_text('{"choice":"ok","reason":"r"}')

    assert make_decide(query_fn=_query)('p', Decision).choice == 'ok'


def test_auth_error_on_every_account_raises_value_error(monkeypatch):
    monkeypatch.delenv('SAMBA_CLAUDE_OAUTH_TOKENS', raising=False)

    async def _query(*, prompt: str, options):
        yield _auth_error_result()

    with pytest.raises(ValueError, match='인증 실패'):
        make_decide(query_fn=_query)('p', Decision)


def test_구독이_모두_막히면_API_키로_Messages_API_를_직접_부른다(monkeypatch) -> None:
    import httpx

    monkeypatch.setenv('SAMBA_ANTHROPIC_API_KEY', 'sk-ant-api-test')
    monkeypatch.setenv('SAMBA_ANTHROPIC_WORKSPACE_ID', 'wrkspc_t')
    sent: dict[str, object] = {}

    def fake_post(url, headers, json, timeout):
        sent['headers'] = headers
        return httpx.Response(
            200,
            json={'content': [{'type': 'text', 'text': '{"choice": "retry", "reason": "api"}'}]},
            request=httpx.Request('POST', url),
        )

    monkeypatch.setattr(httpx, 'post', fake_post)

    async def blocked(*, prompt, options):
        raise RuntimeError('Not logged in')
        yield  # pragma: no cover

    out = make_decide(query_fn=blocked)('p', Decision)
    assert out.choice == 'retry'
    headers = sent['headers']
    assert headers['x-api-key'] == 'sk-ant-api-test'
    assert headers['anthropic-workspace-id'] == 'wrkspc_t'


def test_API_키의_크레딧이_없으면_다음_키로_넘기고_모두_실패하면_오류(monkeypatch) -> None:
    import httpx

    monkeypatch.setenv('SAMBA_ANTHROPIC_API_KEY', 'k1')
    monkeypatch.setenv('SAMBA_ANTHROPIC_API_KEY_2', 'k2')
    seen: list[str] = []

    def fake_post(url, headers, json, timeout):
        seen.append(headers['x-api-key'])
        return httpx.Response(
            400,
            json={'error': {'message': 'Your credit balance is too low'}},
            request=httpx.Request('POST', url),
        )

    monkeypatch.setattr(httpx, 'post', fake_post)

    async def blocked(*, prompt, options):
        raise RuntimeError('Not logged in')
        yield  # pragma: no cover

    with pytest.raises(ValueError, match='모든 계정'):
        make_decide(query_fn=blocked)('p', Decision)
    assert seen == ['k1', 'k2']


def test_구독이_한도_소진으로_막혀도_API_로_넘어간다_한도가_남아_있으면_넘어가지_않는다(monkeypatch) -> None:
    import httpx

    monkeypatch.setenv('SAMBA_ANTHROPIC_API_KEY', 'k1')
    calls: list[str] = []

    def fake_post(url, headers, json, timeout):
        calls.append('api')
        return httpx.Response(
            200,
            json={'content': [{'type': 'text', 'text': '{"choice": "x", "reason": "r"}'}]},
            request=httpx.Request('POST', url),
        )

    monkeypatch.setattr(httpx, 'post', fake_post)

    async def limited(*, prompt, options):
        raise RuntimeError("You've hit your weekly limit")
        yield  # pragma: no cover

    assert make_decide(query_fn=limited)('p', Decision).choice == 'x'
    assert calls == ['api']

    calls.clear()
    ok = fake_query('{"choice": "sub", "reason": "r"}')
    assert make_decide(query_fn=ok)('p', Decision).choice == 'sub'
    assert calls == []  # 구독이 되면 API 를 부르지 않는다
