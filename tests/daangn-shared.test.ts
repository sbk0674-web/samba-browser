// 당근 채팅함 공용 순수 함수·설정 키 — 안 읽은 수·시각 파싱, 목록 거르기·정렬, 새 설정 기본값
import { describe, expect, it } from 'vitest'
import {
  filterChannels,
  parseKoreanTime,
  parseUnread,
  unreadByAccount,
  type DaangnChannelDto
} from '../src/shared/daangn'
import { parseSettings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'

function ch(partial: Partial<DaangnChannelDto>): DaangnChannelDto {
  return {
    accountId: 1,
    roomId: 'r',
    peerName: '',
    region: '',
    lastMessage: '',
    lastAt: 0,
    lastAtText: '',
    unread: 0,
    productTitle: '',
    productThumb: null,
    ...partial
  }
}

describe('parseUnread', () => {
  it('숫자는 그대로 읽는다', () => {
    expect(parseUnread('3')).toBe(3)
    expect(parseUnread('  12 ')).toBe(12)
    expect(parseUnread('0')).toBe(0)
  })
  it('"99+" 는 99 로 읽는다', () => {
    expect(parseUnread('99+')).toBe(99)
  })
  it('글자만 있는 배지("N")는 안 읽음으로 보고 1 로 읽는다', () => {
    expect(parseUnread('N')).toBe(1)
  })
  it('빈 값은 0', () => {
    expect(parseUnread('')).toBe(0)
  })
})

describe('parseKoreanTime', () => {
  // 2026-10-21 16:00 (로컬 시간)
  const now = new Date(2026, 9, 21, 16, 0, 0)
  const at = (y: number, m: number, d: number, h = 0, mi = 0): number =>
    new Date(y, m - 1, d, h, mi, 0, 0).getTime()

  it('오후·오전 시각만으로 오늘 날짜를 만들지 않는다', () => {
    expect(parseKoreanTime('오후 03:26', now)).toBe(0)
    expect(parseKoreanTime('오전 12:05', now)).toBe(0)
    expect(parseKoreanTime('오후 12:10', now)).toBe(0)
  })
  it('미래 시각이라는 이유만으로 어제 날짜를 만들지 않는다', () => {
    expect(parseKoreanTime('오후 11:41', now)).toBe(0)
    expect(parseKoreanTime('오후 03:59', now)).toBe(0)
  })
  it('"어제" 는 어제 안의 시각이다', () => {
    const v = parseKoreanTime('어제', now)
    expect(v).toBeGreaterThanOrEqual(at(2026, 10, 20))
    expect(v).toBeLessThan(at(2026, 10, 21))
  })
  it('월일·연월일은 그날 0시로 읽는다', () => {
    expect(parseKoreanTime('10월 20일', now)).toBe(at(2026, 10, 20))
    expect(parseKoreanTime('2025년 3월 2일', now)).toBe(at(2025, 3, 2))
  })
  it('"N분·시간·일·주·달·년 전" 같은 상대 표기는 지금에서 거꾸로 센다(실제 화면에 "6달 전" 이 있다)', () => {
    expect(parseKoreanTime('5분 전', now)).toBe(now.getTime() - 5 * 60_000)
    expect(parseKoreanTime('3시간 전', now)).toBe(now.getTime() - 3 * 3_600_000)
    expect(parseKoreanTime('2일 전', now)).toBe(now.getTime() - 2 * 86_400_000)
    expect(parseKoreanTime('1주 전', now)).toBe(now.getTime() - 7 * 86_400_000)
    expect(parseKoreanTime('6달 전', now)).toBe(now.getTime() - 6 * 30 * 86_400_000)
    expect(parseKoreanTime('2개월 전', now)).toBe(now.getTime() - 2 * 30 * 86_400_000)
    expect(parseKoreanTime('1년 전', now)).toBe(now.getTime() - 365 * 86_400_000)
  })
  it('"방금" 은 지금, 모르는 글은 0', () => {
    expect(parseKoreanTime('방금', now)).toBe(now.getTime())
    expect(parseKoreanTime('???', now)).toBe(0)
  })
})

describe('filterChannels', () => {
  const list = [
    ch({ accountId: 1, roomId: 'b', lastAt: 200, unread: 2 }),
    ch({ accountId: 2, roomId: 'a', lastAt: 300, unread: 0 }),
    ch({ accountId: 1, roomId: 'a', lastAt: 200, unread: 1 }),
    ch({ accountId: 2, roomId: 'c', lastAt: 100, unread: 5 })
  ]
  it('안 읽음만 보면 unread>0 만 최근순이고 같은 시각은 roomId 순', () => {
    const out = filterChannels(list, { accountId: null, unreadOnly: true })
    expect(out.map((c) => `${c.accountId}${c.roomId}`)).toEqual(['1a', '1b', '2c'])
  })
  it('계정을 고르면 그 계정만', () => {
    const out = filterChannels(list, { accountId: 2, unreadOnly: false })
    expect(out.map((c) => c.roomId)).toEqual(['a', 'c'])
  })
  it('원본 배열을 바꾸지 않는다', () => {
    const before = list.map((c) => c.roomId)
    filterChannels(list, { accountId: null, unreadOnly: false })
    expect(list.map((c) => c.roomId)).toEqual(before)
  })
})

describe('unreadByAccount', () => {
  it('계정별 합계이고 채널이 없는 계정은 키가 없다', () => {
    const out = unreadByAccount([
      ch({ accountId: 1, unread: 2 }),
      ch({ accountId: 1, roomId: 'x', unread: 3 }),
      ch({ accountId: 2, unread: 0 })
    ])
    expect(out[1]).toBe(5)
    expect(out[2]).toBe(0)
    expect(3 in out).toBe(false)
  })
})

describe('당근 설정 키', () => {
  it('빈 설정에서 기본값이 채워진다', () => {
    const s = parseSettings({})
    expect(s.daangnEnabled).toBe(true)
    expect(s.daangnWarmViews).toBe(8)
    expect(s.daangnTempViews).toBe(3)
    expect(s.daangnScanIntervalMs).toBe(5000)
    expect(s.daangnRotateIntervalSec).toBe(120)
    expect(s.daangnNotify).toBe(true)
  })
  it('이 PC 의 사정이라 동기화 키에 없다', () => {
    const keys = SYNCED_SETTING_KEYS as readonly string[]
    expect(keys.some((k) => k.startsWith('daangn'))).toBe(false)
  })
})
