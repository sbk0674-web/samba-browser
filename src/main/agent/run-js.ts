import vm from 'node:vm'

// run_js 샌드박스.
//
// 모델이 여러 동작을 한 턴에 묶어 실행할 수 있게 하되, **페이지 컨텍스트에서 임의 JS 를
// 돌리지는 않는다**. 코드는 메인 프로세스의 vm 컨텍스트에서 돌고, 그 안에서 쓸 수 있는 것은
// 우리가 직접 만든 API 뿐이다(page/tabs/sleep/log). DOM 에는 우리 API 를 통해서만 닿는다.
//
// 격리 원칙
// - 컨텍스트에는 호스트 객체를 남기지 않는다. 다리(bridge) 함수 하나만 잠깐 넣고 즉시 지운다 —
//   호스트 함수가 남아 있으면 `fn.constructor.constructor('return process')()` 로 빠져나간다.
// - 다리를 오가는 값은 전부 JSON 문자열이다. 호스트 객체가 샌드박스로 새어 나가지 않는다.
// - 부트스트랩 마지막에 `globalThis` 를 지운다 — 전역 객체를 손에 쥐지 못하게 한다.
// - require·process 는 애초에 컨텍스트에 없다(참조하면 ReferenceError).

/** 받아 줄 코드 길이 상한 */
// 8000: 사이트 스크립트가 옵션·쿠폰·결제수단 처리를 덧붙이며 4000 을 넘어 AI 수리가 시험조차 못 했다(2026-09-24)
export const RUN_JS_MAX_CODE = 8000
/** 모델에게 돌려주는 결과 문자열 상한 */
export const RUN_JS_MAX_OUTPUT = 12000
/** 동기 실행 상한(무한 루프 차단) */
export const RUN_JS_SYNC_TIMEOUT_MS = 20000
/** 전체 실행 상한(비동기 포함) */
export const RUN_JS_TOTAL_TIMEOUT_MS = 30000
/** 저장된 스크립트(run_script)의 실행 상한 — 여러 단계를 한 번에 돌리므로 run_js 보다 길다(도구 상한 90초 안) */
export const RUN_SCRIPT_TOTAL_TIMEOUT_MS = 75000

/** 코드가 너무 길 때 돌려주는 문자열 */
export const RUN_JS_TOO_LONG = `refused: code must be ${RUN_JS_MAX_CODE} characters or fewer`
/** 전체 실행 시간이 넘었을 때 돌려주는 문자열 */
export const RUN_JS_TIMED_OUT = `Error: timed out after ${RUN_JS_TOTAL_TIMEOUT_MS} ms`

/** 진행 라벨 — 코드의 첫 의미 있는 줄 40자 */
export function runJsLabel(code: string): string {
  const first =
    code
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  return `코드 실행: ${first.slice(0, 40)}`
}

/** 결과가 길면 앞뒤를 남기고 가운데를 잘라 낸다 */
export function truncateOutput(value: string, max = RUN_JS_MAX_OUTPUT): string {
  if (value.length <= max) return value
  const keep = Math.floor((max - 40) / 2)
  const cut = value.length - keep * 2
  return `${value.slice(0, keep)}\n… ${cut} characters cut …\n${value.slice(value.length - keep)}`
}

/** 스택은 앞 2줄만 남긴다(샌드박스 내부 구조를 길게 흘리지 않는다) */
export function shortStack(stack: string): string {
  return stack.split('\n').slice(0, 2).join('\n')
}

/** 샌드박스가 부를 수 있는 동작 한 건. 이름은 아래 부트스트랩이 만드는 API 와 짝이다 */
export type RunJsBridge = (name: string, args: unknown[]) => Promise<unknown>

// 컨텍스트 안에서 우리 API 를 조립하는 부트스트랩. 호스트 값은 여기서만 만지고 바로 버린다
const BOOTSTRAP = `(() => {
  const g = globalThis
  const bridge = g.__bridge
  delete g.__bridge
  const invoke = async (name, args) => {
    const parsed = JSON.parse(await bridge(name, JSON.stringify(args)))
    if (parsed.error) throw new Error(parsed.error)
    return parsed.value
  }
  // 저장된 스크립트(run_script)가 받는 인자. run_js 에서는 빈 객체다
  try {
    g.args = typeof g.__args === 'string' ? JSON.parse(g.__args) : {}
  } catch {
    g.args = {}
  }
  delete g.__args
  g.__logs = []
  g.log = (...parts) => {
    g.__logs.push(
      parts
        .map((p) => {
          if (typeof p === 'string') return p
          try {
            return JSON.stringify(p)
          } catch {
            return String(p)
          }
        })
        .join(' ')
    )
  }
  g.sleep = (ms) => invoke('sleep', [ms])
  g.page = {
    get: (options) => invoke('page.get', [options]),
    click: (id) => invoke('page.click', [id]),
    type: (id, text, submit) => invoke('page.type', [id, text, submit === true]),
    select: (id, value) => invoke('page.select', [id, value]),
    scroll: (dir, id) => invoke('page.scroll', [dir, id]),
    text: (id) => invoke('page.text', [id]),
    find: (query) => invoke('page.find', [query]),
    // 글자로 요소를 찾는다 — 번호는 페이지를 읽을 때마다 바뀌므로, 다시 쓸 코드는 이걸로 쓴다
    idOf: (text, nth) => invoke('page.idOf', [text, nth || 0]),
    clickText: (text, nth) => invoke('page.clickText', [text, nth || 0]),
    // 요소 목록에 안 잡히는 칸(그리드 셀)을 정확한 글자로 찾아 번호를 준다(-1 = 없음)
    idOfExact: (text, nth) => invoke('page.idOfExact', [text, nth || 0]),
    // 그 칸과 같은 줄의 index 번째 칸(왼쪽부터) 번호 — 그리드의 체크 칸을 누를 때 쓴다(-1 = 없음)
    // 진단: 요소의 조상 상자들(DOM id 끝마디·크기)
    ancestorsOf: (id) => invoke('page.ancestorsOf', [id]),
    idOfRowCell: (id, index) => invoke('page.idOfRowCell', [id, index || 0]),
    // 합성 클릭을 무시하는 요소(커스텀 드롭다운 등)를 요소 가운데 좌표로 진짜 마우스 클릭한다(실기: 렉스몬드 옵션)
    clickNative: (id) => invoke('page.clickNative', [id]),
    dismissOverlay: () => invoke('page.dismissOverlay', []),
    // 라벨 글자로 체크박스를 켠다(숨은 동의 칸 포함) — checked·already·not-found·failed
    check: (text) => invoke('page.check', [text]),
    url: () => invoke('page.url', []),
    title: () => invoke('page.title', []),
    // 고정 sleep 대신 쓴다 — 화면(요소 목록·본문)에 글자(또는 정규식)가 보이면 바로 true, ms 안에 안 보이면 false.
    // 페이지가 빨리 뜨면 기다리지 않고 넘어간다(실기: 스크립트마다 2~4초 고정 대기가 쌓여 계정당 1~2분)
    waitFor: async (pattern, ms) => {
      const limit = Date.now() + Math.min(Math.max(Number(ms) || 8000, 200), 30000)
      const re = pattern instanceof RegExp ? pattern : null
      while (true) {
        const snap = await invoke('page.get', [{}])
        const tree = snap && typeof snap.tree === 'string' ? snap.tree : ''
        if (re ? re.test(tree) : tree.includes(String(pattern))) return true
        if (Date.now() >= limit) return false
        await invoke('sleep', [250])
      }
    }
  }
  g.tabs = {
    list: () => invoke('tabs.list', []),
    switch: (id) => invoke('tabs.switch', [id]),
    close: (id) => invoke('tabs.close', [id]),
    // 계정별 프로필 탭을 한 턴에 여러 개 열 때 쓴다(계정 비교를 로그아웃 없이 병렬로)
    open: (opts) => invoke('tabs.open', [opts])
  }
  // 제휴 적립 링크 — 애드픽: 상품 주소 → {ok, trackinglink, percent, …}. 프로필의 애드픽 로그인으로 받는다(10초쯤 걸린다)
  g.affiliate = {
    adpick: (url, profile) => invoke('affiliate.adpick', [url, profile])
  }
  // 전역 객체를 손에 쥐지 못하게 한다(마지막에 지운다 — 위에서는 g 로 썼다)
  delete g.globalThis
})()`

// 모델 코드를 감싸는 실행기. 결과도 오류도 컨텍스트 안에서 JSON 문자열로 만들어 넘긴다
function runnerScript(code: string): string {
  return `(async () => {
  try {
    const __value = await (async () => {
${code}
    })()
    try {
      return JSON.stringify({ ok: true, value: __value === undefined ? null : __value })
    } catch {
      return JSON.stringify({ ok: true, value: String(__value) })
    }
  } catch (e) {
    return JSON.stringify({
      ok: false,
      message: String((e && e.message) || e),
      stack: String((e && e.stack) || '')
    })
  }
})()`
}

/** 실행 결과 값과 로그를 모델이 읽을 한 덩어리로 합친다 */
function combine(logs: string, value: string): string {
  return truncateOutput([logs, value].filter((part) => part.length > 0).join('\n'))
}

/**
 * 모델 코드를 샌드박스에서 실행하고, 반환값과 log() 출력을 합친 문자열을 돌려준다.
 * 코드 오류는 `Error: …` 문자열로 돌려준다(던지지 않는다)
 */
export async function runSandbox(
  code: string,
  bridge: RunJsBridge,
  options: { args?: Record<string, unknown>; totalTimeoutMs?: number } = {}
): Promise<string> {
  if (code.length > RUN_JS_MAX_CODE) return RUN_JS_TOO_LONG
  const totalTimeoutMs = options.totalTimeoutMs ?? RUN_JS_TOTAL_TIMEOUT_MS
  const timedOut = `Error: timed out after ${totalTimeoutMs} ms`
  const context = vm.createContext({
    __args: JSON.stringify(options.args ?? {}),
    __bridge: (name: unknown, argsJson: unknown): Promise<string> =>
      bridgeCall(bridge, name, argsJson)
  })
  const readLogs = (): string => {
    try {
      const raw: unknown = vm.runInContext('__logs.join("\\n")', context)
      return typeof raw === 'string' ? raw : ''
    } catch {
      return ''
    }
  }
  try {
    vm.runInContext(BOOTSTRAP, context, { timeout: RUN_JS_SYNC_TIMEOUT_MS })
  } catch (e) {
    return `Error: sandbox setup failed — ${e instanceof Error ? e.message : String(e)}`
  }
  let pending: unknown
  try {
    pending = vm.runInContext(runnerScript(code), context, { timeout: RUN_JS_SYNC_TIMEOUT_MS })
  } catch (e) {
    // 문법 오류·동기 무한 루프가 여기로 온다
    const err = e instanceof Error ? e : new Error(String(e))
    return combine(readLogs(), `Error: ${err.message}\n${shortStack(err.stack ?? '')}`.trim())
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), totalTimeoutMs)
  })
  try {
    const raw = await Promise.race([Promise.resolve(pending) as Promise<unknown>, timeout])
    if (raw === timedOut) return combine(readLogs(), timedOut)
    return combine(readLogs(), formatResult(raw))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 실행기가 돌려준 JSON 문자열을 모델이 읽을 문자열로 바꾼다 */
function formatResult(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let parsed: { ok?: boolean; value?: unknown; message?: string; stack?: string }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return ''
  }
  if (parsed.ok === true) {
    if (parsed.value === null || parsed.value === undefined) return ''
    return typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value)
  }
  const head = `Error: ${parsed.message ?? 'failed'}`
  const stack = shortStack(parsed.stack ?? '')
    .split('\n')
    .slice(1)
    .join('\n')
  return stack ? `${head}\n${stack}` : head
}

/** 샌드박스 → 호스트 호출 한 건. 결과도 오류도 JSON 문자열로만 돌려준다 */
async function bridgeCall(bridge: RunJsBridge, name: unknown, argsJson: unknown): Promise<string> {
  try {
    if (typeof name !== 'string') return JSON.stringify({ error: 'bad call' })
    const args: unknown = typeof argsJson === 'string' ? JSON.parse(argsJson) : []
    const value = await bridge(name, Array.isArray(args) ? args : [])
    return JSON.stringify({ value: value === undefined ? null : value })
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
  }
}
