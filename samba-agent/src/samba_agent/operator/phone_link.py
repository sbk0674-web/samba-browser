"""식화 → 淘宝 상품 링크 따기 — 폰 AI 가 식화 앱에서 화이트리스트 가게 행으로 淘宝 상품에 넘어가 공유 링크를 복사해 읽어 온다.

사용자 2026-10-08: "식화에서 타오바오 넘어가서 공유링크 따면 되잖아". 淘宝 검색으로 상품을 찾으면 블랙리스트 가게를 고르게 되므로
링크는 반드시 식화의 판매처 행에서 넘어간 상품에서 딴다. 구매는 PC(샵백 경유)에서 이 링크로 한다(taobao_pc).

AI 는 결제 도구가 없다 — 보기·누르기·입력·붙여넣기만 한다. 알리페이 결제창이 앞에 있으면 조작이 막힌다(PhoneToolbox 와 같은 점검).
"""

import asyncio
import base64
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from samba_agent.operator.phone_buyer import PhoneToolbox, _log_actions
from samba_agent.ops.dewu_order import DewuOrderError
from samba_agent.ops.ssg_gift_accept import Phone
from samba_agent.repair.agent import DEFAULT_REPAIR_MODEL, _run_sync

log = logging.getLogger(__name__)

DEFAULT_MAX_TURNS = 100
DEFAULT_TIMEOUT_S = 600.0
# 淘宝 상품 링크로 인정하는 형태 — 단축 링크(m.tb.cn)·상품 주소(item.taobao.com·detail.tmall.com)
_LINK = re.compile(
    r'https?://(?:m\.tb\.cn/[\w./?=&%-]+|(?:item|detail|h5)\.(?:taobao|tmall)\.com/[\w./?=&%-]+|[\w.]*\.taobao\.com/[\w./?=&%-]*item[\w./?=&%-]*)',
    re.I,
)
NETWORK_MARKS = ('网络异常', '网络', '네트워크')


@dataclass
class LinkResult:
    url: str
    shop: str
    price_cny: float


class LinkToolbox:
    """링크 따기 도구 모음 — PhoneToolbox 의 조작 위에 보고 도구만 얹는다."""

    def __init__(self, phone: Phone, *, sleep: Callable[[float], None] = time.sleep) -> None:
        # 결제하지 않는 도구 상자 — approve 는 항상 거절한다
        self.tb = PhoneToolbox(
            phone, lambda krw: 'refused: link-only', max_cny=0, rate=0.0, sleep=sleep
        )
        self.result: LinkResult | None = None
        self.gave_up: str | None = None

    def report_link(self, url: str, shop: str, price_cny: float) -> str:
        found = _LINK.search(url or '')
        if not found:
            return '淘宝 상품 링크 형태가 아니다(m.tb.cn·item.taobao.com·detail.tmall.com) — 화면에서 다시 읽어라.'
        if not any(allowed in (shop or '') for allowed in ('后浪潮品奥莱折扣店', '品牌官方店')):
            return f'가게 "{shop}" 는 화이트리스트가 아니다 — 이 상품으로는 링크를 받지 않는다.'
        self.result = LinkResult(found.group(0), shop, float(price_cny or 0))
        return '기록했다. 끝내라.'

    def give_up(self, reason: str) -> str:
        self.gave_up = (reason or '').strip()[:300] or '사유 없음'
        return '기록했다. 끝내라.'


SYSTEM_PROMPT = """너는 SAMBA 하네스의 링크 담당이다. 한국어로 생각하고 도구만 쓴다. 임성희폰에서 식화(识货) 앱으로 淘宝 상품 링크를 딴다.
목표: 식화의 판매처 행(화이트리스트 가게 '后浪潮品奥莱折扣店' 또는 '品牌官方店', 플랫폼 淘宝/天猫)으로 淘宝 앱 상품 페이지에 넘어가
그 상품의 공유 링크를 복사해 읽는다. 결제·주문은 하지 않는다.
순서
1. launch 로 식화 앱(com.hupu.shihuo). 검색칸에 품번(영문·숫자)을 text 로 넣고 enter. 결과에서 같은 품번 상품(색상이 주어졌으면 같은 색)을 연다.
   '网络异常' 이면 '点击重试' 를 누르고 5~10초 기다린 뒤 screen 으로 다시 읽는다. 화면이 바뀌었는지 보고 누르고, 같은 좌표를 반복해 누르지 마라.
2. 주어진 EU 사이즈를 고른다. 판매처 목록(价格对比·최저가 판매처)에서 화이트리스트 가게 행을 찾는다. 그 행의 '购'/'去购买' 를 눌러 淘宝 앱으로 넘어간다.
   淘宝 검색창으로 상품을 찾는 것은 금지다.
3. 淘宝 상품 페이지에서 가게 이름이 화이트리스트인지 화면에서 읽어 확인한다. 아니면 뒤로 가서 다른 행을 고른다.
4. 상품 페이지 오른쪽 위 공유(分享) → '复制链接'(링크 복사). 복사한 링크를 읽으려면 淘宝 홈/검색의 입력칸을 눌러 paste 로 붙여 넣고 screen 으로 글자를 읽는다.
   읽은 뒤 clear_field 로 지우고 뒤로 나온다.
5. report_link(url, shop, price_cny) 로 끝낸다. 링크가 안 읽히면 give_up(reason).
의심스러우면 give_up. 좌표는 720x1600 기준이고 screen 의 글자 목록 좌표를 우선한다."""


class LinkFetcher:
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

    def fetch(self, box: LinkToolbox, ctx: str) -> LinkResult:
        """링크를 딴다. 못 따면 DewuOrderError(결제 전) — 식화 앱 네트워크 오류로만 포기하면 초기화 후 최대 3번 다시 한다."""
        for attempt in range(3):
            box.result = None
            box.gave_up = None
            box.tb.reset()
            _log_actions(box.tb)
            try:
                _run_sync(asyncio.wait_for(self._loop(box, ctx), timeout=self.timeout_s))
            except TimeoutError:
                box.gave_up = box.gave_up or '시간 초과'
            except Exception as e:  # noqa: BLE001 — SDK·CLI 오류 형식이 정해져 있지 않다
                box.gave_up = box.gave_up or f'링크 AI 오류: {type(e).__name__}: {str(e)[:120]}'
            if box.result is not None:
                return box.result
            transient = any(k in (box.gave_up or '') for k in NETWORK_MARKS)
            if not transient or attempt == 2:
                break
            log.info('링크 AI 네트워크 오류로 포기 — 다시(%d/3)', attempt + 1)
            box.tb.sleep(20)
        raise DewuOrderError(
            f'식화에서 淘宝 링크를 못 땄다(결제 전): {box.gave_up or "판단을 남기지 못함"}'
        )

    async def _loop(self, box: LinkToolbox, ctx: str) -> None:
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, tool
        from claude_agent_sdk import query as default_query

        tb = box.tb

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

        @tool('tap', '(x,y) 를 누른다. 720x1600 기준.', {'x': int, 'y': int})
        async def tap(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.tap, int(inp['x']), int(inp['y'])))

        @tool('swipe', 'direction=up|down', {'direction': str})
        async def swipe(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.swipe, str(inp.get('direction', ''))))

        @tool('key', 'name=back|home|enter', {'name': str})
        async def key(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.key, str(inp.get('name', ''))))

        @tool('type_text', '영문·숫자·하이픈만 입력(품번).', {'value': str})
        async def type_text(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.text, str(inp.get('value', ''))))

        @tool('paste', '클립보드를 선택된 입력칸에 붙여 넣는다.', {})
        async def paste(_inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.paste))

        @tool('clear_field', '선택된 입력칸의 글자를 모두 지운다.', {})
        async def clear_field(_inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.clear_field))

        @tool('launch', 'com.hupu.shihuo · com.taobao.taobao', {'package': str})
        async def launch(inp: dict[str, Any]) -> dict[str, Any]:
            return text(await asyncio.to_thread(tb.launch, str(inp.get('package', ''))))

        @tool(
            'report_link',
            '읽은 淘宝 링크를 보고하고 끝낸다. shop=화면에서 읽은 가게 이름, price_cny=상품 가격.',
            {'url': str, 'shop': str, 'price_cny': float},
        )
        async def report_link(inp: dict[str, Any]) -> dict[str, Any]:
            return text(
                box.report_link(
                    str(inp.get('url', '')),
                    str(inp.get('shop', '')),
                    float(inp.get('price_cny', 0) or 0),
                )
            )

        @tool(
            'give_up', '링크를 못 따겠다고 끝낸다. reason 은 화면에서 본 글자로.', {'reason': str}
        )
        async def give_up(inp: dict[str, Any]) -> dict[str, Any]:
            return text(box.give_up(str(inp.get('reason', ''))))

        names = (
            'screen', 'tap', 'swipe', 'key', 'type_text', 'paste', 'clear_field', 'launch',
            'report_link', 'give_up',
        )  # fmt: skip
        server = create_sdk_mcp_server(
            name='phonelink',
            version='1.0.0',
            tools=[
                screen,
                tap,
                swipe,
                key,
                type_text,
                paste,
                clear_field,
                launch,
                report_link,
                give_up,
            ],
        )
        options = ClaudeAgentOptions(
            tools=[],
            mcp_servers={'phonelink': server},
            allowed_tools=[f'mcp__phonelink__{n}' for n in names],
            permission_mode='bypassPermissions',
            system_prompt=SYSTEM_PROMPT,
            model=self.model,
            max_turns=self.max_turns,
        )
        query_fn = self._query_fn or default_query
        async for _message in query_fn(prompt=ctx, options=options):
            pass
