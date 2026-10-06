import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PHONE_ELEMENTS } from '../src/shared/phone-snapshot'
import { dumpScreen, isSecretNode, parseUiXml } from '../src/main/phone/uitree'
import { keypadFromUiTree } from '../src/main/phone/pay-secret'
import { FakeAdb } from './stubs/fake-adb'

// 실제 uiautomator 덤프를 축약한 고정 파일(토스 송금 화면)
const XML = readFileSync(join(__dirname, 'fixtures/uiautomator-toss.xml'), 'utf8')

function parse(): ReturnType<typeof parseUiXml> {
  return parseUiXml(XML, 'R3CRA05HY3R', 'viva.republica.toss')
}

describe('parseUiXml', () => {
  it('bounds 를 좌표와 중심점으로 바꾼다', () => {
    const title = parse().elements.find((e) => e.text === '송금하기')
    expect(title?.bounds).toEqual({ l: 0, t: 100, r: 720, b: 200 })
    expect(title?.center).toEqual({ x: 360, y: 150 })
  })

  it('누를 수 있거나 읽을 거리가 있는 노드만 1번부터 번호를 받는다', () => {
    const screen = parse()
    // 배경 View·크기 0 노드는 빠지고 5개만 남는다
    expect(screen.elements.map((e) => e.id)).toEqual([1, 2, 3, 4, 5])
    expect(screen.elements[0].text).toBe('송금하기')
    expect(screen.elements[1].contentDesc).toBe('확인 & 계속')
    expect(screen.elements.some((e) => e.className === 'android.view.View')).toBe(false)
  })

  it('password 노드는 비밀로 보고 값을 버린다', () => {
    const pw = parse().elements.find((e) => e.resourceId?.endsWith('input_amount'))
    expect(pw?.isSecret).toBe(true)
    expect(pw?.text).toBe('')
  })

  it('resource-id 가 핀·비밀번호·키패드 류면 비밀로 본다', () => {
    expect(isSecretNode({ 'resource-id': 'com.app:id/pin_keypad' })).toBe(true)
    expect(isSecretNode({ 'resource-id': 'com.app:id/password' })).toBe(true)
    expect(isSecretNode({ 'resource-id': 'com.app:id/pwd_field' })).toBe(true)
    expect(isSecretNode({ password: 'true' })).toBe(true)
    expect(isSecretNode({ 'resource-id': 'com.app:id/title' })).toBe(false)
    expect(parse().elements.find((e) => e.resourceId?.endsWith('pin_keypad'))?.isSecret).toBe(true)
  })

  it('요소 수가 상한을 넘으면 앞에서 자른다', () => {
    const rows: string[] = ['<hierarchy rotation="0">']
    for (let i = 0; i < MAX_PHONE_ELEMENTS + 20; i++) {
      rows.push(
        `<node text="항목${i}" class="android.widget.TextView" clickable="true" bounds="[0,${i}][100,${i + 1}]" />`
      )
    }
    rows.push('</hierarchy>')
    const screen = parseUiXml(rows.join('\n'), 'S', 'app')
    expect(screen.elements).toHaveLength(MAX_PHONE_ELEMENTS)
    expect(screen.elements[MAX_PHONE_ELEMENTS - 1].text).toBe(`항목${MAX_PHONE_ELEMENTS - 1}`)
  })

  it('깨진 XML 이어도 던지지 않고 빈 요소를 돌려준다', () => {
    expect(parseUiXml('<hierarchy><node bounds="[0,0', 'S', 'app').elements).toEqual([])
    expect(parseUiXml('', 'S', 'app')).toEqual({
      serial: 'S',
      width: 0,
      height: 0,
      app: 'app',
      elements: []
    })
  })

  it('화면 크기는 hierarchy 가 아니라 최상위 노드 bounds 에서 얻는다', () => {
    const screen = parse()
    expect(screen.width).toBe(720)
    expect(screen.height).toBe(1600)
  })
})

describe('dumpScreen', () => {
  it('현재 앱을 읽고 덤프를 떠서 파싱한다', async () => {
    const adb = new FakeAdb()
    adb.reply(
      'dumpsys window displays',
      '  mCurrentFocus=Window{a b viva.republica.toss/com.toss.MainAct}'
    )
    adb.reply('uiautomator dump', 'UI hierchary dumped to: /sdcard/samba-ui.xml')
    adb.reply('cat /sdcard/samba-ui.xml', XML)
    const screen = await dumpScreen(adb, 'R3CRA05HY3R')
    expect(screen.app).toBe('viva.republica.toss')
    expect(screen.elements).toHaveLength(5)
    expect(adb.calls[1].slice(0, 3)).toEqual(['-s', 'R3CRA05HY3R', 'shell'])
  })

  it('토스 홈처럼 덤프가 안 되는 화면은 uiautomator 를 부르지 않고 빈 화면을 돌려준다(실기 2026-10-06)', async () => {
    const adb = new FakeAdb()
    adb.reply(
      'dumpsys window displays',
      '  mCurrentFocus=Window{8d3be u0 viva.republica.toss/im.toss.features.main.ui.MainActivity}'
    )
    adb.reply('uiautomator dump', 'ERROR: could not get idle state', 1)
    const screen = await dumpScreen(adb, 'S')
    expect(screen).toEqual({
      serial: 'S',
      width: 0,
      height: 0,
      app: 'viva.republica.toss',
      elements: []
    })
    expect(adb.calls.some((c) => c.join(' ').includes('uiautomator'))).toBe(false)
  })

  it('덤프가 실패하면 빈 화면을 돌려준다(보안 앱·게임)', async () => {
    const adb = new FakeAdb()
    adb.reply('dumpsys window displays', '')
    adb.reply('uiautomator dump', 'ERROR: could not get idle state', 1)
    const screen = await dumpScreen(adb, 'S')
    expect(screen).toEqual({ serial: 'S', width: 0, height: 0, app: '', elements: [] })
  })
})

describe('parseCurrentApp — 첫 줄이 null 인 폰', () => {
  it('mCurrentFocus=null 줄을 건너뛰고 패키지가 적힌 줄을 쓴다(실기: SM A426N)', async () => {
    const { parseCurrentApp } = await import('../src/main/phone/uitree')
    const out = [
      '  mCurrentFocus=null',
      '  mFocusedApp=null',
      '  mCurrentFocus=Window{d6224e5 u0 viva.republica.toss/viva.republica.toss.password.PasswordActivity}'
    ].join('\n')
    expect(parseCurrentApp(out)).toBe('viva.republica.toss')
    expect(parseCurrentApp('  mCurrentFocus=null')).toBe('')
  })
})

describe('토스 결제 비밀번호 화면(실기 구조) — 숫자 키의 id 에 password 가 들어 있다', () => {
  // 실기: 키 id 는 password_btnNumberN 이고 N 과 라벨은 무관하다(매번 섞인다). 라벨을 지우면 키패드를 읽지 못한다
  const order = ['5', '2', '0', '8', '9', '7', '4', '1', '3', '6']
  const xml = [
    '<hierarchy rotation="0">',
    '<node text="29,960원을 결제하려면 비밀번호를 눌러주세요" resource-id="viva.republica.toss:id/password_tvInfo" class="android.widget.TextView" clickable="false" password="false" bounds="[183,357][537,469]" />',
    '<node text="1234" resource-id="viva.republica.toss:id/password_input" class="android.widget.EditText" clickable="true" password="true" bounds="[100,500][600,580]" />',
    ...order.map(
      (d, i) =>
        `<node text="${d}" resource-id="viva.republica.toss:id/password_btnNumber${i}" class="android.widget.Button" clickable="false" password="false" bounds="[${(i % 3) * 225},${880 + Math.floor(i / 3) * 150}][${(i % 3) * 225 + 225},${1030 + Math.floor(i / 3) * 150}]" />`
    ),
    '</hierarchy>'
  ].join('')

  it('숫자 키 라벨과 안내 문구는 남기고, 입력칸의 값만 버린다', () => {
    const screen = parseUiXml(xml, 's', 'viva.republica.toss')
    expect(screen.elements.some((e) => /결제하려면/.test(e.text))).toBe(true)
    expect(screen.elements.some((e) => e.text === '1234')).toBe(false)
    const layout = keypadFromUiTree(screen)
    expect(layout).not.toBeNull()
    expect(Object.keys(layout?.digits ?? {}).sort()).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9'
    ])
    // 라벨 기준으로 자리를 잡는다 — id 의 번호가 아니다
    expect(layout?.digits['5']).toEqual({ x: 113, y: 955 })
  })
})
