import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize('mode', ['found', 'stalled', 'refused', 'missing'])
def test_sent_gift_history_reads_more_with_bounded_progress(mode):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'lotteon_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const run=new (Object.getPrototypeOf(async function(){}).constructor)('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
const mode=process.argv[2],target='2026101112345678';
let active='',more=0,detail=false;const opened=[],closed=[];
const tabs={open:async o=>{const id=String(opened.length);opened.push({id,url:o.url});return 'tab '+id;},switch:async id=>active=opened[Number(id)].url,list:async()=>opened,close:async id=>closed.push(id)};
const list=()=> 'PAGE TEXT: 2026101212345678'+(more&&mode==='found'?' '+target:more&&mode==='missing'?' 202610101234567'+more:'');
const page={url:async()=>active,waitFor:async()=>{},click:async id=>{
 if(id===9)return 'ok';if(id===10){more++;return mode==='refused'?'refused':'ok';}
 assert.equal(id,12);detail=true;return 'ok';
},get:async o=>({tree:o.query==='보낸 선물'?'[9] button "보낸 선물 (99+)"':
 o.query==='더보기'?'[10] button "더보기 (1/112)"':
 o.query==='상세보기'?'[11] button "상세보기"\n[12] button "상세보기"':
 detail?'PAGE TEXT: '+target+' 배송중 결제정보 네이버페이 결제완료 30,000원 목록보기':
 active.includes('givenSentList')?list():'PAGE TEXT: no normal orders'})};
(async()=>{const r=await run({source_order_no:target},tabs,page,async()=>{});
 assert.equal(more,mode==='missing'?2:1);assert.equal(detail,mode==='found');
 assert.equal(r.paid,mode==='found'?30000:0);assert.equal(r.note,mode==='found'?null:'order not in list');
 assert.deepEqual(closed,['0','1']);
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path), mode], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr


def test_return_collection_is_read_without_marking_refund_complete():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'lotteon_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const run=new (Object.getPrototypeOf(async function(){}).constructor)('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
let detail=false;const closed=[];
const tabs={open:async()=> 'tab audit',switch:async()=>{},list:async()=>[{id:'audit'}],close:async id=>closed.push(id)};
const page={url:async()=> 'https://www.lotteon.com/p/order/mylotte/orderDeliveryList',waitFor:async()=>true,
click:async id=>{assert.equal(id,4);detail=true;return 'ok';},get:async o=>({tree:o.query==='상세보기'?'[4] button "상세보기"':!detail?'PAGE TEXT: 2026100317589579':
'PAGE TEXT: 2026100317589579 NF6KR96A_BLK 80(XL) 수량 1 반품회수 택배사에 상품 회수를 요청했어요 반품취소 반품현황 결제정보 L.PAY 롯데카드 1234 결제완료 101,920원 목록보기'})};
(async()=>{const r=await run({source_order_no:'2026100317589579'},tabs,page,async()=>{});
assert.equal(r.status,'반품회수');assert.equal(r.note,null);assert.equal(r.paid,101920);
assert.equal(r.card,'L.PAY - 롯데카드');assert.deepEqual(closed,['audit']);
const line=fs.readFileSync(process.argv[1],'utf8').split('\n').find(x=>x.startsWith('const productStatus ='));
const parse=new Function('text',line+';return productStatus(text);');
assert.equal(parse('상품 결제정보 반품회수 결제완료 101,920원'),'');
assert.equal(parse('상품 반품현황 반품취소 결제정보'),'');
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr


def test_scheduled_confirmation_is_not_completed_order_status():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'lotteon_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const line=s.split('\n').find(x=>x.startsWith('const productStatus ='));
const parse=new Function('text',line+';return productStatus(text);');
const parseWithAction=new Function('text',line+';return productStatus(text,true);');
assert.equal(parseWithAction('구매확정 러닝 글러브 블랙 M 배송완료 상품이 배송지에 도착하였습니다. 구매확정연장 결제정보'),'배송완료');
assert.equal(parseWithAction('구매확정 러닝 글러브 블랙 M 구매확정연장 결제정보'),'');
assert.equal(parse('후디 110 자동구매확정 예정일 : 2026.10.14 결제정보 네이버페이 결제완료 47,400원'),'');
assert.equal(parse('후디 110 구매확정 예정일 : 2026.10.14 결제정보 네이버페이 결제완료 47,400원'),'');
assert.equal(parse('배송완료 후디 110 자동구매확정 예정일 : 2026.10.14 결제정보'),'배송완료');
assert.equal(parse('구매확정 후디 110 결제정보'),'구매확정');
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('delay', [0, 2, 99])
def test_order_status_waits_for_product_not_payment_method(delay):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'lotteon_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const run=new (Object.getPrototypeOf(async function(){}).constructor)('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
let detail=false,reads=0;const closed=[],delay=Number(process.argv[2]);
const tabs={open:async()=> 'tab audit',switch:async()=>{},list:async()=>[{id:'audit'}],close:async id=>closed.push(id)};
const page={url:async()=> 'https://www.lotteon.com/p/order/mylotte/orderDeliveryList',waitFor:async()=>true,
click:async()=>{detail=true;return 'ok';},get:async o=>({tree:o.query==='상세보기'?'[4] button "상세보기"':!detail?'PAGE TEXT: 2026092816131856':
'PAGE TEXT: 2026092816131856 '+(reads++>=delay?'NP6KP12B 그레이 085(L) 수량 1 구매확정 ':'')+'결제정보 네이버페이 결제완료 35,100원 목록보기'})};
(async()=>{const r=await run({source_order_no:'2026092816131856'},tabs,page,async()=>{});
assert.equal(r.status,delay===99?'':'구매확정');
assert.equal(r.note,delay===99?'product order status not loaded':null);
assert.equal(r.paid,35100);assert.deepEqual(closed,['audit']);
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path), str(delay)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('readback', [True, False])
def test_historical_keyword_search_checks_readback_and_exact_order(readback):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'lotteon_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const run=new (Object.getPrototypeOf(async function(){}).constructor)('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
let year=false,typed=false,searched=false,detail=false;const closed=[];const readback=process.argv[2]==='True';
const tabs={open:async()=> 'tab audit',switch:async()=>{},list:async()=>[{id:'audit'}],close:async id=>closed.push(id)};
const page={url:async()=> 'https://www.lotteon.com/p/order/mylotte/orderDeliveryList',waitFor:async()=>true,
type:async(id,value)=>{assert.equal(id,2);assert.equal(value,'PHF3RR2020');typed=true;},
click:async id=>{if(id===1)year=true;else if(id===3){assert(year&&typed);searched=true;}else if(id===4)detail=true;else throw Error('unexpected click '+id);return 'ok';},
get:async o=>({tree:o.query==='1년'?'[1] radio "1년"':o.query==='상품명'?'[2] textbox "상품명 또는 브랜드명 검색" value="'+(typed&&readback?'PHF3RR2020':'')+'"':o.query==='검색'?'[3] button "검색"':o.query==='상세보기'?'[4] button "상세보기"':detail?'PAGE TEXT: 2026092415237706 구매확정 구매적립완료 70P 결제정보 네이버페이 결제완료 17,000원 목록보기':searched?'PAGE TEXT: 2026092415237706':'PAGE TEXT: recent orders'})};
(async()=>{const r=await run({source_order_no:'2026092415237706',search_keyword:'PHF3RR2020'},tabs,page,async()=>{});
assert(year&&typed);assert.equal(searched,readback);assert.deepEqual(closed,['audit']);
if(readback){assert.equal(r.paid,17000);assert.equal(r.reward,70);assert.equal(r.source_order_no,'2026092415237706');}else assert.equal(r.note,'search keyword readback failed');
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path), str(readback)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr


def test_payment_issuer_readback_with_masked_card_digits():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'lotteon_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const body=s.slice(s.indexOf('const methods = []'),s.indexOf('if (!R.paid'));
const run=new Function('pay','R','nz','num',body+';return R;');
const parse=pay=>run(pay,{paid:0,points_used:0,card:''},s=>s.replace(/\s+/g,' ').trim(),s=>Number(s.replace(/\D/g,'')));
const r=parse('L.PAY 롯데카드 1234 결제완료 103,320원');
assert.equal(r.paid,103320);assert.equal(r.card,'L.PAY - 롯데카드');
assert.equal(parse('결제완료 103,320원').card,'');
assert.equal(parse('L.PAY 롯데카드 현대카드 1234 결제완료 103,320원').card,'');
assert.equal(parse('카카오페이 머니 결제완료 99,100원').card,'카카오페이 머니');
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('covered', [0, 2, 6])
def test_missing_normal_order_reads_sent_gifts_and_closes_audit_tabs(covered):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'lotteon_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const run=new (Object.getPrototypeOf(async function(){}).constructor)('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
const opened=[],closed=[];let active='',sent=false,clicks=0;const covered=Number(process.argv[2]);
const tabs={open:async o=>{opened.push({id:String(opened.length),url:o.url});return 'tab '+(opened.length-1);},switch:async id=>{active=opened.find(t=>t.id===id).url;},list:async()=>opened,close:async id=>closed.push(id)};
const page={url:async()=>active,waitFor:async()=>{},click:async id=>{assert.equal(id,9);if(clicks++<covered)return 'ok; covered by div.vld-background';sent=true;return 'ok';},get:async o=>({tree:o.query==='보낸 선물'?'[9] button "보낸 선물 (99+)"':o.query==='상세보기'?'':active.includes('givenSentList')?'PAGE TEXT: 2026101112345678':'PAGE TEXT: no normal orders'})};
(async()=>{const r=await run({source_order_no:'2026101112345678'},tabs,page,async()=>{});assert.equal(sent,covered<6);assert.equal(clicks,Math.min(covered+1,6));assert.equal(r.note,covered<6?'detail button not found':'sent gift list blocked by overlay');assert.equal(closed.length,2);assert.equal(r.paid,0);})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path), str(covered)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
