// SSG 선물하기 진입(2026-09-29 수동 성공 2건 이식): 상품 주소(애드픽 경유면 ckwhere 가 붙은 주소 그대로)를 새 탭으로 열고
// 옵션 → '선물' → 선물 정보 화면(pay.ssg.com/cart/giftInfoDiv). 결제·주문 없음.
// 로그인 팝업이 떠도 잠시 뒤 스스로 닫히며 선물 화면이 뜨는 경우가 있다(실기) — 선물 화면을 먼저 기다린다.
// 인자 {product_url, option, profile}  반환 {ok, gift_tab, error?, note, options?}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const R = { ok: false, gift_tab: null, note: null }
if (!args.product_url || !nz(args.option)) return { ...R, note: 'product_url·option 필요' }
const lines = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l)) } catch (e) {} await sleep(400) } return [] }
const idL = l => parseInt(l.slice(1))
const lab = l => nz((l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1])
await tabs.open({ url: String(args.product_url), ...(args.profile ? { profile: args.profile } : {}) })
try { await page.waitFor(/선물|바로구매|일시품절/, 12000) } catch (e) {}
let ls = await lines({ interactive: true })
if (ls.some(l => / link "일시품절"/.test(l))) return { ...R, error: 'sold_out', note: '상품 일시품절' }
// 옵션: '100 (남은수량:4)' 또는 'L' — 주문서 옵션 글자(snap.selected)와 앞부분이 정확히 같은 것 하나
const opt = nz(args.option).replace(/\s*\(남은수량[^)]*\)\s*$/, '')
// 큰 페이지(신세계백화점)는 전체 목록이 잘린다 — 검색으로 찾고, '사이즈 선택하세요.'처럼 이름 붙은 칸을 먼저(맨 앞은 숨은 칸, 09-30)
// 선택 칸이 둘(색·사이즈)이면 주문서 옵션 '색/사이즈'를 칸 순서대로 하나씩 고른다(2026-10-02 다이나핏 '라이트 블루(B1)/L')
const selN = (await lines({ query: '선택하세요' })).filter(l => / link "[^"]*선택하세요\.?"/.test(l)).length
const parts = selN > 1 && opt.includes('/') ? opt.split('/').map(nz).filter(Boolean) : [opt]
for (const opt of parts) {
  const selAll = (await lines({ query: '선택하세요' })).filter(l => / link "[^"]*선택하세요\.?"/.test(l))
  const sel = selAll.find(l => !/ link "선택하세요\."/.test(l)) || selAll[0]
  if (!sel) break
  await page.click(idL(sel))
  await sleep(1500)
  ls = [...await lines({ interactive: true }), ...await lines({ query: opt || '선택' })]
  // 전체 목록·검색 결과에 같은 항목이 두 번 잡힌다 — 요소 번호로 하나씩만
  const cand = [...new Map(ls.map(l => [idL(l), l])).values()].filter(l => /^\[\d+\] link "/.test(l) && lab(l).replace(/\s*\(남은수량[^)]*\)\s*$/, '') === opt)
  if (cand.length !== 1) {
    const all = ls.filter(l => /^\[\d+\] link "/.test(l) && /남은수량|품절|매진/.test(l)).map(lab).slice(0, 12)
    return { ...R, error: 'option_not_found', note: '옵션 ' + opt + ' 을 하나로 못 찾음(' + cand.length + ')', options: all }
  }
  if (/품절|매진/.test(lab(cand[0]))) return { ...R, error: 'sold_out', note: '옵션 품절: ' + opt }
  await page.click(idL(cand[0]))
  await sleep(1800)
  ls = await lines({ interactive: true })
}
const g = ls.find(l => /^\[\d+\] link "선물"/.test(l)) || (await lines({ query: '선물' })).find(l => /^\[\d+\] link "선물"/.test(l))
if (!g) return { ...R, error: 'no_gift_button', note: '선물 버튼 없음' }
page.click(idL(g)).catch(() => {})
let loginSeen = null
for (let i = 0; i < 30; i++) {
  await sleep(600)
  const ts = await tabs.list()
  const gi = ts.find(t => /pay\.ssg\.com\/cart\/giftInfo/.test(t.url || ''))
  if (gi) { await tabs.switch(gi.id); try { await page.waitFor(/배송지 대신 입력하기/, 8000) } catch (e) {} return { ...R, ok: true, gift_tab: gi.id } }
  const lg = ts.find(t => t.kind === 'popup' && /popupLogin|member\/login/.test(t.url || ''))
  if (lg) loginSeen = lg.id
}
if (loginSeen) return { ...R, error: 'login_required', note: 'SSG 로그인 팝업(선물 화면 안 뜸)', login_popup: loginSeen }
return { ...R, note: '선물 정보 화면이 안 뜸' }
