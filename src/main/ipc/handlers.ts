import { isSupabaseAnonKey, isSupabaseProjectUrl, type AuthState } from '../../shared/sync'
import type { SyncBackend } from '../sync/backend'
import {
  enableExtensionServiceWorkerSupport,
  pickActionIconPath,
  sendExtensionTabEvent,
  setExtensionActionListener,
  warmExtensionWorkers
} from '../extensions/cookies-bridge'
import { loadFallbackTokens } from '../agent/fallback-tokens'
import { applyProfileProxy, loadProfileProxies, profileOfPartition } from '../browser/profile-proxy'
import { ChatSessionStore } from '../agent/chat-session'
import {
  app,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  type BrowserWindow,
  type WebContents,
  type WebFrameMain
} from 'electron'
import { join } from 'node:path'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { profileNames } from '../../shared/profiles'
import { PHONE_SYNC_KEYS, PhoneRegistrySync } from '../phone/registry-sync'
import { declareKeymasterBaseline } from '../sync/authority'
import * as os from 'node:os'
import { IPC, type IpcResult, type Layout, type Settings } from '../../shared/ipc'
import { defaultTabUrl } from '../../shared/settings'
import type { TabManager } from '../browser/tab-manager'
import { ClosedTabStack, newProfileName, runGesture, type GestureDeps } from '../browser/gestures'
import { SettingsStore } from '../settings/store'
import { setOcrEnabled } from '../agent/tools-ocr'
import { AgentRunner } from '../agent/runner'
import { BridgeServer } from '../bridge/server'
import { applyBridgeSettings, newBridgeToken } from '../bridge/wiring'
import { createHarnessApi } from '../harness/wiring'
import { createAgentNotifier } from '../notify'
import type { NotifyChannel } from '../../shared/notify'
import type { Db } from '../db/client'
import { VaultService, type PutItemInput, type UpsertAccountInput } from '../vault/service'
import { exportVault, writeOwnerOnlyFile, type ExportRequest } from '../vault/export'
import { ImportService, type ImportDialogs } from '../import/service'
import { ChatRepo } from '../chat/repo'
import { PlaybookStore } from '../playbooks/store'
import { parseAgentImages } from '../../shared/agent-image'
import { fetchClaudeUsage } from '../ai/usage'
import { fetchCodexUsage } from '../ai/usage-codex'
import type { PlaybookInput } from '../../shared/playbook'
import { ScheduleRunStore } from '../schedule/runs'
import { PlaybookScheduler } from '../schedule/scheduler'
import { ActivityStore } from '../activity/store'
import { SiteMemoryStore } from '../agent/site-memory-store'
import { SiteScriptStore } from '../agent/site-scripts-store'
import { SiteMemoryService } from '../agent/site-memory'
import { ActivityRecorder } from '../activity/recorder'
import { RecommendService } from '../activity/recommend'
import { RECENT_CHAT_LIMIT, type AppendMessageInput } from '../../shared/chat'
import { VaultCaptureGate } from './vault-capture'
import { watchLoginOutcome } from './login-watch'
import { machineFilledRecently } from '../browser/human-activity'
import { addNeverSaveHost, autoSaveCapturedLogin, saveCapturedLogin } from '../vault/login-capture'
import {
  CAPTURE_DECISIONS,
  CAPTURE_TRACE_STAGES,
  maskUsername,
  type CaptureDecision
} from '../../shared/vault'
import { VaultPickerGate } from './vault-picker'
import { autofillAccount, type AutofillDeps } from '../vault/autofill'
import { assertFromRenderer, isFromRenderer, settingsForSender } from './sender'
import { normalizeHost } from '../../shared/host'
import { isAllowedExternalUrl, isInternalUrl } from '../../shared/url'
import { SyncEngineHolder } from '../sync/engine'
import { toolbarBookmarks } from '../bookmarks/newtab'
import type { NewTabInitDto } from '../../shared/newtab'
// === AI 연결(2b 추가분) ===============================================================
import {
  connectionKeyOf,
  isAiProviderId,
  isApiKeyVendor,
  isSubscriptionProviderId,
  isTaskModelKey
} from '../../shared/ai'
import type { AiProviderId, ApiKeyVendor, TaskModelKey } from '../../shared/ai'
import { ApiKeyStore } from '../ai/keys'
import {
  defaultProbes,
  detectProviders,
  readAccountFromDisk,
  SUBSCRIPTION_CLI,
  testApiKey
} from '../ai/providers'
import {
  connectSubscription,
  disconnectedRecord,
  openLoginTerminal,
  migrateAiConnections,
  withConnection
} from '../ai/connections'
import { resolveAgentAuth } from '../ai/auth-route'
import { remapOnProviderChange, resolveModel, taskModelChoices } from '../ai/models'
import {
  agentBackend,
  setApiKeyResolver,
  setAuthResolver,
  setSubscriptionFallbackTokens
} from '../agent/provider'
// === AI 연결 끝 =======================================================================
import { AuthService } from '../sync/auth'
import {
  hasDirectoryEnv,
  hasSupabaseEnv,
  readDirectoryEnv,
  setSupabaseEnvFromSettings
} from '../sync/env'
import { AccountService } from '../sync/account'
import { AccountWorkspaceStore, ensureAccountWorkspace } from '../sync/account-workspace'
import { createSessionStore } from '../sync/session-store'
import { createSupabaseBackend } from '../sync/supabase-backend'
import { SyncConnection } from '../sync/connect'
import { workspaceRemoteId } from '../sync/workspace-id'
import type { DeviceService } from '../sync/devices'
import { WorkspaceService } from '../workspace/service'
import { workspaceShortcutIndex } from '../workspace/shortcut'
import { ExtensionManager, createSessionExtensionHost } from '../extensions/manager'
import { readIconDataUrl } from '../extensions/import-sources'
import { createExtensionInstaller } from '../extensions/install-service'
import { extensionPopupUrl } from '../extensions/action'
import { ExtensionPopupHost, sessionWithExtension } from '../extensions/popup-view'
import { WEBSTORE_HOST, isExtensionId } from '../../shared/extensions'
import type { ExtensionActionResult, ExtensionAnchorDto } from '../../shared/extensions'
// === 폰 연동(3단계) — child_process 는 phone/process.ts 안에만 있다 ===================
import { createAdbRunner } from '../phone/process'
import { PhoneRepo } from '../phone/repo'
import { PhoneService } from '../phone/service'
import { registerPhoneScreenIpc } from '../phone/screen-ipc'
import { installPhoneTools, phoneToolsStatus } from '../phone/tools-install'
import { createPhoneOps } from '../agent/tools-phone'
import { readCodeFromImage, readKeypadLayout } from '../ai/visual'
import { OcrEngine } from '../ocr/engine'
import { createTabPagePort } from '../phone/tab-port'
import {
  AgentProgressRelay,
  createCodeReader,
  createKeypadReader,
  createPhoneAgentBridge,
  SecretScreenGate
} from '../phone/wiring'
// === 화면 번역 · 이미지 번역 — 배선은 translate/register.ts 한 곳에 모여 있다 ==========
import { registerTranslate } from '../translate/register'
// === 사진·영상 캡처 — 배선은 capture/capture-ipc.ts 한 곳에 모여 있다 =================
import { registerCaptureIpc } from '../capture/capture-ipc'
import { isAllowedCaptureDir } from '../capture/paths'
import type { CaptureShortcutInput } from '../../shared/capture'
import { tr } from '../i18n'

// 빌드가 넣어 주는 코드 판(커밋 짧은 해시·날짜, electron.vite.config.ts). 시험 환경에는 없다
declare const __APP_REV__: string | undefined
const APP_REV = typeof __APP_REV__ === 'string' ? __APP_REV__ : 'dev'

/**
 * 렌더러가 보낸 툴바 버튼 좌표를 숫자만 남긴 형태로 받는다.
 * 값이 빠지거나 숫자가 아니면 0 으로 본다 — 팝업은 그래도 창 왼쪽 위에 뜬다
 */
function toExtensionAnchor(raw: unknown): ExtensionAnchorDto {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    x: num(o.x),
    y: num(o.y),
    width: num(o.width),
    height: num(o.height),
    viewportWidth: num(o.viewportWidth),
    viewportHeight: num(o.viewportHeight)
  }
}

// 모든 핸들러는 {ok,data}|{ok:false,error}로 응답
function wrap<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then((data) => ({ ok: true as const, data }))
    .catch((e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e)
    }))
}

export function registerIpc(
  win: BrowserWindow,
  tabs: TabManager,
  db: Db
): {
  settings: SettingsStore
  agent: AgentRunner
  db: Db
  vault: VaultService
  auth: AuthService
  sync: SyncEngineHolder
} {
  const settings = new SettingsStore()
  // 동기화 엔진이 붙을 자리. 로그인 전에도 IPC 가 상태를 답할 수 있게 한다
  const sync = new SyncEngineHolder()
  // === 홈 버튼 / 설정 페이지 (신규 추가분) ===================================
  // newTabUrl(홈과 동일/빈 페이지) + homeUrl 을 조합해 tab-manager 가 쓸 최종
  // 기본 주소를 계산한다. tab-manager 는 이 enum 을 몰라도 되게 분리했다
  const applyBrowserDefaults = (s: Settings): void => {
    tabs.setDefaultUrl(defaultTabUrl(s))
    tabs.setSearchEngine(s.searchEngine)
    // 마우스 제스처 설정은 페이지 preload 가 궤적을 그릴지 판단하는 데 필요하다
    tabs.setGestureConfig({
      enabled: s.mouseGesturesEnabled,
      language: s.language,
      mapping: s.mouseGestures
    })
  }
  applyBrowserDefaults(settings.get())
  setOcrEnabled(settings.get().ocrEnabled)
  // === 신규 추가분 끝 =========================================================
  // 창이 이미 파괴됐는데 send 하면 예외가 난다. 모든 main→renderer 통지는 이 관문을 거친다
  const send = (channel: string, payload: unknown): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
  }
  // 금고. 마스터 키는 이 인스턴스 안에만 있고 IPC 로는 절대 나가지 않는다
  const vault = new VaultService(db, settings, { safeStorage })
  // AI 도구(list_accounts/fill_secret/login)가 쓸 수 있도록 금고를 넘긴다.
  // 메신저 알림·예약 실행 결과 판정은 에이전트 이벤트를 화면으로 보내는 같은 길목에서 엿본다
  // (작업 완료·실패, 확인 카드, 사람에게 넘김 — 폰 결제 비밀번호 키패드 포함)
  const notifier = createAgentNotifier({
    settings: () => settings.get(),
    fetchImpl: (url, init) => globalThis.fetch(url, init)
  })
  // 활동 기록. 파일은 이 PC 의 userData 안에만 있고 동기화 대상이 아니다.
  // 기록 여부는 설정 한 칸(activityRecording)으로 매번 다시 읽는다 — 끄면 곧바로 멈춘다
  const activityStore = new ActivityStore(join(app.getPath('userData'), 'activity'))
  activityStore.prune()
  const activity = new ActivityRecorder({
    store: activityStore,
    enabled: () => settings.get().activityRecording
  })
  const agent = new AgentRunner(
    tabs,
    settings,
    (ev) => {
      scheduler.noteAgentEvent(ev)
      activity.observeAgent(ev)
      send(IPC.agentEvent, ev)
      notifier.observe(ev)
    },
    vault
  )
  // 탭이 옮겨 가면 **호스트 한 조각**만 기록기로 넘어간다(전체 URL·검색어는 넘기지 않는다)
  tabs.onVisit((host) => activity.noteVisit(host))
  // AI 채팅 기록. 러너가 작업 완료 시점에 이 저장소로 대화를 남긴다
  const chats = new ChatRepo(db)
  agent.setTranscript((chatId, entry) => {
    chats.append({ chatId, role: 'user', content: entry.prompt })
    chats.append({ chatId, role: 'assistant', content: entry.text, steps: entry.steps })
  })
  // 자동화 플레이북. 사용자 문장에 트리거가 들어 있으면 러너가 절차를 시스템 프롬프트에 덧붙인다
  const playbooks = new PlaybookStore(settings)
  agent.setPlaybooks(() => playbooks.list())
  // AI 가 배운 절차를 플레이북에 덧붙일 수 있게 한다(저장 전 확인 카드는 도구가 띄운다)
  agent.setPlaybookEditor(playbooks)
  // 사이트 기억. 파일은 이 PC 의 userData 안에만 있고 동기화 대상이 아니다.
  // 켬/끔은 설정 한 칸(siteMemoryEnabled)으로 매번 다시 읽는다 — 끄면 곧바로 멈춘다
  const siteMemoryStore = new SiteMemoryStore(join(app.getPath('userData'), 'site-memory.json'))
  const siteMemory = new SiteMemoryService(siteMemoryStore, () => settings.get().siteMemoryEnabled)
  agent.setSiteMemory(siteMemory)
  // 한 번 통한 run_js 코드를 저장해 두고 재생한다(기기 로컬). 사이트 기억과 같은 스위치로 켜고 끈다
  agent.setSiteScripts(new SiteScriptStore(join(app.getPath('userData'), 'site-scripts.json')))
  // 하네스 브릿지 — 밖의 LangGraph 하네스가 이 앱의 도구를 부르는 문. 설정으로 켜고 끈다
  const bridge = new BridgeServer({
    openSession: (onStep, lane) => agent.createToolSession({ onStep, ...(lane ? { lane } : {}) }),
    token: () => settings.get().bridgeToken
  })
  const applyBridge = (): Promise<void> =>
    applyBridgeSettings(
      bridge,
      () => settings.get(),
      (patch) => void settings.set(patch)
    )
  void applyBridge()
  win.once('closed', () => void bridge.stop())
  handleFromRenderer(IPC.bridgeRegenerateToken, async () => {
    const token = newBridgeToken()
    settings.set({ bridgeToken: token })
    return { token }
  })
  // 하네스 읽기 API — 자동화 페이지가 5초마다 부른다. 바꾸는 것은 규칙 파일 하나뿐이다
  const harness = createHarnessApi(() => settings.get())
  handleFromRenderer(IPC.harnessGraph, () => harness.graph())
  handleFromRenderer(IPC.harnessJobs, () => harness.jobs())
  handleFromRenderer(IPC.harnessReleases, () => harness.releases())
  handleFromRenderer(IPC.harnessGetRules, (agent: string) => harness.getRules(agent))
  handleFromRenderer(IPC.harnessPutRules, (agent: string, text: string) =>
    harness.putRules(agent, text)
  )
  // 같은 대화의 다음 지시는 SDK 세션을 이어받아 앞선 지시·도구 결과를 기억한다(세션 연결은 이 PC 에만 남는다)
  agent.setChatSessions(
    new ChatSessionStore(join(app.getPath('userData'), 'chat-sessions.json')),
    (chatId) => chats.messages(chatId).map((m) => ({ role: m.role, content: m.content }))
  )
  // 예약 실행. 실행 기록은 이 PC 의 파일에만 남는다(동기화 대상이 아니다)
  const scheduleRuns = new ScheduleRunStore(join(app.getPath('userData'), 'schedule-runs.json'))
  const scheduler = new PlaybookScheduler({
    playbooks,
    runs: scheduleRuns,
    isRunning: () => agent.isRunning(),
    aiConnected: () => agentBackend() !== 'none',
    // 렌더러가 이 문구를 평소 채팅과 똑같이 보낸다 — 진행 상황이 AI 패널에 그대로 보인다
    dispatch: (req) => send(IPC.scheduleDispatch, req),
    onChanged: () => send(IPC.scheduleChanged, null)
  })
  scheduler.start()
  // 추천 — 기록 파일 + 숨김 설정 + 플레이북 목록을 잇기만 한다(판정은 순수 함수)
  const recommend = new RecommendService({
    runs: activityStore,
    settings,
    playbooks
  })
  // 페이지 JS 대화상자는 AI 작업이나 하네스(브릿지) 자동화가 도는 동안에만 자동 처리한다
  tabs.setAgentRunningProvider(() => agent.isRunning() || bridge.recentlyActive())
  // guard 모드에서 confirm/beforeunload 는 사용자 확인 카드를 거쳐야 '예' 가 된다
  tabs.setDialogPolicy({
    mode: () => settings.get().permissionMode,
    confirm: (message) => agent.requestConfirm(tr('ipc.pageConfirm', { message }), 'danger')
  })
  vault.onStateChanged((state) => send(IPC.vaultStateChanged, state))
  // 저장 제안 카드에는 host/username/isNew 만 간다(비밀번호는 메인에 남는다)
  vault.onCapturePrompt((prompt) => send(IPC.vaultCapturePrompt, prompt))

  // 가져오기(비밀번호 CSV·북마크 HTML). filePath 를 안 주면 다이얼로그를 연다
  const importDialogs: ImportDialogs = {
    showOpenDialog: async (filters) => {
      const result = await dialog.showOpenDialog(win, { filters, properties: ['openFile'] })
      if (result.canceled || result.filePaths.length === 0) return undefined
      return result.filePaths[0]
    }
  }
  const importService = new ImportService(db, vault, importDialogs)
  // === 북마크 관리자 페이지 (신규 추가분) — 내보내기용 저장 다이얼로그를 나중에 덧붙인다 ===
  // (importDialogs 리터럴 자체는 건드리지 않고, 참조가 같은 객체에 속성만 추가한다)
  importDialogs.showSaveDialog = async (filters, defaultPath) => {
    const result = await dialog.showSaveDialog(win, { filters, defaultPath })
    if (result.canceled || !result.filePath) return undefined
    return result.filePath
  }
  // === 북마크 관리자 페이지 끝 ===========================================================

  // --- 발신자 검증 ---------------------------------------------------------
  // 렌더러 창(메인 UI)에서 온 요청만 허용한다. 탭 안의 웹 페이지 preload 는 별도 게이트
  // (VaultCaptureGate·VaultPickerGate·newTabSender)를 가진 채널만 쓸 수 있다.
  // 판정 자체는 ipc/sender.ts 의 순수 함수에 있다
  /** 렌더러 전용 invoke 채널을 등록한다(발신자 검증 + {ok,data} 포장) */
  function handleFromRenderer<A extends unknown[], T>(
    channel: string,
    fn: (...args: A) => T | Promise<T>
  ): void {
    ipcMain.handle(channel, (e, ...args: unknown[]) =>
      wrap(() => {
        assertFromRenderer(win, e.sender)
        return fn(...(args as A))
      })
    )
  }

  /** 렌더러 전용 단방향(send) 채널을 등록한다. 다른 발신자의 메시지는 조용히 버린다 */
  function onFromRenderer<A extends unknown[]>(channel: string, fn: (...args: A) => void): void {
    ipcMain.on(channel, (e, ...args: unknown[]) => {
      if (!isFromRenderer(win, e.sender)) return
      fn(...(args as A))
    })
  }

  tabs.onChange((list) => send(IPC.tabUpdated, list))

  // 창이 닫히면 등록한 핸들러를 모두 걷어낸다(1단계는 단일 창)
  win.once('closed', () => {
    for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
    ipcMain.removeAllListeners(IPC.agentConfirmReply)
    ipcMain.removeAllListeners(IPC.vaultCaptureDecision)
    ipcMain.removeAllListeners(IPC.vaultCapture)
    ipcMain.removeAllListeners(IPC.vaultUndoPasswordUpdate)
    ipcMain.removeAllListeners(IPC.pageGesture)
    ipcMain.removeAllListeners(IPC.pageWebstoreInstall)
    scheduler.stop()
    // 열려 있던 방문 한 건을 마무리해 머문 시간이 통째로 사라지지 않게 한다
    activity.flush()
    sync.current()?.stop()
    sync.release()
    vault.dispose()
  })

  // 팝업(결제창·주소 검색창)까지 함께 돌려준다 — 사이드바가 "팝업" 배지로 보여 준다
  handleFromRenderer(IPC.tabList, () => tabs.listAll())
  handleFromRenderer(IPC.tabCreate, (o: { url?: string; profile?: string; mobile?: boolean }) =>
    // 화면에서 사람이 연 탭 — 바깥 자동화가 닫지 못하게 표시한다
    tabs.create({ ...o, user: true })
  )
  // 팝업 id 로도 닫기·전환이 되게 대상(탭+팝업) 경로로 보낸다
  handleFromRenderer(IPC.tabClose, (id: string) => tabs.closeTarget(id))
  handleFromRenderer(IPC.tabActivate, (id: string) => tabs.focusTarget(id))
  handleFromRenderer(IPC.tabNavigate, (id: string, url: string) => tabs.navigate(id, url))
  handleFromRenderer(IPC.tabBack, (id: string) => tabs.back(id))
  handleFromRenderer(IPC.tabForward, (id: string) => tabs.forward(id))
  handleFromRenderer(IPC.tabReload, (id: string) => tabs.reload(id))
  handleFromRenderer(IPC.tabSetMobile, (id: string, mobile: boolean) => tabs.setMobile(id, mobile))
  handleFromRenderer(IPC.tabMove, (id: string, toIndex: number) => tabs.move(id, toIndex))
  // 프로필 메뉴용 목록 — 이 작업공간에서 한 번이라도 쓴 프로필(세션 폴더)과 지금 열린 탭의 프로필
  handleFromRenderer(IPC.profileList, () => {
    const dirPrefix = workspace.partitionPrefix().replace(/^persist:/, '')
    let dirs: string[] = []
    try {
      dirs = readdirSync(join(app.getPath('userData'), 'Partitions'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      // 아직 프로필 탭을 연 적이 없으면 폴더가 없다
    }
    return profileNames(
      dirs,
      dirPrefix,
      tabs.listAll().map((t) => t.profile)
    )
  })
  handleFromRenderer(IPC.layoutSet, (l: Layout) => tabs.setLayout(l))

  // 실행 시작만 즉시 확인해 주고, 완료·실패는 status 이벤트로만 알린다.
  // (예전처럼 완료까지 기다리면 늦게 끝난 이전 작업의 응답이 새 작업 UI 를 덮어썼다)
  // scheduleToken 은 예약이 보낸 실행임을 잇는 표식이다. 모르는 토큰이면 평소대로 돈다
  handleFromRenderer(
    IPC.agentRun,
    (prompt: string, chatId?: number, scheduleToken?: string, rawImages?: unknown) => {
      // 붙여 넣은 이미지는 형식·크기·장수를 검증하고, 하나라도 어긋나면 실행하지 않는다
      const images = parseAgentImages(rawImages)
      if (images === null) throw new Error(tr('ipc.imagesInvalid'))
      // 알림 요약의 "작업:" 줄에 쓸 사용자 지시(비밀값 마스킹은 메시지 조립 때 한다)
      notifier.setPrompt(prompt)
      // 활동 기록도 같은 자리에서 지시를 받아 둔다(마스킹은 저장 직전에 한다)
      activity.notePrompt(prompt)
      const overrides = scheduler.claimOverrides(scheduleToken)
      void agent
        .run(prompt, chatId, overrides, images)
        .catch((e: unknown) => console.error('작업 실행 실패', e))
      return { started: true }
    }
  )

  // 설정 화면의 [테스트 보내기] — 지금 입력된 값으로 한 줄 보내 본다
  handleFromRenderer(IPC.notifyTest, (channel: NotifyChannel) => notifier.test(channel))

  // --- AI 채팅 기록 -------------------------------------------------------
  handleFromRenderer(IPC.chatList, (limit?: number) => chats.list(limit ?? RECENT_CHAT_LIMIT))
  handleFromRenderer(IPC.chatCreate, (title: string) => chats.create(title))
  handleFromRenderer(IPC.chatGet, (chatId: number) => chats.get(chatId))
  handleFromRenderer(IPC.chatAppend, (input: AppendMessageInput) => chats.append(input))
  handleFromRenderer(IPC.chatRename, (chatId: number, title: string) => chats.rename(chatId, title))
  handleFromRenderer(IPC.chatDelete, (chatId: number) => chats.remove(chatId))
  handleFromRenderer(IPC.agentStop, () => agent.stop())

  // --- 자동화 플레이북 — 절차 문서만 오간다(비밀값 없음) --------------------
  handleFromRenderer(IPC.playbookList, () => playbooks.list())
  handleFromRenderer(IPC.playbookPut, (input: PlaybookInput) => playbooks.put(input))
  handleFromRenderer(IPC.playbookDelete, (id: string) => playbooks.remove(id))
  handleFromRenderer(IPC.playbookRestore, (id: string) => playbooks.restore(id))

  // --- 예약 실행 — 상태 조회·지금 실행·일시정지/재개 ------------------------
  handleFromRenderer(IPC.scheduleStatus, () => scheduler.statusList())
  handleFromRenderer(IPC.scheduleRunNow, (playbookId: string) => scheduler.runNow(playbookId))
  handleFromRenderer(IPC.scheduleSetPaused, (playbookId: string, paused: boolean) =>
    scheduler.setPaused(playbookId, paused)
  )
  // --- 활동 기록·추천 — 기록은 이 PC 안에만 있고 화면으로는 후보만 나간다 ----
  // 사이트 기억 — 화면에는 호스트별 개수만 나간다(경로·메모 본문은 메인에 남는다).
  // 지우기는 이 길뿐이다 — AI 도구로는 지우지 못한다
  handleFromRenderer(IPC.siteMemoryList, () => siteMemory.summary())
  handleFromRenderer(IPC.siteMemoryForget, (host: string) => siteMemory.forget(host))
  handleFromRenderer(IPC.activityRecommend, () => recommend.list())
  handleFromRenderer(IPC.activityDismiss, (key: string) => recommend.dismiss(key))
  handleFromRenderer(IPC.activityApply, (key: string) => recommend.apply(key))
  handleFromRenderer(IPC.activityClear, () => {
    // 열려 있던 방문을 먼저 닫아 둔다. 그러지 않으면 지운 뒤에 그 방문이
    // 옛 시각 그대로 다시 쓰여 "지웠는데 남아 있다" 가 된다
    activity.flush()
    return activityStore.clear()
  })

  onFromRenderer(IPC.agentConfirmReply, (requestId: string, approved: boolean) =>
    agent.resolveConfirm(requestId, approved)
  )

  // 렌더러 창(메인 UI)에는 전체 설정을, 탭 안의 페이지 preload(언어 표기용)에는
  // language 하나만 돌려준다. 분기 로직 자체는 sender.ts 의 순수 함수(settingsForSender)에 있다
  ipcMain.handle(IPC.settingsGet, (e) =>
    wrap(() => settingsForSender(settings.get(), win, e.sender))
  )
  handleFromRenderer(IPC.settingsSet, async (patch: Partial<Settings>) => {
    // 저장 폴더는 렌더러가 임의 경로를 넣지 못한다 — 폴더 선택 다이얼로그(메인)로만 자유롭다
    if (
      typeof patch.captureDir === 'string' &&
      !isAllowedCaptureDir(patch.captureDir, app.getPath('home'))
    ) {
      throw new Error(tr('ipc.saveFolderOutsideHome'))
    }
    const s = settings.set(patch)
    // 브릿지 적용이 토큰을 새로 만들어 저장할 수 있다 — 끝난 뒤 다시 읽어 최신값을 돌려준다
    if ('bridgeEnabled' in patch || 'bridgePort' in patch) await applyBridge()
    // 홈 주소·새 탭 주소·검색엔진이 바뀌면 tab-manager 도 즉시 반영한다
    applyBrowserDefaults(s)
    setOcrEnabled(s.ocrEnabled)
    return settings.get()
  })

  // --- 금고 ---------------------------------------------------------------
  // 비밀값(평문)을 돌려주는 채널은 vault:reveal 하나뿐이다. 나머지는 전부 메타/상태만 보낸다.
  handleFromRenderer(IPC.vaultState, () => vault.state())
  handleFromRenderer(IPC.vaultKeyFromSync, () => vault.isKeyFromSync())
  handleFromRenderer(IPC.vaultSetup, (master: string) => vault.setup(master))
  handleFromRenderer(IPC.vaultUnlock, (master: string) => vault.unlock(master))
  handleFromRenderer(IPC.vaultLock, () => vault.lock())
  // 서버(계정) 마스터 키 재료와 이 PC 가 다를 때 — 계정 마스터로 모든 항목을 다시 잠근다
  handleFromRenderer(IPC.vaultRekeyToAccount, (master: string) =>
    vault.rekeyToRemote(String(master ?? ''))
  )
  // 복구 키 — 발급 응답만 평문을 돌려주고, 확인을 통과해야 감싼 키가 저장된다
  handleFromRenderer(IPC.vaultRecoveryCreate, () => vault.createRecoveryKey())
  handleFromRenderer(IPC.vaultRecoveryConfirm, (input: string) => vault.confirmRecoveryKey(input))
  handleFromRenderer(IPC.vaultRecoveryUnlock, (input: string) => vault.unlockWithRecoveryKey(input))
  handleFromRenderer(IPC.vaultSites, () => {
    vault.touch()
    return vault.listSites()
  })
  handleFromRenderer(IPC.vaultAccounts, (host?: string) => {
    vault.touch()
    return vault.listAccounts(host)
  })
  handleFromRenderer(IPC.vaultItems, (accountId: number | null) => {
    vault.touch()
    return vault.listItems(accountId ?? null)
  })
  handleFromRenderer(IPC.vaultPutItem, (input: PutItemInput) => vault.putItem(input))
  // 같은 사람의 두 계정이 같은 결제 비밀번호를 쓸 때. 사용자 화면에서만 부른다(AI 도구 아님)
  handleFromRenderer(IPC.vaultCopyPaymentItems, (from: unknown, to: unknown) => {
    if (!Number.isInteger(from) || !Number.isInteger(to))
      throw new Error(tr('vault.accountNotFound'))
    return vault.copyPaymentItems(from as number, to as number)
  })
  handleFromRenderer(IPC.vaultDeleteItem, (id: number) => vault.deleteItem(id))
  // 사용자가 '보기' 를 눌렀을 때만 호출된다(감사 로그 기록됨)
  handleFromRenderer(IPC.vaultReveal, (id: number, fieldKey?: string) => vault.reveal(id, fieldKey))
  handleFromRenderer(IPC.vaultDeleteAccounts, (ids: number[]) =>
    vault.deleteAccounts(Array.isArray(ids) ? ids : [])
  )
  handleFromRenderer(IPC.vaultUndoDelete, (token: string) => vault.undoDeleteAccounts(token))
  handleFromRenderer(IPC.vaultMergeDomain, (domain: string) =>
    vault.mergeDomainAccounts(String(domain ?? ''))
  )
  handleFromRenderer(IPC.vaultUpsertAccount, (dto: UpsertAccountInput) => vault.upsertAccount(dto))
  // 사용 기록(감사 로그). accountId 를 주면 그 계정 소유 항목만, 아니면 전체를 반환한다
  handleFromRenderer(IPC.vaultAudit, (accountId?: number, limit?: number) =>
    vault.listAudit(accountId, limit)
  )
  // 내보내기 — 평문은 사용자가 고른 파일에만 들어가고, 응답에는 개수·경로만 담긴다
  handleFromRenderer(IPC.vaultExport, (req: ExportRequest) =>
    exportVault(
      {
        vault,
        showSaveDialog: async (prompt) => {
          const result = await dialog.showSaveDialog(win, {
            defaultPath: prompt.defaultPath,
            filters: prompt.filters,
            message: prompt.message,
            nameFieldLabel: prompt.nameFieldLabel
          })
          if (result.canceled || !result.filePath) return undefined
          return result.filePath
        },
        // 평문이 담기는 파일이다 — 소유자만 읽을 수 있게 한다(0o600)
        writeFile: (filePath, content) => writeOwnerOnlyFile(filePath, content)
      },
      req
    )
  )
  // 페이지(preload 격리 월드)가 감지한 로그인 폼 제출.
  // 로그인 자격증명 자동 저장(크롬 '비밀번호 저장' 흐름).
  // 검증·레이트리밋·호스트 대조·기계 입력 제외는 전부 VaultCaptureGate 안에 있다(테스트 가능하도록 분리).
  // 통과한 제출은 그 탭의 로그인 성공을 지켜본 뒤에만 확인 바(렌더러)를 띄운다
  const captureGate = new VaultCaptureGate({
    vault,
    excludedHosts: () => settings.get().vaultExcludedHosts,
    neverSaveHosts: () => settings.get().vaultNeverSaveHosts,
    machineFilled: (senderKey) => machineFilledRecently(senderKey as WebContents),
    profileOf: (senderKey) => tabs.findByWebContents(senderKey as WebContents)?.profile,
    watchLogin: (senderKey, onSettled, subFrame) => {
      const wc = senderKey as WebContents
      watchLoginOutcome(wc, wc.getURL(), onSettled, subFrame as WebFrameMain | undefined)
    },
    // 호스트·단계·버린 이유만 남긴다(값·아이디 없음) — 바가 안 뜰 때 원인을 앱 로그로 찾는다
    log: (line) => console.log(line),
    autoSaveEnabled: () => settings.get().vaultAutoSaveLogins,
    autoSave: (capture) => {
      try {
        const { result, undoToken } = autoSaveCapturedLogin(vault, capture)
        if (result === 'same' || !undoToken) return false
        send(IPC.vaultPasswordUpdated, {
          host: capture.host,
          username: maskUsername(capture.username),
          undoToken,
          kind: result
        })
        return true
      } catch (e: unknown) {
        // 실패 사유만 남긴다 — 값은 절대 로그에 넣지 않는다
        console.error('자격정보 자동 저장 실패', e instanceof Error ? e.message : String(e))
        return 'error'
      }
    }
  })
  ipcMain.on(IPC.vaultCapture, (e, raw: unknown) => {
    const frame = e.senderFrame
    const isSubFrame = !!frame && frame.parent !== null
    captureGate.handle(
      e.sender,
      {
        trusted: tabs.hasWebContents(e.sender),
        frameUrl: frame?.url ?? '',
        topUrl: e.sender.isDestroyed() ? '' : e.sender.getURL(),
        ...(isSubFrame && frame ? { subFrame: frame } : {})
      },
      raw
    )
  })
  // 페이지(preload)의 감지 단계 기록 — 단계 이름만 받아 발신 프레임 호스트와 함께 로그에 남긴다.
  // 실제 탭이 보낸 것만, 정해진 단계 이름만, 탭당 30초에 10줄까지만(로그 도배 방지)
  const traceSentAt = new WeakMap<WebContents, number[]>()
  ipcMain.on(IPC.vaultCaptureTrace, (e, raw: unknown) => {
    if (!tabs.hasWebContents(e.sender)) return
    if (typeof raw !== 'string' || !(CAPTURE_TRACE_STAGES as readonly string[]).includes(raw))
      return
    const now = Date.now()
    const recent = (traceSentAt.get(e.sender) ?? []).filter((t) => now - t < 30_000)
    if (recent.length >= 10) return
    recent.push(now)
    traceSentAt.set(e.sender, recent)
    console.log(
      `[로그인 저장] ${normalizeHost(e.senderFrame?.url ?? '') || '(호스트 모름)'} 페이지 감지 단계: ${raw}`
    )
  })

  // 자동 갱신 되돌리기(60초 이내). 실패해도 조용히 무시한다(토큰 만료 등)
  onFromRenderer(IPC.vaultUndoPasswordUpdate, (token: string) => {
    try {
      vault.undoAutoPasswordUpdate(token)
    } catch (e: unknown) {
      console.error('비밀번호 되돌리기 실패', e instanceof Error ? e.message : String(e))
    }
  })

  // 자동 채움(사용자 조작) — 값은 메인 안에서만 오간다.
  // 상세 화면의 '자동 채우기' 버튼과 페이지 내 피커가 같은 경로를 쓴다
  const autofillDeps: AutofillDeps = {
    vault,
    activeTab: () => tabs.active(),
    excludedHosts: () => settings.get().vaultExcludedHosts,
    autoSubmit: () => settings.get().autofillAutoSubmit
  }
  handleFromRenderer(IPC.vaultAutofill, (accountId: number) =>
    autofillAccount(autofillDeps, accountId)
  )

  // 페이지 내 자동 채움 피커. 목록은 {id,label,username} 뿐이고, 값은 메인이 직접 채운다
  const pickerGate = new VaultPickerGate({
    vault,
    excludedHosts: () => settings.get().vaultExcludedHosts
  })
  ipcMain.handle(IPC.vaultPickerAccounts, (e, rawHost: unknown) => {
    const result = pickerGate.accounts(
      e.sender,
      { trusted: tabs.hasWebContents(e.sender), frameUrl: e.senderFrame?.url ?? '' },
      rawHost
    )
    return { outcome: result.outcome, accounts: result.accounts }
  })
  // 피커 채우기는 활성 탭이 아니라 "요청을 보낸 탭"에, 게이트가 검증한 호스트로만 채운다.
  // 결과는 호출한 페이지(격리 월드)로 돌려줘 실패를 조용히 삼키지 않는다
  ipcMain.handle(IPC.vaultPickerFill, async (e, raw: unknown) => {
    const result = pickerGate.fill(
      e.sender,
      { trusted: tabs.hasWebContents(e.sender), frameUrl: e.senderFrame?.url ?? '' },
      raw
    )
    if (result.outcome !== 'ok' || result.accountId === undefined || result.host === undefined) {
      return { outcome: result.outcome }
    }
    const tab = tabs.findByWebContents(e.sender)
    if (!tab) return { outcome: 'untrusted-sender' }
    try {
      const filled = await autofillAccount(autofillDeps, result.accountId, {
        tab,
        host: result.host
      })
      return { outcome: filled }
    } catch (err: unknown) {
      // 실패 사유만 남긴다 — 값은 절대 로그에 넣지 않는다
      console.error('피커 자동 채움 실패', err instanceof Error ? err.message : String(err))
      return { outcome: 'fill-failed' }
    }
  })

  // 확인 바의 답. 저장이 아니면 보관 중이던 비밀번호를 그냥 버린다.
  // 옛 렌더러(boolean)도 받는다 — true 는 저장, false 는 이번만 건너뛰기
  onFromRenderer(IPC.vaultCaptureDecision, (raw: unknown) => {
    const decision: CaptureDecision | null =
      raw === true
        ? 'save'
        : raw === false
          ? 'skip'
          : typeof raw === 'string' && (CAPTURE_DECISIONS as readonly string[]).includes(raw)
            ? (raw as CaptureDecision)
            : null
    if (!decision) return
    const capture = vault.takePendingCapture()
    if (!capture) return
    if (decision === 'never') {
      // 이 사이트(등록 도메인)는 다시 묻지 않는다. 자동 채움은 그대로 쓸 수 있다(제외 도메인과 다르다)
      settings.set({
        vaultNeverSaveHosts: addNeverSaveHost(settings.get().vaultNeverSaveHosts, capture.host)
      })
      return
    }
    if (decision !== 'save') return
    // 수락했는데 그 사이 금고가 잠겼다면(자동 잠금 등) 조용히 버리지 않고 제안을 다시 띄운다.
    // 사용자가 확인 바에서 잠금을 풀고 다시 저장할 수 있다
    if (vault.state() !== 'unlocked') {
      vault.setPendingCapture({ ...capture, locked: true })
      return
    }
    try {
      // 누른 시점에 다시 판정한다(같은 값이면 저장하지 않는다). 기존 계정의 라벨·기본 지정은 건드리지 않는다
      saveCapturedLogin(vault, capture)
    } catch (e: unknown) {
      // 실패 사유만 남긴다 — 값은 절대 로그에 넣지 않는다
      console.error('자격정보 저장 실패', e instanceof Error ? e.message : String(e))
    }
  })

  // --- 가져오기 -------------------------------------------------------------
  handleFromRenderer(IPC.importPasswords, (filePath?: string) =>
    importService.importPasswords(filePath)
  )
  handleFromRenderer(IPC.importBookmarks, (filePath?: string) =>
    importService.importBookmarks(filePath)
  )
  handleFromRenderer(IPC.bookmarksTree, () => importService.tree())
  handleFromRenderer(IPC.bookmarksRemove, (id: number) => importService.removeBookmark(id))

  // === 북마크 관리자 페이지 (신규 추가분 — 병합 편의를 위해 이 블록만 별도로 추가) =========
  handleFromRenderer(IPC.bookmarksCreateFolder, (o: { parentId: number | null; name: string }) =>
    importService.createBookmarkFolder(o.parentId, o.name)
  )
  handleFromRenderer(
    IPC.bookmarksCreateLink,
    (o: { folderId: number | null; title: string; url: string }) =>
      importService.createBookmarkLink(o.folderId, o.title, o.url)
  )
  handleFromRenderer(
    IPC.bookmarksRename,
    (o: { id: number; kind: 'folder' | 'link'; name: string }) =>
      importService.renameBookmark(o.id, o.kind, o.name)
  )
  handleFromRenderer(
    IPC.bookmarksMove,
    (o: { id: number; kind: 'folder' | 'link'; toFolderId: number | null }) =>
      importService.moveBookmark(o.id, o.kind, o.toFolderId)
  )
  handleFromRenderer(IPC.bookmarksRemoveFolder, (id: number) =>
    importService.removeBookmarkFolder(id)
  )
  handleFromRenderer(IPC.bookmarksSort, (o: { folderId: number | null; by: 'name' }) =>
    importService.sortBookmarkFolder(o.folderId)
  )
  handleFromRenderer(IPC.bookmarksExport, () => importService.exportBookmarks())
  // === 북마크 관리자 페이지 끝 ===========================================================

  // === 자체 새 탭 페이지(samba://newtab) ================================================
  // 발신자는 반드시 관리 중인 탭이면서 내부 페이지여야 한다(웹 페이지의 위조 호출 차단)
  const newTabSender = (sender: WebContents): { tabId: string } | null => {
    const tab = tabs.findByWebContents(sender)
    if (!tab) return null
    if (!isInternalUrl(sender.getURL())) return null
    return { tabId: tab.id }
  }

  ipcMain.handle(IPC.newTabInit, (e): NewTabInitDto => {
    if (!newTabSender(e.sender)) return { language: settings.get().language, bookmarks: [] }
    return {
      language: settings.get().language,
      bookmarks: toolbarBookmarks(importService.tree())
    }
  })

  ipcMain.on(IPC.newTabSearch, (e, input: unknown) => {
    const from = newTabSender(e.sender)
    if (!from || typeof input !== 'string' || !input.trim()) return
    // 검색어 → URL 변환과 허용 판정은 주소창과 완전히 같은 경로를 쓴다
    void tabs.navigate(from.tabId, input).catch((err: unknown) => {
      console.warn('새 탭 검색 실패', err instanceof Error ? err.message : String(err))
    })
  })

  ipcMain.on(IPC.newTabOpen, (e, url: unknown) => {
    const from = newTabSender(e.sender)
    if (!from || typeof url !== 'string' || !isAllowedExternalUrl(url)) return
    void tabs.navigate(from.tabId, url).catch((err: unknown) => {
      console.warn('새 탭 북마크 열기 실패', err instanceof Error ? err.message : String(err))
    })
  })
  // === 자체 새 탭 페이지 끝 =============================================================

  // === 마우스 제스처 ====================================================================
  // 닫은 탭 다시 열기용 스택(최대 10). 탭이 닫힐 때마다 주소를 쌓아 둔다
  const closedTabs = new ClosedTabStack()
  tabs.onTabClosed((closed) => closedTabs.push(closed))

  const gestureDeps: GestureDeps = {
    activeTabId: () => tabs.active()?.id ?? null,
    back: (id) => tabs.back(id),
    forward: (id) => tabs.forward(id),
    reload: (id) => tabs.reload(id),
    navigate: (id, url) => tabs.navigate(id, url),
    scrollTo: (id, to) => tabs.scrollTo(id, to),
    homeUrl: () => settings.get().homeUrl,
    newTab: () => {
      tabs.create({ user: true })
    },
    // 이 앱은 단일 창이라 '새 창 열기' 는 새 탭으로 대체한다(설정 라벨에도 그렇게 적혀 있다)
    newWindow: () => {
      tabs.create({ user: true })
    },
    // 시크릿창 대체 — 세션이 분리된 새 프로필 탭
    newProfileTab: () => {
      tabs.create({ profile: newProfileName(Date.now()), user: true })
    },
    closeTab: (id) => tabs.close(id),
    reopenTab: () => {
      const last = closedTabs.pop()
      if (last)
        tabs.create({ url: last.url, profile: last.profile, mobile: last.mobile, user: true })
    },
    toggleFullScreen: () => {
      if (!win.isDestroyed()) win.setFullScreen(!win.isFullScreen())
    },
    maximize: () => {
      if (win.isDestroyed()) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    },
    minimize: () => {
      if (!win.isDestroyed()) win.minimize()
    }
  }

  // 발신자는 반드시 관리 중인 탭이어야 한다(웹 페이지·확장의 위조 호출 차단)
  ipcMain.on(IPC.pageGesture, (e, raw: unknown) => {
    const tab = tabs.findByWebContents(e.sender)
    if (!tab) return
    // 방향 4글자(L/R/U/D)를 넘는 값은 인식기가 만들 수 없다 — 들어오면 버린다
    if (typeof raw !== 'string' || !/^[LRUD]{1,4}$/.test(raw)) return
    const s = settings.get()
    if (!s.mouseGesturesEnabled) return
    // 제스처가 일어난 그 탭을 대상으로 실행한다(활성 탭 추정에 기대지 않는다)
    void runGesture(raw, s.mouseGestures, {
      ...gestureDeps,
      activeTabId: () => tab.id
    }).catch((err: unknown) => {
      console.warn('마우스 제스처 실행 실패', err instanceof Error ? err.message : String(err))
    })
  })
  // === 마우스 제스처 끝 =================================================================

  // === AI 연결(2b 추가분 — 병합 편의를 위해 이 블록만 별도로 추가) ======================
  // 평문 API 키는 이 저장소와 agent/provider.ts 안에만 머문다. 렌더러로 나가는 것은
  // 마스킹 문자열(sk-ant-••••1234)과 boolean 뿐이다
  const apiKeys = new ApiKeyStore(join(app.getPath('userData'), 'ai-keys.bin'), safeStorage)
  const aiProbes = defaultProbes()
  // ApiKeyStore.get 의 유일한 소비자(agent/provider.ts)에 조회기를 심는다.
  // 실제로 키를 꺼낼지는 provider.ts 가 인증 경로('api_key')를 보고 정한다
  setApiKeyResolver(() => apiKeys.get('anthropic'))
  // 이번 실행에 쓸 인증 경로. **연결한 적 없는 구독은 자격 파일이 있어도 쓰지 않는다**
  setAuthResolver(() => {
    const s = settings.get()
    return resolveAgentAuth({
      provider: s.aiProvider as AiProviderId,
      connections: s.aiConnections,
      // 평문 키는 여기까지 오지 않는다 — 마스킹 결과로 존재 여부만 본다
      hasApiKey: Boolean(apiKeys.masked().anthropic)
    })
  })
  // 구독 예비 계정 토큰(하네스와 공유). 등록·삭제가 재시작 없이 반영되게 부를 때마다 읽는다
  setSubscriptionFallbackTokens(() => loadFallbackTokens([process.cwd(), app.getAppPath()]))
  win.once('closed', () => {
    setApiKeyResolver(null)
    setAuthResolver(null)
    setSubscriptionFallbackTokens(null)
  })

  // 첫 실행 1회 승계: 이미 Claude 구독으로 쓰고 있던 기존 사용자는 연결됨으로 올려 준다
  {
    const s = settings.get()
    const patch = migrateAiConnections({
      migrated: s.aiConnectionsMigrated,
      aiProvider: s.aiProvider,
      connections: s.aiConnections,
      hasClaudeCredential: SUBSCRIPTION_CLI.claude_subscription.credentialPaths.some((p) =>
        aiProbes.fileExists(p)
      ),
      account: readAccountFromDisk('claude_subscription') ?? undefined
    })
    if (patch) {
      const inherited = patch.aiConnections.claude.connected && !s.aiConnections.claude.connected
      settings.set(patch)
      if (inherited) {
        console.info('[AI] 기존 Claude 구독 사용 상태를 연결됨으로 1회 승계했습니다')
      }
    }
  }

  handleFromRenderer(IPC.aiProviders, () =>
    detectProviders(aiProbes, apiKeys.masked(), settings.get().aiConnections)
  )
  // 연결: 자격이 있으면 연결 기록을 남기고, 없으면 이유만 돌려준다(화면이 안내를 띄운다)
  handleFromRenderer(IPC.aiConnect, async (raw: unknown, rawOpenTerminal: unknown) => {
    if (!isSubscriptionProviderId(raw)) throw new Error(tr('ipc.unknownSubscriptionProvider'))
    if (rawOpenTerminal === true) {
      // 새 터미널 창에서 로그인 명령을 띄운다(자격은 그 창에서 사용자가 직접 만든다)
      openLoginTerminal(raw)
      return { ok: false, reason: 'needs_login' }
    }
    const result = await connectSubscription(raw, aiProbes)
    if (result.ok && result.connection) {
      settings.set({
        aiConnections: withConnection(settings.get().aiConnections, raw, result.connection)
      })
    }
    return result
  })
  // 해지: 진행 중 작업이 없을 때만. 앱의 연결 기록만 지우고 CLI 로그인 파일은 두 손 대지 않는다
  handleFromRenderer(IPC.aiDisconnect, (raw: unknown) => {
    if (!isSubscriptionProviderId(raw)) throw new Error(tr('ipc.unknownSubscriptionProvider'))
    if (agent.isRunning()) throw new Error(tr('ipc.disconnectWhileRunning'))
    const next = withConnection(settings.get().aiConnections, raw, disconnectedRecord())
    settings.set({ aiConnections: next })
    return { ok: true, connection: next[connectionKeyOf(raw)] }
  })
  // 계정 바꾸기: 앱의 연결 기록을 지우고, 새 터미널에서 'claude auth logout & claude auth login' 을 띄운다.
  // 로그인은 그 창에서 사용자가 직접 한다 — 끝나면 카드의 [연결]로 다시 붙인다
  handleFromRenderer(IPC.aiSwitchAccount, (raw: unknown) => {
    if (!isSubscriptionProviderId(raw)) throw new Error(tr('ipc.unknownSubscriptionProvider'))
    if (agent.isRunning()) throw new Error(tr('ipc.disconnectWhileRunning'))
    settings.set({
      aiConnections: withConnection(settings.get().aiConnections, raw, disconnectedRecord())
    })
    return { opened: openLoginTerminal(raw) }
  })
  // 사용량: 구독 경로별(Claude · Codex). 조회가 안 되면 null(화면은 줄을 숨긴다)
  handleFromRenderer(IPC.aiUsage, (raw: unknown) =>
    raw === 'codex_subscription' ? fetchCodexUsage() : fetchClaudeUsage()
  )
  handleFromRenderer(IPC.aiSetProvider, (raw: unknown) => {
    if (!isAiProviderId(raw)) throw new Error(tr('ipc.unknownAiProvider'))
    const before = settings.get()
    const { models, changed } = remapOnProviderChange(
      before.taskModels,
      before.aiProvider as AiProviderId,
      raw
    )
    const after = settings.set({ aiProvider: raw, taskModels: models })
    return { provider: after.aiProvider, taskModels: after.taskModels, changed }
  })
  // 평문 키는 렌더러 → 메인 한 방향으로만 흐른다. 응답은 마스킹뿐이다
  handleFromRenderer(IPC.aiSetApiKey, (rawVendor: unknown, rawKey: unknown) => {
    if (!isApiKeyVendor(rawVendor)) throw new Error(tr('ipc.unknownApiKeyVendor'))
    const key = typeof rawKey === 'string' ? rawKey : ''
    if (key.trim()) apiKeys.set(rawVendor as ApiKeyVendor, key)
    else apiKeys.remove(rawVendor as ApiKeyVendor)
    return apiKeys.masked()
  })
  // 확인은 모델 목록 1회 호출. 응답 본문은 읽지도 로그에 남기지도 않는다
  handleFromRenderer(IPC.aiTestKey, async (rawVendor: unknown, rawKey: unknown) => {
    if (!isApiKeyVendor(rawVendor)) throw new Error(tr('ipc.unknownApiKeyVendor'))
    const key = typeof rawKey === 'string' ? rawKey : ''
    return testApiKey(rawVendor as ApiKeyVendor, key)
  })
  handleFromRenderer(IPC.aiTaskModels, () => {
    const s = settings.get()
    return {
      provider: s.aiProvider,
      taskModels: s.taskModels,
      choices: taskModelChoices(s.aiProvider as AiProviderId)
    }
  })
  handleFromRenderer(IPC.aiSetTaskModel, (rawKey: unknown, rawModel: unknown) => {
    if (!isTaskModelKey(rawKey)) throw new Error(tr('ipc.unknownTaskModel'))
    if (typeof rawModel !== 'string' || !rawModel.trim()) throw new Error(tr('ipc.emptyModelName'))
    const key = rawKey as TaskModelKey
    const next = { ...settings.get().taskModels, [key]: rawModel.trim() }
    return settings.set({ taskModels: next }).taskModels
  })
  // === AI 연결 끝 =======================================================================

  // === 계정 인증(2b) ===================================================================
  // 접속 정보가 없으면 백엔드를 아예 만들지 않는다(설정 전에도 앱은 로컬 전용으로 그대로 돈다).
  // 값의 출처는 설정 → 계정에서 붙여넣은 값이 먼저고, 없으면 .env 다.
  // 설정을 바꾼 뒤에는 앱을 다시 시작해야 반영된다(백엔드를 시작 시 한 번만 만든다).
  // refresh token 은 safeStorage 로 감싼 파일에만 남고 렌더러로는 나가지 않는다
  {
    const s = settings.get()
    setSupabaseEnvFromSettings(s.syncSupabaseUrl, s.syncSupabaseAnonKey)
  }
  const syncConfigured = hasSupabaseEnv()
  const sessionStore = createSessionStore(
    join(app.getPath('userData'), 'sync-session.bin'),
    safeStorage
  )
  const syncBackend = syncConfigured ? createSupabaseBackend(sessionStore) : null
  const auth = new AuthService({
    backend: syncBackend,
    configured: syncConfigured,
    openExternal: (url) => shell.openExternal(url)
  })
  // 계정 디렉터리(중앙 로그인). 빌드에 주소가 있으면 "로그인 먼저 → 설정은 계정에 따라옴"으로 돈다.
  // 디렉터리 세션은 데이터 세션과 다른 파일에 둔다(프로젝트가 다르다)
  const directoryConfigured = hasDirectoryEnv()
  const directoryBackend = directoryConfigured
    ? createSupabaseBackend(
        createSessionStore(join(app.getPath('userData'), 'directory-session.bin'), safeStorage),
        readDirectoryEnv()
      )
    : null
  const directoryAuth = directoryBackend
    ? new AuthService({
        backend: directoryBackend,
        configured: true,
        openExternal: (url) => shell.openExternal(url)
      })
    : null
  // 동기화 연결부는 아래에서 만들어진다 — 데이터 백엔드가 바뀌면 여기로 알린다
  let onDataBackend: (backend: SyncBackend | null) => void = () => {}
  const account = new AccountService({
    directory: directoryBackend,
    directoryAuth,
    auth,
    createDataBackend: (config) => createSupabaseBackend(sessionStore, config),
    onDataBackend: (backend) => onDataBackend(backend),
    settings: {
      get: () => settings.get(),
      set: (patch) => void settings.set(patch)
    },
    applyEnv: setSupabaseEnvFromSettings,
    directoryUrl: directoryConfigured ? readDirectoryEnv().url : undefined,
    // 계정 비밀번호가 곧 키마스터 열쇠 — 로그인되면 이 PC 금고를 그 비밀번호에 맞춘다
    vault: { adoptAccountPassword: (password) => vault.adoptAccountPassword(password) }
  })
  // 렌더러에는 데이터 인증 상태 + 디렉터리 상태를 한 덩어리로 보낸다(토큰·비밀번호 없음)
  // 계정 로그인 전(게이트)에는 이 PC 에 남은 데이터 세션의 이메일을 화면에 내보내지 않는다 —
  // 자리를 비운 사이 다른 사람이 누구 계정인지 알 수 없어야 한다
  const authStateWithAccount = (): AuthState => {
    const acct = account.accountState()
    const data = auth.state()
    const gated = acct.configured && !acct.signedIn
    return { ...data, ...(gated ? { email: undefined } : {}), account: acct }
  }
  auth.onStateChanged(() => send(IPC.authStateChanged, authStateWithAccount()))
  account.onStateChanged(() => send(IPC.authStateChanged, authStateWithAccount()))
  // 구글 로그인을 기다리는 중에 창이 닫히면 루프백 서버가 최대 5분 남는다
  win.once('closed', () => {
    auth.dispose()
    directoryAuth?.dispose()
  })

  handleFromRenderer(IPC.authState, () => authStateWithAccount())
  // 실패 사유를 한 줄 남긴다(Supabase 오류 문구뿐 — 이메일·비밀번호·토큰은 넣지 않는다)
  const logged = async (step: string, fn: () => Promise<unknown>): Promise<AuthState> => {
    try {
      await fn()
    } catch (e: unknown) {
      console.warn(`계정 ${step} 실패`, e instanceof Error ? e.message : String(e))
      throw e
    }
    return authStateWithAccount()
  }
  handleFromRenderer(IPC.authSignUp, (email: string, password: string) =>
    logged('가입', () => account.signUp(email, password))
  )
  handleFromRenderer(IPC.authSignIn, (email: string, password: string) =>
    logged('로그인', () => account.signIn(email, password))
  )
  // 브라우저에서 구글 로그인을 마칠 때까지(최대 5분) 응답이 늦게 온다
  handleFromRenderer(IPC.authSignInGoogle, () =>
    logged('구글 로그인', () => account.signInGoogle())
  )
  handleFromRenderer(IPC.authSignOut, async () => {
    await account.signOut()
    // 로그아웃 = 자리를 비우는 것. 금고는 곧바로 잠근다(다음 사람이 열어 보지 못하게)
    vault.lock()
    return authStateWithAccount()
  })
  // 로그인한 계정에 데이터 Supabase 주소를 저장하고 곧바로 붙는다(재시작 불필요)
  handleFromRenderer(IPC.authResetPassword, (email: string, password: string) =>
    logged('비밀번호 재설정', () =>
      account.resetPasswordWithSession(String(email ?? ''), String(password ?? ''))
    )
  )
  handleFromRenderer(IPC.authSaveSupabase, (raw: unknown) => {
    const o = raw as { url?: unknown; anonKey?: unknown }
    const url = typeof o?.url === 'string' ? o.url.trim() : ''
    const anonKey = typeof o?.anonKey === 'string' ? o.anonKey.trim() : ''
    if (!isSupabaseProjectUrl(url)) throw new Error(tr('auth.badSupabaseUrl'))
    if (!isSupabaseAnonKey(anonKey)) throw new Error(tr('auth.badSupabaseKey'))
    return logged('Supabase 주소 저장', () => account.saveSupabase({ url, anonKey }))
  })
  // === 계정 인증 끝 ====================================================================

  // === 작업공간(브라우저 프로필) — 이 블록만 따로 추가한다 =============================
  const workspace = new WorkspaceService(db, settings)
  // 첫 실행이면 '기본' 작업공간을 만들고, 저장소·탭 파티션을 현재 작업공간에 맞춘다
  const applyWorkspace = (notify: boolean): void => {
    const current = workspace.ensureDefault()
    const scope = workspace.scope()
    vault.setWorkspaceScope(scope)
    importService.setWorkspaceScope(scope)
    chats.setWorkspaceScope(scope)
    // 열려 있는 탭의 세션은 그대로 두고, 새로 여는 탭부터 새 파티션을 쓴다
    tabs.setPartitionPrefix(workspace.partitionPrefix())
    if (notify) send(IPC.workspaceChanged, current)
  }
  applyWorkspace(false)
  workspace.onChanged(() => applyWorkspace(true))
  // 계정별 로컬 공간: 계정이 로그인하면 그 계정의 작업공간으로 전환한다(첫 계정은 기존 공간을 물려받는다).
  // 로그인 전에는 탭 뷰를 숨겨 로그인 화면만 보인다(북마크·대화는 렌더러 게이트가 가린다)
  const accountWorkspaces = new AccountWorkspaceStore(
    join(app.getPath('userData'), 'account-workspaces.json')
  )
  const applyAccountGate = (state: {
    configured: boolean
    signedIn: boolean
    userId?: string
    email?: string
  }): void => {
    if (!state.configured) return
    tabs.setGateHidden(!state.signedIn)
    if (state.signedIn && state.userId) {
      try {
        ensureAccountWorkspace(workspace, accountWorkspaces, state.userId, state.email ?? '')
      } catch (e: unknown) {
        console.error('계정 작업공간 전환 실패', e instanceof Error ? e.message : String(e))
      }
      // 로그인하면 키마스터도 연다 — 이 PC 에 기억해 둔 기기 키가 있으면 마스터 입력 없이(없으면 잠긴 채)
      void vault.ensureUnlockedByDevice()
    }
  }
  account.onStateChanged(applyAccountGate)
  applyAccountGate(account.accountState())

  // Ctrl+Alt+1~9 — 전역 단축키가 아니라 이 창(렌더러 UI + 탭 페이지)에서만 듣는다
  const handleWorkspaceShortcut = (input: {
    type: string
    key: string
    control: boolean
    alt: boolean
    shift: boolean
    meta: boolean
  }): boolean => {
    const index = workspaceShortcutIndex(input)
    if (index === null) return false
    try {
      return workspace.switchToIndex(index) !== null
    } catch (e) {
      console.error('작업공간 전환 실패', e)
      return false
    }
  }
  // 캡처 단축키(Alt+1~6)도 같은 창 안 입력 경로를 쓴다. 캡처 배선은 아래에서 붙는다
  let handleCaptureShortcut: (input: CaptureShortcutInput) => boolean = () => false
  const handleWindowShortcut = (input: CaptureShortcutInput): boolean =>
    handleWorkspaceShortcut(input) || handleCaptureShortcut(input)
  win.webContents.on('before-input-event', (e, input) => {
    if (handleWindowShortcut(input)) e.preventDefault()
  })
  tabs.setInputHandler(handleWindowShortcut)

  handleFromRenderer(IPC.workspaceList, () => workspace.list())
  handleFromRenderer(IPC.workspaceCreate, (o: { name: string; color?: string }) =>
    workspace.create(o.name, o.color)
  )
  handleFromRenderer(IPC.workspaceSwitch, (id: number) => workspace.switchTo(id))
  handleFromRenderer(IPC.workspaceRename, (o: { id: number; name: string }) =>
    workspace.rename(o.id, o.name)
  )
  handleFromRenderer(IPC.workspaceDelete, (id: number) => workspace.remove(id))
  // === 작업공간 끝 =====================================================================

  // === 동기화(2b) ======================================================================
  // 엔진은 로그인 이후에 만들어져 holder 에 붙는다. 붙기 전에는 오프라인 상태를 답한다
  handleFromRenderer(IPC.syncStatus, () => sync.status())
  sync.onStatusChanged((status) => send(IPC.syncStatusChanged, status))
  // 로그인하면 이 PC 를 기기 목록에 올리고, 저장소에 변경 로그 훅을 붙인 뒤 엔진을 돌린다.
  // 로그아웃·토큰 만료·기기 원격 로그아웃은 모두 같은 정리 경로(엔진 정지·훅 해제·금고 잠금)를 탄다
  const connection = new SyncConnection({
    db,
    backend: syncBackend,
    auth,
    holder: sync,
    vault,
    settings,
    bookmarks: importService,
    chats,
    // 주기마다 다시 불린다 — 작업공간을 바꿔도 다음 주기부터 새 uuid 로 올라간다.
    // 기본 작업공간만 기기 간 공유 대상이라 고정 uuid 를 쓴다(2b 범위)
    workspace: () => {
      const scope = workspace.scope()
      // 계정 작업공간은 그 계정의 "기본" 공간이다 — 모든 PC 에서 같은 고정 uuid 를 써야 서로 내려받는다
      return {
        localId: scope.id,
        remoteId: workspaceRemoteId(
          db,
          scope.id,
          scope.isDefault || accountWorkspaces.isAccountWorkspace(scope.id)
        )
      }
    },
    device: {
      hostname: () => os.hostname(),
      osLabel: () => `${os.type()} ${os.release()}`,
      appVersion: () => `${app.getVersion()}+${APP_REV}`
    },
    // 서버 키 재료가 다르면 계정 비밀번호로 자동으로 맞춘다(사용자 개입 없음)
    onVaultKeyMismatch: () => void account.onVaultKeyMismatch()
  })
  onDataBackend = (backend) => connection.setBackend(backend)
  // 수동 동기화는 연결을 거친다 — 최초 업로드가 놓친 행을 먼저 보충하고 한 주기를 돈다
  handleFromRenderer(IPC.syncNow, () => connection.syncNow())
  // 이 PC 의 키마스터를 기준으로 선언한다(sync/authority.ts). 실행했으면 곧바로 한 주기 돌려 올린다
  handleFromRenderer(IPC.syncKeymasterBaseline, async (dryRun: boolean) => {
    if (!syncBackend || !auth.state().signedIn) throw new Error(tr('ipc.loginRequired'))
    if (vault.state() !== 'unlocked') throw new Error(tr('vault.locked'))
    const scope = workspace.scope()
    const report = await declareKeymasterBaseline(
      {
        db,
        backend: syncBackend,
        workspace: {
          localId: scope.id,
          remoteId: workspaceRemoteId(
            db,
            scope.id,
            scope.isDefault || accountWorkspaces.isAccountWorkspace(scope.id)
          )
        },
        settings,
        // 서버에만 있던 행은 지우기 전에 앱 데이터 폴더에 남긴다(암호문 그대로 — 되돌릴 때 쓴다)
        backup: (table, rows, at) => {
          const dir = join(app.getPath('userData'), 'keymaster-baseline-backup')
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, `${at}-${table}.json`), JSON.stringify(rows))
        }
      },
      { dryRun: dryRun !== false }
    )
    if (!report.dryRun) await connection.syncNow()
    return report
  })
  // 저장된 세션이 있으면 조용히 되살린다(디렉터리 → 주소 내려받기 → 데이터 세션). 실패는 로그아웃으로 본다.
  // 연결부가 만들어진 뒤에 돌려야 새 백엔드 교체가 연결부까지 닿는다
  void account.restore().then(() => connection.refresh())
  win.once('closed', () => connection.dispose())

  const requireDevices = (): DeviceService => {
    const devices = connection.devices()
    if (!devices) throw new Error(tr('ipc.loginRequired'))
    return devices
  }
  handleFromRenderer(IPC.devicesList, () => requireDevices().list())
  handleFromRenderer(IPC.devicesRevoke, (deviceId: string) => requireDevices().revoke(deviceId))
  // === 동기화 끝 =======================================================================

  // === 확장(압축 해제된 크롬 확장 폴더) — 이 블록만 따로 추가한다 ======================
  // 기본 세션에 걸고, 작업공간 파티션 세션이 새로 생기면 같은 확장을 그 세션에도 건다.
  // 로드 실패는 항목별 오류 문자열로만 남고 앱을 멈추지 않는다
  // 확장 서비스워커에 없는 chrome.cookies 보충을 확장 로드보다 먼저 건다(기본 세션)
  enableExtensionServiceWorkerSupport(
    session.defaultSession,
    join(__dirname, '../preload/extension-sw.js')
  )
  const extensions = new ExtensionManager(
    createSessionExtensionHost(session.defaultSession),
    settings
  )
  void extensions
    .loadSaved()
    .then(() => warmExtensionWorkers(session.defaultSession))
    .catch((e: unknown) => console.error('저장된 확장 로드 실패', e))
  // 확장이 툴바 아이콘을 바꾸면(샵백 활성화 → 초록) 목록의 아이콘을 바꾸고 렌더러가 다시 그리게 한다
  setExtensionActionListener((id, op, details) => {
    if (op !== 'setIcon') return
    const entry = extensions.find(id)
    const rel = pickActionIconPath((details as { path?: unknown } | null)?.path)
    if (!entry || !rel) return
    const dataUrl = readIconDataUrl(entry.path, rel)
    if (dataUrl && extensions.setActionIcon(id, dataUrl)) send(IPC.extChanged, null)
  })
  // 프로필별 프록시(userData/profile-proxies.json · SAMBA_PROFILE_PROXY_<프로필>) — 스니커덩크처럼 사무실 IP 를
  // 막는 사이트는 전용 프로필에만 프록시를 건다(사용자 2026-09-28)
  const profileProxies = loadProfileProxies(app.getPath('userData'))
  tabs.setSessionHook((ses, partition) => {
    applyProfileProxy(
      ses,
      profileOfPartition(partition, workspace.partitionPrefix()),
      profileProxies
    )
    enableExtensionServiceWorkerSupport(ses, join(__dirname, '../preload/extension-sw.js'))
    // 파티션 이름을 함께 넘긴다 — 같은 세션이 두 번 들어와도 한 번만 붙는다
    void extensions
      .attachHost(createSessionExtensionHost(ses), partition)
      .then(() => warmExtensionWorkers(ses))
      .catch((e: unknown) => console.error('파티션 세션 확장 로드 실패', e))
  })

  // 확장 액션 팝업(툴바 아이콘 아래에 붙는 작은 창). 창당 한 개만 떠 있는다
  const extensionPopup = new ExtensionPopupHost({
    win,
    onClosed: () => send(IPC.extPopupClosed, null)
  })
  win.once('closed', () => extensionPopup.dispose())
  // 팝업은 탭 뷰 위에 얹히는데, 탭을 전환하면 활성 탭 뷰가 다시 맨 위로 올라간다.
  // 크롬도 탭을 바꾸면 팝업을 닫으므로 여기서 함께 닫는다
  tabs.onActivated(() => {
    extensionPopup.close()
    // 확장에 탭 활성화를 알린다(chrome.tabs.onActivated) — 샵백은 이때 아이콘·알림을 다시 판정한다.
    // 이 콜백은 활성 탭이 바뀌기 전에 불리므로 한 틱 뒤에 새 활성 탭을 읽는다(실기 2026-09-28: 이전 탭을 보냈다)
    setTimeout(() => {
      const t = tabs.active()
      const wc = t?.view.webContents
      if (wc && !wc.isDestroyed())
        sendExtensionTabEvent(wc.session, 'activated', { tabId: wc.id, windowId: 0 })
    }, 0)
  })

  handleFromRenderer(IPC.extList, () => ({ items: extensions.list(), errors: extensions.errors() }))
  // 경로를 주지 않으면 폴더 선택 다이얼로그를 연다. 취소하면 null 을 돌려준다.
  // 렌더러가 준 경로든 다이얼로그로 고른 경로든 resolveExtensionFolder 를 반드시 지난다 —
  // realpath 로 푼 실제 디렉터리이고 manifest.json 검증을 통과해야만 세션에 넘어간다
  handleFromRenderer(IPC.extLoad, async (rawPath?: unknown) => {
    let folder = typeof rawPath === 'string' ? rawPath : ''
    if (!folder) {
      const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      if (picked.canceled || picked.filePaths.length === 0) return null
      folder = picked.filePaths[0]
    }
    return extensions.add(folder)
  })
  handleFromRenderer(IPC.extRemove, (id: string) => {
    extensionPopup.close()
    return extensions.remove(id)
  })
  handleFromRenderer(IPC.extSetEnabled, (id: string, enabled: boolean) => {
    if (extensionPopup.activeId() === id) extensionPopup.close()
    return extensions.setEnabled(id, enabled)
  })

  // 툴바 아이콘 클릭 → 크롬이 하던 일을 대신한다.
  // Electron 39 에는 chrome.action 이 없어 확장이 팝업을 띄워 달라고 할 수 없으므로,
  // manifest 의 default_popup 을 우리가 읽어 같은 자리에 같은 문서를 띄운다
  handleFromRenderer(IPC.extAction, (id: unknown, rawAnchor: unknown): ExtensionActionResult => {
    if (typeof id !== 'string') throw new Error(tr('ipc.invalidExtensionId'))
    const item = extensions.find(id)
    if (!item) throw new Error(tr('ipc.extensionNotListed'))
    if (!item.enabled) throw new Error(tr('ipc.extensionDisabled'))
    const anchor = toExtensionAnchor(rawAnchor)
    if (item.popup) {
      // 팝업은 그 확장이 로드된 세션에서 열어야 chrome.* 이 동작한다.
      // 보통은 지금 보고 있는 탭의 파티션 세션이고, 거기에 없으면 기본 세션으로 내려간다
      const active = tabs.active()?.view.webContents.session
      const ses = sessionWithExtension(id, [...(active ? [active] : []), session.defaultSession])
      if (!ses) throw new Error(tr('ipc.extensionSessionNotFound'))
      const open = extensionPopup.toggle({
        id,
        url: extensionPopupUrl(id, item.popup),
        session: ses,
        anchor
      })
      return { kind: 'popup', open }
    }
    extensionPopup.close()
    if (item.optionsPage) {
      // 팝업이 없으면 크롬은 chrome.action.onClicked 를 보낸다. Electron 은 그 이벤트를
      // 전달할 방법이 없어, 대신 설정 화면에 해당하는 옵션 페이지를 새 탭으로 연다
      tabs.create({ url: extensionPopupUrl(id, item.optionsPage), extension: true })
      return { kind: 'options', open: false }
    }
    return { kind: 'none', open: false }
  })
  handleFromRenderer(IPC.extPopupClose, () => extensionPopup.close())

  // 가져오기·웹스토어 설치. 결과 폴더는 항상 userData/extensions/<id> 이고, 로드는 위 관리자가 한다
  const extensionInstaller = createExtensionInstaller({
    manager: extensions,
    extensionsRoot: join(app.getPath('userData'), 'extensions'),
    localAppData: process.env.LOCALAPPDATA ?? '',
    chromiumVersion: process.versions.chrome ?? '120.0.0.0',
    fetchImpl: (url, init) => globalThis.fetch(url, init)
  })
  handleFromRenderer(IPC.extImportSources, () => extensionInstaller.importSources())
  handleFromRenderer(IPC.extImportFrom, (ids: string[]) => extensionInstaller.importFrom(ids))
  handleFromRenderer(IPC.extInstallWebstore, (input: string) =>
    extensionInstaller.installWebstore(input)
  )

  // 웹스토어 탭에서 "Chrome에 추가" 를 누른 경우 — 크롬과 같은 설치 경험.
  // 발신자는 반드시 관리 중인 탭이면서 지금 보고 있는 주소가 웹스토어여야 한다
  // (웹 페이지·확장이 아무 id 나 밀어 넣어 설치시키는 것을 막는다)
  ipcMain.on(IPC.pageWebstoreInstall, (e, raw: unknown) => {
    if (!tabs.findByWebContents(e.sender)) return
    if (normalizeHost(e.sender.getURL()) !== WEBSTORE_HOST) return
    if (!isExtensionId(raw)) return
    const id = raw
    const sender = e.sender
    void extensionInstaller
      .installWebstore(id)
      .then((result) => {
        const ok = !result.error
        if (!ok) console.warn(`웹스토어 설치 실패(${id}): ${result.error}`)
        // 버튼 문구를 바꿔 주도록 누른 그 탭으로 결과를 돌려준다
        if (!sender.isDestroyed()) {
          sender.send(IPC.pageWebstoreInstallResult, { id, ok })
        }
        // 확장 페이지·퍼즐 메뉴가 열려 있으면 목록을 다시 읽게 한다
        if (ok) send(IPC.extChanged, null)
      })
      .catch((err: unknown) => {
        console.error('웹스토어 설치 처리 실패', err instanceof Error ? err.message : String(err))
        if (!sender.isDestroyed()) sender.send(IPC.pageWebstoreInstallResult, { id, ok: false })
      })
  })
  // === 확장 끝 =========================================================================

  // === 폰 연동(3단계) — 이 블록만 따로 추가한다 ========================================
  // 결제 비밀번호·문자 본문은 이 채널들로 흐르지 않는다
  const phoneAdb = createAdbRunner(() => settings.get().adbPath)
  // 원클릭 설치본이 들어가는 자리(%APPDATA%/SAMBA Browser/phone-tools)
  const phoneToolsRoot = join(app.getPath('userData'), 'phone-tools')
  const phoneRepo = new PhoneRepo(db)
  // 예전 버전이 auth_events 에 평문으로 남긴 인증번호를 자리수 표시로 바꾼다(I20)
  try {
    const purged = phoneRepo.purgeStoredCodes()
    if (purged > 0) console.log(`저장된 인증번호 ${purged}건을 자리수 표시로 바꿨습니다`)
  } catch (e: unknown) {
    console.warn('저장된 인증번호 정리 실패', e instanceof Error ? e.message : String(e))
  }
  // 비밀번호 화면 표식(결제 실행기가 갱신 → 화면 전송이 참조)과 ARS 진행 로그 중계
  const phoneSecretGate = new SecretScreenGate()
  const phoneProgress = new AgentProgressRelay()
  // 폰 연동 동기화 — 폰 목록·담당 계정을 계정 설정에 실어 다른 PC 에서도 보이게 한다(registry-sync.ts)
  const phoneRegistry = new PhoneRegistrySync({ repo: phoneRepo, settings })
  let phonePublishTimer: NodeJS.Timeout | null = null
  const publishPhonesSoon = (): void => {
    if (phonePublishTimer) clearTimeout(phonePublishTimer)
    phonePublishTimer = setTimeout(() => {
      try {
        phoneRegistry.publish()
      } catch (e: unknown) {
        console.warn('폰 목록 동기화 실패', e instanceof Error ? e.message : String(e))
      }
    }, 2000)
  }
  const phones = new PhoneService({
    adb: phoneAdb,
    repo: phoneRepo,
    settings,
    toolsRoot: phoneToolsRoot,
    emit: (list, warning) => {
      send(IPC.phoneUpdated, { list, warning })
      publishPhonesSoon()
    },
    emitAuthWaiting: (dto) => send(IPC.phoneAuthWaiting, dto),
    onProgress: (t) => phoneProgress.emit(t)
  })
  phones.start()
  win.once('closed', () => {
    if (phonePublishTimer) clearTimeout(phonePublishTimer)
    phones.dispose()
  })
  // 켤 때 한 번 맞추고, 다른 PC 의 변경이 내려오면 다시 맞춘다
  publishPhonesSoon()
  settings.onSynced((keys) => {
    if (!keys.some((k) => PHONE_SYNC_KEYS.includes(k))) return
    try {
      if (phoneRegistry.applyRemote()) void phones.refresh()
    } catch (e: unknown) {
      console.warn('받은 폰 목록 반영 실패', e instanceof Error ? e.message : String(e))
    }
  })

  handleFromRenderer(IPC.phoneList, () => phones.list())
  handleFromRenderer(IPC.phoneRefresh, () => phones.refresh())
  handleFromRenderer(IPC.phoneDetectPaths, () => phones.detectPaths())
  handleFromRenderer(IPC.phoneConnect, (address: string) => phones.connectWifi(address))
  handleFromRenderer(IPC.phoneRemove, (id: number) => phones.remove(id))
  handleFromRenderer(IPC.phonePair, (address: string, code: string) =>
    phones.pairWifi(address, code)
  )
  handleFromRenderer(IPC.phoneDisconnect, (serial: string) => phones.disconnect(serial))
  handleFromRenderer(IPC.phoneRecover, (serial: string) => phones.recover(serial))
  handleFromRenderer(IPC.phoneSetLabel, (id: number, label: string, country: string) =>
    phones.setLabel(id, label, country)
  )
  handleFromRenderer(IPC.phoneAssign, (accountId: number, phoneId: number | null) => {
    phones.assign(accountId, phoneId)
    // 담당 폰도 다른 PC 로 따라간다
    publishPhonesSoon()
  })
  handleFromRenderer(IPC.phoneAssigned, (accountId: number) => phones.assignedPhoneId(accountId))
  handleFromRenderer(IPC.phoneAuthEvents, (limit?: number) => phones.authEvents(limit))
  // 폰 연동 프로그램 원클릭 설치 — 내려받기·해제·설정 저장까지 메인에서만 한다
  handleFromRenderer(IPC.phoneToolsStatus, () =>
    phoneToolsStatus({ root: phoneToolsRoot, settings })
  )
  handleFromRenderer(IPC.phoneInstallTools, () =>
    installPhoneTools({
      root: phoneToolsRoot,
      fetchImpl: (url, init) => globalThis.fetch(url, init),
      settings,
      onProgress: (p) => send(IPC.phoneInstallProgress, p)
    })
  )
  // AI 폰 도구 배선. 금고는 넘기지 않는다 — 폰 도구는 비밀값을 볼 수 없다.
  // 문자 인증·결제 승인만 별도 실행기(phone/wiring.ts)를 거치고, 결제 비밀번호는
  // 그 안의 pay-secret.ts 밖으로 나오지 않는다.
  // 비밀 화면 표식을 함께 넘겨, 화면 읽기·캡처가 비밀번호 화면을 모델에게 넘기지 않게 한다
  const phoneOps = createPhoneOps(phoneAdb, () => phones.list(), phoneSecretGate)
  const visualDeps = {
    apiKey: () => apiKeys.get('anthropic'),
    model: () => resolveModel(settings.get().taskModels, 'visual', settings.get().aiProvider)
  }
  const phoneOcr = new OcrEngine()
  const phoneBridge = createPhoneAgentBridge({
    adb: phoneAdb,
    phones: {
      list: () => phones.list(),
      assignForJob: (accountId) => phones.assignForJob(accountId),
      notifyAuthWaiting: (dto) => phones.notifyAuthWaiting(dto),
      watchArs: (siteHost) => phones.watchArs(siteHost)
    },
    ops: phoneOps,
    repo: phoneRepo,
    vault,
    page: createTabPagePort(tabs),
    settings: () => settings.get(),
    // 인증번호는 로컬 OCR 로 먼저 읽고, 못 읽었을 때만 Visual 을 부른다
    readCode: createCodeReader({
      ocrEnabled: () => settings.get().ocrEnabled,
      ocr: phoneOcr,
      visual: (png) => readCodeFromImage(visualDeps, png)
    }),
    readKeypad: createKeypadReader({
      adb: phoneAdb,
      // 결제 키패드 원본 화면을 외부 AI 로 보내는 경로다 — 기본은 꺼짐
      enabled: () => settings.get().phoneKeypadVisual,
      screen: (serial) => phoneOps.screen(serial),
      readLayout: (png, size) => readKeypadLayout(visualDeps, png, size)
    }),
    secretGate: phoneSecretGate,
    progress: phoneProgress
  })
  agent.setPhones({
    phones: phoneOps,
    assigned: () => phoneBridge.defaultSerial(),
    waitForSmsCode: phoneBridge.waitForSmsCode,
    approvePayment: phoneBridge.approvePayment
  })
  // === 폰 연동 끝 ======================================================================

  // === 폰 화면(3단계 Task 5) ===========================================================
  // 화면 전송과 scrcpy 큰 창. 배선은 phone/screen-ipc.ts 한 곳에 모여 있다
  const phoneScreen = registerPhoneScreenIpc({
    handle: handleFromRenderer,
    send,
    settings: () => settings.get(),
    // 결제 비밀번호 화면 프레임은 보내지도 저장하지도 않는다
    isSecretScreen: (serial) => phoneSecretGate.isSecret(serial)
  })
  // 폰 도구가 큰 화면(scrcpy 창)을 열 수 있게 잇는다 — 캡차는 사람이 이 창에서 푼다
  phoneOps.openWindow = (serial) => phoneScreen.windows.open(serial)
  win.once('closed', () => phoneScreen.dispose())
  // === 폰 화면 끝 ======================================================================

  // === 화면 번역 · 이미지 번역 =========================================================
  const translate = registerTranslate({
    handle: handleFromRenderer,
    tabs,
    settings: () => settings.get(),
    apiKeys,
    userDataDir: app.getPath('userData'),
    // 번역 캐시에는 번역문이 평문으로 들어가므로 작업공간마다 파일을 나눈다
    profileId: () => `ws${workspace.active().id}`,
    // 진행률에는 개수와 고정된 사유 코드만 담긴다(원문·번역문은 오지 않는다)
    emit: (dto) => send(IPC.translateProgress, dto)
  })
  // 작업공간을 바꾸면 그 프로필의 캐시 파일로 갈아 끼운다
  workspace.onChanged(() => translate.setProfile())
  win.once('closed', () => translate.dispose())
  // === 번역 끝 ========================================================================
  // === 사진·영상 캡처 ==================================================================
  // 파일은 설정의 저장 폴더에만 쓰인다. 단축키는 위에서 만든 창 안 입력 경로에 붙는다
  const capture = registerCaptureIpc({
    handle: handleFromRenderer,
    send,
    settings: () => settings.get(),
    setSettings: (patch) => settings.set(patch),
    win,
    tabs,
    downloadsDir: () => app.getPath('downloads')
  })
  handleCaptureShortcut = capture.handleShortcut
  win.once('closed', () => capture.dispose())
  // === 캡처 끝 =========================================================================

  return { settings, agent, db, vault, auth, sync }
}
