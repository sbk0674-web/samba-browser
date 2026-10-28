# 번개장터 상세를 다시 조회해 당근 제목·설명 구성 — 사람이 쓴 글처럼(템플릿 몇 가지를 상품마다 섞어 씀)
import json, os, random, re, urllib.request
COND = {'NEW': '새 상품', 'LIKE_NEW': '사용감 거의 없는 상품', 'LIGHTLY_USED': '사용감 적은 상품', 'HEAVILY_USED': '사용감 있는 상품', 'DEFECTIVE': '하자 있는 상품'}

def fetch(pid):
  try:
    req = urllib.request.Request(f'https://api.bunjang.co.kr/api/pms/v3/products-detail/{pid}?viewerUid=-1', headers={'User-Agent': 'Mozilla/5.0'})
    return json.load(urllib.request.urlopen(req, timeout=20))['data']['product']
  except Exception:
    # API 차단(403) 시 크롬으로 받아 둔 캐시(bunjang/fresh.json) 사용
    fresh = json.load(open('bunjang/fresh.json', encoding='utf-8')) if os.path.exists('bunjang/fresh.json') else {}
    if str(pid) in fresh:
      return fresh[str(pid)]
    for it in json.load(open('bunjang/items.json', encoding='utf-8')):   # 마지막 수단: 어제 받은 items.json
      if it['pid'] == str(pid):
        return {'name': it['name'], 'price': it['price'], 'description': it['description'], 'condition': it.get('condition'),
                'saleStatus': it['saleStatus'], 'imageCount': len(it['images']), 'brand': None, 'options': [],
                'categories': [{'name': c} for c in it['categories']]}
    raise

def size_of(p):
  for o in p.get('options') or []:
    if o.get('optionGroupName') == '사이즈':
      v = o['optionValue']
      if v.startswith('기타'): return None, None   # '기타 (상품설명에 작성)' 은 사이즈 없음
      unit = o.get('childOptionGroupUnit') or ''
      if unit == 'mm' and not v.endswith('mm'): v = v + 'mm'
      elif unit and unit not in ('공용', '기타') and not v.upper().startswith(unit.split('/')[0]): v = f'{unit.split("/")[0]} {v}'   # US/UK·EU 사이즈는 단위 붙임
      return v, o.get('childOptionGroupName') or ''
  return None, None

def model_no(desc):
  m = re.search(r'모델 ?번호\s*\n?\s*([A-Za-z0-9][A-Za-z0-9\- /]{3,40})', desc or '')
  return m.group(1).strip() if m else None

def color_of(desc):
  m = re.search(r'색상\s*\n?\s*([^\n]{2,40})', desc or '')
  return m.group(1).strip() if m else None

def extra_notes(desc):
  """번개장터 설명에서 판매자가 직접 쓴 문장만(영문명·모델번호·색상·사이즈 같은 스펙 줄 제외)"""
  lines = [l.strip() for l in (desc or '').split('\n')]
  out = []; skip_next = False
  for i, l in enumerate(lines):
    if i == 0 or not l: continue
    if l in ('모델 번호', '색상', '사이즈', '상태', '구성품', '구성', '브랜드'): skip_next = True; continue
    if skip_next: skip_next = False; continue
    if re.fullmatch(r"[A-Za-z0-9 \-/().,&'\"]+", l): continue
    if len(l) < 10 or not re.search(r'(요|다|죠|음|함|\.|!|~)$', l): continue
    out.append(l)
  return out

def compose(pid):
  p = fetch(pid)
  rnd = random.Random(int(pid))        # 상품마다 고정된 무작위(재실행해도 같은 문장)
  size, grp = size_of(p)
  name = p['name']
  shoe = any(c.get('name') == '신발' for c in p.get('categories', []))
  kid = any('유아동' in (c.get('name') or '') for c in p.get('categories', []))
  cloth = any((c.get('name') or '') in ('남성의류', '여성의류') for c in p.get('categories', []))
  cond = COND.get(p.get('condition'), '')
  size_txt = size or ''
  if size_txt and (size_txt.replace('mm','') in name.split() or len(size_txt.replace('mm','')) < 2): size_txt = ''   # 이름에 이미 있거나 '1' 같은 애매한 값
  # 제목
  t_opts = [f'{name} {size_txt}', f'{name} {size_txt} 팔아요', f'{name} {size_txt} 새상품' if cond == '새 상품' else f'{name} {size_txt}', f'{name} {size_txt} 급처' if rnd.random() < 0.3 else f'{name} {size_txt}']
  title = re.sub(r'\s+', ' ', rnd.choice(t_opts)).strip()[:40]
  # 본문: 스펙 나열 대신 사람 말투 2~4문장 (사정 한 줄 + 사이즈/상태 + 거래 안내)
  reasons_new = ['선물 받았는데 사이즈가 안 맞아서 내놓아요.', '사이즈 착각하고 주문해서 한 번도 못 신었어요.', '같은 걸 두 개 사게 돼서 하나 정리합니다.',
                 '신발장 정리하면서 내놓습니다.', '발볼이 안 맞아서 신어보지도 못했어요.', '교환 기간 놓쳐서 그냥 팝니다.', '안 신게 돼서 필요하신 분께 드려요.',
                 '선물용으로 샀다가 못 드리게 됐어요.']
  reasons_new_cloth = ['사이즈가 안 맞아서 내놓아요.', '옷장 정리하면서 내놓습니다.', '택도 안 뗀 새 옷이에요. 안 입게 돼서 팝니다.', '선물 받았는데 제 스타일이 아니라 내놓습니다.']
  reasons_new_etc = ['선물 받았는데 안 쓰게 돼서 내놓아요.', '정리하면서 내놓습니다. 새 거예요.', '중복으로 생겨서 하나 팝니다.']
  reasons_used = ['몇 번 안 신어서 상태 좋아요.', '잠깐 신고 보관만 했어요.', '사진처럼 깨끗한 편이에요.']
  lines = []
  head = [f'{name} {size_txt} 팔아요.', f'{name} {size_txt} 내놓습니다.', f'{name} {size_txt}이에요.'] + ([f'{name} 판매해요. 사이즈 {size_txt}.'] if size_txt else [f'{name} 판매해요.'])
  lines.append(re.sub(r'\s+', ' ', rnd.choice(head)).replace(' 이에요', '이에요').strip())
  if cond == '새 상품':
    lines.append(rnd.choice(reasons_new if shoe else reasons_new_cloth if cloth else reasons_new_etc))
    lines.append(rnd.choice(['박스랑 택 다 있어요.', '새 거라 상태는 깨끗해요.', '정품이고 박스 그대로예요.', '한 번도 안 신은 새 제품이에요.'] if shoe else ['택 그대로 있어요.', '새 거라 상태 깨끗해요.', '한 번도 안 입은 새 옷이에요.'] if cloth else ['택 그대로 있어요.', '새 거라 상태 깨끗해요.', '한 번도 안 쓴 새 거예요.']))
  else:
    lines.append(rnd.choice(reasons_used))
  notes = extra_notes(p.get('description'))
  if notes: lines.append(' '.join(notes)[:120])
  lines.append('')
  lines.append(rnd.choice(['용황 쪽 직거래 좋고 택배도 가능해요.', '직거래는 용황에서, 택배도 보내드려요.', '용황 근처면 직거래 하고, 멀면 택배로 보내드릴게요.']))
  lines.append(rnd.choice(['편하게 채팅 주세요~', '궁금한 거 있으면 채팅 주세요 :)', '네고는 조금만요 ㅎㅎ 채팅 주세요.', '빠른 답 드릴게요.']))
  return {'pid': str(pid), 'name': name, 'title': title, 'description': '\n'.join(lines), 'price': p['price'],
          'saleStatus': p['saleStatus'], 'size': size, 'categories': [c.get('name') for c in p.get('categories', [])],
          'imageCount': p['imageCount']}

if __name__ == '__main__':
  import sys, io
  sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
  for pid in sys.argv[1:]:
    r = compose(pid); print(r['title']); print(r['description']); print('---')
