import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { useUiStore } from '@renderer/stores/uiStore'
import { useVaultStore } from '@renderer/stores/vaultStore'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { normalizeHost } from '@shared/host'
import type { AccountDto } from '@shared/ipc'

// 자동 채우기 결과 안내를 남겨 두는 시간(ms)
const NOTICE_MS = 3000
// 목록에 보여 줄 최대 계정 수(축소판이라 짧게 끊는다)
const LIST_LIMIT = 6

/**
 * 툴바 열쇠 아이콘으로 여는 키마스터 축소판.
 * 오른쪽 AI 패널 상단 슬롯(웹뷰 밖)에 그려서 네이티브 웹뷰에 가려지지 않는다.
 */
export function VaultPopover(): React.JSX.Element {
  const { t } = useTranslation()
  const closeVaultPanel = useUiStore((s) => s.closeVaultPanel)
  const openSettings = useUiStore((s) => s.openSettings)
  const state = useVaultStore((s) => s.state)
  const accounts = useVaultStore((s) => s.accounts)
  const refreshState = useVaultStore((s) => s.refreshState)
  const recentAccountIds = useVaultStore((s) => s.recentAccountIds)
  const loadRecent = useVaultStore((s) => s.loadRecent)
  const autofill = useVaultStore((s) => s.autofill)
  const select = useVaultStore((s) => s.select)
  const activeTab = useBrowserStore((s) => s.activeTab)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void refreshState()
    void loadRecent()
  }, [refreshState, loadRecent])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const host = normalizeHost(activeTab?.url ?? '')
  const q = query.trim().toLowerCase()

  const matched = useMemo(
    () =>
      accounts.filter((a) => !q || `${a.label} ${a.username} ${a.host}`.toLowerCase().includes(q)),
    [accounts, q]
  )
  const suggestions = host ? matched.filter((a) => a.host === host) : []
  const recent = recentAccountIds
    .map((id) => matched.find((a) => a.id === id))
    .filter((a): a is AccountDto => a !== undefined && !suggestions.includes(a))

  const run = async (accountId: number): Promise<void> => {
    const result = await autofill(accountId)
    // 2단계 로그인의 아이디 화면(filled-username-only)도 채우기 성공이다 — 비밀번호는 뒤에서 이어 채운다
    setNotice(
      result === 'ok' || result === 'filled-password-only' || result === 'filled-username-only'
        ? 'ok'
        : 'failed'
    )
  }

  const row = (a: AccountDto, keyPrefix: string): React.JSX.Element => (
    <button
      key={`${keyPrefix}-${a.id}`}
      type="button"
      onClick={() => void run(a.id)}
      className="flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left hover:bg-black/5"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-[var(--text)] text-[11px] font-bold text-white">
        {a.host.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[12.5px] font-medium">{a.label}</b>
        <span className="block truncate text-[11px] text-[var(--text3)]">{a.host}</span>
      </span>
    </button>
  )

  return (
    <section className="flex max-h-[320px] flex-col rounded-2xl border border-[var(--line)] bg-white p-2.5">
      <header className="mb-2 flex items-center gap-2">
        <b className="text-[13px]">{t('vault.popover.title')}</b>
        <button
          type="button"
          onClick={() => {
            closeVaultPanel()
            openSettings('keymaster')
          }}
          className="text-[11.5px] text-[var(--text3)] underline"
        >
          {t('vault.popover.manage')}
        </button>
        <button
          type="button"
          onClick={closeVaultPanel}
          title={t('vault.popover.close')}
          aria-label={t('vault.popover.close')}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-[7px] text-[var(--text2)] hover:bg-black/5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {state !== 'unlocked' ? (
        <p className="px-1 py-3 text-center text-[12px] text-[var(--text3)]">
          {t('vault.autofill.locked')}
        </p>
      ) : (
        <>
          <div className="mb-2 flex h-8 items-center gap-2 rounded-[10px] bg-[var(--bg)] px-2.5 text-[var(--text3)]">
            <Search className="h-3.5 w-3.5" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('vault.list.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--text)] outline-none placeholder:text-[var(--text3)]"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {suggestions.length > 0 && (
              <>
                <div className="px-2 pb-1 pt-1 text-[10.5px] font-semibold text-[var(--text3)]">
                  {t('vault.list.suggestions')}
                </div>
                {suggestions.slice(0, LIST_LIMIT).map((a) => row(a, 'sug'))}
              </>
            )}
            {recent.length > 0 && (
              <>
                <div className="px-2 pb-1 pt-2 text-[10.5px] font-semibold text-[var(--text3)]">
                  {t('vault.list.recent')}
                </div>
                {recent.slice(0, LIST_LIMIT).map((a) => row(a, 'recent'))}
              </>
            )}
            {suggestions.length === 0 && recent.length === 0 && (
              <p className="px-2 py-3 text-center text-[12px] text-[var(--text3)]">
                {t('vault.list.noSuggestions')}
              </p>
            )}
          </div>
          <footer className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                closeVaultPanel()
                select(null)
                openSettings('keymaster')
              }}
              className="text-[11.5px] text-[var(--text3)] underline"
            >
              {t('vault.add.menu')}
            </button>
            {notice && (
              <span className="ml-auto text-[11.5px] text-[var(--text2)]">
                {t(notice === 'ok' ? 'vault.autofill.ok' : 'vault.autofill.failed')}
              </span>
            )}
          </footer>
        </>
      )}
    </section>
  )
}
