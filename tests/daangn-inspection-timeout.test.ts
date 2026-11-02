import { afterEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ wc: null as unknown }))
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents = fake.wc
    setBounds() {}
  },
  session: { fromPartition: vi.fn() }
}))
import { DaangnAccountView } from '../src/main/daangn/account-view'

afterEach(() => vi.useRealTimers())

describe('sale inspection lifetime', () => {
  function setup(load: Promise<void>) {
    const wc = {
      loadURL: vi.fn(() => load), getURL: () => 'https://chat.daangn.com/room/test',
      setAudioMuted: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn(),
      isDestroyed: vi.fn(() => false), stop: vi.fn(), close: vi.fn(),
      executeJavaScript: vi.fn(async () => ({ ready: true, productMatches: true, payment: true }))
    }
    fake.wc = wc
    const host = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
    const view = new DaangnAccountView({ accountId: 1, partition: 'test', now: () => new Date(), openExternal() {} })
    Object.assign(view, { host, loggedIn: true })
    return { wc, host, view }
  }

  it('stops and closes a stalled load before the collector 15 second timeout', async () => {
    vi.useFakeTimers()
    const { wc, host, view } = setup(new Promise(() => {}))
    const result = view.inspectSale('test', '상품')
    const assertion = expect(result).rejects.toThrow('주문 확인 시간 초과')
    await vi.advanceTimersByTimeAsync(12_000)
    await assertion
    expect(wc.stop).toHaveBeenCalledOnce()
    expect(wc.close).toHaveBeenCalledOnce()
    expect(host.contentView.removeChildView).toHaveBeenCalledOnce()
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its deadline and closes the temporary view after success', async () => {
    vi.useFakeTimers()
    const { wc, view } = setup(Promise.resolve())
    await expect(view.inspectSale('test', '상품')).resolves.toMatchObject({ payment: true })
    expect(wc.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('also bounds a stalled script and ignores a late navigation result', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const stalled = setup(new Promise<void>(resolve => { finish = resolve }))
    const pending = stalled.view.inspectSale('test', '상품')
    const failed = expect(pending).rejects.toThrow('주문 확인 시간 초과')
    await vi.advanceTimersByTimeAsync(12_000)
    await failed
    finish()
    await Promise.resolve()
    expect(stalled.wc.executeJavaScript).not.toHaveBeenCalled()

    const script = setup(Promise.resolve())
    script.wc.executeJavaScript.mockImplementation(() => new Promise(() => {}))
    const result = script.view.inspectSale('test', '상품')
    const assertion = expect(result).rejects.toThrow('주문 확인 시간 초과')
    await vi.advanceTimersByTimeAsync(12_000)
    await assertion
    expect(script.wc.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up setup failures and never reads a different room', async () => {
    vi.useFakeTimers()
    const setupFailure = setup(Promise.resolve())
    setupFailure.wc.setAudioMuted.mockImplementation(() => { throw new Error('setup failure') })
    await expect(setupFailure.view.inspectSale('test', '상품')).rejects.toThrow('setup failure')
    expect(setupFailure.wc.close).toHaveBeenCalledOnce()
    const other = setup(Promise.resolve())
    other.wc.getURL = () => 'https://chat.daangn.com/room/other'
    await expect(other.view.inspectSale('test', '상품')).rejects.toThrow('채팅방 연결 확인 필요')
    expect(other.wc.executeJavaScript).not.toHaveBeenCalled()
    expect(other.wc.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
