// 주소창 별 버튼 — 트리에서 같은 주소 찾기·북마크바 폴더 고르기
import { describe, it, expect } from 'vitest'
import {
  findBookmarkId,
  isBookmarkableUrl,
  toolbarFolderId
} from '../src/renderer/src/components/browser/BookmarkStar'
import {
  findBookmarkEntry,
  folderOptions,
  insertIndexBefore
} from '../src/renderer/src/lib/bookmark-folders'

const tree = {
  links: [{ id: 1, title: 'a', url: 'https://a.com/' }],
  folders: [
    {
      id: 10,
      name: '북마크바',
      isToolbar: true,
      links: [{ id: 2, title: 'b', url: 'https://b.com/' }],
      folders: [
        {
          id: 11,
          name: '쇼핑',
          isToolbar: false,
          links: [{ id: 3, title: 'c', url: 'https://c.com/x' }],
          folders: []
        }
      ]
    }
  ]
}

describe('주소창 북마크 별', () => {
  it('최상위·폴더·하위 폴더에서 같은 주소를 찾는다', () => {
    expect(findBookmarkId(tree, 'https://a.com/')).toBe(1)
    expect(findBookmarkId(tree, 'https://b.com/')).toBe(2)
    expect(findBookmarkId(tree, 'https://c.com/x')).toBe(3)
    expect(findBookmarkId(tree, 'https://none.com/')).toBeNull()
  })
  it('새 북마크는 북마크바 폴더에, 없으면 최상위', () => {
    expect(toolbarFolderId(tree)).toBe(10)
    expect(toolbarFolderId({ links: [], folders: [] })).toBeNull()
  })
  it('웹 주소만 북마크한다', () => {
    expect(isBookmarkableUrl('https://x.com')).toBe(true)
    expect(isBookmarkableUrl('samba://newtab')).toBe(false)
    expect(isBookmarkableUrl(undefined)).toBe(false)
  })
})

describe('북마크 폴더 계산(팝오버·끌어 옮기기)', () => {
  const labels = { root: '기타 북마크', toolbar: '북마크 바' }

  it('폴더 고르기 목록은 최상위 다음 깊이 우선, 북마크바는 고정 이름', () => {
    expect(folderOptions(tree, labels)).toEqual([
      { id: null, label: '기타 북마크', depth: 0 },
      { id: 10, label: '북마크 바', depth: 0 },
      { id: 11, label: '쇼핑', depth: 1 }
    ])
  })

  it('같은 주소의 링크가 든 폴더를 알려 준다', () => {
    expect(findBookmarkEntry(tree, 'https://a.com/')).toEqual({ id: 1, title: 'a', folderId: null })
    expect(findBookmarkEntry(tree, 'https://c.com/x')).toEqual({ id: 3, title: 'c', folderId: 11 })
    expect(findBookmarkEntry(tree, 'https://none.com/')).toBeNull()
  })

  it('대상 앞에 놓는 자리 — 끌던 항목이 앞에 있었으면 한 칸 당긴다', () => {
    const ids = [1, 2, 3, 4]
    expect(insertIndexBefore(ids, 1, 3)).toBe(1) // 1을 3 앞으로: [2,1,3,4]
    expect(insertIndexBefore(ids, 4, 2)).toBe(1) // 4를 2 앞으로: [1,4,2,3]
    expect(insertIndexBefore(ids, 9, 2)).toBe(1) // 다른 폴더에서 온 항목
    expect(insertIndexBefore(ids, 1, 99)).toBe(3) // 대상이 없으면 끝
  })
})
