"""어댑터 규약 — 외부 프로그램 1개의 주문 표를 읽고 쓴다.

작업자는 이 두 함수만 부른다. 화면을 어떻게 다루는지(검색·셀 선택·저장)는 어댑터 안의 일이다.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from samba_agent.export.failures import ExportFail


@dataclass(frozen=True)
class CellValues:
    """주문 1행의 원가·배송비. 빈 셀은 None 또는 0 이다(작업자는 둘을 같게 본다)."""

    cost: int | None
    shipping_fee: int | None
    # 한줄메모 같은 글 칸(EMP). 읽지 않는 프로그램은 None
    memo: str | None = None


class _AdapterError(Exception):
    def __init__(self, reason: ExportFail, detail: str) -> None:
        super().__init__(f'{reason.value}: {detail}')
        self.reason = reason
        self.detail = detail


class AdapterRetry(_AdapterError):
    """다시 하면 풀릴 수 있다 — 창 없음·대화상자·응답 없음."""


class AdapterReject(_AdapterError):
    """다시 해도 같다 — 주문 없음·검색 결과 여러 건·행 불일치."""


class Adapter(Protocol):
    """외부 프로그램 1개.

    두 함수 모두 주문번호로 행을 1건으로 특정한 뒤에만 일한다. 특정하지 못하면 아무것도
    바꾸지 않고 예외를 던진다.
    """

    def read(self, order_no: str) -> CellValues:
        """그 주문의 현재 원가·배송비."""
        ...

    def write(self, order_no: str, cost: int, shipping_fee: int, memo: str = '') -> None:
        """원가·배송비(와 memo 가 있으면 글 칸)를 입력하고 저장한다. 입력 직전에 선택 행의 주문번호를 다시 확인한다."""
        ...


@runtime_checkable
class BatchAdapter(Protocol):
    """일괄형 외부 프로그램 — 주문별 값 기입이 아니라 화면에서 여러 주문을 한 번에 처리한다(샵마인).

    작업자는 요청 하나를 집고, 그때 대기 중이던 같은 대상 요청의 주문번호를 모두 넘긴다.
    어댑터는 화면에서 찾은 주문만 처리하고 그 주문번호 집합을 돌려준다(사용자 2026-09-28:
    하네스가 이행한 주문만 완료됨). 되풀이해 불러도 안전해야 한다(찾은 게 없으면 빈 집합).
    """

    def complete_pending(self, order_nos: Sequence[str]) -> set[str]:
        """처리한 주문번호 집합. 창 없음·시간 초과·대화상자는 AdapterRetry, 되읽기 불일치는 AdapterReject."""
        ...
