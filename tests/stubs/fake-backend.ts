// 메모리 테이블 기반 가짜 SyncBackend. 이후 모든 sync 테스트는 이것만 쓴다(네트워크 없음)
import {
  AuthExpiredError,
  DEFAULT_SELECT_LIMIT,
  isAfterCursor,
  isAtOrAfterCursor,
  toPullCursor,
  type RemoteKeyedRow,
  type RemoteRow,
  type SyncBackend
} from '../../src/main/sync/backend'

export interface FakeBackend extends SyncBackend {
  /** 테이블 내용을 직접 들여다본다(단언용) */
  rows(table: string): RemoteRow[]
  /** 복합 PK 표(settings_sync)의 내용을 들여다본다 */
  keyedRows(table: string): RemoteKeyedRow[]
  /** 서버에 미리 행을 심는다(풀 테스트용) */
  seed(table: string, rows: RemoteRow[]): void
  /** 복합 PK 표에 미리 행을 심는다 */
  seedKeyed(table: string, rows: RemoteKeyedRow[]): void
  /** 다음 호출부터 이 에러로 실패시킨다(오프라인 재현). null 을 주면 정상으로 되돌린다 */
  failWith(error: Error | null): void
  /** subscribe 로 등록한 콜백을 수동으로 발화한다 */
  fire(table: string): void
  /** 다음 호출부터 인증 만료로 실패시킨다(기기 원격 로그아웃 재현) */
  expireAuth(): void
  /** 호출 횟수 기록 */
  readonly calls: { select: number; upsert: number; remove: number }
}

export const FAKE_USER_ID = '00000000-0000-4000-8000-000000000001'

function updatedAtMs(row: Record<string, unknown>): number {
  const v = row.updated_at
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? 0 : t
  }
  return 0
}

/** 정렬 기준 — 서버와 같아야 한다: (updated_at asc, id asc) */
function byUpdatedAtThenId(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  idOf: (row: Record<string, unknown>) => string
): number {
  const diff = updatedAtMs(a) - updatedAtMs(b)
  if (diff !== 0) return diff
  return idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0
}

export function createFakeBackend(): FakeBackend {
  const tables = new Map<string, Map<string, RemoteRow>>()
  const keyedTables = new Map<string, Map<string, RemoteKeyedRow>>()
  const listeners = new Map<string, Set<() => void>>()
  const calls = { select: 0, upsert: 0, remove: 0 }
  let signedIn: { userId: string; email: string } | null = null
  let authExpired = false
  let failure: Error | null = null

  const table = (name: string): Map<string, RemoteRow> => {
    let t = tables.get(name)
    if (!t) {
      t = new Map()
      tables.set(name, t)
    }
    return t
  }

  const keyedTable = (name: string): Map<string, RemoteKeyedRow> => {
    let t = keyedTables.get(name)
    if (!t) {
      t = new Map()
      keyedTables.set(name, t)
    }
    return t
  }

  // 복합 PK(user_id, workspace_id, key)를 한 문자열로 눌러 맵 키로 쓴다
  const keyOf = (row: RemoteKeyedRow): string =>
    `${String(row.user_id)}|${String(row.workspace_id)}|${String(row.key)}`

  const guard = (): void => {
    if (authExpired) throw new AuthExpiredError('JWT expired')
    if (failure) throw failure
  }

  return {
    async signUp(email) {
      signedIn = { userId: FAKE_USER_ID, email }
      return signedIn
    },
    async signIn(email) {
      signedIn = { userId: FAKE_USER_ID, email }
      return signedIn
    },
    async oauthUrl(redirectTo) {
      return `https://fake.supabase.co/auth/v1/authorize?redirect_to=${encodeURIComponent(redirectTo)}`
    },
    async exchangeCode(code) {
      if (!code) throw new Error('인증 코드가 없습니다')
      signedIn = { userId: FAKE_USER_ID, email: 'fake@example.com' }
      return signedIn
    },
    async signOut() {
      signedIn = null
    },
    async clearLocalSession() {
      signedIn = null
    },
    async updatePassword() {
      if (!signedIn) throw new Error('not signed in')
    },
    async exportSession() {
      return signedIn ? { accessToken: `at:${signedIn.email}`, refreshToken: 'rt' } : null
    },
    async importSession(session) {
      const email = session.accessToken.replace(/^at:/, '')
      signedIn = { userId: FAKE_USER_ID, email }
    },
    async currentUser() {
      return signedIn
    },
    async select(name, cursor, workspaceId, limit) {
      guard()
      calls.select += 1
      const c = toPullCursor(cursor)
      const idOf = (r: Record<string, unknown>): string => String(r.id)
      return (
        [...table(name).values()]
          // 서버와 같은 순서 — 먼저 넓게(>= ts) 고르고, 그 뒤 (ts, id) 로 정확히 거른다
          .filter((r) => isAtOrAfterCursor(updatedAtMs(r), c))
          .filter((r) => isAfterCursor(updatedAtMs(r), idOf(r), c))
          .filter((r) => workspaceId === undefined || r.workspace_id === workspaceId)
          .sort((a, b) => byUpdatedAtThenId(a, b, idOf))
          .slice(0, limit ?? DEFAULT_SELECT_LIMIT)
          .map((r) => ({ ...r }))
      )
    },
    async selectDeleted(name, workspaceId, columns) {
      guard()
      calls.select += 1
      const wanted = columns.split(',').map((c) => c.trim())
      return [...table(name).values()]
        .filter((r) => r.workspace_id === workspaceId)
        .filter((r) => r.deleted_at !== null && r.deleted_at !== undefined)
        .map((r) => {
          const picked: RemoteRow = { id: r.id }
          for (const c of wanted) picked[c] = r[c]
          return picked
        })
    },
    async selectAll(name) {
      guard()
      calls.select += 1
      return [...table(name).values()].map((r) => ({ ...r }))
    },
    async upsert(name, rows) {
      guard()
      calls.upsert += 1
      const t = table(name)
      // id 기준으로 통째로 덮어쓴다
      for (const row of rows) t.set(row.id, { ...row })
    },
    async selectKeyed(name, cursor, workspaceId, limit) {
      guard()
      calls.select += 1
      const c = toPullCursor(cursor)
      // 이 표에는 id 컬럼이 없다 — 동률 판정·정렬에 key 를 쓴다
      const idOf = (r: Record<string, unknown>): string => String(r.key)
      return [...keyedTable(name).values()]
        .filter((r) => isAtOrAfterCursor(updatedAtMs(r), c))
        .filter((r) => isAfterCursor(updatedAtMs(r), idOf(r), c))
        .filter((r) => workspaceId === undefined || r.workspace_id === workspaceId)
        .sort((a, b) => byUpdatedAtThenId(a, b, idOf))
        .slice(0, limit ?? DEFAULT_SELECT_LIMIT)
        .map((r) => ({ ...r }))
    },
    async upsertKeyed(name, rows) {
      guard()
      calls.upsert += 1
      const t = keyedTable(name)
      for (const row of rows) t.set(keyOf(row), { ...row })
    },
    async remove(name, ids) {
      guard()
      calls.remove += 1
      const t = table(name)
      for (const id of ids) t.delete(id)
    },
    async rpcNumber() {
      return null
    },
    async subscribe(name, onChange) {
      let set = listeners.get(name)
      if (!set) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(onChange)
      return () => {
        set!.delete(onChange)
      }
    },
    rows(name) {
      return [...table(name).values()].map((r) => ({ ...r }))
    },
    keyedRows(name) {
      return [...keyedTable(name).values()].map((r) => ({ ...r }))
    },
    seed(name, rows) {
      const t = table(name)
      for (const row of rows) t.set(row.id, { ...row })
    },
    seedKeyed(name, rows) {
      const t = keyedTable(name)
      for (const row of rows) t.set(keyOf(row), { ...row })
    },
    failWith(error) {
      failure = error
    },
    fire(name) {
      for (const fn of listeners.get(name) ?? []) fn()
    },
    expireAuth() {
      authExpired = true
    },
    calls
  }
}
