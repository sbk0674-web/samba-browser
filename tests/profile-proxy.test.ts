import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadProfileProxies, parseProxyUrl, profileOfPartition } from '../src/main/browser/profile-proxy'

describe('프로필별 프록시 설정', () => {
  it('http 주소는 http=·https= 규칙으로, 자격은 따로 뗀다', () => {
    expect(parseProxyUrl('http://u:p%40w@1.2.3.4:8080')).toEqual({
      proxyRules: 'http=1.2.3.4:8080;https=1.2.3.4:8080',
      proxyBypassRules: '<local>',
      username: 'u',
      password: 'p@w'
    })
  })

  it('socks5 는 스킴을 그대로 쓰고, 스킴이 없으면 http 로 본다', () => {
    expect(parseProxyUrl('socks5://127.0.0.1:1080')?.proxyRules).toBe('socks5://127.0.0.1:1080')
    expect(parseProxyUrl('127.0.0.1:8899')?.proxyRules).toBe('http=127.0.0.1:8899;https=127.0.0.1:8899')
    expect(parseProxyUrl('')).toBeNull()
  })

  it('파티션 이름에서 접두어를 떼 프로필을 얻는다', () => {
    expect(profileOfPartition('persist:ws1-snkrdunk', 'persist:ws1-')).toBe('snkrdunk')
    expect(profileOfPartition('persist:other', 'persist:ws1-')).toBe('persist:other')
  })

  it('환경변수 SAMBA_PROFILE_PROXY_<프로필> 이 파일보다 우선하고 프로필 이름은 소문자로 맞춘다', () => {
    const out = loadProfileProxies('C:/nonexistent-dir', {
      SAMBA_PROFILE_PROXY_SNKRDUNK: 'http://127.0.0.1:8899'
    })
    expect(out.snkrdunk?.proxyRules).toBe('http=127.0.0.1:8899;https=127.0.0.1:8899')
    expect(Object.keys(out)).toEqual(['snkrdunk'])
  })

  it('파일의 pacScript 항목(proxyRules 없이)도 읽고, "*" 는 모든 프로필 기본값으로 남는다(ABC마트 PAC 2026-11-11)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-'))
    writeFileSync(
      join(dir, 'profile-proxies.json'),
      JSON.stringify({ '*': { pacScript: 'http://127.0.0.1:18113/proxy.pac' }, snkrdunk: { proxyRules: 'http=1.2.3.4:80' } })
    )
    const out = loadProfileProxies(dir, {})
    expect(out['*']?.pacScript).toBe('http://127.0.0.1:18113/proxy.pac')
    expect(out.snkrdunk?.proxyRules).toBe('http=1.2.3.4:80')
    expect(out.snkrdunk?.pacScript).toBeUndefined()
  })
})
