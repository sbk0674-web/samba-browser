"""이미 결제된 SSG 선물 화면만 복구한다. 구매·결제·배송지 변경 도구는 제공하지 않는다."""

import asyncio
import base64
import io
import logging
import subprocess
import time

from samba_agent.ops.evidence import is_secret_stage
from samba_agent.ops.ssg_gift_accept import (
    ACCEPT,
    CHECK_BTN,
    CONSENT,
    DONE,
    DOOR,
    KAKAO,
    SSG_APP,
    GiftAcceptError,
    Phone,
    _close_browser,
    adb_server_args,
    same_product,
)
from samba_agent.ops.ssg_gift_search import gift_overlay

log = logging.getLogger(__name__)


class GiftRepairTools:
    def __init__(self, phone: Phone, sku: str, model_code: str) -> None:
        self.phone = phone
        self.sku = sku
        self.model_code = model_code
        self.door_selected = False

    def read(self):
        if self.phone.top_package() not in (KAKAO, SSG_APP):
            raise GiftAcceptError('폰이 다른 앱으로 전환됨 — AI 수락 복구 중단')
        nodes = self.phone.nodes()
        texts = [node.text + ' ' + node.desc for node in nodes]
        if any(is_secret_stage(text) for text in texts):
            raise GiftAcceptError('비밀번호 화면 — AI 수락 복구 중단')
        if not (self.model_code or self.sku) or not same_product(self.model_code, self.sku, texts):
            raise GiftAcceptError('대상 상품이 현재 선물 화면에 없음 — AI 수락 복구 중단')
        return nodes

    def completed(self) -> bool:
        try:
            nodes = self.read()
            return any(DONE in node.text for node in nodes) and (
                not self.door_selected or any(DOOR in node.text for node in nodes)
            )
        except GiftAcceptError:
            return False

    def act(self, action: str, x: int, y: int) -> str:
        nodes = self.read()
        if not (0 < x < 720 and 50 < y < 1510):
            raise GiftAcceptError('수락 화면 밖 좌표')
        labels = {'check': CHECK_BTN, 'door': DOOR, 'consent': CONSENT, 'accept': ACCEPT}
        if action == 'close_overlay':
            if not gift_overlay(nodes):
                raise GiftAcceptError('닫을 광고 팝업이 확인되지 않음')
        elif action in labels:
            label = labels[action]
            hits = [node for node in nodes if label in node.text and node.y > 0]
            if action == 'accept':
                hits = [node for node in hits if node.text.strip() == ACCEPT]
                if not self.door_selected:
                    raise GiftAcceptError('문앞 배송 요청 선택 전 수락 금지')
            if not any(abs(node.x - x) <= 120 and abs(node.y - y) <= 80 for node in hits):
                raise GiftAcceptError('확인된 선물 버튼과 좌표가 다름')
            if gift_overlay(nodes):
                raise GiftAcceptError('광고 팝업을 먼저 닫아야 함')
        else:
            raise GiftAcceptError('허용되지 않은 수락 동작')
        self.phone.tap(x, y)
        if action == 'door':
            self.door_selected = True
        time.sleep(2)
        return '화면을 다시 확인하세요'

    def screenshot(self) -> str:
        from PIL import Image

        self.read()
        result = subprocess.run(
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
            timeout=20,
            check=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        output = io.BytesIO()
        Image.open(io.BytesIO(result.stdout)).convert('RGB').save(output, format='JPEG', quality=55)
        return base64.b64encode(output.getvalue()).decode()


class GiftScreenRepairer:
    def __init__(self, *, model: str, timeout_s: float = 180, query_fn=None) -> None:
        self.model = model
        self.timeout_s = timeout_s
        self.query_fn = query_fn

    def __call__(self, phone: Phone, *, sku: str, model_code: str, problem: str) -> str | None:
        from claude_agent_sdk import ClaudeSDKError

        from samba_agent.repair.agent import _run_sync

        tools = GiftRepairTools(phone, sku, model_code)
        try:
            tools.read()
            _run_sync(asyncio.wait_for(self._loop(tools, problem), self.timeout_s))
            if tools.completed():
                _close_browser(phone, time.sleep)
                return '선물 받기 완료(AI 화면 복구·상품 대조)'
        except (
            GiftAcceptError,
            ClaudeSDKError,
            OSError,
            TimeoutError,
            RuntimeError,
            ValueError,
        ) as exc:
            log.warning('SSG 선물 AI 복구 미완료: %s', type(exc).__name__)
        return None

    async def _loop(self, toolbox: GiftRepairTools, problem: str) -> None:
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool

        from samba_agent.llm.auth import with_fallback

        @tool('screen', '현재 대상 선물 화면의 글자와 사진을 읽는다.', {})
        async def screen(_inputs):
            nodes = await asyncio.to_thread(toolbox.read)
            body = '\n'.join(f'{node.text} {node.desc} ({node.x},{node.y})' for node in nodes)
            picture = await asyncio.to_thread(toolbox.screenshot)
            return {
                'content': [
                    {'type': 'text', 'text': body[:9000]},
                    {'type': 'image', 'data': picture, 'mimeType': 'image/jpeg'},
                ]
            }

        @tool(
            'act',
            '사진에서 보이는 선물 버튼만 누른다. action=close_overlay|check|door|consent|accept.',
            {'action': str, 'x': int, 'y': int},
        )
        async def act(inputs):
            try:
                result = await asyncio.to_thread(
                    toolbox.act, inputs['action'], inputs['x'], inputs['y']
                )
            except GiftAcceptError as exc:
                result = str(exc)
            return {'content': [{'type': 'text', 'text': result}]}

        server = create_sdk_mcp_server(name='giftrepair', version='1.0.0', tools=[screen, act])
        options = ClaudeAgentOptions(
            tools=[],
            mcp_servers={'giftrepair': server},
            allowed_tools=['mcp__giftrepair__screen', 'mcp__giftrepair__act'],
            permission_mode='bypassPermissions',
            model=self.model,
            max_turns=16,
            system_prompt=(
                '이미 결제된 해당 SSG 선물만 수락한다. 매 동작 전 screen 사진을 보고 실제 보이는 버튼 좌표를 고른다. '
                '접근성 목록에는 뒤에 가려진 홈·선물 화면이 함께 나온다. 광고 X를 먼저 닫는다. '
                '옵션/배송지 확인→문앞 요청→필요한 개인정보 동의→선물 받기 순서로 한다. '
                '배송지·옵션 변경, 결제, 구매, 거절, 다른 주문 접근 금지. 완료 화면과 같은 상품 확인 뒤 종료한다. '
                '막히면 추측으로 누르지 말고 종료한다. 답변에 이름·주소·전화번호를 쓰지 않는다.'
            ),
        )
        query_fn = self.query_fn or with_fallback(query)
        async for _message in query_fn(
            prompt=f'선물 수락 화면 복구. 사유: {problem[:300]}', options=options
        ):
            pass
