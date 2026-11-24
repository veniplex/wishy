import { useCallback, useEffect, useRef, useState } from 'react'
import { startAuthentication, browserSupportsWebAuthnAutofill, WebAuthnAbortService } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { Fingerprint } from 'lucide-react'
import { ApiError, api, errMsg, type Me } from './api'
import { t, useT } from './i18n'
import { Button, FormError } from './ui'
import { passkeysSupported } from './settings/security/passkeys'

// Option requests are strictly serialized: each one replaces the short-lived challenge cookie, so the response that arrives last
// must belong to the ceremony that is started last (StrictMode, button click while the autofill request is still in flight).
let optionsChain: Promise<unknown> = Promise.resolve()
function fetchOptions() {
  const p = optionsChain.then(() => api<PublicKeyCredentialRequestOptionsJSON>('POST', '/api/auth/passkey/options'))
  optionsChain = p.catch(() => undefined)
  return p
}

const cancelled = (e: unknown) => {
  const x = e as { name?: string; code?: string } | null
  return x?.name === 'AbortError' || x?.name === 'NotAllowedError' || x?.code === 'ERROR_CEREMONY_ABORTED'
}
const aborted = (e: unknown) => {
  const x = e as { name?: string; code?: string } | null
  return x?.name === 'AbortError' || x?.code === 'ERROR_CEREMONY_ABORTED'
}

/**
 * Passwordless sign-in with a passkey: explicit button (`start`) and conditional UI (browser autofill on the e-mail field, which
 * must carry `autoComplete="username webauthn"`). At most one ceremony is active; it is aborted on unmount, when `enabled` turns false,
 * when the button is used and before a password submit (`cancel`). Aborted ceremonies never surface as errors.
 */
export function usePasskeyLogin(onDone: (me: Me) => void, enabled = true) {
  useT()
  const supported = passkeysSupported()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(false)
  const gen = useRef(0)
  const done = useRef(onDone)
  done.current = onDone

  const run = useCallback(async (conditional: boolean) => {
    const my = ++gen.current
    const stale = () => !alive.current || gen.current !== my
    try {
      if (!conditional) { setBusy(true); setError('') }
      const optionsJSON = await fetchOptions()
      if (stale()) return
      const response = await startAuthentication({ optionsJSON, useBrowserAutofill: conditional })
      if (!alive.current) return
      setBusy(true)
      setError('')
      const me = await api<Me>('POST', '/api/auth/passkey/verify', { response })
      if (!alive.current) return
      done.current(me)
    } catch (e) {
      if (stale()) return
      setBusy(false)
      if (cancelled(e)) {
        // Autofill dismissed: silent. Dialog cancelled by the user: short hint.
        if (!conditional && !aborted(e)) setError(t('auth.passkey.cancelled'))
        return
      }
      const code = e instanceof ApiError ? e.code : ''
      setError(
        code === 'passkey_login_failed' ? t('auth.passkey.failed')
        : code === 'passkey_expired' ? t('auth.passkey.expired')
        : e instanceof ApiError && (e.status === 429 || code === 'too_many_attempts') ? t('auth.passkey.tooMany')
        : errMsg(e),
      )
      if (!(e instanceof ApiError && e.status === 429)) arm()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const arm = useCallback(() => {
    if (!supported || !alive.current) return
    void browserSupportsWebAuthnAutofill().then((ok) => { if (ok && alive.current) void run(true) }).catch(() => undefined)
  }, [supported, run])

  const cancel = useCallback(() => {
    gen.current++
    try { WebAuthnAbortService.cancelCeremony() } catch { /* nothing active */ }
    setBusy(false)
  }, [])

  useEffect(() => {
    if (!enabled || !supported) return
    alive.current = true
    const h = setTimeout(arm, 0) // StrictMode: the first mount is torn down before any request is sent
    return () => {
      clearTimeout(h)
      alive.current = false
      gen.current++
      try { WebAuthnAbortService.cancelCeremony() } catch { /* nothing active */ }
    }
  }, [enabled, supported, arm])

  return { supported, busy, error, start: () => void run(false), cancel, rearm: arm }
}

/** "Sign in with a passkey" button for the sign-in page (hidden when WebAuthn is unavailable, e.g. plain http on a LAN address). */
export function PasskeyLoginButton({ pk }: { pk: ReturnType<typeof usePasskeyLogin> }) {
  const tt = useT()
  if (!pk.supported) return null
  return (
    <div className="space-y-2">
      <Button variant="primary" icon={Fingerprint} className="w-full min-h-11" disabled={pk.busy} onClick={pk.start}>{tt('auth.passkey.button')}</Button>
      <p className="meta text-center" role="status">{pk.busy ? tt('auth.passkey.waiting') : tt('auth.passkey.hint')}</p>
      <FormError>{pk.error}</FormError>
      <div className="flex items-center gap-3 meta"><span className="flex-1 border-t border-line" />{tt('auth.or')}<span className="flex-1 border-t border-line" /></div>
    </div>
  )
}
