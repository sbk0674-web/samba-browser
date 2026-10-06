import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { migrateSettingsFile, parseSettings, type Settings } from '../../shared/settings'
import { SYNCED_SETTING_KEYS, type OutboxRecorder } from '../../shared/sync'
import { setMainLanguage } from '../i18n'

// %APPDATA%/samba-browser/config.json
export class SettingsStore {
  private file = join(app.getPath('userData'), 'config.json')
  private cache: Settings
  // 동기화 변경 로그 훅. 주입하지 않으면 아무 일도 하지 않는다(동기화를 끈 상태)
  private outbox: OutboxRecorder | null = null
  // 동기화로 내려받아 실제로 값이 바뀐 키를 듣는 쪽(폰 목록 반영 등)
  private syncedListeners: Array<(keys: string[]) => void> = []

  constructor() {
    this.cache = this.load()
    // 메인이 만드는 문구(오류·알림)도 앱 언어를 따른다
    setMainLanguage(this.cache.language)
  }

  /** 변경 로그 훅을 붙인다(로그인 상태에서만) */
  setOutboxRecorder(recorder: OutboxRecorder | null): void {
    this.outbox = recorder
  }

  private load(): Settings {
    let raw: unknown = {}
    let exists = false
    try {
      exists = existsSync(this.file)
      if (exists) raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (e) {
      console.error('설정 읽기 실패, 기본값 사용', e)
      exists = false
    }
    // 저장된 파일에만 1회 마이그레이션을 걸고 곧바로 파일에 남긴다(다음 실행에서 다시 걸리지 않게).
    // 새 설치(파일 없음)는 기본값이 이미 새 값이라 걸 필요가 없다
    const migrated = exists ? migrateSettingsFile(raw) : null
    if (migrated) {
      raw = migrated
      try {
        writeFileSync(this.file, JSON.stringify(parseSettings(migrated), null, 2))
        console.log('설정 마이그레이션: 로그인 자동 저장(vaultAutoSaveLogins)을 켬으로 옮겼다')
      } catch (e) {
        console.error('설정 마이그레이션 저장 실패', e)
      }
    }
    // 손상·조작된 값은 parseSettings 가 필드별로 기본값으로 되돌린다
    return parseSettings(raw)
  }

  get(): Settings {
    return this.cache
  }

  set(patch: Partial<Settings>): Settings {
    return this.apply(patch, true)
  }

  /**
   * 동기화로 내려받은 값을 적용한다. 변경 로그를 남기지 않으므로
   * 받은 값을 곧바로 되돌려 보내는 왕복(에코)이 생기지 않는다
   */
  setFromSync(patch: Partial<Settings>): Settings {
    const before = this.cache
    const after = this.apply(patch, false)
    const changed = (Object.keys(patch) as Array<keyof Settings>).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])
    )
    if (changed.length > 0) {
      for (const cb of this.syncedListeners) {
        try {
          cb(changed)
        } catch (e) {
          console.error('동기화 설정 반영 실패', e)
        }
      }
    }
    return after
  }

  /** 동기화로 내려받은 설정이 실제로 바뀌었을 때 불린다(바뀐 키 목록) */
  onSynced(cb: (keys: string[]) => void): void {
    this.syncedListeners.push(cb)
  }

  private apply(patch: Partial<Settings>, record: boolean): Settings {
    const before = this.cache
    this.cache = parseSettings({ ...this.cache, ...patch })
    setMainLanguage(this.cache.language)
    // 동기화 대상 키가 실제로 바뀐 것만 변경 로그에 남긴다(기기 전용 값은 목록에 없다)
    if (record) {
      for (const key of SYNCED_SETTING_KEYS) {
        if (JSON.stringify(before[key]) === JSON.stringify(this.cache[key])) continue
        this.outbox?.('settings', key, 'upsert')
      }
    }
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.cache, null, 2))
    } catch (e) {
      console.error('설정 저장 실패', e)
    }
    return this.cache
  }
}
