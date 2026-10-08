# 자동 수집 — 중복 거절 / 미지원 소싱처 / 일시정지 / 삼바웨이브 오류 / 오래된 것부터
from datetime import UTC, datetime, timedelta

import pytest

from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.queue.db import JobQueue
from samba_agent.queue.intake import Intake, intake_line
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.wave.client import WaveError, WaveOrder

NOW = datetime(2026, 9, 23, 9, 0, tzinfo=UTC)


def wave_order(order_no: str, *, source: str = 'MUSINSA', minutes: int = 0, **over) -> WaveOrder:
    """미이행 주문 1건. 개인정보는 애초에 이 모델에 없다."""
    return WaveOrder(
        order_number=order_no,
        source_site=source,
        product_name=over.pop('product_name', '나이키 덩크 로우'),
        product_option=over.pop('product_option', '270'),
        quantity=over.pop('quantity', 1),
        paid_at=NOW - timedelta(minutes=minutes),
        **over,
    )


class _FakeWave:
    """WaveClient 중 intake 가 쓰는 메서드 하나만 흉내 낸다."""

    def __init__(self, orders, error: WaveError | None = None) -> None:
        self.orders = orders
        self.error = error
        self.calls: list[int] = []

    def pending_orders(self, days: int = 7, limit: int = 100):
        self.calls.append(days)
        if self.error is not None:
            raise self.error
        return list(self.orders)


class _Slack:
    """post_new / post 두 통로만 기록한다."""

    def __init__(self, ts: str | None = 'ts') -> None:
        self._ts = ts
        self.tops: list[str] = []
        self.lines: list[tuple[str | None, str]] = []
        self._n = 0

    def post_new(self, text: str) -> str | None:
        self.tops.append(text)
        self._n += 1
        return f'{self._ts}{self._n}' if self._ts else None

    def post_line(self, thread_ts, text) -> bool:
        self.lines.append((thread_ts, text))
        return True


@pytest.fixture()
def setup(tmp_path):
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()

    def make(orders, error=None, days=7):
        wave = _FakeWave(orders, error)
        return (
            Intake(wave, q, reg, slack.post_new, slack.post_line, days=days),
            wave,
        )

    return q, slack, make


def test_새_주문마다_최상위_메시지_하나와_큐_한_행(setup):
    q, slack, make = setup
    intake, wave = make([wave_order('A1'), wave_order('A2')])
    report = intake.run_once()
    assert (report.seen, report.enqueued, report.unsupported) == (2, 2, 0)
    assert wave.calls == [7]
    assert len(slack.tops) == 2
    assert slack.tops[0].startswith('접수: A1 · MUSINSA · 나이키 덩크 로우 [270] · 1개')
    assert q.get('A1').thread_ts == 'ts1'
    assert q.get('A1').requester == 'intake'
    assert q.get('A2').state == 'queued'


def test_이미_큐에_살아있는_주문은_건너뛴다(setup):
    q, slack, make = setup
    q.enqueue('A1', 'U1', {}, 'ts0')
    intake, _w = make([wave_order('A1'), wave_order('A2')])
    report = intake.run_once()
    assert (report.seen, report.enqueued, report.skipped_live) == (2, 1, 1)
    assert slack.tops == [intake_line(wave_order('A2').to_order_ref())]
    assert q.get('A1').thread_ts == 'ts0'  # 남의 스레드를 덮어쓰지 않는다


def test_같은_주문이_두_번_실려_와도_한_번만_접수한다(setup):
    _q, slack, make = setup
    intake, _w = make([wave_order('A1'), wave_order('A1')])
    report = intake.run_once()
    assert (report.enqueued, report.skipped_live) == (1, 1)
    assert len(slack.tops) == 1


@pytest.mark.parametrize('state', ['needs_human', 'failed', 'cancelled', 'done'])
def test_큐에_한_번_들어온_주문은_어떤_상태든_다시_접수하지_않는다(setup, state):
    # 사람 확인 대기 건이 매 주기 되살아나 무한 반복되면 안 된다 — 다시 돌리는 건 슬랙 `이어서`
    q, slack, make = setup
    job, _ = q.enqueue('A1', 'U1', {}, 'ts0')
    if state == 'cancelled':
        q.cancel('A1')
    else:
        q.finish(job.id, state)
    intake, _w = make([wave_order('A1')])
    report = intake.run_once()
    assert (report.enqueued, report.skipped_live) == (0, 1)
    assert q.get('A1').state == state
    assert slack.tops == []


def test_한_바퀴에_새로_접수하는_건수는_상한이_있다(setup):
    _q, slack, make = setup
    intake, _w = make([wave_order(f'A{i}') for i in range(8)])
    report = intake.run_once()
    assert report.enqueued == 5 and len(slack.tops) == 5
    # 다음 바퀴에 나머지를 받는다
    assert intake.run_once().enqueued == 3


def test_미지원_소싱처는_접수_뒤_바로_사람에게_넘긴다(setup):
    q, slack, make = setup
    # KREAM 은 sources.yaml 에서 hold — 등록부에 구매 에이전트가 없다
    intake, _w = make([wave_order('K1', source='KREAM'), wave_order('S1', source='SNKRDUNK')])
    report = intake.run_once()
    assert (report.enqueued, report.unsupported) == (0, 2)
    assert q.get('K1').state == 'needs_human'
    assert q.get('K1').error == 'unsupported: KREAM'
    assert len(slack.lines) == 2  # 스레드마다 한 줄씩만
    assert slack.lines[0][0] == 'ts1'
    assert 'KREAM' in slack.lines[0][1]


def test_일시정지하면_삼바웨이브를_부르지도_않는다(setup):
    _q, slack, make = setup
    intake, wave = make([wave_order('A1')])
    intake.pause()
    assert intake.paused is True
    assert intake.run_once() == intake.run_once().__class__()
    assert wave.calls == [] and slack.tops == []
    intake.resume()
    assert intake.run_once().enqueued == 1


def test_삼바웨이브_오류는_다음_주기로_미룬다(setup):
    q, slack, make = setup
    intake, _w = make([], error=WaveError(FailReason.BRIDGE_DOWN, '연결 실패'))
    report = intake.run_once()
    assert report.seen == 0 and report.enqueued == 0
    assert slack.tops == [] and q.live() == []


def test_결제가_오래된_주문부터_접수한다(setup):
    _q, slack, make = setup
    intake, _w = make(
        [wave_order('NEW', minutes=1), wave_order('OLD', minutes=600), wave_order('NONE')]
    )
    intake.run_once()
    posted = [t.split(' · ')[0] for t in slack.tops]
    assert posted[0].endswith('OLD') and posted[1].endswith('NEW')
    assert posted[2].endswith('NONE')  # 결제 시각이 없는 건은 맨 뒤


def test_슬랙이_없으면_스레드_없이_큐에만_쌓인다(tmp_path):
    q = JobQueue(tmp_path / 'jobs.sqlite')
    reg = Registry.load(DEFAULT_ROOT)
    slack = _Slack(ts=None)
    intake = Intake(_FakeWave([wave_order('A1')]), q, reg, slack.post_new, slack.post_line, days=7)
    assert intake.run_once().enqueued == 1
    assert q.get('A1').thread_ts is None


def test_run_forever_는_멈춤_신호에서_끝난다(setup):
    _q, _slack, make = setup
    intake, wave = make([wave_order('A1')])
    calls = {'n': 0}

    def stop() -> bool:
        calls['n'] += 1
        return calls['n'] > 2

    intake.run_forever(stop, interval_s=0)
    assert wave.calls  # 최소 한 바퀴는 돌았다


def test_접수_문구에는_개인정보가_없다():
    line = intake_line(wave_order('A1').to_order_ref())
    assert '접수: A1' in line
    for personal in ('010', '서울', '님'):
        assert personal not in line


def test_플래그가_있으면_접수_문구에_덧붙인다():
    line = intake_line(wave_order('A1', action_tag='no_price,staff_b').to_order_ref())
    assert line.endswith(' · ⚠ 가격X, 직원B')
    assert '⚠' not in intake_line(wave_order('A2').to_order_ref())


def test_플래그가_있어도_제외하지_않고_접수한다(setup):
    # 가격X·재고X·구매보류·다른 작업자는 오류일 수 있다 — 접수·구매는 진행하고 결제 승인에서 본다
    q, slack, make = setup
    intake, _w = make([wave_order('A1', action_tag='no_stock,staff_a')])
    report = intake.run_once()
    assert report.enqueued == 1
    assert q.get('A1').state == 'queued'
    assert '재고X, 직원A' in slack.tops[0]


def test_수집_범위는_소싱처와_포이즌_판매만():
    from samba_agent.queue.intake import Intake
    from samba_agent.wave.client import WaveOrder

    it = Intake.__new__(Intake)
    it._sources = frozenset({'MUSINSA', '29CM'})
    it._poison_only = True
    it._all_sellers = frozenset()

    def o(site, seller):
        return WaveOrder.model_validate(
            {'order_number': 'X', 'source_site': site, 'seller': seller}
        )

    assert it._in_scope(o('MUSINSA', 'poison(a@b.com)'))
    assert it._in_scope(o('29CM', '포이즌'))
    assert not it._in_scope(o('ABCmart', 'poison'))
    assert not it._in_scope(o('MUSINSA', '쿠팡(seller02)'))


def test_무신사는_판매처와_무관하게_이행한다():
    from samba_agent.queue.intake import Intake
    from samba_agent.wave.client import WaveOrder

    it = Intake.__new__(Intake)
    it._sources = frozenset({'MUSINSA', '29CM'})
    it._poison_only = True
    it._all_sellers = frozenset()
    it._all_sellers = frozenset({'MUSINSA'})

    def o(site, seller):
        return WaveOrder.model_validate(
            {'order_number': 'X', 'source_site': site, 'seller': seller}
        )

    assert it._in_scope(o('MUSINSA', '쿠팡(seller02)'))
    assert it._in_scope(o('29CM', 'poison'))
    assert not it._in_scope(o('29CM', '롯데홈쇼핑'))


class _LinkWave(_FakeWave):
    """연결 API 까지 흉내 — status 를 주면 그 상태로 실패한다."""

    def __init__(self, orders, link_status: int | None = None) -> None:
        super().__init__(orders)
        self.link_status = link_status
        self.linked: list[tuple[str, str]] = []

    def link_product(
        self, order_no: str, site_product_id: str, source_site: str = 'MUSINSA'
    ) -> dict[str, object]:
        self.linked.append((order_no, site_product_id))
        if self.link_status is not None:
            raise WaveError(FailReason.UNKNOWN, '삼바웨이브 404: 없음', self.link_status)
        return {'collected': False, 'linked_orders': 1}


def test_소싱처_미등록_주문은_추정한_무신사_상품에_연결하고_접수한다(tmp_path):
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()
    order = wave_order(
        'G1', source='', product_name='르무통 메이트 오렌지 3347853', product_option='230mm'
    )
    wave = _LinkWave([order])
    report = Intake(wave, q, reg, slack.post_new, slack.post_line, days=7).run_once()
    assert report.enqueued == 1
    assert wave.linked == [('G1', '3347853')]
    assert q.get('G1').state == 'queued'
    assert any('상품관리 상품에 연결' in t for _, t in slack.lines)


def test_무신사에서_사라진_상품은_재고X_로_마감한다(tmp_path):
    """상품명 숫자로 찾은 상품이 삭제됐다(무신사 '유효하지 않은 상품') — 사지 않고 표시·취소요청."""
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()
    marked: list[tuple[str, str]] = []
    order = wave_order(
        'G2', source='', product_name='남자데님팬츠 05415547 와이드 쿨 데님 415547 3colo'
    )
    intake = Intake(
        _LinkWave([order], link_status=404),
        q,
        reg,
        slack.post_new,
        slack.post_line,
        days=7,
        on_unfulfillable=lambda no, why: (
            marked.append((no, why)) or '재고X 표시함 · 취소요청으로 바꿈'
        ),
    )
    report = intake.run_once()
    assert report.enqueued == 0
    job = q.get('G2')
    assert job.state == 'needs_human'
    assert job.error == 'out_of_stock'
    assert marked == [('G2', 'out_of_stock')]
    assert any('재고X' in t for _, t in slack.lines)


def test_상품명이_잘린_롯데온_주문은_접두어로_연결만_시도한다(tmp_path):
    """소싱처도 추정 못 한 주문(LE+9자리) — 삼바웨이브에 접두어 연결을 한 번만 부탁하고 접수는 않는다."""
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()
    order = wave_order(
        'H1',
        source='',
        product_name='스케쳐스 여성 클레오 플렉스 웨지 여자로퍼 LE122077228',
        product_option='차콜/240',
    )
    wave = _LinkWave([order], link_status=409)
    intake = Intake(wave, q, reg, slack.post_new, slack.post_line, days=7)
    assert intake.run_once().enqueued == 0
    assert wave.linked == [('H1', 'LE122077228')]
    assert q.get('H1') is None
    intake.run_once()
    assert len(wave.linked) == 1  # 되풀이하지 않는다


def test_범위_밖_소싱처의_미등록_주문은_연결만_하고_접수하지_않는다(tmp_path):
    """ABC마트(10자리) — 이행 범위는 무신사·29CM 지만 상품관리 연결은 해 둔다(사용자 2026-09-25)."""
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()
    order = wave_order(
        'B1', source='', product_name='나이키 코트 버로우 로우 1010109335', product_option='230'
    )
    wave = _LinkWave([order])
    intake = Intake(
        wave,
        q,
        reg,
        slack.post_new,
        slack.post_line,
        days=7,
        sources=frozenset({'MUSINSA', '29CM'}),
    )
    assert intake.run_once().enqueued == 0
    assert wave.linked == [('B1', '1010109335')]
    assert q.get('B1') is None
    intake.run_once()
    assert wave.linked == [('B1', '1010109335')]  # 같은 프로세스에서 되풀이하지 않는다


# ==================== 같은 상품주문번호에 행이 여럿(삼바웨이브 행 id) ====================


def test_같은_주문번호_두_행은_따로_접수한다(setup):
    """실기 20261005DFA7D9 — 230 과 210 이 각각 행이다. 둘 다 사야 한다."""
    q, slack, make = setup
    a = wave_order('X', id='ord_A', product_option='230')
    b = wave_order('X', id='ord_B', product_option='210')
    intake, _w = make([a, b])
    report = intake.run_once()
    assert (report.enqueued, report.skipped_live) == (2, 0)
    assert [j.wave_id for j in q.live()] == ['ord_A', 'ord_B']
    assert all(j.order_no == 'X' for j in q.live())
    assert len(slack.tops) == 2
    # 다음 바퀴엔 둘 다 진행중 제외
    report = intake.run_once()
    assert (report.enqueued, report.skipped_live) == (0, 2)


def test_옛_행이_done_이면_같은_주문번호의_다른_행을_접수한다(setup):
    """230 을 산 옛 작업(행 id 없음, done)이 있어도 210 행은 들어가야 한다."""
    q, _slack, make = setup
    legacy, _ = q.enqueue('X', 'intake', {}, 'ts0')
    q.claim()
    q.finish(legacy.id, 'done')
    intake, _w = make([wave_order('X', id='ord_B', product_option='210')])
    report = intake.run_once()
    assert report.enqueued == 1
    assert q.get('ord_B').id != legacy.id


def test_옛_행이_사람_대기면_같은_주문번호의_행은_접수하지_않는다(setup):
    q, _slack, make = setup
    legacy, _ = q.enqueue('X', 'U1', {}, 'ts0')
    q.claim()
    q.finish(legacy.id, 'needs_human', error='margin')
    intake, _w = make([wave_order('X', id='ord_B', product_option='210')])
    report = intake.run_once()
    assert (report.enqueued, report.skipped_live) == (0, 1)


def test_소싱처_미등록_주문_연결은_행_id_로_부른다(tmp_path):
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()
    order = wave_order(
        'G1',
        id='ord_G1',
        source='',
        product_name='르무통 메이트 오렌지 3347853',
        product_option='230mm',
    )
    wave = _LinkWave([order])
    Intake(wave, q, reg, slack.post_new, slack.post_line, days=7).run_once()
    assert wave.linked == [('ord_G1', '3347853')]
    assert q.get('ord_G1').order_no == 'G1'


def test_bridge_down_으로_멈춘_작업은_5분_뒤_한_번_다시_넣는다(tmp_path):
    """실기 2026-10-06 탑텐 청자켓 — 앱이 죽어 bridge_down 으로 멈춘 채 20시간+ 방치됐다."""
    from datetime import UTC, datetime, timedelta

    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()
    order = wave_order('T1', source='MUSINSA', product_name='탑텐 청자켓', product_option='95')
    wave = _FakeWave([order])
    intake = Intake(wave, q, reg, slack.post_new, slack.post_line, days=7)
    intake.run_once()
    job = q.get('T1')
    q.finish(job.id, 'needs_human', error='bridge_down')
    intake.run_once()  # 방금 멈췄다 — 5분 안에는 두지 않는다
    assert q.get('T1').state == 'needs_human'
    old = (datetime.now(UTC) - timedelta(minutes=6)).isoformat(timespec='seconds')
    q._db.execute('UPDATE jobs SET updated_at=? WHERE id=?', (old, job.id))
    intake.run_once()
    again = q.get('T1')
    assert again.state == 'queued' and again.attempts == 1
    q.finish(job.id, 'needs_human', error='bridge_down')
    q._db.execute('UPDATE jobs SET updated_at=? WHERE id=?', (old, job.id))
    intake.run_once()  # 두 번째는 자동으로 하지 않는다
    assert q.get('T1').state == 'needs_human'


class _CancelWave(_FakeWave):
    """마켓 취소 정리까지 흉내 낸다."""

    def __init__(self, orders, cancelled) -> None:
        super().__init__(orders)
        self.cancelled = cancelled
        self.set_calls: list[tuple[str, str]] = []

    def market_cancelled_pending(self, days: int = 14):
        return list(self.cancelled)

    def set_cancel_requested(self, order_no: str, reason: str, flag=None) -> bool:
        self.set_calls.append((order_no, reason))
        return True


def test_마켓이_취소로_돌린_미이행_주문은_취소중으로_정리한다(tmp_path):
    """실기 2026-10-06 탑텐 청자켓 — 마켓 취소완료인데 주문접수로 20시간+ 방치됐다."""
    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()
    wave = _CancelWave(
        [],
        [{'id': 'ord_T1', 'order_number': '3475968284 2906047682', 'shipping_status': '취소완료'}],
    )
    intake = Intake(wave, q, reg, slack.post_new, slack.post_line, days=7)
    intake.run_once()
    assert [k for k, _ in wave.set_calls] == ['ord_T1']
    assert '취소완료' in wave.set_calls[0][1]
    assert any('취소중으로 정리' in t for t in slack.tops)
    intake.run_once()  # 한 번 정리한 주문은 다시 건드리지 않는다
    assert len(wave.set_calls) == 1


def test_소싱처_매칭에_끝내_실패한_주문은_한참_뒤_근거를_남겨_취소중으로_정리한다(
    tmp_path, monkeypatch
):
    """사용자 2026-10-08: 소싱처 미등록 주문은 매칭 로직을 거치고, 그래도 안 되면 취소중이다."""
    from samba_agent.queue import intake as intake_mod

    reg = Registry.load(DEFAULT_ROOT)
    q = JobQueue(tmp_path / 'jobs.sqlite')
    slack = _Slack()
    unlinked = wave_order(
        'U1', source='', product_name='노스페이스 크림색 키즈 아동 플리스 재킷', id='ord_U1'
    )
    wave = _CancelWave([unlinked], [])
    intake = Intake(wave, q, reg, slack.post_new, slack.post_line, days=7, sources=('MUSINSA',))
    intake.run_once()
    assert wave.set_calls == []  # 처음 본 직후엔 연결이 돌 틈을 준다
    monkeypatch.setattr(intake_mod, 'UNLINKED_CANCEL_AFTER', timedelta(seconds=0))
    intake.run_once()
    assert [k for k, _ in wave.set_calls] == ['ord_U1']
    assert '소싱처 매칭 실패' in wave.set_calls[0][1]
    intake.run_once()  # 한 번 정리한 주문은 다시 건드리지 않는다
    assert len(wave.set_calls) == 1

    # 끝 번호로 추정되는 주문(소싱처를 알아낼 수 있다)은 정리하지 않는다
    class _NoLink(_CancelWave):
        def link_product(self, *a, **k):
            raise WaveError(FailReason.UNKNOWN, '연결 못 함')

    wave2 = _NoLink(
        [wave_order('U2', source='', product_name='나이키 덩크 6079566', id='ord_U2')], []
    )
    Intake(
        wave2, JobQueue(tmp_path / 'j2.sqlite'), reg, slack.post_new, slack.post_line, days=7
    ).run_once()
    assert wave2.set_calls == []
