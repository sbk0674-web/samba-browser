import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge: {} }))

const { ensureDebuggerAttached, keepDebuggerAttached } = vi.hoisted(() => ({
  ensureDebuggerAttached: vi.fn(() => true),
  keepDebuggerAttached: vi.fn()
}))
vi.mock('../src/main/browser/emulation', () => ({ ensureDebuggerAttached, keepDebuggerAttached }))

const { createSambaTools } = await import('../src/main/agent/tools')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

const sendCommand = vi.fn()
const fakeTab = {
  id: 't1',
  view: {
    webContents: {
      getURL: () => 'https://example.com/form',
      debugger: { isAttached: () => true, attach: vi.fn(), sendCommand }
    }
  },
  profile: 'default',
  mobile: false
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samba-upload-'))
const realFile = path.join(tmp, 'a.txt')
fs.writeFileSync(realFile, 'hello')
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const confirm = vi.fn(async () => true)
const tabsStub = {
  active: () => fakeTab,
  create: vi.fn(),
  list: () => [],
  downloadDir: null as string | null,
  downloads: [] as unknown[]
}

function build(mode: ToolContext['mode'] = 'guard'): ToolStub[] {
  const ctx: ToolContext = {
    tabs: tabsStub as unknown as TabManager,
    dangerWords: [],
    mode,
    finalConfirm: false,
    confirm,
    tick: () => null,
    onStep: () => {}
  }
  return (createSambaTools(ctx) as unknown as { tools: ToolStub[] }).tools
}
const run = async (
  name: string,
  args: Record<string, unknown>,
  mode?: ToolContext['mode']
): Promise<string> =>
  (
    await build(mode)
      .find((t) => t.name === name)!
      .handler(args)
  ).content[0].text

beforeEach(() => {
  vi.clearAllMocks()
  tabsStub.downloadDir = null
  tabsStub.downloads = []
  sendCommand.mockImplementation(async (method: string) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: 7 }
    return {}
  })
})

describe('upload_file', () => {
  it('파일 input 에 파일을 넣는다', async () => {
    const out = await run('upload_file', { selector: '#f', paths: [realFile] })
    expect(JSON.parse(out)).toEqual({ ok: true, files: 1 })
    expect(sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', {
      files: [realFile],
      nodeId: 7
    })
    expect(ensureDebuggerAttached).toHaveBeenCalled()
    expect(keepDebuggerAttached).toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledWith(`파일 업로드: ${realFile} → #f`, 'danger')
  })

  it('전체 모드에서도 확인을 묻는다', async () => {
    await run('upload_file', { selector: '#f', paths: [realFile] }, 'full')
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('셀렉터가 없으면 알린다', async () => {
    sendCommand.mockImplementation(async (method: string) =>
      method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : { nodeId: 0 }
    )
    expect(await run('upload_file', { selector: '#x', paths: [realFile] })).toBe('셀렉터 없음: #x')
  })

  it('없는 파일·상대 경로·폴더는 CDP 를 부르지 않는다', async () => {
    const missing = path.join(tmp, 'nope.txt')
    expect(await run('upload_file', { selector: '#f', paths: [missing] })).toBe(
      `파일 없음: ${missing}`
    )
    expect(await run('upload_file', { selector: '#f', paths: ['a.txt'] })).toBe('파일 없음: a.txt')
    expect(await run('upload_file', { selector: '#f', paths: [tmp] })).toBe(`파일 없음: ${tmp}`)
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('읽기 전용에서는 거부한다', async () => {
    expect(await run('upload_file', { selector: '#f', paths: [realFile] }, 'read_only')).toBe(
      'refused: read-only mode'
    )
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('확인을 거절하면 CDP 를 부르지 않는다', async () => {
    confirm.mockResolvedValueOnce(false)
    expect(await run('upload_file', { selector: '#f', paths: [realFile] })).toBe('denied by user')
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('input 이 아니면 file input 아님', async () => {
    sendCommand.mockImplementation(async (method: string) => {
      if (method === 'DOM.setFileInputFiles') throw new Error('Node is not a file input')
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      return { nodeId: 7 }
    })
    expect(await run('upload_file', { selector: 'div', paths: [realFile] })).toBe(
      'file input 아님: div'
    )
  })
})

describe('upload_file 보강', () => {
  it('input 과 무관한 CDP 오류는 업로드 실패로 알린다', async () => {
    sendCommand.mockImplementation(async (method: string) => {
      if (method === 'DOM.setFileInputFiles') throw new Error('Target closed')
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      return { nodeId: 7 }
    })
    expect(await run('upload_file', { selector: '#f', paths: [realFile] })).toBe(
      '업로드 실패: Target closed'
    )
  })

  it('UNC 경로는 거부한다', async () => {
    expect(await run('upload_file', { selector: '#f', paths: [String.raw`\\srv\share\a.txt`] })).toBe(
      'UNC 경로 불가'
    )
    expect(await run('upload_file', { selector: '#f', paths: ['//srv/share/a.txt'] })).toBe(
      'UNC 경로 불가'
    )
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('슬래시가 섞인 UNC 경로도 거부한다', async () => {
    expect(await run('upload_file', { selector: '#f', paths: [String.raw`/\srv\share\x`] })).toBe(
      'UNC 경로 불가'
    )
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('정규화한 경로를 확인 카드와 CDP 에 쓴다', async () => {
    const messy = `${tmp}${path.sep}.${path.sep}a.txt`
    await run('upload_file', { selector: '#f', paths: [messy] })
    expect(confirm).toHaveBeenCalledWith(`파일 업로드: ${realFile} → #f`, 'danger')
    expect(sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', {
      files: [realFile],
      nodeId: 7
    })
  })
})

describe('set_download_dir · list_downloads', () => {
  it('확인을 거절하면 폴더를 만들지 않는다', async () => {
    confirm.mockResolvedValueOnce(false)
    const dir = path.join(tmp, 'denied')
    expect(await run('set_download_dir', { path: dir })).toBe('denied by user')
    expect(fs.existsSync(dir)).toBe(false)
    expect(tabsStub.downloadDir).toBeNull()
  })

  it('폴더를 만들고 TabManager 에 저장한다', async () => {
    const dir = path.join(tmp, 'dl', 'nested')
    const out = await run('set_download_dir', { path: dir })
    expect(JSON.parse(out)).toEqual({ ok: true, dir })
    expect(fs.statSync(dir).isDirectory()).toBe(true)
    expect(tabsStub.downloadDir).toBe(dir)
  })

  it('상대 경로·읽기 전용은 거부한다', async () => {
    expect(await run('set_download_dir', { path: 'rel' })).toContain('절대 경로가 아님')
    expect(await run('set_download_dir', { path: tmp }, 'read_only')).toBe(
      'refused: read-only mode'
    )
    expect(tabsStub.downloadDir).toBeNull()
  })

  it('list_downloads 는 읽기 전용에서도 기록을 돌려준다', async () => {
    const rec = { file: 'x', url: 'u', state: 'completed', bytes: 3, startedAt: 't' }
    tabsStub.downloads = [rec]
    expect(JSON.parse(await run('list_downloads', {}, 'read_only'))).toEqual([rec])
  })
})
