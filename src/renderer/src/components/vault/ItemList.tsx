import { useEffect, useMemo } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  Settings as SettingsIcon,
  ArrowDownAZ,
  Clock,
  ChevronRight,
  ChevronDown,
  Merge,
  X
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useVaultStore } from '@renderer/stores/vaultStore'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { normalizeHost } from '@shared/host'
import { VAULT_ITEM_TYPES, payPriorityOf, visibleTags } from '@shared/vault'
import type { AccountDto, VaultItemMeta, VaultItemType } from '@shared/ipc'
import { groupByDomain, type DomainGroup } from '@renderer/lib/vault-groups'
import { AddItemMenu } from './AddItemMenu'
import { SiteFavicon } from './SiteFavicon'

// 계정 없이도 존재할 수 있는(전역) 항목 종류
const GLOBAL_TYPES = new Set<VaultItemType>(['card', 'note', 'identity', 'document'])

// 한 사이트 안에서 같은 아이디가 여러 서브도메인에 흩어져 있는 개수(합치면 사라질 계정 수)
function duplicateCount(group: DomainGroup): number {
  return group.accounts.length - new Set(group.accounts.map((a) => a.username)).size
}

// 아이디는 사용자 본인 화면이므로 크롬 비밀번호 관리자처럼 가리지 않고 그대로 보여 준다(비밀번호는 목록에 없다)
function displayUsername(u: string): string {
  return u
}

interface Props {
  onAdd: (type: VaultItemType) => void
  onImport: () => void
  onSettings: () => void
}

/**
 * 계정·항목 목록 — 추천(현재 탭) · 최근 사용 · 도메인별 접이식 그룹.
 * 기본은 모든 그룹이 접혀 있고, 사이트당 한 줄만 보인다(크롬 비밀번호 관리자와 같은 형태).
 */
export function ItemList({ onAdd, onImport, onSettings }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const accounts = useVaultStore((s) => s.accounts)
  const itemsByAccount = useVaultStore((s) => s.itemsByAccount)
  const query = useVaultStore((s) => s.query)
  const setQuery = useVaultStore((s) => s.setQuery)
  const typeFilter = useVaultStore((s) => s.typeFilter)
  const setTypeFilter = useVaultStore((s) => s.setTypeFilter)
  const tagFilter = useVaultStore((s) => s.tagFilter)
  const toggleTagFilter = useVaultStore((s) => s.toggleTagFilter)
  const sort = useVaultStore((s) => s.sort)
  const setSort = useVaultStore((s) => s.setSort)
  const recentAccountIds = useVaultStore((s) => s.recentAccountIds)
  const loadRecent = useVaultStore((s) => s.loadRecent)
  const expandedGroups = useVaultStore((s) => s.expandedGroups)
  const toggleGroup = useVaultStore((s) => s.toggleGroup)
  const expandAllGroups = useVaultStore((s) => s.expandAllGroups)
  const collapseAllGroups = useVaultStore((s) => s.collapseAllGroups)
  const selectedAccountId = useVaultStore((s) => s.selectedAccountId)
  const selectedGlobalItemId = useVaultStore((s) => s.selectedGlobalItemId)
  const select = useVaultStore((s) => s.select)
  const selectGlobalItem = useVaultStore((s) => s.selectGlobalItem)
  const deleteAccounts = useVaultStore((s) => s.deleteAccounts)
  const mergeDomain = useVaultStore((s) => s.mergeDomain)
  // 현재 활성 탭을 구독한다 — 탭이 바뀌면 추천 섹션이 자동으로 갱신된다
  const activeTab = useBrowserStore((s) => s.activeTab)

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  const currentHost = normalizeHost(activeTab?.url ?? '')
  const globalItems = itemsByAccount.global ?? []
  const q = query.trim().toLowerCase()

  // 모든 계정 태그 모음(필터 바에 칩으로 보여 준다)
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const a of accounts) for (const tag of a.tags) set.add(tag)
    return [...set].sort()
  }, [accounts])

  const matchAccount = (a: AccountDto): boolean => {
    if (q && !`${a.label} ${a.username} ${a.host} ${a.tags.join(' ')}`.toLowerCase().includes(q)) {
      return false
    }
    if (typeFilter !== 'all' && !a.itemTypes.includes(typeFilter)) return false
    if (tagFilter.length > 0 && !tagFilter.every((tag) => a.tags.includes(tag))) return false
    return true
  }

  const matchItem = (i: VaultItemMeta): boolean => {
    if (q && !i.label.toLowerCase().includes(q)) return false
    if (typeFilter !== 'all' && i.type !== typeFilter) return false
    // 전역 항목에는 태그가 없으므로 태그 필터가 켜져 있으면 숨긴다
    return tagFilter.length === 0
  }

  const visibleAccounts = useMemo(
    () => accounts.filter(matchAccount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, q, typeFilter, tagFilter]
  )

  // 추천: 현재 탭 호스트와 같은 계정(탭이 없거나 일치 계정이 없으면 섹션 자체를 숨긴다)
  const suggestions = currentHost ? visibleAccounts.filter((a) => a.host === currentHost) : []

  // 최근 사용: 감사 로그 순서를 그대로 따른다(추천에 이미 나온 계정은 뺀다)
  const recent = recentAccountIds
    .map((id) => visibleAccounts.find((a) => a.id === id))
    .filter((a): a is AccountDto => a !== undefined && !suggestions.includes(a))

  const groups = useMemo(() => {
    const list = groupByDomain(visibleAccounts)
    if (sort === 'recent') {
      // 최근순: 최근 사용 계정을 가진 도메인을 앞으로 올린다
      const rank = (g: DomainGroup): number => {
        const ranks = g.accounts.map((a) => recentAccountIds.indexOf(a.id)).filter((i) => i !== -1)
        return ranks.length > 0 ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER
      }
      list.sort((a, b) => rank(a) - rank(b))
    }
    for (const g of list) g.accounts.sort((x, y) => x.label.localeCompare(y.label))
    return list
  }, [visibleAccounts, sort, recentAccountIds])

  // 검색 중에는 매칭된 그룹을 모두 펼쳐 보여 준다(접혀 있어 결과가 안 보이는 일이 없도록)
  const isExpanded = (key: string): boolean => q.length > 0 || expandedGroups.has(key)

  const filteredGlobalItems = globalItems.filter((i) => GLOBAL_TYPES.has(i.type) && matchItem(i))

  const accountRow = (
    a: AccountDto,
    keyPrefix: string,
    options: { indent?: boolean; showHost?: boolean } = {}
  ): React.JSX.Element => (
    // 삭제 버튼을 행 안에 중첩 버튼으로 넣을 수 없어(잘못된 HTML), 형제로 나란히 둔다
    <div key={`${keyPrefix}-${a.id}`} className="group relative flex items-center">
      <button
        type="button"
        onClick={() => select(a.id)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] py-2 pr-8 text-left',
          options.indent ? 'pl-8' : 'pl-2',
          selectedAccountId === a.id && 'bg-[rgba(0,0,0,.06)]'
        )}
      >
        <SiteFavicon host={a.host} size={options.indent ? 22 : 28} />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[13px] font-medium">{a.label}</b>
          <span className="block truncate text-[11.5px] text-[var(--text3)]">
            {options.showHost === false
              ? displayUsername(a.username)
              : `${a.host} · ${displayUsername(a.username)}`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {payPriorityOf(a.tags) !== null && (
            <span className="rounded-full bg-[var(--accent-soft,#e8f0ff)] px-1.5 py-0.5 text-[10.5px] text-[var(--text2)]">
              {t('vault.payPriority.badge', { n: payPriorityOf(a.tags) })}
            </span>
          )}
          {visibleTags(a.tags).slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-[var(--bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--text2)]"
            >
              {tag}
            </span>
          ))}
          {a.isDefault && (
            <span className="rounded-full bg-[var(--bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--text2)]">
              {t('vault.list.default')}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={() => void deleteAccounts([a.id])}
        title={t('vault.list.deleteAccount')}
        aria-label={t('vault.list.deleteAccount')}
        className="absolute right-1 flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--text3)] opacity-0 hover:bg-black/10 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )

  return (
    <div className="flex w-[300px] shrink-0 flex-col border-r border-black/[.05]">
      <div className="flex flex-col gap-2.5 p-3.5 pb-2.5">
        <div className="flex h-8 items-center gap-2 rounded-[10px] bg-[var(--bg)] px-2.5 text-[var(--text3)]">
          <Search className="h-3.5 w-3.5" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('vault.list.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text3)]"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as VaultItemType | 'all')}
            aria-label={t('vault.list.filterType')}
            className="h-[26px] rounded-[8px] border border-[var(--line)] bg-transparent px-1.5 text-[12px] text-[var(--text2)] outline-none"
          >
            <option value="all">{t('vault.list.filterAll')}</option>
            {VAULT_ITEM_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`vault.itemType.${ty}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setSort(sort === 'name' ? 'recent' : 'name')}
            title={t('vault.list.sortLabel')}
            className="flex h-[26px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] border border-[var(--line)] px-1.5 text-[12px] text-[var(--text2)]"
          >
            {sort === 'name' ? (
              <ArrowDownAZ className="h-3.5 w-3.5" />
            ) : (
              <Clock className="h-3.5 w-3.5" />
            )}
            {sort === 'name' ? t('vault.list.sortName') : t('vault.list.sortRecent')}
          </button>
          <button
            type="button"
            onClick={() =>
              expandedGroups.size > 0
                ? collapseAllGroups()
                : expandAllGroups(groups.map((g) => g.key))
            }
            className="h-[26px] shrink-0 whitespace-nowrap rounded-[8px] border border-[var(--line)] px-1.5 text-[12px] text-[var(--text2)]"
          >
            {expandedGroups.size > 0 ? t('vault.list.collapseAll') : t('vault.list.expandAll')}
          </button>
          <button
            type="button"
            onClick={onSettings}
            title={t('vault.list.settingsBtn')}
            className="ml-auto flex h-[26px] w-[26px] items-center justify-center rounded-[8px] border border-[var(--line)] text-[var(--text2)]"
          >
            <SettingsIcon className="h-3.5 w-3.5" />
          </button>
          <AddItemMenu onPick={onAdd} onImport={onImport} />
        </div>
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTagFilter(tag)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px]',
                  tagFilter.includes(tag)
                    ? 'bg-[var(--text)] text-white'
                    : 'bg-[var(--bg)] text-[var(--text2)]'
                )}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto px-2 pb-2">
        {suggestions.length > 0 && (
          <div>
            <div className="px-2 pb-1 pt-2 text-[11px] font-semibold text-[var(--text3)]">
              {t('vault.list.suggestions')} · {currentHost}
            </div>
            {suggestions.map((a) => accountRow(a, 'sug'))}
          </div>
        )}
        {recent.length > 0 && (
          <div>
            <div className="px-2 pb-1 pt-3 text-[11px] font-semibold text-[var(--text3)]">
              {t('vault.list.recent')}
            </div>
            {recent.map((a) => accountRow(a, 'recent'))}
          </div>
        )}
        {groups.map((group) => {
          const expanded = isExpanded(group.key)
          const only = group.accounts.length === 1 ? group.accounts[0] : null
          return (
            <div key={group.key}>
              <div className="group relative flex items-center">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] py-2 pl-2 pr-16 text-left hover:bg-black/[.03]"
                >
                  <SiteFavicon host={group.key} />
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-[13px] font-medium">{group.key}</b>
                    <span className="block truncate text-[11.5px] text-[var(--text3)]">
                      {only
                        ? displayUsername(only.username)
                        : t('vault.list.accountCount', { count: group.accounts.length })}
                    </span>
                  </span>
                  {expanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text3)]" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text3)]" />
                  )}
                </button>
                {duplicateCount(group) > 0 && (
                  <button
                    type="button"
                    onClick={() => void mergeDomain(group.key)}
                    title={t('vault.list.mergeTitle', { domain: group.key })}
                    className="absolute right-8 flex h-6 items-center gap-1 rounded-[7px] px-1.5 text-[11px] text-[var(--text3)] opacity-0 hover:bg-black/10 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Merge className="h-3.5 w-3.5" />
                    {t('vault.list.merge', { count: duplicateCount(group) })}
                  </button>
                )}
                <GroupDeleteButton
                  accountIds={group.accounts.map((a) => a.id)}
                  onDelete={(ids) => void deleteAccounts(ids)}
                />
              </div>
              {expanded &&
                group.accounts.map((a) => accountRow(a, `g-${group.key}`, { indent: true }))}
            </div>
          )
        })}
        {filteredGlobalItems.length > 0 && (
          <div>
            <div className="px-2 pb-1 pt-3 text-[11px] font-semibold text-[var(--text3)]">
              {t('vault.list.globalGroup')}
            </div>
            {filteredGlobalItems.map((i) => (
              <button
                key={i.id}
                type="button"
                onClick={() => selectGlobalItem(i.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left',
                  selectedAccountId === 'global' &&
                    selectedGlobalItemId === i.id &&
                    'bg-[rgba(0,0,0,.06)]'
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--bg)] text-[12px] font-bold text-[var(--text2)]">
                  {i.label.slice(0, 1)}
                </span>
                <span className="min-w-0">
                  <b className="block truncate text-[13px] font-medium">{i.label}</b>
                  <span className="block truncate text-[11.5px] text-[var(--text3)]">
                    {t(`vault.itemType.${i.type}`)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {groups.length === 0 && filteredGlobalItems.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-[var(--text3)]">
            {t('vault.list.empty')}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * 사이트(도메인 그룹) 삭제 버튼. 확인 없이 바로 지운다 — 되돌리기 토스트(60초)가 안전망이다
 */
function GroupDeleteButton({
  accountIds,
  onDelete
}: {
  accountIds: number[]
  onDelete: (ids: number[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={() => onDelete(accountIds)}
      title={t('vault.list.deleteSite')}
      aria-label={t('vault.list.deleteSite')}
      className="absolute right-1 flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--text3)] opacity-0 hover:bg-black/10 focus-visible:opacity-100 group-hover:opacity-100"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  )
}
