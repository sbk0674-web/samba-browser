# 네이버 데이터랩 인기 키워드로 당근 매물을 모아, 관심·채팅이 많고 시세보다 싼 매물이 있는 동네를 찾는다(소싱용).
# 1) 키워드×대표 지역 검색 → 카드(제목·가격·동) 2) 키워드별 시세 중앙값보다 싼 후보만 상품 페이지에서 관심·채팅·조회 수 읽기
# 요청은 3~6초 간격. 체크포인트: seller_research/sourcing_*.json
import html, json, os, re, sys, urllib.parse
import seller_research as sr

DIR = sr.DIR
KEYWORDS = ['에어프라이어', '냄비', '무선청소기', '헤어드라이기', '갈바닉', '라면조리기', '후라이팬', '칼세트', '멀티쿠커', '캐리어', '웨건', '자동텐트', '캠핑테이블', '아이스박스',
            '목마사지기', '경추베개', '냉감이불', '베개', '손목마사지기', '텀블러', '장우산', '가습기', '전기장판', '제습기']
SRC = '수업 추천 21개(3주차 카테고리 리스트) + 데이터랩 인기 4개'
# (이름, 지역 id) — regions_scan.json 의 id. 경주 천북면은 3139
REGIONS = {}


def pick_region_ids():
  D = json.load(open(os.path.join(DIR, 'regions_scan.json'), encoding='utf-8'))
  want = [('서울특별시', '중구', '명동'), ('인천광역시', '서해구', '가좌4동'), ('부산광역시', '해운대구', '좌제1동'), ('경상남도', '창원시 성산구', '가음정동'),
          ('전북특별자치도', '전주시 완산구', '효자2동'), ('대전광역시', '유성구', '온천2동'), ('울산광역시', '남구', '달동'), ('대구광역시', '북구', '검단동'),
          ('경기도', '수원시 영통구', '원천동'), ('경기도', '성남시 수정구', '고등동')]
  keep = {('서울특별시', '중구', '명동'), ('인천광역시', '서해구', '가좌4동'), ('부산광역시', '해운대구', '좌제1동'), ('대구광역시', '북구', '검단동'), ('대전광역시', '유성구', '온천2동')}
  for k, v in D.items():
    r = v.get('region')
    if r and tuple(r) in want and tuple(r) in keep:
      REGIONS['%s %s' % (r[1], r[2])] = int(k)
  REGIONS['경주 천북면'] = 3139


def cards(t):
  out = []
  for href, body in re.findall(r'<li class="[^"]*"><a href="(/kr/buy-sell/[^"?]+-[a-z0-9]{12}/)"(.*?)</li>', t, flags=re.S):
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    toks = [x.strip() for x in html.unescape(re.sub(r'<[^>]+>', '|', body)).split('|') if x.strip() and x.strip() != '·']
    full = ' '.join(toks)
    m = re.search(r'([\d,]{3,})원', full)
    title = next((x for x in toks if not x.startswith('class=') and not re.fullmatch(r'[\d,]+원|나눔|바로구매|거래완료|예약중', x)), '')
    out.append({'href': href, 'title': title, 'price': int(m.group(1).replace(',', '')) if m else 0, 'sold': '거래완료' in full, 'buynow': '바로구매' in full,
                'dong': next((x for x in toks if re.fullmatch(r'[가-힣0-9.]+(?:동|읍|면|가)', x)), '')})
  return out


def search(kw, rid):
  return cards(sr.get('https://www.daangn.com/kr/buy-sell/?in=' + urllib.parse.quote('x-%d' % rid) + '&search=' + urllib.parse.quote(kw)))


def item(href):
  t = sr.get('https://www.daangn.com' + href)
  if not t:
    return None
  g = lambda p: (lambda m: int(m.group(1)) if m else None)(re.search(p, t))
  reg = re.search(r'"region":\{"dbId":"(\d+)","name":"([^"]*)","name1":"([^"]*)","name2":"([^"]*)"', t)
  return {'fav': g(r'"favoriteCount":(\d+)'), 'chat': g(r'"chatCount":(\d+)'), 'view': g(r'"viewCount":(\d+)'),
          'region': list(reg.groups()) if reg else None, 'status': (re.search(r'"status":"(\w+)"', t) or [None, None])[1]}


def main():
  pick_region_ids()
  print('지역', REGIONS, flush=True)
  pa = os.path.join(DIR, 'sourcing_search.json')
  A = json.load(open(pa, encoding='utf-8')) if os.path.exists(pa) else {}
  for kw in KEYWORDS:
    for rn, rid in REGIONS.items():
      key = f'{kw}|{rn}'
      if key in A:
        continue
      A[key] = sr.with_backoff(search, kw, rid)
      json.dump(A, open(pa, 'w', encoding='utf-8'), ensure_ascii=False)
      print('검색', key, len(A[key]), flush=True)
  # 키워드별 시세 중앙값(나눔·거래완료 제외, 제목에 키워드 포함)
  import statistics as st
  pool = {}
  for key, rows in A.items():
    kw = key.split('|')[0]
    for c in rows:
      if kw in c['title'].replace(' ', '') and c['price'] >= 3000 and not c['sold']:
        pool.setdefault(kw, {})[c['href']] = c
  cand = []
  for kw, d in pool.items():
    med = st.median([c['price'] for c in d.values()])
    cheap = [c for c in d.values() if c['price'] <= 0.8 * med]
    cheap.sort(key=lambda c: c['price'] / med)
    for c in cheap[:10]:
      cand.append((kw, med, c))
  print('후보', len(cand), flush=True)
  pb = os.path.join(DIR, 'sourcing_items.json')
  B = json.load(open(pb, encoding='utf-8')) if os.path.exists(pb) else {}
  for i, (kw, med, c) in enumerate(cand):
    if c['href'] in B:
      continue
    x = sr.with_backoff(item, c['href']) or {}
    x.update({'kw': kw, 'med': med, 'title': c['title'], 'price': c['price'], 'dong': c['dong'], 'buynow': c['buynow']})
    B[c['href']] = x
    if i % 10 == 0:
      json.dump(B, open(pb, 'w', encoding='utf-8'), ensure_ascii=False)
      print('상품', i, '/', len(cand), flush=True)
  json.dump(B, open(pb, 'w', encoding='utf-8'), ensure_ascii=False)
  print('끝', flush=True)


if __name__ == '__main__':
  main()
