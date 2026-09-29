// 29CM 스냅샷(09-26) — 옵션 → 바로 구매하기 → 주문서 상품번호 대조. 결제 없음.
const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const idOf = l => parseInt(l.slice(1))
const nameOf = l => (l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1]
const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const tree = async () => (await page.get({})).tree
const U = 'https://www.29cm.co.kr/'
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_/:().,[\]·]/g, '')
const EX = /^(보유중|자세히|더보기|로그아웃|로그인)$|닫기|툴팁|혜택|카드|적립|쿠폰|리뷰|찜|원$/
const SOLD = /\[품절\]|품절(?!임박)/, UP = /\] button "증가"/, BUY = /\] button "바로 ?구매하기"/, OUT = /\] button "(로그아웃|LOGOUT|보유중)"|보유 적립금 사용/i, CK = /\/order\/checkout/
const btn = (t, re) => lines(t).find(l => re.test(l))
const ac = args.account || args.profile || null, ck = ac || '계정'
const sku = String(args.sku || '').trim(), want = String(args.size || '').trim()
const qty = Math.max(1, parseInt(args.qty, 10) || 1)
let pno = (sku.match(/(?:catalog|products)\/(\d+)/) || [])[1] || (/^\d{5,}$/.test(sku) ? sku : null)
const base = { options: [], account: ac, coupons: { [ck]: 0 }, methods: [], cost: null, selected: null }
if (!args.profile) return { ...base, error: 'profile_required' }
const op = async u => (String(await tabs.open({ profile: args.profile, url: U + u })).match(/tab (\S+)/) || [])[1]
let tid = await op('products/' + pno)
if (!tid) return { ...base, error: 'tab_open_failed' }
await tabs.switch(tid)
const bye = async r => { await tabs.close(tid).catch(() => {}); return r }
if (!pno) return bye({ ...base, error: 'no_product', note: '상품번호 없음(상품 주소 필요)' })
const product_url = base.product_url = U + 'products/' + pno
await page.waitFor(/보유중|보유 적립금|판매 ?종료|품절된 상품/, 10000).catch(() => {}); await sleep(600)
let t = await tree(), tx = text(t)
if (!OUT.test(t)) return bye({ ...base, error: 'login_required', note: '로그인 안 됨' })
if (!btn(t, BUY)) { const b0 = btn(t, /\] button "구매하기"/); if (b0) { await page.click(parseInt(b0.slice(1))); await sleep(1800); t = await tree(); tx = text(t) } }
if (!btn(t, BUY)) {
  if (/판매 ?종료|품절된 상품|일시 ?품절|SOLD ?OUT/i.test(tx)) return bye({ ...base, sold_out: true, note: '판매종료/품절 화면' })
  return bye({ ...base, error: 'no_buy_button', note: '구매 버튼 못 읽음' })
}
const L0 = lines(t), cart = L0.findIndex(l => /\] button "장바구니 담기"/.test(l)), groups = []
for (let i = cart - 1; i >= 0 && i > cart - 25; i--) {
  const l = L0[i], n = nameOf(l)
  if (/\] link /.test(l) || /카드사별|전체보기|삼성카드|자세히|혜택|적립|구매하기"|선물하기/.test(l)) break
  if (/\] button "/.test(l) && n && !SOLD.test(n) && !EX.test(n) && !/^(감소|증가)$/.test(n)) groups.unshift({ id: idOf(l), name: n })
}
const LET = /(?<![A-Za-z])(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|FREE|ONE)(?![A-Za-z])/g
const lets = s => [...new Set(String(s).toUpperCase().replace(/프리\s*사이즈|원\s*사이즈/g, ' FREE ').match(LET) || [])].sort().join()
function pick(live, w, n) {
  const one = f => { const a = live.filter(f); return a.length === 1 ? a[0] : null }
  const nw = norm(w)
  if (!nw) return n === 1 ? live[0] : null
  let r = one(o => o.v === w) || one(o => norm(o.v) === nw) || one(o => norm(o.v).length >= 2 && (nw.includes(norm(o.v)) || norm(o.v).includes(nw)))
  for (const tk of w.split(/\s+/)) if (!r && norm(tk).length >= 2) r = one(o => o.v.split(/[-\s/]+/).map(norm).includes(norm(tk)))
  // 숫자만 같아도 색·코드 토큰(BLK0 등)이 다르면 고르지 않는다(09-27 실기: BLK0 90 주문에 BEG0 90)
  const wt = w.split(/[\s:/_,·-]+/).filter(x => /[A-Za-z가-힣]/.test(x) && norm(x).length >= 2 && !lets(x))
  const tok = o => !wt.length || wt.some(x => norm(o.v).includes(norm(x)))
  for (const d of (w.match(/\d+(?:\.\d+)?/g) || []).reverse()) if (!r && d.length >= 2) r = one(o => tok(o) && (o.v.match(/\d+(?:\.\d+)?/g) || []).includes(d))
  if (!r && lets(w) && !/\d{2,}/.test(w)) r = one(o => lets(o.v) === lets(w))
  return r || (n === 1 && live.length === 1 ? live[0] : null)
}
const chosen = []
let shown = []
for (let g = 0; g < groups.length; g++) {
  const dd = groups[g], last = g === groups.length - 1
  let opts = []
  for (let a = 0; a < 2 && !opts.length; a++) {
    const before = new Set(lines(t = await tree()).map(idOf))
    if (g === 0 || a > 0) await page.click(dd.id)
    for (let i = 0; i < 15 && !opts.length; i++) {
      await sleep(200); t = await tree()
      opts = lines(t).filter(l => /\] button "/.test(l) && !before.has(idOf(l)) && nameOf(l) && nameOf(l) !== dd.name && !EX.test(nameOf(l)))
        .map(l => { const n = nameOf(l); return { id: idOf(l), raw: n, v: n.replace(/\s*\[품절\]$/, ''), so: SOLD.test(n) } })
    }
  }
  if (!opts.length) return bye({ ...base, note: '옵션 못 읽음(' + dd.name + ', 품절 아님)' })
  const dq = (want.match(/\d{2,3}(?:\.5)?/g) || []).pop()
  const wq = want.split(/[\s:/_,·-]+/).find(x => /[A-Za-z]/.test(x) && x.length >= 3 && !lets(x))
  for (const q of [dq, wq]) if (q && !opts.some(o => norm(o.v).includes(norm(q)))) for (const l of lines(String((await page.get({ query: q })).tree))) { const n = nameOf(l); if (/\] button "/.test(l) && n && n.length < 40 && norm(n).includes(norm(q)) && !opts.some(o => o.id === idOf(l))) opts.push({ id: idOf(l), raw: n, v: n.replace(/\s*\[품절\]$/, ''), so: SOLD.test(n) }) }
  const pre = chosen.map(c => c.v).join(' ')
  shown = opts.map(x => (pre ? pre + ' ' : '') + x.raw)
  const p = pick(opts.filter(x => !x.so), want, opts.length)
  if (!p) {
    const s = pick(opts.filter(x => x.so), want, 0)
    return bye({ ...base, options: shown, note: s ? '주문 옵션 품절 표시: ' + s.raw : '옵션 불일치: ' + want + ' (' + dd.name + ')' })
  }
  await page.click(p.id)
  chosen.push(p)
  for (let i = 0; i < 15; i++) { await sleep(200); t = await tree(); if (!last || UP.test(t)) break }
}
if (groups.length && !UP.test(t)) return bye({ ...base, options: shown, note: '옵션 선택 반영 안 됨' })
const inc = btn(t, UP)
for (let i = 1; i < qty && inc; i++) { await page.click(idOf(inc)); await sleep(150) }
const buy = btn(await tree(), BUY)
if (!buy) return bye({ ...base, options: shown, error: 'no_buy_button', note: '구매 버튼 없음' })
await page.click(idOf(buy))
let url = ''
for (let i = 0; i < 40 && !CK.test(url); i++) { await sleep(250); url = await page.url() }
if (!CK.test(url)) return { ...base, options: shown, error: OUT.test(await tree()) ? 'no_checkout' : 'login_required', note: '주문서 못 감: ' + url.slice(0, 60) }
await page.waitFor(/(?:총|최종) 결제 ?금액/, 10000).catch(() => {})
for (let i = 0; i < 12; i++) { t = await tree(); tx = text(t); if (/(?:총|최종) 결제 ?금액 [\d,]+원/.test(tx)) break; await sleep(250) }
const nos = [...new Set([...t.matchAll(/\/product\/catalog\/(\d+)/g)].map(m => m[1]))]
if (nos.length !== 1 || nos[0] !== String(pno)) return { ...base, options: shown, error: 'order_form_mismatch', note: '주문서 상품번호 ' + nos.join(',') + ' ≠ ' + pno }
const pname = ((btn(t, new RegExp('\\] link "[^"]+" href=\\S*/product/catalog/' + pno)) || '').match(/link "([^"]+)"/) || [])[1] || ''
const at = pname ? tx.indexOf(pname) : -1
const om = at >= 0 ? tx.slice(at + pname.length, at + pname.length + 120).match(/^\s*(.*?)\s*\d+개/) : null
const selected = om ? om[1].replace(/\[[^\]]{1,12}\]\s*/g, ' ').replace(/\s+/g, ' ').trim() : null
const amt = re => num((tx.match(re) || [])[1]), PU = /보유 적립금 사용 -?([\d,]+)원/
const total = amt(/(?:총|최종) 결제 ?금액 ([\d,]+)원/)
const cost = total ? total + amt(/ㄴ 결제 즉시 할인 [^ㄴ]*?-([\d,]+)원/) + amt(/ㄴ 제휴카드[^ㄴ]*?-([\d,]+)원/) + amt(PU) : null
const payText = text((await page.get({ selector: 'label:has(input[type=radio])' })).tree)
const methods = ['무신사머니', '무신사페이', '토스페이', '카카오페이', '카드 결제'].filter(n => payText.includes(n))
if (/다른 결제 방법/.test(payText)) methods.push('페이코')
return {
  options: shown, account: ac, coupons: { [ck]: amt(/쿠폰 할인 금액 (?:최대 할인 적용 )?-([\d,]+)원/) }, methods, cost,
  selected: selected || (groups.length ? null : ''), points_used: PU.test(tx) ? amt(PU) : null, product_url, product_no: String(pno), product_name: pname,
  order_tab: tid, note: cost ? null : '총액 못 읽음', warning: '장바구니 옵션남음'
}
