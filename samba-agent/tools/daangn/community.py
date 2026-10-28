# 당근 동네생활 글쓰기(장소 첨부) / 댓글 — 활동배지(동네 주민·탐험가·한바퀴·답변가)용
import io, json, os, sys, time
from post import dump, find, tap, sh, focused, sx, sy, ADB, DEV, H
import subprocess
from kbd import Kbd

def dismiss_overlay(nodes):
  """후후 스팸 안내 등 다른 앱 오버레이가 덮으면 닫기(X) 또는 뒤로"""
  dec = next((n for n in nodes if n['t'] in ('안 받을래요', '다음에 할게요', '괜찮아요', '나중에')), None)   # 알림 받기 등 안내 팝업은 거절
  if dec: tap(dec['cx'], dec['cy'], 1.5); return True
  if any('후후' in n['t'] for n in nodes):
    x = [n for n in nodes if n['click'] and n['cy'] < sy(200) and n['cx'] > sx(850)]
    if x: tap(x[0]['cx'], x[0]['cy'], 1.5)
    else: sh('input', 'keyevent', '4'); time.sleep(1.5)
    return True
  return False

def to_community():
  """당근 메인 → 커뮤니티 탭(동네생활 목록)"""
  sh('input', 'keyevent', '224'); time.sleep(0.8)   # 글 사이 10분 동안 화면이 꺼지면 덤프가 비므로 먼저 깨운다
  for _ in range(10):
    f = focused()
    nodes = dump()
    if dismiss_overlay(nodes): continue
    tab = [n for n in nodes if (n['t'] == '커뮤니티' or n['d'] == '커뮤니티') and n['cy'] > sy(2000)]   # 옛 UI 는 desc 만 있음
    if 'MainActivity' in f and tab:
      tap(tab[0]['cx'], tab[0]['cy'], 2.5); return True
    if 'towneers' not in f:
      sh('monkey', '-p', 'com.towneers.www', '-c', 'android.intent.category.LAUNCHER', '1'); time.sleep(4)
      continue
    b = find(nodes, text='저장하지 않고 나가기', exact=True)
    if b: tap(b['cx'], b['cy'], 1.5); continue
    c = find(nodes, desc='닫기') or find(nodes, text='닫기', exact=True)
    if c and find(nodes, rid='title'): tap(c['cx'], c['cy'], 1.5); continue
    sh('input', 'keyevent', '4'); time.sleep(1.5)
  return False

def paste(text):
  k = Kbd(); k.paste(text); time.sleep(0.4); k.close()

def push_photo(path):
  """사진을 EXIF 촬영시각=지금 으로 바꿔 폰 DCIM/Place 에 넣고 스캔 → 선택창 '모든 사진' 첫 칸에 옴"""
  from PIL import Image
  im = Image.open(path); ex = im.getexif(); now = time.strftime('%Y:%m:%d %H:%M:%S')
  ex[306] = now; ex.get_ifd(0x8769)[36867] = now; ex.get_ifd(0x8769)[36868] = now
  tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tmp_place.jpg')
  im.save(tmp, 'JPEG', quality=92, exif=ex.tobytes())
  sh('mkdir', '-p', '/sdcard/DCIM/Place')
  for f in sh('ls', '/sdcard/DCIM/Place').stdout.decode().split():
    sh('rm', '-f', f'/sdcard/DCIM/Place/{f}'); sh('content', 'call', '--uri', 'content://media/external/file', '--method', 'scan_file', '--arg', f'/sdcard/DCIM/Place/{f}')
  dst = f'/sdcard/DCIM/Place/place_{int(time.time())}.jpg'
  subprocess.run([ADB, '-s', DEV, 'push', tmp, dst], creationflags=0x08000000, capture_output=True)
  sh('content', 'call', '--uri', 'content://media/external/file', '--method', 'scan_file', '--arg', dst)
  sh('am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file://' + dst)   # 구형(G950N)은 scan_file 미지원 → 브로드캐스트
  for _ in range(10):                                        # 미디어 색인이 끝나 '가장 최근 사진' 이 우리 것일 때까지
    out = sh('content', 'query', '--uri', 'content://media/external/images/media', '--projection', '_data', '--sort', '"datetaken DESC, date_added DESC"').stdout.decode('utf-8', 'replace')
    first = next((l for l in out.splitlines() if '_data=' in l), '')
    if dst.split('/')[-1] in first: break
    time.sleep(1.0)
  else:
    raise AssertionError('사진 색인 안 됨 — 최근 사진이 우리 것이 아님: ' + first[:80])   # 엉뚱한 사진이 붙지 않게 중단
  time.sleep(1.0)

def attach_photo():
  """글쓰기 폼에서 사진 첨부 → 모든 사진 격자 첫 칸(가장 최근) → 1장 올리기 → 폼에 '첨부한 이미지' 확인"""
  from post import W, H
  for attempt in range(3):
    nodes = dump()
    if (find(nodes, desc='첨부한 이미지') or find(nodes, text='첨부한 이미지', exact=True)): return True
    pb = find(nodes, desc='사진 첨부') or find(nodes, text='사진 첨부', exact=True)
    if not pb: sh('input', 'keyevent', '4'); time.sleep(1.2); continue   # 키보드가 가리면 내림
    tap(pb['cx'], pb['cy'], 3)
    for _ in range(6):
      if 'MediaPicker' in focused(): break
      time.sleep(1)
    assert 'MediaPicker' in focused(), '사진 선택창 안 뜸: ' + focused()
    time.sleep(1.5); tap(W // 2, round(H * 0.17), 1.5)                   # 1행 2열(카메라 칸 오른쪽) = 가장 최근 사진
    nodes = dump(); up = find(nodes, desc='1장 올리기') or find(nodes, text='1장 올리기')
    if not up:
      print('선택 안 됨, 다시'); sh('input', 'keyevent', '4'); time.sleep(1.5); continue
    tap(up['cx'], up['cy'], 3)
    nodes = dump()
    if (find(nodes, desc='첨부한 이미지') or find(nodes, text='첨부한 이미지', exact=True)): return True
  raise AssertionError('사진 첨부 실패')

def select_button_y():
  """지도 화면의 주황색 '선택' 버튼 세로 위치 — 폰마다 비율이 달라 스크린샷에서 찾음, 못 찾으면 예전 고정값"""
  from PIL import Image
  import io as _io
  try:
    png = subprocess.run([ADB, '-s', DEV, 'exec-out', 'screencap', '-p'], capture_output=True, creationflags=0x08000000).stdout
    im = Image.open(_io.BytesIO(png)).convert('RGB'); w, h = im.size; x = w // 2
    ys = [y for y in range(int(h * 0.55), int(h * 0.97)) if (lambda p: p[0] > 220 and 80 < p[1] < 150 and p[2] < 70)(im.getpixel((x, y)))]
    if len(ys) > 20: return round((ys[0] + ys[-1]) / 2 * H / h)
  except Exception as e:
    print('선택 버튼 탐색 실패:', e)
  return sy(2106)

def write_post(title, body, place=None, tag='생활/편의', photo=None, match=None):
  assert to_community(), '커뮤니티 진입 실패'
  nodes = dump(); dn = [n for n in nodes if n['t'] == '동네생활' and n['cy'] < sy(400)]
  if dn: tap(dn[0]['cx'], dn[0]['cy'], 2)
  else: tap(sx(140), sy(275), 2)   # 상단 '동네생활' 서브탭(웹뷰)
  def open_form():
    for attempt in range(3):
      nodes = dump()
      if find(nodes, desc='발행 위치 선택') or find(nodes, rid='title'):   # 이미 폼이 열려 있음(이전 시도에서 늦게 뜬 경우)
        print('폼 이미 열림'); return nodes
      fab = [n for n in nodes if n['t'] == '글쓰기' and n['cy'] > sy(1500)]
      if fab: tap(fab[0]['cx'], fab[0]['cy'], 2.5)
      else: tap(sx(900), sy(1935), 2.5)                      # 웹뷰 FAB '+ 글쓰기'
      for _ in range(4):
        if 'BottomSheet' in focused(): break
        time.sleep(1)
      if 'BottomSheet' not in focused():
        nodes = dump()
        if find(nodes, desc='발행 위치 선택') or find(nodes, rid='title'): print('폼 바로 열림'); return nodes   # 시트 없이 바로 폼으로 가는 판
        print('시트 안 뜸', attempt); continue
      time.sleep(6.0)                                        # 구형 폰은 Lynx 시트가 늦게 활성화됨
      from PIL import Image
      import io as _io
      png = subprocess.run([ADB, '-s', DEV, 'exec-out', 'screencap', '-p'], capture_output=True, creationflags=0x08000000).stdout
      im = Image.open(_io.BytesIO(png)).convert('L'); w, h = im.size
      x = w // 2; top = None
      for y in range(int(h * 0.3), int(h * 0.9)):
        if im.getpixel((x, y)) > 245 and all(im.getpixel((x, y + k)) > 245 for k in range(5, 60, 5)):
          top = y; break
      if not top: print('시트 윗변 못 찾음'); continue
      ty = round((top + h * 0.16) * H / h); print('시트 top', top, '탭', ty)
      tap(sx(540), ty, 3)         # 시트 첫 항목 '글쓰기'
      if 'BottomSheet' in focused(): tap(sx(540), ty, 3)   # 한 번 더
      backed = False
      for _ in range(10):
        nodes = dump()
        if dismiss_overlay(nodes): continue
        if find(nodes, desc='발행 위치 선택'): return nodes
        if find(nodes, rid='title'):
          if not backed: sh('input', 'keyevent', '4'); backed = True; time.sleep(1.5); continue   # 키보드만 한 번 내림
          return nodes                                          # 제목칸 보이면 폼으로 인정(발행 버튼은 뒤에서 재시도)
        time.sleep(1.5)
      time.sleep(4); nodes = dump()
      if find(nodes, desc='발행 위치 선택') or find(nodes, rid='title'): print('폼 늦게 뜸'); return nodes
      print('폼 안 뜸, 화면:', focused())
      assert to_community(), '커뮤니티 복귀 실패'
      nodes = dump(); dn = [n for n in nodes if n['t'] == '동네생활' and n['cy'] < sy(400)]
      if dn: tap(dn[0]['cx'], dn[0]['cy'], 2)
    return None
  nodes = open_form()
  assert nodes, '글쓰기 폼 아님'
  sel = None
  for _ in range(6):
    nodes = dump(); sel = find(nodes, desc='발행 위치 선택')
    if sel: break
    if not find(nodes, rid='title'): break
    sh('input', 'keyevent', '4') if not find(nodes, text='완료', exact=True) else None   # 키보드 떠 있으면 내림
    time.sleep(1.5)
  if sel is None:
    sel = {'cx': sx(540), 'cy': sy(318)}                        # 폼 상단 '커뮤니티를 선택해주세요' 고정 위치
  # 커뮤니티 선택
  def wait_node(pred, tries=6, what=''):
    for _ in range(tries):
      nodes = dump(); hit = pred(nodes)
      if hit: return hit
      time.sleep(1.2)
    raise AssertionError('안 보임: ' + what)
  for attempt in range(3):
    tap(sel['cx'], sel['cy'], 1.5)
    try:
      dl = wait_node(lambda ns: next((n for n in ns if n['t'].startswith('동네생활') and n['cls'] == 'Button'), None), 4, '동네생활 항목')
      nodes = dump()
      chips_open = [n for n in nodes if n['t'] in ('맛집', '동네행사', '반려동물', '운동') and n['cls'] in ('RadioButton', 'TextView') and dl['cy'] < n['cy'] < dl['cy'] + sy(400)]
      apt = min([n for n in nodes if n['cls'] == 'Button' and n['click'] and n['cy'] > dl['cy'] + sy(60) and n['t'] and not n['t'].startswith('동네생활')], key=lambda n: n['cy'], default=None)   # 동네생활 바로 다음 항목(아파트 모임·공개 게시판 등)
      # 웹뷰는 접힌 칩도 노드로 내보내므로, 칩 줄과 다음 항목(아파트) 사이 간격으로 실제 펼침 여부를 본다
      expanded = bool(chips_open) and (apt is None or apt['cy'] - chips_open[0]['cy'] > sy(100))
      if not expanded: tap(dl['cx'], dl['cy'], 1.5)             # 이미 펼쳐져 있으면 또 누르면 접히므로(S23) 접힌 때만 누름
      def vis_tag(ns):
        t = [n for n in ns if n['t'] == tag and n['cls'] in ('RadioButton', 'TextView') and 0 < n['cx'] < W - sx(40)]   # 구형 폰은 칩이 TextView
        return t[0] if t else None
      from post import W
      tg = None
      for _ in range(4):
        nodes = dump(); tg = vis_tag(nodes)
        if tg: break
        row = [n for n in nodes if n['cls'] in ('RadioButton', 'TextView') and n['t'] in ('맛집', '동네행사', '반려동물', '운동')]
        if row:                                           # 칩 줄을 왼쪽으로 밀어 숨은 태그 노출
          y = row[0]['cy']; sh('input', 'swipe', str(sx(900)), str(y), str(sx(200)), str(y), '300'); time.sleep(1)
        else:
          time.sleep(1)
      assert tg, f'태그 {tag} 없음'
      tap(tg['cx'], tg['cy'], 1.5)
    except AssertionError as e:
      print('선택 재시도:', e); continue
    ok = wait_node(lambda ns: find(ns, desc='현재 동네생활') or find(ns, text='동네생활 · ' + tag), 4, '선택 확인') if False else None
    nodes = dump(); cur = find(nodes, desc='발행 위치 선택') or find(nodes, text='발행 위치 선택')
    chk = [n for n in nodes if n['t'] == tag and (n['chk'] or n['sel'])]
    if (cur and '현재' in (cur['d'] + cur['t'])) or chk or find(nodes, text='동네생활 · ' + tag): break
    print('선택 안 됨, 재시도', attempt)
  else:
    raise AssertionError('커뮤니티·태그 선택 실패')
  # 사진
  if photo:
    push_photo(photo); assert attach_photo(); print('사진 첨부 OK')
  # 제목·본문
  def clear(): sh('input', 'keycombination', '113', '29'); sh('input', 'keyevent', '67'); time.sleep(0.3)   # 남은 글자 비우기
  def fill(rid, text):
    for _ in range(4):                                       # 칸에 포커스가 실제로 갈 때까지(구형 폰은 느림)
      ed = lambda ns: next((n for n in ns if n['id'] == rid and n['cls'] == 'EditText'), None)   # android:id/content(FrameLayout) 와 구분
      nodes = dump(); f = ed(nodes)
      if not f: sh('input', 'keyevent', '4'); time.sleep(1.2); nodes = dump(); f = ed(nodes)   # 키보드가 가리면 내리고 다시
      if not f: time.sleep(1.5); continue
      tap(f['cx'], f['cy'], 1.0)
      nodes = dump(); f = ed(nodes)
      if f and f['foc']: break
    assert f and f['foc'], rid + ' 포커스 실패'
    if f['t']: clear()                                     # 빈 칸에 백스페이스 치면 포커스가 제목으로 튐(XCover)
    paste(text); time.sleep(0.8)
    nodes = dump(); f = ed(nodes); print('입력', rid, (f['t'] or '')[:25])
    sh('input', 'keyevent', '4'); time.sleep(1.2)
  fill('title', title); fill('content', body)
  nodes = dump()
  assert find(nodes, rid='title')['t'] == title, '제목 확인 실패'
  # 장소 첨부 — 검색 결과 행은 웹뷰라 덤프에 없으니, 행을 위에서부터 눌러 '선택된 장소' 라벨이 정확히 맞는 행을 찾는다
  if place:
    def norm(s): return s.replace(' ', '').replace('경주', '').replace('경주시', '')
    want = {norm(place)} | ({norm(match)} if match else set())
    def label_ok(label):
      l = norm(label.replace('선택된 장소', '').replace('삭제', ''))
      return any(l == w or (l.endswith(w) and len(l) - len(w) <= 2 and not l.endswith(('점', '빵', '집', '관'))) for w in want) or (match and l == norm(match))
    cands = []
    for q in (place, place.replace('경주 ', '').replace('경주', ''), match or ''):
      q = q.strip()
      if q and q not in cands: cands.append(q)
    found = None
    for q in cands:
      for row in range(8):
        nodes = dump()
        pb = find(nodes, desc='장소 첨부') or find(nodes, text='장소 첨부', exact=True)
        if pb is None: sh('input', 'keyevent', '4'); time.sleep(1.2); nodes = dump(); pb = find(nodes, desc='장소 첨부')
        tap(pb['cx'], pb['cy'], 2.5)
        nodes = dump(); e = next(n for n in nodes if n['cls'] == 'EditText')
        x = find(nodes, desc='텍스트 지우기') or find(nodes, text='텍스트 지우기', exact=True)   # 구형 폰은 text
        if e['t'] and x: tap(x['cx'], x['cy'], 0.8)                     # 검색어 지우기 버튼(키 조합은 구형 폰에서 안 먹음)
        tap(e['cx'], e['cy'], 0.7)
        if e['t'] and not x: sh('input', 'keycombination', '113', '29'); sh('input', 'keyevent', '67'); time.sleep(0.3)
        paste(q); time.sleep(2.5); sh('input', 'keyevent', '4'); time.sleep(1.2)
        nodes = dump()
        if find(nodes, desc='장소 등록하기') or find(nodes, text='장소 등록하기', exact=True) or find(nodes, text='검색결과가 없어요'):
          print('장소 검색 없음:', q); sh('input', 'keyevent', '4'); time.sleep(1.2); break
        tap(sx(540), round(H * (0.205 + 0.083 * row)), 2.5)   # row 번째 결과 행(첫 행 0.205H, 간격 0.083H — 폰 공통)
        nodes = dump()
        if find(nodes, text='지도보기'):               # 행이 없는 자리 → 이 검색어는 끝
          print('행 없음:', q, row); sh('input', 'keyevent', '4'); time.sleep(1.2); break
        sel = next((n for n in nodes if n['t'].endswith(' 선택') and n['cy'] > sy(1500)), None)   # 지도 화면 아래 '○○ 선택' 버튼이 노드로 잡히면 그 노드를(G950N 은 픽셀 탐색이 빗나가 지도에 머물렀다, 10/27)
        if sel: tap(sel['cx'], sel['cy'], 2.5)
        else: tap(sx(540), select_button_y(), 2.5)          # 지도 화면 아래 주황 '선택' 버튼(웹뷰라 화면 픽셀로 찾음)
        nodes = dump()
        if not find(nodes, rid='title'):   # 실패 순간 화면을 남긴다(10/27 임귀태 폼 복귀 실패 원인 추적)
          try: open(os.path.join(os.environ.get('DAANGN_FAIL_DIR', '.'), 'fail_form_return.png'), 'wb').write(subprocess.run([ADB, '-s', DEV, 'exec-out', 'screencap', '-p'], capture_output=True, creationflags=0x08000000).stdout)
          except Exception: pass
          print('폼 복귀 실패 화면:', focused(), [n['t'] for n in nodes if n['t']][:12])
        assert find(nodes, rid='title'), '폼 복귀 실패'
        chosen = find(nodes, desc='선택된 장소') or find(nodes, text='선택된 장소')
        label = (chosen['d'] or chosen['t']) if chosen else ''
        if chosen and label_ok(label): found = label; break
        print('장소 라벨 불일치:', label, '→ 다음 행')
        if chosen:                                    # 잘못 고른 장소 제거(라벨 오른쪽 '삭제')
          rm = next((n for n in nodes if n['click'] and n['cy'] == chosen['cy'] and n['cx'] > chosen['cx']), None)
          if rm: tap(rm['cx'], rm['cy'], 1.5)
          elif '삭제' in label: tap(chosen['b'][2] - sx(30), chosen['cy'], 1.5)
      if found: break
    assert found, '장소 못 찾음: ' + place
    print('장소 첨부:', found)
  done = find(nodes, text='완료', exact=True); tap(done['cx'], done['cy'], 4)
  nodes = dump()
  ok = find(nodes, text=title) is not None and find(nodes, rid='title') is None
  print('게시', 'OK' if ok else '확인 필요', '|', title)
  return ok

if __name__ == '__main__':
  posts = json.load(open(sys.argv[1], encoding='utf-8'))
  done_f = sys.argv[2] if len(sys.argv) > 2 else 'community_done.txt'
  done = set(open(done_f, encoding='utf-8').read().split('\n')) if os.path.exists(done_f) else set()
  limit = int(sys.argv[3]) if len(sys.argv) > 3 else 3
  limit = min(limit, int(os.environ.get('DAANGN_POST_MAX', '3')))   # 계정당 하루 상한(기본 3)
  n = 0
  from mypost import my_post_titles
  existing = my_post_titles()                       # 게시 전 '내 커뮤니티 글' 목록 대조 — done 파일만 믿지 않는다
  print('내 글', len(existing), '개:', [t[:12] for t in existing][:12])
  for p in posts:
    if p['title'] in existing and p['title'] not in done:
      open(done_f, 'a', encoding='utf-8').write(p['title'] + '\n'); done.add(p['title']); print('이미 올라감, 건너뜀:', p['title'])
    if p['title'] in done or n >= limit: continue
    if n > 0: time.sleep(int(os.environ.get('DAANGN_POST_GAP', '600')))   # 글 사이 간격(기본 10분)
    existing = my_post_titles()                     # 매 글 직전에도 다시 확인
    if p['title'] in existing:
      open(done_f, 'a', encoding='utf-8').write(p['title'] + '\n'); print('이미 올라감, 건너뜀:', p['title']); continue
    if write_post(p['title'], p['body'], p.get('place'), p.get('tag', '생활/편의'), p.get('photo'), p.get('match')):
      open(done_f, 'a', encoding='utf-8').write(p['title'] + '\n'); n += 1
      time.sleep(20)
    else:
      break
  print('오늘 게시', n)
