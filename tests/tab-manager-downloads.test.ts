import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { DownloadItem } from 'electron'
import {
  handleWillDownload,
  sanitizeFileName,
  type DownloadRecord
} from '../src/main/browser/downloads'

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
  policy: { reserved: Set<string> }
  fire: (item: FakeItem) => { preventDefault: ReturnType<typeof vi.fn> }
} {
  const records: DownloadRecord[] = []
  const policy = {
    getDir: () => dir,
    onRecord: (r: DownloadRecord) => records.push(r),
    reserved: new Set<string>()
  }
  const fire = (item: FakeItem): { preventDefault: ReturnType<typeof vi.fn> } => {
    const e = { preventDefault: vi.fn() }
    handleWillDownload(policy, e, item as unknown as DownloadItem)
    return e
  }
  return { records, fire, policy }
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

describe('이름 경쟁·윈도우 파일명', () => {
  it('같은 이름 두 건이 같은 틱에 와도 다른 경로를 받고, done 에서 예약을 푼다', () => {
    const { fire, policy } = setup(tmp)
    const a = new FakeItem('race.bin')
    const b = new FakeItem('race.bin')
    fire(a)
    fire(b)
    const pa = a.setSavePath.mock.calls[0][0] as string
    const pb = b.setSavePath.mock.calls[0][0] as string
    expect(pa).not.toBe(pb)
    expect(path.basename(pb)).toBe('race-1.bin')
    expect(policy.reserved.size).toBe(2)
    a.emit('done', {}, 'completed')
    b.emit('done', {}, 'cancelled')
    expect(policy.reserved.size).toBe(0)
  })

  it('예약 장치명 앞에 _ 를 붙인다(확장자·대소문자 무관)', () => {
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('nul.txt')).toBe('_nul.txt')
    expect(sanitizeFileName('Com3.tar.gz')).toBe('_Com3.tar.gz')
    expect(sanitizeFileName('console.txt')).toBe('console.txt')
  })

  it('끝의 점과 공백을 지운다', () => {
    expect(sanitizeFileName('report.pdf. . ')).toBe('report.pdf')
    expect(sanitizeFileName('...')).toBe('download')
  })

  it('150자로 줄이되 확장자는 보존한다', () => {
    const out = sanitizeFileName(`${'a'.repeat(300)}.pdf`)
    expect(out).toHaveLength(150)
    expect(out.endsWith('.pdf')).toBe(true)
  })
})
