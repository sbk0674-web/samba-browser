const text = t => (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const num = s => s ? parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0 : 0
const no = String(args.source_order_no || '').trim()
const empty = note => ({ source_order_no: no || null, status: '', paid: 0, points_used: 0, reward: 0, card: '', note })
if (!no) return empty('source_order_no 없음')
const prof = args.profile ? { profile: args.profile } : {}
const open = async url => { const id = (String(await tabs.open({ ...prof, url })).match(/tab (\S+)/) || [])[1]; if (id) await tabs.switch(id); return id }
const lid = await open('https://www.29cm.co.kr/order/my-order/list')
await page.waitFor(/주문상세/, 10000).catch(() => {})
const lt = (await page.get({})).tree
const ids = [...new Set([...lt.matchAll(/\] link "주문상세" href=\S*\/detail\/(\d+)/g)].map(m => m[1]))]
if (!ids.length) { await tabs.close(lid).catch(() => {}); return empty('로그인 안 됨') }
const dates = [...text(lt).matchAll(/(\d{4})\. (\d{1,2})\. (\d{1,2}) 주문상세/g)].map(m => m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0'))
await tabs.close(lid).catch(() => {})
const day = (no.match(/(\d{8})/) || [])[1]
const cand = ids.filter((id, i) => !day || dates.length !== ids.length || dates[i] === day).slice(0, 10)
let d = '', did = null
for (const id of cand) {
  did = await open('https://www.29cm.co.kr/order/my-order/detail/' + id)
  await page.waitFor(/결제금액/, 8000).catch(() => {})
  const tx = text((await page.get({})).tree)
  if ((tx.match(/주문번호 (\S+)/) || [])[1] === no) { d = tx; break }
  await tabs.close(did).catch(() => {}); did = null
}
if (!d) return empty('주문번호 ' + no + ' 를 목록(' + cand.length + '건 확인)에서 못 찾음')
const pay = d.slice(d.indexOf('결제정보'), d.indexOf('배송지정보') > 0 ? d.indexOf('배송지정보') : undefined)
const paid = num((pay.match(/결제금액 ([\d,]+)원/) || [])[1])
const method = (pay.match(/결제금액 [\d,]+원 (\S+(?: \S+)?) [\d,]+원/) || [])[1] || ''
const box = pay.match(/보유 적립금 사용 ([\d,]+)원/)
const points_used = num((pay.match(/적립금 사용 ([\d,]+)원/) || [])[1])
const reward = num((d.match(/구매\s?확정 \(([\d,]+)원\)/) || [])[1])
const status = (d.match(/장바구니 담기 (\S+)/) || [])[1] || ''
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
if (did) await tabs.close(did).catch(() => {})
return {
  source_order_no: no, status, paid, points_used, ...(box ? { points_box: num(box[1]) } : {}), reward,
  card: [method, issuer].filter(Boolean).join(' - '), note: paid ? null : '값 못 읽음'
}