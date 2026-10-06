// 폰 기능의 조립 지점. 기기 감시(DeviceManager)·저장소·설정을 한데 묶어
// IPC 핸들러가 이 파일 하나만 보게 한다. 비밀값은 이 층을 지나가지 않는다

import { existsSync } from 'node:fs'
import type { Settings } from '../../shared/settings'
import type { AuthEventDto, PhoneAuthWaitingDto, PhoneCountry, PhoneDto } from '../../shared/phone'
import { isPhoneCountry } from '../../shared/phone'
import { detectAdbPath, shellArgs, toolCandidates } from './adb'
import type { AdbRunner } from './adb'
import { DeviceManager, type DeviceRepo, type PhoneRowLike } from './devices'
import type { RelayHost } from './relay'
import { watchIncomingCall } from './auth-flow'
import { tr } from '../i18n'

/**
 * Task 2 의 `PhoneRepo` 를 구조적으로 받는다(파일 import 없음 — devices.ts 와 같은 이유).
 * 여기서 쓰는 메서드만 적는다
 */
export interface PhoneServiceRepo extends DeviceRepo {
  setLabel: (id: number, label: string, country: PhoneCountry) => void
  setSmsQueryOk: (id: number, ok: boolean) => void
  assignAccount: (accountId: number, phoneId: number | null) => void
  phoneForAccount: (accountId: number) => PhoneRowLike | null
  remove: (id: number) => void
  listAuthEvents: (limit?: number) => AuthEventDto[]
}

export interface PhoneSettingsLike {
  get: () => Settings
  set: (patch: Partial<Settings>) => Settings
}

export interface PhoneServiceDeps {
  adb: AdbRunner
  repo: PhoneServiceRepo
  settings: PhoneSettingsLike
  emit: (list: PhoneDto[], warning?: string) => void
  emitAuthWaiting: (dto: PhoneAuthWaitingDto) => void
  /** 채팅 진행 로그(ARS 안내처럼 사용자가 봐야 하는 한 줄). 없으면 통지만 한다 */
  onProgress?: (text: string) => void
  now?: () => number
  // 경로 후보가 실제로 있는지 보는 함수(테스트에서 갈아 끼운다)
  exists?: (path: string) => boolean
  /** 앱 데이터의 phone-tools 폴더(원클릭 설치본이 여기 들어간다) */
  toolsRoot?: string
  /** PATH 환경변수(테스트에서 갈아 끼운다) */
  pathEnv?: string
  /** 다른 PC 가 중계하는 adb 서버들(phone/relay.ts) */
  relayHosts?: () => readonly RelayHost[]
}

// 문자 DB 시험 조회. 권한이 없으면 adb 가 이 문구를 돌려준다
const PERMISSION_DENIAL_RE = /permission denial|java\.lang\.SecurityException/i

export class PhoneService {
  private devices: DeviceManager
  // 시험 조회를 이미 마친 폰(앱 수명 동안 1회씩만 한다)
  private smsProbed = new Set<string>()

  constructor(private deps: PhoneServiceDeps) {
    this.devices = new DeviceManager({
      adb: deps.adb,
      repo: deps.repo,
      now: deps.now ?? ((): number => Date.now()),
      // 설정에 adb 경로가 없으면 폴링이 adb 를 부르지 않는다(부르면 곧바로 던진다)
      adbPath: () => deps.settings.get().adbPath,
      autoReconnect: () => deps.settings.get().phoneAutoReconnect,
      ignored: () => deps.settings.get().phoneIgnoredSerials,
      relayHosts: deps.relayHosts,
      onChange: (list, warning) => {
        deps.emit(list, warning)
        void this.probeSms(list)
      }
    })
  }

  start(): void {
    // 승계 1회 — 이미 도구가 깔린 PC 라면 설정이 비어 있어도 첫 실행에서 한 번 찾아 저장한다
    this.detectPaths()
    this.devices.start()
  }

  dispose(): void {
    this.devices.stop()
  }

  list(): PhoneDto[] {
    return this.devices.list()
  }

  refresh(): Promise<PhoneDto[]> {
    return this.devices.refresh()
  }

  connectWifi(address: string): Promise<{ ok: boolean; message: string }> {
    this.clearIgnored()
    return this.devices.connectWifi(address)
  }

  async pairWifi(address: string, code: string): Promise<{ ok: boolean; message: string }> {
    // 직접 페어링한다는 건 그 폰을 다시 쓰겠다는 뜻이다 — 지운 폰 목록을 비우고 찾는다
    this.clearIgnored()
    return this.devices.pairWifi(address, code)
  }

  /**
   * 목록에서 폰을 지운다: 와이파이 연결을 끊고, 줄과 담당 계정 매핑을 지우고, 다시 찾지 않게 적어 둔다.
   * 적어 두지 않으면 같은 와이파이의 폰은 5초 뒤 검색에서 도로 나타난다
   */
  async remove(id: number): Promise<void> {
    const row = this.deps.repo.list().find((r) => r.id === id)
    if (!row) return
    const ignored = this.deps.settings.get().phoneIgnoredSerials
    if (!ignored.includes(row.serial))
      this.deps.settings.set({ phoneIgnoredSerials: [...ignored, row.serial].slice(-50) })
    try {
      await this.devices.disconnectAll(row.serial)
    } catch {
      // adb 가 없어도 줄은 지운다
    }
    this.deps.repo.remove(id)
    await this.devices.refresh()
    this.deps.emit(this.devices.list())
  }

  private clearIgnored(): void {
    if (this.deps.settings.get().phoneIgnoredSerials.length > 0)
      this.deps.settings.set({ phoneIgnoredSerials: [] })
  }

  disconnect(serial: string): Promise<void> {
    return this.devices.disconnect(serial)
  }

  recover(serial: string): Promise<boolean> {
    return this.devices.recover(serial)
  }

  /**
   * adb·scrcpy 실행 파일을 찾아 설정이 비어 있으면 채운다.
   * 순서는 설정 경로 → 앱 데이터 설치본 → PATH → 기존 후보다
   */
  detectPaths(): { adb: string; scrcpy: string } {
    const exists = this.deps.exists ?? existsSync
    const current = this.deps.settings.get()
    const pathEnv = this.deps.pathEnv ?? process.env.PATH ?? ''
    const adb = detectAdbPath(
      toolCandidates('adb.exe', {
        settingsPath: current.adbPath,
        toolsRoot: this.deps.toolsRoot,
        pathEnv
      }),
      exists
    )
    const scrcpy = detectAdbPath(
      toolCandidates('scrcpy.exe', {
        settingsPath: current.scrcpyPath,
        toolsRoot: this.deps.toolsRoot,
        pathEnv
      }),
      exists
    )
    const patch: Partial<Settings> = {}
    if (adb && !current.adbPath) patch.adbPath = adb
    if (scrcpy && !current.scrcpyPath) patch.scrcpyPath = scrcpy
    if (Object.keys(patch).length > 0) this.deps.settings.set(patch)
    return { adb, scrcpy }
  }

  setLabel(id: number, label: string, country: string): void {
    this.deps.repo.setLabel(id, label, isPhoneCountry(country) ? country : 'KR')
    this.deps.emit(this.devices.list())
  }

  assign(accountId: number, phoneId: number | null): void {
    this.deps.repo.assignAccount(accountId, phoneId)
  }

  /** 계정의 담당 폰 id. 고르지 않았으면 null — 화면이 저장된 선택을 다시 보여 주는 데 쓴다 */
  assignedPhoneId(accountId: number): number | null {
    return this.deps.repo.phoneForAccount(accountId)?.id ?? null
  }

  authEvents(limit?: number): AuthEventDto[] {
    return this.deps.repo.listAuthEvents(limit)
  }

  /** 인증 대기 알림을 렌더러로 밀어 준다(문자 본문은 담기지 않는다) */
  notifyAuthWaiting(dto: PhoneAuthWaitingDto): void {
    this.deps.emitAuthWaiting(dto)
  }

  /**
   * 인증을 기다리는 동안 ARS(전화 인증) 수신을 3초마다 살핀다.
   * 감지되면 카드 강조 통지와 진행 로그만 남긴다 — 전화를 받거나 키패드를 누르지 않는다.
   * 돌려주는 함수를 부르면 감시를 멈춘다
   */
  watchArs(siteHost: string): () => void {
    let stopped = false
    void watchIncomingCall({
      adb: this.deps.adb,
      serials: () =>
        this.devices
          .list()
          .filter((p) => p.state === 'online')
          .map((p) => p.serial),
      now: this.deps.now ?? ((): number => Date.now()),
      cancelled: () => stopped,
      onDetected: (serial) => {
        const phone = this.devices.list().find((p) => p.serial === serial) ?? null
        this.deps.emitAuthWaiting({
          waiting: true,
          kind: 'ars',
          siteHost,
          phoneId: phone?.id ?? null
        })
        // 전화 인증을 감지했을 때 채팅에 남기는 진행 로그(자동 응답은 하지 않는다)
        this.deps.onProgress?.(tr('phone.arsNotice'))
      }
    })
    return () => {
      stopped = true
    }
  }

  /**
   * 이 계정의 인증을 받을 폰. 매핑이 없으면 null 을 돌려주고
   * 호출부(Task 6)가 연결된 폰 전부를 동시에 감시한다
   */
  assignForJob(accountId: number): PhoneDto | null {
    const row = this.deps.repo.phoneForAccount(accountId)
    if (!row) return null
    return this.devices.list().find((p) => p.id === row.id) ?? null
  }

  /**
   * 폰마다 1회, 문자 DB 를 읽을 수 있는지 시험 조회한다.
   * 읽히지 않으면 화면 읽기(Visual) 경로로 우회하므로 실패해도 기능은 계속된다.
   * 본문은 요청하지 않는다 — `_id` 칸만 본다
   */
  private async probeSms(list: PhoneDto[]): Promise<void> {
    for (const phone of list) {
      if (phone.state !== 'online' || this.smsProbed.has(phone.serial)) continue
      if (phone.smsQueryOk !== null) {
        this.smsProbed.add(phone.serial)
        continue
      }
      this.smsProbed.add(phone.serial)
      const res = await this.deps.adb.run(
        shellArgs(phone.serial, [
          'content',
          'query',
          '--uri',
          'content://sms/inbox',
          '--projection',
          '_id'
        ])
      )
      const ok = res.code === 0 && !PERMISSION_DENIAL_RE.test(`${res.stdout}\n${res.stderr}`)
      this.deps.repo.setSmsQueryOk(phone.id, ok)
    }
  }
}
