// 최초 업로드(backfill) — 로그인 전부터 로컬에 있던 데이터를 변경 로그에 한 번 얹는다.
//
// 변경 로그(sync_outbox)는 **로그인 뒤의 쓰기**에만 남는다. 그래서 로그인 전에 쌓아 둔
// 계정·금고 항목·북마크·채팅은 서버로 한 번도 올라가지 않았고, 두 번째 PC 는 아무것도
// 받지 못했다. 여기서 활성 작업공간 범위의 살아 있는 행을 전부 훑어 'upsert' 로 기록한다.
//
// 기준은 "원격 id 가 아직 없다" 이다 — 한 번이라도 올라간 행(remote_id 가 있거나 풀로
// 내려온 행)은 건드리지 않는다.
//
// **설정은 여기서 다루지 않는다**(3차 리뷰 C1). 설정 행에는 원격 id 가 없어 "올라간 적
// 있는가" 를 행만 보고 판단할 수 없고, 로그인 직후 지금 시각으로 올려 버리면 두 번째 PC 의
// 첫 로그인이 첫 PC 의 설정을 기본값으로 덮어쓴다. 설정은 backfillSettings 가
// **풀을 한 번 돌린 뒤** 서버에 없던 키만 올린다.
//
// 값(평문)은 여기서도 만지지 않는다 — 어떤 행을 올릴지만 적어 두고, 실제 전송은 push 가 한다.
// 금고가 잠겨 있어도 기록만 해 두면 된다(push 가 vault_items 를 'skip' 으로 보류했다가
// 잠금 해제 뒤 다음 주기에 올린다).

import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import { accounts, bookmarks, chatMessages, chats, syncOutbox, vaultItems } from '../db/schema'
import { SYNCED_SETTING_KEYS, VAULT_KEY_SYNC_KEYS, type SyncTable } from '../../shared/sync'
import { SyncLocal } from './local'
import { settingUpdatedAtKey } from './outbox'
import type { WorkspaceRef } from './push'
import { DEFAULT_WORKSPACE_REMOTE_ID } from './workspace-id'

/** 한 번에 넣을 변경 로그 행 수. sql.js 라 한 문장이 너무 길어지지 않게 끊는다 */
const INSERT_CHUNK = 500

/** 최초 업로드가 훑는 표 — 원격 id 로 "올라간 적 있는가" 를 판단할 수 있는 표만 */
type RowTable = 'accounts' | 'vault_items' | 'bookmarks' | 'chats' | 'chat_messages'

const ROW_TABLES: RowTable[] = ['accounts', 'vault_items', 'bookmarks', 'chats', 'chat_messages']

/** 이 작업공간의 최초 업로드가 끝났음을 적어 두는 sync_state 키 */
export function backfillStateKey(workspaceLocalId: number): string {
  return `backfillDone:${workspaceLocalId}`
}

/** 설정 최초 업로드(풀 이후 1회)가 끝났음을 적어 두는 sync_state 키 */
export function settingsBackfillStateKey(workspaceLocalId: number): string {
  return `settingsBackfillDone:${workspaceLocalId}`
}

/** 금고 키 재료를 읽을 수 있는 최소 인터페이스. VaultService 가 그대로 만족한다 */
export interface BackfillVault {
  readKeyMaterial?: (key: (typeof VAULT_KEY_SYNC_KEYS)[number]) => string | null
}

export interface BackfillResult {
  accounts: number
  vaultItems: number
  bookmarks: number
  chats: number
  chatMessages: number
  settings: number
  /** 플래그가 이미 있어 아무것도 훑지 않았다 */
  skipped: boolean
}

function emptyResult(skipped: boolean): BackfillResult {
  return {
    accounts: 0,
    vaultItems: 0,
    bookmarks: 0,
    chats: 0,
    chatMessages: 0,
    settings: 0,
    skipped
  }
}

/** 이 최초 업로드가 실제로 올린 행 수의 합 */
export function backfillTotal(result: BackfillResult): number {
  return (
    result.accounts +
    result.vaultItems +
    result.bookmarks +
    result.chats +
    result.chatMessages +
    result.settings
  )
}

/**
 * 최초 1회 업로드. 이 작업공간에 대해 이미 끝냈으면 아무것도 하지 않는다.
 * 작업공간마다 플래그가 따로라, 작업공간을 새로 붙여도 그 작업공간에 대해 한 번 더 돈다
 */
export function backfillOutbox(
  db: Db,
  workspace: WorkspaceRef,
  _vault?: BackfillVault
): BackfillResult {
  if (db.isClosed) return emptyResult(true)
  const local = new SyncLocal(db)
  if (local.getState(backfillStateKey(workspace.localId)) !== null) return emptyResult(true)
  return run(db, local, workspace)
}

/**
 * 수동 "지금 동기화" 가 부르는 재검사. 플래그가 있어도 한 번 더 훑어,
 * 최초 업로드 뒤에 생겼는데 변경 로그를 놓친 행(예: 훅이 붙기 전 가져오기)을 보충한다.
 * 원격 id 가 이미 있는 행은 비교 대상이 아니라, 올라간 것을 다시 올리지는 않는다
 */
export function verifyBackfill(
  db: Db,
  workspace: WorkspaceRef,
  _vault?: BackfillVault
): BackfillResult {
  if (db.isClosed) return emptyResult(true)
  return run(db, new SyncLocal(db), workspace)
}

/**
 * 설정 최초 업로드 — **풀을 한 번 돌린 뒤에** 부른다.
 *
 * 풀이 서버에 있던 설정을 내려받으면 그 키에는 `settings:<key>:updatedAt` 이 찍힌다.
 * 그러니 이 시점에 그 값이 없는 키 = "서버에 아직 없는 키" 다. 그것만 올린다.
 * 이렇게 해야 두 번째 PC 의 첫 로그인이 첫 PC 의 설정을 자기 기본값으로 덮지 않는다(C1)
 */
export function backfillSettings(
  db: Db,
  workspace: WorkspaceRef,
  vault?: BackfillVault,
  // 키 재료 불일치 주기에는 로컬 salt/verifier 를 올리면 첫 PC 의 금고를 다른 PC 에서 못 열게 된다(4차 리뷰 N1)
  options: { skipKeyMaterial?: boolean } = {}
): BackfillResult {
  const result = emptyResult(false)
  if (db.isClosed) return emptyResult(true)
  const local = new SyncLocal(db)
  // '끝남' 표식이 있어도 키별로 다시 본다 — 뒤늦게 동기화 대상이 된 키(화면 배치·폰 연동)는 수정 시각 기록이
  // 없어서, 통째로 건너뛰면 사용자가 그 값을 다시 바꾸기 전까지 영영 올라가지 않는다.
  // 키별 검사(아래)가 있어 이미 올라갔거나 내려받은 키는 다시 올리지 않는다
  const alreadyDone = local.getState(settingsBackfillStateKey(workspace.localId)) !== null

  const existing = existingPairs(db)
  const now = Date.now()
  const pending: Pending[] = []
  const keys: string[] = []
  const add = (key: string): void => {
    if (existing.has(pairKey('settings', key))) return
    existing.add(pairKey('settings', key))
    pending.push({ table: 'settings', rowId: key })
    keys.push(key)
  }

  for (const key of SYNCED_SETTING_KEYS) {
    // 로컬에서 바꾼 적이 있거나(훅이 찍었다) 풀로 내려왔다면 건드리지 않는다
    if (local.getStateNumber(settingUpdatedAtKey(key)) !== null) continue
    add(key)
  }
  // 금고 키 재료는 설정 store 가 아니라 vault_meta 에서 온다. 금고가 아직 설정 전이면
  // 올릴 값이 없으므로 기록하지 않는다(설정하는 순간 금고가 스스로 기록한다)
  for (const key of VAULT_KEY_SYNC_KEYS) {
    if (options.skipKeyMaterial) break
    if (local.getStateNumber(settingUpdatedAtKey(key)) !== null) continue
    if (vault && (vault.readKeyMaterial?.(key) ?? null) === null) continue
    add(key)
  }

  if (keys.length === 0 && alreadyDone) return emptyResult(true)
  insertPending(db, pending, workspace.localId, now)
  for (const key of keys) local.setStateNumber(settingUpdatedAtKey(key), now)
  local.setState(settingsBackfillStateKey(workspace.localId), String(now))
  result.settings = keys.length
  return result
}

/** 변경 로그에 넣을 한 줄 */
interface Pending {
  table: SyncTable
  rowId: string
}

/** (표, 행) 짝을 한 문자열로. 구분자는 표·id 어느 쪽에도 나오지 않는 NUL */
function pairKey(table: string, rowId: string): string {
  return `${table}\u0000${rowId}`
}

function run(db: Db, local: SyncLocal, workspace: WorkspaceRef): BackfillResult {
  const result = emptyResult(false)
  const existing = existingPairs(db)
  const now = Date.now()
  const pending: Pending[] = []

  // 표별로 "올릴 행" 을 모은다.
  //
  // 대기열에 **이미 있던** 행은 건드리지 않는다(3차 리뷰 M7). 예전에는 그런 행의
  // 수정 시각까지 지금으로 올렸는데, 그러면 이미 만들어져 전송을 기다리던 행이
  // 매 재검사마다 시각이 밀려 다른 PC 와의 LWW 판정이 흔들린다.
  // 수정 시각을 올리는 대상은 "이번에 새로 대기열에 넣은 행" 뿐이다
  for (const table of ROW_TABLES) {
    const added: number[] = []
    for (const id of unsyncedIds(db, table, workspace)) {
      const key = pairKey(table, String(id))
      if (existing.has(key)) continue
      existing.add(key)
      pending.push({ table, rowId: String(id) })
      added.push(id)
    }
    bumpUpdatedAt(db, table, added, now)
    countInto(result, table, added.length)
  }

  insertPending(db, pending, workspace.localId, now)
  local.setState(backfillStateKey(workspace.localId), String(now))
  return result
}

function countInto(result: BackfillResult, table: RowTable, n: number): void {
  if (table === 'accounts') result.accounts = n
  else if (table === 'vault_items') result.vaultItems = n
  else if (table === 'bookmarks') result.bookmarks = n
  else if (table === 'chats') result.chats = n
  else result.chatMessages = n
}

/** 이미 변경 로그에 있는 (표, 행) 짝. 같은 행을 두 번 넣지 않으려고 미리 한 번만 읽는다 */
function existingPairs(db: Db): Set<string> {
  const rows = db.drizzle
    .select({ table: syncOutbox.table, rowId: syncOutbox.rowId })
    .from(syncOutbox)
    .all()
  return new Set(rows.map((r) => pairKey(r.table, r.rowId)))
}

/** 표 이름 → drizzle 표 */
function tableOf(
  table: RowTable
): typeof accounts | typeof vaultItems | typeof bookmarks | typeof chats | typeof chatMessages {
  if (table === 'accounts') return accounts
  if (table === 'vault_items') return vaultItems
  if (table === 'bookmarks') return bookmarks
  if (table === 'chats') return chats
  return chatMessages
}

/** 이 작업공간에서 아직 한 번도 올라간 적 없는(remote_id 가 비어 있는) 살아 있는 행의 id */
function unsyncedIds(db: Db, table: RowTable, workspace: WorkspaceRef): number[] {
  // 메시지는 작업공간 컬럼이 없다 — 대화가 이 작업공간에 속하면 메시지도 그렇다
  if (table === 'chat_messages') return unsyncedChatMessageIds(db, workspace)
  const t = tableOf(table) as typeof accounts | typeof vaultItems | typeof bookmarks | typeof chats
  const where = and(isNull(t.deletedAt), isNull(t.remoteId), scopeWhere(t, workspace)) as SQL
  return db.drizzle
    .select({ id: t.id })
    .from(t)
    .where(where)
    .all()
    .map((r) => r.id)
}

/** 이 작업공간의 대화에 달린, 아직 올라간 적 없는 메시지 */
function unsyncedChatMessageIds(db: Db, workspace: WorkspaceRef): number[] {
  const chatIds = new Set(
    db.drizzle
      .select({ id: chats.id })
      .from(chats)
      .where(and(isNull(chats.deletedAt), scopeWhere(chats, workspace)) as SQL)
      .all()
      .map((r) => r.id)
  )
  if (chatIds.size === 0) return []
  return db.drizzle
    .select({ id: chatMessages.id, chatId: chatMessages.chatId })
    .from(chatMessages)
    .where(and(isNull(chatMessages.deletedAt), isNull(chatMessages.remoteId)) as SQL)
    .all()
    .filter((r) => chatIds.has(r.chatId))
    .map((r) => r.id)
}

/**
 * 작업공간 범위. 기본 작업공간에서는 작업공간 컬럼이 없던 시절의 행(NULL)도 함께 본다 —
 * 로그인 전 데이터는 대부분 여기에 들어 있다
 */
function scopeWhere(
  t: typeof accounts | typeof vaultItems | typeof bookmarks | typeof chats,
  workspace: WorkspaceRef
): SQL {
  const mine = eq(t.workspaceId, workspace.localId)
  if (workspace.remoteId !== DEFAULT_WORKSPACE_REMOTE_ID) return mine
  return or(isNull(t.workspaceId), mine) as SQL
}

/**
 * 최초 업로드로 올릴 행의 수정 시각을 지금으로 올린다.
 *
 * 로그인 전에 가져온 계정·북마크는 가져오기 시각(어제)의 updated_at 을 그대로 달고 있다.
 * 그 값으로 올라가면, 이미 커서가 그보다 앞으로 가 있던 다른 PC 의 풀
 * (updated_at > cursor)에 영영 걸리지 않는다(2PC 실검수에서 발견).
 *
 * 여기 오는 행은 remote_id 가 없는 = 서버에 한 번도 없던 행이고, **이번에 새로 대기열에
 * 넣은** 행뿐이라 시각을 올려도 LWW 로 남의 최신 값을 덮을 일이 없다
 */
function bumpUpdatedAt(db: Db, table: RowTable, ids: number[], now: number): void {
  if (ids.length === 0) return
  // 계정·금고 항목은 원래 수정 시각을 지킨다 — 옛 사본의 행이 "지금" 시각을 달고 올라가면 다른 기기의
  // 삭제보다 늦은 것으로 보여 삭제를 이기고 되살아났다(9/30 계정 약 550개). 푸시가 올리기 전에
  // 서버의 같은 자연 키 삭제 표식과 원래 시각을 비교한다
  if (table === 'accounts' || table === 'vault_items') return
  const t = tableOf(table)
  db.drizzle.transaction((tx) => {
    for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
      tx.update(t)
        .set({ updatedAt: now })
        .where(inArray(t.id, ids.slice(i, i + INSERT_CHUNK)))
        .run()
    }
  })
  db.scheduleSave()
}

/** 변경 로그에 한 번에 밀어 넣는다. 수천 행이어도 문장 몇 개로 끝난다 */
function insertPending(db: Db, pending: Pending[], workspaceId: number, now: number): void {
  if (pending.length === 0) return
  db.drizzle.transaction((tx) => {
    for (let i = 0; i < pending.length; i += INSERT_CHUNK) {
      const chunk = pending.slice(i, i + INSERT_CHUNK)
      tx.insert(syncOutbox)
        .values(
          chunk.map((p) => ({
            table: p.table,
            rowId: p.rowId,
            op: 'upsert',
            payload: null,
            createdAt: now,
            workspaceId
          }))
        )
        .run()
    }
  })
  db.scheduleSave()
}
