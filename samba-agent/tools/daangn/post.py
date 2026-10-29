# 번개장터 상품 하나를 당근마켓(S916N)에 등록하는 전체 흐름
import os, json, re, subprocess, sys, time, io
import xml.etree.ElementTree as ET
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from kbd import Kbd, ADB, DEV
from compose import compose

MAIN = json.load(open('main_images.json', encoding='utf-8')) if os.path.exists('main_images.json') else {}
def _wm():
  out = subprocess.run([ADB, '-s', DEV, 'shell', 'wm', 'size'], creationflags=0x08000000, capture_output=True, text=True).stdout
  ms = re.findall(r'(\d+)x(\d+)', out); m = ms[-1] if ms else None   # Override size 가 있으면 그것(G950N 1440x2960 → 1080x2220)
  return (int(m[0]), int(m[1])) if m else (1080, 2340)
W, H = _wm()                      # 기기 화면 크기(S916N 1080x2340, A426N 720x1600)
def sx(v): return round(v * W / 1080)   # 1080 기준 x 를 이 기기로
def sy(v): return round(v * H / 2340)   # 2340 기준 y 를 이 기기로

def sh(*a):
  return subprocess.run([ADB, '-s', DEV, 'shell', *a], creationflags=0x08000000, capture_output=True)

def focused():
  out = subprocess.run([ADB, '-s', DEV, 'shell', 'dumpsys', 'window'], creationflags=0x08000000, capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
  m = re.search(r'mCurrentFocus=.*?(\S+)\}', out)
  f = m.group(1) if m else ''
  if not f or 'Responding' in (m.group(0) if m else ''):                                 # ANR 창·null 이면 맨 앞 액티비티로 판정
    out = subprocess.run([ADB, '-s', DEV, 'shell', 'dumpsys', 'activity', 'activities'], creationflags=0x08000000, capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
    m = re.search(r'(?:topResumedActivity|mResumedActivity)[=:] ?ActivityRecord\{\S+ u0 (\S+)', out)
    f = m.group(1) if m else f
  return f

def on_sales():
  return 'MySalesActivity' in focused()

def go_sales():
  """어떤 화면이든 판매관리(MySalesActivity)로 되돌린다. 홍보글·폼·상세는 뒤로, 저장 묻는 창은 '저장 안 함'."""
  for _ in range(8):
    if on_sales():
      nodes = dump()
      if find(nodes, text='글쓰기', exact=True): time.sleep(4); return True   # 배너·토스트 사라질 시간
    nodes = dump()
    b = find(nodes, text='저장 안 함', exact=True)
    if b: tap(b['cx'], b['cy'], 1.5); continue
    f = focused()
    if 'towneers' not in f or 'MainActivity' in f:
      # 앱 밖(런처 등)이거나 당근 홈: 앱 실행 → 나의 당근 → 판매관리
      sh('monkey', '-p', 'com.towneers.www', '-c', 'android.intent.category.LAUNCHER', '1'); time.sleep(3)
      nodes = dump(); my = find(nodes, text='나의 당근', exact=True)
      if my:
        tap(my['cx'], my['cy'], 2)
        for _ in range(3):
          nodes = dump(); sm = find(nodes, text='판매관리', exact=True)
          if sm and sm['cy'] < sy(2050): tap(sm['cx'], sm['cy'], 2.5); break
          sh('input', 'swipe', str(sx(540)), str(sy(1700)), str(sx(540)), str(sy(900)), '400'); time.sleep(1)
      continue
    sh('input', 'keyevent', '4'); time.sleep(1.5)
  return False

def tap(x, y, wait=1.0):
  sh('input', 'swipe', str(x), str(y), str(x), str(y), '60'); time.sleep(wait)   # XCover 에서 input tap 이 X·임시저장 버튼에 안 먹어 짧은 누름으로

def dump():
  import hashlib
  uif = 'ui_' + hashlib.md5(DEV.encode()).hexdigest()[:10] + '.xml'   # 기기별 파일(mDNS 이름은 끝이 같아 해시로 구분)
  root = None
  for attempt in range(4):   # 덤프가 비면(기기 순간 끊김·하네스와 겹침) 잠깐 쉬고 다시
    sh('rm', '-f', '/sdcard/ui_daangn.xml')                  # 덤프 실패 때 옛 파일을 읽지 않도록 먼저 지움
    if os.path.exists(uif): os.remove(uif)
    sh('uiautomator', 'dump', '/sdcard/ui_daangn.xml')
    subprocess.run([ADB, '-s', DEV, 'pull', '/sdcard/ui_daangn.xml', uif], creationflags=0x08000000, capture_output=True)
    try:
      root = ET.fromstring(open(uif, 'rb').read().decode('utf-8', 'replace')); break
    except (ET.ParseError, FileNotFoundError):
      time.sleep(2 + attempt * 2)
  if root is None: raise RuntimeError('화면 덤프 실패(기기 연결 확인)')
  nodes = []
  for n in root.iter('node'):
    b = [int(v) for v in re.findall(r'\d+', n.get('bounds'))]
    nodes.append({'t': n.get('text') or '', 'd': n.get('content-desc') or '', 'id': (n.get('resource-id') or '').split('/')[-1],
                  'cx': (b[0] + b[2]) // 2, 'cy': (b[1] + b[3]) // 2, 'click': n.get('clickable') == 'true',
                  'chk': n.get('checked') == 'true', 'sel': n.get('selected') == 'true', 'foc': n.get('focused') == 'true', 'cls': n.get('class').split('.')[-1], 'b': b})
  return nodes

def find(nodes, text=None, desc=None, rid=None, exact=False):
  for n in nodes:
    if text is not None and ((n['t'] == text) if exact else (text in n['t'])): return n
    if desc is not None and ((n['d'] == desc) if exact else (desc in n['d'])): return n
    if rid is not None and n['id'] == rid: return n
  return None

def wait_for(pred, timeout=10, step=0.7, what=''):
  end = time.time() + timeout
  while time.time() < end:
    nodes = dump()
    r = pred(nodes)
    if r: return nodes, r
    time.sleep(step)
  raise RuntimeError('기다리던 화면이 안 나옴: ' + what)

def category_for(it):
  path = ' > '.join(it['categories']); name = it['name']
  if '유아동' in path or '(TD)' in name or '(J)' in name or '(PS)' in name or '키즈' in name or '주니어' in name: return '유아동'
  if '캐리어' in name or '여행가방' in name: return '생활/주방'
  if '트레이딩 카드' in path: return '취미/게임/음반'
  if path.startswith('가방') or path.startswith('패션 액세서리'): return '여성잡화' if '여성' in path else '남성패션/잡화'
  if path.startswith('남성의류'): return '남성패션/잡화'
  if path.startswith('여성의류'): return '여성의류'
  if '축구/풋살' in path: return '스포츠/레저'
  if '향수' in path or '뷰티' in path: return '뷰티/미용'
  if '가구/인테리어' in path: return '가구/인테리어'
  if path.startswith('여성의류'): return '여성의류'
  if path.startswith('신발'):
    if '여성화' in path or '(W)' in name or '(GS)' in name: return '여성잡화'
    return '남성패션/잡화'
  return '남성패션/잡화'

def push_images(it):
  from photo_policy import is_musinsa_item
  DIR = '/sdcard/DCIM/Bunjang'
  old = sh('ls', DIR).stdout.decode().split()
  for f in old:
    sh('rm', '-f', f'{DIR}/{f}')
    sh('content', 'call', '--uri', 'content://media/external/file', '--method', 'scan_file', '--arg', f'{DIR}/{f}')
    sh('am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', f'file://{DIR}/{f}')   # 지운 파일도 방송 스캔해야 안드로이드 9 앨범 개수에서 빠진다
  sh("content delete --uri content://media/external/file --where \"_data like '%/DCIM/Bunjang/%'\"")   # 안드로이드 9 는 지운 파일 기록이 갤러리 DB에 남아 앨범 개수가 어긋나므로 기록째 삭제
  sh('mkdir', '-p', DIR)
  imgs = list(it['images'][:10])
  MAIN.update(json.load(open('main_images.json', encoding='utf-8')) if os.path.exists('main_images.json') else {})   # 매번 다시 읽음
  main = None if is_musinsa_item(it) else MAIN.get(it['pid'])  # 무신사는 첫 썸네일을 유지한다
  if main and 1 <= main <= len(imgs):
    imgs.insert(0, imgs.pop(main - 1))
  for n, src in enumerate(imgs, 1):
    dst = f'{DIR}/{it["pid"]}_{n}_{int(time.time())}.jpg'   # 같은 이름으로 다시 밀어넣으면 앱이 옛 캐시(이전 사진)를 올릴 수 있어 매번 새 이름
    subprocess.run([ADB, '-s', DEV, 'push', src, dst], creationflags=0x08000000, capture_output=True)
    sh('touch', '-d', f'@{int(time.time()) - n * 2}', dst)   # 1번(대표)이 가장 최신 → 앨범 격자 첫 칸
    sh('content', 'call', '--uri', 'content://media/external/file', '--method', 'scan_file', '--arg', dst)
    sh('am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', f'file://{dst}')   # 안드로이드 9(G950N)은 scan_file 호출을 지원하지 않아 방송으로 갤러리에 등록
  return len(imgs)

def edit_text_below(nodes, label):
  """라벨 아래 가장 가까운 EditText"""
  lb = find(nodes, text=label, exact=True)
  cands = [n for n in nodes if n['cls'] == 'EditText' and n['cy'] > lb['cy']]
  return min(cands, key=lambda n: n['cy'])

def post(it):
  from photo_policy import validate_photo_policy
  validate_photo_policy(it)
  n_img = push_images(it)
  want = it.get('category') or category_for(it)
  # 1) 판매관리 화면의 글쓰기
  nodes, _ = wait_for(lambda ns: on_sales() and find(ns, text='판매관리', exact=True) and find(ns, text='글쓰기', exact=True), what='판매관리(MySalesActivity)')
  w = next(n for n in nodes if n['t'] == '글쓰기' and n['cy'] < sy(300))   # 판매관리 헤더의 글쓰기
  tap(w['cx'], w['cy'], 2.5)
  # 임시저장 글 대화상자: 메시지와 버튼을 기록하고 '새로 작성' 쪽을 고른다
  nodes = dump(); msg = find(nodes, rid='message')
  if msg:
    btns = [n for n in nodes if n['cls'] == 'Button' and n['t']]
    print('대화상자:', msg['t'], [b['t'] for b in btns])
    pick = next((b for b in btns if any(k in b['t'] for k in ('새로', '삭제', '안 함', '아니'))), None) or find(nodes, rid='negativeButton')
    assert pick, '대화상자 버튼 선택 실패'
    tap(pick['cx'], pick['cy'], 2.0)
  # 2) 사진 선택 화면: AI 작성 끄기, 앨범 Bunjang
  # 사진 선택창이 바로 뜨거나, 빈 폼이 먼저 뜨면 사진 칸(0/10)을 눌러 연다
  # '여러 물건 글쓰기' 안내 시트(XCover 10/21)가 덮으면 닫는다
  for _ in range(3):
    nodes = dump()
    if find(nodes, text='여러 물건의 판매 글을 쉽게 쓸 수 있어요.') or find(nodes, desc='시트 닫기'):
      c = find(nodes, desc='닫기') or find(nodes, desc='시트 닫기'); tap(c['cx'], c['cy'], 2); continue
    break
  def album_title(ns):   # 새 사진 선택창은 리소스 id 없이 '모든 사진' 글자만 있다(서병기 S23 10/23)
    return find(ns, rid='title') or find(ns, text='모든 사진', exact=True)
  nodes, hit = wait_for(lambda ns: (album_title(ns) and find(ns, text='AI로 작성해요')) or find(ns, rid='tvPhotoCount'), what='사진 선택 또는 폼')
  if find(nodes, rid='tvPhotoCount') and not find(nodes, text='AI로 작성해요'):
    pc = find(nodes, rid='tvPhotoCount'); tap(pc['cx'], pc['cy'], 2.5)
    nodes, _ = wait_for(lambda ns: album_title(ns) and find(ns, text='AI로 작성해요'), what='사진 선택')
  assert 'DaangnWebActivity' not in focused(), '홍보글 화면으로 튐'
  for label in ('여러 물건 글쓰기', 'AI로 작성해요'):   # 둘 다 끈다(여러 물건 글쓰기가 켜지면 사진을 AI 가 나눠 글을 만듦)
    lb = find(nodes, text=label)
    if not lb: continue
    toggle = [n for n in nodes if n['click'] and abs(n['cy'] - lb['cy']) < sy(60) and n['cx'] > sx(800)]
    if toggle and toggle[0]['chk']:
      tap(toggle[0]['cx'], toggle[0]['cy'], 0.7); nodes = dump()
  t = album_title(nodes); tap(t['cx'], t['cy'], 1.5)
  nodes, a = wait_for(lambda ns: find(ns, text='Bunjang ('), what='앨범 목록')
  assert a['t'] == f'Bunjang ({n_img})', f'앨범 사진 수 불일치: {a["t"]} vs {n_img}'
  tap(a['cx'], a['cy'], 1.5)
  nodes, _ = wait_for(lambda ns: find(ns, text='Bunjang', exact=True) and find(ns, text='카메라'), what='앨범 격자')
  cam = find(nodes, text='카메라')
  cells = [n for n in nodes if n['click'] and n['cls'] == 'View' and n['cy'] > cam['cy'] - sy(120) and n['cy'] < sy(1950)
           and not (abs(n['cx'] - cam['cx']) < sx(60) and abs(n['cy'] - cam['cy']) < sy(120)) and n['b'][2] - n['b'][0] > sx(200)]
  cells.sort(key=lambda n: (round(n['cy'] / sy(300)), n['cx']))
  assert len(cells) >= n_img, f'격자 칸 부족: {len(cells)} < {n_img}'
  for n in cells[:n_img]:
    tap(n['cx'], n['cy'], 0.5)
  nodes, b = wait_for(lambda ns: find(ns, desc=f'{n_img}장 올리기'), what=f'{n_img}장 올리기')
  tap(b['cx'], b['cy'], 3)
  # 3) 폼
  for _ in range(20):                           # AI 작성 진행창이 뜨면 끝날 때까지(제목·내용은 어차피 덮어씀)
    nodes = dump()
    if not find(nodes, text='거의 다 되었어요!') and not find(nodes, text='AI가 글을'): break
    time.sleep(2)
  nodes, pc = wait_for(lambda ns: find(ns, rid='tvPhotoCount'), what='글쓰기 폼')
  assert pc['t'] == f'{n_img}/10', pc['t']
  k = Kbd()
  try:
    e = edit_text_below(nodes, '제목'); tap(e['cx'], e['cy'], 0.7)
    k.paste(it['title']); time.sleep(0.5); sh('input', 'keyevent', '4'); time.sleep(1.0)
    # 카테고리 칩(제목 아래 나타남)
    nodes = dump()
    chip = find(nodes, text=want, exact=True)
    if chip:
      tap(chip['cx'], chip['cy'], 0.8)
    else:
      # 칩 줄(제목 아래 첫 TextView 줄)의 오른쪽 끝 '더보기' 버튼
      title_e = edit_text_below(nodes, '제목')
      chips = [n for n in nodes if n['cls'] == 'TextView' and n['t'] and title_e['cy'] + 60 < n['cy'] < title_e['cy'] + 260]
      assert chips, '카테고리 칩 영역 없음'
      row_y = chips[0]['cy']
      more = [n for n in nodes if n['click'] and abs(n['cy'] - row_y) < sy(40) and n['cx'] > sx(950)]
      assert more, '카테고리 더보기 버튼 없음'
      tap(more[0]['cx'], more[0]['cy'], 1.5)
      nodes, c = wait_for(lambda ns: find(ns, text=want, exact=True), 6, what='카테고리 목록 ' + want)
      tap(c['cx'], c['cy'], 1.2)
    nodes = dump()
    assert find(nodes, text='카테고리를 선택해주세요.') is None, '카테고리 미선택'
    # 사이즈 칸(패션 카테고리면 카테고리 선택 뒤 나타남)
    if find(nodes, text='사이즈 ', exact=True):
      e = edit_text_below(nodes, '사이즈 '); tap(e['cx'], e['cy'], 0.7)
      k.paste((it.get('size') or '없음').replace('mm', '')); time.sleep(0.5); sh('input', 'keyevent', '4'); time.sleep(1.0)
      nodes = dump()
      e = edit_text_below(nodes, '사이즈 '); assert e['t'].strip(), '사이즈 입력 실패'
    # 설명
    e = edit_text_below(nodes, '자세한 설명'); tap(e['cx'], e['cy'], 0.7)
    k.paste(it['description']); time.sleep(0.7); sh('input', 'keyevent', '4'); time.sleep(1.2)
    # 옛 당근(A426N 26.36): 폼에 가격 칸 대신 '가격을 입력해주세요' 줄 → 별도 가격 설정 화면
    nodes = dump()
    def price_field(ns):   # 새 UI: KarrotTextField 또는 '가격' 힌트가 있는 EditText(XCover 10/21 은 id 없음)
      f = find(ns, rid='KarrotTextField') or next((n for n in ns if n['cls'] == 'EditText' and ('가격' in n['t'] or '￦' in n['t'] or n['t'].replace(',', '').isdigit())), None)
      if f: return f
      lab = find(ns, text='가격', exact=True)              # S23 새 UI: id·텍스트 없는 EditText 가 '가격' 라벨 아래
      if lab:
        below = [n for n in ns if n['cls'] == 'EditText' and n['cy'] > lab['cy']]
        if below: return min(below, key=lambda n: n['cy'])
      return None
    old_ui = price_field(nodes) is None and find(nodes, text='가격을 입력해주세요') is not None and find(nodes, text='가격을 입력해주세요')['cls'] != 'EditText'
    if old_ui:
      row = find(nodes, text='가격을 입력해주세요'); tap(row['cx'], row['cy'], 2)
      nodes, pf = wait_for(lambda ns: find(ns, rid='KarrotTextField'), what='가격 설정 화면')
      tap(pf['cx'], pf['cy'], 0.6); sh('input', 'keycombination', '113', '29'); sh('input', 'keyevent', '67'); time.sleep(0.3)
      sh('input', 'text', str(it['price'])); time.sleep(1.0)
      nodes = dump(); pf = find(nodes, rid='KarrotTextField')
      assert pf['t'].replace('￦', '').replace(',', '').strip() == str(it['price']), '가격 불일치: ' + pf['t']
      sh('input', 'keyevent', '4'); time.sleep(1.2)                      # 키보드 먼저 닫아야 완료 버튼이 덤프에 잡힘
      nodes = dump(); done_btn = [n for n in nodes if n['t'] == '완료' and n['cy'] > sy(400)]
      if done_btn: tap(done_btn[-1]['cx'], done_btn[-1]['cy'], 2)
      else: tap(sx(540), sy(2113), 2)        # 주황 '완료' 버튼은 접근성 트리에 안 잡힘 → 화면 아래 고정 위치
      nodes, _ = wait_for(lambda ns: find(ns, rid='tvPhotoCount') or find(ns, text='거래 희망 장소'), what='폼 복귀')
    # 가격: 키보드가 닫히며 배치가 밀리므로 매번 다시 덤프해 확인, 최대 3회
    for attempt in range(0 if old_ui else 4):
      nodes = dump(); pf = price_field(nodes)
      for _ in range(4):   # 가격 칸이 화면 안에 올 때까지 스크롤
        if pf is not None and sy(300) <= pf['cy'] <= sy(1900): break
        if pf is not None and pf['cy'] < sy(300) and pf['b'][3] > 0:
          sh('input', 'swipe', str(sx(540)), str(sy(600)), str(sx(540)), str(sy(1500)), '400')      # 위쪽에 있으면 내려서 보이게
        else:
          sh('input', 'swipe', str(sx(540)), str(sy(1800)), str(sx(540)), str(sy(900)), '400')      # 아래쪽/안 보이면 올려서 보이게
        time.sleep(1.0); nodes = dump(); pf = price_field(nodes)
      assert pf is not None, '가격 칸 못 찾음'
      if pf['t'].replace('￦', '').replace(',', '').strip() == str(it['price']): break
      tap(pf['cx'], pf['cy'], 0.8)
      sh('input', 'keycombination', '113', '29'); sh('input', 'keyevent', '67'); time.sleep(0.3)   # 기존 값 비우기
      for ch in str(it['price']):                           # 한 번에 치면 자릿수가 빠짐(XCover '670') → 한 글자씩
        sh('input', 'text', ch); time.sleep(0.15)
      time.sleep(1.0); sh('input', 'keyevent', '4'); time.sleep(1.5)
  finally:
    k.close()
  nodes = dump()
  if it.get('direct_buy') is False and os.environ.get('DAANGN_DIRECT_BUY') != '1':   # 서병기(S23) 는 DAANGN_DIRECT_BUY=1 로 항상 바로구매를 켠 채 올린다(사용자 2026-10-22)
    # 위탁상품은 바로구매(전국으로 판매하기) 끄고 올린다 (사용자 2026-10-20)
    for _ in range(4):
      lab = find(nodes, text='전국으로 판매하기')
      if lab: break
      sh('input', 'swipe', str(sx(540)), str(sy(1800)), str(sx(540)), str(sy(900)), '400'); time.sleep(1); nodes = dump()
    if lab:
      sw = [n for n in nodes if n['click'] and abs(n['cy'] - lab['cy']) < sy(60) and n['cx'] > sx(700)] or [n for n in nodes if abs(n['cy'] - lab['cy']) < sy(60) and n['cx'] > sx(700) and n['cls'] in ('View', 'Switch', 'ToggleButton')]   # G950N 은 토글 View 의 click 속성이 false 라 둘째 후보로 찾는다
      print('바로구매 토글 후보', [(n['cls'], n['chk']) for n in sw])
      if sw and sw[0]['chk']:
        tap(sw[0]['cx'], sw[0]['cy'], 1.2); nodes = dump()
        sw2 = [n for n in nodes if n['click'] and abs(n['cy'] - lab['cy']) < sy(60) and n['cx'] > sx(700)]
        assert sw2 and not sw2[0]['chk'], '바로구매 끄기 실패'
        print('바로구매 끔')
  if old_ui:
    assert find(nodes, text=f"{it['price']:,}"), '가격 표시 확인 실패(옛 UI)'
  else:
    pf = price_field(nodes); assert pf['t'].replace('￦', '').replace(',', '').strip() == str(it['price']), '가격 불일치: ' + pf['t']
  # 이웃 동네에도 올리기 토글: 사용자가 앱 설정으로 정해 둔 값을 그대로 둔다(10/23 사용자가 직접 설정).
  # 코드로 강제하면 같은 글이 이웃 동네에 따로 하나 더 생겨 유사글로 보인다. DAANGN_TWO_DONG=1/0 으로만 강제한다
  force = os.environ.get('DAANGN_TWO_DONG')
  if force in ('0', '1'):
    for _ in range(4):
      lb = next((n for n in nodes if n['t'].endswith('에도 올리기')), None)
      if lb: break
      sh('input', 'swipe', str(sx(540)), str(sy(1800)), str(sx(540)), str(sy(900)), '400'); time.sleep(1); nodes = dump()
    if lb:
      sw = [n for n in nodes if n['click'] and abs(n['cy'] - lb['cy']) < sy(60) and n['cx'] > sx(700)]
      if sw and bool(sw[0]['chk']) != (force == '1'):
        tap(sw[0]['cx'], sw[0]['cy'], 1.0); nodes = dump()
  if it.get('draft'):
    # 임시저장: 닫기 → 저장 묻는 창에서 '저장'(저장 안 함 제외)
    ts = find(nodes, text='임시저장', exact=True) or find(nodes, desc='임시저장')
    if ts:                                        # 폼 우상단 '임시저장' 버튼(XCover 10/21)
      tap(ts['cx'], ts['cy'], 3)
    else:
      c = find(nodes, desc='닫기') or find(nodes, text='닫기', exact=True)
      if c: tap(c['cx'], c['cy'], 2)
      else: sh('input', 'keyevent', '4'); time.sleep(2)
      nodes = dump(); btns = [n for n in nodes if n['cls'] == 'Button' and n['t']]
      print('저장 대화상자 버튼:', [b['t'] for b in btns])
      save = next((b for b in btns if '저장' in b['t'] and '안 함' not in b['t'] and '않' not in b['t']), None)
      assert save, '임시 저장 버튼 없음'
      tap(save['cx'], save['cy'], 3)
    nodes = dump()
    if find(nodes, text='게시글을 임시저장했어요.') or find(nodes, rid='tvPhotoCount') or find(nodes, text='임시저장', exact=True):
      sh('input', 'keyevent', '4'); time.sleep(1.5); nodes = dump()
      sv = find(nodes, text='저장하기', exact=True)         # '작성 중인 판매 글을 저장할까요?' → 저장하기
      if sv: tap(sv['cx'], sv['cy'], 2.5)
    print('저장 후 화면:', focused())
    print(f'임시저장 완료 {it["pid"]} {it["title"]} {it["price"]} 사진{n_img}')
    return
  done = find(nodes, desc='작성 완료'); tap(done['cx'], done['cy'], 4)
  # 이미지 업로드 실패 알림이면 취소 → 잠시 뒤 작성 완료 재시도 (최대 3회)
  for _ in range(3):
    nodes = dump(); msg = find(nodes, rid='message')
    if not msg or '업로드에 실패' not in msg['t']: break
    print('이미지 업로드 실패 알림, 재시도')
    neg = find(nodes, rid='negativeButton'); tap(neg['cx'], neg['cy'], 3)
    nodes = dump(); done = find(nodes, desc='작성 완료'); tap(done['cx'], done['cy'], 5)
  # 4) 상세 화면 확인 후 뒤로
  nodes, _ = wait_for(lambda ns: find(ns, desc='공유하기') and find(ns, text=it['title'][:10]), 15, what='등록된 글 상세')
  cat = find(nodes, text=want, exact=True)
  print(f'등록 완료 {it["pid"]} {it["title"]} {it["price"]} 사진{n_img} 카테고리={cat["t"] if cat else "?"}')
  sh('input', 'keyevent', '4'); time.sleep(1.5)
  wait_for(lambda ns: on_sales() and find(ns, text='글쓰기', exact=True), what='판매관리 복귀')
  time.sleep(4)   # 등록 직후 배너·토스트가 사라질 때까지

if __name__ == '__main__':
  items = json.load(open('bunjang/items.json', encoding='utf-8'))
  done_log = 'posted.txt'
  posted = set(open(done_log, encoding='utf-8').read().split()) if os.path.exists(done_log) else set()
  listed = set(open('targets.txt', encoding='utf-8').read().split()) if os.path.exists('targets.txt') else None   # 번개장터에 지금 떠 있는 판매중 상품만
  if listed: items = [i for i in items if i['pid'] in listed]
  targets = sys.argv[1:] or sorted([i['pid'] for i in items if i['saleStatus'] == 'SELLING' and i['pid'] not in posted], key=lambda p: p not in MAIN)
  for pid in targets:
    it = next(i for i in items if i['pid'] == pid)
    if pid in posted:
      print('이미 등록', pid); continue
    fresh = compose(pid)            # 가격·사이즈는 등록 직전 다시 조회
    if fresh['saleStatus'] != 'SELLING':
      print('판매중 아님, 건너뜀', pid, fresh['saleStatus']); continue
    it.update(fresh)
    for attempt in range(2):
      try:
        post(it); break
      except Exception as e:
        print(f'실패({attempt + 1}/2) {pid}: {e}')
        if attempt == 1: raise
        assert go_sales(), '판매관리 복귀 실패'
        nodes = dump()   # 이미 올라갔으면(맨 위 카드가 이 상품·방금) 재시도 않음
        if find(nodes, text=it['title'][:20]) and find(nodes, text='초 전'):
          print('이미 등록됨', pid); break
    open(done_log, 'a', encoding='utf-8').write(pid + '\n')
