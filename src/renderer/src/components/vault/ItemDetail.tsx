import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '@renderer/stores/uiStore'
import { useVaultStore } from '@renderer/stores/vaultStore'
import { usePhoneStore } from '@renderer/stores/phoneStore'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  AGENT_ACCESS_VALUES,
  paymentProviderOfSections,
  payPriorityOf,
  withPayPriority,
  visibleTags
} from '@shared/vault'
import {
  PhoneAssignDialog,
  PhoneAssignSuggestion
} from '@renderer/components/phone/PhoneAssignDialog'
import type { AccountDto, AgentAccess, AuditLogDto, VaultField, VaultItemMeta } from '@shared/ipc'

const USAGE_HISTORY_LIMIT = 10
// '보기' 로 화면에 드러낸 값을 자동으로 다시 가리는 시간(ms)
const REVEAL_AUTO_HIDE_MS = 30_000
// 값을 클립보드에 복사한 뒤 이 시간(ms)이 지나면, 복사 당시와 값이 같을 때만 비운다
const CLIPBOARD_CLEAR_MS = 30_000
// 자동 채우기 결과 안내를 화면에 남겨 두는 시간(ms)
const AUTOFILL_NOTICE_MS = 4000

// 클립보드에 값을 복사하고, 일정 시간 뒤에도 여전히 같은 값이면 비운다.
// readText 가 실패하면(권한 거부 등) 아무 것도 하지 않는다 — 그 사이 사용자가 복사한
// 다른 내용을 우리가 지워버리는 편이 더 나쁜 결과다
async function copyWithAutoClear(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
  setTimeout(() => {
    void navigator.clipboard
      .readText()
      .then((current) => {
        if (current === value) return navigator.clipboard.writeText('')
        return undefined
      })
      .catch(() => {
        // no-op
      })
  }, CLIPBOARD_CLEAR_MS)
}

// autofillAccount 의 결과 문자열 → i18n 키
const AUTOFILL_MESSAGE: Record<string, string> = {
  ok: 'vault.autofill.ok',
  'filled-password-only': 'vault.autofill.ok',
  locked: 'vault.autofill.locked',
  'insecure-page': 'vault.autofill.insecure',
  excluded: 'vault.autofill.excluded',
  'host-mismatch': 'vault.autofill.hostMismatch',
  'fields-not-found': 'vault.autofill.fieldsNotFound'
}

// 비밀값 한 줄. '보기'를 누른 동안만 화면에 표시하고, 토글을 끄거나
// 컴포넌트가 사라지면(계정 전환·잠금 포함) 즉시 지운다
function RevealRow({
  label,
  itemId,
  fieldKey,
  danger
}: {
  label: string
  itemId: number
  fieldKey: string
  danger?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const reveal = useVaultStore((s) => s.reveal)
  const [value, setValue] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => () => setValue(null), [itemId, fieldKey])

  // 드러낸 값은 30초 뒤 자동으로 다시 가린다(자리를 비운 사이 화면에 남지 않게)
  useEffect(() => {
    if (value === null) return
    const timer = setTimeout(() => setValue(null), REVEAL_AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [value])

  const toggle = async (): Promise<void> => {
    if (value !== null) {
      setValue(null)
      return
    }
    setBusy(true)
    const v = await reveal(itemId, fieldKey)
    setBusy(false)
    setValue(v)
  }

  const copy = async (): Promise<void> => {
    const v = value ?? (await reveal(itemId, fieldKey))
    if (v) void copyWithAutoClear(v)
  }

  return (
    <div className="grid grid-cols-[150px_1fr_auto] items-center gap-3 border-b border-black/[.05] px-3.5 py-2.5 last:border-b-0">
      <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--text2)]">
        {label}
        {danger && (
          <span className="rounded-full bg-[rgba(255,59,48,.12)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#ff3b30]">
            {t('vault.detail.dangerBadge')}
          </span>
        )}
      </span>
      <span className="truncate font-mono text-[13px] tracking-[2px] text-[var(--text2)]">
        {value ?? '••••••••••••'}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle()}
          className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
        >
          {value !== null ? t('vault.detail.hide') : t('vault.detail.show')}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          title={t('vault.detail.copyClearHint')}
          className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
        >
          {t('vault.detail.copy')}
        </button>
      </div>
    </div>
  )
}

function PlainRow({
  label,
  value,
  onCopy,
  onOpen,
  onRemove
}: {
  label: string
  value: string
  onCopy?: () => void
  onOpen?: () => void
  onRemove?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-[150px_1fr_auto] items-center gap-3 border-b border-black/[.05] px-3.5 py-2.5 last:border-b-0">
      <span className="text-[12.5px] text-[var(--text2)]">{label}</span>
      <span className="truncate text-[13px]">{value}</span>
      <div className="flex gap-1">
        {onCopy && (
          <button
            type="button"
            onClick={onCopy}
            title={t('vault.detail.copyClearHint')}
            className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
          >
            {t('vault.detail.copy')}
          </button>
        )}
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
          >
            {t('vault.detail.open')}
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
          >
            {t('vault.websites.remove')}
          </button>
        )}
      </div>
    </div>
  )
}

// 항목 하나의 섹션>필드를 그대로 그린다. secret 필드는 RevealRow, 나머지는 PlainRow
function ItemSections({
  item,
  onEdit
}: {
  item: VaultItemMeta
  /** 주면 섹션 제목 옆에 편집 버튼을 둔다 — 계정에 붙은 카드 항목(알리페이 카드)을 화면에서 고치기 위해 */
  onEdit?: (item: VaultItemMeta) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const rowOf = (field: VaultField): React.JSX.Element =>
    field.kind === 'secret' ? (
      <RevealRow key={field.key} label={field.label} itemId={item.id} fieldKey={field.key} />
    ) : (
      <PlainRow
        key={field.key}
        label={field.label}
        value={field.value ?? ''}
        onCopy={field.value ? () => void copyWithAutoClear(field.value as string) : undefined}
      />
    )

  if (item.sections.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-4 text-center text-[12.5px] text-[var(--text3)]">
        {t('vault.detail.noHistory')}
      </div>
    )
  }
  return (
    <>
      {item.sections.map((section, index) => (
        <section key={section.key} className="mb-5">
          <div className="mb-2 flex items-center gap-2">
            <h4 className="text-[12px] font-semibold text-[var(--text2)]">{section.label}</h4>
            {onEdit && index === 0 && (
              <button
                type="button"
                onClick={() => onEdit(item)}
                className="ml-auto h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
              >
                {t('vault.detail.edit')}
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
            {section.fields.map(rowOf)}
          </div>
        </section>
      ))}
    </>
  )
}

// 계정의 Agent access · Website 목록 · 태그를 편집하는 영역
function AccountSettings({ account }: { account: AccountDto }): React.JSX.Element {
  const { t } = useTranslation()
  const upsertAccount = useVaultStore((s) => s.upsertAccount)
  const [newUrl, setNewUrl] = useState('')
  const [newTag, setNewTag] = useState('')

  const patch = (over: { urls?: string[]; tags?: string[]; agentAccess?: AgentAccess }): void => {
    void upsertAccount({
      id: account.id,
      host: account.host,
      username: account.username,
      ...over
    })
  }

  return (
    <>
      <section className="mb-5">
        <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
          {t('vault.agentAccess.label')}
        </h4>
        <select
          value={account.agentAccess}
          onChange={(e) => patch({ agentAccess: e.target.value as AgentAccess })}
          className="h-9 w-full rounded-md border border-[var(--line)] bg-white px-3 text-[13px] outline-none"
        >
          {AGENT_ACCESS_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(`vault.agentAccess.${value}`)}
            </option>
          ))}
        </select>
      </section>

      <section className="mb-5">
        <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
          {t('vault.websites.label')}
        </h4>
        <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
          {account.urls.map((url) => (
            <PlainRow
              key={url}
              label={t('vault.websites.label')}
              value={url}
              onRemove={() => patch({ urls: account.urls.filter((u) => u !== url) })}
            />
          ))}
          <form
            className="flex items-center gap-2 px-3.5 py-2.5"
            onSubmit={(e) => {
              e.preventDefault()
              const url = newUrl.trim()
              if (!url || account.urls.includes(url)) return
              patch({ urls: [...account.urls, url] })
              setNewUrl('')
            }}
          >
            <Input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder={t('vault.websites.placeholder')}
              className="h-8"
            />
            <Button type="submit" variant="outline" size="sm" className="h-8 rounded-[9px]">
              {t('vault.websites.add')}
            </Button>
          </form>
        </div>
      </section>

      <section className="mb-5">
        <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
          {t('vault.payPriority.label')}
        </h4>
        <div className="flex items-center gap-2">
          <select
            aria-label={t('vault.payPriority.label')}
            value={payPriorityOf(account.tags) ?? ''}
            onChange={(e) =>
              patch({
                tags: withPayPriority(account.tags, e.target.value ? Number(e.target.value) : null)
              })
            }
            className="h-8 rounded-[9px] border border-black/10 bg-[var(--bg)] px-2 text-[12.5px]"
          >
            <option value="">{t('vault.payPriority.none')}</option>
            {PAY_PRIORITY_CHOICES.map((n) => (
              <option key={n} value={n}>
                {t('vault.payPriority.rank', { n })}
              </option>
            ))}
          </select>
          <span className="text-[11.5px] text-[var(--text3)]">{t('vault.payPriority.hint')}</span>
        </div>
      </section>

      <section className="mb-5">
        <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
          {t('vault.tags.label')}
        </h4>
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleTags(account.tags).map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => patch({ tags: account.tags.filter((x) => x !== tag) })}
              className="rounded-full bg-[var(--bg)] px-2 py-0.5 text-[11.5px] text-[var(--text2)]"
            >
              {tag} ×
            </button>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const tag = newTag.trim()
              if (!tag || account.tags.includes(tag)) return
              patch({ tags: [...account.tags, tag] })
              setNewTag('')
            }}
          >
            <Input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder={t('vault.tags.placeholder')}
              className="h-7 w-[150px]"
            />
          </form>
        </div>
      </section>
    </>
  )
}

// 결제 우선순위 선택지(1 = 가장 먼저)
const PAY_PRIORITY_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9]

interface Props {
  onEdit: () => void
  // 선택된 계정을 본떠 새 계정을 만든다(사이트·아이디·비밀번호·태그를 채운 에디터를 연다)
  onDuplicate: () => void
  // 전역(계정 없는) 항목 편집. 계정용 onEdit 과 분리해 항상 대상 항목을 명시적으로 넘긴다
  onEditGlobal: (item: VaultItemMeta) => void
  // 선택된 계정에 결제 비밀번호를 새로 추가한다
  onAddPayment: () => void
  // 계정에 딸린 항목 하나를 편집한다(결제 비밀번호처럼 계정당 여러 개인 항목)
  onEditItem: (item: VaultItemMeta) => void
}

// 계정의 결제 비밀번호 목록. 무신사머니·토스페이처럼 결제창마다 비밀번호가 달라
// 계정 하나에 여러 개가 붙는다 — 제공자 라벨과 함께 나열하고 각각 편집·삭제한다
function PaymentSection({
  accountId,
  items,
  onAdd,
  onEdit
}: {
  accountId: number
  items: VaultItemMeta[]
  onAdd: () => void
  onEdit: (item: VaultItemMeta) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const deleteItem = useVaultStore((s) => s.deleteItem)

  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-[12px] font-semibold text-[var(--text2)]">
          {t('vault.detail.paymentSection')}
        </h4>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-[26px] rounded-[9px]"
          onClick={onAdd}
        >
          {t('vault.detail.addPayment')}
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-4 text-center text-[12.5px] text-[var(--text3)]">
          {t('vault.detail.noPayment')}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="overflow-hidden rounded-xl border border-[var(--line)] bg-white"
            >
              <div className="flex items-center gap-2 border-b border-black/[.05] px-3.5 py-2">
                <span className="truncate text-[12.5px] font-medium">{item.label}</span>
                <span className="shrink-0 rounded-full bg-[var(--bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--text2)]">
                  {t(`vault.paymentProvider.${paymentProviderOfSections(item.sections)}`)}
                </span>
                <div className="ml-auto flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => onEdit(item)}
                    className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
                  >
                    {t('vault.detail.edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteItem(item.id, accountId)}
                    className="h-6 rounded-[7px] border border-[var(--line)] px-2 text-[11.5px] text-[var(--text2)]"
                  >
                    {t('vault.detail.deleteItem')}
                  </button>
                </div>
              </div>
              {item.sections.flatMap((section) =>
                section.fields
                  .filter((field) => field.kind === 'secret')
                  .map((field) => (
                    <RevealRow
                      key={`${section.key}.${field.key}`}
                      label={field.label}
                      itemId={item.id}
                      fieldKey={field.key}
                    />
                  ))
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function ItemDetail({
  onEdit,
  onDuplicate,
  onEditGlobal,
  onAddPayment,
  onEditItem
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const setView = useUiStore((s) => s.setView)
  const accounts = useVaultStore((s) => s.accounts)
  const sites = useVaultStore((s) => s.sites)
  const itemsByAccount = useVaultStore((s) => s.itemsByAccount)
  const selectedAccountId = useVaultStore((s) => s.selectedAccountId)
  const selectedGlobalItemId = useVaultStore((s) => s.selectedGlobalItemId)
  const autofill = useVaultStore((s) => s.autofill)
  const lock = useVaultStore((s) => s.lock)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), AUTOFILL_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const openInBrowser = (host: string): void => {
    void window.samba.tabs.create({ url: `https://${host}` })
    setView('browser')
  }

  const runAutofill = async (accountId: number): Promise<void> => {
    const result = await autofill(accountId)
    setNotice(
      result === null
        ? 'vault.autofill.failed'
        : (AUTOFILL_MESSAGE[result] ?? 'vault.autofill.failed')
    )
  }

  if (selectedAccountId === 'global') {
    const item = (itemsByAccount.global ?? []).find((i) => i.id === selectedGlobalItemId)
    if (!item) {
      return (
        <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--text3)]">
          {t('vault.detail.empty')}
        </div>
      )
    }
    return (
      <div className="flex-1 overflow-auto px-9 py-7">
        <div className="mb-6 flex items-center gap-3.5">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--text)] text-[22px] font-extrabold text-white">
            {item.label.slice(0, 1)}
          </div>
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">{item.label}</h1>
            <div className="mt-0.5 text-[12.5px] text-[var(--text2)]">
              {t(`vault.itemType.${item.type}`)}
            </div>
          </div>
          <div className="ml-auto flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] rounded-[9px]"
              onClick={() => onEditGlobal(item)}
            >
              {t('vault.detail.edit')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] rounded-[9px]"
              onClick={() => void lock()}
            >
              {t('vault.detail.lock')}
            </Button>
          </div>
        </div>
        <ItemSections item={item} />
        <UsageSection key={`global-${item.id}`} itemId={item.id} />
      </div>
    )
  }

  const account = accounts.find((a) => a.id === selectedAccountId)
  if (!account) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--text3)]">
        {t('vault.detail.empty')}
      </div>
    )
  }
  const site = sites.find((s) => s.id === account.siteId)
  const items = itemsByAccount[String(account.id)] ?? []

  return (
    <div className="flex-1 overflow-auto px-9 py-7">
      <div className="mb-6 flex items-center gap-3.5">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--text)] text-[22px] font-extrabold text-white">
          {(site?.name ?? account.host).slice(0, 1)}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-semibold tracking-tight">
            {site?.name ?? account.host} · {account.label}
          </h1>
          <div className="mt-0.5 truncate text-[12.5px] text-[var(--text2)]">{account.host}</div>
        </div>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <Button
            size="sm"
            className="h-[30px] rounded-[9px]"
            onClick={() => void runAutofill(account.id)}
          >
            {t('vault.autofill.button')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] rounded-[9px]"
            onClick={() => openInBrowser(account.host)}
          >
            {t('vault.detail.openInBrowser')}
          </Button>
          <Button variant="outline" size="sm" className="h-[30px] rounded-[9px]" onClick={onEdit}>
            {t('vault.detail.edit')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] rounded-[9px]"
            onClick={onDuplicate}
          >
            {t('vault.detail.duplicate')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] rounded-[9px]"
            onClick={() => void lock()}
          >
            {t('vault.detail.lock')}
          </Button>
        </div>
      </div>

      {notice && <p className="mb-4 text-[12.5px] text-[var(--text2)]">{t(notice)}</p>}

      <section className="mb-5">
        <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
          {t('vault.detail.login')}
        </h4>
        <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
          <PlainRow
            label={t('vault.detail.username')}
            value={account.username}
            onCopy={() => void copyWithAutoClear(account.username)}
          />
        </div>
      </section>

      {items
        .filter((item) => item.type !== 'password')
        .map((item) => (
          <ItemSections
            key={item.id}
            item={item}
            {...(item.type === 'card' ? { onEdit: onEditItem } : {})}
          />
        ))}

      <PaymentSection
        accountId={account.id}
        items={items.filter((item) => item.type === 'password')}
        onAdd={onAddPayment}
        onEdit={onEditItem}
      />

      <PhoneAssignSuggestion accountId={account.id} />

      <PhoneAssignSection accountId={account.id} />

      <AccountSettings account={account} />

      <UsageSection key={`account-${account.id}`} accountId={account.id} />
    </div>
  )
}

// 계정별 "담당 폰". 고르지 않으면 인증 때 연결된 폰을 동시에 감시한다
function PhoneAssignSection({ accountId }: { accountId: number }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const phones = usePhoneStore((s) => s.list)
  const loadPhones = usePhoneStore((s) => s.load)
  const assignedFor = usePhoneStore((s) => s.assignedFor)
  // 저장된 담당 폰. undefined 는 아직 읽는 중이다
  const [assigned, setAssigned] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    setAssigned(undefined)
    void loadPhones()
    void assignedFor(accountId).then((id) => {
      if (alive) setAssigned(id)
    })
    return () => {
      alive = false
    }
  }, [accountId, assignedFor, loadPhones])
  const phone = assigned ? phones.find((p) => p.id === assigned) : undefined
  return (
    <section className="mb-5">
      <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
        {t('phone.assign.label')}
      </h4>
      {assigned !== undefined && (
        <p className="mb-2 text-[12.5px] text-[var(--text)]">
          {phone
            ? `${phone.label || phone.serial} · ${phone.model || phone.serial}`
            : t('phone.assign.currentNone')}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-[30px] rounded-[9px]"
        onClick={() => setOpen(true)}
      >
        {t('phone.assign.open')}
      </Button>
      <PhoneAssignDialog
        accountId={accountId}
        open={open}
        current={assigned ?? null}
        onOpenChange={setOpen}
        onSaved={setAssigned}
      />
    </section>
  )
}

// 사용 기록(감사 로그) 최근 10건. accountId 를 주면 그 계정 소유 항목, itemId 를 주면
// 전역 항목 하나(계정이 없어 accountId 로 걸러낼 수 없다)의 기록만 보여준다
function UsageSection({
  accountId,
  itemId
}: {
  accountId?: number
  itemId?: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<AuditLogDto[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.samba.vault.audit(accountId).then((r) => {
      if (cancelled) return
      if (!r.ok) {
        setLogs([])
        return
      }
      const rows = itemId !== undefined ? r.data.filter((l) => l.itemId === itemId) : r.data
      setLogs(rows.slice(0, USAGE_HISTORY_LIMIT))
    })
    return () => {
      cancelled = true
    }
  }, [accountId, itemId])

  return (
    <section className="mb-5">
      <h4 className="mb-2 text-[12px] font-semibold text-[var(--text2)]">
        {t('vault.detail.history')}
      </h4>
      {!logs || logs.length === 0 ? (
        <div className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-4 text-center text-[12.5px] text-[var(--text3)]">
          {t('vault.detail.noHistory')}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
          {logs.map((log) => (
            <div
              key={log.id}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-black/[.05] px-3.5 py-2.5 last:border-b-0"
            >
              <span className="text-[12.5px] text-[var(--text2)]">
                {new Date(log.at).toLocaleString()}
              </span>
              <span className="text-[12.5px]">{t(`vault.detail.auditAction.${log.action}`)}</span>
              <span className="rounded-full bg-[var(--bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--text2)]">
                {t(`vault.detail.auditSource.${log.source}`)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
