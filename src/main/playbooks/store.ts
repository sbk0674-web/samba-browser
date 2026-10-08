// 자동화 플레이북 저장소.
//
// 저장 위치는 설정(config.json)의 `playbooks` 한 칸이다. 표를 따로 만들지 않은 이유:
// 플레이북은 PC 간 같아야 하는 값인데, 새 표를 동기화 대상으로 올리려면 Supabase 표·RLS·
// mappers/push/pull/backfill 을 모두 손봐야 하고 실제 서버 없이는 검증할 수 없다.
// 설정 키는 이미 검증된 동기화 경로라 SYNCED_SETTING_KEYS 에 이름만 넣으면 그대로 오간다.
// 목록이 작고(상한 50) 통째로 바뀌는 성격이라 한 칸 병합으로도 충분하다

import { randomUUID } from 'node:crypto'
import {
  BUILTIN_PLAYBOOKS,
  PLAYBOOK_INSTRUCTIONS_MAX,
  PLAYBOOK_MAX_COUNT,
  PLAYBOOK_NAME_MAX,
  PLAYBOOK_TRIGGER_MAX,
  builtinPlaybook,
  type PlaybookDto,
  type PlaybookInput
} from '../../shared/playbook'
import { isArmed, normalizeSchedule, type PlaybookSchedule } from '../../shared/schedule'

/** 설정 저장소 중 이 저장소가 쓰는 부분만 (테스트에서 갈아 끼우기 쉽게 좁혀 둔다) */
export interface PlaybookSettingsAccess {
  get(): { playbooks: PlaybookDto[] }
  set(patch: { playbooks: PlaybookDto[] }): { playbooks: PlaybookDto[] }
}

/** 사용자가 넣은 이름·트리거·절차를 저장 가능한 모양으로 다듬는다 */
function sanitizeInput(input: PlaybookInput): {
  name: string
  triggers: string[]
  instructions: string
} {
  const name = input.name.trim().slice(0, PLAYBOOK_NAME_MAX)
  const seen = new Set<string>()
  const triggers: string[] = []
  for (const raw of input.triggers) {
    const trigger = raw.trim().slice(0, PLAYBOOK_TRIGGER_MAX)
    if (trigger === '') continue
    const key = trigger.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    triggers.push(trigger)
  }
  return { name, triggers, instructions: input.instructions.slice(0, PLAYBOOK_INSTRUCTIONS_MAX) }
}

/**
 * 저장된 목록에 내장 플레이북을 채워 넣는다.
 * 내장은 삭제되지 않으므로(삭제 대신 '기본값 복원'), 없으면 기본값 그대로 뒤에 붙인다
 */
export function withBuiltins(rows: readonly PlaybookDto[], now: number): PlaybookDto[] {
  const merged = rows.map((row) => ({ ...row, triggers: [...row.triggers] }))
  for (const builtin of BUILTIN_PLAYBOOKS) {
    if (merged.some((row) => row.id === builtin.id)) continue
    const fresh = builtinPlaybook(builtin.id, now)
    if (fresh) merged.push(fresh)
  }
  return merged
}

/** 이 PC — 예약을 저장한 PC 가 그 예약의 실행 주체가 된다(같은 계정의 다른 PC 와 중복 실행을 막는다) */
export interface StoreDevice {
  id: string
  name: string
}

export class PlaybookStore {
  constructor(
    private readonly settings: PlaybookSettingsAccess,
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = randomUUID,
    private readonly device?: StoreDevice
  ) {}

  /** 사용자가 저장한 예약이 켜져 있으면 이 PC 를 실행 주체로 찍는다. 꺼진 예약은 그대로 둔다 */
  private ownedSchedule(raw: PlaybookSchedule): PlaybookSchedule {
    const schedule = normalizeSchedule(raw)
    if (this.device === undefined || !isArmed(schedule)) return schedule
    return { ...schedule, ownerDeviceId: this.device.id, ownerDeviceName: this.device.name }
  }

  /** 저장된 플레이북 전체(내장 포함). 내장이 빠져 있으면 채워서 저장까지 한다 */
  list(): PlaybookDto[] {
    const stored = this.settings.get().playbooks
    const merged = withBuiltins(stored, this.now())
    if (merged.length !== stored.length) return this.save(merged)
    return merged
  }

  /** 새로 만들거나(id 없음) 기존 것을 고친다. 없는 id 를 주면 null */
  put(input: PlaybookInput): PlaybookDto | null {
    const { name, triggers, instructions } = sanitizeInput(input)
    if (name === '') return null
    const rows = this.list()
    const now = this.now()
    if (input.id === undefined) {
      if (rows.length >= PLAYBOOK_MAX_COUNT) return null
      const created: PlaybookDto = {
        id: this.newId(),
        name,
        triggers,
        instructions,
        enabled: input.enabled,
        ...(input.schedule === undefined ? {} : { schedule: this.ownedSchedule(input.schedule) }),
        updatedAt: now
      }
      this.save([...rows, created])
      return created
    }
    const index = rows.findIndex((row) => row.id === input.id)
    if (index < 0) return null
    // builtin 표식은 사용자 입력으로 바뀌지 않는다(복원 대상 여부가 뒤집히면 안 된다).
    // 예약은 주지 않으면 그대로 둔다 — 편집 폼이 예약 칸을 모르고 저장해도 예약이 날아가지 않는다
    const updated: PlaybookDto = {
      ...rows[index],
      name,
      triggers,
      instructions,
      enabled: input.enabled,
      ...(input.schedule === undefined ? {} : { schedule: this.ownedSchedule(input.schedule) }),
      updatedAt: now
    }
    const next = [...rows]
    next[index] = updated
    this.save(next)
    return updated
  }

  /** 지운다. 내장 플레이북은 지워지지 않는다(복원만 된다) — 그때는 false */
  remove(id: string): boolean {
    const rows = this.list()
    const found = rows.find((row) => row.id === id)
    if (!found || found.builtin === true) return false
    this.save(rows.filter((row) => row.id !== id))
    return true
  }

  /** 내장 플레이북을 기본값으로 되돌린다. 내장이 아니면 null */
  restore(id: string): PlaybookDto | null {
    const fresh = builtinPlaybook(id, this.now())
    if (!fresh) return null
    const rows = this.list()
    const index = rows.findIndex((row) => row.id === id)
    const next = [...rows]
    if (index < 0) next.push(fresh)
    else next[index] = fresh
    this.save(next)
    return fresh
  }

  /**
   * 예약 설정 한 건만 바꾼다(스케줄러의 자동 일시정지·화면의 일시정지/재개가 쓴다).
   * 이름·절차는 건드리지 않으므로 편집 중이던 값과 부딪히지 않는다
   */
  setSchedule(id: string, schedule: PlaybookSchedule): PlaybookDto | null {
    const rows = this.list()
    const index = rows.findIndex((row) => row.id === id)
    if (index < 0) return null
    const updated: PlaybookDto = {
      ...rows[index],
      schedule: normalizeSchedule(schedule),
      updatedAt: this.now()
    }
    const next = [...rows]
    next[index] = updated
    this.save(next)
    return updated
  }

  /**
   * 절차 본문 한 건만 바꾼다(AI 의 update_playbook 도구가 쓴다).
   * 이름·트리거·예약은 건드리지 않는다 — AI 가 트리거를 바꿔 다른 요청까지 끌어오면 안 된다.
   * 상한을 넘는 본문은 잘라 저장하지 않고 거절한다(중간에서 끊긴 절차가 남으면 더 위험하다)
   */
  setInstructions(id: string, instructions: string): PlaybookDto | null {
    if (instructions.length > PLAYBOOK_INSTRUCTIONS_MAX) return null
    const rows = this.list()
    const index = rows.findIndex((row) => row.id === id)
    if (index < 0) return null
    const updated: PlaybookDto = { ...rows[index], instructions, updatedAt: this.now() }
    const next = [...rows]
    next[index] = updated
    this.save(next)
    return updated
  }

  private save(rows: PlaybookDto[]): PlaybookDto[] {
    return this.settings.set({ playbooks: rows }).playbooks
  }
}
