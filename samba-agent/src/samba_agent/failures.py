"""실패 사유 enum — 진단 표가 안정되도록 코드로 고정한다(스펙 §4.5 3단계)."""

from enum import StrEnum


class FailReason(StrEnum):
    """에이전트가 돌려줄 수 있는 실패 사유. 이 목록 밖의 값은 쓰지 않는다."""

    OUT_OF_STOCK = 'out_of_stock'  # 품절·옵션 없음
    MARGIN = 'margin'  # 마진 미달
    CARD_MISSING = 'card_missing'  # 지정 카드가 결제수단에 없음
    CAPTCHA = 'captcha'  # 캡차·2단계 인증 — 사람에게 넘긴다
    BRIDGE_DOWN = 'bridge_down'  # 앱 꺼짐·연결 실패·계속 busy
    PERMISSION_DENIED = 'permission_denied'  # 허용 목록 밖 도구·토큰 오류·키마스터 잠김
    DUPLICATE = 'duplicate'  # 이미 처리된 주문
    VERIFY_MISMATCH = 'verify_mismatch'  # 대조 불일치
    # 결제 진행 중 재시작·재진입 — 재결제를 막고 사람이 결제 여부를 확인해야 한다
    PAY_INTERRUPTED = 'pay_interrupted'
    # 한 작업이 시간 상한(SAMBA_JOB_MAX_MINUTES)을 넘겼다 — 결제 전 단계에서만 쓴다. 자동 재접수 대상이 아니다
    TIMEOUT = 'timeout'
    UNKNOWN = 'unknown'
