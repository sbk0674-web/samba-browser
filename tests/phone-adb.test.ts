import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADB_CANDIDATES,
  SCRCPY_CANDIDATES,
  detectAdbPath,
  execOutArgs,
  isWifiSerial,
  parseDevices,
  shellArgs
} from '../src/main/phone/adb'
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings'
import { FakeAdb } from './stubs/fake-adb'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'

// `adb devices -l` 의 실제 출력 모양(머리줄·빈 줄·긴 속성 꼬리표 포함)
const DEVICES_OUT = `List of devices attached\r
R3CRA05HY3R            device usb:1-4 product:a54xks model:SM_A546S device:a54x transport_id:3\r
\r
192.168.0.5:5555       device product:a54xks model:SM_A546S device:a54x transport_id:5\r
ZY227FAKE9             unauthorized usb:1-6 transport_id:7\r
emulator-5554          offline transport_id:9\r
`

describe('parseDevices', () => {
  it('머리줄과 빈 줄을 건너뛰고 serial·state·model 을 뽑는다', () => {
    const devices = parseDevices(DEVICES_OUT)
    expect(devices).toHaveLength(4)
    expect(devices[0]).toEqual({
      serial: 'R3CRA05HY3R',
      state: 'online',
      model: 'SM A546S',
      transport: 'usb'
    })
  })

  it('ip:port 꼴 serial 은 wifi, 그 외는 usb 로 본다', () => {
    const devices = parseDevices(DEVICES_OUT)
    expect(devices[1].serial).toBe('192.168.0.5:5555')
    expect(devices[1].transport).toBe('wifi')
    expect(devices[0].transport).toBe('usb')
    expect(isWifiSerial('192.168.0.5:5555')).toBe(true)
    expect(isWifiSerial('R3CRA05HY3R')).toBe(false)
  })

  it('unauthorized · offline 상태를 그대로 보존한다', () => {
    const devices = parseDevices(DEVICES_OUT)
    expect(devices[2].state).toBe('unauthorized')
    expect(devices[3].state).toBe('offline')
  })

  it('데몬 안내 줄과 빈 출력에서는 아무 기기도 뽑지 않는다', () => {
    const noise = '* daemon not running; starting now at tcp:5037\n* daemon started successfully\n'
    expect(parseDevices(`List of devices attached\n${noise}`)).toEqual([])
    expect(parseDevices('')).toEqual([])
  })
})

describe('detectAdbPath', () => {
  it('후보 중 처음 존재하는 경로를 돌려준다', () => {
    const exists = (p: string): boolean => p === '/b/adb' || p === '/c/adb'
    expect(detectAdbPath(['/a/adb', '/b/adb', '/c/adb'], exists)).toBe('/b/adb')
  })

  it('하나도 없으면 빈 문자열', () => {
    expect(detectAdbPath(['/a/adb', '/b/adb'], () => false)).toBe('')
    expect(detectAdbPath([], () => true)).toBe('')
  })

  it('후보 목록에 특정 PC 의 절대경로를 박아 두지 않는다', () => {
    // 값이 아니라 원본 코드를 본다 — 환경변수로 만든 경로는 실행하는 PC 에 따라 달라진다
    const source = readFileSync(join(__dirname, '../src/main/phone/adb.ts'), 'utf8')
    expect(source).not.toMatch(/'C:\\\\Users\\\\[^']+'/)
    for (const c of [...ADB_CANDIDATES, ...SCRCPY_CANDIDATES]) {
      expect(c.endsWith('adb.exe') || c.endsWith('scrcpy.exe')).toBe(true)
    }
  })
})

describe('shellArgs', () => {
  it('문자열 명령은 공백으로 쪼개 -s <serial> shell 뒤에 붙인다', () => {
    expect(shellArgs('R3C', 'input tap 1 2')).toEqual([
      '-s',
      'R3C',
      'shell',
      'input',
      'tap',
      '1',
      '2'
    ])
  })

  it('쪼개면 안 되는 인자는 배열로 넘겨 그대로 보존한다', () => {
    const args = shellArgs('R3C', ['content', 'query', '--uri', 'content://sms/inbox'])
    expect(args).toEqual(['-s', 'R3C', 'shell', 'content', 'query', '--uri', 'content://sms/inbox'])
    // 배열 인자는 공백 기준으로 다시 쪼개지지 않는다
    expect(args).toHaveLength(7)
  })

  it('exec-out 인자 배열을 조립한다', () => {
    expect(execOutArgs('R3C', ['screencap', '-p'])).toEqual([
      '-s',
      'R3C',
      'exec-out',
      'screencap',
      '-p'
    ])
  })
})

describe('폰 설정', () => {
  it('기본값에 adb/scrcpy 경로와 화면 품질이 있다', () => {
    expect(DEFAULT_SETTINGS.adbPath).toBe('')
    expect(DEFAULT_SETTINGS.scrcpyPath).toBe('')
    expect(DEFAULT_SETTINGS.phoneScreenMaxSize).toBe(720)
    expect(DEFAULT_SETTINGS.phoneScreenFps).toBe(15)
    expect(DEFAULT_SETTINGS.phoneAutoReconnect).toBe(true)
    // 결제 키패드 화면을 외부 AI 로 보내는 경로는 기본으로 꿫 둔다
    expect(DEFAULT_SETTINGS.phoneKeypadVisual).toBe(false)
  })

  it('깨진 값은 기본값으로 되돌린다', () => {
    const s = parseSettings({
      ...DEFAULT_SETTINGS,
      adbPath: 42,
      phoneScreenMaxSize: 999,
      phoneScreenFps: 7
    })
    expect(s.adbPath).toBe('')
    expect(s.phoneScreenMaxSize).toBe(720)
    expect(s.phoneScreenFps).toBe(15)
  })

  it('실행 파일 경로만 기기별 값이고, 나머지 폰 설정은 계정에 따라온다', () => {
    const synced: readonly string[] = SYNCED_SETTING_KEYS
    for (const key of ['adbPath', 'scrcpyPath']) {
      expect(synced).not.toContain(key)
    }
    // 폰 목록·기본 폰·담당 계정·지운 폰도 따라온다(사용자 2026-10-02 "폰연동을 해놓으면 다른 PC 에서도 보여야")
    for (const key of [
      'phoneScreenMaxSize',
      'phoneScreenFps',
      'phoneAutoReconnect',
      'phoneKeypadVisual',
      'phoneIgnoredSerials',
      'defaultPhoneSerial',
      'phoneRegistry',
      'phoneAccountLinks'
    ]) {
      expect(synced).toContain(key)
    }
  })
})

describe('FakeAdb', () => {
  it('부분 일치로 지정한 응답을 돌려주고 호출을 기록한다', async () => {
    const adb = new FakeAdb()
    adb.reply('devices -l', DEVICES_OUT)
    const res = await adb.run(['devices', '-l'])
    expect(res.code).toBe(0)
    expect(parseDevices(res.stdout)).toHaveLength(4)
    expect(adb.calls[0]).toEqual(['devices', '-l'])
  })

  it('지정하지 않은 명령은 빈 성공 응답', async () => {
    const adb = new FakeAdb()
    await expect(adb.run(['get-state'])).resolves.toEqual({ code: 0, stdout: '', stderr: '' })
    await expect(adb.runBinary(['exec-out', 'screencap'])).resolves.toEqual(Buffer.alloc(0))
  })

  it('바이너리 응답과 스트림 청크를 흘려보낸다', async () => {
    const adb = new FakeAdb()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    adb.replyBinary('screencap -p', png)
    await expect(adb.runBinary(execOutArgs('R3C', ['screencap', '-p']))).resolves.toEqual(png)

    const chunks: Buffer[] = []
    let ended: number | null = -1
    const stop = adb.stream(
      ['exec-out', 'screenrecord'],
      (c) => chunks.push(c),
      (code) => {
        ended = code
      }
    )
    adb.push(Buffer.from([1, 2, 3]))
    expect(chunks).toEqual([Buffer.from([1, 2, 3])])
    stop()
    expect(ended).toBe(0)
  })
})

describe('parseMdnsServices', () => {
  it('접속할 수 있는 서비스만 시리얼·주소로 뽑는다', async () => {
    const { parseMdnsServices } = await import('../src/main/phone/adb')
    const out = parseMdnsServices(
      'List of discovered mdns services\r\n' +
        'adb-R3CR50QEJJN\t_adb._tcp\t192.168.45.212:5555\r\n' +
        'adb-R3CRA05HY3R-xYz12\t_adb-tls-connect._tcp\t192.168.45.10:41234\r\n' +
        'adb-R3CRA05HY3R-xYz12\t_adb-tls-pairing._tcp\t192.168.45.10:39999\r\n' +
        'garbage line\r\n'
    )
    expect(out).toEqual([
      { serial: 'R3CR50QEJJN', address: '192.168.45.212:5555' },
      { serial: 'R3CRA05HY3R', address: '192.168.45.10:41234' }
    ])
  })
})

describe('realSerialOf', () => {
  it('서비스 이름·ip:port 를 실제 시리얼로 바꾼다', async () => {
    const { realSerialOf } = await import('../src/main/phone/adb')
    const services = [{ serial: 'R3CR50QEJJN', address: '192.168.45.212:5555' }]
    expect(realSerialOf('adb-RF9X4021NHD-iEPG7p._adb-tls-connect._tcp', services)).toBe(
      'RF9X4021NHD'
    )
    expect(realSerialOf('192.168.45.212:5555', services)).toBe('R3CR50QEJJN')
    // 발견 목록에 없는 주소와 USB 시리얼은 그대로
    expect(realSerialOf('10.0.0.9:5555', services)).toBe('10.0.0.9:5555')
    expect(realSerialOf('R3CRA05HY3R', services)).toBe('R3CRA05HY3R')
  })
})
