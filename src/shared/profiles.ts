// 탭 프로필(계정별 세션) 이름 규칙과 목록 만들기 — 메인(목록 조회)과 렌더러(새 프로필 이름 검사)가 같이 쓴다.
// 프로필은 세션 파티션 이름의 뒷부분이다(`persist:ws1-<프로필>` → userData/Partitions/ws1-<프로필>).

export const DEFAULT_PROFILE_NAME = 'default'
export const MAX_PROFILE_NAME = 40

// 하네스·앱이 내부용으로 만드는 프로필 — 사용자 목록에는 보이지 않는다
const INTERNAL_PROFILE = /^(__.*__|guest-\d+)$/

/** 새 프로필 이름으로 쓸 수 있는가 — 영문·숫자·한글과 . _ @ - 만, 폴더 이름이 되므로 다른 기호는 받지 않는다 */
export function isValidProfileName(name: string): boolean {
  const n = name.trim()
  if (!n || n.length > MAX_PROFILE_NAME) return false
  if (n === DEFAULT_PROFILE_NAME || INTERNAL_PROFILE.test(n)) return false
  return /^[0-9A-Za-z가-힣][0-9A-Za-z가-힣._@-]*$/.test(n)
}

// 한글 같은 글자는 폴더 이름에 퍼센트 인코딩으로 들어간다(`새프로필` → `%EC%83%88…`) — 풀어서 탭의 이름과 맞춘다
function decodeDirName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/**
 * 파티션 폴더 이름과 열린 탭의 프로필에서 사용자에게 보여 줄 프로필 목록을 만든다.
 * - dirPrefix: 지금 작업공간의 폴더 접두사(`ws1-`). 다른 작업공간·E2E 폴더는 뺀다
 * - 기본 프로필과 내부용(임시 guest·탐지용)은 뺀다. 이름순(대소문자 무시)
 */
export function profileNames(
  partitionDirs: readonly string[],
  dirPrefix: string,
  openProfiles: readonly string[] = []
): string[] {
  const names = new Set<string>()
  for (const dir of partitionDirs) {
    if (dirPrefix && !dir.startsWith(dirPrefix)) continue
    names.add(decodeDirName(dir.slice(dirPrefix.length)))
  }
  for (const p of openProfiles) names.add(p)
  return [...names]
    .filter((n) => n && n !== DEFAULT_PROFILE_NAME && !INTERNAL_PROFILE.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}
