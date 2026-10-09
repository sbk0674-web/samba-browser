// 동기화 엔진 — 60초 폴링 + Realtime 구독 + 상태 통지.
//
// Realtime 은 "있으면 좋은" 기능이다. 구독이 실패해도 start() 는 성공하고 폴링은 계속 돈다.
// 인증 만료(401·기기 원격 로그아웃)는 상태로만 알리고, 로그아웃·금고 잠금은 호출부가 한다

import type { SyncStatus } from '../../shared/sync'
import { SYNC_TABLES, VAULT_KEY_MISMATCH_ERROR } from '../../shared/sync'
import { AuthExpiredError } from './backend'
import { SyncLocal } from './local'
import { remoteTableOf } from './mappers'
import { LAST_PULLED_AT_KEY, pullAll, type PullResult } from './pull'
import { pushAll, type PushDeps } from './push'

// 폴링은 Realtime 이 못 받은 변경을 줍는 보험이다 — 1분 폴링이 PC 여러 대에서 돌며 Supabase 무료 한도(Egress·Log)를
// 넘겼다(2026-10-06, 10/8 제한 예고). Realtime(publication 등록) 뒤로는 5분이면 충분하다
// 5분 — 60초 폴링(PC 여러 대 × 표 7개)에 Realtime 알림마다 전체 당기기가 겹쳐 Supabase 무료 전송량(5GB)을
// 세 배 가까이 넘겨 서비스가 정지됐다(2026-10-09 egress 14.8GB). 놓친 알림을 메우는 안전망이라 5분이면 충분하다
export const SYNC_POLL_INTERVAL_MS = 300_000
// Realtime 알림이 몰려 오면(채팅 메시지 연속 저장) 모아서 한 번만 당긴다
export const REALTIME_DEBOUNCE_MS = 3_000
// Realtime 이 살아 있으면 폴링은 이 간격으로만 전체를 당긴다(놓친 알림 보험). 그사이 폴링은 대기 중인 푸시만 한다.
// 10/6 에 이 장치로 한도를 막아 두었는데 10/8 에 '항상 당기기'로 되돌려 다음 날 egress 14.8GB 로 정지됐다
export const LIVE_FULL_PULL_INTERVAL_MS = 30 * 60_000
// 하루 내려받는 양(조회 결과 + Realtime 알림 본문)의 상한 — 넘으면 그날은 아래 간격으로만 당긴다.
// 무료 한도 5GB/월 ÷ PC 3~4대 ÷ 30일 ≈ 40MB. 원인이 무엇이든 한도를 다시 넘지 않게 하는 마지막 장치다
export const EGRESS_DAILY_BUDGET_BYTES = 40 * 1024 * 1024
export const OVER_BUDGET_PULL_INTERVAL_MS = 60 * 60_000
const EGRESS_DAY_KEY = 'egress:day'
const EGRESS_BYTES_KEY = 'egress:bytes'

/** 받은 값의 대략적인 바이트 수(JSON 길이) */
function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

function localDay(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export interface EngineDeps extends PushDeps {
  /**
   * 주기마다 맨 앞에서 불린다(기기 heartbeat·원격 로그아웃 확인).
   * 여기서 AuthExpiredError 를 던지면 아래 인증 만료 경로와 똑같이 처리된다
   */
  onCycleStart?: () => Promise<void>
  /**
   * 풀이 끝나고 푸시가 시작되기 **전에** 불린다.
   * 설정 최초 업로드가 여기 붙는다 — "서버에 이 키가 있었는가" 는 풀을 한 번 돌려 봐야
   * 알 수 있고, 여기서 변경 로그에 얹으면 바로 이어지는 푸시가 같은 주기에 보낸다(C1)
   */
  // 풀 결과를 넘긴다 — 키 재료 불일치 주기에는 호출부가 키 재료 업로드를 건너뛰어야 한다
  onAfterPull?: (pulled: PullResult) => void
  /**
   * 인증이 만료됐을 때 한 번 불린다. 로그아웃·금고 잠금 연결은 호출부(Task 9)가 한다 —
   * 엔진은 여기서 아무것도 스스로 정리하지 않는다
   */
  // firstCycle: 시작 후 첫 동기화 주기에서 만료됐는가(저장된 세션이 오래된 경우) —
  // 연결부는 이때 금고를 잠그지 않는다
  onAuthExpired?: (info: { firstCycle: boolean }) => void
}

export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribers: (() => void)[] = []
  private listeners = new Set<(status: SyncStatus) => void>()
  private inFlight: Promise<SyncStatus> | null = null
  private started = false
  private online = false
  private lastError: string | undefined
  // 만료를 알린 뒤 다시 성공할 때까지는 같은 알림을 반복하지 않는다
  private authExpiredNotified = false
  // 완료한 동기화 주기 수(첫 주기 판정용)
  private cyclesDone = 0
  // Realtime 구독이 살아 있는 표. 전부 살아 있으면 주기 폴링은 당기지 않는다(변경은 구독으로 바로 온다) —
  // 폴링은 구독이 끊긴 동안의 보험일 뿐이다(사용자 2026-10-06 "실시간이면 왜 5분마다 당기냐")
  private liveTables = new Set<string>()
  private readonly local: SyncLocal
  private readonly deps: EngineDeps

  constructor(
    deps: EngineDeps,
    private readonly now: () => number = () => Date.now()
  ) {
    this.local = new SyncLocal(deps.db)
    this.deps = { ...deps, backend: this.metered(deps.backend) }
  }

  /** 조회 결과의 크기를 하루 사용량에 더한다 — 서버 한도(egress)를 앱이 스스로 지킨다 */
  private metered(backend: EngineDeps['backend']): EngineDeps['backend'] {
    const count = <T>(p: Promise<T>): Promise<T> =>
      p.then((rows) => {
        this.addEgress(sizeOf(rows))
        return rows
      })
    return {
      ...backend,
      select: (...a: Parameters<typeof backend.select>) => count(backend.select(...a)),
      selectKeyed: (...a: Parameters<typeof backend.selectKeyed>) =>
        count(backend.selectKeyed(...a)),
      selectAll: (...a: Parameters<typeof backend.selectAll>) => count(backend.selectAll(...a)),
      selectDeleted: (...a: Parameters<typeof backend.selectDeleted>) =>
        count(backend.selectDeleted(...a)),
      // 나머지는 부를 때마다 원래 객체로 넘긴다(바뀐 구현도 그대로 따른다)
      upsert: (...a: Parameters<typeof backend.upsert>) => backend.upsert(...a),
      remove: (...a: Parameters<typeof backend.remove>) => backend.remove(...a),
      upsertKeyed: (...a: Parameters<typeof backend.upsertKeyed>) => backend.upsertKeyed(...a),
      subscribe: (...a: Parameters<typeof backend.subscribe>) => backend.subscribe(...a),
      rpcNumber: (...a: Parameters<typeof backend.rpcNumber>) => backend.rpcNumber(...a)
    }
  }

  private addEgress(bytes: number): void {
    if (bytes <= 0) return
    const day = localDay(this.now())
    const sameDay = this.local.getState(EGRESS_DAY_KEY) === day
    const used = sameDay ? (this.local.getStateNumber(EGRESS_BYTES_KEY) ?? 0) : 0
    if (!sameDay) this.local.setState(EGRESS_DAY_KEY, day)
    this.local.setStateNumber(EGRESS_BYTES_KEY, used + bytes)
  }

  /** 오늘 내려받은 양이 상한을 넘었는가 */
  overBudget(): boolean {
    if (this.local.getState(EGRESS_DAY_KEY) !== localDay(this.now())) return false
    return (this.local.getStateNumber(EGRESS_BYTES_KEY) ?? 0) >= EGRESS_DAILY_BUDGET_BYTES
  }

  /** 이번 주기에 원격을 당길지 — 폴링·Realtime 은 간격·사용량을 보고, 사용자 동작(직접 호출)은 늘 당긴다 */
  private shouldPull(opts: { poll?: boolean; realtime?: boolean }): boolean {
    const last = this.local.getStateNumber(LAST_PULLED_AT_KEY) ?? 0
    const since = this.now() - last
    if (this.overBudget()) {
      if (since < OVER_BUDGET_PULL_INTERVAL_MS) return false
      return opts.poll === true || opts.realtime !== true
    }
    if (opts.poll && this.realtimeLive()) return since >= LIVE_FULL_PULL_INTERVAL_MS
    return true
  }

  /** 즉시 1회 동기화하고, 5분 주기 폴링과 Realtime 구독을 건다 */
  start(): void {
    if (this.started) return
    this.started = true
    void this.syncNow()
    this.timer = setInterval(() => {
      void this.syncNow({ poll: true })
    }, SYNC_POLL_INTERVAL_MS)
    this.timer.unref?.()
    void this.subscribeAll()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe()
      } catch (e: unknown) {
        console.warn('Realtime 구독 해제 실패', e instanceof Error ? e.message : String(e))
      }
    }
    this.unsubscribers = []
    this.online = false
    this.emit()
  }

  status(): SyncStatus {
    return {
      online: this.online,
      pending: this.deps.outbox.count(),
      lastPulledAt: this.local.getStateNumber(LAST_PULLED_AT_KEY),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError })
    }
  }

  /**
   * 지금 한 번 동기화한다. 이미 돌고 있으면 그 결과를 함께 기다린다.
   * poll: 주기 폴링에서 온 호출. Realtime 이 살아 있어도 항상 당긴다 — 알림 한 번을 놓치면 그 변경을 영영 못 받는다
   * (2026-10-08 2호기에서 지운 계정이 1호기에 8분 넘게 남았다). 당기기는 커서 이후만 받아 가볍다
   */
  syncNow(opts: { poll?: boolean; realtime?: boolean } = {}): Promise<SyncStatus> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runOnce(opts).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** 동기화 표 전부의 Realtime 구독이 살아 있는가 */
  realtimeLive(): boolean {
    return SYNC_TABLES.every((t) => this.liveTables.has(t))
  }

  onStatusChanged(fn: (status: SyncStatus) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private async runOnce(opts: { poll?: boolean; realtime?: boolean } = {}): Promise<SyncStatus> {
    try {
      await this.deps.onCycleStart?.()
      if (!this.shouldPull(opts)) {
        // 당기지 않는 주기 — 대기 중인 로컬 변경만 보낸다(전송량 절약)
        if (this.deps.outbox.count() > 0) await pushAll(this.deps, {})
        this.online = true
        this.authExpiredNotified = false
        this.cyclesDone += 1
        const status = this.status()
        this.emit(status)
        return status
      }
      // 먼저 받고(pull) 나서 보낸다(push) — 로컬 변경이 원격 최신본 위에 얹히도록
      const pulled = await pullAll(this.deps)
      this.deps.onAfterPull?.(pulled)
      await pushAll(this.deps, { skipVaultItems: pulled.vaultKeyMismatch })
      this.online = true
      // 키 재료 불일치는 통신 실패가 아니다 — 연결은 살아 있고 경고만 상태에 싣는다
      this.lastError = pulled.vaultKeyMismatch ? VAULT_KEY_MISMATCH_ERROR : undefined
      this.authExpiredNotified = false
    } catch (e: unknown) {
      this.online = false
      // 예외 메시지만 담는다 — 스택·페이로드는 담지 않는다
      this.lastError = e instanceof Error ? e.message : String(e)
      if (e instanceof AuthExpiredError && !this.authExpiredNotified) {
        this.authExpiredNotified = true
        this.deps.onAuthExpired?.({ firstCycle: this.cyclesDone === 0 })
      }
    }
    this.cyclesDone += 1
    const status = this.status()
    this.emit(status)
    return status
  }

  private async subscribeAll(): Promise<void> {
    for (const table of SYNC_TABLES) {
      try {
        const unsubscribe = await this.deps.backend.subscribe(
          remoteTableOf(table),
          (bytes?: number) => {
            // 알림 본문도 서버 전송량이다
            this.addEgress(bytes ?? 0)
            this.scheduleRealtimeSync()
          },
          (live) => {
            const wasLive = this.realtimeLive()
            if (live) this.liveTables.add(table)
            else this.liveTables.delete(table)
            // 끊겼다 다시 붙으면 그사이 놓친 변경을 한 번 당긴다
            if (!wasLive && this.realtimeLive()) void this.syncNow()
          }
        )
        // stop() 이 먼저 불렸다면 방금 건 구독을 바로 푼다
        if (!this.started) unsubscribe()
        else this.unsubscribers.push(unsubscribe)
      } catch (e: unknown) {
        console.warn(
          'Realtime 구독 실패(폴링으로 계속)',
          e instanceof Error ? e.message : String(e)
        )
      }
    }
  }

  private realtimeTimer: ReturnType<typeof setTimeout> | null = null

  /** Realtime 알림은 바로 당기지 않고 잠깐 모은다 — 알림 하나마다 표 7개를 다시 조회하던 것이 전송량을 키웠다 */
  private scheduleRealtimeSync(): void {
    if (this.realtimeTimer) return
    this.realtimeTimer = setTimeout(() => {
      this.realtimeTimer = null
      if (this.started) void this.syncNow({ realtime: true })
    }, REALTIME_DEBOUNCE_MS)
    this.realtimeTimer.unref?.()
  }

  private emit(status: SyncStatus = this.status()): void {
    for (const fn of this.listeners) fn(status)
  }
}

/** 엔진이 붙기 전(로그아웃 상태)의 기본 상태 */
export function offlineStatus(): SyncStatus {
  return { online: false, pending: 0, lastPulledAt: null }
}

/**
 * 엔진은 로그인 이후에 만들어진다. IPC 는 앱 시작 시 한 번만 등록되므로,
 * 그 사이를 이어 주는 자리다 — 붙기 전에도 상태를 답할 수 있다
 */
export class SyncEngineHolder {
  private engine: SyncEngine | null = null
  private listeners = new Set<(status: SyncStatus) => void>()
  private detach: (() => void) | null = null

  attach(engine: SyncEngine): void {
    this.release()
    this.engine = engine
    this.detach = engine.onStatusChanged((status) => {
      for (const fn of this.listeners) fn(status)
    })
  }

  release(): void {
    this.detach?.()
    this.detach = null
    this.engine = null
    const status = offlineStatus()
    for (const fn of this.listeners) fn(status)
  }

  current(): SyncEngine | null {
    return this.engine
  }

  status(): SyncStatus {
    return this.engine ? this.engine.status() : offlineStatus()
  }

  async syncNow(): Promise<SyncStatus> {
    return this.engine ? this.engine.syncNow() : offlineStatus()
  }

  onStatusChanged(fn: (status: SyncStatus) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}
