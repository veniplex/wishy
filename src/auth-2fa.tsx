import { useEffect, useRef, useState, type FormEvent } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { Fingerprint } from 'lucide-react'
import { ApiError, api, type Me } from './api'
import { useAuth } from './auth'
import { t, useT } from './i18n'
import { LanguageMenu } from './i18n/switch'
import { Banner, Button, CenteredCard, Field, FormError, Page, Section, PageHeader, Segmented } from './ui'
import { TwoFactorPanel } from './settings/security/two-factor-panel'
import { passkeysSupported, webauthnMessage } from './settings/security/passkeys'

export type TwoFactorMethod = 'totp' | 'webauthn' | 'recovery'
/** Response of POST /api/auth/login: either the session (`me`) or the prompt for the second factor */
export type LoginResponse = Me | { two_factor: { methods: TwoFactorMethod[]; ticket: string } }
/** Returns the 2FA prompt from a login response (otherwise undefined) */
export const twoFactorOf = (r: LoginResponse) => ('two_factor' in r ? r.two_factor : undefined)

const errorText = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.code === 'two_factor_invalid' || e.code === 'code_invalid') return t('security.login.invalid')
    if (e.code === 'two_factor_locked' || e.code === 'ticket_locked' || e.code === 'too_many_attempts' || e.status === 429) return t('security.login.tooMany')
    if (e.code === 'ticket_invalid') return t('security.login.expired')
    return e.message
  }
  return webauthnMessage(e)
}

/**
 * Sign-in, second step. Shown by the sign-in page when `POST /api/auth/login` returns `{ two_factor }`
 * (`methods` + `ticket`) or after the Google sign-in (`/login?2fa=1`; the ticket then comes from an HttpOnly cookie via
 * `POST /api/auth/2fa/pending`, never from the URL). `onDone` receives the session (me), `onBack` returns to the password sign-in.
 */
export function TwoFactorStep({ ticket, methods, onDone, onBack }: { ticket: string; methods?: TwoFactorMethod[]; onDone: (me: Me) => void; onBack: () => void }) {
  useT()
  const { appName } = useAuth()
  const [known, setKnown] = useState<TwoFactorMethod[] | null>(methods ?? null)
  const options = useRef<PublicKeyCredentialRequestOptionsJSON | null>(null)
  const [method, setMethod] = useState<TwoFactorMethod>('totp')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expired, setExpired] = useState(false)

  // Unknown methods (Google redirect): request passkey options - if that succeeds, passkey is available
  useEffect(() => {
    if (methods) return
    let alive = true
    api<PublicKeyCredentialRequestOptionsJSON>('POST', '/api/auth/2fa/webauthn-options', { ticket })
      .then((o) => { options.current = o; if (alive) setKnown(['totp', 'webauthn', 'recovery']) })
      .catch((e) => {
        if (!alive) return
        if (e instanceof ApiError && e.code === 'ticket_invalid') setExpired(true)
        setKnown(['totp', 'recovery'])
      })
    return () => { alive = false }
  }, [ticket, methods])

  const available = (known ?? methods ?? ['totp', 'recovery']).filter((m) => m !== 'webauthn' || passkeysSupported())
  useEffect(() => {
    if (!available.includes(method)) setMethod(available.includes('totp') ? 'totp' : available[0] ?? 'recovery')
  }, [available.join(','), method]) // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (me: Me) => onDone(me)
  const verify = async (body: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      finish(await api<Me>('POST', '/api/auth/2fa/verify', { ticket, ...body }))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ticket_invalid') setExpired(true)
      setError(errorText(e))
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void verify({ method, code: method === 'totp' ? code.replace(/\s+/g, '') : code.trim() })
  }
  const usePasskey = async () => {
    setBusy(true)
    setError('')
    try {
      const optionsJSON = options.current ?? await api<PublicKeyCredentialRequestOptionsJSON>('POST', '/api/auth/2fa/webauthn-options', { ticket })
      options.current = null // Challenge is single-use
      const assertion = await startAuthentication({ optionsJSON })
      await verify({ method: 'webauthn', assertion })
    } catch (e) {
      const name = (e as { name?: string } | null)?.name
      setError(name === 'NotAllowedError' || name === 'AbortError' ? t('security.login.passkeyCancelled') : errorText(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="fixed top-3 right-3 z-10"><LanguageMenu /></div>
      <CenteredCard brand={appName} title={t('security.login.title')} sub={t('security.login.sub')} footer={<p><button type="button" className="text-accent hover:underline cursor-pointer" onClick={onBack}>{t('security.login.back')}</button></p>}>
        {expired ? (
          <>
            <Banner tone="warn">{t('security.login.expired')}</Banner>
            <Button className="w-full" onClick={onBack}>{t('security.login.back')}</Button>
          </>
        ) : (
          <>
            {available.length > 1 && (
              <Segmented
                label={t('security.login.method')}
                value={method}
                onChange={(m) => { setMethod(m); setCode(''); setError('') }}
                options={available.map((m) => ({ value: m, label: t(`security.login.method.${m}`) }))}
                className="w-full"
              />
            )}
            {method === 'webauthn' ? (
              <div className="space-y-4">
                <p className="text-sm text-muted">{t('security.login.passkeyText')}</p>
                <FormError>{error}</FormError>
                <Button variant="primary" icon={Fingerprint} className="w-full" disabled={busy} onClick={usePasskey}>{t('security.login.passkeyAction')}</Button>
              </div>
            ) : (
              <form className="space-y-4" onSubmit={submit}>
                {method === 'totp' ? (
                  <Field label={t('security.login.totp')} hint={t('security.login.totpHint')}>
                    <input className="input font-mono text-lg tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
                  </Field>
                ) : (
                  <Field label={t('security.login.recovery')} hint={t('security.login.recoveryHint')}>
                    <input className="input font-mono tracking-wider" autoComplete="off" autoCapitalize="characters" spellCheck={false} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
                  </Field>
                )}
                <FormError>{error}</FormError>
                <Button variant="primary" type="submit" className="w-full" disabled={busy || !code.trim()}>{t('security.login.verify')}</Button>
              </form>
            )}
          </>
        )}
      </CenteredCard>
    </>
  )
}

/**
 * Forced setup (`me.user.must_setup_2fa`, "required" policy): replaces the app until a method is active.
 * The panel reloads `me` once the recovery codes are confirmed; this screen then disappears on its own.
 */
export function ForcedTwoFactorSetup() {
  useT()
  const { logout } = useAuth()
  return (
    <Page>
      <PageHeader title={t('security.setup.title')} sub={t('security.setup.sub')} actions={<Button onClick={() => void logout()}>{t('security.setup.logout')}</Button>} />
      <Section>
        <TwoFactorPanel forced />
      </Section>
    </Page>
  )
}
