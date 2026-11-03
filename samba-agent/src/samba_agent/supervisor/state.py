"""감독자 그래프의 상태. 비밀값은 절대 여기 담지 않는다."""

import re
from typing import Literal, TypedDict

from samba_agent.agents.contracts import AgentResult, Evidence, OrderRef
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_value

Stage = Literal['buy', 'pay', 'record', 'verify', 'done']
Outcome = Literal['done', 'failed', 'needs_ai', 'cancelled']

# 애초에 state/체크포인트/승인 요약에 담기면 안 되는 키 — 있으면 저장을 거부한다
# 단어 경계로 본다 — 'pin' 을 부분 문자열로 찾으면 'shipping_set' 이 걸려 정상 구매 결과가 거부됐다(실기)
_SECRET_KEY_PATTERN = re.compile(
    r'(^|[_\-.])(password|passwd|secret|token|card_number|cardno|cvc|cvv|pin)([_\-.]|$)',
    re.IGNORECASE,
)

# 마스킹을 거치지 않는 키 — 우리 내부 판매 계정 식별자다. ops.masking 이 가리는 것은
# 고객의 이름·전화·주소·이메일이고, 이 값은 그 대상이 아니다. 여기서 가려 버리면
# 이메일 꼴 계정이 '***' 가 되어 기록 에이전트가 빈 계정을 저장한다(리뷰 지적 — I1).
# 슬랙·LangSmith 로 나갈 때는 발신 경계(SambaBot.post·ops.tracing)에서 다시 가려진다.
INTERNAL_ID_KEYS = ('account',)


def sanitize_payload(payload: dict[str, object]) -> dict[str, object]:
    """state/체크포인트/승인 요약에 담기 전에 payload 를 가린다.

    비밀·카드번호류 키가 섞여 있으면(모델·브릿지가 실수로 돌려준 경우) 조용히 가리지
    않고 ValueError 로 거부한다 — 이름·전화·주소·이메일만 mask_value 로 가리고
    주문·금액·근거(카드 브랜드명 등)는 그대로 남긴다.
    """
    for key in payload:
        if _SECRET_KEY_PATTERN.search(key):
            raise ValueError(f'payload 에 비밀·카드 정보로 보이는 키가 있다: {key}')
    masked = mask_value({k: v for k, v in payload.items() if k not in INTERNAL_ID_KEYS})
    assert isinstance(masked, dict)  # mask_value(dict) 는 항상 dict 를 돌려준다
    return {**masked, **{k: payload[k] for k in INTERNAL_ID_KEYS if k in payload}}


def sanitize_result(result: AgentResult) -> AgentResult:
    """AgentResult 를 state 에 저장하기 전에 payload 만 sanitize_payload 로 가린다."""
    if not result.payload:
        return result
    return result.model_copy(update={'payload': sanitize_payload(result.payload)})


class RunState(TypedDict, total=False):
    """실행 1건의 상태. LangGraph 체크포인트에 그대로 저장된다."""

    order: OrderRef
    options: dict[str, str]
    job_id: int
    dry_run: bool
    # dry-run 결제 비밀번호 시험 입력 자리수(0 이면 결제창까지만)
    dry_run_digits: int
    stage: Stage
    results: dict[str, AgentResult]
    attempts: dict[str, int]
    evidence: list[Evidence]
    outcome: Outcome | None
    fail_reason: FailReason | None
    approvals: dict[str, str]
    # 결제 노드에 들어갔다는 표시 — 재시작·재진입 시 재결제를 막는다(스펙 §6)
    pay_started: bool
