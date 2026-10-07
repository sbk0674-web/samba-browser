import { describe, expect, it } from 'vitest'
import { moveItem } from '../src/shared/reorder'

describe('moveItem', () => {
  it('앞으로·뒤로 옮긴다', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('끝을 넘는 자리는 끝으로 맞춘다', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b'])
  })

  it('없는 자리·같은 자리·정수가 아닌 값이면 그대로이고 원본은 바뀌지 않는다', () => {
    const list = ['a', 'b', 'c']
    expect(moveItem(list, 5, 0)).toEqual(list)
    expect(moveItem(list, 1, 1)).toEqual(list)
    expect(moveItem(list, 0.5, 2)).toEqual(list)
    expect(moveItem(list, 0, 2)).not.toBe(list)
    expect(list).toEqual(['a', 'b', 'c'])
  })
})
