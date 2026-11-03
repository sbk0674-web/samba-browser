import shutil
import subprocess
from pathlib import Path

import pytest


def test_preserves_designated_product_url_and_numeric_lookup():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'abc_product_snapshot.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const line=s.split('\n').find(x=>x.startsWith('const url ='));
const run=new Function('sku','prdtNo','HOST',line+';return url;');
const host='https://grandstage.a-rt.com';
const url=host+'/product/new?prdtNo=1020130984&tChnnlNo=10002';
assert.equal(run(url,'1020130984',host),url);
assert.equal(run('1020130984','1020130984',host),host+'/product?prdtNo=1020130984');
assert.equal(run('IQ4927 001',null,host),host+'/display/search-word/result?searchWord=IQ4927%20001');
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_selected_is_read_from_checkout_not_product_choice():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'abc_product_snapshot.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const body=s.slice(s.indexOf('const line = t.match('),s.indexOf('const methods ='));
const run=new Function('t','picked',body+';return selected;');
assert.equal(run('A-RT 배송 상품 나이키 AIR FORCE 1 07 290/ 1 개','240'),'290');
assert.equal(run('결제예정금액 209,000원','240'),null);
assert(s.length<=8000);
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_tracking_script_only_is_not_a_login_failure():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'abc_product_snapshot.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const guard=s.split('\n').find(x=>x.includes("error: 'page_not_rendered'"));
assert(guard,'tracking-only page needs its own failure');
const run=new (Object.getPrototypeOf(async function(){}).constructor)('all','pt','stop',guard+';return null;');
(async()=>{
const stop=async(note,extra)=>extra;
assert.equal((await run([],'var h=document.getElementsByTagName("head")[0]; kakaoPixel().pageView();',stop)).error,'page_not_rendered');
assert.equal(await run([{t:'240'}],'상품코드 : IQ4927 LOGOUT kakaoPixel',stop),null);
assert.equal(await run([],'상품코드 : IQ4927 판매 종료 및 중지된 상품 kakaoPixel',stop),null);
assert.equal(await run([],'LOGIN 로그인하세요',stop),null);
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
