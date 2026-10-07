"""소싱처 표(sources.yaml). 새 소싱처 = 여기 1행이면 등록부·스크립트 이름·상품 ID 규칙이 따라온다.

한 줄 요약: `id` 는 삼바웨이브 `source_site` 값, `key` 는 앱 저장 스크립트 이름의 접두어,
`label` 은 사람이 보는 한글 이름이다. 조회 결과가 한글 이름으로 와도 이 표를 거쳐 id 로 맞춘다.
"""

import re
from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict

from samba_agent import local_aliases
from samba_agent.settings import DEFAULT_ROOT

SOURCES_FILE = 'sources.yaml'

# active: 저장 스크립트가 다 있다 · scripts_pending: 등록은 하되 구매를 시작하면 사람에게 넘긴다
# hold: 아예 등록하지 않는다(감독자가 unsupported 로 넘긴다)
SourceStatus = Literal['active', 'scripts_pending', 'hold']


class Source(BaseModel):
    """소싱처 1행. 모르는 필드(오타)는 조용히 버리지 않고 로딩을 거부한다."""

    model_config = ConfigDict(extra='forbid')

    id: str  # 삼바웨이브 source_site 값(MUSINSA·29CM·ABCmart·…)
    key: str  # 스크립트 접두어: <key>_product_snapshot · <key>_set_shipping · checkout_enter_<key>
    label: str  # 표시·별칭(조회 결과의 '무신사' 도 이 id 로 정규화된다)
    home: str | None = None  # 로그인 확인을 시작할 첫 페이지. 모르면 비워 둔다
    login_host: str | None = None
    product_id: str | None = None  # 상품 URL 에서 스냅샷 sku 로 넘길 ID 정규식(없으면 URL 그대로)
    # 이름 규칙을 벗어나는 결제창 진입 스크립트(29CM 는 checkout_enter_29cm 로 이미 저장돼 있다)
    checkout_script: str | None = None
    status: SourceStatus = 'active'
    # 배송지를 팝업 폼에 넣는 사이트(무신사·SSG 등)는 전화까지 채운 뒤 폼을 저장/적용해야 주문서에 반영된다 —
    # True 면 배송 연락처 입력 뒤 `<key>_confirm_shipping` 을 부른다
    shipping_confirm: bool = False
    # False 면 계정 비교(여러 계정으로 견적)를 하지 않는다 — 계정을 연달아 바꿔 로그인하면 차단하는 사이트(실기: SSG)
    compare_accounts: bool = True
    # 플레이북이 정한 구매 계정(§5·§7: 무신사는 buyer01 한 계정). 비어 있지 않으면 SAMBA 주문계정·계정 비교를 쓰지 않고
    # 이 목록 순서대로 견적한다. fallback_account 는 앞 계정이 결제 불가(잔액 부족 등)일 때만 쓰는 대체 계정
    buy_accounts: list[str] = []
    fallback_account: str | None = None
    # True 면 주문서에서 결제수단(카드사 포함)마다 결제예정금액을 읽는 `<key>_payment_quotes` 로 견적을 내고
    # 계정×결제수단 가운데 가장 싼 조합으로 산다(사용자 지시 2026-09-23)
    payment_quotes: bool = False
    # True 면 `<key>_normal_price` 로 소싱처 정가(세일 전 정상가)를 읽는다 — 포이즌 외 마켓의 직배/까대기 판정에 쓴다
    # (정가 < 고객 결제액 → 까대기, 정가 > 고객 결제액 → 직배; poizon-sourcing 스킬 규칙)
    normal_price: bool = False
    # True 면 로그인 도구가 로그인 상태를 못 알아볼 때 `<key>_signed_in` 으로 다시 본다
    # (로그인해도 상단에 '로그인' 링크가 남는 슈마커 — 2026-09-26)
    signed_in_check: bool = False
    # 사이트 '간편결제'에 등록된 카드사 — 견적 줄에 카드가 없으면 이 카드로 보고 청구할인을 반영한다(슈마커 = 현대카드)
    easy_pay_card: str | None = None
    # True 면 계정 비교를 `<key>_quick_price`(상품 페이지의 계정별 할인가·최대 적립)로 먼저 해 가장 싼 계정 하나만
    # 주문서까지 간다(2026-09-26: 계정마다 주문서를 만들어 1건 수 분 — 사람은 쿠폰가만 보고 몇 초에 고른다)
    quick_compare: bool = False
    # True 면 스냅샷(주문서 생성) 직후 `<key>_order_prep` 으로 주문서를 규칙대로 정돈한다 — 무신사 적립금(5만 미만 0원)·선할인(플레이북 §7)
    order_prep: bool = False
    # True 면 스냅샷 전에 `<key>_coupon_download` 로 상품 페이지의 '쿠폰받기'를 눌러 받을 수 있는 쿠폰을 먼저 받는다.
    # 안 받은 쿠폰은 주문서에 안 뜬다 — 계정 비교가 틀린다(실기: buyer01 데상트 10% 쿠폰 미발급으로 0원)
    coupon_download: bool = False
    # True 면 결제수단 견적에 `<key>_pay_card_quote`(간편결제 등록 기본 카드 한 줄)를 더한다 — 카드 청구할인 비교용
    pay_card_quote: bool = False
    # True 면 사이트 머니(무신사머니)가 간편결제(무신사페이) 안의 결제 항목으로 붙어 있다 — 주문서의 '무신사페이'가
    # 곧 무신사머니 결제 창구다(29CM, 실기 2026-09-25: buyer02 가 '결제 가능한 수단 없음'으로 비교에서 빠졌다)
    money_in_pay: bool = False
    # 같은 상품을 같이 비교할 다른 소싱처 id(예: 무신사 ↔ 29CM) — 더 싼 쪽에서 산다(사용자 2026-09-24)
    cross_with: str | None = None
    # 이 소싱처는 이 결제 제공자로만 결제한다(예: ABC마트·그랜드스테이지 = naver 네이버페이, 사용자 2026-09-24).
    # 전역 허용 수단(SAMBA_ALLOWED_PAY_PROVIDERS)보다 우선한다
    pay_provider: str | None = None
    # 이 소싱처에서 결제 후보로 쓰지 않는 결제 제공자(예: 29CM 토스페이 — 현대·LOCA 카드 가맹점 미지원). 전역 허용 수단에서 뺀다
    excluded_pay_providers: list[str] = []
    # 이 소싱처의 주문은 항상 이 배송 종류로 본다(예: ABC마트는 전부 까대기 = 사무실 배송).
    # None 이면 주문(삼바웨이브 action_tag)이 정한 종류를 따른다
    order_type: Literal['direct', 'kkadaegi', 'gift'] | None = None
    # True 면 주문 링크가 지정 몰(SSG = 신세계몰 siteNo 6004)이 아닐 때 `<key>_find_mall_item` 으로 그 몰의 같은 모델
    # 상품을 찾아 싼 순서로 스냅샷하고, 주문 옵션이 맞는 첫 후보로 산다(사용자 2026-09-27: SSG 는 신세계몰에서만 산다)
    mall_item: bool = False
    # True 면 `<key>_route_quotes` 로 진입 경로(직접·애드픽·다나와·에누리)마다 주문서 원가를 비교해 가장 싼 경로로 산다.
    # 경로는 쿠키로 기록되고 마지막 진입이 덮어쓰므로, 이긴 경로로 마지막에 한 번 더 들어가 그 주문서로 결제한다
    route_compare: bool = False
    # 비교할 진입 경로. 비우면 직접·애드픽(ROUTES_DEFAULT). 다나와·에누리는 필요할 때 켠다(실측상 금액이 같았다)
    routes: list[Literal['direct', 'adpick', 'danawa', 'enuri']] = []
    # True 면 신세계백화점(siteNo 6009) 상품도 산다(사용자 2026-09-27 허용). 이마트·트레이더스 등 그 밖의 몰은 여전히 금지
    allow_department: bool = False
    # True 면 '충전결제'(SSG MONEY 충전결제 등) 견적 줄도 후보로 둔다. 기본은 뺀다 —
    # 롯데온 L.pay 충전결제는 현대카드 결제보다 항상 불리하다(사용자 2026-09-26)
    charge_pay: bool = False
    # 진입 경로 강제(H몰 = danawa, 사용자 2026-09-27): 스냅샷 전에 `<key>_danawa_entry` 로 다나와 이동 링크(entry_url)를
    # 받아 그 링크로 들어간다(제휴할인 ReferCode). 직접 진입 금지 — 링크를 못 받으면 AI 수리 없이 사람에게
    entry_route: Literal['danawa', 'shopback'] | None = None
    # 이 판매자 상품만 산다(롯데온 = 롯데백화점, 사용자 2026-09-27). 스냅샷이 seller 를 읽어 다르면 사지 않는다
    required_seller: str | None = None
    # True 면 포이즌 외 주문은 전부 '선물하기'(gift)로 산다(롯데온, 사용자 2026-09-27) — 삼바웨이브 배지와 무관
    gift_unless_poison: bool = False
    # 주문서 '카드' 탭 직접 결제로 낼 카드사(H몰 = 롯데카드, 사용자 2026-09-27). 그 카드 견적 줄은 결제 제공자
    # 'card'(DIRECT_CARD_PROVIDER)로 본다 — 키마스터 결제 비밀번호가 아니라 카드사 결제창(앱카드 등)에서 사람이 승인한다.
    # 이 소싱처의 pay_provider 도 'card' 로 둔다
    direct_card: str | None = None

    @property
    def entry_script(self) -> str:
        return f'{self.key}_{self.entry_route}_entry'

    @property
    def find_product_script(self) -> str:
        return f'{self.key}_find_product'

    @property
    def mall_item_script(self) -> str:
        return f'{self.key}_find_mall_item'

    @property
    def route_quotes_script(self) -> str:
        return f'{self.key}_route_quotes'

    @property
    def product_id_re(self) -> re.Pattern[str] | None:
        return re.compile(self.product_id) if self.product_id else None

    @property
    def snapshot_script(self) -> str:
        return f'{self.key}_product_snapshot'

    @property
    def confirm_shipping_script(self) -> str:
        return f'{self.key}_confirm_shipping'

    @property
    def payment_quotes_script(self) -> str:
        return f'{self.key}_payment_quotes'

    @property
    def normal_price_script(self) -> str:
        return f'{self.key}_normal_price'

    @property
    def pay_card_quote_script(self) -> str:
        return f'{self.key}_pay_card_quote'

    @property
    def coupon_download_script(self) -> str:
        return f'{self.key}_coupon_download'

    @property
    def order_prep_script(self) -> str:
        return f'{self.key}_order_prep'

    @property
    def quick_price_script(self) -> str:
        return f'{self.key}_quick_price'

    @property
    def set_shipping_script(self) -> str:
        return f'{self.key}_set_shipping'

    @property
    def checkout_script_name(self) -> str:
        return self.checkout_script or f'checkout_enter_{self.key}'

    @property
    def agent_name(self) -> str:
        return f'buyer.{self.key}'


class Sources:
    """sources.yaml 을 읽어 들고 있는 객체. id·한글 이름·key 어느 것으로 물어도 같은 행을 준다."""

    def __init__(self, rows: list[Source]) -> None:
        self._rows = rows
        self._index: dict[str, Source] = {}
        for s in rows:
            for alias in (s.id, s.label, s.key):
                self._index.setdefault(alias.strip().lower(), s)

    @classmethod
    def load(cls, root: Path, filename: str = SOURCES_FILE) -> 'Sources':
        raw = yaml.safe_load(local_aliases.apply((root / filename).read_text(encoding='utf-8'))) or {}
        rows = [Source.model_validate(row) for row in raw.get('sources', [])]
        seen_ids: set[str] = set()
        for s in rows:
            if s.id in seen_ids:
                raise ValueError(f'소싱처 id 가 중복이다: {s.id}')
            seen_ids.add(s.id)
        return cls(rows)

    def by_id(self, id_or_label: str | None) -> Source | None:
        """id·한글 이름·key 아무거나로 찾는다(대소문자 무시). 없으면 None."""
        if not id_or_label:
            return None
        return self._index.get(str(id_or_label).strip().lower())

    def normalize(self, id_or_label: str | None) -> str | None:
        """소싱처 이름을 삼바웨이브 id 로 맞춘다. 표에 없으면 받은 값 그대로 둔다."""
        found = self.by_id(id_or_label)
        return found.id if found else id_or_label

    def by_agent(self, agent_name: str) -> Source | None:
        """'buyer.abc' → key 가 abc 인 첫 행. 흐름을 공유하는 소싱처(그랜드스테이지)는 첫 행을 따른다."""
        key = agent_name.split('.', 1)[-1]
        return next((s for s in self._rows if s.key == key), None)

    def active(self) -> list[Source]:
        return [s for s in self._rows if s.status == 'active']

    def registered(self) -> list[Source]:
        """등록부에 buyer 행을 만들 소싱처 — hold 는 뺀다."""
        return [s for s in self._rows if s.status != 'hold']

    def cross_only(self) -> list[Source]:
        """등록은 안 됐지만(hold) 등록된 소싱처의 교차 비교 짝(cross_with)인 소싱처 — 그 주문은 받지 않고
        짝 소싱처의 교차 비교에서만 쓴다(SSG ↔ H몰, 사용자 2026-09-27)."""
        wanted = {s.cross_with for s in self.registered() if s.cross_with}
        return [s for s in self._rows if s.status == 'hold' and s.id in wanted]

    def __iter__(self) -> Iterator[Source]:
        return iter(self._rows)

    def __len__(self) -> int:
        return len(self._rows)


@lru_cache(maxsize=1)
def default_sources() -> Sources:
    """기본 설치 위치(samba-agent/sources.yaml)의 표. 에이전트 모듈이 스크립트 이름을 물을 때 쓴다."""
    return Sources.load(DEFAULT_ROOT)
