# 당근 앱(G950N)에서 판매자 프로필을 열어 매너온도·판매물품 탭(전체/판매중/거래완료)을 화면 캡처로 모은다.
# 앱은 웹뷰라 화면 글자를 못 읽으므로 캡처를 이어 붙인 그림을 사람이(또는 Claude 가) 읽는다.
# 사용: python -X utf8 phone_profiles.py 닉네임1 닉네임2 ...   (분석 결과 seller_research/analysis2.json 에서 주소를 찾는다)
import json, os, subprocess, sys, time
from PIL import Image

ADB = r'C:\Users\canno\Downloads\pt\platform-tools\adb.exe'
DEV = os.environ.get('DAANGN_DEV', '192.168.45.28:5555')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'seller_research', 'shots')
os.makedirs(OUT, exist_ok=True)
NO_WIN = 0x08000000


def adb(*a):
  return subprocess.run([ADB, '-s', DEV, *a], capture_output=True, creationflags=NO_WIN)


def shot(path):
  with open(path, 'wb') as f:
    f.write(adb('exec-out', 'screencap', '-p').stdout)
  return Image.open(path).convert('RGB')


def last_card_top(im):
  """배경(회색)에서 흰 카드로 바뀌는 지점 중 마지막 — 판매물품 카드의 윗변"""
  x = 70
  prev = None
  top = None
  for y in range(300, im.height - 200):
    r, g, b = im.getpixel((x, y))
    white = r > 252 and g > 252 and b > 252
    if prev is not None and white and not prev:
      top = y
    prev = white
  return top


def main():
  rows = {r['nick']: r for r in json.load(open(os.path.join(OUT, '..', 'analysis2.json'), encoding='utf-8'))}
  for nick in sys.argv[1:]:
    r = rows.get(nick)
    if not r:
      print('없음', nick)
      continue
    adb('shell', 'input', 'keyevent', '3')
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', r['href'], 'com.towneers.www')
    time.sleep(7)
    a = shot(os.path.join(OUT, f'{nick}_a.png'))
    top = last_card_top(a)
    b = None
    if top:
      adb('shell', 'input', 'tap', '900', str(top + 85))
      time.sleep(5)
      b = shot(os.path.join(OUT, f'{nick}_b.png'))
    # 이어 붙이기: 프로필(축소) + 판매물품 화면 위쪽(탭 숫자)
    A = a.crop((0, 250, 1080, 1950)).resize((486, 765))
    B = b.crop((0, 100, 1080, 1100)).resize((486, 450)) if b else Image.new('RGB', (486, 450), 'white')
    m = Image.new('RGB', (486 * 2 + 10, 765), 'white')
    m.paste(A, (0, 0))
    m.paste(B, (496, 0))
    m.save(os.path.join(OUT, f'{nick}.png'))
    print('저장', nick, 'tap_y', (top + 85) if top else None, flush=True)
    for _ in range(3):
      adb('shell', 'input', 'keyevent', '4')
      time.sleep(0.8)


if __name__ == '__main__':
  main()
