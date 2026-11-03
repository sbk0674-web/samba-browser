import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import cheapest_quotes, effective_cost
from samba_agent.agents.payer import FailReason
from samba_agent.agents.naverpay import NAVER_PREPARE_JS, parse_receipt
from samba_agent.agents.payer import PayerAgent
from samba_agent.agents.source_detail import actual_cost, with_pay_card


def test_generic_naver_name_never_proves_hyundai_discount():
    assert effective_cost({'cost': 59250, 'card': '네이버페이', 'reward': 295}) == 58955
    assert (
        effective_cost({'cost': 59250, 'card': '네이버페이 머니 충전결제', 'reward': 1479}) == 57771
    )


def test_quote_explicitly_targets_hyundai_card():
    rows = cheapest_quotes([{'method': '네이버페이', 'cost': 59250}], None, {'naver'})
    assert rows[0]['card'] == '현대카드'
    assert rows[0]['cost'] == 57058


def receipt():
    return (
        '결제 상세정보 결제번호20261029NP1811383268 결제완료 '
        '결제 확인 번호: 2026102915869504 수량 1개 상품가격 59,250원 '
        '결제정보 결제금액 총 59,250원 상품금액 59,250원 네이버페이 머니 사용 59,250원 '
        '포인트 혜택 최대 1,184원 구매적립 안내 보기 총 1,184원 기본적립 592원 머니 결제적립 592원'
    )


def test_actual_money_receipt_matches_merchant_order_and_rewards():
    result = parse_receipt(receipt(), '2026102915869504')
    assert result['payment_kind'] == 'money'
    assert result['paid'] == 59250
    assert result['naver_reward'] == 1184
    assert result['source_order_no'] == '2026102915869504'
    result.update(reward=295, points_used=0)
    assert actual_cost(result) == 57771


def test_actual_card_receipt_includes_naver_and_site_rewards():
    text = receipt().replace(
        '네이버페이 머니 사용 59,250원', '카드 간편결제 59,250원 현대 5165 **** **** **** 일시불'
    )
    text = text.replace('총 1,184원 기본적립 592원 머니 결제적립 592원', '총 592원 기본적립 592원')
    result = parse_receipt(text, '2026102915869504')
    result.update(reward=295, points_used=0)
    assert result['payment_kind'] == 'card'
    assert actual_cost(result) == 56763


def test_card_discount_excludes_redeemed_naver_points():
    text = receipt().replace(
        '네이버페이 머니 사용 59,250원',
        '카드 간편결제 58,000원 현대 5165 **** **** **** 일시불 네이버페이 포인트 사용 1,250원',
    )
    text = text.replace('총 1,184원 기본적립 592원 머니 결제적립 592원', '총 580원 기본적립 580원')
    result = parse_receipt(text, '2026102915869504')
    result.update(reward=295, points_used=0)
    assert result['card_paid'] == 58000
    assert result['naver_points_used'] == 1250
    assert actual_cost(result) == 56809


def test_money_one_percent_is_read_not_assumed_two_percent():
    text = receipt().replace(
        '총 1,184원 기본적립 592원 머니 결제적립 592원', '총 592원 머니 결제적립 592원'
    )
    assert parse_receipt(text, '2026102915869504')['naver_reward'] == 592


def test_receipt_mismatch_or_unexplained_rewards_are_blocked():
    with pytest.raises(ValueError):
        parse_receipt(receipt(), 'another-order')
    with pytest.raises(ValueError):
        parse_receipt(
            receipt().replace('총 1,184원 기본적립', '총 2,184원 기본적립'), '2026102915869504'
        )


def test_target_card_never_overwrites_actual_money_payment():
    detail = {
        'paid': 59250,
        'card': '네이버페이 머니',
        'payment_kind': 'money',
        'reward': 295,
        'naver_reward': 1184,
    }
    merged = with_pay_card(detail, {'card_issuer': '현대카드'})
    assert actual_cost(merged) == 57771


def test_generic_naver_detail_cannot_inherit_unverified_target_card():
    result = with_pay_card({'paid': 50000, 'card': '네이버페이'}, {'card_issuer': '현대카드'})
    assert result.get('card') != '현대카드'


def test_naver_rewards_survive_detail_showing_only_issuer():
    detail = {'paid': 59250, 'card': '현대카드', 'reward': 295}
    handoff = {
        'card': '네이버페이',
        'naver_payment': {
            'payment_verified': True,
            'payment_kind': 'card',
            'card_issuer': '현대카드',
            'naver_reward': 592,
        },
    }
    assert actual_cost(with_pay_card(detail, handoff)) == 56763


@pytest.mark.parametrize('verified', [False, True])
def test_payer_only_clicks_agreement_after_verified_hyundai(verified):
    payer = object.__new__(PayerAgent)
    payer._list_tabs_popups = lambda: ([], None)
    calls = []
    prepared = {
        'ok': verified,
        'agree': 7,
        'card_issuer': '현대카드',
        'payment_kind': 'card',
        'naver_reward': 592,
        'payment_verified': verified,
    }

    def tool(name, **kwargs):
        calls.append(name)
        return json.dumps(prepared) if name == 'run_js' else 'ok'

    payer.tool = tool
    payer.note = lambda *args: None
    assignment = SimpleNamespace(handoff={'paid': 59250})
    if verified:
        payer._prepare_naver_card(assignment)
        assert calls == ['run_js', 'click', 'wait']
        assert payer._naver_payment['naver_reward'] == 592
    else:
        with pytest.raises(AgentFailure):
            payer._prepare_naver_card(assignment)
        assert calls == ['run_js']


def _naver_payer(reads, keypad_out):
    payer = object.__new__(PayerAgent)
    payer._list_tabs_popups = lambda: ([], None)
    keypad = []
    payer._press_keypad = lambda a, provider, account: keypad.append((provider, account)) or keypad_out
    payer.tool = lambda name, **kwargs: json.dumps(reads.pop(0)) if name == 'run_js' else 'ok'
    payer.note = lambda *args: None
    payer.step = lambda *args: None
    return payer, keypad


NAVER_AUTH = {'ok': False, 'auth_required': True, 'error': '추가 비밀번호'}
NAVER_READY = {
    'ok': True, 'agree': 7, 'card_issuer': '현대카드', 'payment_kind': 'card',
    'naver_reward': 592, 'payment_verified': True,
}
NAVER_ASSIGNMENT = SimpleNamespace(handoff={'paid': 59250, 'account': 'edelvise06'}, order=SimpleNamespace(account=''))


def test_naver_password_screen_is_filled_once_then_card_is_rechecked():
    payer, keypad = _naver_payer([NAVER_AUTH, NAVER_READY], 'filled')
    payer._prepare_naver_card(NAVER_ASSIGNMENT)
    assert keypad == [('naver', 'edelvise06')]
    assert payer._naver_payment['card_issuer'] == '현대카드'


def test_naver_password_refused_stops_without_second_entry():
    payer, keypad = _naver_payer([NAVER_AUTH, NAVER_READY], 'handoff: 사람에게 넘김')
    with pytest.raises(AgentFailure) as e:
        payer._prepare_naver_card(NAVER_ASSIGNMENT)
    assert len(keypad) == 1
    assert e.value.fail_reason == FailReason.PERMISSION_DENIED


def test_naver_password_that_finishes_payment_goes_to_confirmation():
    payer, keypad = _naver_payer([NAVER_AUTH, {'ok': False, 'error': '네이버페이 결제창 미확인'}], 'filled')
    payer._last_listed = json.dumps([{'id': 't1', 'url': 'https://www.lotteon.com/p/order/complete/2026110317437818', 'active': True}])
    assert payer._prepare_naver_card(NAVER_ASSIGNMENT) is True
    assert len(keypad) == 1


def test_naver_password_then_unknown_screen_never_claims_unpaid():
    payer, keypad = _naver_payer([NAVER_AUTH, {'ok': False, 'error': '네이버페이 결제창 미확인'}], 'filled')
    with pytest.raises(AgentFailure) as e:
        payer._prepare_naver_card(NAVER_ASSIGNMENT)
    assert len(keypad) == 1
    assert e.value.fail_reason == FailReason.PAY_INTERRUPTED
    assert '재결제 금지' in e.value.reason


@pytest.mark.parametrize(
    'selectable,amount,ok', [(True, 59250, True), (False, 59250, False), (True, 60000, False)]
)
def test_browser_selection_guard_never_agrees_or_uses_money(selectable, amount, ok):
    harness = r"""
let selected=false;const clicks=[];
const page={get:async options=>({tree:options&&options.selector?(selected?'[1] radio "현대카드" value="on"':'[1] radio "머니 충전결제" value="on"'):'PAGE TEXT: 네이버페이 결제금액 59,250원 포인트 사용이 불가한 가맹점입니다 포인트 혜택 N592원 적립'}),
idOf:async text=>text==='현대'?12:text==='동의하고 결제하기'?55:-1,
click:async id=>{clicks.push(id);if(id===12&&process.argv[2]==='yes')selected=true;}};
new (Object.getPrototypeOf(async function(){}).constructor)('page','sleep','EXPECTED_AMOUNT',process.argv[1])(
page,async()=>{},Number(process.argv[3])).then(result=>process.stdout.write(JSON.stringify({result,clicks})));
"""
    completed = subprocess.run(
        [
            shutil.which('node'),
            '-e',
            harness,
            NAVER_PREPARE_JS,
            'yes' if selectable else 'no',
            str(amount),
        ],
        capture_output=True,
        text=True,
        encoding='utf-8',
        check=True,
    )
    value = json.loads(completed.stdout)
    assert value['result']['ok'] is ok
    assert 55 not in value['clicks']


@pytest.mark.parametrize(
    'reward_text,amount,verified',
    [('', 0, False), ('구매적립예정 0P', 0, True), ('구매적립예정 295P', 295, True)],
)
def test_lotte_reward_missing_is_not_verified_zero(reward_text, amount, verified):
    script = Path(__file__).parents[1] / 'site-scripts' / 'lotteon_order_detail.js'
    harness = r"""
const fs=require('fs');let detail=true;  // 지금 스크립트는 상세 주소로 바로 들어가 '상세보기'를 누르지 않는다
const sourceNo='2026092816131856';
const tabs={open:async()=> 'tab audit',switch:async()=>{},list:async()=>[{id:'audit'}],close:async()=>{}};
const page={url:async()=> 'https://www.lotteon.com/p/order/mylotte/orderDeliveryList',waitFor:async()=>true,
click:async()=>{detail=true;return 'ok';},get:async options=>({tree:options.query==='상세보기'?'[4] button "상세보기"':!detail?'PAGE TEXT: '+sourceNo:
'PAGE TEXT: '+sourceNo+' 구매확정 '+process.argv[2]+' 결제정보 네이버페이 결제완료 59,250원 목록보기'})};
new (Object.getPrototypeOf(async function(){}).constructor)('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'))(
{source_order_no:sourceNo},tabs,page,async()=>{}).then(result=>process.stdout.write(JSON.stringify(result)));
"""
    result = subprocess.run(
        [shutil.which('node'), '-e', harness, str(script), reward_text],
        capture_output=True,
        text=True,
        encoding='utf-8',
        check=True,
    )
    value = json.loads(result.stdout)
    assert value['reward'] == amount
    assert value['reward_verified'] is verified
