import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentEvent, AgentRunAck, IpcResult } from '../src/shared/ipc'

// 렌더러 전역 window.samba 스텁 (스토어는 순수 zustand 라 node 에서 그대로 돌릴 수 있다).
// agent:run 은 "시작 접수" ack 만 즉시 돌려준다
const ack: IpcResult<AgentRunAck> = { ok: true, data: { started: true } }
const run = vi.fn(async (_prompt: string): Promise<IpcResult<AgentRunAck>> => ack)
const stop = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
const confirmReply = vi.fn()
const win = { samba: { agent: { run, stop, confirmReply, onEvent: vi.fn() } } }
Object.assign(globalThis, { window: win })

const { useChatStore } = await import('../src/renderer/src/stores/chatStore')

const fire = (e: AgentEvent): void => useChatStore.getState().handleEvent(e)

describe('chatStore 상태 가드', () => {
  beforeEach(() => {
    run.mockReset()
    run.mockImplementation(async () => ack)
    useChatStore.setState({
      messages: [],
      runSeq: 0,
      status: 'idle',
      toolCalls: 0,
      currentLabel: '',
      retry: null,
      confirm: null,
      authError: null
    })
  })

  it('중단 뒤 뒤늦게 온 running 은 무시한다', () => {
    useChatStore.setState({ status: 'stopped' })
    fire({ type: 'status', state: 'running', toolCalls: 0 })
    expect(useChatStore.getState().status).toBe('stopped')
  })

  it('실패·완료 뒤의 running 도 무시한다', () => {
    useChatStore.setState({ status: 'failed' })
    fire({ type: 'status', state: 'running' })
    expect(useChatStore.getState().status).toBe('failed')
    useChatStore.setState({ status: 'done' })
    fire({ type: 'status', state: 'running' })
    expect(useChatStore.getState().status).toBe('done')
  })

  it('send() 로 시작한 실행의 running 은 반영된다', async () => {
    await useChatStore.getState().send('구글 검색')
    expect(run).toHaveBeenCalledWith('구글 검색')
    fire({ type: 'status', state: 'running', toolCalls: 0 })
    expect(useChatStore.getState().status).toBe('running')
  })

  it('이미지를 붙여 보내면 네 번째 인자로 넘기고 말풍선에 미리보기를 단다', async () => {
    const img = { mediaType: 'image/png' as const, data: 'aGk=' }
    await useChatStore.getState().send('이 화면 읽어', undefined, [img])
    expect(run).toHaveBeenCalledWith('이 화면 읽어', undefined, undefined, [img])
    const user = useChatStore.getState().messages[0]
    expect(user.role).toBe('user')
    expect(user.images).toEqual(['data:image/png;base64,aGk='])
  })

  it('이미지 없이 보내면 호출 모양이 예전과 같다', async () => {
    await useChatStore.getState().send('검색')
    expect(run).toHaveBeenCalledWith('검색')
    expect(useChatStore.getState().messages[0].images).toBeUndefined()
  })

  it('중단 뒤 새 작업을 다시 보낼 수 있다', async () => {
    useChatStore.setState({ status: 'stopped' })
    await useChatStore.getState().send('다시')
    expect(useChatStore.getState().status).toBe('running')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('stopped 상태는 그대로 반영된다', () => {
    useChatStore.setState({ status: 'running' })
    fire({ type: 'status', state: 'stopped' })
    expect(useChatStore.getState().status).toBe('stopped')
  })

  it('confirm 대기 중 stopped 가 오면 confirm 을 정리한다', () => {
    useChatStore.setState({
      status: 'running',
      confirm: { requestId: 'req-1', action: '위험한 작업', kind: 'danger' }
    })
    fire({ type: 'status', state: 'stopped' })
    expect(useChatStore.getState().status).toBe('stopped')
    expect(useChatStore.getState().confirm).toBeNull()
  })

  it('이전 run 의 늦은 오류 응답이 새 실행을 failed 로 덮지 않는다', async () => {
    // 첫 실행의 invoke 는 아주 늦게 ok:false 로 끝난다
    let releaseFirst: (r: IpcResult<AgentRunAck>) => void = () => {}
    run.mockImplementationOnce(
      () => new Promise<IpcResult<AgentRunAck>>((resolve) => (releaseFirst = resolve))
    )
    const first = useChatStore.getState().send('첫 작업')
    expect(useChatStore.getState().status).toBe('running')

    // 사용자가 중단하고 새 작업을 시작
    useChatStore.getState().handleEvent({ type: 'status', state: 'stopped' })
    await useChatStore.getState().send('두 번째 작업')
    expect(useChatStore.getState().status).toBe('running')

    // 이제서야 첫 실행의 실패 응답이 도착해도 새 실행 상태는 그대로여야 한다
    releaseFirst({ ok: false, error: '이미 실행 중' })
    await first
    expect(useChatStore.getState().status).toBe('running')
    expect(useChatStore.getState().currentLabel).toBe('')
  })

  it('현재 실행의 ok:false 응답은 failed 로 반영된다', async () => {
    run.mockImplementationOnce(async () => ({ ok: false as const, error: '시작 실패' }))
    await useChatStore.getState().send('작업')
    expect(useChatStore.getState().status).toBe('failed')
    expect(useChatStore.getState().currentLabel).toBe('시작 실패')
  })

  it('실패 사유는 빈 AI 말풍선에 남긴다(시작도 못 한 지시가 무반응으로 보이지 않게)', () => {
    useChatStore.setState({
      status: 'running',
      messages: [
        { id: '1', role: 'user', text: '다운로드' },
        { id: '2', role: 'ai', text: '', steps: [] }
      ]
    })
    fire({ type: 'status', state: 'failed', message: '자동 작업이 브라우저를 쓰는 중', toolCalls: 0 })
    const msgs = useChatStore.getState().messages
    expect(msgs[msgs.length - 1].text).toBe('자동 작업이 브라우저를 쓰는 중')
    expect(useChatStore.getState().status).toBe('failed')
  })

  it('로그인 문제(auth:)와 이미 답이 있는 말풍선은 덮지 않는다', () => {
    useChatStore.setState({
      status: 'running',
      messages: [{ id: '1', role: 'ai', text: '하던 답', steps: [] }]
    })
    fire({ type: 'status', state: 'failed', message: '뒤늦은 오류', toolCalls: 0 })
    expect(useChatStore.getState().messages[0].text).toBe('하던 답')
    useChatStore.setState({ status: 'running', messages: [{ id: '1', role: 'ai', text: '' }] })
    fire({ type: 'status', state: 'failed', message: 'auth:missing', toolCalls: 0 })
    expect(useChatStore.getState().messages[0].text).toBe('')
    expect(useChatStore.getState().authError).toBe('missing')
  })

  it('api_retry 진행 이벤트는 retry 로 보관하고 step 이 오면 지운다', () => {
    useChatStore.setState({
      status: 'running',
      messages: [{ id: '1', role: 'ai', text: '', steps: [] }]
    })
    fire({ type: 'progress', kind: 'apiRetry', attempt: 3, reason: 'rate_limit' })
    expect(useChatStore.getState().retry).toEqual({ attempt: 3, reason: 'rate_limit' })
    fire({ type: 'step', label: '클릭', ok: true })
    expect(useChatStore.getState().retry).toBeNull()
  })
})

describe('chatStore 캡차 넘김 카드', () => {
  beforeEach(() => {
    confirmReply.mockReset()
    stop.mockClear()
    useChatStore.setState({
      status: 'running',
      handoff: null,
      messages: [{ id: '1', role: 'ai', text: '', steps: [] }]
    })
  })

  it('handoff 이벤트로 카드가 뜨고 대기 단계가 기록된다', () => {
    fire({
      type: 'handoff',
      requestId: 'r1',
      kind: 'captcha',
      matched: '캡차',
      url: 'https://a.example/login'
    })
    expect(useChatStore.getState().handoff).toEqual({
      requestId: 'r1',
      kind: 'captcha',
      matched: '캡차',
      url: 'https://a.example/login'
    })
    expect(useChatStore.getState().messages[0].steps?.at(-1)?.key).toBe('handoff.waiting')
  })

  it('자동 재개(handoffDone)로 카드가 닫히고 재개 단계가 남는다', () => {
    fire({
      type: 'handoff',
      requestId: 'r1',
      kind: 'captcha',
      matched: '캡차',
      url: 'https://a.example/login'
    })
    fire({ type: 'handoffDone', requestId: 'r1', outcome: 'resumed' })
    expect(useChatStore.getState().handoff).toBeNull()
    expect(useChatStore.getState().messages[0].steps?.at(-1)).toEqual({
      label: '',
      ok: true,
      key: 'handoff.step.resumed'
    })
  })

  it("'건너뛰고 계속'은 승인 응답만 보내고 실행을 멈추지 않는다", () => {
    useChatStore.getState().replyHandoff('r1', true)
    expect(confirmReply).toHaveBeenCalledWith('r1', true)
    expect(stop).not.toHaveBeenCalled()
    expect(useChatStore.getState().handoff).toBeNull()
  })

  it("'작업 중단'은 거부 응답과 함께 실행도 멈춘다", () => {
    useChatStore.getState().replyHandoff('r1', false)
    expect(confirmReply).toHaveBeenCalledWith('r1', false)
    expect(stop).toHaveBeenCalled()
  })

  it('작업이 끝나면 남은 넘김 카드를 정리한다', () => {
    fire({ type: 'handoff', requestId: 'r1', kind: 'captcha', matched: 'x', url: 'u' })
    fire({ type: 'status', state: 'stopped' })
    expect(useChatStore.getState().handoff).toBeNull()
  })
})
