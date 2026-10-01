// 작업별 모델(Fast/Standard/Deep/Visual) 기본값과 제공자 전환 시 자동 대체.
// 순수 함수만 둔다(네트워크·파일 접근 없음)

import {
  TASK_MODEL_KEYS,
  type AiProviderId,
  type TaskModelKey,
  type TaskModels
} from '../../shared/ai'

// Claude 구독(= Claude Code) 경로도 정식 ID 로 둔다(별칭 haiku/sonnet/opus 도 여전히 통한다).
// 목록·라벨을 API 키 경로와 같게 보여 주기 위함
const SUBSCRIPTION_MODELS: TaskModels = {
  fast: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5-5',
  deep: 'claude-opus-5-5',
  visual: 'claude-sonnet-5-5'
}

// 내 API 키 경로는 별칭이 통하지 않으므로 정식 모델 ID 를 쓴다
const API_KEY_MODELS: TaskModels = {
  fast: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5-5',
  deep: 'claude-opus-5-5',
  visual: 'claude-sonnet-5-5'
}

// Codex 구독(= Codex CLI) 경로는 OpenAI 모델 이름을 그대로 넘긴다(codex exec -m)
const CODEX_MODELS: TaskModels = {
  fast: 'gpt-5.6',
  standard: 'gpt-5.6',
  deep: 'gpt-5.6-pro',
  visual: 'gpt-5.6'
}

export const DEFAULT_TASK_MODELS: Record<AiProviderId, TaskModels> = {
  claude_subscription: SUBSCRIPTION_MODELS,
  codex_subscription: CODEX_MODELS,
  api_key: API_KEY_MODELS,
  // 서비스 크레딧은 아직 자리만 잡아 둔 카드라 내 API 키와 같은 목록을 쓴다
  service_credit: API_KEY_MODELS
}

// 설정 화면의 선택 후보. 사용자가 직접 입력한 값도 허용하므로 "제안 목록"에 가깝다
const MODEL_CHOICES: Record<AiProviderId, string[]> = {
  // Claude Code 구독은 별칭(haiku/sonnet/opus)과 정식 ID 둘 다 받는다 — 목록은 정식 ID 로 통일
  claude_subscription: [
    'claude-fable-5-1',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001'
  ],
  api_key: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
  codex_subscription: ['gpt-5.6', 'gpt-5.6-pro', 'gpt-5.1-codex-max', 'gpt-5.3-codex'],
  service_credit: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1'
  ]
}

export function taskModelChoices(provider: AiProviderId): string[] {
  return [...MODEL_CHOICES[provider]]
}

/** 실제 호출에 쓸 모델 이름. 비어 있거나 표가 망가졌으면 제공자 기본값으로 떨어진다 */
export function resolveModel(
  models: TaskModels,
  key: TaskModelKey,
  provider: AiProviderId = 'claude_subscription'
): string {
  const value = models?.[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  return DEFAULT_TASK_MODELS[provider][key]
}

// 값 v 가 from 제공자의 어느 등급인지 찾는다(같은 칸을 먼저 본다)
// Claude Code 별칭(haiku/sonnet/opus/fable)도 등급으로 풀어 준다(구버전 설정 호환)
const ALIAS_GRADE: Record<string, TaskModelKey> = {
  haiku: 'fast',
  sonnet: 'standard',
  opus: 'deep',
  fable: 'deep'
}

function gradeOf(v: string, from: AiProviderId, key: TaskModelKey): TaskModelKey | null {
  if (DEFAULT_TASK_MODELS[from][key] === v) return key
  const direct = TASK_MODEL_KEYS.find((k) => DEFAULT_TASK_MODELS[from][k] === v)
  if (direct) return direct
  return ALIAS_GRADE[v] ?? null
}

/**
 * 제공자를 바꿀 때 작업별 모델을 자동 대체한다.
 * 등급(fast/standard/deep/visual)을 유지하고, 매핑할 수 없는 값은 새 제공자의 해당 칸 기본값으로 떨어진다
 */
export function remapOnProviderChange(
  current: TaskModels,
  from: AiProviderId,
  to: AiProviderId
): { models: TaskModels; changed: TaskModelKey[] } {
  if (from === to) return { models: { ...current }, changed: [] }
  const models = { ...current }
  const changed: TaskModelKey[] = []
  for (const key of TASK_MODEL_KEYS) {
    const before = resolveModel(current, key, from)
    const grade = gradeOf(before, from, key)
    const after = DEFAULT_TASK_MODELS[to][grade ?? key]
    models[key] = after
    if (after !== current[key]) changed.push(key)
  }
  return { models, changed }
}
