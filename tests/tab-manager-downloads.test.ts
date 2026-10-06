import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { DownloadItem } from 'electron'
import { handleWillDownload, type DownloadRecord } from '../src/main/browser/downloads'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samba-dl-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

class FakeItem extends EventEmitter {
  received = 0
  setSavePath = vi.fn()
  constructor(
    private name: string,
    private url = 'https://example.com/f'
  ) {
    super()
  }
  getFilename = (): string => this.name
  getURL = (): string => this.url
  getReceivedBytes = (): number => this.received
}

// 세션 'will-download' 를 흉내 낸다: 이벤트 → handleWillDownload
function setup(dir: string | null): {
  records: DownloadRecord[]
  fire: (item: FakeItem) => { preventDefault: ReturnType<typeof vi.fn> }
} {
  const records: DownloadRecord[] = []
  const policy = { getDir: () => dir, onRecord: (r: DownloadRecord) => records.push(r) }
  const fire = (item: FakeItem): { preventDefault: ReturnType<typeof vi.fn> } => {
    const e = { preventDefault: vi.fn() }
    handleWillDownload(policy, e, item as unknown as DownloadItem)
    return e
  }
  return { records, fire }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('will-download 정책', () => {
  it('폴더가 없으면 막는다', () => {
    const { fire, records } = setup(null)
    const item = new FakeItem('a.pdf')
    const e = fire(item)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(records).toHaveLength(0)
  })

  it('폴더가 있으면 정리한 이름으로 저장하고 막지 않는다', () => {
    const { fire, records } = setup(tmp)
    const item = new FakeItem('../evil/..\\x:y.pdf')
    const e = fire(item)
    expect(e.preventDefault).not.toHaveBeenCalled()
    const saved = item.setSavePath.mock.calls[0][0] as string
    expect(path.dirname(saved)).toBe(tmp)
    expect(path.basename(saved)).not.toMatch(/[\\/:]/)
    expect(records[0]).toMatchObject({ file: saved, state: 'progressing', bytes: 0 })
  })

  it('이름이 겹치면 -1, -2 를 붙인다', () => {
    fs.writeFileSync(path.join(tmp, 'dup.txt'), '1')
    fs.writeFileSync(path.join(tmp, 'dup-1.txt'), '1')
    const { fire } = setup(tmp)
    const item = new FakeItem('dup.txt')
    fire(item)
    expect(item.setSavePath).toHaveBeenCalledWith(path.join(tmp, 'dup-2.txt'))
  })

  it('진행·완료·취소·중단 상태를 기록한다', () => {
    const { fire, records } = setup(tmp)
    const a = new FakeItem('s1.bin')
    fire(a)
    a.received = 10
    a.emit('updated')
    expect(records[0].bytes).toBe(10)
    a.received = 20
    a.emit('done', {}, 'completed')
    expect(records[0]).toMatchObject({ state: 'completed', bytes: 20 })

    const b = new FakeItem('s2.bin')
    fire(b)
    b.emit('done', {}, 'cancelled')
    expect(records[1].state).toBe('cancelled')

    const c = new FakeItem('s3.bin')
    fire(c)
    c.emit('done', {}, 'interrupted')
    expect(records[2].state).toBe('interrupted')
  })
})
