import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AgentEvent,
  type AgentRunAck,
  type IpcResult,
  type Layout,
  type Settings,
  type TabInfo,
  type AccountDto,
  type CaptureDecision,
  type CapturePromptDto,
  type PasswordUpdatedDto,
  type SiteDto,
  type VaultItemMeta,
  type VaultItemType,
  type FieldKind,
  type AgentAccess,
  type VaultState,
  type AuditLogDto,
  type ImportPasswordsResult,
  type ImportBookmarksResult,
  type BookmarkTreeDto,
  type AiConnectResult,
  type AiProviderId,
  type AiProviderStatus,
  type ApiKeyVendor,
  type SubscriptionProviderId,
  type TaskModelKey,
  type TaskModels,
  type SyncStatus,
  type BaselineReport,
  type ExtensionActionResult,
  type ExtensionAnchorDto,
  type ExtensionDto,
  type ExtensionInstallResult,
  type ExtensionListDto,
  type ImportBrowserDto,
  type DeviceDto,
  type ChatDto,
  type ChatDetailDto,
  type ChatMessageDto,
  type AppendMessageInput,
  type PlaybookDto,
  type PlaybookInput,
  type ScheduleDispatchDto,
  type ScheduleStatusDto,
  type RecommendApplyDto,
  type RecommendDto,
  type SiteMemorySummary,
  type PhoneDto,
  type PhoneUpdatedDto,
  type PhoneAuthWaitingDto,
  type AuthEventDto,
  type PhoneScreenChunkDto,
  type ScreenMode,
  type PhoneScreenModeDto,
  type PhoneToolsStatusDto,
  type PhoneToolsProgressDto,
  type TranslateLang,
  type TranslateProgressDto,
  type CaptureMode,
  type CaptureBeginVideoDto,
  type CaptureResultDto,
  type CaptureStillDto,
  type CaptureVideoSourceDto,
  type NotifyChannel,
  type NotifySendResult
} from '../shared/ipc'
import type { AgentImage } from '../shared/agent-image'
import type { AiUsage } from '../shared/ai'
import type { AuthState, WorkspaceDto } from '../shared/sync'
import type { ExportRequest, ExportResult } from '../shared/vault'
import type { HarnessResult } from '../main/harness/client'
import type {
  HarnessGraph,
  HarnessJobs,
  HarnessReleases,
  HarnessRules,
  HarnessRulesSaved
} from '../shared/harness'

// 북마크 관리자 페이지용 요청 입력 타입
interface BookmarkMoveInput {
  id: number
  kind: 'folder' | 'link'
  toFolderId: number | null
}

// 끌어 옮기기 — 폴더 안 자리(toIndex)까지 지정한다
interface BookmarkPlaceInput extends BookmarkMoveInput {
  toIndex: number
}

// 항목 저장 요청. value(평문)는 렌더러 → 메인 방향으로만 흐른다
interface PutFieldInput {
  key: string
  label: string
  kind: FieldKind
  // 생략하면 메인이 기존 암호문을 유지한다
  value?: string
}

interface PutSectionInput {
  key: string
  label: string
  fields: PutFieldInput[]
}

interface PutItemInput {
  // 편집 대상 항목 id. 주면 그 항목을 그대로 갱신한다
  id?: number
  accountId: number | null
  type: VaultItemType
  label: string
  // 단일 값 항목(하위 호환)
  value?: string
  // 섹션>필드 구조
  sections?: PutSectionInput[]
}

interface UpsertAccountInput {
  id?: number
  host: string
  // 생략하면 메인이 기존 계정의 라벨을 유지한다
  label?: string
  username: string
  isDefault?: boolean
  siteName?: string
  loginUrl?: string
  // 생략하면 메인이 기존 값을 유지한다
  urls?: string[]
  agentAccess?: AgentAccess
  tags?: string[]
}

// ipcRenderer.invoke 반환 타입이 Promise<any> 이므로 제네릭 헬퍼로 감싸 IpcResult<T> 를 명시
function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

// React UI가 쓰는 API. 반환은 전부 IpcResult
const api = {
  tabs: {
    list: (): Promise<IpcResult<TabInfo[]>> => invoke(IPC.tabList),
    create: (o: {
      url?: string
      profile?: string
      mobile?: boolean
    }): Promise<IpcResult<TabInfo>> => invoke(IPC.tabCreate, o),
    close: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabClose, id),
    activate: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabActivate, id),
    navigate: (id: string, url: string): Promise<IpcResult<void>> =>
      invoke(IPC.tabNavigate, id, url),
    back: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabBack, id),
    forward: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabForward, id),
    reload: (id: string): Promise<IpcResult<void>> => invoke(IPC.tabReload, id),
    setMobile: (id: string, mobile: boolean): Promise<IpcResult<void>> =>
      invoke(IPC.tabSetMobile, id, mobile),
    /** 탭을 toIndex 자리로 옮긴다(탭 바 끌어 옮기기) */
    move: (id: string, toIndex: number): Promise<IpcResult<void>> =>
      invoke(IPC.tabMove, id, toIndex),
    /** 이 작업공간에서 쓴 프로필(계정별 세션) 이름 목록 — 기본 프로필은 빠져 있다 */
    profiles: (): Promise<IpcResult<string[]>> => invoke(IPC.profileList),
    onUpdated: (cb: (tabs: TabInfo[]) => void): (() => void) => {
      const h = (_: unknown, tabs: TabInfo[]): void => cb(tabs)
      ipcRenderer.on(IPC.tabUpdated, h)
      return () => ipcRenderer.off(IPC.tabUpdated, h)
    }
  },
  layout: {
    set: (l: Layout): Promise<IpcResult<void>> => invoke(IPC.layoutSet, l)
  },
  agent: {
    // 반환은 "시작 접수" ack 뿐. 완료·실패는 onEvent 의 status 이벤트로 온다
    // chatId 를 주면 메인이 완료 시점에 그 대화에 기록을 남긴다
    // scheduleToken 은 예약이 보낸 실행을 잇는 표식이다(사용자가 직접 칠 때는 없다)
    // images 는 AI 창에 붙여 넣은 그림(base64). 없으면 인자를 덧붙이지 않는다
    run: (
      prompt: string,
      chatId?: number,
      scheduleToken?: string,
      images?: AgentImage[]
    ): Promise<IpcResult<AgentRunAck>> =>
      images === undefined
        ? invoke(IPC.agentRun, prompt, chatId, scheduleToken)
        : invoke(IPC.agentRun, prompt, chatId, scheduleToken, images),
    stop: (): Promise<IpcResult<void>> => invoke(IPC.agentStop),
    confirmReply: (requestId: string, approved: boolean): void => {
      ipcRenderer.send(IPC.agentConfirmReply, requestId, approved)
    },
    onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
      const h = (_: unknown, e: AgentEvent): void => cb(e)
      ipcRenderer.on(IPC.agentEvent, h)
      return () => ipcRenderer.off(IPC.agentEvent, h)
    }
  },
  // AI 채팅 기록 — 본문은 평문이지만 비밀값은 담기지 않는다(진행 로그는 라벨만)
  chats: {
    list: (limit?: number): Promise<IpcResult<ChatDto[]>> => invoke(IPC.chatList, limit),
    create: (title: string): Promise<IpcResult<ChatDto>> => invoke(IPC.chatCreate, title),
    get: (chatId: number): Promise<IpcResult<ChatDetailDto | null>> => invoke(IPC.chatGet, chatId),
    append: (input: AppendMessageInput): Promise<IpcResult<ChatMessageDto | null>> =>
      invoke(IPC.chatAppend, input),
    rename: (chatId: number, title: string): Promise<IpcResult<ChatDto | null>> =>
      invoke(IPC.chatRename, chatId, title),
    remove: (chatId: number): Promise<IpcResult<boolean>> => invoke(IPC.chatDelete, chatId)
  },
  // 알림 연동 — 설정 화면의 [테스트 보내기]. 웹훅 주소·봇 토큰은 메인이 쥔 값을 쓴다
  notify: {
    test: (channel: NotifyChannel): Promise<IpcResult<NotifySendResult>> =>
      invoke(IPC.notifyTest, channel)
  },
  // 자동화 플레이북 — 이름·트리거·절차 마크다운뿐이다(비밀값은 담기지 않는다)
  playbooks: {
    list: (): Promise<IpcResult<PlaybookDto[]>> => invoke(IPC.playbookList),
    // id 를 빼면 새로 만든다. 이름이 비었거나 없는 id 면 null 이 온다
    put: (input: PlaybookInput): Promise<IpcResult<PlaybookDto | null>> =>
      invoke(IPC.playbookPut, input),
    // 내장 플레이북은 지워지지 않는다(false) — 대신 restore 로 되돌린다
    remove: (id: string): Promise<IpcResult<boolean>> => invoke(IPC.playbookDelete, id),
    restore: (id: string): Promise<IpcResult<PlaybookDto | null>> => invoke(IPC.playbookRestore, id)
  },
  // 예약 실행 — 설정은 플레이북에 실려 동기화되고, 실행 기록은 이 PC 에만 남는다
  schedule: {
    status: (): Promise<IpcResult<ScheduleStatusDto[]>> => invoke(IPC.scheduleStatus),
    // 다른 작업이 돌고 있으면 false 가 온다(카드가 버튼을 잠근다)
    runNow: (playbookId: string): Promise<IpcResult<boolean>> =>
      invoke(IPC.scheduleRunNow, playbookId),
    setPaused: (playbookId: string, paused: boolean): Promise<IpcResult<boolean>> =>
      invoke(IPC.scheduleSetPaused, playbookId, paused),
    onChanged: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on(IPC.scheduleChanged, h)
      return () => ipcRenderer.off(IPC.scheduleChanged, h)
    },
    // 예약이 때가 됐다고 알려 온다. 렌더러는 이 문구를 평소 채팅과 똑같이 보낸다
    onDispatch: (cb: (req: ScheduleDispatchDto) => void): (() => void) => {
      const h = (_: unknown, req: ScheduleDispatchDto): void => cb(req)
      ipcRenderer.on(IPC.scheduleDispatch, h)
      return () => ipcRenderer.off(IPC.scheduleDispatch, h)
    }
  },
  // 활동 기록·추천 — 기록 자체는 오가지 않는다. 화면이 받는 것은 후보 목록뿐이다
  activity: {
    recommend: (): Promise<IpcResult<RecommendDto[]>> => invoke(IPC.activityRecommend),
    dismiss: (key: string): Promise<IpcResult<boolean>> => invoke(IPC.activityDismiss, key),
    apply: (key: string): Promise<IpcResult<RecommendApplyDto | null>> =>
      invoke(IPC.activityApply, key),
    clear: (): Promise<IpcResult<boolean>> => invoke(IPC.activityClear)
  },
  // 사이트 기억 — 호스트별 개수만 나간다(경로·메모 본문은 메인에 남는다)
  siteMemory: {
    list: (): Promise<IpcResult<SiteMemorySummary[]>> => invoke(IPC.siteMemoryList),
    forget: (host: string): Promise<IpcResult<boolean>> => invoke(IPC.siteMemoryForget, host)
  },
  settings: {
    get: (): Promise<IpcResult<Settings>> => invoke(IPC.settingsGet),
    set: (patch: Partial<Settings>): Promise<IpcResult<Settings>> => invoke(IPC.settingsSet, patch)
  },
  bridge: {
    regenerateToken: (): Promise<IpcResult<{ token: string }>> => invoke(IPC.bridgeRegenerateToken)
  },
  // 하네스(밖에서 도는 주문처리 하네스)의 읽기 API. 오류는 status 로 온다
  harness: {
    graph: (): Promise<IpcResult<HarnessResult<HarnessGraph>>> => invoke(IPC.harnessGraph),
    jobs: (): Promise<IpcResult<HarnessResult<HarnessJobs>>> => invoke(IPC.harnessJobs),
    releases: (): Promise<IpcResult<HarnessResult<HarnessReleases>>> => invoke(IPC.harnessReleases),
    getRules: (agent: string): Promise<IpcResult<HarnessResult<HarnessRules>>> =>
      invoke(IPC.harnessGetRules, agent),
    putRules: (agent: string, text: string): Promise<IpcResult<HarnessResult<HarnessRulesSaved>>> =>
      invoke(IPC.harnessPutRules, agent, text)
  },
  // 금고 — reveal 만이 평문을 돌려준다. 나머지는 상태·메타뿐이다
  vault: {
    state: (): Promise<IpcResult<VaultState>> => invoke(IPC.vaultState),
    // 이 금고가 다른 PC 에서 내려온 키 재료로 만들어졌는가(잠금 해제 화면 안내 문구용)
    keyFromSync: (): Promise<IpcResult<boolean>> => invoke(IPC.vaultKeyFromSync),
    setup: (master: string): Promise<IpcResult<void>> => invoke(IPC.vaultSetup, master),
    unlock: (master: string): Promise<IpcResult<boolean>> => invoke(IPC.vaultUnlock, master),
    lock: (): Promise<IpcResult<void>> => invoke(IPC.vaultLock),
    // 이 PC 금고가 계정과 다른 마스터로 잠겨 있을 때: 계정 마스터로 다시 잠근다
    rekeyToAccount: (
      master: string
    ): Promise<IpcResult<'ok' | 'locked' | 'no-remote' | 'wrong-master' | 'decrypt-failed'>> =>
      invoke(IPC.vaultRekeyToAccount, master),
    // 복구 키 — create 응답의 평문은 화면에 보여 준 뒤 확인 완료 즉시 렌더러 상태에서 버린다
    recoveryCreate: (): Promise<IpcResult<string>> => invoke(IPC.vaultRecoveryCreate),
    recoveryConfirm: (input: string): Promise<IpcResult<boolean>> =>
      invoke(IPC.vaultRecoveryConfirm, input),
    recoveryUnlock: (input: string): Promise<IpcResult<boolean>> =>
      invoke(IPC.vaultRecoveryUnlock, input),
    sites: (): Promise<IpcResult<SiteDto[]>> => invoke(IPC.vaultSites),
    accounts: (host?: string): Promise<IpcResult<AccountDto[]>> => invoke(IPC.vaultAccounts, host),
    items: (accountId: number | null): Promise<IpcResult<VaultItemMeta[]>> =>
      invoke(IPC.vaultItems, accountId),
    putItem: (input: PutItemInput): Promise<IpcResult<VaultItemMeta>> =>
      invoke(IPC.vaultPutItem, input),
    deleteItem: (id: number): Promise<IpcResult<void>> => invoke(IPC.vaultDeleteItem, id),
    // 결제 비밀번호 항목을 다른 계정으로 복사. 복사한 개수만 돌아온다
    copyPaymentItems: (fromAccountId: number, toAccountId: number): Promise<IpcResult<number>> =>
      invoke(IPC.vaultCopyPaymentItems, fromAccountId, toAccountId),
    // 사용자가 '보기' 를 눌렀을 때만 호출한다. fieldKey 로 항목 안의 개별 필드를 지정한다
    reveal: (id: number, fieldKey?: string): Promise<IpcResult<string>> =>
      invoke(IPC.vaultReveal, id, fieldKey),
    // 상세 화면의 '자동 채우기'. 값은 메인 안에서만 오가고 여기로는 결과 문자열만 온다
    autofill: (accountId: number): Promise<IpcResult<string>> =>
      invoke(IPC.vaultAutofill, accountId),
    upsertAccount: (dto: UpsertAccountInput): Promise<IpcResult<AccountDto>> =>
      invoke(IPC.vaultUpsertAccount, dto),
    // 계정 삭제(딸린 항목까지). 되돌리기 토큰만 돌려받는다(스냅샷은 메인에 남는다)
    deleteAccounts: (ids: number[]): Promise<IpcResult<{ token: string; count: number }>> =>
      invoke(IPC.vaultDeleteAccounts, ids),
    undoDelete: (token: string): Promise<IpcResult<boolean>> => invoke(IPC.vaultUndoDelete, token),
    // 같은 사이트(등록 도메인)의 같은 아이디 계정을 하나로 합친다. 지운 계정은 되돌리기 토큰으로 60초 보관
    mergeDomain: (
      domain: string
    ): Promise<IpcResult<{ token: string | null; kept: number; removed: number }>> =>
      invoke(IPC.vaultMergeDomain, domain),
    // 사용 기록(감사 로그). accountId 생략 시 전체(최근 200건), 계정 지정 시 해당 계정 항목만
    audit: (accountId?: number, limit?: number): Promise<IpcResult<AuditLogDto[]>> =>
      invoke(IPC.vaultAudit, accountId, limit),
    // 내보내기. master(재입력 값)는 메인 방향으로만 흐르고, 응답에는 개수·경로만 온다
    exportVault: (req: ExportRequest): Promise<IpcResult<ExportResult>> =>
      invoke(IPC.vaultExport, req),
    onStateChanged: (cb: (state: VaultState) => void): (() => void) => {
      const h = (_: unknown, state: VaultState): void => cb(state)
      ipcRenderer.on(IPC.vaultStateChanged, h)
      return () => ipcRenderer.off(IPC.vaultStateChanged, h)
    },
    onCapturePrompt: (cb: (prompt: CapturePromptDto) => void): (() => void) => {
      const h = (_: unknown, prompt: CapturePromptDto): void => cb(prompt)
      ipcRenderer.on(IPC.vaultCapturePrompt, h)
      return () => ipcRenderer.off(IPC.vaultCapturePrompt, h)
    },
    // 확인 바의 답(save·skip·never). 값은 메인에 남아 있고 이 채널에는 답만 실린다
    captureDecision: (decision: CaptureDecision): void => {
      ipcRenderer.send(IPC.vaultCaptureDecision, decision)
    },
    // 로그인 성공 감지로 비밀번호가 자동 갱신됐을 때(묻지 않음). 토스트로 알리고 되돌리기를 제공한다
    onPasswordUpdated: (cb: (dto: PasswordUpdatedDto) => void): (() => void) => {
      const h = (_: unknown, dto: PasswordUpdatedDto): void => cb(dto)
      ipcRenderer.on(IPC.vaultPasswordUpdated, h)
      return () => ipcRenderer.off(IPC.vaultPasswordUpdated, h)
    },
    undoPasswordUpdate: (undoToken: string): void => {
      ipcRenderer.send(IPC.vaultUndoPasswordUpdate, undoToken)
    }
  },
  // 가져오기 — filePath 생략 시 메인이 파일 선택 다이얼로그를 연다
  importData: {
    passwords: (filePath?: string): Promise<IpcResult<ImportPasswordsResult>> =>
      invoke(IPC.importPasswords, filePath),
    bookmarks: (filePath?: string): Promise<IpcResult<ImportBookmarksResult>> =>
      invoke(IPC.importBookmarks, filePath)
  },
  bookmarks: {
    tree: (): Promise<IpcResult<BookmarkTreeDto>> => invoke(IPC.bookmarksTree),
    remove: (id: number): Promise<IpcResult<void>> => invoke(IPC.bookmarksRemove, id),
    createFolder: (parentId: number | null, name: string): Promise<IpcResult<number>> =>
      invoke(IPC.bookmarksCreateFolder, { parentId, name }),
    createLink: (folderId: number | null, title: string, url: string): Promise<IpcResult<number>> =>
      invoke(IPC.bookmarksCreateLink, { folderId, title, url }),
    rename: (id: number, kind: 'folder' | 'link', name: string): Promise<IpcResult<void>> =>
      invoke(IPC.bookmarksRename, { id, kind, name }),
    move: (input: BookmarkMoveInput): Promise<IpcResult<void>> => invoke(IPC.bookmarksMove, input),
    place: (input: BookmarkPlaceInput): Promise<IpcResult<void>> =>
      invoke(IPC.bookmarksPlace, input),
    removeFolder: (id: number): Promise<IpcResult<void>> => invoke(IPC.bookmarksRemoveFolder, id),
    sort: (folderId: number | null): Promise<IpcResult<void>> =>
      invoke(IPC.bookmarksSort, { folderId, by: 'name' }),
    export: (): Promise<IpcResult<string | undefined>> => invoke(IPC.bookmarksExport)
  },
  // AI 연결 — 평문 키는 setApiKey 로 들어가기만 하고 되돌아오지 않는다.
  // 이쪽으로 오는 것은 마스킹 문자열과 boolean 뿐이다
  ai: {
    providers: (): Promise<IpcResult<AiProviderStatus[]>> => invoke(IPC.aiProviders),
    // 구독 연결. openTerminal 이면 새 터미널 창에서 `claude login`/`codex login` 을 띄운다
    connect: (
      provider: SubscriptionProviderId,
      openTerminal = false
    ): Promise<IpcResult<AiConnectResult>> => invoke(IPC.aiConnect, provider, openTerminal),
    disconnect: (provider: SubscriptionProviderId): Promise<IpcResult<AiConnectResult>> =>
      invoke(IPC.aiDisconnect, provider),
    // 다른 계정으로 바꾸기: 로그아웃 + 로그인 터미널을 연다(로그인은 사용자가 그 창에서 한다)
    switchAccount: (provider: SubscriptionProviderId): Promise<IpcResult<{ opened: boolean }>> =>
      invoke(IPC.aiSwitchAccount, provider),
    // Claude 구독 사용량(비율·재설정 시각). 조회 실패는 null
    usage: (provider?: SubscriptionProviderId): Promise<IpcResult<AiUsage | null>> =>
      invoke(IPC.aiUsage, provider),
    setProvider: (
      id: AiProviderId
    ): Promise<
      IpcResult<{ provider: AiProviderId; taskModels: TaskModels; changed: TaskModelKey[] }>
    > => invoke(IPC.aiSetProvider, id),
    setApiKey: (
      vendor: ApiKeyVendor,
      key: string
    ): Promise<IpcResult<Partial<Record<ApiKeyVendor, string>>>> =>
      invoke(IPC.aiSetApiKey, vendor, key),
    testKey: (vendor: ApiKeyVendor, key: string): Promise<IpcResult<{ ok: boolean }>> =>
      invoke(IPC.aiTestKey, vendor, key),
    taskModels: (): Promise<
      IpcResult<{ provider: AiProviderId; taskModels: TaskModels; choices: string[] }>
    > => invoke(IPC.aiTaskModels),
    setTaskModel: (key: TaskModelKey, model: string): Promise<IpcResult<TaskModels>> =>
      invoke(IPC.aiSetTaskModel, key, model)
  },
  // 계정 — 응답은 언제나 AuthState 뿐이다(토큰·비밀번호는 메인에 남는다)
  auth: {
    state: (): Promise<IpcResult<AuthState>> => invoke(IPC.authState),
    signUp: (email: string, password: string): Promise<IpcResult<AuthState>> =>
      invoke(IPC.authSignUp, email, password),
    signIn: (email: string, password: string): Promise<IpcResult<AuthState>> =>
      invoke(IPC.authSignIn, email, password),
    // 서버(Supabase)가 정지·불통일 때만 — 이 PC 키마스터로 비밀번호를 확인해 이 PC 의 계정 공간으로 들어간다
    signInOffline: (password: string): Promise<IpcResult<AuthState>> =>
      invoke(IPC.authSignInOffline, password),
    // 기본 브라우저가 열리고, 사용자가 구글 로그인을 마쳐야 응답이 온다(최대 5분)
    signInGoogle: (): Promise<IpcResult<AuthState>> => invoke(IPC.authSignInGoogle),
    signOut: (): Promise<IpcResult<AuthState>> => invoke(IPC.authSignOut),
    // 로그인한 계정에 데이터 Supabase 주소를 저장하고 곧바로 붙인다
    saveSupabase: (url: string, anonKey: string): Promise<IpcResult<AuthState>> =>
      invoke(IPC.authSaveSupabase, { url, anonKey }),
    // 비밀번호를 잊었을 때 — 이 PC 에 살아 있는 세션으로 새 비밀번호를 정하고 로그인한다
    resetPassword: (email: string, password: string): Promise<IpcResult<AuthState>> =>
      invoke(IPC.authResetPassword, email, password),
    onStateChanged: (cb: (state: AuthState) => void): (() => void) => {
      const h = (_: unknown, state: AuthState): void => cb(state)
      ipcRenderer.on(IPC.authStateChanged, h)
      return () => ipcRenderer.off(IPC.authStateChanged, h)
    }
  },
  // 파비콘 — 메인이 사이트 자체에서 받아 온 dataUrl. 호스트는 제3자로 나가지 않는다
  favicon: {
    get: (host: string): Promise<IpcResult<{ dataUrl: string | null }>> =>
      invoke(IPC.faviconGet, host)
  },
  // 작업공간(브라우저 프로필) — 전환은 메인이 세션 파티션·조회 범위를 함께 바꾼다
  workspace: {
    list: (): Promise<IpcResult<WorkspaceDto[]>> => invoke(IPC.workspaceList),
    create: (name: string, color?: string): Promise<IpcResult<WorkspaceDto>> =>
      invoke(IPC.workspaceCreate, { name, color }),
    switch: (id: number): Promise<IpcResult<WorkspaceDto>> => invoke(IPC.workspaceSwitch, id),
    rename: (id: number, name: string): Promise<IpcResult<WorkspaceDto>> =>
      invoke(IPC.workspaceRename, { id, name }),
    remove: (id: number): Promise<IpcResult<void>> => invoke(IPC.workspaceDelete, id),
    // 단축키(Ctrl+Alt+1~9)로 바뀐 경우에도 렌더러가 따라오도록 메인이 밀어 준다
    onChanged: (cb: (w: WorkspaceDto) => void): (() => void) => {
      const h = (_: unknown, w: WorkspaceDto): void => cb(w)
      ipcRenderer.on(IPC.workspaceChanged, h)
      return () => ipcRenderer.off(IPC.workspaceChanged, h)
    }
  },
  // 기기 — 목록과 원격 로그아웃. 취소된 PC 는 다음 동기화 주기에 스스로 로그아웃한다
  devices: {
    list: (): Promise<IpcResult<DeviceDto[]>> => invoke(IPC.devicesList),
    revoke: (id: string): Promise<IpcResult<void>> => invoke(IPC.devicesRevoke, id)
  },
  // 동기화 — 상태 표시줄용. 토큰·비밀값은 오지 않는다
  sync: {
    status: (): Promise<IpcResult<SyncStatus>> => invoke(IPC.syncStatus),
    now: (): Promise<IpcResult<SyncStatus>> => invoke(IPC.syncNow),
    /**
     * 이 PC 의 키마스터를 기준으로 선언해 다른 PC 를 맞춘다. dryRun 이면 서버와 견준 숫자만 돌려준다.
     * 서버에만 있는 계정·항목에는 삭제 표식이 올라가므로 화면은 숫자를 보여 주고 확인받은 뒤에 실행한다
     */
    keymasterBaseline: (dryRun: boolean): Promise<IpcResult<BaselineReport>> =>
      invoke(IPC.syncKeymasterBaseline, dryRun),
    onStatusChanged: (cb: (status: SyncStatus) => void): (() => void) => {
      const h = (_: unknown, status: SyncStatus): void => cb(status)
      ipcRenderer.on(IPC.syncStatusChanged, h)
      return () => ipcRenderer.off(IPC.syncStatusChanged, h)
    }
  },
  // 확장 — 압축 해제된 폴더만 다룬다. load 를 인자 없이 부르면 메인이 폴더 선택창을 연다
  extensions: {
    list: (): Promise<IpcResult<ExtensionListDto>> => invoke(IPC.extList),
    load: (path?: string): Promise<IpcResult<ExtensionDto | null>> => invoke(IPC.extLoad, path),
    remove: (id: string): Promise<IpcResult<void>> => invoke(IPC.extRemove, id),
    // 확장을 켜고 끈다. 끄면 목록에는 남고 세션에서만 빠진다
    setEnabled: (id: string, enabled: boolean): Promise<IpcResult<ExtensionDto>> =>
      invoke(IPC.extSetEnabled, id, enabled),
    // 다른 브라우저(크롬·웨일·엣지·브레이브)에 설치된 확장 목록
    importSources: (): Promise<IpcResult<ImportBrowserDto[]>> => invoke(IPC.extImportSources),
    // 고른 확장을 앱 데이터로 복사한 뒤 로드한다(항목별 성공·실패)
    importFrom: (ids: string[]): Promise<IpcResult<ExtensionInstallResult[]>> =>
      invoke(IPC.extImportFrom, ids),
    // 웹스토어 주소 또는 32자 id 로 설치한다(보조 경로 — 기본은 웹스토어 탭의 "Chrome에 추가")
    installWebstore: (input: string): Promise<IpcResult<ExtensionInstallResult>> =>
      invoke(IPC.extInstallWebstore, input),
    // 웹스토어 탭에서 설치가 끝나는 등 목록이 바뀌면 메인이 알려 준다
    onChanged: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on(IPC.extChanged, h)
      return () => ipcRenderer.off(IPC.extChanged, h)
    },
    // 툴바 아이콘·퍼즐 메뉴 항목을 눌렀을 때. anchor 는 버튼의 화면 좌표로,
    // 메인이 그 아래에 팝업 문서를 붙인다(좌표 말고는 아무 값도 흐르지 않는다)
    action: (id: string, anchor: ExtensionAnchorDto): Promise<IpcResult<ExtensionActionResult>> =>
      invoke(IPC.extAction, id, anchor),
    closePopup: (): Promise<IpcResult<void>> => invoke(IPC.extPopupClose),
    // 팝업이 스스로 닫혔을 때(바깥 클릭·Esc·탭 전환) 버튼 표시를 되돌리도록 알려 준다
    onPopupClosed: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on(IPC.extPopupClosed, h)
      return () => ipcRenderer.off(IPC.extPopupClosed, h)
    }
  },
  // 화면 번역 · 이미지 번역 — 원문/번역문만 오간다(입력값·비밀번호는 실리지 않는다)
  translate: {
    run: (lang?: TranslateLang): Promise<IpcResult<string>> => invoke(IPC.translateRun, lang),
    restore: (): Promise<IpcResult<string>> => invoke(IPC.translateRestore),
    clearCache: (): Promise<IpcResult<boolean>> => invoke(IPC.translateCacheClear),
    // 진행률·실패 사유 구독(개수와 고정된 사유 코드만 온다)
    onProgress: (cb: (dto: TranslateProgressDto) => void): (() => void) => {
      const h = (_: unknown, dto: TranslateProgressDto): void => cb(dto)
      ipcRenderer.on(IPC.translateProgress, h)
      return () => ipcRenderer.off(IPC.translateProgress, h)
    }
  },
  // 폰 연동 — 결제 비밀번호·문자 본문은 이 중 어느 채널로도 오지 않는다
  phone: {
    list: (): Promise<IpcResult<PhoneDto[]>> => invoke(IPC.phoneList),
    refresh: (): Promise<IpcResult<PhoneDto[]>> => invoke(IPC.phoneRefresh),
    detectPaths: (): Promise<IpcResult<{ adb: string; scrcpy: string }>> =>
      invoke(IPC.phoneDetectPaths),
    connect: (address: string): Promise<IpcResult<{ ok: boolean; message: string }>> =>
      invoke(IPC.phoneConnect, address),
    disconnect: (serial: string): Promise<IpcResult<void>> => invoke(IPC.phoneDisconnect, serial),
    recover: (serial: string): Promise<IpcResult<boolean>> => invoke(IPC.phoneRecover, serial),
    setLabel: (id: number, label: string, country: string): Promise<IpcResult<void>> =>
      invoke(IPC.phoneSetLabel, id, label, country),
    assign: (accountId: number, phoneId: number | null): Promise<IpcResult<void>> =>
      invoke(IPC.phoneAssign, accountId, phoneId),
    remove: (id: number): Promise<IpcResult<void>> => invoke(IPC.phoneRemove, id),
    pair: (address: string, code: string): Promise<IpcResult<{ ok: boolean; message: string }>> =>
      invoke(IPC.phonePair, address, code),
    assigned: (accountId: number): Promise<IpcResult<number | null>> =>
      invoke(IPC.phoneAssigned, accountId),
    authEvents: (limit?: number): Promise<IpcResult<AuthEventDto[]>> =>
      invoke(IPC.phoneAuthEvents, limit),
    // 폰 연동 프로그램(adb·scrcpy) 설치 상태·원클릭 설치
    toolsStatus: (): Promise<IpcResult<PhoneToolsStatusDto>> => invoke(IPC.phoneToolsStatus),
    installTools: (): Promise<IpcResult<PhoneToolsStatusDto>> => invoke(IPC.phoneInstallTools),
    onInstallProgress: (cb: (dto: PhoneToolsProgressDto) => void): (() => void) => {
      const h = (_: unknown, dto: PhoneToolsProgressDto): void => cb(dto)
      ipcRenderer.on(IPC.phoneInstallProgress, h)
      return () => ipcRenderer.off(IPC.phoneInstallProgress, h)
    },
    // 목록·상태가 바뀔 때마다 온다. warning 은 연결 상한 초과 같은 안내 문구
    onUpdated: (cb: (list: PhoneDto[], warning?: string) => void): (() => void) => {
      const h = (_: unknown, dto: PhoneUpdatedDto): void => cb(dto.list, dto.warning)
      ipcRenderer.on(IPC.phoneUpdated, h)
      return () => ipcRenderer.off(IPC.phoneUpdated, h)
    },
    onAuthWaiting: (cb: (dto: PhoneAuthWaitingDto) => void): (() => void) => {
      const h = (_: unknown, dto: PhoneAuthWaitingDto): void => cb(dto)
      ipcRenderer.on(IPC.phoneAuthWaiting, h)
      return () => ipcRenderer.off(IPC.phoneAuthWaiting, h)
    },
    // mode 'still' 을 주면 동영상을 건너뛰고 간이 화면으로 연다(디코더가 못 푸는 폰)
    screenStart: (serial: string, mode?: 'still'): Promise<IpcResult<ScreenMode>> =>
      invoke(IPC.phoneScreenStart, serial, mode),
    // 사용자가 화면을 직접 눌렀을 때. 좌표는 0~1 비율
    tap: (serial: string, rx: number, ry: number): Promise<IpcResult<void>> =>
      invoke(IPC.phoneTap, serial, rx, ry),
    swipe: (
      serial: string,
      rx1: number,
      ry1: number,
      rx2: number,
      ry2: number,
      durationMs?: number
    ): Promise<IpcResult<void>> => invoke(IPC.phoneSwipe, serial, rx1, ry1, rx2, ry2, durationMs),
    key: (serial: string, keyName: string): Promise<IpcResult<void>> =>
      invoke(IPC.phoneKey, serial, keyName),
    screenStop: (serial: string): Promise<IpcResult<void>> => invoke(IPC.phoneScreenStop, serial),
    // scrcpy 큰 창으로 열기(앱 안 임베드와 별개다)
    openWindow: (serial: string): Promise<IpcResult<void>> => invoke(IPC.phoneOpenWindow, serial),
    onScreenChunk: (cb: (chunk: PhoneScreenChunkDto) => void): (() => void) => {
      const h = (_: unknown, chunk: PhoneScreenChunkDto): void => cb(chunk)
      ipcRenderer.on(IPC.phoneScreenChunk, h)
      return () => ipcRenderer.off(IPC.phoneScreenChunk, h)
    },
    onScreenMode: (cb: (dto: PhoneScreenModeDto) => void): (() => void) => {
      const h = (_: unknown, dto: PhoneScreenModeDto): void => cb(dto)
      ipcRenderer.on(IPC.phoneScreenMode, h)
      return () => ipcRenderer.off(IPC.phoneScreenMode, h)
    }
  },
  // 사진·영상 캡처 — 파일은 설정의 저장 폴더에만 쓰인다(경로를 렌더러가 고르지 못한다)
  capture: {
    // 직접 지정용 정지 이미지(웹뷰 1장) + 그 이미지가 덮는 렌더러 좌표
    still: (): Promise<IpcResult<CaptureStillDto>> => invoke(IPC.captureStill),
    // 영역 선택·전체 페이지·전체 화면. true 면 메인이 처리를 맡았다는 뜻
    run: (mode: CaptureMode): Promise<IpcResult<boolean>> => invoke(IPC.captureRun, mode),
    saveImage: (dataUrl: string): Promise<IpcResult<void>> => invoke(IPC.captureSaveImage, dataUrl),
    videoSource: (mode: CaptureMode): Promise<IpcResult<CaptureVideoSourceDto>> =>
      invoke(IPC.captureVideoSource, mode),
    // 녹화 1건을 가리키는 token 을 받아, 이어 쓰기·마무리·취소에 그대로 돌려준다
    beginVideo: (mode: CaptureMode): Promise<IpcResult<CaptureBeginVideoDto>> =>
      invoke(IPC.captureBeginVideo, mode),
    appendVideo: (token: string, bytes: Uint8Array): Promise<IpcResult<void>> =>
      invoke(IPC.captureAppendVideo, token, bytes),
    endVideo: (token: string, mode: CaptureMode): Promise<IpcResult<void>> =>
      invoke(IPC.captureEndVideo, token, mode),
    cancelVideo: (token: string): Promise<IpcResult<void>> => invoke(IPC.captureCancelVideo, token),
    copyImage: (filePath: string): Promise<IpcResult<void>> =>
      invoke(IPC.captureCopyImage, filePath),
    openFile: (filePath: string): Promise<IpcResult<void>> => invoke(IPC.captureOpenFile, filePath),
    // 경로를 주면 그 파일을 탐색기에서 고르고, 주지 않으면 저장 폴더를 연다
    openFolder: (filePath?: string): Promise<IpcResult<void>> =>
      invoke(IPC.captureOpenFolder, filePath ?? ''),
    // 저장 폴더 선택. 고르면 메인이 설정에 반영하고 그 경로를 돌려준다
    pickDir: (): Promise<IpcResult<string | null>> => invoke(IPC.capturePickDir),
    // 지금 쓰는 저장 폴더 경로(설정이 비어 있으면 기본 폴더)
    dir: (): Promise<IpcResult<string>> => invoke(IPC.captureDir),
    onShortcut: (cb: (mode: CaptureMode) => void): (() => void) => {
      const h = (_: unknown, dto: { mode: CaptureMode }): void => cb(dto.mode)
      ipcRenderer.on(IPC.captureShortcut, h)
      return () => ipcRenderer.off(IPC.captureShortcut, h)
    },
    onDone: (cb: (dto: CaptureResultDto) => void): (() => void) => {
      const h = (_: unknown, dto: CaptureResultDto): void => cb(dto)
      ipcRenderer.on(IPC.captureDone, h)
      return () => ipcRenderer.off(IPC.captureDone, h)
    }
  }
}

export type SambaApi = typeof api
contextBridge.exposeInMainWorld('samba', api)
