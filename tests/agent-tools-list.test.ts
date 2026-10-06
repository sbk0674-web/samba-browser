// 도구 목록 변환 회귀 — SDK 가 tools/list 에서 모든 도구의 입력 스키마를 JSON Schema 로 바꾼다.
// 스키마 하나가 변환에 실패하면(실기: z.record) 예외가 나서 도구 전체가 빠지고,
// 모델은 "브라우저 도구가 하나도 연결돼 있지 않다"며 아무 일도 못 한다. SDK 를 흉내 내지 않고 실제 경로를 돌린다

import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '../src/main/agent/tools'

vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge: {} }))

const { createSambaTools, parseScriptArgs } = await import('../src/main/agent/tools')

interface ListedServer {
  instance: {
    server: {
      _requestHandlers: Map<
        string,
        (request: unknown, extra: unknown) => Promise<{ tools: { name: string }[] }>
      >
    }
  }
}

describe('tools/list', () => {
  it('선택 도구를 모두 켠 상태에서도 목록 변환이 성공한다', async () => {
    const ctx = {
      tabs: { active: () => null, list: () => [] },
      dangerWords: [],
      mode: 'guard',
      finalConfirm: false,
      confirm: async () => true,
      tick: () => null,
      onStep: () => {},
      siteMemory: { remember: () => 'ok' },
      scripts: { find: () => undefined, save: () => 'saved', ran: () => {} },
      playbooks: { list: () => [], update: () => null }
    } as unknown as ToolContext
    const server = createSambaTools(ctx) as unknown as ListedServer
    const list = server.instance.server._requestHandlers.get('tools/list')
    expect(list).toBeDefined()
    const result = await list!({ method: 'tools/list', params: {} }, {})
    const names = result.tools.map((t) => t.name)
    for (const name of [
      'get_page',
      'click',
      'run_js',
      'upload_file',
      'set_download_dir',
      'list_downloads',
      'fetch_url',
      'fill_secret',
      'save_script',
      'run_script',
      'remember_site',
      'update_playbook',
      'done'
    ])
      expect(names).toContain(name)
  })
})

describe('parseScriptArgs', () => {
  it('JSON 객체 문자열만 받는다', () => {
    expect(parseScriptArgs('{"orderNo":"A-1","cost":33630}')).toEqual({
      orderNo: 'A-1',
      cost: 33630
    })
    expect(parseScriptArgs(undefined)).toEqual({})
    expect(parseScriptArgs('  ')).toEqual({})
    expect(parseScriptArgs('[1,2]')).toBeNull()
    expect(parseScriptArgs('"x"')).toBeNull()
    expect(parseScriptArgs('{broken')).toBeNull()
  })
})
