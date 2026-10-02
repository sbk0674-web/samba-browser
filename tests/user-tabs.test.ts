// 사람이 연 탭 보호 — 레인 없는 브릿지 세션(하네스 본 작업)은 사람 탭을 정리 대상으로 보지 않고, 닫지도 못한다
import { describe, it, expect } from 'vitest'
import { USER_LANE, labelLaneTargets, newLaneState } from '../src/main/agent/lane-tabs'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { AgentTarget } from '../src/main/browser/targets'

function fakeTabs(
  targets: AgentTarget[],
  userIds: string[]
): { tabs: TabManager; closed: string[] } {
  const closed: string[] = []
  const tabs = {
    listTargets: () => targets,
    list: () => [],
    isUserTab: (id: string) => userIds.includes(id),
    close: (id: string) => closed.push(id),
    closeTarget: (id: string) => closed.push(id)
  } as unknown as TabManager
  return { tabs, closed }
}

const targets: AgentTarget[] = [
  { id: 'mine', kind: 'tab', title: '', url: 'https://shop/a', active: true },
  {
    id: 'minePop',
    kind: 'popup',
    title: '',
    url: 'https://shop/pop',
    openerId: 'mine',
    active: false
  },
  { id: 'job', kind: 'tab', title: '', url: 'https://shop/order/1', active: false },
  { id: 'jobPop', kind: 'popup', title: '', url: 'https://pay', openerId: 'job', active: false }
]

describe('사람이 연 탭 보호', () => {
  it("사람 탭과 그 팝업에 lane 'user' 를 붙이고, 자동화 탭은 그대로 둔다", () => {
    const { tabs } = fakeTabs(targets, ['mine'])
    const out = labelLaneTargets(tabs, new Map()).listTargets()
    expect(out.map((t) => [t.id, t.lane])).toEqual([
      ['mine', USER_LANE],
      ['minePop', USER_LANE],
      ['job', undefined],
      ['jobPop', undefined]
    ])
  })

  it('레인이 연 탭은 레인 이름이 우선한다', () => {
    const { tabs } = fakeTabs(targets, ['job'])
    const st = newLaneState()
    st.owned.add('job')
    const out = labelLaneTargets(tabs, new Map([['chk', st]])).listTargets()
    expect(out.find((t) => t.id === 'job')?.lane).toBe('chk')
  })

  it('사람 탭·그 팝업은 닫기 호출을 무시하고, 자동화 탭은 닫는다', () => {
    const { tabs, closed } = fakeTabs(targets, ['mine'])
    const view = labelLaneTargets(tabs, new Map())
    view.close('mine')
    view.closeTarget('mine')
    view.closeTarget('minePop')
    expect(closed).toEqual([])
    view.close('job')
    view.closeTarget('jobPop')
    expect(closed).toEqual(['job', 'jobPop'])
  })
})
