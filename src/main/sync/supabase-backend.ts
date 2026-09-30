// SyncBackend 의 supabase-js 구현. 앱은 anon 키 + 사용자 JWT 로만 접근한다
// (서비스 롤 키는 어디에도 두지 않는다)

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  AuthExpiredError,
  DEFAULT_SELECT_LIMIT,
  isAfterCursor,
  toPullCursor,
  type PullCursor,
  type RemoteKeyedRow,
  type RemoteRow,
  type SyncBackend
} from './backend'
import type { SessionStorageAdapter } from './session-store'
import { readSupabaseEnv, type SupabaseEnv } from './env'
import { tr } from '../i18n'

// 삭제 표식을 받을 때 넘길 최대 페이지 수(페이지당 DEFAULT_SELECT_LIMIT 행)
const DELETED_MAX_PAGES = 50

// 인증 만료로 볼 응답 코드/문구
const AUTH_EXPIRED = ['PGRST301', '401', 'jwt expired', 'invalid refresh token']

/** PostgREST 의 or 필터 값에 그대로 넣을 수 있게 감싼다(쉼표·괄호가 섞여도 안전하다) */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 키셋 조건. updated_at 만 보면 같은 시각을 가진 행이 페이지 경계를 넘을 때 나머지를 잃는다.
 * id 가 null 인 커서(옛 숫자 커서)는 동률 판정 없이 시각만 본다.
 *
 * 서버에는 일부러 **넓게** 건다(`>=`) — 로컬 커서는 ms, 서버 timestamptz 는 µs 라
 * 좁은 조건은 같은 ms 안의 µs 행을 놓칠 수 있다. 정확한 통과 판정은 받은 뒤
 * isAfterCursor (ts, id) 로 한다.
 * 타임스탬프·id 는 모두 quote() 로 감싼다 — 인용하지 않으면 PostgREST 가 `:`·`+` 를
 * 필터 문법으로 읽어 조건이 통째로 깨진다.
 *
 * 필터 빌더 타입을 직접 들고 오지 않으려고 필요한 메서드만 구조로 요구한다
 */
export function cursorFilter(cursor: PullCursor, idColumn: string): string {
  const iso = new Date(cursor.ts).toISOString()
  if (cursor.id === null) return `updated_at.gte.${quote(iso)}`
  return `updated_at.gt.${quote(iso)},and(updated_at.gte.${quote(iso)},${idColumn}.gt.${quote(cursor.id)})`
}

function whereAfterCursor<Q extends { or(filter: string): Q }>(
  query: Q,
  cursor: PullCursor,
  idColumn: string
): Q {
  return query.or(cursorFilter(cursor, idColumn))
}

/** 서버가 넓게 준 행에서 커서를 실제로 넘어선 것만 남긴다(µs 안전) */
function afterCursorOnly<T extends Record<string, unknown>>(
  rows: T[],
  cursor: PullCursor,
  idOf: (row: T) => string
): T[] {
  return rows.filter((row) => {
    const at = row.updated_at
    const ts = typeof at === 'string' ? Date.parse(at) : typeof at === 'number' ? at : NaN
    // 시각을 읽지 못한 행은 버리지 않는다 — 버리면 영영 내려오지 않는다
    if (Number.isNaN(ts)) return true
    return isAfterCursor(ts, idOf(row), cursor)
  })
}

function raise(message: string): never {
  const m = message.toLowerCase()
  if (AUTH_EXPIRED.some((p) => m.includes(p.toLowerCase()))) throw new AuthExpiredError(message)
  throw new Error(message)
}

export function createSupabaseBackend(
  storage: SessionStorageAdapter,
  // 주소를 직접 주면 그 프로젝트로 붙는다(디렉터리·계정에서 내려받은 주소). 생략하면 설정/.env
  env: SupabaseEnv = readSupabaseEnv()
): SyncBackend {
  const client: SupabaseClient = createClient(env.url, env.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // 데스크톱 앱은 URL 해시가 없다. 코드 교환은 우리가 직접 한다
      detectSessionInUrl: false,
      flowType: 'pkce',
      storage
    }
  })

  const identity = (
    user: { id: string; email?: string } | null
  ): { userId: string; email: string } => {
    if (!user) raise(tr('auth.userMissing'))
    return { userId: user.id, email: user.email ?? '' }
  }

  return {
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password })
      if (error) raise(error.message)
      return identity(data.user)
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      if (error) raise(error.message)
      return identity(data.user)
    },
    async oauthUrl(redirectTo) {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true }
      })
      if (error) raise(error.message)
      if (!data.url) raise(tr('auth.googleUrlMissing'))
      return data.url
    },
    async exchangeCode(code) {
      const { data, error } = await client.auth.exchangeCodeForSession(code)
      if (error) raise(error.message)
      return identity(data.user)
    },
    async signOut() {
      await client.auth.signOut()
    },
    async clearLocalSession() {
      // scope: 'local' 은 서버 세션은 두고 이 클라이언트 저장소만 비운다
      await client.auth.signOut({ scope: 'local' })
    },
    async exportSession() {
      const { data } = await client.auth.getSession()
      const s = data.session
      return s ? { accessToken: s.access_token, refreshToken: s.refresh_token } : null
    },
    async importSession(session) {
      const { error } = await client.auth.setSession({
        access_token: session.accessToken,
        refresh_token: session.refreshToken
      })
      if (error) raise(error.message)
    },
    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password })
      if (error) raise(error.message)
    },
    async currentUser() {
      const { data } = await client.auth.getUser()
      return data.user ? { userId: data.user.id, email: data.user.email ?? '' } : null
    },
    async select(table, cursor, workspaceId, limit) {
      const c = toPullCursor(cursor)
      let query = whereAfterCursor(client.from(table).select('*'), c, 'id')
      // 활성 작업공간의 행만 받는다(다른 작업공간 행은 로컬에서 보이지도 않는다)
      if (workspaceId !== undefined) query = query.eq('workspace_id', workspaceId)
      const { data, error } = await query
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit ?? DEFAULT_SELECT_LIMIT)
      if (error) raise(error.message)
      return afterCursorOnly((data ?? []) as RemoteRow[], c, (r) => String(r.id))
    },
    async selectAll(table) {
      const { data, error } = await client.from(table).select('*')
      if (error) raise(error.message)
      return (data ?? []) as RemoteRow[]
    },
    async selectDeleted(table, workspaceId, columns) {
      // 삭제 표식은 수천 행일 수 있다 — id 순으로 페이지를 넘기며 모두 받는다(상한을 두어 무한정 돌지 않는다)
      const out: RemoteRow[] = []
      for (let page = 0; page < DELETED_MAX_PAGES; page += 1) {
        const from = page * DEFAULT_SELECT_LIMIT
        const { data, error } = await client
          .from(table)
          .select(columns)
          .eq('workspace_id', workspaceId)
          .not('deleted_at', 'is', null)
          .order('id', { ascending: true })
          .range(from, from + DEFAULT_SELECT_LIMIT - 1)
        if (error) raise(error.message)
        const rows = (data ?? []) as unknown as RemoteRow[]
        out.push(...rows)
        if (rows.length < DEFAULT_SELECT_LIMIT) break
      }
      return out
    },
    async upsert(table, rows) {
      if (rows.length === 0) return
      const { error } = await client.from(table).upsert(rows)
      if (error) raise(error.message)
    },
    async selectKeyed(table, cursor, workspaceId, limit) {
      // 복합 PK 라 id 컬럼이 없다 — 동률 판정·정렬을 key 로 한다
      const c = toPullCursor(cursor)
      let query = whereAfterCursor(client.from(table).select('*'), c, 'key')
      if (workspaceId !== undefined) query = query.eq('workspace_id', workspaceId)
      const { data, error } = await query
        .order('updated_at', { ascending: true })
        .order('key', { ascending: true })
        .limit(limit ?? DEFAULT_SELECT_LIMIT)
      if (error) raise(error.message)
      return afterCursorOnly((data ?? []) as RemoteKeyedRow[], c, (r) => String(r.key))
    },
    async upsertKeyed(table, rows) {
      if (rows.length === 0) return
      // PostgREST 는 표의 기본키로 충돌을 해결한다 — settings_sync 는 (user_id, workspace_id, key)
      const { error } = await client.from(table).upsert(rows)
      if (error) raise(error.message)
    },
    async remove(table, ids) {
      if (ids.length === 0) return
      const { error } = await client.from(table).delete().in('id', ids)
      if (error) raise(error.message)
    },
    async rpcNumber(name) {
      const { data, error } = await client.rpc(name)
      if (error) return null
      return typeof data === 'number' ? data : null
    },
    async subscribe(table, onChange) {
      // Realtime 은 "있으면 좋은" 기능이다. 실패해도 폴링으로 계속 동작해야 한다
      try {
        const channel = client
          .channel(`samba-${table}`)
          .on('postgres_changes', { event: '*', schema: 'public', table }, () => onChange())
          .subscribe()
        return () => {
          void client.removeChannel(channel)
        }
      } catch (e: unknown) {
        console.warn(
          'Realtime 구독 실패(폴링으로 계속)',
          e instanceof Error ? e.message : String(e)
        )
        return () => {}
      }
    }
  }
}
