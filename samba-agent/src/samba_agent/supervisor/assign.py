"""배정 — 등록부에서 조건이 맞는 에이전트를 고르고 Assignment 를 만든다.

LLM 이 아니라 코드가 고른다. 결정 근거가 남고 채점이 되기 때문이다(스펙 §4.3).

앞 단계 결과를 다음 단계로 넘기는 자리이기도 하다. 구매가 고른 카드·계정·원가와
결제가 뽑은 소싱 주문번호가 여기서 실리지 않으면 결제는 card_missing 으로 끝나고
기록은 빈 계정·빈 주문번호로 저장한다(리뷰 지적 — C3·I1·I2).
"""

from samba_agent.agents.contracts import Assignment
from samba_agent.agents.registry import AgentSpec, Registry
from samba_agent.supervisor.state import RunState

# 구매 결과에서 다음 단계가 일하는 데 필요한 값 — 대조용이 아니라 인계용이다
BUYER_HANDOFF_FIELDS = (
    'card',
    'account',
    'cost',
    'margin_pct',
    'option',
    'pay_provider',
    'paid',
    'card_issuer',
    # 실제로 산 소싱처(교차 비교로 주문 소싱처와 다를 수 있다)
    'buy_source',
    # 주문서에서 쓴 보유 적립금(선할인 제외) — 기록 단계 원가에 쓴다(주문 상세는 선할인까지 합친 값만 보여 준다)
    'points_used',
    # 견적의 적립(사이트 적립예정 + 네이버페이 1%) — 주문 상세에 적립이 안 나오는 ABC·그랜드스테이지 원가에 쓴다
    'reward',
    # 결제 진입 대조·주문서 탭 지정(2026-09-26 재작성 계약)
    'selected',
    'order_tab',
    # 실제로 산 상품 번호·이름(교차 비교면 원래 주문과 다른 사이트 기준) — 결제 진입 대조용
    'product_no',
    'product_name',
    # 도착한 상품 주소(SSG 지정 몰 상품) — 결제 진입 대조(expect.product_url)
    'product_url',
    # 진입 경로(SSG 직접·애드픽)와 애드픽 적립(원) — 기록 단계 원가에 쓴다(주문 상세에 애드픽 적립이 안 나온다)
    'route',
    'adpick_reward',
)


def build_assignment(reg: Registry, spec: AgentSpec, state: RunState) -> Assignment:
    """에이전트에 넘길 입력. 허용 도구와 규칙 본문을 감독자가 쥐여 준다."""
    handoff = _handoff(state)
    account = handoff.get('account')
    return Assignment(
        order=state['order'],
        options=state.get('options', {}),
        account_candidates=(str(account),) if account else (),
        evidence_so_far=tuple(state.get('evidence', [])),
        allowed_tools=spec.tools,
        rules=reg.rules_text(spec),
        dry_run=bool(state.get('dry_run', True)),
        dry_run_digits=int(state.get('dry_run_digits', 0) or 0),
        expected=_expected(state),
        handoff=handoff,
    )


def _handoff(state: RunState) -> dict[str, object]:
    """앞 단계 결과 → 다음 단계 인계값.

    계정은 마스킹을 거치지 않는다 — `sanitize_payload` 의 INTERNAL_ID_KEYS 가 내부 판매
    계정을 가리지 않기 때문이다(고객 개인정보만 가린다).
    """
    out: dict[str, object] = {}
    for name, r in state.get('results', {}).items():
        if name.startswith('buyer.'):
            out.update({f: r.payload.get(f) for f in BUYER_HANDOFF_FIELDS})
        if name == 'payer':
            # 결제가 성공 화면에서 뽑은 소싱 주문번호 — 기록·검증이 이걸 쓴다
            out.update({f: r.payload.get(f) for f in ('card', 'source_order_no', 'arrival_memo')})
    return {k: v for k, v in out.items() if v is not None}


def _expected(state: RunState) -> dict[str, object]:
    """기록·검증이 소싱처·SAMBA 행과 대조할 값만 뽑는다.

    대조 대상만 담는다 — 검증 에이전트가 이 사전의 모든 키를 소싱처 주문 상세와 SAMBA 행
    양쪽에서 찾아 비교하기 때문이다. 카드·마진·계정처럼 대조 대상이 아닌 값은 `handoff` 로 간다.

    `real_price`(실구매가 = 결제액 + 사용 적립금 − 확정 신규 적립)와 `cost`(원가)는
    rules/recorder.md §2 에서 정의가 다르다. 구매 에이전트가 실구매가를 따로 주지 않으면
    원가와 같은 값을 쓰되, 이름은 실구매가로 둔다(리뷰 지적 — Minor).
    """
    out: dict[str, object] = {}
    for name, r in state.get('results', {}).items():
        if name.startswith('buyer.'):
            cost = r.payload.get('cost')
            out.update(
                {
                    'real_price': r.payload.get('real_price', cost),
                    'source_order_no': r.payload.get('source_order_no'),
                    'shipping_fee': r.payload.get('shipping_fee', 0),
                    'flags': r.payload.get('flags', []),
                    # 구매 에이전트가 판정한 배송 종류 — 기록 단계가 삼바웨이브 태그로 남긴다
                    'order_type': r.payload.get('order_type'),
                }
            )
        if name == 'payer':
            # 구매 단계에서 None 이었다면 여기서 채운다(setdefault 는 None 을 덮지 못한다)
            source_order_no = r.payload.get('source_order_no')
            if source_order_no is not None:
                out['source_order_no'] = source_order_no
    return {k: v for k, v in out.items() if v is not None}
