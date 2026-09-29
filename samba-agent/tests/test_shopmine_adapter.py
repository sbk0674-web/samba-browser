# 샵마인 '완료됨' 절차 — 화면 드라이버는 가짜, 순서·주문번호 대조·되읽기·실패 분류를 본다
import pytest

from samba_agent.export.adapters import AdapterReject, AdapterRetry
from samba_agent.export.desktop.shopmine import ShopMineAdapter, order_matches
from samba_agent.export.failures import ExportFail


class FakeUi:
    """샵마인 화면 가짜. rows 는 필터에 걸린 행의 주문번호, done 을 누르면 체크된 행이 사라진다."""

    def __init__(self, rows: tuple[str, ...] = ('S1', 'S2', 'S3')) -> None:
        self.rows = list(rows)
        self.checked: list[str] = []
        self.calls: list[str] = []
        self.statuses: list[str] = []
        # 이미 그 작업상태인 주문(필터 목록에는 없다)
        self.marked: list[str] = []
        self.ready_error: Exception | None = None
        self.wait_error: Exception | None = None
        # 완료됨을 눌러도 남는 주문(되읽기 불일치 시험용)
        self.sticky: set[str] = set()
        # 체크가 안 되는 주문(부분 선택 시험용)
        self.uncheckable: set[str] = set()

    def ensure_ready(self) -> None:
        self.calls.append('ready')
        if self.ready_error is not None:
            raise self.ready_error

    def set_period(self) -> None:
        self.calls.append('period')

    def collect(self) -> None:
        self.calls.append('collect')

    def wait_collected(self, timeout_s: float) -> None:
        self.calls.append(f'wait {timeout_s:g}')
        if self.wait_error is not None:
            raise self.wait_error

    def set_filters(self) -> None:
        self.calls.append('filters')

    def filtered_order_nos(self) -> list[str]:
        self.calls.append('list')
        return list(self.rows)

    def order_nos_with_status(self, status: str) -> list[str]:
        self.calls.append(f'marked {status}')
        return list(self.marked)

    def select_orders(self, order_nos) -> dict[str, int]:
        self.calls.append(f'select {",".join(order_nos)}')
        self.checked = [o for o in order_nos if o in self.rows and o not in self.uncheckable]
        return {o: (1 if o in self.checked else 0) for o in order_nos}

    def write_memo(self, order_no: str, memo: str) -> None:
        self.calls.append(f'memo {order_no} {memo}')

    def set_status(self, status: str, expected_rows: int) -> None:
        self.calls.append(f'done {expected_rows}')
        self.statuses.append(status)
        self.rows = [r for r in self.rows if r not in self.checked or r in self.sticky]


def test_넘긴_주문_중_화면에_있는_것만_체크해_완료됨으로_바꾸고_되읽는다():
    ui = FakeUi(rows=('S1', 'S2', 'S3'))
    done = ShopMineAdapter(ui, collect_timeout_s=90).complete_pending(['S1', 'S3', 'X9'])
    assert done == {'S1', 'S3'}
    assert ui.calls == [
        'ready',
        'period',
        'collect',
        'wait 90',
        'filters',
        'list',
        'select S1,S3',
        'done 2',
        'filters',
        'list',
    ]
    assert ui.rows == ['S2']  # 넘기지 않은 주문은 건드리지 않는다


def test_넘긴_주문이_화면에_하나도_없으면_아무것도_누르지_않는다():
    ui = FakeUi(rows=('S1',))
    assert ShopMineAdapter(ui).complete_pending(['X1', 'X2']) == set()
    assert not any(c.startswith('done') for c in ui.calls)
    assert not any(c.startswith('select') for c in ui.calls)


def test_주문번호가_비어_있으면_화면을_건드리지_않는다():
    ui = FakeUi()
    assert ShopMineAdapter(ui).complete_pending([]) == set()
    assert ui.calls == []


def test_dry_run_은_체크까지만_한다():
    ui = FakeUi(rows=('S1', 'S2'))
    assert ShopMineAdapter(ui, dry_run=True).complete_pending(['S2']) == {'S2'}
    assert ui.calls[-1] == 'select S2'
    assert not any(c.startswith('done') for c in ui.calls)
    assert ui.rows == ['S1', 'S2']


def test_체크가_안_된_행이_있으면_누르지_않고_거절한다():
    ui = FakeUi(rows=('S1', 'S2'))
    ui.uncheckable = {'S2'}
    with pytest.raises(AdapterReject) as e:
        ShopMineAdapter(ui).complete_pending(['S1', 'S2'])
    assert e.value.reason is ExportFail.AMBIGUOUS
    assert not any(c.startswith('done') for c in ui.calls)


def test_완료됨_뒤에도_남으면_verify_mismatch():
    ui = FakeUi(rows=('S1', 'S2'))
    ui.sticky = {'S2'}
    with pytest.raises(AdapterReject) as e:
        ShopMineAdapter(ui).complete_pending(['S1', 'S2'])
    assert e.value.reason is ExportFail.VERIFY_MISMATCH
    assert '1건' in e.value.detail


def test_창이_없으면_AdapterRetry_가_그대로_나간다():
    ui = FakeUi()
    ui.ready_error = AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 창 없음')
    with pytest.raises(AdapterRetry) as e:
        ShopMineAdapter(ui).complete_pending(['S1'])
    assert e.value.reason is ExportFail.WINDOW_MISSING
    assert ui.calls == ['ready']


def test_수집_시간_초과는_AdapterRetry_timeout():
    ui = FakeUi()
    ui.wait_error = AdapterRetry(ExportFail.TIMEOUT, '수집 120초 초과')
    with pytest.raises(AdapterRetry) as e:
        ShopMineAdapter(ui).complete_pending(['S1'])
    assert e.value.reason is ExportFail.TIMEOUT
    assert 'filters' not in ui.calls


@pytest.mark.parametrize(
    ('order_no', 'cell', 'want'),
    [
        ('20260928C6B437', '20260928C6B437', True),
        ('20260928B68241:1136399342', '20260928B68241', True),  # SSG — ':' 앞
        ('3474596476 2904713019', '2904713019', True),  # GS이숍 — 토큰
        ('3474596476 2904713019', '3474596476', True),
        ('10103253087873', '10103253087873', True),
        # 롯데홈쇼핑 — EMP 는 공백으로, 하네스는 ':' 로 나눈다
        ('20260929B92579:1136441910', '20260929B92579 1136441910', True),
        ('20260929B92579:1136441910', '20260929B92579  1136441910', True),
        ('20260929B92579:1136441910', '20260929B92579 9999999999', False),
        ('20260929B92579:1136441910', '20260929B90309 1136441910', False),
        ('10103253087873', '1010325308787', False),  # 앞부분만 같은 것은 아니다
        ('20260928C6B437', '20260928C6B9E4', False),
        ('', '20260928C6B437', False),
        ('20260928C6B437', '', False),
    ],
)
def test_주문번호_대조_규칙(order_no, cell, want):
    assert order_matches(order_no, cell) is want


def test_기본은_완료됨_취소_어댑터는_지연됨으로_바꾼다():
    ui = FakeUi(rows=('S1', 'S2'))
    ShopMineAdapter(ui).complete_pending(['S1'])
    ShopMineAdapter(ui, status='지연됨').complete_pending(['S2'])
    assert ui.statuses == ['완료됨', '지연됨']


def test_이미_그_작업상태인_주문은_끝난_것으로_본다():
    ui = FakeUi(rows=('S1',))
    ui.marked = ['D1']
    done = ShopMineAdapter(ui, status='지연됨').complete_pending(['S1', 'D1', 'X9'])
    assert done == {'S1', 'D1'}
    assert ui.rows == []


def test_전부_이미_바뀌어_있으면_누르지_않는다():
    ui = FakeUi(rows=('S1',))
    ui.marked = ['D1']
    assert ShopMineAdapter(ui, status='지연됨').complete_pending(['D1']) == {'D1'}
    assert not any(c.startswith('done') for c in ui.calls)


def test_완료됨은_이미_바뀐_주문을_찾으러_큰_목록을_읽지_않는다():
    ui = FakeUi(rows=('S1',))
    ui.marked = ['D1']
    assert ShopMineAdapter(ui).complete_pending(['D1']) == set()
    assert not any(c.startswith('marked') for c in ui.calls)


def test_추가메모는_완료됨_전에_그_주문에만_넣는다():
    ui = FakeUi(rows=('S1', 'S2'))
    adapter = ShopMineAdapter(ui, collect_timeout_s=90)
    adapter.use_memos({'S1': '[도착예정] 10/05(일)'})
    assert adapter.complete_pending(['S1']) == {'S1'}
    i = ui.calls.index('memo S1 [도착예정] 10/05(일)')
    assert ui.calls[i + 1] == 'done 1'


def test_메모가_없으면_메모_칸을_건드리지_않는다():
    ui = FakeUi(rows=('S1',))
    adapter = ShopMineAdapter(ui)
    adapter.use_memos({})
    adapter.complete_pending(['S1'])
    assert not any(c.startswith('memo') for c in ui.calls)
