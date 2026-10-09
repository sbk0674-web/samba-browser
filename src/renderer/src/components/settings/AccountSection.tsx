import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@renderer/stores/authStore'
import { useSyncStore } from '@renderer/stores/syncStore'
import { useVaultStore } from '@renderer/stores/vaultStore'
import { VAULT_KEY_MISMATCH_ERROR } from '@shared/sync'
import { isSupabaseAnonKey, isSupabaseProjectUrl, maskSupabaseKey } from '@shared/sync'
import { DeviceList } from './DeviceList'
import {
  NotReadyNote,
  PrimaryButton,
  SecondaryButton,
  SettingsRow,
  SettingsSection,
  TextInput
} from './shared'

// 계정 삭제를 활성화하려면 사용자가 그대로 입력해야 하는 확인 문구
const DELETE_CONFIRM_WORD = 'DELETE'

// Supabase 가 돌려주는 영문 오류를 사용자 문구 키로 바꾼다. 모르는 오류는 일반 문구
function authErrorKey(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) return 'account.errors.invalidCredentials'
  if (m.includes('email not confirmed')) return 'account.errors.emailNotConfirmed'
  if (m.includes('already registered') || m.includes('already been registered'))
    return 'account.errors.alreadyRegistered'
  if (m.includes('password should be') || m.includes('weak password'))
    return 'account.errors.weakPassword'
  if (m.includes('rate limit') || m.includes('too many')) return 'account.errors.rateLimited'
  // Supabase 무료 한도 초과로 프로젝트가 정지된 상태(2026-10-09 egress) — 비밀번호 문제가 아니다
  if (m.includes('exceed_egress_quota') || m.includes('service for this project is restricted'))
    return 'account.errors.serviceRestricted'
  if (m.includes('fetch') || m.includes('network')) return 'account.errors.network'
  if (m.includes('offline-wrong-password')) return 'account.errors.offlineWrongPassword'
  if (m.includes('offline-')) return 'account.errors.offlineUnavailable'
  return 'account.errors.generic'
}

// 서버 정지·불통이라 로그인 자체가 안 되는 오류인가 — 이때만 로컬 로그인 버튼을 보인다
function isServerDownKey(key: string): boolean {
  return key === 'account.errors.serviceRestricted' || key === 'account.errors.network'
}

export function AccountSection(): React.JSX.Element {
  const { t } = useTranslation()
  const auth = useAuthStore()
  const sync = useSyncStore()

  useEffect(() => {
    void auth.load()
    void sync.load()
    const offAuth = auth.subscribe()
    const offSync = sync.subscribe()
    return () => {
      offAuth()
      offSync()
    }
    // 스토어 함수는 zustand 가 고정 참조로 유지하므로 마운트 시 한 번만 붙인다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const signedIn = auth.state?.signedIn === true

  useEffect(() => {
    if (signedIn) void auth.loadDevices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])

  if (!auth.state) return <SettingsSection title={t('account.title')}>{null}</SettingsSection>
  const account = auth.state.account
  // 계정 디렉터리가 있는 빌드: 로그인이 먼저다. 로그인 뒤 이 계정에 주소가 없을 때만 주소 폼을 보여 준다
  if (account?.configured) {
    if (!account.signedIn) return <SignInCard />
    if (account.needsSupabase || !auth.state.configured)
      return (
        <>
          <AccountCard email={account.email} userCount={account.userCount} />
          <SupabaseConnectCard toAccount />
        </>
      )
    if (!signedIn)
      return (
        <>
          <AccountCard email={account.email} userCount={account.userCount} />
          <SignInCard />
        </>
      )
  } else {
    // 디렉터리 없는 빌드(개인용): Supabase 접속 정보가 없으면 로그인 폼 대신 연결 폼을 보여 준다
    if (!auth.state.configured) return <SupabaseConnectCard />
    if (!signedIn)
      return (
        <>
          <SignInCard />
          <SupabaseConnectCard />
        </>
      )
  }

  return (
    <>
      <SettingsSection title={t('account.title')}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[var(--text)]">
              {auth.state.email ?? '-'}
            </div>
            <div className="text-[11px] text-[var(--text2)]">{t('account.signedIn')}</div>
            {account?.userCount !== undefined && (
              <div className="text-[11px] text-[var(--text2)]">
                {t('account.userCount', { n: account.userCount })}
              </div>
            )}
          </div>
        </div>
        <SecondaryButton disabled={auth.pending !== null} onClick={() => void auth.signOut()}>
          {t('account.signOut')}
        </SecondaryButton>
      </SettingsSection>

      <SettingsSection title={t('account.devicesTitle')} description={t('account.devicesDesc')}>
        <DeviceList
          devices={auth.devices}
          loading={auth.devicesLoading}
          unavailable={auth.devicesUnavailable}
          onRevoke={(id) => void auth.revokeDevice(id)}
        />
      </SettingsSection>

      <SyncStatusCard />
      <SupabaseConnectCard />
      <DangerZone />
    </>
  )
}

// 내 Supabase 프로젝트 연결 — 동기화를 쓰려는 사람만 채우면 된다.
// 비워 두면 앱은 로컬 전용으로 그대로 돈다
function SupabaseConnectCard({ toAccount = false }: { toAccount?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const auth = useAuthStore()
  const [saved, setSaved] = useState<{ url: string; anonKey: string } | null>(null)
  const [url, setUrl] = useState('')
  const [anonKey, setAnonKey] = useState('')
  // 이미 저장된 값이 있으면 키를 마스킹해 보여 주고, [변경] 을 눌러야 입력칸이 열린다
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    void window.samba.settings.get().then((r) => {
      if (!r.ok) return
      setSaved({ url: r.data.syncSupabaseUrl, anonKey: r.data.syncSupabaseAnonKey })
      setUrl(r.data.syncSupabaseUrl)
      setEditing(r.data.syncSupabaseUrl.length === 0)
    })
  }, [])

  const save = (): void => {
    const nextUrl = url.trim()
    const nextKey = anonKey.trim()
    if (!isSupabaseProjectUrl(nextUrl)) {
      setError(t('account.supabase.badUrl'))
      return
    }
    if (!isSupabaseAnonKey(nextKey)) {
      setError(t('account.supabase.badKey'))
      return
    }
    setError(null)
    if (toAccount) {
      // 계정에 저장하고 곧바로 붙는다 — 다른 PC 에서 같은 계정으로 로그인하면 이 값이 따라온다
      void auth.saveSupabase(nextUrl, nextKey).then((ok) => {
        if (!ok) {
          setError(auth.error ?? t('account.errors.generic'))
          return
        }
        setSaved({ url: nextUrl, anonKey: nextKey })
        setAnonKey('')
        setEditing(false)
      })
      return
    }
    void window.samba.settings
      .set({ syncSupabaseUrl: nextUrl, syncSupabaseAnonKey: nextKey })
      .then((r) => {
        if (!r.ok) {
          setError(t('account.errors.generic'))
          return
        }
        setSaved({ url: r.data.syncSupabaseUrl, anonKey: r.data.syncSupabaseAnonKey })
        setAnonKey('')
        setEditing(false)
        setDone(true)
      })
  }

  const connected = (saved?.url.length ?? 0) > 0 && (saved?.anonKey.length ?? 0) > 0

  return (
    <SettingsSection
      title={toAccount ? t('account.needsSupabaseTitle') : t('account.supabase.title')}
      description={toAccount ? t('account.needsSupabaseDesc') : t('account.supabase.desc')}
    >
      {connected && !editing ? (
        <>
          <SettingsRow label={t('account.supabase.urlLabel')}>
            <div className="truncate text-[12.5px] text-[var(--text)]">{saved?.url}</div>
          </SettingsRow>
          <SettingsRow label={t('account.supabase.keyLabel')}>
            <div className="truncate font-mono text-[12px] text-[var(--text2)]">
              {maskSupabaseKey(saved?.anonKey ?? '')}
            </div>
          </SettingsRow>
          <SecondaryButton onClick={() => setEditing(true)}>
            {t('account.supabase.change')}
          </SecondaryButton>
        </>
      ) : (
        <>
          <SettingsRow label={t('account.supabase.urlLabel')}>
            <TextInput
              value={url}
              onChange={setUrl}
              placeholder="https://xxxxxxxxxxxx.supabase.co"
              autoComplete="off"
            />
          </SettingsRow>
          <SettingsRow label={t('account.supabase.keyLabel')}>
            <TextInput
              value={anonKey}
              onChange={setAnonKey}
              type="password"
              placeholder="sb_publishable_…"
              autoComplete="off"
            />
          </SettingsRow>
          <PrimaryButton onClick={save}>{t('account.supabase.save')}</PrimaryButton>
        </>
      )}
      {error && <p className="text-[12px] text-red-600">{error}</p>}
      {done && !toAccount && <NotReadyNote text={t('account.supabase.restartNeeded')} />}
      {/* 설정칸이 비었는데 동기화가 연결돼 있으면 .env(개발용) 값으로 도는 것 — 사용자가 "왜 비었지" 헷갈리지 않게 */}
      {!connected && (
        <p className="text-[11.5px] text-[var(--text2)]">{t('account.supabase.envInUse')}</p>
      )}
      <p className="text-[11.5px] text-[var(--text2)]">{t('account.supabase.optional')}</p>
    </SettingsSection>
  )
}

// 계정 디렉터리에 로그인된 계정(데이터 프로젝트 연결 전 단계). 관리자에게는 가입 사용자 수도 보인다
function AccountCard({
  email,
  userCount
}: {
  email?: string
  userCount?: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const auth = useAuthStore()
  return (
    <SettingsSection title={t('account.title')}>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-[var(--text)]">{email ?? '-'}</div>
        <div className="text-[11px] text-[var(--text2)]">{t('account.accountSignedIn')}</div>
        {userCount !== undefined && (
          <div className="text-[11px] text-[var(--text2)]">
            {t('account.userCount', { n: userCount })}
          </div>
        )}
      </div>
      <SecondaryButton disabled={auth.pending !== null} onClick={() => void auth.signOut()}>
        {t('account.signOut')}
      </SecondaryButton>
    </SettingsSection>
  )
}

// 미로그인 — 이메일/비밀번호 가입·로그인 + 구글로 계속하기
export function SignInCard(): React.JSX.Element {
  const { t } = useTranslation()
  const auth = useAuthStore()
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // 비밀번호를 잊었을 때: 이 PC 에 데이터 세션이 살아 있으면 메일 없이 새 비밀번호를 정할 수 있다
  const [resetting, setResetting] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  // 세션이 남아 있는지만 안다(누구 것인지는 화면에 내보내지 않는다 — 이메일은 사용자가 직접 친다)
  const canReset = auth.state?.signedIn === true

  const busy = auth.pending !== null
  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy

  const submit = (): void => {
    if (!canSubmit) return
    if (mode === 'signUp') void auth.signUp(email.trim(), password)
    else void auth.signIn(email.trim(), password)
  }

  // 구글 로그인은 기본 브라우저에서 끝날 때까지 최대 5분 기다린다.
  // IPC 취소 채널이 없으므로 '취소' 는 화면에서 기다리기를 그만두는 것까지만 한다
  if (auth.pending === 'google') {
    return (
      <SettingsSection title={t('account.title')}>
        <p className="text-[12.5px] text-[var(--text)]">{t('account.googleWaiting')}</p>
        <p className="text-[11px] text-[var(--text2)]">{t('account.googleWaitingDetail')}</p>
        <SecondaryButton onClick={() => auth.cancelGoogle()}>
          {t('account.googleCancel')}
        </SecondaryButton>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title={mode === 'signIn' ? t('account.signInTitle') : t('account.signUpTitle')}
      description={
        auth.state?.account?.configured ? t('account.directorySignInDesc') : t('account.signInDesc')
      }
    >
      <SettingsRow label={t('account.email')}>
        <TextInput
          value={email}
          onChange={setEmail}
          type="email"
          autoComplete="username"
          placeholder="you@example.com"
        />
      </SettingsRow>
      <SettingsRow label={t('account.password')}>
        <TextInput
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="current-password"
        />
      </SettingsRow>
      {auth.error && <p className="text-[12px] text-[#b91c1c]">{t(authErrorKey(auth.error))}</p>}
      {mode === 'signIn' && auth.error && isServerDownKey(authErrorKey(auth.error)) && (
        <div className="rounded-lg border border-[var(--line)] p-2.5 text-[12px] text-[var(--text2)]">
          <p className="mb-2">{t('account.offlineHint')}</p>
          <SecondaryButton
            disabled={busy || password.length === 0}
            onClick={() => void auth.signInOffline(password)}
          >
            {t('account.signInOffline')}
          </SecondaryButton>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton disabled={!canSubmit} onClick={submit}>
          {mode === 'signIn' ? t('account.signIn') : t('account.signUp')}
        </PrimaryButton>
        <SecondaryButton
          disabled={busy}
          onClick={() => {
            auth.clearError()
            setMode(mode === 'signIn' ? 'signUp' : 'signIn')
          }}
        >
          {mode === 'signIn' ? t('account.toSignUp') : t('account.toSignIn')}
        </SecondaryButton>
      </div>
      {canReset && !resetting && (
        <button
          type="button"
          className="w-fit text-[11.5px] text-[var(--text2)] underline"
          onClick={() => {
            auth.clearError()
            setResetting(true)
          }}
        >
          {t('account.forgotPassword')}
        </button>
      )}
      {canReset && resetting && (
        <>
          <p className="text-[11.5px] text-[var(--text2)]">{t('account.resetHint')}</p>
          <SettingsRow label={t('account.newPassword')}>
            <TextInput
              value={newPassword}
              onChange={setNewPassword}
              type="password"
              autoComplete="new-password"
            />
          </SettingsRow>
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton
              disabled={newPassword.length < 8 || email.trim().length === 0 || busy}
              onClick={() => void auth.resetPassword(email.trim(), newPassword)}
            >
              {t('account.resetAndSignIn')}
            </PrimaryButton>
            <SecondaryButton disabled={busy} onClick={() => setResetting(false)}>
              {t('account.googleCancel')}
            </SecondaryButton>
          </div>
        </>
      )}
    </SettingsSection>
  )
}

// 동기화 상태 — online / pending / lastPulledAt / lastError + 지금 동기화
function SyncStatusCard(): React.JSX.Element {
  const { t } = useTranslation()
  const sync = useSyncStore()
  const status = sync.status

  return (
    <SettingsSection title={t('sync.title')}>
      <div className="flex flex-col gap-1.5 text-[12.5px]">
        <Row
          label={t('sync.connection')}
          value={status?.online ? t('sync.online') : t('sync.offline')}
        />
        <Row label={t('sync.pending')} value={String(status?.pending ?? 0)} />
        <Row
          label={t('sync.lastPulledAt')}
          value={status?.lastPulledAt ? new Date(status.lastPulledAt).toLocaleString() : '-'}
        />
        {status?.lastError && status.lastError !== VAULT_KEY_MISMATCH_ERROR && (
          <p className="text-[12px] text-[#b91c1c]">
            {t('sync.lastError')}: {status.lastError}
          </p>
        )}
      </div>
      <PrimaryButton disabled={sync.syncing} onClick={() => void sync.syncNow()}>
        {sync.syncing ? t('sync.syncing') : t('sync.syncNow')}
      </PrimaryButton>
      {status?.lastError === VAULT_KEY_MISMATCH_ERROR && <VaultRekeyCard />}
    </SettingsSection>
  )
}

// 이 PC 의 키마스터가 계정과 다른 마스터 비밀번호로 잠겨 있을 때 — 계정 마스터로 다시 잠가 동기화한다.
// 그 전까지 이 PC 의 항목은 서버로 올라가지 않고(다른 PC 가 못 푸는 암호문이라), 서버 항목도 여기서 안 풀린다
function VaultRekeyCard(): React.JSX.Element {
  const { t } = useTranslation()
  const vault = useVaultStore()
  const sync = useSyncStore()
  const [master, setMaster] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    setBusy(true)
    const r = await vault.rekeyToAccount(master)
    setBusy(false)
    setResult(r)
    setMaster('')
    if (r === 'ok') void sync.syncNow()
  }
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[10px] border border-[#b91c1c] p-3">
      <p className="text-[12.5px] font-medium text-[#b91c1c]">{t('sync.rekey.title')}</p>
      <p className="text-[11.5px] text-[var(--text2)]">{t('sync.rekey.desc')}</p>
      <SettingsRow label={t('sync.rekey.master')}>
        <TextInput value={master} onChange={setMaster} type="password" autoComplete="off" />
      </SettingsRow>
      <div className="flex items-center gap-2">
        <PrimaryButton disabled={busy || master.length === 0} onClick={() => void submit()}>
          {t('sync.rekey.submit')}
        </PrimaryButton>
        {result && (
          <span
            className={
              result === 'ok' ? 'text-[12px] text-[var(--text2)]' : 'text-[12px] text-[#b91c1c]'
            }
          >
            {t(`sync.rekey.result.${result}`)}
          </span>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-[var(--text2)]">{label}</span>
      <span className="font-medium text-[var(--text)]">{value}</span>
    </div>
  )
}

// 위험 구역 — 계정 삭제. 확인 문구를 정확히 입력해야만 버튼이 켜진다.
// 실제 삭제 IPC 는 아직 없으므로 눌러도 준비 중 안내만 보여 준다
function DangerZone(): React.JSX.Element {
  const { t } = useTranslation()
  const [confirmText, setConfirmText] = useState('')
  const [notified, setNotified] = useState(false)
  const armed = confirmText === DELETE_CONFIRM_WORD

  return (
    <SettingsSection title={t('account.dangerTitle')} description={t('account.dangerDesc')}>
      <SettingsRow label={t('account.deleteConfirmLabel', { word: DELETE_CONFIRM_WORD })}>
        <TextInput
          value={confirmText}
          onChange={setConfirmText}
          placeholder={DELETE_CONFIRM_WORD}
        />
      </SettingsRow>
      <button
        type="button"
        disabled={!armed}
        onClick={() => setNotified(true)}
        className="h-9 w-fit shrink-0 whitespace-nowrap rounded-[9px] border border-[#b91c1c] px-3 text-[12.5px] font-medium text-[#b91c1c] disabled:opacity-40"
      >
        {t('account.deleteAccount')}
      </button>
      {notified && <NotReadyNote text={t('account.deleteAccountUnavailable')} />}
    </SettingsSection>
  )
}
