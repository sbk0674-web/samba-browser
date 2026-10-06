// 패션플러스 주문서에서 결제수단을 고르고 필수 동의 뒤 '주문하기'로 결제창(팝업)을 연다(실결제 진입). 2026-09-27 새 계약.
// 안전장치: 시험(dryRun·dry_run 참)은 주문하기 직전에서 멈춘다. 실결제는 expect(상품번호 또는 옵션)·amount·tab 이 없으면 누르지 않는다.
//  탭 = args.tab > expect 와 맞는 패션플러스 주문서 탭 정확히 하나(대조 근거가 없으면 탭 하나일 때만). 보이는 주문서 탭이 고른 탭과 다르면 멈춤
//  주문서 상품 줄은 하나여야 하고 상품번호·옵션(selected)·상품명 단어가 맞아야 한다. 총 결제 예상금액 > amount 면 멈춤, 누르기 직전 재대조
// args: card(네이버페이·페이코·포인트전액), profile, dryRun, expect{name,option,selected,product_no}, amount, tab
// 반환 {ok,method,popup_url,dry?,total,order_tab,order_item,note}
const OF = /fashionplus\.co\.kr\/order\/\d+(?:[?#]|$)/
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const lines = async q => (await page.get(q ? { selector: q } : {})).tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const card = String(args.card || '')
const R = { ok: false, method: card || null, popup_url: null }
const fail = (note, x) => ({ ...R, note, ...(x || {}) })
const on = v => v != null && v !== false && !/^(false|0|no|)$/i.test(String(v).trim())
const dry = on(args.dryRun) || on(args.dry_run)
const norm = s => String(s || '').toLowerCase().replace(/[\s/·,()_-]+/g, '')
const GEN = new Set('매장정품 정품 남성 여성 남녀공용 공용 키즈 블랙 화이트 BLACK WHITE'.split(' '))
let e = args.expect
e = typeof e === 'string' ? { name: e } : e && typeof e === 'object' ? e : {}
const pno = String(e.product_no || '')
const opt = String(e.selected || e.option || '').trim()
const words = String(e.name || '').split(/[\s/()[\],·_:-]+/).filter(w => w && !/^\d+$/.test(w) && !GEN.has(w.toUpperCase()) && ((/[가-힣]/.test(w) && w.length >= 2) || w.length >= 4))
const hasE = !!(pno || opt)
const amount = Math.round(Number(args.amount) || 0)
if (!dry && !hasE) return fail('no expect', { why: 'need product_no or option' })
if (!dry && !(amount > 0)) return fail('no amount')
if (!dry && !args.tab) return fail('no tab')

async function formInfo() {
  const tr = (await page.get({})).tree
  const tx = (tr.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
  const items = [...tr.matchAll(/link "(.*?) 옵션 (.+?) 수량 (\d+)개" href=\/goods\/detail\/(\d+)/g)].map(m => ({ name: m[1], option: m[2].trim(), qty: num(m[3]), code: m[4] }))
  return { tx, items, total: num((tx.match(/총 결제 예상금액 \(\d+건\) ([\d,]+)/) || [])[1]), item: items.map(i => `${i.name} 옵션 ${i.option} (${i.code})`).join(' / ') }
}
function mismatch(f) {
  if (f.items.length !== 1) return `order items ${f.items.length}`
  const it = f.items[0]
  if (pno && it.code !== pno) return `goods ${it.code} != ${pno}`
  if (opt && norm(it.option) !== norm(opt) && !norm(it.option).includes(norm(opt))) return `option ${it.option} != ${opt}`
  if (words.length && !words.some(w => norm(it.name).includes(norm(w)))) return `name ${words.slice(0, 4)} not in ${it.name}`
  return null
}
const act = (await tabs.list()).find(t => t.active)
let c = (await tabs.list()).filter(t => OF.test(t.url || '') && (!args.tab || t.id === args.tab))
if (!c.length) return fail('no order tab')
if (!hasE && c.length > 1) return fail('order form ambiguous', { why: `${c.length} order tabs, no expect` })
const ok = []
let why = null
for (const x of c) {
  await tabs.switch(x.id)
  await page.waitFor('총 결제 예상금액', 8000)
  const f = await formInfo(), m = mismatch(f)
  if (m) why = m; else ok.push({ id: x.id, ...f })
}
if (ok.length !== 1) return fail(ok.length ? 'order form ambiguous' : 'order form mismatch', { why })
const F = ok[0]
await tabs.switch(F.id)
if (act && OF.test(act.url || '') && act.id !== F.id) return fail('order form mismatch', { why: 'active order tab is not the matched one' })
Object.assign(R, { order_tab: F.id, order_item: F.item, total: F.total })
const pointsOnly = card === '포인트전액'
if (pointsOnly ? F.total !== 0 : !(F.total > 0)) return fail(`total ${F.total} (card ${card})`)
if (amount > 0 && F.total > amount) return fail(`total ${F.total} > expected ${amount}`)

// 결제수단 — 아이콘 라디오(이름 없음)는 눌러 보고 알아본다: 네이버 = npay_payment 하위 라디오, 페이코 = 'PAYCO는' 안내
const kindWant = /네이버|naver/i.test(card) ? 'naver' : /페이코|payco/i.test(card) ? 'payco' : null
if (!pointsOnly) {
  if (!kindWant) return fail('unknown pay method: ' + card)
  const ls = await lines()
  const icons = ls.filter((l, i) => /radio name=radio_payment-way/.test(l) && !/^\[\d+\] clickable "(?!혜택)/.test(ls[i + 1] || '')).map(l => parseInt(l.slice(1)))
  let hit = null
  for (const id of icons) {
    await page.click(id); await sleep(500)
    const isNaver = (await lines('input[name=npay_payment]')).length > 0
    const isPayco = /PAYCO는/.test(((await page.get({})).tree.split('PAGE TEXT:')[1] || ''))
    if ((kindWant === 'naver' && isNaver) || (kindWant === 'payco' && isPayco)) { hit = id; break }
  }
  if (hit == null) return fail('pay radio not found: ' + card)
  if (!(await lines('input[name=radio_payment-way]')).some(l => l.startsWith(`[${hit}]`) && /value="on"/.test(l))) return fail('pay radio not selected')
  if (kindWant === 'naver') {
    const sub = (await lines()).findIndex(l => l.includes('clickable "네이버 카드간편결제"'))
    const sl = (await lines())[sub - 1] || ''
    if (!/radio name=npay_payment/.test(sl)) return fail('naver card option not found')
    if (!/value="on"/.test(sl)) { await page.click(parseInt(sl.slice(1))); await sleep(300) }
  }
  R.method = kindWant === 'naver' ? '네이버페이' : '페이코'
}

// 필수 동의 — '전체 동의하기' 뒤 체크박스가 모두 켜졌는지
const boxes = async () => { const ls = await lines(); const i = ls.findIndex(l => l.includes('clickable "전체 동의하기"')); return ls.slice(i - 1).filter(l => /checkbox/.test(l)).slice(0, 5) }
if ((await boxes()).some(l => !/value="on"/.test(l))) {
  // '전체 동의하기' 글자(clickable)를 누른다 — idOf 는 이름 없는 체크박스를 줄 수 있다. 켜질 때까지 잠깐 기다리고, 남은 칸은 하나씩 켠다
  const all = (await lines()).find(l => /clickable "전체 동의하기"/.test(l)); if (all) { await page.click(parseInt(all.slice(1))); }
  for (let i = 0; i < 8 && (await boxes()).some(l => !/value="on"/.test(l)); i++) await sleep(300)
  for (const l of (await boxes()).filter(l => !/value="on"/.test(l))) { await page.click(parseInt(l.slice(1))); await sleep(300) }
}
const bx = await boxes()
if (bx.length < 5 || bx.some(l => !/value="on"/.test(l))) return fail('agreements not checked', { why: bx.join(' | ').slice(0, 200) })

const f2 = await formInfo(), m2 = mismatch(f2)
if (m2) return fail('order form mismatch', { why: 'before order: ' + m2 })
if (f2.total !== F.total) return fail(`total changed ${F.total} -> ${f2.total}`)
const ob = await page.idOf('주문하기')
if (ob < 0) return fail('order button not found')
if (dry) return { ...R, ok: true, dry: true, order_button: ob, note: 'dryRun: 주문하기 전 멈춤' }

const before = new Set((await tabs.list()).filter(t => t.kind === 'popup').map(t => t.id))
await page.click(ob)
if (pointsOnly) {
  for (let i = 0; i < 25 && OF.test(await page.url()); i++) await sleep(300)
  return { ...R, ok: true, points_only: true, note: 'points only - no payment popup' }
}
let popup = null
for (let i = 0; i < 40 && !popup; i++) { await sleep(300); popup = (await tabs.list()).find(t => t.kind === 'popup' && !before.has(t.id)) || null }
// 팝업이 없으면 같은 탭이 네이버페이로 넘어갔는지 본다(롯데온처럼 탭 안 결제창) — 그러면 키패드도 이 탭에 뜬다(실기 2026-09-30)
if (!popup) { const u = String(await page.url()); if (/pay\.naver\.com|nid\.naver\.com/.test(u)) return { ...R, ok: true, popup_url: null, keypad_in_tab: true, note: 'naverpay in same tab' }
  const al = (await tabs.list()).filter(t => /pay\.naver\.com/.test(t.url || '')); if (al.length) { await tabs.switch(al[al.length - 1].id); return { ...R, ok: true, popup_url: al[al.length - 1].url, note: 'naverpay tab' } }
  return { ...R, ok: false, popup_url: null, note: 'no payment popup @ ' + u.replace(/^https?:\/\//, '').split('?')[0].slice(0, 60) } }
return { ...R, ok: true, popup_url: popup.url, note: null }
