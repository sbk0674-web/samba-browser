// 금고 서비스 — 잠금/해제 상태, 항목 CRUD, 감사 로그, 자동 잠금, 저장 제안 보관을 담당한다.
//
// 비밀값 규칙
// - 마스터 키는 이 인스턴스의 private 필드에만 존재한다(파일·로그·IPC 어디에도 없음)
// - 평문을 돌려주는 메서드는 reveal(사용자 클릭)과 getSecretForFill(메인 내부 전용) 둘뿐이다
// - 목록/메타 반환값에는 ciphertext·iv·평문 필드가 아예 존재하지 않는다
//
// AAD 전략
// - v2 부터 필드 암호문의 AAD 는 `${item.id}:${field.key}` 다. id 는 INSERT 시점에 정해지므로
//   "빈 fields 로 행을 먼저 만들고(id 확보) → 같은 트랜잭션에서 fields 를 UPDATE" 하는 방식을 쓴다.
// - v1 에서 옮겨 온 값은 재암호화하지 않으므로 AAD 가 `String(item.id)` 다.
//   그 값은 저장된 field.aad 에 기록돼 있고, fields.aadFor() 가 이를 그대로 사용한다

import { timingSafeEqual } from 'node:crypto'
import type { Db } from '../db/client'
import { tr } from '../i18n'
import {
  VaultRepo,
  type AuditRow,
  type AccountRow,
  type AccountSnapshot,
  type VaultItemRow,
  type PaymentItemLookup
} from './repo'
import {
  DEFAULT_FIELD_KEY,
  DEFAULT_SECTION_KEY,
  aadFor,
  findField,
  isSecretField,
  newAad,
  upsertField,
  type StoredField,
  type StoredSection
} from './fields'
import type { ExportRow } from './export'
import { toCapturePrompt } from './login-capture'
import {
  randomBytes,
  deriveKey,
  encrypt,
  decrypt,
  makeVerifier,
  checkVerifier,
  zeroize,
  clampMemoryKiB,
  clampIterations,
  clampParallelism,
  resolveDefaultKdfParams,
  type KdfParams
} from './crypto'
import {
  generateRecoveryKey,
  isValidRecoveryKey,
  normalizeRecoveryKey,
  unwrapMasterKey,
  wrapMasterKey
} from './recovery'
import type {
  AccountDto,
  AgentAccess,
  CapturePromptDto,
  FieldKind,
  PaymentProvider,
  PickerAccountDto,
  SiteDto,
  VaultItemMeta,
  VaultItemType,
  VaultState
} from '../../shared/vault'
import {
  paymentProviderOfSections,
  paymentAccountOfSections,
  PAYMENT_PROVIDER_ACCOUNT_HOST
} from '../../shared/vault'
import type { Settings } from '../../shared/settings'
import {
  VAULT_KEY_SYNC_KEYS,
  type OutboxRecorder,
  type SyncOp,
  type SyncTable,
  type VaultKeyApplyResult,
  type VaultKeySyncKey,
  type WorkspaceScope
} from '../../shared/sync'
import { normalizeHost, accountGroupKey } from '../../shared/host'

// electron safeStorage 중 실제로 쓰는 부분만 좁혀 둔 인터페이스(테스트에서 스텁 주입)
export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

// SettingsStore 를 통째로 요구하지 않는다(테스트에서 electron 의존 제거)
export interface SettingsReader {
  get: () => Settings
}

export interface VaultServiceOptions {
  safeStorage?: SafeStorageLike
}

// 저장 요청의 필드 한 개. secret 필드의 value 는 평문이며 메인에서 곧바로 암호화된다.
// value 를 생략하면 기존에 저장된 값을 그대로 둔다(편집 화면에서 "비워두면 유지")
export interface PutFieldInput {
  key: string
  label: string
  kind: FieldKind
  value?: string
}

export interface PutSectionInput {
  key: string
  label: string
  fields: PutFieldInput[]
}

// 결제 비밀번호 조회 결과. 값이 없을 때 이유를 호출부가 구분해 안내할 수 있다
export type PaymentSecretResult =
  | { value: string; reason?: undefined }
  | { value: null; reason: 'locked' | 'not-found' | 'ambiguous' }

export interface PutItemInput {
  // 편집 대상 항목 id. 주면 그 항목을 그대로 갱신한다(라벨·종류 변경 포함)
  id?: number
  accountId: number | null
  type: VaultItemType
  label: string
  // 하위 호환 경로: 단일 secret 값 하나만 넣는다(섹션 'main' > 필드 'value')
  value?: string
  // 신규 경로: 섹션>필드 전체를 교체한다(값을 생략한 secret 필드는 기존 암호문을 유지)
  sections?: PutSectionInput[]
  // 감사 로그에 남길 표식(예: 'auto-update'). audit 테이블에 별도 note 컬럼이 없어
  // 기존 jobId 컬럼을 재사용한다. 생략하면 null
  jobId?: string
}

// applyAutoPasswordUpdate() 가 되돌리기(undo)를 위해 보관하는 정보. 평문(oldValue)을
// 메모리에 60초만 들고 있다가 폐기한다(만료 시 undoAutoPasswordUpdate() 가 거부한다)
interface PendingPasswordUndo {
  itemId: number
  accountId: number
  label: string
  // 갱신 전 값. 기존 항목이 없어 새로 만든 경우는 null(되돌리기 시 항목을 삭제한다)
  oldValue: string | null
  hadExistingItem: boolean
  expiresAt: number
}

export interface UpsertAccountInput {
  id?: number
  host: string
  // 생략하면 기존 계정의 라벨을 유지한다(repo.upsertAccount 참고)
  label?: string
  username: string
  // 생략하면 기존 계정의 기본 계정 여부를 유지한다
  isDefault?: boolean
  siteName?: string
  loginUrl?: string
  // 생략하면 기존 값을 유지한다
  urls?: string[]
  agentAccess?: AgentAccess
  tags?: string[]
}

// 저장 제안으로 잡아 둔 자격정보. password 는 메인 메모리에만 60초 머문다
export interface PendingCapture {
  host: string
  username: string
  password: string
  isNew: boolean
  // 감지 시점에 금고가 잠겨 있었는가(UI 문구 분기용)
  locked: boolean
  // 제출이 일어난 탭의 프로필 이름(새 계정 라벨용). 모르면 undefined
  profile?: string
}

const META_SALT = 'salt'
const META_VERIFIER_CT = 'verifier_ct'
const META_VERIFIER_IV = 'verifier_iv'
const META_KDF_PARAMS = 'kdf_params'
const META_DEVICE_KEY = 'device_wrapped_key'
const META_RECOVERY_SALT = 'recovery_salt'
const META_RECOVERY_CT = 'recovery_wrapped_key'
const META_RECOVERY_IV = 'recovery_wrapped_iv'
// 이 금고의 키 재료가 다른 PC 에서 내려온 것인가(잠금 해제 화면 안내 문구 분기용).
// 한 번이라도 마스터 키를 채택하면(applyKey) 지운다
const META_KEY_FROM_SYNC = 'key_from_sync'

// 발급한 복구 키를 재입력 확인까지 메모리에 들고 있는 시간
const RECOVERY_PENDING_TTL_MS = 10 * 60_000

// 되돌리기 유효 시간(ms) — 계정 삭제 스냅샷과 자동 비밀번호 갱신 모두 60초(스펙)
const UNDO_TTL_MS = 60_000

const SALT_BYTES = 16

// 순서를 지키며 중복·빈 문자열을 뺀다(주소·태그 합치기용)
function uniqueStrings(list: string[]): string[] {
  return [...new Set(list.filter((v) => v.length > 0))]
}
const CAPTURE_TTL_MS = 60_000
const MINUTE_MS = 60_000
// setTimeout 이 받는 최대 지연(2^31-1 ms ≈ 24.8일)
const MAX_TIMEOUT_MS = 2_147_483_647

export class VaultService {
  private readonly repo: VaultRepo
  private readonly safeStorage?: SafeStorageLike
  // 마스터 키. 잠금 해제 상태에서만 값이 있고, lock() 이 0으로 덮어쓴다
  private key: Buffer | null = null
  private autoLockTimer: ReturnType<typeof setTimeout> | undefined
  // 자동 잠금 보류 토큰들. 하나라도 있으면 타이머가 만료돼도 잠그지 않는다
  // (AI 작업·예약 실행이 몇 시간 도는 동안 금고가 잠겨 로그인 도구가 실패하는 것을 막는다)
  private autoLockHolds = new Set<symbol>()
  // 보류 때문에 잠금을 미뤘다는 안내를 보류 구간마다 한 번만 남기기 위한 표시
  private autoLockDeferLogged = false
  // 발급했지만 아직 재입력 확인을 못 받은 복구 키(정규화된 값). 10분 뒤 스스로 버린다
  private pendingRecovery: { compact: string; expiresAt: number } | null = null
  private captureTimer: ReturnType<typeof setTimeout> | undefined
  private pending: (PendingCapture & { expiresAt: number }) | null = null
  private listeners = new Set<(state: VaultState) => void>()
  private captureListeners = new Set<(prompt: CapturePromptDto) => void>()
  // 자동 갱신 되돌리기 토큰 → 되돌릴 정보. 60초 지나면 setTimeout 이 스스로 지운다
  private pendingUndos = new Map<string, PendingPasswordUndo>()
  // dispose() 가 이미 실행됐는지(중복 호출 방어). before-quit 과 창 closed 이벤트
  // 양쪽에서 종료 정리를 부를 수 있어서 필요하다
  private disposed = false
  // 삭제 되돌리기 버퍼(토큰 → 스냅샷). 암호문이 들어 있어 메인 메모리에만 둔다
  private undoBuffer = new Map<
    string,
    // deletedAt: 지운 시각(되돌릴 때 옛 원격 id 에 다시 올리는 삭제 표식의 시각)
    { snapshots: AccountSnapshot[]; deletedAt: number; timer: NodeJS.Timeout }
  >()
  // 동기화 변경 로그 훅. 주입하지 않으면 아무 일도 하지 않는다(동기화를 끈 상태)
  private outbox: OutboxRecorder | null = null
  // 서버(계정)의 마스터 키 재료가 이 PC 의 금고와 다를 때 보관해 둔다 — 사용자가 계정 마스터
  // 비밀번호를 넣으면 이 재료로 새 키를 유도해 모든 항목을 다시 잠근다(rekeyToRemote)
  private pendingRemoteMaterial: RemoteKeyMaterial | null = null

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsReader,
    options: VaultServiceOptions = {}
  ) {
    this.repo = new VaultRepo(db)
    this.safeStorage = options.safeStorage
    this.tryDeviceUnlock()
  }

  // --- 동기화 연결 -------------------------------------------------------

  /** 변경 로그 훅을 붙인다(로그인 상태에서만). 붙이지 않으면 기록하지 않는다 */
  setOutboxRecorder(recorder: OutboxRecorder | null): void {
    this.outbox = recorder
  }

  /** 삭제는 행이 사라지기 전에 기록해야 한다 — 호출 순서에 주의 */
  private record(table: SyncTable, rowId: number, op: SyncOp): void {
    this.outbox?.(table, String(rowId), op)
  }

  /**
   * 되돌린 계정·항목의 옛 원격 id 에 삭제 표식을 올리도록 변경 로그에 적는다.
   * 로컬 행은 새 원격 id 를 받으므로, 옛 id 는 로컬 행과 무관한 'remote:<id>' 줄로 기록한다
   * (payload = 원격 삭제 표식을 만들 스냅샷. 비밀값은 담지 않는다)
   */
  private recordOldRemoteTombstones(snapshot: AccountSnapshot, deletedAt: number): void {
    if (!this.outbox) return
    const accountRemoteId = snapshot.account.remoteId
    const account = this.repo.getAccount(snapshot.account.id)
    if (accountRemoteId && account) {
      const payload = {
        id: 0,
        remoteId: accountRemoteId,
        host: account.host,
        label: account.label,
        username: account.username,
        isDefault: account.isDefault,
        urls: account.urls,
        agentAccess: account.agentAccess,
        tags: account.tags,
        pausedUntil: snapshot.account.pausedUntil,
        updatedAt: deletedAt,
        deletedAt
      }
      this.outbox('accounts', `remote:${accountRemoteId}`, 'delete', JSON.stringify(payload))
    }
    for (const item of snapshot.items) {
      if (!item.remoteId) continue
      const payload = {
        id: 0,
        remoteId: item.remoteId,
        accountId: null,
        accountRemoteId,
        type: item.type,
        label: item.label,
        fieldsJson: '[]',
        updatedAt: deletedAt,
        deletedAt
      }
      this.outbox('vault_items', `remote:${item.remoteId}`, 'delete', JSON.stringify(payload))
    }
  }

  /**
   * 동기화 전용 — 잠금 해제 상태에서만 마스터 키를 빌려 준다.
   * 키 자체를 반환하지 않고 콜백 안에서만 쓰게 해, 호출부가 키를 보관하지 못하게 한다
   */
  useMasterKey<T>(fn: (key: Buffer) => T): T | null {
    if (!this.key) return null
    return fn(this.key)
  }

  // --- 마스터 키 재료 동기화 ---------------------------------------------
  //
  // 새 PC 에서 같은 마스터 비밀번호로 금고를 열 수 있게, salt·KDF 파라미터·검증자를
  // settings 표에 얹어 나른다. 셋 다 비밀이 아니다 — 이것만으로는 아무 값도 열리지 않고,
  // 같은 비밀번호에서 같은 키를 다시 유도하는 데만 쓰인다

  /** 동기화가 올릴 값. 금고가 아직 설정 전이면 null */
  readKeyMaterial(key: VaultKeySyncKey): string | null {
    if (this.db.isClosed || !this.isInitialized()) return null
    if (key === 'vault.salt') {
      const salt = this.repo.getMeta(META_SALT)
      return salt ? salt.toString('base64') : null
    }
    if (key === 'vault.kdf') return JSON.stringify(this.readKdfParams())
    const ct = this.repo.getMeta(META_VERIFIER_CT)
    const iv = this.repo.getMeta(META_VERIFIER_IV)
    if (!ct || !iv) return null
    return JSON.stringify({ ct: ct.toString('base64'), iv: iv.toString('base64') })
  }

  /**
   * 원격에서 받은 키 재료를 로컬에 심는다.
   * 로컬 금고가 아직 설정 전일 때만 심는다 — 이미 설정돼 있는데 값이 다르면
   * 덮어쓰지 않고 'mismatch' 를 돌려준다(덮으면 이 PC 의 기존 암호문이 영영 안 열린다)
   */
  applyKeyMaterial(values: Partial<Record<VaultKeySyncKey, string>>): VaultKeyApplyResult {
    if (this.db.isClosed) return 'incomplete'
    const parsed = parseKeyMaterial(values)
    if (!parsed) return 'incomplete'

    if (this.isInitialized()) {
      const salt = this.repo.getMeta(META_SALT)
      const ct = this.repo.getMeta(META_VERIFIER_CT)
      const iv = this.repo.getMeta(META_VERIFIER_IV)
      const same =
        !!salt &&
        !!ct &&
        !!iv &&
        salt.equals(parsed.salt) &&
        ct.equals(parsed.verifierCt) &&
        iv.equals(parsed.verifierIv)
      if (!same) this.pendingRemoteMaterial = parsed
      else this.pendingRemoteMaterial = null
      return same ? 'unchanged' : 'mismatch'
    }

    this.repo.setMeta(META_SALT, parsed.salt)
    this.repo.setMeta(META_KDF_PARAMS, Buffer.from(JSON.stringify(parsed.kdf), 'utf8'))
    this.repo.setMeta(META_VERIFIER_CT, parsed.verifierCt)
    this.repo.setMeta(META_VERIFIER_IV, parsed.verifierIv)
    this.repo.setMeta(META_KEY_FROM_SYNC, Buffer.from('1', 'utf8'))
    // 'uninitialized' → 'locked' 로 바뀐 것을 화면이 곧바로 따라오게 한다
    this.emit()
    return 'applied'
  }

  /** 서버(계정)의 키 재료가 이 PC 와 달라 재키가 필요한 상태인가 */
  hasPendingRemoteKey(): boolean {
    return this.pendingRemoteMaterial !== null
  }

  /**
   * 이 PC 의 금고를 계정(서버) 마스터 키에 맞춘다.
   * 계정 마스터 비밀번호로 서버 재료에서 키를 유도해 검증한 뒤, 모든 항목의 비밀 필드를 지금 키로 풀어
   * 새 키로 다시 잠그고, 키 재료를 서버 것으로 바꾼다. 항목마다 변경 로그를 남겨 서버의 (다른 키로 잠긴)
   * 사본을 덮어쓴다. 복구 키는 옛 키를 감싼 것이라 지운다(다시 등록해야 한다).
   * - 'locked': 지금 키가 없어 항목을 풀 수 없다(먼저 이 PC 마스터로 열어야 한다)
   * - 'no-remote': 서버 재료가 없거나 이미 같다
   * - 'wrong-master': 계정 마스터 비밀번호가 틀렸다
   * - 'decrypt-failed': 어떤 항목을 지금 키로 못 풀었다(아무것도 바꾸지 않았다)
   */
  async rekeyToRemote(
    master: string
  ): Promise<'ok' | 'locked' | 'no-remote' | 'wrong-master' | 'decrypt-failed'> {
    if (!this.key) return 'locked'
    const remote = this.pendingRemoteMaterial
    if (!remote) return 'no-remote'
    if (master.length === 0) return 'wrong-master'
    const newKey = await deriveKey(master, remote.salt, {
      memoryKiB: remote.kdf.memoryKiB,
      iterations: remote.kdf.iterations,
      parallelism: remote.kdf.parallelism
    })
    if (!checkVerifier(newKey, { ciphertext: remote.verifierCt, iv: remote.verifierIv })) {
      zeroize(newKey)
      return 'wrong-master'
    }
    const r = this.rekeyTo(newKey, remote)
    if (r !== 'ok') return r
    this.pendingRemoteMaterial = null
    return 'ok'
  }

  /**
   * 이 PC 의 금고를 새 비밀번호(계정 비밀번호)로 다시 잠근다 — 새 소금·검증자를 만들고 모든 항목을 옮겨 잠근 뒤
   * 키 재료를 서버에 올린다(다른 PC 는 다음 주기에 이 재료로 맞춘다). 지금 키가 있어야 한다
   */
  async rekeyToPassword(password: string): Promise<'ok' | 'locked' | 'decrypt-failed'> {
    if (!this.key) return 'locked'
    if (password.length === 0) return 'locked'
    const salt = randomBytes(SALT_BYTES)
    const kdf: KdfParams = resolveDefaultKdfParams()
    const newKey = await deriveKey(password, salt, {
      memoryKiB: kdf.memoryKiB,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism
    })
    const verifier = makeVerifier(newKey)
    const r = this.rekeyTo(newKey, {
      salt,
      kdf,
      verifierCt: verifier.ciphertext,
      verifierIv: verifier.iv
    })
    if (r !== 'ok') return r
    this.pendingRemoteMaterial = null
    this.recordKeyMaterial()
    return 'ok'
  }

  /**
   * 계정 비밀번호가 곧 키마스터 열쇠다 — 마스터 비밀번호를 따로 두지 않는다.
   * 로그인 직후(비밀번호를 아는 순간) 불러 이 PC 금고를 계정 비밀번호에 맞춘다:
   *  - 서버 재료와 어긋나 있으면(pendingRemoteMaterial) 그 재료로 다시 잠근다
   *  - 금고가 없으면 계정 비밀번호로 만든다(재료는 서버로 올라간다)
   *  - 잠겨 있으면 계정 비밀번호로 연다. 안 열리면 기기 키로 열어 계정 비밀번호로 다시 잠근다
   *  - 열려 있는데 다른 비밀번호로 잠긴 금고면 계정 비밀번호로 다시 잠근다
   * 'needs-old-master' 는 옛 마스터로 잠긴 금고를 기기 키로도 못 연 경우 — 사용자가 옛 마스터를 한 번 쳐야 한다
   */
  async adoptAccountPassword(
    password: string
  ): Promise<
    | 'setup'
    | 'unlocked'
    | 'rekeyed'
    | 'rekeyed-to-remote'
    | 'already'
    | 'needs-old-master'
    | 'failed'
  > {
    if (this.db.isClosed || password.length === 0) return 'failed'
    if (!this.isInitialized()) {
      await this.setup(password)
      return 'setup'
    }
    if (!this.key) {
      if (await this.unlock(password)) {
        // 서버 재료와 어긋난 상태였으면 이제 키가 있으니 맞춘다
        if (this.pendingRemoteMaterial) {
          const r = await this.rekeyToRemote(password)
          if (r === 'ok') return 'rekeyed-to-remote'
        }
        return 'unlocked'
      }
      if (!(await this.ensureUnlockedByDevice())) return 'needs-old-master'
    }
    if (this.pendingRemoteMaterial) {
      const r = await this.rekeyToRemote(password)
      if (r === 'ok') return 'rekeyed-to-remote'
      // 서버 재료가 다른 비밀번호로 만들어졌으면(옛 마스터) 이 PC 것을 계정 비밀번호로 새로 만들어 올린다
    }
    if (await this.verifyMaster(password)) return 'already'
    const r = await this.rekeyToPassword(password)
    return r === 'ok' ? 'rekeyed' : 'failed'
  }

  /** 모든 항목을 newKey 로 옮겨 잠그고 키 재료를 material 로 바꾼다(실패 시 아무것도 바꾸지 않는다) */
  private rekeyTo(newKey: Buffer, material: RemoteKeyMaterial): 'ok' | 'locked' | 'decrypt-failed' {
    const oldKey = this.key
    if (!oldKey) {
      zeroize(newKey)
      return 'locked'
    }
    const rows = this.repo.listAllItemRows()
    const rekeyed: Array<{ row: VaultItemRow; sections: StoredSection[] }> = []
    try {
      for (const row of rows) {
        const sections: StoredSection[] = row.sections.map((section) => ({
          ...section,
          fields: section.fields.map((field): StoredField => {
            if (!isSecretField(field)) return field
            const plain = decrypt(
              oldKey,
              Buffer.from(field.ciphertext, 'base64'),
              Buffer.from(field.iv, 'base64'),
              aadFor(row.id, field)
            )
            const blob = encrypt(newKey, plain, newAad(row.id, field.key))
            return {
              key: field.key,
              label: field.label,
              kind: 'secret',
              ciphertext: blob.ciphertext.toString('base64'),
              iv: blob.iv.toString('base64')
            }
          })
        }))
        rekeyed.push({ row, sections })
      }
    } catch {
      zeroize(newKey)
      return 'decrypt-failed'
    }
    const now = Date.now()
    this.repo.transaction(() => {
      for (const { row, sections } of rekeyed) {
        this.repo.updateItemFields(row.id, sections, row.label, row.type, now)
        this.record('vault_items', row.id, 'upsert')
      }
      this.repo.setMeta(META_SALT, material.salt)
      this.repo.setMeta(META_KDF_PARAMS, Buffer.from(JSON.stringify(material.kdf), 'utf8'))
      this.repo.setMeta(META_VERIFIER_CT, material.verifierCt)
      this.repo.setMeta(META_VERIFIER_IV, material.verifierIv)
      // 복구 키·기기 키는 옛 키를 감싼 것 — 지운다(기기 키는 applyKey 가 새로 감싼다)
      this.repo.deleteMeta(META_RECOVERY_SALT)
      this.repo.deleteMeta(META_RECOVERY_CT)
      this.repo.deleteMeta(META_RECOVERY_IV)
      this.repo.deleteMeta(META_DEVICE_KEY)
      return null
    })
    this.applyKey(newKey)
    this.repo.insertAudit({ itemId: null, accountId: null, action: 'rekey', source: 'user' })
    return 'ok'
  }

  /** 이 금고의 키 재료가 다른 PC 에서 내려온 것인가(잠금 해제 화면 안내 문구용) */
  isKeyFromSync(): boolean {
    if (this.db.isClosed) return false
    return this.repo.getMeta(META_KEY_FROM_SYNC) !== null
  }

  /** 키 재료 세 키를 변경 로그에 올린다(금고 설정 직후) */
  private recordKeyMaterial(): void {
    for (const key of VAULT_KEY_SYNC_KEYS) this.outbox?.('settings', key, 'upsert')
  }

  /**
   * 로그인 직후 한 번 — 로그아웃 상태에서 설정한 금고는 키 재료를 기록할 훅이 없었다.
   * 그대로 두면 이 PC 의 마스터 비밀번호로는 다른 PC 에서 금고를 열 수 없다
   */
  ensureKeyMaterialRecorded(): void {
    if (this.db.isClosed || !this.isInitialized()) return
    this.recordKeyMaterial()
  }

  // --- 상태 -------------------------------------------------------------

  state(): VaultState {
    // 키를 이미 들고 있으면 DB 를 다시 확인할 필요가 없다 — DB 가 닫힌 뒤에도
    // (종료 순서가 겹치는 경우) 안전하게 'unlocked' 를 돌려줄 수 있다
    if (this.key) return 'unlocked'
    if (!this.isInitialized()) return 'uninitialized'
    return 'locked'
  }

  onStateChanged(cb: (state: VaultState) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private emit(): void {
    const s = this.state()
    for (const cb of this.listeners) cb(s)
  }

  private isInitialized(): boolean {
    // DB 가 이미 닫혔으면(종료 중) 쿼리를 시도하지 않는다 — sql.js 는 닫힌 핸들에 대한
    // 쿼리에서 'out of memory' 예외를 던진다
    if (this.db.isClosed) return false
    return this.repo.getMeta(META_SALT) !== null && this.repo.getMeta(META_VERIFIER_CT) !== null
  }

  // --- 설정/해제 ---------------------------------------------------------

  async setup(master: string): Promise<void> {
    if (this.isInitialized()) throw new Error(tr('vault.alreadyInitialized'))
    if (master.length === 0) throw new Error(tr('vault.emptyMaster'))

    const salt = randomBytes(SALT_BYTES)
    // 환경변수 게이트는 crypto.resolveDefaultKdfParams() 안에만 있다 — 여기서 process.env 를
    // 직접 읽으면 프로덕션에서도 메모리 비용을 낮출 수 있게 되므로 절대 하지 않는다
    const params: KdfParams = resolveDefaultKdfParams()
    const key = await deriveKey(master, salt, {
      memoryKiB: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism
    })
    const verifier = makeVerifier(key)

    this.repo.setMeta(META_SALT, salt)
    this.repo.setMeta(META_KDF_PARAMS, Buffer.from(JSON.stringify(params), 'utf8'))
    this.repo.setMeta(META_VERIFIER_CT, verifier.ciphertext)
    this.repo.setMeta(META_VERIFIER_IV, verifier.iv)

    // 다른 PC 가 같은 마스터 비밀번호로 이 금고를 열 수 있도록 키 재료를 함께 올린다
    this.recordKeyMaterial()
    this.applyKey(key)
  }

  async unlock(master: string): Promise<boolean> {
    if (!this.isInitialized()) throw new Error(tr('vault.notInitialized'))
    const salt = this.repo.getMeta(META_SALT)
    const ct = this.repo.getMeta(META_VERIFIER_CT)
    const iv = this.repo.getMeta(META_VERIFIER_IV)
    if (!salt || !ct || !iv) throw new Error(tr('vault.metaCorrupted'))

    const params = this.readKdfParams()
    const key = await deriveKey(master, salt, {
      memoryKiB: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism
    })
    if (!checkVerifier(key, { ciphertext: ct, iv })) {
      zeroize(key)
      return false
    }
    this.applyKey(key)
    return true
  }

  // 사용자가 직접 [잠금] 을 눌렀을 때도 이 함수를 탄다 — 보류가 걸려 있어도 즉시 잠근다
  lock(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer)
      this.autoLockTimer = undefined
    }
    this.autoLockDeferLogged = false
    // 확인 못 받은 복구 키는 잠그는 순간 버린다(마스터 키가 없으면 감쌀 수도 없다)
    this.pendingRecovery = null
    // 키 zeroize 는 DB 상태와 무관하게 항상 수행한다(메모리에 평문 키를 남기지 않는 것이 최우선)
    if (this.key) {
      zeroize(this.key)
      this.key = null
      this.emit()
    }
    // 종료 순서가 겹쳐 DB 가 먼저 닫힌 뒤 lock() 이 불릴 수 있다(예: before-quit 에서
    // vault.dispose() 후 db.close() 를 호출했는데 창 closed 이벤트가 뒤이어 dispose() 를
    // 한 번 더 부르는 경우). DB 작업은 실패해도 잠금 자체를 막으면 안 되므로 try/catch 로 감싼다
    try {
      this.pruneDeviceWrappedKeyIfDisabled()
    } catch (e: unknown) {
      console.error('기기 기억 키 정리 실패', e instanceof Error ? e.message : String(e))
    }
  }

  // 사용자 활동이 있을 때마다 자동 잠금 타이머를 되돌린다
  touch(): void {
    this.pruneDeviceWrappedKeyIfDisabled()
    if (!this.key) return
    this.restartAutoLock()
  }

  // vaultRememberDevice 가 꺼져 있는데 예전에 저장된 감싼 키가 남아 있으면 지운다.
  // lock()/touch() 양쪽에서 불러 옵션을 끈 시점 이후 첫 상태 확인에서 곧바로 반영되게 한다
  private pruneDeviceWrappedKeyIfDisabled(): void {
    if (this.db.isClosed) return
    if (this.settings.get().vaultRememberDevice) return
    if (this.repo.getMeta(META_DEVICE_KEY)) this.repo.deleteMeta(META_DEVICE_KEY)
  }

  // 인스턴스를 버릴 때 타이머·키를 정리한다(앱 종료·테스트). 두 번 호출돼도 안전하다
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.captureTimer) {
      clearTimeout(this.captureTimer)
      this.captureTimer = undefined
    }
    this.pending = null
    for (const entry of this.undoBuffer.values()) clearTimeout(entry.timer)
    this.undoBuffer.clear()
    this.listeners.clear()
    this.captureListeners.clear()
    this.pendingUndos.clear()
    this.lock()
  }

  private readKdfParams(): KdfParams {
    const raw = this.repo.getMeta(META_KDF_PARAMS)
    const fallback: KdfParams = resolveDefaultKdfParams()
    if (!raw) return fallback
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null) return fallback
      const p = parsed as Partial<KdfParams>
      return {
        // DB 값이 변조돼 터무니없이 작거나 커도 허용 범위를 벗어나지 않는다(정수로도 맞춘다)
        memoryKiB:
          typeof p.memoryKiB === 'number' ? clampMemoryKiB(p.memoryKiB) : fallback.memoryKiB,
        iterations:
          typeof p.iterations === 'number' ? clampIterations(p.iterations) : fallback.iterations,
        parallelism:
          typeof p.parallelism === 'number' ? clampParallelism(p.parallelism) : fallback.parallelism
      }
    } catch {
      return fallback
    }
  }

  // 키를 채택하고(기기 기억 옵션 반영) 자동 잠금 타이머를 건다
  private applyKey(key: Buffer): void {
    // 이미 채택된 키가 있으면(예: unlock 을 다시 호출) 새 키로 덮어쓰기 전에 메모리에서 지운다
    if (this.key) zeroize(this.key)
    this.key = key
    // 한 번이라도 열었으면 "다른 PC 에서 설정됨" 안내는 더 이상 필요 없다
    if (!this.db.isClosed && this.repo.getMeta(META_KEY_FROM_SYNC)) {
      this.repo.deleteMeta(META_KEY_FROM_SYNC)
    }
    this.syncDeviceWrappedKey()
    this.restartAutoLock()
    this.emit()
  }

  /**
   * 자동 잠금을 보류한다. 돌려주는 함수를 부르면 보류가 풀리고,
   * 마지막 보류가 풀리는 순간 타이머를 '지금 + 설정 분' 으로 다시 건다.
   * 같은 토큰을 여러 번 풀어도 안전하다(러너의 stop 과 finally 가 겹쳐 부른다).
   * 설정(vaultHoldLockDuringAgent)이 꺼져 있으면 아무것도 하지 않는 함수를 돌려준다
   */
  holdAutoLock(reason: string): () => void {
    if (!this.settings.get().vaultHoldLockDuringAgent) return () => {}
    const token = Symbol(reason)
    this.autoLockHolds.add(token)
    let released = false
    return () => {
      if (released) return
      released = true
      if (!this.autoLockHolds.delete(token)) return
      if (this.autoLockHolds.size > 0) return
      this.autoLockDeferLogged = false
      // 보류 중에 만료됐든 아니든, 마지막 보류가 풀린 시점부터 설정 분을 다시 센다
      if (this.key) this.restartAutoLock()
    }
  }

  private restartAutoLock(): void {
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer)
    const minutes = this.settings.get().vaultAutoLockMinutes
    this.armAutoLock(minutes * MINUTE_MS)
  }

  /**
   * 자동 잠금 타이머를 건다. setTimeout 은 32비트(약 24.8일)를 넘으면 1ms 로 뭉개져 곧바로 잠겨 버리므로
   * (실기: 30일로 설정하자 켜자마자 잠김) 상한 이하로 쪼개 남은 시간을 이어서 건다
   */
  private armAutoLock(remainingMs: number): void {
    const slice = Math.min(remainingMs, MAX_TIMEOUT_MS)
    const rest = remainingMs - slice
    this.autoLockTimer = setTimeout(() => {
      this.autoLockTimer = undefined
      if (rest > 0) {
        this.armAutoLock(rest)
        return
      }
      // 보류가 걸려 있으면 잠그지 않고 그대로 둔다 — 보류가 풀릴 때 타이머를 다시 건다.
      // 설정을 도중에 꺼 두었으면 보류를 무시하고 예정대로 잠근다
      if (this.autoLockHolds.size > 0 && this.settings.get().vaultHoldLockDuringAgent) {
        if (!this.autoLockDeferLogged) {
          this.autoLockDeferLogged = true
          console.info('키마스터 자동 잠금 보류 중(AI 작업)')
        }
        return
      }
      this.lock()
    }, slice)
    // 자동 잠금 타이머 때문에 프로세스가 살아 있지 않도록 한다
    this.autoLockTimer.unref?.()
  }

  // --- 기기 기억(safeStorage) --------------------------------------------

  private canUseSafeStorage(): boolean {
    if (!this.safeStorage) return false
    try {
      return this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private syncDeviceWrappedKey(): void {
    const remember = this.settings.get().vaultRememberDevice
    if (!remember) {
      // 옵션을 껐으면 저장돼 있던 키도 지운다
      if (this.repo.getMeta(META_DEVICE_KEY)) this.repo.deleteMeta(META_DEVICE_KEY)
      return
    }
    if (!this.key || !this.safeStorage || !this.canUseSafeStorage()) return
    try {
      const wrapped = this.safeStorage.encryptString(this.key.toString('base64'))
      this.repo.setMeta(META_DEVICE_KEY, Buffer.from(wrapped))
    } catch {
      // 기기 기억 실패는 치명적이지 않다(다음 실행에서 마스터 입력을 받으면 된다)
    }
  }

  // 시작 시 감싼 키가 있으면 마스터 입력 없이 해제를 시도한다(실패하면 잠긴 채로 둔다)
  private tryDeviceUnlock(): void {
    this.unlockWithDeviceKey()
  }

  // 기기에 감싸 저장된 키로 잠금 해제를 1회 시도한다. 성공하면 true.
  // 생성자의 tryDeviceUnlock 과 ensureUnlockedByDevice() 가 공유하는 핵심 로직이다
  private unlockWithDeviceKey(): boolean {
    // 실패 사유는 값 없이 한 줄만 남긴다 — "왜 매번 잠겨 있나"를 사용자가 알 수 있게
    const skip = (why: string): false => {
      console.warn(`키마스터 기기 키 자동 해제 안 함: ${why}`)
      return false
    }
    if (!this.isInitialized()) return skip('금고 미설정')
    if (!this.settings.get().vaultRememberDevice) return skip('이 PC에서 기억 꺼짐')
    if (!this.canUseSafeStorage() || !this.safeStorage)
      return skip('safeStorage 사용 불가(앱 준비 전?)')
    const wrapped = this.repo.getMeta(META_DEVICE_KEY)
    if (!wrapped) return skip('저장된 기기 키 없음')
    const ct = this.repo.getMeta(META_VERIFIER_CT)
    const iv = this.repo.getMeta(META_VERIFIER_IV)
    if (!ct || !iv) return skip('검증값 없음')
    try {
      const key = Buffer.from(this.safeStorage.decryptString(wrapped), 'base64')
      if (!checkVerifier(key, { ciphertext: ct, iv })) {
        zeroize(key)
        return skip('기기 키가 현재 마스터와 맞지 않음(마스터 변경 후 다시 기억 필요)')
      }
      this.key = key
      this.restartAutoLock()
      this.emit()
      return true
    } catch {
      // 복호화 실패(다른 기기·사용자) → 잠긴 상태 유지
      return skip('기기 키 복호화 실패(다른 사용자·기기)')
    }
  }

  /**
   * 접근 정책이 'always' 일 때, 잠긴 상태에서 AI 도구/UI 진입 시 기기 키로 자동 해제를 시도한다.
   * 이미 해제돼 있으면 즉시 true. 기기 기억이 꺼져 있거나 기기 키가 없으면 false.
   */
  async ensureUnlockedByDevice(): Promise<boolean> {
    if (this.key) return true
    return this.unlockWithDeviceKey()
  }

  // --- 복구 키 -----------------------------------------------------------

  /** 복구 키가 이미 등록돼 있는가(값은 절대 돌려주지 않는다) */
  hasRecoveryKey(): boolean {
    if (this.db.isClosed) return false
    return this.repo.getMeta(META_RECOVERY_CT) !== null
  }

  /**
   * 새 복구 키를 발급한다. 반환값은 화면 표시 전용이며 여기서는 저장하지 않는다 —
   * 사용자가 재입력해 confirmRecoveryKey() 를 통과해야 감싼 마스터 키가 DB 에 남는다.
   * 발급 값은 메모리에만 10분 머문다
   */
  createRecoveryKey(): string {
    if (!this.key) throw new Error(tr('vault.locked'))
    const key = generateRecoveryKey()
    this.pendingRecovery = {
      compact: normalizeRecoveryKey(key),
      expiresAt: Date.now() + RECOVERY_PENDING_TTL_MS
    }
    return key
  }

  /**
   * 사용자가 옮겨 적은 복구 키를 확인한다. 정확히 일치할 때만 마스터 키를
   * 복구 키로 감싸 vault_meta 에 저장하고 true 를 돌려준다.
   * 틀렸거나 발급 기록이 없거나 10분이 지났으면 아무것도 저장하지 않고 false 다
   */
  async confirmRecoveryKey(input: string): Promise<boolean> {
    const pending = this.pendingRecovery
    if (!pending || !this.key) return false
    if (Date.now() > pending.expiresAt) {
      this.pendingRecovery = null
      return false
    }
    if (!this.matchesPendingRecovery(input, pending.compact)) return false

    const salt = randomBytes(SALT_BYTES)
    const blob = await wrapMasterKey(this.key, pending.compact, salt)
    this.repo.setMeta(META_RECOVERY_SALT, salt)
    this.repo.setMeta(META_RECOVERY_CT, blob.ciphertext)
    this.repo.setMeta(META_RECOVERY_IV, blob.iv)
    // 2b 에서 복구 키(recovery_wrapped_key)는 이 기기 로컬에만 둔다 — vault_meta 에만 있고
    // 변경 로그에는 아무것도 남기지 않는다(푸시 화이트리스트 밖이라 어차피 드롭됐다).
    // 다른 PC 복구는 2c
    // 확인이 끝난 발급 값은 곧바로 버린다(재사용 방지)
    this.pendingRecovery = null
    this.logAudit('recovery_create', 'user')
    return true
  }

  /** 입력값을 발급 값과 상수 시간으로 비교한다(길이 차이는 먼저 걸러낸다) */
  private matchesPendingRecovery(input: string, expected: string): boolean {
    if (!isValidRecoveryKey(input)) return false
    const given = Buffer.from(normalizeRecoveryKey(input), 'utf8')
    const want = Buffer.from(expected, 'utf8')
    if (given.length !== want.length) return false
    return timingSafeEqual(given, want)
  }

  /** 복구 키로 금고를 해제한다. 마스터 비밀번호를 잊었을 때의 마지막 수단이다 */
  async unlockWithRecoveryKey(input: string): Promise<boolean> {
    if (!this.isInitialized()) return false
    if (!isValidRecoveryKey(input)) return false
    const salt = this.repo.getMeta(META_RECOVERY_SALT)
    const ct = this.repo.getMeta(META_RECOVERY_CT)
    const iv = this.repo.getMeta(META_RECOVERY_IV)
    const verifierCt = this.repo.getMeta(META_VERIFIER_CT)
    const verifierIv = this.repo.getMeta(META_VERIFIER_IV)
    if (!salt || !ct || !iv || !verifierCt || !verifierIv) return false

    let key: Buffer
    try {
      key = await unwrapMasterKey({ ciphertext: ct, iv }, input, salt)
    } catch {
      // 복구 키가 틀리면 GCM 인증이 실패한다
      return false
    }
    if (!checkVerifier(key, { ciphertext: verifierCt, iv: verifierIv })) {
      zeroize(key)
      return false
    }
    this.applyKey(key)
    this.logAudit('recovery_unlock', 'user')
    return true
  }

  // --- 조회 -------------------------------------------------------------

  listSites(): SiteDto[] {
    return this.repo.listSites()
  }

  /** 활성 작업공간을 저장소에 알려 준다(조회 범위 필터 + 새 행에 붙일 작업공간) */
  setWorkspaceScope(scope: WorkspaceScope | null): void {
    this.repo.setWorkspaceScope(scope)
  }

  listAccounts(host?: string): AccountDto[] {
    const normalizedHost = host === undefined ? undefined : normalizeHost(host) || host
    const types = this.repo.itemTypesByAccount()
    const providers = this.repo.paymentProvidersByAccount()
    return this.matchAccountRows(normalizedHost).map((a) => ({
      id: a.id,
      siteId: a.siteId,
      host: a.host,
      label: a.label,
      username: a.username,
      isDefault: a.isDefault,
      itemTypes: types.get(a.id) ?? [],
      paymentProviders: providers.get(a.id) ?? [],
      urls: a.urls,
      agentAccess: a.agentAccess,
      tags: a.tags
    }))
  }

  /** 계정 하나를 DTO 로 조회한다(없으면 null) */
  getAccount(id: number): AccountDto | null {
    const row = this.repo.getAccount(id)
    if (!row) return null
    const types = this.repo.itemTypesByAccount()
    return {
      id: row.id,
      siteId: row.siteId,
      host: row.host,
      label: row.label,
      username: row.username,
      isDefault: row.isDefault,
      itemTypes: types.get(row.id) ?? [],
      urls: row.urls,
      agentAccess: row.agentAccess,
      tags: row.tags
    }
  }

  /**
   * 페이지 내 자동 채움 피커에 내려보낼 최소 목록.
   * 값(비밀번호)은 담기지 않으며, 로그인 항목이 있는 계정만 고른다
   */
  listPickerAccounts(host: string): PickerAccountDto[] {
    const normalized = normalizeHost(host) || host
    if (!normalized) return []
    return this.listAccounts(normalized)
      .filter((a) => a.itemTypes.includes('login'))
      .map((a) => ({
        id: a.id,
        label: a.label,
        username: a.username
      }))
  }

  // host 로 정확히 일치하는 계정을 우선 반환하고, 같은 등록 도메인(eTLD+1)의 계정을 이어 붙인다.
  // 예: CSV 로 가져온 네이버 계정은 host 가 로그인 URL 기준 "nid.naver.com" 으로 저장되는데,
  // 탭은 "www.naver.com"(→ "naver.com") 인 경우가 흔하다 — 정확 일치만으로는 0건이 나와
  // "저장된 계정 없음" 으로 오판했다(실검수 버그).
  private matchAccountRows(host?: string): AccountRow[] {
    if (host === undefined) return this.repo.listAccounts()
    const exact = this.repo.listAccounts(host)
    const domain = accountGroupKey(host)
    const domainMatches = this.repo
      .listAccounts()
      .filter((a) => a.host !== host && accountGroupKey(a.host) === domain)
    return [...exact, ...domainMatches]
  }

  listItems(accountId: number | null): VaultItemMeta[] {
    return this.repo.listItems(accountId)
  }

  listAudit(accountId?: number, limit?: number): AuditRow[] {
    return this.repo.listAudit(accountId, limit)
  }

  // 특정 항목에 매이지 않는 감사 로그 한 줄을 남긴다(예: 가져오기 완료). 값은 절대 넣지 않는다
  logAudit(action: string, source: string): void {
    this.repo.insertAudit({ itemId: null, action, source })
  }

  // --- 쓰기 -------------------------------------------------------------

  upsertAccount(input: UpsertAccountInput): AccountDto {
    // 정규화 결과가 빈 문자열이면(예: 호스트만 있고 파싱이 안 되는 값) 원래 값을 그대로 둔다 —
    // 계정 자체를 잃어버리는 것보다 정규화 실패를 허용하는 편이 안전하다
    const normalized = normalizeHost(input.host)
    const host = normalized || input.host
    const row = this.repo.upsertAccount({ ...input, host })
    this.record('accounts', row.id, 'upsert')
    const types = this.repo.itemTypesByAccount()
    return {
      id: row.id,
      siteId: row.siteId,
      host: row.host,
      label: row.label,
      username: row.username,
      isDefault: row.isDefault,
      itemTypes: types.get(row.id) ?? [],
      urls: row.urls,
      agentAccess: row.agentAccess,
      tags: row.tags
    }
  }

  // 기존 항목이 있으면 덮어쓰고, 없으면 새로 만든다.
  // - input.id 를 주면 그 항목을 갱신한다(편집)
  // - 계정 항목은 (accountId, type) 이 키다(계정당 로그인 항목 1개)
  // - 전역 항목은 (type, label) 이 키다 — 같은 종류라도 라벨이 다르면 별개 항목이다
  // 새로 만들 때는 id 를 AAD 로 쓰기 위해 placeholder insert → fields update 순서를 한 트랜잭션에서 수행한다
  putItem(input: PutItemInput): VaultItemMeta {
    const key = this.requireKey()
    const now = Date.now()

    const meta = this.repo.transaction(() => {
      const existing = this.findExistingItem(input)
      const id =
        existing?.id ??
        this.repo.insertItemPlaceholder(input.accountId, input.type, input.label, now)
      const base = existing?.sections ?? []
      const sections = this.buildSections(key, id, input, base)
      this.repo.updateItemFields(id, sections, input.label, input.type, now)
      this.repo.insertAudit({
        itemId: id,
        accountId: input.accountId,
        action: 'save',
        source: 'user',
        jobId: input.jobId
      })
      return this.repo.itemMeta(id)
    })
    if (!meta) throw new Error(tr('vault.itemSaveFailed'))
    this.record('vault_items', meta.id, 'upsert')
    this.touch()
    return meta
  }

  /**
   * 저장 요청을 DB 에 넣을 섹션 구조로 바꾼다.
   * - sections 를 주면 그것으로 전체를 교체한다(값 없는 secret 필드는 기존 암호문 유지)
   * - value 만 주면 기본 섹션의 'value' 필드 하나만 upsert 한다(v1 호환 경로)
   */
  private buildSections(
    key: Buffer,
    id: number,
    input: PutItemInput,
    base: StoredSection[]
  ): StoredSection[] {
    if (!input.sections) {
      if (input.value === undefined) return base
      return upsertField(
        base,
        DEFAULT_SECTION_KEY,
        input.label,
        this.encryptField(key, id, {
          key: DEFAULT_FIELD_KEY,
          label: input.label,
          kind: 'secret',
          value: input.value
        }) ?? { key: DEFAULT_FIELD_KEY, label: input.label, kind: 'text' }
      )
    }
    return input.sections.map((section) => ({
      key: section.key,
      label: section.label,
      fields: section.fields.map((field): StoredField => {
        if (field.kind !== 'secret') {
          return {
            key: field.key,
            label: field.label,
            kind: field.kind,
            ...(field.value === undefined ? {} : { value: field.value })
          }
        }
        const encrypted = this.encryptField(key, id, field)
        if (encrypted) return encrypted
        // 값을 생략했으면 기존 암호문을 그대로 유지한다
        const previous = findField(base, field.key)
        if (previous && isSecretField(previous)) {
          return { ...previous, label: field.label }
        }
        // 기존 값도 없으면 값 없는 필드로 둔다(암호화할 평문이 없다)
        return { key: field.key, label: field.label, kind: 'text' }
      })
    }))
  }

  // value 가 있으면 필드별 AES-256-GCM 으로 암호화한다. 값이 없으면 null
  private encryptField(key: Buffer, id: number, field: PutFieldInput): StoredField | null {
    if (field.value === undefined) return null
    const blob = encrypt(key, field.value, newAad(id, field.key))
    return {
      key: field.key,
      label: field.label,
      kind: 'secret',
      ciphertext: blob.ciphertext.toString('base64'),
      iv: blob.iv.toString('base64')
    }
  }

  // putItem 이 덮어쓸 기존 항목을 찾는다(없으면 null → 새 항목을 만든다)
  private findExistingItem(input: PutItemInput): { id: number; sections: StoredSection[] } | null {
    if (input.id !== undefined) {
      const row = this.repo.getItemRow(input.id)
      if (!row) throw new Error(tr('vault.itemNotFound'))
      return row
    }
    if (input.accountId === null) return this.repo.findGlobalItemRow(input.type, input.label)
    // 결제 비밀번호는 계정당 여러 개다 — 같은 결제 수단일 때만 덮어쓰고, 아니면 새로 만든다
    if (input.type === 'password') {
      const provider = paymentProviderOfSections(input.sections ?? [])
      return this.repo.findPaymentItemRow(input.accountId, provider).row
    }
    return this.repo.findItemRow(input.accountId, input.type)
  }

  /**
   * 계정(들)과 딸린 항목을 지우고, 되돌리기용 스냅샷을 메모리에 60초 보관한다.
   * 스냅샷에는 암호문이 들어 있으므로 반환값에는 토큰과 개수만 담는다.
   */
  deleteAccounts(ids: number[]): { token: string; count: number } {
    this.requireKey()
    const snapshots: AccountSnapshot[] = []
    const deletedAt = Date.now()
    this.repo.transaction(() => {
      for (const id of ids) {
        const snapshot = this.repo.accountSnapshot(id)
        if (!snapshot) continue
        snapshots.push(snapshot)
        // 변경 로그의 삭제 스냅샷은 살아 있는 행에서 뜬다 — 반드시 표식을 찍기 전에 기록한다
        for (const item of snapshot.items) this.record('vault_items', item.id, 'delete')
        this.record('accounts', id, 'delete')
        // 행은 지우지 않고 삭제 표식만 찍는다(soft delete) — 다른 기기가 같은 계정을 새 원격 id 로
        // 다시 올려도 풀이 이 표식을 보고 되살리지 않는다
        this.repo.deleteAccountCascade(id)
        this.repo.insertAudit({ itemId: null, accountId: id, action: 'delete', source: 'user' })
      }
      return null
    })
    const token = randomBytes(16).toString('hex')
    const timer = setTimeout(() => this.undoBuffer.delete(token), UNDO_TTL_MS)
    timer.unref?.()
    this.undoBuffer.set(token, { snapshots, deletedAt, timer })
    this.touch()
    return { token, count: snapshots.length }
  }

  /**
   * 한 사이트(등록 도메인) 안에서 같은 아이디로 여러 서브도메인에 흩어진 계정을 하나로 합친다.
   * 남길 계정(항목 많은 것 → 기본 계정 → 먼저 만든 것)에 나머지 계정의 항목·주소·태그를 옮기고,
   * 호스트를 등록 도메인(예: a-rt.com — 모든 서브도메인에 맞는다)으로 바꾼 뒤 나머지를 지운다.
   * 지운 계정은 deleteAccounts 와 같은 되돌리기 토큰으로 60초 동안 되살릴 수 있다
   */
  mergeDomainAccounts(domain: string): { token: string | null; kept: number; removed: number } {
    this.requireKey()
    const key = accountGroupKey(domain) || domain
    const rows = this.repo.listAccounts().filter((a) => (accountGroupKey(a.host) || a.host) === key)
    const byUser = new Map<string, AccountRow[]>()
    for (const a of rows) byUser.set(a.username, [...(byUser.get(a.username) ?? []), a])
    const types = this.repo.itemTypesByAccount()
    const removeIds: number[] = []
    // 남길 계정의 이름·주소 바꾸기는 나머지를 지운 **뒤에** 한다. 지운 계정의 삭제 표식이 남긴 계정과
    // 같은 자연 키(예: a-rt.com)일 수 있는데, 남긴 계정의 수정 시각이 삭제보다 앞서면 다른 기기의 풀이
    // "삭제 뒤에 고친 적 없는 같은 계정" 으로 보고 함께 지운다
    const keeperUpdates: (() => void)[] = []
    let kept = 0
    this.repo.transaction(() => {
      for (const group of byUser.values()) {
        const [keeper, ...rest] = [...group].sort(
          (a, b) =>
            (types.get(b.id)?.length ?? 0) - (types.get(a.id)?.length ?? 0) ||
            Number(b.isDefault) - Number(a.isDefault) ||
            a.id - b.id
        )
        kept += 1
        const have = new Set<string>(types.get(keeper.id) ?? [])
        for (const other of rest) {
          for (const itemId of this.repo.moveItems(other.id, keeper.id, have)) {
            this.record('vault_items', itemId, 'upsert')
          }
          removeIds.push(other.id)
        }
        const urls = uniqueStrings(group.flatMap((a) => a.urls))
        const tags = uniqueStrings(group.flatMap((a) => a.tags))
        const changed =
          keeper.host !== key ||
          urls.length !== keeper.urls.length ||
          tags.length !== keeper.tags.length ||
          rest.some((a) => a.isDefault)
        if (changed) {
          keeperUpdates.push(() => {
            this.repo.upsertAccount({
              id: keeper.id,
              host: key,
              username: keeper.username,
              urls,
              tags,
              isDefault: keeper.isDefault || rest.some((a) => a.isDefault)
            })
            this.record('accounts', keeper.id, 'upsert')
          })
        }
      }
      return null
    })
    const del = removeIds.length > 0 ? this.deleteAccounts(removeIds) : null
    if (keeperUpdates.length > 0) {
      this.repo.transaction(() => {
        for (const update of keeperUpdates) update()
        return null
      })
    }
    if (!del) {
      this.touch()
      return { token: null, kept, removed: 0 }
    }
    this.repo.insertAudit({ itemId: null, accountId: null, action: 'merge', source: 'user' })
    return { token: del.token, kept, removed: del.count }
  }

  /** 되돌리기 — 보관 중인 스냅샷을 원래 id 그대로 복원한다. 만료됐으면 false */
  undoDeleteAccounts(token: string): boolean {
    const entry = this.undoBuffer.get(token)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.undoBuffer.delete(token)
    if (!this.key) return false
    this.repo.transaction(() => {
      for (const snapshot of entry.snapshots) {
        this.repo.restoreSnapshot(snapshot)
        // 되살린 행은 **새 원격 id** 로 올린다. 옛 원격 id 의 삭제 표식은 이미 다른 기기에 퍼졌을 수
        // 있고, 같은 id 로 살아 있는 행을 올리면 그 기기들은 삭제가 이긴다고 보고 다시 지운다.
        // 옛 id 에는 삭제 표식을 (다시) 올려 두 행이 함께 살아 있는 일이 없게 한다
        this.recordOldRemoteTombstones(snapshot, entry.deletedAt)
        this.record('accounts', snapshot.account.id, 'upsert')
        for (const item of snapshot.items) this.record('vault_items', item.id, 'upsert')
      }
      return null
    })
    this.touch()
    return true
  }

  deleteItem(id: number): void {
    this.requireKey()
    // 삭제 전에 계정 id 를 스냅샷으로 떠 둔다 — 삭제 후에는 vault_items 조인이 안 되어
    // 계정별 사용 기록에서 삭제 기록 자체가 보이지 않았다
    const meta = this.repo.itemMeta(id)
    // 변경 로그의 삭제 스냅샷은 살아 있는 행에서 뜬다 — 반드시 표식을 찍기 전에 기록한다
    this.record('vault_items', id, 'delete')
    // 행은 남기고 삭제 표식만 찍는다(soft delete)
    this.repo.deleteItem(id)
    this.repo.insertAudit({
      itemId: id,
      accountId: meta?.accountId ?? null,
      action: 'delete',
      source: 'user'
    })
    this.touch()
  }

  // 사용자가 "보기" 를 눌렀을 때만 호출된다. 평문을 돌려주는 유일한 사용자 경로.
  // fieldKey 를 생략하면 단일 값 항목의 기본 필드('value')를 본다
  /**
   * 한 계정의 결제 비밀번호 항목들을 다른 계정으로 복사한다(같은 사람의 두 계정이 같은
   * 결제 비밀번호를 쓸 때). 평문은 이 메서드 안에서 복호화 → 재암호화로만 흐르고 반환값·로그에
   * 남지 않는다. 대상 계정에 같은 결제 수단 항목이 이미 있으면 건너뛴다. 복사한 개수를 돌려준다
   */
  copyPaymentItems(fromAccountId: number, toAccountId: number): number {
    const key = this.requireKey()
    if (fromAccountId === toAccountId) return 0
    const sources = this.repo.listPaymentItemRows(fromAccountId)
    const existing = new Set(
      this.repo.listPaymentItemRows(toAccountId).map((r) => paymentProviderOfSections(r.sections))
    )
    let copied = 0
    for (const row of sources) {
      const provider = paymentProviderOfSections(row.sections)
      if (existing.has(provider)) continue
      const sections: PutSectionInput[] = row.sections.map((section) => ({
        key: section.key,
        label: section.label,
        fields: section.fields.map((field): PutFieldInput => {
          if (!isSecretField(field)) {
            return {
              key: field.key,
              label: field.label,
              kind: field.kind,
              ...(field.value === undefined ? {} : { value: field.value })
            }
          }
          const plain = decrypt(
            key,
            Buffer.from(field.ciphertext, 'base64'),
            Buffer.from(field.iv, 'base64'),
            aadFor(row.id, field)
          )
          return { key: field.key, label: field.label, kind: 'secret', value: plain }
        })
      }))
      this.putItem({
        accountId: toAccountId,
        type: 'password',
        label: row.label,
        sections,
        jobId: 'copy-payment'
      })
      existing.add(provider)
      copied += 1
    }
    return copied
  }

  reveal(id: number, fieldKey: string = DEFAULT_FIELD_KEY): string {
    const key = this.requireKey()
    const row = this.repo.getItemRow(id)
    if (!row) throw new Error(tr('vault.itemNotFound'))
    const field = findField(row.sections, fieldKey)
    if (!field || !isSecretField(field)) throw new Error(tr('vault.secretFieldNotFound'))
    const plain = decrypt(
      key,
      Buffer.from(field.ciphertext, 'base64'),
      Buffer.from(field.iv, 'base64'),
      aadFor(row.id, field)
    )
    this.repo.insertAudit({
      itemId: id,
      accountId: row.accountId,
      action: 'reveal',
      source: 'user'
    })
    this.touch()
    return plain
  }

  /**
   * 자동 채움용 평문 조회 — **메인 프로세스 내부에서만** 호출한다.
   * IPC 로 노출하지 않으며, 반환값은 격리 월드 인자로만 전달된다.
   * fieldKey 로 항목 안의 개별 필드(예: 'card.number')를 지정한다.
   * source 는 감사 로그에 남길 주체다('ai' | 'user') — 사용자가 누른 자동 채우기는 'user'
   */
  getSecretForFill(
    accountId: number,
    type: VaultItemType,
    fieldKey: string = DEFAULT_FIELD_KEY,
    jobId?: string,
    source: 'ai' | 'user' = 'ai',
    provider?: PaymentProvider
  ): string | null {
    // 결제 비밀번호는 계정당 여러 개일 수 있어 제공자별 조회 경로를 탄다
    if (type === 'password') {
      return this.getPaymentSecretForFill({ accountId, provider, fieldKey, jobId, source }).value
    }
    if (!this.key) return null
    const row = this.repo.findItemRow(accountId, type)
    const own = row ? this.decryptForFill(row, fieldKey, jobId, source) : null
    if (own !== null) return own
    // 신원정보는 "나"의 것이라 계정마다 같다 — 계정에 없으면 전역 신원정보에서 찾는다.
    // (직배 배송지의 CS 연락처를 구매 계정마다 다시 적지 않게. 카드·로그인은 계정에 묶인 값이라 넘겨 쓰지 않는다)
    if (type !== 'identity') return null
    for (const shared of this.repo.findGlobalItemRowsByType(type)) {
      const value = this.decryptForFill(shared, fieldKey, jobId, source)
      if (value !== null) return value
    }
    return null
  }

  /**
   * 계정의 결제 비밀번호 항목을 찾는다. 앱 계정 자신(naver.com 계정)에 저장된 항목은 결제 수단이 "이 사이트"(site)로
   * 돼 있어도 그 앱의 결제 비밀번호다(실기 13차: 네이버 계정의 항목이 site 라 네이버페이 조회가 not-found) —
   * 결제 수단으로 못 찾으면 그 계정이 그 결제 수단의 앱 계정일 때만 site 항목으로 다시 찾는다
   */
  private findPaymentRowFor(accountId: number, provider?: PaymentProvider): PaymentItemLookup {
    const found = this.repo.findPaymentItemRow(accountId, provider)
    if (found.row || !provider || provider === 'site') return found
    const appHost = PAYMENT_PROVIDER_ACCOUNT_HOST[provider]
    if (!appHost) return found
    const account = this.repo.getAccount(accountId)
    if (!account || accountGroupKey(account.host) !== appHost) return found
    return this.repo.findPaymentItemRow(accountId, 'site')
  }

  /** 계정에 그 결제 수단의 결제 비밀번호 항목(직접 값 또는 앱 계정 연결)이 있는가. 복호화하지 않는다 */
  hasPaymentItem(accountId: number, provider: PaymentProvider): boolean {
    return this.findPaymentRowFor(accountId, provider).row !== null
  }

  /**
   * 이 결제 수단으로 결제될 앱 계정의 아이디(네이버페이면 네이버 아이디). 결제창이 그 계정으로 로그인돼 있는지
   * 맞춰 볼 때 쓴다. 쇼핑몰 계정의 항목이면 연결된 아이디, 계정 자체가 앱 사이트(naver.com) 계정이면 제 아이디.
   * 앱 계정이 따로 없는 결제 수단(토스 등)이나 항목이 없으면 null
   */
  paymentAccountUsername(accountId: number, provider: PaymentProvider): string | null {
    const appHost = PAYMENT_PROVIDER_ACCOUNT_HOST[provider]
    if (!appHost) return null
    const account = this.repo.getAccount(accountId)
    if (!account) return null
    if (accountGroupKey(account.host) === appHost) return account.username
    const found = this.findPaymentRowFor(accountId, provider)
    if (!found.row) return null
    return paymentAccountOfSections(found.row.sections)
  }

  /**
   * 결제 비밀번호 항목이 앱 계정 연결(payment.account)이면 그 앱 계정의 같은 결제 수단 항목을 돌려준다.
   * 연결이 아니면(값을 직접 넣은 옛 항목) null, 연결인데 그 계정·항목이 없으면 'missing'.
   * 연결은 한 단계만 따라간다(앱 계정 항목이 또 연결이어도 더 가지 않는다)
   */
  private linkedPaymentRow(row: VaultItemRow): VaultItemRow | null | 'missing' {
    const username = paymentAccountOfSections(row.sections)
    if (username === null) return null
    const secret = findField(row.sections, DEFAULT_FIELD_KEY)
    // 값을 직접 넣어 둔 항목은 연결보다 그 값이 우선이다
    if (secret && isSecretField(secret)) return null
    const provider = paymentProviderOfSections(row.sections)
    const appHost = PAYMENT_PROVIDER_ACCOUNT_HOST[provider]
    if (!appHost) return 'missing'
    // 네이버는 서브도메인마다 다른 계정(nid / accounts.commerce / mail)이 같은 아이디일 수 있다 —
    // 그 아이디 중 이 결제 수단의 비밀번호를 실제로 가진 계정을 고른다
    for (const target of this.matchAccountRows(appHost).filter((a) => a.username === username)) {
      const found = this.findPaymentRowFor(target.id, provider)
      if (!found.row) continue
      const targetSecret = findField(found.row.sections, DEFAULT_FIELD_KEY)
      if (targetSecret && isSecretField(targetSecret)) return found.row
    }
    return 'missing'
  }

  /**
   * 결제 비밀번호 전용 조회 — **메인 프로세스 내부에서만** 호출한다.
   * provider 를 주면 그 결제 수단의 항목만 본다. 주지 않았는데 계정에 결제 비밀번호가
   * 둘 이상이면 'ambiguous' 로 거부한다(임의로 고르면 잘못 눌러 계정이 잠긴다)
   */
  getPaymentSecretForFill(args: {
    accountId: number
    provider?: PaymentProvider
    fieldKey?: string
    jobId?: string
    source?: 'ai' | 'user'
  }): PaymentSecretResult {
    if (!this.key) return { value: null, reason: 'locked' }
    const found = this.findPaymentRowFor(args.accountId, args.provider)
    if (!found.row) return { value: null, reason: found.reason }
    // 쇼핑몰 계정의 항목이 "네이버 계정 mjkim88 의 비밀번호를 쓴다"는 연결이면 그 앱 계정의 항목으로 간다
    const linked = this.linkedPaymentRow(found.row)
    if (linked === 'missing') return { value: null, reason: 'not-found' }
    const plain = this.decryptForFill(
      linked ?? found.row,
      args.fieldKey ?? DEFAULT_FIELD_KEY,
      args.jobId,
      args.source ?? 'ai'
    )
    if (plain === null) return { value: null, reason: 'not-found' }
    return { value: plain }
  }

  // 행 하나에서 secret 필드를 복호화하고 'fill' 감사 로그를 남긴다(평문은 반환값으로만 나간다)
  private decryptForFill(
    row: VaultItemRow,
    fieldKey: string,
    jobId: string | undefined,
    source: 'ai' | 'user'
  ): string | null {
    if (!this.key) return null
    const field = findField(row.sections, fieldKey)
    if (!field) return null
    // 비밀이 아닌 필드(신원정보의 휴대폰·생년월일·이름 등)는 평문으로 저장돼 있다 — 그대로 채운다.
    // 토스페이 결제창이 휴대폰 번호·생년월일을 요구하는데, 이 경로가 없어 "not found" 로 끝났다(실기)
    if (!isSecretField(field)) {
      if (field.value === undefined || field.value === '') return null
      this.repo.insertAudit({
        itemId: row.id,
        accountId: row.accountId,
        action: 'fill',
        source,
        jobId
      })
      return field.value
    }
    try {
      const plain = decrypt(
        this.key,
        Buffer.from(field.ciphertext, 'base64'),
        Buffer.from(field.iv, 'base64'),
        aadFor(row.id, field)
      )
      this.repo.insertAudit({
        itemId: row.id,
        accountId: row.accountId,
        action: 'fill',
        source,
        jobId
      })
      this.touch()
      return plain
    } catch {
      return null
    }
  }

  /**
   * capture 로 감지된 (host, username, password) 가 이미 저장된 로그인 비밀번호와 같은지 확인한다.
   * 같으면 저장 제안을 다시 띄우지 않기 위해 쓴다. 잠겨 있거나 계정이 없으면 false.
   */
  hasSameSecret(host: string, username: string, password: string): boolean {
    if (!this.key) return false
    const normalized = normalizeHost(host) || host
    const account = this.matchAccountRows(normalized).find((a) => a.username === username)
    if (!account) return false
    const row = this.repo.findItemRow(account.id, 'login')
    if (!row) return false
    const field = findField(row.sections, DEFAULT_FIELD_KEY)
    if (!field || !isSecretField(field)) return false
    try {
      const stored = decrypt(
        this.key,
        Buffer.from(field.ciphertext, 'base64'),
        Buffer.from(field.iv, 'base64'),
        aadFor(row.id, field)
      )
      // 타이밍 오라클 방지: 길이가 다르면 즉시 false, 같으면 상수 시간 비교
      const a = Buffer.from(stored, 'utf8')
      const b = Buffer.from(password, 'utf8')
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  /**
   * 잠금 해제 상태에서 마스터 비밀번호를 한 번 더 확인한다(내보내기 같은 위험 작업 전용).
   * 저장된 salt·kdf_params 로 키를 다시 유도해 verifier 를 확인하고, 현재 들고 있는
   * 마스터 키와 상수 시간으로 비교한다. 잠겨 있으면 항상 false 다
   */
  async verifyMaster(master: string): Promise<boolean> {
    if (!this.key) return false
    const salt = this.repo.getMeta(META_SALT)
    const ct = this.repo.getMeta(META_VERIFIER_CT)
    const iv = this.repo.getMeta(META_VERIFIER_IV)
    if (!salt || !ct || !iv) return false

    const params = this.readKdfParams()
    const candidate = await deriveKey(master, salt, {
      memoryKiB: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism
    })
    try {
      if (!checkVerifier(candidate, { ciphertext: ct, iv })) return false
      if (candidate.length !== this.key.length) return false
      return timingSafeEqual(candidate, this.key)
    } finally {
      zeroize(candidate)
    }
  }

  /**
   * 내보내기용 평문 행 목록 — **메인 프로세스 내부에서만** 호출한다.
   * IPC 로 노출하지 않으며, 호출부(export.ts)가 파일을 쓴 직후 배열을 비운다.
   * 복호화에 실패한 필드는 조용히 건너뛴다(항목 자체는 살린다)
   */
  exportRows(): ExportRow[] {
    const key = this.requireKey()
    const accounts = new Map(this.repo.listAccounts().map((a) => [a.id, a]))
    const rows: ExportRow[] = []

    // 계정별 항목 + 계정에 딸리지 않은 전역 항목(accountId = null)
    const itemIds = [
      ...[...accounts.keys()].flatMap((id) => this.repo.listItems(id).map((m) => m.id)),
      ...this.repo.listItems(null).map((m) => m.id)
    ]

    for (const itemId of itemIds) {
      const item = this.repo.getItemRow(itemId)
      if (!item) continue
      const account = item.accountId === null ? undefined : accounts.get(item.accountId)
      const fields: Record<string, string> = {}
      for (const section of item.sections) {
        for (const field of section.fields) {
          if (!isSecretField(field)) {
            if (field.value !== undefined) fields[field.key] = field.value
            continue
          }
          try {
            fields[field.key] = decrypt(
              key,
              Buffer.from(field.ciphertext, 'base64'),
              Buffer.from(field.iv, 'base64'),
              aadFor(item.id, field)
            )
          } catch {
            // 이 필드만 건너뛴다
          }
        }
      }
      rows.push({
        type: item.type,
        label: account?.label || item.label,
        host: account?.host ?? '',
        url: account?.urls[0] ?? '',
        username: account?.username ?? '',
        note: fields.note ?? '',
        fields
      })
    }
    return rows
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error(tr('vault.locked'))
    return this.key
  }

  // --- 로그인 성공 감지 자동 갱신 ------------------------------------------

  /**
   * 로그인 성공을 감지했을 때, 묻지 않고 저장된 로그인 비밀번호를 새 값으로 갱신한다.
   * 갱신 전 값을 60초간 메모리에 보관해 되돌리기(undoAutoPasswordUpdate)를 지원한다.
   * 기존 항목이 없으면(드문 경우) 새로 만들고, 되돌리기 시에는 그 항목을 지운다.
   */
  applyAutoPasswordUpdate(input: { accountId: number; username: string; value: string }): {
    undoToken: string
  } {
    const key = this.requireKey()
    // v2 구조: 로그인 항목의 기본 secret 필드('value')에서 갱신 전 값을 읽는다
    const existing = this.repo.findItemRow(input.accountId, 'login')
    const existingField = existing ? findField(existing.sections, DEFAULT_FIELD_KEY) : null
    const oldValue =
      existing && existingField && isSecretField(existingField)
        ? decrypt(
            key,
            Buffer.from(existingField.ciphertext, 'base64'),
            Buffer.from(existingField.iv, 'base64'),
            aadFor(existing.id, existingField)
          )
        : null
    // DB 에 저장·동기화되는 항목 이름이라 앱 언어와 무관하게 고정(가져오기·IPC 저장과 같은 값)
    const label =
      (existing ? this.repo.itemMeta(existing.id)?.label : undefined) ?? '로그인 비밀번호'

    const meta = this.putItem({
      id: existing?.id,
      accountId: input.accountId,
      type: 'login',
      label,
      value: input.value,
      jobId: 'auto-update'
    })

    const undoToken = randomBytes(16).toString('hex')
    const expiresAt = Date.now() + UNDO_TTL_MS
    this.pendingUndos.set(undoToken, {
      itemId: meta.id,
      accountId: input.accountId,
      label,
      oldValue,
      hadExistingItem: !!existing,
      expiresAt
    })
    const timer = setTimeout(() => this.pendingUndos.delete(undoToken), UNDO_TTL_MS)
    timer.unref?.()

    return { undoToken }
  }

  /**
   * applyAutoPasswordUpdate() 가 남긴 되돌리기 토큰으로 갱신 전 값을 복원한다.
   * 토큰이 없거나 만료됐거나 금고가 잠겨 있으면 false.
   */
  undoAutoPasswordUpdate(token: string): boolean {
    const pending = this.pendingUndos.get(token)
    if (!pending) return false
    this.pendingUndos.delete(token)
    if (Date.now() > pending.expiresAt) return false
    if (!this.key) return false

    if (pending.hadExistingItem && pending.oldValue !== null) {
      this.putItem({
        id: pending.itemId,
        accountId: pending.accountId,
        type: 'login',
        label: pending.label,
        value: pending.oldValue,
        jobId: 'undo-auto-update'
      })
    } else {
      this.deleteItem(pending.itemId)
    }
    return true
  }

  // --- 저장 제안(capture) -------------------------------------------------

  // 저장 제안 카드를 띄울 구독자(=IPC 핸들러)를 등록한다. 비밀번호는 전달되지 않는다
  onCapturePrompt(cb: (prompt: CapturePromptDto) => void): () => void {
    this.captureListeners.add(cb)
    return () => {
      this.captureListeners.delete(cb)
    }
  }

  setPendingCapture(capture: PendingCapture): void {
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.pending = { ...capture, expiresAt: Date.now() + CAPTURE_TTL_MS }
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined
      this.pending = null
    }, CAPTURE_TTL_MS)
    this.captureTimer.unref?.()
    const prompt = this.pendingCapturePrompt()
    if (prompt) for (const cb of this.captureListeners) cb(prompt)
  }

  // 렌더러에 보여줄 정보(비밀번호 제외, 아이디는 가린 값)
  pendingCapturePrompt(): CapturePromptDto | null {
    if (!this.pending || Date.now() > this.pending.expiresAt) return null
    return toCapturePrompt(this.pending)
  }

  // 한 번 가져가면 즉시 비운다(메모리에 남기지 않는다)
  takePendingCapture(): PendingCapture | null {
    const pending = this.pending
    this.pending = null
    if (this.captureTimer) {
      clearTimeout(this.captureTimer)
      this.captureTimer = undefined
    }
    if (!pending) return null
    if (Date.now() > pending.expiresAt) return null
    const { host, username, password, isNew, locked, profile } = pending
    return { host, username, password, isNew, locked, ...(profile ? { profile } : {}) }
  }
}

/** base64 문자열을 버퍼로. 값이 없거나 형식이 아니면 null */
function fromBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
  const buf = Buffer.from(value, 'base64')
  return buf.length > 0 ? buf : null
}

/**
 * 원격에서 받은 키 재료 세 키를 검사해 버퍼로 푼다.
 * 하나라도 빠졌거나 형식이 어긋나면 null — 반쪽만 심어 금고를 못 여는 상태를 만들지 않는다
 */
interface RemoteKeyMaterial {
  salt: Buffer
  kdf: KdfParams
  verifierCt: Buffer
  verifierIv: Buffer
}

function parseKeyMaterial(values: Partial<Record<VaultKeySyncKey, string>>): {
  salt: Buffer
  kdf: KdfParams
  verifierCt: Buffer
  verifierIv: Buffer
} | null {
  const salt = fromBase64(values['vault.salt'])
  if (!salt || salt.length !== SALT_BYTES) return null

  const rawVerifier = values['vault.verifier']
  const rawKdf = values['vault.kdf']
  if (typeof rawVerifier !== 'string' || typeof rawKdf !== 'string') return null

  let verifier: unknown
  let kdf: unknown
  try {
    verifier = JSON.parse(rawVerifier)
    kdf = JSON.parse(rawKdf)
  } catch {
    return null
  }
  if (typeof verifier !== 'object' || verifier === null) return null
  if (typeof kdf !== 'object' || kdf === null) return null

  const { ct, iv } = verifier as { ct?: unknown; iv?: unknown }
  const verifierCt = fromBase64(ct)
  const verifierIv = fromBase64(iv)
  if (!verifierCt || !verifierIv) return null

  // 원격 값이 변조돼도 허용 범위를 벗어나지 못하게 한다(unlock 의 readKdfParams 와 같은 규칙)
  const p = kdf as Partial<KdfParams>
  const fallback = resolveDefaultKdfParams()
  return {
    salt,
    kdf: {
      memoryKiB: typeof p.memoryKiB === 'number' ? clampMemoryKiB(p.memoryKiB) : fallback.memoryKiB,
      iterations:
        typeof p.iterations === 'number' ? clampIterations(p.iterations) : fallback.iterations,
      parallelism:
        typeof p.parallelism === 'number' ? clampParallelism(p.parallelism) : fallback.parallelism
    },
    verifierCt,
    verifierIv
  }
}
