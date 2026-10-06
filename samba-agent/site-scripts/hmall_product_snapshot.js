// H몰 상품 스냅샷(2026-09-27): 다나와 이동 링크(entry_url)로 들어가 사이즈를 고르고 바로구매로 주문서까지. 결제·포인트 없음.
// H몰은 다나와 경유만 — route:'direct' 가 아니면 entry_url 필수, 도착 주소에 ReferCode 가 없으면 멈춘다.
// 인자 {sku, size?, qty?, account?, profile?, route?, entry_url?, keepOrderTabs?}
// 반환 {options, selected, cost, pay_amount, normal_price, discount, reward, methods, affiliate, product_*, order_tab, note, error?}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const pf = args.profile ? { profile: args.profile } : {}
const OF = /hmall\.com\/mo\/oda\/order/
const route = args.route === 'direct' ? 'direct' : 'danawa'
const R = { options: [], methods: [], route, account: args.account || null, note: null }
const tree = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const text = async () => nz((await tree()).split('PAGE TEXT:')[1])
const els = t => t.split('PAGE TEXT')[0].split('\n').map(l => l.match(/^\[(\d+)\] (\S+)(?: "([^"]*)")?(.*)$/)).filter(Boolean).map(m => ({ id: +m[1], role: m[2], t: nz(m[3]), rest: m[4] }))
// 글자 정확 일치로만 누른다(idOf 대체 금지)
const exact = async (role, txt) => els(await tree()).filter(e => e.role === role && e.t === txt)
const want = nz(String(args.size || '').replace(/^\s*(옵션|사이즈|size)\s*[:：]\s*/i, ''))
const nm = s => nz(s).toLowerCase().replace(/[\s()·\-/,:]/g, '')
const score = o => {
  if (!want) return 0
  if (nm(o) === nm(want)) return 100
  const toks = want.split(/[\s/·,]+/).filter(Boolean)
  if (toks.some(k => nm(k) === nm(o))) return 90
  const on = o.match(/(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g) || []
  return toks.some(k => on.includes(k)) ? 70 : 0
}
const sku = String(args.sku || '').trim()
const code = (sku.match(/slitmCd=(\d+)/) || [])[1] || (/^\d{8,12}$/.test(sku) ? sku : null)
if (route === 'danawa' && !/^https:\/\/prod\.danawa\.com\/bridge\//.test(String(args.entry_url || ''))) return { ...R, error: 'no_entry', note: 'entry_url(다나와 이동 링크) 필요' }
const url0 = route === 'danawa' ? args.entry_url : (code ? 'https://www.hmall.com/md/pda/itemPtc?slitmCd=' + code : null)
if (!url0) return { ...R, error: 'bad-sku' }
if (!args.keepOrderTabs) for (const x of await tabs.list()) if (OF.test(x.url || '')) { try { await tabs.close(x.id) } catch (e) {} }
const tabId = (String(await tabs.open({ ...pf, url: url0 })).match(/tab (\S+)/) || [])[1]
if (tabId) await tabs.switch(tabId)
for (let i = 0; i < 20 && !/hmall\.com\/md\/pda\/itemPtc/.test(await page.url()); i++) await sleep(700)
await page.waitFor(/구매하기|품절|판매종료/, 10000)
R.product_url = await page.url()
R.product_no = (R.product_url.match(/slitmCd=(\d+)/) || [])[1] || code
R.affiliate = (R.product_url.match(/[?&]ReferCode=(\d+)/) || [])[1] || null
if (route === 'danawa' && !R.affiliate) return { ...R, error: 'no_affiliate', note: 'ReferCode 없음: ' + R.product_url.slice(0, 80), product_tab: tabId }
if (code && R.product_no !== code) return { ...R, error: 'wrong_product', note: R.product_no + ' != ' + code, product_tab: tabId }
R.product_name = nz(String(await page.title()).replace(/\s*-\s*현대Hmall\s*$/, '')) || null
let t = await text()
if (/로그인시 최대 혜택가/.test(t) || /cob\/loginForm/.test(R.product_url)) return { ...R, error: 'login_required', note: 'H몰 로그인 안 됨', product_tab: tabId }
if (/판매종료|일시품절/.test(t) && !(await exact('button', '구매하기')).length) return { ...R, sold_out: true, note: 'sold out (구매하기 없음)', product_tab: tabId }
// 상품 페이지 '롯데카드 5% 즉시 할인'은 누르지 않는다 — 누르면 결제수단 할인이 골라져 주문서 최대 할인이 줄었다(실측 −3,361원)
for (const b of await exact('button', '확인')) { await page.click(b.id); await sleep(500) }
// 구매하기 → 옵션 시트
let sheet = false
for (let k = 0; k < 4 && !sheet; k++) {
  const b = await exact('button', '구매하기')
  if (!b.length) break
  const id = b[b.length - 1].id
  k % 2 ? await page.clickNative(id) : await page.click(id)
  for (let i = 0; i < 6 && !sheet; i++) { await sleep(500); sheet = (await exact('button', '바로구매')).length > 0 }
}
if (!sheet) return { ...R, note: 'option sheet not opened', product_tab: tabId }
// 옵션 '285 남은수량-6' · '250 재입고 알림 신청'(= 품절)
const links = els(await tree()).filter(e => e.role === 'link' && /^\S+( 남은수량-?\d+| 재입고 알림 신청)?$/.test(e.t) && /남은수량|재입고|^\d{2,3}(\.5)?$|^[A-Z]{1,3}$|^FREE$/i.test(e.t))
const lab = e => nz(e.t.replace(/\s*(남은수량-?\d+|재입고 알림 신청)\s*$/, ''))
const sold = e => /재입고 알림 신청/.test(e.t)
R.options = links.map(e => sold(e) ? lab(e) + ' [품절]' : lab(e))
const avail = links.filter(e => !sold(e))
let pick = null
if (links.length) {
  pick = avail.map(e => ({ e, s: score(lab(e)) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s)[0]?.e || (!want && avail.length === 1 ? avail[0] : null)
  if (!pick) return { ...R, note: `size not available: ${want}`, product_tab: tabId }
  await page.click(pick.id)
  await sleep(1200)
} else if (want) return { ...R, note: 'option list not read', product_tab: tabId }
t = await text()
if (links.length && !/선택한 상품/.test(t)) return { ...R, note: 'option not selected', product_tab: tabId }
const qty = Math.max(1, parseInt(args.qty, 10) || 1)
for (let q = 1; q < qty; q++) { const p = await exact('button', '1 증가'); if (p.length === 1) { await page.click(p[0].id); await sleep(500) } }
const buy = await exact('button', '바로구매')
if (buy.length !== 1) return { ...R, note: 'buy button ' + buy.length, product_tab: tabId }
await page.click(buy[0].id)
for (let i = 0; i < 20 && !OF.test(await page.url()); i++) await sleep(700)
const ou = await page.url()
if (/cob\/loginForm/.test(ou)) return { ...R, error: 'login_required', note: 'login' }
if (!OF.test(ou)) return { ...R, error: 'no_checkout', note: '주문서로 못 감: ' + ou.slice(0, 80), product_tab: tabId }
await page.waitFor(/총 결제금액/, 10000)
await page.waitFor(/\d+P 적립/, 4000)
t = await text()
R.order_tab = tabId
const items = [...t.matchAll(/상품정보 (.+?) (\S+) \| (\d+)개 ([\d,]+)원/g)]
if (items.length !== 1) return { ...R, error: 'order_form_mismatch', note: 'order items ' + items.length }
const it = items[0]
R.selected = it[2]
if (pick && nm(R.selected) !== nm(lab(pick))) return { ...R, error: 'order_form_mismatch', note: `size ${R.selected} != ${lab(pick)}` }
if (+it[3] !== qty) return { ...R, error: 'order_form_mismatch', note: `qty ${it[3]} != ${qty}` }
R.qty = +it[3]
R.normal_price = num(it[4])
R.discount = num((t.match(/최대 할인 -([\d,]+)원/) || [])[1])
const tot = num((t.match(/총 결제금액 (?:\d+% )?([\d,]+) ?원/) || [])[1])
R.cost = R.pay_amount = tot || null
R.reward = num((t.match(/([\d,]+)P 적립/) || [])[1])
R.methods = ['카드', ...(t.includes('페이/Pay') ? ['H포인트페이', '네이버페이', '카카오페이', '토스페이', '페이코', '삼성페이', '스마일페이'] : [])]
if (!tot) R.note = 'total not found'
// 중복: 주문/배송 내역에 같은 상품명+사이즈(취소 아님). 못 읽으면 null
R.already_ordered = R.existing_order_no = null
try {
  const t2 = (String(await tabs.open({ ...pf, url: 'https://www.hmall.com/mo/mpa/selectOrdDlvCrst' })).match(/tab (\S+)/) || [])[1]
  await tabs.switch(t2)
  await page.waitFor(/주문\/배송 내역/, 8000)
  const ol = await text()
  if (/내역이 없습니다/.test(ol)) R.already_ordered = false
  else if (/주문\/배송 내역/.test(ol)) {
    const k = ol.indexOf(nz(it[1]))
    const near = k >= 0 ? ol.slice(k, k + 200) : ''
    R.already_ordered = !!near && near.includes(R.selected) && !/취소완료|취소접수/.test(near)
    if (R.already_ordered) R.existing_order_no = (ol.slice(Math.max(0, k - 200), k).match(/\d{8,}/g) || []).pop() || null
  }
  await tabs.close(t2)
  await tabs.switch(tabId)
} catch (e) {}
return R
