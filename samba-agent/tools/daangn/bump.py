# 당근 판매관리에서 이틀 전(10/14) 등록한 글 끌어올리기 — 가격은 그대로
import io, json, re, subprocess, sys, time
from post import dump, find, tap, sh, focused, on_sales, go_sales

OLD = re.compile(r'\d+일 전')
TARGET_TITLES = [l.strip() for l in open('bump_targets.txt', encoding='utf-8') if l.strip()]   # 10/14 등록분 제목 앞부분
def is_target(title): return any(title.startswith(t) for t in TARGET_TITLES)

def cards(nodes):
  """카드마다 (제목, 시각문구, 끌어올리기 버튼 노드) 묶음"""
  out = []
  titles = [n for n in nodes if n['cls'] == 'TextView' and n['t'] and n['cx'] > 300 and 500 < n['cy'] < 2050 and '원' not in n['t'][-1:]]
  for t in titles:
    when = next((n for n in nodes if n['cls'] == 'TextView' and '전' in n['t'] and '용강동' in n['t'] and 0 < n['cy'] - t['cy'] < 120), None)
    if not when: continue
    btn = next((n for n in nodes if n['d'] == '끌어올리기' and 0 < n['cy'] - t['cy'] < 420), None)
    out.append((t, when, btn))
  return out

def main():
  assert go_sales(), '판매관리 아님'
  for _ in range(30): sh('input', 'swipe', '540', '600', '540', '1900', '150')   # 맨 위로
  time.sleep(1.5)
  done, skipped, seen_titles, stall = [], [], set(), 0
  log = open('bump.log', 'a', encoding='utf-8')
  for _ in range(40):   # 스크롤 반복
    nodes = dump()
    progressed = False
    for t, when, btn in cards(nodes):
      key = t['t']
      if key in seen_titles: continue
      if not OLD.search(when['t']) or not is_target(key): continue
      if btn is None:
        seen_titles.add(key); skipped.append((key, '버튼 없음(예약중 등)')); continue
      if btn['cy'] > 2050: continue   # 화면 아래 잘림 → 스크롤 뒤에
      seen_titles.add(key); progressed = True
      tap(btn['cx'], btn['cy'], 2.5)
      n2 = dump(); txt = ' | '.join(n['t'] for n in n2 if n['t'])[:300]
      if '뒤에' in txt and '끌어올릴 수 있어요' in txt:
        skipped.append((key, re.search(r'(\S+(?: \S+)*?) 뒤에', txt).group(0))); sh('input', 'keyevent', '4'); time.sleep(1.5)
      elif '모두 사용했어요' in txt:
        print('하루 끌어올리기 한도 소진, 중단'); sh('input', 'keyevent', '4'); time.sleep(1.5); return done, skipped
      else:
        print('화면:', focused(), txt, file=log, flush=True)
        btns = [n for n in n2 if n['cls'] == 'Button' and n['t']]
        pick = next((b for b in btns if '끌어올리기' in b['t'] and '가격' not in b['t']), None)
        if pick is None:
          print('모르는 화면이라 중단:', key, [b['t'] for b in btns]); sh('input', 'keyevent', '4'); return done, skipped
        tap(pick['cx'], pick['cy'], 3)
        if not on_sales(): sh('input', 'keyevent', '4'); time.sleep(1.5)
        done.append(key); print('끌어올림', key, flush=True)
      assert go_sales()
    if not progressed:
      before = [c[0]['t'] for c in cards(nodes)]
      sh('input', 'swipe', '540', '1900', '540', '700', '400'); time.sleep(1.5)
      after = [c[0]['t'] for c in cards(dump())]
      if after and after == before:
        stall += 1
        if stall >= 3: break   # 세 번 연속 변화 없으면 끝
      else:
        stall = 0
  return done, skipped

if __name__ == '__main__':
  if '--dry' in sys.argv:
    for t, when, btn in cards(dump()): print(t['t'][:30], '|', when['t'], '|', '버튼' if btn else '-')
    sys.exit()
  d, s = main()
  print(f'끌어올림 {len(d)}건, 건너뜀 {len(s)}건')
  for k, why in s: print(' 건너뜀:', k[:30], why)
