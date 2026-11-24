import { useCallback, useEffect, useState } from 'react'
import { Fingerprint, Pencil, RefreshCw, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import { api, errMsg } from '../../api'
import type { TwoFactorStatus } from '../../account-types'
import { useAuth } from '../../auth'
import { fmtDateTime, t, useT } from '../../i18n'
import { useReachable } from '../../offline/hooks'
import { NeedsConnection } from '../../offline/ui'
import { Badge, Banner, Button, Card, FormError, IconButton, useConfirm, useToast } from '../../ui'
import { isReauthCancelled, useReauth } from './reauth'
import { RecoveryCodesDialog } from './recovery-codes'
import { TotpWizard } from './totp-wizard'
import { AddPasskeyDialog, RenamePasskeyDialog, passkeysSupported } from './passkeys'

/**
 * Management of the two-factor methods (authenticator app, passkeys, recovery codes).
 * Used in the account (as a section) and during forced setup (`forced`).
 * The sign-in state (`me`) is only reloaded once the recovery codes are confirmed - otherwise a
 * forced setup screen would disappear before the codes were saved.
 */
export function TwoFactorPanel({ forced }: { forced?: boolean }) {
  useT()
  const { refresh } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const { run, dialog: reauthDialog } = useReauth()
  const [status, setStatus] = useState<TwoFactorStatus | null>(null)
  const [error, setError] = useState('')
  const [wizard, setWizard] = useState(false)
  const [addPasskey, setAddPasskey] = useState(false)
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)

  const load = useCallback(() => api<TwoFactorStatus>('GET', '/api/account/2fa').then(setStatus).catch((e) => setError(errMsg(e))), [])
  const reachable = useReachable()
  useEffect(() => { if (reachable) void load() }, [load, reachable])

  const applyStatus = (s: TwoFactorStatus) => {
    const { recovery_codes, ...rest } = s
    setStatus(rest as TwoFactorStatus)
    if (recovery_codes?.length) setCodes(recovery_codes)
    else void refresh()
  }

  // Sensitive actions: ask for a quick confirmation first (misclick protection); if the last confirmation is older than 10 minutes, the
  // shared "Confirm it's you" dialog (useReauth) asks for password/code and retries the request.
  const guarded = async (o: { title: string; text: string; destructive: boolean }, action: () => Promise<TwoFactorStatus>, done?: string) => {
    if (!(await confirm({ ...o, confirmLabel: o.destructive ? undefined : t('security.reauth.confirm') }))) return
    try {
      applyStatus(await run(action))
      if (done) toast(done, 'ok')
    } catch (e) {
      if (!isReauthCancelled(e)) toast(errMsg(e), 'bad')
    }
  }
  const disableTotp = () => guarded({ title: t('security.totp.disableTitle'), text: t('security.totp.disableText'), destructive: true }, () => api<TwoFactorStatus>('POST', '/api/account/2fa/totp/disable', {}), t('security.totp.disabled'))
  const removePasskey = (p: { id: string; name: string }) => guarded({ title: t('security.passkeys.removeTitle', { name: p.name }), text: t('security.passkeys.removeText'), destructive: true }, () => api<TwoFactorStatus>('DELETE', `/api/account/2fa/webauthn/${encodeURIComponent(p.id)}`, {}), t('security.passkeys.removed'))
  const regenerate = () => guarded({ title: t('security.recovery.regenerateTitle'), text: t('security.recovery.regenerateText'), destructive: false }, () => api<TwoFactorStatus>('POST', '/api/account/2fa/recovery/regenerate', {}))

  if (!status && !reachable) return <NeedsConnection />
  if (!status) return <Card>{error ? <FormError>{error}</FormError> : <p className="text-sm text-muted">{t('security.loading')}</p>}</Card>

  const supported = passkeysSupported()
  return (
    <>
      <Card className="flex flex-wrap items-center gap-3">
        <span className="grid place-items-center size-11 rounded-2xl bg-soft text-accent shrink-0"><ShieldCheck size={22} strokeWidth={1.75} /></span>
        <div className="flex-1 min-w-0 basis-60">
          <div className="font-medium flex items-center gap-2">{t('security.title')} {status.enabled ? <Badge tone="ok">{t('security.status.on')}</Badge> : <Badge>{t('security.status.off')}</Badge>}</div>
          <p className="meta mt-0.5">{t('security.intro')}</p>
        </div>
      </Card>
      {!forced && status.policy === 'required' && <Banner tone="info">{t('security.policy.required')}</Banner>}

      <Card className="flex flex-wrap items-center gap-3">
        <span className="grid place-items-center size-10 rounded-2xl bg-hover text-muted shrink-0"><Smartphone size={20} strokeWidth={1.75} /></span>
        <div className="flex-1 min-w-0 basis-60">
          <div className="font-medium flex items-center gap-2">{t('security.totp.title')} {status.totp ? <Badge tone="ok">{t('security.status.on')}</Badge> : null}</div>
          <p className="meta mt-0.5">{t('security.totp.text')}</p>
        </div>
        {status.totp
          ? <Button variant="danger" onClick={disableTotp}>{t('security.totp.disable')}</Button>
          : <Button variant={forced ? 'primary' : 'secondary'} onClick={() => setWizard(true)}>{t('security.totp.enable')}</Button>}
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid place-items-center size-10 rounded-2xl bg-hover text-muted shrink-0"><Fingerprint size={20} strokeWidth={1.75} /></span>
          <div className="flex-1 min-w-0 basis-60">
            <div className="font-medium flex items-center gap-2">{t('security.passkeys.title')} {status.passkeys > 0 ? <Badge tone="ok">{status.passkeys}</Badge> : null}</div>
            <p className="meta mt-0.5">{t('security.passkeys.text')}</p>
          </div>
          {supported && <Button variant={status.passkeys === 0 ? 'primary' : 'secondary'} icon={Fingerprint} onClick={() => setAddPasskey(true)}>{t('security.passkeys.add')}</Button>}
        </div>
        {!supported && <p className="meta">{t('security.passkeys.unsupported')}</p>}
        {status.passkey_list.length === 0
          ? (supported ? <p className="meta">{t('security.passkeys.setupText')}</p> : null)
          : (
            <ul className="divide-y divide-line border-t border-line">
              {status.passkey_list.map((p) => (
                <li key={p.id} className="flex items-center gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{p.name}</div>
                    <div className="meta">
                      {[t('security.passkeys.addedOn', { when: fmtDateTime(p.created_at) }), p.last_used_at ? t('security.passkeys.lastUsed', { when: fmtDateTime(p.last_used_at) }) : t('security.passkeys.neverUsed'), p.backed_up ? t('security.passkeys.synced') : p.device_type === 'singleDevice' ? t('security.passkeys.deviceBound') : '', p.passwordless === true ? t('security.passkeys.passwordless') : p.passwordless === false ? t('security.passkeys.secondFactorOnly') : ''].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <IconButton icon={Pencil} size="sm" label={t('security.passkeys.rename', { name: p.name })} onClick={() => setRename({ id: p.id, name: p.name })} />
                  <IconButton icon={Trash2} size="sm" variant="danger" label={t('security.passkeys.remove', { name: p.name })} onClick={() => removePasskey(p)} />
                </li>
              ))}
            </ul>
          )}
      </Card>

      {status.enabled && (
        <Card className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0 basis-60">
            <div className="font-medium flex items-center gap-2">{t('security.recovery.title')} <Badge tone={status.recovery_left <= 2 ? 'warn' : 'neutral'}>{t('security.recovery.left', { count: status.recovery_left })}</Badge></div>
            <p className="meta mt-0.5">{status.recovery_left <= 2 ? t('security.recovery.lowWarn') : t('security.recovery.text')}</p>
          </div>
          <Button icon={RefreshCw} onClick={regenerate}>{t('security.recovery.regenerate')}</Button>
        </Card>
      )}
      <FormError>{error}</FormError>

      {wizard && <TotpWizard run={run} onClose={() => setWizard(false)} onDone={(s) => { setWizard(false); applyStatus(s); toast(t('security.wizard.enabled'), 'ok') }} />}
      {addPasskey && <AddPasskeyDialog run={run} onClose={() => setAddPasskey(false)} onDone={(s) => { setAddPasskey(false); applyStatus(s); toast(t('security.passkeys.added'), 'ok') }} />}
      {rename && <RenamePasskeyDialog {...rename} onClose={() => setRename(null)} onDone={(s) => { setRename(null); applyStatus(s); toast(t('security.passkeys.renamed'), 'ok') }} />}
      {reauthDialog}
      {codes && <RecoveryCodesDialog codes={codes} onClose={() => { setCodes(null); void refresh() }} />}
    </>
  )
}
