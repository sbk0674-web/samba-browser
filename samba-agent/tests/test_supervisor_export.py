# 감독자 — export 노드는 검증 뒤에 돌고, 어떤 경우에도 주문 결과를 바꾸지 않는다
import pytest
from langgraph.checkpoint.memory import MemorySaver

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.graph import build_supervisor

ORDER = OrderRef(order_no='A1', source='무신사', seller='GS이숍(캐논)', sku='S1', qty=1)


def ok(name: str, **payload) -> AgentResult:
    return AgentResult(status='ok', reason=f'{name} 정상', payload=payload)


def agents(**over):
    base = {
        'buyer.musinsa': lambda _a: ok(
            'buyer', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5
        ),
        'payer': lambda _a: ok('payer'),
        'recorder': lambda _a: ok('recorder', values={'real_price': 62470, 'shipping_fee': 2300}),
        'verifier': lambda _a: ok('verifier'),
    }
    base.update(over)
    return base


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def run(reg, agents_map, exporter=None, **hooks) -> dict:
    graph = build_supervisor(reg, agents_map, exporter=exporter, **hooks)
    return graph.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True})


def test_exporter_가_없으면_그래프는_예전과_같다(reg):
    out = run(reg, agents())
    assert out['outcome'] == 'done'
    assert list(out['results']) == ['buyer.musinsa', 'payer', 'recorder', 'verifier']


def test_export_는_검증_뒤에_돈다(reg):
    seen: list[list[str]] = []

    def exporter(state):
        seen.append(list(state['results']))
        return ok('exporter', export='done')

    out = run(reg, agents(), exporter)
    assert seen == [['buyer.musinsa', 'payer', 'recorder', 'verifier']]
    assert out['outcome'] == 'done'
    assert list(out['results'])[-1] == 'exporter'
    assert out['results']['exporter'].payload['export'] == 'done'


def test_export_는_기록_결과를_본다(reg):
    got: dict = {}

    def exporter(state):
        got.update(state['results']['recorder'].payload['values'])
        return ok('exporter', export='done')

    run(reg, agents(), exporter)
    assert got == {'real_price': 62470, 'shipping_fee': 2300}


def test_export_가_예외를_던져도_주문은_done(reg):
    def exporter(_state):
        raise RuntimeError('큐 파일을 못 연다')

    out = run(reg, agents(), exporter)
    assert out['outcome'] == 'done'
    assert out['fail_reason'] is None
    assert out['results']['exporter'].status == 'ok'
    assert out['results']['exporter'].payload == {'export': 'error'}


def test_export_가_실패_결과를_돌려줘도_주문은_done(reg):
    def exporter(_state):
        return AgentResult(status='fail', reason='잘못된 구현', fail_reason=FailReason.UNKNOWN)

    out = run(reg, agents(), exporter)
    assert out['outcome'] == 'done'
    assert out['fail_reason'] is None


def test_검증이_실패하면_export_는_돌지_않는다(reg):
    calls = {'n': 0}

    def exporter(_state):
        calls['n'] += 1
        return ok('exporter', export='done')

    def bad_verifier(_a):
        return AgentResult(status='fail', reason='불일치', fail_reason=FailReason.VERIFY_MISMATCH)

    out = run(reg, agents(verifier=bad_verifier), exporter)
    assert out['outcome'] == 'needs_ai'
    assert calls['n'] == 0
    assert 'exporter' not in out['results']


def test_export_근거가_state_에_쌓인다(reg):
    from samba_agent.agents.contracts import Evidence

    def exporter(_state):
        return AgentResult(
            status='ok',
            reason='기입',
            payload={'export': 'done'},
            evidence=(Evidence(label='외부 기입', detail='emp 에 기입'),),
        )

    out = run(reg, agents(), exporter)
    assert out['evidence'][-1].label == '외부 기입'


def test_체크포인터를_거쳐도_exporter_결과가_round_trip된다(reg):
    # 리뷰 지적 — M4: exporter 가 붙은 상태가 체크포인터에 저장·복원돼도 문제없어야 한다
    calls = {'n': 0}

    def exporter(_state):
        calls['n'] += 1
        return ok('exporter', export='done')

    graph = build_supervisor(reg, agents(), exporter=exporter, checkpointer=MemorySaver())
    config = {'configurable': {'thread_id': 'export-thread-1'}}

    out = graph.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, config)
    assert out['outcome'] == 'done'
    assert out['results']['exporter'].payload['export'] == 'done'
    assert calls['n'] == 1

    # 끝난 스레드(next 가 비어 있다)로 같은 입력을 다시 부른다 — _ResumeSafeGraph 는 대기 중인
    # 스레드만 이어달리기하므로 여기서는 그대로 컴파일된 그래프에 넘어간다. 체크포인터가 이미
    # 끝난 상태를 문제없이 읽고 돌려줘야 한다(예외 없이, exporter 결과도 그대로)
    again = graph.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True}, config)
    assert again['outcome'] == 'done'
    assert again['results']['exporter'].payload['export'] == 'done'


def test_export_도_에이전트_결과_훅에_남는다(reg):
    seen: list[tuple[str, str, str]] = []

    def hook(_state, stage, name, result, _ms, _attempt):
        seen.append((stage, name, result.status))

    run(reg, agents(), lambda _s: ok('exporter', export='done'), on_agent_result=hook)
    assert seen[-1] == ('export', 'exporter', 'ok')
