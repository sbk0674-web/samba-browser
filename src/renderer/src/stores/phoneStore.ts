import { create } from 'zustand'
import type { PhoneAuthWaitingDto, PhoneDto, ScreenMode } from '@shared/phone'
import { sortPhones } from '@renderer/components/phone/phone-view'

// 폰 목록·인증 대기·화면 모드를 담는 스토어.
// 진실 원천은 메인이고 여기 값은 phone:* IPC 응답과 phone:updated 이벤트를 그대로 비춘다.
// 결제 비밀번호·문자 본문은 어느 경로로도 여기에 오지 않는다.

interface PhoneStoreState {
  list: PhoneDto[]
  loading: boolean
  /** 연결 상한 초과처럼 사용자가 알아야 할 안내(메인이 보낸 문구) */
  warning: string | null
  error: string | null
  /** 인증 대기 알림. 해당 폰 카드를 자동으로 펼치고 테두리를 강조한다 */
  authWaiting: PhoneAuthWaitingDto | null
  /** 사용자가 펼쳐 둔(또는 인증 대기로 자동 펼친) 폰 id */
  /** 화면을 열어 둔 폰 id 들 — 여러 대를 동시에 열 수 있다 */
  expandedIds: number[]
  /** serial → 지금 쓰는 화면 방식. 메인이 간이 화면으로 내려도 여기로 반영된다 */
  screenModes: Record<string, ScreenMode>
  /** 인증에 성공한 폰을 계정 담당 폰으로 제안하는 배너(계정 상세에서 쓴다) */
  assignSuggestion: { phoneId: number; siteHost: string } | null

  load: () => Promise<void>
  refresh: () => Promise<void>
  subscribe: () => () => void
  connectWifi: (address: string) => Promise<string | null>
  /** 무선 디버깅 페어링. 성공 여부와 adb 가 돌려준 문구 */
  pairWifi: (address: string, code: string) => Promise<{ ok: boolean; message: string; connected?: boolean } | null>
  disconnect: (serial: string) => Promise<void>
  /** 목록에서 폰을 지운다(연결을 끊고 다시 찾지 않는다) */
  remove: (id: number) => Promise<void>
  recover: (serial: string) => Promise<boolean>
  setLabel: (id: number, label: string, country: string) => Promise<void>
  assign: (accountId: number, phoneId: number | null) => Promise<boolean>
  /** 계정의 담당 폰 id(없으면 null). 조회에 실패해도 null 이다 */
  assignedFor: (accountId: number) => Promise<number | null>
  toggleExpand: (id: number) => void
  setScreenMode: (serial: string, mode: ScreenMode | null) => void
  clearWarning: () => void
  clearError: () => void
  clearAssignSuggestion: () => void
}

export const usePhoneStore = create<PhoneStoreState>((set, get) => ({
  list: [],
  loading: false,
  warning: null,
  error: null,
  authWaiting: null,
  expandedIds: [],
  screenModes: {},
  assignSuggestion: null,

  load: async () => {
    set({ loading: true })
    const r = await window.samba.phone.list()
    if (r.ok) set({ list: sortPhones(r.data), loading: false, error: null })
    else set({ loading: false, error: r.error })
  },

  refresh: async () => {
    set({ loading: true })
    const r = await window.samba.phone.refresh()
    if (r.ok) set({ list: sortPhones(r.data), loading: false, error: null })
    else set({ loading: false, error: r.error })
  },

  subscribe: () => {
    const offUpdated = window.samba.phone.onUpdated((list, warning) => {
      const next = sortPhones(list)
      // 사라진 폰의 화면 모드 기록은 같이 지운다
      const alive = new Set(next.map((p) => p.serial))
      const modes: Record<string, ScreenMode> = {}
      for (const [serial, mode] of Object.entries(get().screenModes)) {
        if (alive.has(serial)) modes[serial] = mode
      }
      // 메인이 보고한 screenMode 가 있으면 그 값이 우선이다
      for (const p of next) if (p.screenMode) modes[p.serial] = p.screenMode
      // 목록에서 사라진 폰의 화면만 닫는다
      const expandedIds = get().expandedIds.filter((id) => next.some((p) => p.id === id))
      set({ list: next, screenModes: modes, expandedIds, warning: warning ?? null })
    })
    const offAuth = window.samba.phone.onAuthWaiting((dto) => {
      if (!dto.waiting) {
        // 인증이 끝나면 인증 때문에 펼쳤던 그 카드만 접고, 배정 폰이 정해졌으면 담당 폰 제안 배너를 남긴다
        const suggestion =
          dto.phoneId === null ? null : { phoneId: dto.phoneId, siteHost: dto.siteHost }
        const authPhoneId = get().authWaiting?.phoneId ?? null
        set({
          authWaiting: null,
          expandedIds: get().expandedIds.filter((id) => id !== authPhoneId),
          assignSuggestion: suggestion
        })
        return
      }
      const open = get().expandedIds
      set({
        authWaiting: dto,
        expandedIds:
          dto.phoneId === null || open.includes(dto.phoneId) ? open : [...open, dto.phoneId]
      })
    })
    return () => {
      offUpdated()
      offAuth()
    }
  },

  connectWifi: async (address) => {
    const r = await window.samba.phone.connect(address)
    if (!r.ok) {
      set({ error: r.error })
      return null
    }
    await get().refresh()
    return r.data.message
  },

  pairWifi: async (address, code) => {
    const r = await window.samba.phone.pair?.(address, code)
    if (!r?.ok) {
      set({ error: r && !r.ok ? r.error : null })
      return null
    }
    if (r.data.ok) await get().refresh()
    return r.data
  },

  remove: async (id) => {
    const r = await window.samba.phone.remove?.(id)
    if (r && !r.ok) set({ error: r.error })
    await get().refresh()
  },

  disconnect: async (serial) => {
    const r = await window.samba.phone.disconnect(serial)
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    await get().refresh()
  },

  recover: async (serial) => {
    const r = await window.samba.phone.recover(serial)
    if (!r.ok) {
      set({ error: r.error })
      return false
    }
    await get().refresh()
    return r.data
  },

  setLabel: async (id, label, country) => {
    const r = await window.samba.phone.setLabel(id, label, country)
    if (!r.ok) {
      set({ error: r.error })
      return
    }
    await get().refresh()
  },

  assignedFor: async (accountId) => {
    const r = await window.samba.phone.assigned?.(accountId)
    return r?.ok ? r.data : null
  },

  assign: async (accountId, phoneId) => {
    const r = await window.samba.phone.assign(accountId, phoneId)
    if (!r.ok) {
      set({ error: r.error })
      return false
    }
    set({ assignSuggestion: null })
    return true
  },

  toggleExpand: (id) =>
    set((s) => ({
      expandedIds: s.expandedIds.includes(id)
        ? s.expandedIds.filter((v) => v !== id)
        : [...s.expandedIds, id]
    })),

  setScreenMode: (serial, mode) =>
    set((s) => {
      const modes = { ...s.screenModes }
      if (mode === null) delete modes[serial]
      else modes[serial] = mode
      return { screenModes: modes }
    }),

  clearWarning: () => set({ warning: null }),
  clearError: () => set({ error: null }),
  clearAssignSuggestion: () => set({ assignSuggestion: null })
}))
