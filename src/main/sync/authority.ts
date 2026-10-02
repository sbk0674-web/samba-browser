// 키마스터 기준 선언 — "지금 이 PC 의 키마스터가 기준이다. 나머지 PC 는 여기에 맞춘다".
//
// 왜: 동기화는 PC 끼리 주고받는 병합이라, 옛 사본·옛 삭제 기록을 가진 PC 가 섞이면 계정이 지워지거나
// 되살아나며 PC 마다 내용이 달라졌다(사용자 2026-10-02 "지금 내 PC 브라우저 기준으로 다른 PC 맞춰지게").
//
// 하는 일(이 PC)
//   1. 기준 시각 T 를 계정 설정(keymasterBaselineAt)에 싣는다 — 다른 PC 가 이걸 보고 T 이전의 자기 삭제 기록·
//      안 올린 행·대기 변경을 버린다(pull.ts · local.applyKeymasterBaseline)
//   2. 서버에 살아 있는데 이 PC 에 없는 계정·항목에 삭제 표식을 올린다(시각 T) — 다른 PC 에서도 지워진다
//   3. 이 PC 의 살아 있는 계정·항목을 전부 시각 T+1 로 다시 올린다 — 내용이 다른 PC 의 것을 덮는다
// 서버 행을 실제로 지우지는 않는다(삭제 표식). 금고 내용은 평소 푸시 경로가 암호화해 올린다
import { and, eq, isNull, or, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client'
import { accounts, syncOutbox, vaultItems } from '../db/schema'
import type { Settings } from '../../shared/settings'
import type { BaselineCounts, BaselineReport } from '../../shared/sync'
import type { RemoteRow, SyncBackend } from './backend'
import { SyncLocal } from './local'
import { fromIso, remoteTableOf, toIso } from './mappers'
import { BASELINE_APPLIED_KEY, PULL_PAGE_SIZE } from './pull'

const TABLES = ['accounts', 'vault_items'] as const
type KeymasterTable = (typeof TABLES)[number]

export interface BaselineDeps {
  db: Db
  backend: SyncBackend
  workspace: { localId: number; remoteId: string }
  settings: { set(patch: Partial<Settings>): Settings }
  /** 삭제 표식을 올리기 직전에, 그 대상 행(서버에만 살아 있던 행)을 받아 보관한다 — 되돌릴 근거 */
  backup?: (table: string, rows: RemoteRow[], at: number) => void
  now?: () => number
}

const CHUNK = 200

/** 서버의 그 표를 이 작업공간 범위로 전부 읽는다(삭제 표식 포함) */
async function fetchAll(
  backend: SyncBackend,
  table: string,
  workspaceId: string
): Promise<RemoteRow[]> {
  const out: RemoteRow[] = []
  let cursor: { ts: number; id: string | null } = { ts: 0, id: null }
  for (;;) {
    const rows = await backend.select(table, cursor, workspaceId, PULL_PAGE_SIZE)
    if (rows.length === 0) break
    out.push(...rows)
    const last = rows[rows.length - 1]
    cursor = { ts: fromIso(last.updated_at), id: last.id }
    if (rows.length < PULL_PAGE_SIZE) break
  }
  return out
}

function tableOf(table: KeymasterTable): typeof accounts | typeof vaultItems {
  return table === 'accounts' ? accounts : vaultItems
}

/** 이 작업공간의 살아 있는 행(작업공간 컬럼이 없던 시절의 행도 함께) */
function liveWhere(t: typeof accounts | typeof vaultItems, localId: number): SQL {
  return and(isNull(t.deletedAt), or(isNull(t.workspaceId), eq(t.workspaceId, localId))) as SQL
}

/**
 * 이 PC 의 키마스터를 기준으로 선언한다. dryRun 이면 서버와 견줘 숫자만 돌려주고 아무것도 바꾸지 않는다.
 * 끝난 뒤 호출부가 동기화를 한 번 돌려야 대기열이 올라간다
 */
export async function declareKeymasterBaseline(
  deps: BaselineDeps,
  opts: { dryRun: boolean }
): Promise<BaselineReport> {
  const { db, backend, workspace } = deps
  const plans = new Map<
    KeymasterTable,
    { counts: BaselineCounts; remoteOnly: RemoteRow[]; ids: number[] }
  >()
  for (const table of TABLES) {
    const t = tableOf(table)
    const local = db.drizzle
      .select({ id: t.id, remoteId: t.remoteId })
      .from(t)
      .where(liveWhere(t, workspace.localId))
      .all()
    const mine = new Set(local.map((r) => r.remoteId).filter((v): v is string => v !== null))
    const remote = await fetchAll(backend, remoteTableOf(table), workspace.remoteId)
    const remoteLive = remote.filter((r) => r.deleted_at === null || r.deleted_at === undefined)
    const remoteOnly = remoteLive.filter((r) => !mine.has(r.id))
    plans.set(table, {
      counts: {
        local: local.length,
        remoteLive: remoteLive.length,
        remoteOnly: remoteOnly.length,
        localOnly: local.filter((r) => r.remoteId === null).length
      },
      remoteOnly,
      ids: local.map((r) => r.id)
    })
  }
  const report = (at: number): BaselineReport => ({
    dryRun: opts.dryRun,
    at,
    accounts: plans.get('accounts')!.counts,
    vaultItems: plans.get('vault_items')!.counts
  })
  if (opts.dryRun) return report(0)

  const at = (deps.now ?? Date.now)()
  // 이 PC 는 기준 그 자체다 — 다른 PC 용 정리(안 올린 행 삭제)를 자기에게 돌리지 않게 먼저 적어 둔다
  new SyncLocal(db, workspace.localId).setStateNumber(BASELINE_APPLIED_KEY, at)
  deps.settings.set({ keymasterBaselineAt: at })

  // 서버에만 살아 있는 행 → 삭제 표식(시각 T). 받은 행 그대로에 두 시각만 바꿔 올린다
  const stamp = toIso(at)
  for (const table of TABLES) {
    deps.backup?.(table, plans.get(table)!.remoteOnly, at)
    const rows = plans
      .get(table)!
      .remoteOnly.map((r) => ({ ...r, deleted_at: stamp, updated_at: stamp }))
    for (let i = 0; i < rows.length; i += CHUNK) {
      await backend.upsert(remoteTableOf(table), rows.slice(i, i + CHUNK))
    }
  }

  // 이 PC 의 살아 있는 행 → 시각 T+1 로 다시 올린다(이미 대기 중인 행은 그대로 둔다)
  const queued = new Set(
    db.drizzle
      .select({ table: syncOutbox.table, rowId: syncOutbox.rowId })
      .from(syncOutbox)
      .all()
      .map((r) => `${r.table}\u0000${r.rowId}`)
  )
  db.drizzle.transaction((tx) => {
    for (const table of TABLES) {
      const t = tableOf(table)
      tx.update(t)
        .set({ updatedAt: at + 1 })
        .where(liveWhere(t, workspace.localId))
        .run()
      const fresh = plans
        .get(table)!
        .ids.filter((id) => !queued.has(`${table}\u0000${id}`))
        .map((id) => ({
          table,
          rowId: String(id),
          op: 'upsert',
          payload: null,
          createdAt: at + 1,
          workspaceId: workspace.localId
        }))
      for (let i = 0; i < fresh.length; i += CHUNK) {
        tx.insert(syncOutbox)
          .values(fresh.slice(i, i + CHUNK))
          .run()
      }
    }
  })
  db.scheduleSave()
  return report(at)
}
