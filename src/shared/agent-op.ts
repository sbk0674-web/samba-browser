// 메인 프로세스가 iframe 안 preload 에 맡기는 동작 한 건.
//
// WebFrameMain 에는 executeJavaScriptInIsolatedWorld 가 없다. frame.executeJavaScript 는
// 페이지의 메인 월드에서 돌아 격리 월드의 __samba 에 닿지 못하고, 거기에 실행기를 두면
// 적대 페이지가 가로챌 수 있다. 그래서 프레임 호출은 IPC 로 하되 **코드 문자열은 보내지 않고**
// 미리 정해진 동작 이름과 인자만 보낸다 — 프레임 preload 는 이 목록에 있는 것만 실행한다.
//
// [주의] 이 파일은 preload(page-core.ts)에서도 쓰이므로 **타입만** 있어야 한다.
// 값(상수·함수)을 넣으면 Rollup 이 공용 청크를 만들어 preload 번들이 깨진다
// (tests/preload-bundle.test.ts 참고)
export type AgentOp =
  | { op: 'snapshot'; query?: string; selector?: string }
  | { op: 'textOf'; id: number }
  | { op: 'click'; id: number }
  | { op: 'type'; id: number; text: string; submit: boolean }
  | { op: 'select'; id: number; value: string }
  | { op: 'scroll'; dir: 'up' | 'down'; id?: number }
  | { op: 'fillValue'; id: number; value: string }
  | { op: 'submitForm'; id: number }
  | { op: 'isSecretField'; id: number }
  // 요소 가운데의 뷰포트 좌표(실제 마우스 클릭을 보낼 자리). 메인 프레임에서만 쓴다
  | { op: 'rectOf'; id: number }
  | { op: 'valueLength'; id: number }
  | { op: 'hasFocus'; id: number }
  | { op: 'focusEl'; id: number }
  | { op: 'idOfExactText'; text: string; nth: number }
  | { op: 'idOfRowCell'; id: number; index: number }
  | { op: 'ancestorsOf'; id: number }
  | { op: 'keypadSignals' }
  // 결제 비밀번호 키패드의 숫자 버튼 배치(앱이 키마스터 값을 넣을 때 쓴다). 값은 오가지 않는다
  | { op: 'keypadLayout' }
  // 글자 없는 키패드 버튼들의 뷰포트 사각형(앱이 OCR 로 숫자를 읽을 자리). 메인 프레임에서만 쓴다
  | { op: 'keypadUnlabeled' }
  // 키패드 버튼을 정확히 한 번만 누른다(폴백 없음). 일반 click 은 변화가 안 보이면 Enter·좌표로
  // 다시 눌러 같은 숫자가 두세 번 들어갈 수 있다(실기: 무신사페이 오답)
  | { op: 'pressOnce'; id: number }
  | { op: 'overlays' }
  // 라벨 글자로 체크박스를 켠다(숨은 체크박스 포함 — 페이코 '전체 동의'). 결과는 checked·already·not-found·failed
  | { op: 'checkByLabel'; text: string }
