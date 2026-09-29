// 29CM 새 배송지 입력(2026-09-26 신규 — 예전엔 저장 스크립트가 없어 직배가 AI 수리로 만들어졌다).
// 주문서 '배송지 변경' → '배송지 추가' 창에 배송지명·수령인·주소(카카오 우편번호 창, 주문서 안 iframe)·상세주소를 넣는다.
// 전화 칸 3개(앞·가운데·끝)는 비워 두고 요소 번호를 phone_field_ids 로 돌려준다 — 번호는 하네스(키마스터)가 채운다.
// 저장하기는 누르지 않는다 — 전화까지 채운 뒤 cm29_confirm_shipping 이 저장·선택한다(sources.yaml shipping_confirm: true 필요).
// 주문서 탭: args.tab > 하나뿐 > args.expect 대조. args: name, address, address_detail, postal_code, profile
// 반환 {name, address, zip, phone_field_ids}
const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d/.test(l))
const idOf = l => parseInt(l.slice(1))
const nameOf = l => (l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1]
const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_/:().,[\]·]/g, '')
// --- 주문서 탭 고르기(공통) ---
async function formInfo() {
  const t = (await page.get({})).tree, tx = text(t)
  const nos = [...new Set([...t.matchAll(/\/product\/catalog\/(\d+)/g)].map(m => m[1]))]
  const names = lines(t).filter(l => /\] link "[^"]+" href=\S*\/product\/catalog\//.test(l)).map(nameOf)
  let opt = ''
  for (const n of names) { const a = tx.indexOf(n), m = a >= 0 ? tx.slice(a + n.length, a + n.length + 120).match(/^\s*(.*?)\s*\d+개/) : null; if (m) opt += ' ' + m[1] }
  return { tx, nos, name: names.join(' '), opt: opt.trim() }
}
function mismatch(f, e) {
  if (!e) return null
  if (typeof e === 'string') e = { name: e }
  const no = String(e.product_no || (String(e.product_url || '').match(/(?:catalog|products)\/(\d+)/) || [])[1] || '')
  if (no && !f.nos.includes(no)) return '상품번호 ' + f.nos + ' ≠ ' + no
  const sz = ((e.option || '') + ' ' + (e.selected || '')).match(/(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g) || []
  if (sz.length && !sz.some(x => new RegExp('(?<![\\d.])' + x + '(?![\\d.])').test(f.opt))) return '옵션 ' + sz + ' ≠ ' + f.opt
  const lz = s => String(s).toUpperCase().match(/(?<![A-Z])(X{0,3}S|M|X{0,3}L|\dXL|FREE)(?![A-Z])/g) || [], el = lz((e.option || '') + ' ' + (e.selected || ''))
  if (!sz.length && el.length && lz(f.opt).length && !lz(f.opt).some(x => el.includes(x))) return '옵션 ' + el + ' ≠ ' + f.opt
  const w = String(e.name || '').split(/[\s/()[\],·_:-]+/).filter(x => !/^\d+$/.test(x) && !/^(나이키|아디다스|뉴발란스|정품|남성|여성|공용|블랙|화이트|nike|adidas|black|white)$/i.test(x) && (/[가-힣]{2}/.test(x) || x.length >= 4))
  if (w.length && !w.some(x => norm(f.name).includes(norm(x)))) return '상품명 ' + w.slice(0, 4) + ' 없음'
  return null
}
async function pickForm() {
  let c = (await tabs.list()).filter(x => /29cm\.co\.kr\/order\/checkout/.test(x.url || ''))
  if (args.tab) c = c.filter(x => x.id === String(args.tab))
  // 계정 비교를 동시에 돌리면 계정마다 주문서 탭이 열린다 — 이 계정(프로필)의 탭만 본다
  // (실기 2026-09-29: 'multiple checkout tabs' 로 원가를 못 읽었다)
  if (args.profile) { const mine = c.filter(x => !x.profile || x.profile === args.profile); if (mine.length) c = mine }
  if (!c.length) return { err: 'no checkout tab' }
  const ok = []
  let why = null
  for (const x of c) {
    await tabs.switch(x.id)
    await page.waitFor(/(?:총|최종) 결제 ?금액/, 8000).catch(() => {})
    const f = await formInfo(), m = mismatch(f, args.expect)
    if (m) why = m; else ok.push({ id: x.id, f })
  }
  if (ok.length !== 1) return { err: ok.length ? 'multiple checkout tabs — args.expect/tab 필요' : 'order form mismatch', why }
  await tabs.switch(ok[0].id)
  return ok[0]
}
const name = String(args.name || '').trim()
const addr = String(args.address || '').replace(/\s+/g, ' ').trim()
const det0 = String(args.address_detail || '').replace(/\s+/g, ' ').trim()
if (!name || !addr) throw new Error('name/address required')
// 상세가 주소를 다시 담아 오기도 한다 — 검색어는 첫 건물번호까지, 나머지는 상세주소
const full = det0.startsWith(addr) ? det0 : (addr + ' ' + det0).trim()
const cut = full.match(/^(.*?\s\d+(?:-\d+)?)(?:\s|$)(.*)$/)
const query = cut ? cut[1] : addr, rest = cut ? cut[2].trim() : det0
const F = await pickForm()
if (F.err) throw new Error(F.err + (F.why ? ': ' + F.why : ''))
const L = async () => lines((await page.get({})).tree)
const find = async re => (await L()).find(l => re.test(l))
const ch = await find(/\] button "배송지 변경"/)
if (!ch) throw new Error('배송지 변경 버튼 없음')
await page.click(idOf(ch))
await page.waitFor(/배송지 추가/, 6000).catch(() => {})
await page.click(idOf(await find(/\] button "배송지 추가"/)))
let d = []
for (let i = 0; i < 15 && !d.some(l => /수령인을 입력/.test(l)); i++) { await sleep(200); d = lines((await page.get({ selector: '[role=dialog]' })).tree) }
const ix = re => d.findIndex(l => re.test(l))
const iName = ix(/textbox "최대 10자/), iRcv = ix(/textbox "수령인을 입력/), iSearch = ix(/\] button "주소 검색"/), iDet = ix(/textbox "상세 주소/)
if (iRcv < 0 || iSearch < 0 || iDet < 0) throw new Error('배송지 추가 창 칸을 못 찾음')
// 수령인 뒤 textbox 3개 = 연락처(앞·가운데·끝), 주소 검색 버튼 앞 = 우편번호, 뒤 = 기본주소
const tbs = d.map((l, i) => ({ l, i })).filter(x => /\] textbox/.test(x.l))
const phone = tbs.filter(x => x.i > iRcv).slice(0, 3).map(x => idOf(x.l))
const zipId = idOf(tbs.filter(x => x.i < iSearch).pop().l), a1Id = idOf(tbs.find(x => x.i > iSearch).l), detId = idOf(d[iDet])
if (iName >= 0) await page.type(idOf(d[iName]), name.slice(0, 10), false)
await page.type(idOf(d[iRcv]), name, false)
// 주소 검색(카카오 우편번호 — iframe 요소 번호는 100000 이상)
await page.click(idOf(d[iSearch]))
let q = null
for (let i = 0; i < 20 && !q; i++) { await sleep(250); q = await find(/^\[1\d{5}\] textbox .*name=region_name/) }
if (!q) throw new Error('우편번호 창이 안 뜸')
await page.type(idOf(q), query, false)
try { await page.click(idOf(await find(/^\[1\d{5}\] button "검색"/))) } catch (e) { /* 창이 다시 그려지며 응답이 끊기기도 한다 */ }
// 결과: '<도로명 주소>…' 버튼 — 건물번호가 든 첫 결과(도로명 검색이면 도로명 줄, 아니면 지번 줄)
const bno = (query.match(/(\d+(?:-\d+)?)$/) || [])[1] || ''
const road = /(로|길)\s*\d|(로|길)$/.test(query.replace(/\s\d.*$/, ''))
const bre = new RegExp(' ' + bno + '(?![\\d-])')
if (!bno) throw new Error('건물번호 없음: ' + query)
let hit = null
for (let i = 0; i < 20 && !hit; i++) {
  await sleep(300)
  const rs = (await L()).filter(l => /^\[1\d{5}\] button "[^"]*\d/.test(l) && !/지도|영문|검색|취소/.test(l))
  // 건물번호가 경계까지 맞는 결과만('12'가 '120'·'12-3'에 걸리지 않게). 없으면 첫 결과를 고르지 않고 실패한다
  hit = rs.find(l => bre.test(nameOf(l)) && (road ? /(로|길)\s?\d*\s/.test(nameOf(l)) : /(동|리|가)\s\d/.test(nameOf(l))))
}
if (!hit) throw new Error('주소 검색 결과 없음: ' + query)
try { await page.click(idOf(hit)) } catch (e) {}
const val = async id => ((await L()).find(l => idOf(l) === id) || '').match(/value="([^"]*)"/)?.[1] || ''
let zip = ''
for (let i = 0; i < 20 && !zip; i++) { await sleep(200); zip = await val(zipId) }
if (!zip) throw new Error('우편번호가 채워지지 않음')
if (rest) await page.type(detId, rest, false)
const a1 = await val(a1Id), a2 = await val(detId)
return { name: await val(idOf(d[iRcv])), address: (a1 + ' ' + a2).trim(), address_detail: a2, zip, phone_field_ids: phone }
