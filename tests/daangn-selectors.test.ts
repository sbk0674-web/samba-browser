// 당근 채팅 화면 읽기 결과 해석·주소 판정·입력칸 채우기 스크립트 — 순수 함수만 시험한다
import { describe, expect, it } from 'vitest'
import { buildFillScript, parseScan } from '../src/main/daangn/selectors'
import { classifyChatUrl, isAllowedChatUrl, roomIdOf } from '../src/main/daangn/url-guard'

const NOW = new Date(2026, 9, 21, 16, 0, 0)

function row(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    href: '/room/UMTA1ODgtMjA0NzIxMTY',
    peerName: '당근당근바니바니',
    region: '대명2동',
    lastMessage: '네고 가능할까요?',
    timeText: '오후 03:32',
    unreadText: '3',
    productTitle: '고양이 그림 액자',
    productThumb: 'https://img/x.webp',
    ...partial
  }
}

describe('parseScan', () => {
  it('목록 줄을 채널로 바꾸고 roomId·시각·안 읽은 수를 읽는다', () => {
    const out = parseScan(
      { me: { displayName: '앙그류', profileImage: null }, rows: [row(), row({ href: '/room/ABC', unreadText: '99+', timeText: '어제' })] },
      7,
      NOW
    )
    expect(out.me).toEqual({ displayName: '앙그류', profileImage: null })
    expect(out.channels).toHaveLength(2)
    expect(out.channels[0]).toMatchObject({
      accountId: 7,
      roomId: 'UMTA1ODgtMjA0NzIxMTY',
      peerName: '당근당근바니바니',
      unread: 3,
      lastAt: 0, // 날짜 근거 없는 목록 시각은 미확인
      lastAtText: '오후 03:32'
    })
    expect(out.channels[1]).toMatchObject({ roomId: 'ABC', unread: 99 })
  })

  it('방 주소가 아닌 줄은 건너뛴다', () => {
    const out = parseScan({ me: null, rows: [row({ href: '/settings' }), row({ href: '' }), row()] }, 1, NOW)
    expect(out.channels).toHaveLength(1)
  })

  it('배지 글자만 있는 줄도 안 읽음(1)으로 읽는다', () => {
    const out = parseScan({ me: null, rows: [row({ unreadText: 'N' })] }, 1, NOW)
    expect(out.channels[0].unread).toBe(1)
  })

  it('객체가 아닌 입력은 읽기 실패로 던진다', () => {
    expect(() => parseScan(null, 1, NOW)).toThrow()
    expect(() => parseScan('x', 1, NOW)).toThrow()
    expect(() => parseScan({ me: null }, 1, NOW)).toThrow()
  })
})

describe('주소 판정', () => {
  it('classifyChatUrl', () => {
    expect(classifyChatUrl('https://chat.daangn.com/room/abc')).toBe('chat')
    expect(classifyChatUrl('https://chat.daangn.com/')).toBe('chat')
    expect(classifyChatUrl('https://chat.daangn.com/login')).toBe('login')
    expect(classifyChatUrl('https://accounts.daangn.com/sign-in?next=x')).toBe('login')
    expect(classifyChatUrl('https://chat.daangn.com/onboarding')).toBe('login')
    expect(classifyChatUrl('https://evil.com/')).toBe('other')
  })

  it('isAllowedChatUrl 은 당근 호스트만 통과시키고 접미사 속임수는 막는다', () => {
    expect(isAllowedChatUrl('https://chat.daangn.com/room/abc')).toBe(true)
    expect(isAllowedChatUrl('https://accounts.daangn.com/sign-in')).toBe(true)
    expect(isAllowedChatUrl('https://business-gateway.daangn.com/auth/x')).toBe(true)
    expect(isAllowedChatUrl('https://karrotauth-http.kr.karrotmarket.com/v2/auth')).toBe(true)
    expect(isAllowedChatUrl('https://evil.com/')).toBe(false)
    expect(isAllowedChatUrl('https://chat.daangn.com.evil.com/')).toBe(false)
    expect(isAllowedChatUrl('http://chat.daangn.com/')).toBe(false)
    expect(isAllowedChatUrl('javascript:alert(1)')).toBe(false)
  })

  it('roomIdOf', () => {
    expect(roomIdOf('https://chat.daangn.com/room/UMTA1')).toBe('UMTA1')
    expect(roomIdOf('https://chat.daangn.com/room/UMTA1?x=1')).toBe('UMTA1')
    expect(roomIdOf('https://chat.daangn.com/')).toBeNull()
  })
})

describe('buildFillScript', () => {
  it('글을 JSON 문자열로 안전하게 담는다(줄바꿈·따옴표·이모지·스크립트 닫는 조각)', () => {
    const text = '안녕 "하세요"\n두번째 줄 😀 </script><b>'
    const script = buildFillScript(text)
    expect(script).toContain(JSON.stringify(text))
    expect(script).not.toContain(text) // 그대로 끼워 넣지 않는다
  })
})
