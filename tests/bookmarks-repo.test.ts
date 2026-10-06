import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { bookmarks } from '../src/main/db/schema'
import { BookmarkRepo } from '../src/main/bookmarks/repo'
import { SyncOutbox, createOutboxRecorder } from '../src/main/sync/outbox'

describe('BookmarkRepo', () => {
  let db: Db
  let repo: BookmarkRepo

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    repo = new BookmarkRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('createFolder / createLink', () => {
    it('루트에 폴더를 만들고 트리에서 조회할 수 있다', () => {
      const id = repo.createFolder(null, '새 폴더')
      const tree = repo.tree()
      expect(tree.folders).toHaveLength(1)
      expect(tree.folders[0].id).toBe(id)
      expect(tree.folders[0].name).toBe('새 폴더')
      expect(tree.folders[0].isToolbar).toBe(false)
    })

    it('폴더 안에 링크를 만들 수 있다', () => {
      const folderId = repo.createFolder(null, '폴더')
      const linkId = repo.createLink(folderId, '링크', 'https://example.com')
      const tree = repo.tree()
      expect(tree.folders[0].links).toHaveLength(1)
      expect(tree.folders[0].links[0]).toMatchObject({
        id: linkId,
        title: '링크',
        url: 'https://example.com'
      })
    })

    it('같은 부모 아래 새로 만든 폴더/링크는 순서대로 뒤에 추가된다', () => {
      repo.createFolder(null, 'A')
      repo.createFolder(null, 'B')
      const tree = repo.tree()
      expect(tree.folders.map((f) => f.name)).toEqual(['A', 'B'])
    })
  })

  describe('rename', () => {
    it('폴더 이름을 바꿀 수 있다', () => {
      const id = repo.createFolder(null, '이전 이름')
      repo.renameFolder(id, '새 이름')
      expect(repo.tree().folders[0].name).toBe('새 이름')
    })

    it('링크 제목을 바꿀 수 있다', () => {
      const id = repo.createLink(null, '이전 제목', 'https://example.com')
      repo.renameLink(id, '새 제목')
      expect(repo.tree().links[0].title).toBe('새 제목')
    })
  })

  describe('move', () => {
    it('폴더를 다른 폴더 아래로 이동할 수 있다', () => {
      const a = repo.createFolder(null, 'A')
      const b = repo.createFolder(null, 'B')
      repo.moveFolder(b, a)
      const tree = repo.tree()
      expect(tree.folders).toHaveLength(1)
      expect(tree.folders[0].folders).toHaveLength(1)
      expect(tree.folders[0].folders[0].name).toBe('B')
    })

    it('링크를 다른 폴더로 이동할 수 있다', () => {
      const folderId = repo.createFolder(null, '폴더')
      const linkId = repo.createLink(null, '링크', 'https://example.com')
      repo.moveLink(linkId, folderId)
      const tree = repo.tree()
      expect(tree.links).toHaveLength(0)
      expect(tree.folders[0].links).toHaveLength(1)
    })

    it('폴더를 루트(null)로 이동할 수 있다', () => {
      const parent = repo.createFolder(null, '부모')
      const child = repo.createFolder(parent, '자식')
      repo.moveFolder(child, null)
      const tree = repo.tree()
      expect(tree.folders.map((f) => f.name).sort()).toEqual(['부모', '자식'])
    })

    it('폴더를 자기 자신 아래로 이동하려 하면 거부한다', () => {
      const a = repo.createFolder(null, 'A')
      expect(() => repo.moveFolder(a, a)).toThrow(
        'cannot move folder into itself or its descendant'
      )
    })

    it('폴더를 자신의 자손 아래로 이동하려 하면 거부한다', () => {
      const parent = repo.createFolder(null, '부모')
      const child = repo.createFolder(parent, '자식')
      const grandchild = repo.createFolder(child, '손주')
      expect(() => repo.moveFolder(parent, grandchild)).toThrow(
        'cannot move folder into itself or its descendant'
      )
      expect(() => repo.moveFolder(parent, child)).toThrow(
        'cannot move folder into itself or its descendant'
      )
    })
  })

  describe('removeFolder (cascade)', () => {
    it('폴더를 지우면 하위 폴더·링크가 모두 함께 지워진다', () => {
      const parent = repo.createFolder(null, '부모')
      const child = repo.createFolder(parent, '자식')
      repo.createLink(parent, '부모 링크', 'https://a.example.com')
      repo.createLink(child, '자식 링크', 'https://b.example.com')

      repo.removeFolder(parent)

      const tree = repo.tree()
      expect(tree.folders).toHaveLength(0)
      expect(tree.links).toHaveLength(0)
    })

    it('형제 폴더는 영향을 받지 않는다', () => {
      const a = repo.createFolder(null, 'A')
      const b = repo.createFolder(null, 'B')
      repo.removeFolder(a)
      const tree = repo.tree()
      expect(tree.folders).toHaveLength(1)
      expect(tree.folders[0].id).toBe(b)
    })

    it('하위 링크마다 삭제 표식을 변경 로그에 남긴다', () => {
      // 기록이 없으면 다른 PC 가 다음 풀에서 같은 북마크를 되살린다(좀비 북마크)
      const outbox = new SyncOutbox(db)
      repo.setOutboxRecorder(createOutboxRecorder(db, outbox))
      const parent = repo.createFolder(null, '부모')
      const child = repo.createFolder(parent, '자식')
      const parentLink = repo.createLink(parent, '부모 링크', 'https://a.example.com')
      const childLink = repo.createLink(child, '자식 링크', 'https://b.example.com')

      repo.removeFolder(parent)

      const deletes = outbox.pendingFor('bookmarks').filter((r) => r.op === 'delete')
      expect(deletes.map((r) => r.rowId).sort()).toEqual(
        [String(parentLink), String(childLink)].sort()
      )
      // 삭제 표식을 원격에 올리려면 url 같은 NOT NULL 컬럼이 payload 에 들어 있어야 한다
      for (const row of deletes) {
        expect(row.payload).toBeTruthy()
        expect(JSON.parse(row.payload!)).toMatchObject({ url: expect.any(String) })
      }
    })

    it('삭제가 실패하면 삭제 표식도 남지 않는다', () => {
      // New-M2 — 기록이 트랜잭션 밖에 있으면 "지우지도 않았는데 표식만 올라가"
      // 다른 PC 의 북마크가 사라진다
      const outbox = new SyncOutbox(db)
      repo.setOutboxRecorder(createOutboxRecorder(db, outbox))
      const folder = repo.createFolder(null, '부모')
      repo.createLink(folder, '링크', 'https://a.example.com')

      const original = db.drizzle.delete.bind(db.drizzle)
      const spy = vi
        .spyOn(db.drizzle, 'delete')
        .mockImplementation((table: Parameters<typeof original>[0]) => {
          if (table === bookmarks) throw new Error('삭제 실패')
          return original(table)
        })
      expect(() => repo.removeFolder(folder)).toThrow('삭제 실패')
      spy.mockRestore()

      expect(outbox.pendingFor('bookmarks').filter((r) => r.op === 'delete')).toHaveLength(0)
      // 폴더·링크도 그대로 남아 있다(전부 되돌아갔다)
      expect(repo.tree().folders).toHaveLength(1)
      expect(repo.tree().folders[0].links).toHaveLength(1)
    })
  })

  describe('sortFolder', () => {
    it('폴더 안의 링크를 제목 오름차순으로 정렬한다', () => {
      const folderId = repo.createFolder(null, '폴더')
      repo.createLink(folderId, '다', 'https://c.example.com')
      repo.createLink(folderId, '가', 'https://a.example.com')
      repo.createLink(folderId, '나', 'https://b.example.com')

      repo.sortFolder(folderId)

      const tree = repo.tree()
      expect(tree.folders[0].links.map((l) => l.title)).toEqual(['가', '나', '다'])
    })

    it('루트(null) 폴더도 정렬할 수 있다', () => {
      repo.createFolder(null, '다')
      repo.createFolder(null, '가')
      repo.createFolder(null, '나')

      repo.sortFolder(null)

      const tree = repo.tree()
      expect(tree.folders.map((f) => f.name)).toEqual(['가', '나', '다'])
    })
  })

  describe('placeLink / placeFolder (끌어 옮기기)', () => {
    it('같은 폴더 안에서 링크 순서를 바꾼다', () => {
      const a = repo.createLink(null, 'A', 'https://a.example.com')
      repo.createLink(null, 'B', 'https://b.example.com')
      repo.createLink(null, 'C', 'https://c.example.com')
      repo.placeLink(a, null, 2)
      expect(repo.tree().links.map((l) => l.title)).toEqual(['B', 'C', 'A'])
    })

    it('다른 폴더의 지정한 자리로 옮기고 양쪽 position 을 다시 매긴다', () => {
      const folder = repo.createFolder(null, '폴더')
      const a = repo.createLink(null, 'A', 'https://a.example.com')
      repo.createLink(null, 'B', 'https://b.example.com')
      repo.createLink(folder, 'X', 'https://x.example.com')
      repo.createLink(folder, 'Y', 'https://y.example.com')
      repo.placeLink(a, folder, 1)
      const tree = repo.tree()
      expect(tree.links.map((l) => l.title)).toEqual(['B'])
      expect(tree.folders[0].links.map((l) => l.title)).toEqual(['X', 'A', 'Y'])
      // 남은 쪽도 0부터 이어진다 — 다음에 만드는 링크가 끝에 붙는다
      repo.createLink(null, 'C', 'https://c.example.com')
      expect(repo.tree().links.map((l) => l.title)).toEqual(['B', 'C'])
    })

    it('범위를 벗어난 자리는 끝으로 간다', () => {
      const a = repo.createLink(null, 'A', 'https://a.example.com')
      repo.createLink(null, 'B', 'https://b.example.com')
      repo.placeLink(a, null, 99)
      expect(repo.tree().links.map((l) => l.title)).toEqual(['B', 'A'])
    })

    it('폴더도 자리를 지정해 옮긴다', () => {
      const a = repo.createFolder(null, 'A')
      const b = repo.createFolder(null, 'B')
      repo.createFolder(null, 'C')
      repo.placeFolder(b, null, 0)
      expect(repo.tree().folders.map((f) => f.name)).toEqual(['B', 'A', 'C'])
      repo.placeFolder(a, b, 0)
      expect(repo.tree().folders.map((f) => f.name)).toEqual(['B', 'C'])
      expect(repo.tree().folders[0].folders.map((f) => f.name)).toEqual(['A'])
    })

    it('폴더를 자기 자손 아래로는 못 옮긴다', () => {
      const a = repo.createFolder(null, 'A')
      const b = repo.createFolder(a, 'B')
      expect(() => repo.placeFolder(a, b, 0)).toThrow()
    })
  })

  describe('remove (링크)', () => {
    it('링크 하나를 지울 수 있다', () => {
      const id = repo.createLink(null, '링크', 'https://example.com')
      repo.remove(id)
      expect(repo.tree().links).toHaveLength(0)
    })
  })
})
