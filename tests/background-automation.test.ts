import { describe, expect, it } from 'vitest'
import {
  isAutomation,
  isBackgroundAutomation,
  runAsAutomation
} from '../src/main/browser/human-activity'

describe('뒤에서만 도는 자동화(브릿지) 표식', () => {
  it('자동화 밖에서는 둘 다 아니다', () => {
    expect(isAutomation()).toBe(false)
    expect(isBackgroundAutomation()).toBe(false)
  })

  it('앱 안 AI 작업은 자동화지만 뒤에서만 도는 작업은 아니다', async () => {
    await runAsAutomation(async () => {
      expect(isAutomation()).toBe(true)
      expect(isBackgroundAutomation()).toBe(false)
    })
  })

  it('브릿지 작업은 뒤에서만 도는 자동화다 — 비동기 경계를 넘어도 유지된다', async () => {
    await runAsAutomation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      expect(isAutomation()).toBe(true)
      expect(isBackgroundAutomation()).toBe(true)
    }, true)
    expect(isBackgroundAutomation()).toBe(false)
  })
})
