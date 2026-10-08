import { describe, it, expect, beforeEach } from 'vitest'
import type { PlaybookDto } from '../src/shared/playbook'
import type { PlaybookSchedule } from '../src/shared/schedule'
import { SCHEDULE_FAIL_LIMIT, normalizeSchedule } from '../src/shared/schedule'
import { ScheduleRunStore } from '../src/main/schedule/runs'
import { PlaybookScheduler, type SchedulerDeps } from '../src/main/schedule/scheduler'

/** 로컬 시각 → 밀리초 */
function at(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

function playbook(id: string, schedule?: PlaybookSchedule): PlaybookDto {
  return {
    id,
    name: id,
    triggers: [`${id} 실행`],
    instructions: '절차',
    enabled: true,
    ...(schedule === undefined ? {} : { schedule: normalizeSchedule(schedule) }),
    updatedAt: 0
  }
}

const daily = (time: string): PlaybookSchedule =>
  normalizeSchedule({ enabled: true, kind: 'daily', at: time, paused: false })

const every = (minutes: number): PlaybookSchedule =>
  normalizeSchedule({ enabled: true, kind: 'interval', everyMinutes: minutes, paused: false })

/** 스케줄러 한 대와 그 둘레의 대역(러너·AI 연결·채팅 보내기)을 한 벌로 만든다 */
interface Harness {
  scheduler: PlaybookScheduler
  sent: { token: string; playbookId: string; phrase: string }[]
  flags: { running: boolean; connected: boolean; now: number }
  runs: ScheduleRunStore
  rows: PlaybookDto[]
}

function harness(rows: PlaybookDto[], now: number, device?: { id: string; name: string }): Harness {
  const sent: { token: string; playbookId: string; phrase: string }[] = []
  const flags = { running: false, connected: true, now }
  const runs = new ScheduleRunStore(null, () => flags.now)
  const deps: SchedulerDeps = {
    playbooks: {
      list: () => rows,
      setSchedule: (id, schedule) => {
        const index = rows.findIndex((r) => r.id === id)
        if (index < 0) return null
        rows[index] = { ...rows[index], schedule: normalizeSchedule(schedule) }
        return rows[index]
      }
    },
    runs,
    ...(device === undefined ? {} : { device }),
    isRunning: () => flags.running,
    aiConnected: () => flags.connected,
    dispatch: (req) => sent.push(req),
    now: () => flags.now
  }
  return { scheduler: new PlaybookScheduler(deps), sent, flags, runs, rows }
}

/** 한 건을 끝까지(보내기 → 채팅 접수 → 종료) 굴린다 */
function runOnce(h: Harness, state: 'done' | 'failed' | 'stopped', message?: string): void {
  h.scheduler.tick()
  const last = h.sent[h.sent.length - 1]
  h.scheduler.claimOverrides(last.token)
  h.scheduler.noteAgentEvent({ type: 'text', text: '미이행 3건 처리 완료' })
  h.scheduler.noteAgentEvent(
    message === undefined ? { type: 'status', state } : { type: 'status', state, message }
  )
}

const NOW = at(2026, 3, 10, 10, 0)

describe('때가 되면 채팅으로 보낸다', () => {
  let h: Harness

  beforeEach(() => {
    // 어제 돌았고 오늘 09시 건이 밀려 있는 상태
    h = harness([playbook('p1', daily('09:00'))], NOW)
    h.runs.set('p1', {
      armedAt: at(2026, 3, 1),
      armKey: undefined,
      lastRunAt: at(2026, 3, 9, 9, 0),
      nextRunAt: null,
      lastResult: 'ok',
      lastSummary: '',
      failStreak: 0,
      history: []
    })
    // armKey 를 맞춰 둬야 첫 틱에서 기준이 다시 잡히지 않는다
    h.scheduler.tick()
    h.runs.patch('p1', { armedAt: at(2026, 3, 1) })
  })

  it('첫 트리거 문구를 보낸다', () => {
    h.sent.length = 0
    h.scheduler.tick()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].phrase).toBe('p1 실행')
    expect(h.sent[0].playbookId).toBe('p1')
  })

  it('보낸 뒤 채팅이 집어 가기 전에는 다시 보내지 않는다', () => {
    h.sent.length = 0
    h.scheduler.tick()
    h.scheduler.tick()
    expect(h.sent).toHaveLength(1)
  })

  it('성공하면 기록과 이력이 남는다', () => {
    runOnce(h, 'done')
    const record = h.runs.get('p1')
    expect(record.lastResult).toBe('ok')
    expect(record.lastRunAt).toBe(NOW)
    expect(record.lastSummary).toBe('미이행 3건 처리 완료')
    expect(record.history).toEqual([{ at: NOW, result: 'ok' }])
    expect(record.failStreak).toBe(0)
  })

  it('돌고 나면 밀린 것이 사라진다', () => {
    runOnce(h, 'done')
    h.sent.length = 0
    h.scheduler.tick()
    expect(h.sent).toHaveLength(0)
  })

  it('사용자가 멈추면 실패가 아니라 중단으로 남는다', () => {
    runOnce(h, 'stopped')
    expect(h.runs.get('p1').lastResult).toBe('skipped')
    expect(h.runs.get('p1').failStreak).toBe(0)
  })
})

describe('동시 실행 금지', () => {
  it('다른 작업이 돌고 있으면 보내지 않고 다음 틱을 기다린다', () => {
    const h = harness([playbook('p1', every(60))], NOW)
    h.scheduler.tick() // 기준 잡기
    h.flags.now = NOW + 61 * 60_000
    h.flags.running = true
    h.scheduler.tick()
    expect(h.sent).toHaveLength(0)
    // 기록도 건드리지 않는다 — '건너뜀'이 아니라 그냥 대기다
    expect(h.runs.get('p1').lastResult).toBeNull()
    expect(h.runs.get('p1').history).toHaveLength(0)

    h.flags.running = false
    h.scheduler.tick()
    expect(h.sent).toHaveLength(1)
  })

  it('지금 실행도 다른 작업이 돌고 있으면 거절한다', () => {
    const h = harness([playbook('p1', daily('09:00'))], NOW)
    h.flags.running = true
    expect(h.scheduler.runNow('p1')).toBe(false)
    h.flags.running = false
    expect(h.scheduler.runNow('p1')).toBe(true)
    expect(h.sent).toHaveLength(1)
  })

  it('없는 플레이북은 실행하지 않는다', () => {
    const h = harness([], NOW)
    expect(h.scheduler.runNow('없음')).toBe(false)
  })
})

describe('연속 실패 자동 일시정지', () => {
  it('세 번 잇달아 실패하면 스스로 멈춘다', () => {
    const h = harness([playbook('p1', every(15))], NOW)
    h.scheduler.tick()
    for (let i = 1; i <= SCHEDULE_FAIL_LIMIT; i += 1) {
      h.flags.now += 16 * 60_000
      runOnce(h, 'failed')
    }
    expect(h.runs.get('p1').failStreak).toBe(SCHEDULE_FAIL_LIMIT)
    expect(h.rows[0].schedule?.paused).toBe(true)
    expect(h.rows[0].schedule?.pauseReason).toBe('failed')
    // 멈춘 뒤에는 더 보내지 않는다
    const before = h.sent.length
    h.flags.now += 60 * 60_000
    h.scheduler.tick()
    expect(h.sent).toHaveLength(before)
  })

  it('중간에 한 번 성공하면 연속 실패가 풀린다', () => {
    const h = harness([playbook('p1', every(15))], NOW)
    h.scheduler.tick()
    h.flags.now += 16 * 60_000
    runOnce(h, 'failed')
    h.flags.now += 16 * 60_000
    runOnce(h, 'done')
    expect(h.runs.get('p1').failStreak).toBe(0)
    expect(h.rows[0].schedule?.paused).toBe(false)
  })

  it('재개하면 사유와 연속 실패가 지워진다', () => {
    const h = harness([playbook('p1', every(15))], NOW)
    h.scheduler.tick()
    for (let i = 1; i <= SCHEDULE_FAIL_LIMIT; i += 1) {
      h.flags.now += 16 * 60_000
      runOnce(h, 'failed')
    }
    expect(h.scheduler.setPaused('p1', false)).toBe(true)
    expect(h.rows[0].schedule?.paused).toBe(false)
    expect(h.rows[0].schedule?.pauseReason).toBeUndefined()
    expect(h.runs.get('p1').failStreak).toBe(0)
  })
})

describe('AI 미연결', () => {
  it('연결돼 있지 않으면 보내지 않고 사유를 남긴 채 멈춘다', () => {
    const h = harness([playbook('p1', every(15))], NOW)
    h.scheduler.tick()
    h.flags.now += 16 * 60_000
    h.flags.connected = false
    h.scheduler.tick()
    expect(h.sent).toHaveLength(0)
    expect(h.rows[0].schedule?.paused).toBe(true)
    expect(h.rows[0].schedule?.pauseReason).toBe('ai-disconnected')
  })

  it('돌던 중에 연결이 끊겨도 연속 실패로 세지 않는다', () => {
    const h = harness([playbook('p1', every(15))], NOW)
    h.scheduler.tick()
    h.flags.now += 16 * 60_000
    runOnce(h, 'failed', 'auth:notConnected')
    expect(h.runs.get('p1').failStreak).toBe(1)
    expect(h.rows[0].schedule?.pauseReason).toBe('ai-disconnected')
  })
})

describe('앱을 껐다 켠 뒤', () => {
  it('간격 예약은 놓친 만큼 따라잡지 않고 지금부터 한 주기 뒤로 잡는다', () => {
    const h = harness([playbook('p1', every(60))], NOW)
    h.scheduler.tick()
    // 앱이 다섯 시간 꺼져 있었다
    h.flags.now = NOW + 5 * 3_600_000
    h.scheduler.start()
    expect(h.runs.get('p1').nextRunAt).toBe(h.flags.now + 60 * 60_000)
    h.scheduler.tick()
    expect(h.sent).toHaveLength(0)
    h.scheduler.stop()
  })

  it('설정한 시각을 바꾸면 기준을 다시 잡는다', () => {
    const h = harness([playbook('p1', daily('09:00'))], NOW)
    h.scheduler.tick()
    h.rows[0] = { ...h.rows[0], schedule: daily('14:00') }
    h.scheduler.tick()
    // 기준이 지금으로 옮겨졌으니 어제 14시 건이 밀린 것으로 보이지 않는다
    expect(h.runs.get('p1').armedAt).toBe(NOW)
    expect(h.sent).toHaveLength(0)
  })

  it('지워진 플레이북의 기록은 걷어낸다', () => {
    const h = harness([playbook('p1', every(60))], NOW)
    h.scheduler.tick()
    h.rows.length = 0
    h.scheduler.tick()
    expect(h.runs.get('p1').armKey).toBeUndefined()
    expect(h.runs.get('p1').lastRunAt).toBeNull()
  })
})

describe('이번 실행만의 모델·권한 모드', () => {
  it('예약이 지정한 값을 채팅 실행에 넘긴다', () => {
    const h = harness(
      [playbook('p1', { ...every(15), model: 'claude-opus-5', permissionMode: 'read_only' })],
      NOW
    )
    h.scheduler.tick()
    h.flags.now += 16 * 60_000
    h.scheduler.tick()
    expect(h.scheduler.claimOverrides(h.sent[0].token)).toEqual({
      model: 'claude-opus-5',
      permissionMode: 'read_only'
    })
  })

  it('사용자가 직접 친 문장(토큰 없음)은 전역 설정 그대로 돈다', () => {
    const h = harness([playbook('p1', every(15))], NOW)
    expect(h.scheduler.claimOverrides(undefined)).toBeUndefined()
    expect(h.scheduler.claimOverrides('모르는-토큰')).toBeUndefined()
  })

  it('지정하지 않았으면 덮어쓰지 않는다', () => {
    const h = harness([playbook('p1', every(15))], NOW)
    h.scheduler.tick()
    h.flags.now += 16 * 60_000
    h.scheduler.tick()
    expect(h.scheduler.claimOverrides(h.sent[0].token)).toBeUndefined()
  })
})

describe('예약 상태 목록', () => {
  it('예약을 걸지 않은 플레이북도 한 줄을 차지한다', () => {
    const h = harness([playbook('p1'), playbook('p2', daily('09:00'))], NOW)
    const rows = h.scheduler.statusList()
    expect(rows.map((r) => r.playbookId)).toEqual(['p1', 'p2'])
    expect(rows[0].state).toBe('off')
    expect(rows[0].nextRunAt).toBeNull()
    expect(rows[1].state).toBe('waiting')
  })

  it('보낸 뒤에는 실행 중으로 보인다', () => {
    const h = harness([playbook('p1', daily('09:00'))], NOW)
    h.scheduler.runNow('p1')
    expect(h.scheduler.statusList()[0].state).toBe('running')
    h.scheduler.claimOverrides(h.sent[0].token)
    expect(h.scheduler.statusList()[0].state).toBe('running')
    h.scheduler.noteAgentEvent({ type: 'status', state: 'done' })
    expect(h.scheduler.statusList()[0].state).toBe('waiting')
  })

  it('일시정지 사유가 함께 실린다', () => {
    const h = harness([playbook('p1', daily('09:00'))], NOW)
    h.scheduler.setPaused('p1', true)
    const row = h.scheduler.statusList()[0]
    expect(row.state).toBe('paused')
    expect(row.pauseReason).toBe('manual')
  })

  it('수동 플레이북은 일시정지 대상이 아니다', () => {
    const h = harness([playbook('p1')], NOW)
    expect(h.scheduler.setPaused('p1', true)).toBe(false)
  })
})

describe('같은 계정의 여러 PC — 실행 주체', () => {
  const T = at(2026, 10, 8, 9, 5)
  const me = { id: 'dev-me-0001', name: 'PC-ME' }

  /** 어제 돌았고 오늘 09시 건이 밀려 있는 상태로 만든다(첫 틱에서 기준이 다시 잡히지 않게 armKey 를 맞춘다) */
  function armedHarness(schedule: PlaybookSchedule): Harness {
    const rows = [playbook('a', schedule)]
    const h = harness(rows, T, me)
    h.runs.set('a', {
      armedAt: at(2026, 10, 1),
      armKey: undefined,
      lastRunAt: at(2026, 10, 7, 9, 0),
      nextRunAt: null,
      lastResult: 'ok',
      lastSummary: '',
      failStreak: 0,
      history: []
    })
    h.scheduler.tick()
    h.runs.patch('a', { armedAt: at(2026, 10, 1) })
    h.sent.length = 0
    return h
  }

  it('다른 PC 가 맡은 예약은 돌리지 않는다', () => {
    const h = armedHarness({
      ...daily('09:00'),
      ownerDeviceId: 'dev-other-1',
      ownerDeviceName: 'PC-OTHER'
    })
    h.scheduler.tick()
    expect(h.sent).toHaveLength(0)
    expect(h.rows[0].schedule?.ownerDeviceId).toBe('dev-other-1') // 주인을 빼앗지 않는다
  })

  it('이 PC 가 맡은 예약은 돌린다', () => {
    const h = armedHarness({ ...daily('09:00'), ownerDeviceId: me.id, ownerDeviceName: me.name })
    h.scheduler.tick()
    expect(h.sent).toHaveLength(1)
  })

  it('주인이 없는 예약은 이 PC 를 주인으로 찍고 돌린다', () => {
    const h = armedHarness(daily('09:00'))
    h.scheduler.tick()
    expect(h.rows[0].schedule?.ownerDeviceId).toBe(me.id)
    expect(h.rows[0].schedule?.ownerDeviceName).toBe('PC-ME')
    expect(h.sent).toHaveLength(1)
  })

  it('예약이 꺼진 플레이북은 주인을 찍지 않는다', () => {
    const h = harness([playbook('a')], T, me)
    h.scheduler.tick()
    expect(h.rows[0].schedule?.ownerDeviceId).toBeUndefined()
  })
})
