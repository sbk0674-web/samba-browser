// 당근 채팅함 화면의 순수 계산(React 를 쓰지 않아 그대로 시험한다)

import {
  filterChannels,
  parseKoreanTime,
  type DaangnAccountDto,
  type DaangnChannelDto
} from '@shared/daangn'

/** 당근 목록의 시간만 있는 표시는 오늘이다. 확인된 날짜는 보존하며 원본 객체는 바꾸지 않는다. */
export function withNativeListOrder(channels: readonly DaangnChannelDto[], now = new Date()): DaangnChannelDto[] {
  const positions = new Map<number, number>()
  return channels.map(channel => {
    const position = positions.get(channel.accountId) ?? 0
    positions.set(channel.accountId, position + 1)
    const listOrder = Number.isInteger(channel.listOrder) && channel.listOrder! >= 0
      ? channel.listOrder : position
    const clockOnly = /^(오전|오후)\s*\d{1,2}:\d{2}$/.test(channel.lastAtText.trim())
    const today = clockOnly && (!Number.isFinite(channel.lastAt) || channel.lastAt <= 0)
      ? parseKoreanTime(`오늘 ${channel.lastAtText.trim()}`, now) : 0
    if (today > 0) return { ...channel, listOrder, lastAt: today, lastAtSource: 'list', lastAtPrecise: true }
    return listOrder === channel.listOrder ? channel : { ...channel, listOrder }
  })
}

/** 오늘은 시간만, 확인된 이전 날짜는 날짜와 시간을 표시한다. */
export function lastAtLabel(text: string, lastAt: number, now = Date.now(), precise = false): string {
  // 본문에서 확인한 오늘 시각에 목록의 오래된 '2일 전'을 계속 붙이지 않는다.
  if (precise && Number.isFinite(lastAt) && lastAt > 0 &&
      !/^(?:(?:오전|오후)\s*)?\d{1,2}:\d{2}$/.test(text.trim())) {
    const stamp = new Date(lastAt + 9 * 3_600_000)
    text = `${String(stamp.getUTCHours()).padStart(2, '0')}:${String(stamp.getUTCMinutes()).padStart(2, '0')}`
  }
  if (!/^(?:(?:오전|오후)\s*)?\d{1,2}:\d{2}$/.test(text.trim())) return text
  if (!Number.isFinite(lastAt) || lastAt <= 0) return text
  const kstDay = (at: number): number => Math.floor((at + 9 * 3_600_000) / 86_400_000)
  const days = kstDay(now) - kstDay(lastAt)
  if (days === 0) return text
  if (days === 1) return `어제 ${text}`
  const date = new Date(lastAt + 9 * 3_600_000)
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}.${mm}.${dd} ${text}`
}

/** 통합 목록에 보일 채널 — 안읽음만/전체, 계정 필터, 최근순 */
export function visibleChannels(state: {
  channels: readonly DaangnChannelDto[]
  selectedAccountId: number | null
  unreadOnly: boolean
}): DaangnChannelDto[] {
  return filterChannels(state.channels, {
    accountId: state.selectedAccountId,
    unreadOnly: state.unreadOnly
  })
}

/** 왼쪽 두 패널의 폭 범위(px) — def 가 처음 폭 */
export const PANEL_WIDTHS = {
  account: { min: 140, max: 320, def: 190 },
  list: { min: 240, max: 560, def: 320 }
} as const

/** 끌어서 바꾼 폭을 범위 안 정수로 맞춘다. 숫자가 아니면 기본 폭 */
export function clampPanelWidth(kind: keyof typeof PANEL_WIDTHS, w: number): number {
  const r = PANEL_WIDTHS[kind]
  if (!Number.isFinite(w)) return r.def
  return Math.min(r.max, Math.max(r.min, Math.round(w)))
}

/** 계정 별칭. 모르는 계정은 빈 글 */
export function accountLabelOf(accounts: readonly DaangnAccountDto[], id: number): string {
  return accounts.find((a) => a.id === id)?.label ?? ''
}
