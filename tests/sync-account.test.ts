// 계정 디렉터리 — "로그인 먼저, 설정은 계정에 따라온다"
import { describe, it, expect, vi } from 'vitest'
import { AccountService } from '../src/main/sync/account'
import { AuthService } from '../src/main/sync/auth'
import type { SyncBackend } from '../src/main/sync/backend'
import {
  DIRECTORY_ANON_KEY,
  DIRECTORY_URL_KEY,
  DIRECTORY_WORKSPACE_ID,
  readDirectoryConfig,
  writeDirectoryConfig
} from '../src/main/sync/directory'
import { createFakeBackend, FAKE_USER_ID } from './stubs/fake-backend'

const URL = 'https://abcdefghijkl.supabase.co'
const KEY = 'sb_publishable_test_key_0123456789'

function authFor(backend: SyncBackend | null): AuthService {
  return new AuthService({
    backend,
    configured: backend !== null,
    openExternal: vi.fn(async () => {})
  })
}

function setup(
  opts: {
    directory?: boolean
    seedConfig?: boolean
    data?: SyncBackend
    vault?: { adoptAccountPassword: (password: string) => Promise<string> }
    offline?: {
      userId: () => string | null
      email: () => string | undefined
      verifyPassword: (password: string) => Promise<boolean>
    }
  } = {}
): {
  account: AccountService
  directory: ReturnType<typeof createFakeBackend> | null
  data: SyncBackend
  auth: AuthService
  settings: { syncSupabaseUrl: string; syncSupabaseAnonKey: string }
  onDataBackend: ReturnType<typeof vi.fn>
  applyEnv: ReturnType<typeof vi.fn>
} {
  const directory = opts.directory === false ? null : createFakeBackend()
  if (directory && opts.seedConfig) {
    directory.seedKeyed('settings_sync', [
      {
        user_id: FAKE_USER_ID,
        workspace_id: DIRECTORY_WORKSPACE_ID,
        key: DIRECTORY_URL_KEY,
        value: URL,
        updated_at: new Date(1000).toISOString(),
        deleted_at: null
      },
      {
        user_id: FAKE_USER_ID,
        workspace_id: DIRECTORY_WORKSPACE_ID,
        key: DIRECTORY_ANON_KEY,
        value: KEY,
        updated_at: new Date(1000).toISOString(),
        deleted_at: null
      }
    ])
  }
  const data = opts.data ?? createFakeBackend()
  // 디렉터리 빌드에서는 데이터 백엔드가 아직 없다(주소를 내려받아 만든다)
  const auth = authFor(directory ? null : data)
  const settings = { syncSupabaseUrl: '', syncSupabaseAnonKey: '' }
  const onDataBackend = vi.fn()
  const applyEnv = vi.fn()
  const account = new AccountService({
    directory,
    directoryAuth: directory ? authFor(directory) : null,
    auth,
    createDataBackend: () => data,
    onDataBackend,
    settings: {
      get: () => settings,
      set: (patch) => Object.assign(settings, patch)
    },
    applyEnv,
    now: () => 5000,
    ...(opts.vault ? { vault: opts.vault } : {}),
    ...(opts.offline ? { offline: opts.offline } : {})
  })
  return { account, directory, data, auth, settings, onDataBackend, applyEnv }
}

describe('directory 행 읽기·쓰기', () => {
  it('내 행만 읽고 형식이 틀리면 null', async () => {
    const dir = createFakeBackend()
    dir.seedKeyed('settings_sync', [
      {
        user_id: 'someone-else',
        workspace_id: DIRECTORY_WORKSPACE_ID,
        key: DIRECTORY_URL_KEY,
        value: URL,
        updated_at: new Date(1000).toISOString(),
        deleted_at: null
      }
    ])
    expect(await readDirectoryConfig(dir, FAKE_USER_ID)).toBeNull()
    await writeDirectoryConfig(dir, FAKE_USER_ID, { url: URL, anonKey: KEY }, 2000)
    expect(await readDirectoryConfig(dir, FAKE_USER_ID)).toEqual({ url: URL, anonKey: KEY })
  })

  it('service_role 키·잘못된 URL 은 저장하지 않는다', async () => {
    const dir = createFakeBackend()
    await expect(
      writeDirectoryConfig(dir, FAKE_USER_ID, { url: URL, anonKey: 'sb_secret_abcdefghijk' })
    ).rejects.toThrow('bad-key')
    await expect(
      writeDirectoryConfig(dir, FAKE_USER_ID, { url: 'http://x', anonKey: KEY })
    ).rejects.toThrow('bad-url')
    expect(dir.keyedRows('settings_sync')).toHaveLength(0)
  })
})

describe('AccountService — 로그인 먼저', () => {
  it('처음 로그인한 계정: 주소가 없으면 needsSupabase, 주소를 넣으면 계정에 저장하고 같은 자격으로 데이터 프로젝트에 붙는다', async () => {
    const h = setup()
    await h.account.signIn('me@example.com', 'pw-1234')
    expect(h.account.accountState()).toMatchObject({
      configured: true,
      signedIn: true,
      email: 'me@example.com',
      needsSupabase: true
    })
    // 데이터 쪽은 아직 아무것도 안 붙었다
    expect(h.auth.state().signedIn).toBe(false)
    expect(h.onDataBackend).not.toHaveBeenCalled()
    expect(h.settings.syncSupabaseUrl).toBe('')

    await h.account.saveSupabase({ url: URL, anonKey: KEY })
    expect(h.account.accountState().needsSupabase).toBe(false)
    expect(h.directory?.keyedRows('settings_sync').map((r) => [r.key, r.value])).toEqual([
      [DIRECTORY_URL_KEY, URL],
      [DIRECTORY_ANON_KEY, KEY]
    ])
    expect(h.settings).toEqual({ syncSupabaseUrl: URL, syncSupabaseAnonKey: KEY })
    expect(h.applyEnv).toHaveBeenCalledWith(URL, KEY)
    expect(h.onDataBackend).toHaveBeenCalledWith(h.data)
    // 들고 있던 자격으로 데이터 프로젝트에 로그인됐다
    expect(h.auth.state()).toMatchObject({ signedIn: true, email: 'me@example.com' })
    expect(await h.data.currentUser()).toMatchObject({ email: 'me@example.com' })
  })

  it('기존 계정: 저장된 주소가 따라와 설정에 들어가고 곧바로 데이터 프로젝트에 로그인된다', async () => {
    const h = setup({ seedConfig: true })
    await h.account.signIn('me@example.com', 'pw-1234')
    expect(h.account.accountState().needsSupabase).toBe(false)
    expect(h.settings).toEqual({ syncSupabaseUrl: URL, syncSupabaseAnonKey: KEY })
    expect(h.onDataBackend).toHaveBeenCalledTimes(1)
    expect(h.auth.state()).toMatchObject({ signedIn: true, email: 'me@example.com' })
  })

  it('데이터 프로젝트에 계정이 없으면 같은 이메일·비밀번호로 가입한다', async () => {
    const data = createFakeBackend()
    const signUp = vi.spyOn(data, 'signUp')
    let first = true
    vi.spyOn(data, 'signIn').mockImplementation(async (email) => {
      if (first) {
        first = false
        throw new Error('Invalid login credentials')
      }
      return { userId: FAKE_USER_ID, email }
    })
    const h = setup({ seedConfig: true, data })
    await h.account.signIn('me@example.com', 'pw-1234')
    expect(signUp).toHaveBeenCalledWith('me@example.com', 'pw-1234')
    expect(h.auth.state().signedIn).toBe(true)
  })

  it('다른 오류는 그대로 던진다(가입으로 덮지 않는다)', async () => {
    const data = createFakeBackend()
    vi.spyOn(data, 'signIn').mockRejectedValue(new Error('network down'))
    const h = setup({ seedConfig: true, data })
    await expect(h.account.signIn('me@example.com', 'pw')).rejects.toThrow('network down')
  })

  it('앱 시작: 디렉터리 세션이 살아 있으면 주소를 내려받아 데이터 백엔드를 붙인다', async () => {
    const h = setup({ seedConfig: true })
    await h.directory?.signIn('me@example.com', 'pw')
    await h.account.restore()
    expect(h.account.accountState()).toMatchObject({ signedIn: true, needsSupabase: false })
    expect(h.settings.syncSupabaseUrl).toBe(URL)
    expect(h.onDataBackend).toHaveBeenCalledWith(h.data)
  })

  it('로그아웃하면 디렉터리·데이터 둘 다 로그아웃된다', async () => {
    const h = setup({ seedConfig: true })
    await h.account.signIn('me@example.com', 'pw')
    await h.account.signOut()
    expect(h.account.accountState()).toMatchObject({ signedIn: false, needsSupabase: false })
    expect(h.auth.state().signedIn).toBe(false)
    expect(await h.directory?.currentUser()).toBeNull()
  })

  it('디렉터리가 없는 빌드는 예전처럼 데이터 프로젝트에 바로 로그인한다', async () => {
    const h = setup({ directory: false })
    await h.account.signIn('me@example.com', 'pw')
    expect(h.account.accountState().configured).toBe(false)
    expect(h.auth.state()).toMatchObject({ signedIn: true, email: 'me@example.com' })
    expect(h.onDataBackend).not.toHaveBeenCalled()
  })

  it('주소 설정을 기다리다 시간이 지나면 비밀번호를 버린다(데이터 로그인은 사용자가 다시 한다)', async () => {
    let clock = 5000
    const directory = createFakeBackend()
    const data = createFakeBackend()
    const auth = authFor(null)
    const settings = { syncSupabaseUrl: '', syncSupabaseAnonKey: '' }
    const account = new AccountService({
      directory,
      directoryAuth: authFor(directory),
      auth,
      createDataBackend: () => data,
      onDataBackend: () => {},
      settings: { get: () => settings, set: (p) => Object.assign(settings, p) },
      applyEnv: () => {},
      credentialTtlMs: 1000,
      now: () => clock
    })
    await account.signIn('me@example.com', 'pw')
    clock += 5000
    await account.saveSupabase({ url: URL, anonKey: KEY })
    expect(settings.syncSupabaseUrl).toBe(URL)
    expect(auth.state().signedIn).toBe(false)
  })
})

describe('AuthService.setBackend', () => {
  it('백엔드를 갈아 끼우면 로그아웃 상태로 시작하고 configured 가 따라간다', async () => {
    const a = authFor(null)
    expect(a.state().configured).toBe(false)
    const backend = createFakeBackend()
    const seen: boolean[] = []
    a.onStateChanged((s) => seen.push(s.configured))
    a.setBackend(backend)
    expect(a.hasBackend()).toBe(true)
    expect(a.state()).toMatchObject({ signedIn: false, configured: true })
    await a.signIn('me@example.com', 'pw')
    expect(a.state().signedIn).toBe(true)
    a.setBackend(null)
    expect(a.state()).toMatchObject({ signedIn: false, configured: false })
    expect(seen).toEqual([true, true, false])
  })
})

describe('이미 같은 프로젝트에 붙어 있을 때', () => {
  it('앱 시작 때 복구된 데이터 세션을 끊지 않고 디렉터리만 로그인한다', async () => {
    const directory = createFakeBackend()
    directory.seedKeyed('settings_sync', [
      {
        user_id: FAKE_USER_ID,
        workspace_id: DIRECTORY_WORKSPACE_ID,
        key: DIRECTORY_URL_KEY,
        value: URL,
        updated_at: new Date(1000).toISOString(),
        deleted_at: null
      },
      {
        user_id: FAKE_USER_ID,
        workspace_id: DIRECTORY_WORKSPACE_ID,
        key: DIRECTORY_ANON_KEY,
        value: KEY,
        updated_at: new Date(1000).toISOString(),
        deleted_at: null
      }
    ])
    const data = createFakeBackend()
    const auth = authFor(data)
    await auth.signIn('me@example.com', 'pw')
    const dataSignIn = vi.spyOn(data, 'signIn')
    const settings = { syncSupabaseUrl: URL, syncSupabaseAnonKey: KEY }
    const onDataBackend = vi.fn()
    const account = new AccountService({
      directory,
      directoryAuth: authFor(directory),
      auth,
      createDataBackend: () => createFakeBackend(),
      onDataBackend,
      settings: { get: () => settings, set: (p) => Object.assign(settings, p) },
      applyEnv: () => {}
    })
    await account.signIn('me@example.com', 'pw')
    expect(onDataBackend).not.toHaveBeenCalled()
    expect(dataSignIn).not.toHaveBeenCalled()
    expect(auth.state()).toMatchObject({ signedIn: true, email: 'me@example.com' })
    expect(account.accountState()).toMatchObject({ signedIn: true, needsSupabase: false })
  })
})

describe('비밀번호를 잊었을 때 — 이 PC 의 살아 있는 세션으로 새로 정한다', () => {
  it('데이터 세션이 있으면 새 비밀번호를 정하고 그것으로 디렉터리에 로그인한다', async () => {
    const directory = createFakeBackend()
    const data = createFakeBackend()
    const auth = authFor(data)
    await auth.signIn('me@example.com', 'old-pw')
    const update = vi.spyOn(data, 'updatePassword')
    const dirSignIn = vi.spyOn(directory, 'signIn')
    const settings = { syncSupabaseUrl: URL, syncSupabaseAnonKey: KEY }
    const account = new AccountService({
      directory,
      directoryAuth: authFor(directory),
      auth,
      createDataBackend: () => data,
      onDataBackend: () => {},
      settings: { get: () => settings, set: (p) => Object.assign(settings, p) },
      applyEnv: () => {}
    })
    await account.resetPasswordWithSession('me@example.com', 'new-password-1')
    expect(update).toHaveBeenCalledWith('new-password-1')
    expect(dirSignIn).toHaveBeenCalledWith('me@example.com', 'new-password-1')
    expect(account.accountState()).toMatchObject({ signedIn: true, email: 'me@example.com' })
  })

  it('세션이 없거나 비밀번호가 짧으면 거부한다', async () => {
    const h = setup()
    await expect(
      h.account.resetPasswordWithSession('me@example.com', 'new-password-1')
    ).rejects.toThrow('no-session')
    const data = createFakeBackend()
    const auth = authFor(data)
    await auth.signIn('me@example.com', 'old')
    const account = new AccountService({
      directory: createFakeBackend(),
      directoryAuth: authFor(createFakeBackend()),
      auth,
      createDataBackend: () => data,
      onDataBackend: () => {},
      settings: { get: () => ({ syncSupabaseUrl: '', syncSupabaseAnonKey: '' }), set: () => {} },
      applyEnv: () => {}
    })
    await expect(account.resetPasswordWithSession('me@example.com', 'short')).rejects.toThrow(
      'weak password'
    )
    await expect(
      account.resetPasswordWithSession('other@example.com', 'new-password-1')
    ).rejects.toThrow('Invalid login credentials')
  })
})

describe('이 PC 설정에 주소가 있는데 계정에는 없을 때', () => {
  it('로그인하면 그 주소를 계정에 올리고 곧바로 붙는다(폼을 다시 채우지 않는다)', async () => {
    const directory = createFakeBackend()
    const data = createFakeBackend()
    const auth = authFor(null)
    const settings = { syncSupabaseUrl: URL, syncSupabaseAnonKey: KEY }
    const onDataBackend = vi.fn()
    const account = new AccountService({
      directory,
      directoryAuth: authFor(directory),
      auth,
      createDataBackend: () => data,
      onDataBackend,
      settings: { get: () => settings, set: (p) => Object.assign(settings, p) },
      applyEnv: () => {}
    })
    await account.signIn('me@example.com', 'pw')
    expect(account.accountState().needsSupabase).toBe(false)
    expect(directory.keyedRows('settings_sync').map((r) => [r.key, r.value])).toEqual([
      [DIRECTORY_URL_KEY, URL],
      [DIRECTORY_ANON_KEY, KEY]
    ])
    expect(onDataBackend).toHaveBeenCalledWith(data)
    expect(auth.state()).toMatchObject({ signedIn: true, email: 'me@example.com' })
  })
})

describe('디렉터리와 데이터가 같은 프로젝트일 때', () => {
  it('앱을 다시 켜면 디렉터리 세션을 데이터 쪽에 심어 로그인을 다시 시키지 않는다', async () => {
    const directory = createFakeBackend()
    directory.seedKeyed('settings_sync', [
      {
        user_id: FAKE_USER_ID,
        workspace_id: DIRECTORY_WORKSPACE_ID,
        key: DIRECTORY_URL_KEY,
        value: URL,
        updated_at: new Date(1000).toISOString(),
        deleted_at: null
      },
      {
        user_id: FAKE_USER_ID,
        workspace_id: DIRECTORY_WORKSPACE_ID,
        key: DIRECTORY_ANON_KEY,
        value: KEY,
        updated_at: new Date(1000).toISOString(),
        deleted_at: null
      }
    ])
    await directory.signIn('me@example.com', 'pw')
    const data = createFakeBackend()
    const auth = authFor(null)
    const settings = { syncSupabaseUrl: '', syncSupabaseAnonKey: '' }
    const account = new AccountService({
      directory,
      directoryAuth: authFor(directory),
      auth,
      createDataBackend: () => data,
      onDataBackend: () => {},
      settings: { get: () => settings, set: (p) => Object.assign(settings, p) },
      applyEnv: () => {},
      directoryUrl: URL
    })
    await account.restore()
    expect(auth.state()).toMatchObject({ signedIn: true, email: 'me@example.com' })
    expect(await data.currentUser()).toMatchObject({ email: 'me@example.com' })
  })
})

describe('AccountService — 계정 비밀번호가 키마스터 열쇠', () => {
  it('데이터 프로젝트에 로그인되면 그 비밀번호로 키마스터를 맞춘다', async () => {
    const adopt = vi.fn(async () => 'setup')
    const h = setup({ directory: false, vault: { adoptAccountPassword: adopt } })
    await h.account.signIn('me@example.com', 'pw-1')
    expect(adopt).toHaveBeenCalledWith('pw-1')
  })

  it('서버 키 재료가 다르다는 알림이 오면 기억한 비밀번호로 다시 맞추고, 로그아웃 뒤에는 하지 않는다', async () => {
    const adopt = vi.fn(async () => 'rekeyed-to-remote')
    const h = setup({ directory: false, vault: { adoptAccountPassword: adopt } })
    await h.account.onVaultKeyMismatch()
    expect(adopt).not.toHaveBeenCalled()
    await h.account.signIn('me@example.com', 'pw-1')
    adopt.mockClear()
    await h.account.onVaultKeyMismatch()
    expect(adopt).toHaveBeenCalledWith('pw-1')
    await h.account.signOut()
    adopt.mockClear()
    await h.account.onVaultKeyMismatch()
    expect(adopt).not.toHaveBeenCalled()
  })

  it('키마스터 맞추기가 실패해도 로그인은 그대로다', async () => {
    const h = setup({
      directory: false,
      vault: {
        adoptAccountPassword: async () => {
          throw new Error('boom')
        }
      }
    })
    await h.account.signIn('me@example.com', 'pw-1')
    expect(h.auth.state().signedIn).toBe(true)
  })
})


describe('서버 정지·불통일 때의 로컬 로그인', () => {
  const STOPPED =
    'Service for this project is restricted due to the following violations: exceed_egress_quota.'

  function stopped(): ReturnType<typeof setup> & { verify: ReturnType<typeof vi.fn> } {
    const verify = vi.fn(async (pw: string) => pw === 'good-password')
    const made = setup({
      offline: { userId: () => 'user-1', email: () => undefined, verifyPassword: verify }
    })
    made.directory!.failWith(new Error(STOPPED))
    return { ...made, verify }
  }

  it('서버 정지로 로그인이 실패한 직후, 키마스터와 맞는 비밀번호면 이 PC 계정 공간으로 들어간다', async () => {
    const { account } = stopped()
    await expect(account.signIn('me@example.com', 'good-password')).rejects.toThrow()
    await account.offlineSignIn('good-password')
    const state = account.accountState()
    expect(state.signedIn).toBe(true)
    expect(state.offline).toBe(true)
    expect(state.userId).toBe('user-1')
  })

  it('비밀번호가 키마스터와 다르면 들어가지 못한다', async () => {
    const { account } = stopped()
    await expect(account.signIn('me@example.com', 'x')).rejects.toThrow()
    await expect(account.offlineSignIn('wrong')).rejects.toThrow('offline-wrong-password')
    expect(account.accountState().signedIn).toBe(false)
  })

  it('서버 오류가 아니라 비밀번호 오류로 실패했으면 로컬 로그인을 열지 않는다', async () => {
    const { account, directory, verify } = stopped()
    directory!.failWith(new Error('Invalid login credentials'))
    await expect(account.signIn('me@example.com', 'x')).rejects.toThrow()
    await expect(account.offlineSignIn('good-password')).rejects.toThrow('offline-not-allowed')
    expect(verify).not.toHaveBeenCalled()
  })

  it('로그인을 시도한 적이 없으면(서버 상태를 모르면) 열지 않는다', async () => {
    const { account } = stopped()
    await expect(account.offlineSignIn('good-password')).rejects.toThrow('offline-not-allowed')
  })

  it('이 PC 에 계정 공간이 하나가 아니면 열지 않는다', async () => {
    const made = setup({
      offline: {
        userId: () => null,
        email: () => undefined,
        verifyPassword: async () => true
      }
    })
    made.directory!.failWith(new Error(STOPPED))
    await expect(made.account.signIn('a@b.com', 'x')).rejects.toThrow()
    await expect(made.account.offlineSignIn('x')).rejects.toThrow('offline-no-account')
  })
})
