const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /pay\.ssg\.com\/(order|payment)/
const tree = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const text = async () => nz((await tree()).split('PAGE TEXT:')[1])
const lines = async () => (await tree({ interactive: true })).split('\n')
const notes = []
const ofs = (await tabs.list()).filter(t => t.kind === 'tab' && OF.test(t.url || ''))
let tab = args.tab ? ofs.find(t => t.id === String(args.tab)) : null
if (!tab && ofs.length === 1) { tab = ofs[0]; if (args.tab) notes.push('args.tab 없음 — 단일 주문서 탭 사용') }
if (!tab && !args.tab && ofs.length === 1) tab = ofs[0]
if (!tab) return { quotes: [], base_cost: null, note: ofs.length ? `order forms ${ofs.length} open — pass args.tab` : 'no order form' }
await tabs.switch(tab.id)
try { await page.waitFor('결제 예정금액', 8000) } catch (e) {}

const read = async () => {
  const t = await text()
  const cost = num((t.match(/결제\s*예정\s*금액\s*([\d,]{3,})\s*원/) || [])[1])
  const reward = num((t.match(/적립\s*예정\s*SSG\s*MONEY\s*([\d,]+)\s*원/i) || [])[1])
  const used = num((t.match(/포인트\s*사용\s*-?\s*([\d,]+)\s*원/) || [])[1])
  return { t, cost, reward, used }
}
const clickLine = async re => { const l = (await lines()).find(x => re.test(x)); if (!l) return false; await page.click(parseInt(l.slice(1))); await sleep(1200); return true }
const base = await read()
const quotes = []
const ALLOWED = /^(현대|KB|국민|롯데|신한|농협|NH)/
const cardLines = (await lines()).filter(l => /^\[\d+\] radio ".+선택하기" name=_cpay_ssgpay_card/.test(l))
const orig = (cardLines.find(l => /value="on"/.test(l)) || '').match(/radio "(.+?)"/)
for (const l of cardLines) {
  const label = (l.match(/radio "(.+?)\s*선택하기"/) || [])[1] || ''
  const card = nz(label.replace(/\(\d{3,4}\*\)/, '').replace(/\s*\(\S*$/, ''))
  if (!ALLOWED.test(card)) { quotes.push({ method: 'SSGPAY', card, cost: base.cost, reward: 0, points_used: base.used, registered: true, allowed: false, available: false }); continue }
  await page.click(parseInt(l.slice(1)))
  await sleep(1000)
  const r = await read()
  quotes.push({ method: 'SSGPAY', card, cost: r.cost, reward: 0, points_used: r.used, registered: true, allowed: true, available: r.cost > 0 })
}
if (!cardLines.length) notes.push('SSGPAY 등록 카드 없음')
if (await clickLine(/^\[\d+\] checkbox "SSG MONEY 충전결제" value="off"/)) {
  const r = await read()
  const acct = /충전\s*금액\s*\S*은행|충전\s*금액\s*\S*\(\d/.test(r.t)
  const rw = r.reward || num((r.t.match(/충전\s*후\s*결제하면\s*SSG\s*MONEY\s*([\d,]+)\s*원\s*적립\s*예정/i) || [])[1])
  quotes.push({ method: 'SSG MONEY 충전결제', card: null, cost: r.cost, reward: rw, points_used: r.used, registered: acct, allowed: true, available: acct && r.cost > 0 })
  if (!acct) notes.push('충전결제 연결 계좌 없음')
  await clickLine(/^\[\d+\] checkbox "SSG MONEY 충전결제" value="on"/)
} else notes.push('충전결제 칸 없음')
if (orig) { const l = (await lines()).find(x => x.includes('radio "' + orig[1] + '"')); if (l) { await page.click(parseInt(l.slice(1))); await sleep(600) } }
else if (cardLines.length) notes.push('처음엔 카드 미선택 — 마지막 견적 카드가 선택된 채 남음(결제 진입이 카드를 다시 고른다)')
return { quotes, base_cost: base.cost || null, note: notes.join('; ') || null }