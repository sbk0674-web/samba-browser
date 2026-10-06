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

const executeJavaScript = vi.fn()
const fakeTab = {
  id: 't1',
  view: { webContents: { getURL: () => 'https://example.com/', executeJavaScript } },
  profile: 'default',
  mobile: false
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samba-fetch-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const confirm = vi.fn(async () => true)
const tabsStub = { active: () => fakeTab, create: vi.fn(), list: () => [] }

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
const run = async (args: Record<string, unknown>, mode?: ToolContext['mode']): Promise<string> =>
  (
    await build(mode)
      .find((t) => t.name === 'fetch_url')!
      .handler(args)
  ).content[0].text

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

beforeEach(() => {
  vi.clearAllMocks()
  executeJavaScript.mockResolvedValue({
    b64: PNG.toString('base64'),
    type: 'image/png',
    bytes: PNG.length
  })
})

describe('fetch_url', () => {
  it('save_to 없이 base64 를 돌려주고, 페이지 안에서 credentials 포함 fetch 를 돌린다', async () => {
    const out = JSON.parse(await run({ url: 'https://example.com/a.png' }, 'read_only'))
    expect(out).toEqual({ ok: true, bytes: 8, type: 'image/png', b64: PNG.toString('base64') })
    const [script, userGesture] = executeJavaScript.mock.calls[0]
    expect(script).toContain(JSON.stringify('https://example.com/a.png'))
    expect(script).toContain("credentials:'include'")
    expect(userGesture).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('save_to 가 있으면 확인 후 파일로 저장하고 base64 는 돌려주지 않는다', async () => {
    const file = path.join(tmp, 'a.png')
    const out = JSON.parse(await run({ url: 'https://example.com/a.png', save_to: file }))
    expect(out).toEqual({ ok: true, bytes: 8, type: 'image/png', path: file })
    expect(fs.readFileSync(file).equals(PNG)).toBe(true)
    expect(confirm).toHaveBeenCalledWith(`파일 저장: ${file}`, 'danger')
  })

  it('확인을 거절하면 저장하지 않고 fetch 도 하지 않는다', async () => {
    confirm.mockResolvedValueOnce(false)
    const file = path.join(tmp, 'no.png')
    expect(await run({ url: 'https://example.com/a.png', save_to: file })).toBe('denied by user')
    expect(fs.existsSync(file)).toBe(false)
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('HTTP 오류 문자열을 그대로 돌려준다', async () => {
    executeJavaScript.mockResolvedValue({ error: 'HTTP 403' })
    expect(await run({ url: 'https://example.com/x' })).toBe('HTTP 403')
  })

  it('페이지 fetch 예외는 fetch 실패로 알린다', async () => {
    executeJavaScript.mockRejectedValue(new Error('Failed to fetch'))
    expect(await run({ url: 'https://other.example/x' })).toBe('fetch 실패: Failed to fetch')
  })

  it('25MB 를 넘으면 너무 큼', async () => {
    executeJavaScript.mockResolvedValue({ tooBig: 26 * 1024 * 1024 })
    expect(await run({ url: 'https://example.com/big' })).toBe(`파일 너무 큼: ${26 * 1024 * 1024}`)
  })

  it('UNC·상대 경로는 거부하고 fetch 하지 않는다', async () => {
    expect(
      await run({ url: 'https://example.com/a', save_to: String.raw`\\srv\share\a.png` })
    ).toBe('UNC 경로 불가')
    expect(
      await run({ url: 'https://example.com/a', save_to: String.raw`/\srv\share\a.png` })
    ).toBe('UNC 경로 불가')
    expect(await run({ url: 'https://example.com/a', save_to: 'a.png' })).toContain(
      '절대 경로가 아님'
    )
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('상위 폴더가 없으면 거부한다', async () => {
    const file = path.join(tmp, 'nodir', 'a.png')
    expect(await run({ url: 'https://example.com/a', save_to: file })).toContain('폴더 없음')
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('b64 가 1MB 를 넘으면 save_to 를 요구한다', async () => {
    const big = Buffer.alloc(900 * 1024, 7)
    executeJavaScript.mockResolvedValue({
      b64: big.toString('base64'),
      type: 'x',
      bytes: big.length
    })
    expect(await run({ url: 'https://example.com/big' })).toBe(`save_to 필요: ${big.length} bytes`)
  })
})
