"""구매 에이전트 — 소싱처에서 옵션·계정·배송지·결제수단을 정하는 데까지만 한다.

결제창 진입과 결제 버튼은 결제 에이전트 담당이다(등록부 tools 에 결제 도구가 없다).
사이트 차이는 등록부의 저장 스크립트 이름과 rules/*.md 가 흡수한다.
"""

import copy
import json
import logging
import os
import re
import time
from collections.abc import Callable
from urllib.parse import urlparse

from samba_agent import local_aliases
from samba_agent.agents.base import (
    PAGE_DIALOGS_KEY,
    AgentBase,
    AgentFailure,
    Decision,
    run_agent,
    split_page_dialogs,
)
from samba_agent.agents.contracts import AgentResult, Assignment, OrderRef
from samba_agent.agents.registry import AgentSpec
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text
from samba_agent.sources import Source, default_sources
from samba_agent.supervisor.policy import is_poison_seller
from samba_agent.wave.client import WaveError

logger = logging.getLogger(__name__)

# (주문번호, 배송 종류) → 배송지 사전. 배송 종류는 소싱처 강제값이 있으면 그것, 없으면 주문의 값.
# 개인정보라 반환값은 호출 안에서만 쓰고 버린다
ShippingFn = Callable[[str, str], dict[str, object]]

# 로그인 아이디로 볼 수 있는 모양(ASCII 영숫자·._-). 한글 별명은 여기 걸리지 않는다
_LOGIN_ID = re.compile(r'[A-Za-z0-9._\-@]+')


def source_of(agent_name: str) -> Source:
    """'buyer.abc' → 소싱처 표(sources.yaml)의 행. 표에 없는 이름은 등록부가 만들지 않는다."""
    source = default_sources().by_agent(agent_name)
    if source is None:
        raise AgentFailure(
            'needs_human', f'소싱처 표에 없는 에이전트: {agent_name}', FailReason.UNKNOWN
        )
    return source


def product_ref(agent_name: str, order: OrderRef) -> str:
    """스냅샷 스크립트의 sku 인자 — 상품 ID > 상품 URL > 판매 상품명 순으로 확실한 것을 쓴다."""
    if order.product_url:
        spec = source_of(agent_name)
        # 같은 구매자가 여러 호스트를 맡는 경우(ABC 구매자가 그랜드스테이지 주문도 산다) 상품 ID 만 넘기면
        # 스크립트가 제 호스트(abcmart) 주소를 만들어 엉뚱한 상품(품절 오판)을 연다 — 호스트가 다르면 URL 을 그대로 준다
        if not _same_host(order.product_url, spec.home):
            return order.product_url
        pattern = spec.product_id_re
        m = pattern.search(order.product_url) if pattern else None
        return m.group(1) if m else order.product_url
    return order.sku


def _same_host(url: str, home: str | None) -> bool:
    """두 주소의 호스트(www. 제외)가 같은가. home 이 없으면 같다고 본다."""
    if not home:
        return True
    a = (urlparse(url).hostname or '').removeprefix('www.')
    b = (urlparse(home).hostname or '').removeprefix('www.')
    return a == b


def office_block_in(page: str) -> bool:
    """주문서 글자에 사무실 배송지(김사무 · 사무실길 58 · 1층 102호)가 한 덩어리로 보이는가.

    이름과 주소가 따로 보이는 것으로는 부족하다 — 29CM 기본 배송지가 '김가명 … 사무실길 58 1층 101호'
    인데 다른 곳의 이름과 합쳐 사무실로 봤다(실기 2026-09-25).
    """
    flat = re.sub(r'\s+', ' ', page)
    detail = r'\s*'.join(re.escape(part) for part in OFFICE_DETAIL.split())
    near = rf'{OFFICE_NAME}.{{0,160}}?{re.escape(OFFICE_ADDRESS_HINT)}\s*,?\s*{detail}'
    return re.search(near, flat) is not None


def _norm(text: str) -> str:
    """옵션 비교용 정규화 — 공백·구두점 제거, 소문자."""
    return re.sub(r'[\s\-_/·,()\[\]]+', '', text).lower()


# 주소 비교용 — 사이트가 우편번호 검색으로 바꿔 놓는 표기 차이("서울특별시"→"서울", 뒤에 "(태평로1가)" 붙음)를 지운다
# 쉼표도 지운다 — 주문 '…35가길 6, 401호' ↔ 사이트 '…35가길 6 401호'(실기 2026-09-27 패션플러스)
_ADDR_DROP = re.compile(r'\([^)]*\)|특별자치도|특별자치시|특별시|광역시|자치|,|\s+')


# 행정구역 개편으로 바뀐 이름 — 주문은 옛 이름, 사이트 주소검색은 새 이름으로 온다(인천 서구 → 서해구, 2026-07)
_ADDR_RENAMED = (('서해구', '서구'),)


def _norm_address(text: str) -> str:
    for new_name, old_name in _ADDR_RENAMED:
        text = text.replace(new_name, old_name)
    return _ADDR_DROP.sub('', text).lower()


def shipping_matches(expected: dict[str, object], applied: dict[str, object]) -> bool:
    """넣은 배송지와 사이트가 되읽어 준 배송지가 같은 곳인가.

    이름은 공백을 뺀 정확 일치. 주소는 사이트 표기 차이를 지운 뒤 한쪽이 다른 쪽을 품거나,
    도로명·건물번호 등 숫자 토큰이 모두 같아야 한다(실기: 무신사가 "서울특별시 중구 세종대로 110" 을
    "서울 중구 세종대로 110 (서울특별시청)" 으로 되읽어 정확 비교가 어긋났다).
    """
    if _norm(str(expected.get('name', ''))) != _norm(str(applied.get('name', ''))):
        return False
    # 호수 — 되읽은 주소에 'NNN호'가 보이면 넣으려던 호수와 같아야 한다(실기 29CM: 1층 101호 / 1층 102호가 함께 있다)
    want_ho = re.findall(r'(\d+)\s*호', str(expected.get('address_detail') or ''))
    got_ho = re.findall(
        r'(\d+)\s*호', f'{applied.get("address") or ""} {applied.get("address_detail") or ""}'
    )
    if want_ho and got_ho and want_ho[-1] not in got_ho:
        return False
    # 우편번호가 양쪽에 있고 같으면 같은 곳이다 — 지번(41-11)을 도로명(14번길 11)으로 되읽는 사이트(실기: 롯데온)는
    # 숫자 토큰이 달라진다
    zip_exp = re.sub(r'\D', '', str(expected.get('postal_code') or ''))
    zip_app = re.sub(r'\D', '', str(applied.get('zip') or applied.get('postal_code') or ''))
    if zip_exp and zip_app and zip_exp == zip_app and str(applied.get('address') or '').strip():
        return True
    a = _norm_address(str(expected.get('address', '')))
    b = _norm_address(str(applied.get('address', '')))
    if not a or not b:
        return False
    if a in b or b in a:
        return True
    return re.findall(r'\d+', a) == re.findall(r'\d+', b) and a[-6:] in b


# 결제수단 이름 → 키마스터 결제 제공자(src/shared/vault.ts PaymentProvider). 앞에서부터 먼저 맞는 것
QUOTE_PROVIDER_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ('musinsapay', ('무신사페이',)),
    ('toss', ('토스', 'toss')),
    ('kakao', ('카카오', 'kakao')),
    ('naver', ('네이버', 'naver')),
    ('payco', ('페이코', 'payco')),
    ('samsung', ('삼성페이', 'samsung')),
    ('apple', ('애플', 'apple')),
    # 사이트 자체 결제(웹에서 끝나는 결제) — 무신사머니·SSG PAY·L.pay·스마일페이 등
    # 롯데온 '충전결제'는 L.pay(사이트 결제 비밀번호, 키마스터 site 항목)다(실기 2026-09-26)
    # 슈마커·롯데온 '간편결제'는 사이트에 등록한 카드로 사이트 결제 비밀번호(키마스터 site 항목)를 쓴다
    ('site', ('머니', 'ssg pay', 'ssgpay', 'l.pay', 'lpay', '엘페이', '충전결제', '간편결제', '스마일', 'smile', '포인트')),
    # 주문서의 '카드'(직접 결제)는 쓰지 않는다 — 결제 가능 수단에 절대 들어가지 않게 표에서 뺀다.
    # 예외는 소싱처 단위 direct_card(H몰 롯데카드) — quote_provider 가 표보다 먼저 본다
)


# 주문서 '카드' 탭 직접 결제(소싱처 direct_card, H몰 = 롯데카드)의 결제 제공자 — 키마스터 결제 비밀번호가 아니라
# 카드사 결제창(앱카드·안심클릭)에서 사람이 폰으로 승인한다. 그 소싱처의 허용 수단(pay_provider)도 이 값이다
DIRECT_CARD_PROVIDER = 'card'
# 카드 직접 결제로 보는 결제수단 이름(주문서 탭 글자)
DIRECT_CARD_METHODS = ('카드', '신용카드')


def _direct_card_provider(method: str, card: str | None, direct_card: str | None) -> str | None:
    """소싱처가 허용한 카드사 직접 결제 줄이면 'card', 아니면 None. 다른 카드사 줄은 허용하지 않는다(None)."""
    if not direct_card or method.strip() not in DIRECT_CARD_METHODS:
        return None
    issuer = direct_card.replace('카드', '').strip()
    return DIRECT_CARD_PROVIDER if not card or (issuer and issuer in card) else None


def quote_provider(method: str, card: str | None = None, direct_card: str | None = None) -> str | None:
    """견적 한 줄의 결제수단(카드사 포함)이 어느 결제 제공자인지. 모르면 None(결제 불가로 본다).

    direct_card(소싱처 표)가 있으면 주문서 '카드' 탭의 그 카드사 줄만 카드 직접 결제('card')로 본다(H몰 롯데카드).
    """
    if direct_card and method.strip() in DIRECT_CARD_METHODS:
        return _direct_card_provider(method, card, direct_card)
    # 수단 이름을 먼저 본다 — 카드 칸에 옆 줄 문구가 섞일 수 있다(실기 2026-09-25 르무통: 페이코 줄의 카드가
    # '적립 무신사페이 혜택 관리 현대카드'로 읽혀 무신사페이로 분류, 페이코만 되는 buyer03 이 결제 수단 없음)
    for text in (method.lower(), f'{method} {card or ""}'.lower()):
        for provider, keywords in QUOTE_PROVIDER_KEYWORDS:
            if any(k in text for k in keywords):
                return provider
    return None


_CARD_ISSUER_RE = re.compile(r'(현대|KB국민|KB|국민|롯데|신한|농협|NH|삼성|하나|우리|BC|비씨|씨티)\s*카드')


def clean_card(card: str | None) -> str | None:
    """견적 줄 카드 칸에서 카드사 이름만 남긴다('적립 무신사페이 혜택 관리 현대카드' → '현대카드'). 못 찾으면 그대로."""
    if not card:
        return card
    m = _CARD_ISSUER_RE.search(card)
    return f'{m.group(1)}카드' if m and not re.search(r'무신사\s*삼성', card) else card


def parse_account_priorities(raw: str) -> dict[str, int]:
    """앱 list_accounts 결과 → {계정 라벨: 결제 우선순위}. 순위가 없는 계정은 빠진다."""
    body, _ = split_page_dialogs(raw)
    try:
        parsed = json.loads(body)
    except ValueError:
        return {}
    items: object = parsed.get('accounts') if isinstance(parsed, dict) else parsed
    out: dict[str, int] = {}
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            label = str(item.get('label') or '').strip()
            pr = item.get('priority')
            if label and isinstance(pr, int) and pr >= 1:
                out[label] = pr
    return out


def parse_account_payments(raw: str, label: str) -> set[str] | None:
    """앱 list_accounts 결과에서 그 계정의 결제 가능 제공자 집합. 계정을 못 찾거나 형식이 아니면 None.

    payments(결제 비밀번호 항목의 제공자)만 본다. 카드 직접 결제는 쓰지 않는다(카드는 간편결제 창 안에서 고른다).
    """
    body, _ = split_page_dialogs(raw)
    try:
        parsed = json.loads(body)
    except ValueError:
        return None
    items: object = parsed.get('accounts') if isinstance(parsed, dict) else parsed
    if not isinstance(items, list):
        return None
    for item in items:
        if not isinstance(item, dict) or str(item.get('label') or '').strip() != label:
            continue
        payments = item.get('payments')
        return {str(x) for x in payments} if isinstance(payments, list) else set()
    return None


def method_providers(
    method: str, money_in_pay: bool = False, direct_card: str | None = None
) -> set[str]:
    """주문서 결제수단 하나로 낼 수 있는 결제 제공자들. 사이트 머니가 간편결제 안에 있는 소싱처(29CM)면
    '무신사페이' 는 무신사머니(site) 창구이기도 하다. direct_card 소싱처(H몰)면 '카드' 탭은 'card'."""
    provider = quote_provider(method, None, direct_card)
    if provider is None:
        return set()
    if money_in_pay and provider == 'musinsapay':
        return {provider, 'site'}
    return {provider}


def payable_methods(
    methods: list[str], payable: set[str], money_in_pay: bool = False, direct_card: str | None = None
) -> list[str]:
    """주문서에 보이는 결제수단 이름 중 키마스터로 낼 수 있는 것만(사이트 표기 그대로). 순서는 화면 순서."""
    return [m for m in methods if method_providers(m, money_in_pay, direct_card) & payable]


def cheapest_quotes(
    raw: object,
    wanted_card: str | None,
    payable: set[str] | None = None,
    easy_pay_card: str | None = None,
    charge_pay: bool = False,
    direct_card: str | None = None,
) -> list[dict[str, object]]:
    """결제수단 견적 목록을 싼 순으로 정리한다. 금액이 없거나 0 이하인 줄은 뺀다.

    '충전결제' 줄은 charge_pay(소싱처 표)일 때만 후보로 둔다 — 기본은 뺀다(롯데온 L.pay).

    payable 이 주어지면 그 제공자로 낼 수 있는 줄만 남긴다(키마스터에 결제 비밀번호·카드가 있는 수단).
    요청자가 카드(수단 이름 또는 카드사 이름 일부)를 지정했으면 그것이 들어간 줄만 남긴다.
    같은 금액이면 목록 앞(사이트가 기본으로 보여 준 순서)이 먼저다.
    """
    if not isinstance(raw, list):
        return []
    rows: list[dict[str, object]] = []
    for q in raw:
        if not isinstance(q, dict):
            continue
        cost = _as_float(q.get('cost'))
        method = str(q.get('method') or '').strip()
        if cost <= 0 or not method:
            continue
        card = clean_card(str(q.get('card') or '').strip() or None)
        if card is None and quote_provider(method) == 'payco':
            # 페이코는 PC 결제창 안에서 현대카드로 낸다 — 특별할인이 없어도 청구할인 2.7%(×0.973)가 붙는다
            # (사용자 2026-09-25). 견적 줄에 카드가 없으면 현대카드로 보고 원가를 낸다
            card = PAYCO_CARD
        if card is None and easy_pay_card and '간편결제' in method:
            # 사이트 간편결제에 등록된 카드(슈마커 = 현대카드, 사용자 2026-09-26) — 청구할인을 원가에 반영한다
            card = easy_pay_card
        if q.get('available') is False or q.get('allowed') is False or q.get('registered') is False:
            # 낼 수 없는 수단(무신사머니 연결 계좌 없음·잔액 부족), 허용 안 된 조합(토스페이×계좌 등), 미등록 카드
            continue
        # '무신사 삼성카드'는 무신사 제휴카드다 — 사용자에겐 없다(일반 삼성카드와 다르다, 사용자 2026-09-24).
        # 그 카드 전용 즉시할인(-5,000)을 받을 수 있다고 견적하면 안 된다
        if card and ('무신사 삼성' in card or '무신사삼성' in card):
            continue
        if '충전결제' in method and not charge_pay:
            # 롯데온 L.pay 충전결제는 현대카드 결제보다 항상 불리하다 — 후보에서 뺀다(사용자 2026-09-26).
            # 소싱처가 charge_pay 로 켜면(SSG MONEY 충전결제 1.5% 적립 등) 비교 후보로 남긴다
            continue
        if card and not any(n in card for n in ALLOWED_CARD_ISSUERS):
            # 허용 카드사(ALLOWED_CARD_ISSUERS) 밖 — 견적만 싸고 실제로는 기본 카드로 결제된다
            # (실기: 삼성카드 할인가 49,310 으로 골랐는데 롯데카드로 51,360 결제)
            continue
        if payable is not None:
            provider = quote_provider(method, card, direct_card)
            if provider is None or provider not in payable:
                continue
        if wanted_card:
            w = wanted_card.strip()
            if w not in method and (card is None or w not in card):
                continue
        reward = _as_float(q.get('reward'))
        if quote_provider(method, card) == 'naver':
            # 네이버페이 기본 적립(결제액 1%)은 사이트 적립(A-RT 포인트 등)과 따로 붙는다 — 원가에서 뺀다
            # (사용자 2026-09-25: 사용 포인트는 더하고 적립 포인트·네이버 포인트는 뺀다. 실측 64,600 → 646)
            reward += round(cost * NAVERPAY_POINT_RATE)
        rows.append(
            {
                'method': method,
                'card': card,
                'paid': cost,
                'reward': reward,
                'points_used': _as_float(q.get('points_used')),
                'cost': effective_cost({**q, 'cost': cost, 'card': card, 'reward': reward}),
            }
        )
    # 같은 원가면 페이코를 뒤로 — 무신사페이(같은 현대카드)가 결제창·로그인 없이 절차가 간편하다(사용자 2026-09-25)
    return sorted(
        rows,
        key=lambda r: (float(r['cost']), quote_provider(str(r['method']), r['card']) == 'payco'),  # type: ignore[arg-type]
    )


# 포이즌 외 마켓의 까대기 건 배송비(삼바웨이브 기록, 원). 사무실 경유 재발송비 — poizon-sourcing 스킬 규칙
KKADAEGI_SHIPPING_FEE = 2300
# 사무실 주소 표식 — 까대기의 기본 배송지가 이 주소여야 한다(경북 가상시 사무실길 58)
OFFICE_ADDRESS_HINT = local_aliases.apply('사무실길 58')
# 사무실 수령인 — 주소가 사무실이어도 이름이 다르면 사무실 배송지로 보지 않는다(사용자 2026-09-24)
OFFICE_NAME = local_aliases.apply('김사무')
# 까대기 주문 배송지(사무실). 기본 배송지가 사무실이 아닐 때 이번 주문에만 넣는다 — poizon-sourcing 스킬 "사무실 배송"
OFFICE_DETAIL = '1층 102호'
# SSG 선물하기 스크립트(2026-09-29) — 바로구매 주문서로 견적한 뒤 선물 주문서로 바꿔 탄다
SSG_GIFT_ENTER_SCRIPT = 'ssg_gift_enter'
SSG_GIFT_ADDRESS_SCRIPT = 'ssg_gift_address'
SSG_GIFT_SAVE_SCRIPT = 'ssg_gift_save_address'
SSG_LOGIN_CHECK_SCRIPT = 'ssg_login_check'
# 까대기 주문서에서 기본 배송지(사무실)가 그려질 때까지 다시 읽는 횟수·간격
DEFAULT_SHIPPING_POLL_TRIES = 4
DEFAULT_SHIPPING_POLL_MS = 1500
# 계정별 결제수단 제한 — 비어 있으면 모든 계정이 허용 수단(SAMBA_ALLOWED_PAY_PROVIDERS) 전부로 비교한다.
# buyer02 는 한때 무신사머니만 썼으나 무신사머니·무신사페이·페이코 모두 허용으로 바뀌었다(사용자 2026-09-25 저녁)
ACCOUNT_PAY_ONLY: dict[str, frozenset[str]] = {}
OFFICE_SHIPPING: dict[str, object] = {
    'name': OFFICE_NAME,
    'address': local_aliases.apply('경북 가상시 사무실길 58'),
    'address_detail': OFFICE_DETAIL,
    'postal_code': local_aliases.apply('postal:99999').removeprefix('postal:'),
}
# 포인트로 전액 결제할 때의 결제수단 이름 — 결제 진입 스크립트가 이 이름을 보고 수단을 고르지 않고 결제하기만 누른다
POINTS_ONLY_METHOD = '포인트전액'
# 네이버페이 기본 적립률(결제액 기준) — 사이트 적립과 별개로 원가에서 뺀다(실측 2026-09-25 64,600원 → 646원)
NAVERPAY_POINT_RATE = 0.01
# 페이코 결제 카드(사용자 2026-09-25: 페이코 = 현대카드, 청구할인 2.7%)
PAYCO_CARD = '현대카드'
# 카드 청구할인(플레이북 §7): 결제창에 안 보이는 카드 대금 할인 — 원가 = 카드 결제액 × 계수 − 적립
CARD_BILLING_FACTORS: tuple[tuple[tuple[str, ...], float], ...] = (
    (('현대',), 0.973),
    (('롯데', 'KB', '국민'), 0.98),
)


# SSG 는 신세계몰(siteNo 6004) 상품만 산다(사용자 2026-09-27). 신세계백화점(6009)은 소싱처 allow_department 일 때만.
# 이마트·트레이더스 등 그 밖의 몰은 금지 — 스냅샷 스크립트가 바로구매 전에 error:'not_shinsegaemall' 로 멈춘다
NOT_MALL_ERROR = 'not_shinsegaemall'
# 사이트 봇 차단(SSG PerimeterX 등) — 스크립트 잘못이 아니다. 재시도·AI 수리 없이 사람에게 넘긴다(돌릴수록 더 막힌다)
BLOCKED_ERROR = 'blocked'
# 진입 경로(다나와 이동 링크) 오류 — 링크 없음·도착 주소에 제휴(ReferCode) 없음·다른 상품 도착. 스크립트 잘못이 아니라
# 규칙상 사지 말아야 하는 상태다(H몰 직접 진입 금지, 사용자 2026-09-27) — AI 수리 없이 사람에게 넘긴다
ENTRY_ERRORS = frozenset({'no_entry', 'no_affiliate', 'wrong_product'})
# 봇 차단 실패 사유 머리 — 교차 비교 짝이 있으면 그쪽만 견적해 사는 대체 경로로 간다(SSG → H몰)
BLOCKED_REASON = '사이트 봇 차단'
_MALL_URL_RE = re.compile(r'shinsegaemall\.ssg\.com|[?&]siteNo=6004(?!\d)')
_DEPARTMENT_URL_RE = re.compile(r'department\.ssg\.com|[?&]siteNo=6009(?!\d)')
# 신세계몰 같은 상품 후보를 주문서까지 시험해 보는 최대 개수(싼 순서) — 후보마다 상품 페이지·주문서를 연다.
# SSG 는 상품 페이지를 네 번쯤 열면 봇 차단에 다시 걸린다(2026-09-27) — 적게 돈다
MALL_ITEM_TRIES = 2
# 진입 경로 — 소싱처 routes 가 비었으면 애드픽 하나(주문서 금액은 경로와 무관함을 실측, 적립만 다르다 — 2026-09-27).
# 애드픽 진입이 안 되면 직접 경로로 산다. 직접·다나와·에누리까지 비교하려면 routes 에 적는다(페이지 요청이 는다)
ROUTES_DEFAULT = ('adpick',)
DIRECT_ROUTE = 'direct'
ADPICK_ROUTE = 'adpick'
# 상품명 속 모델코드(HF5441-100·YUA24B06) — 스크립트 ssg_route_quotes 와 같은 규칙. 한글에 붙어 있어도 잡게 ASCII 경계
_MODEL_CODE_RE = re.compile(r'\b([A-Z]{1,4}\d{3,6}[A-Z0-9]{0,4})(?:[ _-](\d{3}))?\b', re.ASCII)
_LOOSE_MODEL_RE = re.compile(r'\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}\b', re.ASCII)


def is_mall_url(url: str | None, allow_department: bool = False) -> bool:
    """지정 몰(신세계몰, allow_department 면 신세계백화점까지) 상품 주소인가."""
    u = url or ''
    return bool(_MALL_URL_RE.search(u) or (allow_department and _DEPARTMENT_URL_RE.search(u)))


def mall_unknown_url(url: str | None) -> bool:
    """몰을 주소로 알 수 없는 SSG 상품 주소(www.ssg.com/item/…, siteNo 없음) — 열어 봐야 신세계몰·백화점인지 안다.

    실기 2026-09-27: 신세계백화점 백팩 주소가 www.ssg.com 이라 몰 아님으로 보고 신세계몰 검색으로 빠졌다.
    """
    u = url or ''
    return bool(re.search(r'//(www\.)?ssg\.com/item/', u)) and 'siteNo=' not in u


def model_code_of(name: str | None) -> str:
    """상품명의 모델코드(영문+숫자, 뒤 세 자리 색 코드는 '-' 로 잇는다). 없으면 ''.

    나이키형(HF5441-100)이 먼저, 아니면 영문·숫자가 섞인 여섯 글자 이상 토큰(YUA24B06)."""
    m = _MODEL_CODE_RE.search(name or '')
    if m:
        return f'{m.group(1)}-{m.group(2)}' if m.group(2) else m.group(1)
    loose = _LOOSE_MODEL_RE.search(name or '')
    return loose.group(0) if loose else ''


def mall_candidates(raw: object) -> list[dict[str, object]]:
    """신세계몰 같은 상품 후보 — 주소·상품번호가 있는 것만, 가격 싼 순(가격 모름은 뒤, 같으면 원래 순서)."""
    items = [
        x
        for x in (raw if isinstance(raw, list) else [])
        if isinstance(x, dict) and str(x.get('url') or '').startswith('https://') and x.get('item_id')
    ]
    return sorted(items, key=lambda x: _as_float(x.get('price')) or float('inf'))


def usable_routes(raw: object, wanted: list[str]) -> list[dict[str, object]]:
    """경로 견적 중 스냅샷으로 비교할 수 있는 것 — 진입 주소가 있고 지정 몰에 도착했고 품절이 아니며 같은 상품인 것."""
    out: list[dict[str, object]] = []
    for r in raw if isinstance(raw, list) else []:
        if not isinstance(r, dict) or r.get('route') not in wanted:
            continue
        if not str(r.get('entry_url') or '').startswith('https://'):
            continue
        if r.get('mall_ok') is not True or r.get('sold_out') or r.get('same_item') is False:
            continue
        out.append(r)
    return out


def adpick_reward_of(snap: dict[str, object]) -> float:
    """애드픽 경로 적립(원) — 스냅샷의 adpick_reward, 없으면 결제액 × adpick_rate(%). 애드픽이 아니면 0."""
    reward = _as_float(snap.get('adpick_reward'))
    if reward > 0:
        return reward
    rate = _as_float(snap.get('adpick_rate'))
    paid = _as_float(snap.get('pay_amount')) or _as_float(snap.get('cost'))
    return float(round(paid * rate / 100)) if rate > 0 else 0.0


def blocked_failure(out: dict[str, object], what: str) -> AgentFailure | None:
    """스크립트가 봇 차단(error:'blocked')을 알렸으면 사람에게 넘길 실패, 아니면 None."""
    if out.get('error') != BLOCKED_ERROR:
        return None
    return AgentFailure(
        'needs_human',
        mask_text(f'{BLOCKED_REASON}({what}) — 재시도하지 않는다: {str(out.get("note") or "")[:80]}'),
        FailReason.CAPTCHA,
    )


def route_cost(snap: dict[str, object]) -> float:
    """경로 비교 값 = 결제액. 애드픽·샵백 적립은 원가에 넣지 않는다(사용자 2026-09-27) — 결제액이 같으면
    호출부가 애드픽 경로를 고른다. 결제액을 모르면 0(비교에서 뺀다)."""
    paid = _as_float(snap.get('pay_amount')) or _as_float(snap.get('cost'))
    return paid if paid > 0 else 0.0


def product_no_of(url: str | None) -> str:
    """상품 주소의 상품번호(무신사 /products/123, 29CM /products/123, a-rt prdtNo=, 슈마커 ProductCode=,
    SSG itemId=, 패션플러스 /goods/detail/123, H몰 slitmCd=). 없으면 ''."""
    m = re.search(
        r'(?:/products/|[?&]prdtNo=|[?&]ProductCode=|/catalog/|[?&]itemId=|/goods/detail/|[?&]slitmCd=)(\d+)',
        url or '',
    )
    return m.group(1) if m else ''


def billing_factor(card: str | None) -> float:
    """카드사 이름에 맞는 청구할인 계수. 없으면 1.0"""
    if not card:
        return 1.0
    for names, factor in CARD_BILLING_FACTORS:
        if any(n in card for n in names):
            return factor
    return 1.0


def effective_cost(row: dict[str, object]) -> float:
    """견적 한 줄의 원가(플레이북 §6): 실결제액 × 청구할인 계수 − 후기 제외 신규 적립 + 사용한 기존 적립금."""
    paid = _as_float(row.get('cost'))
    reward = _as_float(row.get('reward'))
    used = _as_float(row.get('points_used'))
    return round(paid * billing_factor(str(row.get('card') or '') or None) - reward + used)


# 결제창(토스페이·네이버페이) 안에서 고를 수 있는 카드사. 2026-09-24: 현대·KB·롯데·신한·농협, 2026-09-28 사용자 추가:
# 우리·BC·삼성(일반 삼성카드 — '무신사 삼성카드' 제휴카드와 다르며 그쪽은 위에서 따로 뺀다). 주문서 단계의
# '카드 직접 결제'는 쓰지 않는다 — 카드는 간편결제 창 안에서만 고른다. 결제 에이전트가 카드를 고를 때 이 표를 쓴다
# 무신사 적립금은 보유 5만원 이상일 때만 쓴다(플레이북 §6) — 그 아래면 '적립금 못 쓰는 계정'으로 본다
POINTS_USE_MIN = 50000
ALLOWED_CARD_ISSUERS = ('현대', 'KB', '국민', '롯데', '신한', '농협', 'NH', '우리', 'BC', '비씨', '삼성')


def decide_order_type(
    order: OrderRef, normal_price: float | None, forced: str | None = None, forwarder: bool = False
) -> tuple[str, str]:
    """이 주문을 직배/까대기 중 무엇으로 이행할지와 그 근거(poizon-sourcing 스킬 "대상과 처리 순서").

    - 소싱처가 강제하면(ABC마트·그랜드스테이지 = 까대기) 그것
    - 포이즌 판매건은 소싱처와 무관하게 까대기
    - 그 밖의 마켓(KT알파·롯데홈쇼핑·쿠팡 …)은 **소싱처 정가(세일가 아님)** 와 고객 결제액을 비교한다:
      정가 ≤ 고객 결제액 → 까대기(고객이 정가를 보면 클레임), 정가 > 고객 결제액 → 직배
    - 정가나 고객 결제액을 모르면 판정 불가(빈 문자열) — 호출부가 사람에게 넘긴다
    선물(gift) 태그가 있는 주문은 배송지 입력 흐름이 다르니 그대로 둔다.
    """
    if forced:
        return forced, f'소싱처 규칙({forced})'
    if order.order_type == 'gift':
        return 'gift', '선물 태그'
    if is_poison_seller(order.seller):
        return 'kkadaegi', '포이즌 판매건은 전부 까대기'
    if forwarder:
        # 받는 곳이 해외 판매 물류창고(LAZADA 배대지) — 사무실로 받아 보낸다(사용자 2026-09-27)
        return 'kkadaegi', '라자다(해외 배대지) 주문은 까대기'
    if normal_price is None or normal_price <= 0:
        return '', '소싱처 정가를 읽지 못해 직배/까대기를 정할 수 없다'
    if order.sale_price <= 0:
        # 고객 결제액을 모르는 주문(삼바웨이브 판매가 0) — 비교할 수 없으니 태그를 따른다
        return order.order_type, '고객 결제액을 몰라 삼바웨이브 태그를 따름'
    if normal_price <= order.sale_price:
        return 'kkadaegi', f'정가 {normal_price:,.0f} ≤ 고객 결제액 {order.sale_price:,.0f}'
    return 'direct', f'정가 {normal_price:,.0f} > 고객 결제액 {order.sale_price:,.0f}'


def shipping_fee_for(order: OrderRef, order_type: str) -> float:
    """삼바웨이브에 기록할 배송비 — 포이즌 외 마켓의 까대기 건만 2,300원, 나머지(포이즌·직배)는 0."""
    if order_type == 'kkadaegi' and not is_poison_seller(order.seller):
        return float(KKADAEGI_SHIPPING_FEE)
    return 0.0


_FREE_SIZE_TOKENS = frozenset({'free', 'f', 'one', 'onesize', 'os', 'osfm', 'fs', '프리', '프리사이즈', '단일', '단일사이즈', 'freesize'})


def _is_free_size(text: str) -> bool:
    """옵션 글자에 프리사이즈 표기(토큰)가 있는가 — 'BLACK FREE'·'ONE'·'ONE SIZE'·'BLACK · ONE'."""
    toks = [t for t in re.split(r'[\s/·,()\-]+', text.lower()) if t]
    joined = ''.join(toks)
    return any(t in _FREE_SIZE_TOKENS for t in toks) or 'onesize' in joined or 'freesize' in joined


_KR_SIZE_RE = re.compile(r'(?<![A-Za-z])KR\s*(\d{3})(?!\d)', re.IGNORECASE)


def kr_size(text: str | None) -> str | None:
    """옵션 글자에 적힌 한국 치수('KR 270' → '270'). 없으면 None."""
    m = _KR_SIZE_RE.search(text or '')
    return m.group(1) if m else None


def matching_options(options: list[str], wanted: str | None) -> list[str]:
    """주문 옵션과 맞는 후보들. 주문 옵션이 없으면 전부 후보다.

    순서: 정확 일치 → 정규화 일치 → 후보가 주문 옵션(정규화)을 포함하거나 그 반대 →
    숫자만 같은 것(사이즈 230 ↔ '230(mm)'). '품절' 표시가 붙은 후보는 뺀다.
    아무 단계도 안 맞으면 빈 목록 — 절대 '가까운 값' 으로 대신하지 않는다.
    """
    live = [o for o in options if not _sold_out(o)]
    if not wanted:
        return live
    # 프리사이즈 표기 차이(FREE·F·ONE·ONE SIZE·OS·단일) — 주문이 프리사이즈인데 후보가 프리사이즈 하나뿐이면 그것이다
    # (실기 2026-09-26: 주문 "BLACK FREE" ↔ 무신사 선택지 ['ONE'] 을 품절로 봤다)
    if _is_free_size(wanted):
        free = [o for o in live if _is_free_size(o)]
        if free:
            return free
    # 선택지가 프리사이즈 하나뿐이고 주문 옵션에 사이즈가 없으면(색상만) 그것이다 — 색상은 상품 자체가 정한다
    # (실기 2026-09-28: 주문 '블랙 & 올리브 그린' ↔ 무신사 선택지 ['FREE'] 를 옵션 불일치로 멈췄다).
    # 상품이 맞는지는 결제 직전 주문서 대조가 다시 본다
    if (
        len(live) == 1
        and _is_free_size(live[0])
        and not re.search(r'\d', wanted)
        and not size_letters(wanted)
    ):
        return live
    # 주문 옵션에 한국 치수가 같이 적혀 있으면('EU 42 · KR 270') 그 치수로 맞춘다 — 외국 치수 숫자(42)가
    # 다른 선택지에 걸리지 않게 먼저 본다(사용자 결정 2026-09-29: 한국 치수가 있을 때만 그것으로 맞춘다)
    kr = kr_size(wanted)
    if kr:
        marked = [o for o in live if kr_size(o) == kr]
        if marked:
            return marked
        by_kr = [o for o in live if not kr_size(o) and kr in size_numbers(o)]
        if by_kr:
            return by_kr
    w = wanted.strip()
    exact = [o for o in live if o.strip() == w]
    if exact:
        return exact
    nw = _norm(w)
    if nw:
        normed = [o for o in live if _norm(o) == nw]
        if normed:
            return normed
        # 후보가 주문 옵션 안에 들어 있는 경우는 두 글자 이상만 — 'L' 이 'BLACK' 안에 있다고 L 을 고르면 안 된다
        contains = [o for o in live if _norm(o) and (nw in _norm(o) or (len(_norm(o)) >= 2 and _norm(o) in nw))]
        # 사이즈 글자가 서로 다르면(주문 XL ↔ 선택지 2XL·XXL) 글자 포함으로 맞추지 않는다
        # (실기 2026-09-30 그랜드스테이지: XL 품절인데 2XL 을 후보로 봐 품절 확증을 놓쳤다)
        wl = size_letters(w)
        if wl:
            contains = [o for o in contains if not size_letters(o) or size_letters(o) == wl]
        if contains:
            return contains
        # 주문 옵션이 "카키 085(L) NP6KP12C" 처럼 여러 단계·품번이 섞인 경우 — 토큰 하나가 후보 안에 있으면 맞는 것으로
        # 본다(실기: 롯데온 사이즈 "085(L) 35,100 2개 남음 (품절임박)"). 한 글자짜리 토큰(M·L)은 너무 헐거워 뺀다
        # 빗금으로 붙은 옵션('1.블랙(051)/255')도 조각으로 나눈다 — 실기 2026-09-29 롯데온: 선택지 '255 …' 를 못 맞췄다
        for tok in re.split(r'[\s/]+', w):
            nt = _norm(tok)
            if len(nt) < 2:
                continue
            # 경계 일치가 먼저 — "XL" 은 "Black-XL" 에만 맞고 "Black-XXL"·"Black-XLT" 에는 안 맞는다
            by_piece = [o for o in live if nt in [_norm(x) for x in re.split(r'[-\s/]+', o)]]
            by_tok = [o for o in live if nt in _norm(o)]
            tl = size_letters(tok)
            if tl:
                # 사이즈 글자 조각(XL)은 사이즈 글자가 같은 선택지에만(2XL·XXL 제외)
                by_tok = [o for o in by_tok if not size_letters(o) or size_letters(o) == tl]
            # 모든 선택지에 든 조각(색상 'YEL' ↔ 'YEL 230'…'YEL 290')은 가르는 힘이 없다 — 다음 조각으로 본다
            # (실기 2026-09-29 패션플러스: 주문 'YEL 270' 에 12개 전부가 후보가 돼 없는 270 을 골랐다)
            if len(live) > 1 and len(by_piece or by_tok) == len(live):
                continue
            if by_piece:
                return by_piece
            if by_tok:
                return by_tok
        # 한 글자 사이즈 조각('01올리브/L' 의 L)은 선택지 글자 전체와 똑같을 때만, 하나로 정해질 때만 고른다
        # (실기 2026-09-29 무신사 지오다노: 사이즈 단계 ['M (품절)', 'L (품절)', 'XL'] 를 옵션 불일치로 멈췄다)
        pieces = {_norm(t) for t in re.split(r'[\s/]+', w) if t}
        same_piece = [o for o in live if _norm(o) in pieces]
        if len(same_piece) == 1:
            return same_piece
    # 글자-숫자 사이즈('S-3'·'M-4' — 라코스테 숫자 사이즈)는 숫자가 선택지의 세 자리 코드다('003(95)').
    # 상품 자체 표기로 맞춘다(사용자 2026-09-29: 사이즈는 그 상품의 사이즈표 기준) — 글자만으로 95·100 을 짐작하지 않는다
    for tok in re.split(r'[\s/]+', w):
        m = re.fullmatch(r'(?:XXS|XS|S|M|L|XL|XXL|XXXL)-(\d)', tok.strip(), re.IGNORECASE)
        if m:
            code = f'00{m.group(1)}'
            by_code = [o for o in live if re.match(rf'{code}(?!\d)', o.strip())]
            if by_code:
                return by_code
    digits = re.findall(r'\d+', w)
    if len(digits) == 1:
        by_digit = [o for o in live if re.findall(r'\d+', o) == digits]
        if by_digit:
            return by_digit
    return []


# 사이즈를 가르는 숫자 — 두 자리 이상(285·56.8·44). '7 1/8' 의 한 자리 숫자는 너무 헐거워 뺀다
_SIZE_NUM_RE = re.compile(r'\d+(?:\.\d+)?')


def size_numbers(text: str) -> set[str]:
    """옵션 글자 속 사이즈 숫자들(두~네 자리). 다섯 자리 이상은 품번이라 뺀다.

    실기 2026-09-27: 주문 '블랙 M 2406433303' 의 품번을 사이즈 숫자로 봐서 선택지 'M' 을 못 골랐다.
    """
    return {n for n in _SIZE_NUM_RE.findall(text) if 2 <= len(n.replace('.', '')) <= 4}


_SIZE_LETTER_RE = re.compile(
    r'(?<![A-Za-z])(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL|FREE|ONE)(?![A-Za-z])'
)


def size_letters(text: str) -> set[str]:
    """옵션 글자 속 사이즈 글자(S·M·L·XL·FREE·ONE …, 대문자 기준). 한글 '프리(사이즈)'·'원사이즈'도 FREE 로 본다.

    실기 2026-09-25: 주문 '라이트 블루 프리 사이즈' ↔ 선택지 'FREE' 를 AI 가 계정마다 다르게 판단해
    buyer01 이 품절로 빠지고 비싼 계정만 남아 마진 미달로 멈췄다.
    """
    upper = re.sub(r'프리\s*사이즈|프리(?=\s|$)|원\s*사이즈', ' FREE ', text.upper())
    # 원사이즈 표기(OSFM·O/S·ONE SIZE·ONE)도 FREE 로 맞춘다(실기 2026-09-27 무신사 287: 주문 '프리 사이즈' ↔ 'OSFM')
    upper = re.sub(r'(?<![A-Z])(?:OSFM|O/S|ONE\s*SIZE|ONE)(?![A-Z])', ' FREE ', upper)
    return set(_SIZE_LETTER_RE.findall(upper))


def size_letter_options(options: list[str], wanted: str | None) -> list[str]:
    """사이즈 글자만으로 맞는 후보 하나 — 주문 옵션에 사이즈 숫자가 없고 글자 사이즈(S·M·L…)가 있을 때.

    색이 하나뿐인 상품은 선택지에 사이즈만 있다(실기 29CM 아디다스: 주문 '블랙 S' ↔ 선택지 'A/XS·A/S·A/M' —
    'A/'는 아시아 사이즈 표기). 사이즈 글자가 똑같은 후보가 정확히 하나일 때만 그것을 준다.
    """
    letters = size_letters(wanted or '')
    if not letters or size_numbers(wanted or ''):
        return []
    live = [o for o in options if not _sold_out(o)]
    same = [o for o in live if size_letters(o) == letters]
    return same if len(same) == 1 else []


def numeric_overlap_options(options: list[str], wanted: str | None) -> list[str]:
    """AI 옵션 매칭에 넘길 후보 — 품절이 아니고, 주문 옵션에 사이즈 숫자가 있으면 그 숫자가 하나라도 든 것만.

    주문 옵션에 사이즈 숫자가 없으면(예: '상아색 S') 품절 아닌 전부다. 숫자가 있는데 겹치는 후보가 없으면
    빈 목록 — AI 가 '가장 가까운 220' 을 230 주문에 고르는 사고를 코드로 막는다(실기).
    """
    live = [o for o in options if not _sold_out(o)]
    nums = size_numbers(wanted or '')
    if not nums:
        return live
    return [o for o in live if size_numbers(o) & nums]


def resolve_choice(choice: str, candidates: list[str]) -> str | None:
    """모델이 답한 옵션 글자를 후보 중 하나로 맞춘다 — 정확 → 공백 무시 → 정규화 → 하나만 포함.

    실기: 후보 'BLACK / ONE' 에 모델이 'BLACK, ONE' 이라 답해 멀쩡한 주문이 품절로 끝났다.
    """
    c = choice.strip()
    if c in candidates:
        return c
    for o in candidates:
        if o.strip() == c:
            return o
    nc = _norm(c)
    if not nc:
        return None
    same = [o for o in candidates if _norm(o) == nc]
    if len(same) == 1:
        return same[0]
    contains = [o for o in candidates if _norm(o) and (nc in _norm(o) or _norm(o) in nc)]
    return contains[0] if len(contains) == 1 else None


# 품절 표시: "[품절]"·끝의 "품절"·"(품절)". "품절임박"(재고 적음)은 품절이 아니다(실기: 롯데온)
_SOLD_OUT_RE = re.compile(r'\[품절\]|품절(?!임박)')


def _sold_out(option: str) -> bool:
    return _SOLD_OUT_RE.search(option) is not None


def snapshot_args(agent_name: str, order: OrderRef, account: str | None = None) -> str:
    """run_script 에 넘길 JSON 문자열. 옵션이 있으면 size 로, 계정이 있으면 account 로 같이 준다.

    account 를 주면 주문의 계정 대신 그 계정으로 돈다(계정 비교 중 각 계정의 견적).
    """
    args: dict[str, object] = {'sku': product_ref(agent_name, order), 'qty': order.qty}
    if order.option:
        args['size'] = order.option
    account = account or order.account
    if account:
        # 계정별 탭 프로필 — 세션(쿠키)이 계정마다 따로라 다른 계정으로 로그인된 채 사는 일이 없다
        args['account'] = account
        args['profile'] = account
    return json.dumps(args, ensure_ascii=False)


def _int_ids(values: list[object]) -> list[int]:
    """요소 번호 목록 — 정수 또는 숫자 문자열만 남긴다."""
    out: list[int] = []
    for v in values:
        if isinstance(v, bool):
            continue
        if isinstance(v, int):
            out.append(v)
        elif isinstance(v, str) and v.strip().isdigit():
            out.append(int(v.strip()))
    return out


def _as_float(value: object) -> float:
    """스냅샷 금액 → float. 비었거나 숫자가 아니면 0(모름)."""
    try:
        return float(value or 0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def shipping_set_problem(shipping: dict[str, object]) -> Callable[[dict[str, object]], str | None]:
    """배송지 입력 검증: 되읽은 이름·주소가 같고 전화 칸 번호(1~3개)를 알려야 통과."""

    def check(out: dict[str, object]) -> str | None:
        if not shipping_matches(shipping, out):
            return '입력 후 되읽은 이름·주소가 다르다'
        raw = out.get('phone_field_ids')
        ids = _int_ids(raw) if isinstance(raw, list) else _int_ids([out.get('phone_field_id')])
        if not 1 <= len(ids) <= 3:
            return '전화 칸 요소 번호(phone_field_id 또는 phone_field_ids)를 돌려주지 않았다'
        return None

    return check


def _quote_rows_brief(rows: list[object]) -> str:
    """걸러진 견적 줄 요약(수단/카드/금액/가능 여부) — 왜 결제 가능한 수단이 없었는지 나중에 볼 수 있게 남긴다."""
    out = []
    for r in rows[:8]:
        if isinstance(r, dict):
            flags = ','.join(k for k in ('available', 'allowed', 'registered') if r.get(k) is False)
            out.append(f"{r.get('method')}/{r.get('card')}/{r.get('cost')}{'/X:' + flags if flags else ''}")
    return '; '.join(out)[:300]


def quotes_problem(
    out: dict[str, object], offered: list[str], allowed: set[str] | None, direct_card: str | None = None
) -> str | None:
    """결제수단 견적 검사 — 허용 수단으로 실제 낼 수 있는 줄이 있어야 하고, 주문서에 무신사머니가 있으면 그 줄도 있어야 한다.

    실기: 29CM 견적이 무신사 삼성카드 즉시할인 줄뿐이라 결제 가능한 수단이 없었다(빈 목록만 보던 검사가 통과시켰다).
    """
    rows = out.get('quotes')
    if not isinstance(rows, list) or not rows:
        return f'견적 목록(quotes)이 비었다: note={out.get("note")}'
    if any('머니' in m for m in offered) and not any(
        isinstance(r, dict)
        and '머니' in str(r.get('method') or '')
        and _as_float(r.get('cost')) > 0
        for r in rows
    ):
        return '주문서에 무신사머니가 있는데 무신사머니 줄(method 무신사머니, cost)이 없다 — 무신사머니를 골라 금액·적립을 읽어라'
    if not cheapest_quotes(rows, None, allowed, direct_card=direct_card):
        return f'허용 수단({sorted(allowed or [])})으로 낼 수 있는 견적 줄이 없다 — 가능한 수단마다 cost 를 읽어라'
    return None


def pay_card_quote_problem(out: dict[str, object]) -> str | None:
    """무신사페이 기본 카드 견적 검사 — 카드 이름과 금액이 있어야 한다(실기: 카드 [] 인데 통과)."""
    rows = out.get('quotes')
    note = str(out.get('note') or '')
    if not rows and (out.get('cards') == [] or re.search(r'no registered card|등록(된)? ?카드 ?없', note, re.IGNORECASE)):
        # 무신사페이에 등록 카드가 없는 계정 — 실제로 그렇다(수리해도 genuine). 견적 줄 없이 넘어간다
        # (실기 2026-09-25: buyer05 에서 작업마다 수리를 돌렸다)
        return None
    if not out.get('ok') or not isinstance(rows, list) or not rows:
        return f'무신사페이 기본 카드 견적 없음(note={out.get("note")})'
    first = rows[0] if isinstance(rows[0], dict) else {}
    if not str(first.get('card') or '').strip() or _as_float(first.get('cost')) <= 0:
        return '무신사페이 등록 기본 카드 이름(card)이나 결제 금액(cost)을 못 읽었다 — 무신사페이 선택 후 카드 목록 맨 앞 카드를 읽어라'
    return None


# 주문서·결제 탭(과 그 팝업)만 닫는다. 다른 레인 탭(lane 표시)은 건드리지 않는다. SSG 주문서는 pay.ssg.com/order/ordPage.ssg, 패션플러스는 /order/<번호>,
# H몰은 hmall.com/mo/oda/order
_CLOSE_ORDER_TABS_JS = (
    "for (const t of await tabs.list()) { if (!t.lane && /order\\/order-form|order\\/checkout|order\\/orderform|pay\\.ssg\\.com\\/order|fashionplus\\.co\\.kr\\/order\\/\\d+|hmall\\.com\\/mo\\/oda\\/order/.test(t.url || '')) "
    '{ try { await tabs.close(t.id) } catch (e) {} } } return "ok"'
)
# 레인 보기에서는 제 레인이 연 탭만 보인다 — 전부 닫으면 그 레인 탭만 닫힌다
_CLOSE_LANE_TABS_JS = (
    'for (const t of await tabs.list()) { try { await tabs.close(t.id) } catch (e) {} } return "ok"'
)


def prep_screen_mismatch(o: dict[str, object]) -> str | None:
    """주문서 정돈 결과가 화면과 어긋나면 그 사유. 화면 값(discount·points_box)이 없으면 대조하지 않는다.

    - 상품 쿠폰을 적용했다는데 쿠폰 버튼이 여전히 '쿠폰 사용'이거나, 보고한 쿠폰 합계가 화면 할인 금액보다 크다
    - 보유 적립금 5만원 이상인데 '보유 적립금 사용'이 0원(규칙: 최대 사용)
    """
    coupon = _as_float(o.get('coupon'))
    cart = o.get('cart_coupon')
    cart_v = _as_float(cart) if not isinstance(cart, str) else 0.0
    discount = o.get('discount')
    if coupon > 0 and o.get('coupon_button') == '쿠폰 사용':
        return (
            f'상품 쿠폰 {coupon:,.0f}원을 적용했다고 했지만 주문서 쿠폰 버튼이 "쿠폰 사용" 그대로다 — '
            '쿠폰 시트에서 쿠폰을 고른 뒤 "적용하기"(page.idOf 로 찾는다 — 전체 트리에 안 나올 수 있다)를 눌러 '
            '버튼이 "쿠폰 적용 중"으로 바뀌는 것을 확인하라'
        )
    if discount is not None and coupon + cart_v > _as_float(discount) + 100:
        return (
            f'보고한 쿠폰 합계 {coupon + cart_v:,.0f}원이 화면 할인 금액 {_as_float(discount):,.0f}원보다 크다 — '
            '쿠폰이 실제로 적용되지 않았다'
        )
    balance = _as_float(o.get('points_balance'))
    box = o.get('points_box')
    limit = _as_float(o.get('points_limit'))
    if box is not None and balance >= 50000 and limit > 0 and _as_float(box) <= 0:
        return (
            f'보유 적립금 {balance:,.0f}원(5만원 이상)인데 보유 적립금 사용이 0원이다 — "최대 사용"을 눌러 '
            f'한도({limit:,.0f}원)까지 써라'
        )
    return None


def own_snapshot_problem(snap: dict[str, object]) -> str | None:
    """교차 비교에서 이 사이트 스냅샷을 비교에 쓸 수 없는 사유(스크립트 오류·원가 0). 쓸 수 있으면 None."""
    if snap.get('error'):
        return f'{snap.get("error")}: {str(snap.get("note") or "")[:60]}'
    if _as_float(snap.get('cost')) <= 0:
        return f'원가 못 읽음({str(snap.get("note") or "")[:60]})'
    return None


def snapshot_login_required(out: dict[str, object]) -> bool:
    """스냅샷이 '이 계정 프로필은 로그인이 안 돼 있다'고 알렸는가."""
    return out.get('error') == 'login_required' or (
        out.get('error') == 'no_checkout' and '로그인' in str(out.get('note') or '')
    )


# 사이트가 이 계정의 구매 수량 한도를 알린 대화상자(실기 2026-09-27 무신사: 같은 가방을 7일에 3개 산 계정 —
# '최대 구매수량을 이미 구매하셨으므로 더 이상 구매하실 수 없습니다 … 구매가능일 : 2026-10-01'). 주문서가 안 열려
# selected 가 비어 '주문서 옵션 불일치(모름)' 으로 보였다
_PURCHASE_LIMIT_RE = re.compile(r'최대 ?구매 ?수량|구매 ?한도|더 이상 구매하실 수 없')
# 구매 수량 한도 실패 문구 머리 — 계정 사유(다른 계정은 살 수 있다)로 가른다
PURCHASE_LIMIT = '구매 수량 한도 초과'


def snapshot_purchase_limit(out: dict[str, object]) -> str | None:
    """스냅샷 중 사이트가 '이 계정은 구매 수량 한도에 걸렸다'고 알렸으면 그 요약, 아니면 None."""
    dialogs = out.get(PAGE_DIALOGS_KEY)
    for d in dialogs if isinstance(dialogs, list) else []:
        text = str(d)
        if not _PURCHASE_LIMIT_RE.search(text):
            continue
        rule = re.search(r'(\d+)\s*일\s*동안\s*최대\s*(\d+)\s*개', text)
        until = re.search(r'구매\s*가능일\s*[:：]\s*([\d.-]+)', text)
        parts = [
            f'{rule.group(1)}일 최대 {rule.group(2)}개' if rule else '',
            f'구매가능일 {until.group(1)}' if until else '',
        ]
        detail = ', '.join(p for p in parts if p)
        return f'{PURCHASE_LIMIT}({detail})' if detail else PURCHASE_LIMIT
    return None


# 확정 품절(모든 계정에서 선택지는 읽혔는데 주문 사이즈가 없다) 실패 문구 머리 — 감독자가 재시도하지 않는다
CONFIRMED_SOLD_OUT = '확정 품절'


def sold_out_option_matches(options: list[str], wanted: str | None) -> list[str]:
    """선택지 중 '품절' 표시가 붙은 주문 옵션 항목(원문). 목록에 아예 없는 옵션은 품절 확증이 아니라 빈 목록이다."""
    if not wanted:
        return []
    marked = {o: _SOLD_OUT_RE.sub('', o).strip() for o in options if _sold_out(o)}
    hits = set(matching_options(list(marked.values()), wanted))
    return [o for o, bare in marked.items() if bare in hits]


def sold_out_option_listed(options: list[str], wanted: str | None) -> bool:
    """주문 옵션이 선택지에 '품절' 표시로 떠 있는가 — 스크립트가 목록을 제대로 읽었고 그 옵션만 품절이라는 확증."""
    return bool(sold_out_option_matches(options, wanted))


def order_qty_problem(want: int, snap: dict[str, object]) -> str | None:
    """주문서가 열린 스냅샷의 수량이 주문 수량과 다르면 그 사유, 같거나 주문서가 없으면 None.

    실기 2026-09-30: 스크립트가 수량을 무시해 2개 주문에 1개만 결제했다. 수량 2개 이상은 주문서 수량(qty)을
    읽어 온 경우에만 산다 — 1개 주문은 스크립트 기본이 1개라 그대로 둔다.
    """
    if want <= 1 or not (snap.get('order_tab') or snap.get('cost')):
        return None
    try:
        got = int(str(snap.get('qty') or 0))
    except ValueError:
        got = 0
    if got == want:
        return None
    return f'주문서 수량 {got or "확인 안 됨"}개 ≠ 주문 수량 {want}개 — 결제하지 않는다'


def single_item_ok(option: str | None, snap: dict[str, object]) -> bool:
    """선택란 없는 단일 상품으로 봐도 되는가 — 주문서가 열렸고(원가 있음) 주문 옵션이 프리사이즈이며,
    색상 등 나머지 글자가 있으면 그중 하나가 상품명에 있다."""
    if not option or not snap.get('order_tab') or _as_float(snap.get('cost')) <= 0:
        return False
    if not _is_free_size(option):
        return False
    name = str(snap.get('product_name') or '').lower()
    rest = [t for t in re.split(r'[\s()/·,\[\]]+', option.lower()) if t and t not in _FREE_SIZE_TOKENS]
    return not rest or any(t in name for t in rest)


# SSG 장바구니 — 바로구매 전에 한 번 열어 기본 배송지를 불러오게 한다(_warm_ssg_cart)
SSG_CART_URL = 'https://pay.ssg.com/cart/dmsShpp.ssg'


# 계정 견적 건너뜀 사유 중 확정 품절 표시(_quote 가 붙인다)
SOLD_OUT_LISTED_SKIP = '주문 옵션 품절 표시'


# 계정 견적 건너뜀 사유 중 상품 전체 품절 표시(_quote 가 붙인다)
SOLD_OUT_PRODUCT_SKIP = '상품 전체 품절 표시'


def snapshot_sold_out(out: dict[str, object]) -> bool:
    """스냅샷이 '상품 전체가 품절(SOLD OUT)'이라고 알렸는가 — sold_out 이 정확히 True 이고 선택지가 하나도 없을 때만.

    패션플러스는 품절 옵션이 목록에서 빠지고 상품에 SOLD OUT 표시만 남는다(2026-09-27). 선택지가 하나라도
    읽혔으면 이 확증으로 보지 않는다(주문 옵션만 없을 수 있다 — 그건 옵션 대조가 가른다).
    """
    return out.get('sold_out') is True and not out.get('options')


def is_confirmed_sold_out_skip(skip: str) -> bool:
    """계정 견적 건너뜀 사유가 '주문 옵션이 품절 표시로 떠 있다'·'상품 전체 품절 표시'인가."""
    return SOLD_OUT_LISTED_SKIP in skip or SOLD_OUT_PRODUCT_SKIP in skip


# 계정 견적 건너뜀 사유 중 '이 계정은 허용 결제수단의 결제 항목이 없다'(_quote 가 붙인다) — 계정 사유
UNPAYABLE_SKIP = '결제 가능한 수단 없음'

# 계정 견적 건너뜀 사유 중 '이 계정의 주문서를 못 읽었다'(_quote 가 붙인다) — 다음 계정은 열릴 수 있다(계정 사유)
ORDER_FORM_UNREADABLE_SKIP = '주문서 옵션 못 읽음'


def is_account_failure(e: AgentFailure) -> bool:
    """계정 견적 실패가 그 계정만의 사유인가(구매 수량 한도·로그인 안 됨/실패·다른 계정 로그인·결제 항목 없음).

    그러면 같은 상품을 다른 계정으로는 살 수 있다 — 다음 계정으로 잇는다.
    """
    return PURCHASE_LIMIT in e.reason or e.fail_reason in (
        FailReason.PERMISSION_DENIED,
        FailReason.CARD_MISSING,
    )


def snapshot_problem(
    option: str | None, selected_ok: Callable[[str], bool] | None = None
) -> Callable[[dict[str, object]], str | None]:
    """상품 스냅샷 검증: 원가를 읽었고 주문 옵션과 맞는 선택지가 있고, 주문서에 실제로 담긴 옵션(selected)이
    주문 옵션과 같아야 통과. 중복 구매 흔적은 그대로 통과.

    실기: 선택지 목록에는 110 이 있었는데 이름이 한 칸 밀려 주문서엔 105 가 담겼다(무신사 데상트) — 목록만 보면 못 잡는다.
    """

    def check(out: dict[str, object]) -> str | None:
        if out.get('already_ordered') or out.get('existing_order_no'):
            return None
        # 로그인 안 된 계정 — 스크립트 잘못이 아니다(고치게 두면 다른 세션으로 넘어가 견적한다). 호출부가 그 계정을 뺀다
        if snapshot_login_required(out):
            return None
        # 사이트가 구매 수량 한도를 알렸다 — 이 계정은 못 산다. 스크립트 잘못이 아니니 고치지 않는다
        if snapshot_purchase_limit(out):
            return None
        # 지정 몰(SSG 신세계몰)이 아닌 상품 — 스크립트가 규칙대로 멈췄다. 호출부가 그 몰의 같은 상품을 찾는다.
        # 봇 차단도 스크립트 잘못이 아니다 — 호출부가 사람에게 넘긴다
        if out.get('error') in (NOT_MALL_ERROR, BLOCKED_ERROR):
            return None
        # 다나와 진입 실패(제휴 없음·링크 없음·다른 상품) — 고칠 스크립트가 아니다. 호출부가 사람에게 넘긴다
        if out.get('error') in ENTRY_ERRORS:
            return None
        # 주문 옵션이 '품절' 표시로 떠 있다 = 품절이다. 사이즈를 못 골라 selected·원가가 비는 게 당연하다 —
        # 스크립트 잘못이 아니니 고치지 않는다(실기 2026-09-26: 품절 주문마다 계정 4개가 AI 수리를 돌아 1건에 10~20분)
        if option and sold_out_option_listed([str(o) for o in (out.get('options') or [])], option):  # type: ignore[union-attr]
            return None
        # 상품 전체 품절(SOLD OUT, 선택지 0개) — 고칠 스크립트가 없다. 호출부가 확정 품절로 끝낸다
        if snapshot_sold_out(out):
            return None
        if option:
            sel = str(out.get('selected') or '').strip()
            if not sel:
                return (
                    '주문서에 실제로 담긴 옵션(selected)을 돌려주지 않았다 — 주문서의 상품 옵션 글자를 읽어 '
                    'selected 로 돌려줘라'
                )
            if selected_ok is not None and not selected_ok(sel):
                return f'주문서에 담긴 옵션 "{sel}" 이 주문 옵션 "{option}" 과 다르다 — 옵션을 잘못 골랐다'

        options = [str(o) for o in (out.get('options') or [])]  # type: ignore[union-attr]
        # 표기만 다른 옵션(7 1/8 ↔ 718(56.8cm))은 하네스가 AI 로 맞춘다 — 스크립트 수리 대상이 아니다
        if (
            option
            and not matching_options(options, option)
            and not numeric_overlap_options(options, option)
        ):
            return f'주문 옵션 "{option}" 과 맞는 선택지가 없다(읽은 선택지 {options[:8]}, note={out.get("note")})'
        if _as_float(out.get('cost')) <= 0:
            return f'원가(cost)를 못 읽음(note={out.get("note")})'
        if not out.get('methods'):
            # 결제수단을 안 읽으면 '허용 수단 없음'으로 멈춘다(실기: 29CM 주문서엔 무신사머니·무신사페이가 있는데 [] 로 읽음)
            return (
                '주문서의 결제수단 목록(methods)을 돌려주지 않았다 — 주문서 결제수단 영역에서 '
                '무신사머니·무신사페이·토스페이·카카오페이·페이코 등 보이는 이름을 methods 로 돌려줘라'
            )
        return None

    return check


def probe_snapshot_problem(
    option: str | None, base: Callable[[dict[str, object]], str | None]
) -> Callable[[dict[str, object]], str | None]:
    """후보 시험(신세계몰 같은 상품 후보·진입 경로) 스냅샷 검사. 선택지는 읽었는데 주문 옵션이 없으면 통과시킨다 —
    그 후보에 없는 옵션일 뿐 스크립트 잘못이 아니다(고치게 두면 후보마다 AI 수리가 돈다). 나머지는 base 그대로.
    """

    def check(out: dict[str, object]) -> str | None:
        options = [str(o) for o in (out.get('options') or [])]  # type: ignore[union-attr]
        if (
            option
            and options
            and not matching_options(options, option)
            and not numeric_overlap_options(options, option)
        ):
            return None
        return base(out)

    return check


def parse_account_labels(raw: str) -> tuple[list[str], bool]:
    """앱 list_accounts 결과 → (계정 라벨 목록, 금고 잠김 여부).

    앱은 풀린 금고면 계정 배열을, 잠겼으면 {"vaultLocked": true, "accounts": [...]} 를,
    그 밖(호스트 모름·금고 미설정)은 {"accounts": [], "note": ...} 나 안내 문자열을 준다
    (src/main/agent/tools.ts list_accounts). 라벨은 우리 사이트에서 로그인 아이디와 같다.
    """
    body, _ = split_page_dialogs(raw)
    try:
        parsed = json.loads(body)
    except ValueError:
        return [], False
    locked = False
    items: object = parsed
    if isinstance(parsed, dict):
        locked = bool(parsed.get('vaultLocked'))
        items = parsed.get('accounts') or []
    labels: list[str] = []
    if isinstance(items, list):
        for item in items:
            label = str(item.get('label') or '').strip() if isinstance(item, dict) else ''
            if label and label not in labels:
                labels.append(label)
    return labels, locked


# 로그인 확인은 소싱처 첫 페이지(sources.yaml 의 home)에서 시작한다. 앱의 login 도구는 폼이 없으면
# 이미 로그인됐는지 보고, 아니면 알려진 로그인 URL(shared/site-rules)로 스스로 옮겨 간다 —
# 여기서 로그인 URL 을 알 필요가 없다
# 앱 login 도구의 결과 문자열 머리(src/main/agent/tools.ts)
ALREADY_SIGNED_IN = 'already signed in'
LOGIN_SUBMITTED = 'submitted'
# 페이지 이동·로그인 제출 뒤 화면이 안정되길 기다리는 시간
_LOGIN_SETTLE_MS = 2500
# 앱이 바빠 탭이 덜 떴을 때 login 도구가 돌려주는 일시 오류 — 다시 열어 재시도한다
_LOGIN_BUSY_WORDS = ('host unknown', 'page did not respond')
# 앱 로그인 도구가 로그인 상태도 입력칸도 못 찾았을 때의 응답 머리
LOGIN_FIELDS_NOT_FOUND = 'fields not found'
# 같은 소싱처에서 다른 계정으로 로그인을 이어 갈 때의 최소 간격(초). 연달아 바꾸면 사이트가 차단한다(실기: SSG)
_ACCOUNT_SWITCH_GAP_S = 60.0


# 주문의 배송지를 앱에서 실행 시점에 읽어오는 전역 스크립트(소싱처 무관 — 주문 관리 쪽 데이터)
SHIPPING_SCRIPT = 'samba_order_shipping'

# 되읽어 대조하는 배송지 필드 — 전부 개인정보라 어디에도 원문을 남기지 않는다.
# 전화는 하네스가 아예 다루지 않는다(앱이 키마스터 신원정보로 채운다)
SHIPPING_FIELDS = ('name', 'address')

# 배송지 스크립트에 넘기는 키. phone 키는 어떤 출처에서 와도 넣지 않는다 — 고객 전화번호는
# 어디에도 입력하지 않는다(사용자 결정 2026-09-23)
SHIPPING_ARG_FIELDS = ('name', 'address', 'address_detail', 'postal_code')

# 배송 연락처 — 앱 fill_secret 이 키마스터 신원정보의 이 필드로 전화 칸을 채운다
PHONE_SECRET_ITEM = 'identity'
PHONE_SECRET_FIELD = 'identity.phone'
# 앱 fill_secret 이 아는 전화 형식(src/main/agent/tools.ts FILL_FORMATS)
PHONE_FILL_FORMATS = ('phone-first', 'phone-mid', 'phone-last', 'phone-rest', 'digits')

# 까대기 주문서에서 기본 배송지가 채워졌는지 get_page 로 볼 때 쓰는 표시.
# 수령인 라벨이 있고 '배송지 없음' 류 문구가 없으면 채워진 것으로 본다
RECIPIENT_MARKERS = ('받는 분', '받는분', '받으시는 분', '수령인', '수취인')
EMPTY_SHIPPING_MARKERS = (
    '배송지를 입력',
    '배송지를 등록',
    '배송지를 추가',
    '등록된 배송지가 없',
    '배송지가 없습니다',
)

# dry_run 이면 구매 에이전트가 절대 부르지 않는 부수효과 도구(허용 목록에 있어도 막는다).
# save_script 는 뺐다 — 결제 없는 검증 실행에서 AI 가 고친 스크립트도 남아야 검증이 쌓인다(사용자 2026-09-24 전면 재검증)
DRY_RUN_BLOCKED_TOOLS = frozenset(
    {
        'update_playbook',
        'remember_site',
        'phone_approve_payment',
        'phone_tap',
        'phone_type',
        'phone_key',
        'phone_swipe',
    }
)


class BuyerAgent(AgentBase):
    """등록부의 buyer.* 한 행에 대응한다."""

    _dry_run: bool = True
    # 배송지 공급자(삼바웨이브 상세). 없으면 스냅샷·전용 스크립트로 받는다
    _shipping_fn: 'ShippingFn | None' = None
    # 계정 비교 상한(SAMBA_COMPARE_ACCOUNTS_MAX). 배선은 factory 가 한다
    compare_accounts_max: int = 3
    # 결제에 쓸 수 있는 결제 제공자(SAMBA_ALLOWED_PAY_PROVIDERS). None 이면 키마스터에 있는 것 전부
    allowed_pay_providers: set[str] | None = None
    # 같은 상품을 같이 비교할 다른 소싱처의 구매 에이전트(무신사 ↔ 29CM). factory 가 잇는다
    sibling: 'BuyerAgent | None' = None
    # 계정 비교를 레인으로 동시에 돌린다(앱이 레인을 알 때만 main 이 켠다)
    parallel_accounts: bool = False
    # (계정, 시각) — 같은 사이트에서 마지막으로 로그인한 계정
    _last_login: tuple[str, float] | None = None
    _order_type_noted: tuple[str, str] | None = None
    # 주문번호 → 받는 곳이 라자다 배대지인가(삼바웨이브 배송지를 한 번만 본다)
    _forwarder_seen: dict[str, bool] | None = None

    def __call__(self, assignment: Assignment) -> AgentResult:
        self._dry_run = assignment.dry_run
        # 계정 비교 중 견적이 실패한 사유들(모든 계정 실패 때 결과 판정에 쓴다)
        self._quote_errors: list[AgentFailure] = []
        self._option_ai: dict[tuple[str, tuple[str, ...]], list[str]] = {}
        self.reset_repairs()
        return run_agent(lambda: self._buy(assignment), lambda: self.evidence)

    def tool(self, name: str, /, **args: object) -> str:
        """dry_run 이면 부수효과 도구는 허용 목록에 있어도 아예 부르지 않는다(불변조건)."""
        if self._dry_run and name in DRY_RUN_BLOCKED_TOOLS:
            raise AgentFailure(
                'fail',
                f'dry_run 에서는 부수효과 도구를 부르지 않는다: {name}',
                FailReason.PERMISSION_DENIED,
            )
        return super().tool(name, **args)

    def _home(self) -> str:
        """소싱처 첫 페이지 — 로그인 확인·계정 목록 조회를 여기서 시작한다."""
        home = source_of(self.spec.name).home
        if not home:
            raise AgentFailure(
                'needs_human',
                f'소싱처 첫 페이지 주소가 표에 없다: {self.spec.name}',
                FailReason.UNKNOWN,
            )
        return home

    def _login_as(self, account: str) -> None:
        """그 소싱 계정으로 로그인돼 있게 한다(실기: 로그인 안 된 채 스냅샷 → 주문서 대신 로그인 페이지).

        앱 login 도구는 이미 로그인돼 있으면 누구인지까지는 말해 주지 않는다 — 계정 일치는
        스냅샷의 account 로 한 번 더 본다(_check_account).

        확인에 쓴 홈 탭은 끝나면 닫는다 — 스냅샷 스크립트가 상품·주문서 탭을 따로 열어 계정마다 탭이
        둘씩 남았다(사용자 2026-09-28: 같은 사이트·같은 계정 탭이 중복으로 떠 리소스를 먹는다).
        """
        opened: list[str] = []
        try:
            self._login_check(account, opened)
        finally:
            for tab_id in opened:
                try:
                    self.tool('close_tab', id=tab_id)
                except AgentFailure:
                    pass  # 이미 닫혔거나 못 닫아도 로그인 결과는 바꾸지 않는다

    def _open_home(self, account: str, opened: list[str]) -> None:
        """계정 프로필로 홈 탭을 열고 그 탭 id 를 적어 둔다(끝나면 닫는다)."""
        out = self.tool('new_tab', url=self._home(), profile=account)
        m = re.search(r'tab ([0-9a-fA-F-]{8,})', out)
        if m:
            opened.append(m.group(1))

    def _login_check(self, account: str, opened: list[str]) -> None:
        self.step(f'{self.spec.name}: 로그인 확인({account})')
        # 같은 사이트에서 직전에 다른 계정으로 로그인했으면 간격을 둔다(연달아 바꾸면 차단)
        last = self._last_login
        # 프로필 탭으로 계정을 나누는 소싱처(buy_accounts)는 로그아웃·재로그인이 없어 간격이 필요 없다
        if last is not None and last[0] != account and not source_of(self.spec.name).buy_accounts:
            gap = _ACCOUNT_SWITCH_GAP_S - (time.monotonic() - last[1])
            if gap > 0:
                self.note('계정 전환', f'차단 방지 대기 {int(gap)}초')
                self.tool('wait', ms=int(gap * 1000))
        self._last_login = (account, time.monotonic())
        # 계정 이름의 프로필로 탭을 연다 — 저장 스크립트도 같은 profile 인자를 받아 그 세션에서 돈다
        self._open_home(account, opened)
        self.tool('wait', ms=_LOGIN_SETTLE_MS)
        out = self.tool('login', accountLabel=account).strip()
        # 계정 여럿을 동시에 돌려 앱이 바쁠 때 홈이 다 뜨기 전에 불리면 로그인 상태도 입력칸도 못 본다
        # (실기 2026-09-26: 로그인된 계정 4개가 모두 'fields not found'. 2026-09-28: 'host unknown'·
        # 'page did not respond' 로 6계정 전부 실패). 홈을 다시 열고 기다림을 늘려 두 번까지 다시 본다
        for retry in (1, 2):
            if not (out.startswith(LOGIN_FIELDS_NOT_FOUND) or any(w in out for w in _LOGIN_BUSY_WORDS)):
                break
            self.note('로그인', f'{account}: 페이지가 덜 떠 다시 시도({retry}/2)')
            # 탭을 새로 열면 같은 로딩을 또 기다린다(실측 2026-09-28: 병렬 첫 호출 7~20초, 둘째 호출 0.7초).
            # 응답이 없었던 경우는 그 탭이 떠 가는 중이니 그대로 다시 부르고, 탭 자체가 없을 때만 새로 연다
            if not out.startswith('error: page did not respond'):
                self._open_home(account, opened)
            self.tool('wait', ms=_LOGIN_SETTLE_MS * 2 * retry)
            out = self.tool('login', accountLabel=account).strip()
        if out.startswith(ALREADY_SIGNED_IN):
            self.note('로그인', '이미 로그인돼 있음')
            return
        if out.startswith(LOGIN_SUBMITTED):
            self.tool('wait', ms=_LOGIN_SETTLE_MS)
            out = self.tool('login', accountLabel=account).strip()
            if out.startswith(ALREADY_SIGNED_IN):
                self.note('로그인', f'{account} 로 로그인 완료')
                return
        if source_of(self.spec.name).signed_in_check and self._site_signed_in(account):
            self.note('로그인', f'{account} — 사이트 로그인 확인 스크립트로 로그인됨 확인')
            return
        raise AgentFailure(
            'needs_human',
            f'로그인 실패({account}): {mask_text(out[:120])}',
            FailReason.PERMISSION_DENIED,
        )

    def _site_signed_in(self, account: str) -> bool:
        """사이트별 로그인 확인 스크립트(`<key>_signed_in`)가 있으면 그것으로 다시 본다.

        로그인해도 상단에 '로그인' 링크가 남는 사이트(슈마커)는 앱의 공통 판정이 로그인 전으로 본다(실기 2026-09-26).
        스크립트가 없거나 실패하면 False — 원래대로 로그인 실패로 넘긴다.
        """
        try:
            raw = self.tool(
                'run_script',
                name=f'{source_of(self.spec.name).key}_signed_in',
                args=json.dumps({'profile': account}, ensure_ascii=False),
            )
            out = json.loads(split_page_dialogs(raw)[0])
        except (AgentFailure, ValueError):
            return False
        return isinstance(out, dict) and out.get('signed_in') is True

    def _candidate_accounts(self, a: Assignment) -> list[str]:
        """구매 후보 계정. 주문이 계정을 지정하면 그 계정 하나(비교하지 않는다).

        지정이 없으면 기본 프로필로 소싱처 첫 페이지를 열고 키마스터의 그 사이트 계정 목록을 받는다
        (앱 list_accounts 는 현재 탭 호스트의 계정만 답한다). 비교 비용 때문에 앞에서부터
        최대 compare_accounts_max 개만 쓴다.
        """
        source = source_of(self.spec.name)
        if source.buy_accounts:
            # 비교 계정을 정해 둔 소싱처 — SAMBA 주문계정은 기록용일 뿐 구매 계정이 아니다(§5).
            # 순서(= 동률일 때 이기는 쪽)는 키마스터의 결제 우선순위가 먼저, 없으면 sources.yaml 순서
            ordered = self._by_pay_priority(source, list(source.buy_accounts))
            self.note('계정 후보', f'{source.id}: 비교 계정 {ordered}')
            return ordered
        requested = str(a.options.get('account') or '').strip()
        if requested:
            # 작업 옵션으로 사람이 계정을 정한 주문만 그 계정 하나로 산다
            return [requested]
        # 삼바웨이브 주문계정(a.order.account)은 기록용이다 — 구매 계정은 키마스터 우선순위로 고른다
        # (실기 2026-09-28: 패션플러스 우선순위 1 은 buyer01 인데 주문계정 buyer03 으로 샀다)
        if not source.compare_accounts:
            # 계정 전환이 차단을 부르는 사이트 — 첫 계정 하나로만 산다
            labels, locked = self._first_account(source)
            self.note('계정 후보', f'{source.id}: 계정 비교 없음(전환 차단 방지) — {labels[0]}')
            return labels[:1]
        home = self._home()
        host = source.login_host or urlparse(home).hostname or ''
        self.step(f'{self.spec.name}: 계정 목록 확인')
        self.tool('new_tab', url=home)
        self.tool('wait', ms=_LOGIN_SETTLE_MS)
        listed = self.tool('list_accounts', host=host)
        labels, locked = parse_account_labels(listed)
        if locked or not labels:
            raise AgentFailure(
                'needs_human',
                f'소싱처 계정 없음/금고 잠김: {source.id}',
                FailReason.PERMISSION_DENIED,
            )
        # 동률이면 앞 계정이 이긴다 — 키마스터 결제 우선순위(1 = 먼저) 순으로 세운다
        # (실기 2026-09-25: 29CM 세 계정 원가가 같은데 목록 첫째 buyer02 를 골랐다. 우선순위는 buyer01)
        ranks = parse_account_priorities(listed)
        if ranks:
            big = 10**6
            labels = sorted(labels, key=lambda acc: (ranks.get(acc, big), labels.index(acc)))
        cap = self.compare_accounts_max
        if len(labels) > cap:
            self.note(
                '계정 후보', f'{len(labels)}개 중 앞 {cap}개만 비교(SAMBA_COMPARE_ACCOUNTS_MAX)'
            )
            labels = labels[:cap]
        return labels

    def _with_payable_accounts(self, source: Source, first: str) -> list[str]:
        """주문 계정 + 키마스터 결제 항목(payments)이 있는 같은 사이트 계정들(상한 compare_accounts_max).

        목록을 못 읽으면 주문 계정 하나로 간다.
        """
        home = self._home()
        host = source.login_host or urlparse(home).hostname or ''
        self.step(f'{self.spec.name}: 계정 목록 확인')
        self.tool('new_tab', url=home)
        self.tool('wait', ms=_LOGIN_SETTLE_MS)
        raw = self.tool('list_accounts', host=host)
        labels, _locked = parse_account_labels(raw)
        out = [first]
        for label in labels:
            if label == first or len(out) >= self.compare_accounts_max:
                continue
            payments = parse_account_payments(raw, label)
            if payments:
                out.append(label)
        if len(out) > 1:
            self.note('계정 후보', f'주문 계정 {first} + 결제 항목 있는 {out[1:]} 비교')
        return out

    def _by_pay_priority(self, source: Source, accounts: list[str]) -> list[str]:
        """키마스터 결제 우선순위(list_accounts 의 priority, 1 = 먼저) 순으로 정렬한다. 순위 없는 계정은 뒤(원래 순서).

        목록을 못 읽으면 원래 순서 그대로.
        """
        home = self._home()
        host = source.login_host or urlparse(home).hostname or ''
        try:
            self.tool('new_tab', url=home)
            self.tool('wait', ms=_LOGIN_SETTLE_MS)
            ranks = parse_account_priorities(self.tool('list_accounts', host=host))
        except AgentFailure:
            return accounts
        if not ranks:
            return accounts
        big = 10**6
        return sorted(accounts, key=lambda acc: (ranks.get(acc, big), accounts.index(acc)))

    def _first_account(self, source: Source) -> tuple[list[str], bool]:
        home = self._home()
        host = source.login_host or urlparse(home).hostname or ''
        self.tool('new_tab', url=home)
        self.tool('wait', ms=_LOGIN_SETTLE_MS)
        labels, locked = parse_account_labels(self.tool('list_accounts', host=host))
        if locked or not labels:
            raise AgentFailure(
                'needs_human',
                f'소싱처 계정 없음/금고 잠김: {source.id}',
                FailReason.PERMISSION_DENIED,
            )
        return labels, locked

    def _snapshot(self, a: Assignment, account: str) -> dict[str, object]:
        """그 계정의 스냅샷 — 주문서가 열렸으면 주문서 수량이 주문 수량과 같은지 본다(다르면 사지 않는다)."""
        snap = self._snapshot_any(a, account)
        problem = order_qty_problem(a.order.qty, snap)
        if problem:
            raise AgentFailure('fail', problem, FailReason.UNKNOWN)
        return snap

    def _warm_ssg_cart(self, account: str) -> None:
        """SSG — 상품 페이지 바로구매 전에 장바구니를 한 번 연다. 안 열면 배송지가 수십 개 있어도
        '배송지 정보가 없습니다' 알림으로 주문서가 안 열린다(실기 2026-09-30, 장바구니를 연 뒤엔 열림)."""
        profile = json.dumps(account, ensure_ascii=False) if account else 'undefined'
        code = (
            f"const r=await tabs.open({{profile:{profile},url:'{SSG_CART_URL}'}});"
            r"const id=(String(r).match(/tab (\S+)/)||[])[1];await sleep(4000);"
            "if(id){try{await tabs.close(id)}catch(e){}}return 'ok'"
        )
        try:
            self.tool('run_js', code=code, safety='no_pay')
        except AgentFailure as e:
            self.note('SSG 장바구니', mask_text(f'미리 열기 실패(계속): {e.reason[:60]}'))

    def _snapshot_any(self, a: Assignment, account: str) -> dict[str, object]:
        """그 계정의 탭 프로필에서 상품 스냅샷(주문서까지)을 만든다.

        지정 몰 상품(mall_item)·진입 경로 비교(route_compare)가 켜진 소싱처(SSG)는 그 흐름을 거친다.
        """
        source = source_of(self.spec.name)
        if source.key == 'ssg':
            self._warm_ssg_cart(account)
        if source.mall_item or source.route_compare:
            return self._mall_route_snapshot(a, account)
        if source.entry_route:
            first = self._snapshot_once(a, account, self._entry_extra(a, account))
            if ADPICK_ROUTE in (source.routes or []):
                return self._entry_vs_adpick(a, account, first)
            return first
        return self._snapshot_once(a, account)

    def _entry_vs_adpick(self, a: Assignment, account: str, first: dict[str, object]) -> dict[str, object]:
        """정해진 진입 경로(H몰 = 다나와) 주문서와 애드픽 적립 링크 주문서의 원가(결제액 − 적립)를 비교한다.

        사용자 2026-09-27: H몰·GS샵은 애드픽 적립을 받는다. 다나와 제휴할인과 애드픽 적립은 제휴코드가 달라
        함께 받을 수 없다 — 싼 쪽으로 산다. 애드픽 링크를 못 받거나 그 주문서를 못 쓰면 첫 경로로 산다.
        """
        if first.get('error') or first.get('already_ordered') or first.get('existing_order_no') or self._unusable(a, first):
            return first
        product_url = str(first.get('product_url') or a.order.product_url or '')
        link = self._adpick_link(product_url, account)
        if link is None:
            return first
        url, percent = link
        extra: dict[str, object] = {'route': ADPICK_ROUTE, 'entry_url': url, 'adpick_percent': percent}
        try:
            snap = self._snapshot_once(a, account, extra, probe=True)
        except AgentFailure as e:
            if e.fail_reason is FailReason.CAPTCHA:
                raise
            self.note('경로 비교', mask_text(f'애드픽: 불가({e.reason[:60]})'))
            return self._reenter(a, account, first)
        why = self._unusable(a, snap)
        if why:
            self.note('경로 비교', mask_text(f'애드픽: 불가({why})'))
            return self._reenter(a, account, first)
        snap['adpick_rate'] = percent
        route = str(source_of(self.spec.name).entry_route)
        c_first, c_adp = route_cost(first), route_cost(snap)
        self.note('경로 비교', f'{route} {c_first:,.0f} · 애드픽 {c_adp:,.0f}')
        # 결제액이 같거나 싸면 애드픽(적립은 원가 밖 수익)
        if c_adp > 0 and (c_first <= 0 or c_adp <= c_first):
            snap['route'] = ADPICK_ROUTE
            self._apply_adpick(snap)
            return snap
        # 첫 경로가 싸다 — 제휴코드는 마지막 진입이 덮어쓰므로 첫 경로로 다시 들어가 주문서를 새로 만든다
        return self._reenter(a, account, first)

    def _reenter(self, a: Assignment, account: str, first: dict[str, object]) -> dict[str, object]:
        """정해진 진입 경로로 다시 들어가 주문서를 새로 만든다(다른 경로가 제휴코드를 덮어썼을 수 있다)."""
        again = self._snapshot_once(a, account, self._entry_extra(a, account))
        why = self._unusable(a, again)
        if why:
            raise AgentFailure(
                'needs_human', mask_text(f'진입 경로로 다시 들어가 주문서를 못 만들었다: {why}'), FailReason.UNKNOWN
            )
        again['route'] = str(source_of(self.spec.name).entry_route)
        return again

    def _adpick_link(self, product_url: str, account: str) -> tuple[str, float] | None:
        """애드픽 적립 추적 링크와 적립률(%) — 그 계정 프로필의 애드픽 로그인으로 받는다. 못 받으면 None."""
        if not product_url.startswith('https://'):
            return None
        code = (
            f'return JSON.stringify(await affiliate.adpick({json.dumps(product_url)}, {json.dumps(account)}))'
        )
        try:
            raw = self.tool('run_js', code=code, safety='no_pay')
            out = json.loads(json.loads(raw)) if raw.startswith('"') else json.loads(raw)
        except (AgentFailure, ValueError, TypeError) as e:
            self.note('경로 비교', mask_text(f'애드픽 링크 못 받음({str(e)[:60]})'))
            return None
        url = str(out.get('trackinglink') or '') if isinstance(out, dict) else ''
        percent = _as_float(str(out.get('percent') or '').rstrip('%')) if isinstance(out, dict) else 0.0
        if not (out.get('ok') and url.startswith('https://') and percent > 0):
            self.note('경로 비교', mask_text(f'애드픽 링크 없음({str(out.get("note") if isinstance(out, dict) else out)[:60]})'))
            return None
        return url, percent

    def _entry_extra(self, a: Assignment, account: str) -> dict[str, object]:
        """진입 경로가 정해진 소싱처(H몰 = 다나와)의 스냅샷 인자 {route, entry_url}.

        교차 비교가 상품 찾기에서 받아 둔 이동 링크(options.entry_url)가 있으면 그것을, 없으면 `<key>_danawa_entry` 로 받는다.
        링크를 못 받으면 직접 들어가지 않는다 — AI 수리 없이 사람에게(사용자 2026-09-27: H몰은 반드시 다나와 경유).
        """
        source = source_of(self.spec.name)
        route = str(source.entry_route)
        known = str(a.options.get('entry_url') or '')
        if known.startswith('https://'):
            return {'route': route, 'entry_url': known}
        model = str(a.options.get('model') or '') or model_code_of(a.order.sku)
        pno = product_no_of(a.order.product_url) if _same_host(a.order.product_url or '', source.home) else ''
        args: dict[str, object] = {'model': model, 'name': a.order.sku, 'profile': account}
        if pno:
            args['slitmCd'] = pno
        self.step(f'{self.spec.name}: {route} 진입 링크({model or "모델코드 없음"})')
        try:
            out = self.json_tool('run_script', name=source.entry_script, args=json.dumps(args, ensure_ascii=False))
        except AgentFailure as e:
            raise AgentFailure(
                'needs_human', mask_text(f'{route} 진입 링크를 못 받았다 — 직접 진입하지 않는다: {e.reason[:80]}'), FailReason.UNKNOWN
            ) from e
        url = str(out.get('entry_url') or '')
        if not out.get('ok') or not url.startswith('https://'):
            raise AgentFailure(
                'needs_human',
                mask_text(
                    f'{route} 경유 링크 없음({out.get("error") or "-"}: {str(out.get("note") or "")[:80]}) — '
                    '직접 진입하지 않는다, 사람이 확인한다'
                ),
                FailReason.UNKNOWN,
            )
        self.note('진입 경로', mask_text(f'{route}: {url[:120]}'))
        return {'route': route, 'entry_url': url}

    def _snapshot_once(
        self,
        a: Assignment,
        account: str,
        extra: dict[str, object] | None = None,
        probe: bool = False,
    ) -> dict[str, object]:
        """상품 스냅샷 한 번. extra 는 스냅샷 인자에 더할 값(진입 경로 route·entry_url 등).

        probe 면 후보 시험이다 — 선택지에 주문 옵션이 없어도 스크립트 수리를 돌리지 않는다.
        결제수단 견적은 여기서 하지 않는다 — 계정을 고른 뒤 한 번만(_buy).
        """
        source = source_of(self.spec.name)
        if source.coupon_download:
            self._download_coupons(a, account)
        self.step(f'{self.spec.name}: 상품 확인({account})')
        # 저장 스크립트는 "열린 주문서 탭"이 있으면 계정을 따지지 않고 그것을 쓴다 — 먼저 닫아 이 계정 주문서를 새로 만든다
        # (실기 2026-09-25: buyer03 견적 뒤 기본 세션(buyer01) 주문서로 결제됐다)
        self._close_order_tabs(account)
        args: dict[str, object] = json.loads(snapshot_args(self.spec.name, a.order, account=account))
        if source.allow_department:
            args['allow_department'] = True  # SSG: 신세계백화점(6009) 상품도 산다(사용자 2026-09-27)
        if source.required_seller:
            args['required_seller'] = source.required_seller  # 롯데온: 롯데백화점 판매 상품만(사용자 2026-09-27)
        if source.gift_unless_poison and not is_poison_seller(a.order.seller):
            args['gift'] = True  # 롯데온: 포이즌 외에는 '선물하기' 주문서로 들어간다(사용자 2026-09-27)
        args.update(extra or {})
        check = snapshot_problem(a.order.option, lambda sel: self._selected_matches(sel, a.order.option))
        base_check = probe_snapshot_problem(a.order.option, check) if probe else check
        goal = (
            f'상품 {a.order.sku} 페이지에서 주문 옵션 "{a.order.option or "(없음)"}" 을 골라 주문서(구매하기)까지 가서 '
            '원가(cost, 숫자)·선택지 목록(options, 고른 옵션 포함)·결제수단(methods)을 원래 키 그대로 돌려주고, '
            '주문서에 실제로 담긴 상품 옵션 글자를 selected 로 돌려준다(고른 버튼 이름이 아니라 주문서에서 되읽은 값). '
            '반드시 지킬 것: 옵션(사이즈·색상)을 실제로 고르지 못했으면 구매하기·바로구매 버튼을 절대 누르지 말고 '
            'options 만 돌려준다 — 옵션 없이 누르면 "옵션을 선택해 주세요" 경고창이 계정 수만큼 쏟아진다. '
            '구매 버튼은 옵션을 고른 뒤, 또는 옵션 선택창이 아예 없는 상품일 때만 누른다.'
        )

        def pick_failed(out: dict[str, object]) -> bool:
            # 선택지는 읽었는데 스크립트가 주문 옵션 글자로 못 골랐다(표기 차이: '화이트 S' ↔ 'White-SM')
            note = str(out.get('note') or '')
            return (
                bool(a.order.option)
                and not out.get('selected')
                and bool(out.get('options'))
                and note.startswith(('option ambiguous', 'option not matched', 'size not available'))
                # 색상이 안 맞는 것은 다시 열어도 같다 — 사이즈 글자로 다시 열면 다른 색을 사게 된다
                and '색상' not in note
            )

        snap = self.script_json(
            source.snapshot_script,
            args,
            goal=goal,
            check=lambda o: None if pick_failed(o) else base_check(o),
        )
        if pick_failed(snap):
            # 하네스의 옵션 매칭(규칙·AI)이 하나로 정하면 그 선택지 글자로 한 번만 다시 연다
            # (실기 2026-09-28: AI 가 White-SM 으로 맞췄는데 스크립트에는 계속 '화이트 S' 를 줬다)
            options = [str(o) for o in (snap.get('options') or [])]  # type: ignore[union-attr]
            live = [m for m in self._match_options(options, a.order.option) if '품절' not in m]
            if len(live) == 1 and live[0] != a.order.option:
                self.note('옵션 재선택', mask_text(f'[{a.order.option}] → [{live[0]}] 로 다시 연다'))
                reselected: dict[str, str] = getattr(self, '_reselected', {})
                reselected[str(a.order.option)] = live[0]
                self._reselected = reselected
                if snap.get('product_tab'):
                    self._close_product_tabs(account, str(snap.get('product_url') or ''))
                snap = self.script_json(
                    source.snapshot_script, {**args, 'size': live[0]}, goal=goal, check=base_check
                )
        if snap.get('product_tab'):
            # 주문서가 안 열리면 스크립트는 사이트 알림(구매 한도 등)이 결과에 붙도록 상품 탭을 남긴다 — 여기서 닫는다
            self._close_product_tabs(account, str(snap.get('product_url') or ''))
        blocked = blocked_failure(snap, f'상품 확인 {account}')
        if blocked:
            raise blocked
        if snap.get('error') == 'seller-not-allowed':
            # 판매자가 정해진 곳(롯데백화점)이 아니다 — 품절이 아니라 '여기서 못 사는 상품'이다. 근거(판매자)를 남기고 멈춘다
            raise AgentFailure(
                'needs_human',
                mask_text(
                    f'판매자가 {source.required_seller} 이(가) 아니다(읽은 판매자: {str(snap.get("seller") or "-")[:40]}) — 사지 않는다'
                ),
                FailReason.UNKNOWN,
            )
        if snap.get('error') in ENTRY_ERRORS:
            # 다나와 경유 도착에 제휴(ReferCode)가 없거나 다른 상품이 떴다 — 그대로 사면 규칙 위반이다(H몰 직접 진입 금지)
            raise AgentFailure(
                'needs_human',
                mask_text(f'진입 경로 확인 실패({snap.get("error")}): {str(snap.get("note") or "")[:100]}'),
                FailReason.UNKNOWN,
            )
        if snap.get('already_ordered') or snap.get('existing_order_no'):
            return snap  # 중복 구매 흔적 — 정돈·견적 없이 호출부가 바로 거절한다
        limit = snapshot_purchase_limit(snap)
        if limit:
            raise AgentFailure('fail', f'{account}: {limit}', FailReason.OUT_OF_STOCK)
        if snapshot_login_required(snap):
            # 이 계정은 견적에서 빠진다(다른 계정 세션으로 대신 견적하지 않는다 — 실기 2026-09-25)
            raise AgentFailure(
                'needs_human',
                f'{account}: 로그인이 안 돼 있어 견적 못 함({snap.get("note") or snap.get("error")})',
                FailReason.PERMISSION_DENIED,
            )
        if source_of(self.spec.name).order_prep and _as_float(snap.get('cost')) > 0:
            self._order_prep(account, snap)
        # 결제수단 견적은 계정을 고른 뒤 한 번만(_buy) — 계정 비교 중에는 쿠폰 반영 총액만 본다
        if source_of(self.spec.name).normal_price and snap.get('normal_price') is None:
            self._apply_normal_price(a, account, snap)
        return snap

    def _mall_route_snapshot(self, a: Assignment, account: str) -> dict[str, object]:
        """지정 몰 상품(mall_item)·진입 경로(route_compare) 스냅샷 — SSG(사용자 2026-09-27).

        1) 주문 링크가 지정 몰(신세계몰, allow_department 면 신세계백화점까지)이면 그 상품으로 경로 스냅샷을 한다.
        2) 아니면(또는 스크립트가 not_shinsegaemall 로 멈추면) 같은 모델의 신세계몰 상품을 찾아 싼 순서로 스냅샷해
           주문 옵션이 맞는 첫 후보로 간다 — 상품번호·상품명은 그 후보 값이다. 그 뒤 경로 스냅샷(애드픽)을 한다.
        봇 차단을 부르지 않게 SSG 페이지 요청을 줄인다 — 기본은 애드픽 경로 스냅샷 하나.
        """
        source = source_of(self.spec.name)
        snap: dict[str, object] | None = None
        if (
            not source.mall_item
            or is_mall_url(a.order.product_url, source.allow_department)
            or mall_unknown_url(a.order.product_url)
        ):
            snap = (
                self._route_compare(a, account, None)
                if source.route_compare
                else self._snapshot_once(a, account)
            )
            if snap.get('error') == NOT_MALL_ERROR:
                if not source.mall_item:
                    raise AgentFailure(
                        'needs_human',
                        '지정 몰 상품이 아니다(신세계몰 아님) — 사람이 같은 상품을 찾는다',
                        FailReason.UNKNOWN,
                    )
                self.note(
                    '신세계몰 상품', '주문 링크가 신세계몰 상품이 아니다 — 같은 모델을 신세계몰에서 찾는다'
                )
                snap = None
        picked: dict[str, object] | None = None
        if snap is None:
            extra: dict[str, object] | None = (
                {'route': DIRECT_ROUTE} if source.route_compare else None
            )
            a, snap, picked = self._mall_item_snapshot(a, account, extra)
            if source.route_compare:
                snap = self._route_compare(a, account, snap)
        if picked is not None:
            snap['product_no'] = str(picked.get('item_id'))
            snap['product_name'] = str(picked.get('name') or '') or snap.get('product_name')
            snap['mall_item_url'] = str(picked.get('url'))
        return snap

    def _mall_item_snapshot(
        self, a: Assignment, account: str, extra: dict[str, object] | None
    ) -> tuple[Assignment, dict[str, object], dict[str, object]]:
        """같은 모델의 신세계몰 상품(`<key>_find_mall_item`)을 싼 순서로 스냅샷해 주문 옵션이 맞는 첫 후보를 고른다.

        (그 후보 상품 주소로 바꾼 작업, 스냅샷, 후보)를 돌려준다. 모델코드는 상품명(삼바 sku)에서 읽는다.
        후보가 없거나 모두 안 맞으면 사람에게 — 신세계몰이 아닌 곳에서는 사지 않는다.
        """
        source = source_of(self.spec.name)
        model = model_code_of(a.order.sku)
        if not model:
            raise AgentFailure(
                'needs_human',
                mask_text(f'주문 링크가 신세계몰 상품이 아닌데 상품명에서 모델코드를 못 찾았다: {a.order.sku[:60]}'),
                FailReason.UNKNOWN,
            )
        self.step(f'{self.spec.name}: 신세계몰 같은 상품 찾기({model})')
        out = self.script_json(
            source.mall_item_script,
            {'model': model, 'profile': account},
            goal=(
                f'신세계몰 검색에서 모델코드 {model} 상품을 모아 '
                '{ok, model, items:[{item_id, url, name, price}]} 로 돌려준다(가격 오름차순). 결제·주문은 하지 않는다.'
            ),
            check=lambda o: (
                None
                if isinstance(o.get('items'), list) or o.get('error') == BLOCKED_ERROR
                else f'후보 목록(items)이 없다: note={o.get("note")}'
            ),
        )
        blocked = blocked_failure(out, '신세계몰 상품 찾기')
        if blocked:
            raise blocked
        items = mall_candidates(out.get('items'))
        if not items:
            raise AgentFailure(
                'needs_human', f'신세계몰에 같은 모델({model}) 상품이 없다 — 사람이 확인한다', FailReason.UNKNOWN
            )
        misses: list[str] = []
        for item in items[:MALL_ITEM_TRIES]:
            order = a.order.model_copy(update={'product_url': str(item['url'])})
            cand = a.model_copy(update={'order': order})
            snap = self._snapshot_once(cand, account, extra, probe=True)
            if snap.get('already_ordered') or snap.get('existing_order_no'):
                return cand, snap, item  # 중복 구매 흔적 — 호출부가 거절한다
            why = self._unusable(cand, snap)
            if why is None:
                self.note(
                    '신세계몰 상품',
                    mask_text(f'{item["item_id"]} {str(item.get("name") or "")[:40]} — 주문 옵션 맞음(후보 {len(items)}개)'),
                )
                return cand, snap, item
            misses.append(f'{item["item_id"]}: {why}')
            self.note('신세계몰 상품', mask_text(f'{item["item_id"]}: 불가({why})'))
        raise AgentFailure(
            'needs_human',
            mask_text(f'신세계몰 같은 모델({model}) 후보에 주문 옵션이 맞는 상품이 없다 — {"; ".join(misses)[:200]}'),
            FailReason.UNKNOWN,
        )

    def _unusable(self, a: Assignment, snap: dict[str, object]) -> str | None:
        """이 스냅샷으로 살 수 없는 사유(스크립트 오류·주문 옵션 없음·주문서 옵션 불일치·원가 없음). 살 수 있으면 None."""
        if snap.get('error'):
            return f'{snap.get("error")}: {str(snap.get("note") or "")[:60]}'
        option = a.order.option
        if option:
            options = [str(o) for o in (snap.get('options') or [])]  # type: ignore[union-attr]
            if not self._match_options(options, option):
                return f'주문 옵션 없음·품절(선택지 {options[:6]})'
            selected = str(snap.get('selected') or '').strip()
            if not (selected and self._selected_matches(selected, option)):
                return f'주문서 옵션 불일치({selected or "모름"})'
        if _as_float(snap.get('cost')) <= 0:
            return f'원가 못 읽음({snap.get("note")})'
        return None

    def _route_quotes(self, a: Assignment, account: str, wanted: list[str]) -> list[dict[str, object]]:
        """진입 경로 견적(`<key>_route_quotes`) — 경로마다 진입 주소를 받는다. 못 읽으면 빈 목록(직접 경로로 산다)."""
        source = source_of(self.spec.name)
        args: dict[str, object] = {
            'sku': a.order.product_url or '',
            'name': a.order.sku,
            'profile': account,
            'routes': wanted,
        }
        if source.allow_department:
            args['allow_department'] = True
        self.step(f'{self.spec.name}: 진입 경로 견적({", ".join(wanted)})')
        try:
            out = self.script_json(
                source.route_quotes_script,
                args,
                goal=(
                    f'같은 상품(itemId)을 경로 {wanted} 로 열어 '
                    '{ok, routes:[{route, entry_url, mall_ok, same_item, sold_out, percent}]} 로 돌려준다. '
                    '결제·주문·로그인은 하지 않는다.'
                ),
                check=lambda o: (
                    None
                    if isinstance(o.get('routes'), list) or o.get('error') == BLOCKED_ERROR
                    else f'경로 목록(routes)이 없다: note={o.get("note")}'
                ),
            )
        except AgentFailure as e:
            self.note('경로 비교', mask_text(f'경로 견적 실패({e.reason[:60]}) — 직접 경로로 산다'))
            return []
        blocked = blocked_failure(out, '진입 경로 견적')
        if blocked:
            raise blocked
        routes = usable_routes(out.get('routes'), wanted)
        raw = out.get('routes')
        for r in raw if isinstance(raw, list) else []:
            if isinstance(r, dict) and r not in routes:
                self.note('경로 비교', mask_text(f'{r.get("route")}: 못 씀({str(r.get("note") or "진입 불가·몰 아님·품절")[:60]})'))
        return routes

    def _route_compare(
        self, a: Assignment, account: str, first: dict[str, object] | None
    ) -> dict[str, object]:
        """진입 경로(기본 애드픽 하나)로 스냅샷해 주문서 원가(결제액 − 애드픽 적립)가 가장 싼 경로의 주문서를 남긴다.

        first 는 이미 만든 직접 경로 주문서(신세계몰 후보 시험)다 — 있으면 비교에 넣는다. 경로를 하나도 못 쓰면
        직접 경로로 산다. 같은 원가면 앞 경로(직접). 경로는 쿠키로 기록되고 마지막 진입이 덮어쓰므로
        이긴 경로가 마지막으로 연 경로가 아니면 그 경로로 다시 들어가 주문서를 새로 만든다.
        """
        source = source_of(self.spec.name)
        if first is not None and (
            first.get('already_ordered') or first.get('existing_order_no') or self._unusable(a, first)
        ):
            return first  # 살 수 없는 상품이면 경로를 볼 것도 없다 — 호출부가 사유를 판단한다
        wanted = list(source.routes or ROUTES_DEFAULT)
        tried: list[tuple[str, dict[str, object], dict[str, object]]] = []
        direct: dict[str, object] = {'route': DIRECT_ROUTE}
        if first is not None:
            tried.append((DIRECT_ROUTE, first, direct))
        elif DIRECT_ROUTE in wanted:
            first = self._snapshot_once(a, account, direct)
            if first.get('error') or self._unusable(a, first):
                return first
            tried.append((DIRECT_ROUTE, first, direct))
        # 경로 주문서는 받았는데 상품 사유(옵션 없음·품절)로 못 쓰면 그것을 돌려준다 — 직접 경로로 또 열지 않는다
        product_miss: dict[str, object] | None = None
        others = [r for r in wanted if r != DIRECT_ROUTE]
        for r in self._route_quotes(a, account, others) if others else []:
            route = str(r['route'])
            extra: dict[str, object] = {'route': route, 'entry_url': str(r['entry_url'])}
            percent = _as_float(r.get('percent'))
            if percent > 0:
                extra['adpick_percent'] = percent
            try:
                snap = self._snapshot_once(a, account, extra, probe=True)
            except AgentFailure as e:
                if e.fail_reason is FailReason.CAPTCHA:
                    raise  # 봇 차단 — 다른 경로도 막힌다. 사람에게
                self.note('경로 비교', mask_text(f'{route}: 불가({e.reason[:60]})'))
                continue
            if snap.get('error') == NOT_MALL_ERROR or snap.get('already_ordered') or snap.get('existing_order_no'):
                return snap  # 지정 몰 아님(호출부가 같은 상품을 찾는다)·중복 구매 흔적(호출부가 거절한다)
            why = self._unusable(a, snap)
            if why:
                self.note('경로 비교', mask_text(f'{route}: 불가({why})'))
                if not snap.get('error') and product_miss is None:
                    product_miss = snap
                continue
            if route == ADPICK_ROUTE and percent > 0 and not snap.get('adpick_rate'):
                snap['adpick_rate'] = percent  # 스크립트와 같은 % 단위
            tried.append((route, snap, extra))
        if not tried:
            if product_miss is not None:
                return product_miss
            self.note('경로 비교', '쓸 수 있는 경로가 없다 — 직접 경로로 산다')
            first = self._snapshot_once(a, account, direct)
            if first.get('error') or self._unusable(a, first):
                return first
            tried.append((DIRECT_ROUTE, first, direct))
        costs = ' · '.join(f'{name} {route_cost(sn):,.0f}' for name, sn, _ in tried)
        # 결제액이 같으면 애드픽 경로(적립은 원가 밖 수익) — 그다음은 앞 것(직접 경로)
        route, snap, extra = min(tried, key=lambda t: (route_cost(t[1]), t[0] != ADPICK_ROUTE))
        if snap is not tried[-1][1]:
            again = self._snapshot_once(a, account, extra)
            why = self._unusable(a, again)
            if why:
                raise AgentFailure(
                    'needs_human',
                    mask_text(f'이긴 경로({route})로 다시 들어가 주문서를 못 만들었다: {why}'),
                    FailReason.UNKNOWN,
                )
            if not again.get('adpick_rate') and snap.get('adpick_rate'):
                again['adpick_rate'] = snap['adpick_rate']
            snap = again
        self.note('경로 비교', f'{costs} → {route}')
        snap['route'] = route
        self._apply_adpick(snap)
        return snap

    def _apply_adpick(self, snap: dict[str, object]) -> None:
        """애드픽 경로 적립을 원가에 한 번 넣는다 — cost = 결제액 − 적립, reward 에 적립 가산.

        결제수단 견적(_apply_payment_quotes)이 cost·reward 를 견적 값으로 덮어쓰면 거기서 줄마다 다시 더한다.
        """
        reward = adpick_reward_of(snap)
        if reward <= 0:
            return
        # 애드픽·샵백 적립은 원가에 넣지 않는다(사용자 2026-09-27) — 적립 예정액만 남긴다
        snap['adpick_reward'] = reward
        self.note('애드픽 적립', f'{reward:,.0f}원 예정 — 원가에는 넣지 않는다')

    def _close_order_tabs(self, account: str) -> None:
        """열린 주문서·결제 탭을 닫는다(이 레인에서 보이는 것만). 못 닫아도 스냅샷은 이어 간다."""
        try:
            self.tool('run_js', code=_CLOSE_ORDER_TABS_JS, safety='no_pay')
        except AgentFailure as e:
            self.note('주문서 정리', mask_text(f'{account}: 열린 주문서 못 닫음({e.reason[:60]})'))

    def _close_product_tabs(self, account: str, product_url: str) -> None:
        """이 레인에 남은 그 상품 탭을 닫는다(같은 스크립트를 재시도했으면 여럿일 수 있다). 못 닫아도 이어 간다."""
        if not product_url.startswith('http'):
            return
        code = (
            f'const u = {json.dumps(product_url)}; '
            "for (const t of await tabs.list()) { if ((t.url || '').startsWith(u)) "
            '{ try { await tabs.close(t.id) } catch (e) {} } } return "ok"'
        )
        try:
            self.tool('run_js', code=code, safety='no_pay')
        except AgentFailure as e:
            self.note('상품 탭 정리', mask_text(f'{account}: 못 닫음({e.reason[:60]})'))

    def _download_coupons(self, a: Assignment, account: str) -> None:
        """상품 페이지 '쿠폰받기'로 이 계정이 받을 수 있는 쿠폰을 먼저 받는다. 실패해도 구매는 이어 간다(근거만 남긴다)."""
        self.step(f'{self.spec.name}: 쿠폰 받기({account})')
        try:
            out = self.script_json(
                source_of(self.spec.name).coupon_download_script,
                {'sku': product_ref(self.spec.name, a.order), 'profile': account},
                goal=(
                    '계정 profile 로 상품 페이지를 열어 "쿠폰받기"(또는 쿠폰 레이어의 모두 받기)를 눌러 받을 수 있는 '
                    '쿠폰을 모두 받고 레이어를 닫은 뒤 {ok:true, clicked, issued(발급된 할인액 목록)} 를 돌려준다. '
                    '쿠폰받기 버튼이 없으면 {ok:true, clicked:false}.'
                ),
                check=lambda o: None if o.get('ok') else f'쿠폰 받기 실패: {o.get("note")}',
            )
        except AgentFailure as e:
            self.note('쿠폰 받기', mask_text(f'{account}: 못 함({e.reason[:80]})'))
            return
        issued = [str(x) for x in (out.get('issued') or [])]  # type: ignore[union-attr]
        self._issued = {**getattr(self, '_issued', {}), account: issued}
        if out.get('clicked'):
            self.note('쿠폰 받기', f'{account}: 받음 {issued}')

    def _apply_normal_price(self, a: Assignment, account: str, snap: dict[str, object]) -> None:
        """소싱처 정가(`<key>_normal_price`)를 스냅샷에 싣는다. 못 읽으면 None 으로 두고 근거만 남긴다."""
        try:
            out = self.script_json(
                source_of(self.spec.name).normal_price_script,
                {'sku': product_ref(self.spec.name, a.order), 'profile': account},
                goal='상품의 정상가(할인 전 판매가, normal_price 숫자)를 읽어 돌려준다.',
                check=lambda o: (
                    None
                    if _as_float(o.get('normal_price')) > 0
                    else '정상가(normal_price)를 못 읽음'
                ),
            )
        except AgentFailure as e:
            self.note('정가', mask_text(f'못 읽음({e.reason[:80]})'))
            return
        price = _as_float(out.get('normal_price'))
        if price > 0:
            snap['normal_price'] = price
            self.note('정가', f'{price:,.0f}원')

    def _prep_problem(self, account: str, o: dict[str, object]) -> str | None:
        """주문서 정돈 결과 검사. 다시 확인 중인 계정은 받은 쿠폰이 실제로 적용됐는지도 본다."""
        points_only = _as_float(o.get('total')) == 0 and _as_float(o.get('points_used')) > 0
        if not (o.get('ok') and (_as_float(o.get('total')) > 0 or points_only)):
            return f'정돈 실패(ok={o.get("ok")}, total={o.get("total")}, note={o.get("note")})'
        # 스크립트가 돌려준 값을 화면 값과 대조한다 — "쿠폰 적용"이라 보고하고 실제로는 안 붙은 경우를 잡는다
        # (실기 2026-09-25 로라로라: 쿠폰 13,110+4,580 적용 보고, 화면 할인 10,460 · 쿠폰 버튼 '쿠폰 사용' 그대로)
        lie = prep_screen_mismatch(o)
        if lie:
            return lie
        target = getattr(self, '_expect_cost', {}).get(account)
        cost = _as_float(o.get('total')) + _as_float(o.get('points_used'))
        # 이 작업에서 이미 AI 가 '계정마다 쿠폰이 실제로 다르다(스크립트 문제 아님)'고 봤으면 다시 수리하지 않는다
        # (실기 2026-09-25: 계정마다 수리를 새로 돌려 주문 1건에 20분 넘게 걸렸다 — 결과는 매번 genuine)
        genuine = getattr(self, '_repair_genuine', set())
        if source_of(self.spec.name).order_prep_script in genuine:
            return None
        # 이 계정이 이번에 받은 쿠폰이 없거나, 받은 쿠폰 중 가장 큰 금액 이상이 이미 적용됐으면 비싼 건 실제 차이다
        # — 수리하지 않는다(실기 2026-09-25: 쿠폰 없는 계정마다 수리를 돌려 결과는 늘 genuine, 작업당 수 분 낭비)
        issued = [_as_float(str(x).replace(',', '')) for x in getattr(self, '_issued', {}).get(account, [])]
        applied = _as_float(o.get('coupon')) + _as_float(o.get('cart_coupon'))
        if not issued or applied >= max(issued):
            return None
        if target and cost > target:
            return (
                f'이 계정은 쿠폰을 받았는데 비교액(결제+사용 적립금) {cost:,.0f}원이 '
                f'다른 계정 {target:,.0f}원보다 높다 — '
                '주문서 쿠폰 선택(쿠폰 사용·쿠폰 변경)에서 받은 쿠폰을 적용하고 적용액을 coupon 으로 돌려줘라. '
                '정말 적용 불가면 화면 근거를 남겨라'
            )
        return None

    def _order_prep(self, account: str, snap: dict[str, object]) -> None:
        """주문서 정돈(`<key>_order_prep`): 적립금 규칙(5만 미만 0원·이상 최대)·선할인. 규칙대로 못 맞추면 사람에게."""
        self.step(f'{self.spec.name}: 주문서 정돈({account})')
        source = source_of(self.spec.name)
        prep_args: dict[str, object] = {'profile': account}
        if source.direct_card:
            # 카드 직접 결제 소싱처(H몰): 포인트는 그 카드 즉시할인 기준금액(5만원)이 유지되는 선까지만(사용자 2026-09-27)
            prep_args.update({'points': 'keep_card_discount', 'card': source.direct_card})
            if snap.get('order_tab'):
                prep_args['tab'] = str(snap.get('order_tab'))
        out = self.script_json(
            source.order_prep_script,
            prep_args,
            goal=(
                (
                    f'주문서에서 최대 할인을 켜고, 포인트(적립금 먼저·H.Point)는 {source.direct_card} 즉시할인 기준금액'
                    '(결제예정액 5만원 이상)이 유지되는 선까지만 쓴다: 사용량 = min(보유, 결제예정액 − 기준금액), 음수면 0. '
                    '넣은 뒤 즉시할인 줄이 남았는지 확인하고 {ok, total, points_used, points_balance, reward, coupon} 을 돌려준다. '
                    '결제하기는 누르지 않는다.'
                )
                if source.direct_card
                else (
                    '주문서에서 상품 쿠폰·장바구니 쿠폰(확인까지)을 최대 할인으로 적용하고, 적립금은 보유 5만원 미만이면 0원·'
                    '이상이면 최대 사용(사용 제한 상품은 0원), 선할인이 가능하면 켠 뒤 총 결제 금액(total)을 돌려준다. '
                    '규칙대로 맞췄으면 ok:true.'
                )
            ),
            check=lambda o: self._prep_problem(account, o),
        )
        if not out.get('ok'):
            raise AgentFailure(
                'needs_human',
                f'주문서 정돈 실패: {mask_text(str(out.get("note") or "")[:80])}',
                FailReason.UNKNOWN,
            )
        used = _as_float(out.get('points_used'))
        snap['points_used'] = used
        # 계정 비교 검증(_audit_quotes)이 보는 값
        snap['coupon_applied'] = _as_float(out.get('coupon')) + _as_float(out.get('cart_coupon'))
        snap['points_balance'] = out.get('points_balance')
        snap['coupons_issued'] = list(getattr(self, '_issued', {}).get(account, []))
        total = _as_float(out.get('total'))
        if total == 0 and used > 0:
            # 포인트로 전액 결제(ABC 포인트 최대 사용) — 결제창이 없다. 원가 = 사용 포인트 − 사이트 적립
            snap['points_only'] = True
            snap['reward'] = _as_float(out.get('reward'))
            snap['cost'] = used - _as_float(out.get('reward'))
            snap['pay_amount'] = 0.0
        elif total > 0:
            # 계정 비교·원가는 '결제액 + 사용 적립금'으로 — 원가 공식이 사용 적립금을 다시 더한다(플레이북 §6).
            # 결제액만 비교하면 적립금 많은 계정(buyer02)이 늘 싸 보인다(사용자 지적 2026-09-24)
            snap['cost'] = total + used
            snap['pay_amount'] = total
        self.note(
            '쿠폰',
            f'상품 쿠폰 {_as_float(out.get("coupon")):,.0f}원 · 장바구니 쿠폰 {_as_float(out.get("cart_coupon")):,.0f}원 → 총 {total:,.0f}원',
        )
        self.note(
            '주문서 정돈',
            f'보유 적립금 {_as_float(out.get("points_balance")):,.0f}원 → 사용 {used:,.0f}원, 선할인 {out.get("prepay")}',
        )

    def _payable_providers(self, account: str) -> set[str] | None:
        """이 계정으로 실제 낼 수 있는 결제 제공자(키마스터에 결제 비밀번호·카드가 있는 것).

        앱 list_accounts 의 payments(결제 제공자)·types('card') 로 판단한다. 목록을 못 읽으면 None —
        그때는 걸러내지 않고 스냅샷 원가로 간다(견적을 잘못 거르는 것보다 안 거르는 게 안전).
        """
        home = self._home()
        host = source_of(self.spec.name).login_host or urlparse(home).hostname or ''
        try:
            raw = self.tool('list_accounts', host=host)
        except AgentFailure:
            return None
        found = parse_account_payments(raw, account)
        if found is not None and source_of(self.spec.name).direct_card:
            # 카드 직접 결제(H몰 롯데카드)는 키마스터 결제 비밀번호 없이 카드사 결제창에서 사람이 승인한다 — 계정이 있으면 낼 수 있다
            found = found | {DIRECT_CARD_PROVIDER}
        return found

    def _allowed_providers(self, account: str | None = None) -> set[str] | None:
        """이 소싱처에서 쓸 수 있는 결제 제공자. 소싱처가 하나로 고정했으면(pay_provider) 그것만, 아니면 전역 허용 수단.

        계정이 결제수단을 하나로 정해 뒀으면(ACCOUNT_PAY_ONLY) 그것과 겹치는 것만 — buyer02 는 무신사머니만.
        """
        fixed = source_of(self.spec.name).pay_provider
        allowed = {fixed} if fixed else self.allowed_pay_providers
        only = ACCOUNT_PAY_ONLY.get((account or '').split('@')[0].lower())
        if only:
            allowed = set(only) if allowed is None else (set(allowed) & set(only))
        return allowed

    def _pay_card_quote(self, account: str) -> list[dict[str, object]]:
        """무신사페이 등록 기본 카드 견적 한 줄(`<key>_pay_card_quote`). 못 읽으면 빈 목록."""
        try:
            # 없거나 틀리면 AI 가 만든다(29CM 도 무신사페이 등록 카드로 결제한다)
            out = self.script_json(
                source_of(self.spec.name).pay_card_quote_script,
                {'profile': account},
                goal=(
                    '열린 주문서(계정 profile)에서 무신사페이를 골라 등록된 카드 목록(카드사 이름 (번호) 신용카드/체크카드) 중 '
                    '맨 앞 기본 카드와, 그때의 총 결제 금액·후기 제외 적립·사용 적립금을 '
                    '{ok:true, quotes:[{method:"무신사페이", card, cost, reward, points_used, registered:true, allowed:true, '
                    'available:true}], cards:[등록 카드 이름들]} 로 돌려준다. "혜택 받기"가 붙은 카드는 등록 카드가 아니다. '
                    '결제하기는 누르지 않는다.'
                ),
                check=pay_card_quote_problem,
            )
        except AgentFailure as e:
            self.note(
                '결제수단 견적', mask_text(f'무신사페이 기본 카드 견적 못 읽음({e.reason[:60]})')
            )
            return []
        rows = out.get('quotes')
        if not out.get('ok') or not isinstance(rows, list):
            self.note('결제수단 견적', mask_text(f'무신사페이 기본 카드 없음({out.get("note")})'))
            return []
        self.note(
            '결제수단 견적',
            f'무신사페이 등록 카드 {out.get("cards")} — 기본 {rows[0].get("card") if rows else "-"}',
        )
        return [r for r in rows if isinstance(r, dict)]

    def _apply_payment_quotes(self, a: Assignment, account: str, snap: dict[str, object]) -> None:
        """주문서의 결제수단별 견적(`<key>_payment_quotes`)에서 결제 가능한 가장 싼 조합을 스냅샷에 반영한다.

        요청자가 카드를 지정했으면 그 수단·카드사만 후보다. 견적을 못 읽으면(스크립트 실패·빈 목록)
        스냅샷 원가 그대로 간다 — 견적은 더 싸게 사기 위한 것이지 구매 조건이 아니다.
        """
        if snap.get('points_only'):
            # 포인트로 전액 결제 — 결제수단이 필요 없다(결제하기 한 번에 주문 완료)
            snap['pay_method'] = POINTS_ONLY_METHOD
            snap['pay_card'] = None
            self.note('결제수단 견적', f'포인트 전액 결제 — 원가 {_as_float(snap.get("cost")):,.0f}원(사용 포인트 − 적립)')
            return
        # 주문서 결제수단 중 우리가 낼 수 있는 종류(간편결제·사이트 머니)가 하나도 없으면 견적할 것이 없다
        offered = [str(m) for m in (snap.get('methods') or [])]
        src = source_of(self.spec.name)
        if not any(quote_provider(m, None, src.direct_card) for m in offered):
            self.note('결제수단 견적', f'견적할 수단 없음(주문서 {offered}) — 스냅샷 원가로 진행')
            return
        # 결제 가능한 수단을 먼저 정한다 — 그 수단만 시험한다(카드사 12개를 전부 돌리는 낭비·화면 소란 방지).
        # 키마스터 조회는 활성 탭 사이트 기준이다 — 경유 사이트(샵백·교차 비교 29CM)가 앞에 있으면 거절돼
        # 비밀번호 없는 수단(무신사머니)으로 견적했다(실기 2026-09-29) — 주문서 탭을 앞에 두고 묻는다
        if snap.get('order_tab'):
            try:
                self.tool('switch_tab', id=str(snap.get('order_tab')))
            except AgentFailure:
                pass
        payable = self._payable_providers(account)
        allowed = self._allowed_providers(account)
        if payable is not None and allowed is not None:
            # 사용자가 허용한 결제수단만(예: 무신사머니·무신사페이, ABC마트·그랜드스테이지는 네이버페이만)
            payable = payable & allowed
        if payable is None and allowed is not None:
            # 키마스터 조회가 안 되면(활성 탭 사이트가 달라 거절 — 29CM 는 무신사 통합계정 비밀번호를 쓴다)
            # 허용된 결제수단 안에서 견적한다. 사이트 결제 비밀번호(무신사머니 등)는 키마스터에 있는지 모르니 뺀다
            # (실기 2026-09-29 hwangnol06: 비밀번호 없는 무신사머니를 골라 결제 단계에서 멈췄다)
            payable = set(allowed) - {'site'}
            self.note(
                '결제수단 견적',
                f'키마스터 결제 항목 조회 실패 — 허용 수단 {sorted(payable)} 로 견적',
            )
        if payable is None:
            # 결제 가능 여부를 모르면 견적으로 수단을 바꾸지 않는다 — 계좌이체처럼 낼 수 없는 수단을 고를 수 있다
            self.note(
                '결제수단 견적',
                '키마스터 결제 항목을 못 읽어 견적을 돌리지 않는다 — 스냅샷 원가로 진행',
            )
            return
        if not payable:
            # 이 계정엔 허용 수단의 키마스터 결제 항목이 하나도 없다 — 이 계정으로는 살 수 없다
            snap['_unpayable'] = True
            self.note(
                '결제수단 견적',
                f'{account} 에 허용 수단의 키마스터 결제 항목 없음 — 이 계정으로 못 산다',
            )
            return
        methods = payable_methods(offered, payable, src.money_in_pay, src.direct_card)
        if not methods:
            snap['_unpayable'] = True
            self.note(
                '결제수단 견적',
                f'{account}: 주문서 결제수단 중 결제 가능한 것 없음(가능 {sorted(payable)}) — 이 계정으로 못 산다',
            )
            return
        self.step(f'{self.spec.name}: 결제수단 견적({account})')
        quote_args: dict[str, object] = {'profile': account, 'methods': methods}
        if src.direct_card:
            # 카드 직접 결제 소싱처(H몰): 그 카드사 줄만 견적한다(다른 카드사는 허용 수단이 아니다)
            quote_args['cards'] = [src.direct_card]
            if snap.get('order_tab'):
                quote_args['tab'] = str(snap.get('order_tab'))
        try:
            out = self.script_json(
                src.payment_quotes_script,
                quote_args,
                goal=(
                    f'주문서에서 결제수단 {methods} 을 하나씩 골라(무신사머니가 있으면 무신사머니 줄은 반드시 포함) '
                    '각 수단의 할인 반영 결제 금액(cost)을 읽어 '
                    'quotes 목록(원래 키 그대로)으로 돌려준다. 줄마다 reward 에는 후기 적립을 뺀 적립 합계(머니 결제 적립·'
                    '등급 적립·네이버페이 적립 포인트 등)를, card 에는 결제에 쓸 카드사 이름(간편결제 안 카드 포함, 예: 현대카드)을, '
                    'points_used 에는 사용한 적립금·포인트를 넣는다 — 원가 = cost × 카드 청구할인 − reward + points_used. '
                    '결제하기는 누르지 않는다.'
                ),
                check=lambda o: quotes_problem(o, offered, allowed, src.direct_card),
            )
        except AgentFailure as e:
            self.note('결제수단 견적', mask_text(f'못 읽음({e.reason[:80]}) — 스냅샷 원가로 진행'))
            return
        raw_quotes = out.get('quotes')
        if source_of(self.spec.name).pay_card_quote:
            # 간편결제(무신사페이)의 등록 기본 카드 견적 — 결제는 카드 목록 맨 앞 카드로 된다. 롯데 ×0.98·현대 ×0.973
            # 청구할인을 무신사머니와 같이 비교하려면 이 줄이 있어야 한다(실기: 무신사페이는 즉시할인 배너 카드로만 견적됐다)
            extra = self._pay_card_quote(account)
            raw_quotes = [*(raw_quotes if isinstance(raw_quotes, list) else []), *extra]
        if not isinstance(raw_quotes, list) or not raw_quotes:
            self.note('결제수단 견적', '견적 없음 — 스냅샷 원가로 진행')
            return
        # 견적 스크립트는 사용 적립금을 안 돌려준다 — 주문서 정돈에서 쓴 적립금을 넣어야 원가 공식이 맞는다
        # (실기: 적립금 6,150 이 빠져 원가 49,310·마진 +2.6% 로 결제, 실제 원가 56,483·마진 −8.3%)
        used = _as_float(snap.get('points_used'))
        raw_quotes = [
            {**q, 'points_used': used} if isinstance(q, dict) and not q.get('points_used') else q
            for q in raw_quotes
        ]
        # 애드픽 적립은 견적 원가에 더하지 않는다(사용자 2026-09-27: 제휴 적립은 원가 밖)
        quotes = cheapest_quotes(
            raw_quotes, a.options.get('card'), payable, src.easy_pay_card, src.charge_pay, src.direct_card
        )
        if not quotes:
            # 결제 항목은 있는데 이 주문서의 수단과 겹치지 않는다 — 모델이 고르게 두면 실결제에서 어차피 막힌다
            offered = sorted({str(q.get('method')) for q in raw_quotes if isinstance(q, dict)})
            raise AgentFailure(
                'needs_human',
                f'결제 가능한 수단이 없다({account}): 키마스터 결제 항목 {sorted(payable) or "없음"}, '
                f'주문서 결제수단 {offered} — 견적 {_quote_rows_brief(raw_quotes)}',
                FailReason.CARD_MISSING,
            )
        best = quotes[0]
        snap['cost'] = best['cost']
        snap['pay_amount'] = best['paid']
        snap['pay_method'] = best['method']
        snap['pay_card'] = best['card']
        # 견적의 적립(사이트 적립예정 + 네이버페이 기본 1%) — 주문 상세에 적립이 안 나오는 사이트(ABC: 구매확정 뒤 지급)는
        # 기록 단계가 이 값으로 원가를 낸다
        snap['reward'] = best['reward']
        label = f'{best["method"]}/{best["card"]}' if best['card'] else best['method']
        payable_note = '' if payable is None else f', 결제 가능 {sorted(payable)}'
        self.note(
            '결제수단 견적',
            f'{label} {best["cost"]:,.0f}원 — 최저 (후보 {len(quotes)}건, 기본 '
            f'{_as_float(out.get("base_cost")):,.0f}원{payable_note})',
        )

    @staticmethod
    def _adpick_for(snap: dict[str, object], paid: float) -> float:
        """그 결제액의 애드픽 적립 — 적립률(%)이 있으면 결제액 × 적립률, 없으면 스냅샷 적립액 그대로."""
        rate = _as_float(snap.get('adpick_rate'))
        return float(round(paid * rate / 100)) if rate > 0 else _as_float(snap.get('adpick_reward'))

    def _quote(self, a: Assignment, account: str) -> dict[str, object] | None:
        """한 계정의 견적 — 로그인·주문서까지 만들어 원가를 읽는다. 살 수 없으면 None.

        같은 상품을 이미 산 흔적은 계정과 무관한 중단 사유라 그대로 던진다. 그 밖의 실패
        (로그인 실패·품절·원가 없음)는 이 계정만 빼고 근거에 남긴다 — 원문 개인정보는 남기지 않는다.
        """
        try:
            self._login_as(account)
            snap = self._snapshot(a, account)
            self._check_account(account, snap)
        except AgentFailure as e:
            if e.fail_reason is FailReason.DUPLICATE:
                raise
            self._quote_errors.append(e)
            self.note('계정 견적', mask_text(f'{account}: 불가({e.reason[:80]})'))
            return None
        if snap.get('already_ordered') or snap.get('existing_order_no'):
            raise AgentFailure(
                'fail', f'이미 구매한 흔적이 있다: {a.order.sku}', FailReason.DUPLICATE
            )
        if snapshot_sold_out(snap):
            # 상품 전체 품절 — 옵션 대조(AI 매칭 포함)까지 가지 않는다. 계정과 무관한 상품 사유다
            self.note('계정 견적', mask_text(f'{account}: 불가(상품 전체 품절)'))
            self._quote_skips.append(
                f'{account}: {SOLD_OUT_PRODUCT_SKIP} ({str(snap.get("note") or "SOLD OUT")[:60]})'
            )
            return None
        options = [str(o) for o in (snap.get('options') or [])]
        if not self._match_options(options, a.order.option):
            self.note('계정 견적', mask_text(f'{account}: 불가(주문 옵션 품절)'))
            marked = sold_out_option_matches(options, a.order.option)
            if marked:
                # 주문 옵션의 품절 항목 자체를 남긴다 — 앞 6개만 자르면 그 항목이 잘려 '품절 표시가 없다'로 보였다
                # (실기 2026-09-27 그랜드스테이지 260: ['240',…,'270'] 뒤 7번째가 '260 품절')
                self._quote_skips.append(
                    f'{account}: {SOLD_OUT_LISTED_SKIP} {marked} (선택지 {len(options)}개)'
                )
            else:
                self._quote_skips.append(f'{account}: 옵션 불일치 {options[:6]}')
            return None
        selected = str(snap.get('selected') or '').strip()
        if a.order.option and not (selected and self._selected_matches(selected, a.order.option)):
            # 주문서에 엉뚱한 옵션이 담긴 채 사면 안 된다(실기: 110 주문에 105 결제).
            # 주문서를 아예 못 읽었으면(주문서 안 열림 등) 그 사유를 남긴다 — '불일치(모름)' 은 원인을 가렸다
            why = (
                f'주문서 옵션 불일치({selected})'
                if selected
                else f'주문서 옵션 못 읽음({snap.get("note") or snap.get("error") or "모름"})'
            )
            self.note('계정 견적', mask_text(f'{account}: 불가({why})'))
            self._quote_skips.append(f'{account}: {why}')
            return None
        # 계정마다 그 계정이 실제로 낼 수 있는 수단(키마스터 결제 항목 ∩ 허용 수단)으로 견적한 금액으로 비교한다
        # (사용자 지시 2026-09-25 — 쿠폰 총액만 비교해 결제 항목 없는 계정이 이겼고 엉뚱한 카드로 결제됐다)
        if source_of(self.spec.name).payment_quotes and _as_float(snap.get('cost')) > 0:
            self._apply_payment_quotes(a, account, snap)
            snap['_quoted'] = True
            if snap.get('_unpayable'):
                self.note('계정 견적', mask_text(f'{account}: 불가(결제 가능한 수단 없음)'))
                self._quote_skips.append(f'{account}: {UNPAYABLE_SKIP}')
                return None
        cost = _as_float(snap.get('cost'))
        if cost <= 0:
            self.note('계정 견적', mask_text(f'{account}: 불가(원가를 읽지 못함)'))
            self._quote_skips.append(f'{account}: 원가 못 읽음({snap.get("note")})')
            return None
        how = f' ({snap.get("pay_method")})' if snap.get('pay_method') else ''
        self.note('계정 견적', mask_text(f'{account}: 원가 {cost:,.0f}원{how}'))
        return {**snap, 'cost': cost}

    def _selected_matches(self, selected: str, wanted: str | None) -> bool:
        """주문서에 담긴 옵션이 주문 옵션과 같은가. 주문 옵션에 사이즈 숫자가 있으면 그 숫자가 꼭 겹쳐야 한다."""
        if not wanted:
            return True
        # 하네스가 매칭해 스크립트에 넘긴 선택지 글자(옵션 재선택)가 주문서에 그대로 담겼으면 같은 옵션이다
        picked = getattr(self, '_reselected', {}).get(wanted)
        if picked and ''.join(picked.split()).lower() in ''.join(selected.split()).lower():
            return True
        sizes = size_numbers(wanted)
        if sizes and not (size_numbers(selected) & sizes):
            return False
        # 사이즈 글자(S·M·L·XL·FREE…)도 꼭 맞아야 한다(실기: '상아색 S' 주문에 색만 담긴 'IVORY' 가 통과)
        letters = size_letters(wanted)
        # 사이즈 숫자가 이미 맞았으면 괄호 속 글자 사이즈는 보조 표기다(실기: '090(S)' 주문에 'LIGHT BEIGE · 090')
        if letters and not sizes and not (size_letters(selected) & letters):
            return False
        return bool(self._match_options([selected], wanted))

    def _match_options(self, options: list[str], wanted: str | None) -> list[str]:
        """주문 옵션과 맞는 후보. 규칙 매칭이 실패하면 AI 가 표기만 다른 같은 옵션을 고른다.

        AI 에게는 사이즈 숫자가 겹치는 후보만 준다(numeric_overlap_options). 답은 후보 중 하나로 맞춰지지
        않으면 버린다. 같은 (주문 옵션, 후보) 는 작업 안에서 한 번만 묻는다(계정 4개 비교).
        """
        rule = matching_options(options, wanted)
        if rule or not wanted:
            return rule
        by_letter = size_letter_options(options, wanted)
        if by_letter:
            self.note(
                '옵션 선택',
                mask_text(f'[{wanted}] → {by_letter[0]} (사이즈 글자 일치, 선택지에 색 표기 없음)'),
            )
            return by_letter
        pool = numeric_overlap_options(options, wanted)
        if not pool:
            return []
        cache: dict[tuple[str, tuple[str, ...]], list[str]] = getattr(self, '_option_ai', {})
        self._option_ai = cache
        key = (wanted, tuple(pool))
        if key in cache:
            return cache[key]
        try:
            picked = self.decide_once(
                f'주문 옵션 [{wanted}] 과 **같은 상품 옵션**을 후보에서 하나 고르라.\n'
                '표기만 다른 같은 것만 고른다(예: 7 1/8 = 718, 56.8cm 같음 / EU 44 = KR 285 / 상아색 = 아이보리 = IVORY / '
                'A/S = S(아시아 사이즈 표기)). 색이 하나뿐인 상품은 후보에 사이즈만 있다 — 그때는 사이즈만 맞으면 된다.\n'
                '사이즈·색이 다르면 절대 고르지 말고 choice 에 "없음" 이라고 답하라.\n'
                f'후보: {pool}',
                Decision,
            )
        except AgentFailure as e:
            self.note('옵션 AI 매칭', mask_text(f'판단 실패: {e.reason[:80]}'))
            cache[key] = []
            return []
        choice = resolve_choice(str(getattr(picked, 'choice', '')), pool)
        result = [choice] if choice else []
        self.note(
            '옵션 AI 매칭',
            mask_text(
                f'[{wanted}] → {choice or "없음"} ({str(getattr(picked, "reason", ""))[:80]})'
            ),
        )
        cache[key] = result
        return result

    def _audit_quotes(
        self, a: Assignment, quotes: list[tuple[str, dict[str, object]]]
    ) -> list[tuple[str, dict[str, object]]]:
        """계정별 견적 숫자 검증 — 스크립트가 틀린 숫자를 성공처럼 돌려주면 비교가 틀린다(실기: 쿠폰 미적용).

        1) 규칙: 쿠폰을 받았거나 다른 계정엔 쿠폰이 붙었는데 이 계정만 0원
        2) AI: 계정별 수집값 전체를 보고 이상한 계정을 짚는다
        걸린 계정은 한 번 다시 견적한다(주문서 정돈이 쿠폰을 못 붙이면 AI 수리). 그래도 이상하면 비교에서 뺀다.
        """
        if len(quotes) < 2:
            return quotes
        flagged = self._quote_flags(a, quotes)
        if not flagged:
            return quotes
        self.note('견적 검증', mask_text(f'다시 확인: {flagged}'))
        out: list[tuple[str, dict[str, object]]] = []
        for account, snap in quotes:
            if account not in flagged:
                out.append((account, snap))
                continue
            low = min(_as_float(o.get('cost')) for acc, o in quotes if acc != account)
            self._expect_cost = {**getattr(self, '_expect_cost', {}), account: low}
            again = self._quote(a, account)
            if again is None:
                self.note('견적 검증', f'{account}: 다시 확인 실패 — 비교에서 뺀다')
                continue
            others = [q for q in quotes if q[0] != account]
            still = self._quote_flags(a, [*others, (account, again)], use_ai=False)
            if account in still:
                self.note(
                    '견적 검증',
                    mask_text(f'{account}: 다시 봐도 이상({still[account]}) — 비교에서 뺀다'),
                )
                continue
            self.note(
                '견적 검증', f'{account}: 다시 확인 원가 {_as_float(again.get("cost")):,.0f}원'
            )
            out.append((account, again))
        return out or quotes

    def _quote_flags(
        self, a: Assignment, quotes: list[tuple[str, dict[str, object]]], use_ai: bool = True
    ) -> dict[str, str]:
        """이상한 계정 → 사유. 규칙 검사 뒤 AI 가 한 번 더 본다(AI 판단 실패는 규칙 결과만 쓴다)."""
        flags: dict[str, str] = {}
        # 쿠폰을 받았는데 다른 계정 최저 비교액보다 비싸면 받은 쿠폰이 주문서에 안 붙은 것이다
        # (실기: buyer01 114,630 vs 다른 계정 103,170). 쿠폰 적용액 칸은 믿지 않는다 — 자동 적용된 계정은
        # 스크립트가 0·None 으로 돌려줬다
        for account, q in quotes:
            issued = q.get('coupons_issued') or []
            others = [_as_float(o.get('cost')) for acc, o in quotes if acc != account]
            low = min(others) if others else 0.0
            cost = _as_float(q.get('cost'))
            if issued and low and cost > low:
                flags[account] = (
                    f'쿠폰 {issued} 을 받았는데 비교액 {cost:,.0f} > 다른 계정 {low:,.0f}'
                )
        if not use_ai:
            return flags
        rows = [
            {
                'account': acc,
                'selected': q.get('selected'),
                'coupons_issued': q.get('coupons_issued'),
                'coupon_applied': q.get('coupon_applied'),
                'points_balance': q.get('points_balance'),
                'points_used': q.get('points_used'),
                'pay_amount': q.get('pay_amount'),
                'compare_cost': q.get('cost'),
            }
            for acc, q in quotes
        ]
        try:
            verdict = self.decide_once(
                '같은 상품·같은 옵션을 무신사 계정 여러 개로 주문서까지 만들어 읽은 값이다. 계정마다 다를 수 있는 것은 '
                '쿠폰(받은 쿠폰·적용액)과 등급 적립뿐이고, 비교액은 결제액+사용 적립금이다. 적립금 규칙: 보유 5만원 미만이면 '
                '0원, 이상이면 최대 사용. 값이 말이 안 되는 계정(예: 쿠폰을 받았는데 적용 0원, 다른 계정과 옵션이 다름, '
                '비교액이 혼자 크게 튐, 적립금 규칙 위반)을 choice 에 쉼표로 적고(없으면 "없음") reason 에 계정별 이유를 적어라.\n'
                f'주문 옵션: {a.order.option}\n값: {json.dumps(rows, ensure_ascii=False)}',
                Decision,
            )
            names = {x.strip() for x in str(getattr(verdict, 'choice', '')).split(',')}
            for acc, _ in quotes:
                if acc in names and acc not in flags:
                    flags[acc] = f'AI: {str(getattr(verdict, "reason", ""))[:120]}'
        except AgentFailure as e:
            self.note('견적 검증', mask_text(f'AI 검토 실패 — 규칙 검사만 씀({e.reason[:60]})'))
        return flags

    def _find_same_product(self, a: Assignment) -> dict[str, object] | None:
        """다른 사이트 주문의 상품을 이 사이트에서 찾는다(`<key>_find_product`). 없으면 None.

        돌려주는 값: {product_url, name, model, entry_url?}. 모델코드·상품명(삼바 sku)을 함께 넘긴다 — H몰 찾기는
        원래 사이트(SSG)를 열지 않고(봇 차단) 모델코드로 다나와에서 찾는다(2026-09-27).
        """
        source = source_of(self.spec.name)
        host = urlparse(source.home or '').hostname or ''
        site_key = host.replace('www.', '')
        model = model_code_of(a.order.sku)
        out = self.script_json(
            source.find_product_script,
            {
                'source_url': a.order.product_url,
                'option': a.order.option or '',
                'model': model,
                'name': a.order.sku,
            },
            goal=(
                f'model(모델코드 {model or "없음"})·name(상품명)으로, 없으면 source_url(다른 쇼핑몰 상품 페이지)을 열어 읽은 '
                f'브랜드·품번으로 {host} 에서 같은 상품(품번 일치 우선, 없으면 브랜드+상품명 일치)을 찾아 '
                '{found, product_url, name, model} 을 돌려준다. '
                '같은 상품이 없으면 found:false. 다른 상품을 같은 것으로 치지 않는다. 결제·장바구니는 누르지 않는다.'
            ),
            check=lambda o: (
                None
                if not o.get('found')
                or (site_key and site_key in str(o.get('product_url') or '') and o.get('name'))
                else f'found 인데 이 사이트({site_key}) 상품 주소·이름이 없다'
            ),
        )
        if not out.get('found') or not str(out.get('product_url') or ''):
            return None
        return out

    def _cross_compare(
        self, a: Assignment, account: str | None, snap: dict[str, object] | None
    ) -> AgentResult | None:
        """다른 사이트(sibling)의 같은 상품과 최종 원가(결제수단 견적 포함)를 비교한다.

        다른 사이트가 더 싸면 그 사이트 에이전트가 그 계정으로 산 결과를 돌려준다. 같거나 비싸면 None(이 사이트로 산다).
        snap 이 None 이면 이 사이트 견적을 못 낸 것이다(SSG 봇 차단) — 다른 사이트에서 살 수 있으면 그쪽으로 산다.
        """
        sib = self.sibling
        if sib is None or a.options.get('no_cross') or not (a.order.product_url or model_code_of(a.order.sku)):
            return None
        if snap is not None and (snap.get('already_ordered') or snap.get('existing_order_no')):
            return None  # 이 사이트에서 이미 산 흔적 — 다른 사이트에서 또 사면 중복 구매다. 호출부가 거절한다
        sib_src = source_of(sib.spec.name)
        self.step(f'{self.spec.name}: 교차 비교({sib_src.id})')
        sib._dry_run = self._dry_run
        sib.evidence = []
        sib._quote_errors = []
        sib._option_ai = {}
        sib.reset_repairs()
        # 다른 사이트 견적은 제 레인에서 한다 — 견적의 '열린 주문서 탭 닫기'가 레인 밖(모든 탭)에서 돌면 이 사이트가
        # 만들어 둔 주문서까지 닫아, 이 사이트로 살 때 배송지 스크립트가 주문서를 못 찾는다
        # (실기 2026-09-26 job 207: 29CM 1계정 견적이 무신사 주문서를 닫아 '배송지 입력 검증에 실패')
        cmp = copy.copy(sib)
        cmp.bridge = sib.bridge.with_lane(f'{sib_src.key}-cross')
        cmp._last_login = None  # 새 레인 — 로그인 상태를 새로 본다
        try:
            return self._cross_compare_in_lane(a, account, snap, sib, cmp)
        finally:
            # 견적 레인이 연 탭(다른 사이트 주문서)을 닫는다 — 뒤 단계 스크립트가 그 주문서를 집지 않게
            try:
                cmp.tool('run_js', code=_CLOSE_LANE_TABS_JS, safety='no_pay')
            except AgentFailure as e:
                self.note('교차 비교', mask_text(f'{sib_src.id} 레인 탭 정리 실패: {e.reason[:80]}'))

    def _cross_compare_in_lane(
        self,
        a: Assignment,
        account: str | None,
        snap: dict[str, object] | None,
        sib: 'BuyerAgent',
        cmp: 'BuyerAgent',
    ) -> AgentResult | None:
        """교차 비교 본문 — 다른 사이트 상품 찾기·견적은 cmp(견적 레인), 그쪽이 더 싸면 구매는 sib(레인 밖)."""
        sib_src = source_of(sib.spec.name)
        here = source_of(self.spec.name).id
        fallback = snap is None  # 이 사이트 견적 없음(봇 차단) — 다른 사이트만 견적해 산다
        # 이 사이트 스냅샷은 받았는데 못 쓰는 값(주문서 못 엶·원가 0) — 비교 대상이 아니다. 다른 사이트가 되면 그쪽으로.
        # (실기 2026-09-27 job 258: SSG 주문서가 안 열려 원가 0 → '0 < H몰 < 0' 이 거짓이라 SSG 로 가서 배송지에서 멈췄다)
        own_bad = own_snapshot_problem(snap) if snap is not None else None
        stay = '사람에게 넘긴다' if fallback else '이 사이트로 산다'
        try:
            found = cmp._find_same_product(a)
        except AgentFailure as e:
            self.note('교차 비교', mask_text(f'{sib_src.id} 상품 찾기 실패({e.reason[:60]}) — {stay}'))
            return None
        if not found:
            self.note('교차 비교', f'{sib_src.id} 에 같은 상품 없음 — {stay}')
            return None
        url = str(found.get('product_url'))
        own = float('inf')
        if snap is not None:
            if source_of(self.spec.name).payment_quotes and _as_float(snap.get('cost')) > 0:
                self._apply_payment_quotes(a, str(account), snap)
                snap['_quoted'] = True
            own = _as_float(snap.get('cost'))
            own_bad = own_snapshot_problem(snap)
            if own_bad:
                own = float('inf')
        order2 = a.order.model_copy(
            update={'product_url': url, 'sku': url, 'source': sib_src.id, 'account': None}
        )
        # 찾기가 준 모델코드·진입 링크(H몰 다나와 이동 링크)를 넘긴다 — sku 가 주소로 바뀌어 모델코드를 다시 못 읽는다
        extra = {
            k: str(found.get(k))
            for k in ('model', 'entry_url')
            if str(found.get(k) or '').strip()
        }
        a2 = a.model_copy(
            update={'order': order2, 'options': {**a.options, **extra, 'no_cross': True}}
        )
        try:
            s_acc, s_snap = cmp._pick_cheapest(a2, cmp._candidate_accounts(a2))
            if sib_src.payment_quotes and _as_float(s_snap.get('cost')) > 0:
                cmp._apply_payment_quotes(a2, s_acc, s_snap)
        except AgentFailure as e:
            self.note('교차 비교', mask_text(f'{sib_src.id} 견적 실패({e.reason[:60]}) — {stay}'))
            return None
        other = _as_float(s_snap.get('cost'))
        if fallback:
            own_txt = '견적 없음(봇 차단)'
        elif own_bad:
            own_txt = mask_text(f'{account} 견적 불가({own_bad[:60]})')
        else:
            own_txt = f'{account} {own:,.0f}원'
        self.note('교차 비교', f'{here} {own_txt} vs {sib_src.id} {s_acc} {other:,.0f}원 ({url})')
        a3 = a2.model_copy(update={'order': order2.model_copy(update={'account': s_acc})})
        if not (0 < other < own):
            if other > 0:
                # 이 사이트가 싸서 이 사이트로 산다 — 뒤 단계(배송지·주문서)가 실패하면 이 견적으로 대체 구매한다(_buy)
                self._cross_alt = (sib, a3, other)
            self._log_cross(a, f'{here} 선택 — {here} {own_txt} vs {sib_src.id} {other:,.0f}원')
            return None
        if fallback:
            why = f'{here} 봇 차단 — 대체 경로'
        elif own_bad:
            why = f'{here} 견적 불가 — 대체 경로'
        else:
            why = '더 싸다'
        self.note('교차 비교', f'{sib_src.id} {why} — {sib_src.id} {s_acc} 로 산다')
        self._log_cross(a, f'{sib_src.id} 선택({why}) — {here} {own_txt} vs {sib_src.id} {other:,.0f}원')
        return self._buy_sibling(sib, a3)

    def _buy_sibling(self, sib: 'BuyerAgent', a3: Assignment) -> AgentResult:
        """교차 비교 짝(sib)으로 산다. 이 사이트 근거를 앞에 붙인다."""
        result = sib(a3)
        return result.model_copy(update={'evidence': (*self.evidence, *result.evidence)})

    def _log_cross(self, a: Assignment, text: str) -> None:
        """교차 비교 결론을 하네스 로그에도 남긴다 — 근거(evidence)는 체크포인트에만 있어 로그로는 못 봤다(job 258)."""
        logger.info('%s 교차 비교: %s', a.order.order_no, mask_text(text))

    def _quote_parallel(
        self, a: Assignment, accounts: list[str]
    ) -> list[tuple[str, dict[str, object]]]:
        """계정마다 레인을 붙여 동시에 견적한다. 근거·실패 사유·받은 쿠폰은 계정 순서대로 모은다."""
        import concurrent.futures

        key = source_of(self.spec.name).key

        def run(account: str) -> tuple[str, dict[str, object] | None, 'BuyerAgent']:
            clone = copy.copy(self)
            clone.bridge = self.bridge.with_lane(f'{key}-{account}')
            clone.evidence = []
            clone._quote_errors = []
            clone._quote_skips = []
            clone._last_login = None
            clone._issued = {}
            try:
                return account, clone._quote(a, account), clone
            finally:
                # 견적이 끝난 계정의 탭은 바로 닫는다 — 다음 계정을 보는 동안 열어 두면 탭이 쌓여 리소스를 먹는다
                # (사용자 2026-09-28: 체크한 계정은 닫고 안 쓰는 것도 닫아라). 이긴 계정 주문서는 뒤에서 다시 만든다
                try:
                    clone.tool('run_js', code=_CLOSE_LANE_TABS_JS, safety='no_pay')
                except AgentFailure as e:
                    clone.note('계정 비교', mask_text(f'{account} 레인 탭 정리 실패: {e.reason[:80]}'))

        self.step(f'{self.spec.name}: 계정 {len(accounts)}개 동시 비교')
        # 동시 실행 수 제한 — PC 가 바쁘면 탭 6개를 한꺼번에 띄울 때 페이지 호출이 20초 제한을 넘는다
        # (실기 2026-09-28: ABC 6계정·무신사 4계정 전부 '응답 없음'). SAMBA_ACCOUNT_WORKERS 로 조절한다
        workers = max(1, min(len(accounts), int(os.environ.get('SAMBA_ACCOUNT_WORKERS') or 2)))
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            outs = list(pool.map(run, accounts))
        # 레인이 연 탭(각 계정 주문서)은 run() 이 계정마다 끝나는 즉시 닫았다 — 이긴 계정 주문서를 레인 밖에서
        # 다시 만들 때 저장 스크립트가 다른 계정 주문서를 집지 않는다
        quotes: list[tuple[str, dict[str, object]]] = []
        issued = dict(getattr(self, '_issued', {}))
        for account, q, clone in outs:
            self.evidence.extend(clone.evidence)
            self._quote_errors.extend(clone._quote_errors)
            self._quote_skips.extend(clone._quote_skips)
            issued.update(getattr(clone, '_issued', {}))
            if q is not None:
                quotes.append((account, q))
        self._issued = issued
        return quotes

    def _quick_rank(self, a: Assignment, accounts: list[str]) -> list[str] | None:
        """계정별 빠른 가격(상품 페이지 할인가 − 최대 적립)이 싼 순서로 계정을 세운다. 값을 못 읽은 계정은 뒤(원래 순서).

        빠른 비교가 없는 소싱처, 계정이 하나, 모든 계정의 값을 못 읽음이면 None(주문서로 모두 비교한다).
        같은 값이면 앞 계정(키마스터 결제 우선순위)이 앞선다.
        """
        source = source_of(self.spec.name)
        if not source.quick_compare or len(accounts) < 2 or not a.order.product_url:
            return None
        import concurrent.futures

        def run(account: str) -> tuple[str, float | None]:
            bridge = self.bridge.with_lane(f'{source.key}-q-{account}') if self.parallel_accounts else self.bridge
            try:
                raw = bridge.call(
                    'run_script',
                    name=source.quick_price_script,
                    args=json.dumps({'sku': a.order.product_url, 'profile': account}),
                ).result
                out = json.loads(split_page_dialogs(raw)[0])
            except Exception:  # noqa: BLE001 — 빠른 비교 실패는 주문서 비교로 넘긴다
                return account, None
            if not isinstance(out, dict) or out.get('logged_in') is False:
                return account, None
            price = _as_float(out.get('my_price'))
            if price <= 0:
                return account, None
            return account, price - _as_float(out.get('max_reward'))

        self.step(f'{self.spec.name}: 계정 {len(accounts)}개 빠른 비교(할인가·최대 적립)')
        workers = (
            max(1, min(len(accounts), int(os.environ.get('SAMBA_ACCOUNT_WORKERS') or 2)))
            if self.parallel_accounts
            else 1
        )
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            scores = list(pool.map(run, accounts))
        valid = [(acc, v) for acc, v in scores if v is not None]
        if not valid:
            self.note('빠른 비교', '계정별 값을 못 읽음 — 주문서로 비교한다')
            return None
        # sorted 는 안정 정렬 — 같은 값이면 앞(우선순위 높은) 계정이 앞선다
        ranked = [acc for acc, _ in sorted(valid, key=lambda x: x[1])]
        self._quick_scores = dict(valid)  # 동률 판정(적립금 사용 계정 우선)에 쓴다
        ranked += [acc for acc, v in scores if v is None]
        self.note(
            '빠른 비교',
            ' · '.join(f'{acc} {v:,.0f}' for acc, v in scores if v is not None) + f' → {ranked[0]}',
        )
        return ranked

    def _quote_batch(self, a: Assignment, accounts: list[str]) -> list[tuple[str, dict[str, object]]]:
        """계정들의 견적(레인이 있으면 동시에). 살 수 있는 계정만 돌려준다."""
        if self.parallel_accounts and len(accounts) > 1:
            return self._quote_parallel(a, accounts)
        quotes: list[tuple[str, dict[str, object]]] = []
        for account in accounts:
            q = self._quote(a, account)
            if q is not None:
                quotes.append((account, q))
        return quotes

    def _payable_only(
        self, quotes: list[tuple[str, dict[str, object]]]
    ) -> list[tuple[str, dict[str, object]]]:
        """키마스터에 허용 결제수단의 결제 항목이 있는 계정만 남긴다.

        결제 항목(비밀번호·카드)이 하나도 없는 계정은 살 수 없다(실기 2026-09-25: buyer03 이 최저로 뽑혀
        견적 없이 진행, 엉뚱한 탭·카드로 결제됐다).
        """
        out = []
        for account, q in quotes:
            payable = self._payable_providers(account)
            allowed = self._allowed_providers(account)
            if payable is not None and not (payable & allowed if allowed is not None else payable):
                self.note(
                    '계정 비교', f'{account}: 허용 결제수단의 키마스터 결제 항목 없음 — 비교에서 뺌'
                )
                continue
            out.append((account, q))
        return out

    def _account_reasons_only(self, n_err: int, n_skip: int) -> bool:
        """이번 견적에서 빠진 사유(n_err·n_skip 뒤로 쌓인 것)가 모두 계정 사유인가 — 그러면 다른 계정은 살 수 있다."""
        errors = self._quote_errors[n_err:]
        skips = self._quote_skips[n_skip:]
        if not (errors or skips):
            return False
        # '주문서 옵션 못 읽음'(주문서가 비었다 — "주문할 상품이 존재하지 않습니다")도 계정 사유로 본다:
        # 실기 2026-09-28 무신사 언더웨어·KS4343 은 buyer01 만 주문서가 비고 buyer02 는 열렸다
        return all(is_account_failure(e) for e in errors) and all(
            UNPAYABLE_SKIP in x or ORDER_FORM_UNREADABLE_SKIP in x for x in skips
        )

    def _prefer_points_user(
        self,
        a: Assignment,
        quotes: list[tuple[str, dict[str, object]]],
        ranked: list[str],
        tried: list[str],
    ) -> list[tuple[str, dict[str, object]]]:
        """빠른 비교가 같은 값이고 이긴 계정이 적립금을 못 쓰면(보유 5만원 미만) 같은 값의 다음 계정을 견적해
        적립금을 쓰는 쪽을 고른다(사용자 2026-09-28: buyer01 적립금 5만 미만이면 buyer02 로).

        원가가 같아야 바꾼다(사용 적립금은 원가에 더하므로 원가 자체는 같다). 견적 하나가 더 든다.
        """
        scores: dict[str, float] = getattr(self, '_quick_scores', {}) or {}
        if len(quotes) != 1 or not scores:
            return quotes
        acc, snap = quotes[0]
        if snap.get('points_balance') is None:
            return quotes  # 보유 적립금을 못 읽었으면 판단하지 않는다(모르는 값을 0 으로 보지 않는다)
        used = _as_float(snap.get('points_used'))
        balance = _as_float(snap.get('points_balance'))
        if used > 0 or balance >= POINTS_USE_MIN or acc not in scores:
            return quotes
        tied = [b for b in ranked if b != acc and b not in tried and scores.get(b) == scores[acc]]
        if not tied:
            return quotes
        other = tied[0]
        self.note(
            '계정 전환',
            f'{acc}: 적립금 {balance:,.0f}원(5만 미만)이라 못 쓴다 — 같은 값 {other} 의 적립금 사용을 본다',
        )
        tried.append(other)
        try:
            got = self._payable_only(self._audit_quotes(a, self._quote_batch(a, [other])))
        except AgentFailure as e:
            self.note('계정 전환', mask_text(f'{other}: 견적 불가({e.reason[:60]}) — {acc} 로 산다'))
            return quotes
        if not got:
            return quotes
        acc2, snap2 = got[0]
        if _as_float(snap2.get('points_used')) > 0 and _as_float(snap2.get('cost')) <= _as_float(snap.get('cost')):
            self.note('계정 선택', f'{acc2} — 원가 같고 적립금 {_as_float(snap2.get("points_used")):,.0f}원 사용')
            return got
        self.note('계정 전환', f'{acc2}: 적립금 사용 없음 또는 더 비쌈 — {acc} 로 산다')
        return quotes

    def _pick_cheapest(self, a: Assignment, accounts: list[str]) -> tuple[str, dict[str, object]]:
        """계정마다 견적을 내고 원가가 가장 낮은 계정(같으면 앞 계정)과 그 스냅샷을 고른다.

        빠른 비교가 있는 소싱처는 빠른 가격이 싼 순서로 한 계정씩 주문서를 만든다. 그 계정이 계정 사유
        (구매 수량 한도·로그인 안 됨·결제 항목 없음)로 빠지면 다음으로 싼 계정으로 잇는다 — 다른 계정은 살 수 있다
        (실기 2026-09-27 무신사 가방: buyer01 이 7일 구매 한도에 걸렸는데 나머지 3계정을 시도하지 않았다).
        상품 사유(품절·옵션 없음·스크립트 실패)면 거기서 멈춘다.

        스크립트는 가장 최근 주문서 탭을 읽으므로, 이긴 계정이 마지막으로 연 계정이 아니면
        다시 로그인·스냅샷해서 그 주문서를 최신 탭으로 만든다.
        """
        self._quote_errors = []
        self._quote_skips: list[str] = []
        ranked = self._quick_rank(a, accounts)
        batches = [[acc] for acc in ranked] if ranked else [accounts]
        tried: list[str] = []
        quotes: list[tuple[str, dict[str, object]]] = []
        unpayable = False
        parallel = False
        for batch in batches:
            if tried:
                self.note(
                    '계정 전환', f'{tried[-1]}: 계정 사유로 못 삼 — 다음으로 싼 계정 {batch[0]} 로 잇는다'
                )
            n_err, n_skip = len(self._quote_errors), len(self._quote_skips)
            parallel = self.parallel_accounts and len(batch) > 1
            got = self._quote_batch(a, batch)
            tried.extend(batch)
            if got:
                got = self._payable_only(self._audit_quotes(a, got))
                if got:
                    quotes = self._prefer_points_user(a, got, ranked or [], tried)
                    break
                unpayable = True  # 결제 항목 없음도 계정 사유다 — 다음 계정으로 잇는다
                continue
            if not self._account_reasons_only(n_err, n_skip):
                break
        accounts = tried
        if not quotes:
            if unpayable:
                raise AgentFailure(
                    'needs_human', '결제 항목이 있는 계정이 없다(키마스터)', FailReason.CARD_MISSING
                )
            # 어느 계정도 스냅샷까지 못 갔고 전부 사람 확인(로그인 실패·캡차)이면 그 사유가 맞다 — 품절이 아니다
            errors = self._quote_errors
            if len(errors) == len(accounts) and all(e.status == 'needs_human' for e in errors):
                first = errors[0]
                raise AgentFailure(
                    'needs_human', f'모든 계정 불가 — {first.reason}', first.fail_reason
                )
            # 계정 사유로 빠진 계정 말고는 모두 '주문 옵션이 품절 표시로 떠 있다'면 확정 품절 — 다시 돌려도 같다
            if (
                self._quote_skips
                and all(is_confirmed_sold_out_skip(x) for x in self._quote_skips)
                and all(is_account_failure(e) for e in errors)
            ):
                raise AgentFailure(
                    'fail',
                    mask_text(f'{CONFIRMED_SOLD_OUT}: {", ".join(accounts)} — {self._quote_skips[0]}'),
                    FailReason.OUT_OF_STOCK,
                )
            # 계정별 사유를 함께 남긴다 — 진짜 품절인지 스크립트·로그인 실패인지 가려야 한다(실기: 3건 모두 원인 불명)
            why = (
                '; '.join([e.reason[:60] for e in errors[:4]] + self._quote_skips[:4])
                or '견적 없음'
            )
            # 품절 확증이 없는 실패는 품절이 아니다 — 사람 확인으로 넘긴다
            # (실기 2026-09-28: 옵션 목록을 못 읽은 건들이 out_of_stock 으로 나가 재고X·취소요청이 찍혔다)
            raise AgentFailure(
                'needs_human',
                mask_text(f'모든 계정에서 살 수 없다(품절 미확인·실패): {", ".join(accounts)} — {why}'),
                FailReason.UNKNOWN,
            )
        # min 은 같은 값이면 앞 것을 준다 — 동률이면 먼저 비교한 계정
        winner, snap = min(quotes, key=lambda q: _as_float(q[1].get('cost')))
        cost = _as_float(snap.get('cost'))
        self.note('계정 선택', f'{winner} — 원가 최저 {cost:,.0f}원 (비교 {len(accounts)}계정)')
        if parallel or winner != accounts[-1]:
            # 동시 비교면 이긴 계정의 주문서를 레인 밖(뒤 단계가 보는 곳)에서 다시 만든다
            self._login_as(winner)
            snap = self._snapshot(a, winner)
        return winner, snap

    def _check_account(self, want: str, snap: dict[str, object]) -> None:
        """스냅샷이 로그인 계정을 알려 주면 고른 소싱 계정과 대조한다. 다르면 사람에게 넘긴다.

        실기: 사이트가 아이디 대신 표시 이름(한글 별명 '김사무1')을 돌려주는 곳이 있다 —
        아이디끼리 비교할 때만 불일치로 본다. 표시 이름이면 대조를 못 했다고 남기고 지나간다.
        """
        seen = str(snap.get('account') or '').strip()
        if not (want and seen):
            return
        if want.lower() in seen.lower():
            return
        if not _LOGIN_ID.fullmatch(seen):
            self.note('로그인 계정', f'표시 이름이라 대조 불가: {seen} (주문 계정 {want})')
            return
        raise AgentFailure(
            'needs_human',
            f'다른 계정으로 로그인돼 있다: {seen} (주문 계정 {want})',
            FailReason.PERMISSION_DENIED,
        )

    def _buy(self, a: Assignment) -> AgentResult:
        self.evidence = []
        # 주문마다 비교 기준을 비운다 — 앞 주문의 계정 원가(예: 89,000)가 남아 다음 주문 검사를 잘못 걸었다(실기 2026-09-25)
        self._expect_cost = {}
        self._issued = {}
        # 교차 비교에서 진 짝 사이트 견적(sib, 배정, 원가) — 이 사이트 진행이 실패하면 그것으로 산다
        self._cross_alt: tuple[BuyerAgent, Assignment, float] | None = None
        # 계정 비교(사용자 지시 2026-09-23) — 주문 지정 계정이 없으면 키마스터 계정마다 주문서까지
        # 만들어 원가를 비교하고 가장 싼 계정으로 산다
        accounts = self._candidate_accounts(a)
        try:
            if len(accounts) == 1:
                account = accounts[0]
                self._login_as(account)
                snap = self._snapshot(a, account)
                why = '작업 옵션 지정 계정' if a.options.get('account') else '키마스터의 유일한 계정'
                self.note('계정 선택', f'{account} — {why}')
            else:
                account, snap = self._pick_cheapest(a, accounts)
        except AgentFailure as e:
            # 이 사이트가 봇 차단(SSG PerimeterX)이면 교차 비교 짝(H몰)만 견적해 산다 — 이 사이트는 다시 열지 않는다
            if self.sibling is None or BLOCKED_REASON not in e.reason:
                raise
            self.note('교차 비교', mask_text(f'이 사이트 견적 불가({e.reason[:60]}) — 짝 소싱처만 견적한다'))
            delegated = self._cross_compare(a, None, None)
            if delegated is not None:
                return delegated
            raise

        # 무신사 ↔ 29CM 같은 상품을 같이 비교해 더 싼 쪽에서 산다(사용자 2026-09-24)
        delegated = self._cross_compare(a, account, snap)
        if delegated is not None:
            return delegated
        try:
            return self._buy_here(a, accounts, account, snap)
        except AgentFailure as e:
            # 이 사이트가 싸서 골랐는데 주문서·배송지 단계에서 막혔다 — 결제 전이니 교차 비교 짝 견적으로 대체 구매한다
            # (사용자 2026-09-27: SSG 스냅샷·배송지 실패 시 H몰로). 중복 구매 흔적은 대체하지 않는다
            alt = self._cross_alt
            if alt is None or e.fail_reason is FailReason.DUPLICATE:
                raise
            self._cross_alt = None
            sib, a3, other = alt
            sib_id = source_of(sib.spec.name).id
            here = source_of(self.spec.name).id
            self.note(
                '교차 비교',
                mask_text(f'{here} 진행 실패({e.reason[:60]}) — {sib_id} {a3.order.account} {other:,.0f}원으로 대체 구매'),
            )
            self._log_cross(a, f'{here} 진행 실패 → {sib_id} 대체({e.reason[:60]})')
            return self._buy_sibling(sib, a3)

    def _buy_here(
        self, a: Assignment, accounts: list[str], account: str, snap: dict[str, object]
    ) -> AgentResult:
        """계정·스냅샷을 정한 뒤 이 사이트에서 결제 직전까지 준비한다(옵션·배송지·결제수단)."""
        self._check_account(account, snap)
        if (
            source_of(self.spec.name).payment_quotes
            and not snap.get('_quoted')
            and _as_float(snap.get('cost')) > 0
            and not snap.get('already_ordered')
            and not snap.get('existing_order_no')
        ):
            self._apply_payment_quotes(a, account, snap)
        if snap.get('_unpayable'):
            raise AgentFailure(
                'needs_human',
                f'{account}: 허용 결제수단으로 낼 수 없다(키마스터 결제 항목)',
                FailReason.CARD_MISSING,
            )
        # 같은 상품을 이미 산 흔적 — 옵션 선택 전에 끝낸다(규칙 파일 §3)
        if snap.get('already_ordered') or snap.get('existing_order_no'):
            raise AgentFailure(
                'fail', f'이미 구매한 흔적이 있다: {a.order.sku}', FailReason.DUPLICATE
            )

        options = [str(o) for o in (snap.get('options') or [])]
        if not options and single_item_ok(a.order.option, snap):
            # 옵션 선택란이 없는 단일 상품(프리사이즈 한 가지) — 주문서가 열렸고 색상이 상품명과 맞으면 그 상품이다
            # (실기 2026-09-30 롯데온 노스페이스 힙색 'BLK(BLACK) FREE')
            options = [str(a.order.option)]
            snap['selected'] = a.order.option
            self.note('옵션 목록', f'선택란 없는 단일 상품 — 주문 옵션 [{a.order.option}] 그대로')
        if not options:
            if snapshot_sold_out(snap):
                # 한 계정으로만 산 경우(주문 지정 계정 등)도 상품 전체 품절 표시면 확정 품절 — 다시 돌려도 같다
                raise AgentFailure(
                    'fail',
                    mask_text(f'{CONFIRMED_SOLD_OUT}: {account} — {SOLD_OUT_PRODUCT_SKIP}'),
                    FailReason.OUT_OF_STOCK,
                )
            # 선택지를 하나도 못 읽었고 품절 표시도 없다 — 스크립트가 못 읽은 것이지 품절이 아니다
            raise AgentFailure(
                'needs_human', f'옵션 목록을 못 읽었다(품절 미확인): {a.order.sku}', FailReason.UNKNOWN
            )
        self.note('옵션 목록', ', '.join(options))

        # 주문 옵션과 맞는 후보만 남긴다 — 모델이 "가장 가까운 220" 을 골라 230 주문에 220 을 넣을 뻔했다(실기).
        # 맞는 후보가 없으면 품절, 하나면 그대로, 여럿이면 그 안에서만 모델이 고른다
        candidates = self._match_options(options, a.order.option)
        if not candidates:
            if sold_out_option_listed(options, a.order.option):
                raise AgentFailure(
                    'fail',
                    mask_text(
                        f'{CONFIRMED_SOLD_OUT}: 주문 옵션 [{a.order.option}] 품절 표시 '
                        f'{sold_out_option_matches(options, a.order.option)}'
                    ),
                    FailReason.OUT_OF_STOCK,
                )
            # 목록에 아예 없는 옵션은 품절 확증이 아니다 — 사람 확인
            raise AgentFailure(
                'needs_human',
                f'주문 옵션 [{a.order.option}] 이 선택지에 없다(품절 미확인): {options}',
                FailReason.UNKNOWN,
            )
        if len(candidates) == 1:
            picked = Decision(
                choice=candidates[0], reason=f'주문 옵션 [{a.order.option}] 과 일치하는 후보가 하나'
            )
        else:
            picked = self.decide_once(
                f'{a.rules}\n\n주문 {a.order.order_no} 의 SKU {a.order.sku} 에 맞는 옵션을 고르라.\n'
                f'후보(주문 옵션과 맞는 것만): {candidates}',
                Decision,
            )
        resolved = resolve_choice(picked.choice, candidates)
        if resolved is not None:
            picked = Decision(choice=resolved, reason=picked.reason)
        if picked.choice not in candidates:
            # 2단 옵션(색상 + 사이즈)은 후보가 'BLK'·'95(77)' 처럼 단계별로 따로 온다 — 모델이 둘을 합쳐 답하면
            # 그 조각이 전부 후보에 있을 때 주문 옵션 그대로를 고른 것으로 본다(실기 2026-09-28 SSG 'BLK/95(77)')
            parts = [t for t in re.split(r'[,/·\s]+', picked.choice) if t]
            if len(parts) >= 2 and all(t in candidates for t in parts) and a.order.option:
                picked = Decision(choice=a.order.option, reason=picked.reason)
                candidates = [*candidates, a.order.option]
        if picked.choice not in candidates:
            # 후보 밖을 골랐다 — 품절 확증이 아니라 판정 실패다(사람 확인)
            raise AgentFailure(
                'needs_human', f'고른 옵션이 후보에 없다: {picked.choice}', FailReason.UNKNOWN
            )
        self.note('옵션 선택', f'{picked.choice} — {picked.reason}')

        # 배송지 — 개인정보(이름·주소)라 Assignment/state/payload 에는 절대 담지 않는다.
        # 실행 시점에만 받아 입력 도구 호출에 바로 쓰고 로컬 변수 밖으로 내보내지 않는다.
        self._set_shipping(a, snap, account)

        # 결제수단·카드 — 지시받은 카드가 목록에 없으면 여기서 거절한다
        methods = [str(m) for m in (snap.get('methods') or [])]
        allowed_now = self._allowed_providers(account)
        if allowed_now is not None:
            # 허용 결제수단만 후보(SAMBA_ALLOWED_PAY_PROVIDERS) — 견적이 없을 때도 이 밖은 고르지 않는다
            money_in_pay = source_of(self.spec.name).money_in_pay
            direct_card = source_of(self.spec.name).direct_card
            methods = [m for m in methods if method_providers(m, money_in_pay, direct_card) & allowed_now]
            if not methods:
                raise AgentFailure(
                    'needs_human',
                    f'허용 결제수단({sorted(allowed_now)})이 주문서에 없다',
                    FailReason.CARD_MISSING,
                )
        card = a.options.get('card')
        quoted = snap.get('pay_method')
        card_issuer: str | None = None
        if quoted:
            # 결제수단 견적이 고른 조합 — 수단 이름은 card(결제창 진입용), 카드사는 card_issuer(결제 앱 안에서 고름)
            card = str(quoted)
            card_issuer = str(snap.get('pay_card') or '') or None
            self.note(
                '수단 선택',
                f'{card}{"/" + card_issuer if card_issuer else ""} — 결제수단 견적 최저',
            )
        elif card and card not in methods and source_of(self.spec.name).pay_provider and methods:
            # 결제수단이 하나로 고정된 소싱처(ABC마트 = 네이버페이) — 지정 카드는 그 수단 안에서 고르는 카드사다
            card_issuer = str(card)
            card = methods[0]
            self.note('수단 선택', f'{card}/{card_issuer} — 소싱처 고정 결제수단 안의 지정 카드')
        elif card and card not in methods:
            raise AgentFailure(
                'fail', f'지시받은 카드가 결제수단에 없다: {card}', FailReason.CARD_MISSING
            )
        only = ACCOUNT_PAY_ONLY.get(account.split('@')[0].lower())
        if only and not quoted and not card and not any(quote_provider(m) in only for m in methods):
            # 결제수단이 정해진 계정(buyer02 = 무신사머니)인데 견적이 없고 그 수단이 주문서에 따로 없다 —
            # 모델에게 고르게 하면 간편결제 기본 카드로 결제될 수 있다(실기 2026-09-25 롯데카드 모자 주문)
            raise AgentFailure(
                'needs_human',
                f'{account} 는 {sorted(only)} 로만 결제하는데 견적이 없어 수단을 확정하지 못했다',
                FailReason.CARD_MISSING,
            )
        if quoted:
            pass
        elif not card and any(quote_provider(m) == 'site' for m in methods):
            card = next(m for m in methods if quote_provider(m) == 'site')
            self.note('수단 선택', f'{card} — 견적 없음, 사이트 머니 기본(무신사머니)')
        elif not card:
            chosen = self.decide_once(
                f'{a.rules}\n\n결제수단 후보 {methods} 중 원가 규칙에 가장 맞는 것을 고르라.',
                Decision,
            )
            if chosen.choice not in methods:
                raise AgentFailure(
                    'fail', f'고른 수단이 목록에 없다: {chosen.choice}', FailReason.CARD_MISSING
                )
            card = chosen.choice
            self.note('수단 선택', f'{card} — {chosen.reason}')
        else:
            self.note('수단 선택', f'{card} — 요청자가 지정')

        cost = _as_float(snap.get('cost'))
        # 실제 결제액(적립·배송비 보정 전) — 스냅샷이 주면 기록 메모에 싣는다. 0 이면 모름
        paid = float(snap.get('pay_amount') or 0)
        # 마진은 삼바에 기록할 배송비(포이즌 외 까대기 2,300원)까지 넣고 본다 — 빼고 보면 −0.5% 적자 건이
        # +1.3~1.6% 로 보여 결제됐다(실기 2026-09-26 174·181)
        fee = shipping_fee_for(a.order, self.order_type_of(a.order, snap))
        margin = self._margin(a.order, cost + fee, float(snap.get('margin_pct') or 0))
        self.step(f'{self.spec.name}: 결제 직전까지 준비 완료')
        # 실제로 산 상품 번호 — 스냅샷 값 우선, 없으면 이 사이트 상품 주소(교차 비교면 order2 의 이 사이트 주소)
        pno = str(snap.get('product_no') or '') or product_no_of(a.order.product_url)
        return AgentResult(
            status='ok',
            reason=(
                f'옵션 {picked.choice}({picked.reason}), 계정 {account}, 배송지 반영, '
                f'카드 {card}, 원가 {cost:,.0f}원, 마진 {margin}%'
            ),
            payload={
                'option': picked.choice,
                'account': account,
                # 실제로 산 소싱처 — 교차 비교로 다른 사이트에서 샀을 수 있다. 결제·기록·검증이 이 사이트 기준으로 일한다
                'buy_source': source_of(self.spec.name).id,
                'accounts_compared': len(accounts),
                'shipping_set': True,
                'order_type': self.order_type_of(a.order, snap),
                'shipping_fee': shipping_fee_for(a.order, self.order_type_of(a.order, snap)),
                'card': card,
                **({'card_issuer': card_issuer} if card_issuer else {}),
                'cost': cost,
                'margin_pct': margin,
                **({'paid': paid} if paid > 0 else {}),
                **({'points_used': snap.get('points_used')} if snap.get('points_used') is not None else {}),
                **({'reward': snap.get('reward')} if snap.get('reward') is not None else {}),
                # 결제 진입이 주문서를 대조·지정하는 데 쓴다(주문서에 담긴 옵션 글자, 스냅샷이 만든 주문서 탭 id)
                **({'selected': str(snap.get('selected'))} if snap.get('selected') else {}),
                **({'order_tab': str(snap.get('order_tab'))} if snap.get('order_tab') else {}),
                # 실제로 산 상품의 번호·이름 — 교차 비교로 다른 사이트에서 사면 원래 주문 URL·상품명과 다르다.
                # 결제 진입 대조(expect.product_no·name)가 이걸 먼저 쓴다(2026-09-26 29CM 리뷰 차단2)
                **({'product_no': pno} if pno else {}),
                **({'product_name': str(snap.get('product_name'))} if snap.get('product_name') else {}),
                # 진입 경로(SSG 직접·애드픽 …)와 애드픽 적립 — 경로 비교를 한 소싱처만 싣는다
                **({'route': str(snap.get('route'))} if snap.get('route') else {}),
                # 결제 진입 대조(expect.product_url) — 지정 몰·경로 비교 소싱처(SSG)만. 스냅샷이 도착한 상품 주소
                **(
                    {'product_url': str(snap.get('product_url'))}
                    if snap.get('product_url')
                    and (
                        source_of(self.spec.name).mall_item
                        or source_of(self.spec.name).route_compare
                        or source_of(self.spec.name).entry_route
                    )
                    else {}
                ),
                **({'adpick_reward': snap.get('adpick_reward')} if snap.get('adpick_reward') else {}),
            },
            evidence=tuple(self.evidence),
        )

    def _margin(self, order: OrderRef, cost: float, snap_margin: float) -> float:
        """마진율(플레이북 §3) = (SAMBA 정산금 − 원가) ÷ SAMBA 매출 × 100.

        스냅샷은 우리 판매가를 모른다 — 정산금이 있으면 늘 그것으로 계산한다. 정산금을 모르면
        스냅샷 값이 없을 때만 판매가 기준 근사치 (판매가 − 원가) ÷ 판매가 를 쓰고 근거에 남긴다.
        """
        sale = order.sale_price
        if cost <= 0 or sale <= 0:
            return snap_margin
        if order.revenue > 0:
            margin = round((order.revenue - cost) / sale * 100, 1)
            self.note(
                '마진 계산',
                f'(정산금 {order.revenue:,.0f} - 원가 {cost:,.0f}) ÷ 매출 {sale:,.0f} → {margin}%',
            )
            return margin
        if snap_margin > 0:
            return snap_margin
        margin = round((sale - cost) / sale * 100, 1)
        self.note(
            '마진 계산',
            f'판매가 {sale:,.0f} - 원가 {cost:,.0f} → {margin}% (정산금 미확인 근사)',
        )
        return margin

    def set_shipping_provider(self, provider: ShippingFn | None) -> None:
        """배송지 공급자(삼바웨이브 상세)를 꽂는다. 배선은 factory 가 한다.

        직배·선물 주문의 고객 이름·주소를 앱 화면을 거치지 않고 받는다. 까대기는 계정 기본
        배송지(사무실)를 유지하므로 공급자를 부르지 않는다(플레이북 §4).
        """
        self._shipping_fn = provider

    def order_type_of(self, order: OrderRef, snap: dict[str, object] | None = None) -> str:
        """이 주문의 배송 종류(decide_order_type). 정할 수 없으면 사람에게 넘긴다.

        삼바웨이브 태그는 이 판정의 **결과**로 기록되는 값이지 입력이 아니다(사용자 설명 2026-09-24).
        """
        source = source_of(self.spec.name)
        forced = source.order_type
        if source.gift_unless_poison and not forced:
            # 롯데온·SSG: 포이즌·라자다 배대지는 사무실 수령(까대기), 그 밖은 전부 선물하기 — 정가 비교 없이 정해진다
            # (사용자 2026-09-27 롯데온, 2026-09-29 SSG "까대기 제외하고 선물하기")
            forced = 'kkadaegi' if is_poison_seller(order.seller) or self._is_forwarder(order) else 'gift'
        forwarder = not forced and self._is_forwarder(order)
        if not source.normal_price and not forced and not is_poison_seller(order.seller) and not forwarder:
            # 정가 스크립트가 없는 소싱처는 아직 자동 판정을 못 한다 — 삼바웨이브 태그(order_type)를 따른다
            return order.order_type
        normal = _as_float(snap.get('normal_price')) if snap else 0.0
        kind, why = decide_order_type(order, normal if normal > 0 else None, forced, forwarder)
        if not kind:
            raise AgentFailure('needs_human', f'직배/까대기 판정 불가 — {why}', FailReason.UNKNOWN)
        if self._order_type_noted != (order.order_no, kind):
            self._order_type_noted = (order.order_no, kind)
            self.note(
                '배송 종류',
                f'{"까대기" if kind == "kkadaegi" else "선물" if kind == "gift" else "직배"} — {why}',
            )
        return kind

    def _is_forwarder(self, order: OrderRef) -> bool:
        """받는 곳이 라자다 해외 배대지인가(수취인·주소에 LAZADA). 포이즌·선물은 보지 않는다.

        삼바웨이브 배송지를 주문당 한 번만 읽고 참/거짓만 남긴다(원문은 담지 않는다).
        """
        if self._shipping_fn is None or is_poison_seller(order.seller) or order.order_type == 'gift':
            return False
        seen = self._forwarder_seen if self._forwarder_seen is not None else {}
        self._forwarder_seen = seen
        if order.order_no not in seen:
            try:
                shipping = self._shipping_fn(order.order_no, 'direct')
            except (WaveError, AgentFailure):
                return False  # 못 읽으면 기존 판정대로 — 직배 입력 단계에서 다시 멈춘다
            text = ' '.join(str(shipping.get(k) or '') for k in ('name', 'address', 'address_detail'))
            seen[order.order_no] = 'lazada' in text.lower()
        return seen[order.order_no]

    def _fetch_shipping(self, a: Assignment, snap: dict[str, object]) -> dict[str, object]:
        """배송지 출처 — 삼바웨이브(공급자) > 스냅샷에 실려 온 값 > 전용 스크립트 순.

        어느 경로든 받은 값은 이 호출 안에서만 살아 있다(호출부가 바로 입력하고 버린다).
        """
        if self._shipping_fn is not None:
            try:
                fetched = self._shipping_fn(a.order.order_no, self.order_type_of(a.order, snap))
            except WaveError as e:
                raise AgentFailure('fail', f'배송지 조회 실패: {e}', e.reason) from e
            if fetched:
                return fetched
        embedded = snap.get('shipping')
        if isinstance(embedded, dict) and embedded:
            return embedded
        fetched = self.json_tool(
            'run_script', name=SHIPPING_SCRIPT, args=f'{{"order_no":"{a.order.order_no}"}}'
        )
        shipping = fetched.get('shipping')
        return shipping if isinstance(shipping, dict) else fetched

    def _set_shipping(self, a: Assignment, snap: dict[str, object], account: str) -> None:
        """배송지 — 까대기면 기본 배송지를 유지하고, 직배·선물이면 고객 이름·주소를 새로 넣는다.

        원문은 이 함수 밖으로 나가지 않는다 — self.note 에는 마스킹된 요약만 남긴다.
        """
        if self.order_type_of(a.order, snap) == 'kkadaegi':
            if self._keep_default_shipping(snap):
                return
            # 기본 배송지가 사무실이 아니다(또는 없다) — 목록에 사무실 배송지가 있으면 그것을 고르고,
            # 없을 때만 사무실 주소를 새로 넣는다. 기본 배송지 자체는 바꾸지 않는다(poizon-sourcing 스킬 "사무실 배송")
            if self._select_existing_shipping(dict(OFFICE_SHIPPING), account):
                return
            self.note('배송지', '목록에 사무실 배송지가 없어 사무실 주소를 새로 넣는다')
            self._apply_shipping(a, dict(OFFICE_SHIPPING), account)
            return

        if source_of(self.spec.name).key == 'ssg' and self.order_type_of(a.order, snap) == 'gift':
            self._ssg_gift(a, snap, account)
            return

        shipping = self._fetch_shipping(a, snap)
        # 직배·선물도 같은 배송지가 이미 목록에 있으면 고른다 — 재시도마다 같은 주소가 새로 저장되던 것을 막는다
        # (실기 2026-09-27: 29CM·무신사 주소록에 같은 고객 주소가 4개 쌓임)
        if self._select_existing_shipping(dict(shipping), account):
            return
        self._apply_shipping(a, shipping, account)

    def _ssg_gift(self, a: Assignment, snap: dict[str, object], account: str) -> None:
        """SSG 선물하기(사용자 2026-09-29 "까대기 제외하고 선물하기", 수동 성공 2건 이식).

        스냅샷은 바로구매 주문서로 원가를 읽는다 — 그 주문서를 닫고 스냅샷이 도착한 상품 주소(애드픽 경유면 그 주소)를
        '선물'로 다시 열어 받는 분을 고객으로 지정한 선물 주문서로 바꿔 탄다. 결제는 그 주문서(snap['order_tab'])로 한다.
        고객 이름·주소는 스크립트 인자로만 지나가고 결과·기록에는 남지 않는다.
        """
        shipping = self._fetch_shipping(a, snap)
        if not (shipping.get('name') and shipping.get('address')):
            raise AgentFailure('needs_human', '선물 받는 분 배송지를 받지 못했다', FailReason.UNKNOWN)
        url = str(snap.get('product_url') or a.order.product_url or '')
        option = str(snap.get('selected') or a.order.option or '')
        self._close_order_tabs(account)
        enter_args = json.dumps(
            {'product_url': url, 'option': option, **({'profile': account} if account else {})},
            ensure_ascii=False,
        )
        entered = self.json_tool('run_script', name=SSG_GIFT_ENTER_SCRIPT, args=enter_args)
        if entered.get('error') == 'login_required' and entered.get('login_popup') and account:
            # '선물'이 로그인 팝업을 띄웠다 — 그 팝업에서 이 계정으로 로그인하고 한 번만 다시 연다
            self.tool('switch_tab', id=str(entered.get('login_popup')))
            self.tool('login', accountLabel=account)
            self._close_product_tabs(account, url)
            entered = self.json_tool('run_script', name=SSG_GIFT_ENTER_SCRIPT, args=enter_args)
        if not entered.get('ok'):
            reason = FailReason.OUT_OF_STOCK if entered.get('error') == 'sold_out' else FailReason.UNKNOWN
            raise AgentFailure(
                'needs_human', f'SSG 선물 진입 실패: {mask_text(str(entered.get("note"))[:100])}', reason
            )
        who = {
            'name': shipping.get('name'),
            'address': shipping.get('address'),
            'address_detail': shipping.get('address_detail') or '',
        }
        who_args = json.dumps(who, ensure_ascii=False)
        placed = self.json_tool('run_script', name=SSG_GIFT_ADDRESS_SCRIPT, args=who_args)
        new_addr = bool(placed.get('need_address'))
        if new_addr:
            # 주소록에 없는 고객 — 열어 둔 목록 팝업에서 새로 저장(전화는 키마스터 신원정보)하고 다시 고른다
            applied = self._run_set_shipping(
                shipping, {**who, 'gift': True, **({'profile': account} if account else {})}
            )
            if not applied.get('ok'):
                raise AgentFailure(
                    'needs_human',
                    f'선물 받는 분 주소 저장 실패: {mask_text(str(applied.get("note") or "")[:80])}',
                    FailReason.UNKNOWN,
                )
            self._fill_phone(applied)
            saved = self.json_tool('run_script', name=SSG_GIFT_SAVE_SCRIPT, args='{}')
            if not saved.get('ok'):
                raise AgentFailure(
                    'needs_human', f'선물 받는 분 주소 저장 실패: {saved.get("note")}', FailReason.UNKNOWN
                )
            placed = self.json_tool('run_script', name=SSG_GIFT_ADDRESS_SCRIPT, args=who_args)
        if not placed.get('ok') or not placed.get('gift') or not placed.get('order_tab'):
            raise AgentFailure(
                'needs_human',
                f'선물 받는 분 지정 실패: {mask_text(str(placed.get("note"))[:100])} '
                f'(주소록 {placed.get("entries")}개, 일치 {placed.get("matched")}개)',
                FailReason.UNKNOWN,
            )
        amount = _as_float(placed.get('amount'))
        cost = _as_float(snap.get('pay_amount') or snap.get('cost'))
        if amount and cost and amount > cost + 1:
            # 견적(바로구매 주문서)보다 선물 주문서가 비싸다 — 마진 판단이 틀어지므로 결제하지 않는다
            raise AgentFailure(
                'needs_human',
                f'선물 주문서 금액 {amount:,.0f}원이 견적 {cost:,.0f}원보다 크다 — 결제하지 않음',
                FailReason.MARGIN,
            )
        # 로그인이 풀린 채 결제하면 주문이 안 생긴다(실기 2026-09-29) — 결제 전에 세션을 확인한다
        check = self.json_tool(
            'run_script',
            name=SSG_LOGIN_CHECK_SCRIPT,
            args=json.dumps(
                {'back_tab': placed['order_tab'], **({'profile': account} if account else {})}
            ),
        )
        if not check.get('logged_in'):
            raise AgentFailure(
                'needs_human', 'SSG 로그인이 풀려 있다 — 선물 주문서까지 만들었지만 결제하지 않음', FailReason.UNKNOWN
            )
        snap['order_tab'] = str(placed['order_tab'])
        self.note(
            '배송지',
            f'선물하기 — 받는 분 지정·주문서 금액 {amount:,.0f}원'
            + (' · 주소록에 새로 저장' if new_addr else ''),
        )

    def _select_existing_shipping(self, shipping: dict[str, object], account: str) -> bool:
        """배송지 목록에서 이미 있는 항목(이름·주소)을 골라 주문서에 반영한다(`<key>_select_shipping`).

        스크립트가 없거나 목록에 없으면 False — 호출부가 신규 입력으로 넘어간다. 실기: 사무실 주소가 이미 있는데
        새 배송지를 만들고 나서 기존 것을 고르던 낭비(사용자 지적 2026-09-24).
        """
        source = source_of(self.spec.name)
        args = {
            'name': shipping.get('name'),
            'address': shipping.get('address'),
            'address_detail': shipping.get('address_detail'),
        }
        if account:
            args['profile'] = account
        try:
            out = self.script_json(
                f'{source.key}_select_shipping',
                args,
                goal=(
                    '주문서 배송지 변경 목록에서 이름·주소가 args 와 같은 기존 배송지를 골라 주문서에 반영하고, '
                    '반영된 이름·주소를 되읽어 ok:true 와 함께 돌려준다. 목록에 정말 없을 때만 ok:false. 새 배송지는 만들지 않는다.'
                ),
                check=lambda o: (
                    None
                    if o.get('ok') and shipping_matches(shipping, o)
                    else f'기존 배송지 선택 실패: note={o.get("note")}'
                ),
            )
        except AgentFailure as e:
            self.note('배송지', mask_text(f'기존 항목 선택 불가({e.reason[:60]}) — 신규 입력으로'))
            return False
        if not out.get('ok') or not shipping_matches(shipping, out):
            self.note(
                '배송지',
                mask_text(
                    f'기존 항목 선택 실패({str(out.get("note") or "")[:60]}) — 신규 입력으로'
                ),
            )
            return False
        self.note('배송지', '목록의 기존 배송지를 골라 주문서에 반영')
        return True

    def _apply_shipping(self, a: Assignment, shipping: dict[str, object], account: str) -> None:
        """이름·주소를 배송지 스크립트로 넣고 되읽어 대조한다. 원문은 이 함수 밖으로 나가지 않는다."""
        # 이름·주소만 넘긴다 — phone 키는 출처가 어디든 버린다
        args: dict[str, object] = {
            f: shipping[f] for f in SHIPPING_ARG_FIELDS if shipping.get(f) is not None
        }
        if not (args.get('name') and args.get('address')):
            raise AgentFailure('needs_human', '배송지를 받지 못했다', FailReason.UNKNOWN)
        if account:
            args['profile'] = account

        applied = self._run_set_shipping(shipping, args)
        # 주소 검색 팝업이 첫 시도에 안 뜨는 사이트가 있다(실측 2026-09-29 SSG: 첫 시도 '우편번호 팝업 안 뜸',
        # 팝업을 닫고 다시 부르면 뜬다) — 팝업을 닫고 두 번까지 다시 넣는다
        for _retry in (1, 2):
            if shipping_matches(shipping, applied) or '팝업 안 뜸' not in str(applied.get('note') or ''):
                break
            self.note('배송지', f'주소 검색 팝업이 안 떠 다시 시도({_retry}/2)')
            self._close_popups()
            applied = self._run_set_shipping(shipping, args)
        # 원문끼리 비교하지 않는다 — 마스킹한 값끼리만 비교해서 판단에도 개인정보를 안 남긴다
        if not shipping_matches(shipping, applied):
            # 스크립트가 남긴 사유(note)를 붙인다 — 예전엔 사유 없이 멈춰 비교 오탐인지 스크립트 실패인지 몰랐다(job 207)
            # note 가 없으면 오류 코드(name-input-nf 등)라도 남긴다 — 사유 없는 실패는 원인을 못 가른다(실기 2026-09-29)
            note = str(applied.get('note') or applied.get('error') or '').strip()
            raise AgentFailure(
                'needs_human',
                '배송지 입력 검증에 실패했다' + (f': {mask_text(note[:80])}' if note else ''),
                FailReason.UNKNOWN,
            )
        self._fill_phone(applied)
        self._confirm_shipping(shipping, args)
        # 마스킹 규칙이 이름을 가리려면 라벨이 앞에 있어야 한다(ops.masking) — 라벨을 붙여서 가린다
        summary = f'수취인 {shipping.get("name", "")} · {shipping.get("address", "")}'
        self.note('배송지', f'반영 완료 — {mask_text(summary)}')

    def _close_popups(self) -> None:
        """이 레인의 팝업 창을 닫는다(주소 검색·배송지 폼이 남아 다음 시도를 막는다). 실패는 무시한다."""
        try:
            tabs = json.loads(self.tool('list_tabs'))
        except (AgentFailure, ValueError):
            return
        rows = [t for t in tabs if isinstance(t, dict)] if isinstance(tabs, list) else []
        for t in rows:
            if t.get('kind') == 'popup' and t.get('id'):
                try:
                    self.tool('close_tab', id=str(t['id']))
                except AgentFailure:
                    pass
        # 팝업을 닫으면 현재 탭이 비는 일이 있다 — 주문서 탭(마지막 일반 탭)을 다시 현재 탭으로 잡는다
        pages = [t for t in rows if t.get('kind') != 'popup' and t.get('id')]
        if pages:
            try:
                self.tool('switch_tab', id=str(pages[-1]['id']))
            except AgentFailure:
                pass

    def _run_set_shipping(
        self, shipping: dict[str, object], args: dict[str, object]
    ) -> dict[str, object]:
        """배송지 입력 스크립트를 한 번 돌린다."""
        return self.script_json(
            source_of(self.spec.name).set_shipping_script,
            args,
            goal=(
                '주문서 배송지(새 배송지·직접 입력)에 args 의 name·address(·address_detail·postal_code)를 입력하고, '
                '입력된 이름·주소를 되읽어 {"name","address"} 로 돌려준다. 전화 칸은 비워 두고 그 요소 번호를 '
                'phone_field_id(칸 하나) 또는 phone_field_ids(2~3칸, 앞→뒤)로 돌려준다 — 번호는 하네스가 따로 채운다. '
                '주소 검색 팝업이 있으면 우편번호·주소를 검색해 고른다.'
            ),
            check=shipping_set_problem(shipping),
        )

    def _confirm_shipping(self, shipping: dict[str, object], args: dict[str, object]) -> None:
        """팝업 폼 사이트는 전화까지 채운 폼을 저장/적용해야 주문서에 반영된다(sources.yaml shipping_confirm).

        확정 스크립트가 주문서에서 되읽은 수취인·주소가 넣은 값과(마스킹 기준) 같아야 통과한다.
        """
        spec = source_of(self.spec.name)
        if not spec.shipping_confirm:
            return
        confirmed = self.script_json(
            spec.confirm_shipping_script,
            {k: v for k, v in args.items() if k in ('name', 'address', 'profile')},
            goal='배송지 폼을 저장·적용해 주문서에 반영하고, 주문서에서 되읽은 이름·주소를 ok:true 와 함께 돌려준다.',
            check=lambda o: (
                None
                if o.get('ok') and shipping_matches(shipping, o)
                else f'확정 실패: note={o.get("note")}'
            ),
        )
        if not confirmed.get('ok') or not shipping_matches(shipping, confirmed):
            # 저장은 됐는데(사이트 '등록 완료') 목록에서 방금 항목을 못 찾은 경우 — 기존 배송지 선택으로 한 번 더 고른다
            # (실기 2026-09-30 롯데온 선물: 다시 돌리면 선택으로 통과했다)
            account = str(args.get('profile') or '')
            note = str(confirmed.get('note') or '')
            if ('저장 뒤 목록에 없음' in note or '주문서에 받는 분' in note) and self._select_existing_shipping(
                dict(shipping), account
            ):
                self.note('배송지 확정', '저장 뒤 목록 확인을 놓쳐 기존 배송지 선택으로 반영')
                return
            raise AgentFailure(
                'needs_human',
                f'배송지 확정 검증에 실패했다: {mask_text(str(confirmed.get("note", ""))[:80])}',
                FailReason.UNKNOWN,
            )
        self.note('배송지 확정', '폼 저장 후 주문서 되읽기 일치')

    def _keep_default_shipping(self, snap: dict[str, object]) -> bool:
        """까대기 — 계정 기본 배송지가 사무실이면 그대로 두고 True(플레이북 §4-2).

        배송지 스크립트를 부르지 않고 주문서에 수령인·주소가 비어 있지 않은지만 본다.
        스냅샷이 주문서 배송지를 실어 주면 그것으로, 아니면 화면(get_page)으로 확인한다.
        비어 있거나 사무실이 아니면 False — 호출부가 사무실 주소를 주문 배송지로 넣는다.
        """
        embedded = snap.get('shipping')
        if isinstance(embedded, dict) and embedded:
            filled = all(str(embedded.get(f) or '').strip() for f in SHIPPING_FIELDS)
            # 주소만 사무실이고 수령인이 다르면(실기: 김가명) 사무실 배송지가 아니다 — 수령인까지 같아야 한다
            addr = f'{embedded.get("address") or ""} {embedded.get("address_detail") or ""}'
            office = (
                OFFICE_ADDRESS_HINT in addr
                and _norm(OFFICE_DETAIL) in _norm(addr)
                and _norm(str(embedded.get('name') or '')) == _norm(OFFICE_NAME)
            )
        else:
            page = self.tool('get_page')
            office = office_block_in(page)
            # 주문서의 배송지 영역은 늦게 그려진다(실기 2026-09-29 롯데온: 기본 배송지가 사무실인데 못 읽어
            # 새 배송지를 넣으려다 멈췄다) — 사무실이 안 보이면 몇 번 더 읽는다
            for _ in range(DEFAULT_SHIPPING_POLL_TRIES):
                if office:
                    break
                self.tool('wait', ms=DEFAULT_SHIPPING_POLL_MS)
                page = self.tool('get_page')
                office = office_block_in(page)
            # 사무실 주소가 보이면 채워진 것이다 — 무신사 주문서엔 '받는 분' 문구가 없다(실기: 새 배송지를 또 만듦)
            filled = office or (
                any(m in page for m in RECIPIENT_MARKERS)
                and not any(m in page for m in EMPTY_SHIPPING_MARKERS)
            )
        if not (filled and office):
            return False
        self.note('배송지', '사무실 수령(기본 배송지 유지)')
        return True

    def _fill_phone(self, applied: dict[str, object]) -> None:
        """배송 연락처 — 스크립트가 비워 둔 전화 칸을 앱이 키마스터 신원정보로 채운다.

        번호는 하네스를 지나가지 않는다. 앱 결과는 성공이면 'ok…', 아니면 'refused: …'·'not found: …'.
        """
        # 스크립트는 phone_field_id(칸 하나) 또는 phone_field_ids(1~3칸, 앞→뒤 순서)로 알린다.
        # 칸이 둘이면 010 은 사이트가 고정한 것이라 가운데·끝, 셋이면 앞·가운데·끝을 앱이 나눠 넣는다
        raw_ids = applied.get('phone_field_ids')
        ids = (
            _int_ids(raw_ids)
            if isinstance(raw_ids, list)
            else _int_ids([applied.get('phone_field_id')])
        )
        if not ids or len(ids) > 3:
            raise AgentFailure('needs_human', '전화 칸을 찾지 못함', FailReason.UNKNOWN)
        # 칸 하나면 앱이 저장된 번호 그대로 넣는다(format 없음). 둘·셋이면 부분 형식을 준다
        formats: list[str | None] = {
            1: [None],
            2: ['phone-mid', 'phone-last'],
            3: ['phone-first', 'phone-mid', 'phone-last'],
        }[len(ids)]
        # 칸 모양이 위 기본과 다르면 스크립트가 phone_formats 로 알린다(칸 수만큼, 앱이 아는 형식만).
        # 슈마커: 010 은 고르는 칸이고 나머지 8자리가 한 칸 → ['phone-rest'](실기 2026-09-26)
        declared = applied.get('phone_formats')
        if (
            isinstance(declared, list)
            and len(declared) == len(ids)
            and all(f is None or f in PHONE_FILL_FORMATS for f in declared)
        ):
            formats = [str(f) if f else None for f in declared]
        for field_id, fmt in zip(ids, formats, strict=True):
            try:
                out = self.tool(
                    'fill_secret',
                    elementId=field_id,
                    itemType=PHONE_SECRET_ITEM,
                    field=PHONE_SECRET_FIELD,
                    **({'format': fmt} if fmt else {}),
                )
            except AgentFailure as e:
                raise AgentFailure(
                    'needs_human', f'배송 연락처 입력 실패: {e.reason}', e.fail_reason
                ) from e
            if not out.strip().lower().startswith('ok'):
                raise AgentFailure(
                    'needs_human',
                    f'배송 연락처 입력 실패: {mask_text(out.strip()[:100])}',
                    FailReason.UNKNOWN,
                )
        self.note(
            '배송 연락처', f'키마스터 신원정보로 입력({len(ids)}칸, 번호는 하네스가 보지 않는다)'
        )


class ScriptsPendingBuyer:
    """저장 스크립트가 아직 없는 소싱처(sources.yaml status: scripts_pending)의 구매 에이전트.

    등록부에는 행이 있어야 한다 — 없으면 감독자가 'unsupported' 로만 말해 준비가 어디까지 됐는지
    알 수 없다. 그래서 만들어는 두고, 부르면 곧바로 사람에게 넘긴다.
    """

    def __init__(self, spec: AgentSpec, source: Source) -> None:
        self.spec = spec
        self.source = source

    def __call__(self, assignment: Assignment) -> AgentResult:
        return AgentResult(
            status='needs_human',
            reason=f'스크립트 미작성: {self.source.id}',
            fail_reason=FailReason.UNKNOWN,
        )
