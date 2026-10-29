import { describe, expect, it } from 'vitest'
import { findOrderCandidates, previewSignal, buildInspectSaleScript } from '../src/main/daangn/order-watch'
import { runInNewContext } from 'node:vm'
import type { DaangnChannelDto } from '../src/shared/daangn'

const cutoff = Date.parse('2026-10-29T10:00:00+09:00')
const base: DaangnChannelDto = {
  accountId: 3, roomId: 'room-1', peerName: '구매자', region: '',
  lastMessage: '10월 30일(금)에 기사님이 택배를 수거할 예정이에요.',
  lastAt: Date.parse('2026-10-29T10:30:00+09:00'), lastAtText: '오전 10:30',
  unread: 0, productTitle: '유니클로 x 니들스 플리스 와이드 팬츠 다크 그레이 - KR 3XL',
  productThumb: null
}

describe('당근 주문 후보', () => {
  it.each(['오전 8:13', '오후 8:13'])('결제 안내의 날짜와 시각만 묶고 나중 채팅은 무시한다 (%s)', clock => {
    const notice = '수거 날짜를 선택해 주세요. 모바일에서 확인해주세요. 모바일에서 확인해주세요.'
    const children = [
      { textContent: '2026년 10월29일 목요일', classList: { contains: (s: string) => s === 'day-divider' } },
      { textContent: notice + clock },
      { textContent: '구매자 메시지 오후 9:00' }
    ]
    const document = { querySelector: () => ({ textContent: notice, children }),
      querySelectorAll: () => [{ textContent: '상품14,000원' }] }
    expect(runInNewContext(buildInspectSaleScript('상품'), { document })).toMatchObject({
      paymentEventAt: clock.startsWith('오전') ? '2026-10-29T08:13:00+09:00' : '2026-10-29T20:13:00+09:00'
    })
  })
  it('채팅 목록의 수거 안내를 폰 확인이 필요한 후보로 찾는다', () => {
    expect(findOrderCandidates([base], cutoff)).toEqual([{
      accountId: 3, roomId: 'room-1', productTitle: base.productTitle,
      lastAt: base.lastAt, peerName: '구매자', productThumb: null, previewSignal: 'pickup_scheduled', lastAtPrecise: true
    }])
  })
  it('최근 구매 문의도 채팅 내용을 확인하되 결제완료로 간주하지 않는다', () => {
    const inquiry = { ...base, lastMessage: '구매할 수 있나요?' }
    expect(findOrderCandidates([inquiry], cutoff)).toEqual([{
      accountId: 3, roomId: 'room-1', productTitle: base.productTitle, lastAt: base.lastAt, peerName: '구매자', productThumb: null, previewSignal: 'unknown', lastAtPrecise: true
    }])
  })
  it('기준 이전과 시각 불명은 건너뛴다', () => {
    const rows = [
      { ...base, lastAt: cutoff - 1 },
      { ...base, lastAt: 0 }
    ]
    expect(findOrderCandidates(rows, cutoff)).toEqual([])
  })
  it('결제 문의와 취소는 수거 신호로 취급하지 않는다', () => {
    expect(previewSignal('바로구매 가능한가요?')).toBe('unknown')
    expect(previewSignal('거래 취소')).toBe('cancel')
    expect(previewSignal('수거 날짜를 선택해 주세요.')).toBe('pickup_request')
  })
  it('다른 채팅 목록이 아닌 해당 방 본문의 수거 메시지만 본다', () => {
    const message = { textContent: '수거 날짜를 선택해 주세요. 모바일에서 확인해주세요. 모바일에서 확인해주세요.' }
    const doc = { querySelector: (s: string) => s === '[aria-label="메시지 리스트"]'
      ? { textContent: '수거 날짜를 선택해 주세요. 선택한 날짜에 택배 기사님이 방문할 예정이에요.', children: [message] } : null,
      querySelectorAll: () => [{ textContent: '신발 230mm 69,000원' }] }
    expect(runInNewContext(buildInspectSaleScript('신발 230mm'), { document: doc })).toMatchObject({ ready: true, payment: true, cancelled: false, productMatches: true, salePrice: 69000, systemNotice: true })
    expect(runInNewContext(buildInspectSaleScript('다른 상품'), { document: doc })).toMatchObject({ productMatches: false, salePrice: null })
    expect(runInNewContext(buildInspectSaleScript('신발'), { document: { querySelector: () => null } })).toMatchObject({ ready: false, payment: false })
  })
  it.each(['', '예약중', '판매완료'])('제목 끝 품번과 가격·상태가 붙어도 가격만 읽는다 (%s)', status => {
    const title = '나이키 조거 팬츠 M AO2371-091'
    const document = {
      querySelector: () => ({ textContent: '수거 날짜를 선택해 주세요.', children: [] }),
      querySelectorAll: () => [{ textContent: `${title}14,000원${status}` }]
    }
    expect(runInNewContext(buildInspectSaleScript(title), { document })).toMatchObject({
      productMatches: true, salePrice: 14000
    })
  })
  it.each([
    ['', ['상품14,000원']],
    ['상품', ['다른 상품14,000원']],
    ['상품', ['상품 다른 옵션14,000원']],
    ['상품', ['상품14,000원', '상품15,000원']],
    ['상품', ['상품14,000원 15,000원']]
  ])('제목이 없거나 제목·가격이 충돌하면 보류한다 (%s)', (title, links) => {
    const document = {
      querySelector: () => ({ textContent: '수거 날짜를 선택해 주세요.', children: [] }),
      querySelectorAll: () => links.map(textContent => ({ textContent }))
    }
    expect(runInNewContext(buildInspectSaleScript(title), { document })).toMatchObject({
      productMatches: false, salePrice: null
    })
  })
})
