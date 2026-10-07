// SSG 로그인 확인(2026-09-29): 결제 전에 세션이 살아 있는지 본다 — 로그인이 풀린 채 결제 비밀번호까지 넣으면
// orderProcess 가 로그인 화면으로 튕기고 주문이 안 생긴다(실기). MY SSG 주문조회를 새 탭으로 열어 '주문배송 조회'가 보이면 로그인.
// 확인 뒤 그 탭을 닫고 원래 탭으로 돌아간다. 인자 {profile?, back_tab?}  반환 {logged_in, note}
const back = args.back_tab ? String(args.back_tab) : null
await tabs.open({ url: 'https://pay.ssg.com/myssg/orderInfo.ssg?viewType=Ssg', ...(args.profile ? { profile: args.profile } : {}) })
try { await page.waitFor(/주문배송 조회|로그인/, 12000) } catch (e) {}
await sleep(800)
const url = String(await page.url())
const g = await page.get({})
const t = String(g.tree || '').split('PAGE TEXT')[1] || ''
const logged = !/member\.ssg\.com\/member\/login/.test(url) && /주문배송 조회/.test(t)
const me = (await tabs.list()).find(x => /myssg\/orderInfo|member\/login/.test(x.url || ''))
if (me) { try { await tabs.close(me.id) } catch (e) {} }
if (back) { try { await tabs.switch(back) } catch (e) {} }
return { logged_in: logged, note: logged ? 'ok' : 'SSG 로그인 필요' }
