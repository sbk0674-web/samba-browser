# 결제 에이전트 — dry-run / 정상 / 카드 없음 / 캡차 / 승인 거절 / 성공 문구 미확인
import json

import httpx
import pytest
import respx

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.payer import PayerAgent
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.ops.masking import find_leaks
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
# 결제창 진입 스크립트의 실제 응답 형식(checkout_enter_*: {ok, method, popup_url})
ENTER_OK = '{"ok": true, "method": "현대카드", "popup_url": null}'
ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='S1', qty=1)


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def assignment(
    reg,
    *,
    dry_run: bool,
    card: str | None = '현대',
    handoff=None,
    dry_run_digits: int = 0,
) -> Assignment:
    spec = reg['payer']
    return Assignment(
        order=ORDER,
        options={'card': card} if card else {},
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=dry_run,
        dry_run_digits=dry_run_digits,
        # 결제 앱(provider)은 여기서 사람이 정해 넘기지 않는다 — payer 가 카드 이름이나
        # 결제창(list_tabs) 을 보고 스스로 정한다(사용자 결정)
        handoff={'cost': 89000, **(handoff or {})},
    )


def agent(reg) -> PayerAgent:
    spec = reg['payer']

    # 결제 에이전트는 LLM 을 쓰지 않는다 — decide 를 부르면 테스트가 터지게 둔다
    def never(_p, _m):
        raise AssertionError('결제 에이전트는 LLM 판단을 하지 않는다')

    return PayerAgent(spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), never)


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


# 결제창(팝업) 목록 흉내 — 앱 list_tabs(src/main/agent/tools.ts)가 돌려주는 모양(id·kind·title·url).
# popup_url 이 있으면 결제창 팝업 하나를 섞어 넣고, 없으면 탭만 돌려준다(결제창이 안 뜬 경우)
def list_tabs_page(popup_url: str | None) -> httpx.Response:
    targets: list[dict[str, object]] = [
        {
            'id': 't1',
            'kind': 'tab',
            'title': '무신사',
            'url': 'https://www.musinsa.com/order',
            'active': True,
        }
    ]
    if popup_url:
        targets.append(
            {'id': 'p1', 'kind': 'popup', 'title': '결제', 'url': popup_url, 'openerId': 't1'}
        )
    return page(json.dumps(targets, ensure_ascii=False))


TOSS_POPUP_URL = 'https://pay.toss.im/checkout'


@respx.mock
def test_dry_run_이면_결제하지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment')
    out = agent(reg)(assignment(reg, dry_run=True))
    assert out.status == 'ok'
    assert out.payload == {'dry_run': True, 'paid': False}
    assert not pay.called  # 외부를 바꾸지 않았다


@respx.mock
def test_실제_결제는_폰_승인까지_하고_성공_문구를_확인한다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(
        side_effect=[page('결제 진행 중'), page('결제 완료되었습니다')]
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    assert out.payload['paid'] is True
    assert pay.called
    # 한 번의 실행에서 폰 승인은 정확히 한 번만 — 같은 주문을 두 번 결제하지 않는다
    assert pay.calls.call_count == 1


@respx.mock
def test_카드가_없으면_시작도_하지_않는다(reg):
    enter = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card=None))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)
    assert not enter.called


@respx.mock
def test_캡차는_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('needs_user: 캡차'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.CAPTCHA)


@respx.mock
def test_폰_승인이_거절되면_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('declined: 한도 초과'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.UNKNOWN


@respx.mock
def test_성공_문구를_못_보면_ok_를_내지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('처리 중입니다'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.VERIFY_MISMATCH)
    assert '결제됐는지' in out.reason


@respx.mock
def test_결제_응답에_비밀값이_실리지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    body = fill.calls.last.request.content.decode('utf-8')
    assert 'password' not in body.lower() or '"value"' not in body  # 값을 보내지 않는다
    assert 'pin' not in str(out.payload).lower()
    assert not find_leaks(out.payload)
    assert not find_leaks(out.reason)
    assert not find_leaks([e.detail for e in out.evidence])


@respx.mock
def test_결제창_진입_인자는_카드명에_따옴표가_있어도_유효한_JSON이다(reg):
    """수기 문자열 포맷 대신 json.dumps 를 쓴다 — 카드명에 따옴표가 섞여도 깨지지 않는다."""
    enter = respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=True, card='현대"카드'))
    assert out.status == 'ok'
    body = json.loads(enter.calls.last.request.content.decode('utf-8'))
    script_args = json.loads(
        body['args']['args']
    )  # 스크립트 args 자체도 유효 JSON 문자열이어야 한다
    assert script_args['card'] == '현대"카드'
    # 재작성 계약: 시험 실행이면 dryRun, 주문 대조용 expect 를 같이 넘긴다
    assert script_args['dryRun'] is True
    assert set(script_args['expect']) == {'name', 'option', 'selected', 'product_no'}


def _enter_expect(reg, a, form: str = '주문서') -> dict:
    enter = respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page(form))
    out = agent(reg)(a)
    assert out.status == 'ok', out.reason
    body = json.loads(enter.calls.last.request.content.decode('utf-8'))
    return json.loads(body['args']['args'])['expect']


@respx.mock
def test_교차_구매면_expect_는_산_사이트의_상품번호와_상품명을_쓴다(reg):
    """무신사 주문을 29CM 에서 샀다 — 주문 URL(무신사) 번호·삼바 상품명이 아니라 구매 인계값으로 대조한다."""
    a = assignment(
        reg,
        dry_run=True,
        handoff={'buy_source': '29CM', 'product_no': '3544786', 'product_name': '에어포스 1 로우 트리플'},
    )
    a = a.model_copy(update={'order': ORDER.model_copy(update={'product_url': 'https://www.musinsa.com/products/5901754'})})
    # 결제 전 주문서 대조(_check_order_form)도 산 사이트 상품명으로 본다 — 삼바 상품명(S1)이 없어도 통과
    exp = _enter_expect(reg, a, '주문서 에어포스 1 로우 트리플 250 1개')
    assert exp['product_no'] == '3544786'
    assert exp['name'] == '에어포스 1 로우 트리플'


@respx.mock
def test_교차_구매_주문서에_산_상품명이_없으면_결제하지_않는다(reg):
    a = assignment(reg, dry_run=True, handoff={'buy_source': '29CM', 'product_no': '3544786', 'product_name': '에어포스 1 로우 트리플'})
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('주문서 후디 XS 1개'))
    out = agent(reg)(a)
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.VERIFY_MISMATCH)


@respx.mock
def test_같은_사이트_구매도_결제_진입엔_사이트_상품명_번호는_인계값_우선(reg):
    # 2026-09-27 변경: 결제 진입 스크립트는 사이트 주문서 글자만 보므로 사이트 상품명으로 대조한다
    a = assignment(reg, dry_run=True, handoff={'buy_source': '무신사', 'product_no': '5901754', 'product_name': '다른 이름'})
    a = a.model_copy(update={'order': ORDER.model_copy(update={'product_url': 'https://www.musinsa.com/products/5901754'})})
    exp = _enter_expect(reg, a)
    assert (exp['product_no'], exp['name']) == ('5901754', '다른 이름')


@respx.mock
def test_인계_상품번호가_없으면_주문_URL_번호를_쓴다(reg):
    a = assignment(reg, dry_run=True)
    a = a.model_copy(update={'order': ORDER.model_copy(update={'product_url': 'https://www.musinsa.com/products/5901754'})})
    assert _enter_expect(reg, a)['product_no'] == '5901754'


def test_구매_인계값에_상품번호와_상품명이_실린다():
    from samba_agent.agents.contracts import AgentResult
    from samba_agent.supervisor.assign import _handoff

    r = AgentResult(status='ok', reason='ok', payload={'product_no': '3544786', 'product_name': '에어포스', 'buy_source': '29CM'})
    out = _handoff({'results': {'buyer.cm29': r}})
    assert (out['product_no'], out['product_name'], out['buy_source']) == ('3544786', '에어포스', '29CM')


@respx.mock
def test_카드_요구_거절은_카드_없음으로_분류한다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(
        return_value=page('refused: card-required - call again with card set')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)


@respx.mock
def test_카드를_못_찾으면_카드_없음으로_분류한다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(
        return_value=page('refused: card-not-found')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)


@pytest.mark.parametrize(
    ('refusal', 'reason'),
    [
        ('refused: pay-account-ambiguous (choose payAccount: a, b)', FailReason.UNKNOWN),
        ('refused: pay-account-mismatch (a != b)', FailReason.UNKNOWN),
        ('refused: no-account', FailReason.UNKNOWN),
        # 금고 잠김은 다시 해도 같다 — 권한 부족으로 분류해 재시도를 막는다(리뷰 지적 — I5)
        ('refused: vault-locked', FailReason.PERMISSION_DENIED),
        ('refused: verify-failed', FailReason.UNKNOWN),
    ],
)
@respx.mock
def test_계정_모호_불일치_잠김_인증실패는_사람에게_넘기고_사유를_담는다(reg, refusal, reason):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page(refusal))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', reason)
    # refused: 뒤 사유 원문(비밀 없음)이 reason 에 남는다 — 사람이 무엇 때문인지 바로 안다
    assert refusal.removeprefix('refused:').strip()[:20] in out.reason


@respx.mock
def test_거절_한글_표기도_사람에게_넘긴다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('refused: 거절됨'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.UNKNOWN)


@respx.mock
def test_결제_에이전트는_재시도하지_않는다(reg):
    """등록부 payer 행의 retry 가 0 이다. 폰 승인이 거절돼도 다시 부르지 않고 그대로 사람에게 넘긴다
    (같은 주문 재결제 방지). 중복 주문 자체의 차단은 큐(order_no UNIQUE, queue/db.py)의 몫이라
    이 에이전트 범위 밖이다 — 여기서는 한 번의 실행 안에서 도구를 다시 부르지 않는 것만 본다.
    """
    spec = reg['payer']
    assert spec.retry == 0
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(
        return_value=page('declined: 한도 초과')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'needs_human'
    assert pay.calls.call_count == 1  # 거절돼도 다시 부르지 않는다


@respx.mock
def test_권한_부족이면_재시도_없이_바로_실패한다(reg):
    """브릿지가 401/403 을 돌려주면(토큰 오류·키마스터 잠김) 재시도 없이 바로 fail 이다."""
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=httpx.Response(403, json={'error': 'forbidden'})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'fail'
    assert out.fail_reason == FailReason.PERMISSION_DENIED


@respx.mock
def test_이미_결제된_화면이면_폰_승인을_부르지_않는다(reg):
    # 리뷰 지적 — Critical 2 ③: 폰 승인 전에 주문 상세를 1회 읽어 재결제를 막는다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('주문이 완료되었습니다 주문번호 A12345'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=page('[]'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.PAY_INTERRUPTED)
    assert not pay.called
    assert not fill.called


@respx.mock
def test_요청자가_카드를_안_주면_구매가_고른_카드로_결제한다(reg):
    # 리뷰 지적 — C3: options 에 카드가 없으면 인계값의 카드를 쓴다
    enter = respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=True, card=None, handoff={'card': '현대'}))
    assert out.status == 'ok'
    body = json.loads(enter.calls.last.request.content.decode('utf-8'))
    assert json.loads(body['args']['args'])['card'] == '현대'


@respx.mock
def test_성공_화면에서_소싱_주문번호를_뽑아_넘긴다(reg):
    # 리뷰 지적 — I2: 아무도 source_order_no 를 만들지 않아 기록·검증이 비어 있었다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[7] textbox "이름"'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(
        side_effect=[page('결제 진행 중'), page('결제 완료되었습니다 주문번호 M-20260922-77')]
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    assert out.payload['source_order_no'] == 'M-20260922-77'


# 앱 스키마(src/main/agent/tools.ts fill_secret · tools-phone.ts phone_approve_payment)
FILL_SECRET_KEYS = {'elementId', 'itemType', 'field', 'accountLabel', 'provider', 'format'}
PAY_KEYS = {'provider', 'amountKrw', 'merchant', 'methodLabel', 'card', 'payAccount'}
PAY_PROVIDERS = {'toss', 'payco', 'kakaopay', 'naverpay'}
ITEM_TYPES = {'login', 'password', 'card', 'note', 'identity', 'document'}


def _args(route) -> dict:
    return json.loads(route.calls.last.request.content.decode('utf-8'))['args']


def _full_pay_mocks(popup_url: str | None = TOSS_POPUP_URL):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(popup_url))
    # 팝업이 0개일 때만 실제로 불린다(리뷰 지적 — Minor 4) — 다른 시나리오에서는 그냥 등록만 해 둔다
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/find_elements').mock(
        return_value=page('INTERACTIVE ELEMENTS:\n[12] textbox "주문자 이름"')
    )
    respx.post(f'{URL}/tool/get_page').mock(
        side_effect=[page('결제 진행 중'), page('결제 완료 주문번호 M-1')]
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    return fill, pay


@respx.mock
def test_fill_secret_인자가_앱_스키마와_맞는다(reg):
    # 리뷰 지적 — I6: 필수 elementId·itemType 없이 부르면 앱이 400 이다
    fill, _pay = _full_pay_mocks()
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    args = _args(fill)
    assert set(args) <= FILL_SECRET_KEYS
    assert isinstance(args['elementId'], int)
    assert args['elementId'] == 12
    assert args['itemType'] in ITEM_TYPES
    assert args['itemType'] == 'identity'


@respx.mock
def test_phone_approve_payment_인자가_앱_스키마와_맞는다(reg):
    # 리뷰 지적 — I7: provider enum · 양의 정수 amountKrw · merchant · methodLabel 이 필수다.
    # 카드 이름 자체가 결제 앱을 가리키면(토스페이) 결제창을 보지 않고 바로 정한다
    _fill, pay = _full_pay_mocks(popup_url=None)
    out = agent(reg)(assignment(reg, dry_run=False, card='토스페이', handoff={'cost': 89000}))
    assert out.status == 'ok'
    args = _args(pay)
    assert set(args) <= PAY_KEYS
    assert args['provider'] in PAY_PROVIDERS
    assert args['provider'] == 'toss'
    assert isinstance(args['amountKrw'], int) and args['amountKrw'] == 89000
    assert args['merchant'] == '무신사'
    assert args['methodLabel'] == '토스페이'


@respx.mock
def test_카드_브랜드는_결제앱_안에서_고를_카드로_넘긴다(reg):
    # 사용자 결정 — 결제 앱은 카드 이름이 아니라 결제창(팝업) 호스트로 정한다.
    # 결제수단 '현대카드' + 결제창 pay.toss.im 팝업 → provider toss 로 부른다
    _fill, pay = _full_pay_mocks(popup_url=TOSS_POPUP_URL)
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    args = _args(pay)
    assert args['provider'] == 'toss'
    assert args['card'] == '현대카드'


@respx.mock
def test_카드_이름이_네이버페이면_폰_승인이_아니라_PC_결제창_키패드로_낸다(reg):
    # 네이버페이는 PC 결제창(pay.naver.com 비밀번호 키패드)에서 낸다 — 폰 승인 도구로 보내면 휴대폰 네이버 앱 경로라
    # 폰이 없어 시간 초과로 끊겼다(실기 2026-09-25 ABC). 모바일 결제는 안정화 전까지 쓰지 않는다(사용자)
    fill, pay = _full_pay_mocks(popup_url=None)
    a = assignment(
        reg, dry_run=False, card='네이버페이', handoff={'cost': 89000, 'pay_account': 'acc-a'}
    )
    out = agent(reg)(a)
    assert out.status == 'ok'
    assert not pay.called
    providers = [json.loads(c.request.content)['args'].get('provider') for c in fill.calls]
    assert 'naver' in providers

@respx.mock
def test_토스여도_handoff에_pay_account가_있어도_넘기지_않는다(reg):
    # payAccount 는 앱 스키마상 네이버페이 전용이지만, 어떤 provider 에도 넘기지 않는 게
    # 사용자 결정이다(리뷰 지적 — Critical 1) — 토스에서도 죽은 값이 새 나가지 않는지 본다
    _fill, pay = _full_pay_mocks(popup_url=None)
    out = agent(reg)(
        assignment(
            reg, dry_run=False, card='토스페이', handoff={'cost': 89000, 'pay_account': 'acc-b'}
        )
    )
    assert out.status == 'ok'
    args = _args(pay)
    assert args['provider'] == 'toss'
    assert 'payAccount' not in args


@respx.mock
def test_금액을_모르면_결제하지_않는다(reg):
    # amountKrw 는 양의 정수여야 한다 — 모르면 결제 자체를 하지 않는다
    _fill, pay = _full_pay_mocks()
    out = agent(reg)(assignment(reg, dry_run=False, handoff={'cost': None}))
    assert out.status == 'needs_human'
    assert not pay.called


@respx.mock
def test_결제앱을_정할_수_없으면_폰_승인_없이_웹_결제_경로로_간다(reg):
    # 사용자 결정 — 결제창(팝업)이 없고 결제수단 문자열에도 앱 이름이 없으면(사이트 자체
    # 결제·카드 직접 결제) phone_approve_payment 를 부르지 않는다. 그래도 성공 문구를
    # 화면에서 확인하기 전에는 ok 를 내지 않는다
    _fill, pay = _full_pay_mocks(popup_url=None)
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    assert not pay.called


@respx.mock
def test_list_tabs가_실패하면_사람에게_넘긴다(reg):
    # 결제창을 못 본 채로 결제 앱을 찍어 승인하면 안 된다 — list_tabs 자체가 실패하면
    # (브릿지 오류 등) needs_human 이다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=httpx.Response(500, json={'error': 'boom'})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'needs_human'
    assert not pay.called


@respx.mock
def test_신원정보_입력칸이_없어도_웹_결제_경로로_진행한다(reg):
    # 플레이북 §7 무신사머니: 결제창엔 신원정보 칸이 없다 — 있을 때만 채우고, 없으면 키패드(fill_secret password)로 간다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('no element matches "이름"'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(None))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('ok: entered'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, handoff={'cost': 89000}))
    assert out.status == 'ok', out.reason
    assert not pay.called
    assert [json.loads(c.request.content)['args']['itemType'] for c in fill.calls] == ['password']


@respx.mock
def test_list_tabs_실패_사유는_원래_fail_reason을_그대로_남긴다(reg):
    # 리뷰 지적 — Minor 3: list_tabs 의 AgentFailure 를 UNKNOWN 으로 재포장하지 않는다.
    # 403 은 브릿지가 PERMISSION_DENIED 로 분류한다(client.py) — needs_human 으로 넘어가도
    # 그 사유가 그대로 남아야 한다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=httpx.Response(403, json={'error': 'forbidden'})
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'needs_human'
    assert out.fail_reason is FailReason.PERMISSION_DENIED
    assert not pay.called


@respx.mock
def test_결제창이_아직_없으면_한번_기다렸다_다시_본다(reg):
    # 리뷰 지적 — Minor 4: run_script checkout_enter_* 직후 팝업이 0개면 바로 웹 경로로
    # 가지 않고 wait(2초) 후 list_tabs 를 한 번 더 본다. 두 번째에는 팝업이 잡힌다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    wait = respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    list_tabs = respx.post(f'{URL}/tool/list_tabs').mock(
        side_effect=[
            list_tabs_page(None),  # 결제 전 '이미 결제됐나' 검사
            list_tabs_page(None),
            list_tabs_page(TOSS_POPUP_URL),
            list_tabs_page(TOSS_POPUP_URL),
            list_tabs_page(None),  # 결제 뒤 주문번호용 탭 목록
            list_tabs_page(None),
        ]
    )
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    assert json.loads(wait.calls[0].request.content.decode('utf-8'))['args'] == {'ms': 2000}
    assert list_tabs.calls.call_count >= 2
    assert pay.called
    assert _args(pay)['provider'] == 'toss'


@respx.mock
def test_결제창이_끝내_안_뜨면_한번만_기다리고_웹_경로로_간다(reg):
    # 두 번째 list_tabs 도 팝업이 0개면 더 기다리지 않고(wait 는 딱 한 번) 웹 결제 경로로 간다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    wait = respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    list_tabs = respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(None))
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    # 결제창 대기(2초)는 한 번만 — 그 뒤 wait 는 키패드 입력 후 결과 대기다
    assert json.loads(wait.calls[0].request.content.decode('utf-8'))['args'] == {'ms': 2000}
    assert list_tabs.calls.call_count >= 2
    assert not pay.called


def _list_tabs_with_two_popups(providers: tuple[str, str]) -> httpx.Response:
    """서로 다른 결제 호스트를 가리키는 팝업 두 개를 흉내 낸다. openerId 가 't1' 인데 't1' 은
    활성 탭이 아니다 — 활성 탭 우선 규칙으로 풀리지 않게 해서 provider 다름 판정을 본다."""
    hosts = {'toss': TOSS_POPUP_URL, 'naverpay': 'https://pay.naver.com/checkout'}
    targets: list[dict[str, object]] = [
        {
            'id': 't1',
            'kind': 'tab',
            'title': '무신사',
            'url': 'https://www.musinsa.com',
            'active': False,
        },
        {
            'id': 'p1',
            'kind': 'popup',
            'title': '결제1',
            'url': hosts[providers[0]],
            'openerId': 't1',
        },
        {
            'id': 'p2',
            'kind': 'popup',
            'title': '결제2',
            'url': hosts[providers[1]],
            'openerId': 't1',
        },
    ]
    return page(json.dumps(targets, ensure_ascii=False))


@respx.mock
def test_매칭_팝업이_둘이고_서로_다른_provider면_사람에게_넘긴다(reg):
    # 리뷰 지적 — Important 2: 팝업이 여럿이고 서로 다른 결제 앱을 가리키면 코드가 짐작하지
    # 않고 사람에게 넘긴다. 근거에 두 호스트가 남는다
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('결제 진행 중'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=_list_tabs_with_two_popups(('toss', 'naverpay'))
    )
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'needs_human'
    assert not pay.called
    assert 'pay.toss.im' in out.reason or 'tosspayments' in out.reason
    assert 'pay.naver.com' in out.reason


@respx.mock
def test_매칭_팝업이_여러개면_활성_탭이_연_팝업을_우선한다(reg):
    # 리뷰 지적 — Important 2: openerId 가 활성 탭인 팝업을 우선한다(같은 provider 중복이 아니라
    # 마지막이 다른 provider 여도 활성 탭 쪽을 쓴다)
    targets: list[dict[str, object]] = [
        {
            'id': 't1',
            'kind': 'tab',
            'title': '무신사',
            'url': 'https://www.musinsa.com',
            'active': False,
        },
        {
            'id': 't2',
            'kind': 'tab',
            'title': '29CM',
            'url': 'https://www.29cm.co.kr',
            'active': True,
        },
        {'id': 'p1', 'kind': 'popup', 'title': '결제1', 'url': TOSS_POPUP_URL, 'openerId': 't1'},
        {
            'id': 'p2',
            'kind': 'popup',
            'title': '결제2',
            'url': 'https://online-pay.kakao.com/checkout',
            'openerId': 't2',
        },
    ]
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=page(json.dumps(targets, ensure_ascii=False))
    )
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    assert _args(pay)['provider'] == 'kakaopay'  # p2 를 연 t2 가 활성 탭이다


@respx.mock
def test_활성_탭이_연_팝업이_없으면_가장_최근_팝업을_쓴다(reg):
    # 매칭 팝업 둘 다 같은 provider 이고(중복 팝업), 어느 openerId 도 활성 탭이 아니면
    # 목록의 마지막(가장 최근에 뜬 것)을 쓴다
    targets: list[dict[str, object]] = [
        {
            'id': 't1',
            'kind': 'tab',
            'title': '무신사',
            'url': 'https://www.musinsa.com',
            'active': True,
        },
        {'id': 't2', 'kind': 'tab', 'title': '숨은 탭', 'url': 'about:blank', 'active': False},
        {'id': 'p1', 'kind': 'popup', 'title': '결제1', 'url': TOSS_POPUP_URL, 'openerId': 't2'},
        {
            'id': 'p2',
            'kind': 'popup',
            'title': '결제2(최근)',
            'url': 'https://tosspayments.com/checkout',
            'openerId': 't2',
        },
    ]
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/list_tabs').mock(
        return_value=page(json.dumps(targets, ensure_ascii=False))
    )
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=[page('결제 진행 중'), page('결제 완료')])
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=False, card='현대카드', handoff={'cost': 89000}))
    assert out.status == 'ok'
    assert _args(pay)['provider'] == 'toss'
    assert _args(pay)['card'] == '현대카드'


@respx.mock
def test_시험_입력은_폰_승인을_자리수만_실어_한_번_부른다(reg):
    """dry_run_digits 가 있으면 결제창 진입 뒤 결제 비밀번호를 그 자리수만 눌러 보고 취소한다."""
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    get_page = respx.post(f'{URL}/tool/get_page')
    pay = respx.post(f'{URL}/tool/phone_approve_payment').mock(
        return_value=page('refused: dry-run (typed 3 digits then cancelled)')
    )
    out = agent(reg)(assignment(reg, dry_run=True, dry_run_digits=3))

    assert out.status == 'ok'
    assert out.payload == {
        'dry_run': True,
        'paid': False,
        'keypad_tested': True,
        'digits': 3,
    }
    assert pay.calls.call_count == 1
    body = json.loads(pay.calls.last.request.content.decode('utf-8'))
    assert body['args']['dryRunDigits'] == 3
    assert body['args']['provider'] == 'toss'
    # 결제 성공 확인 경로로는 가지 않는다(결제하지 않았으므로)
    assert not get_page.called
    assert not find_leaks(out.payload)
    assert not find_leaks(out.reason)
    assert not find_leaks([e.detail for e in out.evidence])


@respx.mock
def test_시험_입력에서_결제창이_웹_키패드면_fill_secret_을_부른다(reg):
    """결제 앱을 정할 수 없으면(팝업 없음) 웹 키패드 경로로 같은 시험 입력을 한다."""
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(None))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[7] textbox "비밀번호"'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment')
    fill = respx.post(f'{URL}/tool/fill_secret').mock(
        return_value=page('refused: DRY_RUN — typed 3 digits then closed (popup closed)')
    )
    out = agent(reg)(assignment(reg, dry_run=True, dry_run_digits=3))

    assert out.status == 'ok'
    assert out.payload['keypad_tested'] is True
    assert not pay.called
    body = json.loads(fill.calls.last.request.content.decode('utf-8'))
    assert body['args']['dryRunDigits'] == 3
    assert body['args']['elementId'] == 7


@respx.mock
def test_시험_입력이_아닌_응답이_오면_사람에게_넘긴다(reg):
    """시험 입력을 시켰는데 'ok'(결제됨)가 오면 그냥 넘기지 않는다."""
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=True, dry_run_digits=3))
    assert (out.status, out.fail_reason) == ('needs_human', FailReason.PAY_INTERRUPTED)


@respx.mock
def test_시험_입력에서도_진짜_거절은_그대로_실패다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(
        return_value=page('refused: card-not-found')
    )
    out = agent(reg)(assignment(reg, dry_run=True, dry_run_digits=3))
    assert (out.status, out.fail_reason) == ('fail', FailReason.CARD_MISSING)


@respx.mock
def test_자리수가_0이면_예전처럼_결제창까지만_간다(reg):
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    pay = respx.post(f'{URL}/tool/phone_approve_payment')
    fill = respx.post(f'{URL}/tool/fill_secret')
    out = agent(reg)(assignment(reg, dry_run=True, dry_run_digits=0))
    assert out.payload == {'dry_run': True, 'paid': False}
    assert not pay.called
    assert not fill.called


# ---- 결제 직전 SAMBA 재조회(플레이북 §5-1) ----

WAVE_BASE = 'https://wave.test'
WAVE_API = f'{WAVE_BASE}/api/v1/internal/harness'


def agent_with_wave(reg) -> PayerAgent:
    from samba_agent.wave.client import WaveClient

    a = agent(reg)
    a.set_wave(WaveClient(WAVE_BASE, 'test-token', 'tenant-1'))
    return a


def _wave_order(**fields):
    return respx.get(f'{WAVE_API}/orders/A1').mock(
        return_value=httpx.Response(200, json={'order_number': 'A1', **fields})
    )


@respx.mock
def test_결제_직전_재조회에서_소싱주문번호가_있으면_중복으로_끝낸다(reg):
    _wave_order(status='pending', sourcing_order_number='M-777')
    enter = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent_with_wave(reg)(assignment(reg, dry_run=False))
    assert (out.status, out.fail_reason) == ('fail', FailReason.DUPLICATE)
    assert not enter.called  # 결제창에 들어가지도 않았다


@respx.mock
def test_결제_직전_재조회에서_상태가_바뀌었으면_사람에게_넘긴다(reg):
    _wave_order(status='cancelled')
    enter = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent_with_wave(reg)(assignment(reg, dry_run=True))
    assert out.status == 'needs_human'
    assert out.reason == '상태 변경: cancelled'
    assert not enter.called


@respx.mock
def test_결제_직전_재조회가_실패하면_결제하지_않는다(reg):
    respx.get(f'{WAVE_API}/orders/A1').mock(return_value=httpx.Response(503))
    enter = respx.post(f'{URL}/tool/run_script')
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent_with_wave(reg)(assignment(reg, dry_run=False))
    assert out.status == 'needs_human'
    assert not enter.called


@respx.mock
def test_재조회가_미처리면_결제를_이어가고_누가_결제했는지_남긴다(reg):
    _wave_order(status='pending')
    respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(TOSS_POPUP_URL))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[12] textbox "주문자 이름"'))
    respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('filled'))
    respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('approved'))
    respx.post(f'{URL}/tool/get_page').mock(
        side_effect=[page('결제 진행 중'), page('결제 완료되었습니다')]
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent_with_wave(reg)(assignment(reg, dry_run=False))
    assert out.status == 'ok'
    assert out.payload['paid_by'] == 'agent'
    assert any(e.label == '결제 직전 재조회' for e in out.evidence)


def test_공장이_결제_에이전트에도_삼바웨이브를_꽂는다(reg):
    from samba_agent.agents.factory import build_agents
    from samba_agent.wave.client import WaveClient

    wave = WaveClient(WAVE_BASE, 'test-token', 'tenant-1')
    bridge = BridgeClient(URL, 'a' * 64, allowed=())
    agents = build_agents(reg, bridge, lambda p, m: m(choice='x', reason='r'), wave)
    assert agents['payer']._wave is wave
    assert build_agents(reg, bridge, lambda p, m: m(choice='x', reason='r'))['payer']._wave is None


def test_card_app_code_는_카드사를_결제_앱_검색어로_바꾼다():
    from samba_agent.agents.payer import card_app_code

    assert card_app_code('현대카드') == '현대'
    assert card_app_code('KB국민카드') == 'Smart'
    assert card_app_code('롯데카드') == 'LOCA'
    assert card_app_code('신한카드') == '11번가'
    assert card_app_code('농협카드') == 'zgm'
    assert card_app_code('삼성카드') == '삼성카드'
    assert card_app_code(None) is None


def test_web_pay_provider_separates_musinsapay_from_site_money() -> None:
    from samba_agent.agents.payer import _keypad_not_ready, web_pay_provider

    assert web_pay_provider('무신사페이') == 'musinsapay'
    assert web_pay_provider('무신사머니') == 'site'
    assert web_pay_provider('토스페이') is None
    # 슈마커 간편결제(슈마커PAY)는 사이트 결제 비밀번호
    assert web_pay_provider('슈마커 간편결제') == 'site'
    # 키패드가 아직 안 뜬 화면의 거절은 기다렸다 다시 본다 — 한 번 누른 뒤의 거절은 다시 누르지 않는다
    assert _keypad_not_ready('refused: target is not a secret input')
    assert not _keypad_not_ready('ok: the app entered the payment password on the keypad.')


@respx.mock
def test_결제창_진입_실패면_비밀번호_단계로_가지_않는다(reg):
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page('{"ok": false, "error": "method-not-found"}')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    fill = respx.post(f'{URL}/tool/fill_secret')
    out = agent(reg)(assignment(reg, dry_run=False))
    assert out.status == 'needs_human'
    assert 'method-not-found' in out.reason
    assert not fill.called


@respx.mock
def test_웹_키패드가_늦게_뜨면_기다렸다_다시_누른다(reg, monkeypatch):
    from samba_agent.agents import payer as payer_mod

    monkeypatch.setattr(payer_mod, 'KEYPAD_POLL_WAIT_MS', 100)
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=page('[]'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[3] textbox "비밀번호"'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(
        side_effect=[
            page('refused: target is not a secret input'),
            page('ok: the app entered the payment password on the keypad.'),
        ]
    )
    a = agent(reg)
    a._dry_run = False
    a._web_pay(assignment(reg, dry_run=False))
    assert fill.call_count == 2


def test_결제_전_검사는_결제창_일반_문구로_멈추지_않는다():
    from samba_agent.agents.payer import looks_already_paid

    assert not looks_already_paid('[]', '무신사페이 결제 완료 시 최대 5% 적립 approved')
    assert looks_already_paid('[{"url":"https://www.musinsa.com/order/result/123"}]', '')
    assert looks_already_paid('[]', '주문이 완료되었습니다 주문번호 202609241546330001')


def test_주문번호는_완료_탭_주소에서도_읽는다():
    from samba_agent.agents.payer import _source_order_no

    tabs = '[{"url":"https://www.musinsa.com/order/result/202609241804480002"}]'
    assert _source_order_no('결제가 완료되었습니다', tabs) == '202609241804480002'
    assert _source_order_no('주문번호 A12345', '') == 'A12345'
    assert _source_order_no('결제가 완료되었습니다', '[]') is None


@respx.mock
def test_dry_run_포인트_전액이면_결제창_진입_스크립트도_부르지_않는다(reg):
    # 포인트 전액 결제는 결제하기 한 번에 주문이 끝난다 — 시험에서 진입 스크립트를 부르면 실주문이 된다
    enter = respx.post(f'{URL}/tool/run_script').mock(return_value=page(ENTER_OK))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    out = agent(reg)(assignment(reg, dry_run=True, card='포인트전액'))
    assert out.status == 'ok'
    assert out.payload == {'dry_run': True, 'paid': False, 'points_only': True}
    assert not enter.called


def test_주문서가_다른_상품이면_결제하지_않는다() -> None:
    """실기 2026-09-26: 197(나이키 코르테즈 240)이 앞 작업의 아디다스 210 주문서를 결제했다."""
    from samba_agent.agents.payer import order_form_mismatch

    adidas_form = '주문서 아디다스 아디스타 컨트롤 5 EL 칠드런 210 / 1개 89,000원 70,900원'
    assert order_form_mismatch(adidas_form, '나이키 IB1857 201 봄신발 가을신발 코르테즈 스웨이드', '옵션:240', '240')
    assert order_form_mismatch(adidas_form, '매장정품 아디다스 ADIDAS KJ8365 아디스타 컨트롤 5 EL 칠드런 신발', '옵션:210', '210') is None
    # 옵션은 같아도 상품명 고유 단어가 하나도 없으면 다른 상품이다
    assert '상품명' in (order_form_mismatch('아디다스 아디스타 240 / 1개', '나이키 코르테즈 스웨이드', '240') or '')
    # 구매가 상품번호로 확인한 주문서(trust_site)는 사이트 영문명 토큰으로 맞춘다(실기 2026-09-28 B15960 'BIG NIKE LOW')
    assert (
        order_form_mismatch(
            'A-RT 배송 상품 나이키 BIG NIKE LOW 285/ 1 개 82,600 원',
            '나이키 355152 106 통기성 커플샌들 빅 로우 1010109298',
            '옵션:285',
            '285',
            site_name='빅 나이키 로우 BIG NIKE LOW',
            product_no='1010109298',
            trust_site=True,
        )
        is None
    )
    # trust_site 여도 다른 상품(에어 포스 주문서 ↔ 에어맥스 주문)은 사이트명 토큰이 주문서에 있어도 주문과 안 맞으면 막힌다
    assert order_form_mismatch(
        'A-RT 배송 상품 나이키 AIR FORCE 1 07 290/ 1 개', '나이키 우먼스 에어 맥스 인비고', '290', '290',
        site_name='나이키 에어 포스 1 07 AIR FORCE'
    )
    # ABC 주문서는 'NIKE P-6000' 만 보인다 — 사이트 상품명의 모델 토큰(p6000)으로 맞춘다(실기 2026-09-28 B07648)
    assert (
        order_form_mismatch(
            '나이키 NIKE P-6000 265/ 1 개 107,600 원',
            '매장정품 나이키 CN0149 001 P 6000 운동화 1020109440',
            '옵션:265',
            '265',
            site_name='나이키 NIKE P-6000',
            product_no='1020109440',
        )
        is None
    )


# 실기 2026-09-26 ABC 주문서(get_page PAGE TEXT 발췌) — 영문명만 보이고 모델코드·상품번호가 없다
ABC_FORM_198 = 'URL: https://abcmart.a-rt.com/order 주문서작성/결제 A-RT 배송 상품 휠라 DAZE RUN KD 210/ 1 개 840P 89,000 원 41,800 원'
ABC_FORM_204 = (
    'URL: https://abcmart.a-rt.com/order 주문서작성/결제 A-RT 배송 상품 나이키 WMNS NIKE AIR MAX INVIGOR 290/ 1 개 '
    '1,350P 119,000 원 67,400 원'
)


def test_ABC_주문서가_영문명만_보여도_사이트_상품명으로_같은_상품이면_통과한다() -> None:
    """job 198·204: 삼바 상품명의 한글·모델코드가 ABC 주문서에 없어 결제 직전에 멈췄다(오탐)."""
    from samba_agent.agents.payer import order_form_mismatch

    sku198 = '휠라 3XM02475H 봄신발 가을신발 데이즈 런 키즈 1010113096 [210]'
    sku204 = '나이키 749866 101 봄신발 가을신발 우먼스 에어 맥스 인비고 1010120521 [290]'
    # 예전 규칙(삼바 상품명만)은 여전히 못 맞춘다 — 사유에 단어가 남는다
    assert '3XM02475H' in (order_form_mismatch(ABC_FORM_198, sku198, '210', '210') or '')
    assert '인비고' in (order_form_mismatch(ABC_FORM_204, sku204, '290', '290') or '')
    # 구매 스냅샷이 상품 페이지에서 읽은 이름(한글+영문)으로 잇는다
    assert order_form_mismatch(ABC_FORM_198, sku198, '210', '210', site_name='데이즈 런 키즈 DAZE RUN KD') is None
    assert (
        order_form_mismatch(
            ABC_FORM_204, sku204, '290', '290', site_name='나이키 에어 맥스 인비고 WMNS NIKE AIR MAX INVIGOR'
        )
        is None
    )
    # 사이즈가 다르면 이름이 맞아도 막는다
    assert '옵션' in (
        order_form_mismatch(ABC_FORM_198, sku198, '220', '220', site_name='데이즈 런 키즈 DAZE RUN KD') or ''
    )


def test_사이트_상품명이_주문과_다른_상품이면_그것으로_통과시키지_않는다() -> None:
    from samba_agent.agents.payer import order_form_mismatch

    sku = '나이키 IB1857 201 봄신발 가을신발 코르테즈 스웨이드'
    adidas_form = '주문서 아디다스 아디스타 컨트롤 5 EL 칠드런 240 / 1개 89,000원 70,900원'
    # 2026-09-26 사고: 구매는 코르테즈를 봤는데 주문서는 앞 작업의 아디다스 — 사이트 상품명도 주문서에 없다
    assert order_form_mismatch(adidas_form, sku, '240', '240', site_name='나이키 코르테즈 스웨이드 NIKE CORTEZ SUEDE')
    # 스냅샷이 엉뚱한 상품(아디스타)을 열었어도 그 이름이 주문 상품명과 달라 잇지 않는다
    assert order_form_mismatch(adidas_form, sku, '240', '240', site_name='아디다스 아디스타 컨트롤 5 EL 칠드런')
    # 흔한 단어 하나('에어')만 겹치는 다른 모델도 잇지 않는다
    assert order_form_mismatch(
        'A-RT 배송 상품 나이키 AIR FORCE 1 07 290/ 1 개',
        '나이키 우먼스 에어 맥스 인비고',
        '290',
        '290',
        site_name='나이키 에어 포스 1 07 AIR FORCE',
    )


def test_상품번호가_주문서나_탭_주소에_있으면_같은_상품이다() -> None:
    from samba_agent.agents.payer import order_form_mismatch

    form = 'URL: https://www.musinsa.com/order/order-form?goodsNo=5111643 JANE BLACK 250 1개'
    assert order_form_mismatch(form, '매장정품 JQ6445 삼바 제인', '250', '250', product_no='5111643') is None
    # 번호 일부만 겹치는 건 아니다
    assert order_form_mismatch(form.replace('5111643', '51116430'), '삼바 제인', '250', product_no='5111643')
    # 번호가 맞아도 사이즈가 다르면 막는다
    assert '옵션' in (order_form_mismatch(form, '삼바 제인', '260', product_no='5111643') or '')


@respx.mock
def test_결제_전_주문서_대조는_인계받은_사이트_상품명을_쓴다(reg):
    """ABC job 204 재현: 삼바 상품명으론 못 맞추지만 구매 인계 product_name 으로 같은 상품임을 확인한다."""
    respx.post(f'{URL}/tool/get_page').mock(return_value=page(ABC_FORM_204))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    a = agent(reg)
    asg = assignment(
        reg,
        dry_run=True,
        handoff={'selected': '290', 'product_name': '나이키 에어 맥스 인비고 WMNS NIKE AIR MAX INVIGOR'},
    )
    order = asg.order.model_copy(
        update={'sku': '나이키 749866 101 봄신발 가을신발 우먼스 에어 맥스 인비고 1010120521 [290]', 'option': '290'}
    )
    a._check_order_form(asg.model_copy(update={'order': order}))  # 막히지 않는다
    with pytest.raises(AgentFailure):
        a._check_order_form(
            asg.model_copy(update={'order': order, 'handoff': {'selected': '290'}})
        )  # 사이트 상품명이 없으면 예전처럼 막는다


def test_상품번호를_주소에서_뽑는다() -> None:
    from samba_agent.agents.payer import product_no_of

    assert product_no_of('https://www.musinsa.com/products/5901754') == '5901754'
    assert product_no_of('https://abcmart.a-rt.com/product/new?prdtNo=1020113253') == '1020113253'
    assert product_no_of('https://www.shoemarker.co.kr/ASP/Product/ProductDetail.asp?ProductCode=48761') == '48761'
    assert product_no_of(None) == ''


@respx.mock
def test_주문서_대조는_구매가_만든_주문서_탭으로_옮긴_뒤_한다(reg):
    # 활성 탭이 다른 페이지면 엉뚱한 화면을 대조한다 — handoff.order_tab 으로 먼저 옮긴다
    calls: list[str] = []

    def rec(name):
        def _(request):
            calls.append(name)
            return page('ok')

        return _

    switch = respx.post(f'{URL}/tool/switch_tab').mock(side_effect=rec('switch_tab'))
    respx.post(f'{URL}/tool/get_page').mock(side_effect=rec('get_page'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    a = agent(reg)
    try:
        asg = assignment(reg, dry_run=True, handoff={'order_tab': 42})
        order = asg.order.model_copy(update={'sku': '아디다스 아디스타 컨트롤 KJ8365', 'option': '210'})
        a._check_order_form(asg.model_copy(update={'order': order}))
    except AgentFailure:
        pass  # 'ok' 화면은 대조에 실패해도 된다 — 순서만 본다
    assert calls[:2] == ['switch_tab', 'get_page']
    assert json.loads(switch.calls[0].request.content)['args']['id'] == '42'


def test_이미_결제_판정은_이번_사이트의_주문_완료_탭만_본다():
    # 실기 2026-09-27: 남아 있던 ABC 주문 완료 탭 하나로 무신사 결제 5건이 모두 멈췄다
    from samba_agent.agents.payer import looks_already_paid

    tabs = '[{"id":"7","url":"https://abcmart.a-rt.com/order/complete?orderNo=2026092638789"}]'
    assert not looks_already_paid(tabs, '', 'musinsa.com')
    assert looks_already_paid(tabs, '', 'a-rt.com')
    assert looks_already_paid(tabs, '')


@respx.mock
def test_같은_사이트_구매도_결제_진입_expect_name_은_사이트_상품명이다(reg):
    # 실기 2026-09-27: ABC 주문서엔 영문명만 있어 삼바 상품명(모델코드 3XM02475H) 대조로 198 이 막혔다
    a = assignment(reg, dry_run=True, handoff={'product_name': '데이즈 런 키즈 DAZE RUN KD'})
    exp = _enter_expect(reg, a, '주문서 휠라 DAZE RUN KD 210/ 1 개')
    assert exp['name'] == '데이즈 런 키즈 DAZE RUN KD'


# 실기 2026-09-27 ABC 214·218 — 네이버페이 창이 네이버 로그인 화면으로 가 키패드가 없었다
NAVER_LOGIN_POPUP = 'https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fm.pay.naver.com%2F'
NAVER_KEYPAD_POPUP = 'https://m.pay.naver.com/instantPay/nfPayment/abc?isOnAuthorize=true'


def _popups(*urls: str) -> httpx.Response:
    targets: list[dict[str, object]] = [
        {'id': 't1', 'kind': 'tab', 'title': 'ABC', 'url': 'https://abcmart.a-rt.com/order', 'active': True}
    ]
    for i, u in enumerate(urls):
        targets.append({'id': f'p{i}', 'kind': 'popup', 'title': '네이버페이', 'url': u, 'openerId': 't1'})
    return page(json.dumps(targets, ensure_ascii=False))


def _web_pay_agent(reg, monkeypatch):
    from samba_agent.agents import payer as payer_mod

    monkeypatch.setattr(payer_mod, 'KEYPAD_POLL_WAIT_MS', 1)
    monkeypatch.setattr(payer_mod, 'PAY_BUTTON_POLL_WAIT_MS', 1)
    monkeypatch.setattr(payer_mod, 'PAY_POPUP_WAIT_MS', 1)
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/switch_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/run_js').mock(return_value=page('{"clicked": false}'))
    a = agent(reg)
    a._dry_run = False
    return a


@respx.mock
def test_결제창이_네이버_로그인_화면이면_비밀번호를_넣지_않고_바로_멈춘다(reg, monkeypatch):
    a = _web_pay_agent(reg, monkeypatch)
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=_popups(NAVER_LOGIN_POPUP))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page('[4] link "비밀번호 찾기"'))
    respx.post(f'{URL}/tool/switch_tab').mock(return_value=page('ok'))
    # 앱 login 이 연결된 앱 계정을 못 찾으면(2단계 인증·계정 없음) 그대로 사람 확인 — 한 번만 부른다
    login = respx.post(f'{URL}/tool/login').mock(return_value=page('account not found: use list_accounts'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('refused: target is not a secret input'))
    get_page = respx.post(f'{URL}/tool/get_page').mock(return_value=page(''))
    with pytest.raises(AgentFailure) as e:
        a._web_pay(assignment(reg, dry_run=False, card='네이버페이', handoff={'account': 'buyer02'}))
    assert e.value.status == 'needs_human'
    assert '로그인' in e.value.reason and 'buyer02' in e.value.reason
    assert login.call_count == 1
    assert not fill.called
    assert not get_page.called


@respx.mock
def test_결제창_로그인_화면은_앱_login_으로_한번_로그인하고_이어간다(reg, monkeypatch):
    """쇼핑몰 계정에 연결된 네이버 계정으로 결제창에 로그인되면 키패드로 이어 간다(실기 2026-09-28)."""
    from samba_agent.agents.payer import KEYPAD_FILL_MAX_CALLS

    a = _web_pay_agent(reg, monkeypatch)
    respx.post(f'{URL}/tool/list_tabs').mock(
        side_effect=[_popups(NAVER_LOGIN_POPUP)] + [_popups(NAVER_KEYPAD_POPUP)] * 40
    )
    respx.post(f'{URL}/tool/switch_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    login = respx.post(f'{URL}/tool/login').mock(return_value=page('submitted: check the page'))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page(''))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('refused: target is not a secret input'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page(''))
    with pytest.raises(AgentFailure) as e:
        a._web_pay(assignment(reg, dry_run=False, card='네이버페이', handoff={'account': 'buyer02'}))
    # 로그인은 한 번, 그 뒤 로그인 화면으로 멈추지 않고 결제 단계로 넘어갔다
    assert login.call_count == 1
    assert '로그인 화면' not in e.value.reason
    assert fill.call_count <= KEYPAD_FILL_MAX_CALLS


@respx.mock
def test_키패드가_끝내_없으면_상한까지만_부르고_결제확인으로_가지_않는다(reg, monkeypatch):
    from samba_agent.agents.payer import KEYPAD_FILL_MAX_CALLS

    a = _web_pay_agent(reg, monkeypatch)
    # 결제창이 둘이어도 총 호출은 상한을 넘지 않는다
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=_popups(NAVER_KEYPAD_POPUP, NAVER_KEYPAD_POPUP))
    respx.post(f'{URL}/tool/find_elements').mock(return_value=page(''))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('refused: target is not a secret input'))
    get_page = respx.post(f'{URL}/tool/get_page').mock(return_value=page(''))
    with pytest.raises(AgentFailure) as e:
        a._web_pay(assignment(reg, dry_run=False, card='네이버페이'))
    assert e.value.status == 'needs_human'
    assert '키패드가 뜨지 않았다' in e.value.reason and '결제 안 됨' in e.value.reason
    assert fill.call_count == KEYPAD_FILL_MAX_CALLS
    assert not get_page.called


@pytest.mark.parametrize(
    'answer',
    [
        'handoff: 결제 비밀번호는 직접 눌러 주세요',
        'something unexpected from the app',
        'not found: no payment password (naver) saved for this account',
        'refused: the app already entered the payment password once in this window during this task.',
    ],
)
@respx.mock
def test_아직_키패드_아님_이외의_답이_한번이라도_오면_다시_부르지_않는다(reg, monkeypatch, answer):
    a = _web_pay_agent(reg, monkeypatch)
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=_popups(NAVER_KEYPAD_POPUP, NAVER_KEYPAD_POPUP))
    # '결제하기'는 없고(키패드 창) 비밀번호 검색에만 요소가 잡힌다
    respx.post(f'{URL}/tool/find_elements').mock(
        side_effect=lambda req: page('' if '결제하기' in req.content.decode('utf-8') else '[3] button "1"')
    )
    respx.post(f'{URL}/tool/get_page').mock(return_value=page(''))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page(answer))
    try:
        a._web_pay(assignment(reg, dry_run=False, card='네이버페이'))
    except AgentFailure:
        pass  # 멈추든 넘어가든 — 다시 누르지만 않으면 된다
    assert fill.call_count == 1


def test_키패드_아님_판정은_아무것도_누르지_않은_응답만이다() -> None:
    from samba_agent.agents.payer import _is_login_url, _keypad_not_ready

    assert _keypad_not_ready('fill_secret 거절: refused: target is not a secret input')
    assert _keypad_not_ready('Error: element not found')
    assert not _keypad_not_ready('not found: no payment password (naver) saved for this account')
    assert not _keypad_not_ready('account not found: use list_accounts')
    assert not _keypad_not_ready('handoff: 결제 비밀번호는 직접 눌러 주세요')
    assert _is_login_url(NAVER_LOGIN_POPUP)
    assert not _is_login_url(NAVER_KEYPAD_POPUP)
    assert not _is_login_url('https://pay.naver.com/authentication/pw/check?token=abc')
    assert not _is_login_url('')


# ---- 29CM 결제 확인 폴백(실기 2026-09-27 job 244: 페이코 결제가 됐는데 '확인되지 않는다'로 멈춤) ----

CM29_HANDOFF = {
    'buy_source': '29CM',
    'account': 'buyer01',
    'product_name': '다이나핏 HIIT (히트) 남성 폴로티_Black YMM25214Z1',
    'selected': '08(2XL)',
}


def _cm29_found(minutes_ago: int = 1, order_no: str | None = 'ORD20260927-4902978') -> str:
    from datetime import datetime, timedelta

    from samba_agent.agents.payer import _KST

    at = (datetime.now(_KST) - timedelta(minutes=minutes_ago)).strftime('%Y-%m-%d %H:%M')
    body = {'order_no': order_no, 'paid': 59400, 'method': '페이코', 'at': at if order_no else ''}
    body['note'] = None if order_no else '맞는 주문 2건 — 하나로 못 정함'
    return json.dumps(body, ensure_ascii=False)


def _mock_confirm(found: str):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page('https://bill.payco.com/x'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('페이코 결제 진행 중'))
    return respx.post(f'{URL}/tool/run_script').mock(return_value=page(found))


@respx.mock
def test_29CM_완료_화면을_못_잡으면_주문내역의_방금_주문으로_확인한다(reg):
    run = _mock_confirm(_cm29_found())
    a = assignment(reg, dry_run=False, handoff=CM29_HANDOFF)
    out = agent(reg)._confirm_paid(a, '페이코')
    assert out.status == 'ok'
    assert out.payload['source_order_no'] == 'ORD20260927-4902978'
    sent = json.loads(run.calls.last.request.content)['args']
    assert sent['name'] == 'cm29_recent_order'
    args = json.loads(sent['args'])
    assert args['profile'] == 'buyer01'
    assert args['name'] == CM29_HANDOFF['product_name']
    assert args['option'] == '08(2XL)'
    assert args['withinMin'] == 10


@respx.mock
def test_29CM_주문내역이_여러_건이거나_없으면_사람에게_넘긴다(reg):
    _mock_confirm(_cm29_found(order_no=None))
    a = assignment(reg, dry_run=False, handoff=CM29_HANDOFF)
    with pytest.raises(AgentFailure) as e:
        agent(reg)._confirm_paid(a, '페이코')
    assert e.value.fail_reason == FailReason.VERIFY_MISMATCH


@respx.mock
def test_29CM_주문내역의_주문이_10분보다_오래됐으면_쓰지_않는다(reg):
    _mock_confirm(_cm29_found(minutes_ago=30))
    a = assignment(reg, dry_run=False, handoff=CM29_HANDOFF)
    with pytest.raises(AgentFailure):
        agent(reg)._confirm_paid(a, '페이코')


@respx.mock
def test_29CM_이_아닌_구매는_29CM_주문내역을_보지_않는다(reg):
    run = _mock_confirm(_cm29_found())
    a = assignment(reg, dry_run=False, handoff={**CM29_HANDOFF, 'buy_source': 'MUSINSA'})
    with pytest.raises(AgentFailure):
        agent(reg)._confirm_paid(a, '페이코')
    assert not run.called


@respx.mock
def test_29CM_완료_탭으로_옮겨_읽고_주소의_order_serial_을_주문번호로_쓴다(reg):
    confirmed = (
        'https://www.29cm.co.kr/order/confirmed/66965965'
        '?order_serial=ORD20260925-3907371&previous_screen=item_detail'
    )
    tabs = json.dumps(
        [
            {'id': 't1', 'kind': 'tab', 'url': 'https://www.29cm.co.kr/order/checkout'},
            {'id': 't9', 'kind': 'tab', 'url': confirmed},
        ]
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=page(tabs))
    switch = respx.post(f'{URL}/tool/switch_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('주문이 완료되었습니다 결제완료'))
    run = respx.post(f'{URL}/tool/run_script')
    a = assignment(reg, dry_run=False, handoff=CM29_HANDOFF)
    out = agent(reg)._confirm_paid(a, '무신사머니')
    assert json.loads(switch.calls.last.request.content)['args']['id'] == 't9'
    assert out.payload['source_order_no'] == 'ORD20260925-3907371'
    assert not run.called


def test_29CM_완료_주소는_이미_결제로_본다():
    from samba_agent.agents.payer import looks_already_paid

    tabs = '[{"url":"https://www.29cm.co.kr/order/confirmed/66965965?order_serial=ORD20260925-3907371"}]'
    assert looks_already_paid(tabs, '', '29cm.co.kr')
    assert not looks_already_paid(tabs, '', 'musinsa.com')


# ---- 완료 문구는 봤는데 번호를 못 뽑은 경우(실기 2026-09-27 job 262 ABC 네이버페이: recorder 가 번호 없이 멈춤) ----

ABC_HANDOFF = {'buy_source': 'ABCmart', 'account': 'buyer02'}


def _art_found(minutes_ago: int = 1, no: str = '2026092742392') -> str:
    from datetime import datetime, timedelta

    from samba_agent.agents.payer import _KST

    at = (datetime.now(_KST) - timedelta(minutes=minutes_ago)).strftime('%Y-%m-%d %H:%M:%S')
    return json.dumps({'no': no, 'at': at, 'amount': '41,800'})


@respx.mock
def test_완료_문구만_있고_번호가_없으면_ABC_주문내역에서_번호를_채운다(reg):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(None))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('네이버페이 결제가 완료되었습니다 주문완료'))
    js = respx.post(f'{URL}/tool/run_js').mock(return_value=page(_art_found()))
    a = assignment(reg, dry_run=False, handoff=ABC_HANDOFF)
    out = agent(reg)._confirm_paid(a, '네이버페이')
    assert out.status == 'ok'
    assert out.payload['source_order_no'] == '2026092742392'
    code = json.loads(js.calls.last.request.content)['args']['code']
    assert 'abcmart.a-rt.com/mypage/claim/claim-order-main' in code


@respx.mock
def test_완료_문구에서_번호를_뽑았으면_주문내역을_보지_않는다(reg):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(None))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('주문완료 주문번호 2026092742392'))
    js = respx.post(f'{URL}/tool/run_js').mock(return_value=page(_art_found()))
    a = assignment(reg, dry_run=False, handoff=ABC_HANDOFF)
    out = agent(reg)._confirm_paid(a, '네이버페이')
    assert out.payload['source_order_no'] == '2026092742392'
    assert not js.called


@respx.mock
def test_완료_문구만_있고_주문내역도_오래된_주문이면_번호_없이_넘긴다(reg):
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/wait').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=list_tabs_page(None))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('주문완료'))
    respx.post(f'{URL}/tool/run_js').mock(return_value=page(_art_found(minutes_ago=30)))
    a = assignment(reg, dry_run=False, handoff=ABC_HANDOFF)
    out = agent(reg)._confirm_paid(a, '네이버페이')
    assert out.status == 'ok'
    assert 'source_order_no' not in out.payload


def test_order_form_mismatch_띄어쓰기만_다른_고유_단어는_같은_상품():
    from samba_agent.agents.payer import order_form_mismatch

    # 실기 2026-09-30 롯데온 포이즌: 주문 '트래퍼햇' ↔ 주문서 '트래퍼 햇'
    page = '주문상품 노스페이스키즈 NE3CR52T 키즈 트래퍼 햇 BRW M 1개'
    assert order_form_mismatch(page, '노스페이스 폴리에스터 섬유 트래퍼햇 남녀공용', '브라운 M') is None
    # 다른 상품은 여전히 막는다
    assert order_form_mismatch('주문상품 아디다스 아디스타 1개', '나이키 코르테즈 운동화', None) is not None


def test_도착예정일이_3일을_넘으면_메모_한_줄():
    from datetime import date

    from samba_agent.agents.payer import arrival_eta, arrival_memo

    today = date(2026, 9, 30)
    assert arrival_eta('배송 10/03(토) 도착 예정', today) == (date(2026, 10, 3), 3)
    assert arrival_memo('배송 10/03(토) 도착 예정', today) is None
    assert arrival_memo('10월 6일(화) 도착 확률 83%', today) == '[도착예정] 10/06(화) — 결제일 기준 6일'
    assert arrival_memo('도착 정보 없음 1,000원', today) is None
    # 롯데온 표기 '10/6(화) 이내 도착확률 80%'
    assert arrival_memo('M 옵션변경 10/6(화) 이내 도착확률 80%', today) == '[도착예정] 10/06(화) — 결제일 기준 6일'
    # 연말에 본 1월 날짜는 다음 해다
    assert arrival_eta('01.04(월) 도착', date(2026, 12, 30)) == (date(2027, 1, 4), 5)
