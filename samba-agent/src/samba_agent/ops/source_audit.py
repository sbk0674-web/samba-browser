"""소싱처 주문 대조 — 소싱처 주문 내역·주문 상세를 삼바웨이브 기록과 견준다(교차 검증이 부른다, 읽기 전용).

[2026-10-02 사고]
- 중복 구매: 무신사페이가 비밀번호 없이 결제됐는데 하네스가 '결제 안 됨'으로 끝냈고, 그 주문이 다시 돌며 한 번 더
  결제됐다(9/29 탑텐키즈·9/30 크록스키즈). 삼바웨이브에는 소싱주문번호가 하나만 남아, 물건이 두 번 올 때까지 몰랐다.
- 배송지: 직배로 기록된 롯데온 주문이 사무실(기본 배송지)로 갔다 — 주문서 되읽기가 이름만 봤다.

여기서 찾는 것
- 삼바에 기록이 없는 소싱 주문: 소싱처 주문 내역에는 있는데 어느 판매 주문의 소싱주문번호로도 적혀 있지 않다.
  취소된 주문·상품권은 뺀다. 출고 전이어야 취소할 수 있으니 빨리 알리는 게 목적이다.
- 받는 곳이 기록과 다른 주문: 직배인데 사무실로 가거나, 까대기인데 사무실이 아닌 곳으로 간다.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

_log = logging.getLogger(__name__)

_KST = timezone(timedelta(hours=9))
# 무신사 주문번호 앞 14자리가 결제 시각(KST)이다 — 202609301104250002 → 2026-09-30 11:04:25
_MUSINSA_NO = re.compile(r'^(20\d{12})\d{4}$')
# 기입이 끝나기 전의 주문을 '기록 없음'으로 알리지 않게 기다리는 시간
SETTLE = timedelta(minutes=10)
# 이보다 오래된 주문은 보지 않는다(처음 켰을 때 옛 주문을 한꺼번에 알리지 않게)
LOOKBACK = timedelta(hours=48)
# 삼바에 기록하지 않는 구매 — 주문 상세의 상품 글에 이 낱말이 있으면 넘긴다
NOT_STOCK_WORDS = ('상품권',)
# 끝난 주문 — 다시 살 것도 취소할 것도 없다
_VOID_STATUS = re.compile(r'취소 완료|결제 취소|환불 완료|반품 완료')

# run_js 본문(30초 제한) — 주문 내역 첫 화면의 주문번호들
LIST_JS = """await tabs.open({ profile: %(profile)s, url: 'https://www.musinsa.com/order/order-list' })
try { await page.waitFor(/주문 상세|주문 내역이 없/, 12000) } catch (e) {}
await sleep(800)
const t = (await page.get({ selector: 'a[href*="order-detail"]' })).tree
const body = (await page.get({})).tree
for (const x of await tabs.list()) { try { await tabs.close(x.id) } catch (e) {} }
return JSON.stringify({ login: /로그인/.test(body.slice(0, 500)) && !/로그아웃/.test(body), nos: [...new Set([...t.matchAll(/order-detail\\/(20\\d{16})/g)].map((m) => m[1]))] })"""
# 주문 상세 — 주문번호 뒤(받는 곳)와 상품·상태 앞부분
DETAIL_JS = """await tabs.open({ profile: %(profile)s, url: 'https://www.musinsa.com/order/order-detail/%(no)s' })
try { await page.waitFor(/결제 정보|주문 상품/, 12000) } catch (e) {}
await sleep(500)
const text = ((await page.get({})).tree.split('PAGE TEXT')[1] || '').replace(/\\s+/g, ' ')
const i = text.indexOf('주문번호 %(no)s')
const j = text.indexOf('주문 상품')
for (const x of await tabs.list()) { try { await tabs.close(x.id) } catch (e) {} }
return JSON.stringify({ found: i >= 0, head: i >= 0 ? text.slice(i, i + 220) : '', body: j >= 0 ? text.slice(j, j + 260) : '' })"""


@dataclass(frozen=True)
class SourceDetail:
    """소싱처 주문 상세에서 읽은 것. 받는 사람·주소·전화는 담지 않는다."""

    status: str
    product: str
    to_office: bool


def ordered_at(source_order_no: str) -> datetime | None:
    """무신사 주문번호 → 결제 시각. 모양이 다르면 None."""
    m = _MUSINSA_NO.match(source_order_no)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), '%Y%m%d%H%M%S').replace(tzinfo=_KST)
    except ValueError:
        return None


def parse_detail(out: dict[str, object], office_hint: str) -> SourceDetail | None:
    """DETAIL_JS 결과 → 상태·상품·사무실 여부. 주문을 못 찾았으면 None."""
    if not out.get('found'):
        return None
    head = str(out.get('head') or '')
    body = re.sub(r'^주문 상품 \d+개\s*', '', str(out.get('body') or ''))
    # '배송 완료 10.01(목) 도착 <브랜드> 판매자 정보 <상품> / 1개 …' — 상태는 맨 앞 낱말들, 상품은 '판매자 정보' 뒤
    status = re.split(r'\s\d{2}\.\d{2}\(|판매자 정보', body, maxsplit=1)[0].strip()[:20]
    product = body.split('판매자 정보', 1)[-1].split(' / ')[0].strip()[:60]
    return SourceDetail(
        status=status, product=product, to_office=bool(office_hint) and office_hint in head
    )


# 개인 용도로 산 소싱처 주문번호 — 삼바에 기록이 없어도 알리지 않는다(사용자가 알려 준 것만 이 파일에 적는다)
PERSONAL_ORDERS_FILE = Path(__file__).resolve().parents[3] / 'personal_source_orders.json'


def personal_source_orders() -> set[str]:
    try:
        data = json.loads(PERSONAL_ORDERS_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return set()
    return {str(x) for x in data if isinstance(x, str) and x}


def is_ignorable(detail: SourceDetail) -> bool:
    """삼바에 기록이 없어도 되는 주문인가 — 취소·반품이 끝났거나 상품권이다."""
    return bool(_VOID_STATUS.search(detail.status)) or any(
        w in detail.product for w in NOT_STOCK_WORDS
    )


class SourceAudit:
    """소싱처 계정들의 최근 주문을 삼바 기록과 견줘, 기록이 없는 주문을 한 번씩 알린다."""

    def __init__(
        self,
        accounts: Callable[[], list[str]],
        list_orders: Callable[[str], list[str] | None],
        detail: Callable[[str, str], SourceDetail | None],
        known_numbers: Callable[[], set[str] | None],
        alert: Callable[[str], object] | None = None,
        *,
        site: str = 'MUSINSA',
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._accounts = accounts
        self._list = list_orders
        self._detail = detail
        self._known = known_numbers
        self._alert = alert
        self._site = site
        self._now = now
        # 이미 판단을 끝낸 주문번호(알렸거나, 넘겨도 되는 주문) — 다시 열어 보지 않는다
        self._settled: set[str] = set()

    def run_once(self, idle: Callable[[], bool] | None = None) -> list[str]:
        """한 번 훑는다. 알린 줄을 돌려준다. 주문 작업이 시작되면(idle 이 False) 바로 멈춘다."""
        known = self._known()
        if known is None:
            return []  # 삼바 기록을 못 읽었다 — 전부 '기록 없음'으로 알리면 안 된다
        now = self._now()
        told: list[str] = []
        for account in self._accounts():
            if idle is not None and not idle():
                break
            numbers = self._list(account)
            if not numbers:
                continue
            for no in numbers:
                if no in known or no in self._settled:
                    continue
                at = ordered_at(no)
                if at is None or now - at > LOOKBACK:
                    self._settled.add(no)
                    continue
                if now - at < SETTLE:
                    continue  # 방금 결제한 주문 — 기입이 끝난 뒤 다시 본다
                if idle is not None and not idle():
                    return told
                detail = self._detail(account, no)
                if detail is None:
                    continue  # 못 읽었다 — 다음 주기에 다시 본다
                self._settled.add(no)
                if is_ignorable(detail):
                    continue
                line = (
                    f'⚠ [교차 검증] 삼바 기록에 없는 소싱 주문 — {self._site} {account} {no} '
                    f'({at.astimezone(_KST):%m/%d %H:%M} 결제, 상태 "{detail.status}", {detail.product}). '
                    '같은 판매 주문을 두 번 샀을 수 있다 — 출고 전이면 바로 취소하고, 정상 구매면 삼바에 소싱주문번호를 적는다'
                )
                told.append(line)
                _log.warning(line)
                if self._alert is not None:
                    try:
                        self._alert(line)
                    except Exception:  # noqa: BLE001 — 알림 실패가 점검을 멈추게 하지 않는다
                        _log.exception('소싱처 주문 대조 알림 실패')
        return told


def delivery_mismatch(order_types: tuple[str, ...], to_office: bool) -> str | None:
    """기록된 배송 종류와 소싱처 주문의 받는 곳이 어긋나는가 — 어긋나면 알릴 글, 맞으면 None.

    선물(gift)은 받는 사람이 수락하며 주소를 넣는 방식이라 소싱처 주문에 고객 주소가 없다 — 보지 않는다.
    """
    if 'gift' in order_types:
        return None
    if 'direct' in order_types and to_office:
        return '직배로 기록됐는데 소싱처 주문은 사무실로 간다'
    if 'kkadaegi' in order_types and not to_office:
        return '까대기로 기록됐는데 소싱처 주문은 사무실이 아닌 곳으로 간다'
    return None


def run_js_json(raw: str) -> dict[str, object]:
    """run_js 응답 글에서 스크립트가 돌려준 JSON 을 꺼낸다. 없으면 빈 dict."""
    start, end = raw.find('{'), raw.rfind('}')
    if start < 0 or end <= start:
        return {}
    try:
        out = json.loads(raw[start : end + 1])
    except ValueError:
        return {}
    return out if isinstance(out, dict) else {}
