// @vitest-environment jsdom
// preload 의 결제 키패드 배치 읽기 — 0~9 가 정확히 한 번씩 보일 때만 배치를 돌려준다

import { describe, it, expect, beforeEach } from 'vitest'
import {
  keypadLayout,
  keypadUnlabeled,
  performClick,
  resetElementIds
} from '../src/preload/page-core'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

function keypadHtml(
  digits: string[] = DIGITS,
  wrap: (d: string) => string = (d) => `<button>${d}</button>`
): string {
  return `<div class="kpd">${digits.map(wrap).join('')}</div>`
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetElementIds()
})

describe('keypadLayout', () => {
  it('button 열 자리 숫자를 배치로 돌려주고, 그 id 로 바로 누를 수 있다', () => {
    document.body.innerHTML = keypadHtml()
    const layout = keypadLayout()
    expect(layout).not.toBeNull()
    expect(layout!.digits.map((d) => d.digit)).toEqual(DIGITS)
    // 스냅샷을 찍지 않았어도 id 가 매겨져 registry 에 들어간다
    const five = layout!.digits.find((d) => d.digit === '5')!
    let clicked = ''
    document.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        clicked = b.textContent ?? ''
      })
    })
    performClick(five.id)
    expect(clicked).toBe('5')
  })

  it('div·span·td 로 그린 키패드도 읽는다(NICE·페이코 보안 키패드)', () => {
    document.body.innerHTML = `<table><tr>${DIGITS.map((d) => `<td>${d}</td>`).join('')}</tr></table>`
    expect(keypadLayout()?.digits.length).toBe(10)
    document.body.innerHTML = keypadHtml(DIGITS, (d) => `<div class="key">${d}</div>`)
    expect(keypadLayout()?.digits.length).toBe(10)
  })

  it('<a><span>5</span></a> 처럼 겹친 표기는 안쪽 하나만 세어 중복으로 보지 않는다', () => {
    document.body.innerHTML = keypadHtml(DIGITS, (d) => `<a href="#"><span>${d}</span></a>`)
    const layout = keypadLayout()
    expect(layout?.digits.length).toBe(10)
  })

  it('글자 없이 aria-label 에만 숫자가 있는 키패드도 읽는다(NICE nFilter 실기 구조)', () => {
    // 숫자는 배경 스프라이트, 접근성 이름만 "1".."0". 명령 키와 빈 칸(이름 없음)이 섞여 있다
    const keys = ['1', '2', '3', '', '4', '5', '6', '7', '8', '9', '', '0']
      .map((d) =>
        d === ''
          ? '<button class="nfilter_keypad_button kpd"></button>'
          : `<button class="nfilter_keypad_button kpd" aria-label="${d}"></button>`
      )
      .join('')
    document.body.innerHTML =
      `<div id="ownKeypad">${keys}` +
      '<button id="nfilter_renew" aria-label="재배열"></button>' +
      '<button id="nfilter_enter" aria-label="입력완료"></button></div>' +
      // 숨겨진 다른 자판(display:none)에 같은 숫자가 있어도 세지 않는다
      '<div class="kpdGrp lower" style="display:none"><button aria-label="1"></button></div>' +
      '<input type="tel" maxlength="6" value="">'
    const layout = keypadLayout()
    expect(layout?.digits.map((d) => d.digit)).toEqual(DIGITS)
    // 비밀 입력칸이 없어도 PIN 길이의 숫자칸으로 자리수를 센다
    expect(layout?.filled).toBe(0)
  })

  it('alt·title 에 숫자가 있는 이미지 키도 읽는다', () => {
    document.body.innerHTML = DIGITS.map((d, i) =>
      i % 2 === 0 ? `<a href="#"><img alt="${d}"></a>` : `<button title="${d}"></button>`
    ).join('')
    expect(keypadLayout()?.digits.length).toBe(10)
  })

  it('숫자가 하나라도 빠지면 null', () => {
    document.body.innerHTML = keypadHtml(DIGITS.filter((d) => d !== '7'))
    expect(keypadLayout()).toBeNull()
  })

  it('같은 숫자가 두 곳에 보이면 null(어느 쪽인지 확정할 수 없다)', () => {
    document.body.innerHTML = keypadHtml() + '<button>3</button>'
    expect(keypadLayout()).toBeNull()
  })

  it('키패드가 모달이면 뒤 페이지의 같은 숫자(수량 1)는 세지 않는다(롯데온 L.PAY)', () => {
    document.body.innerHTML =
      '<div class="order"><span>수량</span> <span>1</span></div>' +
      `<div role="dialog" aria-label="L.PAY 비밀번호 입력">${keypadHtml(DIGITS, (d) => `<div class="key">${d}</div>`)}</div>`
    const layout = keypadLayout()
    expect(layout?.digits.map((d) => d.digit)).toEqual(DIGITS)
    // 고른 요소는 모달 안의 것이다
    const one = layout!.digits.find((d) => d.digit === '1')!
    performClick(one.id)
  })

  it('모달 밖에만 같은 숫자가 있어도 모달 안 배치가 불완전하면 null 이다', () => {
    document.body.innerHTML =
      keypadHtml() + `<div role="dialog">${keypadHtml(DIGITS.slice(0, 9))}</div>`
    expect(keypadLayout()).toBeNull()
  })

  it('숨겨진 버튼은 세지 않는다', () => {
    document.body.innerHTML = keypadHtml() + '<button style="display:none">3</button>'
    expect(keypadLayout()?.digits.length).toBe(10)
    document.body.innerHTML = `<div style="display:none">${keypadHtml()}</div>`
    expect(keypadLayout()).toBeNull()
  })

  it('filled 는 결제 비밀번호 칸의 길이만 준다(값은 읽지 않는다)', () => {
    document.body.innerHTML =
      keypadHtml() + '<input type="password" maxlength="6" inputmode="numeric" value="14">'
    const layout = keypadLayout()
    expect(layout?.filled).toBe(2)
    expect(JSON.stringify(layout)).not.toContain('14')
  })

  it('비밀 입력칸이 없으면 filled 는 null', () => {
    document.body.innerHTML = keypadHtml()
    expect(keypadLayout()?.filled).toBeNull()
  })

  it('키패드가 아닌 화면(장바구니 수량 등)에서는 null', () => {
    document.body.innerHTML = '<button>1</button><button>2</button><span>3</span>'
    expect(keypadLayout()).toBeNull()
  })
})

describe('pressOnce — 키패드 단발 누름', () => {
  it('화면 변화가 없어도 정확히 한 번만 누른다(일반 click 의 재시도 폴백 없음)', async () => {
    const { pressOnce } = await import('../src/preload/page-core')
    document.body.innerHTML = keypadHtml()
    const layout = keypadLayout()!
    const five = layout.digits.find((d) => d.digit === '5')!
    let presses = 0
    document.querySelectorAll('button').forEach((b) => {
      if ((b.textContent ?? '') === '5') b.addEventListener('click', () => (presses += 1))
    })
    expect(pressOnce(five.id)).toBe('ok')
    expect(presses).toBe(1)
  })

  it('없는 id 는 누르지 않고 알린다', async () => {
    const { pressOnce } = await import('../src/preload/page-core')
    expect(pressOnce(9999)).toMatch(/not found|gone/)
  })
})

describe('keypadUnlabeled — 글자 없는 보안 키패드(네이버페이)', () => {
  // 3열 격자로 그린다. 칸 크기 60x40, 간격 없음
  function unlabeledHtml(count: number, extra = ''): string {
    const keys = Array.from(
      { length: count },
      (_, i) => `<button class="k" data-i="${i}"></button>`
    )
    return `<div class="kpd">${keys.join('')}${extra}</div>`
  }

  function placeGrid(size = { w: 60, h: 40 }): void {
    document.querySelectorAll<HTMLElement>('button.k').forEach((b) => {
      const i = Number(b.dataset.i)
      const left = (i % 3) * size.w
      const top = Math.floor(i / 3) * size.h
      b.getBoundingClientRect = () =>
        ({
          left,
          top,
          x: left,
          y: top,
          width: size.w,
          height: size.h,
          right: left + size.w,
          bottom: top + size.h,
          toJSON: () => ({})
        }) as DOMRect
    })
  }

  it('버튼 10~14개면 위→아래, 왼→오른 순으로 뷰포트 사각형과 id 를 준다', () => {
    document.body.innerHTML = unlabeledHtml(12)
    placeGrid()
    // DOM 순서를 섞어도 화면 순서로 정렬된다
    const kpd = document.querySelector('.kpd')!
    kpd.prepend(kpd.lastElementChild!)
    const cells = keypadUnlabeled()
    expect(cells).not.toBeNull()
    expect(cells!.length).toBe(12)
    expect(cells![0]).toMatchObject({ x: 0, y: 0, width: 60, height: 40 })
    expect(cells![1]).toMatchObject({ x: 60, y: 0 })
    expect(cells![3]).toMatchObject({ x: 0, y: 40 })
    expect(cells![11]).toMatchObject({ x: 120, y: 120 })
    // 받은 id 로 바로 누를 수 있다
    let clicked = ''
    document.querySelectorAll<HTMLElement>('button.k').forEach((b) => {
      b.addEventListener('click', () => (clicked = b.dataset.i ?? ''))
    })
    performClick(cells![4].id)
    expect(clicked).toBe('4')
  })

  it('글자·숫자 이름이 있는 버튼(전체삭제·지우기·aria-label 숫자)은 세지 않는다', () => {
    document.body.innerHTML = unlabeledHtml(
      10,
      '<button>전체삭제</button><button>지우기</button><button aria-label="3"></button>'
    )
    placeGrid()
    expect(keypadUnlabeled()?.length).toBe(10)
  })

  it('9개 이하·15개 이상이면 키패드로 보지 않는다', () => {
    document.body.innerHTML = unlabeledHtml(9)
    placeGrid()
    expect(keypadUnlabeled()).toBeNull()
    document.body.innerHTML = unlabeledHtml(15)
    placeGrid()
    expect(keypadUnlabeled()).toBeNull()
  })

  it('너무 작거나(아이콘) 너무 큰(레이어) 버튼·숨은 버튼은 빼낸다', () => {
    document.body.innerHTML = unlabeledHtml(10)
    placeGrid({ w: 12, h: 12 })
    expect(keypadUnlabeled()).toBeNull()
    placeGrid({ w: 500, h: 40 })
    expect(keypadUnlabeled()).toBeNull()
    placeGrid()
    ;(document.querySelector('.kpd') as HTMLElement).style.display = 'none'
    expect(keypadUnlabeled()).toBeNull()
  })

  it('넓은 창의 큰 칸(300px)도 키패드로 본다', () => {
    document.body.innerHTML = unlabeledHtml(10)
    placeGrid({ w: 300, h: 80 })
    expect(keypadUnlabeled()).toHaveLength(10)
  })

  it('jsdom 기본(크기 0) 버튼은 후보가 아니다', () => {
    document.body.innerHTML = unlabeledHtml(10)
    expect(keypadUnlabeled()).toBeNull()
  })
})

describe('keypadUnlabeled — 여분 아이콘 버튼', () => {
  it('글자 없는 버튼이 14개를 넘으면 크기가 같은 무리만 키패드로 본다', async () => {
    const { keypadUnlabeled } = await import('../src/preload/page-core')
    document.body.innerHTML = ''
    const add = (w: number, h: number, x: number, y: number): void => {
      const b = document.createElement('button')
      b.getBoundingClientRect = () =>
        ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) }) as DOMRect
      document.body.appendChild(b)
    }
    for (let i = 0; i < 12; i++) add(60, 50, (i % 3) * 60, Math.floor(i / 3) * 50)
    for (let i = 0; i < 4; i++) add(24, 24, 500 + i * 30, 0)
    expect(keypadUnlabeled()).toHaveLength(12)
  })
})
