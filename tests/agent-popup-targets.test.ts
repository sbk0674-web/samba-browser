// 팝업 창(결제창·주소 검색창)을 AI 작업 대상으로 다루는 경로의 회귀 테스트.
//
// 실기에서 무신사 '배송지 변경', 29CM '주소 검색' 버튼이 팝업 창을 열었는데도 AI 가
// 활성 탭만 보고 "창이 안 열린다"고 판단했다. 그 흐름을 두 겹으로 고정한다.
//  1) 대상 계산(targets.ts) — 탭+팝업 목록, 팝업이 닫히면 활성 탭으로 복귀
//  2) 도구(tools.ts) — list_tabs·switch_tab·close_tab 과 click 결과의 팝업 안내

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildTargets, pickAgentTargetId, type TargetInfo } from '../src/main/browser/targets'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'

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
    snapshot: vi.fn(),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    type: vi.fn(async () => 'ok'),
    select: vi.fn(async () => 'ok'),
    scroll: vi.fn(async () => 'ok'),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools, SAMBA_TOOL_NAMES } = await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

// --- 1) 대상 계산 ------------------------------------------------------------

const tabInfo = (id: string, title = id): TargetInfo => ({
  id,
  title,
  url: `https://shop.example/${id}`
})

describe('buildTargets — 탭 + 살아 있는 팝업', () => {
  it('탭 뒤에 팝업을 붙이고 kind·openerId 를 채운다', () => {
    const targets = buildTargets(
      [tabInfo('t1'), tabInfo('t2')],
      [{ id: 'p1', title: '주소 검색', url: 'https://post.example/find', openerId: 't1' }],
      't2',
      null
    )
    expect(targets.map((t) => t.id)).toEqual(['t1', 't2', 'p1'])
    expect(targets.map((t) => t.kind)).toEqual(['tab', 'tab', 'popup'])
    expect(targets[2].openerId).toBe('t1')
    expect(targets[2].title).toBe('주소 검색')
  })

  it('active 는 탭이면 활성 탭, 팝업이면 AI 표식이 붙은 것이다', () => {
    const popups = [{ id: 'p1', title: '결제', url: 'https://pay.example', openerId: 't1' }]
    const none = buildTargets([tabInfo('t1')], popups, 't1', null)
    expect(none.map((t) => t.active)).toEqual([true, false])
    const focused = buildTargets([tabInfo('t1')], popups, 't1', 'p1')
    expect(focused.map((t) => t.active)).toEqual([true, true])
  })

  it('탭에는 openerId 키 자체를 넣지 않는다', () => {
    const [tab] = buildTargets([tabInfo('t1')], [], 't1', null)
    expect('openerId' in tab).toBe(false)
  })
})

describe('pickAgentTargetId — 팝업이 닫히면 활성 탭으로 돌아간다', () => {
  it('표식이 없으면 활성 탭이다', () => {
    expect(pickAgentTargetId(null, ['p1'], 't1')).toBe('t1')
  })

  it('표식이 가리키는 팝업이 살아 있으면 그 팝업이다', () => {
    expect(pickAgentTargetId('p1', ['p1', 'p2'], 't1')).toBe('p1')
  })

  it('팝업이 닫히면(살아 있는 목록에서 빠지면) 활성 탭으로 복귀한다', () => {
    expect(pickAgentTargetId('p1', [], 't1')).toBe('t1')
    expect(pickAgentTargetId('p1', ['p2'], 't1')).toBe('t1')
  })

  it('활성 탭도 없으면 null 이다', () => {
    expect(pickAgentTargetId('p1', [], null)).toBeNull()
  })
})

// --- 2) 도구 --------------------------------------------------------------

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

/** 팝업을 열고 닫을 수 있는 가짜 TabManager. 실제 BrowserWindow 는 만들지 않는다 */
function fakeTabs(): {
  tabs: TabManager
  openPopup: (id: string, title: string, url: string) => void
  closePopup: (id: string) => void
  focused: () => string | null
  closed: string[]
  currentId: () => string
} {
  const tabs: TargetInfo[] = [tabInfo('t1', '주문서')]
  let popups: Array<TargetInfo & { openerId: string }> = []
  let focusedPopupId: string | null = null
  const closed: string[] = []
  const targetTab = (
    id: string
  ): { id: string; view: { webContents: { getURL: () => string } } } => {
    const found = [...tabs, ...popups].find((t) => t.id === id)
    return {
      id,
      view: { webContents: { getURL: () => found?.url ?? '' } }
    }
  }
  const manager = {
    list: () =>
      tabs.map((t) => ({ ...t, profile: 'default', mobile: false, loading: false, active: true })),
    listTargets: () => buildTargets(tabs, popups, 't1', focusedPopupId),
    agentTarget: () => {
      const id = pickAgentTargetId(
        focusedPopupId,
        popups.map((p) => p.id),
        't1'
      )
      return id === null ? null : targetTab(id)
    },
    active: () => targetTab('t1'),
    focusTarget: (id: string) => {
      focusedPopupId = popups.some((p) => p.id === id) ? id : null
    },
    closeTarget: (id: string) => {
      closed.push(id)
      if (focusedPopupId === id) focusedPopupId = null
      popups = popups.filter((p) => p.id !== id)
    },
    activate: vi.fn(),
    close: vi.fn(),
    create: vi.fn(),
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  return {
    tabs: manager,
    openPopup: (id, title, url) => popups.push({ id, title, url, openerId: 't1' }),
    closePopup: (id) => {
      popups = popups.filter((p) => p.id !== id)
      if (focusedPopupId === id) focusedPopupId = null
    },
    focused: () => focusedPopupId,
    closed,
    currentId: () => manager.agentTarget()?.id ?? ''
  }
}

function build(tabs: TabManager): ToolStub[] {
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: 'guard',
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick: () => null,
    onStep: () => undefined
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return server.tools
}

const get = (tools: ToolStub[], name: string): ToolStub => tools.find((t) => t.name === name)!
const textOut = (r: { content: { text: string }[] }): string => r.content[0].text

beforeEach(() => {
  pageBridge.textOf.mockReset()
  pageBridge.textOf.mockResolvedValue('')
  pageBridge.click.mockReset()
  pageBridge.click.mockImplementation(async () => 'ok')
  pageBridge.waitForLoad.mockClear()
})

describe('list_tabs — 팝업도 함께 나열한다', () => {
  it('도구 이름이 허용 목록에 있다', () => {
    expect(SAMBA_TOOL_NAMES).toContain('mcp__samba__list_tabs')
    expect(SAMBA_TOOL_NAMES).toContain('mcp__samba__close_tab')
  })

  it('kind popup 과 openerId·제목·주소를 돌려준다', async () => {
    const env = fakeTabs()
    env.openPopup('p1', '주소 검색', 'https://post.example/find')
    const r = await get(build(env.tabs), 'list_tabs').handler({})
    const parsed = JSON.parse(textOut(r)) as Array<{
      id: string
      kind: string
      title: string
      openerId?: string
    }>
    expect(parsed).toHaveLength(2)
    expect(parsed[1]).toMatchObject({ id: 'p1', kind: 'popup', title: '주소 검색', openerId: 't1' })
  })
})

describe('switch_tab — 팝업 id 로 들어간다', () => {
  it('팝업을 고르면 이후 도구가 그 팝업을 대상으로 삼는다', async () => {
    const env = fakeTabs()
    env.openPopup('p1', '주소 검색', 'https://post.example/find')
    const tools = build(env.tabs)
    expect(env.currentId()).toBe('t1')
    const r = await get(tools, 'switch_tab').handler({ id: 'p1' })
    expect(textOut(r)).toContain('now working in popup p1')
    expect(env.focused()).toBe('p1')
    expect(env.currentId()).toBe('p1')

    // 팝업이 닫히면 따로 알리지 않아도 원래 탭으로 돌아온다
    env.closePopup('p1')
    expect(env.currentId()).toBe('t1')
  })

  it('모르는 id 는 거부 문구를 돌려준다', async () => {
    const env = fakeTabs()
    const r = await get(build(env.tabs), 'switch_tab').handler({ id: 'nope' })
    expect(textOut(r)).toContain('not found')
    expect(env.focused()).toBeNull()
  })
})

describe('navigate — 팝업 안에서는 주소를 갈아 끼우지 않는다', () => {
  it('팝업을 보고 있으면 탭으로 돌아가라고 거부한다', async () => {
    const env = fakeTabs()
    env.openPopup('p1', '결제', 'https://pay.example/nice')
    const tools = build(env.tabs)
    await get(tools, 'switch_tab').handler({ id: 'p1' })
    const r = await get(tools, 'navigate').handler({ url: 'https://shop.example' })
    expect(textOut(r)).toContain('cannot navigate inside a popup')
  })
})

describe('close_tab — 팝업도 닫는다', () => {
  it('팝업 id 를 주면 그 창을 닫는다', async () => {
    const env = fakeTabs()
    env.openPopup('p1', '결제', 'https://pay.example/nice')
    const r = await get(build(env.tabs), 'close_tab').handler({ id: 'p1' })
    expect(textOut(r)).toContain('closed popup p1')
    expect(env.closed).toEqual(['p1'])
  })
})

describe('click 결과의 팝업 안내', () => {
  it('클릭으로 팝업이 새로 열리면 안내 한 줄을 덧붙인다', async () => {
    const env = fakeTabs()
    const tools = build(env.tabs)
    pageBridge.click.mockImplementation(async () => {
      env.openPopup('p1', '주소 검색', 'https://post.example/find')
      return 'ok'
    })
    const r = await get(tools, 'click').handler({ id: 3, label: '배송지 변경' })
    expect(textOut(r)).toBe(
      'ok\nopened popup p1 "주소 검색" (post.example) - call switch_tab("p1") to work inside it'
    )
  })

  it('팝업이 열리지 않으면 결과를 그대로 둔다', async () => {
    const env = fakeTabs()
    const r = await get(build(env.tabs), 'click').handler({ id: 3, label: '다음' })
    expect(textOut(r)).toBe('ok')
  })

  it('이미 떠 있던 팝업은 다시 안내하지 않는다', async () => {
    const env = fakeTabs()
    env.openPopup('p1', '주소 검색', 'https://post.example/find')
    const r = await get(build(env.tabs), 'click').handler({ id: 3, label: '다음' })
    expect(textOut(r)).toBe('ok')
  })

  it('type 도 같은 안내를 붙인다', async () => {
    const env = fakeTabs()
    pageBridge.type.mockImplementation(async () => {
      env.openPopup('p2', '우편번호', 'https://post.example/zip')
      return 'ok'
    })
    const r = await get(build(env.tabs), 'type').handler({ id: 1, text: '역삼동', submit: true })
    expect(textOut(r)).toContain('opened popup p2 "우편번호" (post.example)')
    pageBridge.type.mockImplementation(async () => 'ok')
  })
})

describe('buildTargets — 프로필', () => {
  it('프로필을 준 탭·팝업은 목록에 프로필이 실린다(같은 주문서 주소의 탭을 계정으로 가린다)', () => {
    const targets = buildTargets(
      [
        { id: 't1', title: '주문서', url: 'https://www.29cm.co.kr/order/checkout', profile: 'a' },
        { id: 't2', title: '주문서', url: 'https://www.29cm.co.kr/order/checkout', profile: 'b' }
      ],
      [{ id: 'p1', title: '결제', url: 'https://pay.example', openerId: 't2', profile: 'b' }],
      't1',
      null
    )
    expect(targets.map((t) => t.profile)).toEqual(['a', 'b', 'b'])
  })

  it('프로필을 안 주면 그 값이 없다', () => {
    const [only] = buildTargets([{ id: 't1', title: '', url: 'about:blank' }], [], 't1', null)
    expect('profile' in only).toBe(false)
  })
})
