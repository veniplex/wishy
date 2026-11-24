import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { api, errMsg } from '../api'
import { ApiDocs } from '../api-docs'
import { useAuth } from '../auth'
import { useFeatures } from '../features'
import { fmtCost } from '../admin/ai-usage'
import { fmtDate, fmtDateTime, fmtNumber, t, useT } from '../i18n'
import { isReauthCancelled, useReauth } from './security/reauth'
import { Badge, Banner, Button, Checkbox, CopyField, DatePicker, EmptyState, Field, FormError, IconButton, List, Modal, Progress, Row, Section, Select, Stat, useConfirm, useToast, type BadgeTone } from '../ui'

export interface ApiKey {
  id: number
  name: string
  prefix: string
  masked: string
  scopes: string[]
  space_id: number | null
  space_name: string | null
  created_at: string
  last_used_at: string | null
  last_used_ip: string | null
  expires_at: string | null
  revoked_at: string | null
  status: 'active' | 'expired' | 'revoked'
}

const STATUS_TONE: Record<ApiKey['status'], BadgeTone> = { active: 'ok', expired: 'warn', revoked: 'bad' }
export const KeyStatus = ({ s }: { s: ApiKey['status'] }) => <Badge tone={STATUS_TONE[s]}>{t(`apiKeys.status.${s}` as const)}</Badge>
export const scopesText = (k: ApiKey) => k.scopes.map((s) => t(`apiKeys.scope.${s}` as never)).join(' + ')
export const lastUsed = (k: ApiKey) => (k.last_used_at ? t('apiKeys.lastUsed', { when: fmtDateTime(k.last_used_at) }) : t('apiKeys.neverUsed'))
export const expiryText = (k: ApiKey) => (k.expires_at ? t('apiKeys.expires', { date: fmtDate(k.expires_at.slice(0, 10)) }) : t('apiKeys.noExpiry'))

type Expiry = 'never' | '30' | '90' | '365' | 'custom'

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  useT()
  const { run, dialog: reauthDialog } = useReauth()
  const { spaces } = useAuth()
  const [name, setName] = useState('')
  const [read, setRead] = useState(true)
  const [write, setWrite] = useState(true)
  const [space, setSpace] = useState('')
  const [expiry, setExpiry] = useState<Expiry>('never')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    if (!name.trim()) return setError(t('apiKeys.create.nameRequired'))
    if (!read && !write) return setError(t('apiKeys.create.scopeRequired'))
    if (expiry === 'custom' && !date) return setError(t('apiKeys.create.dateRequired'))
    setBusy(true)
    try {
      const body: Record<string, unknown> = { name: name.trim(), scopes: [...(read ? ['read'] : []), ...(write ? ['write'] : [])], space_id: space ? Number(space) : null }
      if (expiry === 'custom') body.expires_at = `${date}T23:59:59`
      else if (expiry !== 'never') body.expires_in_days = Number(expiry)
      // A key is permanent access: the server requires a fresh confirmation (shared dialog, if needed)
      const r = await run(() => api<{ key: ApiKey; secret: string }>('POST', '/api/account/api-keys', body))
      onCreated(r.secret)
    } catch (e) {
      if (!isReauthCancelled(e)) setError(errMsg(e))
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('apiKeys.create.title')}
      onClose={onClose}
      footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={busy} onClick={submit}>{t('apiKeys.create.submit')}</Button></>}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <Field label={t('apiKeys.create.name')} hint={t('apiKeys.create.nameHint')}>
          <input className="input" autoFocus data-autofocus="" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('apiKeys.create.namePlaceholder')} />
        </Field>
        <Field label={t('apiKeys.create.scopes')} group hint={t('apiKeys.create.scopesHint')}>
          <div className="space-y-2 mt-1">
            <Checkbox checked={read} onChange={setRead}>{t('apiKeys.scope.read')}</Checkbox>
            <Checkbox checked={write} onChange={setWrite}>{t('apiKeys.scope.write')}</Checkbox>
          </div>
        </Field>
        <Field label={t('apiKeys.create.space')} hint={t('apiKeys.create.spaceHint')}>
          <Select value={space} onChange={(e) => setSpace(e.target.value)} options={[{ value: '', label: t('apiKeys.create.personal') }, ...spaces.map((s) => ({ value: s.id, label: s.name }))]} />
        </Field>
        <Field label={t('apiKeys.create.expiry')}>
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)} options={[
            { value: 'never', label: t('apiKeys.create.never') }, { value: '30', label: t('apiKeys.create.d30') }, { value: '90', label: t('apiKeys.create.d90') },
            { value: '365', label: t('apiKeys.create.d365') }, { value: 'custom', label: t('apiKeys.create.custom') },
          ]} />
        </Field>
        {expiry === 'custom' && <Field label={t('apiKeys.create.date')}><DatePicker value={date} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} required onChange={setDate} /></Field>}
        <FormError>{error}</FormError>
        <button type="submit" hidden />
      </form>
      {reauthDialog}
    </Modal>
  )
}

function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  useT()
  return (
    <Modal title={t('apiKeys.secret.title')} onClose={onClose} footer={<><span className="flex-1" /><Button variant="primary" onClick={onClose}>{t('apiKeys.secret.done')}</Button></>}>
      <Banner tone="warn" icon={TriangleAlert}>{t('apiKeys.secret.warning')}</Banner>
      <CopyField value={secret} label={t('apiKeys.secret.label')} />
      <p className="meta">{t('apiKeys.secret.usage')}</p>
    </Modal>
  )
}
interface OwnUsage {
  currency: { code: string }
  month: { month: string; requests: number; cost: number }
  limits: { monthly_user_limit: number | null; monthly_cost_cap: number | null }
}
/** Own AI usage this month (only if AI is enabled for the user) */
function OwnAiUsage() {
  useT()
  const [u, setU] = useState<OwnUsage | null>(null)
  useEffect(() => {
    const now = new Date()
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
    api<OwnUsage>('GET', `/api/account/ai-usage?from=${from}&to=${now.toISOString().slice(0, 10)}`).then(setU).catch(() => {})
  }, [])
  if (!u) return null
  const { monthly_user_limit: lim, monthly_cost_cap: cap } = u.limits
  return (
    <Section title={t('apiKeys.ai.title')}>
      <div className="grid grid-cols-2 gap-3">
        <Stat label={t('apiKeys.ai.requests')} value={fmtNumber(u.month.requests)} sub={lim != null ? t('apiKeys.ai.ofLimit', { limit: lim }) : t('apiKeys.ai.noLimit')}>
          {lim != null && <Progress value={u.month.requests} max={lim} />}
        </Stat>
        <Stat label={t('apiKeys.ai.cost')} value={fmtCost(u.month.cost, u.currency.code)} sub={cap != null ? t('apiKeys.ai.ofCap', { cap: fmtCost(cap, u.currency.code) }) : t('apiKeys.ai.noLimit')}>
          {cap != null && <Progress value={u.month.cost} max={cap} />}
        </Stat>
      </div>
    </Section>
  )
}

/** Settings › API keys: manage keys, own AI usage, documentation */
export function ApiKeysTab() {
  useT()
  const toast = useToast()
  const confirm = useConfirm()
  const f = useFeatures()
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  const load = useCallback(() => api<{ keys: ApiKey[] }>('GET', '/api/account/api-keys').then((r) => setKeys(r.keys)).catch((e) => setError(errMsg(e))), [])
  useEffect(() => { void load() }, [load])

  const revoke = async (k: ApiKey) => {
    if (!(await confirm({ title: t('apiKeys.revoke.title'), text: t('apiKeys.revoke.text', { name: k.name }), confirmLabel: t('apiKeys.revoke.confirm'), destructive: true }))) return
    try {
      await api('DELETE', `/api/account/api-keys/${k.id}`)
      toast(t('apiKeys.revoke.done'), 'ok')
      void load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <Section title={t('apiKeys.title')} action={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>{t('apiKeys.new')}</Button>}>
        <p className="text-muted text-sm -mt-1">{t('apiKeys.sub')}</p>
        <FormError>{error}</FormError>
        {keys && (
          <List empty={<EmptyState icon={KeyRound} action={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>{t('apiKeys.new')}</Button>}>{t('apiKeys.empty')}</EmptyState>}>
            {keys.map((k) => (
              <Row
                key={k.id}
                lead={<span className="grid place-items-center size-11 rounded-2xl bg-hover text-muted"><KeyRound size={18} /></span>}
                title={k.name}
                titleSuffix={<KeyStatus s={k.status} />}
                meta={<span className="font-mono text-xs">{k.masked}</span>}
                extra={<>{scopesText(k)} · {k.space_name ?? t('apiKeys.create.personal')} · {lastUsed(k)} · {expiryText(k)}</>}
                dim={k.status !== 'active'}
                actions={k.status === 'active' ? <IconButton icon={Trash2} label={t('apiKeys.revoke.label', { name: k.name })} onClick={() => void revoke(k)} /> : undefined}
              />
            ))}
          </List>
        )}
      </Section>

      {f.ai && <OwnAiUsage />}

      <ApiDocs />

      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); setSecret(s); void load() }} />}
      {secret && <SecretDialog secret={secret} onClose={() => setSecret(null)} />}
    </div>
  )
}
