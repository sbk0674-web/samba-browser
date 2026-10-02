import { describe, expect, it } from 'vitest'
import { isValidProfileName, profileNames } from '../src/shared/profiles'

describe('profileNames', () => {
  it('지금 작업공간 폴더만, 기본·내부용 프로필은 빼고 이름순으로 돌려준다', () => {
    const dirs = [
      'default',
      'e2e-naver.com',
      'ws1-default',
      'ws1-__probe__',
      'ws1-guest-1790000000000',
      'ws1-hwangnol06',
      'ws1-Edelvise06',
      'ws1-cannonfort@naver.com',
      'ws2-other'
    ]
    expect(profileNames(dirs, 'ws1-')).toEqual(['cannonfort@naver.com', 'Edelvise06', 'hwangnol06'])
  })

  it('아직 폴더가 없는(방금 연) 탭의 프로필도 넣고 중복은 한 번만', () => {
    expect(profileNames(['ws1-a'], 'ws1-', ['b', 'a', 'default', 'guest-12'])).toEqual(['a', 'b'])
  })
})

describe('profileNames — 폴더 이름 인코딩', () => {
  it('퍼센트 인코딩된 한글 폴더 이름을 풀어 열린 탭의 이름과 하나로 합친다', () => {
    expect(
      profileNames(['ws1-%EC%83%88%ED%94%84%EB%A1%9C%ED%95%841'], 'ws1-', ['새프로필1'])
    ).toEqual(['새프로필1'])
  })

  it('풀 수 없는 이름은 그대로 둔다', () => {
    expect(profileNames(['ws1-100%'], 'ws1-')).toEqual(['100%'])
  })
})

describe('isValidProfileName', () => {
  it('영문·숫자·한글과 . _ @ - 를 받는다', () => {
    for (const ok of ['hwangnol06', 'a.b_c-d', 'me@naver.com', '무신사2']) {
      expect(isValidProfileName(ok)).toBe(true)
    }
  })

  it('빈 값·기본 이름·내부용·경로 기호·너무 긴 이름은 거부한다', () => {
    for (const bad of [
      '',
      '  ',
      'default',
      '__probe__',
      'guest-123',
      '../x',
      'a/b',
      'a b',
      '.hidden',
      'x'.repeat(41)
    ]) {
      expect(isValidProfileName(bad)).toBe(false)
    }
  })
})
