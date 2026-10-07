// 레인(lane) — 하네스가 계정마다 동시에 돌리는 브릿지 호출을 서로 떼어 놓는 탭 보기.
//
// 왜: 모든 페이지 조작이 앱 전체에 하나뿐인 "지금 작업 중인 탭"(agentTarget)을 쓴다. 계정 4개를
// 동시에 돌리면 서로의 탭을 건드린다(실기 2026-09-24: 계정 비교가 순서대로라 주문 1건에 5~8분).
//
// 레인은 진짜 TabManager 를 감싼 보기다.
//  - 레인이 연 탭과 그 탭에서 뜬 팝업만 목록에 보인다(저장 스크립트는 탭 목록에서 제 탭을 찾는다)
//  - "지금 작업 중인 창"을 레인이 따로 쥔다 — 전역 활성 탭을 바꾸지 않는다
//  - 그 밖의 기능(페이지 조작·대화상자·세션)은 진짜 TabManager 그대로다
import type { Tab, TabManager } from '../browser/tab-manager'
import type { AgentTarget } from '../browser/targets'

export interface LaneState {
  owned: Set<string>
  current: string | null
}

export function newLaneState(): LaneState {
  return { owned: new Set(), current: null }
}

/** 레인 보기. state 는 레인 이름마다 하나 — 브릿지 요청(세션)이 바뀌어도 이어진다 */
export function laneTabs(real: TabManager, state: LaneState): TabManager {
  const mine = (t: AgentTarget): boolean =>
    state.owned.has(t.id) ||
    (t.kind === 'popup' && typeof t.openerId === 'string' && state.owned.has(t.openerId))
  const alive = (id: string): boolean => real.listTargets().some((t) => t.id === id && mine(t))
  const overrides: Partial<Record<keyof TabManager, unknown>> = {
    list: () => real.list().filter((t) => state.owned.has(t.id)),
    listTargets: (): AgentTarget[] =>
      real
        .listTargets()
        .filter(mine)
        .map((t) => ({ ...t, active: t.id === state.current })),
    active: (): Tab | null =>
      state.current && state.owned.has(state.current) ? real.get(state.current) : null,
    // 폰 배선(tab-port)이 보는 "자동화가 조작하는 진짜 탭" 도 레인의 작업 탭이다 — 전역 표식을 보면
    // 사람이 보던 탭의 호스트로 계정을 찾아 결제가 거부됐다(실기 2026-10-06)
    workingTab: (): Tab | null => {
      if (!state.current || !alive(state.current)) return null
      const tab = real.get(state.current)
      if (tab) return tab
      // 작업 창이 팝업(결제창)이면 그 팝업을 연 탭이 "진짜 탭" 이다 — 계정은 구매 사이트(여는 탭) 기준으로 찾는다
      // (실기 2026-10-06: 토스 결제창으로 switch_tab 한 직후 폰 승인을 불러 host 가 비어 no-account 로 거부)
      const target = real.listTargets().find((t) => t.id === state.current)
      return target?.kind === 'popup' && typeof target.openerId === 'string'
        ? real.get(target.openerId)
        : null
    },
    agentTarget: (): Tab | null => {
      if (state.current && alive(state.current)) return real.targetTab(state.current)
      // 작업 창이 닫혔으면(결제창 등) 레인의 마지막 탭으로 돌아간다
      const last = [...state.owned].reverse().find((id) => real.get(id) !== null) ?? null
      state.current = last
      return last ? real.get(last) : null
    },
    focusTarget: (id: string): void => {
      if (alive(id)) state.current = id
    },
    activate: (id: string): void => {
      if (state.owned.has(id)) state.current = id
    },
    create: (opts: Parameters<TabManager['create']>[0]): ReturnType<TabManager['create']> => {
      // 레인 탭은 전역 자동화 대상 표식을 바꾸지 않고, 사람이 창을 쓰는 중이면 뒤에서만 연다(visible-guard.ts)
      const t = real.create({ ...opts, keepAgentTarget: true })
      state.owned.add(t.id)
      state.current = t.id
      return t
    },
    close: (id: string): void => {
      if (!state.owned.has(id)) return
      real.close(id)
      state.owned.delete(id)
      if (state.current === id) state.current = null
    },
    closeTarget: (id: string): void => {
      if (!alive(id)) return
      real.closeTarget(id)
      state.owned.delete(id)
      if (state.current === id) state.current = null
    }
  }
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop as keyof TabManager]
      const v: unknown = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    }
  })
}

/**
 * 레인 없는 세션의 탭 보기 — 목록은 그대로 두고, 레인이 연 탭·팝업에 lane 이름만 붙인다.
 *
 * 왜: 하네스 본 작업(레인 없음)은 모든 탭을 본다. 작업이 끝나면 그 사이 생긴 탭을 모두 닫아
 * 다른 레인(사람이 따로 돌리는 수동 작업)의 주문서까지 닫았다(실기 2026-09-27 패션플러스·SMARKET).
 * 숨기지는 않는다 — 교차 비교가 레인에서 만든 주문서를 본 작업이 이어받는 흐름이 있다.
 * 하네스는 lane 이 붙은 탭을 정리 대상에서 뺀다(레인 탭은 레인이 스스로 닫는다).
 * 사람이 직접 연 탭에는 lane 'user' 를 붙이고, 닫기 호출도 무시한다.
 */
/** 사람이 직접 연 탭에 붙는 표시 — 하네스는 lane 이 붙은 탭을 정리하지 않는다 */
export const USER_LANE = 'user'

export function labelLaneTargets(
  real: TabManager,
  lanes: ReadonlyMap<string, LaneState>
): TabManager {
  // 시험용 대역에는 isUserTab 이 없을 수 있다
  const isUser = (id: string): boolean => {
    const fn = (real as Partial<TabManager>).isUserTab
    return typeof fn === 'function' && fn.call(real, id)
  }
  const laneOf = (t: AgentTarget): string | undefined => {
    for (const [name, st] of lanes) {
      if (st.owned.has(t.id)) return name
      if (t.kind === 'popup' && typeof t.openerId === 'string' && st.owned.has(t.openerId))
        return name
    }
    // 사람이 연 탭과 그 탭에서 뜬 팝업 — 정리 대상에서 빠지게 lane 을 붙인다(실기 2026-10-02: 사용자가
    // 쓰려고 띄운 탭·프로필 탭이 작업 정리 때 같이 닫혔다)
    if (isUser(t.id)) return USER_LANE
    if (t.kind === 'popup' && typeof t.openerId === 'string' && isUser(t.openerId)) return USER_LANE
    return undefined
  }
  const listTargets = (): AgentTarget[] =>
    real.listTargets().map((t) => {
      const lane = laneOf(t)
      return lane ? { ...t, lane } : t
    })
  // 목록 표시만으로는 부족하다 — id 를 알고 닫으려는 호출도 막는다(사람 탭과 그 팝업)
  const protectedId = (id: string): boolean => {
    if (isUser(id)) return true
    const t = real.listTargets().find((x) => x.id === id)
    return !!t && t.kind === 'popup' && typeof t.openerId === 'string' && isUser(t.openerId)
  }
  const overrides: Partial<Record<keyof TabManager, unknown>> = {
    listTargets,
    close: (id: string): void => {
      if (!protectedId(id)) real.close(id)
    },
    closeTarget: (id: string): void => {
      if (!protectedId(id)) real.closeTarget(id)
    }
  }
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop as keyof TabManager]
      const v: unknown = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    }
  })
}
