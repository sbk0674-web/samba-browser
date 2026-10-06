import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FolderOpen, Search, Store } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import { ExtensionCard } from '@renderer/components/extensions/ExtensionCard'
import { ExtensionProfileScope } from '@renderer/components/extensions/ExtensionProfileScope'
import { ExtensionImportDialog } from '@renderer/components/extensions/ExtensionImportDialog'
import { ExtensionWebstoreDialog } from '@renderer/components/extensions/ExtensionWebstoreDialog'
import {
  DEFAULT_EXTENSION_MENU,
  EXTENSION_MENUS,
  filterExtensions,
  sortExtensions,
  type ExtensionMenu
} from '@renderer/components/extensions/extension-list'
import { WEBSTORE_URL } from '@shared/extensions'
import { cn } from '@renderer/lib/utils'
import { useExtensionStore } from '@renderer/stores/extensionStore'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'

const MENU_LABEL_KEYS: Record<ExtensionMenu, string> = {
  mine: 'extensions.menuMine',
  shortcuts: 'extensions.menuShortcuts'
}

// 확장 프로그램 화면 — 크롬의 chrome://extensions 와 같은 짜임새다.
// 상단 제목 + 검색 + 개발자 모드 토글, 왼쪽 소메뉴, 본문은 카드 그리드.
// "폴더 불러오기" 는 크롬과 마찬가지로 개발자 모드를 켰을 때만 보인다
export function ExtensionsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    items,
    loadErrors,
    message,
    busy,
    load,
    addFolder,
    remove,
    removed,
    undoRemove,
    dismissRemoved,
    setEnabled,
    clearMessage
  } = useExtensionStore()
  const [menu, setMenu] = useState<ExtensionMenu>(DEFAULT_EXTENSION_MENU)
  const [query, setQuery] = useState('')
  const [devMode, setDevMode] = useState(false)
  const [storeOpen, setStoreOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const createTab = useBrowserStore((s) => s.createTab)
  const setView = useUiStore((s) => s.setView)

  useEffect(() => {
    void load()
  }, [load])

  // 웹스토어 탭에서 설치가 끝나면 메인이 알려 준다 — 이 화면으로 돌아왔을 때 이미 목록에 있다
  useEffect(() => window.samba.extensions.onChanged(() => void load()), [load])

  // 크롬과 같은 흐름 — 웹스토어를 새 탭으로 열고 브라우저 화면으로 돌아간다.
  // 상세 페이지의 "Chrome에 추가" 를 누르면 그대로 설치된다(가로채기는 페이지 preload 가 한다)
  const openWebstore = async (): Promise<void> => {
    await createTab(WEBSTORE_URL)
    setView('browser')
  }

  const shown = useMemo(() => sortExtensions(filterExtensions(items, query)), [items, query])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]">
      {/* 상단 줄 — 제목 · 검색 · 개발자 모드 */}
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-6 py-4">
        <h1 className="text-[18px] font-semibold tracking-tight text-[var(--text)]">
          {t('extensions.pageTitle')}
        </h1>
        <label className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-[10px] border border-[var(--line)] bg-white px-3">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text3)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('extensions.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
          />
        </label>
        <span className="flex shrink-0 items-center gap-2 text-[12px] text-[var(--text2)]">
          {t('extensions.devMode')}
          <Switch checked={devMode} onCheckedChange={setDevMode} />
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 min-[769px]:flex-row">
        {/* 왼쪽 소메뉴 — 좁은 폭에서는 가로 탭이 된다 */}
        <nav className="flex shrink-0 gap-1.5 min-[769px]:w-[180px] min-[769px]:flex-col">
          {EXTENSION_MENUS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMenu(m)}
              className={cn(
                'h-8 rounded-[8px] px-2.5 text-left text-[12.5px]',
                menu === m
                  ? 'bg-black/[.06] font-medium text-[var(--text)]'
                  : 'text-[var(--text2)] hover:bg-black/[.03]'
              )}
            >
              {t(MENU_LABEL_KEYS[m])}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {menu === 'shortcuts' ? (
            <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-[12.5px] text-[var(--text2)]">
              {t('extensions.shortcutsSoon')}
            </p>
          ) : (
            <>
              {/* 설치 경로 — 폴더 불러오기는 개발자 모드에서만 */}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void openWebstore()}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-[9px] bg-[var(--text)] px-3 text-[12.5px] font-medium text-white"
                >
                  <Store className="h-3.5 w-3.5" />
                  {t('extensions.storeButton')}
                </button>
                <button
                  type="button"
                  onClick={() => setImportOpen(true)}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-[9px] border border-[var(--line)] px-3 text-[12.5px] font-medium text-[var(--text)] hover:bg-black/5"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('extensions.importButton')}
                </button>
                {devMode && (
                  <button
                    type="button"
                    onClick={() => void addFolder()}
                    disabled={busy}
                    className="flex h-9 shrink-0 items-center gap-1.5 rounded-[9px] border border-[var(--line)] px-3 text-[12.5px] font-medium text-[var(--text)] hover:bg-black/5 disabled:opacity-50"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {busy ? t('extensions.adding') : t('extensions.addButton')}
                  </button>
                )}
                {/* 보조 경로 — 주소나 id 를 직접 아는 경우에만 쓴다 */}
                <button
                  type="button"
                  onClick={() => setStoreOpen(true)}
                  className="h-9 shrink-0 px-1 text-[12px] text-[var(--text2)] underline underline-offset-2 hover:text-[var(--text)]"
                >
                  {t('extensions.storeByUrl')}
                </button>
              </div>

              {/* 크롬과 같은 설치 흐름 안내 */}
              <p className="text-[11.5px] leading-snug text-[var(--text2)]">
                {t('extensions.storeHint')}
              </p>

              {message && (
                <p className="flex items-start gap-3 rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-600">
                  <span className="min-w-0 flex-1">{message}</span>
                  <button type="button" onClick={clearMessage} className="shrink-0 underline">
                    {t('extensions.cancel')}
                  </button>
                </p>
              )}

              {/* 제거 되돌리기 — 5초 동안만 떠 있는다 */}
              {removed && (
                <p className="flex items-center gap-3 rounded-[10px] border border-[var(--line)] bg-black/[0.03] px-3 py-2 text-[11.5px] text-[var(--text)]">
                  <span className="min-w-0 flex-1 truncate">
                    {t('extensions.removed', { name: removed.name })}
                  </span>
                  <button
                    type="button"
                    onClick={() => void undoRemove()}
                    className="shrink-0 font-medium underline underline-offset-2"
                  >
                    {t('extensions.undo')}
                  </button>
                  <button
                    type="button"
                    onClick={dismissRemoved}
                    className="shrink-0 text-[var(--text2)] underline underline-offset-2"
                  >
                    {t('extensions.cancel')}
                  </button>
                </p>
              )}

              {/* 카드 그리드 */}
              {shown.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-[12.5px] text-[var(--text2)]">
                  {items.length === 0 ? t('extensions.empty') : t('extensions.searchEmpty')}
                </p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {shown.map((item) => (
                    <ExtensionCard
                      key={item.id}
                      item={item}
                      onToggle={(v) => setEnabled(item.id, v)}
                      onRemove={() => remove(item.id)}
                    />
                  ))}
                </div>
              )}

              {/* 확장별로 올릴 프로필 */}
              {items.length > 0 && <ExtensionProfileScope items={items} />}

              {/* 시작할 때 실패한 확장 — 개발자 모드에서만 자세히 보여 준다 */}
              {devMode && loadErrors.length > 0 && (
                <div className="flex flex-col gap-1 rounded-[10px] border border-red-200 bg-red-50 px-3 py-2">
                  <span className="text-[11.5px] font-medium text-red-600">
                    {t('extensions.failedTitle')}
                  </span>
                  {loadErrors.map((e) => (
                    <span key={e.path} className="text-[11px] leading-snug break-all text-red-500">
                      {e.path} — {e.error}
                    </span>
                  ))}
                </div>
              )}

              {/* 제한 사항 — 개발자 모드에서만, 크롬처럼 화면을 어지럽히지 않는다 */}
              {devMode && (
                <div className="flex flex-col gap-1 rounded-[10px] bg-black/[0.03] px-3 py-2">
                  <span className="text-[11.5px] font-medium text-[var(--text)]">
                    {t('extensions.limitsTitle')}
                  </span>
                  <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-snug text-[var(--text2)]">
                    <li>{t('extensions.limitMv3')}</li>
                    <li>{t('extensions.limitServiceWorker')}</li>
                    <li>{t('extensions.limitNoAutoUpdate')}</li>
                    <li>{t('extensions.limitMv2')}</li>
                    <li>{t('extensions.limitPartition')}</li>
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <ExtensionWebstoreDialog
        open={storeOpen}
        onOpenChange={setStoreOpen}
        onInstalled={() => load()}
      />
      <ExtensionImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => load()}
      />
    </div>
  )
}
