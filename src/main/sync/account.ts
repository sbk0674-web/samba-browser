// 계정 서비스 — 디렉터리(중앙) 로그인과 데이터 Supabase 로그인을 한 번의 로그인으로 잇는다.
//
//   로그인(이메일·비밀번호) → 디렉터리에 로그인 → 계정에 저장된 데이터 Supabase 주소 읽기
//     있음: 설정에 저장 → 데이터 백엔드 새로 만들어 붙임 → 같은 자격으로 데이터 프로젝트에 로그인
//           (그 프로젝트에 계정이 없으면 가입한다)
//     없음: "이 계정의 Supabase 를 설정하세요" 상태. 사용자가 주소를 넣으면 디렉터리에 쓰고 위 순서로 붙는다
//   디렉터리가 내장돼 있지 않으면(개인 빌드): 예전처럼 데이터 프로젝트에 바로 로그인한다
//
// 디렉터리 로그인은 별도 AuthService(directoryAuth)가 맡는다 — 동기화 엔진은 데이터 쪽 AuthService 만 듣는다.
// 비밀번호는 데이터 프로젝트 로그인에 한 번 더 쓰려고 **메모리에만** 잠깐 둔다(주소 설정을 기다리는 동안).
// 디스크·로그·렌더러 어디에도 남기지 않고, 붙고 나면 즉시 지운다

import { isSupabaseAnonKey, isSupabaseProjectUrl, type AuthState } from '../../shared/sync'
import type { AuthService } from './auth'
import type { SyncBackend } from './backend'
import { readDirectoryConfig, writeDirectoryConfig, type DirectoryConfig } from './directory'

export interface AccountDeps {
  /** 디렉터리 백엔드·인증. 내장 주소가 없으면 둘 다 null(예전 동작) */
  directory: SyncBackend | null
  directoryAuth: AuthService | null
  /** 데이터 프로젝트 인증(기존 AuthService, 동기화 연결부가 듣는다). 백엔드는 여기서 갈아 끼운다 */
  auth: AuthService
  /** 데이터 백엔드를 주소로 새로 만든다(세션 파일은 호출부가 정한다) */
  createDataBackend: (config: DirectoryConfig) => SyncBackend
  /** 데이터 백엔드가 바뀌면 동기화 연결부에도 알린다 */
  onDataBackend: (backend: SyncBackend | null) => void
  settings: {
    get: () => { syncSupabaseUrl: string; syncSupabaseAnonKey: string }
    set: (patch: { syncSupabaseUrl: string; syncSupabaseAnonKey: string }) => void
  }
  /** 저장된 주소를 env 읽기보다 앞에 놓는다(sync/env.ts) */
  applyEnv: (url: string, anonKey: string) => void
  /** 디렉터리 프로젝트의 URL. 데이터 주소와 같으면 디렉터리 세션을 데이터 쪽에 그대로 심는다 */
  directoryUrl?: string
  /** 비밀번호를 메모리에 두는 최대 시간(ms). 기본 10분 */
  credentialTtlMs?: number
  now?: () => number
  /**
   * 키마스터. 계정 비밀번호가 곧 열쇠다 — 데이터 프로젝트에 로그인이 되는 순간 이 PC 금고를 그 비밀번호에
   * 맞추고, 서버 키 재료와 어긋나면(다른 PC 가 먼저 만든 금고) 자동으로 다시 잠근다. 없으면 아무것도 하지 않는다
   */
  vault?: { adoptAccountPassword: (password: string) => Promise<string> }
  /**
   * 서버가 정지·불통일 때의 로컬 로그인(사용자 2026-10-09: Supabase 한도 초과로 로그인이 막혀 앱을 못 썼다).
   * userId: 이 PC 에 계정 공간이 하나뿐일 때 그 계정 id(여럿이면 null — 모호해서 열지 않는다).
   * verifyPassword: 이 PC 키마스터로 비밀번호를 확인한다(서버를 거치지 않는다, 금고가 열려 있어야 한다)
   */
  offline?: {
    userId: () => string | null
    email: () => string | undefined
    verifyPassword: (password: string) => Promise<boolean>
  }
}

/** 디렉터리 쪽 상태. AuthState.account 로 렌더러에 나간다 — 토큰·비밀번호 없음 */
export interface AccountState {
  configured: boolean
  signedIn: boolean
  email?: string
  /** 디렉터리 계정 id(uuid). 이 PC 의 계정별 작업공간을 고르는 열쇠다 */
  userId?: string
  /** 로그인은 됐는데 이 계정에 데이터 Supabase 주소가 아직 없다 */
  needsSupabase: boolean
  /** 서버 함수(directory_user_count)가 관리자에게만 돌려주는 가입 사용자 수 */
  userCount?: number
  /** 서버 없이 이 PC 에서만 들어온 상태 — 동기화는 꺼져 있다(서버가 풀리면 다시 로그인한다) */
  offline?: boolean
}

/** 서버가 정지·불통이라 로그인 자체가 안 되는 오류 문구 — 비밀번호 문제가 아니다 */
const SERVER_DOWN_PATTERNS = [
  'service for this project is restricted',
  'exceed_egress_quota',
  'fetch failed',
  'failed to fetch',
  'network',
  'econnrefused',
  'enotfound',
  'etimedout',
  'timeout'
]

export function isServerDownError(message: string): boolean {
  const m = message.toLowerCase()
  return SERVER_DOWN_PATTERNS.some((p) => m.includes(p))
}

/** 디렉터리 서버의 관리자 전용 함수 이름(supabase/directory.sql). 없거나 권한 없으면 null */
export const USER_COUNT_RPC = 'directory_user_count'

const CREDENTIAL_TTL_MS = 10 * 60 * 1000

export class AccountService {
  private readonly deps: AccountDeps
  private state: AccountState
  private readonly listeners = new Set<(s: AccountState) => void>()
  /** 데이터 프로젝트 로그인에 한 번 더 쓸 자격. 주소 설정을 기다리는 동안만 산다 */
  private pendingCredential: { email: string; password: string; expiresAt: number } | null = null
  private currentUrl = ''
  /** 로그인에 쓴 계정 비밀번호 — 키마스터를 맞출 때만 쓴다. 메모리에만 있고 로그아웃 때 지운다 */
  private accountPassword: string | null = null
  /** 마지막 로그인 시도가 서버 정지·불통으로 실패했는가 — 로컬 로그인을 열어도 되는 유일한 조건 */
  private lastEnterServerDown = false

  constructor(deps: AccountDeps) {
    this.deps = deps
    this.state = {
      configured: deps.directory !== null && deps.directoryAuth !== null,
      signedIn: false,
      needsSupabase: false
    }
  }

  accountState(): AccountState {
    return { ...this.state }
  }

  onStateChanged(fn: (s: AccountState) => void): void {
    this.listeners.add(fn)
  }

  /** 앱 시작: 디렉터리 세션이 살아 있으면 주소를 내려받아 데이터 백엔드를 붙이고, 데이터 세션도 되살린다 */
  async restore(): Promise<AuthState> {
    const dir = this.directory()
    if (!dir) return this.deps.auth.restore()
    try {
      await dir.auth.restore()
      const user = await dir.backend.currentUser()
      if (!user) {
        this.next({
          ...this.state,
          signedIn: false,
          email: undefined,
          userId: undefined,
          needsSupabase: false
        })
        return this.deps.auth.restore()
      }
      await this.afterDirectorySignIn(user)
      return this.deps.auth.restore()
    } catch (e: unknown) {
      console.warn('계정 세션 복구 실패', e instanceof Error ? e.message : String(e))
      return this.deps.auth.restore()
    }
  }

  async signIn(email: string, password: string): Promise<AuthState> {
    return this.enterTracked(email, password, 'signIn')
  }

  /** 로그인 시도의 실패 사유를 기억한다 — 서버가 정지·불통일 때만 로컬 로그인이 열린다 */
  private async enterTracked(
    email: string,
    password: string,
    mode: 'signIn' | 'signUp'
  ): Promise<AuthState> {
    try {
      const state = await this.enter(email, password, mode)
      this.lastEnterServerDown = false
      return state
    } catch (e: unknown) {
      this.lastEnterServerDown = isServerDownError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  /**
   * 서버(Supabase)가 정지·불통이라 로그인이 안 될 때, 이 PC 키마스터로 비밀번호를 확인하고 이 PC 의 계정 공간으로 들어간다.
   * 조건: 직전 로그인이 서버 정지·불통으로 실패했고, 이 PC 에 계정 공간이 하나뿐이고, 비밀번호가 키마스터와 맞을 것.
   * 동기화는 켜지지 않는다(데이터 쪽 로그인은 여전히 로그아웃) — 서버가 풀린 뒤 다시 로그인하면 이어진다
   */
  async offlineSignIn(password: string): Promise<AuthState> {
    const offline = this.deps.offline
    if (!offline || !this.state.configured) throw new Error('offline-unavailable')
    if (!this.lastEnterServerDown) throw new Error('offline-not-allowed')
    const userId = offline.userId()
    if (!userId) throw new Error('offline-no-account')
    if (password.length === 0 || !(await offline.verifyPassword(password))) {
      throw new Error('offline-wrong-password')
    }
    this.accountPassword = password
    this.next({
      configured: true,
      signedIn: true,
      userId,
      ...(offline.email() ? { email: offline.email() } : {}),
      needsSupabase: false,
      offline: true
    })
    return this.deps.auth.state()
  }

  async signUp(email: string, password: string): Promise<AuthState> {
    return this.enterTracked(email, password, 'signUp')
  }

  /**
   * 구글 로그인: 디렉터리에서 끝낸 뒤 주소가 있으면 데이터 프로젝트에도 구글로 한 번 더 로그인한다
   * (비밀번호가 없어 자동 가입은 못 한다 — 그 프로젝트에 구글 로그인이 설정돼 있어야 한다)
   */
  async signInGoogle(): Promise<AuthState> {
    const dir = this.directory()
    if (!dir) return this.deps.auth.signInGoogle()
    await dir.auth.signInGoogle()
    const user = await dir.backend.currentUser()
    if (!user) return this.deps.auth.state()
    const config = await this.afterDirectorySignIn(user)
    if (!config) return this.deps.auth.state()
    // 데이터 프로젝트에 이미 세션이 살아 있으면 브라우저를 또 열지 않는다
    if (this.deps.auth.state().signedIn) return this.deps.auth.state()
    return this.deps.auth.signInGoogle()
  }

  /** 로그인한 계정에 데이터 Supabase 주소를 저장하고 곧바로 붙는다 */
  async saveSupabase(config: DirectoryConfig): Promise<AuthState> {
    const dir = this.directory()
    if (dir) {
      const user = await dir.backend.currentUser()
      if (!user) throw new Error('not-signed-in')
      await writeDirectoryConfig(dir.backend, user.userId, config, this.deps.now?.())
      this.next({ ...this.state, needsSupabase: false })
    }
    this.attachData(config)
    const cred = this.takeCredential()
    if (cred) {
      await this.signInData(cred.email, cred.password)
      await this.adoptVault(cred.password)
    }
    return this.deps.auth.state()
  }

  /**
   * 비밀번호를 잊었을 때: 이 PC 에 살아 있는 데이터 세션으로 새 비밀번호를 정하고, 그 비밀번호로 디렉터리에 로그인한다.
   * 디렉터리와 데이터가 같은 프로젝트일 때 통한다(다르면 디렉터리 로그인은 실패하고 그 사유를 돌려준다)
   */
  async resetPasswordWithSession(email: string, password: string): Promise<AuthState> {
    const data = this.deps.auth.state()
    const backend = this.deps.auth.currentBackend()
    if (!data.signedIn || !data.email || !backend) throw new Error('no-session')
    // 이메일을 직접 쳐서 세션 주인과 같아야 한다 — 화면에는 세션 이메일을 보여 주지 않는다
    if (email.trim().toLowerCase() !== data.email.trim().toLowerCase())
      throw new Error('Invalid login credentials')
    if (password.length < 8) throw new Error('weak password')
    await backend.updatePassword(password)
    return this.signIn(data.email, password)
  }

  async signOut(): Promise<AuthState> {
    this.pendingCredential = null
    this.accountPassword = null
    const state = await this.deps.auth.signOut()
    const dir = this.directory()
    if (dir) {
      try {
        await dir.auth.signOut()
      } catch (e: unknown) {
        console.warn('디렉터리 로그아웃 실패', e instanceof Error ? e.message : String(e))
      }
      this.next({ configured: true, signedIn: false, needsSupabase: false })
    }
    return state
  }

  // --- 내부 -----------------------------------------------------------------

  private directory(): { backend: SyncBackend; auth: AuthService } | null {
    const { directory, directoryAuth } = this.deps
    return directory && directoryAuth ? { backend: directory, auth: directoryAuth } : null
  }

  private async enter(
    email: string,
    password: string,
    mode: 'signIn' | 'signUp'
  ): Promise<AuthState> {
    const dir = this.directory()
    if (!dir) {
      const state =
        mode === 'signIn'
          ? await this.deps.auth.signIn(email, password)
          : await this.deps.auth.signUp(email, password)
      // 디렉터리 없는 빌드도 계정 비밀번호가 키마스터 열쇠다
      await this.adoptVault(password)
      return state
    }
    if (mode === 'signIn') await dir.auth.signIn(email, password)
    else await dir.auth.signUp(email, password)
    const user = await dir.backend.currentUser()
    if (!user) return this.deps.auth.state()
    const config = await this.afterDirectorySignIn(user)
    if (!config) {
      // 주소를 넣을 때까지 같은 자격으로 데이터 프로젝트에 붙일 수 있게 잠깐 들고 있는다
      this.pendingCredential = {
        email,
        password,
        expiresAt: (this.deps.now ?? Date.now)() + (this.deps.credentialTtlMs ?? CREDENTIAL_TTL_MS)
      }
      return this.deps.auth.state()
    }
    if (!this.deps.auth.state().signedIn) await this.signInData(email, password)
    await this.adoptVault(password)
    return this.deps.auth.state()
  }

  /** 데이터 프로젝트에 로그인된 뒤 이 PC 키마스터를 계정 비밀번호에 맞춘다. 실패해도 로그인은 그대로 둔다 */
  private async adoptVault(password: string): Promise<void> {
    this.accountPassword = password
    if (!this.deps.vault || !this.deps.auth.state().signedIn) return
    try {
      const r = await this.deps.vault.adoptAccountPassword(password)
      if (r === 'needs-old-master' || r === 'failed')
        console.warn('키마스터 계정 비밀번호 맞추기', r)
    } catch (e: unknown) {
      console.warn('키마스터 계정 비밀번호 맞추기 실패', e instanceof Error ? e.message : String(e))
    }
  }

  /** 동기화가 "서버 키 재료가 다르다"고 알릴 때 — 비밀번호를 아는 동안은 자동으로 맞춘다 */
  async onVaultKeyMismatch(): Promise<void> {
    if (this.accountPassword === null) return
    await this.adoptVault(this.accountPassword)
  }

  /** 디렉터리 로그인 뒤 공통: 주소를 읽어 상태를 올리고, 있으면 데이터 백엔드를 붙인다 */
  private async afterDirectorySignIn(user: {
    userId: string
    email: string
  }): Promise<DirectoryConfig | null> {
    const dir = this.directory()
    if (!dir) return null
    let config = await readDirectoryConfig(dir.backend, user.userId)
    if (!config) {
      // 계정에는 아직 없는데 이 PC 설정에 주소가 있으면(로그인 기능 전부터 쓰던 PC) 계정에 올려 둔다 —
      // 그래야 다른 PC 가 로그인만으로 따라온다. 사용자가 폼을 다시 채울 필요가 없다
      const local = this.deps.settings.get()
      if (
        isSupabaseProjectUrl(local.syncSupabaseUrl) &&
        isSupabaseAnonKey(local.syncSupabaseAnonKey)
      ) {
        config = { url: local.syncSupabaseUrl.trim(), anonKey: local.syncSupabaseAnonKey.trim() }
        try {
          await writeDirectoryConfig(dir.backend, user.userId, config, this.deps.now?.())
        } catch (e: unknown) {
          console.warn(
            '계정에 Supabase 주소 올리기 실패',
            e instanceof Error ? e.message : String(e)
          )
          config = null
        }
      }
    }
    // 관리자에게만 숫자가 온다(서버 함수가 이메일을 검사). 그 외·함수 없음은 null
    const userCount = await dir.backend.rpcNumber(USER_COUNT_RPC).catch(() => null)
    this.next({
      configured: true,
      signedIn: true,
      email: user.email,
      userId: user.userId,
      needsSupabase: !config,
      ...(userCount === null ? {} : { userCount })
    })
    if (config) {
      this.attachData(config)
      await this.reuseDirectorySession(config)
    }
    return config
  }

  /**
   * 디렉터리와 데이터가 같은 프로젝트면 디렉터리 세션 토큰을 데이터 클라이언트에 심어 로그인을 한 번으로 끝낸다
   * (비밀번호를 바꿔 데이터 세션이 끊긴 뒤 앱을 다시 켰을 때 두 번 로그인시키지 않게). 실패해도 조용히 넘긴다
   */
  private async reuseDirectorySession(config: DirectoryConfig): Promise<void> {
    const dir = this.directory()
    const data = this.deps.auth.currentBackend()
    if (!dir || !data) return
    if (this.deps.directoryUrl === undefined || this.deps.directoryUrl.trim() !== config.url.trim())
      return
    if (this.deps.auth.state().signedIn) return
    try {
      const session = await dir.backend.exportSession()
      if (!session) return
      await data.importSession(session)
      await this.deps.auth.restore()
    } catch (e: unknown) {
      console.warn('디렉터리 세션 재사용 실패', e instanceof Error ? e.message : String(e))
    }
  }

  /** 데이터 프로젝트 로그인. 계정이 없으면 가입한다(같은 이메일·비밀번호) */
  private async signInData(email: string, password: string): Promise<void> {
    try {
      await this.deps.auth.signIn(email, password)
    } catch (e: unknown) {
      const message = (e instanceof Error ? e.message : String(e)).toLowerCase()
      if (!message.includes('invalid login credentials')) throw e
      await this.deps.auth.signUp(email, password)
    }
  }

  /** 주소로 데이터 백엔드를 만들어 인증·동기화에 끼운다. 같은 주소면 그대로 둔다 */
  private attachData(config: DirectoryConfig): void {
    const current = this.deps.settings.get()
    if (current.syncSupabaseUrl !== config.url || current.syncSupabaseAnonKey !== config.anonKey) {
      this.deps.settings.set({ syncSupabaseUrl: config.url, syncSupabaseAnonKey: config.anonKey })
    }
    this.deps.applyEnv(config.url, config.anonKey)
    if (this.currentUrl === config.url && this.deps.auth.hasBackend()) return
    // 설정에 이미 같은 주소가 있고 백엔드가 떠 있으면 그 프로젝트다 — 세션을 살려 둔 채 그대로 쓴다
    // (앱 시작 때 복구된 데이터 세션을 디렉터리 로그인이 도로 끊고 다시 로그인시키지 않게)
    if (
      current.syncSupabaseUrl === config.url &&
      current.syncSupabaseAnonKey === config.anonKey &&
      this.deps.auth.hasBackend()
    ) {
      this.currentUrl = config.url
      return
    }
    this.currentUrl = config.url
    const backend = this.deps.createDataBackend(config)
    this.deps.auth.setBackend(backend)
    this.deps.onDataBackend(backend)
  }

  private takeCredential(): { email: string; password: string } | null {
    const cred = this.pendingCredential
    this.pendingCredential = null
    if (!cred) return null
    if ((this.deps.now ?? Date.now)() > cred.expiresAt) return null
    return { email: cred.email, password: cred.password }
  }

  private next(state: AccountState): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return
    this.state = state
    for (const fn of this.listeners) {
      try {
        fn(this.accountState())
      } catch (e: unknown) {
        console.error('계정 상태 통지 실패', e instanceof Error ? e.message : String(e))
      }
    }
  }
}
