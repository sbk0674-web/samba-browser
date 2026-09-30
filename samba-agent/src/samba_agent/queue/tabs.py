"""작업이 남긴 브라우저 탭 정리.

실기: 앞 주문의 주문서 탭이 남아 있으면 다음 주문의 스냅샷 스크립트가 `tabs.list().find(url 에 /order/)`
로 **옛 주문서**를 집어 원가(66,400원)를 잘못 읽었다. 작업이 끝날 때마다 그 작업이 연 탭을 닫는다.
승인 대기(결제 직전)에 멈춘 작업은 주문서가 살아 있어야 하므로 닫지 않는다.
"""

import json
import logging
import os

from samba_agent.bridge.client import BridgeClient, BridgeError

log = logging.getLogger(__name__)

# 브릿지에 요구하는 도구 — 진입점이 이 목록으로 scoped() 한다
TAB_TOOLS = ('list_tabs', 'close_tab')
# 정리에서 남기는 탭 — 사람이 보는 화면(삼바웨이브 주문관리·네이버 홈·앱 새 탭)
KEEP_HOSTS = ('samba-wave', 'www.naver.com', 'nid.naver.com', 'localhost', 'about:blank')


def _env(key: str) -> str:
    """환경변수, 없으면 작업 폴더의 .env 에서 읽는다(설정 모델은 .env 를 환경변수로 올리지 않는다)."""
    if os.environ.get(key):
        return os.environ[key]
    try:
        with open('.env', encoding='utf-8') as f:
            for line in f:
                k, _, v = line.partition('=')
                if k.strip() == key:
                    return v.strip().strip('"')
    except OSError:
        pass
    return ''


class TabJanitor:
    """작업 시작 시 탭 목록을 찍어 두고, 끝나면 그 뒤에 생긴 탭만 닫는다."""

    def __init__(self, bridge: BridgeClient) -> None:
        self._bridge = bridge

    def _tabs(self) -> list[dict[str, object]]:
        try:
            raw = json.loads(self._bridge.call('list_tabs').result)
        except (BridgeError, ValueError) as e:
            log.warning('탭 목록을 읽지 못했다 — 정리를 건너뛴다: %s', e)
            return []
        return [t for t in raw if isinstance(t, dict)] if isinstance(raw, list) else []

    def snapshot(self) -> frozenset[str]:
        """지금 열린 탭·팝업 id."""
        return frozenset(str(t.get('id')) for t in self._tabs() if t.get('id'))

    def close_new(self, before: frozenset[str]) -> int:
        """``before`` 에 없던 탭을 닫는다. 닫은 개수를 돌려준다. 실패는 로그만."""
        closed = 0
        for t in self._tabs():
            tab_id = str(t.get('id') or '')
            if not tab_id or tab_id in before:
                continue
            # 다른 레인(사람의 수동 작업·계정 비교)이 연 탭은 그 레인이 닫는다 — 하네스가 닫으면 남의 주문서가
            # 사라진다(실기 2026-09-27 패션플러스·SMARKET 수동 진행 중 탭이 닫힘)
            if t.get('lane'):
                continue
            try:
                self._bridge.call('close_tab', id=tab_id)
                closed += 1
            except BridgeError as e:
                log.warning('탭을 닫지 못했다(%s): %s', tab_id, e)
        return closed

    def close_leftovers(self, keep_hosts: tuple[str, ...] = KEEP_HOSTS) -> int:
        """남아 있는 작업 탭을 전부 닫는다(남길 호스트 제외). 닫은 개수를 돌려준다.

        하네스가 죽거나 작업이 시간 초과로 끝나면 계정 비교 탭이 남는다 — 실기 2026-09-28: ABC·무신사 탭이
        30개 쌓여 메모리를 먹고 페이지 호출이 전부 늦어졌다. 작업이 없을 때(기동 직후·작업 시작 직전)만 부른다.
        """
        # 수동 작업 중인 사이트는 SAMBA_KEEP_TAB_HOSTS(쉼표 구분)로 남긴다 — 목록에 레인 정보가 없어 사람·다른 세션의
        # 탭을 구분할 수 없다(실기 2026-09-29: 수동으로 보던 SSG 탭이 닫혔다)
        extra = tuple(h.strip() for h in _env('SAMBA_KEEP_TAB_HOSTS').split(',') if h.strip())
        keep_hosts = keep_hosts + extra
        closed = 0
        for t in self._tabs():
            tab_id = str(t.get('id') or '')
            url = str(t.get('url') or '')
            if not tab_id or any(h in url for h in keep_hosts):
                continue
            # 다른 레인(사람·다른 세션의 수동 작업)이 연 탭은 건드리지 않는다 — close_new 와 같은 규칙
            # (실기 2026-09-30: 새 작업 시작 때 수동 재현 중이던 주문서 탭이 닫혀 결과를 못 봤다)
            if t.get('lane'):
                continue
            try:
                self._bridge.call('close_tab', id=tab_id)
                closed += 1
            except BridgeError as e:
                log.warning('탭을 닫지 못했다(%s): %s', tab_id, e)
        return closed
