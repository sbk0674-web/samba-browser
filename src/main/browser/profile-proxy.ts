/**
 * 프로필(파티션)별 프록시.
 *
 * 스니커덩크처럼 사무실 IP 를 막는 사이트는 그 사이트 전용 프로필에만 프록시를 건다(사용자 2026-09-28).
 * 설정은 userData/profile-proxies.json(저장소 밖) 또는 환경변수 SAMBA_PROFILE_PROXY_<프로필> 로 준다.
 *
 *   { "snkrdunk": { "proxyRules": "http=1.2.3.4:8080;https=1.2.3.4:8080", "proxyBypassRules": "<local>",
 *                   "username": "u", "password": "p" } }
 *   SAMBA_PROFILE_PROXY_SNKRDUNK=http://u:p@1.2.3.4:8080   (socks5://… 도 된다)
 *
 * 인증 프록시(407)는 app 'login' 이벤트에서 그 프록시 호스트일 때만 자격을 넘긴다. 비밀값은 로그에 남기지 않는다.
 */
import { app, type Session } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface ProfileProxy {
  proxyRules: string
  /** PAC 주소 — 있으면 proxyRules 대신 쓴다(특정 도메인만 프록시로 보낼 때. 예: ABC마트 전용 중계기 PAC) */
  pacScript?: string
  proxyBypassRules?: string
  username?: string
  password?: string
}

export type ProfileProxies = Record<string, ProfileProxy>

/** "http://u:p@host:port" · "socks5://host:port" → 프록시 설정(순수 함수). 못 읽으면 null */
export function parseProxyUrl(raw: string): ProfileProxy | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const u = new URL(text.includes('://') ? text : `http://${text}`)
    if (!u.hostname) return null
    const scheme = u.protocol.replace(':', '').toLowerCase()
    const hostPort = `${u.hostname}${u.port ? `:${u.port}` : ''}`
    // Chromium 프록시 규칙: 'http=' 접두어는 http 요청, 'https=' 는 https 요청. socks 는 스킴을 그대로 쓴다
    const rules =
      scheme === 'socks5' || scheme === 'socks4' || scheme === 'socks'
        ? `${scheme}://${hostPort}`
        : `http=${hostPort};https=${hostPort}`
    const out: ProfileProxy = { proxyRules: rules, proxyBypassRules: '<local>' }
    if (u.username) out.username = decodeURIComponent(u.username)
    if (u.password) out.password = decodeURIComponent(u.password)
    return out
  } catch {
    return null
  }
}

/** 파티션 이름('persist:ws1-snkrdunk')에서 프로필 이름을 뗀다 */
export function profileOfPartition(partition: string, prefix: string): string {
  return partition.startsWith(prefix) ? partition.slice(prefix.length) : partition
}

/** 파일 + 환경변수를 합친다. 환경변수가 파일보다 우선한다. 프로필 이름은 소문자로 맞춘다 */
export function loadProfileProxies(
  userData: string,
  env: NodeJS.ProcessEnv = process.env
): ProfileProxies {
  const out: ProfileProxies = {}
  const file = join(userData, 'profile-proxies.json')
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const [name, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue
        const v = value as Record<string, unknown>
        const pac = typeof v.pacScript === 'string' && v.pacScript.trim() ? v.pacScript.trim() : ''
        if (!pac && (typeof v.proxyRules !== 'string' || !v.proxyRules.trim())) continue
        out[name.toLowerCase()] = {
          proxyRules: typeof v.proxyRules === 'string' ? v.proxyRules : '',
          ...(pac ? { pacScript: pac } : {}),
          ...(typeof v.proxyBypassRules === 'string' ? { proxyBypassRules: v.proxyBypassRules } : {}),
          ...(typeof v.username === 'string' ? { username: v.username } : {}),
          ...(typeof v.password === 'string' ? { password: v.password } : {})
        }
      }
    } catch (e: unknown) {
      console.error('profile-proxies.json 을 읽지 못했습니다', e instanceof Error ? e.message : e)
    }
  }
  for (const [key, value] of Object.entries(env)) {
    const m = /^SAMBA_PROFILE_PROXY_(.+)$/.exec(key)
    if (!m || !value) continue
    const cfg = parseProxyUrl(value)
    if (cfg) out[m[1].toLowerCase()] = cfg
  }
  return out
}

/** 프록시 호스트(host:port) — 'login' 이벤트의 authInfo.host/port 와 대조한다 */
function proxyHosts(rules: string): Set<string> {
  const hosts = new Set<string>()
  for (const part of rules.split(/[;,]/)) {
    const m = /(?:^|=)\s*(?:[a-z0-9]+:\/\/)?([^\s/]+?)(?::(\d+))?\s*$/i.exec(part.trim())
    if (m) hosts.add(`${m[1].toLowerCase()}:${m[2] ?? ''}`)
  }
  return hosts
}

const authRegistered = new Set<string>()

/**
 * 프로필 세션에 프록시를 건다. 설정에 없는 프로필은 건드리지 않는다(직접 연결 그대로).
 * 같은 세션에 두 번 불려도 setProxy 는 멱등이다
 */
export function applyProfileProxy(ses: Session, profile: string, proxies: ProfileProxies): boolean {
  // 프로필 전용 설정이 없으면 '*'(모든 프로필 기본값)를 쓴다 — ABC마트가 집 IP 를 막아 ABC 도메인만 중계기로 보내는 PAC(2026-11-11)
  const cfg = proxies[profile.toLowerCase()] ?? proxies['*']
  if (!cfg) return false
  const config = cfg.pacScript
    ? { pacScript: cfg.pacScript }
    : { proxyRules: cfg.proxyRules, proxyBypassRules: cfg.proxyBypassRules ?? '<local>' }
  void ses
    .setProxy(config)
    .then(() => console.info(`프로필 프록시 적용: ${profile} → ${cfg.pacScript ?? cfg.proxyRules}`))
    .catch((e: unknown) => console.error(`프로필 프록시 실패: ${profile}`, e instanceof Error ? e.message : e))
  if (cfg.username !== undefined && !authRegistered.has(profile.toLowerCase())) {
    authRegistered.add(profile.toLowerCase())
    const hosts = proxyHosts(cfg.proxyRules)
    app.on('login', (event, _wc, _details, authInfo, callback) => {
      if (!authInfo.isProxy) return
      const key = `${String(authInfo.host).toLowerCase()}:${authInfo.port ?? ''}`
      const keyNoPort = `${String(authInfo.host).toLowerCase()}:`
      if (!hosts.has(key) && !hosts.has(keyNoPort)) return
      event.preventDefault()
      callback(cfg.username ?? '', cfg.password ?? '')
    })
  }
  return true
}
