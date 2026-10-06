"""소싱처 주문 상세 읽기 — 기록·검증이 함께 쓴다.

결제가 끝난 뒤 실제 주문 상세에서 결제액·사용 적립금·후기 제외 적립·카드를 읽어 원가를 다시 계산한다.
결제 전 견적 원가는 적립금·적립을 빼먹는 일이 있다(실기 2026-09-24: 88,300 으로 기록, 실제 95,520).
스크립트가 없거나 틀리면 에이전트의 script_json 이 AI 수리로 이어 간다.
"""

from collections.abc import Callable

from samba_agent.agents.buyer import effective_cost
from samba_agent.agents.contracts import Assignment

SOURCE_DETAIL_SCRIPT = 'source_order_detail'


def detail_script(site: str) -> str:
    """소싱처별 주문 상세 스크립트 이름(`<key>_order_detail`). 사이트마다 화면이 달라 하나로 쓰면 수리가 서로를 깬다."""
    from samba_agent.sources import default_sources

    src = default_sources().by_id(site)
    return f'{src.key}_order_detail' if src is not None else SOURCE_DETAIL_SCRIPT


def site_of(a: Assignment) -> str:
    """실제로 산 사이트(교차 비교면 주문 소싱처와 다르다)."""
    return str(a.handoff.get('buy_source') or a.order.source)


def detail_args(a: Assignment, source_order_no: object) -> dict[str, object]:
    """상세 스크립트 인자 — 삼바 주문번호·소싱처·소싱 주문번호·산 계정(프로필)."""
    site = str(a.handoff.get('buy_source') or a.order.source)  # 실제로 산 사이트
    args: dict[str, object] = {'orderNo': a.order.order_no, 'site': site}
    if source_order_no:
        args['source_order_no'] = source_order_no
    account = a.handoff.get('account') or a.order.account
    if account:
        args['profile'] = account
    return args


def detail_goal(site: str) -> str:
    return (
        f'소싱처({site}) 계정 profile 의 주문 상세에서 주문번호 source_order_no 의 주문을 열어 '
        '{source_order_no, status, paid(결제 금액 숫자), points_used(사용한 적립금·포인트 숫자, 없으면 0), '
        'reward(후기 적립을 뺀 이번 주문 적립·포인트 합계 숫자 — 머니 결제 적립·등급 적립·구매 적립 포인트·네이버페이 적립 '
        '포인트 등, 없으면 0), card(결제 수단과 카드사 글자, 예: 무신사페이 - 롯데카드 / 네이버페이 - 현대카드)} 를 돌려준다. '
        '카드사는 청구할인(현대 ×0.973, 롯데·KB ×0.98) 계산에 쓴다. 주문을 바꾸거나 취소하지 않는다.'
    )


def detail_check(source_order_no: object) -> Callable[[dict[str, object]], str | None]:
    """주문번호가 같고 결제액을 읽었어야 통과."""

    def check(out: dict[str, object]) -> str | None:
        if source_order_no and str(out.get('source_order_no') or '') != str(source_order_no):
            return f'주문번호 {source_order_no} 의 상세를 읽지 못했다(읽은 번호 {out.get("source_order_no")})'
        if actual_cost(out) is None:
            return '결제 금액(paid)을 읽지 못했다'
        return None

    return check


def with_pay_card(detail: dict[str, object], handoff: dict[str, object]) -> dict[str, object]:
    """주문 상세에 카드사가 안 읽히면(롯데온 L.PAY·간편결제는 '간편결제'로만 나온다) 구매 때 고른 카드사를 쓴다.

    청구할인 계수(롯데 ×0.98·현대 ×0.973)는 카드사 이름으로 정해진다 — 안 곱하면 실제 원가가 그만큼 높게 기록된다
    (실기 2026-10-06 롯데온 L.PAY 롯데카드: 결제 78,950 · 적립 437 → 원가 76,934 인데 78,513 으로 기록).
    상세에 계수가 있는 카드사가 읽혔으면 그대로 둔다.
    """
    from samba_agent.agents.buyer import billing_factor

    if billing_factor(str(detail.get('card') or '')) != 1.0:
        return detail
    issuer = str(handoff.get('card_issuer') or '').strip()
    if issuer and billing_factor(issuer) != 1.0:
        return {**detail, 'card': issuer}
    return detail


def actual_cost(detail: dict[str, object]) -> float | None:
    """상세 값으로 원가(플레이북 §6): 결제액 × 카드 청구할인 − 후기 제외 적립 + 사용 적립금. 결제액을 모르면 None."""
    try:
        paid = float(detail.get('paid') or 0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if paid <= 0:
        # 포인트로 전액 결제(ABC·그랜드스테이지) — 현금 0원이 맞다. 원가 = 사용 포인트 − 적립.
        # 0원을 '못 읽음'으로 보면 검사가 실패해 AI 수리가 상세 스크립트를 틀리게 고쳤다(실기 2026-09-26: 포인트 이중 계산 재발)
        try:
            used = float(detail.get('points_used') or 0)  # type: ignore[arg-type]
            reward = float(detail.get('reward') or 0)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
        return used - reward if used > 0 else None
    return float(
        effective_cost(
            {
                'cost': paid,
                'reward': detail.get('reward') or 0,
                'points_used': detail.get('points_used') or 0,
                'card': str(detail.get('card') or ''),
            }
        )
    )
