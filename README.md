# SAMBA Browser (삼바브라우저)

사람이 하는 웹 작업(로그인·인증·결제 포함)을 AI 가 대신 끝내주는 Chromium 기반 데스크톱 브라우저

Electron 39 · React 19 · TypeScript · Tailwind CSS · MIT 라이선스 · Windows 11 검증

---

## 3분 퀵스타트

### 준비물 (한 번만)

| 무엇 | 확인 / 설치 |
|---|---|
| Windows 11 | (macOS·Linux 는 아직 검증하지 않았습니다) |
| Node.js 20 이상 | `node -v` → 없으면 [nodejs.org](https://nodejs.org) 에서 LTS 설치 |
| pnpm 9 이상 | `corepack enable` 한 번 실행 (Node 에 들어 있습니다) |
| Git | `git --version` |

### 받아서 실행

```bash
git clone https://github.com/sbk0674-web/samba-browser.git
cd samba-browser
pnpm install   # 30초~3분 (Electron 내려받기 포함)
pnpm dev       # 브라우저 창이 뜹니다
```

`.env` 는 **만들지 않아도 됩니다.** 계정·동기화를 쓰지 않으면 앱은 이 PC 전용으로 그대로 돌아갑니다
(브라우징·AI 에이전트·키마스터·가져오기·번역·캡처 전부 동작합니다).
다른 PC 와 동기화하고 싶으면 아래 "내 Supabase 만들기" 를 따라 하세요.

### 첫 실행에서 할 일

1. **AI 연결** — 오른쪽 AI 패널에 "AI 가 아직 연결되지 않았어요" 한 줄이 보이면 그 링크(설정 → AI 연결)로 갑니다. 셋 중 하나를 고르세요.
   - **Claude 구독** — Claude Code 가 설치·로그인돼 있으면 [연결] 한 번으로 끝. 안 돼 있으면 터미널에서 `claude login`
   - **Codex 구독** — OpenAI Codex CLI 로그인 (단, 페이지 번역은 Claude 경로만 지원)
   - **내 API 키** — Anthropic·OpenAI 키를 직접 입력. 키는 이 PC 에서 암호화 저장되고 동기화되지 않습니다
2. **키마스터 마스터 비밀번호** — 왼쪽 사이드바 → 키마스터 → 마스터 비밀번호 설정. 로그인·결제 비밀번호·카드 같은 비밀값은 여기서만 암호화 보관되고 AI 는 값을 보지 못합니다. 설정 → 보안에서 **복구 키**를 꼭 받아 두세요(마스터 비밀번호와 복구 키를 둘 다 잃으면 열 수 없습니다)
3. **가져오기** — 키마스터에서 크롬·웨일·엣지·Bitwarden 의 비밀번호 CSV, 북마크 HTML 을 가져옵니다
4. (선택) **동기화** — 다른 PC 와 맞추고 싶을 때만. 아래 "내 Supabase 만들기" 참고

### (선택) 내 Supabase 만들기 — 다기기 동기화용

동기화는 **각자 자기 Supabase 프로젝트**에 붙습니다. 내 데이터가 내 프로젝트에만 들어가고,
안 만들면 앱은 로컬 전용으로 잘 돌아갑니다.

1. [supabase.com](https://supabase.com) 에서 무료 프로젝트를 만듭니다
2. 대시보드 → **SQL Editor** 에 이 저장소의 [`supabase/schema.sql`](supabase/schema.sql) 내용을 붙여넣고 실행합니다
3. **Project Settings → API** 에서 **Project URL** 과 **anon(publishable) 키**를 복사합니다 (`service_role` 키는 절대 쓰지 마세요)
4. 앱 → **설정 → 계정 → Supabase 연결** 에 두 값을 붙여넣고 [저장] → 앱을 다시 시작합니다
5. 설정 → 계정 → **회원가입** → 두 번째 PC 에서 같은 계정으로 로그인하면 설정·계정·키마스터(암호문만)·북마크·채팅이 내려옵니다

구글 로그인을 쓰려면 Supabase 대시보드의 **Authentication → URL Configuration → Redirect URLs** 에
`http://127.0.0.1:47612/callback`·`47613`·`47614` 를 등록해야 합니다.
자세한 설정은 [docs/supabase-설정.md](docs/supabase-설정.md) 를 보세요.
`.env` 에 `SAMBA_SUPABASE_URL`·`SAMBA_SUPABASE_ANON_KEY` 를 넣어도 되며, 앱 설정값이 있으면 그쪽이 우선합니다.

### 써보기

- 오른쪽 채팅에 `구글 열어서 삼바웨이브 검색해` 입력 → AI 가 진행 로그를 보여주며 수행, 진행 띠의 [중단]으로 멈춤
- 위험한 행동(결제·구매·삭제)은 노란 확인 카드가 뜹니다 → [승인] / [거부]
- `네이버 로그인해` → 키마스터에 저장된 계정으로 AI 가 로그인 (캡차는 사용자가 처리하면 자동 재개)

---

## 기능 요약

- **AI 에이전트 브라우징** — 탭 열기·클릭·입력·스크롤·검색을 AI 가 직접 수행. 도구 호출마다 진행 로그, 위험 행동은 확인 게이트
- **파일 업로드·다운로드 도구** — `upload_file`(파일 input 에 로컬 파일 주입), `set_download_dir`·`list_downloads`(다운로드 폴더 지정과 기록). 업로드는 항상 확인 카드를 거칩니다(브릿지 제외)
- **페이지 컨텍스트 fetch** — `fetch_url` 로 로그인 쿠키가 실린 같은 출처 이미지·파일을 받아 저장(비브라우저 요청을 막는 사이트용)
- **키마스터** — 로그인·결제 비밀번호·카드·신분증 등 6종을 마스터 비밀번호로 암호화 저장(argon2id + AES-256-GCM). AI 는 `login`/`fill_secret` 으로 채우기만 합니다
- **자동 로그인** — 아이디 칸 계정 드롭리스트, AI 로그인(2단계 로그인 포함), 비밀번호 변경 시 자동 갱신
- **가져오기** — 비밀번호 CSV, 북마크 HTML (크롬·웨일·엣지·Bitwarden)
- **계정·다기기 동기화** — Supabase 로그인(이메일/구글), 작업공간 `Ctrl+Alt+1~9`, 기기 목록·원격 로그아웃
- **확장 프로그램** — 크롬 웹스토어에서 바로 설치, 기존 브라우저에서 가져오기
- **번역** — 페이지 번역(보이는 부분부터·자동 번역 도메인), 우클릭 이미지 번역
- **캡처** — 이미지(영역·전체 페이지·전체 화면)·영상, `Alt+1~6`
- **마우스 제스처** — 오른쪽 버튼 드래그 16종(웨일 기본값, 변경 가능)
- **로컬 OCR** — PP-OCRv5 한국어 ONNX(첫 사용 시 약 18MB 다운로드), 설정에서 끌 수 있음
- **자체 새 탭** `samba://newtab`, 북마크 관리자, 한국어/영어 UI

## 폰 연동

안드로이드 폰을 USB 로 연결해 문자 인증번호 자동 읽기, ARS 감시, 페이코·토스 결제 승인까지 이어집니다.

1. 폰에서 **개발자 옵션 → USB 디버깅** 켜고 USB 연결 (폰에 뜨는 "USB 디버깅 허용" 승인)
2. 앱 → **폰** 화면 → 도구 카드에서 **adb·scrcpy 원클릭 설치** (앱 데이터 폴더에 내려받습니다. 따로 설치할 필요 없습니다)
3. 기기 목록에서 **연결** → 화면 스트림·문자 권한 확인. 사이트별 인증 폰 지정 가능
4. 결제 승인 비밀번호는 앱 안 폰 화면에서 **사용자가 직접** 누릅니다 (AI·로그에 흐르지 않습니다)


## 문제 해결

| 증상 | 해결 |
|---|---|
| `pnpm` 명령이 없다 | `corepack enable` 후 터미널 다시 열기. 그래도 안 되면 `npm i -g pnpm` |
| `pnpm install` 중 "Ignored build scripts: onnxruntime-node, electron-winstaller" 경고 | **정상입니다.** 필요한 네이티브 바이너리는 패키지에 들어 있어 무시해도 동작합니다. 그래도 걸리면 `pnpm approve-builds` 로 허용 |
| `postinstall`(electron-builder install-app-deps) 실패 | Node 20 이상인지 확인(`node -v`). 네트워크가 막힌 회사망이면 Electron·네이티브 바이너리 다운로드가 실패합니다 — 프록시를 풀거나 `ELECTRON_MIRROR` 지정. 그래도 안 되면 `node_modules` 와 `pnpm-lock.yaml` 재설치 대신 `pnpm install --ignore-scripts` 로 넘기고 `pnpm dev` 를 시도해 보세요(OCR 등 일부 기능만 빠집니다) |
| `ERR_REQUIRE_CYCLE_MODULE` / `Cannot require() ES Module ... electron-vite.js` | 프로젝트 경로가 너무 길면(윈도우 260자 제한) Node 가 패키지 설정을 못 읽어 생깁니다. `C:\Users\<이름>\samba-browser` 처럼 짧은 경로에 clone 하세요 |
| `Port 5173 is in use, trying another one...` | 이미 떠 있는 `pnpm dev` 가 있다는 뜻입니다. 그대로 두면 5174 로 올라가니 대개 문제없습니다. 정리하려면 `netstat -ano \| findstr 5173` → `taskkill /PID <pid> /F` |
| 방화벽 경고 창이 뜸 | Electron/Node 의 로컬 포트 접근을 허용하세요(렌더러 개발 서버 5173, 구글 로그인 콜백 47612~47614) |
| 창은 뜨는데 웹페이지가 안 보임 | 창 크기를 한 번 바꿔보고, 안 되면 `pnpm dev` 재실행 |
| 채팅에 "AI 연결이 안 됐어요" | 설정 → AI 연결에서 경로를 연결하거나 터미널에서 `claude login` |
| AI 가 오래 응답이 없음 | 구독 사용 한도일 수 있습니다. [중단] 후 잠시 뒤 재시도, 또는 설정에서 API 키 사용 |
| 로그인창에 계정 목록이 안 뜸 | 키마스터가 잠겨 있으면 안 뜹니다. 왼쪽 키마스터에서 잠금 해제 |
| OCR 이 "모델 없음" | 첫 1회 다운로드가 필요합니다. 인터넷 연결 확인 후 재시도 |
| 코드를 고쳤는데 반영 안 됨 | 화면(renderer)은 자동 반영되지만 `src/main`·`src/preload` 는 앱을 닫고 `pnpm dev` 재실행 |
| 앱을 두 개 띄우니 `EPERM ... rename data.db` 오류 | 같은 데이터 폴더를 두 인스턴스가 쓰면 생깁니다. 두 번째는 자동으로 닫히지만, 검증·개발용으로 나란히 띄우려면 `SAMBA_USER_DATA=<빈 폴더> pnpm dev` 처럼 데이터 폴더를 분리하세요 |
| 두 번째 PC 에 데이터가 안 내려옴 | 첫 PC 의 "대기 변경" 이 0 인지, 두 번째 PC 에서 "지금 동기화" 를 눌렀는지 확인 |

## 개발

```bash
pnpm format   # prettier
pnpm lint     # eslint
pnpm test     # vitest
pnpm build    # typecheck + electron-vite build
```

코딩 규칙: 들여쓰기 2칸, 세미콜론 없음, 작은따옴표, `any` 금지, 주석·커밋 메시지는 한국어.

## 문서

- **[PRD](docs/PRD.md)** — 제품 요구사항
- **[기술스택](docs/기술스택.md)** — 사용 기술 및 라이브러리
- **[실행방법](docs/실행방법.md)** — 화면별 사용법 상세(설치·실행은 이 README 가 기준입니다)
- **[Supabase 설정](docs/supabase-설정.md)** — 내 Supabase 프로젝트를 직접 쓸 때만 필요
- **[설계 스펙](docs/superpowers/specs/)** — 단계별 설계 문서

## 기여

이슈·PR 환영합니다. 브랜치는 `feature/기능명` / `fix/버그명`, 커밋 메시지는 한국어로 작게 나눠 주세요.
PR 전에 `pnpm format && pnpm lint && pnpm build && pnpm test` 가 모두 통과해야 합니다.

## 라이선스

[MIT](LICENSE) © 2026 showpang. 동봉 라이브러리 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 를 참고하세요.

---

## 개발 이력

### 1단계 `v0.1.0-mvp1` — 브라우저 껍데기 + AI 에이전트
탭·주소창·네이티브 웹뷰, 도구 호출(`navigate`·`click`·`type`·`get_page`·`done`), 위험 행동 확인 게이트.

알려진 한계: 확인 게이트는 `click`/`type` 에만 적용(`navigate`·`select` 는 통과), 탭이 열 수 있는 주소는 `http`/`https`/`about:blank` 뿐(`file:`·`javascript:`·`data:` 차단), 작업당 도구 호출 상한 40회(`done` 제외), `mailto:`/`tel:` 은 차단·로그만, 영문 위험 단어 판정은 부분 일치라 오탐 가능, Windows 전용 검증.

### 2단계 `v0.2.0-mvp2` — 키마스터·가져오기·자동 로그인
6종 비밀값 암호화 저장, 비밀번호 CSV·북마크 HTML 가져오기, 계정 드롭리스트와 AI 로그인(2단계 로그인·캡차 도구), 로컬 OCR, 자체 새 탭 페이지·북마크 관리자.

### 알려진 한계 (3단계)
- 폰 연동은 USB 케이블 연결만 지원(무선 adb 는 다음 단계)
- 번역은 AI 연결 경로(Claude·Codex CLI)를 쓰므로 첫 배치가 10초 안팎 걸림
- 확장은 Electron 지원 범위(chrome.action·서비스 워커 일부) 안에서만 동작
- 모바일 모드는 터치 에뮬레이션을 켜지 않는다(우클릭 제스처와 충돌) — UA·뷰포트만 모바일

### 2b 단계 `v0.3.0-mvp2b` — 계정·동기화·작업공간·확장
Supabase 로그인(이메일/구글), 설정·계정·키마스터(암호문만)·북마크·채팅 동기화(마지막 수정 우선, 북마크는 합집합, 삭제는 30일 표식), 작업공간 `Ctrl+Alt+1~9`, AI 연결 설정, 크롬 확장 설치·가져오기, 캡차·2FA 사용자 넘김.

알려진 한계: Realtime 은 회사망·프록시에서 막힐 수 있고 그때는 60초 폴링, 구글 로그인은 Supabase Redirect URLs 에 `http://127.0.0.1:47612~47614/callback` 등록 필요, 확장은 MV3 일부 API 미지원·자동 업데이트 없음, 복구 키는 이 PC 에만 보관, 채팅 본문은 서버에 평문 저장(행 단위 접근 제어·TLS 로만 보호).

### 3단계 `feature/stage3-phone` — 폰 연동·AI 연결 재작업·제스처·번역·캡처
폰 연동(adb·scrcpy 원클릭, 문자 인증·ARS·결제 승인), AI 연결 3경로와 모델·추론 강도·권한 모드 선택, 사이드바/AI 패널 접기·폭 조절, 마우스 제스처, 페이지·이미지 번역, 이미지·영상 캡처, 웹스토어 직접 설치, 설정 재편.

알려진 한계: 폰 연동은 USB 케이블만(무선 adb 는 다음 단계), 번역은 Claude 경로만 지원하고 첫 배치가 10초 안팎, 확장은 Electron 지원 범위 안에서만, 모바일 모드는 UA·뷰포트만 바꾸고 터치 에뮬레이션은 켜지 않음(우클릭 제스처 충돌).

## IDE 추천

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
