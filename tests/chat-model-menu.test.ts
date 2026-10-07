import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcResult } from '../src/shared/ipc'
import type { AiProviderId, TaskModels } from '../src/shared/ai'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'

// 입력줄 아래 "모델 · 강도" 선택만 확인한다. 스토어는 순수 zustand 라 node 에서 그대로 돌아간다
let settings: Settings = { ...DEFAULT_SETTINGS }
let taskModels: TaskModels = { ...DEFAULT_SETTINGS.taskModels }

const aiTaskModels = vi.fn(
  async (): Promise<
    IpcResult<{ provider: AiProviderId; taskModels: TaskModels; choices: string[] }>
  > => ({
    ok: true,
    data: {
      provider: 'claude_subscription',
      taskModels,
      choices: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']
    }
  })
)
const setTaskModel = vi.fn(async (key: string, model: string): Promise<IpcResult<TaskModels>> => {
  taskModels = { ...taskModels, [key]: model }
  return { ok: true, data: taskModels }
})
const settingsGet = vi.fn(async (): Promise<IpcResult<Settings>> => ({ ok: true, data: settings }))
const settingsSet = vi.fn(async (patch: Partial<Settings>): Promise<IpcResult<Settings>> => {
  settings = { ...settings, ...patch }
  return { ok: true, data: settings }
})

const win = {
  samba: {
    agent: { run: vi.fn(), stop: vi.fn(), confirmReply: vi.fn(), onEvent: vi.fn() },
    ai: { taskModels: aiTaskModels, setTaskModel },
    settings: { get: settingsGet, set: settingsSet }
  }
}
Object.assign(globalThis, { window: win })

const { useChatStore } = await import('../src/renderer/src/stores/chatStore')

describe('채팅 입력줄 모델·추론 강도', () => {
  beforeEach(() => {
    settings = { ...DEFAULT_SETTINGS }
    taskModels = { ...DEFAULT_SETTINGS.taskModels }
    setTaskModel.mockClear()
    settingsSet.mockClear()
    useChatStore.setState({
      model: DEFAULT_SETTINGS.taskModels.standard,
      modelChoices: [],
      effort: DEFAULT_SETTINGS.agentEffort
    })
  })

  it('작업별 모델 표의 표준 칸과 후보 목록을 읽어 온다', async () => {
    await useChatStore.getState().loadModelMenu()
    expect(useChatStore.getState().model).toBe('claude-sonnet-5-5')
    expect(useChatStore.getState().modelChoices).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-4-5-20251001'
    ])
  })

  it('저장된 추론 강도를 읽어 온다', async () => {
    settings = { ...settings, agentEffort: 'high' }
    await useChatStore.getState().loadModelMenu()
    expect(useChatStore.getState().effort).toBe('high')
  })

  it('모델을 고르면 표준 칸에만 저장한다', async () => {
    await useChatStore.getState().setModel('opus')
    expect(setTaskModel).toHaveBeenCalledWith('standard', 'opus')
    expect(useChatStore.getState().model).toBe('opus')
    expect(taskModels.standard).toBe('opus')
    // 하위 호환 키(settings.model)는 건드리지 않는다 — 진실은 taskModels.standard 뿐이다
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('강도를 고르면 agentEffort 설정에 저장한다', async () => {
    await useChatStore.getState().setEffort('low')
    expect(settingsSet).toHaveBeenCalledWith({ agentEffort: 'low' })
    expect(useChatStore.getState().effort).toBe('low')
    expect(settings.agentEffort).toBe('low')
  })

  it('저장한 값이 다시 읽어도 그대로다', async () => {
    await useChatStore.getState().setEffort('high')
    await useChatStore.getState().setModel('haiku')
    useChatStore.setState({ model: 'sonnet', effort: 'medium' })
    await useChatStore.getState().loadModelMenu()
    expect(useChatStore.getState().model).toBe('haiku')
    expect(useChatStore.getState().effort).toBe('high')
  })
})
