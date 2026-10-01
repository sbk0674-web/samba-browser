// 원격 → 로컬. 표 단위로 읽어 병합 규칙(merge.ts)을 적용한다.
//
// 안전 규칙
// - 금고 항목은 마스터 키로만 열 수 있다. 잠겨 있으면 그 표를 통째로 건너뛴다
// - 복호화에 실패한 행은 **그 행만** 건너뛰고, 로그에 값도 암호문도 남기지 않는다
// - 감사 로그(audit_log)는 어떤 경로로도 건드리지 않는다

import { bookmarkKey, decideLww, type Syncable } from './merge'
import { SyncLocal } from './local'
import {
  accountFromRemote,
  bookmarkFromRemote,
  chatFromRemote,
  chatMessageFromRemote,
  fromIso,
  remoteTableOf,
  settingFromRemote,
  vaultItemFromRemote,
  type AccountSyncRow,
  type VaultItemSyncRow
} from './mappers'
import type { PullCursor } from './backend'
import { settingUpdatedAtKey } from './outbox'
import { isVaultKeySyncKey, SYNCED_SETTING_KEYS, type VaultKeySyncKey } from '../../shared/sync'
import { parseSettings, type Settings } from '../../shared/settings'
import type { PushDeps } from './push'

export type PullDeps = PushDeps

export interface PullResult {
  applied: number
  conflicts: number
  pruned: number
  /**
   * 서버의 마스터 키 재료가 이 PC 의 금고와 다르다. 덮어쓰지 않고 경고만 올린다 —
   * 덮으면 이 PC 에 이미 저장된 암호문이 영영 열리지 않는다
   */
  vaultKeyMismatch: boolean
  /**
   * 이번 주기에 금고 항목 복호화에 **처음** 실패한 행이 있었다(알림용).
   * 실패한 원격 id 는 sync_state 에 기억하고 커서는 넘긴다 — 예전에는 커서를 고정해, 열리지 않는
   * 행이 한 페이지(500행)를 채우자 금고 풀이 9/18 부터 멈췄다. 그 행이 원격에서 다시 고쳐지면
   * (updated_at 이 바뀌면) 커서 뒤로 다시 내려와 한 번 더 시도한다.
   * 키 재료 불일치(vaultKeyMismatch) 주기에는 여전히 커서를 원래 자리에 둔다(C2)
   */
  vaultDecryptFailed: boolean
}

/**
 * 2b 초기의 단일 커서. 지금은 (작업공간, 표) 별 커서로 나뉘었고, 이 값은 새 커서가 아직 없는
 * 옛 DB 의 출발점으로만 읽는다(더 이상 쓰지 않는다)
 */
export const PULL_CURSOR_KEY = 'pullCursor'

/**
 * 다음 풀에서 이 (작업공간, 표) 를 어디부터 읽을지(원격 updated_at 의 최대값).
 * 커서에 작업공간 축이 없으면, A 에서 커서가 T 까지 전진한 뒤 B 로 옮겼을 때
 * B 의 updated_at ≤ T 인 행이 영영 내려오지 않는다
 */
export function pullCursorKey(workspaceLocalId: number, table: PullTable): string {
  return `pullCursor:${workspaceLocalId}:${table}`
}

/** 작업공간 축이 없던 시절의 표별 커서 키(옛 DB 승계용) */
export function legacyTableCursorKey(table: PullTable): string {
  return `pullCursor:${table}`
}

/** 마지막으로 풀에 성공한 시각(로컬 시계). 상태 표시줄에 그대로 보여 준다 */
export const LAST_PULLED_AT_KEY = 'lastPulledAt'

/** 풀이 도는 표. 커서를 표마다 따로 센다 */
export type PullTable =
  'accounts' | 'vault_items' | 'bookmarks' | 'chats' | 'chat_messages' | 'settings'

/** 한 번에 받아 올 행 수. 이만큼 꽉 차서 왔으면 뒤에 더 있다고 본다 */
export const PULL_PAGE_SIZE = 500

/**
 * 한 주기에 한 표가 넘길 수 있는 최대 페이지 수. 남은 것은 다음 주기가 이어 간다 —
 * 첫 동기화가 수만 행이어도 한 주기를 무한정 붙잡지 않는다
 */
export const MAX_PAGES_PER_CYCLE = 20

/**
 * 한 페이지에서 **받아 본** 행들(적용 여부와 무관하다). null 이면 이번 주기에 그 표를
 * 읽지 못했다는 뜻이다.
 * 커서를 하나만 쓰면 금고가 잠겨 vault_items 를 통째로 건너뛴 주기에도 다른 표의
 * updated_at 때문에 커서가 전진해, 잠금 해제 후 그 구간의 금고 행이 영영 내려오지 않았다.
 * 복호화에 실패해 건너뛴 행도 여기에는 담는다 — 담지 않으면 커서가 그 자리에 붙박여
 * 같은 페이지를 영원히 다시 받는다
 */
type Seen = { updatedAt: number; id: string }[] | null

/** 커서 한 줄을 sync_state 문자열로. id 가 없으면 옛 형식(숫자)과 같은 모양이다 */
export function formatPullCursor(cursor: PullCursor): string {
  return cursor.id === null ? String(cursor.ts) : `${cursor.ts}:${cursor.id}`
}

/**
 * sync_state 에 적힌 커서를 읽는다.
 * - 'ts:id' — 지금 형식
 * - 'ts'    — 커서에 id 가 없던 옛 DB. 동률 판정 없이 그대로 이어 간다
 */
export function parsePullCursor(raw: string | null): PullCursor {
  if (raw === null) return { ts: 0, id: null }
  const at = raw.indexOf(':')
  if (at < 0) {
    const ts = Number(raw)
    return { ts: Number.isFinite(ts) ? ts : 0, id: null }
  }
  const ts = Number(raw.slice(0, at))
  return { ts: Number.isFinite(ts) ? ts : 0, id: raw.slice(at + 1) }
}

export async function pullAll(deps: PullDeps): Promise<PullResult> {
  // 내려받은 행에 지금 작업공간을 찍어 둔다 — 그러지 않으면 비기본 작업공간에서 보이지 않는다
  const workspaceLocalId = deps.workspace().localId
  const local = new SyncLocal(deps.db, workspaceLocalId)
  const result: PullResult = {
    applied: 0,
    conflicts: 0,
    pruned: 0,
    vaultKeyMismatch: false,
    vaultDecryptFailed: false
  }
  // 단일 커서만 있던 옛 DB 는 그 자리에서 이어 간다
  const legacy = local.getState(PULL_CURSOR_KEY)

  const step = async (
    table: PullTable,
    fn: (cursor: PullCursor, limit: number) => Promise<Seen>
  ): Promise<void> => {
    const key = pullCursorKey(workspaceLocalId, table)
    // 승계 순서: (작업공간, 표) → 표만 있던 커서 → 단일 커서
    const own = local.getState(key)
    const raw = own ?? local.getState(legacyTableCursorKey(table)) ?? legacy
    let cursor = parsePullCursor(raw)
    // 옛 키에서 물려받았으면 값이 그대로여도 새 키에 한 번 적어 둔다(승계 완료)
    let dirty = own === null
    for (let page = 0; page < MAX_PAGES_PER_CYCLE; page += 1) {
      const seen = await fn(cursor, PULL_PAGE_SIZE)
      // 건너뛴 표는 커서를 두고 간다 — 다음 주기에 같은 구간을 다시 본다
      if (seen === null) return
      const last = seen[seen.length - 1]
      if (last) {
        cursor = { ts: last.updatedAt, id: last.id }
        dirty = true
      }
      // 꽉 차지 않았으면 이 표는 끝까지 읽었다
      if (seen.length < PULL_PAGE_SIZE) break
    }
    if (dirty) local.setState(key, formatPullCursor(cursor))
  }

  // 금고 커서는 주기가 끝난 뒤 되돌릴 수 있게 원래 값을 들고 있는다(C2).
  // 키 재료 불일치는 이 주기의 **맨 마지막**(settings)에서야 드러나기 때문이다
  const vaultCursorKey = pullCursorKey(workspaceLocalId, 'vault_items')
  const vaultCursorBefore = local.getState(vaultCursorKey)

  await step('accounts', (cursor, limit) => pullAccounts(deps, local, cursor, limit, result))
  await step('vault_items', (cursor, limit) => pullVaultItems(deps, local, cursor, limit, result))
  await step('bookmarks', (cursor, limit) => pullBookmarks(deps, local, cursor, limit, result))
  // 대화를 먼저 내려받아야 메시지의 chat_id 가 가리킬 대상이 생긴다
  await step('chats', (cursor, limit) => pullChats(deps, local, cursor, limit, result))
  await step('chat_messages', (cursor, limit) =>
    pullChatMessages(deps, local, cursor, limit, result)
  )
  await step('settings', (cursor, limit) => pullSettings(deps, local, cursor, limit, result))

  // 키 재료가 어긋난 주기에는 금고 커서를 원래 자리에 둔다.
  // 커서가 넘어가면 그 구간의 금고 항목은 키를 맞춘 뒤에도 영영 내려오지 않는다(C2).
  // 행 하나하나의 복호화 실패는 커서를 막지 않는다(기억해 두고 넘긴다)
  if (result.vaultKeyMismatch) {
    if (vaultCursorBefore === null) local.deleteState(vaultCursorKey)
    else local.setState(vaultCursorKey, vaultCursorBefore)
  }

  result.pruned = local.pruneExpiredTombstones(Date.now())
  local.setStateNumber(LAST_PULLED_AT_KEY, Date.now())
  return result
}

/**
 * 로컬·원격 중 누가 이겼는지 판정한다.
 * 로컬이 이기면 충돌로 센다 — 로컬 값이 그대로 남고, 다음 푸시가 원격을 덮는다
 */
function wins(
  localRow: Syncable | null,
  remoteRow: Syncable,
  result: PullResult,
  revive = false
): boolean {
  // 로컬에서 지운 행(tombstone)은 원격의 "살아 있는" 갱신이 더 늦어도 되살리지 않는다 — 옛 복제본(병렬
  // 인스턴스)이 지운 뒤에 그 행을 만지고 upsert 하면 LWW 로는 삭제가 뒤집혔다(실기: 키마스터에서 지운
  // 계정·사이트가 자꾸 원복). 삭제는 사용자 의도라 이긴다. 다음 푸시가 tombstone 을 다시 올린다.
  // 단 revive(다른 기기가 삭제 뒤에 내용을 바꿔 다시 저장했다)면 그 수정이 이긴다 — 실기 2026-10-01:
  // 9/24 에 지운 포이즌 계정을 다른 PC 가 9/30 에 주소·비밀번호를 고쳐 저장했는데 이 PC 만 끝내 안 받았다
  if (localRow !== null && localRow.deletedAt !== null && remoteRow.deletedAt === null && !revive) {
    result.conflicts += 1
    return false
  }
  const decision = decideLww(localRow, remoteRow)
  if (decision === 'remote') return true
  if (decision === 'local') result.conflicts += 1
  // 같은 시각이면 굳이 덮어쓰지 않는다
  return false
}

/**
 * 지운 계정을 다른 기기가 삭제 **뒤에** 내용을 바꿔 다시 저장했는가(주소·아이디 중 하나라도 다르다).
 * 내용이 같은 채 시각만 늦은 행은 옛 복제본이 만진 것으로 보고 되살리지 않는다(원복 사고 방지)
 */
export function accountRevived(
  current: { host: string; username: string; deletedAt: number | null } | null,
  remote: { host: string; username: string; updatedAt: number; deletedAt: number | null }
): boolean {
  if (current === null || current.deletedAt === null || remote.deletedAt !== null) return false
  if (remote.updatedAt <= current.deletedAt) return false
  // 이름(label)은 로그인 기록이 저절로 바꾸기도 해 판단에서 뺀다 — 주소·아이디가 바뀐 것만 사람의 재저장으로 본다
  return current.host !== remote.host || current.username !== remote.username
}

function toSyncable(row: {
  remoteId?: string | null
  updatedAt: number
  deletedAt: number | null
}): Syncable {
  return { remoteId: row.remoteId ?? '', updatedAt: row.updatedAt, deletedAt: row.deletedAt }
}

async function pullAccounts(
  deps: PullDeps,
  local: SyncLocal,
  cursor: PullCursor,
  limit: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.select(
    remoteTableOf('accounts'),
    cursor,
    workspaceOf(deps),
    limit
  )
  const seen: { updatedAt: number; id: string }[] = []

  for (const raw of rows) {
    const remote = accountFromRemote(raw)
    seen.push({ updatedAt: remote.updatedAt, id: raw.id })

    // 1) 원격 id 로 짝이 맞으면 그 행끼리 판정한다
    const byRemote = remote.remoteId ? local.accountIdByRemote(remote.remoteId) : null
    if (byRemote !== null) {
      const current = local.accountForSync(byRemote)
      if (wins(current ? toSyncable(current) : null, toSyncable(remote), result, accountRevived(current, remote))) {
        local.applyAccount(remote, byRemote)
        result.applied += 1
      } else if (current && current.deletedAt !== null && remote.deletedAt === null) {
        // 로컬 삭제가 이겼는데 서버에는 살아 있다 — 서버에도 삭제 표식을 다시 올려야
        // 다른 기기(새로 로그인한 기기 포함)에서 되살아나지 않는다
        requeueLocalTombstone(deps, local, 'accounts', byRemote)
      }
      continue
    }

    // 2) 처음 보는 원격 id 의 삭제 표식 — 같은 자연 키의 살아 있는 로컬 계정이 그 삭제보다 **엄격히**
    //    옛것이면(삭제 뒤에 고친 적이 없으면) 로컬도 지운다. 옛 사본이 새 id 로 올린 행을 받아 둔 기기
    //    (새로 로그인한 기기 등)가 여기서 정리된다. 그 행이 서버에 있던 것이면 서버에도 삭제 표식을 올린다.
    //    삭제 뒤에 고친 계정(합치며 이름을 바꾼 남은 계정 등)은 수정 시각이 삭제보다 늦어 건드리지 않는다
    //    (실기: a-rt.com 합치기 뒤 계정 3개 실종 — 합치기는 지운 뒤에 남은 계정을 고친다)
    if (remote.deletedAt !== null) {
      for (const target of local.liveAccountsByKey(remote.host, remote.username)) {
        if (target.updatedAt >= remote.deletedAt) continue
        markAccountDeletedAndPropagate(deps, local, target.id, remote.deletedAt)
        if (target.remoteId !== null) requeueLocalTombstone(deps, local, 'accounts', target.id)
        result.applied += 1
      }
      continue
    }

    // 3) 처음 보는 원격 id 의 살아 있는 행
    // 3-1) 이 원격 id 를 로컬에서 지운 기억(삭제 메모)이 있으면 되살리지 않는다 — 같은 id 는 삭제가 이긴다
    const memo = remote.remoteId ? local.tombstoneAt('accounts', remote.remoteId) : null
    if (memo !== null) {
      result.conflicts += 1
      requeueRemoteTombstone(deps, 'accounts', { id: 0, ...remote, deletedAt: memo })
      continue
    }
    // 3-2) 같은 자연 키를 로컬에서 그 행보다 뒤에 지웠다 — 다른 기기·옛 사본이 새 id 로 다시 올린 것이다.
    //      삽입하지 않고 그 원격 id 에 삭제 표식을 올린다
    const deleted = local.deletedAccountByKey(remote.host, remote.username)
    const live = local.liveAccountIdByKey(remote.host, remote.username)
    if (live === null && deleted !== null && deleted.deletedAt >= remote.updatedAt) {
      result.conflicts += 1
      requeueRemoteTombstone(deps, 'accounts', { id: 0, ...remote, deletedAt: deleted.deletedAt })
      continue
    }
    // 3-3) 같은 자연 키의 살아 있는 로컬 계정과 짝을 맞춘다(처음 합치는 기기)
    if (live !== null) {
      const current = local.accountForSync(live)
      if (wins(current ? toSyncable(current) : null, toSyncable(remote), result)) {
        local.applyAccount(remote, live)
        result.applied += 1
      } else if (current && current.remoteId === null && remote.remoteId) {
        // 로컬이 이겼어도 어느 원격 행과 짝인지는 기억해 둔다
        local.setAccountRemoteId(live, remote.remoteId)
      }
      continue
    }
    // 3-4) 삭제 뒤에 다시 만든 계정이다 — 지운 행 자리에 되살린다(같은 자연 키로 행이 둘 생기지 않게)
    local.applyAccount(remote, deleted ? deleted.id : null)
    result.applied += 1
  }
  return seen
}

/**
 * 로컬에서 이미 지운 행의 삭제 표식을 다시 올린다. 수정 시각을 지금으로 올려야 서버에 살아 있는 행
 * (그 행보다 옛 시각의 삭제 표식은 다른 기기의 LWW 에서 진다)을 확실히 덮는다
 */
function requeueLocalTombstone(
  deps: PullDeps,
  local: SyncLocal,
  table: 'accounts' | 'vault_items',
  localId: number
): void {
  local.touchDeletedRow(table, localId, Date.now())
  deps.outbox.record(table, String(localId), 'delete', undefined, deps.workspace().localId)
}

/**
 * 로컬 행과 짝이 없는 원격 id 에 삭제 표식을 올리도록 변경 로그에 적는다.
 * 로컬 행 id 대신 'remote:<원격 id>' 를 쓰고, payload 에 삭제 표식을 만들 스냅샷을 담는다.
 * 금고 항목의 fieldsJson 은 비운다 — 복호화한 값을 변경 로그에 남기지 않는다
 */
function requeueRemoteTombstone(
  deps: PullDeps,
  table: 'accounts' | 'vault_items',
  row: AccountSyncRow | VaultItemSyncRow
): void {
  if (!row.remoteId || row.deletedAt === null) return
  const payload = { ...row, updatedAt: Date.now() }
  deps.outbox.record(
    table,
    `remote:${row.remoteId}`,
    'delete',
    JSON.stringify(payload),
    deps.workspace().localId
  )
}

/** 로컬 계정을 삭제 표식으로 바꾸고, 딸린 항목 중 서버에 있던 것은 삭제 표식을 올린다 */
function markAccountDeletedAndPropagate(
  deps: PullDeps,
  local: SyncLocal,
  accountId: number,
  deletedAt: number
): void {
  for (const itemId of local.markAccountDeleted(accountId, deletedAt)) {
    deps.outbox.record('vault_items', String(itemId), 'delete', undefined, deps.workspace().localId)
  }
}

async function pullVaultItems(
  deps: PullDeps,
  local: SyncLocal,
  cursor: PullCursor,
  limit: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.select(
    remoteTableOf('vault_items'),
    cursor,
    workspaceOf(deps),
    limit
  )
  if (rows.length === 0) return []

  // 금고가 잠겨 있으면 복호화할 수 없다 — 커서도 올리지 않고 다음 주기에 다시 본다
  const seen = deps.vault.useMasterKey((key) => {
    const applied: { updatedAt: number; id: string }[] = []
    for (const raw of rows) {
      let remote: ReturnType<typeof vaultItemFromRemote>
      try {
        remote = vaultItemFromRemote(raw, key)
      } catch {
        // 열지 못한 행은 원격 id 와 그 판(updated_at)을 기억하고 커서를 넘긴다 — 커서를 고정하면
        // 이런 행이 한 페이지를 채웠을 때 금고 풀이 통째로 멈춘다(9/18~). 경고는 같은 행·같은 판에
        // 한 번만 남긴다. 값도 암호문도 남기지 않는다 — 어느 행인지만 남긴다
        const failedAt = fromIso(raw.updated_at)
        if (!local.decryptFailedBefore(raw.id, failedAt)) {
          console.warn('금고 항목 복호화 실패(건너뜀)', raw.id)
          local.rememberDecryptFailed(raw.id, failedAt)
          result.vaultDecryptFailed = true
        }
        applied.push({ updatedAt: failedAt, id: raw.id })
        continue
      }
      applied.push({ updatedAt: remote.updatedAt, id: raw.id })
      // 원격 id 로 먼저 찾고, 없으면 (계정, 종류, 라벨) 이 같고 아직 올라간 적 없는
      // 로컬 항목에 붙인다 — 두 PC 가 같은 CSV 를 각자 가져온 경우 중복을 만들지 않는다(I1)
      // 원격 계정이 있는데 로컬에 아직 없으면(계정 표가 다음 페이지·다음 주기) identity 매칭을
      // 하지 않는다 — null 계정으로 떨어져 무관한 항목에 붙는 사고 방지(4차 리뷰 N2)
      const accountLocalId =
        remote.accountRemoteId === null ? null : local.accountIdByRemote(remote.accountRemoteId)
      const identityAllowed = remote.accountRemoteId === null || accountLocalId !== null
      const byRemote = local.vaultItemIdByRemote(remote.remoteId)
      if (byRemote !== null) {
        const current = local.vaultItemForSync(byRemote)
        // 딸린 계정이 살아 있고(다시 저장돼 되살아난 계정 포함) 원격 항목이 삭제보다 뒤에 고쳐졌으면 되살린다
        const revive =
          current !== null &&
          current.deletedAt !== null &&
          remote.deletedAt === null &&
          remote.updatedAt > current.deletedAt &&
          accountLocalId !== null &&
          local.accountDeletedAt(accountLocalId) === null
        if (wins(current ? toSyncable(current) : null, toSyncable(remote), result, revive)) {
          local.applyVaultItem(remote, byRemote)
          result.applied += 1
        } else if (current && current.deletedAt !== null && remote.deletedAt === null) {
          // 로컬 삭제가 이겼는데 서버에는 살아 있다 — 서버에도 삭제 표식을 다시 올린다
          requeueLocalTombstone(deps, local, 'vault_items', byRemote)
        }
        continue
      }
      // 처음 보는 원격 id 의 삭제 표식 — 같은 (계정, 종류, 라벨) 의 살아 있는 로컬 항목이 그 삭제보다
      // 엄격히 옛것이면 로컬도 지운다. 서버에 있던 항목이면 서버에도 삭제 표식을 올린다
      if (remote.deletedAt !== null) {
        const target = identityAllowed
          ? local.liveVaultItemByIdentity(accountLocalId, remote.type, remote.label)
          : null
        if (target && target.updatedAt < remote.deletedAt) {
          local.markVaultItemDeleted(target.id, remote.deletedAt)
          if (target.remoteId !== null) requeueLocalTombstone(deps, local, 'vault_items', target.id)
          result.applied += 1
        }
        continue
      }
      // 처음 보는 원격 id 의 살아 있는 행 — 이 id 를 지운 기억이 있거나, 같은 항목·딸린 계정을
      // 그 행보다 뒤에 지웠으면 삽입하지 않고 그 원격 id 에 삭제 표식을 올린다
      const memo = local.tombstoneAt('vault_items', remote.remoteId)
      const deletedByKey = identityAllowed
        ? local.deletedVaultItemAtByIdentity(accountLocalId, remote.type, remote.label)
        : null
      const accountDeletedAt =
        accountLocalId === null ? null : local.accountDeletedAt(accountLocalId)
      const newer = [deletedByKey, accountDeletedAt].filter(
        (at): at is number => at !== null && at >= remote.updatedAt
      )
      if (memo !== null || newer.length > 0) {
        result.conflicts += 1
        requeueRemoteTombstone(deps, 'vault_items', {
          id: 0,
          accountId: null,
          ...remote,
          fieldsJson: '[]',
          deletedAt: memo ?? Math.max(...newer)
        })
        continue
      }
      const localId = identityAllowed
        ? local.vaultItemIdByIdentity(accountLocalId, remote.type, remote.label)
        : null
      if (localId === null) {
        local.applyVaultItem(remote, null)
        result.applied += 1
        continue
      }
      const current = local.vaultItemForSync(localId)
      if (wins(current ? toSyncable(current) : null, toSyncable(remote), result)) {
        local.applyVaultItem(remote, localId)
        result.applied += 1
      } else if (current && current.remoteId === null) {
        // 로컬이 이겼어도 어느 원격 행과 짝인지는 기억해 둔다 — 그러지 않으면
        // 다음 주기에 또 "처음 보는 항목" 으로 보여 결국 하나 더 만든다
        local.setVaultItemRemoteId(localId, remote.remoteId)
      }
    }
    return applied
  })
  // null 이면 금고가 잠겨 한 행도 보지 못했다 — 호출부가 커서를 그대로 둔다
  return seen
}

async function pullBookmarks(
  deps: PullDeps,
  local: SyncLocal,
  cursor: PullCursor,
  limit: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.select(
    remoteTableOf('bookmarks'),
    cursor,
    workspaceOf(deps),
    limit
  )
  if (rows.length === 0) return []

  // 북마크는 합집합이다. 같은 (폴더 경로, URL) 만 한 개로 합치고 나머지는 양쪽 다 남는다
  const locals = local.listBookmarksForSync()
  const byKey = new Map(locals.map((b) => [bookmarkKey(b), b]))
  const seen: { updatedAt: number; id: string }[] = []

  for (const raw of rows) {
    const remote = bookmarkFromRemote(raw)
    seen.push({ updatedAt: remote.updatedAt, id: raw.id })
    const matched =
      locals.find((b) => b.remoteId !== null && b.remoteId === remote.remoteId) ??
      byKey.get(bookmarkKey(remote)) ??
      null

    if (!matched) {
      if (remote.deletedAt !== null) continue
      local.applyBookmark(remote, null)
      result.applied += 1
      continue
    }
    if (wins(toSyncable(matched), toSyncable(remote), result)) {
      local.applyBookmark(remote, matched.id)
      result.applied += 1
    } else if (matched.remoteId === null && remote.remoteId) {
      local.setBookmarkRemoteId(matched.id, remote.remoteId)
    }
  }
  return seen
}

async function pullChats(
  deps: PullDeps,
  local: SyncLocal,
  cursor: PullCursor,
  limit: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.select(remoteTableOf('chats'), cursor, workspaceOf(deps), limit)
  const seen: { updatedAt: number; id: string }[] = []

  for (const raw of rows) {
    const remote = chatFromRemote(raw)
    seen.push({ updatedAt: remote.updatedAt, id: raw.id })
    const localId = local.chatIdByRemote(remote.remoteId)
    if (localId === null) {
      // 원격에서 이미 지워진 대화는 로컬에 되살리지 않는다
      if (remote.deletedAt !== null) continue
      local.applyChat(remote, null)
      result.applied += 1
      continue
    }
    const current = local.chatForSync(localId)
    if (wins(current ? toSyncable(current) : null, toSyncable(remote), result)) {
      local.applyChat(remote, localId)
      result.applied += 1
    }
  }
  return seen
}

async function pullChatMessages(
  deps: PullDeps,
  local: SyncLocal,
  cursor: PullCursor,
  limit: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.select(
    remoteTableOf('chat_messages'),
    cursor,
    workspaceOf(deps),
    limit
  )
  const seen: { updatedAt: number; id: string }[] = []

  for (const raw of rows) {
    const remote = chatMessageFromRemote(raw)
    const localId = local.chatMessageIdByRemote(remote.remoteId)
    if (localId === null) {
      if (remote.deletedAt !== null) {
        // 본 적 없는 메시지의 삭제 표식은 되살릴 것이 없다 — 커서만 통과시킨다
        seen.push({ updatedAt: remote.updatedAt, id: raw.id })
        continue
      }
      const applied = local.applyChatMessage(remote, null)
      // 대화를 아직 못 찾았다(대화가 다음 주기에 내려온다) — 커서를 올리지 않고 다시 본다
      if (applied === null) continue
      seen.push({ updatedAt: remote.updatedAt, id: raw.id })
      result.applied += 1
      continue
    }
    seen.push({ updatedAt: remote.updatedAt, id: raw.id })
    const current = local.chatMessageForSync(localId)
    if (wins(current ? toSyncable(current) : null, toSyncable(remote), result)) {
      if (local.applyChatMessage(remote, localId) !== null) result.applied += 1
    }
  }
  return seen
}

async function pullSettings(
  deps: PullDeps,
  local: SyncLocal,
  cursor: PullCursor,
  limit: number,
  result: PullResult
): Promise<Seen> {
  const rows = await deps.backend.selectKeyed('settings_sync', cursor, workspaceOf(deps), limit)
  const seen: { updatedAt: number; id: string }[] = []
  // 마스터 키 재료는 세 키가 다 모여야 심을 수 있다 — 먼저 모아 두고 끝에서 한 번에 적용한다
  const keyMaterial: Partial<Record<VaultKeySyncKey, string>> = {}
  const keyMaterialAt = new Map<VaultKeySyncKey, number>()

  for (const raw of rows) {
    const remote = settingFromRemote(raw)
    // 복합 PK 표라 동률 판정 축이 id 가 아니라 key 다
    seen.push({ updatedAt: remote.updatedAt, id: remote.key })
    if (isVaultKeySyncKey(remote.key)) {
      // 다른 설정과 달리 수정 시각으로 거르지 않는다 — 로컬이 더 최신이어도 "같은 금고인가"는
      // 확인해야 하고, 심을지 말지는 금고 상태(설정 전인가)가 정한다
      if (typeof remote.value !== 'string') continue
      keyMaterial[remote.key] = remote.value
      keyMaterialAt.set(remote.key, remote.updatedAt)
      continue
    }
    if (!isSyncedSettingKey(remote.key)) continue
    // 설정은 config.json 에 있어 행 단위 수정 시각이 없다. sync_state 에 키별로 따로 적어 둔다
    const localUpdatedAt = local.getStateNumber(settingUpdatedAtKey(remote.key)) ?? 0
    if (remote.updatedAt <= localUpdatedAt) {
      if (localUpdatedAt > remote.updatedAt) result.conflicts += 1
      continue
    }
    // 손상·조작된 값이 들어와도 zod 스키마가 필드별 기본값으로 되돌린다
    const merged = parseSettings({ ...deps.settings.get(), [remote.key]: remote.value })
    applyFromSync(deps, { [remote.key]: merged[remote.key] } as Partial<Settings>)
    local.setStateNumber(settingUpdatedAtKey(remote.key), remote.updatedAt)
    result.applied += 1
  }

  applyVaultKeyMaterial(deps, local, keyMaterial, keyMaterialAt, result)
  return seen
}

/**
 * 모아 둔 마스터 키 재료를 금고에 심는다.
 * 심지 못한 경우(불일치·부족)에는 수정 시각을 적지 않는다 — 다음 주기에 다시 본다
 */
function applyVaultKeyMaterial(
  deps: PullDeps,
  local: SyncLocal,
  values: Partial<Record<VaultKeySyncKey, string>>,
  updatedAt: Map<VaultKeySyncKey, number>,
  result: PullResult
): void {
  if (Object.keys(values).length === 0) return
  const outcome = deps.vault.applyKeyMaterial?.(values)
  if (outcome === undefined) return
  if (outcome === 'mismatch') {
    // 값도 재료도 남기지 않는다 — 어긋났다는 사실만 알린다
    console.warn('동기화: 서버의 마스터 키 재료가 이 PC 의 금고와 다릅니다(덮어쓰지 않음)')
    result.vaultKeyMismatch = true
    return
  }
  if (outcome === 'incomplete') return
  for (const [key, at] of updatedAt) local.setStateNumber(settingUpdatedAtKey(key), at)
  if (outcome === 'applied') result.applied += 1
}

/** 원격에서 받은 설정을 적용한다. 다시 변경 로그에 쌓이지 않도록 전용 경로가 있으면 그것을 쓴다 */
function applyFromSync(deps: PullDeps, patch: Partial<Settings>): void {
  if (deps.settings.setFromSync) deps.settings.setFromSync(patch)
  else deps.settings.set(patch)
}

function isSyncedSettingKey(key: string): key is (typeof SYNCED_SETTING_KEYS)[number] {
  return (SYNCED_SETTING_KEYS as readonly string[]).includes(key)
}

/** 지금 활성 작업공간의 원격 uuid. 주기마다 다시 읽는다(작업공간 전환 반영) */
function workspaceOf(deps: PullDeps): string {
  return deps.workspace().remoteId
}
