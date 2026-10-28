# 판매자 판매물품 목록을 앱에서 3화면 캡처해 이어 붙인다 — 상품마다 '바로구매' 표시가 있는지 보려고(위탁형은 바로구매 불가)
# 사용: python -X utf8 phone_lists.py 닉네임...   (phone_profiles.py 와 같은 기기·분석 파일)
import os, sys, time
from PIL import Image
import phone_profiles as pp


def main():
  import json
  rows = {r['nick']: r for r in json.load(open(os.path.join(pp.OUT, '..', 'analysis2.json'), encoding='utf-8'))}
  for nick in sys.argv[1:]:
    r = rows.get(nick)
    if not r:
      print('없음', nick)
      continue
    pp.adb('shell', 'input', 'keyevent', '3')
    pp.adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', r['href'], 'com.towneers.www')
    time.sleep(7)
    a = pp.shot(os.path.join(pp.OUT, f'{nick}_l0.png'))
    top = pp.last_card_top(a)
    if not top:
      print('판매물품 카드 못 찾음', nick)
      continue
    pp.adb('shell', 'input', 'tap', '900', str(top + 85))
    time.sleep(5)
    shots = [pp.shot(os.path.join(pp.OUT, f'{nick}_l1.png'))]
    for i in (2, 3):
      pp.adb('shell', 'input', 'swipe', '540', '1700', '540', '500', '400')
      time.sleep(2.5)
      shots.append(pp.shot(os.path.join(pp.OUT, f'{nick}_l{i}.png')))
    W, H = 486, 1000
    m = Image.new('RGB', (W * 3 + 20, H), 'white')
    for i, s in enumerate(shots):
      m.paste(s.crop((0, 150, 1080, 2100)).resize((W, H)), (i * (W + 10), 0))
    m.save(os.path.join(pp.OUT, f'{nick}_list.png'))
    print('저장', nick, flush=True)
    for _ in range(3):
      pp.adb('shell', 'input', 'keyevent', '4')
      time.sleep(0.8)


if __name__ == '__main__':
  main()
