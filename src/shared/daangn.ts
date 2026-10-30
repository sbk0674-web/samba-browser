// 당근 통합 채팅함 공용 타입·상수·순수 함수. 메인·렌더러·preload 가 모두 이 파일 하나만 본다.
// 계정 세션·채팅 본문은 이 PC 의 숨은 뷰 안에만 있고, 여기에는 목록 표시에 필요한 값만 오간다

export const DAANGN_ACCOUNT_STATES = ['loading', 'logged_in', 'expired', 'read_failed'] as const
export type DaangnAccountState = (typeof DAANGN_ACCOUNT_STATES)[number]

export interface DaangnAccountDto {
  id: number
  label: string
  displayName: string
  profileImage: string | null
  state: DaangnAccountState
  /** 이 계정의 안 읽은 메시지 합계(목록에서 센다) */
  unread: number
}

export interface DaangnChannelDto {
  accountId: number
  roomId: string
  peerName: string
  region: string
  lastMessage: string
  /** 마지막 메시지 시각(epoch ms). 원본 날짜 근거가 없으면 0(시각만으로 오늘을 추정하지 않는다) */
  lastAt: number
  lastAtText: string
  /** 날짜가 확인된 원본 출처. 구버전의 시각만으로 만든 lastAt에는 이 표시가 없다 */
  lastAtSource?: 'message' | 'list'
  /** 원본에 날짜와 분 단위 시각이 함께 있을 때만 true */
  lastAtPrecise?: boolean
  unread: number
  productTitle: string
  productThumb: string | null
}

export interface DaangnTemplateDto {
  id: number
  text: string
  sortOrder: number
}

/** 창 안 오른쪽 영역(렌더러 CSS 픽셀 = 네이티브 뷰 DIP) */
export interface DaangnBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 서비스가 렌더러에 보내는 통합 상태 */
export interface DaangnStateDto {
  accounts: DaangnAccountDto[]
  channels: DaangnChannelDto[]
}

/** 답변 템플릿 한 개의 글자 수 상한 */
export const DAANGN_TEMPLATE_MAX = 500

/**
 * 안 읽은 수 표기를 숫자로 읽는다. "3"→3, "99+"→99, 글자만 있는 배지("N")→1.
 * 못 읽겠다고 0 으로 두면 안 읽은 채팅이 목록에서 빠지므로, 배지 글자가 있으면 최소 1 로 본다
 */
export function parseUnread(text: string): number {
  const t = text.trim()
  if (t === '') return 0
  const m = /\d+/.exec(t)
  if (m) return Number(m[0])
  return 1
}

/**
 * 원본에 날짜가 있는 시각·상대 표기만 KST epoch ms 로 바꾼다.
 * "오후 03:26"처럼 날짜가 없는 글은 조회 시각으로 채우지 않고 0(미확인)으로 둔다.
 */
export function parseKoreanTime(text: string, now: Date): number {
  const t = text.trim()
  const offset = 9 * 3_600_000
  const kst = new Date(now.getTime() + offset)
  const day = (y: number, m: number, d: number, h = 0, mi = 0): number => {
    const check = new Date(Date.UTC(y, m, d, h, mi))
    return check.getUTCFullYear() === y && check.getUTCMonth() === m && check.getUTCDate() === d &&
      h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? check.getTime() - offset : 0
  }
  const clock = (half: string, h: string, m: string): number[] | null =>
    +h >= 1 && +h <= 12 && +m <= 59 ? [(+h % 12) + (half === '오후' ? 12 : 0), +m] : null
  const full = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*[월화수목금토일]요일)?(?:\s+(오전|오후)\s*(\d{1,2}):(\d{2}))?$/.exec(t)
  if (full) {
    const hm = full[4] ? clock(full[4], full[5], full[6]) : [0, 0]
    return hm ? day(+full[1], +full[2] - 1, +full[3], hm[0], hm[1]) : 0
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(t)
  if (iso) {
    const at = Date.parse(t)
    return day(+iso[1], +iso[2] - 1, +iso[3]) && Number.isFinite(at) ? at : 0
  }
  const relativeDay = /^(오늘|어제)(?:\s+(오전|오후)\s*(\d{1,2}):(\d{2}))?$/.exec(t)
  if (relativeDay) {
    const hm = relativeDay[2] ? clock(relativeDay[2], relativeDay[3], relativeDay[4]) : [12, 0]
    return hm ? day(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), hm[0], hm[1]) -
      (relativeDay[1] === '어제' ? 86_400_000 : 0) : 0
  }
  if (t === '방금' || t === '방금 전') return now.getTime()
  const rel = /^(\d+)\s*(분|시간|일|주|달|개월|년)\s*전$/.exec(t)
  if (rel) {
    const unit: Record<string, number> = {
      분: 60_000,
      시간: 3_600_000,
      일: 86_400_000,
      주: 7 * 86_400_000,
      달: 30 * 86_400_000,
      개월: 30 * 86_400_000,
      년: 365 * 86_400_000
    }
    return now.getTime() - Number(rel[1]) * unit[rel[2]]
  }
  const md = /^(\d{1,2})월\s*(\d{1,2})일$/.exec(t)
  if (md) {
    const at = day(kst.getUTCFullYear(), +md[1] - 1, +md[2])
    return at > now.getTime() ? day(kst.getUTCFullYear() - 1, +md[1] - 1, +md[2]) : at
  }
  return 0
}

/**
 * 통합 목록에 보일 채널. unreadOnly 면 안 읽은 것만, accountId 가 있으면 그 계정만.
 * 최근 시각이 먼저이고 같으면 roomId 사전순(깜빡이지 않는 안정 정렬). 원본은 바꾸지 않는다
 */
export function filterChannels(
  list: readonly DaangnChannelDto[],
  opts: { accountId: number | null; unreadOnly: boolean }
): DaangnChannelDto[] {
  const out = list.filter(
    (c) => (opts.accountId === null || c.accountId === opts.accountId) && (!opts.unreadOnly || c.unread > 0)
  )
  return out.sort((a, b) => b.lastAt - a.lastAt || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0))
}

/** 계정별 안 읽은 합계. 채널이 하나도 없는 계정은 키가 없다 */
export function unreadByAccount(list: readonly DaangnChannelDto[]): Record<number, number> {
  const out: Record<number, number> = {}
  for (const c of list) out[c.accountId] = (out[c.accountId] ?? 0) + c.unread
  return out
}
