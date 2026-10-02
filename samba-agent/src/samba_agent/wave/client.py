"""삼바웨이브 하네스 내부 API 클라이언트.

규약은 삼바웨이브의 `api/v1/routers/samba/harness_internal.py` —
`${SAMBA_WAVE_URL}/api/v1/internal/harness/*`, 헤더 `X-Internal-Token` · `X-Tenant-Id`.

이 클라이언트가 지키는 것:
1. 오류를 `FailReason` 으로 바꾼다(브릿지 클라이언트와 같은 방식) — 진단 표가 이 enum 으로만 집계된다.
2. 개인정보(배송지)는 `get_order` 응답에만 실린다. 호출부는 즉시 쓰고 버린다 —
   state·payload·로그 어디에도 담지 않는다(계획 문서 Global Constraints).
3. 토큰은 헤더로만 쓰고 예외 메시지·로그에 옮기지 않는다.
"""

import re
from datetime import datetime
from typing import Literal, Self

import httpx
from pydantic import BaseModel, ConfigDict, model_validator

from samba_agent.agents.contracts import OrderRef
from samba_agent.failures import FailReason

DEFAULT_TIMEOUT_S = 10.0
API_PREFIX = '/api/v1/internal/harness'

# HTTP 상태 → 실패 사유. 503 은 서버에 내부 토큰이 설정되지 않은 경우다(권한 문제로 센다)
_STATUS_REASON = {
    401: FailReason.PERMISSION_DENIED,
    403: FailReason.PERMISSION_DENIED,
    404: FailReason.UNKNOWN,
    409: FailReason.DUPLICATE,
    503: FailReason.PERMISSION_DENIED,
}

# 삼바웨이브 옵션 문자열은 '옵션:230' 처럼 머리말이 붙어 오기도 한다 — 값만 남긴다
# '옵션:230' 과 '옵션1:DEEP PEACH(H25)/옵션2:095'(무신사 292) — 줄 앞과 '/' 뒤의 '옵션N:' 머리말을 뗀다
_OPTION_PREFIX = re.compile(r'(?:^|(?<=/))\s*옵션\d*\s*[:：]\s*')

OrderType = Literal['direct', 'kkadaegi', 'gift']

# 삼바웨이브 플래그 토큰(action_tag, DB 실측) → 사람이 읽는 이름. 모르는 토큰은 그대로 보인다
FLAG_LABELS = {
    'no_price': '가격X',
    'no_stock': '재고X',
    'staff_a': '직원A',
    'staff_b': '직원B',
    'kkadaegi': '까대기',
    'direct': '직배',
    'gift': '선물',
}


def flag_text(flags: tuple[str, ...] | list[str]) -> str:
    """('no_price', 'staff_a') → '가격X, 직원A'. 플래그가 없으면 빈 문자열."""
    return ', '.join(FLAG_LABELS.get(f, f) for f in flags)


class WaveError(Exception):
    """삼바웨이브 호출 실패. 사유는 FailReason 으로 고정한다."""

    def __init__(self, reason: FailReason, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.reason = reason
        self.status = status


class WaveShipping(BaseModel):
    """배송지. 개인정보라 받는 즉시 쓰고 버린다 — 절대 state·payload·로그에 담지 않는다.

    전화번호 필드는 두지 않는다 — 응답에 실려 와도 버린다(extra='ignore'). 고객 전화번호는
    어디에도 입력하지 않고, 배송 연락처는 앱이 키마스터 신원정보로 채운다(사용자 결정 2026-09-23).
    """

    model_config = ConfigDict(extra='ignore')

    name: str = ''
    address: str = ''
    address_detail: str = ''
    postal_code: str = ''

    def to_script_args(self) -> dict[str, str]:
        """앱 저장 스크립트(<key>_set_shipping)가 받는 모양. 빈 값은 빼지 않는다(덮어쓰기 목적).

        phone 키는 없다 — 스크립트는 전화 칸을 비워 두고 그 칸의 요소 번호를 돌려준다.
        """
        return {
            'name': self.name,
            'address': self.address,
            'address_detail': self.address_detail,
            'postal_code': self.postal_code,
        }


# 소싱처 미등록 상품명 속 소싱처 상품번호 — 따로 떨어진 번호 중 마지막 것(사용자 2026-09-25).
#   LE+10자리 → 롯데온 상품번호 예: '노스페이스 … 레귤러핏 LE1215528857'
#   10자리    → ABC마트 prdtNo  예: '나이키 DV5456 300 코트 버로우 로우 … 1010109335'
#   5~8자리   → 무신사 상품번호  예: '르무통 LEMOUTON 5009530519 메이트 오렌지 3347853' → 3347853,
#               '남자데님팬츠 05415547 와이드 쿨 데님 415547 3colo' → 415547
#   13자리(1000…) → SSG itemId   예: '아레나 포겟미낫 … A4FL1LH08 1000618616029'
#   9자리     → 패션플러스 상품번호 예: 'QELAX24541CRE 여성 베이직 니삭스 KS0099KEY 376268351'(실측 2026-09-28)
_PRODUCT_NO_IN_NAME = re.compile(r'(?<!\w)(LE\d{10}|1000\d{9}|\d{5,10})(?!\w)')
_INFER_URL = {
    'MUSINSA': 'https://www.musinsa.com/products/{}',
    'ABCmart': 'https://abcmart.a-rt.com/product/new?prdtNo={}',
    'LOTTEON': 'https://www.lotteon.com/p/product/{}',
    'SSG': 'https://www.ssg.com/item/itemView.ssg?itemId={}',
    'FashionPlus': 'https://www.fashionplus.co.kr/goods/detail/{}',
}


def infer_source(product_name: str | None) -> tuple[str, str] | None:
    """소싱처 미등록 상품명에서 (소싱처 id, 상품번호)를 추정한다. 못 하면 None."""
    found = _PRODUCT_NO_IN_NAME.findall(product_name or '')
    if not found:
        return None
    last = found[-1]
    if last.startswith('LE'):
        return 'LOTTEON', last
    if len(last) == 13:
        return 'SSG', last
    if len(last) == 10:
        return 'ABCmart', last
    if len(last) == 9:
        return 'FashionPlus', last
    if len(last) <= 8:
        product_id = last.lstrip('0')
        return ('MUSINSA', product_id) if product_id else None
    return None


def infer_musinsa_product_id(product_name: str | None) -> str | None:
    """무신사로 추정되면 그 상품번호, 아니면 None."""
    found = infer_source(product_name)
    return found[1] if found and found[0] == 'MUSINSA' else None


class WaveOrder(BaseModel):
    """미이행 주문 1건(개인정보 없음). 모르는 필드가 늘어도 그냥 무시한다."""

    model_config = ConfigDict(extra='ignore')

    id: str = ''
    order_number: str
    source_site: str | None = None
    source_url: str | None = None
    product_name: str | None = None
    product_option: str | None = None
    quantity: int = 1
    sale_price: float = 0
    # SAMBA 정산금. 목록 응답에 실리면 마진을 정산금 기준으로 계산한다(없으면 판매가 근사)
    revenue: float | None = None
    seller: str | None = None
    # 중국 크림 주문 — 판매처(得物 …)·판매처 가격(위안)·수집상품 상품코드(식화 품번). 삼바웨이브가 실어 줄 때만
    source_seller: str | None = None
    source_price_cny: float | None = None
    source_product_code: str | None = None
    sourcing_account_id: str | None = None
    sourcing_account_username: str | None = None
    sourcing_account_label: str | None = None
    sourcing_account_default: bool = False
    action_tag: str | None = None
    paid_at: datetime | None = None
    status: str = ''
    # 아래 셋은 현재 목록 응답에 없다 — 삼바웨이브가 나중에 실어 주면 기록·검증이 바로 대조한다
    sourcing_order_number: str | None = None
    cost: float | None = None
    shipping_fee: float | None = None
    # 주문 종류 — 목록 응답에는 없어 기본 direct 다. 상세 응답이 실제 값을 준다
    order_type: OrderType = 'direct'
    # 소싱처가 비어 있어 상품명 끝 숫자로 소싱처·상품번호를 추정했는가(infer_source)
    source_inferred: bool = False
    inferred_product_id: str | None = None

    @model_validator(mode='after')
    def _infer_source(self) -> Self:
        """소싱처 미등록 주문 — 상품명 뒤쪽 번호로 무신사·ABC마트·롯데온 상품을 찾는다(사용자 2026-09-25)."""
        if (self.source_site or '').strip():
            return self
        found = infer_source(self.product_name)
        if found:
            site, product_id = found
            self.source_site = site
            self.source_url = _INFER_URL[site].format(product_id)
            self.source_inferred = True
            self.inferred_product_id = product_id
        return self

    @property
    def flags(self) -> tuple[str, ...]:
        """action_tag('no_price,staff_a') → ('no_price', 'staff_a'). 소문자로 맞추고 빈 토큰은 버린다."""
        tokens = (t.strip().lower() for t in (self.action_tag or '').split(','))
        return tuple(t for t in tokens if t)

    @property
    def option(self) -> str | None:
        """'옵션:230' · 'BLACK / 270' 어느 쪽으로 와도 머리말을 뗀 값만 준다."""
        raw = _OPTION_PREFIX.sub('', self.product_option or '').strip()
        return raw or None

    def to_order_ref(self) -> OrderRef:
        """감독자 배정에 쓰는 OrderRef. 개인정보는 애초에 이 모델에 없다."""
        option = self.option
        name = (self.product_name or '').strip()
        sku = f'{name} [{option}]' if (name and option) else (name or self.order_number)
        return OrderRef(
            order_no=self.order_number,
            source=self.source_site or '',
            seller=(self.seller or '').strip(),
            sku=sku,
            qty=max(int(self.quantity or 1), 1),
            option=option,
            product_url=(self.source_url or '').strip() or None,
            # 로그인에 쓰는 것은 아이디다 — 없으면 비워 둔다(표시 이름으로 로그인할 수 없다)
            account=(self.sourcing_account_username or '').strip() or None,
            # 기록이 되돌려 줄 소싱 계정 id — 로그인용 아이디가 아니라 삼바웨이브 내부 id 다
            account_id=(self.sourcing_account_id or '').strip() or None,
            order_type=self.order_type,
            sale_price=float(self.sale_price or 0),
            revenue=float(self.revenue or 0),
            flags=self.flags,
        )


class WaveSourceOption(BaseModel):
    """상품 등록 때 수집한 소싱처 옵션 — 마켓 옵션은 이것으로 만들었다."""

    model_config = ConfigDict(extra='ignore')

    name: str
    stock: int | None = None
    sold_out: bool = False


def _opt_key(text: str) -> str:
    """옵션 이름 비교용 — 공백·구두점을 지우고 소문자로."""
    return re.sub(r'[\s\-_/·,:()\[\]]+', '', text or '').lower()


def registered_source_option(
    market_option: str | None,
    source_options: list[WaveSourceOption],
    registered: str | None = None,
) -> str | None:
    """주문의 마켓 옵션이 등록 때 어느 소싱처 옵션이었는가. 하나로 정해질 때만 그 이름, 아니면 None.

    1) 포이즌처럼 입찰번호로 삼바웨이브가 찾아 준 옵션(registered)
    2) 이름이 공백·구두점만 다르고 같은 등록 옵션 하나(마켓 옵션은 등록 옵션 이름으로 만들었다)
    사용자 2026-09-30: 등록 때 매칭한 옵션이 있는데 옵션 글자를 새로 짐작하다 틀려 취소했다.
    """
    if registered and registered.strip():
        return registered.strip()
    key = _opt_key(market_option or '')
    if not key:
        return None
    same = [o.name for o in source_options if _opt_key(o.name) == key]
    return same[0] if len(set(same)) == 1 else None


class WaveOrderDetail(WaveOrder):
    """주문 상세 — 배송지가 더 실린다. 배송지는 받는 즉시 쓰고 버린다."""

    shipping: WaveShipping = WaveShipping()
    # 등록 때 매칭한 소싱처 옵션(삼바웨이브가 실어 주면) — 주문 옵션 대신 이것으로 산다
    source_options: list[WaveSourceOption] = []
    poison_sizes: dict[str, str] = {}
    registered_option: str | None = None

    def to_order_ref(self) -> OrderRef:
        """등록 매칭으로 소싱처 옵션 이름이 정해지면 그 이름을 주문 옵션으로 쓴다(글자 짐작을 건너뛴다)."""
        ref = super().to_order_ref()
        source_option = registered_source_option(
            ref.option, self.source_options, self.registered_option
        )
        if not source_option or source_option == ref.option:
            return ref
        return ref.model_copy(update={'option': source_option, 'market_option': ref.option})


# 감독자 기대값 키 ← 삼바웨이브 응답 필드. 응답에 그 값이 없으면(None) 빼서 '대조 못 함' 으로 남긴다.
# 계정·플래그는 뜻이 1:1 로 맞지 않아(판매 계정 vs 소싱 계정, 태그 묶음) 대조 대상에서 뺀다
EXPECTED_FIELD_MAP = {
    'source_order_no': 'sourcing_order_number',
    'real_price': 'cost',
    'shipping_fee': 'shipping_fee',
}


def wave_fields(order: WaveOrder) -> dict[str, object]:
    """삼바웨이브 주문 → 기대값 키로 맞춘 사전. 응답에 없는 값은 아예 담지 않는다."""
    out: dict[str, object] = {}
    for expected_key, wave_key in EXPECTED_FIELD_MAP.items():
        value = getattr(order, wave_key, None)
        if value is not None:
            out[expected_key] = value
    return out


class WaveClient:
    """내부 API 3개(목록·상세·소싱 기입)만 부르는 얇은 클라이언트."""

    def __init__(
        self,
        base_url: str,
        token: str,
        tenant_id: str,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        client: httpx.Client | None = None,
    ) -> None:
        self._base = f'{base_url.rstrip("/")}{API_PREFIX}'
        self._token = token
        self._tenant_id = tenant_id
        self._timeout_s = timeout_s
        self._client = client or httpx.Client(timeout=timeout_s)

    def pending_orders(self, days: int = 7, limit: int = 100) -> list[WaveOrder]:
        """최근 `days` 일 안에 결제됐지만 아직 소싱 발주가 안 된 주문들."""
        body = self._request('GET', '/pending-orders', params={'days': days, 'limit': limit})
        items = body.get('items') if isinstance(body, dict) else None
        return [WaveOrder.model_validate(i) for i in items or []]

    def sourcing_numbers(self, days: int = 14) -> set[str]:
        """최근 주문에 적힌 소싱주문번호 전부 — 교차 검증이 소싱처 주문 내역과 견준다(삼바에 없는 소싱 주문 찾기)."""
        body = self._request('GET', '/sourcing-numbers', params={'days': str(days)})
        numbers = body.get('numbers') if isinstance(body, dict) else None
        return {str(n) for n in numbers} if isinstance(numbers, list) else set()

    def sourcing_account_id(self, source_site: str, username: str) -> str | None:
        """(소싱처, 로그인 아이디) → 삼바웨이브 소싱 계정 id. 못 찾으면 None.

        실제로 산 계정으로 주문계정을 기록하려고 쓴다(주문에 미리 잡힌 계정과 다를 수 있다).
        """
        # 삼바웨이브는 H몰을 내부적으로 THEHYUNDAI 로 저장한다(표시 이름만 HMALL, 2026-09-27)
        if source_site.strip().upper() in ('HMALL', 'H몰', '현대H몰'):
            source_site = 'TheHyundai'
        try:
            body = self._request('GET', '/sourcing-accounts', params={'source_site': source_site})
        except WaveError:
            return None
        items = body.get('items') if isinstance(body, dict) else body
        if not isinstance(items, list):
            return None
        want = username.strip().lower()
        # 29CM 키마스터 라벨은 'buyer01@naver.com', 삼바웨이브 29CM 계정 아이디는 'buyer01' 처럼 @ 앞만일 수 있다
        wants = {want, want.split('@')[0]}
        for item in items:
            if not isinstance(item, dict):
                continue
            got = str(item.get('username') or '').strip().lower()
            if (got in wants or got.split('@')[0] in wants) and (
                str(item.get('source_site') or source_site).lower() == source_site.lower()
            ):
                return str(item.get('id') or '') or None
        return None

    def only_sourcing_account_id(self, source_site: str) -> str | None:
        """그 소싱처의 활성 계정이 하나뿐이면 그 id(得物 '마놀' 처럼 계정이 하나인 곳). 없거나 여럿이면 None."""
        try:
            body = self._request('GET', '/sourcing-accounts', params={'source_site': source_site})
        except WaveError:
            return None
        items = body.get('items') if isinstance(body, dict) else body
        ids = [str(i.get('id')) for i in items or [] if isinstance(i, dict) and i.get('id')]
        return ids[0] if len(ids) == 1 else None

    def get_order(
        self,
        order_no: str,
        order_type: OrderType | None = None,
        sourcing_order_number: str | None = None,
    ) -> WaveOrderDetail:
        """주문 1건 상세. 배송지가 실려 온다 — 호출부는 즉시 쓰고 버린다.

        ``order_type`` 을 주면 그 종류의 배송지(까대기 = 사무실)를 달라고 요청한다. 삼바웨이브가
        아직 이 인자를 모르면 응답의 order_type 이 다르게 오고, 호출부가 그걸 보고 멈춘다.
        한 상품주문번호에 행이 여럿이면 삼바웨이브는 아직 안 산 행을 준다. 기입 되읽기는
        ``sourcing_order_number`` 로 방금 적은 행을 고른다(실기 20260927C5313B 240·260).
        """
        params: dict[str, str] = {}
        if order_type:
            params['order_type'] = order_type
        if sourcing_order_number:
            params['sourcing_order_number'] = sourcing_order_number
        body = self._request('GET', f'/orders/{order_no}', params=params or None)
        return WaveOrderDetail.model_validate(body)

    def record_sourcing(
        self,
        order_no: str,
        *,
        sourcing_order_number: str,
        cost: float,
        shipping_fee: float = 0,
        sourcing_account_id: str | None = None,
        notes: str | None = None,
        order_type: OrderType | None = None,
        replace: bool = False,
    ) -> WaveOrder:
        """소싱주문번호·매입금액을 삼바웨이브 행에 기입한다. 다른 번호가 이미 있으면 409(DUPLICATE).

        replace=True 는 소싱처 주문을 취소하고 다시 산 경우(사용자 지시) — 다른 번호가 있어도 덮어쓴다.

        order_type 은 하네스가 판정한 배송 종류(직배/까대기) — 삼바웨이브가 action_tag 로 기록한다(결과값).
        삼바웨이브가 아직 이 필드를 모르면 무시된다.
        """
        payload: dict[str, object] = {
            'sourcing_order_number': sourcing_order_number,
            'cost': cost,
            'shipping_fee': shipping_fee,
        }
        if sourcing_account_id:
            payload['sourcing_account_id'] = sourcing_account_id
        if order_type:
            payload['order_type'] = order_type
        if notes:
            payload['notes'] = notes
        if replace:
            payload['replace'] = True
        body = self._request('PUT', f'/orders/{order_no}/sourcing', json=payload)
        order = body.get('order') if isinstance(body, dict) else None
        if not isinstance(order, dict):
            raise WaveError(FailReason.UNKNOWN, f'소싱 기입 응답에 order 가 없다: {order_no}')
        return WaveOrder.model_validate(order)

    def link_product(
        self, order_no: str, site_product_id: str, source_site: str = 'MUSINSA'
    ) -> dict[str, object]:
        """소싱처 미등록 주문을 수집상품에 연결한다(상품관리에 없으면 삼바웨이브가 수집해 저장).

        소싱처에서 상품이 사라졌으면(삭제) 삼바웨이브가 404 를 준다 — WaveError.status 로 구분한다.
        """
        body = self._request(
            'POST',
            f'/orders/{order_no}/link-product',
            json={'source_site': source_site, 'site_product_id': site_product_id},
        )
        return body if isinstance(body, dict) else {}

    def link_collected(self, order_no: str, collected_product_id: str) -> dict[str, object]:
        """소싱처 미등록 주문을 수집상품 번호(cp_…)로 연결한다 — 판매자상품코드에서 읽은 번호다.

        그 수집상품이 없으면(지워짐) 삼바웨이브가 404 를 준다.
        """
        body = self._request(
            'POST',
            f'/orders/{order_no}/link-product',
            json={'collected_product_id': collected_product_id},
        )
        return body if isinstance(body, dict) else {}

    def set_cancel_requested(self, order_no: str, reason: str, flag: str | None = None) -> bool:
        """이행하지 못한 발주 전 주문을 '취소중'(cancelling)으로 바꾼다(flag 를 주면 가격X·재고X 태그도 붙인다).

        사용자 2026-09-28: 미이행은 취소요청이 아니라 취소중. reason 은 삼바웨이브가 주문 메모에 [취소근거] 로 남긴다.
        바뀌었으면 True, 이미 취소중이면 False.
        """
        payload: dict[str, object] = {'status': 'cancelling', 'reason': reason}
        if flag:
            payload['flag'] = flag
        body = self._request('PUT', f'/orders/{order_no}/status', json=payload)
        return bool(body.get('changed')) if isinstance(body, dict) else False

    def dewu_tracking_targets(self, limit: int = 30) -> list[dict[str, str]]:
        """중국 크림 得物 주문 중 해외송장이 빈 건 — [{order_number, sourcing_order_number}]."""
        body = self._request('GET', '/cn-dewu-tracking-targets', params={'limit': limit})
        return [x for x in body if isinstance(x, dict)] if isinstance(body, list) else []

    def write_overseas_tracking(self, order_no: str, company: str, number: str) -> bool:
        """중국 크림 주문의 해외 택배사·송장을 넣는다(배송중으로 바뀐다). 허브넷 전송은 삼바웨이브 CN 루프가 한다."""
        body = self._request(
            'PUT',
            f'/orders/{order_no}/overseas-tracking',
            json={'company': company, 'number': number},
        )
        return bool(body.get('rows')) if isinstance(body, dict) else False

    def write_lotteon_gift_tracking(
        self,
        *,
        company: str,
        number: str,
        sourcing_order_number: str = '',
        customer_name: str = '',
        product_text: str = '',
        dry_run: bool = False,
    ) -> dict[str, object]:
        """롯데ON 선물 주문에 택배사·송장을 넣고 마켓으로 보낸다(카카오톡 알림에서 읽은 값).

        주문은 삼바웨이브가 정한다 — 롯데ON 주문번호, 없으면 받는 사람 이름 + 품번. 정확히 1건일 때만 넣는다.
        돌려주는 것: {ok, action(shipped·dry_run·skipped·rejected), reason, order_number, market_sent, message}.
        """
        body = self._request(
            'PUT',
            '/lotteon-gift-tracking',
            json={
                'company': company,
                'number': number,
                'sourcing_order_number': sourcing_order_number or None,
                'customer_name': customer_name or None,
                'product_text': product_text or None,
                'dry_run': dry_run,
            },
        )
        return body if isinstance(body, dict) else {}

    def add_memo(self, order_no: str, line: str) -> bool:
        """주문 메모에 한 줄을 덧붙인다(상태·소싱 값은 그대로). 새로 붙였으면 True, 이미 같은 줄이 있으면 False.

        사용자 2026-10-01: 카카오페이가 최저가인데 폰 비밀번호를 못 받으면 다른 수단으로 사지 않고 메모만 남긴다.
        """
        body = self._request('POST', f'/orders/{order_no}/memo', json={'line': line})
        return bool(body.get('rows')) if isinstance(body, dict) else False

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _headers(self) -> dict[str, str]:
        return {
            'X-Internal-Token': self._token,
            'X-Tenant-Id': self._tenant_id,
            'content-type': 'application/json',
        }

    def _request(self, method: str, path: str, **kwargs: object) -> object:
        """호출 1건. 연결 실패는 BRIDGE_DOWN, 상태 코드는 표대로 FailReason 으로 바꾼다."""
        try:
            r = self._client.request(
                method,
                f'{self._base}{path}',
                headers=self._headers(),
                timeout=self._timeout_s,
                **kwargs,  # type: ignore[arg-type]
            )
        except httpx.TimeoutException as e:
            raise WaveError(FailReason.BRIDGE_DOWN, f'삼바웨이브 시간 초과: {path}') from e
        except httpx.HTTPError as e:
            raise WaveError(
                FailReason.BRIDGE_DOWN, f'삼바웨이브 연결 실패: {type(e).__name__}'
            ) from e
        if r.status_code >= 400:
            raise WaveError(*self._fail(r))
        try:
            return r.json()
        except ValueError as e:
            raise WaveError(FailReason.UNKNOWN, f'삼바웨이브 응답이 JSON 이 아니다: {path}') from e

    @staticmethod
    def _fail(r: httpx.Response) -> tuple[FailReason, str, int]:
        """응답 → (사유, 메시지, 상태). 메시지에 토큰은 들어가지 않는다(응답 본문만 쓴다)."""
        reason = _STATUS_REASON.get(r.status_code, FailReason.UNKNOWN)
        try:
            body = r.json()
            detail = str(body.get('detail', '')) if isinstance(body, dict) else ''
        except ValueError:
            detail = ''
        return reason, f'삼바웨이브 {r.status_code}: {detail}'.strip(), r.status_code
