const OF = /fashionplus\.co\.kr\/order\/\d+(?:[?#]|$)/
const lines = async q => (await page.get(q ? { selector: q } : {})).tree.split('PAGE TEXT')[0].split('\n').filter(l => /^\[\d+\]/.test(l))
const text = async () => ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\s+/g, ' ')
const fail = (note, x) => ({ ok: false, note, ...(x || {}) })
const sq = s => String(s || '').replace(/\s+/g, '')
const name = String(args.name || '').trim(), addr = String(args.address || '').trim()
const cand = (await tabs.list()).filter(t => OF.test(t.url || '') && (!args.tab || t.id === args.tab))
if (cand.length !== 1) return fail(cand.length ? `order form ambiguous: ${cand.length} tabs` : 'no order tab')
const tab = cand[0].id
await tabs.switch(tab)
const big = async () => (await lines()).filter(l => /^\[\d{6,}\]/.test(l))
const fr = await big()
const k = fr.findIndex(l => /link "우편번호 찾기"/.test(l))
if (k < 0) return fail('새 주소 입력 폼이 열려 있지 않다', { order_tab: tab })
const valOf = l => ((l || '').match(/value="([^"]*)"/) || [])[1] || ''
// 줄 순서가 DOM 순서와 다를 수 있다 — 값 모양으로 칸을 구분한다
const tbs = fr.filter(l => /textbox/.test(l))
const nameL = tbs.find(l => valOf(l) === name)
const zipL = tbs.find(l => /^\d{5}$/.test(valOf(l)))
const phoneL = tbs.find(l => /^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(valOf(l)))
const roadL = tbs.find(l => /\S+\s+\S+/.test(valOf(l)) && !/^\d{5}$/.test(valOf(l)) && valOf(l) !== name && /(로|길|동|읍|면|리)/.test(valOf(l)))
if (!nameL) return fail('폼 이름이 다르다', { order_tab: tab })
if (!valOf(zipL) || !valOf(roadL)) return fail('폼 주소가 비었다', { order_tab: tab })
if (!phoneL) return fail('전화 칸이 비었다', { order_tab: tab })
const def = fr.findIndex(l => /clickable "기본 배송지로 설정"/.test(l))
if (def > 0 && /value="on"/.test(fr[def - 1])) { await page.click(parseInt(fr[def].slice(1))); await sleep(300) }
const reg = fr.find(l => /button "등록하기"/.test(l))
if (!reg) return fail('등록하기 버튼 없음', { order_tab: tab })
await page.click(parseInt(reg.slice(1)))
for (let i = 0; i < 20; i++) {
  await sleep(400)
  const ok = (await lines()).find(l => /button "확인"$/.test(l) && !/^\[\d{6,}\]/.test(l))
  if (ok) { try { await page.click(parseInt(ok.slice(1))) } catch (e) {} }
  if (!(await big()).some(l => /button "등록하기"/.test(l))) break
}
const t = await text()
const m = t.match(/배송지 정보 (\S+?)배송지 변경 (\d{5}) (.+?) (?:0\d{1,2}-?\d{3,4}-?\d{4}|배송메모)/)
if (!m) return fail('주문서 배송지 되읽기 실패', { order_tab: tab })
const nums = addr.replace(/^\d{5}\s*/, '').match(/\d+(-\d+)?/g) || []
const same = m[1] === name && nums.every(n => sq(m[3]).includes(n))
return { ok: same, name: m[1], zip: m[2], address: m[3], order_tab: tab, note: same ? null : '등록 뒤 주문서 배송지가 넣은 값과 다르다' }