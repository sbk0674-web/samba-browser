# 삼바 브라우저 — 여러 세션이 같이 쓰는 저장소 규칙

이 저장소는 여러 Claude 세션(주문처리·다중 창·SAMBASNS·선녀체크인·오토튠 등)이 동시에 만진다.
앱이 옛 판으로 되돌아가는 사고(2026-10-15: 아이디 저장·구글 로그아웃·롯데온 키패드 수정이 빠진 앱이 세 번 뜸)를 막기 위한 규칙이다.

## 앱 빌드·교체·재시작
- **앱 `out/` 은 `scripts/deploy-app.ps1` 로만 만든다.** 이 스크립트는 깨끗한 워크트리(`samba_browser-mastersync`)를 최신 origin/master 로 맞춰 빌드하고 메인 `out/` 에 복사한다. 메인 체크아웃에서 직접 `npm run build` 후 재시작하지 않는다.
- `npm run build` 는 `scripts/check-build-source.mjs` 가 먼저 돈다 — 소스가 origin/master 보다 뒤처졌으면 빌드를 막는다. `SAMBA_ALLOW_STALE_BUILD=1` 로 우회하지 않는다(옛 판을 일부러 만들 때만).
- **재시작은 하네스 큐가 30초 비었을 때만** 한다(`deploy-app.ps1 -Restart` 가 확인한다). 주문 결제 중에 앱을 끄면 결제 여부가 불명해진다.
- 재시작 전에 삼바 브라우저를 쓰는 세션(SAMBASNS·선녀체크인 등)에 한 줄로 알리고, 끝난 뒤 한 줄로 다시 알린다. 앱 창(`video`·`collect` 등)은 재시작하면 사라지니 별칭으로 다시 만든다.
- 로그인 화면 아래 "최종 수정 <해시.날짜>[+] · 빌드 <시각>" 으로 떠 있는 판을 확인한다. 해시가 origin/master 최신과 다르거나 `+` 가 붙어 있으면 의도한 빌드인지 본다.

## 브랜치·커밋
- 메인 체크아웃(`samba_browser`)은 `master` 를 origin/master 와 항상 같게 둔다(ahead/behind 0). 커밋은 지정 경로만 `git add <경로>` 해서 메인 트리에 직접 하고 곧바로 `git push origin master` 한다.
- 다른 워크트리에 cherry-pick 해서 따로 푸시하지 않는다(메인 트리 master 가 갈라져 옛 소스가 된다).
- 다른 세션의 미커밋 변경이 같은 파일에 있으면 `git commit -- <파일>` 이 그 변경까지 쓸어 담는다. 겹치는 파일은 `git add -p` 대신 HEAD 기준 blob 으로 내 변경만 올리거나, 그 세션과 먼저 조율한다.
- 길게 가는 작업은 자기 워크트리·브랜치에서 하고, 끝나면 origin/master 에 합친 뒤 메인 트리를 `git pull --ff-only` 로 따라간다. 메인 트리에 미커밋 변경이 있어 pull 이 안 되면 그 변경의 주인과 조율한다.

## 하네스 사이트 스크립트
- 하네스가 쓰는 사이트 스크립트는 앱 데이터(`%APPDATA%/SAMBA Browser/site-scripts.json`)에 저장된 복사본으로 돈다. 저장소 `samba-agent/site-scripts/*.js` 는 내보낸 사본이다. 고칠 때는 둘 다 맞춘다(앱 저장은 브릿지 `save_script`, 코드 8000자 이하).
