// 변경 로그(outbox) → 원격. 표 단위로 돈다.
//
// 안전 규칙
// - 전송 직전 모든 행에 assertNoPlaintext 를 건다. 한 행이라도 걸리면 그 표는 통째로 보내지 않는다
// - 금고가 잠겨 있으면 vault_items 표만 통째로 건너뛴다(봉투 암호화에 마스터 키가 필요하다)
// - 전송에 실패한 건은 outbox 에 그대로 남는다(오프라인이어도 잃지 않는다)

import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import type { Settings } from '../../shared/settings'
import {
  isVaultKeySyncKey,
  SYNCED_SETTING_KEYS,
  type SyncTable,
  type VaultKeyApplyResult,
  type VaultKeySyncKey
} from '../../shared/sync'
import { AuthExpiredError, type RemoteKeyedRow, type RemoteRow, type SyncBackend } from './backend'
import { assertNoPlaintext, PlaintextLeakError } from './guard'
import { accountNaturalKey, SyncLocal, vaultItemNaturalKey } from './local'
import {
  accountToRemote,
  bookmarkToRemote,
  chatMessageToRemote,
  chatToRemote,
  fromIsoOrNull,
  remoteTableOf,
  settingToRemote,
  vaultItemToRemote,
  type BookmarkSyncRow,
  type ChatMessageSyncRow,
  type ChatSyncRow,
  type MapCtx
} from './mappers'
import { settingUpdatedAtKey, type OutboxRow, type SyncOutbox } from './outbox'
import { storedWorkspaceRemoteId } from './workspace-id'

/** 설정 읽기·쓰기. SettingsStore 가 그대로 만족한다(테스트에서는 최소 스텁) */
export interface SettingsAccess {
  get: () => Settings
  set: (patch: Partial<Settings>) => Settings
  /**
   * 원격에서 받은 값을 적용할 때 쓴다. 변경 로그를 남기지 않아 되돌아가는 전송(에코)이 없다.
   * 없으면 set 을 쓴다(테스트용 최소 스텁 호환)
   */
  setFromSync?: (patch: Partial<Settings>) => Settings
}

/** 금고에서 동기화가 필요로 하는 부분만. VaultService 가 그대로 만족한다 */
export interface VaultAccess {
  /** 잠금 해제 상태에서만 마스터 키를 빌려 준다. 잠겨 있으면 null */
  useMasterKey: <T>(fn: (key: Buffer) => T) => T | null
  /**
   * 마스터 키 재료(salt·KDF·검증자)를 읽는다. 값은 설정 store 가 아니라 vault_meta 에서 온다.
   * 금고가 아직 설정 전이면 null. 없으면 키 재료를 올리지 않는다(옛 테스트 스텁 호환)
   */
  readKeyMaterial?: (key: VaultKeySyncKey) => string | null
  /** 원격에서 받은 키 재료를 로컬 금고에 심는다. 없으면 풀에서 무시한다 */
  applyKeyMaterial?: (values: Partial<Record<VaultKeySyncKey, string>>) => VaultKeyApplyResult
}

/**
 * 지금 활성 작업공간. 전환될 수 있으므로 엔진을 다시 세우지 않고 **매 주기 평가**한다 —
 * 예전에는 엔진 생성 시 한 번만 읽어, B 작업공간의 변경이 A 의 uuid 로 올라갔다
 */
export interface WorkspaceRef {
  /** 로컬 DB 의 workspaces.id. 풀로 내려받은 행에 채워 넣는다 */
  localId: number
  /** 원격 uuid. 푸시 payload 와 풀 필터에 쓴다 */
  remoteId: string
}

export interface PushDeps {
  db: Db
  backend: SyncBackend
  outbox: SyncOutbox
  vault: VaultAccess
  settings: SettingsAccess
  userId: string
  /** 매 주기 불린다(작업공간 전환을 그대로 따라간다) */
  workspace: () => WorkspaceRef
}

export interface PushResult {
  sent: number
  failed: number
  skipped: number
}

// 계정을 먼저 올려야 금고 항목의 account_id 가, 대화를 먼저 올려야 메시지의 chat_id 가
// 가리킬 대상이 생긴다
const PUSH_ORDER: SyncTable[] = [
  'accounts',
  'vault_items',
  'bookmarks',
  'chats',
  'chat_messages',
  'settings'
]

export async function pushAll(
  deps: PushDeps,
  opts: {
    /**
     * 서버의 마스터 키 재료가 이 PC 와 다를 때 true. 그 상태에서 올린 항목은 다른 PC 가 못 푸는
     * 암호문이라 vault_items 는 통째로 보류한다(재키 뒤에 올라간다)
     */
    skipVaultItems?: boolean
  } = {}
): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, skipped: 0 }
  const local = new SyncLocal(deps.db)
  const ctxOf = workspaceResolver(deps)

  for (const table of PUSH_ORDER) {
    const entries = deps.outbox.pendingFor(table)
    if (entries.length === 0) continue
    if (table === 'vault_items' && opts.skipVaultItems) {
      result.skipped += entries.length
      continue
    }
    if (table === 'settings') {
      await pushSettings(deps, local, ctxOf, entries, result)
      continue
    }
    await pushTable(deps, local, ctxOf, table, entries, result)
  }
  return result
}

/** 변경 로그 한 줄 → 그 행을 올릴 때 쓸 매핑 문맥(작업공간 uuid 가 행마다 다를 수 있다) */
type CtxOf = (entry: OutboxRow) => MapCtx

/**
 * 행에 적힌 작업공간(로컬 id)으로 원격 uuid 를 고른다.
 * 예전에는 푸시 시점의 활성 작업공간 uuid 를 모든 대기 행에 찍어, 작업공간을 바꾸기 전에
 * 쌓인 변경이 새 작업공간으로 올라갔다.
 * 작업공간이 비어 있는 옛 행과, uuid 를 아직 정하지 못한 행은 활성 작업공간으로 본다
 */
function workspaceResolver(deps: PushDeps): CtxOf {
  const active = deps.workspace()
  const cache = new Map<number, string>()
  return (entry) => {
    const localId = entry.workspaceId
    if (localId === null || localId === active.localId)
      return { userId: deps.userId, workspaceRemoteId: active.remoteId }
    const cached = cache.get(localId)
    if (cached !== undefined) return { userId: deps.userId, workspaceRemoteId: cached }
    const remoteId = storedWorkspaceRemoteId(deps.db, localId) ?? active.remoteId
    cache.set(localId, remoteId)
    return { userId: deps.userId, workspaceRemoteId: remoteId }
  }
}

/** 전송한 행과 로컬 행을 이어 두었다가, 성공하면 remote_id 를 로컬에 적는다 */
interface Prepared {
  entry: OutboxRow
  row: RemoteRow
  /** upsert 인 경우에만 있다(삭제는 로컬 행이 이미 없다) */
  localId: number | null
  /** 최초 업로드라 수정 시각을 올려 보냈다면 그 값. 성공하면 로컬에도 같은 값을 적는다 */
  bumpedAt: number | null
}

async function pushTable(
  deps: PushDeps,
  local: SyncLocal,
  ctxOf: CtxOf,
  table: Exclude<SyncTable, 'settings'>,
  entries: OutboxRow[],
  result: PushResult
): Promise<void> {
  const remoteTable = remoteTableOf(table)
  const prepared: Prepared[] = []
  // 로컬 행이 사라졌고 삭제 스냅샷도 없는 건 — 보낼 것이 없으니 로그에서 지운다
  const droppable: number[] = []

  // 최초 업로드할 계정·금고 항목이 있으면 서버의 삭제 표식을 먼저 받아 둔다(작업공간별)
  let tombstones: TombstoneIndexes
  try {
    tombstones = await loadTombstones(deps, local, ctxOf, table, entries)
  } catch (e: unknown) {
    if (e instanceof AuthExpiredError) throw e
    const message = e instanceof Error ? e.message : String(e)
    deps.outbox.markFailed(
      entries.map((r) => r.id),
      message
    )
    result.failed += entries.length
    return
  }

  try {
    for (const entry of entries) {
      const built = buildRemote(deps, local, ctxOf(entry), table, entry, tombstones)
      if (built === 'skip') {
        result.skipped += 1
        continue
      }
      if (built === null) {
        droppable.push(entry.id)
        continue
      }
      assertNoPlaintext(remoteTable, built.row)
      prepared.push(built)
    }
  } catch (e: unknown) {
    // 평문 검사 실패 — 이 표는 한 행도 보내지 않는다. outbox 는 그대로 보존한다
    const message = e instanceof Error ? e.message : String(e)
    if (e instanceof PlaintextLeakError) console.error('동기화 중단: 평문 검사 실패', message)
    else console.error('동기화 중단: 원격 행을 만들지 못했습니다', message)
    deps.outbox.markFailed(
      entries.map((r) => r.id),
      message
    )
    result.failed += entries.length
    return
  }

  deps.outbox.clear(droppable)
  if (prepared.length === 0) return

  try {
    await deps.backend.upsert(
      remoteTable,
      prepared.map((p) => p.row)
    )
  } catch (e: unknown) {
    if (e instanceof AuthExpiredError) throw e
    const message = e instanceof Error ? e.message : String(e)
    deps.outbox.markFailed(
      prepared.map((p) => p.entry.id),
      message
    )
    result.failed += prepared.length
    return
  }

  for (const p of prepared) {
    if (p.localId === null) continue
    const remoteId = String(p.row.id)
    if (table === 'accounts') local.setAccountRemoteId(p.localId, remoteId, p.bumpedAt)
    else if (table === 'vault_items') local.setVaultItemRemoteId(p.localId, remoteId, p.bumpedAt)
    else if (table === 'bookmarks') local.setBookmarkRemoteId(p.localId, remoteId, p.bumpedAt)
    else if (table === 'chats') local.setChatRemoteId(p.localId, remoteId, p.bumpedAt)
    else local.setChatMessageRemoteId(p.localId, remoteId, p.bumpedAt)
  }
  deps.outbox.clear(prepared.map((p) => p.entry.id))
  result.sent += prepared.length
}

/** 서버 삭제 표식의 자연 키 → 가장 늦은 삭제. 작업공간 원격 uuid 별로 따로 든다 */
interface RemoteTombstone {
  id: string
  deletedAt: number
}
type TombstoneIndex = Map<string, RemoteTombstone>
type TombstoneIndexes = Map<string, TombstoneIndex>

/**
 * 이 표의 대기 건 중 최초 업로드(원격 id 없음·살아 있음)가 있으면, 그 작업공간의 서버 삭제 표식을
 * 자연 키로 모아 둔다. 계정·금고 항목만 본다(삭제가 권위를 가져야 하는 표)
 */
async function loadTombstones(
  deps: PushDeps,
  local: SyncLocal,
  ctxOf: CtxOf,
  table: Exclude<SyncTable, 'settings'>,
  entries: OutboxRow[]
): Promise<TombstoneIndexes> {
  const indexes: TombstoneIndexes = new Map()
  if (table !== 'accounts' && table !== 'vault_items') return indexes
  const workspaces = new Set<string>()
  for (const entry of entries) {
    if (entry.op !== 'upsert') continue
    const id = Number(entry.rowId)
    if (!Number.isInteger(id)) continue
    const row = table === 'accounts' ? local.accountForSync(id) : local.vaultItemForSync(id)
    if (row && row.remoteId === null && row.deletedAt === null) {
      workspaces.add(ctxOf(entry).workspaceRemoteId)
    }
  }
  for (const workspace of workspaces) {
    const columns =
      table === 'accounts'
        ? 'id,host,username,updated_at,deleted_at'
        : 'id,account_id,type,label,updated_at,deleted_at'
    const rows = await deps.backend.selectDeleted(remoteTableOf(table), workspace, columns)
    const index: TombstoneIndex = new Map()
    for (const r of rows) {
      const deletedAt = fromIsoOrNull(r.deleted_at)
      if (deletedAt === null) continue
      const key =
        table === 'accounts'
          ? accountNaturalKey(String(r.host ?? ''), String(r.username ?? ''))
          : vaultItemNaturalKey(
              typeof r.account_id === 'string' ? r.account_id : null,
              String(r.type ?? ''),
              String(r.label ?? '')
            )
      const prev = index.get(key)
      if (!prev || deletedAt > prev.deletedAt) index.set(key, { id: r.id, deletedAt })
    }
    indexes.set(workspace, index)
  }
  return indexes
}

/**
 * 최초 업로드하려는 행이 서버에서 이미 지워진 같은 자연 키보다 옛것인가(= 되살리면 안 되는가).
 * 행의 **원래** 수정 시각과 비교한다 — 삭제 뒤에 고친 행이면 사용자가 다시 만든 것이라 올린다
 */
function deletedOnServer(
  indexes: TombstoneIndexes,
  ctx: MapCtx,
  key: string,
  updatedAt: number
): RemoteTombstone | null {
  const hit = indexes.get(ctx.workspaceRemoteId)?.get(key)
  return hit && hit.deletedAt >= updatedAt ? hit : null
}

/**
 * 지운 계정·항목의 삭제 표식 행. 로컬 행이 삭제 표식으로 남아 있으면(soft delete) 그 행을 쓰고
 * localId 를 돌려준다 — 원격 id 가 없던 행도 전송 뒤 새 원격 id 를 로컬에 적을 수 있다.
 * 행이 없으면(옛 하드 삭제·되돌리기의 옛 원격 id) 변경 로그의 스냅샷으로 만든다
 */
function deletedRowOf<
  T extends { remoteId: string | null; updatedAt: number; deletedAt: number | null }
>(entry: OutboxRow, read: (id: number) => T | null): { row: T; localId: number | null } | null {
  const id = Number(entry.rowId)
  if (Number.isInteger(id)) {
    const current = read(id)
    if (current && current.deletedAt !== null) {
      return {
        row: { ...current, updatedAt: Math.max(current.updatedAt, current.deletedAt) },
        localId: id
      }
    }
  }
  const snap = tombstone<T>(entry)
  return snap ? { row: snap, localId: null } : null
}

/**
 * 변경 로그 한 줄을 원격 행으로 바꾼다.
 * - 'skip': 지금은 보낼 수 없다(금고 잠김·계정 먼저) — outbox 에 남긴다
 * - null: 보낼 것이 없다 — outbox 에서 지운다
 */
function buildRemote(
  deps: PushDeps,
  local: SyncLocal,
  ctx: MapCtx,
  table: Exclude<SyncTable, 'settings'>,
  entry: OutboxRow,
  tombstones: TombstoneIndexes
): Prepared | 'skip' | null {
  const rowId = Number(entry.rowId)
  if (table === 'accounts') {
    if (entry.op === 'delete') {
      const del = deletedRowOf(entry, (id) => local.accountForSync(id))
      if (!del) return null
      return { entry, row: accountToRemote(del.row, ctx), localId: del.localId, bumpedAt: null }
    }
    const row = local.accountForSync(rowId)
    if (!row) return null
    // 서버에 없던 행을 지운 것이면 올릴 것이 없다(삭제 표식은 delete 줄이 올린다)
    if (row.remoteId === null && row.deletedAt !== null) return null
    if (row.remoteId === null) {
      // 최초 업로드 — 서버에서 이미 지운 같은 계정이면 올리지 않고 로컬도 지운다(되살아남 방지)
      const key = accountNaturalKey(row.host, row.username)
      const hit = deletedOnServer(tombstones, ctx, key, row.updatedAt)
      if (hit) {
        for (const itemId of local.markAccountDeleted(rowId, hit.deletedAt)) {
          deps.outbox.record('vault_items', String(itemId), 'delete', undefined, entry.workspaceId)
        }
        return null
      }
    }
    const bumpedAt = bumpForFirstUpload(row, entry, table)
    return { entry, row: accountToRemote(row, ctx), localId: rowId, bumpedAt }
  }
  if (table === 'bookmarks') {
    const row =
      entry.op === 'delete' ? tombstone<BookmarkSyncRow>(entry) : local.bookmarkForSync(rowId)
    if (!row) return null
    const bumpedAt = bumpForFirstUpload(row, entry, table)
    return {
      entry,
      row: bookmarkToRemote(row, ctx),
      localId: entry.op === 'delete' ? null : rowId,
      bumpedAt
    }
  }
  if (table === 'chats') {
    const row = entry.op === 'delete' ? tombstone<ChatSyncRow>(entry) : local.chatForSync(rowId)
    if (!row) return null
    const bumpedAt = bumpForFirstUpload(row, entry, table)
    return {
      entry,
      row: chatToRemote(row, ctx),
      localId: entry.op === 'delete' ? null : rowId,
      bumpedAt
    }
  }
  if (table === 'chat_messages') {
    const row =
      entry.op === 'delete' ? tombstone<ChatMessageSyncRow>(entry) : local.chatMessageForSync(rowId)
    if (!row) return null
    // 대화가 한 번도 올라간 적이 없으면 원격 id 만 먼저 붙이고, 대화 자체도 다음 주기에 올린다
    if (row.chatRemoteId === null) {
      const chatRemoteId = local.ensureChatRemoteId(row.chatId, randomUUID)
      if (chatRemoteId === null) return null
      row.chatRemoteId = chatRemoteId
      deps.outbox.record('chats', String(row.chatId), 'upsert', undefined, entry.workspaceId)
    }
    const bumpedAt = bumpForFirstUpload(row, entry, table)
    return {
      entry,
      row: chatMessageToRemote(row, ctx),
      localId: entry.op === 'delete' ? null : rowId,
      bumpedAt
    }
  }

  if (entry.op === 'delete') {
    const del = deletedRowOf(entry, (id) => local.vaultItemForSync(id))
    if (!del) return null
    const deleted = del.row
    const row = deps.vault.useMasterKey((key) => vaultItemToRemote(deleted, { ...ctx, key }))
    if (row === null) return 'skip'
    return { entry, row, localId: del.localId, bumpedAt: null }
  }
  const item = local.vaultItemForSync(rowId)
  if (!item) return null
  if (item.remoteId === null && item.deletedAt !== null) return null
  if (item.remoteId === null) {
    // 최초 업로드 — 딸린 계정이 지워졌으면 항목도 지운다(지운 계정의 항목이 새로 올라가 되살아나지 않게)
    const accountDeletedAt = item.accountId === null ? null : local.accountDeletedAt(item.accountId)
    if (accountDeletedAt !== null) {
      local.markVaultItemDeleted(rowId, accountDeletedAt)
      return null
    }
    // 서버에서 이미 지운 같은 항목(계정·종류·라벨)이면 올리지 않고 로컬도 지운다
    if (item.accountId === null || item.accountRemoteId !== null) {
      const key = vaultItemNaturalKey(item.accountRemoteId, item.type, item.label)
      const hit = deletedOnServer(tombstones, ctx, key, item.updatedAt)
      if (hit) {
        local.markVaultItemDeleted(rowId, hit.deletedAt)
        return null
      }
    }
  }
  // 계정에 딸린 항목인데 그 계정이 아직 서버에 없다면 이번에는 보류하고 계정부터 올린다.
  // 계정은 다음 주기의 계정 단계에서 "서버에서 지운 같은 계정인가" 검사를 거친 뒤 원격 id 를 받는다 —
  // 여기서 원격 id 를 먼저 붙이면 그 검사를 건너뛰어 지운 계정이 되살아났다
  if (
    item.accountId !== null &&
    item.accountRemoteId === null &&
    local.accountForSync(item.accountId) !== null &&
    local.accountDeletedAt(item.accountId) === null
  ) {
    // 계정도 같은 작업공간으로 올라가야 한다 — 변경 로그 행의 작업공간을 그대로 물려준다
    deps.outbox.record('accounts', String(item.accountId), 'upsert', undefined, entry.workspaceId)
    return 'skip'
  }
  const bumpedAt = bumpForFirstUpload(item, entry, table)
  const row = deps.vault.useMasterKey((key) => vaultItemToRemote(item, { ...ctx, key }))
  if (row === null) return 'skip'
  return { entry, row, localId: rowId, bumpedAt }
}

/**
 * 서버에 한 번도 올라간 적 없는 행(remote_id 없음)은 **지금 시각**으로 올린다.
 *
 * 로그인 전에 쌓인 행은 옛 updated_at 을 그대로 달고 있어, 커서가 이미 그보다 앞으로 가 있던
 * 다른 PC 의 풀(updated_at > cursor)에 영영 걸리지 않는다(2PC 실검수에서 발견).
 * 서버에 없던 행이라 시각을 올려도 LWW 로 남의 최신 값을 덮지 않는다.
 * 삭제 표식은 tombstone() 이 이미 삭제 시각으로 올려 둔다.
 *
 * **계정·금고 항목은 올리지 않는다(원래 수정 시각 유지).** 옛 사본의 계정이 "지금" 시각을 달고
 * 올라가면 다른 기기의 삭제보다 늦은 것으로 보여 삭제를 이기고 되살아났다(9/30 계정 약 550개)
 */
function bumpForFirstUpload<T extends { remoteId: string | null; updatedAt: number }>(
  row: T,
  entry: OutboxRow,
  table: Exclude<SyncTable, 'settings'>
): number | null {
  if (table === 'accounts' || table === 'vault_items') return null
  if (entry.op === 'delete' || row.remoteId !== null) return null
  const next = Math.max(row.updatedAt, Date.now())
  row.updatedAt = next
  return next
}

/**
 * 삭제 스냅샷(payload)을 원래 행 모양으로 되돌린다. 삭제 시각이 비어 있으면 지금으로 본다.
 * updatedAt 도 삭제 시각으로 올린다 — 옛 값 그대로 두면 다른 PC 의 풀 커서(updated_at > cursor)에
 * 걸러져 삭제가 영영 전파되지 않는다(2PC 실검수에서 발견)
 */
function tombstone<T extends { deletedAt: number | null; updatedAt: number }>(
  entry: OutboxRow
): T | null {
  if (!entry.payload) return null
  try {
    const parsed: unknown = JSON.parse(entry.payload)
    if (typeof parsed !== 'object' || parsed === null) return null
    const row = parsed as T
    const deletedAt = row.deletedAt ?? entry.createdAt
    return { ...row, deletedAt, updatedAt: Math.max(row.updatedAt ?? 0, deletedAt) }
  } catch {
    return null
  }
}

async function pushSettings(
  deps: PushDeps,
  local: SyncLocal,
  ctxOf: CtxOf,
  entries: OutboxRow[],
  result: PushResult
): Promise<void> {
  const current = deps.settings.get()
  const rows: RemoteKeyedRow[] = []
  const ids: number[] = []
  const droppable: number[] = []

  try {
    for (const entry of entries) {
      const key = entry.rowId
      if (isVaultKeySyncKey(key)) {
        // 키 재료는 설정 store 에 없다 — 금고(vault_meta)에서 읽는다
        const material = deps.vault.readKeyMaterial?.(key) ?? null
        if (material === null) {
          // 금고가 아직 설정 전이면 올릴 값이 없다(다음 설정 때 다시 기록된다)
          droppable.push(entry.id)
          continue
        }
        const updatedAt = local.getStateNumber(settingUpdatedAtKey(key)) ?? entry.createdAt
        const row = settingToRemote(key, material, updatedAt, ctxOf(entry))
        assertNoPlaintext('settings_sync', row)
        rows.push(row)
        ids.push(entry.id)
        continue
      }
      if (!isSyncedSettingKey(key)) {
        // 조용히 사라지면 "왜 안 올라가지" 를 추적할 수 없다. 키 이름만 남긴다(값은 없다)
        console.warn('동기화 대상이 아닌 설정 키라 변경 로그에서 버립니다', key)
        droppable.push(entry.id)
        continue
      }
      const updatedAt = local.getStateNumber(settingUpdatedAtKey(key)) ?? entry.createdAt
      const row = settingToRemote(key, current[key], updatedAt, ctxOf(entry))
      assertNoPlaintext('settings_sync', row)
      rows.push(row)
      ids.push(entry.id)
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('동기화 중단: 평문 검사 실패', message)
    deps.outbox.markFailed(
      entries.map((r) => r.id),
      message
    )
    result.failed += entries.length
    return
  }

  deps.outbox.clear(droppable)
  if (rows.length === 0) return

  try {
    await deps.backend.upsertKeyed('settings_sync', rows)
  } catch (e: unknown) {
    if (e instanceof AuthExpiredError) throw e
    const message = e instanceof Error ? e.message : String(e)
    deps.outbox.markFailed(ids, message)
    result.failed += rows.length
    return
  }
  deps.outbox.clear(ids)
  result.sent += rows.length
}

function isSyncedSettingKey(key: string): key is (typeof SYNCED_SETTING_KEYS)[number] {
  return (SYNCED_SETTING_KEYS as readonly string[]).includes(key)
}

/** 계정에 원격 id 가 없으면 만들어 붙인다(금고 항목의 account_id 가 가리킬 대상) */
export function ensureAccountRemoteId(local: SyncLocal, accountId: number): string | null {
  return local.ensureAccountRemoteId(accountId, randomUUID)
}
