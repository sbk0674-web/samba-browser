import json
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from samba_agent.agents.contracts import AgentResult
from samba_agent.agents.payer import PayerAgent
from samba_agent.ops.money_alerts import KST, MUSINSA_BALANCE_JS, MoneyBalanceAlerts, money_band


@pytest.fixture(autouse=True)
def daytime_default(monkeypatch):
    original = MoneyBalanceAlerts.__init__

    def init(self, path, send, *, now=None):
        original(self, path, send, now=now or (lambda: datetime(2026, 10, 29, 12, tzinfo=KST)))

    monkeypatch.setattr(MoneyBalanceAlerts, '__init__', init)


@pytest.mark.parametrize(
    'balance,band',
    [
        (0, None),
        (1, 0),
        (200000, 0),
        (200001, None),
        (499999, None),
        (500000, None),
        (500001, 1),
        (700000, 1),
        (700001, None),
        (1000000, None),
        (1000001, 2),
        (1200000, 2),
        (1200001, None),
        (1500000, None),
        (1500001, 3),
        (1700000, 3),
        (1700001, None),
        (None, None),
        (-1, None),
        (True, None),
        ('unknown', None),
    ],
)
def test_requested_ranges_exclude_lower_boundary(balance, band):
    assert money_band(balance) == band


def rows(balance):
    return [{'method': '무신사머니', 'balance': balance}]


@pytest.mark.parametrize('account', ['buyer01', 'buyer02'])
@pytest.mark.parametrize('balance', [0, 500000, 1000000, 1500000])
def test_no_message_at_excluded_lower_boundary(tmp_path, account, balance):
    sent = []
    alert = MoneyBalanceAlerts(tmp_path / 'alerts.sqlite', lambda text: sent.append(text) or True)
    assert not alert.observe(account, rows(balance))
    assert sent == []


def test_per_account_dedup_survives_restart_and_rearms(tmp_path):
    sent = []
    path = tmp_path / 'alerts.sqlite'

    def send(text):
        sent.append(text)
        return 'posted'

    alert = MoneyBalanceAlerts(path, send)
    assert alert.observe('buyer01', rows(1600000))
    assert not alert.observe('buyer01', rows(1550000))
    assert MoneyBalanceAlerts(path, send).observe('buyer02', rows(1600000))
    assert not MoneyBalanceAlerts(path, send).observe('buyer01', rows(1500000))
    assert not alert.observe('buyer01', rows(1800000))
    assert alert.observe('buyer01', rows(1600000))
    assert len(sent) == 3
    assert 'buyer01' in sent[0] and '1,600,000원' in sent[0] and 'KST' in sent[0]


def test_failed_delivery_retries_and_unknown_never_becomes_zero(tmp_path):
    alert = MoneyBalanceAlerts(tmp_path / 'alerts.sqlite', lambda text: None)
    assert not alert.observe('buyer01', rows(100000))
    sent = []
    alert.send = lambda text: sent.append(text) or 'posted'
    assert alert.observe('buyer01', rows(100000))
    assert not alert.observe('buyer01', rows(None))
    assert not alert.observe('buyer01', rows(0))
    assert not alert.observe('other-account', rows(0))
    assert not alert.observe('buyer02', [{'method': '무신사페이', 'balance': 0}])
    assert not alert.observe('buyer02', rows(0) + rows(600000))
    assert len(sent) == 1


def test_payer_reads_actual_balance_after_success():
    agent = object.__new__(PayerAgent)
    calls = []
    agent.money_balance_alert = lambda account, quotes: calls.append((account, quotes))
    agent.tool = lambda *args, **kwargs: json.dumps({'verified': True, 'balance': 1680000})
    a = SimpleNamespace(dry_run=False, handoff={'buy_source':'MUSINSA','account':'buyer01','balance':1800000}, order=SimpleNamespace(source='무신사',account=None))
    agent._notify_money_balance(a, AgentResult(status='ok', reason='paid', payload={'paid':True,'card':'무신사머니'}))
    assert calls == [('buyer01', rows(1680000))]


@pytest.mark.parametrize('dry_run,paid,card,source', [
    (True,True,'무신사머니','MUSINSA'),(False,False,'무신사머니','MUSINSA'),
    (False,True,'무신사페이','MUSINSA'),(False,True,'무신사머니','LOTTEON'),
])
def test_no_balance_lookup_before_payment_or_for_other_methods(dry_run,paid,card,source):
    agent = object.__new__(PayerAgent)
    agent.money_balance_alert = lambda *args: pytest.fail('unexpected SMS')
    agent.tool = lambda *args, **kwargs: pytest.fail('unexpected site read')
    a = SimpleNamespace(dry_run=dry_run,handoff={'buy_source':source,'account':'buyer01'},order=SimpleNamespace(source='무신사',account=None))
    agent._notify_money_balance(a,AgentResult(status='ok',reason='result',payload={'paid':paid,'card':card}))


@pytest.mark.parametrize('hour,minute,sends', [(23,59,True),(0,0,False),(6,59,False),(7,0,True)])
def test_kst_quiet_boundaries(tmp_path,hour,minute,sends):
    sent=[]
    alert=MoneyBalanceAlerts(tmp_path/'a.sqlite',lambda msg:sent.append(msg) or True,
        now=lambda:datetime(2026,10,29,hour,minute,tzinfo=KST))
    assert alert.observe('buyer01',rows(1600000)) is sends
    assert bool(sent) is sends


def test_quiet_payment_does_not_consume_daytime_alert(tmp_path):
    clock=[datetime(2026,10,28,21,59,tzinfo=UTC)]  # KST 06:59
    sent=[]
    alert=MoneyBalanceAlerts(tmp_path/'a.sqlite',lambda msg:sent.append(msg) or True,now=lambda:clock[0])
    assert not alert.observe('buyer01',rows(1600000))
    clock[0]=datetime(2026,10,28,22,0,tzinfo=UTC)
    assert alert.observe('buyer01',rows(1550000))
    assert not alert.observe('buyer01',rows(1540000))
    assert len(sent)==1


def test_balance_notification_failure_preserves_paid_result(monkeypatch):
    agent=object.__new__(PayerAgent)
    result=AgentResult(status='ok',reason='paid',payload={'paid':True,'card':'무신사머니'})
    a=SimpleNamespace(dry_run=False,handoff={'buy_source':'MUSINSA','account':'buyer01'},order=SimpleNamespace(source='무신사',account=None))
    agent.evidence=[]
    agent.reset_repairs=lambda:None
    agent.failure_shot=lambda assignment:lambda reason:[]
    agent._pay=lambda assignment:result
    def broken(*args,**kwargs):raise RuntimeError('read failed')
    agent.tool=broken
    agent.money_balance_alert=lambda *args:pytest.fail('unexpected SMS')
    assert agent(a) is result


@pytest.mark.parametrize('tree,balance', [
    ('[37] button "무신사머니 1,180,540원"',1180540),
    ('[37] button "무신사머니 0원"',0),
    ('[49] link "무신사머니 최대 10% 적립"',None),
    ('[37] button "무신사머니 1,180,540원"\n[38] button "무신사머니 900,000원"',None),
])
def test_balance_reader_only_uses_explicit_wallet_label_and_restores_tab(tree,balance):
    harness=r'''
const code=process.argv[1],tree=process.argv[2];const closed=[],switched=[];
const tabs={list:async()=>[{id:'paid',active:true}],open:async()=> 'tab balance',switch:async id=>switched.push(id),close:async id=>closed.push(id)};
const page={waitFor:async()=>{},get:async()=>({tree})};
new (Object.getPrototypeOf(async function(){}).constructor)('tabs','page','PROFILE',code)(tabs,page,'buyer01')
.then(r=>process.stdout.write(JSON.stringify({value:JSON.parse(r),closed,switched})));
'''
    p=subprocess.run([shutil.which('node'),'-e',harness,MUSINSA_BALANCE_JS,tree],capture_output=True,text=True,check=True)
    out=json.loads(p.stdout)
    assert out['value'].get('balance')==balance
    assert out['value']['verified'] is (balance is not None)
    assert out['closed']==['balance'] and out['switched'][-1]=='paid'


@pytest.mark.parametrize(
    'balance,expected',
    [('', None), ('현재 보유 머니 0 원', 0), ('현재 보유 머니 600,000 원', 600000)],
)
def test_script_distinguishes_unknown_balance_from_real_zero(balance, expected):
    script = Path(__file__).parents[1] / 'site-scripts' / 'musinsa_payment_quotes.js'
    harness = r"""
const fs = require('fs');
const code = fs.readFileSync(process.argv[1], 'utf8');
const text = '결제 수단 무신사머니 ' + process.argv[2] + ' 결제 금액 상품 금액 총 결제 금액 10,000 원';
const tree = '[1] radio "무신사머니"\nPAGE TEXT:' + text;
const page = {get:async()=>({tree}),waitFor:async()=>{},find:async()=>'',click:async()=>{}};
const tabs = {list:async()=>[{id:'one',url:'https://www.musinsa.com/order/order-form'}],switch:async()=>{}};
new (Object.getPrototypeOf(async function(){}).constructor)('args','tabs','page','sleep',code)(
  {methods:['무신사머니']},tabs,page,async()=>{}
).then(result=>process.stdout.write(JSON.stringify(result.quotes[0].balance)));
"""
    result = subprocess.run(
        [shutil.which('node'), '-e', harness, str(script), balance],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(result.stdout) == expected
