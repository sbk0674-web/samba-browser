// SSG 선물하기 주소록 저장(2026-09-29): ssg_set_shipping{gift:true} 가 채우고 하네스가 전화를 넣은 배송지 폼(shpplocForm)에서
// '저장'(글자 정확 일치) → 저장 뒤 남은 SSG 회원 팝업(목록·주소록)을 닫고 선물 정보 화면으로 돌아간다. 주문서 배송지는 바꾸지 않는다.
// 인자 {}  반환 {ok, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const lab = l => nz((l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1])
const form = (await tabs.list()).find(t => t.kind === 'popup' && /shpplocForm/.test(t.url || ''))
if (!form) return { ok: false, note: '배송지 폼 팝업 없음' }
await tabs.switch(form.id)
await sleep(400)
const g = await page.get({ interactive: true })
const s = String(g.tree || '').split('\n').find(l => /^\[\d+\] button "/.test(l) && lab(l) === '저장')
if (!s) return { ok: false, note: '저장 버튼 없음' }
await Promise.race([page.click(parseInt(s.slice(1))).catch(() => {}), sleep(3000)])
await sleep(2500)
// 저장이 알림(예: 상세주소 40자 초과)으로 막히면 폼이 남는다 — 성공으로 돌려주면 주소록에 없는 채로 되읽는다(실기 2026-09-30)
if ((await tabs.list()).some(t => t.id === form.id)) {
  const ft = String((await page.get({})).tree || '')
  const dlg = (ft.match(/^OVERLAY: "([^"]{0,80})/m) || [])[1] || ''
  return { ok: false, note: '저장 뒤에도 배송지 폼이 남음' + (dlg ? '(' + dlg + ')' : ' — 입력값 확인 알림일 수 있음') }
}
for (const t of await tabs.list()) {
  if (t.kind === 'popup' && /member\.ssg\.com|selectShpploc/.test(t.url || '')) { try { await tabs.close(t.id) } catch (e) {} }
}
const gift = (await tabs.list()).find(t => /pay\.ssg\.com\/cart\/giftInfo/.test(t.url || ''))
if (!gift) return { ok: false, note: '선물 정보 화면을 못 찾음' }
await tabs.switch(gift.id)
return { ok: true, note: 'saved' }
