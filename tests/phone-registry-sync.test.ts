import { describe, expect, it } from 'vitest'
import { PhoneRegistrySync, type PhoneRegistrySyncDeps } from '../src/main/phone/registry-sync'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import type { PhoneRow } from '../src/main/phone/repo'

// 폰 표와 설정을 메모리로 흉내 낸 PC 한 대
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 시험용 묶음이라 추론에 맡긴다
function pc(accountsByRemote: Record<string, number> = {}) {
  let nextId = 1
  const rows: PhoneRow[] = []
  const links = new Map<number, number>() // 계정 → 폰
  let settings: Settings = { ...DEFAULT_SETTINGS }
  const remoteOf = (id: number): string | undefined =>
    Object.entries(accountsByRemote).find(([, v]) => v === id)?.[0]
  const repo: PhoneRegistrySyncDeps['repo'] = {
    list: () => rows.map((r) => ({ ...r })),
    insertKnown: (e) => {
      rows.push({ id: nextId++, smsQueryOk: null, lastSeenAt: 0, workspaceId: null, ...e })
    },
    setLabel: (id, label, country) => {
      const r = rows.find((x) => x.id === id)
      if (r) Object.assign(r, { label, country })
    },
    setWifiAddress: (id, address) => {
      const r = rows.find((x) => x.id === id)
      if (r) r.wifiAddress = address
    },
    remove: (id) => {
      rows.splice(
        rows.findIndex((x) => x.id === id),
        1
      )
      for (const [a, p] of links) if (p === id) links.delete(a)
    },
    assignAccount: (accountId, phoneId) => {
      if (phoneId === null) links.delete(accountId)
      else links.set(accountId, phoneId)
    },
    accountLinks: () =>
      [...links]
        .map(([a, p]) => ({ account: remoteOf(a), serial: rows.find((r) => r.id === p)?.serial }))
        .filter((l): l is { account: string; serial: string } => !!l.account && !!l.serial),
    accountIdByRemote: (remoteId) => accountsByRemote[remoteId] ?? null,
    phoneForAccount: (accountId) => rows.find((r) => r.id === links.get(accountId)) ?? null
  }
  const store = {
    get: () => settings,
    set: (patch: Partial<Settings>) => (settings = { ...settings, ...patch })
  }
  return { repo, store, rows, links, sync: new PhoneRegistrySync({ repo, settings: store }) }
}

/** 한 PC 의 동기화 대상 설정을 다른 PC 로 옮긴다(서버를 거친 것과 같다) */
function deliver(from: ReturnType<typeof pc>, to: ReturnType<typeof pc>): void {
  const s = from.store.get()
  to.store.set({
    phoneRegistry: s.phoneRegistry,
    phoneAccountLinks: s.phoneAccountLinks,
    phoneIgnoredSerials: s.phoneIgnoredSerials,
    defaultPhoneSerial: s.defaultPhoneSerial
  })
}

describe('PhoneRegistrySync', () => {
  it('한 PC 에서 연동한 폰과 담당 계정이 다른 PC 에 그대로 나타난다', () => {
    const a = pc({ 'acc-1': 10 })
    a.repo.insertKnown({
      serial: 'R5',
      label: '임성희',
      country: 'KR',
      transport: 'wifi',
      wifiAddress: '192.168.0.2:5555',
      model: 'SM A426N'
    })
    a.repo.assignAccount(10, a.rows[0].id)
    a.store.set({ defaultPhoneSerial: 'R5' })
    a.sync.publish()

    const b = pc({ 'acc-1': 77 })
    deliver(a, b)
    expect(b.sync.applyRemote()).toBe(true)
    expect(b.rows.map((r) => [r.serial, r.label, r.wifiAddress, r.lastSeenAt])).toEqual([
      ['R5', '임성희', '192.168.0.2:5555', 0]
    ])
    expect(b.links.get(77)).toBe(b.rows[0].id)
    expect(b.store.get().defaultPhoneSerial).toBe('R5')
    // 한 번 더 돌려도 바뀌는 게 없다
    expect(b.sync.applyRemote()).toBe(false)
  })

  it('방금 켠 PC 의 빈 목록이 다른 PC 가 올린 목록을 지우지 않는다', () => {
    const a = pc({ 'acc-1': 10 })
    a.repo.insertKnown({
      serial: 'R5',
      label: '임성희',
      country: 'KR',
      transport: 'usb',
      wifiAddress: null,
      model: ''
    })
    a.repo.assignAccount(10, a.rows[0].id)
    a.sync.publish()

    const b = pc() // 계정이 아직 안 내려온 PC
    deliver(a, b)
    b.sync.publish()
    expect(b.store.get().phoneRegistry.map((e) => e.serial)).toEqual(['R5'])
    expect(b.store.get().phoneAccountLinks).toEqual([{ account: 'acc-1', serial: 'R5' }])
  })

  it('이름을 바꾸거나 폰을 지우면 다른 PC 에도 반영된다', () => {
    const a = pc()
    const b = pc()
    a.repo.insertKnown({
      serial: 'R5',
      label: 'SM A426N',
      country: 'KR',
      transport: 'usb',
      wifiAddress: null,
      model: ''
    })
    a.repo.insertKnown({
      serial: 'F7',
      label: '플립',
      country: 'KR',
      transport: 'usb',
      wifiAddress: null,
      model: ''
    })
    a.sync.publish()
    deliver(a, b)
    b.sync.applyRemote()

    a.repo.setLabel(a.rows[0].id, '임성희', 'KR')
    // 지우기 — 화면의 '지우기'는 지운 폰 목록에 적고 줄을 지운다
    a.store.set({ phoneIgnoredSerials: ['F7'] })
    a.repo.remove(a.rows[1].id)
    a.sync.publish()
    deliver(a, b)
    b.sync.applyRemote()
    expect(b.rows.map((r) => [r.serial, r.label])).toEqual([['R5', '임성희']])
  })
})
