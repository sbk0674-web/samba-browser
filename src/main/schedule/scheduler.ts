// 플레이북 예약 실행기 — 1분마다 "돌 때가 된" 플레이북을 찾아 채팅으로 실행한다.
//
// 실행 경로를 새로 만들지 않는 것이 핵심이다. 스케줄러는 렌더러에 "이 문구를 채팅에
// 넣어라" 고만 알리고, 실제 실행은 사용자가 직접 칠 때와 똑같은 경로(chat → agent:run)를
// 탄다. 그래서 진행 상황이 AI 패널에 그대로 보이고, 기록도 평소처럼 대화에 남는다.
//
// 결과는 러너가 이미 내보내는 status 이벤트만 보고 판정한다 — 알림·토스트 같은 별도
// 통지 코드는 여기에 두지 않는다(알림 연동은 러너 이벤트를 따로 듣는다).
//
// 규칙
//  - 동시 실행 금지: 러너가 돌고 있으면 실행하지 않고 다음 틱으로 미룬다(실패가 아니라 대기).
//  - 연속 3회 실패하면 스스로 일시정지한다(pauseReason 'failed').
//  - AI 가 연결돼 있지 않으면 실행하지 않고 일시정지한다(pauseReason 'ai-disconnected').

import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '../../shared/ipc'
import type { PlaybookDto } from '../../shared/playbook'
import { runPhraseOf } from '../../shared/playbook'
import {
  SCHEDULE_FAIL_LIMIT,
  armKeyOf,
  dueAt,
  intervalNextFrom,
  isArmed,
  normalizeSchedule,
  overridesOf,
  pushHistory,
  scheduleOf,
  summarize,
  upcomingRunAt,
  type PlaybookSchedule,
  type ScheduleResult,
  type SchedulePauseReason,
  type ScheduleRunOverrides,
  type ScheduleStatusDto,
  type ScheduleUiState
} from '../../shared/schedule'
import type { ScheduleRunStore } from './runs'

/** 틱 주기 1분 — 분 단위보다 촘촘한 예약이 없으므로 이보다 잦을 이유가 없다 */
export const SCHEDULE_TICK_MS = 60_000
/**
 * 보낸 실행 요청이 이 시간 안에 채팅으로 접수되지 않으면 없던 일로 본다.
 * (렌더러가 막 다른 작업을 시작해 요청을 흘렸을 때 기록이 영영 열려 있지 않게 한다)
 */
export const DISPATCH_TIMEOUT_MS = 60_000

/** 스케줄러가 건드리는 플레이북 저장소의 일부 */
export interface SchedulePlaybookAccess {
  list(): PlaybookDto[]
  setSchedule(id: string, schedule: PlaybookSchedule): PlaybookDto | null
}

/** 이 PC 의 식별자(로컬에만 남는다) — 예약의 실행 주체를 가를 때 쓴다 */
export interface ScheduleDevice {
  id: string
  name: string
}

export interface SchedulerDeps {
  playbooks: SchedulePlaybookAccess
  runs: ScheduleRunStore
  /** 러너가 지금 작업 중인가 */
  isRunning: () => boolean
  /** AI 실행 경로가 연결돼 있는가 */
  aiConnected: () => boolean
  /** 이 PC. 없으면(테스트) 실행 주체를 가르지 않고 예전처럼 모든 예약을 돌린다 */
  device?: ScheduleDevice
  /** 렌더러에 "이 문구를 채팅에 넣어라" 고 알린다 */
  dispatch: (req: { token: string; playbookId: string; phrase: string }) => void
  /** 예약 상태가 바뀌었다(화면을 다시 읽게 한다) */
  onChanged?: () => void
  now?: () => number
}

/** 보냈지만 아직 채팅이 집어 가지 않은 실행 요청 */
interface PendingDispatch {
  token: string
  playbookId: string
  sentAt: number
  overrides?: ScheduleRunOverrides
}

/** 채팅이 집어 가 실제로 돌고 있는 예약 실행 */
interface ActiveRun {
  playbookId: string
  startedAt: number
  /** 이번 실행에서 마지막으로 받은 AI 본문(끝나면 한 줄 요약으로 줄인다) */
  lastText: string
}

export class PlaybookScheduler {
  private timer: NodeJS.Timeout | null = null
  private pending: PendingDispatch | null = null
  private active: ActiveRun | null = null
  private readonly now: () => number

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /** 앱 시작 시 한 번. 기준을 다시 잡고 1분 틱을 건다 */
  start(): void {
    if (this.timer) return
    this.reanchor()
    this.timer = setInterval(() => this.tick(), SCHEDULE_TICK_MS)
    // 예약 때문에 앱이 안 꺼지는 일이 없게 한다
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 앱이 꺼져 있던 동안의 간격(interval) 예약은 따라잡지 않는다 —
   * 지난 다음 실행 시각은 버리고 지금부터 한 주기 뒤로 다시 잡는다.
   * 매일·매주는 여기서 손대지 않는다(놓친 1회를 따라잡아야 하기 때문이다)
   */
  private reanchor(): void {
    const now = this.now()
    for (const playbook of this.safeList()) {
      const schedule = scheduleOf(playbook.schedule)
      if (!isArmed(schedule) || schedule.kind !== 'interval') continue
      const record = this.deps.runs.get(playbook.id)
      if (record.nextRunAt !== null && record.nextRunAt > now) continue
      this.deps.runs.patch(playbook.id, { nextRunAt: intervalNextFrom(schedule, now) })
    }
  }

  /** 플레이북 조회가 실패해도 틱 자체는 죽지 않게 한다 */
  private safeList(): PlaybookDto[] {
    try {
      return this.deps.playbooks.list()
    } catch (e: unknown) {
      console.error('예약: 플레이북 조회 실패', e instanceof Error ? e.message : String(e))
      return []
    }
  }

  /**
   * 예약 설정이 바뀌었으면(종류·주기·시각·요일) 기준 시각을 다시 잡는다.
   * 그래야 "매일 09시 → 매일 14시" 로 바꾼 직후 어제 14시 건이 밀린 것으로 보이지 않는다
   */
  private syncArming(now: number, playbook: PlaybookDto): void {
    const schedule = scheduleOf(playbook.schedule)
    const record = this.deps.runs.get(playbook.id)
    if (!isArmed(schedule)) {
      if (record.armKey !== undefined) {
        this.deps.runs.set(playbook.id, { ...record, armKey: undefined, nextRunAt: null })
      }
      return
    }
    const key = armKeyOf(schedule)
    if (record.armKey === key) return
    this.deps.runs.patch(playbook.id, {
      armKey: key,
      armedAt: now,
      nextRunAt: schedule.kind === 'interval' ? intervalNextFrom(schedule, now) : null
    })
  }

  /** 1분 틱. 테스트에서는 이 함수를 직접 부른다 */
  tick(): void {
    const now = this.now()
    // 접수되지 않은 채 오래 묵은 실행 요청은 없던 일로 본다(기록을 남기지 않는다)
    if (this.pending !== null && now - this.pending.sentAt > DISPATCH_TIMEOUT_MS) {
      this.pending = null
    }
    const playbooks = this.safeList()
    this.deps.runs.keepOnly(playbooks.map((p) => p.id))
    for (const playbook of playbooks) this.syncArming(now, playbook)
    // 같은 계정의 다른 PC 가 맡은 예약은 돌리지 않는다. 주인이 없는 예약은 이 PC 가 자기 것으로 찍는다
    // (찍힌 값이 동기화되면 다른 PC 는 손을 뗀다 — 그 사이 한 번 겹칠 수 있다)
    const mine = playbooks.filter((p) => this.claimOrOwned(p))
    // 이미 예약 실행이 돌고 있거나 보내 둔 요청이 있으면 이번 틱은 아무것도 보내지 않는다
    if (this.pending !== null || this.active !== null) return
    for (const playbook of mine) {
      const schedule = scheduleOf(playbook.schedule)
      if (dueAt(schedule, this.deps.runs.get(playbook.id), now) === null) continue
      // 다른 작업이 돌고 있으면 미룬다 — 실패도 건너뜀도 아니고 그냥 다음 틱을 기다린다
      if (this.deps.isRunning()) return
      if (!this.deps.aiConnected()) {
        this.pause(playbook.id, 'ai-disconnected')
        continue
      }
      this.send(playbook, now)
      return
    }
  }

  /**
   * 이 예약을 이 PC 가 돌려도 되는가. 주인이 이 PC 면 true, 다른 PC 면 false.
   * 주인이 없으면(옛 예약·새 예약) 이 PC 를 주인으로 찍고 true — 예약이 아닌 플레이북은 건드리지 않는다
   */
  private claimOrOwned(playbook: PlaybookDto): boolean {
    const device = this.deps.device
    if (device === undefined) return true
    const schedule = scheduleOf(playbook.schedule)
    if (!isArmed(schedule)) return true
    if (schedule.ownerDeviceId === undefined || schedule.ownerDeviceId === '') {
      this.deps.playbooks.setSchedule(playbook.id, {
        ...schedule,
        ownerDeviceId: device.id,
        ownerDeviceName: device.name
      })
      return true
    }
    return schedule.ownerDeviceId === device.id
  }

  /** 사용자가 카드에서 [지금 실행] 을 눌렀다. 다른 작업이 돌고 있으면 false */
  runNow(playbookId: string): boolean {
    if (this.pending !== null || this.active !== null || this.deps.isRunning()) return false
    const playbook = this.safeList().find((p) => p.id === playbookId)
    if (!playbook) return false
    this.send(playbook, this.now())
    return true
  }

  private send(playbook: PlaybookDto, now: number): void {
    const schedule = scheduleOf(playbook.schedule)
    const token = randomUUID()
    const overrides = overridesOf(schedule)
    this.pending = {
      token,
      playbookId: playbook.id,
      sentAt: now,
      ...(overrides === undefined ? {} : { overrides })
    }
    this.deps.dispatch({ token, playbookId: playbook.id, phrase: runPhraseOf(playbook) })
    this.deps.onChanged?.()
  }

  /**
   * 채팅이 실행을 접수했다. agent:run 핸들러가 이 토큰으로 불러
   * 이번 실행에 쓸 덮어쓰기(모델·권한 모드)를 받아 간다.
   * 모르는 토큰(사용자가 직접 친 문장)이면 undefined 라 평소대로 전역 설정을 쓴다
   */
  claimOverrides(token: string | undefined): ScheduleRunOverrides | undefined {
    if (token === undefined || this.pending === null || this.pending.token !== token) {
      return undefined
    }
    const { playbookId, overrides } = this.pending
    this.pending = null
    this.active = { playbookId, startedAt: this.now(), lastText: '' }
    this.deps.onChanged?.()
    return overrides
  }

  /**
   * 러너가 내보내는 이벤트를 그대로 흘려 받는다(별도 통지 경로를 만들지 않는다).
   * 예약 실행이 돌고 있지 않으면 전부 무시한다
   */
  noteAgentEvent(event: AgentEvent): void {
    const active = this.active
    if (active === null) return
    if (event.type === 'text') {
      active.lastText = event.text
      return
    }
    if (event.type !== 'status' || event.state === 'running') return
    const authError = event.message?.startsWith('auth:') === true
    const result: ScheduleResult =
      event.state === 'done' ? 'ok' : event.state === 'stopped' ? 'skipped' : 'failed'
    this.finish(active, result, authError)
  }

  private finish(active: ActiveRun, result: ScheduleResult, authError: boolean): void {
    this.active = null
    const now = this.now()
    const playbook = this.safeList().find((p) => p.id === active.playbookId)
    const schedule = scheduleOf(playbook?.schedule)
    const record = this.deps.runs.get(active.playbookId)
    // 실패만 연달아 센다. 사용자가 멈춘 것(skipped)은 실패로 보지 않는다
    const failStreak = result === 'failed' ? record.failStreak + 1 : 0
    this.deps.runs.set(active.playbookId, {
      ...record,
      lastRunAt: now,
      lastResult: result,
      lastSummary: summarize(active.lastText),
      failStreak,
      history: pushHistory(record.history, { at: now, result }),
      nextRunAt: schedule.kind === 'interval' ? intervalNextFrom(schedule, now) : null
    })
    // AI 미연결은 플레이북 잘못이 아니다 — 연속 실패로 세지 않고 사유를 따로 남긴다
    if (authError) this.pause(active.playbookId, 'ai-disconnected')
    else if (failStreak >= SCHEDULE_FAIL_LIMIT) this.pause(active.playbookId, 'failed')
    this.deps.onChanged?.()
  }

  /** 예약을 일시정지한다(사유와 함께). 이미 멈춰 있으면 사유만 바뀐다 */
  private pause(playbookId: string, reason: SchedulePauseReason): void {
    const playbook = this.safeList().find((p) => p.id === playbookId)
    if (!playbook) return
    const schedule = scheduleOf(playbook.schedule)
    if (schedule.kind === 'manual') return
    this.deps.playbooks.setSchedule(playbookId, {
      ...normalizeSchedule(schedule),
      paused: true,
      pauseReason: reason
    })
    this.deps.onChanged?.()
  }

  /** 화면의 [일시정지]/[재개]. 재개하면 사유를 지우고 기준 시각을 다시 잡는다 */
  setPaused(playbookId: string, paused: boolean): boolean {
    const playbook = this.safeList().find((p) => p.id === playbookId)
    if (!playbook) return false
    const schedule = normalizeSchedule(scheduleOf(playbook.schedule))
    if (schedule.kind === 'manual') return false
    const next = paused
      ? { ...schedule, paused: true, pauseReason: 'manual' as const }
      : { ...schedule, paused: false, pauseReason: undefined }
    this.deps.playbooks.setSchedule(playbookId, next)
    if (!paused) {
      // 재개는 "지금부터 다시 센다" 는 뜻이다 — 멈춰 있던 동안의 예정은 따라잡지 않는다
      const now = this.now()
      this.deps.runs.patch(playbookId, {
        armKey: armKeyOf(next),
        armedAt: now,
        failStreak: 0,
        nextRunAt: next.kind === 'interval' ? intervalNextFrom(next, now) : null
      })
    }
    this.deps.onChanged?.()
    return true
  }

  /** 카드가 그리는 예약 상태 목록 */
  statusList(): ScheduleStatusDto[] {
    const now = this.now()
    return this.safeList().map((playbook) => {
      const schedule = scheduleOf(playbook.schedule)
      const record = this.deps.runs.get(playbook.id)
      const running =
        this.active?.playbookId === playbook.id || this.pending?.playbookId === playbook.id
      const state: ScheduleUiState = running
        ? 'running'
        : schedule.paused
          ? 'paused'
          : isArmed(schedule)
            ? 'waiting'
            : 'off'
      return {
        playbookId: playbook.id,
        schedule,
        state,
        ...(schedule.pauseReason === undefined ? {} : { pauseReason: schedule.pauseReason }),
        nextRunAt: upcomingRunAt(schedule, record, now),
        lastRunAt: record.lastRunAt,
        lastResult: record.lastResult,
        lastSummary: record.lastSummary,
        history: record.history
      }
    })
  }
}
