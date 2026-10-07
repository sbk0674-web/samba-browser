// SSG 결제창 진입(2026-09-27, 적대적 검토 반영 — dryRun 만 실측): 주문서(pay.ssg.com/order/ordPage.ssg)에서 결제수단을 고르고 '동의하고 N원 결제하기'를 누른다.
// 수단: 'SSG MONEY 충전결제'(체크박스) 또는 SSGPAY 등록 카드(라디오 '현대카드(850*) 선택하기'). 카드사를 모르면 추측하지 않고 멈춘다.
// 인자 {card, issuer?, profile?, dryRun?, expect:{name, option, selected, product_no, product_url}, amount, tab, allow_department?}
// 실결제 필수: expect(name·product_no·product_url)·amount>0·tab. 탭 자동 대조는 dry 에서만.
// 상품 대조: 주문서엔 itemId 가 없다(실측: 링크·숨은 값 없음) — 스냅샷이 만든 주문서 탭(args.tab) + 스냅샷 상품명(expect.name 전체)이
// 주문상품 줄에 그대로 있어야 한다 + expect.product_url 의 itemId 가 product_no 이고 신세계몰 6004·신세계백화점 6009(6009는 allow_department:true 때만)여야 한다.
// 옵션: expect.selected 글자가 주문상품 줄 '옵션 : … 판매가격' 구간에 있어야(구간을 못 찾으면 실패).
// 반환 {ok, method, popup_url, dry?, total, order_item, note, error?}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const key = s => String(s || '').toLowerCase().replace(/[\s\-_/·,()[\]]+/g, '')
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /pay\.ssg\.com\/(order|payment)/
const tree = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const text = async () => nz((await tree()).split('PAGE TEXT:')[1])
const L = async () => (await tree({ interactive: true })).split('\n')
const clickL = async re => { const l = (await L()).find(x => typeof re === 'function' ? re(x) : re.test(x)); if (!l) return false; await page.click(parseInt(l.slice(1))); await sleep(1200); return true }
const dry = !!(args.dryRun || args.dry_run)
const card = nz(args.card)
const amt = Number(args.amount)
const R = { ok: false, method: card || null, popup_url: null, total: null, order_item: null, note: null }
const fail = (error, note) => ({ ...R, ok: false, error, note: note || error })
const ex = args.expect && typeof args.expect === 'object' ? args.expect : null
if (!dry) {
  if (!ex || !nz(ex.name) || !nz(ex.product_no) || !nz(ex.product_url)) return fail('no expect', 'expect.name·product_no·product_url 필요')
  if (!(amt > 0)) return fail('no amount')
  if (!args.tab) return fail('no tab')
}
// 신세계몰 허용 목록(상품 주소 기준)
const mallOk = u => /shinsegaemall\.ssg\.com/.test(u) || /[?&]siteNo=6004(?!\d)/.test(u) || (args.allow_department === true && (/department\.ssg\.com/.test(u) || /[?&]siteNo=6009(?!\d)/.test(u)))
if (ex && ex.product_url) {
  // www.ssg.com 주소(siteNo 없음)는 주문상품 줄의 판매처(신세계몰·신세계백화점)로 본다(2026-09-27 실측)
  if (!mallOk(String(ex.product_url)) && /siteNo=/.test(String(ex.product_url))) return fail('not_shinsegaemall', '신세계몰 상품 주소가 아니다')
  const pno = String(ex.product_no || '').replace(/\D/g, '')
  if (pno && !new RegExp('[?&]itemId=' + pno + '(?!\\d)').test(String(ex.product_url))) return fail('order form mismatch', 'product_url 의 itemId 가 product_no 와 다르다')
}
// 주문상품 줄: '주문상품 목록' 뒤 '수량 N' 앞
const itemOf = t => { const i = t.indexOf('주문상품 목록'); if (i < 0) return ''; const s = t.slice(i + 7); const j = s.search(/수량\s*\d/); return nz(s.slice(0, j > 0 ? j : 200)) }
const mismatch = seg => {
  if (!seg) return 'order item not readable'
  if (!/^(신세계몰|신세계백화점)/.test(seg) || (/^신세계백화점/.test(seg) && args.allow_department !== true)) return 'not_shinsegaemall: 주문상품 판매처'
  if (!ex) return null
  if (nz(ex.name) && !key(seg).includes(key(ex.name))) return 'product name not in order item'
  const opt = (seg.match(/옵션\s*:\s*(.*?)\s*판매가격/) || [])[1]
  const sel = nz(ex.selected)
  if (sel) {
    if (opt == null) return 'option segment not found'
    if (!key(opt).includes(key(sel))) return `selected "${sel}" not in option "${opt}"`
  }
  const sizes = String(ex.option || '').match(/(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g) || []
  if (sizes.length && opt != null && !sizes.some(x => opt.split(/[^\d.]+/).includes(x))) return 'size ' + sizes.join('/') + ' not in option'
  return null
}
// 1) 주문서 탭 — 실결제는 args.tab 만. 자동 대조(딱 하나)는 dry 에서만
const ofs = (await tabs.list()).filter(t => t.kind === 'tab' && OF.test(t.url || ''))
let tab = null
if (args.tab) {
  tab = ofs.find(t => t.id === String(args.tab))
  if (!tab) return fail('not-on-order-form', 'order form tab ' + args.tab + ' not found')
} else {
  const hit = []
  for (const t of ofs) {
    await tabs.switch(t.id)
    try { await page.waitFor('결제 예정금액', 6000) } catch (e) {}
    if (!mismatch(itemOf(await text()))) hit.push(t)
  }
  if (hit.length !== 1) return fail('not-on-order-form', ofs.length ? `order forms ${ofs.length} open, ${hit.length} match — pass args.tab` : 'no order form tab')
  tab = hit[0]
}
await tabs.switch(tab.id)
try { await page.waitFor('결제 예정금액', 8000) } catch (e) {}
// 2) 대조
let tx = await text()
R.order_item = itemOf(tx).slice(0, 160) || null
const why = mismatch(itemOf(tx))
if (why) return fail('order form mismatch', 'order form mismatch: ' + why)
// 3) 결제수단
const issuer = nz(args.issuer || (card.match(/(현대|KB국민|국민|롯데|신한|농협|NH)\s*카드/) || [])[0])
if (/충전|MONEY|머니/i.test(card)) {
  await clickL(/^\[\d+\] checkbox "SSG MONEY 충전결제" value="off"/)
  if (!(await L()).some(x => /checkbox "SSG MONEY 충전결제" value="on"/.test(x))) return fail('method-not-selected', 'SSG MONEY 충전결제 not on')
  tx = await text()
  if (!/충전\s*금액\s*\S*은행/.test(tx)) return fail('money-unavailable', '충전결제 연결 계좌 없음')
  R.method = 'SSG MONEY 충전결제'
} else if (/SSG|쓱|site/i.test(card) || issuer) {
  if (!issuer) return fail('method-not-found', 'SSGPAY 카드사(issuer)가 없다 — 카드를 추측하지 않는다')
  await clickL(/^\[\d+\] checkbox "SSG MONEY 충전결제" value="on"/)
  const head = issuer.replace(/카드$/, '')
  const isCard = x => / radio "[^"]*선택하기" name=_cpay_ssgpay_card/.test(x) && (x.match(/radio "([^"]*)"/) || [])[1].startsWith(head)
  if (!(await clickL(isCard))) return fail('method-not-found', issuer + ' SSGPAY 등록 카드 없음')
  if (!(await L()).some(x => isCard(x) && /value="on"/.test(x))) return fail('method-not-selected', issuer + ' not selected')
  R.method = 'SSGPAY ' + issuer
  tx = await text()
} else return fail('method-not-found', 'unsupported pay method: ' + card)
// 4) 금액(수단 고른 뒤)
R.total = num((tx.match(/결제\s*예정\s*금액\s*([\d,]{3,})\s*원/) || [])[1]) || null
if (!R.total) return fail('total-not-read', '결제 예정금액을 읽지 못함')
if (amt > 0 && R.total > amt) return fail('amount-exceeded', `total ${R.total} > expected ${amt}`)
// 5) 결제 버튼(name=processOrderButton) — 아래쪽 '동의하고 N원 결제하기'(약관 동의 포함)
const pls = (await L()).filter(l => /^\[\d+\] button "[^"]*결제하기[^"]*" name=processOrderButton/.test(l))
const pl = pls.find(l => /동의하고/.test(l)) || pls[0]
if (!pl) return fail('pay-button-not-found')
const payId = parseInt(pl.slice(1))
if (dry) return { ...R, ok: true, dry: true, note: 'dry run — pay button ' + payId + ' not clicked' }
// 6) 결제하기 → 결제창(팝업 또는 같은 탭 이동). 두 번 누르지 않는다
const before = new Set((await tabs.list()).map(t => t.id))
const click = String(await page.click(payId)).slice(0, 80)
for (let i = 0; i < 30 && !R.popup_url; i++) {
  await sleep(500)
  const nt = (await tabs.list()).filter(t => !before.has(t.id))
  if (nt.length) R.popup_url = nt[0].url || 'about:blank'
  else if (!OF.test(await page.url())) R.popup_url = await page.url()
}
if (!R.popup_url) {
  const t2 = await text()
  const hits = t2.match(/[^.]{0,50}(잔액|충전|한도|부족|초과|품절|재고|확인해\s*주세요|선택해\s*주세요|동의|실패|오류|불가)[^.]{0,50}/g) || []
  return { ...R, ok: false, error: 'no-payment-popup', note: ('click=' + click + ' | ' + hits.slice(0, 5).join(' | ')).slice(0, 400) }
}
return { ...R, ok: true, click }
