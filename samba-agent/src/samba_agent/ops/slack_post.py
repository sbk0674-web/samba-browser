"""정해 둔 슬랙 채널(이름 또는 id)에 최상위 글을 올린다 — 하네스 주문 채널과 다른 채널로 보낼 알림용.

무신사머니 잔액 알림이 쓴다(사용자 2026-11-25: 문자 대신 #daily_brief). 채널 id 는 처음 보낼 때 한 번 풀어 둔다.
슬랙 오류는 삼켜 False 를 돌려준다 — 알림이 실패해도 결제 흐름은 멈추지 않고, 부르는 쪽이 다음 기회에 다시 보낸다.
"""

import logging
import re
from typing import Any

from samba_agent.ops.masking import mask_text

log = logging.getLogger(__name__)
_CHANNEL_ID_RE = re.compile(r'^[CG][A-Z0-9]{8,}$')


class SlackChannelPoster:
    def __init__(self, app: Any, channel: str) -> None:
        self.app = app
        self.channel = channel.lstrip('#')
        self._channel_id: str | None = self.channel if _CHANNEL_ID_RE.match(self.channel) else None

    def _resolve(self) -> str | None:
        if self._channel_id is not None:
            return self._channel_id
        # 공개 채널부터 찾는다 — 앱에 비공개 채널 읽기 권한(groups:read)이 없어도 공개 채널은 찾아야 한다
        for kind in ('public_channel', 'private_channel'):
            cursor: str | None = None
            try:
                while True:
                    resp = self.app.client.conversations_list(types=kind, cursor=cursor, limit=200)
                    for ch in resp.get('channels', []):
                        if ch.get('name') == self.channel:
                            self._channel_id = str(ch['id'])
                            return self._channel_id
                    cursor = (resp.get('response_metadata') or {}).get('next_cursor')
                    if not cursor:
                        break
            except Exception as exc:  # noqa: BLE001 — 권한이 없는 종류는 건너뛴다
                log.info('채널 목록 조회 건너뜀(%s): %s', kind, type(exc).__name__)
        log.warning('알림 채널을 찾지 못했다: %s', self.channel)
        return None

    def post(self, text: str) -> bool:
        """글을 올렸으면 True. 채널을 못 찾았거나 슬랙 오류면 False."""
        try:
            channel_id = self._resolve()
            if channel_id is None:
                return False
            try:
                self.app.client.chat_postMessage(channel=channel_id, text=mask_text(text))
            except Exception as exc:  # noqa: BLE001 — 봇이 채널에 없으면 한 번 들어가 본다
                if 'not_in_channel' not in str(exc):
                    raise
                self.app.client.conversations_join(channel=channel_id)
                self.app.client.chat_postMessage(channel=channel_id, text=mask_text(text))
            return True
        except Exception as exc:  # noqa: BLE001 — 알림 실패가 결제를 멈추게 하면 안 된다
            log.warning('슬랙 알림 전송 실패(%s): %s', self.channel, type(exc).__name__)
            return False
