"""교차 검증 — 하네스가 기입한 값(장부)과 삼바웨이브에 지금 들어 있는 값을 주기적으로 대조한다.

[2026-10-01 사고] 외부 프로그램이 발주 끝난 주문 약 270건의 실구매가·주문계정을 덮어썼는데
하네스는 기입 직후 한 번만 되읽어서 몰랐다. 기입할 때 장부(ledger.sqlite)에 값을 남기고,
그 뒤로도 삼바웨이브 값이 장부와 같은지 계속 본다. 다르면 알리고, 실구매가·주문계정은 한 번 되돌린다.

    python -m samba_agent.ops.crosscheck backfill   # 하네스 로그에서 장부를 채운다
    python -m samba_agent.ops.crosscheck check      # 한 번 대조하고 다른 것을 찍는다(되돌리지 않는다)
"""

from __future__ import annotations

import glob
import json
import logging
import re
import sqlite3
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from samba_agent.wave.client import WaveClient, WaveOrder

_log = logging.getLogger(__name__)

# 실구매가가 이만큼 넘게 다르면 덮어쓴 것으로 본다(적립 확정 같은 몇백 원 보정은 사람이 한 것 — 건드리지 않는다)
COST_GAP_MIN_WON = 1000
COST_GAP_RATE = 0.03
# 취소·반품으로 원가를 지운 주문은 장부와 달라도 정상이다
_VOID_STATES = {
    'cancelled', 'cancel_requested', 'cancelling', 'returned', 'returning', 'return_requested',
    'exchange_requested', 'exchanging', 'exchanged',
}  # fmt: skip
DEFAULT_DAYS = 14
# 발송 전 상태 — 이때만 소싱처 주문이 취소됐는지 본다
_BEFORE_SHIP_STATES = {'wait_ship', 'preparing'}
# 소싱처 주문 상세로 상태를 읽을 수 있는 곳(상태 글자가 확인된 스크립트만)
SOURCE_CHECK_SITES = {'MUSINSA'}
SOURCE_CHECKS_PER_CYCLE = 3
SOURCE_RECHECK_HOURS = 6
# 로그에서 되살린 줄의 restored_at 표시 — 자동으로 되돌리지 않는다
BACKFILLED = 'backfill'
DEFAULT_INTERVAL_S = 600.0


@dataclass(frozen=True)
class LedgerRow:
    """하네스가 기입한 주문 한 줄."""

    order_no: str
    source_order_no: str
    cost: float
    shipping_fee: float
    account: str
    site: str
    recorded_at: str
    state: str = 'ok'
    restored_at: str | None = None
    source_checked_at: str | None = None


@dataclass(frozen=True)
class Finding:
    """장부와 다른 값 하나."""

    order_no: str
    field: str  # 'source_order_no' | 'cost' | 'account'
    ledger: str
    actual: str

    def line(self) -> str:
        label = {'source_order_no': '소싱주문번호', 'cost': '실구매가', 'account': '주문계정'}[self.field]
        return f'{self.order_no} {label}: 하네스 기입 {self.ledger} → 지금 {self.actual}'


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec='seconds')


def _login_id(value: str | None) -> str:
    return (value or '').strip().split('@')[0].lower()


class Ledger:
    """하네스 기입 장부(sqlite). 연결은 부를 때마다 열고 닫는다 — 기록·점검 스레드가 따로 쓴다."""

    def __init__(self, path: Path | str) -> None:
        self._path = str(path)
        with self._open() as db:
            db.execute(
                'CREATE TABLE IF NOT EXISTS ledger('
                'order_no TEXT NOT NULL, source_order_no TEXT NOT NULL, cost REAL NOT NULL, '
                'shipping_fee REAL NOT NULL DEFAULT 0, account TEXT NOT NULL DEFAULT "", '
                'site TEXT NOT NULL DEFAULT "", recorded_at TEXT NOT NULL, '
                'state TEXT NOT NULL DEFAULT "ok", restored_at TEXT, '
                'PRIMARY KEY(order_no, source_order_no))'
            )
            cols = {r[1] for r in db.execute('PRAGMA table_info(ledger)')}
            if 'source_checked_at' not in cols:
                db.execute('ALTER TABLE ledger ADD COLUMN source_checked_at TEXT')

    def _open(self) -> sqlite3.Connection:
        db = sqlite3.connect(self._path, timeout=20)
        db.row_factory = sqlite3.Row
        return db

    def put(
        self,
        order_no: str,
        source_order_no: str,
        cost: float,
        shipping_fee: float = 0,
        account: str = '',
        site: str = '',
        recorded_at: str | None = None,
        *,
        trusted: bool = True,
    ) -> None:
        """기입한 값을 남긴다. 같은 주문·소싱번호를 다시 적으면 새 값으로 바꾼다(재기입).

        ``trusted=False`` 는 로그에서 되살린 줄 — 다르면 알리기만 하고 되돌리지는 않는다(로그 짝짓기가 틀릴 수 있다).
        """
        with self._open() as db:
            db.execute(
                'INSERT INTO ledger(order_no, source_order_no, cost, shipping_fee, account, site, recorded_at, restored_at) '
                'VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(order_no, source_order_no) DO UPDATE SET '
                'cost=excluded.cost, shipping_fee=excluded.shipping_fee, account=excluded.account, '
                'site=excluded.site, recorded_at=excluded.recorded_at, state="ok", restored_at=excluded.restored_at',
                (
                    order_no,
                    source_order_no,
                    float(cost),
                    float(shipping_fee),
                    account,
                    site,
                    recorded_at or _now(),
                    None if trusted else BACKFILLED,
                ),
            )

    def recent(self, days: int = DEFAULT_DAYS) -> list[LedgerRow]:
        """최근 기입 중 아직 살아 있는 줄(주문마다 가장 나중 것). 취소·원복으로 끝난 줄은 뺀다."""
        since = (datetime.now(UTC) - timedelta(days=days)).isoformat(timespec='seconds')
        with self._open() as db:
            rows = db.execute(
                'SELECT * FROM ledger WHERE recorded_at >= ? ORDER BY recorded_at', (since,)
            ).fetchall()
        latest: dict[str, LedgerRow] = {}
        for r in rows:
            latest[r['order_no']] = LedgerRow(**dict(r))
        return [r for r in latest.values() if r.state == 'ok']

    def mark(self, row: LedgerRow, state: str) -> None:
        with self._open() as db:
            db.execute(
                'UPDATE ledger SET state=? WHERE order_no=? AND source_order_no=?',
                (state, row.order_no, row.source_order_no),
            )

    def mark_source_checked(self, row: LedgerRow) -> None:
        with self._open() as db:
            db.execute(
                'UPDATE ledger SET source_checked_at=? WHERE order_no=? AND source_order_no=?',
                (_now(), row.order_no, row.source_order_no),
            )

    def mark_restored(self, row: LedgerRow) -> None:
        with self._open() as db:
            db.execute(
                'UPDATE ledger SET restored_at=? WHERE order_no=? AND source_order_no=?',
                (_now(), row.order_no, row.source_order_no),
            )


_default: Ledger | None = None
_default_lock = threading.Lock()


def configure(path: Path | str) -> Ledger:
    """기록 에이전트가 쓸 장부를 정한다(하네스 시작 때 한 번)."""
    global _default
    with _default_lock:
        _default = Ledger(path)
        return _default


def note_recorded(
    order_no: str, source_order_no: str, cost: float, shipping_fee: float, account: str, site: str
) -> None:
    """기입이 끝난 값을 장부에 남긴다. 장부가 없거나 쓰기에 실패해도 주문 진행은 막지 않는다."""
    if _default is None or not order_no or not source_order_no:
        return
    try:
        _default.put(order_no, source_order_no, cost, shipping_fee, account, site)
    except sqlite3.Error:
        _log.exception('교차 검증 장부 기록 실패: %s', order_no)


def is_void(order: WaveOrder) -> bool:
    """취소·반품·원복으로 이행 기록이 지워진 주문인가(장부와 달라도 정상)."""
    status = (order.status or '').strip().lower()
    if status in _VOID_STATES:
        return True
    return not (order.sourcing_order_number or '').strip() and not float(order.cost or 0)


def compare(row: LedgerRow, order: WaveOrder) -> list[Finding]:
    """장부 한 줄과 삼바웨이브 주문을 대조한다. 같으면 빈 목록."""
    found: list[Finding] = []
    actual_no = (order.sourcing_order_number or '').strip()
    if actual_no != row.source_order_no:
        found.append(Finding(row.order_no, 'source_order_no', row.source_order_no, actual_no or '(빈칸)'))
        return found  # 다른 구매 기록이다 — 값 대조는 뜻이 없다
    actual_cost = float(order.cost or 0)
    if abs(actual_cost - row.cost) > max(COST_GAP_MIN_WON, row.cost * COST_GAP_RATE):
        found.append(Finding(row.order_no, 'cost', f'{row.cost:,.0f}원', f'{actual_cost:,.0f}원'))
    actual_account = _login_id(order.sourcing_account_username)
    if row.account and actual_account and actual_account != _login_id(row.account):
        found.append(Finding(row.order_no, 'account', row.account, order.sourcing_account_username or ''))
    return found


class CrossChecker:
    """장부의 최근 기입을 삼바웨이브와 대조하고, 다른 값을 알리고 한 번 되돌린다."""

    def __init__(
        self,
        ledger: Ledger,
        wave: WaveClient,
        alert: Callable[[str], object] | None = None,
        *,
        restore: bool = True,
        days: int = DEFAULT_DAYS,
        source_status: Callable[[LedgerRow], str | None] | None = None,
        idle: Callable[[], bool] | None = None,
    ) -> None:
        self._ledger = ledger
        self._wave = wave
        self._alert = alert
        self._restore = restore
        self._days = days
        # 소싱처 주문 상세의 상태 글자를 읽는 함수(브라우저를 쓴다) — 주문 작업이 없을 때만 부른다
        self._source_status = source_status
        self._idle = idle
        self._told: set[tuple[str, str, str]] = set()

    def run_once(self) -> list[Finding]:
        from samba_agent.wave.client import WaveError

        all_found: list[Finding] = []
        fixed: list[str] = []
        before_ship: list[LedgerRow] = []
        for row in self._ledger.recent(self._days):
            try:
                order = self._wave.get_order(row.order_no, sourcing_order_number=row.source_order_no)
            except WaveError as e:
                _log.debug('교차 검증: %s 조회 실패 — 다음 주기에 다시 본다: %s', row.order_no, e)
                continue
            if is_void(order):
                self._ledger.mark(row, 'voided')
                continue
            if (order.status or '').strip().lower() in _BEFORE_SHIP_STATES:
                before_ship.append(row)
            found = compare(row, order)
            if not found:
                continue
            all_found.extend(found)
            if self._restore and row.restored_at is None and self._restore_row(row, order, found):
                fixed.append(row.order_no)
        fresh = [f for f in all_found if (f.order_no, f.field, f.actual) not in self._told]
        if fresh:
            self._told.update((f.order_no, f.field, f.actual) for f in fresh)
            lines = [f.line() + (' — 하네스 기입 값으로 되돌림' if f.order_no in fixed else '') for f in fresh]
            text = f'⚠ [교차 검증] 하네스 기입과 삼바웨이브 값이 다르다 {len(fresh)}건\n' + '\n'.join(lines[:30])
            _log.warning(text)
            if self._alert is not None:
                try:
                    self._alert(text)
                except Exception:  # noqa: BLE001 — 알림 실패가 점검을 멈추게 하지 않는다
                    _log.exception('교차 검증 알림 실패')
        self._check_sources(before_ship)
        return all_found

    def _check_sources(self, rows: list[LedgerRow]) -> None:
        """아직 발송 전인 이행 주문의 소싱처 주문이 취소됐는지 본다(한 주기에 몇 건씩, 주문 작업이 없을 때만).

        소싱처에서 취소됐는데 삼바웨이브에는 이행으로 남으면 고객 주문이 방치된다(실기 2026-10-01 비니·나이키).
        """
        if self._source_status is None:
            return
        since = (datetime.now(UTC) - timedelta(hours=SOURCE_RECHECK_HOURS)).isoformat(timespec='seconds')
        due = [r for r in rows if r.site in SOURCE_CHECK_SITES and (r.source_checked_at or '') < since]
        for row in due[:SOURCE_CHECKS_PER_CYCLE]:
            if self._idle is not None and not self._idle():
                return
            try:
                status = self._source_status(row)
            except Exception:  # noqa: BLE001 — 한 건 실패로 점검을 멈추지 않는다
                _log.exception('교차 검증: %s 소싱처 상태 확인 실패', row.order_no)
                continue
            if status is None:
                continue  # 못 읽었다 — 다음 주기에 다시 본다
            self._ledger.mark_source_checked(row)
            if '취소' in status and '요청' not in status:
                text = (
                    f'⚠ [교차 검증] 소싱처 주문이 취소됐는데 삼바웨이브는 이행 상태다 — {row.order_no} '
                    f'({row.site} {row.source_order_no}, 상태 "{status}"). 기록을 주문접수로 되돌리고 다시 사야 한다'
                )
                _log.warning(text)
                if self._alert is not None:
                    try:
                        self._alert(text)
                    except Exception:  # noqa: BLE001 — 알림 실패가 점검을 멈추게 하지 않는다
                        _log.exception('교차 검증 알림 실패')

    def _restore_row(self, row: LedgerRow, order: WaveOrder, found: list[Finding]) -> bool:
        """실구매가·주문계정을 장부 값으로 한 번 되돌린다. 소싱주문번호가 다르면 손대지 않는다(재구매·사람 수정)."""
        from samba_agent.wave.client import WaveError

        if any(f.field == 'source_order_no' for f in found):
            return False
        account_id = self._wave.sourcing_account_id(row.site, row.account) if row.site and row.account else None
        try:
            self._wave.record_sourcing(
                row.order_no,
                sourcing_order_number=row.source_order_no,
                cost=row.cost,
                # 배송비는 사람이 바꾸는 값(반품비·까대기)이라 지금 값을 지킨다
                shipping_fee=float(order.shipping_fee or 0),
                sourcing_account_id=account_id,
            )
        except WaveError:
            _log.exception('교차 검증: %s 되돌리기 실패', row.order_no)
            return False
        self._ledger.mark_restored(row)
        return True

    def run_forever(self, should_stop: Callable[[], bool], interval_s: float = DEFAULT_INTERVAL_S) -> None:
        import time

        while not should_stop():
            try:
                self.run_once()
            except Exception:  # noqa: BLE001 — 점검 고리는 죽지 않는다
                _log.exception('교차 검증 주기 실패')
            waited = 0.0
            while waited < interval_s and not should_stop():
                time.sleep(2.0)
                waited += 2.0


# ── 로그에서 장부 채우기 ──────────────────────────────────────────────────────────────────

_SITE_OF_BUYER = {
    'musinsa': 'MUSINSA', 'cm29': '29CM', 'lotteon': 'LOTTEON', 'abc': 'ABCmart', 'ssg': 'SSG',
    'fashionplus': 'FashionPlus', 'shoemaker': 'SHOEMAKER', 'hmall': 'TheHyundai', 'gsshop': 'GSShop',
}  # fmt: skip


def _buyer_of(source_order_no: str) -> str | None:
    """소싱주문번호 모양으로 산 사이트를 가린다(교차 비교로 계정 선택 줄이 여러 사이트 것일 때)."""
    if source_order_no.startswith('ORD'):
        return 'cm29'
    if re.fullmatch(r'\d{18}', source_order_no):
        return 'musinsa'
    if re.fullmatch(r'\d{16}', source_order_no):
        return 'lotteon'
    return None


def backfill(ledger: Ledger, log_dir: Path) -> int:
    """하네스 로그의 기입(PUT …/sourcing 200 + [기입 확인])을 장부에 넣는다. 넣은 줄 수를 준다."""
    count = 0
    for path in sorted(glob.glob(str(log_dir / 'harness-2*.log'))):
        m = re.search(r'harness-(\d{4})(\d{2})(\d{2})-', path)
        if not m:
            continue
        day = '-'.join(m.groups())
        accounts: dict[str, str] = {}
        last_buyer = ''
        last_put: str | None = None
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                hit = re.search(r'buyer\.(\w+) 근거 \[계정 선택\] (\S+)', line)
                if hit:
                    last_buyer = hit.group(1)
                    accounts[last_buyer] = hit.group(2)
                    continue
                hit = re.search(r'PUT \S+/orders/([^/\s]+)/sourcing "HTTP/1.1 200', line)
                if hit:
                    last_put = hit.group(1).replace('%20', ' ')
                    continue
                if '[기입 확인]' in line and last_put:
                    try:
                        values = json.loads(line.split('[기입 확인]')[1])
                    except ValueError:
                        continue
                    no = str(values.get('source_order_no') or '')
                    if no:
                        buyer = _buyer_of(no) or last_buyer
                        # 로그 시각은 한국 시각이다
                        at = datetime.fromisoformat(f'{day}T{line[:8]}+09:00').astimezone(UTC)
                        account = accounts.get(buyer, '')
                        ledger.put(
                            last_put, no, float(values.get('real_price') or 0),
                            float(values.get('shipping_fee') or 0),
                            '' if '*' in account else account,  # 로그에서 가려진 아이디는 모르는 값이다
                            _SITE_OF_BUYER.get(buyer, ''), at.isoformat(timespec='seconds'), trusted=False,
                        )  # fmt: skip
                        count += 1
                    last_put = None
                    accounts = {}
    return count


def main(argv: list[str] | None = None) -> int:
    from samba_agent.settings import load_settings
    from samba_agent.wave.client import WaveClient

    args = list(sys.argv[1:] if argv is None else argv)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    settings = load_settings()
    ledger = Ledger(settings.root / 'ledger.sqlite')
    cmd = args[0] if args else 'check'
    if cmd == 'backfill':
        print(f'장부에 {backfill(ledger, settings.root / "logs")}줄 넣음')
        return 0
    if cmd in ('check', 'fix'):
        if not (settings.wave_internal_token and settings.wave_tenant_id):
            print('삼바웨이브 설정이 없다')
            return 2
        wave = WaveClient(
            settings.wave_url, settings.wave_internal_token.get_secret_value(), settings.wave_tenant_id
        )
        found = CrossChecker(ledger, wave, restore=cmd == 'fix').run_once()
        for f in found:
            print(f.line())
        print(f'장부 {len(ledger.recent())}건 중 다른 값 {len(found)}개')
        return 1 if found else 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
