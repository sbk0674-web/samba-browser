// 29CM 기존 배송지 고르기(2026-09-26 재작성) — 주문서 '배송지 변경' 목록에서 이름·주소(·호수)가 args 와 같은 항목의 '선택'을 누르고
// 2026-09-27: 인천 서구가 서해구로 바뀌어 사이트는 서해구, 주문은 서구로 온다 — 비교에서 같게 본다
// 주문서 머리의 배송지를 되읽어 {ok:true, name, address, zip} 으로 돌려준다. 없으면 ok:false. 새 배송지는 만들지 않는다.
// 받는 분이 다르면 주소가 같아도 고르지 않는다(같은 건물 101호·102호가 함께 있다). 호수가 주어지면 호수까지 같아야 한다.
// 주문서 탭: args.tab > 하나뿐 > args.expect 대조('가장 최근 탭' 금지). args: name, address, address_detail, profile, tab, expect
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
// --- 배송지 공통 ---
// 주소 비교: 시·도 머리(경상북도·경북 …)와 표기 차이를 지운다. '숫자 숫자' 사이 공백은 '|'로 남긴다(번호 경계)
const na = s => String(s || '').replace(/서해구/g, '서구').replace(/^\s*\S+(도|시)(?=\s)|^\s*(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?=\s)/, '').replace(/\([^)]*\)|특별자치도|특별자치시|특별시|광역시|자치/g, '').replace(/(\d)\s+(?=\d)/g, '$1|').replace(/\s+/g, '').toLowerCase()
const hos = s => (String(s || '').match(/(\d+)\s*호/g) || []).map(x => x.replace(/\D/g, ''))
// 항목 글자 '사무실 / 임성희 (38069) 경북 … 1층 102호 010-…' → {name, zip, address}(전화는 버린다)
const entry = s => {
  const z = s.match(/\((\d{5})\)\s*(.*?)\s*(?:0\d{1,2}-\d{3,4}-\d{4}|$)/)
  const head = s.split(/\(\d{5}\)/)[0].replace(/기본 배송지|배송지 변경|선택된 배송지/g, ' ')
  return { name: head.split('/').pop().trim(), zip: z ? z[1] : '', address: z ? z[2].trim() : '' }
}
// 주문서 머리 배송지 되읽기('주문서' 뒤 — 주소는 전화번호 앞에서 끊는다)
const readBack = async () => {
  const tx = text((await page.get({})).tree)
  const a = tx.indexOf('주문서 ')
  if (a >= 0) return entry(tx.slice(a + 4, a + 300))
  // 09-27 개편: '주문서' 머리 글자가 없다 — '<이름> (기본 배송지) 배송지 변경 (우편번호) 주소 전화' 로 읽는다(270)
  const k = tx.indexOf(' 배송지 변경 (')
  if (k < 0) return entry('')
  const nm = tx.slice(Math.max(0, k - 60), k).replace(/기본 배송지/g, ' ').replace(/^\s*\d+\s+/, '').trim()
  return entry(nm + ' ' + tx.slice(k + 7, k + 300))
}
// a 안에 b 가 있고 바로 뒤가 숫자·'-숫자'가 아니다(번호 경계). 상세주소 '-'가 붙은 '12-34-'는 경계로 본다(job 244: '…12-34 -' 저장 항목을 못 찾음)
// b 가 숫자로 끝날 때만 경계를 본다 — 주문 주소가 '인천 서구 원창동'처럼 번지 없이 오면 뒤에 번지가 붙어도 같다(270)
const inc = (a, b) => { for (let i = a.indexOf(b); i >= 0; i = a.indexOf(b, i + 1)) if (!/\d$/.test(b) || !/^-?\d/.test(a.slice(i + b.length))) return true; return false }
// 목록·주문서는 긴 이름을 '앞 몇 자...'로 줄이기도 한다 — 앞 5자 이상이 같고 ...이면 같은 이름
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
// 이미 그 배송지면 그대로
let cur = await readBack()
if (same(cur, w)) return { ok: true, ...cur, note: 'already selected' }
const ch = lines((await page.get({})).tree).find(l => /\] button "배송지 변경"/.test(l))
if (!ch) return { ok: false, note: '배송지 변경 버튼 없음' }
await page.click(idOf(ch))
await page.waitFor(/배송지 추가/, 6000).catch(() => {})
let dl = ''
for (let i = 0; i < 10 && !/\(\d{5}\)/.test(dl); i++) { await sleep(200); dl = (await page.get({ selector: '[role=dialog]' })).tree; if (!/\(\d{5}\)/.test(dl)) dl = (await page.get({})).tree }
const dtx = text(dl).replace(/^.*?배송지 추가\s*/, '')
// 항목은 '… 수정 (삭제) 선택|선택된 배송지' 로 끝난다 — i 번째 항목 = i 번째 선택 버튼
const items = dtx.split(/\s선택(?:된 배송지)?(?=\s|$)/).map(s => s.replace(/\s(수정|삭제)(?=\s|$)/g, ' ').trim()).filter(s => /\(\d{5}\)/.test(s)).map(entry)
const sel = lines(dl).filter(l => /\] button "선택(된 배송지)?"$/.test(l)).map(idOf)
const hit = items.findIndex(e => same(e, w))
// 닫기 = '배송지 추가' 앞의 이름 없는 버튼(X 아이콘)만 — 다른 버튼을 누르지 않는다
const close = async () => { const L = lines(dl), k = L.findIndex(l => /\] button "배송지 추가"/.test(l)), x = L.slice(0, Math.max(k, 0)).find(l => /\] button$/.test(l)); if (x) await page.click(idOf(x)).catch(() => {}) }
if (hit < 0 || items.length !== sel.length) { await close(); return { ok: false, note: hit < 0 ? '일치하는 배송지가 목록에 없음(' + items.length + '개)' : '항목·선택 버튼 수가 다름' } }
await page.click(sel[hit])
for (let i = 0; i < 20; i++) { await sleep(200); cur = await readBack(); if (same(cur, w)) break }
return same(cur, w) ? { ok: true, ...cur } : { ok: false, ...cur, note: '선택 후 주문서 배송지가 바뀌지 않음' }
