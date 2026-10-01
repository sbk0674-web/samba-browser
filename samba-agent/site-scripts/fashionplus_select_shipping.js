// 패션플러스 주문서 '배송지 변경' 창(iframe)의 배송지 목록에서 이름·주소가 같은 기존 배송지를 골라 주문서에 반영한다. 새로 만들지 않는다.
// 목록 줄: '이름 [기본배송지|최근배송지] 전화 우편번호 주소 상세'. 이름이 같고 주소의 도로명·건물번호(숫자)·호수가 모두 들어 있어야 고른다
// 탭: args.tab > 이 레인의 패션플러스 주문서 탭 하나 · args: name, address, address_detail, profile, tab
// 반환 {ok,name,address,zip,order_tab,note} — 목록에 없으면 ok:false(창을 닫고 끝)
const OF = /fashionplus\.co\.kr\/order\/\d+(?:[?#]|$)/
// 배송지 창(iframe)이 넘어가는 중에 읽으면 프레임 호출이 시간 초과로 던진다(실기 2026-09-30) — 잠깐 쉬고 다시 읽는다
const get = async q => { for (let i = 0; i < 4; i++) { try { return String((await page.get(q)).tree || '') } catch (e) { await sleep(1500) } } return '' }
const lines = async q => (await get(q ? { selector: q } : {})).split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const text = async () => ((await get({})).split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const fail = (note, x) => ({ ok: false, note, ...(x || {}) })
const sq = s => String(s || '').replace(/\s+/g, '')
const name = String(args.name || '').trim(), addr = String(args.address || '').trim(), det = String(args.address_detail || '').trim()
if (!name || !addr) return fail('name/address missing')
const cand = (await tabs.list()).filter(t => OF.test(t.url || '') && (!args.tab || t.id === args.tab))
if (cand.length !== 1) return fail(cand.length ? `order form ambiguous: ${cand.length} tabs` : 'no order tab')
const tab = cand[0].id
await tabs.switch(tab)
const big = async () => (await lines()).filter(l => /^\[\d{6,}\]/.test(l))
const closeModal = async () => { const c = (await big()).find(l => /button "모달 닫기"/.test(l)); if (c) { try { await page.click(parseInt(c.slice(1))) } catch (e) {} await sleep(400) } }
let fr = await big()
if (!fr.some(l => /link "배송지 선택"/.test(l))) {
  // 창이 넘어가는 중이면 조회·클릭이 '프레임 호출 시간 초과'로 던진다 — 삼키고 다시 본다(2026-10-01)
  let ch = -1
  for (let i = 0; i < 3 && ch < 0; i++) { try { ch = await page.idOf('배송지 변경') } catch (e) { await sleep(1200) } }
  if (ch < 0) return fail('배송지 변경 링크 없음', { order_tab: tab })
  try { await page.click(ch) } catch (e) {}
  for (let i = 0; i < 20 && !(fr = await big()).some(l => /link "배송지 선택"/.test(l)); i++) await sleep(250)
}
const st = fr.find(l => /link "배송지 선택"/.test(l))
if (!st) return fail('배송지 선택 탭 없음', { order_tab: tab })
try { await page.click(parseInt(st.slice(1))) } catch (e) {}
await sleep(900)
// 도로명(…로·…길)과 숫자 토큰, 호수
const road = (addr.match(/\S+(로|길)\b/g) || []).map(sq)
const nums = addr.replace(/^\d{5}\s*/, '').match(/\d+(-\d+)?/g) || []
const ho = (det.match(/(\d+)\s*호/) || [])[1]
const entries = (await big()).filter(l => /^\[\d+\] link "/.test(l) && !/"(배송지 선택|새 주소 입력|수정|본문바로가기)"/.test(l))
const hits = entries.filter(l => {
  const t = (l.match(/link "([^"]*)"/) || [])[1] || ''
  const head = t.split(/\s+/)[0]
  const s = sq(t)
  return head === name && road.every(r => s.includes(r)) && nums.every(n => s.includes(n)) && (!ho || s.includes(ho + '호'))
})
if (hits.length !== 1) { await closeModal(); return fail(hits.length ? `목록에 같은 배송지 ${hits.length}개` : '목록에 없음', { order_tab: tab }) }
// 항목을 누르면 창(iframe)이 바로 넘어가 클릭 호출이 시간 초과로 던진다 — 던져도 클릭은 된 것이다(실기 2026-09-30)
try { await page.click(parseInt(hits[0].slice(1))) } catch (e) {}
for (let i = 0; i < 12 && (await big()).some(l => /link "배송지 선택"/.test(l)); i++) await sleep(300)
if ((await big()).some(l => /link "배송지 선택"/.test(l))) {
  // 고른 뒤 창이 안 닫히면 '선택/확인' 버튼을 찾아 누른다(저장·등록 버튼은 누르지 않는다)
  const b = (await big()).find(l => /button "(선택|확인|배송지 선택)"/.test(l))
  if (b) { try { await page.click(parseInt(b.slice(1))) } catch (e) {} await sleep(800) }
}
const t = await text()
const m = t.match(/배송지 정보 (\S+?)배송지 변경 (\d{5}) (.+?) (?:0\d{1,2}-?\d{3,4}-?\d{4}|배송메모)/)
if (!m) return fail('주문서 배송지 되읽기 실패', { order_tab: tab })
const back = { name: m[1], zip: m[2], address: m[3] }
const same = back.name === name && road.every(r => sq(back.address).includes(r)) && nums.every(n => sq(back.address).includes(n))
return { ok: same, ...back, order_tab: tab, note: same ? null : '주문서 배송지가 고른 항목과 다름' }
