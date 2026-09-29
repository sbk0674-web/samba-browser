"""샵마인 화면 드라이버 — pywinauto. ShopMineUi 규약을 실제 창에 대고 수행한다.

컨트롤은 automation id·이름·항목 목록으로 찾는다.
실제 마우스·키보드는 쓰지 않고 창을 앞으로 가져오지도 않는다 — 사용자가 PC 를 쓰는 동안
뒤에서 돈다(사용자 지시 2026-09-29). 누르기는 그 컨트롤 창에 메시지를 보내거나 UIA 동작으로 한다.
못 하는 상황(창 없음·수집 시간 초과·낯선 대화상자)은 AdapterRetry 로 던진다.

찾는 방법(실기 2026-09-28): 창 전체를 UIA 로 훑으면(descendants·child_window) 주문 수백 행 ×
56칸 때문에 한 번에 20초가 걸리고, 숨은 탭 페이지가 같은 automation id 를 갖고 있어 헷갈린다.
그래서 **보이는 자식 창 핸들**만 열거해(EnumChildWindows + IsWindowVisible, 0.01초) 핸들마다
UIA 요소를 만들어 automation id 색인을 만든다(약 4초). 숨은 탭 페이지의 컨트롤은 보이지 않는
창이라 색인에 들어오지 않는다. 그리드 행·툴바 항목은 그 요소의 children 만 읽는다(0.1초대).
"""

import ctypes
import datetime as dt
import functools
import logging
import re
import threading
import time
from collections.abc import Callable, Sequence
from ctypes import wintypes

from pywinauto import Desktop
from pywinauto.controls.hwndwrapper import InvalidWindowHandle
from pywinauto.controls.uiawrapper import UIAWrapper
from pywinauto.findwindows import ElementNotFoundError
from pywinauto.timings import TimeoutError as PwTimeoutError
from pywinauto.uia_defines import NoPatternInterfaceError
from pywinauto.uia_element_info import UIAElementInfo

from samba_agent.export.adapters import AdapterReject, AdapterRetry
from samba_agent.export.desktop.shopmine import order_matches
from samba_agent.export.failures import ExportFail

log = logging.getLogger(__name__)

WINDOW_TITLE_MARK = 'ShopMine::'
# 탭을 실제 클릭으로 바꿔도 되는 자리 비움 시간(초) — EMP 조작 조건과 같다
TAB_SWITCH_MIN_IDLE_S = 180.0
# 사람이 처리해야 하는 인증 창 제목에 들어 있는 글자(실기 2026-09-29: '관리자 추가인증')
AUTH_MARKS = ('인증', '로그인', 'OTP')
ORDER_TAB = '통합주문관리'
ORDER_MENU = '주문관리'
NORMAL_ALL = '(정상전체)'
FILTER_STATUS = '미지정'
FILTER_EXCEL = '엑셀생성안됨'
STATUS_MENU = '작업상태지정'
ORDER_NO_COLUMN = '주문번호'
# 쿠팡은 삼바웨이브 주문번호가 샵마인의 배송번호 칸에 있다(실기 2026-09-29: 736… ↔ 배송번호)
SHIPMENT_NO_COLUMN = '배송번호'
SELLER_CODE_COLUMN = '판매자상품코드'
_EMPTY_CELLS = ('', '(null)')
# 우리가 완료됨을 누른 뒤 뜨는 확인 대화상자에서 눌러도 되는 버튼 이름
CONFIRM_BUTTONS = ('예(Y)', '확인', 'OK', 'Yes')
# 확인 대화상자에서 물러날 때 누르는 버튼 이름
CANCEL_BUTTONS = ('아니요(N)', '아니오(N)', '취소', 'No', 'Cancel')
# 확인 대화상자 문구의 선택 개수('선택한 1개의 주문을 …')
_SELECTED_COUNT = re.compile(r'선택한\s*(\d+)\s*개')
# 완료됨 지정 뒤 결과 안내창 문구('[완료됨]으로 [작업상태지정] 되었습니다.')
RESULT_MARK = '되었습니다'
# 행별 선택 상태 셀 값이 '체크됨'으로 보이는 표시들
_CHECKED_MARKERS = ('true', '1', '선택', '체크', 'checked')

# 검색 기간 — 시작일은 적어도 이만큼 전, 종료일은 적어도 오늘(사용자 지시 2026-09-29)
PERIOD_BACK_DAYS = 14
START_DATE_ID = 'DtpStartDate'
END_DATE_ID = 'DtpEndDate'

_WM_KEYDOWN, _WM_KEYUP = 0x0100, 0x0101
_WM_MOUSEMOVE, _WM_LBUTTONDOWN, _WM_LBUTTONUP = 0x0200, 0x0201, 0x0202
_WM_COMMAND = 0x0111
_BM_CLICK = 0x00F5
_CB_GETCURSEL, _CB_SETCURSEL = 0x0147, 0x014E
_CBN_SELCHANGE = 1
_SW_SHOWNOACTIVATE = 4
_VK_RIGHT = 0x27

_user32 = ctypes.windll.user32
_ENUM_PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _new_windows(before: set[int], windows: list) -> list:
    """`before` 스냅숏(핸들 집합)에 없던 창만 남긴다 — 우리가 방금 띄운 창을 고르는 데 쓴다.

    순수 함수(pywinauto 를 부르지 않는다) — `windows` 는 `.handle` 속성만 있으면 된다.
    """
    return [w for w in windows if w.handle not in before]


def period_to_cover(
    start: dt.date | None, end: dt.date | None, today: dt.date, back_days: int = PERIOD_BACK_DAYS
) -> tuple[dt.date, dt.date]:
    """오늘이 들어가는 검색 기간. 이미 넉넉하면 그대로 둔다(순수 함수).

    종료일이 어제로 남아 있으면 오늘 들어온 주문이 목록에 없다(실기 2026-09-29: 12건 전부
    '주문을 찾지 못했다').
    """
    floor = today - dt.timedelta(days=back_days)
    new_start = start if start is not None and start <= floor else floor
    new_end = end if end is not None and end >= today else today
    return new_start, new_end


def _guard_pywinauto_errors(fn):
    """pywinauto 가 던지는 '요소 없음·시간 초과·패턴 없음' 을 AdapterRetry(BLOCKED) 로 감싼다.

    ShopMineUi 규약은 AdapterRetry/AdapterReject 만 밖으로 나가야 한다 — 원본 예외가
    그대로 새어 나가면 어댑터·CLI 가 처리하지 못하고 트레이스백으로 죽는다.
    """

    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        started = time.monotonic()
        try:
            return fn(self, *args, **kwargs)
        except (AdapterRetry, AdapterReject):
            raise
        except (ElementNotFoundError, PwTimeoutError, NoPatternInterfaceError) as e:
            raise AdapterRetry(ExportFail.BLOCKED, f'{fn.__name__}: {e}') from e
        except InvalidWindowHandle as e:
            # 창 목록을 읽는 사이 창이 사라졌다(실기 2026-09-29) — 다음에 다시 하면 된다
            raise AdapterRetry(ExportFail.BLOCKED, f'{fn.__name__}: {e}') from e
        finally:
            # 단계별 소요 — 실기에서 어느 단계가 느린지 본다
            log.info('샵마인 %s %.1f초', fn.__name__, time.monotonic() - started)

    return wrapper


def _post_click(hwnd: int, rect) -> None:
    """그 창의 화면 좌표 rect 가운데를 누른다 — 창에 메시지만 보낸다(실제 마우스는 그대로)."""
    point = wintypes.POINT((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
    _user32.ScreenToClient(hwnd, ctypes.byref(point))
    lparam = (point.y << 16) | (point.x & 0xFFFF)
    for message, wparam in ((_WM_MOUSEMOVE, 0), (_WM_LBUTTONDOWN, 1), (_WM_LBUTTONUP, 0)):
        _user32.PostMessageW(hwnd, message, wparam, lparam)
        time.sleep(0.05)


def _real_click(element) -> None:
    """실제 마우스로 누르고 커서를 원래 자리로 돌려놓는다 — 사람이 자리를 비웠을 때만 쓴다."""
    point = wintypes.POINT()
    _user32.GetCursorPos(ctypes.byref(point))
    try:
        element.click_input()
    finally:
        _user32.SetCursorPos(point.x, point.y)


def _press_button(button) -> None:
    """버튼을 누른다 — 버튼의 부모(대화상자·패널)에 '이 버튼이 눌렸다'를 보낸다.

    버튼에 직접 보내는 누름 메시지는 뒤에 있는 대화상자에서 먹지 않았다(실기 2026-09-29).
    """
    hwnd = button.element_info.handle
    _user32.PostMessageW(_user32.GetParent(hwnd), _WM_COMMAND, _user32.GetDlgCtrlID(hwnd), hwnd)


def _invoke(element, timeout_s: float = 10.0) -> None:
    """UIA 동작으로 누른다. 누른 결과 대화상자가 뜨면 호출이 돌아오지 않으므로 따로 돌린다."""
    errors: list[Exception] = []

    def run() -> None:
        try:
            element.invoke()
        except Exception as e:  # noqa: BLE001 — 아래에서 재시도로 바꿔 던진다
            errors.append(e)

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout_s)
    if errors:
        raise AdapterRetry(ExportFail.BLOCKED, f'누르지 못했다: {errors[0]!r}')


def _visible_children(hwnd: int) -> list[int]:
    """그 창의 보이는 자식 창 핸들(손자 포함)."""
    found: list[int] = []

    def collect(child, _lparam):
        if _user32.IsWindowVisible(child):
            found.append(child)
        return True

    _user32.EnumChildWindows(hwnd, _ENUM_PROC(collect), 0)
    return found


class PywinautoShopMineUi:
    """ShopMineUi 구현."""

    def __init__(
        self, *, poll_s: float = 0.5, user_idle_s: Callable[[], float] | None = None
    ) -> None:
        self._poll_s = poll_s
        # 사람이 키보드·마우스를 안 쓴 시간(초). 주면 배경 조작이 안 먹을 때 자리 비움에만 실제로 누른다
        self._user_idle_s = user_idle_s
        # 메인 창(win32 래퍼) — 핸들·최소화·활성 여부만 본다
        self._main = None
        # automation id → UIA 요소 정보(보이는 컨트롤만)
        self._index: dict[str, UIAElementInfo] = {}

    # ---- 창·색인 ----
    def _top_windows(self, pid: int) -> list:
        """같은 프로세스의 **보이는** 최상위 창들(win32 — 빠르다).

        이 프로그램은 숨은 최상위 창(툴팁·콤보 목록·메뉴)이 수백 개라, 숨은 것까지 하나씩
        UIA 로 열면 대화상자에 닿기 전에 시간이 다 간다(실기 2026-09-28: 결과 안내창을 놓침).
        """
        found = []
        for w in self._all_windows():
            try:
                if w.process_id() == pid and w.is_visible():
                    found.append(w)
            except Exception:  # noqa: BLE001, S112 — 열거 사이에 사라진 창
                continue
        return found

    def _all_windows(self) -> list:
        """최상위 창 목록. 읽는 사이 창 하나가 사라지면 목록 읽기가 통째로 실패한다(실기
        2026-09-29: 확인 창이 닫히는 순간) — 몇 번 다시 읽는다."""
        for _ in range(4):
            try:
                return Desktop(backend='win32').windows()
            except InvalidWindowHandle:
                time.sleep(0.2)
        return Desktop(backend='win32').windows()

    def _find_main(self):
        """ShopMine 메인 창. 없으면 AdapterRetry(WINDOW_MISSING)."""
        for w in self._all_windows():
            if (w.window_text() or '').startswith(WINDOW_TITLE_MARK):
                return w
        raise AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 창이 없다')

    def _refresh(self) -> None:
        """보이는 컨트롤 색인을 다시 만든다(탭 전환·수집 뒤에는 보이는 컨트롤이 바뀐다)."""
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
        """보이는 컨트롤 하나. 없으면 색인을 한 번 다시 만들고, 그래도 없으면 AdapterRetry(BLOCKED)."""
        if auto_id not in self._index:
            self._refresh()
        info = self._index.get(auto_id)
        if info is None:
            raise AdapterRetry(
                ExportFail.BLOCKED, f'샵마인 화면에서 {auto_id!r} 요소를 찾지 못했다'
            )
        return UIAWrapper(info)

    def _main_uia(self) -> UIAWrapper:
        return UIAWrapper(UIAElementInfo(self._main.handle))

    def _refuse_if_dialog(self) -> None:
        """메인 창이 모달 대화상자에 막혀 있으면 건드리지 않고 물러난다.

        같은 프로세스에 CS메모관리 등 다른 업무 창이 함께 떠 있는 것은 정상이다 — 메인 창
        자체가 비활성(모달에 막힘)일 때만 대화상자로 본다.
        """
        if self._main.is_enabled():
            return
        title = '(제목 없음)'
        for w in self._top_windows(self._main.process_id()):
            if w.handle != self._main.handle and w.is_enabled():
                title = w.window_text() or '(제목 없음)'
                break
        if any(mark in title for mark in AUTH_MARKS):
            # 인증 창은 사람이 처리한다 — 건드리지 않는다(사용자에게 알린다)
            raise AdapterRetry(ExportFail.AUTH_REQUIRED, f'샵마인 {title[:40]} 창 — 직접 인증 필요')
        raise AdapterRetry(ExportFail.BLOCKED, f'샵마인에 대화상자가 떠 있다: {title[:40]!r}')

    # ---- 탭 ----
    def _order_page_shown(self) -> bool:
        """통합주문관리 페이지가 앞에 있는가 — TabItem.is_selected() 는 항상 0 이라(실기) 제목표로 본다."""
        self._refresh()
        info = self._index.get('LabelTitle')
        return info is not None and (info.name or '').strip() == ORDER_TAB

    def _tab_item(self):
        """탭 막대의 통합주문관리 탭. 아직 안 열렸으면 None."""
        for hwnd in _visible_children(self._main.handle):
            try:
                info = UIAElementInfo(hwnd)
                if info.control_type != 'Tab':
                    continue
                for item in UIAWrapper(info).children(control_type='TabItem'):
                    if item.window_text() == ORDER_TAB:
                        return item
            except Exception:  # noqa: BLE001, S112
                continue
        return None

    def _open_order_tab(self) -> None:
        """탭이 안 열려 있으면(재시작 직후) 메뉴 주문관리 → 통합주문관리 로 연다."""
        bars = self._main_uia().children(control_type='MenuBar')
        top = None
        for bar in bars:
            top = next(
                (m for m in bar.children(control_type='MenuItem') if ORDER_MENU in m.window_text()),
                None,
            )
            if top is not None:
                break
        if top is None:
            raise AdapterRetry(ExportFail.BLOCKED, '샵마인 메뉴에 주문관리 가 없다')
        before = {w.handle for w in self._top_windows(self._main.process_id())}
        top.click_input()
        time.sleep(self._poll_s)
        item = self._menu_item(top, ORDER_TAB, before, prefix=True)
        if item is None:
            self._main.type_keys('{ESC}')
            raise AdapterRetry(
                ExportFail.BLOCKED, '주문관리 메뉴에서 통합주문관리 항목을 찾지 못했다'
            )
        item.click_input()
        time.sleep(self._poll_s * 4)

    def _menu_item(self, parent, title: str, before: set[int], *, prefix: bool = False):
        """펼쳐진 메뉴에서 항목 하나 — 부모 메뉴의 자식, 없으면 클릭 뒤 새로 뜬 팝업 창 안에서."""

        def ok(text: str) -> bool:
            return text.startswith(title) if prefix else text == title

        candidates = list(parent.children(control_type='MenuItem'))
        pid = self._main.process_id()
        for popup in _new_windows(before, self._top_windows(pid)):
            try:
                candidates.extend(
                    UIAWrapper(UIAElementInfo(popup.handle)).descendants(control_type='MenuItem')
                )
            except Exception:  # noqa: BLE001, S112 — 이미 닫힌 팝업은 건너뛴다
                continue
        for item in candidates:
            try:
                if ok(item.window_text()) and item.rectangle().width() > 0:
                    return item
            except Exception:  # noqa: BLE001, S112
                continue
        return None

    @_guard_pywinauto_errors
    def ensure_ready(self) -> None:
        self._main = self._find_main()
        if self._main.is_minimized():
            # 최소화된 창은 자식 요소를 돌려주지 않는다(실기) — 앞으로 가져오지 않고 펴기만 한다
            _user32.ShowWindow(self._main.handle, _SW_SHOWNOACTIVATE)
            time.sleep(self._poll_s * 2)
        self._refuse_if_dialog()
        if self._order_page_shown():
            return
        tab = self._tab_item()
        if tab is None:
            self._open_order_tab()
        else:
            # select() 는 예외 없이 조용히 실패한다(실기: 홈 탭 그대로) — 탭 막대를 눌러 고른다
            _post_click(tab.parent().element_info.handle, tab.rectangle())
            time.sleep(self._poll_s * 2)
        if not self._order_page_shown() and tab is not None:
            # 사람이 샵마인을 다른 탭에 두면 탭 막대는 창 메시지로 안 바뀐다(실기 2026-09-30).
            # 자리를 3분 넘게 비웠을 때만 실제로 눌러 바꾸고 마우스는 제자리로 돌려놓는다(EMP 와 같은 규칙)
            idle = self._user_idle_s() if self._user_idle_s is not None else 0.0
            if idle < TAB_SWITCH_MIN_IDLE_S:
                raise AdapterRetry(
                    ExportFail.BUSY,
                    '샵마인이 다른 탭에 있다 — 자리 비울 때 통합주문관리로 바꾼다',
                )
            _real_click(tab)
            time.sleep(self._poll_s * 2)
        if not self._order_page_shown():
            raise AdapterRetry(ExportFail.BLOCKED, '통합주문관리 탭으로 전환하지 못했다')

    # ---- 콤보 상자 ----
    def _select_combo(self, combo, item: str) -> None:
        """WinForms 콤보 상자에서 항목을 고른다.

        pywinauto 의 select() 는 펼치기 패턴이나 'Open' 버튼을 찾는데, 이 프로그램 콤보는 둘 다
        없고 '열기' 버튼뿐이다(실기 2026-09-28). 이미 그 값이면 손대지 않는다.
        """
        if (combo.selected_text() or '').strip() == item:
            return
        items = [t.strip() for t in combo.texts()]
        if item not in items:
            raise AdapterRetry(ExportFail.BLOCKED, f'콤보 상자 목록에 {item!r} 이 없다')
        # 목록을 펼치지 않는다 — 고른 뒤 부모에게 '선택이 바뀌었다'를 알려 프로그램이 반응하게 한다
        hwnd = combo.element_info.handle
        _user32.SendMessageW(hwnd, _CB_SETCURSEL, items.index(item), 0)
        notify = (_CBN_SELCHANGE << 16) | (_user32.GetDlgCtrlID(hwnd) & 0xFFFF)
        _user32.SendMessageTimeoutW(
            _user32.GetParent(hwnd), _WM_COMMAND, notify, hwnd, 0x0002, 10000, None
        )
        time.sleep(self._poll_s)
        if (combo.selected_text() or '').strip() != item:
            raise AdapterRetry(
                ExportFail.BLOCKED,
                f'콤보 상자를 {item!r} 로 바꾸지 못했다({combo.selected_text()!r})',
            )

    # ---- 검색 기간 ----
    def _read_date(self, auto_id: str) -> dt.date | None:
        """날짜 상자에 보이는 날짜('2026-09-29'). 못 읽으면 None."""
        # 색인의 요소는 읽은 때의 값을 쥐고 있을 수 있다 — 핸들로 새로 읽는다
        handle = self._el(auto_id).element_info.handle
        text = (UIAElementInfo(handle).name or '').strip()
        try:
            return dt.date.fromisoformat(text)
        except ValueError:
            return None

    def _type_date(self, auto_id: str, value: dt.date) -> None:
        """날짜 상자에 연·월·일을 차례로 넣는다 — 그 상자 창 핸들에 메시지만 보낸다.

        전역 키 입력은 쓰지 않는다(다른 창으로 샌다). 맨 왼쪽(연도)을 눌러 고르고, 숫자를 넣고
        오른쪽 화살표로 다음 칸으로 간다. 상자가 스스로 값 변경을 알리므로 프로그램도 새 값을 쓴다.
        """
        hwnd = self._el(auto_id).element_info.handle

        def post(message: int, wparam: int, lparam: int = 0) -> None:
            _user32.PostMessageW(hwnd, message, wparam, lparam)
            time.sleep(0.08)

        def key(code: int) -> None:
            post(_WM_KEYDOWN, code)
            post(_WM_KEYUP, code, 0xC0000001)

        at_year = (10 << 16) | 8
        post(_WM_LBUTTONDOWN, 1, at_year)
        post(_WM_LBUTTONUP, 0, at_year)
        time.sleep(self._poll_s / 2)
        for part in (f'{value.year:04d}', f'{value.month:02d}', f'{value.day:02d}'):
            for ch in part:
                key(ord(ch))
            key(_VK_RIGHT)
        time.sleep(self._poll_s)

    def _set_date(self, auto_id: str, value: dt.date) -> None:
        if self._read_date(auto_id) == value:
            return
        self._type_date(auto_id, value)
        got = self._read_date(auto_id)
        if got != value:
            raise AdapterRetry(
                ExportFail.BLOCKED, f'샵마인 검색 날짜를 {value} 로 바꾸지 못했다({got})'
            )

    @_guard_pywinauto_errors
    def set_period(self, today: dt.date | None = None) -> None:
        today = today or dt.datetime.now().astimezone().date()
        start, end = period_to_cover(
            self._read_date(START_DATE_ID), self._read_date(END_DATE_ID), today
        )
        # 종료일을 먼저 넓힌다 — 시작일이 종료일보다 늦어지는 순간을 만들지 않는다
        self._set_date(END_DATE_ID, end)
        self._set_date(START_DATE_ID, start)
        log.info('샵마인 검색 기간 %s ~ %s', start, end)

    # ---- 수집 ----
    @_guard_pywinauto_errors
    def collect(self) -> None:
        # 수집 범위는 언제나 (정상전체) — 다른 값으로 바꾸지 않는다(사용자 지시 2026-09-29)
        self._select_combo(self._el('ComboBoxProcessStatus'), NORMAL_ALL)
        time.sleep(self._poll_s)
        _press_button(self._el('ButtonSearch'))
        # 수집 중 표시가 뜰 틈을 준다 — 바로 보면 '이미 끝남'으로 잘못 읽는다
        time.sleep(self._poll_s * 2)

    @_guard_pywinauto_errors
    def wait_collected(self, timeout_s: float) -> None:
        """수집 안내 패널이 사라지고 수집 버튼이 다시 눌리게 될 때까지 기다린다."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            self._refuse_if_dialog()
            self._refresh()
            button = self._index.get('ButtonSearch')
            if 'PanelLoading' not in self._index and button is not None and button.enabled:
                return
            time.sleep(self._poll_s)
        raise AdapterRetry(ExportFail.TIMEOUT, f'수집이 {timeout_s:g}초 안에 끝나지 않았다')

    # ---- 필터 ----
    def _filter_combo(self, item: str):
        """주문필터 툴바에서 그 항목을 가진 콤보 상자(id 가 숫자라 항목 목록으로 찾는다)."""
        toolbar = self._el('ToolStripOrderFilter')
        for combo in toolbar.children(control_type='ComboBox'):
            try:
                if item in combo.texts():
                    return combo
            except Exception:  # noqa: BLE001, S112 — 목록을 못 주는 콤보는 건너뛴다
                continue
        raise AdapterRetry(ExportFail.BLOCKED, f'주문필터에 {item!r} 항목을 가진 콤보 상자가 없다')

    @_guard_pywinauto_errors
    def set_filters(self) -> None:
        self._select_combo(self._filter_combo(FILTER_STATUS), FILTER_STATUS)
        self._select_combo(self._filter_combo(FILTER_EXCEL), FILTER_EXCEL)
        time.sleep(self._poll_s * 2)
        self._refresh()

    @_guard_pywinauto_errors
    def seller_codes(self, order_nos: Sequence[str]) -> dict[str, str]:
        """지금 목록에서 그 주문들의 판매자상품코드(주문번호 → 코드). 목록에 없는 주문은 빠진다."""
        header, rows = self._rows()
        if not rows:
            return {}
        cols = self._key_columns(header)
        code_col = self._column(header, SELLER_CODE_COLUMN)
        out: dict[str, str] = {}
        for cells in rows:
            keys = self._row_keys(cells, cols)
            hit = next((o for o in order_nos if any(order_matches(o, k) for k in keys)), None)
            if hit is not None and code_col < len(cells):
                out[hit] = self._cell_value(cells[code_col])
        return out

    @_guard_pywinauto_errors
    def order_nos_with_status(self, status: str) -> list[str]:
        """작업상태 필터만 status 로 두고 목록을 읽는다. 필터는 부른 쪽이 되돌린다.

        엑셀 생성 여부 필터는 건드리지 않는다(사용자 지시 2026-09-29) — 엑셀생성안됨 그대로다.
        """
        self._select_combo(self._filter_combo(FILTER_EXCEL), FILTER_EXCEL)
        self._select_combo(self._filter_combo(FILTER_STATUS), status)
        time.sleep(self._poll_s * 2)
        self._refresh()
        header, rows = self._rows()
        if not rows:
            return []
        cols = self._key_columns(header)
        return [key for cells in rows for key in self._row_keys(cells, cols)]

    # ---- 그리드 ----
    def _rows(self) -> tuple[list, list]:
        """(헤더 행의 칸들, 데이터 행들). 실기: 행은 Custom 이고 첫 행 '상위 행' 이 헤더다."""
        header: list = []
        rows: list = []
        for c in self._el('DataGridView1').children():
            if c.element_info.control_type not in ('DataItem', 'Custom'):
                continue
            cells = c.children()
            if cells and cells[0].element_info.control_type == 'Header':
                header = cells
            elif cells:
                rows.append(cells)
        return header, rows

    def _column(self, header: list, name: str) -> int:
        for i, h in enumerate(header):
            if h.window_text() == name:
                return i
        raise AdapterRetry(ExportFail.BLOCKED, f'그리드에 {name!r} 열이 없다')

    def _cell_value(self, cell) -> str:
        """셀 값 — window_text 는 '주문번호 행 0' 같은 이름표라 legacy Value 를 본다(실기)."""
        try:
            value = cell.legacy_properties().get('Value')
        except Exception:  # noqa: BLE001
            value = None
        return str(value or '').strip()

    def _checked(self, cell) -> bool:
        return self._cell_value(cell).lower() in _CHECKED_MARKERS

    @_guard_pywinauto_errors
    def filtered_order_nos(self) -> list[str]:
        header, rows = self._rows()
        if not rows:
            return []
        cols = self._key_columns(header)
        return [key for cells in rows for key in self._row_keys(cells, cols)]

    def _key_columns(self, header: list) -> list[int]:
        """주문을 알아보는 칸들 — 주문번호는 꼭 있어야 하고, 배송번호는 있으면 함께 본다."""
        cols = [self._column(header, ORDER_NO_COLUMN)]
        cols.extend(i for i, h in enumerate(header) if h.window_text() == SHIPMENT_NO_COLUMN)
        return cols

    def _row_keys(self, cells: list, cols: list[int]) -> list[str]:
        values = [self._cell_value(cells[c]) for c in cols if c < len(cells)]
        return [v for v in values if v not in _EMPTY_CELLS]

    def _set_row_check(self, cells: list, want: bool) -> bool:
        """행의 체크 칸을 원하는 상태로 만든다.

        체크 칸은 눌러도 다른 칸으로 포커스를 옮겨야 값이 확정된다(실기: 확정 전 상태를 읽고
        다시 눌러 도로 풀렸다) — 누른 뒤 같은 행의 다음 칸을 눌러 확정하고 나서 읽는다.
        """
        for _ in range(2):
            if self._checked(cells[0]) == want:
                return True
            grid = self._el('DataGridView1').element_info.handle
            _post_click(grid, cells[0].rectangle())
            time.sleep(self._poll_s / 2)
            if len(cells) > 1:
                _post_click(grid, cells[1].rectangle())
                time.sleep(self._poll_s / 2)
        return self._checked(cells[0]) == want

    @_guard_pywinauto_errors
    def select_orders(self, order_nos: Sequence[str]) -> dict[str, int]:
        """전체 선택을 풀고, 목록의 주문번호와 맞는 행만 체크한다."""
        box = self._el('CheckBoxAll')
        if box.get_toggle_state() == 1:
            box.toggle()
            time.sleep(self._poll_s)
        header, rows = self._rows()
        checked: dict[str, int] = dict.fromkeys(order_nos, 0)
        if not rows:
            return checked
        cols = self._key_columns(header)
        for cells in rows:
            keys = self._row_keys(cells, cols)
            hit = next((o for o in order_nos if any(order_matches(o, k) for k in keys)), None)
            if hit is None:
                # 이전 실행이 남긴 체크를 지운다 — 대상이 아닌 행이 함께 바뀌면 안 된다
                if self._checked(cells[0]) and not self._set_row_check(cells, False):
                    raise AdapterRetry(ExportFail.BLOCKED, '대상이 아닌 행의 체크를 풀지 못했다')
                continue
            if self._set_row_check(cells, True):
                checked[hit] += 1
        return checked

    # ---- 완료됨 ----
    @_guard_pywinauto_errors
    def set_status(self, status: str, expected_rows: int) -> None:
        pid = self._main.process_id()
        toolbar = self._el('ToolStripSub')
        menu = next(
            (
                m
                for m in toolbar.children(control_type='MenuItem')
                if m.window_text() == STATUS_MENU
            ),
            None,
        )
        if menu is None:
            raise AdapterRetry(ExportFail.BLOCKED, f'{STATUS_MENU!r} 메뉴를 찾지 못했다')
        before_menu = {w.handle for w in self._top_windows(pid)}
        _invoke(menu)
        time.sleep(self._poll_s)
        done_item = self._menu_item(menu, status, before_menu)
        if done_item is None:
            raise AdapterRetry(
                ExportFail.BLOCKED, f'작업상태지정 메뉴에서 {status} 항목을 찾지 못했다'
            )
        before_confirm = {w.handle for w in self._top_windows(pid)}
        # 확인 창을 띄우는 항목이다 — UIA 동작으로 누르면 창이 닫힐 때까지 UIA 가 통째로 멈춘다
        # (실기 2026-09-29). 펼쳐진 메뉴 창에 클릭 메시지를 보낸다.
        popup = _user32.WindowFromPoint(
            wintypes.POINT(done_item.rectangle().mid_point().x, done_item.rectangle().mid_point().y)
        )
        owner = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(popup, ctypes.byref(owner))
        if owner.value != pid:
            raise AdapterRetry(ExportFail.BLOCKED, f'{status} 항목이 다른 창에 가려 있다')
        _post_click(popup, done_item.rectangle())
        self._confirm_own_dialog(pid, before_confirm, expected_rows)
        self._dismiss_result_dialog(pid, before_confirm)
        time.sleep(self._poll_s * 2)

    def _dismiss_result_dialog(self, pid: int, before: set[int], wait_s: float = 60.0) -> None:
        """완료됨 지정 뒤 뜨는 결과 안내창('… 되었습니다' · 확인)을 닫는다(실기 2026-09-28).

        닫지 않으면 메인 창이 그 창에 막힌 채 남는다. 클릭 전에 없던 창이고 문구가 결과
        안내일 때만 누른다.
        """
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            for w in _new_windows(before, self._top_windows(pid)):
                try:
                    dialog = UIAWrapper(UIAElementInfo(w.handle))
                    texts = [t.window_text() for t in dialog.descendants(control_type='Text')]
                    buttons = dialog.descendants(control_type='Button')
                except Exception:  # noqa: BLE001, S112 — 이미 닫힌 창은 건너뛴다
                    continue
                message = ' '.join(t for t in texts if t)
                if RESULT_MARK not in message:
                    continue
                named = {b.window_text(): b for b in buttons}
                ok = next((named[n] for n in CONFIRM_BUTTONS if n in named), None)
                if ok is None:
                    continue
                _press_button(ok)
                log.info('샵마인 결과 안내창(%r)을 닫았다', message[:80])
                time.sleep(self._poll_s)
                return
            time.sleep(self._poll_s)
        log.warning('샵마인 결과 안내창을 찾지 못했다 — 뜨지 않았거나 이미 닫혔다')

    def _confirm_own_dialog(
        self, pid: int, before: set[int], expected_rows: int, wait_s: float = 5.0
    ) -> None:
        """우리가 방금 띄운 대화상자(클릭 전에는 없던 창)만 누른다. 없으면 그냥 지나간다.

        문구의 '선택한 N개' 가 우리가 체크한 행 수와 다르면 누르지 않고 물러난다 — 대상이 아닌
        주문이 함께 바뀌는 것을 막는 마지막 확인이다(실기: '선택한 1개의 주문을 [완료됨]으로 …').
        """
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            for w in _new_windows(before, self._top_windows(pid)):
                try:
                    dialog = UIAWrapper(UIAElementInfo(w.handle))
                    texts = [t.window_text() for t in dialog.descendants(control_type='Text')]
                    buttons = dialog.descendants(control_type='Button')
                except Exception:  # noqa: BLE001, S112 — 이미 닫힌 창은 건너뛴다
                    continue
                named = {b.window_text(): b for b in buttons}
                confirm = next((named[n] for n in CONFIRM_BUTTONS if n in named), None)
                if confirm is None:
                    continue
                message = ' '.join(t for t in texts if t)
                count = _SELECTED_COUNT.search(message)
                if count is None:
                    # 개수를 묻는 확인 창이 아니다(결과 안내 등) — 여기서는 누르지 않는다
                    continue
                if int(count.group(1)) != expected_rows:
                    cancel = next((named[n] for n in CANCEL_BUTTONS if n in named), None)
                    if cancel is not None:
                        _press_button(cancel)
                    raise AdapterReject(
                        ExportFail.AMBIGUOUS,
                        f'확인 창의 선택 {count.group(1)}개 ≠ 체크한 {expected_rows}개 — 누르지 않았다',
                    )
                pressed = confirm.window_text()
                _press_button(confirm)
                log.info('샵마인 확인 대화상자(%r) 에서 %r 을 눌렀다', message[:80], pressed)
                time.sleep(self._poll_s)
                return
            time.sleep(self._poll_s)
