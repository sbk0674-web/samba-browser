const num = s => Number(String(s || '').replace(/[^\d]/g, '') || 0)
const raw = String(args.sku || '').trim()
if (!raw) return { normal_price: null, note: 'sku 없음' }
const url = /^https?:/.test(raw) ? raw : 'https://www.lotteon.com/p/product/' + raw
const opened = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url })
const tabId = (String(opened).match(/tab (\S+)/) || [])[1] || null
let sale = 0, before = 0, head = ''
try {
  await page.waitFor(/판매가/, 10000).catch(() => {})
  for (let k = 0; k < 3 && !sale; k++) {
    try {
      try { await page.dismissOverlay() } catch (e) {}
      const tx = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
      const i = tx.indexOf('가격 정보')
      const seg = i >= 0 ? tx.slice(i, i + 300) : tx
      // 상품명 줄(가격 정보 바로 앞) — 상품명에 브랜드가 빠진 주문도 까대기 고정 브랜드(스케쳐스 등)를 알아보게 한다(2026-11-05)
      head = i >= 0 ? tx.slice(Math.max(0, i - 250), i) : ''
      sale = num((seg.match(/판매가\s*([\d,]+)\s*원/) || [])[1])
      before = num((seg.match(/할인전\s*가격\s*([\d,]+)/) || [])[1])
    } catch (e) {}
    if (!sale) await sleep(1500)
  }
} finally {
  if (tabId) { try { await tabs.close(tabId) } catch (e) {} }
}
const normal = before || sale
return { normal_price: normal || null, sale_price: sale || null, product_head: head || null, note: normal ? null : '가격 정보 못 읽음' }
