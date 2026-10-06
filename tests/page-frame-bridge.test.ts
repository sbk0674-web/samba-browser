import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tab } from '../src/main/browser/tab-manager'
import type { PageElement, PageSnapshot } from '../src/shared/snapshot'

// frame-channel 은 electron 의 ipcMain 으로 프레임 응답을 받는다.
// 여기서는 그 통로를 가짜로 바꿔, 프레임 호출이 "어떤 프레임에 어떤 동작으로" 갔는지만 본다
const { frameCalls, frameReply } = vi.hoisted(() => ({
  frameCalls: [] as { host: string; op: Record<string, unknown> }[],
  frameReply: { fail: new Set<string>() }
}))

vi.mock('../src/main/browser/frame-channel', () => ({
  FRAME_CALL_TIMEOUT_MS: 8000,
  callFrameOp: async (frame: { url: string; result: unknown }, op: Record<string, unknown>) => {
    const host = new URL(frame.url).host
    frameCalls.push({ host, op })
    if (frameReply.fail.has(host)) throw new Error('frame call failed')
    return frame.result
  }
}))

const { pageBridge } = await import('../src/main/browser/page-bridge')

function el(id: number, text = ''): PageElement {
  return { id, tag: 'button', role: 'button', text, isSecret: false }
}

function snap(url: string, elements: PageElement[], text = ''): PageSnapshot {
  return { url, title: '', text, elements, total: elements.length }
}

interface FakeFrame {
  url: string
  result: unknown
}

/** 메인 프레임 결과 + 하위 프레임 목록을 가진 가짜 탭 */
function fakeTab(
  mainResult: unknown,
  frames: FakeFrame[]
): { tab: Tab; mainCalls: string[]; inputEvents: Record<string, unknown>[] } {
  const mainCalls: string[] = []
  const inputEvents: Record<string, unknown>[] = []
  // framesInSubtree 는 메인 프레임 자신을 맨 앞에 담는다(같은 객체여야 걸러진다)
  const mainFrame: { url: string; framesInSubtree: unknown[] } = {
    url: 'https://order.29cm.co.kr/order',
    framesInSubtree: []
  }
  mainFrame.framesInSubtree = [mainFrame, ...frames]
  const webContents = {
    isDestroyed: () => false,
    mainFrame,
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
      mainCalls.push(scripts[0].code)
      return mainResult
    },
    sendInputEvent: (ev: Record<string, unknown>) => inputEvents.push(ev)
  }
  return { tab: { view: { webContents } } as unknown as Tab, mainCalls, inputEvents }
}

const POSTCODE = 'https://postcode.map.daum.net/guide'

beforeEach(() => {
  frameCalls.length = 0
  frameReply.fail.clear()
})

describe('pageBridge.snapshot: iframe 합치기', () => {
  it('메인 프레임과 iframe 요소를 한 목록으로 돌려준다', async () => {
    const { tab, mainCalls } = fakeTab(
      snap('https://order.29cm.co.kr/order', [el(1, '주문하기')], '주문서'),
      [{ url: POSTCODE, result: snap(POSTCODE, [el(2, '검색')], '우편번호') }]
    )
    const s = await pageBridge.snapshot(tab)
    expect(mainCalls).toEqual(['__samba.snapshot()'])
    expect(frameCalls).toEqual([{ host: 'postcode.map.daum.net', op: { op: 'snapshot' } }])
    expect(s.elements.map((e) => e.id)).toEqual([1, 100002])
    expect(s.elements[1].frame).toEqual({ index: 1, host: 'postcode.map.daum.net' })
  })

  it('실패한 프레임은 건너뛰고 나머지는 그대로 쓴다', async () => {
    frameReply.fail.add('postcode.map.daum.net')
    const { tab } = fakeTab(snap('https://order.29cm.co.kr/order', [el(1)]), [
      { url: POSTCODE, result: snap(POSTCODE, [el(2)]) },
      {
        url: 'https://zip.musinsa.com/z',
        result: snap('https://zip.musinsa.com/z', [el(2, '주소')])
      }
    ])
    const s = await pageBridge.snapshot(tab)
    // 1번 프레임이 실패했으므로 2번 프레임 요소만 남는다(번호는 프레임 순서 그대로)
    expect(s.elements.map((e) => e.id)).toEqual([1, 200002])
    expect(s.elements[1].frame?.host).toBe('zip.musinsa.com')
  })

  it('about:blank·빈 프레임은 열거하지 않는다', async () => {
    const { tab } = fakeTab(snap('https://order.29cm.co.kr/order', [el(1)]), [
      { url: 'about:blank', result: snap('about:blank', [el(9)]) },
      { url: '', result: snap('', [el(9)]) }
    ])
    const s = await pageBridge.snapshot(tab)
    expect(frameCalls).toEqual([])
    expect(s.elements.map((e) => e.id)).toEqual([1])
  })

  it('요소도 글도 없는 프레임(광고 iframe)은 목록에 넣지 않는다', async () => {
    const { tab } = fakeTab(snap('https://order.29cm.co.kr/order', [el(1)]), [
      { url: 'https://ads.example/x', result: snap('https://ads.example/x', []) }
    ])
    const s = await pageBridge.snapshot(tab)
    expect(s.elements.map((e) => e.id)).toEqual([1])
  })
})

describe('pageBridge 행동 도구: id 로 프레임을 가른다', () => {
  it('메인 프레임 id 는 예전처럼 격리 월드에서 실행한다', async () => {
    const { tab, mainCalls } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    expect(await pageBridge.click(tab, 7)).toBe('ok')
    expect(mainCalls).toEqual(['__samba.click(7)'])
    expect(frameCalls).toEqual([])
  })

  it('프레임 id 는 그 프레임에 지역 id 로 전달한다', async () => {
    const { tab, mainCalls } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    expect(await pageBridge.click(tab, 100015)).toBe('ok')
    expect(mainCalls).toEqual([])
    expect(frameCalls).toEqual([{ host: 'postcode.map.daum.net', op: { op: 'click', id: 15 } }])
  })

  it('type·select·textOf·submitForm 도 같은 프레임으로 간다', async () => {
    const { tab } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    await pageBridge.type(tab, 100003, '서울시 강남구', true)
    await pageBridge.select(tab, 100004, '서울')
    await pageBridge.textOf(tab, 100005)
    await pageBridge.submitForm(tab, 100006)
    expect(frameCalls.map((c) => c.op)).toEqual([
      { op: 'type', id: 3, text: '서울시 강남구', submit: true },
      { op: 'select', id: 4, value: '서울' },
      { op: 'textOf', id: 5 },
      { op: 'submitForm', id: 6 }
    ])
    expect(frameCalls.every((c) => c.host === 'postcode.map.daum.net')).toBe(true)
  })

  it('scroll 은 id 를 주면 그 프레임, 안 주면 메인 프레임이다', async () => {
    const { tab, mainCalls } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    await pageBridge.scroll(tab, 'down')
    await pageBridge.scroll(tab, 'down', 100009)
    expect(mainCalls).toEqual(['__samba.scroll("down")'])
    expect(frameCalls.map((c) => c.op)).toEqual([{ op: 'scroll', dir: 'down', id: 9 }])
  })

  it('fillValue 는 프레임에 맡기고, 값이 담긴 코드 문자열을 만들지 않는다', async () => {
    const { tab, mainCalls } = fakeTab('ok', [{ url: POSTCODE, result: 'ok' }])
    expect(await pageBridge.fillValue(tab, 100002, '비밀값')).toBe('ok')
    expect(mainCalls).toEqual([])
    expect(frameCalls).toEqual([
      { host: 'postcode.map.daum.net', op: { op: 'fillValue', id: 2, value: '비밀값' } }
    ])
  })

  it('가리키는 프레임이 사라졌으면 오류를 던진다', async () => {
    const { tab } = fakeTab('ok', [])
    await expect(pageBridge.click(tab, 300001)).rejects.toThrow('frame 3 is gone')
  })
})

describe('pageBridge.keypadSignalsAll', () => {
  it('메인 프레임 신호를 먼저, 그다음 프레임 신호를 돌려준다', async () => {
    const mainSignals = {
      url: 'https://pay.example/',
      text: '결제 비밀번호',
      digitButtons: 0,
      pinField: false
    }
    const frameSignals = {
      url: 'https://kpad.payco.com/',
      text: '',
      digitButtons: 10,
      pinField: false
    }
    const { tab } = fakeTab(mainSignals, [{ url: 'https://kpad.payco.com/', result: frameSignals }])
    expect(await pageBridge.keypadSignalsAll(tab)).toEqual([mainSignals, frameSignals])
  })
})

describe('pageBridge.keypadUnlabeled — 글자 없는 키패드 칸', () => {
  const cell = (id: number): Record<string, number> => ({ id, x: 0, y: 0, width: 60, height: 40 })

  it('메인 프레임에만 묻고 칸 목록을 그대로 준다', async () => {
    const { tab, mainCalls } = fakeTab(
      [cell(1), cell(2)],
      [{ url: 'https://kpad.payco.com/', result: null }]
    )
    frameCalls.length = 0
    expect(await pageBridge.keypadUnlabeled(tab)).toEqual([cell(1), cell(2)])
    expect(mainCalls).toEqual(['__samba.keypadUnlabeled()'])
    expect(frameCalls).toEqual([])
  })

  it('null 은 null, 모양이 틀린 결과는 믿지 않고 던진다', async () => {
    expect(await pageBridge.keypadUnlabeled(fakeTab(null, []).tab)).toBeNull()
    await expect(pageBridge.keypadUnlabeled(fakeTab([{ id: 'x' }], []).tab)).rejects.toThrow(
      /unexpected page result/
    )
  })
})

describe('pageBridge.keypadLayout / keypadFilled — 결제 키패드 배치', () => {
  const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
  const layout = (
    filled: number | null = 0
  ): { digits: { digit: string; id: number }[]; filled: number | null } => ({
    digits: DIGITS.map((d, i) => ({ digit: d, id: 10 + i })),
    filled
  })

  it('메인 프레임에 배치가 있으면 그 id 그대로(프레임 0)', async () => {
    const { tab } = fakeTab(layout(), [])
    const r = await pageBridge.keypadLayout(tab)
    expect(r?.frameIndex).toBe(0)
    expect(r?.digits['7']).toBe(17)
    expect(r?.filled).toBe(0)
  })

  it('메인에 없고 iframe 에 있으면 프레임 번호를 얹은 id 를 준다(그대로 click 가능)', async () => {
    const { tab } = fakeTab(null, [
      { url: 'https://ads.example/x', result: null },
      { url: 'https://kpad.payco.com/', result: layout(3) }
    ])
    const r = await pageBridge.keypadLayout(tab)
    expect(r?.frameIndex).toBe(2)
    expect(r?.digits['0']).toBe(200010)
    expect(r?.filled).toBe(3)
    expect(frameCalls.map((c) => c.op)).toEqual([{ op: 'keypadLayout' }, { op: 'keypadLayout' }])
  })

  it('어느 프레임에도 없으면 null', async () => {
    const { tab } = fakeTab(null, [{ url: 'https://kpad.payco.com/', result: null }])
    expect(await pageBridge.keypadLayout(tab)).toBeNull()
  })

  it('숫자가 아닌 digit 이 섞여 오면 페이지 결과를 믿지 않고 던진다', async () => {
    const bad = { digits: [{ digit: 'x', id: 1 }], filled: null }
    const { tab } = fakeTab(bad, [])
    await expect(pageBridge.keypadLayout(tab)).rejects.toThrow(/unexpected page result/)
  })

  it('keypadFilled 는 그 프레임의 자리수만 돌려준다', async () => {
    const { tab } = fakeTab(layout(1), [{ url: 'https://kpad.payco.com/', result: layout(4) }])
    expect(await pageBridge.keypadFilled(tab, 0)).toBe(1)
    expect(await pageBridge.keypadFilled(tab, 1)).toBe(4)
    await expect(pageBridge.keypadFilled(tab, 5)).rejects.toThrow(/frame 5 is gone/)
  })
})

describe('pageBridge.rectOf / clickAt — 실제 마우스 클릭 폴백', () => {
  it('메인 프레임 요소의 좌표를 격리 월드에서 물어본다', async () => {
    const { tab, mainCalls } = fakeTab({ x: 120, y: 340 }, [])
    expect(await pageBridge.rectOf(tab, 7)).toEqual({ x: 120, y: 340 })
    expect(mainCalls).toEqual(['__samba.rectOf(7)'])
  })

  it('iframe 안 요소는 화면 좌표를 알 수 없어 null 이다', async () => {
    const { tab, mainCalls } = fakeTab({ x: 1, y: 2 }, [{ url: POSTCODE, result: null }])
    expect(await pageBridge.rectOf(tab, 100015)).toBeNull()
    expect(mainCalls).toEqual([])
    expect(frameCalls).toEqual([])
  })

  it('좌표를 못 구하면 null 을 그대로 돌려준다', async () => {
    const { tab } = fakeTab(null, [])
    expect(await pageBridge.rectOf(tab, 3)).toBeNull()
  })

  it('clickAt 은 mouseDown·mouseUp 한 벌을 보낸다', () => {
    const { tab, inputEvents } = fakeTab(null, [])
    expect(pageBridge.clickAt(tab, 120.4, 340.6)).toBe(true)
    expect(inputEvents).toEqual([
      { type: 'mouseDown', x: 120, y: 341, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 120, y: 341, button: 'left', clickCount: 1 }
    ])
  })

  it('좌표가 화면 밖(음수)이면 보내지 않는다', () => {
    const { tab, inputEvents } = fakeTab(null, [])
    expect(pageBridge.clickAt(tab, -5, 10)).toBe(false)
    expect(inputEvents).toEqual([])
  })
})

describe('pageBridge.typeLogin — 로그인 칸 진짜 키 입력', () => {
  // fakeTab 의 mainResult 는 rectOf 와 valueLength 응답에 같이 쓰인다 — 좌표 객체를 주면 rectOf 가,
  // 숫자를 주면 valueLength 가 그 값을 받는다. 여기서는 순서대로 다른 응답을 주는 가짜를 따로 만든다
  function typingTab(replies: unknown[]): {
    tab: Tab
    mainCalls: string[]
    inputEvents: Record<string, unknown>[]
  } {
    const mainCalls: string[] = []
    const inputEvents: Record<string, unknown>[] = []
    const mainFrame: { url: string; framesInSubtree: unknown[] } = {
      url: 'https://www.gsshop.com/cust/login/login.gs',
      framesInSubtree: []
    }
    mainFrame.framesInSubtree = [mainFrame]
    const webContents = {
      isDestroyed: () => false,
      mainFrame,
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
        mainCalls.push(scripts[0].code)
        return replies.shift()
      },
      sendInputEvent: (ev: Record<string, unknown>) => inputEvents.push(ev)
    }
    return { tab: { view: { webContents } } as unknown as Tab, mainCalls, inputEvents }
  }

  it('클릭 뒤 그 칸에 포커스가 없으면 키를 하나도 보내지 않는다(다른 칸에 쳐지는 사고 방지)', async () => {
    // 포커스 확인 3번(처음 + 다시 누르기 2번)과 직접 포커스까지 모두 실패
    const { tab, inputEvents } = typingTab([{ x: 10, y: 20 }, false, false, false, false, false, 'ok'])
    await pageBridge.typeLogin(tab, 5, 'a@1')
    // Tab 으로 칸을 옮겨 보는 것 말고는 글자 키를 보내지 않는다
    expect(inputEvents.some((e) => e.type === 'char')).toBe(false)
    expect(inputEvents.filter((e) => e.type === 'keyDown').map((e) => e.keyCode)).toEqual(['Tab'])
  })

  it('요소를 실제 클릭해 포커스한 뒤 전체 선택하고 글자별 char 이벤트로 친다', async () => {
    const { tab, mainCalls, inputEvents } = typingTab([{ x: 10, y: 20 }, true, 3])
    expect(await pageBridge.typeLogin(tab, 5, 'a@1')).toBe('ok')
    expect(mainCalls).toEqual([
      '__samba.rectOf(5)',
      '__samba.hasFocus(5)',
      '__samba.valueLength(5)'
    ])
    // 사람처럼 보이려 넣는 마우스 이동은 순서 검증에서 뺀다
    const types = inputEvents
      .filter((e) => e.type !== 'mouseMove')
      .map((e) => `${e.type}:${e.keyCode ?? ''}`)
    expect(types).toEqual([
      'mouseDown:',
      'mouseUp:',
      'keyDown:A',
      'keyUp:A',
      'keyDown:a',
      'char:a',
      'keyUp:a',
      // '@' 는 가속기 이름이 아니라 char 만 보낸다
      'char:@',
      'keyDown:1',
      'char:1',
      'keyUp:1'
    ])
    // 값은 어떤 코드 문자열에도 들어가지 않는다
    expect(mainCalls.some((c) => c.includes('a@1'))).toBe(false)
  })

  it('좌표를 못 구하면(프레임 안 요소) fillValue 로 돌아간다', async () => {
    const { tab, mainCalls, inputEvents } = typingTab([null, 'ok'])
    expect(await pageBridge.typeLogin(tab, 5, 'pw')).toBe('ok')
    expect(inputEvents).toEqual([])
    expect(mainCalls[1]).toContain('__samba.fillValue(5,')
  })

  it('친 뒤 글자 수가 다르면(포커스 실패) fillValue 로 돌아간다', async () => {
    const { tab, mainCalls } = typingTab([{ x: 10, y: 20 }, true, 0, 'ok'])
    expect(await pageBridge.typeLogin(tab, 5, 'pw')).toBe('ok')
    expect(mainCalls[3]).toContain('__samba.fillValue(5,')
  })
})
