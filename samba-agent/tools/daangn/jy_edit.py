# 판매관리에서 내 글을 찾아 수정: 제목 교체, 사진 교체(선택), 완료
import json, sys, time
from post import dump, find, tap, sh, focused, sx, sy, go_sales, wait_for, push_images
from kbd import Kbd

def open_edit(title_prefix):
  assert go_sales()
  for _ in range(20): sh('input', 'swipe', '360', '400', '360', '1200', '150')
  time.sleep(1)
  for _ in range(12):
    nodes = dump(); t = next((n for n in nodes if n['t'].startswith(title_prefix)), None)
    if t and sy(400) < t['cy'] < sy(2000): break
    sh('input', 'swipe', str(sx(540)), str(sy(1700)), str(sx(540)), str(sy(900)), '400'); time.sleep(1.2)
  assert t, '카드 못 찾음: ' + title_prefix
  more = sorted([n for n in nodes if n['click'] and n['cx'] > sx(850) and 0 < t['cy'] - n['cy'] < sy(260)], key=lambda n: t['cy'] - n['cy'])
  assert more, '⋮ 없음'
  tap(more[0]['cx'], more[0]['cy'], 1.5)
  ed = None
  for _ in range(4):                                      # 메뉴 시트가 늦게 뜸
    nodes = dump(); ed = find(nodes, text='게시글 수정', exact=True)
    if ed: break
    time.sleep(1.0)
  print('메뉴:', [n['t'] for n in nodes if n['t']][:8])
  assert ed, '수정 항목 없음'
  tap(ed['cx'], ed['cy'], 3)
  nodes, _ = wait_for(lambda ns: find(ns, rid='tvPhotoCount'), what='수정 폼'); return nodes

def set_title(new_title, category=None):
  for _ in range(6): sh('input', 'swipe', '360', '400', '360', '1200', '150')     # 맨 위로(제목 칸)
  time.sleep(1); nodes = dump(); es = sorted([n for n in nodes if n['cls'] == 'EditText' and n['cy'] > 0], key=lambda n: n['cy'])
  assert es, '제목 EditText 없음'; e = es[0]
  tap(e['cx'], e['cy'], 0.7); sh('input', 'keycombination', '113', '29'); sh('input', 'keyevent', '67'); time.sleep(0.3)
  k = Kbd(); k.paste(new_title); time.sleep(0.6); k.close(); sh('input', 'keyevent', '4'); time.sleep(1.0)
  nodes = dump(); assert find(nodes, text=new_title), '제목 확인 실패'
  if category:                                             # 제목 바꾸면 카테고리가 풀림 → 칩 다시 선택
    chip = find(nodes, text=category, exact=True)
    if not chip:
      row = [n for n in nodes if n['t'] in ('디지털기기', '생활가전', '가구/인테리어')]
      if row: sh('input', 'swipe', str(sx(900)), str(row[0]['cy']), str(sx(200)), str(row[0]['cy']), '300'); time.sleep(1); nodes = dump(); chip = find(nodes, text=category, exact=True)
    assert chip, '카테고리 칩 없음: ' + category
    tap(chip['cx'], chip['cy'], 1.0)
    nodes = dump(); assert not find(nodes, text='카테고리를 선택해주세요.'), '카테고리 미선택'

def replace_photo(it):
  n_img = push_images(it)
  nodes = dump(); xs = sorted([n for n in nodes if n['d'] == '사진 삭제'], key=lambda n: n['cx'])
  for x in xs: tap(x['cx'], x['cy'], 1.2)
  nodes = dump(); pc = find(nodes, rid='tvPhotoCount'); tap(pc['cx'], pc['cy'], 2.5)
  nodes, _ = wait_for(lambda ns: find(ns, rid='title') and (find(ns, text='AI로 작성해요') or find(ns, text='모든 사진')), what='사진 선택')
  for label in ('여러 물건 글쓰기', 'AI로 작성해요'):
    lb = find(nodes, text=label)
    if lb:
      tg = [n for n in nodes if n['click'] and abs(n['cy'] - lb['cy']) < sy(60) and n['cx'] > sx(800)]
      if tg and tg[0]['chk']: tap(tg[0]['cx'], tg[0]['cy'], 0.7); nodes = dump()
  t = find(nodes, rid='title'); tap(t['cx'], t['cy'], 1.5)
  nodes, a = wait_for(lambda ns: find(ns, text='Bunjang ('), what='앨범 목록'); tap(a['cx'], a['cy'], 1.5)
  nodes, _ = wait_for(lambda ns: find(ns, text='Bunjang', exact=True) and find(ns, text='카메라'), what='앨범 격자')
  cam = find(nodes, text='카메라')
  cells = [n for n in nodes if n['click'] and n['cls'] == 'View' and n['cy'] > cam['cy'] - sy(120) and n['cy'] < sy(1950)
           and not (abs(n['cx'] - cam['cx']) < sx(60) and abs(n['cy'] - cam['cy']) < sy(120)) and n['b'][2] - n['b'][0] > sx(200)]
  cells.sort(key=lambda n: (round(n['cy'] / sy(300)), n['cx']))
  for c in cells[:n_img]: tap(c['cx'], c['cy'], 0.6)
  nodes, b = wait_for(lambda ns: find(ns, desc=f'{n_img}장 올리기'), what='올리기'); tap(b['cx'], b['cy'], 3)
  nodes, pc = wait_for(lambda ns: find(ns, rid='tvPhotoCount'), what='폼'); assert pc['t'].startswith(f'{n_img}/'), pc['t']

def finish():
  for _ in range(6):
    nodes = dump(); d = find(nodes, desc='수정 완료') or find(nodes, text='수정 완료', exact=True) or find(nodes, desc='작성 완료') or find(nodes, text='작성 완료', exact=True)
    if d: break
    sh('input', 'swipe', str(sx(540)), str(sy(1800)), str(sx(540)), str(sy(900)), '400'); time.sleep(1)
  assert d, '완료 버튼 없음'
  tap(d['cx'], d['cy'], 4); print('완료 후', focused()[-40:])

def card_menu(title_prefix):
  """판매관리에서 글 카드의 ⋮ 메뉴를 열어 (nodes) 돌려준다"""
  assert go_sales()
  for _ in range(20): sh('input', 'swipe', '360', '400', '360', '1200', '150')
  time.sleep(1)
  for _ in range(12):
    nodes = dump(); t = next((n for n in nodes if n['t'].startswith(title_prefix)), None)
    if t and sy(400) < t['cy'] < sy(2000): break
    sh('input', 'swipe', str(sx(540)), str(sy(1700)), str(sx(540)), str(sy(900)), '400'); time.sleep(1.2)
  assert t, '카드 못 찾음: ' + title_prefix
  more = sorted([n for n in nodes if n['click'] and n['cx'] > sx(850) and 0 < t['cy'] - n['cy'] < sy(260)], key=lambda n: t['cy'] - n['cy'])
  assert more, '⋮ 없음'
  tap(more[0]['cx'], more[0]['cy'], 1.5)
  return dump()

def hide_listing(title_prefix):
  """글 숨기기(되돌릴 수 있음) — 지우지 않는다"""
  nodes = card_menu(title_prefix); h = find(nodes, text='숨기기', exact=True)
  assert h, '숨기기 항목 없음'
  tap(h['cx'], h['cy'], 1.5); nodes = dump()
  ok = find(nodes, text='숨기기', exact=True) or find(nodes, text='확인', exact=True)
  print('숨김 확인창:', [n['t'] for n in nodes if n['t']][:8])
  if ok: tap(ok['cx'], ok['cy'], 2.0)

def set_price(new_price):
  for _ in range(4):
    nodes = dump(); lab = find(nodes, text='가격', exact=True)
    if lab and any(n['cls'] == 'EditText' and n['cy'] > lab['cy'] for n in nodes): break
    sh('input', 'swipe', str(sx(540)), str(sy(1800)), str(sx(540)), str(sy(900)), '400'); time.sleep(1)
  below = [n for n in nodes if n['cls'] == 'EditText' and n['cy'] > lab['cy']]; assert below, '가격 칸 없음'
  f = min(below, key=lambda n: n['cy']); tap(f['cx'], f['cy'], 0.8)
  sh('input', 'keycombination', '113', '29'); sh('input', 'keyevent', '67'); time.sleep(0.4)
  for ch in str(new_price): sh('input', 'text', ch); time.sleep(0.25)
  time.sleep(0.8); sh('input', 'keyevent', '4'); time.sleep(1.0)
  nodes = dump(); below = [n for n in nodes if n['cls'] == 'EditText' and n['cy'] > find(nodes, text='가격', exact=True)['cy']]
  val = min(below, key=lambda n: n['cy'])['t'].replace('￦', '').replace(',', '').strip()
  assert val == str(new_price), '가격 불일치: ' + val

if __name__ == '__main__':
  it = json.load(open(sys.argv[1], encoding='utf-8'))[0]
  mode = sys.argv[2] if len(sys.argv) > 2 else 'title+photo'
  if mode == 'hide': hide_listing(sys.argv[3] if len(sys.argv) > 3 else it['title'][:8]); sys.exit(0)
  open_edit(sys.argv[3] if len(sys.argv) > 3 else it['title'][:8])
  if 'price' in mode: set_price(it['price'])
  if 'photo' in mode: replace_photo(it)
  if 'title' in mode: set_title(it['title'], it.get('category'))
  finish()
