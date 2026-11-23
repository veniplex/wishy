import { useEffect, useState, type FormEvent } from 'react'
import { api, errMsg } from '../../api'
import type { TwoFactorStatus } from '../../account-types'
import { t, useT } from '../../i18n'
import { Button, CopyField, Field, FormError, Modal } from '../../ui'
import { isReauthCancelled } from './reauth'

interface Setup { secret: string; otpauth_uri: string; qr_data_url: string }

/** Set up an authenticator app: show QR + key, confirm code. `onDone` receives the status (+ recovery codes for the first method). */
export function TotpWizard({ run, onDone, onClose }: { run: <T>(fn: () => Promise<T>) => Promise<T>; onDone: (s: TwoFactorStatus) => void; onClose: () => void }) {
  useT()
  const [setup, setSetup] = useState<Setup | null>(null)
  const [loadError, setLoadError] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = () => {
    setSetup(null)
    setLoadError('')
    // Setup requires a fresh confirmation ("Confirm it's you" dialog, if needed)
    run(() => api<Setup>('POST', '/api/account/2fa/totp/setup')).then(setSetup).catch((e) => { if (isReauthCancelled(e)) onClose(); else setLoadError(errMsg(e)) })
  }
  useEffect(start, [])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onDone(await run(() => api<TwoFactorStatus>('POST', '/api/account/2fa/totp/confirm', { code: code.replace(/\s+/g, '') })))
    } catch (err) {
      if (!isReauthCancelled(err)) setError(errMsg(err))
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal
        title={t('security.wizard.title')}
        onClose={onClose}
        footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" disabled={busy || !setup || code.replace(/\s+/g, '').length !== 6}>{t('security.wizard.confirm')}</Button></>}
      >
        {loadError ? (
          <>
            <FormError>{loadError}</FormError>
            <Button onClick={start}>{t('security.wizard.retry')}</Button>
          </>
        ) : !setup ? (
          <p className="text-sm text-muted">{t('security.wizard.starting')}</p>
        ) : (
          <>
            <p className="text-sm">{t('security.wizard.step1')}</p>
            <div className="flex justify-center">
              <img src={setup.qr_data_url} alt={t('security.wizard.qrAlt')} width={200} height={200} className="rounded-2xl border border-line bg-white p-2 size-[200px]" />
            </div>
            <CopyField label={t('security.wizard.manual')} value={setup.secret} />
            <p className="text-sm">{t('security.wizard.step2')}</p>
            <Field label={t('security.wizard.code')} error={error}>
              <input className="input font-mono text-lg tracking-[0.3em] sm:max-w-48" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} autoFocus required value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
          </>
        )}
      </Modal>
    </form>
  )
}
