// 당근 계정 1개의 숨은 채팅 뷰. TabManager 를 타지 않는 독립 WebContentsView 라서
// 탭 바·브릿지 탭 목록·AI 도구·확장·금고 저장 바에 보이지 않는다. 대신 보안 설정을 여기서 직접 건다.
//
// 뷰는 항상 어느 창엔가 붙어 있다 — 안 보일 때는 전용 숨김 창(host)의 hiddenBounds 에 두어 뷰포트(1100x800)를
// 유지하고(보이는 창의 창 밖 좌표는 뷰포트가 0 이 되어 실측으로 탈락), 보일 때만 앱 창으로 옮겨 붙인다.
// 당근 자체 목록 패널과 프로필 사이드바는 CSS 로 가린다(DOM 은 남아 계속 읽는다)

import { WebContentsView, session, type BrowserWindow, type WebContents } from 'electron'
import type { DaangnAccountState, DaangnBounds, DaangnChannelDto } from '../../shared/daangn'
import { clampBounds, hiddenBounds } from './bounds'
import { buildFillScript, buildHideListCss, buildScanScript, parseScan, type RawScan } from './selectors'
import { persistentCookieDetails } from './cookies'
import { buildInspectSaleScript, type DaangnSaleSignal } from './order-watch'
import { classifyChatUrl, isAllowedChatUrl, roomIdOf } from './url-guard'

/** 페이지의 alert·confirm·prompt 를 무력화한다(확인 대화상자가 쌓여 읽기가 멈추는 것도 막는다) */
const SILENCE_DIALOGS_SCRIPT =
  'window.alert = () => undefined; window.confirm = () => true; window.prompt = () => null'

const CHAT_HOME = 'https://chat.daangn.com/'
const LOGIN_URL = 'https://chat.daangn.com/login'
/** 읽기가 이만큼 연달아 실패하면 화면 읽기 실패로 본다 */
const READ_FAIL_LIMIT = 3

// 세션 보안 설정은 파티션마다 한 번만 건다
const hardened = new Set<string>()

function hardenPartition(partition: string): void {
  if (hardened.has(partition)) return
  hardened.add(partition)
  const ses = session.fromPartition(partition)
  // 알림·카메라·위치 같은 권한은 전부 거절한다(알림은 앱이 직접 띄운다)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  // 다운로드는 받지 않는다
  ses.on('will-download', (e) => e.preventDefault())
}

export interface DaangnAccountViewDeps {
  accountId: number
  /** 저장소에 적힌 세션 파티션 이름 */
  partition: string
  now: () => Date
  /** 채팅 안 링크는 기본 브라우저로 연다 */
  openExternal: (url: string) => void
}

export class DaangnAccountView {
  private view: WebContentsView | null = null
  private lastCookiePersistAt = 0
  /** 숨김 창 — 뷰의 집이다 */
  private host: BrowserWindow | null = null
  /** 지금 뷰가 붙어 있는 창(숨김 창이거나 보이는 앱 창) */
  private current: BrowserWindow | null = null
  private url = ''
  private loggedIn = false
  private failures = 0
  private failed = false

  constructor(private readonly deps: DaangnAccountViewDeps) {}

  /** 숨김 창(host) 안에 뷰를 만들고 채팅 홈을 연다. 이미 있으면 아무것도 안 한다 */
  async start(host: BrowserWindow): Promise<void> {
    if (this.view) return
    hardenPartition(this.deps.partition)
    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(this.deps.partition),
        sandbox: true,
        contextIsolation: true,
        // 창 밖·뒤에 있어도 계속 그려지게 한다(목록 갱신이 멈추면 안 읽음을 놓친다)
        backgroundThrottling: false
      }
    })
    view.setBorderRadius(0)
    this.view = view
    this.host = host
    this.current = host
    const wc = view.webContents
    this.guard(wc)
    host.contentView.addChildView(view)
    view.setBounds(hiddenBounds())
    wc.on('did-navigate', (_e, url) => this.onNavigated(url))
    wc.on('did-navigate-in-page', (_e, url) => this.onNavigated(url))
    wc.on('did-finish-load', () => {
      void this.injectCss()
      void this.persistCookies()
    })
    this.url = CHAT_HOME
    await wc.loadURL(CHAT_HOME).catch(() => undefined)
  }

  /** 뷰를 창에서 떼고 닫는다 */
  /**
   * 당근이 로그인 쿠키를 세션 쿠키(만료 없음)로 주면 앱을 끌 때 사라져 QR 로그인을 다시 해야 한다 —
   * 만료 1년짜리 영속 쿠키로 다시 심어 재시작 뒤에도 로그인이 남게 한다. 30초에 한 번만
   */
  private async persistCookies(): Promise<void> {
    const t = this.deps.now().getTime()
    if (t - this.lastCookiePersistAt < 30_000) return
    this.lastCookiePersistAt = t
    try {
      const ses = session.fromPartition(this.deps.partition)
      const nowSec = Math.floor(t / 1000)
      for (const c of await ses.cookies.get({})) {
        const d = persistentCookieDetails(c, nowSec)
        if (d) await ses.cookies.set(d).catch(() => undefined)
      }
      await ses.cookies.flushStore()
    } catch {
      // 쿠키 저장소 접근 실패는 다음 기회에 다시 한다
    }
  }

  stop(): void {
    const view = this.view
    this.view = null
    if (!view) return
    try {
      this.current?.contentView.removeChildView(view)
    } catch {
      // 창이 이미 닫혔을 수 있다
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.host = null
    this.current = null
  }

  /** 지금 이 계정의 상태. 주소가 로그인 화면이면 expired, 목록을 읽었으면 logged_in */
  state(): DaangnAccountState {
    if (this.failed) return 'read_failed'
    if (classifyChatUrl(this.url) === 'login') return 'expired'
    return this.loggedIn ? 'logged_in' : 'loading'
  }

  /**
   * 채팅 목록을 읽는다(읽기만 한다). 로그인 화면이거나 아직 안 그려졌으면 빈 목록,
   * 스크립트 실행·해석이 실패하면 던진다 — 3번 연달아 실패하면 state() 가 read_failed 가 된다
   */
  async scan(): Promise<{ me: RawScan['me']; channels: DaangnChannelDto[] }> {
    const wc = this.alive()
    if (!wc) throw new Error('뷰가 없어요')
    void this.persistCookies()
    if (classifyChatUrl(wc.getURL()) !== 'chat') return { me: null, channels: [] }
    try {
      const raw = await wc.executeJavaScript(buildScanScript())
      const parsed = parseScan(raw, this.deps.accountId, this.deps.now())
      this.failures = 0
      this.failed = false
      // 이름이 읽혔을 때만 로그인된 것으로 본다(목록이 아직 안 그려졌으면 loading 그대로)
      if (parsed.me) this.loggedIn = true
      return parsed
    } catch (err) {
      this.failures += 1
      if (this.failures >= READ_FAIL_LIMIT) this.failed = true
      throw err
    }
  }

  currentRoomId(): string | null {
    const wc = this.alive()
    return wc ? roomIdOf(wc.getURL()) : null
  }

  /** 별도 숨김 뷰에서 해당 방 본문만 읽는다. 현재 사용 중인 채팅 화면을 바꾸지 않는다. */
  async inspectSale(roomId: string, expectedTitle: string): Promise<DaangnSaleSignal> {
    if (!this.host || !this.loggedIn || !/^[A-Za-z0-9_-]{1,200}$/.test(roomId))
      throw new Error('로그인 계정 또는 채팅방 확인 필요')
    const view = new WebContentsView({ webPreferences: {
      session: session.fromPartition(this.deps.partition), sandbox: true,
      contextIsolation: true, backgroundThrottling: false
    } })
    const wc = view.webContents
    const host = this.host
    host.contentView.addChildView(view)
    view.setBounds(hiddenBounds())
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e, url) => { if (!isAllowedChatUrl(url)) e.preventDefault() })
    wc.on('will-redirect', (e, url) => { if (!isAllowedChatUrl(url)) e.preventDefault() })
    try {
      await wc.loadURL(`${CHAT_HOME}room/${encodeURIComponent(roomId)}`)
      if (roomIdOf(wc.getURL()) !== roomId) throw new Error('채팅방 연결 확인 필요')
      for (let i = 0; i < 6; i++) {
        const result = await wc.executeJavaScript(buildInspectSaleScript(expectedTitle)) as DaangnSaleSignal
        if (result?.ready && result.productMatches) return result
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      throw new Error('채팅 본문을 확인하지 못했습니다')
    } finally {
      try { host.contentView.removeChildView(view) } catch { /* 창이 이미 닫힘 */ }
      if (!wc.isDestroyed()) wc.close()
    }
  }

  /** 방을 연다. 목록에 그 줄이 있으면 눌러서(페이지 새로고침 없이), 없으면 주소로 이동한다 */
  async openRoom(roomId: string): Promise<void> {
    const wc = this.alive()
    if (!wc) throw new Error('뷰가 없어요')
    this.setFocusEmulation(true) // 방을 여는 순간에 포커스가 있어야 당근이 읽음 처리한다
    const clicked = await wc
      .executeJavaScript(
        `(() => { const a = document.querySelector('a[href*="/room/' + ${JSON.stringify(roomId)} + '"]'); if (!a) return false; a.click(); return true })()`
      )
      .catch(() => false)
    if (clicked !== true) await wc.loadURL(`${CHAT_HOME}room/${encodeURIComponent(roomId)}`)
  }

  /** 로그인(QR) 화면으로 보낸다 — 계정 추가·다시 로그인에서 쓴다 */
  async openLogin(): Promise<void> {
    const wc = this.alive()
    if (!wc) throw new Error('뷰가 없어요')
    this.loggedIn = false
    await wc.loadURL(LOGIN_URL).catch(() => undefined)
  }

  /** target(앱 창)의 오른쪽 영역에 보이게 한다 — 숨김 창에서 떼어 맨 위에 붙인다 */
  show(bounds: DaangnBounds, target: BrowserWindow): void {
    if (!this.view) return
    const clamped = clampBounds(bounds)
    // 너무 좁으면 옆 패널을 덮지 않게 접어 둔다
    if (!clamped) return this.hide()
    const becameVisible = this.current !== target
    this.moveTo(target)
    this.view.setBounds(clamped)
    this.setFocusEmulation(true)
    // 포커스가 없으면 당근이 "보고 있는 창이 아니다" 로 보고 읽음 처리를 하지 않는다.
    // 숨김에서 보임으로 바뀔 때만 준다 — 영역 조절 때마다 주면 다른 입력칸의 포커스를 뺏는다
    // 앱 창이 OS 포커스를 갖고 있을 때만 — 뒤에 있는 창에서 focus() 를 부르면 그 창이 사람이 쓰는 창 앞으로 튀어나온다(포커스 에뮬레이션은 위에서 켬)
    if (becameVisible && target.isFocused() && !this.view.webContents.isDestroyed()) this.view.webContents.focus()
  }

  /** 다시 숨김 창으로 돌려보낸다 */
  hide(): void {
    if (!this.view || !this.host) return
    this.setFocusEmulation(false)
    this.moveTo(this.host)
    this.view.setBounds(hiddenBounds())
  }

  private moveTo(win: BrowserWindow): void {
    if (!this.view) return
    if (this.current && this.current !== win) {
      try {
        this.current.contentView.removeChildView(this.view)
      } catch {
        // 옛 창이 이미 닫혔을 수 있다
      }
    }
    // 같은 창이어도 다시 붙이면 맨 위로 올라온다
    win.contentView.addChildView(this.view)
    this.current = win
  }

  /** 입력칸에 글을 넣는다(보내기는 누르지 않는다). 입력칸이 없거나 값이 안 들어가면 false */
  async fillText(text: string): Promise<boolean> {
    const wc = this.alive()
    if (!wc) return false
    const ok = await wc.executeJavaScript(buildFillScript(text)).catch(() => false)
    return ok === true
  }

  webContents(): WebContents | null {
    return this.alive()
  }

  // --- 내부 ---------------------------------------------------------------

  private alive(): WebContents | null {
    const wc = this.view?.webContents
    return wc && !wc.isDestroyed() ? wc : null
  }

  private onNavigated(url: string): void {
    this.url = url
    if (classifyChatUrl(url) === 'login') this.loggedIn = false
  }

  private async injectCss(): Promise<void> {
    const wc = this.alive()
    if (!wc || classifyChatUrl(wc.getURL()) !== 'chat') return
    await wc.insertCSS(buildHideListCss()).catch(() => undefined)
  }

  /**
   * 뷰가 보이는 동안 페이지가 "창에 포커스가 있다" 고 믿게 한다(엔진 수준 에뮬레이션).
   * 앱 창이 OS 포커스를 잃었거나 방을 연 시점에 포커스가 없으면 당근 웹이 읽음 처리를 하지 않아
   * 열어 둔 방의 안 읽음 배지가 남는다. 숨길 때는 끈다 — 숨은 뷰가 열려 있는 방의 새 메시지를
   * 몰래 읽음 처리하면 새 문의를 놓친다
   */
  private setFocusEmulation(enabled: boolean): void {
    const wc = this.alive()
    if (!wc) return
    try {
      void wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled }).catch(() => undefined)
    } catch {
      // 디버거가 붙지 않은 뷰는 기존 동작(webContents.focus)만 쓴다
    }
  }

  /**
   * 어느 프레임·어느 시점에 뜨는 alert·confirm·beforeunload 든 엔진 수준에서 바로 닫는다.
   * (페이지 스크립트로 alert 를 덮는 방식은 하위 프레임·로드 초기에 뜨는 창을 못 막는다)
   */
  private autoCloseDialogs(wc: WebContents): void {
    try {
      wc.debugger.attach('1.3')
    } catch {
      return
    }
    wc.debugger.on('message', (_e, method) => {
      if (method !== 'Page.javascriptDialogOpening') return
      void wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined)
    })
    void wc.debugger.sendCommand('Page.enable').catch(() => undefined)
    // 새 문서가 로드될 때마다(모든 프레임) 스크립트가 돌기 전에 대화상자 함수를 비운다
    void wc.debugger
      .sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: SILENCE_DIALOGS_SCRIPT })
      .catch(() => undefined)
  }

  /** 당근 밖으로 못 나가게 하고, 새 창·링크는 기본 브라우저로 보낸다 */
  private guard(wc: WebContents): void {
    const block = (e: { preventDefault: () => void }, url: string): void => {
      if (isAllowedChatUrl(url)) return
      e.preventDefault()
    }
    wc.on('will-navigate', block)
    wc.on('will-redirect', block)
    // 당근 웹이 알림음 파일을 못 찾으면 alert("timer_HtmlChk Function error…") 를 계정마다 계속 띄운다 —
    // 숨은 뷰의 대화상자는 사람이 볼 일이 없으니 막고, 소리도 끈다
    wc.setAudioMuted(true)
    const silence = (): void => {
      void wc.executeJavaScript(SILENCE_DIALOGS_SCRIPT).catch(() => undefined)
    }
    wc.on('dom-ready', silence)
    wc.on('did-navigate-in-page', silence)
    this.autoCloseDialogs(wc)
    // 숨김 창에서 확인 대화상자(떠나시겠어요?)가 뜨면 읽기가 영영 멈춘다 — 묻지 않고 넘어간다
    wc.on('will-prevent-unload', (e) => e.preventDefault())
    // 로그인 뒤 SPA 이동은 did-finish-load 가 다시 오지 않는다 — 목록 숨김 CSS 를 다시 넣는다
    wc.on('did-navigate-in-page', () => void this.injectCss())
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) this.deps.openExternal(url)
      return { action: 'deny' }
    })
  }
}
