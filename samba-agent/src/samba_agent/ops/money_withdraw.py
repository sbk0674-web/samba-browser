"""무신사머니 잔액 알림이 나가면, 같은 계정의 무신사머니를 연결 계좌로 전액 인출한다.

사용자 2026-11-26: 알림이 뜬 경우 인출까지 실행. 모두 본인 계좌라 사고 위험 없음. 결제 진행 중인 창과 따로
별도 레인('money-withdraw')·별도 탭에서 독립으로 한다. 결제비밀번호는 앱의 fill_secret 이 키패드로 넣는다
(여기를 지나가지 않는다). 인출 가능 금액이 0원이면 누르지 않고 알리기만 한다.
SAMBA_MONEY_AUTO_WITHDRAW=1 일 때만 켜진다(money_alerts.observe 가 부른다).
"""

import json
import logging
import os
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path

from samba_agent.bridge.client import BridgeClient, BridgeError

log = logging.getLogger(__name__)
LANE = 'money-withdraw'
TOOLS = ('run_js', 'find_elements', 'fill_secret', 'close_tab', 'list_tabs', 'switch_tab', 'get_page')
_LOCK = threading.Lock()  # 한 번에 한 계정씩 — 같은 앱·같은 키패드

OPEN_JS = r'''
const PROFILE = __PROFILE__
const out = {}
const id = (String(await tabs.open({url:'https://www.musinsa.com/mypage',profile:PROFILE})).match(/tab (\S+)/)||[])[1]
if (!id) return JSON.stringify({ok:false,why:'탭 열기 실패'})
out.tab = id
await tabs.switch(id)
try { await page.waitFor('무신사머니',10000) } catch(e) {}
let tr = String((await page.get({})).tree||'')
const m = tr.match(/^\[(\d+)\] button "무신사머니[^"]*"/m)
if (!m) return JSON.stringify({ok:false,tab:id,why:'마이페이지에서 무신사머니 버튼 없음(로그인 확인 필요)'})
await page.click(parseInt(m[1]))
try { await page.waitFor('머니 인출',12000) } catch(e) {}
await page.clickText('머니 인출')
await sleep(5000)
const tx = String((await page.get({})).tree||'').split('PAGE TEXT:')[1] || ''
const av = tx.match(/인출 가능 금액\s*([\d,]+)\s*원/)
const bank = tx.match(/(\S+은행|\S+뱅크)\s*\((\d{3,4})\)/)
out.ok = !!av
out.available = av ? Number(av[1].replace(/,/g,'')) : null
out.account_tail = bank ? bank[2] : null
out.bank = bank ? bank[1] : null
if (!av) out.why = '인출 화면 아님'
return JSON.stringify(out)
'''

CLICK_JS = r'''
const tr = String((await page.get({interactive:1})).tree||'')
const idOf = n => { const x = tr.match(new RegExp('^\\[(\\d+)\\] button "'+n+'"','m')); return x ? parseInt(x[1]) : 0 }
const all = idOf('전액'), go = idOf('인출하기')
if (!all || !go) return JSON.stringify({ok:false,why:'전액/인출하기 버튼 없음'})
await page.click(all)
await sleep(1200)
const tx = String((await page.get({})).tree||'').split('PAGE TEXT:')[1] || ''
await page.click(go)
await sleep(2500)
return JSON.stringify({ok:true,before:tx.slice(0,200)})
'''

DONE_JS = r'''
await sleep(4000)
const tx = String((await page.get({})).tree||'').split('PAGE TEXT:')[1] || ''
return JSON.stringify({text:tx.slice(0,300), url:await page.url()})
'''


WINDOW = 'withdraw'  # 주문처리 창(기본 창)과 떼어 낸 별도 앱 창 — 거기 탭 정리가 닿지 않는다(docs/bridge.md 다중 창)


class _WindowBridge(BridgeClient):
    def _headers(self) -> dict[str, str]:
        return {**super()._headers(), 'X-Samba-Window': WINDOW}


def _bridge() -> BridgeClient:
    token = os.environ.get('SAMBA_BRIDGE_TOKEN', '')
    port = os.environ.get('SAMBA_BRIDGE_PORT', '47811')
    if not token:
        from dotenv import dotenv_values

        env = dotenv_values(Path(__file__).resolve().parents[3] / '.env')
        token = str(env.get('SAMBA_BRIDGE_TOKEN') or '')
        port = str(env.get('SAMBA_BRIDGE_PORT') or port)
    return _WindowBridge(
        f'http://127.0.0.1:{port}', token, allowed=TOOLS, lane=LANE, busy_retries=150, busy_wait_s=1.0
    )


def _json(raw: str) -> dict:
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except ValueError:
        m = re.search(r'\{.*\}', raw, re.S)
        try:
            return json.loads(m.group(0)) if m else {}
        except ValueError:
            return {}


def _json_list(raw: str) -> list[dict]:
    try:
        v = json.loads(raw)
        return [t for t in v if isinstance(t, dict)] if isinstance(v, list) else []
    except ValueError:
        return []


def withdraw_all(account: str, bridge: BridgeClient | None = None) -> str:
    """한 계정을 전액 인출하고 슬랙에 남길 한 줄 결과를 돌려준다. 예외는 문구로 바꾼다."""
    c = bridge or _bridge()
    tab = None
    try:
        r = _json(c.call('run_js', code=OPEN_JS.replace('__PROFILE__', json.dumps(account))).result)
        tab = r.get('tab')
        if not r.get('ok'):
            return f'⚠️ {account} 출금 못 함: {r.get("why") or "알 수 없음"}'
        avail = r.get('available') or 0
        dest = f'{r.get("bank") or "연결계좌"}({r.get("account_tail") or "?"})'
        if avail <= 0:
            return f'ℹ️ {account} 출금 안 함: 인출 가능 금액 0원 (연결계좌 {dest})'
        r2 = _json(c.call('run_js', code=CLICK_JS).result)
        if not r2.get('ok'):
            return f'⚠️ {account} 출금 못 함: {r2.get("why")}'
        # 비밀번호 키패드는 ePAY(niceepay) 팝업 창에 뜬다 — 그 창으로 옮겨 앱이 키패드를 누르게 한다
        popup = None
        for _ in range(20):
            tabs = _json_list(c.call('list_tabs').result)
            popup = next((t for t in tabs if t.get('kind') == 'popup' and t.get('openerId') == tab), None)
            if popup:
                break
            time.sleep(1)
        if not popup:
            return f'⚠️ {account} 출금 비밀번호 창이 안 뜸(사람 확인 필요)'
        c.call('switch_tab', id=popup['id'])
        time.sleep(2)
        found = c.call('find_elements', query='가상키패드').result
        m = re.search(r'\[(\d+)\]', found)
        out = c.call(
            'fill_secret',
            elementId=int(m.group(1)) if m else 0,
            itemType='password',
            provider='site',  # 무신사머니(사이트 자체 결제) 비밀번호
            accountLabel=account,
        ).result
        if out.lstrip().lower().startswith(('handoff', 'refused', 'ambiguous', 'account not found', 'error')):
            return f'⚠️ {account} 출금 비밀번호 입력 실패(사람 확인 필요): {out[:80]}'
        time.sleep(3)
        try:
            c.call('switch_tab', id=tab)
        except BridgeError:
            pass
        r3 = _json(c.call('run_js', code=DONE_JS).result)
        text = str(r3.get('text') or '')
        ok = bool(re.search(r'완료|인출이 (신청|접수)|성공', text))
        head = '✅' if ok else '❓'
        tail = '' if ok else ' (완료 문구 확인 못 함 — 이용내역 확인 필요)'
        return f'{head} {account} 무신사머니 {avail:,}원 → {dest} 인출{tail}'
    except BridgeError as e:
        return f'⚠️ {account} 출금 중단: {e}'
    except Exception as e:  # noqa: BLE001 — 출금 실패가 알림·결제를 막으면 안 된다
        log.warning('무신사머니 인출 실패: %s', type(e).__name__)
        return f'⚠️ {account} 출금 중단: {type(e).__name__}'
    finally:
        if tab:
            try:
                c.call('close_tab', id=tab)
            except Exception:  # noqa: BLE001
                pass


def withdraw_after_alert(account: str, send: Callable[[str], object]) -> None:
    with _LOCK:
        msg = withdraw_all(account)
    try:
        send(f'💸 무신사머니 출금 결과\n{msg}')
    except Exception as e:  # noqa: BLE001
        log.warning('무신사머니 인출 결과 전송 실패: %s', type(e).__name__)


def start_after_alert(account: str, send: Callable[[str], object]) -> None:
    if os.environ.get('SAMBA_MONEY_AUTO_WITHDRAW') != '1':
        return
    threading.Thread(
        target=withdraw_after_alert, args=(account, send), name='money-withdraw', daemon=True
    ).start()


_RUNNING: set[str] = set()
_LAST: dict[str, float] = {}
MIN_GAP_S = 120.0  # 같은 계정은 2분 안에 다시 확인하지 않는다(결제가 연달아 끝나도 한 번만)


def _check_and_withdraw(account: str, send: Callable[[str], object]) -> None:
    try:
        with _LOCK:
            msg = withdraw_all(account)
        # 0원이라 건너뛴 경우(ℹ️)는 조용히 — 출금했거나 문제가 있을 때만 슬랙에 남긴다
        if not msg.startswith('ℹ️'):
            try:
                send(f'💸 무신사머니 출금 결과\n{msg}')
            except Exception as e:  # noqa: BLE001
                log.warning('무신사머니 인출 결과 전송 실패: %s', type(e).__name__)
    finally:
        _RUNNING.discard(account)
        _LAST[account] = time.monotonic()


def start_after_payment(account: str, send: Callable[[str], object]) -> None:
    if os.environ.get('SAMBA_MONEY_AUTO_WITHDRAW') != '1':
        return
    if account in _RUNNING or time.monotonic() - _LAST.get(account, -1e9) < MIN_GAP_S:
        return
    _RUNNING.add(account)
    threading.Thread(
        target=_check_and_withdraw, args=(account, send), name='money-withdraw', daemon=True
    ).start()
