"""결제 후 확인한 무신사머니 잔액을 알린다. KST 00:00~06:59에는 전송하지 않는다."""

import logging
import math
import re
import sqlite3
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path

from samba_agent import local_aliases
from samba_agent.ops.sms_alerts import SmsDeliveryUnknown

log = logging.getLogger(__name__)
ACCOUNTS = frozenset({local_aliases.apply('buyer01'), local_aliases.apply('buyer02')})
BANDS = ((0, 200000), (500000, 700000), (1000000, 1200000), (1500000, 1700000))
KST = timezone(timedelta(hours=9))

# 결제 완료 후 같은 계정의 마이페이지를 새로 읽는다. 결제 전 견적에서 차감해 추정하지 않는다.
# 이 탭만 닫고 원래 결제 완료 탭을 복원한다. 원가 기록과 결제 재시도에는 관여하지 않는다.
MUSINSA_BALANCE_JS = r'''
const old = (await tabs.list()).find(t => t.active)
let id = null
try {
  id = (String(await tabs.open({url:'https://www.musinsa.com/mypage',profile:PROFILE})).match(/tab (\S+)/)||[])[1]
  if (!id) return JSON.stringify({verified:false})
  await tabs.switch(id)
  try { await page.waitFor('무신사머니',6000) } catch(e) {}
  const tree = String((await page.get({})).tree || '')
  const values = [...tree.matchAll(/^\[\d+\] button "무신사머니\s+([\d,]+)\s*원"/gm)]
    .map(m => Number(m[1].replace(/,/g,'')))
  const unique = [...new Set(values)]
  return JSON.stringify(unique.length===1 && Number.isSafeInteger(unique[0]) && unique[0]>=0
    ? {verified:true,balance:unique[0]} : {verified:false})
} finally {
  if (id) { try { await tabs.close(id) } catch(e) {} }
  if (old) { try { await tabs.switch(old.id) } catch(e) {} }
}
'''


def money_value(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        if not re.fullmatch(r'\d+|\d{1,3}(?:,\d{3})+', value):
            return None
        value = int(value.replace(',', ''))
    if not isinstance(value, int | float) or (
        isinstance(value, float) and not math.isfinite(value)
    ):
        return None
    if value < 0 or value > 2**63 - 1 or int(value) != value:
        return None
    return int(value)


def money_band(value: object) -> int | None:
    amount = money_value(value)
    if amount is None:
        return None
    return next((index for index, (low, high) in enumerate(BANDS) if low < amount <= high), None)


class MoneyBalanceAlerts:
    def __init__(
        self, path: Path, send: Callable[[str], object],
        *, now: Callable[[], datetime] | None = None,
    ) -> None:
        self.path = path
        self.send = send
        self.now = now or (lambda: datetime.now(KST))

    def flush(self) -> int:
        """야간에 미뤄 둔 알림을 보낸다 — 저장된 잔액의 구간이 마지막 발송 구간과 다르면 지금 보낸다.

        사용자 2026-11-08: 밤에 61만원대로 떨어진 계정 알림이 아침 이후에도 안 왔다(그 뒤 결제가 없어서).
        """
        if self.now().astimezone(KST).hour < 7:
            return 0
        try:
            with sqlite3.connect(self.path, timeout=30) as db:
                db.execute(
                    'CREATE TABLE IF NOT EXISTS money_alerts (account TEXT PRIMARY KEY, band INTEGER, balance INTEGER NOT NULL)'
                )
                rows = db.execute('SELECT account, band, balance FROM money_alerts').fetchall()
        except (OSError, sqlite3.Error) as exc:
            log.warning('무신사머니 알림 상태 읽기 실패: %s', type(exc).__name__)
            return 0
        sent = 0
        for account, band, balance in rows:
            now_band = money_band(balance)
            if account in ACCOUNTS and now_band is not None and now_band != band:
                if self.observe(account, [{'method': '무신사머니', 'balance': balance}]):
                    sent += 1
        return sent

    def observe(self, account: str, quotes: list[object]) -> bool:
        if account not in ACCOUNTS:
            return False
        values = {
            money_value(row.get('balance'))
            for row in quotes
            if isinstance(row, dict) and row.get('method') == '무신사머니'
        }
        if len(values) != 1 or None in values:
            return False
        balance = values.pop()
        band = money_band(balance)
        now = self.now().astimezone(KST)
        quiet = now.hour < 7
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self.path, timeout=30) as db:
                db.execute(
                    'CREATE TABLE IF NOT EXISTS money_alerts (account TEXT PRIMARY KEY, band INTEGER, balance INTEGER NOT NULL)'
                )
                db.execute('BEGIN IMMEDIATE')
                previous = db.execute(
                    'SELECT band FROM money_alerts WHERE account = ?', (account,)
                ).fetchone()
                posted = False
                if not quiet and band is not None and (previous is None or previous[0] != band):
                    low, high = BANDS[band]
                    message = (
                        f'🔔 무신사머니 잔액 알림\n계정: {account}\n잔액: {balance:,}원\n'
                        f'구간: {low // 10000}만원 초과~{high // 10000}만원 이하\n'
                        f'확인: {now:%Y-%m-%d %H:%M:%S} KST'
                    )
                    try:
                        delivered = self.send(message)
                    except SmsDeliveryUnknown:
                        db.execute(
                            'INSERT INTO money_alerts(account,band,balance) VALUES(?,?,?) '
                            'ON CONFLICT(account) DO UPDATE SET band=excluded.band,balance=excluded.balance',
                            (account, band, balance),
                        )
                        log.warning(
                            '무신사머니 문자 결과 미확인, 같은 구간 자동 재전송 보류: %s', account
                        )
                        return False
                    if not delivered:
                        log.warning('무신사머니 잔액 알림 전송 실패: %s', account)
                        return False
                    posted = True
                # 야간에는 발송 이력을 새로 만들지 않는다. 다음 주간 결제에서 실제 잔액을 다시 판단한다.
                saved_band = (previous[0] if previous else None) if quiet and band is not None else band
                db.execute(
                    'INSERT INTO money_alerts(account,band,balance) VALUES(?,?,?) '
                    'ON CONFLICT(account) DO UPDATE SET band=excluded.band,balance=excluded.balance',
                    (account, saved_band, balance),
                )
                return posted
        except (OSError, sqlite3.Error) as exc:
            log.warning('무신사머니 알림 상태 저장 실패: %s', type(exc).__name__)
            return False
