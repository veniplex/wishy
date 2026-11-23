import { useState } from 'react'
import { api, type Me } from '../../api'
import { useAuth } from '../../auth'
import { t } from '../../i18n'
import { Button, Card, Field, FormError, Section } from '../../ui'
import { useSave } from './use-save'
import { useReauth } from '../security/reauth'

/** Account › Change password, or set it for the first time */
export function PasswordSection() {
  const { user, applyMe } = useAuth()
  const { run, dialog: reauthDialog } = useReauth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const { busy, error, submit } = useSave(async () => {
    if (next !== again) { setMismatch(true); throw new Error(t('account.password.mismatch')) }
    setMismatch(false)
    // First password (Google-only account): the server requires a fresh confirmation -> shared dialog, then retry
    applyMe(await run(() => api<Me>('PUT', '/api/account', { current_password: current, new_password: next })))
    setCurrent(''); setNext(''); setAgain('')
  }, user?.has_password ? t('account.password.changed') : t('account.password.wasSet'))
  return (
    <Section title={t('account.password.title')}>
      <form onSubmit={submit}>
        <Card className="space-y-4">
          {!user?.has_password && <p className="text-sm text-muted">{t('account.password.googleOnly')}</p>}
          {user?.has_password && <Field label={t('account.password.current')}><input className="input sm:max-w-sm" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>}
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label={t('account.password.new')} hint={t('account.password.newHint')}><input className="input" type="password" required minLength={8} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
            <Field label={t('account.password.repeat')}><input className={`input ${mismatch ? 'input-invalid' : ''}`} type="password" required autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
          </div>
          <FormError>{error}</FormError>
          <Button variant="primary" type="submit" disabled={busy}>{user?.has_password ? t('account.password.change') : t('account.password.set')}</Button>
        </Card>
      </form>
      {reauthDialog}
    </Section>
  )
}
