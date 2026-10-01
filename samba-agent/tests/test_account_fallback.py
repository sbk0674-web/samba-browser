"""계정 사유로 빠지면 남은 계정으로 잇는다(실기 2026-09-27 무신사 가방: buyer01 7일 구매 한도 → 다른 3계정 미시도)."""

import json

import httpx
import pytest
import respx

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import (
    SOLD_OUT_LISTED_SKIP,
    BuyerAgent,
    is_account_failure,
    sold_out_option_matches,
)
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT

URL = 'http://127.0.0.1:47811'
ACCOUNTS = ['buyer01', 'buyer02', 'buyer03', 'buyer05']
LIMIT = 'buyer01: 구매 수량 한도 초과(7일 최대 3개, 구매가능일 2026-10-03)'


def page(text: str) -> httpx.Response:
    return httpx.Response(200, json={'ok': True, 'result': text, 'steps': []})


@pytest.fixture()
def buyer(monkeypatch) -> BuyerAgent:
    reg = Registry.load(DEFAULT_ROOT)
    spec = reg['buyer.musinsa']
    agent = BuyerAgent(
        spec,
        BridgeClient(URL, 'a' * 64, allowed=spec.tools, busy_wait_s=0.0),
        lambda p, m: None,  # type: ignore[arg-type,return-value]
    )
    agent._dry_run = False
    agent.evidence = []
    agent._quote_errors = []
    cls = type(agent)
    monkeypatch.setattr(cls, '_payable_providers', lambda self, acc: None)
    monkeypatch.setattr(cls, '_allowed_providers', lambda self, acc=None: None)
    monkeypatch.setattr(cls, '_login_as', lambda self, acc: None)
    monkeypatch.setattr(cls, '_snapshot', lambda self, a, acc: {'account': acc, 'cost': 1.0, 'resnap': True})
    return agent


def assignment(buyer: BuyerAgent) -> Assignment:
    order = OrderRef(
        order_no='736141871267877',
        source='MUSINSA',
        seller='쿠팡',
        sku='가방',
        qty=1,
        option='BLACK FREE',
        product_url='https://www.musinsa.com/products/5837910',
        account='buyer05',
    )
    return Assignment(order=order, allowed_tools=buyer.spec.tools, rules='', dry_run=False)


def mock_quick(prices: dict[str, float]) -> None:
    """빠른 비교 스크립트 — 계정(profile)별 나의 할인가."""

    def handler(request: httpx.Request) -> httpx.Response:
        args = json.loads(json.loads(request.content)['args']['args'])
        return page(json.dumps({'my_price': prices[args['profile']], 'max_reward': 0}))

    respx.post(f'{URL}/tool/run_script').mock(side_effect=handler)
    respx.post(f'{URL}/tool/progress').mock(return_value=page('ok'))


def fake_quote(outcomes: dict[str, object], calls: list[str]):
    """계정별 견적 결과 — AgentFailure 면 실패 사유로 쌓고 None, 문자열이면 건너뜀 사유, dict 면 견적."""

    def quote(self: BuyerAgent, a: Assignment, account: str) -> dict[str, object] | None:
        calls.append(account)
        got = outcomes[account]
        if isinstance(got, AgentFailure):
            self._quote_errors.append(got)
            return None
        if isinstance(got, str):
            self._quote_skips.append(f'{account}: {got}')
            return None
        return got  # type: ignore[return-value]

    return quote


@respx.mock
def test_구매_한도에_걸린_계정은_빼고_다음으로_싼_계정으로_산다(buyer, monkeypatch) -> None:
    mock_quick({'buyer01': 44390, 'buyer02': 44390, 'buyer03': 44390, 'buyer05': 45550})
    calls: list[str] = []
    monkeypatch.setattr(
        BuyerAgent,
        '_quote',
        fake_quote(
            {
                'buyer01': AgentFailure('fail', LIMIT, FailReason.OUT_OF_STOCK),
                'buyer02': {'cost': 44390.0},
                'buyer03': {'cost': 44390.0},
                'buyer05': {'cost': 45550.0},
            },
            calls,
        ),
    )
    account, snap = buyer._pick_cheapest(assignment(buyer), ACCOUNTS)
    assert account == 'buyer02'  # 한도 계정 다음으로 싼 계정(동률이면 앞 계정)
    # 빠른 비교가 비슷한(3% 안) 계정은 모두 주문서로 견적한다 — 빠른 값은 결제수단 적립·청구할인을 모른다
    assert calls == ACCOUNTS
    # 이긴 계정이 마지막으로 연 계정이 아니라 주문서를 다시 만든다
    assert snap.get('resnap') is True


@respx.mock
def test_로그인_안_된_계정도_계정_사유라_다음_계정으로_잇는다(buyer, monkeypatch) -> None:
    mock_quick({'buyer01': 40000, 'buyer02': 41000, 'buyer03': 42000, 'buyer05': 43000})
    calls: list[str] = []
    monkeypatch.setattr(
        BuyerAgent,
        '_quote',
        fake_quote(
            {
                'buyer01': AgentFailure('fail', LIMIT, FailReason.OUT_OF_STOCK),
                'buyer02': AgentFailure(
                    'needs_human', 'buyer02: 로그인이 안 돼 있어 견적 못 함', FailReason.PERMISSION_DENIED
                ),
                'buyer03': '결제 가능한 수단 없음',
                'buyer05': {'cost': 43000.0},
            },
            calls,
        ),
    )
    account, _ = buyer._pick_cheapest(assignment(buyer), ACCOUNTS)
    assert account == 'buyer05'
    assert calls == ACCOUNTS


@respx.mock
def test_상품_사유면_다른_계정을_돌지_않는다(buyer, monkeypatch) -> None:
    """품절은 계정과 무관하다 — 다음 계정으로 잇지 않는다."""
    mock_quick({'buyer01': 40000, 'buyer02': 42000, 'buyer03': 44000, 'buyer05': 46000})
    calls: list[str] = []
    monkeypatch.setattr(
        BuyerAgent,
        '_quote',
        fake_quote({'buyer01': f"{SOLD_OUT_LISTED_SKIP} ['FREE 품절'] (선택지 1개)"}, calls),
    )
    with pytest.raises(AgentFailure) as e:
        buyer._pick_cheapest(assignment(buyer), ACCOUNTS)
    assert calls == ['buyer01']
    assert e.value.reason.startswith('확정 품절')


@respx.mock
def test_모든_계정이_한도면_시도한_계정을_모두_남긴다(buyer, monkeypatch) -> None:
    mock_quick({acc: 40000 for acc in ACCOUNTS})
    calls: list[str] = []
    monkeypatch.setattr(
        BuyerAgent,
        '_quote',
        fake_quote(
            {acc: AgentFailure('fail', f'{acc}: 구매 수량 한도 초과', FailReason.OUT_OF_STOCK) for acc in ACCOUNTS},
            calls,
        ),
    )
    with pytest.raises(AgentFailure) as e:
        buyer._pick_cheapest(assignment(buyer), ACCOUNTS)
    assert calls == ACCOUNTS
    assert all(acc in e.value.reason for acc in ACCOUNTS)
    assert not e.value.reason.startswith('확정 품절')


@respx.mock
def test_한도_계정_말고_나머지가_품절_표시면_확정_품절이다(buyer, monkeypatch) -> None:
    mock_quick({'buyer01': 40000, 'buyer02': 41000, 'buyer03': 42000, 'buyer05': 43000})
    calls: list[str] = []
    monkeypatch.setattr(
        BuyerAgent,
        '_quote',
        fake_quote(
            {
                'buyer01': AgentFailure('fail', LIMIT, FailReason.OUT_OF_STOCK),
                'buyer02': f"{SOLD_OUT_LISTED_SKIP} ['FREE 품절'] (선택지 1개)",
            },
            calls,
        ),
    )
    with pytest.raises(AgentFailure) as e:
        buyer._pick_cheapest(assignment(buyer), ACCOUNTS)
    assert calls == ['buyer01', 'buyer02']
    assert e.value.reason.startswith('확정 품절')


@respx.mock
def test_결제_항목_없는_계정이_뽑히면_다음_계정으로_잇는다(buyer, monkeypatch) -> None:
    mock_quick({'buyer01': 40000, 'buyer02': 41000, 'buyer03': 42000, 'buyer05': 43000})
    calls: list[str] = []
    monkeypatch.setattr(
        BuyerAgent,
        '_quote',
        fake_quote({'buyer01': {'cost': 40000.0}, 'buyer02': {'cost': 41000.0}}, calls),
    )
    monkeypatch.setattr(
        BuyerAgent, '_payable_providers', lambda self, acc: set() if acc == 'buyer01' else None
    )
    account, _ = buyer._pick_cheapest(assignment(buyer), ACCOUNTS)
    assert account == 'buyer02'
    assert calls == ['buyer01', 'buyer02']


def test_계정_사유_판정() -> None:
    assert is_account_failure(AgentFailure('fail', LIMIT, FailReason.OUT_OF_STOCK))
    assert is_account_failure(AgentFailure('needs_human', '로그인 실패(x)', FailReason.PERMISSION_DENIED))
    assert not is_account_failure(AgentFailure('fail', '원가 못 읽음', FailReason.OUT_OF_STOCK))
    assert not is_account_failure(AgentFailure('needs_human', '캡차', FailReason.CAPTCHA))


def test_품절_표시_항목은_목록_뒤쪽에_있어도_그대로_보인다() -> None:
    """실기 2026-09-27 그랜드스테이지 260 — 사유에 앞 6개만 남겨 '품절 표시가 없다'로 보였다."""
    options = ['240', '245', '250', '255', '265', '270', '260 품절', '275 품절', '280 품절']
    assert sold_out_option_matches(options, '260') == ['260 품절']
    # 목록에 아예 없는 옵션은 품절 확증이 아니다
    assert sold_out_option_matches(['240', '250 품절'], '260') == []
