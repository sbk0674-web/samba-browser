import { PAYMENT_PROVIDER_ACCOUNT_HOST, payPriorityOf, visibleTags } from '../../shared/vault'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { TabManager, Tab } from '../browser/tab-manager'
import { adpickTrackingLink } from './affiliate'
import { pageBridge } from '../browser/page-bridge'
import type { KeypadLayout, LoginFieldsResult } from '../browser/page-bridge'
import { serializeSnapshot } from '../../shared/snapshot'
import type { PageOverlay, PageSnapshot } from '../../shared/snapshot'
import { diffLines } from '../../shared/snapshot-diff'
import {
  runJsLabel,
  runSandbox,
  RUN_JS_MAX_CODE,
  RUN_SCRIPT_TOTAL_TIMEOUT_MS,
  type RunJsBridge
} from './run-js'
import { isScriptFailure, type SiteScript, type SiteScriptInput } from '../../shared/site-scripts'
import { isDangerous } from '../../shared/danger'
import type { PermissionMode, VaultAccessPolicy } from '../../shared/settings'
import type { VaultService } from '../vault/service'
import type { AccountDto, PaymentProvider, VaultItemType } from '../../shared/vault'
import { normalizeHost } from '../../shared/host'
import {
  isNaverPayHost,
  maskedNaverAccount,
  maskedNaverAccountMatches
} from '../../shared/naverpay'
import {
  checkFillGate,
  checkVaultGate,
  effectiveAccess,
  isHostExcluded as isHostExcludedIn,
  isSecurePageUrl,
  sameRegistrableDomain
} from '../vault/access-gate'
import { DEFAULT_FIELD_KEY } from '../vault/fields'
import { formatDialogNote } from '../browser/dialogs'
import { promises as fsp } from 'fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'path'
import { ensureDebuggerAttached, keepDebuggerAttached } from '../browser/emulation'
import { createOcrTool, ocrDigitInRegion, resolveKeypadDigits, type DigitRead } from './tools-ocr'
import {
  createPayTool,
  createPhoneTools,
  hasConnectedPhone,
  PAY_TOOL_NAME,
  PHONE_TOOL_NAMES,
  type PayToolContext,
  type PhoneToolContext
} from './tools-phone'
import { handoffToolResult, type HandoffResult } from './handoff'
import { secretKeypadGate } from './secret-page'
import { enterWebPaymentPassword, type WebKeypadResult } from '../vault/web-keypad'
import { knownLoginUrl, isLikelyLoginUrl } from '../../shared/site-rules'
import { BLOCKED_URL_MESSAGE, isInternalUrl } from '../../shared/url'
import {
  agentTargetOf,
  allTargetsOf,
  closeTargetOf,
  focusTargetOf,
  popupNotice,
  popupTargetsOf
} from './target'
import type { AgentTarget } from '../browser/targets'
import { automationBlocked, runAsAutomation } from '../browser/human-activity'
import type { AgentToolCall, SiteActionTool } from '../../shared/site-memory'
import type { HandoffKind } from '../../shared/ipc'
import { PLAYBOOK_INSTRUCTIONS_MAX, type PlaybookDto } from '../../shared/playbook'

// 읽기 전용 모드에서 실행 자체를 거부할 때 돌려주는 문자열(AI 가 읽고 판단)
const READ_ONLY_REFUSAL = 'refused: read-only mode'
// preload 의 클릭 폴백이 전부 실패했을 때 결과에 들어가는 표식
// (page-core 의 CLICK_NO_CHANGE_NOTE 앞부분. preload 모듈은 메인에서 import 하지 않는다)
const CLICK_NO_CHANGE_MARK = 'clicked but nothing changed'
// finalConfirm 이 거부됐을 때 모델이 계속 작업하도록 돌려주는 문자열
const CONTINUE_INSTRUCTION = 'user asked to continue; do not finish yet'
// 금고가 잠겨 있을 때 돌려주는 문자열(모델이 사용자에게 해제를 요청하도록 유도)
const VAULT_LOCKED = 'locked: ask the user to unlock 키마스터'
// 금고를 아직 설정하지 않았을 때(state === 'uninitialized') 돌려주는 문자열
const VAULT_NOT_SET_UP = 'not set up: ask the user to set up 키마스터 first'
// 현재 탭의 호스트를 알 수 없을 때(정규화 실패·활성 탭 없음) 돌려주는 문자열.
// 전체 계정으로 폴백하지 않기 위해 명시적으로 거부한다
const HOST_UNKNOWN = 'host unknown: navigate to the site first'
// list_accounts 의 host 인자가 현재 탭 호스트와 다를 때 돌려주는 문자열
const HOST_MISMATCH = 'refused: host must match the current tab'
// 계정을 특정하지 못했을 때 돌려주는 문자열
const ACCOUNT_NOT_FOUND = 'account not found: use list_accounts'
// 네이버페이 결제창이 키마스터에서 고른 네이버 계정이 아닌 다른 계정으로 로그인돼 있다.
// 그 계정으로 결제하면 안 되므로 넣지 않는다 — 결제창에서 로그아웃하고 맞는 계정으로 다시 로그인해야 한다
export const NAVERPAY_ACCOUNT_MISMATCH = (shown: string, expected: string): string =>
  `refused: NAVERPAY_ACCOUNT_MISMATCH — the Naver Pay window is signed in as ${shown}, but the KeyMaster account to pay with is ${expected}. ` +
  'Sign out inside the Naver Pay window (top-right account menu) and sign in as that account with fill_secret, then continue'
export const NAVERPAY_ACCOUNT_UNKNOWN =
  'refused: NAVERPAY_ACCOUNT_UNKNOWN — could not read the signed-in account (top-right, masked like abcd******) on the Naver Pay window; ' +
  'make sure the payment page is fully shown, then call again'
// 계정에 결제 비밀번호가 둘 이상인데 provider 를 주지 않았을 때 돌려주는 문자열.
// 임의로 고르면 잘못 눌러 계정이 잠기므로 반드시 모델에게 되묻게 한다
const PAYMENT_PROVIDER_AMBIGUOUS =
  'ambiguous: this account has several payment passwords; pass provider ' +
  '(site for the site own pay such as 무신사머니, musinsapay, toss, kakao, naver, payco, other)'
// guard 모드에서 추가 확인을 받아야 하는 민감 항목
const CONFIRM_ITEM_TYPES: VaultItemType[] = ['password', 'card']
// PG 결제창(토스·ePAY 팝업)에서 채우는 항목 — 그 창의 호스트가 아니라 창을 연 사이트의 계정을 쓴다
const PAYMENT_POPUP_ITEM_TYPES: VaultItemType[] = ['identity', 'card', 'password']
// fill_secret 의 format 인자 — 저장된 값을 입력칸이 원하는 모양으로 바꾼다
export const FILL_FORMATS = [
  'yymmdd',
  'yyyymmdd',
  'digits',
  // 전화번호를 칸 셋(010 / 1234 / 5678)에 나눠 넣는 폼 — 앞·가운데·끝
  'phone-first',
  'phone-mid',
  'phone-last',
  // 앞자리는 고르는 칸(010 선택)이고 나머지 8자리를 한 칸에 넣는 폼(슈마커 ReceiveHP23) — 가운데+끝
  'phone-rest'
] as const
export type FillFormat = (typeof FILL_FORMATS)[number]

/**
 * 저장된 값을 입력칸 모양에 맞춘다(순수 함수). 못 맞추면 null.
 *  - yymmdd: 1991-01-01 / 19910101 / 910101 → 910101 (토스페이 생년월일 6자리)
 *  - yyyymmdd: 1991-01-01 → 19910101
 *  - digits: 010-1234-5678 → 01012345678
 */
export function formatFillValue(value: string, format?: FillFormat): string | null {
  if (!format) return value
  const digits = value.replace(/\D/g, '')
  if (format === 'digits') return digits === '' ? null : digits
  if (format.startsWith('phone-')) {
    // 010-1234-5678(11자리) / 02-123-4567 같은 번호를 앞·가운데·끝으로 나눈다. 끝은 항상 4자리
    if (digits.length < 9 || digits.length > 11) return null
    const last = digits.slice(-4)
    const first = digits.startsWith('02') ? '02' : digits.slice(0, 3)
    const mid = digits.slice(first.length, -4)
    if (mid.length < 3) return null
    if (format === 'phone-rest') return mid + last
    return format === 'phone-first' ? first : format === 'phone-mid' ? mid : last
  }
  if (digits.length === 8) return format === 'yymmdd' ? digits.slice(2) : digits
  if (digits.length === 6) return format === 'yymmdd' ? digits : null
  return null
}
// fill_secret 대상 요소가 실제로 비밀 입력칸(type=password)이어야 하는 항목 종류.
// 카드·신원정보는 번호칸이 평문 input 인 경우가 흔해 이 검사에서 제외한다
const SECRET_TARGET_ITEM_TYPES: VaultItemType[] = ['login', 'password']
// 대상 요소가 비밀 입력칸이 아닐 때 돌려주는 문자열
const NOT_A_SECRET_FIELD = 'refused: target is not a secret input'
// run_js safety:no_pay 에서 누르지 않는 결제 확정·주문 취소/반품/교환 버튼 글자(요소 자신 + 감싸는 버튼·링크 글자로 판정)
export const PAY_CLICK_RE =
  /결제\s*하기|입력\s*완료|구매\s*확정|결제\s*승인|주문\s*확정|취소\s*요청|주문\s*취소|반품\s*요청|교환\s*요청|place\s*order|pay\s*now/i
export const RUN_JS_SAFETY_PROBE = 'safety: no_pay supported'
const PAY_CLICK_REFUSAL = 'refused: safety no_pay — payment confirm buttons cannot be clicked here'
// 접근 정책이 never 일 때 돌려주는 문자열
const VAULT_ACCESS_NEVER = 'refused: KeyMaster access policy is Never'
// 현재 호스트가 제외 도메인 목록에 있을 때 돌려주는 문자열
const VAULT_HOST_EXCLUDED = 'refused: host is excluded from KeyMaster'
// list_accounts 에서 제외 도메인일 때 돌려주는 문자열(계정 목록 자체를 노출하지 않는다)
const LIST_ACCOUNTS_HOST_EXCLUDED = 'refused: host excluded'
// 평문(http)으로 열린 페이지에 비밀값을 채우려 할 때 돌려주는 문자열
const INSECURE_PAGE = 'refused: insecure page (https required)'
// 값을 채우기 직전, 페이지가 계정과 다른 등록 도메인으로 옮겨 갔을 때 돌려주는 문자열
const FILL_HOST_MISMATCH = 'refused: HOST_MISMATCH — page moved to another domain'
// 이미 로그인돼 있을 때 돌려주는 문자열(다시 로그인하면 세션이 끊겨 캡차가 늘어난다)
const ALREADY_SIGNED_IN = 'already signed in'
// 사이트가 "아이디 또는 비밀번호가 일치하지 않습니다" 같은 대화상자로 로그인 실패를 알린 경우.
// 같은 실행에서 다시 시도하면 실패가 쌓여 계정이 잠긴다(실기: SSG 에서 모델이 3회 재시도) — 앱이 막고 사람에게 넘긴다
const WRONG_PASSWORD_RE =
  /일치하지\s*않|비밀번호가\s*(틀|올바르지|잘못)|아이디\s*또는\s*비밀번호|비밀번호를?\s*(다시|확인)|incorrect\s*(password|login)|invalid\s*(password|credentials)|wrong\s*password/i
export const LOGIN_WRONG_PASSWORD = (host: string): string =>
  `failed: WRONG_PASSWORD — ${host} says the id or password does not match. Do NOT retry (repeated failures lock the account); ` +
  "tell the user to update this account's password in KeyMaster and stop"
// 캡차·2FA 를 사용자에게 넘길 수 없을 때(넘김 콜백 미주입) 돌려주는 문자열
const NEEDS_USER_CAPTCHA = 'needs_user: captcha'
// 웹 결제 비밀번호 키패드에서 조작 도구(click/type/select/scroll)를 거부할 때 돌려주는 문자열.
// 모델은 비밀번호를 모르므로 숫자를 맞출 수 없고, 잘못 누르면 계정이 잠긴다
export const PAYMENT_KEYPAD_REFUSAL =
  'refused: payment keypad — the app enters the payment password itself; ' +
  'call fill_secret with itemType "password" and provider, or stop and tell the user'
// 비밀 키패드 화면에서 화면 읽기(screenshot·ocr)를 거부할 때 돌려주는 문자열(폰 도구와 같은 톤).
// 숫자 배치를 모델에게 보여 주지 않는다
export const SECRET_SCREEN_REFUSAL = 'refused: secret screen'
// 비밀 키패드 화면에서 fill_secret 이 사람에게 넘길 때의 안내
// 글자 없는 키패드 버튼이 늦게 뜰 때 다시 찾는 횟수·간격(합쳐 약 6초)
const KEYPAD_CELLS_RETRIES = 8
// 시험에서는 기다리지 않는다(VITEST)
const KEYPAD_CELLS_WAIT_MS = process.env['VITEST'] ? 0 : 750
export const KEYPAD_HANDOFF_MESSAGE ='결제 비밀번호는 직접 눌러 주세요'
// 사용자가 키패드 넘김을 건너뛴 뒤 모델이 할 일(같은 키패드에 다시 시도하지 않게)
export const KEYPAD_SKIPPED_NEXT =
  'user skipped: they will enter the payment password themselves later. Do NOT call fill_secret, ' +
  'click or type on this keypad again. Call get_page once; if the payment finished, verify the order, ' +
  'otherwise finish with done and tell the user the payment is waiting for their password.'
// 넘김 카드에 표시할 근거 문구(값이 아니라 화면 종류만 담는다)
const KEYPAD_HANDOFF_MATCHED = '결제 비밀번호 키패드'
// 앱이 키패드에 결제 비밀번호를 다 넣었을 때. 확인·입력완료 버튼은 모델이 누른다
export const KEYPAD_ENTERED_NEXT =
  'ok: the app entered the payment password on the keypad. ' +
  'Now call get_page and press the confirm/입력완료 button if the keypad has one; never press the digits yourself.'
// 같은 결제창에 자동 입력을 이미 한 번 했을 때(연속 오답 → 결제 수단 잠금 방지)
export const KEYPAD_ALREADY_TRIED =
  'refused: the app already entered the payment password once in this window during this task. ' +
  'Do NOT retry - a wrong password locks the pay method after 5 tries. Read the page: if it says the password ' +
  'is wrong, stop and tell the user which pay method and provider you used; otherwise continue.'
// 시험 입력(dry-run)으로 키패드를 절반만 누르고 결제창을 닫았을 때. 결제는 하지 않았다
export const KEYPAD_DRY_RUN = (digits: number, closed: string): string =>
  `refused: DRY_RUN — typed ${digits} digits then closed (${closed}). ` +
  'Nothing was paid. Report to the user that the keypad auto-fill works and stop here.'
// 시험 입력 뒤 누를 취소·닫기 버튼 문구
const KEYPAD_CANCEL_RE = /^(취소|닫기|뒤로|cancel|close)$/i
// 결제창(PG 팝업)의 계정을 여는 탭에서 찾을 수 없을 때
const KEYPAD_ACCOUNT_UNKNOWN =
  'account not found: the payment window is not linked to a saved account; ' +
  'call list_accounts on the shop tab or pass accountLabel'
// progress 도구가 말이 안 되는 숫자를 받았을 때 돌려주는 문자열
export const PROGRESS_INVALID = 'refused: progress needs 0 <= done <= total and total >= 1'
// 진행 라벨 표시 상한(상품명이 길어도 진행 배지가 무너지지 않게)
const PROGRESS_LABEL_MAX = 80
// 플레이북 수정 확인 카드에 보여 줄 덧붙일 글의 상한(카드가 무너지지 않게)
const PLAYBOOK_PREVIEW_MAX = 400
// diff 를 부탁했는데 직전 읽기와 똑같을 때 돌려주는 문자열
const NO_CHANGE = 'no change since the last get_page'
// 직전 스냅샷 문자열을 기억해 둘 탭 개수(diff 용)
const SNAPSHOT_CACHE_TABS = 5
// run_js 안에서 비밀 입력칸에 쓰려 할 때 돌려주는 문자열. 비밀 경로는 fill_secret 뿐이다
const RUN_JS_SECRET_REFUSAL =
  'refused: that input is a secret field - use the fill_secret tool, not run_js'
// run_js 가 노출하지 않는 것을 모델에게 알리는 문자열
export const RUN_JS_NO_SECRET_TOOLS =
  'refused: fill_secret, login and the phone tools are not available inside run_js'

/**
 * 탭별 직전 스냅샷 문자열 보관소(diff 용). 오래된 탭부터 버린다 —
 * 탭을 많이 열어 둔 사용자에게서 메모리가 계속 늘면 안 된다
 */
export function rememberSnapshot(
  cache: Map<string, string>,
  tabId: string,
  tree: string
): string | undefined {
  const prev = cache.get(tabId)
  cache.delete(tabId)
  cache.set(tabId, tree)
  while (cache.size > SNAPSHOT_CACHE_TABS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return prev
}

// 세션을 넘는 키패드 입력 기록의 상한 — 오래된 것부터 버린다(창 id 는 매번 새로 생긴다)
const KEYPAD_ENTERED_MAX = 200

/** 키패드 입력을 한 결제창을 기록한다. 상한을 넘으면 가장 오래된 기록부터 지운다 */
export function rememberKeypadEntered(set: Set<string> | undefined, key: string): void {
  if (!set) return
  set.delete(key)
  set.add(key)
  while (set.size > KEYPAD_ENTERED_MAX) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

/** progress 도구 입력 검증. 문제가 없으면 null, 있으면 모델이 읽을 거부 문구 */
export function validateProgress(done: number, total: number): string | null {
  if (!Number.isInteger(done) || !Number.isInteger(total)) return PROGRESS_INVALID
  if (total < 1 || done < 0 || done > total) return PROGRESS_INVALID
  return null
}

// https·제외 도메인·접근 정책 판정은 하네스·자동 채움과 공유한다(vault/access-gate.ts)
export { isSecurePageUrl, effectiveAccess }

// 금고에 저장된 항목 종류(도구 스키마용). shared/vault 의 VaultItemType 과 단일 소스로 유지한다.
// `satisfies` 는 초과/오타 항목을 잡고, 아래 완전성 체크는 누락 항목을 컴파일 타임에 잡는다
const ITEM_TYPES = [
  'login',
  'password',
  'card',
  'note',
  'identity',
  'document'
] as const satisfies readonly VaultItemType[]

// 결제 수단(도구 스키마용). shared/vault 의 PaymentProvider 와 단일 소스로 유지한다
const PAYMENT_PROVIDER_NAMES = [
  'site',
  'musinsapay',
  'toss',
  'kakao',
  'naver',
  'payco',
  'alipay',
  'lottecard',
  'samsung',
  'apple',
  'other'
] as const satisfies readonly PaymentProvider[]

type PaymentProvidersComplete = [PaymentProvider] extends [(typeof PAYMENT_PROVIDER_NAMES)[number]]
  ? true
  : never
const _paymentProvidersComplete: PaymentProvidersComplete = true
void _paymentProvidersComplete

// 타입 레벨 완전성 체크 — VaultItemType 에 값이 추가되고 ITEM_TYPES 갱신을 잊으면 컴파일 에러가 난다
type ItemTypesComplete = [VaultItemType] extends [(typeof ITEM_TYPES)[number]] ? true : never
const _itemTypesComplete: ItemTypesComplete = true
void _itemTypesComplete

/** 사용자명 마스킹 — 앞 2글자만 남기고 `***` 를 붙인다 */
export function maskUsername(username: string): string {
  return `${username.slice(0, 2)}***`
}

/**
 * 계정 선택 규칙 — 라벨 지정 > 탭 프로필과 같은 라벨 > 기본 계정 > 유일한 계정.
 * 탭 프로필을 같이 넘기면 계정 순회(계정별 새 탭)에서 라벨 없이도 그 탭의 계정을 고른다.
 * 특정하지 못하면 null 을 돌려준다(도구는 ACCOUNT_NOT_FOUND 를 반환).
 */
/** 주소에서 호스트·경로만(쿼리·해시 제외) — 진행 라벨용. 파싱 실패면 원문 앞 80자 */
export function pathOnly(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return url.slice(0, 80)
  }
}

export function resolveAccount(
  accounts: AccountDto[],
  label?: string,
  tabProfile?: string
): AccountDto | null {
  if (label) return accounts.find((a) => a.label === label) ?? null
  if (tabProfile) {
    const byProfile = accounts.find((a) => a.label === tabProfile)
    if (byProfile) return byProfile
  }
  const preferred = accounts.find((a) => a.isDefault)
  if (preferred) return preferred
  return accounts.length === 1 ? accounts[0] : null
}

/**
 * 통합 로그인으로 다른 도메인에 넘어갔을 때 원래 사이트 계정과 짝인 계정을 고른다.
 * 실기: 29CM 계정 라벨 "buyer02@naver.com" 은 무신사 통합 로그인 화면에서 무신사 계정 "buyer02" 다.
 * 아이디가 같거나, 넘어간 쪽 라벨이 원래 계정의 아이디·라벨 @ 앞부분과 같으면 짝으로 본다
 */
export function movedHostAccount(
  origin: AccountDto[],
  moved: AccountDto[],
  label?: string
): AccountDto | null {
  if (!label) return null
  const src = origin.find((a) => a.label === label)
  const keys = new Set(
    [label, label.split('@')[0], src?.username, src?.username.split('@')[0]]
      .filter((k): k is string => typeof k === 'string' && k.length > 0)
      .map((k) => k.toLowerCase())
  )
  return (
    moved.find((a) => keys.has(a.username.toLowerCase())) ??
    moved.find((a) => keys.has(a.label.toLowerCase())) ??
    null
  )
}

// 도구 하나의 상한 시간. run_js 는 자체 30초 상한이 있으므로 그보다 넉넉히 둔다
const TOOL_TIMEOUT_MS = 90_000
// 로그인 제출 뒤 사이트의 실패 대화상자(비밀번호 불일치)가 뜰 때까지 기다리는 시간
const LOGIN_DIALOG_WAIT_MS = 800

// 도구가 실패를 알릴 때 쓰는 말. 결과 어디에 있든 실패로 보던 예전 판정은, 페이지 본문·플레이북 절차처럼
// 남의 글을 그대로 돌려주는 도구에서 오탐을 냈다(실기: 플레이북 본문의 "error"·"locked" 때문에 읽기 성공이 ✗)
const FAILURE_WORDS_RE = /not found|not set up|host unknown|refused|denied|error|locked|fail/i
/** 본문을 돌려주는 도구의 실패 표식 — 우리 도구는 실패를 결과 맨 앞에 적는다 */
const FAILURE_HEAD_RE =
  /^\s*(refused|error|denied|locked|handoff|needs_user|no active tab|no element matches)\b|^\s*Error:/i

/**
 * 도구 결과가 성공인가(진행 로그의 ✓/✗ 와 사이트 기억의 성공 경로 판정에 쓴다).
 * content 도구(페이지 읽기·요소 찾기·탭 목록·플레이북 읽기·run_js)는 결과에 남의 글이 섞이므로 앞머리만 본다.
 * run_js 는 log() 출력 뒤에 `Error:` 줄이 올 수 있어 줄 머리도 본다
 */
export function isToolResultOk(raw: string, content = false): boolean {
  if (!content) return !FAILURE_WORDS_RE.test(raw)
  return !FAILURE_HEAD_RE.test(raw) && !/^(Error:|refused:)/m.test(raw)
}

/** 결제창 호스트 → 결제 수단. 결제창이 묻는 휴대폰·생년월일을 어느 결제 항목에서 찾을지 정한다 */
const PAY_HOST_PROVIDERS: ReadonlyArray<[RegExp, PaymentProvider]> = [
  [/(^|\.)toss\.im$|(^|\.)tosspayments\.com$/, 'toss'],
  [/(^|\.)payco\.com$/, 'payco'],
  [/(^|\.)kakaopay\.com$|(^|\.)kakao\.com$/, 'kakao'],
  [/(^|\.)pay\.naver\.com$/, 'naver']
]

export function payProviderOfUrl(url: string): PaymentProvider | null {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  return PAY_HOST_PROVIDERS.find(([re]) => re.test(host))?.[1] ?? null
}

/**
 * 신원정보에서 못 찾은 휴대폰·생년월일을, 지금 결제창의 결제 수단 항목(payment.phone·payment.birth)에서 찾는다.
 * 결제창이 아니거나 다른 필드면 null
 */
function paymentIdentityFallback(
  vault: VaultService,
  accountId: number,
  itemType: VaultItemType,
  fieldKey: string,
  url: string,
  jobId: string | undefined
): string | null {
  if (itemType !== 'identity') return null
  const short = fieldKey.split('.').pop() ?? ''
  if (short !== 'phone' && short !== 'birth') return null
  const provider = payProviderOfUrl(url)
  if (!provider) return null
  return vault.getPaymentSecretForFill({
    accountId,
    provider,
    fieldKey: `payment.${short}`,
    ...(jobId === undefined ? {} : { jobId })
  }).value
}

/** run_script 의 args(JSON 문자열)를 객체로 바꾼다. 비어 있으면 빈 객체, 객체가 아니면 null */
export function parseScriptArgs(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined || raw.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

/** 제한 시간을 잴 때 시계를 확인하는 간격 */
const TOOL_TIMEOUT_POLL_MS = 1_000

/**
 * 도구 하나의 제한 시간. 사람을 기다리는 동안(확인 카드·키패드 넘김)은 시간을 세지 않는다 —
 * 사용자가 결제 비밀번호를 90초 넘게 누르고 있으면 도구가 "페이지 무응답"으로 끝나 버리고,
 * 카드는 화면에 남은 채 모델이 다른 길로 새던 문제를 막는다
 */
export async function withToolTimeout<T>(
  p: Promise<T>,
  ms: number,
  isWaitingForHuman: () => boolean = () => false,
  pollMs: number = TOOL_TIMEOUT_POLL_MS
): Promise<T | string> {
  let timer: ReturnType<typeof setInterval> | undefined
  const timeout = new Promise<string>((resolve) => {
    let spent = 0
    timer = setInterval(() => {
      if (isWaitingForHuman()) return
      spent += pollMs
      if (spent < ms) return
      resolve(
        `error: the page did not respond within ${Math.round(ms / 1000)}s (a dialog, a stuck popup or heavy loading). ` +
          'Call list_tabs/get_page again, or switch to another tab.'
      )
    }, pollMs)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearInterval(timer)
  }
}

export interface ToolContext {
  tabs: TabManager
  /** 브릿지(하네스) 호출이면 true — 보이는 탭·창 포커스를 가져가지 않는다 */
  background?: boolean
  dangerWords: string[]
  // 사용 권한 모드. read_only 는 조작 도구를 실행하지 않고, full 은 위험 단어 확인을 생략한다
  mode: PermissionMode
  // 켜져 있으면 done 호출 전에 확인 카드를 띄운다
  finalConfirm: boolean
  // 위험 행동 확인. 승인이면 true. kind 로 위험/완료 확인 카드를 구분한다
  confirm: (action: string, kind?: 'danger' | 'finish') => Promise<boolean>
  // 호출 카운터. 상한 넘으면 문자열 반환
  tick: () => string | null
  onStep: (label: string, ok: boolean) => void
  // 진행 상황 보고(progress 도구). 주입되지 않으면 도구는 받기만 하고 아무 데도 알리지 않는다
  onProgress?: (p: { done: number; total: number; label?: string }) => void
  // 행동 도구(click·type·select·scroll·switch_tab·dismiss_overlay·run_js) 호출 1건을 그대로 넘긴다.
  // 사이트 기억이 성공 경로를 뽑는 유일한 입구다 — 관찰 도구는 여기로 오지 않는다
  onCall?: (call: AgentToolCall) => void
  // 통한(또는 실패한) run_js 코드 전문. 실행이 끝난 뒤 학습 단계가 이것으로 재생용 스크립트를 만든다.
  // clicked 는 코드 안에서 번호로 누른 요소의 글자다(번호는 페이지마다 바뀌므로 글자로 바꿔 쓰게 한다)
  onRunJs?: (run: { code: string; ok: boolean; url: string; clicked: string[] }) => void
  // 사이트 기억. 주입되지 않으면 remember_site 도구를 등록하지 않는다
  siteMemory?: { remember: (host: string, note: string) => string }
  // 저장된 사이트 스크립트. 주입되지 않으면 save_script·run_script 도구를 등록하지 않는다
  scripts?: {
    find: (name: string) => SiteScript | undefined
    save: (input: SiteScriptInput) => string
    ran: (name: string, ok: boolean) => void
  }
  // 플레이북 읽기·절차 수정. 주입되지 않으면 list_playbooks·update_playbook 도구를 등록하지 않는다
  playbooks?: {
    list: () => PlaybookDto[]
    update: (id: string, instructions: string) => PlaybookDto | null
  }
  // 키마스터. 주입되지 않은 실행(구버전 호출부·테스트)에서는 금고 도구가 잠금으로 동작한다
  vault?: VaultService
  // 감사 로그에 남길 작업 식별자(실행 1건 = jobId 1개)
  jobId?: string
  // 키마스터 AI 접근 정책. 미지정 시 while_unlocked 로 동작한다(구버전 호출부·테스트 호환)
  vaultAccessPolicy?: VaultAccessPolicy
  // 자동 채움 후 자동 제출 여부. 미지정 시 true(기존 동작)로 동작한다
  vaultAutoSubmit?: boolean
  // 로그인 폼의 "로그인 상태 유지" 체크박스를 자동으로 켤지. 미지정 시 켠다.
  // 세션을 오래 유지하면 재로그인이 줄어 캡차도 덜 뜬다
  vaultKeepSignedIn?: boolean
  // 캡차·2FA 를 사용자에게 넘기고 처리될 때까지 작업을 일시정지한다.
  // 주입되지 않은 실행(구버전 호출부·테스트)에서는 도구가 needs_user 문자열만 돌려준다
  handoff?: (req: {
    matched: string
    currentUrl: () => string
    stillBlocked: () => Promise<boolean>
    kind?: HandoffKind
  }) => Promise<HandoffResult>
  // 제외 도메인(정규화된 host 문자열). 미지정 시 빈 목록으로 동작한다
  vaultExcludedHosts?: string[]
  // 폰 도구 문맥. 주입되지 않은 실행에서는 폰 도구가 아예 등록되지 않는다.
  // 금고(vault)는 여기에 들어가지 않는다 — 폰 도구는 비밀값을 볼 수 없다
  phone?: PhoneToolContext
  // 결제 승인 문맥. 폰 도구와 따로 주입한다 — 결제만 금고를 보는 실행기를 갖는다
  pay?: PayToolContext
  // 키패드 자동 입력을 이미 한 결제창(창 id|호스트) — 도구 세션을 넘어 공유한다. 브릿지는 요청마다 새
  // 세션을 열어 세션 안의 1회 제한이 하네스의 반복 호출을 막지 못했다(실기 2026-09-27). 주입되지 않으면 세션 안만 본다
  keypadEntered?: Set<string>
}

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text' as const, text: t }]
})

// 지금 조작할 창. 팝업(결제창·주소 검색창)을 골라 둔 상태면 그 팝업, 아니면 활성 탭.
// 대상이 없으면 null
// 행동 도구(action)가 아니어도 탭에 입력하는 도구의 라벨 머리 — fill_secret('입력: …')·login('로그인…')·run_script
// 슬래시·역슬래시 두 개로 시작하면 윈도우에서 UNC 경로다
const UNC = /^[\\/]{2}/
// fetch_url 한도
const FETCH_MAX_BYTES = 25 * 1024 * 1024
const FETCH_INLINE_B64_MAX = 1024 * 1024

const HUMAN_GATED_LABEL_RE = /^(입력|로그인|스크립트 실행|파일 업로드|파일 저장)/

function activeOr(ctx: ToolContext): Tab | null {
  return agentTargetOf(ctx.tabs)
}

// 로그인 진입점으로 보이는 요소의 텍스트·링크 주소 패턴(E2E 하네스의 clickLoginLink 와 같은 규칙).
// 크림처럼 소셜 로그인 버튼만 보이고 이메일 로그인은 한 번 더 눌러야 나오는 사이트가 있어
// "이메일로 로그인" 류를 가장 먼저 찾는다
const EMAIL_LOGIN_TEXT_RE = /이메일(로| )?\s?로그인|email.*(login|sign in)|아이디로 로그인/i
// 통합계정 로그인 — 29CM 는 무신사 통합계정으로 전환된 계정이라 "이메일 로그인"으로 들어가면
// "무신사 통합계정으로 다시 로그인해주세요"로 막힌다(실기 2026-09-25). 이메일 로그인보다 먼저 찾는다
const UNIFIED_LOGIN_TEXT_RE = /통합\s?계정.{0,12}로그인|통합\s?로그인/
const LOGIN_TEXT_RE = /^(로그인|로그인하기|login|log in|sign\s?in|signin)$/i
const LOGIN_HREF_RE = /login|signin|sign-in|logon/i

/** 페이지 안에서 로그인 링크·버튼을 텍스트 또는 링크 주소로 찾아 한 번 눌러 본다. 눌렀으면 true */
async function clickLoginLink(tab: Tab): Promise<boolean> {
  const snapshot = await pageBridge.snapshot(tab)
  const target =
    snapshot.elements.find((el) => UNIFIED_LOGIN_TEXT_RE.test(el.text)) ??
    snapshot.elements.find((el) => EMAIL_LOGIN_TEXT_RE.test(el.text)) ??
    snapshot.elements.find((el) => LOGIN_TEXT_RE.test(el.text.trim())) ??
    snapshot.elements.find((el) => el.href !== undefined && LOGIN_HREF_RE.test(el.href)) ??
    snapshot.elements.find((el) => /로그인|login|sign in/i.test(el.text))
  if (!target) return false
  await pageBridge.click(tab, target.id)
  await pageBridge.waitForLoad(tab)
  return true
}

/**
 * 로그인 폼을 찾는다. 못 찾으면 도구 호출 1회 안에서 아래 순서로 되짚는다(모델 왕복 감소).
 *   1) 알려진 로그인 URL(knownLoginUrl)로 이동 → 재탐지
 *   2) 현재 페이지의 로그인 링크를 눌러 이동 → 재탐지
 * 끝내 못 찾으면 마지막 탐지 결과(stage: 'none')를 그대로 돌려준다.
 */
// 알려진 로그인 URL 로 옮긴 뒤 폼이 나타날 때까지 다시 보는 횟수·간격
const LOGIN_FIELDS_POLL_MAX = 6
const LOGIN_FIELDS_POLL_MS = 700
// 로그인 링크를 따라가는 최대 횟수(29CM: LOGIN → 로그인 방법 선택 → 무신사 통합 로그인 "로그인" → 입력칸)
const LOGIN_LINK_HOPS = 3

export async function findLoginFieldsWithFallback(
  tabs: TabManager,
  tab: Tab,
  host: string,
  // 이미 한 번 탐지해 봤으면 그 결과를 넘겨 중복 호출을 줄인다
  initial?: LoginFieldsResult
): Promise<LoginFieldsResult> {
  let fields = initial ?? (await pageBridge.findLoginFields(tab))
  if (fields.stage !== 'none') return fields

  // 1) 지금 페이지가 로그인 페이지로 보이지 않을 때만 알려진 로그인 URL 로 옮겨 간다
  const known = knownLoginUrl(host)
  if (known !== undefined && !isLikelyLoginUrl(tab.view.webContents.getURL())) {
    try {
      await tabs.navigate(tab.id, known)
      await pageBridge.waitForLoad(tab)
      // 로그인 폼을 스크립트로 늦게 그리는 사이트(실기: SSG member.ssg.com)는 적재 직후엔 칸이 없다 — 잠깐씩 다시 본다
      for (let attempt = 0; attempt < LOGIN_FIELDS_POLL_MAX; attempt += 1) {
        fields = await pageBridge.findLoginFields(tab)
        if (fields.stage !== 'none') return fields
        await new Promise((resolve) => setTimeout(resolve, LOGIN_FIELDS_POLL_MS))
      }
    } catch {
      // 이동 실패는 다음 단계(로그인 링크 클릭)로 넘어간다
    }
  }

  // 2) 페이지 안의 로그인 링크를 눌러 본다. 눌러 간 곳이 입력칸 없는 로그인 방법 선택 화면이면
  //    (실기: 29CM LOGIN → 카카오·Apple·무신사 통합계정·이메일 버튼만 있는 화면) 한 번 더 누른다
  // 페이지가 넘어가는 중에는 조회가 "응답 없음"으로 던진다 — 그 한 번은 못 찾은 것으로 보고 계속 기다린다
  // (실기: 29CM 통합계정 버튼 → member.one.musinsa.com 이동 중 오류가 반복 전체를 끝내 "칸 없음"으로 답함)
  const detect = async (): Promise<LoginFieldsResult> => {
    try {
      return await pageBridge.findLoginFields(tab)
    } catch {
      return fields
    }
  }
  for (let hop = 0; hop < LOGIN_LINK_HOPS; hop += 1) {
    try {
      if (!(await clickLoginLink(tab))) break
    } catch {
      // 누르다 페이지가 넘어가면 던질 수 있다 — 넘어간 화면을 아래에서 본다
    }
    fields = await detect()
    // 통합 로그인은 다른 도메인을 거쳐 오느라 늦게 뜬다(실기: 29CM → member.one.musinsa.com) — 두 배로 기다린다
    for (let attempt = 0; fields.stage === 'none' && attempt < LOGIN_FIELDS_POLL_MAX * 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, LOGIN_FIELDS_POLL_MS))
      fields = await detect()
    }
    if (fields.stage !== 'none') break
  }
  return fields
}

// 브릿지 도구 세션(runner.ts 의 createToolSession)이 서버 객체에서 실제로 쓰는 부분만(이름·핸들러).
// 도구마다 zod 스키마 타입이 달라 SdkMcpToolDefinition<Schema> 그대로는 배열 하나로 묶이지 않는다
export interface SambaMcpTool {
  name: string
  handler: (
    args: Record<string, unknown>,
    extra: unknown
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>
}

export function createSambaTools(
  baseCtx: ToolContext
): ReturnType<typeof createSdkMcpServer> & { tools: SambaMcpTool[] } {
  // 사람을 기다리는 중인 호출 수 — 이 동안은 도구 제한 시간을 세지 않는다
  let humanWaits = 0
  const waitingForHuman = async <T>(fn: () => Promise<T>): Promise<T> => {
    humanWaits += 1
    try {
      return await fn()
    } finally {
      humanWaits -= 1
    }
  }
  const baseHandoff = baseCtx.handoff
  const ctx: ToolContext = {
    ...baseCtx,
    confirm: (action, kind) => waitingForHuman(() => baseCtx.confirm(action, kind)),
    ...(baseHandoff ? { handoff: (o) => waitingForHuman(() => baseHandoff(o)) } : {})
  }
  // 상한 도달 알림은 1회만 보낸다
  let limitNotified = false

  // label 은 실행 뒤에야 알 수 있는 경우(예: login 의 호스트·계정)를 위해 함수도 받는다.
  // action 을 주면 그 호출을 사이트 기억(onCall)으로도 흘려 보낸다 — 행동 도구만 준다
  const guard = async <T>(
    label: string | (() => string),
    fn: () => Promise<T>,
    action?: SiteActionTool,
    // 결과에 페이지·문서 본문이 실리는 도구(앞머리만 보고 성공/실패를 가린다)
    content = false
  ): Promise<ReturnType<typeof text>> => {
    const resolveLabel = (): string => (typeof label === 'string' ? label : label())
    // 호출 1건을 사이트 기억으로 넘긴다. 기억이 붙어 있지 않으면 아무 일도 하지 않는다
    const note = (ok: boolean, result: string): void => {
      if (!action || !ctx.onCall) return
      ctx.onCall({ tool: action, label: resolveLabel(), ok, result, url: currentUrl() })
    }
    const over = ctx.tick()
    if (over) {
      if (!limitNotified) {
        limitNotified = true
        ctx.onStep('도구 호출 상한 도달', false)
      }
      return text(over)
    }
    // 사람이 지금 쓰고 있는 탭에는 입력·클릭·로그인·비밀값 채우기·페이지 스크립트를 하지 않는다
    // (실기 2026-09-25: 사용자 자동로그인과 login 도구 입력이 섞여 네이버 계정이 잠겼다)
    if (action || HUMAN_GATED_LABEL_RE.test(resolveLabel())) {
      const busy = automationBlocked(activeOr(ctx)?.view.webContents)
      if (busy) {
        ctx.onStep(resolveLabel(), false)
        return text(busy)
      }
    }
    try {
      // 페이지가 대화상자·무한 로딩으로 응답하지 않으면 실행 전체가 멈춘다(실기에서 14분 대기).
      // 도구 하나는 이 시간 안에 끝나야 하고, 넘기면 문구로 돌려줘 모델이 다른 길을 찾게 한다
      // 자동화 흐름으로 표시해 아래 입력 함수들이 '사람이 쓰는 탭' 검사를 하게 한다
      const r = await withToolTimeout(
        runAsAutomation(fn, ctx.background === true),
        TOOL_TIMEOUT_MS,
        () => humanWaits > 0
      )
      const raw = typeof r === 'string' ? r : JSON.stringify(r)
      const ok = isToolResultOk(raw, content)
      ctx.onStep(resolveLabel(), ok)
      note(ok, raw)
      // 실행 중 자동으로 닫은 페이지 대화상자가 있으면 그 문구를 결과 앞에 알려 준다
      const dialog = ctx.tabs.takeDialogMessage?.()
      return text(
        dialog
          ? `${formatDialogNote(dialog)}
${raw}`
          : raw
      )
    } catch (e) {
      const message = `error: ${e instanceof Error ? e.message : String(e)}`
      ctx.onStep(resolveLabel(), false)
      note(false, message)
      return text(message)
    }
  }

  // 탭 + 살아 있는 팝업 목록(팝업은 kind 'popup').
  // navigate·list_tabs·switch_tab·close_tab 이 함께 쓴다
  const targetList = (): AgentTarget[] => allTargetsOf(ctx.tabs)

  // 도구 실행 전후로 살아 있는 팝업을 비교해, 새로 열린 창이 있으면 결과에 안내를 붙인다.
  // 무신사 '배송지 변경'·29CM '주소 검색'처럼 버튼 하나가 새 창을 여는 흐름에서
  // 모델이 창이 열린 줄 모르고 다시 누르는 것을 막는다
  const withPopupNotice = async (fn: () => Promise<string>): Promise<string> => {
    const before = new Set(popupTargetsOf(ctx.tabs).map((t) => t.id))
    const result = await fn()
    const opened = popupTargetsOf(ctx.tabs).filter((t) => !before.has(t.id))
    if (opened.length === 0) return result
    return [result, ...opened.map((t) => popupNotice(t, normalizeHost(t.url) || '?'))].join('\n')
  }

  // 대상 탭의 URL. 탭을 넘기면 그 탭(도구 진입 시 잡은 탭)을, 아니면 활성 탭을 본다.
  // 비밀 채움 경로는 반드시 진입 시 탭을 넘겨서 "검사한 탭 ≠ 채우는 탭" 이 되지 않게 한다
  const currentUrl = (target?: Tab): string => {
    const tab = target ?? activeOr(ctx)
    return tab ? tab.view.webContents.getURL() : ''
  }

  // 대상 탭의 호스트(정규화). 탭이 없거나 정규화에 실패하면 빈 문자열
  const currentHost = (target?: Tab): string => normalizeHost(currentUrl(target))

  // 현재 호스트가 제외 도메인 목록에 있는지(같은 등록 도메인이면 제외로 본다)
  const isHostExcluded = (host: string): boolean =>
    isHostExcludedIn(host, ctx.vaultExcludedHosts ?? [])

  // 전역 접근 정책(계정이 'inherit' 일 때 적용된다)
  const globalPolicy = (): VaultAccessPolicy => ctx.vaultAccessPolicy ?? 'while_unlocked'

  // 금고 인스턴스가 있고 설정도 끝났는지만 본다(정책 판정 전 단계).
  // 미주입은 기존 호출부·테스트 호환을 위해 "잠금"으로 취급한다
  const vaultAvailable = (): VaultService | string => {
    const v = ctx.vault
    if (!v) return VAULT_LOCKED
    if (v.state() === 'uninitialized') return VAULT_NOT_SET_UP
    return v
  }

  // 정해진 정책으로 실제 사용 가능 여부를 판정한다.
  // never 는 즉시 거부하고, always 는 잠겨 있을 때 기기 키로 자동 해제를 시도한다
  const applyPolicy = async (
    v: VaultService,
    policy: VaultAccessPolicy
  ): Promise<VaultService | string> => {
    if (policy === 'never') return VAULT_ACCESS_NEVER
    if (policy === 'always' && v.state() !== 'unlocked') {
      await v.ensureUnlockedByDevice()
    }
    const state = v.state()
    if (state === 'uninitialized') return VAULT_NOT_SET_UP
    if (state !== 'unlocked') return VAULT_LOCKED
    return v
  }

  // checkVaultGate 결과를 모델이 읽는 안내 문자열로 바꾼다(https·호스트·제외 도메인)
  const gateRefusal = (url: string): string | null => {
    const reason = checkVaultGate({ url, excludedHosts: ctx.vaultExcludedHosts ?? [] })
    if (reason === 'host-unknown') return HOST_UNKNOWN
    if (reason === 'insecure-page') return INSECURE_PAGE
    if (reason === 'excluded') return VAULT_HOST_EXCLUDED
    return null
  }

  /**
   * 값을 채우기 직전 재검증 — 이동·리다이렉트로 조건이 바뀌었을 수 있다.
   * https 여야 하고, 제외 도메인이 아니어야 하며, 현재 호스트가 계정 호스트와 같은
   * 등록 도메인(eTLD+1)이어야 한다. 통과하면 null, 막히면 안내 문자열을 돌려준다
   */
  const verifyFillTarget = (account: AccountDto, target?: Tab): string | null => {
    const reason = checkFillGate({
      url: currentUrl(target),
      excludedHosts: ctx.vaultExcludedHosts ?? [],
      accountHost: account.host
    })
    if (reason === 'host-unknown') return HOST_UNKNOWN
    if (reason === 'insecure-page') return INSECURE_PAGE
    if (reason === 'excluded') return VAULT_HOST_EXCLUDED
    if (reason !== null) return FILL_HOST_MISMATCH
    return null
  }

  // 계정을 특정하지 않는 경로(현재는 없음)를 위한 전역 정책 게이트

  /**
   * 캡차·2FA 징후만 살펴 안내 문자열을 만든다(기다리지 않는다).
   * 징후가 없으면 null
   */
  const captchaNotice = async (tab: Tab): Promise<string | null> => {
    let hint: { needsUser: boolean; matched: string }
    try {
      hint = await pageBridge.captchaHint(tab)
    } catch {
      // 페이지를 읽지 못하면 넘김 판단을 하지 않는다(기존 흐름 유지)
      return null
    }
    if (!hint.needsUser) return null
    return `${NEEDS_USER_CAPTCHA} (${hint.matched}): ask the user to complete it on screen`
  }

  /**
   * 캡차·2FA 징후가 있으면 사용자에게 화면을 넘기고, 처리될 때까지 작업을 멈춘다.
   * 징후가 없으면 null 을 돌려준다.
   * AI 는 캡차를 대신 풀지 않는다 — 입력은 언제나 사용자가 한다.
   *
   * **읽기 도구(get_page)에서는 부르지 않는다** — 화면을 한 번 읽어 보려던 호출이
   * 최장 10분 막혀 버린다. 넘김은 login·click 처럼 사용자가 행동을 지시한 경로에서만 건다
   */
  const captchaHandoff = async (tab: Tab): Promise<string | null> => {
    let hint: { needsUser: boolean; matched: string }
    try {
      hint = await pageBridge.captchaHint(tab)
    } catch {
      return null
    }
    if (!hint.needsUser) return null
    if (!ctx.handoff) {
      return `${NEEDS_USER_CAPTCHA} (${hint.matched}): ask the user to complete it on screen`
    }
    try {
      const result = await ctx.handoff({
        matched: hint.matched,
        currentUrl: () => currentUrl(tab),
        stillBlocked: async () => (await pageBridge.captchaHint(tab)).needsUser
      })
      return handoffToolResult(result)
    } catch (e: unknown) {
      // 감시 중에 탭이 사라지면 currentUrl 이 던진다 — 넘김만 접고 도구는 계속 답한다
      // (여기서 전파하면 도구 호출 전체가 예외로 끝나 모델이 아무 정보도 받지 못한다)
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('캡차 넘김이 끊겼습니다(탭 종료 등)', reason)
      return `${NEEDS_USER_CAPTCHA} (${hint.matched}): handoff was cancelled; the tab may have closed`
    }
  }

  /**
   * 결제창이 어느 사이트 계정의 것인지. 결제 키패드는 PG 도메인(NICE·KCP·페이코) 팝업이나
   * iframe 에 뜨므로 그 창의 호스트로는 계정을 못 찾는다 — 팝업을 연 탭(opener)의 호스트로
   * 되돌아가 찾는다. opener 도 없으면 현재 창 호스트 그대로다
   */
  // 이번 실행에서 키패드 자동 입력을 이미 한 결제창 호스트들
  const keypadAttempts = new Set<string>()
  // 이번 실행에서 "비밀번호 불일치"로 로그인이 거부된 호스트들 — 다시 시도하지 않는다
  const wrongPasswordHosts = new Set<string>()

  const keypadAccountHosts = (tab: Tab): string[] => {
    const hosts = [currentHost(tab)]
    // opener 사슬을 팝업까지 따라간다(무신사머니 팝업 → 그 안에서 열린 ePAY 팝업). 탭 목록에는
    // 팝업이 없어 list() 만 보면 결제창의 부모를 못 찾는다(실기: account not found)
    const targets = targetList()
    let openerId = tab.openerId
    for (let depth = 0; depth < 4 && openerId; depth += 1) {
      const opener = targets.find((t) => t.id === openerId)
      if (!opener) break
      hosts.push(normalizeHost(opener.url))
      openerId = opener.openerId
    }
    // 같은 탭 안에서 결제창으로 넘어온 경우(롯데온 → pay.naver.com, opener 없음)는 뒤로가기 이력의
    // 직전 호스트들을 쇼핑몰 후보로 쓴다 — 없으면 결제 앱 호스트만 남아 계정을 못 골랐다(실기 2026-09-28)
    if (hosts.length === 1) {
      try {
        const nav = tab.view.webContents.navigationHistory
        const entries = nav.getAllEntries()
        for (let i = nav.getActiveIndex() - 1; i >= 0 && hosts.length < 4; i -= 1) {
          const h = normalizeHost(entries[i]?.url ?? '')
          if (h && !hosts.includes(h) && !sameRegistrableDomain(h, hosts[0])) hosts.push(h)
        }
      } catch {
        // 이력을 못 읽어도 opener 방식은 그대로 동작한다
      }
    }
    return hosts.filter((h) => h !== '')
  }

  /**
   * 네이버페이 창에 표시된 로그인 아이디(마스킹 mjki****** 또는 비밀번호 화면의 "buyer01 님")를 읽는다.
   * 비밀번호 화면은 "동의하고 결제하기" 직후 다시 그려지는 중일 수 있다 — 표기가 없으면 잠깐 두고 다시 읽는다.
   * 못 읽으면 실패 라벨에 주소(쿼리 제외)·본문 길이·읽기 오류를 남기고 null(비밀은 없다)
   */
  const readNaverPayAccount = async (tab: Tab): Promise<string | null> => {
    let shown: string | null = null
    let textLength = 0
    let readError = ''
    for (let attempt = 0; attempt < 3 && shown === null; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500))
      try {
        const snapshot = await pageBridge.snapshot(tab)
        textLength = snapshot.text.length
        shown = maskedNaverAccount(`${snapshot.title}\n${snapshot.text}`)
      } catch (e: unknown) {
        readError = e instanceof Error ? e.message : String(e)
      }
    }
    if (!shown) {
      const where = pathOnly(currentUrl(tab))
      ctx.onStep(
        `네이버페이 창 계정 확인 실패(표시 없음: ${where}, 본문 ${textLength}자${readError ? `, 읽기 오류: ${readError}` : ''})`,
        false
      )
    }
    return shown
  }

  /**
   * 네이버페이 창이면 창에 표시된 로그인 아이디로 계정을 고른다 — 라벨도 프로필 단서도 없고 쇼핑몰 계정 여럿이
   * 결제 비밀번호를 가진 경우(실기 8차: ABC 계정 4개가 각각 네이버 계정에 연결). 후보 중 연결된 네이버 아이디가
   * 표시 아이디와 맞는 것을 고르되, 결제창을 연 쇼핑몰 쪽 계정을 먼저 본다. 하나로 좁혀지지 않으면 null
   */
  const keypadAccountByNaverWindow = async (
    available: VaultService,
    hosts: string[],
    tab: Tab
  ): Promise<AccountDto | null> => {
    if (!isNaverPayHost(currentHost(tab))) return null
    const shown = await readNaverPayAccount(tab)
    if (!shown) return null
    const seen = new Set<number>()
    const matching: AccountDto[] = []
    for (const host of hosts) {
      for (const a of available.listAccounts(host)) {
        if (seen.has(a.id) || !a.itemTypes.includes('password')) continue
        seen.add(a.id)
        const username = available.paymentAccountUsername(a.id, 'naver')
        if (username && maskedNaverAccountMatches(shown, username)) matching.push(a)
      }
    }
    const shopHosts = hosts.slice(1)
    const fromShop = matching.filter((a) => shopHosts.some((h) => sameRegistrableDomain(h, a.host)))
    const pool = fromShop.length > 0 ? fromShop : matching
    if (pool.length === 0) {
      ctx.onStep(`키패드 계정: 네이버페이 창 표시(${shown})에 연결된 계정 없음`, false)
      return null
    }
    // 여럿이어도 모두 같은 네이버 계정(같은 결제 비밀번호)에 연결돼 있으면 어느 것이든 같다(실기 9차: ABC 계정 4개
    // 가 전부 buyer01 연결). 다른 네이버 계정이 섞여 있으면 고르지 않는다
    const linked = new Set(pool.map((a) => available.paymentAccountUsername(a.id, 'naver')))
    if (linked.size !== 1) {
      ctx.onStep(
        `키패드 계정: 네이버페이 창 표시(${shown})에 맞는 계정이 ${pool.length}개(연결 계정 다름)`,
        false
      )
      return null
    }
    // 같은 연결이면 어느 것이든 되지만, 표시 아이디와 이름이 같은 계정(buyer01)이 있으면 그것을 앞세운다(로그 가독성)
    const picked =
      pool.find((a) => maskedNaverAccountMatches(shown, a.label)) ??
      pool.find((a) => maskedNaverAccountMatches(shown, a.username)) ??
      pool[0]
    ctx.onStep(`키패드 계정: 네이버페이 창 표시(${shown})로 ${picked.label} 선택`, true)
    return picked
  }

  /**
   * 네이버페이 결제창(pay.naver.com)이면 창 우측 위의 마스킹된 아이디(mjki******)를 읽어 키마스터에서 고른
   * 네이버 계정과 맞춘다. 다른 계정이거나 못 읽으면 거부 문구, 네이버페이 창이 아니거나 계정 연결이 없으면 null
   */
  const verifyNaverPayAccount = async (
    v: VaultService,
    accountId: number,
    tab: Tab
  ): Promise<string | null> => {
    if (!isNaverPayHost(currentHost(tab))) return null
    const expected = v.paymentAccountUsername(accountId, 'naver')
    if (!expected) return null
    const shown = await readNaverPayAccount(tab)
    if (!shown) return NAVERPAY_ACCOUNT_UNKNOWN
    if (!maskedNaverAccountMatches(shown, expected)) {
      ctx.onStep(`네이버페이 창 계정 불일치: ${shown} ≠ ${expected}`, false)
      return NAVERPAY_ACCOUNT_MISMATCH(shown, expected)
    }
    ctx.onStep(`네이버페이 창 계정 확인: ${shown}`, true)
    return null
  }

  /**
   * 결제 비밀번호를 넣을 계정. 같은 이름의 계정이 로그인 도메인별로 여럿일 수 있다
   * (member.one.musinsa.com / my.musinsa.com / musinsa.com 의 alice) — 그중 결제 비밀번호를
   * 가진 계정을 먼저 본다. 안 그러면 프로필 이름이 같은 다른 계정을 잡아 "not found" 로 끝난다(실기)
   */
  const keypadAccount = (
    available: VaultService,
    hosts: string[],
    accountLabel: string | undefined,
    profile: string,
    wanted: VaultItemType = 'password'
  ): AccountDto | null => {
    const seen = new Set<number>()
    const candidates: AccountDto[] = []
    for (const host of hosts) {
      for (const a of available.listAccounts(host)) {
        if (seen.has(a.id)) continue
        seen.add(a.id)
        candidates.push(a)
      }
    }
    const withItem = candidates.filter((a) => a.itemTypes.includes(wanted))
    const resolved =
      resolveAccount(withItem, accountLabel, profile) ??
      resolveAccount(candidates, accountLabel, profile)
    if (resolved || accountLabel) return resolved
    // 라벨도 프로필 단서도 없다(기본 프로필 탭에서 연 결제창, 실기 7차) — 결제창을 연 쇼핑몰 쪽 계정 중
    // 이 결제 수단의 항목을 가진 계정이 하나뿐이면 그것이다(네이버 계정 수십 개 사이에서 고를 필요가 없다).
    // 네이버페이는 이어지는 창 계정 검사가 그 계정으로 로그인돼 있는지 다시 맞춰 본다
    const shopHosts = hosts.slice(1)
    const fromShop = withItem.filter((a) => shopHosts.some((h) => sameRegistrableDomain(h, a.host)))
    return fromShop.length === 1 ? fromShop[0] : null
  }

  /**
   * 결제창(팝업) 안의 결제 앱 로그인(네이버·페이코)에 쓸 계정. 결제창을 연 쇼핑몰 계정의 결제 비밀번호 항목이
   * 연결해 둔 앱 계정 아이디(payment.account)와 같은 아이디의 앱 사이트 계정을 고른다 — 키마스터에서 무신사
   * 계정마다 네이버페이·페이코 계정을 골라 두는 것과 같은 규칙이다. 결제창이 아니거나 연결이 없으면 null
   */
  const linkedAppAccount = (
    available: VaultService,
    tab: Tab,
    loginHost: string,
    accountLabel: string | undefined
  ): AccountDto | null => {
    const entry = (
      Object.entries(PAYMENT_PROVIDER_ACCOUNT_HOST) as Array<[PaymentProvider, string]>
    ).find(([, appHost]) => sameRegistrableDomain(loginHost, appHost))
    if (!entry) return null
    const [provider] = entry
    const shopHosts = keypadAccountHosts(tab)
      .slice(1)
      .filter((h) => !sameRegistrableDomain(h, loginHost))
    if (shopHosts.length === 0) return null
    const shop = keypadAccount(available, shopHosts, accountLabel, tab.profile)
    if (!shop) return null
    const username = available.paymentAccountUsername(shop.id, provider)
    if (!username) return null
    const appAccounts = available.listAccounts(loginHost).filter((a) => a.username === username)
    return appAccounts.find((a) => a.itemTypes.includes('login')) ?? appAccounts[0] ?? null
  }

  /**
   * 웹 결제 비밀번호 키패드에 키마스터 값을 앱이 넣는다. 값은 web-keypad 실행기 안에만 있고,
   * 여기는 결과 문구만 받는다. 넣지 못했으면(배치 불완전·검증 실패) 사람에게 넘긴다.
   * 계정 호스트 검사: 키패드가 계정 도메인 자체에 있거나, 계정 도메인 탭이 연 결제창(팝업)에
   * 있어야 한다 — 아무 사이트의 키패드에나 결제 비밀번호를 넣지 않는다
   */
  const keypadEnter = async (
    tab: Tab,
    accountLabel: string | undefined,
    provider: PaymentProvider | undefined,
    // 시험 입력(dry-run) 자리수. 주면 이 자리수만 누르고 결제창을 닫는다(결제하지 않는다)
    dryRunDigits: number | undefined
  ): Promise<string> => {
    const blocked = gateRefusal(currentUrl(tab))
    if (blocked) return blocked
    // 금고를 쓸 수 없으면(미설정·잠김) 예전처럼 사람에게 넘긴다 — 사용자가 직접 누르면 이어간다
    const available = vaultAvailable()
    if (typeof available === 'string') return await keypadHandoff(tab)
    const hosts = keypadAccountHosts(tab)
    // 네이버페이 창이면 창에 로그인된 네이버 계정에 연결된 항목을 먼저 고른다 — 비밀번호는 그 네이버 계정의 것이다.
    // 라벨(쇼핑몰 계정)을 먼저 보면 연결이 다른 항목을 골라 거절됐다(실기 2026-09-25 ABC V36: buyer02 ≠ 창 buyer01)
    const byWindow = isNaverPayHost(currentHost(tab))
      ? await keypadAccountByNaverWindow(available, hosts, tab)
      : null
    const account =
      byWindow ??
      keypadAccount(available, hosts, accountLabel, tab.profile) ??
      (accountLabel ? null : await keypadAccountByNaverWindow(available, hosts, tab))
    if (!account) {
      // 왜 못 골랐는지 라벨에 남긴다(호스트·탭 프로필·후보 라벨 — 비밀은 없다). 실기 5차: 라벨 없이 부르면 여기서 끝났다
      const labels = hosts
        .flatMap((h) => available.listAccounts(h))
        .map((a) => `${a.label}${a.itemTypes.includes('password') ? '*' : ''}`)
      ctx.onStep(
        `키패드 계정 못 고름(호스트 ${hosts.join(',')}; 프로필 ${tab.profile ?? '-'}; 후보 ${labels.slice(0, 12).join(' ') || '없음'})`,
        false
      )
      return hosts.length > 1 ? KEYPAD_ACCOUNT_UNKNOWN : ACCOUNT_NOT_FOUND
    }
    const gate = await applyPolicy(available, effectiveAccess(account.agentAccess, globalPolicy()))
    // 잠김·미설정은 사람에게 넘기고(직접 누르면 이어간다), 접근 정책 거부(never)는 그대로 알린다
    if (gate === VAULT_LOCKED || gate === VAULT_NOT_SET_UP) return await keypadHandoff(tab)
    if (typeof gate === 'string') return gate
    const v = gate
    // 결제창 호스트가 계정 도메인과 다르면 계정 도메인 탭이 연 팝업이어야 한다
    // (제외 도메인·평문 페이지는 위 gateRefusal 이 이미 걸렀다)
    const here = currentHost(tab)
    const accountHost = account.host
    if (!sameRegistrableDomain(here, accountHost)) {
      const openedFromAccountSite = hosts
        .slice(1)
        .some((h) => sameRegistrableDomain(h, accountHost))
      if (!openedFromAccountSite) return FILL_HOST_MISMATCH
    }
    // 네이버페이 창은 반드시 고른 네이버 계정으로 로그인돼 있어야 한다(우측 위 마스킹 아이디로 맞춘다)
    const naverCheck = await verifyNaverPayAccount(v, account.id, tab)
    if (naverCheck) return naverCheck
    // guard 모드는 결제 비밀번호 입력 전에 한 번 더 묻는다(fill_secret 의 평소 규칙과 같다).
    // full 모드는 묻지 않는다 — 결제 직전 확인은 플레이북이 정한다
    if (ctx.mode === 'guard') {
      const ok = await ctx.confirm('키마스터 입력: 결제 비밀번호 키패드', 'danger')
      if (!ok) return 'denied by user'
    }
    // 한 실행에서 키패드 자동 입력은 결제창(호스트)마다 1회뿐이다. 틀린 값을 모델이 다시 부르면
    // 5회 오답으로 결제 수단이 잠긴다(실기: 3/5 까지 감). 두 번째부터는 앱이 거절하고 사람에게 맡긴다
    const attemptKey = currentHost(tab)
    // 세션을 넘는 기록은 창(id)별이다 — 호스트만 보면 다음 주문의 새 결제창(같은 pay.naver.com)까지 막힌다
    const windowKey = `${tab.id}|${attemptKey}`
    if (keypadAttempts.has(attemptKey) || ctx.keypadEntered?.has(windowKey)) return KEYPAD_ALREADY_TRIED
    // 글자·이름으로 읽히는 키패드가 먼저다. 못 읽으면(네이버페이처럼 숫자를 이미지로 그린 키패드)
    // 빈 버튼들을 OCR 로 읽어 배치를 만든다 — 둘 다 안 되면 사람에게 넘긴다
    const labelled = await pageBridge.keypadLayout(tab).catch(() => null)
    const fromOcr = labelled === null
    const layout = labelled ?? (await ocrKeypadLayout(tab).catch(() => null))
    if (fromOcr) ctx.onStep('키패드 배치(OCR)', layout !== null)
    if (!layout) return await keypadHandoff(tab)
    // 시험 입력은 끝까지 누르지 않으므로 1회 제한을 쓰지 않는다 — 진짜 입력 기회를 남겨 둔다
    if (dryRunDigits === undefined) {
      keypadAttempts.add(attemptKey)
      rememberKeypadEntered(ctx.keypadEntered, windowKey)
    }
    let typedDigits = dryRunDigits ?? 0
    const frameIndex = layout.frameIndex
    const result: WebKeypadResult = await enterWebPaymentPassword({
      vault: v,
      accountId: account.id,
      ...(provider === undefined ? {} : { provider }),
      ...(ctx.jobId === undefined ? {} : { jobId: ctx.jobId }),
      layout,
      // 누를 때마다 숫자가 재배열되는 키패드가 있다 — 매 자리 직전에 배치를 다시 읽는다
      relayout: fromOcr
        ? () => ocrKeypadLayout(tab).catch(() => null)
        : () => pageBridge.keypadLayout(tab).catch(() => null),
      // 일반 click 은 변화가 안 보이면 Enter·좌표로 다시 눌러 같은 숫자가 두세 번 들어간다 —
      // 키패드는 폴백 없는 단발 누름만 쓴다
      click: (id) => pageBridge.pressOnce(tab, id),
      // 보안 키패드가 합성 클릭을 무시하면 요소 가운데 좌표에 진짜 마우스 클릭을 보낸다.
      // 프레임 안 요소는 화면 좌표를 알 수 없어 rectOf 가 null 이다 — 그때는 폴백 없이 넘김으로 간다
      clickNative: async (id) => {
        const point = await pageBridge.rectOf(tab, id).catch(() => null)
        return point ? pageBridge.clickAt(tab, point.x, point.y) : false
      },
      // OCR 배치는 입력칸이 없는 화면(점 6개)이라 자리수를 셀 수 없다 — 검증 없이 한 번씩만 누른다
      filled: fromOcr ? async () => null : () => pageBridge.keypadFilled(tab, frameIndex),
      onStep: ctx.onStep,
      ...(dryRunDigits === undefined
        ? {}
        : {
            maxDigits: dryRunDigits,
            onTyped: (n: number) => {
              typedDigits = n
            }
          })
    })
    // 시험 입력이면 누른 뒤 결제창을 닫고 끝낸다 — 확인 버튼도 누르지 않는다
    if (result === 'ok' && dryRunDigits !== undefined) {
      return KEYPAD_DRY_RUN(typedDigits, await closeKeypadWindow(tab))
    }
    if (result === 'ok') return KEYPAD_ENTERED_NEXT
    if (result === 'ambiguous') return PAYMENT_PROVIDER_AMBIGUOUS
    if (result === 'not-found') {
      return `not found: no payment password${provider ? ` (${provider})` : ''} saved for this account`
    }
    // 금고가 잠겼거나, 배치를 못 읽었거나, 눌러도 자리수가 늘지 않았다 — 사람에게 넘긴다
    return await keypadHandoff(tab)
  }

  /**
   * 글자 없는 보안 키패드(네이버페이 결제 비밀번호 창)의 배치를 OCR 로 만든다.
   * 빈 버튼 칸마다 화면을 잘라 한 자리 숫자로 읽고, 0~9 가 각각 정확히 한 번씩 읽혔을 때만
   * 배치를 돌려준다 — 하나라도 빠지거나 겹치면 null(잘못 누르면 결제 수단이 잠긴다).
   * 배치(숫자 위치)는 로그·결과·모델 어디에도 내보내지 않는다. 자리수 검증 수단이 없어 filled 는 null
   */
  // 캡처는 탭이 화면에 그려져 있어야 한다 — 뒤 층(가려진) 탭이면 OCR 동안만 맨 위로 올린다
  const ocrKeypadLayout = (tab: Tab): Promise<KeypadLayout | null> =>
    ctx.tabs.withFront(tab.id, () => ocrKeypadLayoutInner(tab))

  const ocrKeypadLayoutInner = async (tab: Tab): Promise<KeypadLayout | null> => {
    // 비밀번호 화면 글이 먼저 뜨고 키패드 버튼은 늦게 그려진다(실기 2026-09-29 롯데온 바로구매:
    // 결제하기 8초 뒤엔 버튼이 아직 없어 사람에게 넘겼다) — 몇 초 동안 다시 찾아본다
    let cells = await pageBridge.keypadUnlabeled(tab).catch(() => null)
    for (let i = 0; i < KEYPAD_CELLS_RETRIES && !cells; i++) {
      await new Promise((resolve) => setTimeout(resolve, KEYPAD_CELLS_WAIT_MS))
      cells = await pageBridge.keypadUnlabeled(tab).catch(() => null)
    }
    if (!cells) {
      const diag = await pageBridge.keypadDiag(tab).catch(() => '')
      ctx.onStep(`키패드 배치(OCR): 글자 없는 버튼 10~14개를 못 찾음${diag ? ` (${diag})` : ''}`, false)
      return null
    }
    // 못 읽은 사유만 모은다(어느 칸이 어느 숫자인지는 남기지 않는다)
    const reasons: string[] = []
    const reads: DigitRead[] = []
    for (const cell of cells) {
      const scores: number[] = []
      const digit = await ocrDigitInRegion(tab, cell, reasons, scores).catch(() => null)
      if (digit === null) continue
      // 확신도를 안 주는 경로(시험의 목 등)는 1 로 본다
      reads.push({ cellId: cell.id, digit, score: scores[0] ?? 1 })
    }
    const resolved = resolveKeypadDigits(reads)
    if (!resolved) {
      const distinct = new Set(reads.map((r) => r.digit)).size
      const why = [...new Set(reasons)].slice(0, 4).join(' ')
      ctx.onStep(
        `키패드 배치(OCR): 칸 ${cells.length}, 읽은 숫자 ${reads.length}(서로 다른 ${distinct})${why ? `, 사유 ${why}` : ''}`,
        false
      )
      return null
    }
    if (resolved.inferred !== null) {
      ctx.onStep(`키패드 배치(OCR): 9개 읽고 빠진 숫자 1개는 혼동 짝으로 추론`, true)
    }
    return { digits: resolved.digits, filled: null, frameIndex: 0 }
  }

  /**
   * 시험 입력을 끝낸 뒤 결제창을 닫는다. 팝업이면 창째로 닫고, 탭 안의 키패드면 취소·닫기 버튼을
   * 눌러 본다. 어느 쪽도 못 하면 사용자가 직접 닫도록 그대로 알린다
   */
  const closeKeypadWindow = async (tab: Tab): Promise<string> => {
    const target = targetList().find((t) => t.id === tab.id)
    if (target?.kind === 'popup') {
      closeTargetOf(ctx.tabs, tab.id)
      return 'popup closed'
    }
    try {
      const snapshot = await pageBridge.snapshot(tab)
      const cancel = snapshot.elements.find((e) =>
        KEYPAD_CANCEL_RE.test((e.text || e.name || '').trim())
      )
      if (cancel) {
        await pageBridge.click(tab, cancel.id)
        return 'cancel button clicked'
      }
    } catch {
      // 페이지를 못 읽어도 시험 입력 자체는 끝났다 — 사용자가 닫도록 알리기만 한다
    }
    return 'not closed - close the payment window yourself'
  }

  /**
   * 웹 결제 비밀번호 키패드를 사용자에게 넘긴다(앱이 넣지 못했을 때).
   * 사용자가 직접 누르고 "계속" 하면 이어간다. 비밀값은 어디에도 오가지 않는다
   */
  const keypadHandoff = async (tab: Tab): Promise<string> => {
    if (!ctx.handoff) return `handoff: ${KEYPAD_HANDOFF_MESSAGE}`
    try {
      const result = await ctx.handoff({
        matched: KEYPAD_HANDOFF_MATCHED,
        kind: 'keypad',
        currentUrl: () => currentUrl(tab),
        stillBlocked: async () => (await secretKeypadGate.check(tab, { fresh: true })) !== null
      })
      // '건너뛰고 계속'은 "지금은 안 누른다"는 뜻이다 — 같은 키패드에 fill_secret 을 다시 부르면
      // 카드가 또 뜬다(실기에서 반복 관찰). 모델에게 다음 행동을 콕 집어 준다
      if (result.outcome === 'skipped')
        return `handoff: ${KEYPAD_HANDOFF_MESSAGE}
${KEYPAD_SKIPPED_NEXT}`
      return `handoff: ${KEYPAD_HANDOFF_MESSAGE}
${handoffToolResult(result)}`
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e)
      console.warn('결제 키패드 넘김이 끊겼습니다(탭 종료 등)', reason)
      return `handoff: ${KEYPAD_HANDOFF_MESSAGE}`
    }
  }

  /**
   * 제출 직전 "로그인 상태 유지" 체크박스를 켠다(설정으로 끌 수 있다).
   * 로그인 세션을 재사용하면 재로그인이 줄어 캡차도 덜 뜬다. 실패해도 로그인은 계속한다
   */
  const keepSignedIn = async (tab: Tab, anchorId?: number): Promise<void> => {
    if (ctx.vaultKeepSignedIn === false) return
    try {
      await pageBridge.checkKeepSignedIn(tab, anchorId)
    } catch {
      // 체크박스가 없거나 페이지를 못 읽어도 로그인 자체는 진행한다
    }
  }

  /**
   * 대상 탭이 웹 결제 비밀번호 키패드 화면이면 거부 문구를, 아니면 null 을 돌려준다.
   * 스캔은 도구 호출당 1회다(secret-page 의 500ms 캐시)
   */
  const keypadRefusal = async (tab: Tab, refusal: string): Promise<string | null> =>
    (await secretKeypadGate.check(tab)) === null ? null : refusal

  /**
   * 화면을 덮고 있는 레이어 목록. 페이지를 못 읽으면 빈 목록으로 본다
   * (오버레이 안내는 덤이라 실패가 읽기 도구를 막으면 안 된다)
   */
  const overlaysOf = async (tab: Tab): Promise<PageOverlay[]> => {
    try {
      return await pageBridge.overlays(tab)
    } catch {
      return []
    }
  }

  /**
   * get_page·find_elements 앞머리에 붙이는 한 줄.
   * 덮고 있는 레이어가 없으면 null
   */
  const overlayNotice = async (tab: Tab): Promise<string | null> => {
    const list = await overlaysOf(tab)
    const first = list[0]
    if (!first) return null
    const head = `OVERLAY: "${first.label}" is covering the page`
    // 결제·로그인 모달은 절대 대신 닫지 않는다 — 존재만 알린다
    if (first.sensitive) return `${head} - payment/sign-in dialog: do NOT dismiss it`
    if (first.closeIds.length === 0) return `${head} - no close button found`
    return `${head} - close ids: [${first.closeIds.join(', ')}]`
  }

  // --- 동작 본체 --------------------------------------------------------
  //
  // 도구(get_page·click·…)와 run_js 가 같은 함수를 쓴다. 가드(read_only·위험 단어 확인·
  // 결제 키패드·SECRET)는 전부 여기 들어 있어, run_js 로 들어와도 빠져나갈 길이 없다.

  // 탭별 직전 스냅샷 문자열(get_page 의 diff 인자용). 최대 SNAPSHOT_CACHE_TABS 개
  const snapshotCache = new Map<string, string>()

  /** 스냅샷을 읽어 직렬화한다. 실패·잘못된 selector 는 문자열로 돌려준다 */
  const readSnapshot = async (options: {
    query?: string
    selector?: string
  }): Promise<{ tab: Tab; snapshot: PageSnapshot; tree: string } | string> => {
    const tab = activeOr(ctx)
    if (!tab) return 'no active tab'
    await pageBridge.waitForLoad(tab)
    const snapshot = await pageBridge.snapshot(tab, options.query, options.selector)
    if (snapshot.selectorError !== undefined) return `error: ${snapshot.selectorError}`
    return { tab, snapshot, tree: serializeSnapshot(snapshot) }
  }

  const doClick = async (id: number, label: string): Promise<string> =>
    withPopupNotice(async () => {
      if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
      const tab = activeOr(ctx)
      if (!tab) return 'no active tab'
      // 결제 비밀번호 키패드에서는 숫자를 누르지 않는다
      const keypad = await keypadRefusal(tab, PAYMENT_KEYPAD_REFUSAL)
      if (keypad) return keypad
      // 위험 판정 근거는 페이지의 실제 텍스트. AI 가 준 label 은 기록용일 뿐 신뢰하지 않는다
      const pageText = await pageBridge.textOf(tab, id)
      // full 모드는 위험 단어 확인을 생략한다(SECRET 거부·URL 허용목록·호출 상한은 그대로 유지)
      if (ctx.mode !== 'full' && isDangerous(`${pageText} ${label}`, ctx.dangerWords)) {
        const ok = await ctx.confirm(`클릭: ${pageText || label}`, 'danger')
        if (!ok) return 'denied by user'
      }
      const r = await pageBridge.click(tab, id)
      await pageBridge.waitForLoad(tab)
      // preload 의 폴백(합성 클릭 → Enter → 좌표 클릭)이 전부 헛돌았으면 마지막으로
      // 진짜 마우스 클릭을 보낸다. 합성 이벤트를 아예 믿지 않는 사이트(롯데온 주소 검색
      // 결과의 '사용')가 있어서다. 프레임 안 요소는 좌표를 알 수 없어 여기서 끝낸다
      if (!r.includes(CLICK_NO_CHANGE_MARK)) return r
      const point = await pageBridge.rectOf(tab, id).catch(() => null)
      if (!point || !pageBridge.clickAt(tab, point.x, point.y)) return r
      await pageBridge.waitForLoad(tab)
      return `${r}; via native click (retried with a real mouse click; call get_page to check)`
    })

  const doType = async (id: number, value: string, submit: boolean): Promise<string> =>
    withPopupNotice(async () => {
      if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
      const tab = activeOr(ctx)
      if (!tab) return 'no active tab'
      // 결제 비밀번호 키패드에서는 입력하지 않는다(숫자칸·키패드 모두)
      const keypad = await keypadRefusal(tab, PAYMENT_KEYPAD_REFUSAL)
      if (keypad) return keypad
      // 입력값 자체와 대상 입력칸의 실제 텍스트를 함께 판정
      const pageText = await pageBridge.textOf(tab, id)
      if (ctx.mode !== 'full' && isDangerous(`${pageText} ${value}`, ctx.dangerWords)) {
        const ok = await ctx.confirm(`입력: ${value}${pageText ? ` → ${pageText}` : ''}`, 'danger')
        if (!ok) return 'denied by user'
      }
      const r = await pageBridge.type(tab, id, value, submit)
      if (submit) await pageBridge.waitForLoad(tab)
      return r
    })

  const doSelect = async (id: number, value: string): Promise<string> =>
    withPopupNotice(async () => {
      if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
      const tab = activeOr(ctx)
      if (!tab) return 'no active tab'
      const keypad = await keypadRefusal(tab, PAYMENT_KEYPAD_REFUSAL)
      if (keypad) return keypad
      return pageBridge.select(tab, id, value)
    })

  const doScroll = async (direction: 'up' | 'down', id?: number): Promise<string> => {
    const tab = activeOr(ctx)
    if (!tab) return 'no active tab'
    const keypad = await keypadRefusal(tab, PAYMENT_KEYPAD_REFUSAL)
    if (keypad) return keypad
    return pageBridge.scroll(tab, direction, id)
  }

  const getPage = tool(
    'get_page',
    'For single actions; prefer run_js for sequences. ' +
      'Read the current page: URL, title, numbered interactive elements, visible text. ' +
      'At most 150 elements are listed; pass query to list only the ones matching that text. ' +
      'Pass selector (a CSS selector) to list only what is inside it - element ids stay the same. ' +
      'Pass diff=true to get only the lines that changed since your last get_page on this tab.',
    { query: z.string().optional(), selector: z.string().optional(), diff: z.boolean().optional() },
    ({ query, selector, diff }) =>
      guard(
        query ? `페이지 읽기: ${query}` : '페이지 읽기',
        async () => {
          const read = await readSnapshot({ query, selector })
          if (typeof read === 'string') return read
          const { tab, tree } = read
          const prev = rememberSnapshot(snapshotCache, tab.id, tree)
          // 사람의 추가 확인이 필요하면 **알리기만** 한다 — 읽기 도구가 최장 10분 막히면
          // 모델이 다음 수를 두지 못한다. 실제 넘김·대기는 login 같은 행동 도구가 건다
          const notice = await captchaNotice(tab)
          // 화면을 덮는 레이어는 맨 앞에 알린다 — 뒤에 있는 버튼을 누르려다 실패하지 않게
          const overlay = await overlayNotice(tab)
          // diff 는 직전 읽기가 있을 때만 뜻이 있다 — 처음이면 트리 전체를 준다
          const body =
            diff === true && prev !== undefined ? diffLines(prev, tree) || NO_CHANGE : tree
          return [overlay, notice, body].filter((line) => line !== null).join('\n')
        },
        undefined,
        true
      )
  )

  // 나열 상한(150개) 때문에 필요한 버튼이 목록에서 빠졌을 때 되찾는 통로.
  // registry 는 보이는 요소를 전부 들고 있으므로 150 이후 id 도 click/type 이 된다
  const findElements = tool(
    'find_elements',
    "Search interactive elements by visible text/name/href when read_page's list is truncated; returns matching element ids to use with click/type",
    { query: z.string() },
    ({ query }) =>
      guard(
        `요소 찾기: ${query}`,
        async () => {
          const tab = activeOr(ctx)
          if (!tab) return 'no active tab'
          const snapshot = await pageBridge.snapshot(tab, query)
          const overlay = await overlayNotice(tab)
          if (snapshot.elements.length === 0) {
            const miss = `no element matches "${query}"`
            return overlay === null ? miss : `${overlay}\n${miss}`
          }
          const listed = serializeSnapshot({ ...snapshot, text: '' })
          return overlay === null ? listed : `${overlay}\n${listed}`
        },
        undefined,
        true
      )
  )

  // 화면 캡처: get_page 텍스트로는 알 수 없는 정보(이미지 캡차·그래프·레이아웃)가 필요할 때 사용.
  // read_only 모드에서도 허용(조회일 뿐 조작이 아님). 이미지 블록을 돌려줘야 하므로 text() 기반
  // guard() 를 그대로 쓰지 않고, 같은 호출 상한·step 기록 로직만 인라인으로 맞춘다
  const screenshot = tool(
    'screenshot',
    'Screenshot the active tab as an image. Do NOT use it when the text snapshot already answers the question - ' +
      'only when get_page text is not enough (image captcha, chart, layout). ' +
      'Password fields show as dots, never the real value.',
    { full: z.boolean().optional() },
    async () => {
      const over = ctx.tick()
      if (over) {
        if (!limitNotified) {
          limitNotified = true
          ctx.onStep('도구 호출 상한 도달', false)
        }
        return text(over)
      }
      try {
        const tab = activeOr(ctx)
        const bounds = tab?.view.getBounds()
        // 키마스터 등 웹뷰가 접힌 화면(view !== 'browser')은 bounds 가 0 이 되어 캡처 대상이 아니다
        if (!tab || !bounds || bounds.width === 0 || bounds.height === 0) {
          ctx.onStep('화면 캡처', false)
          return text('no visible page')
        }
        // 비밀 키패드 화면은 캡처하지 않는다 — 숫자 배치를 모델에게 보여 주지 않는다
        if (await secretKeypadGate.check(tab)) {
          ctx.onStep('화면 캡처', false)
          return text(SECRET_SCREEN_REFUSAL)
        }
        const image = await tab.view.webContents.capturePage()
        const { width, height } = image.getSize()
        // 긴 변을 1280px 로 맞춰 리사이즈(비율 유지)
        const resized =
          Math.max(width, height) > 1280
            ? image.resize(width >= height ? { width: 1280 } : { height: 1280 })
            : image
        const base64 = resized.toJPEG(70).toString('base64')
        const { width: w, height: h } = resized.getSize()
        ctx.onStep('화면 캡처', true)
        return {
          content: [
            { type: 'image' as const, data: base64, mimeType: 'image/jpeg' },
            {
              type: 'text' as const,
              text: `screenshot of ${currentHost() || 'unknown'} (${w}x${h})`
            }
          ]
        }
      } catch (e) {
        ctx.onStep('화면 캡처', false)
        return text(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  const navigate = tool(
    'navigate',
    'Open a URL or search query in the active tab.',
    { url: z.string() },
    ({ url }) =>
      guard(`이동: ${url}`, async () => {
        // 내부 페이지(samba://…)는 AI 도구로 열 수 없다 — 사용자 탐색 전용이다
        if (isInternalUrl(url)) return `${BLOCKED_URL_MESSAGE} (${url})`
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        // 팝업 창(결제창·주소 검색창)은 그 사이트가 띄운 흐름을 그대로 따라가야 한다.
        // 주소를 갈아 끼우면 결제 세션이 끊기므로, 탭으로 돌아가라고 알려 준다
        if (targetList().find((t) => t.id === tab.id)?.kind === 'popup') {
          return 'refused: cannot navigate inside a popup; switch_tab to the opener tab first'
        }
        await ctx.tabs.navigate(tab.id, url)
        await pageBridge.waitForLoad(tab)
        return `ok: ${tab.view.webContents.getURL()}`
      })
  )

  const click = tool(
    'click',
    'For single actions; prefer run_js for sequences. Click element [n] from get_page.',
    { id: z.number().int(), label: z.string().describe('element text, for logging') },
    ({ id, label }) => guard(`클릭: ${label} (#${id})`, () => doClick(id, label), 'click')
  )

  const typeTool = tool(
    'type',
    'Type text into input [n]. submit=true presses Enter.',
    { id: z.number().int(), text: z.string(), submit: z.boolean().default(false) },
    ({ id, text: t, submit }) =>
      guard(`입력: "${t.slice(0, 30)}" (#${id})`, () => doType(id, t, submit), 'type')
  )

  const select = tool(
    'select',
    'Choose an option in <select> [n] by value or visible text.',
    { id: z.number().int(), value: z.string() },
    ({ id, value }) => guard(`선택: ${value} (#${id})`, () => doSelect(id, value), 'select')
  )

  const scroll = tool(
    'scroll',
    'Scroll the page up or down. Pass id (an element id from get_page/find_elements) to scroll the ' +
      'scrollable list that contains that element instead - use it when a dropdown or panel shows ' +
      'only its first items (e.g. sizes up to 250 but you need 255): scroll with the id of a visible ' +
      'item, then call find_elements again.',
    { direction: z.enum(['up', 'down']), id: z.number().int().positive().optional() },
    ({ direction, id }) =>
      guard(
        `스크롤 ${direction}${id === undefined ? '' : ` (#${id} 목록)`}`,
        () => doScroll(direction, id),
        'scroll'
      )
  )

  // 한 번의 호출에서 닫아 볼 레이어 개수
  const MAX_DISMISS = 3

  const doDismissOverlay = async (): Promise<string> =>
    withPopupNotice(async () => {
      if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
      const tab = activeOr(ctx)
      if (!tab) return 'no active tab'
      // 결제 비밀번호 키패드 화면에서는 아무것도 누르지 않는다
      const keypad = await keypadRefusal(tab, PAYMENT_KEYPAD_REFUSAL)
      if (keypad) return keypad
      const before = await overlaysOf(tab)
      if (before.length === 0) return 'no overlay is covering the page'
      const sensitive = before.filter((o) => o.sensitive)
      const targets = before
        .filter((o) => !o.sensitive && o.closeIds.length > 0)
        .slice(0, MAX_DISMISS)
      const kept = sensitive.length === 0 ? '' : ` left alone (sensitive): "${sensitive[0].label}"`
      if (targets.length === 0) {
        return sensitive.length > 0
          ? `refused: only a payment/sign-in dialog is open ("${sensitive[0].label}") - answer it yourself or ask the user`
          : `overlay "${before[0].label}" has no close button; scroll or press Escape on screen${kept}`
      }
      const closed: string[] = []
      for (const overlay of targets) {
        const r = await pageBridge.click(tab, overlay.closeIds[0])
        closed.push(`"${overlay.label}" -> ${r}`)
      }
      await pageBridge.waitForLoad(tab)
      const after = await overlaysOf(tab)
      return `dismissed ${closed.length}: ${closed.join('; ')}
overlays left: ${after.length}${kept}`
    })

  const dismissOverlay = tool(
    'dismiss_overlay',
    'Close the notice, coupon, event or app-install layer that covers the page (up to 3 of them). ' +
      'Use it when a click answers "clicked but nothing changed" or get_page starts with an OVERLAY line. ' +
      'Payment, password, sign-in and verification dialogs are never touched - answer those yourself or ask the user.',
    {},
    () => guard('레이어 닫기', doDismissOverlay, 'dismiss_overlay')
  )

  // --- run_js -----------------------------------------------------------
  //
  // 여러 동작을 한 턴에 묶어 실행한다. 코드는 **페이지가 아니라** 메인 프로세스의 vm
  // 샌드박스에서 돌고, 거기서 쓸 수 있는 것은 아래 API 뿐이다. 모든 동작은 도구와
  // 똑같은 본체(doClick·doType·…)를 거치므로 가드를 우회할 수 없다.
  // fill_secret·login·폰 도구는 일부러 노출하지 않는다 — 비밀 경로는 기존 도구로만 간다

  /**
   * run_js 안 동작은 5건당 1회로 상한을 센다(run_js 호출 자체가 1회).
   * 동작마다 세면 80회 상한이 한두 화면에서 바닥나 run_js 를 쓸 이유가 없어진다(실기 관찰)
   */
  let runJsActions = 0
  const runJsTick = (): void => {
    runJsActions += 1
    if (runJsActions % 5 !== 0) return
    const over = ctx.tick()
    if (over) {
      if (!limitNotified) {
        limitNotified = true
        ctx.onStep('도구 호출 상한 도달', false)
      }
      throw new Error(over)
    }
  }

  const asText = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))
  const asId = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0

  /** 샌드박스가 부르는 동작 표. 실행 1건마다 새로 만든다(직전 스냅샷을 그 안에서만 기억) */
  /** 글자로 요소 번호를 찾는다. 글자가 정확히 같은 것을 먼저, 없으면 포함하는 것. 못 찾으면 -1 */
  const idOfText = async (query: string, nth: number): Promise<number> => {
    const read = await readSnapshot({ query })
    if (typeof read === 'string') return -1
    const want = query.trim()
    const label = (e: { text: string; name?: string }): string => (e.text || e.name || '').trim()
    const exact = read.snapshot.elements.filter((e) => label(e) === want)
    const pool = exact.length > 0 ? exact : read.snapshot.elements
    return pool[Math.max(nth, 0)]?.id ?? -1
  }

  const makeRunJsBridge = (clicked?: string[], noPay = false): RunJsBridge => {
    let lastTree: string | undefined
    // noPay(safety no_pay): 결제 확정 버튼(결제하기·입력완료 …)은 누르지 않는다 — 하네스의 AI 스크립트 수리가 켠다.
    // 비밀번호 없는 간편결제는 결제하기 한 번에 결제가 끝난다(실기 2026-09-24). 판정은 페이지 실제 글자
    const payRefusal = async (id: number): Promise<string | null> => {
      if (!noPay) return null
      const tab = activeOr(ctx)
      const text = tab ? await pageBridge.textOf(tab, id).catch(() => '') : ''
      return PAY_CLICK_RE.test(text) ? `${PAY_CLICK_REFUSAL} (${text.slice(0, 40)})` : null
    }
    return async (name, args) => {
      runJsTick()
      switch (name) {
        case 'sleep': {
          const ms = Math.min(Math.max(asId(args[0]), 0), 5000)
          await new Promise((r) => setTimeout(r, ms))
          return 'ok'
        }
        case 'page.get': {
          const o = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as {
            query?: unknown
            selector?: unknown
            interactive?: unknown
          }
          const read = await readSnapshot({
            ...(typeof o.query === 'string' ? { query: o.query } : {}),
            ...(typeof o.selector === 'string' ? { selector: o.selector } : {})
          })
          if (typeof read === 'string') return read
          // interactive 를 주면 본문 텍스트는 빼고 요소 목록만 담는다
          const tree =
            o.interactive === true ? serializeSnapshot({ ...read.snapshot, text: '' }) : read.tree
          const prev = lastTree
          lastTree = tree
          return {
            tree,
            diff: prev === undefined ? tree : diffLines(prev, tree) || NO_CHANGE,
            total: read.snapshot.total ?? read.snapshot.elements.length,
            elements: read.snapshot.elements.length
          }
        }
        case 'page.click': {
          const blocked = await payRefusal(asId(args[0]))
          if (blocked) return blocked
          // 학습용: 번호로 누른 요소가 무슨 글자였는지 남긴다
          if (clicked) {
            const tab = activeOr(ctx)
            const text = tab ? await pageBridge.textOf(tab, asId(args[0])) : ''
            clicked.push(`${asId(args[0])}=${text.slice(0, 40)}`)
          }
          return doClick(asId(args[0]), asText(args[1]))
        }
        case 'page.idOf':
          return idOfText(asText(args[0]), asId(args[1]))
        case 'page.ancestorsOf': {
          const tab = activeOr(ctx)
          if (!tab) return ''
          return pageBridge.ancestorsOf(tab, asId(args[0]))
        }
        case 'page.idOfRowCell': {
          const tab = activeOr(ctx)
          if (!tab) return -1
          return pageBridge.idOfRowCell(tab, asId(args[0]), asId(args[1]))
        }
        case 'page.idOfExact': {
          // 요소 목록에 안 잡히는 칸(그리드 셀)을 글자로 찾아 번호를 준다 — 누르는 것은 click/clickNative 가 한다
          const tab = activeOr(ctx)
          if (!tab) return -1
          return pageBridge.idOfExactText(tab, asText(args[0]), asId(args[1]))
        }
        case 'page.clickNative': {
          const blocked = await payRefusal(asId(args[0]))
          if (blocked) return blocked
          // 요소 가운데 좌표에 진짜 마우스 클릭(sendInputEvent). 프레임 안 요소는 좌표를 몰라 거절한다
          const tab = activeOr(ctx)
          if (!tab) return 'no active tab'
          const point = await pageBridge.rectOf(tab, asId(args[0])).catch(() => null)
          if (!point) return 'not found: element has no screen position (inside a frame or hidden)'
          return (await pageBridge.clickHuman(tab, point.x, point.y))
            ? 'ok'
            : 'failed: click not sent'
        }
        case 'page.clickText': {
          const id = await idOfText(asText(args[0]), asId(args[1]))
          if (id < 0) return `not found: no element with text "${asText(args[0])}"`
          const blocked = await payRefusal(id)
          if (blocked) return blocked
          return doClick(id, asText(args[0]))
        }
        case 'page.type': {
          const tab = activeOr(ctx)
          if (!tab) return 'no active tab'
          // 비밀 입력칸에는 run_js 로 값을 넣지 않는다 — fill_secret 만이 비밀 경로다
          if (await pageBridge.isSecretField(tab, asId(args[0]))) return RUN_JS_SECRET_REFUSAL
          // safety no_pay 면 Enter 제출은 하지 않는다(주문서 폼 제출 = 결제 가능)
          return doType(asId(args[0]), asText(args[1]), !noPay && args[2] === true)
        }
        case 'page.select':
          return doSelect(asId(args[0]), asText(args[1]))
        case 'page.scroll':
          return doScroll(
            args[0] === 'up' ? 'up' : 'down',
            typeof args[1] === 'number' ? asId(args[1]) : undefined
          )
        case 'page.text': {
          const tab = activeOr(ctx)
          if (!tab) return 'no active tab'
          return pageBridge.textOf(tab, asId(args[0]))
        }
        case 'page.find': {
          const read = await readSnapshot({ query: asText(args[0]) })
          if (typeof read === 'string') return read
          return read.snapshot.elements.length === 0
            ? `no element matches "${asText(args[0])}"`
            : serializeSnapshot({ ...read.snapshot, text: '' })
        }
        case 'page.dismissOverlay':
          return doDismissOverlay()
        case 'page.check': {
          // 라벨 글자로 체크박스 켜기(동의 칸). 결제 확정 버튼이 아니라 no_pay 에서도 허용한다
          const tab = activeOr(ctx)
          if (!tab) return 'no active tab'
          return await pageBridge.checkByLabel(tab, asText(args[0])).catch((e: unknown) => `failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        case 'page.url':
          return currentUrl()
        case 'page.title': {
          const tab = activeOr(ctx)
          if (!tab) return ''
          // getTitle 이 없는 대역(테스트 스텁)에서는 빈 제목으로 본다
          return typeof tab.view.webContents.getTitle === 'function'
            ? tab.view.webContents.getTitle()
            : ''
        }
        case 'tabs.list':
          return targetList()
        case 'tabs.switch': {
          const id = asText(args[0])
          const target = targetList().find((t) => t.id === id)
          if (!target) return `not found: no tab or popup with id ${id}`
          focusTargetOf(ctx.tabs, id)
          return `ok: now working in ${target.kind} ${id}`
        }
        case 'tabs.close': {
          if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
          const id = asText(args[0])
          const target = targetList().find((t) => t.id === id)
          if (!target) return `not found: no tab or popup with id ${id}`
          closeTargetOf(ctx.tabs, id)
          return `ok: closed ${target.kind} ${id}`
        }
        case 'tabs.open': {
          // new_tab 도구와 같은 규칙: 내부 페이지 금지, url 없으면 빈 페이지
          if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
          const raw = args[0]
          const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
          const url = typeof o.url === 'string' ? o.url : 'about:blank'
          const profile = typeof o.profile === 'string' ? o.profile : undefined
          if (isInternalUrl(url)) return `${BLOCKED_URL_MESSAGE} (${url})`
          const t = ctx.tabs.create({ url, ...(profile ? { profile } : {}) })
          return `ok: tab ${t.id}${profile ? ` (profile ${profile})` : ''}`
        }
        case 'affiliate.adpick': {
          // 프로필 세션의 애드픽 로그인으로 적립 링크를 받는다(값에 쿠키·계정 정보는 없다)
          const url = typeof args[0] === 'string' ? args[0] : ''
          const profile = typeof args[1] === 'string' && args[1] ? args[1] : 'default'
          return JSON.stringify(await adpickTrackingLink(ctx.tabs.sessionForProfile(profile), url))
        }
        default:
          return RUN_JS_NO_SECRET_TOOLS
      }
    }
  }

  const runJs = tool(
    'run_js',
    'Run a short async script that drives the page through several steps in ONE turn. ' +
      'The code runs in a sandbox in the browser process, not in the page - only these APIs exist: ' +
      'page.get({query,selector,interactive}) -> {tree,diff,total,elements}, page.click(id), ' +
      'page.type(id,text,submit), page.select(id,value), page.scroll(dir,id), page.text(id), ' +
      'page.find(query), page.idOf(text,nth) -> id or -1, page.clickText(text,nth), ' +
      'page.dismissOverlay(), page.url(), page.title(), page.waitFor(textOrRegex, ms) -> true/false (use instead of fixed sleep), ' +
      'tabs.list()/switch(id)/close(id)/open({url, profile}), affiliate.adpick(productUrl, profile) -> JSON string {ok,trackinglink,percent}, sleep(ms), log(...). ' +
      'Use log() and return a value; both come back to you. ' +
      'fill_secret, login and the phone tools are NOT available here - call those tools directly.',
    {
      code: z.string().describe(`JavaScript, ${RUN_JS_MAX_CODE} characters or fewer`),
      // 하네스의 AI 스크립트 수리 전용 — 결제 확정 버튼 클릭·Enter 제출을 앱이 거절한다
      safety: z
        .enum(['no_pay', 'probe'])
        .optional()
        .describe('no_pay: refuse clicks on payment-confirm buttons; probe: report support')
    },
    ({ code, safety }) => {
      // 하네스가 이 앱이 결제 버튼 차단을 아는지 묻는다(모르는 예전 앱은 코드를 그냥 돌린다)
      if (safety === 'probe') return Promise.resolve(text(RUN_JS_SAFETY_PROBE))
      const clicked: string[] = []
      return guard(
        runJsLabel(code),
        async () => {
          const result = await runSandbox(code, makeRunJsBridge(clicked, safety === 'no_pay'))
          ctx.onRunJs?.({ code, ok: isToolResultOk(result, true), url: currentUrl(), clicked })
          return result
        },
        'run_js',
        true
      )
    }
  )

  const uploadFile = tool(
    'upload_file',
    '활성 탭의 <input type=file> 에 이 PC 의 로컬 파일을 넣는다. selector 는 CSS 셀렉터(숨겨진 input 도 가능), ' +
      'paths 는 절대 경로 목록. 파일을 고르는 대화상자는 열리지 않는다.',
    { selector: z.string().min(1), paths: z.array(z.string()).min(1) },
    ({ selector, paths }) =>
      guard(
        `파일 업로드: ${selector}`,
        async () => {
          if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
          const tab = activeOr(ctx)
          if (!tab) return 'no active tab'
          // UNC(\서버\공유) 경로는 네트워크로 자격 증명이 새어 나갈 수 있어 막는다
          // 슬래시·역슬래시가 섞인 형태(/\srv)도 윈도우에서는 UNC 가 되므로 원본과 정규화 결과를 모두 본다
          const files = paths.map((p) => (isAbsolute(p) ? resolvePath(p) : p))
          if (paths.some((p) => UNC.test(p)) || files.some((p) => UNC.test(p))) return 'UNC 경로 불가'
          for (const p of files) {
            const st = isAbsolute(p) ? await fsp.stat(p).catch(() => null) : null
            if (!st || !st.isFile()) return `파일 없음: ${p}`
          }
          // 이 PC 의 파일을 웹사이트로 내보내는 도구라 권한 모드와 무관하게 항상 확인한다
          const ok = await ctx.confirm(`파일 업로드: ${files.join(', ')} → ${selector}`, 'danger')
          if (!ok) return 'denied by user'
          const wc = tab.view.webContents
          ensureDebuggerAttached(wc)
          keepDebuggerAttached(wc)
          const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: 0 })
          const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', {
            nodeId: root.nodeId,
            selector
          })
          if (!nodeId) return `셀렉터 없음: ${selector}`
          try {
            await wc.debugger.sendCommand('DOM.setFileInputFiles', { files, nodeId })
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            // 입력 칸이 아닌 노드일 때만 그렇게 알리고, 나머지는 원인을 그대로 돌려준다
            if (/input|file/i.test(message)) return `file input 아님: ${selector}`
            return `업로드 실패: ${message}`
          }
          return JSON.stringify({ ok: true, files: files.length })
        }
      )
  )

  const setDownloadDir = tool(
    'set_download_dir',
    '웹페이지가 시작한 다운로드를 저장할 폴더(절대 경로)를 정한다. 없으면 만든다. 정하기 전에는 모든 다운로드가 막힌다.',
    { path: z.string().min(1) },
    ({ path }) =>
      guard(`다운로드 폴더: ${path}`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        if (!isAbsolute(path)) return `절대 경로가 아님: ${path}`
        const dir = resolvePath(path)
        // 이후 모든 탭의 다운로드가 이 폴더로 저장되므로 채팅 모드에서는 확인을 받는다(브릿지는 자동 승인)
        const ok = await ctx.confirm(`다운로드 폴더 지정: ${dir}`, 'danger')
        if (!ok) return 'denied by user'
        await fsp.mkdir(dir, { recursive: true })
        const st = await fsp.stat(dir)
        if (!st.isDirectory()) return `폴더 아님: ${dir}`
        ctx.tabs.downloadDir = dir
        return JSON.stringify({ ok: true, dir })
      })
  )

  const listDownloads = tool(
    'list_downloads',
    '받은 파일 기록(최근 순, 최대 50건): file, url, state, bytes, startedAt.',
    {},
    () => guard('다운로드 목록', async () => JSON.stringify(ctx.tabs.downloads.slice(0, 50)))
  )

  const fetchUrl = tool(
    'fetch_url',
    '활성 탭의 페이지 안에서 fetch(credentials 포함)로 URL 을 받아 온다 — 같은 출처이거나 CORS 를 허용하는 URL 만 된다. ' +
      '비브라우저 요청을 막는 사이트의 이미지·파일을 받을 때 쓴다. save_to(절대 경로)를 주면 파일로 저장하고 ' +
      '{ok,bytes,type,path} 를, 없으면 {ok,bytes,type,b64} 를 돌려준다(b64 가 1MB 를 넘으면 save_to 필요). 최대 25MB.',
    { url: z.string().min(1), save_to: z.string().optional() },
    ({ url, save_to }) =>
      guard(save_to ? `파일 저장: ${save_to}` : `URL 받기: ${url}`, async () => {
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        let target: string | null = null
        if (save_to !== undefined) {
          if (UNC.test(save_to) || (isAbsolute(save_to) && UNC.test(resolvePath(save_to)))) {
            return 'UNC 경로 불가'
          }
          if (!isAbsolute(save_to)) return `절대 경로가 아님: ${save_to}`
          target = resolvePath(save_to)
          const parent = await fsp.stat(dirname(target)).catch(() => null)
          if (!parent || !parent.isDirectory()) return `폴더 없음: ${dirname(target)}`
          // 이 PC 에 파일을 쓰는 동작이라 채팅 모드에서는 확인을 받는다(브릿지는 자동 승인)
          if (ctx.mode !== 'read_only') {
            const ok = await ctx.confirm(`파일 저장: ${target}`, 'danger')
            if (!ok) return 'denied by user'
          } else {
            return READ_ONLY_REFUSAL
          }
        }
        interface FetchResult {
          error?: string
          b64?: string
          type?: string
          bytes?: number
          tooBig?: number
        }
        const script =
          `(async()=>{const r=await fetch(${JSON.stringify(url)},{credentials:'include'});` +
          `if(!r.ok)return {error:'HTTP '+r.status};const b=await r.arrayBuffer();` +
          `const u=new Uint8Array(b);if(u.length>${FETCH_MAX_BYTES})return {tooBig:u.length};let s='';` +
          `for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));` +
          `return {b64:btoa(s),type:r.headers.get('content-type')||'',bytes:u.length}})()`
        let res: FetchResult
        try {
          res = (await tab.view.webContents.executeJavaScript(script, true)) as FetchResult
        } catch (e) {
          return `fetch 실패: ${e instanceof Error ? e.message : String(e)}`
        }
        if (res.error) return res.error
        const bytes = res.bytes ?? res.tooBig ?? 0
        if (res.tooBig !== undefined || bytes > FETCH_MAX_BYTES) return `파일 너무 큼: ${bytes}`
        const b64 = res.b64 ?? ''
        const type = res.type ?? ''
        if (target) {
          await fsp.writeFile(target, Buffer.from(b64, 'base64'))
          return JSON.stringify({ ok: true, bytes, type, path: target })
        }
        if (b64.length > FETCH_INLINE_B64_MAX) return `save_to 필요: ${bytes} bytes`
        return JSON.stringify({ ok: true, bytes, type, b64 })
      })
  )

  const wait = tool(
    'wait',
    'Wait up to 5000 ms for the page to settle.',
    { ms: z.number().int().min(100).max(5000) },
    ({ ms }) =>
      guard(`대기 ${ms}ms`, async () => {
        await new Promise((r) => setTimeout(r, ms))
        return 'ok'
      })
  )

  const newTab = tool(
    'new_tab',
    'Open a new tab (optionally with profile name and mobile mode) and make it active.',
    { url: z.string().optional(), profile: z.string().optional(), mobile: z.boolean().optional() },
    (o) =>
      guard(`새 탭 ${o.profile ?? ''}`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        // 내부 페이지(samba://…)는 AI 도구로 열 수 없다
        if (o.url && isInternalUrl(o.url)) return `${BLOCKED_URL_MESSAGE} (${o.url})`
        // url 을 안 주면 빈 페이지로 연다(기본값이 내부 페이지일 수 있어 AI 경로는 분리한다)
        const t = ctx.tabs.create({ ...o, url: o.url ?? 'about:blank' })
        return `ok: tab ${t.id}`
      })
  )

  const listTabs = tool(
    'list_tabs',
    'List open tabs AND popup windows. kind "popup" is a separate window a tab opened ' +
      '(address search, payment); openerId says which tab opened it. ' +
      'Call switch_tab with its id to work inside a popup.',
    {},
    () => guard('탭 목록', async () => JSON.stringify(targetList()), undefined, true)
  )

  const switchTab = tool(
    'switch_tab',
    'Activate a tab, or step into a popup window, by id (see list_tabs). ' +
      'When you are done inside a popup, call switch_tab again with the opener tab id.',
    { id: z.string() },
    ({ id }) =>
      guard(
        '탭 전환',
        async () => {
          const target = targetList().find((t) => t.id === id)
          if (!target) return `not found: no tab or popup with id ${id}`
          focusTargetOf(ctx.tabs, id)
          return `ok: now working in ${target.kind} ${id}. targets: ${JSON.stringify(targetList())}`
        },
        'switch_tab'
      )
  )

  const closeTab = tool(
    'close_tab',
    'Close a tab or a popup window by id (see list_tabs).',
    { id: z.string() },
    ({ id }) =>
      guard('탭 닫기', async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const target = targetList().find((t) => t.id === id)
        if (!target) return `not found: no tab or popup with id ${id}`
        closeTargetOf(ctx.tabs, id)
        return `ok: closed ${target.kind} ${id}. targets: ${JSON.stringify(targetList())}`
      })
  )

  // 프로필 하나의 특정 사이트 쿠키만 지운다 — 그 프로필 세션만 사이트가 차단 화면을 띄울 때 쓴다
  // (실기 2026-10-01: edelvise06 프로필만 www.ssg.com 차단, 기본 프로필은 정상). 지운 뒤에는 로그인이 풀린다
  const clearSiteCookies = tool(
    'clear_site_cookies',
    'Delete cookies of one site (host and its subdomains) in one profile session. Logs that profile out of the site.',
    { profile: z.string().min(1), host: z.string().min(3) },
    ({ profile, host }) =>
      guard(`쿠키 지우기 ${profile}`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const site = (normalizeHost(host) || host).replace(/^www\./, '').toLowerCase()
        if (!site.includes('.')) return `error: host 가 도메인이 아니다: ${host}`
        const ses = ctx.tabs.sessionForProfile(profile)
        const all = await ses.cookies.get({})
        const hit = all.filter((c) => {
          const d = String(c.domain ?? '').replace(/^\./, '').toLowerCase()
          return d === site || d.endsWith(`.${site}`)
        })
        for (const c of hit) {
          const d = String(c.domain ?? '').replace(/^\./, '')
          await ses.cookies.remove(`https://${d}${c.path ?? '/'}`, c.name)
        }
        return `ok: removed ${hit.length} cookies of ${site} in profile ${profile}`
      })
  )

  const listAccounts = tool(
    'list_accounts',
    'List saved accounts for a host (usernames are masked). Use it to pick an account label for fill_secret/login.',
    { host: z.string().optional() },
    ({ host }) =>
      guard('계정 목록', async () => {
        const v = ctx.vault
        if (!v) return JSON.stringify({ vaultLocked: true, accounts: [] })
        // 현재 탭 호스트를 모르면 전체 계정으로 폴백하지 않는다
        const target = currentHost()
        if (!target) {
          return JSON.stringify({ accounts: [], note: 'host unknown' })
        }
        // host 인자는 현재 탭 호스트(또는 같은 등록 도메인)로만 제한한다 — 모델이 임의 호스트를
        // 넣어 저장된 계정 전체를 훑는 것(열거)을 막되, nid.naver.com 처럼 같은 사이트의
        // 다른 서브도메인에 저장된 계정은 허용한다
        if (host) {
          const h = normalizeHost(host) || host
          if (h !== target && !sameRegistrableDomain(h, target)) {
            return JSON.stringify({ accounts: [], note: HOST_MISMATCH })
          }
        }
        // 접근 정책 never·제외 도메인은 vaultGate 와 같은 기준으로 즉시 거부한다(계정 열거 자체를 막는다)
        if (globalPolicy() === 'never') return VAULT_ACCESS_NEVER
        if (isHostExcluded(target)) return LIST_ACCOUNTS_HOST_EXCLUDED
        const state = v.state()
        if (state === 'uninitialized') {
          return JSON.stringify({ accounts: [], note: VAULT_NOT_SET_UP })
        }
        // 사용자명은 비밀값이 아니므로 잠겨 있어도 목록 자체는 보여 준다
        const accounts = v.listAccounts(target).map((a) => ({
          label: a.label,
          username: maskUsername(a.username),
          types: a.itemTypes,
          // 결제 비밀번호가 있는 결제 제공자(site·musinsapay·toss·kakao·naver·payco …) — 하네스가
          // "결제 가능한 수단"만 견적 후보로 남기는 데 쓴다
          payments: a.paymentProviders ?? [],
          // 키마스터에서 사용자가 정한 결제 우선순위(1 = 먼저). 없으면 null
          priority: payPriorityOf(a.tags),
          tags: visibleTags(a.tags)
        }))
        if (state !== 'unlocked') return JSON.stringify({ vaultLocked: true, accounts })
        return JSON.stringify(accounts)
      })
  )

  const fillSecret = tool(
    'fill_secret',
    'Fill a saved secret (password, card number, ...) into input [n] without ever revealing its value. ' +
      'Use field for a specific field such as "card.number". ' +
      'For itemType "password" (a payment password) pass provider to say which checkout it is: ' +
      'site when the site pays with its own money such as 무신사머니 or SSG머니, ' +
      'musinsapay for 무신사페이 when the user saved a separate password for it (otherwise follow the playbook - many users share one password with site), ' +
      'toss for 토스페이, kakao for 카카오페이, naver for 네이버페이, payco for 페이코. ' +
      'When a pay popup (pay.toss.im, PAYCO ...) asks for the phone number or birth date, those are saved on ' +
      'that payment item: itemType "password", the provider, field "payment.phone" or "payment.birth" ' +
      '(format "digits" / "yymmdd"). The user’s own contact number for other forms (e.g. a shipping ' +
      'address) is itemType "identity", field "identity.phone" - it may be saved once as a global item.',
    {
      elementId: z.number().int(),
      itemType: z.enum(ITEM_TYPES),
      field: z.string().optional(),
      accountLabel: z.string().optional(),
      provider: z
        .enum(PAYMENT_PROVIDER_NAMES)
        .optional()
        .describe('payment method for itemType "password"'),
      dryRunDigits: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe(
          'DRY RUN on a payment-password keypad: press only this many digits, then close the payment window. ' +
            'Nothing is paid - the tool answers "refused: DRY_RUN". Pass it only when the user asked to test the keypad.'
        ),
      format: z
        .enum(FILL_FORMATS)
        .optional()
        .describe(
          'reshape the saved value for this input: yymmdd (birth date as 6 digits, e.g. 910101), yyyymmdd, or digits (strip hyphens/spaces from a phone or card number)'
        )
    },
    ({ elementId, itemType, field, accountLabel, provider, format, dryRunDigits }) =>
      guard(`입력: ${itemType}${field ? `.${field}` : ''} (#${elementId})`, async () => {
        if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
        const tab = activeOr(ctx)
        if (!tab) return 'no active tab'
        // 웹 결제 키패드: 입력칸이 아니라 숫자 버튼이다 — 앱이 키마스터 값을 눌러 넣는다.
        // 결제 비밀번호가 아닌 항목을 키패드 화면에서 부르면 넘긴다(넣을 곳이 없다)
        if (await secretKeypadGate.check(tab)) {
          if (itemType !== 'password') return await keypadHandoff(tab)
          return await keypadEnter(tab, accountLabel, provider, dryRunDigits)
        }
        const host = currentHost(tab)
        // 평문(http) 페이지에는 비밀값을 절대 채우지 않는다(네트워크 도청·다운그레이드 방어)
        const blocked = gateRefusal(currentUrl(tab))
        if (blocked) return blocked
        const available = vaultAvailable()
        if (typeof available === 'string') return available
        // 계정을 먼저 특정해야 계정별 접근 정책을 적용할 수 있다.
        // 계정 목록 조회는 값(비밀번호)을 건드리지 않으므로 잠금 상태에서도 안전하다.
        // 결제 관련 항목(신원정보·카드·결제 비밀번호)은 PG 결제창(토스·ePAY 팝업)에서 불리므로,
        // 그 창의 호스트로 못 찾으면 창을 연 사이트(opener 사슬)의 계정을 쓴다
        const direct = resolveAccount(available.listAccounts(host), accountLabel, tab.profile)
        const viaOpener =
          direct === null && PAYMENT_POPUP_ITEM_TYPES.includes(itemType)
            ? keypadAccount(available, keypadAccountHosts(tab), accountLabel, tab.profile, itemType)
            : null
        const account = direct ?? viaOpener
        if (!account) return ACCOUNT_NOT_FOUND
        // 항목별 agentAccess 가 전역 정책을 override 한다
        const gate = await applyPolicy(
          available,
          effectiveAccess(account.agentAccess, globalPolicy())
        )
        if (typeof gate === 'string') return gate
        const v = gate
        // 비밀번호류는 대상 요소가 실제 비밀 입력칸(type=password)일 때만 채운다.
        // 최신 스냅샷을 신뢰하지 않고, 매번 페이지에서 직접 확인한다
        // 기본 필드(value = 비밀번호 자체)만 해당한다 — 결제 항목의 부가 필드(payment.phone·payment.birth)는
        // 결제창의 평범한 입력칸에 들어간다
        const isMainSecret = (field ?? DEFAULT_FIELD_KEY) === DEFAULT_FIELD_KEY
        if (SECRET_TARGET_ITEM_TYPES.includes(itemType) && isMainSecret) {
          const isSecret = await pageBridge.isSecretField(tab, elementId)
          if (!isSecret) return NOT_A_SECRET_FIELD
        }
        // guard 모드에서 결제 비밀번호·카드는 사용자 확인을 한 번 더 받는다
        if (ctx.mode === 'guard' && CONFIRM_ITEM_TYPES.includes(itemType)) {
          const ok = await ctx.confirm(`키마스터 입력: ${itemType}`, 'danger')
          if (!ok) return 'denied by user'
        }
        const fieldKey = field ?? DEFAULT_FIELD_KEY
        // 결제 비밀번호는 계정당 여러 개다 — 못 좁히면 채우지 않고 되묻게 한다
        if (itemType === 'password') {
          // 네이버페이 창은 반드시 고른 네이버 계정으로 로그인돼 있어야 한다
          const naverCheck = await verifyNaverPayAccount(v, account.id, tab)
          if (naverCheck) return naverCheck
          const found = v.getPaymentSecretForFill({
            accountId: account.id,
            ...(provider === undefined ? {} : { provider }),
            fieldKey,
            ...(ctx.jobId === undefined ? {} : { jobId: ctx.jobId })
          })
          if (found.reason === 'ambiguous') return PAYMENT_PROVIDER_AMBIGUOUS
          if (found.value === null) {
            return fieldKey === DEFAULT_FIELD_KEY
              ? `not found: no payment password${provider ? ` (${provider})` : ''} saved for this account`
              : `not found: no ${fieldKey} saved in the ${provider ?? ''} payment item - skip this pay method`
          }
          const shaped = formatFillValue(found.value, format)
          if (shaped === null)
            return `refused: saved password.${fieldKey} cannot be shaped as ${format}`
          const movedPay = viaOpener ? null : verifyFillTarget(account, tab)
          if (movedPay) return movedPay
          return await pageBridge.fillValue(tab, elementId, shaped)
        }
        const raw =
          v.getSecretForFill(account.id, itemType, fieldKey, ctx.jobId) ??
          // 결제창(토스·페이코…)이 묻는 휴대폰·생년월일은 그 결제 수단 항목에 적어 두는 값이다.
          // 모델이 신원정보(identity)로만 찾다 멈추지 않게, 결제창 호스트로 수단을 짐작해 거기서도 찾는다
          paymentIdentityFallback(v, account.id, itemType, fieldKey, currentUrl(tab), ctx.jobId)
        if (raw === null) return `not found: no ${itemType}.${fieldKey} saved for this account`
        const value = formatFillValue(raw, format)
        if (value === null)
          return `refused: saved ${itemType}.${fieldKey} cannot be shaped as ${format}`
        // 확인 대기 사이에 페이지가 옮겨 갔을 수 있어 채우기 직전에 다시 검증한다.
        // 결제창(opener 사슬로 찾은 계정)은 창을 연 사이트가 계정 도메인이면 통과시킨다
        const moved = viaOpener ? null : verifyFillTarget(account, tab)
        if (moved) return moved
        // 평문은 여기서만 존재하고 반환값·step 라벨·로그 어디에도 남기지 않는다
        const filled = await pageBridge.fillValue(tab, elementId, value)
        if (filled !== 'ok') return filled
        return 'ok'
      })
  )

  const login = tool(
    'login',
    'Sign in to the current site with a saved account. Never ask the user for a password.',
    { accountLabel: z.string().optional() },
    ({ accountLabel }) => {
      let label = '로그인'
      return guard(
        () => label,
        async () => {
          if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
          const tab = activeOr(ctx)
          if (!tab) return 'no active tab'
          const host = currentHost(tab)
          // 평문(http) 로그인 페이지에는 비밀번호를 채우지 않는다
          const blocked = gateRefusal(currentUrl(tab))
          if (blocked) return blocked
          const available = vaultAvailable()
          if (typeof available === 'string') return available
          label = `로그인: ${host}`
          // 이미 로그인돼 있으면 다시 로그인하지 않는다 — 재로그인은 세션을 새로 만들어
          // 캡차·추가 인증을 불러오기 때문이다. 폼이 없을 때만 상태 힌트를 본다
          const first = await pageBridge.findLoginFields(tab)
          let verified: LoginFieldsResult | undefined
          if (first.stage === 'none') {
            try {
              const hint = await pageBridge.signedInHint(tab)
              if (hint.signedIn) {
                // 마이페이지 류만 근거면(약한 근거) 알려진 로그인 URL 로 가서 확인한다 — 로그아웃 상태에서도
                // 그 링크를 보이는 사이트가 있다(실기: 무신사 홈 "마이 페이지로 이동" → 로그인 건너뜀 →
                // 구매하기가 로그인 페이지로 감). 로그인 페이지에 폼이 나오면 로그인 전이다
                if (hint.weak && knownLoginUrl(host) !== undefined) {
                  verified = await findLoginFieldsWithFallback(ctx.tabs, tab, host, first)
                }
                // 확인하러 간 곳이 로그인 전 화면이면(로그인 링크만 보임 등) 로그인된 게 아니다
                // (실기: 29CM 홈 "마이페이지" → 로그인 방법 선택 화면이라 칸이 없어 "이미 로그인"으로 잘못 답함)
                // (URL 로는 가리지 않는다 — 29CM 는 로그인된 상태에서도 /mypage/login 에 머문다)
                const stillOut =
                  verified !== undefined &&
                  verified.stage === 'none' &&
                  !(await pageBridge.signedInHint(tab)).signedIn
                if (stillOut) return 'fields not found: navigate to the login page first'
                if (!verified || verified.stage === 'none') {
                  label = `이미 로그인됨: ${host}`
                  return `${ALREADY_SIGNED_IN} (${hint.matched})`
                }
              }
            } catch {
              // 힌트를 못 읽으면 평소대로 로그인 절차를 계속한다
            }
          }
          // 폼이 없으면 알려진 로그인 URL 이동 → 페이지 내 로그인 링크 클릭까지 한 번에 시도한다
          let fields = verified ?? (await findLoginFieldsWithFallback(ctx.tabs, tab, host, first))
          if (fields.stage === 'none') {
            return 'fields not found: navigate to the login page first'
          }
          // 폴백(알려진 로그인 URL 이동·로그인 링크 클릭)으로 평문 페이지나 다른 도메인에
          // 내려섰을 수 있다. 29cm → musinsa 통합 로그인처럼 다른 등록 도메인으로 넘어가는
          // 정상 흐름이 있으므로, 막는 대신 "옮겨 간 도메인의 계정"으로 다시 조회한다
          const loginHost = currentHost(tab)
          const movedBlocked = gateRefusal(currentUrl(tab))
          if (movedBlocked) return movedBlocked
          label = `로그인: ${loginHost}`
          if (wrongPasswordHosts.has(loginHost)) return LOGIN_WRONG_PASSWORD(loginHost)
          // 라벨을 안 주면 탭 프로필과 같은 라벨의 계정을 자동으로 고른다(계정 순회 지원)
          // 결제 앱 사이트(naver.com·payco …)에서는 프로필 이름으로 계정을 고르지 않는다 — 결제창은 쇼핑몰 계정에
          // 연결된 앱 계정(linkedAppAccount)으로만, 그 밖은 라벨을 준 경우만. 실기 2026-09-28: 라벨 없이 부르자 프로필
          // buyer03 과 이름이 같은 네이버 계정(결제 비밀번호 없음)으로 로그인됐다
          const payAppHost = Object.values(PAYMENT_PROVIDER_ACCOUNT_HOST).some((h) =>
            sameRegistrableDomain(loginHost, h)
          )
          const linked = linkedAppAccount(available, tab, loginHost, accountLabel)
          // 결제창(팝업)에서만 막는다 — 일반 탭의 프로필 이름 폴백(계정 순회)은 그대로 둔다
          if (!linked && payAppHost && !accountLabel && tab.openerId) {
            return `${ACCOUNT_NOT_FOUND}: payment popup — no linked app account; pass accountLabel`
          }
          const account =
            // 결제창 안의 네이버·페이코 로그인이면 결제창을 연 쇼핑몰 계정이 연결해 둔 앱 계정으로 로그인한다
            linked ??
            resolveAccount(available.listAccounts(loginHost), accountLabel, tab.profile) ??
            // 앞 호출에서 이미 통합 로그인 화면으로 넘어와 있어도(host === loginHost) 라벨 @ 앞부분으로 짝을 찾는다
            movedHostAccount(
              loginHost !== host ? available.listAccounts(host) : [],
              available.listAccounts(loginHost),
              accountLabel ?? tab.profile
            )
          if (!account) return ACCOUNT_NOT_FOUND
          const gate = await applyPolicy(
            available,
            effectiveAccess(account.agentAccess, globalPolicy())
          )
          if (typeof gate === 'string') return gate
          const v = gate
          label = `로그인: ${loginHost} (${account.label})`
          // 2단계 로그인 1단계(아이디 화면): 아이디만 채워 제출한 뒤 비밀번호 화면을 다시 탐지한다
          if (fields.stage === 'username-only' && fields.username !== undefined) {
            const idFilled = await pageBridge.typeLogin(tab, fields.username, account.username)
            if (idFilled !== 'ok') return idFilled
            if (ctx.vaultAutoSubmit === false) {
              return 'filled: submit is disabled by setting; ask the user to press login'
            }
            await keepSignedIn(tab, fields.submit ?? fields.username)
            const idSubmitted = await pageBridge.submitLogin(
              tab,
              fields.submit ?? fields.username,
              fields.submit !== undefined
            )
            if (idSubmitted !== 'ok') return idSubmitted
            await pageBridge.waitForLoad(tab)
            // 아이디 제출로 페이지가 옮겨 갔을 수 있어 https·등록 도메인을 다시 확인한다
            const moved = verifyFillTarget(account, tab)
            if (moved) return moved
            fields = await pageBridge.findLoginFields(tab)
          }
          if (fields.password === undefined) {
            return 'fields not found: navigate to the login page first'
          }
          const password = v.getSecretForFill(account.id, 'login', DEFAULT_FIELD_KEY, ctx.jobId)
          if (password === null) return 'not found: no login password saved for this account'
          // 사용자명은 비밀값이 아니므로 평문 그대로 채운다. 실패해도 전파한다
          if (fields.username !== undefined) {
            const userFilled = await pageBridge.typeLogin(tab, fields.username, account.username)
            if (userFilled !== 'ok') return userFilled
          }
          // 비밀번호를 넣기 직전 마지막 재검증 — 이 사이에 페이지가 바뀌었을 수 있다
          const beforeFill = verifyFillTarget(account, tab)
          if (beforeFill) return beforeFill
          const pwFilled = await pageBridge.typeLogin(tab, fields.password, password)
          if (pwFilled !== 'ok') return pwFilled
          // 자동 제출이 꺼져 있으면 채우기만 하고 제출은 사용자에게 맡긴다
          if (ctx.vaultAutoSubmit === false) {
            return 'filled: submit is disabled by setting; ask the user to press login'
          }
          // 제출 직전 "로그인 상태 유지"를 켠다 — 세션이 오래가면 재로그인·캡차가 줄어든다
          await keepSignedIn(tab, fields.submit ?? fields.password)
          const submitted = await pageBridge.submitLogin(
            tab,
            fields.submit ?? fields.password,
            fields.submit !== undefined
          )
          if (submitted !== 'ok') return submitted
          await pageBridge.waitForLoad(tab)
          // 사이트가 로그인 실패를 대화상자로 알렸으면(비밀번호 불일치) 재시도를 막고 사람에게 넘긴다
          await new Promise((resolve) => setTimeout(resolve, LOGIN_DIALOG_WAIT_MS))
          const dialog = ctx.tabs.takeDialogMessage?.() ?? null
          if (dialog && WRONG_PASSWORD_RE.test(dialog)) {
            wrongPasswordHosts.add(loginHost)
            return `${LOGIN_WRONG_PASSWORD(loginHost)} (${formatDialogNote(dialog)})`
          }
          // 첫 클릭이 먹지 않는 사이트(실기: 패션플러스 — 같은 화면에서 로그인 버튼을 한 번 더 누르면 로그인됨):
          // 대화상자 없이 같은 폼(같은 비밀번호 칸)이 그대로 남아 있으면 제출을 한 번만 더 누른다.
          // 두 번째는 DOM 클릭 — 숨김 탭(작업 레인)에는 진짜 마우스 클릭이 닿지 않아
          // 버튼 onclick 로그인(슈마커 chk_Login)이 아예 불리지 않았다(실기 2026-09-26)
          if (!dialog && fields.submit !== undefined) {
            const again = await pageBridge.findLoginFields(tab)
            if (again.stage === fields.stage && again.password === fields.password) {
              await pageBridge.submitLogin(tab, fields.submit, false)
              await pageBridge.waitForLoad(tab)
            }
          }
          // 사이트가 캡차·2FA 를 요구하면 사용자에게 넘기고 처리될 때까지 기다린다
          const handed = await captchaHandoff(tab)
          if (handed) return handed
          const submittedNote = 'submitted: check the page for success or captcha/2FA'
          return dialog
            ? `${formatDialogNote(dialog)}
${submittedNote}`
            : submittedNote
        }
      )
    }
  )

  // progress 도 guard 를 거치지 않는다 — 진행 상황을 알리느라 정작 일할 호출이 줄면 안 된다.
  // 진행 로그(step)도 남기지 않는다(도구 호출 수가 부풀지 않게). 화면에는 진행 배지로만 뜬다
  const progress = tool(
    'progress',
    'Report how far along a multi-item task is, so the user can watch. Call it when you start and after each item.',
    {
      done: z.number().int().describe('items finished so far'),
      total: z.number().int().describe('items in total'),
      label: z.string().optional().describe('what is being worked on right now')
    },
    async ({ done, total, label }) => {
      const bad = validateProgress(done, total)
      if (bad) return text(bad)
      const trimmed = label?.trim().slice(0, PROGRESS_LABEL_MAX)
      ctx.onProgress?.(trimmed ? { done, total, label: trimmed } : { done, total })
      return text(`ok: ${done}/${total}`)
    }
  )

  // 사이트 기억에 한 줄 남긴다. 저장 전에 비밀값·개인정보를 지우는 일은 서비스가 한다.
  // 지우기(forget)는 도구로 열지 않는다 — 설정 화면에서만 지운다
  const rememberSite = tool(
    'remember_site',
    'Remember one short lesson about this site for next time (e.g. "the 구매하기 button only ' +
      'opens with focus+Enter", "the address popup is a separate window"). Call it at most a ' +
      'couple of times per task, and never store personal data, addresses or secrets.',
    {
      host: z.string().describe('site host, e.g. musinsa.com'),
      note: z.string().describe('one short sentence, no personal data')
    },
    ({ host, note }) =>
      guard(`사이트 기억: ${host}`, async () =>
        ctx.siteMemory ? ctx.siteMemory.remember(host, note) : 'refused: site memory is off'
      )
  )

  // 한 번 통한 run_js 코드를 매개변수째 저장한다. 다음 실행은 run_script 한 번으로 같은 손놀림을 재생한다
  const saveScript = tool(
    'save_script',
    'Save a run_js snippet that just WORKED so later runs can replay it with one run_script call ' +
      '(no code tokens, fewer tool calls). Save steps you will need again for other orders/items: ' +
      'searching a list, reading a row, filling a record form, reading totals. Take everything that ' +
      'changes between runs from the global `args` object (args.orderNo, args.cost …) — never hardcode ' +
      'order numbers, amounts or element ids that change; find elements by text inside the code. ' +
      'Return a small JSON result the caller can verify. Saving under an existing name replaces it.',
    {
      name: z.string().describe('snake_case, e.g. samba_find_order'),
      host: z.string().optional().describe('main site host, e.g. samba-wave.vercel.app'),
      description: z.string().describe('what it does and what it returns, one or two sentences'),
      params: z
        .array(z.string())
        .optional()
        .describe('args it reads, e.g. ["orderNo — 상품주문번호", "cost — 실구매가 숫자"]'),
      code: z.string().max(RUN_JS_MAX_CODE).describe('the run_js body; reads inputs from args')
    },
    (input) =>
      guard(`스크립트 저장: ${input.name}`, async () =>
        ctx.scripts ? ctx.scripts.save(input) : 'refused: saved scripts are off'
      )
  )

  // 저장된 스크립트를 인자와 함께 실행한다. run_js 와 같은 샌드박스·같은 다리를 쓴다
  const runScript = tool(
    'run_script',
    'Run a saved script by name with args (see "Saved scripts" in the system prompt). Same sandbox and ' +
      'page/tabs API as run_js, up to 75s. Check the returned result against the page before relying on it.',
    {
      name: z.string(),
      // 객체 스키마(z.record·z.unknown)는 SDK 의 도구 목록 변환에서 실패해 도구 전체가 빠진다(실기) —
      // 다른 도구처럼 문자열만 받는다
      args: z
        .string()
        .optional()
        .describe('JSON object string with the values the script reads, e.g. {"orderNo":"…"}')
    },
    ({ name, args }) =>
      guard(
        `스크립트 실행: ${name}`,
        async () => {
          if (!ctx.scripts) return 'refused: saved scripts are off'
          if (ctx.mode === 'read_only') return READ_ONLY_REFUSAL
          const script = ctx.scripts.find(name)
          if (!script) return `refused: no saved script named "${name}"`
          const parsedArgs = parseScriptArgs(args)
          if (parsedArgs === null) return 'refused: args must be a JSON object string'
          const result = await runSandbox(script.code, makeRunJsBridge(), {
            args: parsedArgs,
            totalTimeoutMs: RUN_SCRIPT_TOTAL_TIMEOUT_MS
          })
          ctx.scripts.ran(name, !isScriptFailure(result))
          return result
        },
        'run_js',
        true
      )
  )

  // 저장된 플레이북을 읽는다. id 를 주면 절차 본문까지, 아니면 이름·트리거 목록만 준다.
  // 본문이 길어 목록에 다 싣지 않는다(9,000자 넘는 절차가 있다)
  const listPlaybooks = tool(
    'list_playbooks',
    'List the saved playbooks (name, triggers, size). Pass an id to read that playbook’s full ' +
      'instructions — do that before replacing them.',
    { id: z.string().optional().describe('playbook id from a previous list_playbooks call') },
    ({ id }) =>
      guard(
        '플레이북 읽기',
        async () => {
          if (!ctx.playbooks) return 'refused: playbooks are off'
          const rows = ctx.playbooks.list()
          if (id === undefined) {
            return JSON.stringify(
              rows.map((p) => ({
                id: p.id,
                name: p.name,
                triggers: p.triggers,
                enabled: p.enabled,
                chars: p.instructions.length
              }))
            )
          }
          const found = rows.find((p) => p.id === id)
          if (!found) return 'refused: no playbook with that id'
          return JSON.stringify({
            id: found.id,
            name: found.name,
            triggers: found.triggers,
            instructions: found.instructions
          })
        },
        undefined,
        true
      )
  )

  // 절차 본문만 바꾼다. 트리거·이름은 도구로 열지 않는다 —
  // 트리거가 바뀌면 이 플레이북이 다른 요청까지 끌어오고, 그 변화는 사용자 눈에 잘 띄지 않는다.
  // 저장 전에는 권한 모드와 무관하게 확인 카드를 1회 띄운다(페이지 글이 절차를 심는 것을 막는다)
  const updatePlaybook = tool(
    'update_playbook',
    'Change a saved playbook’s instructions. Use append to add a step you just learned, or ' +
      'instructions to replace the whole text (read it with list_playbooks first). The user has ' +
      'to approve the change on a card before it is saved. Name and triggers cannot be changed here.',
    {
      id: z.string().describe('playbook id from list_playbooks'),
      append: z.string().optional().describe('text to add at the end, e.g. one new step'),
      instructions: z.string().optional().describe('full replacement text')
    },
    ({ id, append, instructions }) =>
      guard('플레이북 수정', async () => {
        if (!ctx.playbooks) return 'refused: playbooks are off'
        if ((append === undefined) === (instructions === undefined)) {
          return 'refused: pass exactly one of append or instructions'
        }
        const found = ctx.playbooks.list().find((p) => p.id === id)
        if (!found) return 'refused: no playbook with that id'
        const addition = append?.trim()
        if (append !== undefined && (addition === undefined || addition === '')) {
          return 'refused: append is empty'
        }
        const next =
          addition === undefined
            ? (instructions as string)
            : `${found.instructions.trimEnd()}\n\n${addition}`
        if (next.trim() === '') return 'refused: instructions are empty'
        if (next.length > PLAYBOOK_INSTRUCTIONS_MAX) {
          return `refused: playbook would be ${next.length} chars (max ${PLAYBOOK_INSTRUCTIONS_MAX})`
        }
        if (next === found.instructions) return 'ok: no change'
        // 확인 카드에는 바뀌는 대목만 싣는다 — 덧붙이기는 덧붙일 글, 통째 교체는 길이 변화
        const preview =
          addition === undefined
            ? `전체 교체 (${found.instructions.length}자 → ${next.length}자)`
            : addition.slice(0, PLAYBOOK_PREVIEW_MAX)
        const ok = await ctx.confirm(`플레이북 수정: ${found.name}\n${preview}`, 'danger')
        if (!ok) return 'denied by user'
        const saved = ctx.playbooks.update(id, next)
        return saved ? `ok: updated (${next.length} chars)` : 'error: could not save the playbook'
      })
  )

  // done 은 guard 를 거치지 않으므로 도구 호출 상한(tick)에 계산되지 않는다.
  // 상한에 도달했을 때 "done 으로 마무리하라"고 안내하기 때문에, 마무리 호출까지 막으면 안 된다
  const done = tool(
    'done',
    'Finish the task with a short summary for the user.',
    { summary: z.string() },
    async ({ summary }) => {
      if (ctx.finalConfirm) {
        const ok = await ctx.confirm(summary, 'finish')
        if (!ok) {
          ctx.onStep(`계속 진행: ${summary.slice(0, 60)}`, true)
          return text(CONTINUE_INSTRUCTION)
        }
      }
      ctx.onStep(`완료: ${summary.slice(0, 60)}`, true)
      return text(`DONE: ${summary}`)
    }
  )

  const tools = [
    getPage,
    findElements,
    screenshot,
    createOcrTool(ctx),
    navigate,
    click,
    typeTool,
    select,
    scroll,
    dismissOverlay,
    runJs,
    uploadFile,
    setDownloadDir,
    listDownloads,
    fetchUrl,
    wait,
    newTab,
    listTabs,
    switchTab,
    closeTab,
    clearSiteCookies,
    listAccounts,
    fillSecret,
    login,
    progress,
    ...(ctx.siteMemory ? [rememberSite] : []),
    ...(ctx.scripts ? [saveScript, runScript] : []),
    ...(ctx.playbooks ? [listPlaybooks, updatePlaybook] : []),
    done,
    // 폰이 한 대도 붙어 있지 않으면 폰 도구를 아예 내보내지 않는다 —
    // 목록에 있으면 모델이 웹 작업 중에도 phone_tap 을 부른다(실기에서 관찰)
    ...(ctx.phone && hasConnectedPhone(ctx.phone) ? createPhoneTools(ctx.phone) : []),
    ...(ctx.pay ? [createPayTool(ctx.pay)] : [])
  ]
  // 서버 객체에 도구 배열을 그대로 얹어 둔다 — 브릿지 도구 세션(runner.ts 의 createToolSession)이
  // MCP 내부 필드에 기대지 않고 이 값을 그대로 읽는다.
  // 도구마다 zod 스키마 타입이 달라 SdkMcpToolDefinition<Schema> 그대로는 하나의 배열 타입으로
  // 못 묶는다(제네릭 분산) — 브릿지가 실제로 쓰는 부분(이름·핸들러)만 남긴 타입으로 한 번만 캐스팅한다
  return Object.assign(createSdkMcpServer({ name: 'samba', version: '0.1.0', tools }), {
    tools: tools as unknown as SambaMcpTool[]
  })
}

export const SAMBA_TOOL_NAMES = [
  'get_page',
  'find_elements',
  'screenshot',
  'ocr',
  'navigate',
  'click',
  'type',
  'select',
  'scroll',
  'dismiss_overlay',
  'run_js',
  'upload_file',
  'set_download_dir',
  'list_downloads',
  'fetch_url',
  'wait',
  'new_tab',
  'list_tabs',
  'switch_tab',
  'close_tab',
  'clear_site_cookies',
  'list_accounts',
  'fill_secret',
  'login',
  'progress',
  // 사이트 기억이 붙지 않은 실행에서도 이름은 허용 목록에 있어야 모델이 거부 문구를 받는다
  'remember_site',
  // 스크립트 저장소가 붙지 않은 실행에서도 이름은 허용 목록에 있어야 모델이 거부 문구를 받는다
  'save_script',
  'run_script',
  // 플레이북이 붙지 않은 실행에서도 이름은 허용 목록에 있어야 모델이 거부 문구를 받는다
  'list_playbooks',
  'update_playbook',
  'done',
  // 폰 도구가 주입되지 않은 실행에서도 이름은 허용 목록에 있어야 모델이 거부 문구를 받는다
  ...PHONE_TOOL_NAMES,
  PAY_TOOL_NAME
].map((n) => `mcp__samba__${n}`)
