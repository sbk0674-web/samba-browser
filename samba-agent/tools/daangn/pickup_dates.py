"""당근 수거일 선택 규칙. 화면에 실제로 표시된 날짜만 고른다."""

import hashlib
import io
import math
import re
import xml.etree.ElementTree as ET
from datetime import date, timedelta


class MissingDateBounds(ValueError):
    """날짜는 읽었으나 접근성 좌표를 쓸 수 없어 시각 근거가 필요한 경우."""


def calendar_dates(xml: str, *, today: date) -> list[tuple[date, str]]:
    root = ET.fromstring(xml)
    if not any(n.get('text', '').strip() == '택배를 언제 수거할까요?' for n in root.iter('node')):
        raise ValueError('수거일 선택 화면 확인 필요')
    result = []
    for node in root.iter('node'):
        label = node.get('text', '').strip()
        match = re.fullmatch(r'(\d{1,2})월\s*(\d{1,2})일\s*\([월화수목금토일]\)', label)
        if not match:
            continue
        # 시각 행과 XML 순서가 달라질 수 있는 비활성 항목은 추정하지 않는다.
        if node.get('enabled') == 'false':
            raise ValueError('비활성 수거일 시각 매핑 확인 필요')
        month, day = map(int, match.groups())
        try:
            value = date(today.year, month, day)
            if value < today:
                value = date(today.year + 1, month, day)
        except ValueError as exc:
            raise ValueError('수거일 확인 필요') from exc
        if not today <= value <= today + timedelta(days=31):
            raise ValueError('수거일 범위 확인 필요')
        result.append((value, label))
    if not result or [v for v, _ in result] != sorted({v for v, _ in result}):
        raise ValueError('수거일 순서 또는 중복 확인 필요')
    return result


def choose_pickup_date(xml: str, *, today: date, is_musinsa: bool) -> tuple[date, str]:
    root = ET.fromstring(xml)
    texts = [n.get('text', '').strip() for n in root.iter('node')]
    if '택배를 언제 수거할까요?' not in texts:
        raise ValueError('수거일 선택 화면 확인 필요')
    options = []
    for node in root.iter('node'):
        label = node.get('text', '').strip()
        m = re.fullmatch(r'(\d{1,2})월\s*(\d{1,2})일\s*\([월화수목금토일]\)', label)
        if not m or node.get('enabled') == 'false':
            continue
        month, day = map(int, m.groups())
        try:
            value = date(today.year, month, day)
            if value < today:
                value = date(today.year + 1, month, day)
        except ValueError:
            continue
        # 같은 화면에서 고를 수 있는 날짜는 가까운 미래만 허용한다.
        if not today <= value <= today + timedelta(days=31):
            continue
        bounds = node.get('bounds', '')
        if not re.fullmatch(r'\[\d+,\d+\]\[\d+,\d+\]', bounds):
            raise MissingDateBounds('수거일 버튼 위치 확인 필요')
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', bounds))
        if x2 <= x1 or y2 <= y1:
            raise MissingDateBounds('수거일 버튼 위치 확인 필요')
        options.append((value, bounds))
    if not options or len({d for d, _ in options}) != len(options):
        raise ValueError('수거 가능 날짜 확인 필요')
    chosen = (max if is_musinsa else min)(options, key=lambda item: item[0])
    if is_musinsa and chosen[0] <= today + timedelta(days=1):
        raise ValueError('무신사 수거 최후일 확인 필요 — 오늘/내일은 예약하지 않습니다')
    return chosen


def detect_radio_rows(png: bytes) -> list[dict]:
    """밝은 화면의 원형 라디오와 이를 감싼 카드 경계를 실제 픽셀에서 찾는다.

    화면 좌표/해상도 비율을 사용하지 않는다. 카드 밖 아이콘과 잘린 원은 제외한다.
    """
    from PIL import Image

    with Image.open(io.BytesIO(png)) as source:
        image = source.convert('L')
    width, height = image.size
    pixels = image.tobytes()
    mask = bytearray(image.point(lambda p: 1 if p < 235 else 0).tobytes())
    components = []
    # 4방향 연결요소. 카드 테두리와 라디오 원은 서로 독립된 요소다.
    for start in range(width * height):
        if not mask[start]:
            continue
        mask[start] = 0
        stack = [start]
        x0 = x1 = start % width
        y0 = y1 = start // width
        count = 0
        while stack:
            pos = stack.pop()
            x, y = pos % width, pos // width
            x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
            count += 1
            neighbors = []
            if x: neighbors.append(pos - 1)
            if x + 1 < width: neighbors.append(pos + 1)
            if y: neighbors.append(pos - width)
            if y + 1 < height: neighbors.append(pos + width)
            for neighbor in neighbors:
                if mask[neighbor]:
                    mask[neighbor] = 0
                    stack.append(neighbor)
        components.append((x0, y0, x1 + 1, y1 + 1, count))

    candidates = []
    for x0, y0, x1, y1, count in components:
        w, h = x1 - x0, y1 - y0
        if not (16 <= w <= 100 and 0.9 <= w / h <= 1.1 and count >= w * 2):
            continue
        cx, cy, radius = (x0 + x1 - 1) / 2, (y0 + y1 - 1) / 2, min(w, h) / 2
        boundary = []
        for step in range(48):
            angle = step * 2 * math.pi / 48
            x, y = round(cx + (radius - 1) * math.cos(angle)), round(cy + (radius - 1) * math.sin(angle))
            boundary.append(any(pixels[yy * width + xx] < 235
                                for yy in range(max(0, y - 1), min(height, y + 2))
                                for xx in range(max(0, x - 1), min(width, x + 2))))
        if sum(boundary) < 46:
            continue
        center = [pixels[y * width + x] for y in range(y0, y1) for x in range(x0, x1)
                  if (x - cx)**2 + (y - cy)**2 < (radius * 0.25)**2]
        annulus = [pixels[y * width + x] for y in range(y0, y1) for x in range(x0, x1)
                   if (radius * 0.55)**2 < (x - cx)**2 + (y - cy)**2 < (radius * 0.8)**2]
        if not center or sum(v < 200 for v in center) > len(center) * 0.1:
            continue
        cards = [c[:4] for c in components
                 if c[0] < x0 and c[1] < y0 and c[2] > x1 and c[3] > y1
                 and c[2] - c[0] > w * 4 and c[3] - c[1] < h * 5]
        if not cards:
            continue
        card = min(cards, key=lambda c: (c[2] - c[0]) * (c[3] - c[1]))
        # 날짜 글자만 잘라 이진 잉크 지문을 만든다. 테두리/선택 상태는 포함하지 않는다.
        ink = image.crop((card[0] + w, y0, x0 - w, y1)).point(lambda p: 255 if p < 128 else 0)
        box = ink.getbbox()
        if box is None:
            continue
        ink = ink.crop(box)
        fingerprint = hashlib.sha256(str(ink.size).encode() + ink.tobytes()).hexdigest()
        candidates.append({'bounds': (x0, y0, x1, y1), 'card': card,
                           'selected': sum(v < 100 for v in annulus) > len(annulus) * 0.7,
                           'fingerprint': fingerprint})
    # 원 크기·열이 같은 후보만 한 그룹으로 묶는다(글자 속 동그라미 배제).
    groups = []
    for row in candidates:
        x0, _, x1, _ = row['bounds']
        group = next((g for g in groups if abs(g[0]['bounds'][0] - x0) <= (x1 - x0) * 0.15
                      and abs((g[0]['bounds'][2] - g[0]['bounds'][0]) - (x1 - x0)) <= 2), None)
        if group is None:
            groups.append([row])
        else:
            group.append(row)
    groups.sort(key=lambda g: (len(g), g[0]['bounds'][2] - g[0]['bounds'][0]), reverse=True)
    if not groups or len(groups[0]) < 2:
        raise ValueError('시각 라디오 행 확인 필요')
    if len(groups) > 1 and len(groups[0]) == len(groups[1]):
        raise ValueError('시각 라디오 열이 모호합니다')
    rows = sorted(groups[0], key=lambda r: r['bounds'][1])
    if len({r['fingerprint'] for r in rows}) != len(rows):
        raise ValueError('시각 행 글자 중복 확인 필요')
    return rows


def map_radio_rows(rows: list[dict], count: int, known: dict | None = None):
    """첫 화면 기본 선택과 겹치는 글자 지문으로 XML 순서에 연결한다. 추정 매핑 금지."""
    if known is None:
        if not rows or [i for i, row in enumerate(rows) if row['selected']] != [0]:
            raise ValueError('수거일 첫 화면 기본 선택 확인 필요')
        offset = 0
        known = {}
    else:
        offsets = [known[row['fingerprint']] - i for i, row in enumerate(rows)
                   if row['fingerprint'] in known]
        if len(offsets) < 2 or len(set(offsets)) != 1:
            raise ValueError('스크롤 전후 날짜 행 연결 확인 필요')
        offset = offsets[0]
    if offset < 0 or offset + len(rows) > count:
        raise ValueError('시각 날짜와 XML 개수 불일치')
    mapped = [{**row, 'index': offset + i} for i, row in enumerate(rows)]
    known = {**known, **{row['fingerprint']: row['index'] for row in mapped}}
    return mapped, known
