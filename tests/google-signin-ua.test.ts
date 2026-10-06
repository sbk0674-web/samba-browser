import { describe, expect, it } from 'vitest'
import { electronUserAgent, isGoogleSigninUrl } from '../src/main/browser/google-signin-ua'

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.265 Safari/537.36'

describe('구글 로그인 UA', () => {
  it('구글 계정 호스트만 구글 로그인으로 본다', () => {
    expect(isGoogleSigninUrl('https://accounts.google.com/v3/signin/identifier')).toBe(true)
    expect(isGoogleSigninUrl('https://accounts.youtube.com/accounts/CheckConnection')).toBe(true)
    expect(isGoogleSigninUrl('https://www.google.com/search?q=a')).toBe(false)
    expect(isGoogleSigninUrl('https://artlist.io/')).toBe(false)
    expect(isGoogleSigninUrl('not a url')).toBe(false)
  })

  it('크롬 UA 에 Electron 토큰을 Safari 앞에 붙인다', () => {
    const ua = electronUserAgent(CHROME_UA, '39.8.10')
    expect(ua).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.265 Electron/39.8.10 Safari/537.36'
    )
  })

  it('이미 Electron 토큰이 있으면 그대로 둔다', () => {
    const withToken = electronUserAgent(CHROME_UA, '39.8.10')
    expect(electronUserAgent(withToken, '39.8.10')).toBe(withToken)
  })
})
