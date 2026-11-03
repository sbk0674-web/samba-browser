"""선물 수락은 주문 상세의 명시 상태로만 판정한다. 실제 브라우저/결제 호출 없음."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / 'site-scripts' / 'ssg_order_detail.js'


def run_detail(text, *, login=False, complete=None, complete_profile='edelvise06'):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    code = r"""
const fs=require('fs'), assert=require('assert');
const source=fs.readFileSync(process.argv[1],'utf8');
const fixture=JSON.parse(process.argv[2]);
const closed=[];
let active='own-detail';
const tabs={
 open:async o=>{assert.equal(o.profile,'edelvise06');assert(o.url.includes('2026103039AE04'));return 'ok: tab own-detail';},
 list:async()=>fixture.complete===null?[]:[{id:'own-detail',active:true},{id:'complete',profile:fixture.complete_profile,url:'https://pay.ssg.com/orderComplete.ssg?orordNo=2026103039AE04'}],
 switch:async id=>{assert(['own-detail','complete'].includes(id));active=id;},
 close:async id=>closed.push(id)
};
const page={waitFor:async()=>{},url:async()=>fixture.login?'https://member.ssg.com/member/login.ssg':'https://pay.ssg.com/myssg/orderInfoDetail.ssg?orordNo=2026103039AE04',
 get:async()=>({tree:'PAGE TEXT:\n'+(active==='complete'?fixture.complete:fixture.text)})};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
new AsyncFunction('args','tabs','page',source)({source_order_no:'2026103039AE04',profile:'edelvise06'},tabs,page)
 .then(result=>{assert.deepEqual(closed,['own-detail']);console.log(JSON.stringify(result));}).catch(e=>{console.error(e);process.exitCode=1;});
"""
    result = subprocess.run(
        [
            node,
            '-e',
            code,
            str(SCRIPT),
            json.dumps(
                {
                    'text': text,
                    'login': login,
                    'complete': complete,
                    'complete_profile': complete_profile,
                }
            ),
        ],
        capture_output=True,
        text=True,
        encoding='utf-8',
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


BASE = '주문번호 20261030-39AE04\nA515131017\n상품준비중\n결제 정보 총 결제 금액 10,355원\n'


@pytest.mark.parametrize(
    'extra',
    [
        '',
        '선물하기 주문',
        '선물 수락 완료 후 배송됩니다',
        '선물 수락 완료 여부를 확인하세요',
        '선물 수락 완료',
        '선물 받기 완료',
    ],
)
def test_preparing_or_guidance_is_not_acceptance(extra):
    result = run_detail(BASE + extra)
    assert result['status'] == '상품준비중'
    assert result['gift_accepted'] is None
    assert result['gift_status'] is None


@pytest.mark.parametrize(
    'state',
    [
        '선물 상태: 선물 수락 완료',
        '선물 받기 상태: 받기완료',
        '선물 수락 상태: 수락완료',
        '선물 상태\n수락완료',
    ],
)
def test_explicit_acceptance_field(state):
    result = run_detail(BASE + state)
    assert result['gift_accepted'] is True
    assert result['gift_status'] == '수락완료'
    assert result['gift_evidence']


@pytest.mark.parametrize(
    'state', ['선물 수락 대기', '선물 수락 상태\n수락대기', '선물 상태: 수락대기']
)
def test_explicit_pending_overrides_preparing(state):
    result = run_detail(BASE + state)
    assert result['gift_accepted'] is False
    assert result['gift_status'] == '수락대기'


def test_conflicting_fields_do_not_confirm_acceptance():
    result = run_detail(BASE + '선물 상태: 수락완료\n선물 수락 대기')
    assert result['gift_accepted'] is None
    assert result['gift_status'] == '확인필요'


def test_wrong_order_does_not_return_acceptance():
    result = run_detail(BASE.replace('20261030-39AE04', '20261030-OTHER') + '선물 수락 완료')
    assert result['gift_accepted'] is None
    assert 'not on page' in result['note']


def test_login_required_does_not_return_acceptance():
    result = run_detail(BASE + '선물 수락 완료', login=True)
    assert result['gift_accepted'] is None
    assert result['note'] == 'login required'


def test_app_script_size_limit():
    assert len(SCRIPT.read_text(encoding='utf-8')) <= 8000


COMPLETE = (
    '주문번호 2026103039AE04\n선물하기 주문 결제완료\n'
    '최종 결제 금액 292,500원\n결제 내역 '
    'SSGPAY-신용카드 292,500원 (현대카드) '
    '신세계 포인트 1,000원 적립 머니 200원 SSG MONEY 적립 300원 '
    'SSG MONEY 충전결제 4,000원\n이번 주문으로 '
    '구매 혜택 신세계 포인트 500P SSG MONEY 200원 쓱7클럽'
)


def test_active_completion_fallback_keeps_financials_and_unknown_acceptance():
    result = run_detail('', login=True, complete=COMPLETE)
    assert result['paid'] == 292500
    assert result['points_used'] == 1500
    assert result['money_paid'] == 4000
    assert result['card'] == 'SSGPAY-신용카드 - 현대카드'
    assert result['reward'] == 700
    assert result['note'] == '주문완료 화면에서 읽음'
    assert result['gift_status'] is None
    assert result['gift_accepted'] is None


@pytest.mark.parametrize('profile', ['another-account', ''])
def test_completion_fallback_does_not_read_another_profile(profile):
    result = run_detail('', login=True, complete=COMPLETE, complete_profile=profile)
    assert result['paid'] == 0
    assert result['note'] == 'login required'


def test_completion_fallback_rejects_other_order():
    result = run_detail(
        '', login=True, complete=COMPLETE.replace('2026103039AE04', '20261030OTHER')
    )
    assert result['paid'] == 0
    assert result['note'] == 'login required'


def test_detail_keeps_points_money_and_card_with_gift_fields():
    text = BASE + (
        '결제 내역 SSGPAY-신용카드 10,355원 현대카드 '
        '신세계 포인트 1,000원 적립 머니 200원 SSG MONEY 충전결제 4,000원 '
        '구매혜택 신세계 포인트 500P 받은 총 혜택\n선물 상태: 수락완료'
    )
    result = run_detail(text)
    assert result['points_used'] == 1200
    assert result['money_paid'] == 4000
    assert result['card'] == 'SSGPAY-신용카드 - 현대카드'
    assert result['gift_accepted'] is True


@pytest.mark.parametrize(
    'history,expected',
    [
        ('신용카드 현대카드 일시불 10,355원', '신용카드 - 현대카드'),
        ('신용카드 현대카드 롯데카드 10,355원', ''),
        ('신용카드 일시불 10,355원', ''),
        ('SSGPAY-신용카드 50,400원 현대카드', 'SSGPAY-신용카드 - 현대카드'),
    ],
)
def test_active_detail_card_cases_by_running_whole_script(history, expected):
    result = run_detail(BASE + '결제 내역 ' + history + ' 구매혜택 받은 총 혜택')
    assert result['card'] == expected
