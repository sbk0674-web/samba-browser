"""`python -m samba_agent.export` — 입력 작업자 실행과 큐 관리.

worker                   입력 작업자를 띄운다(관리자 권한으로 실행해야 EMP 에 입력된다)
list [--limit N]         최근 요청을 본다
requeue ORDER_NO TARGET  실패한 요청을 같은 값으로 다시 대기시킨다
shopmine [--dry] [주문번호…]  샵마인 완료됨 지정을 큐 갱신 없이 한 번 돌린다(--dry 는 체크까지만)
"""

import argparse
import logging
import signal
import sys
import threading
from pathlib import Path
from typing import get_args

from samba_agent.export.adapters import AdapterReject, AdapterRetry
from samba_agent.export.desktop import build_adapters
from samba_agent.export.desktop.shopmine import ShopMineAdapter
from samba_agent.export.idle import user_idle_seconds
from samba_agent.export.routing import QueueTarget
from samba_agent.export.store import ExportQueue
from samba_agent.export.worker import ExportWorker
from samba_agent.settings import DEFAULT_ROOT, load_settings

log = logging.getLogger(__name__)

EMP_MIN_IDLE_S = 180.0


def _list(queue: ExportQueue, limit: int) -> int:
    rows = queue.recent(limit)
    if not rows:
        print('외부 기입 요청이 없다')
        return 0
    for r in rows:
        tail = f' {r.fail_reason}: {r.detail}' if r.fail_reason else f' {r.detail or ""}'
        print(
            f'{r.updated_at} {r.order_no} {r.target} {r.status}'
            f' 원가 {r.cost:,} 배송비 {r.shipping_fee:,} 시도 {r.attempts}{tail}'
        )
    return 0


def _requeue(queue: ExportQueue, order_no: str, target: str) -> int:
    req = queue.requeue(order_no, target)
    if req is None:
        print(f'{order_no}({target}) 실패한 요청이 없다')
        return 1
    print(f'{req.order_no}({req.target}) 다시 대기 — 원가 {req.cost:,} 배송비 {req.shipping_fee:,}')
    return 0


def _shopmine_ui():
    from samba_agent.export.desktop.shopmine_ui import PywinautoShopMineUi

    return PywinautoShopMineUi()


# 테스트가 바꿔 끼울 수 있게 모듈 이름으로 둔다
PywinautoShopMineUi = _shopmine_ui


def _shopmine(dry: bool, order_nos: list[str], queue: ExportQueue) -> int:
    """샵마인 완료됨 지정을 큐 갱신 없이 한 번 돌린다 — 실기 시험용.

    주문번호를 주지 않으면 큐에 대기 중인 샵마인 요청의 주문번호를 쓴다(큐 상태는 바꾸지 않는다).
    """
    wanted = order_nos or queue.pending_order_nos('shopmine')
    if not wanted:
        print('샵마인에 넘길 주문번호가 없다(인자로 주거나 큐에 대기 요청이 있어야 한다)')
        return 1
    adapter = ShopMineAdapter(PywinautoShopMineUi(), dry_run=dry)
    try:
        done = adapter.complete_pending(wanted)
    except (AdapterRetry, AdapterReject) as e:
        print(f'샵마인 처리 못 함 — {e.reason.value}: {e.detail}')
        return 2
    label = '찾아서 체크(누르지 않음)' if dry else '완료됨 처리'
    print(f'샵마인 {label} {len(done)}건 / 요청 {len(wanted)}건: {", ".join(sorted(done)) or "-"}')
    return 0


def _auth_toast(program: str, detail: str) -> None:
    from samba_agent.export.desktop import toast

    name = {'shopmine': '샵마인', 'emp': 'EMP(플레이오토)'}.get(program, program)
    if '인증' in detail:
        toast.show(f'{name} 인증 필요', f'{detail}\n인증하면 외부 기입이 이어서 돈다.')
    else:
        toast.show(f'{name} 창이 막혀 있다', f'{detail}\n창을 닫으면 외부 기입이 이어서 돈다.')


def _worker(queue: ExportQueue, targets: tuple[str, ...]) -> int:
    adapters = build_adapters(targets)
    if not adapters:
        log.warning('등록된 어댑터가 없다 — 요청은 큐에 대기로 남는다')
    recovered = queue.recover_running(tuple(adapters))
    if recovered:
        log.info('도중에 끊긴 요청 %d건을 되돌렸다', recovered)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_a: stop.set())
    signal.signal(signal.SIGTERM, lambda *_a: stop.set())
    log.info('입력 작업자 시작 — 대상 %s', ', '.join(adapters) or '없음')
    ExportWorker(
        queue,
        adapters,
        user_idle_s=user_idle_seconds,
        # 샵마인은 창 메시지로만 만져 사람이 PC 를 쓰는 중에도 돈다
        min_idle_s=0.0,
        # EMP 는 조작하면 창이 앞으로 나온다 — 키보드·마우스가 3분 넘게 멈췄을 때만 한다(사용자 지시 2026-09-29)
        min_idle_by_target={t: EMP_MIN_IDLE_S for t in adapters if t.startswith('emp')},
        # 인증 창은 사람이 처리한다 — 슬랙을 안 보니 윈도우 알림으로 바로 알린다(사용자 2026-09-29)
        on_auth_required=_auth_toast,
    ).run_forever(stop.is_set)
    return 0


def main(argv: list[str] | None = None) -> int:
    # 예약 작업(Task Scheduler)의 콘솔은 cp949 라 한글 로그·print 가 UnicodeEncodeError 로 죽는다.
    # reconfigure 가 없는 스트림(테스트의 캡처 버퍼 등)은 건드리지 않는다.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(prog='python -m samba_agent.export')
    # 예약 작업(Task Scheduler)은 System32 에서 시작해 cwd 기준 .env 를 못 찾는다 — 항상
    # 하네스 폴더의 .env 를 읽는다. --db 는 그 값을 다시 덮어써(예: 시험 삼아 다른 파일을 볼 때) 쓴다.
    parser.add_argument('--db', type=Path, default=None, help='큐 파일 경로(설정값을 덮어쓴다)')
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('worker', help='입력 작업자를 띄운다')
    p_list = sub.add_parser('list', help='최근 요청을 본다')
    p_list.add_argument('--limit', type=int, default=20)
    p_requeue = sub.add_parser('requeue', help='실패한 요청을 다시 대기시킨다')
    p_requeue.add_argument('order_no')
    p_requeue.add_argument('target', choices=list(get_args(QueueTarget)))
    p_shop = sub.add_parser('shopmine', help='샵마인 일괄 완료됨을 한 번 돌린다')
    p_shop.add_argument('--dry', action='store_true', help='완료됨을 누르지 않고 행 체크까지만')
    p_shop.add_argument('order_nos', nargs='*', help='대상 주문번호(없으면 큐의 샵마인 대기 요청)')
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s.%(msecs)03d %(levelname)s:%(name)s:%(message)s',
        datefmt='%H:%M:%S',
    )
    settings = load_settings(DEFAULT_ROOT / '.env')
    db_path = args.db if args.db is not None else settings.export_db_path
    queue = ExportQueue(db_path)
    if args.cmd == 'shopmine':
        return _shopmine(args.dry, list(args.order_nos), queue)
    if args.cmd == 'list':
        return _list(queue, args.limit)
    if args.cmd == 'requeue':
        return _requeue(queue, args.order_no, args.target)
    return _worker(queue, settings.export_target_list)


if __name__ == '__main__':
    raise SystemExit(main())
