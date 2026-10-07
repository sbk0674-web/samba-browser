import { describe, expect, it } from 'vitest'
import { MAX_SAVED_TABS, parseSavedTabs, savedTabsOf } from '../src/main/browser/user-tabs-store'
import type { TabInfo } from '../src/shared/ipc'

function tab(id: string, over: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    url: `https://site/${id}`,
    title: '',
    profile: 'default',
    mobile: false,
    loading: false,
    active: false,
    ...over
  }
}

describe('savedTabsOf', () => {
  it('사람이 연 탭만 순서대로 고르고 팝업·주소 없는 탭·자동화 탭은 뺀다', () => {
    const list = [
      tab('a', { active: true }),
      tab('job'),
      tab('b', { profile: 'hwangnol06', mobile: true }),
      tab('pop', { kind: 'popup' }),
      tab('blank', { url: '' })
    ]
    const user = new Set(['a', 'b', 'pop', 'blank'])
    expect(savedTabsOf(list, (id) => user.has(id))).toEqual([
      { url: 'https://site/a', profile: 'default', mobile: false, active: true },
      { url: 'https://site/b', profile: 'hwangnol06', mobile: true, active: false }
    ])
  })

  it('상한을 넘으면 앞에서부터 상한까지만', () => {
    const list = Array.from({ length: MAX_SAVED_TABS + 5 }, (_, i) => tab(`t${i}`))
    expect(savedTabsOf(list, () => true)).toHaveLength(MAX_SAVED_TABS)
  })
})

describe('parseSavedTabs', () => {
  it('저장한 모양 그대로 되읽는다', () => {
    const saved = [{ url: 'https://a', profile: 'p', mobile: false, active: true }]
    expect(parseSavedTabs(JSON.stringify(saved))).toEqual(saved)
  })

  it('깨진 파일·틀린 모양은 버린다', () => {
    expect(parseSavedTabs('{not json')).toEqual([])
    expect(parseSavedTabs('{"url":"x"}')).toEqual([])
    expect(
      parseSavedTabs(
        JSON.stringify([
          null,
          1,
          { url: '' },
          { url: 'https://a' },
          { url: 'https://b', profile: 'p' }
        ])
      )
    ).toEqual([{ url: 'https://b', profile: 'p', mobile: false, active: false }])
  })
})
