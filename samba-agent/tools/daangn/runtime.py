"""당근 채팅 → 해당 폰 → 삼바 주문 저장. 로그와 기록에 채팅 본문을 남기지 않는다."""

from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
from zoneinfo import ZoneInfo

from tools.daangn.account_switch import AndroidAccountPhone, switch_account
from tools.daangn.android_phone import AndroidPhone
from tools.daangn.chat_bridge import ChatBridge
from tools.daangn.collector import collect_round
from tools.daangn.order_record import submit_collected_order
from tools.daangn.phone_worker import read_phone_order
from tools.daangn.reservation_journal import ReservationJournal

ADB = r'C:\Users\canno\Downloads\pt\platform-tools\adb.exe'
LOCK = r'C:\Users\canno\workspace\phone-locks\phone_lock.py'
ATTACHMENTS = Path(r'C:\Users\canno\workspace\samba_browser\.codex-remote-attachments')
RECEIPTS = ATTACHMENTS / 'daangn-batch-20261027' / 'direct-sale-sync'
log = logging.getLogger(__name__)


class CollectionState:
    def __init__(self, path: str):
        self.path = path
        with sqlite3.connect(path, timeout=10) as db:
            db.execute('CREATE TABLE IF NOT EXISTS collected (event_key TEXT PRIMARY KEY, order_id TEXT NOT NULL, pickup_number TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL)')

    def next_offset(self) -> int:
        with sqlite3.connect(self.path, timeout=10) as db:
            row = db.execute('SELECT value FROM cursor WHERE id=1').fetchone()
            value = row[0] if row else 0
            db.execute('INSERT INTO cursor(id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', (value + 1,))
            return value

    @staticmethod
    def key(candidate) -> str:
        raw = f'{candidate.account}\0{candidate.room_id}\0{candidate.last_at}'
        return hashlib.sha256(raw.encode('utf8')).hexdigest()

    def done(self, candidate) -> bool:
        with sqlite3.connect(self.path, timeout=10) as db:
            return db.execute('SELECT 1 FROM collected WHERE event_key=?', (self.key(candidate),)).fetchone() is not None

    def mark(self, candidate, result):
        number, order_id = str(result['pickup_number']), str(result['id'])
        if not number.isdecimal() or not order_id.startswith('ord_'):
            raise ValueError('주문 저장 확인 실패')
        RECEIPTS.mkdir(parents=True, exist_ok=True)
        path = RECEIPTS / f'{number}.json'
        receipt = {'pickup_number': f'당근 {number}', 'success': True, 'order_id': order_id}
        try:
            with path.open('x', encoding='utf8') as f:
                json.dump(receipt, f, ensure_ascii=False)
        except FileExistsError:
            with path.open(encoding='utf8') as f:
                if json.load(f) != receipt:
                    raise ValueError('기존 수거번호 기록이 다릅니다')
        with sqlite3.connect(self.path, timeout=10) as db:
            db.execute('INSERT OR IGNORE INTO collected VALUES (?, ?, ?)', (self.key(candidate), order_id, number))


def _phone_identity(account: str) -> tuple[str, str]:
    path = Path(os.environ['APPDATA']) / 'SAMBA Browser' / 'data.db'
    with sqlite3.connect(f'file:{path.as_posix()}?mode=ro', uri=True, timeout=5) as db:
        accounts = db.execute('SELECT display_name FROM daangn_accounts WHERE label=? AND state=?', (account, 'logged_in')).fetchall()
        phones = db.execute('SELECT serial FROM phones WHERE label=?', (account,)).fetchall()
    if len(accounts) != 1 or not accounts[0][0]:
        raise ValueError('당근 계정 확인 필요')
    # 임귀태는 사용자가 지정한 S22 복제본만 사용한다. 과거 등록 폰은 대체하지 않는다.
    serials = ['R5CT33ZR53H'] if account == '임귀태' else [p[0] for p in phones if p[0]]
    if len(serials) != 1:
        raise ValueError('대상 폰 확인 필요')
    return serials[0], accounts[0][0]


def _transport(serial: str) -> str:
    result = subprocess.run([ADB, 'devices'], capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError('ADB 연결 확인 실패')
    transports = [line.split()[0] for line in result.stdout.decode('utf8', 'replace').splitlines()
                  if len(line.split()) >= 2 and line.split()[1] == 'device']
    if serial in transports:
        return serial
    for target in transports:
        if target == serial:
            continue
        try:
            p = subprocess.run([ADB, '-s', target, 'shell', 'getprop', 'ro.serialno'],
                               capture_output=True, timeout=4)
            if p.returncode == 0 and p.stdout.decode('utf8', 'replace').strip() == serial:
                return target
        except subprocess.TimeoutExpired:
            continue
    raise RuntimeError('지정 폰이 연결되지 않았습니다')


def _phone_idle(phone: AndroidPhone):
    calls = phone._run('shell', 'dumpsys', 'telephony.registry').decode('utf8', 'replace')
    states = re.findall(r'mCallState\s*=\s*(\d+)', calls)
    if not states or any(state != '0' for state in states):
        raise RuntimeError('폰이 통화 중이거나 통화 상태를 확인할 수 없습니다')
    text = phone._run('shell', 'dumpsys', 'power').decode('utf8', 'replace')
    m = re.search(r'lastUserActivityTime=\d+\s*\((\d+) ms ago\)', text)
    if not m or int(m.group(1)) < 30000:
        raise RuntimeError('폰을 사용 중이거나 사용 상태를 확인할 수 없습니다')


def _prepare_account(phone: AndroidPhone, locks):
    if phone.verify_account(phone.owner):
        return
    # 현재 계정이 다르거나 앱이 다른 화면이면 USB 상태에서만 전체 닫기와 비행기모드를 수행한다.
    def open_target(account: str):
        package = 'com.pengyou.cloneapp' if phone.serial == 'R5CT33ZR53H' and account == '임귀태' else 'com.towneers.www'
        phone._run('shell', 'monkey', '-p', package, '-c', 'android.intent.category.LAUNCHER', '1')
        time.sleep(3)
        if package == 'com.pengyou.cloneapp':
            _xml, root = phone._screen()
            phone._tap_unique(root, '임귀태')
            time.sleep(2)
    device = AndroidAccountPhone(phone.adb, phone.serial, phone.lock_owner, locks.holder,
                                 open_target, phone.verify_account)
    switch_account(device, serial=phone.serial, target=phone.owner)


def make_phone_reader(journal: ReservationJournal):
    spec = importlib.util.spec_from_file_location('daangn_shared_phone_lock', LOCK)
    locks = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(locks)
    def inspect(candidate, chat):
        serial, nickname = _phone_identity(candidate.account)
        transport = _transport(serial)
        owner = 'daangn-order-collector'
        with locks.PhoneLock(serial, owner, minutes=5, wait=0, note='당근 주문 확인'):
            phone = AndroidPhone(adb=ADB, transport=transport, serial=serial, owner=candidate.account,
                nickname=nickname, lock_owner=owner, attachments=str(ATTACHMENTS),
                journal=journal, room_id=candidate.room_id)
            phone.assert_lock()
            phone.assert_connected()
            _phone_idle(phone)
            _prepare_account(phone, locks)
            today = datetime.now(ZoneInfo('Asia/Seoul')).date()
            return read_phone_order(phone, candidate, chat, today=today)
    return inspect


def run_round(settings, wave):
    RECEIPTS.mkdir(parents=True, exist_ok=True)
    state = CollectionState(str(RECEIPTS / 'collection-state.sqlite'))
    journal = ReservationJournal(str(RECEIPTS / 'reservation-attempts.sqlite'))
    # 계정 이름은 브라우저의 로그인된 채팅 계정과 폰 등록 이름이 정확히 같아야 한다.
    path = Path(os.environ['APPDATA']) / 'SAMBA Browser' / 'data.db'
    with sqlite3.connect(f'file:{path.as_posix()}?mode=ro', uri=True, timeout=5) as db:
        accounts = {r[0] for r in db.execute('SELECT label FROM daangn_accounts WHERE state=?', ('logged_in',)) if r[0]}
    chat = ChatBridge(settings.bridge_url, settings.bridge_token.get_secret_value(), accounts=accounts)
    try:
        return collect_round(chat=chat, inspect_phone=make_phone_reader(journal),
            submit=lambda order: submit_collected_order(wave, order), already_done=state.done,
            mark_done=state.mark, limit=15, offset=state.next_offset())
    finally:
        chat._client.close()


def run_forever(settings, wave, stop):
    while not stop.is_set():
        try:
            run_round(settings, wave)
        except Exception as exc:
            # 인증·연결·차단의 상세에는 민감한 값이 들어갈 수 있어 기록하지 않는다.
            log.warning('당근 주문수집 회차 보류: %s', type(exc).__name__)
        stop.wait(300)
