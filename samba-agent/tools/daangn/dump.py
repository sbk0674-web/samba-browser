# uiautomator 덤프를 읽기 쉬운 줄로 출력
import sys, re, io, xml.etree.ElementTree as ET
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
raw = sys.stdin.buffer.read().decode('utf-8', 'replace')
root = ET.fromstring(raw)
for n in root.iter('node'):
  t = n.get('text') or ''; d = n.get('content-desc') or ''; rid = n.get('resource-id') or ''
  if t or d or n.get('clickable') == 'true':
    b = re.findall(r'\d+', n.get('bounds')); cx = (int(b[0]) + int(b[2])) // 2; cy = (int(b[1]) + int(b[3])) // 2
    print(f'{cx},{cy} {n.get("class").split(".")[-1]} id={rid.split("/")[-1]} t={t[:70]!r} d={d[:70]!r} click={n.get("clickable")} sel={n.get("selected")} chk={n.get("checked")}')
