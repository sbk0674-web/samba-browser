import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import {
  HUMAN_BUSY_MS,
  HUMAN_BUSY_REFUSAL,
  automationBlocked,
  humanBusy,
  isHumanInputEvent,
  markHuman,
  runAsAutomation,
  withAutomationInput
} from '../src/main/browser/human-activity'

// 사람이 쓰는 탭에 자동화가 끼어들지 않는다(실기 2026-09-25: 두 입력이 섞여 네이버 계정 잠김)
const fakeWc = (): WebContents => ({ isDestroyed: () => false }) as unknown as WebContents

describe('human-activity', () => {
  it('사람 입력 뒤 창 안에서는 바쁨, 지나면 아님', () => {
    const wc = fakeWc()
    markHuman(wc, 1000)
    expect(humanBusy(wc, 1000 + HUMAN_BUSY_MS - 1)).toBe(true)
    expect(humanBusy(wc, 1000 + HUMAN_BUSY_MS + 1)).toBe(false)
  })

  it('자동화 흐름 안에서만 거절한다 — 사용자가 누른 자동완성은 막지 않는다', async () => {
    const wc = fakeWc()
    markHuman(wc)
    expect(automationBlocked(wc)).toBeNull()
    expect(await runAsAutomation(async () => automationBlocked(wc))).toBe(HUMAN_BUSY_REFUSAL)
  })

  it('사람이 안 쓰는 탭은 자동화도 통과', async () => {
    expect(await runAsAutomation(async () => automationBlocked(fakeWc()))).toBeNull()
  })

  it('자동화가 입력을 보내는 동안의 키 이벤트는 사람 입력이 아니다', async () => {
    const wc = fakeWc()
    let during = true
    await withAutomationInput(wc, async () => {
      during = isHumanInputEvent(wc)
    })
    expect(during).toBe(false)
    // 끝난 직후(늦게 도착한 제 이벤트)도 사람으로 세지 않는다
    expect(isHumanInputEvent(wc)).toBe(false)
    expect(isHumanInputEvent(wc, Date.now() + 5000)).toBe(true)
  })
})

import { needsHumanTyping } from '../src/main/browser/page-bridge'

describe('needsHumanTyping — 한 글자씩 키 입력은 GS샵·페이코만', () => {
  it('GS샵만 진짜 키 입력, 네이버 등은 값을 직접 넣는다(실기 2026-09-25 네이버 계정 잠김)', () => {
    expect(needsHumanTyping('www.gsshop.com')).toBe(true)
    expect(needsHumanTyping('nid.naver.com')).toBe(false)
    expect(needsHumanTyping('www.musinsa.com')).toBe(false)
  })
  it('페이코 로그인은 진짜 키 입력(값만 넣으면 로그인 버튼이 먹지 않음, 실기 2026-09-25)', () => {
    expect(needsHumanTyping('id.payco.com')).toBe(true)
    expect(needsHumanTyping('notpayco.com')).toBe(false)
    expect(needsHumanTyping('www.shoemarker.co.kr')).toBe(true)
    // 현대홈쇼핑 파트너센터만 — H몰 고객 사이트 로그인은 그대로 둔다
    expect(needsHumanTyping('partner.hmall.com')).toBe(true)
    expect(needsHumanTyping('www.hmall.com')).toBe(false)
  })
  it('롯데온 로그인은 진짜 키 입력(값만 넣으면 비밀번호 칸이 비어 있다고 나옴, 실기 2026-11-26)', () => {
    expect(needsHumanTyping('www.lotteon.com')).toBe(true)
    expect(needsHumanTyping('member.lotteon.com')).toBe(true)
    expect(needsHumanTyping('notlotteon.com')).toBe(false)
  })
})
