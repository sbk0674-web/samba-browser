import shutil
import subprocess
from pathlib import Path

import pytest


def test_plain_credit_card_issuer_is_read_only_from_payment_history():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js required')
    path = Path(__file__).parents[1] / 'site-scripts' / 'ssg_order_detail.js'
    code = r"""
const fs=require('fs'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const body=s.slice(s.indexOf('const cm ='),s.indexOf('const ben ='));
const run=new Function('hist','R','nz',body+';return R.card;');
const read=hist=>run(hist,{paid:10355},s=>s.replace(/\s+/g,' ').trim());
assert.equal(read('신용카드 현대카드 일시불 10,355원'),'신용카드 - 현대카드');
assert.equal(read('신용카드 현대카드 롯데카드 10,355원'),'');
assert.equal(read('신용카드 일시불 10,355원'),'');
assert.equal(read('SSGPAY-신용카드 50,400원 현대카드'),'SSGPAY-신용카드 - 현대카드');
"""
    result = subprocess.run([node, '-e', code, str(path)], capture_output=True, text=True, encoding='utf-8')
    assert result.returncode == 0, result.stderr
