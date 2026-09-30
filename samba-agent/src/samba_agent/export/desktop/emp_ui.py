"""EMP(플레이오토) 주문관리 화면 드라이버 — pywinauto. 주문 그리드의 원가·배송비를 읽고 쓴다.

EMP 는 관리자 권한으로 돈다 — 이 드라이버도 관리자 권한 프로세스에서 불러야 한다(일반 권한
에서는 UIA 가 창을 못 보고 입력도 막힌다, 실기 2026-09-28).

화면 사실(실기 2026-09-28, EMP 1.1.0.458):
- 주문 그리드는 C1 FlexGrid(automation id `grid`). 행은 `Custom` 요소고 legacy Value 가 그 행의
  모든 열 값을 탭으로 이은 문자열이다(숨은 열 포함 82열). 첫 행(`Row 0`)이 열 이름이다.
- 셀 요소는 **화면에 보이는 열**만 있다. 원가 셀은 `wprice1 Row N`, 배송비 셀은 `deliv_price Row N`
  이고 둘 다 ValuePattern 으로 값을 넣을 수 있다(읽기 전용 아님).
- 컨트롤은 보이는 자식 창 핸들을 열거해 automation id 색인으로 찾는다(샵마인 드라이버와 같은 이유).
"""

import contextlib
import ctypes
import datetime as dt
import logging
import re
import threading
import time
from collections.abc import Callable, Iterator
from ctypes import wintypes

from pywinauto.controls.hwndwrapper import HwndWrapper
from pywinauto.controls.uiawrapper import UIAWrapper
from pywinauto.uia_element_info import UIAElementInfo

from samba_agent.export.adapters import AdapterReject, AdapterRetry, CellValues
from samba_agent.export.desktop.emp import parse_won
from samba_agent.export.desktop.shopmine import order_matches
from samba_agent.export.desktop.shopmine_ui import period_to_cover
from samba_agent.export.failures import ExportFail

log = logging.getLogger(__name__)

WINDOW_TITLE_MARK = 'EMP 1.'
# 사람이 처리해야 하는 인증 창 제목에 들어 있는 글자
AUTH_MARKS = ('인증', 'OTP')
LOGIN_MARK = '로그인'
GRID_ID = 'grid'
COL_ORDER_NO = '주문번호'
COL_COST = '원가'
COL_SHIPPING = '배송비'
# 화면에 보이는 셀 요소의 이름 앞머리(열의 내부 이름)
CELL_COST = 'wprice1'
CELL_SHIPPING = 'deliv_price'
# 한줄메모 — 소싱주문번호를 넣는다(사용자 2026-09-30). 그리드 칸 이름은 note(실기)
COL_NOTE = '한줄메모'
CELL_NOTE = 'note'
SAVE_BUTTON = '저장'
REFRESH_BUTTON = '새로고침'
TOOLBAR_ID = 'toolStrip2'
# 저장 뒤 안내창 문구('성공적으로 저장 되었습니다.')
SAVED_MARK = '저장 되었습니다'
# 새로고침 때 저장 안 된 편집이 있으면 뜨는 문구
UNSAVED_MARK = '저장하시겠습니까'
OK_BUTTONS = ('확인', 'OK')
# 검색 영역(리본) — 요소 이름은 프로그램 안쪽 이름이다(실기 2026-09-29)
RIBBON_ID = 'c1Ribbon1'
START_DATE = 'OrderSdate'
END_DATE = 'OrderEdate'
# 날짜 빠른 선택 '2주' — 오늘까지 14일을 잡는다
TWO_WEEKS_BUTTON = 'ribbonToggleButton1511'
SEARCH_BUTTON = 'OrderSearchBT'
KEYWORD_BOX = 'OrderKeyword'
# 취소 확인 창은 30초 뒤 스스로 실행된다 — 여유를 두고 기다린다
AUTO_RUN_WAIT_S = 50.0
_WM_RBUTTONDOWN, _WM_RBUTTONUP = 0x0204, 0x0205
DIALOG_CLASS = '#32770'
COL_STATE = '상태'
COL_SELLER_CODE = '판매자상품코드'
STATE_CANCELLED = '취소'
# 행 메뉴(우클릭 메뉴) 항목 — 이름 뒤에 단축 글자가 붙는다('상태변경 (Q)')
MENU_STATE = '상태변경'
MENU_CANCEL = '취소'
# 주문 상세 미리보기의 주문번호 칸 — 지금 고른 행이 무엇인지 여기서 확인한다
PREVIEW_ORDER_NO = 'ocode1'
_WM_MOUSEMOVE = 0x0200
_VK_APPS = 0x5D
NO_BUTTONS = ('아니요(N)', '아니오(N)', 'No')
YES_BUTTONS = ('예(Y)', 'Yes')

_WM_SETTEXT, _WM_GETTEXT = 0x000C, 0x000D
_WM_KEYDOWN, _WM_KEYUP, _WM_CHAR = 0x0100, 0x0101, 0x0102
_WM_LBUTTONDOWN, _WM_LBUTTONUP, _WM_LBUTTONDBLCLK = 0x0201, 0x0202, 0x0203
_WM_COMMAND = 0x0111
_VK_RETURN, _VK_ESCAPE = 0x0D, 0x1B

# 확인 창 문구의 선택 건수('선택하신 1건의 주문의 …')
_SELECTED_COUNT = re.compile(r'선택하신\s*(\d+)\s*건')

_user32 = ctypes.windll.user32
_ENUM_PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


class _GuiThreadInfo(ctypes.Structure):
    _fields_ = [
        ('cbSize', wintypes.DWORD),
        ('flags', wintypes.DWORD),
        ('hwndActive', wintypes.HWND),
        ('hwndFocus', wintypes.HWND),
        ('hwndCapture', wintypes.HWND),
        ('hwndMenuOwner', wintypes.HWND),
        ('hwndMoveSize', wintypes.HWND),
        ('hwndCaret', wintypes.HWND),
        ('rcCaret', wintypes.RECT),
    ]


def _visible_children(hwnd: int) -> list[int]:
    found: list[int] = []

    def collect(child, _lparam):
        if _user32.IsWindowVisible(child):
            found.append(child)
        return True

    _user32.EnumChildWindows(hwnd, _ENUM_PROC(collect), 0)
    return found


def _all_windows() -> list[tuple[int, str, str]]:
    """보이는 최상위 창 전부 — (핸들, 제목, 창 종류)."""
    found: list[tuple[int, str, str]] = []

    def collect(hwnd, _lparam):
        if _user32.IsWindowVisible(hwnd):
            title = ctypes.create_unicode_buffer(256)
            kind = ctypes.create_unicode_buffer(256)
            _user32.GetWindowTextW(hwnd, title, 256)
            _user32.GetClassNameW(hwnd, kind, 256)
            found.append((hwnd, title.value, kind.value))
        return True

    _user32.EnumWindows(_ENUM_PROC(collect), 0)
    return found


def _process_windows(pid: int) -> list[tuple[int, str, str]]:
    """그 프로세스의 보이는 최상위 창 — (핸들, 제목, 창 종류).

    pywinauto 의 창 목록은 읽는 사이 창 하나가 사라지면 통째로 실패한다(실기 2026-09-29:
    InvalidWindowHandle). 여기서는 사라진 창을 건너뛴다.
    """
    found: list[tuple[int, str, str]] = []

    def collect(hwnd, _lparam):
        owner = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and _user32.IsWindowVisible(hwnd):
            title = ctypes.create_unicode_buffer(256)
            kind = ctypes.create_unicode_buffer(256)
            _user32.GetWindowTextW(hwnd, title, 256)
            _user32.GetClassNameW(hwnd, kind, 256)
            found.append((hwnd, title.value, kind.value))
        return True

    _user32.EnumWindows(_ENUM_PROC(collect), 0)
    return found


class GridRow:
    """그리드 한 행 — 요소와 열 이름 → 값."""

    def __init__(self, element, number: int, values: dict[str, str]) -> None:
        self.element = element
        # 셀 이름의 'Row N' 에 쓰이는 번호(헤더가 0)
        self.number = number
        self.values = values


class PywinautoEmpUi:
    """EMP 주문 그리드 읽기·쓰기."""

    def __init__(
        self, *, poll_s: float = 0.5, user_active: Callable[[], bool] | None = None
    ) -> None:
        self._poll_s = poll_s
        # 사람이 키보드·마우스를 만지고 있는가 — 참이면 하던 일을 그 자리에서 멈춘다(사용자 지시 2026-09-29)
        self._user_active = user_active
        # 뒷정리(메뉴 닫기·안 저장한 값 버리기·검색어 지우기) 중에는 멈추지 않는다 — 화면을 어질러 둔 채 떠나지 않는다
        self._guard = True
        self._main = None
        self._index: dict[str, UIAElementInfo] = {}
        # 방금 고른 행의 칸 자리(화면 좌표) — 행 메뉴를 그 자리에서 연다
        self._selected_cell = None

    # ---- 창·색인 ----
    def _find_main(self):
        # pywinauto 의 창 목록은 읽는 사이 창 하나가 사라지면 통째로 실패한다 — 직접 열거한다
        for hwnd, title, _kind in _all_windows():
            if WINDOW_TITLE_MARK in title and LOGIN_MARK not in title:
                return HwndWrapper(hwnd)
        raise AdapterRetry(ExportFail.WINDOW_MISSING, 'EMP 창이 없다')

    def _refresh(self) -> None:
        index: dict[str, UIAElementInfo] = {}
        for hwnd in _visible_children(self._main.handle):
            try:
                info = UIAElementInfo(hwnd)
                auto_id = info.automation_id
            except Exception:  # noqa: BLE001, S112 — 열거 사이에 사라진 창은 건너뛴다
                continue
            if auto_id and auto_id not in index:
                index[auto_id] = info
        self._index = index

    def _el(self, auto_id: str) -> UIAWrapper:
        if auto_id not in self._index:
            self._refresh()
        info = self._index.get(auto_id)
        if info is None:
            raise AdapterRetry(ExportFail.BLOCKED, f'EMP 화면에서 {auto_id!r} 요소를 찾지 못했다')
        return UIAWrapper(info)

    def _stop_if_user_back(self) -> None:
        """사람이 돌아왔으면 멈춘다. 다음 동작을 시작하기 전마다 부른다."""
        if self._guard and self._user_active is not None and self._user_active():
            raise AdapterRetry(ExportFail.BUSY, '사람이 PC 를 쓰기 시작해 멈췄다')

    @contextlib.contextmanager
    def _cleanup(self) -> Iterator[None]:
        """뒷정리 구간 — 사람이 돌아왔어도 끝까지 한다."""
        before = self._guard
        self._guard = False
        try:
            yield
        finally:
            self._guard = before

    def ensure_ready(self) -> None:
        """창이 있고 최소화가 풀려 있으며 모달 대화상자에 막히지 않았다."""
        self._stop_if_user_back()
        self._main = self._find_main()
        if not self._main.is_minimized() and _user32.GetForegroundWindow() != self._main.handle:
            # EMP 그리드는 창이 뒤에 있으면 칸 편집·행 메뉴가 열리다 말다 한다(실기 2026-09-29).
            # 작업자는 사람이 3분 넘게 자리를 비웠을 때만 EMP 를 만지므로 창을 앞으로 가져온다 —
            # 뒤에 있는 창을 바로 부르는 것은 윈도우가 막아서, 최소화했다 복원한다
            self._main.minimize()
            time.sleep(self._poll_s)
        if self._main.is_minimized():
            self._main.restore()
            time.sleep(self._poll_s * 2)
        if not self._main.is_enabled():
            # 앞선 시도가 남긴 '저장하시겠습니까' 창이면 닫고 계속한다. 다른 창이면 건드리지 않고 물러난다
            try:
                # 대화상자는 UIA 로 늦게 읽힐 때가 있다 — 6초로는 '저장하시겠습니까' 창을 못 읽고 막힘으로
                # 끝났다(2026-09-29 저녁 EMP 9건이 6시간 멈춤). 넉넉히 기다리며 닫는다
                self._wait_enabled(40.0)
            except AdapterRetry as e:
                titles = [title for _h, title, _k in _process_windows(self._main.process_id())]
                auth = next((t for t in titles if any(m in t for m in AUTH_MARKS)), None)
                if auth:
                    raise AdapterRetry(
                        ExportFail.AUTH_REQUIRED, f'EMP {auth[:40]} 창 — 직접 인증 필요'
                    ) from e
                shown = ', '.join(t[:30] for t in titles if t and WINDOW_TITLE_MARK not in t)
                raise AdapterRetry(
                    ExportFail.BLOCKED, f'EMP 에 대화상자가 떠 있다: {shown or "(제목 없음)"}'
                ) from e
        self._refresh()
        if GRID_ID not in self._index:
            raise AdapterRetry(ExportFail.BLOCKED, 'EMP 주문관리 그리드가 화면에 없다')

    # ---- 그리드 ----
    def rows(self) -> list[GridRow]:
        """지금 그리드에 보이는 데이터 행들."""
        elements = [
            c for c in self._el(GRID_ID).children() if c.element_info.control_type == 'Custom'
        ]
        if not elements:
            return []
        header = (elements[0].legacy_properties().get('Value') or '').split('\t')
        out: list[GridRow] = []
        for number, el in enumerate(elements[1:], start=1):
            cells = (el.legacy_properties().get('Value') or '').split('\t')
            values = {name: cells[i] for i, name in enumerate(header) if name and i < len(cells)}
            out.append(GridRow(el, number, values))
        return out

    def find_row(self, order_no: str) -> GridRow:
        """주문번호가 맞는 행 하나. 없으면 재시도(NOT_FOUND), 여러 개면 거절(AMBIGUOUS)."""
        hits = [r for r in self.rows() if order_matches(order_no, r.values.get(COL_ORDER_NO, ''))]
        if not hits:
            # 방금 들어온 주문은 EMP 가 아직 수집하지 않았을 수 있다 — 나중에 다시 본다
            raise AdapterRetry(ExportFail.NOT_FOUND, 'EMP 그리드에 그 주문번호가 없다')
        if len(hits) > 1:
            raise AdapterReject(
                ExportFail.AMBIGUOUS, f'EMP 그리드에 그 주문번호 행이 {len(hits)}개다'
            )
        return hits[0]

    def seller_code(self, order_no: str) -> str:
        """그 주문 행의 판매자상품코드. 비어 있으면 빈 글자."""
        return (self.find_row(order_no).values.get(COL_SELLER_CODE) or '').strip()

    def read(self, order_no: str) -> CellValues:
        row = self.find_row(order_no)
        return CellValues(
            parse_won(row.values.get(COL_COST)),
            parse_won(row.values.get(COL_SHIPPING)),
            (row.values.get(COL_NOTE) or '').strip(),
        )

    def _cell(self, row: GridRow, prefix: str):
        """행의 보이는 셀 중 이름이 '<prefix> Row N' 인 것."""
        want = f'{prefix} Row {row.number}'
        for cell in row.element.children():
            if (cell.element_info.name or '') == want:
                return cell
        raise AdapterRetry(ExportFail.BLOCKED, f'EMP 그리드에 {prefix!r} 열이 화면에 보이지 않는다')

    # ---- 검색 조건 ----
    def _ribbon_item(self, name: str):
        """리본 안의 요소 하나(콤보 상자·버튼). 리본 요소는 창 핸들이 없어 이름으로 찾는다."""

        def walk(element, depth: int):
            for child in element.children():
                info = child.element_info
                if (info.name or '') == name and info.control_type in ('Button', 'ComboBox'):
                    return child
                if depth < 5:
                    hit = walk(child, depth + 1)
                    if hit is not None:
                        return hit
            return None

        item = walk(self._el(RIBBON_ID), 0)
        if item is None:
            raise AdapterRetry(ExportFail.BLOCKED, f'EMP 검색 영역에 {name!r} 가 없다')
        return item

    def _ribbon_date(self, name: str) -> dt.date | None:
        text = (self._ribbon_item(name).legacy_properties().get('Value') or '').strip()
        try:
            return dt.date.fromisoformat(text)
        except ValueError:
            return None

    def _invoke(self, name: str, timeout_s: float = 15.0) -> None:
        """리본 버튼을 누른다. 리본은 창에 보낸 클릭 메시지를 받지 않는다(실기) — UIA 동작을 쓴다.

        대화상자가 뜨면 동작 호출이 돌아오지 않으므로 따로 돌리고 기다리는 시간을 둔다.
        """
        button = self._ribbon_item(name)
        errors: list[Exception] = []

        def run() -> None:
            try:
                button.invoke()
            except Exception as e:  # noqa: BLE001 — 아래에서 재시도로 바꿔 던진다
                errors.append(e)

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(timeout_s)
        if errors:
            raise AdapterRetry(
                ExportFail.BLOCKED, f'EMP {name!r} 버튼을 누르지 못했다: {errors[0]}'
            )

    def _keyword_handle(self) -> int:
        """검색어 칸의 창 핸들. 리본 요소에는 핸들이 없어, 자리가 같은 편집 창을 찾는다."""
        box = self._ribbon_item(KEYWORD_BOX)
        edit = next((c for c in box.children() if c.element_info.control_type == 'Edit'), None)
        if edit is None:
            raise AdapterRetry(ExportFail.BLOCKED, 'EMP 검색어 칸이 없다')
        want = edit.rectangle()
        for hwnd in _visible_children(self._main.handle):
            try:
                info = UIAElementInfo(hwnd)
                rect = info.rectangle
            except Exception:  # noqa: BLE001, S112 — 열거 사이에 사라진 창
                continue
            same = (rect.left, rect.top, rect.right, rect.bottom) == (
                want.left,
                want.top,
                want.right,
                want.bottom,
            )
            if info.control_type == 'Edit' and same:
                return hwnd
        raise AdapterRetry(ExportFail.BLOCKED, 'EMP 검색어 칸의 창을 찾지 못했다')

    def set_keyword(self, text: str) -> None:
        """검색어 칸에 글자를 넣는다(검색은 따로 누른다)."""
        hwnd = self._keyword_handle()
        _user32.SendMessageW(hwnd, _WM_SETTEXT, 0, ctypes.c_wchar_p(text))
        if self._window_text(hwnd) != text:
            raise AdapterRetry(ExportFail.BLOCKED, 'EMP 검색어 칸에 글자가 들어가지 않았다')

    def show_only(self, order_no: str) -> None:
        """그 주문만 그리드에 띄운다 — 행이 많으면 대상 행이 화면 밖이라 누를 수 없다.

        주문번호가 두 토막이면(GS이숍) 토막마다 검색해 본다. 끝나면 clear_keyword() 로 되돌린다.
        """
        # 구분 글자(':' · 공백)로 나눈 토막마다 검색한다 — EMP 검색은 한 토막만 받는다
        for word in dict.fromkeys(t for t in re.split(r'[:\s]+', order_no.strip()) if t):
            self.set_keyword(word)
            self.search()
            if any(order_matches(order_no, r.values.get(COL_ORDER_NO, '')) for r in self.rows()):
                return
        raise AdapterRetry(ExportFail.NOT_FOUND, 'EMP 그리드에 그 주문번호가 없다')

    def clear_keyword(self) -> None:
        """검색어를 지우고 다시 검색해 목록을 되돌린다."""
        with self._cleanup():
            self.set_keyword('')
            self.search()

    def search(self, today: dt.date | None = None) -> None:
        """검색 기간에 오늘이 들어가게 한 뒤 검색시작을 눌러 그리드를 다시 채운다.

        종료일이 어제로 남아 있으면 오늘 들어온 주문이 그리드에 없다(실기 2026-09-29).
        """
        self._stop_if_user_back()
        today = today or dt.datetime.now().astimezone().date()
        start, end = self._ribbon_date(START_DATE), self._ribbon_date(END_DATE)
        if (start, end) != period_to_cover(start, end, today):
            self._invoke(TWO_WEEKS_BUTTON)
            time.sleep(self._poll_s * 2)
            start, end = self._ribbon_date(START_DATE), self._ribbon_date(END_DATE)
            if end is None or end < today or start is None or start > today:
                raise AdapterRetry(
                    ExportFail.BLOCKED, f'EMP 검색 기간을 오늘까지로 바꾸지 못했다({start} ~ {end})'
                )
            log.info('EMP 검색 기간 %s ~ %s', start, end)
        self._invoke(SEARCH_BUTTON)
        time.sleep(self._poll_s * 4)
        dialog = self._wait_dialog(1.0)
        if dialog is not None:
            _handle, title, message, buttons = dialog
            if UNSAVED_MARK not in message:
                raise AdapterRetry(
                    ExportFail.BLOCKED, f'EMP 검색 뒤 창이 떴다: {title[:20]!r} {message[:60]!r}'
                )
            self._click_dialog_button(buttons, NO_BUTTONS)
            log.warning('EMP 에 저장 안 된 편집이 남아 있어 버렸다')
        self._wait_enabled(60.0)
        self._wait_rows_settled()
        self._refresh()

    def _wait_rows_settled(self, timeout_s: float = 60.0) -> None:
        """그리드 행 수가 연달아 같게 읽힐 때까지 기다린다(검색 결과를 채우는 중일 수 있다)."""
        deadline = time.monotonic() + timeout_s
        last = -1
        while time.monotonic() < deadline:
            try:
                count = len(self.rows())
            except Exception:  # noqa: BLE001 — 채우는 중에는 요소가 사라진다
                count = -1
            if count >= 0 and count == last:
                return
            last = count
            time.sleep(self._poll_s * 2)
        raise AdapterRetry(ExportFail.TIMEOUT, 'EMP 검색 결과가 자리 잡지 않았다')

    # ---- 취소 ----
    def _post_click(self, hwnd: int, rect) -> None:
        point = wintypes.POINT((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
        _user32.ScreenToClient(hwnd, ctypes.byref(point))
        lparam = (point.y << 16) | (point.x & 0xFFFF)
        for message, wparam in ((_WM_MOUSEMOVE, 0), (_WM_LBUTTONDOWN, 1), (_WM_LBUTTONUP, 0)):
            _user32.PostMessageW(hwnd, message, wparam, lparam)
            time.sleep(0.05)

    def _select_row(self, order_no: str) -> GridRow:
        """그 주문 행을 고르고, 상세 미리보기의 주문번호로 고른 행이 맞는지 확인한다."""
        row = self.find_row(order_no)
        area = self._el(GRID_ID).rectangle()
        cell = None
        for candidate in row.element.children():
            rect = candidate.rectangle()
            inside = area.left < rect.left and rect.right < area.right
            if rect.width() > 30 and inside and area.top < rect.top and rect.bottom < area.bottom:
                cell = candidate
                break
        if cell is None:
            raise AdapterRetry(ExportFail.BLOCKED, 'EMP 그리드에서 그 주문 행이 화면 밖이다')
        self._focus_grid()
        self._selected_cell = cell.rectangle()
        self._post_click(self._el(GRID_ID).element_info.handle, cell.rectangle())
        # 상세 미리보기는 조금 늦게 바뀐다 — 그 주문번호가 보일 때까지 기다린다
        self._index.pop(PREVIEW_ORDER_NO, None)
        preview = self._el(PREVIEW_ORDER_NO).element_info.handle
        deadline = time.monotonic() + 10.0
        shown = ''
        while time.monotonic() < deadline:
            shown = self._window_text(preview).strip()
            if order_matches(order_no, shown):
                return row
            time.sleep(self._poll_s * 2)
            # 검색 직후에는 그리드가 클릭을 놓칠 때가 있다(실기 2026-09-29) — 다시 누른다
            self._post_click(self._el(GRID_ID).element_info.handle, cell.rectangle())
        raise AdapterRetry(
            ExportFail.BLOCKED, f'EMP 에서 고른 행이 그 주문이 아니다({shown[:24]!r})'
        )

    def _popups(self, before: set[int]) -> list[int]:
        pid = self._main.process_id()
        return [h for h, _title, _kind in _process_windows(pid) if h not in before]

    def _menu_items(self, before: set[int], name: str) -> list:
        """새로 뜬 메뉴 창들에서 이름이 name 으로 시작하는 켜진 항목들."""
        found = []
        for handle in self._popups(before):
            try:
                items = UIAWrapper(UIAElementInfo(handle)).descendants(control_type='MenuItem')
            except Exception:  # noqa: BLE001, S112 — 이미 닫힌 창
                continue
            for item in items:
                text = (item.element_info.name or '').strip()
                if text.split(' (')[0] == name and item.is_enabled():
                    found.append((handle, item))
        return found

    def _close_menus(self, before: set[int]) -> None:
        for handle in self._popups(before):
            _user32.PostMessageW(handle, _WM_KEYDOWN, _VK_ESCAPE, 0)
            _user32.PostMessageW(handle, _WM_KEYUP, _VK_ESCAPE, 0)

    def _open_row_menu(self, grid: int, before: set[int]) -> list:
        """고른 행의 행 메뉴를 열고 상태변경 항목을 돌려준다.

        우클릭 메시지로 열고, 안 뜨면 메뉴 키를 보낸다(실기 2026-09-29: 뒤에 있는 창에서는
        한 가지만으로는 안 뜰 때가 있다).
        """
        row_cell = self._selected_cell
        point = wintypes.POINT(
            (row_cell.left + row_cell.right) // 2, (row_cell.top + row_cell.bottom) // 2
        )
        _user32.ScreenToClient(grid, ctypes.byref(point))
        lparam = (point.y << 16) | (point.x & 0xFFFF)
        tries = (
            ((_WM_RBUTTONDOWN, 2, lparam), (_WM_RBUTTONUP, 0, lparam)),
            ((_WM_KEYDOWN, _VK_APPS, 0), (_WM_KEYUP, _VK_APPS, 0xC0000001)),
        )
        for messages in tries:
            for message, wparam, lp in messages:
                _user32.PostMessageW(grid, message, wparam, lp)
                time.sleep(0.05)
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                found = self._menu_items(before, MENU_STATE)
                if found:
                    return found
                time.sleep(self._poll_s)
        return []

    def _open_state_menu(self, menu_handle: int, state_item, before: set[int]) -> list:
        """상태변경의 아래 메뉴를 열고 취소 항목을 돌려준다. 누르기 → 안 열리면 UIA 동작으로 연다."""

        def expand() -> None:
            try:
                state_item.invoke()
            except Exception:  # noqa: BLE001 — 안 열렸으면 아래에서 빈 목록으로 끝난다
                log.info('EMP 상태변경 메뉴를 UIA 동작으로 열지 못했다')

        def by_click() -> None:
            self._post_click(menu_handle, state_item.rectangle())

        for opener in (by_click, expand):
            worker = threading.Thread(target=opener, daemon=True)
            worker.start()
            worker.join(5.0)
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                found = self._menu_items(before, MENU_CANCEL)
                if found:
                    return found
                time.sleep(self._poll_s)
        return []

    def _press_quietly(self, item) -> None:
        try:
            item.invoke()
        except Exception:  # noqa: BLE001 — 눌렸는지는 뒤의 상태 되읽기로 확인한다
            log.info('EMP 메뉴 항목 누르기가 오류로 끝났다')

    def cancel(self, order_no: str, *, dry_run: bool = False) -> None:
        """행 메뉴 → 상태변경 → 취소. 창 메시지로만 한다(실제 마우스·키보드는 쓰지 않는다)."""
        if (self.find_row(order_no).values.get(COL_STATE) or '').strip() == STATE_CANCELLED:
            return
        self._stop_if_user_back()
        self._select_row(order_no)
        grid = self._el(GRID_ID).element_info.handle
        before = {h for h, _title, _kind in _process_windows(self._main.process_id())}
        try:
            state = self._open_row_menu(grid, before)
            if not state:
                raise AdapterRetry(ExportFail.BLOCKED, 'EMP 행 메뉴에 상태변경 이 없다')
            menu_handle, state_item = state[0]
            targets = self._open_state_menu(menu_handle, state_item, before)
            if not targets:
                raise AdapterRetry(
                    ExportFail.BLOCKED, 'EMP 상태변경 메뉴에 취소 가 없다(또는 꺼져 있다)'
                )
            if dry_run:
                log.info('EMP 취소 항목까지 확인(누르지 않음): %s', order_no)
                self._close_menus(before)
                return
            # 취소를 누르기 직전이 마지막 확인이다 — 누른 뒤에는 확인 창을 닫는 데까지 끝낸다
            self._stop_if_user_back()
            _handle, item = targets[0]
            # 메뉴 창에 보낸 클릭은 먹지 않았다(실기 2026-09-29: 상태가 그대로) — UIA 동작으로 누른다.
            # 누르면 확인 창이 떠서 호출이 돌아오지 않으므로 따로 돌리고 기다리지 않는다
            threading.Thread(target=self._press_quietly, args=(item,), daemon=True).start()
        except AdapterRetry:
            # 열어 둔 메뉴를 남기지 않는다
            with self._cleanup():
                self._close_menus(before)
            raise
        with self._cleanup():
            time.sleep(self._poll_s * 2)
            self._settle_after_cancel()
            self.reload()
        got = (self.find_row(order_no).values.get(COL_STATE) or '').strip()
        if got != STATE_CANCELLED:
            raise AdapterReject(
                ExportFail.VERIFY_MISMATCH, f'EMP 상태를 취소로 바꿨는데 {got!r} 로 읽힌다'
            )

    def _settle_after_cancel(self, timeout_s: float = 90.0) -> None:
        """취소 뒤 뜨는 창을 처리한다 — 아는 문구(취소·변경 확인, 완료 안내)만 누르고 나머지는 거절한다.

        확인 창('선택하신 1건의 주문의 상태를 취소 상태로 강제 변경 하시겠습니까?')은 30초 뒤 스스로
        실행된다(실기 2026-09-29). 메뉴 누름 호출이 끝나지 않은 동안에는 문구를 읽을 수 없어,
        못 읽으면 누르지 않고 스스로 실행될 때까지 기다린다. 읽었는데 1건이 아니면 물러난다.
        """
        # 1) 확인 창이 스스로 실행돼 닫힐 때까지 기다린다. 이 동안 UIA 는 쓰지 않는다 — 메뉴 누름
        #    호출이 끝나지 않은 채 UIA 로 창을 읽으면 작업자가 통째로 멈춘다(실기 2026-09-29: 10분 넘게 무응답)
        pid = self._main.process_id()
        auto_run = time.monotonic() + AUTO_RUN_WAIT_S
        while time.monotonic() < auto_run:
            if not any(kind == DIALOG_CLASS for _h, _t, kind in _process_windows(pid)):
                break
            time.sleep(self._poll_s)
        # 2) 그 뒤에 남았거나 새로 뜬 창(완료 안내 등)을 읽어 처리한다
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            found = self.dialogs()
            if not found:
                if self._main.is_enabled():
                    return
                time.sleep(self._poll_s)
                continue
            _handle, title, message, buttons = found[0]
            if not message.strip() or not buttons:
                # 아직 다 그려지지 않았거나 스스로 닫히는 진행 창이다 — 누르지 않고 기다린다
                time.sleep(self._poll_s)
                continue
            count = _SELECTED_COUNT.search(message)
            if count is not None and int(count.group(1)) != 1:
                self._click_dialog_button(buttons, NO_BUTTONS)
                raise AdapterReject(
                    ExportFail.AMBIGUOUS,
                    f'EMP 취소 확인 창이 {count.group(1)}건을 묻는다 — 누르지 않았다',
                )
            known = ('취소' in message or '변경' in message) and UNSAVED_MARK not in message
            if not known:
                raise AdapterReject(
                    ExportFail.UNKNOWN,
                    f'EMP 취소 뒤 모르는 창이 떴다: {title[:20]!r} {message[:60]!r}',
                )
            pressed = self._click_dialog_button(buttons, (*YES_BUTTONS, *OK_BUTTONS))
            log.info('EMP 취소 확인 창(%r) 에서 %r 을 눌렀다', message[:60], pressed)
            time.sleep(self._poll_s * 2)
        raise AdapterRetry(ExportFail.BLOCKED, 'EMP 취소 뒤 창이 닫히지 않았다')

    # ---- 쓰기 ----
    def _focus(self) -> tuple[int, str]:
        """EMP 화면 스레드에서 키보드 포커스를 가진 창과 그 창 종류."""
        info = _GuiThreadInfo()
        info.cbSize = ctypes.sizeof(_GuiThreadInfo)
        thread = _user32.GetWindowThreadProcessId(self._main.handle, None)
        _user32.GetGUIThreadInfo(thread, ctypes.byref(info))
        hwnd = info.hwndFocus or 0
        name = ctypes.create_unicode_buffer(256)
        if hwnd:
            _user32.GetClassNameW(hwnd, name, 256)
        return hwnd, name.value

    def _window_text(self, hwnd: int, size: int = 128) -> str:
        buf = ctypes.create_unicode_buffer(size)
        _user32.SendMessageTimeoutW(hwnd, _WM_GETTEXT, size, buf, 0x0002, 2000, None)
        return buf.value

    def _wait_focus(self, want_edit: bool, timeout_s: float = 3.0) -> int:
        """포커스가 편집 상자로 가거나(want_edit) 그리드로 돌아올 때까지 기다린다."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            hwnd, cls = self._focus()
            if hwnd and ('EDIT' in cls.upper()) == want_edit:
                return hwnd
            time.sleep(0.1)
        what = '편집 상자가 열리지' if want_edit else '편집이 끝나지'
        raise AdapterRetry(ExportFail.TIMEOUT, f'EMP 칸 {what} 않았다')

    def _focus_grid(self) -> None:
        """키보드 포커스를 그리드로 옮긴다.

        주문번호로 검색한 뒤에는 포커스가 검색어 칸에 남아, 그리드에 보낸 클릭·글자가 먹지 않았다
        (실기 2026-09-29: '그리드가 포커스를 받지 못했다(…EDIT…)').
        """
        grid = self._el(GRID_ID)
        if self._focus()[0] == grid.element_info.handle:
            return
        try:
            grid.set_focus()
        except Exception:  # noqa: BLE001 — 못 옮겼으면 아래 확인에서 걸린다
            log.info('EMP 그리드로 포커스를 옮기지 못했다')
        time.sleep(self._poll_s)

    def _edit_cell(self, order_no: str, prefix: str, column: str, value: int | str) -> None:
        """그리드 칸 하나에 값을 넣는다(저장 전).

        실제 마우스·전역 키 입력은 쓰지 않는다 — 다른 창이 앞에 있으면 글자가 그 창으로 샌다
        (실기 2026-09-28: 채팅창에 입력됨). 그리드 창 핸들에 메시지를 직접 보낸다:
        칸 더블클릭 → 숫자 한 글자(편집 상자가 열린다) → 편집 상자에 값을 통째로 넣고 되읽기 →
        Enter → 행 값 확인. 글자를 하나씩 보내면 기존 값과 섞인다(실기: 57131 → 507131).
        """
        self._stop_if_user_back()
        row = self.find_row(order_no)
        cell = self._cell(row, prefix)
        grid = self._el(GRID_ID).element_info.handle
        rect = cell.rectangle()
        area = self._el(GRID_ID).rectangle()
        if not (area.left <= rect.left and rect.right <= area.right and area.top < rect.top):
            raise AdapterRetry(ExportFail.BLOCKED, f'EMP 그리드에서 {column} 칸이 화면 밖이다')
        if rect.bottom > area.bottom:
            raise AdapterRetry(ExportFail.BLOCKED, 'EMP 그리드에서 그 주문 행이 화면 밖이다')
        self._focus_grid()
        point = wintypes.POINT((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
        _user32.ScreenToClient(grid, ctypes.byref(point))
        lparam = (point.y << 16) | (point.x & 0xFFFF)
        for message, wparam in (
            (_WM_LBUTTONDOWN, 1),
            (_WM_LBUTTONUP, 0),
            (_WM_LBUTTONDBLCLK, 1),
            (_WM_LBUTTONUP, 0),
        ):
            _user32.PostMessageW(grid, message, wparam, lparam)
            time.sleep(0.05)
        time.sleep(self._poll_s)
        hwnd, cls = self._focus()
        text = str(value)
        if hwnd == grid:
            # 칸만 골라졌다 — 숫자 한 글자를 보내 편집 상자를 연다
            _user32.PostMessageW(grid, _WM_CHAR, ord(text[0]), 0)
            editor = self._wait_focus(want_edit=True)
        elif 'EDIT' in cls.upper():
            # 더블클릭으로 편집 상자가 바로 열렸다(창이 앞에 있을 때, 실기 2026-09-29) —
            # 검색어 칸 같은 다른 편집 상자일 수도 있으니 아래 위치 확인으로 가린다
            editor = hwnd
        else:
            raise AdapterRetry(ExportFail.BLOCKED, f'EMP 그리드가 포커스를 받지 못했다({cls})')
        # 편집 상자가 대상 칸 위에 열렸는지 본다 — 다른 칸(다른 주문 행·배송방법 등)에 열렸으면
        # 아무것도 넣지 않고 닫는다(실기 2026-09-29: 값이 다른 행에 찍혔다)
        box = wintypes.RECT()
        _user32.GetWindowRect(editor, ctypes.byref(box))
        middle_x, middle_y = (box.left + box.right) // 2, (box.top + box.bottom) // 2
        if not (rect.left <= middle_x <= rect.right and rect.top <= middle_y <= rect.bottom):
            if _user32.GetParent(editor) == grid:
                # 그리드의 편집 상자가 다른 칸에 열렸다 — 값 없이 닫고 그리드를 되돌린다
                _user32.PostMessageW(editor, _WM_KEYDOWN, _VK_ESCAPE, 0)
                _user32.PostMessageW(editor, _WM_KEYUP, _VK_ESCAPE, 0)
                time.sleep(self._poll_s)
                with self._cleanup():
                    self.reload()
            raise AdapterRetry(
                ExportFail.BLOCKED, f'EMP {column} 칸이 아닌 곳에 편집 상자가 열렸다({cls})'
            )
        _user32.SendMessageW(editor, _WM_SETTEXT, 0, ctypes.c_wchar_p(text))
        if self._window_text(editor) != text:
            _user32.PostMessageW(editor, _WM_KEYDOWN, _VK_ESCAPE, 0)
            _user32.PostMessageW(editor, _WM_KEYUP, _VK_ESCAPE, 0)
            raise AdapterReject(
                ExportFail.VERIFY_MISMATCH, f'EMP 편집 상자에 {column} 값이 들어가지 않았다'
            )
        _user32.PostMessageW(editor, _WM_KEYDOWN, _VK_RETURN, 0)
        _user32.PostMessageW(editor, _WM_KEYUP, _VK_RETURN, 0)
        self._wait_focus(want_edit=False)
        time.sleep(self._poll_s)
        shown = self.find_row(order_no).values.get(column)
        got = parse_won(shown) if isinstance(value, int) else (shown or '').strip()
        if got != value:
            # 값이 다른 칸에 들어갔을 수 있다(실기 2026-09-29: 다른 주문 행에 찍힘) — 저장하지 않고
            # 그리드를 서버 값으로 되돌린다. 남겨 두면 사람이 저장을 누를 때 함께 저장된다
            self.reload()
            raise AdapterReject(
                ExportFail.VERIFY_MISMATCH,
                f'EMP {column} 칸에 {value!r} 을 넣었는데 {got!r} 로 읽힌다',
            )

    def _toolbar_button(self, name: str):
        for item in self._el(TOOLBAR_ID).children():
            if item.element_info.name == name:
                return item
        raise AdapterRetry(ExportFail.BLOCKED, f'EMP 툴바에 {name!r} 버튼이 없다')

    def _press_toolbar(self, name: str) -> None:
        """툴바 버튼을 누른다 — 툴바 창에 클릭 메시지를 보낸다(UIA invoke 는 대화상자가 뜨면 막힌다)."""
        button = self._toolbar_button(name)
        if not button.is_enabled():
            raise AdapterRetry(ExportFail.BLOCKED, f'EMP {name!r} 버튼이 꺼져 있다')
        toolbar = self._el(TOOLBAR_ID).element_info.handle
        rect = button.rectangle()
        point = wintypes.POINT((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
        _user32.ScreenToClient(toolbar, ctypes.byref(point))
        lparam = (point.y << 16) | (point.x & 0xFFFF)
        _user32.PostMessageW(toolbar, _WM_LBUTTONDOWN, 1, lparam)
        time.sleep(0.05)
        _user32.PostMessageW(toolbar, _WM_LBUTTONUP, 0, lparam)

    def dialogs(self) -> list[tuple[int, str, str, list]]:
        """EMP 가 띄운 보이는 대화상자들 — (핸들, 제목, 문구, 버튼 요소들).

        EMP 의 확인 창은 자식 창에 글자가 없는 새 모양 대화상자라 UIA 로 읽어야 한다(자식 창을
        직접 읽으면 문구·버튼이 비어 온다, 실기 2026-09-29). 메뉴 항목을 누르는 호출이 끝나지 않은
        동안에는 UIA 도 빈 값을 주므로, 부르는 쪽이 빈 문구를 '아직 못 읽음'으로 보고 다시 읽는다.
        """
        found = []
        pid = self._main.process_id()
        for handle, title, kind in _process_windows(pid):
            if kind != DIALOG_CLASS:
                continue
            try:
                dialog = UIAWrapper(UIAElementInfo(handle))
                message = ' '.join(t.window_text() for t in dialog.descendants(control_type='Text'))
                buttons = dialog.descendants(control_type='Button')
            except Exception:  # noqa: BLE001 — 읽지 못했다(닫히는 중이거나 UIA 가 바쁘다)
                message, buttons = '', []
            found.append((handle, title, message, buttons))
        return found

    def _click_dialog_button(self, buttons: list, names: tuple[str, ...]) -> str | None:
        for b in buttons:
            if b.window_text() in names:
                label = b.window_text()
                # 버튼에 직접 보내는 누름 메시지는 뒤에 있는 대화상자에서 먹지 않는다(실기 2026-09-29) —
                # 대화상자에 '이 버튼이 눌렸다'를 보낸다
                hwnd = b.element_info.handle
                _user32.PostMessageW(
                    _user32.GetParent(hwnd), _WM_COMMAND, _user32.GetDlgCtrlID(hwnd), hwnd
                )
                return label
        return None

    def _wait_dialog(self, timeout_s: float) -> tuple[int, str, str, list] | None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            # 문구를 읽은 창만 돌려준다 — 빈 문구는 아직 못 읽은 것이라 다시 읽는다
            found = [d for d in self.dialogs() if d[2].strip()]
            if found:
                return found[0]
            time.sleep(self._poll_s)
        return None

    def _close_editor(self) -> None:
        """열려 있는 편집 상자를 값 없이 닫는다."""
        hwnd, cls = self._focus()
        if hwnd and 'EDIT' in cls.upper():
            _user32.PostMessageW(hwnd, _WM_KEYDOWN, _VK_ESCAPE, 0)
            _user32.PostMessageW(hwnd, _WM_KEYUP, _VK_ESCAPE, 0)
            time.sleep(self._poll_s)

    def save(self) -> None:
        """저장을 누르고 '저장완료' 안내창을 닫는다. 다른 창이 뜨면 건드리지 않고 거절한다."""
        self._press_toolbar(SAVE_BUTTON)
        dialog = self._wait_dialog(30.0)
        if dialog is None:
            raise AdapterRetry(ExportFail.TIMEOUT, 'EMP 저장 뒤 안내창이 뜨지 않았다')
        _handle, title, message, buttons = dialog
        if SAVED_MARK not in message:
            raise AdapterReject(
                ExportFail.UNKNOWN, f'EMP 저장 뒤 모르는 창이 떴다: {title[:20]!r} {message[:60]!r}'
            )
        self._click_dialog_button(buttons, OK_BUTTONS)
        self._wait_enabled()

    def _wait_enabled(self, timeout_s: float = 20.0) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            found = self.dialogs()
            if self._main.is_enabled() and not found:
                return
            for _handle, _title, message, buttons in found:
                # 저장 안 된 편집을 묻는 창은 늦게 읽혀도 여기서 닫는다 — 우리가 넣은 값은 저장을 거친
                # 뒤에만 남기므로, 이 창이 뜬 것은 버려도 되는 값이다(실기 2026-09-29: 창이 남아 EMP 가 막혔다)
                if UNSAVED_MARK in message:
                    self._click_dialog_button(buttons, NO_BUTTONS)
                    log.warning('EMP 에 저장 안 된 편집이 남아 있어 버렸다')
            time.sleep(self._poll_s)
        raise AdapterRetry(ExportFail.BLOCKED, 'EMP 대화상자가 닫히지 않았다')

    def reload(self) -> None:
        """새로고침 — 서버에 저장된 값으로 그리드를 다시 채운다.

        저장 안 된 편집이 남아 있으면 EMP 가 '저장하시겠습니까?' 를 묻는다. 우리가 넣은 값은
        save() 로 이미 저장했으므로 여기서 묻는다면 뜻하지 않은 편집이다 — '아니요'로 버린다.
        """
        self._press_toolbar(REFRESH_BUTTON)
        dialog = self._wait_dialog(3.0)
        if dialog is not None:
            _handle, title, message, buttons = dialog
            if UNSAVED_MARK not in message:
                raise AdapterReject(
                    ExportFail.UNKNOWN,
                    f'EMP 새로고침 뒤 모르는 창이 떴다: {title[:20]!r} {message[:60]!r}',
                )
            self._click_dialog_button(buttons, NO_BUTTONS)
            log.warning('EMP 에 저장 안 된 편집이 남아 있어 버렸다')
            self._wait_enabled()
        time.sleep(self._poll_s * 4)
        self._refresh()

    def write(self, order_no: str, cost: int, shipping_fee: int, memo: str = '') -> None:
        """원가·배송비(·한줄메모) 칸에 값을 넣고 저장한 뒤 새로고침한다. 이미 같은 값인 칸은 건드리지 않는다.

        한줄메모는 그 글이 이미 들어 있으면 두고, 다른 글이 있으면 ' / ' 로 뒤에 붙인다(사람이 쓴 글을 지우지 않는다).
        """
        current = self.read(order_no)
        try:
            if (current.cost or 0) != cost:
                self._edit_cell(order_no, CELL_COST, COL_COST, cost)
            if (current.shipping_fee or 0) != shipping_fee:
                self._edit_cell(order_no, CELL_SHIPPING, COL_SHIPPING, shipping_fee)
            note = current.memo or ''
            if memo and memo not in note:
                self._edit_cell(order_no, CELL_NOTE, COL_NOTE, f'{note} / {memo}' if note else memo)
            # 저장을 누르기 직전이 마지막 확인이다 — 누른 뒤에는 안내창을 닫는 데까지 끝낸다
            self._stop_if_user_back()
        except AdapterRetry as e:
            if e.reason is ExportFail.BUSY:
                # 넣다 만 값을 남기지 않는다 — 사람이 저장을 누르면 함께 저장된다
                with self._cleanup():
                    self._close_editor()
                    self.reload()
            raise
        with self._cleanup():
            self.save()
            self.reload()
