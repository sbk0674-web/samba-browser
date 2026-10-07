// 폰 입력 전달. 1순위는 `adb shell input` 이다(단순·안정).
// `adb shell` 은 받은 문자열을 폰의 sh 가 해석하므로, 보낼 수 있는 글자를
// 화이트리스트로 못 박는다. 목록 밖 글자(한글·이모지·셸 메타문자)는 거부하고
// 호출부가 요소 탭(가상 키보드)으로 우회한다

import { shellArgs, type AdbRunner } from './adb'

export const PHONE_KEYS = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  enter: 'KEYCODE_ENTER',
  power: 'KEYCODE_POWER',
  recent: 'KEYCODE_APP_SWITCH',
  delete: 'KEYCODE_DEL'
} as const
export type PhoneKey = keyof typeof PHONE_KEYS

/**
 * `input text` 로 보낼 수 있는 글자. 셸 메타문자(`; & | $ \` ( ) > < ' " * ? ~ # !`)와
 * 한글·이모지는 목록에 없다 — 인용부호로 막는 대신 애초에 통과시키지 않는다
 */
export const SAFE_TEXT_RE = /^[A-Za-z0-9 _.@%+\-=:,/]*$/

export function isPhoneKey(v: unknown): v is PhoneKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PHONE_KEYS, v)
}

/** 화면에 그린 폰 뷰 좌표 → 실제 폰 픽셀 좌표 */
export function toDeviceCoord(
  point: { x: number; y: number },
  view: { width: number; height: number },
  device: { width: number; height: number }
): { x: number; y: number } {
  if (view.width <= 0 || view.height <= 0) return { x: 0, y: 0 }
  const x = Math.round((point.x / view.width) * device.width)
  const y = Math.round((point.y / view.height) * device.height)
  return {
    x: Math.max(0, Math.min(device.width - 1, x)),
    y: Math.max(0, Math.min(device.height - 1, y))
  }
}

export async function tap(adb: AdbRunner, serial: string, x: number, y: number): Promise<void> {
  await adb.run(shellArgs(serial, ['input', 'tap', String(Math.round(x)), String(Math.round(y))]))
}

export async function swipe(
  adb: AdbRunner,
  serial: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  ms = 300
): Promise<void> {
  await adb.run(
    shellArgs(serial, [
      'input',
      'swipe',
      String(Math.round(from.x)),
      String(Math.round(from.y)),
      String(Math.round(to.x)),
      String(Math.round(to.y)),
      String(ms)
    ])
  )
}

/**
 * 화이트리스트에 든 글자만 보낸다.
 * 한글·이모지·셸 메타문자가 하나라도 있으면 'unsupported-text' 를 돌려주고
 * 호출부가 다른 길(요소 탭)을 택한다
 */
export async function typeText(
  adb: AdbRunner,
  serial: string,
  text: string
): Promise<'ok' | 'unsupported-text'> {
  if (!SAFE_TEXT_RE.test(text)) return 'unsupported-text'
  // `input text` 에서 '%' 는 탈출 문자다. 먼저 '%%' 로 이중화해야
  // 사용자가 친 "%s" 가 공백으로 둔갑하지 않는다. 그 다음에 공백을 %s 로 바꾼다
  const escaped = text.replace(/%/g, '%%').replace(/ /g, '%s')
  await adb.run(shellArgs(serial, ['input', 'text', escaped]))
  return 'ok'
}

export async function pressKey(adb: AdbRunner, serial: string, key: PhoneKey): Promise<void> {
  if (!isPhoneKey(key)) throw new Error(`unknown key: ${String(key)}`)
  await adb.run(shellArgs(serial, ['input', 'keyevent', PHONE_KEYS[key]]))
}

/** `dumpsys power` 의 mWakefulness 가 Awake 인가. 읽지 못하면 깨어 있다고 본다(탭을 막지 않는다) */
export function parseAwake(stdout: string): boolean {
  const m = /mWakefulness=(\w+)/.exec(stdout)
  return m ? m[1] === 'Awake' : true
}

/**
 * 폰을 깨운다. 무선 adb 에서는 scrcpy `--stay-awake` 가 안 먹어 폰이 잠들면 화면이 검게 나온다
 * (실기 2026-09-30). WAKEUP 은 POWER 와 달리 켜진 화면을 끄지 않는다
 */
export async function wakeScreen(adb: AdbRunner, serial: string): Promise<void> {
  await adb.run(shellArgs(serial, ['input', 'keyevent', 'KEYCODE_WAKEUP']))
}

/** 잠들어 있으면 깨우고 true(= 이번 입력은 버린다 — 검은 화면에서 누른 자리에 뭐가 있는지 모른다) */
export async function wakeIfAsleep(adb: AdbRunner, serial: string): Promise<boolean> {
  // 상태를 못 읽으면 깨어 있다고 보고 입력을 그대로 보낸다 — 깨우기 때문에 탭이 실패하면 안 된다
  const out = await adb.run(shellArgs(serial, ['dumpsys', 'power'])).catch(() => null)
  if (!out || parseAwake(out.stdout)) return false
  await wakeScreen(adb, serial)
  return true
}

/** 자동 작업이 폰을 깨운 뒤 켜질 때까지 기다리는 횟수·간격 */
export const AWAKE_POLL_TRIES = 6
export const AWAKE_POLL_MS = 300

/**
 * 자동 작업(결제 승인·폰 도구)의 조작 전에 부른다 — 잠들어 있으면 깨우고 Awake 가 될 때까지 잠깐 기다린다.
 * 평소에는 폰 설정대로 꺼져 있게 둔다(사용자 2026-09-30: 작업하거나 클릭할 때만 보이면 된다)
 */
export async function ensureAwake(
  adb: AdbRunner,
  serial: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  if (!(await wakeIfAsleep(adb, serial))) return
  for (let i = 0; i < AWAKE_POLL_TRIES; i++) {
    await sleep(AWAKE_POLL_MS)
    const out = await adb.run(shellArgs(serial, ['dumpsys', 'power']))
    if (parseAwake(out.stdout)) return
  }
}
