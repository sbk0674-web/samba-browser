"""식화 판매처 목록에서 화이트리스트 가게의 淘宝 상품 링크를 읽는다 — 淘宝 PC 구매(샵백 경유)의 입구.

사용자 2026-10-08: 淘宝 검색으로 사면 블랙리스트 가게를 고르게 되니 반드시 식화에서 넘어가야 한다. 식화 웹(www.shihuo.cn)은 이 PC 의 회선에서
막혀 있어(SK 회선 차단) 크림 쪽과 같은 엣지 IP 직결(Host·SNI 는 원래 이름)로 받는다 — 크림 중국 세션 실측(2026-10-08).

흐름(주문 1건당 호출 2번 — 식화 쪽 IP 차단 이력이 있어 적게 부른다)
1. pcGoodsDetail(goodsId·styleId) → skuListData 에서 사이즈(EU)의 식화 sku_id
2. 게이트웨이 supplier/list/by-goods(모바일 UA·Referer m.shihuo.cn, 로그인·서명 불필요) → 판매처 행의 href 안 url 파라미터 = 淘宝 상품 주소
"""

import json
import logging
import re
import urllib.parse
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)

EDGES = ('47.89.210.51', '47.254.80.253')
HOSTS = frozenset({'sh-gateway.shihuo.cn', 'www.shihuo.cn', 'm.shihuo.cn'})
PAGE = 'https://www.shihuo.cn/page/pcGoodsDetail'
GATEWAY = 'https://sh-gateway.shihuo.cn/v4/services/sh-openapps/ssr/supplier/list/by-goods'
UA_P = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
)
UA_M = (
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
)
# 식화 판매처 화이트리스트 중 淘宝 가게 — kream_shadow._SUP_ALLOW_NAMES 와 같아야 한다
ALLOWED_SHOPS = ('后浪潮品奥莱折扣店', '品牌官方店')
_NEXT = re.compile(r'id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
_GOODS = re.compile(r'goodsId=(\d+)')
_STYLE = re.compile(r'styleId=(\d+)')


class ShihuoLinkError(Exception):
    """링크를 못 읽은 사유(개인정보 없음)."""


@dataclass(frozen=True)
class SupplierLink:
    store: str  # 淘宝·唯品会·得物
    name: str  # 가게 이름
    price_cny: float
    url: str  # 淘宝 상품 주소(item.taobao.com/item.htm?id=…&skuId=…) — 淘宝 행만 있다


class EdgeTransport(httpx.AsyncBaseTransport):
    """식화 서버 IP 로 직접 연결하고 Host·SNI 는 원래 이름을 유지한다. 연결이 안 되면 다음 IP."""

    def __init__(self, edges: tuple[str, ...] = EDGES, **kw: Any) -> None:
        self._edges = edges
        self._inner = httpx.AsyncHTTPTransport(**kw)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host not in HOSTS:
            return await self._inner.handle_async_request(request)
        last: Exception | None = None
        for ip in self._edges:
            headers = request.headers.copy()
            headers['Host'] = host
            req = httpx.Request(
                request.method,
                request.url.copy_with(host=ip),
                headers=headers,
                stream=request.stream,
                extensions={**request.extensions, 'sni_hostname': host},
            )
            try:
                return await self._inner.handle_async_request(req)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as e:
                last = e
        raise last if last else ShihuoLinkError('식화 엣지 IP 가 없다')

    async def aclose(self) -> None:
        await self._inner.aclose()


def ids_from_url(source_url: str) -> tuple[str, str]:
    """수집상품의 식화 주소에서 goodsId·styleId."""
    goods = _GOODS.search(source_url or '')
    style = _STYLE.search(source_url or '')
    if not goods or not style:
        raise ShihuoLinkError('식화 주소에서 goodsId·styleId 를 못 읽었다')
    return goods.group(1), style.group(1)


def sku_id_of(page_html: str, eu_size: str) -> str:
    """pcGoodsDetail 의 skuListData 에서 사이즈(EU)의 식화 sku_id."""
    found = _NEXT.search(page_html or '')
    if not found:
        raise ShihuoLinkError('식화 상세에서 __NEXT_DATA__ 를 못 찾았다')
    data = json.loads(found.group(1))
    sku = (data.get('props') or {}).get('pageProps', {}).get('skuListData') or {}
    want = (eu_size or '').strip()
    for block in (sku.get('data') or {}).get('list') or []:
        for item in block.get('sku_list') or []:
            for attr in item.get('attrs') or []:
                if attr.get('spec_name') == '尺码' and str(attr.get('name')).strip() == want:
                    return str(item.get('sku_id'))
    raise ShihuoLinkError(f'식화 사이즈 목록에 EU {want} 가 없다')


def parse_suppliers(payload: dict[str, Any]) -> list[SupplierLink]:
    """게이트웨이 응답 → 판매처 행(싼 순). 淘宝 행은 href 의 url 파라미터를 푼다."""
    out: list[SupplierLink] = []
    for row in (payload.get('data') or {}).get('list') or []:
        info = row.get('supplier_info') or {}
        try:
            price = float(info.get('display_price'))
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        url = ''
        href = str(info.get('href') or '')
        if href:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
            url = urllib.parse.unquote((params.get('url') or [''])[0])
        out.append(
            SupplierLink(
                str(info.get('store_name') or ''), str(info.get('supplier_name') or ''), price, url
            )
        )
    out.sort(key=lambda s: s.price_cny)
    return out


def whitelisted_taobao(rows: list[SupplierLink]) -> list[SupplierLink]:
    """淘宝 화이트리스트 가게 행만(상품 주소가 있는 것) — 싼 순."""
    return [
        r
        for r in rows
        if '淘宝' in r.store
        and any(shop in r.name for shop in ALLOWED_SHOPS)
        and r.url.startswith('https://item.taobao.com/')
    ]


async def fetch_suppliers(source_url: str, eu_size: str) -> list[SupplierLink]:
    """식화에서 그 사이즈의 판매처 행(싼 순)을 읽는다. 호출 2번."""
    goods, style = ids_from_url(source_url)
    async with httpx.AsyncClient(
        timeout=40, follow_redirects=True, transport=EdgeTransport()
    ) as cli:
        page = await cli.get(
            PAGE,
            params={'goodsId': goods, 'styleId': style},
            headers={'User-Agent': UA_P, 'Accept-Language': 'zh-CN,zh;q=0.9'},
        )
        if page.status_code != 200:
            raise ShihuoLinkError(f'식화 상세 응답 {page.status_code}')
        sku_id = sku_id_of(page.text, eu_size)
        res = await cli.get(
            GATEWAY,
            params={
                'goods_id': goods,
                'style_id': style,
                'sku_id': sku_id,
                'source': '',
                'tab': '',
                'value': '',
            },
            headers={
                'User-Agent': UA_M,
                'Referer': 'https://m.shihuo.cn/',
                'Accept': 'application/json',
            },
        )
        if res.status_code != 200:
            raise ShihuoLinkError(f'식화 판매처 목록 응답 {res.status_code}')
        return parse_suppliers(res.json())
