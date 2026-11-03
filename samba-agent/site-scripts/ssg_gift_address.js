// SSG 선물 받는 분 지정(2026-09-29 수동 성공 이식): 선물 정보 화면 '배송지 대신 입력하기' → 주소록 팝업(selectShpplocPopup)에서
// 고객 항목(도로명 조각+상세 앞 6자+이름 앞부분 — SSG 는 이름의 '*' 를 빼고 저장한다) 하나를 체크 → 선택완료 → 선물 화면 되읽기
// → 계속하기 → 주문서(ordPage). 주소록에 없으면 팝업의 '배송지 추가'로 목록 팝업(shpplocList)을 열어 두고 need_address 를 돌려준다
// (하네스가 ssg_set_shipping{gift:true} → 전화 → ssg_gift_save_address 뒤 다시 부른다). 고객 글자는 결과에 싣지 않는다.
// 인자 {name, address, address_detail}  반환 {ok, order_tab, amount, gift, need_address?, entries, matched, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const recipientName = nz(nz(args.name).replace(/\*/g, 'ㅇ').replace(/[^\p{L}\p{M}\p{N} ]/gu, ''))
const sq = s => String(s || '').replace(/\s+/g, '')
const R = { ok: false, order_tab: null, amount: null, gift: false, entries: 0, matched: 0, note: null }
if (!recipientName || !nz(args.address)) return { ...R, note: 'name·address 필요' }
const base = recipientName
// 도로명은 띄어쓴 주소에서 마지막 낱말만 — 공백을 먼저 빼면 '부산 …구 …로' 전체가 잡혀 SSG 의 '부산광역시 …' 항목과 안 맞는다(실기 2026-09-30)
const rm = nz(args.address).match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/)
const road = rm ? rm[1] + rm[2] : ''
// 상세는 '(' 앞까지 앞 6자 — 주문 상세 '수서1단지(SH빌리지) 102동' 은 주소록에 '수서1단지 102동' 으로 저장돼 '(' 가 키에 들면 영원히 안 맞는다(실기 2026-10-20 SSG 2706)
const det = sq(nz(args.address_detail).split('(')[0]).slice(0, 6) || sq(args.address_detail).slice(0, 6)
// 마스킹 이름 'ㅇ' 은 한 글자 아무거나 — 주문 '강*우' 는 주소록 '강지우' 와 같은 사람이다(도로명·상세가 함께 맞아야 통과)
// 이름은 공백 없이 앞 8자·대소문자 무시 — 긴 영문 이름은 SSG 가 잘라 저장한다(실기 2026-11-03 4076)
const nk = sq(base).toLowerCase().slice(0, 8)
const nameRe = new RegExp(nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ㅇ/g, '[가-힣ㅇ]'))
const hasName = t => nameRe.test(sq(t).toLowerCase())
const mine = b => { const x = sq(b); return (!road || x.includes(road)) && (!det || x.includes(det)) && hasName(b) }
const tree = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(400) } return '' }
const idL = l => parseInt(l.slice(1))
const findTab = async re => (await tabs.list()).find(t => re.test(t.url || ''))
const waitTab = async (re, n) => { for (let i = 0; i < n; i++) { const t = await findTab(re); if (t) return t; await sleep(500) } return null }
const gift = await findTab(/pay\.ssg\.com\/cart\/giftInfo/)
if (!gift) return { ...R, note: '선물 정보 화면 없음' }
await tabs.switch(gift.id)
const blocks = async () => (await tree({})).split('PAGE TEXT')[0].split(/\n(?=\[\d+\] checkbox)/).filter(x => /^\[\d+\] checkbox/.test(x))
// 닫히는 중인 옛 주소록 창과 새 창이 겹치면 새 창이 비거나 사라진다(실기 2026-09-30: 직전에 창을 닫고 바로 열면 0개) —
// 옛 창을 먼저 닫고 잠시 기다린 뒤 연다. 그래도 비면 한 번 더 연다
let bs = [], pop = null
for (let k = 0; k < 2 && !bs.length; k++) {
  for (const t of await tabs.list()) { if (t.kind === 'popup' && /selectShpploc|member\.ssg\.com/.test(t.url || '')) { try { await tabs.close(t.id) } catch (e) {} } }
  await sleep(1500)
  await tabs.switch(gift.id)
  const b0 = (await tree({ interactive: true })).split('\n').find(l => /^\[\d+\] link "배송지 대신 입력하기"/.test(l))
  if (!b0) return { ...R, note: '배송지 대신 입력하기 없음' }
  await page.click(idL(b0))
  pop = await waitTab(/selectShpploc/, 20)
  if (!pop) continue
  await tabs.switch(pop.id)
  try { await page.waitFor(/선택완료/, 8000) } catch (e) {}
  await sleep(800)
  // 주소록은 늦게 그려진다 — 항목이 보일 때까지 창을 다시 찾아 옮기며 몇 번 더 읽는다
  bs = await blocks()
  for (let i = 0; i < 6 && !bs.length; i++) { await sleep(1000); const p2 = await findTab(/selectShpploc/); if (p2) await tabs.switch(p2.id); bs = await blocks() }
}
if (!pop) return { ...R, note: '주소록 팝업 안 뜸' }
R.entries = bs.length
let hit = bs.filter(mine)
R.matched = hit.length
if (!hit.length) {
  const it = (await tree({ interactive: true })).split('\n')
  const add = it.find(l => /^\[\d+\] (?:link|button) "[^"]*배송지 ?(?:추가|등록)/.test(l))
  // 못 찾으면 어떤 버튼이 있었는지 남긴다(실기 2026-10-01: 주소록 1개인데 추가 링크를 못 찾음)
  if (!add) return { ...R, note: '주소록에 없고 배송지 추가 버튼도 없음 — ' + it.filter(l => /(?:link|button) "[^"]*(?:배송지|추가|등록|입력)/.test(l)).map(l => l.replace(/^\[\d+\] /, '')).join(' | ').slice(0, 200) }
  await page.click(idL(add))
  const lp = await waitTab(/shpplocList/, 16)
  return { ...R, need_address: true, note: lp ? '주소록에 없음 — 배송지 추가 목록을 열어 둠' : '배송지 추가 목록이 안 뜸' }
}
// 도로명+상세+이름이 다 맞는 항목이 여럿이면 같은 고객이 중복 저장된 것이다(실기 2026-09-30: 저장 재시도로 2개) — 첫 번째를 쓴다
// 체크박스라 여러 명이 동시에 체크될 수 있다(실기: 지난 선물 받는 분이 체크된 채 남아 있었다) — 고객 것만 켜고 나머지는 끈다
// 체크박스 이름이 여러 줄이라 value 는 첫 줄이 아니라 이름 끝 따옴표 뒤에 있다(실기)
const isOn = b => /^\[\d+\] checkbox "[\s\S]*?" value="on"/.test(b)
// 한 번 눌러서 안 켜지는 때가 있다(실기) — 켜질 때까지 다시 누르고, 두 번째부터는 실제 마우스 클릭으로 누른다
for (let k = 0; k < 3; k++) {
  const cur = (await blocks()).find(mine)
  if (!cur || isOn(cur)) break
  if (k === 0) await page.click(idL(cur)); else await page.clickNative(idL(cur))
  await sleep(1000)
}
for (let k = 0; k < 3; k++) {
  bs = await blocks()
  const extra = bs.filter(b => isOn(b) && !mine(b))
  if (!extra.length) break
  for (const b of extra) { await page.click(idL(b)); await sleep(700) }
}
bs = await blocks()
const on = bs.map((b, i) => isOn(b) ? i : -1).filter(i => i >= 0)
const me = bs.map((b, i) => mine(b) ? i : -1).filter(i => i >= 0)
if (on.length !== 1 || on[0] !== me[0]) return { ...R, note: '체크된 항목이 고객 항목이 아님(체크 ' + on.join(',') + ' / 고객 ' + me.join(',') + ' / 첫 줄 ' + String(bs[me[0]] || '').split(String.fromCharCode(10))[0].replace(/"[^"]*"/, '"…"').slice(0, 60) + ')' }
const done = (await tree({ query: '선택완료' })).split('\n').find(l => /^\[\d+\] button "선택완료"/.test(l))
if (!done) return { ...R, note: '선택완료 버튼 없음' }
await Promise.race([page.click(idL(done)).catch(() => {}), sleep(3000)])
for (let i = 0; i < 12 && await findTab(/selectShpploc/); i++) await sleep(400)
await tabs.switch(gift.id)
// 선물 화면은 받는 분 칸이 늦게 채워진다 — 채워질 때까지 몇 번 읽는다(글자 전체 = 요소 목록 + 본문)
let filled = false
for (let i = 0; i < 10 && !filled; i++) {
  await sleep(1000)
  const gt = sq(await tree({}))
  filled = hasName(gt) && (!road || gt.includes(road)) && (!det || gt.includes(det))
}
if (!filled) return { ...R, note: '선물 화면에 받는 분이 안 들어감' + ((await findTab(/selectShpploc/)) ? '(주소록 창이 안 닫힘)' : '') }
const go = (await tree({ interactive: true })).split('\n').find(l => /^\[\d+\] button "계속하기"/.test(l))
if (!go) return { ...R, note: '계속하기 버튼 없음' }
await page.click(idL(go))
let od = await waitTab(/pay\.ssg\.com\/(?:order\/ordPage|nodcsnOrder\/ordShppInfo)/, 30)
if (od && /\/nodcsnOrder\/ordShppInfo/.test(od.url || '')) {
  await tabs.switch(od.id)
  try { await page.waitFor('계속하기', 6000) } catch (e) {}
  const mt = sq(await tree({}))
  if (!hasName(mt) || (road && !mt.includes(road)) || (det && !mt.includes(det))) return { ...R, note: '중간 배송정보의 받는 분 불일치' }
  const next = (await tree({ interactive: true })).split('\n').find(l => /^\[\d+\] (?:button|link) "계속하기"/.test(l))
  if (!next) return { ...R, note: '중간 배송정보 계속하기 없음' }
  await page.click(idL(next))
  od = await waitTab(/pay\.ssg\.com\/order\/ordPage/, 30)
}
if (!od) return { ...R, note: '주문서가 안 뜸', observed_urls: (await tabs.list()).map(t => String(t.url || '').split('?')[0]) }
await tabs.switch(od.id)
try { await page.waitFor(/결제\s*예정금액/, 12000) } catch (e) {}
await sleep(800)
const t = nz((await tree({})).split('PAGE TEXT')[1])
const am = t.match(/결제 예정금액\s*([\d,]+)/)
return { ...R, ok: true, order_tab: od.id, amount: am ? parseInt(am[1].replace(/,/g, ''), 10) : null, gift: /SSG닷컴이 대신 전달/.test(t) }
