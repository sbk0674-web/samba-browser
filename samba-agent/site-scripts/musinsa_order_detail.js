const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const no = nz(args.source_order_no || args.orderNo)
const R = { source_order_no: no || null, status: '', paid: 0, points_used: 0, points_total: 0, points_box: null, prepay_points: null, reward: 0, card: '', selected: null, option: null, qty: null, shipping: { name: null, address: null, address_detail: null }, recipient: null, address: null, address_detail: null, note: null }
if (!/^\d{10,}$/.test(no)) return { ...R, note: 'no order number' }
const get = async o => { for (let i = 0; i < 6; i++) { try { return (await page.get(o)).tree } catch (e) { await sleep(600) } } return '' }
const text = async () => nz((await get({})).split('PAGE TEXT:')[1])
const pf = args.profile ? { profile: args.profile } : {}
const opened = []
const open = async url => { const id = (String(await tabs.open({ ...pf, url })).match(/tab (\S+)/) || [])[1]; if (id) { opened.push(id); await tabs.switch(id) } }
const closeAll = async () => { for (const id of opened) { try { await tabs.close(id) } catch (e) {} } }
const good = t => t.includes('결제 정보') && t.includes(no)

await open('https://www.musinsa.com/order/order-detail/' + no)
try { await page.waitFor('결제 정보', 8000) } catch (e) {}
let t = await text()
if (!good(t)) {
  await open('https://www.musinsa.com/order/result/' + no)
  try { await page.waitFor('주문 상세', 8000) } catch (e) {}
  const l = (await get({ query: '주문 상세' })).split('\n').find(x => /^\[\d+\] (link|clickable|button) "주문 상세"/.test(x))
  if (l) { await page.click(parseInt(l.slice(1))); try { await page.waitFor('결제 정보', 8000) } catch (e) {} }
  t = await text()
}
if (!good(t)) { await closeAll(); return { ...R, note: 'order detail not found for ' + no } }

R.status = ((t.match(/주문 상품 \d+개\s*(결제 완료|입금 대기|상품 준비 중|배송 준비 중|배송 시작|배송 중|배송 완료|구매 확정|취소 요청|취소 완료|반품 요청|반품 처리 중|반품 완료|교환 요청|교환 완료|환불 완료|[가-힣]{2,4} ?(?:완료|대기|중|확정))/) || [])[1] || '')
const pay = t.slice(t.indexOf('결제 정보'))
R.paid = num((pay.match(/결제 금액\s*(?:\d+%\s*)?([\d,]+)\s*원/) || [])[1])

const shipStart=t.indexOf(no), shipStop=t.indexOf('주문 상품',shipStart+no.length);
if(shipStart>=0 && shipStop>shipStart) R.shipping_text=t.slice(shipStart+no.length,shipStop);
// 배송지·수취인: '주문번호 N 이름 배송지 변경 주소 … 전화번호'
try {
  const ai = t.indexOf(no)
  const bi = t.indexOf('배송지 변경', ai)
  if (ai >= 0 && bi > ai) {
    const nm = nz(t.slice(ai + no.length, bi))
    if (nm && !/\*/.test(nm)) R.shipping.name = nm
    const rest = t.slice(bi + 5)
    const pm0 = rest.match(/0\d{1,2}-[\d*]{3,4}-[\d*]{4}|\b01\d{8,9}\b/)
    const s = nz(pm0 ? rest.slice(0, pm0.index) : rest.slice(0, 120))
    R.shipping.address = null; R.shipping.address_detail = null;
    const shipEnd=t.indexOf('주문 상품',bi);
    R.shipping_text=shipEnd>bi?t.slice(ai+no.length,shipEnd):null;
    if (R.shipping.address && /\*{2,}/.test(R.shipping.address)) R.shipping.address = null
    if (R.shipping.address_detail && /\*{2,}/.test(R.shipping.address_detail)) R.shipping.address_detail = null
  }
} catch (e) {}
R.recipient = R.shipping.name; R.address = R.shipping.address; R.address_detail = R.shipping.address_detail

// 주문 상품 옵션·수량: '판매자 정보 상품명 옵션 / N개 금액원'
try {
  const links = (await get({ interactive: 1 })).split('\n')
  let pname = ''
  for (const x of links) {
    const m = x.match(/^\[\d+\] link "([^"]+)" href=\S*\/products\/\d+/)
    if (m && !/상품 ?상세로 이동|샵으로 이동/.test(m[1])) { pname = nz(m[1]); break }
  }
  const si = t.indexOf('판매자 정보', t.indexOf('주문 상품'))
  const seg = si >= 0 ? t.slice(si + 6, t.indexOf('결제 정보')) : ''
  const q = seg.match(/(?:^|\s)\/?\s*(\d+)개\s+[\d,]+원/)
  let before = q ? seg.slice(0, q.index) : ''
  if (pname && before.includes(pname)) before = before.slice(before.indexOf(pname) + pname.length)
  else if (pname) before = ''
  before = nz(before).replace(/\/\s*$/, '').replace(/^\//, '').trim()
  if (q) R.qty = parseInt(q[1], 10)
  if (before) R.selected = R.option = before
} catch (e) {}

const pm = pay.match(/적립금 사용\s*-\s?([\d,]+)\s*원/)
if (pm) {
  R.points_total = R.points_used = num(pm[1])
  const w = '-' + pm[1] + '원'
  const l = (await get({ interactive: 1 })).split('\n').find(x => /^\[\d+\]/.test(x) && x.includes('"' + w + '"'))
  if (l && !t.includes('보유 적립금 사용')) { await page.click(parseInt(l.slice(1))); await sleep(700) }
  const t2 = await text()
  const bm = t2.match(/보유 적립금 사용\s*-?\s?([\d,]+)\s*원/), sm = t2.match(/적립금 선할인\s*-?\s?([\d,]+)\s*원/)
  if (bm) R.points_box = R.points_used = num(bm[1])
  else if (sm) R.points_used = Math.max(0, R.points_total - num(sm[1]))
  else R.note = '적립금 사용 내역을 펼치지 못함 — 합계를 사용액으로 둠'
  if (sm) R.prepay_points = num(sm[1])
}

const ps = nz((pay.split('결제 수단')[1] || '').split(/이번 주문으로|받은 총 혜택|주문자 정보|배송 정보/)[0])
const cm = ps.match(/([가-힣A-Za-z0-9]+)\s*[-–]\s*([가-힣A-Za-z0-9 ]{1,12}?(?:카드|은행|계좌)(?:\s*\([^)]{0,12}\))?)/)
R.card = cm ? nz(cm[1] + ' - ' + cm[2]) : nz(ps.split(/\s(?:무신사머니 최대|최대 \d|첫 결제|무신사 삼성카드 결제 혜택|결제 혜택)/)[0]).split(' ').filter((x, i, a) => x !== a[i - 1]).join(' ').slice(0, 40)

const s0 = t.indexOf('받은 혜택'), s1 = t.indexOf('받은 총 혜택')
const seg = s0 >= 0 ? t.slice(s0, s1 > s0 ? s1 : s0 + 600) : ''
const items = seg.split(/원\s*/).map(x => x.match(/(\S[^]*?적립)\s*(?:최대\s*)?([\d,]+)$/)).filter(Boolean).map(m => ({ name: nz(m[1]).split(' 원 ').pop(), v: num(m[2]) })).filter(x => !/후기|리뷰|스냅/.test(x.name))
const skip = new Set()
items.forEach((it, i) => {
  if (skip.has(i)) return
  for (let k = 2; k <= 4; k++) {
    const sub = items.slice(i + 1, i + 1 + k)
    if (sub.length === k && it.v > 0 && sub.reduce((a, b) => a + b.v, 0) === it.v) { for (let j = 1; j <= k; j++) skip.add(i + j); break }
  }
})
R.reward = items.filter((_, i) => !skip.has(i)).reduce((a, b) => a + b.v, 0)
await closeAll()
return R