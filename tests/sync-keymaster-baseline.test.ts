// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

// 키마스터 기준 선언 — 한 PC 의 키마스터로 나머지 PC 를 맞춘다.
// 실기 2026-10-02: 옛 삭제 기록을 가진 PC 가 삭제 표식을 다시 올려 다른 PC 의 계정까지 지워졌다.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'
import { pushAll, type PushDeps, type SettingsAccess } from '../src/main/sync/push'
import { pullAll } from '../src/main/sync/pull'
import { declareKeymasterBaseline } from '../src/main/sync/authority'
import { workspaceRemoteId } from '../src/main/sync/workspace-id'
import { createFakeBackend, FAKE_USER_ID, type FakeBackend } from './stubs/fake-backend'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

const MASTER = 'master-pass-1234'

interface Pc {
  db: Db
  vault: VaultService
  deps: PushDeps
  settings: SettingsAccess
  labels: () => string[]
}

function makePc(db: Db, backend: FakeBackend): Pc {
  const outbox = new SyncOutbox(db)
  const recorder = createOutboxRecorder(db, outbox, () => 1)
  let value: Settings = { ...DEFAULT_SETTINGS }
  // 진짜 설정 저장소처럼, 바뀐 동기화 키를 변경 로그에 남긴다
  const settings: SettingsAccess = {
    get: () => value,
    set: (p: Partial<Settings>) => {
      const before = value
      value = { ...value, ...p }
      if (before.keymasterBaselineAt !== value.keymasterBaselineAt) {
        recorder('settings', 'keymasterBaselineAt', 'upsert')
      }
      return value
    },
    setFromSync: (p: Partial<Settings>) => (value = { ...value, ...p })
  }
  const vault = new VaultService(db, { get: settings.get })
  vault.setOutboxRecorder(recorder)
  vault.setWorkspaceScope({ id: 1, isDefault: true })
  const workspace = (): { localId: number; remoteId: string } => ({
    localId: 1,
    remoteId: workspaceRemoteId(db, 1, true)
  })
  return {
    db,
    vault,
    settings,
    deps: { db, backend, outbox, vault, settings, userId: FAKE_USER_ID, workspace },
    labels: () =>
      vault
        .listAccounts('example.com')
        .map((a) => a.label)
        .sort()
  }
}

// 실제 엔진의 한 주기와 같은 순서 — 먼저 받고(pull) 나서 보낸다(push)
async function sync(pc: Pc): Promise<void> {
  await pullAll(pc.deps)
  await pushAll(pc.deps)
}

function add(pc: Pc, username: string, label: string): number {
  const account = pc.vault.upsertAccount({ host: 'example.com', username, label })
  pc.vault.putItem({
    accountId: account.id,
    type: 'login',
    label: '로그인',
    value: 'pw-' + username
  })
  return account.id
}

describe('키마스터 기준 선언', () => {
  let backend: FakeBackend
  let pc1: Pc
  let pc2: Pc

  beforeEach(async () => {
    backend = createFakeBackend()
    pc1 = makePc(await openDatabase(':memory:'), backend)
    pc2 = makePc(await openDatabase(':memory:'), backend)
    await pc1.vault.setup(MASTER)
    await pushAll(pc1.deps)
    await pullAll(pc2.deps)
    expect(await pc2.vault.unlock(MASTER)).toBe(true)
    // 두 PC 가 같은 계정 셋(A·B·C)을 갖고 시작한다
    add(pc1, 'a', 'A')
    add(pc1, 'b', 'B')
    add(pc1, 'c', 'C')
    await sync(pc1)
    await sync(pc2)
    expect(pc2.labels()).toEqual(['A', 'B', 'C'])
  })

  afterEach(() => {
    pc1.vault.dispose()
    pc2.vault.dispose()
    pc1.db.close()
    pc2.db.close()
  })

  async function declare(pc: Pc, dryRun = false): ReturnType<typeof declareKeymasterBaseline> {
    return declareKeymasterBaseline(
      { db: pc.db, backend, workspace: pc.deps.workspace(), settings: pc.settings },
      { dryRun }
    )
  }

  it('미리 보기는 숫자만 돌려주고 아무것도 바꾸지 않는다', async () => {
    const before = backend.rows('accounts_sync').length
    const report = await declare(pc1, true)
    expect(report.dryRun).toBe(true)
    expect(report.accounts).toEqual({ local: 3, remoteLive: 3, remoteOnly: 0, localOnly: 0 })
    expect(pc1.settings.get().keymasterBaselineAt).toBe(0)
    expect(backend.rows('accounts_sync')).toHaveLength(before)
  })

  it('다른 PC 가 예전에 지운 계정이 기준 PC 의 계정을 지우지 못하고, 그 PC 에서 되살아난다', async () => {
    // PC2 가 B 를 지웠지만 아직 올리지 않았다(옛 삭제 기록)
    const b = pc2.vault.listAccounts('example.com').find((a) => a.label === 'B')!
    pc2.vault.deleteAccounts([b.id])
    expect(pc2.labels()).toEqual(['A', 'C'])

    await new Promise((r) => setTimeout(r, 5))
    await declare(pc1)
    await sync(pc1)
    await sync(pc2)
    await sync(pc1)

    expect(pc2.labels()).toEqual(['A', 'B', 'C'])
    expect(pc1.labels()).toEqual(['A', 'B', 'C'])
    // 되살아난 계정의 비밀번호도 기준 PC 의 것 그대로 열린다
    const revived = pc2.vault.listAccounts('example.com').find((a) => a.label === 'B')!
    const items = pc2.vault.listItems(revived.id)
    expect(items).toHaveLength(1)
    expect(pc2.vault.reveal(items[0].id)).toBe('pw-b')
  })

  it('다른 PC 에만 있던 계정(올라간 것·안 올라간 것 모두)은 그 PC 에서도 사라진다', async () => {
    // 올라간 것: PC2 가 만들고 올렸지만 PC1 은 아직 받지 않았다
    add(pc2, 'e', 'E')
    await pushAll(pc2.deps)
    // 안 올라간 것: PC2 가 만들기만 했다
    add(pc2, 'd', 'D')
    expect(pc2.labels()).toEqual(['A', 'B', 'C', 'D', 'E'])

    await new Promise((r) => setTimeout(r, 5))
    await declare(pc1)
    await sync(pc1)
    await sync(pc2)
    await sync(pc1)

    expect(pc2.labels()).toEqual(['A', 'B', 'C'])
    expect(pc1.labels()).toEqual(['A', 'B', 'C'])
  })

  it('같은 계정의 내용이 다르면 기준 PC 의 내용으로 맞춰진다', async () => {
    const a2 = pc2.vault.listAccounts('example.com').find((a) => a.label === 'A')!
    pc2.vault.upsertAccount({ id: a2.id, host: 'example.com', username: 'a', label: 'A-다른PC' })
    await pushAll(pc2.deps)

    await new Promise((r) => setTimeout(r, 5))
    await declare(pc1)
    await sync(pc1)
    await sync(pc2)

    expect(pc2.labels()).toEqual(['A', 'B', 'C'])
    expect(pc1.labels()).toEqual(['A', 'B', 'C'])
  })

  it('기준 뒤에 지운 계정은 평소대로 지워진다(삭제 기능은 살아 있다)', async () => {
    await declare(pc1)
    await sync(pc1)
    await sync(pc2)
    await new Promise((r) => setTimeout(r, 5))
    const c = pc2.vault.listAccounts('example.com').find((a) => a.label === 'C')!
    pc2.vault.deleteAccounts([c.id])
    await sync(pc2)
    await sync(pc1)
    expect(pc1.labels()).toEqual(['A', 'B'])
  })
})

describe('키마스터 기준 선언 — 기준을 모르는 옛 코드 PC', () => {
  it('예전 삭제를 뒤늦게 다시 올려도 기준 PC 의 계정은 지워지지 않고 서버도 되돌아간다', async () => {
    const backend = createFakeBackend()
    const pc1 = makePc(await openDatabase(':memory:'), backend)
    await pc1.vault.setup(MASTER)
    add(pc1, 'a', 'A')
    add(pc1, 'b', 'B')
    await sync(pc1)
    const before = Date.now() - 60_000
    await new Promise((r) => setTimeout(r, 5))
    await declareKeymasterBaseline(
      { db: pc1.db, backend, workspace: pc1.deps.workspace(), settings: pc1.settings },
      { dryRun: false }
    )
    await sync(pc1)

    // 옛 코드 PC: 기준 전에 지웠던 B 의 삭제 표식을 "지금" 시각으로 다시 올린다
    const row = backend.rows('accounts_sync').find((r) => r.username === 'b')!
    await new Promise((r) => setTimeout(r, 5))
    await backend.upsert('accounts_sync', [
      { ...row, deleted_at: new Date(before).toISOString(), updated_at: new Date().toISOString() }
    ])

    await sync(pc1)
    expect(pc1.labels()).toEqual(['A', 'B'])
    const after = backend.rows('accounts_sync').find((r) => r.username === 'b')!
    expect(after.deleted_at ?? null).toBeNull()
    pc1.vault.dispose()
    pc1.db.close()
  })
})
