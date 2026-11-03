const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d/.test(l))
const idOf = l => parseInt(l.slice(1))
const nameOf = l => (l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1]
const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_/:().,[\]·]/g, '')
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
  if (args.profile) { const mine = c.filter(x => !x.profile || x.profile === args.profile); if (mine.length) c = mine }
  if (!c.length) return { err: 'no checkout tab' }
  const ok = []
  let why = null
  for (const x of c) {
    await tabs.switch(x.id)
    await page.waitFor(/(?:총|최종) 결제 ?금액|배송지 추가/, 8000).catch(() => {})
    const f = await formInfo(), m = mismatch(f, args.expect)
    if (m) why = m; else ok.push({ id: x.id, f })
  }
  if (ok.length !== 1) return { err: ok.length ? 'multiple checkout tabs — args.expect/tab 필요' : 'order form mismatch', why }
  await tabs.switch(ok[0].id)
  return ok[0]
}
const na = s => String(s || '').replace(/서해구/g, '서구').replace(/^\s*\S+(도|시)(?=\s)|^\s*(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?=\s)/, '').replace(/\([^)]*\)|특별자치도|특별자치시|특별시|광역시|자치/g, '').replace(/[,，]/g, ' ').replace(/(\d)\s+(?=\d)/g, '$1|').replace(/\s+/g, '').toLowerCase()
const hos = s => (String(s || '').match(/(\d+)\s*호/g) || []).map(x => x.replace(/\D/g, ''))
const entry = s => {
  const z = s.match(/\((\d{5})\)\s*(.*?)\s*(?:0\d{1,2}-\d{3,4}-\d{4}|$)/)
  const head = s.split(/\(\d{5}\)/)[0].replace(/기본 배송지|배송지 변경|선택된 배송지/g, ' ')
  return { name: head.split('/').pop().trim(), zip: z ? z[1] : '', address: z ? z[2].trim() : '' }
}
const readBack = async () => {
  const tx = text((await page.get({})).tree)
  const a = tx.indexOf('주문서 ')
  if (a >= 0) return entry(tx.slice(a + 4, a + 300))
  const k = tx.indexOf(' 배송지 변경 (')
  if (k < 0) return entry('')
  const nm = tx.slice(Math.max(0, k - 60), k).replace(/기본 배송지/g, ' ').replace(/^\s*\d+\s+/, '').trim()
  return entry(nm + ' ' + tx.slice(k + 7, k + 300))
}
const inc = (a, b) => { for (let i = a.indexOf(b); i >= 0; i = a.indexOf(b, i + 1)) if (!/\d$/.test(b) || !/^-?\d/.test(a.slice(i + b.length))) return true; return false }
const sameName = (a, b) => { if (norm(a) === norm(b)) return true; const m = String(a || '').trim().match(/^(.+?)\s*(?:\.{2,}|…)$/); return !!m && norm(m[1]).length >= 5 && norm(b).startsWith(norm(m[1])) }
const same = (e, w) => {
  if (!sameName(e.name, w.name)) return false
  const wh = hos(w.address_detail), eh = hos(e.address)
  if (wh.length && eh.length && !eh.includes(wh[wh.length - 1])) return false
  if (wh.length && !eh.length) return false
  const x = na(e.address), y = na(w.address)
  return !!x && !!y && (inc(x, y) || inc(y, x))
}
const w = { name: String(args.name || '').trim(), address: String(args.address || '').trim(), address_detail: String(args.address_detail || '') }
const F = await pickForm()
if (F.err) return { ok: false, note: F.err + (F.why ? ': ' + F.why : '') }
const dlg = async () => { const t = (await page.get({ selector: '[role=dialog]' })).tree; return /\] (button|textbox) /.test(t) ? t : (await page.get({})).tree }
let dl = await dlg()
const save = lines(dl).find(l => /\] button "저장하기"/.test(l))
const listOpen = /\] button "선택(된 배송지)?"/.test(dl) && /\(\d{5}\)/.test(text(dl))
if (!save && !listOpen) return { ok: false, note: '배송지 추가 창(저장하기)이 열려 있지 않음' }
let cur = null
if (save) {
  const dtLine = lines(dl).find(l => /textbox "상세 주소/.test(l))
  let dtVal = ((dtLine || '').match(/value="([^"]*)"/) || [])[1] || ''
  if (!w.address_detail) w.address_detail = dtVal
  if (dtLine && !dtVal.trim()) {
    let d = w.address_detail
    if (!d) { const m = w.address.match(/\)\s*([^()]+)$/); d = m ? m[1].trim() : '' }
    if (!d) { const m = w.address.match(/\d+(?:-\d+)?\s+(.*\d.*)$/); d = m ? m[1].trim() : '' }
    if (d) {
      await page.type(idOf(dtLine), d)
      await sleep(300)
      w.address_detail = d
      dl = await dlg()
    }
  }
  const save2 = lines(dl).find(l => /\] button "저장하기"/.test(l)) || save
  await page.click(idOf(save2))
  for (let i = 0; i < 25; i++) {
    await sleep(200)
    dl = await dlg()
    if (/\(\d{5}\)/.test(text(dl)) && /\] button "선택/.test(dl)) break
    cur = await readBack()
    if (!/\] button "저장하기"/.test(dl) && same(cur, w)) return { ok: true, ...cur }
  }
  if (/\] button "저장하기"/.test(dl)) return { ok: false, note: '저장 안 됨: ' + text(dl).slice(-120) }
}
let items = [], sel = [], hits = []
const dt = na(w.address_detail).replace(/^[-.·]+$/, '')
for (let k = 0; k < 12; k++) {
  if (k) { await sleep(400); dl = await dlg() }
  const dtx = text(dl).replace(/^.*?배송지 추가\s*/, '')
  items = dtx.split(/\s선택(?:된 배송지)?(?=\s|$)/).map(s => s.replace(/\s(수정|삭제)(?=\s|$)/g, ' ').trim()).filter(s => /\(\d{5}\)/.test(s)).map(entry)
  sel = lines(dl).filter(l => /\] button "선택(된 배송지)?"$/.test(l)).map(idOf)
  hits = items.map((e, i) => same(e, w) && (!dt || inc(na(e.address), dt)) ? i : -1).filter(i => i >= 0)
  if (hits.length) break
}
if (!hits.length || items.length !== sel.length) return { ok: false, note: !hits.length ? '저장한 배송지가 목록에 없음' : '항목·선택 버튼 수가 다름' }
if (new Set(hits.map(i => na(items[i].address))).size > 1) return { ok: false, note: '같은 이름·주소 항목이 여럿(' + hits.length + ')' }
await page.click(sel[hits[0]])
for (let i = 0; i < 20; i++) { await sleep(200); cur = await readBack(); if (same(cur, w)) break }
return same(cur, w) ? { ok: true, ...cur } : { ok: false, ...cur, note: '선택 후 주문서 배송지가 바뀌지 않음' }