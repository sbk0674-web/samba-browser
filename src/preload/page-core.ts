// [규칙] 이 파일은 page.ts 와 함께 sandbox preload 로 번들된다.
// src/shared/* 에서 **값(value)** 을 import 하지 말 것 — Rollup 청크 분리로 require() 가 생겨
// preload 로드가 실패한다. 타입은 `import type` 만 사용(번들에 남지 않음), 값은 ./page-constants 에서.
import type {
  KeypadCellDto,
  KeypadLayoutDto,
  KeypadSignals,
  PageElement,
  PageOverlay,
  PageSnapshot
} from '../shared/snapshot'
import type { CaptureTraceStage } from '../shared/vault'
import { MAX_ELEMENTS } from './page-constants'
import {
  isCloseLabel,
  isOverlay,
  isSensitiveOverlay,
  isSignInPromptOnly,
  type OverlaySignals
} from './page-overlay'
import {
  detectLoginFields,
  detectSignedInHint,
  detectCaptchaHint,
  labelTextOf,
  passwordElement as detectPasswordElement,
  standaloneUsernameElement,
  SOCIAL_RE,
  SUBMIT_TEXT_RE,
  usernameElementFor as detectUsernameElementFor,
  type CaptchaHint,
  type LoginFields,
  type SignedInHint
} from './login-detect'

// --- 안정 id 표 -----------------------------------------------------------
//
// id 는 **문서(프레임)마다 한 번만** 매긴다. 같은 요소는 몇 번을 다시 스냅샷해도 같은 번호이고,
// 새로 생긴 요소만 새 번호를 받는다. 드롭다운을 열어 앞쪽에 요소가 끼어들어도
// "90(L) 은 1555번" 이 그대로 유지된다 — 예전처럼 번호가 통째로 밀리면
// AI 가 직전 목록을 보고 엉뚱한 항목(85)을 누르게 된다.
//
// 요소 → id 는 WeakMap 이라 DOM 이 사라지면 함께 사라지고,
// id → 요소 는 Map 이라 없어진 번호를 "사라졌다" 고 알려 줄 수 있다.
// 페이지를 옮기면 document 가 바뀌고 preload 가 다시 실행되어 자연히 초기화된다

/** 요소 → 이 문서에서 처음 받은 id */
let idOf: WeakMap<Element, number> = new WeakMap()
/** id → 실제 DOM 요소. 떨어져 나간 요소는 스냅샷 때 정리한다 */
let registry: Map<number, HTMLElement> = new Map()
/** 마지막으로 나눠 준 id(문서 안에서만 증가) */
let idSeq = 0
/** 한때 있었지만 지금은 사라진 id. 모델에게 "없는 번호" 와 구분해 알려 준다 */
let goneIds: Set<number> = new Set()
/** 이 표가 어느 document 것인지(문서가 바뀌면 처음부터 다시 매긴다) */
let idDoc: Document | null = null
/** 마지막 스냅샷이 모은 요소들(문서 순서). 로그인 폼·레이어 판정이 순서대로 훑는다 */
let lastOrder: HTMLElement[] = []

// goneIds 가 한없이 커지지 않도록 하는 상한(넘으면 비운다 — 최신 것만 알려 주면 충분하다)
const GONE_IDS_MAX = 2000

/** id 표를 처음 상태로 되돌린다(문서 교체·테스트용) */
export function resetElementIds(): void {
  idOf = new WeakMap()
  registry = new Map()
  goneIds = new Set()
  lastOrder = []
  idSeq = 0
  idDoc = typeof document === 'undefined' ? null : document
}

/** 사라진 id 를 기록한다(상한을 넘으면 비운다) */
function markGone(id: number): void {
  if (goneIds.size >= GONE_IDS_MAX) goneIds = new Set()
  goneIds.add(id)
}

/**
 * 이번 스냅샷에 나온 요소들로 id 표를 갱신한다.
 * - 이미 번호가 있는 요소는 그 번호 그대로
 * - 처음 보는 요소만 다음 번호
 * - 문서에서 떨어져 나간 요소는 표에서 지우고 goneIds 에 남긴다
 *
 * 화면 전체가 갈린 경우(이전 요소가 하나도 남지 않음)에는 번호를 1번부터 다시 매긴다 —
 * SPA 라우팅으로 페이지가 통째로 바뀐 것이라, 어차피 예전 번호는 아무 의미가 없다
 */
function assignIds(elements: readonly HTMLElement[]): void {
  if (idDoc !== document) resetElementIds()
  // 떨어져 나간 요소 정리
  for (const [id, el] of registry) {
    if (el.isConnected === false) {
      registry.delete(id)
      markGone(id)
    }
  }
  if (registry.size === 0 && idSeq > 0) {
    // 문서는 그대로인데 내용이 전부 갈렸다(SPA 라우팅) — 번호를 처음부터 다시 쓴다.
    // 예전 번호는 아무 의미가 없으니 "사라진 번호" 기록도 함께 비운다
    idOf = new WeakMap()
    goneIds = new Set()
    idSeq = 0
  }
  for (const el of elements) {
    let id = idOf.get(el)
    if (id === undefined) {
      id = ++idSeq
      idOf.set(el, id)
    }
    registry.set(id, el)
    goneIds.delete(id)
  }
  lastOrder = elements.slice()
}

// 기본 수집 셀렉터. 역할(role)·시맨틱으로 "누를 수 있다"고 선언한 요소들.
// 옵션·탭·메뉴 항목까지 넓힌 이유: 쇼핑몰 상품 페이지의 컬러/사이즈 선택이 대부분 이 부류다
// href 없는 <a> 도 담는다 — 무신사 배송지 팝업의 '배송지 추가하기'처럼 JS 버튼으로 쓰는 앵커가 흔하다
const SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"], [onclick], ' +
  '[contenteditable="true"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], ' +
  '[role="menuitemradio"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], ' +
  '[role="combobox"], [role="listbox"] li, [tabindex]:not([tabindex="-1"]), summary, label[for]'

// --- 커서 휴리스틱 --------------------------------------------------------
// 무신사처럼 role·onclick·tabindex 가 하나도 없는 순수 DIV 에 React 핸들러만 달아 둔 UI 대응.
// CSS 가 cursor:pointer 를 준 "가장 안쪽" 요소만 주워 담는다.
const CURSOR_CANDIDATES = 'div,span,li,p,img,svg'
// 성능 상한: 후보 탐색 개수 / 최종 수집 개수 / 라벨 길이
// 무신사 상품 페이지는 후보가 5천 개를 넘고 옵션 목록이 4,500번째쯤에 온다 — 개수보다 시간으로 막는다
const CURSOR_SCAN_MAX = 30000
const CURSOR_TIME_BUDGET_MS = 120
// 무신사 상품 페이지는 pointer 요소만 1,700개다 — 600이면 옵션 목록 전에 차서 사이즈를 못 고른다
const CURSOR_PICK_MAX = 4000
const CURSOR_TEXT_MAX = 120
// 그 자체로는 의미가 없는 태그들(수집됐다면 클릭 가능해서 잡힌 것이다)
const GENERIC_TAGS = new Set(['div', 'span', 'li', 'p', 'img', 'svg'])

// jsdom 등 CSS.escape 미지원 환경을 위한 간단한 폴백
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

// 한 번의 스냅샷 안에서 같은 조상을 몇 번씩 다시 계산하지 않도록 쓰는 캐시
type VisibilityCache = Map<HTMLElement, boolean>

function isVisible(el: HTMLElement, cache?: VisibilityCache): boolean {
  const cached = cache?.get(el)
  if (cached !== undefined) return cached
  let ok = !el.hidden
  if (ok) {
    const cs = getComputedStyle(el)
    ok = cs.display !== 'none' && cs.visibility !== 'hidden'
  }
  if (ok) {
    const parent = el.parentElement
    ok = parent === null ? true : isVisible(parent, cache)
  }
  cache?.set(el, ok)
  return ok
}

function roleOf(el: HTMLElement, clickable = false): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  // 리스트박스 안의 항목은 드롭다운 선택지다 — 모델이 바로 알아보도록 option 으로 표기
  if (tag === 'li' && el.closest?.('[role="listbox"]')) return 'option'
  if (tag === 'a') return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input') {
    const t = (el as HTMLInputElement).type
    if (t === 'submit' || t === 'button') return 'button'
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    return 'textbox'
  }
  // 의미 없는 태그(div/span/…)가 수집됐다는 건 tabindex·onclick·커서 휴리스틱으로 잡혔다는 뜻이다.
  // 모델에게는 태그명보다 "누를 수 있다"가 필요한 정보라 clickable 로 알린다
  if (clickable || GENERIC_TAGS.has(tag)) return 'clickable'
  return tag
}

function labelOf(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return aria.trim()
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  if (text) return text
  // name 속성이 있으면 그 값을 그대로 노출하므로 placeholder 는 name 이 없을 때만 사용
  const name = el.getAttribute('name')
  if (!name) {
    const ph = el.getAttribute('placeholder')
    if (ph) return ph.trim()
  }
  const id = el.id
  if (id) {
    const lab = document.querySelector(`label[for="${cssEscape(id)}"]`)
    if (lab?.textContent) return lab.textContent.trim()
  }
  return ''
}

/** 요소 하나를 스냅샷 항목으로 만든다(id 는 안정 id 표에서 받은 번호) */
function describeElement(el: HTMLElement, id: number, clickable = false): PageElement {
  const input = el as HTMLInputElement
  const inputType = el.tagName === 'INPUT' ? input.type : undefined
  const isSecret = inputType === 'password'
  return {
    id,
    tag: el.tagName.toLowerCase(),
    role: roleOf(el, clickable),
    text: labelOf(el),
    name: input.name || undefined,
    href: (el as HTMLAnchorElement).getAttribute?.('href') || undefined,
    inputType,
    ...(isSecret ? {} : valueOf(el)),
    isSecret
  }
}

/**
 * 입력칸·선택칸·체크박스의 현재 값. 비밀 입력칸(password)은 호출하지 않는다.
 * SAMBA-WAVE 같은 앱은 입력값이 접근성 트리에 안 나와 스크립트가 "저장 후 되읽기"를 못 했다 —
 * 이 값이 스냅샷에 실려야 기록 검증이 된다. 값이 없으면 필드를 아예 넣지 않는다
 */
function valueOf(el: HTMLElement): { value?: string } {
  const tag = el.tagName
  if (tag === 'SELECT') {
    const sel = el as HTMLSelectElement
    const opt = sel.options[sel.selectedIndex]
    return { value: (opt?.text ?? sel.value ?? '').trim() }
  }
  if (tag === 'TEXTAREA') return { value: (el as HTMLTextAreaElement).value.slice(0, 500) }
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement
    if (input.type === 'checkbox' || input.type === 'radio')
      return { value: input.checked ? 'on' : 'off' }
    if (input.type === 'file' || input.type === 'hidden') return {}
    return { value: input.value.slice(0, 500) }
  }
  if (el.getAttribute('role') === 'switch' || el.getAttribute('aria-pressed') !== null) {
    const v = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed')
    return v === null ? {} : { value: v === 'true' ? 'on' : 'off' }
  }
  return {}
}

/** 지금 화면(뷰포트) 안에 들어와 있는 요소인가. 좌표를 못 구하면 false(문서 순으로 밀린다) */
function isInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect?.()
  if (!rect) return false
  if (rect.width === 0 && rect.height === 0) return false
  const height = window.innerHeight || document.documentElement.clientHeight || 0
  const width = window.innerWidth || document.documentElement.clientWidth || 0
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width
}

/** 요소 자신이나 조상이 position fixed/sticky 인가(하단 고정 구매 바 등). 조상 판정은 cache 로 한 번만 한다 */
function isPinned(el: HTMLElement, cache: Map<Element, boolean>): boolean {
  const path: Element[] = []
  let node: Element | null = el
  let pinned = false
  while (node && node !== document.body && node !== document.documentElement) {
    const known = cache.get(node)
    if (known !== undefined) {
      pinned = known
      break
    }
    path.push(node)
    const position = window.getComputedStyle(node).position
    if (position === 'fixed' || position === 'sticky') {
      pinned = true
      break
    }
    node = node.parentElement
  }
  for (const n of path) cache.set(n, pinned)
  return pinned
}

const FORM_CONTROL_TAGS = new Set(['BUTTON', 'SELECT', 'INPUT'])

/**
 * 뷰포트 안 요소가 하나도 없을 때의 대체 순서.
 * 창에 붙지 않은 탭(뒤에서 도는 자동화 탭)은 뷰포트 판정이 전부 false 라 문서 순으로만 나열되고,
 * 페이지 끝의 구매 버튼·옵션칸이 MAX_ELEMENTS 밖으로 밀렸다(실기: 무신사 'buy button not found').
 * fixed/sticky 조상을 가진 요소 → button/select/input → 나머지 순서로, 각 묶음 안은 문서 순서를 지킨다
 */
function fallbackOrder(items: PageElement[], nodes: HTMLElement[]): PageElement[] {
  const cache = new Map<Element, boolean>()
  const pinned: PageElement[] = []
  const controls: PageElement[] = []
  const rest: PageElement[] = []
  items.forEach((item, i) => {
    const el = nodes[i]
    if (isPinned(el, cache)) pinned.push(item)
    else if (FORM_CONTROL_TAGS.has(el.tagName)) controls.push(item)
    else rest.push(item)
  })
  return pinned.concat(controls, rest)
}

/** 검색어가 요소의 라벨·name·href·placeholder 에 들어 있는가(대소문자 무시 부분일치) */
function matchesQuery(el: HTMLElement, item: PageElement, query: string): boolean {
  const haystack = [
    item.text,
    item.name ?? '',
    item.href ?? '',
    el.getAttribute('placeholder') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('value') ?? ''
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

/** 문서에 나타나는 순서대로 정렬(jsdom 에도 compareDocumentPosition 은 있다) */
function sortByDocumentOrder(els: HTMLElement[]): HTMLElement[] {
  return els.slice().sort((a, b) => {
    if (a === b) return 0
    const pos = a.compareDocumentPosition(b)
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })
}

/** 커서 휴리스틱 후보인가 — 텍스트가 짧게라도 있거나(≤120자) 그림(img/svg)이어야 한다 */
function hasTextLabel(el: HTMLElement): boolean {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 0 && text.length <= CURSOR_TEXT_MAX
}

// 아이콘(img/svg/빈 칸)이 텍스트 있는 pointer 조상 안에 있는가 — 그러면 조상이 항목이다
const ICON_ANCESTOR_DEPTH = 8
function insideTextPointer(el: HTMLElement): boolean {
  let node = el.parentElement
  for (let i = 0; i < ICON_ANCESTOR_DEPTH && node && node !== document.body; i += 1) {
    if (getComputedStyle(node).cursor === 'pointer' && hasTextLabel(node)) return true
    node = node.parentElement
  }
  return false
}

function hasClickableLabel(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag === 'img' || tag === 'svg') return true
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 0 && text.length <= CURSOR_TEXT_MAX
}

/**
 * CSS 가 cursor:pointer 를 준 순수 DIV/SPAN 류를 줍는다(role·onclick 이 없는 React UI 대응).
 *
 * 규칙
 * - SELECTOR 로 이미 잡힌 요소, 그리고 그런 요소를 품고 있는 요소는 제외한다(가장 안쪽만).
 * - pointer 인 조상-자손이 겹치면 안쪽(= 텍스트가 더 짧은 쪽)만 남긴다.
 * - 성능: 후보 탐색 30000개 또는 120ms, 결과 4000개까지. 비싼 검사(isVisible)는 마지막에 한다.
 */
function collectCursorClickable(base: HTMLElement[]): HTMLElement[] {
  const body = document.body
  if (!body) return []
  // base 와 그 조상들을 미리 표시해 둔다 — 후보마다 querySelector 를 돌리는 것보다 훨씬 싸다
  const blocked = new Set<HTMLElement>(base)
  for (const el of base) {
    let node = el.parentElement
    while (node && !blocked.has(node)) {
      blocked.add(node)
      node = node.parentElement
    }
  }
  const visible: VisibilityCache = new Map()
  const nodes = body.querySelectorAll<HTMLElement>(CURSOR_CANDIDATES)
  const scanned = Math.min(nodes.length, CURSOR_SCAN_MAX)
  const picked: HTMLElement[] = []
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  for (let i = 0; i < scanned; i += 1) {
    if (picked.length >= CURSOR_PICK_MAX) break
    // 시간 예산 — 64개마다 한 번만 시계를 본다
    if ((i & 63) === 63) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (now - startedAt > CURSOR_TIME_BUDGET_MS) break
    }
    const el = nodes[i]
    // 자기 자신이 이미 수집됐거나, 안에 수집된 인터랙티브 요소가 있으면 건너뛴다(가장 안쪽만)
    if (blocked.has(el)) continue
    if (getComputedStyle(el).cursor !== 'pointer') continue
    if (!hasClickableLabel(el)) continue
    if (!isVisible(el, visible)) continue
    // 문서 순서라 조상이 먼저 담긴다 — 텍스트가 있는 자손이 들어오면 조상을 걷어낸다.
    // 단, 자손이 아이콘(img/svg)이나 빈 칸이고 조상에 텍스트가 있으면 조상을 남긴다 —
    // 메뉴 항목 "(19)BLACK" 안의 컬러칩 이미지가 항목 자체를 밀어내던 문제
    if (!hasTextLabel(el) && insideTextPointer(el)) continue
    while (picked.length > 0 && picked[picked.length - 1].contains(el)) picked.pop()
    picked.push(el)
  }
  return picked
}

export interface SnapshotOptions {
  /** 주면 라벨·name·href·placeholder 가 부분일치하는 요소만 나열한다(id 는 그대로) */
  query?: string
  /** 주면 이 CSS 선택자에 걸린 요소(와 그 안쪽)만 나열한다. registry·id 는 그대로 */
  selector?: string
}

/**
 * selector 로 나열 범위를 좁힐 때 쓰는 뿌리 요소들.
 * 선택자가 문법에 맞지 않으면 null(호출부가 오류로 돌려준다)
 */
function selectorRoots(selector: string): HTMLElement[] | null {
  try {
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
  } catch {
    return null
  }
}

/** el 이 뿌리들 중 하나이거나 그 안쪽에 있는가 */
function insideRoots(roots: readonly HTMLElement[], el: HTMLElement): boolean {
  return roots.some((root) => root === el || root.contains(el))
}

/**
 * 페이지 스냅샷.
 *
 * registry(= click/type 이 쓰는 id 표)에는 **보이는 요소를 전부** 담는다 —
 * 150개로 잘라 버리면 뒤쪽 버튼(사이즈 선택·장바구니)을 영영 누를 수 없다.
 * 나열(elements)만 MAX_ELEMENTS 개로 자르고, 기본 순서는 "뷰포트 안 먼저, 그다음 문서 순"이다.
 * query 를 주면 일치하는 요소만 원래 id 그대로 돌려준다(find_elements).
 */
export function buildSnapshot(options: SnapshotOptions = {}): PageSnapshot {
  const baseVisible: VisibilityCache = new Map()
  const base = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) =>
    isVisible(el, baseVisible)
  )
  const clickable = collectCursorClickable(base)
  const clickableSet = new Set<HTMLElement>(clickable)
  // 두 목록을 합쳐 문서 순서로 정렬한다(처음 보는 요소의 id 가 화면 순서와 어긋나지 않도록)
  const all = clickable.length > 0 ? sortByDocumentOrder(base.concat(clickable)) : base
  // id 는 문서 안에서 한 번만 매긴다 — 나열 순서가 바뀌어도, 요소가 끼어들어도 그대로다
  assignIds(all)
  const described = all.map((el) => describeElement(el, idOf.get(el) ?? 0, clickableSet.has(el)))
  // selector 는 registry 를 건드리지 않는다 — 나열 범위만 좁힌다(id 는 언제나 문서 순서)
  const selector = options.selector?.trim()
  const roots = selector ? selectorRoots(selector) : null
  if (selector && roots === null) {
    return {
      url: location.href,
      title: document.title,
      text: '',
      elements: [],
      total: 0,
      selectorError: `invalid selector: ${selector.slice(0, 80)}`
    }
  }
  const inScope = (el: HTMLElement): boolean => roots === null || insideRoots(roots, el)
  const scoped = described.filter((_, i) => inScope(all[i]))
  const scopedNodes = all.filter((el) => inScope(el))
  const query = options.query?.trim().toLowerCase()
  let picked: PageElement[]
  let total: number
  if (query) {
    const hits = scoped.filter((item, i) => matchesQuery(scopedNodes[i], item, query))
    total = hits.length
    picked = hits.slice(0, MAX_ELEMENTS)
  } else {
    // 지금 화면에 보이는 것부터 — 모델이 필요한 버튼을 먼저 만나게 한다
    const inView: PageElement[] = []
    const rest: PageElement[] = []
    scoped.forEach((item, i) => (isInViewport(scopedNodes[i]) ? inView : rest).push(item))
    total = scoped.length
    // 뷰포트 안이 0개인데 잘려야 하면(창에 안 붙은 탭 등) 고정 바·폼 컨트롤을 먼저 둔다
    const ordered =
      inView.length === 0 && scoped.length > MAX_ELEMENTS
        ? fallbackOrder(scoped, scopedNodes)
        : inView.concat(rest)
    picked = ordered.slice(0, MAX_ELEMENTS)
  }
  // selector 를 주면 본문 텍스트도 그 범위 안만 모은다(전체 페이지 텍스트를 다시 보내지 않게)
  const body =
    roots === null
      ? document.body.innerText || document.body.textContent || ''
      : roots.map((root) => root.innerText || root.textContent || '').join('\n')
  return {
    url: location.href,
    title: document.title,
    text: body.replace(/\s+/g, ' ').trim(),
    elements: picked,
    total
  }
}

function get(id: number): HTMLElement | null {
  const el = registry.get(id)
  if (!el) return null
  if (el.isConnected === false) {
    registry.delete(id)
    markGone(id)
    return null
  }
  return el
}

/**
 * id 조회에 실패한 이유를 한 줄로.
 * 한때 있었던 번호면 "사라졌다" 고 알려 준다 — id 가 밀린 게 아니라는 뜻이라
 * 모델이 목록을 다시 읽고 같은 항목을 다시 찾게 된다
 */
function missingMessage(id: number, suffix = ' (call get_page again)'): string {
  const what = goneIds.has(id) ? 'is gone' : 'not found'
  return `element ${id} ${what}${suffix}`
}

// 등록된 요소가 비밀 입력칸(type=password)인지 여부. 최신 스냅샷 기준으로 판단하며,
// registry 에 없는 id 는 false(비밀 입력칸 아님으로 간주 → 호출부가 거부한다)
export function isSecretField(id: number): boolean {
  const el = get(id)
  if (!el) return false
  return el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'password'
}

// 등록된 요소의 실제 페이지 텍스트. 위험 행동 판정의 근거(AI 가 준 label 은 신뢰하지 않음)
export function textOf(id: number): string {
  const el = get(id)
  if (!el) return ''
  const parts = [labelOf(el)]
  // 버튼·링크 안의 글자 조각(예: 결제하기 버튼 안의 '37,850원')을 누르면 그 버튼이 눌린다 —
  // 감싸는 버튼·링크의 글자도 함께 봐야 위험 판정(결제 버튼 차단)이 새지 않는다
  const actionable = el.parentElement?.closest('button, a, [role="button"], [role="link"]')
  if (actionable && actionable !== el) parts.push(labelOf(actionable as HTMLElement))
  // 입력칸은 라벨이 비는 경우가 많아 name/placeholder 도 함께 본다
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const name = el.getAttribute('name')
    const ph = el.getAttribute('placeholder')
    if (name) parts.push(name.trim())
    if (ph) parts.push(ph.trim())
  }
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

/** 클릭 좌표(뷰포트 기준) */
interface ClickPoint {
  x: number
  y: number
}

/**
 * 마우스/포인터 이벤트 한 개를 쏜다(PointerEvent 가 없는 환경은 MouseEvent 로 대체).
 * point 를 주면 실제 마우스가 그 자리를 누른 것과 같은 좌표·버튼 정보를 담는다 —
 * 좌표로 대상을 다시 찾는 사이트(결과 행 전체가 클릭 영역인 주소 검색 목록)가 있다
 */
function fireMouseEvent(el: HTMLElement, type: string, point?: ClickPoint): void {
  const pressed = type === 'pointerdown' || type === 'mousedown'
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...(point === undefined
      ? {}
      : {
          clientX: point.x,
          clientY: point.y,
          screenX: point.x,
          screenY: point.y,
          button: 0,
          buttons: pressed ? 1 : 0,
          detail: type === 'click' ? 1 : 0
        })
  }
  let ev: Event
  if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
    ev = new PointerEvent(type, init)
  } else if (typeof MouseEvent === 'function') {
    ev = new MouseEvent(type, init)
  } else {
    ev = new Event(type, init)
  }
  el.dispatchEvent(ev)
}

/** 한 요소에 좌표가 담긴 클릭 한 벌(pointerdown→…→click)을 순서대로 쏜다 */
function firePointSequence(el: HTMLElement, point: ClickPoint): void {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    fireMouseEvent(el, type, point)
  }
}

// --- 클릭 결과 확인 --------------------------------------------------------
//
// 무신사 '구매하기'처럼 합성 클릭도 좌표 클릭도 먹지 않는 버튼이 있다. 브랜드 공지·쿠폰
// 레이어가 화면을 덮고 있거나, 사이트가 키보드 활성화(Enter)만 받는 경우다.
// 그래서 클릭 전후를 비교해 "아무 일도 없었다"면 포커스 후 Enter 로 한 번 더 시도한다.

/** 클릭 전후를 비교할 기준값 */
export interface ClickBaseline {
  url: string
  /** body 의 자식 수 — 모달·토스트가 붙으면 늘어난다 */
  children: number
  /** body 텍스트 길이 */
  textLength: number
  /** 포커스가 어디 있는가 */
  active: Element | null
  /** 대상 요소의 aria-expanded */
  expanded: string
  /** 대상 요소의 class(선택 상태를 클래스로 표시하는 UI 대응) */
  className: string
  /**
   * 대상 요소의 inline style·aria 상태. 켜짐/꺼짐을 색(style)이나 aria-pressed 로만 표시하는
   * 토글 버튼(SAMBA-WAVE 까대기)은 이것 말고는 변화가 없다 — 놓치면 폴백이 다시 눌러 도로 꺼진다
   */
  state: string
}

/** 최대 이만큼 지켜본 뒤에도 변화가 없으면 실패로 본다 */
const CLICK_SETTLE_MS = 400
const CLICK_POLL_MS = 40
/** 클릭 이벤트와 waitForChange 시작 사이의 틈 — 그 사이에 도착한 새 창 알림도 인정한다 */
const POPUP_GRACE_MS = 150
/** 가린 요소 설명에 담을 class 이름 최대 길이 */
const COVER_LABEL_MAX = 60

/** 첫 클릭도 Enter 도 통하지 않았을 때 모델에게 주는 안내 */
export const CLICK_NO_CHANGE_NOTE =
  'clicked but nothing changed (an overlay may be covering it; call dismiss_overlay or check get_page)'

/** 토글 상태가 드러나는 속성들 */
const TOGGLE_STATE_ATTRS = ['style', 'aria-pressed', 'aria-checked', 'aria-selected', 'disabled']

/** 지금 화면 상태를 기준값으로 찍는다 */
export function readClickBaseline(el: HTMLElement): ClickBaseline {
  const body = document.body
  const text = (body?.innerText || body?.textContent || '') as string
  return {
    url: location.href,
    children: body?.children.length ?? 0,
    textLength: text.length,
    active: document.activeElement,
    expanded: el.getAttribute('aria-expanded') ?? '',
    className: el.getAttribute('class') ?? '',
    state: TOGGLE_STATE_ATTRS.map((a) => el.getAttribute(a) ?? '').join('|')
  }
}

/** 기준값이 하나라도 달라졌는가(순수 비교) */
export function baselineChanged(before: ClickBaseline, after: ClickBaseline): boolean {
  return (
    before.url !== after.url ||
    before.children !== after.children ||
    before.textLength !== after.textLength ||
    before.active !== after.active ||
    before.expanded !== after.expanded ||
    before.className !== after.className ||
    before.state !== after.state
  )
}

/**
 * 클릭 좌표(요소 가운데)를 다른 요소가 가리고 있으면 "covered by tag.class" 를 돌려준다.
 * 좌표를 못 구하거나 elementFromPoint 가 없는 환경(jsdom 기본)에서는 null
 */
export function coveredByNote(el: HTMLElement): string | null {
  const hit = coveringElement(el)
  if (!hit) return null
  const tag = hit.tagName.toLowerCase()
  const cls = (hit.getAttribute('class') ?? '').trim().split(/\s+/)[0]
  return `covered by ${cls ? `${tag}.${cls}` : tag}`.slice(0, COVER_LABEL_MAX)
}

/** 요소 가운데의 뷰포트 좌표. 크기가 없거나 rect 를 못 구하면 null */
export function centerPointOf(el: HTMLElement): ClickPoint | null {
  const rect = el.getBoundingClientRect?.()
  if (!rect || (rect.width === 0 && rect.height === 0)) return null
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/**
 * 클릭 좌표를 대신 차지하고 있는 요소(가리는 요소). 없으면 null.
 * 자손(아이콘 span)이나 조상(패딩 영역)이 잡히는 것은 가려진 게 아니다
 */
export function coveringElement(el: HTMLElement): HTMLElement | null {
  const point = centerPointOf(el)
  if (!point) return null
  if (typeof document.elementFromPoint !== 'function') return null
  const hit = document.elementFromPoint(point.x, point.y)
  if (!hit || hit === el) return null
  if (el.contains(hit) || hit.contains(el)) return null
  return hit instanceof HTMLElement ? hit : null
}

/**
 * 요소 가운데의 뷰포트 좌표(스크롤 반영). 메인 프로세스가 실제 마우스 클릭
 * (webContents.sendInputEvent)을 보낼 자리다. 요소가 없거나 크기가 0 이면 null
 */
export function rectOf(id: number): ClickPoint | null {
  const el = get(id)
  if (!el) return null
  el.scrollIntoView?.({ block: 'center' })
  const point = centerPointOf(el)
  if (!point) return null
  return { x: Math.round(point.x), y: Math.round(point.y) }
}

/**
 * 입력칸 값의 글자 수. 메인 프로세스가 진짜 키 입력(typeLogin)으로 넣은 값이 들어갔는지 확인할 때 쓴다 —
 * 값 자체는 돌려주지 않는다(비밀 칸). 요소가 없거나 입력칸이 아니면 -1
 */
export function valueLength(id: number): number {
  const el = get(id)
  if (!el) return -1
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.length
  return -1
}

/**
 * 이 요소가 지금 키 입력을 받는가(document.activeElement). 진짜 키 입력 전에 확인한다 — 클릭이 포커스로
 * 이어지지 않으면 글자가 앞서 포커스된 칸(아이디 칸)에 쳐진다(실기 2026-09-25 네이버, 2026-09-29 partner.hmall.com)
 */
export function hasFocus(id: number): boolean {
  const el = get(id)
  const active = document.activeElement
  if (!el || !active) return false
  if (active === el) return true
  // Nexacro 는 포커스를 받으면 안내 글자용 칸(type=text)을 비밀번호 칸으로 바꿔 끼운다 — 요소는 달라져도
  // DOM id 가 같거나 같은 부모 안의 입력칸이면 같은 칸이다
  if (!(active instanceof HTMLInputElement)) return false
  if (el.id !== '' && active.id === el.id) return true
  return el.parentElement !== null && el.parentElement.contains(active)
}

/** 요소에 포커스를 준다(클릭이 포커스로 이어지지 않는 화면용 — Nexacro). 포커스를 받았으면 true */
export function focusEl(id: number): boolean {
  const el = get(id)
  if (!el) return false
  el.focus()
  return hasFocus(id)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 이 페이지가 마지막으로 새 탭·새 창을 연 시각(메인 프로세스가 알려 준다) */
let lastPopupAt = 0

/** 메인의 '새 탭·새 창이 열렸다' 알림을 기록한다 — 클릭이 통했다는 증거다 */
export function notePopupOpened(): void {
  lastPopupAt = Date.now()
}

/** 기준값이 달라질 때까지 최대 CLICK_SETTLE_MS 동안 지켜본다 */
async function waitForChange(el: HTMLElement, before: ClickBaseline): Promise<boolean> {
  const startedAt = Date.now()
  for (;;) {
    // 새 탭·새 창이 열렸다면 이 페이지 화면은 그대로여도 클릭은 통한 것이다
    if (lastPopupAt >= startedAt - POPUP_GRACE_MS) {
      // 한 번 쓴 알림은 지운다 — 바로 다음 클릭까지 "통했다"로 오인하지 않게
      lastPopupAt = 0
      return true
    }
    if (baselineChanged(before, readClickBaseline(el))) return true
    if (Date.now() - startedAt >= CLICK_SETTLE_MS) return false
    await sleep(CLICK_POLL_MS)
  }
}

/**
 * 페이지가 클릭을 실제로 "처리했는지" 지켜본다.
 * preventDefault 했거나(대부분의 SPA 버튼) stopPropagation 으로 문서까지 오지 못하게
 * 막았다면 사이트가 받아 간 것이다 — 화면이 당장 안 바뀌어도(비동기 요청) 성공으로 본다
 */
function watchClickHandled(): { handled: () => boolean; stop: () => void } {
  let reached = false
  let bubbled = false
  let prevented = false
  const onCapture = (): void => {
    reached = true
  }
  const onBubble = (ev: Event): void => {
    bubbled = true
    if (ev.defaultPrevented) prevented = true
  }
  document.addEventListener('click', onCapture, true)
  document.addEventListener('click', onBubble, false)
  return {
    handled: () => prevented || (reached && !bubbled),
    stop: () => {
      document.removeEventListener('click', onCapture, true)
      document.removeEventListener('click', onBubble, false)
    }
  }
}

/** 결과 문자열에 "가려져 있다" 안내를 덧붙인다 */
function withCoverNote(base: string, covered: string | null): string {
  return covered === null ? base : `${base}; ${covered}`
}

/** 포커스 상태에서 Enter 키 한 벌을 쏜다 */
function fireEnter(el: HTMLElement): void {
  if (typeof KeyboardEvent !== 'function') return
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      })
    )
  }
}

/** 글자를 넣는 칸인가(입력 중이던 칸의 blur 를 챙겨야 하는 대상) */
function isTextEntry(el: Element | null): el is HTMLElement {
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea') return true
  if (tag !== 'input') return (el as HTMLElement).isContentEditable === true
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
  return ![
    'button',
    'submit',
    'reset',
    'checkbox',
    'radio',
    'file',
    'image',
    'range',
    'color'
  ].includes(type)
}

/**
 * 다른 요소를 누르거나 다른 칸에 입력하기 직전에, 입력 중이던 칸에서 포커스를 뗀다.
 * 탭 페이지는 AI 패널이 포커스를 쥔 동안 document.hasFocus() 가 false 이고, 그 상태에서는
 * focus()/blur() 가 activeElement 만 바꾸고 blur·focusout 이벤트는 내지 않는다. blur 에 저장을
 * 걸어 둔 화면(SAMBA-WAVE 소싱주문번호·메모·실구매가)은 값이 화면에만 남고 서버에는 안 간다.
 * 그래서 브라우저가 이벤트를 내지 않았을 때만 같은 이벤트를 직접 보낸다(이중 저장 방지)
 */
export function releaseTextFocus(next: HTMLElement): void {
  const active = document.activeElement
  if (!isTextEntry(active) || active === next || active.contains(next)) return
  let fired = false
  const mark = (): void => {
    fired = true
  }
  active.addEventListener('blur', mark, { once: true })
  active.blur()
  active.removeEventListener('blur', mark)
  if (fired || typeof FocusEvent !== 'function') return
  active.dispatchEvent(new FocusEvent('blur', { relatedTarget: next }))
  active.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: next }))
}

export async function performClick(id: number): Promise<string> {
  const el = get(id)
  if (!el) return missingMessage(id)
  // jsdom 등 일부 환경은 scrollIntoView 를 구현하지 않음
  el.scrollIntoView?.({ block: 'center' })
  const covered = coveredByNote(el)
  // 실제 클릭은 mousedown 에서 입력 중이던 칸의 포커스를 뗀다. 기준값은 그 뒤에 찍는다
  releaseTextFocus(el)
  const before = readClickBaseline(el)
  // 1차 — 기존 경로 그대로. React 합성 이벤트(onPointerDown/onMouseDown 으로만 반응하는
  // 옵션 UI)를 위해 실제 사용자 클릭과 같은 순서로 쏘고, 마지막 click 은 네이티브 기본동작
  // (링크 이동·폼 제출·체크박스 토글)이 살아 있도록 el.click() 으로 낸다
  const watch = watchClickHandled()
  fireMouseEvent(el, 'pointerdown')
  fireMouseEvent(el, 'mousedown')
  fireMouseEvent(el, 'pointerup')
  fireMouseEvent(el, 'mouseup')
  el.click()
  const handled = watch.handled()
  watch.stop()
  if (handled) return withCoverNote('ok', covered)
  if (await waitForChange(el, before)) return withCoverNote('ok', covered)
  // 2차 폴백 — 포커스 후 Enter. 키보드 활성화만 받는 버튼(무신사 '구매하기') 대응.
  // 포커스 자체가 기준값(active)을 바꾸므로 기준을 다시 찍고 비교한다
  el.focus?.()
  const afterFocus = readClickBaseline(el)
  fireEnter(el)
  const tag = el.tagName.toLowerCase()
  if (tag === 'button' || tag === 'a') el.click()
  if (await waitForChange(el, afterFocus)) return withCoverNote('ok (via Enter)', covered)
  // 3차 폴백 — 좌표 기준 클릭.
  //
  // 롯데온 주소 검색 결과의 '사용' 버튼처럼, 사이트가 선택을 버튼이 아니라 결과 행(li)의
  // 핸들러로 처리하거나 투명 레이어가 버튼을 덮고 있으면 버튼에 보낸 합성 클릭은 무시된다.
  // 그래서 대상 가운데 좌표를 실제로 차지한 요소에게, 진짜 마우스와 같은 순서·좌표로 쏜다.
  // 가려져 있지 않다면 대상 자신에게 좌표를 담아 한 번 더 보낸다(1차는 좌표 없이 보냈다)
  const point = centerPointOf(el)
  if (point) {
    const hit = coveringElement(el)
    const target = hit ?? el
    const beforePoint = readClickBaseline(el)
    firePointSequence(target, point)
    if (await waitForChange(el, beforePoint)) {
      const mark = hit ? `via point click on ${hit.tagName.toLowerCase()}` : 'via point click'
      return withCoverNote(`ok (${mark})`, covered)
    }
  }
  return withCoverNote(`ok; ${CLICK_NO_CHANGE_NOTE}`, covered)
}

/**
 * 요소를 정확히 한 번만 누른다 — 결제 비밀번호 키패드 전용.
 * performClick 의 폴백(Enter·좌표 재클릭)은 '변화가 안 보이면 다시 누르기' 라서, 점(●) 표시가
 * 버튼 바깥에서 바뀌는 키패드에서는 같은 숫자를 두세 번 넣는다(실기: 무신사페이 오답 누적).
 * 여기서는 실제 사용자 클릭과 같은 이벤트 한 벌만 보내고 끝낸다
 */
export function pressOnce(id: number): string {
  const el = get(id)
  if (!el) return missingMessage(id)
  fireMouseEvent(el, 'pointerdown')
  fireMouseEvent(el, 'mousedown')
  fireMouseEvent(el, 'pointerup')
  fireMouseEvent(el, 'mouseup')
  el.click()
  return 'ok'
}

export function performType(id: number, text: string, submit: boolean): string | Promise<string> {
  const el = get(id)
  if (!el) return missingMessage(id)
  const input = el as HTMLInputElement
  if (input.type === 'password') return 'refused: SECRET field. Ask the user to type it.'
  // 비활성 칸은 값이 화면에만 들어가고 페이지는 받지 않는다(실기: SAMBA-WAVE 소싱주문번호 칸은
  // 주문계정을 고르기 전에는 disabled). 조용히 성공한 척하지 않는다
  if (input.disabled === true) {
    const why = el.getAttribute('title')
    return `refused: input is disabled${why ? ` (${why.slice(0, 80)})` : ''}. Enable it first, then type.`
  }
  releaseTextFocus(el)
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
  if (setter) setter.call(el, text)
  else input.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  if (!submit) return 'ok'
  // Enter 는 한 박자 뒤에 보낸다. React 제어 입력은 input 이벤트로 setState 만 예약하고,
  // 리렌더 전에는 onKeyDown 핸들러가 옛 state(빈 값·0)를 쥐고 있다. 같은 틱에 Enter 를 쏘면
  // 옛 값이 저장된다(실기: SAMBA-WAVE 실구매가 칸이 재조회 때 0 으로 돌아감)
  return new Promise<string>((resolve) => {
    setTimeout(() => {
      const target = el.isConnected ? el : null
      if (!target) return resolve('ok; input re-rendered before Enter — read the page to verify')
      const init: KeyboardEventInit = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }
      // Enter 핸들러가 "e.target.blur() → onBlur 에서 저장" 식이면(SAMBA-WAVE 소싱주문번호),
      // 포커스 없는 페이지에서는 그 blur() 가 이벤트를 내지 않아 저장이 안 된다.
      // 포커스는 빠졌는데 blur 이벤트가 없었으면 직접 보낸다
      let blurred = false
      const markBlur = (): void => {
        blurred = true
      }
      target.addEventListener('blur', markBlur)
      target.dispatchEvent(new KeyboardEvent('keydown', init))
      target.dispatchEvent(new KeyboardEvent('keypress', init))
      target.dispatchEvent(new KeyboardEvent('keyup', init))
      target.removeEventListener('blur', markBlur)
      if (!blurred && document.activeElement !== target && typeof FocusEvent === 'function') {
        target.dispatchEvent(new FocusEvent('blur'))
        target.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      }
      ;(target as HTMLInputElement).form?.requestSubmit?.()
      resolve('ok')
    }, SUBMIT_ENTER_DELAY_MS)
  })
}

/** 입력과 Enter 사이 간격 — React 리렌더(핸들러 교체) 한 번이 끝나기에 충분한 시간 */
const SUBMIT_ENTER_DELAY_MS = 120

export function performSelect(id: number, value: string): string {
  const el = get(id) as HTMLSelectElement | null
  if (!el) return missingMessage(id, '')
  if (el.tagName !== 'SELECT') return 'refused: not a select'
  releaseTextFocus(el)
  const opt = Array.from(el.options).find((o) => o.value === value || o.text.trim() === value)
  if (!opt) return `option "${value}" not found`
  el.value = opt.value
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
}

// 요소를 품은 가장 가까운 "스크롤 되는" 상자(overflow auto/scroll + 넘치는 내용)를 찾는다
function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el
  while (node && node !== document.body) {
    const cs = getComputedStyle(node)
    const canScroll =
      /(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1
    if (canScroll) return node
    node = node.parentElement
  }
  return null
}

/**
 * 페이지를 스크롤한다. id 를 주면 그 요소를 품은 스크롤 상자(드롭다운 목록·패널)를
 * 대신 스크롤한다 — 목록 안쪽에 잘린 옵션(사이즈 255 등)을 보이게 하려는 것이다.
 * 스크롤 상자가 없으면 요소를 화면 가운데로 데려온다
 */
export function performScroll(dir: 'up' | 'down', id?: number): string {
  const sign = dir === 'down' ? 1 : -1
  if (id !== undefined) {
    const el = get(id)
    if (!el) return missingMessage(id)
    const box = scrollableAncestor(el)
    if (box) {
      box.scrollTop += sign * box.clientHeight * 0.8
      return `ok (scrolled the list containing element ${id})`
    }
    el.scrollIntoView?.({ block: 'center' })
    return `ok (element ${id} is not inside a scrollable list; brought it into view)`
  }
  window.scrollBy({ top: sign * window.innerHeight * 0.8 })
  return 'ok'
}

// --- 값 주입(SECRET 허용) ------------------------------------------------
// 격리 월드에서 메인 프로세스만 호출한다(AI 텍스트 도구인 performType 과 달리 password 를 막지 않음)
export function fillValue(id: number, value: string): string {
  const el = get(id)
  if (!el) return missingMessage(id)
  const input = el as HTMLInputElement
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
  if (setter) setter.call(el, value)
  else input.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
}

// --- 로그인 필드 탐지 -----------------------------------------------------

type FormOwner = HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement

function formOf(el: HTMLElement): HTMLFormElement | null {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLButtonElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    return (el as FormOwner).form
  }
  return null
}

function isSubmitLike(el: HTMLElement): boolean {
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).type === 'submit'
  if (el.tagName === 'BUTTON') return (el as HTMLButtonElement).type !== 'button'
  return false
}

function isButtonish(el: HTMLElement): boolean {
  return (
    el.tagName === 'BUTTON' ||
    (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'submit')
  )
}

const LOGIN_TEXT = /로그인하기|로그인|login|sign in/i

// 로그인 필드 탐지. 호출할 때마다 스냅샷을 새로 구성한다 — SPA 는 클라이언트 라우팅으로 화면이
// 바뀌어도 문서를 새로 만들지 않아 이전 registry 가 낡은 채 남기 때문(E2E 하네스에서 확인된 버그).
// 실제 판정은 login-detect 모듈(Chromium/Bitwarden 규칙 이식)이 담당한다
export function findLoginFields(): LoginFields {
  buildSnapshot()
  // id 는 안정 id 표에서 가져온다 — 목록 순서가 아니라 요소가 처음 받은 번호다
  return detectLoginFields(lastOrder, (el) => idOf.get(el))
}

// 이미 로그인된 상태인지 힌트를 돌려준다(판정은 login-detect 모듈)
export function signedInHint(): SignedInHint {
  return detectSignedInHint()
}

// 캡차·2FA 징후를 돌려준다. 푸는 것은 언제나 사용자 몫이다
export function captchaHint(): CaptchaHint {
  return detectCaptchaHint()
}

// --- 결제 비밀번호 키패드 신호 ---------------------------------------------

// 문구 판정에만 쓰므로 페이지 텍스트는 앞부분만 본다(결제 팝업은 짧다)
const KEYPAD_TEXT_MAX = 8000
// 결제 비밀번호 칸으로 볼 자릿수 범위(간편결제 PIN 은 보통 4~6자리)
const PIN_MAXLENGTH_MIN = 4
const PIN_MAXLENGTH_MAX = 6

/**
 * 결제 비밀번호 키패드 판정에 필요한 신호만 모은다.
 * 입력칸의 **값은 절대 읽지 않는다** — 있는지·몇 개인지만 센다.
 * 실제 판정은 메인 쪽 순수 함수(main/agent/secret-page.ts)가 한다
 */
export function keypadSignals(): KeypadSignals {
  let digitButtons = 0
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
    const label = (el.textContent ?? '').trim()
    if (label.length !== 1 || label < '0' || label > '9') continue
    if (!isVisible(el)) continue
    digitButtons += 1
  }
  const pinField = Array.from(document.querySelectorAll<HTMLInputElement>('input')).some((el) => {
    // 평문 입력칸(문자 인증번호 등)은 대상이 아니다 — 비밀 입력칸만 본다
    if (el.type !== 'password') return false
    const max = el.maxLength
    const short = max >= PIN_MAXLENGTH_MIN && max <= PIN_MAXLENGTH_MAX
    const numeric = (el.getAttribute('inputmode') ?? '').toLowerCase() === 'numeric'
    // maxlength 가 없어도(-1) 숫자 전용 비밀 입력칸이면 결제 비밀번호로 본다
    return short || (numeric && (max === -1 || max <= PIN_MAXLENGTH_MAX))
  })
  const body = document.body
  const text = ((body?.innerText || body?.textContent) ?? '').replace(/\s+/g, ' ').trim()
  return {
    url: location.href,
    text: text.slice(0, KEYPAD_TEXT_MAX),
    digitButtons,
    pinField
  }
}

// --- 결제 비밀번호 키패드 배치 ---------------------------------------------

// 결제 비밀번호 칸으로 보는 비밀 입력칸(keypadSignals 의 pinField 와 같은 기준)
function pinInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter((el) => {
    if (el.type !== 'password') return false
    const max = el.maxLength
    const short = max >= PIN_MAXLENGTH_MIN && max <= PIN_MAXLENGTH_MAX
    const numeric = (el.getAttribute('inputmode') ?? '').toLowerCase() === 'numeric'
    return short || (numeric && (max === -1 || max <= PIN_MAXLENGTH_MAX))
  })
}

// 숫자 버튼 후보. 결제 키패드는 button·a 뿐 아니라 div·span·td 로도 그려진다
const KEYPAD_DIGIT_SELECTOR = SELECTOR + ', div, span, td, li, p, img, area'
const KEYPAD_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * 요소가 나타내는 한 자리 숫자. 화면 글자가 없으면 접근성 이름(aria-label·alt·title)을 본다 —
 * NICE nFilter 보안 키패드는 숫자를 배경 스프라이트로 그리고 글자는 aria-label 에만 둔다(실기)
 */
function singleDigitOf(el: Element): string | null {
  const isDigit = (s: string): boolean => s.length === 1 && s >= '0' && s <= '9'
  const text = (el.textContent ?? '').trim()
  if (text !== '') return isDigit(text) ? text : null
  for (const attr of ['aria-label', 'alt', 'title']) {
    const name = (el.getAttribute(attr) ?? '').trim()
    if (name !== '') return isDigit(name) ? name : null
  }
  return null
}

// 자리수를 세는 입력칸. 비밀 입력칸이 없으면 PIN 길이의 숫자칸(type=tel — nFilter)도 본다
function pinCounterInput(): HTMLInputElement | null {
  const secret = pinInputs()[0]
  if (secret) return secret
  const tel = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find(
    (el) =>
      el.type === 'tel' && el.maxLength >= PIN_MAXLENGTH_MIN && el.maxLength <= PIN_MAXLENGTH_MAX
  )
  return tel ?? null
}

/**
 * 글자가 정확히 같은 요소에 번호를 매겨 돌려준다 — 누를 수 있다는 표시(버튼·링크·커서)가 없어 요소 목록에
 * 안 잡히는 칸(Nexacro 그리드 셀 등)을 누르려는 용도다. 같은 글자가 여럿이면 가장 안쪽 요소들 중 nth 번째.
 * 보이지 않거나 없으면 -1
 */
export function idOfExactText(text: string, nth = 0): number {
  const want = text.replace(/\s+/g, ' ').trim()
  if (want === '') return -1
  const visible: VisibilityCache = new Map()
  const hits: HTMLElement[] = []
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    if ((el.textContent ?? '').replace(/\s+/g, ' ').trim() !== want) continue
    // 같은 글자를 가진 자식이 있으면 바깥 껍데기다 — 가장 안쪽만 센다
    if (Array.from(el.children).some((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim() === want)) continue
    if (!isVisible(el, visible)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    hits.push(el)
  }
  const el = hits[nth]
  return el ? ensureId(el) : -1
}

/**
 * 같은 줄(행)의 다른 칸에 번호를 매겨 돌려준다 — 그리드에서 글자로 찾은 칸(주문번호)의 줄에 있는 체크 칸을
 * 누르려는 용도다. 기준 요소에서 위로 올라가며 형제 칸이 여럿인 첫 조상을 '줄'로 보고, 그 줄의 칸들을
 * 화면 왼쪽부터 세어 index 번째 칸을 고른다. 없으면 -1
 */
export function idOfRowCell(id: number, index: number): number {
  const base = get(id)
  if (!base) return -1
  const ref = base.getBoundingClientRect()
  if (ref.height <= 0) return -1
  // 기준 칸을 감싼 칸(글자 요소의 부모)이 줄 높이를 정한다 — 글자 요소는 칸보다 작을 수 있다
  const line = Math.round(ref.top + ref.height / 2)
  const onLine = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8 || r.width > ROW_CELL_MAX_WIDTH || r.height > ROW_CELL_MAX_HEIGHT) return false
    return r.top <= line && r.bottom >= line
  }
  // 그리드는 고정 열(체크·번호)과 스크롤 열을 다른 상자에 그린다 — 문서 전체에서 같은 높이의 칸을 모은다.
  // 겹친 요소는 가장 바깥 것(칸)만 센다
  // 같은 높이에 있는 다른 화면(가려진 탭)의 요소가 섞이지 않게, 기준 칸을 감싼 표(넓고 높은 첫 조상) 안만 본다
  let grid: HTMLElement | null = base.parentElement
  while (grid) {
    const g = grid.getBoundingClientRect()
    if (g.width >= GRID_MIN_WIDTH && g.height >= GRID_MIN_HEIGHT) break
    grid = grid.parentElement
  }
  if (!grid) return -1
  const inGrid = Array.from(grid.querySelectorAll<HTMLElement>('*')).filter((el) => isVisible(el))
  // Nexacro 그리드는 칸 id 가 '…gridrow_0.cell_0_3' 꼴이다 — 있으면 그것만 칸으로 센다(고정 열 상자를 칸으로 세지 않게)
  const named = inGrid.filter((el) => NEXACRO_CELL_ID_RE.test(el.id) && onLine(el))
  const cells = (
    named.length >= 3
      ? named
      : inGrid.filter((el) => onLine(el) && !(el.parentElement && onLine(el.parentElement)))
  )
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
  const cell = cells[index]
  return cell ? ensureId(cell) : -1
}

// 줄의 칸으로 볼 최대 크기(px) — 줄 전체를 감싼 상자·화면 레이어는 뺀다
const ROW_CELL_MAX_WIDTH = 500
const ROW_CELL_MAX_HEIGHT = 60
const NEXACRO_CELL_ID_RE = /gridrow_\d+\.cell_\d+_\d+$/
// 표로 볼 최소 크기(px)
const GRID_MIN_WIDTH = 600
const GRID_MIN_HEIGHT = 100

/**
 * 요소의 조상들을 안쪽부터 적는다 — DOM id 의 끝 두 마디와 크기·위치만(글자는 싣지 않는다).
 * 화면 구조를 몰라 어느 상자가 표인지 가를 때 쓰는 진단용이다
 */
export function ancestorsOf(id: number): string {
  let el: HTMLElement | null = get(id) ?? null
  const out: string[] = []
  for (let depth = 0; el && depth < 12; depth++) {
    const r = el.getBoundingClientRect()
    const tail = (el.id || '').split('.').slice(-2).join('.')
    out.push(
      `${el.tagName.toLowerCase()}#${tail} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} kids=${el.children.length}`
    )
    el = el.parentElement
  }
  return out.join(' | ')
}

/** 이 요소에 id 가 없으면 매겨 registry 에 넣는다(스냅샷을 다시 찍지 않고 누를 수 있게) */
function ensureId(el: HTMLElement): number {
  if (idDoc !== document) resetElementIds()
  let id = idOf.get(el)
  if (id === undefined) {
    id = ++idSeq
    idOf.set(el, id)
  }
  registry.set(id, el)
  goneIds.delete(id)
  return id
}

/**
 * 결제 비밀번호 키패드의 숫자 버튼 배치. 앱이 키마스터 값을 대신 누를 때 쓴다.
 * 0~9 가 각각 정확히 한 개 보일 때만 배치를 돌려주고, 하나라도 빠지거나 겹치면 null —
 * 부분·중복 배치로 누르면 잘못 눌러 계정이 잠긴다. 이미지로 그려진 숫자는 잡지 못한다.
 * 값은 어디에서도 읽지 않는다: filled 는 비밀 입력칸의 길이(자리수)뿐이다
 */
/** root 안에서 0~9 가 정확히 한 번씩 보이면 그 요소들. 빠지거나 겹치면 null */
function digitCellsIn(root: ParentNode, visible: VisibilityCache): Map<string, HTMLElement> | null {
  const found = new Map<string, HTMLElement>()
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(KEYPAD_DIGIT_SELECTOR))
  for (const el of candidates) {
    const digit = singleDigitOf(el)
    if (digit === null) continue
    // <a><span>5</span></a> 처럼 겹친 경우 가장 안쪽만 센다(클릭은 위로 전파된다)
    if (Array.from(el.children).some((child) => singleDigitOf(child) !== null)) continue
    if (!isVisible(el, visible)) continue
    // 같은 숫자가 두 곳에 보이면 어느 쪽인지 확정할 수 없다 — 배치 전체를 버린다
    if (found.has(digit)) return null
    found.set(digit, el)
  }
  if (KEYPAD_DIGITS.some((d) => !found.has(d))) return null
  return found
}

export function keypadLayout(): KeypadLayoutDto | null {
  const visible: VisibilityCache = new Map()
  // 키패드가 모달(role=dialog)이면 그 안만 본다 — 뒤 페이지의 '수량 1' 같은 한 자리 숫자가 키패드의 1 과 겹쳐
  // 배치 전체가 버려졌다(실기 2026-10-06 롯데온 L.PAY 비밀번호). 모달 밖은 눌러도 먹지 않으니 볼 필요가 없다
  let found: Map<string, HTMLElement> | null = null
  for (const modal of Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open], [aria-modal="true"]')
  )) {
    if (!isVisible(modal, visible)) continue
    found = digitCellsIn(modal, visible)
    if (found) break
  }
  found = found ?? digitCellsIn(document, visible)
  if (!found) return null
  const digits = KEYPAD_DIGITS.map((digit) => ({ digit, id: ensureId(found.get(digit)!) }))
  const pin = pinCounterInput()
  return { digits, filled: pin ? pin.value.length : null }
}

// 글자 없는 키패드 버튼 후보
const KEYPAD_UNLABELED_SELECTOR = 'button, [role="button"], a'
// 보안 키패드 한 칸으로 볼 크기(px). 아이콘·전체 화면 레이어는 빼낸다
const KEYPAD_CELL_MIN = 16
// 창이 넓으면 네이버페이 PC 키패드 한 칸이 200px 을 넘는다(실기 2026-09-29: 버튼 11개가 다 걸러져 사람에게 넘김)
const KEYPAD_CELL_MAX = 400
// 숫자 10개 + 재배열·빈칸 같은 여분 버튼까지
const KEYPAD_UNLABELED_MIN = 10
const KEYPAD_UNLABELED_MAX = 14

/**
 * 글자도 접근성 이름도 없는 키패드 버튼들(네이버페이 결제 비밀번호 창 — 숫자가 이미지로 그려진다).
 * 보이는 button·[role=button]·a 중 글자가 비어 있고 크기가 키 한 칸 정도인 것을 위→아래, 왼→오른
 * 순으로 돌려준다. 보안 키패드 모양(10~14개)이 아니면 null. 어느 칸이 어느 숫자인지는
 * 여기서 알 수 없다 — 앱(메인 프로세스)이 각 칸을 OCR 로 읽는다. 값은 어디에서도 읽지 않는다
 */
// 숫자 그림 요소 주변 여백(px). 글자 가장자리가 잘리지 않을 만큼만
const KEYPAD_GLYPH_PAD = 6

/** 버튼 안의 숫자 그림 요소(배경 이미지 span·img·svg)의 사각형(여백 포함). 없으면 버튼 사각형 */
function glyphRectOf(
  button: HTMLElement,
  fallback: DOMRect
): { left: number; top: number; width: number; height: number } {
  const inner = Array.from(button.querySelectorAll<HTMLElement>('span, i, img, svg, em, b')).filter(
    (child) => {
      const cr = child.getBoundingClientRect()
      if (cr.width < 4 || cr.height < 4) return false
      if (cr.width >= fallback.width - 2 && cr.height >= fallback.height - 2) return false
      if (child instanceof HTMLImageElement || child instanceof SVGElement) return true
      return getComputedStyle(child).backgroundImage !== 'none'
    }
  )
  if (inner.length !== 1) return fallback
  const g = inner[0].getBoundingClientRect()
  const left = Math.max(fallback.left, g.left - KEYPAD_GLYPH_PAD)
  const top = Math.max(fallback.top, g.top - KEYPAD_GLYPH_PAD)
  const right = Math.min(fallback.right, g.right + KEYPAD_GLYPH_PAD)
  const bottom = Math.min(fallback.bottom, g.bottom + KEYPAD_GLYPH_PAD)
  return { left, top, width: right - left, height: bottom - top }
}

/** 마지막 keypadUnlabeled 판정 요약(후보 수·묶음 수) — 실패 사유를 남기는 데만 쓴다. 값·위치는 담지 않는다 */
let keypadDiag = ''

export function lastKeypadDiag(): string {
  return keypadDiag
}

/** 버튼 크기(4px 단위 반올림)가 같은 칸 무리 중 가장 큰 것 */
function largestSameSizeGroup<T extends { bw: number; bh: number }>(cells: T[]): T[] {
  const groups = new Map<string, T[]>()
  for (const c of cells) {
    const key = `${Math.round(c.bw / 4)}x${Math.round(c.bh / 4)}`
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  let best: T[] = []
  for (const g of groups.values()) if (g.length > best.length) best = g
  return best
}

export function keypadUnlabeled(): KeypadCellDto[] | null {
  keypadDiag = ''

  const visible: VisibilityCache = new Map()
  const cells: {
    el: HTMLElement
    x: number
    y: number
    width: number
    height: number
    bw: number
    bh: number
  }[] = []
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(KEYPAD_UNLABELED_SELECTOR))) {
    if (singleDigitOf(el) !== null) continue
    if ((el.textContent ?? '').trim() !== '') continue
    // <a><button></button></a> 처럼 겹친 경우 안쪽 하나만 센다
    if (el.querySelector(KEYPAD_UNLABELED_SELECTOR) !== null) continue
    if (!isVisible(el, visible)) continue
    const r = el.getBoundingClientRect()
    if (r.width < KEYPAD_CELL_MIN || r.height < KEYPAD_CELL_MIN) continue
    if (r.width > KEYPAD_CELL_MAX || r.height > KEYPAD_CELL_MAX) continue
    // OCR 은 숫자 그림 주변만 읽는 편이 정확하다(130×63 칸 전체를 주면 작은 숫자를 검출 모델이 놓친다 — 실기).
    // 버튼 안에 그림을 담은 작은 요소(스프라이트 span·img·svg)가 하나 있으면 그 사각형에 여백을 둬 쓴다
    const glyph = glyphRectOf(el, r)
    cells.push({
      el,
      x: glyph.left,
      y: glyph.top,
      width: glyph.width,
      height: glyph.height,
      bw: r.width,
      bh: r.height
    })
  }
  // 글자 없는 버튼이 더 있으면(재배열·지우기 아이콘 등) 크기가 같은 칸끼리 묶어 가장 큰 무리만 키패드로 본다
  // (실기 2026-09-30 네이버페이 비밀번호 확인 창: 10~14개 범위를 넘어 사람에게 넘겼다)
  const picked = cells.length > KEYPAD_UNLABELED_MAX ? largestSameSizeGroup(cells) : cells
  keypadDiag = `후보 ${cells.length}개, 같은 크기 무리 ${picked.length}개`
  if (picked.length < KEYPAD_UNLABELED_MIN || picked.length > KEYPAD_UNLABELED_MAX) return null
  picked.sort((a, b) => a.y - b.y || a.x - b.x)
  return picked.map((c) => ({
    id: ensureId(c.el),
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height
  }))
}

// --- 로그인 상태 유지 체크박스 ---------------------------------------------

// "로그인 상태 유지" 류 체크박스 라벨(ko/en). 같은 세션을 오래 유지해 캡차 발생을 줄인다
export const KEEP_SIGNED_IN_RE =
  /로그인\s?상태\s?유지|자동\s?로그인|로그인\s?유지|keep\s?me\s?signed\s?in|keep\s?signed\s?in|remember\s?me|stay\s?signed\s?in|remember\s?this\s?device/i

/** 라벨 문구가 "로그인 상태 유지" 체크박스인지(순수 함수) */
export function matchKeepSignedIn(label: string): boolean {
  return KEEP_SIGNED_IN_RE.test(label)
}

/**
 * 로그인 폼 제출 직전에 "로그인 상태 유지" 체크박스를 켠다.
 * anchorId(비밀번호·제출 버튼)를 주면 그 요소가 속한 form 안에서만 찾고,
 * form 이 없으면 문서 전체에서 찾는다. 이미 켜져 있으면 건드리지 않는다
 */
export function checkKeepSignedIn(anchorId?: number): string {
  const anchor = anchorId === undefined ? null : get(anchorId)
  const form = anchor ? formOf(anchor) : null
  const root: ParentNode = form ?? document
  const boxes = Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  ).filter((el) => isVisible(el) && !el.disabled)
  for (const box of boxes) {
    const label = labelTextOf(box)
    if (!matchKeepSignedIn(label)) continue
    if (box.checked) return `already: ${label.slice(0, 40)}`
    box.click()
    // click 이 막힌 폼(라벨만 처리하는 커스텀 UI) 대비 — 값과 이벤트를 직접 맞춘다
    if (!box.checked) {
      box.checked = true
      box.dispatchEvent(new Event('input', { bubbles: true }))
      box.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return box.checked ? `checked: ${label.slice(0, 40)}` : 'none'
  }
  return 'none'
}

/** 폼의 제출 버튼(button[type=submit]·type 없는 button·input[type=submit|image]). 없으면 null */
function submitButtonOf(form: HTMLFormElement): HTMLElement | null {
  return form.querySelector<HTMLElement>(
    'button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]'
  )
}

function isSubmitControl(el: HTMLElement): boolean {
  if (el instanceof HTMLButtonElement) return el.type === 'submit'
  if (el instanceof HTMLInputElement) return el.type === 'submit' || el.type === 'image'
  return false
}

/** 입력칸이 아니라 누르는 요소인가(button·input[type=button|submit|image|reset]·role=button·링크) */
function isPressable(el: HTMLElement): boolean {
  if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement) return true
  if (el instanceof HTMLInputElement) return /^(button|submit|image|reset)$/.test(el.type)
  return el.getAttribute('role') === 'button'
}

/**
 * 폼 안의 로그인 글자 버튼(type="button" 포함). 패션플러스처럼 제출 버튼 없이
 * <button type="button" v-on:click="login"> 으로 로그인하는 폼용 — 찾기·가입·소셜 버튼은 뺀다
 */
function loginButtonOf(form: HTMLFormElement): HTMLElement | null {
  const buttons = Array.from(
    form.querySelectorAll<HTMLElement>('button, input[type="button"], [role="button"]')
  )
  for (const button of buttons) {
    if (button instanceof HTMLButtonElement && button.disabled) continue
    const text = loginButtonText(button)
    if (!SUBMIT_TEXT_RE.test(text)) continue
    if (NOT_LOGIN_TEXT.test(text) || SOCIAL_RE.test(text)) continue
    return button
  }
  return null
}

/**
 * 입력칸에 Enter 를 누른 것처럼 keydown·keypress·keyup 을 보낸다 — Vue keyup.enter="login"·React onKeyDown
 * 핸들러로 로그인하는 칸용. 합성 이벤트라 브라우저의 암묵적 폼 제출은 일어나지 않는다
 */
function pressEnter(el: HTMLElement): void {
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  el.dispatchEvent(new KeyboardEvent('keypress', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
}

/**
 * 로그인 폼 제출. **버튼 클릭이 먼저다** — 사이트의 로그인 버튼 핸들러가 reCAPTCHA 토큰을 받아 폼에 붙인 뒤
 * 제출하는데(실기: GS샵), form.requestSubmit() 은 그 핸들러를 건너뛰어 토큰 없는 요청이 나가 조용히 거부됐다.
 * - 버튼(type="button" 포함)을 받으면 그 버튼을 누른다 — type="button" 을 폼 제출로 바꾸면 Vue 폼(action 없음)이
 *   같은 주소로 새로고침돼 로그인 요청이 나가지 않는다(실기: 패션플러스)
 * - 입력칸을 받으면 폼의 제출 버튼 → 폼 안 로그인 글자 버튼(type="button") → Enter 키(+ requestSubmit) 순
 */
export function submitForm(id: number): string {
  const el = get(id)
  if (!el) return missingMessage(id)
  if (isSubmitControl(el) || isPressable(el)) {
    el.click()
    return 'ok'
  }
  const form = formOf(el)
  const button = form ? (submitButtonOf(form) ?? loginButtonOf(form)) : null
  if (button) {
    button.click()
    return 'ok'
  }
  // 누를 버튼이 없으면 Enter 로 칸의 키 핸들러를 부른 뒤, 폼이면 제출까지 한다(예전 동작 유지)
  pressEnter(el)
  if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
  else if (!form) el.click()
  return 'ok'
}

// --- 폼 제출 감지(저장 제안) -----------------------------------------------

export interface InstallCaptureListenerOptions {
  // 테스트 전용: jsdom 의 dispatchEvent 는 isTrusted=false 이므로 합성 이벤트도 허용한다.
  // 실제 page.ts 는 이 옵션 없이(옵션 생략 = 신뢰된 이벤트만) 호출해야 한다.
  allowUntrusted?: boolean
  // 원인 파악용 단계 기록(값·아이디 없이 단계 이름만). page.ts 가 메인 로그로 보낸다
  trace?: (stage: CaptureTraceStage) => void
}

const CAPTURE_WINDOW_MS = 30_000
const CAPTURE_MAX_PER_WINDOW = 3
// 2단계 로그인(아이디 화면 → 비밀번호 화면)에서 앞 단계 아이디를 기억해 두는 시간
export const CAPTURE_USERNAME_STEP_MS = 5 * 60_000

export interface CapturedCredentials {
  username: string
  password: string
}

/**
 * 지금 화면의 로그인 칸에서 아이디·비밀번호를 읽는다(저장 제안용 — 메인으로만 보낸다).
 * 비밀번호 칸은 로그인 탐지 엔진과 같은 기준(current-password 우선, 새 비밀번호·확인칸·허니팟 제외)으로 고르고,
 * 제출된 폼(form)을 알면 그 폼 안의 칸을 먼저 쓴다. 값이 비어 있으면 null.
 * 아이디 칸이 없거나 비어 있으면 앞 단계에서 기억한 아이디(rememberedUsername)를 쓴다
 */
export function readLoginCredentials(
  form: HTMLFormElement | null,
  rememberedUsername = ''
): CapturedCredentials | null {
  const inForm = form
    ? Array.from(form.querySelectorAll<HTMLInputElement>('input[type="password"]')).find(
        (el) => isVisible(el) && el.value
      )
    : undefined
  const pw = inForm ?? detectPasswordElement()
  if (!pw || !pw.value) return null
  // username 후보 선택은 login-detect 모듈에 위임한다
  const typed = (detectUsernameElementFor(pw)?.value ?? '').trim()
  return { username: typed || rememberedUsername.trim(), password: pw.value }
}

/** 비밀번호 칸이 없는 화면(2단계 로그인의 아이디 단계)에서 입력된 아이디. 없으면 빈 문자열 */
export function readUsernameStep(): string {
  if (detectPasswordElement()) return ''
  return (standaloneUsernameElement()?.value ?? '').trim()
}

// 로그인 제출로 볼 수 있는 클릭 대상. 한국 쇼핑몰은 form 안이어도 type="button" 버튼(패션플러스 v-on:click="login"),
// 디자인 시스템 버튼 컴포넌트(현대H몰), <a href="javascript:..."> 링크로 로그인을 보내는 경우가 많다
const CAPTURE_CLICK_TARGET =
  'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], a'
// 로그인 버튼 글자로 보지 않는 문구 — 아이디·비밀번호 찾기, 회원가입 등(로그인 낱말이 섞여도 제출이 아니다)
const NOT_LOGIN_TEXT =
  /찾기|회원\s?가입|가입하기|비회원|find|forgot|reset|join|sign\s?up|register|로그인\s?상태|유지|자동\s?로그인|로그아웃|logout|log\s?out/i
// 버튼 글자가 이보다 길면 버튼이 아니라 안내문을 감싼 링크일 가능성이 크다
const LOGIN_BUTTON_TEXT_MAX = 30

/** 클릭한 요소에서 로그인 버튼 판정에 쓰는 글자 — 보이는 글자, 없으면 value·title·이미지 alt·aria-label */
export function loginButtonText(el: HTMLElement): string {
  const own = labelOf(el)
  if (own) return own
  const input = el instanceof HTMLInputElement ? el.value || el.alt : ''
  const img = el.querySelector('img')?.getAttribute('alt') ?? ''
  return `${input} ${el.getAttribute('title') ?? ''} ${img}`.replace(/\s+/g, ' ').trim()
}

/**
 * 클릭이 비밀번호 칸(pw)의 로그인 제출인가(순수 판정 — 테스트 대상).
 * - pw 가 폼 안이고 그 폼의 submit 버튼이면 제출이다
 * - 그 밖에는(폼 안의 type="button" 도, 폼 밖 SPA 버튼·링크도) 글자가 '로그인'류이고
 *   찾기·가입·소셜 로그인 버튼이 아닐 때만 제출이다
 */
export function isLoginSubmitClick(clicked: HTMLElement, pw: HTMLInputElement): boolean {
  const pwForm = formOf(pw)
  if (pwForm && isSubmitLike(clicked) && formOf(clicked) === pwForm) return true
  const text = loginButtonText(clicked)
  if (!text || text.length > LOGIN_BUTTON_TEXT_MAX) return false
  if (!LOGIN_TEXT.test(text)) return false
  if (NOT_LOGIN_TEXT.test(text) || SOCIAL_RE.test(text)) return false
  // 다른 폼의 버튼이면(예: 헤더 검색 폼) 이 비밀번호의 제출이 아니다
  const clickedForm = formOf(clicked) ?? clicked.closest('form')
  if (pwForm && clickedForm && clickedForm !== pwForm) return false
  return true
}

// ipcRenderer.send 등 실제 전송 함수는 주입받는다(테스트에서 스텁 가능하도록)
export function installCaptureListener(
  send: (payload: { host: string; username: string; password: string }) => void,
  options: InstallCaptureListenerOptions = {}
): void {
  const allowUntrusted = options.allowUntrusted === true
  const trace = (stage: CaptureTraceStage): void => {
    try {
      options.trace?.(stage)
    } catch {
      // 원인 파악용 기록이 실패해도 감지는 계속한다
    }
  }

  // 같은 제출이 submit 과 click·Enter 양쪽에서 잡혀 중복 전송되는 것을 짧게 막는다
  let lastSignature = ''
  let lastSentAt = 0
  // 2단계 로그인의 앞 단계 아이디(같은 문서 안에서만 — SPA 로그인)
  let stepUsername = ''
  let stepUsernameAt = 0

  // 시그니처와 무관하게, 적대 페이지가 서로 다른 값을 반복 주입/제출해 플러딩하는 것을 막는다
  // (호스트당 30초 최대 3회)
  const sentTimestamps: number[] = []
  const withinRateLimit = (now: number): boolean => {
    while (sentTimestamps.length > 0 && now - sentTimestamps[0] >= CAPTURE_WINDOW_MS) {
      sentTimestamps.shift()
    }
    return sentTimestamps.length < CAPTURE_MAX_PER_WINDOW
  }

  const attempt = (form: HTMLFormElement | null): void => {
    const now = Date.now()
    const remembered = now - stepUsernameAt < CAPTURE_USERNAME_STEP_MS ? stepUsername : ''
    const creds = readLoginCredentials(form, remembered)
    if (!creds) {
      // 비밀번호 칸이 없는 화면이면 아이디 단계일 수 있다 — 다음 단계에서 쓰려고 기억만 한다(보내지 않는다)
      const step = readUsernameStep()
      if (step) {
        stepUsername = step
        stepUsernameAt = now
        trace('username-step')
      } else {
        trace('no-password-value')
      }
      return // 비밀번호 값이 없으면 저장 제안을 띄우지 않는다
    }
    const signature = `${creds.username}:${creds.password}`
    if (signature === lastSignature && now - lastSentAt < 1000) {
      trace('duplicate')
      return
    }
    if (!withinRateLimit(now)) {
      trace('rate-limited')
      return
    }
    lastSignature = signature
    lastSentAt = now
    sentTimestamps.push(now)
    send({ host: location.host, username: creds.username, password: creds.password })
  }

  // 일반적인 폼 제출(캡처 단계 — 페이지 핸들러의 preventDefault 와 무관하게 이벤트는 도달한다).
  // 페이지 스크립트의 form.submit() 은 submit 이벤트를 일으키지 않는다 — 그 경우는 아래 클릭·Enter 가 잡는다
  document.addEventListener(
    'submit',
    (ev) => {
      if (!allowUntrusted && ev.isTrusted !== true) return
      attempt(ev.target instanceof HTMLFormElement ? ev.target : null)
    },
    true
  )
  // 로그인 버튼 클릭. 페이지가 submit 을 막거나(SPA) type="button" 버튼·링크의 JS 로 로그인하는 경우도 잡는다
  document.addEventListener(
    'click',
    (ev) => {
      if (!allowUntrusted && ev.isTrusted !== true) return
      const target = ev.target
      if (!(target instanceof Element)) return
      const clicked = target.closest(CAPTURE_CLICK_TARGET)
      if (!(clicked instanceof HTMLElement)) return
      const pw = detectPasswordElement()
      if (!pw) {
        // 아이디 단계의 '다음' 버튼 — 아이디만 기억한다
        if (isButtonish(clicked) || clicked.getAttribute('role') === 'button') attempt(null)
        return
      }
      if (!isLoginSubmitClick(clicked, pw)) {
        // 비밀번호가 채워진 화면의 다른 클릭만 기록한다(빈 로그인 화면의 클릭은 소음이다)
        if (pw.value) trace('click-not-login')
        return
      }
      attempt(formOf(pw))
    },
    true
  )
  // 비밀번호 칸에서 Enter. 폼 안이어도 페이지가 Enter 를 가로채 JS 로 로그인하면(현대H몰·패션플러스)
  // submit 이 일어나지 않으므로 여기서 직접 잡는다. 브라우저가 submit 도 일으키면 중복 방지가 거른다
  document.addEventListener(
    'keydown',
    (ev) => {
      if (!allowUntrusted && ev.isTrusted !== true) return
      if (ev.key !== 'Enter' || ev.isComposing) return
      const target = ev.target
      if (!(target instanceof HTMLInputElement) || target.type !== 'password') return
      attempt(formOf(target))
    },
    true
  )
}

// --- 화면을 덮는 레이어 감지 ------------------------------------------------
//
// 상품·주문 페이지에 브랜드 공지·쿠폰·앱 설치 유도 레이어가 뜨면, AI 는 그 존재를 모른 채
// 뒤에 있는 버튼을 누르려다 계속 실패한다. 먼저 "무엇이 덮고 있는지"를 알려 준다.
// 판정 규칙은 page-overlay 의 순수 함수가 맡는다(테스트 가능)

// 역할로 스스로 레이어라고 밝힌 요소들 — 깊이와 무관하게 본다
const OVERLAY_ROLE_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog'
// 그 밖의 고정 레이어는 body 에서 몇 단계 안쪽까지만 훑는다(전면 배너·바텀시트는 대개 얕다)
const OVERLAY_SCAN_DEPTH = 8
const OVERLAY_SCAN_MAX = 4000
const OVERLAY_LABEL_MAX = 60
// 민감 판정에 쓰는 레이어 본문 길이
const OVERLAY_TEXT_MAX = 400
// 한 번에 알릴 레이어 개수
const OVERLAY_MAX = 5
// 레이어 하나당 닫기 후보 개수
const OVERLAY_CLOSE_MAX = 5

/** 오버레이 후보 요소들(역할 선언 + body 얕은 층) */
function overlayCandidates(): HTMLElement[] {
  const body = document.body
  if (!body) return []
  const seen = new Set<HTMLElement>()
  const out: HTMLElement[] = []
  const push = (el: HTMLElement): void => {
    if (seen.has(el) || out.length >= OVERLAY_SCAN_MAX) return
    seen.add(el)
    out.push(el)
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(OVERLAY_ROLE_SELECTOR))) {
    push(el)
  }
  let level = Array.from(body.children).filter((c): c is HTMLElement => c instanceof HTMLElement)
  for (let d = 0; d < OVERLAY_SCAN_DEPTH && level.length > 0; d += 1) {
    const next: HTMLElement[] = []
    for (const el of level) {
      push(el)
      for (const child of Array.from(el.children)) {
        if (child instanceof HTMLElement) next.push(child)
      }
    }
    if (out.length >= OVERLAY_SCAN_MAX) break
    level = next.slice(0, OVERLAY_SCAN_MAX)
  }
  return out
}

/** 요소 하나에서 오버레이 판정에 필요한 값을 잰다 */
function overlaySignalsOf(el: HTMLElement): OverlaySignals {
  const cs = getComputedStyle(el)
  const rect = el.getBoundingClientRect?.()
  const vw = window.innerWidth || document.documentElement.clientWidth || 0
  const vh = window.innerHeight || document.documentElement.clientHeight || 0
  const area = vw * vh
  const w = rect ? Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)) : 0
  const h = rect ? Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0)) : 0
  const z = Number.parseInt(cs.zIndex, 10)
  const bg = (cs.backgroundColor ?? '').replace(/\s+/g, '')
  return {
    role: el.getAttribute('role') ?? '',
    ariaModal: el.getAttribute('aria-modal') === 'true',
    position: cs.position,
    zIndex: Number.isNaN(z) ? 0 : z,
    coverage: area > 0 ? (w * h) / area : 0,
    // 배경이 투명한데 클릭은 가로채는 "투명 덮개" 판정용
    transparentBg: bg === '' || bg === 'transparent' || /,0(\.0+)?\)$/.test(bg),
    pointerEvents: cs.pointerEvents ?? ''
  }
}

/** 레이어 하나를 결과 항목으로 만든다(닫기 후보는 registry 안에서만 고른다) */
function describeOverlay(el: HTMLElement, index: Map<HTMLElement, number>): PageOverlay {
  const body = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const aria = el.getAttribute('aria-label') ?? ''
  const heading = el.querySelector('h1, h2, h3, [role="heading"]')
  const headingText = (heading?.textContent ?? '').replace(/\s+/g, ' ').trim()
  // 투명 덮개는 글자가 없어 이름이 비는데, 이름 없는 레이어는 안내가 되지 않는다.
  // 그럴 때는 태그·class 로 어떤 층인지 알려 준다(예: transparent layer div.zipCodeWrap)
  const tag = el.tagName.toLowerCase()
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0]
  const fallback = `transparent layer ${cls ? `${tag}.${cls}` : tag}`
  const label = ((aria || headingText || body).trim() || fallback).slice(0, OVERLAY_LABEL_MAX)
  const overlayText = `${label} ${body.slice(0, OVERLAY_TEXT_MAX)}`
  // "로그인" 말고는 민감한 말이 없고, 비밀 입력칸도 없고, 페이지는 이미 로그인 상태다 →
  // 가입·로그인 유도 팝업이다. 닫아도 되는 레이어로 본다(무신사는 이걸 닫아야 구매 버튼이 풀린다)
  const signInPromo =
    isSignInPromptOnly(overlayText) &&
    el.querySelector('input[type="password"]') === null &&
    detectSignedInHint().signedIn
  const sensitive = isSensitiveOverlay(overlayText) && !signInPromo
  const closeIds: number[] = []
  // 결제·비밀번호·로그인 레이어는 닫기 후보를 아예 내놓지 않는다
  if (!sensitive) {
    for (const [node, id] of index) {
      if (closeIds.length >= OVERLAY_CLOSE_MAX) break
      if (node === el || !el.contains(node)) continue
      if (isCloseLabel(labelOf(node)) || isCloseLabel(node.getAttribute('aria-label') ?? '')) {
        closeIds.push(id)
      }
    }
  }
  return { id: index.get(el) ?? 0, label, closeIds, sensitive }
}

/**
 * 지금 화면을 덮고 있는 레이어들. 스냅샷을 새로 만들어 id 를 맞춘 뒤 판정한다
 * (SPA 는 화면이 바뀌어도 문서를 새로 만들지 않아 낡은 registry 가 남는다).
 * 겹친 레이어는 가장 안쪽만 남긴다 — 배경 dim 이 아니라 실제 모달을 알려야 한다
 */
export function detectOverlays(): PageOverlay[] {
  buildSnapshot()
  const index = new Map<HTMLElement, number>()
  for (const el of lastOrder) {
    const id = idOf.get(el)
    if (id !== undefined) index.set(el, id)
  }
  const visible: VisibilityCache = new Map()
  const found: HTMLElement[] = []
  for (const el of overlayCandidates()) {
    if (found.length >= OVERLAY_MAX) break
    if (!isVisible(el, visible)) continue
    if (!isOverlay(overlaySignalsOf(el))) continue
    found.push(el)
  }
  return found
    .filter((el) => !found.some((other) => other !== el && el.contains(other)))
    .map((el) => describeOverlay(el, index))
}

// --- 라벨 글자로 체크박스 켜기 ---------------------------------------------

/**
 * 라벨 글자가 text 와 같은 체크박스를 켠다. 체크박스가 화면에 숨어 있고(커스텀 모양) 라벨만 눌러야 켜지는
 * 동의 칸(페이코 PC 결제창 '전체 동의')을 위한 것이다 — 요소 목록에 안 잡혀 번호로 누를 수 없었다(실기 2026-09-25).
 * 이미 켜져 있으면 누르지 않는다(누르면 꺼진다).
 */
export function checkByLabel(text: string): string {
  const want = text.replace(/\s+/g, '')
  if (!want) return 'not-found'
  const labels = Array.from(document.querySelectorAll<HTMLLabelElement>('label'))
  for (const label of labels) {
    if ((label.textContent ?? '').replace(/\s+/g, '') !== want) continue
    const target =
      (label.htmlFor ? document.getElementById(label.htmlFor) : null) ??
      label.querySelector('input')
    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') continue
    if (target.checked) return 'already'
    label.click()
    // 커스텀 체크박스는 라벨 클릭을 자기 처리기로 되돌리기도 한다(실기: 페이코 '전체 동의'가 failed) —
    // 안 켜졌으면 체크박스 자체를 누르고, 그래도 안 되면 값을 켜고 변경 알림을 보낸다
    if (!target.checked) target.click()
    if (!target.checked) {
      target.checked = true
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return target.checked ? 'checked' : 'failed'
  }
  return 'not-found'
}

// --- 프레임 채널 동작 실행 -------------------------------------------------
//
// 메인 프로세스는 하위 프레임(iframe)의 격리 월드를 직접 실행할 수 없어서,
// 코드 문자열 대신 미리 정해진 동작 이름만 IPC 로 보낸다. 여기서는 그 이름을
// 이 문서의 함수로 이어 준다 — **자기 document 만** 다루며, 목록에 없는 이름은 무시한다

/** 메인이 보낸 동작 하나를 이 프레임에서 실행한다. 모르는 동작이면 null */
export function runAgentOp(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as {
    op?: unknown
    id?: unknown
    text?: unknown
    value?: unknown
    query?: unknown
    selector?: unknown
    submit?: unknown
    dir?: unknown
  }
  const id = typeof r.id === 'number' ? r.id : 0
  const text = typeof r.text === 'string' ? r.text : ''
  const value = typeof r.value === 'string' ? r.value : ''
  switch (r.op) {
    case 'snapshot':
      return buildSnapshot({
        ...(typeof r.query === 'string' ? { query: r.query } : {}),
        ...(typeof r.selector === 'string' ? { selector: r.selector } : {})
      })
    case 'textOf':
      return textOf(id)
    case 'click':
      return performClick(id)
    case 'type':
      return performType(id, text, r.submit === true)
    case 'select':
      return performSelect(id, value)
    case 'scroll':
      return performScroll(
        r.dir === 'up' ? 'up' : 'down',
        typeof r.id === 'number' ? r.id : undefined
      )
    case 'fillValue':
      return fillValue(id, value)
    case 'submitForm':
      return submitForm(id)
    case 'isSecretField':
      return isSecretField(id)
    case 'rectOf':
      return rectOf(id)
    case 'keypadSignals':
      return keypadSignals()
    case 'keypadLayout':
      return keypadLayout()
    case 'keypadUnlabeled':
      return keypadUnlabeled()
    case 'pressOnce':
      return pressOnce(id)
    case 'overlays':
      return detectOverlays()
    case 'checkByLabel':
      return checkByLabel(text)
    default:
      return null
  }
}
