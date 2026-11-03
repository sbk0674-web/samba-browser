// vault:capture(격리 월드 preload → 메인) 메시지의 검증·레이트리밋·저장 제안 판단 전담 모듈.
// electron 의존이 없어 테스트에서 그대로 호출할 수 있다.
//
// 메인 프로세스는 페이지가 보낸 값을 신뢰하지 않는다:
// - 발신자가 실제 탭의 webContents 인지(위조 발신자 차단)
// - 발신 프레임의 URL 호스트와 payload 의 host 가 같은 사이트인지(호스트 위조 차단)
// - https 페이지인지, 제외 도메인·'묻지 않기' 사이트가 아닌지
// - 사람이 친 값인지(자동화·키마스터 자동 채움이 넣은 값의 제출은 받지 않는다)
// - sender 당 30초에 3회까지만(preload 레이트리밋 우회 대비)
// 통과하면 로그인 성공을 지켜본 뒤에만 확인 바를 띄운다(틀린 비밀번호를 저장하자고 하지 않게).
// 어떤 경우에도 비밀번호 값 자체는 로그·반환값에 남기지 않는다.

import { z } from 'zod'
import { normalizeHost, registrableDomain } from '../../shared/host'
import type { VaultState } from '../../shared/vault'
import { isHostExcluded, isSecurePageUrl } from '../vault/access-gate'
import { classifyCapture } from '../vault/login-capture'

export const captureSchema = z.object({
  host: z.string().min(1).max(512),
  username: z.string().max(512),
  password: z.string().min(1).max(512)
})

export const CAPTURE_WINDOW_MS = 30_000
export const CAPTURE_MAX_PER_WINDOW = 3

// 메인에 잠시 보관할 제출 정보(비밀번호 포함). 메인 메모리 밖으로 나가지 않는다
export interface CaptureCandidateInput {
  host: string
  username: string
  password: string
  isNew: boolean
  locked: boolean
  profile?: string
}

// VaultService 중 capture 경로에서 실제로 쓰는 부분만 좁힌 인터페이스
export interface CaptureVaultLike {
  state: () => VaultState
  hasSameSecret: (host: string, username: string, password: string) => boolean
  listAccounts: (host?: string) => { id?: number; username: string }[]
  setPendingCapture: (capture: CaptureCandidateInput) => void
}

// ipcMain 이벤트에서 뽑아낸, 신뢰 판단에 필요한 정보
export interface CaptureSender {
  // tabs.hasWebContents(e.sender) — 실제 탭의 webContents 인가
  trusted: boolean
  // e.senderFrame?.url — 메시지를 보낸 프레임의 실제 URL(확인 불가면 빈 문자열)
  frameUrl: string
  // 탭 최상위 문서의 URL(e.sender.getURL()). 주면 발신 프레임이 그와 같은 등록 도메인이어야 받는다 —
  // iframe 로그인 폼은 받되 광고·제3자 iframe 의 제출은 버린다. 없으면(테스트·예전 호출부) 검사하지 않는다
  topUrl?: string
  // 발신 프레임이 하위 프레임이면 그 프레임(로그인 성공 감시가 그 프레임의 비밀번호 칸을 본다). 최상위면 없다
  subFrame?: object
}

// 처리 결과. 값(비밀번호)은 절대 담지 않는다
export type CaptureOutcome =
  // 확인 바를 띄웠다(또는 잠긴 금고라 잠금 해제 요청 바를 띄웠다)
  | 'accepted'
  | 'untrusted-sender'
  | 'rate-limited'
  | 'invalid'
  | 'host-mismatch'
  // 발신 프레임이 탭 최상위 문서와 다른 사이트(제3자 iframe)
  | 'cross-site-frame'
  // https 가 아닌 페이지(로컬 개발 서버 제외)
  | 'insecure-page'
  | 'excluded'
  // 사용자가 '이 사이트는 묻지 않기'를 고른 사이트
  | 'never-save'
  // 자동화·키마스터 자동 채움이 넣은 값의 제출
  | 'automation'
  // 아이디 칸이 비어 있다(저장해도 자동 채움에 쓸 수 없다)
  | 'no-username'
  | 'duplicate'
  // 로그인 성공을 지켜보는 중 — 성공하면 그때 판정한다
  | 'watching'
  // '묻지 않고 자동 저장'이 켜져 있어 바로 저장했다
  | 'auto-saved'

export interface VaultCaptureGateDeps {
  vault: CaptureVaultLike
  // 제외 도메인(설정에서 매번 최신 값을 읽는다)
  excludedHosts: () => string[]
  // '이 사이트는 묻지 않기' 목록(설정에서 매번 최신 값을 읽는다). 없으면 빈 목록
  neverSaveHosts?: () => string[]
  // 테스트에서 시간 흐름을 제어하기 위한 주입점
  now?: () => number
  // 이 sender(탭)의 최근 입력이 기계(자동화·자동 채움)가 넣은 것인가. 없으면 사람 입력으로 본다
  machineFilled?: (senderKey: object) => boolean
  // 이 sender(탭)의 프로필 이름(새 계정 라벨용)
  profileOf?: (senderKey: object) => string | undefined
  // 로그인 성공 감시. 없으면 곧바로 성공으로 본다(테스트·동기 경로).
  // onSettled 는 정확히 한 번 불려야 한다 — false 면 보관 중이던 값을 버린다(reason 은 로그용 짧은 영문 사유).
  // subFrame 은 제출이 하위 프레임(iframe 로그인)에서 왔을 때 그 프레임
  watchLogin?: (
    senderKey: object,
    onSettled: (success: boolean, reason?: string) => void,
    subFrame?: object
  ) => void
  // 원인 파악용 로그 한 줄(호스트·단계·사유만 — 값·아이디는 절대 넣지 않는다). 없으면 남기지 않는다
  log?: (line: string) => void
  // '묻지 않고 자동 저장'(설정). 새 계정은 반드시 확인 바를 띄우고, 기존 계정 갱신에만 쓴다
  autoSaveEnabled?: () => boolean
  // 자동 저장을 실행한다(잠금 해제 상태에서만 불린다). 같은 값이라 저장할 게 없으면 false,
  // 저장이 실패하면 'error' — 그때는 값을 버리지 않고 확인 바로 한 번 묻는다
  autoSave?: (capture: CaptureCandidateInput) => boolean | 'error'
}

export class VaultCaptureGate {
  // sender(webContents) 별 최근 전송 시각. WeakMap 이라 탭이 닫히면 함께 사라진다
  private readonly sentAt = new WeakMap<object, number[]>()

  constructor(private readonly deps: VaultCaptureGateDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private isRateLimited(senderKey: object): boolean {
    const now = this.now()
    const timestamps = (this.sentAt.get(senderKey) ?? []).filter((t) => now - t < CAPTURE_WINDOW_MS)
    if (timestamps.length >= CAPTURE_MAX_PER_WINDOW) {
      this.sentAt.set(senderKey, timestamps)
      return true
    }
    timestamps.push(now)
    this.sentAt.set(senderKey, timestamps)
    return false
  }

  private log(host: string, stage: string): void {
    try {
      this.deps.log?.(`[로그인 저장] ${host || '(호스트 모름)'} ${stage}`)
    } catch {
      // 로그 실패는 무시한다
    }
  }

  /** 한 건의 vault:capture 메시지를 처리한다. 결과(버린 이유 포함)를 호스트와 함께 로그에 남긴다 */
  handle(senderKey: object, sender: CaptureSender, raw: unknown): CaptureOutcome {
    const outcome = this.evaluate(senderKey, sender, raw)
    this.log(normalizeHost(sender.frameUrl), `제출 감지 → ${outcome}`)
    return outcome
  }

  private evaluate(senderKey: object, sender: CaptureSender, raw: unknown): CaptureOutcome {
    // 발신자가 실제 탭의 webContents 가 아니면 무시(위조 발신자 방지)
    if (!sender.trusted) return 'untrusted-sender'
    if (this.isRateLimited(senderKey)) return 'rate-limited'

    const parsed = captureSchema.safeParse(raw)
    if (!parsed.success) return 'invalid'
    const { host: rawHost, password } = parsed.data
    const username = parsed.data.username.trim()

    // payload 의 host 는 페이지가 준 값이므로, 발신 프레임의 실제 URL 과 반드시 대조한다.
    // 프레임 URL 을 알 수 없으면(빈 문자열) 검증할 수 없으므로 받지 않는다.
    // iframe 등으로 같은 사이트의 다른 서브도메인(예: 로그인 서브도메인)에서 캡처가 오는 경우가
    // 있으므로, 정확 일치가 아니어도 등록 도메인(eTLD+1)이 같으면 허용한다
    const frameHost = normalizeHost(sender.frameUrl)
    const host = normalizeHost(rawHost) || rawHost
    if (
      !frameHost ||
      (frameHost !== host && registrableDomain(frameHost) !== registrableDomain(host))
    ) {
      return 'host-mismatch'
    }
    // 하위 프레임의 제출은 탭 최상위 문서와 같은 사이트(등록 도메인)일 때만 받는다
    if (sender.topUrl !== undefined) {
      const topHost = normalizeHost(sender.topUrl)
      if (
        !topHost ||
        (topHost !== frameHost && registrableDomain(topHost) !== registrableDomain(frameHost))
      ) {
        return 'cross-site-frame'
      }
    }

    // 평문(http) 페이지의 값은 받지 않는다(자동 채움과 같은 기준 — 로컬 개발 서버만 예외)
    if (!isSecurePageUrl(sender.frameUrl)) return 'insecure-page'

    // 제외 도메인·'묻지 않기' 사이트면 제안 자체를 띄우지 않는다(같은 등록 도메인이면 서브도메인도 포함)
    if (isHostExcluded(host, this.deps.excludedHosts())) return 'excluded'
    if (isHostExcluded(host, this.deps.neverSaveHosts?.() ?? [])) return 'never-save'

    // 자동화·자동 채움이 넣은 값의 제출은 사람의 새 자격증명이 아니다
    if (this.deps.machineFilled?.(senderKey)) return 'automation'

    // 아이디 없이 비밀번호만 있으면 저장해도 어느 계정인지 알 수 없다
    if (!username) return 'no-username'

    const profile = this.deps.profileOf?.(senderKey)
    const candidate = { host, username, password, ...(profile ? { profile } : {}) }

    if (!this.deps.watchLogin) return this.decide(candidate)
    // 로그인 성공을 확인한 뒤에만 판정한다. 값은 이 클로저에만 머물고 실패·시간 초과면 함께 버려진다
    this.deps.watchLogin(
      senderKey,
      (success, reason) => {
        if (!success) {
          this.log(host, `로그인 성공 확인 실패 → 버림(${reason ?? 'failure'})`)
          return
        }
        const decided = this.decide(candidate)
        this.log(host, `로그인 성공(${reason ?? 'success'}) → ${decided}`)
      },
      sender.subFrame
    )
    return 'watching'
  }

  /** 로그인이 성공한 제출을 판정해 확인 바를 띄우거나(또는 자동 저장) 버린다 */
  private decide(c: {
    host: string
    username: string
    password: string
    profile?: string
  }): CaptureOutcome {
    const vault = this.deps.vault
    if (vault.state() !== 'unlocked') {
      // 잠긴 상태에서는 기존 계정·값을 확인할 수 없다. locked 를 함께 넘겨
      // 확인 바가 "새 계정" 이라고 단정하지 않고 잠금 해제를 먼저 요청하게 한다
      vault.setPendingCapture({ ...c, isNew: true, locked: true })
      return 'accepted'
    }
    const verdict = classifyCapture(
      vault.listAccounts(c.host),
      c.username,
      vault.hasSameSecret(c.host, c.username, c.password)
    )
    // 같은 값이면 아무것도 묻지 않는다
    if (verdict.kind === 'same') return 'duplicate'
    const candidate = { ...c, isNew: verdict.kind === 'new', locked: false }
    if (verdict.kind !== 'new' && this.deps.autoSaveEnabled?.() && this.deps.autoSave) {
      const saved = this.deps.autoSave(candidate)
      if (saved === true) return 'auto-saved'
      if (saved === false) return 'duplicate'
    }
    vault.setPendingCapture(candidate)
    return 'accepted'
  }
}
