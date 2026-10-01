# 구매 에이전트 — 정상 / 품절 / 중복 / 배송지 / 카드 없음 / 캡차 / 결제창은 건드리지 않는다
import json

import httpx
import pytest
import respx

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import BuyerAgent, shipping_matches, snapshot_args
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.ops.masking import find_leaks
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ORDER = OrderRef(order_no='A1', source='무신사', seller='쿠팡', sku='SKU-260', qty=1)


@pytest.fixture
def generic_musinsa(monkeypatch):
    """계정 비교 로직 시험용 — 무신사의 플레이북 고정 계정(buy_accounts)을 잠시 비워 일반 비교 경로를 탄다."""
    from samba_agent.agents import buyer as buyer_mod

    real = buyer_mod.source_of

    def patched(name):
        src = real(name)
        return src.model_copy(update={'buy_accounts': [], 'fallback_account': None})

    monkeypatch.setattr(buyer_mod, 'source_of', patched)
    return patched


# 배송지 표본 — 테스트에서만 쓰는 가짜 개인정보. 어디에도 원문으로 남으면 안 된다
SHIPPING = {'name': '홍길동', 'phone': '010-1234-5678', 'address': '서울특별시 강남구 테헤란로 1'}

# 배송지 스크립트의 반영 확인 응답 — 이름·주소를 메아리치고 비워 둔 전화 칸 번호를 알려 준다
SHIPPING_ECHO = {'name': SHIPPING['name'], 'address': SHIPPING['address'], 'phone_field_id': 42}

SNAPSHOT_OK = {
    'options': ['260', '265'],
    'coupons': {'a***@x.com': 5000},
    'methods': ['현대', '삼성'],
    'cost': 89000,
    'margin_pct': 12.5,
    'shipping': SHIPPING,
}


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def assignment(reg, *, dry_run: bool = True) -> Assignment:
    spec = reg['buyer.musinsa']
    return Assignment(
        order=ORDER,
        options={'card': '현대'},
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=dry_run,
    )


def agent(reg, decide) -> BuyerAgent:
    spec = reg['buyer.musinsa']
    return BuyerAgent(
        spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), decide
    )


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


def mock_fill_secret(result: str = 'ok: filled identity.phone'):
    """앱 fill_secret — 번호는 앱이 키마스터에서 채우고 우리에게는 결과 문구만 온다."""
    return respx.post(f'{URL}/tool/fill_secret').mock(return_value=page(result))


def route_run_script(responses: dict[str, object]) -> object:
    """저장 스크립트 이름(run_script 의 args.name)별로 다른 JSON 을 돌려주는 respx 핸들러.

    respx 는 URL 로만 매칭해서 같은 /tool/run_script 로 스냅샷·배송지 호출이 모두 들어온다 —
    본문의 스크립트 이름으로 직접 분기한다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        name = body.get('args', {}).get('name')
        if name not in responses and str(name).endswith('_confirm_shipping'):
            # 확정 스크립트는 표본에 없어도 받은 인자를 되읽기로 메아리친다
            args = json.loads(body['args'].get('args') or '{}')
            return page(json.dumps({'ok': True, **args}, ensure_ascii=False))
        if name not in responses and str(name).endswith('_payment_quotes'):
            # 결제수단 견적은 표본에 없으면 "견적 없음" — 스냅샷 원가로 진행한다
            return page('{"quotes": []}')
        if name not in responses and str(name).endswith('_normal_price'):
            return page('{"normal_price": 150000}')  # 정가 표본
        if name not in responses and str(name).endswith('_select_shipping'):
            return page('{"ok": false, "found": false, "note": "목록에 맞는 배송지 없음"}')
        if name not in responses and str(name).endswith('_order_prep'):
            return page('{"ok": true, "points_balance": 220, "points_used": 0, "prepay": true}')
        if name not in responses:
            raise AssertionError(f'예상치 못한 run_script 호출: {name}')
        return page(json.dumps(responses[name], ensure_ascii=False))

    return handler


def mock_accounts(*labels: str, locked: bool = False, login: str = 'already signed in (logout)'):
    """주문 계정이 없는 주문의 계정 경로 — 기본 탭 열기·계정 목록·계정별 로그인을 mock 한다.

    list_accounts 는 앱처럼 풀린 금고면 배열을, 잠겼으면 {vaultLocked, accounts} 를 돌려준다.
    """
    accounts = [
        {'label': x, 'username': 'a***', 'types': ['login'], 'payments': ['site', 'musinsapay', 'naver'], 'tags': []}
        for x in labels or ('acc1',)
    ]
    body = {'vaultLocked': True, 'accounts': accounts} if locked else accounts
    respx.post(f'{URL}/tool/new_tab').mock(return_value=page('ok: tab t9'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/login').mock(return_value=page(login))
    return respx.post(f'{URL}/tool/list_accounts').mock(
        return_value=page(json.dumps(body, ensure_ascii=False))
    )


@respx.mock
def test_정상이면_계정_카드_원가_배송지를_돌려준다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {
                'musinsa_product_snapshot': SNAPSHOT_OK,
                'musinsa_set_shipping': SHIPPING_ECHO,  # 그대로 반영됐다고 메아리쳐 준다
            }
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='주문 사이즈와 일치'))(assignment(reg))
    assert out.status == 'ok'
    assert out.payload['card'] == '현대'
    assert out.payload['cost'] == 89000
    assert out.payload['shipping_set'] is True
    assert out.reason  # 근거가 반드시 있다
    assert [e.label for e in out.evidence]


@respx.mock
def test_배송지_원문은_결과_어디에도_남지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='주문 사이즈와 일치'))(assignment(reg))
    dumped = json.dumps(out.model_dump(mode='json'), ensure_ascii=False)
    assert find_leaks(dumped) == []
    assert SHIPPING['name'] not in dumped
    assert SHIPPING['phone'].replace('-', '') not in dumped.replace('-', '')


@respx.mock
def test_옵션을_못_읽었으면_품절이_아니라_확인으로_넘긴다(reg):
    """선택지가 비었고 품절 표시도 없으면 스크립트가 못 읽은 것 — 재고X 로 자르지 않는다(실기 2026-09-28)."""
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page('{"options":[],"coupons":{},"methods":["현대"],"cost":0,"margin_pct":0}')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)
    assert '품절 미확인' in out.reason


@respx.mock
def test_상품_전체_품절_표시면_확정_품절이다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page('{"options":[],"sold_out":true,"coupons":{},"methods":["현대"],"cost":0,"margin_pct":0}')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.OUT_OF_STOCK)
    assert '확정 품절' in out.reason


@respx.mock
def test_이미_구매한_흔적이_있으면_중복으로_거절한다(reg):
    dup = {**SNAPSHOT_OK, 'already_ordered': True}
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page(json.dumps(dup, ensure_ascii=False))
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.DUPLICATE)


@pytest.mark.parametrize('locked', [True, False])
@respx.mock
def test_금고가_잠겼거나_계정이_없으면_사람에게_넘긴다(generic_musinsa, reg, locked):
    snap = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    if locked:
        mock_accounts('A', 'B', locked=True)
    else:
        mock_accounts()
        respx.post(f'{URL}/tool/list_accounts').mock(return_value=page('[]'))
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.PERMISSION_DENIED)
    assert '소싱처 계정 없음/금고 잠김: MUSINSA' in out.reason
    assert not snap.called


@respx.mock
def test_배송지를_못_받으면_사람에게_넘긴다(reg):
    no_shipping = {**SNAPSHOT_OK, 'shipping': {}}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': no_shipping, 'samba_order_shipping': {}}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)
    assert '홍길동' not in out.reason
    assert find_leaks(out.reason) == []


@respx.mock
def test_배송지_입력_검증이_어긋나면_사람에게_넘긴다(reg):
    # 반영 확인 응답이 요청과 다르다(주소가 빠졌다) — 마스킹 비교에서 어긋난다
    bad_echo = {**SHIPPING_ECHO, 'address': ''}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': bad_echo}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)


@respx.mock
def test_지시받은_카드가_없으면_거절한다(reg):
    no_card = {**SNAPSHOT_OK, 'methods': ['신한']}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': no_card, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)


@respx.mock
def test_캡차가_뜨면_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('needs_user: 캡차 확인 필요'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.CAPTCHA)


@respx.mock
def test_결제_도구는_부르지도_못한다(reg):
    route = respx.post(f'{URL}/tool/phone_approve_payment')
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    agent(reg, lambda p, m: m(choice='260', reason='x'))(assignment(reg))
    assert not route.called


@respx.mock
def test_dry_run이면_부수효과_도구를_아예_부르지_않는다(reg):
    route = respx.post(f'{URL}/tool/phone_tap')
    b = agent(reg, lambda p, m: m(choice='260', reason='x'))
    b._dry_run = True
    with pytest.raises(AgentFailure) as e:
        b.tool('phone_tap', x=1, y=1)
    assert (e.value.status, e.value.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)
    assert not route.called


@respx.mock
def test_dry_run이_아니면_부수효과_도구_호출은_막지_않는다(reg):
    route = respx.post(f'{URL}/tool/save_script').mock(return_value=page('ok'))
    b = agent(reg, lambda p, m: m(choice='260', reason='x'))
    b._dry_run = False
    b.tool('save_script', name='x', args='{}')
    assert route.called


def _login_mocks(*login_results: str):
    """로그인 확인 경로의 도구 3개를 mock 한다. login 은 호출 순서대로 답한다."""
    respx.post(f'{URL}/tool/new_tab').mock(return_value=page('ok: tab t9'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    results = list(login_results)
    return respx.post(f'{URL}/tool/login').mock(
        side_effect=lambda _req: page(results.pop(0) if len(results) > 1 else results[0])
    )


ORDER_WITH_ACCOUNT = ORDER.model_copy(update={'account': 'buyer01'})


def assignment_with_account(reg) -> Assignment:
    # 계정 하나로 사는 것은 작업 옵션(account)으로 사람이 정했을 때뿐이다 — 주문계정만으로는 고르지 않는다
    base = assignment(reg)
    return base.model_copy(update={'order': ORDER_WITH_ACCOUNT, 'options': {**base.options, 'account': 'buyer01'}})


@respx.mock
def test_소싱_계정이_있으면_스냅샷_전에_로그인한다(generic_musinsa, reg):
    login = _login_mocks(
        'submitted: check the page for success or captcha/2FA', 'already signed in (logout)'
    )
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'ok'
    assert login.call_count == 2  # 제출 뒤 한 번 더 불러 로그인됐는지 확인한다
    assert json.loads(login.calls[0].request.content)['args'] == {'accountLabel': 'buyer01'}
    # 계정 이름의 프로필로 탭을 열었다
    new_tab = next(c for c in respx.calls if c.request.url.path.endswith('/new_tab'))
    assert json.loads(new_tab.request.content)['args']['profile'] == 'buyer01'
    assert any('로그인 완료' in e.detail for e in out.evidence)


@respx.mock
def test_이미_로그인돼_있으면_바로_진행한다(generic_musinsa, reg):
    login = _login_mocks('already signed in (logout)')
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': SNAPSHOT_OK, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제수단 선택'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'ok'
    assert login.call_count == 1


@respx.mock
def test_저장된_계정이_없으면_사람에게_넘긴다(generic_musinsa, reg):
    _login_mocks('account not found: use list_accounts')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.PERMISSION_DENIED
    assert '로그인 실패' in out.reason


@respx.mock
def test_스냅샷의_계정이_주문_계정과_다르면_사람에게_넘긴다(generic_musinsa, reg):
    _login_mocks('already signed in (logout)')
    other = {**SNAPSHOT_OK, 'account': 'buyer02'}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'musinsa_product_snapshot': other})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.PERMISSION_DENIED
    assert 'buyer02' in out.reason


@respx.mock
def test_실패해도_그때까지의_근거는_결과에_남는다(reg):
    # 실기: 실패 사유만 남고 옵션 목록 등 근거가 비어 진단이 막혔다
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {
                'musinsa_product_snapshot': {**SNAPSHOT_OK, 'methods': ['신한']},
                'musinsa_set_shipping': SHIPPING_ECHO,
            }
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'fail'
    labels = [e.label for e in out.evidence]
    assert {'계정 선택', '옵션 목록', '옵션 선택', '배송지'} <= set(labels)


def test_스냅샷_인자는_상품_ID와_사이즈를_우선한다():
    """실기: 판매 상품명을 ABC마트 검색어로 써서 검색 결과 페이지에서 '품절'로 오판했다."""
    abc = OrderRef(
        order_no='A1',
        source='ABC마트',
        seller='신세계몰',
        sku='매장정품 코르테즈 [265]',
        qty=1,
        option='265',
        product_url='https://abcmart.a-rt.com/product/new?prdtNo=1010118346',
    )
    assert json.loads(snapshot_args('buyer.abc', abc)) == {
        'sku': '1010118346',
        'qty': 1,
        'size': '265',
    }
    # ID 규칙이 없는 소싱처는 URL 그대로, URL 도 없으면 판매 상품명
    musinsa = abc.model_copy(update={'product_url': 'https://www.musinsa.com/products/1'})
    assert (
        json.loads(snapshot_args('buyer.musinsa', musinsa))['sku']
        == 'https://www.musinsa.com/products/1'
    )
    plain = abc.model_copy(update={'product_url': None, 'option': None})
    assert json.loads(snapshot_args('buyer.abc', plain)) == {
        'sku': '매장정품 코르테즈 [265]',
        'qty': 1,
    }
    with_account = abc.model_copy(update={'account': 'buyer01'})
    with_acc = json.loads(snapshot_args('buyer.abc', with_account))
    assert with_acc['account'] == 'buyer01' and with_acc['profile'] == 'buyer01'


def test_스냅샷_인자는_따옴표가_있어도_JSON_이다():
    order = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='SKU "A"', qty=2)
    assert json.loads(snapshot_args('buyer.musinsa', order)) == {'sku': 'SKU "A"', 'qty': 2}


# ---- 삼바웨이브 배송지 공급자 · 표시 이름 계정(Task C) · 전화는 신원정보(P2) ----

WAVE_BASE = 'https://wave.test'
WAVE_API = f'{WAVE_BASE}/api/v1/internal/harness'
# 삼바웨이브 상세 응답 — 고객 전화번호가 실려 와도 하네스는 버린다
CUSTOMER = {
    'name': '홍길동',
    'phone': '010-1234-5678',
    'address': '서울특별시 강남구 테헤란로 1',
    'address_detail': '2층',
    'postal_code': '06234',
}


def wave_client():
    from samba_agent.wave.client import WaveClient

    return WaveClient(WAVE_BASE, 'test-token', 'tenant-1')


def shipping_provider():
    from samba_agent.agents.factory import _shipping_provider

    return _shipping_provider(wave_client())


def buyer_with_wave(reg, decide):
    a = agent(reg, decide)
    a.set_shipping_provider(shipping_provider())
    return a


def _recording_handler(snapshot_name, applied, echo_extra=None, snapshot=None):
    """스냅샷은 표본을, 배송지 스크립트는 받은 인자(+전화 칸 번호)를 메아리친다."""
    extra = {'phone_field_id': 42} if echo_extra is None else echo_extra

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body['args']['name'] == snapshot_name:
            snap = dict(snapshot or SNAPSHOT_OK)
            if snapshot_name.startswith('abc_'):
                # ABC마트·그랜드스테이지는 네이버페이로만 결제한다(sources.yaml pay_provider)
                snap['methods'] = [*snap.get('methods', []), '네이버페이']
            return page(json.dumps(snap, ensure_ascii=False))
        if body['args']['name'].endswith('_payment_quotes'):
            return page('{"quotes": []}')  # 견적 없음 — 스냅샷 원가로 진행
        if body['args']['name'].endswith('_normal_price'):
            return page('{"normal_price": 150000}')
        if body['args']['name'].endswith('_select_shipping'):
            return page('{"ok": false, "found": false, "note": "목록에 맞는 배송지 없음"}')
        if body['args']['name'].endswith('_order_prep'):
            return page('{"ok": true, "points_balance": 220, "points_used": 0, "prepay": true}')
        args = json.loads(body['args']['args'])
        if body['args']['name'].endswith('_confirm_shipping'):
            # 확정 스크립트 — 폼을 저장한 뒤 주문서에서 되읽은 값을 그대로 메아리친다
            return page(json.dumps({'ok': True, **args}, ensure_ascii=False))
        applied.update(args)
        return page(json.dumps({**applied, **extra}, ensure_ascii=False))

    return handler


def _wave_direct():
    return respx.get(f'{WAVE_API}/orders/A1').mock(
        return_value=httpx.Response(
            200, json={'order_number': 'A1', 'order_type': 'direct', 'shipping': CUSTOMER}
        )
    )


@respx.mock
def test_삼바웨이브가_있으면_배송지는_거기서_받는다(reg):
    """직배 — 스냅샷에 실린 값보다 삼바웨이브 상세의 고객 이름·주소가 우선한다."""
    _wave_direct()
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler('musinsa_product_snapshot', applied)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = buyer_with_wave(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert applied['address'] == CUSTOMER['address']
    assert applied['postal_code'] == '06234' and applied['address_detail'] == '2층'
    dumped = json.dumps(out.model_dump(mode='json'), ensure_ascii=False)
    assert find_leaks(dumped) == []
    assert CUSTOMER['address'] not in dumped


@respx.mock
def test_삼바웨이브_배송지_조회가_실패하면_그_사유로_실패한다(reg):
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(403, json={'detail': 'x'}))
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'musinsa_product_snapshot': SNAPSHOT_OK})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = buyer_with_wave(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.PERMISSION_DENIED)


@respx.mock
def test_스냅샷이_표시_이름을_돌려주면_대조를_건너뛴다(generic_musinsa, reg):
    """실기: 사이트가 로그인 아이디 대신 한글 별명(김사무1)을 돌려준다 — 불일치로 보지 않는다."""
    snap = {**SNAPSHOT_OK, 'account': '김사무1'}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': snap, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    respx.post(f'{URL}/tool/new_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    a = assignment_with_account(reg)
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(a)
    assert out.status == 'ok'
    assert any('표시 이름이라 대조 불가' in e.detail for e in out.evidence)


@respx.mock
def test_스냅샷이_다른_아이디를_돌려주면_사람에게_넘긴다(generic_musinsa, reg):
    snap = {**SNAPSHOT_OK, 'account': 'someone_else'}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'musinsa_product_snapshot': snap})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/new_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    a = assignment_with_account(reg)
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(a)
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.PERMISSION_DENIED)


@respx.mock
def test_고객_전화번호는_어디에도_입력하지_않는다(reg):
    # 사용자 결정(2026-09-23): 전화 칸은 앱이 키마스터 신원정보로 채운다 — 하네스는 번호를 보지 않는다
    _wave_direct()
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler(
            'musinsa_product_snapshot', applied, echo_extra={'phone_field_id': 7}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    fill = mock_fill_secret()
    out = buyer_with_wave(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert 'phone' not in applied  # 스크립트 인자에 phone 키 자체가 없다
    assert applied['name'] == CUSTOMER['name']
    assert json.loads(fill.calls[0].request.content)['args'] == {
        'elementId': 7,
        'itemType': 'identity',
        'field': 'identity.phone',
    }
    # 어떤 도구 호출에도 고객 번호가 실리지 않았다
    for call in respx.calls:
        if call.request.content:
            assert '5678' not in call.request.content.decode('utf-8')
    assert any(e.label == '배송 연락처' for e in out.evidence)


@respx.mock
def test_스크립트가_알린_전화_형식대로_채운다(reg):
    # 슈마커: 010 은 고르는 칸, 나머지 8자리가 한 칸 — 스크립트가 phone_formats 로 알린다(2026-09-26)
    _wave_direct()
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler(
            'musinsa_product_snapshot',
            applied,
            echo_extra={'phone_field_ids': [9], 'phone_formats': ['phone-rest']},
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    fill = mock_fill_secret()
    out = buyer_with_wave(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert json.loads(fill.calls[0].request.content)['args'] == {
        'elementId': 9,
        'itemType': 'identity',
        'field': 'identity.phone',
        'format': 'phone-rest',
    }


@respx.mock
def test_모르는_전화_형식은_무시하고_기본대로_채운다(reg):
    _wave_direct()
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler(
            'musinsa_product_snapshot',
            applied,
            echo_extra={'phone_field_ids': [9], 'phone_formats': ['whatever']},
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    fill = mock_fill_secret()
    out = buyer_with_wave(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert 'format' not in json.loads(fill.calls[0].request.content)['args']


@respx.mock
def test_스냅샷에_실린_전화번호도_배송지_스크립트에_넘기지_않는다(reg):
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler('musinsa_product_snapshot', applied)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert 'phone' not in applied and applied['name'] == SHIPPING['name']


@pytest.mark.parametrize(
    ('echo_extra', 'fill_result', 'want'),
    [
        ({}, None, '전화 칸을 찾지 못함'),
        ({'phone_field_id': 42}, 'not found: identity.phone', '배송 연락처 입력 실패'),
        ({'phone_field_id': 42}, 'refused: vault-locked', '배송 연락처 입력 실패'),
    ],
)
@respx.mock
def test_전화_칸을_채우지_못하면_사람에게_넘긴다(reg, echo_extra, fill_result, want):
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler('musinsa_product_snapshot', applied, echo_extra=echo_extra)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    fill = mock_fill_secret(fill_result or 'ok')
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'needs_human'
    assert want in out.reason
    assert fill.called is (fill_result is not None)


@respx.mock
def test_dry_run에서도_배송_연락처_입력은_막지_않는다(reg):
    b = agent(reg, lambda p, m: m(choice='260', reason='x'))
    b._dry_run = True
    route = mock_fill_secret()
    b.tool('fill_secret', elementId=1, itemType='identity', field='identity.phone')
    assert route.called


def _abc_agent(reg):
    spec = reg['buyer.abc']
    abc = BuyerAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='260', reason='일치'),
    )
    abc.set_shipping_provider(shipping_provider())
    return abc, spec


def _abc_assignment(reg, spec):
    order = ORDER.model_copy(update={'source': 'ABCmart', 'order_type': 'direct'})
    return assignment(reg).model_copy(update={'order': order, 'allowed_tools': spec.tools})


@respx.mock
def test_ABC마트는_항상_까대기로_기본_배송지를_유지한다(reg):
    # 플레이북 §4: 까대기면 계정 기본 배송지(사무실)를 유지하고 수정하지 않는다
    wave = respx.get(f'{WAVE_API}/orders/A1')
    abc, spec = _abc_agent(reg)
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler(
            'abc_product_snapshot',
            applied,
            # 까대기 계정의 기본 배송지 = 경주 사무실
            snapshot={
                **SNAPSHOT_OK,
                'shipping': {**SHIPPING, 'name': '김사무', 'address': '경북 가상시 사무실길 58, 1층 102호'},
            },
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    fill = respx.post(f'{URL}/tool/fill_secret')
    out = abc(_abc_assignment(reg, spec))
    assert out.status == 'ok'
    assert applied == {}  # 배송지 스크립트를 부르지 않았다
    assert not wave.called and not fill.called
    assert any(e.detail == '사무실 수령(기본 배송지 유지)' for e in out.evidence)


@respx.mock
def test_까대기_주문서에_기본_배송지가_없으면_사무실_주소를_넣는다(reg):
    # poizon-sourcing 스킬: 사무실 주소가 등록돼 있지 않을 때만 사무실 주소를 주문 배송지로 쓴다(기본 배송지는 안 바꿈)
    abc, spec = _abc_agent(reg)
    snap = {
        **SNAPSHOT_OK,
        'methods': [*SNAPSHOT_OK['methods'], '네이버페이'],  # ABC마트는 네이버페이로만 결제
        'shipping': {'name': '', 'address': ''},
    }
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler('abc_product_snapshot', applied, snapshot=snap)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = abc(_abc_assignment(reg, spec))
    assert out.status == 'ok', out.reason
    assert applied['name'] == '김사무' and '사무실길 58' in str(applied['address'])
    assert any('사무실 주소를 새로 넣는다' in e.detail for e in out.evidence)


@pytest.mark.parametrize(
    ('page_text', 'keeps_default'),
    [
        ('배송지 받는 분 김사무 경북 가상시 사무실길 58 1층 102호', True),
        # 주소는 사무실이어도 수령인이 다르면 사무실 배송지가 아니다(실기: 김가명)
        ('배송지 받는 분 김가명 경북 가상시 사무실길 58 1층 102호', False),
        # 호수가 다르면 사무실이 아니다(실기 29CM: 김가명 1층 101호) — 다른 곳의 김사무와 합쳐 보지 않는다
        ('주문자 김사무 배송지 김가명 / 김가명 경북 가상시 사무실길 58 1층 101호', False),
        ('배송지 등록된 배송지가 없습니다 배송지를 추가해 주세요', False),
        ('결제수단 선택', False),
    ],
)
@respx.mock
def test_스냅샷에_배송지가_없으면_주문서_화면으로_확인한다(reg, page_text, keeps_default):
    """화면의 기본 배송지가 사무실이면 그대로, 아니면(없음 포함) 사무실 주소를 넣는다."""
    abc, spec = _abc_agent(reg)
    snap = {k: v for k, v in SNAPSHOT_OK.items() if k != 'shipping'}
    applied: dict[str, object] = {}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_recording_handler('abc_product_snapshot', applied, snapshot=snap)
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page(page_text))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    out = abc(_abc_assignment(reg, spec))
    assert out.status == 'ok', out.reason
    assert (applied == {}) is keeps_default


@respx.mock
def test_공급자는_까대기를_요청했는데_고객_주소가_오면_멈춘다():
    _wave_direct()
    with pytest.raises(AgentFailure) as e:
        shipping_provider()('A1', 'kkadaegi')
    assert e.value.status == 'needs_human' and '사무실 배송지' in e.value.reason


@respx.mock
def test_공급자가_주는_배송지에는_전화번호가_없다():
    _wave_direct()
    got = shipping_provider()('A1', 'direct')
    assert 'phone' not in got
    assert got['name'] == CUSTOMER['name'] and got['postal_code'] == '06234'


@respx.mock
def test_스냅샷에_마진이_없으면_판매가로_계산한다(reg):
    # 실기: 소싱처 스냅샷은 margin_pct 를 모른다(null) → 감독자가 마진 미달로 거부했다
    snap = {**SNAPSHOT_OK, 'margin_pct': None, 'cost': 80000}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': snap, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    order = ORDER.model_copy(update={'sale_price': 100000})
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(
        assignment(reg).model_copy(update={'order': order})
    )
    assert out.status == 'ok'
    assert out.payload['margin_pct'] == 20.0
    assert any(e.label == '마진 계산' for e in out.evidence)
    assert any('정산금 미확인 근사' in e.detail for e in out.evidence)


@respx.mock
def test_정산금이_있으면_정산금_기준으로_마진을_계산한다(reg):
    # 플레이북 §3: 마진율 = (정산금 − 원가) ÷ 매출 × 100 — 스냅샷 값보다 우선한다
    snap = {**SNAPSHOT_OK, 'margin_pct': 30, 'cost': 80000, 'pay_amount': 81000}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script(
            {'musinsa_product_snapshot': snap, 'musinsa_set_shipping': SHIPPING_ECHO}
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    mock_fill_secret()
    order = ORDER.model_copy(update={'sale_price': 100000, 'revenue': 90000})
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(
        assignment(reg).model_copy(update={'order': order})
    )
    assert out.status == 'ok'
    assert out.payload['margin_pct'] == 10.0
    assert out.payload['paid'] == 81000
    assert not any('근사' in e.detail for e in out.evidence)


def test_포이즌_외_까대기_마진은_배송비_2300원까지_넣고_본다(reg):
    # 실기 2026-09-26 174·181: 배송비를 빼고 +1.3~1.6% 로 보고 결제했는데 실제 −0.5% 적자
    from samba_agent.agents.buyer import shipping_fee_for

    buyer = agent(reg, lambda p, m: m(choice='260', reason='일치'))
    order = ORDER.model_copy(update={'sale_price': 100000, 'revenue': 81825, 'order_type': 'kkadaegi'})
    fee = shipping_fee_for(order, 'kkadaegi')
    assert fee == 2300
    # (81,825 − 80,114 − 2,300) ÷ 100,000 = −0.6%
    assert buyer._margin(order, 80114 + fee, 0) == -0.6
    poison = order.model_copy(update={'seller': 'poison(x)'})
    assert shipping_fee_for(poison, 'kkadaegi') == 0


def test_주문_옵션과_맞는_후보만_남긴다():
    from samba_agent.agents.buyer import matching_options

    # 실기: 230 주문에 후보가 220~270(230 없음)인데 모델이 '가장 가까운 220' 을 골랐다
    assert matching_options(['220', '225', '240', '250'], '230') == []
    assert matching_options(['220', '230', '240'], '230') == ['230']
    assert matching_options(['230(mm)', '240'], '옵션:230'.replace('옵션:', '')) == ['230(mm)']
    assert matching_options(['BLACK / 270', 'WHITE / 270'], 'BLACK / 270') == ['BLACK / 270']
    assert matching_options(['70(S)', '75(M)'], 'S') == ['70(S)']
    assert matching_options(['75(M) (품절)', '80(L)'], '75(M)') == []
    assert matching_options(['260', '265'], None) == ['260', '265']


@respx.mock
def test_주문_옵션에_맞는_후보가_없으면_모델에게_묻지_않고_품절이다(reg):
    snap = {**SNAPSHOT_OK, 'options': ['220', '240']}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'musinsa_product_snapshot': snap})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    asked = []

    def decide(p, m):
        asked.append(p)
        return m(choice='220', reason='가장 가까움')

    order = ORDER.model_copy(update={'option': '230'})
    out = agent(reg, decide)(assignment(reg).model_copy(update={'order': order}))
    # 목록에 없는 옵션은 품절 확증이 아니다 — 재고X 로 자르지 않고 확인으로 넘긴다(실기 2026-09-28)
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)
    assert asked == []


@respx.mock
def test_주문_옵션이_품절_표시로_떠_있으면_확정_품절이다(reg):
    snap = {**SNAPSHOT_OK, 'options': ['220', '230 (품절)', '240']}
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=route_run_script({'musinsa_product_snapshot': snap})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    order = ORDER.model_copy(update={'option': '230'})
    out = agent(reg, lambda p, m: m(choice='230', reason='x'))(
        assignment(reg).model_copy(update={'order': order})
    )
    assert (out.status, out.fail_reason) == ('fail', FailReason.OUT_OF_STOCK)
    assert '확정 품절' in out.reason


# ---- 계정 비교(사용자 지시 2026-09-23: 계정별로 싸게 살 수 있는 걸 비교하고 구매 계정을 고른다) ----


def _per_account_snapshots(by_account: dict[str, object], calls: list[str]):
    """스냅샷 스크립트는 args.account 별로 다른 견적을, 배송지 스크립트는 메아리를 준다.

    값이 문자열이면 그대로(예: 캡차 표시) 돌려준다. 스냅샷을 부른 계정 순서를 calls 에 남긴다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        name = body['args']['name']
        args = json.loads(body['args']['args'])
        if name == 'musinsa_product_snapshot':
            calls.append(f'snapshot:{args.get("account")}')
            got = by_account[args['account']]
            return page(got if isinstance(got, str) else json.dumps(got, ensure_ascii=False))
        if name.endswith('_confirm_shipping'):
            # 확정은 calls 에 남기지 않는다(배송지 순서 단언은 set_shipping 기준)
            return page(json.dumps({'ok': True, **args}, ensure_ascii=False))
        if name.endswith('_payment_quotes'):
            # 결제수단 견적도 calls 에 남기지 않는다 — "견적 없음"이면 스냅샷 원가로 간다
            return page('{"quotes": []}')
        if name.endswith('_normal_price'):
            return page('{"normal_price": 150000}')  # 정가도 calls 에 남기지 않는다
        if name.endswith('_select_shipping'):
            return page('{"ok": false, "found": false, "note": "목록에 맞는 배송지 없음"}')
        if name.endswith('_order_prep'):
            return page('{"ok": true, "points_balance": 220, "points_used": 0, "prepay": true}')
        calls.append(f'{name}:{args.get("profile")}')
        return page(json.dumps(SHIPPING_ECHO, ensure_ascii=False))

    return handler


def _login_accounts(login_route) -> list[str]:
    return [json.loads(c.request.content)['args']['accountLabel'] for c in login_route.calls]


@respx.mock
def test_주문_계정이_지정되면_비교하지_않고_그_계정으로_산다(generic_musinsa, reg):
    listed = respx.post(f'{URL}/tool/list_accounts')
    _login_mocks('already signed in (logout)')
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots({'buyer01': SNAPSHOT_OK}, calls)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment_with_account(reg))
    assert out.status == 'ok'
    assert not listed.called
    assert calls == ['snapshot:buyer01', 'musinsa_set_shipping:buyer01']
    assert out.payload['account'] == 'buyer01'
    assert out.payload['accounts_compared'] == 1


@respx.mock
def test_두_계정이면_원가가_낮은_계정으로_산다(generic_musinsa, reg):
    listed = mock_accounts('A', 'B')
    login = respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {'A': {**SNAPSHOT_OK, 'cost': 90000}, 'B': {**SNAPSHOT_OK, 'cost': 80000}}, calls
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    # 계정 목록은 소싱처 호스트로 묻는다(앱은 현재 탭 호스트만 답한다)
    assert json.loads(listed.calls[0].request.content)['args'] == {'host': 'musinsa.com'}
    # B 가 마지막 견적이라 다시 만들 필요 없이 그 주문서로 이어 간다
    assert _login_accounts(login) == ['A', 'B']
    assert calls == ['snapshot:A', 'snapshot:B', 'musinsa_set_shipping:B']
    assert out.payload['account'] == 'B'
    assert out.payload['accounts_compared'] == 2
    assert out.payload['cost'] == 80000
    details = [e.detail for e in out.evidence if e.label == '계정 견적']
    assert details == ['A: 원가 90,000원', 'B: 원가 80,000원']
    assert any(
        e.label == '계정 선택' and '원가 최저 80,000원 (비교 2계정)' in e.detail
        for e in out.evidence
    )


@respx.mock
def test_싼_계정이_먼저면_그_계정으로_다시_로그인해_주문서를_최신으로_만든다(generic_musinsa, reg):
    mock_accounts('A', 'B')
    login = respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {'A': {**SNAPSHOT_OK, 'cost': 80000}, 'B': {**SNAPSHOT_OK, 'cost': 90000}}, calls
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert _login_accounts(login) == ['A', 'B', 'A']
    assert calls == ['snapshot:A', 'snapshot:B', 'snapshot:A', 'musinsa_set_shipping:A']
    assert out.payload['account'] == 'A'


@respx.mock
def test_한_계정이_품절이면_다른_계정으로_산다(generic_musinsa, reg):
    mock_accounts('A', 'B')
    calls: list[str] = []
    order = ORDER.model_copy(update={'option': '260'})
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {
                'A': {**SNAPSHOT_OK, 'options': ['260 (품절)', '265'], 'cost': 70000},
                'B': {**SNAPSHOT_OK, 'cost': 85000, 'selected': '260'},
            },
            calls,
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(
        assignment(reg).model_copy(update={'order': order})
    )
    assert out.status == 'ok'
    assert out.payload['account'] == 'B'
    assert any(e.detail == 'A: 불가(주문 옵션 품절)' for e in out.evidence)


@respx.mock
def test_로그인에_실패한_계정은_빼고_비교한다(generic_musinsa, reg):
    mock_accounts('A', 'B')
    respx.post(f'{URL}/tool/login').mock(
        side_effect=lambda req: page(
            'account not found: use list_accounts'
            if json.loads(req.content)['args']['accountLabel'] == 'A'
            else 'already signed in'
        )
    )
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots({'B': SNAPSHOT_OK}, calls)
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert out.status == 'ok'
    assert out.payload['account'] == 'B'
    assert calls == ['snapshot:B', 'musinsa_set_shipping:B']


@respx.mock
def test_모든_계정이_품절이면_품절로_거절한다(generic_musinsa, reg):
    mock_accounts('A', 'B')
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {'A': {**SNAPSHOT_OK, 'options': []}, 'B': {**SNAPSHOT_OK, 'cost': 0}}, calls
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    # 옵션 목록이 비거나 원가를 못 읽은 것은 품절 확증이 아니다 — 확인으로 넘긴다(실기 2026-09-28)
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)
    assert 'A' in out.reason and 'B' in out.reason
    assert calls == ['snapshot:A', 'snapshot:B']  # 배송지까지 가지 않았다


@respx.mock
def test_모든_계정이_로그인에_실패하면_품절이_아니라_사람에게_넘긴다(reg):
    mock_accounts('A', 'B', login='account not found: use list_accounts')
    snap = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.PERMISSION_DENIED)
    assert not snap.called


@respx.mock
def test_한_계정에서_이미_산_흔적이_보이면_비교를_멈추고_중복이다(generic_musinsa, reg):
    mock_accounts('A', 'B')
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {'A': {**SNAPSHOT_OK, 'already_ordered': True}, 'B': SNAPSHOT_OK}, calls
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    out = agent(reg, lambda p, m: m(choice='260', reason='일치'))(assignment(reg))
    assert (out.status, out.fail_reason) == ('fail', FailReason.DUPLICATE)
    assert calls == ['snapshot:A']


@respx.mock
def test_비교_계정_수는_상한까지만(generic_musinsa, reg):
    mock_accounts('A', 'B', 'C', 'D')
    login = respx.post(f'{URL}/tool/login').mock(return_value=page('already signed in'))
    calls: list[str] = []
    respx.post(f'{URL}/tool/run_script').mock(
        side_effect=_per_account_snapshots(
            {
                'A': {**SNAPSHOT_OK, 'cost': 90000},
                'B': {**SNAPSHOT_OK, 'cost': 80000},
                'C': {**SNAPSHOT_OK, 'cost': 50000},
                'D': {**SNAPSHOT_OK, 'cost': 10000},
            },
            calls,
        )
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_fill_secret()
    b = agent(reg, lambda p, m: m(choice='260', reason='일치'))
    b.compare_accounts_max = 2
    out = b(assignment(reg))
    assert out.status == 'ok'
    assert _login_accounts(login) == ['A', 'B']  # 원래 순서의 앞 2개만
    assert out.payload['account'] == 'B'
    assert out.payload['accounts_compared'] == 2
    assert any(e.label == '계정 후보' and '4개 중 앞 2개' in e.detail for e in out.evidence)


def test_계정_목록_결과를_읽는다():
    from samba_agent.agents.buyer import parse_account_labels

    unlocked = json.dumps([{'label': 'A'}, {'label': 'B'}, {'label': 'A'}, {'label': ''}])
    assert parse_account_labels(unlocked) == (['A', 'B'], False)
    assert parse_account_labels('{"vaultLocked": true, "accounts": [{"label": "A"}]}') == (
        ['A'],
        True,
    )
    assert parse_account_labels('{"accounts": [], "note": "host unknown"}') == ([], False)
    assert parse_account_labels('not set up: ask the user') == ([], False)


def test_계정_비교_상한_설정은_기본_5이고_1_이상이다(monkeypatch):
    from pydantic import ValidationError

    from samba_agent.settings import load_settings

    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'x' * 64)
    monkeypatch.delenv('SAMBA_COMPARE_ACCOUNTS_MAX', raising=False)
    assert load_settings(env_file=None).compare_accounts_max == 5
    monkeypatch.setenv('SAMBA_COMPARE_ACCOUNTS_MAX', '3')
    assert load_settings(env_file=None).compare_accounts_max == 3
    monkeypatch.setenv('SAMBA_COMPARE_ACCOUNTS_MAX', '0')
    with pytest.raises(ValidationError):
        load_settings(env_file=None)


def test_배송지_비교는_사이트_표기_차이를_허용한다():
    exp = {'name': '홍길동', 'address': '서울특별시 중구 세종대로 110'}
    assert shipping_matches(
        exp, {'name': '홍길동', 'address': '서울 중구 세종대로 110 (서울특별시청)'}
    )
    assert shipping_matches(exp, {'name': '홍 길동', 'address': '04524 서울 중구 세종대로 110'})
    # 이름이 다르거나 번지가 다르면 다른 곳이다
    assert not shipping_matches(exp, {'name': '김철수', 'address': '서울 중구 세종대로 110'})
    assert not shipping_matches(exp, {'name': '홍길동', 'address': '서울 중구 세종대로 111'})
    assert not shipping_matches(exp, {'name': '홍길동', 'address': ''})
    # 우편번호가 같으면 표기가 달라도(지번 ↔ 도로명) 같은 곳 — 실기: 롯데온
    zip_exp = {'name': '홍길동', 'address': '경기 수원시 영통구 이의동 41-11', 'postal_code': '16514'}
    assert shipping_matches(zip_exp, {'name': '홍길동', 'address': '경기 수원시 영통구 법조로14번길 11', 'zip': '16514'})
    assert not shipping_matches(zip_exp, {'name': '홍길동', 'address': '경기 수원시 영통구 법조로14번길 11', 'zip': '16515'})
    assert not shipping_matches(zip_exp, {'name': '홍길동', 'address': '', 'zip': '16514'})
    # 인천 서구 → 서해구(2026-07 개편) — 주문은 옛 이름, 사이트 주소검색은 새 이름으로 되읽는다(실기 2026-09-27 29CM)
    old = {'name': '홍길동', 'address': '인천광역시 서구 원창동', 'address_detail': '인천광역시 서구 원창동 488 로지스허브 9층910호'}
    assert shipping_matches(old, {'name': '홍길동', 'address': '인천 서해구 원창동 488 로지스허브 9층910호'})
    assert not shipping_matches(old, {'name': '홍길동', 'address': '인천 서해구 원창동 488 로지스허브 9층911호'})
    comma = {'name': '김*영', 'address': '서울 강동구 천중로35가길 6, 401호 (천호동 55-2, 그린캐슬)'}
    assert shipping_matches(comma, {'name': '김*영', 'address': '서울 강동구 천중로35가길 6 401호'})


def test_matching_options_품절임박은_품절이_아니고_토큰_하나로도_맞춘다():
    from samba_agent.agents.buyer import matching_options

    # 실기: 롯데온 — 주문 옵션 "카키 085(L) NP6KP12C", 사이즈 단계 후보에 재고 표기가 붙는다
    opts = ['[품절] 080(M) 35,100 품절', '085(L) 35,100 2개 남음 (품절임박)', '[품절] 090(XL) 35,100 품절']
    assert matching_options(opts, '카키 085(L) NP6KP12C') == ['085(L) 35,100 2개 남음 (품절임박)']
    assert matching_options(opts, '카키 080(M) NP6KP12C') == []
    # 한 글자 토큰(M·L)만으로는 고르지 않는다
    assert matching_options(['S 재고있음', 'M 재고있음'], '레드 M') == []


def test_matching_options_한_글자_사이즈는_선택지_전체와_같을_때만():
    from samba_agent.agents.buyer import matching_options, sold_out_option_matches

    # 실기 2026-09-29 무신사 지오다노: 주문 '01올리브/L' ↔ 사이즈 단계 ['M (품절)', 'L (품절)', 'XL'] 를 옵션 불일치로 멈췄다
    opts = ['M (품절)', 'L (품절)', 'XL']
    assert matching_options(opts, '01올리브/L') == []
    assert sold_out_option_matches(opts, '01올리브/L') == ['L (품절)']
    assert matching_options(['M', 'L', 'XL'], '01올리브/L') == ['L']
    assert matching_options(['M', 'L', 'XL'], '블랙 XL') == ['XL']
    # 선택지 글자가 사이즈 하나와 똑같지 않으면 고르지 않는다
    assert matching_options(['L 재고있음', 'XL 재고있음'], '블랙/L') == []


def test_matching_options_모든_선택지에_든_색상_조각은_가르지_않는다():
    from samba_agent.agents.buyer import matching_options

    # 실기 2026-09-29 패션플러스: 품절 사이즈는 목록에서 빠진다 — 'YEL 270' 은 후보가 없어야 한다
    opts = ['YEL 230', 'YEL 260', 'YEL 265', 'YEL 275']
    assert matching_options(opts, 'YEL 270') == []
    assert matching_options(opts, 'YEL 265') == ['YEL 265']
    # 선택지가 하나뿐이면 그 조각으로 맞춘다
    assert matching_options(['YEL 270'], 'YEL 270') == ['YEL 270']


def test_cheapest_quotes_결제_가능한_수단만_싼_순으로():
    from samba_agent.agents.buyer import cheapest_quotes, parse_account_payments, quote_provider

    quotes = [
        {'method': '무신사머니', 'card': None, 'cost': 29000},
        {'method': '신용카드', 'card': '현대카드', 'cost': 27500},
        {'method': '토스페이', 'card': None, 'cost': 28000},
        {'method': '휴대폰결제', 'card': None, 'cost': 26000},
        {'method': '카카오페이', 'card': None, 'cost': 0},
    ]
    # 거르지 않으면 원가순(0 원은 뺀다). 현대카드 줄은 청구할인 ×0.973 이 반영된다
    assert [q['cost'] for q in cheapest_quotes(quotes, None)] == [26000, 26758, 28000, 29000]
    # 키마스터에 무신사머니(site)·토스만 있으면 그 둘만, 휴대폰결제는 제공자를 몰라 뺀다
    got = cheapest_quotes(quotes, None, {'site', 'toss'})
    assert [(q['method'], q['cost']) for q in got] == [('토스페이', 28000), ('무신사머니', 29000)]
    # 카드 직접 결제는 후보가 아니다 — 카드는 토스페이·네이버페이 창 안에서 고른다
    assert cheapest_quotes(quotes, None, {'site', 'toss', 'card'})[0]['method'] == '토스페이'
    assert quote_provider('무신사페이') == 'musinsapay'
    assert quote_provider('신용/체크카드', '롯데카드') is None
    assert quote_provider('휴대폰결제') is None
    raw = '[{"label":"buyer05","types":["login","password","card"],"payments":["site","toss"]}]'
    assert parse_account_payments(raw, 'buyer05') == {'site', 'toss'}
    assert parse_account_payments(raw, 'other') is None
    assert parse_account_payments('vault locked', 'buyer05') is None


def test_결제_가능한_수단이_없으면_사람에게_넘긴다(monkeypatch):
    """키마스터 결제 항목이 비어 있으면 견적이 있어도 모델에게 고르게 하지 않는다."""
    from samba_agent.agents import buyer as buyer_mod
    from samba_agent.agents.base import AgentFailure

    agent = buyer_mod.BuyerAgent.__new__(buyer_mod.BuyerAgent)
    agent.evidence = []
    agent.spec = type('S', (), {'name': 'buyer.musinsa'})()
    agent.step = lambda *_: None
    agent.note = lambda *_: None
    agent.json_tool = lambda *_, **__: {
        'quotes': [{'method': '무신사머니', 'card': None, 'cost': 29000}],
        'base_cost': 29000,
    }
    snap = {'cost': 29000, 'methods': ['무신사머니', '카드', '토스페이']}
    a = type('A', (), {'options': {}})()
    # 결제 항목이 하나도 없으면 견적을 돌리지 않고 그대로 간다(승인 근거에 남긴다)
    agent._payable_providers = lambda _account: set()
    agent._apply_payment_quotes(a, 'buyer05', snap)
    assert 'pay_method' not in snap
    # 결제 항목은 있는데(토스) 견적에 그 수단이 없으면 사람에게
    agent._payable_providers = lambda _account: {'toss'}
    try:
        agent._apply_payment_quotes(a, 'buyer05', snap)
    except AgentFailure as e:
        assert e.status == 'needs_human'
        assert '결제 가능한 수단이 없다' in e.reason
    else:
        raise AssertionError('needs_human 이어야 한다')
    # 결제 항목이 있으면 그 수단으로 원가를 바꾼다
    agent._payable_providers = lambda _account: {'site'}
    agent._apply_payment_quotes(a, 'buyer05', snap)
    assert snap['pay_method'] == '무신사머니' and snap['cost'] == 29000.0


def test_직배_까대기_판정_규칙():
    from samba_agent.agents.buyer import decide_order_type, shipping_fee_for
    from samba_agent.agents.contracts import OrderRef

    def order(seller, sale_price=50000, order_type='direct'):
        return OrderRef(order_no='X', source='무신사', seller=seller, sku='S', sale_price=sale_price, order_type=order_type)

    # 포이즌은 전부 까대기, 배송비 0
    assert decide_order_type(order('포이즌'), 79000)[0] == 'kkadaegi'
    assert shipping_fee_for(order('포이즌'), 'kkadaegi') == 0
    # 소싱처 강제
    assert decide_order_type(order('쿠팡'), None, 'kkadaegi')[0] == 'kkadaegi'
    # 그 외 마켓: 정가 vs 고객 결제액
    assert decide_order_type(order('쿠팡', 50000), 79000)[0] == 'direct'
    assert decide_order_type(order('쿠팡', 50000), 39000)[0] == 'kkadaegi'
    assert shipping_fee_for(order('쿠팡', 50000), 'kkadaegi') == 2300
    assert shipping_fee_for(order('쿠팡', 50000), 'direct') == 0
    # 정가 모르면 판정 불가, 고객 결제액을 모르면 태그를 따른다
    assert decide_order_type(order('쿠팡', 50000), None)[0] == ''
    assert decide_order_type(order('쿠팡', 0), 79000)[0] == 'direct'
    # 선물 태그는 그대로
    assert decide_order_type(order('쿠팡', 50000, 'gift'), 79000)[0] == 'gift'


def test_cheapest_quotes_카드_직접_결제는_후보가_아니다():
    from samba_agent.agents.buyer import cheapest_quotes

    quotes = [
        {'method': '카드', 'card': 'KB카드', 'cost': 27000},
        {'method': '카드', 'card': '현대카드', 'cost': 28000},
        {'method': '무신사머니', 'card': None, 'cost': 29000},
    ]
    got = cheapest_quotes(quotes, None, {'site'})
    assert [(q['method'], q['cost']) for q in got] == [('무신사머니', 29000)]


def test_matching_options_토큰_경계_일치가_우선():
    from samba_agent.agents.buyer import matching_options

    opts = ['Black-XS (품절)', 'Black-XL', 'Black-XLT (품절)', 'Black-XXL', 'Black-3XL']
    assert matching_options(opts, '블랙 XL') == ['Black-XL']
    assert matching_options(opts, '블랙 3XL') == ['Black-3XL']


def test_payable_methods_는_결제_가능한_수단_이름만_남긴다():
    from samba_agent.agents.buyer import payable_methods

    methods = ['무신사머니', '무신사페이', '카드', '카카오페이', '토스페이', '페이코', '휴대폰결제']
    assert payable_methods(methods, {'site', 'toss'}) == ['무신사머니', '토스페이']
    assert payable_methods(methods, {'card', 'kakao'}) == ['카카오페이']  # '카드'는 절대 안 들어간다
    assert payable_methods(methods, set()) == []


@respx.mock
def test_까대기_사무실_배송지가_목록에_있으면_골라서_쓴다(reg):
    """신규 입력(set_shipping) 없이 `<key>_select_shipping` 으로 기존 사무실 항목을 고른다."""
    abc, spec = _abc_agent(reg)
    snap = {
        **SNAPSHOT_OK,
        'methods': [*SNAPSHOT_OK['methods'], '네이버페이'],  # ABC마트는 네이버페이로만 결제
        'shipping': {'name': '', 'address': ''},
    }
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        name = body['args']['name']
        calls.append(name)
        if name == 'abc_product_snapshot':
            return page(json.dumps(snap, ensure_ascii=False))
        if name.endswith('_select_shipping'):
            args = json.loads(body['args']['args'])
            return page(json.dumps({'ok': True, 'found': True, **args}, ensure_ascii=False))
        if name.endswith('_payment_quotes'):
            return page('{"quotes": []}')
        if name.endswith('_normal_price'):
            return page('{"normal_price": 150000}')
        if name == 'abc_order_prep':
            # ABC 도 결제 전 쿠폰 적용 단계를 거친다(2026-09-25)
            return page('{"ok": true, "coupon": 0, "cart_coupon": 0, "total": 89000, "points_used": 0}')
        raise AssertionError(f'예상치 못한 run_script 호출: {name}')

    respx.post(f'{URL}/tool/run_script').mock(side_effect=handler)
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    mock_accounts()
    out = abc(_abc_assignment(reg, spec))
    assert out.status == 'ok', out.reason
    assert 'abc_order_prep' in calls
    assert 'abc_select_shipping' in calls and 'abc_set_shipping' not in calls
    assert any('목록의 기존 배송지' in e.detail for e in out.evidence)


def test_cheapest_quotes_는_낼_수_없는_수단을_뺀다():
    from samba_agent.agents.buyer import cheapest_quotes

    quotes = [
        {'method': '무신사머니', 'card': None, 'cost': 39200, 'available': False, 'note': '연결 계좌 없음'},
        {'method': '토스페이', 'card': None, 'cost': 39200},
    ]
    assert [q['method'] for q in cheapest_quotes(quotes, None, {'site', 'toss'})] == ['토스페이']


def test_원가는_적립과_청구할인을_반영한다():
    from samba_agent.agents.buyer import effective_cost

    # 39,200 결제, 무신사머니 적립 3,120 → 원가 36,080(사용자 예시 2026-09-24)
    assert effective_cost({'cost': 39200, 'reward': 3120}) == 36080
    # PAYCO×현대카드: 결제액 ×0.973, 적립 1,170
    assert effective_cost({'cost': 39200, 'card': '현대카드', 'reward': 1170}) == round(39200 * 0.973 - 1170)
    # 기존 적립금 사용액은 원가에 다시 더한다
    assert effective_cost({'cost': 30000, 'reward': 0, 'points_used': 2000}) == 32000


def test_무신사는_4계정을_지정_순서로_비교한다():
    from samba_agent.sources import default_sources

    src = default_sources().by_id('MUSINSA')
    # 동률이면 앞 계정(buyer01 → buyer02 순)이 이긴다(사용자 2026-09-24)
    assert src.buy_accounts[:2] == ['buyer01', 'buyer02']
    assert set(src.buy_accounts) == {'buyer01', 'buyer02', 'buyer03', 'buyer05'}


def test_결제_우선순위를_읽는다():
    from samba_agent.agents.buyer import parse_account_priorities

    raw = '[{"label":"buyer01","priority":1},{"label":"buyer02","priority":2},{"label":"x","priority":null}]'
    assert parse_account_priorities(raw) == {'buyer01': 1, 'buyer02': 2}
    assert parse_account_priorities('vault locked') == {}


def test_29cm_무신사페이는_무신사머니_창구다():
    """29CM 는 무신사머니가 무신사페이 안에 있다 — buyer02(무신사머니만)도 29CM 주문서에서 결제 수단을 찾는다
    (실기 2026-09-25: '주문서 결제수단 중 결제 가능한 것 없음(가능 [site])' 로 비교에서 빠졌다)."""
    from samba_agent.agents.buyer import method_providers, payable_methods, source_of

    methods = ['무신사페이', '카드', '토스페이']
    assert payable_methods(methods, {'site'}, money_in_pay=True) == ['무신사페이']
    assert payable_methods(methods, {'site'}) == []  # 무신사: 무신사머니는 따로 있는 수단이다
    assert method_providers('무신사페이', money_in_pay=True) == {'musinsapay', 'site'}
    assert method_providers('카드', money_in_pay=True) == set()
    assert source_of('buyer.cm29').money_in_pay is True
    assert source_of('buyer.musinsa').money_in_pay is False


def test_페이코_견적은_현대카드_청구할인_2_7퍼센트():
    """특별할인 없는 페이코도 현대카드 청구할인 ×0.973 로 원가를 낸다(사용자 2026-09-25)."""
    from samba_agent.agents.buyer import cheapest_quotes

    rows = cheapest_quotes(
        [
            {'method': '무신사머니', 'cost': 100000, 'reward': 2000},
            {'method': '페이코', 'cost': 100000, 'reward': 0},
        ],
        None,
        {'site', 'payco'},
    )
    payco = next(r for r in rows if r['method'] == '페이코')
    assert payco['card'] == '현대카드'
    assert payco['cost'] == 97300
    assert rows[0]['method'] == '페이코'  # 97,300 < 98,000


def test_무신사페이_등록_카드가_없으면_수리하지_않는다():
    """buyer05 처럼 무신사페이 카드가 없는 계정은 실제로 그렇다 — 실패로 보지 않는다(2026-09-25)."""
    from samba_agent.agents.buyer import pay_card_quote_problem

    assert pay_card_quote_problem({'ok': False, 'quotes': [], 'note': 'no registered card'}) is None
    assert pay_card_quote_problem({'ok': True, 'quotes': [], 'cards': []}) is None
    assert pay_card_quote_problem({'ok': False, 'quotes': [], 'note': '화면 못 읽음'}) is not None


def test_네이버페이_견적은_사이트_적립과_네이버페이_1퍼센트를_모두_뺀다():
    """ABC 원가 = 결제액 × 현대카드 청구할인 − A-RT 적립 − 네이버페이 적립(1%) + 사용 포인트.

    네이버페이는 등록한 현대카드로 결제된다 — 청구할인 2.7%(사용자 2026-10-02)."""
    from samba_agent.agents.buyer import cheapest_quotes

    rows = cheapest_quotes(
        [{'method': '네이버페이', 'cost': 64600, 'reward': 1300, 'points_used': 0}], None, {'naver'}
    )
    assert rows[0]['cost'] == round(64600 * 0.973 - 1300 - 646)


def test_같은_원가면_페이코보다_무신사페이가_먼저다():
    from samba_agent.agents.buyer import cheapest_quotes

    raw = [
        {'method': '페이코', 'card': '현대카드', 'cost': 100000},
        {'method': '무신사페이', 'card': '현대카드', 'cost': 100000},
    ]
    rows = cheapest_quotes(raw, None)
    assert rows[0]['method'] == '무신사페이'


def test_페이코_줄의_카드칸에_무신사페이_문구가_섞여도_페이코로_분류한다():
    from samba_agent.agents.buyer import cheapest_quotes, clean_card, quote_provider

    card = '적립 무신사페이 혜택 관리 현대카드'
    assert quote_provider('페이코', card) == 'payco'
    assert clean_card(card) == '현대카드'
    rows = cheapest_quotes([{'method': '페이코', 'card': card, 'cost': 119710}], None, {'payco'})
    assert rows and rows[0]['card'] == '현대카드'


def test_롯데온_충전결제는_견적_후보에서_뺀다():
    from samba_agent.agents.buyer import cheapest_quotes

    rows = cheapest_quotes([{'method': '충전결제', 'card': None, 'cost': 30000}], None, {'site'})
    assert rows == []


def test_슈마커_간편결제는_등록_현대카드로_보고_청구할인을_반영한다():
    from samba_agent.agents.buyer import cheapest_quotes

    rows = cheapest_quotes([{'method': '간편결제', 'card': None, 'cost': 69300}], None, {'site'}, '현대카드')
    assert rows[0]['card'] == '현대카드'
    assert rows[0]['cost'] == round(69300 * 0.973)


@respx.mock
def test_교차_비교_견적은_제_레인에서_해_이_사이트_주문서를_닫지_않는다(reg, monkeypatch):
    """실기 2026-09-26 job 207: 29CM 1계정 견적의 '주문서 탭 닫기'가 레인 밖에서 돌아 무신사 주문서를 닫았다.

    무신사가 더 싸 무신사로 살 때 배송지 스크립트가 주문서를 못 찾아 '배송지 입력 검증에 실패' 로 멈췄다.
    """
    mus = agent(reg, lambda p, m: m(choice='250', reason='일치'))
    cm_spec = reg['buyer.cm29']
    sib = BuyerAgent(
        cm_spec,
        BridgeClient(URL, 'a' * 64, allowed=cm_spec.tools, busy_wait_s=0.0),
        lambda p, m: m(choice='250', reason='일치'),
    )
    mus.sibling = sib
    mus.evidence = []
    lanes: list[str | None] = []
    closed_lanes: list[str | None] = []

    def fake_find(self, a):
        lanes.append(self.bridge._lane)
        return {'found': True, 'product_url': 'https://www.29cm.co.kr/products/4014966', 'name': '같은 상품'}

    def fake_pick(self, a, accounts):
        lanes.append(self.bridge._lane)
        return 'buyer01@naver.com', {'cost': 141541}

    monkeypatch.setattr(BuyerAgent, '_find_same_product', fake_find)
    monkeypatch.setattr(BuyerAgent, '_pick_cheapest', fake_pick)
    monkeypatch.setattr(BuyerAgent, '_candidate_accounts', lambda self, a: ['buyer01@naver.com'])
    monkeypatch.setattr(BuyerAgent, '_apply_payment_quotes', lambda self, a, acc, snap: None)

    def on_js(request):
        closed_lanes.append(request.headers.get('X-Samba-Lane'))
        return page('ok')

    respx.post(f'{URL}/tool/run_js').mock(side_effect=on_js)
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    a = assignment(reg).model_copy(
        update={'order': ORDER.model_copy(update={'product_url': 'https://www.musinsa.com/products/5111643'})}
    )
    out = mus._cross_compare(a, 'buyer01', {'cost': 81900})
    assert out is None  # 무신사가 더 싸다 — 이 사이트로 산다
    # 다른 사이트 상품 찾기·견적은 레인 안에서만
    assert lanes and all(x == 'cm29-cross' for x in lanes)
    # 끝나면 그 레인 탭만 닫는다(레인 밖 '모든 탭 닫기'가 아니다)
    assert closed_lanes == ['cm29-cross']
    # 실제 구매에 쓰는 29CM 에이전트의 브리지는 그대로(레인 밖)
    assert sib.bridge._lane is None


def test_라자다_배대지_주문은_까대기다(reg):
    # 사용자 2026-09-27: 받는 곳이 LAZADA 배대지면 정가와 무관하게 까대기(사무실), 포이즌 외라 배송비 2,300
    from samba_agent.agents.buyer import decide_order_type, shipping_fee_for
    from samba_agent.agents.contracts import OrderRef

    o = OrderRef(order_no='L1', source='무신사', seller='신세계몰(x)', sku='S', sale_price=38800)
    assert decide_order_type(o, 99000, None, forwarder=True)[0] == 'kkadaegi'
    assert shipping_fee_for(o, 'kkadaegi') == 2300

    a = agent(reg, lambda _p, _m: '{}')
    a.set_shipping_provider(
        lambda no, _t: {'name': '(G2L)0000', 'address': '인천 어딘가', 'address_detail': ' LAZADA(0000)'}
        if no == 'L1'
        else {'name': '홍길동', 'address': '서울', 'address_detail': '101호'}
    )
    assert a.order_type_of(o, {'normal_price': 99000}) == 'kkadaegi'
    other = o.model_copy(update={'order_no': 'D1'})
    assert a.order_type_of(other, {'normal_price': 99000}) == 'direct'


def test_주문_옵션의_품번_숫자는_사이즈로_보지_않는다():
    # 실기 2026-09-27: '블랙 M 2406433303' 의 품번 때문에 선택지 'M' 을 못 골라 품절로 멈췄다
    from samba_agent.agents.buyer import size_letter_options, size_numbers

    assert size_numbers('블랙 M 2406433303') == set()
    assert size_numbers('카키 085(L) 230') == {'085', '230'}
    assert size_letter_options(['S (품절)', 'M', 'L (품절)', 'XL'], '블랙 M 2406433303') == ['M']


def test_롯데온은_포이즌_외_전부_선물하기_포이즌은_까대기다(reg):
    # 사용자 2026-09-27: 롯데온 = 롯데백화점 판매자만·샵백 경유, 포이즌 외 전부 선물하기, 포이즌은 바로구매(까대기)
    from samba_agent.agents.buyer import source_of
    from samba_agent.agents.contracts import OrderRef

    source = source_of('buyer.lotteon')
    assert source.gift_unless_poison and source.required_seller == '롯데백화점'
    assert source.entry_route == 'shopback' and source.entry_script == 'lotteon_shopback_entry'
    assert source.shipping_confirm and source.buy_accounts == ['buyer01']

    spec = reg['buyer.lotteon']
    a = BuyerAgent(spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), lambda _p, _m: '{}')
    other = OrderRef(order_no='G1', source='롯데온', seller='KT알파', sku='S', sale_price=50000, order_type='direct')
    # 정가를 몰라도(스냅샷 없음) 선물로 정해진다
    assert a.order_type_of(other, None) == 'gift'
    poison = other.model_copy(update={'order_no': 'P1', 'seller': '포이즌'})
    assert a.order_type_of(poison, None) == 'kkadaegi'


def test_matching_options_letter_number_size_uses_product_code() -> None:
    """'S-3'(라코스테 숫자 사이즈)은 선택지의 세 자리 코드 003 에 맞춘다 — 글자로 95·100 을 짐작하지 않는다."""
    from samba_agent.agents.buyer import matching_options

    options = [
        '003(95) 143,400 3개 남음 (품절임박)',
        '004(100) 143,400 4개 남음 (품절임박)',
        '005(105) 143,400 4개 남음 (품절임박)',
    ]
    assert matching_options(options, '블랙/031 S-3') == [options[0]]
    assert matching_options(options, '블랙/031 XL-6') == []


def test_주문_옵션에_한국_치수가_있으면_그_치수로_맞춘다():
    from samba_agent.agents.buyer import matching_options

    wanted = 'EU 화이트 EU 42 · KR 270'
    assert matching_options(['230', '240', '250', '260', '270', '280'], wanted) == ['270']
    # 외국 치수 숫자(42)가 든 선택지에 걸리지 않는다
    assert matching_options(['42', '43', '270', '280'], wanted) == ['270']
    # 선택지에도 한국 치수가 적혀 있으면 그것끼리 맞춘다
    options = ['KR 265 / EU 42', 'KR 270 / EU 42.5', 'KR 275 / EU 43']
    assert matching_options(options, wanted) == ['KR 270 / EU 42.5']


def test_한국_치수가_없는_외국_치수_주문은_짐작하지_않는다():
    from samba_agent.agents.buyer import matching_options

    options = ['230', '240', '250', '260', '270', '280']
    assert matching_options(options, 'EU 미디엄 다크 카키 EU 43/44') == []


def test_한국_치수_선택지가_품절이면_다른_치수로_바꾸지_않는다():
    from samba_agent.agents.buyer import matching_options

    assert matching_options(['260', '270 (품절)', '280'], 'EU 42 · KR 270') == []


def test_주문서_수량이_주문_수량과_다르면_사지_않는다():
    from samba_agent.agents.buyer import order_qty_problem

    # 실기 2026-09-30 무신사 노스페이스 모자: 2개 주문에 1개 결제
    assert order_qty_problem(2, {'order_tab': 't', 'qty': 1}) is not None
    assert order_qty_problem(2, {'order_tab': 't'}) is not None  # 수량을 못 읽었으면 사지 않는다
    assert order_qty_problem(2, {'order_tab': 't', 'qty': 2}) is None
    assert order_qty_problem(1, {'order_tab': 't'}) is None
    assert order_qty_problem(2, {'error': 'sold_out'}) is None  # 주문서가 없으면 다른 사유가 가른다


def test_matching_options_XL_은_2XL_에_맞추지_않는다():
    from samba_agent.agents.buyer import matching_options, sold_out_option_matches

    # 실기 2026-09-30 그랜드스테이지: 선택지 ['M','L','2XL','S 품절','XL 품절'], 주문 XL
    opts = ['M', 'L', '2XL', 'S 품절', 'XL 품절']
    assert matching_options(opts, 'XL') == []
    assert sold_out_option_matches(opts, 'XL') == ['XL 품절']
    assert matching_options(['XL', 'XXL'], 'XL') == ['XL']


def test_선택란_없는_단일_상품은_프리사이즈_색상이_맞으면_진행():
    from samba_agent.agents.buyer import single_item_ok

    snap = {'order_tab': 't', 'cost': 33630, 'product_name': '[노스페이스]린덴 힙색 NN2PS26J_BLK'}
    assert single_item_ok('BLK(BLACK) FREE', snap)
    assert not single_item_ok('WHT(WHITE) FREE', snap)  # 색이 다르면 아니다
    assert not single_item_ok('BLK 270', snap)  # 프리사이즈가 아니면 아니다
    assert not single_item_ok('BLK FREE', {'cost': 1000})  # 주문서가 없으면 아니다
    # 상품명에 색 글자가 없으면(품번뿐) 선택란 없는 단일 상품으로 본다 — 실기 2026-10-01 롯데온 라코스테 쇼퍼백
    plain = {'order_tab': 't', 'cost': 100080, 'product_name': '[라코스테]2025 NEW L.12.12 스몰 사이즈 쇼퍼백 KP NF2037P55G000'}
    assert single_item_ok('블랙 FREE', plain)
    assert not single_item_ok('블랙 250', plain)  # 프리사이즈가 아니면 여전히 아니다
    assert not single_item_ok('NF9999 FREE', plain)  # 색이 아닌 낯선 글자는 이름에 있어야 한다
    # 이름에 다른 색이 적혀 있으면 막는다
    assert not single_item_ok('블랙 FREE', {**plain, 'product_name': '[라코스테] 쇼퍼백 화이트 NF2037'})


def test_선물하기가_막힌_지역_주소():
    from samba_agent.agents.buyer import gift_blocked_address

    # 롯데온 '선물하기 주문은 제주/도서산간 지역은 배송이 불가'(실기 2026-09-30)
    assert gift_blocked_address('제주특별자치도 제주시 봉개북3길 1')
    assert gift_blocked_address('경상북도 울릉군 울릉읍 도동리 1')
    assert not gift_blocked_address('서울특별시 강남구 테헤란로 1')


def test_margin_pct_rounded_keeps_tiny_positive():
    from samba_agent.agents.buyer import margin_pct_rounded

    # 정산금 272,161 - 원가 272,052 = +109원 → 0.035% — 0.0 으로 줄면 '0% 초과' 검사에 걸린다
    assert margin_pct_rounded((272161 - 272052) / 307700 * 100) > 0
    assert margin_pct_rounded(-0.03) < 0
    assert margin_pct_rounded(7.5896) == 7.6
    assert margin_pct_rounded(0.0) == 0.0


def test_shipping_matches_when_site_reads_back_detail_in_address():
    from samba_agent.agents.buyer import shipping_matches

    expected = {'name': '홍길동', 'address': '경기 성남시 분당구 판교역로 12 (백현동,판교푸르지오)', 'address_detail': '101동 1203호'}
    applied = {'name': '홍길동', 'address': '경기 성남시 분당구 판교역로 12 101동 1203호'}
    assert shipping_matches(expected, applied)
    other_road = {'name': '홍길동', 'address': '경기 성남시 분당구 대왕판교로 99 101동 1203호'}
    assert not shipping_matches(expected, other_road)


def test_xxl_matches_2xl_by_size_letters():
    from samba_agent.agents.buyer import size_letter_options, size_letters

    assert size_letters('그레이 XXL') == size_letters('2XL') == {'2XL'}
    assert size_letter_options(['S (품절)', 'M (품절)', 'L', 'XL', '2XL'], '그레이 XXL') == ['2XL']


def test_상품_도메인이_홈과_다르면_그_도메인에서_로그인한다():
    """실기 2026-10-01 SSG: pay.ssg.com 은 로그인돼 있는데 신세계몰 상품의 바로구매가 로그인 팝업을 띄웠다."""
    from samba_agent.agents import buyer as buyer_mod

    agent = buyer_mod.BuyerAgent.__new__(buyer_mod.BuyerAgent)
    agent.spec = type('S', (), {'name': 'buyer.ssg'})()
    agent.note = lambda *_: None
    calls: list[tuple[str, dict[str, object]]] = []
    answers = iter([buyer_mod.LOGIN_SUBMITTED, buyer_mod.ALREADY_SIGNED_IN + ' (로그아웃)'])

    def tool(name: str, /, **args: object) -> str:
        calls.append((name, args))
        if name == 'new_tab':
            return 'ok: tab 0aba7b25-ae69-4d40-ab06-c0aa4d0cfa47'
        if name == 'login':
            return next(answers)
        return 'ok'

    agent.tool = tool
    url = 'https://shinsegaemall.ssg.com/item/itemView.ssg?itemId=1'
    assert agent._login_product_host('edelvise06', url) is True
    assert ('new_tab', {'url': 'https://shinsegaemall.ssg.com/', 'profile': 'edelvise06'}) in calls
    assert calls[-1] == ('close_tab', {'id': '0aba7b25-ae69-4d40-ab06-c0aa4d0cfa47'})
    # 홈과 같은 도메인이면 다시 로그인하지 않는다
    calls.clear()
    assert agent._login_product_host('edelvise06', 'https://pay.ssg.com/myssg/x') is False
    assert calls == []


def test_나의_할인가보다_주문서가_크게_비싸면_결제하지_않는다():
    """실기 2026-10-01 노스페이스 비니: 나의 할인가 27,590 · 주문서 쿠폰 0원 37,440 으로 결제됐다."""
    from samba_agent.agents.buyer import coupon_gap_failure

    with pytest.raises(AgentFailure) as e:
        coupon_gap_failure(27590, 37440, 'edelvise06')
    assert e.value.status == 'needs_human' and '쿠폰 미적용' in e.value.reason
    assert e.value.fail_reason is not FailReason.MARGIN  # 자동 취소로 가면 안 된다
    coupon_gap_failure(36350, 37850, 'edelvise06')  # 1,500원 — 적립금·등급 차이 범위, 통과
    coupon_gap_failure(None, 37440, 'edelvise06')  # 빠른 비교 없음 — 검사 안 함


def test_롯데홈쇼핑_나이키_아디다스는_직배():
    """사용자 2026-10-01: 롯데홈쇼핑 나이키·아디다스 주문은 정가와 상관없이 직배."""
    from samba_agent.agents.buyer import decide_order_type

    def order(sku: str, seller: str = '롯데홈쇼핑(037800LT)') -> OrderRef:
        return OrderRef(order_no='1', source='MUSINSA', seller=seller, sku=sku, qty=1, sale_price=50000, order_type='direct')

    assert decide_order_type(order('매장정품 나이키 에어포스'), 40000)[0] == 'direct'  # 정가 ≤ 결제액이어도
    assert decide_order_type(order('ADIDAS 삼바 OG'), 40000)[0] == 'direct'
    assert decide_order_type(order('뉴발란스 530'), 40000)[0] == 'kkadaegi'  # 다른 브랜드는 정가 비교 그대로
    assert decide_order_type(order('나이키 에어포스', seller='쿠팡(unclehg)'), 40000)[0] == 'kkadaegi'


def test_주소에_건물번호가_없고_상세가_번호로_시작하는_주문도_같은_곳으로_본다():
    """실기 2026-10-01 패션플러스: 주문 주소 '…로', 상세 '29, 5층' → 사이트는 '…로 29' + '5층' 으로 되읽는다."""
    from samba_agent.agents.buyer import shipping_matches

    want = {'name': '홍길동', 'address': '경기 용인시 처인구 가나다로', 'address_detail': '29, 5층'}
    got = {'name': '홍길동', 'address': '경기 용인시 처인구 가나다로 29', 'address_detail': '5층', 'zip': '16827'}
    assert shipping_matches(want, got)
    # 건물번호가 다르면 다른 곳이다
    assert not shipping_matches(want, {**got, 'address': '경기 용인시 처인구 가나다로 31'})
    # 도로명이 다르면 다른 곳이다
    assert not shipping_matches(want, {**got, 'address': '경기 용인시 처인구 라마바로 29'})


def test_빠른_비교는_순서만_정하고_계정_전부를_주문서로_견적한다():
    """실기 2026-10-02 비니: edelvise06 화면가 34,460(쿠폰 미반영)이라 비교에서 빠졌는데 주문서는 가장 쌌다."""
    from samba_agent.agents.buyer import quick_batches

    scores = {'edelvise06': 34460.0, 'cannonfort': 34460.0, 'hwangnol06': 27590.0, 'roasterydg': 28320.0}
    ranked = ['hwangnol06', 'roasterydg', 'edelvise06', 'cannonfort', 'unread']
    assert quick_batches(ranked, scores) == [ranked]
    assert quick_batches([], {}) == []


def test_단일_상품_색_표기가_달라도_같은_색이면_진행한다():
    """실기 2026-10-02 롯데온 선캡: 주문 옵션 'BLACK ONE', 상품명 'NE3CS11A_BLK' — 선택란 없는 단일 상품."""
    from samba_agent.agents.buyer import single_item_ok

    snap = {'order_tab': 't1', 'cost': 36580, 'product_name': '우먼 유브이 라이트 선캡 NE3CS11A_BLK'}
    assert single_item_ok('BLACK ONE', snap)
    # 이름에 다른 색이 적혀 있으면 막는다
    assert not single_item_ok('BLACK ONE', {**snap, 'product_name': '우먼 유브이 라이트 선캡 NE3CS11A_WHT'})


def test_네이버페이는_현대카드_청구할인을_원가에_반영한다():
    """사용자 2026-10-02: 네이버페이는 현대카드로 결제된다 — 2.7% 청구할인. 다른 카드가 적혀 있으면 그 카드 계수."""
    from samba_agent.agents.buyer import effective_cost

    assert effective_cost({'method': '네이버페이', 'card': None, 'cost': 97670, 'reward': 977}) == round(97670 * 0.973 - 977)
    assert effective_cost({'card': '네이버페이', 'cost': 100000}) == 97300  # 주문 상세의 결제수단 글자
    assert effective_cost({'card': '네이버페이 - 롯데카드', 'cost': 100000}) == 98000
    assert effective_cost({'method': '토스페이', 'card': None, 'cost': 100000}) == 100000
