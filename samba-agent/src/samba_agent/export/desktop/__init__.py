"""외부 프로그램 어댑터 등록 지점.

여기 등록된 대상만 입력 작업자가 큐에서 집는다 — 등록되지 않은 대상의 요청은 큐에 대기로 남는다.
드라이버(pywinauto)는 지연 import 한다 — 하네스 본체에는 그 의존성이 없다.
"""

from collections.abc import Collection

from samba_agent.export.adapters import Adapter, BatchAdapter
from samba_agent.export.desktop.emp import EmpAdapter, EmpCancelAdapter, EmpLookupAdapter
from samba_agent.export.desktop.shopmine import (
    STATUS_DELAYED,
    ShopMineAdapter,
    ShopMineLookupAdapter,
)
from samba_agent.export.routing import cancel_target, lookup_target

USER_BACK_S = 3.0


def _shopmine_ui():
    from samba_agent.export.desktop.shopmine_ui import PywinautoShopMineUi
    from samba_agent.export.idle import user_idle_seconds

    return PywinautoShopMineUi(user_idle_s=user_idle_seconds)


def _emp_ui():
    from samba_agent.export.desktop.emp_ui import PywinautoEmpUi
    from samba_agent.export.idle import user_idle_seconds

    # 방금(3초 안에) 키보드·마우스 입력이 있었으면 사람이 돌아온 것이다
    return PywinautoEmpUi(user_active=lambda: user_idle_seconds() < USER_BACK_S)


def build_adapters(targets: Collection[str]) -> dict[str, Adapter | BatchAdapter]:
    """설정에 적힌 대상만 만든다(대상 이름 → 어댑터). 모르는 이름은 거부한다."""
    made: dict[str, Adapter | BatchAdapter] = {}
    # 'no_emp_cancel' 처럼 적으면 그 취소 연동만 끈다 — 요청은 큐에 대기로 남는다
    off = {t[3:] for t in targets if t.startswith('no_')}
    for target in (t for t in targets if not t.startswith('no_')):
        if target == 'shopmine':
            ui = _shopmine_ui()
            made[target] = ShopMineAdapter(ui)
            # 취소한 주문은 같은 화면에서 지연됨으로 바꾼다
            made[cancel_target(target)] = ShopMineAdapter(ui, status=STATUS_DELAYED)
            # 소싱처 미등록 주문의 판매자상품코드 읽기
            made[lookup_target(target)] = ShopMineLookupAdapter(ui)
        elif target == 'emp':
            # EMP 는 관리자 권한으로 돈다 — 작업자도 관리자 권한으로 띄워야 한다
            emp_ui = _emp_ui()
            made[target] = EmpAdapter(emp_ui)
            made[cancel_target(target)] = EmpCancelAdapter(emp_ui)
            made[lookup_target(target)] = EmpLookupAdapter(emp_ui)
        else:
            raise ValueError(f'모르는 외부 기입 대상: {target!r}')
    return {name: adapter for name, adapter in made.items() if name not in off}
