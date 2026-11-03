// 29CM 같은 상품 찾기 — args.model 있으면 원본 페이지를 열지 않고 바로 29CM 검색. 없으면 source_url 에서 품번을 읽는다.
const lines = t => t.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d/.test(l))
const nameOf = l => (l.match(/^\[\d+\] \w+ "([^"]*)"/) || [])[1]
const N = s => String(s || '').toLowerCase().replace(/[\s\-_/:().,[\]·']/g, '')
const open = async url => { const id = (String(await tabs.open({ url })).match(/tab (\S+)/) || [])[1]; if (id) await tabs.switch(id); return id }
const src = String(args.source_url || '').trim()
const none = (note, model) => ({ found: false, product_url: '', name: '', model: model || '', note })
let model = String(args.model || '').trim()
let title = String(args.name || '').replace(/\[[^\]]*\]\s*$/, '').trim()
if (!model && /^https?:/.test(src)) {
  let tid = null, t = ''
  try {
    tid = await open(src)
    await page.waitFor(/품번|모델|구매하기/, 10000).catch(() => {})
    for (let i = 0; i < 6; i++) { t = (await page.get({})).tree; if (/품번|모델번호|스타일\s*넘버/.test(t)) break; await sleep(300) }
  } catch (e) {}
  if (tid) await tabs.close(tid).catch(() => {})
  title = ((t.match(/TITLE:\s*(.*)/) || [])[1] || '').replace(/\s*[-|]\s*사이즈.*$|\s*\|.*$/, '').trim() || title
  const tx = (t.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
  model = ((tx.match(/(?:품번|모델번호|스타일\s*넘버|제품번호)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_]{3,})/) || title.match(/\/\s*([A-Za-z0-9]+[-_][A-Za-z0-9\-_]+)\s*$/) || [])[1] || '').trim()
}
if (!model && !title) return none('source_url·model 없음')
const brand = (title.match(/^([^\s(]+)/) || [])[1] || ''
const core = title.replace(/^[^\s(]+(\([^)]*\))?\s*/, '').split(/\s[-/]\s/)[0].trim()
const tid2 = await open('https://www.29cm.co.kr/store/search?keyword=' + encodeURIComponent(model || (brand + ' ' + core).trim()))
await page.waitFor(/catalog\/\d+|검색 결과가 없/, 8000).catch(() => {})
await sleep(1500)
let hits = []
try {
  hits = lines((await page.get({ selector: 'a[href*="catalog/"]' })).tree)
    .map(l => ({ n: nameOf(l), no: (l.match(/catalog\/(\d+)/) || [])[1] })).filter(h => h.no && h.n && !/^[\d,]+$/.test(h.n) && !/무료배송|도착/.test(h.n))
} catch (e) {}
await tabs.close(tid2).catch(() => {})
let hit = null
if (model && N(model).length >= 5) hit = hits.find(h => N(h.n).includes(N(model)))
else {
  const nos = [...new Set(hits.map(h => h.no))]
  if (nos.length === 1 && N(core).length >= 4 && N(hits[0].n).includes(N(core))) hit = hits[0]
}
if (!hit) return none(model ? '품번 ' + model + ' 이 든 29CM 상품 없음(검색 ' + hits.length + '건)' : '품번 없음 — 이름만으로 하나로 못 정함', model)
return { found: true, product_url: 'https://www.29cm.co.kr/products/' + hit.no, name: hit.n, model, note: null }
