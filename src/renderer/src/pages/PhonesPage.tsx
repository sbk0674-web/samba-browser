import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2 } from 'lucide-react'
import type { Settings } from '@shared/settings'
import type { PhoneDto } from '@shared/phone'
import { moveItem } from '@shared/reorder'
import { PhoneCard } from '@renderer/components/phone/PhoneCard'
import { ToolsInstallCard } from '@renderer/components/phone/ToolsInstallCard'
import { PhoneSettingsPanel } from '@renderer/components/phone/PhoneSettingsPanel'
import { SecondaryButton, TextInput } from '@renderer/components/settings/shared'
import { cn } from '@renderer/lib/utils'
import { usePhoneStore } from '@renderer/stores/phoneStore'

// 폰 화면 — 카드 3장 그리드 + 상단 도구줄(지금 찾기 · 와이파이 주소로 연결 · 설정 열기)
export function PhonesPage(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    list,
    loading,
    warning,
    error,
    authWaiting,
    expandedIds,
    screenModes,
    load,
    refresh,
    subscribe,
    connectWifi,
    pairWifi,
    toggleExpand,
    clearWarning,
    clearError
  } = usePhoneStore()
  const [address, setAddress] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [pairAddress, setPairAddress] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [pairing, setPairing] = useState(false)
  // 도구 설치 여부(카드가 알려 준다). null 은 아직 확인 전이다
  const [toolsInstalled, setToolsInstalled] = useState<boolean | null>(null)
  const onToolsStatus = useCallback(
    (s: { installed: boolean }) => setToolsInstalled(s.installed),
    []
  )
  // 폰 설정은 이 화면 안에서 톱니로 여닫는다(설정 페이지에는 더 이상 폰 섹션이 없다)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)

  // 설정은 처음 한 번 읽어 온다 — 카드 순서(phoneCardOrder)를 그리려면 패널을 열기 전에도 필요하다
  useEffect(() => {
    if (settings) return
    void window.samba.settings.get().then((r) => {
      if (r.ok) setSettings(r.data)
    })
  }, [settings])

  // 낙관적으로 먼저 반영하고, 메인이 정규화한 값으로 덮어쓴다
  const updateSettings = useCallback((patch: Partial<Settings>): void => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    void window.samba.settings.set(patch).then((r) => {
      if (r.ok) setSettings(r.data)
    })
  }, [])

  useEffect(() => {
    void load()
    return subscribe()
  }, [load, subscribe])

  // 카드 순서: 사용자가 정한 순서(시리얼) 먼저, 거기 없는 폰은 스토어 순서(상태순) 그대로 뒤에
  const cardOrder = settings?.phoneCardOrder ?? []
  const ordered = useMemo(() => orderPhones(list, cardOrder), [list, cardOrder])
  const saveOrder = useCallback(
    (next: readonly PhoneDto[]) => updateSettings({ phoneCardOrder: next.map((p) => p.serial) }),
    [updateSettings]
  )
  const movePhone = (from: number, to: number): void => {
    if (from === to || from < 0 || to < 0 || to >= ordered.length) return
    saveOrder(moveItem(ordered, from, to))
  }
  // 끌어 옮기기 — 끌고 있는 카드의 시리얼만 기억하고, 놓은 카드 자리로 옮긴다
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  // 카드 머리글(data-drag-handle)에서 누르기 시작했을 때만 끌기를 켠다 — 카드 전체가 끌리면 폰 화면 위에서
  // 마우스로 끄는 스와이프(스크롤)가 카드 끌기로 가로채진다(실기 2026-10-21)
  const [armed, setArmed] = useState<string | null>(null)
  const onDrop = (targetSerial: string): void => {
    const from = ordered.findIndex((p) => p.serial === dragging)
    const to = ordered.findIndex((p) => p.serial === targetSerial)
    setDragging(null)
    setDragOver(null)
    if (from >= 0 && to >= 0) movePhone(from, to)
  }

  // 폰이 하나도 안 잡히고 도구도 없을 때만 설치 카드를 맨 위로 올린다
  const needsTools = list.length === 0 && toolsInstalled === false

  const onPair = async (): Promise<void> => {
    setPairing(true)
    const r = await pairWifi(pairAddress.trim(), pairCode.trim())
    setPairing(false)
    // 코드는 1회용이다 — 성공하든 실패하든 칸에 남기지 않는다
    setPairCode('')
    if (r === null) return
    if (r.ok) setPairAddress('')
    // 페어링은 됐는데 접속점이 안 뜨면(폰이 알리지 않음) 다음 할 일을 알려 준다
    if (r.ok && r.connected === false) setNotice(t('phone.pairNoConnect'))
    else setNotice(r.ok ? t('phone.pairDone') : t('phone.pairFailed', { message: r.message }))
  }

  const onConnect = async (): Promise<void> => {
    const value = address.trim()
    if (!value) return
    const message = await connectWifi(value)
    if (message !== null) {
      setAddress('')
      setNotice(message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 p-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-[18px] font-semibold tracking-tight text-[var(--text)]">
            {t('phone.title')}
          </h1>
          <p className="text-[12px] text-[var(--text2)]">
            {t('phone.subtitle')}
          </p>
        </header>

        {/* 폰도 안 잡히고 도구도 없으면 이 카드가 첫 화면이다 */}
        {needsTools && <ToolsInstallCard onStatus={onToolsStatus} />}

        {/* 상단 도구줄 */}
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--line)] bg-white p-3">
          <SecondaryButton className="h-[30px]" disabled={loading} onClick={() => void refresh()}>
            {t('phone.findNow')}
          </SecondaryButton>
          <div className="flex min-w-[220px] flex-1 items-center gap-2">
            <TextInput
              value={address}
              onChange={setAddress}
              placeholder={t('phone.wifiPlaceholder')}
              className="h-[30px]"
            />
            <SecondaryButton
              className="h-[30px]"
              disabled={!address.trim()}
              onClick={() => void onConnect()}
            >
              {t('phone.wifiConnect')}
            </SecondaryButton>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            title={
              settingsOpen ? t('phone.settings.settingsClose') : t('phone.settings.settingsOpen')
            }
            aria-expanded={settingsOpen}
            className={cn(
              'flex h-[30px] shrink-0 items-center gap-1.5 rounded-[9px] border px-2.5 text-[12.5px]',
              settingsOpen
                ? 'border-[var(--text)] bg-[var(--text)] font-medium text-white'
                : 'border-[var(--line)] text-[var(--text)] hover:bg-black/5'
            )}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t('phone.settings.settingsOpen')}
          </button>
        </div>

        {/* USB 를 한 번도 꽂지 않은 폰은 페어링 코드로 이 PC 를 등록한다(안드로이드 11+ 무선 디버깅) */}
        <details className="rounded-2xl border border-[var(--line)] bg-white p-3">
          <summary className="cursor-pointer text-[12.5px] font-medium text-[var(--text)]">
            {t('phone.pairTitle')}
          </summary>
          <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text2)]">
            {t('phone.pairHelp')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <TextInput
              value={pairAddress}
              onChange={setPairAddress}
              placeholder={t('phone.pairAddressPlaceholder')}
              className="h-[30px] min-w-[220px] flex-1"
            />
            <TextInput
              value={pairCode}
              onChange={setPairCode}
              placeholder={t('phone.pairCodePlaceholder')}
              className="h-[30px] w-[120px]"
            />
            <SecondaryButton
              className="h-[30px]"
              disabled={pairing || !pairAddress.trim() || !pairCode.trim()}
              onClick={() => void onPair()}
            >
              {t('phone.pairButton')}
            </SecondaryButton>
          </div>
        </details>

        {/* 폰 설정 — 열었을 때만 그린다 */}
        {settingsOpen && settings && (
          <div className="flex flex-col gap-4">
            <PhoneSettingsPanel settings={settings} update={updateSettings} />
          </div>
        )}

        {warning && (
          <Notice text={warning} onClose={clearWarning} closeLabel={t('phone.dismiss')} />
        )}
        {error && <Notice text={error} onClose={clearError} closeLabel={t('phone.dismiss')} />}
        {notice && (
          <Notice text={notice} onClose={() => setNotice(null)} closeLabel={t('phone.dismiss')} />
        )}

        {list.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--line)] p-6 text-center text-[12.5px] text-[var(--text2)]">
            {t('phone.empty')}
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" title={t('phone.dragHint')}>
            {ordered.map((phone, i) => (
              // 카드 머리글을 끌어 자리를 옮긴다(화면·조작 패드 위의 끌기는 폰 스와이프로 간다)
              <div
                key={phone.id}
                draggable={armed === phone.serial}
                onMouseDown={(e) =>
                  setArmed(
                    (e.target as HTMLElement).closest('[data-drag-handle]') ? phone.serial : null
                  )
                }
                onMouseUp={() => setArmed(null)}
                onDragStart={(e) => {
                  setDragging(phone.serial)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', phone.serial)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setDragOver(null)
                  setArmed(null)
                }}
                onDragOver={(e) => {
                  if (!dragging || dragging === phone.serial) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dragOver !== phone.serial) setDragOver(phone.serial)
                }}
                onDragLeave={() => {
                  if (dragOver === phone.serial) setDragOver(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  onDrop(phone.serial)
                }}
                className={cn(
                  'rounded-2xl transition-shadow',
                  dragging === phone.serial && 'opacity-50',
                  dragOver === phone.serial && 'ring-2 ring-[var(--text)]/40'
                )}
              >
                <PhoneCard
                  phone={phone}
                  expanded={expandedIds.includes(phone.id)}
                  highlighted={
                    authWaiting?.waiting === true &&
                    (authWaiting.phoneId === null || authWaiting.phoneId === phone.id)
                  }
                  screenMode={screenModes[phone.serial] ?? null}
                  onToggle={() => toggleExpand(phone.id)}
                  onMove={(dir) => movePhone(i, i + dir)}
                  canMoveBack={i > 0}
                  canMoveForward={i < ordered.length - 1}
                />
              </div>
            ))}
          </div>
        )}

        {!needsTools && <ToolsInstallCard onStatus={onToolsStatus} />}
      </div>
    </div>
  )
}

/** 사용자가 정한 순서(시리얼 목록)대로 앞에 두고, 목록에 없는 폰은 원래 순서로 뒤에 붙인다 */
export function orderPhones(list: readonly PhoneDto[], order: readonly string[]): PhoneDto[] {
  if (order.length === 0) return [...list]
  const rank = new Map(order.map((serial, i) => [serial, i]))
  const known = list.filter((p) => rank.has(p.serial))
  const rest = list.filter((p) => !rank.has(p.serial))
  known.sort((a, b) => (rank.get(a.serial) ?? 0) - (rank.get(b.serial) ?? 0))
  return [...known, ...rest]
}

// 안내 줄 — 메인이 보낸 경고·오류·연결 결과를 같은 모양으로 보여 준다
function Notice({
  text,
  onClose,
  closeLabel
}: {
  text: string
  onClose: () => void
  closeLabel: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-[10px] border border-[var(--line)] bg-white px-3 py-2 text-[12px] text-[var(--text2)]">
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={onClose} className="shrink-0 underline">
        {closeLabel}
      </button>
    </div>
  )
}
