import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CircleAlert } from 'lucide-react'
import { api, errMsg, loginError, registrationMode, type Me } from './api'
import { peekNext, rememberNext, takeNext, useAuth } from './auth'
import { Banner, Button, CenteredCard, Field, FormError, PageSkeleton } from './ui'
import { LanguageMenu } from './i18n/switch'
import { TwoFactorStep, twoFactorOf, type LoginResponse, type TwoFactorMethod } from './auth-2fa'
import { getLocale, useT } from './i18n'

/** Centered card with a small language switcher at the top right */
function AuthCard(props: Parameters<typeof CenteredCard>[0]) {
  return (
    <>
      <div className="fixed top-3 right-3 z-10"><LanguageMenu /></div>
      <CenteredCard {...props} />
    </>
  )
}

/** Shared form logic: submit with loading state and error message */
function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, onSubmit }
}

function GoogleButton({ invite, label }: { invite?: string | null; label: string }) {
  const t = useT()
  const { providers } = useAuth()
  if (!providers?.google) return null
  const href = `/api/auth/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`
  return (
    <>
      <Button href={href} className="w-full">{label}</Button>
      <div className="flex items-center gap-3 meta"><span className="flex-1 border-t border-line" />{t('auth.or')}<span className="flex-1 border-t border-line" /></div>
    </>
  )
}

/** Signed-in users do not need the public pages */
function useRedirectIfReady() {
  const { status } = useAuth()
  const [sp] = useSearchParams()
  if (status === 'ready') return <Navigate to={sp.get('error') ? `/settings/account?error=${encodeURIComponent(sp.get('error')!)}` : peekNext()} replace />
  if (status === 'setup') return <Navigate to="/setup" replace />
  return null
}

export function Login() {
  const t = useT()
  const redirect = useRedirectIfReady()
  const { applyMe, appName, providers } = useAuth()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const urlError = loginError(sp.get('error'))
  // Second factor: from the login response or after the Google sign-in (?2fa=1): the ticket then sits in a short-lived
  // HttpOnly cookie (never in the URL) and is fetched once via POST /api/auth/2fa/pending
  const [tf, setTf] = useState<{ ticket: string; methods?: TwoFactorMethod[] } | null>(null)
  const pendingTf = !!sp.get('2fa')
  useEffect(() => {
    if (!pendingTf) return
    let alive = true
    nav('/login', { replace: true }) // Remove parameters from the address bar immediately
    api<LoginResponse>('POST', '/api/auth/2fa/pending')
      .then((r) => { const f = twoFactorOf(r); if (alive && f) setTf({ ticket: f.ticket, methods: f.methods }) })
      .catch(() => { /* abgelaufen: normale Anmeldung */ })
    return () => { alive = false }
  }, [pendingTf]) // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, error, onSubmit } = useSubmit(async () => {
    const r = await api<LoginResponse>('POST', '/api/auth/login', { email, password })
    const f = twoFactorOf(r)
    if (f) { setTf({ ticket: f.ticket, methods: f.methods }); setPassword(''); return }
    applyMe(r as Me)
    nav(takeNext(), { replace: true })
  })
  if (redirect && !tf) return redirect
  if (tf) return <TwoFactorStep ticket={tf.ticket} methods={tf.methods} onBack={() => { setTf(null); nav('/login', { replace: true }) }} onDone={(me) => { applyMe(me); nav(takeNext(), { replace: true }) }} />
  return (
    <AuthCard
      brand={appName}
      title={t('auth.login.title')}
      footer={
        registrationMode(providers) === 'open'
          ? <p>{t('auth.login.noAccount')} <Link className="text-accent hover:underline" to="/register">{t('auth.login.register')}</Link></p>
          : registrationMode(providers) === 'invite' ? <p>{t('auth.login.inviteOnly')}</p> : null
      }
    >
      {urlError && <Banner tone="bad" icon={CircleAlert}>{urlError}</Banner>}
      <GoogleButton label={t('auth.login.google')} />
      <form className="space-y-4" onSubmit={onSubmit}>
        <Field label={t('auth.field.email')}><input className="input" type="email" required autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('auth.field.password')}><input className="input" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <FormError>{error}</FormError>
        <Button variant="primary" type="submit" className="w-full" disabled={busy}>{t('auth.login.title')}</Button>
      </form>
    </AuthCard>
  )
}

export function Register() {
  const t = useT()
  const redirect = useRedirectIfReady()
  const { applyMe, switchSpace, appName, providers } = useAuth()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const invite = sp.get('invite')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [info, setInfo] = useState<{ valid: boolean; kind?: 'user' | 'space'; bound?: boolean; name?: string; email?: string; space_name?: string } | null>(null)
  useEffect(() => {
    if (!invite) return
    api<NonNullable<typeof info>>('GET', `/api/auth/invite/${encodeURIComponent(invite)}`).then((r) => {
      setInfo(r)
      if (r.bound) { setName(r.name ?? ''); setEmail(r.email ?? '') }
    }).catch(() => setInfo({ valid: false }))
  }, [invite])
  const spaceName = info?.kind === 'space' ? info.space_name ?? null : null
  const bound = !!info?.bound
  const { busy, error, onSubmit } = useSubmit(async () => {
    const me = applyMe(await api<Me>('POST', '/api/auth/register', { name, email, password, invite: invite || undefined, locale: getLocale() }))
    const joined = spaceName ? me.spaces.find((s) => !s.personal && s.name === spaceName) : undefined
    if (joined) switchSpace(joined.id)
    nav('/', { replace: true })
  })
  if (redirect) return redirect
  const invalid = !!invite && info?.valid === false
  const closed = registrationMode(providers) === 'closed' && !invite
  const needInvite = registrationMode(providers) === 'invite' && !invite
  return (
    <AuthCard
      brand={appName}
      title={t('auth.register.title')}
      sub={spaceName ? t('auth.register.invitedTo', { space: spaceName }) : undefined}
      footer={<p>{t('auth.register.haveAccount')} <Link className="text-accent hover:underline" to="/login">{t('auth.login.title')}</Link></p>}
    >
      {invalid || closed || needInvite ? (
        <Banner tone="warn" icon={CircleAlert}>
          {invalid ? t('auth.register.inviteInvalid') : closed ? t('auth.register.closed') : t('auth.register.needInvite')}
        </Banner>
      ) : (
        <>
          {!bound && <GoogleButton invite={invite} label={t('auth.register.google')} />}
          <form className="space-y-4" onSubmit={onSubmit}>
            <Field label={t('auth.field.name')} hint={bound ? t('auth.register.boundHint') : undefined}>
              <input className="input" required readOnly={bound} autoFocus={!bound} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('auth.field.email')}><input className="input" type="email" required readOnly={bound} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label={t('auth.field.password')} hint={t('auth.field.passwordHint')}><input className="input" key={String(bound)} type="password" required minLength={8} autoFocus={bound} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <FormError>{error}</FormError>
            <Button variant="primary" type="submit" className="w-full" disabled={busy}>{t('auth.register.title')}</Button>
          </form>
        </>
      )}
    </AuthCard>
  )
}

export function Setup() {
  const t = useT()
  const { status, applyMe, appName } = useAuth()
  const nav = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, onSubmit } = useSubmit(async () => {
    applyMe(await api<Me>('POST', '/api/auth/setup', { name, email, password, locale: getLocale() }))
    nav('/', { replace: true })
  })
  if (status === 'ready') return <Navigate to="/" replace />
  if (status === 'anon') return <Navigate to="/login" replace />
  return (
    <AuthCard brand={appName} title={t('auth.setup.title')} sub={t('auth.setup.sub')}>
      <form className="space-y-4" onSubmit={onSubmit}>
        <Field label={t('auth.field.name')}><input className="input" required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('auth.field.email')}><input className="input" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('auth.field.password')} hint={t('auth.field.passwordHint')}><input className="input" type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <FormError>{error}</FormError>
        <Button variant="primary" type="submit" className="w-full" disabled={busy}>{t('auth.setup.submit')}</Button>
      </form>
    </AuthCard>
  )
}

export function PasswordReset() {
  const t = useT()
  const { applyMe, appName } = useAuth()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const token = sp.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const { busy, error, onSubmit } = useSubmit(async () => {
    if (password !== again) return void setMismatch(true)
    setMismatch(false)
    applyMe(await api<Me>('POST', '/api/auth/reset', { token, password }))
    nav('/', { replace: true })
  })
  return (
    <AuthCard brand={appName} title={t('auth.reset.title')} sub={t('auth.reset.sub')}>
      {!token ? (
        <Banner tone="bad" icon={CircleAlert}>{t('auth.reset.incomplete')}</Banner>
      ) : (
        <form className="space-y-4" onSubmit={onSubmit}>
          <Field label={t('auth.reset.newPassword')} hint={t('auth.field.passwordHint')}><input className="input" type="password" required minLength={8} autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label={t('auth.reset.repeat')} error={mismatch && t('auth.reset.mismatch')}><input className="input" type="password" required autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
          <FormError>{error}</FormError>
          <Button variant="primary" type="submit" className="w-full" disabled={busy}>{t('auth.reset.submit')}</Button>
        </form>
      )}
    </AuthCard>
  )
}

/** /invite/:token - public preview, joining after sign-in/registration */
export function InvitePage() {
  const t = useT()
  const { token = '' } = useParams()
  const { status, user, spaces, applyMe, switchSpace, appName } = useAuth()
  const nav = useNavigate()
  const [info, setInfo] = useState<{ space_name: string; inviter_name: string | null } | null>(null)
  const [invalid, setInvalid] = useState('')
  useEffect(() => {
    api<{ space_name: string; inviter_name: string | null }>('GET', `/api/invites/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setInvalid(errMsg(e)))
  }, [token])
  const { busy, error, onSubmit } = useSubmit(async () => {
    const before = new Set(spaces.map((s) => s.id))
    const me = applyMe(await api<Me>('POST', `/api/invites/${encodeURIComponent(token)}/accept`))
    const joined = me.spaces.find((s) => !before.has(s.id)) ?? me.spaces.find((s) => !s.personal && s.name === info?.space_name)
    if (joined) switchSpace(joined.id)
    nav('/', { replace: true })
  })
  useEffect(() => {
    if (status !== 'ready') rememberNext(`/invite/${token}`)
  }, [status, token])
  if (!info && !invalid) return <PageSkeleton />
  const already = info && spaces.some((s) => !s.personal && s.name === info.space_name)
  const content: ReactNode = invalid ? (
    <Banner tone="bad" icon={CircleAlert}>{invalid}</Banner>
  ) : status === 'ready' ? (
    <form className="space-y-4" onSubmit={onSubmit}>
      <p className="text-sm text-muted">{t('auth.invite.signedInAs')} <strong className="text-ink">{user?.name}</strong>.{already ? ` ${t('auth.invite.alreadyMember')}` : ''}</p>
      <FormError>{error}</FormError>
      <Button variant="primary" type="submit" className="w-full" disabled={busy}>{t('auth.invite.join')}</Button>
    </form>
  ) : (
    <div className="space-y-2">
      <Button variant="primary" className="w-full" to={`/register?invite=${encodeURIComponent(token)}`}>{t('auth.invite.registerJoin')}</Button>
      <Button className="w-full" to="/login">{t('auth.invite.loginJoin')}</Button>
    </div>
  )
  return (
    <AuthCard
      brand={appName}
      title={invalid ? t('auth.invite.invalid') : t('auth.invite.title', { space: info?.space_name ?? '' })}
      sub={info ? (info.inviter_name ? t('auth.invite.subNamed', { name: info.inviter_name }) : t('auth.invite.sub')) : undefined}
    >
      {content}
    </AuthCard>
  )
}
