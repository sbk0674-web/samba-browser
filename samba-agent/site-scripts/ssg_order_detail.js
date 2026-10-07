const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const raw = nz(args.source_order_no || args.orderNo).toUpperCase()
const no = raw.replace(/[\s-]/g, '')
const R = { source_order_no: raw || null, status: '', paid: 0, points_used: 0, money_paid: 0, reward: 0, card: '', note: null }
if (!/^\d{8}[A-Z0-9]{4,}$/.test(no)) return { ...R, note: 'no order number' }
const shown = no.slice(0, 8) + '-' + no.slice(8)
const pf = args.profile ? { profile: args.profile } : {}
const id = (String(await tabs.open({ ...pf, url: 'https://pay.ssg.com/myssg/orderInfoDetail.ssg?orordNo=' + no })).match(/tab (\S+)/) || [])[1]
if (id) await tabs.switch(id)
try { await page.waitFor(/결제\s*정보|로그인/, 10000) } catch (e) {}
const url = await page.url()
const done = async r => { if (id) { try { await tabs.close(id) } catch (e) {} } return r }
if (/member\.ssg\.com|\/member\/login/.test(url)) return done({ ...R, note: 'login required' })
const t = nz(((await page.get({})).tree || '').split('PAGE TEXT:')[1])
if (!t.includes(shown) && !t.includes(no)) return done({ ...R, note: 'order ' + shown + ' not on page' })
R.status = (t.match(/(결제완료|주문접수|상품준비중|배송준비중|배송중|배송완료|구매[\s]*[확]정|취소완료|취소요청|반품\S*|교환\S*|선물\s*수락\s*대기)/) || [])[1] || ''
const pi = t.search(/결제\s*정보/)
const pay = pi >= 0 ? t.slice(pi, pi + 700) : ''
R.paid = num((pay.match(/총\s*결제\s*금액\s*([\d,]+)\s*원/) || [])[1])
const hist = (pay.match(/결제\s*내역\s*(.*?)(품절 시|구매혜택|받은 총 혜택|$)/) || [])[1] || ''
R.points_used = [...hist.matchAll(/(신세계\s*포인트|적립\s*머니)\s*([\d,]+)\s*원/g)].reduce((a, m) => a + num(m[2]), 0)
R.money_paid = [...hist.matchAll(/SSG\s*MONEY(?!\s*적립)\s*(?:충전결제)?\s*([\d,]+)\s*원/gi)].reduce((a, m) => a + num(m[1]), 0)
const cm = hist.match(/(SSGPAY-?\s*\S+|SSG\s*MONEY|페이코|네이버페이|카카오페이|토스페이)\s*[\d,]+\s*원\s*((현대|KB국민|국민|롯데|신한|농협|NH|삼성|하나|우리|BC|비씨|씨티)\s*카드)?/i)
R.card = cm ? nz(cm[1] + (cm[2] ? ' - ' + cm[2] : '')) : ''
const ben = (t.match(/구매\s*혜택\s*(.*?)받은\s*총\s*혜택/) || [])[1] || ''
R.reward = [...ben.matchAll(/(신세계\s*포인트|SSG\s*MONEY)\s*([\d,]+)\s*(P|원)/gi)].filter(m => !/리뷰|후기/.test(ben.slice(Math.max(0, m.index - 12), m.index))).reduce((a, m) => a + num(m[2]), 0)
if (!R.paid) R.note = '총 결제금액을 읽지 못함'
return done(R)