const lines = s => s.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
const norm = s => String(s || '').replace(/\s+/g, '').replace(/[()·,.\-]/g, '')
const isOrderUrl = u => /^https:\/\/(abcmart|grandstage)\.a-rt\.com\/order(?:[?#]|$)/.test(u || '')
const profile = String(args.profile || '').trim().toLowerCase().split('@')[0]
const wantName = String(args.name || '').trim()
const wantAddr = String(args.address || '').trim()
const wantDet = String(args.address_detail || '').trim()
const fail = note => ({ ok: false, name: null, address: null, address_detail: null, note })
if (!wantName || !wantAddr) return fail('name·address 인자 없음')
const oTab = String(args.tab || args.order_tab || '')
if (!profile && !oTab) return fail('no profile/tab — 주문서 탭을 고를 수 없음')
const addrHas = (h, w) => { const t = String(w || '').trim().split(/\s+/).filter(Boolean).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); return !!t.length && new RegExp(t.join('\\s*') + '(?![-\\d])').test(String(h || '')) }

const hit = []
for (const t of ((await tabs.list()) || []).filter(t => isOrderUrl(t.url) && (!oTab || t.id === oTab))) {
  await tabs.switch(t.id)
  const email = valOf(lines(await page.get({ selector: 'input[name=buyerEmailAddrText]' }))[0]).toLowerCase()
  if (!profile || email.split('@')[0] === profile) hit.push(t.id)
}
if (hit.length !== 1) return fail(hit.length ? `이 계정 주문서 탭 ${hit.length}개 — 고르지 않음` : '이 계정 주문서 탭 없음')
const tabId = hit[0]
const focus = async () => { try { await tabs.switch(tabId) } catch (e) {} }
await focus()

const fields = async () => {
  await focus()
  const ls = lines(await page.get({ selector: '#tabAddress1', interactive: true }))
  const vals = ls.filter(l => /\] textbox value="/.test(l)).map(l => ({ id: parseInt(l.slice(1)), v: valOf(l).trim() }))
  const nameL = ls.find(l => /\] textbox "이름"/.test(l))
  return { nameId: nameL ? parseInt(nameL.slice(1)) : null, name: valOf(nameL).trim(), addr: vals[0] || {}, det: vals[1] || {} }
}
const finish = async (f) => {
  if (wantDet && f.det.id && norm(f.det.v) !== norm(wantDet)) { await focus(); await page.type(f.det.id, wantDet); await sleep(300); f = await fields() }
  const got = { name: f.name, address: f.addr.v || '', address_detail: f.det.v || '' }
  const same = norm(got.name) === norm(wantName) && addrHas(got.address, wantAddr) && (!wantDet || norm(got.address_detail) === norm(wantDet))
  return { ok: same, ...got, note: same ? null : '선택 후 주문서 배송지가 바뀌지 않음' }
}
const hoOf = s => (String(s).match(/(\d+)\s*호/g) || []).pop() || ''
const wHo = hoOf(wantDet || wantAddr)
const tryRecent = async () => {
  await focus()
  const r = await page.idOf('최근배송지')
  if (r < 0) return null
  await page.click(r)
  let f = await fields()
  for (let i = 0; i < 15 && !(norm(f.name) === norm(wantName) && addrHas(f.addr.v, wantAddr)); i++) { await sleep(200); f = await fields() }
  const okR = norm(f.name) === norm(wantName) && addrHas(f.addr.v, wantAddr)
  return okR ? await finish(f) : null
}

const bookBtn = await page.idOf('배송 주소록')
if (bookBtn < 0) return fail('배송 주소록 버튼 없음')
await page.click(bookBtn)
let ia = []
for (let i = 0; i < 30 && !ia.some(l => /\] radio/.test(l)); i++) { await sleep(200); await focus(); ia = lines(await page.get({ selector: '#tabAddressBook', interactive: true })) }
const radios = ia.filter(l => /\] radio/.test(l)).map(l => parseInt(l.slice(1)))
const body = ((await page.get({ selector: '#tabAddressBook' })).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const items = []
const re = /(?:\[기본\])?\s*([가-힣A-Za-z]{2,12})\s*(01\d{7,9})\s*(.*?)(?=(?:\[기본\])?\s*[가-힣A-Za-z]{2,12}\s*01\d{7,9}|$)/g
let m
while ((m = re.exec(body))) items.push({ name: m[1], addr: m[3].trim() })
const base = it => norm(it.name) === norm(wantName) && addrHas(it.addr, wantAddr)
const exact = it => base(it) && (!wHo || !hoOf(it.addr) || norm(hoOf(it.addr)) === norm(wHo))
// 정확 일치 우선, 없으면 호수만 다른 같은 주소 → 선택 후 상세주소를 args 로 덮어씀
let bi = items.findIndex(exact)
if (bi < 0) bi = items.findIndex(base)
const closeBook = async () => { const c = await page.idOf('Close'); if (c >= 0) { await focus(); await page.click(c) } }
if (bi < 0 || radios[bi] == null || items.length !== radios.length) {
  await closeBook()
  const rec = await tryRecent()
  if (rec) return rec
  return fail(items.length ? `주소록·최근배송지에 같은 배송지 없음(주소록 ${items.length}개)` : '주소록이 비어 있거나 읽지 못함')
}
await focus(); await page.click(radios[bi])
const sel = await page.idOf('선택')
if (sel < 0) { await closeBook(); return fail('선택 버튼 없음') }
await focus(); await page.click(sel)
let f = await fields()
for (let i = 0; i < 15 && !(norm(f.name) === norm(wantName) && addrHas(f.addr.v, wantAddr)); i++) { await sleep(200); f = await fields() }
return await finish(f)