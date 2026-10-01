import { buildLearnPrompt, LEARN_PROMPT_PREFIX, shouldLearn, type LearnedRunJs } from './learn'
import {
  buildHistoryNote,
  RESUME_MAX_RUNS,
  type ChatSessionStore,
  type HistoryMessage
} from './chat-session'
import { randomUUID } from 'crypto'
import type { TabManager } from '../browser/tab-manager'
import type { SettingsStore } from '../settings/store'
import type { AgentEvent, HandoffKind } from '../../shared/ipc'
import type { Settings } from '../../shared/settings'
import type { VaultService } from '../vault/service'
import { createSambaTools, SAMBA_TOOL_NAMES } from './tools'
import type { ToolContext, SambaMcpTool } from './tools'
import { hasConnectedPhone } from './tools-phone'
import type { PayToolRequest, PhoneToolContext, SmsCodeOutcome } from './tools-phone'
import type { PayResult } from '../phone/pay'
import type { PhoneRunContext } from '../phone/wiring'
import { appendSiteMemory, buildSystemPrompt } from './prompt'
import { appendPlaybooks, matchPlaybooks, type PlaybookDto } from '../../shared/playbook'
import type { AgentToolCall } from '../../shared/site-memory'
import type { SiteMemoryBlock, SiteMemoryService } from './site-memory'
import type { ScheduleRunOverrides } from '../../shared/schedule'
import type { AgentImage } from '../../shared/agent-image'
import {
  runQuery,
  runCodexQuery,
  agentBackend,
  classifyAuthError,
  isFatalApiError,
  advanceSubscriptionFallback,
  subscriptionFallbackIndex,
  NOT_CONNECTED_ERROR
} from './provider'
import { resolveModel } from '../ai/models'
import type { CodexInput } from './provider-codex'
import { makeCounter } from './counter'
import type { SiteScriptStore } from './site-scripts-store'
import { buildScriptsBlock } from '../../shared/site-scripts'
import { createTextDeduper } from './dedupe'
import { labelLaneTargets, laneTabs, newLaneState, type LaneState } from './lane-tabs'
import {
  watchHandoff,
  HANDOFF_TIMEOUT_MS,
  type HandoffResult,
  type HandoffWatchDeps
} from './handoff'

/** 브릿지가 쓰는 도구 세션. 채팅 실행과 같은 도구를 이름으로 부른다(한 손발이라 동시에 못 돈다) */
export interface ToolSession {
  /** 부를 수 있는 도구 이름 */
  names(): string[]
  /** 도구 1건 호출. 도구가 돌려주는 본문 문자열. 없는 이름이면 throw */
  call(name: string, args: Record<string, unknown>): Promise<string>
  /** 세션 종료 — 이후 채팅 실행이 다시 가능해진다 */
  dispose(): void
}

/**
 * createSambaTools() 가 돌려준 서버에서 이름→핸들러 목록을 뽑는다.
 * 서버 객체는 자신이 등록한 도구 배열을 `.tools` 로 그대로 들고 있다(createSambaTools 의
 * 반환값 계약) — MCP 내부의 비공개 필드는 들여다보지 않는다
 */
function extractSdkTools(server: unknown): SambaMcpTool[] {
  const tools = (server as { tools?: unknown }).tools
  if (!Array.isArray(tools)) throw new Error('도구 목록을 읽을 수 없음')
  return tools as SambaMcpTool[]
}

// 확인 요청 응답 대기 상한 30분
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000

/** 지시문에 적힌 카드사 이름("현대카드"·"롯데카드"). 결제 도구가 card 를 빠뜨리면 이 값으로 거부한다 */
const CARD_NAME_RE =
  /(현대|롯데|국민|KB국민|KB|신한|삼성|우리|하나|농협|NH농협|NH|BC|비씨|씨티|카카오뱅크|토스뱅크)\s*카드/
export function cardNamedIn(prompt: string): string | undefined {
  const m = CARD_NAME_RE.exec(prompt)
  return m ? m[0].replace(/\s+/g, '') : undefined
}
// 답 없이 멈춘 실행을 자동으로 이어갈 때 쓰는 지시문 머리. 이걸로 시작하면 사용자 지시가 아니다
const AUTO_CONTINUE_PROMPT = '직전 작업을 그 자리에서 이어서'

/**
 * 작업 1건이 남긴 대화 기록. 완료·실패·중단 어느 쪽으로 끝나도 한 번 전달된다.
 * steps 에는 도구가 붙인 **라벨**만 담긴다 — fill_secret·login 은 평문을 라벨에 넣지 않는다
 */
export interface TranscriptEntry {
  prompt: string
  text: string
  steps: { label: string; ok: boolean }[]
}

/** 대화 기록 저장 훅. 주입하지 않으면 아무것도 저장하지 않는다 */
export type TranscriptSink = (chatId: number, entry: TranscriptEntry) => void

/** 플레이북 목록 공급자. 주입하지 않으면 플레이북이 전혀 적용되지 않는다 */
export type PlaybookProvider = () => PlaybookDto[]
// Codex 백엔드로 이미지가 함께 왔을 때 지시문 끝에 붙이는 안내
export const CODEX_NO_IMAGE_NOTE =
  '(The user attached an image, but this AI connection cannot see images. Say so briefly and ask them to describe it.)'
/** 플레이북 절차 수정기(AI 의 update_playbook 도구가 쓴다). 없으면 도구를 등록하지 않는다 */
export interface PlaybookEditor {
  list: () => PlaybookDto[]
  setInstructions: (id: string, instructions: string) => PlaybookDto | null
}

/**
 * 폰 도구 배선. 권한 모드·호출 상한·확인 카드는 웹 도구 것을 그대로 쓰므로
 * 배선부는 폰 조작 능력과 배정 폰만 넘긴다(금고는 넘기지 않는다)
 */
export type PhoneBridge = Pick<PhoneToolContext, 'phones' | 'assigned'> & {
  /**
   * 문자 인증 흐름(phone/wiring.ts). 붙어 있지 않으면 wait_for_sms_code 도구가
   * "sms auth is not available" 만 돌려준다
   */
  waitForSmsCode?: (ctx: PhoneRunContext, host?: string) => Promise<SmsCodeOutcome>
  /** 결제 승인 실행기. 붙어 있지 않으면 결제 도구 자체를 등록하지 않는다 */
  approvePayment?: (ctx: PhoneRunContext, req: PayToolRequest) => Promise<PayResult>
}

// 대기 중인 확인 요청(응답 콜백 + 만료 타이머)
interface PendingConfirm {
  resolve: (ok: boolean) => void
  timer: NodeJS.Timeout
}

// 작업 1건 실행: SDK 스트림을 읽어 UI 이벤트로 변환
// 실행·세션 종료 뒤 페이지 대화상자를 계속 자동 처리하는 유예 시간
export const AUTOMATION_GRACE_MS = 5_000

export class AgentRunner {
  private abort: AbortController | null = null
  // 마지막으로 실행·브릿지 세션이 끝난 시각(대화상자 자동 처리 유예 창의 기준)
  private automationIdleSince = 0
  private pending = new Map<string, PendingConfirm>()
  // 실행 세대 번호. 중단된 이전 스트림이 뒤늦게 보내는 이벤트를 걸러낸다
  private generation = 0
  // 대화 기록 저장 훅(채팅 저장소). 없으면 기록을 남기지 않는다
  private transcript: TranscriptSink | null = null
  // 사용자 지시 하나당 자동 이어가기 허용 횟수(무한 반복 방지)
  private autoContinueLeft = 1
  // 지금 도는 실행이 사용자 지시가 아닌 후속 턴(자동 이어가기·자동 학습)인지. 사용자 지시가 들어오면 양보한다
  private followUpRunning = false
  // 폰 도구 배선. 없으면 폰 도구를 등록하지 않는다(3단계 전 실행·테스트)
  private phones: PhoneBridge | null = null
  // 자동화 플레이북 목록 공급자. 없으면 시스템 프롬프트에 아무것도 덧붙이지 않는다
  private playbooks: PlaybookProvider | null = null
  private playbookEditor: PlaybookEditor | null = null
  // 사이트 기억. 없으면 기억을 붙이지도 남기지도 않는다(기존 호출부·테스트)
  private siteMemory: SiteMemoryService | null = null
  private siteScripts: SiteScriptStore | null = null
  // 대화 ↔ SDK 세션 연결. 없으면 매 실행이 새 세션이다(기억 없음)
  private chatSessions: ChatSessionStore | null = null
  // 세션을 못 이어받을 때 앞부분 요약을 만들 대화 읽기. 없으면 요약도 없다
  private historyReader: ((chatId: number) => HistoryMessage[]) | null = null
  // 실행 중인 작업이 쥔 금고 자동 잠금 보류 해제 함수. stop() 과 run() 의 finally 가
  // 겹쳐 불러도 되도록 해제 함수 자체가 여러 번 호출에 안전하다
  private releaseVaultHold: (() => void) | null = null
  // 밖의 하네스가 쥔 도구 세션. 있는 동안은 채팅 실행(run)을 받지 않는다(한 손발이라 동시에 못 돈다)
  private session: ToolSession | null = null
  // 동시에 열린 레인 세션 수와 레인별 탭 보기 상태(하네스 계정 동시 처리)
  private laneSessions = 0
  private readonly lanes = new Map<string, LaneState>()
  // 브릿지 세션들이 함께 보는 키패드 입력 기록(창 id|호스트) — 한 결제창에 결제 비밀번호를 두 번 넣지 않는다
  private readonly bridgeKeypadEntered = new Set<string>()

  private laneStateOf(name: string): LaneState {
    let st = this.lanes.get(name)
    if (!st) {
      st = newLaneState()
      this.lanes.set(name, st)
    }
    return st
  }

  constructor(
    private tabs: TabManager,
    private settings: SettingsStore,
    private emit: (e: AgentEvent) => void,
    // 개인정보 금고. 없으면 금고 도구는 잠금으로 동작한다
    private vault?: VaultService
  ) {}

  /** 폰 도구 배선을 붙인다. null 이면 폰 도구를 등록하지 않는다 */
  setPhones(bridge: PhoneBridge | null): void {
    this.phones = bridge
  }

  /** 대화 기록 저장 훅을 붙인다(채팅 저장소). null 이면 기록하지 않는다 */
  setTranscript(sink: TranscriptSink | null): void {
    this.transcript = sink
  }

  /** 플레이북 목록 공급자를 붙인다. null 이면 플레이북을 적용하지 않는다 */
  setPlaybooks(provider: PlaybookProvider | null): void {
    this.playbooks = provider
  }

  /** 플레이북 수정기를 붙인다. null 이면 list_playbooks·update_playbook 도구를 내보내지 않는다 */
  setPlaybookEditor(editor: PlaybookEditor | null): void {
    this.playbookEditor = editor
  }

  /** 저장된 사이트 스크립트를 붙인다. null 이면 목록 주입과 save_script·run_script 가 꺼진다 */
  setSiteScripts(store: SiteScriptStore | null): void {
    this.siteScripts = store
  }

  /**
   * 대화 ↔ SDK 세션 연결을 붙인다. 같은 대화의 다음 지시는 세션을 이어받아 앞선 지시·도구 결과를 기억한다.
   * reader 는 세션을 못 이어받을 때(세션 없음·상한 초과) 앞부분 요약을 만들 대화 메시지를 준다
   */
  setChatSessions(
    store: ChatSessionStore | null,
    reader: ((chatId: number) => HistoryMessage[]) | null
  ): void {
    this.chatSessions = store
    this.historyReader = reader
  }

  /** 사이트 기억을 붙인다. null 이면 기억 주입·학습·remember_site 가 모두 꺼진다 */
  setSiteMemory(service: SiteMemoryService | null): void {
    this.siteMemory = service
  }

  /**
   * 이 프롬프트에 걸리는 플레이북을 찾는다.
   * 공급자가 던져도 실행 자체는 막지 않는다(플레이북 없이 평소대로 돈다)
   */
  private matchedPlaybooks(prompt: string): PlaybookDto[] {
    if (!this.playbooks) return []
    try {
      return matchPlaybooks(prompt, this.playbooks())
    } catch (e: unknown) {
      console.error('플레이북 조회 실패', e instanceof Error ? e.message : String(e))
      return []
    }
  }

  /**
   * 이번 실행에 붙일 사이트 기억 블록. 기억이 붙어 있지 않거나 아는 호스트가 없으면 빈 블록이다.
   * 기억 조회가 실패해도 실행 자체는 막지 않는다(기억 없이 평소대로 돈다)
   */
  private siteMemoryBlock(prompt: string, playbooks: PlaybookDto[]): SiteMemoryBlock {
    const empty: SiteMemoryBlock = { text: '', hosts: [], usedRecipe: false }
    if (!this.siteMemory) return empty
    try {
      return this.siteMemory.blockFor({
        prompt,
        playbookTexts: playbooks.map((p) => p.instructions),
        currentUrl: this.currentUrl(),
        // 플레이북 실행은 플레이북 이름으로 경로를 남기므로 같은 이름의 경로를 먼저 싣는다
        goals: playbooks.map((p) => p.name)
      })
    } catch (e: unknown) {
      console.error('사이트 기억 조회 실패', e instanceof Error ? e.message : String(e))
      return empty
    }
  }

  /** 활성 탭의 주소. 탭이 없거나 이미 닫혔으면 빈 문자열 */
  private currentUrl(): string {
    try {
      return this.tabs.active()?.view.webContents.getURL() ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 성공으로 끝난 실행을 마무리한다 — 성공 경로를 기억에 접고, 속도 지표를 한 줄 남긴다.
   * 기억 저장이 실패해도 실행 결과에는 영향을 주지 않는다
   */
  private finishRun(run: {
    prompt: string
    calls: AgentToolCall[]
    startedAt: number
    /** 이번 실행의 전체 도구 호출 수(관찰 도구 포함) */
    toolCalls: number
    usedRecipe: boolean
    /** 이번 실행에 걸린 플레이북 이름. 있으면 경로를 이 이름으로 누적한다 */
    goal?: string
    /** 끝까지 못 간 실행(도구 상한·오류). 성공한 단계까지만 부분 경로로 남긴다 */
    partial?: boolean
  }): void {
    const seconds = Math.round((Date.now() - run.startedAt) / 1000)
    // 효과 비교용 한 줄. 기억을 실어 보낸 실행이면 표식이 붙는다
    console.info(
      `작업 ${run.partial ? '중단' : '완료'} — 도구 호출 ${run.toolCalls}회·${seconds}초` +
        (run.usedRecipe ? ' (usedRecipe: true)' : '')
    )
    if (!this.siteMemory) return
    try {
      this.siteMemory.learn({
        prompt: run.prompt,
        calls: run.calls,
        ...(run.goal === undefined ? {} : { goal: run.goal }),
        ...(run.partial === true ? { partial: true } : {})
      })
    } catch (e: unknown) {
      console.error('사이트 기억 저장 실패', e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 지금 작업이 실행 중인가(페이지 대화상자 자동 처리 조건 판정에 쓴다). 브릿지 세션이 열려 있는 동안도 포함한다.
   * 실행·세션이 끝난 직후 잠깐(AUTOMATION_GRACE_MS)도 실행 중으로 본다 — 스크립트가 버튼을 누르고
   * 바로 돌아간 뒤 페이지가 띄우는 alert 가 "자동화 중 아님" 으로 판정돼 창이 쌓였다(실기: 하네스는
   * 도구 호출마다 세션을 열고 닫아 그 틈이 잦다)
   */
  isRunning(): boolean {
    if (this.abort !== null || this.session !== null || this.laneSessions > 0) return true
    return Date.now() - this.automationIdleSince < AUTOMATION_GRACE_MS
  }

  /** 실행·세션이 끝난 시각을 적는다(유예 창의 기준점) */
  private markAutomationIdle(): void {
    this.automationIdleSince = Date.now()
  }

  /**
   * 사용자 확인 카드를 띄우고 응답을 기다린다(AI 도구·페이지 대화상자 공용).
   * 응답이 없으면 상한 시간 뒤 거부로 처리한다
   */
  requestConfirm(
    action: string,
    kind: 'danger' | 'finish' = 'danger',
    emit: (e: AgentEvent) => void = this.emit
  ): Promise<boolean> {
    const id = randomUUID()
    const reply = this.registerPending(id, CONFIRM_TIMEOUT_MS)
    emit({ type: 'confirm', requestId: id, action, kind })
    return reply
  }

  /**
   * 캡차·2FA 를 사용자에게 넘기고 작업을 일시정지한다.
   * 사용자가 화면에서 직접 처리하면(페이지 이동·징후 소멸) 자동으로 재개하고,
   * 카드 버튼을 누르면 건너뛰기(skipped)/중단(aborted)으로 끝난다.
   * 캡차를 대신 푸는 일은 하지 않는다 — 입력은 언제나 사용자가 한다
   */
  async requestHandoff(
    req: {
      matched: string
      currentUrl: () => string
      stillBlocked: () => Promise<boolean>
      // 카드 종류. 없으면 캡차·2FA 로 본다
      kind?: HandoffKind
      // 테스트에서 폴링 주기·시계를 갈아 끼우기 위한 통로
      watch?: Pick<HandoffWatchDeps, 'sleep' | 'pollMs' | 'timeoutMs'>
    },
    emit: (e: AgentEvent) => void = this.emit
  ): Promise<HandoffResult> {
    const id = randomUUID()
    // 사용자 버튼 응답: true = 건너뛰고 계속, false = 작업 중단
    const reply = this.registerPending(id, HANDOFF_TIMEOUT_MS + 60_000)
    emit({
      type: 'handoff',
      requestId: id,
      kind: req.kind ?? 'captcha',
      matched: req.matched,
      url: req.currentUrl()
    })
    let replied = false
    const userOutcome = reply.then((ok): HandoffResult => {
      replied = true
      return { outcome: ok ? 'skipped' : 'aborted', url: req.currentUrl() }
    })
    const watched = watchHandoff({
      currentUrl: req.currentUrl,
      stillBlocked: req.stillBlocked,
      cancelled: () => replied,
      ...req.watch
    }).then((r): HandoffResult | null =>
      r.outcome === 'cancelled' ? null : { outcome: r.outcome, url: r.url }
    )
    // 먼저 끝나는 쪽이 결과가 된다. 감시가 취소(null)면 사용자 응답을 기다린다
    const result = await Promise.race([userOutcome, watched.then((r) => r ?? userOutcome)])
    // 자동 재개·시간 초과로 끝났으면 남은 응답 대기를 정리한다(카드도 닫힌다)
    this.settlePending(id)
    emit({ type: 'handoffDone', requestId: id, outcome: result.outcome })
    return result
  }

  // 응답 대기 1건 등록 — 확인 카드와 넘김 카드가 같은 응답 채널을 쓴다
  private registerPending(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // 응답이 없으면 거부 처리
        if (this.pending.delete(id)) resolve(false)
      }, timeoutMs)
      // 대기 타이머가 앱 종료를 막지 않도록 한다
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
    })
  }

  // 아직 남아 있는 대기 1건을 조용히 정리한다(거부로 resolve)
  private settlePending(id: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(false)
  }

  resolveConfirm(id: string, approved: boolean): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(approved)
  }

  // 남은 확인 요청을 모두 거부로 정리(타이머 해제 포함)
  private clearPending(): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.resolve(false)
    }
    this.pending.clear()
  }

  stop(): void {
    // 실행 중이 아니면 아무것도 하지 않는다(중복 stopped 방지)
    if (!this.abort) return
    const abort = this.abort
    // 곧바로 새 작업을 받을 수 있도록 abort 를 동기적으로 비운다.
    // (SDK 스트림은 재시도 백오프 중이면 수십 초 뒤에야 끝나므로 finally 를 기다릴 수 없다)
    this.abort = null
    // 세대를 올려 이전 스트림의 잔여 이벤트를 무시한다
    this.generation += 1
    abort.abort()
    this.clearPending()
    // 중단했으면 스트림이 실제로 끝날 때까지 기다리지 않고 곧바로 자동 잠금 보류를 푼다
    this.releaseVaultHold?.()
    this.releaseVaultHold = null
    this.emit({ type: 'status', state: 'stopped' })
  }

  /**
   * chatId 를 주면 이 실행의 대화 기록을 그 대화에 저장한다(완료·실패·중단 모두).
   * overrides 는 예약 실행이 넘기는 이번 실행만의 모델·권한 모드다 —
   * 주지 않으면(사용자가 직접 친 문장) 전역 설정을 그대로 쓴다
   */
  async run(
    prompt: string,
    chatId?: number,
    overrides?: ScheduleRunOverrides,
    // AI 창에 붙여 넣은 이미지. 모델에만 실어 주고 대화 기록에는 남기지 않는다
    images?: AgentImage[]
  ): Promise<void> {
    if (this.session || this.laneSessions > 0) throw new Error('브릿지 세션 사용 중')
    // 이미 실행 중이면 세대 가드 없이 status 를 emit 하면 진행 중인 실행의 UI 를 덮어쓸 수 있다.
    // 핸들러가 throw 를 { ok: false, error } 로 ack 하므로 에러만 던진다.
    if (this.abort) {
      // 자동 이어가기·자동 학습 턴이 도는 중에 들어온 사용자 지시는 그 턴을 끊고 우선한다.
      // (실기: 결제 실패 뒤 학습 턴이 도는 사이 친 "연결됐어 다시해"가 조용히 버려졌다)
      if (this.followUpRunning) this.stop()
      else throw new Error('이미 실행 중')
    }
    // 이전 작업의 잔여 확인 요청 정리
    this.clearPending()
    const saved = this.settings.get()
    // 권한 모드만 덮어쓴다. 도구·프롬프트가 보는 s.permissionMode 가 한 군데라 이걸로 충분하다
    const s =
      overrides?.permissionMode === undefined
        ? saved
        : { ...saved, permissionMode: overrides.permissionMode }
    // 이번 실행에 쓸 모델. 예약이 모델을 지정하지 않았으면 작업별 모델 표의 '표준' 칸이다
    const overrideModel = overrides?.model?.trim()
    const runModel =
      overrideModel !== undefined && overrideModel !== ''
        ? overrideModel
        : resolveModel(s.taskModels, 'standard', s.aiProvider)
    const abort = new AbortController()
    this.abort = abort
    const gen = ++this.generation
    // 이 실행이 남길 대화 기록. 화면으로 나가는 이벤트와 같은 값만 모은다(라벨·본문)
    const entry: TranscriptEntry = { prompt, text: '', steps: [] }
    // 자동 이어가기 문장이 아니면 사용자의 새 지시 — 허용 횟수를 되돌린다
    const autoContinuing = prompt.startsWith(AUTO_CONTINUE_PROMPT)
    if (!autoContinuing) this.autoContinueLeft = 1
    // 사용자의 새 지시는 지금 보이는 탭부터 조작한다 — 이전 자동화가 뒤 탭에 남긴 대상 표식을 지운다
    // (사람이 창을 쓰는 중이라 뒤에서만 돌던 자동화의 대상 탭이 새 지시로 이어지지 않게, visible-guard.ts)
    if (!autoContinuing && !prompt.startsWith(LEARN_PROMPT_PREFIX)) {
      const tabs = this.tabs as Partial<TabManager>
      if (typeof tabs.clearAgentTarget === 'function') tabs.clearAgentTarget()
    }
    this.followUpRunning = autoContinuing || prompt.startsWith(LEARN_PROMPT_PREFIX)
    // 이 실행의 행동 도구 호출 기록. 성공으로 끝나면 사이트 기억이 여기서 경로를 뽑는다
    const calls: AgentToolCall[] = []
    // 이 실행에서 돌린 run_js 코드 전문. 실행이 끝나면 자동 학습 턴이 이것으로 재생용 스크립트를 만든다
    const runJsLog: LearnedRunJs[] = []
    // 이 실행이 끝난 뒤 이어서 돌릴 지시문(자동 이어가기·자동 학습). finally 에서 실행 상태를 비운 다음에 시작한다
    let followUp: string | null = null
    // Claude 구독 계정이 막히면(만료·차단·한도) 예비 계정으로 넘긴다. 도구를 아직 하나도 안 불렀을 때만
    // 같은 지시로 다시 돈다(이미 화면을 건드렸으면 중복 실행 위험 — 다음 지시부터 예비 계정을 쓴다)
    const retryOnFallbackAccount = (): boolean => {
      if (!advanceSubscriptionFallback()) return false
      if (counter.count() !== 0) return false
      emit({
        type: 'text',
        text: `(Claude 구독 계정이 막혀 예비 계정 ${subscriptionFallbackIndex()}번으로 다시 시작합니다)`
      })
      followUp = prompt
      return true
    }
    // 이 실행의 SDK 세션 id(init 메시지) · 이어받은 세션 id · 이어받기 실패 여부
    let sessionId: string | null = null
    let resume: string | undefined
    let resumeFailed = false
    const startedAt = Date.now()
    // 사용자 문장에 걸리는 플레이북 — 시스템 프롬프트 뒤에 절차를 덧붙이고, 화면에는 이름만 알린다
    // 자동 학습 턴에는 플레이북을 붙이지 않는다 — 지시문에 든 "주문처리"에 걸려 주문을 다시 처리하려 들면 안 된다
    const learning = prompt.startsWith(LEARN_PROMPT_PREFIX)
    const playbooks = learning ? [] : this.matchedPlaybooks(prompt)
    // 이번 실행에 붙일 사이트 기억 블록(지시문·플레이북 본문·현재 탭 URL 에서 호스트를 뽑는다)
    const memory = this.siteMemoryBlock(prompt, playbooks)
    const scripts = s.siteMemoryEnabled ? this.siteScripts : null
    const scriptsBlock = scripts ? buildScriptsBlock(scripts.list()) : ''
    // 이 실행이 최신 세대일 때만 UI 로 이벤트를 보낸다
    const emit = (e: AgentEvent): void => {
      if (gen !== this.generation) return
      if (e.type === 'text') entry.text = entry.text ? `${entry.text}\n${e.text}` : e.text
      if (e.type === 'step') entry.steps.push({ label: e.label, ok: e.ok })
      // 성공이면 완주 경로, 도구를 쓰다 실패(상한·오류)했으면 부분 경로를 남긴다.
      // 연결·인증 문제로 시작도 못 한 실패(auth:*)는 배울 것이 없다. 속도 지표도 여기서 한 줄 적는다
      if (e.type === 'status' && (e.state === 'done' || e.state === 'failed')) {
        const partial = e.state === 'failed'
        const authFailure = partial && (e.message ?? '').startsWith('auth:')
        if (!authFailure && (!partial || calls.length > 0)) {
          this.finishRun({
            prompt,
            calls,
            startedAt,
            toolCalls: e.toolCalls ?? 0,
            usedRecipe: memory.usedRecipe,
            ...(playbooks[0] === undefined ? {} : { goal: playbooks[0].name }),
            ...(partial ? { partial: true } : {})
          })
        }
      }
      this.emit(e)
    }
    // 폰이 안 붙어 있으면 폰 도구를 내보내지 않으므로(createSambaTools) 프롬프트의 폰 절도 한 줄로 줄인다
    const phoneAvailable =
      this.phones !== null && this.phones !== undefined && hasConnectedPhone(this.phones)
    const systemPrompt = (
      mode: 'read_only' | 'guard' | 'full',
      effort?: typeof s.agentEffort
    ): string =>
      appendSiteMemory(
        appendPlaybooks(
          effort === undefined
            ? buildSystemPrompt(s.language, mode, 'medium', phoneAvailable)
            : buildSystemPrompt(s.language, mode, effort, phoneAvailable),
          playbooks
        ),
        // 저장된 스크립트 목록은 실행마다 다시 읽는다(직전 실행에서 저장한 것이 바로 보이게).
        // 사이트 기억을 끈 실행에서는 스크립트도 끈다 — 같은 "학습" 스위치다
        [memory.text, scriptsBlock].filter((part) => part !== '').join('\n\n')
      )
    const counter = makeCounter(s.maxToolCalls)
    const deduper = createTextDeduper()
    // api_retry 로 관측한 마지막 API 오류(결과 메시지에 문구가 없을 때 사용)
    let apiError = ''
    // 종료 상태를 이미 보냈는지. SDK 는 오류 result 를 내보낸 뒤 throw 까지 하므로 중복 방지
    let settled = false
    // 이번 실행의 감사 로그 식별자(금고 fill 기록에 남는다)
    const jobId = randomUUID()
    // 폰 배선이 쓰는 작업 문맥. 확인 카드·진행 로그·넘김 카드는 웹 도구 것을 그대로 쓴다
    const phones = this.phones
    const phoneCtx = (): PhoneRunContext => ({
      jobId,
      confirm: (action, kind = 'danger') => this.requestConfirm(action, kind, emit),
      onStep: (label, ok) => emit({ type: 'step', label, ok }),
      handoff: (req) => this.requestHandoff(req, emit),
      cancelled: () => abort.signal.aborted
    })
    const waitSms = (host?: string): Promise<SmsCodeOutcome> =>
      phones?.waitForSmsCode
        ? phones.waitForSmsCode(phoneCtx(), host)
        : Promise.resolve({ filled: false, digits: 0 })
    const runPay = (req: PayToolRequest): Promise<PayResult> =>
      phones?.approvePayment
        ? phones.approvePayment(phoneCtx(), req)
        : Promise.resolve({ ok: false, reason: 'declined' as const })
    const server = createSambaTools(
      this.buildToolContext({
        s,
        jobId,
        tick: counter.tick,
        emit,
        confirm: (action, kind = 'danger') => this.requestConfirm(action, kind, emit),
        handoff: (req) => this.requestHandoff(req, emit),
        onCall: (call) => calls.push(call),
        onRunJs: (run) => runJsLog.push(run),
        scripts,
        phoneCtx,
        waitSms,
        runPay,
        prompt
      })
    )
    emit({ type: 'status', state: 'running', toolCalls: 0 })
    // 어떤 플레이북이 적용됐는지 채팅에 한 줄로 알린다(절차 본문은 보내지 않는다)
    if (playbooks.length > 0) emit({ type: 'playbook', names: playbooks.map((p) => p.name) })
    // 실행이 도는 동안에는 금고 자동 잠금을 보류한다(몇 시간짜리 작업 중간에 잠기면
    // 로그인 도구가 실패한다). done/failed/stopped·예외 어느 쪽으로 끝나도 finally 에서 푼다
    const releaseVaultHold = this.vault?.holdAutoLock('agent run') ?? ((): void => {})
    this.releaseVaultHold = releaseVaultHold
    try {
      const backend = agentBackend()
      // 연결된 경로가 없다 — 실행하지 않고 "연결 필요" 안내로 끝낸다
      if (backend === 'none') {
        settled = true
        emit({ type: 'status', state: 'failed', message: 'auth:notConnected', toolCalls: 0 })
        return
      }
      // Codex 구독 경로: Codex CLI 를 백엔드로 텍스트 응답을 받는다(samba 도구는 붙지 않는다)
      if (backend === 'codex') {
        // Codex 경로는 이미지를 받지 않는다 — 조용히 빼지 않고 모델에게 그 사실을 알린다
        settled = await this.runOnCodex(
          {
            prompt:
              images && images.length > 0
                ? `${prompt}
${CODEX_NO_IMAGE_NOTE}`
                : prompt,
            systemPrompt: systemPrompt(s.permissionMode),
            model: runModel,
            abort
          },
          deduper,
          emit
        )
        return
      }
      // 같은 대화면 SDK 세션을 이어받는다(앞선 지시·탭·도구 결과를 기억). 세션이 없거나 한 세션으로
      // 너무 오래 돌았으면 새 세션을 열고, 대신 앞부분 요약을 지시문 앞에 붙여 맥락을 넘긴다
      const session = chatId === undefined ? null : (this.chatSessions?.get(chatId) ?? null)
      resume = session !== null && session.runs < RESUME_MAX_RUNS ? session.sessionId : undefined
      const historyNote =
        resume === undefined && chatId !== undefined && !learning && this.historyReader
          ? buildHistoryNote(this.historyReader(chatId))
          : ''
      const stream = runQuery({
        prompt: historyNote === '' ? prompt : `${historyNote}${prompt}`,
        ...(resume === undefined ? {} : { resume }),
        ...(images && images.length > 0 ? { images } : {}),
        systemPrompt: systemPrompt(s.permissionMode, s.agentEffort),
        model: runModel,
        // 채팅 입력줄에서 고른 추론 강도
        effort: s.agentEffort,
        mcpServers: { samba: server },
        allowedTools: SAMBA_TOOL_NAMES,
        abort
      })
      for await (const msg of stream) {
        // 중단됐으면 남은 메시지는 읽지 않는다(스트림이 늦게 끝나도 UI 는 즉시 정리됨)
        if (abort.signal.aborted) break
        if (msg.type === 'assistant') {
          // SDKAssistantMessage.message = Anthropic API 메시지.
          // 같은 문단이 두 번 실려 오는 경우가 있어 중복 제거기를 거친다
          for (const block of msg.message.content) {
            if (block.type !== 'text') continue
            const text = deduper.accept(block.text)
            if (text) emit({ type: 'text', text })
          }
        } else if (msg.type === 'system' && msg.subtype === 'init') {
          // 이 실행의 SDK 세션 id — 끝나면 대화에 남겨 다음 지시가 이어받는다
          sessionId = msg.session_id
        } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
          // 인증 실패는 SDK 가 최대 10회 재시도한다(수 분 소요). 회복 불가 오류면 즉시 중단
          apiError = `${msg.error} ${msg.error_status ?? ''}`.trim()
          if (isFatalApiError(msg.error)) {
            const kind = classifyAuthError(apiError)
            settled = true
            // abort 하면 finally 가 이어 돌기(followUp)를 막는다 — 스트림만 닫고 빠져나간다
            if (retryOnFallbackAccount()) break
            emit({
              type: 'status',
              state: 'failed',
              message: kind ? `auth:${kind}` : apiError,
              toolCalls: counter.count()
            })
            abort.abort()
            return
          }
          // 재시도 가능한 오류(rate_limit·overloaded·server_error)는 진행 띠에만 알린다
          emit({ type: 'progress', kind: 'apiRetry', attempt: msg.attempt, reason: msg.error })
        } else if (msg.type === 'result') {
          const failed = msg.subtype !== 'success' || msg.is_error
          // 화면에 보여줄 실패 사유(모델이 쓴 result 문구 포함)
          const detail = [
            msg.subtype === 'success' ? (msg.is_error ? msg.result : '') : msg.errors.join(' '),
            apiError
          ]
            .filter(Boolean)
            .join(' ')
          // 인증 분류에는 모델이 생성한 result 텍스트를 넣지 않는다.
          // ("로그인 페이지로 이동했습니다" 같은 정상 요약이 auth:missing 으로 오분류됐다)
          const kind = classifyAuthError(
            [msg.subtype === 'success' ? '' : msg.errors.join(' '), apiError]
              .filter(Boolean)
              .join(' ')
          )
          // assistant 텍스트를 한 번도 못 받았을 때만 최종 결과 문자열을 대신 보여준다
          if (!failed && deduper.count() === 0) {
            const text = deduper.accept(msg.subtype === 'success' ? msg.result : '')
            if (text) emit({ type: 'text', text })
          }
          // 도구를 여러 번 부르다가 done 없이 조용히 끝난 경우(실기: 로그인 뒤 빈 응답으로 종료) —
          // 사람이 "계속"을 치기 전에 한 번만 자동으로 이어 달라고 한다
          const silentStop =
            !failed &&
            counter.count() >= 3 &&
            !entry.steps.some(
              (st) => st.label.startsWith('완료:') || st.label.startsWith('계속 진행:')
            ) &&
            !entry.steps.some((st) => /넘김|handoff|확인 대기/.test(st.label)) &&
            this.autoContinueLeft > 0
          settled = true
          if (failed && kind && retryOnFallbackAccount()) continue
          emit({
            type: 'status',
            state: failed ? 'failed' : 'done',
            toolCalls: counter.count(),
            message: failed ? (kind ? `auth:${kind}` : detail || msg.subtype) : undefined
          })
          if (silentStop) {
            this.autoContinueLeft -= 1
            emit({ type: 'text', text: '(답 없이 멈춰 자동으로 이어갑니다)' })
            followUp = `${AUTO_CONTINUE_PROMPT} 끝까지 진행하고, 끝나면 done 으로 보고해.`
          } else if (scripts && shouldLearn(prompt, runJsLog)) {
            // 성공이든 실패든, 통한 구간까지는 다음에 재생할 수 있게 스스로 저장하게 한다
            emit({
              type: 'text',
              text: '(이번에 통한 절차를 다음부터 한 번에 재생하도록 저장합니다)'
            })
            followUp = buildLearnPrompt({
              userPrompt: prompt,
              runs: runJsLog,
              steps: entry.steps,
              savedScripts: scripts
                .list()
                .map((sc) => ({ name: sc.name, description: sc.description }))
            })
          }
        }
      }
    } catch (e) {
      // 세션을 이어받으려다 시작도 못 하고 죽었으면(세션 파일 없음·다른 cwd) 연결을 지우고 새 세션으로 한 번 다시 돈다
      if (
        !abort.signal.aborted &&
        !settled &&
        resume !== undefined &&
        chatId !== undefined &&
        counter.count() === 0 &&
        sessionId === null
      ) {
        settled = true
        resumeFailed = true
        this.chatSessions?.clear(chatId)
        emit({ type: 'text', text: '(이전 세션을 이어받지 못해 새 세션으로 다시 시작합니다)' })
        followUp = prompt
      }
      // stop() 또는 result 처리에서 이미 종료 상태를 보냈으면 중복 emit 하지 않는다
      if (!abort.signal.aborted && !settled) {
        const message = e instanceof Error ? e.message : String(e)
        // 연결된 경로가 없어 멈춘 경우는 "연결 필요" 안내로 바꿔 보여 준다
        if (message === NOT_CONNECTED_ERROR) {
          emit({
            type: 'status',
            state: 'failed',
            message: 'auth:notConnected',
            toolCalls: counter.count()
          })
          return
        }
        const kind = classifyAuthError(`${message} ${apiError}`)
        if (kind && retryOnFallbackAccount()) return
        emit({
          type: 'status',
          state: 'failed',
          message: kind ? `auth:${kind}` : message,
          toolCalls: counter.count()
        })
      }
    } finally {
      releaseVaultHold()
      if (this.releaseVaultHold === releaseVaultHold) this.releaseVaultHold = null
      // 다음 지시가 이어받을 세션 id 를 대화에 남긴다(이어받기에 실패한 실행은 남기지 않는다)
      if (chatId !== undefined && sessionId !== null && !resumeFailed)
        this.chatSessions?.note(chatId, sessionId)
      // 이미 stop() 이나 다음 run() 이 상태를 가져갔으면 건드리지 않는다
      if (gen === this.generation) {
        this.abort = null
        this.markAutomationIdle()
        this.clearPending()
      }
      // 중단으로 끝났어도 그때까지의 대화는 남긴다. 저장 실패가 실행을 깨뜨리지는 않는다
      if (chatId !== undefined && this.transcript) {
        try {
          this.transcript(chatId, entry)
        } catch (e: unknown) {
          console.error('대화 기록 저장 실패', e instanceof Error ? e.message : String(e))
        }
      }
      // 이어서 돌릴 것이 있으면 이 실행이 완전히 끝난 다음(실행 상태를 비운 뒤)에 시작한다.
      // 그 사이 사용자가 새 지시를 넣었으면(세대가 바뀜) 양보한다
      const next = followUp
      if (next !== null && gen === this.generation && !abort.signal.aborted) {
        setTimeout(() => {
          if (gen !== this.generation || this.abort) return
          void this.run(next, chatId).catch(() => undefined)
        }, 0)
      }
    }
  }

  /**
   * 도구 서버에 넘길 문맥. 채팅 실행(run)과 브릿지 세션(createToolSession)이 같은 조립을 쓴다 —
   * 차이는 인자(권한 모드·확인 카드·상한)뿐이다
   */
  private buildToolContext(o: {
    s: Settings
    jobId: string
    tick: () => string | null
    emit: (e: AgentEvent) => void
    confirm: ToolContext['confirm']
    handoff: NonNullable<ToolContext['handoff']>
    onCall: (call: AgentToolCall) => void
    onRunJs: NonNullable<ToolContext['onRunJs']>
    scripts: SiteScriptStore | null
    phoneCtx: () => PhoneRunContext
    waitSms: (host?: string) => Promise<SmsCodeOutcome>
    runPay: (req: PayToolRequest) => Promise<PayResult>
    prompt: string
  }): ToolContext {
    const { s, jobId, tick, emit, scripts, phoneCtx, waitSms, runPay, prompt } = o
    const phones = this.phones
    void phoneCtx
    return {
      tabs: this.tabs,
      vault: this.vault,
      jobId,
      dangerWords: s.dangerWords,
      mode: s.permissionMode,
      finalConfirm: s.finalConfirm,
      vaultAccessPolicy: s.vaultAccessPolicy,
      vaultAutoSubmit: s.vaultAutoSubmit,
      vaultKeepSignedIn: s.vaultKeepSignedIn,
      vaultExcludedHosts: s.vaultExcludedHosts,
      tick,
      onStep: (label, ok) => emit({ type: 'step', label, ok }),
      onCall: o.onCall,
      onRunJs: o.onRunJs,
      siteMemory: this.siteMemory
        ? { remember: (host, note) => this.siteMemory?.remember(host, note) ?? '' }
        : undefined,
      scripts: scripts
        ? {
            find: (name) => scripts.find(name),
            save: (input) => scripts.save(input),
            ran: (name, ok) => scripts.ran(name, ok)
          }
        : undefined,
      playbooks: this.playbookEditor
        ? {
            list: () => this.playbookEditor?.list() ?? [],
            update: (id, instructions) =>
              this.playbookEditor?.setInstructions(id, instructions) ?? null
          }
        : undefined,
      onProgress: ({ done, total, label }) =>
        emit(
          label === undefined
            ? { type: 'progress', kind: 'task', done, total }
            : { type: 'progress', kind: 'task', done, total, label }
        ),
      confirm: o.confirm,
      handoff: o.handoff,
      phone: phones
        ? {
            phones: phones.phones,
            assigned: phones.assigned,
            mode: s.permissionMode,
            tick,
            onStep: (label, ok) => emit({ type: 'step', label, ok }),
            confirm: o.confirm,
            ...(phones.waitForSmsCode === undefined
              ? {}
              : { waitForSmsCode: (host?: string) => waitSms(host) })
          }
        : undefined,
      pay:
        phones && phones.approvePayment
          ? {
              tick,
              onStep: (label, ok) => emit({ type: 'step', label, ok }),
              run: (req) => runPay(req),
              ...(cardNamedIn(prompt) === undefined ? {} : { requiredCard: cardNamedIn(prompt) })
            }
          : undefined
    }
  }

  /**
   * 밖의 하네스가 쓰는 도구 세션. 권한은 full, 확인 카드는 자동 승인(판단은 하네스가 했다),
   * 캡차·2단계 인증 같은 넘김은 즉시 skipped 로 돌려 하네스가 needs_human 으로 처리하게 한다.
   * 채팅 실행이 도는 동안은 만들 수 없고, 세션이 있는 동안 채팅 실행은 거부된다
   */
  createToolSession(opts: {
    onStep?: (label: string, ok: boolean) => void
    /** 레인 이름(하네스가 계정마다 동시에 돌릴 때). 있으면 그 레인의 탭 보기로 일하고 다른 레인과 동시에 열린다 */
    lane?: string
  }): ToolSession {
    if (this.abort) throw new Error('이미 실행 중')
    // 레인 없는 세션은 단독이다(다른 세션·레인이 없어야 한다). 레인 세션은 레인 없는 세션만 없으면 된다
    if (this.session) throw new Error('브릿지 세션 사용 중')
    if (!opts.lane && this.laneSessions > 0) throw new Error('브릿지 세션 사용 중')
    if (this.settings.get().permissionMode === 'read_only') {
      throw new Error('읽기 전용 모드에서는 브릿지를 쓸 수 없음')
    }
    const s = this.settings.get()
    const jobId = randomUUID()
    const emit = (e: AgentEvent): void => {
      if (e.type === 'step') opts.onStep?.(e.label, e.ok)
    }
    const phones = this.phones
    const phoneCtx = (): PhoneRunContext => ({
      jobId,
      confirm: async () => true,
      onStep: (label, ok) => emit({ type: 'step', label, ok }),
      handoff: async (req) => ({ outcome: 'skipped', url: req.currentUrl() }),
      cancelled: () => false
    })
    const laneState = opts.lane ? this.laneStateOf(opts.lane) : null
    const baseCtx = this.buildToolContext({
      s: { ...s, permissionMode: 'full', finalConfirm: false },
      jobId,
      tick: () => null,
      emit,
      confirm: async () => true,
      handoff: async (req) => ({ outcome: 'skipped', url: req.currentUrl() }),
      onCall: () => {},
      onRunJs: () => {},
      scripts: this.siteScripts,
      phoneCtx,
      waitSms: (host) =>
        phones?.waitForSmsCode
          ? phones.waitForSmsCode(phoneCtx(), host)
          : Promise.resolve({ filled: false, digits: 0 }),
      runPay: (req) =>
        phones?.approvePayment
          ? phones.approvePayment(phoneCtx(), req)
          : Promise.resolve({ ok: false, reason: 'declined' as const }),
      prompt: ''
    })
    // 키패드 입력 기록은 브릿지 세션(요청 1건)을 넘어 공유한다 — 같은 결제창에 두 번 넣지 않는다
    // 브릿지 작업은 늘 뒤에서 — 사람이 보는 탭을 바꾸지 않는다
    const bridgeCtx = { ...baseCtx, keypadEntered: this.bridgeKeypadEntered, background: true }
    const server = createSambaTools(
      laneState
        ? { ...bridgeCtx, tabs: laneTabs(this.tabs, laneState) }
        : { ...bridgeCtx, tabs: labelLaneTargets(this.tabs, this.lanes) }
    )
    const tools = extractSdkTools(server).filter((t) => t.name !== 'done')
    // 브릿지 세션이 열려 있는 동안은 금고 자동 잠금을 보류한다(run() 과 같은 패턴). 두 번 풀려도 안전하다
    let releaseVaultHold: (() => void) | null = this.vault?.holdAutoLock('bridge session') ?? null
    const session: ToolSession = {
      names: () => tools.map((t) => t.name),
      call: async (name, args) => {
        const t = tools.find((x) => x.name === name)
        if (!t) throw new Error(`unknown tool: ${name}`)
        const r = await t.handler(args, {})
        return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
      },
      dispose: () => {
        if (laneState) {
          if (!disposed) {
            disposed = true
            this.laneSessions -= 1
            if (this.laneSessions === 0) this.markAutomationIdle()
          }
        } else if (this.session === session) {
          this.session = null
          this.markAutomationIdle()
        }
        releaseVaultHold?.()
        releaseVaultHold = null
      }
    }
    let disposed = false
    if (laneState) this.laneSessions += 1
    else this.session = session
    return session
  }

  /**
   * Codex CLI 백엔드로 1건을 실행한다. samba 도구는 인프로세스 MCP 라 붙지 않으므로
   * 이 경로는 텍스트 응답(그리고 codex 자신이 쓴 도구 흔적)만 화면에 올린다.
   * 종료 상태를 보냈으면 true 를 돌려준다
   */
  private async runOnCodex(
    input: CodexInput,
    deduper: ReturnType<typeof createTextDeduper>,
    emit: (e: AgentEvent) => void
  ): Promise<boolean> {
    let lastError = ''
    for await (const event of runCodexQuery(input)) {
      if (input.abort.signal.aborted) return false
      if (event.type === 'text') {
        const text = deduper.accept(event.text)
        if (text) emit({ type: 'text', text })
      } else if (event.type === 'step') {
        emit({ type: 'step', label: event.label, ok: event.ok })
      } else if (event.type === 'error') {
        lastError = event.message
      } else {
        const message = event.ok ? undefined : event.message || lastError
        const kind = message ? classifyAuthError(message) : null
        emit({
          type: 'status',
          state: event.ok ? 'done' : 'failed',
          toolCalls: 0,
          message: event.ok ? undefined : kind ? `auth:${kind}` : message
        })
        return true
      }
    }
    return false
  }
}
