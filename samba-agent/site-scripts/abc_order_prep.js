// ABC·GS 주문서 정돈 — 쿠폰 최대, 포인트 5만↑ 모두사용. 결제 안 누름.
const num = s => Number(String(s || '').replace(/[^\d]/g, '') || 0)
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
const isOrderUrl = u => /^https:\/\/(abcmart|grandstage)\.a-rt\.com\/order(?:[?#]|$)/.test(u || '')
const profile = String(args.profile || '').trim().toLowerCase().split('@')[0]
const oTab = String(args.tab || args.order_tab || '')
if (!profile && !oTab) return { ok: false, note: 'no profile' }
const exp = typeof args.expect === 'string' ? { name: args.expect } : args.expect || {}
const productOf = t => { const m = t.match(/배송 상품 (.{2,160}?) ([^\s\/]{1,20})\s*\/\s*(\d+)\s*개/); return m ? { name: m[1], option: m[2] } : null }
const GENERIC = new Set('나이키 아디다스 뉴발란스 푸마 반스 컨버스 리복 아식스 휠라 스케쳐스 크록스 머렐 NIKE ADIDAS PUMA VANS CONVERSE REEBOK ASICS FILA SKECHERS CROCS MERRELL 매장정품 정품 신발 운동화 스니커즈 남성 여성 공용 남녀공용 키즈 아동'.split(' '))
const words = s => String(s || '').split(/[\s\/()\[\],·_:-]+/).filter(w => ((/[가-힣]/.test(w) && w.length >= 2) || w.length >= 4) && !/^\d+$/.test(w) && !GENERIC.has(w.toUpperCase()))
function matches(p, extra) {
if (!exp.name && !exp.option) return true
if (!p) return false
const hay = (p.name + ' ' + extra).toLowerCase().replace(/\s+/g, '')
const sz = String(exp.option || '').match(/\d{2,3}(?:\.5)?/g) || []
if (sz.length && !sz.includes(p.option)) return false
const w = words(exp.name), n = w.filter(x => hay.includes(x.toLowerCase())).length
return !w.length || n >= Math.max(Math.min(2, w.length), w.length * 0.6)
}
const text = async sel => ((await page.get(sel ? { selector: sel } : {})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const popText = async () => (await text('#tabPopupCoupon1')).slice(0, 200)
const cbs = async () => lines(await page.get({ selector: '#tabPopupCoupon1', interactive: true }))
const waitCb = async ms => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { await focus(); if ((await cbs()).some(l => /\] combobox/.test(l))) return true } return false }
async function korName() {
let t = await popText()
if (t.trim() || !(exp.name || exp.option)) return t
const b = await page.idOf('쿠폰적용')
if (b < 0) return ''
await page.click(b)
for (let i = 0; i < 20 && !(t = await popText()).trim(); i++) await sleep(200)
return t
}
let seen = 0, tabId = null
const hit = []
for (const t of ((await tabs.list()) || []).filter(t => isOrderUrl(t.url) && (!oTab || t.id === oTab))) {
await tabs.switch(t.id)
if (profile && valOf(lines(await page.get({ selector: 'input[name=buyerEmailAddrText]' }))[0]).toLowerCase().split('@')[0] !== profile) continue
seen++
const p = productOf(await text())
if (matches(p, await korName())) hit.push({ id: t.id, product: p })
}
if (hit.length !== 1) return { ok: false, note: hit.length ? `탭 ${hit.length}개(${profile})` : seen ? 'form mismatch' : `주문서 탭 없음(${profile})` }
tabId = hit[0].id
async function focus() { try { await tabs.switch(tabId) } catch (e) {} }
const clickId = async id => { if (id == null || id < 0) return false; await focus(); await page.click(id); return true }
const findTab = async label => { await focus(); const m = String(await page.find(label)).match(new RegExp(`\\[(\\d+)\\] tab "${label}"`)); return m ? parseInt(m[1]) : -1 }
const notes = []
const LABEL = ['일반쿠폰', '플러스쿠폰']
const amounts = async () => {
await focus()
const t = await text('#tabPopupCoupon1')
const g = t.match(/일반쿠폰 .*?([\d,]+)원 플러스쿠폰/), p = t.match(/플러스쿠폰 .*?([\d,]+)원 쿠폰 할인금액/), d = t.match(/쿠폰 할인금액 ([\d,]+)원/)
return { general: g ? num(g[1]) : 0, plus: p ? num(p[1]) : 0, discount: d ? num(d[1]) : 0 }
}
let a = { general: 0, plus: 0, discount: 0 }
await focus()
if ((await cbs()).some(l => /\] combobox/.test(l)) || ((await clickId(await page.idOf('쿠폰적용'))) && (await waitCb(5000)))) {
if (await clickId(await findTab('다운로드'))) {
for (let i = 0; i < 15 && !/전체 쿠폰 다운로드/.test(await text('#tabPopupCoupon2')); i++) await sleep(200)
if (!/가능한 쿠폰이 없습니다/.test(await text('#tabPopupCoupon2'))) {
const d = lines(await page.get({ selector: '#tabPopupCoupon2', interactive: true })).find(l => /전체 쿠폰 다운로드/.test(l))
if (d && (await clickId(parseInt(d.slice(1))))) { await sleep(1000); notes.push('쿠폰 다운로드') }
}
await clickId(await findTab('쿠폰적용'))
await waitCb(3000)
}
const opts = async () => { await focus(); return lines(await page.get({ selector: '[role=listbox]', interactive: true })).filter(l => /\] option "/.test(l)) }
const open = async n => {
if ((await opts()).length) return true
const ls = await cbs()
const i = ls.findIndex(l => l.includes(`label "${LABEL[n]}"`))
const c = i < 0 ? null : ls.slice(i + 1).find(l => /\] clickable "/.test(l))
if (!c || !(await clickId(parseInt(c.slice(1))))) return false
for (let k = 0; k < 25; k++) { if ((await opts()).length) return true; await sleep(200) }
return false
}
// 같은 쿠폰 사본 여럿 — 앞에서부터 누른다
const pick = async (label, n) => {
const ls = (await opts()).filter(x => x.includes(`"${label}"`))
if (!ls.length) return false
for (const l of ls) {
await focus(); await page.clickNative(parseInt(l.slice(1)))
for (let k = 0; k < 6; k++) { await sleep(400); if (label === '적용안함' || (await amounts()).discount) return true }
if (n === undefined || !(await open(n))) break
}
return label === '적용안함'
}
let generalBest = null
for (const n of [0, 1]) {
if (!(await open(n))) continue
// 일반에 고른 쿠폰은 플러스에서 뺀다
const list = [...new Set((await opts()).map(l => l.match(/option "([^"]*)"/)[1]))].filter(o => o && o !== '적용안함' && o !== generalBest)
if (!list.length) { await pick('적용안함', n); continue }
let best = list.length === 1 ? list[0] : null, bestAmt = -1
for (const o of list.length > 1 ? list : []) {
if (!(await open(n)) || !(await pick(o, n))) continue
const x = await amounts()
const amt = n === 0 ? x.general : x.plus
if (amt > bestAmt) { bestAmt = amt; best = o }
}
if (best && (await open(n))) { await pick(best, n); notes.push(`${LABEL[n]} ${best}`); if (n === 0) generalBest = best }
if (n === 1 && generalBest) {
await sleep(500)
const x = await amounts()
if (x.general === 0 || x.plus === 0) {
if (await open(1)) await pick('적용안함', 1)
if (await open(0)) await pick(generalBest, 0)
notes.push('플러스 제외')
}
}
}
a = await amounts()
const ap = lines(await page.get({ selector: '#tabPopupCoupon1', interactive: true })).find(l => /\] button "적용하기"/.test(l))
if (ap && (await clickId(parseInt(ap.slice(1))))) await sleep(700)
try { await page.dismissOverlay() } catch (e) {}
}
const readPts = async () => {
await focus()
const b = await text()
return { bal: num((b.match(/사용가능\s*포인트\s*([\d,]+)\s*P/) || [])[1]), used: num((b.match(/포인트\s*사용\s*([\d,]+)\s*P\s*기프트카드/) || [])[1]) }
}
let pts = await readPts()
const box = async () => { await focus(); return num(valOf(lines(await page.get({ selector: 'input[placeholder*="100 단위"]' }))[0])) }
if (pts.bal >= 50000 && !pts.used) {
for (let i = 0; i < 2 && !(await box()); i++) { if (!(await clickId(await page.idOf('모두사용')))) break; await sleep(400) }
if ((await box()) && (await clickId(await page.idOf('포인트 적용')))) for (let i = 0; i < 15 && !(await readPts()).used; i++) await sleep(250)
pts = await readPts()
notes.push(pts.used ? `포인트 ${pts.used}` : '포인트 미적용')
} else if (pts.used && pts.bal + pts.used < 50000) {
return { ok: false, total: null, points_used: pts.used, note: `포인트 ${pts.used} 이미 적용(5만 미만)` }
} else notes.push(pts.used ? `포인트 ${pts.used}(이미 적용)` : `포인트 미사용(보유 ${pts.bal}P)`)
const t = await text()
const tm = t.match(/총\s*결제예정금액\s*([\d,]+)\s*원/)
if (!tm) return { ok: false, total: null, note: '결제예정금액 못 읽음' }
const total = num(tm[1])
const reward = num((t.match(/([\d,]+)\s*P\s*적립\s*예정/) || [])[1])
return { ok: total > 0 || pts.used > 0, coupon: a.general, cart_coupon: a.plus, discount: a.discount, total, points_used: pts.used, points_balance: pts.bal, reward, product: hit[0].product, order_tab: tabId, note: (notes.join(' · ') || 'no applicable coupon') + ` (${profile})` }
