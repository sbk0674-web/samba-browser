const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const code = fs.readFileSync(process.argv[2] || path.join(__dirname, '../site-scripts/musinsa_order_detail.js'), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
async function main() {
 for (const editable of [true, false]) {
  const no = '123456789012'
  const shipping = `테스트 ${editable ? '배송지 변경 ' : ''}서울 중구 시험로 47 401동 703호 010-0000-0000`
  const state = editable ? '결제 완료' : '상품 준비 중'
  const text = `주문번호 ${no} ${shipping} 주문 상품 1개 ${state} 판매자 정보 시험상품 130 / 1개 42원 결제 정보 결제 금액 42원 결제 수단 무신사머니`
  let closed = 0
  const page = {
    get: async o => ({ tree: o.interactive ? '[1] link "시험상품" href=https://www.musinsa.com/products/1234' : `PAGE TEXT:\n${text}` }),
    waitFor: async () => {}, click: async () => { throw Error('unexpected click') }
  }
  const tabs = { open: async () => 'tab test', switch: async () => {}, close: async () => { closed++ } }
  const result = await new AsyncFunction('args', 'page', 'tabs', 'sleep', code)({ source_order_no: no }, page, tabs, async () => {})
  assert.equal(result.source_order_no, no)
  assert.equal(result.shipping_text.trim(), shipping)
  assert.equal(result.shipping.name, editable ? '테스트' : null)
  assert.equal(result.shipping.address, null)
  assert.equal(result.selected, '130')
  assert.equal(result.qty, 1)
  assert.equal(result.paid, 42)
  assert.equal(result.status, state)
  assert.equal(closed, 1)
 }
  console.log('MUSINSA shipping extraction PASS')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
