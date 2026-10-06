// 기기 감시. adb 는 장치 이벤트 API 가 없어 5초 폴링으로 본다(PRD 04 배치표).
// 복구는 정확히 1회만 — 무한 재시도는 adb 서버를 더 망가뜨린다

import {
  DEVICE_POLL_INTERVAL_MS,
  isPhoneCountry,
  type PhoneDto,
  type PhoneState,
  type PhoneTransport
} from '../../shared/phone'
import {
  isWifiSerial,
  parseDevices,
  parseMdnsServices,
  realSerialOf,
  type AdbRunner,
  type MdnsService,
  type RawDevice
} from './adb'
import { relayArgs, type RelayHost } from './relay'
import { tr } from '../i18n'

const WIFI_DEFAULT_PORT = 5555
/** 무선 디버깅 페어링 코드 자리수 */
const PAIR_CODE_LENGTH = 6
/** 발견된 와이파이 접속점에 다시 connect 를 시도하기까지 쉬는 시간 */
const WIFI_CONNECT_COOLDOWN_MS = 30_000

/**
 * 저장소가 돌려주는 폰 한 줄. 표 정의는 `phone/repo.ts`(Task 2) 에 있고
 * 여기서는 **구조적으로만** 받는다 — 서로 파일을 import 하지 않아 순서에 얽매이지 않는다.
 * 문자열 칸(country·transport)은 표에서 온 값이라 좁히지 않고 받아서 이 파일에서 판별한다
 */
export interface PhoneRowLike {
  id: number
  serial: string
  label: string
  country: string
  transport: string
  wifiAddress: string | null
  model: string
  smsQueryOk: boolean | null
  lastSeenAt: number
}

export interface DeviceRepo {
  upsertSeen: (input: {
    serial: string
    model: string
    transport: PhoneTransport
    state: PhoneState
    at: number
  }) => PhoneRowLike
  list: () => PhoneRowLike[]
  /**
   * 전송 이름(ip:port·서비스 이름)으로 잘못 만들어진 줄을 실제 시리얼의 줄로 합친다.
   * 실제 시리얼 줄이 없으면 그 줄의 시리얼만 바꾸고(이름·담당 계정 유지), 있으면 담당 계정을 옮긴 뒤 지운다
   */
  mergeAlias?: (aliasSerial: string, realSerial: string) => void
  /** 고정 포트 접속 주소(ip:5555)를 기억한다 — 끊긴 뒤 그 주소로 다시 붙인다 */
  setWifiAddress?: (id: number, address: string | null) => void
}

export interface DeviceManagerDeps {
  adb: AdbRunner
  repo: DeviceRepo
  now: () => number
  autoReconnect: () => boolean
  /** 사용자가 지운 폰의 실제 시리얼 — 보여도 저장하지 않고, 발견돼도 붙이지 않는다 */
  ignored?: () => readonly string[]
  /** 다른 PC 가 중계하는 adb 서버들(phone/relay.ts). 그쪽에 붙은 폰도 목록에 넣는다(transport 'relay') */
  relayHosts?: () => readonly RelayHost[]
  // 경고 문구는 상한 초과처럼 사용자가 알아야 할 때만 함께 온다
  onChange: (phones: PhoneDto[], warning?: string) => void
  /**
   * 지금 설정된 adb 실행 파일 경로. 비어 있으면 adb 를 아예 부르지 않는다 —
   * AdbRunner 는 경로가 없으면 던지므로, 5초 폴링이 그대로 unhandledRejection 이 된다
   */
  adbPath?: () => string
  // 테스트에서 가짜 타이머를 넣는다
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

/** 실제 시리얼이 붙은 장치 한 대 */
export interface LiveDevice extends RawDevice {
  realSerial: string
}

/** 같은 폰의 전송이 여럿이면 하나만 고른다: 승인된 것 먼저, 그다음 USB → adb 자동 연결 → ip:port */
export function pickOnePerPhone(
  raw: readonly RawDevice[],
  services: readonly MdnsService[]
): LiveDevice[] {
  const rank = (d: RawDevice): number =>
    (d.state === 'online' ? 0 : 10) +
    (d.transport === 'usb' ? 0 : d.transport === 'relay' ? 3 : isWifiSerial(d.serial) ? 2 : 1)
  const best = new Map<string, LiveDevice>()
  for (const d of raw) {
    const realSerial = realSerialOf(d.serial, services)
    const current = best.get(realSerial)
    if (!current || rank(d) < rank(current)) best.set(realSerial, { ...d, realSerial })
  }
  return [...best.values()]
}

/** 표의 문자열 칸을 공용 타입으로 좁힌다(손상된 값은 기본값으로 본다) */
function toTransport(value: string, serial: string): PhoneTransport {
  if (value === 'usb' || value === 'wifi' || value === 'relay') return value
  return isWifiSerial(serial) ? 'wifi' : 'usb'
}

function toDto(row: PhoneRowLike, live: RawDevice | undefined): PhoneDto {
  const state: PhoneState = live?.state ?? 'disconnected'
  return {
    id: row.id,
    // adb 명령(-s)은 전송 이름을 받는다. 붙어 있지 않으면 저장된 시리얼을 그대로 둔다
    serial: live?.serial ?? row.serial,
    label: row.label || row.model || row.serial,
    country: isPhoneCountry(row.country) ? row.country : 'KR',
    transport: toTransport(live?.transport ?? row.transport, row.serial),
    wifiAddress: row.wifiAddress,
    model: live?.model || row.model,
    state,
    smsQueryOk: row.smsQueryOk,
    lastSeenAt: row.lastSeenAt,
    // 화면 전송 상태는 ScreenStream(Task 5) 이 따로 관리한다
    screenMode: null
  }
}

export class DeviceManager {
  private handle: unknown = null
  private phones: PhoneDto[] = []
  private lastHash = ''
  // 이번 연결 주기에 이미 복구를 시도한 serial(끊겼다 붙으면 비운다)
  private recovered = new Set<string>()
  // 발견된 와이파이 접속점(ip:port) → 다음 connect 시도 시각
  private wifiRetryAt = new Map<string, number>()
  // ip:port 전송 이름 → 폰의 실제 시리얼(폰에 물어 본 값). mDNS 에 안 나오는 고정 포트 접속을 같은 폰으로 알아본다
  private serialByAddress = new Map<string, string>()
  // 고정 포트 전환을 이미 시도한 폰(실제 시리얼) — 한 번 실패한 폰을 5초마다 두드리지 않는다
  private fixedPortTried = new Set<string>()

  constructor(private deps: DeviceManagerDeps) {}

  start(): void {
    if (this.handle !== null) return
    const setI =
      this.deps.setInterval ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
    void this.refresh()
    this.handle = setI(() => void this.refresh(), DEVICE_POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.handle === null) return
    const clearI =
      this.deps.clearInterval ?? ((h: unknown): void => clearInterval(h as NodeJS.Timeout))
    clearI(this.handle)
    this.handle = null
  }

  list(): PhoneDto[] {
    return this.phones
  }

  /** adb 경로가 설정돼 있는가(경로 함수를 주지 않았으면 있다고 본다) */
  private hasAdb(): boolean {
    return this.deps.adbPath === undefined || this.deps.adbPath() !== ''
  }

  /**
   * 1회 즉시 스캔(설정 화면의 "지금 찾기").
   * adb 가 없거나 실행이 실패해도 던지지 않는다 — 5초 폴링에서 던지면
   * 붙잡는 곳이 없어 unhandledRejection 이 된다. 실패하면 직전 목록을 그대로 둔다
   */
  async refresh(): Promise<PhoneDto[]> {
    try {
      return await this.scan()
    } catch {
      // 도구가 없거나 adb 서버가 죽은 상황 — 조용히 직전 목록을 유지한다
      return this.phones
    }
  }

  private async scan(): Promise<PhoneDto[]> {
    // 경로가 비어 있으면 adb 를 부르지 않는다(부르면 곧바로 던진다)
    if (!this.hasAdb()) return this.phones
    const first = await this.deps.adb.run(['devices', '-l'])
    const found = await this.discover()
    // 고정 포트(adb tcpip 5555) 접속은 mDNS 에 안 나오는 폰이 있다(실기: SM-A426N) — 폰에 시리얼을 물어 주인을 안다
    const services = [...found, ...(await this.askSerials(parseDevices(first.stdout), found))]
    // 기억해 둔 고정 주소로 끊긴 폰을 다시 붙인다(무선 디버깅이 꺼져도 이 포트는 살아 있다)
    const rejoined = await this.connectRemembered(parseDevices(first.stdout), services)
    // 같은 와이파이에서 발견된 폰은 주소를 몰라도 알아서 붙인다. 새로 붙인 게 있으면 목록을 다시 읽는다
    const connected = await this.connectDiscovered(parseDevices(first.stdout), services)
    const res = connected || rejoined ? await this.deps.adb.run(['devices', '-l']) : first
    // 한 폰이 여러 전송 이름으로 보이면 하나만 남긴다(저장은 실제 시리얼로, 명령은 전송 이름으로)
    // 다른 PC 가 중계하는 폰은 로컬에 없을 때만 보탠다(로컬 연결이 이긴다)
    const seen = [...parseDevices(res.stdout), ...(await this.relayedDevices(parseDevices(res.stdout)))]
    // 고르지 않은 전송 이름으로 예전에 만들어진 줄도 실제 줄로 합친다(한 폰이 두 이름으로 동시에 보일 때)
    for (const d of seen) {
      const realSerial = realSerialOf(d.serial, services)
      if (realSerial !== d.serial) this.deps.repo.mergeAlias?.(d.serial, realSerial)
    }
    // 지금은 안 보이지만 예전에 ip:port 로 저장된 줄도, 그 주소의 주인을 알면 합친다
    for (const service of services) this.deps.repo.mergeAlias?.(service.address, service.serial)
    // 무선 디버깅 포트는 접속할 때마다 바뀐다. 옛 포트로 남은 ip:port 줄은 같은 IP 의 주인에게 합친다
    // (지금 그 이름으로 붙어 있는 장치는 건드리지 않는다)
    for (const row of this.deps.repo.list()) {
      if (!isWifiSerial(row.serial) || seen.some((d) => d.serial === row.serial)) continue
      const ip = row.serial.split(':')[0]
      const owner = services.find((s) => s.address.split(':')[0] === ip)
      if (owner) this.deps.repo.mergeAlias?.(row.serial, owner.serial)
    }
    const ignored = this.deps.ignored?.() ?? []
    const raw = pickOnePerPhone(seen, services).filter((d) => !ignored.includes(d.realSerial))
    const now = this.deps.now()
    for (const d of raw) {
      this.deps.repo.upsertSeen({
        serial: d.realSerial,
        model: d.model,
        transport: d.transport,
        state: d.state,
        at: now
      })
      // 다시 붙었으면 다음에 끊길 때 또 한 번 복구할 수 있게 표시를 지운다
      if (d.state === 'online') this.recovered.delete(d.serial)
    }
    // 무선 디버깅으로만 붙은 폰은 고정 포트로도 붙여 둔다(와이파이가 끊겨도 다시 붙을 수 있게)
    await this.keepFixedPort(seen, services)
    // 저장된 폰 중 이번에 안 보인 것은 끊김으로 본다
    const rows = this.deps.repo.list()
    // 동시 연결 상한은 두지 않는다 — 붙어 있는 폰은 모두 쓴다(사용자 요청, 예전에는 3대)
    const next = rows.map((row) =>
      toDto(
        row,
        raw.find((d) => d.realSerial === row.serial)
      )
    )
    // 끊긴 폰 자동 복구 1회
    if (this.deps.autoReconnect()) {
      for (const p of next) {
        if (p.state !== 'disconnected' || this.recovered.has(p.serial)) continue
        this.recovered.add(p.serial)
        void this.recover(p.serial)
      }
    }
    this.phones = next
    const hash = next.map((p) => `${p.serial}:${p.state}`).join('|')
    if (hash !== this.lastHash) {
      this.lastHash = hash
      this.deps.onChange(next)
    }
    return next
  }

  /** 중계 PC 들의 adb 서버에 붙은 폰. 중계 PC 가 꺼져 있거나 막혀 있으면 조용히 빈 목록 */
  private async relayedDevices(local: readonly RawDevice[]): Promise<RawDevice[]> {
    const hosts = this.deps.relayHosts?.() ?? []
    const out: RawDevice[] = []
    for (const h of hosts) {
      try {
        const res = await this.deps.adb.run(relayArgs(h, ['devices', '-l']), 5000)
        for (const d of parseDevices(res.stdout)) {
          if (local.some((l) => l.serial === d.serial) || out.some((o) => o.serial === d.serial)) continue
          out.push({ ...d, transport: 'relay' })
        }
      } catch {
        // 중계 PC 가 안 보이면 그 폰은 이번 주기엔 끊김으로 남는다
      }
    }
    return out
  }

  /**
   * `adb mdns services` 로 발견된 접속점 가운데 아직 목록에 없는 것을 `adb connect` 한다.
   * 예전에는 `adb devices` 만 봐서, 와이파이 폰은 사용자가 IP 를 직접 적어야 했고
   * "지금 찾기"로는 영영 안 나왔다(실기: 같은 와이파이의 폰이 "끊김"으로만 보임).
   *  - 같은 폰이 USB 로 이미 붙어 있으면 건너뛴다(한 폰이 두 줄로 보이지 않게)
   *  - 실패한 주소는 잠시 쉬었다가 다시 시도한다(5초 폴링마다 두드리지 않는다)
   * 새로 붙인 것이 있으면 true
   */
  private async discover(): Promise<MdnsService[]> {
    try {
      return parseMdnsServices((await this.deps.adb.run(['mdns', 'services'])).stdout)
    } catch {
      // mdns 를 지원하지 않는 adb·방화벽 — 발견 없이 기존 동작 그대로 간다
      return []
    }
  }

  /**
   * ip:port 로 붙은 장치 가운데 mDNS 로 주인을 모르는 것은 폰에 실제 시리얼을 물어 본다(한 번 알면 기억한다).
   * 이렇게 안 하면 같은 폰이 "192.168.x.x:5555" 라는 다른 폰으로 보여 담당 폰 연결이 끊긴 것으로 판정된다
   */
  private async askSerials(current: RawDevice[], found: MdnsService[]): Promise<MdnsService[]> {
    const out: MdnsService[] = []
    for (const d of current) {
      if (d.state !== 'online' || !isWifiSerial(d.serial)) continue
      if (found.some((sv) => sv.address === d.serial)) continue
      let real = this.serialByAddress.get(d.serial)
      if (!real) {
        try {
          real = (await this.deps.adb.run(['-s', d.serial, 'shell', 'getprop', 'ro.serialno'], 5_000)).stdout.trim()
        } catch {
          real = ''
        }
        if (!real || /\s/.test(real)) continue
        this.serialByAddress.set(d.serial, real)
      }
      out.push({ serial: real, address: d.serial })
    }
    return out
  }

  /** 저장된 폰 가운데 지금 안 붙어 있고 고정 주소(ip:5555)를 기억하는 것은 그 주소로 connect 를 시도한다 */
  private async connectRemembered(current: RawDevice[], services: MdnsService[]): Promise<boolean> {
    const now = this.deps.now()
    const ignored = this.deps.ignored?.() ?? []
    let connected = false
    for (const row of this.deps.repo.list()) {
      const address = row.wifiAddress
      // ip:port 꼴 주소만 — 다른 값이 들어 있는 옛 줄은 건드리지 않는다
      if (!address || !isWifiSerial(address) || ignored.includes(row.serial)) continue
      if (current.some((d) => d.state === 'online' && realSerialOf(d.serial, services) === row.serial)) continue
      if ((this.wifiRetryAt.get(address) ?? 0) > now) continue
      this.wifiRetryAt.set(address, now + WIFI_CONNECT_COOLDOWN_MS)
      try {
        const res = await this.deps.adb.run(['connect', address], 10_000)
        if (/connected to/i.test(res.stdout) && !/failed|cannot|unable/i.test(res.stdout)) connected = true
      } catch {
        // 폰이 꺼져 있거나 다른 망에 있다 — 다음 주기에 다시 본다
      }
    }
    return connected
  }

  /**
   * 무선 디버깅(TLS)으로만 붙은 폰을 고정 포트(5555)로도 붙인다.
   * 안드로이드는 와이파이가 끊기면 무선 디버깅을 스스로 끄고 다시 켜 주지 않는다(실기 2026-10-01: 하루 2~3회 끊김 →
   * 폰 결제 승인이 그때마다 멈춤). `adb tcpip` 로 연 포트는 와이파이가 다시 붙으면 그대로 살아 있다(폰 재부팅 전까지).
   * 이미 고정 포트로 붙어 있으면 그 주소만 기억한다
   */
  private async keepFixedPort(seen: RawDevice[], services: MdnsService[]): Promise<void> {
    const rows = this.deps.repo.list()
    const live = seen.filter((d) => d.state === 'online')
    const byPhone = new Map<string, RawDevice[]>()
    for (const d of live) {
      const real = realSerialOf(d.serial, services)
      byPhone.set(real, [...(byPhone.get(real) ?? []), d])
    }
    for (const [real, transports] of byPhone) {
      const row = rows.find((r) => r.serial === real)
      if (!row) continue
      const fixed = transports.find((d) => isWifiSerial(d.serial) && d.serial.endsWith(`:${WIFI_DEFAULT_PORT}`))
      if (fixed) {
        if (row.wifiAddress !== fixed.serial) this.deps.repo.setWifiAddress?.(row.id, fixed.serial)
        continue
      }
      // USB 로 붙은 폰은 건드리지 않는다. 무선 디버깅(서비스 이름·ip:임의포트)으로만 붙은 폰만 전환한다
      if (transports.some((d) => d.transport === 'usb') || this.fixedPortTried.has(real)) continue
      this.fixedPortTried.add(real)
      const via = transports[0]
      const ip = services.find((sv) => sv.serial === real)?.address.split(':')[0]
      if (!via || !ip) continue
      try {
        await this.deps.adb.run(['-s', via.serial, 'tcpip', String(WIFI_DEFAULT_PORT)], 10_000)
        const address = `${ip}:${WIFI_DEFAULT_PORT}`
        // adbd 가 다시 뜰 틈을 준 뒤 붙인다. 못 붙어도 주소는 기억해 다음 주기에 다시 시도한다
        this.deps.repo.setWifiAddress?.(row.id, address)
        this.wifiRetryAt.set(address, this.deps.now() + 3_000)
      } catch {
        // 전환 실패 — 무선 디버깅 연결은 그대로다
      }
    }
  }

  private async connectDiscovered(current: RawDevice[], services: MdnsService[]): Promise<boolean> {
    const now = this.deps.now()
    let connected = false
    const ignored = this.deps.ignored?.() ?? []
    for (const service of services) {
      if (ignored.includes(service.serial)) continue
      // 이 폰이 어떤 이름으로든 이미 붙어 있으면(USB·ip:port·adb 가 스스로 붙인 무선 디버깅) 또 붙이지 않는다
      if (current.some((d) => realSerialOf(d.serial, services) === service.serial)) continue
      if ((this.wifiRetryAt.get(service.address) ?? 0) > now) continue
      this.wifiRetryAt.set(service.address, now + WIFI_CONNECT_COOLDOWN_MS)
      try {
        await this.deps.adb.run(['connect', service.address], 10_000)
        connected = true
      } catch {
        // 연결 실패는 다음 주기에 다시 본다
      }
    }
    return connected
  }

  /**
   * 폰 카드의 "재연결"·끊긴 폰 자동 복구. 그 폰만 다시 붙인다:
   *  1) 같은 와이파이에서 발견되면 그 주소로 adb connect
   *  2) adb reconnect offline (멈춘 전송만 다시 연다)
   *  3) 그래도 안 되고 **붙어 있는 다른 폰이 하나도 없을 때만** kill-server → start-server
   * 예전에는 곧바로 3)을 했는데, 폰이 여러 대면 한 대가 끊길 때마다 나머지 폰의 연결과 화면 전송까지
   * 함께 끊겼다. 자동 복구는 refresh 안에서 기다리지 않고 부르므로 여기서도 던지지 않는다
   */
  async recover(serial: string): Promise<boolean> {
    if (!this.hasAdb()) return false
    const isBack = async (): Promise<{ back: boolean; others: number }> => {
      const found = await this.discover()
      const current = parseDevices((await this.deps.adb.run(['devices', '-l'])).stdout)
      // 고정 포트로 붙은 폰은 mDNS 에 없을 수 있다 — 폰에 물어 본 시리얼도 함께 본다
      const services = [...found, ...(await this.askSerials(current, found))]
      const live = pickOnePerPhone(current, services).filter((d) => d.state === 'online')
      const back = live.some((d) => d.realSerial === serial || d.serial === serial)
      return { back, others: live.filter((d) => d.realSerial !== serial).length }
    }
    try {
      const service = (await this.discover()).find((sv) => sv.serial === serial)
      if (service) {
        await this.deps.adb.run(['connect', service.address], 10_000)
        if ((await isBack()).back) return true
      }
      await this.deps.adb.run(['reconnect', 'offline'], 10_000)
      const after = await isBack()
      if (after.back) return true
      // 다른 폰이 붙어 있으면 서버를 건드리지 않는다 — 이 폰은 다음 검색에서 다시 본다
      if (after.others > 0) return false
      await this.deps.adb.run(['kill-server'])
      await this.deps.adb.run(['start-server'])
      return (await isBack()).back
    } catch {
      return false
    }
  }

  async connectWifi(address: string): Promise<{ ok: boolean; message: string }> {
    const target = address.includes(':') ? address : `${address}:${WIFI_DEFAULT_PORT}`
    const res = await this.deps.adb.run(['connect', target], 10_000)
    const ok = /connected to/i.test(res.stdout) && !/failed|cannot|unable/i.test(res.stdout)
    if (ok) await this.refresh()
    return { ok, message: res.stdout.trim() || res.stderr.trim() }
  }

  /**
   * 무선 디버깅 페어링(안드로이드 11+). 폰의 "페어링 코드로 기기 페어링" 화면에 뜬 주소와 6자리 코드로
   * 이 PC 의 키를 폰에 등록한다 — USB 를 한 번도 꽂지 않은 폰은 이 길뿐이다.
   * 코드는 폰이 그때그때 만드는 1회용이라 저장하지 않고 로그에도 남기지 않는다
   */
  async pairWifi(address: string, code: string): Promise<{ ok: boolean; message: string }> {
    const target = address.trim()
    const digits = code.replace(/\D/g, '')
    if (!isWifiSerial(target)) return { ok: false, message: tr('phone.pairBadAddress') }
    if (digits.length !== PAIR_CODE_LENGTH) return { ok: false, message: tr('phone.pairBadCode') }
    const res = await this.deps.adb.run(['pair', target, digits], 15_000)
    const ok = /successfully paired/i.test(res.stdout)
    if (ok) {
      // 페어링이 끝나면 접속점(_adb-tls-connect)이 곧 발견된다 — 쉬는 시간을 지우고 바로 찾는다
      this.wifiRetryAt.clear()
      await this.refresh()
    }
    return { ok, message: res.stdout.trim() || res.stderr.trim() }
  }

  /** 이 폰의 모든 전송(ip:port·서비스 이름)을 끊는다. USB 는 adb 가 끊지 못하므로 넘어간다 */
  async disconnectAll(realSerial: string): Promise<void> {
    const res = await this.deps.adb.run(['devices', '-l'])
    const services = await this.discover()
    for (const d of parseDevices(res.stdout)) {
      if (d.transport !== 'wifi' || realSerialOf(d.serial, services) !== realSerial) continue
      try {
        await this.deps.adb.run(['disconnect', d.serial])
      } catch {
        // 이미 끊겼으면 그만이다
      }
    }
  }

  async disconnect(serial: string): Promise<void> {
    await this.deps.adb.run(['disconnect', serial])
    await this.refresh()
  }
}
