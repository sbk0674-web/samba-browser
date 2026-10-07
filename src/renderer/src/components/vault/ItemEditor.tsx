import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { useVaultStore, type PutSectionInput } from '@renderer/stores/vaultStore'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { normalizeHost, accountGroupKey } from '@shared/host'
import { PasswordGenerator } from './PasswordGenerator'
import {
  DEFAULT_PAYMENT_PROVIDER,
  PAYMENT_PROVIDER_FIELD_KEY,
  SELECTABLE_PAYMENT_PROVIDERS,
  paymentProviderOfSections,
  normalizePaymentProvider,
  PAYMENT_PROVIDER_ACCOUNT_HOST,
  PAYMENT_ACCOUNT_FIELD_KEY
} from '@shared/vault'
import type { AccountDto, FieldKind, VaultItemMeta, VaultItemType } from '@shared/ipc'

// 항목 종류별 폼 정의(섹션 > 필드). 값은 여기 담지 않고 state 에만 둔다
interface FieldSpec {
  key: string
  labelKey: string
  kind: FieldKind
  // kind === 'select' 일 때 고를 값 목록(라벨은 i18n 접두사 + 값으로 만든다)
  options?: readonly string[]
  optionLabelPrefix?: string
}

interface SectionSpec {
  key: string
  labelKey: string
  fields: FieldSpec[]
}

// 계정에 종속되는 종류(계정 라벨·아이디·호스트를 함께 입력받는다)
const ACCOUNT_TYPES = new Set<VaultItemType>(['login'])

const FORM_SPECS: Record<VaultItemType, SectionSpec[]> = {
  login: [
    {
      key: 'main',
      labelKey: 'vault.sections.login',
      fields: [{ key: 'value', labelKey: 'vault.fieldNames.password', kind: 'secret' }]
    }
  ],
  // 결제 비밀번호는 계정당 여러 개다 — 어느 결제창의 비밀번호인지 제공자로 구분한다
  password: [
    {
      key: 'main',
      labelKey: 'vault.sections.payment',
      fields: [
        {
          key: PAYMENT_PROVIDER_FIELD_KEY,
          labelKey: 'vault.fieldNames.paymentProvider',
          kind: 'select',
          options: SELECTABLE_PAYMENT_PROVIDERS,
          optionLabelPrefix: 'vault.paymentProvider'
        },
        { key: 'value', labelKey: 'vault.fieldNames.password', kind: 'secret' },
        // 토스페이처럼 결제창이 휴대폰 번호·생년월일을 먼저 묻는 수단용(선택). AI 가 결제창에 채운다
        { key: 'payment.phone', labelKey: 'vault.fieldNames.paymentPhone', kind: 'text' },
        { key: 'payment.birth', labelKey: 'vault.fieldNames.paymentBirth', kind: 'text' }
      ]
    }
  ],
  card: [
    {
      key: 'card',
      labelKey: 'vault.sections.card',
      fields: [
        { key: 'card.holder', labelKey: 'vault.fieldNames.holder', kind: 'text' },
        { key: 'card.brand', labelKey: 'vault.fieldNames.brand', kind: 'text' },
        { key: 'card.number', labelKey: 'vault.fieldNames.number', kind: 'secret' },
        { key: 'card.expiry', labelKey: 'vault.fieldNames.expiry', kind: 'text' },
        { key: 'card.cvc', labelKey: 'vault.fieldNames.cvc', kind: 'secret' }
      ]
    },
    {
      key: 'payment',
      labelKey: 'vault.sections.payment',
      fields: [{ key: 'card.password', labelKey: 'vault.fieldNames.cardPassword', kind: 'secret' }]
    }
  ],
  note: [
    {
      key: 'main',
      labelKey: 'vault.sections.note',
      fields: [{ key: 'value', labelKey: 'vault.fieldNames.note', kind: 'secret' }]
    }
  ],
  identity: [
    {
      key: 'identity',
      labelKey: 'vault.sections.identity',
      fields: [
        { key: 'identity.name', labelKey: 'vault.fieldNames.name', kind: 'text' },
        { key: 'identity.birth', labelKey: 'vault.fieldNames.birth', kind: 'date' },
        { key: 'identity.address', labelKey: 'vault.fieldNames.address', kind: 'text' },
        { key: 'identity.phone', labelKey: 'vault.fieldNames.phone', kind: 'text' },
        { key: 'identity.passport', labelKey: 'vault.fieldNames.passport', kind: 'secret' },
        { key: 'identity.idCard', labelKey: 'vault.fieldNames.idCard', kind: 'secret' },
        // 사업자 정보 — 현금영수증 지출증빙·세금계산서 칸에 넣는다(사용자 2026-09-29). 사업자등록증에 공개되는 값이라 가리지 않는다
        { key: 'identity.bizName', labelKey: 'vault.fieldNames.bizName', kind: 'text' },
        { key: 'identity.bizNo', labelKey: 'vault.fieldNames.bizNo', kind: 'text' }
      ]
    }
  ],
  // 문서 첨부는 2단계 범위 밖이라 폼이 없다(메뉴에서도 비활성)
  document: []
}

const CUSTOM_SECTION_KEY = 'custom'

/**
 * 비밀 입력칸 + [보이기] 눈 버튼. 지금 치고 있는 글자를 확인하는 용도다 —
 * 편집기는 저장된 비밀값을 불러오지 않으므로(빈 칸 = 그대로 둠) 이 버튼으로 기존 값이 드러나지는 않는다.
 * 칸을 벗어나 다른 항목을 열면 컴포넌트가 새로 만들어져 다시 가려진다
 */
function SecretInput({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [shown, setShown] = useState(false)
  const label = t(shown ? 'vault.editor.hideSecret' : 'vault.editor.showSecret')
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        data-lpignore="true"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-9"
      />
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
        className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[7px] text-[var(--text2)] hover:bg-black/5 hover:text-[var(--text)]"
      >
        {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

const FIELD_KINDS: FieldKind[] = ['text', 'secret', 'url', 'date']

interface CustomField {
  key: string
  label: string
  kind: FieldKind
}

/**
 * 편집 중인 항목의 평문 필드를 폼 초기값으로 옮긴다.
 * secret 필드는 값이 아예 내려오지 않으므로 여기 담기지 않는다(빈칸 = 기존 값 유지)
 */
function initialValues(
  item: VaultItemMeta | undefined,
  type: VaultItemType
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const section of item?.sections ?? []) {
    for (const field of section.fields) {
      if (field.kind !== 'secret' && field.value !== undefined) values[field.key] = field.value
    }
  }
  // 제공자 필드가 없는 옛 결제 비밀번호는 사이트 자체 결제로 본다
  if (type === 'password' && values[PAYMENT_PROVIDER_FIELD_KEY] === undefined) {
    values[PAYMENT_PROVIDER_FIELD_KEY] = item
      ? paymentProviderOfSections(item.sections)
      : DEFAULT_PAYMENT_PROVIDER
  }
  return values
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 새로 만들 항목 종류(편집 중이면 기존 항목 종류를 따른다)
  type: VaultItemType
  // 계정 편집이면 대상 계정
  account?: AccountDto
  // 편집 중인 기존 항목(없으면 신규)
  item?: VaultItemMeta
  // 복사 원본 계정 — 사이트·아이디·라벨·URL·태그와 로그인 항목의 값을 채운 채 '새 계정'으로 연다
  template?: AccountDto
}

/**
 * 항목 종류별 폼. 계정형(login)은 계정 정보도 함께 저장한다.
 * 부모가 열 때마다 key 를 바꿔 새로 마운트하므로 초기값만 props 에서 읽는다.
 */
export function ItemEditor({
  open,
  onOpenChange,
  type,
  account,
  item,
  template
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const upsertAccount = useVaultStore((s) => s.upsertAccount)
  const reveal = useVaultStore((s) => s.reveal)
  const itemsByAccount = useVaultStore((s) => s.itemsByAccount)
  // 복사본 저장 검사 오류(같은 사이트·아이디) — 스토어 오류와 별개로 폼 안에 보인다
  const [formError, setFormError] = useState<string | null>(null)
  // 복사 원본의 로그인 항목(평문 필드는 바로, 비밀번호는 reveal 로 채운다)
  const templateItem = template
    ? itemsByAccount[String(template.id)]?.find((i) => i.type === 'login')
    : undefined
  const putItem = useVaultStore((s) => s.putItem)
  const select = useVaultStore((s) => s.select)
  const selectGlobalItem = useVaultStore((s) => s.selectGlobalItem)
  const error = useVaultStore((s) => s.error)
  const activeTab = useBrowserStore((s) => s.activeTab)

  const itemType = item?.type ?? type
  const isAccountForm = ACCOUNT_TYPES.has(itemType)
  // 새 로그인은 현재 탭의 호스트·URL 을 기본값으로 채운다
  const tabHost = normalizeHost(activeTab?.url ?? '')
  const tabUrl = activeTab?.url ?? ''

  const [values, setValues] = useState<Record<string, string>>(() =>
    initialValues(item ?? templateItem, itemType)
  )
  // 복사 원본의 비밀번호를 한 번 읽어 채운다 — 사용자가 일부만 고쳐 새 계정으로 저장한다
  useEffect(() => {
    if (!templateItem) return
    let alive = true
    void reveal(templateItem.id, 'value').then((secret) => {
      if (alive && secret) setValues((prev) => ({ ...prev, value: prev.value || secret }))
    })
    return () => {
      alive = false
    }
    // 원본 항목은 마운트 시점 값만 쓴다(부모가 key 로 새로 마운트한다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 결제 비밀번호의 기본 라벨은 결제 수단 이름이다(사용자가 '무신사머니'처럼 바꿀 수 있다)
  const defaultLabel = (): string => {
    if (isAccountForm) return tabHost
    if (itemType === 'password') {
      return t(
        `vault.paymentProvider.${values[PAYMENT_PROVIDER_FIELD_KEY] ?? DEFAULT_PAYMENT_PROVIDER}`
      )
    }
    return t(`vault.itemType.${itemType}`)
  }
  const [label, setLabel] = useState(
    item?.label ??
      account?.label ??
      (template ? t('vault.editor.duplicateLabel', { label: template.label }) : defaultLabel())
  )
  // 사용자가 라벨을 직접 고쳤는가 — 고치기 전까지는 결제 수단을 바꾸면 라벨도 따라간다
  const [labelTouched, setLabelTouched] = useState(item !== undefined)
  const [username, setUsername] = useState(account?.username ?? template?.username ?? '')
  const [host, setHost] = useState(
    account?.host ?? template?.host ?? (isAccountForm ? tabHost : '')
  )
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [saving, setSaving] = useState(false)

  const accounts = useVaultStore((s) => s.accounts)
  // 결제 앱(네이버페이 등)의 비밀번호는 앱 계정(naver.com …)에만 둔다 — 쇼핑몰 계정에서는 어느 앱 계정을 쓸지만 고른다
  const appHost =
    itemType === 'password'
      ? PAYMENT_PROVIDER_ACCOUNT_HOST[normalizePaymentProvider(values[PAYMENT_PROVIDER_FIELD_KEY])]
      : undefined
  const onAppSite =
    appHost !== undefined && account !== undefined && accountGroupKey(account.host) === appHost
  const appAccounts = useMemo(
    () =>
      appHost === undefined || onAppSite
        ? []
        : // 결제 비밀번호를 넣어 둔 앱 계정만 고를 수 있다(없는 계정을 고르면 결제 때 못 찾는다)
          accounts.filter(
            (a) => accountGroupKey(a.host) === appHost && a.itemTypes.includes('password')
          ),
    [accounts, appHost, onAppSite]
  )
  // 앱 계정이 하나라도 있으면 비밀번호 칸 대신 계정 선택을 보여 준다. 없으면 예전처럼 직접 넣는다
  const linkMode = appAccounts.length > 0
  const specs = useMemo((): SectionSpec[] => {
    const base = FORM_SPECS[itemType]
    if (!linkMode) return base
    return base.map((section) => ({
      ...section,
      fields: section.fields.map((field) =>
        field.key === 'value'
          ? {
              key: PAYMENT_ACCOUNT_FIELD_KEY,
              labelKey: 'vault.fieldNames.paymentAccount',
              kind: 'select' as const,
              options: [...new Set(appAccounts.map((a) => a.username))]
            }
          : field
      )
    }))
  }, [itemType, linkMode, appAccounts])

  const setValue = (key: string, value: string): void => {
    setValues((prev) => ({ ...prev, [key]: value }))
    // 결제 수단을 고르면 손대지 않은 라벨을 그 이름으로 맞춰 준다
    if (key === PAYMENT_PROVIDER_FIELD_KEY && !labelTouched) {
      setLabel(t(`vault.paymentProvider.${value}`))
    }
  }

  // 값이 빈 문자열인 필드는 아예 보내지 않는다 → 메인이 기존 값을 유지한다
  const toSections = (): PutSectionInput[] => {
    const sections: PutSectionInput[] = specs.map((section) => ({
      key: section.key,
      label: t(section.labelKey),
      fields: section.fields.map((field) => {
        // 선택 칸은 고르지 않았으면 첫 항목이 보인 그대로 저장된다
        const value =
          values[field.key] || (field.kind === 'select' ? field.options?.[0] : undefined)
        return {
          key: field.key,
          label: t(field.labelKey),
          kind: field.kind,
          ...(value ? { value } : {})
        }
      })
    }))
    if (customFields.length > 0) {
      sections.push({
        key: CUSTOM_SECTION_KEY,
        label: t('vault.sections.custom'),
        fields: customFields.map((field) => ({
          key: field.key,
          label: field.label,
          kind: field.kind,
          ...(values[field.key] ? { value: values[field.key] } : {})
        }))
      })
    }
    return sections
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    void save()
  }

  const save = async (): Promise<void> => {
    if (!label.trim()) return
    setSaving(true)
    let accountId: number | null = account?.id ?? null
    if (isAccountForm) {
      if (!host.trim()) {
        setSaving(false)
        return
      }
      // 새 계정인데 같은 사이트·아이디가 이미 있으면 저장하지 않는다 — 메인은 (사이트, 아이디)로 기존 계정을
      // 찾아 갱신하므로 복사본이 원본을 덮어쓴다(실기 2026-09-28). 아이디나 사이트를 바꿔야 새 계정이다
      const dupOf = account
        ? undefined
        : accounts.find(
            (a) =>
              accountGroupKey(a.host) === accountGroupKey(host.trim()) &&
              a.username === username.trim()
          )
      if (dupOf) {
        setFormError(t('vault.editor.duplicateExists', { label: dupOf.label }))
        setSaving(false)
        return
      }
      const saved = await upsertAccount({
        id: account?.id,
        host: host.trim(),
        label: label.trim(),
        username: username.trim(),
        isDefault: account?.isDefault,
        ...(template
          ? { urls: template.urls, tags: template.tags, agentAccess: template.agentAccess }
          : {}),
        // 새 계정이면 현재 탭 URL 을 첫 Website 로 담는다
        ...(account || template || !tabUrl ? {} : { urls: [tabUrl] })
      })
      if (!saved) {
        setSaving(false)
        return
      }
      accountId = saved.id
    }

    const ok = await putItem({
      ...(item ? { id: item.id } : {}),
      accountId,
      type: itemType,
      label: label.trim(),
      sections: toSections()
    })
    setSaving(false)
    if (!ok) return
    if (accountId !== null) select(accountId)
    else {
      const saved = useVaultStore
        .getState()
        .itemsByAccount.global?.find((i) => i.type === itemType && i.label === label.trim())
      if (saved) selectGlobalItem(saved.id)
    }
    onOpenChange(false)
  }

  const titleKey = item ? 'vault.editor.editItemTitle' : 'vault.editor.newTitle'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-auto rounded-2xl sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t(titleKey, { type: t(`vault.itemType.${itemType}`) })}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label={t('vault.editor.label')}>
            <Input
              value={label}
              onChange={(e) => {
                setLabelTouched(true)
                setLabel(e.target.value)
              }}
              required
            />
          </Field>
          {isAccountForm && (
            <>
              <Field label={t('vault.editor.username')}>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field label={t('vault.editor.host')}>
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="example.com"
                  required
                />
              </Field>
            </>
          )}

          {appHost !== undefined && !onAppSite && (
            // 네이버페이는 다른 결제 수단과 구조가 다르다 — 처음 보는 사람에게 왜 비밀번호 칸이 없는지 설명한다
            <div className="flex flex-col gap-1 rounded-[10px] bg-[var(--bg2)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--text2)]">
              <p className="font-medium text-[var(--text)]">{t('vault.editor.naverPayTitle')}</p>
              <p>{t('vault.editor.naverPayHow', { host: appHost })}</p>
              <p>
                {linkMode
                  ? t('vault.editor.naverPayPick')
                  : t('vault.editor.naverPayNone', { host: appHost })}
              </p>
              <p>{t('vault.editor.naverPayCheck')}</p>
            </div>
          )}

          {specs.map((section) => (
            <section key={section.key} className="flex flex-col gap-2">
              <h4 className="text-[12px] font-semibold text-[var(--text2)]">
                {t(section.labelKey)}
              </h4>
              {section.fields.map((field) => (
                <Field key={field.key} label={t(field.labelKey)}>
                  {field.kind === 'select' ? (
                    <select
                      value={values[field.key] ?? field.options?.[0] ?? ''}
                      onChange={(e) => setValue(field.key, e.target.value)}
                      required
                      className="h-9 w-full rounded-md border border-[var(--line)] bg-transparent px-2 text-[13px] outline-none"
                    >
                      {(field.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {field.optionLabelPrefix
                            ? t(`${field.optionLabelPrefix}.${option}`)
                            : option}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {field.kind === 'select' ? null : (
                    <div className="flex items-center gap-1.5">
                      {field.kind === 'secret' ? (
                        <SecretInput
                          value={values[field.key] ?? ''}
                          onChange={(v) => setValue(field.key, v)}
                          placeholder={item ? t('vault.editor.keepHint') : ''}
                        />
                      ) : (
                        <Input
                          type={field.kind === 'date' ? 'date' : 'text'}
                          autoComplete="off"
                          data-lpignore="true"
                          spellCheck={false}
                          value={values[field.key] ?? ''}
                          onChange={(e) => setValue(field.key, e.target.value)}
                          placeholder={item ? t('vault.editor.keepHint') : ''}
                        />
                      )}
                      {field.kind === 'secret' && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-9 shrink-0 rounded-[9px]"
                            >
                              {t('vault.editor.generate')}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent align="end" className="w-[280px]">
                            <PasswordGenerator onUse={(pw) => setValue(field.key, pw)} />
                          </PopoverContent>
                        </Popover>
                      )}
                    </div>
                  )}
                </Field>
              ))}
            </section>
          ))}

          <CustomFieldEditor
            fields={customFields}
            values={values}
            onAdd={(field) => setCustomFields((prev) => [...prev, field])}
            onRemove={(key) => setCustomFields((prev) => prev.filter((f) => f.key !== key))}
            onChange={setValue}
          />

          {(formError ?? error) && (
            <p className="text-[12px] text-[#b91c1c]">{formError ?? error}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-[9px]"
              onClick={() => onOpenChange(false)}
            >
              {t('vault.editor.cancel')}
            </Button>
            <Button type="submit" disabled={saving} className="rounded-[9px]">
              {t('vault.editor.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// 사용자 정의 필드 — key/표시 이름/종류를 정해 추가한다
function CustomFieldEditor({
  fields,
  values,
  onAdd,
  onRemove,
  onChange
}: {
  fields: CustomField[]
  values: Record<string, string>
  onAdd: (field: CustomField) => void
  onRemove: (key: string) => void
  onChange: (key: string, value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<FieldKind>('text')

  const add = (): void => {
    const trimmedKey = key.trim()
    if (!trimmedKey || fields.some((f) => f.key === trimmedKey)) return
    onAdd({ key: trimmedKey, label: label.trim() || trimmedKey, kind })
    setKey('')
    setLabel('')
  }

  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[12px] font-semibold text-[var(--text2)]">
        {t('vault.sections.custom')}
      </h4>
      {fields.map((field) => (
        <Field key={field.key} label={field.label}>
          <div className="flex items-center gap-1.5">
            {field.kind === 'secret' ? (
              <SecretInput
                value={values[field.key] ?? ''}
                onChange={(v) => onChange(field.key, v)}
              />
            ) : (
              <Input
                type="text"
                autoComplete="off"
                value={values[field.key] ?? ''}
                onChange={(e) => onChange(field.key, e.target.value)}
              />
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0 rounded-[9px]"
              onClick={() => onRemove(field.key)}
            >
              {t('vault.fields.remove')}
            </Button>
          </div>
        </Field>
      ))}
      <div className="flex items-center gap-1.5">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t('vault.fields.key')}
          className="h-8"
        />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('vault.fields.fieldLabel')}
          className="h-8"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as FieldKind)}
          aria-label={t('vault.fields.kind')}
          className="h-8 rounded-md border border-[var(--line)] bg-transparent px-2 text-[12px] outline-none"
        >
          {FIELD_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`vault.fields.kind${k.charAt(0).toUpperCase()}${k.slice(1)}`)}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 rounded-[9px]"
          onClick={add}
        >
          {t('vault.fields.add')}
        </Button>
      </div>
    </section>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--text2)]">{label}</span>
      {children}
    </label>
  )
}
