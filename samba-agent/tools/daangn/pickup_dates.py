"""당근 수거일 선택 규칙. 화면에 실제로 표시된 날짜만 고른다."""

from datetime import date, timedelta
import re
import xml.etree.ElementTree as ET


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
            raise ValueError('수거일 버튼 위치 확인 필요')
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', bounds))
        if x2 <= x1 or y2 <= y1:
            raise ValueError('수거일 버튼 위치 확인 필요')
        options.append((value, bounds))
    if not options or len({d for d, _ in options}) != len(options):
        raise ValueError('수거 가능 날짜 확인 필요')
    return (max if is_musinsa else min)(options, key=lambda item: item[0])
