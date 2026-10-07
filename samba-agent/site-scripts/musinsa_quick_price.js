// 무신사 계정별 빠른 가격(2026-09-26 재작성): 상품 페이지의 '나의 할인가'와 그 내역·적립 내역만 읽는다(주문서 안 만듦). 자기가 연 탭만 쓰고 닫는다.
// 하네스 점수 = my_price − max_reward. 원가 공식(결제액 − 적립 + 사용 적립금)과 맞추려고:
//  my_price   = 나의 할인가 + 그 안에 든 '보유 적립금 사용'(적립금 많은 계정이 싸 보이지 않게 되더한다)
//  max_reward = 무신사머니 결제 적립 + 등급 구매 적립(선할인이 가격에 이미 들었으면 0). 후기 적립·무신사 삼성카드 적립은 뺀다
// 반환 {my_price, max_reward, list_price, shown_price, points_in_price, prepay_in_price, grade_reward, pay_reward, logged_in, sold_out, product_url, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const code = (String(args.sku || '').match(/products\/(\d+)|^(\d{5,})$/) || []).slice(1).find(Boolean)
const R = { my_price: null, max_reward: 0, list_price: null, shown_price: null, points_in_price: 0, pay_discount_in_price: 0, prepay_in_price: 0, grade_reward: 0, pay_reward: 0, logged_in: null, sold_out: false, product_url: code ? 'https://www.musinsa.com/products/' + code : null, note: null }
if (!code) return { ...R, note: 'no product code in sku' }
const get = async o => { for (let i = 0; i < 5; i++) { try { return (await page.get(o)).tree } catch (e) { await sleep(500) } } return '' }
const id = (String(await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: R.product_url })).match(/tab (\S+)/) || [])[1]
if (!id) return { ...R, note: 'tab not opened' }
await tabs.switch(id)
try { await page.waitFor(/나의 할인가|판매 ?종료|재입고 알림 신청/, 8000) } catch (e) {}
const full = await get({ interactive: 1 })
R.logged_in = /"로그아웃"/.test(full) ? true : /link "로그인/.test(full) ? false : null
// 가격·혜택 칸: 두 '펼치기'(혜택 상세·적립 상세)를 눌러 내역을 드러낸다
const box = await get({ selector: '[class*=Benefit]', interactive: 1 })
for (const l of box.split('\n').filter(x => /^\[\d+\] button "(혜택|적립) 상세 펼치기"/.test(x))) { try { await page.click(parseInt(l.slice(1))) } catch (e) {} }
await sleep(400)
const tx = nz((await get({ selector: '[class*=Benefit]' })).split('PAGE TEXT:')[1])
const pr = nz((await get({ selector: '[class*=Price]' })).split('PAGE TEXT:')[1])
try { await tabs.close(id) } catch (e) {}

const my = tx.match(/([\d,]+)원\s*나의 할인가/)
if (!my) {
  const t = nz((full.split('PAGE TEXT:')[1] || ''))
  R.sold_out = /판매 ?종료/.test(t) || /button "(품절|일시품절|재입고 알림 신청)"/.test(full)
  return { ...R, note: R.sold_out ? 'sold out (판매 종료/품절 화면)' : R.logged_in === false ? '로그인 필요' : '나의 할인가 읽지 못함' }
}
R.shown_price = num(my[1])
// 정가: 가격 칸 첫 '69,000원 41% 40,990원' 묶음(할인 없으면 첫 가격)
const lp = pr.match(/([\d,]+)원\s*\d+%\s*[\d,]+원/) || pr.match(/([\d,]+)원/)
R.list_price = lp ? num(lp[1]) : null
// 나의 할인가 내역(첫 번째 반복 구간만 본다)
const d = tx.slice(tx.indexOf('나의 할인가'), tx.indexOf('최대 적립') > 0 ? tx.indexOf('최대 적립') : undefined)
// '적립금 사용 보유 적립금 사용 (현재 X원 보유) -N원' / '… 사용 제한'
const pts = d.slice(d.indexOf('적립금 사용'), d.indexOf('구매 적립 / 선할인') > 0 ? d.indexOf('구매 적립 / 선할인') : undefined)
R.points_in_price = /사용 제한/.test(pts) ? 0 : num((pts.match(/-([\d,]+)원/) || [])[1])
// '구매 적립 / 선할인 … 1,450원 -1,450원' — '-N원'이 있으면 선할인이 가격에 들었다. '선할인 불가 540원'이면 구매 적립만
const ps = (d.split('구매 적립 / 선할인')[1] || '').split(/제휴카드|무신사머니 최대|무신사 삼성카드/)[0]
R.prepay_in_price = num((ps.match(/-([\d,]+)원/) || [])[1])
// 적립 내역: 등급 적립, 결제수단 적립(무신사 삼성카드 줄 제외), 후기 적립은 뺀다
const rw = tx.slice(tx.indexOf('최대 적립'))
const grade = num((rw.match(/등급 적립 \([^)]*\)\s*([\d,]+)원/) || [])[1]) || num((ps.match(/([\d,]+)원/) || [])[1])
R.grade_reward = R.prepay_in_price ? 0 : grade
R.pay_reward = num((rw.match(/무신사머니 결제 시 [\d.]+% 적립\s*([\d,]+)원/) || [])[1])
// 결제수단 즉시할인(2026-10 신설: 토스페이×계좌 9만원 이상 -9,000원 등) — 나의 할인가에 가장 큰 것이 들어 있다.
// 주문서 총액은 수단을 고르기 전이라 이 할인이 없다 → 적립금처럼 되더해 주문서와 같은 기준으로 맞춘다
const pd = (d.split('결제수단 즉시할인')[1] || '').split(/적용 안함|최대 적립/)[0]
R.pay_discount_in_price = Math.max(0, ...[...pd.matchAll(/-([\d,]+)원/g)].map(m => num(m[1])))
R.my_price = R.shown_price + R.points_in_price + R.pay_discount_in_price
R.max_reward = R.grade_reward + R.pay_reward
R.note = /적립 상세|등급 적립/.test(rw) ? null : '적립 내역을 못 펼침 — 결제수단 적립 0으로 둠'
return R
