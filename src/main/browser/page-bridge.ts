import { clipboard } from 'electron'
import type { WebContents, WebFrameMain } from 'electron'
import { z } from 'zod'
import type {
  KeypadCellDto,
  KeypadLayoutDto,
  KeypadSignals,
  PageElement,
  PageOverlay,
  PageSnapshot
} from '../../shared/snapshot'
import { findCodeField as pickCodeField } from '../phone/auth-flow'
import type { AgentOp } from '../../shared/agent-op'
import { callFrameOp } from './frame-channel'
import {
  decodeFrameId,
  encodeFrameId,
  mergeFrameSnapshots,
  MAX_AGENT_FRAMES,
  type FrameSnapshot
} from './frame-id'
import type { Tab } from './tab-manager'
import {
  automationBlocked,
  isAutomation,
  markMachineInput,
  withAutomationInput,
  withAutomationInputSync
} from './human-activity'

// preload 가 실행되는 격리 월드 id. Electron 의 WorldId.ISOLATED_WORLD = 999
export const ISOLATED_WORLD_ID = 999

// 페이지에서 돌아온 값은 전부 신뢰하지 않는다. AI 에 넘기기 전에 스키마로 검증한다
const elementSchema = z.object({
  id: z.number().int(),
  tag: z.string(),
  role: z.string(),
  text: z.string(),
  name: z.string().optional(),
  href: z.string().optional(),
  inputType: z.string().optional(),
  // 입력칸 현재 값(비밀 입력칸은 프리로드가 애초에 싣지 않는다). 스키마에 없으면 zod 가 조용히 버린다
  value: z.string().max(500).optional(),
  isSecret: z.boolean()
})

// 사람처럼 보이는 입력 간격(ms). 점수형 reCAPTCHA(Enterprise)는 0ms 간격 타자·순간 이동 클릭을 봇으로 본다
const HUMAN_KEY_MIN_MS = 35
const HUMAN_KEY_JITTER_MS = 60
const HUMAN_FOCUS_MS = 120
// 이 길이를 넘는 값은 키 입력 대신 클립보드 붙여넣기(글자당 35~95ms × 길이가 도구 제한 90초를 넘김)
const LONG_PASTE_CHARS = 300
const HUMAN_MOVE_MS = 45
const HUMAN_PRESS_MS = 55
const HUMAN_BEFORE_SUBMIT_MS = 350
const HUMAN_LOAD_WAIT_MS = 8000

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const snapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  elements: z.array(elementSchema),
  total: z.number().int().optional(),
  selectorError: z.string().optional()
})

// 결제 비밀번호 키패드 판정용 신호. 값은 담기지 않는다(개수·존재 여부만)
const keypadSignalsSchema = z.object({
  url: z.string(),
  text: z.string(),
  digitButtons: z.number().int(),
  pinField: z.boolean()
})

// 결제 키패드 숫자 버튼 배치. 값은 담기지 않는다(숫자 → 요소 id, 눌린 자리수만)
const keypadLayoutSchema = z
  .object({
    digits: z.array(z.object({ digit: z.string().regex(/^[0-9]$/), id: z.number().int() })),
    filled: z.number().int().nullable()
  })
  .nullable()

// 글자 없는 키패드 버튼들의 뷰포트 사각형. 값은 담기지 않는다(요소 id·좌표만)
const keypadUnlabeledSchema = z
  .array(
    z.object({
      id: z.number().int(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number()
    })
  )
  .nullable()

/** 키패드 배치(프레임 번호가 얹힌 id). 어느 프레임에 있었는지도 함께 준다 */
export interface KeypadLayout {
  /** 숫자 → 프레임 번호가 얹힌 요소 id(그대로 click 에 넘길 수 있다) */
  digits: Record<string, number>
  filled: number | null
  frameIndex: number
}

// 화면을 덮는 레이어 목록. label 은 페이지에서 온 문자열이라 길이를 잘라 쓴다
const overlaySchema = z.object({
  id: z.number().int(),
  label: z.string(),
  closeIds: z.array(z.number().int()),
  sensitive: z.boolean()
})
const overlayListSchema = z.array(overlaySchema)

/** 한 번에 모델에게 알릴 레이어 개수(프레임까지 합친 뒤) */
export const MAX_OVERLAYS = 5
/** 레이어 이름 길이 상한(페이지가 준 문자열이다) */
const OVERLAY_LABEL_MAX = 60

// 행동 도구(click/type/select/scroll/textOf)는 결과가 항상 문자열이어야 한다
const resultSchema = z.string()

// isSecretField 결과는 boolean
const boolSchema = z.boolean()

// rectOf 결과 — 요소 가운데의 뷰포트 좌표. 못 구하면 null
const pointSchema = z.object({ x: z.number(), y: z.number() }).nullable()

export interface ClickPoint {
  x: number
  y: number
}

// findLoginFields 결과 — 못 찾은 필드는 없음(undefined).
// stage 는 2단계 로그인(아이디 화면 → 비밀번호 화면) 흐름을 호출부가 구분하기 위한 값
const loginFieldsSchema = z.object({
  username: z.number().int().optional(),
  password: z.number().int().optional(),
  submit: z.number().int().optional(),
  stage: z.enum(['single', 'username-only', 'password-only', 'none']),
  confidence: z.number(),
  iframe: z.boolean()
})

export type LoginFieldsResult = z.infer<typeof loginFieldsSchema>

// 로그인 상태 힌트 — matched 는 페이지에서 온 문자열이라 길이를 잘라 쓴다
const signedInHintSchema = z.object({
  signedIn: z.boolean(),
  matched: z.string(),
  // 예전 프리로드와의 호환 — 없으면 확실한 근거로 본다
  weak: z.boolean().default(false)
})

// 캡차·2FA 징후. 푸는 것은 사용자 몫이고, 여기서는 "사람이 필요하다"만 판정한다
const captchaHintSchema = z.object({ needsUser: z.boolean(), matched: z.string() })

export type SignedInHintResult = z.infer<typeof signedInHintSchema>
export type CaptchaHintResult = z.infer<typeof captchaHintSchema>

// --- 프레임 ---------------------------------------------------------------
//
// 주소 검색(카카오 우편번호)·결제 보안 키패드는 iframe 안에 있다. preload 는 모든
// 프레임에서 돌며 프레임마다 자기 __samba 를 만든다.
//
// 메인 프레임은 webContents.executeJavaScriptInIsolatedWorld 로 바로 부르고,
// 하위 프레임은 그런 API 가 없어 frame-channel 의 IPC 통로로 동작 이름만 보내 시킨다.
//
// 프레임 번호는 framesInSubtree 순서(문서 트리 순서)를 그대로 쓴다. 한 작업 동안
// 프레임 구성이 바뀌지 않는 한 안정적이고, 바뀌면 다음 get_page 가 새 번호를 준다

/** AI 가 들여다볼 프레임인가. about:blank·빈 프레임·확장 프로그램 프레임은 뺀다 */
export function isAgentFrameUrl(url: string): boolean {
  if (!url || url === 'about:blank') return false
  return /^https?:\/\//i.test(url)
}

function frameUrl(frame: WebFrameMain): string {
  try {
    return frame.url ?? ''
  } catch {
    return ''
  }
}

/** 프레임 주소의 호스트(구분 헤더용). 못 읽으면 빈 문자열 */
export function frameHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * AI 가 다룰 하위 프레임 목록(메인 프레임은 빼고 상한까지).
 * framesInSubtree 를 갖추지 않은 대역(테스트 스텁)에서는 빈 목록이다
 */
export function agentSubFrames(wc: WebContents): WebFrameMain[] {
  try {
    const main: WebFrameMain | undefined = wc.mainFrame
    const all = main?.framesInSubtree
    if (!main || !Array.isArray(all)) return []
    return all.filter((f) => f !== main && isAgentFrameUrl(frameUrl(f))).slice(0, MAX_AGENT_FRAMES)
  } catch {
    return []
  }
}

// 결과 검증. 페이지에서 돌아온 값은 전부 신뢰하지 않는다
function verify<T>(raw: unknown, expr: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new Error(`unexpected page result for ${expr}`)
  return parsed.data
}

// 탭 안 preload(격리 월드의 __samba)를 호출하고 결과를 스키마로 검증한다(메인 프레임)
// 메인 프레임 호출 상한. 페이지가 alert/confirm 으로 멈춰 있거나 렌더러가 바쁘면
// executeJavaScriptInIsolatedWorld 는 영영 돌아오지 않는다 — 기다리다 도구 전체가 멈춘다
const MAIN_CALL_TIMEOUT_MS = 20_000

// 읽기만 하는 호출(스냅샷·글자 읽기) — 문서가 바뀌는 중이면 새 문서가 뜬 뒤 한 번 다시 읽는다.
// 클릭·입력은 다시 하지 않는다(내비게이션을 일으킨 클릭을 두 번 하면 주문이 두 번 된다)
const READ_ONLY_CALL = /^__samba\.(snapshot|textOf)\(/
// 새 문서를 기다리는 상한 — 결제 사이트 리다이렉트(롯데온 → 네이버페이) 기준
const NAV_SETTLE_MS = 15_000

function waitLoaded(wc: WebContents, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (wc.isDestroyed() || !wc.isLoading()) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      wc.off('did-finish-load', done)
      wc.off('did-fail-load', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    wc.once('did-finish-load', done)
    wc.once('did-fail-load', done)
  })
}

async function call<T>(wc: WebContents, expr: string, schema: z.ZodType<T>): Promise<T> {
  if (wc.isDestroyed()) throw new Error('page is gone')
  // 시험 대역(WebContents 흉내)은 이벤트가 없다 — 그때는 예전처럼 시간 제한만 건다
  const canWatch = typeof (wc as { on?: unknown }).on === 'function'
  const readOnly = READ_ONLY_CALL.test(expr) && canWatch
  for (let attempt = 0; ; attempt++) {
    // webContents.executeJavaScriptInIsolatedWorld 는 메인 프레임의 지정 월드에서 실행한다.
    // 실기 2026-09-28: 롯데온 주문서가 네이버페이로 넘어가는 동안 부르면 영영 돌아오지 않아 20초씩 멈췄다 —
    // 읽기 호출은 최상위 프레임 이동을 보면 바로 끊고 새 문서에서 한 번 다시 읽는다
    let timer: ReturnType<typeof setTimeout> | undefined
    let navigated = false
    const onNav = (ev: { isMainFrame?: boolean; isSameDocument?: boolean }): void => {
      if (ev.isMainFrame === false || ev.isSameDocument) return
      navigated = true
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('page did not respond (busy or blocked by a dialog)')),
        MAIN_CALL_TIMEOUT_MS
      )
    })
    const nav = new Promise<never>((_, reject) => {
      if (!canWatch) return
      const poll = setInterval(() => {
        if (navigated) {
          clearInterval(poll)
          reject(new Error('page navigated'))
        }
      }, 100)
      timeout.catch(() => clearInterval(poll))
    })
    if (canWatch) wc.on('did-start-navigation', onNav as never)
    try {
      const raw: unknown = await Promise.race([
        wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: expr }]),
        timeout,
        nav
      ])
      return verify(raw, expr, schema)
    } catch (e) {
      if (!navigated || !canWatch) throw e
      // 클릭·입력이 문서를 넘겼다 — 동작은 이미 일어났으니 결과를 '이동함'으로 돌려준다(다시 누르지 않는다).
      // 실기 2026-09-28: 롯데온 '결제하기' 클릭이 네이버페이로 넘어가며 응답이 안 와 20초 뒤 실패했다
      if (!readOnly) return verify('ok: page navigated', expr, schema)
      if (attempt >= 1) throw e
      await waitLoaded(wc, NAV_SETTLE_MS)
    } finally {
      if (timer) clearTimeout(timer)
      if (canWatch) wc.off('did-start-navigation', onNav as never)
    }
  }
}

// 특정 프레임에서 동작 하나를 시킨다(IPC 통로). 실패는 그대로 던진다
async function callFrame<T>(frame: WebFrameMain, op: AgentOp, schema: z.ZodType<T>): Promise<T> {
  return verify(await callFrameOp(frame, op), op.op, schema)
}

/**
 * id 가 가리키는 프레임에서 동작을 시킨다. opOf 는 그 프레임 안에서의 지역 id 를 받아
 * 동작을 만든다. 프레임이 사라졌으면 오류를 던진다(도구가 문구로 감싼다)
 */
async function callById<T>(
  tab: Tab,
  id: number,
  opOf: (localId: number) => AgentOp,
  schema: z.ZodType<T>
): Promise<T> {
  const wc = tab.view.webContents
  const { frameIndex, id: localId } = decodeFrameId(id)
  const op = opOf(localId)
  if (frameIndex === 0) return call(wc, opToCode(op), schema)
  if (wc.isDestroyed()) throw new Error('page is gone')
  const frame = agentSubFrames(wc)[frameIndex - 1]
  if (!frame) throw new Error(`frame ${frameIndex} is gone`)
  return callFrame(frame, op, schema)
}

/** 메인 프레임 + 살아 있는 하위 프레임에서 같은 동작을 돌린다. 실패한 프레임은 건너뛴다 */
async function callEveryFrame<T>(
  tab: Tab,
  op: AgentOp,
  schema: z.ZodType<T>
): Promise<{ main: T; frames: { index: number; host: string; value: T }[] }> {
  const wc = tab.view.webContents
  const main = await call(wc, opToCode(op), schema)
  const frames: { index: number; host: string; value: T }[] = []
  const subs = agentSubFrames(wc)
  for (let i = 0; i < subs.length; i += 1) {
    try {
      frames.push({
        index: i + 1,
        host: frameHost(frameUrl(subs[i])),
        value: await callFrame(subs[i], op, schema)
      })
    } catch {
      // preload 가 아직 안 붙었거나 프레임이 사라지면 실패한다 —
      // 그 프레임만 생략하고 나머지는 그대로 쓴다
      continue
    }
  }
  return { main, frames }
}

// 값이 code 문자열 안에 들어간다. JSON.stringify 가 이스케이프하지 않는
// U+2028/U+2029(줄 구분자)는 미리 걷어내 code 가 깨지지 않게 한다
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)]

function encodeQuery(query: string): string {
  const clean = Array.from(query)
    .filter((ch) => !LINE_SEPARATORS.includes(ch))
    .join('')
  return JSON.stringify(clean)
}

// 비밀값이 섞일 수 있는 문자열. U+2028/2029 를 직접 이스케이프해 둔다
function encodeValue(value: string): string {
  return JSON.stringify(value)
    .split(LINE_SEPARATORS[0])
    .join('\\u2028')
    .split(LINE_SEPARATORS[1])
    .join('\\u2029')
}

/** 메인 프레임용 — 동작을 격리 월드에서 실행할 __samba 호출식으로 바꾼다 */
function opToCode(op: AgentOp): string {
  switch (op.op) {
    case 'snapshot': {
      // selector 만 주는 경우도 있어 query 자리는 undefined 로 채운다
      const args =
        op.selector === undefined
          ? op.query === undefined
            ? ''
            : encodeQuery(op.query)
          : `${op.query === undefined ? 'undefined' : encodeQuery(op.query)}, ${encodeQuery(op.selector)}`
      return `__samba.snapshot(${args})`
    }
    case 'textOf':
      return `__samba.textOf(${op.id})`
    case 'click':
      return `__samba.click(${op.id})`
    case 'type':
      return `__samba.type(${op.id}, ${encodeValue(op.text)}, ${op.submit})`
    case 'select':
      return `__samba.select(${op.id}, ${encodeValue(op.value)})`
    case 'scroll':
      return `__samba.scroll(${JSON.stringify(op.dir)}${op.id === undefined ? '' : `, ${op.id}`})`
    case 'fillValue':
      return `__samba.fillValue(${op.id}, ${encodeValue(op.value)})`
    case 'submitForm':
      return `__samba.submitForm(${op.id})`
    case 'isSecretField':
      return `__samba.isSecretField(${op.id})`
    case 'rectOf':
      return `__samba.rectOf(${op.id})`
    case 'valueLength':
      return `__samba.valueLength(${op.id})`
    case 'keypadSignals':
      return '__samba.keypadSignals()'
    case 'keypadLayout':
      return '__samba.keypadLayout()'
    case 'keypadUnlabeled':
      return '__samba.keypadUnlabeled()'
    case 'pressOnce':
      return `__samba.pressOnce(${op.id})`
    case 'overlays':
      return '__samba.overlays()'
    case 'checkByLabel':
      return `__samba.checkByLabel(${encodeValue(op.text)})`
  }
}

// 진짜 키 입력(typeLogin)이 필요한 사이트 — 점수형 reCAPTCHA 가 합성 입력을 봇으로 보는 곳(실기 GS샵),
// 값만 넣으면 로그인 버튼이 먹지 않는 곳(실기 2026-09-25 페이코: 값은 채워졌는데 로그인 화면 그대로)
// 슈마커: 비밀번호 칸(NPwd)에 값만 넣으면 제출돼도 로그인되지 않았다(실기 2026-09-26)
// 현대홈쇼핑 파트너센터(Nexacro): 비밀번호 칸은 컴포넌트가 키 입력으로만 값을 받는다 — 값만 넣으면 화면에는
// 글자가 보이는데(가려지지도 않는다) 컴포넌트 값은 비어 로그인이 안 된다(실기 2026-09-29)
const HUMAN_TYPING_HOSTS = ['gsshop.com', 'payco.com', 'shoemarker.co.kr', 'partner.hmall.com']

function safeHost(wc: WebContents): string {
  try {
    const url =
      typeof wc.getURL === 'function'
        ? wc.getURL()
        : ((wc as { mainFrame?: { url?: string } }).mainFrame?.url ?? '')
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function needsHumanTyping(host: string): boolean {
  return HUMAN_TYPING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * 값을 넣는 동작이 끝나면 부른다 — 이 탭의 다음 로그인 제출은 기계가 채운 것으로 보고 저장 제안을 띄우지 않는다
 * (vault-capture). 성공·실패와 무관하게 표시한다(일부만 들어갔어도 사람이 친 값이 아니다)
 */
async function asMachineInput<T>(tab: Tab, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } finally {
    const wc = tab.view.webContents
    if (!wc.isDestroyed()) markMachineInput(wc)
  }
}

export const pageBridge = {
  // query 를 주면 라벨·name·href·placeholder 가 일치하는 요소만 나열한다(id 는 그대로)
  snapshot: async (tab: Tab, query?: string, selector?: string): Promise<PageSnapshot> => {
    const op: AgentOp = {
      op: 'snapshot',
      ...(query === undefined ? {} : { query }),
      ...(selector === undefined ? {} : { selector })
    }
    const { main, frames } = await callEveryFrame(tab, op, snapshotSchema)
    // 선택자가 잘못됐으면 프레임 합치기 전에 그대로 알린다
    if (main.selectorError !== undefined) return main
    // 아무것도 없는 프레임(광고·추적용 빈 iframe)은 목록을 흐리기만 한다
    const useful: FrameSnapshot[] = frames
      .filter((f) => f.value.elements.length > 0 || f.value.text.length > 0)
      .map((f) => ({ index: f.index, host: f.host, snapshot: f.value }))
    return mergeFrameSnapshots(main, useful)
  },
  // 요소 [id] 의 실제 페이지 텍스트. 없으면 빈 문자열
  textOf: (tab: Tab, id: number): Promise<string> =>
    callById(tab, id, (n) => ({ op: 'textOf', id: n }), resultSchema),
  click: (tab: Tab, id: number): Promise<string> =>
    callById(tab, id, (n) => ({ op: 'click', id: n }), resultSchema),
  type: (tab: Tab, id: number, text: string, submit: boolean): Promise<string> =>
    asMachineInput(tab, () =>
      callById(tab, id, (n) => ({ op: 'type', id: n, text, submit }), resultSchema)
    ),
  select: (tab: Tab, id: number, value: string): Promise<string> =>
    asMachineInput(tab, () =>
      callById(tab, id, (n) => ({ op: 'select', id: n, value }), resultSchema)
    ),
  // id 를 주면 그 요소를 품은 스크롤 상자(드롭다운 목록 등)를 그 요소가 있는 프레임에서 스크롤한다
  scroll: (tab: Tab, dir: 'up' | 'down', id?: number): Promise<string> =>
    callById(
      tab,
      id ?? 0,
      (n) => (id === undefined ? { op: 'scroll', dir } : { op: 'scroll', dir, id: n }),
      resultSchema
    ),
  // 값 주입(SECRET 허용) — 값이 code 문자열 안에 들어가므로, 실패해도 code 를 담은 오류를
  // 만들지 않도록 공용 call() 을 쓰지 않고 이 함수 안에서 직접 try/catch 한다
  fillValue: (tab: Tab, id: number, value: string): Promise<string> =>
    asMachineInput(tab, () => pageBridge.fillValueNow(tab, id, value)),
  /** fillValue 본문(기계 입력 표시 없이 부르지 말 것 — fillValue 를 쓴다) */
  fillValueNow: async (tab: Tab, id: number, value: string): Promise<string> => {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return 'page is gone'
    try {
      // JSON.stringify 는 스펙상 U+2028/U+2029(line/paragraph separator)를 이스케이프하지 않는다.
      // 현재 엔진(Electron ^39, ES2019+)은 문자열 리터럴 내 미이스케이프 U+2028/2029 도 정상
      // 파싱하지만, 향후 엔진/실행 경로 변경에 대비해 방어적으로 직접 이스케이프해 둔다.
      const encoded = JSON.stringify(value)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
      // 요소가 iframe 안(주소 입력·결제 폼)이면 그 프레임의 preload 에 맡긴다
      const { frameIndex, id: localId } = decodeFrameId(id)
      if (frameIndex !== 0) {
        const frame = agentSubFrames(wc)[frameIndex - 1]
        if (!frame) return 'fill failed'
        const fromFrame = resultSchema.safeParse(
          await callFrameOp(frame, { op: 'fillValue', id: localId, value })
        )
        return fromFrame.success ? fromFrame.data : 'fill failed'
      }
      const code = `__samba.fillValue(${localId}, ${encoded})`
      const raw: unknown = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }])
      const parsed = resultSchema.safeParse(raw)
      return parsed.success ? parsed.data : 'fill failed'
    } catch {
      return 'fill failed'
    }
  },
  findLoginFields: (tab: Tab): Promise<LoginFieldsResult> =>
    call(tab.view.webContents, '__samba.findLoginFields()', loginFieldsSchema),
  // 문자 인증번호 입력칸 후보. 새 페이지 채널을 만들지 않고 스냅샷을 다시 받아
  // 순수 판정 함수(auth-flow)를 메인 쪽에서 적용한다
  findCodeField: async (tab: Tab): Promise<PageElement | null> =>
    pickCodeField(await call(tab.view.webContents, '__samba.snapshot()', snapshotSchema)),
  // 이미 로그인된 상태인지 힌트(로그인 폼을 못 찾았을 때만 쓴다)
  signedInHint: (tab: Tab): Promise<SignedInHintResult> =>
    call(tab.view.webContents, '__samba.signedInHint()', signedInHintSchema),
  // 결제 비밀번호 키패드 신호(비밀 화면 판정용). 입력 내용은 읽지 않는다
  keypadSignals: (tab: Tab): Promise<KeypadSignals> =>
    call(tab.view.webContents, '__samba.keypadSignals()', keypadSignalsSchema),
  /**
   * 메인 프레임 + iframe 전부의 키패드 신호. 페이코 보안 키패드처럼 숫자 버튼이
   * iframe 안에만 있는 화면을 놓치지 않으려면 프레임까지 봐야 한다.
   * 합산과 판정은 main/agent/secret-page 의 순수 함수가 한다
   */
  keypadSignalsAll: async (tab: Tab): Promise<KeypadSignals[]> => {
    const { main, frames } = await callEveryFrame(tab, { op: 'keypadSignals' }, keypadSignalsSchema)
    return [main, ...frames.map((f) => f.value)]
  },
  /**
   * 결제 키패드 숫자 버튼 배치. 메인 프레임부터 살펴 0~9 가 완전한 첫 프레임을 쓴다
   * (페이코·NICE 보안 키패드는 iframe 안에 있다). 어느 프레임에도 없으면 null.
   * 값은 오가지 않는다 — 숫자별 요소 id 와 눌린 자리수만
   */
  keypadLayout: async (tab: Tab): Promise<KeypadLayout | null> => {
    const { main, frames } = await callEveryFrame(tab, { op: 'keypadLayout' }, keypadLayoutSchema)
    const candidates: { index: number; value: KeypadLayoutDto | null }[] = [
      { index: 0, value: main },
      ...frames.map((f) => ({ index: f.index, value: f.value }))
    ]
    for (const c of candidates) {
      if (!c.value) continue
      const digits: Record<string, number> = {}
      for (const d of c.value.digits) digits[d.digit] = encodeFrameId(c.index, d.id)
      return { digits, filled: c.value.filled, frameIndex: c.index }
    }
    return null
  },
  /**
   * 글자 없는 키패드 버튼들(네이버페이·페이코 결제 비밀번호 창)의 뷰포트 사각형. 메인 프레임을 먼저 보고,
   * 없으면 하위 프레임을 본다 — 페이코 PC 키패드는 결제창 안 iframe 이다(실기 2026-09-25).
   * 하위 프레임 칸은 그 iframe 의 화면 위치를 더해 탭 좌표로 바꾸고(앱이 이 자리를 캡처해 OCR),
   * id 에는 프레임 번호를 얹는다(그대로 pressOnce 에 넘긴다). 보안 키패드 모양이 아니면 null
   */
  keypadUnlabeled: async (tab: Tab): Promise<KeypadCellDto[] | null> => {
    const wc = tab.view.webContents
    const main = await call(wc, opToCode({ op: 'keypadUnlabeled' }), keypadUnlabeledSchema)
    if (main) return main
    const subs = agentSubFrames(wc)
    for (let i = 0; i < subs.length; i += 1) {
      const frame = subs[i]
      // 좌표를 더할 iframe 요소는 메인 문서에 있어야 한다 — 한 겹 아래 프레임만 다룬다
      if (frame.parent !== wc.mainFrame) continue
      let cells: KeypadCellDto[] | null = null
      try {
        cells = await callFrame(frame, { op: 'keypadUnlabeled' }, keypadUnlabeledSchema)
      } catch {
        continue
      }
      if (!cells) continue
      const url = frameUrl(frame)
      const offset = await call(
        wc,
        `(() => { const f = Array.from(document.querySelectorAll('iframe')).find((x) => x.src === ${JSON.stringify(url)}); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.left + f.clientLeft, y: r.top + f.clientTop } })()`,
        z.object({ x: z.number(), y: z.number() }).nullable()
      ).catch(() => null)
      if (!offset) continue
      return cells.map((c) => ({
        ...c,
        id: encodeFrameId(i + 1, c.id),
        x: c.x + offset.x,
        y: c.y + offset.y
      }))
    }
    return null
  },
  /**
   * 라벨 글자로 체크박스를 켠다 — 메인 프레임부터 하위 프레임까지 처음 찾은 곳에서. 결과 문구만 돌려준다
   * (checked·already·not-found·failed)
   */
  checkByLabel: async (tab: Tab, text: string): Promise<string> => {
    const { main, frames } = await callEveryFrame(tab, { op: 'checkByLabel', text }, resultSchema)
    for (const r of [main, ...frames.map((f) => f.value)]) if (r !== 'not-found') return r
    return 'not-found'
  },
  /** 키패드 버튼을 정확히 한 번 누른다(일반 click 의 재시도 폴백이 없다) */
  pressOnce: (tab: Tab, id: number): Promise<string> =>
    asMachineInput(tab, () => callById(tab, id, (n) => ({ op: 'pressOnce', id: n }), resultSchema)),
  /** 그 프레임의 비밀 입력칸에 찍힌 자리수(값은 읽지 않는다). 셀 수 없으면 null */
  keypadFilled: async (tab: Tab, frameIndex: number): Promise<number | null> => {
    const wc = tab.view.webContents
    const op: AgentOp = { op: 'keypadLayout' }
    const layout =
      frameIndex === 0
        ? await call(wc, opToCode(op), keypadLayoutSchema)
        : await (async () => {
            const frame = agentSubFrames(wc)[frameIndex - 1]
            if (!frame) throw new Error(`frame ${frameIndex} is gone`)
            return callFrame(frame, op, keypadLayoutSchema)
          })()
    return layout?.filled ?? null
  },
  /**
   * 지금 화면을 덮고 있는 레이어들(메인 프레임 + iframe).
   * 팝업 안 공지·쿠폰 레이어도 잡히도록 프레임까지 훑고, 프레임 요소 id 에는
   * 프레임 번호를 얹는다 — 그대로 click 에 넘길 수 있어야 한다
   */
  overlays: async (tab: Tab): Promise<PageOverlay[]> => {
    const { main, frames } = await callEveryFrame(tab, { op: 'overlays' }, overlayListSchema)
    const out: PageOverlay[] = main.map((o) => ({
      ...o,
      label: o.label.slice(0, OVERLAY_LABEL_MAX)
    }))
    for (const frame of frames) {
      for (const o of frame.value) {
        out.push({
          id: encodeFrameId(frame.index, o.id),
          label: o.label.slice(0, OVERLAY_LABEL_MAX),
          closeIds: o.closeIds.map((n) => encodeFrameId(frame.index, n)),
          sensitive: o.sensitive
        })
      }
    }
    return out.slice(0, MAX_OVERLAYS)
  },
  // 캡차·2FA 징후 감지(사용자 넘김 판단용)
  captchaHint: (tab: Tab): Promise<CaptchaHintResult> =>
    call(tab.view.webContents, '__samba.captchaHint()', captchaHintSchema),
  // 제출 직전 "로그인 상태 유지" 체크박스 켜기. 결과는 'checked: …' | 'already: …' | 'none'
  checkKeepSignedIn: (tab: Tab, anchorId?: number): Promise<string> =>
    call(
      tab.view.webContents,
      `__samba.checkKeepSignedIn(${anchorId === undefined ? '' : anchorId})`,
      resultSchema
    ),
  submitForm: (tab: Tab, id: number): Promise<string> =>
    callById(tab, id, (n) => ({ op: 'submitForm', id: n }), resultSchema),
  // 최신 스냅샷 기준 요소가 비밀 입력칸(type=password)인지 확인(fill_secret 대상 검증용)
  isSecretField: (tab: Tab, id: number): Promise<boolean> =>
    callById(tab, id, (n) => ({ op: 'isSecretField', id: n }), boolSchema),
  /**
   * 요소 가운데의 뷰포트 좌표(스크롤 반영). 실제 마우스 클릭(clickAt)을 보낼 자리다.
   *
   * iframe 안 요소는 지원하지 않는다 — 프레임의 화면 위치를 알려면 frame.frameElement 가
   * 필요한데 메인 프로세스에서는 접근할 수 없어 좌표를 합산할 수 없다. 프레임 요소는
   * preload 안의 폴백(합성 클릭·Enter·좌표 클릭)까지만 쓴다
   */
  rectOf: async (tab: Tab, id: number): Promise<ClickPoint | null> => {
    const { frameIndex, id: localId } = decodeFrameId(id)
    if (frameIndex !== 0) return null
    return call(tab.view.webContents, opToCode({ op: 'rectOf', id: localId }), pointSchema)
  },
  /**
   * 뷰포트 좌표에 진짜 마우스 클릭을 보낸다(webContents.sendInputEvent).
   * 합성 이벤트를 무시하는 사이트(좌표로 대상을 다시 찾는 목록·투명 덮개)의 마지막 수단이다.
   * 보낸 뒤 무슨 일이 일어났는지는 알 수 없어 "보냈다/못 보냈다"만 돌려준다
   */
  clickAt: (tab: Tab, x: number, y: number): boolean => {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return false
    // 사람이 쓰는 탭에는 자동화가 클릭을 보내지 않는다(human-activity.ts)
    if (automationBlocked(wc)) return false
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return false
    const point = { x: Math.round(x), y: Math.round(y), button: 'left' as const, clickCount: 1 }
    try {
      // 자동화의 클릭이 before-mouse-event 로 사람의 마우스 누름으로 세이지 않게 감싼다
      const send = (): void => {
        wc.sendInputEvent({ type: 'mouseDown', ...point })
        wc.sendInputEvent({ type: 'mouseUp', ...point })
      }
      withAutomationInputSync(wc, send)
      return true
    } catch {
      return false
    }
  },
  /**
   * 로그인 칸을 **진짜 키 입력**으로 채운다(webContents.sendInputEvent).
   * 점수형 reCAPTCHA(v3·Enterprise)는 합성 이벤트로 넣은 값을 봇으로 보아 로그인 요청 자체를 거부한다 —
   * 실기(GS샵): 키마스터 '완성'으로 채우고 로그인을 눌러도 "reCAPTCHA 검증이 유효하지 않습니다" 뒤
   * 새로고침만 되고, 손으로 치면 들어갔다. 요소 가운데를 실제로 클릭해 포커스한 뒤 전체 선택 → 글자별 char 이벤트.
   * 프레임 안 요소(좌표 불명)·클릭 실패·글자 수 불일치면 fillValue(합성 이벤트)로 돌아간다.
   * 값은 코드 문자열에 넣지 않는다(입력 이벤트로만 나간다)
   */
  typeLogin: async (tab: Tab, id: number, value: string): Promise<string> => {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return 'page is gone'
    // 사람이 이 탭에서 입력 중이면 자동화는 치지 않는다 — 두 입력이 한 칸에 섞여 네이버 계정이 잠겼다(실기 2026-09-25)
    const blocked = automationBlocked(wc)
    if (blocked) return blocked
    // 한 글자씩 진짜 키를 보내는 입력은 그게 필요한 사이트(점수형 reCAPTCHA)만 쓴다. 다른 사이트는 값을 칸에 직접 넣는다 —
    // 키 입력은 포커스가 다른 칸에 남으면 엉뚱한 칸에 쳐진다(실기 2026-09-25 네이버: 계정 목록이 비밀번호 칸을 가려
    // 클릭이 막히자 비밀번호가 아이디 칸에 쳐져 'snnh6oj7n@4f!@o!rt' 로 섞였고, 자동 제출이 반복돼 계정이 잠겼다)
    if (!needsHumanTyping(safeHost(wc))) return pageBridge.fillValue(tab, id, value)
    if (isAutomation())
      return withAutomationInput(wc, () => pageBridge.typeLoginNow(tab, id, value))
    return pageBridge.typeLoginNow(tab, id, value)
  },
  /** 입력칸 값의 글자 수(값 자체는 돌려주지 않는다). 못 읽으면 -1 */
  valueLength: async (tab: Tab, id: number): Promise<number> => {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return -1
    const { frameIndex, id: localId } = decodeFrameId(id)
    if (frameIndex !== 0) return -1
    return call(wc, opToCode({ op: 'valueLength', id: localId }), z.number()).catch(() => -1)
  },
  /** typeLogin 본문(가드 뒤) */
  typeLoginNow: (tab: Tab, id: number, value: string): Promise<string> =>
    asMachineInput(tab, () => pageBridge.typeLoginKeys(tab, id, value)),
  /** typeLoginNow 본문(진짜 키 입력). 기계 입력 표시는 typeLoginNow 가 한다 */
  typeLoginKeys: async (tab: Tab, id: number, value: string): Promise<string> => {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return 'page is gone'
    const point = await pageBridge.rectOf(tab, id).catch(() => null)
    if (!point || !(await pageBridge.clickHuman(tab, point.x, point.y))) {
      return pageBridge.fillValue(tab, id, value)
    }
    try {
      // 클릭이 포커스로 이어질 시간을 준다
      await pause(HUMAN_FOCUS_MS)
      // 이미 든 값(아이디 저장 등)은 전체 선택으로 덮어쓴다
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
      await pause(HUMAN_FOCUS_MS)
      // 긴 글(프롬프트 등)은 글자별 키 입력이 브릿지 제한(90초)을 넘기므로 클립보드 붙여넣기로 넣는다
      const useClipboard = value.length > LONG_PASTE_CHARS
      if (useClipboard) {
        clipboard.writeText(value)
        wc.paste()
        await pause(HUMAN_FOCUS_MS * 3)
      }
      for (const ch of useClipboard ? '' : value) {
        // keyDown/keyUp 은 keyCode 가 가속기 이름이어야 해 영숫자만 보낸다. 글자는 char 이벤트가 넣는다
        const named = /^[A-Za-z0-9]$/.test(ch)
        if (named) wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        if (named) wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
        // 사람 타자 속도(글자 간 35~95ms) — 점수형 reCAPTCHA 는 0ms 간격 입력을 봇으로 본다(실기: 4~5회에 1회 성공)
        await pause(HUMAN_KEY_MIN_MS + Math.random() * HUMAN_KEY_JITTER_MS)
      }
    } catch {
      return pageBridge.fillValue(tab, id, value)
    }
    const { id: localId } = decodeFrameId(id)
    const length = await call(wc, opToCode({ op: 'valueLength', id: localId }), z.number()).catch(
      () => -1
    )
    if (length !== value.length) return pageBridge.fillValue(tab, id, value)
    return 'ok'
  },
  /**
   * 로그인 폼 제출 — 제출 버튼을 **진짜 마우스 클릭**(sendInputEvent)으로 누른다. 점수형 reCAPTCHA 는 버튼 핸들러가
   * 도는 시점의 사용자 신호(신뢰된 클릭)를 보므로 합성 클릭보다 낫다. 좌표를 못 구하면(프레임 안·숨김) submitForm 폴백.
   * 버튼이 아니라 비밀번호 칸 id 를 받으면 그 폼의 제출 버튼을 preload 가 찾아 누른다(submitForm)
   */
  submitLogin: async (tab: Tab, id: number, isButton: boolean): Promise<string> => {
    // 페이지 스크립트(reCAPTCHA 적재)가 끝나기 전에 누르면 "서비스가 원활하지 않습니다"로 실패한다 — 적재를 기다린다
    await pageBridge.waitForLoad(tab, HUMAN_LOAD_WAIT_MS)
    await pause(HUMAN_BEFORE_SUBMIT_MS)
    if (isButton) {
      const point = await pageBridge.rectOf(tab, id).catch(() => null)
      if (point && (await pageBridge.clickHuman(tab, point.x, point.y))) return 'ok'
    }
    return pageBridge.submitForm(tab, id)
  },
  /**
   * 사람처럼 누른다 — 마우스를 근처에서 목표로 두 번 옮긴 뒤 mouseDown·(잠깐)·mouseUp. clickAt 과 달리
   * 이동·간격이 있어 점수형 봇 판정(reCAPTCHA Enterprise)에 사용자 신호를 남긴다. 좌표가 이상하면 false
   */
  clickHuman: async (tab: Tab, x: number, y: number): Promise<boolean> => {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return false
    if (automationBlocked(wc)) return false
    if (isAutomation()) return withAutomationInput(wc, () => pageBridge.clickHumanNow(tab, x, y))
    return pageBridge.clickHumanNow(tab, x, y)
  },
  /** clickHuman 본문(가드 뒤) */
  clickHumanNow: async (tab: Tab, x: number, y: number): Promise<boolean> => {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return false
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return false
    const tx = Math.round(x)
    const ty = Math.round(y)
    try {
      wc.sendInputEvent({ type: 'mouseMove', x: Math.max(0, tx - 40), y: Math.max(0, ty + 25) })
      await pause(HUMAN_MOVE_MS)
      wc.sendInputEvent({ type: 'mouseMove', x: tx, y: ty })
      await pause(HUMAN_MOVE_MS)
      wc.sendInputEvent({ type: 'mouseDown', x: tx, y: ty, button: 'left', clickCount: 1 })
      await pause(HUMAN_PRESS_MS)
      wc.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 })
      return true
    } catch {
      return false
    }
  },
  waitForLoad: (tab: Tab, timeoutMs = 10000): Promise<void> =>
    new Promise<void>((resolve) => {
      const wc = tab.view.webContents
      if (!wc.isLoading()) {
        resolve()
        return
      }
      const t = setTimeout(done, timeoutMs)
      function done(): void {
        clearTimeout(t)
        wc.off('did-stop-loading', done)
        resolve()
      }
      wc.on('did-stop-loading', done)
    })
}
