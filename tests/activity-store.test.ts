// 활동 기록 저장소·기록기·추천 서비스 — 파일 회전, 마스킹, 설정의 기기 전용 여부.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityStore } from '../src/main/activity/store'
import { ActivityRecorder } from '../src/main/activity/recorder'
import { RecommendService, scheduleOfCandidate } from '../src/main/activity/recommend'
import type { ActivityRecord, ActivityRunRecord } from '@shared/activity'
import { serializeActivityRecord } from '@shared/activity'
import type { DismissedRecommendation } from '@shared/activity-patterns'
import type { AgentEvent } from '@shared/ipc'
import { SYNCED_SETTING_KEYS } from '@shared/sync'
import { DEFAULT_SETTINGS, parseSettings } from '@shared/settings'
import type { PlaybookDto, PlaybookInput } from '@shared/playbook'
import type { PlaybookSchedule } from '@shared/schedule'

const DAY = 86_400_000

function at(y: number, m: number, d: number, h: number, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'samba-activity-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('활동 기록 파일', () => {
  it('월별 파일에 한 줄씩 덧붙인다', () => {
    const store = new ActivityStore(dir, () => at(2026, 9, 19, 12))
    store.append({ t: 'run', at: at(2026, 9, 19, 9), prompt: '주문 처리', ok: true, ms: 100 })
    store.append({ t: 'visit', at: at(2026, 9, 19, 10), host: 'musinsa.com', minutes: 3 })
    expect(readdirSync(dir)).toEqual(['2026-09.jsonl'])
    expect(store.readSince(0)).toHaveLength(2)
    expect(store.runsSince(0)).toHaveLength(1)
    expect(store.visitsSince(0)).toHaveLength(1)
  })

  it('90일이 지난 달 파일은 덧붙일 때 지워진다', () => {
    const old: ActivityRecord = {
      t: 'run',
      at: at(2026, 5, 10, 9),
      prompt: '옛날 일',
      ok: true,
      ms: 1
    }
    writeFileSync(join(dir, '2026-05.jsonl'), serializeActivityRecord(old), 'utf8')
    const store = new ActivityStore(dir, () => at(2026, 9, 19, 12))
    store.append({ t: 'run', at: at(2026, 9, 19, 9), prompt: '지금 일', ok: true, ms: 1 })
    expect(readdirSync(dir)).toEqual(['2026-09.jsonl'])
  })

  it('깨진 줄이 있어도 나머지를 읽는다', () => {
    writeFileSync(
      join(dir, '2026-09.jsonl'),
      `{깨짐\n${serializeActivityRecord({ t: 'run', at: at(2026, 9, 19, 9), prompt: 'a', ok: true, ms: 1 })}`,
      'utf8'
    )
    expect(new ActivityStore(dir).readSince(0)).toHaveLength(1)
  })

  it('지우기는 기록 파일만 지운다', () => {
    const store = new ActivityStore(dir)
    store.append({ t: 'run', at: at(2026, 9, 19, 9), prompt: 'a', ok: true, ms: 1 })
    writeFileSync(join(dir, '남길것.txt'), 'x', 'utf8')
    expect(store.clear()).toBe(true)
    expect(readdirSync(dir)).toEqual(['남길것.txt'])
  })
})

describe('기록기', () => {
  const collect = (): { rows: ActivityRecord[]; append: (r: ActivityRecord) => void } => {
    const rows: ActivityRecord[] = []
    return { rows, append: (r) => rows.push(r) }
  }

  it('지시는 마스킹된 뒤에 남는다', () => {
    const sink = collect()
    let clock = 1000
    const rec = new ActivityRecorder({
      store: sink,
      enabled: () => true,
      now: () => clock
    })
    rec.notePrompt('사이트 비밀번호 abcd1234 로 로그인해 줘')
    rec.observeAgent({ type: 'status', state: 'running' })
    clock = 4000
    rec.observeAgent({ type: 'status', state: 'done' })
    const row = sink.rows[0] as ActivityRunRecord
    expect(row.t).toBe('run')
    expect(row.prompt).not.toContain('abcd1234')
    expect(row.ok).toBe(true)
    expect(row.ms).toBe(3000)
  })

  it('플레이북 이름과 실패를 함께 남긴다', () => {
    const sink = collect()
    const rec = new ActivityRecorder({ store: sink, enabled: () => true, now: () => 1 })
    rec.notePrompt('미이행 주문')
    rec.observeAgent({ type: 'playbook', names: ['SAMBA 미이행 주문 처리'] })
    rec.observeAgent({ type: 'status', state: 'running' })
    rec.observeAgent({ type: 'status', state: 'failed', message: '실패' })
    const row = sink.rows[0] as ActivityRunRecord
    expect(row.playbook).toBe('SAMBA 미이행 주문 처리')
    expect(row.ok).toBe(false)
  })

  it('사용자가 멈춘 작업은 남기지 않는다', () => {
    const sink = collect()
    const rec = new ActivityRecorder({ store: sink, enabled: () => true, now: () => 1 })
    rec.notePrompt('무언가')
    rec.observeAgent({ type: 'status', state: 'running' })
    rec.observeAgent({ type: 'status', state: 'stopped' })
    expect(sink.rows).toEqual([])
  })

  it('기록을 끄면 아무것도 남지 않는다', () => {
    const sink = collect()
    const rec = new ActivityRecorder({ store: sink, enabled: () => false, now: () => 1 })
    rec.notePrompt('무언가')
    rec.observeAgent({ type: 'status', state: 'running' })
    rec.observeAgent({ type: 'status', state: 'done' })
    rec.noteVisit('musinsa.com')
    rec.flush()
    expect(sink.rows).toEqual([])
  })

  it('방문은 호스트와 머문 분만 남기고, 같은 호스트면 이어 센다', () => {
    const sink = collect()
    let clock = 0
    const rec = new ActivityRecorder({ store: sink, enabled: () => true, now: () => clock })
    rec.noteVisit('musinsa.com')
    clock = 60_000
    rec.noteVisit('musinsa.com') // 같은 호스트 — 아무 일도 없다
    clock = 120_000
    rec.noteVisit('naver.com')
    expect(sink.rows).toEqual([{ t: 'visit', at: 0, host: 'musinsa.com', minutes: 2 }])
    clock = 180_000
    rec.flush()
    expect(sink.rows[1]).toEqual({ t: 'visit', at: 120_000, host: 'naver.com', minutes: 1 })
  })

  it('이벤트 처리 중 저장이 실패해도 예외를 던지지 않는다', () => {
    const rec = new ActivityRecorder({
      store: {
        append: () => {
          throw new Error('디스크 가득')
        }
      },
      enabled: () => true,
      now: () => 1
    })
    rec.notePrompt('무언가')
    rec.observeAgent({ type: 'status', state: 'running' })
    expect(() => rec.observeAgent({ type: 'status', state: 'done' } as AgentEvent)).not.toThrow()
  })
})

describe('설정 키는 계정에 따라온다', () => {
  it('동기화 대상에 들어 있다', () => {
    const keys = SYNCED_SETTING_KEYS as readonly string[]
    // 사용자 2026-10-02 "모든 설정 다 동일하게" — 기록 켬/끔도, 숨긴 추천 목록도 PC 마다 같아야 한다
    expect(keys).toContain('activityRecording')
    expect(keys).toContain('dismissedRecommendations')
  })

  it('기본값은 기록 켬·숨김 없음이고, 깨진 값은 기본값으로 돌아간다', () => {
    expect(DEFAULT_SETTINGS.activityRecording).toBe(true)
    const parsed = parseSettings({
      activityRecording: '켜짐',
      dismissedRecommendations: [{ key: 1 }]
    })
    expect(parsed.activityRecording).toBe(true)
    expect(parsed.dismissedRecommendations).toEqual([])
  })
})

describe('추천 서비스', () => {
  const now = at(2026, 9, 19, 18)

  function run(ts: number, prompt: string, playbook?: string): ActivityRunRecord {
    return { t: 'run', at: ts, prompt, ok: true, ms: 1, ...(playbook ? { playbook } : {}) }
  }

  /** 설정·플레이북을 메모리로 흉내 낸다 */
  function harness(
    rows: ActivityRunRecord[],
    playbooks: PlaybookDto[] = []
  ): {
    service: RecommendService
    list: PlaybookDto[]
    dismissed: () => DismissedRecommendation[]
  } {
    let dismissed: DismissedRecommendation[] = []
    const list = [...playbooks]
    const service = new RecommendService({
      runs: { runsSince: (from) => rows.filter((r) => r.at >= from) },
      settings: {
        get: () => ({ activityRecording: true, dismissedRecommendations: dismissed }),
        set: (patch) => (dismissed = patch.dismissedRecommendations)
      },
      playbooks: {
        list: () => list,
        put: (input: PlaybookInput) => {
          const created: PlaybookDto = {
            id: 'new-1',
            name: input.name,
            triggers: input.triggers,
            instructions: input.instructions,
            enabled: input.enabled,
            ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
            updatedAt: now
          }
          list.push(created)
          return created
        },
        setSchedule: (id: string, schedule: PlaybookSchedule) => {
          const found = list.find((p) => p.id === id)
          if (!found) return null
          found.schedule = schedule
          return found
        }
      },
      now: () => now
    })
    return { service, list, dismissed: () => dismissed }
  }

  it('플레이북이 이미 있으면 그 플레이북에 예약을 채워 켠다', () => {
    const rows = [1, 2, 3].map((d) => run(at(2026, 9, 10 + d, 9), '미이행', 'SAMBA 미이행'))
    const playbook: PlaybookDto = {
      id: 'p1',
      name: 'SAMBA 미이행',
      triggers: ['미이행'],
      instructions: '절차',
      enabled: true,
      updatedAt: 0
    }
    const { service, list } = harness(rows, [playbook])
    const [candidate] = service.list()
    expect(candidate.playbookId).toBe('p1')
    const applied = service.apply(candidate.key)
    expect(applied).toEqual({ playbookId: 'p1', created: false, scheduled: true })
    expect(list[0].schedule).toEqual({ enabled: true, kind: 'daily', at: '09:00', paused: false })
  })

  it('플레이북이 없으면 지시문으로 새로 만들고 편집기를 열도록 알린다', () => {
    const rows = [1, 2, 3].map((d) => run(at(2026, 9, 10 + d, 9), '주간 재고 확인'))
    const { service, list } = harness(rows)
    const [candidate] = service.list()
    expect(candidate.playbookId).toBeUndefined()
    const applied = service.apply(candidate.key)
    expect(applied?.created).toBe(true)
    expect(applied?.scheduled).toBe(true)
    expect(list[0].name).toBe('주간 재고 확인')
  })

  it('숨기면 목록에서 빠지고 숨김 설정에 남는다', () => {
    const rows = [1, 2, 3].map((d) => run(at(2026, 9, 10 + d, 9), '주간 재고 확인'))
    const { service, dismissed } = harness(rows)
    const [candidate] = service.list()
    expect(service.dismiss(candidate.key)).toBe(true)
    expect(dismissed().map((d) => d.key)).toEqual([candidate.key])
    expect(service.list()).toEqual([])
  })

  it('기록을 끈 상태면 추천하지 않는다', () => {
    const rows = [1, 2, 3].map((d) => run(at(2026, 9, 10 + d, 9), '주간 재고 확인'))
    const service = new RecommendService({
      runs: { runsSince: () => rows },
      settings: {
        get: () => ({ activityRecording: false, dismissedRecommendations: [] }),
        set: () => undefined
      },
      playbooks: { list: () => [], put: () => null, setSchedule: () => null },
      now: () => now
    })
    expect(service.list()).toEqual([])
  })

  it('시각이 흩어진 후보는 예약을 만들지 않는다', () => {
    expect(
      scheduleOfCandidate({
        key: 'k',
        label: 'x',
        kind: 'frequent',
        count: 3,
        spanDays: 5,
        hours: [1, 2, 3],
        lastAt: now
      })
    ).toBeNull()
  })

  it('요일 추천은 그 요일만 켠다', () => {
    expect(
      scheduleOfCandidate({
        key: 'k',
        label: 'x',
        kind: 'weekly',
        at: '09:00',
        weekday: 3,
        count: 3,
        spanDays: 20,
        hours: [9, 9, 9],
        lastAt: now
      })
    ).toEqual({ enabled: true, kind: 'weekly', at: '09:00', weekdays: [3], paused: false })
  })

  it('30일 밖의 기록만 있으면 카드가 없다', () => {
    const rows = [40, 39, 38].map((d) => run(now - d * DAY, '옛날 일'))
    const { service } = harness(rows)
    expect(service.list()).toEqual([])
  })

  it('기록 파일에 남은 내용은 그대로 읽힌다(저장소 → 추천 왕복)', () => {
    const store = new ActivityStore(dir, () => now)
    for (const d of [1, 2, 3]) {
      store.append(run(at(2026, 9, 10 + d, 9), '주간 재고 확인'))
    }
    expect(readFileSync(join(dir, '2026-09.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3)
    const service = new RecommendService({
      runs: store,
      settings: {
        get: () => ({ activityRecording: true, dismissedRecommendations: [] }),
        set: () => undefined
      },
      playbooks: { list: () => [], put: () => null, setSchedule: () => null },
      now: () => now
    })
    expect(service.list()[0].count).toBe(3)
  })
})
