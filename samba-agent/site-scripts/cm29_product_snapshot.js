const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const idOf = l => parseInt(l.slice(1))
const nameOf = l => (l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1]
const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const tree = async () => (await page.get({})).tree
const U = 'https://www.29cm.co.kr/'
const num = s => parseInt(String(s || '').replace(/\D/g, ''), 10) || 0
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_/:().,[\]·]/g, '')
const EX = /^(보유중|자세히|더보기|로그아웃|로그인)$|닫기|툴팁|혜택|카드|적립|쿠폰|리뷰|찜|원$/
const SOLD = /\[품절\]|품절(?!임박)/, UP = /\] button "증가"/, BUY = /\] button "바로 ?구매하기"/, OUT = /\] button "(로그아웃|보유중)"|보유 적립금 사용/i, CK = /\/order\/checkout/
const btn = (t, re) => lines(t).find(l => re.test(l))
const ac = args.account || args.profile || null, ck = ac || '계정'
const sku = String(args.sku || '').trim(), want = String(args.size || '').trim()
const qty = parseInt(args.qty) || 1
let pno = (sku.match(/(?:catalog|products)\/(\d+)/) || [])[1] || (/^\d{5,}$/.test(sku) ? sku : null)
const base = { options: [], account: ac, coupons: { [ck]: 0 }, methods: [], cost: null, selected: null }
if (!args.profile) return {...base, error: 'profile_required' }
const tid = (String(await tabs.open({ profile: args.profile, url: U + 'products/' + pno })).match(/tab (\S+)/) || [])[1]
await tabs.switch(tid)
const bye = async r => { await tabs.close(tid).catch(() => {}); return r }
if (!pno) return bye({...base, error: 'no_product' })
let product_url = base.product_url = U + 'products/' + pno
await page.waitFor(/보유중|보유 적립금|판매 ?종료|품절된 상품/, 10000).catch(() => {})
let t = await tree(), tx = text(t)
if (!OUT.test(t)) return bye({...base, error: 'login_required' })
const ob = async () => { const b0 = !btn(t, BUY) && btn(t, /\] button "구매하기"/); if (b0) { await page.click(idOf(b0)); await sleep(1800); t = await tree(); tx = text(t) } }
await ob()
if (!btn(t, BUY)) {
if (/판매 ?종료|품절된 상품/.test(tx)) return bye({...base, sold_out: true })
return bye({...base, error: 'no_buy_button' })
}
const L0 = lines(t), cart = L0.findIndex(l => /\] button "장바구니 담기"/.test(l)), gs = []
for (let i = cart - 1; i >= 0 && i > cart - 25; i--) {
const l = L0[i], n = nameOf(l)
if (/\] link /.test(l) || /카드사별|전체보기|삼성카드|자세히|혜택|적립|구매하기"|선물하기/.test(l)) break
if (/\] button "/.test(l) && n && !SOLD.test(n) && !EX.test(n) && !/^(감소|증가)$/.test(n)) gs.unshift({ id: idOf(l), name: n })
}
const LET = /(?<![A-Za-z])(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|FREE|ONE)(?![A-Za-z])/g
const lets = s => [...new Set(String(s).toUpperCase().replace(/프리\s*사이즈|원\s*사이즈/g, ' FREE ').match(LET) || [])].sort().join()
const CM = { 화이트: 'white', 블랙: 'black' }
const canon = s => { let x = String(s); for (const k in CM) x = x.split(k).join(CM[k] + ' '); return x.replace(/(?<![A-Za-z])(SM|MD|LG)(?![A-Za-z])/gi, m => m[0]) }
const CODE = /\d[A-Za-z]+\d|[A-Za-z]+\d+[A-Za-z]+\d/
const noCode = s => String(s).split(/\s+/).filter(x => !CODE.test(x)).join(' ')
function pick(lv, w, n) {
lv = lv.map(o => ({ ...o, c: canon(o.v) })); w = canon(w)
const one = f => { const a = lv.filter(f); return a.length === 1 ? a[0] : null }
const nw = norm(w), w2 = noCode(w)
if (!nw) return n === 1 ? lv[0] : null
let r = one(o => o.c === w) || one(o => norm(o.c) === nw) || one(o => norm(o.c).length >= 2 && (nw.includes(norm(o.c)) || norm(o.c).includes(nw)))
for (const tk of w.split(/\s+/)) if (!r && norm(tk).length >= 2) r = one(o => o.c.split(/[-\s/]+/).map(norm).includes(norm(tk)))
const wt = w.split(/[\s:/_,·-]+/).filter(x => /[A-Za-z가-힣]/.test(x) && norm(x).length >= 2 && !lets(x) && !CODE.test(x))
const aT = lv.some(o => wt.some(x => norm(o.c).includes(norm(x))))
const tok = o => !wt.length || !aT || wt.some(x => norm(o.c).includes(norm(x)))
for (const d of (w2.match(/\d+(?:\.\d+)?/g) || []).reverse()) if (!r && d.length >= 2) r = one(o => tok(o) && (o.c.match(/\d+(?:\.\d+)?/g) || []).includes(d))
if (!r && lets(w2) && !/\d{2,}/.test(w2)) r = one(o => lets(o.c) === lets(w2))
return r || (n === 1 && lv.length === 1 ? lv[0] : null)
}
const mk = l => { const n = nameOf(l); return { id: idOf(l), raw: n, v: n.replace(/\s*\[품절\]$/, ''), so: SOLD.test(n) } }
const ch = []
let sh = [], mv = null
for (let g = 0; g < gs.length; g++) {
const dd = gs[g], last = g === gs.length - 1
let opts = []
for (let a = 0; a < 2 && !opts.length; a++) {
const bf = new Set(lines(t = await tree()).map(idOf))
if (g === 0 || a > 0) await page.click(dd.id)
for (let i = 0; i < 15 && !opts.length; i++) {
await sleep(200); t = await tree()
opts = lines(t).filter(l => /\] button "/.test(l) && !bf.has(idOf(l)) && nameOf(l) && nameOf(l) !== dd.name && !EX.test(nameOf(l)))
.map(mk)
}
}
if (!opts.length) return bye({...base, note: '옵션 없음' })
const dq = (noCode(want).match(/\d{2,3}(?:\.5)?/g) || []).pop()
if (dq && !opts.some(o => norm(o.v).includes(dq))) for (const l of lines(String((await page.get({ query: dq })).tree))) { const n = nameOf(l); if (/\] button "/.test(l) && n && norm(n).includes(dq) && !opts.some(o => o.id === idOf(l))) opts.push(mk(l)) }
const pre = ch.map(c => c.v).join(' ')
sh = opts.map(x => (pre ? pre + ' ' : '') + x.raw)
const p = pick(opts.filter(x => !x.so), want, opts.length)
if (!p) {
const s = pick(opts.filter(x => x.so), want, 0)
return bye({...base, options: sh, note: s ? '품절: ' + s.raw : '옵션 불일치: ' + want })
}
await page.click(p.id)
ch.push(p)
for (let i = 0; i < 15 && !mv; i++) { await sleep(200); const m = ((await page.url()).match(/products\/(\d+)/) || [])[1]; if (m && m != pno) mv = m; else { t = await tree(); if (!last || UP.test(t)) break } }
if (mv) break
}
if (mv) { pno = mv; product_url = base.product_url = U + 'products/' + pno; await page.waitFor(/구매하기/, 10000).catch(() => {}); t = await tree(); await ob() }
if (gs.length && !UP.test(t)) return bye({...base, options: sh, note: '선택 미반영' })
const inc = btn(t, UP)
for (let i = 1; i < qty && inc; i++) { await page.click(idOf(inc)); await sleep(150) }
const buy = btn(await tree(), BUY)
if (!buy) return bye({...base, options: sh, error: 'no_buy_button' })
await page.click(idOf(buy))
let url = ''
for (let i = 0; i < 40 && !CK.test(url); i++) { await sleep(250); url = await page.url() }
if (!CK.test(url)) return {...base, options: sh, error: 'no_checkout' }
await page.waitFor(/(?:총|최종) 결제 ?금액/, 10000).catch(() => {})
for (let i = 0; i < 12; i++) { t = await tree(); tx = text(t); if (/(?:총|최종) 결제 ?금액 [\d,]+원/.test(tx)) break; await sleep(250) }
const nos = [...new Set([...t.matchAll(/\/product\/catalog\/(\d+)/g)].map(m => m[1]))]
if (nos.length !== 1 || nos[0] != pno) return {...base, options: sh, error: 'order_form_mismatch' }
const pn = ((btn(t, new RegExp('\\] link "[^"]+" href=\\S*/product/catalog/' + pno)) || '').match(/link "([^"]+)"/) || [])[1] || ''
const at = pn ? tx.indexOf(pn) : -1
const om = at >= 0 ? tx.slice(at + pn.length, at + pn.length + 120).match(/^\s*(.*?)\s*(\d+)개/) : null
let selected = om ? om[1].replace(/\[[^\]]{1,12}\]\s*/g, ' ').replace(/\s+/g, ' ').trim() : null
if (selected) { selected = canon(selected); for (const k in CM) selected = selected.replace(new RegExp(CM[k], 'i'), k) }
const amt = re => num((tx.match(re) || [])[1]), PU = /보유 적립금 사용 -?([\d,]+)원/
const total = amt(/(?:총|최종) 결제 ?금액 ([\d,]+)원/)
const cost = total ? total + amt(/ㄴ 결제 즉시 할인 [^ㄴ]*?-([\d,]+)원/) + amt(/ㄴ 제휴카드[^ㄴ]*?-([\d,]+)원/) + amt(PU) : null
const pt = text((await page.get({ selector: 'label:has(input[type=radio])' })).tree)
const methods = ['무신사머니', '무신사페이', '토스페이', '카카오페이', '카드 결제'].filter(n => pt.includes(n))
if (/다른 결제 방법/.test(pt)) methods.push('페이코')
return {
options: sh, account: ac, coupons: { [ck]: amt(/쿠폰 할인 금액 (?:최대 할인 적용 )?-([\d,]+)원/) }, methods, cost,
selected: selected || (gs.length ? null : ''), qty: om ? +om[2] : null, product_url,
order_tab: tid, note: cost ? null : '총액 없음'
}