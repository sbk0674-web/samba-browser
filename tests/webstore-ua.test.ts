// 크롬 웹스토어 UA 순수 로직 — 헤더용 UA 변환 · 호스트 판별 · navigator.userAgent 동기화

import { describe, it, expect, vi } from 'vitest'
import {
  chromeUserAgent,
  headerUserAgentFor,
  installWebstoreNavigatorUserAgent,
  isWebstoreUrl
} from '../src/main/browser/webstore-ua'

const ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) samba-browser/1.0.0 Chrome/129.0.0.0 Electron/39.0.0 Safari/537.36'

describe('chromeUserAgent — 앱·Electron 토큰만 걷어 낸다', () => {
  it('samba-browser·Electron 토큰을 지우고 정상 크롬 토큰은 남긴다', () => {
    const ua = chromeUserAgent(ELECTRON_UA)
    expect(ua).not.toContain('samba-browser')
    expect(ua).not.toContain('Electron')
    expect(ua).toContain('Chrome/129.0.0.0')
    expect(ua).toContain('Safari/537.36')
  })

  it('Gecko) 표식이 없으면 원문을 그대로 돌려준다', () => {
    expect(chromeUserAgent('이상한 UA')).toBe('이상한 UA')
  })
})

describe('isWebstoreUrl — 호스트만 본다', () => {
  it('웹스토어 호스트면 true', () => {
    expect(isWebstoreUrl('https://chromewebstore.google.com/detail/abc')).toBe(true)
  })

  it('다른 호스트·잘못된 URL 은 false', () => {
    expect(isWebstoreUrl('https://example.com/chromewebstore.google.com')).toBe(false)
    expect(isWebstoreUrl('not a url')).toBe(false)
  })
})

// --- installWebstoreNavigatorUserAgent -------------------------------------------
// 실제 WebContents 대신 on/getUserAgent/setUserAgent 만 흉내 낸 가짜를 쓴다(순수 로직 검증)

interface FakeNavDetails {
  url: string
  isMainFrame: boolean
}

function makeFakeWc(defaultUa: string): {
  wc: object
  fireNavigation: (details: FakeNavDetails) => void
  uaHistory: string[]
} {
  const uaHistory: string[] = []
  let handler: ((details: FakeNavDetails) => void) | null = null
  // 지금 주소(refresh() 가 읽는 값). 항해가 일어나면 따라 바뀐다
  let currentUrl = 'about:blank'
  const wc = {
    getUserAgent: () => defaultUa,
    setUserAgent: (ua: string) => uaHistory.push(ua),
    getURL: () => currentUrl,
    isDestroyed: () => false,
    on: (event: string, listener: (details: FakeNavDetails) => void) => {
      if (event === 'did-start-navigation') handler = listener
    }
  }
  return {
    wc,
    fireNavigation: (details: FakeNavDetails) => {
      if (details.isMainFrame) currentUrl = details.url
      handler?.(details)
    },
    uaHistory
  }
}

describe('installWebstoreNavigatorUserAgent — 탭 이동에 맞춰 navigator UA 를 맞춘다', () => {
  it('웹스토어로 이동을 시작하면 순수 크롬 UA 로 바꾼다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    installWebstoreNavigatorUserAgent(wc as never, () => false)
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: true })
    expect(uaHistory).toHaveLength(1)
    expect(uaHistory[0]).not.toContain('Electron')
    expect(uaHistory[0]).toContain('Chrome/129.0.0.0')
  })

  it('다른 호스트로 벗어나면 원래 UA 로 되돌린다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    installWebstoreNavigatorUserAgent(wc as never, () => false)
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: true })
    fireNavigation({ url: 'https://example.com/', isMainFrame: true })
    expect(uaHistory).toEqual([expect.stringContaining('Chrome/129.0.0.0'), ELECTRON_UA])
  })

  it('서브프레임 이동은 무시한다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    installWebstoreNavigatorUserAgent(wc as never, () => false)
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: false })
    expect(uaHistory).toHaveLength(0)
  })

  it('모바일 모드가 켜진 탭은 건드리지 않는다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    const isMobile = vi.fn(() => true)
    installWebstoreNavigatorUserAgent(wc as never, isMobile)
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: true })
    expect(uaHistory).toHaveLength(0)
    expect(isMobile).toHaveBeenCalled()
  })
})

describe('refresh() — 모바일 모드를 껐을 때 웹스토어 UA 를 되살린다', () => {
  it('웹스토어에 머문 채 모바일을 끄면 크롬 UA 를 다시 건다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    let mobile = true
    const refresh = installWebstoreNavigatorUserAgent(wc as never, () => mobile)
    // 모바일 모드로 웹스토어에 들어가 있는 동안에는 UA 를 건드리지 않는다
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: true })
    expect(uaHistory).toHaveLength(0)
    // 모바일을 끄면 emulation 이 UA 를 비우므로, 지금 주소에 맞춰 다시 건다
    mobile = false
    refresh()
    expect(uaHistory).toEqual([expect.stringContaining('Chrome/129.0.0.0')])
  })

  it('웹스토어가 아닌 곳이면 앱 기본 UA 로 되돌린다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    let mobile = true
    const refresh = installWebstoreNavigatorUserAgent(wc as never, () => mobile)
    fireNavigation({ url: 'https://example.com/', isMainFrame: true })
    mobile = false
    refresh()
    expect(uaHistory).toEqual([ELECTRON_UA])
  })

  it('모바일 모드가 아직 켜져 있으면 아무 것도 하지 않는다', () => {
    const { wc, fireNavigation, uaHistory } = makeFakeWc(ELECTRON_UA)
    const refresh = installWebstoreNavigatorUserAgent(wc as never, () => true)
    fireNavigation({ url: 'https://chromewebstore.google.com/detail/abc', isMainFrame: true })
    refresh()
    expect(uaHistory).toHaveLength(0)
  })
})

describe('앱 기본 UA(userAgentFallback) — 모든 사이트에 순수 크롬 UA', () => {
  it('실기 Electron UA 에서 SAMBABrowser·Electron 토큰을 지우고 Chrome 버전은 남긴다', () => {
    const real =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SAMBABrowser/1.0.0 Chrome/142.0.7444.265 Electron/39.8.10 Safari/537.36'
    expect(chromeUserAgent(real)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.265 Safari/537.36'
    )
  })
})

describe('headerUserAgentFor — 요청 헤더에 실을 사이트별 UA', () => {
  const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.265 Safari/537.36'

  it('웹스토어는 순수 크롬 UA', () => {
    const ua = headerUserAgentFor(
      'https://chromewebstore.google.com/detail/abc',
      ELECTRON_UA,
      '39.8.10'
    )
    expect(ua).not.toContain('Electron')
    expect(ua).toContain('Chrome/129.0.0.0')
  })

  it('구글 로그인 호스트는 Electron 표기 UA', () => {
    expect(
      headerUserAgentFor('https://accounts.google.com/v3/signin/identifier', CHROME_UA, '39.8.10')
    ).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.265 Electron/39.8.10 Safari/537.36'
    )
  })

  it('그 밖의 호스트는 건드리지 않는다', () => {
    expect(headerUserAgentFor('https://www.google.com/', CHROME_UA, '39.8.10')).toBeUndefined()
    expect(headerUserAgentFor('https://artlist.io/', CHROME_UA, '39.8.10')).toBeUndefined()
  })
})
