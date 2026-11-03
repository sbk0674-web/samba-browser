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
    await page.waitFor(/(?:총|최종) 결제 ?금액/, 8000).catch(() => {})
    const f = await formInfo(), m = mismatch(f, args.expect)
    if (m) why = m; else ok.push({ id: x.id, f })
  }
  if (ok.length !== 1) return { err: ok.length ? 'multiple checkout tabs — args.expect/tab 필요' : 'order form mismatch', why }
  await tabs.switch(ok[0].id)
  return ok[0]
}
const na = s => String(s || '').replace(/서해구/g, '서구').replace(/^\s*\S+(도|시)(?=\s)|^\s*(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?=\s)/, '').replace(/\([^)]*\)|특별자치도|특별자치시|특별시|광역시|자치/g, '').replace(/(\d)\s+(?=\d)/g, '$1|').replace(/\s+/g, '').toLowerCase()
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
if (!w.name || !w.address) return { ok: false, note: 'name/address 없음' }
const F = await pickForm()
if (F.err) return { ok: false, note: F.err + (F.why ? ': ' + F.why : '') }
let cur = await readBack()
if (same(cur, w)) return { ok: true, ...cur, note: 'already selected' }
const findCh = async () => {
  const re = /\] button "배송지 변경"/
  let l = lines((await page.get({})).tree).find(x => re.test(x))
  if (!l) { const q = await page.get({ query: '배송지 변경' }).catch(() => null); if (q && q.tree) l = lines(q.tree).find(x => re.test(x)) }
  return l
}
let ch = await findCh()
if (!ch) { await sleep(1500); ch = await findCh() }
if (!ch) return { ok: false, note: '배송지 변경 버튼 없음' }
await page.click(idOf(ch))
let dl = '', items = [], sel = []
const selOf = t => lines(t).filter(l => /\] button "선택(된 배송지)?"$/.test(l)).map(idOf)
for (let i = 0; i < 30; i++) {
  await sleep(250)
  dl = (await page.get({})).tree
  const full = text(dl), p = full.lastIndexOf('배송지 추가')
  const dtx = p >= 0 ? full.slice(p + 6) : ''
  items = dtx.split(/\s선택(?:된 배송지)?(?=\s|$)/).map(s => s.replace(/\s(수정|삭제)(?=\s|$)/g, ' ').trim()).filter(s => /\(\d{5}\)/.test(s)).map(entry)
  sel = selOf(dl)
  if (items.length && sel.length < items.length) {
    const q = await page.get({ query: '선택' }).catch(() => null)
    if (q && q.tree) { const s2 = selOf(q.tree); if (s2.length > sel.length) sel = s2 }
  }
  if (items.length && items.length === sel.length) { await sleep(300); break }
  if (i >= 4 && sel.length >= 2 && items.length > sel.length && items.slice(0, sel.length).some(e => same(e, w))) break
}
const hit = items.findIndex(e => same(e, w))
const close = async () => { const L = lines(dl), k = L.findIndex(l => /\] button "배송지 추가"/.test(l)), x = L.slice(0, Math.max(k, 0)).find(l => /\] button$/.test(l)); if (x) await page.click(idOf(x)).catch(() => {}) }
if (hit < 0 || hit >= sel.length) { await close(); return { ok: false, note: hit < 0 ? '일치하는 배송지가 목록에 없음(' + items.length + '개)' : '항목·선택 버튼 수가 다름(' + items.length + '/' + sel.length + ')' } }
await page.click(sel[hit])
for (let i = 0; i < 20; i++) { await sleep(200); cur = await readBack(); if (same(cur, w)) break }
return same(cur, w) ? { ok: true, ...cur } : { ok: false, ...cur, note: '선택 후 주문서 배송지가 바뀌지 않음' }
