// 롯데온 주문 상세(2026-10-01, 로그인 실측): 계정 profile 로 주문/배송 내역을 열어 그 주문번호 줄의 '상세보기'를 눌러
// 결제 값을 읽고 탭을 닫는다. 선물 주문은 /p/order/claim/giftBoxDetail?odNo=…&type=snd 로 열린다. 주문을 바꾸지 않는다.
// 실측 화면: '총 결제금액 29,000원 L.POINT 적립 예정 상세보기 구매적립예정 150P … 결제정보 카카오페이 머니 결제완료 25,499원
// 2026.10.01 L.POINT 결제완료 3,501P 2026.10.01 현금영수증 …'
// 원가 = paid × 카드 청구할인 − reward + points_used. reward = '…적립예정 NP'(리뷰 적립 제외), points_used = 결제정보의 L.POINT 등 포인트 사용
// 인자 {source_order_no, orderNo?, profile?}  반환 {source_order_no, status, paid, points_used, reward, card, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const no = nz(args.source_order_no || args.orderNo).replace(/\D/g, '')
const R = { source_order_no: no || null, status: '', paid: 0, points_used: 0, reward: 0, card: '', note: null }
if (!/^\d{12,20}$/.test(no)) return { ...R, note: 'no order number' }
const pf = args.profile ? { profile: args.profile } : {}
const id = (String(await tabs.open({ ...pf, url: 'https://www.lotteon.com/p/order/mylotte/orderDeliveryList' })).match(/tab (\S+)/) || [])[1]
if (id) await tabs.switch(id)
// 상세보기는 새 탭(giftBoxDetail·orderDetail)으로 열린다 — 목록 탭과 그 주문 상세 탭을 모두 닫는다
const done = async r => {
  for (const x of await tabs.list()) if (x.id === id || (x.url || '').includes('odNo=' + no)) { try { await tabs.close(x.id) } catch (e) {} }
  return r
}
try { await page.waitFor(/주문\/배송 내역|로그인/, 15000) } catch (e) {}
if (/login/i.test(await page.url())) return done({ ...R, note: 'login required' })
// 목록은 늦게 그려진다 — 그 주문번호가 보일 때까지 기다린다
try { await page.waitFor(new RegExp(no), 12000) } catch (e) {}
// 그 주문번호 뒤에 나오는 첫 '상세보기' 버튼
const g = await page.get({})
const tree = String(g.tree || '')
const lines = tree.split('PAGE TEXT')[0].split('\n')
const text = tree.split('PAGE TEXT')[1] || ''
if (!text.includes(no)) return done({ ...R, note: 'order not in list (1년 내 주문내역에 없음)' })
// 목록의 주문번호 순서 = 상세보기 버튼 순서(주문마다 하나)
const order = [...text.matchAll(/\b(\d{16})\b/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i)
const idx = order.indexOf(no)
const btns = lines.filter(l => /^\[\d+\] button "상세보기"/.test(l))
if (idx < 0 || !btns[idx]) return done({ ...R, note: 'detail button not found' })
await page.click(parseInt(btns[idx].slice(1)))
try { await page.waitFor(/결제정보/, 12000) } catch (e) {}
const t = nz(String((await page.get({})).tree || '').split('PAGE TEXT')[1] || '')
if (!t.includes(no)) return done({ ...R, note: 'detail page is another order' })
// '구매적립은 구매확정 시 적립됩니다' 같은 안내 글은 상태가 아니다
R.status = (t.match(/(결제완료|상품준비중|출고지시|배송중|배송완료|구매확정|취소완료|취소요청)(?!\s*시)/) || [])[1] || ''
// 적립 예정 — 리뷰 적립은 원가에서 빼지 않는다
for (const m of t.matchAll(/([가-힣A-Za-z.]*적립예정)\s*([\d,]+)\s*P/g)) if (!/리뷰/.test(m[1])) R.reward += num(m[2])
const pay = (t.split('결제정보')[1] || '').split(/현금영수증|목록보기|최근본상품/)[0]
const methods = []
for (const m of pay.matchAll(/([가-힣A-Za-z.\s]+?)\s*결제완료\s*([\d,]+)\s*(원|P)/g)) {
  const name = nz(m[1]); const amt = num(m[2])
  if (m[3] === 'P' || /포인트|적립금|L\.POINT/.test(name)) R.points_used += amt
  else { R.paid += amt; methods.push(name) }
}
R.card = methods.join(' + ')
// 네이버페이 기본 적립(결제액 1%)은 롯데온 상세에 안 나온다 — 견적과 같은 규칙으로 더한다(사용자 2026-09-25 원가 공식)
if (/네이버페이/.test(R.card)) R.reward += Math.round(R.paid * 0.01)
if (!R.paid && !R.points_used) R.note = 'payment info not read'
return done(R)
