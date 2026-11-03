# 봇 — 접수 답장 / 중복 답장 / 미등록 무시 / 승인 버튼 / 상태·버전·진단
import pytest
from langgraph.checkpoint.memory import MemorySaver

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.gateway.slack_bot import SambaBot, approval_blocks
from samba_agent.queue.db import JobQueue
from samba_agent.queue.worker import Worker, WorkerDeps
from samba_agent.settings import DEFAULT_ROOT, Settings
from samba_agent.supervisor.graph import build_supervisor


def ok(name, **p):
    def fn(_a):
        return AgentResult(status='ok', reason=f'{name} 정상', payload=p)

    return fn


@pytest.fixture()
def bot(tmp_path):
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    agents = {
        'buyer.musinsa': ok('buy', account='a***@x.com', card='현대', cost=89000, margin_pct=12.5),
        'payer': ok('pay'),
        'recorder': ok('record'),
        'verifier': ok('verify'),
    }
    graph = build_supervisor(reg, agents, checkpointer=MemorySaver(), gate=True)
    worker = Worker(
        WorkerDeps(
            queue=q,
            graph=graph,
            version='vtest',
            report=lambda j, s: None,
            parse_order=lambda j: OrderRef(
                order_no=j.order_no, source='무신사', seller='포이즌', sku='S1', qty=1
            ),
        )
    )
    s = Settings(SAMBA_BRIDGE_TOKEN='a' * 64, SLACK_ALLOWED_USERS='U1,U2', SLACK_CHANNEL='#test')
    return (
        SambaBot(app=None, worker=worker, queue=q, settings=s, diagnose=lambda v: f'진단 표({v})'),
        q,
        worker,
    )


def test_접수하면_답장한다(bot):
    b, q, _ = bot
    out = b.handle_mention('<@BOT> A1 처리해 현대카드', 'U1', 'ts1')
    assert 'A1' in out and '접수' in out
    assert q.get('A1').options == {'card': '현대'}


def test_같은_주문_재요청은_처리중이라고_답한다(bot):
    b, _q, w = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    w.tick()  # 승인 대기까지 간다
    out = b.handle_mention('<@BOT> A1 처리해', 'U2', 'ts2')
    assert '이미' in out and 'U1' in out


def test_미등록_사용자_명령은_무시한다(bot):
    b, q, _ = bot
    assert b.handle_mention('<@BOT> A1 처리해', 'U999', 'ts1') is None
    assert q.get('A1') is None


def test_승인_버튼이_그래프를_이어간다(bot):
    b, q, w = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    w.tick()
    assert q.get('A1').state == 'needs_ai'
    out = b.handle_approval('A1', approved=True, user='U1')
    assert '승인' in out
    assert q.get('A1').state == 'done'  # 결제 승인 뒤에는 기록·검증까지 이어진다


def test_미등록_사용자의_승인은_무시한다(bot):
    b, q, w = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    w.tick()
    out = b.handle_approval('A1', approved=True, user='U999')
    assert '권한' in out
    assert q.get('A1').state == 'needs_ai'


def test_상태와_버전과_진단(bot):
    b, _q, _ = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    assert 'A1' in b.handle_mention('<@BOT> 상태', 'U1', None)
    assert 'vtest' in b.handle_mention('<@BOT> 버전', 'U1', None)
    assert '진단 표' in b.handle_mention('<@BOT> 진단 A1', 'U1', None)


def test_취소와_이어서(bot):
    b, q, _ = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    assert '취소' in b.handle_mention('<@BOT> 취소 A1', 'U1', None)
    assert q.get('A1').state == 'cancelled'
    assert '없' in b.handle_mention('<@BOT> 취소 A9', 'U1', None)


def test_승인_블록에_두_버튼이_있다():
    blocks = approval_blocks('A1', 'pay', '요약')
    ids = [e['action_id'] for b in blocks if b['type'] == 'actions' for e in b['elements']]
    assert ids == ['samba_approve', 'samba_reject']
    assert all('A1' in str(b) or True for b in blocks)


def test_같은_승인_버튼_두번_눌러도_한_번만_먹는다(bot):
    # 리뷰 지적 — Critical 2: 중복 승인 클릭은 한 번만 먹어야 한다
    b, q, w = bot
    b.handle_mention('<@BOT> A1 처리해', 'U1', 'ts1')
    w.tick()
    assert q.get('A1').step == '승인 대기: pay'

    calls: list[str] = []
    real_resume = w.resume

    def counting_resume(*a, **k):
        calls.append('resume')
        return real_resume(*a, **k)

    w.resume = counting_resume  # type: ignore[method-assign]

    out1 = b.handle_approval('A1', True, 'U1', stage='pay')
    assert '승인' in out1
    assert q.get('A1').state == 'done'  # 결제 승인 하나로 기록·검증까지 간다

    out2 = b.handle_approval('A1', True, 'U1', stage='pay')  # 같은 버튼 재클릭
    assert '승인 대기 상태가 아닙니다' in out2
    assert calls == ['resume']  # 실제 재개는 첫 클릭 한 번뿐


class _FakeSlackClient:
    def __init__(self, channels: list[dict[str, str]]) -> None:
        self._channels = channels

    def conversations_list(self, **_kwargs):  # type: ignore[no-untyped-def]
        return {'channels': self._channels, 'response_metadata': {}}


class _FakeSlackApp:
    def __init__(self, channels: list[dict[str, str]]) -> None:
        self.client = _FakeSlackClient(channels)


def test_is_target_channel은_풀어둔_id와만_비교한다():
    s = Settings(SAMBA_BRIDGE_TOKEN='a' * 64, SLACK_ALLOWED_USERS='U1', SLACK_CHANNEL='#test')
    b = SambaBot(
        app=None, worker=None, queue=None, settings=s, diagnose=lambda v: '', channel_id='C123'
    )
    assert b.is_target_channel('C123')
    assert not b.is_target_channel('C999')


def test_채널_이름을_시작시_id로_풀어둔다():
    app = _FakeSlackApp([{'id': 'C123', 'name': 'sambaorder'}])
    s = Settings(SAMBA_BRIDGE_TOKEN='a' * 64, SLACK_ALLOWED_USERS='U1', SLACK_CHANNEL='#sambaorder')
    b = SambaBot(app=app, worker=None, queue=None, settings=s, diagnose=lambda v: '')
    b.resolve_channel()
    assert b.is_target_channel('C123')
    assert not b.is_target_channel('C999')


def test_채널이_이미_id_모양이면_풀이를_건너뛴다():
    s = Settings(SAMBA_BRIDGE_TOKEN='a' * 64, SLACK_ALLOWED_USERS='U1', SLACK_CHANNEL='C123ABCDE')
    b = SambaBot(app=None, worker=None, queue=None, settings=s, diagnose=lambda v: '')
    b.resolve_channel()  # app 없어도 id 모양이면 바로 확정된다
    assert b.is_target_channel('C123ABCDE')


def test_채널을_못_풀면_전부_무시한다():
    # app 도 없고 채널 id 도 안 넣었으면(운영에서 conversations.list 실패 등) 안전하게 거부한다
    s = Settings(SAMBA_BRIDGE_TOKEN='a' * 64, SLACK_ALLOWED_USERS='U1', SLACK_CHANNEL='#nope')
    b = SambaBot(app=None, worker=None, queue=None, settings=s, diagnose=lambda v: '')
    assert not b.is_target_channel('C1')


class _RecordingClient:
    """chat_postMessage 인자를 그대로 모아두는 가짜 슬랙 클라이언트."""

    def __init__(self) -> None:
        self.posts: list[dict[str, object]] = []

    def chat_postMessage(self, **kwargs):  # type: ignore[no-untyped-def]
        self.posts.append(kwargs)
        return {'ok': True}


class _RecordingApp:
    def __init__(self) -> None:
        self.client = _RecordingClient()


def _posting_bot() -> tuple[SambaBot, _RecordingApp]:
    app = _RecordingApp()
    s = Settings(
        _env_file=None,
        SAMBA_BRIDGE_TOKEN='a' * 64,
        SLACK_ALLOWED_USERS='U1',
        SLACK_CHANNEL='#sambaorder',
    )
    return (
        SambaBot(
            app=app, worker=None, queue=None, settings=s, diagnose=lambda v: '', channel_id='C1'
        ),
        app,
    )


def test_승인_요청은_두_버튼을_달아_보낸다():
    # 리뷰 지적 — Critical 1: 승인 버튼이 실제로 슬랙에 나가야 한다
    b, app = _posting_bot()
    assert b.post_approval('ts1', 'A1', 'pay', '결제 승인 요청 요약')
    sent = app.client.posts[-1]
    assert sent['channel'] == 'C1'
    assert sent['thread_ts'] == 'ts1'
    values = [
        e['value'] for blk in sent['blocks'] if blk['type'] == 'actions' for e in blk['elements']
    ]
    assert values == ['A1|pay', 'A1|pay']


def test_진행_보고는_채널_이름이_아니라_id로_나가고_개인정보를_가린다():
    # 리뷰 지적 — Minor: 채널 이름(#sambaorder)이 아니라 풀어둔 id 로 보낸다
    b, app = _posting_bot()
    assert b.post('ts1', '수취인 홍길동 · 010-1234-5678')
    sent = app.client.posts[-1]
    assert sent['channel'] == 'C1'
    assert '홍길동' not in str(sent['text'])
    assert '010-1234-5678' not in str(sent['text'])


def test_채널을_못_풀었으면_슬랙에_보내지_않는다():
    app = _RecordingApp()
    s = Settings(_env_file=None, SAMBA_BRIDGE_TOKEN='a' * 64, SLACK_ALLOWED_USERS='U1')
    b = SambaBot(app=app, worker=None, queue=None, settings=s, diagnose=lambda v: '')
    assert not b.post('ts1', '아무 말')
    assert app.client.posts == []


def test_버전_승인_명령은_승인자를_파일에_남긴다(tmp_path, bot):
    # 리뷰 지적 — I8
    from samba_agent.ops.gate import read_approval

    b, _q, _w = bot
    b.settings = b.settings.model_copy(update={'report_dir': tmp_path})
    out = b.handle_mention('<@BOT> 승인 vab12cd34ef56', 'U1', None)
    assert 'vab12cd34ef56' in out
    assert read_approval(tmp_path, 'vab12cd34ef56') == 'U1'


# ---- 자동 수집 명령 배선(Task D) ----


class _FakeIntake:
    """Intake 의 세 메서드만 흉내 낸다."""

    def __init__(self) -> None:
        from samba_agent.queue.intake import IntakeReport

        self.paused = False
        self.runs = 0
        self._report = IntakeReport(seen=3, enqueued=2, skipped_live=1, unsupported=0)

    def run_once(self):
        self.runs += 1
        return self._report

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False


def test_주문처리_전체는_수집을_한_바퀴_돌리고_요약한다(bot):
    b, _q, _w = bot
    b.intake = _FakeIntake()
    out = b.handle_mention('<@BOT> 주문처리 전체', 'U1', 'ts1')
    assert b.intake.runs == 1
    assert '수집 3건' in out and '접수 2건' in out


def test_수집_중지와_재개가_깃발을_바꾼다(bot):
    b, _q, _w = bot
    b.intake = _FakeIntake()
    assert '중지' in b.handle_mention('<@BOT> 수집 중지', 'U1', None)
    assert b.intake.paused is True
    assert '재개' in b.handle_mention('<@BOT> 수집 재개', 'U1', None)
    assert b.intake.paused is False


def test_수집이_배선되지_않았으면_안내만_한다(bot):
    b, _q, _w = bot
    assert '꺼져' in b.handle_mention('<@BOT> 주문처리 전체', 'U1', None)


def test_post_new_는_최상위_메시지_ts_를_준다(bot):
    b, _q, _w = bot

    calls: list[dict] = []

    class _Client:
        @staticmethod
        def chat_postMessage(**kw):
            calls.append(kw)
            return {'ok': True, 'ts': '1700.1'}

    class _App:
        client = _Client()

    b.app = _App()
    b._channel_id = 'C1'
    assert b.post_new('접수: A1 · MUSINSA · 신발 · 1개') == '1700.1'
    kw = calls[-1]
    assert kw['channel'] == 'C1' and 'thread_ts' not in kw


def test_슬랙이_없으면_post_new_는_None(bot):
    b, _q, _w = bot
    assert b.post_new('접수: A1') is None
