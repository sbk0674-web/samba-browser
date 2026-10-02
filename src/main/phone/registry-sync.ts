// 폰 연동 동기화 — 로컬 폰 표 ↔ 계정 설정(phoneRegistry·phoneAccountLinks). 규칙은 shared/phone-registry.ts 참고.
//
// 흐름
//   받기(applyRemote): 설정에 실린 목록을 이 PC 의 폰 표에 맞춘다 — 없는 폰은 줄을 만들고(연결 안 됨),
//                      이름·나라·와이파이 주소는 받은 값으로, 다른 PC 에서 지운 폰은 지운다. 담당 계정도 건다.
//   보내기(publish):   이 PC 의 폰 표를 설정에 싣는다. 언제나 받기를 먼저 해서, 방금 켠 PC 의 빈 목록이
//                      다른 PC 가 올린 목록을 지우지 않게 한다
import type { Settings } from '../../shared/settings'
import {
  buildRegistry,
  planApply,
  sameJson,
  type PhoneAccountLink
} from '../../shared/phone-registry'
import type { PhoneRepo } from './repo'

/** 이 키들이 동기화로 바뀌면 받기를 다시 돌린다 */
export const PHONE_SYNC_KEYS: readonly string[] = [
  'phoneRegistry',
  'phoneAccountLinks',
  'phoneIgnoredSerials',
  'defaultPhoneSerial'
]

export interface PhoneRegistrySyncDeps {
  repo: Pick<
    PhoneRepo,
    | 'list'
    | 'insertKnown'
    | 'setLabel'
    | 'setWifiAddress'
    | 'remove'
    | 'assignAccount'
    | 'accountLinks'
    | 'accountIdByRemote'
    | 'phoneForAccount'
  >
  settings: { get(): Settings; set(patch: Partial<Settings>): Settings }
}

export class PhoneRegistrySync {
  constructor(private readonly deps: PhoneRegistrySyncDeps) {}

  /**
   * 설정에 실린 폰 목록·담당 계정을 이 PC 에 맞춘다. 폰 표가 바뀌었으면 true.
   * overwrite 가 false 면 없는 폰을 만들고 지운 폰을 지우기만 한다 — 이 PC 에서 방금 바꾼 이름을
   * 아직 올리기 전의 옛 목록으로 되돌리지 않기 위해서다(보내기 직전에 쓴다)
   */
  applyRemote(overwrite = true): boolean {
    const { repo, settings } = this.deps
    const s = settings.get()
    const plan = planApply(s.phoneRegistry, repo.list(), s.phoneIgnoredSerials)
    for (const id of plan.remove) repo.remove(id)
    for (const e of plan.insert) repo.insertKnown(e)
    const updates = overwrite ? plan.update : []
    for (const u of updates) {
      repo.setLabel(u.id, u.label, u.country)
      repo.setWifiAddress(u.id, u.wifiAddress)
    }
    let changed = plan.remove.length + plan.insert.length + updates.length > 0
    // 이 PC 에 기본 폰이 정해져 있지 않으면 받은 목록의 기본 폰을 쓴다
    if (s.defaultPhoneSerial === '' && plan.defaultSerial) {
      settings.set({ defaultPhoneSerial: plan.defaultSerial })
    }
    // 담당 계정 — 계정이 이 PC 에 내려와 있고 폰 줄이 있을 때만 건다. 해제는 전하지 않는다
    // (받은 목록에 없다는 것만으로는 "다른 PC 가 풀었다"와 "이 PC 가 방금 걸었다"를 가를 수 없다)
    const bySerial = new Map(repo.list().map((r) => [r.serial, r]))
    for (const link of s.phoneAccountLinks) {
      const accountId = repo.accountIdByRemote(link.account)
      const phone = bySerial.get(link.serial)
      if (accountId === null || !phone) continue
      if (repo.phoneForAccount(accountId)?.id === phone.id) continue
      repo.assignAccount(accountId, phone.id)
      changed = true
    }
    return changed
  }

  /** 이 PC 의 폰 표를 설정에 싣는다(달라졌을 때만 — 쓰면 서버로 올라간다) */
  publish(): void {
    this.applyRemote(false)
    const { repo, settings } = this.deps
    const s = settings.get()
    const registry = buildRegistry(repo.list(), s.defaultPhoneSerial, s.phoneIgnoredSerials)
    const local = repo.accountLinks()
    const localAccounts = new Set(local.map((l) => l.account))
    // 이 PC 가 모르는 계정(아직 안 내려온 계정)의 연결은 그대로 둔다 — 지우면 다른 PC 의 연결이 사라진다
    const kept = s.phoneAccountLinks.filter(
      (l) => !localAccounts.has(l.account) && repo.accountIdByRemote(l.account) === null
    )
    const links: PhoneAccountLink[] = [...kept, ...local].sort((a, b) =>
      a.account.localeCompare(b.account)
    )
    const patch: Partial<Settings> = {}
    if (!sameJson(registry, s.phoneRegistry)) patch.phoneRegistry = registry
    if (!sameJson(links, s.phoneAccountLinks)) patch.phoneAccountLinks = links
    if (Object.keys(patch).length > 0) settings.set(patch)
  }
}
