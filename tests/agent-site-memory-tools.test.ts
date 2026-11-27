// 도구 쪽 배선 — 행동 도구만 onCall 로 흘러가는가, remember_site 가 붙는가.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'
import type { AgentToolCall } from '@shared/site-memory'

// SDK 의 tool()/createSdkMcpServer() 를 얇게 대체해 도구 핸들러를 직접 부를 수 있게 한다
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    keypadSignals: vi.fn(async () => ({
      url: 'https://shop.example/',
      text: '',
      digitButtons: 0,
      pinField: false
    })),
    snapshot: vi.fn(async () => ({
      url: 'https://shop.example/cart',
      title: '장바구니',
      text: '',
      elements: [],
      total: 0
    })),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok (pressed Enter)'),
    type: vi.fn(async () => 'ok'),
    select: vi.fn(async () => 'ok'),
    scroll: vi.fn(async () => 'ok'),
    isSecretField: vi.fn(async () => false),
    overlays: vi.fn(async () => []),
    captchaHint: vi.fn(async () => ({ needsUser: false, matched: '' })),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools, SAMBA_TOOL_NAMES } = await import('../src/main/agent/tools')
const { secretKeypadGate } = await import('../src/main/agent/secret-page')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

const fakeTab = {
  id: 't1',
  view: { webContents: { getURL: () => 'https://shop.example/cart', getTitle: () => '장바구니' } },
  profile: 'default',
  mobile: false
}

function build(withMemory = true, active: () => unknown = () => fakeTab): {
  tools: ToolStub[]
  calls: AgentToolCall[]
  remembered: Array<{ host: string; note: string }>
} {
  const calls: AgentToolCall[] = []
  const remembered: Array<{ host: string; note: string }> = []
  const tabs = {
    active,
    create: vi.fn(() => ({ id: 't2' })),
    activate: vi.fn(),
    close: vi.fn(),
    list: () => [{ id: 't1', title: '장바구니', url: 'https://shop.example/cart', active: true }],
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: 'guard',
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick: () => null,
    onStep: () => {},
    onCall: (call) => calls.push(call),
    siteMemory: withMemory
      ? {
          remember: (host, note) => {
            remembered.push({ host, note })
            return `ok: remembered (${host})`
          }
        }
      : undefined
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return { tools: server.tools, calls, remembered }
}

beforeEach(() => {
  vi.clearAllMocks()
  secretKeypadGate.clear()
})

describe('행동 도구만 사이트 기억으로 흘러간다', () => {
  it('클릭은 도구 이름·라벨·결과·URL 을 함께 넘긴다', async () => {
    const { tools, calls } = build()
    const click = tools.find((t) => t.name === 'click')!
    await click.handler({ id: 3, label: '구매하기' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      tool: 'click',
      label: '클릭: 구매하기 (#3)',
      ok: true,
      url: 'https://shop.example/cart'
    })
    // Enter 폴백 표식이 결과 그대로 실려 와야 자동 메모를 만들 수 있다
    expect(calls[0].result).toContain('pressed Enter')
  })

  it.each([
    ['closed tab', undefined],
    ['destroyed tab', { isDestroyed: () => true, getURL: () => { throw new Error('Object has been destroyed') } }]
  ])('returns script result even when its work tab is a %s', async (_state, webContents) => {
    const { tools, calls } = build(true, () => ({ ...fakeTab, view: { webContents } }))
    const result = await tools.find((t) => t.name === 'run_js')!.handler({
      code: 'return "script completed"',
      safety: 'no_pay'
    })
    expect(result.content[0].text).toBe('script completed')
    expect(calls).toEqual([expect.objectContaining({ tool: 'run_js', ok: true, url: '' })])
  })

  it('관찰 도구(get_page·list_tabs)는 넘기지 않는다', async () => {
    const { tools, calls } = build()
    await tools.find((t) => t.name === 'get_page')!.handler({})
    await tools.find((t) => t.name === 'list_tabs')!.handler({})
    expect(calls).toHaveLength(0)
  })

  it('입력·선택·스크롤도 행동으로 잡힌다', async () => {
    const { tools, calls } = build()
    await tools.find((t) => t.name === 'type')!.handler({ id: 1, text: '255', submit: false })
    await tools.find((t) => t.name === 'select')!.handler({ id: 2, value: 'BLACK' })
    await tools.find((t) => t.name === 'scroll')!.handler({ direction: 'down' })
    expect(calls.map((c) => c.tool)).toEqual(['type', 'select', 'scroll'])
  })
})

describe('remember_site 도구', () => {
  it('허용 도구 목록에 들어 있다', () => {
    expect(SAMBA_TOOL_NAMES).toContain('mcp__samba__remember_site')
  })

  it('기억 서비스로 그대로 넘긴다', async () => {
    const { tools, remembered } = build()
    const out = await tools
      .find((t) => t.name === 'remember_site')!
      .handler({ host: 'musinsa.com', note: "'구매하기' 는 Enter 로 열린다" })
    expect(out.content[0].text).toContain('remembered')
    expect(remembered).toEqual([{ host: 'musinsa.com', note: "'구매하기' 는 Enter 로 열린다" }])
  })

  it('기억이 붙어 있지 않으면 도구를 등록하지 않는다', () => {
    expect(build(false).tools.find((t) => t.name === 'remember_site')).toBeUndefined()
  })
})
