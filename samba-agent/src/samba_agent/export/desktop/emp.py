"""EMP 어댑터 — 주문 한 건의 원가·배송비를 EMP 주문 그리드에 읽고 쓴다(스펙 §6).

작업자의 셀형 규약(Adapter: read · write)을 따른다. 덮어쓰기 금지·되읽기 비교는 작업자가 한다.
화면을 만지는 일은 드라이버(emp_ui.py)가 한다. 관리자 권한 프로세스에서만 동작한다.
"""

import logging
from collections.abc import Sequence
from typing import Protocol

from samba_agent.export.adapters import AdapterRetry, CellValues
from samba_agent.export.failures import ExportFail

log = logging.getLogger(__name__)


def parse_won(text: str | None) -> int | None:
    """'33,440' → 33440. 빈 칸은 None, 숫자가 아니면 ValueError."""
    raw = (text or '').replace(',', '').strip()
    if not raw:
        return None
    return round(float(raw))


class EmpUi(Protocol):
    """EMP 주문 그리드 조작. 못 하는 상황은 AdapterRetry, 다시 해도 같은 것은 AdapterReject."""

    def ensure_ready(self) -> None: ...

    def search(self) -> None:
        """검색 기간에 오늘이 들어가게 하고 검색시작을 누른다."""
        ...

    def read(self, order_no: str) -> CellValues: ...

    def write(self, order_no: str, cost: int, shipping_fee: int, memo: str = '') -> None: ...

    def show_only(self, order_no: str) -> None:
        """그 주문만 그리드에 띄운다. 없으면 AdapterRetry(NOT_FOUND)."""
        ...

    def clear_keyword(self) -> None:
        """검색어를 지우고 목록을 되돌린다."""
        ...

    def seller_code(self, order_no: str) -> str:
        """그 주문 행의 판매자상품코드. 비어 있으면 빈 글자."""
        ...

    def cancel(self, order_no: str) -> None:
        """그 주문 행의 상태를 취소로 바꾸고 되읽는다. 이미 취소면 아무것도 하지 않는다."""
        ...


class EmpAdapter:
    """Adapter 구현 — 부를 때마다 창 상태를 다시 확인한다(사이에 최소화·대화상자가 생길 수 있다)."""

    def __init__(self, ui: EmpUi) -> None:
        self._ui = ui

    def read(self, order_no: str) -> CellValues:
        self._ui.ensure_ready()
        # 그 주문만 띄워서 읽는다 — 오늘이 들어간 기간으로 다시 검색하고, 다른 주문 행이 화면에 없게 한다
        try:
            self._ui.show_only(order_no)
            return self._ui.read(order_no)
        finally:
            self._ui.clear_keyword()

    def write(self, order_no: str, cost: int, shipping_fee: int, memo: str = '') -> None:
        self._ui.ensure_ready()
        # 그 주문 행만 띄운 채로 넣는다 — 값이 다른 주문 행에 들어갈 자리가 없다(실기 2026-09-29 사고)
        try:
            self._ui.show_only(order_no)
            self._ui.write(order_no, cost, shipping_fee, memo)
        finally:
            self._ui.clear_keyword()


class EmpCancelAdapter:
    """BatchAdapter 구현 — 하네스가 취소한 주문을 EMP 에서 상태 '취소'로 바꾼다(사용자 지시 2026-09-29)."""

    def __init__(self, ui: EmpUi) -> None:
        self._ui = ui

    def complete_pending(self, order_nos: Sequence[str]) -> set[str]:
        wanted = [o for o in dict.fromkeys(order_nos) if o]
        if not wanted:
            return set()
        self._ui.ensure_ready()
        done: set[str] = set()
        try:
            for order_no in wanted:
                try:
                    # 그 주문만 띄운다 — 목록이 길면 대상 행이 화면 밖이라 누를 수 없다
                    self._ui.show_only(order_no)
                    self._ui.cancel(order_no)
                except AdapterRetry as e:
                    if e.reason is not ExportFail.NOT_FOUND:
                        raise
                    # 아직 EMP 에 수집되지 않은 주문이다 — 나머지는 계속한다
                    log.info('EMP 에 아직 없는 주문: %s', order_no)
                    continue
                done.add(order_no)
        finally:
            self._ui.clear_keyword()
        return done


class EmpLookupAdapter:
    """BatchAdapter 구현 — 소싱처 미등록 주문의 판매자상품코드를 읽는다. 화면의 값은 바꾸지 않는다."""

    one_at_a_time = True

    def __init__(self, ui: EmpUi) -> None:
        self._ui = ui
        self._found: dict[str, str] = {}

    def complete_pending(self, order_nos: Sequence[str]) -> set[str]:
        wanted = [o for o in dict.fromkeys(order_nos) if o]
        if not wanted:
            return set()
        self._ui.ensure_ready()
        self._found = {}
        try:
            for order_no in wanted:
                try:
                    self._ui.show_only(order_no)
                    code = self._ui.seller_code(order_no)
                except AdapterRetry as e:
                    if e.reason is not ExportFail.NOT_FOUND:
                        raise
                    continue
                if code:
                    self._found[order_no] = code
        finally:
            self._ui.clear_keyword()
        return set(self._found)

    def detail_for(self, order_no: str) -> str | None:
        return self._found.get(order_no)
