import { describe, it, expect, vi } from 'vitest'

// SDK 의 tool() 을 얇게 대체해 도구 핸들러를 직접 부를 수 있게 한다(다른 agent 테스트와 같은 방식)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

const { createPhoneTools, createPhoneOps, PHONE_TOOL_NAMES, PAYMENT_PACKAGES } =
  await import('../src/main/agent/tools-phone')
const { FakeAdb } = await import('./stubs/fake-adb')
type PhoneToolContext = import('../src/main/agent/tools-phone').PhoneToolContext
type PhoneOps = import('../src/main/agent/tools-phone').PhoneOps
type PhoneScreen = import('../src/shared/phone-snapshot').PhoneScreen
type PhoneDto = import('../src/shared/phone').PhoneDto

type ImageBlock = { type: 'image'; data: string; mimeType: string }
type TextBlock = { type: 'text'; text: string }
interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: (ImageBlock | TextBlock)[] }>
}

const SERIAL = 'R3CRA05HY3R'

function fakePhone(serial = SERIAL): PhoneDto {
  return {
    id: 1,
    serial,
    label: '폰1',
    country: 'KR',
    transport: 'usb',
    wifiAddress: null,
    model: 'SM-A536N',
    state: 'online',
    smsQueryOk: true,
    lastSeenAt: 0,
    screenMode: null
  }
}

function fakeScreen(app = 'com.android.chrome'): PhoneScreen {
  return {
    serial: SERIAL,
    width: 720,
    height: 1600,
    app,
    elements: [
      {
        id: 1,
        text: '다음',
        className: 'android.widget.Button',
        clickable: true,
        bounds: { l: 100, t: 200, r: 300, b: 260 },
        center: { x: 200, y: 230 },
        isSecret: false
      }
    ]
  }
}

interface Built {
  tools: ToolStub[]
  ops: { [K in keyof PhoneOps]: ReturnType<typeof vi.fn> }
  confirm: ReturnType<typeof vi.fn>
  steps: Array<{ label: string; ok: boolean }>
  ctx: PhoneToolContext
}

function build(
  opts: {
    mode?: PhoneToolContext['mode']
    confirmResult?: boolean
    phones?: PhoneDto[]
    screen?: PhoneScreen
    secret?: boolean
    /** uiautomator 덤프 실패(판정 불가) 상황 */
    unknownScreen?: boolean
    typeResult?: 'ok' | 'unsupported-text'
    tick?: () => string | null
    waitForSmsCode?: PhoneToolContext['waitForSmsCode']
  } = {}
): Built {
  const list = opts.phones ?? [fakePhone()]
  const ops = {
    list: vi.fn(() => list),
    screen: vi.fn(async () => opts.screen ?? fakeScreen()),
    tap: vi.fn(async () => {}),
    swipe: vi.fn(async () => {}),
    typeText: vi.fn(async () => opts.typeResult ?? 'ok'),
    key: vi.fn(async () => {}),
    screenshot: vi.fn(async () => ({
      png: opts.unknownScreen ? Buffer.alloc(0) : Buffer.from('fake-png-bytes'),
      secret: opts.unknownScreen ? true : (opts.secret ?? false),
      unknown: opts.unknownScreen ?? false
    })),
    isSecret: vi.fn(() => opts.secret ?? false)
  }
  const confirm = vi.fn(async () => opts.confirmResult ?? true)
  const steps: Array<{ label: string; ok: boolean }> = []
  const ctx: PhoneToolContext = {
    phones: ops as unknown as PhoneOps,
    mode: opts.mode ?? 'guard',
    assigned: () => null,
    confirm,
    tick: opts.tick ?? ((): string | null => null),
    onStep: (label, ok) => steps.push({ label, ok }),
    waitForSmsCode: opts.waitForSmsCode
  }
  return { tools: createPhoneTools(ctx) as unknown as ToolStub[], ops, confirm, steps, ctx }
}

const get = (tools: ToolStub[], name: string): ToolStub => tools.find((t) => t.name === name)!
const textOut = (r: { content: (ImageBlock | TextBlock)[] }): string => {
  const block = r.content.find((c): c is TextBlock => c.type === 'text')
  return block?.text ?? ''
}
const WRITE_TOOLS = ['phone_tap', 'phone_type', 'phone_key', 'phone_swipe']
const ARGS: Record<string, Record<string, unknown>> = {
  phone_get_screen: {},
  phone_tap: { x: 100, y: 100 },
  phone_type: { text: 'hello' },
  phone_key: { key: 'back' },
  phone_swipe: { from: { x: 10, y: 900 }, to: { x: 10, y: 200 } },
  phone_screenshot: {},
  phone_open_window: {},
  wait_for_sms_code: {}
}

describe('폰 도구 목록', () => {
  it('도구 8종의 이름이 정해진 이름과 같다', () => {
    const { tools } = build()
    expect(tools.map((t) => t.name)).toEqual([
      'phone_get_screen',
      'phone_tap',
      'phone_type',
      'phone_key',
      'phone_swipe',
      'phone_screenshot',
      'phone_open_window',
      'wait_for_sms_code'
    ])
    expect(PHONE_TOOL_NAMES).toEqual(tools.map((t) => t.name))
  })
})

describe('권한 모드(read_only)', () => {
  it('조작 도구 4종은 read-only 거부를 돌려주고 폰을 건드리지 않는다', async () => {
    const { tools, ops } = build({ mode: 'read_only' })
    for (const name of WRITE_TOOLS) {
      const r = await get(tools, name).handler(ARGS[name])
      expect(textOut(r)).toBe('refused: read-only mode')
    }
    expect(ops.tap).not.toHaveBeenCalled()
    expect(ops.typeText).not.toHaveBeenCalled()
    expect(ops.key).not.toHaveBeenCalled()
    expect(ops.swipe).not.toHaveBeenCalled()
  })

  it('조회 도구 2종은 read-only 에서도 동작한다', async () => {
    const { tools, ops } = build({ mode: 'read_only' })
    const screen = await get(tools, 'phone_get_screen').handler({})
    expect(textOut(screen)).toContain('ELEMENTS:')
    expect(ops.screen).toHaveBeenCalledWith(SERIAL)

    const shot = await get(tools, 'phone_screenshot').handler({})
    expect(shot.content.some((c) => c.type === 'image')).toBe(true)
  })
})

describe('phone_tap', () => {
  it('요소 번호를 주면 그 요소의 center 를 탭한다', async () => {
    const { tools, ops } = build()
    const r = await get(tools, 'phone_tap').handler({ elementId: 1, label: '다음' })
    expect(ops.tap).toHaveBeenCalledWith(SERIAL, 200, 230)
    expect(textOut(r)).toBe('ok')
  })

  it('없는 요소 번호는 not found 를 돌려준다', async () => {
    const { tools, ops } = build()
    const r = await get(tools, 'phone_tap').handler({ elementId: 99 })
    expect(textOut(r)).toBe('not found')
    expect(ops.tap).not.toHaveBeenCalled()
  })

  it('좌표를 직접 주면 그대로 탭한다', async () => {
    const { tools, ops } = build()
    const r = await get(tools, 'phone_tap').handler({ x: 360, y: 800 })
    expect(ops.tap).toHaveBeenCalledWith(SERIAL, 360, 800)
    expect(textOut(r)).toBe('ok')
  })

  it('요소 번호도 좌표도 없으면 거부한다', async () => {
    const { tools, ops } = build()
    const r = await get(tools, 'phone_tap').handler({})
    expect(textOut(r)).toContain('refused')
    expect(ops.tap).not.toHaveBeenCalled()
  })
})

describe('연결된 폰이 없을 때', () => {
  it('6종 모두 no phone connected 를 돌려준다', async () => {
    const { tools } = build({ phones: [] })
    for (const t of tools) {
      expect(textOut(await t.handler(ARGS[t.name]))).toBe('no phone connected')
    }
  })

  it('배정된 폰이 없으면 연결된 첫 폰을 쓴다', async () => {
    const { tools, ops } = build({ phones: [fakePhone('OTHER'), fakePhone('SECOND')] })
    await get(tools, 'phone_get_screen').handler({})
    expect(ops.screen).toHaveBeenCalledWith('OTHER')
  })
})

describe('guard 모드의 결제 앱 확인', () => {
  it('결제 앱 화면이면 조작 전에 확인 카드를 띄운다', async () => {
    const { tools, ops, confirm } = build({ screen: fakeScreen(PAYMENT_PACKAGES[0]) })
    const r = await get(tools, 'phone_tap').handler({ x: 10, y: 10 })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(textOut(r)).toBe('ok')
    expect(ops.tap).toHaveBeenCalled()
  })

  it('사용자가 거부하면 refused: user declined 를 돌려주고 조작하지 않는다', async () => {
    const { tools, ops, confirm } = build({
      screen: fakeScreen(PAYMENT_PACKAGES[0]),
      confirmResult: false
    })
    const r = await get(tools, 'phone_type').handler({ text: 'hello' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(textOut(r)).toBe('refused: user declined')
    expect(ops.typeText).not.toHaveBeenCalled()
  })

  it('결제 앱이 아니면 확인 없이 진행한다', async () => {
    const { tools, confirm } = build()
    await get(tools, 'phone_key').handler({ key: 'back' })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('full 모드는 결제 앱이어도 확인을 생략한다', async () => {
    const { tools, confirm, ops } = build({
      mode: 'full',
      screen: fakeScreen(PAYMENT_PACKAGES[0])
    })
    await get(tools, 'phone_tap').handler({ x: 1, y: 1 })
    expect(confirm).not.toHaveBeenCalled()
    expect(ops.tap).toHaveBeenCalled()
  })
})

describe('phone_type', () => {
  it('한글처럼 adb 로 못 보내는 글자는 키보드 탭으로 우회하라고 알려 준다', async () => {
    const { tools } = build({ typeResult: 'unsupported-text' })
    const r = await get(tools, 'phone_type').handler({ text: '안녕하세요' })
    expect(textOut(r)).toBe('unsupported-text: use phone_tap on the keyboard')
  })
})

describe('phone_key', () => {
  it('정해진 키만 받는다', async () => {
    const { tools, ops } = build()
    expect(textOut(await get(tools, 'phone_key').handler({ key: 'home' }))).toBe('ok')
    expect(ops.key).toHaveBeenCalledWith(SERIAL, 'home')
    const bad = await get(tools, 'phone_key').handler({ key: 'volume_up' })
    expect(textOut(bad)).toContain('refused')
    expect(ops.key).toHaveBeenCalledTimes(1)
  })
})

describe('phone_swipe', () => {
  it('두 점과 시간을 그대로 전달한다', async () => {
    const { tools, ops } = build()
    await get(tools, 'phone_swipe').handler({
      from: { x: 10, y: 900 },
      to: { x: 10, y: 200 },
      ms: 500
    })
    expect(ops.swipe).toHaveBeenCalledWith(SERIAL, { x: 10, y: 900 }, { x: 10, y: 200 }, 500)
  })
})

describe('phone_screenshot', () => {
  it('비밀번호 화면이면 이미지를 돌려주지 않는다', async () => {
    const { tools } = build({ secret: true })
    const r = await get(tools, 'phone_screenshot').handler({})
    expect(r.content.some((c) => c.type === 'image')).toBe(false)
    expect(textOut(r)).toBe('refused: secret screen')
  })

  it('보통 화면은 PNG 이미지 블록을 돌려준다', async () => {
    const { tools } = build()
    const r = await get(tools, 'phone_screenshot').handler({})
    const image = r.content.find((c): c is ImageBlock => c.type === 'image')
    expect(image?.mimeType).toBe('image/png')
    expect(image?.data).toBe(Buffer.from('fake-png-bytes').toString('base64'))
  })
})

describe('화면 판정 불가(uiautomator 덤프 실패)', () => {
  const UNKNOWN = 'refused: cannot read the phone screen, so it may be a secret screen'
  const blank = (): PhoneScreen => ({
    serial: SERIAL,
    width: 0,
    height: 0,
    app: 'com.example.app',
    elements: []
  })

  it('phone_get_screen 은 거부한다', async () => {
    const { tools, steps } = build({ screen: blank() })
    expect(textOut(await get(tools, 'phone_get_screen').handler({}))).toBe(UNKNOWN)
    expect(steps.at(-1)).toEqual({ label: '폰 화면 읽기', ok: false })
  })

  it('phone_screenshot 은 이미지를 돌려주지 않는다', async () => {
    const { tools, steps } = build({ unknownScreen: true })
    const r = await get(tools, 'phone_screenshot').handler({})
    expect(r.content.some((c) => c.type === 'image')).toBe(false)
    expect(textOut(r)).toBe(UNKNOWN)
    expect(steps.at(-1)).toEqual({ label: '폰 화면 캡처', ok: false })
  })

  it('createPhoneOps 는 덤프가 실패하면 screencap 을 부르지 않는다', async () => {
    const adb = new FakeAdb()
    // uiautomator dump 가 0 이 아닌 코드로 끝나 화면을 읽지 못한 상황
    adb.reply('uiautomator dump', 'ERROR: could not get idle state', 1)
    adb.replyBinary('screencap -p', Buffer.from('png-bytes'))
    const ops = createPhoneOps(adb, () => [fakePhone()])
    const shot = await ops.screenshot(SERIAL)
    expect(shot.unknown).toBe(true)
    expect(shot.secret).toBe(true)
    expect(shot.png.length).toBe(0)
    expect(adb.calls.some((c) => c.join(' ').includes('screencap'))).toBe(false)
  })
})

describe('도구 호출 상한', () => {
  it('웹 도구와 같은 tick 을 6종이 함께 쓴다', async () => {
    let calls = 0
    const tick = (): string | null => (++calls > 3 ? 'tool call limit reached' : null)
    const { tools, ops } = build({ tick })
    expect(textOut(await get(tools, 'phone_get_screen').handler({}))).toContain('ELEMENTS:')
    expect(textOut(await get(tools, 'phone_tap').handler({ x: 1, y: 1 }))).toBe('ok')
    expect(textOut(await get(tools, 'phone_key').handler({ key: 'back' }))).toBe('ok')
    expect(textOut(await get(tools, 'phone_screenshot').handler({}))).toBe(
      'tool call limit reached'
    )
    expect(ops.screenshot).not.toHaveBeenCalled()
  })
})

describe('금고 비접근', () => {
  it('PhoneToolContext 에 vault 키가 없다', () => {
    const { ctx } = build()
    expect(Object.keys(ctx)).not.toContain('vault')
    expect(Object.keys(ctx).sort()).toEqual([
      'assigned',
      'confirm',
      'mode',
      'onStep',
      'phones',
      'tick',
      'waitForSmsCode'
    ])
  })
})

describe('createPhoneOps — adb 배선', () => {
  const SECRET_XML =
    '<hierarchy><node class="android.widget.EditText" resource-id="com.toss:id/pin" ' +
    'password="true" clickable="true" bounds="[0,0][720,100]" /></hierarchy>'
  const PLAIN_XML =
    '<hierarchy><node text="확인" class="android.widget.Button" clickable="true" ' +
    'bounds="[0,0][720,100]" /></hierarchy>'

  it('보통 화면은 screencap PNG 를 그대로 돌려준다', async () => {
    const adb = new FakeAdb()
    adb.reply('cat /sdcard/samba-ui.xml', PLAIN_XML)
    adb.replyBinary('screencap -p', Buffer.from('png-bytes'))
    const ops = createPhoneOps(adb, () => [fakePhone()])
    const shot = await ops.screenshot(SERIAL)
    expect(shot.secret).toBe(false)
    expect(shot.png).toEqual(Buffer.from('png-bytes'))
  })

  it('비밀 입력칸이 보이는 화면은 캡처를 뜨지도 않는다', async () => {
    const adb = new FakeAdb()
    adb.reply('cat /sdcard/samba-ui.xml', SECRET_XML)
    adb.replyBinary('screencap -p', Buffer.from('png-bytes'))
    const ops = createPhoneOps(adb, () => [fakePhone()])
    const shot = await ops.screenshot(SERIAL)
    expect(shot.secret).toBe(true)
    expect(shot.png.length).toBe(0)
    expect(adb.calls.some((c) => c.join(' ').includes('screencap'))).toBe(false)
  })

  it('결제 앱 비밀번호 문구가 보이면 캡처를 뜨지 않는다(password 속성이 없어도)', async () => {
    const adb = new FakeAdb()
    adb.reply(
      'cat /sdcard/samba-ui.xml',
      '<hierarchy><node text="결제 비밀번호를 입력하세요" class="android.widget.TextView" ' +
        'bounds="[0,0][720,100]" /></hierarchy>'
    )
    adb.replyBinary('screencap -p', Buffer.from('png-bytes'))
    const ops = createPhoneOps(adb, () => [fakePhone()])
    const shot = await ops.screenshot(SERIAL)
    expect(shot.secret).toBe(true)
    expect(adb.calls.some((c) => c.join(' ').includes('screencap'))).toBe(false)
  })

  it('결제 실행기가 세운 표식(SecretScreenGate)만으로도 캡처를 막는다', async () => {
    const adb = new FakeAdb()
    adb.reply('cat /sdcard/samba-ui.xml', PLAIN_XML)
    adb.replyBinary('screencap -p', Buffer.from('png-bytes'))
    const ops = createPhoneOps(adb, () => [fakePhone()], { isSecret: () => true })
    const shot = await ops.screenshot(SERIAL)
    expect(shot.secret).toBe(true)
    expect(shot.png.length).toBe(0)
  })

  it('phone_get_screen 은 비밀 화면이면 요소 목록도 넘기지 않는다', async () => {
    const { tools, steps } = build({ secret: true })
    const r = await get(tools, 'phone_get_screen').handler({})
    expect(textOut(r)).toBe('refused: secret screen')
    expect(steps.at(-1)).toEqual({ label: '폰 화면 읽기', ok: false })
  })

  it('탭·입력·키를 adb input 으로 넘긴다', async () => {
    const adb = new FakeAdb()
    const ops = createPhoneOps(adb, () => [fakePhone()])
    await ops.tap(SERIAL, 100, 200)
    await ops.key(SERIAL, 'back')
    expect(await ops.typeText(SERIAL, '안녕')).toBe('unsupported-text')
    const calls = adb.calls.map((c) => c.join(' '))
    expect(calls).toContain(`-s ${SERIAL} shell input tap 100 200`)
    expect(calls).toContain(`-s ${SERIAL} shell input keyevent KEYCODE_BACK`)
    // 보낼 수 없는 글자는 adb 를 부르지 않는다
    expect(calls.some((c) => c.includes('input text'))).toBe(false)
  })
})

describe('wait_for_sms_code', () => {
  it('성공하면 자릿수만 마스킹해 돌려준다(인증번호 값은 나가지 않는다)', async () => {
    const waitForSmsCode = vi.fn(async () => ({ filled: true, digits: 6 }))
    const { tools, steps } = build({ waitForSmsCode })
    const r = await get(tools, 'wait_for_sms_code').handler({ host: 'toss.im' })
    expect(textOut(r)).toBe('filled: ######')
    expect(waitForSmsCode).toHaveBeenCalledWith('toss.im')
    expect(steps.at(-1)).toEqual({ label: '문자 인증 대기', ok: true })
  })

  it('문자가 오지 않으면 timeout 이다', async () => {
    const { tools } = build({ waitForSmsCode: vi.fn(async () => ({ filled: false, digits: 0 })) })
    const r = await get(tools, 'wait_for_sms_code').handler({})
    expect(textOut(r)).toBe('timeout')
  })

  it('인증 흐름이 배선되지 않으면 거부한다', async () => {
    const { tools } = build()
    const r = await get(tools, 'wait_for_sms_code').handler({})
    expect(textOut(r)).toBe('refused: sms auth is not available')
  })

  it('read_only 모드에서는 부르지 않는다', async () => {
    const waitForSmsCode = vi.fn(async () => ({ filled: true, digits: 6 }))
    const { tools } = build({ mode: 'read_only', waitForSmsCode })
    const r = await get(tools, 'wait_for_sms_code').handler({})
    expect(textOut(r)).toBe('refused: read-only mode')
    expect(waitForSmsCode).not.toHaveBeenCalled()
  })
})

describe('phone_open_window', () => {
  it('배선된 큰 화면 열기를 부르고, 배선 전이면 거절한다', async () => {
    const opened: string[] = []
    const { tools, ctx } = build()
    expect(textOut(await get(tools, 'phone_open_window').handler({}))).toContain('refused')
    ctx.phones.openWindow = (s: string): void => void opened.push(s)
    expect(textOut(await get(tools, 'phone_open_window').handler({}))).toBe('ok')
    expect(opened.length).toBe(1)
  })
})
