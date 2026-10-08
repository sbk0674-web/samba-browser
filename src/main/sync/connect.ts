// 로그인 ↔ 동기화 엔진 연결.
//
// 지금까지 조각들(인증·기기·변경 로그·엔진)은 서로를 모른 채 따로 있었다. 이 파일이
// 그 사이를 잇는다.
//
//   로그인  → 기기 등록 → AuthState.deviceId 채우기 → 저장소에 변경 로그 훅 부착
//            → 엔진 생성·시작 → holder 에 부착
//   로그아웃/토큰 만료/기기 원격 로그아웃
//          → 엔진 정지 → 훅 해제 → 금고 잠금 → 로그아웃 상태로
//
// 변경 로그 훅은 **로그인 상태에서만** 붙는다. 로그아웃 상태에서 한 변경은 쌓이지 않는다
// (이미 쌓인 sync_outbox 는 지우지 않는다 — 재로그인 시 그대로 전송된다)

import type { OutboxRecorder, AuthState, SyncStatus } from '../../shared/sync'
import type { Db } from '../db/client'
import type { AuthService } from './auth'
import { backfillOutbox, backfillSettings, backfillTotal, verifyBackfill } from './backfill'
import { AuthExpiredError, type SyncBackend } from './backend'
import { DeviceRevokedError, DeviceService } from './devices'
import { tr } from '../i18n'
import { SyncEngine, SyncEngineHolder } from './engine'
import { SyncLocal } from './local'
import { createOutboxRecorder, settingUpdatedAtKey, SyncOutbox } from './outbox'
import { VAULT_KEY_SYNC_KEYS } from '../../shared/sync'
import type { SettingsAccess, VaultAccess, WorkspaceRef } from './push'

/** 변경 로그 훅을 받아 주는 저장소(금고·설정·북마크가 모두 이 모양이다) */
export interface OutboxTarget {
  setOutboxRecorder(recorder: OutboxRecorder | null): void
}

/** VaultService 가 그대로 만족한다 */
export type SyncVaultTarget = VaultAccess &
  OutboxTarget & {
    lock(): void
    /** 로그아웃 상태에서 설정된 금고의 키 재료를 뒤늦게 기록한다(없으면 건너뛴다) */
    ensureKeyMaterialRecorded?: () => void
  }
/** SettingsStore 가 그대로 만족한다 */
export type SyncSettingsTarget = SettingsAccess & OutboxTarget

export interface SyncConnectionDeps {
  db: Db
  /** .env 가 비어 있으면 null — 이때는 아무것도 연결하지 않는다 */
  backend: SyncBackend | null
  auth: AuthService
  holder: SyncEngineHolder
  vault: SyncVaultTarget
  settings: SyncSettingsTarget
  /** 북마크 저장소(ImportService 가 위임한다) */
  bookmarks: OutboxTarget
  /** AI 채팅 저장소. 없으면 채팅은 동기화되지 않는다(옛 테스트 호환) */
  chats?: OutboxTarget
  /** 지금 활성 작업공간(로컬 id + 원격 uuid). 주기마다 다시 불린다 */
  workspace: () => WorkspaceRef
  /** 기기 표시 정보 — 테스트에서는 주입한다 */
  device: { hostname: () => string; osLabel: () => string; appVersion: () => string }
  /** 서버 키 재료가 이 PC 와 다를 때(주기마다) — 계정 서비스가 비밀번호로 자동으로 맞춘다 */
  onVaultKeyMismatch?: () => void
}

export class SyncConnection {
  private readonly outbox: SyncOutbox
  /** 지금 쓰는 백엔드. 계정에서 주소를 내려받으면 setBackend 로 바뀐다 */
  private backend: SyncBackend | null
  private engine: SyncEngine | null = null
  private deviceService: DeviceService | null = null
  /** 시작이 겹치지 않게 막는다(상태 통지가 연달아 올 수 있다) */
  private starting: Promise<void> | null = null
  /**
   * 정리 중인가. 정리 도중의 setDeviceId(null)·markExpired() 가 다시 상태 통지를 일으켜
   * 같은 정리를 재귀로 부르거나(더 나쁘게는) 엔진을 다시 세우는 것을 막는다
   */
  private closing = false

  constructor(private readonly deps: SyncConnectionDeps) {
    this.outbox = new SyncOutbox(deps.db)
    this.backend = deps.backend
    this.deps.auth.onStateChanged((state) => {
      void this.apply(state)
    })
  }

  /** 데이터 백엔드를 바꾼다. 돌던 엔진은 세우고(금고는 잠그지 않는다) 다음 로그인 때 새 백엔드로 뜬다 */
  setBackend(backend: SyncBackend | null): void {
    if (this.backend === backend) return
    this.lockOnNextTeardown = false
    this.teardown()
    this.backend = backend
  }

  /** 설정 화면의 기기 목록이 쓴다. 로그아웃 상태면 null */
  devices(): DeviceService | null {
    return this.deviceService
  }

  /**
   * 수동 "지금 동기화". 최초 업로드가 놓친 행이 있으면 먼저 보충하고 한 주기를 돈다 —
   * 사용자가 "안 올라간 것 같다" 고 느꼈을 때 누르는 버튼이라, 여기서 한 번 더 훑어 준다
   */
  async syncNow(): Promise<SyncStatus> {
    if (this.engine) this.runBackfill(verifyBackfill)
    return this.deps.holder.syncNow()
  }

  /** 지금 인증 상태를 한 번 반영한다(세션 복구가 먼저 끝난 경우) */
  async refresh(): Promise<void> {
    await this.apply(this.deps.auth.state())
  }

  /** 창이 닫힐 때 — 엔진만 세운다(금고 잠금·DB 정리는 종료 경로가 따로 한다) */
  dispose(): void {
    this.engine?.stop()
    this.engine = null
    this.deviceService = null
    this.deps.holder.release()
    this.detachRecorders()
  }

  private async apply(state: AuthState): Promise<void> {
    if (this.closing) return
    if (state.signedIn) await this.startEngine()
    else this.teardown()
  }

  private async startEngine(): Promise<void> {
    const backend = this.backend
    if (!backend || this.engine || this.starting) return
    this.starting = this.run(backend).finally(() => {
      this.starting = null
    })
    await this.starting
  }

  private async run(backend: SyncBackend): Promise<void> {
    try {
      const user = await backend.currentUser()
      if (!user) return
      const devices = new DeviceService({
        backend,
        db: this.deps.db,
        userId: user.userId,
        ...this.deps.device
      })
      let deviceId: string
      try {
        deviceId = await devices.ensureRegistered()
      } catch (e: unknown) {
        // 취소된 기기가 재시작·세션 복원으로 되살아나면 안 된다 → 즉시 로그아웃·잠금
        if (e instanceof DeviceRevokedError) {
          this.expire('revoked')
          return
        }
        throw e
      }
      this.deviceService = devices
      this.deps.auth.setDeviceId(deviceId)
      this.attachRecorders()
      // 로그인 전부터 있던 데이터를 변경 로그에 얹는다(작업공간마다 1회) — 이게 없으면
      // 로그인 이후의 변경만 올라가, 두 번째 PC 는 기존 데이터를 영영 받지 못한다
      this.runBackfill(backfillOutbox)
      const engine = new SyncEngine({
        db: this.deps.db,
        backend,
        outbox: this.outbox,
        vault: this.deps.vault,
        settings: this.deps.settings,
        userId: user.userId,
        // 값이 아니라 함수로 넘긴다 — 작업공간을 바꿔도 엔진을 다시 세울 필요가 없다
        workspace: this.deps.workspace,
        // 주기마다 이 PC 가 아직 살아 있다고 알리고, 원격 로그아웃 여부를 확인한다
        onCycleStart: async () => {
          // 작업공간을 바꾸면 엔진을 다시 세우지 않는다 — 새 작업공간의 최초 업로드는
          // 여기서 챙긴다(이미 끝난 작업공간이면 플래그만 읽고 곧바로 빠져나온다)
          this.runBackfill(backfillOutbox)
          await devices.heartbeat()
          // (이어서) 풀이 끝나면 onAfterPull 이 설정 최초 업로드를 챙긴다
          if (await devices.isRevoked()) {
            throw new AuthExpiredError(tr('sync.deviceLoggedOutRemotely'))
          }
        },
        // 설정은 최초 업로드에서 빼 두고, **풀을 한 번 돌린 뒤** 서버에 없던 키만 올린다.
        // 로그인 직후 곧바로 올리면 두 번째 PC 의 첫 로그인이 첫 PC 의 설정을
        // 자기 기본값으로 덮어쓴다(3차 리뷰 C1)
        onAfterPull: (pulled) => {
          // 키 재료 불일치면 setup 이 미리 넣어 둔 salt/verifier 항목도 걷어낸다 —
          // 그대로 푸시하면 첫 PC 의 금고를 다른 PC 에서 못 열게 된다(4차 리뷰 N1)
          if (pulled.vaultKeyMismatch) {
            this.outbox.dropPendingSettingKeys(VAULT_KEY_SYNC_KEYS)
            this.deps.onVaultKeyMismatch?.()
          }
          this.runBackfill((db, ws, vault) =>
            backfillSettings(db, ws, vault, { skipKeyMaterial: pulled.vaultKeyMismatch })
          )
        },
        onAuthExpired: ({ firstCycle }) => {
          this.expire(firstCycle ? 'startup' : 'token')
        }
      })
      this.engine = engine
      this.deps.holder.attach(engine)
      engine.start()
    } catch (e: unknown) {
      // 연결에 실패해도 앱은 로컬 전용으로 계속 돈다. 사유만 남긴다(토큰·값 없음)
      console.error('동기화 연결 실패', e instanceof Error ? e.message : String(e))
      this.lockOnNextTeardown = false
      this.teardown()
    }
  }

  /** 토큰 만료·기기 원격 로그아웃 — 서버를 부르지 않고 로컬만 로그아웃한다 */
  // 다음 teardown 에서 금고를 잠글지. 사용자의 로그아웃이면 잠그고,
  // 토큰 만료·연결 실패처럼 사용자가 한 일이 아니면 잠그지 않는다 —
  // 앱 시작 직후 세션 갱신이 실패하면 기기 키로 열어 둔 금고가 매번 도로 잠겼다(실기)
  private lockOnNextTeardown = true

  /**
   * 인증 만료 처리. 첫 동기화 주기의 만료는 "저장된 세션이 오래됐다"는 뜻이라 금고를 잠글 이유가 없다
   * (기기 키로 열어 둔 금고가 켤 때마다 도로 잠겼다). 그 뒤의 만료·원격 기기 취소는 정상대로 잠근다
   */
  private expire(reason: 'token' | 'revoked' | 'startup' = 'token'): void {
    if (reason === 'startup') this.lockOnNextTeardown = false
    this.teardown()
    this.closing = true
    try {
      this.deps.auth.markExpired()
    } finally {
      this.closing = false
    }
  }

  private teardown(): void {
    const hadEngine = this.engine !== null
    this.closing = true
    try {
      this.engine?.stop()
      this.engine = null
      this.deviceService = null
      this.deps.holder.release()
      this.detachRecorders()
      this.deps.auth.setDeviceId(null)
    } finally {
      this.closing = false
    }
    // 로그아웃하면 금고는 곧바로 잠근다(로컬 DB 는 그대로 둔다).
    // 돌던 엔진이 있을 때만 잠근다 — 앱 시작 직후의 "아직 로그아웃" 상태에서까지 잠그면
    // 기기 키로 열어 둔 금고를 매번 도로 닫아 버린다
    if (hadEngine && this.lockOnNextTeardown) this.deps.vault.lock()
    this.lockOnNextTeardown = true
  }

  /** 최초 업로드·재검사 공통 호출부. 실패해도 동기화 자체는 계속 돈다(사유만 남긴다) */
  private runBackfill(fn: typeof backfillOutbox): void {
    try {
      const result = fn(this.deps.db, this.deps.workspace(), this.deps.vault)
      if (result.skipped) return
      const total = backfillTotal(result)
      if (total > 0) console.info('기존 데이터를 동기화 대기열에 올렸습니다', total)
    } catch (e: unknown) {
      console.error('기존 데이터 업로드 준비 실패', e instanceof Error ? e.message : String(e))
    }
  }

  private attachRecorders(): void {
    // 기록 시점의 활성 작업공간을 행마다 남긴다 — 나중에 작업공간을 바꿔도
    // 이미 쌓인 변경은 원래 작업공간의 uuid 로 올라간다
    const base = createOutboxRecorder(
      this.deps.db,
      this.outbox,
      () => this.deps.workspace().localId
    )
    // 지우거나 고치는 순간 곧바로 서버로 올린다 — 대기열에 쌓아 두고 다음 주기를 기다리면 그 사이 앱이 닫히거나
    // 다른 PC 가 먼저 옛 값을 올려 삭제가 되살아났다(사용자 2026-10-08 2호기에서 지운 계정이 1호기에 남음).
    // 짧게 모아(0.8초) 한 번만 돌린다. 대기열은 서버에 못 닿았을 때의 안전장치로만 남는다
    const recorder: typeof base = (...args) => {
      base(...args)
      this.schedulePushNow()
    }
    this.deps.vault.setOutboxRecorder(recorder)
    this.deps.settings.setOutboxRecorder(recorder)
    this.deps.bookmarks.setOutboxRecorder(recorder)
    this.deps.chats?.setOutboxRecorder(recorder)
    // 로그아웃 상태에서 만든 금고는 키 재료를 남길 훅이 없었다. 한 번도 오간 적이 없을 때만
    // 지금 기록한다 — 매 로그인마다 올리면 서버 값을 같은 값으로 계속 덮어쓴다
    const local = new SyncLocal(this.deps.db)
    if (local.getStateNumber(settingUpdatedAtKey('vault.salt')) === null) {
      this.deps.vault.ensureKeyMaterialRecorded?.()
    }
  }

  private pushTimer: ReturnType<typeof setTimeout> | null = null

  private schedulePushNow(): void {
    if (this.pushTimer || !this.engine) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.deps.holder.syncNow()
    }, 800)
    this.pushTimer.unref?.()
  }

  private detachRecorders(): void {
    this.deps.vault.setOutboxRecorder(null)
    this.deps.settings.setOutboxRecorder(null)
    this.deps.bookmarks.setOutboxRecorder(null)
    this.deps.chats?.setOutboxRecorder(null)
  }
}
