// 계정별 로컬 공간 — 같은 PC 를 다른 계정이 써도 서로의 북마크·대화·금고가 보이지 않게 한다.
//
// 기존 "작업공간"(금고·북마크·대화·탭 파티션이 작업공간 단위로 갈린다)을 계정에 자동으로 묶는다:
//   - 계정이 로그인하면 그 계정의 작업공간으로 전환한다(없으면 새로 만든다)
//   - 로그인 전에 이 PC 에 쌓인 데이터(기본 작업공간)는 **어느 계정에도 붙지 않는다** —
//     남이 로그인 없이 넣어 둔 것이 내 계정 것처럼 보이면 안 된다(실기: 다른 PC 의 키마스터가 내 계정에 보였다)
// 계정 ↔ 작업공간 대응은 이 PC 의 파일(userData/account-workspaces.json)에만 둔다(동기화 대상 아님)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/** 계정 작업공간을 만들고 전환하는 데 필요한 만큼만 요구한다(WorkspaceService 가 그대로 만족한다) */
export interface WorkspaceLike {
  list(): Array<{ id: number; name: string }>
  create(name: string): { id: number }
  switchTo(id: number): unknown
}

export class AccountWorkspaceStore {
  private map: Record<string, number> = {}

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isInteger(v)) this.map[k] = v
        }
      }
    } catch {
      this.map = {}
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.map, null, 1))
    } catch (e: unknown) {
      console.error('계정 작업공간 대응 저장 실패', e instanceof Error ? e.message : String(e))
    }
  }

  get(userId: string): number | null {
    return this.map[userId] ?? null
  }

  set(userId: string, workspaceId: number): void {
    this.map[userId] = workspaceId
    this.save()
  }

  /** 이 PC 에 계정 공간이 하나뿐이면 그 계정 id, 아니면 null(여럿이면 누구인지 모호하다) */
  onlyUserId(): string | null {
    const ids = Object.keys(this.map)
    return ids.length === 1 ? ids[0] : null
  }

  /** 어떤 계정이든 이 작업공간을 쓰고 있는가 */
  isAccountWorkspace(workspaceId: number): boolean {
    return Object.values(this.map).includes(workspaceId)
  }
}

/**
 * 계정의 작업공간으로 전환한다(없으면 새로 만든다). 돌려주는 값은 그 작업공간 id.
 * 로그인 전 데이터가 든 첫 작업공간은 물려주지 않는다 — 계정마다 자기 공간뿐이다
 */
export function ensureAccountWorkspace(
  workspace: WorkspaceLike,
  store: AccountWorkspaceStore,
  userId: string,
  label: string
): number {
  const rows = workspace.list()
  const mapped = store.get(userId)
  if (mapped !== null && rows.some((r) => r.id === mapped)) {
    workspace.switchTo(mapped)
    return mapped
  }
  const created = workspace.create(label.trim() === '' ? userId.slice(0, 8) : label)
  store.set(userId, created.id)
  workspace.switchTo(created.id)
  return created.id
}
