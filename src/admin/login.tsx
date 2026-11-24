import { useEffect, useState } from 'react'
import { Banner, Badge, Button, Card, CopyField, Field, FormError, Section, Segmented, Switch, useConfirm } from '../ui'
import { t, useT } from '../i18n'
import { SaveBar, SectionHead } from './shared'
import { useSettingsGroup, type AuthSettings } from './use-settings'

/**
 * Admin › Sign-in: registration (on/off + mode), Google sign-in (on/off, client ID, secret write-only,
 * redirect URI), two-factor policy. Fields locked via environment variable are read-only.
 */
export function AdminLogin() {
  useT()
  const confirm = useConfirm()
  const { cfg, error, saving, save, locked } = useSettingsGroup<AuthSettings>('auth')
  const [regEnabled, setRegEnabled] = useState(false)
  const [regMode, setRegMode] = useState<'open' | 'invite'>('invite')
  const [googleOn, setGoogleOn] = useState(false)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [policy, setPolicy] = useState<'optional' | 'required'>('optional')
  useEffect(() => {
    if (!cfg) return
    setRegEnabled(cfg.registration_enabled)
    setRegMode(cfg.registration_mode)
    setGoogleOn(cfg.google_enabled)
    setClientId(cfg.google_client_id)
    setSecret('')
    setPolicy(cfg.two_factor_policy)
  }, [cfg])

  const lockedNote = (k: string) => (locked(k) ? t('adminAuth.envLocked') : undefined)
  const clearSecret = async () => {
    if (!(await confirm({ title: t('adminAuth.google.clearTitle'), text: t('adminAuth.google.clearText'), confirmLabel: t('adminAuth.google.clear'), destructive: true }))) return
    await save({ google_client_secret: null })
  }

  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('adminAuth.title')} sub={t('adminAuth.sub')} />
      {!cfg ? <FormError>{error || t('adminAuth.loading')}</FormError> : (
        <form
          className="flex flex-col gap-8"
          onSubmit={(e) => {
            e.preventDefault()
            void save({
              ...(locked('registration_enabled') ? {} : { registration_enabled: regEnabled }),
              ...(locked('registration_mode') ? {} : { registration_mode: regMode }),
              google_enabled: googleOn,
              ...(locked('google_client_id') ? {} : { google_client_id: clientId }),
              ...(secret.trim() ? { google_client_secret: secret.trim() } : {}),
              two_factor_policy: policy,
            })
          }}
        >
          <Section title={t('adminAuth.reg.title')}>
            <Card className="space-y-4">
              <div>
                <Switch checked={regEnabled} disabled={locked('registration_enabled')} onChange={setRegEnabled}>{t('adminAuth.reg.enabled')}</Switch>
                <p className="meta mt-1">{lockedNote('registration_enabled') ?? t('adminAuth.reg.enabledHint')}</p>
              </div>
              {regEnabled && (
                <Field label={t('adminAuth.reg.mode')} group hint={lockedNote('registration_mode') ?? t('adminAuth.reg.modeHint')}>
                  <Segmented
                    label={t('adminAuth.reg.mode')}
                    value={regMode}
                    onChange={(v) => !locked('registration_mode') && setRegMode(v)}
                    options={[{ value: 'open', label: t('adminAuth.reg.open') }, { value: 'invite', label: t('adminAuth.reg.invite') }]}
                  />
                </Field>
              )}
            </Card>
          </Section>

          <Section title={t('adminAuth.google.title')}>
            <Card className="space-y-4">
              <div>
                <Switch checked={googleOn && cfg.google_credentials_set} disabled={!cfg.google_credentials_set} onChange={setGoogleOn}>{t('adminAuth.google.enabled')}</Switch>
                <p className="meta mt-1">{cfg.google_credentials_set ? t('adminAuth.google.enabledHint') : t('adminAuth.google.needCreds')}</p>
              </div>
              <Field label={t('adminAuth.google.clientId')} hint={lockedNote('google_client_id')}>
                <input className="input" autoComplete="off" disabled={locked('google_client_id')} value={clientId} onChange={(e) => setClientId(e.target.value)} />
              </Field>
              <Field label={t('adminAuth.google.clientSecret')} hint={lockedNote('google_client_secret') ?? t('adminAuth.google.secretHint')}>
                <div className="flex gap-2 items-center">
                  <input className="input flex-1 min-w-0" type="password" autoComplete="new-password" placeholder={cfg.google_client_secret_set ? t('adminAuth.google.secretReplace') : t('adminAuth.google.secretEnter')} disabled={locked('google_client_secret')} value={secret} onChange={(e) => setSecret(e.target.value)} />
                  {cfg.google_client_secret_set && <Badge tone="ok">{t('adminAuth.google.secretSet')}</Badge>}
                  {cfg.google_client_secret_set && !locked('google_client_secret') && <Button variant="danger" onClick={clearSecret}>{t('adminAuth.google.clear')}</Button>}
                </div>
              </Field>
              <CopyField label={t('adminAuth.google.redirectUri')} value={cfg.redirect_uri} hint={t('adminAuth.google.redirectUriHint')} />
              <div className="text-sm text-muted space-y-1.5">
                <h3 className="h3 text-ink">{t('adminAuth.google.howTitle')}</h3>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>{t('adminAuth.google.how1')}</li>
                  <li>{t('adminAuth.google.how2')}</li>
                  <li>{t('adminAuth.google.how3')}</li>
                  <li>{t('adminAuth.google.how4')}</li>
                </ol>
              </div>
            </Card>
          </Section>

          <Section title={t('adminAuth.twofa.title')}>
            <Card className="space-y-4">
              <Field label={t('adminAuth.twofa.label')} group hint={t('adminAuth.twofa.hint')}>
                <Segmented
                  label={t('adminAuth.twofa.label')}
                  value={policy}
                  onChange={setPolicy}
                  options={[{ value: 'optional', label: t('adminAuth.twofa.optional') }, { value: 'required', label: t('adminAuth.twofa.required') }]}
                />
              </Field>
              {policy === 'required' && cfg.two_factor_policy !== 'required' && <Banner tone="warn">{t('adminAuth.twofa.requiredWarn')}</Banner>}
            </Card>
          </Section>

          <FormError>{error}</FormError>
          <SaveBar dirty={!!cfg && JSON.stringify([regEnabled, regMode, googleOn, clientId, secret, policy]) !== JSON.stringify([cfg.registration_enabled, cfg.registration_mode, cfg.google_enabled, cfg.google_client_id, '', cfg.two_factor_policy])} busy={saving} label={t('adminAuth.save')} />
        </form>
      )}
    </div>
  )
}
