// 29CM 결제수단 견적 — 라디오를 골라 결제금액·적립을 읽는다. 결제 안 함.
// 탭: args.tab > 주문서 하나뿐 > args.expect 대조. 페이코·KB Pay 는 '다른 결제 방법' 하위 버튼.
// reward = 적립 혜택(후기·삼성카드 제외). 무신사페이 기본 카드가 등록 카드 아니면 registered:false.
// 누른 뒤 선택 표시를 확인 못 하면 그 수단 견적을 버린다.
// args: profile, methods(이름 배열), tab, expect  반환 {quotes:[{method,card,cost,reward,points_used,registered,allowed,available}], base_cost, note}
const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d/.test(l))
const idOf = l => parseInt(l.slice(1))
const nameOf = l => (l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1]
const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_/:().,[\]·]/g, '')
// --- 주문서 탭 고르기(공통) ---
async function formInfo() {
  const t = (await page.get({})).tree, tx = text(t)
  const nos = [...new Set([...t.matchAll(/\/product\/catalog\/(\d+)/g)].map(m => m[1]))]
  const names = lines(t).filter(l => /\] link "[^"]+" href=\S*\/product\/catalog\//.test(l)).map(nameOf)
  let opt = ''
  for (const n of names) { const a = tx.indexOf(n), m = a >= 0 ? tx.slice(a + n.length, a + n.length + 120).match(/^\s*(.*?)\s*\d+개/) : null; if (m) opt += ' ' + m[1] }
  return { tx, nos, name: names.join(' '), opt: opt.trim() }
}
function mismatch(f, e) {
  if (!e) return null
  if (typeof e === 'string') e = { name: e }
  const no = String(e.product_no || (String(e.product_url || '').match(/(?:catalog|products)\/(\d+)/) || [])[1] || '')
  if (no && !f.nos.includes(no)) return '상품번호 ' + f.nos + ' ≠ ' + no
  const sz = ((e.option || '') + ' ' + (e.selected || '')).match(/(?<![\d.])\d{2,3}(?:\.5)?(?![\d.])/g) || []
  if (sz.length && !sz.some(x => new RegExp('(?<![\\d.])' + x + '(?![\\d.])').test(f.opt))) return '옵션 ' + sz + ' ≠ ' + f.opt
  const lz = s => String(s).toUpperCase().match(/(?<![A-Z])(X{0,3}S|M|X{0,3}L|\dXL|FREE)(?![A-Z])/g) || [], el = lz((e.option || '') + ' ' + (e.selected || ''))
  if (!sz.length && el.length && lz(f.opt).length && !lz(f.opt).some(x => el.includes(x))) return '옵션 ' + el + ' ≠ ' + f.opt
  const w = String(e.name || '').split(/[\s/()[\],·_:-]+/).filter(x => !/^\d+$/.test(x) && !/^(나이키|아디다스|뉴발란스|정품|남성|여성|공용|블랙|화이트|nike|adidas|black|white)$/i.test(x) && (/[가-힣]{2}/.test(x) || x.length >= 4))
  if (w.length && !w.some(x => norm(f.name).includes(norm(x)))) return '상품명 ' + w.slice(0, 4) + ' 없음'
  return null
}
async function pickForm() {
  let c = (await tabs.list()).filter(x => /29cm\.co\.kr\/order\/checkout/.test(x.url || ''))
  if (args.tab) c = c.filter(x => x.id === String(args.tab))
  const q_=args.profile,m_=c.filter(x=>!q_||!x.profile||x.profile===q_)
  if(m_[0])c=m_
  if (!c.length) return { err: 'no checkout tab' }
  const ok = []
  let why = null
  for (const x of c) {
    await tabs.switch(x.id)
    await page.waitFor(/(?:총|최종) 결제 ?금액/, 8000).catch(() => {})
    const f = await formInfo(), m = mismatch(f, args.expect)
    if (m) why = m; else ok.push({ id: x.id, f })
  }
  if (ok.length !== 1) return { err: ok.length ? 'multiple checkout tabs — args.expect/tab 필요' : 'order form mismatch', why }
  await tabs.switch(ok[0].id)
  return ok[0]
}
// --- 결제수단 라디오 ---
async function radios() {
  const r = (await page.get({ selector: 'label:has(input[type=radio])' })).tree
  // 이름 없는 라디오만(현금영수증 라디오는 이름이 있다), 번호 순 = 화면 순
  const ids = lines(r).filter(l => /\] radio value=/.test(l)).map(idOf).sort((x, y) => x - y), tx = text(r).replace(/소득공제용.*$/, '')
  const K = [['적립', /구매 적립금 받기/], ['선할인', /선할인 받기/], ['무신사머니', /무신사머니/], ['무신사페이', /무신사페이/], ['토스페이', /토스페이/], ['카카오페이', /카카오페이/], ['카드', /카드 결제/], ['기타', /다른 결제 방법/]]
  const got = []
  let p = 0
  for (const [k, re] of K) { const i = tx.slice(p).search(re); if (i >= 0) { got.push(k); p += i + 1 } }
  return got.length === ids.length ? Object.fromEntries(got.map((k, i) => [k, ids[i]])) : null
}
const seg = tx => tx.slice(tx.indexOf('결제 방법'), tx.indexOf('주문 내용을'))
async function settle(prev) {
  let last = null, tx = ''
  for (let i = 0; i < 20; i++) {
    await sleep(150)
    tx = text((await page.get({})).tree)
    const s = seg(tx)
    if (s === last && (s !== prev || i >= 3)) break
    last = s
  }
  return tx
}
// 선택 표시(실측): 머니=보유 잔액, 페이=카드 목록·결제수단 추가, 기타=하위 버튼, 토스·카카오=현금영수증, 카드=없음
const shown = tx => { const s = seg(tx); return { money: /보유 잔액 [\d,]+원/.test(s), pay: /결제수단 추가하기|\(\s*[\d*]{2,6}\s*\)\s*(신용|체크)카드/.test(s), etc: /PIN번호 결제|가상계좌|휴대폰결제/.test(s), cash: /현금 영수증/.test(s) } }
const dsc = tx => (tx.match(/ㄴ 결제 즉시 할인 ([^ㄴ\d-]+?) ?-[\d,]+원/) || [])[1]
const row = tx => {
  const cost = num((tx.match(/(?:총|최종) 결제 ?금액 ([\d,]+)원/) || [])[1])
  const points_used = num((tx.match(/ㄴ 보유 적립금 사용 -?([\d,]+)원/) || [])[1])
  const e = tx.indexOf('총 적립 혜택'), b = e > 0 ? tx.lastIndexOf('적립 혜택', e - 1) : -1
  const rs = b >= 0 ? tx.slice(b, e) : ''
  let reward = 0
  for (const m of rs.matchAll(/([^+]{0,40})\+\s*([\d,]+)\s*원/g)) if (!/후기|리뷰|삼성카드/.test(m[1])) reward += num(m[2])
  return { cost, reward, points_used }
}
const F = await pickForm()
if (F.err) return { quotes: [], base_cost: null, note: F.err + (F.why ? ': ' + F.why : '') }
const R = await radios()
if (!R) return { quotes: [], base_cost: null, note: '결제수단 라디오를 라벨과 맞추지 못함' }
const t0 = F.f.tx
// 수단과 무관한 기준 금액(결제 즉시 할인·제휴카드 할인을 되돌림)
const base_cost = row(t0).cost + num((t0.match(/ㄴ 결제 즉시 할인 [^ㄴ]*?-([\d,]+)원/) || [])[1]) + num((t0.match(/ㄴ 제휴카드[^ㄴ]*?-([\d,]+)원/) || [])[1])
const want = Array.isArray(args.methods) && args.methods.length ? args.methods : ['무신사머니', '무신사페이', '토스페이', '카카오페이', '페이코']
const quotes = [], notes = []
let cur = seg(t0)
const click = async id => { await page.click(id); const tx = await settle(cur); cur = seg(tx); return tx }
for (const m of want) {
  const n = norm(m)
  let tx = null, q = null
  if (n.includes('무신사머니') && R['무신사머니']) {
    tx = await click(R['무신사머니'])
    const ok = /보유 잔액 [\d,]+원/.test(tx)
    q = { method: '무신사머니', card: null, available: ok }
    if (!ok) notes.push('무신사머니 보유 잔액 안 보임(연결 계좌 없음?)')
  } else if (n.includes('무신사페이') && R['무신사페이']) {
    tx = await click(R['무신사페이'])
    const sec = (tx.split('무신사페이').slice(1).join('무신사페이').split('토스페이')[0]) || ''
    // 금액은 맨 앞(기본) 카드로 읽힌다 — 그게 무신사 삼성카드거나 제휴카드 할인이 붙으면 등록 카드 견적이 아니다
    const first = (sec.match(/([가-힣A-Za-z]{2,12}카드)\s*\(\s*[\d*]{2,6}\s*\)/) || [])[1]
    const ti = tx.indexOf('결제 금액 총 주문')
    const reg = !!first && shown(tx).pay && ti >= 0 && !/무신사\s*삼성/.test(first) && !/제휴카드/.test(tx.slice(ti))
    q = { method: '무신사페이', card: reg ? first : null, registered: reg }
    if (!reg) notes.push('무신사페이 기본 카드가 등록 카드 아님(' + (first || '없음') + ')')
  } else if (/토스|카카오/.test(n)) {
    const k = n.includes('토스') ? '토스페이' : '카카오페이'
    if (R[k]) { tx = await click(R[k]); const s = shown(tx), d = dsc(tx); if (s.cash && !s.money && !s.pay && !s.etc && !(d && !norm(d).includes(norm(k)))) q = { method: k, card: null }; else notes.push(k + ' 선택 확인 실패') }
  } else if (n === '카드' || n.includes('카드결제')) {
    if (R['카드']) { tx = await click(R['카드']); const s = shown(tx); if (!s.cash && !s.money && !s.pay && !s.etc && !dsc(tx)) q = { method: '카드 결제', card: null }; else notes.push('카드 결제 선택 확인 실패') }
  } else if (R['기타']) {
    // 다른 결제 방법 → 하위 수단 버튼(이름이 정확히 같은 것 — 위쪽 '페이코 X 포인트' 배너는 이름이 다르다)
    await click(R['기타'])
    const sub = lines((await page.get({})).tree).find(l => /\] button "/.test(l) && norm(nameOf(l)) === n)
    if (sub) {
      // 즉시 할인 줄이 다른 수단 이름이면 하위 수단이 안 바뀐 것이다(앞 수단 금액을 이 이름으로 적지 않는다)
      tx = await click(idOf(sub)); const d = dsc(tx)
      if (shown(tx).etc && !(d && !norm(d).includes(n))) q = { method: m, card: null }; else notes.push(m + ' 선택 확인 실패')
    } else notes.push(m + ' 하위 수단 없음')
  }
  if (!q) continue
  const r = row(tx)
  if (!r.cost) { notes.push(m + ' 금액 못 읽음'); continue }
  quotes.push({ registered: true, allowed: true, available: true, ...q, ...r })
}
return { quotes, base_cost, note: notes.join('; ') || null }
