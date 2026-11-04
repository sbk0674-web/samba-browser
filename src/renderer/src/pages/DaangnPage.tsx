import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@renderer/components/ui/switch'
import { AccountPanel } from '@renderer/components/daangn/AccountPanel'
import { ChannelList } from '@renderer/components/daangn/ChannelList'
import { RoomPane } from '@renderer/components/daangn/RoomPane'
import { ResizeHandle } from '@renderer/components/layout/ResizeHandle'
import { useDaangnStore } from '@renderer/stores/daangnStore'

// 당근 통합 채팅함 — 왼쪽 계정, 가운데 통합 목록, 오른쪽 방(메인의 네이티브 뷰가 올라온다)
export function DaangnPage(): React.JSX.Element {
  const { t } = useTranslation()
  const load = useDaangnStore((s) => s.load)

  // 갱신 구독은 앱 전체에서 한 번(App.tsx) — 다른 화면에서도 알림 클릭이 이 화면으로 오게
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-4 border-b border-[var(--line)] bg-white px-4 py-3">
        <div className="min-w-0 flex-1 [-webkit-app-region:drag]">
          <div className="text-[16px] font-semibold text-[var(--text)]">{t('daangn.title')}</div>
          <div className="text-[12px] text-[var(--text2)]">{t('daangn.subtitle')}</div>
        </div>
        <DaangnToggles />
      </div>
      <div className="flex min-h-0 flex-1">
        <AccountPanel />
        <PanelHandle kind="account" />
        <ChannelList />
        <PanelHandle kind="list" />
        <RoomPane />
      </div>
    </div>
  )
}

// 패널 사이 손잡이 — 끄는 동안은 uiStore.resizing 으로 방 뷰가 접힌다(RoomPane)
function PanelHandle({ kind }: { kind: 'account' | 'list' }): React.JSX.Element {
  const setWidth = useDaangnStore((s) => s.setPanelWidth)
  const save = useDaangnStore((s) => s.savePanelWidths)
  return (
    <ResizeHandle
      side="right"
      getWidth={() =>
        kind === 'account' ? useDaangnStore.getState().accountWidth : useDaangnStore.getState().listWidth
      }
      onWidth={(w) => setWidth(kind, w)}
      onEnd={save}
    />
  )
}

// 기능 켜기·알림 켜기 — 설정에 따로 섹션을 만들지 않고 이 화면 머리글에 둔다
function DaangnToggles(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [notify, setNotify] = useState(true)

  useEffect(() => {
    void window.samba.settings.get().then((r) => {
      if (!r.ok) return
      setEnabled(r.data.daangnEnabled)
      setNotify(r.data.daangnNotify)
    })
  }, [])

  if (enabled === null) return null
  return (
    <div className="flex items-center gap-4 text-[12px] text-[var(--text)]">
      <label className="flex items-center gap-1.5">
        {t('daangn.enabled')}
        <Switch
          checked={enabled}
          onCheckedChange={(v) => {
            setEnabled(v)
            void window.samba.settings.set({ daangnEnabled: v })
          }}
        />
      </label>
      <label className="flex items-center gap-1.5">
        {t('daangn.notify')}
        <Switch
          checked={notify}
          onCheckedChange={(v) => {
            setNotify(v)
            void window.samba.settings.set({ daangnNotify: v })
          }}
        />
      </label>
    </div>
  )
}
