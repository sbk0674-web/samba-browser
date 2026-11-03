import shutil
import subprocess
from pathlib import Path

import pytest


def test_shipping_pins_expected_tab_and_rejects_other_host():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required for saved browser script test')
    path = Path(__file__).parents[1] / 'site-scripts' / 'lotteon_set_shipping.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const source=fs.readFileSync(process.argv[1],'utf8');
const run=new (Object.getPrototypeOf(async function(){}).constructor)('args','tabs','page','sleep',source);
(async()=>{
let active='https://mail.naver.com/',switched=false;
const page={url:async()=>active,waitFor:async()=>{},get:async()=>{throw Error('PINNED');}};
const tabs={list:async()=>[{id:'order',url:'https://www.lotteon.com/order',profile:'buyer'}],switch:async id=>{assert.equal(id,'order');switched=true;active='https://www.lotteon.com/order';}};
await assert.rejects(run({name:'test',address:'test',tab:'order',profile:'buyer'},tabs,page,async()=>{}),/PINNED/);
assert(switched);
const bad=await run({name:'test',address:'test',tab:'other'},tabs,page,async()=>{});
assert.equal(bad.error,'order-tab-mismatch');
active='https://mail.naver.com/';
const wrong=await run({name:'test',address:'test'},tabs,page,async()=>{});
assert.equal(wrong.error,'not-on-lotteon');
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
