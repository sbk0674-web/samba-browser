# 사람 검토 게이트 — 승인 전에는 결제·기록이 돌지 않는다 / 거부 / 재개 / 재시작 뒤 재개
import warnings

import pytest
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.approval import APPROVAL_INTERRUPT_KEY
from samba_agent.supervisor.graph import build_supervisor
from samba_agent.supervisor.state import sanitize_payload

ORDER = OrderRef(order_no='A1', source='무신사', seller='포이즌', sku='S1', qty=1)


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def agents(log: list[str]):
    def mk(name: str, **payload):
        def fn(_a):
            log.append(name)
            return AgentResult(status='ok', reason=f'{name} 정상', payload=payload)

        return fn

    return {
        'buyer.musinsa': mk('buy', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5),
        'payer': mk('pay', paid=True),
        'recorder': mk('record', saved=True),
        'verifier': mk('verify'),
    }


def graph_of(reg, log):
    return build_supervisor(reg, agents(log), checkpointer=MemorySaver(), gate=True)


CFG = {'configurable': {'thread_id': 'job:1'}}


def test_결제_직전에_멈추고_요약을_내놓는다(reg):
    log: list[str] = []
    out = graph_of(reg, log).invoke(
        {'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG
    )
    assert log == ['buy']  # 결제는 아직 돌지 않았다
    req = out['__interrupt__'][0].value
    assert req['kind'] == APPROVAL_INTERRUPT_KEY
    assert req['stage'] == 'pay'
    assert '현대' in req['summary'] and '89,000' in req['summary']


def test_승인하면_결제_기록까지_이어진다(reg):
    # 승인은 결제 한 번뿐이다(계획 Task D) — 기록·검증은 그대로 이어진다
    log: list[str] = []
    g = graph_of(reg, log)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    out = g.invoke(Command(resume={'approved': True, 'by': 'U1'}), CFG)  # 결제 승인
    assert log == ['buy', 'pay', 'record', 'verify']
    assert out['outcome'] == 'done'
    assert out['approvals'] == {'pay': 'U1'}


def test_거부하면_외부를_바꾸지_않고_사람에게_넘긴다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    out = g.invoke(Command(resume={'approved': False, 'by': 'U1'}), CFG)
    assert log == ['buy']
    assert out['outcome'] == 'needs_ai'
    assert out['fail_reason'] is FailReason.PERMISSION_DENIED


def test_기록_단계는_승인_없이_지나간다(reg):
    # 기록은 우리 DB 에 소싱주문번호를 적는 되돌릴 수 있는 일이다 — 매 건 승인을 받지 않는다
    log: list[str] = []
    g = graph_of(reg, log)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    out = g.invoke(Command(resume={'approved': True, 'by': 'U1'}), CFG)
    assert '__interrupt__' not in out
    assert log == ['buy', 'pay', 'record', 'verify']


def test_승인이_필요한_단계는_결제_하나뿐이다():
    from samba_agent.supervisor.graph import EXTERNAL_STAGES

    assert EXTERNAL_STAGES == ('pay',)


def test_dry_run_이어도_게이트는_뜬다(reg):
    log: list[str] = []
    out = build_supervisor(reg, agents(log), checkpointer=MemorySaver(), gate=True).invoke(
        {'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG
    )
    assert '__interrupt__' in out


def test_게이트를_끄면_예전처럼_쭉_돈다(reg):
    log: list[str] = []
    out = build_supervisor(reg, agents(log)).invoke(
        {'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}
    )
    assert out['outcome'] == 'done'
    assert log == ['buy', 'pay', 'record', 'verify']


def test_같은_스레드로_다시_부르면_중복_실행되지_않는다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    assert log.count('buy') == 1  # 체크포인트가 있어 구매를 다시 하지 않는다


def test_stream_도_같은_스레드면_구매가_두_번_돌지_않는다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    list(g.stream({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG))
    list(g.stream({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG))
    assert log.count('buy') == 1  # invoke 뿐 아니라 stream 도 재개 규칙을 따라야 한다


async def test_ainvoke_도_같은_스레드면_구매가_두_번_돌지_않는다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    await g.ainvoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    await g.ainvoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    assert log.count('buy') == 1


async def test_astream_도_같은_스레드면_구매가_두_번_돌지_않는다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    async for _ in g.astream({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG):
        pass
    async for _ in g.astream({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG):
        pass
    assert log.count('buy') == 1


def test_재개해도_체크포인트_역직렬화_경고가_없다(reg):
    log: list[str] = []
    g = graph_of(reg, log)
    g.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        g.invoke(Command(resume={'approved': True, 'by': 'U1'}), CFG)  # 결제 승인
        g.invoke(Command(resume={'approved': True, 'by': 'U1'}), CFG)  # 기록 승인
    messages = [str(w.message) for w in caught]
    assert not any('Deserializing unregistered type' in m for m in messages)


def test_비밀로_보이는_키가_있으면_payload_저장을_거부한다():
    with pytest.raises(ValueError):
        sanitize_payload({'card_number': '1234-5678', 'card': '현대'})


def test_전화번호는_가리고_카드_브랜드명은_남긴다():
    out = sanitize_payload({'phone': '010-1234-5678', 'card': '현대'})
    assert out['phone'] == '***'
    assert out['card'] == '현대'


def test_플래그가_있으면_승인_요약_첫_줄에_표시한다(reg):
    # 가격X·재고X 등은 오류일 수 있어 제외하지 않고 결제 승인에서 사람이 본다(계획 P2-4)
    log: list[str] = []
    flagged = ORDER.model_copy(update={'flags': ('no_price', 'no_stock', 'staff_a', 'weird')})
    out = graph_of(reg, log).invoke(
        {'order': flagged, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG
    )
    summary = out['__interrupt__'][0].value['summary']
    assert summary.splitlines()[0] == '⚠ 플래그: 가격X, 재고X, 직원A, weird'


def test_플래그가_없으면_경고_줄도_없다(reg):
    log: list[str] = []
    out = graph_of(reg, log).invoke(
        {'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, CFG
    )
    assert '⚠' not in out['__interrupt__'][0].value['summary']
