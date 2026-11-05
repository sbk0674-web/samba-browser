// SSG 쿠폰 받기(2026-11-05) — 상품 페이지 '쿠폰보기' 레이어의 '쿠폰 받기'(dialog_coupon_btn)를 눌러 쓱데이 등 받아야 쓰는 쿠폰을 먼저 받는다.
// 주문서 '최대 할인혜택 바로 적용'은 이미 받은 쿠폰만 쓴다 — 안 받으면 쿠폰할인 0원으로 결제됐다(HV2181-084: 52,955원 vs 쿠폰가 46,601원).
// args: sku(상품 주소 또는 itemId), profile · 반환 {ok, clicked, issued:[안내 글자], note}
const profile = String(args.profile || '').trim()
let u = String(args.sku || '')
if (/^\d+$/.test(u)) u = 'https://www.ssg.com/item/itemView.ssg?itemId=' + u
if (!/^https:\/\/[^/]*ssg\.com\//.test(u)) return { ok: true, clicked: false, issued: [], note: 'SSG 상품 주소 아님' }
const before = new Set(((await tabs.list()) || []).map(t => t.id))
const close = async () => { for (const t of (await tabs.list()) || []) if (!before.has(t.id)) { try { await tabs.close(t.id) } catch (e) {} } }
await tabs.open({ url: u, profile: profile || undefined }); await sleep(4500)
const lines = async () => String(((await page.get({})) || {}).tree || '').split('PAGE TEXT')[0].split('\n')
let L = [], view = null
for (let i = 0; i < 8 && !view; i++) { L = await lines(); view = L.find(l => /^\[\d+\] (?:button|clickable) "쿠폰(?:보기|받기)"/.test(l)); if (!view) await sleep(1500) }
if (!view) { await close(); return { ok: true, clicked: false, issued: [], note: '쿠폰보기 없음' } }
await page.clickNative(parseInt(view.slice(1))); await sleep(2500)
L = await lines()
const btns = L.filter(l => /^\[\d+\] button "[^"]*쿠폰\s*받기/.test(l)).map(l => parseInt(l.slice(1))).filter(id => id !== parseInt(view.slice(1)))
const issued = []
const done = async () => String(((await page.get({ selector: '[class*=coupon]' })) || {}).tree || '').split('PAGE TEXT')[1] || ''
for (const id of btns) {
  try { await page.clickNative(id) } catch (e) { continue }
  await sleep(1500)
  try { await page.dismissOverlay() } catch (e) {}
}
// 레이어의 '쿠폰 받기'(dialog_coupon_btn)는 접근성 트리에 버튼으로 안 잡힌다 — 글자로 누른다(다운 가능 쿠폰이 남은 동안 최대 4번)
let clicks = btns.length
for (let i = 0; i < 4 && /다운 가능/.test(await done()); i++) {
  try { await page.clickText('쿠폰 받기') } catch (e) { break }
  clicks++
  await sleep(1500)
  try { await page.dismissOverlay() } catch (e) {}
}
const t = await done()
for (const m of t.matchAll(/([^\s]+(?:\s[^\s]+){0,4}\s할인쿠폰\s[\d,]+원)[^다]{0,40}다운완료/g)) issued.push(m[1])
await close()
return { ok: true, clicked: clicks > 0, issued: [...new Set(issued)], left: /다운 가능/.test(t), note: clicks ? null : '쿠폰 받기 버튼 없음(받을 쿠폰 없음)' }
