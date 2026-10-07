import { describe, it, expect } from 'vitest'
import { AI_PROVIDERS, TASK_MODEL_KEYS, type TaskModels } from '../src/shared/ai'
import {
  DEFAULT_TASK_MODELS,
  remapOnProviderChange,
  resolveModel,
  taskModelChoices
} from '../src/main/ai/models'
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings'

describe('DEFAULT_TASK_MODELS', () => {
  it('제공자마다 fast/standard/deep/visual 4칸이 모두 채워진다', () => {
    for (const provider of AI_PROVIDERS) {
      const models = DEFAULT_TASK_MODELS[provider]
      for (const key of TASK_MODEL_KEYS) {
        expect(models[key], `${provider}.${key}`).toBeTruthy()
      }
    }
  })

  it('구독 기본값은 설정 기본값과 같다', () => {
    expect(DEFAULT_TASK_MODELS.claude_subscription).toEqual(DEFAULT_SETTINGS.taskModels)
  })

  it('내 API 키 경로는 정식 모델 ID 를 쓴다', () => {
    expect(DEFAULT_TASK_MODELS.api_key).toEqual({
      fast: 'claude-haiku-4-5-20251001',
      standard: 'claude-sonnet-5-5',
      deep: 'claude-opus-5-5',
      visual: 'claude-sonnet-5-5'
    })
  })
})

describe('resolveModel', () => {
  it('설정된 값을 그대로 돌려준다', () => {
    const models: TaskModels = { fast: 'haiku', standard: 'opus', deep: 'opus', visual: 'sonnet' }
    expect(resolveModel(models, 'standard')).toBe('opus')
  })

  it('빈 문자열·공백이면 기본값으로 대체한다', () => {
    const models: TaskModels = { fast: '', standard: '   ', deep: 'opus', visual: '' }
    expect(resolveModel(models, 'fast')).toBe(DEFAULT_TASK_MODELS.claude_subscription.fast)
    expect(resolveModel(models, 'standard')).toBe(DEFAULT_TASK_MODELS.claude_subscription.standard)
    expect(resolveModel(models, 'visual')).toBe(DEFAULT_TASK_MODELS.claude_subscription.visual)
  })

  it('표 자체가 망가져도 기본값으로 떨어진다', () => {
    expect(resolveModel(undefined as unknown as TaskModels, 'deep')).toBe(
      DEFAULT_TASK_MODELS.claude_subscription.deep
    )
  })
})

describe('remapOnProviderChange', () => {
  it('구독 → 내 API 키: 별칭을 쓰던 사용자는 등급을 유지하며 정식 ID 로 대체한다', () => {
    const aliases: TaskModels = {
      fast: 'haiku',
      standard: 'sonnet',
      deep: 'opus',
      visual: 'sonnet'
    }
    const { models, changed } = remapOnProviderChange(aliases, 'claude_subscription', 'api_key')
    expect(models).toEqual(DEFAULT_TASK_MODELS.api_key)
    expect(changed.sort()).toEqual(['deep', 'fast', 'standard', 'visual'])
  })

  it('changed 에는 실제로 바뀐 칸만 담긴다', () => {
    // deep 칸만 이미 정식 ID 라 그대로 남는다
    const current: TaskModels = {
      fast: 'haiku',
      standard: 'sonnet',
      deep: 'claude-opus-5-5',
      visual: 'sonnet'
    }
    const { models, changed } = remapOnProviderChange(current, 'claude_subscription', 'api_key')
    expect(models.deep).toBe('claude-opus-5-5')
    expect(changed).not.toContain('deep')
    expect(changed.sort()).toEqual(['fast', 'standard', 'visual'])
  })

  it('같은 제공자로의 전환은 아무것도 바꾸지 않는다', () => {
    const current: TaskModels = { ...DEFAULT_TASK_MODELS.api_key, fast: 'claude-fable-5-1' }
    const { models, changed } = remapOnProviderChange(current, 'api_key', 'api_key')
    expect(models).toEqual(current)
    expect(changed).toEqual([])
  })

  it('다른 칸의 등급을 쓰고 있었으면 그 등급을 따라간다', () => {
    // standard 칸에 '깊게' 등급(opus)을 넣어 둔 사용자
    const current: TaskModels = { fast: 'haiku', standard: 'opus', deep: 'opus', visual: 'sonnet' }
    const { models } = remapOnProviderChange(current, 'claude_subscription', 'api_key')
    expect(models.standard).toBe(DEFAULT_TASK_MODELS.api_key.deep)
  })

  it('매핑할 수 없는 값은 새 제공자의 해당 칸 기본값으로 떨어진다', () => {
    const current: TaskModels = {
      ...DEFAULT_TASK_MODELS.claude_subscription,
      fast: 'gpt-4o-mini'
    }
    const { models, changed } = remapOnProviderChange(current, 'api_key', 'claude_subscription')
    expect(models.fast).toBe(DEFAULT_TASK_MODELS.claude_subscription.fast)
    expect(changed).toContain('fast')
  })
})

describe('taskModelChoices', () => {
  it('제공자별 후보에 기본값이 모두 들어 있다', () => {
    for (const provider of AI_PROVIDERS) {
      const choices = taskModelChoices(provider)
      for (const key of TASK_MODEL_KEYS) {
        expect(choices, `${provider}.${key}`).toContain(DEFAULT_TASK_MODELS[provider][key])
      }
    }
  })
})

describe('설정 스키마', () => {
  it('기본 설정에 aiProvider · taskModels 가 있다', () => {
    expect(DEFAULT_SETTINGS.aiProvider).toBe('claude_subscription')
    expect(DEFAULT_SETTINGS.taskModels).toEqual({
      fast: 'claude-haiku-4-5-20251001',
      standard: 'claude-sonnet-5-5',
      deep: 'claude-opus-5-5',
      visual: 'claude-sonnet-5-5'
    })
  })

  it('망가진 값은 필드별 기본값으로 되돌린다', () => {
    const s = parseSettings({ aiProvider: 'nope', taskModels: { fast: 3 } })
    expect(s.aiProvider).toBe('claude_subscription')
    expect(s.taskModels).toEqual(DEFAULT_SETTINGS.taskModels)
  })

  it('유효한 값은 그대로 지킨다', () => {
    const s = parseSettings({
      aiProvider: 'api_key',
      taskModels: {
        fast: 'claude-haiku-4-5-20251001',
        standard: 'claude-sonnet-5-5',
        deep: 'claude-opus-5-5',
        visual: 'claude-fable-5-1'
      }
    })
    expect(s.aiProvider).toBe('api_key')
    expect(s.taskModels.visual).toBe('claude-fable-5-1')
  })
})

describe('canonicalModel', () => {
  it('별칭을 정식 ID 로 바꾸고 모르는 값은 그대로 둔다', async () => {
    const { canonicalModel } = await import('../src/shared/ai')
    expect(canonicalModel('sonnet')).toBe('claude-sonnet-5-5')
    expect(canonicalModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(canonicalModel('gpt-5.6')).toBe('gpt-5.6')
  })
})

describe('옛 모델 ID 승격', () => {
  it('저장된 Opus 5·Sonnet 5 는 5.5 로 올려 읽고 나머지는 그대로 둔다', () => {
    const s = parseSettings({
      taskModels: {
        fast: 'claude-haiku-4-5-20251001',
        standard: 'claude-opus-5',
        deep: 'claude-opus-5',
        visual: 'claude-sonnet-5'
      }
    })
    expect(s.taskModels).toEqual({
      fast: 'claude-haiku-4-5-20251001',
      standard: 'claude-opus-5-5',
      deep: 'claude-opus-5-5',
      visual: 'claude-sonnet-5-5'
    })
  })
})
