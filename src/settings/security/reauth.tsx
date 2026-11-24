import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { Fingerprint } from 'lucide-react'
import { api, ApiError, errMsg } from '../../api'
import { useUserX } from '../../account-types'
import { t, useT } from '../../i18n'
import { Button, Field, FormError, Modal, Segmented } from '../../ui'
import { passkeysSupported, webauthnMessage } from './passkeys'

export type ReauthBody = { current_password: string } | { code: string } | { passkey: unknown }

/**
 * Shared "Confirm it's you" dialog for sensitive actions: password (if set) or 2FA/recovery code
 * (if 2FA is active); accounts with neither (Google only) confirm by signing in with Google again. The confirmation is valid server-side for
 * 10 minutes (`POST /api/account/reauth`). `onConfirm` receives the body part for the server; if it throws, the dialog stays open.
 * Usually not used directly, but via `useReauth().run(...)`.
 */
export function ReauthDialog({ title, text, confirmLabel, destructive, onConfirm, onClose }: {
  title?: string
  text?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: (body: ReauthBody) => Promise<void>
  onClose: () => void
}) {
  useT()
  const user = useUserX()
  const canPassword = !!user?.has_password
  const canCode = !!user?.two_factor?.enabled
  const canPasskey = (user?.two_factor?.passkeys ?? 0) > 0 && passkeysSupported()
  const googleLinked = !!user?.google_linked || !!user?.identities?.some((i) => i.provider === 'google' && i.linked)
  const onlyGoogle = !canPassword && !canCode && googleLinked
  const [method, setMethod] = useState<'password' | 'code'>(canPassword ? 'password' : 'code')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (onlyGoogle) { window.location.assign('/api/auth/google/start?reauth=1'); return }
    setBusy(true)
    setError('')
    try {
      await onConfirm(method === 'password' ? { current_password: value } : { code: value.trim() })
      onClose()
    } catch (err) {
      setError(errMsg(err) || t('security.reauth.error'))
      setBusy(false)
    }
  }
  // Passkey (user verification required): challenge bound to this session, then the assertion goes in as the confirmation
  const usePasskey = async () => {
    setBusy(true)
    setError('')
    try {
      const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>('POST', '/api/account/reauth/passkey-options', {})
      await onConfirm({ passkey: await startAuthentication({ optionsJSON }) })
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : webauthnMessage(err))
      setBusy(false)
    }
  }
  const body = text ?? (onlyGoogle ? t('security.reauth.textNoPassword') : t('security.reauth.text'))
  return (
    <form onSubmit={submit}>
      <Modal
        compact
        title={title ?? t('security.reauth.title')}
        onClose={onClose}
        footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant={destructive ? 'destructive' : 'primary'} type="submit" disabled={busy || (!onlyGoogle && !value)}>{onlyGoogle ? t('security.reauth.google') : confirmLabel ?? t('security.reauth.confirm')}</Button></>}
      >
        <p className="text-sm text-muted">{body}</p>
        {!onlyGoogle && canPasskey && (
          <Button variant="primary" icon={Fingerprint} className="w-full min-h-11" disabled={busy} onClick={usePasskey}>{t('security.reauth.passkeyAction')}</Button>
        )}
        {!onlyGoogle && canPassword && canCode && (
          <Field label={t('security.reauth.method')} group>
            <Segmented label={t('security.reauth.method')} value={method} onChange={(m) => { setMethod(m); setValue(''); setError('') }} options={[{ value: 'password', label: t('security.reauth.password') }, { value: 'code', label: t('security.reauth.code') }]} />
          </Field>
        )}
        {!onlyGoogle && (
          <Field label={method === 'password' ? t('security.reauth.passwordField') : t('security.reauth.codeField')}>
            {method === 'password'
              ? <input className="input" type="password" autoFocus autoComplete="current-password" enterKeyHint="done" required value={value} onChange={(e) => setValue(e.target.value)} />
              : <input className="input font-mono tracking-wider" inputMode="text" autoFocus autoComplete="one-time-code" enterKeyHint="done" required value={value} onChange={(e) => setValue(e.target.value)} />}
          </Field>
        )}
        <FormError>{error}</FormError>
      </Modal>
    </form>
  )
}

/** The user cancelled the confirmation dialog (not an error, show nothing). */
export class ReauthCancelled extends Error {
  constructor() { super('reauth cancelled') }
}
export const isReauthCancelled = (e: unknown) => e instanceof ReauthCancelled

/**
 * `run(fn)` performs a server action. If the server responds with `reauth_required` (no confirmation in the last 10 minutes),
 * the shared dialog appears; after confirmation `fn` is retried exactly once. If the user cancels, `run` throws `ReauthCancelled`.
 * `dialog` must be rendered in the component.
 */
export function useReauth(): { run: <T>(fn: () => Promise<T>, text?: string) => Promise<T>; dialog: ReactNode } {
  const [req, setReq] = useState<{ resolve: () => void; reject: (e: unknown) => void; text?: string } | null>(null)
  const confirmed = useRef(false)
  const run = useCallback(async <T,>(fn: () => Promise<T>, text?: string): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_required')) throw e
    }
    confirmed.current = false
    await new Promise<void>((resolve, reject) => setReq({ resolve, reject, text }))
    return fn()
  }, [])
  const dialog = req && (
    <ReauthDialog
      text={req.text}
      onConfirm={async (body) => {
        await api('POST', '/api/account/reauth', body)
        confirmed.current = true
        req.resolve()
      }}
      onClose={() => {
        if (!confirmed.current) req.reject(new ReauthCancelled())
        setReq(null)
      }}
    />
  )
  return { run, dialog }
}
