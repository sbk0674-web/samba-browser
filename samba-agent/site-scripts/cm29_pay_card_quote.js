// 29CM 무신사페이 기본 카드 견적(2026-09-26 재작성) — 주문서에서 무신사페이를 골라 등록 카드 목록 맨 앞(기본) 카드와
// 그때의 총 결제금액·적립(후기·삼성카드 제외)·사용 적립금을 읽는다. 결제 안 함. '무신사 삼성카드'는 없는 제휴카드라 등록 카드로 치지 않는다
// (기본 카드가 그것이거나 제휴카드 할인이 붙으면 견적을 내지 않는다). 등록 카드가 없으면 {ok:true, quotes:[], cards:[], note:'no registered card'}.
// 주문서 탭: args.tab > 하나뿐 > args.expect 대조. args: profile, tab, expect
// 반환 {ok, quotes:[{method:'무신사페이',card,cost,reward,points_used,registered,allowed,available}], cards, note}
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
  // 계정 비교를 동시에 돌리면 계정마다 주문서 탭이 열린다 — 이 계정(프로필)의 탭만 본다
  // (실기 2026-09-29: 'multiple checkout tabs' 로 원가를 못 읽었다)
  if (args.profile) { const mine = c.filter(x => !x.profile || x.profile === args.profile); if (mine.length) c = mine }
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
if (F.err) return { ok: false, quotes: [], cards: [], note: F.err + (F.why ? ': ' + F.why : '') }
const R = await radios()
if (!R || !R['무신사페이']) return { ok: false, quotes: [], cards: [], note: '무신사페이 라디오를 찾지 못함' }
await page.click(R['무신사페이'])
const tx = await settle(seg(F.f.tx))
// 무신사페이 칸: '무신사페이' 라벨 ~ '토스페이' 라벨 사이의 '<카드사>카드 (1234) 신용카드' 들
const sec = (seg(tx).split('무신사페이').slice(1).join('무신사페이').split('토스페이')[0]) || ''
if (!/결제수단 추가하기|\(\s*[\d*]{2,6}\s*\)/.test(sec)) return { ok: false, quotes: [], cards: [], note: '무신사페이 선택 확인 실패' }
const all = [...sec.matchAll(/([가-힣A-Za-z]{2,12}카드)\s*\(\s*[\d*]{2,6}\s*\)\s*(신용카드|체크카드)?/g)]
const cards = all.filter(m => !/무신사\s*삼성/.test(m[1])).map(m => (m[1] + ' ' + (m[2] || '')).trim())
// 금액은 맨 앞(기본) 카드로 읽힌다 — 그게 무신사 삼성카드거나 제휴카드 할인이 붙으면 등록 카드 견적이 아니다
if (!all.length || /무신사\s*삼성/.test(all[0][1]) || tx.indexOf('결제 금액 총 주문') < 0 || /제휴카드/.test(tx.slice(tx.indexOf('결제 금액 총 주문'))))
  return { ok: true, quotes: [], cards, note: 'no registered card(기본 카드가 무신사 삼성카드·제휴카드 할인, 또는 카드 없음)' }
const r = row(tx)
if (!r.cost) return { ok: false, quotes: [], cards, note: '총 결제금액 못 읽음' }
return { ok: true, quotes: [{ method: '무신사페이', card: cards[0], ...r, registered: true, allowed: true, available: true }], cards }
