// 실제 SDK 서버로 도구 세션을 만든다 — @anthropic-ai/claude-agent-sdk 를 모킹하지 않는다.
// vi.mock 은 파일 단위로 적용되므로, agent-tool-session.test.ts 의 SDK 모킹과 겹치지 않도록
// 이 테스트만 별도 파일에 둔다(실제 createSdkMcpServer()가 .tools 를 그대로 돌려주는지 확인)
import { describe, it, expect, vi } from 'vitest'
import { AgentRunner } from '../src/main/agent/runner'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { SettingsStore } from '../src/main/settings/store'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

vi.mock('../src/main/browser/page-bridge', () => ({
  pageBridge: {
    snapshot: vi.fn(async () => ({
      url: 'https://a.test/',
      title: 'A',
      text: '본문',
      elements: []
    })),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    rectOf: vi.fn(async () => null),
    overlays: vi.fn(async () => [])
  }
}))

function runner(): AgentRunner {
  const tabs = {
    active: () => ({
      id: 't1',
      view: { webContents: { getURL: () => 'https://a.test/', isDestroyed: () => false } }
    }),
    list: () => [],
    listTargets: () => [],
    create: vi.fn(),
    activate: vi.fn(),
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const settings = { get: () => ({ ...DEFAULT_SETTINGS }) } as unknown as SettingsStore
  return new AgentRunner(tabs, settings, () => {})
}

describe('실제 SDK 서버로', () => {
  it('도구 목록을 뽑고, 도구를 호출할 수 있다', async () => {
    const s = runner().createToolSession({})
    const names = s.names()
    expect(names).toContain('get_page')
    expect(names).toContain('list_tabs')
    // 브릿지 /health 의 tools[] 는 이 목록 그대로다
    expect(names).toContain('upload_file')
    expect(names).toContain('set_download_dir')
    expect(names).toContain('list_downloads')
    expect(names).not.toContain('done')
    const out = await s.call('list_tabs', {})
    expect(typeof out).toBe('string')
    s.dispose()
  })
})
