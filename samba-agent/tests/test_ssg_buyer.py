"""SSG 구매 — 신세계몰 같은 상품 찾기·진입 경로(직접·애드픽) 비교·애드픽 적립·봇 차단(respx 목)."""

import json

import httpx
import pytest
import respx

from samba_agent.agents import buyer as buyer_mod
from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import BuyerAgent, model_code_of
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.sources import default_sources

URL = 'http://127.0.0.1:47811'
EMART = 'https://emart.ssg.com/item/itemView.ssg?itemId=1000000000111&siteNo=6001'
MALL_A = 'https://shinsegaemall.ssg.com/item/itemView.ssg?itemId=1000000000222&siteNo=6004'
MALL_B = 'https://shinsegaemall.ssg.com/item/itemView.ssg?itemId=1000000000333&siteNo=6004'
ADPICK = 'https://adpick.example/track/abc'
ADPICK_ROUTE = {
    'route': 'adpick',
    'entry_url': ADPICK,
    'mall_ok': True,
    'same_item': True,
    'sold_out': False,
    'percent': 1.6,
}

Calls = list[tuple[str, dict[str, object]]]


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@pytest.fixture()
def ssg(monkeypatch) -> BuyerAgent:
    """SSG 행(sources.yaml)을 쓰는 구매 에이전트. SSG 는 hold 라 등록부에 없어 무신사 스펙에 SSG 행을 물린다."""
    row = default_sources().by_id('SSG')
    assert row is not None
    monkeypatch.setattr(buyer_mod, 'source_of', lambda name: row)
    spec = Registry.load(DEFAULT_ROOT)['buyer.musinsa']
    agent = BuyerAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: None,  # type: ignore[arg-type,return-value]
    )
    agent._dry_run = False
    agent.evidence = []
    agent._quote_errors = []
    return agent


def with_routes(monkeypatch, *routes: str) -> None:
    """SSG 행의 비교 경로를 바꾼다(기본은 애드픽 하나)."""
    row = default_sources().by_id('SSG')
    assert row is not None
    changed = row.model_copy(update={'routes': list(routes)})
    monkeypatch.setattr(buyer_mod, 'source_of', lambda name: changed)


def assignment(url: str, option: str = '270') -> Assignment:
    order = OrderRef(
        order_no='O1',
        source='SSG',
        seller='쿠팡',
        sku='나이키 에어포스1 HF5441-100',
        option=option,
        product_url=url,
    )
    return Assignment(
        order=order, allowed_tools=('run_script', 'progress'), rules='', dry_run=False
    )


def snap_of(url: str, *, options: list[str], cost: int, **kw: object) -> dict[str, object]:
    """스냅샷 계약(2026-09-27): cost = pay_amount = 결제액, 애드픽은 adpick_rate(%)·adpick_reward(원)."""
    item = url.split('itemId=')[1].split('&')[0]
    ok = '270' in options
    return {
        'options': options,
        'selected': '270' if ok else None,
        'cost': cost if ok else None,
        'pay_amount': cost if ok else None,
        'methods': ['SSGPAY', 'SSG MONEY'],
        'product_url': url,
        'product_no': item,
        'product_name': f'페이지 상품명 {item}',
        'order_tab': f'tab-{item}' if ok else None,
        'mall_ok': True,
        **kw,
    }


def mock_scripts(responses: dict[str, object], calls: Calls) -> None:
    """run_script 이름별 응답. 값이 함수면 인자로 부른다. 부른 (이름, 인자)를 calls 에 쌓는다."""

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
    # 바로구매 전 장바구니 미리 열기(_warm_ssg_cart) — 다른 run_js 목(탭 정리 등)이 없을 때만 받는다
    if 'run_js' not in respx.routes:
        respx.post(f'{URL}/tool/run_js', name='run_js').mock(return_value=page('ok'))


def snapshots(calls: Calls) -> list[dict[str, object]]:
    return [args for name, args in calls if name == 'ssg_product_snapshot']


def test_모델코드는_상품명에서_읽는다() -> None:
    assert model_code_of('나이키 에어포스1 HF5441-100') == 'HF5441-100'
    assert model_code_of('나이키HF5441 100 블랙') == 'HF5441-100'  # 한글에 붙어 있어도
    assert model_code_of('버킷햇 YUA24B06') == 'YUA24B06'
    assert model_code_of('그냥 모자') == ''


@respx.mock
def test_신세계몰이_아니면_같은_모델_후보를_싼_순서로_보고_옵션_맞는_후보로_산다(ssg) -> None:
    calls: Calls = []

    def snapshot(args: dict[str, object]) -> dict[str, object]:
        url = str(args.get('entry_url') or args['sku'])
        if url == MALL_A:
            return snap_of(MALL_A, options=['260', '280'], cost=0)  # 이 후보엔 270 이 없다
        if url == ADPICK:
            return snap_of(
                MALL_B, options=['270', '275'], cost=95000, adpick_rate=1.6, adpick_reward=1520
            )
        return snap_of(MALL_B, options=['270', '275'], cost=95000)

    mock_scripts(
        {
            'ssg_find_mall_item': {
                'ok': True,
                'items': [
                    {'item_id': '1000000000333', 'url': MALL_B, 'name': '나이키 HF5441-100 B', 'price': 99000},
                    {'item_id': '1000000000222', 'url': MALL_A, 'name': '나이키 HF5441-100 A', 'price': 90000},
                ],
            },
            'ssg_product_snapshot': snapshot,
            'ssg_route_quotes': {'ok': True, 'routes': [ADPICK_ROUTE]},
        },
        calls,
    )
    snap = ssg._snapshot(assignment(EMART), 'acc1')
    # 원래 링크(이마트몰)는 스냅샷하지 않고, 모델코드로 신세계몰을 찾는다
    assert calls[0] == ('ssg_find_mall_item', {'model': 'HF5441-100', 'profile': 'acc1'})
    shots = snapshots(calls)
    # 싼 후보(A) 먼저 — 270 이 없어 다음 후보(B), 그다음 애드픽 경로. 애드픽이 이겼고 마지막으로 연 경로라 다시 안 들어간다
    assert [s['sku'] for s in shots] == [MALL_A, MALL_B, MALL_B]
    assert [s.get('route') for s in shots] == ['direct', 'direct', 'adpick']
    assert shots[2]['entry_url'] == ADPICK and shots[2]['adpick_percent'] == 1.6
    assert all(s['allow_department'] is True for s in shots)  # 사용자 2026-09-27: 신세계백화점 허용
    # 상품번호·상품명은 고른 후보 값
    assert snap['product_no'] == '1000000000333'
    assert snap['product_name'] == '나이키 HF5441-100 B'
    # 애드픽 적립은 원가에 넣지 않는다(사용자 2026-09-27) — 적립 예정액만 남긴다
    assert snap['route'] == 'adpick'
    assert (snap['cost'], snap['adpick_reward']) == (95000, 1520)
    # 옵션이 없는 후보에 AI 수리를 돌리지 않았다(수리는 다른 이름의 도구 호출을 남긴다)
    assert {n for n, _ in calls} == {'ssg_find_mall_item', 'ssg_product_snapshot', 'ssg_route_quotes'}


@respx.mock
def test_기본은_애드픽_경로_스냅샷_하나로_산다(ssg) -> None:
    """SSG 는 상품 페이지를 네 번쯤 열면 봇 차단 — 주문서 금액은 경로와 무관하니 애드픽 하나만 연다(2026-09-27)."""
    calls: Calls = []
    mock_scripts(
        {
            'ssg_product_snapshot': lambda args: snap_of(
                MALL_B, options=['270'], cost=95000, adpick_rate=1.6, adpick_reward=1520
            ),
            'ssg_route_quotes': {'ok': True, 'routes': [ADPICK_ROUTE]},
        },
        calls,
    )
    snap = ssg._snapshot(assignment(MALL_B), 'acc1')
    assert [n for n, _ in calls] == ['ssg_route_quotes', 'ssg_product_snapshot']
    route_args = calls[0][1]
    assert route_args['routes'] == ['adpick'] and route_args['allow_department'] is True
    shot = snapshots(calls)[0]
    assert (shot['route'], shot['entry_url'], shot['adpick_percent']) == ('adpick', ADPICK, 1.6)
    assert snap['route'] == 'adpick'
    assert (snap['cost'], snap['pay_amount'], snap['adpick_reward']) == (95000, 95000, 1520)


@respx.mock
def test_애드픽이_더_비싸면_직접_경로로_다시_들어가_그_주문서를_남긴다(ssg, monkeypatch) -> None:
    with_routes(monkeypatch, 'direct', 'adpick')  # 직접까지 비교하도록 켠 경우
    calls: Calls = []

    def snapshot(args: dict[str, object]) -> dict[str, object]:
        if args.get('entry_url') == ADPICK:
            # 애드픽 경로는 쿠폰이 빠져 결제액이 크다 — 적립을 빼도 직접보다 비싸다
            return snap_of(MALL_B, options=['270'], cost=97000, adpick_rate=1.6, adpick_reward=1552)
        return snap_of(MALL_B, options=['270'], cost=95000)

    mock_scripts(
        {
            'ssg_product_snapshot': snapshot,
            'ssg_route_quotes': {'ok': True, 'routes': [ADPICK_ROUTE]},
        },
        calls,
    )
    snap = ssg._snapshot(assignment(MALL_B), 'acc1')
    assert 'ssg_find_mall_item' not in [n for n, _ in calls]  # 신세계몰 링크는 찾지 않는다
    route_args = next(a for n, a in calls if n == 'ssg_route_quotes')
    assert route_args['routes'] == ['adpick']
    # 직접 → 애드픽 → (직접이 이겨) 직접으로 다시 진입해 경로 쿠키를 되돌린다
    assert [s.get('route') for s in snapshots(calls)] == ['direct', 'adpick', 'direct']
    assert snap['route'] == 'direct'
    assert snap['cost'] == 95000 and not snap.get('adpick_reward')


@respx.mock
def test_애드픽과_같은_금액이면_직접_경로다(ssg, monkeypatch) -> None:
    with_routes(monkeypatch, 'direct', 'adpick')
    calls: Calls = []

    def snapshot(args: dict[str, object]) -> dict[str, object]:
        if args.get('entry_url') == ADPICK:
            return snap_of(MALL_B, options=['270'], cost=96520, adpick_rate=1.6, adpick_reward=1520)
        return snap_of(MALL_B, options=['270'], cost=95000)

    mock_scripts(
        {'ssg_product_snapshot': snapshot, 'ssg_route_quotes': {'ok': True, 'routes': [ADPICK_ROUTE]}},
        calls,
    )
    assert ssg._snapshot(assignment(MALL_B), 'acc1')['route'] == 'direct'


@respx.mock
def test_쓸_수_있는_경로가_없으면_직접_경로로_산다(ssg) -> None:
    calls: Calls = []
    mock_scripts(
        {
            'ssg_product_snapshot': lambda args: snap_of(MALL_B, options=['270'], cost=95000),
            'ssg_route_quotes': {
                'ok': False,
                'routes': [
                    {'route': 'adpick', 'entry_url': None, 'note': '애드픽 링크 없음'},
                    # 요청하지 않은 경로는 쓰지 않는다
                    {'route': 'danawa', 'entry_url': 'https://danawa.example', 'mall_ok': True},
                ],
            },
        },
        calls,
    )
    snap = ssg._snapshot(assignment(MALL_B), 'acc1')
    assert [s.get('route') for s in snapshots(calls)] == ['direct']
    assert snap['route'] == 'direct' and snap['cost'] == 95000


@respx.mock
def test_애드픽_주문서에_주문_옵션이_없으면_직접_경로로_또_열지_않는다(ssg) -> None:
    calls: Calls = []
    mock_scripts(
        {
            'ssg_product_snapshot': lambda args: snap_of(MALL_B, options=['260', '270 품절'], cost=0),
            'ssg_route_quotes': {'ok': True, 'routes': [ADPICK_ROUTE]},
        },
        calls,
    )
    snap = ssg._snapshot(assignment(MALL_B), 'acc1')
    assert len(snapshots(calls)) == 1  # 품절은 경로와 무관 — 페이지를 더 열지 않고 호출부가 품절로 판단한다
    assert '270 품절' in snap['options']  # type: ignore[operator]


@respx.mock
def test_신세계몰_링크인데_스크립트가_신세계몰_아님으로_멈추면_같은_모델을_찾는다(ssg) -> None:
    calls: Calls = []

    def snapshot(args: dict[str, object]) -> dict[str, object]:
        if args['sku'] == MALL_A:
            return {'error': 'not_shinsegaemall', 'note': '이마트몰로 이동', 'options': []}
        return snap_of(MALL_B, options=['270'], cost=95000)

    mock_scripts(
        {
            'ssg_product_snapshot': snapshot,
            'ssg_find_mall_item': {
                'ok': True,
                'items': [{'item_id': '1000000000333', 'url': MALL_B, 'name': 'B', 'price': 99000}],
            },
            'ssg_route_quotes': {'ok': False, 'routes': []},
        },
        calls,
    )
    snap = ssg._snapshot(assignment(MALL_A), 'acc1')
    assert [n for n, _ in calls][:3] == ['ssg_route_quotes', 'ssg_product_snapshot', 'ssg_find_mall_item']
    assert snap['product_no'] == '1000000000333'
    assert snap['route'] == 'direct'  # 후보 시험 주문서(직접)로 산다 — 애드픽 경로를 못 받았다


@respx.mock
def test_모델코드가_없거나_후보가_모두_안_맞으면_사람에게(ssg) -> None:
    calls: Calls = []
    mock_scripts(
        {
            'ssg_find_mall_item': {
                'ok': True,
                'items': [{'item_id': '1000000000222', 'url': MALL_A, 'name': 'A', 'price': 90000}],
            },
            'ssg_product_snapshot': lambda args: snap_of(MALL_A, options=['260'], cost=0),
        },
        calls,
    )
    a = assignment(EMART)
    no_model = a.model_copy(update={'order': a.order.model_copy(update={'sku': '그냥 운동화'})})
    with pytest.raises(AgentFailure) as e:
        ssg._snapshot(no_model, 'acc1')
    assert e.value.status == 'needs_human' and '모델코드' in e.value.reason
    with pytest.raises(AgentFailure) as e:
        ssg._snapshot(a, 'acc1')
    assert e.value.status == 'needs_human' and '맞는 상품이 없다' in e.value.reason


@respx.mock
def test_봇_차단이면_수리_재시도_없이_사람에게(ssg) -> None:
    calls: Calls = []
    mock_scripts({'ssg_route_quotes': {'error': 'blocked', 'note': 'PerimeterX'}}, calls)
    with pytest.raises(AgentFailure) as e:
        ssg._snapshot(assignment(MALL_B), 'acc1')
    assert (e.value.status, e.value.fail_reason) == ('needs_human', FailReason.CAPTCHA)
    assert [n for n, _ in calls] == ['ssg_route_quotes']  # 한 번만 — 수리·직접 경로 없음


@respx.mock
def test_애드픽_경로에서_봇_차단이면_직접_경로로_넘어가지_않고_멈춘다(ssg) -> None:
    calls: Calls = []
    mock_scripts(
        {
            'ssg_product_snapshot': {'error': 'blocked', 'note': 'PerimeterX'},
            'ssg_route_quotes': {'ok': True, 'routes': [ADPICK_ROUTE]},
        },
        calls,
    )
    with pytest.raises(AgentFailure) as e:
        ssg._snapshot(assignment(MALL_B), 'acc1')
    assert e.value.fail_reason is FailReason.CAPTCHA
    assert [n for n, _ in calls] == ['ssg_route_quotes', 'ssg_product_snapshot']


@respx.mock
def test_애드픽_경로_적립은_결제수단_견적_원가에_넣지_않는다(ssg, monkeypatch) -> None:
    calls: Calls = []
    mock_scripts(
        {
            'ssg_payment_quotes': {
                'quotes': [
                    {'method': 'SSGPAY', 'card': '현대카드', 'cost': 100000, 'reward': 0,
                     'registered': True, 'allowed': True, 'available': True},
                    {'method': 'SSGPAY', 'card': '삼성카드', 'cost': 100000, 'reward': 0,
                     'registered': True, 'allowed': False, 'available': False},
                ],
                'base_cost': 100000,
            }
        },
        calls,
    )
    monkeypatch.setattr(BuyerAgent, '_payable_providers', lambda self, acc: {'site'})
    monkeypatch.setattr(BuyerAgent, '_allowed_providers', lambda self, acc=None: None)
    snap: dict[str, object] = {
        'route': 'adpick',
        'adpick_rate': 1.6,
        'adpick_reward': 1600,
        'cost': 100000,
        'reward': 0,
        'pay_amount': 100000,
        'methods': ['SSGPAY', 'SSG MONEY'],
    }
    ssg._apply_payment_quotes(assignment(MALL_B), 'acc1', snap)
    # 원가 = 100,000 × 0.973(현대 청구할인) — 애드픽 적립은 원가 밖(사용자 2026-09-27)
    assert (snap['pay_method'], snap['pay_card']) == ('SSGPAY', '현대카드')
    assert (snap['cost'], snap['reward'], snap['pay_amount']) == (97300, 0, 100000)


def test_애드픽_적립_계산() -> None:
    assert BuyerAgent._adpick_for({'adpick_rate': 1.6}, 50000) == 800
    assert BuyerAgent._adpick_for({'adpick_reward': 700}, 50000) == 700
    assert BuyerAgent._adpick_for({}, 50000) == 0


@respx.mock
def test_www_ssg_주문_링크가_차단이면_신세계몰에서_같은_모델을_찾는다(ssg) -> None:
    """실기 2026-10-01: edelvise06 프로필은 www.ssg.com 만 차단 화면이고 신세계몰 도메인은 열렸다."""
    calls: Calls = []
    www = 'https://www.ssg.com/item/itemView.ssg?itemId=1000000000999'

    def snapshot(args: dict[str, object]) -> dict[str, object]:
        if args['sku'] == www:
            return {'error': 'blocked', 'note': 'SSG 봇 차단 화면'}
        return snap_of(MALL_B, options=['270'], cost=95000)

    mock_scripts(
        {
            'ssg_product_snapshot': snapshot,
            'ssg_route_quotes': lambda args: (
                {'error': 'blocked', 'note': 'SSG 봇 차단 화면'} if args.get('sku') == www else {'ok': False, 'routes': []}
            ),
            'ssg_find_mall_item': {
                'ok': True,
                'items': [{'item_id': '1000000000333', 'url': MALL_B, 'name': 'B', 'price': 99000}],
            },
        },
        calls,
    )
    snap = ssg._snapshot(assignment(www), 'acc1')
    assert 'ssg_find_mall_item' in [n for n, _ in calls]
    assert snap['product_no'] == '1000000000333'


def test_선물_결제_전_로그인이_풀려_있으면_다시_로그인하고_한_번_더_본다() -> None:
    """실기 2026-10-01: 선물 주문서를 만든 뒤 pay.ssg.com 세션이 풀려 결제 전 확인에서 멈췄다."""
    agent = BuyerAgent.__new__(BuyerAgent)
    agent.note = lambda *_: None
    agent._fetch_shipping = lambda a, snap: {'name': '고객', 'address': '서울 강남구 테헤란로 1'}
    agent._close_order_tabs = lambda account: None
    logins: list[str] = []
    agent._login_as = lambda account: logins.append(account)
    answers = iter(
        [
            {'ok': True},  # 선물 진입
            {'ok': True, 'gift': True, 'order_tab': 'T1', 'amount': 30000},  # 받는 분 지정
            {'logged_in': False},  # 결제 전 확인 — 풀림
            {'logged_in': True},  # 다시 로그인한 뒤
        ]
    )
    agent.json_tool = lambda *_, **__: next(answers)
    snap: dict[str, object] = {'product_url': MALL_B, 'selected': '270', 'cost': 30000}
    agent._ssg_gift(assignment(MALL_B), snap, 'acc1')
    assert logins == ['acc1']
    assert snap['order_tab'] == 'T1'
