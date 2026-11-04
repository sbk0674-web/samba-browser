import { create } from 'zustand'
import type {
  DaangnAccountDto,
  DaangnChannelDto,
  DaangnStateDto,
  DaangnTemplateDto
} from '@shared/daangn'
import { useUiStore } from '@renderer/stores/uiStore'
import { PANEL_WIDTHS, clampPanelWidth, withNativeListOrder } from '@renderer/components/daangn/daangn-view'

const WIDTH_KEY = 'samba.daangn.panelWidths'

// 보는 사람(이 PC)마다 다른 편의라 브라우저 저장소에 둔다 — 막혀 있어도 기본 폭으로 동작
function loadWidths(): { account: number; list: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(WIDTH_KEY) ?? '{}') as Record<string, unknown>
    return {
      account: clampPanelWidth('account', Number(raw.account ?? PANEL_WIDTHS.account.def)),
      list: clampPanelWidth('list', Number(raw.list ?? PANEL_WIDTHS.list.def))
    }
  } catch {
    return { account: PANEL_WIDTHS.account.def, list: PANEL_WIDTHS.list.def }
  }
}

// 당근 통합 채팅함 스토어. 진실 원천은 메인이고 여기 값은 daangn:* IPC 응답과 daangn:updated 이벤트를 비춘다.
// 채팅 본문·세션은 어느 경로로도 여기에 오지 않는다(목록 표시값만)

interface OpenRoom {
  accountId: number
  /** null 이면 로그인(QR) 화면을 보여 주는 중 */
  roomId: string | null
}

interface DaangnStoreState {
  accounts: DaangnAccountDto[]
  channels: DaangnChannelDto[]
  templates: DaangnTemplateDto[]
  selectedAccountId: number | null
  unreadOnly: boolean
  accountWidth: number
  listWidth: number
  open: OpenRoom | null
  /** 템플릿 편집 대화상자 같은 모달이 열려 있는 수 — 0 보다 크면 오른쪽 네이티브 뷰를 접는다 */
  modalCount: number
  error: string | null

  load: () => Promise<void>
  subscribe: () => () => void
  selectAccount: (id: number | null) => void
  setUnreadOnly: (v: boolean) => void
  setPanelWidth: (kind: 'account' | 'list', w: number) => void
  savePanelWidths: () => void
  openChannel: (c: Pick<DaangnChannelDto, 'accountId' | 'roomId'>) => Promise<void>
  addAccount: (label: string) => Promise<void>
  removeAccount: (id: number) => Promise<void>
  renameAccount: (id: number, label: string) => Promise<void>
  relogin: (id: number) => Promise<void>
  fillTemplate: (text: string) => Promise<boolean>
  loadTemplates: () => Promise<void>
  saveTemplate: (input: { id?: number; text: string }) => Promise<void>
  deleteTemplate: (id: number) => Promise<void>
  reorderTemplates: (ids: number[]) => Promise<void>
  pushModal: () => void
  popModal: () => void
  clearError: () => void
}

export const useDaangnStore = create<DaangnStoreState>((set, get) => ({
  accounts: [],
  channels: [],
  templates: [],
  selectedAccountId: null,
  unreadOnly: true,
  accountWidth: loadWidths().account,
  listWidth: loadWidths().list,
  open: null,
  modalCount: 0,
  error: null,

  load: async () => {
    const channelsBeforeLoad = get().channels
    const [a, c] = await Promise.all([
      window.samba.daangn.accountsList(),
      window.samba.daangn.channelsList()
    ])
    if (get().channels === channelsBeforeLoad) {
      if (a.ok && c.ok) set({ accounts: a.data, channels: withNativeListOrder(c.data) })
      else set({ error: !a.ok ? a.error : !c.ok ? c.error : null })
    }
    await get().loadTemplates()
  },

  subscribe: () => {
    const offUpdated = window.samba.daangn.onUpdated((s: DaangnStateDto) => {
      // 지워진 계정을 고르고 있었으면 전체로 돌아간다
      const selected = get().selectedAccountId
      const alive = selected === null || s.accounts.some((a) => a.id === selected)
      set({
        accounts: s.accounts,
        channels: withNativeListOrder(s.channels),
        selectedAccountId: alive ? selected : null
      })
    })
    // 알림을 누르면 당근 페이지로 가서 그 방을 연다
    const offClick = window.samba.daangn.onNotifyClick(({ accountId, roomId }) => {
      useUiStore.getState().setView('daangn')
      void get().openChannel({ accountId, roomId })
    })
    return () => {
      offUpdated()
      offClick()
    }
  },

  selectAccount: (id) => set({ selectedAccountId: id }),
  setUnreadOnly: (v) => set({ unreadOnly: v }),
  setPanelWidth: (kind, w) =>
    set(kind === 'account' ? { accountWidth: clampPanelWidth(kind, w) } : { listWidth: clampPanelWidth(kind, w) }),
  savePanelWidths: () => {
    try {
      const { accountWidth, listWidth } = get()
      localStorage.setItem(WIDTH_KEY, JSON.stringify({ account: accountWidth, list: listWidth }))
    } catch {
      // 저장이 막혀 있으면 이번 실행에서만 유지
    }
  },

  openChannel: async (c) => {
    const r = await window.samba.daangn.openRoom(c.accountId, c.roomId)
    if (!r.ok) return set({ error: r.error })
    set({ open: { accountId: c.accountId, roomId: c.roomId } })
  },

  addAccount: async (label) => {
    const r = await window.samba.daangn.addAccount(label)
    if (!r.ok) return set({ error: r.error })
    // 새 계정의 로그인(QR) 화면이 오른쪽에 뜬다
    set({ open: { accountId: r.data.id, roomId: null }, selectedAccountId: r.data.id })
  },

  removeAccount: async (id) => {
    const r = await window.samba.daangn.removeAccount(id)
    if (!r.ok) return set({ error: r.error })
    if (get().open?.accountId === id) set({ open: null })
  },

  renameAccount: async (id, label) => {
    const r = await window.samba.daangn.setAccountLabel(id, label)
    if (!r.ok) set({ error: r.error })
  },

  relogin: async (id) => {
    const r = await window.samba.daangn.relogin(id)
    if (!r.ok) return set({ error: r.error })
    set({ open: { accountId: id, roomId: null } })
  },

  // 템플릿은 입력칸에만 채운다. 보내기는 사람이 한다. 열린 방의 계정이 기준이다
  fillTemplate: async (text) => {
    const open = get().open
    if (!open || open.roomId === null) return false
    const r = await window.samba.daangn.fillText(open.accountId, text)
    return r.ok && r.data
  },

  loadTemplates: async () => {
    const r = await window.samba.daangn.templatesList()
    if (r.ok) set({ templates: r.data })
  },

  saveTemplate: async (input) => {
    const r = await window.samba.daangn.saveTemplate(input)
    if (!r.ok) return set({ error: r.error })
    await get().loadTemplates()
  },

  deleteTemplate: async (id) => {
    const r = await window.samba.daangn.deleteTemplate(id)
    if (!r.ok) return set({ error: r.error })
    await get().loadTemplates()
  },

  reorderTemplates: async (ids) => {
    const r = await window.samba.daangn.reorderTemplates(ids)
    if (!r.ok) return set({ error: r.error })
    await get().loadTemplates()
  },

  pushModal: () => set((s) => ({ modalCount: s.modalCount + 1 })),
  popModal: () => set((s) => ({ modalCount: Math.max(0, s.modalCount - 1) })),
  clearError: () => set({ error: null })
}))
