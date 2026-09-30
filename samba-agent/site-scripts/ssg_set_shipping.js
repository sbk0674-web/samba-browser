// SSG 배송지: 목록→추가 폼→우편번호→받는분. gift 는 열린 목록 팝업. 전화는 칸 번호만(fill_secret), 저장은 별도.
// 인자 {name,address,address_detail?,gift?,tab?} 반환 {ok,name,address(_detail),phone_field_ids,form_popup,note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const OF = /pay\.ssg\.com\/(order|payment)|ssg\.com\/order\//
const tree = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const first = async sel => { const l = (await tree({ selector: sel })).split('\n').find(x => /^\[\d+\]/.test(x)); return l ? parseInt(l.slice(1)) : -1 }
const R = { ok: false, name: null, address: null, address_detail: null, phone_field_ids: [], phone_formats: ['phone-rest'], form_popup: null, note: null }
if (!args.name || !args.address) return { ...R, note: 'name·address 필요' }
const waitPopup = async (re, ms) => { for (let i = 0; i < ms / 400; i++) { const p = (await tabs.list()).find(t => t.kind === 'popup' && re.test(t.url || '')); if (p) return p; await sleep(400) } return null }
let list = args.gift ? (await tabs.list()).find(t => t.kind === 'popup' && /shpplocList/.test(t.url || '')) : null
if (!list) {
  const ofs = (await tabs.list()).filter(t => t.kind === 'tab' && OF.test(t.url || ''))
  const tab = args.tab ? ofs.find(t => t.id === String(args.tab)) : ofs.length === 1 ? ofs[0] : null
  if (!tab) return { ...R, note: ofs.length ? '주문서 ' + ofs.length + '개 — args.tab 필요' : '주문서 없음' }
  await tabs.switch(tab.id)
  let b = await first('[id^="btnChangeShpploc"], [name="btnChangeShpploc"]')
  if (b < 0) b = await page.idOf('배송지 변경', 0)
  if (b < 0) return { ...R, note: '배송지 변경 버튼 없음' }
  await page.click(b)
  list = await waitPopup(/shpplocList/, 8000)
}
if (!list) {
  const lg = (await tabs.list()).find(t => t.kind === 'popup' && /member\.ssg\.com\/member\/login/.test(t.url || ''))
  if (lg) { try { await tabs.close(lg.id) } catch (e) {} return { ...R, error: 'login_required', note: 'SSG 세션 만료 — 로그인 팝업' } }
  return { ...R, note: '배송지 목록 팝업 안 뜸' }
}
await tabs.switch(list.id)
try { await page.waitFor(/배송지|로그인/, 5000) } catch (e) {}
if (/member\/login/.test(await page.url())) { try { await tabs.close(list.id) } catch (e) {} return { ...R, error: 'login_required', note: 'SSG 세션 만료(목록)' } }
let add = -1
for (const w of ['새 배송지 추가', '배송지 추가', '새 배송지']) { if (add < 0) add = await page.idOf(w, 0) }
if (add < 0) return { ...R, note: '새 배송지 추가 버튼 없음' }
page.click(add).catch(() => {})
const form = await waitPopup(/shpplocForm/, 8000)
if (!form) return { ...R, note: '배송지 폼 팝업 안 뜸' }
R.form_popup = form.id
await tabs.switch(form.id)
try { await page.waitFor(/받는\s*분|수령인|이름|로그인/, 5000) } catch (e) {}
if (/member\/login/.test(await page.url())) { try { await tabs.close(form.id) } catch (e) {} return { ...R, error: 'login_required', note: 'SSG 세션 만료(폼)' } }
try { await page.waitFor(/우편번호/, 8000) } catch (e) {}
let zipBtn = await page.idOf('우편번호 검색', 0)
if (zipBtn < 0) { await sleep(1500); zipBtn = await page.idOf('우편번호 검색', 0) }
if (zipBtn < 0) zipBtn = await first('#address_zipcode')
if (zipBtn < 0) return { ...R, note: '우편번호 찾기 버튼 없음' }
page.click(zipBtn).catch(() => {})
let zip = await waitPopup(/zipcd\.ssg/, 8000)
if (!zip) { await tabs.switch(form.id); const z2 = await page.idOf('우편번호 검색', 0); if (z2 >= 0) page.click(z2).catch(() => {}); zip = await waitPopup(/zipcd\.ssg/, 8000) }
if (!zip) return { ...R, note: '우편번호 팝업 안 뜸' }
await tabs.switch(zip.id)
try { await page.waitFor(/도로명/, 6000) } catch (e) {}
await sleep(500)
let kw = -1
for (let i = 0; i < 15 && kw < 0; i++) { kw = await first('input[name="searchKeyword"]'); if (kw < 0) await sleep(800) }
if (kw < 0) return { ...R, note: '주소 검색칸 없음' }
let sb = await first('.postcode_search_btn')
if (sb < 0) sb = await page.idOf('찾기', 0)
const kwVal = async () => ((await tree({ selector: 'input[name="searchKeyword"]' })).match(/value="([^"]*)"/) || [])[1] || ''
for (let i = 0; i < 4; i++) { const k = i ? await first('input[name="searchKeyword"]') : kw; if (k >= 0) await page.type(k, nz(args.address), true); await sleep(1200); if ((await kwVal()).length) break }
let pickBtn = -1
for (let i = 0; i < 10 && pickBtn < 0; i++) { await sleep(800); pickBtn = await first('button[onclick*="showZipcdDtl"]'); if (i === 4 && pickBtn < 0 && sb >= 0) await page.click(sb) }
if (pickBtn < 0) {
  const a0 = nz(nz(args.address).replace(/\([^)]*\)/g, ' '))
  const rm = a0.match(/([가-힣0-9]+(?:로|길)\s*\d+(?:-\d+)?)/)
  const parts = a0.split(' ')
  const region = parts.slice(1, 3).filter(p => /(시|군|구|읍|면|동)$/.test(p)).join(' ')
  const jb = (a0.match(/^(.*?[가-힣\d]+[동리가]\s*\d+(?:-\d+)?)(?=\s|$)/) || [])[1]
  const qs = [...new Set([rm && region ? region + ' ' + rm[1] : '', rm ? rm[1] : '', jb, jb && jb.replace(/^\S+ /, ''), a0.replace(/^\S+\s+/, '')].filter(q => q && q !== nz(args.address)))]
  for (const q2 of qs) { if (pickBtn >= 0) break; const k2 = await first('input[name="searchKeyword"]'); if (k2 < 0) break; await page.type(k2, q2, true); for (let i = 0; i < 8 && pickBtn < 0; i++) { await sleep(800); pickBtn = await first('button[onclick*="showZipcdDtl"]') } }
}
if (pickBtn < 0) return { ...R, note: '주소 검색 결과 없음' }
await page.click(pickBtn)
await sleep(700)
const dtl = await first('#addrDtlInput, input[name="dtlAddr"]')
// 상세 없으면 끝 호·동·층; 지번은 번지까지
const tl = nz((nz(args.address).match(/^.*(?:로|길)\s*\d+(?:-\d+)?\s*(?:\([^)]*\))?\s*(.*)$/) || [])[1])
const dtlRaw = nz(args.address_detail) || nz((nz(args.address).split(',')[1] || '').replace(/\([^)]*\)/g, ' ')) || (/^[\dA-Za-z]|[호층동]$/.test(tl) ? tl : '')
const dtlText = (dtlRaw.length > 40 ? nz(dtlRaw.replace(/\([^)]*\)?/g, ' ')) : dtlRaw).slice(0, 40).trim()
if (dtl >= 0 && dtlText) await page.type(dtl, dtlText, false)
if (!/zipcd\.ssg/.test(await page.url())) return { ...R, note: '우편번호 팝업 아님 — 멈춤' }
let ok = await first('#addrDtlBtn')
if (ok < 0) ok = await page.idOf('저장', 0)
if (ok < 0) return { ...R, note: '우편번호 팝업 저장 버튼 없음' }
page.click(ok).catch(() => {})
for (let i = 0; i < 10 && (await tabs.list()).some(t => t.id === zip.id); i++) await sleep(300)
if ((await tabs.list()).some(t => t.id === zip.id)) { const zt = await tree({}); const dlg = (zt.match(/^OVERLAY: "([^"]{0,80})/m) || [])[1] || ''; try { await tabs.close(zip.id) } catch (e) {} return { ...R, note: '우편번호 팝업 저장이 안 닫힘' + (dlg ? '(' + dlg + ')' : '') + (dtlText ? '' : ' — 상세주소 없음') } }
await tabs.switch(form.id)
await sleep(500)
{ const V = l => (l.match(/value="([^"]*)"/) || [])[1] || ''
  const dl = dtlText && (await tree({ interactive: true })).split('\n').find(l => /textbox/.test(l) && V(l).startsWith(dtlText.slice(0, 6)))
  if (dl && V(dl).length > 40) await page.type(parseInt(dl.slice(1)), nz(V(dl).replace(/\([^)]*\)?/g, ' ')).slice(0, 40).trim(), false) }
const nmId = await first('#rcptpeNm, input[name="rcptpeNm"]')
if (nmId < 0) return { ...R, note: '받는분 이름칸 없음' }
await page.type(nmId, nz(args.name), false)
let h1 = await first('#hpno1')
if (h1 < 0) h1 = parseInt((((await tree({ interactive: true })).split('\n').find(l => /combobox "010 011/.test(l))) || '[-1]').slice(1))
if (h1 >= 0) await page.select(h1, '010')
let h2 = await first('#hpno2')
if (h2 < 0) h2 = await page.idOf('- 없이 번호만 입력해주세요.', 0)
if (h2 < 0) return { ...R, note: '휴대폰 번호칸 없음' }
R.phone_field_ids = [h2]
const tr = await tree({ interactive: true })
const lines = tr.split('\n')
const val = id => ((lines.find(l => l.startsWith('[' + id + ']')) || '').match(/value="([^"]*)"/) || [])[1] || ''
R.name = val(nmId) || null
const vals = lines.filter(l => /textbox/.test(l) && !l.startsWith('[' + nmId + ']')).map(l => (l.match(/value="([^"]*)"/) || [])[1]).filter(v => v && v.length >= 2)
R.address = vals.find(v => /(로|길)\s*\d|(동|읍|면|리)\s+\d/.test(v)) || null
R.postal_code = vals.find(v => /^\d{5}$/.test(v)) || null
R.address_detail = (dtlText && vals.find(v => v.startsWith(dtlText))) || null
R.ok = !!(R.name && R.address)
if (!R.ok) R.note = '폼 되읽기 실패(이름 또는 주소)'
return R