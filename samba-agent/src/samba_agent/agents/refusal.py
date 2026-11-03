"""앱의 `refused: …` 응답을 실패 사유로 옮긴다(리뷰 지적 — I5).

앱 도구는 거절을 HTTP 오류가 아니라 200 + `refused: <사유>` 문자열로 돌려준다
(docs/bridge.md · src/main/agent/tools.ts · tools-phone.ts). 이걸 그대로 성공으로 읽으면
키마스터가 잠겨 있어도, 읽기 전용 모드여도 에이전트가 다음 단계로 넘어간다.

사유 이름은 앱과 단일 소스다 — 결제 쪽은 `PayFailReason`(src/main/phone/pay.ts) 값을 쓴다.
"""

from typing import Literal

from samba_agent.failures import FailReason

REFUSED_PREFIX = 'refused:'

# 시험 입력(dry-run)으로 결제 비밀번호를 일부만 누르고 취소했다 — 실패가 아니라 "결제하지 않음" 이다.
# 앱은 이것도 `refused: …` 로 돌려주므로(phone: dry-run, 웹 키패드: DRY_RUN) 여기서 정상 응답으로 통과시킨다
DRY_RUN_REFUSALS = ('dry-run', 'dry_run')

# 카드 자체가 없다 — 시작 전 카드 누락과 같은 사유로 묶는다
CARD_REFUSALS = ('card-required', 'card-not-found')

# 금고가 잠겨 비밀값을 만질 수 없다 — 다시 해도 같다. 사람이 금고를 열어야 한다
VAULT_LOCKED_REFUSALS = ('vault-locked',)

# 결제 앱이 멈춘 자리(PayFailReason) — 재결제 위험이 있어 재시도 없이 사람에게 넘긴다.
# unknown 으로 남기면 감시/수리 루프가 "일시 오류"처럼 다시 넣을 수 있어 결제 중복 위험이 생긴다.
PAY_REFUSALS = (
    'declined',
    'password-failed',
    'password-ambiguous',
    'layout-incomplete',
    'verify-failed',
    'stuck',
    'no-account',
    'no-phone',
    'pay-account-ambiguous',
    'pay-account-mismatch',
    'bad-amount',
    'failed',
    'user declined',
    '거절',
)

# 비밀 화면·결제 키패드 — 앱이 사람에게 넘긴 자리다
SECRET_SCREEN_REFUSALS = (
    'secret screen',
    'cannot read the phone screen',
    'payment keypad',
    'already entered the payment password',
)

# 접근 정책·호스트·모드 — 코드가 아무리 다시 해도 같은 답이다
PERMISSION_REFUSALS = (
    'keymaster access policy',
    'host is excluded',
    'host excluded',
    'host_mismatch',
    'host must match',
    'read-only mode',
    'insecure page',
    'no saved script',
    'saved scripts are off',
    'site memory is off',
    'not a secret input',
    'naverpay_account_',
    'are not available inside run_js',
)

Verdict = tuple[Literal['fail', 'needs_ai'], FailReason]


def classify_refusal(result: str) -> Verdict | None:
    """`refused: …` 이면 (상태, 사유), 아니면 None(정상 응답).

    분류에 없는 거절은 권한 부족으로 본다 — 모르는 거절을 성공으로 읽는 것보다 안전하다.
    """
    text = result.strip()
    if not text.lower().startswith(REFUSED_PREFIX):
        return None
    body = text[len(REFUSED_PREFIX) :].strip().lower()
    # 시험 입력은 거절이 아니다 — 부르는 쪽이 문자열을 그대로 보고 판단한다
    if any(body.startswith(m) for m in DRY_RUN_REFUSALS):
        return None
    if any(body.startswith(m) for m in CARD_REFUSALS):
        return 'fail', FailReason.CARD_MISSING
    if any(body.startswith(m) for m in VAULT_LOCKED_REFUSALS):
        return 'needs_ai', FailReason.PERMISSION_DENIED
    if any(m in body for m in SECRET_SCREEN_REFUSALS):
        return 'needs_ai', FailReason.CAPTCHA
    if any(body.startswith(m) or m in body for m in PAY_REFUSALS):
        return 'needs_ai', FailReason.PAY_INTERRUPTED
    if any(m in body for m in PERMISSION_REFUSALS):
        return 'fail', FailReason.PERMISSION_DENIED
    return 'fail', FailReason.PERMISSION_DENIED
