const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const code = fs.readFileSync(path.join(__dirname, '../site-scripts/checkout_enter_lotteon.js'), 'utf8');
for (const [card, issuer, expected] of [
  ['네이버페이', '현대카드', '네이버페이'],
  ['카카오페이', '현대카드', '카카오페이'],
  ['토스페이', '현대카드', '토스페이'],
  ['간편결제', '롯데카드', '간편결제'],
  ['신용카드', '현대카드', '신용카드'],
]) {
  test(`${card} / ${issuer}: 선택 수단을 카드사로 바꾸지 않는다`, async () => {
    const stop = new Error('stop before any payment');
    let selected;
    const page = {
      url: async () => 'https://www.lotteon.com/p/order/orderSheet/one/payment',
      get: async () => ({tree:'결제수단'}),
      idOf: async () => -1,
      clickText: async text => { selected=text; throw stop; },
    };
    await assert.rejects(new AsyncFunction('args','page','tabs','sleep',code)(
      {card,issuer}, page, {list:async()=>[]}, async()=>{}
    ), e=>e===stop);
    assert.equal(selected, expected);
  });
}
