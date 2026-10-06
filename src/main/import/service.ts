// 가져오기 서비스 — 비밀번호 CSV/북마크 HTML 파일을 읽어 DB 에 반영한다.
// 비밀값(비밀번호) · 행 원문은 처리 즉시 참조를 해제하고, 어떤 로그에도 남기지 않는다.

import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import type { Db } from '../db/client'
import type { VaultService } from '../vault/service'
import { BookmarkRepo } from '../bookmarks/repo'
import { parsePasswordCsv } from './passwords-csv'
import { parseNetscapeBookmarks } from './bookmarks-html'
import { toNetscapeHtml } from './bookmarks-export'
import { normalizeHost } from '../../shared/host'
import { correctLoginUrl } from '../../shared/site-rules'
import type { ImportPasswordsResult, ImportBookmarksResult } from '../../shared/import'
import type { OutboxRecorder, WorkspaceScope } from '../../shared/sync'

// dialog.showOpenDialog/showSaveDialog 를 감싼 최소 인터페이스 — 테스트에서 파일 선택을 흉내낼 수 있게 주입한다.
// 취소되면 undefined 를 반환한다
export interface ImportDialogs {
  showOpenDialog(filters: { name: string; extensions: string[] }[]): Promise<string | undefined>
  // 내보내기는 파일 선택 다이얼로그를 안 쓰는 흐름(예: 테스트)에서는 생략 가능
  showSaveDialog?(
    filters: { name: string; extensions: string[] }[],
    defaultPath?: string
  ): Promise<string | undefined>
}

export interface ImportServiceOptions {
  // 기본은 fs/promises readFile(utf8). 테스트에서 합성 CSV/HTML 문자열을 주입할 때 사용
  readFile?: (filePath: string) => Promise<string>
  // 기본은 fs/promises writeFile(utf8). 테스트에서 실제 파일 쓰기를 피할 때 사용
  writeFile?: (filePath: string, content: string) => Promise<void>
}

const CSV_FILTERS = [{ name: 'CSV', extensions: ['csv'] }]
const HTML_FILTERS = [{ name: 'HTML', extensions: ['html', 'htm'] }]
const EXPORT_DEFAULT_FILENAME = 'bookmarks.html'
const BOM = '﻿'

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text
}

/** 빈 값을 걸러 내고 순서를 유지한 채 중복을 없앤 URL 목록 */
function uniqueUrls(urls: (string | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const url of urls) {
    if (url) seen.add(url)
  }
  return Array.from(seen)
}

export class ImportService {
  private readonly bookmarkRepo: BookmarkRepo
  private readonly readFileImpl: (filePath: string) => Promise<string>
  private readonly writeFileImpl: (filePath: string, content: string) => Promise<void>

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly dialogs: ImportDialogs,
    options: ImportServiceOptions = {}
  ) {
    this.bookmarkRepo = new BookmarkRepo(db)
    this.readFileImpl = options.readFile ?? ((p) => fsReadFile(p, 'utf8'))
    this.writeFileImpl = options.writeFile ?? ((p, content) => fsWriteFile(p, content, 'utf8'))
  }

  /** 활성 작업공간을 북마크 저장소에 알려 준다(조회 범위 필터 + 새 링크에 붙일 작업공간) */
  /** 북마크 변경 로그 훅을 붙인다(로그인 상태에서만) */
  setOutboxRecorder(recorder: OutboxRecorder | null): void {
    this.bookmarkRepo.setOutboxRecorder(recorder)
  }

  setWorkspaceScope(scope: WorkspaceScope | null): void {
    this.bookmarkRepo.setWorkspaceScope(scope)
  }

  /**
   * 비밀번호 CSV 를 가져온다. 금고가 잠겨 있으면 'locked' 에러를 던진다.
   * (host, username) 조합이 이미 있으면 비밀번호만 갱신하고, 없으면 계정+항목을 새로 만든다.
   */
  async importPasswords(filePath?: string): Promise<ImportPasswordsResult> {
    if (this.vault.state() !== 'unlocked') throw new Error('locked')

    const path = filePath ?? (await this.dialogs.showOpenDialog(CSV_FILTERS))
    if (!path) throw new Error('cancelled')

    // CSV 원문은 파싱 직후 곧바로 참조를 해제한다(비밀번호가 담긴 문자열을 오래 들고 있지 않는다)
    let text: string | undefined = stripBom(await this.readFileImpl(path))
    let parsed: { rows: ReturnType<typeof parsePasswordCsv>['rows']; skipped: number } | undefined =
      parsePasswordCsv(text)
    text = undefined

    const result: ImportPasswordsResult = {
      total: parsed.rows.length,
      added: 0,
      updated: 0,
      skipped: parsed.skipped,
      sites: 0
    }
    const seenHosts = new Set<string>()

    for (const row of parsed.rows) {
      const host = normalizeHost(row.url) || normalizeHost(row.host)
      if (!host) {
        result.skipped += 1
        continue
      }
      seenHosts.add(host)

      const existing = this.vault.listAccounts(host).find((a) => a.username === row.username)

      // CSV 의 URL 은 로그인 페이지가 아닌 경우가 많다(마이페이지·가입폼 등).
      // 알려진 로그인 URL 이 있으면 그쪽으로 바꾸되, 원본 URL 은 urls 배열에 남겨 둔다
      const loginUrl = correctLoginUrl(host, row.url)
      const urls = uniqueUrls([loginUrl, row.url, ...(existing?.urls ?? [])])

      const account = this.vault.upsertAccount({
        id: existing?.id,
        host,
        label: existing?.label ?? row.username,
        username: row.username,
        siteName: row.name || host,
        ...(loginUrl ? { loginUrl } : {}),
        ...(urls.length > 0 ? { urls } : {})
      })

      this.vault.putItem({
        accountId: account.id,
        type: 'login',
        label: '로그인 비밀번호',
        value: row.password
      })

      if (existing) result.updated += 1
      else result.added += 1
    }

    result.sites = seenHosts.size
    // 비밀번호가 담긴 파싱 결과 참조를 더 이상 들고 있지 않는다
    parsed = undefined

    this.vault.logAudit('import', 'user')
    this.db.scheduleSave()
    return result
  }

  /** 북마크 Netscape HTML 을 가져온다. 이미 있는 URL 은 건너뛴다(전체 DB 기준) */
  async importBookmarks(filePath?: string): Promise<ImportBookmarksResult> {
    const path = filePath ?? (await this.dialogs.showOpenDialog(HTML_FILTERS))
    if (!path) throw new Error('cancelled')

    let html: string | undefined = stripBom(await this.readFileImpl(path))
    let tree: ReturnType<typeof parseNetscapeBookmarks> | undefined = parseNetscapeBookmarks(html, {
      dedupeUrls: true
    })
    html = undefined

    const inserted = this.bookmarkRepo.insertTree(tree)
    tree = undefined

    // 감사 로그는 비밀 항목(키마스터) 전용이다 — 북마크는 비밀이 아니므로 기록하지 않는다
    return { folders: inserted.folders, bookmarks: inserted.bookmarks, skipped: inserted.skipped }
  }

  tree(): ReturnType<BookmarkRepo['tree']> {
    return this.bookmarkRepo.tree()
  }

  removeBookmark(id: number): void {
    this.bookmarkRepo.remove(id)
  }

  // --- 북마크 관리자 페이지용 CRUD ------------------------------------------

  createBookmarkFolder(parentId: number | null, name: string): number {
    // 감사 로그는 비밀 항목(키마스터) 전용이다 — 북마크는 비밀이 아니므로 기록하지 않는다
    return this.bookmarkRepo.createFolder(parentId, name)
  }

  createBookmarkLink(folderId: number | null, title: string, url: string): number {
    return this.bookmarkRepo.createLink(folderId, title, url)
  }

  renameBookmark(id: number, kind: 'folder' | 'link', name: string): void {
    if (kind === 'folder') this.bookmarkRepo.renameFolder(id, name)
    else this.bookmarkRepo.renameLink(id, name)
  }

  moveBookmark(id: number, kind: 'folder' | 'link', toFolderId: number | null): void {
    if (kind === 'folder') this.bookmarkRepo.moveFolder(id, toFolderId)
    else this.bookmarkRepo.moveLink(id, toFolderId)
  }

  /** 끌어 옮기기 — 폴더 안 toIndex 자리에 놓는다(같은 폴더면 순서만 바뀐다) */
  placeBookmark(
    id: number,
    kind: 'folder' | 'link',
    toFolderId: number | null,
    toIndex: number
  ): void {
    if (kind === 'folder') this.bookmarkRepo.placeFolder(id, toFolderId, toIndex)
    else this.bookmarkRepo.placeLink(id, toFolderId, toIndex)
  }

  removeBookmarkFolder(id: number): void {
    this.bookmarkRepo.removeFolder(id)
    this.vault.logAudit('delete', 'user')
  }

  sortBookmarkFolder(folderId: number | null): void {
    this.bookmarkRepo.sortFolder(folderId)
  }

  /** 북마크 트리를 Netscape HTML 로 내보낸다. 취소되면 undefined 를 반환한다 */
  async exportBookmarks(): Promise<string | undefined> {
    const tree = this.bookmarkRepo.tree()
    const html = toNetscapeHtml(tree)
    const path = await this.dialogs.showSaveDialog?.(HTML_FILTERS, EXPORT_DEFAULT_FILENAME)
    if (!path) return undefined
    await this.writeFileImpl(path, html)
    this.vault.logAudit('export', 'user')
    return path
  }
}
