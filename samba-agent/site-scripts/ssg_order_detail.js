const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const raw = nz(args.source_order_no || args.orderNo).toUpperCase()
const no = raw.replace(/[\s-]/g, '')
const R = { source_order_no: raw || null, status: '', paid: 0, points_used: 0, money_paid: 0, reward: 0, card: '', note: null, gift_status: null, gift_accepted: null, gift_evidence: [] }
if (!/^\d{8}[A-Z0-9]{4,}$/.test(no)) return { ...R, note: 'no order number' }
const shown = no.slice(0, 8) + '-' + no.slice(8)
const pf = args.profile ? { profile: args.profile } : {}
// 주문완료 화면 대체 읽기: 상세가 로그인을 요구할 때, 이미 열린 주문완료 탭에서 읽는다
const fromComplete = async () => {
  let list = []
  try { list = await tabs.list() } catch (e) {}
  const c = list.find(x => (!args.profile || x.profile === args.profile) && /orderComplete\.ssg/.test(x.url || '') && (x.url || '').includes(no))
  if (!c) return null
  const prev = (list.find(x => x.active) || {}).id
  try { await tabs.switch(c.id) } catch (e) { return null }
  let t = ''
  try { t = nz(((await page.get({})).tree || '').split('PAGE TEXT:')[1]) } catch (e) {}
  if (prev) { try { await tabs.switch(prev) } catch (e) {} }
  if (!t.includes(no)) return null
  const r = { ...R }
  r.paid = num((t.match(/최종\s*결제\s*금액\s*([\d,]+)\s*원/) || [])[1])
  const h = (t.match(/결제\s*내역\s*(.*?)(이번\s*주문으로|쇼핑\s*계속|$)/) || [])[1] || ''
  r.points_used = [...h.matchAll(/(신세계\s*포인트|적립\s*머니|SSG\s*MONEY\s*적립)\s*([\d,]+)\s*원/g)].reduce((a, m) => a + num(m[2]), 0)
  r.money_paid = [...h.matchAll(/SSG\s*MONEY(?!\s*적립)\s*(?:충전결제)?\s*([\d,]+)\s*원/gi)].reduce((a, m) => a + num(m[1]), 0)
  const cm = h.match(/(SSGPAY-?\s*\S+|SSG\s*MONEY|페이코|네이버페이|카카오페이|토스페이)\s*[\d,]+\s*원\s*\(?\s*((현대|KB국민|국민|롯데|신한|농협|NH|삼성|하나|우리|BC|비씨|씨티)\s*카드)?/i)
  r.card = cm ? nz(cm[1] + (cm[2] ? ' - ' + cm[2] : '')) : ''
  const ben = (t.match(/구매\s*혜택\s*(.*?)(쓱7클럽|쇼핑\s*계속|$)/) || [])[1] || ''
  r.reward = [...ben.matchAll(/(신세계\s*포인트|SSG\s*MONEY)\s*([\d,]+)\s*(P|원)/gi)].filter(m => !/리뷰|후기/.test(ben.slice(Math.max(0, m.index - 12), m.index))).reduce((a, m) => a + num(m[2]), 0)
  r.status = (t.match(/(선물[^.]{0,20}미확인시|결제완료)/) || [])[1] ? (/선물/.test(t) ? '선물 수락 대기' : '결제완료') : '결제완료'
  r.note = '주문완료 화면에서 읽음'
  return r.paid ? r : null
}
const id = (String(await tabs.open({ ...pf, url: 'https://pay.ssg.com/myssg/orderInfoDetail.ssg?orordNo=' + no })).match(/tab (\S+)/) || [])[1]
if (id) await tabs.switch(id)
try { await page.waitFor(/결제\s*정보|로그인/, 10000) } catch (e) {}
const url = await page.url()
const done = async r => { if (id) { try { await tabs.close(id) } catch (e) {} } return r }
if (/member\.ssg\.com|\/member\/login/.test(url)) {
  await done(null)
  const fb = await fromComplete()
  return fb || { ...R, note: 'login required' }
}
const text = ((await page.get({})).tree || '').split('PAGE TEXT:')[1] || ''
const t = nz(text)
if (!t.includes(shown) && !t.includes(no)) return done({ ...R, note: 'order ' + shown + ' not on page' })
R.status = (t.match(/(결제완료|주문접수|상품준비중|배송준비중|배송중|배송완료|구매[\s]*[확]정|취소완료|취소요청|반품\S*|교환\S*|선물\s*수락\s*대기)/) || [])[1] || ''
// 상품준비중·안내문·버튼은 수락 증거가 아니다. 명시된 상태 줄만 읽는다.
const lines = text.split(/\r?\n/).map(nz).filter(Boolean)
const giftStates = new Set()
const giftLabel = /^(?:선물\s*수락\s*상태|선물\s*받기\s*상태|선물\s*상태)\s*[:：]?$/
for (let i = 0; i < lines.length; i++) {
  let value = lines[i]
  let evidence = value
  const labelValue = value.match(/^(?:선물\s*수락\s*상태|선물\s*받기\s*상태|선물\s*상태)\s*[:：]?\s*(.+)$/)
  const labelled = Boolean(labelValue || giftLabel.test(value))
  if (labelValue) value = labelValue[1]
  else if (giftLabel.test(value)) { value = lines[i + 1] || ''; evidence += ': ' + value }
  // 라벨 없는 완료 문구는 버튼/안내일 수도 있으므로 확정하지 않는다.
  if (!labelled && !/^선물\s*(?:수락|받기)\s*(?:대기|취소)$/.test(value)) continue
  const state = value.replace(/\s/g, '').replace(/^선물/, '')
  if (/^(?:수락|받기)(?:완료|대기|취소)$/.test(state)) {
    giftStates.add(state.replace(/^받기/, '수락'))
    R.gift_evidence.push(evidence)
  }
}
if (giftStates.size === 1) {
  R.gift_status = [...giftStates][0]
  R.gift_accepted = R.gift_status === '수락완료'
} else if (giftStates.size > 1) R.gift_status = '확인필요'
const pi = t.search(/결제\s*정보/)
const pay = pi >= 0 ? t.slice(pi, pi + 700) : ''
R.paid = num((pay.match(/총\s*결제\s*금액\s*([\d,]+)\s*원/) || [])[1])
const hist = (pay.match(/결제\s*내역\s*(.*?)(품절 시|구매혜택|받은 총 혜택|$)/) || [])[1] || ''
R.points_used = [...hist.matchAll(/(신세계\s*포인트|적립\s*머니)\s*([\d,]+)\s*원/g)].reduce((a, m) => a + num(m[2]), 0)
R.money_paid = [...hist.matchAll(/SSG\s*MONEY(?!\s*적립)\s*(?:충전결제)?\s*([\d,]+)\s*원/gi)].reduce((a, m) => a + num(m[1]), 0)
const cm = hist.match(/(SSGPAY-?\s*\S+|SSG\s*MONEY|페이코|네이버페이|카카오페이|토스페이)\s*[\d,]+\s*원\s*((현대|KB국민|국민|롯데|신한|농협|NH|삼성|하나|우리|BC|비씨|씨티)\s*카드)?/i)
R.card = cm ? nz(cm[1] + (cm[2] ? ' - ' + cm[2] : '')) : ''
const direct = (hist.match(/신용카드|체크카드/) || [])[0]
const issuers = [...new Set((hist.match(/(?:현대|KB국민|국민|롯데|신한|농협|NH|삼성|하나|우리|BC|비씨|씨티)\s*카드/g) || []).map(nz))]
if (!R.card && R.paid > 0 && direct && issuers.length === 1) R.card = direct + ' - ' + issuers[0]
const ben = (t.match(/구매\s*혜택\s*(.*?)받은\s*총\s*혜택/) || [])[1] || ''
R.reward = [...ben.matchAll(/(신세계\s*포인트|SSG\s*MONEY)\s*([\d,]+)\s*(P|원)/gi)].filter(m => !/리뷰|후기/.test(ben.slice(Math.max(0, m.index - 12), m.index))).reduce((a, m) => a + num(m[2]), 0)
if (!R.paid) R.note = '총 결제금액을 읽지 못함'
return done(R)