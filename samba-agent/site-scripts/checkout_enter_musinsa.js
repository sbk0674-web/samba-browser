// 무신사 결제창 진입(2026-09-26 검토 반영): 결제수단을 고르고 '결제하기'로 결제창을 띄운다(실결제 진입, 비밀번호는 하네스가)
// 인자 {card, profile?, dryRun?, expect:{name, option, selected, product_no}, amount?, tab?}
// dry 면 결제하기 직전까지만. 실결제인데 expect 없으면 결제 안 함. 탭은 args.tab 만, 없으면 대조로 딱 하나
// 총액을 못 읽으면 실패, args.amount 보다 크면 멈춤. 무신사페이는 두 번 누르지 않는다(비밀번호 없는 결제)
// 반환 {ok, method, popup_url, dry?, points_only?, total, order_item, note, error?}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const lc = s => nz(s).toLowerCase()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /musinsa\.com\/order\/order-form/
const get = async o => { for (let i = 0; i < 6; i++) { try { return (await page.get(o)).tree } catch (e) { await sleep(600) } } return '' }
const text = async () => nz((await get({})).split('PAGE TEXT:')[1])
// 총액: 못 읽으면 null(0 으로 보지 않는다)
const totalOf = t => { const m = t.match(/총 결제 금액\s*(?:\d+%\s*)?([\d,]+)\s*원/); return m ? num(m[1]) : null }
const segOf = t => nz((t.match(/주문 ?상품\s*\d+\s*개\s*(.*?)\s*\/\s*\d+\s*개/) || [])[1])
const dry = !!(args.dryRun || args.dry_run)
const card = nz(args.card)
const R = { ok: false, method: card || null, popup_url: null, total: null, order_item: null, note: null }
const fail = (error, note) => ({ ...R, ok: false, error, note: note || error })
const ex = typeof args.expect === 'string' ? { name: args.expect } : (args.expect && typeof args.expect === 'object' ? args.expect : null)
if (!dry && !ex) return fail('no expect', 'no expect')

// 주문서 대조(하네스 order_form_mismatch 기준 + 상품번호): 다르면 사유
const GEN = new Set('매장정품 정품 신발 운동화 스니커즈 스니커 남성 여성 남녀공용 공용 커플 키즈 아동 나이키 아디다스 뉴발란스 푸마 반스 컨버스 리복 아식스 휠라 스케쳐스 크록스 노스페이스 nike adidas puma vans converse reebok asics fila skechers crocs 모자 가방 티셔츠 블랙 화이트 그레이 네이비 black white grey gray navy'.split(' '))
const tk = s => lc(s).split(/[^0-9a-z가-힣]+/).filter(Boolean)
const ft = t => /^(free|one|f|os|onesize|프리)$/.test(t)
const mismatch = (seg, tree) => {
  if (!ex) return null
  const low = lc(seg)
  const words = String(ex.name || '').split(/[\s/()[\],·_:-]+/).filter(w => w && !/^\d+$/.test(w) && !GEN.has(w.toLowerCase()) && !w.startsWith('옵션') && ((/[가-힣]/.test(w) && w.length >= 2) || w.length >= 4))
  const sizes = (String(ex.option || '') + ' ' + String(ex.selected || '')).match(/(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g) || []
  const segNums = seg.split(/[^\d.]+/).filter(Boolean)
  if (words.length && !words.some(w => low.includes(w.toLowerCase()))) return `name words ${words.slice(0, 5).join(',')} not in order form`
  if (sizes.length && !sizes.some(x => segNums.includes(x))) return `size ${sizes.join('/')} not in order form`
  // 글자 사이즈는 주문서 줄에 같은 토큰이 있어야
  const want = sizes.length ? [] : tk(ex.selected || ex.option).filter(t => /^(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl)$/.test(t) || ft(t))
  const st = tk(seg)
  if (want.length && !want.some(l => st.includes(l) || (ft(l) && st.some(ft)))) return `size ${want.join('/')} not in order form`
  // 상품 링크가 보이면 그 번호여야
  const pno = String(ex.product_no || '').replace(/\D/g, '')
  if (pno && /products\/\d+/.test(tree) && !new RegExp('products/' + pno + '(?!\\d)').test(tree)) return `product ${pno} not in order form`
  return null
}

// 1) 주문서 탭(tabs.list 에 profile 이 실리면 그 계정 것만)
const ofs = (await tabs.list()).filter(t => OF.test(t.url || '') && (!args.profile || !t.profile || t.profile === args.profile))
let tab = null
if (args.tab) {
  tab = ofs.find(t => t.id === String(args.tab))
  if (!tab) return fail('not-on-order-form', 'order form tab ' + args.tab + ' not found')
} else {
  // 후보마다 대조해 딱 하나만(expect 없으면 주문서 하나일 때만)
  const hit = []
  for (const t of ofs) {
    if (!ex) { hit.push(t); continue }
    await tabs.switch(t.id)
    try { await page.waitFor('총 결제 금액', 6000) } catch (e) {}
    const tr = await get({})
    const sg = segOf(nz(tr.split('PAGE TEXT:')[1]))
    if (sg && !mismatch(sg, tr)) hit.push(t)
  }
  if (hit.length !== 1) return fail('not-on-order-form', ofs.length ? `order forms ${ofs.length} open, ${hit.length} match — pass args.tab` : 'no order form tab')
  tab = hit[0]
}
await tabs.switch(tab.id)
try { await page.waitFor('총 결제 금액', 8000) } catch (e) {}

// 2) 주문서 대조
const tree0 = await get({})
let tx = nz(tree0.split('PAGE TEXT:')[1])
const seg = segOf(tx)
R.order_item = seg || null
if (!seg) return fail('order form mismatch', 'order item not readable')
const why = mismatch(seg, tree0)
if (why) return fail('order form mismatch', 'order form mismatch: ' + why + ' | ' + seg.slice(0, 80))

// 3) 결제수단
const NAMES = ['무신사머니', '무신사페이', '토스페이', '카카오페이', '페이코', '네이버페이']
const pointsOnly = card === '포인트전액'
const m = NAMES.find(n => card.includes(n) || (card.length > 1 && n.includes(card)))
if (!pointsOnly && !m) return fail('method-not-found', 'unsupported pay method: ' + card)
if (m) {
  const radioOf = t => { const l = t.split('\n').find(x => /^\[\d+\] radio "/.test(x) && x.includes('] radio "' + m)); return l ? parseInt(l.slice(1)) : 0 }
  const rid = radioOf(await get({ interactive: 1 })) || radioOf(String(await page.find(m)))
  if (!rid) return fail('method-not-found', m + ' radio not found')
  await page.click(rid)
  try { await page.waitFor(m + ' 결제', 3000) } catch (e) { await sleep(700) }
  tx = await text()
  // 화면 아래 '<수단> 결제' 문구로 확인
  if (!tx.includes(m + ' 결제')) return fail('method-not-selected', m + ' not confirmed on screen')
  R.method = m
  if (m === '무신사페이' && !/\(\d{3,4}\*?\)\s*(신용카드|체크카드)/.test(tx.slice(tx.indexOf('결제 수단'), tx.indexOf('결제 금액 상품 금액')))) return fail('no-registered-card', '무신사페이 registered card not found')
  if (m === '무신사머니' && /잔액이 부족|계좌를 (등록|연결)해/.test(tx)) return fail('money-unavailable', '무신사머니 잔액·계좌 확인 필요')
}
// 4) 금액: 수단을 고른 뒤의 화면 총액
R.total = totalOf(tx)
if (R.total == null) return fail('total-not-read', '총 결제 금액을 읽지 못함')
if (pointsOnly && R.total > 0) return fail('not-points-only', `total ${R.total} > 0`)
const amt = Number(args.amount)
// 견적에 없던 배송비만큼 커진 건 넘어간다(결제 화면에만 배송비가 붙는 상품, 2026-10-05)
const shipFee = num((tx.match(/배송비\s*\+?\s*([\d,]{3,})\s*원/) || [])[1]) || 0
if (amt > 0 && R.total > amt + shipFee) return fail('amount-exceeded', `total ${R.total} > expected ${amt}+${shipFee}`)
if (amt > 0 && R.total > amt) R.shipping_fee = shipFee
const payLine = (t => t.split('\n').find(x => /^\[\d+\] button "[^"]*결제하기"/.test(x)))(await get({ interactive: 1 })) || String(await page.find('결제하기')).split('\n').find(x => /^\[\d+\] button "[^"]*결제하기"/.test(x))
if (!payLine) return fail('pay-button-not-found')
const payId = parseInt(payLine.slice(1))

// 5) 시험: 누르기 직전에서 멈춘다
if (dry) return { ...R, ok: true, dry: true, points_only: pointsOnly || undefined, note: 'dry run — pay button ' + payId + ' not clicked' }

// 6) 결제하기 → 결제창. 늦으면 한 번 더 누른다(무신사페이 제외), 새 창이 둘이면 사람에게
const before = new Set((await tabs.list()).map(t => t.id))
const clicks = [String(await page.click(payId)).slice(0, 80)]
if (pointsOnly) { await sleep(2500); return { ...R, ok: true, points_only: true, click: clicks } }
const news = async () => (await tabs.list()).filter(t => !before.has(t.id))
const waitPopup = async n => { for (let i = 0; i < n * 2 && !R.popup_url; i++) { await sleep(500); const nt = (await news())[0]; if (nt) R.popup_url = nt.url || 'about:blank' } }
await waitPopup(12)
let retried = false
if (!R.popup_url && m !== '무신사페이' && OF.test(await page.url())) {
  retried = true
  clicks.push(String(await page.clickNative(payId)).slice(0, 80))
  await waitPopup(15)
  await sleep(1500)
  const nw = await news()
  if (nw.length > 1) return { ...R, ok: false, error: 'multiple-payment-popups', note: `결제창 ${nw.length}개 — 사람이 확인` }
}
if (!R.popup_url) {
  const t2 = await text()
  const hits = t2.match(/[^.]{0,50}(잔액|충전|한도|부족|초과|품절|재고|확인해\s*주세요|선택해\s*주세요|동의|실패|오류|불가)[^.]{0,50}/g) || []
  return { ...R, ok: false, error: 'no-payment-popup', url: await page.url(), note: ('click=' + clicks.join(',') + ' | ' + hits.slice(0, 5).join(' | ')).slice(0, 400) }
}
return { ...R, ok: true, retried, click: clicks }
