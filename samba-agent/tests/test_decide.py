# DecideFn 구현 — 정상 JSON / 코드펜스 안 JSON / JSON 없음 / 스키마 불일치 / 빈 응답
# 실제 Claude 호출은 하지 않는다 — query_fn 을 가짜 비동기 제너레이터로 주입한다.
import asyncio
import threading

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

from samba_agent.agents.base import Decision
from samba_agent.llm.decide import make_decide


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
    # 기본 로그인 구독이 막히면 SAMBA_CLAUDE_OAUTH_TOKENS 의 다른 계정으로 다시 묻는다
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
    assert seen == [None, 'tok-a', 'tok-b']
    assert result.choice == "ok"


def test_auth_error_on_every_account_raises_value_error(monkeypatch):
    monkeypatch.delenv('SAMBA_CLAUDE_OAUTH_TOKENS', raising=False)

    async def _query(*, prompt: str, options):
        yield _auth_error_result()

    with pytest.raises(ValueError, match='인증 실패'):
        make_decide(query_fn=_query)('p', Decision)
