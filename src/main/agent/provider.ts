import {
  query,
  startup,
  type Options,
  type Query,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentImage } from '../../shared/agent-image'
import { MAX_TOOL_CALLS, type AgentEffort } from '../../shared/settings'
import type { AgentAuth } from '../ai/auth-route'
import { runCodex, type CodexEvent, type CodexInput } from './provider-codex'

export interface ProviderInput {
  prompt: string
  // 지시문과 함께 보낼 이미지(AI 창에 붙여 넣은 스크린샷). 없으면 문자열 프롬프트 그대로
  images?: AgentImage[]
  systemPrompt: string
  model: string
  mcpServers: Options['mcpServers']
  allowedTools: string[]
  abort: AbortController
  // 추론 강도. SDK Options.effort('low'|'medium'|'high'|…)와 값이 같다
  effort?: AgentEffort
  /** 이어받을 SDK 세션 id(같은 대화의 앞선 실행). 없으면 새 세션 */
  resume?: string
}

// 사용자가 설정에 넣어 둔 내 API 키를 읽는 함수. 메인 프로세스가 주입한다.
// **`ApiKeyStore.get`(평문 키)을 호출하는 곳은 이 모듈 하나뿐이다.** 값은 SDK 하위 프로세스의
// 환경변수로만 흘러가고, 로그·IPC·렌더러 어디에도 나가지 않는다
let apiKeyResolver: (() => string | null) | null = null

export function setApiKeyResolver(fn: (() => string | null) | null): void {
  apiKeyResolver = fn
}

// 이번 실행에 쓸 인증 경로를 알려 주는 함수(메인 프로세스가 주입한다).
// 주입되지 않은 테스트 환경에서는 예전처럼 Claude 구독 경로로 본다
let authResolver: (() => AgentAuth) | null = null

export function setAuthResolver(fn: (() => AgentAuth) | null): void {
  authResolver = fn
}

/** 이번 실행의 인증 경로. 조회에 실패하면 "연결 필요" 로 본다(몰래 구독을 쓰지 않는다) */
export function currentAuth(): AgentAuth {
  if (!authResolver) return { mode: 'claude_subscription' }
  try {
    return authResolver()
  } catch {
    return { mode: 'none', reason: 'not_connected' }
  }
}

// 구독 예비 계정: 이 PC 의 Claude 로그인이 막히면(만료·차단·한도) 다른 계정의 OAuth 토큰
// (`claude setup-token`)으로 넘어간다. 0 = PC 로그인, 1.. = 예비 토큰 순서. 토큰 값은 로그에 남기지 않는다
let fallbackTokens: () => string[] = () => []
let fallbackIndex = 0

export function setSubscriptionFallbackTokens(fn: (() => string[]) | null): void {
  fallbackTokens = fn ?? (() => [])
  fallbackIndex = 0
}

/** 구독 경로에서 다음 예비 계정으로 넘긴다. 넘길 계정이 없거나 구독 경로가 아니면 false */
export function advanceSubscriptionFallback(auth: AgentAuth = currentAuth()): boolean {
  if (auth.mode !== 'claude_subscription') return false
  let count = 0
  try {
    count = fallbackTokens().length
  } catch {
    count = 0
  }
  if (fallbackIndex >= count) return false
  fallbackIndex += 1
  return true
}

/** 지금 쓰는 구독 계정 순번(0 = PC 로그인) — 화면 안내용 */
export function subscriptionFallbackIndex(): number {
  return fallbackIndex
}

// 인증 경로가 없을 때 실행부가 그대로 실패 사유로 쓰는 표식(UI 는 "연결 필요" 안내로 바꾼다)
export const NOT_CONNECTED_ERROR = 'auth:not_connected'

// 내 API 키를 쓸 때만 환경을 교체한다(교체 시 process.env 를 통째로 펼쳐 PATH 등을 유지)
function resolveEnv(auth: AgentAuth): Record<string, string | undefined> | undefined {
  // 구독 경로에서는 API 키를 꺼내지 않는다 — 예비 계정으로 넘어간 뒤면 그 토큰만 넣는다
  if (auth.mode === 'claude_subscription' && fallbackIndex > 0) {
    let token: string | undefined
    try {
      token = fallbackTokens()[fallbackIndex - 1]
    } catch {
      token = undefined
    }
    return token ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } : undefined
  }
  if (auth.mode !== 'api_key') return undefined
  let key: string | null = null
  try {
    key = apiKeyResolver?.() ?? null
  } catch {
    // 키 조회 실패는 값 없음으로 본다(값은 로그에 남기지 않는다)
    key = null
  }
  if (!key) return undefined
  return { ...process.env, ANTHROPIC_API_KEY: key }
}

/**
 * SDK 에 넘길 옵션을 만든다(순수 함수 — 단위 테스트에서 그대로 확인한다).
 * effort 는 SDK Options 가 지원하는 정식 옵션이라 그대로 넘기고,
 * 같은 내용을 시스템 프롬프트 한 줄로도 남겨 둔다(prompt.ts)
 */
export function buildQueryOptions(
  input: ProviderInput,
  // 연결 경로에 따른 환경(내 API 키 경로만 ANTHROPIC_API_KEY 를 담는다). 생략하면 현재 연결 기준
  env: Record<string, string | undefined> | undefined = resolveEnv(currentAuth())
): Options {
  return {
    env,
    systemPrompt: input.systemPrompt,
    model: input.model,
    effort: input.effort ?? 'medium',
    mcpServers: input.mcpServers,
    allowedTools: input.allowedTools,
    // 내장 도구 전체 비활성화. disallowedTools 는 이중 안전장치
    tools: [],
    disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'WebSearch', 'Glob', 'Grep'],
    // samba 서버 외의 MCP(사용자 설정·계정 커넥터·플러그인)를 불러오지 않음
    strictMcpConfig: true,
    // 사용자/프로젝트 설정(훅·CLAUDE.md)을 상속하지 않음
    settingSources: [],
    permissionMode: 'default',
    // 실제 상한은 도구 호출 수(설정 maxToolCalls, 러너의 counter)다. 턴 상한이 그보다 먼저 걸리면
    // 도구를 95회밖에 안 썼는데 "maximum number of turns (60)" 로 죽는다(실기: 결제 키패드 앞에서 중단).
    // 도구 상한 최대값보다 넉넉히 잡아, 멈추는 기준을 한 곳으로 모은다
    maxTurns: MAX_TOOL_CALLS + 50,
    abortController: input.abort,
    // 같은 대화의 앞선 실행을 이어받는다 — 앞선 지시·도구 결과를 기억한 채로 돈다
    ...(input.resume === undefined ? {} : { resume: input.resume })
  }
}

// Claude Agent SDK 호출. Claude Code 로그인 또는 ANTHROPIC_API_KEY 자동 사용

/** 이번 실행을 어느 백엔드로 돌릴지. 'none' 이면 실행하지 않고 "연결 필요" 안내로 끝낸다 */
export function agentBackend(auth: AgentAuth = currentAuth()): 'claude' | 'codex' | 'none' {
  if (auth.mode === 'codex_subscription') return 'codex'
  if (auth.mode === 'none') return 'none'
  return 'claude'
}

/** Codex CLI 백엔드 실행(도구 없이 텍스트 응답 경로). 사건은 정규화된 CodexEvent 로 온다 */
export function runCodexQuery(input: CodexInput): AsyncGenerator<CodexEvent> {
  return runCodex(input)
}

/** 도구 없는 "프롬프트 한 덩어리 → 텍스트 한 덩어리" 1회 호출 입력. 번역 등이 쓴다 */
export interface AskTextInput {
  model: string
  system: string
  prompt: string
  abort: AbortController
}

/**
 * 연결된 백엔드(Claude 구독/내 API 키 vs Codex 구독)에 맞춰 알아서 갈아 타는 얇은 공용 호출.
 * 도구를 하나도 붙이지 않는 순수 텍스트 응답 경로라 번역처럼 "프롬프트 → 텍스트" 만
 * 필요한 호출부가 백엔드 분기를 직접 신경 쓰지 않도록 여기서 한 번만 처리한다.
 * 연결이 없으면 runQuery 와 같은 규칙으로 NOT_CONNECTED_ERROR 를 던진다
 */
export async function askText(input: AskTextInput): Promise<string | null> {
  const backend = agentBackend()
  if (backend === 'none') throw new Error(NOT_CONNECTED_ERROR)
  if (backend === 'codex') {
    let text = ''
    for await (const event of runCodexQuery({
      prompt: input.prompt,
      systemPrompt: input.system,
      model: input.model,
      abort: input.abort
    })) {
      if (input.abort.signal.aborted) break
      if (event.type === 'text') text += event.text
    }
    return text.trim() || null
  }
  const stream = runQuery({
    prompt: input.prompt,
    systemPrompt: input.system,
    model: input.model,
    mcpServers: {},
    allowedTools: [],
    abort: input.abort
  })
  let text = ''
  for await (const message of stream) {
    if (input.abort.signal.aborted) break
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) {
      if (block.type === 'text') text += block.text
    }
  }
  return text.trim() || null
}

// Claude Agent SDK 호출. 연결된 Claude 구독 또는 내 API 키(ANTHROPIC_API_KEY)를 쓴다
/**
 * 이미지가 붙었으면 SDK 가 받는 사용자 메시지 스트림(텍스트 + 이미지 블록)으로 만든다.
 * 이미지가 없으면 문자열 그대로 — 기존 경로를 건드리지 않는다
 */
export function promptInputOf(
  prompt: string,
  images?: AgentImage[]
): string | AsyncIterable<SDKUserMessage> {
  if (!images || images.length === 0) return prompt
  const message: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        ...images.map((img) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.mediaType, data: img.data }
        })),
        { type: 'text' as const, text: prompt }
      ]
    }
  }
  return (async function* () {
    yield message
  })()
}

export function runQuery(input: ProviderInput): Query {
  const auth = currentAuth()
  // 연결된 경로가 없으면 SDK 를 아예 부르지 않는다 —
  // 부르면 이 PC 에 남아 있는 CLI 로그인 자격을 SDK 가 알아서 집어 쓴다
  if (auth.mode === 'none') throw new Error(NOT_CONNECTED_ERROR)
  const env = resolveEnv(auth)
  // 키 경로인데 키가 사라졌으면 구독 자격으로 조용히 넘어가지 않고 멈춘다
  if (auth.mode === 'api_key' && !env) throw new Error(NOT_CONNECTED_ERROR)
  return query({
    prompt: promptInputOf(input.prompt, input.images),
    options: buildQueryOptions(input, env)
  })
}

/**
 * 미리 띄워 둔 CLI 프로세스 하나. 프롬프트를 써 넣는 순간 바로 응답이 시작된다
 * (spawn + 초기화 시간을 호출보다 앞에서 미리 치른다)
 */
export interface WarmSession {
  /** 한 번만 쓸 수 있다(쓰고 나면 그 프로세스는 이 대화로 끝난다) */
  query: (prompt: string) => Query
  /** 이 프로세스를 멈추는 신호(호출부의 시간 초과가 이것을 쓴다) */
  abort: AbortController
  /** 쓰지 않고 버릴 때 */
  close: () => void
}

/**
 * 프롬프트 없이 CLI 프로세스만 먼저 띄운다. 연결 경로가 없거나 실패하면 null 이며,
 * 그때는 호출부가 평소처럼 runQuery 로 돌면 된다(기능이 죽지는 않는다)
 */
export async function startWarmSession(
  input: Omit<ProviderInput, 'prompt' | 'abort'>
): Promise<WarmSession | null> {
  const auth = currentAuth()
  // 연결이 없으면 프로세스를 띄우지 않는다(남아 있는 CLI 자격을 몰래 쓰지 않기 위함)
  if (auth.mode === 'none') return null
  const env = resolveEnv(auth)
  if (auth.mode === 'api_key' && !env) return null
  const abort = new AbortController()
  try {
    const warm = await startup({
      options: buildQueryOptions({ ...input, prompt: '', abort }, env)
    })
    return {
      query: (prompt: string) => warm.query(prompt),
      abort,
      close: () => {
        try {
          warm.close()
        } catch {
          // 이미 끝난 프로세스를 닫는 것은 문제가 아니다
        }
      }
    }
  } catch {
    // 미리 띄우기는 있으면 좋은 것이지 필수가 아니다(사유는 남기지 않는다)
    return null
  }
}

// 인증 없음으로 볼 문구. SDK 의 SDKAssistantMessageError 값과 실제 401 응답 문구를 모두 포함
const MISSING_PATTERNS = [
  // 'login' 단독은 페이지·모델 텍스트("로그인 버튼을 눌렀습니다")와 겹쳐 오분류를 만든다
  'not logged in',
  'please login',
  'please log in',
  'authentication',
  'authentication_error',
  'authentication_failed',
  'oauth',
  'api key',
  'api_key',
  'x-api-key',
  'unauthorized',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
  'credential'
]

// 사용 한도·결제 문구. billing_error 는 인증 문제가 아니라 한도/결제 안내가 맞다
const LIMIT_PATTERNS = ['rate limit', 'rate_limit', 'usage limit', 'quota', '429', 'billing_error']

// 인증 오류 문구 판별 → UI 안내 키
export function classifyAuthError(message: string): 'missing' | 'limit' | null {
  const m = message.toLowerCase()
  if (MISSING_PATTERNS.some((p) => m.includes(p))) return 'missing'
  if (LIMIT_PATTERNS.some((p) => m.includes(p))) return 'limit'
  return null
}

// 재시도해도 회복되지 않는 인증/계정 오류. api_retry 관측 시 즉시 중단한다
const FATAL_API_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
  'invalid_request',
  'model_not_found'
])

export function isFatalApiError(error: string): boolean {
  return FATAL_API_ERRORS.has(error)
}
