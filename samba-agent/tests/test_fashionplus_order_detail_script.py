import shutil
import subprocess
from pathlib import Path

import pytest


def test_delivery_link_does_not_hide_order_status():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'fashionplus_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('args','tabs','page','sleep',fs.readFileSync(process.argv[1],'utf8'));
async function parse(status){
 const closed=[];
 const tabs={open:async()=> 'tab audit1',switch:async()=>{},close:async id=>closed.push(id)};
 const tree='[70] link "슬링백 옵션 CHA XXX" href=/goods/detail/416254437\nPAGE TEXT: 주문 상세 141908330 (신청일: 2026-09-23) 옵션 CHA XXX '+status+' 1개 결제수단 정보 결제수단 네이버 페이 결제승인일 2026-09-23 결제금액 66,550원';
 const page={url:async()=> 'https://www.fashionplus.co.kr/mypage/order/detail/141908330',waitFor:async()=>true,get:async()=>({tree})};
 const result=await run({source_order_no:'141908330'},tabs,page,async()=>{});
 assert.deepEqual(closed,['audit1']);assert.equal(result.product_no,'416254437');
 assert.equal(result.option,'CHA XXX');assert.equal(result.paid,66550);return result;
}
(async()=>{
 assert.equal((await parse('배송완료 배송조회')).status,'배송완료');
 assert.equal((await parse('배송완료')).status,'배송완료');
 assert.equal((await parse('입금대기')).status,'입금대기');
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr
