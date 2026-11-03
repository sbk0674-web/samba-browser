"""운영 감시 — 슬랙 알림 규칙 3종(스펙 §4.5 4단계). 자동 롤백은 하지 않는다.

판정(`check_alerts`)과 전송은 분리돼 있다 — 여기서는 규칙이 터졌는지만 순수하게
계산하고, 슬랙으로 실제 보내는 것은 호출부가 주입한 전송 함수가 한다. 전송이
실패해도(네트워크 등) 이미 계산된 판정 결과에는 영향이 없다.
"""

from collections.abc import Mapping

ALERT_RULES = ('fail_rate_2x', 'needs_ai_30pct', 'duration_50pct')
NEEDS_HUMAN_LIMIT = 0.30
DURATION_LIMIT = 1.50


def check_alerts(today: Mapping[str, float], yesterday: Mapping[str, float]) -> list[str]:
    """터진 규칙 이름들. 봇이 진단 표를 붙여 슬랙에 올린다.

    세 규칙 모두 경계 연산자를 "초과"(`>`) 로 통일한다 — 정확히 경계값(2배·30%·50%)에
    걸친 경우는 알리지 않는다.
    """
    fired: list[str] = []
    prev_fail = float(yesterday.get('fail_rate', 0))
    if prev_fail > 0 and float(today.get('fail_rate', 0)) > prev_fail * 2:
        fired.append('fail_rate_2x')
    if float(today.get('needs_ai_rate', 0)) > NEEDS_HUMAN_LIMIT:
        fired.append('needs_ai_30pct')
    prev_ms = float(yesterday.get('avg_duration_ms', 0))
    if prev_ms > 0 and float(today.get('avg_duration_ms', 0)) > prev_ms * DURATION_LIMIT:
        fired.append('duration_50pct')
    return fired
