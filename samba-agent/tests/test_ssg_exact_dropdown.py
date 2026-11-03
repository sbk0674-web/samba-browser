import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize('label,choices,expected', [
    ('색상 선택하세요.', ['유색3매입', '옵션1.M그레이_PMDOFK01/97'], ['옵션1.M그레이_PMDOFK01/97']),
    ('사이즈 선택하세요.', ['095', '110 (남은수량:780개)'], ['110 (남은수량:780개)']),
    ('색상 선택하세요.', ['유색3매입'], []),
])
def test_named_dropdown_matches_complete_requested_part(label, choices, expected):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node required')
    code = (Path(__file__).parents[1] / 'site-scripts/ssg_product_snapshot.js').read_text(encoding='utf-8')
    start = code.index("const p=want.lastIndexOf('/')")
    end = code.index('\nR.options=', start)
    js = "const want='옵션1.M그레이_PMDOFK01/97/110',opener=1;const before=new Set();const optionLike=()=>true;const nm=s=>s.replace(/[\\s()·\\-/,:]/g,'').toLowerCase();"
    js += 'const oc=[{id:1,text:' + json.dumps(label) + '}];const after=' + json.dumps([{'id': i + 2, 'text': t} for i, t in enumerate(choices)]) + ';'
    js += code[start:end] + ';console.log(JSON.stringify(live.map(x=>x.text)));'
    out = subprocess.run([node, '-e', js], check=True, capture_output=True, text=True, encoding='utf-8')
    assert json.loads(out.stdout) == expected
