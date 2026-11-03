"""감독 규칙 — 재시도 여부와 구매 결과 검사(스펙 §4.3-4, §5-4, §6)."""

from samba_agent.agents.contracts import AgentResult
from samba_agent.agents.registry import AgentSpec
from samba_agent.failures import FailReason

STAGES = ('buy', 'pay', 'record', 'verify')
KIND_OF_STAGE = {'buy': 'buyer', 'pay': 'payer', 'record': 'recorder', 'verify': 'verifier'}

# 다시 해도 같은 답이 나오는 사유 — 재시도 없이 사람에게 넘긴다
NO_RETRY_REASONS = frozenset(
    {
        FailReason.PERMISSION_DENIED,
        FailReason.DUPLICATE,
        FailReason.CAPTCHA,
        FailReason.MARGIN,
        FailReason.CARD_MISSING,
        # 되읽기 불일치는 다시 시도해도 같은 결과다 — 사람이 확인해야 한다
        FailReason.VERIFY_MISMATCH,
        # 결제 진행 중 재시작 — 다시 돌리면 재결제다
        FailReason.PAY_INTERRUPTED,
    }
)


def should_retry(spec: AgentSpec, result: AgentResult, attempts: int) -> bool:
    """이 실패를 같은 에이전트로 한 번 더 시켜도 되는가."""
    if result.status != 'fail':
        return False  # needs_ai 은 재시도하지 않는다
    if spec.retry <= 0:
        return False  # 결제 에이전트 — 재결제 위험
    if result.fail_reason in NO_RETRY_REASONS:
        return False
    # 확정 품절(모든 계정에서 선택지는 읽혔는데 주문 사이즈가 없다)은 다시 돌려도 같다(실기: 재시도로 1건 10~20분)
    if result.fail_reason is FailReason.OUT_OF_STOCK and result.reason.startswith('확정 품절'):
        return False
    return attempts <= spec.retry


# 판매처별 마진 하한(사용자 지시 2026-09-23): 포이즌은 −3% 까지 감수하고 산다(마진 ≥ −3%),
# 나머지 판매처는 0% 이하면 이행하지 않는다(마진 > 0%). 판매처 문자열에 아래 표식이 들어 있으면 포이즌이다
POISON_SELLER_MARKERS = ('포이즌', 'poison', 'poizon')
POISON_MARGIN_MIN = -3.0


def is_poison_seller(seller: str | None) -> bool:
    """판매처 문자열이 포이즌(삼바웨이브 마켓 poison)인가."""
    s = (seller or '').lower()
    return any(m in s for m in POISON_SELLER_MARKERS)


def margin_ok(margin: object, seller: str | None) -> bool:
    """마진율(%)이 판매처 기준을 넘는가. 숫자가 아니면 거짓."""
    if not isinstance(margin, (int, float)) or isinstance(margin, bool):
        return False
    if is_poison_seller(seller):
        return float(margin) >= POISON_MARGIN_MIN
    return float(margin) > 0


def check_buyer(result: AgentResult, seller: str | None = None) -> AgentResult:
    """구매 결과를 감독자가 검사한다 — 카드가 있고 마진이 판매처 기준을 넘어야 결제로 넘어간다."""
    if result.status != 'ok':
        return result
    payload = result.payload
    if not payload.get('card'):
        return AgentResult(
            status='fail',
            reason='감독자 검사: 결제할 카드가 정해지지 않았다',
            fail_reason=FailReason.CARD_MISSING,
            payload=payload,
            evidence=result.evidence,
        )
    margin = payload.get('margin_pct')
    if not margin_ok(margin, seller):
        floor = f'{POISON_MARGIN_MIN:g}% 이상' if is_poison_seller(seller) else '0% 초과'
        return AgentResult(
            status='fail',
            reason=f'감독자 검사: 마진 미달({margin}, 기준 {floor})',
            fail_reason=FailReason.MARGIN,
            payload=payload,
            evidence=result.evidence,
        )
    return result
