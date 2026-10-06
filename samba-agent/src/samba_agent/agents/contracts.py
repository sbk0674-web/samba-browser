"""에이전트 공통 계약(스펙 §4.3).

입력은 Assignment, 출력은 AgentResult 하나뿐이다 — 감독자는 이 둘만 본다.
모든 판단에 reason 을 요구한다. 채점기와 진단 표가 이 문장을 읽는다.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from samba_agent.failures import FailReason


class OrderRef(BaseModel):
    """처리 대상 주문. 고객 개인정보는 담지 않는다 — 마스킹 대상 자체를 안 들인다."""

    order_no: str
    # 삼바웨이브 주문 행 id(ord_…). 한 상품주문번호에 행이 여럿일 수 있어(사이즈 2개) 조회·기입은 이 id 로 한다.
    # 앱 저장 스크립트로 찾은 주문(옛 경로)은 None
    wave_id: str | None = None
    source: str  # 소싱처: 무신사 · 29CM · ABC마트 · 롯데온
    seller: str  # 판매처: 포이즌 등
    sku: str
    qty: int = Field(default=1, gt=0)  # 0 이하 수량은 애초에 만들 수 없다
    # 옵션(사이즈·색상). 스냅샷 스크립트의 size 인자로 넘긴다 — sku 문자열에서 다시 뽑지 않는다
    option: str | None = None
    # 마켓 주문의 원래 옵션 글자 — option 을 등록 매칭(소싱처 옵션 이름)으로 바꿨을 때만 남는다(근거·표시용)
    market_option: str | None = None
    # 소싱처 상품 페이지(삼바웨이브 '원문링크'). 있으면 판매 상품명으로 검색하지 않고 이 상품을 바로 연다
    # (실기: 판매처 상품명을 ABC마트 검색어로 써서 검색 결과 페이지에서 '품절'로 오판)
    product_url: str | None = None
    # 소싱처 로그인 계정(아이디). 삼바웨이브 '주문계정'(예: "ABCmart · 사무(buyer01)")의 괄호 안 값
    account: str | None = None
    # 소싱 계정의 삼바웨이브 내부 id. 기록이 이 값을 그대로 되돌려 준다(표시용 아이디와 다르다)
    account_id: str | None = None
    # 주문 종류 — 까대기는 사무실로 받고, 선물하기는 배송지 입력 흐름이 다르다.
    # 배송지 자체는 여기 담지 않는다(개인정보) — 실행 순간에만 받아 쓴다
    order_type: Literal['direct', 'kkadaegi', 'gift'] = 'direct'
    # 판매가(고객 결제액 = SAMBA 매출). 스냅샷이 마진을 안 주면 원가와 이 값으로 계산한다. 0 이면 모름
    sale_price: float = 0
    # SAMBA 정산금(판매처 수수료를 뺀 금액). 있으면 마진율 = (정산금 − 원가) ÷ 매출 × 100. 0 이면 모름
    revenue: float = 0
    # 삼바웨이브 플래그(action_tag 토큰, 소문자) — 가격X·재고X·직원A 등. 오류일 수 있어 제외하지 않고
    # 결제 승인 요약에 표시해 사람이 검토한다
    flags: tuple[str, ...] = ()

    @property
    def wave_key(self) -> str:
        """삼바웨이브 내부 API 를 부를 때 쓰는 주문 키 — 행 id 가 있으면 그것, 없으면 상품주문번호."""
        return self.wave_id or self.order_no


class Evidence(BaseModel):
    """판단의 근거 조각(화면 문구·금액·주문번호). 진단과 검수 큐가 본다."""

    label: str
    detail: str


class Assignment(BaseModel):
    """감독자 → 에이전트. allowed_tools 밖의 도구는 브릿지 클라이언트가 거절한다."""

    order: OrderRef
    options: dict[str, str] = Field(default_factory=dict)
    account_candidates: tuple[str, ...] = ()
    evidence_so_far: tuple[Evidence, ...] = ()
    allowed_tools: tuple[str, ...]
    rules: str
    # True 면 외부를 바꾸는 도구(결제·기록)를 부르지 않고 계획만 돌려준다
    dry_run: bool = True
    # dry_run 에서 결제 비밀번호를 몇 자리만 눌러 보고 취소할지(0 이면 결제창까지만).
    # 결제는 어느 값에서도 끝내지 않는다 — 키패드 자동 입력이 실기에서 되는지만 본다
    dry_run_digits: int = Field(default=0, ge=0, le=3)
    # 감독자가 아는 기대값(소싱주문번호·실구매가·배송비·플래그). 기록·검증이 '대조' 에 쓴다 —
    # 검증 에이전트가 이 키를 전부 소싱처·SAMBA 행과 맞춰보므로 대조 대상만 담는다
    expected: dict[str, object] = Field(default_factory=dict)
    # 앞 단계 에이전트가 넘긴 인계값(카드·원가·마진·계정·소싱주문번호). 대조 대상이 아니라
    # '다음 단계가 일을 하려면 필요한 값' 이다(리뷰 지적 — C3·I1·I2)
    handoff: dict[str, object] = Field(default_factory=dict)


class AgentResult(BaseModel):
    """에이전트 → 감독자. 이 모양 말고는 아무것도 돌려주지 않는다."""

    status: Literal['ok', 'fail', 'needs_human']
    payload: dict[str, object] = Field(default_factory=dict)
    reason: str = Field(min_length=1)
    fail_reason: FailReason | None = None
    evidence: tuple[Evidence, ...] = ()

    @model_validator(mode='after')
    def _check_fail_reason(self) -> 'AgentResult':
        """실패·사람 넘김에는 사유가 반드시 있고, 성공에는 없어야 한다."""
        if self.status == 'ok' and self.fail_reason is not None:
            raise ValueError('성공 결과에 fail_reason 이 있다')
        if self.status != 'ok' and self.fail_reason is None:
            raise ValueError('실패·사람 넘김에는 fail_reason 이 필요하다')
        return self
