// 금고 저장소 — drizzle 쿼리만 담당한다(암호화·상태 판단은 service.ts).
// sql.js 드라이버는 동기이므로 .all()/.get()/.run() 을 그대로 쓴다.

import { eq, and, or, isNull, desc, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import { tr } from '../i18n'
import { sites, accounts, vaultItems, vaultMeta, auditLog } from '../db/schema'
import type {
  AgentAccess,
  PaymentProvider,
  SiteDto,
  VaultItemMeta,
  VaultItemType
} from '../../shared/vault'
import {
  normalizeAgentAccess,
  normalizeItemType,
  paymentProviderOfSections
} from '../../shared/vault'
import type { WorkspaceScope } from '../../shared/sync'
import { parseFields, serializeFields, toMetaSections, type StoredSection } from './fields'

// 암호문을 포함한 내부 행. 이 타입은 메인 프로세스 밖으로 나가지 않는다
export interface VaultItemRow {
  id: number
  accountId: number | null
  type: VaultItemType
  label: string
  // 섹션>필드 구조. secret 필드의 암호문이 여기 들어 있다
  sections: StoredSection[]
  updatedAt: number
}

// 결제 비밀번호 조회 결과. 못 찾은 이유를 호출부가 구분할 수 있게 담는다
export type PaymentItemLookup =
  { row: VaultItemRow; reason?: undefined } | { row: null; reason: 'not-found' | 'ambiguous' }

export interface AccountRow {
  id: number
  siteId: number
  host: string
  label: string
  username: string
  isDefault: boolean
  urls: string[]
  agentAccess: AgentAccess
  tags: string[]
}

// 계정 삭제 되돌리기용 스냅샷. 암호문을 그대로 들고 있으므로 메인 밖으로 나가지 않는다
export interface AccountSnapshot {
  account: typeof accounts.$inferSelect
  items: (typeof vaultItems.$inferSelect)[]
}

export interface AuditRow {
  id: number
  at: number
  itemId: number | null
  // 기록 시점의 계정 id 스냅샷(항목이 지워져도 남는다). 전역 항목·가져오기는 null
  accountId: number | null
  action: string
  jobId: string | null
  source: string
}

export interface UpsertAccountInput {
  id?: number
  host: string
  // 생략하면 기존 계정의 라벨을 그대로 둔다(신규면 username → host 순으로 대체)
  label?: string
  username: string
  // 생략하면 기존 계정의 기본 계정 여부를 그대로 둔다(신규면 false)
  isDefault?: boolean
  siteName?: string
  loginUrl?: string
  // 아래 셋은 생략하면 기존 값을 유지한다(자동 저장·가져오기가 사용자 설정을 지우지 않게)
  urls?: string[]
  agentAccess?: AgentAccess
  tags?: string[]
}

const AUDIT_LIST_LIMIT = 200

// sql.js 는 BLOB 을 Uint8Array 로 돌려준다. 항상 Buffer 로 맞춰 준다
function toBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
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

export class VaultRepo {
  constructor(private readonly db: Db) {}

  // 현재 작업공간. null 이면 범위 제한 없이 전부 본다(작업공간 기능이 붙기 전 동작)
  private scope: WorkspaceScope | null = null

  private get d(): Db['drizzle'] {
    return this.db.drizzle
  }

  /** 활성 작업공간을 알려 준다. 이후의 조회는 이 범위로 걸러지고, 새 행은 이 작업공간에 붙는다 */
  setWorkspaceScope(scope: WorkspaceScope | null): void {
    this.scope = scope
  }

  /** 새 행에 붙일 작업공간 id */
  private get scopeId(): number | null {
    return this.scope ? this.scope.id : null
  }

  /**
   * 작업공간 범위 조건. 범위가 없으면 undefined(=조건 없음)를 돌려준다.
   * 기본 작업공간에서는 아직 작업공간이 없던 시절의 행(NULL)도 함께 보인다
   */
  private scopeWhere(
    column: typeof accounts.workspaceId | typeof vaultItems.workspaceId
  ): SQL | undefined {
    if (!this.scope) return undefined
    if (this.scope.isDefault) return or(isNull(column), eq(column, this.scope.id))
    return eq(column, this.scope.id)
  }

  // --- vault_meta -------------------------------------------------------

  getMeta(key: string): Buffer | null {
    const row = this.d.select().from(vaultMeta).where(eq(vaultMeta.key, key)).get()
    return row ? toBuffer(row.value) : null
  }

  setMeta(key: string, value: Buffer): void {
    this.d
      .insert(vaultMeta)
      .values({ key, value })
      .onConflictDoUpdate({ target: vaultMeta.key, set: { value } })
      .run()
    this.db.scheduleSave()
  }

  deleteMeta(key: string): void {
    this.d.delete(vaultMeta).where(eq(vaultMeta.key, key)).run()
    this.db.scheduleSave()
  }

  // --- sites ------------------------------------------------------------

  listSites(): SiteDto[] {
    return this.d
      .select()
      .from(sites)
      .all()
      .map((r) => ({
        id: r.id,
        host: r.host,
        name: r.name,
        ...(r.loginUrl ? { loginUrl: r.loginUrl } : {})
      }))
  }

  // host 를 키로 사이트를 만들거나 이름/로그인 URL 을 갱신한다
  upsertSite(host: string, name?: string, loginUrl?: string): number {
    const existing = this.d.select().from(sites).where(eq(sites.host, host)).get()
    if (existing) {
      const patch: { name?: string; loginUrl?: string } = {}
      if (name && name !== existing.name) patch.name = name
      if (loginUrl && loginUrl !== existing.loginUrl) patch.loginUrl = loginUrl
      if (Object.keys(patch).length > 0) {
        this.d.update(sites).set(patch).where(eq(sites.id, existing.id)).run()
        this.db.scheduleSave()
      }
      return existing.id
    }
    const inserted = this.d
      .insert(sites)
      .values({
        host,
        name: name ?? host,
        loginUrl: loginUrl ?? null,
        createdAt: Date.now()
      })
      .returning({ id: sites.id })
      .all()
    this.db.scheduleSave()
    return inserted[0].id
  }

  // --- accounts ---------------------------------------------------------

  listAccounts(host?: string): AccountRow[] {
    const base = this.d
      .select({
        id: accounts.id,
        siteId: accounts.siteId,
        host: sites.host,
        label: accounts.label,
        username: accounts.username,
        isDefault: accounts.isDefault,
        urls: accounts.urls,
        agentAccess: accounts.agentAccess,
        tags: accounts.tags
      })
      .from(accounts)
      .innerJoin(sites, eq(accounts.siteId, sites.id))
    const conds = [
      host ? eq(sites.host, host) : undefined,
      // 원격에서 지워진 행(tombstone)은 화면·피커·자동채움 어디에도 나오지 않는다
      isNull(accounts.deletedAt),
      this.scopeWhere(accounts.workspaceId)
    ].filter((c): c is SQL => c !== undefined)
    const rows = conds.length > 0 ? base.where(and(...conds)).all() : base.all()
    return rows.map(toAccountRow)
  }

  getAccount(id: number): AccountRow | null {
    const rows = this.d
      .select({
        id: accounts.id,
        siteId: accounts.siteId,
        host: sites.host,
        label: accounts.label,
        username: accounts.username,
        isDefault: accounts.isDefault,
        urls: accounts.urls,
        agentAccess: accounts.agentAccess,
        tags: accounts.tags
      })
      .from(accounts)
      .innerJoin(sites, eq(accounts.siteId, sites.id))
      // 지운 계정(삭제 표식)은 id 로 찾아도 없는 것으로 본다
      .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)))
      .all()
    const row = rows[0]
    return row ? toAccountRow(row) : null
  }

  upsertAccount(input: UpsertAccountInput): AccountRow {
    const now = Date.now()
    const siteId = this.upsertSite(input.host, input.siteName, input.loginUrl)

    // id 가 있으면 수정, 없으면 (siteId, username) 조합으로 기존 계정을 찾는다
    // 같은 (siteId, username) 에 삭제 표식 행과 살아 있는 행이 함께 있으면 살아 있는 행을 고른다
    const existing = input.id
      ? (this.d.select().from(accounts).where(eq(accounts.id, input.id)).get() ?? null)
      : (this.d
          .select()
          .from(accounts)
          .where(and(eq(accounts.siteId, siteId), eq(accounts.username, input.username)))
          .all()
          .sort((a, b) => Number(a.deletedAt !== null) - Number(b.deletedAt !== null))[0] ?? null)
    // 지운 계정을 다시 저장하면 **새 원격 id** 로 되살린다. 옛 원격 id 는 서버에 삭제 표식으로 남아
    // 있어, 같은 id 로 살아 있는 행을 올리면 다른 기기는 삭제가 이긴다고 보고 다시 지운다
    const revived = existing !== null && existing.deletedAt !== null

    if (existing) {
      // label/isDefault 는 명시적으로 넘어온 경우에만 바꾼다 — 자동 저장(capture)·가져오기가
      // 사용자가 붙여 둔 라벨과 기본 계정 지정을 지워버리지 않게 한다
      this.d
        .update(accounts)
        .set({
          siteId,
          label: input.label ?? existing.label,
          username: input.username,
          isDefault: input.isDefault ?? existing.isDefault,
          urls: input.urls ? JSON.stringify(input.urls) : existing.urls,
          agentAccess: input.agentAccess ?? existing.agentAccess,
          tags: input.tags ? JSON.stringify(input.tags) : existing.tags,
          updatedAt: now,
          // 원격에서 지워졌던 계정(tombstone)을 다시 저장하면 되살린다 — 표식을 지우지 않으면
          // 저장은 성공했는데 목록·피커 어디에도 30일 동안 나타나지 않는다
          deletedAt: null,
          ...(revived ? { remoteId: null } : {})
        })
        .where(eq(accounts.id, existing.id))
        .run()
      this.db.scheduleSave()
      const updated = this.getAccount(existing.id)
      if (!updated) throw new Error(tr('vault.accountNotFound'))
      return updated
    }

    const inserted = this.d
      .insert(accounts)
      .values({
        siteId,
        // 빈 문자열("")도 "값 없음"으로 취급해 다음 후보로 넘어간다 — ?? 는 ''를 값으로 인정해 버린다
        label: input.label || input.username || input.host,
        username: input.username,
        isDefault: input.isDefault ?? false,
        // 신규 계정은 loginUrl 이 있으면 첫 URL 로 담아 둔다
        urls: JSON.stringify(input.urls ?? (input.loginUrl ? [input.loginUrl] : [])),
        agentAccess: input.agentAccess ?? 'inherit',
        tags: JSON.stringify(input.tags ?? []),
        createdAt: now,
        updatedAt: now,
        workspaceId: this.scopeId
      })
      .returning({ id: accounts.id })
      .all()
    this.db.scheduleSave()
    const created = this.getAccount(inserted[0].id)
    if (!created) throw new Error(tr('vault.accountCreateFailed'))
    return created
  }

  // 계정별 보유 항목 타입 목록(값 없음)
  itemTypesByAccount(): Map<number, VaultItemType[]> {
    const rows = this.d
      .select({ accountId: vaultItems.accountId, type: vaultItems.type })
      .from(vaultItems)
      // 다른 작업공간의 항목이 계정 목록의 타입 배지로 새어 나오지 않게 범위를 건다
      .where(and(isNull(vaultItems.deletedAt), this.scopeWhere(vaultItems.workspaceId)))
      .all()
    const map = new Map<number, VaultItemType[]>()
    for (const row of rows) {
      if (row.accountId === null) continue
      const list = map.get(row.accountId) ?? []
      const type = normalizeItemType(row.type)
      if (!list.includes(type)) list.push(type)
      map.set(row.accountId, list)
    }
    return map
  }

  // --- vault_items ------------------------------------------------------

  // 값(암호문)을 제외한 메타만 돌려준다 — secret 필드는 {key,label,kind} 만 담긴다
  listItems(accountId: number | null): VaultItemMeta[] {
    const rows = this.d
      .select({
        id: vaultItems.id,
        accountId: vaultItems.accountId,
        type: vaultItems.type,
        label: vaultItems.label,
        fields: vaultItems.fields,
        updatedAt: vaultItems.updatedAt
      })
      .from(vaultItems)
      .where(
        and(
          accountId === null ? isNull(vaultItems.accountId) : eq(vaultItems.accountId, accountId),
          isNull(vaultItems.deletedAt),
          this.scopeWhere(vaultItems.workspaceId)
        )
      )
      .all()
    return rows.map(toItemMeta)
  }

  getItemRow(id: number): VaultItemRow | null {
    // 지운 항목(삭제 표식)은 id 로 찾아도 없는 것으로 본다
    const row = this.d
      .select()
      .from(vaultItems)
      .where(and(eq(vaultItems.id, id), isNull(vaultItems.deletedAt)))
      .get()
    return row ? toItemRow(row) : null
  }

  /** 작업공간과 무관하게 모든 항목 행. 마스터 키를 바꿀 때(재암호화) 전부 훑는 용도 */
  listAllItemRows(): VaultItemRow[] {
    return this.d.select().from(vaultItems).all().map(toItemRow)
  }

  /** 전역 항목(accountId = null) 가운데 이 종류인 것 전부(만든 순서) */
  findGlobalItemRowsByType(type: VaultItemType): VaultItemRow[] {
    return this.d
      .select()
      .from(vaultItems)
      .where(
        and(
          isNull(vaultItems.accountId),
          eq(vaultItems.type, type),
          isNull(vaultItems.deletedAt),
          this.scopeWhere(vaultItems.workspaceId)
        )
      )
      .all()
      .map(toItemRow)
  }

  // 전역 항목(accountId = null)은 (type, label) 조합으로 찾는다 — 같은 type 이라도
  // 라벨이 다르면 별개 항목이다(예: '메모' 항목 여러 개)
  findGlobalItemRow(type: VaultItemType, label: string): VaultItemRow | null {
    const rows = this.d
      .select()
      .from(vaultItems)
      .where(
        and(
          isNull(vaultItems.accountId),
          eq(vaultItems.type, type),
          eq(vaultItems.label, label),
          isNull(vaultItems.deletedAt)
        )
      )
      .all()
    const row = rows[0]
    return row ? toItemRow(row) : null
  }

  findItemRow(accountId: number | null, type: VaultItemType): VaultItemRow | null {
    const rows = this.d
      .select()
      .from(vaultItems)
      .where(
        and(
          accountId === null ? isNull(vaultItems.accountId) : eq(vaultItems.accountId, accountId),
          eq(vaultItems.type, type),
          isNull(vaultItems.deletedAt)
        )
      )
      .all()
    const row = rows[0]
    return row ? toItemRow(row) : null
  }

  /** 계정에 딸린 결제 비밀번호('password') 항목 전부. 저장 순서(id)를 그대로 지킨다 */
  listPaymentItemRows(accountId: number): VaultItemRow[] {
    return this.d
      .select()
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.accountId, accountId),
          eq(vaultItems.type, 'password'),
          isNull(vaultItems.deletedAt)
        )
      )
      .orderBy(vaultItems.id)
      .all()
      .map(toItemRow)
  }

  /**
   * 계정별로 결제 비밀번호 항목이 가리키는 결제 제공자 목록(중복 없이, 저장 순서).
   * 하네스가 "결제 가능한 수단"만 견적 후보로 남기는 데 쓴다(list_accounts 의 payments).
   * 비밀값은 읽지 않는다 — 제공자는 평문 필드다
   */
  paymentProvidersByAccount(): Map<number, PaymentProvider[]> {
    const rows = this.d
      .select()
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.type, 'password'),
          isNull(vaultItems.deletedAt),
          this.scopeWhere(vaultItems.workspaceId)
        )
      )
      .orderBy(vaultItems.id)
      .all()
      .map(toItemRow)
    const map = new Map<number, PaymentProvider[]>()
    for (const row of rows) {
      if (row.accountId === null) continue
      const list = map.get(row.accountId) ?? []
      const provider = paymentProviderOfSections(row.sections)
      if (!list.includes(provider)) list.push(provider)
      map.set(row.accountId, list)
    }
    return map
  }

  /**
   * 결제 비밀번호 한 개를 고른다.
   * - provider 를 주면 그 결제 수단의 항목만 본다(제공자 필드가 없는 옛 항목은 'site')
   * - provider 가 없으면 계정에 항목이 정확히 1개일 때만 돌려준다.
   *   2개 이상이면 어느 결제창인지 알 수 없으므로 'ambiguous' 다 —
   *   잘못 누르면 계정이 잠기므로 절대 임의로 고르지 않는다
   */
  /** 계정의 카드 항목(type 'card'). 하나면 그것, 없으면 not-found, 둘 이상이면 ambiguous — 임의로 고르지 않는다 */
  findCardItemRow(accountId: number): PaymentItemLookup {
    const rows = this.d
      .select()
      .from(vaultItems)
      .where(
        and(
          eq(vaultItems.accountId, accountId),
          eq(vaultItems.type, 'card'),
          isNull(vaultItems.deletedAt)
        )
      )
      .orderBy(vaultItems.id)
      .all()
      .map(toItemRow)
    if (rows.length === 1) return { row: rows[0] }
    if (rows.length === 0) return { row: null, reason: 'not-found' }
    return { row: null, reason: 'ambiguous' }
  }

  findPaymentItemRow(accountId: number, provider?: PaymentProvider): PaymentItemLookup {
    const rows = this.listPaymentItemRows(accountId)
    if (provider) {
      const matched = rows.filter((r) => paymentProviderOfSections(r.sections) === provider)
      const first = matched[0]
      return first ? { row: first } : { row: null, reason: 'not-found' }
    }
    if (rows.length === 1) return { row: rows[0] }
    if (rows.length === 0) return { row: null, reason: 'not-found' }
    return { row: null, reason: 'ambiguous' }
  }

  // AAD 로 쓸 id 를 먼저 얻기 위해 빈 fields 로 행을 만든다(곧바로 updateItemFields 로 채운다).
  // ciphertext/iv 는 v1 스키마의 NOT NULL 잔재라 빈 버퍼를 넣는다
  insertItemPlaceholder(
    accountId: number | null,
    type: VaultItemType,
    label: string,
    updatedAt: number
  ): number {
    const inserted = this.d
      .insert(vaultItems)
      .values({
        accountId,
        type,
        label,
        fields: serializeFields([]),
        ciphertext: Buffer.alloc(0),
        iv: Buffer.alloc(0),
        updatedAt,
        workspaceId: this.scopeId
      })
      .returning({ id: vaultItems.id })
      .all()
    return inserted[0].id
  }

  updateItemFields(
    id: number,
    sections: StoredSection[],
    label: string,
    type: VaultItemType,
    updatedAt: number
  ): void {
    this.d
      .update(vaultItems)
      .set({ fields: serializeFields(sections), label, type, updatedAt })
      .where(eq(vaultItems.id, id))
      .run()
    this.db.scheduleSave()
  }

  /**
   * 항목을 지운다 — 행은 남기고 삭제 표식(deleted_at)만 찍는다(soft delete).
   * 행이 남아 있어야 풀이 다른 기기에서 되살아 올라온 같은 항목을 알아보고 막을 수 있다.
   * 표식은 30일 뒤 pruneExpiredTombstones 가 물리 삭제한다
   */
  deleteItem(id: number): void {
    const now = Date.now()
    this.d
      .update(vaultItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(vaultItems.id, id), isNull(vaultItems.deletedAt)))
      .run()
    this.db.scheduleSave()
  }

  itemMeta(id: number): VaultItemMeta | null {
    const rows = this.d
      .select({
        id: vaultItems.id,
        accountId: vaultItems.accountId,
        type: vaultItems.type,
        label: vaultItems.label,
        fields: vaultItems.fields,
        updatedAt: vaultItems.updatedAt
      })
      .from(vaultItems)
      .where(and(eq(vaultItems.id, id), isNull(vaultItems.deletedAt)))
      .all()
    const r = rows[0]
    return r ? toItemMeta(r) : null
  }

  // --- audit_log --------------------------------------------------------

  // accountId 는 기록 시점의 스냅샷이다 — 항목이 삭제돼도 계정별 사용 기록에서 사라지지 않는다
  insertAudit(entry: {
    itemId: number | null
    accountId?: number | null
    action: string
    source: string
    jobId?: string
  }): void {
    this.d
      .insert(auditLog)
      .values({
        at: Date.now(),
        itemId: entry.itemId,
        accountId: entry.accountId ?? null,
        action: entry.action,
        jobId: entry.jobId ?? null,
        source: entry.source
      })
      .run()
    this.db.scheduleSave()
  }

  // accountId 를 주면 그 계정의 기록만 반환한다.
  // audit_log.account_id 스냅샷(삭제된 항목 포함)과 vault_items 조인(스냅샷이 없는 옛 기록)을 모두 본다
  listAudit(accountId?: number, limit = AUDIT_LIST_LIMIT): AuditRow[] {
    if (accountId === undefined) {
      return this.d.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit).all()
    }
    return this.d
      .select({
        id: auditLog.id,
        at: auditLog.at,
        itemId: auditLog.itemId,
        accountId: auditLog.accountId,
        action: auditLog.action,
        jobId: auditLog.jobId,
        source: auditLog.source
      })
      .from(auditLog)
      .leftJoin(vaultItems, eq(auditLog.itemId, vaultItems.id))
      .where(or(eq(auditLog.accountId, accountId), eq(vaultItems.accountId, accountId)))
      .orderBy(desc(auditLog.id))
      .limit(limit)
      .all()
  }

  // --- 계정 삭제·복원(되돌리기) -----------------------------------------

  /**
   * 계정 한 건과 딸린 항목을 원본 컬럼 그대로 떠 둔다(되돌리기용 스냅샷).
   * 암호문이 들어 있으므로 이 값은 메인 프로세스 밖으로 나가지 않는다.
   */
  accountSnapshot(id: number): AccountSnapshot | null {
    const account = this.d
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)))
      .get()
    if (!account) return null
    // 이미 지운 항목은 되돌리기 대상이 아니다 — 살아 있는 항목만 떠 둔다
    const items = this.d
      .select()
      .from(vaultItems)
      .where(and(eq(vaultItems.accountId, id), isNull(vaultItems.deletedAt)))
      .all()
    return {
      account,
      items: items.map((r) => ({ ...r, ciphertext: toBuffer(r.ciphertext), iv: toBuffer(r.iv) }))
    }
  }

  /** 계정과 딸린 항목을 지운다(FK cascade 에 기대지 않고 직접 지운다) */
  /**
   * fromId 계정의 항목 중 skipTypes 에 없는 종류를 toId 계정으로 옮긴다(계정 합치기용).
   * 항목 id 는 그대로라 AAD(itemId:fieldKey) 도 그대로다. 옮긴 항목 id 를 돌려준다
   */
  moveItems(fromId: number, toId: number, skipTypes: Set<string>): number[] {
    const rows = this.d
      .select({ id: vaultItems.id, type: vaultItems.type })
      .from(vaultItems)
      .where(and(eq(vaultItems.accountId, fromId), isNull(vaultItems.deletedAt)))
      .all()
    const moved: number[] = []
    const now = Date.now()
    for (const row of rows) {
      const type = normalizeItemType(row.type)
      if (skipTypes.has(type)) continue
      this.d
        .update(vaultItems)
        .set({ accountId: toId, updatedAt: now })
        .where(eq(vaultItems.id, row.id))
        .run()
      skipTypes.add(type)
      moved.push(row.id)
    }
    if (moved.length > 0) this.db.scheduleSave()
    return moved
  }

  /**
   * 계정과 딸린 살아 있는 항목에 삭제 표식을 찍는다(soft delete). 행은 30일 동안 남아
   * 다른 기기·옛 사본이 같은 계정을 새 원격 id 로 다시 올려도 풀이 알아보고 막는다
   */
  deleteAccountCascade(id: number): void {
    const now = Date.now()
    this.d
      .update(vaultItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(vaultItems.accountId, id), isNull(vaultItems.deletedAt)))
      .run()
    this.d
      .update(accounts)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)))
      .run()
    this.db.scheduleSave()
  }

  /**
   * 스냅샷을 원래 id 그대로 되돌린다.
   * id 를 유지해야 암호문의 AAD(`${itemId}:${fieldKey}`)가 여전히 맞는다
   */
  restoreSnapshot(snapshot: AccountSnapshot): void {
    // 삭제는 행을 남기는 soft delete 라 같은 id 의 행이 대개 그대로 있다 — 있으면 덮어써 되살린다.
    // 수정 시각은 지금으로 올린다: 이미 올라간 삭제 표식(삭제 시각)보다 늦어야 다른 기기가 되살린다
    // 원격 id 는 비운다 — 옛 id 는 서버에 삭제 표식으로 남기고 새 id 로 올린다(service 가 옛 id 에
    // 삭제 표식을 다시 기록한다)
    const now = Date.now()
    const account = { ...snapshot.account, updatedAt: now, deletedAt: null, remoteId: null }
    this.d
      .insert(accounts)
      .values(account)
      .onConflictDoUpdate({ target: accounts.id, set: account })
      .run()
    for (const snap of snapshot.items) {
      const item = { ...snap, updatedAt: now, deletedAt: null, remoteId: null }
      this.d
        .insert(vaultItems)
        .values(item)
        .onConflictDoUpdate({ target: vaultItems.id, set: item })
        .run()
    }
    this.db.scheduleSave()
  }

  // 여러 쓰기를 한 트랜잭션으로 묶는다(항목 생성: placeholder insert → 암호문 update)
  transaction<T>(fn: () => T): T {
    return this.d.transaction(() => fn())
  }
}

// --- 행 → 도메인 객체 변환 -------------------------------------------------

interface RawAccountRow {
  id: number
  siteId: number
  host: string
  label: string
  username: string
  isDefault: boolean
  urls: string | null
  agentAccess: string
  tags: string | null
}

function toAccountRow(r: RawAccountRow): AccountRow {
  return {
    id: r.id,
    siteId: r.siteId,
    host: r.host,
    label: r.label,
    username: r.username,
    isDefault: r.isDefault,
    urls: parseStringArray(r.urls),
    agentAccess: normalizeAgentAccess(r.agentAccess),
    tags: parseStringArray(r.tags)
  }
}

interface RawItemMetaRow {
  id: number
  accountId: number | null
  type: string
  label: string
  fields: string | null
  updatedAt: number
}

function toItemMeta(r: RawItemMetaRow): VaultItemMeta {
  return {
    id: r.id,
    accountId: r.accountId,
    type: normalizeItemType(r.type),
    label: r.label,
    sections: toMetaSections(parseFields(r.fields)),
    updatedAt: r.updatedAt
  }
}

function toItemRow(r: RawItemMetaRow): VaultItemRow {
  return {
    id: r.id,
    accountId: r.accountId,
    type: normalizeItemType(r.type),
    label: r.label,
    sections: parseFields(r.fields),
    updatedAt: r.updatedAt
  }
}
