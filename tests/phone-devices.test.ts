import { describe, it, expect, beforeEach } from 'vitest'
import { DeviceManager, type DeviceRepo, type PhoneRowLike } from '../src/main/phone/devices'
import { DEVICE_POLL_INTERVAL_MS, type PhoneDto } from '../src/shared/phone'
import { ADB_CANDIDATES } from '../src/main/phone/adb'
import { PhoneService, type PhoneServiceRepo } from '../src/main/phone/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { FakeAdb } from './stubs/fake-adb'

// 폴링을 실제 시간에 맡기지 않는다 — 테스트가 직접 tick() 으로 돌린다
class FakeTimer {
  private fns: (() => void)[] = []
  readonly setInterval = (fn: () => void, ms: number): unknown => {
    this.lastMs = ms
    this.fns.push(fn)
    return this.fns.length
  }
  readonly clearInterval = (handle: unknown): void => {
    this.fns.splice((handle as number) - 1, 1, () => {})
  }
  lastMs = 0
  tick(): void {
    for (const fn of [...this.fns]) fn()
  }
}

// 표 대신 메모리 배열을 쓰는 가짜 저장소(T2 의 PhoneRepo 와 같은 모양)
class FakeRepo implements DeviceRepo {
  readonly rows: PhoneRowLike[] = []
  private nextId = 1

  upsertSeen(input: {
    serial: string
    model: string
    transport: string
    state: string
    at: number
  }): PhoneRowLike {
    const found = this.rows.find((r) => r.serial === input.serial)
    if (found) {
      found.model = input.model || found.model
      found.transport = input.transport
      found.lastSeenAt = input.at
      return found
    }
    const row: PhoneRowLike = {
      id: this.nextId++,
      serial: input.serial,
      label: input.model || input.serial,
      country: 'KR',
      transport: input.transport,
      wifiAddress: input.transport === 'wifi' ? input.serial : null,
      model: input.model,
      smsQueryOk: null,
      lastSeenAt: input.at
    }
    this.rows.push(row)
    return row
  }

  list(): PhoneRowLike[] {
    return [...this.rows]
  }

  setWifiAddress(id: number, address: string | null): void {
    const row = this.rows.find((r) => r.id === id)
    if (row) row.wifiAddress = address
  }
}

const ONE = 'List of devices attached\nR3CRA05HY3R device usb:1-4 model:SM_A546S transport_id:3\n'
const NONE = 'List of devices attached\n'

interface Harness {
  adb: FakeAdb
  repo: FakeRepo
  timer: FakeTimer
  changes: { list: PhoneDto[]; warning?: string }[]
  manager: DeviceManager
}

function makeHarness(options: { autoReconnect?: boolean; adbPath?: () => string } = {}): Harness {
  const adb = new FakeAdb()
  const repo = new FakeRepo()
  const timer = new FakeTimer()
  const changes: { list: PhoneDto[]; warning?: string }[] = []
  const manager = new DeviceManager({
    adb,
    repo,
    now: () => 1_000,
    adbPath: options.adbPath,
    autoReconnect: () => options.autoReconnect !== false,
    onChange: (list, warning) => changes.push({ list, warning }),
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval
  })
  return { adb, repo, timer, changes, manager }
}

/** adb 호출 중 `devices` 조회만 센다 */
function deviceCalls(adb: FakeAdb): string[][] {
  return adb.calls.filter((c) => c[0] === 'devices')
}

describe('DeviceManager 폴링', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  it('start() 후 5초 주기로 devices -l 을 부른다', async () => {
    h.adb.reply('devices -l', ONE)
    h.manager.start()
    await Promise.resolve()
    expect(h.timer.lastMs).toBe(DEVICE_POLL_INTERVAL_MS)
    expect(deviceCalls(h.adb)).toHaveLength(1)
    h.timer.tick()
    h.timer.tick()
    await Promise.resolve()
    expect(deviceCalls(h.adb)).toHaveLength(3)
    h.manager.stop()
    h.timer.tick()
    expect(deviceCalls(h.adb)).toHaveLength(3)
  })

  it('새 폰이 보이면 저장하고 변경을 1회 통지한다', async () => {
    h.adb.reply('devices -l', ONE)
    const list = await h.manager.refresh()
    expect(list).toHaveLength(1)
    expect(list[0].serial).toBe('R3CRA05HY3R')
    expect(list[0].state).toBe('online')
    expect(h.repo.rows).toHaveLength(1)
    expect(h.changes).toHaveLength(1)
  })

  it('같은 목록이 반복되면 다시 통지하지 않는다', async () => {
    h.adb.reply('devices -l', ONE)
    await h.manager.refresh()
    await h.manager.refresh()
    await h.manager.refresh()
    expect(h.changes).toHaveLength(1)
    expect(h.manager.list()).toHaveLength(1)
  })

  it('목록에서 사라진 폰은 disconnected 로 바뀌며 통지한다', async () => {
    h.adb.reply('devices -l', ONE)
    await h.manager.refresh()
    h.adb.reply('devices -l', NONE)
    const list = await h.manager.refresh()
    expect(list[0].state).toBe('disconnected')
    expect(h.changes).toHaveLength(2)
  })

  it('unauthorized 는 그대로 보고하고 자동 복구 대상이 아니다', async () => {
    h.adb.reply('devices -l', 'List of devices attached\nZY227FAKE9 unauthorized usb:1-6\n')
    const list = await h.manager.refresh()
    expect(list[0].state).toBe('unauthorized')
    expect(h.adb.calls.some((c) => c[0] === 'kill-server')).toBe(false)
  })
})

describe('DeviceManager 실패 내성', () => {
  it('adb 경로가 비어 있으면 adb 를 아예 부르지 않는다', async () => {
    const h = makeHarness({ adbPath: () => '' })
    h.manager.start()
    await Promise.resolve()
    h.timer.tick()
    await Promise.resolve()
    expect(h.adb.calls).toHaveLength(0)
    expect(h.manager.list()).toEqual([])
    h.manager.stop()
  })

  it('adb 실행이 던져도 refresh 는 빈 목록을 돌려주고 예외를 내보내지 않는다', async () => {
    const h = makeHarness()
    h.adb.run = (): Promise<never> => Promise.reject(new Error('adb path is not set'))
    await expect(h.manager.refresh()).resolves.toEqual([])
    expect(h.changes).toHaveLength(0)
  })

  it('한 번 실패해도 직전 목록을 지우지 않는다', async () => {
    const h = makeHarness()
    h.adb.reply('devices -l', ONE)
    await h.manager.refresh()
    const before = h.manager.list()
    h.adb.run = (): Promise<never> => Promise.reject(new Error('adb server died'))
    expect(await h.manager.refresh()).toEqual(before)
    expect(h.manager.list()).toEqual(before)
  })

  it('폴링 중 adb 가 던져도 unhandledRejection 이 나지 않는다', async () => {
    const rejections: unknown[] = []
    const onReject = (e: unknown): void => {
      rejections.push(e)
    }
    process.on('unhandledRejection', onReject)
    try {
      const h = makeHarness()
      h.adb.run = (): Promise<never> => Promise.reject(new Error('adb path is not set'))
      h.manager.start()
      h.timer.tick()
      // 마이크로태스크가 모두 빠진 뒤에야 미처리 거부가 보고된다
      await new Promise((r) => setTimeout(r, 10))
      h.manager.stop()
    } finally {
      process.off('unhandledRejection', onReject)
    }
    expect(rejections).toEqual([])
  })

  it('recover() 도 adb 가 던지면 false 를 돌려준다', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.run = (): Promise<never> => Promise.reject(new Error('adb path is not set'))
    expect(await h.manager.recover('R3CRA05HY3R')).toBe(false)
  })
})

describe('DeviceManager 끊김 복구', () => {
  it('recover(): 붙어 있는 다른 폰이 없을 때만 adb 서버를 껐다 켠다(마지막 수단, 재시도 없음)', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.reply('devices -l', NONE)
    const ok = await h.manager.recover('R3CRA05HY3R')
    expect(ok).toBe(false)
    const calls = h.adb.calls.map((c) => c.join(' '))
    expect(calls).toContain('reconnect offline')
    expect(calls.filter((c) => c === 'kill-server')).toHaveLength(1)
    expect(calls.indexOf('reconnect offline')).toBeLessThan(calls.indexOf('kill-server'))
  })

  it('recover(): 다른 폰이 붙어 있으면 서버를 건드리지 않는다 — 그 폰의 연결·화면 전송이 끊기지 않게', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.reply('devices -l', 'List of devices attached\nOTHERPHONE device model:SM_F711N\n')
    expect(await h.manager.recover('RF9X4021NHD')).toBe(false)
    expect(h.adb.calls.some((c) => c[0] === 'kill-server')).toBe(false)
  })

  it('recover(): 같은 와이파이에서 발견되면 그 주소로 connect 해서 되살린다', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.reply(
      'mdns services',
      'List of discovered mdns services\nadb-RF9X4021NHD-iEPG7p\t_adb-tls-connect._tcp\t192.168.45.126:40449\n'
    )
    h.adb.reply(
      'devices -l',
      'List of devices attached\nadb-RF9X4021NHD-iEPG7p._adb-tls-connect._tcp device model:SM_A155N\n'
    )
    expect(await h.manager.recover('RF9X4021NHD')).toBe(true)
    const calls = h.adb.calls.map((c) => c.join(' '))
    expect(calls).toContain('connect 192.168.45.126:40449')
    expect(calls).not.toContain('kill-server')
  })

  it('복구 후 폰이 보이면 true 를 돌려준다', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.reply('devices -l', ONE)
    expect(await h.manager.recover('R3CRA05HY3R')).toBe(true)
  })

  it('자동 복구는 끊긴 폰마다 1회만 시도한다', async () => {
    const h = makeHarness()
    h.adb.reply('devices -l', ONE)
    await h.manager.refresh()
    h.adb.reply('devices -l', NONE)
    await h.manager.refresh()
    await h.manager.refresh()
    await h.manager.refresh()
    expect(h.adb.calls.filter((c) => c[0] === 'kill-server')).toHaveLength(1)
  })

  it('autoReconnect() 가 false 면 끊겨도 자동 복구하지 않는다', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.reply('devices -l', ONE)
    await h.manager.refresh()
    h.adb.reply('devices -l', NONE)
    await h.manager.refresh()
    expect(h.adb.calls.some((c) => c[0] === 'kill-server')).toBe(false)
  })
})

describe('DeviceManager 상한과 와이파이', () => {
  it('동시 연결 상한이 없다 — 붙어 있는 폰은 몇 대든 모두 online 이고 경고도 없다', async () => {
    const h = makeHarness()
    const lines = ['List of devices attached']
    for (let i = 0; i < 5; i++) {
      lines.push(`SERIAL${i} device usb:1-${i} model:SM_A54${i}`)
    }
    h.adb.reply('devices -l', `${lines.join('\n')}\n`)
    const list = await h.manager.refresh()
    expect(list).toHaveLength(5)
    expect(list.every((p) => p.state === 'online')).toBe(true)
    expect(h.changes[0].warning).toBeUndefined()
  })

  it('connectWifi 는 포트를 생략하면 5555 를 붙인다', async () => {
    const h = makeHarness()
    h.adb.reply('connect', 'connected to 192.168.0.5:5555')
    h.adb.reply('devices -l', NONE)
    const res = await h.manager.connectWifi('192.168.0.5')
    expect(res.ok).toBe(true)
    expect(h.adb.calls[0]).toEqual(['connect', '192.168.0.5:5555'])
  })

  it('connectWifi 는 이미 포트가 있으면 그대로 쓴다', async () => {
    const h = makeHarness()
    h.adb.reply('connect', 'failed to connect to 192.168.0.5:5037')
    const res = await h.manager.connectWifi('192.168.0.5:5037')
    expect(res.ok).toBe(false)
    expect(h.adb.calls[0]).toEqual(['connect', '192.168.0.5:5037'])
  })

  it('disconnect 는 serial 로 끊고 목록을 다시 읽는다', async () => {
    const h = makeHarness()
    h.adb.reply('devices -l', NONE)
    await h.manager.disconnect('192.168.0.5:5555')
    expect(h.adb.calls[0]).toEqual(['disconnect', '192.168.0.5:5555'])
    expect(deviceCalls(h.adb)).toHaveLength(1)
  })
})

// --- PhoneService ----------------------------------------------------------
// 경로 탐지 테스트에서 "있다"고 답할 단 하나의 후보
const ADB_FOUND = ADB_CANDIDATES[0]

class FakeServiceRepo extends FakeRepo implements PhoneServiceRepo {
  readonly assigned: [number, number | null][] = []
  readonly smsFlags: [number, boolean][] = []

  setLabel(id: number, label: string, country: string): void {
    const row = this.rows.find((r) => r.id === id)
    if (row) {
      row.label = label
      row.country = country
    }
  }
  setSmsQueryOk(id: number, ok: boolean): void {
    this.smsFlags.push([id, ok])
    const row = this.rows.find((r) => r.id === id)
    if (row) row.smsQueryOk = ok
  }
  assignAccount(accountId: number, phoneId: number | null): void {
    this.assigned.push([accountId, phoneId])
  }
  phoneForAccount(accountId: number): PhoneRowLike | null {
    const found = this.assigned.filter(([a]) => a === accountId).pop()
    if (!found || found[1] === null) return null
    return this.rows.find((r) => r.id === found[1]) ?? null
  }
  listAuthEvents(): [] {
    return []
  }
}

function makeService(options: { adbPath?: string } = {}): {
  adb: FakeAdb
  repo: FakeServiceRepo
  emitted: { list: PhoneDto[]; warning?: string }[]
  settings: Settings
  service: PhoneService
} {
  const adb = new FakeAdb()
  const repo = new FakeServiceRepo()
  const emitted: { list: PhoneDto[]; warning?: string }[] = []
  // 기기 감시는 adb 경로가 설정돼 있을 때만 adb 를 부른다 — 기본은 찾은 경로를 미리 넣어 둔다
  let settings: Settings = { ...DEFAULT_SETTINGS, adbPath: options.adbPath ?? ADB_FOUND }
  const service = new PhoneService({
    adb,
    repo,
    settings: {
      get: () => settings,
      set: (patch) => {
        settings = { ...settings, ...patch }
        return settings
      }
    },
    emit: (list, warning) => emitted.push({ list, warning }),
    emitAuthWaiting: () => {},
    now: () => 1_000,
    exists: (p) => p === ADB_FOUND
  })
  return {
    adb,
    repo,
    emitted,
    get settings() {
      return settings
    },
    service
  }
}

describe('PhoneService', () => {
  it('detectPaths 는 찾은 경로로 비어 있는 설정을 채운다', () => {
    const s = makeService({ adbPath: '' })
    const found = s.service.detectPaths()
    expect(found.adb).toBe(ADB_FOUND)
    expect(found.scrcpy).toBe('')
    expect(s.settings.adbPath).toBe(ADB_FOUND)
  })

  it('폰이 붙으면 문자 DB 시험 조회를 폰당 1회만 한다', async () => {
    const s = makeService()
    s.adb.reply('devices -l', ONE)
    s.adb.reply('content query', 'Row: 0 _id=1')
    await s.service.refresh()
    await s.service.refresh()
    const probes = s.adb.calls.filter((c) => c.includes('content'))
    expect(probes).toHaveLength(1)
    expect(s.repo.smsFlags).toEqual([[1, true]])
  })

  it('권한이 없으면 문자 DB 조회 불가로 기록한다', async () => {
    const s = makeService()
    s.adb.reply('devices -l', ONE)
    s.adb.reply('content query', 'Error: Permission Denial: reading SmsProvider')
    await s.service.refresh()
    expect(s.repo.smsFlags).toEqual([[1, false]])
  })

  it('assignForJob 은 매핑된 폰을 돌려주고 없으면 null 이다', async () => {
    const s = makeService()
    s.adb.reply('devices -l', ONE)
    await s.service.refresh()
    expect(s.service.assignForJob(7)).toBeNull()
    s.service.assign(7, 1)
    expect(s.service.assignForJob(7)?.serial).toBe('R3CRA05HY3R')
  })

  it('setLabel 은 나라 값이 이상하면 KR 로 되돌린다', async () => {
    const s = makeService()
    s.adb.reply('devices -l', ONE)
    await s.service.refresh()
    s.service.setLabel(1, '업무용', 'XX')
    expect(s.repo.rows[0]).toMatchObject({ label: '업무용', country: 'KR' })
  })
})

describe('와이파이 폰 자동 발견(adb mdns services)', () => {
  const MDNS =
    'List of discovered mdns services\n' +
    'adb-R3CR50QEJJN\t_adb._tcp\t192.168.45.212:5555\n' +
    'adb-R3CR50QEJJN-abc123\t_adb-tls-pairing._tcp\t192.168.45.212:37001\n'
  const connects = (adb: FakeAdb): string[][] => adb.calls.filter((c) => c[0] === 'connect')

  it('발견된 접속점이 목록에 없으면 connect 하고 목록을 다시 읽는다', async () => {
    const h = makeHarness()
    h.adb.reply('devices -l', 'List of devices attached\n')
    h.adb.reply('mdns services', MDNS)
    await h.manager.refresh()
    expect(connects(h.adb)).toEqual([['connect', '192.168.45.212:5555']])
    expect(deviceCalls(h.adb)).toHaveLength(2)
  })

  it('페어링 서비스에는 connect 하지 않는다', async () => {
    const h = makeHarness()
    h.adb.reply('devices -l', 'List of devices attached\n')
    h.adb.reply('mdns services', MDNS)
    await h.manager.refresh()
    expect(connects(h.adb).some((c) => c[1].endsWith(':37001'))).toBe(false)
  })

  it('같은 폰이 USB 로 이미 붙어 있거나 이미 연결된 주소면 건너뛴다', async () => {
    const usb = makeHarness()
    usb.adb.reply('devices -l', 'List of devices attached\nR3CR50QEJJN device model:SM_A155N\n')
    usb.adb.reply('mdns services', MDNS)
    await usb.manager.refresh()
    expect(connects(usb.adb)).toEqual([])

    const wifi = makeHarness()
    wifi.adb.reply('devices -l', 'List of devices attached\n192.168.45.212:5555 unauthorized\n')
    wifi.adb.reply('mdns services', MDNS)
    await wifi.manager.refresh()
    expect(connects(wifi.adb)).toEqual([])
  })

  it('방금 시도한 주소는 쉬는 시간 동안 다시 두드리지 않는다', async () => {
    const h = makeHarness()
    h.adb.reply('devices -l', 'List of devices attached\n')
    h.adb.reply('mdns services', MDNS)
    await h.manager.refresh()
    await h.manager.refresh()
    expect(connects(h.adb)).toHaveLength(1)
  })
})

describe('무선 디버깅 페어링(adb pair)', () => {
  it('주소와 6자리 코드로 adb pair 를 부르고, 성공하면 목록을 다시 읽는다', async () => {
    const h = makeHarness()
    h.adb.reply(
      'pair 192.168.45.212:37123',
      'Successfully paired to 192.168.45.212:37123 [guid=adb-X]'
    )
    h.adb.reply('devices -l', 'List of devices attached\n')
    const r = await h.manager.pairWifi(' 192.168.45.212:37123 ', '123 456')
    expect(r.ok).toBe(true)
    expect(h.adb.calls.find((c) => c[0] === 'pair')).toEqual([
      'pair',
      '192.168.45.212:37123',
      '123456'
    ])
    expect(deviceCalls(h.adb).length).toBeGreaterThan(0)
  })

  it('주소·코드 형식이 틀리면 adb 를 부르지 않는다', async () => {
    const h = makeHarness()
    expect((await h.manager.pairWifi('192.168.45.212', '123456')).ok).toBe(false)
    expect((await h.manager.pairWifi('192.168.45.212:37123', '12345')).ok).toBe(false)
    expect(h.adb.calls.some((c) => c[0] === 'pair')).toBe(false)
  })

  it('코드가 틀리면 실패와 adb 문구를 돌려준다', async () => {
    const h = makeHarness()
    h.adb.reply('pair 192.168.45.212:37123', 'Failed: Wrong password or connection was dropped.')
    const r = await h.manager.pairWifi('192.168.45.212:37123', '000000')
    expect(r).toEqual({ ok: false, message: 'Failed: Wrong password or connection was dropped.' })
  })
})

describe('같은 폰의 여러 전송 이름을 한 줄로 합친다', () => {
  const MDNS =
    'List of discovered mdns services\n' +
    'adb-RF9X4021NHD-iEPG7p\t_adb-tls-connect._tcp\t192.168.45.126:40449\n'
  // 실기 그대로: 무선 디버깅 폰 한 대가 서비스 이름과 ip:port 두 이름으로 동시에 보인다
  const DEVICES =
    'List of devices attached\n' +
    '192.168.45.126:40449 device product:a15ks model:SM_A155N\n' +
    'adb-RF9X4021NHD-iEPG7p._adb-tls-connect._tcp device product:a15ks model:SM_A155N\n'

  it('한 대로 세고, 저장은 실제 시리얼로, 명령용 serial 은 전송 이름으로 준다', async () => {
    const h = makeHarness()
    h.adb.reply('devices -l', DEVICES)
    h.adb.reply('mdns services', MDNS)
    const list = await h.manager.refresh()
    expect(h.repo.rows.map((r) => r.serial)).toEqual(['RF9X4021NHD'])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      serial: 'adb-RF9X4021NHD-iEPG7p._adb-tls-connect._tcp',
      state: 'online',
      transport: 'wifi'
    })
    // 이미 붙어 있는 폰에 connect 를 또 걸지 않는다
    expect(h.adb.calls.some((c) => c[0] === 'connect')).toBe(false)
  })

  it('USB 로 등록해 둔 줄(이름 붙인 폰)이 와이파이로 붙어도 그 줄 그대로 쓴다', async () => {
    const h = makeHarness()
    h.repo.upsertSeen({
      serial: 'RF9X4021NHD',
      model: 'SM A155N',
      transport: 'usb',
      state: 'online',
      at: 1
    })
    h.repo.rows[0].label = '이가명'
    h.adb.reply('devices -l', DEVICES)
    h.adb.reply('mdns services', MDNS)
    const list = await h.manager.refresh()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: '이가명', state: 'online' })
  })

  it('끊긴 옛 줄이 몇 개든 새로 붙은 폰은 바로 쓴다', async () => {
    const h = makeHarness()
    for (const s of ['OLD1', 'OLD2', 'OLD3'])
      h.repo.upsertSeen({ serial: s, model: '', transport: 'usb', state: 'online', at: 1 })
    h.adb.reply('devices -l', 'List of devices attached\nNEW1 device model:SM_F711N\n')
    const list = await h.manager.refresh()
    expect(list.find((p) => p.serial === 'NEW1')?.state).toBe('online')
  })
})

describe('옛 포트로 남은 ip:port 줄 정리', () => {
  it('같은 IP 의 주인을 알면 그 폰 줄로 합친다(무선 디버깅 포트는 매번 바뀐다)', async () => {
    const h = makeHarness()
    const merged: string[][] = []
    ;(h.repo as unknown as { mergeAlias: (a: string, r: string) => void }).mergeAlias = (a, r) => {
      merged.push([a, r])
      const i = h.repo.rows.findIndex((row) => row.serial === a)
      if (i >= 0) h.repo.rows.splice(i, 1)
    }
    h.repo.upsertSeen({
      serial: 'RF9X4021NHD',
      model: 'SM A155N',
      transport: 'wifi',
      state: 'online',
      at: 1
    })
    h.repo.upsertSeen({
      serial: '192.168.45.126:40449',
      model: 'SM A155N',
      transport: 'wifi',
      state: 'online',
      at: 1
    })
    h.adb.reply(
      'devices -l',
      'List of devices attached\nadb-RF9X4021NHD-iEPG7p._adb-tls-connect._tcp device model:SM_A155N\n'
    )
    h.adb.reply(
      'mdns services',
      'List of discovered mdns services\nadb-RF9X4021NHD-iEPG7p\t_adb-tls-connect._tcp\t192.168.45.126:41777\n'
    )
    const list = await h.manager.refresh()
    expect(merged).toContainEqual(['192.168.45.126:40449', 'RF9X4021NHD'])
    expect(list.map((p) => p.label)).toEqual(['SM A155N'])
  })
})

describe('지운 폰은 다시 끌어오지 않는다', () => {
  const MDNS = 'List of discovered mdns services\nadb-R3CR50QEJJN\t_adb._tcp\t192.168.45.212:5555\n'

  it('무시 목록의 폰은 보여도 저장하지 않고, 발견돼도 connect 하지 않는다', async () => {
    const adb = new FakeAdb()
    const repo = new FakeRepo()
    const manager = new DeviceManager({
      adb,
      repo,
      now: () => 1_000,
      autoReconnect: () => false,
      ignored: () => ['R3CR50QEJJN'],
      onChange: () => {}
    })
    adb.reply('devices -l', 'List of devices attached\n192.168.45.212:5555 unauthorized\n')
    adb.reply('mdns services', MDNS)
    const list = await manager.refresh()
    expect(list).toEqual([])
    expect(repo.rows).toEqual([])
    expect(adb.calls.some((c) => c[0] === 'connect')).toBe(false)
  })

  it('disconnectAll 은 그 폰의 와이파이 전송만 끊는다', async () => {
    const h = makeHarness()
    h.adb.reply(
      'devices -l',
      'List of devices attached\nR3CRA05HY3R device model:SM_F711N\n192.168.45.212:5555 unauthorized\n'
    )
    h.adb.reply('mdns services', MDNS)
    await h.manager.disconnectAll('R3CR50QEJJN')
    expect(h.adb.calls.filter((c) => c[0] === 'disconnect')).toEqual([
      ['disconnect', '192.168.45.212:5555']
    ])
  })
})

describe('고정 포트(adb tcpip 5555)로 무선 연결을 유지한다', () => {
  // 실기 2026-10-01 SM-A426N: 무선 디버깅은 와이파이가 끊길 때마다 폰이 스스로 꺼서 결제 승인이 멈췄다.
  // 고정 포트 접속은 mDNS 에 안 나오므로 폰에 시리얼을 물어 같은 폰으로 알아본다
  const TLS = 'adb-R5CR30LFATY-mPzLR3._adb-tls-connect._tcp'
  const HEAD = 'List of devices attached\n'
  const MDNS_HEAD = 'List of discovered mdns services\n'
  const MDNS = MDNS_HEAD + 'adb-R5CR30LFATY-mPzLR3\t_adb-tls-connect._tcp\t192.168.45.116:46055\n'
  const SEEN = { serial: 'R5CR30LFATY', model: 'SM_A426N', transport: 'usb', state: 'online', at: 1 }

  it('무선 디버깅으로만 붙은 폰은 고정 포트로 전환하고 그 주소를 기억한다', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.adb.reply('devices -l', HEAD + TLS + ' device model:SM_A426N\n')
    h.adb.reply('mdns services', MDNS)
    await h.manager.refresh()
    expect(h.adb.calls).toContainEqual(['-s', TLS, 'tcpip', '5555'])
    expect(h.repo.rows[0]).toMatchObject({
      serial: 'R5CR30LFATY',
      wifiAddress: '192.168.45.116:5555'
    })
    // 한 번 시도한 폰을 주기마다 다시 전환하지 않는다
    await h.manager.refresh()
    expect(h.adb.calls.filter((c) => c[2] === 'tcpip')).toHaveLength(1)
  })

  it('고정 포트로만 붙어 있어도(mDNS 에 없음) 같은 폰으로 알아본다', async () => {
    const h = makeHarness({ autoReconnect: false })
    h.repo.upsertSeen(SEEN)
    h.adb.reply('devices -l', HEAD + '192.168.45.116:5555 device model:SM_A426N\n')
    h.adb.reply('mdns services', MDNS_HEAD)
    h.adb.reply('getprop ro.serialno', 'R5CR30LFATY\n')
    const list = await h.manager.refresh()
    expect(h.repo.rows.map((r) => r.serial)).toEqual(['R5CR30LFATY'])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ serial: '192.168.45.116:5555', state: 'online' })
    expect(h.repo.rows[0].wifiAddress).toBe('192.168.45.116:5555')
    // 이미 고정 포트면 전환하지 않는다
    expect(h.adb.calls.some((c) => c[2] === 'tcpip')).toBe(false)
  })

  it('끊긴 폰은 기억한 고정 주소로 다시 붙인다', async () => {
    const h = makeHarness({ autoReconnect: false })
    const row = h.repo.upsertSeen(SEEN)
    h.repo.setWifiAddress(row.id, '192.168.45.116:5555')
    h.adb.reply('devices -l', HEAD)
    h.adb.reply('mdns services', MDNS_HEAD)
    h.adb.reply('connect 192.168.45.116:5555', 'connected to 192.168.45.116:5555')
    await h.manager.refresh()
    expect(h.adb.calls).toContainEqual(['connect', '192.168.45.116:5555'])
    // 쉬는 시간 안에는 다시 두드리지 않는다
    await h.manager.refresh()
    expect(h.adb.calls.filter((c) => c[0] === 'connect')).toHaveLength(1)
  })
})
