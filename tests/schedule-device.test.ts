import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLocalDevice } from '../src/main/schedule/device'
import { PlaybookStore, type PlaybookSettingsAccess } from '../src/main/playbooks/store'
import type { PlaybookDto } from '../src/shared/playbook'
import { normalizeSchedule } from '../src/shared/schedule'

describe('이 PC 의 기기 식별자', () => {
  it('처음엔 만들고 다시 읽으면 같은 값이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samba-dev-'))
    const file = join(dir, 'device-id.json')
    const first = loadLocalDevice(file, 'PC-A')
    expect(first.id.length).toBeGreaterThanOrEqual(8)
    expect(first.name).toBe('PC-A')
    expect(JSON.parse(readFileSync(file, 'utf8')).id).toBe(first.id)
    expect(loadLocalDevice(file, 'PC-A').id).toBe(first.id)
  })

  it('깨진 파일은 새로 만든다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samba-dev-'))
    const file = join(dir, 'device-id.json')
    writeFileSync(file, '{깨짐', 'utf8')
    expect(loadLocalDevice(file, 'PC-A').id.length).toBeGreaterThanOrEqual(8)
  })
})

describe('예약을 저장한 PC 가 실행 주체가 된다', () => {
  function store(device?: { id: string; name: string }): PlaybookStore {
    let rows: PlaybookDto[] = []
    const settings: PlaybookSettingsAccess = {
      get: () => ({ playbooks: rows }),
      set: (patch) => {
        rows = patch.playbooks
        return { playbooks: rows }
      }
    }
    return new PlaybookStore(
      settings,
      () => 1,
      () => 'pb-1',
      device
    )
  }

  it('켜진 예약을 저장하면 이 PC 가 주인이 된다', () => {
    const saved = store({ id: 'dev-b-0001', name: 'PC-B' }).put({
      name: '정리',
      triggers: ['정리'],
      instructions: '절차',
      enabled: true,
      schedule: normalizeSchedule({
        enabled: true,
        kind: 'daily',
        at: '09:00',
        paused: false,
        ownerDeviceId: 'dev-a-0001',
        ownerDeviceName: 'PC-A'
      })
    })
    expect(saved?.schedule?.ownerDeviceId).toBe('dev-b-0001')
    expect(saved?.schedule?.ownerDeviceName).toBe('PC-B')
  })

  it('예약이 꺼져 있으면 주인을 찍지 않는다', () => {
    const saved = store({ id: 'dev-b-0001', name: 'PC-B' }).put({
      name: '정리',
      triggers: ['정리'],
      instructions: '절차',
      enabled: true,
      schedule: normalizeSchedule({ enabled: false, kind: 'manual', paused: false })
    })
    expect(saved?.schedule?.ownerDeviceId).toBeUndefined()
  })
})
