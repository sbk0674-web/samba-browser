# 진단 표 — 에이전트별 실패율 / 상위 사유 / 재시도 / 소요 / 직전 대비 / 빈 기간
import pytest

from samba_agent.ops.diagnose import diagnose, main
from samba_agent.ops.events import EventLog


@pytest.fixture()
def events(tmp_path) -> EventLog:
    log = EventLog(tmp_path / 'events.sqlite')
    for i in range(8):
        log.write(
            job_id=i,
            version='v1',
            env='prod',
            agent='buyer.musinsa',
            kind='agent',
            payload={'ok': True, 'duration_ms': 1000 + i, 'status': 'ok'},
        )
    for i in range(2):
        log.write(
            job_id=100 + i,
            version='v1',
            env='prod',
            agent='buyer.musinsa',
            kind='agent',
            payload={
                'ok': False,
                'duration_ms': 5000,
                'status': 'fail',
                'fail_reason': 'out_of_stock',
                'retries': 1,
                'link': f'https://smith/{i}',
            },
        )
    log.write(
        job_id=200,
        version='v1',
        env='prod',
        agent='payer',
        kind='agent',
        payload={
            'ok': False,
            'duration_ms': 3000,
            'status': 'needs_ai',
            'fail_reason': 'captcha',
        },
    )
    return log


def test_에이전트별_실패율과_상위_사유(events):
    d = diagnose(events, version='v1', since_days=7)
    buyer = next(r for r in d.rows if r.agent == 'buyer.musinsa')
    assert buyer.runs == 10
    assert buyer.failures == 2
    assert buyer.fail_rate == pytest.approx(0.2)
    assert buyer.top_reason == 'out_of_stock'
    assert buyer.retries == 2  # 실패 2건, 각 retries=1 의 합
    assert buyer.example_links  # 실패 예시 링크가 있다


def test_결제_에이전트_줄도_나온다(events):
    d = diagnose(events, version='v1', since_days=7)
    payer = next(r for r in d.rows if r.agent == 'payer')
    assert payer.top_reason == 'captcha'


def test_소요_분포가_계산된다(events):
    buyer = next(r for r in diagnose(events, version='v1').rows if r.agent == 'buyer.musinsa')
    assert buyer.p50_ms < buyer.p95_ms


def test_직전_버전_대비_차이(events):
    d = diagnose(events, version='v1', previous={'buyer.musinsa': 0.1})
    buyer = next(r for r in d.rows if r.agent == 'buyer.musinsa')
    assert buyer.delta_vs_prev == pytest.approx(0.1)  # 0.2 - 0.1


def test_검수_큐_미처리가_표에_실린다(events):
    d = diagnose(events, version='v1', review_queue_pending=3)
    assert '검수 큐 미처리: 3' in d.to_markdown()


def test_기록이_없으면_빈_표를_준다(tmp_path):
    d = diagnose(EventLog(tmp_path / 'e.sqlite'), version='v9')
    assert d.rows == ()
    assert '기록 없음' in d.to_markdown()


def test_마크다운_표에_모든_열이_있다(events):
    md = diagnose(events, version='v1').to_markdown()
    for head in ('에이전트', '실행', '실패율', '상위 사유', '재시도', 'p50', 'p95'):
        assert head in md


# --- 추가: 실패 케이스(이벤트 없음 / 손상된 payload / 모르는 사유 값) ---


def test_다른_버전_이벤트만_있으면_빈_표(tmp_path):
    log = EventLog(tmp_path / 'e.sqlite')
    log.write(
        job_id=1,
        version='v0',
        env='prod',
        agent='buyer.musinsa',
        kind='agent',
        payload={'ok': True, 'duration_ms': 100, 'status': 'ok'},
    )
    d = diagnose(log, version='v1')
    assert d.rows == ()


def test_모르는_실패_사유는_unknown으로_집계된다(tmp_path):
    log = EventLog(tmp_path / 'e.sqlite')
    log.write(
        job_id=1,
        version='v1',
        env='prod',
        agent='buyer.musinsa',
        kind='agent',
        payload={
            'ok': False,
            'duration_ms': 100,
            'status': 'fail',
            'fail_reason': 'totally_unknown_value',
        },
    )
    d = diagnose(log, version='v1')
    buyer = next(r for r in d.rows if r.agent == 'buyer.musinsa')
    assert buyer.top_reason == 'unknown'


def test_fail_reason_없는_실패는_unknown으로_집계된다(tmp_path):
    log = EventLog(tmp_path / 'e.sqlite')
    log.write(
        job_id=1,
        version='v1',
        env='prod',
        agent='buyer.musinsa',
        kind='agent',
        payload={'ok': False, 'duration_ms': 100, 'status': 'fail'},
    )
    d = diagnose(log, version='v1')
    buyer = next(r for r in d.rows if r.agent == 'buyer.musinsa')
    assert buyer.top_reason == 'unknown'


def test_kind가_agent가_아니면_집계에서_빠진다(tmp_path):
    log = EventLog(tmp_path / 'e.sqlite')
    log.write(
        job_id=1,
        version='v1',
        env='prod',
        agent='buyer.musinsa',
        kind='tool',
        payload={'ok': True, 'duration_ms': 100},
    )
    d = diagnose(log, version='v1')
    assert d.rows == ()


# --- 추가: (agent, step) 그룹핑 / nearest-rank p50·p95 / --since 파싱 실패 ---


def test_같은_에이전트라도_단계가_다르면_두_줄로_나온다(tmp_path):
    log = EventLog(tmp_path / 'e.sqlite')
    log.write(
        job_id=1,
        version='v1',
        env='prod',
        agent='buyer.musinsa',
        kind='agent',
        payload={'ok': True, 'duration_ms': 100, 'step': 'search'},
    )
    log.write(
        job_id=2,
        version='v1',
        env='prod',
        agent='buyer.musinsa',
        kind='agent',
        payload={'ok': True, 'duration_ms': 200, 'step': 'checkout'},
    )
    d = diagnose(log, version='v1')
    buyer_rows = [r for r in d.rows if r.agent == 'buyer.musinsa']
    assert len(buyer_rows) == 2
    assert {r.step for r in buyer_rows} == {'search', 'checkout'}


def test_p50_p95는_표준_nearest_rank로_계산된다(tmp_path):
    # N=15 (10 의 배수가 아님) — ceil(0.5*15)-1 = 6(0-based, 7번째), ceil(0.95*15)-1 = 13(14번째)
    log = EventLog(tmp_path / 'e.sqlite')
    durations = list(range(1, 16))  # 1..15ms
    for i, dur in enumerate(durations):
        log.write(
            job_id=i,
            version='v1',
            env='prod',
            agent='buyer.musinsa',
            kind='agent',
            payload={'ok': True, 'duration_ms': dur, 'step': 's'},
        )
    d = diagnose(log, version='v1')
    buyer = next(r for r in d.rows if r.agent == 'buyer.musinsa')
    assert buyer.p50_ms == 8  # idx = ceil(0.5*15)-1 = 7(0-based) → durations[7] == 8
    assert buyer.p95_ms == 15  # idx = ceil(0.95*15)-1 = 14(0-based) → durations[14] == 15


def test_main은_잘못된_since_값에_argparse_오류로_끝난다(tmp_path, capsys):
    with pytest.raises(SystemExit) as exc_info:
        main(['--version', 'v1', '--since', 'not-a-number'])
    assert exc_info.value.code != 0
    captured = capsys.readouterr()
    assert 'since' in captured.err
