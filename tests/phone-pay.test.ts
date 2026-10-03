// 간편결제 앱 승인 흐름. 상한 검사·확인 카드·상태 전이와 "재시도 없음" 을 단언한다

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// SDK 의 tool() 을 얇게 대체해 도구 핸들러를 직접 부른다(다른 agent 테스트와 같은 방식)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

import {
  PAY_APP_TO_PAYMENT_PROVIDER,
  PAY_PROVIDERS,
  cardPatternOf,
  findPayNotification,
  parseAppNotifications,
  checkPaymentGate,
  nextPayState,
  runPayApproval,
  type PayRequest,
  type PayResult,
  type PayRunDeps,
  selectedCardOf
} from '../src/main/phone/pay'
import { createPayTool, PAY_TOOL_NAME, PHONE_TOOL_NAMES } from '../src/main/agent/tools-phone'
import { SAMBA_TOOL_NAMES } from '../src/main/agent/tools'

// 사용자가 설정에 적어 넣은 상한(테스트용 값). 기본값은 둘 다 없음(0)이다
import type { PhoneElement, PhoneScreen } from '../src/shared/phone-snapshot'
import type { KeypadLayout } from '../src/main/ai/visual'

const SERIAL = 'R3CRA05HY3R'
const TOSS = PAY_PROVIDERS.toss

function el(id: number, text: string, extra: Partial<PhoneElement> = {}): PhoneElement {
  return {
    id,
    text,
    className: 'android.widget.Button',
    clickable: true,
    bounds: { l: 0, t: id * 100, r: 200, b: id * 100 + 60 },
    center: { x: 100, y: id * 100 + 30 },
    isSecret: false,
    ...extra
  }
}

function screen(app: string, elements: PhoneElement[] = []): PhoneScreen {
  return { serial: SERIAL, width: 720, height: 1600, app, elements }
}

const fullLayout: KeypadLayout = {
  digits: Object.fromEntries(
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => [
      d,
      { x: Number(d) * 10, y: 500 }
    ])
  )
}

function request(over: Partial<PayRequest> = {}): PayRequest {
  return {
    provider: 'toss',
    amountKrw: 12_000,
    merchant: '삼바상회',
    methodLabel: '토스페이',
    phoneLabel: '내 폰',
    accountId: 7,
    phoneId: 1,
    serial: SERIAL,
    siteHost: 'shop.example.com',
    jobId: 'job-1',
    ...over
  }
}

interface Harness {
  deps: PayRunDeps
  screens: PhoneScreen[]
  taps: Array<[string, number, number]>
  /** 뒤로 키를 누른 폰 목록(시험 입력 취소) */
  backs: string[]
  confirm: ReturnType<typeof vi.fn>
  tapPassword: ReturnType<typeof vi.fn>
  records: Array<{ kind: string; ok: boolean; dryRunDigits?: number }>
  notices: Array<{ message: string; hasImage: boolean }>
  steps: Array<{ label: string; ok: boolean }>
}

/** screens 를 순서대로 돌려주고, 다 쓰면 마지막 화면을 계속 돌려준다 */
function harness(
  opts: {
    screens?: PhoneScreen[]
    confirmResult?: boolean
    vaultUnlocked?: boolean
    webSuccess?: boolean
    password?: 'ok' | 'locked' | 'not-found' | 'ambiguous' | 'layout-incomplete'
    uiKeypad?: KeypadLayout | null
    visualKeypad?: KeypadLayout | null
    screenshotSecret?: boolean
  } = {}
): Harness {
  const screens = opts.screens ?? [screen('viva.republica.toss')]
  const taps: Array<[string, number, number]> = []
  const backs: string[] = []
  const records: Array<{ kind: string; ok: boolean; dryRunDigits?: number }> = []
  const notices: Array<{ message: string; hasImage: boolean }> = []
  const steps: Array<{ label: string; ok: boolean }> = []
  const confirm = vi.fn(async () => opts.confirmResult ?? true)
  const tapPassword = vi.fn(async () => opts.password ?? 'ok')
  let idx = 0
  let clock = 1000

  const deps: PayRunDeps = {
    phones: {
      screen: async () => screens[Math.min(idx++, screens.length - 1)],
      tap: async (serial, x, y) => {
        taps.push([serial, x, y])
      },
      screenshot: async () =>
        opts.screenshotSecret
          ? { png: Buffer.alloc(0), secret: true }
          : { png: Buffer.from([1, 2, 3]), secret: false },
      back: async (serial) => {
        backs.push(serial)
      }
    },
    launchApp: vi.fn(async () => {}),
    confirm,
    vault: {
      state: () => 'unlocked',
      getPaymentSecretForFill: () => ({ value: '149072' })
    },
    vaultUnlocked: () => opts.vaultUnlocked ?? true,
    keypad: {
      fromUiTree: () => (opts.uiKeypad === undefined ? fullLayout : opts.uiKeypad),
      fromVisual: async () => opts.visualKeypad ?? null
    },
    webSuccess: async () => opts.webSuccess ?? true,
    record: (e) =>
      records.push({
        kind: e.kind,
        ok: e.ok,
        ...(e.dryRunDigits === undefined ? {} : { dryRunDigits: e.dryRunDigits })
      }),
    notify: (message, png) => notices.push({ message, hasImage: png !== undefined }),
    onStep: (label, ok) => steps.push({ label, ok }),
    now: () => (clock += 10),
    sleep: async () => {},
    tapPassword
  }
  return { deps, screens, taps, backs, confirm, tapPassword, records, notices, steps }
}

describe('PAY_APP_TO_PAYMENT_PROVIDER', () => {
  it('결제앱 4종이 모두 금고 결제 수단으로 이어진다', () => {
    expect(PAY_APP_TO_PAYMENT_PROVIDER).toEqual({
      toss: 'toss',
      payco: 'payco',
      kakaopay: 'kakao',
      naverpay: 'naver',
      alipay: 'alipay'
    })
    // 앱 목록과 매핑표가 어긋나면(새 앱 추가 후 매핑 누락) 여기서 걸린다
    expect(Object.keys(PAY_APP_TO_PAYMENT_PROVIDER).sort()).toEqual(
      Object.keys(PAY_PROVIDERS).sort()
    )
  })
})

describe('checkPaymentGate', () => {
  it('금액이 양수고 금고가 열려 있으면 ok — 금액 상한은 두지 않는다', () => {
    expect(checkPaymentGate({ amountKrw: 10_000, vaultUnlocked: true })).toBe('ok')
    expect(checkPaymentGate({ amountKrw: 10_000_000, vaultUnlocked: true })).toBe('ok')
  })

  it('금액이 0 이하면 bad-amount', () => {
    expect(checkPaymentGate({ amountKrw: 0, vaultUnlocked: true })).toBe('bad-amount')
  })

  it('금고가 잠겨 있으면 vault-locked', () => {
    expect(checkPaymentGate({ amountKrw: 10_000, vaultUnlocked: false })).toBe('vault-locked')
  })
})

describe('nextPayState', () => {
  it('앱 패키지가 뜨면 app_steps 로 가고 확인 버튼 번호를 함께 돌려준다', () => {
    const s = screen('viva.republica.toss', [
      el(1, '결제하기'),
      el(90, '결제수단 변경 ・ 설정', { clickable: false })
    ])
    expect(nextPayState('await_app', s, TOSS)).toEqual({ state: 'app_steps', tapElementId: 1 })
  })

  it('앱이 아직 안 떴으면 await_app 을 유지한다', () => {
    const s = screen('com.android.chrome', [el(1, '결제하기')])
    expect(nextPayState('await_app', s, TOSS)).toEqual({ state: 'await_app' })
  })

  it('비밀번호 화면 표식이 보이면 password', () => {
    const s = screen('viva.republica.toss', [el(1, '간편비밀번호 입력', { clickable: false })])
    expect(nextPayState('app_steps', s, TOSS)).toEqual({ state: 'password' })
  })

  it('비밀 입력칸만 있어도 password 로 본다', () => {
    const s = screen('viva.republica.toss', [el(1, '', { isSecret: true, clickable: false })])
    expect(nextPayState('app_steps', s, TOSS)).toEqual({ state: 'password' })
  })

  it('성공 표식이 보이면 verify', () => {
    const s = screen('viva.republica.toss', [el(1, '결제 완료', { clickable: false })])
    expect(nextPayState('app_steps', s, TOSS)).toEqual({ state: 'verify' })
  })

  it('verify 에서 성공 표식을 다시 보면 done', () => {
    const s = screen('viva.republica.toss', [el(1, '결제가 완료되었습니다', { clickable: false })])
    expect(nextPayState('verify', s, TOSS)).toEqual({ state: 'done' })
  })

  it('아무 표식이 없으면 상태를 유지하고 누를 곳을 주지 않는다', () => {
    const s = screen('viva.republica.toss', [el(1, '주문 내역')])
    expect(nextPayState('app_steps', s, TOSS)).toEqual({ state: 'app_steps' })
  })
})

describe('runPayApproval', () => {
  const okScreens = [
    screen('viva.republica.toss', [
      el(1, '결제하기'),
      el(90, '결제수단 변경 ・ 설정', { clickable: false })
    ]),
    screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })]),
    screen('viva.republica.toss', [el(3, '결제 완료', { clickable: false })])
  ]

  it('권한 모드와 무관하게 확인 카드를 정확히 1회 띄운다', async () => {
    const h = harness({ screens: okScreens })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: true })
    expect(h.confirm).toHaveBeenCalledTimes(1)
    // 카드에 금액·가맹점·결제수단·폰 별칭이 모두 들어간다
    const card = String(h.confirm.mock.calls[0][0])
    expect(card).toContain('12,000')
    expect(card).toContain('삼바상회')
    expect(card).toContain('토스페이')
    expect(card).toContain('내 폰')
  })

  it('사용자가 거부하면 아무것도 누르지 않고 declined', async () => {
    const h = harness({ screens: okScreens, confirmResult: false })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'declined' })
    expect(h.taps).toEqual([])
    expect(h.tapPassword).not.toHaveBeenCalled()
    expect(h.deps.launchApp).not.toHaveBeenCalled()
  })

  it('금고가 잠겨 있으면 비밀번호를 건드리지 않는다', async () => {
    const h = harness({ screens: okScreens, vaultUnlocked: false })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'vault-locked' })
    expect(h.tapPassword).not.toHaveBeenCalled()
  })

  it('알리페이 결제창이 이미 떠 있으면 앱을 다시 열지 않고 웹 확인 없이 끝낸다', async () => {
    // 실기 2026-10-01: 得物 앱이 띄운 알리페이 결제창 — 제목은 'CVV를 입력하세요'지만 6자리 결제 비밀번호다
    const ali = 'com.eg.android.AlipayGphone'
    const h = harness({
      screens: [
        screen(ali, [el(2, 'CVV를 입력하세요', { clickable: false })]),
        screen(ali, [el(2, 'CVV를 입력하세요', { clickable: false })]),
        screen(ali, [el(3, '결제 성공', { clickable: false })]),
        screen(ali, [el(3, '결제 성공', { clickable: false })])
      ],
      webSuccess: false
    })
    const r = await runPayApproval(h.deps, request({ provider: 'alipay' }))

    expect(r).toEqual({ ok: true })
    expect(h.deps.launchApp).not.toHaveBeenCalled()
    expect(h.tapPassword.mock.calls[0][0]).toMatchObject({ provider: 'alipay' })
  })

  it('결제앱에 맞는 금고 결제 수단을 비밀번호 입력기에 넘긴다', async () => {
    const h = harness({ screens: okScreens })
    await runPayApproval(h.deps, request({ provider: 'toss' }))

    expect(h.tapPassword).toHaveBeenCalledTimes(1)
    // 계정의 결제 비밀번호 아무거나가 아니라 이 앱(토스)의 항목만 읽게 좁혀 넘긴다
    expect(h.tapPassword.mock.calls[0][0]).toMatchObject({ provider: 'toss', accountId: 7 })
  })

  it('어느 결제 비밀번호인지 좁히지 못하면 password-ambiguous 로 멈춘다', async () => {
    const h = harness({ screens: okScreens, password: 'ambiguous' })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'password-ambiguous' })
  })

  it('비밀번호를 넣었는데 성공 표식이 안 뜨면 재시도 없이 verify-failed', async () => {
    const stuck = [
      screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })]),
      screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })])
    ]
    const h = harness({ screens: stuck })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'verify-failed' })
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
  })

  it('앱 완료 화면만 보이고 웹 팝업이 성공하지 않으면 실패로 본다', async () => {
    const h = harness({ screens: okScreens, webSuccess: false })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: false, reason: 'verify-failed' })
  })

  it('성공·실패 모두 app_approve 를 1건만 남긴다', async () => {
    const good = harness({ screens: okScreens })
    await runPayApproval(good.deps, request())
    expect(good.records).toEqual([{ kind: 'app_approve', ok: true }])

    const bad = harness({ screens: okScreens, webSuccess: false })
    await runPayApproval(bad.deps, request())
    expect(bad.records).toEqual([{ kind: 'app_approve', ok: false }])
  })

  it('실패 통지에 스크린샷을 붙이되 비밀번호 화면이면 이미지를 빼고 보낸다', async () => {
    // 일반 화면에서 막힌 경우 — 이미지를 붙인다
    const plain = harness({ screens: [screen('viva.republica.toss', [el(1, '주문 내역')])] })
    await runPayApproval(plain.deps, request())
    expect(plain.notices).toHaveLength(1)
    expect(plain.notices[0].hasImage).toBe(true)

    // 비밀번호 화면에서 막힌 경우 — 이미지 없이 글만 보낸다
    const secret = harness({
      screens: [screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })])],
      webSuccess: false,
      screenshotSecret: true
    })
    await runPayApproval(secret.deps, request())
    expect(secret.notices).toHaveLength(1)
    expect(secret.notices[0].hasImage).toBe(false)
  })

  it('같은 요소를 두 번 연속 탭하지 않는다', async () => {
    // 확인 버튼만 계속 보이는 화면 — 한 번 누른 뒤에는 다시 누르지 않는다
    const h = harness({
      screens: [
        screen('viva.republica.toss', [
          el(1, '결제하기'),
          el(90, '결제수단 변경 ・ 설정', { clickable: false })
        ])
      ]
    })
    const r = await runPayApproval(h.deps, request())

    expect(h.taps).toHaveLength(1)
    expect(r.ok).toBe(false)
  })

  it('UI 트리로 배치를 못 구하면 Visual 로 받아 입력한다', async () => {
    const h = harness({ screens: okScreens, uiKeypad: null, visualKeypad: fullLayout })
    const r = await runPayApproval(h.deps, request())

    expect(r).toEqual({ ok: true })
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
  })

  it('두 경로 모두 배치를 못 구하면 사람에게 넘긴다', async () => {
    const handoff = vi.fn(async () => ({ outcome: 'timeout' as const, url: '' }))
    const h = harness({
      screens: [screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })])],
      uiKeypad: null,
      visualKeypad: null
    })
    const r = await runPayApproval({ ...h.deps, handoff }, request())

    expect(handoff).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: false, reason: 'layout-incomplete' })
    expect(h.tapPassword).not.toHaveBeenCalled()
  })
})

describe('runPayApproval — 시험 입력(dry-run)', () => {
  // 결제 화면 → 비밀번호 화면 → (취소 뒤) 다시 결제 화면
  const dryScreens = [
    screen('viva.republica.toss', [
      el(1, '결제하기'),
      el(90, '결제수단 변경 ・ 설정', { clickable: false })
    ]),
    screen('viva.republica.toss', [el(2, '간편비밀번호', { clickable: false })]),
    screen('viva.republica.toss', [
      el(1, '결제하기'),
      el(90, '결제수단 변경 ・ 설정', { clickable: false })
    ])
  ]

  it('지정한 자리수만 누르고 뒤로 키로 빠져나온 뒤 dry-run 으로 끝낸다', async () => {
    const h = harness({ screens: dryScreens })
    const r = await runPayApproval(h.deps, request({ dryRunDigits: 3 }))

    expect(r).toEqual({
      ok: false,
      reason: 'dry-run',
      detail: 'typed 3 digits then cancelled'
    })
    // 비밀번호 입력기에 자리수 상한이 그대로 전달된다(재시도 없이 1회)
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
    expect(h.tapPassword.mock.calls[0][0]).toMatchObject({ maxDigits: 3 })
    // 키패드에서 빠져나온다
    expect(h.backs).toEqual([SERIAL])
    // 확인 카드는 시험 입력에서도 그대로 1회
    expect(h.confirm).toHaveBeenCalledTimes(1)
    // 결과 이벤트에 시험 입력 자리수가 남는다(성공은 아니다)
    expect(h.records).toEqual([{ kind: 'app_approve', ok: false, dryRunDigits: 3 }])
    expect(h.steps.some((x) => x.label.includes('시험 입력 취소') && x.ok)).toBe(true)
  })

  it('취소했는데 결제 완료 문구가 보이면 곧바로 알린다', async () => {
    const h = harness({
      screens: [
        dryScreens[0],
        dryScreens[1],
        screen('viva.republica.toss', [el(3, '결제가 완료되었습니다', { clickable: false })])
      ]
    })
    const r = await runPayApproval(h.deps, request({ dryRunDigits: 3 }))

    expect(r.reason).toBe('dry-run')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0].message).toContain('결제 완료 문구')
    // 비밀번호 화면 근처의 통지에는 이미지를 붙이지 않는다
    expect(h.notices[0].hasImage).toBe(false)
    expect(h.steps.some((x) => !x.ok && x.label.includes('결제 완료 문구'))).toBe(true)
  })

  it('앱 잠금 화면(토스)의 비밀번호는 끝까지 풀고 결제 비밀번호만 절반 누른다', async () => {
    const lock = screen('viva.republica.toss', [
      el(2, '앱을 켜려면 비밀번호를 눌러주세요', { clickable: false })
    ])
    const h = harness({ screens: [lock, dryScreens[0], dryScreens[1], dryScreens[2]] })
    const r = await runPayApproval(h.deps, request({ dryRunDigits: 3 }))

    expect(r.reason).toBe('dry-run')
    expect(h.tapPassword).toHaveBeenCalledTimes(2)
    // 잠금 해제에는 자리수 상한이 없고, 결제 비밀번호에만 걸린다
    expect(h.tapPassword.mock.calls[0][0].maxDigits).toBeUndefined()
    expect(h.tapPassword.mock.calls[1][0]).toMatchObject({ maxDigits: 3 })
  })

  it('시험 입력이 아니면 뒤로 키를 누르지 않는다', async () => {
    const h = harness({ screens: dryScreens })
    await runPayApproval(h.deps, request())
    expect(h.backs).toEqual([])
  })
})

describe('phone_approve_payment 도구', () => {
  interface ToolStub {
    name: string
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
  }

  function buildTool(opts: { over?: string | null; result?: PayResult } = {}): {
    tool: ToolStub
    run: ReturnType<typeof vi.fn>
    steps: Array<{ label: string; ok: boolean }>
  } {
    const run = vi.fn(async () => opts.result ?? { ok: true })
    const steps: Array<{ label: string; ok: boolean }> = []
    const built = createPayTool({
      tick: () => opts.over ?? null,
      onStep: (label, ok) => steps.push({ label, ok }),
      run
    })
    return { tool: built as unknown as ToolStub, run, steps }
  }

  const args = {
    provider: 'toss',
    amountKrw: 12_000,
    merchant: '삼바상회',
    methodLabel: '토스페이'
  }

  it('dryRunDigits 는 1~3 만 받고, 실행기에 그대로 넘긴다', async () => {
    const built = buildTool({
      result: { ok: false, reason: 'dry-run', detail: 'typed 3 digits then cancelled' }
    })
    const shape = built.tool.schema as Record<
      string,
      { safeParse: (v: unknown) => { success: boolean } }
    >
    expect(shape.dryRunDigits.safeParse(3).success).toBe(true)
    expect(shape.dryRunDigits.safeParse(1).success).toBe(true)
    expect(shape.dryRunDigits.safeParse(0).success).toBe(false)
    expect(shape.dryRunDigits.safeParse(4).success).toBe(false)
    expect(shape.dryRunDigits.safeParse(1.5).success).toBe(false)
    expect(shape.dryRunDigits.safeParse(undefined).success).toBe(true)

    const r = await built.tool.handler({ ...args, dryRunDigits: 3 })
    expect(built.run).toHaveBeenCalledWith(expect.objectContaining({ dryRunDigits: 3 }))
    expect(r.content[0].text).toBe('refused: dry-run (typed 3 digits then cancelled)')
  })

  it('dryRunDigits 를 주지 않으면 실행기에도 넘기지 않는다', async () => {
    const built = buildTool()
    await built.tool.handler({ ...args })
    expect(built.run.mock.calls[0][0]).not.toHaveProperty('dryRunDigits')
  })

  it('도구 이름은 phone_approve_payment 이며 폰 도구 목록과 분리돼 있다', () => {
    expect(buildTool().tool.name).toBe(PAY_TOOL_NAME)
    expect(PHONE_TOOL_NAMES).not.toContain(PAY_TOOL_NAME)
    expect(SAMBA_TOOL_NAMES).toContain(`mcp__samba__${PAY_TOOL_NAME}`)
  })

  it('실행기 결과를 상태 이름으로만 돌려준다', async () => {
    const good = buildTool()
    expect((await good.tool.handler(args)).content[0].text).toBe('ok')

    const bad = buildTool({ result: { ok: false, reason: 'declined' } })
    expect((await bad.tool.handler(args)).content[0].text).toBe('refused: declined')
  })

  it('호출 상한에 걸리면 실행기를 부르지 않는다', async () => {
    const t = buildTool({ over: 'refused: tool call limit reached' })
    const out = await t.tool.handler(args)

    expect(out.content[0].text).toContain('limit')
    expect(t.run).not.toHaveBeenCalled()
  })

  it('지시문에 카드사가 적혀 있는데 card 없이 부르면 실행기를 부르지 않고 거부한다(실기: 현대카드 지시 → 롯데로 결제)', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const steps: Array<{ label: string; ok: boolean }> = []
    const built = createPayTool({
      tick: () => null,
      onStep: (label, ok) => steps.push({ label, ok }),
      run,
      requiredCard: '현대카드'
    }) as unknown as ToolStub
    const out = await built.handler(args)
    expect(out.content[0].text).toContain('card-required')
    expect(run).not.toHaveBeenCalled()
    expect(steps[0]?.ok).toBe(false)
    // card 를 넘기면 그대로 실행한다
    expect((await built.handler({ ...args, card: '현대' })).content[0].text).toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('도구 문맥에 금고가 없다', () => {
    type PayCtxKeys = keyof import('../src/main/agent/tools-phone').PayToolContext
    const hasVault: Extract<PayCtxKeys, 'vault'> extends never ? true : false = true
    expect(hasVault).toBe(true)
  })
})

describe('결제 요청이 푸시 알림으로만 와 있을 때 — 알림창에서 연다', () => {
  const shade = (elements: PhoneElement[]): PhoneScreen => screen('com.android.systemui', elements)
  const tossHome = screen(TOSS.packageName, [el(1, '홈', { clickable: true })])
  const payAsk = screen(TOSS.packageName, [
    el(2, '결제하기'),
    el(90, '결제수단 변경 ・ 설정', { clickable: false })
  ])
  const keypad = screen(TOSS.packageName, [el(3, '비밀번호를 눌러주세요', { clickable: false })])
  const done = screen(TOSS.packageName, [el(4, '결제가 완료되었습니다', { clickable: false })])
  const TOSS_PUSH = { title: '무신사 결제하기', text: '알림을 누르고 결제를 완료해주세요.' }

  // 알림 우선 규칙 자체를 검증하는 묶음 — 토스는 이제 앱을 바로 열므로(openBy: 'app') 여기서만 알림 우선으로 되돌린다
  beforeEach(() => {
    PAY_PROVIDERS.toss.openBy = 'notification'
  })
  afterEach(() => {
    PAY_PROVIDERS.toss.openBy = 'app'
  })

  // 실기 그대로: 카카오톡으로 온 "토스" 채널 메시지(제목이 토스)와 토스 앱의 결제 알림이 함께 떠 있다
  const DUMP = [
    '    NotificationRecord(0x0e5267b9: pkg=com.kakao.talk user=UserHandle{0} id=2 tag=49 importance=4 key=0|com.kakao.talk|2',
    '                android.title=String (토스)',
    '                android.text=String ([토스] 결제 혜택이 시작됐어요.',
    '    NotificationRecord(0x08447035: pkg=viva.republica.toss user=UserHandle{0} id=2010044086 tag=null importance=4',
    '                android.title=String (무신사 결제하기)',
    '                android.text=String (알림을 누르고 결제를 완료해주세요.',
    '    NotificationRecord(0x057392be: pkg=viva.republica.toss user=UserHandle{0} id=511393872 tag=null importance=4',
    '                android.title=null',
    '                android.text=null',
    '    NotificationRecord(0x01: pkg=viva.republica.toss user=UserHandle{0} id=7 tag=null importance=3',
    '                android.title=String (오늘의 혜택)',
    '                android.text=String (만보기 포인트를 받아 가세요)'
  ].join('\n')

  it('parseAppNotifications: 그 앱이 올린 결제 알림만 뽑는다(카카오톡의 "토스" 메시지·토스의 광고 알림 제외)', () => {
    expect(parseAppNotifications(DUMP, 'viva.republica.toss')).toEqual([TOSS_PUSH])
  })

  it('findPayNotification: 제목이 정확히 같은 알림만 고른다 — "토스" 글자가 들어간 남의 알림은 누르지 않는다', () => {
    const s = shade([
      el(1, '카카오톡', { clickable: false }),
      el(2, '토스', { clickable: false }),
      el(3, '[토스] 결제 혜택이 시작됐어요.', { clickable: false }),
      el(4, '토스', { clickable: false }),
      el(5, '무신사 결제하기', { clickable: false }),
      el(6, '알림을 누르고 결제를 완료해주세요.', { clickable: false })
    ])
    expect(findPayNotification(s, [TOSS_PUSH])).toBe(5)
    // 결제 알림 글자가 화면에 없으면 아무것도 고르지 않는다
    expect(
      findPayNotification(shade([el(1, '카카오톡'), el(2, '토스'), el(3, '[토스] 결제 혜택')]), [
        TOSS_PUSH
      ])
    ).toBeUndefined()
    expect(findPayNotification(s, [])).toBeUndefined()
  })

  it('토스는 알림창을 거치지 않고 앱을 바로 연다 — 알림 클릭이 엉뚱한 곳으로 들어가던 실기 대응', async () => {
    PAY_PROVIDERS.toss.openBy = 'app'
    const h = harness({ screens: [tossHome, payAsk, payAsk, keypad, done, done] })
    const calls: string[] = []
    h.deps.notifications = {
      open: async () => void calls.push('open'),
      close: async () => void calls.push('close'),
      list: async () => {
        calls.push('list')
        return [TOSS_PUSH]
      }
    }
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: true })
    expect(h.deps.launchApp).toHaveBeenCalledTimes(1)
    // 앱을 열자 결제 화면이 떴으므로 알림창은 한 번도 열지 않았다
    expect(calls).toEqual([])
    expect(PAY_PROVIDERS.toss.openBy).toBe('app')
  })

  it('그 앱이 올린 결제 알림이 있으면 앱을 열기 전에 그 알림부터 누른다(가장 짧은 길)', async () => {
    const screens = [
      shade([
        el(2, '토스', { clickable: false }),
        el(3, '[토스] 결제 혜택이 시작됐어요.'),
        el(11, '무신사 결제하기', { clickable: false })
      ]),
      payAsk,
      payAsk,
      keypad,
      done,
      done
    ]
    const h = harness({ screens })
    const calls: string[] = []
    h.deps.notifications = {
      open: async () => void calls.push('open'),
      close: async () => void calls.push('close'),
      list: async (_serial, pkg) => {
        calls.push(`list:${pkg}`)
        return [TOSS_PUSH]
      }
    }
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: true })
    expect(calls).toEqual(['list:viva.republica.toss', 'open'])
    // 토스 결제 알림(11) → 결제하기(2). 카카오톡의 토스 메시지(3)는 누르지 않았고, 앱을 따로 열지도 않았다
    expect(h.taps.map((t) => t[2])).toEqual([11 * 100 + 30, 2 * 100 + 30])
    expect(h.deps.launchApp).not.toHaveBeenCalled()
  })

  it('알림이 묶음으로 접혀 있으면 첫 탭은 펼치기만 한다 — 같은 제목을 다시 눌러 연다', async () => {
    const folded = shade([
      el(9, '토스', { clickable: false }),
      el(11, '무신사 결제하기', { clickable: false })
    ])
    const unfolded = shade([
      el(9, '토스', { clickable: false }),
      el(12, '무신사 결제하기', { clickable: false })
    ])
    const h = harness({ screens: [folded, unfolded, payAsk, payAsk, keypad, done, done] })
    h.deps.notifications = {
      open: async () => {},
      close: async () => {},
      list: async () => [TOSS_PUSH]
    }
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: true })
    expect(h.taps.map((t) => t[2])).toEqual([11 * 100 + 30, 12 * 100 + 30, 2 * 100 + 30])
  })

  it('그 앱이 올린 결제 알림이 없으면 알림창을 열지 않고 앱을 직접 연다', async () => {
    const h = harness({ screens: [payAsk, keypad, done, done] })
    const calls: string[] = []
    h.deps.notifications = {
      open: async () => void calls.push('open'),
      close: async () => void calls.push('close'),
      list: async () => []
    }
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(h.deps.launchApp).toHaveBeenCalledTimes(1)
  })

  it('알림 기록에는 있는데 알림창에서 같은 글자를 못 찾으면 아무것도 누르지 않고 알림창을 올린 뒤 앱을 연다', async () => {
    const h = harness({ screens: [shade([el(1, '카카오톡'), el(2, '토스')]), tossHome] })
    const calls: string[] = []
    h.deps.notifications = {
      open: async () => void calls.push('open'),
      close: async () => void calls.push('close'),
      list: async () => [TOSS_PUSH]
    }
    const r = await runPayApproval(h.deps, request())
    expect(r.ok).toBe(false)
    expect(calls).toEqual(['open', 'close'])
    expect(h.taps).toEqual([])
    expect(h.deps.launchApp).toHaveBeenCalledTimes(1)
  })
})

describe('결제 확인 카드는 권한 모드를 따른다', () => {
  const flow = [
    screen(TOSS.packageName, [
      el(2, '결제하기'),
      el(90, '결제수단 변경 ・ 설정', { clickable: false })
    ]),
    screen(TOSS.packageName, [el(3, '비밀번호를 눌러주세요', { clickable: false })]),
    screen(TOSS.packageName, [el(4, '결제가 완료되었습니다', { clickable: false })]),
    screen(TOSS.packageName, [el(4, '결제가 완료되었습니다', { clickable: false })])
  ]

  it('자동(full) 모드에서는 묻지 않고 진행한다', async () => {
    const h = harness({ screens: flow })
    const r = await runPayApproval(h.deps, request({ confirmFirst: false }))
    expect(r).toEqual({ ok: true })
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('guard 모드(기본)에서는 확인 카드를 한 번 띄운다', async () => {
    const h = harness({ screens: flow })
    await runPayApproval(h.deps, request())
    expect(h.confirm).toHaveBeenCalledTimes(1)
  })
})

describe('토스 앱 잠금 — 앱을 켤 때도 비밀번호를 묻는다', () => {
  const lock = screen(TOSS.packageName, [
    el(1, '앱을 켜려면\n비밀번호를 눌러주세요', { clickable: false })
  ])
  const payAsk = screen(TOSS.packageName, [
    el(2, '결제하기'),
    el(90, '결제수단 변경 ・ 설정', { clickable: false })
  ])
  const payPw = screen(TOSS.packageName, [el(3, '비밀번호를 눌러주세요', { clickable: false })])
  const done = screen(TOSS.packageName, [el(4, '결제가 완료되었습니다', { clickable: false })])

  it('잠금 1회 + 결제 1회, 비밀번호를 두 번 넣고 끝까지 간다', async () => {
    const h = harness({ screens: [lock, lock, payAsk, payPw, done, done] })
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: true })
    expect(h.tapPassword).toHaveBeenCalledTimes(2)
  })

  it('잠금 화면이 한참 뒤에도 그대로면(오답) 다시 넣지 않고 멈춘다', async () => {
    const h = harness({ screens: [lock] })
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: false, reason: 'verify-failed' })
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
  })

  it('결제 비밀번호 화면이 두 번째로 보이면 예전처럼 멈춘다(재시도 없음)', async () => {
    const h = harness({ screens: [payAsk, payPw, payPw, payPw] })
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: false, reason: 'verify-failed' })
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
  })
})

describe('토스 결제 화면(실기 구조) — 글자와 눌리는 영역이 따로인 [결제하기], 카드 바꾸기', () => {
  // 실기: 글자는 클릭 불가 TextView, 눌리는 영역은 글자 없는 View 다
  const payScreen = (card: string): PhoneScreen =>
    screen(TOSS.packageName, [
      el(1, '무신사', { clickable: false }),
      el(2, '', { clickable: true }),
      el(3, card, { clickable: false }),
      el(4, '일시불 결제', { clickable: false }),
      el(5, '결제수단 변경 ・ 설정', { clickable: false }),
      el(6, '개인(신용)정보 제3자 제공 동의 필수 항목에 동의합니다', { clickable: false }),
      el(7, '', { clickable: true }),
      el(8, '결제하기', { clickable: false })
    ])
  const sheet = screen(TOSS.packageName, [
    el(1, '닫기', { clickable: true }),
    el(2, '결제수단 선택', { clickable: false }),
    el(3, 'LOCA Professional', { clickable: false }),
    el(4, '넥슨현대UNLIMITED', { clickable: false }),
    el(5, 'zgm.streaming카드', { clickable: false })
  ])
  const pw = screen(TOSS.packageName, [el(9, '비밀번호를 눌러주세요', { clickable: false })])
  const done = screen(TOSS.packageName, [el(10, '결제가 완료되었습니다', { clickable: false })])

  it('클릭 불가 TextView 인 [결제하기]도 누른다 — 동의 문장 같은 본문은 누르지 않는다', async () => {
    const h = harness({ screens: [payScreen('LOCA Professional'), pw, done, done] })
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: true })
    expect(h.taps.map((t) => t[2])).toEqual([8 * 100 + 30])
  })

  it('카드를 지정하면 결제하기 전에 [결제수단 변경] → 그 카드 → 결제하기 순서로 누른다', async () => {
    const h = harness({
      screens: [
        payScreen('LOCA Professional'),
        sheet,
        payScreen('넥슨현대UNLIMITED'),
        pw,
        done,
        done
      ]
    })
    const r = await runPayApproval(h.deps, request({ cardHint: '현대' }))
    expect(r).toEqual({ ok: true })
    expect(h.taps.map((t) => t[2])).toEqual([5 * 100 + 30, 4 * 100 + 30, 8 * 100 + 30])
  })

  it('지정한 카드가 이미 선택돼 있으면 바꾸지 않고 바로 결제한다', async () => {
    const h = harness({ screens: [payScreen('넥슨현대UNLIMITED'), pw, done, done] })
    const r = await runPayApproval(h.deps, request({ cardHint: '현대' }))
    expect(r).toEqual({ ok: true })
    expect(h.taps.map((t) => t[2])).toEqual([8 * 100 + 30])
  })

  it('카드 목록에 그 카드가 없으면 다른 카드로 결제하지 않고 멈춘다', async () => {
    const h = harness({ screens: [payScreen('LOCA Professional'), sheet] })
    const r = await runPayApproval(h.deps, request({ cardHint: '삼성' }))
    expect(r).toEqual({ ok: false, reason: 'card-not-found' })
    expect(h.tapPassword).not.toHaveBeenCalled()
    // [결제수단 변경]만 눌렀고 결제하기는 누르지 않았다
    expect(h.taps.map((t) => t[2])).toEqual([5 * 100 + 30])
  })

  it('실기: 화면 다른 곳에 "현대" 글자(혜택 안내)가 있어도 선택된 카드가 LOCA 면 바꾼다 — 롯데로 결제되지 않는다', async () => {
    const promo = (card: string): PhoneScreen =>
      screen(TOSS.packageName, [
        el(1, '무신사', { clickable: false }),
        el(2, '', { clickable: true }),
        el(3, card, { clickable: false }),
        el(4, '일시불 결제', { clickable: false }),
        el(5, '결제수단 변경 ・ 설정', { clickable: false }),
        el(6, '현대카드로 결제하면 3개월 무이자', { clickable: false }),
        el(7, '', { clickable: true }),
        el(8, '결제하기', { clickable: false })
      ])
    const h = harness({
      screens: [promo('LOCA Professional'), sheet, promo('넥슨현대UNLIMITED'), pw, done, done]
    })
    const r = await runPayApproval(h.deps, request({ cardHint: '현대' }))
    expect(r).toEqual({ ok: true })
    // [결제수단 변경](5) → 목록의 넥슨현대(4) → 결제하기(8)
    expect(h.taps.map((t) => t[2])).toEqual([5 * 100 + 30, 4 * 100 + 30, 8 * 100 + 30])
    expect(h.steps.map((x) => x.label)).toEqual(
      expect.arrayContaining([
        '카드 맞추기: [결제수단 변경 ・ 설정] 누름',
        '카드 확인: 넥슨현대UNLIMITED 일시불 결제'
      ])
    )
  })

  it('카드를 지정하지 않으면 앱에 선택된 카드를 진행 로그에 남기고 그대로 결제한다', async () => {
    const h = harness({ screens: [payScreen('LOCA Professional'), pw, done, done] })
    const r = await runPayApproval(h.deps, request())
    expect(r).toEqual({ ok: true })
    expect(h.steps.map((x) => x.label)).toContain(
      '카드 미지정 — 앱에 선택된 카드로 결제: LOCA Professional 일시불 결제'
    )
  })

  it('selectedCardOf: [결제수단 변경] 바로 위 줄만 카드로 본다', () => {
    expect(selectedCardOf(payScreen('LOCA Professional'), TOSS)).toBe(
      'LOCA Professional 일시불 결제'
    )
    expect(selectedCardOf(screen(TOSS.packageName, [el(1, '홈')]), TOSS)).toBe('')
  })
})

describe('결제 화면이 아닌 곳에서는 아무것도 누르지 않는다(실기: 토스 홈의 버튼을 눌러 용돈 화면으로 들어감)', () => {
  it('토스 홈·다른 서비스 화면의 [확인]·[다음]·[결제하기]는 누르지 않는다', async () => {
    const other = screen(TOSS.packageName, [
      el(1, '다음'),
      el(2, '확인'),
      el(3, '결제하기'),
      el(4, '용돈 보내기')
    ])
    const h = harness({ screens: [other] })
    const r = await runPayApproval(h.deps, request({ cardHint: '현대' }))
    expect(r).toEqual({ ok: false, reason: 'stuck' })
    expect(h.taps).toEqual([])
  })

  it('카드 이름은 카드사 이름으로 맞춘다 — "현대카드"는 넥슨현대UNLIMITED, "롯데카드"는 LOCA', () => {
    expect(cardPatternOf('현대카드').test('넥슨현대UNLIMITED')).toBe(true)
    expect(cardPatternOf('현대').test('LOCA Professional')).toBe(false)
    expect(cardPatternOf('롯데카드').test('LOCA Professional')).toBe(true)
    expect(cardPatternOf('KB국민카드').test('KB국민 톡톡')).toBe(true)
  })
})

describe('runPayApproval — 알리페이 국제카드(唯品会) 다단계', () => {
  const ali = 'com.eg.android.AlipayGphone'
  // 실기 2026-10-03: 결제 비밀번호 → 현대카드 인증 안내(앱카드/PIN 고르기) → PIN 보안 키패드 → 결제 완료
  const cvv = screen(ali, [
    el(1, 'CVV를 입력하세요', { clickable: false }),
    el(2, '주문금액: ¥ 427.00', { clickable: false })
  ])
  const pw = screen(ali, [el(2, '주문금액: ¥ 427.00', { clickable: false })])
  const stepUp = screen(ali, [
    el(3, 'Cruise API - Step Up', { clickable: false }),
    el(4, '앱카드 결제'),
    el(5, 'PIN번호 결제')
  ])
  const pinPad = screen(ali, [
    el(6, 'Cruise API - Step Up', { clickable: false }),
    el(7, '', { isSecret: true, clickable: false })
  ])
  const done = screen(ali, [el(8, '결제 완료', { clickable: false })])

  it('비밀번호 뒤 카드사 인증 안내에서 PIN번호 결제를 누르고, PIN 키패드에 결제 비밀번호를 한 번 더 넣는다', async () => {
    const h = harness({
      screens: [cvv, cvv, pw, pw, pw, pw, pw, pw, stepUp, stepUp, pinPad, pinPad, done, done],
      webSuccess: false
    })
    const r = await runPayApproval(h.deps, request({ provider: 'alipay' }))

    expect(r).toEqual({ ok: true })
    // CVC → 결제 비밀번호 → 카드사 PIN(결제 비밀번호)
    expect(h.tapPassword).toHaveBeenCalledTimes(3)
    expect(h.tapPassword.mock.calls[0][0]).toMatchObject({ secret: 'card-cvc' })
    expect(h.tapPassword.mock.calls[2][0]).toMatchObject({ provider: 'alipay', secret: 'payment' })
    // 'PIN번호 결제' 버튼(5) 을 눌렀다
    expect(h.taps.some(([, x, y]) => x === 100 && y === 530)).toBe(true)
  })

  it('안내 화면(PIN번호 결제 고르기)은 비밀번호 화면이 아니다 — 버튼을 누른다', () => {
    const next = nextPayState('verify', stepUp, PAY_PROVIDERS.alipay)
    expect(next).toEqual({ state: 'app_steps', tapElementId: 5 })
  })

  it('알리페이가 시스템 바쁨 오류를 띄우면 누르지 않고 blocked-by-app 으로 멈춘다', async () => {
    const blocked = screen(ali, [el(9, '身份验证 系统正忙，稍后再试', { clickable: false })])
    const h = harness({ screens: [pw, pw, blocked, blocked], webSuccess: false })
    const r = await runPayApproval(h.deps, request({ provider: 'alipay' }))
    expect(r).toMatchObject({ ok: false, reason: 'blocked-by-app' })
    expect(h.tapPassword).toHaveBeenCalledTimes(1)
  })
})

describe('runPayApproval — 알리페이 CVV 는 금고 카드 항목에서', () => {
  it('계정에 카드 항목이 없으면 CVV 를 누르지 않고 card-not-saved 로 멈춘다', async () => {
    const ali = 'com.eg.android.AlipayGphone'
    const cvv = screen(ali, [
      el(1, 'CVV를 입력하세요', { clickable: false }),
      el(2, '주문금액: ¥ 427.00', { clickable: false })
    ])
    const h = harness({ screens: [cvv, cvv, cvv], password: 'not-found', webSuccess: false })
    const r = await runPayApproval(h.deps, request({ provider: 'alipay' }))
    expect(r).toMatchObject({ ok: false, reason: 'card-not-saved' })
    expect(h.tapPassword.mock.calls[0][0]).toMatchObject({ secret: 'card-cvc' })
  })
})
