// ABC마트·그랜드스테이지 스냅샷 — 사이즈·수량 골라 바로구매로 주문서까지(결제 없음). 연 탭(tid)만 쓴다.
const tabIdOf = r => (String(r).match(/tab (\S+)/) || [])[1] || null
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const num = s => (s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0)
const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const labelOf = l => (l.match(/"([^"]*)"/) || [])[1] || ''
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
const text = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const isOrderUrl = u => /^https:\/\/(abcmart|grandstage)\.a-rt\.com\/order(?:[?#]|$)/.test(u || '')
const profile = String(args.profile || '').trim().toLowerCase()
const withProfile = url => (profile ? { profile: args.profile, url } : { url })
const sameAccount = email => !profile || String(email || '').toLowerCase().split('@')[0] === profile.split('@')[0]
const emailOnForm = async () => valOf(lines(await page.get({ selector: 'input[name=buyerEmailAddrText]' }))[0])

function pickOption(want, opts) {
  if (!want || !opts.length) return null
  if (opts.includes(want)) return want
  const w = want.toLowerCase()
  const kr = w.match(/kr\s*(\d+(?:\.\d+)?)/)
  const nums = (w.match(/\d+(?:\.\d+)?/g) || []).map(Number)
  for (const n of kr ? [Number(kr[1]), ...nums] : nums) {
    const hit = opts.find(o => { const m = String(o).match(/\d+(?:\.\d+)?/); return m && Number(m[0]) === n })
    if (hit) return hit
  }
  if (!nums.length) return opts.find(o => o.toLowerCase().replace(/\s/g, '') === w.replace(/\s/g, '')) || null
  return null
}

const sku = String(args.sku || '').trim()
const HOST = /grand/i.test(String(args.site || '')) || /grandstage\./.test(sku) ? 'https://grandstage.a-rt.com' : 'https://abcmart.a-rt.com'
const prdtNo = (sku.match(/[?&]prdtNo=(\d+)/) || [])[1] || (/^\d{6,}$/.test(sku) ? sku : null)
const want = String(args.size || '').trim()

for (const t of (await tabs.list()) || []) {
  if (!isOrderUrl(t.url)) continue
  try { await tabs.switch(t.id); if (sameAccount(await emailOnForm())) await tabs.close(t.id) } catch (e) {}
}

const url = prdtNo ? `${HOST}/product?prdtNo=${prdtNo}` : /^https?:/.test(sku) ? sku : `${HOST}/display/search-word/result?searchWord=${encodeURIComponent(sku)}`
const tid = tabIdOf(await tabs.open(withProfile(url)))
if (!tid) return { options: [], error: 'no_tab', note: 'tab open failed' }
await tabs.switch(tid)
if (!prdtNo) {
  await page.waitFor('prdtNo', 8000).catch(() => {})
  const first = lines(await page.get({ selector: 'a[href*="/product?prdtNo="]' }))[0]
  if (!first) { await tabs.close(tid); return { options: [], error: 'no_product', note: 'search no result' } }
  await page.click(parseInt(first.slice(1)))
}
await page.waitFor(/바로구매|판매\s*종료|일시\s*품절|SOLD OUT/, 8000).catch(() => {})
const product_url = await page.url()
const pt = await text()
const productName = ((pt.match(/공유하기 (.{2,120}?) 상품코드 :/) || [])[1] || '').trim()

const all = lines(await page.get({ selector: '.size-list button' })).map(l => ({ id: parseInt(l.slice(1)), t: labelOf(l) })).filter(o => o.t)
const soldIds = new Set(lines(await page.get({ selector: '.size-list button.sold-out' })).map(l => parseInt(l.slice(1))))
const avail = all.filter(o => !soldIds.has(o.id))
const sold = all.filter(o => soldIds.has(o.id))
const options = [...avail.map(o => o.t), ...sold.map(o => `${o.t} 품절`)]
const base = { options, already_ordered: null, coupons: {}, methods: [], cost: null, reward: 0, margin_pct: null, product_url, selected: null, product_name: productName || null }
const stop = async (note, extra = {}) => { await tabs.close(tid).catch(() => {}); return { ...base, note, ...extra } }

if (!/\bLOGOUT\b/.test(pt)) return await stop('로그인 안 됨', { error: 'login_required' })
if (!all.length && /판매 종료 및 중지된 상품/.test(pt)) return await stop('판매 종료 및 중지된 상품', { options: want ? [`${want} 품절`] : [], sale_ended: true })
// 선택지를 못 읽었으면 품절 글자(추천 배지 등)로 판정하지 않는다
if (!all.length && want) return await stop('사이즈 선택지를 읽지 못함(품절 판정 아님)')
if (!avail.length && /판매\s*종료|판매가 종료|일시\s*품절|SOLD OUT/i.test(pt)) return await stop('판매종료·품절 화면 — 모든 옵션 품절')

let picked = null
if (all.length) {
  picked = pickOption(want, avail.map(o => o.t)) || (!want && avail.length === 1 ? avail[0].t : null)
  if (!picked) {
    const s = pickOption(want, sold.map(o => o.t))
    return await stop(s ? `주문 사이즈 ${s} 품절 표시` : `주문 사이즈 "${want}" 선택지에 없음(${all.map(o => o.t).join('·').slice(0, 40)})`)
  }
  await page.click(avail.find(o => o.t === picked).id)
  await page.waitFor(/총 결제금액\s*[1-9]/, 3000).catch(() => {})
}

// 수량: 칸에 직접 입력(실측 2026-09-30)
const WQ=Math.max(1,+args.qty||1);if(WQ>1){const sp=+(((await page.get({interactive:1})).tree.match(/^\[(\d+)\] spinbutton value=/m)||[])[1]||0);if(!sp)return await stop('수량 칸 없음');await page.type(sp,String(WQ),true);await sleep(800)}
const buy = await page.idOf('바로구매')
if (buy < 0) return await stop('바로구매 버튼 없음')
await page.click(buy)
let orderUrl = ''
for (let i = 0; i < 40 && !isOrderUrl(orderUrl) && !/login/i.test(orderUrl); i++) { await sleep(300); orderUrl = await page.url() }
await page.waitFor('결제예정금액', 6000).catch(() => {})
if (/login/i.test(orderUrl)) return await stop('로그인 필요', { error: 'login_required' })
if (!isOrderUrl(orderUrl)) return await stop('주문서로 못 감: ' + orderUrl.slice(0, 80), { error: 'no_checkout' })

// 주문서 읽기 — 이 탭(tid)만
const t = await text()
const email = await emailOnForm()
const account = email.split('@')[0] || null
if (!sameAccount(email)) return { ...base, account, order_tab: tid, note: `주문서 계정 ${account} ≠ profile` }
const cost = num((t.match(/총\s*결제예정금액\s*([\d,]+)\s*원/) || [])[1]) || null
const qty = +((t.match(/\/\s*(\d+)\s*개/) || [])[1] || 0) || null
const reward = num((t.match(/([\d,]+)\s*P\s*적립\s*예정/) || [])[1])
// 주문서 상품 줄 '… 배송 상품 <상품명> 220/ 1 개'
const line = t.match(/배송 상품 (.{2,160}?) ([^\s\/]{1,20})\s*\/\s*(\d+)\s*개/)
const selected = line ? line[2] : null
const methods = lines(await page.get({ selector: 'input[name=rgPaymentModule]' })).map(labelOf).filter(Boolean)
// 기본 배송지(까대기 판정용) — 전화번호 제외
const ship = lines(await page.get({ selector: '#tabAddress1' }))
const addr = ship.filter(x => /\] textbox value="/.test(x)).map(valOf)
const shipping = { name: valOf(ship.find(x => /textbox "이름"/.test(x))).trim(), address: (addr[0] || '').trim(), address_detail: (addr[1] || '').trim() }

// 확인 못 하면(주문내역 못 읽음·예외) null + note
let already_ordered = null, existing_order_no = null, dup_note = '중복 확인 못 함'
const nameKey = ((productName.match(/^[^A-Za-z]{4,}/) || [productName])[0]).trim().split(' ').slice(0, 4).join(' ')
if (nameKey && selected) {
  const hid = tabIdOf(await tabs.open(withProfile(`${HOST}/mypage/claim/claim-order-main`)))
  if (hid) {
    try {
      await tabs.switch(hid)
      await page.waitFor(/주문일시|내역이 없습니다/, 8000).catch(() => {})
      const ot = await text()
      const loaded = /주문일시|내역이 없습니다/.test(ot)
      const part = ot.slice(Math.max(0, ot.indexOf('주문번호')), ot.indexOf('꼭 읽어') > 0 ? ot.indexOf('꼭 읽어') : undefined)
      for (const bk of part.split(/(?=주문번호 \d{10,} 주문일시)/)) {
        const d = bk.match(/주문번호 (\d{10,}) 주문일시 (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/)
        if (!d) continue
        const age = Date.now() - new Date(`${d[2]}T${d[3]}+09:00`).getTime()
        if (age < 0 || age > 3 * 864e5 || /취소완료/.test(bk)) continue
        if (bk.includes(nameKey) && new RegExp(`\\s${esc(selected)}\\s*/\\s*\\d+개`).test(bk)) { already_ordered = true; existing_order_no = d[1]; break }
      }
      if (loaded) { dup_note = null; if (already_ordered === null) already_ordered = false }
    } catch (e) {}
    await tabs.close(hid).catch(() => {})
  }
  await tabs.switch(tid)
}

return { ...base, already_ordered, existing_order_no, methods, cost, qty, reward, selected, account, shipping, order_tab: tid, note: [cost ? null : '결제예정금액 못 읽음', dup_note].filter(Boolean).join(' · ') || null }
