// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { idOfExactText, textOf } from '../src/preload/page-core'

// jsdom 은 크기를 0 으로 준다 — 보이는 칸처럼 크기를 준다
function sized(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 80, bottom: 20, width: 80, height: 20, x: 0, y: 0 }) as DOMRect
  }
}

describe('idOfExactText — 요소 목록에 안 잡히는 칸을 글자로 찾는다', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="grid">
        <div class="row"><div class="cell"><div class="txt">20260101-000001</div></div><div class="cell">A</div></div>
        <div class="row"><div class="cell"><div class="txt">20260101-000002</div></div><div class="cell">A</div></div>
        <div class="row" style="display:none"><div class="cell">20260101-000003</div></div>
      </div>`
    sized()
  })

  it('글자가 정확히 같은 가장 안쪽 요소에 번호를 매긴다', () => {
    const id = idOfExactText('20260101-000002')
    expect(id).toBeGreaterThan(0)
    expect(textOf(id)).toContain('20260101-000002')
  })

  it('같은 글자가 여럿이면 nth 로 고른다', () => {
    const first = idOfExactText('A', 0)
    const second = idOfExactText('A', 1)
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(0)
    expect(second).not.toBe(first)
  })

  it('없거나 숨은 글자는 -1', () => {
    expect(idOfExactText('20260101-999999')).toBe(-1)
    expect(idOfExactText('20260101-000003')).toBe(-1)
    expect(idOfExactText('  ')).toBe(-1)
  })
})

describe('idOfRowCell — 같은 줄의 다른 칸', () => {
  it('주문번호 칸의 줄에서 왼쪽 첫 칸을 고른다', async () => {
    const { idOfRowCell } = await import('../src/preload/page-core')
    document.body.innerHTML = `
      <div class="body">
        <div class="row" id="r0"><div id="c0"></div><div id="c1">1</div><div id="c2"><div class="t">20260101-000001</div></div></div>
      </div>`
    const place = (id: string, left: number): void => {
      const el = document.getElementById(id) as HTMLElement
      el.getBoundingClientRect = () =>
        ({ left, top: 100, right: left + 40, bottom: 120, width: 40, height: 20, x: left, y: 100 }) as DOMRect
    }
    place('c0', 0)
    place('c1', 40)
    place('c2', 80)
    const t = document.querySelector('.t') as HTMLElement
    t.getBoundingClientRect = () =>
      ({ left: 80, top: 100, right: 120, bottom: 120, width: 40, height: 20, x: 80, y: 100 }) as DOMRect
    const row = document.getElementById('r0') as HTMLElement
    row.getBoundingClientRect = () =>
      ({ left: 0, top: 100, right: 900, bottom: 120, width: 900, height: 20, x: 0, y: 100 }) as DOMRect
    const body = document.querySelector('.body') as HTMLElement
    body.getBoundingClientRect = () =>
      ({ left: 0, top: 80, right: 900, bottom: 400, width: 900, height: 320, x: 0, y: 80 }) as DOMRect
    const id = idOfExactText('20260101-000001')
    const first = idOfRowCell(id, 0)
    expect(first).toBeGreaterThan(0)
    expect(first).not.toBe(id)
    expect(idOfRowCell(id, 9)).toBe(-1)
  })
})
