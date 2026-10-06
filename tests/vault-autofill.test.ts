// 사용자 조작 자동 채움(상세 화면 버튼·페이지 내 피커)의 호스트 대조 검증.
// pageBridge 는 mock 으로 대체해 electron 없이 실행한다.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import type { VaultService } from '../src/main/vault/service'
import type { AccountDto } from '../src/shared/vault'

const { pageBridge, filledLengths } = vi.hoisted(() => ({
  // 칸 id → 채운 글자 수(제출 전 길이 확인용)
  filledLengths: new Map<number, number>(),
  pageBridge: {
    findLoginFields: vi.fn(
      async (): Promise<{
        username: number | undefined
        password: number | undefined
        submit: number | undefined
      }> => ({ username: 1, password: 2, submit: 3 })
    ),
    fillValue: vi.fn(async (_tab: unknown, id: number, value: string): Promise<string> => {
      filledLengths.set(id, value.length)
      return 'ok'
    }),
    valueLength: vi.fn(
      async (_tab: unknown, id: number): Promise<number> => filledLengths.get(id) ?? -1
    ),
    // 로그인 칸 진짜 키 입력 — 테스트에서는 fillValue 와 같은 목으로 흘려 기존 기대를 그대로 둔다
    typeLogin: vi.fn(async (tab: unknown, id: number, value: string) =>
      pageBridge.fillValue(tab, id, value)
    ),
    submitForm: vi.fn(async (): Promise<string> => 'ok'),
    // 로그인 제출(진짜 클릭) — 테스트에서는 submitForm 목으로 흘려 기존 기대를 그대로 둔다
    submitLogin: vi.fn(async (tab: unknown, id: number) => pageBridge.submitForm(tab, id))
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { autofillAccount } = await import('../src/main/vault/autofill')

const PASSWORD = 'pw-secret-1234'

function account(over: Partial<AccountDto> = {}): AccountDto {
  return {
    id: 1,
    siteId: 1,
    host: 'nid.naver.com',
    label: '네이버',
    username: 'hongildong',
    isDefault: true,
    itemTypes: ['login'],
    urls: [],
    agentAccess: 'inherit',
    tags: [],
    ...over
  }
}

function tabAt(url: string): Tab {
  return { id: 't1', view: { webContents: { getURL: () => url } } } as unknown as Tab
}

function deps(
  opts: { url?: string; account?: AccountDto | null; excluded?: string[]; locked?: boolean } = {}
): {
  vault: VaultService
  activeTab: () => Tab | null
  excludedHosts: () => string[]
} {
  const vault = {
    state: () => (opts.locked ? 'locked' : 'unlocked'),
    getAccount: () => (opts.account === undefined ? account() : opts.account),
    getSecretForFill: () => PASSWORD
  } as unknown as VaultService
  return {
    vault,
    activeTab: () => (opts.url === null ? null : tabAt(opts.url ?? 'https://www.naver.com/')),
    excludedHosts: () => opts.excluded ?? []
  }
}

beforeEach(() => {
  pageBridge.fillValue.mockClear()
  pageBridge.findLoginFields.mockClear()
})

describe('autofillAccount', () => {
  it('같은 등록 도메인이면 서브도메인이 달라도 채운다(nid.naver.com 계정 → www.naver.com)', async () => {
    expect(await autofillAccount(deps(), 1)).toBe('ok')
    expect(pageBridge.fillValue).toHaveBeenCalledTimes(2)
  })

  it('autoSubmit 이 켜져 있고 아이디까지 채웠으면 로그인 폼을 바로 제출한다', async () => {
    pageBridge.submitForm.mockClear()
    expect(await autofillAccount({ ...deps(), autoSubmit: () => true }, 1)).toBe('ok')
    expect(pageBridge.submitForm).toHaveBeenCalledTimes(1)
  })

  it('autoSubmit 이 꺼져 있으면 채우기만 한다', async () => {
    pageBridge.submitForm.mockClear()
    expect(await autofillAccount({ ...deps(), autoSubmit: () => false }, 1)).toBe('ok')
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
  })

  it('등록 도메인이 다르면 채우지 않는다', async () => {
    expect(await autofillAccount(deps({ url: 'https://www.daum.net/login' }), 1)).toBe(
      'host-mismatch'
    )
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('평문(http) 페이지에는 채우지 않는다', async () => {
    expect(await autofillAccount(deps({ url: 'http://www.naver.com/' }), 1)).toBe('insecure-page')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('제외 도메인이면 채우지 않는다(같은 등록 도메인의 서브도메인 포함)', async () => {
    expect(await autofillAccount(deps({ excluded: ['naver.com'] }), 1)).toBe('excluded')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('금고가 잠겨 있으면 채우지 않는다', async () => {
    expect(await autofillAccount(deps({ locked: true }), 1)).toBe('locked')
  })

  it('target 을 주면 활성 탭이 아니라 그 탭에 채운다(피커 경로)', async () => {
    const target = tabAt('https://nid.naver.com/nidlogin.login')
    const d = deps({ url: 'https://www.daum.net/' })
    expect(await autofillAccount(d, 1, { tab: target, host: 'nid.naver.com' })).toBe('ok')
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(1, target, 1, 'hongildong')
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(2, target, 2, PASSWORD)
  })

  it('게이트가 검증한 호스트와 탭의 현재 호스트가 어긋나면 채우지 않는다', async () => {
    const target = tabAt('https://www.daum.net/login')
    expect(await autofillAccount(deps(), 1, { tab: target, host: 'nid.naver.com' })).toBe(
      'host-mismatch'
    )
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })

  it('아이디 칸이 있는데 금고 아이디가 비어 있으면 제출하지 않는다(빈 아이디 제출 금지)', async () => {
    pageBridge.submitForm.mockClear()
    const d = { ...deps({ account: account({ username: '' }) }), autoSubmit: () => true }
    expect(await autofillAccount(d, 1)).toBe('filled-password-only')
    // 비밀번호 칸만 채우고 아이디 칸은 건드리지 않는다
    expect(pageBridge.fillValue).toHaveBeenCalledTimes(1)
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
  })

  it('아이디 칸 자체가 없는 비밀번호 전용 화면(2단계)이면 제출한다', async () => {
    pageBridge.submitForm.mockClear()
    pageBridge.findLoginFields.mockResolvedValueOnce({
      username: undefined,
      password: 2,
      submit: 3
    })
    const d = { ...deps({ account: account({ username: '' }) }), autoSubmit: () => true }
    expect(await autofillAccount(d, 1)).toBe('ok')
    expect(pageBridge.submitForm).toHaveBeenCalledTimes(1)
  })

  it('아이디 채우기가 실패하면 제출하지 않는다', async () => {
    pageBridge.submitForm.mockClear()
    pageBridge.fillValue.mockResolvedValueOnce('not found')
    const d = { ...deps(), autoSubmit: () => true }
    expect(await autofillAccount(d, 1)).toBe('filled-password-only')
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
  })

  it('계정을 찾지 못하면 값을 읽지 않는다', async () => {
    expect(await autofillAccount(deps({ account: null }), 99)).toBe('account-not-found')
    expect(pageBridge.findLoginFields).not.toHaveBeenCalled()
  })
})

describe('2단계 로그인(구글) — 아이디 화면 → 비밀번호 화면', () => {
  const noWait = async (): Promise<void> => undefined

  it('아이디 칸만 있으면 아이디를 채워 넘기고, 비밀번호 칸이 나오면 이어서 채워 제출한다', async () => {
    pageBridge.submitForm.mockClear()
    const tab = tabAt('https://accounts.google.com/v3/signin/identifier')
    pageBridge.findLoginFields
      .mockResolvedValueOnce({ username: 1, password: undefined, submit: 3 })
      .mockResolvedValueOnce({ username: undefined, password: undefined, submit: undefined })
      .mockResolvedValueOnce({ username: undefined, password: 2, submit: 3 })
      .mockResolvedValueOnce({ username: undefined, password: 2, submit: 3 })
    const d = {
      ...deps({ account: account({ host: 'accounts.google.com', username: 'hong@gmail.com' }) }),
      autoSubmit: () => true,
      wait: noWait
    }
    expect(await autofillAccount(d, 1, { tab, host: 'accounts.google.com' })).toBe(
      'filled-username-only'
    )
    // 첫 화면: 아이디만 채우고 [다음]을 누른다. 비밀번호는 아직 읽지 않는다
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(1, tab, 1, 'hong@gmail.com')
    expect(pageBridge.submitForm).toHaveBeenCalledTimes(1)
    // 비밀번호 화면이 나타나면 이어서 채우고 제출한다
    await vi.waitFor(() => expect(pageBridge.fillValue).toHaveBeenCalledTimes(2))
    expect(pageBridge.fillValue).toHaveBeenNthCalledWith(2, tab, 2, PASSWORD)
    await vi.waitFor(() => expect(pageBridge.submitForm).toHaveBeenCalledTimes(2))
  })

  it('비밀번호 단계에서 비밀번호 칸이 없으면 아이디를 다시 치지 않는다(되돌이 방지)', async () => {
    pageBridge.submitForm.mockClear()
    const tab = tabAt('https://accounts.google.com/v3/signin/identifier')
    pageBridge.findLoginFields.mockResolvedValueOnce({
      username: 1,
      password: undefined,
      submit: 3
    })
    const d = {
      ...deps({ account: account({ host: 'accounts.google.com' }) }),
      autoSubmit: () => true
    }
    expect(
      await autofillAccount(d, 1, { tab, host: 'accounts.google.com', stage: 'password' })
    ).toBe('fields-not-found')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
    expect(pageBridge.submitForm).not.toHaveBeenCalled()
  })

  it('아이디 칸만 있어도 금고 아이디가 비어 있으면 채우지 않는다', async () => {
    pageBridge.findLoginFields.mockResolvedValueOnce({
      username: 1,
      password: undefined,
      submit: 3
    })
    const d = deps({ account: account({ username: '' }) })
    expect(await autofillAccount(d, 1)).toBe('fields-not-found')
    expect(pageBridge.fillValue).not.toHaveBeenCalled()
  })
})
