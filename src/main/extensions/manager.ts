// 확장 관리 — 압축 해제된 크롬 확장 폴더만 다룬다.
// CRX 설치·웹스토어 연동은 하지 않으며, 로드한 폴더 경로는 설정(extensionPaths)에
// 기기 로컬로만 저장한다(동기화 대상 아님).
//
// 세션(파티션)마다 확장을 따로 걸어야 하므로, 이 관리자는 "호스트" 목록을 들고 있다.
// 첫 호스트는 기본 세션이고, 작업공간 전환으로 새 파티션 세션이 생기면 attachHost 로 붙인다.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Settings } from '../../shared/settings'
import type { ExtensionDto, ExtensionError, ExtensionSource } from '../../shared/extensions'
import { pickIconPath, readIconDataUrl, resolveExtensionName } from './import-sources'
import { resolveActionIconPath, resolveOptionsPath, resolvePopupPath } from './action'
import { tr } from '../i18n'

export type { ExtensionDto, ExtensionError, ExtensionSource }

/** 세션이 돌려주는 확장 정보(테스트에서 흉내내기 쉽도록 최소한만) */
export interface LoadedExtension {
  id: string
  name?: string
  version?: string
}

/** electron 세션 경계. 테스트는 이 인터페이스의 가짜 구현만 쓴다 */
export interface ExtensionHost {
  loadExtension: (path: string) => Promise<LoadedExtension>
  removeExtension: (id: string) => void
}

/** SettingsStore 중 이 관리자가 쓰는 부분만 */
export interface SettingsWriter {
  get: () => Settings
  set: (patch: Partial<Settings>) => Settings
}

/** manifest.json 에서 실제로 쓰는 값만 뽑은 것 */
export interface ExtensionManifest {
  name: string
  version: string
  manifestVersion: 2 | 3
  /** 카드 설명(없으면 빈 문자열) */
  description: string
  /** permissions + host_permissions 를 합친 것. 세부정보의 권한 요약에 쓴다 */
  permissions: string[]
  /** manifest icons 중 가장 큰 것의 상대 경로(없으면 null) */
  iconPath: string | null
  /** 툴바에 그릴 아이콘 — action.default_icon 우선, 없으면 iconPath 와 같다 */
  actionIconPath: string | null
  /** 아이콘을 눌렀을 때 띄울 팝업 문서(없으면 null) */
  popupPath: string | null
  /** 팝업이 없을 때 새 탭으로 여는 옵션 페이지(없으면 null) */
  optionsPath: string | null
  /** `__MSG_…__` 를 풀 때 쓰는 default_locale */
  defaultLocale?: string
}

/** manifest 의 문자열 배열 필드를 안전하게 읽는다(형식이 틀리면 빈 배열) */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 지원하는 manifest 버전 — MV1 은 크로미움이 더 이상 읽지 않는다 */
const SUPPORTED_MANIFEST_VERSIONS = [2, 3]

/**
 * manifest.json 의 내용(파싱된 JSON)을 검증한다.
 * 잘못된 확장을 세션에 넘기기 전에 걸러 내기 위한 순수 함수다
 */
export function parseManifest(raw: unknown): ExtensionManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(tr('ext.manifestInvalid'))
  }
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const version = typeof o.version === 'string' ? o.version.trim() : ''
  const manifestVersion = typeof o.manifest_version === 'number' ? o.manifest_version : 0
  if (!name) throw new Error(tr('ext.manifestNoName'))
  if (!version) throw new Error(tr('ext.manifestNoVersion'))
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifestVersion)) {
    throw new Error(tr('ext.manifestVersionUnsupported'))
  }
  // 권한은 화면에 보여 주기만 하는 값이라, 형식이 틀려도 거부하지 않고 걸러 낸다
  const permissions = [...stringArray(o.permissions), ...stringArray(o.host_permissions)]
  return {
    name,
    version,
    manifestVersion: manifestVersion as 2 | 3,
    description: typeof o.description === 'string' ? o.description.trim() : '',
    permissions,
    iconPath: pickIconPath(o.icons),
    actionIconPath: resolveActionIconPath(o),
    popupPath: resolvePopupPath(o),
    optionsPath: resolveOptionsPath(o),
    defaultLocale: typeof o.default_locale === 'string' ? o.default_locale : undefined
  }
}

/**
 * 확장 폴더 경로를 실제 경로(realpath)로 바꾸고 안전한지 확인한다.
 *
 * ext:load 는 렌더러가 경로 문자열을 줄 수 있으므로, 사용자가 다이얼로그로 고른 경로든
 * 설정에 저장된 경로든 여기를 반드시 지난다. 확인하는 것은 세 가지다.
 * - 실제로 존재하는 디렉터리인가(.crx 파일·없는 경로 거부)
 * - 그 안에 manifest.json 이 있는가
 * - manifest.json 이 심볼릭 링크로 폴더 밖을 가리키지 않는가(링크 이탈 방지)
 *
 * 돌려주는 값은 심볼릭 링크를 모두 푼 절대 경로다 — 세션에는 이 경로만 넘긴다
 *
 * 알려진 한계(2b 재리뷰 New-M1, 기록만): 경로 자체는 디스크 어디든 될 수 있다.
 * 렌더러가 임의 절대 경로(예: 사용자 문서 폴더)를 주면 그 폴더가 확장으로 올라간다.
 * 세션에는 allowFileAccess:false 로 넘기고 manifest 링크 이탈도 막지만, "앱이 관리하는
 * 확장 디렉터리 안" 이라는 제한은 아직 없다 — 확장 설치 UX 를 다듬을 때 함께 좁힌다
 */
export function resolveExtensionFolder(folder: string): string {
  if (!folder.trim()) throw new Error(tr('ext.folderPathEmpty'))
  if (!existsSync(folder)) throw new Error(tr('ext.folderNotFound'))
  const resolved = realpathSync(folder)
  if (!statSync(resolved).isDirectory()) {
    throw new Error(tr('ext.selectUnpackedFolder'))
  }
  const manifestPath = join(resolved, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(tr('ext.folderNoManifest'))
  // 링크를 푼 뒤에도 폴더 안이어야 한다 — 밖을 가리키는 manifest 는 받지 않는다
  const realManifest = realpathSync(manifestPath)
  if (
    realManifest !== join(resolved, 'manifest.json') &&
    !realManifest.startsWith(resolved + sep)
  ) {
    throw new Error(tr('ext.manifestOutsideFolder'))
  }
  return resolved
}

/**
 * 폴더가 실제로 존재하는 디렉터리인지, manifest.json 이 읽히는지 확인하고 내용을 돌려준다.
 * 압축 해제된 확장 폴더만 받는다(.crx 파일은 지원하지 않는다)
 */
export function readExtensionFolder(folder: string): ExtensionManifest {
  const resolved = resolveExtensionFolder(folder)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(resolved, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error(tr('ext.manifestUnreadable'))
  }
  return parseManifest(raw)
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * electron 세션이 제공하는 확장 API 의 최소 형태.
 * Electron 39 는 ses.extensions 아래에 있고, 구버전은 세션에 직접 달려 있다
 */
interface SessionExtensionApi {
  loadExtension: (path: string, options: { allowFileAccess: boolean }) => Promise<LoadedExtension>
  removeExtension: (id: string) => void
}

interface SessionLike {
  extensions?: SessionExtensionApi
  loadExtension?: SessionExtensionApi['loadExtension']
  removeExtension?: SessionExtensionApi['removeExtension']
}

/**
 * 실제 electron 세션을 ExtensionHost 로 감싼다.
 * 파일 접근(allowFileAccess)은 열어 주지 않는다 — 확장이 로컬 파일을 읽지 못하게 한다
 */
export function createSessionExtensionHost(session: SessionLike): ExtensionHost {
  const api: SessionExtensionApi | null = session.extensions
    ? session.extensions
    : session.loadExtension && session.removeExtension
      ? { loadExtension: session.loadExtension, removeExtension: session.removeExtension }
      : null
  if (!api) throw new Error(tr('ext.loadUnsupported'))
  return {
    loadExtension: (path: string) => api.loadExtension(path, { allowFileAccess: false }),
    removeExtension: (id: string) => api.removeExtension(id)
  }
}

/**
 * 파티션 이름(persist:ws1-<프로필>)에서 프로필 이름을 뽑는다. 기본 세션(파티션 없음)은 null
 */
export function profileOfPartitionKey(key: string | undefined): string | null {
  if (key === undefined) return null
  return key.replace(/^persist:/, '').replace(/^ws[^-]*-/, '')
}

/**
 * 이 확장을 그 세션에 올리지 말아야 하는가(설정 extensionProfiles).
 * 적혀 있지 않은 확장은 어디든 올린다. 기본 세션과 일반 탭(default)에는 늘 올린다
 */
export function skipsProfile(
  scopes: Record<string, string[]>,
  extensionId: string,
  key: string | undefined
): boolean {
  const allow = scopes[extensionId]
  if (allow === undefined) return false
  const profile = profileOfPartitionKey(key)
  if (profile === null || profile === 'default') return false
  return !allow.some((p) => p.trim().toLowerCase() === profile.toLowerCase())
}

export class ExtensionManager {
  /** 로드에 성공한 확장. 설정에 저장되는 경로 순서와 같다 */
  private entries: ExtensionDto[] = []
  /** 확장을 걸어 둔 세션들. hosts[0] 은 생성자로 받은 기본 세션이다 */
  private hosts: ExtensionHost[] = []
  /** 이미 붙인 파티션 이름. 같은 세션을 두 번 붙여 목록이 불어나는 것을 막는다 */
  private hostKeys = new Set<string>()
  /** 세션별 파티션 이름 — 설정(extensionProfiles)에 따라 그 프로필에 올릴 확장을 고른다 */
  private keyOfHost = new WeakMap<ExtensionHost, string>()
  private skips(host: ExtensionHost, id: string): boolean {
    return skipsProfile(this.settings.get().extensionProfiles, id, this.keyOfHost.get(host))
  }
  private failures: ExtensionError[] = []
  /** 진행 중인 최초 로드. 새 파티션 세션에 확장을 걸기 전에 이것을 기다린다 */
  private ready: Promise<void> = Promise.resolve()

  constructor(
    host: ExtensionHost,
    private readonly settings: SettingsWriter
  ) {
    this.hosts.push(host)
  }

  /** 설정에 저장된 경로·출처·꺼 둔 확장을 현재 목록으로 덮어쓴다 */
  private persist(): void {
    const sources: Record<string, ExtensionSource> = {}
    for (const e of this.entries) sources[e.path] = e.source
    this.settings.set({
      extensionPaths: this.entries.map((e) => e.path),
      extensionSources: sources,
      disabledExtensionIds: this.entries.filter((e) => !e.enabled).map((e) => e.id)
    })
  }

  /** 설정에 적힌 출처를 읽는다. 기록이 없으면(예전 버전에서 넣은 경로) 폴더로 본다 */
  private sourceOf(path: string): ExtensionSource {
    return this.settings.get().extensionSources[path] ?? 'folder'
  }

  /** 지금까지 쌓인 로드 실패 목록(설정 화면에 표시용) */
  errors(): ExtensionError[] {
    return [...this.failures]
  }

  list(): ExtensionDto[] {
    return [...this.entries]
  }

  /**
   * 앱 시작 시 저장된 경로를 순서대로 로드한다.
   * 한 개가 실패해도 나머지는 그대로 로드하고, 실패한 경로는 설정에서 지운다(앱 중단 금지).
   *
   * 끝나기를 기다릴 수 있도록 진행 중인 작업을 ready 에 남긴다 — attachHost 가 이것을
   * 기다리지 않으면, 첫 탭이 만들어질 때 목록이 아직 비어 있어서 그 탭의 파티션 세션에
   * 확장이 하나도 걸리지 않는다(확장이 기본 세션에만 남아 아무 탭에서도 동작하지 않는다)
   */
  loadSaved(): Promise<ExtensionDto[]> {
    const run = this.loadSavedInto()
    this.ready = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async loadSavedInto(): Promise<ExtensionDto[]> {
    const saved = this.settings.get().extensionPaths
    const disabled = new Set(this.settings.get().disabledExtensionIds)
    this.entries = []
    this.failures = []
    const seen = new Set<string>()
    for (const path of saved) {
      if (seen.has(path)) continue
      seen.add(path)
      try {
        const dto = await this.loadInto(this.hosts[0], path, this.sourceOf(path))
        // 확장 id 는 세션에 올려 봐야 알 수 있어서, 꺼 둔 확장도 일단 올린 뒤 바로 걷어낸다.
        // 목록에는 남아 있어야 화면에서 다시 켤 수 있다
        if (disabled.has(dto.id)) {
          dto.enabled = false
          this.removeFromHosts(dto.id)
        }
        this.entries.push(dto)
      } catch (e: unknown) {
        this.failures.push({ path, error: messageOf(e) })
        console.error('확장 로드 실패', path, messageOf(e))
      }
    }
    this.persist()
    return this.list()
  }

  /** 폴더를 검증한 뒤 한 세션에 로드한다. 세션이 돌려준 이름·버전을 우선 쓴다 */
  private async loadInto(
    host: ExtensionHost,
    path: string,
    source: ExtensionSource
  ): Promise<ExtensionDto> {
    // 검증을 통과한 실제 경로만 세션에 넘기고 설정에도 그 경로를 적는다
    const resolved = resolveExtensionFolder(path)
    const manifest = readExtensionFolder(resolved)
    const loaded = await host.loadExtension(resolved)
    return {
      id: loaded.id,
      name: loaded.name?.trim() || manifest.name,
      version: loaded.version?.trim() || manifest.version,
      path: resolved,
      source,
      // 설명도 `__MSG_key__` 일 수 있어 이름과 같은 방식으로 푼다
      description: resolveExtensionName(manifest.description, resolved, manifest.defaultLocale),
      permissions: manifest.permissions,
      enabled: true,
      // 툴바 아이콘은 크롬과 같은 우선순위 — action.default_icon 이 있으면 그것을 쓴다
      icon:
        readIconDataUrl(resolved, manifest.actionIconPath) ??
        readIconDataUrl(resolved, manifest.iconPath),
      ...(manifest.popupPath === null ? {} : { popup: manifest.popupPath }),
      ...(manifest.optionsPath === null ? {} : { optionsPage: manifest.optionsPath })
    }
  }

  /** 확장이 chrome.action.setIcon 으로 바꾼 툴바 아이콘을 목록에 반영한다. 항목이 없으면 false */
  setActionIcon(id: string, dataUrl: string): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry || entry.icon === dataUrl) return false
    entry.icon = dataUrl
    return true
  }

  /** id 로 목록의 한 항목을 찾는다(툴바 액션이 팝업 경로를 읽을 때 쓴다) */
  find(id: string): ExtensionDto | null {
    return this.entries.find((e) => e.id === id) ?? null
  }

  /** 모든 세션에서 확장을 걷어낸다. 한 세션이 실패해도 나머지는 계속 걷어낸다 */
  private removeFromHosts(id: string): void {
    for (const host of this.hosts) {
      try {
        host.removeExtension(id)
      } catch (e: unknown) {
        console.error('확장 제거 실패', messageOf(e))
      }
    }
  }

  /**
   * 확장을 켜거나 끈다. 끄면 세션에서만 걷어내고 목록·경로는 그대로 두므로
   * 다시 켤 때 폴더를 고를 필요가 없다.
   *
   * 켜는 쪽이 실패하면(폴더가 사라졌다 등) 꺼진 상태 그대로 두고 던진다 —
   * 켜졌다고 표시해 놓고 실제로는 안 도는 상태가 더 나쁘기 때문이다
   */
  async setEnabled(id: string, enabled: boolean): Promise<ExtensionDto> {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) throw new Error(tr('ext.notInList'))
    if (entry.enabled === enabled) return { ...entry }
    if (enabled) {
      // 첫 세션이 실패하면 아무것도 바꾸지 않는다
      await this.hosts[0].loadExtension(entry.path)
      for (const host of this.hosts.slice(1)) {
        if (this.skips(host, entry.id)) continue
        try {
          await host.loadExtension(entry.path)
        } catch (e: unknown) {
          this.failures.push({ path: entry.path, error: messageOf(e) })
        }
      }
    } else {
      this.removeFromHosts(id)
    }
    entry.enabled = enabled
    this.persist()
    return { ...entry }
  }

  /**
   * 사용자가 고른 폴더를 로드한다. 이미 있는 경로면 다시 로드하지 않고 기존 항목을 돌려준다.
   * 검증·로드 어느 쪽이든 실패하면 throw 하고 설정은 건드리지 않는다
   */
  async add(path: string, source: ExtensionSource = 'folder'): Promise<ExtensionDto> {
    // 검증·링크 해석을 먼저 한다 — 통과하지 못하면 목록도 설정도 건드리지 않는다
    const resolved = resolveExtensionFolder(path)
    const existing = this.entries.find((e) => e.path === resolved)
    if (existing) return existing
    const dto = await this.loadInto(this.hosts[0], resolved, source)
    this.entries.push(dto)
    this.persist()
    // 다른 파티션 세션에도 같은 확장을 걸어 준다(실패해도 전체를 되돌리지는 않는다)
    for (const host of this.hosts.slice(1)) {
      if (this.skips(host, dto.id)) continue
      try {
        await host.loadExtension(dto.path)
      } catch (e: unknown) {
        this.failures.push({ path: dto.path, error: messageOf(e) })
      }
    }
    return dto
  }

  /**
   * 같은 폴더에 새 버전을 덮어쓰기 전에 쓴다(웹스토어 재설치·가져오기 갱신).
   * 목록에 없으면 아무 일도 하지 않는다
   */
  removeByPath(path: string): void {
    const target = existsSync(path) ? realpathSync(path) : path
    const entry = this.entries.find((e) => e.path === target)
    if (entry) this.remove(entry.id)
  }

  /** 목록·설정·모든 세션에서 확장을 걷어낸다 */
  remove(id: string): void {
    const index = this.entries.findIndex((e) => e.id === id)
    if (index < 0) throw new Error(tr('ext.notInList'))
    const [removed] = this.entries.splice(index, 1)
    // 꺼 둔 확장은 이미 세션에 없으므로 다시 걷어낼 것이 없다
    if (removed.enabled) this.removeFromHosts(id)
    this.persist()
  }

  /**
   * 새로 만들어진 파티션 세션에 지금 목록을 다시 로드한다(작업공간 전환).
   * 실패는 오류 목록에만 남기고 던지지 않는다 — 탭 생성이 확장 때문에 막히면 안 되기 때문이다
   *
   * key(파티션 이름)를 주면 같은 세션을 두 번 붙이지 않는다. 훅을 다시 걸면
   * 이미 있는 파티션에도 소급 호출이 오는데, 그때마다 hosts 가 늘어나면
   * 같은 세션에 확장이 중복 로드되고 제거·재로드도 그 수만큼 돈다
   */
  async attachHost(host: ExtensionHost, key?: string): Promise<void> {
    if (key !== undefined) {
      if (this.hostKeys.has(key)) return
      this.hostKeys.add(key)
      this.keyOfHost.set(host, key)
    }
    this.hosts.push(host)
    // 첫 탭은 앱이 뜨자마자 만들어지므로 저장된 확장을 아직 다 읽지 못했을 수 있다.
    // 여기서 기다리지 않으면 그 탭 세션에는 확장이 하나도 걸리지 않는다
    await this.ready
    for (const entry of this.entries) {
      if (!entry.enabled) continue
      if (this.skips(host, entry.id)) continue
      try {
        await host.loadExtension(entry.path)
      } catch (e: unknown) {
        this.failures.push({ path: entry.path, error: messageOf(e) })
        console.error('확장 재로드 실패', entry.path, messageOf(e))
      }
    }
  }
}
