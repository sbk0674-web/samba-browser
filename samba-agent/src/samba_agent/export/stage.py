"""export 단계 — 검증이 끝난 주문의 원가·배송비를 외부 기입 큐에 넣는다.

이 단계는 주문 결과를 바꾸지 않는다. 기입이 실패하든 늦든 돌려주는 결과는 항상 ok 이고,
실제 기입 결과는 payload['export'] 에 담는다(실패 알림은 export.notify 가 따로 보낸다).
"""

import logging
import time
from collections.abc import Callable, Collection

from samba_agent.agents.contracts import AgentResult, Evidence
from samba_agent.export.routing import ExportRouting, cancel_target, lookup_target
from samba_agent.export.store import ExportConflict, ExportQueue
from samba_agent.supervisor.state import RunState

ExportFn = Callable[[RunState], AgentResult]

log = logging.getLogger(__name__)


def _won(value: object) -> int | None:
    """금액 → 원 단위 정수. 숫자가 아니면 None(불리언·문자열은 숫자로 치지 않는다)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return round(float(value))


def export_values(state: RunState) -> tuple[int, int] | None:
    """기록 단계가 삼바웨이브에 적은 (원가, 배송비). 원가가 없으면 None.

    기록 결과만 본다 — 구매 단계의 견적 원가는 실제 결제액과 다를 수 있어 쓰지 않는다.
    """
    recorder = state.get('results', {}).get('recorder')
    if recorder is None:
        return None
    values = recorder.payload.get('values') or recorder.payload.get('planned')
    if not isinstance(values, dict):
        return None
    cost = _won(values.get('real_price'))
    if cost is None or cost <= 0:
        return None
    return cost, max(_won(values.get('shipping_fee')) or 0, 0)


def _result(reason: str, payload: dict[str, object]) -> AgentResult:
    return AgentResult(
        status='ok',
        reason=reason,
        payload=payload,
        evidence=(Evidence(label='외부 기입', detail=reason),),
    )


def make_exporter(
    queue: ExportQueue,
    routing: ExportRouting,
    *,
    wait_s: float = 60.0,
    poll_s: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
    deferred: Collection[str] = (),
) -> ExportFn:
    """그래프의 export 노드가 부를 함수를 만든다.

    deferred 에 든 대상은 기다리지 않는다 — 사람이 PC 를 쓰지 않을 때만 만지는 프로그램(EMP)이라
    언제 끝날지 모른다. 결과는 알림 고리가 주문 스레드에 덧붙인다.
    """

    def exporter(state: RunState) -> AgentResult:
        order = state['order']
        values = export_values(state)
        if values is None:
            return _result('외부 기입 건너뜀 — 기록된 원가가 없다', {'export': 'skipped'})
        cost, shipping_fee = values
        target = routing.target_for(order.seller)
        if target is None:
            return _result(
                f'외부 기입 건너뜀 — 기입 제외 판매처({order.seller or "판매처 없음"})',
                {'export': 'skipped'},
            )
        plan: dict[str, object] = {'target': target, 'cost': cost, 'shipping_fee': shipping_fee}
        if state.get('dry_run', True):
            return _result(
                f'dry-run: {target} 에 원가 {cost:,} · 배송비 {shipping_fee:,} 기입 예정',
                {'export': 'planned', **plan},
            )
        try:
            req = queue.enqueue(order.order_no, target, cost, shipping_fee)
        except ExportConflict as e:
            return _result(f'외부 기입 충돌({target}) — {e}', {'export': 'conflict', **plan})
        # 그 대상을 맡은 작업자가 떠 있고, 이 요청보다 먼저 온 대기 건이 없을 때만 기다린다 —
        # 작업자가 죽었거나(alive 거짓) 대기열이 밀려 있으면(먼저 온 pending 이 있으면)
        # 어차피 못 받으니 주문마다 제한 시간을 통째로 쓰지 않는다
        if target in deferred:
            return _result(
                f'{target} 기입 예약 — PC 를 쓰지 않을 때 넣고 결과를 이 스레드에 알린다',
                {'export': 'pending', **plan},
            )
        can_wait = queue.alive(target) and not queue.has_older_pending(target, req.id)
        waited = wait_s if can_wait else 0
        final = queue.wait(req.id, waited, poll_s=poll_s, sleep=sleep)
        if final.status == 'done':
            return _result(
                f'{target} 에 원가 {cost:,} · 배송비 {shipping_fee:,} 기입',
                {'export': 'done', **plan, 'detail': final.detail},
            )
        if final.status == 'failed':
            return _result(
                f'외부 기입 실패({target}) — {final.fail_reason}: {final.detail}',
                {
                    'export': 'failed',
                    **plan,
                    'fail_reason': final.fail_reason,
                    'detail': final.detail,
                },
            )
        return _result(
            f'외부 기입 대기 중({target}) — 입력 작업자가 처리하면 반영된다',
            {'export': 'pending', **plan},
        )

    return exporter


def make_cancel_exporter(
    queue: ExportQueue,
    routing: ExportRouting,
    seller_of: Callable[[str], str | None],
    *,
    wait_s: float = 0.0,
    poll_s: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
    deferred: Collection[str] = (),
) -> Callable[[str], str | None]:
    """취소중으로 바꾼 주문을 외부 프로그램에도 알리는 함수(사용자 지시 2026-09-29).

    샵마인은 작업상태 '지연됨', EMP 는 상태 '취소'. 결과 한 줄을 돌려준다(해당 없으면 None).
    실패해도 예외를 내지 않는다 — 주문 처리 결과는 이미 정해졌다.
    """

    def export_cancel(order_no: str) -> str | None:
        try:
            target = routing.target_for(seller_of(order_no))
            if target is None:
                return None
            if queue.find(order_no, target) is not None:
                # 구매까지 끝내 기입 요청이 있는 주문이다 — 취소 상태가 됐어도 완료됨으로 둔다
                # (사용자 지시 2026-09-29). 지연됨·취소로 덮지 않는다
                return '구매까지 끝낸 주문 — 취소 연동하지 않음'
            name = cancel_target(target)
            req = queue.enqueue(order_no, name, 0, 0)
            if target in deferred:
                return f'{target} 취소 연동 예약 — PC 를 쓰지 않을 때 바꾸고 결과를 알린다'
            waited = wait_s if queue.alive(name) else 0
            final = queue.wait(req.id, waited, poll_s=poll_s, sleep=sleep)
            if final.status == 'done':
                return f'{target} 취소 연동 완료'
            if final.status == 'failed':
                return f'{target} 취소 연동 실패 — {final.fail_reason}: {final.detail}'
        except Exception as e:  # 취소 처리 자체는 끝났다 — 작업 결과에 영향을 주지 않는다
            log.exception('외부 취소 연동 요청 실패')
            return f'외부 취소 연동 요청 실패: {type(e).__name__}'
        return f'{target} 취소 연동 요청함'

    return export_cancel


def make_lookup_requester(
    queue: ExportQueue, routing: ExportRouting
) -> Callable[[str, str | None], str | None]:
    """소싱처 미등록 주문의 판매자상품코드를 읽어 달라고 큐에 넣는 함수(주문번호, 판매처).

    넣었으면 대상 이름, 넣지 않았으면(제외 판매처·이미 넣음) None. 예외를 내지 않는다.
    """

    def request(order_no: str, seller: str | None) -> str | None:
        try:
            target = routing.target_for(seller)
            if target is None:
                return None
            name = lookup_target(target)
            if queue.find(order_no, name) is not None:
                return None
            queue.enqueue(order_no, name, 0, 0)
        except Exception:  # 수집은 이어 간다 — 다음 주기에 다시 넣는다
            log.exception('판매자상품코드 읽기 요청 실패')
            return None
        return name

    return request
