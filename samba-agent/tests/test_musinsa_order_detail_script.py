import shutil
import subprocess
from pathlib import Path

import pytest


def test_return_processing_is_not_return_or_refund_complete():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'musinsa_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const line=fs.readFileSync(process.argv[1],'utf8').split('\n').find(x=>x.startsWith('R.status ='));
const parse=new Function('t','const R={};'+line+';return R.status;');
assert.equal(parse('주문 상품 1개 반품 처리 중 판매자 확인 후 처리 예정 Urban Muse Tee White S 결제 정보'),'반품 처리 중');
assert.equal(parse('주문 상품 1개 배송 완료 티셔츠 반품 요청 결제 정보'),'배송 완료');
assert.equal(parse('주문 상품 1개 배송 시작 10.14(수) 이내 도착 예정 팬츠 결제 정보'),'배송 시작');
assert.equal(parse('주문 상품 1개 구매 확정 티셔츠 결제 정보'),'구매 확정');
assert.equal(parse('주문 상품 1개 반품 완료 티셔츠 결제 정보'),'반품 완료');
assert.equal(parse('주문 상품 1개 환불 완료 티셔츠 결제 정보'),'환불 완료');
assert.equal(parse('주문 상품 1개 티셔츠 결제 정보 반품 처리 중'),'');
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr
