"""폰 구매 AI — 식화 최저가 판매처(淘宝 화이트리스트 가게 등)를 식화 앱 링크로 들어가 AI 가 폰을 조작해 산다.

사용자 2026-10-08: "발주미입력 사람이 정할 걸 AI 가 붙어서 하는 거라고 몇 번을 말해". 득물 외 판매처는 고정 스크립트가 없다 —
식화 앱에서 상품 → 판매처 목록 → 화이트리스트 가게 행 → 淘宝 앱으로 넘어가 사이즈·결제. 화면은 매번 조금씩 달라 AI 가 보고 누른다.

안전(코드 수준, AI 가 어길 수 없다)
- 돈이 나가는 길은 pay 도구 하나다. 알리페이 결제창이 앞에 있고, 결제창 주문금액을 읽을 수 있고, 그 금액이 상한(max_cny)과
  AI 가 말한 가격 이하이고, 가게 이름이 화이트리스트일 때만 앱의 phone_approve_payment 를 부른다.
- 알리페이 창이 앞에 있을 때는 AI 가 누르기·입력·뒤로가기를 못 한다(비밀번호·결제 버튼 접근 차단).
- 淘宝 검색창으로 상품을 찾는 것은 프롬프트로 금지한다(블랙리스트 가게를 고르게 된다) — 반드시 식화 링크로 들어간다.
- 결제됐는데 주문번호를 못 남기면 paid=True 로 사람에게 넘긴다(재결제 금지).
"""

import asyncio
import base64
import io
import logging
import re
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from samba_agent.ops.dewu_order import ALIPAY, DewuOrderError, DewuResult, alipay_order_amount
from samba_agent.ops.ssg_gift_accept import Phone, adb_server_args
from samba_agent.repair.agent import DEFAULT_REPAIR_MODEL, _run_sync

log = logging.getLogger(__name__)

# 식화 화이트리스트 가게 — kream_shadow._SUP_ALLOW_NAMES 와 같은 이름. 唯品会·得物 은 플랫폼 단위 화이트리스트다
ALLOWED_SHOPS = ('后浪潮品奥莱折扣店', '品牌官方店')
MAX_ACTIONS = 160
NETWORK_RETRIES = 3
NETWORK_MARKS = ('网络异常', '网络', '네트워크')
DEFAULT_MAX_TURNS = 120
DEFAULT_TIMEOUT_S = 900.0
_ORDER_NO = re.compile(r'^\d{12,25}$')


def _shrink(png: bytes) -> bytes:
    """스크린샷을 JPEG 로 줄인다 — PNG(1MB↑)는 SDK 메시지 버퍼 한도(1MB)를 넘는다. 해상도는 그대로(좌표 유지)."""
    if not png:
        return png
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(png)).convert('RGB')
        out = io.BytesIO()
        img.save(out, format='JPEG', quality=55, optimize=True)
        return out.getvalue()
    except Exception:  # noqa: BLE001 — 줄이지 못하면 이미지 없이 글자 목록만 준다
        log.warning('스크린샷 JPEG 변환 실패')
        return b''


def alipay_window_front(phone: Phone) -> bool:
    """알리페이 결제창이 앞에 있나. 得物·식화는 알리페이 앱이 뜨고, 淘宝는 淘宝 앱 안에 결제창이 뜬다(실기 2026-10-08)."""
    if phone.top_package() == ALIPAY:
        return True
    nodes = phone.nodes()
    if alipay_order_amount(nodes) is None:
        return False
    texts = ' '.join((n.text or n.desc or '') for n in nodes)
    return any(k in texts for k in ('密码共', '国际卡手续费', '手续费'))


@dataclass
class BuyState:
    paid: bool = False
    uncertain: bool = False
    paid_cny: float = 0.0
    item_cny: float = 0.0
    order_no: str | None = None
    gave_up: str | None = None
    actions: int = 0
    notes: list[str] = field(default_factory=list)


class PhoneToolbox:
    """AI 에게 주는 폰 도구 모음 — 안전 점검이 여기에 있다(SDK 와 분리해 시험할 수 있다)."""

    def __init__(
        self,
        phone: Phone,
        approve: Callable[[int], str],
        *,
        max_cny: float,
        rate: float,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.phone = phone
        self.approve = approve
        self.max_cny = max_cny
        self.rate = rate
        self.sleep = sleep
        self.state = BuyState()

    # --- 읽기 ---
    def screen_text(self) -> str:
        nodes = self.phone.nodes()
        lines = [f'앞 앱: {self.phone.top_package()}']
        for n in nodes:
            t = (n.text or n.desc or '').strip()
            if t:
                lines.append(f'{n.x},{n.y} {t[:60]}')
        return '\n'.join(lines[:120])

    def screenshot(self) -> bytes:
        done = subprocess.run(
            [
                self.phone.adb,
                *adb_server_args(),
                '-s',
                self.phone.serial,
                'exec-out',
                'screencap',
                '-p',
            ],
            capture_output=True,
            timeout=30,
            check=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        return _shrink(done.stdout)

    def reset(self) -> None:
        """시작 전 초기화 — 淘宝·식화 앱을 끄고 홈으로. 지난 시도가 남긴 결제창에 갇히지 않게 한다(미결제 주문은 그대로 남는다)."""
        for package in ('com.taobao.taobao', 'com.hupu.shihuo'):
            self.phone._run('shell', 'am', 'force-stop', package)
        self.phone.key('3')
        self.sleep(1.5)

    # --- 조작(알리페이 창이 앞이면 막힌다) ---
    def _guard(self) -> str | None:
        self.state.actions += 1
        if self.state.actions > MAX_ACTIONS:
            return f'조작 {MAX_ACTIONS}회를 넘었다 — give_up 으로 끝내라.'
        if self.state.paid:
            return '이미 결제했다 — finish 로 주문번호를 남겨라.'
        if alipay_window_front(self.phone):
            return '알리페이 결제창이 앞에 있다 — 누르기·입력은 막혀 있다. 금액·가게를 확인했으면 pay 를 불러라.'
        return None

    def tap(self, x: int, y: int) -> str:
        blocked = self._guard()
        if blocked:
            return blocked
        self.phone.tap(int(x), int(y))
        self.sleep(1.5)
        return '눌렀다'

    def swipe(self, direction: str) -> str:
        blocked = self._guard()
        if blocked:
            return blocked
        if direction == 'up':
            self.phone.swipe_up()
        elif direction == 'down':
            self.phone.swipe_down()
        else:
            return 'direction 은 up 또는 down'
        self.sleep(1.2)
        return '넘겼다'

    def key(self, name: str) -> str:
        blocked = self._guard()
        if blocked and not (name == 'back' and alipay_window_front(self.phone)):
            return blocked
        code = {'back': '4', 'home': '3', 'enter': '66'}.get(name)
        if code is None:
            return 'name 은 back·home·enter 중 하나'
        self.phone.key(code)
        self.sleep(1.5)
        return '눌렀다'

    def text(self, value: str) -> str:
        blocked = self._guard()
        if blocked:
            return blocked
        clean = re.sub(r'[^A-Za-z0-9-]', '', value)
        if not clean:
            return '영문·숫자·하이픈만 칠 수 있다(품번 검색용)'
        self.phone.input_text(clean)
        self.sleep(1)
        return f'{clean} 입력'

    def launch(self, package: str) -> str:
        blocked = self._guard()
        if blocked:
            return blocked
        if package not in ('com.hupu.shihuo', 'com.taobao.taobao', 'com.achievo.vipshop'):
            return '식화·淘宝·唯品会 앱만 연다'
        self.phone.launch(package)
        self.sleep(5)
        return f'{package} 실행'

    # --- 돈이 나가는 유일한 길 ---
    def pay(self, shop: str, price_cny: float) -> str:
        if self.state.paid:
            return '이미 결제했다 — finish 로 주문번호를 남겨라.'
        if not any(allowed in (shop or '') for allowed in ALLOWED_SHOPS):
            return f'가게 "{shop}" 는 화이트리스트({" · ".join(ALLOWED_SHOPS)})가 아니다 — 결제하지 않는다.'
        if not alipay_window_front(self.phone):
            return (
                '알리페이 결제창이 앞에 없다 — 주문 확인 화면에서 立即支付 로 결제창을 먼저 띄워라.'
            )
        charge = alipay_order_amount(self.phone.nodes())
        if charge is None:
            return '결제창의 주문금액을 못 읽었다 — 결제하지 않는다. 화면을 다시 읽어라.'
        if charge > self.max_cny:
            return f'결제창 금액 ¥{charge:g} 이 상한 ¥{self.max_cny:.0f} 을 넘는다(마진) — 결제하지 않는다. give_up 하라.'
        if price_cny <= 0 or charge > price_cny * 1.02 + 1:
            return f'결제창 금액 ¥{charge:g} 이 네가 본 가격 ¥{price_cny:g} 과 다르다 — 결제하지 않는다. 화면을 다시 확인하라.'
        out = self.approve(round(charge * 1.03 * self.rate)).strip()
        if not out.startswith('ok'):
            # 앱의 승인 응답이 실패여도 결제됐을 수 있다 — 화면에 支付成功 이 뜨는지 본다(최대 ~10초)
            succeeded = False
            for _ in range(5):
                shown = ' '.join((n.text or n.desc or '') for n in self.phone.nodes())
                if '支付成功' in shown:
                    succeeded = True
                    break
                self.sleep(2)
            if not succeeded:
                self.state.uncertain = True
                return f'결제 승인 응답: {out[:80]} — 결제됐는지 알 수 없다. 화면과 주문내역을 확인하라(재결제 금지).'
        self.state.paid = True
        self.state.item_cny = float(price_cny)
        self.state.paid_cny = charge
        return f'결제 승인 완료(¥{charge:g}). 이제 淘宝/앱 주문내역에서 주문번호를 읽어 finish 를 불러라.'

    def finish(self, order_no: str) -> str:
        if not self.state.paid:
            return '결제하지 않았다 — finish 는 결제 뒤에만.'
        digits = re.sub(r'\D', '', order_no or '')
        if not _ORDER_NO.match(digits):
            return '주문번호는 숫자 12~25자리다 — 주문 상세의 订单编号 를 다시 읽어라.'
        self.state.order_no = digits
        return '기록했다. 끝내라.'

    def give_up(self, reason: str) -> str:
        if self.state.paid:
            return '이미 결제했다 — give_up 이 아니라 finish.'
        self.state.gave_up = (reason or '').strip()[:300] or '사유 없음'
        return '기록했다. 끝내라.'


SYSTEM_PROMPT = """너는 SAMBA 주문 하네스의 폰 구매 담당이다. 한국어로 생각하고 도구만 쓴다.
식화(识货) 대상 주문을 임성희폰에서 산다. 식화 앱의 판매처 목록(价格对比·供应商)에서 **화이트리스트 가게 중 최저가**로 산다.
화이트리스트 가게: 淘宝/天猫의 '后浪潮品奥莱折扣店', '品牌官方店' · 唯品会 · 得物. 그 밖의 가게는 블랙리스트다 — 절대 사지 않는다.

순서
1. launch 로 식화 앱(com.hupu.shihuo)을 연다. 검색창에 품번(영문·숫자)을 text 로 입력하고 enter. 결과에서 같은 품번 상품을 연다.
2. 상품 화면에서 판매처 목록(价格对比 등)을 연다. 사이즈(EU)를 고르면 판매처별 가격이 보인다. 화이트리스트 가게 중 가장 싼 곳을 고른다.
3. 그 판매처 행의 '去购买/去淘宝' 같은 링크를 눌러 淘宝(또는 唯品会) 앱으로 넘어간다. **淘宝 앱 검색창에서 상품을 검색하는 것은 금지다.** 식화 링크로만 들어간다.
4. 넘어간 상품 페이지에 가게 이름이 화이트리스트인지 화면에서 읽어 확인한다. 아니면 뒤로 가서 다른 행을 고른다.
5. 색상(품번)·사이즈를 고르고 立即支付/立即购买 → 주문 확인 화면. 배송지가 HUBNET 배대지인지, 합계 ¥ 가 상한 이하인지 확인한다.
   결제수단은 支付宝(알리페이, 大陆版). '개인정보 국경 간 전송 동의' 체크칸이 있으면 체크한다. 立即支付 로 알리페이 결제창을 띄운다.
6. 알리페이 결제창(淘宝는 淘宝 앱 안에 '订单金额·国际卡手续费·密码共6位' 창이 뜬다)이 뜨면 pay(shop, price_cny) 를 부른다.
   '待付款'(미결제) 주문이 이미 남아 있으면 새로 만들지 말고 그 주문의 '去支付' 로 결제한다. 결제창이 뜬 뒤에는 누르지 말고 pay 만 부른다 — shop 은 화면에서 읽은 가게 이름, price_cny 는 상품 가격(수수료 제외).
   코드가 결제창 금액·상한을 다시 확인하고 비밀번호를 넣는다. 결제 뒤 주문 내역(我的·待发货)에서 订单编号 를 읽어 finish(order_no).
7. 최저가 판매처에서 못 사면(품절·가게 없음·상한 초과) 다음으로 싼 화이트리스트 판매처로 넘어간다. 마진이 남는 가격(상한 이하)일 때만 산다.
   더 갈 곳이 없으면 give_up(reason) — 이유를 화면에서 본 글자로 적는다.
screen 으로 화면을 읽고(글자 목록 + 이미지) 누른다. 좌표는 720x1600 화면 기준이다. 의심스러우면 give_up. 결제 비밀번호는 네가 다루지 않는다."""


def _log_actions(tb: PhoneToolbox) -> None:
    """AI 가 부른 폰 도구를 로그에 남긴다(감시용) — 입력값은 좌표·품번·가게 이름뿐이라 비밀이 없다."""
    if getattr(tb, '_logged', False):
        return
    tb._logged = True  # type: ignore[attr-defined]
    for name in ('tap', 'swipe', 'key', 'text', 'launch', 'pay', 'finish', 'give_up'):
        original = getattr(tb, name)

        def wrapped(*args: Any, _orig: Any = original, _name: str = name) -> Any:
            out = _orig(*args)
            log.info('폰 AI %s%s → %s', _name, args, str(out)[:160])
            return out

        setattr(tb, name, wrapped)


class PhoneBuyer:
    """식화 링크 경로로 폰을 조작해 사는 AI. 결제는 pay 도구(코드 점검)로만 나간다."""

    def __init__(
        self,
        *,
        model: str = DEFAULT_REPAIR_MODEL,
        max_turns: int = DEFAULT_MAX_TURNS,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        query_fn: Any = None,
    ) -> None:
        self.model = model
        self.max_turns = max_turns
        self.timeout_s = timeout_s
        self._query_fn = query_fn

    def buy(self, toolbox: PhoneToolbox, ctx: str) -> DewuResult:
        """일시적인 네트워크 오류(식화 앱 网络异常)로만 포기했으면 폰을 초기화하고 최대 3번까지 다시 한다. 결제 뒤엔 다시 하지 않는다."""
        for attempt in range(NETWORK_RETRIES):
            try:
                return self._buy_once(toolbox, ctx)
            except DewuOrderError as e:
                transient = (not e.paid) and any(k in str(e) for k in NETWORK_MARKS)
                if not transient or attempt == NETWORK_RETRIES - 1:
                    raise
                log.info(
                    '폰 구매 AI 네트워크 오류로 포기 — 초기화 후 다시(%d/%d)',
                    attempt + 1,
                    NETWORK_RETRIES,
                )
                toolbox.state.gave_up = None
                toolbox.state.notes.clear()
                toolbox.state.actions = 0
                toolbox.sleep(20)
        raise DewuOrderError('폰 구매 AI 재시도 소진')  # 도달하지 않는다

    def _buy_once(self, toolbox: PhoneToolbox, ctx: str) -> DewuResult:
        """산다. 못 사면 DewuOrderError(결제 전), 결제됐는데 주문번호가 없으면 paid=True 로 던진다."""
        state = toolbox.state
        toolbox.reset()
        _log_actions(toolbox)
        try:
            _run_sync(asyncio.wait_for(self._loop(toolbox, ctx), timeout=self.timeout_s))
        except TimeoutError:
            state.notes.append('시간 초과')
        except Exception as e:  # noqa: BLE001 — SDK·CLI 오류 형식이 정해져 있지 않다
            state.notes.append(f'폰 구매 AI 오류: {type(e).__name__}: {str(e)[:120]}')
        if state.uncertain and not state.paid:
            raise DewuOrderError(
                f'결제 승인 응답이 실패였고 화면으로도 확인 못 했다 — 淘宝 주문내역 확인(재결제 금지): {state.gave_up or ""}'.strip(),
                paid=True,
            )
        if state.paid:
            if state.order_no is None:
                raise DewuOrderError(
                    f'결제는 됐는데(¥{state.paid_cny:g}) 주문번호를 못 남겼다 — 주문내역 확인(재결제 금지)',
                    paid=True,
                )
            return DewuResult(
                order_no=state.order_no,
                paid_cny=state.paid_cny,
                item_cny=state.item_cny,
                rate=toolbox.rate,
            )
        raise DewuOrderError(
            f'폰 구매 AI 가 못 샀다(결제 전): {state.gave_up or "; ".join(state.notes) or "판단을 남기지 못함"}'
        )

    async def _loop(self, tb: PhoneToolbox, ctx: str) -> None:
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, tool
        from claude_agent_sdk import query as default_query

        def text(body: str) -> dict[str, Any]:
            return {'content': [{'type': 'text', 'text': body[:6000]}]}

        @tool('screen', '지금 폰 화면을 글자 목록(좌표 포함)과 이미지로 읽는다.', {})
        async def screen(_inp: dict[str, Any]) -> dict[str, Any]:
            body = await asyncio.to_thread(tb.screen_text)
            png = await asyncio.to_thread(tb.screenshot)
            blocks: list[dict[str, Any]] = [{'type': 'text', 'text': body[:6000]}]
            if png:
                blocks.append(
                    {
                        'type': 'image',
                        'data': base64.b64encode(png).decode(),
                        'mimeType': 'image/jpeg',
                    }
                )
            return {'content': blocks}

        @tool('tap', '화면의 (x,y) 를 누른다. 720x1600 기준.', {'x': int, 'y': int})
        async def tap(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.tap, int(inp['x']), int(inp['y'])))

        @tool('swipe', '위/아래로 넘긴다. direction=up|down', {'direction': str})
        async def swipe(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.swipe, str(inp.get('direction', ''))))

        @tool('key', 'name=back|home|enter', {'name': str})
        async def key(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.key, str(inp.get('name', ''))))

        @tool('type_text', '영문·숫자·하이픈만 입력(품번 검색).', {'value': str})
        async def type_text(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.text, str(inp.get('value', ''))))

        @tool(
            'launch',
            '앱 실행: com.hupu.shihuo · com.taobao.taobao · com.achievo.vipshop',
            {'package': str},
        )
        async def launch(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.launch, str(inp.get('package', ''))))

        @tool(
            'pay',
            '알리페이 결제창이 앞에 있을 때 결제한다. shop=화면에서 읽은 가게 이름, price_cny=상품 가격(위안). 코드가 점검한다.',
            {'shop': str, 'price_cny': float},
        )
        async def pay(inp: dict[str, Any]) -> dict[str, Any]:
            return text(
                await asyncio.to_thread(
                    tb.pay, str(inp.get('shop', '')), float(inp.get('price_cny', 0) or 0)
                )
            )

        @tool('finish', '결제 뒤 주문 상세의 订单编号(숫자)를 남기고 끝낸다.', {'order_no': str})
        async def finish(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.finish, str(inp.get('order_no', ''))))

        @tool(
            'give_up', '살 수 없다고 판단해 끝낸다. reason 은 화면에서 본 글자로.', {'reason': str}
        )
        async def give_up(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.give_up, str(inp.get('reason', ''))))

        tools = [screen, tap, swipe, key, type_text, launch, pay, finish, give_up]
        server = create_sdk_mcp_server(name='phonebuyer', version='1.0.0', tools=tools)
        options = ClaudeAgentOptions(
            tools=[],
            mcp_servers={'phonebuyer': server},
            allowed_tools=[
                f'mcp__phonebuyer__{t}'
                for t in (
                    'screen',
                    'tap',
                    'swipe',
                    'key',
                    'type_text',
                    'launch',
                    'pay',
                    'finish',
                    'give_up',
                )
            ],
            permission_mode='bypassPermissions',
            system_prompt=SYSTEM_PROMPT,
            model=self.model,
            max_turns=self.max_turns,
        )
        query_fn = self._query_fn or default_query
        async for _message in query_fn(prompt=ctx, options=options):
            pass
