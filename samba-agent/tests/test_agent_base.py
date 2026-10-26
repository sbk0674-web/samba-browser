# 워커 공통 껍데기 — 허용 목록 / 캡차 감지 / 구조화 출력 재요청 / 실패 변환
import json

import httpx
import pytest
import respx
from pydantic import BaseModel

from samba_agent.agents.base import AgentBase, AgentFailure, Decision, run_agent
from samba_agent.agents.contracts import AgentResult
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'


def base(decide=None, allowed=('get_page',)) -> AgentBase:
    reg = Registry.load(DEFAULT_ROOT)
    spec = reg['buyer.musinsa'].model_copy(update={'tools': allowed})
    client = BridgeClient(URL, 'a' * 64, allowed=allowed, busy_wait_s=0.0)
    return AgentBase(spec, client, decide or (lambda p, m: m(choice='x', reason='근거')))


@respx.mock
def test_허용_목록_밖_도구는_권한_부족_실패다():
    b = base()
    with pytest.raises(AgentFailure) as e:
        b.tool('phone_approve_payment', provider='토스페이')
    assert e.value.fail_reason is FailReason.PERMISSION_DENIED
    assert e.value.status == 'fail'


@respx.mock
def test_캡차_문구가_오면_사람에게_넘긴다():
    respx.post(f'{URL}/tool/get_page').mock(
        return_value=httpx.Response(
            200, json={'ok': True, 'result': 'needs_user: 캡차', 'steps': []}
        )
    )
    with pytest.raises(AgentFailure) as e:
        base().tool('get_page')
    assert e.value.fail_reason is FailReason.CAPTCHA
    assert e.value.status == 'needs_ai'


@respx.mock
def test_브릿지가_죽으면_bridge_down_실패다():
    respx.post(f'{URL}/tool/get_page').mock(side_effect=httpx.ConnectError('refused'))
    with pytest.raises(AgentFailure) as e:
        base().tool('get_page')
    assert e.value.fail_reason is FailReason.BRIDGE_DOWN


def test_구조화_출력_실패는_한_번만_다시_묻는다():
    calls = {'n': 0}

    def flaky(_p, model):
        calls['n'] += 1
        if calls['n'] == 1:
            raise ValueError('형식 오류')
        return model(choice='260', reason='사이즈 일치')

    got = base(decide=flaky).decide_once('옵션을 고르라', Decision)
    assert calls['n'] == 2
    assert got.choice == '260'


def test_두_번_실패하면_사람에게_넘긴다():
    def always_bad(_p, _m):
        raise ValueError('형식 오류')

    with pytest.raises(AgentFailure) as e:
        base(decide=always_bad).decide_once('옵션을 고르라', Decision)
    assert e.value.status == 'needs_ai'
    assert e.value.fail_reason is FailReason.UNKNOWN


def test_근거_없는_판단은_받지_않는다():
    class Empty(BaseModel):
        pass

    with pytest.raises(Exception):  # noqa: B017 — pydantic 검증 오류 타입은 신경 쓰지 않는다
        Decision(choice='x', reason='')


def test_run_agent_는_실패를_결과로_바꾼다():
    def boom() -> AgentResult:
        raise AgentFailure('fail', '품절이다', FailReason.OUT_OF_STOCK)

    got = run_agent(boom)
    assert (got.status, got.fail_reason) == ('fail', FailReason.OUT_OF_STOCK)
    assert got.reason == '품절이다'


@pytest.mark.parametrize(
    ('result', 'status', 'reason'),
    [
        # 앱의 HTTP 200 거절 문자열(src/main/agent/tools.ts, tools-phone.ts)
        ('refused: KeyMaster access policy is Never', 'fail', FailReason.PERMISSION_DENIED),
        ('refused: host is excluded from KeyMaster', 'fail', FailReason.PERMISSION_DENIED),
        (
            'refused: HOST_MISMATCH — page moved to another domain',
            'fail',
            FailReason.PERMISSION_DENIED,
        ),
        ('refused: read-only mode', 'fail', FailReason.PERMISSION_DENIED),
        ('refused: no saved script named "checkout_enter"', 'fail', FailReason.PERMISSION_DENIED),
        ('refused: insecure page (https required)', 'fail', FailReason.PERMISSION_DENIED),
        # 금고 잠김 — 재시도해도 같다(permission_denied), 사람이 풀어야 한다
        ('refused: vault-locked', 'needs_ai', FailReason.PERMISSION_DENIED),
        # 비밀 화면은 사람이 봐야 한다
        ('refused: secret screen', 'needs_ai', FailReason.CAPTCHA),
        # PayFailReason 값(src/main/phone/pay.ts)
        ('refused: card-not-found', 'fail', FailReason.CARD_MISSING),
        ('refused: card-required - call again with card set', 'fail', FailReason.CARD_MISSING),
        ('refused: pay-account-ambiguous (a, b)', 'needs_ai', FailReason.PAY_INTERRUPTED),
        ('refused: no-phone', 'needs_ai', FailReason.PAY_INTERRUPTED),
        ('refused: stuck', 'needs_ai', FailReason.PAY_INTERRUPTED),
    ],
)
@respx.mock
def test_앱의_거절_문자열을_성공으로_읽지_않는다(result, status, reason):
    # 리뷰 지적 — I5: HTTP 200 + 'refused: …' 를 성공으로 읽고 있었다
    respx.post(f'{URL}/tool/get_page').mock(
        return_value=httpx.Response(200, json={'ok': True, 'result': result, 'steps': []})
    )
    with pytest.raises(AgentFailure) as e:
        base().tool('get_page')
    assert (e.value.status, e.value.fail_reason) == (status, reason)
    # 사람이 무엇 때문인지 알 수 있게 사유 원문(비밀 없음)이 남는다
    assert result.removeprefix('refused:').strip()[:15] in e.value.reason


def test_권한_부족_거절은_재시도_대상이_아니다():
    # 키마스터 잠김·접근 정책은 다시 해도 같다(스펙 §6)
    from samba_agent.supervisor.policy import NO_RETRY_REASONS

    assert FailReason.PERMISSION_DENIED in NO_RETRY_REASONS
    assert FailReason.CARD_MISSING in NO_RETRY_REASONS


@respx.mock
def test_거절이_아닌_응답은_그대로_돌려준다():
    respx.post(f'{URL}/tool/get_page').mock(
        return_value=httpx.Response(
            200, json={'ok': True, 'result': '주문이 refused 된 적 없음', 'steps': []}
        )
    )
    assert base().tool('get_page') == '주문이 refused 된 적 없음'


@respx.mock
def test_진행_보고는_done_total_정수를_함께_보낸다():
    # 앱 progress 도구는 done/total 이 없으면 'refused: progress needs …' 로 거절한다(실기)
    route = respx.post(f'{URL}/tool/progress').mock(
        return_value=httpx.Response(200, json={'ok': True, 'result': 'ok', 'steps': []})
    )
    b = base(allowed=('progress',))
    b.step('상품 확인')
    b.step('옵션 선택')
    sent = [json.loads(c.request.content)['args'] for c in route.calls]
    assert sent[0] == {'label': '상품 확인', 'done': 0, 'total': 1}
    assert sent[1] == {'label': '옵션 선택', 'done': 1, 'total': 2}


@respx.mock
def test_로그인_제출_응답의_captcha_글자는_캡차가_아니다():
    # 앱 login 도구는 제출 뒤 'submitted: check the page for success or captcha/2FA' 를 돌려준다
    respx.post(f'{URL}/tool/login').mock(
        return_value=httpx.Response(
            200,
            json={
                'ok': True,
                'result': 'submitted: check the page for success or captcha/2FA',
                'steps': [],
            },
        )
    )
    b = base(allowed=('login',))
    assert b.tool('login', accountLabel='x').startswith('submitted')


@respx.mock
def test_결과_앞의_페이지_대화상자_줄은_떼고_JSON_을_읽는다():
    # 실기: 앱이 자동으로 닫은 alert 를 'page dialog: "…"' 로 결과 앞에 붙여 JSON 파싱이 깨졌다
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=httpx.Response(
            200,
            json={
                'ok': True,
                'result': 'page dialog: "옵션을 선택해주세요."\n{"options": [], "cost": null}',
                'steps': [],
            },
        )
    )
    b = base(allowed=('run_script',))
    out = b.json_tool('run_script', name='abc_product_snapshot', args='{}')
    # 알림 문구는 결과 객체에도 실린다 — 호출부가 사유(구매 한도 등)를 가를 수 있게
    assert out == {'options': [], 'cost': None, '_page_dialogs': ['옵션을 선택해주세요.']}
    assert [e.label for e in b.evidence] == ['페이지 알림']


def test_작업_시간_상한을_넘기면_결제자_아닌_에이전트의_도구_호출은_timeout_으로_끝난다():
    # 실기 2026-10-26: 한 작업이 AI 수리를 75분 돌며 단일 워커를 막아 큐 6건이 멈췄다
    import time

    from samba_agent.agents.base import JOB_DEADLINE, job_time_left

    agent = base()
    token = JOB_DEADLINE.set(time.monotonic() - 1)
    try:
        assert job_time_left() is not None and job_time_left() < 0
        with pytest.raises(AgentFailure) as ei:
            agent.tool('get_page')
        assert ei.value.status == 'needs_ai'
        assert ei.value.fail_reason == FailReason.TIMEOUT
    finally:
        JOB_DEADLINE.reset(token)
    assert job_time_left() is None
