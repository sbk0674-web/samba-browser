const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
const t0 = Date.now()
let dead = false
const late = () => dead || Date.now() - t0 > 40000
const TO = (p, ms, dv) => Promise.race([Promise.resolve(p), sleep(ms).then(() => dv)])
const pf = args.profile ? { profile: args.profile } : {}
const sku = String(args.sku || '')
const item = (sku.match(/itemId=(\d+)/) || [])[1]
if (!item) return { ok: false, note: 'sku 에 itemId 없음' }
let model = nz(args.model)
if (!model) {
const m = String(args.name || '').match(/\b([A-Z]{1,4}\d{3,6}[A-Z0-9]{0,4})(?:[ _-](\d{3}))?\b/)
model = m ? (m[2] ? m[1] + '-' + m[2] : m[1]) : ''
}
const want = Array.isArray(args.routes) && args.routes.length ? args.routes : ['direct', 'danawa', 'enuri', 'adpick']
const opened = []
const open = async url => {
const id = (String(await TO(tabs.open({ ...pf, url }), 15000, '')).match(/tab (\S+)/) || [])[1]
if (id) { opened.push(id); await TO(tabs.switch(id), 5000) }
return id
}
const closeAll = async () => { for (const id of opened.splice(0)) { try { await TO(tabs.close(id), 4000) } catch (e) {} } }
const tree = async o => { for (let i = 0; i < 3; i++) { if (dead) return ''; try { const g = await TO(page.get(o || {}), 8000, null); if (g && g.tree) return g.tree } catch (e) {} await sleep(400) } return '' }
const text = async () => nz((await tree()).split('PAGE TEXT:')[1])
const ids = t => t.split('\n').filter(l => /^\[\d+\]/.test(l))
const hrefOf = l => (l.match(/href=(\S+)/) || [])[1] || ''
const mallOk = u => args.any_mall === true || /shinsegaemall\.ssg\.com|[?&]siteNo=6004(?!\d)/.test(u) || (args.allow_department === true && /department\.ssg\.com|[?&]siteNo=6009(?!\d)/.test(u))
const readSsg = async () => {
try { await TO(page.waitFor(/바로구매|품절|입고알림/, 8000), 9000) } catch (e) {}
const url = await TO(page.url(), 5000, ''), t = await text()
if (/접속이 잠시 제한|자동화된 환경/.test(t)) return { landed: url, blocked: true, mall_ok: false, same_item: false }
const best = num((t.match(/최적가\s*([\d,]+)\s*원/) || [])[1])
const sale = num((t.match(/삭선가격\s*[\d,]+원\s*([\d,]+)\s*원/) || [])[1]) || best
const buy = await TO(page.idOf('바로구매', 0), 4000, -1)
const soldBtn = (await TO(page.idOf('입고알림', 0), 4000, -1)) >= 0 || (await TO(page.idOf('품절', 0), 4000, -1)) >= 0
return {
landed: url, mall_ok: mallOk(url), ckwhere: (url.match(/[?&]ckwhere=([^&]+)/) || [])[1] || null,
same_item: new RegExp('[?&]itemId=' + item + '(?!\\d)').test(url),
page_best: best || null, page_sale: sale || null,
sold_out: buy < 0 && soldBtn
}
}
const out = []
const add = r => out.push(r.entry_url && r.landed && !r.same_item ? { ...r, entry_url: null, note: r.blocked ? 'SSG 봇 차단 화면' : '다른 상품으로 도착(itemId 불일치)' } : r)
const main = async () => {
if (want.includes('adpick')) {
const [base, qs] = sku.split('?')
const keep = String(qs || '').split('&').filter(kv => kv && !/^(ckwhere|utm_\w+|appPopYn|service_id)=/.test(kv))
const clean = base + (keep.length ? '?' + keep.join('&') : '')
let a = {}
try { a = JSON.parse(await TO(affiliate.adpick(clean, args.profile || 'default'), 15000, '{"ok":false,"note":"애드픽 시간초과"}')) } catch (e) { a = { ok: false, note: String(e) } }
if (a.ok && a.trackinglink) {
await open(a.trackinglink)
add({ route: 'adpick', entry_url: a.trackinglink, percent: parseFloat(a.percent) || null, listed: null, ...(await readSsg()) })
await closeAll()
} else add({ route: 'adpick', entry_url: null, note: a.note || '애드픽 링크 없음' })
}
if (want.includes('direct') && !late()) {
await open(sku)
add({ route: 'direct', entry_url: sku, listed: null, ...(await readSsg()) })
await closeAll()
}
if (want.includes('danawa') && model && !late()) {
await open('https://search.danawa.com/dsearch.php?query=' + encodeURIComponent(model))
await sleep(2500)
const pc = [...new Set(ids(await tree({ selector: 'a[href*="prod.danawa.com/info/?pcode="]' })).map(l => (hrefOf(l).match(/pcode=(\d+)/) || [])[1]).filter(Boolean))].slice(0, 1)
let hit = null, direct = null
if (!pc.length) {
const rows = ids(await tree({ selector: 'a[href*="cmpny_c="]' })).filter(l => (l.match(/link "([^"]*)"/) || [])[1] || '').filter(l => l.includes(item))
const rid = [...new Set(rows.map(l => (l.match(/^\[(\d+)\]/) || [])[1]))].slice(0, 3)
const base = (await tabs.list()).map(t => t.id), first = opened[0]
for (const r of rid) {
if (late() || direct) break
try { await TO(page.click(Number(r)), 5000) } catch (e) { continue }
await sleep(1500)
const nt = (await tabs.list()).filter(t => !base.includes(t.id))
for (const t of nt) { opened.push(t.id); base.push(t.id) }
const t = nt[nt.length - 1]
if (!t) continue
await TO(tabs.switch(t.id), 5000)
const rd = await readSsg()
if (rd.same_item && rd.mall_ok) direct = { route: 'danawa', entry_url: rd.landed, listed: null, ...rd }
else if (rd.blocked) break
await TO(tabs.switch(first), 5000)
}
await closeAll()
add(direct || { route: 'danawa', entry_url: null, note: '다나와 카탈로그 없음·검색 목록 신세계몰 줄이 이 itemId 로 안 감' })
} else {
await closeAll()
for (const p of pc) {
if (late()) break
await open('https://prod.danawa.com/info/?pcode=' + p)
await sleep(3000)
const rows = ids(await tree({ selector: `a[href*="link_pcode=${item}"]` }))
if (!rows.length) { await closeAll(); continue }
const cate = (hrefOf(rows[0]).match(/cate1=\d+&cate2=\d+&cate3=\d+&cate4=\d+/) || [])[0] || ''
const prices = rows.map(l => (l.match(/"([\d,]{4,})원"/) || [])[1]).filter(Boolean).map(num)
const cm = (hrefOf(rows[0]).match(/cmpnyc=(\w+)/) || [])[1] || 'ED901'
hit = { pcode: p, cmpnyc: cm, listed: prices.length ? Math.min(...prices) : null, entry_url: `https://prod.danawa.com/bridge/loadingBridge.html?${cate ? cate + '&' : ''}pcode=${p}&cmpnyc=${cm}&link_pcode=${item}` }
await closeAll()
}
await closeAll()
if (hit && !late()) {
await open(hit.entry_url)
add({ route: 'danawa', ...hit, ...(await readSsg()) })
await closeAll()
} else add({ route: 'danawa', entry_url: null, note: '다나와 카탈로그에 이 itemId 없음' })
}
}
if (want.includes('enuri') && model && !late()) {
await open('https://price.enuri.com/search?keyword=' + encodeURIComponent(model))
try { await TO(page.waitFor(/원/, 8000), 9000) } catch (e) {}
await sleep(1200)
const all = ids(await tree({ selector: 'a[href*="Redirect.jsp"], a[href*="/catalog/"]' }))
const pls = all.filter(l => /Redirect/.test(l) && /신세계/.test(l)).map(l => (hrefOf(l).match(/pl_no=(\d+)/) || [])[1])
const cats = [...new Set(all.map(l => (hrefOf(l).match(/\/catalog\/(\d+)/) || [])[1]).filter(Boolean))].slice(0, 1)
for (const c of cats) {
if (late()) break
await open('https://price.enuri.com/catalog/' + c)
try { await TO(page.waitFor('구매하기', 8000), 9000) } catch (e) {}
for (const l of ids(await tree({ selector: 'a[href*="vcode=47&"]' }))) pls.push((hrefOf(l).match(/pl_no=(\d+)/) || [])[1])
}
let got = null
for (const pl of [...new Set(pls.filter(Boolean))].slice(0, 2)) {
if (late() || got) break
const u = `https://www.enuri.com/move/Redirect.jsp?type=ex&cmd=move_${pl}&pl_no=${pl}`
await open(u)
const r = await readSsg()
if (r.same_item && r.mall_ok) got = { route: 'enuri', entry_url: u, pl_no: pl, listed: null, ...r }
}
await closeAll()
add(got || { route: 'enuri', entry_url: null, note: '에누리에서 이 itemId 로 가는 링크 못 찾음' })
}
}
let timedOut = false
await Promise.race([main().catch(e => { out.push({ route: 'error', entry_url: null, note: String(e).slice(0, 150) }) }), sleep(60000).then(() => { timedOut = true })])
dead = true
await closeAll()
return { ok: out.some(r => r.entry_url && r.mall_ok), item_id: item, model: model || null, routes: out, note: timedOut || Date.now() - t0 > 52000 ? '시간 초과로 일부 경로 생략' : null }