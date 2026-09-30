// 동기화가 만지는 로컬 행 읽기·쓰기 모음.
// push.ts / pull.ts 가 같은 질의를 두 벌 들고 있지 않도록 여기 한 곳에 모았다.
// 기존 저장소(VaultRepo·BookmarkRepo)는 "앱 기능" 관점의 질의만 담당하고,
// 여기에는 remote_id·deleted_at 처럼 동기화에만 쓰는 컬럼 질의를 둔다

import { and, eq, isNotNull, isNull, like, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  accounts,
  bookmarkFolders,
  bookmarks,
  chatMessages,
  chats,
  sites,
  syncState,
  vaultItems
} from '../db/schema'
import type { SyncTable } from '../../shared/sync'
import { isChatRole } from '../../shared/chat'
import { parseSteps } from '../chat/repo'
import { TOMBSTONE_TTL_MS } from './merge'
import type {
  AccountSyncRow,
  BookmarkSyncRow,
  ChatMessageSyncRow,
  ChatSyncRow,
  VaultItemSyncRow
} from './mappers'

// 삭제 메모(sync_state) 키: tombstone:<표>:<원격 id>
const TOMBSTONE_KEY_PREFIX = 'tombstone:'
function tombstoneKey(table: SyncTable, remoteId: string): string {
  return `${TOMBSTONE_KEY_PREFIX}${table}:${remoteId}`
}

// 복호화 실패 메모(sync_state) 키: vaultDecryptFailed:<원격 id>
const DECRYPT_FAILED_KEY_PREFIX = 'vaultDecryptFailed:'

/** 계정 자연 키의 호스트 정규화 — 대소문자·앞뒤 공백을 무시한다 */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase()
}

/** 계정 자연 키(정규화 호스트 + 아이디). 원격 삭제 표식과 로컬 행을 맞출 때 쓴다 */
export function accountNaturalKey(host: string, username: string): string {
  return `${normalizeHost(host)}\u0000${username}`
}

/** 금고 항목 자연 키(계정 원격 id + 종류 + 라벨). 전역 항목은 계정 자리가 빈 문자열이다 */
export function vaultItemNaturalKey(
  accountRemoteId: string | null,
  type: string,
  label: string
): string {
  return `${accountRemoteId ?? ''}\u0000${type}\u0000${label}`
}

/** 폴더 경로 구분자. bookmarks_sync.folder_path 도 같은 규칙을 쓴다 */
const PATH_SEPARATOR = '/'

export class SyncLocal {
  /**
   * 풀로 내려받은 행에 채울 활성 작업공간의 로컬 id.
   * null 이면(동기화 밖 호출) 작업공간 컬럼을 건드리지 않는다 — 이 값이 없으면 내려받은
   * 행이 전부 NULL 로 남아 비기본 작업공간에서는 보이지 않는다
   */
  constructor(
    private readonly db: Db,
    private readonly workspaceLocalId: number | null = null
  ) {}

  /** 내려받은 행에 붙일 작업공간 컬럼. 모르면 아예 넣지 않는다 */
  private get workspacePatch(): { workspaceId: number } | Record<string, never> {
    return this.workspaceLocalId === null ? {} : { workspaceId: this.workspaceLocalId }
  }

  private get d(): Db['drizzle'] {
    return this.db.drizzle
  }

  // --- sync_state -----------------------------------------------------------

  getState(key: string): string | null {
    const row = this.d.select().from(syncState).where(eq(syncState.key, key)).get()
    return row ? row.value : null
  }

  getStateNumber(key: string): number | null {
    const raw = this.getState(key)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }

  setState(key: string, value: string): void {
    this.d
      .insert(syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: syncState.key, set: { value } })
      .run()
    this.db.scheduleSave()
  }

  setStateNumber(key: string, value: number): void {
    this.setState(key, String(value))
  }

  /** 한 줄을 지운다. 값을 "없던 상태" 로 되돌려야 할 때 쓴다(풀 커서 되돌리기) */
  deleteState(key: string): void {
    this.d.delete(syncState).where(eq(syncState.key, key)).run()
    this.db.scheduleSave()
  }

  // --- 삭제 메모(tombstone memory) -------------------------------------------
  // 지운 행의 원격 id 를 30일 동안 기억해, 다른 기기가 그 행을 살아 있는 채로 다시 올려도 풀이 되살리지
  // 않게 한다(실기: 병렬 인스턴스의 옛 복제본이 지운 계정·사이트를 원복시킴). 계정·금고 항목은 이제 행을
  // 남기는 soft delete 라 행 자체로도 막지만, 되돌리기로 원격 id 가 바뀐 옛 id·옛 하드 삭제분은 이 메모가 막는다

  /** 삭제 기록(outbox payload = 지운 행의 스냅샷)에서 원격 id 를 읽어 메모한다. 원격 id 가 없으면 아무것도 안 한다 */
  rememberTombstoneFromPayload(table: SyncTable, payload: string): void {
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed !== 'object' || parsed === null) return
      const row = parsed as { remoteId?: unknown; deletedAt?: unknown }
      if (typeof row.remoteId !== 'string' || !row.remoteId) return
      const deletedAt = typeof row.deletedAt === 'number' ? row.deletedAt : Date.now()
      this.rememberTombstone(table, row.remoteId, deletedAt)
    } catch {
      // 스냅샷을 못 읽으면 메모하지 않는다 — 삭제 전파 자체는 outbox 가 맡는다
    }
  }

  rememberTombstone(table: SyncTable, remoteId: string, deletedAt: number): void {
    this.setStateNumber(tombstoneKey(table, remoteId), deletedAt)
  }

  /** 그 원격 id 를 로컬에서 지운 시각. 메모가 없으면 null */
  tombstoneAt(table: SyncTable, remoteId: string): number | null {
    return this.getStateNumber(tombstoneKey(table, remoteId))
  }

  /** 삭제 메모를 지운다 — 원격에서 같은 id 로 다시 받아야 할 때(테스트의 "다른 기기" 흉내 등) */
  forgetTombstone(table: SyncTable, remoteId: string): void {
    this.deleteState(tombstoneKey(table, remoteId))
  }

  /** 30일 지난 삭제 메모를 지운다(pruneExpiredTombstones 가 부른다) */
  pruneTombstoneMemory(now: number): number {
    const cutoff = now - TOMBSTONE_TTL_MS
    const rows = this.d
      .select({ key: syncState.key, value: syncState.value })
      .from(syncState)
      .where(like(syncState.key, `${TOMBSTONE_KEY_PREFIX}%`))
      .all()
    let pruned = 0
    for (const row of rows) {
      const at = Number(row.value)
      if (!Number.isFinite(at) || at < cutoff) {
        this.d.delete(syncState).where(eq(syncState.key, row.key)).run()
        pruned += 1
      }
    }
    return pruned
  }

  // --- 계정 -----------------------------------------------------------------

  accountForSync(id: number): AccountSyncRow | null {
    const rows = this.d
      .select({ account: accounts, host: sites.host })
      .from(accounts)
      .innerJoin(sites, eq(accounts.siteId, sites.id))
      .where(eq(accounts.id, id))
      .all()
    const row = rows[0]
    if (!row) return null
    return {
      id: row.account.id,
      remoteId: row.account.remoteId,
      host: row.host,
      label: row.account.label,
      username: row.account.username,
      isDefault: row.account.isDefault,
      urls: parseStringArray(row.account.urls),
      agentAccess: row.account.agentAccess,
      tags: parseStringArray(row.account.tags),
      pausedUntil: row.account.pausedUntil,
      updatedAt: row.account.updatedAt,
      deletedAt: row.account.deletedAt
    }
  }

  accountIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  accountIdByHostUsername(host: string, username: string): number | null {
    const rows = this.d
      .select({ id: accounts.id })
      .from(accounts)
      .innerJoin(sites, eq(accounts.siteId, sites.id))
      .where(and(eq(sites.host, host), eq(accounts.username, username)))
      .all()
    return rows[0]?.id ?? null
  }

  // --- 자연 키(정규화 호스트 + 아이디) 기준 조회 ------------------------------
  // 원격 id 가 다른 같은 계정(다른 기기·옛 사본이 새 id 로 올린 것)을 알아보는 데 쓴다

  /** 자연 키가 같은 계정 행들(삭제 표식 포함). 호스트는 대소문자·앞뒤 공백을 무시한다 */
  private accountsByKey(
    host: string,
    username: string
  ): { id: number; remoteId: string | null; updatedAt: number; deletedAt: number | null }[] {
    return this.d
      .select({
        id: accounts.id,
        remoteId: accounts.remoteId,
        updatedAt: accounts.updatedAt,
        deletedAt: accounts.deletedAt
      })
      .from(accounts)
      .innerJoin(sites, eq(accounts.siteId, sites.id))
      .where(
        and(
          sql`lower(trim(${sites.host})) = ${normalizeHost(host)}`,
          eq(accounts.username, username)
        )
      )
      .all()
  }

  /** 자연 키가 같은 살아 있는 계정(원격 id 유무 무관) */
  liveAccountIdByKey(host: string, username: string): number | null {
    return this.accountsByKey(host, username).find((r) => r.deletedAt === null)?.id ?? null
  }

  /** 자연 키가 같은 살아 있는 계정들(원격 id 유무 무관) */
  liveAccountsByKey(
    host: string,
    username: string
  ): { id: number; remoteId: string | null; updatedAt: number }[] {
    return this.accountsByKey(host, username)
      .filter((r) => r.deletedAt === null)
      .map((r) => ({ id: r.id, remoteId: r.remoteId, updatedAt: r.updatedAt }))
  }

  /** 자연 키가 같은 계정 중 가장 늦게 지운 삭제 표식 행. 없으면 null */
  deletedAccountByKey(host: string, username: string): { id: number; deletedAt: number } | null {
    let best: { id: number; deletedAt: number } | null = null
    for (const r of this.accountsByKey(host, username)) {
      if (r.deletedAt === null) continue
      if (best === null || r.deletedAt > best.deletedAt) best = { id: r.id, deletedAt: r.deletedAt }
    }
    return best
  }

  /** 계정의 삭제 시각. 살아 있거나 없으면 null */
  accountDeletedAt(id: number): number | null {
    const row = this.d
      .select({ deletedAt: accounts.deletedAt })
      .from(accounts)
      .where(eq(accounts.id, id))
      .get()
    return row?.deletedAt ?? null
  }

  /**
   * 계정을 삭제 표식으로 바꾸고(soft delete) 딸린 살아 있는 항목도 함께 표식한다.
   * 돌려주는 값은 함께 표식한 항목 중 이미 원격에 올라간(원격 id 가 있는) 항목 id —
   * 호출부가 그 항목의 삭제 표식을 원격에 올린다
   */
  markAccountDeleted(id: number, deletedAt: number): number[] {
    const items = this.d
      .select({ id: vaultItems.id, remoteId: vaultItems.remoteId })
      .from(vaultItems)
      .where(and(eq(vaultItems.accountId, id), isNull(vaultItems.deletedAt)))
      .all()
    this.d
      .update(vaultItems)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(and(eq(vaultItems.accountId, id), isNull(vaultItems.deletedAt)))
      .run()
    this.d
      .update(accounts)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(accounts.id, id))
      .run()
    this.db.scheduleSave()
    return items.filter((r) => r.remoteId !== null).map((r) => r.id)
  }

  /** 금고 항목 하나를 삭제 표식으로 바꾼다(soft delete) */
  markVaultItemDeleted(id: number, deletedAt: number): void {
    this.d
      .update(vaultItems)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(vaultItems.id, id))
      .run()
    this.db.scheduleSave()
  }

  /**
   * 이미 지운 행의 수정 시각만 지금으로 올린다 — 원격에 되살아난 행을 다시 지우는 삭제 표식이
   * 다른 기기의 LWW(더 늦은 쪽이 이긴다)와 풀 커서를 통과하려면 시각이 그 행보다 뒤여야 한다
   */
  touchDeletedRow(table: 'accounts' | 'vault_items', id: number, at: number): void {
    const t = table === 'accounts' ? accounts : vaultItems
    this.d
      .update(t)
      .set({ updatedAt: at })
      .where(and(eq(t.id, id), isNotNull(t.deletedAt)))
      .run()
    this.db.scheduleSave()
  }

  // --- 복호화 실패 메모 -------------------------------------------------------
  // 풀에서 열지 못한 금고 행의 원격 id 와 그 행의 updated_at. 커서가 그 행에 붙박이지 않게 넘기고,
  // 같은 행(같은 판)에 대한 경고는 한 번만 남긴다

  /** 이 원격 행을 이 판(updated_at)으로 이미 실패 처리했는가 */
  decryptFailedBefore(remoteId: string, updatedAt: number): boolean {
    const at = this.getStateNumber(`${DECRYPT_FAILED_KEY_PREFIX}${remoteId}`)
    return at !== null && at >= updatedAt
  }

  rememberDecryptFailed(remoteId: string, updatedAt: number): void {
    this.setStateNumber(`${DECRYPT_FAILED_KEY_PREFIX}${remoteId}`, updatedAt)
  }

  /** updatedAt 을 함께 주면 그 값도 적는다(최초 업로드에서 시각을 올려 보낸 경우) */
  setAccountRemoteId(id: number, remoteId: string, updatedAt: number | null = null): void {
    this.d
      .update(accounts)
      .set(updatedAt === null ? { remoteId } : { remoteId, updatedAt })
      .where(eq(accounts.id, id))
      .run()
    this.db.scheduleSave()
  }

  /**
   * 원격 id 가 아직 없는 계정에 하나 만들어 붙인다.
   * 금고 항목이 account_id 로 가리켜야 하는데 계정이 아직 올라가지 않은 경우에 쓴다.
   * 이 계정도 서버에 한 번도 없던 행이므로 수정 시각을 지금으로 올린다 —
   * 옛 시각 그대로 올라가면 커서가 앞서 있는 다른 PC 의 풀에 걸리지 않는다
   */
  ensureAccountRemoteId(id: number, generate: () => string): string | null {
    const row = this.d
      .select({ remoteId: accounts.remoteId, updatedAt: accounts.updatedAt })
      .from(accounts)
      .where(eq(accounts.id, id))
      .get()
    if (!row) return null
    if (row.remoteId) return row.remoteId
    const remoteId = generate()
    this.setAccountRemoteId(id, remoteId, Math.max(row.updatedAt ?? 0, Date.now()))
    return remoteId
  }

  /** 원격 계정 행을 로컬에 반영한다(없으면 만든다). 돌려주는 값은 로컬 id */
  applyAccount(row: Omit<AccountSyncRow, 'id'>, localId: number | null): number {
    const siteId = this.upsertSite(row.host)
    const patch = {
      siteId,
      label: row.label,
      username: row.username,
      isDefault: row.isDefault,
      urls: JSON.stringify(row.urls),
      agentAccess: row.agentAccess,
      tags: JSON.stringify(row.tags),
      pausedUntil: row.pausedUntil,
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt,
      ...this.workspacePatch
    }
    if (localId !== null) {
      this.d.update(accounts).set(patch).where(eq(accounts.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    const inserted = this.d
      .insert(accounts)
      .values({ ...patch, createdAt: row.updatedAt })
      .returning({ id: accounts.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  private upsertSite(host: string): number {
    const existing = this.d.select({ id: sites.id }).from(sites).where(eq(sites.host, host)).get()
    if (existing) return existing.id
    const inserted = this.d
      .insert(sites)
      .values({ host, name: host, loginUrl: null, createdAt: Date.now() })
      .returning({ id: sites.id })
      .all()
    return inserted[0].id
  }

  // --- 금고 항목 -------------------------------------------------------------

  vaultItemForSync(id: number): VaultItemSyncRow | null {
    const row = this.d.select().from(vaultItems).where(eq(vaultItems.id, id)).get()
    if (!row) return null
    return {
      id: row.id,
      remoteId: row.remoteId,
      accountId: row.accountId,
      accountRemoteId: row.accountId === null ? null : this.accountRemoteIdOf(row.accountId),
      type: row.type,
      label: row.label,
      fieldsJson: row.fields ?? '[]',
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt
    }
  }

  accountRemoteIdOf(accountId: number): string | null {
    const row = this.d
      .select({ remoteId: accounts.remoteId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get()
    return row?.remoteId ?? null
  }

  vaultItemIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: vaultItems.id })
      .from(vaultItems)
      .where(eq(vaultItems.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  /**
   * 원격 id 로 짝을 못 찾았을 때 쓰는 두 번째 기준 — (계정, 종류, 라벨) 이 같고
   * 아직 한 번도 올라간 적 없는(remote_id 가 비어 있는) 로컬 항목.
   *
   * 두 PC 가 로그인 전에 같은 CSV 를 각자 가져오면 같은 항목이 양쪽에 서로 다른 로컬 id 로
   * 들어 있다. 원격 id 로만 맞추면 풀이 그것을 "처음 보는 항목" 으로 보고 하나 더 만들어,
   * 동기화할수록 항목이 배로 늘었다(3차 리뷰 I1).
   * 이미 올라간 적 있는 행(remote_id 가 있는 행)은 다른 원격 행의 짝이므로 건드리지 않는다
   */
  vaultItemIdByIdentity(accountId: number | null, type: string, label: string): number | null {
    const row = this.d
      .select({ id: vaultItems.id })
      .from(vaultItems)
      .where(
        and(
          isNull(vaultItems.remoteId),
          isNull(vaultItems.deletedAt),
          eq(vaultItems.type, type),
          eq(vaultItems.label, label),
          accountId === null ? isNull(vaultItems.accountId) : eq(vaultItems.accountId, accountId)
        )
      )
      .get()
    return row ? row.id : null
  }

  /** (계정, 종류, 라벨) 이 같은 살아 있는 항목(원격 id 유무 무관). 원격 삭제 표식을 맞출 때 쓴다 */
  liveVaultItemByIdentity(
    accountId: number | null,
    type: string,
    label: string
  ): { id: number; remoteId: string | null; updatedAt: number } | null {
    const row = this.d
      .select({ id: vaultItems.id, remoteId: vaultItems.remoteId, updatedAt: vaultItems.updatedAt })
      .from(vaultItems)
      .where(
        and(
          isNull(vaultItems.deletedAt),
          eq(vaultItems.type, type),
          eq(vaultItems.label, label),
          accountId === null ? isNull(vaultItems.accountId) : eq(vaultItems.accountId, accountId)
        )
      )
      .get()
    return row ?? null
  }

  /**
   * (계정, 종류, 라벨) 이 같은 항목 중 가장 늦게 지운 삭제 표식의 시각(원격 id 유무 무관).
   * 다른 기기가 같은 항목을 새 원격 id 로 올렸을 때 되살릴지 판단하는 데 쓴다. 없으면 null
   */
  deletedVaultItemAtByIdentity(
    accountId: number | null,
    type: string,
    label: string
  ): number | null {
    const rows = this.d
      .select({ deletedAt: vaultItems.deletedAt })
      .from(vaultItems)
      .where(
        and(
          isNotNull(vaultItems.deletedAt),
          eq(vaultItems.type, type),
          eq(vaultItems.label, label),
          accountId === null ? isNull(vaultItems.accountId) : eq(vaultItems.accountId, accountId)
        )
      )
      .all()
    let best: number | null = null
    for (const r of rows) {
      if (r.deletedAt !== null && (best === null || r.deletedAt > best)) best = r.deletedAt
    }
    return best
  }

  vaultItemUpdatedAt(id: number): number | null {
    const row = this.d
      .select({ updatedAt: vaultItems.updatedAt, deletedAt: vaultItems.deletedAt })
      .from(vaultItems)
      .where(eq(vaultItems.id, id))
      .get()
    return row ? row.updatedAt : null
  }

  /** updatedAt 을 함께 주면 그 값도 적는다(최초 업로드에서 시각을 올려 보낸 경우) */
  setVaultItemRemoteId(id: number, remoteId: string, updatedAt: number | null = null): void {
    this.d
      .update(vaultItems)
      .set(updatedAt === null ? { remoteId } : { remoteId, updatedAt })
      .where(eq(vaultItems.id, id))
      .run()
    this.db.scheduleSave()
  }

  /** 원격 금고 행을 로컬에 반영한다(없으면 만든다). fieldsJson 은 이미 복호화된 값이다 */
  applyVaultItem(
    row: Omit<VaultItemSyncRow, 'id' | 'accountId'> & { remoteId: string },
    localId: number | null
  ): number {
    const accountId =
      row.accountRemoteId === null ? null : this.accountIdByRemote(row.accountRemoteId)
    const patch = {
      accountId,
      type: row.type,
      label: row.label,
      fields: row.fieldsJson,
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt,
      ...this.workspacePatch
    }
    if (localId !== null) {
      this.d.update(vaultItems).set(patch).where(eq(vaultItems.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    // ciphertext/iv 는 v1 스키마의 NOT NULL 잔재라 빈 버퍼를 넣는다(값은 fields 안에 있다)
    const inserted = this.d
      .insert(vaultItems)
      .values({ ...patch, ciphertext: Buffer.alloc(0), iv: Buffer.alloc(0) })
      .returning({ id: vaultItems.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  // --- 북마크 ---------------------------------------------------------------

  /** 폴더 트리를 따라 올라가며 경로를 만든다(예: '북마크바/개발'). 루트면 빈 문자열 */
  folderPath(folderId: number | null): string {
    if (folderId === null) return ''
    const rows = this.d
      .select({
        id: bookmarkFolders.id,
        parentId: bookmarkFolders.parentId,
        name: bookmarkFolders.name
      })
      .from(bookmarkFolders)
      .all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    const names: string[] = []
    const visited = new Set<number>()
    let cursor: number | null = folderId
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor)
      const node = byId.get(cursor)
      if (!node) break
      names.unshift(node.name)
      cursor = node.parentId
    }
    return names.join(PATH_SEPARATOR)
  }

  /** 경로를 따라 폴더를 찾고, 없는 단계는 만든다. 빈 경로는 루트(null) */
  ensureFolderPath(path: string): number | null {
    const names = path.split(PATH_SEPARATOR).filter((s) => s.trim().length > 0)
    let parentId: number | null = null
    for (const name of names) {
      const siblings = this.d
        .select({ id: bookmarkFolders.id, name: bookmarkFolders.name })
        .from(bookmarkFolders)
        .where(
          parentId === null
            ? isNull(bookmarkFolders.parentId)
            : eq(bookmarkFolders.parentId, parentId)
        )
        .all()
      const found = siblings.find((f) => f.name === name)
      if (found) {
        parentId = found.id
        continue
      }
      const inserted = this.d
        .insert(bookmarkFolders)
        .values({ parentId, name, position: siblings.length, isToolbar: 0, addDate: null })
        .returning({ id: bookmarkFolders.id })
        .all()
      parentId = inserted[0].id
    }
    this.db.scheduleSave()
    return parentId
  }

  bookmarkForSync(id: number): BookmarkSyncRow | null {
    const row = this.d.select().from(bookmarks).where(eq(bookmarks.id, id)).get()
    if (!row) return null
    return {
      id: row.id,
      remoteId: row.remoteId,
      folderPath: this.folderPath(row.folderId),
      title: row.title,
      url: row.url,
      position: row.position,
      // updated_at 은 2b 에서 추가된 컬럼이라 옛 행은 비어 있다. 가져온 시각·0 순으로 메운다
      updatedAt: row.updatedAt ?? row.addedAt ?? 0,
      deletedAt: row.deletedAt
    }
  }

  listBookmarksForSync(): BookmarkSyncRow[] {
    return this.d
      .select()
      .from(bookmarks)
      .all()
      .map((row) => ({
        id: row.id,
        remoteId: row.remoteId,
        folderPath: this.folderPath(row.folderId),
        title: row.title,
        url: row.url,
        position: row.position,
        updatedAt: row.updatedAt ?? row.addedAt ?? 0,
        deletedAt: row.deletedAt
      }))
  }

  bookmarkIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: bookmarks.id })
      .from(bookmarks)
      .where(eq(bookmarks.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  /** updatedAt 을 함께 주면 그 값도 적는다(최초 업로드에서 시각을 올려 보낸 경우) */
  setBookmarkRemoteId(id: number, remoteId: string, updatedAt: number | null = null): void {
    this.d
      .update(bookmarks)
      .set(updatedAt === null ? { remoteId } : { remoteId, updatedAt })
      .where(eq(bookmarks.id, id))
      .run()
    this.db.scheduleSave()
  }

  applyBookmark(row: Omit<BookmarkSyncRow, 'id'>, localId: number | null): number {
    const folderId = this.ensureFolderPath(row.folderPath)
    const patch = {
      folderId,
      title: row.title,
      url: row.url,
      position: row.position,
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt,
      ...this.workspacePatch
    }
    if (localId !== null) {
      this.d.update(bookmarks).set(patch).where(eq(bookmarks.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    const inserted = this.d.insert(bookmarks).values(patch).returning({ id: bookmarks.id }).all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  // --- AI 채팅 ---------------------------------------------------------------

  chatForSync(id: number): ChatSyncRow | null {
    const row = this.d.select().from(chats).where(eq(chats.id, id)).get()
    if (!row) return null
    return {
      id: row.id,
      remoteId: row.remoteId,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt
    }
  }

  chatIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  /** updatedAt 을 함께 주면 그 값도 적는다(최초 업로드에서 시각을 올려 보낸 경우) */
  setChatRemoteId(id: number, remoteId: string, updatedAt: number | null = null): void {
    this.d
      .update(chats)
      .set(updatedAt === null ? { remoteId } : { remoteId, updatedAt })
      .where(eq(chats.id, id))
      .run()
    this.db.scheduleSave()
  }

  /** 메시지의 chat_id 가 가리킬 대상이 아직 없으면 원격 id 만 먼저 만들어 붙인다 */
  ensureChatRemoteId(id: number, generate: () => string): string | null {
    const row = this.d
      .select({ remoteId: chats.remoteId })
      .from(chats)
      .where(eq(chats.id, id))
      .get()
    if (!row) return null
    if (row.remoteId) return row.remoteId
    const remoteId = generate()
    this.setChatRemoteId(id, remoteId)
    return remoteId
  }

  applyChat(row: Omit<ChatSyncRow, 'id'> & { remoteId: string }, localId: number | null): number {
    const patch = {
      title: row.title,
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt,
      ...this.workspacePatch
    }
    if (localId !== null) {
      this.d.update(chats).set(patch).where(eq(chats.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    const inserted = this.d
      .insert(chats)
      .values({ ...patch, createdAt: row.createdAt })
      .returning({ id: chats.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  chatMessageForSync(id: number): ChatMessageSyncRow | null {
    const row = this.d.select().from(chatMessages).where(eq(chatMessages.id, id)).get()
    if (!row) return null
    return {
      id: row.id,
      remoteId: row.remoteId,
      chatId: row.chatId,
      chatRemoteId: this.chatRemoteIdOf(row.chatId),
      role: isChatRole(row.role) ? row.role : 'system',
      content: row.content,
      steps: parseSteps(row.steps),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt
    }
  }

  chatRemoteIdOf(chatId: number): string | null {
    const row = this.d
      .select({ remoteId: chats.remoteId })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get()
    return row?.remoteId ?? null
  }

  chatMessageIdByRemote(remoteId: string): number | null {
    const row = this.d
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.remoteId, remoteId))
      .get()
    return row ? row.id : null
  }

  /** updatedAt 을 함께 주면 그 값도 적는다(최초 업로드에서 시각을 올려 보낸 경우) */
  setChatMessageRemoteId(id: number, remoteId: string, updatedAt: number | null = null): void {
    this.d
      .update(chatMessages)
      .set(updatedAt === null ? { remoteId } : { remoteId, updatedAt })
      .where(eq(chatMessages.id, id))
      .run()
    this.db.scheduleSave()
  }

  /**
   * 원격 메시지를 로컬에 반영한다. 대화(chat_id)를 로컬에서 못 찾으면 null 을 돌려준다 —
   * 호출부는 그 행을 건너뛰고 커서도 올리지 않는다(다음 주기에 대화가 먼저 내려온 뒤 다시 본다)
   */
  applyChatMessage(
    row: Omit<ChatMessageSyncRow, 'id' | 'chatId'> & { remoteId: string },
    localId: number | null
  ): number | null {
    const chatId = row.chatRemoteId === null ? null : this.chatIdByRemote(row.chatRemoteId)
    if (chatId === null) return null
    const patch = {
      chatId,
      role: row.role,
      content: row.content,
      steps: row.steps === null ? null : JSON.stringify(row.steps),
      updatedAt: row.updatedAt,
      remoteId: row.remoteId,
      deletedAt: row.deletedAt
    }
    if (localId !== null) {
      this.d.update(chatMessages).set(patch).where(eq(chatMessages.id, localId)).run()
      this.db.scheduleSave()
      return localId
    }
    const inserted = this.d
      .insert(chatMessages)
      .values({ ...patch, createdAt: row.createdAt })
      .returning({ id: chatMessages.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  // --- 삭제 스냅샷 -----------------------------------------------------------

  /**
   * 행을 지우기 직전에 떠 두는 스냅샷. 원격 삭제 표식(tombstone)을 만들려면
   * host·label·url 같은 NOT NULL 컬럼이 필요한데, 지운 뒤에는 읽을 수 없다
   */
  snapshotForDelete(
    table: SyncTable,
    rowId: number
  ): AccountSyncRow | VaultItemSyncRow | BookmarkSyncRow | ChatSyncRow | ChatMessageSyncRow | null {
    if (table === 'accounts') return this.accountForSync(rowId)
    if (table === 'vault_items') return this.vaultItemForSync(rowId)
    if (table === 'bookmarks') return this.bookmarkForSync(rowId)
    if (table === 'chats') return this.chatForSync(rowId)
    if (table === 'chat_messages') return this.chatMessageForSync(rowId)
    return null
  }

  // --- tombstone 정리 --------------------------------------------------------

  /** 30일이 지난 삭제 표식을 물리 삭제한다. 돌려주는 값은 지운 행 수 */
  pruneExpiredTombstones(now: number): number {
    const cutoff = now - TOMBSTONE_TTL_MS
    let pruned = this.pruneTombstoneMemory(now)
    // 메시지를 먼저 지운다 — 대화가 먼저 사라지면 외래 키가 가리킬 대상이 없어진다
    for (const table of [accounts, vaultItems, bookmarks, chatMessages, chats]) {
      const rows = this.d
        .select({ id: table.id })
        .from(table)
        .where(and(isNotNull(table.deletedAt), lt(table.deletedAt, cutoff)))
        .all()
      for (const row of rows) {
        this.d.delete(table).where(eq(table.id, row.id)).run()
        pruned += 1
      }
    }
    if (pruned > 0) this.db.scheduleSave()
    return pruned
  }
}

// JSON 으로 저장된 string[] 컬럼(urls/tags)을 읽는다. 깨져 있으면 빈 배열
function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}
