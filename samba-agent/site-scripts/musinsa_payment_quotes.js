// 무신사 결제수단 견적(2026-09-26 재작성): 주문서에서 수단 라디오를 하나씩 골라 화면의 총 결제 금액·적립(후기 제외)·사용 적립금을 읽는다.
// 결제하기는 누르지 않는다. 주문서 탭은 args.tab, 없으면 레인에 하나뿐인 무신사 주문서(여럿이면 멈춘다 — 197←196 사고).
// 원가 = cost × 카드 청구할인 − reward + points_used (하네스 effective_cost). 무신사페이 카드는 등록 카드 목록 맨 앞(결제 카드).
// 반환 {quotes:[{method,card,cost,reward,points_used,registered,allowed,available}], base_cost, note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /musinsa\.com\/order\/order-form/
const get = async o => { for (let i = 0; i < 6; i++) { try { return (await page.get(o)).tree } catch (e) { await sleep(600) } } return '' }
const notes = []

const ofs = (await tabs.list()).filter(t => OF.test(t.url || ''))
const tab = args.tab ? ofs.find(t => t.id === args.tab) : ofs.length === 1 ? ofs[0] : null
if (!tab) return { quotes: [], base_cost: null, note: ofs.length ? `order forms ${ofs.length} open — pass args.tab` : 'no order form' }
await tabs.switch(tab.id)
try { await page.waitFor('총 결제 금액', 8000) } catch (e) {}

// 화면 값: 아래 결제 금액 칸에서 읽는다
// 사용 적립금은 '보유 적립금 사용' 칸 값만 — 화면 '적립금 사용 -N원'에는 선할인이 섞인다(선할인은 할인이라 되더하지 않는다)
const read = async () => {
  const tr = await get({ interactive: 1 }), box = tr.match(/textbox "보유 적립금 사용" value="([\d,]+)"/)
  const tx = nz((await get({})).split('PAGE TEXT:')[1])
  const s = tx.slice(tx.lastIndexOf('결제 금액 상품 금액'))
  const tot = num((s.match(/총 적립 금액\s*([\d,]+)\s*원/) || [])[1]), rev = num((s.match(/후기 적립\s*최대\s*([\d,]+)\s*원/) || [])[1])
  return {
    tx,
    cost: num((s.match(/총 결제 금액\s*(?:\d+%\s*)?([\d,]+)\s*원/) || [])[1]),
    reward: Math.max(tot - rev, 0),
    points_used: box ? num(box[1]) : 0
  }
}
const radioOf = (tree, nm) => { const l = tree.split('\n').find(x => /^\[\d+\] radio "/.test(x) && x.includes('] radio "' + nm)); return l ? parseInt(l.slice(1)) : 0 }
// 트리가 길면 잘려 라디오가 빠진다 — 글자 찾기로 한 번 더
const radio = async nm => radioOf(await get({ interactive: 1 }), nm) || radioOf(String(await page.find(nm)), nm)
const base = await read()
const NAMES = ['무신사머니', '무신사페이', '토스페이', '카카오페이', '페이코', '네이버페이']
const want = (Array.isArray(args.methods) && args.methods.length ? args.methods : NAMES).map(w => NAMES.find(n => w.includes(n) || n.includes(w)) || w)
// 무신사머니가 주문서에 있으면 그 줄은 늘 넣는다(하네스 검사)
if (!want.includes('무신사머니') && await radio('무신사머니')) want.unshift('무신사머니')
const quotes = []
for (const m of [...new Set(want)]) {
  const id = await radio(m)
  if (!id) { notes.push(m + ' 없음'); continue }
  await page.click(id)
  try { await page.waitFor(m + ' 결제', 3000) } catch (e) { await sleep(600) }
  const r = await read()
  const q = { method: m, card: null, cost: r.cost, reward: r.reward, points_used: r.points_used, registered: true, allowed: true, available: r.cost > 0 }
  const sec = r.tx.slice(r.tx.indexOf('결제 수단'), r.tx.indexOf('결제 금액 상품 금액'))
  if (m === '무신사페이') {
    // 등록 카드: '카드이름 (705*) 체크카드|신용카드' — '혜택 받기' 광고 카드는 등록 카드가 아니다
    const cards = [...sec.matchAll(/([가-힣A-Za-z0-9 ]{2,30}?)\s*\((\d{3,4}\*?)\)\s*(신용카드|체크카드)/g)].map(x => nz(x[1].split(/혜택 관리|혜택 받기|추가 할인|적립/).pop()).replace(/^(일시불|할부)\s*/, ''))
    q.card = cards[0] || null
    if (!cards.length) { q.registered = false; q.available = false }
  }
  if (m === '무신사머니') {
    // 머니가 모자라면 연결 계좌에서 자동 충전된다(혜택 없는 은행 충전) — 보유 머니가 결제액보다 적은 계정은 머니로 내지 않는다
    // (사용자 2026-10-05: 머니 있는 buyer01 두고 다른 계정이 은행 충전으로 결제했다)
    const bal = num((sec.match(/현재 보유 머니\s*([\d,]+)\s*원/) || [])[1])
    q.balance = bal
    if (bal < r.cost) { q.available = false; q.note = `보유 머니 ${bal} < ${r.cost} — 충전결제 금지` }
  }
  quotes.push(q)
}
// 기본 표시로 되돌린다(무신사머니)
const back = await radio('무신사머니')
if (back) { await page.click(back); await sleep(300) }
return { quotes, base_cost: base.cost || null, note: notes.join('; ') || null }
