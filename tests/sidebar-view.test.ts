import { describe, it, expect } from 'vitest'
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_ITEMS,
  SIDEBAR_SECTION_KEYS,
  canResizeSidebar,
  isSectionOpen,
  showSectionBody,
  sidebarWidthOf,
  tabFaviconHost,
  tabRowLabel,
  toggleSection
} from '../src/renderer/src/components/layout/sidebar-view'
import { AGENT_EFFORTS, DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings'
import { SYNCED_SETTING_KEYS } from '../src/shared/sync'
import ko from '../src/renderer/src/i18n/ko.json'
import en from '../src/renderer/src/i18n/en.json'

describe('사이드바 접힘 폭', () => {
  it('접으면 아이콘 폭으로 고정된다', () => {
    expect(sidebarWidthOf(true, 300)).toBe(SIDEBAR_COLLAPSED_WIDTH)
    expect(SIDEBAR_COLLAPSED_WIDTH).toBe(56)
  })

  it('펼치면 사용자가 끌어 둔 폭을 그대로 쓴다', () => {
    expect(sidebarWidthOf(false, 300)).toBe(300)
  })

  it('폭 손잡이는 펼친 상태에서만 쓸 수 있다', () => {
    expect(canResizeSidebar(false)).toBe(true)
    expect(canResizeSidebar(true)).toBe(false)
  })
})

describe('사이드바 섹션 접기', () => {
  it('값이 없으면 펼침으로 본다', () => {
    for (const key of SIDEBAR_SECTION_KEYS) {
      expect(isSectionOpen(undefined, key)).toBe(true)
      expect(isSectionOpen({}, key)).toBe(true)
    }
  })

  it('false 일 때만 접힘이다', () => {
    expect(isSectionOpen({ tabs: false }, 'tabs')).toBe(false)
    expect(isSectionOpen({ tabs: true }, 'tabs')).toBe(true)
  })

  it('토글은 그 섹션만 뒤집고 나머지는 그대로 둔다', () => {
    const next = toggleSection({ tabs: true, chat: false, bookmarks: true }, 'tabs')
    expect(next).toEqual({ tabs: false, chat: false, bookmarks: true })
  })

  it('토글해도 원본 객체를 건드리지 않는다', () => {
    const before = { tabs: true, chat: true, bookmarks: true }
    toggleSection(before, 'chat')
    expect(before.chat).toBe(true)
  })

  it('빠진 칸이 있어도 모든 섹션 키가 채워진다', () => {
    const next = toggleSection({}, 'bookmarks')
    expect(Object.keys(next).sort()).toEqual([...SIDEBAR_SECTION_KEYS].sort())
    expect(next.bookmarks).toBe(false)
  })

  it('사이드바를 접으면 펼쳐 둔 섹션도 본문을 그리지 않는다', () => {
    const sections = { tabs: true, chat: true, bookmarks: true }
    expect(showSectionBody(false, sections, 'tabs')).toBe(true)
    expect(showSectionBody(true, sections, 'tabs')).toBe(false)
  })

  it('펼친 사이드바에서도 접은 섹션은 본문을 그리지 않는다', () => {
    expect(showSectionBody(false, { tabs: false, chat: true, bookmarks: true }, 'tabs')).toBe(false)
  })
})

describe('사이드바 이동 항목', () => {
  it('모든 항목에 갈 뷰가 있다(자리표시자 없음)', () => {
    for (const item of SIDEBAR_ITEMS) {
      expect(typeof item.view).toBe('string')
      expect(item.view).not.toBe('')
    }
  })

  it('작업 항목은 작업 페이지로 간다', () => {
    expect(SIDEBAR_ITEMS.find((i) => i.key === 'tasks')?.view).toBe('tasks')
  })

  it('폰은 사이드바에 두지 않는다(설정 → 폰 연동으로 옮겼다)', () => {
    expect(SIDEBAR_ITEMS.map((i) => i.key)).toEqual(['browser', 'tasks', 'logs'])
  })

  it('항목 키가 겹치지 않는다', () => {
    const keys = SIDEBAR_ITEMS.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('열린 탭 줄', () => {
  it('http(s) 주소만 파비콘 호스트를 낸다', () => {
    expect(tabFaviconHost('https://www.naver.com/path')).toBe('naver.com')
    expect(tabFaviconHost('samba://newtab')).toBe('')
    expect(tabFaviconHost('about:blank')).toBe('')
    expect(tabFaviconHost('')).toBe('')
  })

  it('제목이 없으면 주소, 그것도 없으면 기본 문구로 떨어진다', () => {
    expect(tabRowLabel({ title: '네이버', url: 'https://naver.com' }, '제목 없음')).toBe('네이버')
    expect(tabRowLabel({ title: '  ', url: 'https://naver.com' }, '제목 없음')).toBe(
      'https://naver.com'
    )
    expect(tabRowLabel({ title: '', url: '' }, '제목 없음')).toBe('제목 없음')
  })
})

describe('설정 라운드트립', () => {
  it('새 키의 기본값', () => {
    const s = parseSettings({})
    expect(s.sidebarCollapsed).toBe(false)
    expect(s.sidebarSections).toEqual({ tabs: true, chat: true, bookmarks: true })
    expect(s.agentEffort).toBe('medium')
  })

  it('저장한 값이 그대로 돌아온다', () => {
    const s = parseSettings({
      ...DEFAULT_SETTINGS,
      sidebarCollapsed: true,
      sidebarSections: { tabs: false, chat: true, bookmarks: false },
      agentEffort: 'high'
    })
    expect(s.sidebarCollapsed).toBe(true)
    expect(s.sidebarSections).toEqual({ tabs: false, chat: true, bookmarks: false })
    expect(s.agentEffort).toBe('high')
  })

  it('망가진 값은 칸별로 기본값으로 되돌아간다', () => {
    const s = parseSettings({
      ...DEFAULT_SETTINGS,
      sidebarCollapsed: 'yes',
      sidebarSections: { tabs: 'nope', chat: false, bookmarks: true },
      agentEffort: 'turbo'
    })
    expect(s.sidebarCollapsed).toBe(false)
    expect(s.sidebarSections).toEqual({ tabs: true, chat: false, bookmarks: true })
    expect(s.agentEffort).toBe('medium')
  })

  it('추론 강도도 사이드바 접힘도 동기화한다(모든 설정은 PC 마다 같다)', () => {
    const synced: readonly string[] = SYNCED_SETTING_KEYS
    expect(synced).toContain('agentEffort')
    expect(synced).toContain('sidebarCollapsed')
    expect(synced).toContain('sidebarSections')
  })
})

// 평평한 키 목록(중첩 객체는 점으로 잇는다)
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flatten(v as Record<string, unknown>, path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

describe('사이드바·모델 메뉴 i18n', () => {
  const koKeys = flatten(ko as Record<string, unknown>)
  const enKeys = flatten(en as Record<string, unknown>)

  it('ko/en 키 집합이 같다', () => {
    expect(koKeys.filter((k) => !enKeys.includes(k))).toEqual([])
    expect(enKeys.filter((k) => !koKeys.includes(k))).toEqual([])
  })

  it('새 문구 키가 두 파일에 모두 있다', () => {
    const keys = [
      'sidebar.collapse',
      'sidebar.expand',
      'tab.openTabs',
      'tab.close',
      'tab.empty',
      'tab.untitled',
      'chat.modelMenu',
      'chat.effortMenu',
      ...AGENT_EFFORTS.flatMap((e) => [`chat.effort.${e}`, `chat.effortDesc.${e}`])
    ]
    for (const key of keys) {
      expect(koKeys).toContain(key)
      expect(enKeys).toContain(key)
    }
  })
})
