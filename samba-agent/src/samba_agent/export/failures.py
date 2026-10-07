"""외부 기입 실패 사유 — 알림·집계가 흔들리지 않게 코드로 고정한다."""

from enum import StrEnum


class ExportFail(StrEnum):
    """입력 작업자가 남길 수 있는 실패 사유. 이 목록 밖의 값은 쓰지 않는다."""

    # 다시 하면 풀릴 수 있는 사유 — 큐가 시간을 두고 다시 집는다
    WINDOW_MISSING = 'window_missing'  # 프로그램 창이 없다
    BUSY = 'busy'  # 사람이 그 창을 쓰는 중이다
    TIMEOUT = 'timeout'  # 화면이 제때 반응하지 않았다
    BLOCKED = 'blocked'  # 인증·오류 대화상자가 떠 있다(건드리지 않는다)
    # 사람이 인증해야 한다(추가인증·로그인 창) — 건드리지 않고 알린 뒤 기다린다. 시도 횟수에 넣지 않는다
    AUTH_REQUIRED = 'auth_required'
    # 다시 해도 같은 답이 나오는 사유 — 사람이 본다
    NOT_FOUND = 'not_found'  # 그 주문번호가 없다
    AMBIGUOUS = 'ambiguous'  # 검색 결과가 1건이 아니다
    VALUE_CONFLICT = 'value_conflict'  # 이미 다른 값이 들어 있다
    VERIFY_MISMATCH = 'verify_mismatch'  # 입력 뒤 되읽은 값이 다르다
    EXCHANGE_ORDER = (
        'exchange_order'  # 교환주문 행이다 — 입력하지 않는다(원주문에 입력, 사용자 2026-10-07)
    )
    UNKNOWN = 'unknown'
