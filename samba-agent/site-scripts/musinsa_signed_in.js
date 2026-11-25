// 무신사 로그인 여부 — 로그인 주소로 가 보아 로그인 화면이 그대로 남으면 비로그인, 다른 곳으로 튕기면 로그인(2026-11-22).
// 앱의 공통 판정은 홈 화면에서 '로그인됨' 표시를 못 읽어(블랙프라이데이 캠페인 화면 등) 로그인된 계정을 "fields not found" 로 막았다.
// 반환 {signed_in, note}
const opened = await tabs.open({ ...(args.profile ? { profile: args.profile } : {}), url: 'https://www.musinsa.com/auth/login?referer=https%3A%2F%2Fwww.musinsa.com%2F' })
const tabId = (String(opened).match(/tab (\S+)/) || [])[1] || null
let url = ''
for (let i = 0; i < 10; i++) {
  await sleep(1000)
  try { url = String(await page.url()) } catch (e) { url = '' }
  if (url && !/about:blank/.test(url) && i >= 4) break
}
const stayed = /\/(auth|member)\/login/.test(url)
if (tabId) { try { await tabs.close(tabId) } catch (e) {} }
return { signed_in: !!url && !stayed, note: stayed ? 'login page stayed' : (url ? null : 'no url') }
