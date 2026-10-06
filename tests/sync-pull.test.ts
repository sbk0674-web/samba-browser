// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

// 풀 — 원격 변경을 로컬에 병합한다(LWW·합집합·tombstone)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { auditLog, bookmarks } from '../src/main/db/schema'
import { VaultService } from '../src/main/vault/service'
import { SyncOutbox, createOutboxRecorder, settingUpdatedAtKey } from '../src/main/sync/outbox'
import { SyncLocal } from '../src/main/sync/local'
import { pushAll, type PushDeps, type SettingsAccess } from '../src/main/sync/push'
import {
  pullAll,
  pullCursorKey,
  legacyTableCursorKey,
  parsePullCursor,
  PULL_CURSOR_KEY,
  PULL_PAGE_SIZE,
  type PullTable
} from '../src/main/sync/pull'
import { TOMBSTONE_TTL_MS } from '../src/main/sync/merge'
import { vaultSyncAad } from '../src/main/sync/mappers'
import { encrypt } from '../src/main/vault/crypto'
import { BookmarkRepo } from '../src/main/bookmarks/repo'
import { createFakeBackend, FAKE_USER_ID, type FakeBackend } from './stubs/fake-backend'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import type { RemoteRow } from '../src/main/sync/backend'

const MASTER = 'master-pass-1234'
const SECRET = 'sup3rs3cret!'
const WORKSPACE = '00000000-0000-4000-8000-0000000000ws'

/** 커서는 (updated_at, id) 복합이라 문자열로 저장된다. 시각만 꺼내 본다 */
function cursorTs(local: SyncLocal, workspaceLocalId: number, table: PullTable): number | null {
  const raw = local.getState(pullCursorKey(workspaceLocalId, table))
  return raw === null ? null : parsePullCursor(raw).ts
}

function makeSettings(patch: Partial<Settings> = {}): SettingsAccess {
  let value: Settings = { ...DEFAULT_SETTINGS, ...patch }
  return {
    get: () => value,
    set: (p: Partial<Settings>) => {
      value = { ...value, ...p }
      return value
    }
  }
}

function accountRow(over: Partial<RemoteRow> = {}): RemoteRow {
  return {
    id: 'acc-1',
    user_id: FAKE_USER_ID,
    workspace_id: WORKSPACE,
    host: 'example.com',
    label: '내 계정',
    username: 'me',
    is_default: false,
    urls: [],
    agent_access: 'inherit',
    tags: [],
    paused_until: null,
    updated_at: new Date(2_000_000).toISOString(),
    deleted_at: null,
    ...over
  }
}

function bookmarkRow(over: Partial<RemoteRow> = {}): RemoteRow {
  return {
    id: 'bm-1',
    user_id: FAKE_USER_ID,
    workspace_id: WORKSPACE,
    folder_path: '북마크바',
    title: '원격 북마크',
    url: 'https://remote.example',
    position: 0,
    updated_at: new Date(2_000_000).toISOString(),
    deleted_at: null,
    ...over
  }
}

describe('pullAll', () => {
  let db: Db
  let vault: VaultService
  let outbox: SyncOutbox
  let backend: FakeBackend
  let deps: PushDeps
  let local: SyncLocal

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    outbox = new SyncOutbox(db)
    backend = createFakeBackend()
    local = new SyncLocal(db)
    const settings = makeSettings()
    vault = new VaultService(db, { get: settings.get })
    vault.setOutboxRecorder(createOutboxRecorder(db, outbox))
    await vault.setup(MASTER)
    deps = {
      db,
      backend,
      outbox,
      vault,
      settings,
      userId: FAKE_USER_ID,
      workspace: () => ({ localId: 1, remoteId: WORKSPACE })
    }
  })

  afterEach(() => {
    vault.dispose()
    db.close()
  })

  it('원격에만 있는 계정이 로컬에 생긴다', async () => {
    backend.seed('accounts_sync', [accountRow()])

    const result = await pullAll(deps)

    expect(result.applied).toBe(1)
    const id = local.accountIdByRemote('acc-1')
    expect(id).not.toBeNull()
    expect(local.accountForSync(id!)?.username).toBe('me')
  })

  it('다른 id 의 삭제 표식은 그 삭제 뒤에 고친 같은 host·아이디의 살아 있는 계정을 지우지 않는다', async () => {
    // 실기: a-rt.com 합치기로 지운 중복 계정의 표식이, 이름을 a-rt.com 으로 바꾼 남은 계정에 걸려 그것까지 지웠다.
    // 합치기는 나머지를 지운 뒤에 남은 계정을 고친다 — 남은 계정의 수정 시각이 삭제보다 늦다
    const kept = vault.upsertAccount({ host: 'a-rt.com', username: 'mjkim88' })
    local.setAccountRemoteId(kept.id, 'acc-kept')
    backend.seed('accounts_sync', [
      accountRow({
        id: 'acc-removed',
        host: 'a-rt.com',
        username: 'mjkim88',
        updated_at: new Date(Date.now() - 60_000).toISOString(),
        deleted_at: new Date(Date.now() - 60_000).toISOString()
      })
    ])
    await pullAll(deps)
    expect(local.accountForSync(kept.id)?.deletedAt).toBeNull()
    expect(vault.listAccounts('a-rt.com').map((a) => a.id)).toEqual([kept.id])
  })

  it('로컬에서 지운 계정은 원격의 더 늦은 살아 있는 갱신으로 되살리지 않는다', async () => {
    // 실기: 병렬 인스턴스(옛 복제본)가 지운 계정을 만지고 upsert → LWW 로 삭제가 뒤집혀 키마스터에 계정이 원복
    backend.seed('accounts_sync', [accountRow({ id: 'acc-del' })])
    await pullAll(deps)
    const id = local.accountIdByRemote('acc-del')!
    vault.deleteAccounts([id])
    // 행은 남고 삭제 표식만 찍힌다(soft delete)
    expect(local.accountForSync(id)?.deletedAt).not.toBeNull()
    // 삭제 기록이 원격 id 를 메모해 둔다(outbox.record → rememberTombstoneFromPayload)
    expect(local.tombstoneAt('accounts', 'acc-del')).not.toBeNull()
    backend.seed('accounts_sync', [
      accountRow({
        id: 'acc-del',
        label: '되살아난 이름',
        updated_at: new Date(Date.now() + 60_000).toISOString()
      })
    ])
    const result = await pullAll(deps)
    expect(result.conflicts).toBe(1)
    expect(local.accountForSync(id)?.deletedAt).not.toBeNull()
    expect(vault.listAccounts('example.com')).toEqual([])
    // 서버에 살아 있는 그 행에 삭제 표식을 다시 올리도록 변경 로그에 남았다
    expect(
      outbox.pendingFor('accounts').some((r) => r.op === 'delete' && r.rowId === String(id))
    ).toBe(true)
  })

  it('원격이 더 최신이면 덮어쓰고, 로컬이 더 최신이면 유지한다', async () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me', label: '로컬 이름' })
    const localUpdatedAt = local.accountForSync(account.id)!.updatedAt

    // 원격이 더 오래된 경우 — 로컬 값이 남는다
    backend.seed('accounts_sync', [
      accountRow({ label: '원격 이름', updated_at: new Date(localUpdatedAt - 1000).toISOString() })
    ])
    const first = await pullAll(deps)
    expect(first.conflicts).toBe(1)
    expect(local.accountForSync(account.id)?.label).toBe('로컬 이름')

    // 원격이 더 최신인 경우 — 원격 값이 이긴다
    backend.seed('accounts_sync', [
      accountRow({ label: '원격 이름', updated_at: new Date(localUpdatedAt + 1000).toISOString() })
    ])
    const second = await pullAll(deps)
    expect(second.applied).toBe(1)
    expect(local.accountForSync(account.id)?.label).toBe('원격 이름')
  })

  it('원격 금고 항목을 같은 마스터 키로 복호화해 값까지 왕복한다', async () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me' })
    const item = vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인',
      value: SECRET
    })
    await pushAll(deps)
    // 다른 기기가 받은 것처럼, 로컬 행을 지우고 원격에서 다시 내려받는다
    const remoteId = local.vaultItemForSync(item.id)!.remoteId!
    vault.deleteItem(item.id)
    outbox.clear(outbox.pending().map((r) => r.id))
    // 다른 기기 흉내 — 삭제 표식 행과 삭제 메모(되살리기 방지)를 30일 정리로 모두 걷어낸다
    local.pruneExpiredTombstones(Date.now() + TOMBSTONE_TTL_MS + 60_000)
    local.setStateNumber('pullCursor', 0)

    const result = await pullAll(deps)

    expect(result.applied).toBeGreaterThan(0)
    const restored = local.vaultItemIdByRemote(remoteId)
    expect(restored).not.toBeNull()
    expect(vault.reveal(restored!)).toBe(SECRET)
  })

  it('AAD 가 다른 행으로 바꿔치기되면 그 행만 건너뛴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sealed = vault.useMasterKey((key) => encrypt(key, '[]', vaultSyncAad('other-item')))!
    backend.seed('vault_items_sync', [
      {
        id: 'item-1',
        user_id: FAKE_USER_ID,
        workspace_id: WORKSPACE,
        account_id: null,
        type: 'note',
        label: '바꿔치기',
        fields_ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        // 다른 행의 AAD 를 그대로 붙였다
        aad: vaultSyncAad('other-item'),
        updated_at: new Date(2_000_000).toISOString(),
        deleted_at: null
      },
      goodVaultRow(vault, '정상')
    ])

    const result = await pullAll(deps)

    expect(local.vaultItemIdByRemote('item-1')).toBeNull()
    expect(local.vaultItemIdByRemote('item-2')).not.toBeNull()
    expect(result.applied).toBe(1)
    expect(warn).toHaveBeenCalledWith('금고 항목 복호화 실패(건너뜀)', 'item-1')
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/sup3rs3cret/)
    }
    warn.mockRestore()
  })

  it('금고가 잠겨 있으면 금고 항목을 건너뛰고 커서도 올리지 않는다', async () => {
    backend.seed('vault_items_sync', [goodVaultRow(vault, '메모')])
    vault.lock()

    const result = await pullAll(deps)

    expect(result.applied).toBe(0)
    expect(local.vaultItemIdByRemote('item-2')).toBeNull()
    expect(local.getStateNumber(pullCursorKey(1, 'vault_items'))).toBeNull()
  })

  it('잠금 중에 다른 표를 받아도, 해제 후 그 구간의 금고 행이 내려온다', async () => {
    // 커서가 표별로 나뉘기 전에는 계정 한 건 때문에 커서가 전진해 금고 행이 영영 누락됐다
    backend.seed('vault_items_sync', [goodVaultRow(vault, '메모')])
    backend.seed('accounts_sync', [accountRow({ updated_at: new Date(9_000_000).toISOString() })])
    vault.lock()

    await pullAll(deps)
    expect(local.accountIdByRemote('acc-1')).not.toBeNull()
    expect(local.vaultItemIdByRemote('item-2')).toBeNull()
    // 계정 표의 커서만 전진하고, 금고 표의 커서는 그대로다
    expect(cursorTs(local, 1, 'accounts')).toBe(9_000_000)
    expect(cursorTs(local, 1, 'vault_items')).toBeNull()

    await vault.unlock(MASTER)
    await pullAll(deps)

    const restored = local.vaultItemIdByRemote('item-2')
    expect(restored).not.toBeNull()
    expect(local.vaultItemForSync(restored!)?.label).toBe('메모')
    expect(cursorTs(local, 1, 'vault_items')).toBe(2_000_000)
  })

  it('옛 DB 의 단일 커서(비0)를 표별 커서가 그대로 이어받는다', async () => {
    // C2 — 2b 초기에는 커서가 하나였다. 그 값이 0 이 아닐 때 새 커서가 0 부터 다시 읽으면
    // 이미 본 구간을 통째로 다시 받는다(반대로 승계가 없으면 누락이 난다)
    local.setStateNumber(PULL_CURSOR_KEY, 5_000_000)
    // 옛 커서보다 오래된 행은 다시 내려오지 않는다
    backend.seed('accounts_sync', [
      accountRow({ id: 'acc-old', updated_at: new Date(4_000_000).toISOString() })
    ])
    backend.seed('bookmarks_sync', [
      bookmarkRow({ id: 'bm-new', updated_at: new Date(6_000_000).toISOString() })
    ])

    const result = await pullAll(deps)

    expect(local.accountIdByRemote('acc-old')).toBeNull()
    expect(local.bookmarkIdByRemote('bm-new')).not.toBeNull()
    expect(result.applied).toBe(1)
    // 승계 이후에는 (작업공간, 표) 커서에만 적힌다
    expect(cursorTs(local, 1, 'accounts')).toBe(5_000_000)
    expect(cursorTs(local, 1, 'bookmarks')).toBe(6_000_000)
  })

  it('작업공간 축이 없던 표별 커서도 이어받는다', async () => {
    local.setState(legacyTableCursorKey('bookmarks'), '5000000')
    backend.seed('bookmarks_sync', [
      bookmarkRow({ id: 'bm-old', updated_at: new Date(4_000_000).toISOString() })
    ])

    await pullAll(deps)

    expect(local.bookmarkIdByRemote('bm-old')).toBeNull()
    expect(local.getStateNumber(pullCursorKey(1, 'bookmarks'))).toBe(5_000_000)
  })

  it('같은 수정 시각을 가진 행이 페이지를 넘겨도 전부 내려온다', async () => {
    // 실검수 회귀: select 가 한 번에 N 행만 주는데 커서가 updated_at 하나뿐이라,
    // 같은 시각의 행이 페이지 경계를 넘으면 gt 커서가 그 시각을 통째로 건너뛰어
    // 나머지가 영영 내려오지 않았다(계정 607 에서 정지)
    const total = PULL_PAGE_SIZE * 2 + 200
    const sameTime = new Date(2_000_000).toISOString()
    backend.seed(
      'bookmarks_sync',
      Array.from({ length: total }, (_, i) => {
        const id = `bm-${String(i).padStart(5, '0')}`
        return bookmarkRow({ id, url: `https://page.example/${i}`, updated_at: sameTime })
      })
    )

    const result = await pullAll(deps)

    expect(result.applied).toBe(total)
    expect(local.bookmarkIdByRemote('bm-00000')).not.toBeNull()
    expect(local.bookmarkIdByRemote(`bm-${String(total - 1).padStart(5, '0')}`)).not.toBeNull()
    // 커서는 마지막 행의 (시각, id) 로 남아 다음 주기가 그 뒤부터 이어 간다
    expect(local.getState(pullCursorKey(1, 'bookmarks'))).toBe(
      `2000000:bm-${String(total - 1).padStart(5, '0')}`
    )

    // 다시 돌려도 같은 행을 또 받지 않는다
    const again = await pullAll(deps)
    expect(again.applied).toBe(0)
  })

  it('옛 숫자 커서 값도 그대로 읽어 이어 간다', async () => {
    // 커서 형식이 'ts' → 'ts:id' 로 바뀌기 전의 DB
    local.setState(pullCursorKey(1, 'bookmarks'), '5000000')
    backend.seed('bookmarks_sync', [
      bookmarkRow({ id: 'bm-old', updated_at: new Date(4_000_000).toISOString() }),
      bookmarkRow({
        id: 'bm-new',
        url: 'https://new.example',
        updated_at: new Date(6_000_000).toISOString()
      })
    ])

    await pullAll(deps)

    expect(local.bookmarkIdByRemote('bm-old')).toBeNull()
    expect(local.bookmarkIdByRemote('bm-new')).not.toBeNull()
    // 이어 간 뒤에는 새 형식으로 적힌다
    expect(local.getState(pullCursorKey(1, 'bookmarks'))).toBe('6000000:bm-new')
  })

  it('커서는 작업공간마다 따로 센다', async () => {
    // I2 — 커서에 작업공간 축이 없으면, 1번에서 커서가 T 까지 간 뒤 2번으로 옮겼을 때
    // 2번의 updated_at ≤ T 인 행이 영영 내려오지 않는다
    backend.seed('bookmarks_sync', [
      bookmarkRow({ id: 'bm-ws1', updated_at: new Date(9_000_000).toISOString() })
    ])
    await pullAll(deps)
    expect(cursorTs(local, 1, 'bookmarks')).toBe(9_000_000)

    // 2번 작업공간 — 더 오래된 행이지만 커서가 따로라 내려온다
    const ws2: PushDeps = { ...deps, workspace: () => ({ localId: 2, remoteId: 'ws-2' }) }
    backend.seed('bookmarks_sync', [
      bookmarkRow({
        id: 'bm-ws2',
        workspace_id: 'ws-2',
        url: 'https://ws2.example',
        updated_at: new Date(3_000_000).toISOString()
      })
    ])

    await pullAll(ws2)

    expect(local.bookmarkIdByRemote('bm-ws2')).not.toBeNull()
    expect(cursorTs(local, 2, 'bookmarks')).toBe(3_000_000)
  })

  it('비기본 작업공간에서도 내려받은 행이 보인다', async () => {
    // 내려받은 행에 workspace_id 를 채우지 않으면 전부 NULL 로 남아, NULL 을 함께 보는
    // 기본 작업공간에서만 보이고 2번 작업공간에서는 사라진다
    const ws2 = { localId: 2, remoteId: 'ws-2' }
    const scoped: PushDeps = { ...deps, workspace: () => ws2 }
    backend.seed('accounts_sync', [accountRow({ workspace_id: ws2.remoteId })])
    backend.seed('bookmarks_sync', [bookmarkRow({ workspace_id: ws2.remoteId })])

    await pullAll(scoped)

    vault.setWorkspaceScope({ id: 2, isDefault: false })
    expect(vault.listAccounts('example.com')).toHaveLength(1)

    const bookmarksRepo = new BookmarkRepo(db)
    bookmarksRepo.setWorkspaceScope({ id: 2, isDefault: false })
    expect(bookmarksRepo.tree().folders[0].links.map((l) => l.url)).toEqual([
      'https://remote.example'
    ])
  })

  it('다른 작업공간의 행은 아예 내려받지 않는다', async () => {
    backend.seed('accounts_sync', [accountRow({ id: 'acc-other', workspace_id: 'ws-other' })])
    backend.seed('accounts_sync', [accountRow()])

    const result = await pullAll(deps)

    expect(result.applied).toBe(1)
    expect(local.accountIdByRemote('acc-other')).toBeNull()
    expect(local.accountIdByRemote('acc-1')).not.toBeNull()
  })

  it('북마크는 양쪽 것이 둘 다 남는다', async () => {
    db.drizzle
      .insert(bookmarks)
      .values({ folderId: null, title: '로컬 북마크', url: 'https://local.example', position: 0 })
      .run()
    backend.seed('bookmarks_sync', [bookmarkRow()])

    await pullAll(deps)

    const urls = local.listBookmarksForSync().map((b) => b.url)
    expect(urls).toContain('https://local.example')
    expect(urls).toContain('https://remote.example')
  })

  it('원격 삭제 표식이 최신이면 로컬에 반영한다', async () => {
    backend.seed('accounts_sync', [accountRow()])
    await pullAll(deps)
    const id = local.accountIdByRemote('acc-1')!

    // 30일이 지나지 않은 삭제 표식이라 물리 삭제되지 않고 표식만 남는다
    const deletedAt = Date.now()
    backend.seed('accounts_sync', [
      accountRow({
        updated_at: new Date(deletedAt).toISOString(),
        deleted_at: new Date(deletedAt).toISOString()
      })
    ])
    await pullAll(deps)

    expect(local.accountForSync(id)?.deletedAt).toBe(deletedAt)
  })

  it('30일이 지난 삭제 표식은 물리 삭제한다', async () => {
    const old = Date.now() - TOMBSTONE_TTL_MS - 1000
    backend.seed('accounts_sync', [
      accountRow({
        updated_at: new Date(old).toISOString(),
        deleted_at: new Date(old).toISOString()
      })
    ])
    // 먼저 로컬에 들어가 있어야 지울 것이 생긴다
    local.applyAccount(
      {
        remoteId: 'acc-1',
        host: 'example.com',
        label: '내 계정',
        username: 'me',
        isDefault: false,
        urls: [],
        agentAccess: 'inherit',
        tags: [],
        pausedUntil: null,
        updatedAt: old,
        deletedAt: old
      },
      null
    )

    const result = await pullAll(deps)

    expect(result.pruned).toBeGreaterThan(0)
    expect(local.accountIdByRemote('acc-1')).toBeNull()
  })

  it('설정은 키별 수정 시각으로 비교해 최신 쪽을 남긴다', async () => {
    backend.seedKeyed('settings_sync', [
      {
        user_id: FAKE_USER_ID,
        workspace_id: WORKSPACE,
        key: 'language',
        value: 'en',
        updated_at: new Date(2_000_000).toISOString(),
        deleted_at: null
      }
    ])

    const result = await pullAll(deps)

    expect(result.applied).toBe(1)
    expect(deps.settings.get().language).toBe('en')
    expect(local.getStateNumber(settingUpdatedAtKey('language'))).toBe(2_000_000)

    // 같은 값이 다시 내려와도 더 오래된 것이면 적용하지 않는다
    backend.seedKeyed('settings_sync', [
      {
        user_id: FAKE_USER_ID,
        workspace_id: WORKSPACE,
        key: 'language',
        value: 'ko',
        updated_at: new Date(1_000_000).toISOString(),
        deleted_at: null
      }
    ])
    local.setStateNumber('pullCursor', 0)
    await pullAll(deps)
    expect(deps.settings.get().language).toBe('en')
  })

  it('동기화 대상이 아닌 설정 키는 무시한다', async () => {
    backend.seedKeyed('settings_sync', [
      {
        user_id: FAKE_USER_ID,
        workspace_id: WORKSPACE,
        key: 'lastUrl',
        value: 'https://evil.example',
        updated_at: new Date(2_000_000).toISOString(),
        deleted_at: null
      }
    ])

    await pullAll(deps)

    expect(deps.settings.get().lastUrl).toBe(DEFAULT_SETTINGS.lastUrl)
  })

  it('감사 로그는 어떤 경로로도 건드리지 않는다', async () => {
    const account = vault.upsertAccount({ host: 'example.com', username: 'me' })
    vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: SECRET })
    const before = db.drizzle.select().from(auditLog).all().length

    backend.seed('accounts_sync', [accountRow({ id: 'acc-9', username: 'other' })])
    backend.seed('bookmarks_sync', [bookmarkRow()])
    await pullAll(deps)

    expect(db.drizzle.select().from(auditLog).all().length).toBe(before)
    expect(backend.rows('audit_log_sync')).toHaveLength(0)
  })
})

// 이 금고의 마스터 키로 정상적으로 봉투 암호화한 원격 행
function goodVaultRow(vault: VaultService, label: string): RemoteRow {
  const id = 'item-2'
  const sealed = vault.useMasterKey((key) =>
    encrypt(key, JSON.stringify([{ key: 'main', label, fields: [] }]), vaultSyncAad(id))
  )!
  return {
    id,
    user_id: FAKE_USER_ID,
    workspace_id: WORKSPACE,
    account_id: null,
    type: 'note',
    label,
    fields_ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    aad: vaultSyncAad(id),
    updated_at: new Date(2_000_000).toISOString(),
    deleted_at: null
  }
}
