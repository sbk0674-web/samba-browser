"""자동 수집 — 삼바웨이브의 미이행 주문을 스스로 큐에 넣는다(계획 Task D).

한 바퀴(`run_once`)가 하는 일은 셋뿐이다.
1. 삼바웨이브에서 최근 `days` 일 미이행 주문을 받아 결제 시각이 오래된 것부터 본다.
2. 이미 살아 있는(큐에 있는) 주문은 건너뛴다 — 같은 주문을 두 번 사지 않는다.
3. 남은 주문은 슬랙에 최상위 메시지를 하나 올리고, 그 ts 를 스레드로 삼아 큐에 넣는다.

맡을 구매 에이전트가 없는 소싱처(KREAM 보류·수기·스니커덩크 등)도 일단 큐에 넣되 바로
`needs_human` 으로 닫고 스레드에 한 줄 남긴다 — 사람이 보게 하되 하네스는 손대지 않는다.
슬랙에 나가는 문구에는 개인정보(이름·전화·주소)를 넣지 않는다(계획 Global Constraints).
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from samba_agent.agents.contracts import OrderRef
from samba_agent.failures import FailReason
from samba_agent.queue.db import JobQueue
from samba_agent.wave.client import WaveClient, WaveError, WaveOrder, flag_text

if TYPE_CHECKING:
    from datetime import datetime

log = logging.getLogger(__name__)

# 슬랙 최상위 메시지에 싣는 상품명 길이 — 길면 스레드 제목이 읽히지 않는다
SKU_LIMIT = 40
# run_forever 가 멈춤 신호를 확인하는 간격(초). 주기가 길어도 종료는 빠르게 한다
TICK_S = 0.5


@dataclass(frozen=True)
class IntakeReport:
    """한 바퀴 결과. 슬랙 `주문처리 전체` 답장이 이 숫자를 그대로 읽어 준다."""

    seen: int = 0
    enqueued: int = 0
    skipped_live: int = 0
    unsupported: int = 0

    def as_line(self) -> str:
        return (
            f'수집 {self.seen}건 · 접수 {self.enqueued}건 · '
            f'진행중 제외 {self.skipped_live}건 · 미지원 {self.unsupported}건'
        )


def _paid_key(order: WaveOrder) -> tuple[int, float]:
    """결제 시각 오름차순. 시각이 없는 건은 맨 뒤로 민다."""
    paid: datetime | None = order.paid_at
    if paid is None:
        return (1, 0.0)
    return (0, paid.timestamp())


def intake_line(order: OrderRef) -> str:
    """슬랙 최상위 메시지 한 줄. 개인정보는 애초에 OrderRef 에 없다.

    플래그(가격X·재고X·직원A 등)는 오류일 수 있어 제외하지 않는다 — 접수하고 줄 끝에 덧붙여
    사람이 결제 승인 때 보게 한다.
    """
    line = f'접수: {order.order_no} · {order.source} · {order.sku[:SKU_LIMIT]} · {order.qty}개'
    if order.flags:
        line += f' · ⚠ {flag_text(order.flags)}'
    return line


class Intake:
    """삼바웨이브 → 큐 자동 수집 고리."""

    def __init__(
        self,
        wave: WaveClient,
        queue: JobQueue,
        registry_or_sources: object,
        post_new: Callable[[str], str | None],
        post_line: Callable[[str | None, str], bool],
        *,
        days: int,
        requester: str = 'intake',
        max_new: int = 5,
        sources: frozenset[str] = frozenset(),
        poison_only: bool = False,
        all_sellers_sources: frozenset[str] = frozenset(),
        on_unfulfillable: Callable[[str, str], str | None] | None = None,
        on_unlinked: Callable[[str, str | None], str | None] | None = None,
    ) -> None:
        self._wave = wave
        self._queue = queue
        self._registry = registry_or_sources
        self._post_new = post_new
        self._post_line = post_line
        self._days = days
        self._requester = requester
        # 한 바퀴에 새로 접수하는 상한 — 첫 기동 때 수십 건이 슬랙에 한꺼번에 쏟아지지 않게
        self._max_new = max_new
        # 수집 범위 — 비어 있으면 전부. 소싱처 id(대문자)로 비교한다
        self._sources = frozenset(x.upper() for x in sources)
        self._poison_only = poison_only
        # 포이즌 제한의 예외 — 이 소싱처는 판매처와 무관하게 모두 이행(사용자 2026-09-24: 무신사)
        self._all_sellers = frozenset(x.upper() for x in all_sellers_sources)
        # 이행 불가 주문 처리(가격X·재고X 표시 + 취소요청) — (주문 키(행 id), 실패 사유)
        self._on_unfulfillable = on_unfulfillable
        # 범위 밖 소싱처 미등록 주문 중 이미 연결을 시도한 주문(주기마다 되풀이하지 않는다)
        self._linked_only: set[str] = set()
        # 소싱처를 추정도 못 한 주문 — 샵마인·EMP 의 판매자상품코드를 읽어 달라고 넘긴다(주문번호, 판매처)
        self._on_unlinked = on_unlinked
        self._lookup_asked: set[str] = set()
        # 슬랙 `수집 중지` 가 세우는 깃발. 세워져 있으면 run_once 는 아무것도 하지 않는다
        self.paused = False

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def run_once(self) -> IntakeReport:
        """한 바퀴. 삼바웨이브가 응답하지 않으면 빈 보고를 돌려주고 다음 주기를 기다린다."""
        if self.paused:
            return IntakeReport()
        try:
            orders = self._wave.pending_orders(days=self._days)
        except WaveError as e:
            log.warning('자동 수집 실패 — 다음 주기에 다시 해본다: %s', e)
            return IntakeReport()

        seen = enqueued = skipped_live = unsupported = 0
        handled: set[str] = set()
        for wave_order in sorted(orders, key=_paid_key):
            seen += 1
            order = wave_order.to_order_ref()
            self._ask_lookup(wave_order)
            if not self._in_scope(wave_order):
                # 이행 범위 밖이라도 소싱처 미등록 주문은 상품관리 상품에 연결만 해 둔다(사용자 2026-09-25 — ABC마트).
                # 연결되면 소싱처가 채워져 다음 주기부터는 추정 주문이 아니다
                if wave_order.source_inferred and order.wave_key not in self._linked_only:
                    self._linked_only.add(order.wave_key)
                    self._link_inferred(wave_order, None, None)
                continue
            # 작업은 삼바웨이브 행(id) 단위다 — 같은 상품주문번호라도 행(사이즈)이 다르면 따로 산다
            if order.wave_key in handled or self._already_queued(order):
                skipped_live += 1
                continue
            if enqueued + unsupported >= self._max_new:
                break
            handled.add(order.wave_key)
            ts = self._post_new(intake_line(order))
            job, _created = self._queue.enqueue(
                order.order_no, self._requester, {}, thread_ts=ts, wave_id=order.wave_id
            )
            if self._supported(order):
                if wave_order.source_inferred and not self._link_inferred(wave_order, job.id, ts):
                    continue
                enqueued += 1
                continue
            # 맡을 구매 에이전트가 없다 — 큐에 흔적만 남기고 바로 사람에게 넘긴다
            unsupported += 1
            self._queue.finish(job.id, 'needs_human', error=f'unsupported: {order.source}')
            self._post_line(ts, f'미지원 소싱처: {order.source} — 사람이 처리해야 합니다')
        return IntakeReport(
            seen=seen, enqueued=enqueued, skipped_live=skipped_live, unsupported=unsupported
        )

    def _ask_lookup(self, wave_order: WaveOrder) -> None:
        """소싱처가 없고 상품명으로 추정도 못 한 주문 — 판매자상품코드 읽기를 한 번 요청한다."""
        if self._on_unlinked is None or (wave_order.source_site or '').strip():
            return
        if wave_order.order_number in self._lookup_asked:
            return
        self._lookup_asked.add(wave_order.order_number)
        target = self._on_unlinked(wave_order.order_number, wave_order.seller)
        if target:
            log.info(
                '소싱처 미등록 주문 %s — 판매자상품코드 읽기 요청(%s)',
                wave_order.order_number,
                target,
            )

    def _link_inferred(self, wave_order: WaveOrder, job_id: int | None, ts: str | None) -> bool:
        """소싱처 미등록 주문(상품명 숫자로 무신사·ABC마트 추정)을 수집상품에 연결한다. 이행을 이어 가면 True.

        소싱처에서 상품이 사라졌으면(삼바웨이브 404) 재고X·취소요청으로 마감한다. 그 밖의 연결 실패는 근거만
        남기고 구매는 이어 간다 — 추정한 상품 URL 로 살 수는 있다. job_id 가 없으면 연결만 한다(범위 밖).
        """
        site = wave_order.source_site or 'MUSINSA'
        product_id = wave_order.inferred_product_id or ''
        label = f'{site} {product_id}'
        key = (wave_order.id or '').strip() or wave_order.order_number
        try:
            out = self._wave.link_product(key, product_id, site)
        except WaveError as e:
            log.info('소싱처 미등록 주문 연결 실패 %s %s: %s', wave_order.order_number, label, e)
            if e.status == 404:
                if job_id is not None:
                    self._queue.finish(job_id, 'needs_human', error=str(FailReason.OUT_OF_STOCK))
                done = (
                    self._on_unfulfillable(key, str(FailReason.OUT_OF_STOCK))
                    if self._on_unfulfillable
                    else None
                )
                self._post_line(
                    ts,
                    f'소싱처 상품 없음({label}) — 재고X' + (f' · {done}' if done else ''),
                )
                return False
            self._post_line(ts, f'수집상품 연결 실패({label}): {e} — 구매는 이어 간다')
            return True
        how = '새로 수집해 연결' if out.get('collected') else '상품관리 상품에 연결'
        log.info('소싱처 미등록 주문 연결 %s → %s %s', wave_order.order_number, label, how)
        self._post_line(ts, f'소싱처 미등록 → {label} {how}(주문 {out.get("linked_orders", 1)}건)')
        return True

    def run_forever(self, stop: Callable[[], bool], interval_s: float) -> None:
        """주기 실행. 멈춤 신호는 대기 중에도 `TICK_S` 마다 확인한다."""
        while not stop():
            try:
                self.run_once()
            except Exception:  # 한 바퀴가 깨져도 고리는 계속 돈다
                log.exception('자동 수집 한 바퀴가 실패했다 — 다음 주기로 넘어간다')
            waited = 0.0
            while waited < interval_s and not stop():
                nap = min(TICK_S, interval_s - waited)
                time.sleep(nap)
                waited += nap

    def _in_scope(self, order: WaveOrder) -> bool:
        """수집 범위 안인가 — 소싱처 목록·포이즌 판매만(사용자 설정)."""
        if self._sources and str(order.source_site or '').upper() not in self._sources:
            return False
        if self._poison_only and str(order.source_site or '').upper() not in self._all_sellers:
            from samba_agent.supervisor.policy import is_poison_seller

            if not is_poison_seller(order.seller):
                return False
        return True

    def _already_queued(self, order: OrderRef) -> bool:
        """큐에 어떤 상태로든 이미 있는 삼바웨이브 행인가.

        살아 있는 건은 물론이고 needs_human·failed·cancelled 로 끝난 건도 건너뛴다 — 삼바웨이브에서는
        여전히 미이행이라 매 주기 되살아나 사람이 정리하기 전까지 무한 반복된다. 다시 돌리는 건
        슬랙 `이어서`(retry) 나 사람의 결정이다. 행 id 로 찾고, 행 id 가 없는 옛 행은 같은 상품주문번호면
        막되 done 이면 막지 않는다(이미 기입한 다른 행 — 실기 20261005DFA7D9 230 done 뒤 210 이 안 들어갔다).
        """
        return self._queue.find(order.order_no, order.wave_id) is not None

    def _supported(self, order: OrderRef) -> bool:
        """이 소싱처를 맡을 구매 에이전트가 있는가.

        등록부(`Registry.pick`)를 주면 그 판단을 그대로 쓰고, 소싱처 표(`Sources`)만 주면
        표에 있고 `hold` 가 아닌지로 본다. 둘 다 아니면 막지 않는다(판단할 근거가 없다).
        """
        pick = getattr(self._registry, 'pick', None)
        if callable(pick):
            return pick('buyer', order, {}) is not None
        by_id = getattr(self._registry, 'by_id', None)
        if callable(by_id):
            found = by_id(order.source)
            return found is not None and found.status != 'hold'
        return True
