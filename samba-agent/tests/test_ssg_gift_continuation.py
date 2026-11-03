import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize('mid,matching,expected', [(False, True, True), (True, True, True), (True, False, False)])
def test_gift_continuation_requires_matching_shipping(mid, matching, expected):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node required for script regression')
    source = (Path(__file__).parents[1] / 'site-scripts/ssg_gift_address.js').read_text(encoding='utf-8')
    tail = source[source.index('const go ='):]
    preamble = '''
let stage=0;const R={ok:false};const base='TEST';const road='TESTROAD';const det='101';
const sq=s=>String(s).replace(/\\s+/g,'');const nz=s=>String(s).replace(/\\s+/g,' ').trim();
const idL=l=>parseInt(l.slice(1));const sleep=async()=>{};
const tabs={switch:async()=>{},list:async()=>[{id:'owned',url:url()}]};
const page={click:async()=>{stage++;return 'ok'},waitFor:async()=>{}};
const url=()=>mid&&stage===1?'https://pay.ssg.com/nodcsnOrder/ordShppInfo.ssg':'https://pay.ssg.com/order/ordPage.ssg';
const waitTab=async re=>re.test(url())?{id:'owned',url:url()}:null;
const tree=async()=>stage===0?'[1] button "계속하기"':stage===1&&mid?
 '[2] button "계속하기"\\nPAGE TEXT: '+(matching?'TEST TESTROAD 101':'OTHER'):
 'PAGE TEXT: 결제 예정금액 10,355 SSG닷컴이 대신 전달';
'''
    js = f'const mid={json.dumps(mid)},matching={json.dumps(matching)}; (async()=>{{{preamble}{tail}}})().then(x=>console.log(JSON.stringify(x)));'
    result = subprocess.run([node, '-e', js], text=True, capture_output=True, encoding='utf-8', check=True)
    assert json.loads(result.stdout)['ok'] is expected
