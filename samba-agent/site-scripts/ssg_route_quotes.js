// SSG 경로 비교(2026-09-27): 같은 SSG 상품(itemId)을 직접·다나와·에누리·애드픽 경유로 열어 진입 주소와 상품 페이지 가격을 읽는다.
// 결제·주문·로그인 없음. SSG 는 진입 경로를 ckwhere(주소 인자+CKWHERE 쿠키, 마지막 진입이 덮어씀)로 기록한다 —
// 다나와(ssg_danawa/s_danawa)·에누리(ssg_enuri/s_enuri)·애드픽(cps_linkmine1)은 서로 배타다(동시 적용 불가).
// 경로별 실제 할인은 주문서에서만 보인다 — 하네스는 routes[].entry_url 로 ssg_product_snapshot 을 경로마다 돌려 cost 를 비교한다.
// 사용자 규칙(2026-09-27): SSG 주문은 신세계몰(6004)·신세계백화점(6009) 상품만 — 도착 주소가 아니면 mall_ok:false.
// 다나와는 신세계몰 줄(cmpnyc ED901 → ckwhere s_danawa), 에누리는 신세계몰 줄(vcode 47 → s_enuri)만 쓴다. SSG.COM 줄(TN118·vcode 6665)은 쓰지 않는다.
// 인자 {sku: SSG 상품 주소, model?: 모델코드(HF5441-100), name?: 상품명(모델 추정용), profile?, routes?: ['direct','danawa','enuri','adpick'], allow_department?: 신세계백화점(6009)도 허용}
// 반환 {ok, item_id, model, routes:[{route, entry_url, landed, ckwhere, mall_ok, listed, page_best, page_sale, sold_out, percent?, note?}], note}
const nz = s => String(s || '').replace(/\s+/g, ' ').trim()
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0
// 브릿지 run_script 제한(75초)보다 훨씬 먼저 빠져야 하네스가 주문 자체를 붙잡지 않는다.
const t0 = Date.now(), late = () => Date.now() - t0 > 38000
const pf = args.profile ? { profile: args.profile } : {}
const sku = String(args.sku || '')
const item = (sku.match(/itemId=(\d+)/) || [])[1]
if (!item) return { ok: false, note: 'sku 에 itemId 없음' }
// 모델코드: 인자 → 상품명의 영문+숫자 토큰(HF5441 100 → HF5441-100)
let model = nz(args.model)
if (!model) {
  const m = String(args.name || '').match(/\b([A-Z]{1,4}\d{3,6}[A-Z0-9]{0,4})(?:[ _-](\d{3}))?\b/)
  model = m ? (m[2] ? m[1] + '-' + m[2] : m[1]) : ''
}
const want = Array.isArray(args.routes) && args.routes.length ? args.routes : ['direct', 'danawa', 'enuri', 'adpick']
const opened = []
const open = async url => {
  const id = (String(await tabs.open({ ...pf, url })).match(/tab (\S+)/) || [])[1]
  if (id) { opened.push(id); await tabs.switch(id) }
  return id
}
const closeAll = async () => { for (const id of opened) { try { await tabs.close(id) } catch (e) {} } opened.length = 0 }
const tree = async o => { for (let i = 0; i < 4; i++) { try { const g = await page.get(o || {}); if (g && g.tree) return g.tree } catch (e) {} await sleep(500) } return '' }
const text = async () => nz((await tree()).split('PAGE TEXT:')[1])
const ids = t => t.split('\n').filter(l => /^\[\d+\]/.test(l))
const hrefOf = l => (l.match(/href=(\S+)/) || [])[1] || ''
// SSG 상품 페이지 가격: 최적가(쿠폰 반영)·판매가, 품절
const readSsg = async () => {
  try { await page.waitFor(/바로구매|품절|입고알림/, 10000) } catch (e) {}
  const url = await page.url(), t = await text()
  if (/접속이 잠시 제한|자동화된 환경/.test(t)) return { landed: url, blocked: true, mall_ok: false, same_item: false }
  const best = num((t.match(/최적가\s*([\d,]+)\s*원/) || [])[1])
  const sale = num((t.match(/삭선가격\s*[\d,]+원\s*([\d,]+)\s*원/) || [])[1]) || best
  return {
    landed: url, mall_ok: mallOk(url), ckwhere: (url.match(/[?&]ckwhere=([^&]+)/) || [])[1] || null,
    same_item: new RegExp('[?&]itemId=' + item + '(?!\\d)').test(url),
    page_best: best || null, page_sale: sale || null,
    // 품절 확증: '바로구매' 요소가 없고 품절·입고알림 요소가 있을 때만(페이지 글자 전체로 판단하지 않는다)
    sold_out: (await page.idOf('바로구매', 0)) < 0 && ((await page.idOf('입고알림', 0)) >= 0 || (await page.idOf('품절', 0)) >= 0)
  }
}
// 허용 몰: 신세계몰(6004)·신세계백화점(6009는 allow_department:true 때만). 이마트·트레이더스 등은 금지
const mallOk = u => /shinsegaemall\.ssg\.com/.test(u) || /[?&]siteNo=6004(?!\d)/.test(u) || (args.allow_department === true && (/department\.ssg\.com/.test(u) || /[?&]siteNo=6009(?!\d)/.test(u)))
const out = []
// 도착 상품이 주문 itemId 가 아니면 진입 주소를 쓰지 않는다
const add = r => out.push(r.entry_url && r.landed && !r.same_item ? { ...r, entry_url: null, note: r.blocked ? 'SSG 봇 차단 화면' : '다른 상품으로 도착(itemId 불일치)' } : r)

if (want.includes('direct')) {
  await open(sku)
  add({ route: 'direct', entry_url: sku, listed: null, ...(await readSsg()) })
  await closeAll()
}

// 다나와: 모델 검색 → 가격비교 카탈로그(pcode) → link_pcode=itemId 인 신세계몰(ED901) 줄 → 브리지 주소로 진입
if (want.includes('danawa') && model && !late()) {
  await open('https://search.danawa.com/dsearch.php?query=' + encodeURIComponent(model))
  try { await page.waitFor('pcode', 8000) } catch (e) {}
  const pc = [...new Set(ids(await tree({ selector: 'a[href*="prod.danawa.com/info/?pcode="]' })).map(l => (hrefOf(l).match(/pcode=(\d+)/) || [])[1]).filter(Boolean))].slice(0, 1)
  let hit = null
  for (const p of pc) {
    if (late() || hit) break
    await open('https://prod.danawa.com/info/?pcode=' + p)
    try { await page.waitFor('쇼핑몰별', 8000) } catch (e) {}
    for (const c of ['ED901']) {
      const rows = ids(await tree({ selector: `a[href*="link_pcode=${item}"][href*="cmpnyc=${c}"]` }))
      if (!rows.length) continue
      const cate = (hrefOf(rows[0]).match(/cate1=\d+&cate2=\d+&cate3=\d+&cate4=\d+/) || [])[0] || ''
      const prices = rows.map(l => (l.match(/"([\d,]{4,})원"/) || [])[1]).filter(Boolean).map(num)
      const cand = { pcode: p, cmpnyc: c, listed: prices.length ? Math.min(...prices) : null, entry_url: `https://prod.danawa.com/bridge/loadingBridge.html?${cate ? cate + '&' : ''}pcode=${p}&cmpnyc=${c}&link_pcode=${item}` }
      if (!hit || (cand.listed && (!hit.listed || cand.listed < hit.listed))) hit = cand
    }
  }
  await closeAll()
  if (hit && !late()) {
    await open(hit.entry_url)
    add({ route: 'danawa', ...hit, ...(await readSsg()) })
    await closeAll()
  } else add({ route: 'danawa', entry_url: null, note: pc.length ? '다나와 카탈로그에 이 itemId 없음' : '다나와 검색 결과 없음' })
}

// 에누리: 모델 검색 → 이동 링크(Redirect.jsp pl_no) 중 신세계 줄·카탈로그의 신세계몰(vcode 47) → 진입해 itemId·몰 대조
if (want.includes('enuri') && model && !late()) {
  await open('https://price.enuri.com/search?keyword=' + encodeURIComponent(model))
  try { await page.waitFor(/원/, 8000) } catch (e) {}
  await sleep(1200)
  const all = ids(await tree({ selector: 'a[href*="Redirect.jsp"], a[href*="/catalog/"]' }))
  const pls = all.filter(l => /Redirect/.test(l) && /신세계/.test(l)).map(l => (hrefOf(l).match(/pl_no=(\d+)/) || [])[1])
  const cats = [...new Set(all.map(l => (hrefOf(l).match(/\/catalog\/(\d+)/) || [])[1]).filter(Boolean))].slice(0, 1)
  for (const c of cats) {
    if (late()) break
    await open('https://price.enuri.com/catalog/' + c)
    try { await page.waitFor('구매하기', 8000) } catch (e) {}
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

// 애드픽: 적립 추적 링크(프로필의 애드픽 로그인). percent 는 결제액 대비 적립률(하네스가 reward 로 계산)
if (want.includes('adpick') && !late()) {
  // 경로 인자(ckwhere·utm·appPopYn·service_id)를 뺀 주소 — 인자 순서와 무관하게 '?' 뒤를 다시 조립한다
  const [base, qs] = sku.split('?')
  const keep = String(qs || '').split('&').filter(kv => kv && !/^(ckwhere|utm_\w+|appPopYn|service_id)=/.test(kv))
  const clean = base + (keep.length ? '?' + keep.join('&') : '')
  let a = {}
  try { a = JSON.parse(await affiliate.adpick(clean, args.profile || 'default')) } catch (e) { a = { ok: false, note: String(e) } }
  if (a.ok && a.trackinglink && !late()) {
    await open(a.trackinglink)
    add({ route: 'adpick', entry_url: a.trackinglink, percent: parseFloat(a.percent) || null, listed: null, ...(await readSsg()) })
    await closeAll()
  } else add({ route: 'adpick', entry_url: null, note: a.note || '애드픽 링크 없음' })
}
await closeAll()
return { ok: out.some(r => r.entry_url && r.mall_ok), item_id: item, model: model || null, routes: out, note: late() ? '시간 초과로 일부 경로 생략' : null }
