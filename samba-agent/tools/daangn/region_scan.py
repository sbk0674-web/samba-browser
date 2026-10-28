# 서울 행정동별 당근 중고거래 최신 매물(36건)을 천천히 훑어 위탁형(신품·바로구매 불가·고가) 적합도를 계산한다.
# 지역 목록 한 페이지에 지역 이름과 매물 카드가 같이 있어 요청 하나로 끝난다. 요청 간 3~6초, 429 면 길게 쉰다.
# 사용: python -X utf8 region_scan.py [시작id] [끝id]   → seller_research/regions_scan.json 에 쌓는다(이어 하기)
import html, json, os, re, sys, time, urllib.parse
import seller_research as sr

OUT = os.path.join(sr.DIR, 'regions_scan.json')
NEW_RE = re.compile(r'새상품|새제품|미개봉|미사용|신품|새것|정품|택포|무료배송')


def parse_cards(t):
  cards = []
  for href, body in re.findall(r'<li class="[^"]*"><a href="(/kr/buy-sell/[^"?]+-[a-z0-9]{12}/)"(.*?)</li>', t, flags=re.S):
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    txt = html.unescape(re.sub(r'<[^>]+>', '|', body))
    toks = [x.strip() for x in txt.split('|') if x.strip() and x.strip() != '·']
    full = ' '.join(toks)
    price = 0
    m = re.search(r'([\d,]{3,})원', full)
    if m:
      price = int(m.group(1).replace(',', ''))
    age = None
    m = re.search(r'(\d+)\s*(분|시간|일|주|개월)\s*전', full)
    if m:
      age = int(m.group(1)) * {'분': 1, '시간': 60, '일': 1440, '주': 10080, '개월': 43200}[m.group(2)]
    title = next((x for x in toks if not x.startswith('class=') and not re.fullmatch(r'[\d,]+원|바로구매|거래완료|예약중', x)), '')
    cards.append({'title': title, 'price': price, 'age': age, 'buynow': '바로구매' in full, 'sold': '거래완료' in full,
                  'new': bool(NEW_RE.search(title)), 'reserved': '예약중' in full})
  return cards


def scan(rid):
  t = sr.get('https://www.daangn.com/kr/buy-sell/?in=' + urllib.parse.quote('x-%d' % rid))
  m = re.search(r'([가-힣]+(?:특별시|광역시|특별자치시|도)) ([가-힣]+시(?: [가-힣]+구)?|[가-힣]+[군구]) ([가-힣0-9.·]+)에서 거래', t)
  if not m:
    return {'region': None}
  return {'region': list(m.groups()), 'cards': parse_cards(t)}


def main():
  a = int(sys.argv[1]) if len(sys.argv) > 1 else 1
  b = int(sys.argv[2]) if len(sys.argv) > 2 else 520
  step = int(sys.argv[3]) if len(sys.argv) > 3 else 1
  data = json.load(open(OUT, encoding='utf-8')) if os.path.exists(OUT) else {}
  miss = 0
  for rid in range(a, b + 1, step):
    if str(rid) in data:
      continue
    data[str(rid)] = sr.with_backoff(scan, rid)
    r = data[str(rid)].get('region')
    json.dump(data, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False)
    print(rid, r, len(data[str(rid)].get('cards', [])), flush=True)
    miss = 0 if r else miss + 1
    if step > 1 and miss >= 30:
      print('지역 구간 끝으로 보고 중단', flush=True)
      break
  print('끝', flush=True)


if __name__ == '__main__':
  main()
