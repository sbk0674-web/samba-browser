import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Users } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Input } from '@renderer/components/ui/input'
import { useOverlayStore } from '@renderer/stores/overlayStore'
import { profileColor } from '@renderer/lib/profile-color'
import { cn } from '@renderer/lib/utils'
import { DEFAULT_PROFILE_NAME, MAX_PROFILE_NAME, isValidProfileName } from '@shared/profiles'

// 탭 바의 프로필 메뉴 — 프로필(계정별 로그인 세션)을 골라 그 프로필로 새 탭을 연다.
//   기본 프로필 · 지금까지 쓴 프로필 목록 · 새 프로필 만들기
// 프로필마다 쿠키·로그인이 따로라 같은 사이트에 다른 계정으로 동시에 들어갈 수 있다
export function ProfileMenu(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<string[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 열려 있는 동안에는 네이티브 웹뷰를 접는다 — 접지 않으면 팝오버가 그 아래로 가려져 안 보인다
  const setWebviewHidden = useOverlayStore((s) => s.setWebviewHidden)
  useEffect(() => {
    setWebviewHidden(open)
    return () => setWebviewHidden(false)
  }, [open, setWebviewHidden])

  // 하네스·AI 가 새 프로필을 만들 수 있으므로 열 때마다 목록을 다시 읽는다
  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) return
    setName('')
    setError(null)
    void window.samba.tabs.profiles().then((r) => {
      if (r.ok) setProfiles(r.data)
      else setError(r.error)
    })
  }

  const openIn = (profile: string): void => {
    setOpen(false)
    void window.samba.tabs.create({ profile })
  }

  const createProfile = (): void => {
    const trimmed = name.trim()
    if (!isValidProfileName(trimmed)) {
      setError(t('tab.profileInvalid', { max: MAX_PROFILE_NAME }))
      return
    }
    openIn(trimmed)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          title={t('tab.profiles')}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className={cn('px-2 pb-2 pt-1.5 text-[var(--text3)]', open && 'text-[var(--text)]')}
        >
          <Users className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 max-w-[calc(100vw-16px)]">
        <div className="px-2 pb-1 pt-1 text-[11.5px] text-[var(--text3)]">
          {t('tab.profileHint')}
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          <ProfileRow
            label={t('tab.profileDefault')}
            color={null}
            onClick={() => openIn(DEFAULT_PROFILE_NAME)}
          />
          {profiles.map((p) => (
            <ProfileRow key={p} label={p} color={profileColor(p)} onClick={() => openIn(p)} />
          ))}
        </div>
        <form
          className="mt-1 flex items-center gap-1.5 border-t border-[var(--line)] px-1 pt-2"
          onSubmit={(e) => {
            e.preventDefault()
            createProfile()
          }}
        >
          <Input
            value={name}
            maxLength={MAX_PROFILE_NAME}
            placeholder={t('tab.profileNamePlaceholder')}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            className="h-8 text-[12.5px]"
          />
          <button
            type="submit"
            title={t('tab.profileCreate')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text2)] hover:bg-black/5"
          >
            <Plus className="h-4 w-4" />
          </button>
        </form>
        {error && <div className="px-2 pt-1.5 text-[11.5px] text-red-600">{error}</div>}
      </PopoverContent>
    </Popover>
  )
}

function ProfileRow(props: {
  label: string
  color: string | null
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-black/5"
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--line)]"
        style={props.color ? { backgroundColor: props.color, borderColor: props.color } : undefined}
      />
      <span className="truncate">{props.label}</span>
    </button>
  )
}
