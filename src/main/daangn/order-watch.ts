// 채팅 미리보기는 결제 증거가 아니라, 상세 화면을 확인할 후보를 찾는 데만 쓴다.
import type { DaangnChannelDto } from '../../shared/daangn'

export interface DaangnSaleSignal {
  ready: boolean
  payment: boolean
  cancelled: boolean
  productMatches: boolean
  salePrice: number | null
  systemNotice: boolean
}

export interface DaangnOrderCandidate {
  accountId: number
  accountLabel?: string
  roomId: string
  productTitle: string
  productThumb: string | null
  /** 목록 신호는 본문을 먼저 살펴볼 힌트이며 결제확인이 아니다. */
  previewSignal: 'pickup_request' | 'pickup_scheduled' | 'cancel' | 'unknown'
  lastAtPrecise: boolean
  /** 폰에서 같은 채팅방을 찾을 때만 메모리에서 사용한다. 파일·로그에 쓰지 않는다. */
  peerName: string
  lastAt: number
}

export function previewSignal(message: string): DaangnOrderCandidate['previewSignal'] {
  const text = message.replace(/\s+/g, ' ').trim()
  if (/거래\s*취소|판매\s*취소|결제\s*취소/.test(text)) return 'cancel'
  if (/수거\s*날짜를\s*선택해\s*주세요/.test(text)) return 'pickup_request'
  if (/기사님이\s*택배를\s*수거할\s*예정/.test(text)) return 'pickup_scheduled'
  return 'unknown'
}

/** 방 본문만 검사한다. 목록 미리보기나 구매 문의는 결제 증거가 아니다. */
export function buildInspectSaleScript(expectedTitle: string): string {
  return `(() => {
    const list = document.querySelector('[aria-label="메시지 리스트"]');
    if (!list) return { ready: false, payment: false, cancelled: false, productMatches: false, salePrice: null, systemNotice: false };
    const text = (list.textContent || '').replace(/\\s+/g, ' ');
    if (!text.trim()) return { ready: false, payment: false, cancelled: false, productMatches: false, salePrice: null, systemNotice: false };
    const payment = /수거\\s*날짜를\\s*선택해\\s*주세요|바로구매로\\s*물품이\\s*팔렸어요/.test(text);
    const cancelled = /거래\\s*취소|판매를\\s*취소했어요|결제\\s*금액이\\s*환불/.test(text);
    const systemNotice = [...list.children].some(el => {
      const t = (el.textContent || '').replace(/\\s+/g, ' ');
      const mobile = t.match(/모바일에서\\s*확인해\\s*주세요/g) || [];
      return /수거\\s*날짜를\\s*선택해\\s*주세요/.test(t) && mobile.length >= 2;
    });
    const title = ${JSON.stringify(expectedTitle)}.replace(/\\s+/g, ' ').trim();
    const links = [...document.querySelectorAll('main section a')].map(a => (a.textContent || '').replace(/\\s+/g, ' ').trim());
    const matches = links.filter(t => title && t.startsWith(title));
    // textContent는 제목 끝 품번과 가격을 붙인다. 제목을 먼저 제거하고 가격만 검증한다.
    const parsedPrices = matches.map(t => {
      const price = t.slice(title.length).trim().match(/^(\\d+|\\d{1,3}(?:,\\d{3})+)\\s*원$/);
      const value = price ? Number(price[1].replace(/,/g, '')) : null;
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    });
    const prices = [...new Set(parsedPrices)];
    const productMatches = matches.length > 0 && prices.length === 1 && prices[0] !== null;
    return { ready: true, payment, cancelled, productMatches, salePrice: productMatches ? prices[0] : null, systemNotice };
  })()`
}

/** 마지막 메시지 시각은 후보 탐색용이다. 결제 시각으로 저장해서는 안 된다. */
export function findOrderCandidates(
  channels: readonly DaangnChannelDto[],
  cutoff: number
): DaangnOrderCandidate[] {
  const result: DaangnOrderCandidate[] = []
  for (const channel of channels) {
    if (!channel.roomId || !channel.productTitle || !Number.isFinite(channel.lastAt) || channel.lastAt < cutoff) continue
    result.push({
      accountId: channel.accountId,
      roomId: channel.roomId,
      productTitle: channel.productTitle,
      productThumb: channel.productThumb,
      previewSignal: previewSignal(channel.lastMessage || ''),
      lastAtPrecise: /^(오전|오후)\s*\d{1,2}:\d{2}$/.test(channel.lastAtText.trim()),
      lastAt: channel.lastAt,
      peerName: channel.peerName
    })
  }
  return result
}
