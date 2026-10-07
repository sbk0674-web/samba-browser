const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const key = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const pf = args.profile ? { profile: args.profile } : {}
const R = { found: false, product_url: null, name: null, model: null, item_id: null, price: null, candidates: [], note: null }
const srcKey = key(args.source_url)
const isSiteCode = t => { const k = key(t); return /^LE\d+$/.test(k) || (k.length >= 5 && /^LE\d/.test(k) && srcKey.includes(k)) }
const toks = (String(args.name || '').toUpperCase().match(/[A-Z0-9][A-Z0-9_-]{4,}/g) || []).filter(t => /[A-Z]/.test(t) && /\d/.test(t) && !isSiteCode(t))
const models = []
for (const t of [args.model, ...toks]) { const v = nz(t); if (v && !isSiteCode(v) && !models.some(x => key(x) === key(v))) models.push(v) }
if (!models.length) return { ...R, note: '품번 없음(롯데온 상품코드만 있음): ' + nz(args.model) }
let model = ''
for (const m of models.slice(0, 3)) {
  model = m
  const r = await tabs.open({ ...pf, url: 'https://www.ssg.com/search.ssg?target=all&query=' + encodeURIComponent(m) })
  const id = (String(r).match(/tab (\S+)/) || [])[1]
  if (id) await tabs.switch(id)
  let T = ''
  for (let i = 0; i < 10; i++) { await sleep(1200); T = String((await page.get({})).tree || ''); if (/검색결과|검색한 결과|상품이 없|Access Denied|차단/i.test(T)) break }
  if (/Access Denied|차단|px-captcha/i.test(T)) { if (id) { try { await tabs.close(id) } catch (e) {} } return { ...R, error: 'blocked', note: 'SSG 봇 차단' } }
  await sleep(1500)
  T = String((await page.get({ selector: 'a[href*="itemView.ssg"]' })).tree || '')
  if (id) { try { await tabs.close(id) } catch (e) {} }
  for (const l of T.split('\n')) {
    const mm = l.match(/^\[\d+\] link "([^"]*)" href=(https:\/\/[a-z.]*ssg\.com\/item\/itemView\.ssg\?itemId=(\d+)[^\s"]*)/)
    if (!mm) continue
    const [, text, url, itemId] = mm
    if (!key(text).includes(key(m))) continue
    const site = (url.match(/siteNo=(\d+)/) || [])[1] || ''
    if (site && site !== '6004' && site !== '6009') continue
    const price = num((text.match(/판매가격\s*([\d,]+)원/) || [])[1])
    if (!price) continue
    if (R.candidates.some(c => c.item_id === itemId)) continue
    R.candidates.push({ item_id: itemId, url, name: nz(text.replace(/\s*(쿠폰할인|정상가격.*|판매가격.*)$/g, '')), price, site })
  }
  if (R.candidates.length) break
}
R.model = model
if (!R.candidates.length) return { ...R, note: 'SSG 검색에 품번 상품 없음(신세계몰·백화점): ' + models.join(',') }
R.candidates.sort((a, b) => a.price - b.price)
const best = R.candidates[0]
return { ...R, found: true, product_url: best.url.replace('://www.ssg.com', '://pay.ssg.com'), www_url: best.url, name: best.name, item_id: best.item_id, price: best.price }