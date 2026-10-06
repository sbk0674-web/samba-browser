// uiautomator dump XML 파싱. 외부 XML 파서를 쓰지 않는다 —
// 덤프는 자기 종료 <node .../> 만 있는 단순 구조라 속성 스캔으로 충분하고,
// 새 의존성 없이 순수 함수로 테스트할 수 있다

import {
  MAX_PHONE_ELEMENTS,
  type PhoneElement,
  type PhoneScreen
} from '../../shared/phone-snapshot'
import { shellArgs, type AdbRunner } from './adb'

const NODE_RE = /<node\b([^>]*)\/?>/g
const ATTR_RE = /([\w:-]+)="([^"]*)"/g
const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/
// 비밀 입력칸으로 보는 resource-id 패턴(웹 스냅샷의 isSecret 과 같은 취지)
const SECRET_ID_RE = /(pin|passwd|password|pwd|keypad|secure)/i
// 키패드의 숫자 키 라벨(한 글자 숫자)
const KEYPAD_KEY_RE = /^\d$/
// 덤프 파일은 폰 안에서만 쓰고 지우지 않는다(다음 덤프가 덮어쓴다)
const DUMP_PATH = '/sdcard/samba-ui.xml'

export function isSecretNode(attrs: Record<string, string>): boolean {
  if (attrs.password === 'true') return true
  return SECRET_ID_RE.test(attrs['resource-id'] ?? '')
}

function unescapeXml(v: string): string {
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function readAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m = ATTR_RE.exec(raw)
  while (m) {
    out[m[1]] = unescapeXml(m[2])
    m = ATTR_RE.exec(raw)
  }
  return out
}

export function parseUiXml(xml: string, serial: string, app: string): PhoneScreen {
  const elements: PhoneElement[] = []
  let width = 0
  let height = 0
  NODE_RE.lastIndex = 0
  let m = NODE_RE.exec(xml)
  while (m) {
    const attrs = readAttrs(m[1])
    const b = BOUNDS_RE.exec(attrs.bounds ?? '')
    m = NODE_RE.exec(xml)
    if (!b) continue
    const bounds = { l: +b[1], t: +b[2], r: +b[3], b: +b[4] }
    // 가장 바깥 노드가 화면 크기다(<hierarchy rotation> 에는 크기가 없다)
    width = Math.max(width, bounds.r)
    height = Math.max(height, bounds.b)
    const secret = isSecretNode(attrs)
    // 비밀 입력칸의 값은 여기서 버린다 — 이 함수 밖으로 나가지 않는다
    // 단, 키패드의 숫자 키 라벨은 입력값이 아니다 — 지우면 키패드 배치를 읽지 못한다
    // (실기: 토스 키는 resource-id 가 password_btnNumberN 이라 비밀칸으로 분류돼 라벨이 전부 지워졌다)
    const rawText = (attrs.text ?? '').trim()
    const keyLabel = attrs.password !== 'true' && KEYPAD_KEY_RE.test(rawText)
    // 같은 이유로 안내 문구("앱을 켜려면 비밀번호를…")도 남긴다 — 입력칸(password·EditText)의 값만 버린다
    const isInput = attrs.password === 'true' || /EditText/.test(attrs.class ?? '')
    const text = secret && isInput && !keyLabel ? '' : rawText
    const desc = secret ? '' : (attrs['content-desc'] ?? '').trim()
    const clickable = attrs.clickable === 'true'
    // 누를 수 있거나 읽을 거리가 있는 노드만 AI 에게 보인다
    if (!clickable && !text && !desc && !secret) continue
    if (bounds.r <= bounds.l || bounds.b <= bounds.t) continue
    if (elements.length >= MAX_PHONE_ELEMENTS) continue
    elements.push({
      id: elements.length + 1,
      text,
      resourceId: attrs['resource-id'] || undefined,
      contentDesc: desc || undefined,
      className: attrs.class ?? '',
      clickable,
      bounds,
      center: {
        x: Math.round((bounds.l + bounds.r) / 2),
        y: Math.round((bounds.t + bounds.b) / 2)
      },
      isSecret: secret
    })
  }
  return { serial, width, height, app, elements }
}

/** dumpsys 출력에서 최상위 패키지명을 뽑는다(순수 함수 — 셸을 거치지 않는다) */
export function parseCurrentApp(stdout: string): string {
  // 디스플레이가 여럿으로 잡히는 폰은 첫 줄이 `mCurrentFocus=null` 이다(실기: SM A426N — 토스가 앞에 떠 있는데도
  // 앱 이름이 빈 값으로 읽혀 결제 흐름이 "앱이 아직 안 떴다"며 stuck 으로 끝났다). 패키지가 적힌 첫 줄을 쓴다
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('mCurrentFocus')) continue
    const app = /\s([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/.exec(line)?.[1]
    if (app) return app
  }
  return ''
}

/**
 * 현재 최상위 패키지명. 결제 앱 판정(guard 확인 카드)에도 쓴다.
 * 예전에는 `| grep` 으로 폰 셸에 걸렀지만, 셸 파이프를 쓰면 인자 하나만 흘러들어도
 * 명령이 되므로 출력을 그대로 받아 JS 정규식으로 거른다
 */
export async function currentApp(adb: AdbRunner, serial: string): Promise<string> {
  const res = await adb.run(shellArgs(serial, ['dumpsys', 'window', 'displays']))
  return parseCurrentApp(res.stdout)
}

/** dumpsys 출력에서 최상위 액티비티(`패키지/클래스`)를 뽑는다. 없으면 빈 문자열 */
export function parseCurrentActivity(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('mCurrentFocus')) continue
    const m = /\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/.exec(line)
    if (m) return m[1]
  }
  return ''
}

/**
 * UI 덤프를 아예 뜨지 않는 화면 — 애니메이션이 계속 돌아 uiautomator 가 idle 을 못 잡고("could not get idle state")
 * 호출마다 15초씩 멈추는 화면. 실기 2026-10-06 토스 홈: 결제 흐름이 폴링마다 멈춰 7분을 다 썼다.
 * 이 화면은 어차피 누를 것이 없다 — 빈 화면으로 바로 돌려준다
 */
export const NO_DUMP_ACTIVITIES: ReadonlySet<string> = new Set([
  'viva.republica.toss/im.toss.features.main.ui.MainActivity'
])

/** 폰에서 덤프를 떠 와 파싱한다. 실패(보안 앱·게임)하면 elements 가 빈 화면을 돌려준다 */
export async function dumpScreen(adb: AdbRunner, serial: string): Promise<PhoneScreen> {
  const focus = await adb.run(shellArgs(serial, ['dumpsys', 'window', 'displays']))
  const app = parseCurrentApp(focus.stdout)
  if (NO_DUMP_ACTIVITIES.has(parseCurrentActivity(focus.stdout))) {
    return { serial, width: 0, height: 0, app, elements: [] }
  }
  const dumped = await adb.run(shellArgs(serial, `uiautomator dump ${DUMP_PATH}`))
  if (dumped.code !== 0) return { serial, width: 0, height: 0, app, elements: [] }
  const xml = await adb.run(shellArgs(serial, `cat ${DUMP_PATH}`), 20_000)
  return parseUiXml(xml.stdout, serial, app)
}
