/**
 * Claude 구독 예비 계정 토큰 읽기.
 *
 * 하네스(samba-agent/.env 의 SAMBA_CLAUDE_OAUTH_TOKENS)와 같은 토큰을 쓴다 — 등록은
 * samba-agent/add-claude-token.ps1 한 곳에서 한다. 환경변수가 있으면 그것이 우선이다.
 * 토큰 값은 로그에 남기지 않는다.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const KEY = 'SAMBA_CLAUDE_OAUTH_TOKENS'

/** "a, b,,c" → ['a','b','c'] (순수 함수) */
export function parseTokenList(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

/** .env 본문에서 마지막 SAMBA_CLAUDE_OAUTH_TOKENS= 줄의 토큰 목록(순수 함수) */
export function tokensFromEnvText(text: string): string[] {
  let found: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(`${KEY}=`)) found = parseTokenList(line.slice(KEY.length + 1))
  }
  return found
}

/** 환경변수 → 저장소 안 samba-agent/.env 순서로 찾는다. 없으면 빈 목록 */
export function loadFallbackTokens(
  roots: string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const fromEnv = env[KEY]
  if (fromEnv && fromEnv.trim()) return parseTokenList(fromEnv)
  for (const root of roots) {
    const file = join(root, 'samba-agent', '.env')
    if (!existsSync(file)) continue
    try {
      const tokens = tokensFromEnvText(readFileSync(file, 'utf8'))
      if (tokens.length > 0) return tokens
    } catch (e: unknown) {
      console.error('예비 계정 토큰을 읽지 못했습니다', e instanceof Error ? e.message : e)
    }
  }
  return []
}
