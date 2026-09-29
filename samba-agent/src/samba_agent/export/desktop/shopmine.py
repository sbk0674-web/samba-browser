"""샵마인 어댑터 — 통합주문관리의 '미지정 · 엑셀생성안됨' 주문 중 하네스가 이행한 주문을 '완료됨'으로(스펙 §6.1).

절차만 있다. 화면을 실제로 만지는 일은 ShopMineUi 드라이버(shopmine_ui.py, pywinauto)가 한다 —
그래서 절차는 가짜 드라이버로 시험하고, 드라이버는 실기로 시험한다.
"""

import re
from collections.abc import Mapping, Sequence
from typing import Protocol

from samba_agent.export.adapters import AdapterReject
from samba_agent.export.failures import ExportFail

_SEPARATORS = re.compile(r'[:\s]+')


def _tokens(text: str) -> list[str]:
    """주문번호를 토막으로 나눈다 — 프로그램마다 구분 글자가 다르다(':' · 공백)."""
    return [t for t in _SEPARATORS.split(text.strip()) if t]


def order_matches(order_no: str, cell: str) -> bool:
    """하네스 주문번호와 프로그램의 주문번호 칸이 같은 주문인가.

    실기 2026-09-28: SSG 는 하네스 `20260928B68241:1136399342` ↔ 샵마인 `20260928B68241`(`:` 앞),
    GS이숍은 하네스가 두 토막 `3474596476 2904713019` 이고 화면에는 그중 하나가 보인다.
    실기 2026-09-29: 롯데홈쇼핑은 하네스 `20260929B92579:1136441910` ↔ EMP `20260929B92579 1136441910`
    (구분 글자만 다르다). 토막이 모두 같거나, 화면 값이 한 토막이고 그것이 하네스 토막 중 하나면 같다.
    """
    wanted = _tokens(order_no or '')
    shown = _tokens(cell or '')
    if not wanted or not shown:
        return False
    if shown == wanted:
        return True
    return len(shown) == 1 and shown[0] in wanted


STATUS_DONE = '완료됨'
STATUS_DELAYED = '지연됨'


class ShopMineUi(Protocol):
    """샵마인 통합주문관리 화면 조작. 못 하는 상황은 AdapterRetry 로 던진다."""

    def ensure_ready(self) -> None:
        """창이 있고 통합주문관리 탭이 앞에 있으며 낯선 대화상자가 없다."""
        ...

    def set_period(self) -> None:
        """검색 기간에 오늘이 들어가게 한다(이미 들어 있으면 그대로)."""
        ...

    def collect(self) -> None:
        """수집 범위를 (정상전체)로 두고 수집하기(F5). 다른 범위로는 바꾸지 않는다."""
        ...

    def wait_collected(self, timeout_s: float) -> None:
        """수집이 끝날 때까지 기다린다. 넘기면 AdapterRetry(TIMEOUT)."""
        ...

    def set_filters(self) -> None:
        """작업상태 = 미지정, 엑셀생성여부 = 엑셀생성안됨."""
        ...

    def filtered_order_nos(self) -> list[str]:
        """지금 필터에 걸린 행들을 알아보는 값들 — 주문번호, 쿠팡은 배송번호도(헤더 제외)."""
        ...

    def order_nos_with_status(self, status: str) -> list[str]:
        """작업상태가 status 인 행들을 알아보는 값들(엑셀 필터는 그대로 둔다)."""
        ...

    def seller_codes(self, order_nos: Sequence[str]) -> Mapping[str, str]:
        """지금 목록에서 그 주문들의 판매자상품코드. 목록에 없는 주문은 빠진다."""
        ...

    def select_orders(self, order_nos: Sequence[str]) -> Mapping[str, int]:
        """전체 선택을 풀고, 목록의 주문번호와 맞는 행만 체크한다. 주문번호 → 체크한 행 수."""
        ...

    def write_memo(self, order_no: str, memo: str) -> None:
        """체크한 그 주문의 추가메모에 memo 를 넣는다(이미 들어 있으면 그대로). 못 하면 AdapterRetry."""
        ...

    def set_status(self, status: str, expected_rows: int) -> None:
        """작업상태지정 → status(완료됨·지연됨). 확인 대화상자의 '선택한 N개' 가 expected_rows 와 같을 때만 누른다."""
        ...


class ShopMineAdapter:
    # 작업자가 집은 주문 1건만 넘긴다(주문 처리와 1건 단위로 묶는다)
    one_at_a_time = True

    """BatchAdapter 구현. complete_pending 한 번이 넘겨받은 주문 중 화면에 있는 것을 처리한다."""

    def __init__(
        self,
        ui: ShopMineUi,
        *,
        collect_timeout_s: float = 300.0,
        status: str = STATUS_DONE,
        dry_run: bool = False,
    ) -> None:
        self._ui = ui
        self._collect_timeout_s = collect_timeout_s
        # 이행한 주문은 완료됨, 취소한 주문은 지연됨(사용자 지시 2026-09-29)
        self._status = status
        # 실기 시험용 — 행 체크까지만 하고 완료됨은 누르지 않는다
        self._dry_run = dry_run
        # 이번에 넘겨받은 주문의 추가메모(작업자가 complete_pending 전에 건넨다)
        self._memos: dict[str, str] = {}

    def use_memos(self, memos: Mapping[str, str]) -> None:
        self._memos = {o: m for o, m in memos.items() if m}

    def complete_pending(self, order_nos: Sequence[str]) -> set[str]:
        wanted = [o for o in dict.fromkeys(order_nos) if o]
        if not wanted:
            return set()
        self._ui.ensure_ready()
        return self._pass(wanted)

    def _pass(self, wanted: Sequence[str]) -> set[str]:
        """정상 주문 목록에서 찾아 바꾼다. 처리한(또는 이미 바뀌어 있던) 주문번호 집합.

        수집 범위는 (정상전체), 엑셀 필터는 엑셀생성안됨에서 바꾸지 않는다(사용자 지시 2026-09-29).
        """
        ui = self._ui
        # 조건이 먼저다 — 오늘이 빠진 기간으로 수집하면 오늘 주문이 목록에 없다
        ui.set_period()
        ui.collect()
        ui.wait_collected(self._collect_timeout_s)
        ui.set_filters()
        present = ui.filtered_order_nos()
        found = [o for o in wanted if any(order_matches(o, c) for c in present)]
        # 목록에 없는 주문은 이미 그 작업상태일 수 있다(사람이 먼저 바꿨거나 앞선 시도가 바꿨다) —
        # 그러면 끝난 것이다. 못 찾았다고 되풀이하지 않는다(실기 2026-09-29: 20260927C6134A)
        already: set[str] = set()
        if len(found) < len(wanted) and self._status != STATUS_DONE:
            # 완료됨 목록은 한 달 치 수백 행이라 읽는 데 10분이 걸린다(실기 2026-09-29) — 거기서는 찾지 않는다
            marked = ui.order_nos_with_status(self._status)
            already = {
                o for o in wanted if o not in found and any(order_matches(o, c) for c in marked)
            }
            ui.set_filters()
        if not found:
            return already
        checked = ui.select_orders(found)
        missing = [o for o in found if not checked.get(o)]
        if missing:
            # 찾았는데 체크가 안 된 행이 있다 — 일부만 완료됨으로 바꾸면 무엇이 바뀌었는지 알 수 없다
            raise AdapterReject(
                ExportFail.AMBIGUOUS, f'{len(missing)}건은 행을 체크하지 못했다 — 누르지 않았다'
            )
        if self._dry_run:
            return set(found) | already
        # 추가메모(도착예정 등)는 완료됨으로 바꾸기 전에 넣는다 — 바꾸면 행이 이 목록에서 빠진다.
        # 메모를 못 넣으면 완료됨도 누르지 않고 다시 한다(메모가 빠진 채 끝나지 않게)
        for order_no in found:
            memo = self._memos.get(order_no)
            if memo:
                ui.write_memo(order_no, memo)
        ui.set_status(self._status, sum(checked.get(o, 0) for o in found))
        # 되읽기 — 처리한 주문은 같은 필터에 남아 있으면 안 된다
        ui.set_filters()
        after = ui.filtered_order_nos()
        left = [o for o in found if any(order_matches(o, c) for c in after)]
        if left:
            raise AdapterReject(
                ExportFail.VERIFY_MISMATCH,
                f'{self._status} 지정 뒤에도 {len(left)}건이 필터에 남음(처리 대상 {len(found)}건)',
            )
        return set(found) | already


class ShopMineLookupAdapter:
    """BatchAdapter 구현 — 소싱처 미등록 주문의 판매자상품코드를 읽는다. 화면의 값은 바꾸지 않는다."""

    one_at_a_time = True

    def __init__(self, ui: ShopMineUi, *, collect_timeout_s: float = 300.0) -> None:
        self._ui = ui
        self._collect_timeout_s = collect_timeout_s
        self._found: dict[str, str] = {}

    def complete_pending(self, order_nos: Sequence[str]) -> set[str]:
        wanted = [o for o in dict.fromkeys(order_nos) if o]
        if not wanted:
            return set()
        ui = self._ui
        ui.ensure_ready()
        ui.set_period()
        ui.collect()
        ui.wait_collected(self._collect_timeout_s)
        ui.set_filters()
        self._found = {o: c for o, c in ui.seller_codes(wanted).items() if c.strip()}
        return set(self._found)

    def detail_for(self, order_no: str) -> str | None:
        return self._found.get(order_no)
