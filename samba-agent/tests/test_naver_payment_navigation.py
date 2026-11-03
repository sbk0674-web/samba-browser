"""Recorded NaverPay carousel labels; never click the payment agreement."""
import json
import shutil
import subprocess

import pytest

from samba_agent.agents.naverpay import NAVER_PREPARE_JS


@pytest.mark.parametrize('label', ['다음 결제수단', '다음 카드'])
@pytest.mark.parametrize('selected_card', ['현대카드', '머니 충전결제', '신한카드'])
def test_carousel_label_and_selected_card_must_both_match(label, selected_card):
    harness = r'''
let advanced=false;const clicks=[];
const page={
 get:async options=>({tree:options&&options.selector?
   (advanced?'[1] radio "'+process.argv[3]+'"':'[1] radio "머니 충전결제"'):
   'PAGE TEXT: 네이버페이 결제금액 59,250원 포인트 사용이 불가한 가맹점입니다 포인트 혜택 N592원 적립'}),
 idOf:async text=>text===process.argv[2]?42:text==='동의하고 결제하기'?55:-1,
 click:async id=>{clicks.push(id);if(id===42)advanced=true;}
};
new (Object.getPrototypeOf(async function(){}).constructor)('page','sleep','EXPECTED_AMOUNT',process.argv[1])(
 page,async()=>{},59250).then(result=>process.stdout.write(JSON.stringify({result,clicks})));
'''
    completed = subprocess.run(
        [shutil.which('node'), '-e', harness, NAVER_PREPARE_JS, label, selected_card],
        capture_output=True, text=True, encoding='utf-8', check=True,
    )
    value = json.loads(completed.stdout)
    assert value['result']['ok'] is (selected_card == '현대카드')
    assert 42 in value['clicks']
    assert len(value['clicks']) <= 8
    assert 55 not in value['clicks']


@pytest.mark.parametrize('scoped_text,ok', [('현대카드 일시불', True), ('현대카드 머니 충전결제', False), ('신한카드', False), ('', False)])
def test_selected_card_brand_in_scoped_plain_text(scoped_text, ok):
    harness = r'''
const clicks=[];
const page={get:async options=>({tree:'PAGE TEXT: '+(options&&options.selector?process.argv[2]:
 '네이버페이 현대카드 결제금액 59,250원 포인트 사용이 불가한 가맹점입니다 포인트 혜택 N592원 적립')}),
 idOf:async text=>text==='동의하고 결제하기'?55:-1,
 click:async id=>clicks.push(id)};
new (Object.getPrototypeOf(async function(){}).constructor)('page','sleep','EXPECTED_AMOUNT',process.argv[1])(
 page,async()=>{},59250).then(result=>process.stdout.write(JSON.stringify({result,clicks})));
'''
    completed = subprocess.run([shutil.which('node'), '-e', harness, NAVER_PREPARE_JS, scoped_text], capture_output=True, text=True, encoding='utf-8', check=True)
    value = json.loads(completed.stdout)
    assert value['result']['ok'] is ok
    assert value['clicks'] == []


@pytest.mark.parametrize('amount_text,ok', [
    ('0 1 2 3 4 5 6 7 8 9 ' * 5 + '41480 원', True),
    ('0 1 2 3 4 5 6 7 8 9 ' * 2 + ', ' + '0 1 2 3 4 5 6 7 8 9 ' * 3 + '41480 원', True),
    ('0 1 2 3 4 5 6 7 8 9 ' * 2 + ', ' + '0 1 2 3 4 5 6 7 8 9 ' * 3 + '41481 원', False),
    ('0 1 2 3 4 5 6 7 8 9 ' * 5 + '41481 원', False),
    ('0 1 2 3 4 5 6 7 8 41480 원', False),
    ('금액 확인 불가 다른 혜택 41480원', False),
])
def test_real_npay_rolling_amount_requires_complete_digit_strips(amount_text, ok):
    harness = r'''
const clicks=[];
const page={get:async options=>({tree:'PAGE TEXT: '+(options&&options.selector?'현대카드':
 '네이버페이 결제금액 '+process.argv[2]+' 포인트 사용이 불가한 가맹점입니다 포인트 혜택 '+'0 1 2 3 4 5 6 7 8 9 '.repeat(3)+'414 원 적립')}),
 idOf:async text=>text==='동의하고 결제하기'?55:-1,
 click:async id=>clicks.push(id)};
new (Object.getPrototypeOf(async function(){}).constructor)('page','sleep','EXPECTED_AMOUNT',process.argv[1])(
 page,async()=>{},41480).then(result=>process.stdout.write(JSON.stringify({result,clicks})));
'''
    completed = subprocess.run([shutil.which('node'), '-e', harness, NAVER_PREPARE_JS, amount_text], capture_output=True, text=True, encoding='utf-8', check=True)
    value = json.loads(completed.stdout)
    assert value['result']['ok'] is ok
    assert value['clicks'] == []
    if ok:
        assert value['result']['naver_reward'] == 414


def test_npay_password_authentication_is_not_a_card_selection_failure():
    harness = r'''
const page={get:async()=>({tree:'URL: https://pay.naver.com/authentication/pw/check?closeType=closeTypeBack\nPAGE TEXT: 네이버페이 인증 비밀번호 입력 키패드'}),
 idOf:async()=>{throw Error('must not look for cards during authentication')},
 click:async()=>{throw Error('must not click authentication or payment')}};
new (Object.getPrototypeOf(async function(){}).constructor)('page','sleep','EXPECTED_AMOUNT',process.argv[1])(
 page,async()=>{},41480).then(result=>process.stdout.write(JSON.stringify(result)));
'''
    completed = subprocess.run([shutil.which('node'), '-e', harness, NAVER_PREPARE_JS], capture_output=True, text=True, encoding='utf-8', check=True)
    value = json.loads(completed.stdout)
    assert value['ok'] is False
    assert value['auth_required'] is True
    assert '추가 비밀번호 인증' in value['error']


@pytest.mark.parametrize('selected,ok', [
    ('빅스 현대카드 UNLIMITED', True),
    ('머니 충전결제', False),
    ('롯데 1832 LOCA', False),
])
def test_captured_screen_reads_selected_card_from_page_text(selected, ok):
    """실기 2026-11-02 결제창 — 선택 표시 속성 없이 글자 '선택됨' 만 있다."""
    strip = '0 1 2 3 4 5 6 7 8 9 '
    captured = (
        '네이버페이 결제 결제금액 ' + strip * 2 + ', ' + strip * 3 + '51830 원 '
        '포인트 사용이 불가한 가맹점입니다 결제 수단 ' + selected + ' 선택됨 결제수단 전체보기 '
        '현대 8503 빅스 현대카드 UNLIMITED 선택 일시불 머니 충전결제 '
        '포인트 혜택 ' + strip * 3 + '518 원 적립 설정하기 동의하고 결제하기'
    )
    harness = r'''
const clicks=[];
const page={get:async options=>({tree:'PAGE TEXT: '+(options&&options.selector?'':process.argv[2])}),
 idOf:async text=>text==='동의하고 결제하기'?55:-1,click:async id=>clicks.push(id)};
new (Object.getPrototypeOf(async function(){}).constructor)('page','sleep','EXPECTED_AMOUNT',process.argv[1])(
 page,async()=>{},51830).then(result=>process.stdout.write(JSON.stringify({result,clicks})));
'''
    completed = subprocess.run([shutil.which('node'), '-e', harness, NAVER_PREPARE_JS, captured], capture_output=True, text=True, encoding='utf-8', check=True)
    value = json.loads(completed.stdout)
    assert value['result']['ok'] is ok
    assert value['clicks'] == []


def test_captured_job4011_amount_and_reward_with_rolling_thousands_separator():
    strip = '0 1 2 3 4 5 6 7 8 9 '
    captured = (
        '네이버페이 결제 스탠다드_백팩 미디움_옥스포드 NM2DR57K_GRY 결제금액 '
        + strip * 2 + ', ' + strip * 3 + '52280 원 '
        '포인트 사용이 불가한 가맹점입니다 '
        '포인트 혜택 ' + strip * 3 + '522 원 적립 설정하기 동의하고 결제하기'
    )
    harness = r'''
const clicks=[];
const page={get:async options=>({tree:'PAGE TEXT: '+(options&&options.selector?'현대카드 일시불':process.argv[2])}),
 idOf:async text=>text==='동의하고 결제하기'?55:-1,click:async id=>clicks.push(id)};
new (Object.getPrototypeOf(async function(){}).constructor)('page','sleep','EXPECTED_AMOUNT',process.argv[1])(
 page,async()=>{},52280).then(result=>process.stdout.write(JSON.stringify({result,clicks})));
'''
    completed = subprocess.run([shutil.which('node'), '-e', harness, NAVER_PREPARE_JS, captured], capture_output=True, text=True, encoding='utf-8', check=True)
    value = json.loads(completed.stdout)
    assert value['result']['ok'] is True
    assert value['result']['naver_reward'] == 522
    assert value['clicks'] == []
