"""품절·가격 불일치 주문의 대체 판매처 찾기 — 네이버 쇼핑·다나와를 웨일(CDP 9223) 탭 하나로 검색한다(읽기만).

사용: .venv/Scripts/python.exe tools/alt_source/search.py <품번> [<품번2> ...]
출력: 판매처·가격·상품명, 하네스가 살 수 있는 소싱처면 source·product_url(작업 옵션에 그대로 넣는다).

- 네이버 쇼핑: 내장 브라우저는 막혀 있고 앱 브라우저는 '접속량 많음'으로 막힌다 — 사람이 쓰는 웨일로 읽는다(2026-11-05)
- 다나와: 바로가기(loadingBridge) 주소의 link_pcode 가 그 쇼핑몰 상품번호다 — 페이지를 넘기지 않고 주소를 만든다
- 웨일 탭은 공유 자원이다 — 탭 하나를 새로 열어 쓰고 반드시 닫는다
"""

import asyncio
import json
import re
import sys
import urllib.parse
import urllib.request

import websockets

sys.stdout.reconfigure(encoding='utf-8')
CDP = 'http://127.0.0.1:9223'

# 다나와 업체코드 → (하네스 소싱처, 상품 주소 틀)
DANAWA_MALLS = {
    'ED901': ('SSG', 'https://www.ssg.com/item/itemView.ssg?itemId={}'),
    'TN118': ('SSG', 'https://www.ssg.com/item/itemView.ssg?itemId={}'),
    'ED908': ('GSShop', 'https://www.gsshop.com/prd/prd.gs?prdid={}'),
}

_NAVER_JS = r"""(() => {
  const out = []
  const nd = document.getElementById('__NEXT_DATA__')
  const walk = (o) => { if (!o || typeof o !== 'object') return
    if (o.productTitle && (o.mallName || o.mallNameOrg)) out.push({title: o.productTitle, mall: o.mallName || o.mallNameOrg, price: +(o.price || o.lowPrice || 0), url: o.mallProductUrl || o.crUrl || o.adcrUrl || ''})
    for (const k in o) walk(o[k]) }
  if (nd) { try { walk(JSON.parse(nd.textContent)) } catch (e) {} }
  return JSON.stringify({title: document.title, items: out})
})()"""

_DANAWA_JS = r"""(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const key = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const M = __M__
  const hit = [...document.querySelectorAll('a[href*="pcode="]')].map(a => [a.innerText, a.href]).find(([t, h]) => /info\/\?pcode=\d+/.test(h) && key(t).includes(key(M)))
  return JSON.stringify({pcode_url: hit ? hit[1] : null})
})()"""

_DANAWA_ROWS_JS = r"""(() => {
  const out = []
  document.querySelectorAll('a[href*="loadingBridge"]').forEach(a => {
    const r = a.closest('li,tr'); const img = r && r.querySelector('img')
    const t = (r ? r.innerText : a.innerText).replace(/\s+/g, ' ')
    const c = (a.href.match(/cmpnyc=(\w+)/) || [])[1], p = (a.href.match(/link_pcode=(\d+)/) || [])[1]
    const price = +((t.replace(/배송비\s*[\d,]+원/g, '').match(/([\d,]{4,})\s*원/) || [])[1] || '0').replace(/,/g, '')
    out.push({mall: (img && img.alt) || '', code: c, pid: p, price, title: t.slice(0, 120)})
  })
  return JSON.stringify(out)
})()"""


def _naver_source(mall: str, url: str) -> tuple[str, str] | None:
    """네이버 쇼핑 판매처 줄 → 하네스 소싱처·상품 주소. 모르는 판매처면 None."""
    m = re.search(r'lotteon\.com/p/product/(LE\d+)', url)
    if m:
        return 'LOTTEON', f'https://www.lotteon.com/p/product/{m.group(1)}'
    m = re.search(r'gsshop\.com/.*prdseqnum=(\d+)', url)
    if m:
        return 'GSShop', f'https://www.gsshop.com/prd/prd.gs?prdid={m.group(1)}'
    m = re.search(r'ssg\.com/item/itemView\.ssg\?itemId=(\d+)', url)
    if m:
        return 'SSG', f'https://www.ssg.com/item/itemView.ssg?itemId={m.group(1)}'
    m = re.search(r'musinsa\.com/(?:products|app/goods)/(\d+)', url)
    if m:
        return 'MUSINSA', f'https://www.musinsa.com/products/{m.group(1)}'
    return None


async def _tab_eval(ws, url: str, scripts: list[str], wait: float) -> list[str]:
    n = 0

    async def call(method, params=None):
        nonlocal n
        n += 1
        await ws.send(json.dumps({'id': n, 'method': method, 'params': params or {}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get('id') == n:
                return m

    await call('Page.navigate', {'url': url})
    await asyncio.sleep(wait)
    out = []
    for js in scripts:
        r = await call('Runtime.evaluate', {'expression': js, 'returnByValue': True, 'awaitPromise': True})
        out.append(r['result']['result'].get('value') or '')
    return out


async def search(model: str) -> dict[str, object]:
    req = urllib.request.Request(f'{CDP}/json/new?about:blank', method='PUT')
    tab = json.loads(urllib.request.urlopen(req, timeout=10).read())
    rows: list[dict[str, object]] = []
    try:
        async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=50_000_000) as ws:
            (naver,) = await _tab_eval(
                ws, 'https://search.shopping.naver.com/search/all?query=' + urllib.parse.quote(model), [_NAVER_JS], 7
            )
            for it in json.loads(naver or '{}').get('items', []):
                if re.sub(r'[^A-Z0-9]', '', model.upper()) not in re.sub(r'[^A-Z0-9]', '', str(it['title']).upper()):
                    continue
                buy = _naver_source(str(it['mall']), str(it['url']))
                rows.append({'via': 'naver', 'mall': it['mall'], 'price': it['price'], 'title': it['title'],
                             'source': buy[0] if buy else None, 'product_url': buy[1] if buy else it['url'][:160]})
            (dn,) = await _tab_eval(
                ws, 'https://search.danawa.com/dsearch.php?query=' + urllib.parse.quote(model),
                [_DANAWA_JS.replace('__M__', json.dumps(model))], 5,
            )
            pcode_url = json.loads(dn or '{}').get('pcode_url')
            if pcode_url:
                (drows,) = await _tab_eval(ws, pcode_url, [_DANAWA_ROWS_JS], 6)
                for r in json.loads(drows or '[]'):
                    mall = DANAWA_MALLS.get(str(r.get('code')))
                    rows.append({'via': 'danawa', 'mall': r.get('mall') or r.get('code'), 'price': r.get('price'),
                                 'title': r.get('title'), 'source': mall[0] if mall else None,
                                 'product_url': mall[1].format(r['pid']) if mall and r.get('pid') else None})
    except websockets.exceptions.ConnectionClosed as e:
        # 탭이 도중에 닫히면(사람이 닫음·페이지 충돌) 읽은 데까지만 돌려준다
        rows.append({'via': 'error', 'mall': None, 'price': 0, 'title': f'웨일 탭 연결 끊김: {e}', 'source': None, 'product_url': None})
    finally:
        try:
            urllib.request.urlopen(f"{CDP}/json/close/{tab['id']}", timeout=10).read()
        except OSError:
            pass
    rows.sort(key=lambda r: (r['source'] is None, int(r.get('price') or 0) or 10**9))
    return {'model': model, 'offers': rows}


if __name__ == '__main__':
    for m in sys.argv[1:]:
        print(json.dumps(asyncio.run(search(m)), ensure_ascii=False))
