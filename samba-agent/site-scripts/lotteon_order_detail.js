const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const no = nz(args.source_order_no || args.orderNo).replace(/\D/g, '')
const R = { source_order_no: no || null, status: '', paid: 0, points_used: 0, reward: 0, card: '', note: null }
if (!/^\d{12,20}$/.test(no)) return { ...R, note: 'no order number' }
const pf = args.profile ? { profile: args.profile } : {}
const id = (String(await tabs.open({ ...pf, url: 'https://www.lotteon.com/p/order/mylotte/orderDeliveryList' })).match(/tab (\S+)/) || [])[1]
if (id) await tabs.switch(id)
const done = async r => {
  for (const x of await tabs.list()) if (x.id === id || (x.url || '').includes('odNo=' + no)) { try { await tabs.close(x.id) } catch (e) {} }
  return r
}
try { await page.waitFor(/주문\/배송 내역|로그인/, 15000) } catch (e) {}
if (/login/i.test(await page.url())) return done({ ...R, note: 'login required' })
try { await page.waitFor(new RegExp(no), 12000) } catch (e) {}
const g = await page.get({})
const text = String(g.tree || '').split('PAGE TEXT')[1] || ''
if (!text.includes(no)) return done({ ...R, note: 'order not in list' })
const order = [...text.matchAll(/\b(\d{16})\b/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i)
const idx = order.indexOf(no)
// 기본 스냅샷엔 상세보기 버튼이 빠질 수 있어 query 로 읽는다
const gg = await page.get({ query: '상세보기' })
const btns = String(gg.tree || '').split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\] button "상세보기"/.test(l))
if (idx < 0 || !btns[idx]) return done({ ...R, note: 'detail button not found' })
await page.click(parseInt(btns[idx].slice(1)))
try { await page.waitFor(/결제\s*정보/, 12000) } catch (e) {}
const t = nz(String((await page.get({})).tree || '').split('PAGE TEXT')[1] || '')
if (!t.includes(no)) return done({ ...R, note: 'detail page is another order' })
R.status = (t.match(/(결제\s?완료|상품준비중|출고지시|배송중|배송완료|구매\s?확정|취소완료|취소요청)(?!\s*시)/) || [])[1] || ''
for (const m of t.matchAll(/([가-힣A-Za-z.]*적립예정)\s*([\d,]+)\s*P/g)) if (!/리뷰/.test(m[1])) R.reward += num(m[2])
const pay = (t.split(/결제\s*정보/)[1] || '').split(/현금영수증|목록보기|최근본상품/)[0]
const methods = []
for (const m of pay.matchAll(/([가-힣A-Za-z.\s]+?)\s*결제\s?완료\s*([\d,]+)\s*(원|P)/g)) {
  const name = nz(m[1]); const amt = num(m[2])
  if (m[3] === 'P' || /포인트|적립금|L\.POINT/.test(name)) R.points_used += amt
  else { R.paid += amt; methods.push(name) }
}
R.card = methods.join(' + ')
if (/네이버페이/.test(R.card)) R.reward += Math.round(R.paid * 0.01)
if (!R.paid && !R.points_used) R.note = 'payment info not read'
return done(R)