// [막힘 2026-09-27 실측] 카카오 우편번호 팝업(about:blank + postcode.map.kakao.com 프레임) 안 요소에 type 이 'element 2 not found' — 앱 page-bridge 가 팝업의 하위 프레임 id 를 못 푼다. 앱 수정 전엔 ok:false(팝업 모두 닫음)로 멈춘다
// 패션플러스 주문서 배송지 입력 — '배송지 변경' 창(iframe)의 '새 주소 입력'에 이름·주소(우편번호 찾기 팝업)·상세주소를 넣고 되읽는다.
// 전화 칸은 비워 두고 phone_field_id 로 알린다(하네스가 fill_secret 으로 채운다 — 한 칸, 숫자만). '등록하기'는 누르지 않는다(확정은 fashionplus_confirm_shipping)
// 탭: args.tab > 이 레인의 패션플러스 주문서 탭 하나 · args: name, address, address_detail, postal_code, profile, tab
// 반환 {ok,name,address,address_detail,zip,phone_field_id,phone_formats,order_tab,note}
const OF = /fashionplus\.co\.kr\/order\/\d+(?:[?#]|$)/
// 배송지 창(iframe)이 넘어가는 중에 읽으면 프레임 호출이 시간 초과로 던진다 — 잠깐 쉬고 다시 읽는다(2026-10-01)
const tree = async o => { for (let i = 0; i < 4; i++) { try { return String((await page.get(o)).tree || '') } catch (e) { await sleep(1500) } } return '' }
const lines = async q => (await tree(q ? { selector: q } : {})).split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const idOfLine = l => parseInt(String(l).slice(1))
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
const fail = (note, x) => ({ ok: false, note, ...(x || {}) })
const name = String(args.name || '').trim(), addr = String(args.address || '').trim()
const det0 = String(args.address_detail || '').trim(), zipWant = String(args.postal_code || '').replace(/\D/g, '')
// 검색어는 도로명+건물번호까지만 — '…35가길 6, 401호 (천호동 55-2, 그린캐슬)'을 통째로 넣으면 결과가 없다(B05369). 나머지는 상세주소
// 주소에 건물번호가 없고 상세주소가 번호로 시작하면 합친다('국채보상로34길' + '12, 109동 1705호' → C6B9E4 검색 결과 없음)
const joined = !!(det0 && !det0.startsWith(addr) && /^\d/.test(det0) && !/\d\s*$/.test(addr))
const full0 = det0 && det0.startsWith(addr) ? det0 : joined ? addr + ' ' + det0 : addr
const cut = full0.match(/^(.*?(?:로|길)\s+\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/) || full0.match(/^(.*?(?:로|길)\d+(?:-\d+)?)(?![\d-])[,\s]*(.*)$/)
const query = cut ? cut[1] : addr
const detail = det0 && !det0.startsWith(addr) && !joined ? det0 : (cut ? cut[2] : '').trim()
if (!name || !addr) return fail('name/address missing')
const cand = (await tabs.list()).filter(t => OF.test(t.url || '') && (!args.tab || t.id === args.tab))
if (cand.length !== 1) return fail(cand.length ? `order form ambiguous: ${cand.length} tabs` : 'no order tab')
const tab = cand[0].id
await tabs.switch(tab)
// 창(iframe) 요소는 6자리 이상 번호로 보인다
const big = async () => (await lines()).filter(l => /^\[\d{6,}\]/.test(l))
let fr = await big()
if (!fr.some(l => /link "새 주소 입력"/.test(l))) {
  let ch = -1
  for (let i = 0; i < 3 && ch < 0; i++) { try { ch = await page.idOf('배송지 변경') } catch (e) { await sleep(1200) } }
  if (ch < 0) return fail('배송지 변경 링크 없음', { order_tab: tab })
  try { await page.click(ch) } catch (e) {}
  for (let i = 0; i < 20 && !(fr = await big()).some(l => /link "새 주소 입력"/.test(l)); i++) await sleep(250)
}
const nl = fr.find(l => /link "새 주소 입력"/.test(l))
if (!nl) return fail('새 주소 입력 탭 없음', { order_tab: tab })
try { await page.click(idOfLine(nl)) } catch (e) {}
let form = []
for (let i = 0; i < 12; i++) { await sleep(250); fr = await big(); const k = fr.findIndex(l => /link "우편번호 찾기"/.test(l)); if (k >= 3) { form = fr; break } }
const k = form.findIndex(l => /link "우편번호 찾기"/.test(l))
if (k < 3) return fail('주소 입력 폼 못 찾음', { order_tab: tab })
// 순서: 이름·휴대폰·우편번호 / 우편번호 찾기 / 검색주소·상세주소
const [nameL, phoneL, zipL] = form.slice(k - 3, k)
const [roadL, detL] = form.slice(k + 1, k + 3)
if (![nameL, phoneL, zipL, roadL, detL].every(l => /textbox/.test(l || ''))) return fail('주소 입력 칸 모양이 다르다', { order_tab: tab })
await page.type(idOfLine(nameL), name, false)
if (detail) await page.type(idOfLine(detL), detail, false)

// 우편번호 찾기 팝업(카카오 우편번호) — 한 번에 2~3개가 뜰 수 있다. 도로명 주소로 찾아 주소 글자가 맞는 결과를 고른다.
// 팝업 조작이 예외로 끝나도(앱 버그: 하위 프레임 요소 id 못 풂) 새로 뜬 팝업을 모두 닫고 ok:false 로 멈춘다(등록하기 없음)
const popIds = async () => (await tabs.list()).filter(t => t.kind === 'popup').map(t => t.id)
const before = new Set(await popIds())
const closePops = async () => { for (const id of await popIds()) if (!before.has(id)) { try { await tabs.close(id) } catch (e) {} } try { await tabs.switch(tab) } catch (e) {} }
let why = null
try {
  await page.click(idOfLine(form[k]))
  let pops = []
  for (let i = 0; i < 20 && !pops.length; i++) { await sleep(300); pops = (await popIds()).filter(id => !before.has(id)) }
  if (!pops.length) why = '우편번호 팝업 안 뜸'
  else {
    await sleep(600)
    pops = (await popIds()).filter(id => !before.has(id))
    const pid = pops[pops.length - 1]
    await tabs.switch(pid)
    await page.waitFor(/검색/, 6000)
    const q = (await lines()).find(l => /textbox/.test(l))
    if (!q) why = '우편번호 검색칸 없음'
    else {
      const tr = String(await page.type(idOfLine(q), query, true))
      if (!/^ok/i.test(tr)) throw new Error(tr.slice(0, 60))
      const toks = query.split(/\s+/).filter(w => /\d/.test(w) || /(로|길|동|읍|면)$/.test(w))
      let hit = null
      for (let i = 0; i < 16 && !hit; i++) {
        await sleep(400)
        // 결과 묶음 줄(clickable '검색 결과 보기 …')을 누르면 폼에 안 들어간다 — 도로명·지번 버튼을 눌러야 한다(B05369)
        const rs = (await lines()).filter(l => /^\[\d+\] button "/.test(l) && !/지도|영문|검색|취소/.test(l))
        hit = rs.find(l => toks.length && toks.every(w => l.includes(w)) && (!zipWant || l.includes(zipWant))) || rs.find(l => toks.length && toks.every(w => l.includes(w)))
      }
      if (!hit) why = '주소 검색 결과 없음'
      else { await page.click(idOfLine(hit)); for (let i = 0; i < 10 && (await popIds()).includes(pid); i++) await sleep(300) }
    }
  }
} catch (e) { why = '우편번호 팝업 조작 실패: ' + String(e && e.message || e).slice(0, 80) }
await closePops()
if (why) return fail(why, { order_tab: tab })

let road = '', zip = ''
for (let i = 0; i < 12 && !road; i++) {
  await sleep(300)
  const f = await big()
  road = valOf(f.find(l => l.startsWith('[' + idOfLine(roadL) + ']')))
  zip = valOf(f.find(l => l.startsWith('[' + idOfLine(zipL) + ']')))
}
const f = await big()
const got = id => valOf(f.find(l => l.startsWith('[' + id + ']')))
const nm = got(idOfLine(nameL)), dt = got(idOfLine(detL))
if (!road) return fail('주소가 폼에 안 들어감', { order_tab: tab, name: nm })
return {
  ok: true,
  name: nm,
  address: road,
  address_detail: dt,
  zip,
  phone_field_id: idOfLine(phoneL),
  phone_formats: ['digits'],
  order_tab: tab,
  note: got(idOfLine(phoneL)) ? 'phone field not empty' : null
}
