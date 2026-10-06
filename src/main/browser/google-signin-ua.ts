// 구글 로그인 화면에만 Electron 표기가 든 UA 를 쓴다.
//
// 왜 필요한가
// 앱은 모든 사이트에 순수 크롬 UA 를 보낸다(index.ts — GS샵 reCAPTCHA 대응). 그런데 구글 로그인은 UA 는 크롬인데
// 엔진 힌트·환경이 Electron 인 이 조합을 "안전하지 않은 브라우저" 로 보고 이메일 제출 직후 막는다
// (실기 2026-10-06: 순수 Electron 창에서 UA 를 걷어 내면 /signin/rejected, Electron 토큰을 두면 정상 진행).
// 범위는 구글 계정 호스트로 못 박는다 — 다른 사이트의 UA 는 건드리지 않는다.

import type { Session, WebContents } from 'electron'

/** 구글 로그인 화면이 열리는 호스트 */
const GOOGLE_SIGNIN_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com'])

/** url 이 구글 로그인 화면인가(파싱 실패는 아니라고 본다) */
export function isGoogleSigninUrl(url: string): boolean {
  try {
    return GOOGLE_SIGNIN_HOSTS.has(new URL(url).host)
  } catch {
    return false
  }
}

/** 순수 크롬 UA 에 Electron 제품 토큰을 다시 붙인다. 이미 있으면 그대로 */
export function electronUserAgent(chromeUa: string, electronVersion: string): string {
  if (/\bElectron\//.test(chromeUa)) return chromeUa
  return chromeUa.replace(/\s+Safari\//, ` Electron/${electronVersion} Safari/`)
}

/**
 * wc 가 구글 로그인 호스트로 이동하면(요청이 나가기 전: will-navigate·will-redirect) Electron 표기 UA 를 걸고,
 * 벗어나면 원래 UA 로 되돌린다. eager 면(구글 로그인 주소로 열린 팝업) 바로 건다.
 * 항해가 시작된 뒤(did-start-navigation) 에 UA 를 바꾸면 그 항해가 취소(ERR_ABORTED)되므로 쓰지 않는다.
 * 코드로 여는 첫 항해(loadURL)는 이 이벤트가 안 나므로 googleLoadOptions 로 따로 UA 를 준다.
 * 모바일 모드 탭은 emulation.ts 가 UA 를 따로 관리하므로 건드리지 않는다
 */
export function installGoogleSigninUserAgent(
  wc: WebContents,
  opts: { isMobile?: () => boolean; eager?: boolean } = {}
): void {
  const isMobile = opts.isMobile ?? (() => false)
  const defaultUa = wc.getUserAgent()
  const googleUa = electronUserAgent(defaultUa, process.versions.electron ?? '0.0.0')
  let applied = false
  const apply = (google: boolean): void => {
    if (isMobile() || google === applied) return
    applied = google
    try {
      if (!wc.isDestroyed()) wc.setUserAgent(google ? googleUa : defaultUa)
    } catch (e: unknown) {
      console.warn('구글 로그인 UA 설정 실패', e instanceof Error ? e.message : String(e))
    }
  }
  if (opts.eager === true) apply(true)
  wc.on('will-navigate', (event) => apply(isGoogleSigninUrl(event.url)))
  wc.on('will-redirect', (event) => apply(isGoogleSigninUrl(event.url)))
}

/** loadURL 에 줄 옵션 — 구글 로그인 주소면 Electron 표기 UA 를, 아니면 undefined */
export function googleLoadOptions(
  url: string,
  currentUa: string
): { userAgent: string } | undefined {
  return isGoogleSigninUrl(url)
    ? { userAgent: electronUserAgent(currentUa, process.versions.electron ?? '0.0.0') }
    : undefined
}

/** 구글 로그인 호스트 응답에만 걸 필터 — 패스키 차단 헤더 대상 */
export const GOOGLE_SIGNIN_URL_PATTERNS = [
  'https://accounts.google.com/*',
  'https://accounts.youtube.com/*'
]

/**
 * 구글 로그인 화면이 열릴 때마다 윈도우 '암호 키 선택' 창이 저절로 뜨는 것을 막는다.
 * 크롬은 패스키 자동 제안을 입력칸 아래 자동완성으로 조용히 보여 주지만 Electron 은 윈도우 보안 창을 띄운다.
 * 그 화면의 응답에 패스키 호출을 끄는 Permissions-Policy 를 얹는다 — 비밀번호 로그인은 그대로 된다.
 * onHeadersReceived 는 세션당 리스너가 하나뿐이므로 파티션마다 1회만 건다
 */
export function installGooglePasskeyBlock(ses: Session): void {
  ses.webRequest.onHeadersReceived({ urls: GOOGLE_SIGNIN_URL_PATTERNS }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Permissions-Policy': ['publickey-credentials-get=()']
      }
    })
  })
}
