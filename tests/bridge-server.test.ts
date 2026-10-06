// 브릿지 HTTP — 토큰·라우팅·busy·제한 시간
import { describe, it, expect, afterEach } from 'vitest'
import { BridgeServer } from '../src/main/bridge/server'
import type { ToolSession } from '../src/main/agent/runner'

const TOKEN = 'a'.repeat(64)

function fakeSession(opts: { slowMs?: number; fail?: boolean } = {}): {
  make: (onStep: (l: string, ok: boolean) => void) => ToolSession
  disposed: () => number
} {
  let disposed = 0
  return {
    disposed: () => disposed,
    make: (onStep) => ({
      names: () => ['get_page', 'click', 'upload_file', 'phone_approve_payment'],
      call: async (name, args) => {
        if (name === 'click') onStep(`클릭: ${String(args.id)}`, true)
        if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs))
        if (opts.fail) throw new Error('boom')
        return `${name} 결과`
      },
      dispose: () => {
        disposed += 1
      }
    })
  }
}

let server: BridgeServer | null = null
afterEach(async () => {
  await server?.stop()
  server = null
})

async function up(
  deps: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}
): Promise<string> {
  const fs = fakeSession()
  server = new BridgeServer({ openSession: fs.make, token: () => TOKEN, ...deps })
  const port = await server.start(0)
  return `http://127.0.0.1:${port}`
}

const H = { 'X-Samba-Token': TOKEN, 'content-type': 'application/json' }

describe('BridgeServer', () => {
  it('토큰이 없거나 틀리면 401', async () => {
    const base = await up()
    expect((await fetch(`${base}/health`)).status).toBe(401)
    expect((await fetch(`${base}/health`, { headers: { 'X-Samba-Token': 'wrong' } })).status).toBe(
      401
    )
  })

  it('길이는 맞지만 틀린 토큰도 401', async () => {
    const base = await up()
    const wrong = 'b'.repeat(64)
    expect(wrong).not.toBe(TOKEN)
    expect((await fetch(`${base}/health`, { headers: { 'X-Samba-Token': wrong } })).status).toBe(
      401
    )
  })

  it('설정된 토큰이 빈 문자열이면 빈 헤더로도 401', async () => {
    const fs = fakeSession()
    server = new BridgeServer({ openSession: fs.make, token: () => '' })
    const port = await server.start(0)
    expect(
      (await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'X-Samba-Token': '' } })).status
    ).toBe(401)
  })

  it('health 는 도구 이름을 준다', async () => {
    const base = await up()
    const r = await fetch(`${base}/health`, { headers: H })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      ok: true,
      tools: ['get_page', 'click', 'upload_file', 'phone_approve_payment']
    })
  })

  it('도구를 부르고 진행 로그를 함께 돌려주며, 요청마다 세션을 닫는다', async () => {
    const fs = fakeSession()
    server = new BridgeServer({ openSession: fs.make, token: () => TOKEN })
    const port = await server.start(0)
    const r = await fetch(`http://127.0.0.1:${port}/tool/click`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ args: { id: 7 } })
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      ok: true,
      result: 'click 결과',
      steps: [{ label: '클릭: 7', ok: true }]
    })
    expect(fs.disposed()).toBe(1)
  })

  it('없는 도구 404, 도구 오류 500, JSON 아님 400', async () => {
    const base = await up()
    expect(
      (await fetch(`${base}/tool/nope`, { method: 'POST', headers: H, body: '{"args":{}}' })).status
    ).toBe(404)
    expect(
      (await fetch(`${base}/tool/get_page`, { method: 'POST', headers: H, body: '{not json' }))
        .status
    ).toBe(400)
    const fs = fakeSession({ fail: true })
    await server?.stop()
    server = new BridgeServer({ openSession: fs.make, token: () => TOKEN })
    const port = await server.start(0)
    const r = await fetch(`http://127.0.0.1:${port}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ ok: false, error: 'boom' })
  })

  it('채팅 실행 중이면 409, 동시 요청도 두 번째는 409', async () => {
    server = new BridgeServer({
      openSession: () => {
        throw new Error('이미 실행 중')
      },
      token: () => TOKEN
    })
    let port = await server.start(0)
    expect((await fetch(`http://127.0.0.1:${port}/health`, { headers: H })).status).toBe(409)
    await server.stop()
    const fs = fakeSession({ slowMs: 300 })
    server = new BridgeServer({ openSession: fs.make, token: () => TOKEN })
    port = await server.start(0)
    const a = fetch(`http://127.0.0.1:${port}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    await new Promise((r) => setTimeout(r, 50))
    const b = await fetch(`http://127.0.0.1:${port}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    expect(b.status).toBe(409)
    expect((await a).status).toBe(200)
  })

  it('제한 시간을 넘기면 504 로 끝내고, 도구 호출이 실제로 끝나면 세션을 닫는다', async () => {
    const fs = fakeSession({ slowMs: 300 })
    server = new BridgeServer({ openSession: fs.make, token: () => TOKEN, toolTimeoutMs: 100 })
    const port = await server.start(0)
    const r = await fetch(`http://127.0.0.1:${port}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    expect(r.status).toBe(504)
    // 504 응답 시점에는 도구 호출이 아직 도는 중이라 세션을 닫지 않는다
    expect(fs.disposed()).toBe(0)
    await new Promise((r2) => setTimeout(r2, 400))
    expect(fs.disposed()).toBe(1)
  })

  it('폰을 기다리는 긴 도구(phone_approve_payment)는 긴 제한 시간을 쓴다 — 일반 도구는 그대로 504', async () => {
    // 실기 2026-10-06: 폰 결제는 90초를 넘기기 일쑤라 504 → bridge_down 으로 결제창 탭이 닫혔다
    const fs = fakeSession({ slowMs: 300 })
    server = new BridgeServer({
      openSession: fs.make,
      token: () => TOKEN,
      toolTimeoutMs: 100,
      longToolTimeoutMs: 1000
    })
    const port = await server.start(0)
    const long = await fetch(`http://127.0.0.1:${port}/tool/phone_approve_payment`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    expect(long.status).toBe(200)
    const short = await fetch(`http://127.0.0.1:${port}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    expect(short.status).toBe(504)
  })

  it('도구 호출이 영영 안 끝나면 유예 뒤 강제로 세션을 닫고 busy 를 푼다 — 하네스가 죽은 뒤 문이 잠기지 않게', async () => {
    let disposed = 0
    const make = (onStep: (l: string, ok: boolean) => void): ToolSession => {
      void onStep
      return {
        names: () => ['get_page'],
        call: () => new Promise<string>(() => {}), // 절대 끝나지 않는 호출
        dispose: () => {
          disposed += 1
        }
      }
    }
    server = new BridgeServer({
      openSession: make,
      token: () => TOKEN,
      toolTimeoutMs: 50,
      hangGraceMs: 100
    })
    const port = await server.start(0)
    const r = await fetch(`http://127.0.0.1:${port}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    expect(r.status).toBe(504)
    expect((await fetch(`http://127.0.0.1:${port}/health`, { headers: H })).status).toBe(409)
    await new Promise((r2) => setTimeout(r2, 200))
    expect(disposed).toBe(1)
    expect((await fetch(`http://127.0.0.1:${port}/health`, { headers: H })).status).toBe(200)
  })

  it('제한 시간 뒤에도 도구 호출을 끝까지 지켜본 뒤 세션을 닫는다 — 그동안 새 요청은 409, 끝나면 다음 요청은 정상', async () => {
    let callCount = 0
    let disposed = 0
    const make = (onStep: (l: string, ok: boolean) => void): ToolSession => {
      void onStep
      const isFirst = callCount === 0
      callCount += 1
      return {
        names: () => ['get_page', 'click'],
        call: async (name: string) => {
          if (isFirst) await new Promise((r) => setTimeout(r, 300))
          return `${name} 결과`
        },
        dispose: () => {
          disposed += 1
        }
      }
    }
    server = new BridgeServer({ openSession: make, token: () => TOKEN, toolTimeoutMs: 100 })
    const port = await server.start(0)
    const r = await fetch(`http://127.0.0.1:${port}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    expect(r.status).toBe(504)
    // 도구 호출이 아직 끝나지 않았으니 새 요청은 409
    const r2 = await fetch(`http://127.0.0.1:${port}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    expect(r2.status).toBe(409)
    expect(disposed).toBe(0)
    await new Promise((r3) => setTimeout(r3, 400))
    expect(disposed).toBe(1)
    const r3 = await fetch(`http://127.0.0.1:${port}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: '{"args":{}}'
    })
    expect(r3.status).toBe(200)
  })

  it('본문이 1MB 를 넘으면 413', async () => {
    const base = await up()
    const big = JSON.stringify({ args: { x: 'a'.repeat(1024 * 1024) } })
    const r = await fetch(`${base}/tool/get_page`, {
      method: 'POST',
      headers: H,
      body: big
    })
    expect(r.status).toBe(413)
    expect(await r.json()).toEqual({ error: 'body too large' })
  })

  it('127.0.0.1 에만 바인딩한다', async () => {
    const base = await up()
    const port = Number(new URL(base).port)
    const addr = (server as unknown as { address: () => { address: string } }).address()
    expect(addr.address).toBe('127.0.0.1')
    expect(port).toBeGreaterThan(0)
  })
})
