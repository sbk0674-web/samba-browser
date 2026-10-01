# 진입점 배선 — 승인 요청이 버튼 있는 경로로, 진행 보고가 평문 경로로 나가는지
from samba_agent.__main__ import make_reporters


class _FakeBot:
    """SambaBot 의 발신 두 메서드만 흉내 낸다."""

    def __init__(self, ok: bool = True) -> None:
        self.ok = ok
        self.posts: list[tuple[str | None, str]] = []
        self.approvals: list[tuple[str | None, str, str, str]] = []

    def post(self, thread_ts, text, blocks=None):  # type: ignore[no-untyped-def]
        self.posts.append((thread_ts, text))
        return self.ok

    def post_approval(self, thread_ts, order_no, stage, summary):  # type: ignore[no-untyped-def]
        self.approvals.append((thread_ts, order_no, stage, summary))
        return self.ok


class _Job:
    order_no = 'A1'
    thread_ts = 'ts1'


def test_진입점은_승인_요청을_버튼_경로로_배선한다():
    # 리뷰 지적 — Critical 1
    bot = _FakeBot()
    _report, approval_report = make_reporters(lambda: bot)
    approval_report(_Job(), 'A1', 'pay', '요약')
    assert bot.approvals == [('ts1', 'A1', 'pay', '요약')]
    assert bot.posts == []


def test_진입점의_진행_보고는_평문_경로로_간다():
    bot = _FakeBot()
    report, _ = make_reporters(lambda: bot)
    report(_Job(), '접수: A1')
    assert bot.posts == [('ts1', '접수: A1')]


def test_슬랙이_없으면_보고는_조용히_로그로만_남는다():
    bot = _FakeBot(ok=False)
    report, approval_report = make_reporters(lambda: bot)
    report(_Job(), '접수: A1')  # 예외가 나지 않는다
    approval_report(_Job(), 'A1', 'pay', '요약')


# ---- 삼바웨이브 클라이언트 배선(Task C) ----


def _settings(**env):
    import os

    from samba_agent.settings import load_settings

    keys = {
        'SAMBA_BRIDGE_TOKEN': 'b' * 64,
        'SAMBA_WAVE_URL': 'https://wave.test',
        **env,
    }
    old = {k: os.environ.get(k) for k in keys}
    os.environ.update({k: v for k, v in keys.items() if v is not None})
    for k, v in keys.items():
        if v is None:
            os.environ.pop(k, None)
    try:
        return load_settings(env_file=None)
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_토큰과_테넌트가_다_있어야_삼바웨이브_클라이언트를_만든다():
    from samba_agent.__main__ import make_wave

    assert make_wave(_settings()) is None
    assert make_wave(_settings(SAMBA_WAVE_INTERNAL_TOKEN='t')) is None
    assert make_wave(_settings(SAMBA_WAVE_TENANT_ID='tn')) is None
    wave = make_wave(_settings(SAMBA_WAVE_INTERNAL_TOKEN='t', SAMBA_WAVE_TENANT_ID='tn'))
    assert wave is not None


def test_기본_설정은_창_7일_주기_300초다():
    s = _settings()
    assert (s.intake_days, s.intake_interval_s) == (7, 300)
    assert s.wave_internal_token is None


def test_에이전트_공장이_삼바웨이브를_구매_기록_검증에_꽂는다():
    from samba_agent.agents.buyer import BuyerAgent
    from samba_agent.agents.factory import build_agents
    from samba_agent.agents.recorder import RecorderAgent
    from samba_agent.agents.registry import Registry
    from samba_agent.agents.verifier import VerifierAgent
    from samba_agent.bridge.client import BridgeClient
    from samba_agent.settings import DEFAULT_ROOT
    from samba_agent.wave.client import WaveClient

    wave = WaveClient('https://wave.test', 'test-token', 'tenant-1')
    reg = Registry.load(DEFAULT_ROOT)
    bridge = BridgeClient('http://127.0.0.1:47811', 'a' * 64, allowed=())
    agents = build_agents(reg, bridge, lambda p, m: m(choice='x', reason='r'), wave)
    buyer = agents['buyer.musinsa']
    assert isinstance(buyer, BuyerAgent) and buyer._shipping_fn is not None
    assert isinstance(agents['recorder'], RecorderAgent) and agents['recorder']._wave is wave
    assert isinstance(agents['verifier'], VerifierAgent) and agents['verifier']._wave is wave
    # 꽂지 않으면 예전 경로(앱 저장 스크립트) 그대로다
    plain = build_agents(reg, bridge, lambda p, m: m(choice='x', reason='r'))
    assert plain['recorder']._wave is None
    assert plain['buyer.musinsa']._shipping_fn is None


def test_배송_연락처_설정은_없다():
    # 사용자 결정(2026-09-23): 배송 연락처는 앱 키마스터 신원정보 — .env 에 번호를 두지 않는다
    s = _settings(SAMBA_SHIP_PHONE='010-0000-0000')
    assert not hasattr(s, 'ship_phone')
    assert '0000-0000' not in s.model_dump_json()


# ---- 자동 수집 배선(Task D) ----


def test_자동_수집은_기본으로_켜져_있고_끌_수_있다():
    assert _settings().intake_enabled is True
    assert _settings(SAMBA_INTAKE_ENABLED='false').intake_enabled is False


class _BrokenBot:
    """네트워크가 끊겨 슬랙 호출이 예외를 던지는 봇."""

    def post(self, thread_ts, text, blocks=None):  # type: ignore[no-untyped-def]
        raise OSError('getaddrinfo failed')

    def post_approval(self, thread_ts, order_no, stage, summary):  # type: ignore[no-untyped-def]
        raise OSError('getaddrinfo failed')


def test_슬랙_전송_예외는_작업을_죽이지_않는다():
    # 2026-10-01 DNS 끊김 — 보고 예외로 running 작업이 고아가 돼 큐가 멈췄다
    report, approval_report = make_reporters(lambda: _BrokenBot())
    report(_Job(), '접수: A1')
    approval_report(_Job(), 'A1', 'pay', '요약')
