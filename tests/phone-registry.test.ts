import { describe, expect, it } from 'vitest'
import {
  buildRegistry,
  isTransportSerial,
  planApply,
  type LocalPhone,
  type PhoneRegistryEntry
} from '../src/shared/phone-registry'

function phone(id: number, serial: string, over: Partial<LocalPhone> = {}): LocalPhone {
  return {
    id,
    serial,
    label: serial,
    country: 'KR',
    transport: 'usb',
    wifiAddress: null,
    model: 'SM',
    ...over
  }
}

function entry(serial: string, over: Partial<PhoneRegistryEntry> = {}): PhoneRegistryEntry {
  return {
    serial,
    label: serial,
    country: 'KR',
    transport: 'usb',
    wifiAddress: null,
    model: 'SM',
    isDefault: false,
    ...over
  }
}

describe('isTransportSerial', () => {
  it('ip:port 와 무선 디버깅 서비스 이름은 임시 줄이다', () => {
    expect(isTransportSerial('192.168.45.126:40449')).toBe(true)
    expect(isTransportSerial('adb-R5CR30LFATY-abc._adb-tls-connect._tcp')).toBe(true)
    expect(isTransportSerial('R5CR30LFATY')).toBe(false)
  })
})

describe('buildRegistry', () => {
  it('임시 줄·지운 폰을 빼고 시리얼순으로, 기본 폰을 표시한다', () => {
    const rows = [
      phone(1, 'R5', { label: '임성희', transport: 'wifi', wifiAddress: '192.168.0.2:5555' }),
      phone(2, '192.168.0.9:40000'),
      phone(3, 'A1'),
      phone(4, 'GONE')
    ]
    expect(buildRegistry(rows, 'R5', ['GONE'])).toEqual([
      entry('A1'),
      entry('R5', {
        label: '임성희',
        transport: 'wifi',
        wifiAddress: '192.168.0.2:5555',
        isDefault: true
      })
    ])
  })
})

describe('planApply', () => {
  it('없는 폰은 새로 만들고, 이름·주소가 다르면 받은 값으로 맞춘다', () => {
    const plan = planApply(
      [
        entry('NEW', { label: '새 폰' }),
        entry('R5', { label: '임성희', wifiAddress: '10.0.0.5:5555', isDefault: true })
      ],
      [phone(7, 'R5', { label: 'SM A426N' })],
      []
    )
    expect(plan.insert.map((e) => e.serial)).toEqual(['NEW'])
    expect(plan.update).toEqual([
      { id: 7, label: '임성희', country: 'KR', wifiAddress: '10.0.0.5:5555' }
    ])
    expect(plan.defaultSerial).toBe('R5')
    expect(plan.remove).toEqual([])
  })

  it('받은 쪽 와이파이 주소가 비어 있으면 이 PC 가 아는 주소를 지우지 않는다', () => {
    const plan = planApply([entry('R5')], [phone(7, 'R5', { wifiAddress: '10.0.0.5:5555' })], [])
    expect(plan.update).toEqual([])
  })

  it('다른 PC 에서 지운 폰은 만들지 않고, 이 PC 에 있으면 지운다', () => {
    const plan = planApply(
      [entry('GONE'), entry('KEEP')],
      [phone(1, 'GONE'), phone(2, 'KEEP')],
      ['GONE']
    )
    expect(plan.insert).toEqual([])
    expect(plan.remove).toEqual([1])
  })

  it('같은 내용이면 할 일이 없다', () => {
    const plan = planApply([entry('R5')], [phone(7, 'R5')], [])
    expect(plan).toEqual({ insert: [], update: [], remove: [], defaultSerial: null })
  })
})

describe('동기화에서 빠지는 설정은 그 PC 에만 맞는 값뿐이다', () => {
  it('경로·이 PC 의 연결·접속 정보·내부 표식 말고는 전부 동기화한다', async () => {
    const { SYNCED_SETTING_KEYS } = await import('../src/shared/sync')
    const { DEFAULT_SETTINGS } = await import('../src/shared/settings')
    const deviceOnly = [
      'adbPath',
      'scrcpyPath',
      'captureDir',
      'extensionPaths',
      'extensionSources',
      'aiConnections',
      'aiConnectionsMigrated',
      'vaultAutoSaveLoginsMigrated',
      'vaultRememberDevice',
      'bridgeEnabled',
      'bridgePort',
      'bridgeToken',
      'harnessApiUrl',
      'activeWorkspaceId',
      'lastUrl',
      'syncSupabaseUrl',
      'syncSupabaseAnonKey'
    ]
    const synced = new Set<string>(SYNCED_SETTING_KEYS)
    const unsynced = Object.keys(DEFAULT_SETTINGS).filter((k) => !synced.has(k))
    expect(unsynced.sort()).toEqual([...deviceOnly].sort())
  })
})
