// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

// 키마스터 삭제가 서버(Supabase)에서 권위를 갖는지 — 어느 기기에서 로그인하든 지운 계정·항목이
// 되살아나지 않아야 한다(9/30 계정 약 550개 되살아남 회귀 테스트).
// 여러 PC 가 가짜 백엔드 하나를 공유한다(네트워크 없음)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'
import { backfillOutbox, backfillSettings } from '../src/main/sync/backfill'
import { pushAll, type PushDeps, type SettingsAccess } from '../src/main/sync/push'
import { pullAll, pullCursorKey, PULL_PAGE_SIZE } from '../src/main/sync/pull'
import { SyncLocal } from '../src/main/sync/local'
import { workspaceRemoteId } from '../src/main/sync/workspace-id'
import { vaultSyncAad } from '../src/main/sync/mappers'
import { encrypt } from '../src/main/vault/crypto'
import { accounts as accountsTable, vaultItems as vaultItemsTable } from '../src/main/db/schema'
import { createFakeBackend, FAKE_USER_ID, type FakeBackend } from './stubs/fake-backend'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import type { RemoteRow } from '../src/main/sync/backend'

const MASTER = 'master-pass-1234'
const SECRET = 'sup3rs3cret!'
const HOST = 'shop.example.com'
const USER = 'buyer01'
// 옛 사본의 행이 달고 있는 옛 수정 시각(삭제보다 훨씬 전)
const OLD_AT = Date.parse('2026-09-01T00:00:00Z')

interface Pc {
  db: Db
  vault: VaultService
  outbox: SyncOutbox
  local: SyncLocal
  deps: PushDeps
  signIn: () => void
}

function makeSettings(): SettingsAccess {
  let value: Settings = { ...DEFAULT_SETTINGS }
  return {
    get: () => value,
    set: (p: Partial<Settings>) => {
      value = { ...value, ...p }
      return value
    }
  }
}

function makePc(db: Db, backend: FakeBackend, signedIn = true): Pc {
  const outbox = new SyncOutbox(db)
  const settings = makeSettings()
  const vault = new VaultService(db, { get: settings.get })
  vault.setWorkspaceScope({ id: 1, isDefault: true })
  const workspace = (): { localId: number; remoteId: string } => ({
    localId: 1,
    remoteId: workspaceRemoteId(db, 1, true)
  })
  const pc: Pc = {
    db,
    vault,
    outbox,
    local: new SyncLocal(db),
    deps: { db, backend, outbox, vault, settings, userId: FAKE_USER_ID, workspace },
    signIn: () => vault.setOutboxRecorder(createOutboxRecorder(db, outbox, () => 1))
  }
  if (signedIn) pc.signIn()
  return pc
}

/** 엔진 한 주기와 같은 순서 — 풀 → 설정 최초 업로드 → 푸시 */
async function cycle(pc: Pc): Promise<void> {
  await pullAll(pc.deps)
  backfillSettings(pc.db, pc.deps.workspace(), pc.vault)
  await pushAll(pc.deps)
}

/** 첫 PC 의 금고 키 재료를 받아 같은 마스터 비밀번호로 연다 */
async function joinVault(pc: Pc): Promise<void> {
  await pullAll(pc.deps)
  expect(await pc.vault.unlock(MASTER)).toBe(true)
}

/** 옛 사본이 새 원격 id 로 올린 같은 계정 행 */
const NEW_ID = '11111111-2222-4333-8444-555555555555'
function remoteAccount(pc: Pc, id: string, updatedAt: number): RemoteRow {
  return {
    id,
    user_id: FAKE_USER_ID,
    workspace_id: pc.deps.workspace().remoteId,
    host: HOST,
    label: USER,
    username: USER,
    is_default: false,
    urls: [],
    agent_access: 'inherit',
    tags: [],
    paused_until: null,
    updated_at: new Date(updatedAt).toISOString(),
    deleted_at: null
  }
}

/** 서버에서 이 자연 키로 살아 있는 계정 행 */
function liveRemoteAccounts(backend: FakeBackend): RemoteRow[] {
  return backend
    .rows('accounts_sync')
    .filter((r) => r.host === HOST && r.username === USER && r.deleted_at === null)
}

/** 로그아웃 상태(변경 로그 훅 없음)에서 만든 옛 계정 — 수정 시각을 옛 값으로 되돌린다 */
function makeOldCopy(pc: Pc, withItem: boolean): { accountId: number; itemId: number | null } {
  const account = pc.vault.upsertAccount({ host: HOST, username: USER })
  let itemId: number | null = null
  if (withItem) {
    itemId = pc.vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인',
      value: SECRET
    }).id
    pc.db.drizzle
      .update(vaultItemsTable)
      .set({ updatedAt: OLD_AT })
      .where(eq(vaultItemsTable.id, itemId))
      .run()
  }
  pc.db.drizzle
    .update(accountsTable)
    .set({ updatedAt: OLD_AT })
    .where(eq(accountsTable.id, account.id))
    .run()
  return { accountId: account.id, itemId }
}

describe('삭제는 서버에서 권위를 갖는다', () => {
  let backend: FakeBackend
  let pc1: Pc
  let pc2: Pc
  const extra: Pc[] = []

  beforeEach(async () => {
    backend = createFakeBackend()
    pc1 = makePc(await openDatabase(':memory:'), backend)
    pc2 = makePc(await openDatabase(':memory:'), backend)
    await pc1.vault.setup(MASTER)
    await cycle(pc1)
    await joinVault(pc2)
  })

  afterEach(() => {
    for (const pc of [pc1, pc2, ...extra.splice(0)]) {
      pc.vault.dispose()
      pc.db.close()
    }
  })

  async function freshPc(signedIn = true): Promise<Pc> {
    const pc = makePc(await openDatabase(':memory:'), backend, signedIn)
    extra.push(pc)
    return pc
  }

  it('계정 삭제는 행을 남기는 soft delete 이고, 목록에서 숨기며 서버에 삭제 표식을 올린다', async () => {
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    const item = pc1.vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인',
      value: SECRET
    })
    await cycle(pc1)
    const remoteId = pc1.local.accountForSync(account.id)!.remoteId

    pc1.vault.deleteAccounts([account.id])
    // 행은 남고 삭제 표식만 찍힌다 — UI·조회에서는 보이지 않는다
    expect(pc1.local.accountForSync(account.id)?.deletedAt).not.toBeNull()
    expect(pc1.local.vaultItemForSync(item.id)?.deletedAt).not.toBeNull()
    expect(pc1.vault.listAccounts(HOST)).toEqual([])
    expect(pc1.vault.getAccount(account.id)).toBeNull()

    await cycle(pc1)
    const remote = backend.rows('accounts_sync').find((r) => r.id === remoteId)
    expect(remote?.deleted_at).not.toBeNull()
    expect(backend.rows('vault_items_sync').every((r) => r.deleted_at !== null)).toBe(true)
  })

  it('삭제 표식을 받은 기기는 로컬에서도 지운다(항목 포함)', async () => {
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    pc1.vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: SECRET })
    await cycle(pc1)
    await cycle(pc2)
    expect(pc2.vault.listAccounts(HOST)).toHaveLength(1)
    const pc2AccountId = pc2.vault.listAccounts(HOST)[0].id

    pc1.vault.deleteAccounts([account.id])
    await cycle(pc1)
    await cycle(pc2)

    expect(pc2.vault.listAccounts(HOST)).toEqual([])
    expect(pc2.local.accountForSync(pc2AccountId)?.deletedAt).not.toBeNull()
    expect(pc2.vault.listItems(pc2AccountId)).toEqual([])
  })

  it('처음 보는 원격 id 의 삭제 표식도 같은 계정의 올라간 적 없는 옛 사본을 지운다', async () => {
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    await cycle(pc1)
    pc1.vault.deleteAccounts([account.id])
    await cycle(pc1)

    // PC3: 로그아웃 상태에서 같은 계정을 옛날에 저장해 둔 옛 사본(원격 id 없음)
    const pc3 = await freshPc(false)
    const old = makeOldCopy(pc3, false)
    await pullAll(pc3.deps)

    expect(pc3.local.accountForSync(old.accountId)?.deletedAt).not.toBeNull()
    expect(pc3.vault.listAccounts(HOST)).toEqual([])
  })

  it('다른 기기가 같은 계정을 새 원격 id 로 올려도 지운 기기에서 되살아나지 않는다 — 그 id 에 삭제 표식을 올린다', async () => {
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    await cycle(pc1)
    await cycle(pc2)
    await new Promise((r) => setTimeout(r, 5))

    // 옛 사본이 같은 계정을 **새 원격 id** 로 올렸다(원래 수정 시각 = 삭제 전)
    backend.seed('accounts_sync', [remoteAccount(pc1, NEW_ID, Date.now())])
    await new Promise((r) => setTimeout(r, 5))
    // PC1 은 그 뒤에 계정을 지웠다(아직 동기화 전)
    pc1.vault.deleteAccounts([account.id])

    // 지운 기기는 새 id 행을 삽입하지 않고, 그 원격 id 에 삭제 표식을 올린다
    await cycle(pc1)
    expect(pc1.vault.listAccounts(HOST)).toEqual([])
    expect(liveRemoteAccounts(backend)).toEqual([])

    // 다른 기기·새로 로그인한 기기에서도 되살아나지 않는다
    await cycle(pc2)
    expect(pc2.vault.listAccounts(HOST)).toEqual([])
    const pc4 = await freshPc()
    await joinVault(pc4)
    await cycle(pc4)
    expect(pc4.vault.listAccounts(HOST)).toEqual([])
  })

  it('지운 뒤 옛 수정 시각의 새 id 행이 서버에 남아도, 새로 로그인한 기기가 정리하고 서버에도 삭제 표식을 올린다', async () => {
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    await cycle(pc1)
    pc1.vault.deleteAccounts([account.id])
    await cycle(pc1)
    const deletedAt = pc1.local.accountForSync(account.id)!.deletedAt!
    // 옛 사본의 행(삭제 전 시각)이 새 id 로 서버에 있다 — 커서가 앞선 PC1 에는 내려오지 않는다
    backend.seed('accounts_sync', [remoteAccount(pc1, NEW_ID, deletedAt - 60_000)])

    const pc4 = await freshPc()
    await joinVault(pc4)
    await cycle(pc4)
    expect(pc4.vault.listAccounts(HOST)).toEqual([])
    expect(liveRemoteAccounts(backend)).toEqual([])
    // 그 뒤 로그인한 기기도 마찬가지다
    const pc5 = await freshPc()
    await joinVault(pc5)
    await cycle(pc5)
    expect(pc5.vault.listAccounts(HOST)).toEqual([])
  })

  it('계정 합치기로 지운 계정의 표식이 이름을 바꾼 남은 계정을 다른 기기에서 지우지 않는다', async () => {
    // 항목이 많은 member 쪽이 남고, 등록 도메인과 같은 호스트의 계정이 지워진다
    pc1.vault.upsertAccount({ host: 'a-rt.com', username: USER })
    const member = pc1.vault.upsertAccount({ host: 'member.a-rt.com', username: USER })
    pc1.vault.putItem({ accountId: member.id, type: 'login', label: '로그인', value: SECRET })
    await cycle(pc1)
    await cycle(pc2)
    expect(pc2.vault.listAccounts().filter((a) => a.username === USER)).toHaveLength(2)

    pc1.vault.mergeDomainAccounts('a-rt.com')
    await cycle(pc1)
    await cycle(pc2)
    const pc4 = await freshPc()
    await joinVault(pc4)
    await cycle(pc4)

    for (const pc of [pc1, pc2, pc4]) {
      const mine = pc.vault.listAccounts().filter((a) => a.username === USER)
      expect(mine.map((a) => a.host)).toEqual(['a-rt.com'])
    }
  })

  it('옛 복제본이 같은 원격 id 로 살아 있는 행을 다시 올려도, 지운 기기가 서버에 삭제 표식을 다시 올린다', async () => {
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    await cycle(pc1)
    const remoteId = pc1.local.accountForSync(account.id)!.remoteId!
    pc1.vault.deleteAccounts([account.id])
    await cycle(pc1)

    // 같은 id 로 살아 있는 행이 더 늦은 시각으로 올라왔다
    const row = backend.rows('accounts_sync').find((r) => r.id === remoteId)!
    backend.seed('accounts_sync', [
      { ...row, deleted_at: null, updated_at: new Date(Date.now() + 5_000).toISOString() }
    ])

    await cycle(pc1)
    expect(pc1.vault.listAccounts(HOST)).toEqual([])
    expect(liveRemoteAccounts(backend)).toEqual([])
    // 새로 로그인한 기기에서도 보이지 않는다
    const pc4 = await freshPc()
    await joinVault(pc4)
    await cycle(pc4)
    expect(pc4.vault.listAccounts(HOST)).toEqual([])
  })

  it('삭제 뒤에 다른 기기가 같은 원격 id 의 내용(주소)을 바꿔 다시 저장하면 지운 기기에도 되살아난다', async () => {
    // 실기 2026-10-01: 9/24 에 지운 포이즌 계정을 다른 PC 가 9/30 에 주소를 고쳐 저장했는데 이 PC 만 끝내 안 받았다
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    await cycle(pc1)
    const remoteId = pc1.local.accountForSync(account.id)!.remoteId!
    pc1.vault.deleteAccounts([account.id])
    await cycle(pc1)

    const row = backend.rows('accounts_sync').find((r) => r.id === remoteId)!
    backend.seed('accounts_sync', [
      { ...row, host: 'new.example.com', deleted_at: null, updated_at: new Date(Date.now() + 5_000).toISOString() }
    ])

    await cycle(pc1)
    expect(pc1.vault.listAccounts('new.example.com').map((a) => a.username)).toEqual([USER])
  })

  it('옛 사본의 최초 업로드는 삭제를 이기지 못한다 — 올리지 않고 로컬도 지우며, 수정 시각을 올리지 않는다', async () => {
    // PC3 는 첫 PC 와 같은 금고를 열고, 로그아웃 상태에서 계정·항목을 옛날에 저장해 두었다
    const pc3 = await freshPc(false)
    await joinVault(pc3)
    const old = makeOldCopy(pc3, true)
    // 삭제와 무관한 다른 옛 계정 — 원래 수정 시각 그대로 올라가야 한다
    const other = pc3.vault.upsertAccount({ host: 'other.example.com', username: USER })
    pc3.db.drizzle
      .update(accountsTable)
      .set({ updatedAt: OLD_AT })
      .where(eq(accountsTable.id, other.id))
      .run()

    // 그 사이 PC1 이 같은 계정을 만들었다가 지웠다
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    await cycle(pc1)
    pc1.vault.deleteAccounts([account.id])
    await cycle(pc1)

    // PC3 로그인 — 풀보다 먼저 최초 업로드가 나가도 삭제를 이기지 못한다
    pc3.signIn()
    backfillOutbox(pc3.db, pc3.deps.workspace())
    await pushAll(pc3.deps)
    await pushAll(pc3.deps)

    expect(liveRemoteAccounts(backend)).toEqual([])
    expect(pc3.local.accountForSync(old.accountId)?.deletedAt).not.toBeNull()
    expect(pc3.local.vaultItemForSync(old.itemId!)?.deletedAt).not.toBeNull()
    expect(backend.rows('vault_items_sync').filter((r) => r.deleted_at === null)).toEqual([])
    // 다른 옛 계정은 원래 수정 시각으로 올라갔다(지금으로 올리지 않는다)
    const otherRemote = backend.rows('accounts_sync').find((r) => r.host === 'other.example.com')
    expect(otherRemote && Date.parse(String(otherRemote.updated_at))).toBe(OLD_AT)
  })

  it('삭제 뒤에 사용자가 다시 저장한 계정은 새 원격 id 로 다른 기기에도 나타난다', async () => {
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    await cycle(pc1)
    await cycle(pc2)
    pc1.vault.deleteAccounts([account.id])
    await cycle(pc1)
    await cycle(pc2)
    expect(pc2.vault.listAccounts(HOST)).toEqual([])
    const oldRemoteId = pc1.local.accountForSync(account.id)!.remoteId

    // 잠시 뒤 PC2 에서 같은 계정을 다시 저장한다
    await new Promise((r) => setTimeout(r, 5))
    pc2.vault.upsertAccount({ host: HOST, username: USER })
    await cycle(pc2)
    await cycle(pc1)

    expect(pc1.vault.listAccounts(HOST)).toHaveLength(1)
    const live = liveRemoteAccounts(backend)
    expect(live).toHaveLength(1)
    expect(live[0].id).not.toBe(oldRemoteId)
  })

  it('계정 삭제 되돌리기는 새 원격 id 로 되살리고 옛 id 는 서버에서 지운 채로 둔다', async () => {
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    await cycle(pc1)
    await cycle(pc2)
    const oldRemoteId = pc1.local.accountForSync(account.id)!.remoteId
    const { token } = pc1.vault.deleteAccounts([account.id])
    await cycle(pc1)
    await cycle(pc2)
    expect(pc2.vault.listAccounts(HOST)).toEqual([])

    await new Promise((r) => setTimeout(r, 5))
    expect(pc1.vault.undoDeleteAccounts(token)).toBe(true)
    await cycle(pc1)
    await cycle(pc2)

    expect(pc1.vault.listAccounts(HOST)).toHaveLength(1)
    expect(pc2.vault.listAccounts(HOST)).toHaveLength(1)
    const live = liveRemoteAccounts(backend)
    expect(live).toHaveLength(1)
    expect(live[0].id).not.toBe(oldRemoteId)
    expect(
      backend.rows('accounts_sync').find((r) => r.id === oldRemoteId)?.deleted_at
    ).not.toBeNull()
  })

  it('금고 항목 삭제도 soft delete 이고 다른 기기에서 새 id 로 다시 올라와도 되살아나지 않는다', async () => {
    const account = pc1.vault.upsertAccount({ host: HOST, username: USER })
    const item = pc1.vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인',
      value: SECRET
    })
    await cycle(pc1)
    const accountRemoteId = pc1.local.accountForSync(account.id)!.remoteId!
    pc1.vault.deleteItem(item.id)
    expect(pc1.local.vaultItemForSync(item.id)?.deletedAt).not.toBeNull()
    expect(pc1.vault.listItems(account.id)).toEqual([])
    await cycle(pc1)
    const deletedAt = pc1.local.vaultItemForSync(item.id)!.deletedAt!

    // 옛 사본이 같은 항목(계정·종류·라벨)을 새 원격 id 로 올렸다
    const newId = '99999999-8888-4777-8666-555555555555'
    const aad = vaultSyncAad(newId)
    const sealed = pc1.vault.useMasterKey((key) => encrypt(key, '[]', aad))!
    backend.seed('vault_items_sync', [
      {
        id: newId,
        user_id: FAKE_USER_ID,
        workspace_id: pc1.deps.workspace().remoteId,
        account_id: accountRemoteId,
        type: 'login',
        label: '로그인',
        fields_ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        aad,
        updated_at: new Date(deletedAt - 60_000).toISOString(),
        deleted_at: null
      }
    ])
    // 커서가 앞선 PC1 에는 내려오지 않는다 — 다른 기기(같은 계정·항목을 받아 둔 기기)가 정리한다
    await cycle(pc1)
    expect(pc1.vault.listItems(account.id)).toEqual([])
    const pc4 = await freshPc()
    await joinVault(pc4)
    await cycle(pc4)
    expect(pc4.vault.listItems(null)).toEqual([])
    for (const a of pc4.vault.listAccounts(HOST)) expect(pc4.vault.listItems(a.id)).toEqual([])
    expect(backend.rows('vault_items_sync').find((r) => r.id === newId)?.deleted_at).not.toBeNull()
  })

  it('복호화에 실패한 행은 커서를 막지 않고, 같은 행의 경고는 한 번만 남긴다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 한 페이지를 꽉 채우는 열 수 없는 행 + 그 뒤의 정상 행
      const workspace = pc1.deps.workspace().remoteId
      const base = Date.parse('2026-09-18T00:00:00Z')
      const bad: RemoteRow[] = []
      for (let i = 0; i < PULL_PAGE_SIZE; i += 1) {
        const id = `bad-${String(i).padStart(4, '0')}`
        bad.push({
          id,
          user_id: FAKE_USER_ID,
          workspace_id: workspace,
          account_id: null,
          type: 'note',
          label: `열 수 없음 ${i}`,
          fields_ciphertext: Buffer.from('broken'),
          iv: Buffer.alloc(12),
          aad: vaultSyncAad(id),
          updated_at: new Date(base + i).toISOString(),
          deleted_at: null
        })
      }
      backend.seed('vault_items_sync', bad)
      const good = pc1.vault.putItem({
        accountId: null,
        type: 'note',
        label: '정상 메모',
        value: SECRET
      })
      await cycle(pc1)
      // PC1 자신의 풀이 남긴 경고는 세지 않는다
      warn.mockClear()

      const decryptWarns = (): number =>
        warn.mock.calls.filter((c) => c[0] === '금고 항목 복호화 실패(건너뜀)').length

      const first = await pullAll(pc2.deps)
      expect(first.vaultDecryptFailed).toBe(true)
      expect(decryptWarns()).toBe(PULL_PAGE_SIZE)
      // 정상 행까지 내려왔다 — 열 수 없는 행 한 페이지가 커서를 막지 않는다
      const pulled = pc2.vault.listItems(null).find((i) => i.label === '정상 메모')
      expect(pulled).toBeDefined()
      expect(pc2.vault.reveal(pulled!.id)).toBe(SECRET)
      const cursor = pc2.local.getState(pullCursorKey(1, 'vault_items'))
      expect(cursor).not.toBeNull()
      expect(cursor).not.toContain('bad-')

      // 다음 주기 — 같은 행은 다시 받지도, 다시 경고하지도 않는다
      const second = await pullAll(pc2.deps)
      expect(second.vaultDecryptFailed).toBe(false)
      expect(decryptWarns()).toBe(PULL_PAGE_SIZE)
      expect(pc2.local.getState(pullCursorKey(1, 'vault_items'))).toBe(cursor)
      expect(good.id).toBeGreaterThan(0)
    } finally {
      warn.mockRestore()
    }
  })
})
