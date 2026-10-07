const H = 'https://www.fashionplus.co.kr'
const OF = /fashionplus\.co\.kr\/order\/\d+(?:[?#]|$)/
const num = s=>parseInt(String(s||'').replace(/[^\d]/g, ''), 10)||0
const tabId = r=>(String(r).match(/tab (\S+)/)||[])[1]||null
const lines = async q=>(await page.get(q ? { selector: q } : {})).tree.split('PAGE TEXT')[0].split('\n').filter(l=>/^\[\d+\]/.test(l))
const text = async ()=>((await page.get({})).tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g, ' ')
const norm = s=>String(s||'').toLowerCase().replace(/\[품절\]/g, '').replace(/[\s/·,()_-]+/g, '')
const P = args.profile ? { profile: args.profile } : {}
const sku = String(args.sku||'').trim()
const want = String(args.size||'').trim()
const qty = Math.max(1, parseInt(args.qty, 10)||1)
if (!args.keepOrderTabs) for (const x of await tabs.list()) if (OF.test(x.url||'')) { try { await tabs.close(x.id) } catch (e) {} }
let pno = (sku.match(/goods\/detail\/(\d+)/)||[])[1]||(/^\d{6,}$/.test(sku) ? sku : null)
const url = pno ? `${H}/goods/detail/${pno}` : /^https?:/.test(sku) ? sku : `${H}/search/goods/result?searchWord=${encodeURIComponent(sku)}`
const tid = tabId(await tabs.open({ ...P, url }))
if (tid) await tabs.switch(tid)
if (!pno) {
await page.waitFor(/goods\/detail\/\d+|검색 결과/, 10000)
const m = (await lines()).map(l=>l.match(/href=\/goods\/detail\/(\d+)/)).find(Boolean)
if (!m) return { options: [], error: 'no_product', note: 'search no result', product_tab: tid }
pno = m[1]
await page.click(parseInt((await lines()).find(l=>l.includes('/goods/detail/' + pno)).slice(1)))
}
await page.waitFor('바로 구매', 10000)
const product_url = `${H}/goods/detail/${pno}`
const product_name = String(await page.title()).replace(/\s*-\s*패션플러스\s*$/, '').trim()
const base = { already_ordered: null, existing_order_no: null, coupons: {}, methods: [], cost: null, product_url, product_no: pno, product_name, selected: null, product_tab: tid }
const t0 = await text()
if (!/로그아웃/.test(t0)&&/로그인/.test(t0)) return { ...base, options: [], error: 'login_required', note: '로그인 안 됨' }
const label = s=>{
const m = String(s).match(/^(.*?)\s+\d{1,3}(?:,\d{3})+\s*원?(?:\s|$)/)
if (m&&m[1].trim()) return m[1].trim()
return String(s).replace(/\s+[\d,]+\s*원?\s*(\(\d+개\))?\s*$/, '').trim()
}
let optLines = await lines('.m__option-list li button')
for(let i=0;i<10&&!optLines.length;i++){await sleep(1000);optLines=await lines('.m__option-list li button')}
const soldIds = new Set((await lines('.m__option-list li.__option-soldout button')).map(l=>parseInt(l.slice(1))))
const seen = new Set(), opts = []
for (const l of optLines) {
const raw = (l.match(/"([^"]*)"/)||[])[1]
if (!raw) continue
const t = label(raw)
if (seen.has(t)) continue
seen.add(t)
opts.push({ id: parseInt(l.slice(1)), t, sold: soldIds.has(parseInt(l.slice(1)))||/품절/.test(raw) })
}
if (!opts.length) {
const li = ((await page.get({ selector: '.m__option-list li' })).tree.split('PAGE TEXT:')[1]||'').replace(/\s+/g, ' ').trim()
const one = li ? label(li.split(/(?<=\))\s+/)[0]) : ''
if (one) opts.push({ id: -1, t: one, sold: /품절/.test(li) })
}
const options = opts.map(o=>o.sold ? o.t + ' [품절]' : o.t)
const skip = (note, extra)=>({ ...base, options, note, ...(extra||{}) })
if (!opts.length) {
const di = t0.indexOf('상세설명')
const soldAll = di > 0&&/SOLD OUT|일시품절|판매종료/.test(t0.slice(0, di))
return skip(soldAll ? '전체 품절(SOLD OUT)' : 'no options', soldAll ? { sold_out: true, error: 'sold_out' } : {})
}
const avail = opts.filter(o=>!o.sold)
let pick = null
if (want) {
const w = norm(want)
pick = avail.find(o=>o.t===want)||avail.find(o=>norm(o.t)===w)
if (!pick) {
const wt = want.toLowerCase().split(/[\s/·,]+/).filter(Boolean)
const hits = avail.filter(o=>{ const ot = o.t.toLowerCase().split(/[\s/·,()]+/); return wt.every(x=>ot.includes(x)) })
if (hits.length===1) pick = hits[0]
}
} else if (avail.length===1) pick = avail[0]
if (!pick) return skip(avail.length ? `size not available: ${want}` : 'all options sold out')
const PLUS = '수량 더하기'
if (pick.id >= 0&&(await page.idOf(PLUS)) < 0) {
const dd = await page.idOf('옵션을 선택하세요')
if (dd >= 0) { await page.click(dd); await sleep(500) }
await page.click(pick.id)
await sleep(700)
if ((await page.idOf(PLUS)) < 0) { await page.click(pick.id); await sleep(700) }
}
for (let i = 1; i < qty; i++) { const plus = await page.idOf(PLUS); if (plus < 0) break; await page.click(plus) }
const buys = (await lines()).filter(l=>/\] button "바로 구매"/.test(l)).map(l=>parseInt(l.slice(1)))
let buy = -1
for (const b of buys) { await page.click(b); await sleep(1200); const m0 = (await page.get({})).tree.match(/^OVERLAY: "구매할 상품을 선택[^"]*" .*close ids: \[(\d+)/); if (!m0) { buy = b; break } await page.click(parseInt(m0[1])); await sleep(400) }
if (buy < 0) return skip(buys.length ? 'buy: 옵션 미선택' : 'buy button not found')
let ou = ''
let guest = false
for (let i = 0; i < 40&&!(OF.test(ou)||/login/i.test(ou)||guest); i++) { await sleep(300); ou = await page.url(); if (i % 5===4) guest = /비회원 주문하기/.test((await page.get({ selector: '[class*=mm_bom]', interactive: true })).tree.split('PAGE TEXT')[0]) }
if (guest) return { ...skip('로그인 필요(비회원)'), error: 'login_required' }
if (OF.test(ou)) await page.waitFor('총 결제 예상금액', 8000)
if (!OF.test(ou)) return { ...skip(/login/i.test(ou) ? '로그인 필요' : '주문서로 못 감: ' + ou.slice(0, 80)), error: /login/i.test(ou) ? 'login_required' : 'no_checkout' }
const tr = (await page.get({})).tree
const t = (tr.split('PAGE TEXT:')[1]||'').replace(/\s+/g, ' ')
const items = [...tr.matchAll(/link "(.*?) 옵션 (.+?) 수량 (\d+)개" href=\/goods\/detail\/(\d+)/g)]
const it = items[0]
const selected = it ? it[2].trim() : null
const order_item = it ? `${it[1]} 옵션 ${it[2]} 수량 ${it[3]} (${it[4]})` : null
const bad = items.length!==1 ? `order items ${items.length}` : it[4]!==pno ? `goods ${it[4]} != ${pno}` : norm(selected)!==norm(pick.t) ? `option ${selected} != ${pick.t}` : num(it[3])!==qty ? `qty ${it[3]} != ${qty}` : null
if (bad) return { ...skip('주문서 불일치: ' + bad), selected, order_tab: tid, error: 'order_form_mismatch' }
const cost = num((t.match(/총 결제 예상금액 \(\d+건\) ([\d,]+)/)||[])[1])||null
const reward = num((t.match(/총 예상 적립금 \+ ([\d,]+)/)||[])[1])
const points_used = num((t.match(/적립금 사용액 - ([\d,]+)/)||[])[1])
const points_balance = num((t.match(/보유 적립금 ([\d,]+)/)||[])[1])
const coupon = num((t.match(/상품 쿠폰 - ([\d,]+)/)||[])[1]) + num((t.match(/장바구니 쿠폰 - ([\d,]+)/)||[])[1])
const labeled = ['간편등록결제', '신용/체크카드', '무통장 입금 (가상계좌)', '퀵계좌이체', '내통장결제', '휴대폰', '결제대금예치제 (NICE)'].filter(m=>t.includes(m))
const icons = (await lines('input[name=radio_payment-way]')).length - labeled.length
const methods = [...labeled, ...(icons >= 4 ? ['토스페이', '네이버페이', '페이코', '카카오페이'] : icons > 0 ? ['네이버페이'] : [])]
let already_ordered = null, existing_order_no = null, note = 'dup skipped'
const t2 = tabId(await tabs.open({ ...P, url: `${H}/mypage/order` }))
if (t2) {
await tabs.switch(t2)
if (await page.waitFor(/신청일|내역이 없/, 10000)) {
const ls = await lines()
const ot = await text()
already_ordered = false; note = null
let ono = null
for (const l of ls) {
const d = l.match(/href=\/mypage\/order\/detail\/(\d+)/)
if (d) { ono = d[1]; continue }
const g = l.match(/link "(.*?) 옵션 (.+?)" href=\/goods\/detail\/(\d+)/)
if (!g||!ono||g[3]!==pno||norm(g[2])!==norm(selected)) continue
const blk = (ot.split(ono + '(신청일: ')[1]||'').split('(신청일:')[0]
const day = (blk.match(/^(\d{4}-\d\d-\d\d)/)||[])[1]
if (day&&Date.now() - new Date(day + 'T00:00:00+09:00').getTime() < 3 * 864e5&&!/취소|환불/.test(blk.slice(0, 300))) { already_ordered = true; existing_order_no = ono; break }
}
} else note = 'order list unreadable'
await tabs.close(t2)
}
if (tid) await tabs.switch(tid)
return { ...base, product_tab: null, options, selected, cost, qty: num(it[3]), pay_amount: cost, reward, points_used, points_balance, coupon, coupons: {}, methods, order_tab: tid, order_item, already_ordered, existing_order_no, note }