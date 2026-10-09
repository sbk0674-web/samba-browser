// 속도를 위해 테스트에서는 argon2id 메모리를 낮춘다 (import 전에 설정)
process.env.VAULT_KDF_MEM = '8192'

// 동기화 엔진 — 즉시 1회 + 60초 폴링 + Realtime 구독 + 상태 통지

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'
import { SyncEngine, SyncEngineHolder, SYNC_POLL_INTERVAL_MS, REALTIME_DEBOUNCE_MS } from '../src/main/sync/engine'
import type { SettingsAccess } from '../src/main/sync/push'
import { createFakeBackend, FAKE_USER_ID, type FakeBackend } from './stubs/fake-backend'
import { SYNC_TABLES, type SyncStatus } from '../src/shared/sync'
import { remoteTableOf } from '../src/main/sync/mappers'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

const MASTER = 'master-pass-1234'
const WORKSPACE = '00000000-0000-4000-8000-0000000000ws'

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

describe('SyncEngine', () => {
  let db: Db
  let vault: VaultService
  let outbox: SyncOutbox
  let backend: FakeBackend
  let engine: SyncEngine
  let authExpired: number

  beforeEach(async () => {
    vi.useFakeTimers()
    db = await openDatabase(':memory:')
    outbox = new SyncOutbox(db)
    backend = createFakeBackend()
    authExpired = 0
    const settings = makeSettings()
    vault = new VaultService(db, { get: settings.get })
    vault.setOutboxRecorder(createOutboxRecorder(db, outbox))
    await vault.setup(MASTER)
    // 금고 설정이 남기는 마스터 키 재료 변경 로그는 이 파일의 관심사가 아니다
    // (키 재료 동기화는 sync-two-pcs 가 다룬다). 대기 건수 단언을 흐리지 않게 비운다
    outbox.clear(outbox.pendingFor('settings').map((r) => r.id))
    engine = new SyncEngine({
      db,
      backend,
      outbox,
      vault,
      settings,
      userId: FAKE_USER_ID,
      workspace: () => ({ localId: 1, remoteId: WORKSPACE }),
      onAuthExpired: () => {
        authExpired += 1
      }
    })
  })

  afterEach(() => {
    engine.stop()
    vault.dispose()
    db.close()
    vi.useRealTimers()
  })

  it('start() 하면 즉시 1회 동기화한다', async () => {
    engine.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.calls.select).toBeGreaterThan(0)
    expect(engine.status().online).toBe(true)
  })

  it('60초마다 한 번씩 더 돈다', async () => {
    engine.start()
    await vi.advanceTimersByTimeAsync(0)
    const first = backend.calls.select

    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)
    const second = backend.calls.select
    expect(second).toBeGreaterThan(first)

    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)
    expect(backend.calls.select).toBeGreaterThan(second)
  })

  it('Realtime 구독이 전부 살아 있어도 주기 폴링은 서버 변경을 당긴다(놓친 알림 복구)', async () => {
    engine.start()
    await vi.advanceTimersByTimeAsync(0)
    for (const t of SYNC_TABLES) backend.realtime(remoteTableOf(t), true)
    await vi.advanceTimersByTimeAsync(0)
    const live = backend.calls.select
    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 2)
    expect(engine.realtimeLive()).toBe(true)
    // 알림이 하나도 오지 않았어도 폴링이 두 번 당겼다 — 놓친 삭제를 폴링이 받는다
    expect(backend.calls.select).toBeGreaterThan(live)

    backend.realtime('accounts_sync', false)
    await vi.advanceTimersByTimeAsync(0)
    backend.realtime('accounts_sync', true)
    await vi.advanceTimersByTimeAsync(0)
    const afterRejoin = backend.calls.select
    expect(afterRejoin).toBeGreaterThan(live) // 끊겼다 다시 붙는 순간에도 한 번 당긴다
  })

  it('stop() 뒤에는 더 돌지 않는다', async () => {
    engine.start()
    await vi.advanceTimersByTimeAsync(0)
    engine.stop()
    const after = backend.calls.select

    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 3)

    expect(backend.calls.select).toBe(after)
    expect(engine.status().online).toBe(false)
  })

  it('인증이 만료되면 콜백을 1회 부르고 오프라인으로 표시한다', async () => {
    backend.expireAuth()
    engine.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(authExpired).toBe(1)
    expect(engine.status().online).toBe(false)
    expect(engine.status().lastError).toContain('JWT expired')

    // 다음 주기에도 같은 알림을 반복하지 않는다
    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)
    expect(authExpired).toBe(1)
  })

  it('오프라인이면 변경 로그를 보존하고, 다음 주기에 다시 보낸다', async () => {
    vault.upsertAccount({ host: 'example.com', username: 'me' })
    backend.failWith(new Error('연결 실패'))

    engine.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.status().online).toBe(false)
    expect(engine.status().pending).toBe(1)

    backend.failWith(null)
    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)

    expect(engine.status().online).toBe(true)
    expect(engine.status().pending).toBe(0)
    expect(backend.rows('accounts_sync')).toHaveLength(1)
  })

  it('Realtime 구독이 실패해도 start() 는 성공하고 폴링은 계속된다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    backend.subscribe = () => Promise.reject(new Error('Realtime 사용 불가'))

    expect(() => engine.start()).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    const first = backend.calls.select

    await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS)

    expect(backend.calls.select).toBeGreaterThan(first)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('Realtime 알림은 잠깐 모았다가 한 번만 동기화한다(전송량 절약)', async () => {
    engine.start()
    await vi.advanceTimersByTimeAsync(0)
    const before = backend.calls.select

    backend.fire('accounts_sync')
    backend.fire('accounts_sync')
    backend.fire('accounts_sync')
    await vi.advanceTimersByTimeAsync(0)
    expect(backend.calls.select).toBe(before)

    await vi.advanceTimersByTimeAsync(REALTIME_DEBOUNCE_MS)
    const once = backend.calls.select
    expect(once).toBeGreaterThan(before)

    // 세 번 알림이 와도 한 주기만 돈다
    await vi.advanceTimersByTimeAsync(REALTIME_DEBOUNCE_MS)
    expect(backend.calls.select).toBe(once)
  })

  it('상태가 바뀌면 구독자에게 알린다(비밀값 없음)', async () => {
    const seen: SyncStatus[] = []
    engine.onStatusChanged((s) => seen.push(s))

    engine.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toMatchObject({ online: true, pending: 0 })
    expect(Object.keys(seen[0])).toEqual(
      expect.arrayContaining(['online', 'pending', 'lastPulledAt'])
    )
  })
})

describe('SyncEngineHolder', () => {
  it('엔진이 붙기 전에는 오프라인 상태를 돌려준다', async () => {
    const holder = new SyncEngineHolder()
    expect(holder.status()).toEqual({ online: false, pending: 0, lastPulledAt: null })
    expect(await holder.syncNow()).toEqual({ online: false, pending: 0, lastPulledAt: null })
    expect(holder.current()).toBeNull()
  })
})
