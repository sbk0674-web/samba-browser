import shutil
import subprocess
from pathlib import Path

import pytest

from samba_agent.agents.source_detail import actual_cost


def test_points_only_detail_never_counts_points_as_cash():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'abc_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('args','tabs','page',fs.readFileSync(process.argv[1],'utf8'));
async function parse(methods){
 const closed=[];
 const tabs={open:async()=> 'tab audit1',switch:async()=>{},close:async id=>closed.push(id)};
 const page={waitFor:async()=>{},get:async()=>({tree:'PAGE TEXT: 2026092534404 구매확정 결제 정보 주문금액 63,100원 총 결제금액 63,100원 상시할인 0원 '+methods+' 꼭 읽어'})};
 const result=await run({source_order_no:'2026092534404'},tabs,page);
 assert.deepEqual(closed,['audit1']);return result;
}
(async()=>{
 const points=await parse('포인트 63,100 P');
 assert.equal(points.paid,0);assert.equal(points.points_used,63100);
 assert.equal(points.card,'포인트전액');
 const mixed=await parse('포인트 10,000 P 네이버페이 53,100 원');
 assert.equal(mixed.paid,53100);assert.equal(mixed.points_used,10000);
})().catch(e=>{console.error(e);process.exit(1)});
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr


def test_points_only_cost_uses_verified_reward_only():
    assert actual_cost({'paid': 0, 'points_used': 63100, 'reward': 0}) == 63100
    assert actual_cost({'paid': 0, 'points_used': 63100, 'reward': 1270}) == 61830
