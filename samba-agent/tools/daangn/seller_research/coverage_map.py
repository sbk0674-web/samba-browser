# 추천 12개 동네의 반경 10km 커버 지도(전국·수도권 두 장). OSM 타일 + 원 + 번호.
import math, os
from PIL import Image, ImageDraw, ImageFont
from staticmap import StaticMap, Polygon, CircleMarker
from staticmap.staticmap import _lon_to_x, _lat_to_y

OUT = os.path.dirname(os.path.abspath(__file__))
# (번호, 이름, 위도, 경도, 폰)
ZONES = [
  (1, '하남 미사2동', 37.539, 127.215, '폰6'),
  (2, '울산 남구 달동', 35.544, 129.330, '폰6'),
  (3, '서울 서대문 연희동', 37.579, 126.937, '폰5'),
  (4, '대구 북구 검단동', 35.886, 128.583, '폰1'),
  (5, '인천 연수1동', 37.410, 126.678, '폰4'),
  (6, '대전 유성 노은3동', 36.362, 127.356, '폰2'),
  (7, '군포 궁내동', 37.361, 126.935, '폰4'),
  (8, '천안 서북 쌍용3동', 36.880, 127.120, '폰3'),
  (9, '청주 흥덕 복대1동', 36.630, 127.435, '폰2'),
  (10, '오산 원동', 37.150, 127.077, '폰3'),
  (11, '의정부 3동', 37.738, 127.047, '폰5'),
  (12, '구미 형곡2동', 36.119, 128.344, '폰1'),
]
FONT = ImageFont.truetype(r'C:\Windows\Fonts\malgunbd.ttf', 22)
FONT_S = ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf', 18)


def circle(lat, lon, km, n=60):
  pts = []
  for i in range(n + 1):
    a = 2 * math.pi * i / n
    dlat = km / 111.0 * math.cos(a)
    dlon = km / (111.0 * math.cos(math.radians(lat))) * math.sin(a)
    pts.append((lon + dlon, lat + dlat))
  return pts


def render(zones, size, zoom, name, center=None, label=True):
  m = StaticMap(size[0], size[1], url_template='https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                headers={'User-Agent': 'samba-browser-research/1.0 (personal use)'})
  for z in zones:
    m.add_polygon(Polygon(circle(z[2], z[3], 10), fill_color='#ff6f0f55', outline_color='#d94f00', simplify=False))
  for z in zones:
    m.add_marker(CircleMarker((z[3], z[2]), '#d94f00', 9))
  img = m.render(zoom=zoom, center=center).convert('RGB')
  d = ImageDraw.Draw(img)
  for z in zones:
    x = (_lon_to_x(z[3], zoom) - m.x_center) * m.tile_size + size[0] / 2
    y = (_lat_to_y(z[2], zoom) - m.y_center) * m.tile_size + size[1] / 2
    txt = f'{z[0]}'
    d.ellipse([x - 13, y - 13, x + 13, y + 13], fill='#d94f00', outline='white', width=2)
    d.text((x - 6 if z[0] < 10 else x - 12, y - 13), txt, fill='white', font=FONT)
    if label:
      d.text((x + 16, y - 12), z[1], fill='#222222', font=FONT_S, stroke_width=3, stroke_fill='white')
  img.save(os.path.join(OUT, name))
  print('저장', name, img.size)


if __name__ == '__main__':
  render(ZONES, (900, 1100), 7, 'map_korea.png', center=(128.1, 36.6), label=False)
  south = [z for z in ZONES if z[0] in (2, 4, 6, 8, 9, 12)]
  render(south, (1000, 1000), 8, 'map_south.png', center=(128.3, 36.35))
  capital = [z for z in ZONES if z[0] in (1, 3, 5, 7, 10, 11)]
  render(capital, (1000, 900), 9, 'map_capital.png', center=(127.0, 37.45))
