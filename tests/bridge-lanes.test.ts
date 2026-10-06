// 브릿지 레인 — 레인이 다르면 동시에, 같은 레인·레인 없는 요청은 겹치지 않는다
import { describe, it, expect, afterEach } from 'vitest'
import { BridgeServer } from '../src/main/bridge/server'
import type { ToolSession } from '../src/main/agent/runner'
import { laneTabs, newLaneState } from '../src/main/agent/lane-tabs'
import type { TabManager } from '../src/main/browser/tab-manager'

const TOKEN = 'a'.repeat(64)
let server: BridgeServer | null = null
afterEach(async () => {
  await server?.stop()
  server = null
})

function slowSessions(ms: number): {
  make: (onStep: (l: string, ok: boolean) => void, lane?: string) => ToolSession
  lanes: Array<string | undefined>
} {
  const lanes: Array<string | undefined> = []
  return {
    lanes,
    make: (_onStep, lane) => {
      lanes.push(lane)
      return {
        names: () => ['get_page'],
        call: async () => {
          await new Promise((r) => setTimeout(r, ms))
          return `ok ${lane ?? '-'}`
        },
        dispose: () => {}
      }
    }
  }
}

async function up(ms: number): Promise<{ base: string; lanes: Array<string | undefined> }> {
  const s = slowSessions(ms)
  server = new BridgeServer({ openSession: s.make, token: () => TOKEN })
  const port = await server.start(0)
  return { base: `http://127.0.0.1:${port}`, lanes: s.lanes }
}

const call = (base: string, lane?: string): Promise<Response> =>
  fetch(`${base}/tool/get_page`, {
    method: 'POST',
    headers: {
      'X-Samba-Token': TOKEN,
      'content-type': 'application/json',
      ...(lane ? { 'X-Samba-Lane': lane } : {})
    },
    body: '{}'
  })

describe('브릿지 레인', () => {
  it('레인이 다르면 동시에 돈다', async () => {
    const { base, lanes } = await up(150)
    const [a, b] = await Promise.all([call(base, 'edelvise06'), call(base, 'cannonfort')])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(lanes.sort()).toEqual(['cannonfort', 'edelvise06'])
  })

  it('같은 레인이 겹치면 409, 레인 중에는 레인 없는 요청도 409', async () => {
    const { base } = await up(150)
    const first = call(base, 'edelvise06')
    await new Promise((r) => setTimeout(r, 30))
    expect((await call(base, 'edelvise06')).status).toBe(409)
    expect((await call(base)).status).toBe(409)
    expect((await first).status).toBe(200)
  })
})

describe('레인 탭 보기', () => {
  it('레인은 자기가 연 탭만 보고 작업 창도 따로 쥔다', () => {
    const tabs: Array<{ id: string; url: string }> = []
    let n = 0
    const real = {
      list: () => tabs.map((t) => ({ ...t, title: '', active: false })),
      listTargets: () =>
        tabs.map((t) => ({ id: t.id, kind: 'tab', title: '', url: t.url, active: false })),
      get: (id: string) => (tabs.some((t) => t.id === id) ? ({ id } as never) : null),
      targetTab: (id: string) => (tabs.some((t) => t.id === id) ? ({ id } as never) : null),
      create: (o: { url?: string }) => {
        const t = { id: `t${++n}`, url: o.url ?? '' }
        tabs.push(t)
        return { ...t, title: '', active: true }
      },
      close: (id: string) => {
        const i = tabs.findIndex((t) => t.id === id)
        if (i >= 0) tabs.splice(i, 1)
      }
    } as unknown as TabManager
    const a = laneTabs(real, newLaneState())
    const b = laneTabs(real, newLaneState())
    a.create({ url: 'https://musinsa.com/a' })
    b.create({ url: 'https://musinsa.com/b' })
    expect(a.list().map((t) => t.url)).toEqual(['https://musinsa.com/a'])
    expect(b.list().map((t) => t.url)).toEqual(['https://musinsa.com/b'])
    expect((a.agentTarget() as unknown as { id: string }).id).toBe('t1')
    expect((b.agentTarget() as unknown as { id: string }).id).toBe('t2')
    // 폰 배선이 보는 작업 탭(workingTab)도 레인 것이다
    expect((a.workingTab() as unknown as { id: string }).id).toBe('t1')
    expect((b.workingTab() as unknown as { id: string }).id).toBe('t2')
    // 남의 탭은 닫지 못한다
    a.close('t2')
    expect(tabs.length).toBe(2)
  })
})
