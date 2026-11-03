import shutil
import subprocess
from pathlib import Path

import pytest


def test_ssg_shipping_name_is_replaced_without_mutating_original():
    from samba_agent.agents.buyer import shipping_for_source
    original = {'name': '김*수_!', 'address': '가명로 12', 'address_detail': '101호'}
    normalized = shipping_for_source(original, 'ssg')
    assert normalized == {**original, 'name': '김ㅇ수'}
    assert original['name'] == '김*수_!'
    assert shipping_for_source(original, 'musinsa') == original


@pytest.mark.parametrize('route', ['provider', 'embedded', 'script'])
def test_ssg_fetch_shipping_normalizes_every_input_route(monkeypatch, route):
    from samba_agent.agents.buyer import BuyerAgent, shipping_matches
    from samba_agent.agents.contracts import Assignment, OrderRef
    from samba_agent.agents.registry import Registry
    from samba_agent.bridge.client import BridgeClient
    from samba_agent.settings import DEFAULT_ROOT
    reg = Registry.load(DEFAULT_ROOT)
    spec = reg['buyer.ssg']
    buyer = BuyerAgent(spec, BridgeClient('http://127.0.0.1:47811', 'a' * 64, allowed=spec.tools), lambda _: None)
    assignment = Assignment(order=OrderRef(order_no='test', source='SSG', seller='test', sku='test'), allowed_tools=spec.tools, rules=reg.rules_text(spec))
    original = {'name': '김*(가명)', 'address': '가명로 12', 'address_detail': '101호'}
    snap = {}
    if route == 'provider':
        buyer.set_shipping_provider(lambda *_: original)
    elif route == 'embedded':
        snap['shipping'] = original
    else:
        monkeypatch.setattr(buyer, 'json_tool', lambda *_a, **_k: {'shipping': original})
    received = buyer._fetch_shipping(assignment, snap)
    assert received['name'] == '김ㅇ가명'
    assert original['name'] == '김*(가명)'
    assert shipping_matches(received, {**received, 'name': '김ㅇ가명'})


@pytest.mark.parametrize('script', ['ssg_set_shipping', 'ssg_gift_address', 'ssg_select_shipping', 'ssg_confirm_shipping'])
def test_ssg_scripts_share_input_and_match_name_normalization(script):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / f'{script}.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const line=s.split('\n').find(x=>x.startsWith('const recipientName ='));
assert(line,'name normalization missing');
const nz=s=>String(s||'').replace(/\s+/g,' ').trim();
const run=new Function('args','nz',line+';return recipientName;');
assert.equal(run({name:'김*수_!'},nz),'김ㅇ수');
assert.equal(run({name:'O\'Neil'},nz),'ONeil');
assert.equal(run({name:'김**(가명)'},nz),'김ㅇㅇ가명');
assert.equal(run({name:'()_!'},nz),'');
assert.equal(run({name:' Éric 김수 123 '},nz),'Éric 김수 123');
assert(s.includes('recipientName'));
assert(!s.includes("nz(args.name).replace(/\\*/g, '')"));
assert(s.includes('if (!recipientName'));
if(process.argv[1].includes('ssg_set_shipping'))assert(s.includes('page.type(nmId, recipientName, false)'));
if(process.argv[1].includes('ssg_gift_address'))assert(s.includes('const base = recipientName'));
if(/ssg_(select|confirm)_shipping/.test(process.argv[1]))assert(s.includes('na(recipientName)'));
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr
