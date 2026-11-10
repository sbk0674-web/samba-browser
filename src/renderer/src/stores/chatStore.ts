import { create } from 'zustand'
import type { AgentEvent, ChatDto, ChatMessageDto, HandoffKind } from '@shared/ipc'
import { RECENT_CHAT_LIMIT, titleFromMessage } from '@shared/chat'
import { agentImageDataUrl, type AgentImage } from '@shared/agent-image'
import { DEFAULT_SETTINGS, type AgentEffort } from '@shared/settings'

export interface ChatMessage {
  id: string
  role: 'user' | 'ai'
  text: string
  steps?: Step[]
  // 사용자가 붙여 넣은 이미지 미리보기(data URL). 이 세션 화면에만 있고 저장되지 않는다
  images?: string[]
}
export interface Step {
  label: string
  ok: boolean
  // 번역 키. 있으면 화면에서 i18n 문구로 바꿔 보여 준다(메인이 보내는 label 은 그대로 표시)
  key?: string
}

// 캡차·2FA 사용자 넘김 카드 상태
export interface Handoff {
  requestId: string
  // 카드 종류(captcha = 캡차·2FA, keypad = 결제 비밀번호 키패드). 문구가 달라진다
  kind: HandoffKind
  matched: string
  url: string
}

// SDK 재시도 대기 표시용 (진행 띠 라벨은 i18n 으로 화면에서 조립)
export interface Retry {
  attempt: number
  reason: string
}

// 여러 건짜리 작업의 진행 상황(progress 도구). 화면에는 "3/26" 배지로 뜬다
export interface TaskProgress {
  done: number
  total: number
  label?: string
}

interface ChatState {
  messages: ChatMessage[]
  // 사이드바에 걸리는 최근 대화 목록
  chats: ChatDto[]
  // 지금 열려 있는 대화. null 이면 아직 저장되지 않은 새 대화다
  activeChatId: number | null
  // 실행 세대 번호. 이전 작업의 늦은 IPC 응답이 새 작업 UI 를 덮지 않게 한다
  runSeq: number
  status: 'idle' | 'running' | 'done' | 'failed' | 'stopped'
  toolCalls: number
  currentLabel: string
  retry: Retry | null
  // 이번 실행에 적용된 플레이북 이름들(빈 배열이면 배지를 숨긴다)
  playbookNames: string[]
  // 여러 건짜리 작업의 진행 상황. null 이면 진행 배지를 숨긴다
  taskProgress: TaskProgress | null
  confirm: { requestId: string; action: string; kind: 'danger' | 'finish' } | null
  // 사이트가 사람의 추가 확인을 요구해 작업이 멈춰 있는 상태
  handoff: Handoff | null
  authError: 'missing' | 'limit' | null
  // 입력줄 아래 "모델 · 강도" 선택. 모델의 진실은 설정의 작업별 모델 표 중 '표준' 칸이다
  model: string
  modelChoices: string[]
  effort: AgentEffort
  // 설정에서 현재 모델·후보·추론 강도를 읽어 온다(입력줄이 뜰 때 한 번)
  loadModelMenu: () => Promise<void>
  setModel: (model: string) => Promise<void>
  setEffort: (effort: AgentEffort) => Promise<void>
  // 최근 대화 목록을 다시 읽는다(앱 시작·작업 종료 후)
  loadChats: () => Promise<void>
  // 저장된 대화를 열어 메시지를 화면에 올린다
  openChat: (chatId: number) => Promise<void>
  // 화면을 비우고 새 대화를 시작한다(대화 행은 첫 전송 때 만들어진다)
  newChat: () => void
  // 대화를 지운다(삭제 표식). 화면에 열려 있었으면 새 대화로 돌아간다
  removeChat: (chatId: number) => Promise<void>
  /** scheduleToken 은 예약이 보낸 실행임을 메인에 알리는 표식이다(사용자 입력에는 없다) */
  send: (text: string, scheduleToken?: string, images?: AgentImage[]) => Promise<void>
  stop: () => Promise<void>
  reply: (requestId: string, approved: boolean) => void
  // 넘김 카드 응답 — skip=true 는 건너뛰고 계속, false 는 작업 중단
  replyHandoff: (requestId: string, skip: boolean) => void
  handleEvent: (e: AgentEvent) => void
}

let seq = 0
const nid = (): string => String(++seq)

// 진행 로그(step)는 마지막 AI 메시지에 붙인다
export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  chats: [],
  activeChatId: null,
  runSeq: 0,
  status: 'idle',
  toolCalls: 0,
  currentLabel: '',
  retry: null,
  playbookNames: [],
  taskProgress: null,
  confirm: null,
  handoff: null,
  authError: null,
  model: DEFAULT_SETTINGS.taskModels.standard,
  modelChoices: [],
  effort: DEFAULT_SETTINGS.agentEffort,
  loadModelMenu: async () => {
    const r = await window.samba.ai?.taskModels()
    if (r?.ok) set({ model: r.data.taskModels.standard, modelChoices: r.data.choices })
    const s = await window.samba.settings?.get()
    if (s?.ok) set({ effort: s.data.agentEffort })
  },
  setModel: async (model) => {
    // 화면을 먼저 바꾸고 저장한다(실패하면 다음 loadModelMenu 에서 되돌아온다)
    set({ model })
    await window.samba.ai?.setTaskModel('standard', model)
  },
  setEffort: async (effort) => {
    set({ effort })
    await window.samba.settings?.set({ agentEffort: effort })
  },
  loadChats: async () => {
    const r = await window.samba.chats?.list(RECENT_CHAT_LIMIT)
    if (r?.ok) set({ chats: r.data })
  },
  openChat: async (chatId) => {
    if (get().status === 'running') return
    const r = await window.samba.chats?.get(chatId)
    if (!r?.ok || r.data === null) return
    set({
      activeChatId: chatId,
      messages: r.data.messages.map(toChatMessage),
      status: 'idle',
      toolCalls: 0,
      currentLabel: '',
      retry: null,
      playbookNames: [],
      taskProgress: null,
      confirm: null,
      handoff: null,
      authError: null
    })
  },
  newChat: () => {
    if (get().status === 'running') return
    set({
      activeChatId: null,
      messages: [],
      status: 'idle',
      toolCalls: 0,
      currentLabel: '',
      retry: null,
      playbookNames: [],
      taskProgress: null,
      confirm: null,
      handoff: null,
      authError: null
    })
  },
  removeChat: async (chatId) => {
    const r = await window.samba.chats?.remove(chatId)
    if (!r?.ok) return
    set((s) => ({ chats: s.chats.filter((c) => c.id !== chatId) }))
    if (get().activeChatId === chatId) get().newChat()
  },
  send: async (text, scheduleToken, images) => {
    if (get().status === 'running') return
    const seq = get().runSeq + 1
    const previews = images && images.length > 0 ? images.map(agentImageDataUrl) : undefined
    set((s) => ({
      messages: [
        ...s.messages,
        { id: nid(), role: 'user', text, ...(previews ? { images: previews } : {}) },
        { id: nid(), role: 'ai', text: '', steps: [] }
      ],
      runSeq: seq,
      status: 'running',
      toolCalls: 0,
      currentLabel: '',
      retry: null,
      playbookNames: [],
      taskProgress: null,
      confirm: null,
      handoff: null,
      authError: null
    }))
    // 아직 저장되지 않은 새 대화면 여기서 대화 행을 만든다(제목은 첫 메시지에서 짓는다).
    // 저장은 메인(러너)이 작업 완료 시점에 한 번에 한다
    let chatId = get().activeChatId
    if (chatId === null) {
      const created = await window.samba.chats?.create(titleFromMessage(text) || text.slice(0, 40))
      if (created?.ok) {
        chatId = created.data.id
        set((s) => ({ activeChatId: created.data.id, chats: [created.data, ...s.chats] }))
      }
    }
    // 메인은 "시작 접수" ack 만 즉시 돌려준다. 완료·실패는 status 이벤트로 온다.
    // 늦게 도착한 이전 세대의 응답은 버린다
    // 예약 실행이 아니면 인자를 덧붙이지 않는다(평소 경로의 호출 모양을 그대로 둔다)
    const args: [string, number?, string?] =
      scheduleToken === undefined
        ? chatId === null
          ? [text]
          : [text, chatId]
        : [text, chatId ?? undefined, scheduleToken]
    // 이미지가 있을 때만 네 번째 인자를 붙인다(평소 경로의 호출 모양을 그대로 둔다)
    const r =
      images && images.length > 0
        ? await window.samba.agent.run(text, chatId ?? undefined, scheduleToken, images)
        : await window.samba.agent.run(...args)
    if (!r.ok && get().runSeq === seq) set({ status: 'failed', currentLabel: r.error, retry: null })
  },
  stop: async () => {
    await window.samba.agent.stop()
  },
  reply: (requestId, approved) => {
    window.samba.agent.confirmReply(requestId, approved)
    set({ confirm: null })
  },
  // 넘김 카드도 확인 카드와 같은 응답 채널을 쓴다(승인=건너뛰고 계속, 거부=작업 중단)
  replyHandoff: (requestId, skip) => {
    window.samba.agent.confirmReply(requestId, skip)
    set({ handoff: null })
    // '작업 중단'은 응답만으로 끝나지 않는다 — 실행 자체를 멈춘다
    if (!skip) void window.samba.agent.stop()
  },
  handleEvent: (e) => {
    const msgs = get().messages
    const last = msgs[msgs.length - 1]
    const patchLast = (p: Partial<ChatMessage>): void =>
      set({ messages: [...msgs.slice(0, -1), { ...last, ...p }] })
    if (e.type === 'text' && last?.role === 'ai')
      patchLast({ text: last.text ? `${last.text}\n${e.text}` : e.text })
    if (e.type === 'step' && last?.role === 'ai') {
      patchLast({ steps: [...(last.steps ?? []), { label: e.label, ok: e.ok }] })
      set((s) => ({ toolCalls: s.toolCalls + 1, currentLabel: e.label, retry: null }))
    }
    if (e.type === 'progress' && e.kind === 'apiRetry')
      set({ retry: { attempt: e.attempt, reason: e.reason } })
    // progress 도구가 알려 준 "n/N" — 화면 위쪽 진행 배지에 그대로 뜬다
    if (e.type === 'progress' && e.kind === 'task')
      set({
        taskProgress:
          e.label === undefined
            ? { done: e.done, total: e.total }
            : { done: e.done, total: e.total, label: e.label }
      })
    // 이번 실행에 적용된 플레이북(이름만 온다)
    if (e.type === 'playbook') set({ playbookNames: e.names })
    if (e.type === 'confirm')
      set({ confirm: { requestId: e.requestId, action: e.action, kind: e.kind ?? 'danger' } })
    if (e.type === 'handoff') {
      set({ handoff: { requestId: e.requestId, kind: e.kind, matched: e.matched, url: e.url } })
      if (last?.role === 'ai') {
        patchLast({
          steps: [...(last.steps ?? []), { label: '', ok: true, key: 'handoff.waiting' }]
        })
      }
    }
    if (e.type === 'handoffDone') {
      // 자동 재개·시간 초과로 끝났을 수도 있으므로 카드를 항상 닫는다
      set({ handoff: null })
      if (last?.role === 'ai') {
        patchLast({
          steps: [
            ...(last.steps ?? []),
            {
              label: '',
              ok: e.outcome !== 'aborted' && e.outcome !== 'timeout',
              key: `handoff.step.${e.outcome}`
            }
          ]
        })
      }
    }
    if (e.type === 'status') {
      // 중단·실패·완료 뒤에 뒤늦게 도착한 running 은 무시한다.
      // send() 가 실행을 시작할 때 status 를 먼저 running 으로 바꾸므로 정상 시작은 통과한다
      if (e.state === 'running' && get().status !== 'running') return
      const auth = e.message?.startsWith('auth:')
        ? (e.message.slice(5) as 'missing' | 'limit')
        : null
      const done = e.state === 'done' || e.state === 'failed' || e.state === 'stopped'
      // 실패 사유는 말풍선에 남긴다 — 예전엔 상태만 바꾸고 문구를 버려, 시작도 못 한 지시(자동 작업이
      // 브라우저를 쓰는 중 등)가 아무 반응 없이 끝난 것처럼 보였다(실기 2026-11-10 "반응이 없어")
      if (e.state === 'failed' && e.message && !auth && last?.role === 'ai' && !last.text)
        patchLast({ text: e.message })
      // 작업이 끝나면 메인이 방금 기록을 남겼다 — 목록의 제목·순서를 다시 읽는다
      if (done) void get().loadChats()
      set({
        status: e.state,
        authError: auth,
        toolCalls: e.toolCalls ?? get().toolCalls,
        retry: e.state === 'running' ? get().retry : null,
        // 중단 후 응답 불가능한 확인·넘김 카드가 남지 않도록 정리
        confirm: done ? null : get().confirm,
        handoff: done ? null : get().handoff
      })
    }
  }
}))

/** 저장된 메시지 한 줄을 화면 메시지로 바꾼다(system 은 AI 말풍선으로 보여 준다) */
function toChatMessage(row: ChatMessageDto): ChatMessage {
  return {
    id: `db-${row.id}`,
    role: row.role === 'user' ? 'user' : 'ai',
    text: row.content,
    steps: row.steps ?? undefined
  }
}
