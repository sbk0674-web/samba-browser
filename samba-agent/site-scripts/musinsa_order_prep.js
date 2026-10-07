const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /musinsa\.com\/order\/order-form/
const out = { ok: false, total: null, coupon: 0, cart_coupon: 0, points_balance: null, points_used: 0, points_box: null, points_limit: null, prepay: false, discount: null, coupon_button: null, instant_discount: 0, reward: 0, profile: args.profile || null, note: null }
const notes = []
const done = n => { if (n) notes.push(n); out.note = notes.join('; ') || null; return out }
const safe = async f => { try { return await f() } catch (e) {} }
const get = async o => { for (let i = 0; i < 6; i++) { try { return (await page.get(o)).tree } catch (e) { await sleep(600) } } return '' }
const txt = async () => nz((await get({})).split('PAGE TEXT:')[1])
const idOf = (t, re) => +((t.match(re) || [])[1] || 0)
const totalOf = t => num((t.match(/총 결제 금액\s*(?:\d+%\s*)?([\d,]+)\s*원/) || [])[1]) || null

let ofs = (await tabs.list()).filter(t => OF.test(t.url || ''))
if (args.profile && ofs.some(t => t.profile === args.profile)) ofs = ofs.filter(t => t.profile === args.profile || !t.profile)
let tab = args.tab ? ofs.find(t => t.id === args.tab) : ofs.length === 1 ? ofs[0] : null
if (!tab && !args.tab && ofs.length > 1) {
  // 같은 프로필 주문서 탭이 여럿이면 활성 탭, 없으면 마지막 탭 사용
  tab = ofs.find(t => t.active) || ofs[ofs.length - 1]
  notes.push(`order forms ${ofs.length} open — using ${tab.active ? 'active' : 'last'}`)
}
if (!tab) return done(ofs.length ? `order forms ${ofs.length} open — pass args.tab` : 'no order-form tab found')
await tabs.switch(tab.id)
await safe(() => page.waitFor('총 결제 금액', 8000))

let t = await get({ interactive: 1 })
const cb = idOf(t, /^\[\d+\] button "쿠폰 (?:사용|변경|적용 중)"\n\[(\d+)\] clickable/m)
  || idOf(t, /^\[(\d+)\] clickable "쿠폰 (?:사용|변경|적용 중)"/m)
if (!cb && /^\[\d+\] button "쿠폰 (?:사용|변경|적용 중)"/m.test(t)) notes.push('coupon button found but not clickable')
if (cb) {
  await page.click(cb)
  let rs = []
  for (let i = 0; i < 12 && !rs.length; i++) {
    await sleep(500)
    t = await get({ interactive: 1 })
    const tq = await get({ query: '원 할인' })
    rs = [...(t + '\n' + tq).matchAll(/^\[(\d+)\] radio "([\d,]+)원 할인/gm)].map(m => ({ id: +m[1], v: num(m[2]) })).sort((a, b) => b.v - a.v)
  }
  const opened = rs.length > 0 || /적용하기/.test(t)
  let ap = idOf(t, /^\[(\d+)\] button "적용하기"/m)
  if (!ap) { const k = await safe(() => page.idOf('적용하기', 0)); if (typeof k === 'number' && k >= 0) ap = k }
  if (rs[0] && ap) {
    await page.click(rs[0].id)
    await sleep(300)
    await page.click(ap)
    await safe(() => page.waitFor(/쿠폰 (적용 중|변경)/, 5000))
    if (/^\[\d+\] button "쿠폰 (?:적용 중|변경)"/m.test(await get({ interactive: 1 }))) out.coupon = rs[0].v
    else notes.push('coupon apply not confirmed')
  } else {
    notes.push(opened ? 'no coupon in sheet' : 'coupon sheet not opened (쿠폰 적용 불가 상품)')
    if (opened) await safe(() => page.dismissOverlay())
  }
}

t = await get({ interactive: 1 })
const ct = t.match(/^\[(\d+)\] textbox "쿠폰을 선택해주세요" value="([^"]*)"/m)
if (ct && !ct[2]) {
  await page.click(+ct[1])
  await safe(() => page.waitFor('할인 적용', 3000))
  t = await get({ interactive: 1 })
  const rs = [...t.matchAll(/^\[(\d+)\] radio "[^"]*?([\d,]+)원 할인 적용"/gm)].map(m => ({ id: +m[1], v: num(m[2]) })).sort((a, b) => b.v - a.v)
  if (rs[0]) {
    await page.click(rs[0].id)
    await sleep(300)
    const ok = idOf(await get({ interactive: 1 }), /^\[(\d+)\] button "(?:확인|적용하기)"/m)
    if (ok) { await page.click(ok); await safe(() => page.waitFor('총 결제 금액', 5000)) }
  } else await safe(() => page.dismissOverlay())
}
{
  const m = (await txt()).match(/장바구니 쿠폰\s*(?:할인 금액\s*)?-\s?([\d,]+)\s*원/)
  out.cart_coupon = m ? num(m[1]) : 0
}

const pts = async () => {
  const tr = await get({ interactive: 1 }), tx = nz(tr.split('PAGE TEXT:')[1]) || (await txt())
  const box = tr.match(/^\[(\d+)\] textbox "보유 적립금 사용" value="([^"]*)"/m)
  const lm = tx.match(/적용 한도\([^)]*\)\s*([\d,]+)원\s*\/\s*보유\s*([\d,]+)원/)
  return { tr, box: box ? +box[1] : 0, used: box && /^[\d,]+$/.test(box[2]) ? num(box[2]) : 0, locked: !!box && /제한/.test(box[2]), limit: lm ? num(lm[1]) : null, bal: lm ? num(lm[2]) : null }
}
let p = await pts()
out.points_balance = p.bal
const target = p.locked || p.bal == null || p.bal < 50000 ? 0 : (p.limit || 0)
if (p.locked) notes.push('적립금 사용 제한 상품')
if (p.bal == null && !p.locked) notes.push('points balance not read — untouched')
else if (p.used !== target) {
  const btn = idOf(p.tr, target ? /^\[(\d+)\] button "(?:최대 사용|모두 사용|전액 사용)"/m : /^\[(\d+)\] button "사용 취소"/m)
  if (btn) { await page.click(btn); await sleep(800); p = await pts() }
  if (p.used !== target && p.box) { await safe(() => page.type(p.box, String(target))); await sleep(800); p = await pts() }
  if (p.used !== target) notes.push(`points ${p.used} != target ${target}`)
}
out.points_used = out.points_box = p.used
out.points_limit = p.limit

let tx = await txt()
if (/선할인 제한 상품/.test(tx)) notes.push('선할인 제한 상품')
else {
  const r = idOf(await get({ interactive: 1 }), /^\[(\d+)\] radio "적립금 선할인"/m)
  if (r) {
    const b = totalOf(tx)
    await page.click(r)
    await sleep(900)
    tx = await txt()
    const a = totalOf(tx)
    out.prepay = !!(b && a && a <= b)
  }
}

tx = await txt()
out.total = totalOf(tx)
const dm = tx.match(/상품 금액\s*[\d,]+\s*원\s*할인 금액\s*-\s?([\d,]+)\s*원/) || tx.match(/할인 금액\s*-\s?([\d,]+)\s*원(?![\s\S]*할인 금액\s*-)/)
out.discount = num((dm || [])[1]) || 0
out.coupon_button = ((await get({ interactive: 1 })).match(/^\[\d+\] button "(쿠폰 (?:사용|변경|적용 중))"/m) || [])[1] || null
const tot = num((tx.match(/총 적립 금액\s*([\d,]+)\s*원/) || [])[1]), rev = num((tx.match(/후기 적립\s*최대\s*([\d,]+)\s*원/) || [])[1])
out.reward = Math.max(tot - rev, 0)
out.ok = out.total != null
return done(out.ok ? null : '총 결제 금액을 읽지 못함')