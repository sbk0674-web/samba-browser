// AI 연결 경로와 작업별 모델에 관한 공용 타입.
// 이 파일에는 실제 API 키가 담기는 타입이 없다 — 렌더러로 나가는 것은 마스킹 문자열뿐이다

export const AI_PROVIDERS = [
  'claude_subscription',
  'codex_subscription',
  'api_key',
  'service_credit'
] as const
export type AiProviderId = (typeof AI_PROVIDERS)[number]

// 구독(= CLI 로그인) 경로 둘. 이 둘만 명시적 연결/해지를 갖는다
export const SUBSCRIPTION_PROVIDERS = ['claude_subscription', 'codex_subscription'] as const
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDERS)[number]

// 설정에 저장할 때 쓰는 짧은 키
export const CONNECTION_KEYS = ['claude', 'codex'] as const
export type ConnectionKey = (typeof CONNECTION_KEYS)[number]

export const API_KEY_VENDORS = ['anthropic', 'openai', 'gemini'] as const
export type ApiKeyVendor = (typeof API_KEY_VENDORS)[number]

// 작업 등급: 빠름 · 표준 · 깊게 · 화면 인식
export const TASK_MODEL_KEYS = ['fast', 'standard', 'deep', 'visual'] as const
export type TaskModelKey = (typeof TASK_MODEL_KEYS)[number]
export type TaskModels = Record<TaskModelKey, string>

/**
 * 제공자 카드 상태.
 * - connected: 사용자가 직접 연결했고 지금 쓸 수 있다
 * - available: 이 PC 에 CLI 로그인 자격은 있지만 **연결하지 않았다**(에이전트가 쓰지 않는다)
 * - needs_login: CLI 는 있는데 로그인 자격이 없다
 * - not_installed: CLI 자체가 없다
 * - unset: 아직 아무것도 넣지 않았다(내 API 키)
 */
export const AI_PROVIDER_STATES = [
  'connected',
  'available',
  'not_installed',
  'needs_login',
  'disabled',
  'unset'
] as const
export type AiProviderState = (typeof AI_PROVIDER_STATES)[number]

/** 기기 로컬 연결 기록. 계정은 화면 표시용 문자열(이메일)일 뿐 자격이 아니다 */
export interface AiConnection {
  connected: boolean
  account?: string
  connectedAt?: number
}

export type AiConnections = Record<ConnectionKey, AiConnection>

export interface AiProviderStatus {
  id: AiProviderId
  state: AiProviderState
  // 키는 마스킹 문자열만. 실제 값은 절대 렌더러로 가지 않는다
  maskedKeys: Partial<Record<ApiKeyVendor, string>>
  // 화면 안내 문구의 i18n 키(평문 문장이 아니다)
  detail?: string
  // 표시용 계정(이메일 등). 토큰·키는 절대 담기지 않는다
  account?: string
  // 사용자가 명시적으로 연결했는가(구독 카드에만 의미가 있다)
  connected?: boolean
}

/**
 * 구독 사용량 한 줄. 5시간 세션·주간 전체·모델별 주간(Fable 등) 한도가 각각 한 줄이다.
 * 계정이 둘일 때 "어느 계정이 붙어 있고 얼마나 썼나"를 앱에서 바로 보게 한다 —
 * 한도 소진 계정이 붙은 줄 모르고 실행이 중간에 끊기던 문제(실기)
 */
export interface AiUsageLimit {
  kind: 'session' | 'weekly_all' | 'weekly_scoped'
  /** 0~100 */
  percent: number
  /** ISO 시각. 없으면 null */
  resetsAt: string | null
  /** 모델별 한도일 때 모델 표시 이름(예: Fable) */
  model?: string
}

export interface AiUsage {
  limits: AiUsageLimit[]
  fetchedAt: number
}

/** 이 비율부터 카드에 경고를 띄운다 */
export const AI_USAGE_WARN_PERCENT = 90

/** 연결 시도 결과. 자격이 없으면 이유만 돌려주고 안내 다이얼로그를 띄운다 */
export interface AiConnectResult {
  ok: boolean
  reason?: 'not_installed' | 'needs_login'
  connection?: AiConnection
}

export function isAiProviderId(v: unknown): v is AiProviderId {
  return typeof v === 'string' && (AI_PROVIDERS as readonly string[]).includes(v)
}

export function isSubscriptionProviderId(v: unknown): v is SubscriptionProviderId {
  return typeof v === 'string' && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(v)
}

/** 제공자 → 설정 저장 키 */
export function connectionKeyOf(provider: SubscriptionProviderId): ConnectionKey {
  return provider === 'claude_subscription' ? 'claude' : 'codex'
}

export function isApiKeyVendor(v: unknown): v is ApiKeyVendor {
  return typeof v === 'string' && (API_KEY_VENDORS as readonly string[]).includes(v)
}

export function isTaskModelKey(v: unknown): v is TaskModelKey {
  return typeof v === 'string' && (TASK_MODEL_KEYS as readonly string[]).includes(v)
}

// 모델 ID·별칭을 사람이 읽는 이름으로. 모르는 값은 그대로 보여 준다
const MODEL_LABELS: Record<string, string> = {
  'claude-fable-5-1': 'Fable 5.1',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  fable: 'Fable 5.1',
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5.5',
  haiku: 'Haiku 4.5'
}
export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model
}

// 별칭(sonnet 등)을 정식 ID 로. 저장값이 별칭이어도 목록의 정식 ID 와 같은 항목으로 취급한다
const MODEL_ALIASES: Record<string, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5-20251001'
}
// 한 세대 지난 모델 ID → 최신 ID(설정 저장값 승격용)
const MODEL_UPGRADES: Record<string, string> = {
  'claude-opus-5': 'claude-opus-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5'
}
export function upgradeModelId(model: string): string {
  return MODEL_UPGRADES[model] ?? model
}

export function canonicalModel(model: string): string {
  return MODEL_ALIASES[model] ?? model
}
