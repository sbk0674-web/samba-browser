// AI 작업 대상(AgentTarget) 계산 — 탭 + 살아 있는 팝업 창.
//
// tab-manager 에서 떼어 둔 이유는 popups.ts 와 같다: Electron 의 BrowserWindow·
// WebContentsView 없이 목록 계산과 대상 선택 규칙만 순수하게 테스트하기 위해서다.
//
// 무신사 '배송지 변경', 29CM '주소 검색', NICE ePAY 결제창은 탭이 아니라 팝업 창으로
// 열린다. 활성 탭만 보던 시절에는 AI 가 그 안을 아예 조작하지 못했다

/** AI 가 다룰 수 있는 대상 한 건(탭 또는 팝업) */
export interface AgentTarget {
  id: string
  kind: 'tab' | 'popup'
  title: string
  url: string
  /** 팝업을 띄운 탭의 id(탭에는 없다) */
  openerId?: string
  /** 탭이면 활성 탭인지, 팝업이면 AI 표식이 붙어 있는지 */
  active: boolean
  /** 그 탭·팝업이 속한 계정 프로필 — 스크립트가 같은 주소의 탭 여럿 중 이 계정의 것을 가린다 */
  profile?: string
  /** 레인이 연 탭(과 그 팝업)이면 레인 이름 — 레인 없는 세션의 목록에만 붙는다(labelLaneTargets) */
  lane?: string
}

/** 창·뷰를 모르는 순수 계산용 최소 정보 */
export interface TargetInfo {
  id: string
  title: string
  url: string
  openerId?: string
  profile?: string
}

/**
 * 탭과 살아 있는 팝업을 한 목록으로 만든다. 팝업은 항상 탭 뒤에 온다 —
 * 앞쪽 순서가 흔들리지 않아야 모델이 목록을 다시 읽어도 같은 대상을 가리킨다
 */
export function buildTargets(
  tabs: TargetInfo[],
  popups: TargetInfo[],
  activeId: string | null,
  focusedPopupId: string | null
): AgentTarget[] {
  const asTarget = (t: TargetInfo, kind: 'tab' | 'popup', active: boolean): AgentTarget => ({
    id: t.id,
    kind,
    title: t.title,
    url: t.url,
    ...(t.openerId === undefined ? {} : { openerId: t.openerId }),
    ...(t.profile === undefined ? {} : { profile: t.profile }),
    active
  })
  return [
    ...tabs.map((t) => asTarget(t, 'tab', t.id === activeId)),
    ...popups.map((p) => asTarget(p, 'popup', p.id === focusedPopupId))
  ]
}

/**
 * AI 작업 대상의 id. 표식이 가리키는 팝업이 아직 살아 있으면 그 팝업,
 * 아니면 활성 탭이다 — 결제창이 닫히면 따로 알리지 않아도 원래 탭으로 돌아온다
 */
export function pickAgentTargetId(
  focusedPopupId: string | null,
  alivePopupIds: readonly string[],
  activeId: string | null
): string | null {
  if (focusedPopupId !== null && alivePopupIds.includes(focusedPopupId)) return focusedPopupId
  return activeId
}
