import json
import pytest

from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import BuyerAgent
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.payer import PayerAgent
from samba_agent.queue.db import JobQueue
from samba_agent.queue.office_scope import load_office_scope


def test_claim_only_allowlisted_job_keeps_older_job_queued(tmp_path):
    q=JobQueue(tmp_path/'jobs.sqlite')
    old,_=q.enqueue('old','test',{},None)
    allowed,_=q.enqueue('allowed','test',{},None)
    q.allowed_job_ids=frozenset({allowed.id})
    assert q.claim().id==allowed.id
    assert q.get_by_id(old.id).state=='queued'
    q.finish(allowed.id,'done')
    assert q.claim() is None
    assert q.get_by_id(old.id).attempts==0


def test_empty_scope_never_claims(tmp_path):
    q=JobQueue(tmp_path/'jobs.sqlite');q.enqueue('x','test',{},None)
    q.allowed_job_ids=frozenset()
    assert q.claim() is None


def test_scope_does_not_resume_another_held_order(tmp_path):
    q=JobQueue(tmp_path/'jobs.sqlite');old,_=q.enqueue('old','test',{},None)
    q.progress(old.id,agent='approval.pay',step='승인 대기: pay');q.finish(old.id,'needs_ai')
    q.allowed_job_ids=frozenset({old.id+1})
    assert q.try_start_resume('old',stage='pay') is None
    assert q.get_by_id(old.id).state=='needs_ai'


def test_scope_never_reclaims_a_retried_allowed_job(tmp_path):
    q=JobQueue(tmp_path/'jobs.sqlite');job,_=q.enqueue('test','test',{},None)
    q.allowed_job_ids=frozenset({job.id})
    q._db.execute('UPDATE jobs SET attempts=1 WHERE id=?',(job.id,))
    assert q.claim() is None


def test_missing_scope_with_guard_fails_closed(tmp_path):
    path=tmp_path/'jobs.sqlite';q=JobQueue(path)
    q._db.execute('CREATE TRIGGER office_conflict_claim_guard BEFORE UPDATE ON jobs BEGIN SELECT 1; END')
    assert load_office_scope(path,tmp_path/'missing.json')==frozenset()


def test_no_guard_and_no_scope_preserves_normal_queue(tmp_path):
    path=tmp_path/'jobs.sqlite';JobQueue(path)
    assert load_office_scope(path,tmp_path/'missing.json') is None


@pytest.mark.parametrize('ids', [[],[True],['4024'],[-1]])
def test_invalid_scope_fails_before_claim(tmp_path,ids):
    path=tmp_path/'jobs.sqlite';JobQueue(path);scope=tmp_path/'scope.json'
    scope.write_text(json.dumps({'owner':'office-conflict-20261103',
        'allowed_order_type':'gift','allowed_job_ids':ids}),encoding='utf-8')
    with pytest.raises(ValueError):load_office_scope(path,scope)


def test_valid_scope_is_exact_job_ids(tmp_path):
    path=tmp_path/'jobs.sqlite';JobQueue(path);scope=tmp_path/'scope.json'
    scope.write_text(json.dumps({'owner':'office-conflict-20261103',
        'allowed_order_type':'gift','allowed_job_ids':[4024,4027]}),encoding='utf-8')
    assert load_office_scope(path,scope)==frozenset({4024,4027})


def assignment(kind):
    return Assignment(order=OrderRef(order_no='T',source='LOTTEON',seller='test',sku='S'),
        handoff={'order_type':kind,'card':'test'},allowed_tools=(),rules='',dry_run=False)


@pytest.mark.parametrize('kind',['kkadaegi','direct',None])
def test_scoped_payer_blocks_non_gift_before_rechecking_or_paying(kind):
    payer=object.__new__(PayerAgent);payer.gift_only=True
    payer._recheck_wave=lambda *_:pytest.fail('payment path reached')
    with pytest.raises(AgentFailure):payer._pay(assignment(kind))


def test_scoped_gift_reaches_existing_checks_without_bypassing_them():
    payer=object.__new__(PayerAgent);payer.gift_only=True
    class ExistingCheckReached(Exception):pass
    def check(*_):raise ExistingCheckReached()
    payer._recheck_wave=check
    with pytest.raises(ExistingCheckReached):payer._pay(assignment('gift'))


def test_normal_payer_keeps_existing_non_gift_preflight():
    payer=object.__new__(PayerAgent)
    class ExistingCheckReached(Exception):pass
    def check(*_):raise ExistingCheckReached()
    payer._recheck_wave=check
    with pytest.raises(ExistingCheckReached):payer._pay(assignment('kkadaegi'))


def test_scoped_buyer_cannot_select_or_apply_office_address():
    buyer=object.__new__(BuyerAgent);buyer.office_shipping_blocked=True
    buyer.order_type_of=lambda *_:'kkadaegi'
    buyer._keep_default_shipping=lambda *_:pytest.fail('office selection reached')
    with pytest.raises(AgentFailure):buyer._set_shipping(assignment('kkadaegi'),{},'test')


def test_factory_guards_all_buyers_cross_partners_and_payer():
    from samba_agent.agents.factory import build_agents
    from samba_agent.agents.registry import Registry
    from samba_agent.bridge.client import BridgeClient
    from samba_agent.settings import DEFAULT_ROOT
    bridge=BridgeClient('http://127.0.0.1:47811','test',allowed=())
    try:
        agents=build_agents(Registry.load(DEFAULT_ROOT),bridge,lambda *_:None,gift_only=True)
        assert agents['payer'].gift_only
        for agent in agents.values():
            if isinstance(agent,BuyerAgent):
                assert agent.office_shipping_blocked
                if agent.sibling is not None:
                    assert agent.sibling.office_shipping_blocked
    finally:bridge.close()


def test_actual_worker_constructor_has_no_cancel_callback_in_scoped_mode():
    import ast,inspect
    from types import SimpleNamespace
    import samba_agent.__main__ as main
    tree=ast.parse(inspect.getsource(main))
    call=next(n for n in ast.walk(tree) if isinstance(n,ast.Call)
              and isinstance(n.func,ast.Name) and n.func.id=='WorkerDeps')
    expr=next(k.value for k in call.keywords if k.arg=='flag_order')
    sentinel=object()
    code=compile(ast.Expression(expr),'<worker cancellation wiring>','eval')
    assert eval(code,{'flagger':SimpleNamespace(mark=sentinel),'office_scoped':True}) is None
    assert eval(code,{'flagger':SimpleNamespace(mark=sentinel),'office_scoped':False}) is sentinel


def test_no_auto_cancel_policy_blocks_client_before_http(monkeypatch):
    from samba_agent.wave.client import WaveClient,WaveError
    monkeypatch.setenv('SAMBA_NO_AUTO_CANCEL','1')
    wave=object.__new__(WaveClient)
    wave._request=lambda *a,**kw:pytest.fail('cancellation HTTP request attempted')
    with pytest.raises(WaveError,match='자동 취소 금지'):
        wave.set_cancel_requested('test','sold out',flag='no_stock')


def test_explicit_non_guarded_client_retains_existing_call_contract(monkeypatch):
    from samba_agent.wave.client import WaveClient
    monkeypatch.setenv('SAMBA_NO_AUTO_CANCEL','0')
    wave=object.__new__(WaveClient);calls=[]
    def request(*args,**kwargs):calls.append((args,kwargs));return {'ok':True,'changed':True}
    wave._request=request
    assert wave.set_cancel_requested('test','sold out',flag='no_stock')
    assert len(calls)==1
