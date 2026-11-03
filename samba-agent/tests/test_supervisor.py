# 감독자 — 배정 / 결과 검사 / 재시도 1회 / needs_ai / 결제 무재시도 / 미지원 / 권한 부족
import pytest

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.bridge.client import BridgeError
from samba_agent.failures import FailReason
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.graph import build_supervisor

ORDER = OrderRef(order_no='734501000740906', source='무신사', seller='포이즌', sku='S1', qty=1)


def ok(name: str, **payload) -> AgentResult:
    return AgentResult(status='ok', reason=f'{name} 정상', payload=payload)


def buyer_ok(_a) -> AgentResult:
    return ok('buyer', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5)


def plain_ok(_a) -> AgentResult:
    return ok('agent')


def agents(**over):
    base = {
        'buyer.musinsa': buyer_ok,
        'payer': plain_ok,
        'recorder': plain_ok,
        'verifier': plain_ok,
    }
    base.update(over)
    return base


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def run(reg, agents_map, order: OrderRef = ORDER, options=None, state_over=None) -> dict:
    graph = build_supervisor(reg, agents_map)
    state = {'order': order, 'options': options or {}, 'job_id': 1, 'dry_run': True}
    state.update(state_over or {})
    return graph.invoke(state)


def test_정상_한_건은_네_단계를_거쳐_done(reg):
    out = run(reg, agents())
    assert out['outcome'] == 'done'
    assert list(out['results']) == ['buyer.musinsa', 'payer', 'recorder', 'verifier']
    assert out['results']['buyer.musinsa'].payload['card'] == '현대'


def test_구매_실패는_한_번_재시도하고_그래도_실패면_사람에게(reg):
    calls = {'n': 0}

    def flaky(_a):
        calls['n'] += 1
        return AgentResult(status='fail', reason='품절', fail_reason=FailReason.OUT_OF_STOCK)

    out = run(reg, agents(**{'buyer.musinsa': flaky}))
    assert calls['n'] == 2  # 최초 1 + 재시도 1
    assert out['outcome'] == 'needs_ai'
    assert out['fail_reason'] is FailReason.OUT_OF_STOCK
    assert 'payer' not in out['results']  # 결제까지 가지 않는다


def test_재시도해서_성공하면_계속_간다(reg):
    calls = {'n': 0}

    def flaky(a):
        calls['n'] += 1
        if calls['n'] == 1:
            return AgentResult(
                status='fail', reason='브릿지 끊김', fail_reason=FailReason.BRIDGE_DOWN
            )
        return buyer_ok(a)

    out = run(reg, agents(**{'buyer.musinsa': flaky}))
    assert out['outcome'] == 'done'
    assert out['attempts']['buyer.musinsa'] == 2


def test_결제_에이전트는_재시도하지_않는다(reg):
    calls = {'n': 0}

    def failing_payer(_a):
        calls['n'] += 1
        return AgentResult(status='fail', reason='승인 거절', fail_reason=FailReason.UNKNOWN)

    out = run(reg, agents(payer=failing_payer))
    assert calls['n'] == 1  # 재결제 위험 — 한 번뿐
    assert out['outcome'] == 'needs_ai'


def test_needs_ai_은_재시도_없이_바로_멈춘다(reg):
    calls = {'n': 0}

    def captcha(_a):
        calls['n'] += 1
        return AgentResult(status='needs_ai', reason='캡차', fail_reason=FailReason.CAPTCHA)

    out = run(reg, agents(**{'buyer.musinsa': captcha}))
    assert calls['n'] == 1
    assert out['fail_reason'] is FailReason.CAPTCHA


def test_카드가_없으면_감독자가_결제로_넘기지_않는다(reg):
    def no_card(_a):
        return ok('buyer', account='a***@x.com', cost=89000, margin_pct=12.5)

    out = run(reg, agents(**{'buyer.musinsa': no_card}))
    assert out['outcome'] == 'needs_ai'
    assert out['fail_reason'] is FailReason.CARD_MISSING
    assert 'payer' not in out['results']


def test_카드가_없으면_재시도하지_않는다(reg):
    calls = {'n': 0}

    def no_card(_a):
        calls['n'] += 1
        return ok('buyer', account='a***@x.com', cost=89000, margin_pct=12.5)

    out = run(reg, agents(**{'buyer.musinsa': no_card}))
    assert calls['n'] == 1  # 다시 해도 카드가 안 생긴다 — 재시도 없이 바로 사람에게
    assert out['fail_reason'] is FailReason.CARD_MISSING


def test_마진이_미달이면_결제로_넘기지_않는다(reg):
    def thin(_a):
        return ok(
            'buyer', account='a***@x.com', card='현대', cost=89000, margin_pct=-5.0
        )  # 포이즌 기준(-3%) 미달

    out = run(reg, agents(**{'buyer.musinsa': thin}))
    assert out['fail_reason'] is FailReason.MARGIN


def test_모르는_소싱처는_바로_사람에게(reg):
    out = run(reg, agents(), order=ORDER.model_copy(update={'source': '쿠팡'}))
    assert out['outcome'] == 'needs_ai'
    assert 'unsupported' in out['results']['supervisor'].reason


def test_허용_목록_밖_도구를_부르면_권한_부족으로_끝난다(reg):
    def sneaky(_a):
        raise BridgeError(FailReason.PERMISSION_DENIED, '허용 목록 밖 도구: phone_approve_payment')

    out = run(reg, agents(**{'buyer.musinsa': sneaky}))
    assert out['outcome'] == 'needs_ai'
    assert out['fail_reason'] is FailReason.PERMISSION_DENIED
    assert out['attempts']['buyer.musinsa'] == 1  # 권한 부족은 재시도하지 않는다(스펙 §6)


def test_감독자는_에이전트에_허용_도구와_규칙만_넘긴다(reg):
    seen = {}

    def spy(a):
        seen['tools'] = a.allowed_tools
        seen['rules'] = a.rules
        seen['dry_run'] = a.dry_run
        return buyer_ok(a)

    run(reg, agents(**{'buyer.musinsa': spy}))
    assert 'phone_approve_payment' not in seen['tools']
    assert '원가 규칙' in seen['rules']
    assert seen['dry_run'] is True


def test_되읽기_불일치는_재시도하지_않고_바로_사람에게(reg):
    """verify_mismatch 는 다시 해도 같은 결과다 — 기록 에이전트의 retry:1 이 있어도 쓰지 않는다."""
    calls = {'n': 0}

    def mismatched(_a):
        calls['n'] += 1
        return AgentResult(
            status='fail', reason='필드 불일치', fail_reason=FailReason.VERIFY_MISMATCH
        )

    out = run(reg, agents(recorder=mismatched))
    assert calls['n'] == 1  # 재시도 없이 바로 사람에게
    assert out['outcome'] == 'needs_ai'
    assert out['fail_reason'] is FailReason.VERIFY_MISMATCH


def test_결제_단계_진입_직후_마커를_남긴다(reg):
    # 리뷰 지적 — Critical 2: 결제에 들어갔다는 사실을 체크포인트와 큐에 먼저 적는다
    marks: list[str] = []
    graph = build_supervisor(reg, agents(), on_stage_start=lambda _s, stage: marks.append(stage))
    out = graph.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True})
    assert marks == ['buy', 'pay', 'record', 'verify']
    assert out['pay_started'] is True


def test_결제_마커가_있으면_payer를_다시_부르지_않는다(reg):
    # 재시작·중복 재개로 결제 노드에 다시 들어와도 폰 승인을 두 번 내지 않는다
    calls = {'n': 0}

    def counting_payer(a):
        calls['n'] += 1
        return plain_ok(a)

    out = run(reg, agents(payer=counting_payer), state_over={'pay_started': True})
    assert calls['n'] == 0
    assert out['outcome'] == 'needs_ai'
    assert out['fail_reason'] is FailReason.PAY_INTERRUPTED


def test_구매_결과가_결제_기록_검증까지_계약으로_흐른다(reg):
    """리뷰 지적 — C3·I1·I2: buyer 가 고른 카드·계정·원가와 payer 가 뽑은 소싱 주문번호가
    다음 단계 Assignment 에 실려야 한다. 하나라도 비면 payer 는 card_missing,
    recorder 는 빈 계정으로 저장한다."""
    seen: dict[str, object] = {}

    def buyer(_a):
        return ok(
            'buyer',
            account='samba01@wave.co.kr',
            card='현대',
            cost=89000,
            margin_pct=12.5,
            option='270',
        )

    def payer(a):
        seen['payer'] = a
        return ok('payer', paid=True, card='현대', source_order_no='M-123456')

    def recorder(a):
        seen['recorder'] = a
        return ok('recorder', saved=True)

    def verifier(a):
        seen['verifier'] = a
        return ok('verifier')

    out = run(
        reg,
        agents(
            **{'buyer.musinsa': buyer, 'payer': payer, 'recorder': recorder, 'verifier': verifier}
        ),
    )
    assert out['outcome'] == 'done'

    pay_a = seen['payer']
    assert pay_a.handoff['card'] == '현대'
    assert pay_a.handoff['cost'] == 89000
    assert pay_a.handoff['account'] == 'samba01@wave.co.kr'  # 마스킹에 뭉개지지 않는다

    rec_a = seen['recorder']
    assert rec_a.handoff['account'] == 'samba01@wave.co.kr'
    assert rec_a.expected['source_order_no'] == 'M-123456'
    assert rec_a.expected['real_price'] == 89000

    assert seen['verifier'].expected['source_order_no'] == 'M-123456'


def test_요청자가_카드를_지정하지_않아도_payer는_buyer의_카드를_쓴다(reg):
    # 리뷰 지적 — C3
    seen: dict[str, object] = {}

    def payer(a):
        seen['a'] = a
        return plain_ok(a)

    run(reg, agents(payer=payer), options={})
    assert seen['a'].handoff['card'] == '현대'


def test_에이전트_실행마다_결과_훅이_불린다(reg):
    # diagnose 는 kind='agent' 이벤트만 본다 — 훅이 없으면 진단 표가 항상 비어 있다(실기)
    calls: list[tuple[str, str, str, int]] = []

    def hook(state, stage, agent, result, duration_ms, attempt):
        calls.append((stage, agent, result.status, attempt))
        assert duration_ms >= 0

    graph = build_supervisor(reg, agents(), on_agent_result=hook)
    out = graph.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True})
    assert out['outcome'] == 'done'
    assert calls == [
        ('buy', 'buyer.musinsa', 'ok', 1),
        ('pay', 'payer', 'ok', 1),
        ('record', 'recorder', 'ok', 1),
        ('verify', 'verifier', 'ok', 1),
    ]


def test_결과_훅이_예외를_던져도_실행은_계속된다(reg):
    def hook(*_a):
        raise RuntimeError('기록 실패')

    graph = build_supervisor(reg, agents(), on_agent_result=hook)
    out = graph.invoke({'order': ORDER, 'options': {}, 'job_id': 1, 'dry_run': True})
    assert out['outcome'] == 'done'


@pytest.mark.parametrize(
    ('seller', 'margin', 'ok'),
    [
        ('포이즌', -3.0, True),
        ('poison(마놀)', -2.9, True),
        ('POIZON', -3.1, False),
        ('신세계몰(seller01)', 0.0, False),
        ('신세계몰(seller01)', 0.1, True),
        ('쿠팡', -1.0, False),
    ],
)
def test_마진_기준은_판매처에_따라_다르다(seller, margin, ok):
    # 사용자 지시(2026-09-23): 포이즌만 −3% 이상이면 구매, 나머지는 0% 이하면 이행하지 않는다
    from samba_agent.supervisor.policy import check_buyer

    result = AgentResult(
        status='ok', reason='r', payload={'card': '현대', 'margin_pct': margin, 'account': 'a'}
    )
    out = check_buyer(result, seller)
    assert (out.status == 'ok') is ok
    if not ok:
        assert out.fail_reason is FailReason.MARGIN
