// 북마크 트리 순수 계산 — 폴더 고르기 목록·링크의 현재 폴더·끌어 옮기기 자리.
// 주소창 별 팝오버와 사이드바 북마크 트리가 같이 쓴다(DOM 없음, 테스트 가능)

import type { BookmarkFolderDto, BookmarkTreeDto } from '@shared/ipc'

export interface FolderOption {
  // null 은 최상위(폴더 없음 — 크롬의 '기타 북마크')
  id: number | null
  label: string
  depth: number
}

/** 폴더 고르기 목록 — 최상위를 먼저 두고, 전체 폴더를 깊이 우선으로 평탄화한다 */
export function folderOptions(
  tree: BookmarkTreeDto,
  labels: { root: string; toolbar: string }
): FolderOption[] {
  const walk = (folders: BookmarkFolderDto[], depth: number): FolderOption[] =>
    folders.flatMap((f) => [
      { id: f.id, label: f.isToolbar ? labels.toolbar : f.name, depth },
      ...walk(f.folders, depth + 1)
    ])
  return [{ id: null, label: labels.root, depth: 0 }, ...walk(tree.folders, 0)]
}

export interface BookmarkEntry {
  id: number
  title: string
  folderId: number | null
}

/** 트리에서 같은 주소의 링크와 그 링크가 든 폴더(최상위 → 폴더 깊이 순). 없으면 null */
export function findBookmarkEntry(tree: BookmarkTreeDto, url: string): BookmarkEntry | null {
  const hit = tree.links.find((l) => l.url === url)
  if (hit) return { id: hit.id, title: hit.title, folderId: null }
  const walk = (folders: BookmarkFolderDto[]): BookmarkEntry | null => {
    for (const f of folders) {
      const link = f.links.find((l) => l.url === url)
      if (link) return { id: link.id, title: link.title, folderId: f.id }
      const deep = walk(f.folders)
      if (deep !== null) return deep
    }
    return null
  }
  return walk(tree.folders)
}

/**
 * 끌어 옮기기에서 "targetId 항목 앞에 놓기"의 자리 번호.
 * 저장소(placeLink/placeFolder)는 끌던 항목을 뺀 목록에 끼워 넣으므로, 같은 목록 안에서
 * 끌던 항목이 대상보다 앞에 있었으면 한 칸 당긴다. 대상이 목록에 없으면 끝
 */
export function insertIndexBefore(
  siblingIds: readonly number[],
  draggedId: number,
  targetId: number
): number {
  const rest = siblingIds.filter((id) => id !== draggedId)
  const at = rest.indexOf(targetId)
  return at < 0 ? rest.length : at
}
