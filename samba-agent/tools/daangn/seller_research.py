# 경주(천북면 기준) 당근 중고거래 판매자 조사 — 느리게(요청 간 3~6초), 429 가 오면 길게 쉰다.
# 1단계: 키워드별 목록에서 상품 주소 모으기 → 2단계: 상품 페이지에서 판매자·가격·새상품 여부 → 3단계: 경주 판매자 프로필
# 사용: python -X utf8 seller_research.py [stage]   (체크포인트 seller_research/*.json 에서 이어 한다)
import html, json, os, random, re, sys, time, urllib.parse, urllib.request, urllib.error

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'seller_research')
os.makedirs(DIR, exist_ok=True)
REGION = '천북면-3139'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

KEYWORDS = ['제습기', '에어프라이어', '선풍기', '히터', '전기매트', '가습기', '청소기', '믹서기', '전기포트', '토스터', '커피머신', '밥솥',
            '새상품', '미개봉', '새제품', '미사용', '정품', '무료배송', '캠핑', '랜턴', '캠핑의자', '보조배터리', '충전기', '이어폰', '스피커',
            '시계', '가방', '신발', '운동화', '패딩', '화장품', '향수', '수건', '이불', '조명', '도마', '냄비', '프라이팬', '텀블러', '면도기',
            '드라이기', '고데기', '마사지', '체중계', '공구', '장난감', '선물세트', '영양제']


def load(name, default):
  p = os.path.join(DIR, name)
  return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else default


def save(name, data):
  json.dump(data, open(os.path.join(DIR, name), 'w', encoding='utf-8'), ensure_ascii=False)


class Blocked(Exception):
  pass


def get(url):
  """한 번에 하나, 3~6초 간격. 429·403 이면 Blocked"""
  time.sleep(3 + random.random() * 3)
  req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9'})
  try:
    with urllib.request.urlopen(req, timeout=30) as r:
      return r.read().decode('utf-8', 'replace')
  except urllib.error.HTTPError as e:
    if e.code in (429, 403):
      raise Blocked(str(e.code))
    if e.code == 404:
      return ''
    raise


def with_backoff(fn, *a):
  wait = 600
  while True:
    try:
      return fn(*a)
    except Blocked as e:
      print(f'[{time.strftime("%H:%M")}] 막힘 {e} — {wait // 60}분 쉰다', flush=True)
      time.sleep(wait)
      wait = min(wait * 2, 3600)
    except Exception as e:  # 네트워크 일시 오류
      print('오류', e, flush=True)
      time.sleep(60)


def region_name(rid):
  t = get('https://www.daangn.com/kr/buy-sell/?in=' + urllib.parse.quote('x-%d' % rid))
  m = re.search(r'경상북도 ([가-힣]+시) ([가-힣0-9.]+)에서 거래', t)
  return (m.group(1), m.group(2)) if m else None


def listing(rid):
  u = f'https://www.daangn.com/kr/buy-sell/?in={urllib.parse.quote("x-%d" % rid)}'
  t = get(u)
  out = []
  for li in re.findall(r'<li class="[^"]*"><a href="(/kr/buy-sell/[^"?]+-[a-z0-9]{12}/)"(.*?)</li>', t, flags=re.S):
    href, body = li
    txt = re.sub(r'<[^>]+>', '|', body)
    txt = [x.strip() for x in html.unescape(txt).split('|') if x.strip() and x.strip() != '·']
    out.append({'href': href, 'txt': txt[:8]})
  return out


def item(href):
  t = get('https://www.daangn.com' + href)
  if not t:
    return None
  g = lambda re_, s=t: (lambda m: m.group(1) if m else None)(re.search(re_, s))
  u = re.search(r'"user":\{"id":"[^"]*","dbId":"(\d+)","href":"([^"]*)","nickname":"((?:[^"\\]|\\.)*)"(.*?)"region":\{"dbId":"(\d+)","name":"([^"]*)","name1":"([^"]*)","name2":"([^"]*)"', t, flags=re.S)
  sc = re.search(r'"score":([\d.]+)', u.group(4)) if u else None
  rv = re.search(r'"reviewCount":(\d+)', u.group(4)) if u else None
  return {
    'title': g(r'"@type":"Product","name":"((?:[^"\\]|\\.)*)"'),
    'price': g(r'"price":"(\d+)"'),
    'cond': g(r'itemCondition":"https://schema.org/(\w+)"'),
    'desc': (g(r'"@type":"Product","name":"(?:[^"\\]|\\.)*","description":"((?:[^"\\]|\\.){0,200})') or '')[:200],
    'direct': '바로구매' in t,
    'seller': {'id': u.group(1), 'href': u.group(2), 'nick': u.group(3), 'dong': u.group(6), 'city': u.group(8),
               'score': float(sc.group(1)) if sc else None, 'rev': int(rv.group(1)) if rv else None} if u else None,
  }


def profile(href):
  t = get(href)
  txt = html.unescape(re.sub(r'<[^>]+>', ' ', re.sub(r'<script.*?</script>|<style.*?</style>', ' ', t, flags=re.S)))
  txt = re.sub(r'\s+', ' ', txt)
  return {'txt': txt[:2500], 'items': [{'t': m[0], 'p': m[1]} for m in re.findall(r'"name":"((?:[^"\\]|\\.)*)","description".*?"price":"(\d+)"', t)][:60]}


def main():
  stage = sys.argv[1] if len(sys.argv) > 1 else 'all'
  lists = load('listings.json', {})
  regions = load('regions.json', {})
  if stage in ('all', '1'):
    for rid in range(3115, 3185):
      if str(rid) in regions:
        continue
      regions[str(rid)] = with_backoff(region_name, rid)
      save('regions.json', regions)
    gj = [int(r) for r, v in regions.items() if v and v[0] == '경주시']
    print('경주 동', len(gj), flush=True)
    for rid in gj:
      if str(rid) in lists:
        continue
      lists[str(rid)] = with_backoff(listing, rid)
      save('listings.json', lists)
      print('목록', regions[str(rid)][1], len(lists[str(rid)]), flush=True)
  hrefs = {}
  for kw, rows in lists.items():
    for r in rows:
      hrefs.setdefault(r['href'], r['txt'])
  items = load('items.json', {})
  if stage in ('all', '2'):
    def priced(txt):
      for x in txt:
        m = re.fullmatch(r'([\d,]+)원', x)
        if m:
          return int(m.group(1).replace(',', ''))
      return 0
    todo = [h for h in hrefs if h not in items and (os.environ.get('ALL') == '1' or (priced(hrefs[h]) >= 10000 and '거래완료' not in hrefs[h]))]
    print('상품 대기', len(todo), flush=True)
    for i, h in enumerate(todo):
      items[h] = with_backoff(item, h) or {}
      if i % 10 == 0:
        save('items.json', items)
        print('상품', i, '/', len(todo), flush=True)
    save('items.json', items)
  profs = load('profiles.json', {})
  if stage in ('all', '3'):
    sellers = {}
    for h, x in items.items():
      s = (x or {}).get('seller')
      if s and '경주' in (s.get('city') or ''):
        sellers.setdefault(s['id'], s)
    todo = [s for s in sellers.values() if s['id'] not in profs]
    print('프로필 대기', len(todo), flush=True)
    for i, s in enumerate(todo):
      profs[s['id']] = with_backoff(profile, s['href'])
      if i % 5 == 0:
        save('profiles.json', profs)
        print('프로필', i, '/', len(todo), flush=True)
    save('profiles.json', profs)
  print('끝', flush=True)


if __name__ == '__main__':
  main()
