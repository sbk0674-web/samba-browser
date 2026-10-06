"""외부 기입 알림 — 실패한 요청, 그리고 나중에 끝난 요청의 성공을 그 주문의 슬랙 스레드에 한 번만 알린다.

하네스 프로세스에서 돈다(슬랙 봇이 거기 있다). 입력 작업자는 큐에 결과만 적는다.
"""

import logging
import re
import time
from collections.abc import Callable, Collection

from samba_agent.export.store import ExportQueue, ExportRequest

log = logging.getLogger(__name__)

# 판매자상품코드 속 삼바웨이브 수집상품 번호(cp_ + 26글자)
_COLLECTED_ID = re.compile(r'cp_[0-9A-Z]{26}')
LOOKUP_SUFFIX = '_lookup'


def _text(req: ExportRequest) -> str:
    return (
        f'{req.order_no} 외부 기입 실패({req.target}) — {req.fail_reason}: {req.detail or ""}\n'
        f'기입하려던 값: 원가 {req.cost:,} · 배송비 {req.shipping_fee:,} '
        '(주문은 완료 상태 그대로다. 직접 기입이 필요하다)'
    )


def _done_text(req: ExportRequest) -> str:
    if req.target.endswith('_cancel'):
        return f'{req.order_no} 외부 취소 연동 완료({req.target})'
    return (
        f'{req.order_no} 외부 기입 완료({req.target}) — '
        f'원가 {req.cost:,} · 배송비 {req.shipping_fee:,}'
    )


class ExportNotifier:
    """실패 알림 고리."""

    def __init__(
        self,
        queue: ExportQueue,
        thread_of: Callable[[str], str | None],
        post: Callable[[str | None, str], bool],
        *,
        # 스레드가 없는 주문(예: 자동 수집 이전 형식)도 놓치지 않게 최상위 메시지로 대신 올린다.
        # 없으면 옛 동작 그대로 — 스레드 없는 실패는 로그에만 남고 notified 로 표시된다.
        post_new: Callable[[str], object] | None = None,
        # 하네스가 결과를 기다리지 않는 대상(EMP) — 끝나면 성공도 알린다
        done_targets: Collection[str] = (),
        since: str = '',
        # 읽어 온 판매자상품코드로 주문을 수집상품에 잇는 함수(주문번호, 수집상품 번호) → 결과 한 줄
        link: Callable[[str, str], str] | None = None,
    ) -> None:
        self._queue = queue
        self._thread_of = thread_of
        self._post = post
        self._post_new = post_new
        self._done_targets = tuple(done_targets)
        # 이 시각 뒤에 들어온 요청만 알린다 — 예전에 끝난 요청을 한꺼번에 쏟아내지 않는다
        self._since = since
        self._link = link

    def tick(self) -> int:
        """알리지 않은 실패를 알린다. 이번에 알린 건수를 돌려준다."""
        sent = 0
        finished = (
            self._queue.unnotified_done(self._done_targets, self._since)
            if self._done_targets
            else []
        )
        todo = [(r, _text(r)) for r in self._queue.unnotified_failed()]
        todo += [(r, self._finish(r)) for r in finished]
        for req, text in todo:
            try:
                thread_ts = self._thread_of(req.order_no)
                if thread_ts is None and self._post_new is not None:
                    delivered = self._post_new(text) is not None
                else:
                    delivered = self._post(thread_ts, text)
            except Exception:
                # 표시하지 않는다 — 다음 바퀴에 다시 알린다
                log.exception('외부 기입 알림 전송 오류: %s', req.order_no)
                continue
            if not delivered:
                # 슬랙이 없는 실행 — 로그에 남기고 되풀이하지 않는다
                log.warning('%s', text)
            self._queue.mark_notified(req.id)
            sent += 1
        return sent

    def _finish(self, req: ExportRequest) -> str:
        """끝난 요청의 알림 글자. 읽기 요청이면 읽어 온 코드로 주문을 수집상품에 잇는다."""
        if not req.target.endswith(LOOKUP_SUFFIX):
            return _done_text(req)
        found = _COLLECTED_ID.search(req.detail or '')
        if found is None:
            return f'{req.order_no} 소싱처 미등록 — 판매자상품코드에 수집상품 번호가 없다({req.detail})'
        if self._link is None:
            return f'{req.order_no} 소싱처 미등록 — 수집상품 {found.group(0)} (연결 기능 꺼짐)'
        try:
            return self._link(req.order_no, found.group(0))
        except Exception as e:
            log.exception('소싱처 미등록 주문 연결 실패: %s', req.order_no)
            return f'{req.order_no} 소싱처 미등록 — 연결 실패({type(e).__name__}: {str(e)[:80]})'

    def run_forever(
        self,
        should_stop: Callable[[], bool],
        interval_s: float = 15.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        while not should_stop():
            try:
                self.tick()
            except Exception:
                log.exception('외부 기입 알림 고리 오류 — 계속한다')
            sleep(interval_s)
