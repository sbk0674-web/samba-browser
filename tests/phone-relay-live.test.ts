// 실기 전용(RELAY_LIVE=1): 이 PC 의 설정에 있는 브로커·방 열쇠로 RelayClientProxy 를 열고 adb -H 로 devices 를 묻는다.
// 다른 PC 가 쓰는 길을 이 PC 에서 그대로 밟아 본다. 평소 테스트에서는 건너뛴다
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { RelayClientProxy, defaultWsFactory, type MiniWs } from '../src/main/phone/relay-ws'

const live = process.env.RELAY_LIVE === '1'

describe.skipIf(!live)('브로커 경유 adb(실기)', () => {
  it('RelayClientProxy 입구로 raw host:version 과 adb -H devices 가 답한다', async () => {
    const cfg = JSON.parse(
      readFileSync(join(process.env.APPDATA ?? '', 'SAMBA Browser', 'config.json'), 'utf8')
    ) as { phoneRelayRoom: string; phoneRelayBrokerUrl: string; adbPath?: string }
    const [room, key] = cfg.phoneRelayRoom.split(':')
    let n = 0
    const logged = (url: string): MiniWs => {
      const id = ++n
      const ws = defaultWsFactory(url)
      const origSend = ws.send.bind(ws)
      ws.send = (d) => { console.log(`ws${id} send ${typeof d === 'string' ? d.length : d.byteLength}b ${typeof d === 'string' ? d : Buffer.from(d).toString('latin1').slice(0, 40)}`); origSend(d) }
      const w = ws as MiniWs & { addEventListener?: (t: string, f: (e: { data?: unknown; code?: number }) => void) => void }
      w.addEventListener?.('open', () => console.log(`ws${id} open`))
      w.addEventListener?.('message', (e) => console.log(`ws${id} recv ${Buffer.from(e.data as ArrayBuffer).toString('latin1').slice(0, 40)}`))
      w.addEventListener?.('close', (e) => console.log(`ws${id} close ${e.code}`))
      return ws
    }
    const proxy = new RelayClientProxy({ brokerUrl: cfg.phoneRelayBrokerUrl, room, key, ws: logged, log: (l) => console.log(l) })
    const port = await proxy.start()
    const raw = await new Promise<string>((resolve) => {
      const s = connect({ host: '127.0.0.1', port }, () => s.write('000chost:version'))
      s.on('data', (d: Buffer) => { resolve(d.toString()); s.destroy() })
      s.on('error', (e) => resolve('ERR ' + e.message))
      setTimeout(() => resolve('raw timeout'), 15000)
    })
    console.log('raw:', raw)
    const adb = cfg.adbPath || join(process.env.USERPROFILE ?? '', 'Downloads', 'pt', 'platform-tools', 'adb.exe')
    // spawnSync 는 이벤트 루프를 막아 입구가 접속을 못 받는다 — 비동기로 돈다
    const r = await new Promise<{ stdout: string; stderr: string; error?: string }>((resolve) => {
      const p = spawn(adb, ['-H', '127.0.0.1', '-P', String(port), 'devices', '-l'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      p.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      p.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      p.on('exit', () => resolve({ stdout, stderr }))
      setTimeout(() => { p.kill(); resolve({ stdout, stderr, error: 'timeout' }) }, 20000)
    })
    console.log('adb:', r.stdout, r.stderr, r.error)
    proxy.stop()
    expect(raw).toMatch(/OKAY/)
    expect(r.stdout).toMatch(/device/)
  }, 60000)
})
