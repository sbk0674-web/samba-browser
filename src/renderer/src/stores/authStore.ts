import { create } from 'zustand'
import type { AuthState, DeviceDto } from '@shared/sync'

// 계정(로그인) 상태. 진실 원천은 메인이고 여기 값은 auth:* IPC 응답과
// auth:stateChanged 이벤트를 그대로 비춘다. 토큰·비밀번호는 절대 여기로 오지 않는다.
interface AuthStoreState {
  state: AuthState | null
  loading: boolean
  /** 구글 로그인처럼 오래 걸리는 작업이 진행 중인지 */
  pending: 'signIn' | 'signUp' | 'google' | 'signOut' | null
  error: string | null
  devices: DeviceDto[]
  /** window.samba.devices 가 아직 없는 빌드(Task 9 미병합)인지 */
  devicesUnavailable: boolean
  devicesLoading: boolean
  load: () => Promise<void>
  subscribe: () => () => void
  signUp: (email: string, password: string) => Promise<boolean>
  signIn: (email: string, password: string) => Promise<boolean>
  /** 서버 정지·불통일 때 — 이 PC 키마스터로 비밀번호를 확인해 이 PC 의 계정 공간으로 들어간다 */
  signInOffline: (password: string) => Promise<boolean>
  signInGoogle: () => Promise<boolean>
  cancelGoogle: () => void
  signOut: () => Promise<boolean>
  /** 로그인한 계정에 데이터 Supabase 주소 저장 + 즉시 연결 */
  saveSupabase: (url: string, anonKey: string) => Promise<boolean>
  /** 비밀번호를 잊었을 때: 이 PC 에 살아 있는 세션으로 새 비밀번호 설정 + 로그인 */
  resetPassword: (email: string, password: string) => Promise<boolean>
  loadDevices: () => Promise<void>
  revokeDevice: (id: string) => Promise<boolean>
  clearError: () => void
}

export const useAuthStore = create<AuthStoreState>((set, get) => {
  // 로그인 계열 IPC 공통 처리 — 실패하면 error 만 남기고 상태는 건드리지 않는다
  const run = async (
    kind: NonNullable<AuthStoreState['pending']>,
    fn: () => Promise<{ ok: true; data: AuthState } | { ok: false; error: string }>
  ): Promise<boolean> => {
    set({ pending: kind, error: null })
    const r = await fn()
    // 취소(cancelGoogle)로 pending 이 이미 지워졌으면 늦게 온 응답은 버린다
    if (get().pending !== kind) return false
    if (!r.ok) {
      set({ pending: null, error: r.error })
      return false
    }
    set({ state: r.data, pending: null, error: null })
    return true
  }

  return {
    state: null,
    loading: false,
    pending: null,
    error: null,
    devices: [],
    devicesUnavailable: false,
    devicesLoading: false,

    load: async () => {
      set({ loading: true })
      const r = await window.samba.auth.state()
      if (r.ok) set({ state: r.data, loading: false, error: null })
      else set({ loading: false, error: r.error })
    },

    subscribe: () => window.samba.auth.onStateChanged((state) => set({ state })),

    signUp: (email, password) => run('signUp', () => window.samba.auth.signUp(email, password)),
    signIn: (email, password) => run('signIn', () => window.samba.auth.signIn(email, password)),
    signInOffline: (password) =>
      run('signIn', () => window.samba.auth.signInOffline(password)),
    // 기본 브라우저가 열리고 사용자가 구글 로그인을 마쳐야 응답이 온다(최대 5분)
    signInGoogle: () => run('google', () => window.samba.auth.signInGoogle()),
    // IPC 취소 채널이 없으므로 화면에서 기다리기를 그만두는 것까지만 한다
    cancelGoogle: () => set({ pending: null }),
    signOut: () => run('signOut', () => window.samba.auth.signOut()),
    saveSupabase: (url, anonKey) =>
      run('signIn', () => window.samba.auth.saveSupabase(url, anonKey)),
    resetPassword: (email, password) =>
      run('signIn', () => window.samba.auth.resetPassword(email, password)),

    loadDevices: async () => {
      const devices = window.samba.devices
      if (!devices) {
        set({ devicesUnavailable: true, devices: [] })
        return
      }
      set({ devicesLoading: true })
      const r = await devices.list()
      if (r.ok) set({ devices: r.data, devicesLoading: false, devicesUnavailable: false })
      else set({ devicesLoading: false, error: r.error })
    },

    revokeDevice: async (id) => {
      const devices = window.samba.devices
      if (!devices) {
        set({ devicesUnavailable: true })
        return false
      }
      const r = await devices.revoke(id)
      if (!r.ok) {
        set({ error: r.error })
        return false
      }
      await get().loadDevices()
      return true
    },

    clearError: () => set({ error: null })
  }
})
