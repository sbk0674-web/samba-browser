const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const no = String(args.source_order_no || '').trim()
const empty = note => ({ source_order_no: no || null, status: '', paid: 0, points_used: 0, reward: 0, card: '', note })
if (!no) return empty('source_order_no 없음')
const prof = args.profile ? { profile: args.profile } : {}
const open = async url => { const id = (String(await tabs.open({ ...prof, url })).match(/tab (\S+)/) || [])[1]; if (id) await tabs.switch(id); return id }
const lid = await open('https://www.29cm.co.kr/order/my-order/list')
await page.waitFor(/주문상세/, 10000).catch(() => {})
const day = (no.match(/(\d{8})/) || [])[1]
const readList = async () => {
  const lt = (await page.get({})).tree
  const dl = String((await page.get({ query: '주문상세' })).tree || lt)
  const ids = [...new Set([...dl.matchAll(/\] link "주문상세" href=\S*\/detail\/(\d+)/g)].map(m => m[1]))]
  const dates = [...text(lt).matchAll(/(\d{4})\. (\d{1,2})\. (\d{1,2}) 주문상세/g)].map(m => m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0'))
  return ids.filter((id, i) => !day || dates.length !== ids.length || dates[i] === day).slice(0, 20)
}
let d = '', did = null
const seen = new Set()
const scan = async cand => {
  for (const id of cand) {
    if (seen.has(id)) continue
    seen.add(id)
    did = await open('https://www.29cm.co.kr/order/my-order/detail/' + id)
    await page.waitFor(/결제금액/, 8000).catch(() => {})
    const tx = text((await page.get({})).tree)
    if ((tx.match(/주문번호 (\S+)/) || [])[1] === no) { d = tx; return true }
    await tabs.close(did).catch(() => {}); did = null
  }
  return false
}
const first = await readList()
if (!first.length) { await tabs.close(lid).catch(() => {}); return empty('로그인 안 됨') }
let found = await scan(first)
if (!found && day) {
  try {
    await tabs.switch(lid)
    const date = day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6)
    const clickButton = async (label, optional) => {
      const tree = (await page.get({})).tree
      const line = tree.split('\n').find(x => /^\[\d+\] button /.test(x) && (label instanceof RegExp ? label.test(x.replace(/^\[\d+\] button "/, '').replace(/"$/, '')) : x.includes('"' + label + '"')))
      if (!line) { if (optional) return false; throw new Error('조회 요소 없음: ' + label) }
      await page.click(parseInt(line.slice(1))); return true
    }
    await clickButton(/^최근 \d+(개월|년)$/)
    await clickButton('기간 선택')
    const fields = (await page.get({})).tree
    for (const label of ['시작일', '종료일']) {
      const line = fields.split('\n').find(x => /^\[\d+\] textbox /.test(x) && x.includes('"' + label + '"'))
      if (!line) throw new Error('날짜 요소 없음: ' + label)
      await page.type(parseInt(line.slice(1)), date)
    }
    await clickButton('조회하기')
    await sleep(1000)
    found = await scan(await readList())
  } catch (e) {
    await tabs.close(lid).catch(() => {})
    return empty('주문일 조회 실패: ' + String(e.message || e))
  }
}
await tabs.close(lid).catch(() => {})
if (!d) return empty('주문번호 ' + no + ' 를 목록(' + seen.size + '건 확인)에서 못 찾음')
const pay = d.slice(d.indexOf('결제정보'), d.indexOf('배송지정보') > 0 ? d.indexOf('배송지정보') : undefined)
const paid = num((pay.match(/결제금액 ([\d,]+)원/) || [])[1])
const method = (pay.match(/결제금액 [\d,]+원 (\S+(?: \S+)?) [\d,]+원/) || [])[1] || ''
const box = pay.match(/보유 적립금(?: 사용)? ([\d,]+)원/)
const points_used = box ? num(box[1]) : num((pay.match(/(?:적립금|포인트) 사용 ([\d,]+)원/) || [])[1])
const reward = num((d.match(/구매\s?확정 \(([\d,]+)원\)/) || [])[1])
const status = (d.match(/장바구니 담기 (\S+)/) || [])[1] || ''
const ir = d.includes('장바구니 담기') ? d.split('장바구니 담기')[1].split('구매자정보')[0] : d
const item = ir.match(/\[[^\]]*\]\s*(.*?)\s+[\d,]+원\s*\/\s*수량\s*(\d+)개/)
const selected = item && item[1].trim() ? item[1].trim() : null, qty = item ? +item[2] : null
const shipping_text = d.includes('배송지정보') ? d.split('배송지정보')[1].split(/결제정보|유의사항/)[0].trim() : null
let shipping = null, rawName = null, rawAd = null
if (shipping_text) {
  const nm = (shipping_text.match(/(?:받는\s?사람|수령인|수취인|받으실 분) (.*?)(?= 전화번호| 휴대폰| 주소|$)/) || [])[1]
  const ad = (shipping_text.match(/주소 (.*?)(?: 배송요청사항| 주문내역서| 영수증|$)/) || [])[1]
  rawName = nm && nm.trim() ? nm.trim() : null; rawAd = ad ? ad.trim() : null
  let addr = null, det = null
  if (ad) {
    const m = ad.match(/^(.*?(?:로|길)\s?\d+(?:-\d+)?)(?:\s+(.*))?$/)
    addr = m ? m[1].trim() : ad.trim(); det = m && m[2] ? m[2].trim() : null
  }
  const ok = v => v && !/\*/.test(v) ? v : null
  shipping = { name: rawName, address: ok(addr), address_detail: ok(det) }
}
let issuer = ([...pay.matchAll(/(무신사 )?([가-힣]{2,5}카드)(?!\s*할인)/g)].find(m => !m[1] && m[2] !== '제휴카드') || [])[2] || ''
if (!issuer && !/머니|페이코/.test(method)) {
  const rb = ((await page.get({ query: '영수증' })).tree.match(/\[(\d+)\] button "영수증[^"]*"/) || [])[1]
  if (rb) {
    const before = new Set((await tabs.list()).map(x => x.id))
    await page.click(+rb)
    let pop = null
    for (let i = 0; i < 20 && !pop; i++) { await sleep(250); pop = (await tabs.list()).find(x => !before.has(x.id)) }
    if (pop) {
      await tabs.switch(pop.id)
      await page.waitFor(/카드/, 6000).catch(() => {})
      const pt = text((await page.get({})).tree)
      issuer = (pt.match(/카드\s?종류\s*([가-힣A-Za-z]{2,8}카드)/) || pt.match(/([가-힣]{2,5}카드)/) || [])[1] || ''
      await tabs.close(pop.id).catch(() => {})
    }
  }
}
// 받는사람이 '임*희' 처럼 마스킹되면, 배송지 변경 창(열기만 함, 선택·수정 안 함)의 주소록에서 같은 주소·같은 마스킹 패턴의 실명을 읽는다
if (shipping && rawName && /\*/.test(rawName) && did) {
  try {
    await tabs.switch(did)
    const bl = (await page.get({ interactive: true })).tree.split('\n').find(x => /^\[\d+\] button "배송지 정보\s?변경"/.test(x))
    if (bl) {
      await page.click(parseInt(bl.slice(1)))
      await page.waitFor('배송지 추가', 6000).catch(() => {})
      const full = text((await page.get({})).tree)
      const modal = full.includes('배송지 추가') ? full.slice(full.lastIndexOf('배송지 변경 배송지 추가')) : ''
      const pat = new RegExp('^' + rawName.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[가-힣A-Za-z*]') + '$')
      const norm = s => String(s || '').replace(/\s+/g, '')
      const cands = [...modal.matchAll(/([가-힣A-Za-z*]{2,6})(?: \/ ([가-힣A-Za-z*]{2,6}))? \((\d{5})\) (.*?) 010-/g)]
        .map(m => ({ n: m[1], n2: m[2], a: m[4] }))
        .filter(c => (pat.test(c.n) || (c.n2 && pat.test(c.n2))) && rawAd && norm(c.a).includes(norm(rawAd)))
      const real = cands.map(c => [c.n, c.n2].find(v => v && !/\*/.test(v) && pat.test(v))).find(Boolean)
      if (real) shipping.name = real
    }
  } catch (e) {}
}
if (did) await tabs.close(did).catch(() => {})
return {
  source_order_no: no, status, selected, qty, shipping, shipping_text, paid, points_used, ...(box ? { points_box: num(box[1]) } : {}), reward,
  card: [method, issuer].filter(Boolean).join(' - '), note: paid ? null : '값 못 읽음'
}