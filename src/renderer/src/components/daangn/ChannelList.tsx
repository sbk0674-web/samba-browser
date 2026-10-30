import type React from 'react'
import { useTranslation } from 'react-i18next'
import type { DaangnChannelDto } from '@shared/daangn'
import { cn } from '@renderer/lib/utils'
import { useDaangnStore } from '@renderer/stores/daangnStore'
import { accountLabelOf, lastAtLabel, visibleChannels } from '@renderer/components/daangn/daangn-view'
import { Badge } from '@renderer/components/daangn/AccountPanel'

// 가운데 통합 채팅 목록 — 모든 계정의 채팅을 최근순으로 섞어 보인다(카톡처럼)
export function ChannelList(): React.JSX.Element {
  const { t } = useTranslation()
  const accounts = useDaangnStore((s) => s.accounts)
  const channels = useDaangnStore((s) => s.channels)
  const selectedAccountId = useDaangnStore((s) => s.selectedAccountId)
  const unreadOnly = useDaangnStore((s) => s.unreadOnly)
  const setUnreadOnly = useDaangnStore((s) => s.setUnreadOnly)
  const open = useDaangnStore((s) => s.open)
  const openChannel = useDaangnStore((s) => s.openChannel)
  const width = useDaangnStore((s) => s.listWidth)
  const list = visibleChannels({ channels, selectedAccountId, unreadOnly })

  return (
    <div
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-[var(--line)] bg-white"
    >
      <div className="flex gap-1 border-b border-[var(--line)] p-2">
        <Tab active={unreadOnly} onClick={() => setUnreadOnly(true)}>
          {t('daangn.unreadOnly')}
        </Tab>
        <Tab active={!unreadOnly} onClick={() => setUnreadOnly(false)}>
          {t('daangn.allChats')}
        </Tab>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {accounts.length === 0 ? (
          <Empty text={t('daangn.noAccounts')} />
        ) : list.length === 0 ? (
          <Empty text={t('daangn.noChannels')} />
        ) : (
          list.map((c) => (
            <ChannelRow
              key={`${c.accountId}:${c.roomId}`}
              channel={c}
              accountLabel={accountLabelOf(accounts, c.accountId)}
              active={open?.accountId === c.accountId && open.roomId === c.roomId}
              onClick={() => void openChannel(c)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function Tab({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-[28px] rounded-full px-3 text-[12px]',
        active ? 'bg-[var(--text)] text-white' : 'bg-[var(--bg2)] text-[var(--text2)]'
      )}
    >
      {children}
    </button>
  )
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <div className="px-4 py-10 text-center text-[13px] text-[var(--text2)]">{text}</div>
}

function ChannelRow({
  channel,
  accountLabel,
  active,
  onClick
}: {
  channel: DaangnChannelDto
  accountLabel: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-0.5 border-b border-[var(--line)] px-3 py-2.5 text-left',
        active ? 'bg-[#fff4ec]' : 'hover:bg-[var(--bg2)]'
      )}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text)]">
          {channel.peerName}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--text2)]">{lastAtLabel(channel.lastAtText, channel.lastAt)}</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text2)]">
          {channel.lastMessage}
        </span>
        <Badge n={channel.unread} />
      </span>
      <span className="truncate text-[11px] text-[#ff6f0f]">
        {accountLabel}
        {channel.productTitle ? ` · ${channel.productTitle}` : ''}
      </span>
    </button>
  )
}
