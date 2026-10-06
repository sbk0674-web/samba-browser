// 간편결제 앱 승인 흐름. 웹 결제창이 띄운 앱(토스·페이코·카카오페이·네이버페이)에서
// "결제하기 → 비밀번호 → 완료" 를 따라가고, 웹 팝업의 성공 리다이렉트까지 확인한다.
//
// 안전 규칙(3단계 Global Constraints):
//  - 결제는 권한 모드와 무관하게 확인 카드 1회. full 모드여도 건너뛰지 않는다
//  - 상한 50만원, 새 (사이트 × 결제수단) 조합의 첫 결제는 1만원까지
//  - 비밀번호는 여기서 다루지 않는다 — pay-secret.ts 의 tapPaymentPassword 가 금고에서
//    직접 읽어 좌표만 누른다. 오입력이 의심돼도 재시도하지 않는다(계정 잠금 방지)
//  - 실패 통지의 스크린샷은 비밀번호 화면이면 붙이지 않는다

import { type AuthEventDto } from '../../shared/phone'
import { findElement, type PhoneScreen } from '../../shared/phone-snapshot'
import type { PaymentProvider } from '../../shared/vault'
import { PAYMENT_PROVIDER_ACCOUNT_HOST } from '../../shared/vault'
import type { KeypadLayout } from '../ai/visual'
import type { HandoffResult } from '../agent/handoff'
import {
  tapPaymentPassword,
  type KeypadSource,
  type PaySecretResult,
  type PaySecretVault
} from './pay-secret'
import { tr, type MessageKey } from '../i18n'

export type PayState =
  'idle' | 'await_app' | 'app_steps' | 'password' | 'verify' | 'done' | 'failed'
export type PayProvider = 'toss' | 'payco' | 'kakaopay' | 'naverpay' | 'alipay' | 'lottecard'

export interface PayProviderSpec {
  id: PayProvider
  packageName: string
  deepLink: string
  // 진행 버튼 텍스트 후보(정규식). 사이트·앱별 차이는 데이터로 둔다
  confirmText: RegExp
  // 비밀번호 화면임을 알리는 표식
  passwordHint: RegExp
  successHint: RegExp
  /**
   * 앱을 켤 때 묻는 잠금 비밀번호 화면의 문구. 결제 비밀번호와 같은 값을 쓰는 앱(토스)만 적는다 —
   * 이 화면은 결제 비밀번호 입력과 따로 센다(잠금 1회 + 결제 1회)
   */
  unlockHint?: RegExp
  /** 결제 화면에서 결제수단(카드)을 바꾸는 버튼 문구와, 열린 선택 목록의 제목. 둘 다 있어야 카드 지정을 지원한다 */
  changeMethodText?: RegExp
  methodSheetTitle?: RegExp
  /**
   * 결제 화면에서 선택된 카드 줄 바로 아래 오는 할부 안내 문구(토스 '할부 선택 ・ 일시불'). 있으면 그 바로 위
   * 글자 줄이 지금 선택된 카드다 — 카드 행이 여럿 보이는 화면(실기 2026-10-06: 넥슨현대·LOCA 두 줄)에서는
   * [결제수단 변경] 위 두 줄 규칙으로 선택 카드를 가릴 수 없다
   */
  installmentText?: RegExp
  /**
   * 결제 화면에만 있는 문구. 적혀 있으면 이 문구가 보이는 화면에서만 진행 버튼을 누른다 —
   * 앱 홈이나 다른 서비스 화면의 [확인]·[다음]을 눌러 엉뚱한 곳으로 들어가지 않게 한다(실기: 토스 홈 → 용돈 화면)
   */
  payScreenHint?: RegExp
  /**
   * 결제 요청 화면으로 들어가는 길. 'app' 이면 알림창을 거치지 않고 앱을 바로 연다 —
   * 알림 클릭이 엉뚱한 곳으로 들어가던 앱(토스)에 쓴다. 생략하면 결제 알림을 먼저 누른다
   */
  openBy?: 'app' | 'notification'
  /**
   * 다른 앱(得物)이 띄운 결제창처럼 이미 앞에 떠 있으면 앱을 다시 열지 않는다 — 다시 열면 결제창이 앱 홈에 가린다
   */
  keepIfForeground?: boolean
  /** 웹 결제창 없이 앱 안에서 끝나는 결제(식화·得物 → 알리페이) — 웹 성공 확인을 하지 않는다 */
  appOnly?: boolean
  /**
   * 비밀번호 뒤에 단계가 더 있는 결제(알리페이 국제카드: CVV → 결제 비밀번호 → 카드사 인증 → PIN).
   * 비밀번호를 넣은 뒤 완료만 기다리지 않고 앱 단계(버튼·다음 비밀 화면)를 계속 따라간다
   */
  multiStep?: boolean
  /** 카드 CVV 를 묻는 화면의 문구 — 계정 카드 항목의 card.cvc 를 누른다 */
  cvvHint?: RegExp
  /** 카드사 PIN(결제 비밀번호와 같은 값, 사용자 2026-10-03) 화면의 문구 — 결제 비밀번호를 한 번 더 누른다 */
  pinHint?: RegExp
  /** 진행이 막히는 화면(백신 설치 요구 등) — 보이면 누르지 않고 멈춘다 */
  blockerHint?: RegExp
  /**
   * 결제 요청 화면까지 앱 안에서 거쳐 가는 버튼 문구(순서대로 한 번씩 누른다). 웹 결제창이 푸시를 보내지 않고
   * 사용자가 앱에서 코드를 넣는 결제(롯데카드 앱카드: 홈 → 로카페이 → 온라인 결제 코드 입력)에 쓴다
   */
  appPath?: RegExp[]
  /**
   * 웹 결제창이 보여 준 숫자코드를 넣는 화면의 문구. 이 화면에 숫자 키패드(UI 트리의 0~9)가 보이면
   * PayRequest.code 자리를 차례로 누르고 진행 버튼([입력완료])을 누른다. code 가 없으면 멈춘다(엉뚱한 값을 넣지 않는다)
   */
  codeHint?: RegExp
  /** 딥링크 대신 이 액티비티를 바로 띄운다(롯데카드 로카페이: 앱 홈의 [PAY] 아이콘에 접근성 글자가 없다) */
  launchActivity?: string
}

export const PAY_PROVIDERS: Record<PayProvider, PayProviderSpec> = {
  toss: {
    id: 'toss',
    packageName: 'viva.republica.toss',
    deepLink: 'supertoss://',
    // 토스는 결제 화면에서 [결제하기]만 누르면 된다 — [확인]·[다음]은 홈·광고·다른 서비스에도 있어 넣지 않는다
    confirmText: /결제하기|동의하고 결제/,
    passwordHint: /비밀번호|간편비밀번호|PIN/,
    successHint: /결제(가)?\s?완료|송금 완료|완료되었습니다/,
    // "앱을 켜려면 비밀번호를 눌러주세요" — 토스는 앱 잠금과 결제에 같은 비밀번호를 쓴다
    unlockHint: /앱을 켜려면/,
    changeMethodText: /결제수단 변경/,
    methodSheetTitle: /결제수단 선택/,
    installmentText: /할부 선택/,
    // 카드 줄을 눌러 바꾸면 화면이 내려가 [결제수단 변경]이 안 보일 수 있다 — 할부 줄도 결제 화면 표식으로 본다
    payScreenHint: /결제수단 변경|할부 선택/
    // 결제 알림을 먼저 누른다(openBy 기본). 앱을 바로 열면 홈이 뜨고(결제 화면이 저절로 뜨지 않는다) 홈은 UI 덤프가
    // 안 돼("could not get idle state") 폴링마다 15초씩 멈춰 7분을 다 쓴다(실기 2026-10-06). 알림은 제목이 정확히
    // 같은 그 앱의 알림만 누르므로 엉뚱한 곳으로 들어가지 않는다 — 누르면 바로 결제 화면(OnlinePayActivity)
  },
  payco: {
    id: 'payco',
    packageName: 'com.nhnent.payapp',
    deepLink: 'payco://',
    confirmText: /결제하기|확인|다음/,
    passwordHint: /결제 ?비밀번호|PAYCO 비밀번호|비밀번호/,
    successHint: /결제 ?완료|완료되었습니다/
  },
  kakaopay: {
    id: 'kakaopay',
    packageName: 'com.kakao.talk',
    deepLink: 'kakaotalk://',
    confirmText: /결제하기|확인|다음|동의하고 결제/,
    passwordHint: /결제 ?비밀번호|카카오페이 비밀번호|비밀번호/,
    successHint: /결제 ?완료|완료되었습니다/
  },
  naverpay: {
    id: 'naverpay',
    packageName: 'com.nhn.android.search',
    deepLink: 'naversearchapp://',
    confirmText: /결제하기|확인|다음/,
    passwordHint: /결제 ?비밀번호|네이버페이 비밀번호|비밀번호/,
    successHint: /결제 ?완료|완료되었습니다/
  },
  // 식화·得物(더우) 앱 결제 — 앱이 알리페이 결제창을 띄운다. 6자리 결제 비밀번호 칸 제목이 'CVV를 입력하세요'로
  // 번역돼 보인다(사용자 2026-10-01: "cvv가 결제 비밀번호다"). 키패드는 숫자가 고정이고 UI 트리에 글자가 있다
  alipay: {
    id: 'alipay',
    packageName: 'com.eg.android.AlipayGphone',
    deepLink: 'alipays://',
    // 'PIN번호 결제' = 카드사(현대카드) 인증 화면에서 앱카드 대신 PIN 으로 간다(실기 2026-10-03 唯品会)
    // '다음' = 카드사 인증의 백신(V3) 확인 페이지에서 설치돼 있으니 넘어가는 버튼(실기 2026-10-03)
    // 영어 표시(알리페이 '일반버전'은 한국어가 없어 영어로 뜬다, 2026-10-03)도 함께 본다
    confirmText: /^(?:결제|확인|确认付款|立即付款|付款|PIN번호 결제|다음|Pay|Confirm|Next|OK)$/,
    // 한국어 알리페이 결제창(唯品会 국제카드)은 '支付密码' 글자 없이 금액·수수료·숫자 키패드만 보인다(실기 2026-10-03)
    passwordHint:
      /CVV를 입력|결제 ?비밀번호|支付密码|请输入|주문금액|국제카드 수수료|Enter CVV|Order total|International Card|Payment Password/i,
    successHint: /결제 ?(?:완료|성공)|支付成功|付款成功|完成|Payment Successful|Paid/,
    openBy: 'app',
    keepIfForeground: true,
    appOnly: true,
    multiStep: true,
    // 'CVV를 입력하세요' 제목 화면은 실제로는 6자리 결제 비밀번호 키패드다 — 실기 2026-10-03 唯品会: 결제 비밀번호 6자리를
    // 넣으면 카드사 인증으로 넘어갔고, 카드 CVC 3자리를 넣으면 그 화면에 그대로 머물렀다. 그래서 cvvHint 는 두지 않는다
    // (card-cvc 경로는 CVV 만 따로 묻는 화면이 확인될 때 쓴다)
    // 카드사(현대카드) PIN 화면은 3D 인증 페이지(Cruise API) 안의 보안 키패드다
    pinHint: /Cruise API|PIN ?번호 ?입력|비밀번호를 입력/,
    // '백신 설치' 페이지 = 카드사 3D 인증(Cruise API)이 V3 확인을 못 받은 상태 — 이 폰에선 설치·권한·재설치로도 안 풀렸고
    // (2026-10-03, 알리페이 12.12.16 웹뷰가 V3 스킴을 안 보냄) '다음'을 반복해 두드릴수록 카드사 위험점수만 오른다. 바로 멈춘다
    blockerHint: /系统正忙|백신 설치|백신 앱을 설치/
  },
  // 롯데카드 앱카드(디지로카 앱 com.lcacApp 의 로카페이) — PC 결제창(sps.lottecard.co.kr)은 푸시를 보내지 않고
  // 7자리 숫자코드(잔여시간 10분)를 보여 준다(실기 2026-10-06 롯데온). 폰에서 로카페이 → 코드 입력 → 결제 비밀번호 →
  // 완료 뒤, PC 결제창의 [결제 완료]는 하네스가 누른다(appOnly: 웹 성공 확인은 하네스 몫)
  // 실기 2026-10-06 로카페이: 홈(카드 캐러셀·[숫자 코드]) → 숫자코드 화면('PC 화면의 숫자코드를 입력해주세요', 키패드 뷰 탭)
  // → 섞인 보안 키패드(contentDesc 0~9·삭제·입력완료, 캡처 불가). 카드는 반드시 LOCA Professional 1832(사용자 2026-10-06)
  lottecard: {
    id: 'lottecard',
    packageName: 'com.lcacApp',
    deepLink: 'lcacapp://',
    launchActivity: 'com.lcacApp/.appcard.views.activity.AppCardActivity',
    confirmText: /^(?:결제하기|확인|다음|결제|입력완료)$/,
    passwordHint: /결제 ?비밀번호|간편 ?비밀번호|비밀번호 ?(?:6자리|입력)/,
    successHint: /결제(?:가)? ?완료|승인(?:이)? ?완료|완료되었습니다|결제 성공/,
    openBy: 'app',
    appOnly: true,
    appPath: [/LOCA Professional 1832/, /^숫자 ?코드$/, /숫자코드\(7자리\) 입력 키패드/],
    codeHint: /숫자코드 입력|PC 화면의 숫자코드/
  }
}

/**
 * 결제앱(PayProvider) → 금고 결제 수단(PaymentProvider) 매핑.
 * 사이트 자체 결제(무신사머니·SSG머니 등)는 웹에서 끝나므로 여기 없고 'site' 를 쓴다
 */
export const PAY_APP_TO_PAYMENT_PROVIDER: Record<PayProvider, PaymentProvider> = {
  toss: 'toss',
  payco: 'payco',
  kakaopay: 'kakao',
  naverpay: 'naver',
  alipay: 'alipay',
  lottecard: 'lottecard'
}

/**
 * 결제 앱 자체의 계정이 키마스터에 저장되는 사이트(등록 도메인). 네이버페이만 — 네이버 계정으로 로그인하고
 * 결제 비밀번호도 그 계정의 것이라 구매 사이트(abcmart) 계정이 아니라 네이버 계정에서 찾는다.
 * 토스·카카오·페이코는 전화번호 결제라 구매 사이트 계정의 항목을 그대로 쓴다
 */
export const PAY_APP_ACCOUNT_HOST: Partial<Record<PayProvider, string>> = {
  naverpay: PAYMENT_PROVIDER_ACCOUNT_HOST.naver ?? 'naver.com',
  alipay: PAYMENT_PROVIDER_ACCOUNT_HOST.alipay ?? 'alipay.com',
  lottecard: PAYMENT_PROVIDER_ACCOUNT_HOST.lottecard ?? 'lottecard.co.kr'
}

/** 앱 화면을 더듬는 최대 스텝(무한 루프 방지) */
export const MAX_PAY_STEPS = 30
/** 화면이 그대로일 때 다음 확인까지 기다리는 시간 */
export const PAY_POLL_MS = 1000

export type PayGate = 'ok' | 'bad-amount' | 'vault-locked'

/** 결제를 시작해도 되는지 본다. 금액은 원 단위 정수다. 금액 상한은 두지 않는다 — 사용자가 시킨 결제는 그대로 한다 */
export function checkPaymentGate(input: { amountKrw: number; vaultUnlocked: boolean }): PayGate {
  if (!(input.amountKrw > 0)) return 'bad-amount'
  // 금고가 잠겨 있으면 비밀번호를 만질 수 없으므로 시작조차 하지 않는다
  if (!input.vaultUnlocked) return 'vault-locked'
  return 'ok'
}

/** 글자를 정규식에 그대로 넣을 수 있게 특수문자를 막는다 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch)
}

function hasText(screen: PhoneScreen, re: RegExp): boolean {
  return screen.elements.some((e) => re.test(e.text) || re.test(e.contentDesc ?? ''))
}

function findConfirm(screen: PhoneScreen, re: RegExp): number | undefined {
  const clickable = screen.elements.find(
    (e) => e.clickable && (re.test(e.text) || re.test(e.contentDesc ?? ''))
  )
  if (clickable) return clickable.id
  // 글자(TextView)와 눌리는 영역(빈 View)이 따로인 버튼이 있다(실기: 토스 결제 화면의 [결제하기]).
  // 글자 자리를 누르면 그 아래 버튼이 받는다. 본문 문장을 누르지 않도록 글자 전체가 버튼 문구와 같을 때만 고른다
  const whole = new RegExp(`^(?:${re.source})$`)
  return screen.elements.find((e) => whole.test(e.text.trim()))?.id
}

/** 결제 앱이 올린 알림 한 건(dumpsys notification 에서 읽는다). 발신 앱이 그 결제 앱인 것만 담는다 */
export interface AppNotification {
  title: string
  text: string
}

/** 결제 요청 알림으로 볼 문구 — 광고·혜택 알림을 누르지 않게 제목이나 본문에 이 말이 있어야 한다 */
const PAY_NOTIFICATION_TEXT = /결제|승인/

/**
 * `dumpsys notification --noredact` 출력에서 **그 패키지가 올린** 알림의 제목·본문만 뽑는다.
 * 알림창 글자로 앱을 짐작하지 않는다 — 카카오톡으로 온 "토스" 채널 메시지처럼 제목이 같은 남의 알림을
 * 눌러 버린다(실기). 누가 올렸는지는 알림 기록의 pkg 로만 가린다
 */
export function parseAppNotifications(stdout: string, packageName: string): AppNotification[] {
  const out: AppNotification[] = []
  let mine = false
  let current: AppNotification | null = null
  const valueOf = (line: string): string =>
    /=String \((.*)$/.exec(line)?.[1]?.replace(/\)\s*$/, '') ?? ''
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('NotificationRecord(')) {
      if (current && (current.title || current.text)) out.push(current)
      mine = line.includes(`pkg=${packageName} `)
      current = mine ? { title: '', text: '' } : null
      continue
    }
    if (!mine || !current) continue
    if (line.startsWith('android.title=')) current.title = valueOf(line)
    else if (line.startsWith('android.text=')) current.text = valueOf(line)
  }
  if (current && (current.title || current.text)) out.push(current)
  return out.filter((n) => PAY_NOTIFICATION_TEXT.test(`${n.title} ${n.text}`))
}

/**
 * 알림창(내려진 상태)에서 누를 요소. 그 결제 앱이 올린 결제 알림의 **제목(없으면 본문)과 글자가 정확히 같은**
 * 요소만 고른다. 같은 글자가 없으면 아무것도 누르지 않는다
 */
export function findPayNotification(
  screen: PhoneScreen,
  notifications: readonly AppNotification[]
): number | undefined {
  const same = (a: string, b: string): boolean => a.trim() !== '' && a.trim() === b.trim()
  for (const n of notifications) {
    const byTitle = screen.elements.find((e) => same(e.text, n.title))
    if (byTitle) return byTitle.id
    const byText = screen.elements.find((e) => same(e.text, n.text))
    if (byText) return byText.id
  }
  return undefined
}

/** 지금 화면이 비밀번호(보안 키패드) 화면인가. 스크린샷 저장·전송 판정에도 쓴다 */
export function isSecretScreen(screen: PhoneScreen, spec: PayProviderSpec): boolean {
  if (screen.elements.some((e) => e.isSecret)) return true
  return hasText(screen, spec.passwordHint)
}

/** 카드사 이름과 앱에 보이는 카드 상품명이 다른 경우 */
const CARD_ALIASES: Record<string, string[]> = {
  롯데: ['롯데', 'LOCA'],
  국민: ['국민', 'KB'],
  KB: ['KB', '국민']
}

/** 지시받은 카드 이름("현대카드", "롯데")을 앱의 카드 상품명("넥슨현대UNLIMITED", "LOCA …")과 맞출 정규식으로 */
export function cardPatternOf(hint: string): RegExp {
  const core = hint.replace(/\s+/g, '').replace(/카드$/, '') || hint.trim()
  const names = CARD_ALIASES[core.toUpperCase()] ?? CARD_ALIASES[core] ?? [core]
  return new RegExp(names.map(escapeRegExp).join('|'), 'i')
}

/** 카드 맞추기에서 누르는 최대 횟수(변경 버튼 1 + 카드 1, 여유 포함) */
const MAX_CARD_TAPS = 4

type CardStep =
  | { kind: 'ready'; card: string }
  | { kind: 'wait' }
  | { kind: 'missing' }
  | { kind: 'tap'; x: number; y: number; label: string }

/** 글자 있는 줄 기준으로 카드명·일시불 안내 두 줄만 본다 */
const SELECTED_CARD_TEXT_LINES = 2

/**
 * 결제 화면에 지금 선택돼 있는 카드 이름. [결제수단 변경] 버튼 바로 위 몇 줄만 본다 —
 * 화면 다른 곳(혜택 안내·상품명)에 든 카드사 이름을 "이미 선택됨"으로 잘못 보지 않게 한다
 * (실기: 현대카드를 지정했는데 롯데(LOCA)로 결제됐다). 변경 버튼이 없으면 빈 문자열
 */
export function selectedCardOf(screen: PhoneScreen, spec: PayProviderSpec): string {
  // 할부 줄이 있으면 그 바로 위 글자 줄이 선택된 카드다(실기 2026-10-06 토스: 카드 행 두 줄 중 선택된 행 아래에만 할부 줄)
  if (spec.installmentText) {
    const at = screen.elements.findIndex((e) => spec.installmentText?.test(e.text))
    if (at >= 0) {
      const above = screen.elements
        .slice(0, at)
        .map((e) => e.text.trim())
        .filter((t) => t !== '')
      return above[above.length - 1] ?? ''
    }
  }
  if (!spec.changeMethodText) return ''
  const idx = screen.elements.findIndex((e) => spec.changeMethodText?.test(e.text))
  if (idx < 0) return ''
  // 글자 없는 클릭 요소(체크 원·행 틀)는 세지 않는다 — 사이에 끼어 있어도 카드 이름 줄이 밀리지 않게(실기 2026-10-06 토스:
  // '넥슨현대UNLIMITED' 와 [결제수단 변경] 사이에 빈 요소가 있어 선택 카드를 못 읽고 card-not-found).
  // 다만 보는 범위는 옛 규칙(원래 요소 3개)과 같은 크기의 글자 있는 줄 2개로 좁힌다 — 카드 줄과 '일시불' 안내 줄뿐이다
  return screen.elements
    .slice(0, idx)
    .map((e) => e.text.trim())
    .filter((t) => t !== '')
    .slice(-SELECTED_CARD_TEXT_LINES)
    .join(' ')
}

/**
 * 결제 화면에서 지정한 카드를 고르기 위한 다음 한 수.
 *  - 카드 선택 목록이 열려 있으면: 이름이 맞는 카드를 누른다(없으면 missing — 다른 카드로 결제하지 않는다)
 *  - 결제 화면이면: 지정 카드가 이미 보이면 ready, 아니면 [결제수단 변경]을 누른다
 *  - 둘 다 아니면(화면 전환 중) wait
 */
export function cardStep(screen: PhoneScreen, spec: PayProviderSpec, card: RegExp): CardStep {
  const at = (e: PhoneScreen['elements'][number]): CardStep => ({
    kind: 'tap',
    x: e.center.x,
    y: e.center.y,
    label: e.text.trim()
  })
  if (spec.methodSheetTitle && hasText(screen, spec.methodSheetTitle)) {
    const match = screen.elements.find((e) => card.test(e.text))
    return match ? at(match) : { kind: 'missing' }
  }
  if (findConfirm(screen, spec.confirmText) === undefined) return { kind: 'wait' }
  // "이미 선택됨"은 [결제수단 변경] 바로 위 카드 줄로만 판정한다 — 화면 전체에서 찾지 않는다
  const selected = selectedCardOf(screen, spec)
  if (selected !== '' && card.test(selected)) return { kind: 'ready', card: selected }
  const change = spec.changeMethodText
    ? screen.elements.find((e) => spec.changeMethodText?.test(e.text))
    : undefined
  // 결제 화면에 카드 행이 바로 보이면(토스: 넥슨현대·LOCA 두 줄) 그 행을 눌러 고른다 — [결제수단 변경] 목록을
  // 거치면 "결제 취소할까요?" 팝업이 떴다(실기 2026-10-06). 카드 행은 할부 줄(없으면 변경 버튼) 위에만 있다 —
  // 그 아래의 혜택 안내("현대카드로 결제하면…")는 카드 행이 아니다
  const limit =
    (spec.installmentText
      ? screen.elements.find((e) => spec.installmentText?.test(e.text))
      : undefined) ?? change
  const row = limit
    ? screen.elements.find((e) => e.bounds.t < limit.bounds.t && card.test(e.text))
    : undefined
  if (row) return at(row)
  // 변경 버튼이 안 보이면 아직 결제 화면이 아니다 — 카드가 없다고 단정하지 않고 기다린다
  return change ? at(change) : { kind: 'wait' }
}

/** 앱 안에서 화면을 보고 다음 할 일을 정한다 */
function stepInApp(
  screen: PhoneScreen,
  spec: PayProviderSpec
): { state: PayState; tapElementId?: number } {
  // 비밀번호 화면 판정이 가장 먼저다 — 여기서 아무 버튼이나 누르면 안 된다
  if (isSecretScreen(screen, spec)) return { state: 'password' }
  if (hasText(screen, spec.successHint)) return { state: 'verify' }
  // 결제 화면 표식이 있는 앱은 그 화면에서만 누른다
  if (spec.payScreenHint && !hasText(screen, spec.payScreenHint)) return { state: 'app_steps' }
  const tapElementId = findConfirm(screen, spec.confirmText)
  return tapElementId === undefined ? { state: 'app_steps' } : { state: 'app_steps', tapElementId }
}

/** 화면을 보고 다음 상태를 정하는 순수 전이 함수 */
export function nextPayState(
  state: PayState,
  screen: PhoneScreen,
  spec: PayProviderSpec
): { state: PayState; tapElementId?: number } {
  switch (state) {
    case 'idle':
      return { state: 'await_app' }
    case 'await_app':
      // 앱이 앞으로 나오기 전에는 아무것도 누르지 않는다
      return screen.app === spec.packageName ? stepInApp(screen, spec) : { state: 'await_app' }
    case 'app_steps':
      return stepInApp(screen, spec)
    case 'password':
      if (hasText(screen, spec.successHint)) return { state: 'verify' }
      // 단계가 더 있는 결제: 비밀 화면이 끝났으면(카드사 인증 안내 등) 그 화면의 버튼을 따라간다
      if (spec.multiStep && !isSecretScreen(screen, spec)) return stepInApp(screen, spec)
      return { state: 'password' }
    case 'verify':
      if (hasText(screen, spec.successHint)) return { state: 'done' }
      // 비밀번호 뒤에 카드사 인증이 더 있는 결제는 다음 화면(버튼·비밀 화면)을 계속 따라간다
      if (
        spec.multiStep &&
        (isSecretScreen(screen, spec) || findConfirm(screen, spec.confirmText) !== undefined)
      ) {
        return stepInApp(screen, spec)
      }
      return { state: 'verify' }
    default:
      return { state }
  }
}

export type PayFailReason =
  | PayGate
  | 'declined'
  | 'password-failed'
  // 계정에 결제 비밀번호가 둘 이상인데 어느 것인지 좁히지 못했다(누르지 않고 멈춘다)
  | 'password-ambiguous'
  | 'layout-incomplete'
  | 'verify-failed'
  | 'stuck'
  // 지정한 카드가 결제 앱의 카드 목록에 없다(다른 카드로 결제하지 않고 멈춘다)
  | 'card-not-found'
  // CVV 를 물었는데 계정에 카드 항목(card.cvc)이 없거나 둘 이상이다
  | 'card-not-saved'
  // 카드사 인증이 백신 앱 설치 등 사람만 할 수 있는 것을 요구한다
  | 'blocked-by-app'
  // 앱이 숫자코드를 묻는데 요청에 code 가 없다(롯데카드 앱카드)
  | 'code-missing'
  // 배선부가 실행기에 닿기도 전에 막는 두 가지(계정 특정 실패·연결된 폰 없음)
  | 'no-account'
  | 'no-phone'
  // 결제 앱 계정(네이버 등)이 여럿인데 payAccount 로 고르지 않았다
  | 'pay-account-ambiguous'
  // 네이버페이 창이 고른 네이버 계정이 아닌 다른 계정으로 로그인돼 있다
  | 'pay-account-mismatch'
  // 시험 입력(dry-run) — 결제 비밀번호를 일부만 누르고 취소했다. 실패가 아니라 "결제하지 않음" 이다
  | 'dry-run'

export interface PayResult {
  ok: boolean
  reason?: PayFailReason
  /** 모델에게 돌려줄 덧붙임(예: 고를 수 있는 계정 아이디 목록). 비밀 값은 절대 담지 않는다 */
  detail?: string
}

export interface PayRequest {
  provider: PayProvider
  amountKrw: number
  merchant: string
  /** 확인 카드에 보일 결제수단 이름 */
  methodLabel: string
  /** 확인 카드에 보일 폰 별칭 */
  phoneLabel: string
  accountId: number
  phoneId: number | null
  serial: string
  siteHost: string
  jobId?: string
  /** 결제 앱 안에서 고를 카드 이름의 일부(예: "현대"). 지금 선택된 카드가 이와 다르면 바꾼 뒤 결제한다 */
  cardHint?: string
  /** 웹 결제창이 보여 준 숫자코드(롯데카드 앱카드 7자리) — spec.codeHint 화면에 친다. 숫자만 */
  code?: string
  /** 결제 전에 확인 카드를 띄울지. 생략하면 띄운다(guard). 자동 모드에서는 false */
  confirmFirst?: boolean
  /**
   * 시험 입력(dry-run) 자리수. 주면 결제 비밀번호 화면까지 가서 이 자리수만 누르고 취소한다 —
   * 결제는 끝내지 않는다. 앱 잠금 화면(토스)의 비밀번호는 그대로 다 푼다
   */
  dryRunDigits?: number
}

/**
 * 실행기가 남기는 인증 이벤트 1건(문자와 같은 표를 쓰되 본문은 없다).
 * dryRunDigits 는 시험 입력에서 누른 자리수다 — 표에는 열이 없어 저장되지 않고, 배선부·통계가 보는 값이다
 */
export type PayRecord = Omit<AuthEventDto, 'id'> & {
  kind: 'app_approve'
  dryRunDigits?: number
}

export interface PayRunDeps {
  phones: {
    screen: (serial: string) => Promise<PhoneScreen>
    tap: (serial: string, x: number, y: number) => Promise<void>
    screenshot: (serial: string) => Promise<{ png: Buffer; secret: boolean }>
    /** 뒤로 키. 시험 입력을 취소하고 키패드에서 빠져나오는 데만 쓴다 */
    back?: (serial: string) => Promise<void>
    /** 글자 입력(숫자코드). 비밀 값은 절대 여기로 보내지 않는다 — 결제 비밀번호는 tapPassword 가 누른다 */
    typeText?: (serial: string, text: string) => Promise<'ok' | 'unsupported-text'>
  }
  /** 딥링크로 결제 앱을 앞으로 부른다(배선부가 am start 로 채운다) */
  launchApp: (serial: string, deepLink: string) => Promise<void>
  /**
   * 알림창을 내리고/올린다. 결제 앱을 열어도 결제 요청 화면이 안 나올 때(요청이 푸시 알림으로만 와 있을 때)
   * 알림을 눌러 여는 데 쓴다. 주입되지 않으면 그 경로는 건너뛴다
   */
  notifications?: {
    open: (serial: string) => Promise<void>
    close: (serial: string) => Promise<void>
    /** 그 패키지가 올린 결제 알림(제목·본문). 발신 앱은 알림 기록의 pkg 로 가린다 */
    list: (serial: string, packageName: string) => Promise<AppNotification[]>
  }
  /** 결제 확인 카드. 권한 모드와 무관하게 정확히 1회 부른다 */
  confirm: (action: string) => Promise<boolean>
  /** 비밀번호를 읽을 금고. 값은 tapPaymentPassword 안에서만 복호화된다 */
  vault: PaySecretVault
  vaultUnlocked: () => boolean
  keypad: KeypadSource
  /** 웹 결제창(팝업)이 성공 주소로 넘어갔는가 */
  webSuccess: () => Promise<boolean>
  record: (e: PayRecord) => void
  /** 실패 알림. 비밀번호 화면이면 png 를 넘기지 않는다 */
  notify: (message: string, png?: Buffer) => void
  onStep: (label: string, ok: boolean) => void
  now: () => number
  sleep?: (ms: number) => Promise<void>
  /** 캡차 넘김과 같은 카드로 사람에게 넘긴다(키패드를 못 읽었을 때) */
  handoff?: (req: {
    matched: string
    currentUrl: () => string
    stillBlocked: () => Promise<boolean>
    kind?: 'captcha' | 'keypad'
  }) => Promise<HandoffResult>
  /** 테스트에서 바꿔 끼우는 비밀번호 입력기. 기본값은 pay-secret 의 구현이다 */
  tapPassword?: typeof tapPaymentPassword
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

/** 12000 → '12,000' */
export function formatKrw(amount: number): string {
  return String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 확인 카드 문구 — 금액·가맹점·결제수단·폰 별칭을 모두 보여 준다 */
export function payConfirmText(req: PayRequest): string {
  return tr('phone.payConfirm', {
    amount: formatKrw(req.amountKrw),
    merchant: req.merchant,
    method: req.methodLabel,
    phone: req.phoneLabel
  })
}

// 문구는 앱 언어를 따라야 하므로 키만 두고 쓰는 시점에 번역한다
const GATE_LABEL: Record<Exclude<PayGate, 'ok'>, MessageKey> = {
  'bad-amount': 'phone.gateBadAmount',
  'vault-locked': 'phone.gateVaultLocked'
}

const SECRET_FAIL: Record<Exclude<PaySecretResult, 'ok'>, PayFailReason> = {
  locked: 'vault-locked',
  'not-found': 'password-failed',
  ambiguous: 'password-ambiguous',
  'layout-incomplete': 'layout-incomplete'
}

export async function runPayApproval(deps: PayRunDeps, req: PayRequest): Promise<PayResult> {
  const spec = PAY_PROVIDERS[req.provider]
  const sleep = deps.sleep ?? defaultSleep
  const tapPassword = deps.tapPassword ?? tapPaymentPassword
  const startedAt = deps.now()
  // 키패드를 Visual 로 읽었는지 — 인증 이벤트의 method 에 남긴다
  let usedVisual = false

  const finish = (ok: boolean, reason?: PayFailReason, detail?: string): PayResult => {
    const at = deps.now()
    deps.record({
      kind: 'app_approve',
      ...(req.dryRunDigits === undefined ? {} : { dryRunDigits: req.dryRunDigits }),
      jobId: req.jobId ?? null,
      phoneId: req.phoneId,
      siteHost: req.siteHost,
      ok,
      method: usedVisual ? 'visual' : 'manual',
      elapsedMs: at - startedAt,
      // 결제 승인에는 인증번호도 발신번호도 없다
      code: null,
      senderTail: null,
      at
    })
    if (ok) return { ok: true }
    return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
  }

  /** 실패 통지 + 기록. 비밀번호 화면이면 이미지를 아예 만들지 않는다 */
  const fail = async (reason: PayFailReason, screen: PhoneScreen | null): Promise<PayResult> => {
    deps.onStep(tr('phone.payFailedStep', { reason }), false)
    const message = tr('phone.payFailedNotice', { reason })
    if (screen && isSecretScreen(screen, spec)) {
      deps.notify(message)
      return finish(false, reason)
    }
    try {
      const shot = await deps.phones.screenshot(req.serial)
      if (shot.secret || shot.png.length === 0) deps.notify(message)
      else deps.notify(message, shot.png)
    } catch {
      // 캡처가 실패해도 통지는 남긴다(오류 본문에는 화면이 실릴 수 있어 남기지 않는다)
      deps.notify(message)
    }
    return finish(false, reason)
  }

  /**
   * 시험 입력(dry-run)을 취소하고 끝낸다. 뒤로 키로 키패드에서 빠져나온 뒤,
   * 혹시 결제가 끝나 버렸는지(성공 문구) 한 번 확인해 사용자에게 알린다
   */
  const cancelDryRun = async (typed: number): Promise<PayResult> => {
    if (deps.phones.back) {
      try {
        await deps.phones.back(req.serial)
      } catch {
        // 뒤로 키가 듣지 않아도 아래 확인은 그대로 한다(사용자가 화면을 보고 닫을 수 있게)
      }
    }
    await (deps.sleep ?? defaultSleep)(PAY_POLL_MS)
    let after: PhoneScreen | null = null
    try {
      after = await deps.phones.screen(req.serial)
    } catch {
      after = null
    }
    if (after && hasText(after, spec.successHint)) {
      // 반만 눌렀는데 결제 완료 문구가 보인다 — 그냥 넘기지 않고 곧바로 알린다
      deps.onStep(tr('phone.payDryRunSucceeded'), false)
      deps.notify(tr('phone.payDryRunSucceeded'))
    } else {
      deps.onStep(tr('phone.payDryRunCancelled', { digits: typed }), true)
    }
    return finish(false, 'dry-run', `typed ${typed} digits then cancelled`)
  }

  /** 키패드를 못 읽으면 누르지 않고 사람에게 넘긴다(캡차 넘김 카드 재사용) */
  const handOff = async (screen: PhoneScreen): Promise<PayResult> => {
    if (deps.handoff) {
      const result = await deps.handoff({
        matched: tr('phone.payKeypadHandoff'),
        kind: 'keypad',
        currentUrl: () => req.siteHost,
        // 비밀번호 화면이 사라지면 사용자가 직접 끝낸 것으로 본다
        stillBlocked: async () => isSecretScreen(await deps.phones.screen(req.serial), spec)
      })
      if (result.outcome === 'resumed' && (spec.appOnly || (await deps.webSuccess()))) {
        deps.onStep(tr('phone.payDoneByUser'), true)
        return finish(true)
      }
    }
    return fail('layout-incomplete', screen)
  }

  const gate = checkPaymentGate({ amountKrw: req.amountKrw, vaultUnlocked: deps.vaultUnlocked() })
  if (gate !== 'ok') {
    // 앱을 열기 전이라 화면도 없다 — 카드도 띄우지 않고 사유만 남긴다
    deps.onStep(tr('phone.payRejected', { reason: tr(GATE_LABEL[gate]) }), false)
    return finish(false, gate)
  }

  // 확인 카드는 앱의 권한 모드를 따른다 — guard 에서만 묻고, 자동(full)에서는 묻지 않는다
  if (req.confirmFirst !== false && !(await deps.confirm(payConfirmText(req)))) {
    deps.onStep(tr('phone.payConfirmDeclined'), false)
    return finish(false, 'declined')
  }

  // 가장 짧은 길은 결제 요청 알림을 누르는 것이다(누르면 바로 결제 화면). 그 앱이 올린 결제 알림이 없을 때만
  // 앱을 직접 연다 — 앱만 열면 홈 화면이라 알림함을 거쳐야 해서 길다
  // openBy 가 'app' 인 앱(토스)은 알림창을 거치지 않고 앱을 바로 연다 — 결제 요청이 걸려 있으면 그 화면이 뜬다.
  // 앱을 열어도 결제 화면이 안 나오면 아래 루프에서 몇 번 기다린 뒤에야 알림창을 시도한다
  let notificationTried = false
  if (deps.notifications && spec.openBy !== 'app') {
    notificationTried = true
    if (!(await openPayNotification(deps, req.serial, spec))) {
      await deps.launchApp(req.serial, spec.deepLink)
    }
  } else if (!(
    spec.keepIfForeground && (await deps.phones.screen(req.serial)).app === spec.packageName
  )) {
    await deps.launchApp(req.serial, spec.deepLink)
  }

  let state: PayState = 'await_app'
  let lastTapped: number | null = null
  let passwordTried = false
  // CVV·카드사 PIN 을 넣은 적이 있는가(알리페이 국제카드) — 결제 비밀번호와 따로 센다
  let cvvTried = false
  let pinTried = false
  // 마지막으로 비밀(결제 비밀번호·CVV·PIN)을 넣은 차례 — 넣은 직후 같은 화면이 남아 있는 동안은 기다린다
  let secretAt = -1
  // 앱 잠금 화면에 넣은 적이 있는가 — 결제 비밀번호 입력과 따로 센다
  let unlockTried = false
  let unlockedAt = -1
  let screen: PhoneScreen | null = null
  // 누를 것이 없던 횟수. 몇 번 이어지면 알림창의 결제 요청 알림을 눌러 본다(실행당 한 번)
  let idlePolls = 0
  // 결제 앱 안에서 고를 카드(이름 일부). 지정이 없거나 그 앱이 카드 바꾸기를 지원하지 않으면 건드리지 않는다
  const cardPattern =
    req.cardHint && req.cardHint.trim() !== '' && spec.changeMethodText && spec.methodSheetTitle
      ? cardPatternOf(req.cardHint)
      : null
  let cardReady = false
  let cardTaps = 0
  // 카드를 지정하지 않은 결제는 앱에 선택된 카드로 나간다 — 어떤 카드였는지 진행 로그에 한 번 남긴다
  let cardNoted = false
  // 앱 안 경로(appPath)에서 다음에 누를 버튼 차례, 숫자코드를 넣었는가
  let pathIdx = 0
  let codeTyped = false

  for (let i = 0; i < MAX_PAY_STEPS && state !== 'done'; i++) {
    screen = await deps.phones.screen(req.serial)
    const next = nextPayState(state, screen, spec)
    state = next.state
    // 비밀 화면을 벗어났으면 입력 직후 유예도 끝난다 — 다음 비밀 화면(카드사 PIN)은 새로 센다
    if (state !== 'password') secretAt = -1

    if (spec.blockerHint && hasText(screen, spec.blockerHint)) return fail('blocked-by-app', screen)

    if (state === 'password') {
      // 알리페이 국제카드: CVV → 결제 비밀번호 → 카드사 PIN(=결제 비밀번호) 순서로 비밀 화면이 셋 온다. 각각 한 번씩만
      const cvv = spec.cvvHint !== undefined && hasText(screen, spec.cvvHint)
      // PIN 은 보안 입력칸이 있는 화면에서만 — 'PIN번호 결제' 를 고르는 안내 화면은 버튼을 눌러야 한다
      const pin =
        !cvv &&
        spec.pinHint !== undefined &&
        hasText(screen, spec.pinHint) &&
        screen.elements.some((e) => e.isSecret)
      // 비밀을 넣은 직후에는 화면이 넘어가는 동안 같은 화면이 잠깐 더 보인다 — 그동안은 기다리기만 한다
      if (secretAt >= 0 && i - secretAt <= UNLOCK_GRACE_POLLS) {
        await sleep(PAY_POLL_MS)
        continue
      }
      if (cvv || pin) {
        if (cvv ? cvvTried : pinTried) return fail('verify-failed', screen)
        secretAt = i
        if (cvv) cvvTried = true
        else pinTried = true
        const layout = await resolveKeypad(deps, screen, req.serial, (v) => (usedVisual = v))
        if (!layout) return handOff(screen)
        const r = await tapPassword({
          vault: deps.vault,
          accountId: req.accountId,
          provider: PAY_APP_TO_PAYMENT_PROVIDER[req.provider],
          ...(req.jobId === undefined ? {} : { jobId: req.jobId }),
          serial: req.serial,
          layout,
          tap: deps.phones.tap,
          onStep: deps.onStep,
          secret: cvv ? 'card-cvc' : 'payment'
        })
        if (r !== 'ok') {
          return fail(
            cvv && (r === 'not-found' || r === 'ambiguous') ? 'card-not-saved' : SECRET_FAIL[r],
            screen
          )
        }
        deps.onStep(tr(cvv ? 'phone.payCvvTyped' : 'phone.payPinTyped'), true)
        state = cvv ? 'app_steps' : 'verify'
        lastTapped = null
        await sleep(PAY_POLL_MS)
        continue
      }
      // 앱 잠금 화면인가(앱을 켤 때 먼저 묻는 비밀번호). 잠금 1회 + 결제 1회, 어느 쪽도 재시도하지 않는다 —
      // 같은 화면이 두 번째로 보이면 잘못 눌린 것으로 본다(오답이 쌓이면 잠긴다)
      const unlocking = spec.unlockHint !== undefined && hasText(screen, spec.unlockHint)
      // 비밀번호를 넣은 직후에는 화면이 넘어가는 동안 같은 잠금 화면이 잠깐 더 보인다 — 그동안은 기다리기만 한다
      if (unlocking && unlockTried && i - unlockedAt <= UNLOCK_GRACE_POLLS) {
        await sleep(PAY_POLL_MS)
        continue
      }
      if (unlocking ? unlockTried : passwordTried) return fail('verify-failed', screen)
      if (!unlocking) secretAt = i
      if (unlocking) unlockedAt = i
      if (unlocking) unlockTried = true
      else passwordTried = true
      const layout = await resolveKeypad(deps, screen, req.serial, (v) => (usedVisual = v))
      if (!layout) return handOff(screen)
      // 시험 입력은 결제 비밀번호에만 건다 — 앱 잠금(토스)은 끝까지 풀어야 결제 화면에 닿는다
      const dryRun = !unlocking && req.dryRunDigits !== undefined
      let typedDigits = req.dryRunDigits ?? 0
      const r = await tapPassword({
        ...(dryRun && req.dryRunDigits !== undefined
          ? {
              maxDigits: req.dryRunDigits,
              onTyped: (n: number) => {
                typedDigits = n
              }
            }
          : {}),
        vault: deps.vault,
        accountId: req.accountId,
        provider: PAY_APP_TO_PAYMENT_PROVIDER[req.provider],
        ...(req.jobId === undefined ? {} : { jobId: req.jobId }),
        serial: req.serial,
        layout,
        tap: deps.phones.tap,
        onStep: deps.onStep
      })
      if (r !== 'ok') return fail(SECRET_FAIL[r], screen)
      // 시험 입력이면 여기서 끝난다 — 이어서 누르지도, 완료를 기다리지도 않는다
      if (dryRun) return cancelDryRun(typedDigits)
      // 잠금을 풀었으면 결제 화면을 마저 따라간다. 결제 비밀번호였으면 완료를 기다린다 —
      // 단계가 더 있는 결제(알리페이 국제카드)는 카드사 인증 버튼·PIN 화면을 계속 따라간다
      state = unlocking || spec.multiStep ? 'app_steps' : 'verify'
      lastTapped = null
      await sleep(PAY_POLL_MS)
      continue
    }

    // 숫자코드 화면(롯데카드 앱카드): 진행 버튼보다 먼저 코드를 넣는다 — 빈 채로 [확인]을 누르지 않는다
    // 숫자 키패드(0~9)가 보여야 코드 화면이다 — 안내 문구만 있는 화면(키패드 뷰를 눌러야 키패드가 뜬다)은 경로 버튼으로 본다
    const codeKeypad =
      spec.codeHint && state === 'app_steps' && !codeTyped && hasText(screen, spec.codeHint)
        ? deps.keypad.fromUiTree(screen)
        : null
    if (codeKeypad) {
      const code = req.code?.trim() ?? ''
      if (!/^\d{4,12}$/.test(code)) return fail('code-missing', screen)
      // 코드는 비밀이 아니다 — 자리마다 키패드의 그 숫자를 누른다(키 배치는 섞여 있어 화면에서 읽은 자리를 쓴다)
      for (const d of code) {
        const key = codeKeypad.digits[d]
        if (!key) return fail('layout-incomplete', screen)
        await deps.phones.tap(req.serial, key.x, key.y)
      }
      codeTyped = true
      lastTapped = null
      idlePolls = 0
      deps.onStep(tr('phone.payCodeTyped'), true)
      await sleep(PAY_POLL_MS)
      continue
    }
    // 앱 안 경로(appPath): 결제 요청 화면으로 가는 버튼을 순서대로 한 번씩 누른다(코드를 넣기 전까지만)
    if (spec.appPath && pathIdx < spec.appPath.length && state === 'app_steps' && !codeTyped) {
      const want = spec.appPath[pathIdx]
      const el = screen.elements.find(
        (e) => want.test(e.text.trim()) || want.test(e.contentDesc ?? '')
      )
      if (el) {
        pathIdx += 1
        lastTapped = null
        idlePolls = 0
        deps.onStep(tr('phone.payPathTap', { label: el.text.trim() || el.contentDesc || '' }), true)
        await deps.phones.tap(req.serial, el.center.x, el.center.y)
        await sleep(PAY_POLL_MS)
        continue
      }
    }

    // 카드 지정: 결제하기를 누르기 전에 선택된 카드를 맞춘다
    if (cardPattern && !cardReady && state === 'app_steps') {
      const step = cardStep(screen, spec, cardPattern)
      if (step.kind === 'ready') {
        cardReady = true
        deps.onStep(tr('phone.payCardReady', { card: step.card }), true)
      } else if (step.kind === 'missing') return fail('card-not-found', screen)
      else if (step.kind === 'tap' && cardTaps < MAX_CARD_TAPS) {
        cardTaps += 1
        idlePolls = 0
        lastTapped = null
        deps.onStep(tr('phone.payCardTap', { label: step.label }), true)
        await deps.phones.tap(req.serial, step.x, step.y)
        await sleep(PAY_POLL_MS)
        continue
      } else if (step.kind === 'tap') return fail('card-not-found', screen)
    } else if (
      !cardPattern &&
      !cardNoted &&
      state === 'app_steps' &&
      next.tapElementId !== undefined
    ) {
      const selected = selectedCardOf(screen, spec)
      if (selected !== '') {
        cardNoted = true
        deps.onStep(tr('phone.payCardUnspecified', { card: selected }), true)
      }
    }

    // 같은 요소를 두 번 연속 누르지 않는다(무한 탭 방지)
    if (next.tapElementId !== undefined && next.tapElementId !== lastTapped) {
      const el = findElement(screen, next.tapElementId)
      if (el) {
        lastTapped = next.tapElementId
        idlePolls = 0
        await deps.phones.tap(req.serial, el.center.x, el.center.y)
        continue
      }
    }
    idlePolls += 1
    const waiting = state === 'await_app' || state === 'app_steps'
    if (
      waiting &&
      !notificationTried &&
      idlePolls >= NOTIFICATION_AFTER_POLLS &&
      deps.notifications
    ) {
      notificationTried = true
      idlePolls = 0
      if (await openPayNotification(deps, req.serial, spec)) continue
    }
    await sleep(PAY_POLL_MS)
  }

  if (state !== 'done') return fail(passwordTried ? 'verify-failed' : 'stuck', screen)
  // 앱 완료 화면만으로는 부족하다 — 웹 팝업이 성공 주소로 넘어갔는지도 확인한다
  if (!spec.appOnly && !(await deps.webSuccess())) return fail('verify-failed', screen)
  deps.onStep(tr('phone.payDone'), true)
  return finish(true)
}

/** 앱 잠금을 푼 뒤 같은 잠금 화면이 이만큼까지는 더 보여도 기다린다(화면 전환 시간) */
const UNLOCK_GRACE_POLLS = 4

/** 결제 알림이 아직 없을 때 기다려 보는 횟수 */
const NOTIFICATION_WAIT_POLLS = 8

/** 알림을 누르는 최대 횟수(묶음 펼치기 1회 + 실제 알림 1~2회) */
const NOTIFICATION_TAP_TRIES = 3

/** 누를 것이 없는 화면이 이만큼 이어지면 알림창을 열어 본다 */
export const NOTIFICATION_AFTER_POLLS = 3

/** 알림창을 내려 이 결제 앱의 결제 요청 알림을 누른다. 눌렀으면 true. 못 찾으면 알림창을 도로 올린다 */
async function openPayNotification(
  deps: PayRunDeps,
  serial: string,
  spec: PayProviderSpec
): Promise<boolean> {
  const shade = deps.notifications
  const sleep = deps.sleep ?? defaultSleep
  if (!shade) return false
  try {
    let mine = await shade.list(serial, spec.packageName)
    // 웹에서 결제를 요청한 직후에는 알림이 아직 안 왔을 수 있다 — 잠깐 기다려 본다
    for (let w = 0; w < NOTIFICATION_WAIT_POLLS && mine.length === 0; w += 1) {
      await sleep(PAY_POLL_MS)
      mine = await shade.list(serial, spec.packageName)
    }
    // 그 앱이 올린 결제 알림이 없으면 알림창을 열지도 않는다
    if (mine.length === 0) return false
    await shade.open(serial)
    let tapped = false
    // 같은 앱의 알림이 여럿이면 묶음으로 접혀 있다 — 첫 탭은 묶음을 펼치기만 하므로, 앱이 앞으로 나올 때까지
    // 같은 제목을 다시 찾아 누른다(맨 위가 가장 새 알림이다)
    for (let attempt = 0; attempt < NOTIFICATION_TAP_TRIES; attempt += 1) {
      await sleep(PAY_POLL_MS)
      const screen = await deps.phones.screen(serial)
      if (screen.app === spec.packageName) return true
      const id = findPayNotification(screen, mine)
      const el = id === undefined ? undefined : findElement(screen, id)
      if (!el) break
      if (!tapped) deps.onStep(tr('phone.payNotificationOpened'), true)
      tapped = true
      await deps.phones.tap(serial, el.center.x, el.center.y)
    }
    if (tapped) return true
    await shade.close(serial)
    return false
  } catch {
    return false
  }
}

/** 키패드 배치: UI 트리 우선, 실패하면 Visual 에게 위치만 묻는다 */
async function resolveKeypad(
  deps: PayRunDeps,
  screen: PhoneScreen,
  serial: string,
  markVisual: (v: boolean) => void
): Promise<KeypadLayout | null> {
  const fromTree = deps.keypad.fromUiTree(screen)
  if (fromTree) return fromTree
  markVisual(true)
  return deps.keypad.fromVisual(serial)
}
