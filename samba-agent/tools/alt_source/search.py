"""품절·가격 불일치 주문의 대체 판매처 찾기 — 삼바 브라우저(앱 브릿지 'alt-search' 레인)로 네이버 통합검색 쇼핑 칸·다나와를 읽는다.

사용: .venv/Scripts/python.exe tools/alt_source/search.py <품번> [<품번2> ...]
출력: 판매처·가격·상품명, 하네스가 살 수 있는 소싱처면 source·product_url(작업 옵션에 그대로 넣는다).

- 사용자 웨일 브라우저는 쓰지 않는다(사용자 2026-11-05: 작업 방해 금지)
- 네이버 쇼핑 검색(search.shopping.naver.com)은 앱 브라우저에서 '접속 제한'으로 막힌다 — 네이버 통합검색의 쇼핑 칸을 읽는다
- 다나와 바로가기(loadingBridge) 주소의 link_pcode 가 그 쇼핑몰 상품번호다
- 결제·장바구니는 누르지 않는다. 연 탭은 닫는다
"""

import json
import os
import re
import sys
import urllib.parse

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'src'))
sys.stdout.reconfigure(encoding='utf-8')

from samba_agent.bridge.client import BridgeClient  # noqa: E402
from samba_agent.settings import load_settings  # noqa: E402

LANE = 'alt-search'
# 다나와 업체코드 → (하네스 소싱처, 상품 주소 틀)
DANAWA_MALLS = {
    'ED901': ('SSG', 'https://www.ssg.com/item/itemView.ssg?itemId={}'),
    'TN118': ('SSG', 'https://www.ssg.com/item/itemView.ssg?itemId={}'),
    'ED908': ('GSShop', 'https://www.gsshop.com/prd/prd.gs?prdid={}'),
}

# 탭을 열어 트리를 읽고 닫는다 — 결과는 트리 글자 그대로
_OPEN_READ_JS = r"""
const id = (String(await tabs.open({url: __URL__})).match(/tab (\S+)/) || [])[1]
if (id) await tabs.switch(id)
await sleep(__WAIT__)
const SEL = __SEL__
const T = String(((await page.get(SEL ? {selector: SEL} : {})) || {}).tree || '')
if (id) { try { await tabs.close(id) } catch (e) {} }
return T
"""


def _bridge() -> BridgeClient:
    s = load_settings()
    return BridgeClient(
        s.bridge_url, s.bridge_token.get_secret_value(), allowed=(), busy_retries=60, busy_wait_s=5.0
    ).with_lane(LANE).scoped(['run_js'])


def _read(b: BridgeClient, url: str, wait_ms: int, selector: str = '') -> str:
    code = (
        _OPEN_READ_JS.replace('__URL__', json.dumps(url))
        .replace('__WAIT__', str(wait_ms))
        .replace('__SEL__', json.dumps(selector))
    )
    out = b.call('run_js', code=code, safety='no_pay')
    return str(getattr(out, 'result', out))


def _key(s: str) -> str:
    return re.sub(r'[^A-Z0-9]', '', str(s).upper())


def _price_after(text: str, title: str) -> int:
    head = re.sub(r'\s+', ' ', title)[:18]
    i = text.find(head)
    if i < 0:
        return 0
    m = re.search(r'([\d,]{4,})\s*원', text[i + len(head): i + len(head) + 260])
    return int(m.group(1).replace(',', '')) if m else 0


def _naver(b: BridgeClient, model: str) -> list[dict[str, object]]:
    tree = _read(b, 'https://search.naver.com/search.naver?where=nexearch&query=' + urllib.parse.quote(model), 7000)
    head, _, text = tree.partition('PAGE TEXT')
    text = re.sub(r'\s+', ' ', text)
    lines = [l for l in head.split('\n') if re.match(r'^\[\d+\] link', l)]
    rows: list[dict[str, object]] = []
    for i, line in enumerate(lines):
        m = re.match(r'^\[\d+\] link "([^"]+)" href=(\S+)', line)
        if not m or _key(model) not in _key(m.group(1)):
            continue
        title, url = m.group(1), m.group(2)
        nxt = re.match(r'^\[\d+\] link "([^"]{1,30})" href=', lines[i + 1]) if i + 1 < len(lines) else None
        mall = nxt.group(1) if nxt and _key(model) not in _key(nxt.group(1)) else ''
        source, product_url = None, None
        le = re.search(r'\b(LE\d{9,})\b', title)
        if le and ('롯데' in mall or 'lotteon' in url):
            source, product_url = 'LOTTEON', f'https://www.lotteon.com/p/product/{le.group(1)}'
        rows.append({'via': 'naver', 'mall': mall, 'price': _price_after(text, title), 'title': title,
                     'source': source, 'product_url': product_url or url[:160]})
    return rows


def _danawa(model: str) -> list[dict[str, object]]:
    """다나와는 브라우저 없이 페이지를 받아 읽는다 — 앱 트리는 바로가기 주소를 잘라 쇼핑몰 상품번호가 사라진다."""
    ua = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'}
    with httpx.Client(timeout=30, follow_redirects=True, headers=ua) as http:
        html = http.get('https://search.danawa.com/dsearch.php', params={'query': model}).text
        pcode = None
        for m in re.finditer(r'href="https://prod\.danawa\.com/info/\?pcode=(\d+)[^"]*"[^>]*>([^<]{4,200})<', html):
            if _key(model) in _key(m.group(2)):
                pcode = m.group(1)
                break
        if not pcode:
            m = re.search(r'prod\.danawa\.com/info/\?pcode=(\d+)', html)
            pcode = m.group(1) if m else None
        if not pcode:
            return []
        html = http.get('https://prod.danawa.com/info/', params={'pcode': pcode, 'keyword': model}).text
    rows: list[dict[str, object]] = []
    # 페이지 안 JSON(역슬래시로 감싼 따옴표일 수 있다) — logo·companyCode·linkProductCode·price
    html = html.replace('\\"', '"')
    pat = r'"logo":"([^"]+)".{0,200}?"companyCode":"(\w+)","linkProductCode":"([^"]+)".{0,200}?"price":"([\d,]+)'
    for m in re.finditer(pat, html, re.S):
        logo, code, pid, price = m.groups()
        mall = DANAWA_MALLS.get(code)
        if code in ('EE309', 'TLC16') and pid.startswith('LE'):
            mall = ('LOTTEON', 'https://www.lotteon.com/p/product/{}')
        rows.append({'via': 'danawa', 'mall': logo, 'price': int(price.replace(',', '')), 'title': f'{logo} {code}',
                     'source': mall[0] if mall else None, 'product_url': mall[1].format(pid) if mall else None})
    return rows


def search(model: str) -> dict[str, object]:
    b = _bridge()
    rows = _naver(b, model) + _danawa(model)
    seen, uniq = set(), []
    for r in rows:
        k = (r['source'], r['product_url'], r['price'])
        if k not in seen:
            seen.add(k)
            uniq.append(r)
    uniq.sort(key=lambda r: (r['source'] is None, int(r.get('price') or 0) or 10**9))
    return {'model': model, 'offers': uniq}


if __name__ == '__main__':
    for m in sys.argv[1:]:
        print(json.dumps(search(m), ensure_ascii=False))
