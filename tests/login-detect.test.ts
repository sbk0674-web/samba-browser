// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { buildSnapshot, findLoginFields } from '../src/preload/page-core'

// 스냅샷 id ↔ 요소를 이름/역할로 대조하기 위한 도우미
function snapshotWith(html: string): ReturnType<typeof buildSnapshot> {
  document.body.innerHTML = html
  return buildSnapshot()
}

function idOfName(snap: ReturnType<typeof buildSnapshot>, name: string): number | undefined {
  return snap.elements.find((e) => e.name === name)?.id
}

describe('findLoginFields 픽스처', () => {
  it('Nexacro(현대홈쇼핑 파트너센터): 비어 있는 비밀번호 칸은 type=text 다', () => {
    const snap = snapshotWith(`
      <div id="mainframe.VFrameSet00.LoginFrame.form.div_login.form.div_dtl.form.edt_userId">
        <input type="text" name="uid" id="mainframe.VFrameSet00.LoginFrame.form.div_login.form.div_dtl.form.edt_userId:input">
      </div>
      <div id="mainframe.VFrameSet00.LoginFrame.form.div_login.form.div_dtl.form.edt_password">
        <input type="text" name="upw" autocomplete="new-password" id="mainframe.VFrameSet00.LoginFrame.form.div_login.form.div_dtl.form.edt_password:input">
      </div>
    `)
    const f = findLoginFields()
    expect(f.password).toBe(idOfName(snap, 'upw'))
    expect(f.username).toBe(idOfName(snap, 'uid'))
  })

  it('Nexacro: div 로 그린 로그인 버튼을 제출 버튼으로 찾는다(찾기·재발급은 아니다)', () => {
    const snap = snapshotWith(`
      <div><input type="text" name="uid" id="f.edt_userId:input"></div>
      <div><input type="text" name="upw" autocomplete="new-password" id="f.edt_password:input"></div>
      <div id="find" tabindex="0" style="cursor:pointer">아이디 찾기</div>
      <div id="go" tabindex="0" style="cursor:pointer">로그인</div>
    `)
    const f = findLoginFields()
    const go = snap.elements.find((e) => e.text === '로그인' || e.name === '로그인')
    expect(go).toBeDefined()
    expect(f.submit).toBe(go?.id)
  })

  it('네이버: 아이디 또는 전화번호 라벨', () => {
    const snap = snapshotWith(`
      <form id="frmNIDLogin">
        <label for="id">아이디 또는 전화번호</label>
        <input type="text" id="id" name="id">
        <label for="pw">비밀번호</label>
        <input type="password" id="pw" name="pw">
        <button type="submit" id="log.login">로그인</button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.username).toBe(idOfName(snap, 'id'))
    expect(f.password).toBe(idOfName(snap, 'pw'))
    expect(f.submit).toBeDefined()
    expect(f.stage).toBe('single')
    expect(f.confidence).toBeGreaterThan(0.7)
  })

  it('쿠팡: 이메일(아이디) + 비밀번호', () => {
    const snap = snapshotWith(`
      <form class="login-form">
        <input type="text" name="login-email-input" placeholder="아이디(이메일)">
        <input type="password" name="login-password-input" placeholder="비밀번호">
        <input type="submit" value="로그인">
      </form>
    `)
    const f = findLoginFields()
    expect(f.username).toBe(idOfName(snap, 'login-email-input'))
    expect(f.password).toBe(idOfName(snap, 'login-password-input'))
    expect(f.stage).toBe('single')
    expect(f.submit).toBeDefined()
  })

  it('크림: 2단계 로그인 1단계(이메일만)', () => {
    const snap = snapshotWith(`
      <div class="login_box">
        <input type="email" name="email" autocomplete="email" placeholder="이메일 주소">
        <button type="button" class="btn_login">다음</button>
      </div>
    `)
    const f = findLoginFields()
    expect(f.stage).toBe('username-only')
    expect(f.username).toBe(idOfName(snap, 'email'))
    expect(f.password).toBeUndefined()
    expect(f.submit).toBeDefined()
  })

  it('무신사: 아이디/비밀번호 폼', () => {
    const snap = snapshotWith(`
      <form id="login_form">
        <input type="text" name="id" placeholder="아이디 또는 이메일">
        <input type="password" name="pw" placeholder="비밀번호">
        <button type="submit">로그인</button>
        <button type="button" class="btn_naver">네이버로 로그인</button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.username).toBe(idOfName(snap, 'id'))
    expect(f.password).toBe(idOfName(snap, 'pw'))
    // 소셜 로그인 버튼이 아니라 실제 제출 버튼을 고른다
    const socialId = snap.elements.find((e) => e.text === '네이버로 로그인')?.id
    expect(f.submit).not.toBe(socialId)
    expect(f.stage).toBe('single')
  })

  it('11번가: 검색창 노이즈가 있어도 아이디를 고른다', () => {
    const snap = snapshotWith(`
      <input type="text" name="searchKeyword" placeholder="검색어를 입력하세요">
      <form name="loginForm">
        <input type="text" name="loginName" placeholder="아이디">
        <input type="password" name="passWord" placeholder="비밀번호">
        <button type="submit">로그인</button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.username).toBe(idOfName(snap, 'loginName'))
    expect(f.password).toBe(idOfName(snap, 'passWord'))
    expect(f.stage).toBe('single')
  })

  it('지마켓: 폼 밖 버튼(SPA)도 제출로 인식', () => {
    const snap = snapshotWith(`
      <input type="text" id="typeMemberInputId" name="uid" placeholder="아이디">
      <input type="password" id="typeMemberInputPassword" name="upw" placeholder="비밀번호">
      <button type="button" id="btn_login">로그인</button>
    `)
    const f = findLoginFields()
    expect(f.username).toBe(idOfName(snap, 'uid'))
    expect(f.password).toBe(idOfName(snap, 'upw'))
    expect(f.submit).toBe(snap.elements.find((e) => e.text === '로그인')?.id)
  })

  it('패션플러스: 폼 안 type=button 로그인 버튼을 제출로 고른다(앞의 캐러셀 다음·찾기·소셜 제외)', () => {
    const snap = snapshotWith(`
      <div class="swiper">
        <button type="button" class="btn_swiper-prev"><b>이전</b></button>
        <button type="button" class="btn_swiper-next"><b>다음</b></button>
      </div>
      <form>
        <input type="text" name="userId" placeholder="아이디">
        <button type="button" class="btn_text-clear"><b>지우기</b></button>
        <button type="button" class="btn_text-pw"><b>비밀번호 보기</b></button>
        <input type="password" name="pw" placeholder="비밀번호">
        <button type="button" class="btn_find"><b>아이디 찾기</b></button>
        <button type="button" class="btn_naver"><b>네이버로 로그인</b></button>
        <button type="button" class="mm_btn __btn_lg_primary__"><b>로그인</b></button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.username).toBe(idOfName(snap, 'userId'))
    expect(f.password).toBe(idOfName(snap, 'pw'))
    expect(f.submit).toBe(snap.elements.find((e) => e.text === '로그인')?.id)
  })

  it('카카오: 2단계(아이디 화면) → username-only', () => {
    const snap = snapshotWith(`
      <form>
        <input type="text" name="loginId" autocomplete="username" placeholder="카카오메일 아이디, 이메일, 전화번호">
        <button type="submit">계속</button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.stage).toBe('username-only')
    expect(f.username).toBe(idOfName(snap, 'loginId'))
    expect(f.submit).toBeDefined()
  })

  it('구글 스타일: username-only 화면', () => {
    const snap = snapshotWith(`
      <form>
        <input type="email" name="identifier" autocomplete="username" aria-label="이메일 또는 휴대전화">
        <button type="button">다음</button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.stage).toBe('username-only')
    expect(f.username).toBe(idOfName(snap, 'identifier'))
    expect(f.password).toBeUndefined()
  })

  it('허니팟: 숨은 아이디/비밀번호 칸은 무시한다', () => {
    const snap = snapshotWith(`
      <form>
        <input type="text" name="honeypot_user" style="display:none">
        <input type="password" name="honeypot_pw" style="display:none">
        <input type="text" name="userId" placeholder="아이디">
        <input type="password" name="userPw" placeholder="비밀번호">
        <button type="submit">로그인</button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.username).toBe(idOfName(snap, 'userId'))
    expect(f.password).toBe(idOfName(snap, 'userPw'))
  })

  it('소셜 버튼만 있는 화면은 none', () => {
    snapshotWith(`
      <div>
        <button type="button">카카오로 시작하기</button>
        <button type="button">네이버로 로그인</button>
        <a href="/signup">회원가입</a>
      </div>
    `)
    const f = findLoginFields()
    expect(f.stage).toBe('none')
    expect(f.username).toBeUndefined()
    expect(f.password).toBeUndefined()
    expect(f.confidence).toBe(0)
  })

  it('회원가입 폼의 새 비밀번호/비밀번호 확인은 로그인 대상이 아니다', () => {
    const snap = snapshotWith(`
      <form>
        <input type="text" name="userId" placeholder="아이디">
        <input type="password" name="newPw" autocomplete="new-password" placeholder="새 비밀번호">
        <input type="password" name="newPwConfirm" placeholder="비밀번호 확인">
        <input type="password" name="loginPw" autocomplete="current-password" placeholder="비밀번호">
        <button type="submit">로그인</button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.password).toBe(idOfName(snap, 'loginPw'))
  })

  it('OTP(인증번호) 칸은 아이디 후보에서 제외한다', () => {
    const snap = snapshotWith(`
      <form>
        <input type="text" name="otpCode" placeholder="인증번호">
        <input type="text" name="memberId" placeholder="아이디">
        <input type="password" name="memberPw" placeholder="비밀번호">
        <button type="submit">로그인</button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.username).toBe(idOfName(snap, 'memberId'))
  })

  it('iframe 여부와 confidence 를 항상 반환한다', () => {
    snapshotWith(`
      <form>
        <input type="text" name="id" placeholder="아이디">
        <input type="password" name="pw" placeholder="비밀번호">
        <button type="submit">로그인</button>
      </form>
    `)
    const f = findLoginFields()
    expect(f.iframe).toBe(false)
    expect(f.confidence).toBeGreaterThan(0)
    expect(f.confidence).toBeLessThanOrEqual(1)
  })
})
