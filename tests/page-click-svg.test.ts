// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { buildSnapshot, performClick } from '../src/preload/page-core'

describe('performClick — SVG 요소', () => {
  it('click() 이 없는 SVG 요소도 오류 없이 클릭 이벤트가 전달된다(실기 2026-11-26 무신사 옵션)', async () => {
    document.body.innerHTML = `
      <div>
        <svg id="opt" role="button" aria-label="옵션 275" width="20" height="20"><rect width="20" height="20"></rect></svg>
      </div>
    `
    let clicked = 0
    document.getElementById('opt')!.addEventListener('click', () => {
      clicked += 1
    })
    const snap = buildSnapshot()
    const target = snap.elements.find((e) => (e.name ?? '').includes('옵션 275') || (e.text ?? '').includes('옵션 275'))
    expect(target).toBeDefined()
    const out = await performClick(target!.id as number)
    expect(out).toMatch(/^ok/)
    expect(clicked).toBeGreaterThanOrEqual(1)
  })
})
