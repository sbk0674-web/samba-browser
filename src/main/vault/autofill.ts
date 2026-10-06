// 사용자 조작(상세 화면의 '자동 채우기' 버튼, 페이지 내 피커)으로 시작하는 자동 채움.
// AI 도구를 거치지 않고 메인이 직접 탭에 값을 넣는다 — 값은 IPC 로 나가지 않는다.

import { markHuman } from '../browser/human-activity'
import { pageBridge } from '../browser/page-bridge'
import type { Tab } from '../browser/tab-manager'
import type { VaultService } from './service'
import { checkVaultGate, isSecurePageUrl, sameRegistrableDomain } from './access-gate'
import { normalizeHost } from '../../shared/host'
import { DEFAULT_FIELD_KEY } from './fields'

// 결과 문자열. 값(평문)은 어떤 경우에도 담기지 않는다
export type AutofillResult =
  | 'ok'
  | 'filled-password-only'
  // 2단계 로그인의 첫 화면(아이디 칸만) — 아이디를 채워 넘겼고 비밀번호 칸이 나오면 이어서 채운다
  | 'filled-username-only'
  | 'no-active-tab'
  | 'locked'
  | 'insecure-page'
  | 'excluded'
  | 'host-mismatch'
  | 'account-not-found'
  | 'fields-not-found'
  | 'secret-not-found'
  | 'fill-failed'

export interface AutofillDeps {
  vault: VaultService
  activeTab: () => Tab | null
  excludedHosts: () => string[]
  /** 채운 뒤 로그인 폼을 바로 제출할지(계정 고르면 곧바로 로그인) */
  autoSubmit?: () => boolean
  /** 비밀번호 화면을 기다리는 간격(테스트 주입용). 없으면 setTimeout */
  wait?: (ms: number) => Promise<void>
}

// 채울 대상을 호출부가 지정할 때 쓰는 값(피커 경로).
// 활성 탭이 아니라 요청을 보낸 탭에, 게이트가 검증한 호스트로만 채운다
export interface AutofillTarget {
  tab: Tab
  host: string
  // 'password' 면 2단계의 비밀번호 화면이다 — 비밀번호 칸이 없어도 아이디를 다시 치지 않는다(되돌이 방지)
  stage?: 'password'
}

/** 아이디를 넘긴 뒤 비밀번호 칸이 나타나기를 기다리는 최대 시간·간격 */
const PASSWORD_STEP_WAIT_MS = 20_000
const PASSWORD_STEP_POLL_MS = 500

/**
 * 계정 하나를 로그인 폼에 채운다(아이디 + 비밀번호).
 * 대상 탭은 target 이 있으면 그 탭, 없으면 활성 탭이다.
 * 계정이 속한 호스트와 페이지 호스트의 등록 도메인(eTLD+1)이 다르면 채우지 않는다 —
 * nid.naver.com 계정을 www.naver.com 에 채우는 것은 허용하되(금고 목록과 같은 기준),
 * 전혀 다른 사이트로 새는 것은 막는다.
 */
export async function autofillAccount(
  deps: AutofillDeps,
  accountId: number,
  target?: AutofillTarget
): Promise<AutofillResult> {
  const tab = target?.tab ?? deps.activeTab()
  if (!tab) return 'no-active-tab'
  // 사용자가 누른 자동완성이다 — 이 탭은 잠시 자동화가 끼어들지 않는다(두 입력이 섞여 계정이 잠긴 실기 2026-09-25)
  markHuman(tab.view.webContents)
  const url = tab.view.webContents.getURL()
  // 평문 페이지 판정을 먼저 본다(about: 등 호스트가 없는 주소도 'insecure-page' 로 알린다)
  if (!isSecurePageUrl(url)) return 'insecure-page'
  const gate = checkVaultGate({ url, excludedHosts: deps.excludedHosts() })
  if (gate === 'excluded') return 'excluded'
  if (gate !== null) return 'host-mismatch'
  const host = normalizeHost(url)
  // 피커 게이트가 검증한 발신 프레임 호스트와 탭의 현재 호스트가 어긋나면(그 사이 이동)
  // 채우지 않는다
  if (target && target.host !== host) return 'host-mismatch'
  if (deps.vault.state() !== 'unlocked') return 'locked'

  const account = deps.vault.getAccount(accountId)
  if (!account) return 'account-not-found'
  if (!sameRegistrableDomain(account.host, host)) return 'host-mismatch'

  const fields = await pageBridge.findLoginFields(tab)
  if (fields.password === undefined) {
    // 2단계 로그인(구글)의 첫 화면: 아이디 칸만 있다. 아이디만 채워 [다음]을 누르고,
    // 비밀번호 칸이 나타나면 이어서 채운다(실기 2026-10-06: 피커로 계정을 골라도 아무 일도 없었다).
    // 비밀번호 단계에서 또 비밀번호 칸이 없으면(계정 없음 안내 등) 되돌지 않고 끝낸다
    if (target?.stage === 'password' || fields.username === undefined || !account.username) {
      return 'fields-not-found'
    }
    const typed = await pageBridge.typeLogin(tab, fields.username, account.username)
    if (typed !== 'ok') return 'fill-failed'
    if ((await pageBridge.valueLength(tab, fields.username)) !== account.username.length) {
      return 'fill-failed'
    }
    if (deps.autoSubmit?.()) {
      try {
        await pageBridge.submitLogin(
          tab,
          fields.submit ?? fields.username,
          fields.submit !== undefined
        )
      } catch {
        // 제출 실패는 채우기 성공을 뒤집지 않는다 — 사용자가 [다음]을 누르면 비밀번호 단계로 이어진다
      }
    }
    // 비밀번호 화면은 뒤에서 기다린다 — 피커에는 지금 결과를 돌려준다
    void continuePasswordStep(deps, accountId, tab, host)
    return 'filled-username-only'
  }

  // 사용자가 직접 누른 채움이므로 감사 로그의 주체는 'user' 다
  const password = deps.vault.getSecretForFill(
    account.id,
    'login',
    DEFAULT_FIELD_KEY,
    undefined,
    'user'
  )
  if (password === null) return 'secret-not-found'

  // 아이디 칸이 아예 없는 화면(2단계 로그인의 비밀번호 단계)은 채울 아이디가 없는 게 정상이다.
  // 반대로 칸이 있는데 금고 아이디가 비어 있으면 "채우지 못함"으로 본다 —
  // 빈 아이디로 폼을 제출하면 로그인 실패·계정 잠금으로 이어진다
  let usernameFilled = fields.username === undefined
  if (fields.username !== undefined && account.username) {
    usernameFilled = (await pageBridge.typeLogin(tab, fields.username, account.username)) === 'ok'
  }
  // 아이디 → 비밀번호 칸으로 옮기는 사람의 틈
  await new Promise((resolve) => setTimeout(resolve, 180))
  const filled = await pageBridge.typeLogin(tab, fields.password, password)
  if (filled !== 'ok') return 'fill-failed'
  // 제출 전에 두 칸의 글자 수를 다시 본다 — 하나라도 다르면(다른 칸에 쳐졌거나 섞였으면) 로그인 버튼을 누르지 않는다.
  // 틀린 값으로 자동 제출이 반복되면 계정이 잠긴다(실기 2026-09-25 네이버)
  const lengthsOk =
    (await pageBridge.valueLength(tab, fields.password)) === password.length &&
    (fields.username === undefined ||
      !account.username ||
      (await pageBridge.valueLength(tab, fields.username)) === account.username.length)
  if (!lengthsOk) return 'fill-failed'
  // 계정을 고르면 로그인 버튼까지 눌러 준다(아이디까지 채운 경우만 — 비밀번호만 채웠으면 사용자가 확인)
  if (usernameFilled && deps.autoSubmit?.()) {
    try {
      // 제출 버튼이 있으면 그 버튼을 진짜 클릭한다(사이트 핸들러가 캡차 토큰을 붙이고 제출한다)
      await pageBridge.submitLogin(
        tab,
        fields.submit ?? fields.password,
        fields.submit !== undefined
      )
    } catch {
      // 제출 실패는 채우기 성공을 뒤집지 않는다 — 사용자가 버튼을 누르면 된다
    }
  }
  return usernameFilled ? 'ok' : 'filled-password-only'
}

/**
 * 2단계 로그인의 비밀번호 화면을 기다렸다가 같은 계정으로 이어서 채운다.
 * 같은 등록 도메인에 머무는 동안만 기다리고, 탭이 닫히거나 다른 사이트로 가면 그만둔다.
 * 결과는 돌려줄 곳이 없다(피커는 이미 닫혔다) — 실패는 조용히 끝낸다
 */
export async function continuePasswordStep(
  deps: AutofillDeps,
  accountId: number,
  tab: Tab,
  host: string
): Promise<AutofillResult | null> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let waited = 0; waited < PASSWORD_STEP_WAIT_MS; waited += PASSWORD_STEP_POLL_MS) {
    await wait(PASSWORD_STEP_POLL_MS)
    const wc = tab.view.webContents
    if (!wc || wc.isDestroyed?.()) return null
    const now = normalizeHost(wc.getURL())
    if (!now || !sameRegistrableDomain(now, host)) return null
    let fields: Awaited<ReturnType<typeof pageBridge.findLoginFields>>
    try {
      fields = await pageBridge.findLoginFields(tab)
    } catch {
      continue
    }
    if (fields.password === undefined) continue
    return autofillAccount(deps, accountId, { tab, host: now, stage: 'password' })
  }
  return null
}
