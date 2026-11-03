// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  buildSnapshot,
  findLoginFields,
  fillValue,
  submitForm,
  installCaptureListener,
  isLoginSubmitClick,
  readLoginCredentials,
  readUsernameStep
} from '../src/preload/page-core'

describe('findLoginFields', () => {
  it('아이디/비밀번호/로그인 버튼 폼에서 필드를 찾는다(노이즈 포함)', () => {
    document.body.innerHTML = `
      <input type="text" name="q" placeholder="검색">
      <form id="loginForm">
        <input type="text" name="userId" placeholder="아이디">
        <input type="password" name="pw">
        <button type="submit">로그인</button>
      </form>
    `
    const snap = buildSnapshot()
    const fields = findLoginFields()
    const idOf = (name: string): number | undefined =>
      snap.elements.find((e) => e.name === name)?.id

    expect(fields.password).toBe(idOf('pw'))
    expect(fields.username).toBe(idOf('userId'))
    expect(fields.submit).toBeDefined()
  })

  it('이메일 로그인 폼도 탐지한다', () => {
    document.body.innerHTML = `
      <form>
        <input type="email" name="email" autocomplete="email">
        <input type="password" name="password">
        <button type="submit">Sign in</button>
      </form>
    `
    buildSnapshot()
    const fields = findLoginFields()
    expect(fields.username).toBeDefined()
    expect(fields.password).toBeDefined()
    expect(fields.submit).toBeDefined()
  })

  it('비밀번호만 있는 2단계 폼은 username 이 undefined', () => {
    document.body.innerHTML = `
      <form>
        <input type="password" name="password">
        <button type="submit">로그인</button>
      </form>
    `
    buildSnapshot()
    const fields = findLoginFields()
    expect(fields.username).toBeUndefined()
    expect(fields.password).toBeDefined()
  })

  it('registry 가 비어 있으면 내부적으로 buildSnapshot 을 호출한다', () => {
    // 빈 페이지를 한 번 스냅샷해서 registry 를 실제로 비운 뒤(길이 0), DOM 을 바꾸고
    // buildSnapshot() 을 다시 부르지 않은 채 findLoginFields() 만 호출한다
    document.body.innerHTML = ''
    buildSnapshot()
    document.body.innerHTML = `
      <form>
        <input type="text" name="id">
        <input type="password" name="pw">
        <button type="submit">로그인하기</button>
      </form>
    `
    const fields = findLoginFields()
    expect(fields.password).toBeDefined()
    expect(fields.username).toBeDefined()
    expect(fields.submit).toBeDefined()
  })

  it('폼이 없고 로그인 텍스트 버튼만 있는 경우도 submit 을 찾는다', () => {
    document.body.innerHTML = `
      <input type="text" id="u">
      <input type="password" id="p">
      <button>로그인하기</button>
      <button>검색</button>
    `
    const snap = buildSnapshot()
    const fields = findLoginFields()
    const loginBtnId = snap.elements.find((e) => e.text === '로그인하기')?.id
    expect(fields.submit).toBe(loginBtnId)
  })
})

describe('fillValue', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input type="text" name="userId">
      <input type="password" name="pw">
    `
    buildSnapshot()
  })

  it('SECRET(password) 칸에도 값을 넣는다', () => {
    expect(fillValue(2, 's3cret')).toBe('ok')
    expect((document.querySelector('[name=pw]') as HTMLInputElement).value).toBe('s3cret')
  })

  it('input/change 이벤트를 발생시킨다', () => {
    const el = document.querySelector('[name=pw]') as HTMLInputElement
    const inputHandler = vi.fn()
    const changeHandler = vi.fn()
    el.addEventListener('input', inputHandler)
    el.addEventListener('change', changeHandler)
    fillValue(2, 'abc')
    expect(inputHandler).toHaveBeenCalledTimes(1)
    expect(changeHandler).toHaveBeenCalledTimes(1)
  })

  it('없는 id 는 not found', () => {
    expect(fillValue(99, 'x')).toMatch(/not found/)
  })
})

describe('submitForm', () => {
  it('제출 버튼이 있는 폼은 버튼을 클릭한다(사이트 핸들러가 캡차 토큰을 붙인다 — GS샵 실기)', () => {
    document.body.innerHTML = `
      <form>
        <input type="password" name="pw">
        <button type="submit">로그인</button>
      </form>
    `
    buildSnapshot()
    const form = document.querySelector('form') as HTMLFormElement
    const requestSubmit = vi.fn()
    form.requestSubmit = requestSubmit
    const clicked = vi.fn()
    document.querySelector('button')!.addEventListener('click', (e) => {
      e.preventDefault()
      clicked()
    })
    const snap = buildSnapshot()
    const pwId = snap.elements.find((e) => e.tag === 'input')!.id
    expect(submitForm(pwId)).toBe('ok')
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(requestSubmit).not.toHaveBeenCalled()
    // 버튼 id 로 불러도 버튼을 누른다
    const btnId = snap.elements.find((e) => e.tag === 'button')!.id
    expect(submitForm(btnId)).toBe('ok')
    expect(clicked).toHaveBeenCalledTimes(2)
  })

  it('제출 버튼이 없는 폼만 requestSubmit 을 호출한다', () => {
    document.body.innerHTML = `
      <form>
        <input type="password" name="pw">
        <a href="#">로그인</a>
      </form>
    `
    buildSnapshot()
    const form = document.querySelector('form') as HTMLFormElement
    const requestSubmit = vi.fn()
    form.requestSubmit = requestSubmit
    const pwId = buildSnapshot().elements.find((e) => e.tag === 'input')!.id
    expect(submitForm(pwId)).toBe('ok')
    expect(requestSubmit).toHaveBeenCalledTimes(1)
  })

  it('type=button 로그인 버튼 id 를 받으면 폼 제출 대신 그 버튼을 누른다(패션플러스 Vue v-on:click)', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="uid">
        <input type="password" name="pw">
        <button type="button" class="btn_text-pw"><b>비밀번호 보기</b></button>
        <button type="button" class="mm_btn"><b>로그인</b></button>
      </form>
    `
    const form = document.querySelector('form') as HTMLFormElement
    const requestSubmit = vi.fn()
    form.requestSubmit = requestSubmit
    const buttons = Array.from(document.querySelectorAll('button'))
    const toggled = vi.fn()
    const loggedIn = vi.fn()
    buttons[0].addEventListener('click', toggled)
    buttons[1].addEventListener('click', loggedIn)
    const snap = buildSnapshot()
    const btnId = snap.elements.find((e) => e.text === '로그인')!.id
    expect(submitForm(btnId)).toBe('ok')
    expect(loggedIn).toHaveBeenCalledTimes(1)
    expect(requestSubmit).not.toHaveBeenCalled()
    // 비밀번호 칸 id 로 불러도 폼 안 로그인 글자 버튼을 누른다(비밀번호 보기·찾기는 누르지 않는다)
    const pwId = snap.elements.find((e) => e.name === 'pw')!.id
    expect(submitForm(pwId)).toBe('ok')
    expect(loggedIn).toHaveBeenCalledTimes(2)
    expect(toggled).not.toHaveBeenCalled()
    expect(requestSubmit).not.toHaveBeenCalled()
  })

  it('누를 버튼이 없으면 비밀번호 칸에 Enter keydown·keyup 을 보낸다(Vue keyup.enter)', () => {
    document.body.innerHTML = `<div><input type="password" name="pw"></div>`
    const pw = document.querySelector('input') as HTMLInputElement
    const keys: string[] = []
    pw.addEventListener('keydown', (e) => keys.push(`down:${e.key}:${e.keyCode}`))
    pw.addEventListener('keyup', (e) => keys.push(`up:${e.key}:${e.keyCode}`))
    const pwId = buildSnapshot().elements[0].id
    expect(submitForm(pwId)).toBe('ok')
    expect(keys).toEqual(['down:Enter:13', 'up:Enter:13'])
  })

  it('form 이 없으면 click 을 호출한다', () => {
    document.body.innerHTML = `<button>로그인하기</button>`
    buildSnapshot()
    const btn = document.querySelector('button') as HTMLButtonElement
    const clicked = vi.fn()
    btn.addEventListener('click', clicked)
    const id = buildSnapshot().elements[0].id
    expect(submitForm(id)).toBe('ok')
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('없는 id 는 not found', () => {
    expect(submitForm(99)).toMatch(/not found/)
  })
})

describe('installCaptureListener', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="loginForm">
        <input type="text" name="userId" placeholder="아이디">
        <input type="password" name="pw">
        <button type="submit">로그인</button>
      </form>
    `
  })

  it('submit 시 host/username/password 를 전달한다', () => {
    const send = vi.fn()
    // jsdom 의 dispatchEvent 는 isTrusted=false 이므로 테스트에서만 합성 이벤트를 허용한다
    installCaptureListener(send, { allowUntrusted: true })
    ;(document.querySelector('[name=userId]') as HTMLInputElement).value = 'shopmine'
    ;(document.querySelector('[name=pw]') as HTMLInputElement).value = 'p@ss'
    const form = document.getElementById('loginForm') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'shopmine', password: 'p@ss' })
    )
  })

  it('password 가 비어 있으면 전달하지 않는다', () => {
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    ;(document.querySelector('[name=userId]') as HTMLInputElement).value = 'shopmine'
    const form = document.getElementById('loginForm') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    expect(send).not.toHaveBeenCalled()
  })

  it('신뢰되지 않은(합성) submit 이벤트는 옵션 없이는 무시한다', () => {
    const send = vi.fn()
    installCaptureListener(send) // allowUntrusted 미지정 → 기본값(page.ts 와 동일)
    ;(document.querySelector('[name=userId]') as HTMLInputElement).value = 'shopmine'
    ;(document.querySelector('[name=pw]') as HTMLInputElement).value = 'p@ss'
    const form = document.getElementById('loginForm') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    expect(send).not.toHaveBeenCalled()
  })

  it('폼 밖 버튼 클릭(SPA)도 감지한다', () => {
    document.body.innerHTML = `
      <input type="text" id="u">
      <input type="password" id="p">
      <button id="go" type="button">로그인</button>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    ;(document.getElementById('u') as HTMLInputElement).value = 'me'
    ;(document.getElementById('p') as HTMLInputElement).value = 'secret1'
    document.getElementById('go')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'me', password: 'secret1' })
    )
  })

  it('비밀번호가 채워진 상태에서 무관한 버튼을 클릭해도 전송하지 않는다(오탐 방지)', () => {
    document.body.innerHTML = `
      <form id="loginForm">
        <input type="text" name="userId" placeholder="아이디">
        <input type="password" name="pw">
        <button type="submit">로그인</button>
      </form>
      <button id="cancel" type="button">취소</button>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    ;(document.querySelector('[name=userId]') as HTMLInputElement).value = 'shopmine'
    ;(document.querySelector('[name=pw]') as HTMLInputElement).value = 'p@ss'
    document.getElementById('cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(send).not.toHaveBeenCalled()
  })

  it('form 밖의 로그인과 무관한 버튼 클릭은 전송하지 않는다', () => {
    document.body.innerHTML = `
      <input type="text" id="u">
      <input type="password" id="p">
      <button id="unrelated" type="button">검색</button>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    ;(document.getElementById('u') as HTMLInputElement).value = 'me'
    ;(document.getElementById('p') as HTMLInputElement).value = 'secret1'
    document.getElementById('unrelated')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(send).not.toHaveBeenCalled()
  })

  it('호스트당 30초에 4번째 전송(서명 무관)은 무시한다', () => {
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    const userEl = document.querySelector('[name=userId]') as HTMLInputElement
    const pwEl = document.querySelector('[name=pw]') as HTMLInputElement
    const form = document.getElementById('loginForm') as HTMLFormElement

    for (let i = 0; i < 4; i++) {
      userEl.value = `user${i}`
      pwEl.value = `pass${i}`
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    }

    expect(send).toHaveBeenCalledTimes(3)
  })
})

describe('readLoginCredentials — 저장 제안용 감지 판정', () => {
  it('제출된 폼 안의 비밀번호 칸과 짝 아이디를 읽는다', () => {
    document.body.innerHTML = `
      <input type="password" id="other">
      <form id="f">
        <input type="text" name="userId" placeholder="아이디" value="shopmine">
        <input type="password" name="pw" value="p@ss">
      </form>
    `
    const form = document.getElementById('f') as HTMLFormElement
    expect(readLoginCredentials(form)).toEqual({ username: 'shopmine', password: 'p@ss' })
  })

  it('비밀번호 값이 없으면 null', () => {
    document.body.innerHTML = `
      <form id="f"><input type="text" name="userId" value="me"><input type="password" name="pw"></form>
    `
    expect(readLoginCredentials(document.getElementById('f') as HTMLFormElement)).toBeNull()
  })

  it('비밀번호 변경 화면에서는 새 비밀번호·확인칸이 아니라 현재 비밀번호 칸을 고른다', () => {
    document.body.innerHTML = `
      <input type="text" name="userId" placeholder="아이디" value="me">
      <input type="password" name="newPw" autocomplete="new-password" value="new1">
      <input type="password" name="curPw" autocomplete="current-password" value="cur1">
    `
    expect(readLoginCredentials(null)?.password).toBe('cur1')
  })

  it('아이디 칸이 없으면(2단계 로그인) 기억한 앞 단계 아이디를 쓴다', () => {
    document.body.innerHTML = `<input type="password" name="pw" value="p@ss">`
    expect(readLoginCredentials(null, 'first-step')).toEqual({
      username: 'first-step',
      password: 'p@ss'
    })
  })

  it('비밀번호 칸이 없는 아이디 단계에서만 아이디를 읽는다', () => {
    document.body.innerHTML = `<input type="email" name="email" value="me@example.com">`
    expect(readUsernameStep()).toBe('me@example.com')
    document.body.innerHTML = `
      <input type="email" name="email" value="me@example.com"><input type="password" value="x">
    `
    expect(readUsernameStep()).toBe('')
  })
})

describe('installCaptureListener — 2단계 로그인·Enter 제출', () => {
  it('아이디 단계에서 다음을 누르면 기억했다가 비밀번호 단계 제출에 붙인다', () => {
    document.body.innerHTML = `
      <input type="email" name="email" autocomplete="username">
      <button id="next" type="button">다음</button>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    ;(document.querySelector('[name=email]') as HTMLInputElement).value = 'two@step.com'
    document.getElementById('next')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // 아이디 단계에서는 아무것도 보내지 않는다
    expect(send).not.toHaveBeenCalled()

    document.body.innerHTML = `
      <form id="f"><input type="password" name="pw"><button type="submit">로그인</button></form>
    `
    ;(document.querySelector('[name=pw]') as HTMLInputElement).value = 'pw-2step'
    document
      .getElementById('f')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'two@step.com', password: 'pw-2step' })
    )
  })

  it('Google처럼 문서가 바뀐 비밀번호 단계는 화면의 이메일 힌트로 저장 제안을 보낸다', () => {
    document.body.innerHTML = `
      <div data-email="shown">roasterydg@gmail.com</div>
      <form id="f">
        <input type="hidden" name="identifier" value="roasterydg@gmail.com">
        <input type="password" name="Passwd" value="google-pw">
        <button id="next" type="button">다음</button>
      </form>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    document.getElementById('next')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'roasterydg@gmail.com', password: 'google-pw' })
    )
  })

  it('폼 없는 비밀번호 칸에서 Enter 로 제출해도 잡는다', () => {
    document.body.innerHTML = `
      <input type="text" id="u" placeholder="아이디">
      <input type="password" id="p">
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    ;(document.getElementById('u') as HTMLInputElement).value = 'enter-user'
    const pw = document.getElementById('p') as HTMLInputElement
    pw.value = 'enter-pw'
    pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'enter-user', password: 'enter-pw' })
    )
  })

  it('신뢰되지 않은(합성) Enter 는 무시한다 — 자동화 스크립트가 만든 이벤트', () => {
    document.body.innerHTML = `
      <input type="text" id="u" placeholder="아이디">
      <input type="password" id="p">
    `
    const send = vi.fn()
    installCaptureListener(send)
    ;(document.getElementById('u') as HTMLInputElement).value = 'bot'
    const pw = document.getElementById('p') as HTMLInputElement
    pw.value = 'bot-pw'
    pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(send).not.toHaveBeenCalled()
  })
})

describe('installCaptureListener — 실제 쇼핑몰 로그인 방식(JS 버튼·Enter 가로채기)', () => {
  const fill = (user: string, pw: string): void => {
    ;(document.getElementById('u') as HTMLInputElement).value = user
    ;(document.getElementById('p') as HTMLInputElement).value = pw
  }

  it('폼 안의 type="button" 로그인 버튼(패션플러스 v-on:click="login")도 잡는다', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="u" class="textfield">
        <input type="password" id="p" class="textfield">
        <input type="checkbox"> <span>아이디 저장</span>
        <button type="button" id="go" class="mm_btn"><b>로그인</b></button>
        <input hidden>
      </form>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    fill('fp-user', 'fp-pass')
    document.getElementById('go')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'fp-user', password: 'fp-pass' })
    )
  })

  it('버튼 안쪽 글자(<b>)를 눌러도 버튼 클릭으로 본다', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="u"><input type="password" id="p">
        <button type="button"><b id="inner">로그인</b></button>
      </form>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    fill('inner-user', 'inner-pass')
    document.getElementById('inner')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('폼 안 비밀번호 칸의 Enter 를 페이지가 가로채도(현대H몰) 잡는다', () => {
    document.body.innerHTML = `
      <form name="login">
        <input type="text" id="u" name="userid">
        <input type="password" id="p" name="password">
        <button type="button">로그인</button>
      </form>
    `
    const pw = document.getElementById('p') as HTMLInputElement
    // 페이지 핸들러: Enter 를 막고 JS 로 로그인한다(submit 이벤트가 생기지 않는다)
    pw.addEventListener('keydown', (e) => e.preventDefault())
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    fill('hm-user', 'hm-pass')
    pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'hm-user', password: 'hm-pass' })
    )
  })

  it('Enter 뒤 브라우저 submit 이 이어져도 한 번만 보낸다', () => {
    document.body.innerHTML = `
      <form id="f">
        <input type="text" id="u" placeholder="아이디">
        <input type="password" id="p">
        <button type="submit">로그인</button>
      </form>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    fill('dup-user', 'dup-pass')
    const pw = document.getElementById('p') as HTMLInputElement
    pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    document
      .getElementById('f')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('이미지 로그인 링크(<a href="javascript:"><img alt="로그인">)도 잡는다', () => {
    document.body.innerHTML = `
      <input type="text" id="u" name="mem_id">
      <input type="password" id="p" name="mem_pw">
      <a href="#" id="go"><img src="btn_login.gif" alt="로그인"></a>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    fill('img-user', 'img-pass')
    document.querySelector('#go img')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('아이디 찾기·회원가입·소셜 로그인·다른 폼 버튼은 로그인 제출로 보지 않는다', () => {
    document.body.innerHTML = `
      <form id="search"><input type="text" name="q"><button type="button" id="sbtn">로그인 검색</button></form>
      <form>
        <input type="text" id="u"><input type="password" id="p">
        <button type="button">로그인</button>
      </form>
      <a href="/auth/find-id" id="find">아이디 찾기</a>
      <a href="/join" id="join">회원가입</a>
      <a href="#" id="naver">네이버 로그인</a>
      <label><input type="checkbox" id="keep">로그인 상태 유지</label>
    `
    const send = vi.fn()
    installCaptureListener(send, { allowUntrusted: true })
    fill('nope', 'nope-pass')
    for (const id of ['find', 'join', 'naver', 'keep', 'sbtn']) {
      document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('원인 파악용 단계를 알린다 — 빈 비밀번호 제출, 로그인 아닌 클릭(값은 담지 않는다)', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="u"><input type="password" id="p">
        <button type="button" id="go">로그인</button>
        <button type="button" id="other">취소</button>
      </form>
    `
    const send = vi.fn()
    const trace = vi.fn()
    installCaptureListener(send, { allowUntrusted: true, trace })
    ;(document.getElementById('u') as HTMLInputElement).value = 'only-id'
    document.getElementById('go')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(trace).toHaveBeenCalledWith('no-password-value')
    fill('only-id', 'pw-now')
    document.getElementById('other')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(trace).toHaveBeenCalledWith('click-not-login')
    expect(send).not.toHaveBeenCalled()
    for (const call of trace.mock.calls) expect(JSON.stringify(call)).not.toContain('pw-now')
  })
})

describe('isLoginSubmitClick', () => {
  it('폼의 submit 버튼은 글자와 무관하게 제출이다', () => {
    document.body.innerHTML = `
      <form><input type="password" id="p"><button id="b">확인</button></form>
    `
    const pw = document.getElementById('p') as HTMLInputElement
    expect(isLoginSubmitClick(document.getElementById('b')!, pw)).toBe(true)
  })

  it('글자가 너무 긴 링크(안내문)는 제출로 보지 않는다', () => {
    document.body.innerHTML = `
      <input type="password" id="p">
      <a id="a">로그인하시면 더 많은 혜택을 받을 수 있습니다 지금 바로 확인해 보세요</a>
    `
    const pw = document.getElementById('p') as HTMLInputElement
    expect(isLoginSubmitClick(document.getElementById('a')!, pw)).toBe(false)
  })

  it('Google 같은 2단계 로그인의 다음 버튼도 비밀번호 제출로 본다', () => {
    document.body.innerHTML = `
      <input type="password" id="p" value="pw">
      <button id="next" type="button">다음</button>
      <button id="next-en" type="button">Next</button>
    `
    const pw = document.getElementById('p') as HTMLInputElement
    expect(isLoginSubmitClick(document.getElementById('next')!, pw)).toBe(true)
    expect(isLoginSubmitClick(document.getElementById('next-en')!, pw)).toBe(true)
  })
})
