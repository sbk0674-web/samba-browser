"""주문번호 → OrderRef 조회.

슬랙 명령은 주문번호만 준다. 감독자 배정(등록부 조건)에는 소싱처·판매처·SKU·수량이
필요해서 앱의 저장 스크립트 `samba_find_order` 로 읽어온다. 결과에 고객 이름·전화·주소가
섞여 있어도 OrderRef 에는 올리지 않는다 — 개인정보는 애초에 그래프 상태에 담지 않는다
(계획 문서 Global Constraints).
"""

import json
import logging
import re
from collections.abc import Callable, Mapping

from samba_agent.agents.contracts import OrderRef
from samba_agent.bridge.client import BridgeClient
from samba_agent.sources import default_sources
from samba_agent.wave.client import WaveClient, WaveError

log = logging.getLogger(__name__)

FIND_ORDER_SCRIPT = 'samba_find_order'
# 조회 스크립트는 앱의 활성 탭에서 돈다 — 이 주소가 앞에 있어야 한다
ORDERS_URL = 'https://samba-wave.vercel.app/samba/orders'
ORDERS_HOST = 'samba-wave.vercel.app'
# 조회에 필요한 도구 전부(브릿지 허용 목록에 그대로 쓴다)
LOOKUP_TOOLS = ('run_script', 'list_tabs', 'switch_tab', 'new_tab', 'wait')
# 새 탭을 열었을 때 페이지가 그려질 때까지 기다리는 시간
_NEW_TAB_WAIT_MS = 2000
# OrderRef 를 채우는 데 필요한 필드만 본다 — 결과에 다른 키(개인정보 등)가 있어도 무시한다
_REQUIRED_FIELDS = ('source', 'seller', 'sku', 'qty')
# 앱 저장 스크립트(samba_find_order)는 사람이 고쳐 쓰는 것이라 키 이름이 흔들린다 — 별칭을 받아 준다
_ALIASES: dict[str, tuple[str, ...]] = {
    'source': ('source', 'sourcingPlatform', 'sourcing_platform', 'sourcing'),
    'seller': ('seller', 'sellerAccount', 'seller_account', 'market'),
    'qty': ('qty', 'quantity', 'count'),
    'option': ('option', 'optionText', 'size'),
    'product_url': ('product_url', 'sourceUrl', 'productUrl', 'source_url'),
    'account': ('account', 'sourcingAccount', 'sourcing_account'),
}
# 없어도 되는 필드 — 있으면 OrderRef 에 싣는다
_OPTIONAL_FIELDS = ('option', 'product_url', 'account')
# "ABCmart · 사무(buyer01)" 처럼 표시 이름 뒤 괄호에 아이디가 온다 — 아이디만 쓴다
_ACCOUNT_ID = re.compile(r'\(([^()]+)\)\s*$')


def _normalize(data: dict[str, object]) -> dict[str, object]:
    """별칭 키를 표준 키로 옮기고, sku 가 없으면 상품명+옵션으로 만든다. 개인정보 키는 옮기지 않는다."""
    out: dict[str, object] = dict(data)
    for field, names in _ALIASES.items():
        if out.get(field) in (None, ''):
            for n in names:
                if data.get(n) not in (None, ''):
                    out[field] = data[n]
                    break
    # 소싱처는 한글 이름('ABC마트')·id('ABCmart')·key('abc') 어느 쪽으로 와도 삼바웨이브 id 로 맞춘다
    source = out.get('source')
    if isinstance(source, str):
        out['source'] = default_sources().normalize(source.strip())
    account = out.get('account')
    if isinstance(account, str):
        m = _ACCOUNT_ID.search(account)
        out['account'] = (m.group(1) if m else account).strip()
    if out.get('sku') in (None, ''):
        name = next(
            (str(data[k]) for k in ('productName', 'product', 'name', 'title') if data.get(k)), ''
        )
        option = str(data.get('option') or data.get('optionText') or '').strip()
        sku = (name + (f' [{option}]' if option else '')).strip()
        if sku:
            out['sku'] = sku
    return out


def lookup_order_api(wave: 'WaveClient', order_no: str) -> OrderRef:
    """삼바웨이브 내부 API 로 주문을 찾아 OrderRef 를 만든다(앱 화면을 거치지 않는다).

    상세 응답에는 배송지(개인정보)가 실려 있지만 OrderRef 에는 옮기지 않는다 —
    배송지는 구매 에이전트가 입력하는 순간에만 따로 받아 쓴다.
    소싱처 이름은 표(sources.yaml)를 거쳐 삼바웨이브 id 로 맞춘다.
    """
    detail = wave.get_order(order_no)
    ref = detail.to_order_ref()
    if not ref.source or not ref.seller:
        raise ValueError(f'order lookup incomplete: {order_no} (소싱처·판매처 없음)')
    return ref.model_copy(update={'source': default_sources().normalize(ref.source)})


def parse_order_fn(
    wave: 'WaveClient | None', bridge: BridgeClient
) -> Callable[[str, Mapping[str, str]], OrderRef]:
    """조회 통로 하나로 묶는다 — 삼바웨이브 API 가 있으면 그쪽, 없으면 앱 저장 스크립트.

    API 가 있어도 그 주문이 삼바웨이브에 없거나(404) 필드가 모자라면 스크립트로 한 번 더 찾는다 —
    수기로 넣은 주문이 API 목록에 안 잡히는 경우가 있다.
    """

    def parse(order_no: str, options: Mapping[str, str]) -> OrderRef:
        ref: OrderRef | None = None
        if wave is not None:
            try:
                ref = lookup_order_api(wave, order_no)
            except (WaveError, ValueError) as e:
                log.warning('삼바웨이브 조회 실패 — 앱 스크립트로 넘어간다: %s', e)
        if ref is None:
            ref = lookup_order(bridge, order_no, options)
        return with_overrides(ref, options)

    return parse


# 작업 옵션으로 덮어쓸 수 있는 주문 필드 — 등록 상품이 다른 색상이거나 사이즈 표기가 달라 사람이
# 상품 링크·옵션을 정해 준 경우(실기 2026-09-30 라코스테: 연결 상품은 베이지, 블랙은 다른 상품)
OVERRIDE_FIELDS = ('option', 'product_url')


def with_overrides(ref: OrderRef, options: Mapping[str, object]) -> OrderRef:
    """작업 옵션의 option·product_url 이 있으면 주문 참조의 그 필드를 바꾼다."""
    update = {k: str(options[k]) for k in OVERRIDE_FIELDS if options.get(k)}
    return ref.model_copy(update=update) if update else ref


def focus_orders_page(bridge: BridgeClient) -> None:
    """삼바웨이브 주문 탭을 앞에 둔다. 없으면 새로 연다.

    run_script 는 활성 탭에서 돈다 — 채팅이 무신사 상품 페이지를 앞에 두고 끝나면 조회 스크립트가
    그 페이지에서 돌아 found:false 를 돌려줬다(실기). 팝업(kind=popup)은 후보에서 뺀다.
    """
    try:
        tabs = json.loads(bridge.call('list_tabs').result)
    except ValueError:
        tabs = []
    for t in tabs if isinstance(tabs, list) else []:
        if not isinstance(t, dict) or t.get('kind', 'tab') != 'tab':
            continue
        if ORDERS_HOST not in str(t.get('url', '')):
            continue
        if not t.get('active'):
            bridge.call('switch_tab', id=str(t['id']))
        return
    bridge.call('new_tab', url=ORDERS_URL)
    bridge.call('wait', ms=_NEW_TAB_WAIT_MS)


def lookup_order(bridge: BridgeClient, order_no: str, options: Mapping[str, str]) -> OrderRef:
    """브릿지로 주문을 찾아 OrderRef 를 만든다.

    결과 JSON 에 필드가 없으면 ``options`` 의 같은 키로 보완하고, 그래도 없으면
    ``ValueError`` 다. 브릿지 오류(권한 부족 등)는 ``BridgeError`` 그대로 전파한다.
    """
    focus_orders_page(bridge)
    result = bridge.call(
        'run_script', name=FIND_ORDER_SCRIPT, args=json.dumps({'orderNo': order_no})
    )
    try:
        data = json.loads(result.result)
    except ValueError as e:
        raise ValueError(f'{order_no} 조회 결과가 JSON 이 아니다') from e
    if not isinstance(data, dict):
        # TRY004 무시 — 스키마 오류도 lookup_order 는 전부 ValueError 하나로 통일한다
        raise ValueError(f'{order_no} 조회 결과가 객체가 아니다')  # noqa: TRY004

    data = _normalize(data)
    values: dict[str, object] = {}
    missing: list[str] = []
    for field in _REQUIRED_FIELDS:
        value = data.get(field)
        if value in (None, ''):
            value = options.get(field)
        if value in (None, ''):
            missing.append(field)
        else:
            values[field] = value
    if missing:
        raise ValueError(f'order lookup incomplete: {", ".join(missing)}')

    qty = int(values['qty'])  # type: ignore[arg-type]
    if qty < 1:
        raise ValueError(f'{order_no} qty 는 1 이상이어야 한다 (받은 값: {qty})')

    extras = {
        field: str(data[field]).strip()
        for field in _OPTIONAL_FIELDS
        if data.get(field) not in (None, '')
    }
    return OrderRef(
        order_no=order_no,
        source=str(values['source']),
        seller=str(values['seller']),
        sku=str(values['sku']),
        qty=qty,
        **extras,
    )
