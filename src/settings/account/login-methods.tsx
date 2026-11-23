import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, KeyRound } from 'lucide-react'
import { api, errMsg, type Me } from '../../api'
import { useUserX, type Identity } from '../../account-types'
import { useAuth } from '../../auth'
import { useFeatures } from '../../features'
import { t, useT } from '../../i18n'
import { Badge, Button, Card, Section, useConfirm, useToast } from '../../ui'
import { isReauthCancelled, useReauth } from '../security/reauth'

const PROVIDERS: Record<string, { label: () => string; start: string; enabled: (f: ReturnType<typeof useFeatures>) => boolean }> = {
  google: { label: () => t('account.google.name'), start: '/api/auth/google/start?link=1', enabled: (f) => f.google },
}

/**
 * Account › Login methods: password and linked providers (generic via `me.user.identities`).
 * Linking requires a fresh confirmation (password or 2FA code, 10 minutes), then the user is sent to the provider.
 * Providers that are globally disabled are hidden (unless still linked, then only for unlinking).
 */
export function LoginMethodsSection() {
  useT()
  const { applyMe } = useAuth()
  const user = useUserX()
  const features = useFeatures()
  const confirm = useConfirm()
  const toast = useToast()
  const [sp, setSp] = useSearchParams()
  const { run, dialog: reauthDialog } = useReauth()

  // Return from the provider (?linked=google) or from the repeated Google confirmation (?reauthed=1)
  const linked = sp.get('linked')
  const reauthed = sp.get('reauthed')
  useEffect(() => {
    if (!linked && !reauthed) return
    toast(linked ? t('account.methods.linkedToast') : t('security.reauth.done'), 'ok')
    const n = new URLSearchParams(sp)
    n.delete('linked')
    n.delete('reauthed')
    setSp(n, { replace: true })
  }, [linked, reauthed]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null
  const identities: Identity[] = user.identities ?? [{ provider: 'google', linked: !!user.google_linked, email: null, picture_available: false }]
  const visible = identities.filter((i) => PROVIDERS[i.provider] && (i.linked || PROVIDERS[i.provider].enabled(features)))
  if (visible.length === 0 && !features.google) return null

  const unlink = async (i: Identity) => {
    const label = PROVIDERS[i.provider].label()
    if (!(await confirm({ title: t('account.google.unlinkTitle'), text: t('account.google.unlinkText'), confirmLabel: t('account.google.unlink'), destructive: true }))) return
    try {
      applyMe(await run(() => api<Me>('DELETE', `/api/account/identities/${i.provider}`, {})))
      toast(t('account.google.unlinked'), 'ok')
    } catch (e) {
      if (!isReauthCancelled(e)) toast(`${label}: ${errMsg(e)}`, 'bad')
    }
  }

  // Linking: ensure a fresh confirmation (dialog only if needed), then continue to the provider
  const link = async (provider: string) => {
    try {
      await run(() => api('POST', '/api/account/reauth', {}))
    } catch (e) {
      if (!isReauthCancelled(e)) toast(errMsg(e), 'bad')
      return
    }
    window.location.assign(PROVIDERS[provider].start)
  }

  return (
    <Section title={t('account.methods.title')}>
      <Card className="flex flex-wrap items-center gap-3">
        <span className="grid place-items-center size-10 rounded-2xl bg-hover text-muted shrink-0"><KeyRound size={20} strokeWidth={1.75} /></span>
        <div className="flex-1 min-w-0 basis-60">
          <div className="font-medium flex items-center gap-2">{t('account.methods.password')} {user.has_password ? <Badge tone="ok" icon={Check}>{t('account.methods.passwordSet')}</Badge> : <Badge>{t('account.google.notLinked')}</Badge>}</div>
          <p className="meta mt-0.5">{user.has_password ? t('account.methods.sub') : t('account.methods.passwordNone')}</p>
        </div>
      </Card>
      {visible.map((i) => {
        const p = PROVIDERS[i.provider]
        const canConfirm = !!user.has_password || !!user.two_factor?.enabled
        return (
          <Card key={i.provider} className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-0 basis-60">
              <div className="font-medium flex items-center gap-2">{p.label()} {i.linked ? <Badge tone="ok" icon={Check}>{t('account.google.linked')}</Badge> : <Badge>{t('account.google.notLinked')}</Badge>}</div>
              <p className="meta mt-0.5">
                {i.linked
                  ? [i.email ? t('account.methods.linkedAs', { email: i.email }) : '', user.has_password ? t('account.google.linkedBoth') : t('account.google.linkedNeedPassword')].filter(Boolean).join(' · ')
                  : canConfirm ? t('account.google.linkHint') : t('account.google.linkedNeedPassword')}
              </p>
            </div>
            {i.linked
              ? <Button variant="danger" disabled={!user.has_password} onClick={() => unlink(i)}>{t('account.google.unlink')}</Button>
              : <Button disabled={!canConfirm} onClick={() => link(i.provider)}>{t('account.google.link')}</Button>}
          </Card>
        )
      })}
      {reauthDialog}
    </Section>
  )
}
