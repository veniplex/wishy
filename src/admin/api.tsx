import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, Trash2 } from 'lucide-react'
import { api, errMsg } from '../api'
import { t, useT } from '../i18n'
import { Card, EmptyState, Field, FormError, IconButton, List, Row, Section, Segmented, Select, Switch, useConfirm, useToast } from '../ui'
import { KeyStatus, expiryText, lastUsed, scopesText, type ApiKey } from '../settings/api-tab'
import { SectionHead } from './shared'

type AdminKey = ApiKey & { user_id: number; user_name: string; user_email: string }

/** Admin › API: global switch, all keys of all users (filter by user/status), revocation */
export function AdminApi() {
  useT()
  const toast = useToast()
  const confirm = useConfirm()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [keys, setKeys] = useState<AdminKey[] | null>(null)
  const [error, setError] = useState('')
  const [user, setUser] = useState('')
  const [status, setStatus] = useState<'all' | ApiKey['status']>('all')

  const load = useCallback(() => api<{ api_enabled: boolean; keys: AdminKey[] }>('GET', '/api/admin/api-keys').then((r) => { setEnabled(r.api_enabled); setKeys(r.keys) }).catch((e) => setError(errMsg(e))), [])
  useEffect(() => { void load() }, [load])

  const toggle = async (v: boolean) => {
    const prev = enabled
    setEnabled(v)
    try {
      await api('PUT', '/api/admin/api-keys/settings', { api_enabled: v })
      toast(t('admin.saved'), 'ok')
    } catch (e) {
      setEnabled(prev)
      toast(errMsg(e), 'bad')
    }
  }
  const revoke = async (k: AdminKey) => {
    if (!(await confirm({ title: t('apiKeys.admin.revoke.title'), text: t('apiKeys.admin.revoke.text', { name: k.name, user: k.user_name }), confirmLabel: t('apiKeys.revoke.confirm'), destructive: true }))) return
    try {
      await api('DELETE', `/api/admin/api-keys/${k.id}`)
      toast(t('apiKeys.revoke.done'), 'ok')
      void load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }

  const owners = useMemo(() => {
    const m = new Map<number, string>()
    for (const k of keys ?? []) m.set(k.user_id, k.user_name)
    return [...m.entries()].map(([id, name]) => ({ value: String(id), label: name }))
  }, [keys])
  const shown = (keys ?? []).filter((k) => (!user || String(k.user_id) === user) && (status === 'all' || k.status === status))

  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('admin.nav.api')} sub={t('apiKeys.admin.sub')} />
      <Section title={t('apiKeys.admin.global')}>
        <Card className="space-y-1">
          <Switch checked={enabled === true} disabled={enabled === null} onChange={toggle}><span className="font-semibold">{t('apiKeys.admin.enabled')}</span></Switch>
          <p className="meta pr-14">{t('apiKeys.admin.enabledHint')}</p>
        </Card>
      </Section>

      <Section title={t('apiKeys.admin.keys')}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('apiKeys.admin.filter.user')} className="w-56">
            <Select value={user} onChange={(e) => setUser(e.target.value)} options={[{ value: '', label: t('apiKeys.admin.filter.allUsers') }, ...owners]} />
          </Field>
          <Field label={t('apiKeys.admin.filter.status')} group>
            <Segmented label={t('apiKeys.admin.filter.status')} value={status} onChange={setStatus} options={[
              { value: 'all', label: t('apiKeys.admin.filter.all') }, { value: 'active', label: t('apiKeys.status.active') },
              { value: 'expired', label: t('apiKeys.status.expired') }, { value: 'revoked', label: t('apiKeys.status.revoked') },
            ]} />
          </Field>
        </div>
        <FormError>{error}</FormError>
        {keys && (
          <List empty={<EmptyState icon={KeyRound}>{keys.length ? t('apiKeys.admin.emptyFiltered') : t('apiKeys.admin.empty')}</EmptyState>}>
            {shown.map((k) => (
              <Row
                key={k.id}
                lead={<span className="grid place-items-center size-11 rounded-2xl bg-hover text-muted"><KeyRound size={18} /></span>}
                title={k.name}
                titleSuffix={<KeyStatus s={k.status} />}
                meta={<><span className="font-mono text-xs">{k.masked}</span> · {k.user_name} ({k.user_email})</>}
                extra={<>{scopesText(k)} · {k.space_name ?? t('apiKeys.create.personal')} · {lastUsed(k)}{k.last_used_ip ? ` · ${k.last_used_ip}` : ''} · {expiryText(k)}</>}
                dim={k.status !== 'active'}
                actions={k.status === 'active' ? <IconButton icon={Trash2} label={t('apiKeys.revoke.label', { name: k.name })} onClick={() => void revoke(k)} /> : undefined}
              />
            ))}
          </List>
        )}
      </Section>
    </div>
  )
}
