// 폰 중계(phone/relay.ts) — 다른 PC 에 USB 로 붙은 폰을 그 PC 의 adb 서버를 거쳐 쓴다
import { describe, it, expect, vi } from 'vitest'
import {
  createPhoneRelay,
  createRelayingAdb,
  parseRelayHost,
  pickLanAddress,
  relayArgs,
  relayHostsOf,
  relayServerArgs,
  relayTargets,
  serialOfArgs,
  RELAY_PORT
} from '../src/main/phone/relay'
import { buildRegistry, type PhoneRegistryEntry } from '../src/shared/phone-registry'
import type { AdbRunner } from '../src/main/phone/process'

const entry = (serial: string, relayHost: string | null): PhoneRegistryEntry => ({
  serial,
  label: serial,
  country: 'KR',
  transport: 'usb',
  wifiAddress: null,
  model: 'SM-A426N',
  isDefault: false,
  relayHost
})

describe('중계 주소·인자', () => {
  it('ip:port 만 중계 주소로 받는다', () => {
    expect(parseRelayHost('192.168.0.7:5037')).toEqual({ host: '192.168.0.7', port: 5037 })
    expect(parseRelayHost('192.168.0.7')).toBeNull()
    expect(parseRelayHost('host:5037')).toBeNull()
    expect(parseRelayHost(null)).toBeNull()
  })

  it('중계 서버는 모든 인터페이스에서 받는 nodaemon 서버다', () => {
    expect(relayServerArgs()).toEqual(['-a', '-P', String(RELAY_PORT), 'nodaemon', 'server'])
  })

  it('-H/-P 를 맨 앞에 붙이고, -s 의 시리얼을 읽는다', () => {
    const args = ['-s', 'R5CR30LFATY', 'shell', 'input', 'tap', '1', '2']
    expect(relayArgs({ host: '10.0.0.2', port: 5037 }, args)).toEqual([
      '-H',
      '10.0.0.2',
      '-P',
      '5037',
      ...args
    ])
    expect(serialOfArgs(args)).toBe('R5CR30LFATY')
    expect(serialOfArgs(['devices', '-l'])).toBeNull()
  })

  it('LAN 주소는 사설 192.168 → 10 → 172.16 순으로 고르고 루프백·APIPA 는 뺀다', () => {
    const ifaces = {
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      vpn: [{ family: 'IPv4', address: '10.8.0.3', internal: false }],
      wifi: [
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv4', address: '192.168.45.10', internal: false }
      ],
      dead: [{ family: 'IPv4', address: '169.254.3.3', internal: false }]
    }
    expect(pickLanAddress(ifaces)).toBe('192.168.45.10')
    expect(pickLanAddress({ lo: ifaces.lo })).toBeNull()
  })
})

describe('relayTargets', () => {
  const registry = [
    entry('R5CR30LFATY', '192.168.45.10:5037'),
    entry('LOCALPHONE', '192.168.45.10:5037'),
    entry('MINE', '192.168.45.99:5037'),
    entry('NOHOST', null)
  ]

  it('로컬에 붙어 있는 폰과 이 PC 자신의 중계 주소는 뺀다', () => {
    const t = relayTargets(registry, new Set(['LOCALPHONE']), '192.168.45.99:5037')
    expect([...t.keys()]).toEqual(['R5CR30LFATY'])
    expect(t.get('R5CR30LFATY')).toEqual({ host: '192.168.45.10', port: 5037 })
    expect(relayHostsOf(t)).toEqual([{ host: '192.168.45.10', port: 5037 }])
  })

  it('buildRegistry 는 중계를 켠 PC 에 붙어 있는 폰에만 relayHost 를 싣는다', () => {
    const rows = [
      { id: 1, serial: 'A', label: 'a', country: 'KR' as const, transport: 'usb' as const, wifiAddress: null, model: '' },
      { id: 2, serial: 'B', label: 'b', country: 'KR' as const, transport: 'usb' as const, wifiAddress: null, model: '' }
    ]
    const out = buildRegistry(rows, 'A', [], { host: '192.168.45.10:5037', connected: ['A'] })
    expect(out.map((e) => [e.serial, e.relayHost])).toEqual([
      ['A', '192.168.45.10:5037'],
      ['B', null]
    ])
    expect(buildRegistry(rows, 'A', []).every((e) => e.relayHost === null)).toBe(true)
  })
})

describe('createRelayingAdb', () => {
  const calls: string[][] = []
  const inner: AdbRunner = {
    run: async (args) => {
      calls.push(args)
      return { code: 0, stdout: '', stderr: '' }
    },
    runBinary: async (args) => {
      calls.push(args)
      return Buffer.alloc(0)
    },
    stream: (args, _d, onEnd) => {
      calls.push(args)
      onEnd(0)
      return () => {}
    }
  }

  it('중계 폰의 명령만 -H/-P 를 붙이고 나머지는 그대로 보낸다', async () => {
    calls.length = 0
    const adb = createRelayingAdb(inner, (serial) =>
      serial === 'REMOTE' ? { host: '192.168.45.10', port: 5037 } : null
    )
    await adb.run(['-s', 'REMOTE', 'shell', 'ls'])
    await adb.run(['-s', 'LOCAL', 'shell', 'ls'])
    await adb.run(['devices', '-l'])
    adb.stream(['-s', 'REMOTE', 'exec-out', 'screenrecord'], () => {}, () => {})
    expect(calls[0]).toEqual(['-H', '192.168.45.10', '-P', '5037', '-s', 'REMOTE', 'shell', 'ls'])
    expect(calls[1]).toEqual(['-s', 'LOCAL', 'shell', 'ls'])
    expect(calls[2]).toEqual(['devices', '-l'])
    expect(calls[3].slice(0, 4)).toEqual(['-H', '192.168.45.10', '-P', '5037'])
  })
})

interface RelayHarness {
  relay: ReturnType<typeof createPhoneRelay>
  runs: string[][]
  spawned: string[][]
  settings: { phoneRelayEnabled: boolean; phoneRegistry: PhoneRegistryEntry[] }
  timers: (() => void)[]
  killed: () => number
}

describe('createPhoneRelay', () => {
  function harness(enabled: boolean, registry: PhoneRegistryEntry[] = []): RelayHarness {
    const runs: string[][] = []
    const spawned: string[][] = []
    let killed = 0
    const timers: (() => void)[] = []
    const adb: AdbRunner = {
      run: async (args) => {
        runs.push(args)
        return { code: 0, stdout: '', stderr: '' }
      },
      runBinary: async () => Buffer.alloc(0),
      stream: () => () => {}
    }
    const settings = { phoneRelayEnabled: enabled, phoneRegistry: registry }
    const relay = createPhoneRelay({
      adb,
      spawn: (args) => {
        spawned.push(args)
        return () => {
          killed += 1
        }
      },
      settings: () => settings,
      localOnline: () => new Set(['LOCAL']),
      interfaces: () => ({ wifi: [{ family: 'IPv4', address: '192.168.45.10', internal: false }] }),
      setInterval: (fn) => {
        timers.push(fn)
        return 1
      },
      clearInterval: () => {},
      log: () => {}
    })
    return { relay, runs, spawned, settings, timers, killed: () => killed }
  }

  it('켜져 있으면 kill-server 뒤 중계 서버를 띄우고, 등록 정보에 자기 주소와 붙은 폰을 싣는다', async () => {
    const h = harness(true)
    h.relay.start()
    await vi.waitFor(() => expect(h.spawned.length).toBe(1))
    expect(h.runs[0]).toEqual(['kill-server'])
    expect(h.spawned[0]).toEqual(relayServerArgs())
    expect(h.relay.serving()).toBe(true)
    expect(h.relay.published()).toEqual({ host: '192.168.45.10:5037', connected: ['LOCAL'] })
  })

  it('꺼지면 서버를 내리고 등록 정보에는 싣지 않는다', async () => {
    const h = harness(true)
    h.relay.start()
    await vi.waitFor(() => expect(h.spawned.length).toBe(1))
    h.settings.phoneRelayEnabled = false
    h.timers[0]()
    expect(h.killed()).toBe(1)
    expect(h.relay.serving()).toBe(false)
    expect(h.relay.published()).toBeNull()
  })

  it('다른 PC 가 중계하는 폰만 경로를 돌려준다(자기 주소·로컬 폰 제외)', () => {
    const h = harness(false, [
      entry('REMOTE', '192.168.45.20:5037'),
      entry('LOCAL', '192.168.45.20:5037'),
      entry('OWN', '192.168.45.10:5037')
    ])
    expect(h.relay.targetOf('REMOTE')).toEqual({ host: '192.168.45.20', port: 5037 })
    expect(h.relay.targetOf('LOCAL')).toBeNull()
    expect(h.relay.targetOf('OWN')).toBeNull()
    expect(h.relay.hosts()).toEqual([{ host: '192.168.45.20', port: 5037 }])
    expect(h.spawned.length).toBe(0)
  })
})
