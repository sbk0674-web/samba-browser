import { describe, expect, it } from 'vitest'
import { profileOfPartitionKey, skipsProfile } from '../src/main/extensions/manager'
import {
  parseProfileList,
  scopeModeOf
} from '../src/renderer/src/components/extensions/extension-scope'

describe('확장의 프로필 범위 — 세션에 올릴지 판정', () => {
  const scopes = { wave: [], shop: ['auto1', 'Auto2'] }

  it('파티션 이름에서 프로필 이름을 뽑는다', () => {
    expect(profileOfPartitionKey(undefined)).toBeNull()
    expect(profileOfPartitionKey('persist:ws1-default')).toBe('default')
    expect(profileOfPartitionKey('persist:ws12-buyer01')).toBe('buyer01')
  })

  it('설정에 없는 확장은 어디든 올린다', () => {
    expect(skipsProfile(scopes, 'other', 'persist:ws1-buyer01')).toBe(false)
  })

  it('기본 세션과 일반 탭에는 늘 올린다', () => {
    expect(skipsProfile(scopes, 'wave', undefined)).toBe(false)
    expect(skipsProfile(scopes, 'wave', 'persist:ws1-default')).toBe(false)
  })

  it('빈 목록이면 계정 프로필에는 올리지 않는다', () => {
    expect(skipsProfile(scopes, 'wave', 'persist:ws1-buyer01')).toBe(true)
  })

  it('고른 프로필에만 올린다(대소문자 무시)', () => {
    expect(skipsProfile(scopes, 'shop', 'persist:ws1-auto1')).toBe(false)
    expect(skipsProfile(scopes, 'shop', 'persist:ws1-auto2')).toBe(false)
    expect(skipsProfile(scopes, 'shop', 'persist:ws1-buyer01')).toBe(true)
  })
})

describe('확장의 프로필 범위 — 화면 값', () => {
  it('범위 종류를 읽는다', () => {
    expect(scopeModeOf({}, 'a')).toBe('all')
    expect(scopeModeOf({ a: [] }, 'a')).toBe('default')
    expect(scopeModeOf({ a: ['x'] }, 'a')).toBe('list')
  })

  it('프로필 목록을 쉼표·공백으로 나누고 빈 값·중복을 뺀다', () => {
    expect(parseProfileList(' auto1, auto2  AUTO1 ,, ')).toEqual(['auto1', 'auto2'])
    expect(parseProfileList('')).toEqual([])
  })
})
