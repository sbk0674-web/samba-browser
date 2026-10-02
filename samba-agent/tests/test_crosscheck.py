"""교차 검증 — 하네스 기입 장부와 삼바웨이브 값 대조."""

from samba_agent.ops.crosscheck import CrossChecker, Ledger, backfill, compare, is_void
from samba_agent.wave.client import WaveOrder


def _order(**kw: object) -> WaveOrder:
    base = {'order_number': 'A1', 'status': 'wait_ship', 'sourcing_order_number': 'S1', 'cost': 108690,
            'shipping_fee': 0, 'sourcing_account_username': 'edelvise06'}  # fmt: skip
    return WaveOrder.model_validate({**base, **kw})


def _ledger(tmp_path) -> Ledger:
    ledger = Ledger(tmp_path / 'ledger.sqlite')
    ledger.put('A1', 'S1', 108690, 0, 'edelvise06', 'MUSINSA')
    return ledger


def test_덮어쓴_실구매가와_주문계정을_찾는다(tmp_path):
    row = _ledger(tmp_path).recent()[0]
    found = compare(row, _order(cost=147970, sourcing_account_username='roasterydg'))
    assert [f.field for f in found] == ['cost', 'account']


def test_몇백원_보정과_같은_값은_지나간다(tmp_path):
    row = _ledger(tmp_path).recent()[0]
    assert compare(row, _order()) == []
    assert compare(row, _order(cost=108540)) == []


def test_소싱주문번호가_바뀌면_그것만_알린다(tmp_path):
    row = _ledger(tmp_path).recent()[0]
    found = compare(row, _order(sourcing_order_number='S2', cost=1))
    assert [f.field for f in found] == ['source_order_no']


def test_취소_원복된_주문은_대조하지_않는다():
    assert is_void(_order(status='cancelled'))
    assert is_void(_order(status='pending', sourcing_order_number='', cost=0))
    assert not is_void(_order())


class _Wave:
    def __init__(self, order: WaveOrder) -> None:
        self.order = order
        self.written: list[dict[str, object]] = []

    def get_order(self, order_no, order_type=None, sourcing_order_number=None):
        return self.order

    def sourcing_account_id(self, site, username):
        return f'sa_{username}'

    def record_sourcing(self, order_no, **kw):
        self.written.append({'order_no': order_no, **kw})

    def pending_orders(self, days=7, limit=100):
        return getattr(self, 'pending', [])


def test_덮어쓴_값은_한_번만_되돌리고_알린다(tmp_path):
    ledger = _ledger(tmp_path)
    wave = _Wave(_order(cost=147970, shipping_fee=92, sourcing_account_username='roasterydg'))
    alerts: list[str] = []
    checker = CrossChecker(ledger, wave, alerts.append)  # type: ignore[arg-type]
    assert len(checker.run_once()) == 2
    assert wave.written == [{
        'order_no': 'A1', 'sourcing_order_number': 'S1', 'cost': 108690.0, 'shipping_fee': 92.0,
        'sourcing_account_id': 'sa_edelvise06',
    }]  # fmt: skip
    assert len(alerts) == 1 and '되돌림' in alerts[0]
    # 또 덮어써지면 다시 되돌리지 않는다(사람이 고친 값과 싸우지 않는다) — 같은 내용은 다시 알리지도 않는다
    checker.run_once()
    assert len(wave.written) == 1 and len(alerts) == 1


def test_취소된_주문은_장부에서_끝난_것으로_표시한다(tmp_path):
    ledger = _ledger(tmp_path)
    wave = _Wave(_order(status='cancelled', cost=0))
    assert CrossChecker(ledger, wave).run_once() == []  # type: ignore[arg-type]
    assert ledger.recent() == [] and wave.written == []


def test_로그에서_장부를_채운다(tmp_path):
    logs = tmp_path / 'logs'
    logs.mkdir()
    (logs / 'harness-20261001-195830.log').write_text(
        '20:36:00.000 INFO:samba_agent.agents.base:buyer.cm29 근거 [계정 선택] rbf1 — 원가 최저\n'
        '20:36:10.000 INFO:samba_agent.agents.base:buyer.musinsa 근거 [계정 선택] edelvise06 — 원가 최저 108,690원\n'
        '20:36:50.000 INFO:httpx:HTTP Request: PUT https://x/api/v1/internal/harness/orders/21315208468963299/sourcing "HTTP/1.1 200 OK"\n'
        '20:36:53.000 INFO:samba_agent.agents.base:recorder 근거 [기입 확인] {"source_order_no": "202610012036530002", "real_price": 108690.0, "shipping_fee": 0.0}\n',
        encoding='utf-8',
    )
    ledger = Ledger(tmp_path / 'ledger.sqlite')
    assert backfill(ledger, logs) == 1
    row = ledger.recent(days=3650)[0]
    assert (row.order_no, row.source_order_no, row.cost, row.account, row.site) == (
        '21315208468963299', '202610012036530002', 108690.0, 'edelvise06', 'MUSINSA',
    )  # fmt: skip


def test_소싱처에서_취소된_이행_주문을_알린다(tmp_path):
    ledger = _ledger(tmp_path)
    alerts: list[str] = []
    seen: list[str] = []

    def status(row):
        seen.append(row.source_order_no)
        return '취소 완료'

    checker = CrossChecker(ledger, _Wave(_order()), alerts.append, source_status=status, idle=lambda: True)  # type: ignore[arg-type]
    checker.run_once()
    assert seen == ['S1'] and len(alerts) == 1 and '취소' in alerts[0]
    # 방금 본 주문은 몇 시간 뒤에 다시 본다
    checker.run_once()
    assert seen == ['S1']


def test_주문_작업이_돌면_소싱처를_열지_않고_취소_요청은_알리지_않는다(tmp_path):
    ledger = _ledger(tmp_path)
    alerts: list[str] = []
    busy = CrossChecker(ledger, _Wave(_order()), alerts.append, source_status=lambda r: '취소 완료', idle=lambda: False)  # type: ignore[arg-type]
    busy.run_once()
    assert alerts == []
    asked = CrossChecker(ledger, _Wave(_order()), alerts.append, source_status=lambda r: '취소 요청', idle=lambda: True)  # type: ignore[arg-type]
    asked.run_once()
    assert alerts == []


def test_주문접수로_오래_남은_주문을_하루에_한_번_알린다(tmp_path):
    from datetime import UTC, datetime, timedelta

    wave = _Wave(_order())
    wave.pending = [
        WaveOrder.model_validate({'order_number': 'OLD1', 'status': 'pending', 'seller': 'KT알파', 'paid_at': datetime.now(UTC) - timedelta(hours=30)}),
        WaveOrder.model_validate({'order_number': 'NEW1', 'status': 'pending', 'paid_at': datetime.now(UTC) - timedelta(hours=1)}),
    ]  # fmt: skip
    alerts: list[str] = []
    checker = CrossChecker(Ledger(tmp_path / 'ledger.sqlite'), wave, alerts.append)  # type: ignore[arg-type]
    checker.run_once()
    checker.run_once()
    assert len(alerts) == 1 and 'OLD1' in alerts[0] and 'NEW1' not in alerts[0] and '소싱처 미등록' in alerts[0]


def test_결제_시각이_날짜만_있는_주문은_처음_본_때부터_잰다(tmp_path):
    from datetime import UTC, datetime, timedelta, timezone

    kst = timezone(timedelta(hours=9))
    # KT알파는 0시 0분 1초로 들어온다 — 초가 붙어도 날짜만 있는 값으로 본다
    midnight = datetime.now(kst).replace(hour=0, minute=0, second=1, microsecond=0) - timedelta(days=1)
    wave = _Wave(_order())
    # 플레이오토 주문은 결제 시각이 그날 0시로 들어온다 — 방금 수집된 주문이 '수십 시간째'로 잡히면 안 된다
    wave.pending = [WaveOrder.model_validate({'order_number': 'PA1', 'status': 'pending', 'paid_at': midnight})]
    alerts: list[str] = []
    checker = CrossChecker(Ledger(tmp_path / 'ledger.sqlite'), wave, alerts.append)  # type: ignore[arg-type]
    checker.run_once()
    assert alerts == []
    # 처음 본 뒤로 6시간이 지나면 알린다
    checker._first_seen['PA1'] = datetime.now(UTC) - timedelta(hours=7)
    checker.run_once()
    assert len(alerts) == 1 and 'PA1' in alerts[0] and '7시간째' in alerts[0]


def test_직배인데_소싱처_주문이_사무실로_가면_알린다(tmp_path):
    from samba_agent.ops.source_audit import SourceDetail

    ledger = _ledger(tmp_path)
    alerts: list[str] = []
    wave = _Wave(_order(action_tag='direct'))
    to_office = CrossChecker(
        ledger, wave, alerts.append, source_detail=lambda r: SourceDetail('상품 준비 중', '상품', True), idle=lambda: True
    )  # type: ignore[arg-type]
    to_office.run_once()
    assert len(alerts) == 1 and '받는 곳이 기록과 다르다' in alerts[0] and 'A1' in alerts[0]


def test_직배가_고객_주소로_가면_조용하다(tmp_path):
    from samba_agent.ops.source_audit import SourceDetail

    alerts: list[str] = []
    wave = _Wave(_order(action_tag='direct'))
    ok = CrossChecker(
        _ledger(tmp_path), wave, alerts.append, source_detail=lambda r: SourceDetail('상품 준비 중', '상품', False), idle=lambda: True
    )  # type: ignore[arg-type]
    ok.run_once()
    assert alerts == []
