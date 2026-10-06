import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useBookmarkStore } from '@renderer/stores/bookmarkStore'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { insertIndexBefore } from '@renderer/lib/bookmark-folders'
import { SectionHeader } from './SectionHeader'
import { isSectionOpen } from './sidebar-view'
import type { BookmarkFolderDto, BookmarkLinkDto } from '@shared/ipc'

// === 끌어 옮기기 =====================================================================
// 행을 끌어 다른 행 위에 놓으면 그 행 앞에, 폴더 행 아래쪽에 놓으면 그 폴더 안(끝)에 들어간다.
// 자리 계산은 저장소(placeLink/placeFolder)가 하고, 여기서는 "어느 부모의 몇 번째" 만 넘긴다

const DND_TYPE = 'application/x-samba-bookmark'
// 폴더 끝에 붙이기 — 저장소가 범위 밖 자리를 끝으로 맞춘다
const AT_END = 1_000_000

interface DragPayload {
  id: number
  kind: 'folder' | 'link'
}

function readPayload(e: React.DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DND_TYPE)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<DragPayload>
    if (typeof p.id !== 'number' || (p.kind !== 'folder' && p.kind !== 'link')) return null
    return { id: p.id, kind: p.kind }
  } catch {
    return null
  }
}

function startDrag(e: React.DragEvent, payload: DragPayload): void {
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'move'
}

function allowDrop(e: React.DragEvent): boolean {
  if (!e.dataTransfer.types.includes(DND_TYPE)) return false
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  return true
}

type DropSpot = 'before' | 'into' | null

// 즐겨찾기 아이콘 대신 첫 글자를 검정 원에 넣은 파비콘 대체
function LetterFavicon({ title }: { title: string }): React.JSX.Element {
  const letter = title.trim().charAt(0).toUpperCase() || '?'
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-black/70 text-[8px] font-semibold text-white">
      {letter}
    </span>
  )
}

function LinkRow({
  link,
  depth,
  parentId,
  siblingIds
}: {
  link: BookmarkLinkDto
  depth: number
  // 이 링크가 든 폴더와 그 폴더 안 링크 id 순서 — 끌어 놓을 때 "이 링크 앞" 자리를 계산한다
  parentId: number | null
  siblingIds: number[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const remove = useBookmarkStore((s) => s.remove)
  const place = useBookmarkStore((s) => s.place)
  const activeTab = useBrowserStore((s) => s.activeTab)
  const setView = useUiStore((s) => s.setView)
  const [over, setOver] = useState(false)

  const open = async (): Promise<void> => {
    setView('browser')
    if (activeTab) {
      await window.samba.tabs.navigate(activeTab.id, link.url)
    } else {
      await window.samba.tabs.create({ url: link.url })
    }
  }

  const onRemove = (e: React.MouseEvent): void => {
    e.stopPropagation()
    void remove(link.id)
  }

  const onDrop = (e: React.DragEvent): void => {
    setOver(false)
    const p = readPayload(e)
    if (!p) return
    e.preventDefault()
    e.stopPropagation()
    if (p.kind === 'link') {
      if (p.id === link.id) return
      void place(p.id, 'link', parentId, insertIndexBefore(siblingIds, p.id, link.id))
    } else {
      // 폴더는 링크 사이에 끼울 수 없다 — 같은 부모의 폴더 목록 끝으로 보낸다
      void place(p.id, 'folder', parentId, AT_END)
    }
  }

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => startDrag(e, { id: link.id, kind: 'link' })}
      onDragOver={(e) => {
        if (allowDrop(e)) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => void open()}
      onContextMenu={(e) => {
        // 우클릭으로 즉시 삭제하지 않는다 — 삭제는 hover 시 나타나는 × 버튼으로만 한다
        e.preventDefault()
      }}
      style={{ paddingLeft: 10 + depth * 14 }}
      className={cn(
        'group flex w-full items-center gap-2 rounded-[8px] py-1 pr-1.5 text-left text-[12.5px] text-[var(--text)] hover:bg-black/5',
        over && 'shadow-[inset_0_2px_0_0_var(--accent,#2563eb)]'
      )}
    >
      <LetterFavicon title={link.title || link.url} />
      <span className="min-w-0 flex-1 truncate">{link.title || link.url}</span>
      <span
        role="button"
        tabIndex={-1}
        title={t('bookmark.delete')}
        onClick={onRemove}
        className="hidden h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--text3)] hover:bg-black/10 group-hover:flex"
      >
        <X className="h-3 w-3" />
      </span>
    </button>
  )
}

function FolderRow({
  folder,
  depth,
  parentId,
  siblingIds
}: {
  folder: BookmarkFolderDto
  depth: number
  // 이 폴더의 부모와 그 부모 안 폴더 id 순서 — 폴더를 "이 폴더 앞" 에 놓을 때 쓴다
  parentId: number | null
  siblingIds: number[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const expanded = useBookmarkStore((s) => s.expanded.has(folder.id))
  const toggle = useBookmarkStore((s) => s.toggle)
  const removeFolder = useBookmarkStore((s) => s.removeFolder)
  const place = useBookmarkStore((s) => s.place)
  const isEmpty = folder.folders.length === 0 && folder.links.length === 0
  const hasChildren = folder.folders.length > 0 || folder.links.length > 0
  const [over, setOver] = useState<DropSpot>(null)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteTimeoutId, setDeleteTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null)

  const handleDeleteClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!hasChildren) {
      // 하위 항목이 없으면 바로 삭제
      void removeFolder(folder.id)
    } else {
      // 하위 항목이 있으면 2단계 확인
      setConfirmDelete(true)
      // 2초 후 자동 취소
      if (deleteTimeoutId) clearTimeout(deleteTimeoutId)
      const timeoutId = setTimeout(() => {
        setConfirmDelete(false)
        setDeleteTimeoutId(null)
      }, 2000)
      setDeleteTimeoutId(timeoutId)
    }
  }

  const handleConfirmDelete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (deleteTimeoutId) clearTimeout(deleteTimeoutId)
    setConfirmDelete(false)
    setDeleteTimeoutId(null)
    void removeFolder(folder.id)
  }

  const handleCancelDelete = (): void => {
    if (deleteTimeoutId) clearTimeout(deleteTimeoutId)
    setConfirmDelete(false)
    setDeleteTimeoutId(null)
  }

  // 폴더 행의 위쪽 1/3 은 "이 폴더 앞", 나머지는 "이 폴더 안"
  const spotOf = (e: React.DragEvent): DropSpot => {
    const rect = e.currentTarget.getBoundingClientRect()
    return e.clientY - rect.top < rect.height / 3 ? 'before' : 'into'
  }

  const onDrop = (e: React.DragEvent): void => {
    const spot = over
    setOver(null)
    const p = readPayload(e)
    if (!p) return
    e.preventDefault()
    e.stopPropagation()
    if (p.kind === 'folder' && p.id === folder.id) return
    if (p.kind === 'folder' && spot === 'before') {
      void place(p.id, 'folder', parentId, insertIndexBefore(siblingIds, p.id, folder.id))
      return
    }
    // 링크는 폴더 안으로만 들어간다(폴더 앞에 끼울 자리가 없다). 자손 폴더로의 이동은 저장소가 거부한다
    void place(p.id, p.kind, folder.id, AT_END)
  }

  return (
    <div>
      <button
        type="button"
        draggable={!folder.isToolbar}
        onDragStart={(e) => startDrag(e, { id: folder.id, kind: 'folder' })}
        onDragOver={(e) => {
          if (allowDrop(e)) setOver(spotOf(e))
        }}
        onDragLeave={() => setOver(null)}
        onDrop={onDrop}
        onClick={() => toggle(folder.id)}
        style={{ paddingLeft: 10 + depth * 14 }}
        title={over === 'into' ? t('bookmark.dropInto', { name: folder.name }) : undefined}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-[8px] py-1 pr-1.5 text-left text-[12.5px] font-medium text-[var(--text2)] hover:bg-black/5',
          over === 'before' && 'shadow-[inset_0_2px_0_0_var(--accent,#2563eb)]',
          over === 'into' && 'bg-[var(--accent,#2563eb)]/10'
        )}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-[var(--text3)] transition-transform',
            expanded && 'rotate-90'
          )}
        />
        <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--text3)]" />
        <span className="min-w-0 flex-1 truncate">
          {folder.isToolbar ? t('bookmark.toolbar') : folder.name}
        </span>
        {confirmDelete ? (
          <span
            role="button"
            tabIndex={-1}
            title={t('bookmark.delete')}
            onClick={handleConfirmDelete}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500/20 text-[11px] font-bold text-red-600 hover:bg-red-500/30"
          >
            ○
          </span>
        ) : (
          <span
            role="button"
            tabIndex={-1}
            title={t('bookmark.deleteFolder')}
            onClick={handleDeleteClick}
            className="hidden h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--text3)] hover:bg-black/10 group-hover:flex"
          >
            <X className="h-3 w-3" />
          </span>
        )}
      </button>
      {confirmDelete && (
        <div className="px-2.5 py-1 text-[11px] text-[var(--text3)]">
          <span className="inline-block mr-1.5">{t('bookmark.delete')}?</span>
          <button
            type="button"
            onClick={handleCancelDelete}
            className="text-[11px] font-medium text-[var(--text3)] hover:text-[var(--text)] hover:underline"
          >
            {t('confirm.deny')}
          </button>
        </div>
      )}
      {expanded && (
        <div>
          {isEmpty && (
            <div
              style={{ paddingLeft: 10 + (depth + 1) * 14 }}
              className="py-1 text-[11.5px] text-[var(--text3)]"
            >
              {t('bookmark.empty')}
            </div>
          )}
          {folder.folders.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              depth={depth + 1}
              parentId={folder.id}
              siblingIds={folder.folders.map((x) => x.id)}
            />
          ))}
          {folder.links.map((l) => (
            <LinkRow
              key={l.id}
              link={l}
              depth={depth + 1}
              parentId={folder.id}
              siblingIds={folder.links.map((x) => x.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// 사이드바 메뉴 아래 "북마크" 섹션. 폴더는 접기/펼치기, 링크는 클릭 시 활성 탭에서 열고
// 브라우저 뷰로 전환한다. 행을 끌어 순서를 바꾸거나 다른 폴더로 옮길 수 있다.
// 섹션 자체가 스크롤되므로 사이드바 푸터(설정)는 항상 보인다
export function BookmarkTree(): React.JSX.Element {
  const { t } = useTranslation()
  const tree = useBookmarkStore((s) => s.tree)
  const loading = useBookmarkStore((s) => s.loading)
  const load = useBookmarkStore((s) => s.load)
  const setView = useUiStore((s) => s.setView)
  // 섹션 헤더로 접었으면 목록을 그리지 않는다(상태는 설정에 영속)
  const open = useUiStore((s) => isSectionOpen(s.sidebarSections, 'bookmarks'))

  useEffect(() => {
    void load()
  }, [load])

  const isEmpty = !tree || (tree.folders.length === 0 && tree.links.length === 0)
  // 북마크 바(isToolbar) 폴더는 "북마크" 섹션 바로 아래 한 겹 더 접혀 보여 이중 구조가 된다 —
  // 그 폴더의 내용은 최상위로 펼치고(폴더 행 생략), 나머지 최상위 폴더는 그 뒤에 둔다.
  // 끌어 놓기 자리 계산을 위해 각 행이 실제로 속한 부모(북마크바 폴더 또는 최상위)를 같이 넘긴다
  const toolbar = tree?.folders.find((f) => f.isToolbar) ?? null
  const rootFolders = tree?.folders.filter((f) => !f.isToolbar) ?? []
  const toolbarFolderIds = toolbar?.folders.map((f) => f.id) ?? []
  const rootFolderIds = tree?.folders.map((f) => f.id) ?? []
  const toolbarLinkIds = toolbar?.links.map((l) => l.id) ?? []
  const rootLinkIds = tree?.links.map((l) => l.id) ?? []

  return (
    <div className={cn('flex flex-col', open && 'min-h-0 flex-1')}>
      <SectionHeader
        sectionKey="bookmarks"
        label={t('bookmark.title')}
        action={
          <button
            type="button"
            onClick={() => setView('bookmarks')}
            className="shrink-0 text-[11px] font-medium text-[var(--text3)] hover:text-[var(--text)] hover:underline"
          >
            {t('bookmark.manage')}
          </button>
        }
      />
      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          {!loading && isEmpty && (
            <div className="px-2.5 py-2 text-[12px] text-[var(--text3)]">
              {t('bookmark.emptyAll')}
            </div>
          )}
          {(toolbar?.folders ?? []).map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              depth={0}
              parentId={toolbar?.id ?? null}
              siblingIds={toolbarFolderIds}
            />
          ))}
          {rootFolders.map((f) => (
            <FolderRow key={f.id} folder={f} depth={0} parentId={null} siblingIds={rootFolderIds} />
          ))}
          {(toolbar?.links ?? []).map((l) => (
            <LinkRow
              key={l.id}
              link={l}
              depth={0}
              parentId={toolbar?.id ?? null}
              siblingIds={toolbarLinkIds}
            />
          ))}
          {(tree?.links ?? []).map((l) => (
            <LinkRow key={l.id} link={l} depth={0} parentId={null} siblingIds={rootLinkIds} />
          ))}
        </div>
      )}
    </div>
  )
}
