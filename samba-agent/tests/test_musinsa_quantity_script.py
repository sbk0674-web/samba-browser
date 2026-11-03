import shutil
import subprocess
from pathlib import Path

import pytest


def test_quantity_uses_dom_click_and_stops_before_checkout_on_mismatch():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'musinsa_product_snapshot.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const body=s.slice(s.indexOf('const WQ='),s.indexOf('const bi='));
const run=new (Object.getPrototypeOf(async function(){}).constructor)('args','itree','page','sleep','closeP','done',body+';return "ready";');
(async()=>{for(const blocked of [false,true]){
let qty=1,closed=false;
const tree=async()=>`[2068] button\n[2069] textbox value="${qty}"\n[2070] button`;
const page={click:async id=>{assert.equal(id,2070);if(!blocked)qty++;},clickNative:async()=>{throw Error('native click forbidden');}};
const out=await run({qty:2},tree,page,async()=>{},async()=>{closed=true;},note=>note);
assert.equal(out,blocked?'qty mismatch':'ready');assert.equal(closed,blocked);assert.equal(qty,blocked?1:2);
}})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_failed_checkout_closes_product_tab():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'musinsa_product_snapshot.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const line=s.split('\n').find(x=>x.startsWith('if(!of)'));
const run=new (Object.getPrototypeOf(async function(){}).constructor)('of','O','closeP','done',line);
(async()=>{let closed=0;const o={};
assert.equal(await run(null,o,async()=>{closed++;},x=>x),'no order form');
assert.equal(closed,1);assert.equal(o.error,'no_checkout');
closed=0;await run({id:'checkout'},o,async()=>{closed++;},x=>x);assert.equal(closed,0);
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_interactive_reader_uses_boolean_and_quantity_scoping():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'musinsa_product_snapshot.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
assert(!/interactive:\s*1\b/.test(s));assert(s.length<=8000);
const line=s.split('\n').find(x=>x.startsWith('const itree='));
const run=new (Object.getPrototypeOf(async function(){}).constructor)('get','q',line+';return await itree(q);');
(async()=>{for(const q of [undefined,1]){const calls=[];
await run(async o=>{calls.push(o);assert.strictEqual(o.interactive,true);return {tree:'snapshot'};},q);
assert.equal(calls.length,q?1:2);
if(q)assert(calls[0].selector.includes('Purchase'));
}})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
