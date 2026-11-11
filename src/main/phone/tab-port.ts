// 폰 배선이 웹 페이지에 닿는 어댑터. wiring.ts 를 탭·page-bridge 에서 떼어 놓기 위해
// 이 파일 하나만 TabManager 를 안다(테스트는 PagePort 를 가짜로 넣는다)

import type { TabManager } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import { normalizeHost } from '../../shared/host'
import { isNaverPayHost, maskedNaverAccount } from '../../shared/naverpay'
import type { PageSnapshot } from '../../shared/snapshot'
import { isPaySuccessUrl, PAY_SUCCESS_TEXT_RE, type PagePort } from './wiring'

// 결제사 결제창 호스트(토스·네이버페이·카카오페이·페이코)
const PAY_TAB_HOST_RE = /(^|\.)(toss\.im|tosspayments\.com|pay\.naver\.com|kakaopay\.com|payco\.com)$/

const EMPTY_SNAPSHOT: PageSnapshot = { url: '', title: '', text: '', elements: [] }

/** 활성 탭이 없을 때도 던지지 않는다 — 인증 흐름이 'no-field' 로 조용히 끝난다 */
export function createTabPagePort(tabs: TabManager): PagePort {
  // 자동화가 조작하는 탭 — 사람이 창을 쓰는 중이라 자동화가 뒤 탭에서 돌면 보이는 탭과 다르다.
  // workingTab 이 없는 대역(테스트)은 보이는 탭으로 되돌린다
  const active = (): ReturnType<TabManager['active']> => {
    const candidate = tabs as Partial<TabManager>
    return typeof candidate.workingTab === 'function' ? candidate.workingTab() : tabs.active()
  }

  return {
    host: () => {
      const tab = active()
      if (!tab) return ''
      const host = normalizeHost(tab.view.webContents.getURL())
      // 결제창이 팝업이 아니라 새 탭으로 열리면(롯데온 토스·네이버페이, 실기 2026-11-12) 그 탭 주소는 결제사라
      // 구매 사이트 계정을 못 찾아 폰 승인이 no-account 로 거부됐다 — 결제사 탭이면 그 탭을 연 탭의 사이트로 본다
      if (PAY_TAB_HOST_RE.test(host) && tab.openerId) {
        const opener = tabs.get(tab.openerId)
        if (opener && !opener.view.webContents.isDestroyed()) return normalizeHost(opener.view.webContents.getURL())
      }
      if (PAY_TAB_HOST_RE.test(host)) {
        // 연 탭을 모르면 같은 프로필의 주문서 탭 사이트로 본다
        const sheet = tabs
          .list()
          .find((t) => t.profile === tab.profile && /order|checkout/i.test(t.url) && !PAY_TAB_HOST_RE.test(normalizeHost(t.url)))
        if (sheet) return normalizeHost(sheet.url)
      }
      return host
    },
    profile: () => active()?.profile ?? '',
    activeTabId: () => active()?.id ?? null,
    naverPayAccount: async () => {
      // 결제창은 보통 활성 탭이 연 팝업이다. 팝업이 없으면 활성 탭 자체가 결제창일 수 있다
      const tab = active()
      if (!tab) return null
      const candidates = [tabs.popupOf(tab.id), tab].filter((t) => t !== null)
      for (const target of candidates) {
        if (!isNaverPayHost(normalizeHost(target.view.webContents.getURL()))) continue
        try {
          const snapshot = await pageBridge.snapshot(target)
          return maskedNaverAccount(`${snapshot.title}\n${snapshot.text}`)
        } catch {
          return null
        }
      }
      return null
    },
    snapshot: async () => {
      const tab = active()
      return tab ? pageBridge.snapshot(tab) : EMPTY_SNAPSHOT
    },
    fillValue: async (elementId, value) => {
      const tab = active()
      return tab ? pageBridge.fillValue(tab, elementId, value) : 'not found'
    },
    submit: async (elementId) => {
      const tab = active()
      return tab ? pageBridge.submitForm(tab, elementId) : 'not found'
    },
    paymentSucceeded: async (openerId) => {
      // 결제창은 보통 팝업이다. 팝업이 닫혔으면 원래 탭이 성공 주소로 돌아온다
      const target = (openerId === null ? null : tabs.popupOf(openerId)) ?? active()
      if (!target) return false
      if (isPaySuccessUrl(target.view.webContents.getURL())) return true
      try {
        return PAY_SUCCESS_TEXT_RE.test((await pageBridge.snapshot(target)).text)
      } catch {
        // 팝업이 막 닫히는 중이면 스냅샷이 실패한다 — 아직 성공으로 보지 않는다
        return false
      }
    }
  }
}
