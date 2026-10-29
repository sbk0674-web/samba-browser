// 당근 채팅함 서비스 — 가짜 뷰·가짜 시계로 뷰 풀·합치기·알림·방 열기·템플릿 채우기·정리를 시험한다
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { openDatabase, type Db } from '../src/main/db/client'
import { DaangnRepo } from '../src/main/daangn/repo'
import { DaangnService, type AccountViewLike } from '../src/main/daangn/service'
import { parseSettings } from '../src/shared/settings'
import type {
  DaangnAccountState,
  DaangnBounds,
  DaangnChannelDto,
  DaangnStateDto
} from '../src/shared/daangn'

function chan(accountId: number, roomId: string, unread: number): DaangnChannelDto {
  return {
    accountId,
    roomId,
    peerName: `상대${roomId}`,
    region: '',
    lastMessage: '메시지',
    lastAt: 1000,
    lastAtText: '',
    unread,
    productTitle: '',
    productThumb: null
  }
}

class FakeView implements AccountViewLike {
  started = false
  stopped = false
  st: DaangnAccountState = 'logged_in'
  channels: DaangnChannelDto[] = []
  throwOnScan = false
  opened: string[] = []
  shown: { bounds: DaangnBounds; target: unknown }[] = []
  hides = 0
  filled: string[] = []
  loginOpened = 0
  room: string | null = null
  scanGate: Promise<void> | null = null
  openGate: Promise<void> | null = null
  scans = 0
  inspected: string[] = []
  constructor(readonly accountId: number) {}
  async start(): Promise<void> {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  state(): DaangnAccountState {
    return this.st
  }
  async scan(): Promise<{ me: { displayName: string; profileImage: string | null } | null; channels: DaangnChannelDto[] }> {
    this.scans += 1
    if (this.scanGate) await this.scanGate
    if (this.throwOnScan) throw new Error('읽기 실패')
    return { me: { displayName: `계정${this.accountId}`, profileImage: null }, channels: this.channels }
  }
  async openRoom(roomId: string): Promise<void> {
    if (this.openGate) await this.openGate
    this.opened.push(roomId)
    this.room = roomId
  }
  async inspectSale(roomId: string): Promise<{ ready: boolean; payment: boolean; cancelled: boolean; productMatches: boolean; salePrice: number | null; systemNotice: boolean }> {
    this.inspected.push(roomId)
    return { ready: true, payment: true, cancelled: false, productMatches: true, salePrice: 34000, systemNotice: true }
  }
  async openLogin(): Promise<void> {
    this.loginOpened += 1
  }
  currentRoomId(): string | null {
    return this.room
  }
  show(bounds: DaangnBounds, target: unknown): void {
    this.shown.push({ bounds, target })
  }
  hide(): void {
    this.hides += 1
  }
  async fillText(text: string): Promise<boolean> {
    this.filled.push(text)
    return true
  }
}

const HIDDEN = { id: 'hidden' } as unknown as BrowserWindow
const APP = { id: 'app' } as unknown as BrowserWindow

describe('DaangnService', () => {
  let db: Db
  let repo: DaangnRepo
  let views: Map<number, FakeView>
  let now: number
  let sent: { channel: string; payload: unknown }[]
  let notices: { title: string; body: string; click: () => void }[]
  let settingsOverride: Record<string, unknown>
  let makeView: ((id: number) => FakeView) | null
  let sleeps: number
  let cleared: string[]

  function make(): DaangnService {
    return new DaangnService({
      repo,
      hiddenHost: () => HIDDEN,
      appWindow: () => APP,
      settings: () => parseSettings(settingsOverride),
      send: (channel, payload) => sent.push({ channel, payload }),
      notify: (title, body, click) => notices.push({ title, body, click }),
      now: () => now,
      sleep: async () => {
        sleeps += 1
      },
      clearPartition: (p) => {
        cleared.push(p)
      },
      partitionPrefix: () => 'persist:ws1-',
      createView: ({ accountId }) => {
        const v = makeView?.(accountId) ?? new FakeView(accountId)
        views.set(accountId, v)
        return v
      }
    })
  }
  const lastState = (): DaangnStateDto => {
    const u = [...sent].reverse().find((s) => s.channel === 'daangn:updated')
    return u?.payload as DaangnStateDto
  }

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    repo = new DaangnRepo(db)
    views = new Map()
    now = 1_000_000
    sent = []
    notices = []
    settingsOverride = {}
    makeView = null
    sleeps = 0
    cleared = []
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  it('로그인된 계정의 최근 상품 채팅만 주문 본문 확인 후보로 제공한다', async () => {
    const a = repo.addAccount({ label: '서병기', partitionPrefix: 'p-' })
    const b = repo.addAccount({ label: '임귀태', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    views.get(a.id)!.channels = [{ ...chan(a.id, 'room-a', 0), productTitle: '바지', lastAt: 1000 }]
    views.get(b.id)!.channels = [{ ...chan(b.id, 'room-b', 0), productTitle: '상의', lastAt: 1000 }]
    views.get(b.id)!.st = 'expired'
    await svc.runTick()
    expect(svc.orderInspectionCandidates(900)).toEqual([
      { accountId: a.id, accountLabel: '서병기', roomId: 'room-a', productTitle: '바지', productThumb: null, previewSignal: 'unknown', lastAtPrecise: false, lastAt: 1000, peerName: '상대room-a' }
    ])
    expect(await svc.inspectOrderSignal(a.id, 'room-a')).toEqual({ ready: true, payment: true, cancelled: false, productMatches: true, salePrice: 34000, systemNotice: true })
    expect(views.get(a.id)!.inspected).toEqual(['room-a'])
    expect(views.get(a.id)!.opened).toEqual([])
    await expect(svc.inspectOrderSignal(a.id, 'room-b')).rejects.toThrow()
    svc.dispose()
  })

  it('계정이 0개면 뷰도 타이머도 만들지 않고 dispose 뒤에도 남지 않는다', () => {
    const svc = make()
    svc.start()
    expect(views.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    svc.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('계정이 있으면 타이머를 하나 돌리고 dispose 가 뷰를 전부 닫고 타이머를 지운다', async () => {
    repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    repo.addAccount({ label: 'B', partitionPrefix: 'p-' })
    const svc = make()
    svc.start()
    await svc.runTick()
    expect(vi.getTimerCount()).toBe(1)
    expect([...views.values()].every((v) => v.started)).toBe(true)
    svc.dispose()
    expect([...views.values()].every((v) => v.stopped)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('한 계정이 읽기 실패해도 다른 계정 목록은 그대로이고, 로그인 풀린 계정만 빠진다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const b = repo.addAccount({ label: 'B', partitionPrefix: 'p-' })
    const c = repo.addAccount({ label: 'C', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick() // 뷰가 만들어진다(아직 채널 없음)
    views.get(a.id)!.channels = [chan(a.id, 'a1', 1)]
    views.get(b.id)!.channels = [chan(b.id, 'b1', 2)]
    views.get(c.id)!.channels = [chan(c.id, 'c1', 3)]
    await svc.runTick()
    expect(lastState().channels.map((x) => x.roomId).sort()).toEqual(['a1', 'b1', 'c1'])

    // b: 읽기가 연달아 실패해 view 가 read_failed 로 판정, c: 로그인 풀림
    views.get(b.id)!.throwOnScan = true
    views.get(b.id)!.st = 'read_failed'
    views.get(c.id)!.st = 'expired'
    views.get(c.id)!.channels = []
    await svc.runTick()
    const s = lastState()
    expect(s.channels.map((x) => x.roomId)).toEqual(['a1'])
    expect(s.accounts.find((x) => x.id === b.id)?.state).toBe('read_failed')
    expect(s.accounts.find((x) => x.id === c.id)?.state).toBe('expired')
    expect(s.accounts.find((x) => x.id === a.id)?.state).toBe('logged_in')
    svc.dispose()
  })

  it('한 번만 읽기가 실패하면(아직 logged_in) 옛 목록을 그대로 보여 준다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    views.get(a.id)!.channels = [chan(a.id, 'a1', 1)]
    await svc.runTick()
    views.get(a.id)!.throwOnScan = true // state 는 아직 logged_in
    await svc.runTick()
    expect(lastState().channels.map((x) => x.roomId)).toEqual(['a1'])
    svc.dispose()
  })

  it('알림: 첫 읽기에는 없고, 늘어난 방에만 한 번, 같은 방 2분 안엔 다시 없다', async () => {
    const a = repo.addAccount({ label: '황놀', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    views.get(a.id)!.channels = [chan(a.id, 'r1', 2), chan(a.id, 'r2', 0)]
    await svc.runTick() // 이 계정의 첫 읽기
    expect(notices).toHaveLength(0)

    views.get(a.id)!.channels = [chan(a.id, 'r1', 3), chan(a.id, 'r2', 0)]
    now += 5000
    await svc.runTick()
    expect(notices).toHaveLength(1)
    expect(notices[0].title).toBe('[황놀] 상대r1')

    views.get(a.id)!.channels = [chan(a.id, 'r1', 4), chan(a.id, 'r2', 0)]
    now += 60_000
    await svc.runTick()
    expect(notices).toHaveLength(1) // 쿨다운 안

    views.get(a.id)!.channels = [chan(a.id, 'r1', 5), chan(a.id, 'r2', 0)]
    now += 70_000
    await svc.runTick()
    expect(notices).toHaveLength(2)
    svc.dispose()
  })

  it('알림 설정을 끄면 알리지 않는다', async () => {
    settingsOverride = { daangnNotify: false }
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    views.get(a.id)!.channels = [chan(a.id, 'r1', 1)]
    await svc.runTick()
    views.get(a.id)!.channels = [chan(a.id, 'r1', 2)]
    now += 5000
    await svc.runTick()
    expect(notices).toHaveLength(0)
    svc.dispose()
  })

  it('방을 열면 그 계정 뷰를 보이고, 다른 계정 방을 열면 이전 뷰를 숨긴다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const b = repo.addAccount({ label: 'B', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    svc.setRoomBounds({ x: 300, y: 80, width: 900, height: 700 })
    await svc.openRoom(a.id, 'r1')
    expect(views.get(a.id)!.opened).toEqual(['r1'])
    expect(views.get(a.id)!.shown.at(-1)).toEqual({ bounds: { x: 300, y: 80, width: 900, height: 700 }, target: APP })
    await svc.openRoom(b.id, 'r9')
    expect(views.get(a.id)!.hides).toBeGreaterThan(0)
    expect(views.get(b.id)!.shown).toHaveLength(1)
    svc.closeRoom()
    expect(views.get(b.id)!.hides).toBeGreaterThan(0)
    svc.dispose()
  })

  it('템플릿 채우기: 열린 방의 계정과 다르면 입력칸을 건드리지 않고 false', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const b = repo.addAccount({ label: 'B', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    expect(await svc.fillText(a.id, '안녕')).toBe(false) // 방이 안 열려 있다
    await svc.openRoom(b.id, 'r1')
    expect(await svc.fillText(a.id, '안녕')).toBe(false)
    expect(views.get(a.id)!.filled).toEqual([])
    expect(views.get(b.id)!.filled).toEqual([])
    expect(await svc.fillText(b.id, '안녕')).toBe(true)
    expect(views.get(b.id)!.filled).toEqual(['안녕'])
    svc.dispose()
  })

  it('relogin 은 로그인 화면으로 보내고 상태를 loading 으로 바꿔 알린다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    views.get(a.id)!.st = 'expired'
    await svc.runTick()
    expect(lastState().accounts[0].state).toBe('expired')
    views.get(a.id)!.st = 'loading'
    await svc.relogin(a.id)
    expect(views.get(a.id)!.loginOpened).toBe(1)
    expect(lastState().accounts[0].state).toBe('loading')
    svc.dispose()
  })

  it('기능을 끄면(daangnEnabled=false) 다음 틱에 뷰를 모두 닫는다', async () => {
    repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    expect([...views.values()].every((v) => v.started && !v.stopped)).toBe(true)
    settingsOverride = { daangnEnabled: false }
    await svc.runTick()
    expect([...views.values()].every((v) => v.stopped)).toBe(true)
    svc.dispose()
  })

  it('계정을 추가하면 로그인(QR) 화면을 보이고, 지우면 뷰를 닫는다', async () => {
    const svc = make()
    svc.setRoomBounds({ x: 0, y: 0, width: 900, height: 700 })
    const dto = await svc.addAccount('새 계정')
    expect(dto.label).toBe('새 계정')
    // 파티션은 계정을 만들 때의 작업공간 접두사로 한 번 정해 저장한다
    expect(repo.listAccounts()[0].partition).toBe(`persist:ws1-__daangn-${dto.id}__`)
    const v = views.get(dto.id)!
    expect(v.loginOpened).toBe(1)
    expect(v.shown).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    svc.removeAccount(dto.id)
    expect(v.stopped).toBe(true)
    expect(repo.listAccounts()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    svc.dispose()
  })

  // === 최종 리뷰 반영 ===================================================================

  const BOUNDS: DaangnBounds = { x: 300, y: 100, width: 900, height: 700 }
  const deferred = (): { p: Promise<void>; go: () => void } => {
    let go!: () => void
    const p = new Promise<void>((r) => (go = r))
    return { p, go }
  }

  it('방을 연달아 열면 마지막으로 누른 방만 붙고, 늦게 끝난 앞 요청은 뷰를 붙이지 않는다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const b = repo.addAccount({ label: 'B', partitionPrefix: 'p-' })
    const gate = deferred()
    makeView = (id) => {
      const v = new FakeView(id)
      if (id === a.id) v.openGate = gate.p
      return v
    }
    const svc = make()
    svc.setRoomBounds(BOUNDS)
    const first = svc.openRoom(a.id, 'RA') // 느린 계정
    await svc.openRoom(b.id, 'RB')
    gate.go()
    await first
    expect(views.get(a.id)?.shown.length).toBe(0)
    expect(views.get(b.id)?.shown.length).toBe(1)
    svc.setRoomBounds(null)
    expect(views.get(b.id)?.hides).toBeGreaterThan(0)
    expect(await svc.fillText(b.id, '안녕')).toBe(true)
    expect(await svc.fillText(a.id, '안녕')).toBe(false)
  })

  it('열린 방이 바뀌어 뷰 안의 방이 다르면 템플릿을 채우지 않는다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const svc = make()
    await svc.openRoom(a.id, 'RA')
    ;(views.get(a.id) as FakeView).room = 'RB'
    expect(await svc.fillText(a.id, '안녕')).toBe(false)
  })

  it('읽는 도중 지운 계정의 채널이 목록에 다시 살아나지 않는다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const gate = deferred()
    makeView = (id) => {
      const v = new FakeView(id)
      v.scanGate = gate.p
      v.channels = [chan(id, 'R1', 1)]
      return v
    }
    const svc = make()
    const tick = svc.runTick()
    await Promise.resolve()
    svc.removeAccount(a.id)
    gate.go()
    await tick
    expect(svc.snapshot().channels).toEqual([])
  })

  it('끈 동안 쌓인 안 읽음은 다시 켜도 알림 폭주가 되지 않는다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    ;(views.get(a.id) as FakeView).channels = [chan(a.id, 'R1', 0)]
    await svc.runTick()
    settingsOverride = { daangnEnabled: false }
    await svc.runTick()
    settingsOverride = {}
    now += 10 * 60_000
    await svc.runTick()
    ;(views.get(a.id) as FakeView).channels = [chan(a.id, 'R1', 7), chan(a.id, 'R2', 3)]
    await svc.runTick()
    expect(notices.length).toBe(0)
  })

  it('한 번에 새 방이 많이 생기면 알림 하나로 묶는다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    const v = views.get(a.id) as FakeView
    v.channels = [chan(a.id, 'R0', 0)]
    await svc.runTick()
    now += 200_000
    v.channels = [1, 2, 3, 4, 5].map((n) => chan(a.id, `N${n}`, 1))
    await svc.runTick()
    expect(notices.length).toBe(1)
    expect(notices[0].title).toContain('5건')
  })

  it('dispose 뒤 진행 중이던 틱이 뷰를 다시 만들지 않는다', async () => {
    repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const svc = make()
    svc.dispose()
    await svc.runTick()
    expect(views.size).toBe(0)
  })

  it('임시 읽기는 이미 로그인된 뷰를 10초씩 기다리지 않는다', async () => {
    repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    repo.addAccount({ label: 'B', partitionPrefix: 'p-' })
    repo.addAccount({ label: 'C', partitionPrefix: 'p-' })
    settingsOverride = { daangnWarmViews: 1, daangnTempViews: 3 }
    // scan() 이 한 번 돌아야 loggedIn 이 되는 뷰(실제 DaangnAccountView 와 같은 성질)
    makeView = (id) => {
      const v = new FakeView(id)
      v.st = 'loading'
      v.channels = [chan(id, 'R1', 1)]
      const scan = v.scan.bind(v)
      v.scan = async () => {
        const r = await scan()
        v.st = 'logged_in'
        return r
      }
      return v
    }
    const svc = make()
    await svc.runTick()
    expect(sleeps).toBe(0)
    expect(svc.snapshot().channels.length).toBeGreaterThanOrEqual(2)
  })

  it('멈춘 읽기 하나가 다른 계정 읽기를 영구히 막지 않는다(시간 제한)', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const b = repo.addAccount({ label: 'B', partitionPrefix: 'p-' })
    makeView = (id) => {
      const v = new FakeView(id)
      if (id === a.id) v.scanGate = new Promise<void>(() => undefined) // 영원히 안 끝남
      v.channels = [chan(id, 'R1', 1)]
      return v
    }
    const svc = make()
    const tick = svc.runTick()
    await vi.advanceTimersByTimeAsync(30_000)
    await tick
    expect(svc.snapshot().channels.some((c) => c.accountId === b.id)).toBe(true)
  })

  it('계정을 지우면 세션 파티션 저장소도 지운다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const partition = repo.listAccounts().find((r) => r.id === a.id)?.partition
    const svc = make()
    svc.removeAccount(a.id)
    expect(cleared).toEqual([partition])
  })


  it('방을 열고 잠시 뒤 목록을 다시 읽어 읽음 처리된 안 읽음 배지를 바로 지운다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    makeView = (id) => {
      const v = new FakeView(id)
      v.channels = [chan(id, 'R1', 1)]
      return v
    }
    const svc = make()
    await svc.runTick()
    expect(svc.snapshot().accounts[0].unread).toBe(1)
    svc.setRoomBounds(BOUNDS)
    await svc.openRoom(a.id, 'R1')
    // 당근이 읽음 처리를 하면 다음 읽기에서 0 이 된다
    ;(views.get(a.id) as FakeView).channels = [chan(a.id, 'R1', 0)]
    await vi.advanceTimersByTimeAsync(3000)
    expect(svc.snapshot().accounts[0].unread).toBe(0)
  })

  it('영역을 보낸 창에 뷰를 붙이고, 다른 창이 보낸 접기 요청은 무시한다(창이 여럿일 때)', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const WIN2 = { id: 'win2', isDestroyed: () => false } as unknown as BrowserWindow
    const OTHER = { id: 'other', isDestroyed: () => false } as unknown as BrowserWindow
    const svc = make()
    await svc.runTick()
    await svc.relogin(a.id)
    svc.setRoomBounds(BOUNDS, WIN2)
    expect(views.get(a.id)?.shown.at(-1)?.target).toBe(WIN2)
    svc.setRoomBounds(null, OTHER) // 다른 창이 화면을 떠나며 보낸 접기 — 보고 있는 창의 뷰는 그대로
    expect(views.get(a.id)?.hides).toBe(0)
    svc.setRoomBounds(null, WIN2)
    expect(views.get(a.id)?.hides).toBe(1)
  })

  it('다시 로그인(QR) 화면은 영역이 먼저든 나중이든 앱 창에 붙는다', async () => {
    const a = repo.addAccount({ label: 'A', partitionPrefix: 'p-' })
    const svc = make()
    await svc.runTick()
    await svc.relogin(a.id)
    svc.setRoomBounds(BOUNDS) // 렌더러는 relogin 응답 뒤에 영역을 보낸다
    expect(views.get(a.id)?.loginOpened).toBeGreaterThan(0)
    expect(views.get(a.id)?.shown.length).toBe(1)
    // 이어지는 틱이 이 뷰를 다시 숨기거나 닫지 않는다
    await svc.runTick()
    expect(views.get(a.id)?.stopped).toBe(false)
    expect(views.get(a.id)?.hides).toBe(0)
  })
})
