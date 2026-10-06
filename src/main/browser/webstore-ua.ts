// 크롬 웹스토어에만 크롬처럼 보이는 UA 를 보낸다.
//
// 왜 필요한가
// Electron 기본 UA 에는 `samba-browser/1.0.0 … Electron/39.0.0` 제품 토큰이 섞여 있고,
// 웹스토어는 이런 UA 를 보면 "이 브라우저는 지원되지 않습니다" 배너를 띄우거나
// "Chrome에 추가" 버튼 자리를 다른 안내로 바꿔 버린다. 그러면 설치 버튼 자체가 없어진다.
//
// 범위는 웹스토어 호스트 요청으로 못 박는다 — 다른 사이트의 UA 는 건드리지 않는다.
// (모바일 모드의 UA 교체는 src/main/browser/emulation.ts 가 webContents 단위로 따로 한다)

import type { Session, WebContents } from 'electron'
import { WEBSTORE_HOST } from '../../shared/extensions'
import { isGoogleSigninUrl } from './google-signin-ua'

/** webRequest 필터 — 이 패턴에 걸리는 요청만 UA 를 갈아 끼운다 */
export const WEBSTORE_URL_PATTERNS = [`https://${WEBSTORE_HOST}/*`]

// 크롬 UA 의 `(KHTML, like Gecko)` 뒤에 올 수 있는 정상 제품 토큰.
// 여기 없는 `이름/버전` 토큰(앱 이름·Electron)은 걷어 낸다
const CHROME_TOKENS = /^(Chrome|Chromium|Safari|CriOS|Version|Edg|Mobile)\//i

/**
 * Electron 기본 UA 에서 앱·Electron 제품 토큰을 걷어 내 순수 크롬 UA 로 만든다.
 * 플랫폼 부분(`Mozilla/5.0 (…) AppleWebKit/537.36 (KHTML, like Gecko)`)은 그대로 둔다
 */
export function chromeUserAgent(ua: string): string {
  const marker = 'Gecko)'
  const at = ua.indexOf(marker)
  if (at < 0) return ua.trim()
  const head = ua.slice(0, at + marker.length)
  const tail = ua
    .slice(at + marker.length)
    .split(/\s+/)
    .filter(Boolean)
    // 슬래시가 없는 토큰(`Mobile` 등)은 버전 표기가 아니므로 그대로 둔다
    .filter((token) => !token.includes('/') || CHROME_TOKENS.test(token))
  return [head, ...tail].join(' ').trim()
}

/**
 * 세션에 웹스토어 전용 UA 교체를 건다.
 * onBeforeSendHeaders 는 세션당 리스너가 하나뿐이라 파티션마다 1회만 걸어야 한다
 * (호출부인 tab-manager 의 hardenSession 이 파티션 단위로 한 번만 부른다)
 */
export function installWebstoreUserAgent(ses: Session): void {
  const ua = chromeUserAgent(ses.getUserAgent())
  ses.webRequest.onBeforeSendHeaders({ urls: WEBSTORE_URL_PATTERNS }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'User-Agent': ua } })
  })
}

/** url 의 호스트가 웹스토어인가(파싱 실패는 아니라고 본다) */
export function isWebstoreUrl(url: string): boolean {
  try {
    return new URL(url).host === WEBSTORE_HOST
  } catch {
    return false
  }
}

/**
 * 요청 헤더의 UA 는 installWebstoreUserAgent 가 이미 세션 단위로 바꿔 주지만,
 * 웹스토어 페이지 JS 가 직접 읽는 `navigator.userAgent` 는 webContents 단위로 따로 설정해야
 * 같이 바뀐다. 그렇지 않으면 헤더와 `navigator.userAgent` 가 서로 달라져 "Chrome으로
 * 전환할까요?" 배너가 계속 뜬다.
 *
 * 탭이 웹스토어 호스트로 이동을 시작하면(메인 프레임만) 순수 크롬 UA 를 걸고,
 * 다른 호스트로 벗어나면 원래 UA(앱 기본값)로 되돌린다.
 *
 * 모바일 모드가 켜진 탭은 emulation.ts 가 UA(모바일 UA)를 따로 관리하므로 건드리지 않는다 —
 * isMobile() 이 true 를 돌려주는 동안은 아무 것도 하지 않는다
 *
 * 돌려주는 refresh() 는 항해 없이 UA 를 지금 주소에 맞춰 다시 건다.
 * 모바일 모드를 끄면 emulation.ts 가 UA 를 앱 기본값('')으로 되돌리는데,
 * 그때 탭이 이미 웹스토어에 머물러 있으면 다음 항해 전까지 크롬 UA 가 빠져 버린다 —
 * 모바일 해제 직후 이 함수를 불러 웹스토어 UA 를 되살린다
 */
export function installWebstoreNavigatorUserAgent(
  wc: WebContents,
  isMobile: () => boolean
): () => void {
  // 앱 기본 UA(모바일 모드가 아닐 때 되돌아갈 값). 이후 언제 호출해도 같은 값이 나오도록
  // getUserAgent() 를 매번 다시 읽지 않고 최초 값을 고정해 둔다
  const defaultUa = wc.getUserAgent()
  const webstoreUa = chromeUserAgent(defaultUa)
  const apply = (url: string): void => {
    if (isMobile()) return
    // 구글 로그인 주소의 UA 는 google-signin-ua 가 정한다 — 여기서 되돌리면 항해가 취소된다
    if (isGoogleSigninUrl(url)) return
    try {
      if (wc.isDestroyed()) return
      wc.setUserAgent(isWebstoreUrl(url) ? webstoreUa : defaultUa)
    } catch (e: unknown) {
      console.warn('웹스토어 UA 설정 실패', e instanceof Error ? e.message : String(e))
    }
  }
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame) return
    apply(details.url)
  })
  return () => {
    try {
      if (!wc.isDestroyed()) apply(wc.getURL())
    } catch (e: unknown) {
      console.warn('웹스토어 UA 복구 실패', e instanceof Error ? e.message : String(e))
    }
  }
}
