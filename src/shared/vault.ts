// 금고(vault) 공용 DTO — 메인·프리로드·렌더러가 함께 쓴다.
// 여기 정의된 어떤 타입에도 비밀값(평문) 필드는 존재하지 않는다.
// 평문은 오직 vault:reveal 응답(string)으로만 렌더러에 전달된다.

// 2단계 Task 11 에서 9종 → 6종으로 재편했다.
// 옛 종류는 migrate-vault-v2 가 LEGACY_TYPE_MAP 으로 변환한다
export type VaultItemType = 'login' | 'password' | 'card' | 'note' | 'identity' | 'document'

export const VAULT_ITEM_TYPES: readonly VaultItemType[] = [
  'login',
  'password',
  'card',
  'note',
  'identity',
  'document'
]

// 옛 9종 → 새 6종 매핑표(마이그레이션·하위 호환 입력 정규화에 함께 쓴다)
export const LEGACY_TYPE_MAP: Record<string, VaultItemType> = {
  login_password: 'login',
  payment_password: 'password',
  card: 'card',
  passport: 'identity',
  id_card: 'identity',
  birth_date: 'identity',
  address: 'identity',
  phone: 'identity',
  custom: 'note'
}

/** 옛 종류 문자열이 들어와도 6종 중 하나로 정규화한다. 모르는 값은 'note' */
export function normalizeItemType(raw: string): VaultItemType {
  if ((VAULT_ITEM_TYPES as readonly string[]).includes(raw)) return raw as VaultItemType
  return LEGACY_TYPE_MAP[raw] ?? 'note'
}

// --- 결제 수단(제공자) ------------------------------------------------------
// 한 계정에 결제 비밀번호가 여러 개일 수 있다(예: 무신사 = 무신사머니·토스페이·
// 카카오페이·페이코). 어느 결제창의 비밀번호인지 구분하는 평문 필드 값이다.
// 'site' 는 사이트 자체 결제(무신사머니·SSG머니처럼 웹에서 끝나는 결제)다
export type PaymentProvider =
  'site' | 'musinsapay' | 'toss' | 'kakao' | 'naver' | 'payco' | 'alipay' | 'samsung' | 'apple' | 'other'

export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = [
  'site',
  // 무신사페이(카드 간편결제) — 무신사머니(site)와 결제 비밀번호가 따로다.
  // 이 구분이 없어 무신사페이 키패드에 무신사머니 비밀번호를 넣었다(실기: 오답 누적)
  'musinsapay',
  'toss',
  'kakao',
  'naver',
  'payco',
  // 알리페이 — 식화·得物(더우) 앱 결제. 폰 결제창의 6자리 결제 비밀번호(사용자 2026-10-01)
  'alipay',
  'samsung',
  'apple',
  'other'
]

/** 키마스터 편집 화면에서 고를 수 있는 결제 수단 — 삼성페이·애플페이는 쓰지 않는다(사용자 2026-09-24).
 *  예전에 저장된 값은 그대로 읽히도록 PAYMENT_PROVIDERS 에는 남겨 둔다 */
export const SELECTABLE_PAYMENT_PROVIDERS: readonly PaymentProvider[] = PAYMENT_PROVIDERS.filter(
  (p) => p !== 'samsung' && p !== 'apple'
)

/** 결제 비밀번호 항목에서 제공자를 담는 평문 필드 키 */
export const PAYMENT_PROVIDER_FIELD_KEY = 'payment.provider'

/**
 * 결제 수단이 "그 앱 계정"으로 결제되는 경우 그 계정이 사는 사이트(등록 도메인).
 * 네이버페이만 해당한다 — 어느 쇼핑몰에서 쓰든 네이버 계정으로 로그인해 결제하므로 결제 비밀번호는
 * **네이버 계정(naver.com)에만** 두고, 쇼핑몰 계정의 결제 비밀번호 항목은 어느 네이버 계정을 쓸지
 * (PAYMENT_ACCOUNT_FIELD_KEY)만 적는다. 토스·카카오는 전화번호로 결제하므로 예전처럼 쇼핑몰 계정에 둔다.
 * 페이코도 PC 결제창에서 페이코 계정(id.payco.com)으로 로그인한 뒤 결제 비밀번호를 받는다 — 네이버페이와 같은
 * 방식으로 페이코 계정(payco.com)에 비밀번호를 두고 쇼핑몰 계정은 어느 페이코 계정인지만 적는다(사용자 2026-09-25)
 */
export const PAYMENT_PROVIDER_ACCOUNT_HOST: Partial<Record<PaymentProvider, string>> = {
  naver: 'naver.com',
  payco: 'payco.com',
  // 식화·得物은 폰 앱만 있고 결제는 알리페이 계정으로 된다 — 비밀번호는 알리페이 계정(alipay.com) 항목에 둔다
  alipay: 'alipay.com'
}

/** 결제 비밀번호 항목에서 "이 앱 계정(아이디)의 비밀번호를 쓴다"를 담는 평문 필드 키 */
export const PAYMENT_ACCOUNT_FIELD_KEY = 'payment.account'

/** 섹션 목록에서 연결된 결제 앱 계정 아이디를 읽는다. 없으면 null */
export function paymentAccountOfSections(
  sections: readonly ProviderLookupSection[]
): string | null {
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.key === PAYMENT_ACCOUNT_FIELD_KEY) return field.value?.trim() || null
    }
  }
  return null
}

/** 제공자 필드가 없는 옛 항목은 사이트 자체 결제로 본다(마이그레이션 없이 읽기 기본값) */
export const DEFAULT_PAYMENT_PROVIDER: PaymentProvider = 'site'

/** 무엇이 들어와도 8값 중 하나로 맞춘다(기본 'site') */
export function normalizePaymentProvider(raw: string | null | undefined): PaymentProvider {
  if (raw && (PAYMENT_PROVIDERS as readonly string[]).includes(raw)) return raw as PaymentProvider
  return DEFAULT_PAYMENT_PROVIDER
}

// 제공자 필드를 찾기 위한 최소 구조 — StoredSection·VaultSection 둘 다 그대로 들어맞는다
interface ProviderLookupSection {
  fields: readonly { key: string; value?: string }[]
}

/** 섹션 목록에서 결제 제공자를 읽는다. 필드가 없거나 모르는 값이면 'site' */
export function paymentProviderOfSections(
  sections: readonly ProviderLookupSection[]
): PaymentProvider {
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.key === PAYMENT_PROVIDER_FIELD_KEY) return normalizePaymentProvider(field.value)
    }
  }
  return DEFAULT_PAYMENT_PROVIDER
}

export type FieldKind = 'text' | 'secret' | 'url' | 'date' | 'select'

export interface VaultField {
  // 'card.number' 처럼 점으로 구분한다 — fill_secret 의 field 인자와 같은 문자열이다
  key: string
  label: string
  kind: FieldKind
  // kind !== 'secret' 일 때만 평문이 내려간다. secret 필드는 항상 value 가 없다
  value?: string
}

export interface VaultSection {
  key: string
  label: string
  fields: VaultField[]
}

// 목록/상세 메타 — secret 필드는 value 를 절대 포함하지 않는다(reveal 로만 본다)
export interface VaultItemMeta {
  id: number
  accountId: number | null
  type: VaultItemType
  label: string
  sections: VaultSection[]
  updatedAt: number
}

// 항목별 AI 접근 정책. 'inherit' 는 전역 설정(vaultAccessPolicy)을 따른다
export type AgentAccess = 'inherit' | 'always' | 'while_unlocked' | 'never'

export const AGENT_ACCESS_VALUES: readonly AgentAccess[] = [
  'inherit',
  'always',
  'while_unlocked',
  'never'
]

/** DB 문자열이 무엇이든 4값 중 하나로 맞춘다(기본 'inherit') */
export function normalizeAgentAccess(raw: string | null | undefined): AgentAccess {
  if (raw && (AGENT_ACCESS_VALUES as readonly string[]).includes(raw)) return raw as AgentAccess
  return 'inherit'
}

export interface SiteDto {
  id: number
  host: string
  name: string
  loginUrl?: string
}

export interface AccountDto {
  id: number
  siteId: number
  host: string
  label: string
  username: string
  isDefault: boolean
  itemTypes: VaultItemType[]
  // 결제 비밀번호 항목이 가리키는 결제 제공자들(무신사머니=site·토스·카카오 …). 목록 조회에서만 채운다
  paymentProviders?: PaymentProvider[]
  // 계정당 여러 URL(옛 sites.loginUrl 이월분 포함)
  urls: string[]
  agentAccess: AgentAccess
  tags: string[]
}

// 페이지 내 자동 채움 피커가 쓰는 최소 정보. 값(비밀번호)은 절대 담기지 않는다.
// username 은 사용자 본인 화면에만 그려지므로 마스킹하지 않는다
export interface PickerAccountDto {
  id: number
  label: string
  username: string
}

export type VaultState = 'uninitialized' | 'locked' | 'unlocked'

// 저장 제안 확인 바에 쓰는 정보. 비밀번호는 메인에만 남고 여기 담기지 않는다.
// username 도 마스킹한 값(maskUsername)만 담는다 — 렌더러 방송으로 아이디 전체가 퍼지지 않게
export interface CapturePromptDto {
  host: string
  username: string
  isNew: boolean
  // 감지 시점에 금고가 잠겨 있었는가. 잠겨 있으면 기존 계정 여부를 알 수 없어
  // isNew 가 항상 true 이므로, UI 는 "새 계정" 대신 중립적인 문구를 쓴다
  locked: boolean
}

// 확인 바에서 고른 답. never = 이 사이트(등록 도메인)는 다시 묻지 않기
export type CaptureDecision = 'save' | 'skip' | 'never'

export const CAPTURE_DECISIONS: readonly CaptureDecision[] = ['save', 'skip', 'never']

// 페이지(preload)가 로그인 제출 감지 단계에서 보내는 원인 파악용 기록(vault:captureTrace).
// 값·아이디는 담지 않고 단계 이름만 보낸다 — 메인이 발신 프레임의 호스트와 함께 로그에 남긴다
export type CaptureTraceStage =
  // 로그인 버튼·Enter 로 보이는 제출이 있었지만 비밀번호 칸이 비어 있었다
  | 'no-password-value'
  // 비밀번호가 채워진 상태의 클릭이지만 로그인 버튼으로 보지 않았다
  | 'click-not-login'
  // 비밀번호 칸이 없는 화면에서 아이디만 기억했다(2단계 로그인 1단계)
  | 'username-step'
  // 페이지 쪽 레이트리밋(30초 3회)에 걸려 보내지 않았다
  | 'rate-limited'
  // 같은 값을 방금 보냈다(submit·click·Enter 가 한 제출에서 겹침)
  | 'duplicate'

export const CAPTURE_TRACE_STAGES: readonly CaptureTraceStage[] = [
  'no-password-value',
  'click-not-login',
  'username-step',
  'rate-limited',
  'duplicate'
]

// '묻지 않고 자동 저장'으로 저장·갱신됐을 때 렌더러에 보내는 알림 정보.
// 값(비밀번호)은 담지 않고 username 은 마스킹한다. undoToken 은 60초간만 유효하다
export interface PasswordUpdatedDto {
  host: string
  username: string
  undoToken: string
  // 새 계정을 저장했는지(saved), 기존 계정의 비밀번호를 바꿨는지(updated). 옛 메시지는 updated 로 본다
  kind?: 'saved' | 'updated'
}

/**
 * 아이디를 화면·IPC 용으로 가린다(값 전체가 렌더러로 방송되지 않게).
 * 이메일은 @ 앞부분만 가리고 도메인은 남긴다. 앞 2자·끝 1자만 보이고 나머지는 *.
 * 3자 이하면 첫 글자만 남긴다. 빈 값은 그대로 빈 값
 */
export function maskUsername(username: string): string {
  const value = username.trim()
  if (!value) return ''
  const at = value.lastIndexOf('@')
  const local = at > 0 ? value.slice(0, at) : value
  const domain = at > 0 ? value.slice(at) : ''
  const chars = Array.from(local)
  let masked: string
  if (chars.length <= 3) masked = chars[0] + '*'.repeat(Math.max(chars.length - 1, 1))
  else masked = chars.slice(0, 2).join('') + '*'.repeat(chars.length - 3) + chars[chars.length - 1]
  return masked + domain
}

// 사용 기록(감사 로그) 한 줄. 값(평문)은 절대 포함하지 않는다
export interface AuditLogDto {
  id: number
  at: number
  itemId: number | null
  // 기록 시점의 계정 id 스냅샷(항목이 지워져도 남는다). 전역 항목·가져오기는 null
  accountId: number | null
  action: string
  jobId: string | null
  source: string
}

// --- 내보내기 ------------------------------------------------------------
// 요청·응답 어디에도 평문 값은 없다. master 는 렌더러 → 메인 한 방향으로만 흐르고
// 메인에서 검증 후 즉시 버려지며, 응답에는 내보낸 항목 "개수" 와 저장 경로만 담긴다
export type ExportFormat = 'csv' | 'json'

export interface ExportRequest {
  format: ExportFormat
  // 마스터 비밀번호 재입력 값
  master: string
}

export interface ExportResult {
  itemCount: number
  filePath: string
}

// --- 결제 우선순위 ------------------------------------------------------------
// 같은 사이트의 여러 계정 중 결제(구매)에 먼저 쓸 순서. 서버 스키마를 바꾸지 않고 모든 PC 에 동기화되도록
// 계정 태그에 예약 태그 `결제순위:N`(N = 1 이 가장 먼저)으로 저장한다. 사용자 태그 목록에서는 숨긴다
export const PAY_PRIORITY_TAG_PREFIX = '결제순위:'

/** 태그 목록에서 결제 우선순위(1 이상 정수)를 읽는다. 없으면 null */
export function payPriorityOf(tags: readonly string[]): number | null {
  for (const tag of tags) {
    if (!tag.startsWith(PAY_PRIORITY_TAG_PREFIX)) continue
    const n = Number(tag.slice(PAY_PRIORITY_TAG_PREFIX.length))
    if (Number.isInteger(n) && n >= 1) return n
  }
  return null
}

/** 결제 우선순위를 바꾼 태그 목록. null 이면 지운다. 다른 태그의 순서는 그대로 */
export function withPayPriority(tags: readonly string[], priority: number | null): string[] {
  const rest = tags.filter((t) => !t.startsWith(PAY_PRIORITY_TAG_PREFIX))
  return priority === null ? rest : [...rest, `${PAY_PRIORITY_TAG_PREFIX}${priority}`]
}

/** 화면에 보여 줄 사용자 태그(예약 태그 제외) */
export function visibleTags(tags: readonly string[]): string[] {
  return tags.filter((t) => !t.startsWith(PAY_PRIORITY_TAG_PREFIX))
}
