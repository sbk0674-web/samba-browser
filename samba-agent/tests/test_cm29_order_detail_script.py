import shutil
import subprocess
from pathlib import Path

import pytest


def test_historical_order_filters_date_and_reads_owned_points():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'cm29_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
let url='',phase='list',filtered=false;const typed={},closed=[];
const tabs={open:async x=>{url=x.url;return 'tab audit'},switch:async()=>{},close:async x=>closed.push(x),list:async()=>[]};
const page={waitFor:async()=>true,
 type:async(id,value)=>{typed[id]=value},
 click:async id=>{if(id===1)phase='period';if(id===2)phase='dates';if(id===5){assert.equal(typed[3],'2026-09-23');assert.equal(typed[4],'2026-09-23');filtered=true;phase='list'}},
 get:async()=>{let tree;
 if(url.includes('/detail/'))tree='PAGE TEXT: 주문번호 ORD20260923-3292776 장바구니 담기 구매확정 결제정보 결제금액 83,990원 페이코 83,990원 보유 적립금 1,320원 구매 적립금 선할인 840원 배송지정보';
 else if(phase==='period')tree='[2] button "기간 선택"';
 else if(phase==='dates')tree='[3] textbox "시작일" value="'+(typed[3]||'2025-10-12')+'"\n[4] textbox "종료일" value="'+(typed[4]||'2026-10-12')+'"\n[5] button "조회하기"';
 else tree=filtered?'[6] link "주문상세" href=https://www.29cm.co.kr/order/my-order/detail/66920580\nPAGE TEXT: 2026. 9. 23 주문상세':'[1] button "최근 1년"\n[6] link "주문상세" href=https://www.29cm.co.kr/order/my-order/detail/67748422\nPAGE TEXT: 2026. 10. 12 주문상세';
 return {tree}}};
(async()=>{const r=await run({source_order_no:'ORD20260923-3292776'},tabs,page,async()=>{});
 assert.equal(filtered,true);assert.equal(r.source_order_no,'ORD20260923-3292776');
 assert.equal(r.paid,83990);assert.equal(r.points_used,1320);assert.equal(r.points_box,1320);
 assert.equal(r.status,'구매확정');assert.equal(closed.length,2);
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr


def test_date_readback_failure_closes_tab_without_reading_another_order():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'cm29_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
let phase=0,opens=0;const closed=[];
const tabs={open:async()=>{opens++;return 'tab audit'},switch:async()=>{},close:async id=>closed.push(id)};
const page={waitFor:async()=>true,type:async()=>{},click:async id=>{if(id===1)phase=1;if(id===2)phase=2;},
 get:async()=>({tree:phase===0?'[1] button "최근 1년"':phase===1?'[2] button "기간 선택"':'[3] textbox "시작일" value="2025-10-12"\n[4] textbox "종료일" value="2026-10-12"\n[5] button "조회하기"'})};
(async()=>{const r=await run({source_order_no:'ORD20260923-3292776'},tabs,page,async()=>{});
 assert.match(r.note,/날짜 되읽기 불일치/);assert.equal(r.paid,0);assert.equal(opens,1);assert.deepEqual(closed,['audit']);
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr


def test_order_below_tenth_row_is_read_via_detail_query():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'cm29_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
let url='',phase=0,queryRead=false;const typed={},closed=[];
const links=n=>Array.from({length:n},(_,i)=>'['+(10+i)+'] link "주문상세" href=https://www.29cm.co.kr/order/my-order/detail/'+(100+i)).join('\n');
const dates='PAGE TEXT: '+Array(12).fill('2026. 9. 25 주문상세').join(' ');
const tabs={open:async x=>{url=x.url;return 'tab audit'},switch:async()=>{},close:async x=>closed.push(x),list:async()=>[]};
const page={waitFor:async()=>true,type:async(id,value)=>{typed[id]=value},click:async id=>{if(id===1)phase=1;if(id===2)phase=2;if(id===5)phase=3},
 get:async o=>{let tree;
 if(url.includes('/detail/'))tree='PAGE TEXT: 주문번호 '+(url.endsWith('/111')?'ORD20260925-3907371':'OTHER')+' 장바구니 담기 구매확정 결제정보 결제금액 74,850원 무신사머니 74,850원 배송지정보';
 else if(phase===0)tree='[1] button "최근 1년"';
 else if(phase===1)tree='[2] button "기간 선택"';
 else if(phase===2)tree='[3] textbox "시작일" value="'+(typed[3]||'')+'"\n[4] textbox "종료일" value="'+(typed[4]||'')+'"\n[5] button "조회하기"';
 else {if(o.query==='주문상세')queryRead=true;tree=links(o.query==='주문상세'?12:6)+'\n'+dates}
 return {tree}}};
(async()=>{const r=await run({source_order_no:'ORD20260925-3907371'},tabs,page,async()=>{});
 assert.equal(queryRead,true);assert.equal(r.paid,74850);assert.equal(r.source_order_no,'ORD20260925-3907371');
 assert.equal(closed.length,13);
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr
