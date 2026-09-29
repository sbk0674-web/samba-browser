// 폰 AI 도구. 금고에 접근하지 않는다 — 비밀값은 pay-secret.ts 만 다룬다.
// 호출 상한(tick)·진행 로그(onStep)는 웹 도구와 같은 것을 공유한다.
//
// 안전 규칙(3단계 Global Constraints):
//  - 결제 비밀번호·PIN 은 phone_type 으로 넣지 않는다. 이 파일은 금고를 아예 볼 수 없다.
//  - 비밀 입력 화면의 캡처는 모델에게 넘기지 않는다(phone_screenshot 이 거부).
//  - 결과 문자열에는 화면 값이 아닌 상태만 담는다.

import { tr } from '../i18n'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { PermissionMode } from '../../shared/settings'
import type { PhoneDto } from '../../shared/phone'
import {
  findElement,
  isScreenUnknown,
  serializePhoneScreen,
  type PhoneScreen
} from '../../shared/phone-snapshot'
import {
  PHONE_KEYS,
  ensureAwake,
  isPhoneKey,
  pressKey,
  swipe as adbSwipe,
  tap as adbTap,
  typeText as adbTypeText,
  type PhoneKey
} from '../phone/input'
import { execOutArgs, type AdbRunner } from '../phone/adb'
import { dumpScreen } from '../phone/uitree'
import { isSecretScreen, PAY_PROVIDERS, type PayProvider, type PayResult } from '../phone/pay'

const READ_ONLY_REFUSAL = 'refused: read-only mode'
const NO_PHONE = 'no phone connected'
const NOT_FOUND = 'not found'
const SECRET_SCREEN = 'refused: secret screen'
// uiautomator 덤프가 실패해 비밀 화면 여부를 판정하지 못한 경우
const UNKNOWN_SCREEN = 'refused: cannot read the phone screen, so it may be a secret screen'
const USER_DECLINED = 'refused: user declined'
// 좌표도 요소 번호도 없이 부른 경우
const TAP_TARGET_MISSING = 'refused: give elementId from phone_get_screen, or x and y'
// adb input text 가 보낼 수 없는 글자(한글·이모지)일 때
const UNSUPPORTED_TEXT = 'unsupported-text: use phone_tap on the keyboard'

// guard 모드에서 조작 전 확인을 받는 앱(간편결제·은행)
export const PAYMENT_PACKAGES = [
  'viva.republica.toss',
  'com.nhnent.payapp', // 페이코
  'com.kakao.talk',
  'com.nhn.android.search' // 네이버앱(네이버페이)
]

/**
 * 결제 승인 도구 이름. PHONE_TOOL_NAMES 와 따로 둔다 —
 * 결제는 금고를 보는 별도 문맥(PayToolContext)으로만 등록되기 때문이다
 */
export const PAY_TOOL_NAME = 'phone_approve_payment'

export const PHONE_TOOL_NAMES = [
  'phone_get_screen',
  'phone_tap',
  'phone_type',
  'phone_key',
  'phone_swipe',
  'phone_screenshot',
  'wait_for_sms_code'
]

/** 인증 대기 결과 — 값이 아니라 "채웠는가 · 몇 자리인가" 만 오간다 */
export interface SmsCodeOutcome {
  filled: boolean
  digits: number
}

// 인증 흐름이 배선되지 않은 실행에서 돌려주는 문구
const NO_AUTH_FLOW = 'refused: sms auth is not available'
const AUTH_TIMEOUT = 'timeout'

export interface Point {
  x: number
  y: number
}

/** 도구가 쓰는 폰 조작 능력. 구현은 배선부(handlers.ts)가 adb 로 채운다 */
export interface PhoneOps {
  list: () => PhoneDto[]
  screen: (serial: string) => Promise<PhoneScreen>
  tap: (serial: string, x: number, y: number) => Promise<void>
  swipe: (serial: string, from: Point, to: Point, ms?: number) => Promise<void>
  typeText: (serial: string, text: string) => Promise<'ok' | 'unsupported-text'>
  key: (serial: string, key: PhoneKey) => Promise<void>
  /** unknown 은 화면을 읽지 못해 비밀 화면 여부를 판정할 수 없다는 뜻이다 */
  screenshot: (serial: string) => Promise<{ png: Buffer; secret: boolean; unknown?: boolean }>
  /**
   * 이 화면을 모델에게 넘겨도 되는가.
   * 결제 실행기가 세운 표식(SecretScreenGate)과 결제 앱의 비밀번호 문구를 함께 본다
   */
  isSecret: (serial: string, screen: PhoneScreen) => boolean
}

export interface PhoneToolContext {
  // 주의: vault 필드가 없다 — 폰 도구는 금고 값에 접근할 수 없다(테스트로 단언)
  phones: PhoneOps
  mode: PermissionMode
  // 배정된 폰 serial. 없으면 연결된 첫 폰
  assigned: () => string | null
  confirm: (action: string, kind?: 'danger' | 'finish') => Promise<boolean>
  tick: () => string | null
  onStep: (label: string, ok: boolean) => void
  /**
   * 문자 인증을 끝까지 수행한다(auth-flow 의 runSmsAuth 를 배선부가 꽂는다).
   * 인증번호 값은 돌려주지 않는다 — 이미 페이지에 채워졌기 때문이다
   */
  waitForSmsCode?: (host?: string) => Promise<SmsCodeOutcome>
}

// 스키마가 서로 다른 도구를 한 배열에 담기 위한 공통 타입(웹 도구 배열과 같은 취지).
// 기본 인자(AnyZodRawShape)라 스키마가 제각각인 도구를 모두 담는다
type PhoneTool = SdkMcpToolDefinition

type TextBlock = { type: 'text'; text: string }
type ImageBlock = { type: 'image'; data: string; mimeType: string }

const text = (t: string): { content: TextBlock[] } => ({
  content: [{ type: 'text' as const, text: t }]
})

// 실패로 볼 결과 문자열(진행 로그의 ✓/✗ 판정). 웹 도구 guard 와 같은 규칙
const FAILED_RE = /not found|no phone|refused|denied|unsupported|error/i

// 도구 통과 결과 — 폰이 정해졌거나(ok), 거부 문구를 그대로 돌려줘야 하거나(message)
type Gate =
  | { ok: true; serial: string; screen: () => Promise<PhoneScreen> }
  // silent 는 호출 상한처럼 이미 별도 step 을 남긴 경우다(중복 기록 방지)
  | { ok: false; message: string; silent?: boolean }

const keyNames = Object.keys(PHONE_KEYS) as [PhoneKey, ...PhoneKey[]]

/**
 * 지금 쓸 수 있는 폰이 한 대라도 붙어 있는가.
 * 폰이 없으면 도구 목록에서 폰 도구를 아예 빼 버린다 — 웹 작업 중에 모델이
 * phone_tap 을 부르는 혼동을 없애기 위해서다(실기에서 관찰). 폰을 꽂으면 다음 실행부터 다시 보인다
 */
export function hasConnectedPhone(ctx: Pick<PhoneToolContext, 'phones'>): boolean {
  try {
    return ctx.phones.list().some((p) => p.state === 'online')
  } catch {
    // 장치 목록을 못 읽으면 폰이 없는 것으로 본다(도구를 내보내지 않는 쪽이 안전하다)
    return false
  }
}

export function createPhoneTools(ctx: PhoneToolContext): PhoneTool[] {
  // 상한 도달 알림은 1회만 보낸다(웹 도구와 같은 규칙)
  let limitNotified = false

  /** 배정된 폰 → 없으면 연결(online)된 첫 폰 */
  const resolveSerial = (): string | null => {
    const assigned = ctx.assigned()
    if (assigned) return assigned
    return ctx.phones.list().find((p) => p.state === 'online')?.serial ?? null
  }

  /**
   * 모든 폰 도구가 지나는 관문.
   * 호출 상한 → 권한 모드 → 폰 선택 → (guard) 결제 앱 확인 순으로 본다
   */
  const enter = async (write: boolean): Promise<Gate> => {
    const over = ctx.tick()
    if (over) {
      if (!limitNotified) {
        limitNotified = true
        ctx.onStep('도구 호출 상한 도달', false)
      }
      return { ok: false, message: over, silent: true }
    }
    if (write && ctx.mode === 'read_only') return { ok: false, message: READ_ONLY_REFUSAL }
    const serial = resolveSerial()
    if (!serial) return { ok: false, message: NO_PHONE }

    // 화면은 한 호출 안에서 한 번만 뜬다(요소 탭 판정과 결제 앱 판정이 같은 화면을 본다)
    let cached: PhoneScreen | null = null
    const screen = async (): Promise<PhoneScreen> => {
      if (!cached) cached = await ctx.phones.screen(serial)
      return cached
    }

    // guard 모드에서 간편결제·은행 앱을 조작하기 전에는 사용자 확인 카드를 받는다.
    // 판정 근거는 모델이 준 값이 아니라 폰이 보고한 최상위 패키지명이다
    if (write && ctx.mode === 'guard') {
      const app = (await screen()).app
      if (PAYMENT_PACKAGES.includes(app)) {
        const ok = await ctx.confirm(`폰 조작: ${app}`, 'danger')
        if (!ok) return { ok: false, message: USER_DECLINED }
      }
    }
    return { ok: true, serial, screen }
  }

  /** 글자 결과를 돌려주는 도구 5종의 공통 실행부 */
  const act = async (
    label: string,
    write: boolean,
    fn: (serial: string, screen: () => Promise<PhoneScreen>) => Promise<string>
  ): Promise<{ content: TextBlock[] }> => {
    const gate = await enter(write)
    if (!gate.ok) {
      if (!gate.silent) ctx.onStep(label, false)
      return text(gate.message)
    }
    try {
      const out = await fn(gate.serial, gate.screen)
      ctx.onStep(label, !FAILED_RE.test(out))
      return text(out)
    } catch (e) {
      ctx.onStep(label, false)
      return text(`error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const getScreen = tool(
    'phone_get_screen',
    'Read the connected phone screen: current app package, screen size and numbered elements. Use those numbers with phone_tap. Password and PIN screens are refused.',
    {},
    () =>
      act('폰 화면 읽기', false, async (serial, screen) => {
        const got = await screen()
        // 덤프가 실패한 화면은 비밀 화면인지 가릴 수 없다 — 판정 불가는 거부로 본다
        if (isScreenUnknown(got)) return UNKNOWN_SCREEN
        // 비밀번호·PIN 화면은 요소 목록도 넘기지 않는다(키패드 배치가 곧 단서다)
        if (ctx.phones.isSecret(serial, got)) return SECRET_SCREEN
        return serializePhoneScreen(got)
      })
  )

  const tap = tool(
    'phone_tap',
    'Tap the phone screen: pass elementId from phone_get_screen, or raw device coordinates x and y.',
    {
      elementId: z.number().int().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      label: z.string().optional().describe('element text, for logging')
    },
    ({ elementId, x, y, label }) =>
      act(
        `폰 탭: ${label ?? (elementId !== undefined ? `#${elementId}` : `${x},${y}`)}`,
        true,
        async (serial, screen) => {
          if (elementId !== undefined) {
            const el = findElement(await screen(), elementId)
            if (!el) return NOT_FOUND
            await ctx.phones.tap(serial, el.center.x, el.center.y)
            return 'ok'
          }
          if (x === undefined || y === undefined) return TAP_TARGET_MISSING
          await ctx.phones.tap(serial, x, y)
          return 'ok'
        }
      )
  )

  const typeTool = tool(
    'phone_type',
    'Type plain text into the focused phone field. Only letters, digits, space and _ . @ % + - = : , / are accepted; anything else is refused, so tap the on-screen keyboard instead. Never use this for a payment password, PIN or any secret - the app fills those itself.',
    { text: z.string() },
    ({ text: value }) =>
      // 라벨에 입력값을 넣지 않는다 — 진행 로그는 화면에 그대로 보인다
      act('폰 입력', true, async (serial) => {
        const r = await ctx.phones.typeText(serial, value)
        return r === 'ok' ? 'ok' : UNSUPPORTED_TEXT
      })
  )

  const keyTool = tool(
    'phone_key',
    `Press a phone hardware key. One of: ${keyNames.join(', ')}.`,
    { key: z.enum(keyNames) },
    ({ key }) =>
      act(`폰 키: ${String(key)}`, true, async (serial) => {
        if (!isPhoneKey(key)) return `refused: unknown key, use one of ${keyNames.join(', ')}`
        await ctx.phones.key(serial, key)
        return 'ok'
      })
  )

  const swipe = tool(
    'phone_swipe',
    'Swipe on the phone between two device coordinates. Use it to scroll a list or open a drawer.',
    {
      from: z.object({ x: z.number(), y: z.number() }),
      to: z.object({ x: z.number(), y: z.number() }),
      ms: z.number().int().optional()
    },
    ({ from, to, ms }) =>
      act('폰 스와이프', true, async (serial) => {
        await ctx.phones.swipe(serial, from, to, ms)
        return 'ok'
      })
  )

  // 캡처는 이미지 블록을 돌려줘야 해서 act() 대신 같은 관문만 공유한다(웹 screenshot 과 같은 방식)
  const screenshot = tool(
    'phone_screenshot',
    'Screenshot the phone as an image. Use when phone_get_screen text is not enough (image captcha, keypad layout). Secret keypad screens are refused.',
    {},
    async (): Promise<{ content: (TextBlock | ImageBlock)[] }> => {
      const label = '폰 화면 캡처'
      const gate = await enter(false)
      if (!gate.ok) {
        if (!gate.silent) ctx.onStep(label, false)
        return text(gate.message)
      }
      try {
        const { png, secret, unknown } = await ctx.phones.screenshot(gate.serial)
        // 화면을 읽지 못했으면(판정 불가) 캡처 원본을 넘기지 않는다
        if (unknown) {
          ctx.onStep(label, false)
          return text(UNKNOWN_SCREEN)
        }
        // 비밀번호·PIN 화면은 이미지를 아예 넘기지 않는다
        if (secret) {
          ctx.onStep(label, false)
          return text(SECRET_SCREEN)
        }
        ctx.onStep(label, true)
        return {
          content: [
            { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
            { type: 'text' as const, text: `phone screenshot (${gate.serial})` }
          ]
        }
      } catch (e) {
        ctx.onStep(label, false)
        return text(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  // 문자 인증 대기 — 폰에 온 인증번호를 페이지 입력칸에 바로 채운다.
  // 모델에게는 마스킹된 결과(`filled: ####`)만 준다. 값은 어떤 경로로도 나가지 않는다
  const waitSmsCode = tool(
    'wait_for_sms_code',
    'Wait for the SMS verification code to arrive on the phone and fill it into the page field. Returns only a masked result - you never see the code itself.',
    { host: z.string().optional().describe('site host that is asking for the code') },
    ({ host }) =>
      act('문자 인증 대기', true, async () => {
        if (!ctx.waitForSmsCode) return NO_AUTH_FLOW
        const r = await ctx.waitForSmsCode(host)
        // 자릿수까지만 알려 준다(모델이 "6자리를 채웠다" 정도만 알면 된다)
        return r.filled ? `filled: ${'#'.repeat(Math.max(0, r.digits))}` : AUTH_TIMEOUT
      })
  )

  // 스키마가 도구마다 달라 한 배열로 모으려면 좁히기가 필요하다(SDK 도 내부적으로 같은 처리를 한다).
  // any 를 쓰지 않으려고 unknown 을 거쳐 좁힌다 — 실행 시 모양은 그대로다
  return [
    getScreen,
    tap,
    typeTool,
    keyTool,
    swipe,
    screenshot,
    waitSmsCode
  ] as unknown as PhoneTool[]
}

/**
 * adb 로 PhoneOps 를 채운다(배선부 전용).
 * 화면 프레임은 T4 스냅샷과 같은 `exec-out screencap -p` 경로를 쓴다.
 * 비밀 입력칸이 보이는 화면은 캡처 자체를 뜨지 않는다 — 버퍼로도 만들지 않는다
 */
export function createPhoneOps(
  adb: AdbRunner,
  list: () => PhoneDto[],
  // 결제 실행기가 "지금 비밀번호 화면" 이라고 세워 둔 표식. 주지 않으면 화면만 보고 판정한다
  secretGate?: { isSecret: (serial: string) => boolean }
): PhoneOps {
  const isSecret = (serial: string, screen: PhoneScreen): boolean => {
    if (secretGate?.isSecret(serial)) return true
    // 결제 앱마다 비밀번호 화면 문구가 다르다 — 어느 하나라도 맞으면 비밀 화면으로 본다
    // (isSecretScreen 은 password 속성이 붙은 입력칸도 함께 본다)
    return Object.values(PAY_PROVIDERS).some((spec) => isSecretScreen(screen, spec))
  }
  return {
    list,
    isSecret,
    // 폰이 잠들어 있으면 화면을 못 읽고 탭이 헛돈다 — 조작마다 먼저 깨운다(잠들어 있을 때만 WAKEUP)
    screen: async (serial) => {
      await ensureAwake(adb, serial).catch(() => {})
      return dumpScreen(adb, serial)
    },
    tap: async (serial, x, y) => {
      await ensureAwake(adb, serial).catch(() => {})
      await adbTap(adb, serial, x, y)
    },
    swipe: async (serial, from, to, ms) => {
      await ensureAwake(adb, serial).catch(() => {})
      await adbSwipe(adb, serial, from, to, ms)
    },
    typeText: (serial, value) => adbTypeText(adb, serial, value),
    key: async (serial, key) => {
      await ensureAwake(adb, serial).catch(() => {})
      await pressKey(adb, serial, key)
    },
    screenshot: async (serial) => {
      const screen = await dumpScreen(adb, serial)
      // 덤프가 실패해 판정할 수 없으면 캡처를 뜨지 않는다(가장 안전한 쪽으로 본다)
      if (isScreenUnknown(screen)) return { png: Buffer.alloc(0), secret: true, unknown: true }
      // 비밀 화면이면 캡처를 아예 뜨지 않는다 — 버퍼로도 만들지 않는다
      if (isSecret(serial, screen)) return { png: Buffer.alloc(0), secret: true }
      return { png: await adb.runBinary(execOutArgs(serial, ['screencap', '-p'])), secret: false }
    }
  }
}

// --- 결제 승인 도구 ---------------------------------------------------------
//
// 결제는 폰 도구와 문맥을 나눈다. PhoneToolContext 는 금고를 보지 못하고(테스트로 단언),
// 결제 실행기만 금고를 본다 — 다만 비밀번호 값은 pay-secret.ts 안에서만 복호화된다.
// 확인 카드·상한 검사·재시도 금지는 전부 runPayApproval 안에 있다

/** 모델이 도구로 넘길 수 있는 값. 폰·계정·금고는 배선부가 채운다(모델이 고르지 못한다) */
export interface PayToolRequest {
  provider: PayProvider
  amountKrw: number
  merchant: string
  methodLabel: string
  /** 결제 앱 안에서 고를 카드 이름의 일부(예: "현대") */
  card?: string
  /** 결제 앱 자체의 키마스터 계정(네이버페이면 naver.com 계정)의 아이디 또는 라벨 */
  payAccount?: string
  /**
   * 시험 입력(dry-run) 자리수. 주면 결제 비밀번호를 이 자리수만 누르고 취소한다 —
   * 실기에서 키패드 자동 입력이 되는지만 보고 결제는 하지 않는다
   */
  dryRunDigits?: number
}

export interface PayToolContext {
  tick: () => string | null
  onStep: (label: string, ok: boolean) => void
  /**
   * 사용자 지시문에 적힌 카드 이름(예: "현대카드"). 있으면 card 없는 호출은 실행기까지 가지 않고 거부한다 —
   * 실기: "현대카드 결제"라고 시켰는데 card 를 빼고 불러 앱에 선택돼 있던 롯데카드로 나갔다
   */
  requiredCard?: string
  // 결제 실행기(배선부가 runPayApproval 에 금고·폰·확인 카드를 묶어 넣는다)
  run: (req: PayToolRequest) => Promise<PayResult>
}

const PAY_PROVIDER_NAMES = Object.keys(PAY_PROVIDERS) as [PayProvider, ...PayProvider[]]

export function createPayTool(ctx: PayToolContext): PhoneTool {
  const payTool = tool(
    PAY_TOOL_NAME,
    'Approve a payment that the web checkout handed to a Korean pay app on the phone. ' +
      'In guard mode the app asks the user first; in auto mode it proceeds without asking - do not ask yourself either way. Never pass a payment password or PIN here - ' +
      'this tool fills it on the phone by itself and the value never reaches you.',
    {
      provider: z.enum(PAY_PROVIDER_NAMES),
      amountKrw: z.number().int().positive(),
      merchant: z.string(),
      methodLabel: z.string().describe('payment method shown to the user, e.g. 토스페이'),
      card: z
        .string()
        .optional()
        .describe(
          'part of the card name to pay with inside the pay app, e.g. "현대" for 현대카드 or "LOCA" for 롯데카드. ' +
            'The tool switches the selected card to it before paying and refuses (card-not-found) if the app has no such card.'
        ),
      dryRunDigits: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe(
          'DRY RUN: type only this many digits of the payment password, then cancel and leave the keypad. ' +
            'Nothing is paid - the tool answers "refused: dry-run". Pass it only when the user asked to test the keypad.'
        ),
      payAccount: z
        .string()
        .optional()
        .describe(
          '네이버페이 only: username or label of the naver.com account in KeyMaster to pay with (its payment password is used). ' +
            'Required when several naver accounts have one - the refusal pay-account-ambiguous lists them; ' +
            'if the user or instruction names which naver account to pay with, pass it here.'
        )
    },
    async (args): Promise<{ content: TextBlock[] }> => {
      const label = '폰 결제 승인'
      const over = ctx.tick()
      // 상한 도달은 실행기까지 가지 않는다(별도 step 은 폰 도구 쪽에서 이미 남는다)
      if (over) return text(over)
      if (ctx.requiredCard !== undefined && (args.card === undefined || args.card.trim() === '')) {
        ctx.onStep(tr('phone.payCardRequired', { card: ctx.requiredCard }), false)
        return text(
          `refused: card-required - the instruction says to pay with ${ctx.requiredCard}; call again with card set`
        )
      }
      try {
        const r = await ctx.run({
          provider: args.provider,
          amountKrw: args.amountKrw,
          merchant: args.merchant,
          methodLabel: args.methodLabel,
          ...(args.card === undefined ? {} : { card: args.card }),
          ...(args.dryRunDigits === undefined ? {} : { dryRunDigits: args.dryRunDigits }),
          ...(args.payAccount === undefined ? {} : { payAccount: args.payAccount })
        })
        // 사유는 상태 이름뿐이다 — 화면 값은 담지 않는다(진행 로그는 실행기가 남긴다).
        // detail 은 실행기가 고른 덧붙임(계정 아이디 목록 등)이라 그대로 전한다
        return text(
          r.ok ? 'ok' : `refused: ${r.reason ?? 'failed'}${r.detail ? ` (${r.detail})` : ''}`
        )
      } catch (e) {
        ctx.onStep(label, false)
        return text(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )
  return payTool as unknown as PhoneTool
}
