import type { PhoneAccountLink, PhoneRegistryEntry } from './phone-registry'
import { z } from 'zod'
import {
  AI_PROVIDERS,
  upgradeModelId,
  type AiConnections,
  type AiProviderId,
  type TaskModels
} from './ai'
import { DEFAULT_DANGER_WORDS, mergeDangerWords } from './danger'
import { EXTENSION_SOURCES, type ExtensionSource } from './extensions'
import { defaultMouseGestures, GESTURE_ACTIONS } from './gestures'
import { type ScreenFps, type ScreenSize } from './phone'
import { DEFAULT_TRANSLATE_LANG, TRANSLATE_LANGS, type TranslateLang } from './translate'
import {
  CAPTURE_FORMATS,
  CAPTURE_MODES,
  DEFAULT_CAPTURE_SHORTCUTS,
  mergeCaptureShortcuts,
  type CaptureFormat,
  type CaptureShortcuts
} from './capture'
import { isDiscordWebhook, isSlackWebhook, isTelegramChatId, isTelegramToken } from './notify'
import { isSupabaseAnonKey, isSupabaseProjectUrl } from './sync'
import { isHttpUrl, isInternalUrl, NEW_TAB_URL } from './url'
import { playbookListSchema, type PlaybookDto } from './playbook'
import { RECOMMEND_MAX, type DismissedRecommendation } from './activity-patterns'

// 도구 호출 상한 허용 범위
export const MIN_TOOL_CALLS = 1
// 계정 두 개로 주문서를 각각 만들어 원가를 비교하면 한 건에 200회를 넘긴다
export const MAX_TOOL_CALLS = 400

// 오른쪽 패널 폭 허용 범위
// 패널 폭 한계(렌더러 uiStore 와 공유)
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 420
export const MIN_PANEL_WIDTH = 280
export const MAX_PANEL_WIDTH = 900

// 자동 잠금 대기 시간(분) 허용 범위. 상한(43200 = 30일)은 "안 함"에 해당하는 매우 긴 시간이다
export const MIN_VAULT_AUTO_LOCK_MINUTES = 1
export const MAX_VAULT_AUTO_LOCK_MINUTES = 43200

// 키마스터 AI 에이전트 접근 정책: 항상 허용 · 잠금 해제 중에만 허용 · 절대 허용 안 함
export const VAULT_ACCESS_POLICIES = ['always', 'while_unlocked', 'never'] as const
export type VaultAccessPolicy = (typeof VAULT_ACCESS_POLICIES)[number]

// 화면 테마: 시스템 따라감 · 밝게 · 어둡게
export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

// 화면 확대 비율(%) 허용 범위
export const MIN_UI_ZOOM = 80
export const MAX_UI_ZOOM = 150

// 사용 권한 모드: 읽기 전용(read_only) · 위험 행동 확인(guard) · 자동(full)
export const PERMISSION_MODES = ['read_only', 'guard', 'full'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

// 에이전트 추론 강도(Aside 하단 "Fable 5.1 High ▾" 와 같은 개념).
// Claude Agent SDK 의 effort 옵션 값과 같은 문자열을 쓴다
export const AGENT_EFFORTS = ['low', 'medium', 'high'] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]

// 사이드바 접힘 폭(아이콘만 보이는 폭)
export const SIDEBAR_COLLAPSED_WIDTH = 56

// 사이드바 안에서 따로 접을 수 있는 섹션들
export const SIDEBAR_SECTION_KEYS = ['tabs', 'chat', 'bookmarks'] as const
export type SidebarSectionKey = (typeof SIDEBAR_SECTION_KEYS)[number]
export type SidebarSections = Record<SidebarSectionKey, boolean>

// === 홈/새 탭/검색엔진 설정 (신규 추가분) ==================================
// 새 탭 주소: 'home' 이면 홈 주소를 따르고, 'blank' 면 빈 페이지로 연다
export const NEW_TAB_URL_MODES = ['home', 'blank'] as const
export type NewTabUrlMode = (typeof NEW_TAB_URL_MODES)[number]

// 기본 검색엔진 — 주소창에 검색어를 입력했을 때 사용
export const SEARCH_ENGINES = ['google', 'naver'] as const
export type SearchEngine = (typeof SEARCH_ENGINES)[number]
// === 신규 추가분 끝 =========================================================

export const DEFAULT_SETTINGS = {
  model: 'sonnet' as const,
  language: 'ko' as const,
  panelWidth: 380,
  // 왼쪽 환경 탭(사이드바) 폭. 기기별 값이라 동기화하지 않는다
  sidebarWidth: 232,
  lastUrl: NEW_TAB_URL,
  dangerWords: DEFAULT_DANGER_WORDS,
  // 한 작업에서 허용하는 도구 호출 수. 주문 흐름(로그인→검색→옵션→장바구니→주문서→쿠폰→
  // 결제수단 비교)은 120회로도 계정 비교 도중에 끊겼다(실기). 200회로 잡는다(상한은 MAX_TOOL_CALLS)
  maxToolCalls: 200,
  permissionMode: 'guard' as const,
  finalConfirm: false,
  // Aside 방식: 자동 잠금 기본 1주(10080분), 이 PC 에서 기억 기본 켬
  vaultAutoLockMinutes: 10080,
  vaultRememberDevice: true,
  // AI 작업·예약 실행이 도는 동안에는 자동 잠금을 보류한다(기본 켬).
  // 몇 시간짜리 작업 중간에 금고가 잠겨 로그인 도구가 실패하는 것을 막는다.
  // 기기마다 다르게 두고 싶은 값이라 SYNCED_SETTING_KEYS 에 넣지 않는다
  vaultHoldLockDuringAgent: true,
  vaultAccessPolicy: 'while_unlocked' as const,
  vaultAutoSubmit: true,
  // 로그인 폼의 "로그인 상태 유지" 체크박스를 자동으로 켤지(세션 재사용 → 캡차 감소)
  vaultKeepSignedIn: true,
  // [사용 안 함 — 2026-09-27 부터 vaultAutoSaveLogins 가 대신한다] 예전 "묻지 않고 비밀번호 자동 갱신" 설정.
  // 기본이 켜짐이라 무확인 저장이 됐다. 저장 파일·동기화 호환을 위해 키만 남긴다
  vaultAutoUpdatePassword: true,
  // 로그인 성공 뒤 새 계정·바뀐 비밀번호를 묻지 않고 바로 키마스터에 저장·수정할지(기본 켬 — 저장 뒤
  // '키마스터에 저장됨 [되돌리기]' 알림만 띄운다. 끄면 주소창 아래 확인 바로 묻는다)
  vaultAutoSaveLogins: true,
  // vaultAutoSaveLogins 기본값을 켬으로 바꾼 1회 마이그레이션(2026-09-27)을 마쳤는가.
  // 기기 전용 값이라 동기화하지 않는다(SYNCED_SETTING_KEYS 에 넣지 않는다).
  // 기본은 켬(=마쳤음) — 새 설치는 이미 새 기본값이라 옮길 게 없다. 이 키가 없는 예전 저장 파일만
  // migrateSettingsFile 이 원본 JSON 을 보고 한 번 옮긴다
  vaultAutoSaveLoginsMigrated: true,
  // 저장 제안을 띄우지 않을 사이트(등록 도메인). 확인 바의 '이 사이트는 묻지 않기'가 여기에 더한다.
  // 제외 도메인(vaultExcludedHosts)과 달리 자동 채움은 그대로 쓴다
  vaultNeverSaveHosts: [] as string[],
  // 계정 선택기에서 계정을 고르면 로그인 버튼까지 눌러 준다
  autofillAutoSubmit: true,
  vaultExcludedHosts: [] as string[],
  // === 홈/새 탭/검색엔진 기본값 (신규 추가분) ===============================
  // 로컬 OCR(ocr 도구) 사용 여부. 첫 사용 시 모델(약 18MB)을 내려받는다
  ocrEnabled: true,
  // 기본 홈 주소는 자체 새 탭 페이지. 사용자가 config.json 에 저장해 둔 값이 있으면 그대로 유지된다
  homeUrl: NEW_TAB_URL,
  newTabUrl: 'home' as const,
  searchEngine: 'google' as const,
  // === 신규 추가분 끝 =======================================================
  // === AI 연결 / 에이전트 / 작업공간 (2b 추가분) ============================
  // AI 연결 경로와 작업별 모델
  aiProvider: 'claude_subscription' as AiProviderId,
  // 구독 연결 상태(기기 로컬 — 동기화하지 않는다).
  // 자격 파일이 있어도 connected 가 아니면 에이전트는 그 경로를 쓰지 않는다
  aiConnections: {
    claude: { connected: false },
    codex: { connected: false }
  } as AiConnections,
  // 기존 사용자 승계(구독으로 이미 쓰고 있던 상태 → connected)를 한 번만 하기 위한 표식
  aiConnectionsMigrated: false,
  taskModels: {
    fast: 'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-5-5',
    deep: 'claude-opus-5-5',
    visual: 'claude-sonnet-5-5'
  } as TaskModels,
  // 에이전트 동작
  agentNotify: true,
  agentSound: false,
  // === 하네스 브릿지 ==========================================================
  // 밖의 LangGraph 하네스가 이 앱의 도구를 HTTP 로 부르게 여는 문. 기본 꺼짐.
  // 포트·토큰은 이 PC 의 값이라 동기화하지 않는다(SYNCED_SETTING_KEYS 에 없음)
  bridgeEnabled: false,
  bridgePort: 47811,
  // 32바이트 hex. 비어 있으면 켤 때 만든다
  bridgeToken: '',
  // 밖에서 도는 하네스(samba-agent)의 읽기 API 주소. 자동화 페이지의 흐름 그래프·판정 카드가 읽는다.
  // 로컬 전용이라 127.0.0.1(또는 localhost) 만 허용한다 — 이 PC 값이라 동기화하지 않는다
  harnessApiUrl: 'http://127.0.0.1:47812',
  // 에이전트가 연 탭을 몇 분 뒤 정리할지(0 이면 정리 안 함)
  agentTabCleanupMinutes: 15,
  // 작업공간(기기 로컬 — 동기화하지 않는다)
  activeWorkspaceId: 0,
  // 확장 폴더 경로(로컬 전용)
  extensionPaths: [] as string[],
  // 확장 경로별 출처(스토어/가져옴/폴더). 기록이 없으면 'folder' 로 본다
  extensionSources: {} as Record<string, ExtensionSource>,
  // 꺼 둔 확장의 id. 목록·경로는 그대로 두고 세션에만 올리지 않는다
  disabledExtensionIds: [] as string[],
  // 확장별로 올릴 프로필. 적혀 있지 않은 확장은 모든 프로필에 올린다. 빈 목록이면 일반 탭(default)에만,
  // 이름이 있으면 일반 탭 + 그 프로필에만 올린다. 삼바웨이브 확장은 삼바 페이지에서 설정을 받으므로
  // 그 페이지를 열지 않는 계정 프로필에서는 API 호출이 전부 실패한다(실기 2026-09-28) — 기본은 일반 탭만
  extensionProfiles: { ojfcneljbbajgcmpmklgglhenieehicb: [] } as Record<string, string[]>,
  // 주소창 툴바에 고정한 확장의 id(왼쪽부터 이 순서대로 놓인다).
  // 툴바를 이 기기에서 어떻게 보여 줄지에 대한 값이라 동기화하지 않는다
  extensionsPinned: [] as string[],
  // 담당 폰이 정해지지 않은 계정이 쓸 기본 폰의 serial. 비우면 예전처럼 연결된 첫 폰(결제는 결제 앱이 깔린 폰).
  // 다른 작업 전용 폰이 같이 붙어 있을 때 결제·문자가 그 폰으로 가지 않게 한다(사용자 2026-09-29 "모든 건 담당 폰")
  defaultPhoneSerial: '',
  // 모양(기기 로컬 — 동기화하지 않는다)
  theme: 'system' as ThemeMode,
  uiZoom: 100,
  sidebarShowBookmarks: true,
  sidebarShowChat: true,
  // 사이드바 접기(아이콘 폭) 여부와 섹션별 펼침 상태 — 기기 로컬이라 동기화하지 않는다
  sidebarCollapsed: false,
  // 오른쪽 AI 패널 접힘(기기 로컬)
  panelCollapsed: false,
  sidebarSections: { tabs: true, chat: true, bookmarks: true } as SidebarSections,
  // 에이전트 추론 강도(채팅 입력줄에서 고른다). 기기 간 같은 값을 쓰도록 동기화한다
  agentEffort: 'medium' as AgentEffort,
  // === 2b 추가분 끝 =========================================================
  // === 폰 연동(3단계 추가분) ================================================
  // adb/scrcpy 실행 파일 경로. 빈 문자열이면 설정 화면의 "자동 찾기" 를 안내한다
  adbPath: '',
  scrcpyPath: '',
  // 폰 화면 품질(긴 변 픽셀 · 초당 프레임)
  phoneScreenMaxSize: 720 as ScreenSize,
  phoneScreenFps: 15 as ScreenFps,
  // 끊겼을 때 kill-server/start-server 로 1회 자동 복구할지
  phoneAutoReconnect: true,
  // 사용자가 목록에서 지운 폰의 시리얼. 같은 와이파이에 있으면 5초 검색이 다시 찾아오므로 여기 적어 건너뛴다.
  // 주소 연결·페어링을 직접 하면 비운다. 이 PC 의 사정이라 SYNCED_SETTING_KEYS 에 넣지 않는다
  phoneIgnoredSerials: [] as string[],
  // 이 PC 에 붙은 폰을 다른 PC 가 쓰게 adb 서버를 LAN 에 연다(phone/relay.ts). 이 PC 의 사정이라 동기화하지 않는다
  phoneRelayEnabled: false,
  // 인터넷 너머 중계 브로커(삼바웨이브 API 의 WebSocket, 예: wss://api.samba-wave.co.kr/api/v1/samba/phone-relay).
  // 계정 전체가 같은 브로커를 써야 하므로 동기화한다. 비어 있으면 같은 LAN 의 adb 원격 서버만 쓴다
  phoneRelayBrokerUrl: '',
  // 이 PC 가 중계 방을 여는 데 쓰는 방 id·열쇠('room:key'). 다른 PC 는 등록 정보(relayHost)로 받는다 — 동기화하지 않는다
  phoneRelayRoom: '',
  // 폰 연동 동기화(phone-registry.ts) — 폰 목록과 계정↔담당 폰. 폰 표(로컬)의 사본이라 화면에서 직접 고치지 않는다
  // 키마스터 기준 시각(ms) — "이 시각에 이 PC 의 키마스터가 기준"이라는 선언(sync/authority.ts).
  // 다른 PC 는 이보다 앞선 자기 삭제 기록·안 올린 행을 버리고 서버 내용을 그대로 받는다. 0 이면 선언 없음
  keymasterBaselineAt: 0,
  phoneRegistry: [] as PhoneRegistryEntry[],
  phoneAccountLinks: [] as PhoneAccountLink[],
  // 결제 비밀번호 키패드 배치를 외부 AI(Visual)에게 물어볼지.
  // 켜면 키패드 화면 원본이 AI 제공자로 전송되므로 기본은 꺼짐이고,
  // 꺼져 있으면 UI 트리로 못 읽은 키패드는 사람에게 넘긴다
  phoneKeypadVisual: false,
  // === 폰 연동 끝 ===========================================================
  // === 마우스 제스처 ========================================================
  // 오른쪽 버튼 드래그 제스처 사용 여부와 시퀀스→동작 매핑(웨일 기본값 16종)
  mouseGesturesEnabled: true,
  mouseGestures: defaultMouseGestures(),
  // === 마우스 제스처 끝 =====================================================
  // === 번역(화면·이미지) ====================================================
  // 번역 결과의 기본 대상 언어
  translateTargetLang: DEFAULT_TRANSLATE_LANG as TranslateLang,
  // 열자마자 자동으로 번역할 도메인 목록(정규화된 host 문자열)
  translateAutoDomains: [] as string[],
  // === 번역 끝 ==============================================================
  // === 사진·영상 캡처(3단계 추가분) =========================================
  // 저장 폴더. 빈 문자열이면 메인이 `다운로드/SAMBA 캡처` 를 만들어 쓴다(기기별 값)
  captureDir: '',
  captureFormat: 'png' as CaptureFormat,
  // 영상 녹화에 마이크 소리를 함께 담을지
  captureMicrophone: false,
  // 이미지 저장 직후 클립보드에도 복사할지
  captureCopyToClipboard: false,
  // 캡처 단축키 표(설정에서 바꿀 수 있다)
  captureShortcuts: { ...DEFAULT_CAPTURE_SHORTCUTS } as CaptureShortcuts,
  // === 캡처 끝 ==============================================================
  // === 자동화 플레이북 ======================================================
  // 저장된 플레이북 전체(JSON 배열). 비어 있으면 저장소가 내장 플레이북을 채워 준다.
  // 표를 따로 만들지 않고 설정 한 칸에 담아 기존 설정 동기화 경로를 그대로 탄다
  playbooks: [] as PlaybookDto[],
  // === 자동화 플레이북 끝 ===================================================
  // === 활동 기록·추천(기기 로컬) ============================================
  // 활동 기록은 이 PC 에서 일어난 일이고 파일도 userData 안에만 있다 —
  // SYNCED_SETTING_KEYS 에 넣지 않는다(다른 PC 의 기록과 섞이면 판정이 뒤틀린다)
  activityRecording: true,
  // 사이트 기억 — 성공한 경로·메모를 이 PC 의 파일(userData/site-memory.json)에만 남긴다.
  // 관찰 결과는 이 PC 의 사실이고 서버로 나갈 이유도 없어 SYNCED_SETTING_KEYS 에 넣지 않는다
  siteMemoryEnabled: true,
  // 사용자가 [숨기기] 를 누른 추천 후보. 30일이 지나면 다시 나타난다
  dismissedRecommendations: [] as DismissedRecommendation[],
  // === 활동 기록·추천 끝 ====================================================
  // === Supabase 연결(기기 로컬) =============================================
  // 설정 → 계정에서 사용자가 자기 Supabase 프로젝트를 붙여넣는 자리.
  // 기기마다 다를 수 있고 서버에 올릴 이유도 없어 SYNCED_SETTING_KEYS 에 넣지 않는다.
  // anonKey 는 공개용 publishable 키다 — service_role 키는 저장 단계에서 거른다
  syncSupabaseUrl: '',
  syncSupabaseAnonKey: '',
  // === Supabase 연결 끝 =====================================================
  // === 알림 연동(기기 로컬) =================================================
  // 작업이 끝나거나 사람 확인이 필요할 때 메신저로 알린다.
  // 웹훅 주소·봇 토큰은 이 PC 의 비밀이라 SYNCED_SETTING_KEYS 에 넣지 않는다 —
  // 다른 PC 로 올려 보낼 이유가 없고, 새는 경로를 하나라도 줄이는 쪽이 낫다
  notifySlackEnabled: false,
  notifySlackWebhook: '',
  notifyDiscordEnabled: false,
  notifyDiscordWebhook: '',
  notifyTelegramEnabled: false,
  notifyTelegramToken: '',
  notifyTelegramChatId: '',
  // 사건별 켬/끔(완료·실패·확인 필요). 기본은 셋 다 켬
  notifyOnDone: true,
  notifyOnFailed: true,
  notifyOnAttention: true
  // === 알림 연동 끝 =========================================================
}

// 구독 연결 기록 한 칸. account 는 화면 표시용 문자열뿐이고 토큰은 담지 않는다
const aiConnectionSchema = z
  .object({
    connected: z.boolean().catch(false),
    account: z.string().optional().catch(undefined),
    connectedAt: z.number().optional().catch(undefined)
  })
  .catch({ connected: false })

// 손상된 config.json 이어도 앱이 뜨도록 필드마다 catch 로 기본값으로 되돌린다
export const settingsSchema = z.object({
  model: z.enum(['sonnet', 'opus', 'haiku']).catch(DEFAULT_SETTINGS.model),
  language: z.enum(['ko', 'en']).catch(DEFAULT_SETTINGS.language),
  panelWidth: z
    .number()
    .min(MIN_PANEL_WIDTH)
    .max(MAX_PANEL_WIDTH)
    .catch(DEFAULT_SETTINGS.panelWidth),
  sidebarWidth: z
    .number()
    .min(MIN_SIDEBAR_WIDTH)
    .max(MAX_SIDEBAR_WIDTH)
    .catch(DEFAULT_SETTINGS.sidebarWidth),
  lastUrl: z.string().min(1).catch(DEFAULT_SETTINGS.lastUrl),
  dangerWords: z.array(z.string()).catch([]),
  maxToolCalls: z.number().catch(DEFAULT_SETTINGS.maxToolCalls),
  permissionMode: z.enum(PERMISSION_MODES).catch(DEFAULT_SETTINGS.permissionMode),
  finalConfirm: z.boolean().catch(DEFAULT_SETTINGS.finalConfirm),
  // 금고 미사용 자동 잠금(분). 손상된 값은 기본 1주(10080분)로 되돌린다
  vaultAutoLockMinutes: z
    .number()
    .int()
    .min(MIN_VAULT_AUTO_LOCK_MINUTES)
    .max(MAX_VAULT_AUTO_LOCK_MINUTES)
    .catch(DEFAULT_SETTINGS.vaultAutoLockMinutes),
  // 이 PC 에서 마스터 키를 safeStorage 로 감싸 기억할지 여부
  vaultRememberDevice: z.boolean().catch(DEFAULT_SETTINGS.vaultRememberDevice),
  // AI 작업 중 자동 잠금 보류 여부
  vaultHoldLockDuringAgent: z.boolean().catch(DEFAULT_SETTINGS.vaultHoldLockDuringAgent),
  // 키마스터 AI 에이전트 접근 정책
  vaultAccessPolicy: z.enum(VAULT_ACCESS_POLICIES).catch(DEFAULT_SETTINGS.vaultAccessPolicy),
  // 자동 채움 후 자동 제출 여부
  vaultAutoSubmit: z.boolean().catch(DEFAULT_SETTINGS.vaultAutoSubmit),
  // 로그인 상태 유지 체크박스 자동 체크 여부
  vaultKeepSignedIn: z.boolean().catch(DEFAULT_SETTINGS.vaultKeepSignedIn),
  // 로그인 성공 감지 시 비밀번호 자동 갱신 여부(끄면 기존 "갱신할까요?" 프롬프트로 동작)
  vaultAutoUpdatePassword: z.boolean().catch(DEFAULT_SETTINGS.vaultAutoUpdatePassword),
  // 묻지 않고 자동 저장(기본 켬)
  vaultAutoSaveLogins: z.boolean().catch(DEFAULT_SETTINGS.vaultAutoSaveLogins),
  vaultAutoSaveLoginsMigrated: z.boolean().catch(DEFAULT_SETTINGS.vaultAutoSaveLoginsMigrated),
  // 저장 제안을 띄우지 않을 사이트. 손상된 값은 빈 배열로 되돌린다
  vaultNeverSaveHosts: z.array(z.string()).catch(DEFAULT_SETTINGS.vaultNeverSaveHosts),
  // 제외 도메인(정규화된 host 문자열 목록). 손상된 값은 빈 배열로 되돌린다
  autofillAutoSubmit: z.boolean().catch(DEFAULT_SETTINGS.autofillAutoSubmit),
  vaultExcludedHosts: z.array(z.string()).catch(DEFAULT_SETTINGS.vaultExcludedHosts),
  // === 홈/새 탭/검색엔진 (신규 추가분) =======================================
  // 홈 주소. http/https 나 내부 페이지(samba://newtab)가 아니면 기본값으로 되돌린다
  // 로컬 OCR 사용 여부
  ocrEnabled: z.boolean().catch(DEFAULT_SETTINGS.ocrEnabled),
  homeUrl: z
    .string()
    .refine((v) => isHttpUrl(v) || isInternalUrl(v))
    .catch(DEFAULT_SETTINGS.homeUrl),
  newTabUrl: z.enum(NEW_TAB_URL_MODES).catch(DEFAULT_SETTINGS.newTabUrl),
  searchEngine: z.enum(SEARCH_ENGINES).catch(DEFAULT_SETTINGS.searchEngine),
  // === 신규 추가분 끝 =========================================================
  // === AI 연결 / 에이전트 / 작업공간 (2b 추가분) ==============================
  aiProvider: z.enum(AI_PROVIDERS).catch(DEFAULT_SETTINGS.aiProvider),
  // 연결 기록이 깨졌으면 "미연결"로 되돌린다 — 의심스러우면 쓰지 않는 쪽이 안전하다
  aiConnections: z
    .object({
      claude: aiConnectionSchema,
      codex: aiConnectionSchema
    })
    .catch(DEFAULT_SETTINGS.aiConnections),
  aiConnectionsMigrated: z.boolean().catch(DEFAULT_SETTINGS.aiConnectionsMigrated),
  taskModels: z
    .object({
      fast: z.string(),
      standard: z.string(),
      deep: z.string(),
      visual: z.string()
    })
    // 저장된 옛 모델 ID(Opus 5·Sonnet 5)는 최신(5.5)으로 올려 읽는다
    .transform((m) => ({
      fast: upgradeModelId(m.fast),
      standard: upgradeModelId(m.standard),
      deep: upgradeModelId(m.deep),
      visual: upgradeModelId(m.visual)
    }))
    .catch(DEFAULT_SETTINGS.taskModels),
  agentNotify: z.boolean().catch(DEFAULT_SETTINGS.agentNotify),
  agentSound: z.boolean().catch(DEFAULT_SETTINGS.agentSound),
  bridgeEnabled: z.boolean().catch(DEFAULT_SETTINGS.bridgeEnabled),
  bridgePort: z.number().int().min(1024).max(65535).catch(DEFAULT_SETTINGS.bridgePort),
  bridgeToken: z.string().max(128).catch(DEFAULT_SETTINGS.bridgeToken),
  harnessApiUrl: z.string().max(200).catch(DEFAULT_SETTINGS.harnessApiUrl),
  agentTabCleanupMinutes: z.number().int().min(0).catch(DEFAULT_SETTINGS.agentTabCleanupMinutes),
  activeWorkspaceId: z.number().int().min(0).catch(DEFAULT_SETTINGS.activeWorkspaceId),
  extensionPaths: z.array(z.string()).catch(DEFAULT_SETTINGS.extensionPaths),
  extensionSources: z
    .record(z.string(), z.enum(EXTENSION_SOURCES))
    .catch(DEFAULT_SETTINGS.extensionSources),
  disabledExtensionIds: z.array(z.string()).catch(DEFAULT_SETTINGS.disabledExtensionIds),
  extensionProfiles: z
    .record(z.string(), z.array(z.string()))
    .catch(DEFAULT_SETTINGS.extensionProfiles),
  extensionsPinned: z.array(z.string()).catch(DEFAULT_SETTINGS.extensionsPinned),
  defaultPhoneSerial: z.string().catch(DEFAULT_SETTINGS.defaultPhoneSerial),
  // 모양 — 범위를 벗어나거나 타입이 틀리면 기본값으로 되돌린다
  theme: z.enum(THEME_MODES).catch(DEFAULT_SETTINGS.theme),
  uiZoom: z.number().int().min(MIN_UI_ZOOM).max(MAX_UI_ZOOM).catch(DEFAULT_SETTINGS.uiZoom),
  sidebarShowBookmarks: z.boolean().catch(DEFAULT_SETTINGS.sidebarShowBookmarks),
  sidebarShowChat: z.boolean().catch(DEFAULT_SETTINGS.sidebarShowChat),
  sidebarCollapsed: z.boolean().catch(DEFAULT_SETTINGS.sidebarCollapsed),
  panelCollapsed: z.boolean().catch(DEFAULT_SETTINGS.panelCollapsed),
  // 섹션 중 하나만 망가져도 그 칸만 기본값(펼침)으로 되돌린다
  sidebarSections: z
    .object({
      tabs: z.boolean().catch(true),
      chat: z.boolean().catch(true),
      bookmarks: z.boolean().catch(true)
    })
    .catch(DEFAULT_SETTINGS.sidebarSections),
  agentEffort: z.enum(AGENT_EFFORTS).catch(DEFAULT_SETTINGS.agentEffort),
  // === 2b 추가분 끝 ===========================================================
  // === 폰 연동(3단계 추가분) — 경로는 기기별 값이라 동기화하지 않는다 ==========
  adbPath: z.string().catch(DEFAULT_SETTINGS.adbPath),
  scrcpyPath: z.string().catch(DEFAULT_SETTINGS.scrcpyPath),
  phoneScreenMaxSize: z
    .union([z.literal(720), z.literal(1080)])
    .catch(DEFAULT_SETTINGS.phoneScreenMaxSize),
  phoneScreenFps: z
    .union([z.literal(10), z.literal(15), z.literal(30)])
    .catch(DEFAULT_SETTINGS.phoneScreenFps),
  phoneAutoReconnect: z.boolean().catch(DEFAULT_SETTINGS.phoneAutoReconnect),
  phoneIgnoredSerials: z.array(z.string().max(120)).max(50).catch([]),
  phoneRelayEnabled: z.boolean().catch(false),
  phoneRelayBrokerUrl: z.string().max(300).catch(''),
  phoneRelayRoom: z.string().max(200).catch(''),
  keymasterBaselineAt: z.number().int().min(0).catch(0),
  phoneRegistry: z
    .array(
      z.object({
        serial: z.string().min(1).max(120),
        label: z.string().max(80),
        country: z.enum(['KR', 'CN', 'JP']).catch('KR'),
        transport: z.enum(['usb', 'wifi', 'relay']).catch('usb'),
        wifiAddress: z.string().max(120).nullable().catch(null),
        model: z.string().max(80).catch(''),
        isDefault: z.boolean().catch(false),
        relayHost: z.string().max(200).nullable().optional().catch(null)
      })
    )
    .max(50)
    .catch([]),
  phoneAccountLinks: z
    .array(z.object({ account: z.string().min(1).max(80), serial: z.string().min(1).max(120) }))
    .max(2000)
    .catch([]),
  phoneKeypadVisual: z.boolean().catch(DEFAULT_SETTINGS.phoneKeypadVisual),
  // === 폰 연동 끝 =============================================================
  // === 마우스 제스처 ==========================================================
  mouseGesturesEnabled: z.boolean().catch(DEFAULT_SETTINGS.mouseGesturesEnabled),
  // 알 수 없는 동작 이름이 섞이면 표 전체를 기본값으로 되돌린다(부분 손상 방지)
  mouseGestures: z.record(z.string(), z.enum(GESTURE_ACTIONS)).catch(() => defaultMouseGestures()),
  // === 마우스 제스처 끝 =======================================================
  // === 번역 — 손상된 값은 기본 언어·빈 목록으로 되돌린다 ======================
  translateTargetLang: z.enum(TRANSLATE_LANGS).catch(DEFAULT_SETTINGS.translateTargetLang),
  translateAutoDomains: z.array(z.string()).catch(DEFAULT_SETTINGS.translateAutoDomains),
  // === 번역 끝 ================================================================
  // === 사진·영상 캡처 — 기기별 값이라 동기화하지 않는다 ========================
  captureDir: z.string().catch(DEFAULT_SETTINGS.captureDir),
  captureFormat: z.enum(CAPTURE_FORMATS).catch(DEFAULT_SETTINGS.captureFormat),
  captureMicrophone: z.boolean().catch(DEFAULT_SETTINGS.captureMicrophone),
  captureCopyToClipboard: z.boolean().catch(DEFAULT_SETTINGS.captureCopyToClipboard),
  // 표기가 깨진 항목만 기본 단축키로 되돌린다(전체를 버리지 않는다)
  captureShortcuts: z
    .record(z.enum(CAPTURE_MODES), z.string())
    .catch({ ...DEFAULT_CAPTURE_SHORTCUTS })
    .transform((v): CaptureShortcuts => mergeCaptureShortcuts(v)),
  // === 캡처 끝 ================================================================
  // === 자동화 플레이북 — 한 칸이라도 깨지면 목록 전체를 비운다(저장소가 내장을 다시 채운다) ===
  playbooks: playbookListSchema.catch(() => []),
  // === 활동 기록·추천 — 깨진 값은 통째로 비운다(기록은 복구할 가치가 낮다) ====
  activityRecording: z.boolean().catch(DEFAULT_SETTINGS.activityRecording),
  siteMemoryEnabled: z.boolean().catch(DEFAULT_SETTINGS.siteMemoryEnabled),
  dismissedRecommendations: z
    .array(z.object({ key: z.string().min(1).max(400), at: z.number() }))
    // 후보 자체가 한 번에 몇 개뿐이라 숨김도 이만큼이면 넉넉하다
    .max(RECOMMEND_MAX * 20)
    .catch(() => []),
  // === Supabase 연결 — 형식이 어긋난 값은 빈 문자열로 되돌린다 ================
  syncSupabaseUrl: z
    .string()
    .catch(DEFAULT_SETTINGS.syncSupabaseUrl)
    .transform((v) => (isSupabaseProjectUrl(v) ? v.trim() : '')),
  syncSupabaseAnonKey: z
    .string()
    .catch(DEFAULT_SETTINGS.syncSupabaseAnonKey)
    .transform((v) => (isSupabaseAnonKey(v) ? v.trim() : '')),
  // === Supabase 연결 끝 =======================================================
  // === 알림 연동 — 형식이 어긋난 주소·토큰은 빈 문자열로 되돌린다 =============
  notifySlackEnabled: z.boolean().catch(DEFAULT_SETTINGS.notifySlackEnabled),
  notifySlackWebhook: z
    .string()
    .catch(DEFAULT_SETTINGS.notifySlackWebhook)
    .transform((v) => (isSlackWebhook(v) ? v.trim() : '')),
  notifyDiscordEnabled: z.boolean().catch(DEFAULT_SETTINGS.notifyDiscordEnabled),
  notifyDiscordWebhook: z
    .string()
    .catch(DEFAULT_SETTINGS.notifyDiscordWebhook)
    .transform((v) => (isDiscordWebhook(v) ? v.trim() : '')),
  notifyTelegramEnabled: z.boolean().catch(DEFAULT_SETTINGS.notifyTelegramEnabled),
  notifyTelegramToken: z
    .string()
    .catch(DEFAULT_SETTINGS.notifyTelegramToken)
    .transform((v) => (isTelegramToken(v) ? v.trim() : '')),
  notifyTelegramChatId: z
    .string()
    .catch(DEFAULT_SETTINGS.notifyTelegramChatId)
    .transform((v) => (isTelegramChatId(v) ? v.trim() : '')),
  notifyOnDone: z.boolean().catch(DEFAULT_SETTINGS.notifyOnDone),
  notifyOnFailed: z.boolean().catch(DEFAULT_SETTINGS.notifyOnFailed),
  notifyOnAttention: z.boolean().catch(DEFAULT_SETTINGS.notifyOnAttention)
  // === 알림 연동 끝 ===========================================================
})

export type Settings = z.infer<typeof settingsSchema>

// 새 탭·첫 탭이 열 주소. 'blank' 면 빈 페이지, 아니면 홈 주소(기본값은 자체 새 탭 페이지)
export function defaultTabUrl(s: Pick<Settings, 'newTabUrl' | 'homeUrl'>): string {
  return s.newTabUrl === 'blank' ? 'about:blank' : s.homeUrl
}

export function clampToolCalls(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.maxToolCalls
  return Math.min(MAX_TOOL_CALLS, Math.max(MIN_TOOL_CALLS, Math.round(n)))
}

// 임의의 입력(파일 내용·IPC 패치 결과)을 항상 유효한 Settings 로 만든다
/**
 * 저장 파일(원본 JSON)에 1회 마이그레이션을 건다(순수 함수). 바꿀 게 없으면 null.
 * - 2026-09-27: 로그인 자격증명 '묻지 않고 자동 저장'을 기본 켬으로 바꿨다. 예전 기본값(꺼짐)이 저장된 파일도
 *   한 번만 켬으로 옮긴다. 옮긴 뒤 사용자가 다시 끄면 그 값을 존중한다(플래그가 남아 다시 바꾸지 않는다)
 */
export function migrateSettingsFile(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.vaultAutoSaveLoginsMigrated === true) return null
  return { ...obj, vaultAutoSaveLogins: true, vaultAutoSaveLoginsMigrated: true }
}

export function parseSettings(input: unknown): Settings {
  const r = settingsSchema.safeParse(input)
  const v = r.success ? r.data : { ...DEFAULT_SETTINGS }
  return {
    ...v,
    // 위험 단어는 기본 목록과의 합집합이라 사용자가 비워도 보호가 유지된다
    dangerWords: mergeDangerWords(v.dangerWords),
    maxToolCalls: clampToolCalls(v.maxToolCalls)
  }
}
