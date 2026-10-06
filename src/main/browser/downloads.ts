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
}

// 경로 구분자·제어문자를 지우고, 같은 이름이 이미 있으면 -1, -2 … 를 붙인다
export function uniqueSafeName(dir: string, rawName: string): string {
  // eslint-disable-next-line no-control-regex -- 파일명의 제어문자를 지운다
  const cleaned = rawName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_')
  const name = cleaned.trim() === '' ? 'download' : cleaned
  if (!existsSync(join(dir, name))) return name
  const { name: base, ext } = parse(name)
  for (let i = 1; ; i += 1) {
    const candidate = `${base}-${i}${ext}`
    if (!existsSync(join(dir, candidate))) return candidate
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
  const file = join(dir, uniqueSafeName(dir, item.getFilename()))
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
    record.bytes = item.getReceivedBytes()
    record.state =
      state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
  })
}
