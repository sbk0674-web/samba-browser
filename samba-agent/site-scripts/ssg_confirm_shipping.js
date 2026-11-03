// SSG 배송지 확정(2026-09-27 재작성 v2): ssg_set_shipping 이 채운 폼 팝업(shpplocForm)에서 '저장'(글자 정확 일치) → 목록 팝업(shpplocList)에서
// 이름·도로명(·호수)이 같은 항목의 라디오 → '배송지 변경'(글자 정확 일치) → 주문서에서 받는 분·주소를 되읽는다. idOf 의 '첫 요소' 대체 금지.
// v1 실패 원인: 이름·주소는 요소 줄이 아니라 본문 글자인데 요소 줄 앞뒤 3줄에서 찾았다 — 이제 라디오를 품은 항목 범위(selector)로 읽는다.
// 인자 {name, address, address_detail?, profile?}  반환 {ok, name, address, note, dup}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const recipientName = nz(nz(args.name).replace(/\*/g, 'ㅇ').replace(/[^\p{L}\p{M}\p{N} ]/gu, ''))
const OF = /pay\.ssg\.com\/(order|payment)|ssg\.com\/order\//
const lines = t => String(t || '').split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const txt = t => nz(String(t || '').split('PAGE TEXT:')[1])
const idOf = l => parseInt(l.slice(1))
const lab = l => nz((l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1])
const exact = (ls, w) => { const l = ls.find(x => /^\[\d+\] (button|link|clickable) "/.test(x) && lab(x).replace(/\s/g, '') === w.replace(/\s/g, '')); return l ? idOf(l) : -1 }
const tap = async id => { await Promise.race([page.click(id).catch(() => {}), sleep(3000)]) }
const get = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(400) } return '' }
// 주소 비교: 시·도 머리·괄호·공백 제거. 도로명+건물번호(사무실길58)를 열쇠로
const na = s => String(s || '').replace(/\([^)]*\)/g, '').replace(/\s+/g, '').toLowerCase()
const addr = nz(args.address).replace(/\([^)]*\)/g, ' ')
const rm = addr.match(/[가-힣0-9]+(로|길)\s*\d+(-\d+)?/)
const road = na(rm ? rm[0] : addr.replace(/^\S+\s+\S+\s+/, '')).slice(0, 30)
const hos = s => (String(s || '').match(/(\d+)\s*호/g) || []).map(x => x.replace(/\D/g, ''))
const wantHo = hos(args.address_detail).pop()
const inc = (a, b) => { for (let i = a.indexOf(b); i >= 0; i = a.indexOf(b, i + 1)) if (!/[\d-]/.test(a[i + b.length] || '')) return true; return false }
const cnt = (a, b) => b ? a.split(b).length - 1 : 0
const same = t => { const x = na(t); if (!x.includes(na(recipientName)) || !inc(x, road)) return false; if (wantHo && !hos(t).includes(wantHo)) return false; return true }
const W = /(배송지|기본|선택|수정|삭제|변경|추가|받는|분|주소|휴대폰|연락처|자택|회사|최근)/g
const shape = s => { const k = []; s = nz(s).replace(W, m => { k.push(m); return '\u0001' }).replace(/[가-힣]/g, '가').replace(/[A-Za-z]/g, 'a').replace(/\d/g, '9'); let j = 0; return s.replace(/\u0001/g, () => k[j++]).slice(0, 70) }
// 목록 팝업에서 항목 읽기 → [{text, pick}]
async function items() {
  for (const T of ['li', 'tr', 'dl', 'div']) {
    const S = `${T}:has(input[type="radio"]):not(:has(${T} input[type="radio"]))`
    const out = []
    for (let k = 1; k <= 40; k++) {
      const t = await get({ selector: `${T}:nth-child(${k} of ${S})`, interactive: true })
      const tx = txt(t)
      if (!tx) { if (k > 1 && !out.length) break; if (out.length) break; continue }
      const ls = lines(t)
      let p = ls.find(l => /^\[\d+\] (radio|checkbox)/.test(l))
      if (!p) p = ls.find(l => lab(l) === '선택')
      if (!p) p = ls.find(l => /^\[\d+\] clickable/.test(l) && same(lab(l)))
      // 숨은 라디오(모양만 라벨) — 수정·삭제·기본 설정이 아닌 첫 클릭 요소(라벨)
      if (!p) p = ls.find(l => /^\[\d+\] clickable/.test(l) && !/수정|삭제|기본|설정|추가/.test(lab(l)))
      out.push({ text: tx, pick: p ? idOf(p) : -1, n: ls.filter(l => /radio/.test(l)).length })
    }
    if (out.length) return { T, out }
  }
  // 선택자로 못 읽으면 화면 트리를 라디오 줄 단위로 끊는다 — 라디오 다음 줄들이 그 항목의 이름·주소다
  const all = String(await get({})).split('PAGE TEXT')[0].split('\n')
  const out = []
  let cur = null
  for (const l of all) {
    if (/^\s*\[\d+\] radio/.test(l)) { cur = { text: '', pick: parseInt(l.trim().slice(1)), n: 1 }; out.push(cur) }
    if (cur) cur.text += ' ' + l.replace(/^\s*\[\d+\]\s+\w+\s*/, '').replace(/"/g, ' ')
  }
  for (const e of out) e.text = nz(e.text)
  return out.length ? { T: 'tree', out } : { T: '-', out: [] }
}
const R = { ok: false, name: null, address: null, note: null, dup: 0 }
if (!recipientName || !addr) return { ...R, note: 'name·address 필요' }
const readBack = async () => {
  const t = na(txt(await get({})))
  const n = na(recipientName)
  for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + 1)) { const w = t.slice(Math.max(0, i - 200), i + 300); if (inc(w, road)) return true }
  return false
}
const findPopup = async re => (await tabs.list()).find(t => t.kind === 'popup' && re.test(t.url || ''))
let form = await findPopup(/shpplocForm/)
let lp = await findPopup(/shpplocList/)
const opener = (form || lp || {}).openerId
const ofs = (await tabs.list()).filter(t => t.kind === 'tab' && OF.test(t.url || ''))
const tabId = opener || (ofs.length === 1 ? ofs[0].id : null)
if (form) {
  await tabs.switch(form.id)
  await sleep(300)
  const s = exact(lines(await get({ interactive: true })), '저장')
  if (s < 0) return { ...R, note: '배송지 폼에서 저장 버튼을 찾지 못함' }
  tap(s)
  await sleep(1500)
}
lp = null
for (let i = 0; i < 12 && !lp; i++) { lp = await findPopup(/shpplocList/); if (!lp) await sleep(500) }
const back = async () => { if (tabId) await tabs.switch(tabId); let ok = false; for (let i = 0; i < 10 && !ok; i++) { await sleep(400); ok = await readBack() } return ok }
if (!lp) {
  // 저장이 곧바로 주문서에 반영되고 팝업이 닫히는 경우
  if (!(await findPopup(/shpplocForm/)) && tabId && await back()) return { ...R, ok: true, name: recipientName, address: nz(args.address), note: 'applied(목록 없이 반영)' }
  return { ...R, note: '배송지 목록 팝업을 찾지 못함' }
}
await tabs.switch(lp.id)
try { await page.waitFor(/배송지/, 5000) } catch (e) {}
await sleep(500)
const { T, out } = await items()
const hits = out.filter(e => same(e.text))
R.dup = hits.length
if (!hits.length) return { ...R, note: `저장한 배송지를 목록에서 찾지 못함(항목 ${out.length}개, ${T})` + (out[0] ? ' 첫 항목 모양: ' + shape(out[0].text) : '') }
const h = hits.find(e => e.pick >= 0 && e.n <= 1 && (T === 'tree' || cnt(na(e.text), road) === 1))
if (!h) return { ...R, note: `일치 ${hits.length}개지만 선택 요소 없음(${T}) 모양: ` + shape(hits[0].text) }
await tap(h.pick)
await sleep(400)
const c = exact(lines(await get({ interactive: true })), '배송지 변경')
if (c < 0) return { ...R, note: "목록 팝업 '배송지 변경' 버튼을 찾지 못함" }
tap(c)
for (let i = 0; i < 15 && (await tabs.list()).some(t => t.id === lp.id); i++) await sleep(300)
const ok = await back()
return { ...R, ok, name: ok ? recipientName : null, address: ok ? nz(args.address) : null, note: (ok ? 'applied' : '주문서 되읽기 불일치') + (hits.length > 1 ? ` (같은 배송지 ${hits.length}개 중복)` : '') }
