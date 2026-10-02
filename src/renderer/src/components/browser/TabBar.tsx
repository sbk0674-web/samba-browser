import type React from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus } from 'lucide-react'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { profileColor, profileTint } from '@renderer/lib/profile-color'
import { ProfileMenu } from './ProfileMenu'

export function TabBar(): React.JSX.Element {
  const { t } = useTranslation()
  const { tabs, activateTab, closeTab, createTab } = useBrowserStore()
  return (
    <div
      className="flex items-end gap-1 px-2.5 pt-2"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 팝업 창(결제창·주소 검색창)은 탭 바에 넣지 않는다 — 사이드바 "열린 탭"에만 배지로 보인다 */}
      {tabs
        .filter((tab) => tab.kind !== 'popup')
        .map((tab) => {
          // 계정별 세션(프로필) 탭은 이름마다 고정된 색 띠·배지로 구분한다 — 어느 계정으로 로그인된 탭인지 한눈에
          const color = profileColor(tab.profile)
          return (
            <div
              key={tab.id}
              onClick={() => activateTab(tab.id)}
              title={color ? t('tab.profileOf', { profile: tab.profile }) : undefined}
              style={
                {
                  WebkitAppRegion: 'no-drag',
                  ...(color ? { boxShadow: `inset 0 3px 0 0 ${color}` } : {})
                } as React.CSSProperties
              }
              className={cn(
                'flex max-w-[200px] items-center gap-2 rounded-t-lg px-2.5 pb-2 pt-1.5 text-[12.5px] text-[var(--text2)] cursor-default',
                tab.active && 'bg-[var(--bg)] font-medium text-[var(--text)]'
              )}
            >
              <span className="truncate">{tab.title || tab.url}</span>
              {color && (
                <Badge
                  variant="secondary"
                  className="h-4 px-1.5 text-[10.5px]"
                  style={{ color, backgroundColor: profileTint(tab.profile) ?? undefined }}
                >
                  {tab.profile}
                </Badge>
              )}
              <X
                className="h-3.5 w-3.5 shrink-0 text-[var(--text3)] hover:text-[var(--text)]"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(tab.id)
                }}
              />
            </div>
          )
        })}
      <button
        title={t('tab.new')}
        onClick={() => createTab()}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className="px-2 pb-2 pt-1.5 text-[var(--text3)]"
      >
        <Plus className="h-4 w-4" />
      </button>
      <ProfileMenu />
    </div>
  )
}
