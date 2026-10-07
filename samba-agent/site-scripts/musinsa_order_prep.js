// 무신사 주문서 정돈(2026-09-26 재작성, 플레이북 §6·§7): 상품 쿠폰 최대 → 장바구니 쿠폰 최대 → 적립금(보유 5만 미만 0원, 이상 한도까지, 제한 상품 0원) → 선할인.
// 주문서 탭은 '가장 최근 것'으로 고르지 않는다: args.tab, 없으면 레인에 하나뿐인 무신사 주문서. 여럿이면 멈춘다(197←196 사고).
// 즉시 할인(카드사·간편결제 전용 쿠폰)은 결제수단에 묶여 있어 여기서 켜지 않는다 — 결제수단 견적이 따로 본다.
// 반환 {ok,total,coupon,cart_coupon,points_balance,points_used,points_box,points_limit,prepay,discount,coupon_button,instant_discount,reward,profile,note}
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

// 0) 주문서 탭
const ofs = (await tabs.list()).filter(t => OF.test(t.url || ''))
const tab = args.tab ? ofs.find(t => t.id === args.tab) : ofs.length === 1 ? ofs[0] : null
if (!tab) return done(ofs.length ? `order forms ${ofs.length} open — pass args.tab` : 'no order-form tab found')
await tabs.switch(tab.id)
await safe(() => page.waitFor('총 결제 금액', 8000))

// 1) 상품 쿠폰: '쿠폰 사용|변경|적용 중' 옆 clickable 을 눌러 시트를 연다(버튼 자체는 글자에 가려 안 눌린다)
let t = await get({ interactive: 1 })
// 누를 자리(clickable)가 버튼 바로 다음 줄이 아닐 때가 있다 — 글자가 같은 clickable 을 어디서든 찾는다(2026-10-01)
const cb = idOf(t, /^\[\d+\] button "쿠폰 (?:사용|변경|적용 중)"\n\[(\d+)\] clickable/m)
  || idOf(t, /^\[(\d+)\] clickable "쿠폰 (?:사용|변경|적용 중)"/m)
if (!cb && /^\[\d+\] button "쿠폰 (?:사용|변경|적용 중)"/m.test(t)) notes.push('coupon button found but not clickable')
if (cb) {
  await page.click(cb)
  // '적용하기' 글자는 시트가 그려지기 전에도 DOM 에 있다 — 쿠폰 radio 가 보일 때까지 기다린다(2026-10-01 쿠폰 누락 사고)
  let rs = []
  for (let i = 0; i < 12 && !rs.length; i++) {
    await sleep(500)
    t = await get({ interactive: 1 })
    // 쿠폰이 많으면 전체 요소 목록에서 시트 안 radio 가 잘린다 — 글자 조회('원 할인')도 함께 본다(2026-10-01)
    const tq = await get({ query: '원 할인' })
    rs = [...(t + '\n' + tq).matchAll(/^\[(\d+)\] radio "([\d,]+)원 할인/gm)].map(m => ({ id: +m[1], v: num(m[2]) })).sort((a, b) => b.v - a.v)
  }
  const opened = rs.length > 0 || /적용하기/.test(t)
  // '적용하기' 버튼은 interactive 목록에 안 나올 때가 있다 — page.idOf 로도 찾는다
  let ap = idOf(t, /^\[(\d+)\] button "적용하기"/m)
  if (!ap) { const k = await safe(() => page.idOf('적용하기', 0)); if (typeof k === 'number' && k >= 0) ap = k }
  if (rs[0] && ap) {
    await page.click(rs[0].id)
    await sleep(300)
    await page.click(ap)
    await safe(() => page.waitFor(/쿠폰 (적용 중|변경)/, 5000))
    // 적용 확인: 쿠폰 버튼이 '적용 중·변경'으로 바뀌어야 보고한다(못 보면 0 + note)
    if (/^\[\d+\] button "쿠폰 (?:적용 중|변경)"/m.test(await get({ interactive: 1 }))) out.coupon = rs[0].v
    else notes.push('coupon apply not confirmed')
  } else {
    notes.push(opened ? 'no coupon in sheet' : 'coupon sheet not opened (쿠폰 적용 불가 상품)')
    if (opened) await safe(() => page.dismissOverlay())
  }
}

// 2) 장바구니 쿠폰: textbox '쿠폰을 선택해주세요'(쿠폰이 없으면 '사용 가능한 쿠폰 없음')
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
  const m = (await txt()).match(/장바구니 쿠폰\s*-\s?([\d,]+)\s*원/)
  out.cart_coupon = m ? num(m[1]) : 0
}

// 3) 적립금: '적용 한도(7%) N원 / 보유 M원', textbox '보유 적립금 사용' value(제한 상품이면 '적립금 사용 제한 상품')
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
// 보유액을 못 읽으면 적립금을 건드리지 않는다(5만 이상 계정에서 조용히 빼지 않게)
if (p.bal == null && !p.locked) notes.push('points balance not read — untouched')
else if (p.used !== target) {
  const btn = idOf(p.tr, target ? /^\[(\d+)\] button "(?:최대 사용|모두 사용|전액 사용)"/m : /^\[(\d+)\] button "사용 취소"/m)
  if (btn) { await page.click(btn); await sleep(800); p = await pts() }
  if (p.used !== target && p.box) { await safe(() => page.type(p.box, String(target))); await sleep(800); p = await pts() }
  if (p.used !== target) notes.push(`points ${p.used} != target ${target}`)
}
out.points_used = out.points_box = p.used
out.points_limit = p.limit

// 4) 선할인: 제한 상품이 아니면 '적립금 선할인'을 켠다(총액이 줄거나 같아야 켜진 것으로 본다)
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

// 5) 결과: 화면 값
tx = await txt()
out.total = totalOf(tx)
out.discount = num((tx.match(/할인 금액\s*-\s?([\d,]+)\s*원/) || [])[1]) || 0
out.coupon_button = ((await get({ interactive: 1 })).match(/^\[\d+\] button "(쿠폰 (?:사용|변경|적용 중))"/m) || [])[1] || null
// 적립: 후기 적립 제외 합계(포인트 전액 결제일 때만 하네스가 쓴다)
const tot = num((tx.match(/총 적립 금액\s*([\d,]+)\s*원/) || [])[1]), rev = num((tx.match(/후기 적립\s*최대\s*([\d,]+)\s*원/) || [])[1])
out.reward = Math.max(tot - rev, 0)
out.ok = out.total != null
return done(out.ok ? null : '총 결제 금액을 읽지 못함')
