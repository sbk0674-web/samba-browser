// 폰 중계 — USB 로 이 PC 에 붙은 폰을 같은 계정의 다른 PC 가 쓰게 한다(사용자 2026-10-06 "중계기능구현해").
//
// adb 자체의 원격 서버 기능을 쓴다. 중계 PC 는 adb 서버를 모든 인터페이스에 연다(`adb -a -P 5037 nodaemon server`)
// 그리고 폰 등록 정보(phoneRegistry, 계정 설정으로 동기화)에 자기 LAN 주소를 relayHost 로 싣는다. 다른 PC 는
// 그 폰이 로컬에 안 붙어 있으면 모든 adb 명령 앞에 `-H <host> -P <port>` 를 붙여 중계 PC 의 adb 서버로 보낸다 —
// 화면 읽기·탭·screenrecord 가 전부 같은 길이라 결제 승인도 그대로 된다.
//
// 한계: 같은 LAN(또는 VPN)에 있어야 한다. 중계 PC 의 방화벽에서 adb.exe 의 TCP 5037 수신을 허용해야 한다.
// 전부 순수 함수 + 작은 래퍼라 폰 없이 테스트한다

import { networkInterfaces } from 'node:os'
import type { PhoneRegistryEntry } from '../../shared/phone-registry'
import type { Settings } from '../../shared/settings'
import type { AdbRunner, ProcessSpawner } from './process'
import {
  brokerHostOf,
  newRoom,
  parseBrokerHost,
  RelayClientProxy,
  RelayHostSession,
  type WsFactory
} from './relay-ws'

/** 중계 PC 의 adb 서버 포트(adb 기본값). 바꾸면 중계 PC 의 로컬 명령도 같은 포트를 써야 한다 */
export const RELAY_PORT = 5037

const HOST_RE = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/

export interface RelayHost {
  host: string
  port: number
}

/** 'ip:port' → {host, port}. 꼴이 아니면 null */
export function parseRelayHost(value: string | null | undefined): RelayHost | null {
  const m = HOST_RE.exec((value ?? '').trim())
  if (!m) return null
  const port = Number(m[2])
  if (!(port > 0 && port < 65536)) return null
  return { host: m[1], port }
}

/** `adb -a -P <port> nodaemon server` — 모든 인터페이스에서 받는 adb 서버(중계 PC 에서 띄운다) */
export function relayServerArgs(port: number = RELAY_PORT): string[] {
  return ['-a', '-P', String(port), 'nodaemon', 'server']
}

/** adb 명령을 중계 PC 의 서버로 보내는 인자: `-H host -P port` 를 맨 앞에 붙인다 */
export function relayArgs(target: RelayHost, args: readonly string[]): string[] {
  return ['-H', target.host, '-P', String(target.port), ...args]
}

/** adb 인자에서 `-s <serial>` 의 시리얼. 없으면 null */
export function serialOfArgs(args: readonly string[]): string | null {
  const i = args.indexOf('-s')
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

/**
 * 네트워크 인터페이스 목록에서 LAN IPv4 하나를 고른다(내부 루프백·APIPA 제외). 없으면 null.
 * os.networkInterfaces() 의 결과를 그대로 받는다
 */
export function pickLanAddress(
  interfaces: Record<string, Array<{ family: string | number; address: string; internal: boolean }> | undefined>
): string | null {
  const candidates: string[] = []
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      const v4 = i.family === 'IPv4' || i.family === 4
      if (!v4 || i.internal || i.address.startsWith('169.254.')) continue
      candidates.push(i.address)
    }
  }
  // 사설 대역(192.168 → 10 → 172.16~31)을 앞에 둔다 — 가상 어댑터(VPN·WSL)의 주소보다 집·사무실 LAN 이 먼저
  const score = (a: string): number =>
    a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3
  candidates.sort((a, b) => score(a) - score(b))
  return candidates[0] ?? null
}

/**
 * 등록 정보에서 "다른 PC 가 중계하는 폰" 의 시리얼 → 중계 주소.
 * 이 PC 에 지금 붙어 있는 폰(localOnline)과 이 PC 자신이 중계하는 주소(ownHost)는 뺀다
 */
export function relayTargets(
  registry: readonly PhoneRegistryEntry[],
  localOnline: ReadonlySet<string>,
  ownHost: string | null
): Map<string, RelayHost> {
  const out = new Map<string, RelayHost>()
  for (const e of registry) {
    const target = parseRelayHost(e.relayHost)
    if (!target || localOnline.has(e.serial)) continue
    if (ownHost && e.relayHost === ownHost) continue
    out.set(e.serial, target)
  }
  return out
}

/** 중계 주소들(중복 제거, 'ip:port' 문자열) */
export function relayHostsOf(targets: ReadonlyMap<string, RelayHost>): RelayHost[] {
  const seen = new Set<string>()
  const out: RelayHost[] = []
  for (const t of targets.values()) {
    const key = `${t.host}:${t.port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * `-s <serial>` 이 중계 폰이면 인자 앞에 `-H/-P` 를 붙여 중계 PC 의 adb 서버로 보내는 러너.
 * 시리얼 없는 명령(devices·kill-server 등)과 로컬 폰은 그대로 간다
 */
export function createRelayingAdb(
  inner: AdbRunner,
  resolve: (serial: string) => RelayHost | null
): AdbRunner {
  const route = (args: string[]): string[] => {
    const serial = serialOfArgs(args)
    const target = serial ? resolve(serial) : null
    return target ? relayArgs(target, args) : args
  }
  return {
    run: (args, timeoutMs) => inner.run(route(args), timeoutMs),
    runBinary: (args, timeoutMs) => inner.runBinary(route(args), timeoutMs),
    stream: (args, onData, onEnd) => inner.stream(route(args), onData, onEnd)
  }
}

// --- 조립부: 중계 서버 켜기/끄기 + 등록 정보에 실을 주소 + 다른 PC 폰의 경로 -----------------------------

/** 중계 상태 점검 주기(설정 토글은 IPC 로 들어오므로 폴링으로 따라간다) */
export const RELAY_CHECK_MS = 10_000

export interface PhoneRelayDeps {
  adb: AdbRunner
  /** adb 서버를 띄우는 실행기(`adb -a -P port nodaemon server` 는 끝나지 않는 프로세스다) */
  spawn: ProcessSpawner
  settings: () => Pick<Settings, 'phoneRelayEnabled' | 'phoneRegistry' | 'phoneRelayBrokerUrl' | 'phoneRelayRoom'>
  /** 방 열쇠('room:key')를 설정에 남긴다 — 앱을 다시 켜도 같은 방을 쓴다 */
  saveRoom?: (value: string) => void
  /** 이 PC 에 지금 붙어 있는(온라인·중계 아님) 폰의 시리얼 */
  localOnline: () => ReadonlySet<string>
  /** 브로커 WebSocket(테스트에서 가짜로) */
  ws?: WsFactory
  interfaces?: () => Parameters<typeof pickLanAddress>[0]
  port?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  log?: (line: string) => void
}

export interface PhoneRelay {
  start(): void
  stop(): void
  /** 중계 서버가 이 PC 에서 돌고 있는가 */
  serving(): boolean
  /** 이 PC 가 중계 중이면 등록 정보에 실을 {host, connected}, 아니면 null */
  published(): { host: string; connected: readonly string[] } | null
  /** 이 시리얼이 다른 PC 가 중계하는 폰이면 그 adb 서버 주소 */
  targetOf(serial: string): RelayHost | null
  /** 다른 PC 들의 중계 서버 주소(폰 목록 갱신이 여기도 묻는다) */
  hosts(): RelayHost[]
}

export function createPhoneRelay(deps: PhoneRelayDeps): PhoneRelay {
  const port = deps.port ?? RELAY_PORT
  const log = deps.log ?? ((line: string): void => console.info(line))
  const setIv = deps.setInterval ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
  const clearIv = deps.clearInterval ?? ((h: unknown): void => clearInterval(h as NodeJS.Timeout))
  const ifaces = deps.interfaces ?? ((): Parameters<typeof pickLanAddress>[0] => networkInterfaces())
  let handle: unknown = null
  let cancelServer: (() => void) | null = null
  let starting = false
  // 인터넷 중계(브로커): 폰 PC 의 제어 세션, 다른 PC 쪽 방별 입구
  let hostSession: RelayHostSession | null = null
  const proxies = new Map<string, RelayClientProxy>()

  const brokerUrl = (): string => deps.settings().phoneRelayBrokerUrl.trim().replace(/\/+$/, '')
  const myRoom = (): { room: string; key: string } | null => {
    const raw = deps.settings().phoneRelayRoom
    const i = raw.indexOf(':')
    if (i > 0) return { room: raw.slice(0, i), key: raw.slice(i + 1) }
    return null
  }

  const ownHost = (): string | null => {
    const ip = pickLanAddress(ifaces())
    return ip ? `${ip}:${port}` : null
  }

  const startServer = async (): Promise<void> => {
    if (cancelServer || starting) return
    starting = true
    try {
      // 로컬 전용으로 떠 있던 서버를 내리고 모든 인터페이스에서 받는 서버로 다시 띄운다
      await deps.adb.run(['kill-server'], 10_000)
      cancelServer = deps.spawn(
        relayServerArgs(port),
        () => {},
        (code) => {
          cancelServer = null
          log(`[phone-relay] adb 중계 서버 종료(code ${String(code)})`)
        }
      )
      log(`[phone-relay] adb 중계 서버 시작 — ${ownHost() ?? '(LAN 주소 없음)'} (방화벽에서 TCP ${port} 수신 허용 필요)`)
    } catch (e: unknown) {
      log(`[phone-relay] adb 중계 서버 시작 실패: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      starting = false
    }
  }

  const stopServer = (): void => {
    if (!cancelServer) return
    try {
      cancelServer()
    } catch {
      // 이미 죽었으면 그만
    }
    cancelServer = null
    log('[phone-relay] adb 중계 서버 끔')
  }

  const checkBroker = (): void => {
    const url = brokerUrl()
    const enabled = deps.settings().phoneRelayEnabled
    // 폰 PC: 브로커가 있으면 방 열쇠를 만들어 두고 제어 세션을 유지한다(끊기면 다음 점검에서 다시 붙는다)
    if (enabled && url) {
      let r = myRoom()
      if (!r) {
        r = newRoom()
        deps.saveRoom?.(`${r.room}:${r.key}`)
      }
      if (!hostSession || !hostSession.alive()) {
        hostSession?.stop()
        hostSession = new RelayHostSession({
          brokerUrl: url,
          room: r.room,
          key: r.key,
          adbPort: port,
          ...(deps.ws ? { ws: deps.ws } : {}),
          log
        })
        hostSession.start()
      }
    } else if (hostSession) {
      hostSession.stop()
      hostSession = null
    }
    // 다른 PC: 등록 정보의 'ws:' 중계 폰마다 로컬 입구를 연다(내 방은 제외)
    const wanted = new Set<string>()
    if (url) {
      for (const e of deps.settings().phoneRegistry) {
        const b = parseBrokerHost(e.relayHost)
        if (!b || deps.localOnline().has(e.serial)) continue
        const mine = myRoom()
        if (mine && mine.room === b.room) continue
        wanted.add(e.relayHost as string)
        if (!proxies.has(e.relayHost as string)) {
          const p = new RelayClientProxy({ brokerUrl: url, room: b.room, key: b.key, ...(deps.ws ? { ws: deps.ws } : {}), log })
          proxies.set(e.relayHost as string, p)
          p.start().catch((e2: unknown) =>
            log(`[phone-relay] 중계 입구 열기 실패: ${e2 instanceof Error ? e2.message : String(e2)}`)
          )
        }
      }
    }
    for (const [k, p] of proxies) {
      if (!wanted.has(k)) {
        p.stop()
        proxies.delete(k)
      }
    }
  }

  const check = (): void => {
    const enabled = deps.settings().phoneRelayEnabled
    if (enabled && !cancelServer) void startServer()
    else if (!enabled && cancelServer) stopServer()
    checkBroker()
  }

  const targets = (): Map<string, RelayHost> => {
    const out = relayTargets(deps.settings().phoneRegistry, deps.localOnline(), ownHost())
    // 브로커 중계 폰: 로컬 입구 포트가 열려 있으면 127.0.0.1:<포트>
    for (const e of deps.settings().phoneRegistry) {
      if (!parseBrokerHost(e.relayHost) || deps.localOnline().has(e.serial)) continue
      const p = proxies.get(e.relayHost as string)
      const prt = p?.port()
      if (prt) out.set(e.serial, { host: '127.0.0.1', port: prt })
    }
    return out
  }

  return {
    start() {
      if (handle) return
      check()
      handle = setIv(check, RELAY_CHECK_MS)
      ;(handle as { unref?: () => void })?.unref?.()
    },
    stop() {
      if (handle) clearIv(handle)
      handle = null
      stopServer()
      hostSession?.stop()
      hostSession = null
      for (const p of proxies.values()) p.stop()
      proxies.clear()
    },
    serving: () => cancelServer !== null,
    published() {
      if (!deps.settings().phoneRelayEnabled) return null
      // 브로커가 있으면 방 열쇠를 싣는다(인터넷 너머) — 없으면 LAN 주소(adb 원격 서버가 떠 있을 때만)
      const r = brokerUrl() ? myRoom() : null
      if (r) return { host: brokerHostOf(r.room, r.key), connected: [...deps.localOnline()] }
      if (!cancelServer) return null
      const host = ownHost()
      return host ? { host, connected: [...deps.localOnline()] } : null
    },
    targetOf: (serial) => targets().get(serial) ?? null,
    hosts: () => relayHostsOf(targets())
  }
}
