// 확장의 프로필 범위 — 화면과 무관한 순수 로직(테스트 대상)

export type ScopeMode = 'all' | 'default' | 'list'

/** 설정값에서 이 확장의 범위 종류를 읽는다. 적혀 있지 않으면 모든 프로필 */
export function scopeModeOf(scopes: Record<string, string[]>, id: string): ScopeMode {
  const list = scopes[id]
  if (list === undefined) return 'all'
  return list.length === 0 ? 'default' : 'list'
}

/** 쉼표·공백으로 나눈 프로필 이름 목록. 빈 값과 중복은 뺀다 */
export function parseProfileList(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[,\s]+/)) {
    const name = raw.trim()
    if (name && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name)
  }
  return out
}
