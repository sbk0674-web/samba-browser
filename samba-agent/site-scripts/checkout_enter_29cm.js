// 29CM 결제창 진입(09-26) — 수단을 고르고 '결제하기'로 결제창을 연다(비밀번호 안 넣음). dryRun 이면 직전에 멈춘다.
// 실결제는 expect·상품번호·tab 필수(dry 는 tab 없으면 대조 통과 하나). 대조는 결제 탭 화면만 — 주문서를 새 탭으로
// 다시 열면 서버 주문서가 기본값(배송지 등)으로 돌아갈 수 있어 열지 않는다. 같은 계정 동시 구매는 하네스 락 몫.
// args: card, profile, tab, expect{option,selected,product_no}, amount, dryRun  반환 {ok,method,checkout,popup_url,total,note}
const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d/.test(l))
const idOf = l => parseInt(l.slice(1))
const nameOf = l => (l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1]
const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_/:().,[\]·]/g, '')
const CK = /29cm\.co\.kr\/order\/checkout/
async function formInfo() {
  const t = (await page.get({})).tree, tx = text(t)
  const nos = [...new Set([...t.matchAll(/\/product\/catalog\/(\d+)/g)].map(m => m[1]))]
  const names = lines(t).filter(l => /\] link "[^"]+" href=\S*\/product\/catalog\//.test(l)).map(nameOf)
  let opt = ''; for (const n of names) { const a = tx.indexOf(n), m = a >= 0 ? tx.slice(a + n.length, a + n.length + 120).match(/^\s*(.*?)\s*\d+개/) : null; if (m) opt += ' ' + m[1] }
  return { tx, nos, name: names.join(' '), opt: opt.trim() }
}
function mismatch(f, e) {
  if (f.nos.length !== 1) return '주문서 상품 ' + f.nos.length + '개'
  if (!e) return null
  const no = String(e.product_no || '')
  if (no && f.nos[0] !== no) return '상품번호 ' + f.nos + ' ≠ ' + no
  const sz = ((e.option || '') + ' ' + (e.selected || '')).match(/(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g) || []
  if (sz.length && !sz.some(x => new RegExp('(?<![\\d.])' + x + '(?![\\d.])').test(f.opt))) return '옵션 ' + sz + ' ≠ ' + f.opt
  const lz = s => (s + '').toUpperCase().match(/(?<![A-Z])(X{0,3}S|M|X{0,3}L|\dXL|FREE)(?![A-Z])/g) || [], el = lz((e.option || '') + ' ' + (e.selected || ''))
  if (!sz.length && el.length && lz(f.opt).length && !lz(f.opt).some(x => el.includes(x))) return '옵션 ' + el + ' ≠ ' + f.opt
  // 상품명 단어는 payer 가 본다(여기선 상품번호가 필수)
  return null
}
// 라디오 번호를 라벨 순서로 맞춘다(value 는 늘 on)
async function radios() {
  const r = (await page.get({ selector: 'label:has(input[type=radio])' })).tree, ids = lines(r).filter(l => /\] radio value=/.test(l)).map(idOf).sort((x, y) => x - y), tx = text(r).replace(/소득공제용.*$/, '')
  const K = [['적립', /구매 적립금 받기/], ['선할인', /선할인 받기/], ['무신사머니', /무신사머니/], ['무신사페이', /무신사페이/], ['토스페이', /토스페이/], ['카카오페이', /카카오페이/], ['카드', /카드 결제/], ['기타', /다른 결제 방법/]]
  const got = []; let p = 0
  for (const [k, re] of K) { const i = tx.slice(p).search(re); if (i >= 0) { got.push(k); p += i + 1 } }
  return got.length === ids.length ? Object.fromEntries(got.map((k, i) => [k, ids[i]])) : null
}
const seg = tx => tx.slice(tx.indexOf('결제 방법'), tx.indexOf('주문 내용을'))
async function settle(prev) {
  let last = null, tx = ''
  for (let i = 0; i < 20; i++) { await sleep(150); tx = text((await page.get({})).tree); const s = seg(tx); if (s === last && (s !== prev || i >= 3)) break; last = s }
  return tx
}
// 선택 표시(실측): 머니=보유 잔액, 페이=카드 목록, 기타=하위 버튼, 토스·카카오=현금영수증, 카드=없음
const shown = tx => { const s = seg(tx); return { money: /보유 잔액 [\d,]+원/.test(s), pay: /결제수단 추가하기|\(\s*[\d*]{2,6}\s*\)\s*(신용|체크)카드/.test(s), etc: /PIN번호 결제|가상계좌|휴대폰결제/.test(s), cash: /현금 영수증/.test(s) } }
const dsc = tx => (tx.match(/ㄴ 결제 즉시 할인 ([^ㄴ\d-]+?) ?-[\d,]+원/) || [])[1]
const dry = !!(args.dryRun || args.dry_run), E = args.expect
const card = String(args.card || '').trim()
const fail = (note, x) => ({ ok: false, method: card || null, popup_url: null, note, ...x })
if (!dry && !E) return { ok: false, note: 'no expect' }
if (!card) return fail('card 없음')
if (!dry && !String(E.product_no || '')) return fail('no expect.product_no')
if (!dry && !args.tab) return fail('no tab')
const amt = args.amount == null || args.amount === '' ? null : Number(args.amount)
if (amt != null && !(amt > 0)) return fail('amount 이상: ' + args.amount)
if (!dry && amt == null) return fail('no amount')
let c = (await tabs.list()).filter(x => CK.test(x.url || ''))
if (args.tab) c = c.filter(x => x.id === String(args.tab))
// 계정 비교를 동시에 돌리면 계정마다 주문서 탭이 열린다 — 이 계정(프로필)의 탭만 본다
// (실기 2026-09-29: 'multiple checkout tabs' 로 원가를 못 읽었다)
if (args.profile) { const mine = c.filter(x => !x.profile || x.profile === args.profile); if (mine.length) c = mine }
if (!c.length) return fail('no checkout tab')
const ok = []; let why = null
for (const x of c) { await tabs.switch(x.id); await page.waitFor(/(?:총|최종) 결제 ?금액/, 8000).catch(() => {}); const f = await formInfo(), m = mismatch(f, E); if (m) why = m; else ok.push({ id: x.id, f }) }
if (ok.length !== 1) return fail(ok.length ? 'multiple checkout tabs' : 'order form mismatch', why ? { why } : null)
const P = ok[0]
await tabs.switch(P.id)
const checkout = await page.url()
const R = await radios()
if (!R) return fail('수단 라디오 대응 실패')
let tx = P.f.tx, cur = seg(tx)
const click = async id => { await page.click(id); tx = await settle(cur); cur = seg(tx) }
const n = norm(card)
let method, s
if (n.includes('무신사머니')) {
  await click(R['무신사머니']); method = '무신사머니'; s = shown(tx)
  if (!s.money || s.pay || s.etc) return fail('무신사머니 선택 안 됨')
} else if (n.includes('무신사페이')) {
  await click(R['무신사페이']); method = '무신사페이'; s = shown(tx)
  if (!s.pay || s.money || s.etc) return fail('무신사페이 선택 안 됨')
  const sec = (seg(tx).split('무신사페이').slice(1).join('무신사페이').split('토스페이')[0]) || ''
  const first = (sec.match(/([가-힣A-Za-z]{2,12}카드)\s*\(\s*[\d*]{2,6}\s*\)/) || [])[1]
  if (!first || /무신사\s*삼성/.test(first)) return fail('무신사페이 기본 카드 아님(' + first + ')')
  const ti = tx.indexOf('결제 금액 총 주문')
  if (ti < 0 || /제휴카드/.test(tx.slice(ti))) return fail(ti < 0 ? '결제 금액 줄 못 읽음' : '제휴카드 할인 붙음')
} else if (/토스|카카오/.test(n)) {
  method = n.includes('토스') ? '토스페이' : '카카오페이'
  await click(R[method]); s = shown(tx)
  const d = dsc(tx)
  if (!s.cash || s.money || s.pay || s.etc || (d && !norm(d).includes(norm(method)))) return fail(method + ' 선택 안 됨 ' + (d || ''))
} else if (/카드(결제)?$/.test(n) && R['카드']) {
  // 카드사 이름 → '카드 결제'(카드사는 결제창에서)
  await click(R['카드']); method = '카드 결제'; s = shown(tx)
  if (s.cash || s.money || s.pay || s.etc || dsc(tx)) return fail('카드 결제 선택 안 됨')
} else if (R['기타']) {
  // 기타의 하위 수단 — 이름이 정확히 같은 버튼만(배너 아님)
  await click(R['기타'])
  const sub = lines((await page.get({})).tree).find(l => /\] button "/.test(l) && norm(nameOf(l)) === n)
  if (!sub) return fail(card + ' 하위 수단 없음')
  await click(idOf(sub)); method = nameOf(sub)
  const d = dsc(tx)
  if (!shown(tx).etc || (d && !norm(d).includes(n))) return fail(card + ' 선택 안 됨 ' + (d || ''))
} else return fail('모르는 결제수단: ' + card)
if (!CK.test(await page.url())) return fail('주문서를 벗어남')
// 결제 탭 화면만 다시 읽어 대조한다(새 탭 재오픈 없음)
const warn = E ? null : 'no expect(dry)'
const f2 = await formInfo(), m2 = mismatch(f2, E)
if (m2) return fail('order form mismatch', { why: m2 })
const total = num((f2.tx.match(/(?:총|최종) 결제 ?금액 ([\d,]+)원/) || [])[1])
if (!total) return fail('총액 못 읽음')
if (amt != null && total > amt) return fail('결제액 ' + total + ' > 예상 ' + amt, { total })
const pay = lines((await page.get({ query: '결제하기' })).tree).filter(l => /\] (button|clickable) "[^"]*원 ?결제하기/.test(l)).pop()
if (!pay) return fail("'결제하기' 버튼 없음", { total })
const pb = num((nameOf(pay).match(/([\d,]+)원 ?결제하기/) || [])[1])
if (pb !== total) return fail('버튼 금액 ' + pb + ' ≠ 총액 ' + total, { total })
if (dry) return { ok: true, dry: true, method, checkout, total, note: warn }
const before = new Set((await tabs.list()).map(x => x.id))
await page.click(idOf(pay))
let popup = null
for (let i = 0; i < 24 && !popup; i++) { await sleep(300); popup = (await tabs.list()).find(x => !before.has(x.id)) || null }
return { ok: true, method, checkout, total, popup_url: popup ? popup.url : null, note: warn || (popup ? null : '팝업 안 보임') }
