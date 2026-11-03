import { describe, it, expect } from 'vitest'
import { computeViewBounds, computeBehindBounds } from '../src/main/browser/tab-manager'
import type { Layout } from '../src/shared/ipc'

// 렌더러가 1440x900 뷰포트에서 잰 실측값(계산 로직 자체는 여백 수치에 의존하지 않으므로
// 임의의 여백 값으로도 알고리즘 검증이 가능하다 — edge-to-edge 레이아웃 이후에도 그대로 유효)
const reported: Layout = {
  x: 233,
  y: 101,
  width: 816,
  height: 788,
  viewportWidth: 1440,
  viewportHeight: 900
}

describe('computeBehindBounds', () => {
  const folded: Layout = { x: 0, y: 0, width: 0, height: 0, viewportWidth: 1440, viewportHeight: 900 }
  it('keeps background work sized when the browser panel is folded', () => {
    expect(computeBehindBounds(folded, 1440, 900, false, false)).toMatchObject({ width: 1440, height: 900 })
    const behind = computeBehindBounds(folded, 1440, 900, false, false)
    expect(behind.x + behind.width).toBeLessThanOrEqual(0)
    expect(computeViewBounds(folded, 1440, 900).width).toBe(0)
  })
  it('never exposes a view through the login gate', () => {
    expect(computeBehindBounds(reported, 1440, 900, false, true).width).toBe(0)
  })
  it('preserves normal bounds and mobile sizing', () => {
    expect(computeBehindBounds(reported, 1440, 900, false, false)).toEqual(computeViewBounds(reported, 1440, 900))
    expect(computeBehindBounds(folded, 1440, 900, true, false).width).toBe(412)
    const mobile = computeBehindBounds(folded, 1440, 900, true, false)
    expect(mobile.x + mobile.width).toBeLessThanOrEqual(0)
  })
  it('does not invent dimensions for a zero-sized host window', () => {
    expect(computeBehindBounds(folded, 0, 0, false, false).width).toBe(0)
  })
})

describe('computeViewBounds', () => {
  it('보고 시점과 창 크기가 같으면 좌표를 그대로 쓴다', () => {
    const b = computeViewBounds(reported, 1440, 900)
    expect(b.x).toBe(233)
    expect(b.y).toBe(101)
    expect(b.width).toBe(816)
    expect(b.height).toBe(788)
  })

  it('창이 줄어든 뒤 보고가 누락돼도 아래·오른쪽 여백을 유지한다', () => {
    // 1440x900 -> 1427x889 로 줄었는데 렌더러가 다시 보고하지 않은 상황
    const b = computeViewBounds(reported, 1427, 889)
    // 아래 여백 11px(패딩 10 + 테두리 1), 오른쪽 여백 391px 이 그대로 유지돼야 한다
    expect(b.y + b.height).toBe(889 - 11)
    expect(b.x + b.width).toBe(1427 - 391)
  })

  it('창이 커져도 여백을 유지한다(최대화)', () => {
    const b = computeViewBounds(reported, 1920, 1032)
    expect(b.y + b.height).toBe(1032 - 11)
    expect(b.x + b.width).toBe(1920 - 391)
  })

  it('접힌 레이아웃(browser 뷰가 아닐 때)은 0 으로 유지된다', () => {
    const b = computeViewBounds(
      { x: 0, y: 0, width: 0, height: 0, viewportWidth: 1440, viewportHeight: 900 },
      1920,
      1032
    )
    expect(b).toEqual({ x: 0, y: 0, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 })
  })

  it('창이 여백보다 작아지면 음수 대신 0 크기를 돌려준다', () => {
    const b = computeViewBounds(reported, 300, 80)
    expect(b.width).toBe(0)
    expect(b.height).toBe(0)
  })

  it('모바일: 넓은 레이아웃에서는 412px 카드가 가운데 정렬된다', () => {
    // 1440x900 에서 잰 reported(가용 폭 816px)를 그대로 재투영한 경우
    const b = computeViewBounds(reported, 1440, 900, true)
    expect(b.width).toBe(412)
    // 가용 폭(816) 안에서 좌우 여백이 같아야 한다
    const available = 1440 - reported.x - (1440 - (reported.x + reported.width))
    expect(b.x).toBe(reported.x + Math.floor((available - 412) / 2))
    expect(available - b.width - (b.x - reported.x)).toBe(Math.ceil((available - 412) / 2))
    // 높이는 전체 그대로 유지한다(세로는 중앙 정렬하지 않기로 결정)
    expect(b.height).toBe(788)
    expect(b.y).toBe(101)
  })

  it('모바일: 가용 폭이 412px 보다 좁으면 폭 전체를 그대로 쓰고 좁히지 않는다', () => {
    const narrow: Layout = {
      x: 10,
      y: 20,
      width: 300,
      height: 500,
      viewportWidth: 320,
      viewportHeight: 600
    }
    const b = computeViewBounds(narrow, 320, 600, true)
    expect(b.width).toBe(300)
    expect(b.x).toBe(10)
    expect(b.height).toBe(500)
  })
})
