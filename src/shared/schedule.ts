// 플레이북 예약 실행(크론) 공유 타입·순수 계산. 메인·렌더러 양쪽에서 쓴다.
//
// 두 가지를 갈라 둔다
//  - 예약 **설정**(PlaybookSchedule): 사용자가 정한 값이라 플레이북에 실려 PC 간 동기화된다.
//  - 실행 **기록**(ScheduleRunRecord): "언제 돌았고 어떻게 끝났나" 는 그 PC 에서 일어난 일이라
//    기기 로컬 파일(userData/schedule-runs.json)에만 남고 동기화하지 않는다.
//
// 시각 계산은 전부 이 파일의 순수 함수에 모아 둔다 — 스케줄러는 시계와 저장만 맡는다.

import { z } from 'zod'

/** 예약 종류. 'manual' 은 예약 없음(지금 실행 버튼만) */
export const SCHEDULE_KINDS = ['manual', 'interval', 'daily', 'weekly'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

/** 간격 예약에서 고를 수 있는 분 단위 주기 */
export const SCHEDULE_INTERVALS = [15, 30, 60, 180, 360, 720] as const
export type ScheduleInterval = (typeof SCHEDULE_INTERVALS)[number]

/** 일시정지 사유. 'manual' 만 사용자가 직접 누른 것이다 */
export const SCHEDULE_PAUSE_REASONS = ['manual', 'failed', 'ai-disconnected'] as const
export type SchedulePauseReason = (typeof SCHEDULE_PAUSE_REASONS)[number]

/** 실행 결과. 'skipped' 는 시작은 했으나 사용자가 멈춘 경우다 */
export const SCHEDULE_RESULTS = ['ok', 'failed', 'skipped'] as const
export type ScheduleResult = (typeof SCHEDULE_RESULTS)[number]

/**
 * 권한 모드 덮어쓰기 후보. settings.ts 의 PERMISSION_MODES 와 **같은 값**이어야 한다.
 * settings.ts → playbook.ts → schedule.ts 로 이어지는 import 순환을 만들지 않으려고
 * 여기에 따로 적어 두고, 두 목록이 어긋나지 않는지는 테스트가 지킨다
 */
export const SCHEDULE_PERMISSION_MODES = ['read_only', 'guard', 'full'] as const
export type SchedulePermissionMode = (typeof SCHEDULE_PERMISSION_MODES)[number]

/** 카드 안에 보여 주는 최근 이력 개수 */
export const SCHEDULE_HISTORY_MAX = 10
/** 마지막 실행 요약 길이 상한(채팅 본문을 그대로 담지 않는다) */
export const SCHEDULE_SUMMARY_MAX = 200
/** 이만큼 연속으로 실패하면 스스로 일시정지한다 */
export const SCHEDULE_FAIL_LIMIT = 3
/** 기본 간격·기본 시각·기본 요일(평일) */
export const DEFAULT_INTERVAL_MINUTES: ScheduleInterval = 60
export const DEFAULT_SCHEDULE_AT = '09:00'
export const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5]

/** 플레이북 한 건의 예약 설정 */
export interface PlaybookSchedule {
  enabled: boolean
  kind: ScheduleKind
  /** kind === 'interval' 일 때의 주기(분) */
  everyMinutes?: number
  /** kind === 'daily' | 'weekly' 일 때의 시각 'HH:MM'(로컬 시간) */
  at?: string
  /** kind === 'weekly' 일 때의 요일(0=일 ~ 6=토) */
  weekdays?: number[]
  paused: boolean
  pauseReason?: SchedulePauseReason
  /** 이 예약만 쓸 모델. 비어 있으면 전역 설정을 따른다 */
  model?: string
  /** 이 예약만 쓸 권한 모드. 비어 있으면 전역 설정을 따른다 */
  permissionMode?: SchedulePermissionMode
  /**
   * 이 예약을 실제로 돌리는 PC 의 기기 식별자. 같은 계정으로 여러 PC 를 쓰면 예약 설정이 모든 PC 로 동기화되는데,
   * 실행 주체를 정하지 않으면 모든 PC 가 같은 시각에 따로 돌려 작업이 중복된다(2026-10-08).
   * 비어 있으면 아직 주인이 없는 것 — 처음 틱을 만난 PC 가 자기 것으로 찍는다
   */
  ownerDeviceId?: string
  /** 사람이 알아볼 PC 이름(화면 표시용) */
  ownerDeviceName?: string
}

/** 'HH:MM' 형식(24시간) */
export const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

export const playbookScheduleSchema = z.object({
  enabled: z.boolean(),
  kind: z.enum(SCHEDULE_KINDS),
  everyMinutes: z.number().int().min(1).max(10080).optional(),
  at: z.string().regex(HHMM_PATTERN).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  paused: z.boolean(),
  pauseReason: z.enum(SCHEDULE_PAUSE_REASONS).optional(),
  model: z.string().max(120).optional(),
  permissionMode: z.enum(SCHEDULE_PERMISSION_MODES).optional(),
  ownerDeviceId: z.string().max(80).optional(),
  ownerDeviceName: z.string().max(80).optional()
})

/** 예약을 걸지 않은 플레이북의 기본값(옛 플레이북에는 schedule 칸 자체가 없다) */
export const DEFAULT_SCHEDULE: PlaybookSchedule = {
  enabled: false,
  kind: 'manual',
  paused: false
}

/** schedule 칸이 없는(옛) 플레이북도 같은 모양으로 다룬다 */
export function scheduleOf(schedule: PlaybookSchedule | undefined): PlaybookSchedule {
  return schedule ?? DEFAULT_SCHEDULE
}

/** 가장 가까운 허용 주기로 맞춘다(모르는 값이 들어와도 계산이 깨지지 않게) */
export function snapInterval(minutes: number | undefined): ScheduleInterval {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return DEFAULT_INTERVAL_MINUTES
  let best: ScheduleInterval = SCHEDULE_INTERVALS[0]
  for (const candidate of SCHEDULE_INTERVALS) {
    if (Math.abs(candidate - minutes) < Math.abs(best - minutes)) best = candidate
  }
  return best
}

/**
 * 종류에 맞는 칸만 남기고 빠진 값은 기본값으로 채운다.
 * (매일로 바꿨다가 매주로 다시 바꿔도 엉뚱한 칸이 남아 돌지 않게 한다)
 */
export function normalizeSchedule(raw: PlaybookSchedule | undefined): PlaybookSchedule {
  const s = scheduleOf(raw)
  const base: PlaybookSchedule = {
    enabled: s.kind === 'manual' ? false : s.enabled,
    kind: s.kind,
    paused: s.paused,
    ...(s.pauseReason === undefined ? {} : { pauseReason: s.pauseReason }),
    ...(s.model === undefined || s.model.trim() === '' ? {} : { model: s.model.trim() }),
    ...(s.permissionMode === undefined ? {} : { permissionMode: s.permissionMode }),
    ...(s.ownerDeviceId === undefined || s.ownerDeviceId === ''
      ? {}
      : { ownerDeviceId: s.ownerDeviceId }),
    ...(s.ownerDeviceName === undefined || s.ownerDeviceName === ''
      ? {}
      : { ownerDeviceName: s.ownerDeviceName })
  }
  if (s.kind === 'interval') return { ...base, everyMinutes: snapInterval(s.everyMinutes) }
  const at = typeof s.at === 'string' && HHMM_PATTERN.test(s.at) ? s.at : DEFAULT_SCHEDULE_AT
  if (s.kind === 'daily') return { ...base, at }
  if (s.kind === 'weekly') {
    const picked = (s.weekdays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    const weekdays = [...new Set(picked)].sort((a, b) => a - b)
    return { ...base, at, weekdays: weekdays.length > 0 ? weekdays : [...DEFAULT_WEEKDAYS] }
  }
  return base
}

/** 'HH:MM' → 자정으로부터 지난 분. 형식이 어긋나면 null */
export function parseHhmm(at: string | undefined): number | null {
  if (typeof at !== 'string' || !HHMM_PATTERN.test(at)) return null
  const [h, m] = at.split(':')
  return Number(h) * 60 + Number(m)
}

/**
 * base 가 속한 날에서 dayOffset 일 떨어진 날의 minutes 시각(로컬).
 * 달·해 경계와 서머타임을 Date 에 맡기려고 연·월·일로 다시 만든다
 */
function atOnDay(base: number, dayOffset: number, minutes: number): number {
  const d = new Date(base)
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + dayOffset,
    0,
    minutes,
    0,
    0
  ).getTime()
}

/** now 이하(같아도 포함)의 가장 최근 예정 시각. 매일·매주만 해당하고, 없으면 null */
export function previousOccurrence(schedule: PlaybookSchedule, now: number): number | null {
  const minutes = parseHhmm(schedule.at)
  if (minutes === null) return null
  if (schedule.kind === 'daily') {
    const today = atOnDay(now, 0, minutes)
    return today <= now ? today : atOnDay(now, -1, minutes)
  }
  if (schedule.kind !== 'weekly') return null
  const weekdays = schedule.weekdays ?? []
  if (weekdays.length === 0) return null
  // 오늘부터 최대 7일 거슬러 올라가며 요일이 맞는 첫 예정 시각을 찾는다
  for (let back = 0; back <= 7; back += 1) {
    const at = atOnDay(now, -back, minutes)
    if (at > now) continue
    if (weekdays.includes(new Date(at).getDay())) return at
  }
  return null
}

/** from 보다 **뒤**의 첫 예정 시각. 매일·매주만 해당하고, 없으면 null */
export function nextOccurrence(schedule: PlaybookSchedule, from: number): number | null {
  const minutes = parseHhmm(schedule.at)
  if (minutes === null) return null
  if (schedule.kind === 'daily') {
    const today = atOnDay(from, 0, minutes)
    return today > from ? today : atOnDay(from, 1, minutes)
  }
  if (schedule.kind !== 'weekly') return null
  const weekdays = schedule.weekdays ?? []
  if (weekdays.length === 0) return null
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const at = atOnDay(from, ahead, minutes)
    if (at <= from) continue
    if (weekdays.includes(new Date(at).getDay())) return at
  }
  return null
}

/** 스케줄러가 시각 계산에 쓰는 실행 기록의 일부 */
export interface ScheduleState {
  /** 예약을 켠(또는 다시 맞춘) 시각. 이보다 앞의 예정 시각은 이미 지나간 것으로 본다 */
  armedAt: number
  lastRunAt: number | null
  /** 간격 예약의 다음 실행 시각. 매일·매주는 예정 시각에서 계산하므로 쓰지 않는다 */
  nextRunAt: number | null
}

/** 이 예약이 지금 돌 수 있는 상태인가(켜짐·수동 아님·일시정지 아님) */
export function isArmed(schedule: PlaybookSchedule): boolean {
  return schedule.enabled && schedule.kind !== 'manual' && !schedule.paused
}

/** 매일·매주에서 "이 시각 뒤의 예정만 센다" 는 기준 시각 */
function since(state: ScheduleState): number {
  return Math.max(state.armedAt, state.lastRunAt ?? 0)
}

/** 간격 예약의 다음 실행 시각(= 기준 시각 + 주기) */
export function intervalNextFrom(schedule: PlaybookSchedule, from: number): number {
  return from + snapInterval(schedule.everyMinutes) * 60_000
}

/**
 * 지금 실행해야 하는가. 실행해야 하면 "그 예정 시각"을, 아니면 null 을 돌려준다.
 *
 * 앱이 꺼져 있던 동안 놓친 실행은 매일·매주만 **한 번** 따라잡는다 —
 * 지난 예정 시각이 마지막 실행보다 뒤면 그 한 건이 밀려 있는 것으로 보고,
 * 돌고 나면 lastRunAt 이 지금으로 바뀌어 남은 과거 건은 사라진다.
 * 간격 예약은 따라잡지 않는다(start 에서 기준을 다시 잡는다)
 */
export function dueAt(
  schedule: PlaybookSchedule,
  state: ScheduleState,
  now: number
): number | null {
  if (!isArmed(schedule)) return null
  if (schedule.kind === 'interval') {
    return state.nextRunAt !== null && now >= state.nextRunAt ? state.nextRunAt : null
  }
  const previous = previousOccurrence(schedule, now)
  if (previous === null) return null
  return previous > since(state) ? previous : null
}

/** 화면에 보여 줄 다음 실행 시각(지금 밀려 있으면 그 시각). 꺼져 있으면 null */
export function upcomingRunAt(
  schedule: PlaybookSchedule,
  state: ScheduleState,
  now: number
): number | null {
  if (!isArmed(schedule)) return null
  const due = dueAt(schedule, state, now)
  if (due !== null) return due
  if (schedule.kind === 'interval') return state.nextRunAt
  return nextOccurrence(schedule, now)
}

/** 실행 기록 한 줄(최근 10회 점 표시용) */
export interface ScheduleHistoryEntry {
  at: number
  result: ScheduleResult
}

/** 기기 로컬 실행 기록. 동기화하지 않는다 */
export interface ScheduleRunRecord extends ScheduleState {
  /**
   * 이 기록이 어느 예약 설정을 기준으로 맞춰졌는지 나타내는 표식(armKeyOf).
   * 사용자가 시각·주기를 바꾸면 값이 달라져 armedAt 을 다시 잡는다 —
   * 그래야 "09시 → 14시" 로 바꾼 직후 어제 14시 건이 밀린 것으로 보이지 않는다
   */
  armKey?: string
  lastResult: ScheduleResult | null
  lastSummary: string
  /** 연속 실패 횟수. 성공하면 0 으로 돌아간다 */
  failStreak: number
  history: ScheduleHistoryEntry[]
}

/** 예약 설정이 바뀌었는지 가리는 표식. 실행 시각에 영향을 주는 칸만 넣는다 */
export function armKeyOf(schedule: PlaybookSchedule): string {
  return JSON.stringify([
    schedule.kind,
    schedule.everyMinutes ?? null,
    schedule.at ?? null,
    schedule.weekdays ?? null
  ])
}

/** 아직 한 번도 돌지 않은 플레이북의 기록 */
export function emptyRecord(now: number): ScheduleRunRecord {
  return {
    armedAt: now,
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    lastSummary: '',
    failStreak: 0,
    history: []
  }
}

export const scheduleHistoryEntrySchema = z.object({
  at: z.number(),
  result: z.enum(SCHEDULE_RESULTS)
})

export const scheduleRunRecordSchema = z.object({
  armedAt: z.number(),
  armKey: z.string().max(200).optional(),
  lastRunAt: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  lastResult: z.enum(SCHEDULE_RESULTS).nullable(),
  lastSummary: z.string().max(SCHEDULE_SUMMARY_MAX),
  failStreak: z.number().int().min(0),
  history: z.array(scheduleHistoryEntrySchema).max(SCHEDULE_HISTORY_MAX)
})

/** 실행 기록 파일 전체 */
export const scheduleRunsFileSchema = z.object({
  version: z.literal(1),
  records: z.record(z.string(), scheduleRunRecordSchema)
})

/** 채팅 본문에서 카드에 한 줄로 보여 줄 요약을 뽑는다(빈 줄·머리표 제거) */
export function summarize(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    // 제목 줄은 건너뛴다(플레이북 절차 미리보기와 같은 규칙이다)
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => l.replace(/^[>\-*\s]+/, '').trim())
    .find((l) => l !== '')
  if (line === undefined) return ''
  return line.length > SCHEDULE_SUMMARY_MAX ? `${line.slice(0, SCHEDULE_SUMMARY_MAX)}…` : line
}

/** 이력에 한 줄 덧붙인다(최근 10회만 남긴다 — 앞이 오래된 것) */
export function pushHistory(
  history: readonly ScheduleHistoryEntry[],
  entry: ScheduleHistoryEntry
): ScheduleHistoryEntry[] {
  return [...history, entry].slice(-SCHEDULE_HISTORY_MAX)
}

/** 예약 실행 시 전역 설정 대신 쓸 값. 비어 있는 칸은 전역 설정을 따른다 */
export interface ScheduleRunOverrides {
  model?: string
  permissionMode?: SchedulePermissionMode
}

/** 예약 설정에서 덮어쓸 값만 뽑는다(둘 다 비었으면 undefined) */
export function overridesOf(schedule: PlaybookSchedule): ScheduleRunOverrides | undefined {
  const model = schedule.model?.trim()
  const out: ScheduleRunOverrides = {
    ...(model === undefined || model === '' ? {} : { model }),
    ...(schedule.permissionMode === undefined ? {} : { permissionMode: schedule.permissionMode })
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** 카드 개요에 쓰는 상태 */
export type ScheduleUiState = 'off' | 'paused' | 'waiting' | 'running'

/** 렌더러로 보내는 예약 상태 한 줄(설정 + 기기 로컬 기록을 합친 값) */
export interface ScheduleStatusDto {
  playbookId: string
  schedule: PlaybookSchedule
  state: ScheduleUiState
  pauseReason?: SchedulePauseReason
  nextRunAt: number | null
  lastRunAt: number | null
  lastResult: ScheduleResult | null
  lastSummary: string
  history: ScheduleHistoryEntry[]
}
