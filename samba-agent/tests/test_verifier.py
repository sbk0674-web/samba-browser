# 검증 에이전트 — 셋이 맞으면 ok / 하나라도 다르면 불일치 표 / 개인정보는 payload·프롬프트로 안 샌다
import json

import httpx
import pytest
import respx

from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.agents.verifier import VerifierAgent
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.ops.masking import find_leaks
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='S1', qty=1)
EXPECTED = {'source_order_no': 'M-777', 'real_price': 89000}


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def agent(reg, decide=None) -> VerifierAgent:
    spec = reg['verifier']
    return VerifierAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        decide or (lambda p, m: m(choice='불일치 없음', reason='세 값이 같다')),
    )


def assignment(reg, *, expected=EXPECTED) -> Assignment:
    spec = reg['verifier']
    return Assignment(
        order=ORDER,
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=False,
        expected=expected,
    )


def page(obj) -> httpx.Response:
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@respx.mock
def test_셋이_같으면_통과(reg):
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page(EXPECTED), page(EXPECTED)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg))
    assert out.status == 'needs_ai'
    assert out.payload['identity_unverified']
    assert out.payload['mismatches'] == []


@respx.mock
def test_소싱처와_samba_가_다르면_불일치_표를_낸다(reg):
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({**EXPECTED, 'real_price': 91000}), page(EXPECTED)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert out.payload['mismatches'][0]['field'] == 'real_price'
    assert out.payload['mismatches'][0]['source'] == 91000


@respx.mock
def test_허용_목록_밖_도구는_거절된다(reg):
    """등록부 tools 를 progress 만 남기고 좁히면 run_script 조차 내보내지 않는다."""
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    read = respx.post(f'{URL}/tool/run_script')
    spec = reg['verifier'].model_copy(update={'tools': ('progress',)})
    restricted = VerifierAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='불일치 없음', reason='세 값이 같다'),
    )
    out = restricted(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)
    assert not read.called


@respx.mock
def test_불일치_표에_개인정보가_남지_않는다(reg):
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({**EXPECTED, 'real_price': 91000}), page(EXPECTED)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg))
    assert find_leaks(out.payload) == []
    assert find_leaks(out.reason) == []
    assert find_leaks([e.detail for e in out.evidence]) == []


@respx.mock
def test_브릿지의_원문_개인정보가_불일치_표와_프롬프트에서_가려진다(reg):
    """브릿지(소싱처 주문 상세)가 이름·전화·이메일이 섞인 원문 메모를 돌려줘도, 불일치
    표(payload)와 reason·decide_once 프롬프트 어디에도 원문이 그대로 나가면 안 된다
    (find_leaks 0건)."""
    leaky_expected = {**EXPECTED, 'note': '수취인 정상 처리'}
    leaky_source = {
        **EXPECTED,
        'note': '수취인 홍길동 010-1234-5678 kimsun@example.com 배송 요청',
    }
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page(leaky_source), page(leaky_expected)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))

    captured_prompts: list[str] = []

    def spy_decide(prompt, model):
        captured_prompts.append(prompt)
        return model(choice='불일치 있음', reason='실구매가가 다르다')

    out = agent(reg, decide=spy_decide)(assignment(reg, expected=leaky_expected))

    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert find_leaks(out.payload) == []
    assert find_leaks(out.reason) == []
    assert find_leaks([e.detail for e in out.evidence]) == []
    assert captured_prompts, '불일치가 있으면 decide_once 가 반드시 호출돼야 한다'
    assert all(find_leaks(p) == [] for p in captured_prompts)


@respx.mock
def test_대조할_기대값이_없으면_ok가_아니라_사람에게_넘긴다(reg):
    # 리뷰 지적 — Minor: 기대값이 비면 '0개가 모두 같다' 로 ok 가 나왔다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page({}))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, expected={}))
    assert out.status == 'needs_ai'
    assert out.fail_reason is FailReason.VERIFY_MISMATCH


# ---- 삼바웨이브 쪽 값은 내부 API 로(Task C) ----

WAVE_BASE = 'https://wave.test'
WAVE_API = f'{WAVE_BASE}/api/v1/internal/harness'
WAVE_ORDER = {'order_number': 'A1', 'source_site': 'MUSINSA', 'status': 'pending'}


def wave_client():
    from samba_agent.wave.client import WaveClient

    return WaveClient(WAVE_BASE, 'test-token', 'tenant-1')


def verifier_with_wave(reg, decide=None) -> VerifierAgent:
    a = agent(reg, decide)
    a.set_wave(wave_client())
    return a


@respx.mock
def test_삼바웨이브_값이_같으면_통과하고_앱_행은_읽지_않는다(reg):
    respx.get(f'{WAVE_API}/orders/A1').mock(
        return_value=httpx.Response(
            200, json={**WAVE_ORDER, 'sourcing_order_number': 'M-777', 'cost': 89000}
        )
    )
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page(EXPECTED)]  # 소싱처 상세 1번만 부른다
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = verifier_with_wave(reg)(assignment(reg))
    assert out.status == 'needs_ai'
    assert out.payload['identity_unverified']
    assert out.payload['unverified'] == []
    assert route.call_count == 1


@respx.mock
def test_삼바웨이브_값이_다르면_불일치_표를_낸다(reg):
    respx.get(f'{WAVE_API}/orders/A1').mock(
        return_value=httpx.Response(
            200, json={**WAVE_ORDER, 'sourcing_order_number': 'M-777', 'cost': 91000}
        )
    )
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(EXPECTED))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = verifier_with_wave(reg)(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert out.payload['mismatches'][0]['field'] == 'real_price'


@respx.mock
def test_삼바웨이브가_대조할_필드를_안_주면_사람에게_넘긴다(reg):
    """응답에 없는 값을 '같다' 로 치지 않는다 — 확인하지 못했다고 말한다."""
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(EXPECTED))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = verifier_with_wave(reg)(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_ai', FailReason.VERIFY_MISMATCH)
    assert set(out.payload['unverified']) == set(EXPECTED)


@respx.mock
def test_일부만_대조_가능하면_나머지는_대조_불가로_남긴다(reg):
    respx.get(f'{WAVE_API}/orders/A1').mock(
        return_value=httpx.Response(200, json={**WAVE_ORDER, 'cost': 89000})
    )
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(EXPECTED))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = verifier_with_wave(reg)(assignment(reg))
    assert out.status == 'needs_ai'
    assert out.payload['identity_unverified']
    assert out.payload['unverified'] == ['source_order_no']
    assert any('대조 불가' in e.label for e in out.evidence)


@respx.mock
def test_삼바웨이브_조회가_실패하면_그_사유로_실패한다(reg):
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(403, json={'detail': 'x'}))
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(EXPECTED))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = verifier_with_wave(reg)(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)
