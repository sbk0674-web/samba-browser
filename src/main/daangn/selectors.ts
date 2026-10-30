// chat.daangn.com(당근채팅 웹) 화면을 읽고 입력칸을 채우는 코드. 당근 화면이 바뀌면 이 파일만 고친다.
//
// 선택자는 2026-10-21 로그인된 화면에서 직접 확인한 것이다(목록 줄은 `a[href*="/room/"]`,
// 안쪽 글자는 `.preview-nickname`·`.sub-text`·`.description-text`, 안 읽은 배지는 `.unread-count-wrapper`).
// `css-xxxx` 같은 해시 클래스는 빌드마다 바뀌므로 쓰지 않는다.
// 숨긴(display:none) 요소도 읽어야 하므로 글자는 innerText 가 아니라 textContent 로 읽는다.

import { parseKoreanTime, parseUnread, type DaangnChannelDto } from '../../shared/daangn'

export const SELECTORS = {
  /** 채팅 목록의 줄(방 링크) */
  row: 'a[href*="/room/"]',
  peerName: '.preview-nickname',
  /** "지역 · 시각" 또는 시각만 있는 글 조각들 */
  subText: '.preview-title-wrap .sub-text span',
  lastMessage: '.description-text',
  messageTime: '.preview-title-wrap .sub-text time[datetime]',
  /** 상품 썸네일 — alt 가 상품 이름이다 */
  productThumb: 'img.preview-image',
  /** 안 읽은 수 배지(원형, 안 읽은 줄에만 있다) */
  unread: '.unread-count-wrapper',
  /** 이 계정의 닉네임(목록 머리) */
  meName: '.nickname-area',
  meImage: 'nav.sidebar img',
  /** 방 화면 아래 메시지 입력칸 */
  textarea: 'textarea[placeholder*="메시지"]'
} as const

/** 오른쪽 영역에 방 화면만 보이게, 당근 자체 목록 패널과 프로필 사이드바를 가린다(DOM 은 남는다) */
export function buildHideListCss(): string {
  return [
    'main.body nav.sidebar { display: none !important; }',
    'main.body nav:not(.sidebar):has(.preview-nickname) { display: none !important; }',
    'main.body nav:not(.sidebar):has(.nickname-area) { display: none !important; }'
  ].join('\n')
}

export interface RawRow {
  href: string
  peerName: string
  region: string
  lastMessage: string
  timeText: string
  /** 같은 목록 행의 datetime 또는 현재 방 마지막 메시지의 날짜+시각. 조회 시각은 넣지 않는다 */
  messageAt?: string
  unreadText: string
  productTitle: string
  productThumb: string | null
}

export interface RawScan {
  me: { displayName: string; profileImage: string | null } | null
  rows: RawRow[]
}

/** 페이지 안에서 실행해 RawScan 을 돌려주는 스크립트(읽기만 한다 — 서버 요청도 클릭도 없다) */
export function buildScanScript(): string {
  const S = JSON.stringify(SELECTORS)
  return `(() => {
  const S = ${S}
  const text = (el) => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '')
  const compact = (s) => s.replace(/\\s+/g, '')
  const clockKey = (s) => {
    const m = s.match(/^(?:(오전|오후)\\s*)?(\\d{1,2}):(\\d{2})$/)
    return m ? (m[1] ? +m[2] % 12 + (m[1] === '오후' ? 12 : 0) : +m[2]) + ':' + m[3] : ''
  }
  const roomId = (typeof location === 'object' && location.pathname.match(/^\\/room\\/([^/?#]+)$/) || [])[1] || ''
  const list = roomId ? document.querySelector('[aria-label="메시지 리스트"]') : null
  let day = '', latest = null
  for (const el of list ? list.children : []) {
    const body = text(el)
    if (!body) continue
    latest = null
    if (el.classList.contains('day-divider')) {
      const date = body.match(/^\\d{4}년\\s*\\d{1,2}월\\s*\\d{1,2}일/)
      day = date ? date[0] : ''
      continue
    }
    const clocks = [...body.matchAll(/(오전|오후)\\s*\\d{1,2}:\\d{2}/g)]
    if (day && clocks.length === 1) latest = {
      message: compact(body.replace(clocks[0][0], '')),
      clock: clockKey(clocks[0][0]),
      at: day + ' ' + clocks[0][0]
    }
  }
  const rows = [...document.querySelectorAll(S.row)].map((a) => {
    const subs = [...a.querySelectorAll(S.subText)].map(text).filter((t) => t && t !== '·')
    const timeText = subs.length ? subs[subs.length - 1] : ''
    const region = subs.length > 1 ? subs[0] : ''
    const thumb = a.querySelector(S.productThumb)
    const href = a.getAttribute('href') || ''
    const id = (href.match(/\\/room\\/([^/?#]+)/) || [])[1]
    const lastMessage = text(a.querySelector(S.lastMessage))
    const stamp = a.querySelector(S.messageTime)
    const messageAt = id === roomId && latest && lastMessage && latest.message === compact(lastMessage)
      && (!clockKey(timeText) || clockKey(timeText) === latest.clock)
      ? latest.at : stamp ? stamp.getAttribute('datetime') || '' : ''
    return {
      href,
      peerName: text(a.querySelector(S.peerName)),
      region,
      lastMessage,
      timeText,
      messageAt,
      unreadText: text(a.querySelector(S.unread)),
      productTitle: thumb ? thumb.getAttribute('alt') || '' : '',
      productThumb: thumb ? thumb.getAttribute('src') : null
    }
  })
  const nameEl = document.querySelector(S.meName)
  const img = document.querySelector(S.meImage)
  const me = nameEl ? { displayName: text(nameEl), profileImage: img ? img.getAttribute('src') : null } : null
  return { me, rows }
})()`
}

/**
 * 입력칸에 글을 넣는 스크립트. React 가 값 변경을 알아채도록 native setter 와 input 이벤트를 쓴다.
 * 글은 JSON.stringify 로 담아 줄바꿈·따옴표·이모지가 문자열 밖으로 새지 않게 한다. 성공이면 true
 */
export function buildFillScript(text: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(SELECTORS.textarea)})
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus()
  return el.value === ${JSON.stringify(text)}
})()`
}

/**
 * 읽기 결과를 채널 목록으로 바꾼다. 방 주소가 아닌 줄은 건너뛴다.
 * 객체가 아니거나 rows 가 배열이 아니면 던진다(읽기 실패로 취급 — 호출한 쪽이 상태를 바꾼다)
 */
export function parseScan(
  raw: unknown,
  accountId: number,
  now: Date,
  previous: readonly DaangnChannelDto[] = []
): { me: RawScan['me']; channels: DaangnChannelDto[] } {
  if (typeof raw !== 'object' || raw === null) throw new Error('채팅 목록을 읽지 못했어요')
  const r = raw as { me?: unknown; rows?: unknown }
  if (!Array.isArray(r.rows)) throw new Error('채팅 목록을 읽지 못했어요')
  const me = readMe(r.me)
  const channels: DaangnChannelDto[] = []
  for (const item of r.rows) {
    const row = item as Partial<RawRow>
    const m = /\/room\/([^/?#]+)/.exec(typeof row.href === 'string' ? row.href : '')
    if (!m) continue
    const timeText = str(row.timeText)
    const messageAt = str(row.messageAt)
    const lastMessage = str(row.lastMessage)
    const unread = parseUnread(str(row.unreadText))
    const known = previous.find(c => (c.lastAtSource === 'message' || c.lastAtSource === 'list') &&
      Number.isFinite(c.lastAt) && c.lastAt > 0 && c.accountId === accountId && c.roomId === m[1] &&
      c.lastMessage === lastMessage && c.lastAtText === timeText && c.unread >= unread)
    // 확인했던 같은 메시지의 날짜는 유지한다. 메시지가 바뀌면 예전 날짜를 새 글에 붙이지 않는다.
    const listAt = parseKoreanTime(timeText, now)
    const lastAt = messageAt ? parseKoreanTime(messageAt, now) : listAt || known?.lastAt || 0
    const sourceText = messageAt || timeText
    const lastAtSource = lastAt > 0 ? (messageAt ? 'message' : listAt ? 'list' : known?.lastAtSource) : undefined
    const lastAtPrecise = lastAt > 0 && (messageAt || listAt
      ? /T\d{2}:\d{2}|(?:오전|오후)\s*\d{1,2}:\d{2}/.test(sourceText) : known?.lastAtPrecise === true)
    channels.push({
      accountId,
      roomId: m[1],
      peerName: str(row.peerName),
      region: str(row.region),
      lastMessage,
      lastAt,
      lastAtText: timeText,
      lastAtSource,
      lastAtPrecise,
      unread,
      productTitle: str(row.productTitle),
      productThumb: typeof row.productThumb === 'string' ? row.productThumb : null
    })
  }
  return { me, channels }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function readMe(v: unknown): RawScan['me'] {
  if (typeof v !== 'object' || v === null) return null
  const o = v as { displayName?: unknown; profileImage?: unknown }
  return {
    displayName: str(o.displayName),
    profileImage: typeof o.profileImage === 'string' ? o.profileImage : null
  }
}
