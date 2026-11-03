// 다른 PC 가 먼저 설정한 계정 마스터 키에 이 PC 금고를 맞춘다(재키)
process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { VAULT_KEY_SYNC_KEYS, type VaultKeySyncKey } from '../src/shared/sync'

function settings(): { get: () => Settings } {
  return { get: () => ({ ...DEFAULT_SETTINGS }) }
}

/** 다른 PC(계정)의 금고를 만들어 그 키 재료를 꺼낸다 */
async function remoteMaterial(master: string): Promise<Partial<Record<VaultKeySyncKey, string>>> {
  const db = await openDatabase(':memory:')
  const other = new VaultService(db, settings())
  await other.setup(master)
  const out: Partial<Record<VaultKeySyncKey, string>> = {}
  for (const k of VAULT_KEY_SYNC_KEYS) {
    const v = other.readKeyMaterial(k)
    if (v !== null) out[k] = v
  }
  other.dispose()
  db.close()
  return out
}

describe('rekeyToRemote', () => {
  let db: Db
  let vault: VaultService
  const recorded: Array<[string, string, string]> = []

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, settings())
    recorded.length = 0
    vault.setOutboxRecorder((table, id, op) => recorded.push([table, id, op]))
    await vault.setup('pc-master')
  })
  afterEach(() => {
    vault.dispose()
    db.close()
  })

  it('서버 재료가 다르면 mismatch 로 보관하고, 계정 마스터로 모든 항목을 다시 잠근다', async () => {
    const account = vault.upsertAccount({
      host: 'example.com',
      label: '메인',
      username: 'alice',
      isDefault: true
    })
    const item = vault.putItem({
      accountId: account.id,
      type: 'login',
      label: '로그인',
      value: 'secret-1'
    })
    const pay = vault.putItem({
      accountId: account.id,
      type: 'password',
      label: '토스 결제',
      value: '123456'
    })
    const remote = await remoteMaterial('account-master')
    expect(vault.applyKeyMaterial(remote)).toBe('mismatch')
    expect(vault.hasPendingRemoteKey()).toBe(true)
    recorded.length = 0

    expect(await vault.rekeyToRemote('wrong')).toBe('wrong-master')
    expect(vault.reveal(item.id)).toBe('secret-1')

    expect(await vault.rekeyToRemote('account-master')).toBe('ok')
    expect(vault.hasPendingRemoteKey()).toBe(false)
    // 새 키로 곧바로 읽힌다
    expect(vault.reveal(item.id)).toBe('secret-1')
    expect(vault.reveal(pay.id)).toBe('123456')
    // 항목마다 변경 로그(서버의 옛 암호문을 덮어쓴다)
    const upserts = recorded
      .filter(([t, , op]) => t === 'vault_items' && op === 'upsert')
      .map(([, id]) => id)
      .sort()
    expect(upserts).toEqual([String(item.id), String(pay.id)].sort())
    // 잠갔다가 계정 마스터로 열린다. 옛 마스터로는 안 열린다
    vault.lock()
    expect(await vault.unlock('pc-master')).toBe(false)
    expect(await vault.unlock('account-master')).toBe(true)
    expect(vault.reveal(item.id)).toBe('secret-1')
    // 이제 서버 재료와 같다
    expect(vault.applyKeyMaterial(remote)).toBe('unchanged')
  })

  it('보관된 서버 재료가 없으면 no-remote, 잠겨 있으면 locked', async () => {
    expect(await vault.rekeyToRemote('x')).toBe('no-remote')
    const account = vault.upsertAccount({ host: 'example.com', username: 'alice' })
    vault.putItem({ accountId: account.id, type: 'login', label: '로그인', value: 'secret-1' })
    const remote = await remoteMaterial('account-master')
    vault.applyKeyMaterial(remote)
    vault.lock()
    expect(await vault.rekeyToRemote('account-master')).toBe('locked')
  })

  it('잠긴 빈 금고는 서버 재료로 바로 맞춘다', async () => {
    vault.dispose()
    db.close()
    db = await openDatabase(':memory:')
    vault = new VaultService(db, settings())
    vault.setOutboxRecorder((table, id, op) => recorded.push([table, id, op]))
    await vault.setup('pc-master')
    const remote = await remoteMaterial('account-master')
    expect(vault.applyKeyMaterial(remote)).toBe('mismatch')
    vault.lock()

    expect(await vault.rekeyToRemote('wrong')).toBe('wrong-master')
    expect(await vault.rekeyToRemote('account-master')).toBe('ok')
    vault.lock()
    expect(await vault.unlock('pc-master')).toBe(false)
    expect(await vault.unlock('account-master')).toBe(true)
  })
})
