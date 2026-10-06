// 인터넷 폰 중계(relay-ws.ts) — 가짜 브로커로 폰 PC(host)와 다른 PC(client)를 맞붙여 바이트가 양방향으로 흐르는지 본다
import { describe, it, expect } from 'vitest'
import { createServer, connect, type Socket } from 'node:net'
import {
  brokerHostOf,
  parseBrokerHost,
  newRoom,
  RelayClientProxy,
  RelayHostSession,
  type MiniWs,
  type WsFactory
} from '../src/main/phone/relay-ws'

/** 브로커를 흉내 내는 가짜 WebSocket — /host 는 제어, /client ↔ /data 를 쌍으로 잇는다 */
class FakeWs implements MiniWs {
  binaryType = 'blob'
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  peer: FakeWs | null = null
  sent: unknown[] = []
  constructor(readonly url: string) {}
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  send(data: Uint8Array | string): void {
    this.sent.push(data)
    const p = this.peer
    if (p) queueMicrotask(() => p.onmessage?.({ data: typeof data === 'string' ? data : new Uint8Array(data).buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({})
    const p = this.peer
    this.peer = null
    p?.close()
  }
}

class FakeBroker {
  host: FakeWs | null = null
  pendingClients = new Map<string, FakeWs>()
  conns = 0
  readonly factory: WsFactory = (url) => {
    const ws = new FakeWs(url)
    const u = new URL(url)
    const path = u.pathname.split('/').pop()
    if (path === 'host') {
      this.host = ws
      queueMicrotask(() => ws.open())
    } else if (path === 'client') {
      const conn = `c${++this.conns}`
      this.pendingClients.set(conn, ws)
      queueMicrotask(() => {
        ws.open()
        this.host?.onmessage?.({ data: JSON.stringify({ type: 'open', conn }) })
      })
    } else if (path === 'data') {
      const conn = u.searchParams.get('conn') ?? ''
      const client = this.pendingClients.get(conn)
      this.pendingClients.delete(conn)
      if (client) {
        ws.peer = client
        client.peer = ws
      }
      queueMicrotask(() => ws.open())
    }
    return ws
  }
}

function listenEcho(): Promise<{ port: number; close: () => void; seen: Buffer[] }> {
  const seen: Buffer[] = []
  const server = createServer((s: Socket) => {
    s.on('data', (d: Buffer) => {
      seen.push(d)
      s.write(Buffer.concat([Buffer.from('echo:'), d]))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close(), seen })
    })
  })
}

describe('방 열쇠 문자열', () => {
  it('ws:room:key 꼴만 받는다', () => {
    const r = newRoom()
    expect(parseBrokerHost(brokerHostOf(r.room, r.key))).toEqual(r)
    expect(parseBrokerHost('192.168.0.7:5037')).toBeNull()
    expect(parseBrokerHost('ws:short:key')).toBeNull()
  })
})

describe('host ↔ broker ↔ client 바이트 중계', () => {
  it('다른 PC 의 TCP 접속이 폰 PC 의 adb 서버(에코)에 닿고 답이 돌아온다', async () => {
    const adb = await listenEcho()
    const broker = new FakeBroker()
    const room = newRoom()
    const host = new RelayHostSession({ brokerUrl: 'wss://b/api/v1/samba/phone-relay', ...room, adbPort: adb.port, ws: broker.factory, log: () => {} })
    host.start()
    await new Promise((r) => setTimeout(r, 10))
    expect(host.alive()).toBe(true)

    const proxy = new RelayClientProxy({ brokerUrl: 'wss://b/api/v1/samba/phone-relay', ...room, ws: broker.factory, log: () => {} })
    const port = await proxy.start()
    expect(port).toBeGreaterThan(0)

    const got = await new Promise<string>((resolve, reject) => {
      const s = connect({ host: '127.0.0.1', port }, () => s.write('host:transport:R5CR30LFATY'))
      s.on('data', (d: Buffer) => {
        resolve(d.toString())
        s.destroy()
      })
      s.on('error', reject)
      setTimeout(() => reject(new Error('timeout')), 3000)
    })
    expect(got).toBe('echo:host:transport:R5CR30LFATY')
    expect(adb.seen.map((b) => b.toString())).toEqual(['host:transport:R5CR30LFATY'])

    proxy.stop()
    host.stop()
    adb.close()
    expect(host.alive()).toBe(false)
  })
})
