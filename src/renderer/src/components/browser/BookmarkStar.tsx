import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Star } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useOverlayStore } from '@renderer/stores/overlayStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { useBookmarkStore } from '@renderer/stores/bookmarkStore'
import {
  findBookmarkEntry,
  folderOptions,
  type BookmarkEntry,
  type FolderOption
} from '@renderer/lib/bookmark-folders'
import type { BookmarkFolderDto, BookmarkTreeDto } from '../../../../shared/import'

// 주소창 안 별 버튼 — 크롬처럼 누르면 지금 페이지를 북마크바에 넣고 바로 편집 팝오버를 연다
// (이름·폴더를 고치거나 삭제). 이미 있으면 그 북마크의 편집 팝오버를 연다

/** 트리에서 같은 주소의 링크 id 를 찾는다(최상위 → 폴더 깊이 순). 없으면 null */
export function findBookmarkId(tree: BookmarkTreeDto, url: string): number | null {
  return findBookmarkEntry(tree, url)?.id ?? null
}

/** 새 북마크를 넣을 폴더 — 북마크바 폴더가 있으면 그곳, 없으면 최상위(null) */
export function toolbarFolderId(tree: BookmarkTreeDto): number | null {
  const walk = (folders: BookmarkFolderDto[]): number | null => {
    for (const f of folders) {
      if (f.isToolbar) return f.id
      const deep = walk(f.folders)
      if (deep !== null) return deep
    }
    return null
  }
  return walk(tree.folders)
}

/** 북마크할 수 있는 주소인가 — 웹 주소만(새 탭·앱 내부 페이지는 뺀다) */
export function isBookmarkableUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url)
}

// <select> 의 value 는 문자열이라 최상위(null)를 따로 표기한다
const ROOT_VALUE = 'root'
const folderValue = (id: number | null): string => (id === null ? ROOT_VALUE : String(id))
const folderIdOf = (value: string): number | null => (value === ROOT_VALUE ? null : Number(value))

export function BookmarkStar({
  url,
  title
}: {
  url?: string
  title?: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [entry, setEntry] = useState<BookmarkEntry | null>(null)
  const [options, setOptions] = useState<FolderOption[]>([])
  const [open, setOpen] = useState(false)
  const [justAdded, setJustAdded] = useState(false)
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const setView = useUiStore((s) => s.setView)
  const reloadTree = useBookmarkStore((s) => s.load)
  const setWebviewHidden = useOverlayStore((s) => s.setWebviewHidden)

  // 열려 있는 동안에는 네이티브 웹뷰를 접는다 — 접지 않으면 팝오버가 그 아래로 가려져 안 보인다
  useEffect(() => {
    setWebviewHidden(open)
    return () => setWebviewHidden(false)
  }, [open, setWebviewHidden])

  const labels = { root: t('bookmark.popover.otherFolder'), toolbar: t('bookmark.toolbar') }

  // 북마크할 수 없는 주소면 아무것도 그리지 않으므로 상태를 비울 필요가 없다(이펙트 안 동기 setState 금지 규칙)
  const refresh = useCallback(async (): Promise<BookmarkEntry | null> => {
    if (!isBookmarkableUrl(url)) return null
    const r = await window.samba.bookmarks.tree()
    if (!r.ok) {
      setEntry(null)
      return null
    }
    const found = findBookmarkEntry(r.data, url)
    setEntry(found)
    setOptions(folderOptions(r.data, labels))
    return found
    // labels 는 언어가 바뀔 때만 달라진다 — 주소가 바뀔 때만 다시 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // 주소가 바뀔 때마다 이 페이지가 이미 북마크돼 있는지 다시 본다.
  // 마이크로태스크로 미뤄 이펙트 안에서 동기 setState 가 되지 않게 한다(react-hooks 규칙)
  useEffect(() => {
    let alive = true
    queueMicrotask(() => {
      if (alive) void refresh()
    })
    return () => {
      alive = false
    }
  }, [refresh])
  // 다른 페이지로 넘어가면 열려 있던 팝오버는 닫는다(이펙트의 setState 대신 렌더 중 비교 — AddressBar 와 같은 방식)
  const [syncedUrl, setSyncedUrl] = useState(url)
  if (url !== syncedUrl) {
    setSyncedUrl(url)
    if (open) setOpen(false)
  }

  if (!isBookmarkableUrl(url)) return null
  const saved = entry !== null

  // 팝오버의 입력값을 지금 북마크 상태로 맞춘다
  const showEditor = (e: BookmarkEntry, added: boolean): void => {
    setName(e.title)
    setFolderId(e.folderId)
    setJustAdded(added)
    setOpen(true)
  }

  // 별 클릭: 없으면 북마크바에 바로 넣고 편집 팝오버, 있으면 편집 팝오버
  const onStar = async (): Promise<void> => {
    if (busy) return
    if (open) {
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      if (entry) {
        showEditor(entry, false)
        return
      }
      const tree = await window.samba.bookmarks.tree()
      const target = tree.ok ? toolbarFolderId(tree.data) : null
      await window.samba.bookmarks.createLink(target, title?.trim() || url, url)
      void reloadTree()
      const created = await refresh()
      if (created) showEditor(created, true)
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!entry || busy) return
    setBusy(true)
    try {
      const nextName = name.trim()
      if (nextName && nextName !== entry.title) {
        await window.samba.bookmarks.rename(entry.id, 'link', nextName)
      }
      if (folderId !== entry.folderId) {
        await window.samba.bookmarks.move({ id: entry.id, kind: 'link', toFolderId: folderId })
      }
      void reloadTree()
      await refresh()
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!entry || busy) return
    setBusy(true)
    try {
      await window.samba.bookmarks.remove(entry.id)
      void reloadTree()
      await refresh()
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const more = (): void => {
    setOpen(false)
    setView('bookmarks')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        // 열기는 별 클릭 처리(onStar)가 맡는다 — 바깥 클릭·Esc 로 닫히는 것만 받는다
        if (!o) setOpen(false)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={() => void onStar()}
          disabled={busy}
          title={saved ? t('bookmark.popover.editTitle') : t('address.bookmarkAdd')}
          aria-label={saved ? t('bookmark.popover.editTitle') : t('address.bookmarkAdd')}
          aria-pressed={saved}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text3)] hover:bg-black/5"
        >
          <Star className={cn('h-3.5 w-3.5', saved && 'fill-amber-400 text-amber-400')} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-2xl p-4">
        <div className="mb-3 text-[14px] font-semibold text-[var(--text)]">
          {justAdded ? t('bookmark.popover.addedTitle') : t('bookmark.popover.editTitle')}
        </div>
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1 text-[12px] text-[var(--text2)]">
            {t('bookmark.popover.name')}
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
              className="h-9 rounded-[9px]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-[var(--text2)]">
            {t('bookmark.popover.folder')}
            <select
              value={folderValue(folderId)}
              onChange={(e) => setFolderId(folderIdOf(e.target.value))}
              className="h-9 rounded-[9px] border border-[var(--line)] bg-white px-2 text-[12.5px] text-[var(--text)] outline-none"
            >
              {options.map((o) => (
                <option key={folderValue(o.id)} value={folderValue(o.id)}>
                  {' '.repeat(o.depth * 3)}
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={more}
            className="text-[12.5px] text-[var(--accent,#2563eb)] hover:underline"
          >
            {t('bookmark.popover.more')}
          </button>
          <div className="flex-1" />
          <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
            {t('bookmark.popover.done')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void remove()}
            disabled={busy}
          >
            {t('bookmark.popover.delete')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
