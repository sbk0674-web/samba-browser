// 동기화 백엔드 인터페이스 — 테스트 경계. 여기 위로는 supabase-js 를 모른다.
// 테스트는 tests/stubs/fake-backend.ts 의 가짜 구현만 쓴다(네트워크 없음)

/** 원격 테이블의 한 행. 컬럼 구성은 테이블마다 다르므로 열린 형태로 둔다 */
export interface RemoteRow {
  id: string
  [column: string]: unknown
}

/**
 * 복합 PK 표(settings_sync = user_id + workspace_id + key)의 한 행.
 * id 컬럼이 아예 없으므로 RemoteRow 를 쓸 수 없다
 */
export interface RemoteKeyedRow {
  [column: string]: unknown
}

/**
 * 풀 커서 — (updated_at, id) 복합.
 * updated_at 만으로는 같은 시각을 가진 행이 페이지 경계를 넘을 때 나머지를 영영 못 받는다
 * (gt 커서가 그 시각 전체를 건너뛴다). id 를 동률 판정에 함께 쓴다.
 * id 가 null 이면 동률 판정이 없다 — 커서에 id 가 없던 옛 DB(숫자 커서)의 뜻 그대로 읽는다
 */
export interface PullCursor {
  ts: number
  id: string | null
}

/** 옛 호출부(숫자 커서)도 그대로 받는다 */
export type PullCursorInput = PullCursor | number

/** 숫자 커서를 복합 커서로 올린다. 동률 판정이 없으므로 id 는 null */
export function toPullCursor(input: PullCursorInput): PullCursor {
  return typeof input === 'number' ? { ts: input, id: null } : input
}

/** 커서보다 뒤에 있는 행인가. 정렬 (updated_at asc, id asc) 과 같은 기준이다 */
export function isAfterCursor(ts: number, id: string, cursor: PullCursor): boolean {
  if (ts > cursor.ts) return true
  return cursor.id !== null && ts === cursor.ts && id > cursor.id
}

/**
 * 서버에 거는 **넓은** 조건 — 커서 시각 이상인가.
 *
 * 로컬 커서는 ms 이고 서버의 timestamptz 는 µs 다. 커서를 만든 행의 실제 값이
 * 12:00:00.123456 이어도 커서에는 …123 만 남아, `updated_at > …123.000` 같은 좁은 조건을
 * 걸면 µs 자리를 가진 같은 ms 의 행이 조건 밖으로 새어 나갈 수 있다.
 * 그래서 서버에는 `>=` 로 넓게 걸어 **받고**, 실제 통과 여부는 받은 뒤 (ts, id) 로 거른다
 * (isAfterCursor). 가짜 백엔드도 같은 순서를 쓴다
 */
export function isAtOrAfterCursor(ts: number, cursor: PullCursor): boolean {
  return ts >= cursor.ts
}

/** 한 번에 받아 올 최대 행 수의 기본값(supabase 기본 상한과 같다) */
export const DEFAULT_SELECT_LIMIT = 1000

export interface SyncBackend {
  signUp(email: string, password: string): Promise<{ userId: string; email: string }>
  signIn(email: string, password: string): Promise<{ userId: string; email: string }>
  /** 구글 로그인용 주소를 만든다(브라우저는 호출부가 연다) */
  oauthUrl(redirectTo: string): Promise<string>
  /** 딥링크로 돌아온 인증 코드를 세션으로 바꾼다 */
  exchangeCode(code: string): Promise<{ userId: string; email: string }>
  signOut(): Promise<void>
  /** 서버를 부르지 않고 이 PC 에 저장된 세션(refresh token)만 지운다 — 토큰 만료·원격 취소용 */
  clearLocalSession(): Promise<void>
  currentUser(): Promise<{ userId: string; email: string } | null>
  /** 지금 로그인된 사용자의 비밀번호를 바꾼다(살아 있는 세션 필요). 메일 없이 이 PC 에서 재설정하는 길 */
  updatePassword(password: string): Promise<void>
  /**
   * 세션 토큰을 꺼내고(없으면 null) 다른 클라이언트에 심는다 — **같은 프로젝트**의 클라이언트끼리만 유효하다.
   * 디렉터리와 데이터가 같은 프로젝트일 때 로그인을 두 번 시키지 않으려고 쓴다. 값은 메모리에서만 오간다
   */
  exportSession(): Promise<{ accessToken: string; refreshToken: string } | null>
  importSession(session: { accessToken: string; refreshToken: string }): Promise<void>
  /**
   * 커서보다 뒤에 있는 행을 (updated_at asc, id asc) 순으로 최대 limit 행 준다.
   * workspaceId 를 주면 그 작업공간의 행만 받는다 — 다른 작업공간 행까지 내려받아 봐야
   * 로컬에서는 보이지 않고, 커서만 앞으로 밀어 버린다.
   * 받은 행이 limit 과 같으면 뒤에 더 있다는 뜻이다(호출부가 커서를 옮겨 한 번 더 부른다)
   */
  select(
    table: string,
    cursor: PullCursorInput,
    workspaceId?: string,
    limit?: number
  ): Promise<RemoteRow[]>
  /**
   * 표의 행을 전부 준다. updated_at 컬럼이 없는 표(devices)용이다 —
   * 커서로 걸러 낼 수 없고 행 수도 기기 수만큼이라 통째로 읽는다
   */
  selectAll(table: string): Promise<RemoteRow[]>
  /**
   * 작업공간의 삭제 표식(deleted_at 이 있는 행)만 준다. columns 로 받을 컬럼을 좁힌다(예: 'id,host,username,updated_at,deleted_at').
   * 최초 업로드 직전에 "같은 자연 키가 이미 서버에서 지워졌는가" 를 보는 데 쓴다 —
   * 옛 사본이 지운 계정을 새 원격 id 로 다시 올려 되살리는 것을 막는다
   */
  selectDeleted(table: string, workspaceId: string, columns: string): Promise<RemoteRow[]>
  upsert(table: string, rows: RemoteRow[]): Promise<void>
  remove(table: string, ids: string[]): Promise<void>
  /**
   * 복합 PK 표(settings_sync)에서 읽는다. workspaceId 를 주면 그 작업공간의 행만 받는다.
   * 이 표에는 id 컬럼이 없어 동률 판정에 key 컬럼을 쓴다 — 정렬도 (updated_at asc, key asc)
   */
  selectKeyed(
    table: string,
    cursor: PullCursorInput,
    workspaceId?: string,
    limit?: number
  ): Promise<RemoteKeyedRow[]>
  /** 복합 PK 표(settings_sync)에 올린다. 충돌 해결은 서버의 기본키를 따른다 */
  upsertKeyed(table: string, rows: RemoteKeyedRow[]): Promise<void>
  /**
   * 변경 알림 구독. 반환값을 호출하면 구독을 푼다.
   * onStatus 는 구독이 살아 있는지(true = 변경이 실시간으로 온다) 바뀔 때 불린다 — 엔진이 이걸 보고 폴링을 멈춘다
   */
  subscribe(
    table: string,
    onChange: () => void,
    onStatus?: (live: boolean) => void
  ): Promise<() => void>
  /**
   * 숫자 하나를 돌려주는 서버 함수(rpc). 함수가 없거나 권한이 없으면 null —
   * 디렉터리의 가입 사용자 수처럼 "있으면 보여 주는" 값에 쓴다
   */
  rpcNumber(name: string): Promise<number | null>
}

/** 토큰 만료·기기 원격 로그아웃 — 호출부는 이 에러를 받으면 로그아웃하고 금고를 잠근다 */
export class AuthExpiredError extends Error {}
