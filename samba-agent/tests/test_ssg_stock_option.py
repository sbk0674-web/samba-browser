import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize('want,choices,sold_out', [
    ('245', ['230', '245(매진)'], True),
    ('245', ['245 (품절)', '250'], True),
    ('245', ['230', '250(매진)'], False),
    ('235', ['235', '245(매진)'], False),
])
def test_requested_sold_out_option_is_not_lost(want, choices, sold_out):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node required')
    path = Path(__file__).parents[1] / 'site-scripts/ssg_product_snapshot.js'
    js = r'''
const fs=require('fs'),assert=require('assert');
const run=new (Object.getPrototypeOf(async function(){}).constructor)('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
const [want,choices,expected]=JSON.parse(process.argv[2]);
let opened=false,selected=false;const clicks=[];
const base='[1] link "사이즈 선택하세요." href=#';
const page={url:async()=> 'https://department.ssg.com/item/itemView.ssg?itemId=1&siteNo=6009',
 title:async()=> 'test - 신세계백화점',waitFor:async()=>{},
 idOf:async label=>label==='바로구매'&&!selected?2:-1,
 click:async id=>{clicks.push(id);if(id===1)opened=true;else selected=true;assert.notEqual(id,2,'Must not enter checkout');},
 get:async o=>({tree:base+(opened?'\n'+choices.map((s,i)=>`[${i+10}] link "${s}" href=#`).join('\n'):'')+'\nPAGE TEXT: 판매자스토어 신세계백화점 바로구매'})};
const tabs={open:async()=> 'tab stock',switch:async()=>{},close:async()=>{},list:async()=>[]};
(async()=>{const r=await run({sku:'https://department.ssg.com/item/itemView.ssg?itemId=1&siteNo=6009',size:want,allow_department:true,coupon:false},tabs,page,async()=>{});
 assert.equal(r.sold_out===true,expected);
 if(expected){assert(r.options.some(x=>x.includes(want)));assert.deepEqual(clicks,[1]);assert.equal(r.selected,null);}
})().catch(e=>{console.error(e);process.exit(1)});
'''
    result = subprocess.run(
        [node, '-e', js, str(path), json.dumps([want, choices, sold_out])],
        capture_output=True, text=True, encoding='utf-8',
    )
    assert result.returncode == 0, result.stderr
