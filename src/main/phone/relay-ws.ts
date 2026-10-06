// 인터넷 너머 폰 중계 — 삼바웨이브 API 의 WebSocket 브로커(/api/v1/samba/phone-relay)로 adb 바이트를 흘린다.
//
// 왜: adb 원격 서버(-H/-P)는 같은 LAN 에서만 닿는다. 두 PC 가 다른 네트워크면 둘 다 닿는 곳(삼바웨이브 API,
// Cloudflare 터널 뒤)이 바이트만 중계한다(사용자 2026-10-06 "설치 없이 되게끔"). 아무것도 설치하지 않는다.
//
// 폰 PC(host):  RelayHostSession — 브로커 /host 제어 소켓을 유지하고, open 요청마다 /data 소켓 ↔ 로컬 adb 서버 TCP(5037)를 잇는다
// 다른 PC(client): RelayClientProxy — 127.0.0.1 의 임시 포트로 TCP 를 받아 접속마다 /client 소켓 ↔ 그 TCP 를 잇는다.
//                 adb 는 `-H 127.0.0.1 -P <그 포트>` 로 그 포트에 말을 건다(createRelayingAdb)
// 등록 정보의 relayHost 는 'ws:<room>:<key>' — 방 열쇠는 계정 설정 동기화로만 다른 PC 에 전해진다

import { createServer, connect, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'

/** 전역 WebSocket(Node 22+) 가운데 우리가 쓰는 부분만 — 테스트가 가짜로 바꾼다 */
export interface MiniWs {
  binaryType: string
  readyState: number
  send(data: Uint8Array | string): void
  close(code?: number): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}
export type WsFactory = (url: string) => MiniWs

/** Node 전역 WebSocket 으로 연다(렌더러의 DOM WebSocket 과 같은 모양) */
export const defaultWsFactory: WsFactory = (url) => {
  const ctor = (globalThis as unknown as { WebSocket?: new (u: string) => MiniWs }).WebSocket
  if (!ctor) throw new Error('WebSocket is not available in this runtime')
  const ws = new ctor(url)
  ws.binaryType = 'arraybuffer'
  return ws
}

const WS_OPEN = 1

/** 방 id·열쇠 → 등록 정보에 싣는 relayHost 문자열 */
export function brokerHostOf(room: string, key: string): string {
  return `ws:${room}:${key}`
}

export function parseBrokerHost(value: string | null | undefined): { room: string; key: string } | null {
  const m = /^ws:([A-Za-z0-9_-]{6,64}):([A-Za-z0-9_-]{16,128})$/.exec((value ?? '').trim())
  return m ? { room: m[1], key: m[2] } : null
}

/** 새 방 id·열쇠(열쇠는 24바이트 난수) */
export function newRoom(): { room: string; key: string } {
  return { room: randomBytes(9).toString('hex'), key: randomBytes(24).toString('hex') }
}

function toBuffer(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return Buffer.from(data)
  return null
}

/** WebSocket 하나와 TCP 소켓 하나를 양방향으로 잇는다. 한쪽이 닫히면 다른 쪽도 닫는다 */
export function pipeWsToSocket(ws: MiniWs, socket: Socket, onEnd?: () => void): void {
  let ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    try {
      socket.destroy()
    } catch {
      // 이미 닫힘
    }
    try {
      ws.close()
    } catch {
      // 이미 닫힘
    }
    onEnd?.()
  }
  // WS 가 열리기 전에 TCP 가 먼저 보낼 수 있다 — 열릴 때까지 모아 둔다
  const queue: Buffer[] = []
  const flush = (): void => {
    for (const b of queue.splice(0)) ws.send(b)
  }
  ws.onmessage = (ev) => {
    const b = toBuffer(ev.data)
    if (b) socket.write(b)
  }
  ws.onclose = finish
  ws.onerror = finish
  socket.on('data', (chunk: Buffer) => {
    if (ws.readyState === WS_OPEN) ws.send(chunk)
    else queue.push(Buffer.from(chunk))
  })
  socket.on('close', finish)
  socket.on('error', finish)
  if (ws.readyState === WS_OPEN) flush()
  else {
    const prev = ws.onopen
    ws.onopen = (ev) => {
      prev?.(ev)
      flush()
    }
  }
}

export interface RelayHostSessionDeps {
  brokerUrl: string
  room: string
  key: string
  /** 이 PC 의 adb 서버 포트(기본 5037) */
  adbPort: number
  ws?: WsFactory
  connectTcp?: (port: number) => Socket
  log?: (line: string) => void
}

/** 폰 PC 쪽: 제어 소켓을 유지하고 open 요청마다 adb 서버와 잇는다. 끊기면 호출부(check 주기)가 다시 start 한다 */
export class RelayHostSession {
  private control: MiniWs | null = null
  private closed = false
  private readonly wsOf: WsFactory
  private readonly tcp: (port: number) => Socket
  private readonly log: (line: string) => void
  private dataCount = 0

  constructor(private readonly deps: RelayHostSessionDeps) {
    this.wsOf = deps.ws ?? defaultWsFactory
    this.tcp = deps.connectTcp ?? ((port) => connect({ host: '127.0.0.1', port }))
    this.log = deps.log ?? ((line) => console.info(line))
  }

  /** 제어 소켓이 살아 있는가(열림 또는 여는 중) */
  alive(): boolean {
    return this.control !== null && !this.closed
  }

  start(): void {
    if (this.control) return
    const { brokerUrl, room, key } = this.deps
    let ws: MiniWs
    try {
      ws = this.wsOf(`${brokerUrl}/host?room=${encodeURIComponent(room)}&key=${encodeURIComponent(key)}`)
    } catch (e: unknown) {
      this.log(`[phone-relay] 브로커 소켓을 못 만들었다: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    this.control = ws
    this.log(`[phone-relay] 브로커 연결 시도 — ${brokerUrl} 방 ${room.slice(0, 6)}…`)
    // 열리지 않은 채 오래 머물면 끊고 다음 점검에서 다시 붙는다
    const opened = { done: false }
    setTimeout(() => {
      if (!opened.done && this.control === ws) {
        this.log('[phone-relay] 브로커 연결 시간 초과 — 다시 시도')
        this.control = null
        try {
          ws.close()
        } catch {
          // 이미 닫힘
        }
      }
    }, 20_000).unref?.()
    ws.onopen = () => {
      opened.done = true
      this.log(`[phone-relay] 브로커 연결 — 방 ${room.slice(0, 6)}…`)
    }
    ws.onmessage = (ev) => {
      const b = toBuffer(ev.data)
      if (!b) return
      try {
        const msg = JSON.parse(b.toString()) as { type?: string; conn?: string }
        if (msg.type === 'open' && typeof msg.conn === 'string') this.openData(msg.conn)
      } catch {
        // 제어 소켓에 JSON 아닌 것이 오면 무시
      }
    }
    ws.onclose = () => {
      this.control = null
      this.log('[phone-relay] 브로커 연결 끊김 — 곧 다시 붙는다')
    }
    ws.onerror = (ev) => {
      const err = ev as { message?: unknown; error?: { message?: unknown } }
      const why = String(err?.message ?? err?.error?.message ?? '')
      if (why) this.log(`[phone-relay] 브로커 소켓 오류: ${why.slice(0, 120)}`)
    }
  }

  stop(): void {
    this.closed = true
    const c = this.control
    this.control = null
    try {
      c?.close()
    } catch {
      // 이미 닫힘
    }
  }

  /** 다른 PC 의 접속 하나: /data 소켓을 열어 로컬 adb 서버 TCP 와 잇는다 */
  private openData(conn: string): void {
    const { brokerUrl, room, key, adbPort } = this.deps
    const ws = this.wsOf(
      `${brokerUrl}/data?room=${encodeURIComponent(room)}&key=${encodeURIComponent(key)}&conn=${encodeURIComponent(conn)}`
    )
    const socket = this.tcp(adbPort)
    this.dataCount += 1
    pipeWsToSocket(ws, socket, () => {
      this.dataCount -= 1
    })
  }

  /** 지금 열린 데이터 통로 수(상태 표시·테스트) */
  connections(): number {
    return this.dataCount
  }
}

export interface RelayClientProxyDeps {
  brokerUrl: string
  room: string
  key: string
  ws?: WsFactory
  listen?: () => Server
  log?: (line: string) => void
}

/** 다른 PC 쪽: 127.0.0.1 임시 포트로 TCP 를 받아 접속마다 브로커 /client 소켓과 잇는다 */
export class RelayClientProxy {
  private server: Server | null = null
  private _port: number | null = null
  private readonly wsOf: WsFactory
  private readonly log: (line: string) => void

  constructor(private readonly deps: RelayClientProxyDeps) {
    this.wsOf = deps.ws ?? defaultWsFactory
    this.log = deps.log ?? ((line) => console.info(line))
  }

  /** 듣는 포트(아직 안 열렸으면 null) */
  port(): number | null {
    return this._port
  }

  start(): Promise<number> {
    if (this.server && this._port !== null) return Promise.resolve(this._port)
    const { brokerUrl, room, key } = this.deps
    const server = (this.deps.listen ?? createServer)()
    this.server = server
    server.on('connection', (socket: Socket) => {
      const ws = this.wsOf(`${brokerUrl}/client?room=${encodeURIComponent(room)}&key=${encodeURIComponent(key)}`)
      pipeWsToSocket(ws, socket)
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        this._port = port
        this.log(`[phone-relay] 중계 폰 입구 127.0.0.1:${port} (방 ${room.slice(0, 6)}…)`)
        resolve(port)
      })
    })
  }

  stop(): void {
    const s = this.server
    this.server = null
    this._port = null
    try {
      s?.close()
    } catch {
      // 이미 닫힘
    }
  }
}
