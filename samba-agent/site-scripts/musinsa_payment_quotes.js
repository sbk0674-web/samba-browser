const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /musinsa\.com\/order\/order-form/
const get = async o => { for (let i = 0; i < 6; i++) { try { return (await page.get(o)).tree } catch (e) { await sleep(600) } } return '' }
const notes = []
const ofs = (await tabs.list()).filter(t => OF.test(t.url || ''))
let tab = args.tab ? ofs.find(t => t.id === args.tab) : ofs.length === 1 ? ofs[0] : null
if (!tab && !args.tab && ofs.length > 1) {
  const pf = args.profile ? ofs.filter(t => t.profile === args.profile) : ofs
  const cand = pf.length ? pf : ofs
  tab = cand.find(t => t.active) || cand[0]
  notes.push(`order forms ${ofs.length} open — 사용 탭 ${tab.id}`)
}
if (!tab) return { quotes: [], base_cost: null, note: ofs.length ? `order forms ${ofs.length} open — pass args.tab` : 'no order form' }
await tabs.switch(tab.id)
try { await page.waitFor('총 결제 금액', 8000) } catch (e) {}
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
const radio = async nm => radioOf(await get({ interactive: 1 }), nm) || radioOf(String(await page.find(nm)), nm)
const base = await read()
const NAMES = ['무신사머니', '무신사페이', '토스페이', '카카오페이', '페이코', '네이버페이']
const want = (Array.isArray(args.methods) && args.methods.length ? args.methods : NAMES).map(w => NAMES.find(n => w.includes(n) || n.includes(w)) || w)
if (!want.includes('무신사머니') && await radio('무신사머니')) want.unshift('무신사머니')
const quotes = []
const done = new Set()
const run = async m => {
  done.add(m)
  const id = await radio(m)
  if (!id) { notes.push(m + ' 없음'); return }
  await page.click(id)
  try { await page.waitFor(m + ' 결제', 3000) } catch (e) { await sleep(600) }
  const r = await read()
  const q = { method: m, card: null, cost: r.cost, reward: r.reward, points_used: r.points_used, registered: true, allowed: true, available: r.cost > 0 }
  const sec = r.tx.slice(r.tx.indexOf('결제 수단'), r.tx.indexOf('결제 금액 상품 금액'))
  if (m === '무신사페이') {
    const cards = [...sec.matchAll(/([가-힣A-Za-z0-9 ]{2,30}?)\s*\((\d{3,4}\*?)\)\s*(신용카드|체크카드)/g)].map(x => nz(x[1].split(/혜택 관리|혜택 받기|추가 할인|적립/).pop()).replace(/^(일시불|할부)\s*/, ''))
    q.card = cards[0] || null
    if (!cards.length) { q.registered = false; q.available = false }
  }
  if (m === '무신사머니') {
    const balanceMatch = sec.match(/현재 보유 머니\s*([\d,]+)\s*원/)
    const bal = balanceMatch ? num(balanceMatch[1]) : null
    q.balance = bal
    if (bal === null) { q.available = false; q.note = '보유 머니 잔액 미확인 — 충전결제 금지' }
    else if (bal < r.cost) { q.available = false; q.note = `보유 머니 ${bal} < ${r.cost} — 충전결제 금지` }
  }
  quotes.push(q)
}
for (const m of [...new Set(want)]) await run(m)
if (!quotes.some(q => q.method !== '무신사머니' && q.available)) {
  for (const m of NAMES) if (!done.has(m) && m !== '네이버페이') await run(m)
}
const back = await radio('무신사머니')
if (back) { await page.click(back); await sleep(300) }
return { quotes, base_cost: base.cost || null, note: notes.join('; ') || null }