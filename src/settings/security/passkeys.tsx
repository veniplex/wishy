import { useState, type FormEvent } from 'react'
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'
import { api, ApiError, errMsg } from '../../api'
import type { TwoFactorStatus } from '../../account-types'
import { t, useT } from '../../i18n'
import { Button, Field, FormError, Modal } from '../../ui'
import { isReauthCancelled } from './reauth'

export const passkeysSupported = () => {
  try { return browserSupportsWebAuthn() } catch { return false }
}

/** Translate a WebAuthn error into an understandable message */
export function webauthnMessage(e: unknown): string {
  const name = (e as { name?: string } | null)?.name
  const code = (e as { code?: string } | null)?.code
  if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') return t('security.passkeys.cancelled')
  if (name === 'InvalidStateError' || code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return t('security.passkeys.exists')
  return errMsg(e)
}

/** Add a passkey: ask for a name, then the browser dialog (WebAuthn) and registration on the server. */
export function AddPasskeyDialog({ run, onDone, onClose }: { run: <T>(fn: () => Promise<T>) => Promise<T>; onDone: (s: TwoFactorStatus) => void; onClose: () => void }) {
  useT()
  const [name, setName] = useState(t('security.passkeys.nameDefault'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      // Adding requires a fresh confirmation ("Confirm it's you" dialog, if needed)
      const optionsJSON = await run(() => api<PublicKeyCredentialCreationOptionsJSON>('POST', '/api/account/2fa/webauthn/register-options'))
      const response = await startRegistration({ optionsJSON })
      onDone(await run(() => api<TwoFactorStatus>('POST', '/api/account/2fa/webauthn/register', { name: name.trim(), response })))
    } catch (err) {
      if (isReauthCancelled(err)) { setBusy(false); return }
      setError(err instanceof ApiError ? err.message : webauthnMessage(err))
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal
        compact
        title={t('security.passkeys.addTitle')}
        onClose={() => { if (!busy) onClose() }}
        footer={<><span className="flex-1" /><Button disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" disabled={busy || !name.trim()}>{t('security.passkeys.addAction')}</Button></>}
      >
        <Field label={t('security.passkeys.nameLabel')} hint={t('security.passkeys.nameHint')}>
          <input className="input" maxLength={60} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {busy && <p className="text-sm text-muted" role="status">{t('security.passkeys.waiting')}</p>}
        <FormError>{error}</FormError>
      </Modal>
    </form>
  )
}

/** Rename a passkey */
export function RenamePasskeyDialog({ id, name: initial, onDone, onClose }: { id: string; name: string; onDone: (s: TwoFactorStatus) => void; onClose: () => void }) {
  useT()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onDone(await api<TwoFactorStatus>('PUT', `/api/account/2fa/webauthn/${encodeURIComponent(id)}`, { name: name.trim() }))
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal compact title={t('security.passkeys.renameTitle')} onClose={onClose} footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" disabled={busy || !name.trim()}>{t('common.save')}</Button></>}>
        <Field label={t('security.passkeys.nameLabel')}>
          <input className="input" maxLength={60} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <FormError>{error}</FormError>
      </Modal>
    </form>
  )
}
