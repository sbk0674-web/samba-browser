import { create } from 'zustand'
import type { BookmarkTreeDto } from '@shared/ipc'

interface BookmarkState {
  tree: BookmarkTreeDto | null
  // 펼쳐진 폴더 id 집합. 툴바 폴더는 기본 펼침 상태로 시작한다(load 에서 채움)
  expanded: Set<number>
  loading: boolean
  load: () => Promise<void>
  remove: (id: number) => Promise<void>
  toggle: (id: number) => void
  // --- 북마크 관리자 페이지용(전부 성공 시 load() 로 트리를 새로고침한다) ---
  createFolder: (parentId: number | null, name: string) => Promise<void>
  createLink: (folderId: number | null, title: string, url: string) => Promise<void>
  rename: (id: number, kind: 'folder' | 'link', name: string) => Promise<void>
  move: (id: number, kind: 'folder' | 'link', toFolderId: number | null) => Promise<void>
  // 끌어 옮기기 — 폴더 안 자리까지 지정한다
  place: (
    id: number,
    kind: 'folder' | 'link',
    toFolderId: number | null,
    toIndex: number
  ) => Promise<void>
  removeFolder: (id: number) => Promise<void>
  sort: (folderId: number | null) => Promise<void>
  exportBookmarks: () => Promise<string | undefined>
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  tree: null,
  expanded: new Set(),
  loading: false,

  load: async () => {
    set({ loading: true })
    const r = await window.samba.bookmarks.tree()
    if (r.ok) {
      set((s) => {
        // 이미 펼친 적 있는 폴더 상태는 유지하고, 첫 로드 시 툴바 폴더만 기본으로 펼친다
        const expanded = s.expanded.size > 0 ? s.expanded : new Set<number>()
        if (expanded.size === 0) {
          for (const f of r.data.folders) if (f.isToolbar) expanded.add(f.id)
        }
        return { tree: r.data, expanded, loading: false }
      })
    } else {
      set({ loading: false })
    }
  },

  remove: async (id) => {
    const r = await window.samba.bookmarks.remove(id)
    if (r.ok) await get().load()
  },

  toggle: (id) => {
    set((s) => {
      const next = new Set(s.expanded)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { expanded: next }
    })
  },

  createFolder: async (parentId, name) => {
    const r = await window.samba.bookmarks.createFolder(parentId, name)
    if (r.ok) await get().load()
  },
  createLink: async (folderId, title, url) => {
    const r = await window.samba.bookmarks.createLink(folderId, title, url)
    if (r.ok) await get().load()
  },
  rename: async (id, kind, name) => {
    const r = await window.samba.bookmarks.rename(id, kind, name)
    if (r.ok) await get().load()
  },
  move: async (id, kind, toFolderId) => {
    const r = await window.samba.bookmarks.move({ id, kind, toFolderId })
    if (r.ok) await get().load()
  },
  place: async (id, kind, toFolderId, toIndex) => {
    const r = await window.samba.bookmarks.place({ id, kind, toFolderId, toIndex })
    if (r.ok) await get().load()
  },
  removeFolder: async (id) => {
    const r = await window.samba.bookmarks.removeFolder(id)
    if (r.ok) await get().load()
  },
  sort: async (folderId) => {
    const r = await window.samba.bookmarks.sort(folderId)
    if (r.ok) await get().load()
  },
  exportBookmarks: async () => {
    const r = await window.samba.bookmarks.export()
    return r.ok ? r.data : undefined
  }
}))
