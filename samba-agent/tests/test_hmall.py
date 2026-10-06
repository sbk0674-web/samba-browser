"""현대H몰 소싱처(2026-09-27) — 다나와 경유 진입·롯데카드 직접 결제 견적·포인트 정돈 인자·SSG↔H몰 교차(봇 차단 대체)·결제 대기(respx 목)."""

import json

import httpx
import pytest
import respx

from samba_agent.agents import buyer as buyer_mod
from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import (
    _CLOSE_ORDER_TABS_JS,
    DIRECT_CARD_PROVIDER,
    BuyerAgent,
    blocked_failure,
    cheapest_quotes,
    method_providers,
    product_no_of,
    quote_provider,
)
from samba_agent.agents.contracts import AgentResult, Assignment, OrderRef
from samba_agent.agents.factory import build_agents
from samba_agent.agents.payer import PayerAgent, direct_card_of
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.sources import default_sources

URL = 'http://127.0.0.1:47811'
ITEM = 'https://www.hmall.com/md/pda/itemPtc?slitmCd=2240259019'
LANDED = 'https://www.hmall.com/md/pda/itemPtc?ReferCode=250&slitmCd=2240259019&utm_source=danawa'
ENTRY = 'https://prod.danawa.com/bridge/loadingBridge.html?pcode=1&cmpnyc=ED907&link_pcode=2240259019&keyword=HF5441-100'
SSG_URL = 'https://department.ssg.com/item/itemView.ssg?itemId=1000766092973&siteNo=6009'

Calls = list[tuple[str, dict[str, object]]]


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def make_buyer(reg: Registry, name: str = 'buyer.musinsa') -> BuyerAgent:
    spec = reg[name]
    agent = BuyerAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: None,  # type: ignore[arg-type,return-value]
    )
    agent._dry_run = False
    agent.evidence = []
    agent._quote_errors = []
    return agent


@pytest.fixture()
def hmall(reg, monkeypatch) -> BuyerAgent:
    """H몰 행을 쓰는 구매 에이전트. H몰은 hold 라 등록부에 없어 무신사 스펙에 H몰 행을 물린다."""
    row = default_sources().by_id('HMALL')
    assert row is not None
    monkeypatch.setattr(buyer_mod, 'source_of', lambda name: row)
    return make_buyer(reg)


def assignment(url: str | None = ITEM, source: str = 'HMALL', option: str = '285') -> Assignment:
    order = OrderRef(
        order_no='O1',
        source=source,
        seller='쿠팡',
        sku='매장정품 나이키 남성 덩크 로우 레트로 HF5441 100',
        option=option,
        product_url=url,
    )
    return Assignment(order=order, allowed_tools=('run_script', 'progress'), rules='', dry_run=False)


def mock_scripts(responses: dict[str, object], calls: Calls) -> None:
    """run_script 이름별 응답(값이 함수면 인자로 부른다). 부른 (이름, 인자)를 calls 에 쌓는다."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)['args']
        name, args = body['name'], json.loads(body.get('args') or '{}')
        calls.append((name, args))
        if name not in responses:
            raise AssertionError(f'예상치 못한 run_script 호출: {name}')
        got = responses[name]
        out = got(args) if callable(got) else got
        return page(json.dumps(out, ensure_ascii=False))

    respx.post(f'{URL}/tool/run_script').mock(side_effect=handler)
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/run_js').mock(return_value=page('ok'))


SNAP = {
    'options': ['280 [품절]', '285'],
    'selected': '285',
    'cost': 80675,
    'pay_amount': 80675,
    'methods': ['카드', 'H포인트페이', '네이버페이'],
    'product_url': LANDED,
    'product_no': '2240259019',
    'product_name': '[나이키] 덩크 로우 레트로 HF5441-100',
    'order_tab': 'tab-h',
    'route': 'danawa',
    'affiliate': '250',
}
PREP = {
    'ok': True,
    'mode': 'keep_card_discount',
    'total': 50000,
    'points_used': 30675,
    'points_balance': 45815,
    'reward': 50,
    'coupon': 68325,
    'discount': 68325,
}


# --- 소싱처 표·등록부 ------------------------------------------------------


def test_H몰_행은_다나와_경유·롯데카드_직접결제·hold_다() -> None:
    row = default_sources().by_id('HMALL')
    assert row is not None
    assert (row.key, row.entry_route, row.direct_card, row.pay_provider, row.status) == (
        'hmall',
        'danawa',
        '롯데카드',
        DIRECT_CARD_PROVIDER,
        'hold',
    )
    assert row.entry_script == 'hmall_danawa_entry'
    assert row.checkout_script_name == 'checkout_enter_hmall'
    assert row.buy_accounts == ['buyer01'] and row.compare_accounts is False
    assert default_sources().by_id('현대H몰') is row


def test_SSG_의_교차_짝은_H몰이고_H몰은_짝으로만_쓴다(reg) -> None:
    assert default_sources().by_id('SSG').cross_with == 'HMALL'  # type: ignore[union-attr]
    assert [s.id for s in reg.sources.cross_only()] == ['HMALL']
    # H몰 주문은 배정되지 않는다(hold) — 등록부에 buyer.hmall 이 없다
    assert 'buyer.hmall' not in reg.names()
    assert [s.name for s in reg.cross_only_specs()] == ['buyer.hmall']
    agents = build_agents(reg, BridgeClient(URL, 'a' * 64, allowed=(), busy_wait_s=0.0), lambda p, m: None)  # type: ignore[arg-type,return-value]
    assert 'buyer.hmall' not in agents
    ssg = agents['buyer.ssg']
    assert isinstance(ssg, BuyerAgent) and ssg.sibling is not None
    assert ssg.sibling.spec.name == 'buyer.hmall'


def test_H몰_상품번호는_slitmCd_이고_주문서_탭도_닫는다() -> None:
    assert product_no_of(LANDED) == '2240259019'
    assert 'hmall\\.com\\/mo\\/oda\\/order' in _CLOSE_ORDER_TABS_JS


# --- 카드 직접 결제 견적 ---------------------------------------------------


def test_카드_직접결제는_지정_카드사_줄만_card_제공자다() -> None:
    assert quote_provider('카드', '롯데카드', '롯데카드') == DIRECT_CARD_PROVIDER
    assert quote_provider('카드', '현대카드', '롯데카드') is None  # 다른 카드사는 허용 안 함
    assert quote_provider('카드', '롯데카드') is None  # 소싱처가 허용하지 않으면 예전처럼 못 쓴다
    assert quote_provider('네이버페이', None, '롯데카드') == 'naver'
    assert method_providers('카드', direct_card='롯데카드') == {DIRECT_CARD_PROVIDER}
    assert method_providers('카드') == set()


def test_롯데카드_직접결제_견적은_청구할인을_반영해_고른다() -> None:
    rows = [
        {'method': '카드', 'card': '롯데카드', 'cost': 47500, 'reward': 40, 'points_used': 30675},
        {'method': '카드', 'card': '현대카드', 'cost': 50000, 'reward': 50, 'points_used': 30675},
        {'method': '네이버페이', 'card': None, 'cost': 50000, 'reward': 50, 'points_used': 30675},
    ]
    got = cheapest_quotes(rows, None, {DIRECT_CARD_PROVIDER}, direct_card='롯데카드')
    assert [(q['method'], q['card']) for q in got] == [('카드', '롯데카드')]
    # 원가 = 47,500 × 0.98 − 40 + 30,675
    assert got[0]['cost'] == round(47500 * 0.98 - 40 + 30675)
    # 소싱처 허용이 없으면 카드 줄은 후보가 아니다
    assert cheapest_quotes(rows, None, {DIRECT_CARD_PROVIDER}) == []


# --- 다나와 경유 스냅샷 ------------------------------------------------------


@respx.mock
def test_스냅샷_전에_다나와_링크를_받아_그_링크로_들어가고_정돈은_기준금액_규칙으로(hmall) -> None:
    calls: Calls = []
    mock_scripts(
        {
            'hmall_danawa_entry': {'ok': True, 'entry_url': ENTRY, 'slitmCd': '2240259019'},
            'hmall_product_snapshot': SNAP,
            'hmall_order_prep': PREP,
        },
        calls,
    )
    snap = hmall._snapshot(assignment(), 'buyer01')
    names = [n for n, _ in calls]
    assert names == ['hmall_danawa_entry', 'hmall_product_snapshot', 'hmall_order_prep']
    entry = calls[0][1]
    assert (entry['model'], entry['slitmCd'], entry['profile']) == ('HF5441-100', '2240259019', 'buyer01')
    s_args = calls[1][1]
    assert (s_args['route'], s_args['entry_url'], s_args['sku']) == ('danawa', ENTRY, '2240259019')
    assert calls[2][1] == {
        'profile': 'buyer01',
        'points': 'keep_card_discount',
        'card': '롯데카드',
        'tab': 'tab-h',
    }
    # 원가 비교는 결제액 + 사용 포인트
    assert (snap['cost'], snap['pay_amount'], snap['points_used']) == (80675, 50000, 30675)


@respx.mock
def test_다나와_링크를_못_받으면_직접_들어가지_않고_사람에게(hmall) -> None:
    calls: Calls = []
    mock_scripts(
        {'hmall_danawa_entry': {'ok': False, 'error': 'no_hmall_row', 'note': '현대H몰 판매처 없음'}}, calls
    )
    with pytest.raises(AgentFailure) as e:
        hmall._snapshot(assignment(), 'buyer01')
    assert e.value.status == 'needs_human' and 'no_hmall_row' in e.value.reason
    assert [n for n, _ in calls] == ['hmall_danawa_entry']  # 스냅샷(직접 진입)은 부르지 않는다


@respx.mock
def test_도착에_제휴가_없으면_수리_없이_사람에게(hmall) -> None:
    calls: Calls = []
    mock_scripts(
        {
            'hmall_danawa_entry': {'ok': True, 'entry_url': ENTRY},
            'hmall_product_snapshot': {'error': 'no_affiliate', 'note': 'ReferCode 없음', 'options': []},
        },
        calls,
    )
    with pytest.raises(AgentFailure) as e:
        hmall._snapshot(assignment(), 'buyer01')
    assert e.value.status == 'needs_human' and 'no_affiliate' in e.value.reason
    assert [n for n, _ in calls].count('hmall_product_snapshot') == 1  # 재시도·수리 없음


@respx.mock
def test_교차_비교가_받아_둔_이동_링크가_있으면_다시_찾지_않는다(hmall) -> None:
    calls: Calls = []
    mock_scripts({'hmall_product_snapshot': SNAP, 'hmall_order_prep': PREP}, calls)
    a = assignment()
    a = a.model_copy(update={'options': {'entry_url': ENTRY, 'model': 'HF5441-100'}})
    hmall._snapshot(a, 'buyer01')
    assert [n for n, _ in calls] == ['hmall_product_snapshot', 'hmall_order_prep']
    assert calls[0][1]['entry_url'] == ENTRY


@respx.mock
def test_결제수단_견적은_롯데카드만_묻고_카드_직접결제로_고른다(hmall) -> None:
    calls: Calls = []
    mock_scripts(
        {
            'hmall_payment_quotes': {
                'ok': True,
                'quotes': [
                    {'method': '카드', 'card': '롯데카드', 'cost': 47500, 'reward': 40, 'points_used': 30675},
                ],
                'base_cost': 50000,
            }
        },
        calls,
    )
    # 키마스터 목록: 재시작 전 라벨(hmall.com) — 계정을 못 찾으면 허용 수단(card)으로 견적한다
    # 견적 전에 주문서 탭을 앞에 둔다(키마스터 조회는 활성 탭 사이트 기준)
    respx.post(f'{URL}/tool/switch_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_accounts').mock(
        return_value=page(json.dumps([{'label': 'buyer01', 'payments': ['site', 'other', 'naver']}]))
    )
    snap = dict(SNAP, cost=80675, pay_amount=50000, points_used=30675)
    hmall._apply_payment_quotes(assignment(), 'buyer01', snap)
    args = calls[0][1]
    assert args['methods'] == ['카드'] and args['cards'] == ['롯데카드'] and args['tab'] == 'tab-h'
    assert (snap['pay_method'], snap['pay_card'], snap['pay_amount']) == ('카드', '롯데카드', 47500)
    assert snap['cost'] == round(47500 * 0.98 - 40 + 30675)


# --- SSG ↔ H몰 교차 ----------------------------------------------------------


class _FakeSibling(BuyerAgent):
    bought: list[Assignment]

    def __call__(self, assignment: Assignment) -> AgentResult:
        self.bought.append(assignment)
        return AgentResult(status='ok', reason='H몰 구매', payload={'buy_source': 'HMALL'})


def _ssg_with_sibling(reg: Registry, monkeypatch, hm_cost: float) -> tuple[BuyerAgent, _FakeSibling, Calls]:
    ssg = make_buyer(reg, 'buyer.ssg')
    spec = reg.cross_only_specs()[0]
    sib = _FakeSibling(spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), lambda p, m: None)  # type: ignore[arg-type,return-value]
    sib.bought = []
    ssg.sibling = sib
    seen: Calls = []

    def fake_find(self, a):
        seen.append(('find', {'lane': self.bridge._lane, 'sku': a.order.sku}))
        return {'found': True, 'product_url': ITEM, 'name': '[나이키] 덩크 로우 레트로 HF5441-100', 'model': 'HF5441-100', 'entry_url': ENTRY}

    def fake_pick(self, a, accounts):
        seen.append(('pick', {'options': dict(a.options), 'source': a.order.source}))
        return 'buyer01', {'cost': hm_cost}

    monkeypatch.setattr(BuyerAgent, '_find_same_product', fake_find)
    monkeypatch.setattr(BuyerAgent, '_pick_cheapest', fake_pick)
    monkeypatch.setattr(BuyerAgent, '_candidate_accounts', lambda self, a: ['buyer01'])
    monkeypatch.setattr(BuyerAgent, '_apply_payment_quotes', lambda self, a, acc, snap: None)
    respx.post(f'{URL}/tool/run_js').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    return ssg, sib, seen


@respx.mock
def test_H몰이_더_싸면_H몰로_산다_이동_링크를_넘긴다(reg, monkeypatch) -> None:
    ssg, sib, seen = _ssg_with_sibling(reg, monkeypatch, 77225)
    a = assignment(SSG_URL, source='SSG')
    out = ssg._cross_compare(a, 'buyer01', {'cost': 81000, 'selected': '285'})
    assert out is not None and out.payload['buy_source'] == 'HMALL'
    bought = sib.bought[0]
    assert bought.order.source == 'HMALL' and bought.order.account == 'buyer01'
    assert bought.options['entry_url'] == ENTRY and bought.options['model'] == 'HF5441-100'
    assert seen[0][1]['lane'] == 'hmall-cross'  # 찾기·견적은 H몰 레인에서


@respx.mock
def test_SSG_가_더_싸면_SSG_로_산다(reg, monkeypatch) -> None:
    ssg, sib, _seen = _ssg_with_sibling(reg, monkeypatch, 90000)
    out = ssg._cross_compare(assignment(SSG_URL, source='SSG'), 'buyer01', {'cost': 81000})
    assert out is None and sib.bought == []


@respx.mock
def test_SSG_봇_차단이면_H몰만_견적해_산다(reg, monkeypatch) -> None:
    ssg, sib, _seen = _ssg_with_sibling(reg, monkeypatch, 77225)
    blocked = blocked_failure({'error': 'blocked', 'note': 'PerimeterX'}, '상품 확인 buyer01')
    assert blocked is not None

    def snap_blocked(self, a, account):
        raise blocked

    monkeypatch.setattr(BuyerAgent, '_login_as', lambda self, account: None)
    monkeypatch.setattr(BuyerAgent, '_snapshot', snap_blocked)
    out = ssg(assignment(SSG_URL, source='SSG'))
    assert out.status == 'ok' and out.payload['buy_source'] == 'HMALL'
    assert sib.bought and sib.bought[0].order.source == 'HMALL'


@respx.mock
def test_SSG_봇_차단인데_H몰에도_없으면_원래대로_사람에게(reg, monkeypatch) -> None:
    ssg, sib, _seen = _ssg_with_sibling(reg, monkeypatch, 77225)
    monkeypatch.setattr(BuyerAgent, '_find_same_product', lambda self, a: None)
    blocked = blocked_failure({'error': 'blocked', 'note': 'PerimeterX'}, '상품 확인 buyer01')

    def snap_blocked(self, a, account):
        raise blocked

    monkeypatch.setattr(BuyerAgent, '_login_as', lambda self, account: None)
    monkeypatch.setattr(BuyerAgent, '_snapshot', snap_blocked)
    out = ssg(assignment(SSG_URL, source='SSG'))
    assert out.status == 'needs_human' and '봇 차단' in out.reason
    assert sib.bought == []


@respx.mock
def test_SSG_주문서를_못_열어_원가가_0이면_H몰로_산다(reg, monkeypatch, caplog) -> None:
    """실기 2026-09-27 job 258: SSG 스냅샷이 no_checkout(원가 0)인데 '0 < H몰 < 0' 이 거짓이라 SSG 로 갔다."""
    ssg, sib, _seen = _ssg_with_sibling(reg, monkeypatch, 77185)
    snap = {'error': 'no_checkout', 'note': 'order form not opened', 'cost': 0, 'options': ['285']}
    with caplog.at_level('INFO', logger='samba_agent.agents.buyer'):
        out = ssg._cross_compare(assignment(SSG_URL, source='SSG'), 'buyer01', snap)
    assert out is not None and out.payload['buy_source'] == 'HMALL'
    assert sib.bought and sib.bought[0].order.account == 'buyer01'
    notes = [e.detail for e in ssg.evidence if e.label == '교차 비교']
    assert any('견적 불가' in n and '77,185' in n for n in notes)
    assert any('HMALL 선택' in r.getMessage() for r in caplog.records)


@respx.mock
def test_SSG_원가_0_은_에러가_없어도_비교에서_지지_않는다(reg, monkeypatch) -> None:
    ssg, sib, _seen = _ssg_with_sibling(reg, monkeypatch, 77185)
    out = ssg._cross_compare(assignment(SSG_URL, source='SSG'), 'buyer01', {'cost': 0, 'selected': '285'})
    assert out is not None and sib.bought


@respx.mock
def test_SSG_에_중복_구매_흔적이면_H몰을_보지_않는다(reg, monkeypatch) -> None:
    ssg, sib, seen = _ssg_with_sibling(reg, monkeypatch, 77185)
    out = ssg._cross_compare(assignment(SSG_URL, source='SSG'), 'buyer01', {'cost': 81000, 'already_ordered': True})
    assert out is None and sib.bought == [] and seen == []


def _ssg_buy_fails(monkeypatch, failure: AgentFailure) -> None:
    monkeypatch.setattr(BuyerAgent, '_login_as', lambda self, account: None)
    monkeypatch.setattr(BuyerAgent, '_snapshot', lambda self, a, account: {'cost': 81000, 'selected': '285'})

    def buy_here(self, a, accounts, account, snap):
        raise failure

    monkeypatch.setattr(BuyerAgent, '_buy_here', buy_here)


@respx.mock
def test_SSG_가_싸도_배송지에서_막히면_H몰_견적으로_대체_구매(reg, monkeypatch) -> None:
    ssg, sib, _seen = _ssg_with_sibling(reg, monkeypatch, 84000)
    _ssg_buy_fails(monkeypatch, AgentFailure('needs_human', '배송지 입력 검증에 실패했다: no order form', FailReason.UNKNOWN))
    out = ssg(assignment(SSG_URL, source='SSG'))
    assert out.status == 'ok' and out.payload['buy_source'] == 'HMALL'
    bought = sib.bought[0]
    assert bought.order.source == 'HMALL' and bought.options['entry_url'] == ENTRY
    assert any('대체 구매' in e.detail for e in out.evidence)


@respx.mock
def test_SSG_중복_구매_실패는_H몰로_대체하지_않는다(reg, monkeypatch) -> None:
    ssg, sib, _seen = _ssg_with_sibling(reg, monkeypatch, 84000)
    _ssg_buy_fails(monkeypatch, AgentFailure('fail', '이미 구매한 흔적이 있다', FailReason.DUPLICATE))
    out = ssg(assignment(SSG_URL, source='SSG'))
    assert out.status == 'fail' and sib.bought == []


@respx.mock
def test_H몰_찾기는_SSG_를_열지_않게_모델코드·상품명을_넘긴다(reg, monkeypatch) -> None:
    row = default_sources().by_id('HMALL')
    monkeypatch.setattr(buyer_mod, 'source_of', lambda name: row)
    hm = make_buyer(reg)
    calls: Calls = []
    mock_scripts(
        {'hmall_find_product': {'found': True, 'product_url': ITEM, 'name': '덩크', 'model': 'HF5441-100', 'entry_url': ENTRY}},
        calls,
    )
    found = hm._find_same_product(assignment(SSG_URL, source='SSG'))
    assert found is not None and found['entry_url'] == ENTRY
    assert (calls[0][1]['model'], calls[0][1]['source_url']) == ('HF5441-100', SSG_URL)


# --- 결제: 카드 직접 결제는 사람 승인 대기 -------------------------------------


def payer(reg: Registry) -> PayerAgent:
    spec = reg['payer']

    def never(_p, _m):
        raise AssertionError('LLM 호출 금지')

    return PayerAgent(spec, BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0), never)


HANDOFF: dict[str, object] = {
    'card': '카드',
    'card_issuer': '롯데카드',
    'buy_source': 'HMALL',
    'account': 'buyer01',
    'cost': 77225,
    'paid': 47500,
    'order_tab': 'tab-h',
    'selected': '285',
    'product_no': '2240259019',
    'product_name': '[나이키] 덩크 로우 레트로 HF5441-100',
    'product_url': LANDED,
}


def pay_assignment(reg: Registry, dry: bool, digits: int = 0) -> Assignment:
    spec = reg['payer']
    order = OrderRef(order_no='O1', source='SSG', seller='쿠팡', sku='덩크 HF5441-100', qty=1, option='285')
    return Assignment(
        order=order,
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=dry,
        dry_run_digits=digits,
        handoff=dict(HANDOFF),
    )


def test_카드_직접결제_판정(reg) -> None:
    assert direct_card_of(pay_assignment(reg, True)) == '롯데카드'
    other = pay_assignment(reg, True).model_copy(update={'handoff': {**HANDOFF, 'card': '네이버페이'}})
    assert direct_card_of(other) is None


@respx.mock
def test_카드_직접결제_시험은_결제창_직전까지_키패드_시험_없음(reg) -> None:
    enter = respx.post(f'{URL}/tool/run_script').mock(
        return_value=page('{"ok": true, "dry": true, "method": "카드", "card": "롯데카드", "total": 47500}')
    )
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/switch_tab').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('주문서 [나이키] 덩크 로우 레트로 HF5441-100 285 | 1개'))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('dry-run ok'))
    out = payer(reg)(pay_assignment(reg, True, digits=3))
    assert out.status == 'ok' and out.payload['direct_card'] == '롯데카드' and out.payload['paid'] is False
    assert not fill.called
    args = json.loads(json.loads(enter.calls.last.request.content)['args']['args'])
    assert (args['card'], args['issuer'], args['dryRun'], args['amount'], args['tab']) == (
        '카드',
        '롯데카드',
        True,
        47500,
        'tab-h',
    )
    assert args['expect']['product_url'] == LANDED


@respx.mock
def test_카드_직접결제는_결제창을_누르지_않고_주문완료를_기다려_사람_결제로_기록한다(reg, monkeypatch) -> None:
    from samba_agent.agents import payer as payer_mod

    monkeypatch.setattr(payer_mod, 'DIRECT_CARD_WAIT_TRIES', 3)
    respx.post(f'{URL}/tool/run_script').mock(
        return_value=page('{"ok": true, "method": "카드", "card": "롯데카드", "popup_url": "https://kspay.ksnet.to/popmpi/veri_host.jsp", "pay_window": "card_mpi"}')
    )
    for t in ('progress', 'switch_tab', 'wait'):
        respx.post(f'{URL}/tool/{t}').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=page('[]'))
    pages = iter(
        [
            '주문서 [나이키] 덩크 로우 레트로 HF5441-100 285 | 1개',  # 결제 전 대조
            '주문서 [나이키] 덩크 로우 레트로 HF5441-100 285 | 1개',  # 이미 결제됐는지 확인
            '주문서 그대로',  # 대기 1
            '주문이 완료되었습니다 주문번호 20260927000123',  # 대기 2
            '주문이 완료되었습니다 주문번호 20260927000123',
        ]
    )
    respx.post(f'{URL}/tool/get_page').mock(side_effect=lambda r: page(next(pages)))
    fill = respx.post(f'{URL}/tool/fill_secret').mock(return_value=page('ok'))
    phone = respx.post(f'{URL}/tool/phone_approve_payment').mock(return_value=page('ok'))
    click = respx.post(f'{URL}/tool/click').mock(return_value=page('ok'))
    out = payer(reg)(pay_assignment(reg, False))
    assert out.status == 'ok', out.reason
    assert out.payload['paid_by'] == 'human' and out.payload['source_order_no'] == '20260927000123'
    assert not (fill.called or phone.called or click.called)  # 결제창에서 아무것도 누르지 않는다


@respx.mock
def test_카드_직접결제_승인이_안_보이면_재결제_없이_사람에게(reg, monkeypatch) -> None:
    from samba_agent.agents import payer as payer_mod

    monkeypatch.setattr(payer_mod, 'DIRECT_CARD_WAIT_TRIES', 2)
    respx.post(f'{URL}/tool/run_script').mock(return_value=page('{"ok": true, "method": "카드", "popup_url": null}'))
    for t in ('progress', 'switch_tab', 'wait'):
        respx.post(f'{URL}/tool/{t}').mock(return_value=page('ok'))
    respx.post(f'{URL}/tool/list_tabs').mock(return_value=page('[]'))
    respx.post(f'{URL}/tool/get_page').mock(return_value=page('주문서 [나이키] 덩크 로우 레트로 HF5441-100 285 | 1개'))
    out = payer(reg)(pay_assignment(reg, False))
    assert out.status == 'needs_human' and '재결제 금지' in out.reason
    assert out.fail_reason == FailReason.PAY_INTERRUPTED
