import { describe, it, expect, vi } from 'vitest'
import {
  VaultCaptureGate,
  CAPTURE_MAX_PER_WINDOW,
  CAPTURE_WINDOW_MS,
  type CaptureVaultLike,
  type VaultCaptureGateDeps
} from '../src/main/ipc/vault-capture'
import type { VaultState } from '../src/shared/vault'

const PASSWORD = 'sup3r-secret-pw!'
const PAYLOAD = { host: 'shop.example', username: 'alice', password: PASSWORD }
const FRAME = { trusted: true, frameUrl: 'https://www.shop.example/login' }

interface Built {
  gate: VaultCaptureGate
  setPendingCapture: ReturnType<typeof vi.fn>
  hasSameSecret: ReturnType<typeof vi.fn>
  tick: (ms: number) => void
}

function build(
  opts: {
    state?: VaultState
    excludedHosts?: string[]
    neverSaveHosts?: string[]
    sameSecret?: boolean
    accounts?: { id?: number; username: string }[]
    machineFilled?: boolean
    profile?: string
    watchLogin?: VaultCaptureGateDeps['watchLogin']
    autoSaveEnabled?: boolean
    autoSave?: ReturnType<typeof vi.fn>
    log?: (line: string) => void
  } = {}
): Built {
  let clock = 1_000_000
  const setPendingCapture = vi.fn()
  const hasSameSecret = vi.fn(() => opts.sameSecret ?? false)
  const vault: CaptureVaultLike = {
    state: () => opts.state ?? 'unlocked',
    hasSameSecret,
    listAccounts: () => opts.accounts ?? [],
    setPendingCapture
  }
  const gate = new VaultCaptureGate({
    vault,
    excludedHosts: () => opts.excludedHosts ?? [],
    neverSaveHosts: () => opts.neverSaveHosts ?? [],
    now: () => clock,
    machineFilled: () => opts.machineFilled ?? false,
    profileOf: () => opts.profile,
    watchLogin: opts.watchLogin,
    autoSaveEnabled: () => opts.autoSaveEnabled ?? false,
    autoSave: opts.autoSave,
    log: opts.log
  })
  return {
    gate,
    setPendingCapture,
    hasSameSecret,
    tick: (ms: number) => {
      clock += ms
    }
  }
}

describe('VaultCaptureGate', () => {
  it('정상 요청은 저장 제안을 띄운다(신규 계정)', () => {
    const b = build()
    const sender = {}
    expect(b.gate.handle(sender, FRAME, PAYLOAD)).toBe('accepted')
    expect(b.setPendingCapture).toHaveBeenCalledWith({
      host: 'shop.example',
      username: 'alice',
      password: PASSWORD,
      isNew: true,
      locked: false
    })
  })

  it('발신자가 탭의 webContents 가 아니면 무시한다(위조 발신자)', () => {
    const b = build()
    expect(b.gate.handle({}, { ...FRAME, trusted: false }, PAYLOAD)).toBe('untrusted-sender')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
    // 위조 발신자는 레이트리밋 카운터도 소비하지 않는다
    expect(b.hasSameSecret).not.toHaveBeenCalled()
  })

  it('sender 당 30초에 3회까지만 받고, 창이 지나면 다시 받는다', () => {
    const b = build()
    const sender = {}
    for (let i = 0; i < CAPTURE_MAX_PER_WINDOW; i++) {
      expect(b.gate.handle(sender, FRAME, PAYLOAD)).toBe('accepted')
    }
    expect(b.gate.handle(sender, FRAME, PAYLOAD)).toBe('rate-limited')
    expect(b.setPendingCapture).toHaveBeenCalledTimes(CAPTURE_MAX_PER_WINDOW)

    // 다른 sender 는 자기 몫의 한도를 따로 가진다
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')

    b.tick(CAPTURE_WINDOW_MS + 1)
    expect(b.gate.handle(sender, FRAME, PAYLOAD)).toBe('accepted')
  })

  it('payload 의 host 가 발신 프레임 호스트와 다르면 무시한다', () => {
    const b = build()
    expect(b.gate.handle({}, FRAME, { ...PAYLOAD, host: 'evil.example' })).toBe('host-mismatch')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('프레임 URL 을 알 수 없으면 대조할 수 없으므로 무시한다', () => {
    const b = build()
    expect(b.gate.handle({}, { trusted: true, frameUrl: '' }, PAYLOAD)).toBe('host-mismatch')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('스키마에 맞지 않으면 무시한다', () => {
    const b = build()
    expect(b.gate.handle({}, FRAME, { host: 'shop.example', username: 'alice' })).toBe('invalid')
    expect(b.gate.handle({}, FRAME, 'not-an-object')).toBe('invalid')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('제외 도메인이면 제안하지 않는다', () => {
    const b = build({ excludedHosts: ['www.shop.example'] })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('excluded')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('이미 같은 값이 저장돼 있으면 제안하지 않는다', () => {
    const b = build({ sameSecret: true })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('duplicate')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('기존 계정이면 isNew=false 로 제안한다', () => {
    const b = build({ accounts: [{ username: 'alice' }] })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')
    expect(b.setPendingCapture).toHaveBeenCalledWith(
      expect.objectContaining({ isNew: false, locked: false })
    )
  })

  it('잠긴 상태에서는 locked=true 로 제안한다(문구 분기용)', () => {
    const b = build({ state: 'locked' })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')
    expect(b.setPendingCapture).toHaveBeenCalledWith(
      expect.objectContaining({ isNew: true, locked: true })
    )
    expect(b.hasSameSecret).not.toHaveBeenCalled()
  })

  it('제외 도메인은 서브도메인까지(같은 등록 도메인) 막는다', () => {
    const b = build({ excludedHosts: ['example.com'] })
    const frame = { trusted: true, frameUrl: 'https://login.example.com/signin' }
    expect(b.gate.handle({}, frame, { ...PAYLOAD, host: 'login.example.com' })).toBe('excluded')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it("'이 사이트는 묻지 않기' 목록의 사이트는 제안하지 않는다", () => {
    const b = build({ neverSaveHosts: ['example.com'] })
    const frame = { trusted: true, frameUrl: 'https://www.example.com/login' }
    expect(b.gate.handle({}, frame, { ...PAYLOAD, host: 'www.example.com' })).toBe('never-save')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('https 가 아닌 페이지는 받지 않는다(로컬 개발 서버만 예외)', () => {
    const b = build()
    const http = { trusted: true, frameUrl: 'http://www.shop.example/login' }
    expect(b.gate.handle({}, http, PAYLOAD)).toBe('insecure-page')
    const local = { trusted: true, frameUrl: 'http://localhost:5173/login' }
    expect(b.gate.handle({}, local, { ...PAYLOAD, host: 'localhost:5173' })).toBe('accepted')
  })

  it('자동화·키마스터 자동 채움이 넣은 값의 제출은 잡지 않는다', () => {
    const b = build({ machineFilled: true })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('automation')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
    expect(b.hasSameSecret).not.toHaveBeenCalled()
  })

  it('아이디가 비어 있으면 제안하지 않는다', () => {
    const b = build()
    expect(b.gate.handle({}, FRAME, { ...PAYLOAD, username: '   ' })).toBe('no-username')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('탭 프로필 이름을 함께 보관한다(새 계정 라벨용)', () => {
    const b = build({ profile: '쇼핑1' })
    b.gate.handle({}, FRAME, PAYLOAD)
    expect(b.setPendingCapture).toHaveBeenCalledWith(expect.objectContaining({ profile: '쇼핑1' }))
  })

  it('로그인 성공을 확인한 뒤에만 확인 바를 띄운다', () => {
    let settle: ((success: boolean) => void) | undefined
    const b = build({
      watchLogin: (_key, onSettled) => {
        settle = onSettled
      }
    })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('watching')
    expect(b.setPendingCapture).not.toHaveBeenCalled()
    settle?.(true)
    expect(b.setPendingCapture).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'shop.example', username: 'alice', isNew: true })
    )
  })

  it('로그인이 실패하면(또는 시간 초과) 아무것도 띄우지 않는다', () => {
    let settle: ((success: boolean) => void) | undefined
    const b = build({
      watchLogin: (_key, onSettled) => {
        settle = onSettled
      }
    })
    b.gate.handle({}, FRAME, PAYLOAD)
    settle?.(false)
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('묻지 않고 자동 저장이 켜져 있어도 새 계정은 확인 바를 띄운다', () => {
    const autoSave = vi.fn(() => true)
    const b = build({ autoSaveEnabled: true, autoSave })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')
    expect(autoSave).not.toHaveBeenCalled()
    expect(b.setPendingCapture).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'alice', password: PASSWORD, isNew: true })
    )
  })

  it('자동 저장이 켜져 있어도 잠긴 금고면 잠금 해제를 먼저 묻는다', () => {
    const autoSave = vi.fn(() => true)
    const b = build({ state: 'locked', autoSaveEnabled: true, autoSave })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')
    expect(autoSave).not.toHaveBeenCalled()
    expect(b.setPendingCapture).toHaveBeenCalledWith(expect.objectContaining({ locked: true }))
  })

  it('자동 저장을 끄면 기존 계정 + 다른 값은 업데이트 확인 바(isNew=false)로 묻는다', () => {
    const autoSave = vi.fn(() => true)
    const b = build({ accounts: [{ id: 7, username: 'alice' }], autoSave })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')
    expect(autoSave).not.toHaveBeenCalled()
    expect(b.setPendingCapture).toHaveBeenCalledWith(
      expect.objectContaining({ isNew: false, locked: false })
    )
  })

  it('반환값에는 비밀번호가 담기지 않는다', () => {
    const b = build()
    const outcome = b.gate.handle({}, FRAME, PAYLOAD)
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD)
  })
})

describe('VaultCaptureGate — iframe 로그인·자동 저장·원인 로그', () => {
  it('같은 등록 도메인의 하위 프레임 제출은 받고, 그 프레임을 로그인 감시에 넘긴다', () => {
    const watchLogin = vi.fn()
    const b = build({ watchLogin })
    const subFrame = {}
    const sender = {
      trusted: true,
      frameUrl: 'https://member.shop.example/login-frame',
      topUrl: 'https://www.shop.example/login',
      subFrame
    }
    const outcome = b.gate.handle({}, sender, { ...PAYLOAD, host: 'member.shop.example' })
    expect(outcome).toBe('watching')
    expect(watchLogin).toHaveBeenCalledWith(expect.anything(), expect.any(Function), subFrame)
  })

  it('탭 최상위 문서와 다른 사이트의 iframe 제출은 버린다(광고·제3자 프레임)', () => {
    const b = build()
    const sender = {
      trusted: true,
      frameUrl: 'https://ads.other.example/frame',
      topUrl: 'https://www.shop.example/login'
    }
    expect(b.gate.handle({}, sender, { ...PAYLOAD, host: 'ads.other.example' })).toBe(
      'cross-site-frame'
    )
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('자동 저장이 켜져 있으면 바뀐 비밀번호도 묻지 않고 업데이트한다', () => {
    const autoSave = vi.fn(() => true)
    const b = build({ accounts: [{ id: 7, username: 'alice' }], autoSaveEnabled: true, autoSave })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('auto-saved')
    expect(autoSave).toHaveBeenCalledWith(expect.objectContaining({ isNew: false }))
    expect(b.setPendingCapture).not.toHaveBeenCalled()
  })

  it('자동 저장이 실패하면 값을 버리지 않고 확인 바로 묻는다', () => {
    const autoSave = vi.fn(() => 'error' as const)
    const b = build({ autoSaveEnabled: true, autoSave })
    expect(b.gate.handle({}, FRAME, PAYLOAD)).toBe('accepted')
    expect(b.setPendingCapture).toHaveBeenCalledTimes(1)
  })

  it('처리 결과·버린 이유를 호스트와 함께 로그에 남기되 아이디·비밀번호는 남기지 않는다', () => {
    const lines: string[] = []
    let settle: ((success: boolean, reason?: string) => void) | undefined
    const b = build({
      log: (line) => lines.push(line),
      watchLogin: (_key, onSettled) => {
        settle = onSettled
      }
    })
    b.gate.handle({}, FRAME, PAYLOAD)
    settle?.(false, 'timeout')
    b.gate.handle({}, { ...FRAME, frameUrl: 'http://www.shop.example/login' }, PAYLOAD)
    const all = lines.join(' | ')
    expect(all).toContain('shop.example')
    expect(all).toContain('watching')
    expect(all).toContain('timeout')
    expect(all).toContain('insecure-page')
    expect(all).not.toContain(PASSWORD)
    expect(all).not.toContain('alice')
  })
})
