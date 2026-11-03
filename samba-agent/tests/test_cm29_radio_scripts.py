import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize('name', [
    'checkout_enter_29cm', 'cm29_payment_quotes', 'cm29_pay_card_quote',
])
@pytest.mark.parametrize('named', [False, True])
def test_payment_radio_reader_accepts_named_and_unnamed_controls(name, named):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / f'{name}.js'
    code = r'''
const fs=require('fs'),assert=require('assert');
const source=fs.readFileSync(process.argv[1],'utf8');
const start=source.indexOf('async function radios()');
const end=source.indexOf('\n}',start)+2;
const globals=`const lines=t=>t.split('PAGE TEXT')[0].split('\\n').filter(l=>/^\\[\\d/.test(l));const idOf=l=>parseInt(l.slice(1));const text=t=>(t.split('PAGE TEXT:')[1]||'').replace(/\\s+/g,' ');`;
const run=new(Object.getPrototypeOf(async function(){}).constructor)('page',globals+source.slice(start,end)+';return radios();');
const labels=['구매 적립금 받기','선할인 받기','무신사머니','무신사페이','토스페이','카카오페이','카드 결제','다른 결제 방법'];
const tree=labels.map((label,i)=>`[${i+1}] radio${process.argv[2]==='True'?' "'+label+'" name=payment':''} value="off"`).join('\n')+'\nPAGE TEXT: '+labels.join(' ');
run({get:async()=>({tree})}).then(r=>{assert(r);assert.equal(r['기타'],8);assert.equal(r['무신사머니'],3);}).catch(e=>{console.error(e);process.exit(1);});
'''
    result = subprocess.run([node, '-e', code, str(path), str(named)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
