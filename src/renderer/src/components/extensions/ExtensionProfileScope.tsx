import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtensionDto } from '@shared/extensions'
import { parseProfileList, scopeModeOf, type ScopeMode } from './extension-scope'

// 확장별로 "어느 프로필에 올릴지" 고르는 칸.
// 모든 프로필 / 일반 탭만 / 고른 프로필 — 바꾼 값은 앱을 다시 켠 뒤부터 적용된다
export function ExtensionProfileScope({ items }: { items: ExtensionDto[] }): React.JSX.Element {
  const { t } = useTranslation()
  const [scopes, setScopes] = useState<Record<string, string[]>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.samba.settings.get().then((r) => {
      if (!r.ok) return
      setScopes(r.data.extensionProfiles)
      const next: Record<string, string> = {}
      for (const [id, list] of Object.entries(r.data.extensionProfiles)) next[id] = list.join(', ')
      setDrafts(next)
    })
  }, [])

  const save = (next: Record<string, string[]>): void => {
    setScopes(next)
    void window.samba.settings.set({ extensionProfiles: next }).then((r) => setSaved(r.ok))
  }

  const setMode = (id: string, mode: ScopeMode): void => {
    const next = { ...scopes }
    if (mode === 'all') delete next[id]
    else if (mode === 'default') next[id] = []
    else next[id] = parseProfileList(drafts[id] ?? '')
    save(next)
  }

  const commitList = (id: string): void => {
    save({ ...scopes, [id]: parseProfileList(drafts[id] ?? '') })
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-[var(--line)] p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium text-[var(--text)]">
          {t('extensions.scopeTitle')}
        </span>
        <span className="text-[11.5px] leading-snug text-[var(--text2)]">
          {t('extensions.scopeDesc')}
        </span>
      </div>
      {items.map((item) => {
        const mode = scopeModeOf(scopes, item.id)
        return (
          <div key={item.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-[140px] flex-1 truncate text-[12.5px] text-[var(--text)]">
              {item.name}
            </span>
            <select
              value={mode}
              onChange={(e) => setMode(item.id, e.target.value as ScopeMode)}
              aria-label={t('extensions.scopeTitle')}
              className="h-[30px] rounded-[8px] border border-[var(--line)] bg-transparent px-2 text-[12px] text-[var(--text)]"
            >
              <option value="all">{t('extensions.scopeAll')}</option>
              <option value="default">{t('extensions.scopeDefault')}</option>
              <option value="list">{t('extensions.scopeList')}</option>
            </select>
            {mode === 'list' && (
              <input
                value={drafts[item.id] ?? ''}
                onChange={(e) => setDrafts({ ...drafts, [item.id]: e.target.value })}
                onBlur={() => commitList(item.id)}
                placeholder={t('extensions.scopePlaceholder')}
                className="h-[30px] min-w-[180px] flex-1 rounded-[8px] border border-[var(--line)] bg-transparent px-2 text-[12px] text-[var(--text)]"
              />
            )}
          </div>
        )
      })}
      {saved && (
        <span className="text-[11.5px] text-[var(--text2)]">{t('extensions.scopeSaved')}</span>
      )}
    </div>
  )
}
