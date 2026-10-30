import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { runInNewContext } from 'node:vm'
import { buildScanScript, parseScan } from '../src/main/daangn/selectors'
import { parseKoreanTime } from '../src/shared/daangn'
import { findOrderCandidates } from '../src/main/daangn/order-watch'
import * as view from '../src/renderer/src/components/daangn/daangn-view'

const now = new Date('2026-10-30T16:10:00+09:00')
const yesterday = Date.parse('2026-10-29T15:52:00+09:00')
const today = Date.parse('2026-10-30T15:45:00+09:00')
function row(room: string, timeText = '오후 03:52', extra = {}) {
  return { href: `/room/${room}`, peerName: room, lastMessage: '네 알겠습니다',
    timeText, unreadText: '1', ...extra }
}
function scan(options: { date?: string; body?: string; room?: string; machine?: string } = {}) {
  const dom = new JSDOM(`<a href="/room/flower">
    <span class="preview-nickname">정직한꽃집이웃</span>
    <div class="preview-title-wrap"><div class="sub-text"><span>오후 03:52</span>
    ${options.machine ? `<time datetime="${options.machine}"></time>` : ''}</div></div>
    <span class="description-text">네 알겠습니다</span></a>
    <a href="/room/gana"><span class="preview-nickname">가나</span>
    <div class="preview-title-wrap"><div class="sub-text"><span>오후 03:45</span>
    <time datetime="2026-10-30T15:45:00+09:00"></time></div></div>
    <span class="description-text">다른 채팅</span></a>
    <div aria-label="메시지 리스트">
    ${options.date === '' ? '' : `<div class="day-divider">${options.date ?? '2026년 10월 29일 목요일'}</div>`}
    <div>${options.body ?? '네 알겠습니다 오후 03:52'}</div></div>`,
    { url: `https://chat.daangn.com/room/${options.room ?? 'flower'}` })
  return runInNewContext(buildScanScript(), { document: dom.window.document, location: dom.window.location })
}

describe('당근 마지막 메시지 날짜 근거', () => {
  it.each(['오후 03:52', '오전 12:05', '오후 11:41', '15:52'])('%s에 조회한 오늘/어제 날짜를 붙이지 않는다', text => {
    expect(parseKoreanTime(text, now)).toBe(0)
  })
  it.each(['2026년 10월 29일 오후 03:52', '2026-10-29T15:52:00+09:00'])('실제 날짜와 시각을 KST로 읽는다: %s', text => {
    expect(parseKoreanTime(text, now)).toBe(yesterday)
  })
  it('날짜가 틀린 원본은 다른 날로 보정하지 않는다', () => {
    expect(parseKoreanTime('2026년 2월 30일 오후 03:52', now)).toBe(0)
  })
  it('어제 15:52 꽃집이 오늘 15:45 가나보다 아래로 간다', () => {
    const { channels } = parseScan(scan(), 1, now)
    expect(channels.map(c => c.lastAt)).toEqual([yesterday, today])
    expect(view.visibleChannels({ channels, selectedAccountId: null, unreadOnly: false }).map(c => c.peerName))
      .toEqual(['가나', '정직한꽃집이웃'])
  })
  it('목록 행 자체의 machine 날짜도 사용한다', () => {
    const { channels } = parseScan(scan({ date: '', machine: '2026-10-29T15:52:00+09:00' }), 1, now)
    expect(channels[0].lastAt).toBe(yesterday)
  })
  it.each([
    { date: '' }, { date: '날짜 미확인' }, { room: 'other' },
    { body: '다른 메시지 오후 03:52' }, { body: '네 알겠습니다 오후 03:52 오후 04:00' },
    { body: '네 알겠습니다 오후 03:51' }
  ])('날짜/방/마지막 메시지가 확인되지 않으면 미확인: %j', options => {
    expect(parseScan(scan(options), 1, now).channels[0].lastAt).toBe(0)
  })
  it('다른 방으로 본문 날짜를 옮기지 않는다', () => {
    const { channels } = parseScan(scan({ room: 'gana' }), 1, now)
    expect(channels[0].lastAt).toBe(0)
    expect(channels[1].lastAt).toBe(today)
  })
  it('열었던 방의 검증된 날짜는 자정이 지나도 조회 날짜로 바뀌지 않는다', () => {
    const old = parseScan({ rows: [row('flower', '오후 03:52', { messageAt: '2026년 10월 29일 오후 03:52' })] }, 1, now).channels
    const next = parseScan({ rows: [row('flower')] }, 1, new Date('2026-10-31T00:01:00+09:00'), old)
    expect(next.channels[0].lastAt).toBe(yesterday)
  })
  it.each([
    { lastMessage: '새 메시지' }, { timeText: '오후 03:53' }, { unreadText: '2' }
  ])('새 메시지/시간/안읽음 증가에는 이전 본문 날짜를 재사용하지 않는다: %j', extra => {
    const old = parseScan({ rows: [row('flower', '오후 03:52', { messageAt: '2026년 10월 29일 오후 03:52' })] }, 1, now).channels
    expect(parseScan({ rows: [row('flower', '오후 03:52', extra)] }, 1, now, old).channels[0].lastAt).toBe(0)
  })
  it('같은 방 ID라도 다른 계정의 날짜를 가져오지 않는다', () => {
    const old = parseScan({ rows: [row('flower', '오후 03:52', { messageAt: '2026년 10월 29일 오후 03:52' })] }, 1, now).channels
    expect(parseScan({ rows: [row('flower')] }, 2, now, old).channels[0].lastAt).toBe(0)
  })
  it('출처 없는 기존 오늘 추정값은 같은 메시지라도 승계하지 않는다', () => {
    const old = parseScan({ rows: [row('flower')] }, 1, now).channels
      .map(c => ({ ...c, lastAt: today, lastAtSource: undefined }))
    expect(parseScan({ rows: [row('flower')] }, 1, now, old).channels[0].lastAt).toBe(0)
  })
  it('정밀 날짜와 시각은 후보에도 그대로 전달한다', () => {
    const channels = parseScan({ rows: [row('flower', '15:52', {
      messageAt: '2026-10-29T15:52:00+09:00', productTitle: '상품'
    })] }, 1, now).channels
    expect(findOrderCandidates(channels, yesterday - 1)).toMatchObject([{ lastAt: yesterday, lastAtPrecise: true }])
  })
  it.each(['수거 날짜를 선택해 주세요.', '기사님이 택배를 수거할 예정이에요.', '새로운 문의'])('날짜 불명이어도 수거 신호/새 안읽음은 본문 확인 후보로 남는다: %s', lastMessage => {
    const channels = parseScan({ rows: [row('flower', '15:52', { lastMessage, productTitle: '상품' })] }, 1, now).channels
    expect(findOrderCandidates(channels, today)).toMatchObject([{ lastAt: 0, lastAtPrecise: false }])
  })
  it('날짜가 확인된 기준 이전 글은 수거 신호라도 건너뛴다', () => {
    const channels = parseScan({ rows: [row('flower', '15:52', {
      lastMessage: '수거 날짜를 선택해 주세요.', messageAt: '2026-10-29T15:52:00+09:00', productTitle: '상품'
    })] }, 1, now).channels
    expect(findOrderCandidates(channels, today)).toEqual([])
  })
  it('같은 시각·본문이라도 새 원본 날짜가 있으면 옛 날짜를 덮고 cutoff를 다시 판정한다', () => {
    const old = parseScan({ rows: [row('flower', '15:52', {
      messageAt: '2026-10-29T15:52:00+09:00', productTitle: '상품'
    })] }, 1, now).channels
    const channels = parseScan({ rows: [row('flower', '15:52', {
      messageAt: '2026-10-30T15:52:00+09:00', productTitle: '상품'
    })] }, 1, now, old).channels
    expect(findOrderCandidates(channels, today)).toMatchObject([{
      lastAt: Date.parse('2026-10-30T15:52:00+09:00'), lastAtPrecise: true
    }])
  })
  it('날짜 없는 읽은 일반 채팅은 수집 후보를 늘리지 않는다', () => {
    const channels = parseScan({ rows: [row('flower', '15:52', { unreadText: '', productTitle: '상품' })] }, 1, now).channels
    expect(findOrderCandidates(channels, today)).toEqual([])
  })
  it('날짜 없는 읽은 수거 안내도 긴급 후보에서 탈락하지 않는다', () => {
    const channels = parseScan({ rows: [row('flower', '15:52', {
      lastMessage: '수거 날짜를 선택해 주세요.', unreadText: '', productTitle: '상품'
    })] }, 1, now).channels
    expect(findOrderCandidates(channels, today)).toMatchObject([{ lastAt: 0, lastAtPrecise: false, previewSignal: 'pickup_request' }])
  })
})

describe('날짜 표시', () => {
  const label = (text: string, at: number) => {
    const fn = (view as unknown as Record<string, (...args: unknown[]) => string>).lastAtLabel
    expect(fn, '화면 날짜 표시 함수를 직접 검증한다').toBeTypeOf('function')
    return fn(text, at, now.getTime())
  }
  it('날짜 불명은 오늘처럼 표시하지 않는다', () => {
    expect(label('오후 03:52', 0)).toBe('날짜 미확인 오후 03:52')
  })
  it('KST 어제와 오늘을 구분한다', () => {
    expect(label('오후 03:52', yesterday)).toBe('어제 오후 03:52')
    expect(label('15:45', today)).toBe('15:45')
  })
  it('그제보다 오래된 메시지는 무조건 어제라고 하지 않는다', () => {
    expect(label('15:52', Date.parse('2026-10-28T15:52:00+09:00'))).toBe('2026.10.28 15:52')
  })
})
