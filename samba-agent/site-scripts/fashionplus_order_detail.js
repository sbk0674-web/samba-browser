// 패션플러스 주문 상세(/mypage/order/detail/<번호>)를 읽는다 — 주문을 바꾸거나 취소하지 않는다. 2026-09-27 새 계약.
// source_order_no 가 없으면 주문 관리(/mypage/order) 맨 위(가장 최근) 주문을 읽고 note 에 남긴다
// 적립은 상세에 나오지 않는다(reward 0 — 하네스가 견적 적립을 쓴다). 카드사도 안 나온다(결제수단 '네이버 페이' 등)
// args: source_order_no, orderNo, site, profile · 반환 {source_order_no,status,paid,points_used,coupon,reward,card,account,order_date,product_no,option,note}
const H = 'https://www.fashionplus.co.kr'
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const tabId = r => (String(r).match(/tab (\S+)/) || [])[1] || null
const P = args.profile ? { profile: args.profile } : {}
const text = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
let no = String(args.source_order_no || '').replace(/\D/g, '')
let note = null
const opened = []
const open = async url => { const id = tabId(await tabs.open({ ...P, url })); if (id) { opened.push(id); await tabs.switch(id) } return id }
const done = async r => { for (const id of opened) { try { await tabs.close(id) } catch (e) {} } return r }
if (!no) {
  await open(`${H}/mypage/order`)
  if (!(await page.waitFor(/신청일|내역이 없/, 10000))) return done({ source_order_no: null, paid: null, note: 'order list unreadable' })
  const m = (await page.get({})).tree.match(/href=\/mypage\/order\/detail\/(\d+)/)
  if (!m) return done({ source_order_no: null, paid: null, note: 'no orders' })
  no = m[1]
  note = 'source_order_no 없음 — 가장 최근 주문을 읽음'
}
await open(`${H}/mypage/order/detail/${no}`)
if (/login/i.test(await page.url())) return done({ source_order_no: no, paid: null, error: 'login_required', note: '로그인 필요' })
if (!(await page.waitFor('결제수단 정보', 10000))) return done({ source_order_no: no, paid: null, note: 'detail not loaded: ' + (await page.url()).slice(0, 80) })
await sleep(500)
const tr = (await page.get({})).tree
const t = (tr.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const got = (t.match(/주문 상세 (\d+) \(신청일: (\d{4}-\d\d-\d\d)\)/) || [])
const item = tr.match(/link "(.*?) 옵션 (.+?)" href=\/goods\/detail\/(\d+)/)
const status = (t.match(/옵션 .+? (결제완료|입금대기|배송준비중|배송중|배송완료|구매확정|취소신청|취소완료|반품\S*|교환\S*|환불\S*)(?: 배송조회)? \d+개/) || [])[1] || null
const method = ((t.match(/결제수단 정보 결제수단 (.+?) 결제승인일/) || [])[1] || '').trim()
const email = (t.match(/이메일 ([\w.+-]+)@/) || [])[1] || null
return done({
  source_order_no: got[1] || null,
  order_date: got[2] || null,
  status,
  paid: num((t.match(/결제금액 ([\d,]+)원/) || [])[1]) || null,
  points_used: num((t.match(/적립금 사용 - ([\d,]+)/) || [])[1]),
  coupon: num((t.match(/쿠폰할인 - ([\d,]+)/) || [])[1]),
  reward: 0,
  card: method.replace(/네이버 페이/, '네이버페이') || null,
  account: email,
  product_no: item ? item[3] : null,
  option: item ? item[2].trim() : null,
  note
})
