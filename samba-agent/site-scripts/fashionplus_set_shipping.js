const OF = /fashionplus\.co\.kr\/order\/\d+(?:[?#]|$)/
const DA = /fashionplus\.co\.kr\/order\/manage\/delivery-address/
const tree = async o => { for (let i = 0; i < 4; i++) { try { return String((await page.get(o)).tree || '') } catch (e) { await sleep(1500) } } return '' }
const lines = async q => (await tree(q ? { selector: q } : {})).split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const idOfLine = l => parseInt(String(l).slice(1))
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
const fail = (note, x) => ({ ok: false, note, ...(x || {}) })
const name = String(args.name || '').trim(), addr = String(args.address || '').trim()
const det0 = String(args.address_detail || '').trim(), zipWant = String(args.postal_code || '').replace(/\D/g, '')
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
for (const t of await tabs.list()) if ((t.kind === 'popup' && t.openerId === tab) || (t.id !== tab && DA.test(t.url || ''))) { try { await tabs.close(t.id) } catch (e) {} }
try { await tabs.switch(tab) } catch (e) {}
let ft = tab, sep = false
const big = async () => (await lines()).filter(l => sep ? true : /^\[\d{6,}\]/.test(l))
const daTab = async () => (await tabs.list()).find(t => t.kind !== 'popup' && DA.test(t.url || ''))
const findForm = fr => { const k = fr.findIndex(l => /link "우편번호 찾기"/.test(l)); return k >= 3 ? fr : null }
const hasNew = fr => fr.some(l => /link "새 주소 입력"/.test(l))
let fr = await big()
if (!hasNew(fr)) {
  let ch = -1
  for (let i = 0; i < 3 && ch < 0; i++) { try { ch = await page.idOf('배송지 변경') } catch (e) { await sleep(1200) } }
  if (ch < 0) return fail('배송지 변경 링크 없음', { order_tab: tab })
  const hl = (await lines()).find(l => l.startsWith('[' + ch + ']'))
  const href = ((hl || '').match(/href=(\S+)/) || [])[1] || ''
  try { await page.click(ch) } catch (e) {}
  for (let i = 0; i < 14 && !hasNew(fr = await big()); i++) {
    await sleep(300)
    const d = await daTab()
    if (d) { ft = d.id; sep = true; await tabs.switch(ft); fr = await big(); if (hasNew(fr)) break }
  }
  if (!hasNew(fr)) {
    if (ft !== tab) { try { await tabs.switch(tab) } catch (e) {} }
    const url = /^\//.test(href) ? 'https://www.fashionplus.co.kr' + href : (DA.test(href) ? href : 'https://www.fashionplus.co.kr/order/manage/delivery-address')
    try { await tabs.open({ url }) } catch (e) {}
    for (let i = 0; i < 20 && !hasNew(fr); i++) {
      await sleep(400)
      const d = await daTab()
      if (d) { ft = d.id; sep = true; try { await tabs.switch(ft) } catch (e) {} fr = await big() }
    }
  }
}
let form = findForm(fr) || []
for (let t = 0; t < 3 && !form.length; t++) {
  const nl = fr.find(l => /link "새 주소 입력"/.test(l))
  if (!nl) return fail('새 주소 입력 탭 없음', { order_tab: ft })
  try { await page.click(idOfLine(nl)) } catch (e) {}
  for (let i = 0; i < 20; i++) { await sleep(400); fr = await big(); const f0 = findForm(fr); if (f0) { form = f0; break } }
}
const k = form.findIndex(l => /link "우편번호 찾기"/.test(l))
if (k < 3) return fail('주소 입력 폼 못 찾음', { order_tab: ft })
const [nameL, phoneL, zipL] = form.slice(k - 3, k)
const [roadL, detL] = form.slice(k + 1, k + 3)
if (![nameL, phoneL, zipL, roadL, detL].every(l => /textbox/.test(l || ''))) return fail('주소 입력 칸 모양이 다르다', { order_tab: ft })
await page.type(idOfLine(nameL), name, false)
if (detail) await page.type(idOfLine(detL), detail, false)

const popIds = async () => (await tabs.list()).filter(t => t.kind === 'popup').map(t => t.id)
const before = new Set(await popIds())
const closePops = async () => { for (const id of await popIds()) if (!before.has(id)) { try { await tabs.close(id) } catch (e) {} } try { await tabs.switch(ft) } catch (e) {} }
const safeClick = async id => { try { await page.click(id) } catch (e) {} }
let why = null
try {
  await safeClick(idOfLine(form[k]))
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
      const tr = String(await page.type(idOfLine(q), query, false))
      if (!/^ok/i.test(tr)) throw new Error(tr.slice(0, 60))
      await sleep(400)
      const sb0 = (await lines()).find(l => /^\[\d+\] button "검색"/.test(l))
      if (sb0) await safeClick(idOfLine(sb0))
      const toks = query.split(/\s+/).filter(w => /\d/.test(w) || /(로|길|동|읍|면)$/.test(w))
      let hit = null
      for (let i = 0; i < 16 && !hit; i++) {
        await sleep(500)
        const rs = (await lines()).filter(l => /^\[\d+\] button "/.test(l) && !/지도|영문|검색|취소/.test(l))
        hit = rs.find(l => toks.length && toks.every(w => l.includes(w)) && (!zipWant || l.includes(zipWant))) || rs.find(l => toks.length && toks.every(w => l.includes(w)))
        if (!hit && i === 5) { const sb = (await lines()).find(l => /^\[\d+\] button "검색"/.test(l)); if (sb) await safeClick(idOfLine(sb)) }
      }
      if (!hit) why = '주소 검색 결과 없음'
      else { await safeClick(idOfLine(hit)); await sleep(1200) }
    }
  }
} catch (e) { why = '우편번호 팝업 조작 실패: ' + String(e && e.message || e).slice(0, 80) }
await closePops()
if (why) return fail(why, { order_tab: ft })

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
if (!road) return fail('주소가 폼에 안 들어감', { order_tab: ft, name: nm })
return {
  ok: true,
  name: nm,
  address: road,
  address_detail: dt,
  zip,
  phone_field_id: idOfLine(phoneL),
  phone_formats: ['digits'],
  order_tab: ft,
  note: got(idOfLine(phoneL)) ? 'phone field not empty' : null
}