# 운영 감시 — 실패율 2배 / needs_ai 30% / 평균 소요 +50%. 자동 롤백은 없다
from samba_agent.ops.alerts import ALERT_RULES, check_alerts


def test_실패율이_두_배를_넘으면_알린다():
    got = check_alerts({'fail_rate': 0.21}, {'fail_rate': 0.1})
    assert 'fail_rate_2x' in got


def test_needs_ai_이_30퍼센트를_넘으면_알린다():
    assert 'needs_ai_30pct' in check_alerts({'needs_ai_rate': 0.31}, {})


def test_평균_소요가_50퍼센트_넘게_늘면_알린다():
    assert 'duration_50pct' in check_alerts({'avg_duration_ms': 15001}, {'avg_duration_ms': 10000})


def test_실패율이_정확히_두_배면_경계값이라_알리지_않는다():
    # 경계 연산자는 "초과"(>) 다 — 정확히 2배는 알리지 않는다
    assert check_alerts({'fail_rate': 0.2}, {'fail_rate': 0.1}) == []


def test_needs_ai_이_정확히_30퍼센트면_경계값이라_알리지_않는다():
    assert check_alerts({'needs_ai_rate': 0.30}, {}) == []


def test_평균_소요가_정확히_50퍼센트_늘면_경계값이라_알리지_않는다():
    assert check_alerts({'avg_duration_ms': 15000}, {'avg_duration_ms': 10000}) == []


def test_평온하면_아무것도_알리지_않는다():
    assert (
        check_alerts(
            {'fail_rate': 0.1, 'needs_ai_rate': 0.1, 'avg_duration_ms': 10000},
            {'fail_rate': 0.1, 'needs_ai_rate': 0.1, 'avg_duration_ms': 10000},
        )
        == []
    )


def test_규칙은_세_종이다():
    assert len(ALERT_RULES) == 3


def test_직전값이_0이면_배수_비교를_하지_않는다():
    # 0 → 어떤 값이든 "2배" 판정은 0 나눗셈이 되므로 알리지 않는다
    assert check_alerts({'fail_rate': 0.5}, {'fail_rate': 0.0}) == []
    assert check_alerts({'avg_duration_ms': 5000}, {'avg_duration_ms': 0}) == []


def test_알림_전송_함수가_실패해도_알림_판정_자체는_영향받지_않는다():
    # check_alerts 자체는 순수 판정이다 — 전송은 호출부(슬랙 봇)가 주입된 send 함수로 한다.
    # 여기서는 실패하는 전송 함수를 흉내내 판정과 전송이 분리돼 있음을 확인한다.
    fired = check_alerts({'fail_rate': 0.4}, {'fail_rate': 0.1})

    def failing_send(_message: str) -> None:
        raise RuntimeError('슬랙 전송 실패(네트워크 등) — 판정 결과는 이미 나와 있다')

    assert fired == ['fail_rate_2x']
    try:
        failing_send('\n'.join(fired))
    except RuntimeError:
        pass
    else:  # pragma: no cover
        raise AssertionError('전송 실패를 흉내내는 함수가 실패하지 않았다')
