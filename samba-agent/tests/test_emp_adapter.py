# EMP 어댑터 — 부를 때마다 창 상태를 확인하고 드라이버에 넘긴다. 금액 글자 읽기
import pytest

from samba_agent.export.adapters import AdapterRetry, CellValues
from samba_agent.export.desktop.emp import EmpAdapter, EmpCancelAdapter, parse_won
from samba_agent.export.failures import ExportFail


class FakeUi:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.rows = {'E1': CellValues(0, 0)}
        self.ready_error: Exception | None = None

    def ensure_ready(self) -> None:
        self.calls.append('ready')
        if self.ready_error is not None:
            raise self.ready_error

    def search(self) -> None:
        self.calls.append('search')

    def show_only(self, order_no: str) -> None:
        self.calls.append(f'show {order_no}')
        if order_no not in self.rows:
            raise AdapterRetry(ExportFail.NOT_FOUND, '없다')

    def clear_keyword(self) -> None:
        self.calls.append('clear')

    def cancel(self, order_no: str) -> None:
        self.calls.append(f'cancel {order_no}')

    def read(self, order_no: str) -> CellValues:
        self.calls.append(f'read {order_no}')
        return self.rows[order_no]

    def write(self, order_no: str, cost: int, shipping_fee: int, memo: str = '') -> None:
        self.calls.append(f'write {order_no} {cost} {shipping_fee}' + (f' {memo}' if memo else ''))
        self.rows[order_no] = CellValues(cost, shipping_fee, memo or None)


def test_읽기와_쓰기_앞에_창_상태를_확인한다():
    ui = FakeUi()
    adapter = EmpAdapter(ui)
    assert adapter.read('E1') == CellValues(0, 0)
    adapter.write('E1', 57131, 2300)
    assert adapter.read('E1') == CellValues(57131, 2300)
    assert ui.calls == [
        'ready',
        'show E1',
        'read E1',
        'clear',
        'ready',
        'show E1',
        'write E1 57131 2300',
        'clear',
        'ready',
        'show E1',
        'read E1',
        'clear',
    ]


def test_창이_준비되지_않으면_드라이버를_부르지_않는다():
    ui = FakeUi()
    ui.ready_error = AdapterRetry(ExportFail.WINDOW_MISSING, 'EMP 창이 없다')
    with pytest.raises(AdapterRetry):
        EmpAdapter(ui).write('E1', 1000, 0)
    assert ui.calls == ['ready']


@pytest.mark.parametrize(
    ('text', 'want'),
    [
        ('33,440', 33440),
        ('0', 0),
        ('2,300', 2300),
        ('57131', 57131),
        ('', None),
        (None, None),
        (' 1,000 ', 1000),
    ],
)
def test_금액_글자를_원_단위_정수로_읽는다(text, want):
    assert parse_won(text) == want


def test_숫자가_아닌_금액은_오류다():
    with pytest.raises(ValueError):
        parse_won('무료')


def test_취소는_검색한_뒤_있는_주문만_바꾸고_없는_주문은_남긴다():
    ui = FakeUi()
    done = EmpCancelAdapter(ui).complete_pending(['E1', 'X9'])
    assert done == {'E1'}
    assert ui.calls == ['ready', 'show E1', 'cancel E1', 'show X9', 'clear']


def test_취소할_주문이_없으면_화면을_건드리지_않는다():
    ui = FakeUi()
    assert EmpCancelAdapter(ui).complete_pending([]) == set()
    assert ui.calls == []


class _UiProbe:
    """PywinautoEmpUi.write 의 칸 입력 순서·실패 뒷정리만 보는 가짜 — 실제 창은 건드리지 않는다."""

    def __init__(self, fail_on: str | None = None) -> None:
        from samba_agent.export.desktop.emp_ui import PywinautoEmpUi

        self.write = PywinautoEmpUi.write.__get__(self)
        self.fail_on = fail_on
        self.calls: list[str] = []
        self._guard = True

    def read(self, order_no):
        return CellValues(cost=0, shipping_fee=0, memo='')

    def _edit_cell(self, order_no, prefix, column, value):
        self.calls.append(f'edit {column}')
        if column == self.fail_on:
            raise AdapterRetry(ExportFail.TIMEOUT, 'EMP 칸 편집 상자가 열리지 않았다')

    def _stop_if_user_back(self):
        pass

    def _cleanup(self):
        import contextlib

        return contextlib.nullcontext()

    def _close_editor(self):
        self.calls.append('close_editor')

    def reload(self):
        self.calls.append('reload')

    def save(self):
        self.calls.append('save')


def test_한줄메모를_먼저_넣고_저장한다():
    ui = _UiProbe()
    ui.write('E1', 72418, 2300, '2026100700955')
    assert ui.calls == ['edit 한줄메모', 'edit 원가', 'edit 배송비', 'save', 'reload']


def test_메모_칸이_실패하면_아무것도_저장하지_않고_편집을_버린다():
    """실기 2026-10-07: 원가·배송비만 들어간 채 남아 '저장하시겠습니까?' 가 떴다."""
    ui = _UiProbe(fail_on='한줄메모')
    with pytest.raises(AdapterRetry):
        ui.write('E1', 72418, 2300, '2026100700955')
    assert ui.calls == ['edit 한줄메모', 'close_editor', 'reload']
    assert 'save' not in ui.calls


def test_원가_칸이_실패해도_넣다_만_메모를_버린다():
    ui = _UiProbe(fail_on='원가')
    with pytest.raises(AdapterRetry):
        ui.write('E1', 72418, 2300, '2026100700955')
    assert ui.calls == ['edit 한줄메모', 'edit 원가', 'close_editor', 'reload']


def test_교환주문_행은_읽는_단계에서_거절한다():
    """사용자 2026-10-07: 교환주문은 입력할 필요가 없다(원주문을 고쳐야 한다)."""
    from samba_agent.export.adapters import AdapterReject
    from samba_agent.export.desktop.emp_ui import PywinautoEmpUi

    class Row:
        def __init__(self) -> None:
            self.values = {
                '상품명': '[★교환주문]매장정품 반스 VANS VN000CRRCJJ1',
                '원가': '0',
                '배송비': '0',
                '한줄메모': '',
            }

    ui = object.__new__(PywinautoEmpUi)
    ui.find_row = lambda order_no: Row()  # type: ignore[method-assign]
    with pytest.raises(AdapterReject) as err:
        ui.read('20261005H22417:1137314933')
    assert err.value.reason is ExportFail.EXCHANGE_ORDER
