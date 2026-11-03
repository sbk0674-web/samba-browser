// 세션 쿠키 유지 — 앱을 닫아도 로그인이 살아 있게 한다.
//
// 만료가 없는 쿠키(세션 쿠키)는 크로미움이 브라우저를 닫을 때 버린다. 무신사의 로그인 토큰
// (app_atk·app_rtk)이 이 종류라, 앱을 다시 켤 때마다 프로필 탭이 "상단은 로그아웃(=로그인),
// 구매 버튼은 회원 전용" 인 반쪽 상태로 시작했다(실기). 헤더용 쿠키는 만료가 있어 남고
// 토큰만 사라져서다. 크롬의 "이전 세션 이어서" 와 같은 동작을 파티션에 준다:
// 세션 쿠키가 생기면 같은 값에 만료만 얹어 다시 저장한다.
//
// 값은 읽어 그대로 되쓰기만 한다 — 로그·IPC·렌더러 어디에도 나가지 않는다.
//
// host-only 쿠키(도메인 속성 없이 받은 쿠키)는 domain 을 넘기지 않고 되써야 한다. domain 을 넘기면
// 크로미움이 '.호스트' 도메인 쿠키를 **따로** 만들어 같은 이름이 두 벌이 된다. 사이트가 1회용 토큰
// 쿠키를 지워도 복제본이 남아 옛 토큰을 계속 보내고, 슈마커는 그 요청마다 history.back() 을 돌려줘
// 검색·클릭·구매하기가 전부 이전 페이지로 튕겼다(실기 2026-09-26, 웨일에는 복제본 없음).

import type { Cookie, CookiesSetDetails, Session } from 'electron'

/** 세션 쿠키에 얹는 수명. 사이트가 서버에서 만료시키면 그쪽이 우선한다 */
export const SESSION_COOKIE_KEEP_DAYS = 14

/** 이 모듈이 세션에서 쓰는 부분만(테스트에서 대역으로 갈아 끼운다) */
export interface CookieJarLike {
  on(
    event: 'changed',
    listener: (event: unknown, cookie: Cookie, cause: string, removed: boolean) => void
  ): unknown
  set(details: CookiesSetDetails): Promise<void>
}

const SESSION_KEEP_EXCLUDED_DOMAINS = [
  'google.com',
  'youtube.com',
  'youtube.co.kr',
  'ytimg.com',
  'googleusercontent.com'
]

function cookieHost(cookie: Pick<Cookie, 'domain'>): string {
  return (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
}

export function shouldKeepSessionCookie(cookie: Pick<Cookie, 'domain'>): boolean {
  const host = cookieHost(cookie)
  if (!host) return false
  return !SESSION_KEEP_EXCLUDED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
}

/** 쿠키가 온 도메인·경로로 되돌아갈 URL(set 은 url 을 요구한다) */
export function cookieUrl(cookie: Pick<Cookie, 'domain' | 'path' | 'secure'>): string {
  const host = (cookie.domain ?? '').replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
}

/** 세션 쿠키 → 만료를 얹은 저장 요청(순수 함수). 세션 쿠키가 아니면 null */
export function persistedCookie(
  cookie: Cookie,
  now: number = Date.now(),
  keepDays: number = SESSION_COOKIE_KEEP_DAYS
): CookiesSetDetails | null {
  if (!cookie.session) return null
  if (!cookie.domain) return null
  if (!shouldKeepSessionCookie(cookie)) return null
  // host-only 세션 쿠키는 건드리지 않는다. 같은 쿠키를 덮어쓰면 사이트가 곧바로 바꾼 새 값을 비동기 되쓰기가
  // 옛 값으로 되돌린다 — 무신사머니 결제창이 "로그인 세션을 찾을 수 없습니다"로 튕겼다(실기 2026-09-26).
  // 로그인 유지가 필요한 토큰(무신사 app_atk 등)은 도메인 쿠키라 그대로 남긴다
  if (cookie.hostOnly) return null
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? '/',
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    expirationDate: Math.floor(now / 1000) + keepDays * 24 * 60 * 60
  }
}

/**
 * 파티션의 세션 쿠키를 만료 있는 쿠키로 바꿔 저장한다.
 * 다시 저장한 쿠키는 세션 쿠키가 아니므로 'changed' 가 다시 와도 건너뛴다(무한 반복 없음)
 */
export function keepSessionCookies(
  cookies: CookieJarLike,
  deps: { now?: () => number; keepDays?: number; onError?: (name: string) => void } = {}
): void {
  cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed) return
    const details = persistedCookie(cookie, (deps.now ?? Date.now)(), deps.keepDays)
    if (!details) return
    void cookies.set(details).catch(() => deps.onError?.(cookie.name))
  })
}

/** 복제본 정리에 쓰는 쿠키 저장소 부분(테스트 대역용) */
export interface CookieStoreLike {
  get(filter: Record<string, never>): Promise<Cookie[]>
  set(details: CookiesSetDetails): Promise<void>
  remove(url: string, name: string): Promise<void>
}

// 두 단계 공개 접미사(이 아래 한 단계가 등록 도메인이다). 쓰는 사이트 기준으로만 둔다
const TWO_LEVEL_SUFFIXES = new Set(['co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr', 'pe.kr', 'com.cn', 'co.jp', 'com.tw', 'com.au', 'co.uk'])

/** 등록 도메인(예: api.musinsapayments.com → musinsapayments.com, www.shoemarker.co.kr → shoemarker.co.kr) */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const lastTwo = parts.slice(-2).join('.')
  return parts.slice(TWO_LEVEL_SUFFIXES.has(lastTwo) ? -3 : -2).join('.')
}

/**
 * 예전 코드가 만든 '.하위호스트' 복제본인가(순수 함수). 도메인 쿠키인데 그 도메인이 등록 도메인이 아닌
 * 하위 주소(api.·www.·fin-auth.…)면 복제본으로 본다 — 사이트가 Domain=api.example.com 처럼 하위 주소를
 * 도메인으로 주는 일은 사실상 없다. 등록 도메인(.naver.com·.musinsa.com)은 사이트가 준 진짜 로그인 쿠키라 건드리지 않는다.
 *
 * 실기 2026-09-26: '.api.musinsapayments.com' JSESSIONID 복제본(옛 값)이 새 세션 쿠키와 함께 가서
 * 무신사머니 결제창이 "로그인 세션을 찾을 수 없습니다"로 튕겼다. 슈마커 '.www.' 복제본과 같은 원인
 */
export function isStaleHostCopy(c: Cookie): boolean {
  if (c.hostOnly || c.session || !c.domain?.startsWith('.')) return false
  const host = c.domain.slice(1)
  return registrableDomain(host) !== host.toLowerCase()
}

/** 쿠키를 원래 모양대로 다시 쓰는 요청(host-only 는 domain 없이, 세션 쿠키는 만료 없이) */
function restoreDetails(c: Cookie): CookiesSetDetails {
  return {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path ?? '/',
    ...(c.hostOnly ? {} : { domain: c.domain }),
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    ...(c.session || c.expirationDate === undefined ? {} : { expirationDate: c.expirationDate })
  }
}

/** 그 주소·이름으로 remove 하면 같이 지워지는 쿠키인가(도메인·경로가 그 주소에 붙는 것) */
function sentTo(c: Cookie, host: string, path: string, name: string): boolean {
  if (c.name !== name || !c.domain) return false
  const d = c.domain.toLowerCase()
  const domainOk = c.hostOnly ? d === host : host === d.replace(/^\./, '') || host.endsWith(d.startsWith('.') ? d : `.${d}`)
  const p = c.path ?? '/'
  return domainOk && (path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`))
}

/**
 * 예전 코드가 만든 하위 주소 복제본을 지운다(원본·다른 쿠키는 그대로).
 * remove(url, name) 은 그 주소에 붙는 같은 이름 쿠키를 모두 지우므로, 복제본이 아닌 것은 원래 모양대로 다시 쓴다
 */
export async function removeStaleHostCopies(store: CookieStoreLike): Promise<number> {
  const all = await store.get({})
  let removed = 0
  for (const c of all) {
    if (!isStaleHostCopy(c)) continue
    const host = (c.domain ?? '').slice(1).toLowerCase()
    const path = c.path ?? '/'
    const keep = all.filter((o) => o !== c && sentTo(o, host, path, c.name) && !isStaleHostCopy(o))
    await store.remove(cookieUrl(c), c.name)
    for (const o of keep) await store.set(restoreDetails(o))
    removed++
  }
  return removed
}

/** 앱의 파티션 세션에 붙인다 */
export function installSessionCookieKeeper(ses: Session): void {
  // 예전 코드가 남긴 복제본부터 정리(실패해도 앱은 계속 — 이름·값은 남기지 않는다)
  void removeStaleHostCopies(ses.cookies as unknown as CookieStoreLike)
    .then((n) => {
      if (n) console.log(`세션 쿠키 복제본 ${n}개 정리`)
    })
    .catch((e: unknown) => console.warn('세션 쿠키 복제본 정리 실패', e instanceof Error ? e.message : String(e)))
  keepSessionCookies(ses.cookies, {
    // 값은 남기지 않는다 — 어느 쿠키인지 이름만
    onError: (name) => console.warn(`세션 쿠키 유지 실패: ${name}`)
  })
  installGoogleLogoutCleanup(ses)
}

// === 구글 로그아웃 쿠키 ======================================================
// 구글 로그아웃은 SID·HSID·SAPISID 등을 만료시키는 쿠키를 보낸다. 그런데 유튜브 쪽 삭제(accounts.youtube.com 의
// ClearSID 프레임, .youtube.com 도메인)는 SameSite 를 적지 않은 쿠키라 교차 사이트 응답으로 보고 크로미움이 막는다
// (SameSiteUnspecifiedTreatedAsLax). 그래서 유튜브 로그인 쿠키가 남아 로그아웃이 안 된 것처럼 보인다(실기 2026-10-13).
// 로그아웃·ClearSID 응답이 끝나면 구글 로그인 쿠키를 앱이 직접 지운다

/** 구글 로그아웃·유튜브 로그아웃 프레임 주소 — 이 응답이 끝나면 로그인 쿠키를 지운다 */
export const GOOGLE_LOGOUT_URL_PATTERNS = [
  'https://accounts.google.com/Logout*',
  'https://accounts.youtube.com/accounts/ClearSID*'
]

/** 로그아웃 때 지울 구글·유튜브 로그인 쿠키 이름 */
export const GOOGLE_LOGIN_COOKIE_NAMES = [
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-1PAPISID',
  '__Secure-1PSIDTS',
  '__Secure-3PSID',
  '__Secure-3PAPISID',
  '__Secure-3PSIDTS',
  'LSID',
  '__Host-1PLSID',
  '__Host-3PLSID',
  'LOGIN_INFO'
]

// 구글은 나라별 도메인(google.co.kr 등)에도 같은 로그인 쿠키를 둔다 — 실기 2026-10-13: .google.co.kr 의 SID·HSID 가 남았다
const GOOGLE_LOGIN_DOMAIN_RE = /(^|\.)(google\.(com|[a-z]{2}(\.[a-z]{2})?)|youtube\.com)$/

export function isGoogleLogoutUrl(url: string): boolean {
  return /^https:\/\/accounts\.google\.com\/Logout(\?|$)/.test(url) || /^https:\/\/accounts\.youtube\.com\/accounts\/ClearSID(\?|$)/.test(url)
}

/** 구글·유튜브 도메인의 로그인 쿠키인가(하위 도메인 포함) */
export function isGoogleLoginCookie(c: Pick<Cookie, 'name' | 'domain'>): boolean {
  if (!GOOGLE_LOGIN_COOKIE_NAMES.includes(c.name)) return false
  const host = (c.domain ?? '').replace(/^\./, '').toLowerCase()
  return GOOGLE_LOGIN_DOMAIN_RE.test(host)
}

/** 구글·유튜브 로그인 쿠키를 지운다. 지운 개수를 돌려준다 */
export async function clearGoogleLoginCookies(store: CookieStoreLike): Promise<number> {
  const all = await store.get({})
  let removed = 0
  for (const c of all) {
    if (!isGoogleLoginCookie(c)) continue
    await store.remove(cookieUrl(c), c.name)
    removed++
  }
  return removed
}

/** 로그아웃 응답이 끝나면 구글 로그인 쿠키를 지우도록 파티션 세션에 건다 */
export function installGoogleLogoutCleanup(ses: Session): void {
  ses.webRequest.onCompleted({ urls: GOOGLE_LOGOUT_URL_PATTERNS }, (details) => {
    if (!isGoogleLogoutUrl(details.url)) return
    void clearGoogleLoginCookies(ses.cookies as unknown as CookieStoreLike).catch((e: unknown) =>
      console.warn('구글 로그인 쿠키 정리 실패', e instanceof Error ? e.message : String(e))
    )
  })
}
