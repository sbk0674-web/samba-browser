// 세션 쿠키 유지 — 만료 없는 쿠키만 만료를 얹어 되쓰고, 되쓴 쿠키로 반복하지 않는다

import { describe, it, expect, vi } from 'vitest'
import type { Cookie, CookiesSetDetails } from 'electron'
import {
  cookieUrl,
  isStaleHostCopy,
  registrableDomain,
  removeStaleHostCopies,
  keepSessionCookies,
  persistedCookie,
  shouldKeepSessionCookie,
  SESSION_COOKIE_KEEP_DAYS
} from '../src/main/browser/session-cookies'

function cookie(over: Partial<Cookie> = {}): Cookie {
  return {
    name: 'app_atk',
    value: 'opaque-token',
    domain: '.musinsa.com',
    path: '/',
    secure: true,
    httpOnly: false,
    session: true,
    hostOnly: false,
    sameSite: 'no_restriction',
    ...over
  } as Cookie
}

describe('persistedCookie', () => {
  it('세션 쿠키에 14일 만료를 얹고 나머지는 그대로 둔다', () => {
    const now = 1_700_000_000_000
    const d = persistedCookie(cookie(), now)
    expect(d).toEqual({
      url: 'https://musinsa.com/',
      name: 'app_atk',
      value: 'opaque-token',
      domain: '.musinsa.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      expirationDate: Math.floor(now / 1000) + SESSION_COOKIE_KEEP_DAYS * 86400
    })
  })

  it('host-only 세션 쿠키는 건드리지 않는다(복제본도, 덮어쓰기 경쟁도 없게 — 무신사머니 결제 세션)', () => {
    expect(persistedCookie(cookie({ domain: 'www.shoemarker.co.kr', hostOnly: true, name: 'CKMAIN' }))).toBeNull()
    expect(persistedCookie(cookie({ domain: 'money.musinsapayments.com', hostOnly: true, name: 'SESSION' }))).toBeNull()
  })

  it('만료가 있는 쿠키·도메인 없는 쿠키는 건드리지 않는다', () => {
    expect(persistedCookie(cookie({ session: false, expirationDate: 1 }))).toBeNull()
    expect(persistedCookie(cookie({ domain: undefined }))).toBeNull()
  })

  it('유튜브·구글 로그인 쿠키는 유지하지 않는다(로그아웃이 다시 살아나지 않게)', () => {
    expect(shouldKeepSessionCookie(cookie({ domain: '.youtube.com' }))).toBe(false)
    expect(shouldKeepSessionCookie(cookie({ domain: '.accounts.google.com' }))).toBe(false)
    expect(persistedCookie(cookie({ domain: '.youtube.com', name: 'SID' }))).toBeNull()
    expect(persistedCookie(cookie({ domain: '.accounts.google.com', name: 'ACCOUNT_CHOOSER' }))).toBeNull()
  })

  it('cookieUrl 은 secure 여부와 경로를 따른다', () => {
    expect(cookieUrl({ domain: 'a.example', path: '/x', secure: false })).toBe('http://a.example/x')
    expect(cookieUrl({ domain: '.b.example', path: '/', secure: true })).toBe('https://b.example/')
  })
})

describe('keepSessionCookies', () => {
  // 되쓰기는 DELAY 만큼 기다렸다가 쿠키가 아직 있는지 다시 읽고 나서 한다 — 가짜 시계로 시간을 흘린다
  const DELAY = 500
  function jar(stored?: Cookie[]): {
    fire: (c: Cookie, removed?: boolean) => void
    set: ReturnType<typeof vi.fn>
    jar: Parameters<typeof keepSessionCookies>[0]
  } {
    let handler: ((e: unknown, c: Cookie, cause: string, removed: boolean) => void) | null = null
    const set = vi.fn(async (_d: CookiesSetDetails) => {})
    const j = {
      on: (_ev: 'changed', l: typeof handler) => {
        handler = l
        return j
      },
      set,
      // stored 를 주면 저장소를 흉내 낸다(없으면 get 이 없는 대역)
      ...(stored
        ? { get: async (f: { name?: string }) => stored.filter((c) => c.name === f.name) }
        : {})
    }
    return { fire: (c, removed = false) => handler?.(null, c, 'explicit', removed), set, jar: j }
  }
  const tick = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms)
  }

  it('세션 쿠키가 생기면 잠시 뒤 만료를 얹어 되쓴다', async () => {
    vi.useFakeTimers()
    try {
      const { fire, set, jar: j } = jar()
      keepSessionCookies(j, { now: () => 1_700_000_000_000 })
      fire(cookie())
      expect(set).not.toHaveBeenCalled() // 바로 쓰지 않는다(로그아웃 삭제와 겹치지 않게)
      await tick(DELAY)
      expect(set).toHaveBeenCalledTimes(1)
      expect(set.mock.calls[0][0]).toMatchObject({ name: 'app_atk', domain: '.musinsa.com' })
      expect((set.mock.calls[0][0] as CookiesSetDetails).expirationDate).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('되쓴 쿠키(만료 있음)·지워진 쿠키에는 반응하지 않는다(무한 반복 없음)', async () => {
    vi.useFakeTimers()
    try {
      const { fire, set, jar: j } = jar()
      keepSessionCookies(j)
      fire(cookie({ session: false, expirationDate: 9_999_999_999 }))
      fire(cookie(), true)
      await tick(DELAY * 2)
      expect(set).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('저장이 실패해도 던지지 않고 이름만 알린다', async () => {
    vi.useFakeTimers()
    try {
      const { fire, set, jar: j } = jar()
      set.mockRejectedValueOnce(new Error('boom'))
      const errors: string[] = []
      keepSessionCookies(j, { onError: (n) => errors.push(n) })
      fire(cookie())
      await tick(DELAY)
      expect(errors).toEqual(['app_atk'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('로그아웃 응답처럼 세션 쿠키 설정 직후 삭제가 오면 되살리지 않는다(무신사 app_atk 실기 2026-11-28)', async () => {
    vi.useFakeTimers()
    try {
      const { fire, set, jar: j } = jar()
      keepSessionCookies(j)
      fire(cookie({ name: 'app_atk' })) // Set-Cookie: app_atk=…; Domain=musinsa.com (세션)
      fire(cookie({ name: 'app_atk' }), true) // 이어서 Max-Age=0 삭제
      fire(cookie({ name: 'app_rtk' }))
      fire(cookie({ name: 'app_rtk' }), true)
      await tick(DELAY * 2)
      expect(set).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('기다리는 사이 저장소에서 이미 사라진 쿠키는 되쓰지 않는다', async () => {
    vi.useFakeTimers()
    try {
      const { fire, set, jar: j } = jar([]) // get 이 빈 목록을 돌려준다
      keepSessionCookies(j)
      fire(cookie())
      await tick(DELAY)
      expect(set).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('같은 쿠키가 연달아 바뀌면 마지막 값 하나만 되쓴다', async () => {
    vi.useFakeTimers()
    try {
      const latest = cookie({ value: 'new-token' })
      const { fire, set, jar: j } = jar([latest])
      keepSessionCookies(j)
      fire(cookie({ value: 'old-token' }))
      fire(latest)
      await tick(DELAY)
      expect(set).toHaveBeenCalledTimes(1)
      expect((set.mock.calls[0][0] as CookiesSetDetails).value).toBe('new-token')
    } finally {
      vi.useRealTimers()
    }
  })

  it('삭제 뒤에 다시 로그인해 새로 생긴 쿠키는 되쓴다', async () => {
    vi.useFakeTimers()
    try {
      const { fire, set, jar: j } = jar()
      keepSessionCookies(j)
      fire(cookie())
      fire(cookie(), true)
      fire(cookie({ value: 'relogin-token' }))
      await tick(DELAY)
      expect(set).toHaveBeenCalledTimes(1)
      expect((set.mock.calls[0][0] as CookiesSetDetails).value).toBe('relogin-token')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('하위 주소 복제본 정리', () => {
  const ck = (over: Partial<Cookie> = {}): Cookie =>
    cookie({ name: 'JSESSIONID', value: 'fresh', domain: 'api.musinsapayments.com', path: '/money/api', hostOnly: true, session: true, expirationDate: undefined, ...over })
  const stale = ck({ value: 'old', domain: '.api.musinsapayments.com', hostOnly: false, session: false, expirationDate: 2_000_000_000 })

  it('registrableDomain 은 두 단계 접미사를 안다', () => {
    expect(registrableDomain('api.musinsapayments.com')).toBe('musinsapayments.com')
    expect(registrableDomain('www.shoemarker.co.kr')).toBe('shoemarker.co.kr')
    expect(registrableDomain('naver.com')).toBe('naver.com')
  })

  it('하위 주소 도메인 쿠키만 복제본이다(등록 도메인 쿠키·host-only·세션 쿠키는 아니다)', () => {
    expect(isStaleHostCopy(stale)).toBe(true)
    expect(isStaleHostCopy(ck({ domain: '.www.shoemarker.co.kr', hostOnly: false, session: false, expirationDate: 1 }))).toBe(true)
    expect(isStaleHostCopy(ck({ name: 'NID_AUT', domain: '.naver.com', hostOnly: false, session: false, expirationDate: 1 }))).toBe(false)
    expect(isStaleHostCopy(ck({ name: 'app_atk', domain: '.musinsa.com', hostOnly: false, session: false, expirationDate: 1 }))).toBe(false)
    expect(isStaleHostCopy(ck())).toBe(false)
  })

  it('복제본만 지우고 같이 지워진 원본은 원래 모양(host-only 세션)으로 되살린다', async () => {
    const fresh = ck()
    const parent = ck({ name: 'JSESSIONID', value: 'p', domain: '.musinsapayments.com', path: '/', hostOnly: false, session: false, expirationDate: 2_100_000_000 })
    const other = ck({ name: 'OTHER', value: 'x' })
    const calls: string[] = []
    const sets: CookiesSetDetails[] = []
    const store = {
      get: async () => [fresh, stale, parent, other],
      remove: async (url: string, name: string) => {
        calls.push(`remove ${url} ${name}`)
      },
      set: async (d: CookiesSetDetails) => {
        sets.push(d)
      }
    }
    expect(await removeStaleHostCopies(store)).toBe(1)
    expect(calls).toEqual(['remove https://api.musinsapayments.com/money/api JSESSIONID'])
    const back = sets.map((d) => `${d.value}|${d.domain ?? 'host'}|${d.expirationDate ?? 'session'}`).sort()
    expect(back).toEqual(['fresh|host|session', 'p|.musinsapayments.com|2100000000'])
  })
})
