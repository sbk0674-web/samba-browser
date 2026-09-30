// SSG 상품 스냅샷: 진입 경로로 상품을 열어 옵션을 고르고 바로구매로 주문서까지(결제 없음).
// 신세계몰(6004)·신세계백화점(6009)만 — 아니면 'not_shinsegaemall'(6009는 allow_department:true 때만). 쿠폰받기 먼저.
// 인자 {sku: 상품 주소, size?: 주문 옵션('옵션:285'), qty?, account?, profile?, route?: 'direct'|'danawa'|'enuri'|'adpick', entry_url?, adpick_percent?}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const pf = args.profile ? { profile: args.profile } : {}
const acct = args.account || args.profile || '현재 로그인 계정'
const R = { options: [], selected: null, cost: null, pay_amount: null, methods: [], coupons: {}, product_url: null, product_name: null, product_no: null, order_tab: null, route: args.route || 'direct', ckwhere: null, account: args.account || null, note: null }
const tree = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const text = async () => nz((await tree()).split('PAGE TEXT:')[1])
const els = t => t.split('\n').map(l => l.match(/^\[(\d+)\] (\S+)(?: "([^"]*)")?(.*)$/)).filter(Boolean).map(m => ({ id: +m[1], role: m[2], text: m[3] || '', rest: m[4] }))
const want = nz(String(args.size || '').replace(/^\s*(옵션|사이즈|size)\s*[:：]\s*/i, ''))
const nm = s => nz(s).toLowerCase().replace(/[\s()·\-/,:]/g, '')
const score = o => {
  if (!want) return 0
  if (nm(o) === nm(want)) return 100
  const toks = want.split(/[\s/·,]+/).filter(Boolean)
  if (toks.some(k => nm(k) === nm(o))) return 90
  const on = o.match(/(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g) || []
  if (on.length && toks.some(k => on.includes(k))) return 70
  if (toks.some(k => k.length > 1 && nm(o).includes(nm(k)))) return 50
  return 0
}
const url0 = args.entry_url || args.sku
if (!/^https:\/\//.test(String(url0 || ''))) return { ...R, error: 'bad-sku', note: 'sku/entry_url 은 https 주소' }
const tabId = (String(await tabs.open({ ...pf, url: url0 })).match(/tab (\S+)/) || [])[1]
if (tabId) await tabs.switch(tabId)
try { await page.waitFor(/바로구매|품절|입고알림/, 25000) } catch (e) {}
R.product_url = await page.url()
R.product_no = (R.product_url.match(/itemId=(\d+)/) || [])[1] || null
R.ckwhere = (R.product_url.match(/[?&]ckwhere=([^&]+)/) || [])[1] || null
const mallOk = u => /shinsegaemall\.ssg\.com/.test(u) || /[?&]siteNo=6004(?!\d)/.test(u) || (args.allow_department === true && (/department\.ssg\.com/.test(u) || /[?&]siteNo=6009(?!\d)/.test(u)))
R.mall_ok = mallOk(R.product_url) || (!/siteNo=/.test(R.product_url) && (/판매자스토어 신세계몰/.test(await text()) || (args.allow_department === true && /판매자스토어 신세계 ?백화점/.test(await text()))))
R.product_name = nz(String(await page.title()).replace(/\s*-\s*(SSG\.COM|신세계백화점|신세계몰|이마트몰)\s*$/, '')) || null
if (/접속이 잠시 제한|자동화된 환경/.test(await text())) return { ...R, error: 'blocked', note: 'SSG 봇 차단 화면 — 잠시 뒤 재시도' }
if (/member\.ssg\.com/.test(R.product_url)) return { ...R, error: 'login_required', note: '로그인 페이지로 이동' }
if (!R.mall_ok) { R.coupons[acct] = 0; return { ...R, error: 'not_shinsegaemall', note: '신세계몰 상품이 아니다 — 같은 상품의 신세계몰 판매 페이지로 사야 한다', product_tab: tabId } }
if (args.coupon !== false) { const cb = await page.idOf('쿠폰받기', 0); if (cb >= 0) { await page.click(cb); await sleep(1200); R.coupon_downloaded = true } }
let t = await text()
if ((await page.idOf('바로구매', 0)) < 0 && ((await page.idOf('입고알림', 0)) >= 0 || (await page.idOf('품절', 0)) >= 0)) {
  R.coupons[acct] = 0
  return { ...R, sold_out: true, options: [], note: 'item sold out', product_tab: tabId }
}

const picked = []
for (let step = 0; step < 3; step++) {
  const before = new Set(els(await tree({ interactive: true })).map(e => e.id))
  // '사이즈 선택하세요.'처럼 이름 붙은 칸 먼저(맨 앞 '선택하세요.'는 숨은 칸일 수 있다, 09-30 백화점)
  const oc = els(await tree({ query: '선택하세요' })).filter(e => e.role === 'link' && /선택하세요\.?$/.test(e.text) && !picked.includes(e.text))
  const opener = (oc.find(e => e.text !== '선택하세요.') || oc[0] || { id: -1 }).id
  if (opener < 0) break
  await page.click(opener)
  await sleep(700)
  const after = els(await tree({ interactive: true }))
  const live = after.filter(e => !before.has(e.id) && e.role === 'link' && /href=#/.test(e.rest) && e.text && e.text.length <= 40 && !/배너|이전|다음|닫기|선택하세요|매진|품절/.test(e.text))
  t = await text()
  const oseg = t.slice(Math.max(t.indexOf('선택하세요.'), 0), t.indexOf('총 금액') > 0 ? t.indexOf('총 금액') : undefined)
  const sold = [...oseg.matchAll(/(\S+)\(매진\)/g)].map(m => m[1] + ' 품절')
  R.options = [...R.options, ...live.map(e => e.text), ...sold]
  if (!live.length) { R.note = 'no live option'; break }
  let best = null, top = 0
  for (const o of live) { const s = score(o.text); if (s > top) { top = s; best = o } }
  const COLOR = /black|white|red|blue|navy|gr[ae]y|green|beige|pink|ivory|블랙|화이트|레드|블루|네이비|그레이|그린|베이지|핑크|아이보리/i
  if (!best && live.length === 1 && (/^(free|f|one ?size|os|프리)$/i.test(live[0].text) || !COLOR.test(want) || COLOR.test(live[0].text) && nm(want).includes(nm(live[0].text)))) best = live[0]
  if (!best) { R.note = want ? 'size not available' : 'option needs choice'; R.coupons[acct] = 0; return { ...R, product_tab: tabId } }
  await page.click(best.id)
  picked.push(best.text)
  await sleep(800)
}
t = await text()
const sec = t.slice(0, t.indexOf('바로구매') > 0 ? t.indexOf('바로구매') : t.length)
// 자동 선택 상품: '사이즈 : FREE' 줄을 선택으로 본다
const chosen = [...sec.matchAll(/(색상|사이즈|옵션|용량|타입)\s*:\s*([^/]+?)(?=\s*\/|\s*삭제|\s*빼기)/g)].map(m => nz(m[2]))
if (!picked.length && chosen.length) R.options = chosen
if (!chosen.length && !picked.length && /선택하세요\./.test(sec)) { R.coupons[acct] = 0; return { ...R, note: 'option not chosen', product_tab: tabId } }

const beforeTabs = new Set((await tabs.list()).map(x => x.id))
let buy = await page.idOf('바로구매', 0)
for (let i = 0; i < 10 && buy < 0; i++) { await sleep(1000); buy = await page.idOf('바로구매', 0) }
if (buy < 0) return { ...R, error: 'buy-button-not-found', product_tab: tabId }
await page.click(buy)
let form = null
for (let i = 0; i < 24 && !form; i++) {
  await sleep(500)
  const list = await tabs.list()
  const login = list.find(x => !beforeTabs.has(x.id) && /member\.ssg\.com/.test(x.url || ''))
  if (login) { await sleep(800); for (const x of await tabs.list()) if (x.kind === 'popup' && /member\.ssg\.com/.test(x.url || '')) { try { await tabs.close(x.id) } catch (e) {} } R.coupons[acct] = 0; return { ...R, error: 'login_required', note: 'SSG 로그인 필요(바로구매가 로그인 팝업을 띄움)', product_tab: tabId } }
  // 상품 탭이 넘어가거나 새 탭만(예전 주문서 제외)
  form = list.find(x => (x.id === tabId || !beforeTabs.has(x.id)) && /pay\.ssg\.com\/(order|payment)/.test(x.url || ''))
}
if (!form) {
  t = await text()
  const why = (t.match(/[^.]{0,40}(한도|최대 ?구매|품절|재고|선택해 ?주세요|불가)[^.]{0,40}/g) || []).slice(0, 3).join(' | ')
  return { ...R, error: 'no_checkout', note: 'order form not opened ' + why, product_tab: tabId }
}
await tabs.switch(form.id)
R.order_tab = form.id
try { await page.waitFor(/결제\s*수단|결제수단/, 12000) } catch (e) {}
await sleep(800)
t = await text()
let total = num((t.match(/(최종\s*결제\s*금액|총\s*결제\s*금액|결제\s*예정\s*금액)\s*([\d,]{3,})\s*원/) || [])[2])
if (!total) total = num(els(await tree({ selector: '#totalPayAmt, [id*="totalPay"]' })).map(e => e.text).join(' '))
R.pay_amount = total || null
R.cost = total || null
R.adpick_rate = R.route === 'adpick' ? (parseFloat(args.adpick_percent) || 0) : 0
R.adpick_reward = Math.round((total || 0) * R.adpick_rate / 100)
const MN = ['SSGPAY', 'SSG MONEY', '신용카드', '페이코', 'PAYCO', '카카오페이', '네이버페이', '토스페이', '일반결제']
R.methods = MN.filter(m => t.toUpperCase().includes(m.toUpperCase()))
const cp = t.match(/쿠폰\s*(?:할인|사용)?\s*-?\s*([\d,]{3,})\s*원/)
R.coupons[acct] = cp ? num(cp[1]) : 0
// 주문서에 담긴 옵션: 주문상품 목록의 '옵션 : 285 판매가격'
const oi = t.indexOf('주문상품 목록')
const om = (oi >= 0 ? t.slice(oi) : '').match(/옵션\s*:\s*(.+?)\s*판매가격/)
R.selected = om ? nz(om[1]) : (picked.join(' / ') || chosen.join(' / ') || null)
if (!R.cost) R.note = 'total not read on order form'
return R
