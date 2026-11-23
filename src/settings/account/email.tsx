import { useState } from 'react'
import { ApiError, api, type Me } from '../../api'
import { useAuth } from '../../auth'
import { t } from '../../i18n'
import { Button, Card, Field, FormError, Section } from '../../ui'
import { useSave } from './use-save'

/** Account › Email: change address; requires the current password (accounts without a password must set one first). */
export function EmailSection() {
  const { user, applyMe } = useAuth()
  const [email, setEmail] = useState(user?.email ?? '')
  const [current, setCurrent] = useState('')
  const hasPassword = !!user?.has_password
  const { busy, error, submit } = useSave(async () => {
    try {
      applyMe(await api<Me>('PUT', '/api/account', { email, current_password: current }))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'password_required') throw new Error(t('account.email.passwordRequired'))
      throw e
    }
    setCurrent('')
  }, t('account.email.changed'))
  const unchanged = email.trim() === user?.email
  return (
    <Section title={t('account.email.title')}>
      <form onSubmit={submit}>
        <Card className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label={t('account.email.field')}><input className="input" type="email" required autoComplete="username" disabled={!hasPassword} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            {hasPassword && !unchanged && (
              <Field label={t('account.email.currentPassword')} hint={t('account.email.currentPasswordHint')}>
                <input className="input" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              </Field>
            )}
          </div>
          {!hasPassword && <p className="text-sm text-muted">{t('account.email.needPassword')}</p>}
          <FormError>{error}</FormError>
          <Button variant="primary" type="submit" disabled={busy || unchanged || !hasPassword}>{t('common.save')}</Button>
        </Card>
      </form>
    </Section>
  )
}
