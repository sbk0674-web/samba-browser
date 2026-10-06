import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadFallbackTokens,
  parseTokenList,
  tokensFromEnvText
} from '../src/main/agent/fallback-tokens'
import {
  advanceSubscriptionFallback,
  buildQueryOptions,
  setSubscriptionFallbackTokens,
  subscriptionFallbackIndex
} from '../src/main/agent/provider'

describe('예비 계정 토큰 읽기', () => {
  it('쉼표 목록을 다듬는다', () => {
    expect(parseTokenList(' a, "b",,c ')).toEqual(['a', 'b', 'c'])
  })

  it('.env 의 마지막 줄을 쓴다', () => {
    expect(
      tokensFromEnvText('X=1\nSAMBA_CLAUDE_OAUTH_TOKENS=a\r\nSAMBA_CLAUDE_OAUTH_TOKENS=b,c\n')
    ).toEqual(['b', 'c'])
  })

  it('환경변수가 파일보다 우선하고, 없으면 samba-agent/.env 를 읽는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'fbt-'))
    mkdirSync(join(root, 'samba-agent'))
    writeFileSync(join(root, 'samba-agent', '.env'), 'SAMBA_CLAUDE_OAUTH_TOKENS=f1,f2\n')
    expect(loadFallbackTokens([root], {})).toEqual(['f1', 'f2'])
    expect(loadFallbackTokens([root], { SAMBA_CLAUDE_OAUTH_TOKENS: 'e1' })).toEqual(['e1'])
    expect(loadFallbackTokens([join(root, 'none')], {})).toEqual([])
  })
})

describe('구독 예비 계정 전환', () => {
  beforeEach(() => setSubscriptionFallbackTokens(() => ['t1', 't2']))

  it('처음엔 PC 로그인(토큰 없음), 넘길 때마다 다음 토큰, 다 쓰면 false', () => {
    const sub = { mode: 'claude_subscription' } as const
    expect(subscriptionFallbackIndex()).toBe(0)
    expect(advanceSubscriptionFallback(sub)).toBe(true)
    expect(subscriptionFallbackIndex()).toBe(1)
    expect(advanceSubscriptionFallback(sub)).toBe(true)
    expect(advanceSubscriptionFallback(sub)).toBe(false)
    expect(subscriptionFallbackIndex()).toBe(2)
  })

  it('API 키 경로에서는 넘기지 않는다', () => {
    expect(advanceSubscriptionFallback({ mode: 'api_key' })).toBe(false)
    expect(subscriptionFallbackIndex()).toBe(0)
  })

  it('buildQueryOptions 는 넘겨준 env 를 그대로 싣는다', () => {
    const opts = buildQueryOptions({ prompt: 'p' } as never, { CLAUDE_CODE_OAUTH_TOKEN: 'x' })
    expect((opts as { env?: Record<string, string> }).env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('x')
  })
})
