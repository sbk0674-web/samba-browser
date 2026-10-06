import { existsSync } from 'fs'
import { join, parse } from 'path'
import type { DownloadItem, Event } from 'electron'

// 에이전트가 받은 파일 한 건의 기록
export interface DownloadRecord {
  file: string
  url: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  bytes: number
  startedAt: string
}

// 다운로드 정책: 폴더가 지정돼 있을 때만 저장을 허용한다
export interface DownloadPolicy {
  getDir: () => string | null
  // 기록은 같은 객체를 이후에도 갱신한다(진행 바이트·최종 상태)
  onRecord: (record: DownloadRecord) => void
  // 저장 경로를 잡아 둔 진행 중 다운로드(같은 틱에 같은 이름이 와도 다른 경로를 받게 한다)
  reserved: Set<string>
}

const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_NAME = 150

// 윈도우에서 안전한 파일명: 구분자·제어문자 제거, 예약 장치명 회피, 끝의 점·공백 제거, 길이 제한(확장자 보존)
export function sanitizeFileName(rawName: string): string {
  // eslint-disable-next-line no-control-regex -- 파일명의 제어문자를 지운다
  let name = rawName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_')
  name = name.replace(/[. ]+$/, '')
  if (name.replace(/_/g, '').trim() === '') return 'download'
  if (RESERVED_DEVICE.test(name.split('.')[0])) name = `_${name}`
  if (name.length > MAX_NAME) {
    const { name: base, ext } = parse(name)
    const keep = ext.length < MAX_NAME ? ext : ''
    name = base.slice(0, MAX_NAME - keep.length) + keep
  }
  return name
}

// 정리한 이름이 폴더에 이미 있거나 진행 중인 다른 다운로드가 잡아 뒀으면 -1, -2 … 를 붙인다
export function uniqueSafeName(dir: string, rawName: string, reserved: Set<string>): string {
  const name = sanitizeFileName(rawName)
  const taken = (n: string): boolean => existsSync(join(dir, n)) || reserved.has(join(dir, n))
  if (!taken(name)) return name
  const { name: base, ext } = parse(name)
  for (let i = 1; ; i += 1) {
    const candidate = `${base}-${i}${ext}`
    if (!taken(candidate)) return candidate
  }
}

// session 'will-download' 처리. 폴더가 없으면 기존처럼 막고, 있으면 그 폴더에 저장한다
export function handleWillDownload(
  policy: DownloadPolicy,
  e: Pick<Event, 'preventDefault'>,
  item: DownloadItem
): void {
  const dir = policy.getDir()
  if (!dir) {
    e.preventDefault()
    console.warn(`다운로드 차단: ${item.getURL()}`)
    return
  }
  const file = join(dir, uniqueSafeName(dir, item.getFilename(), policy.reserved))
  policy.reserved.add(file)
  item.setSavePath(file)
  const record: DownloadRecord = {
    file,
    url: item.getURL(),
    state: 'progressing',
    bytes: 0,
    startedAt: new Date().toISOString()
  }
  policy.onRecord(record)
  item.on('updated', () => {
    record.bytes = item.getReceivedBytes()
  })
  item.once('done', (_event, state) => {
    policy.reserved.delete(file)
    record.bytes = item.getReceivedBytes()
    record.state =
      state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
  })
}
