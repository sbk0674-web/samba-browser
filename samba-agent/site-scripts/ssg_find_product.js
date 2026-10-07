// SSG 같은 상품 찾기(2026-10-06, 롯데온 ↔ SSG 교차 비교용): 모델코드로 SSG.COM 통합검색을 돌려 상품명에 모델코드가 있는
// 신세계몰(6004)·신세계백화점(6009) 상품 가운데 표시 판매가가 가장 싼 것을 돌려준다. 실제 원가는 ssg_product_snapshot 이
// 주문서(쿠폰·결제수단)로 다시 본다. 결제·장바구니 없음. 다나와 페이지는 레인에서 판매처 목록이 안 떠 쓰지 않는다.
// 인자 {model?, name?(상품명 — model 이 없으면 여기서 모델코드), source_url?(쓰지 않는다), option?, profile?}
// 반환 {found, product_url, name, model, item_id, price, candidates, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const key = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const pf = args.profile ? { profile: args.profile } : {}
const R = { found: false, product_url: null, name: null, model: null, item_id: null, price: null, candidates: [], note: null }
const model = nz(args.model || (String(args.name || '').match(/\b[A-Z]{1,4}\d{3,6}[A-Z0-9]{0,4}(?:[ _-]\d{3})?\b/) || [])[0])
if (!model) return { ...R, note: 'model 필요(예: II7406-105)' }
const id = (String(await tabs.open({ ...pf, url: 'https://www.ssg.com/search.ssg?target=all&query=' + encodeURIComponent(model) })).match(/tab (\S+)/) || [])[1]
if (id) await tabs.switch(id)
let T = ''
for (let i = 0; i < 10; i++) { await sleep(1200); T = String((await page.get({})).tree || ''); if (/검색결과|검색한 결과|상품이 없|Access Denied|차단/i.test(T)) break }
if (/Access Denied|차단|px-captcha/i.test(T)) { if (id) { try { await tabs.close(id) } catch (e) {} } return { ...R, error: 'blocked', note: 'SSG 봇 차단' } }
// 전체 트리는 요소 수 상한에 잘린다(검색 결과가 770개 넘게 숨음) — 상품 링크만 selector 로 모은다
await sleep(1500)
T = String((await page.get({ selector: 'a[href*="itemView.ssg"]' })).tree || '')
// 상품 링크 한 줄: link "브랜드 상품명 모델 … 판매가격 N원" href=…itemView.ssg?itemId=…&siteNo=…
for (const l of T.split('\n')) {
  const m = l.match(/^\[\d+\] link "([^"]*)" href=(https:\/\/[a-z.]*ssg\.com\/item\/itemView\.ssg\?itemId=(\d+)[^\s"]*)/)
  if (!m) continue
  const [, text, url, itemId] = m
  if (!key(text).includes(key(model))) continue
  const site = (url.match(/siteNo=(\d+)/) || [])[1] || ''
  // 신세계몰·신세계백화점만(사용자 2026-09-27) — 이마트·트레이더스 등은 후보가 아니다
  if (site && site !== '6004' && site !== '6009') continue
  const price = num((text.match(/판매가격\s*([\d,]+)원/) || [])[1])
  if (!price) continue
  if (R.candidates.some(c => c.item_id === itemId)) continue
  R.candidates.push({ item_id: itemId, url, name: nz(text.replace(/\s*(쿠폰할인|정상가격.*|판매가격.*)$/g, '')), price, site })
}
if (id) { try { await tabs.close(id) } catch (e) {} }
R.model = model
if (!R.candidates.length) return { ...R, note: 'SSG 검색에 모델코드 상품 없음(신세계몰·백화점): ' + model }
R.candidates.sort((a, b) => a.price - b.price)
const best = R.candidates[0]
return { ...R, found: true, product_url: best.url, name: best.name, item_id: best.item_id, price: best.price }
