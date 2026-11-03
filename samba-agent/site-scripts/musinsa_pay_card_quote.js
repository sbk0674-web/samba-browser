const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const OF = /musinsa\.com\/order\/order-form/
const get = async o => { for (let i = 0; i < 6; i++) { try { return (await page.get(o)).tree } catch (e) { await sleep(600) } } return '' }
let ofs = (await tabs.list()).filter(t => OF.test(t.url || ''))
if (args.tab && ofs.some(t => t.id === args.tab)) ofs = ofs.filter(t => t.id === args.tab)
else if (args.profile && ofs.some(t => t.profile === args.profile)) ofs = ofs.filter(t => t.profile === args.profile)
// 같은 계정에 주문서가 여럿이면 활성 탭, 없으면 마지막 탭
const tab = ofs.length === 1 ? ofs[0] : ofs.length ? (ofs.find(t => t.active) || ofs[ofs.length - 1]) : null
if (!tab) return { ok: false, note: 'no order form' }
await tabs.switch(tab.id)
try { await page.waitFor('총 결제 금액', 8000) } catch (e) {}
const radioOf = t => { const l = t.split('\n').find(x => /^\[\d+\] radio "무신사페이/.test(x)); return l ? parseInt(l.slice(1)) : 0 }
const rid = radioOf(await get({ interactive: 1 })) || radioOf(String(await page.find('무신사페이')))
if (!rid) return { ok: false, note: 'no musinsapay radio' }
await page.click(rid)
try { await page.waitFor('무신사페이 결제', 3000) } catch (e) { await sleep(800) }
const tr = await get({ interactive: 1 }), box = tr.match(/textbox "보유 적립금 사용" value="([\d,]+)"/)
const t = nz((await get({})).split('PAGE TEXT:')[1])
const pay = t.slice(t.indexOf('결제 수단'), t.indexOf('결제 금액 상품 금액'))
const cards = [...pay.matchAll(/([가-힣A-Za-z0-9 ]{2,30}?)\s*\((\d{3,4}\*?)\)\s*(신용카드|체크카드)/g)].map(m => nz(m[1].split(/혜택 관리|혜택 받기|추가 할인|적립/).pop()).replace(/^(일시불|할부)\s*/, '')).filter(Boolean)
if (!cards.length) return { ok: false, cards: [], note: 'no registered card' }
const s = t.slice(t.lastIndexOf('결제 금액 상품 금액'))
const cost = num((s.match(/총 결제 금액\s*(?:\d+%\s*)?([\d,]+)\s*원/) || [])[1])
const tot = num((s.match(/총 적립 금액\s*([\d,]+)\s*원/) || [])[1]), rev = num((s.match(/후기 적립\s*최대\s*([\d,]+)\s*원/) || [])[1])
const q = { method: '무신사페이', card: cards[0], cost, reward: Math.max(0, tot - rev), points_used: box ? num(box[1]) : 0, registered: true, allowed: true, available: cost > 0, note: '등록 기본 카드(맨 앞) — 결제도 이 카드로 된다' }
return { ok: cost > 0, quotes: [q], cards }