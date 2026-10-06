# 기록 에이전트 — dry-run / 저장 후 재확인 / 재시도는 재저장 없이 재확인만 / 한 필드라도
# 다르면 실패 / 브릿지 끊김 / 타입 정규화 / 계정은 마스킹 없는 옵션에서 / 개인정보 미노출
import json

import httpx
import pytest
import respx

from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.recorder import SAVE_SCRIPT, RecorderAgent
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.ops.masking import find_leaks
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='S1', qty=1)
ACCOUNT = 'sales-acct-01'  # 내부 판매 계정 식별자 — 고객 개인정보가 아니다
EMAIL_ACCOUNT = 'kimsun@example.com'  # 이메일 꼴 내부 계정 — 이래도 가려지면 안 된다
EXPECTED = {
    'source_order_no': 'M-777',
    'real_price': 89000,
    'shipping_fee': 0,
    'flags': '직배',
}
SAVED_VALUES = {**EXPECTED, 'account': ACCOUNT, 'memo': '포이즌 주문 자동 처리'}


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def assignment(reg, *, dry_run: bool, expected=None, account=ACCOUNT, handoff=None) -> Assignment:
    spec = reg['recorder']
    return Assignment(
        order=ORDER,
        options={'account': account} if account else {},
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=dry_run,
        expected=EXPECTED if expected is None else expected,
        handoff=handoff or {},
    )


def agent(reg) -> RecorderAgent:
    spec = reg['recorder']
    return RecorderAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='포이즌 주문 자동 처리', reason='주문번호와 소싱처를 적었다'),
    )


def page(obj) -> httpx.Response:
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@respx.mock
def test_dry_run_은_저장하지_않고_계획만_준다(reg):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    save = respx.post(f'{URL}/tool/run_script')
    out = agent(reg)(assignment(reg, dry_run=True))
    assert out.status == 'ok'
    assert out.payload['planned']['source_order_no'] == 'M-777'
    assert out.payload['planned']['account'] == ACCOUNT
    assert not save.called


@respx.mock
def test_저장된_적_없으면_저장하고_각_필드를_다시_읽어_확인한다(reg):
    route = respx.post(f'{URL}/tool/run_script')
    # 1) 기존 저장 확인(없음 — 빈 행) 2) 저장 3) 저장 확인(값 채워짐)
    route.side_effect = [page({}), page('saved'), page(SAVED_VALUES)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    assert out.payload['saved'] is True
    assert out.payload['already_saved'] is False
    assert route.call_count == 3


@respx.mock
def test_이미_저장된_주문을_다시_호출해도_저장은_한_번뿐이다(reg):
    """재시도 = 재저장이 아니다 — 이미 저장된 주문이면 저장을 건너뛰고 재확인만 한다."""
    route = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))

    # 1회차: 저장 안 됨 → 저장 → 재확인
    route.side_effect = [page({}), page('saved'), page(SAVED_VALUES)]
    a = assignment(reg, dry_run=False)
    first = agent(reg)(a)
    assert first.status == 'ok'
    assert first.payload['already_saved'] is False

    # 2회차(재시도): 이미 저장돼 있음 → 저장을 부르지 않고 재확인만
    route.side_effect = [page(SAVED_VALUES)]
    second = agent(reg)(a)
    assert second.status == 'ok'
    assert second.payload['already_saved'] is True

    save_calls = [
        c
        for c in route.calls
        if json.loads(c.request.content)['args']['name'] == 'samba_save_order'
    ]
    assert len(save_calls) == 1


@respx.mock
def test_저장은_됐는데_되읽기만_어긋나도_재저장하지_않고_실패한다(reg):
    """ "저장은 됐는데 되읽기만 어긋난" 경우 — 재저장이 아니라 사람 확인으로 넘긴다."""
    route = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    wrong = {**SAVED_VALUES, 'real_price': 12345}
    # 이미 저장된 행이 있지만(존재함) 값이 다르다 — 저장을 다시 부르면 안 된다
    route.side_effect = [page(wrong)]
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert 'real_price' in out.reason
    save_calls = [
        c
        for c in route.calls
        if json.loads(c.request.content)['args']['name'] == 'samba_save_order'
    ]
    assert len(save_calls) == 0


@respx.mock
def test_한_필드라도_다르면_실패하고_재결제하지_않는다(reg):
    wrong = {**SAVED_VALUES, 'real_price': 12345}
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({}), page('saved'), page(wrong)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert 'real_price' in out.reason


@respx.mock
def test_되읽은_숫자와_문자열_타입이_달라도_같은_값이면_통과한다(reg):
    """숫자 필드는 캐스팅해서 비교하고, 문자열은 strip 해서 비교한다(타입 정규화)."""
    stringy = {
        **SAVED_VALUES,
        'real_price': '89000',  # 문자열이지만 숫자로는 같다
        'shipping_fee': '0',
        'memo': ' 포이즌 주문 자동 처리 ',  # 앞뒤 공백만 다르다
    }
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({}), page('saved'), page(stringy)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'


@respx.mock
def test_브릿지가_끊기면_bridge_down(reg):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/run_script').mock(side_effect=httpx.ConnectError('refused'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.fail_reason is FailReason.BRIDGE_DOWN


@respx.mock
def test_허용_목록_밖_도구는_거절되고_저장을_시도하지_않는다(reg):
    """등록부 tools 를 progress 만 남기고 좁히면 run_script 조차 내보내지 않는다."""
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    save = respx.post(f'{URL}/tool/run_script')
    spec = reg['recorder'].model_copy(update={'tools': ('progress',)})
    restricted = RecorderAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='포이즌 주문 자동 처리', reason='주문번호와 소싱처를 적었다'),
    )
    out = restricted(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)
    assert not save.called


@respx.mock
def test_이메일_꼴_계정이_마스킹_없이_그대로_저장된다(reg):
    """account 는 내부 판매 계정 식별자다 — expected(마스킹 거친 결과)가 아니라
    Assignment.options 에서 받아 이메일 꼴이어도 가려지지 않는다."""
    saved = {**EXPECTED, 'account': EMAIL_ACCOUNT, 'memo': '포이즌 주문 자동 처리'}
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({}), page('saved'), page(saved)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, account=EMAIL_ACCOUNT))
    assert out.status == 'ok'
    assert out.payload['values']['account'] == EMAIL_ACCOUNT


@respx.mock
def test_저장_결과에_개인정보가_남지_않는다(reg):
    route = respx.post(f'{URL}/tool/run_script')
    route.side_effect = [page({}), page('saved'), page(SAVED_VALUES)]
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert find_leaks(out.payload) == []
    assert find_leaks(out.reason) == []
    assert find_leaks([e.detail for e in out.evidence]) == []


@respx.mock
def test_계정은_인계값에서_받아_저장한다(reg):
    # 리뷰 지적 — I1: options 에 account 를 채우는 곳이 없어 빈 계정으로 저장됐다
    saved: list[dict] = []

    def handler(request):
        body = json.loads(request.content.decode('utf-8'))
        args = json.loads(body['args']['args'])
        if body['args']['name'] == SAVE_SCRIPT:
            saved.append(args)
            return httpx.Response(200, json={'ok': True, 'result': 'saved', 'steps': []})
        stored = saved[-1] if saved else {}
        return httpx.Response(200, json={'ok': True, 'result': json.dumps(stored), 'steps': []})

    respx.post(f'{URL}/tool/run_script').mock(side_effect=handler)
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg)(
        assignment(
            reg,
            dry_run=False,
            expected={'real_price': 89000, 'source_order_no': 'M-1', 'shipping_fee': 0},
            account=None,
            handoff={'account': 'samba01@wave.co.kr'},
        )
    )
    assert out.status == 'ok'
    assert saved[0]['account'] == 'samba01@wave.co.kr'


# ---- 삼바웨이브 내부 API 기입(Task C) ----

WAVE_BASE = 'https://wave.test'
WAVE_API = f'{WAVE_BASE}/api/v1/internal/harness'
WAVE_ORDER = {'order_number': 'A1', 'source_site': 'MUSINSA', 'status': 'pending'}


def wave_client():
    from samba_agent.wave.client import WaveClient

    return WaveClient(WAVE_BASE, 'test-token', 'tenant-1')


def recorder_with_wave(reg) -> RecorderAgent:
    a = agent(reg)
    a.set_wave(wave_client())
    a.read_actual_cost = False  # 기존 기입 흐름 시험 — 상세 재계산은 아래 별도 시험
    a.mark_status = False  # 상태 변경도 아래 별도 시험
    return a


@respx.mock
def test_삼바웨이브가_있으면_앱_저장_대신_API_로_기입한다(reg):
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    script = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = recorder_with_wave(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    assert out.payload['via'] == 'wave'
    body = json.loads(put.calls[0].request.content)
    assert body['sourcing_order_number'] == 'M-777'
    assert body['cost'] == 89000
    assert not script.called  # 앱 저장 스크립트는 부르지 않는다


@respx.mock
def test_dry_run_이면_삼바웨이브에도_기입하지_않는다(reg):
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = recorder_with_wave(reg)(assignment(reg, dry_run=True))
    assert out.status == 'ok'
    assert not put.called


@respx.mock
def test_이미_다른_소싱주문번호가_있으면_덮어쓰지_않고_사람에게_넘긴다(reg):
    respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(409, json={'detail': '이미 다른 번호가 있습니다'})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = recorder_with_wave(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.DUPLICATE)


@respx.mock
def test_기입할_소싱주문번호가_없으면_사람에게_넘긴다(reg):
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = recorder_with_wave(reg)(
        assignment(reg, dry_run=False, expected={'real_price': 89000, 'shipping_fee': 0})
    )
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)
    assert not put.called


@respx.mock
def test_되읽은_값이_다르면_재결제_없이_실패한다(reg):
    respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(
        return_value=httpx.Response(
            200, json={**WAVE_ORDER, 'sourcing_order_number': 'M-999', 'cost': 89000}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = recorder_with_wave(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.VERIFY_MISMATCH)
    assert 'source_order_no' in out.reason


@respx.mock
def test_소싱_계정_id_는_주문에서_온다(reg):
    # Task D: 기록이 되돌려 주는 sourcing_account_id 는 주문이 들고 온 값이다
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    a = assignment(reg, dry_run=False)
    a = a.model_copy(update={'order': ORDER.model_copy(update={'account_id': 'acc-42'})})
    out = recorder_with_wave(reg)(a)
    assert out.status == 'ok'
    assert json.loads(put.calls[0].request.content)['sourcing_account_id'] == 'acc-42'


@respx.mock
def test_삼바웨이브_메모는_계정_수단_실결제_원가_한_줄이다(reg):
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = recorder_with_wave(reg)(
        assignment(reg, dry_run=False, handoff={'card': '현대', 'paid': 91000})
    )
    assert out.status == 'ok'
    notes = json.loads(put.calls[0].request.content)['notes']
    assert notes == f'계정 {ACCOUNT} · 수단 현대 · 실결제 91,000원 · 원가 89,000원'
    assert find_leaks(notes) == []


@respx.mock
def test_실결제액을_모르면_메모에_미확인으로_남긴다(reg):
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    recorder_with_wave(reg)(assignment(reg, dry_run=False, handoff={'card': '현대'}))
    assert '실결제 미확인' in json.loads(put.calls[0].request.content)['notes']


@respx.mock
def test_마진이_낮아도_결제된_주문은_기록한다(reg):
    """결제는 이미 끝났다 — 기록을 거르면 주문접수로 남아 재주문된다(실기 2026-09-25 포이즌 −0.7%)."""
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    detail = {'source_order_no': 'M-777', 'paid': 95950, 'points_used': 0, 'reward': 0, 'card': '무신사머니'}
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(detail))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    a = agent(reg)
    a.set_wave(wave_client())
    a.mark_status = False
    out = a(assignment(reg, dry_run=False, handoff={'margin_pct': -3.5}))
    assert out.status == 'ok'
    assert put.called


@respx.mock
def test_결제_뒤_주문_상세로_원가를_다시_계산해_기록한다(reg):
    """견적 원가(89,000) 대신 실제 상세(결제 95,950 · 적립 7,650 · 적립금 7,220)로 원가 95,520 을 기록한다."""
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    detail = {
        'source_order_no': 'M-777',
        'paid': 95950,
        'points_used': 7220,
        'reward': 7650,
        'card': '무신사머니',
    }
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(detail))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    a = agent(reg)
    a.set_wave(wave_client())
    a.mark_status = False
    out = a(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    body = json.loads(put.calls[0].request.content)
    assert body['cost'] == 95520
    assert '실결제 95,950' in body['notes']


@respx.mock
def test_주문_상세에_적립이_없으면_견적의_적립으로_원가를_낸다(reg):
    """ABC 는 적립이 구매확정 뒤 지급돼 상세에 없다 — 견적 적립 1,640 을 빼 57,560(실기 HQ2414)."""
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    detail = {'source_order_no': 'M-777', 'paid': 45000, 'points_used': 14200, 'reward': 0, 'card': '네이버페이'}
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(detail))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    a = agent(reg)
    a.set_wave(wave_client())
    a.mark_status = False
    out = a(assignment(reg, dry_run=False, handoff={'reward': 1640, 'points_used': 14200}))
    assert out.status == 'ok'
    # 네이버페이 = 현대카드 청구할인 2.7%(사용자 2026-10-02): 45,000 × 0.973 − 1,640 + 14,200
    assert json.loads(put.calls[0].request.content)['cost'] == 56345


@respx.mock
def test_이행하면_주문상태를_배송대기중으로_바꾸고_확인한다(reg):
    """주문접수로 남으면 다시 주문된다 — 상태 스크립트를 부르고 내부 API 로 wait_ship 을 확인한다."""
    respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(
        side_effect=[
            httpx.Response(200, json=WAVE_ORDER),
            httpx.Response(200, json={**WAVE_ORDER, 'status': 'wait_ship'}),
        ]
    )
    status = respx.post(f'{URL}/tool/run_script').mock(
        return_value=page({'ok': True, 'status': '배송대기중'})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    a = recorder_with_wave(reg)
    a.mark_status = True
    out = a(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    body = json.loads(status.calls[0].request.content)['args']
    assert body['name'] == 'samba_set_status'


@respx.mock
def test_배송대기중으로_못_바꾸면_사람에게_넘긴다(reg):
    respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page({'ok': False, 'note': '주문 행 없음'})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    a = recorder_with_wave(reg)
    a.mark_status = True
    out = a(assignment(reg, dry_run=False))
    assert out.status == 'needs_human'
    assert '재주문 위험' in out.reason


def test_포인트_전액_결제는_현금_0원이라도_원가를_사용_포인트_빼기_적립으로_낸다():
    from samba_agent.agents.source_detail import actual_cost

    assert actual_cost({'paid': 0, 'points_used': 66000, 'reward': 1320}) == 64680
    assert actual_cost({'paid': 0, 'points_used': 0}) is None


@pytest.mark.parametrize(
    ('site_reward', 'quoted_reward', 'cost'),
    [
        # 애드픽·샵백 적립은 원가에 넣지 않는다(사용자 2026-09-27): 100,000 × 0.973 − 사이트 적립 134
        (134, 0, 97166),
        # 상세·견적 모두 사이트 적립이 없으면 청구할인만: 100,000 × 0.973
        (0, 0, 97300),
    ],
)
@respx.mock
def test_SSG_애드픽_적립은_기록_원가에_넣지_않는다(reg, site_reward, quoted_reward, cost):
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    detail = {
        'source_order_no': 'M-777',
        'paid': 100000,
        'points_used': 0,
        'reward': site_reward,
        'card': '현대카드',
    }
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(detail))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    a = agent(reg)
    a.set_wave(wave_client())
    a.mark_status = False
    handoff = {'reward': quoted_reward, 'adpick_reward': 1600, 'route': 'adpick'}
    out = a(assignment(reg, dry_run=False, handoff=handoff))
    assert out.status == 'ok'
    assert json.loads(put.calls[0].request.content)['cost'] == cost


@respx.mock
def test_소싱주문번호가_없으면_사람에게_넘기기_전에_ABC_주문내역에서_찾아_기입한다(reg):
    # 실기 2026-09-27 job 262: ABC 네이버페이 결제는 됐는데 번호가 안 넘어와 '기입할 소싱주문번호가 없다'로 멈춤
    from datetime import datetime, timedelta

    from samba_agent.agents.payer import _KST

    at = (datetime.now(_KST) - timedelta(minutes=2)).strftime('%Y-%m-%d %H:%M:%S')
    js = respx.post(f'{URL}/tool/run_js').mock(
        return_value=page({'no': '2026092742392', 'at': at, 'amount': '41,800'})
    )
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    respx.get(f'{WAVE_API}/sourcing-accounts').mock(return_value=httpx.Response(200, json={'items': []}))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = recorder_with_wave(reg)(
        assignment(
            reg,
            dry_run=False,
            expected={'real_price': 89000, 'shipping_fee': 0},
            handoff={'buy_source': 'ABCmart', 'account': 'buyer02'},
        )
    )
    assert out.status == 'ok'
    assert js.called
    assert json.loads(put.calls[0].request.content)['sourcing_order_number'] == '2026092742392'


@respx.mock
def test_주문_계정과_같은_계정으로_사도_id_가_비어_있으면_조회해서_채운다(reg):
    # 실기 2026-09-27: 주문에 아이디만 있고 id 가 비어 ABC buyer01 결제건들의 주문계정이 빈칸이었다
    put = respx.put(f'{WAVE_API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': WAVE_ORDER})
    )
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(200, json=WAVE_ORDER))
    respx.get(f'{WAVE_API}/sourcing-accounts').mock(
        return_value=httpx.Response(
            200, json={'items': [{'id': 'sa-edel', 'source_site': 'MUSINSA', 'username': 'buyer01'}]}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    a = assignment(reg, dry_run=False)
    a = a.model_copy(
        update={
            'order': ORDER.model_copy(update={'account': 'buyer01', 'account_id': None, 'source': 'MUSINSA'}),
            'handoff': {**a.handoff, 'account': 'buyer01'},
        }
    )
    out = recorder_with_wave(reg)(a)
    assert out.status == 'ok'
    assert json.loads(put.calls[0].request.content)['sourcing_account_id'] == 'sa-edel'


def test_상세에_카드사가_없으면_구매때_고른_카드사로_청구할인을_곱한다():
    from samba_agent.agents.source_detail import actual_cost, with_pay_card

    # 롯데온 L.PAY 롯데카드(실기 2026-10-06): 결제 78,950 · 적립 437 → 78,950×0.98 − 437 = 76,934
    detail = {'paid': 78950, 'reward': 437, 'card': '간편결제'}
    assert actual_cost(detail) == 78513  # 계수 없이 계산하면 틀린 값
    shaped = with_pay_card(detail, {'card_issuer': '롯데카드'})
    assert shaped['card'] == '롯데카드'
    assert actual_cost(shaped) == 76934


def test_상세에_청구할인_카드사가_읽혔으면_구매때_카드사로_덮지_않는다():
    from samba_agent.agents.source_detail import with_pay_card

    detail = {'paid': 50000, 'card': '현대카드'}
    assert with_pay_card(detail, {'card_issuer': '롯데카드'})['card'] == '현대카드'
    # 구매 때 카드사가 청구할인 대상이 아니면 그대로 둔다
    assert with_pay_card({'paid': 50000, 'card': ''}, {'card_issuer': '신한카드'})['card'] == ''
