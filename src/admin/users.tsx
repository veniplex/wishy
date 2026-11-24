import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Ban, CircleCheck, KeyRound, Link2, LogOut, MonitorSmartphone, Pencil, Plus, ShieldCheck, ShieldOff, Trash2, UserRound } from 'lucide-react'
import { api, errMsg, type AdminUser } from '../api'
import { useAuth } from '../auth'
import { fmtDateTime, t } from '../i18n'
import { Badge, Banner, Button, Card, CopyField, EmptyState, Field, FormError, List, Modal, Row, Section, Segmented, useConfirm, useToast } from '../ui'
import { isCoarse } from '../controls'
import { UserAvatar } from '../user-avatar'
import { RowActions, SectionHead } from './shared'

/** Last activity and IP come from the user's most recent session (admin only) */
type AdminUserX = AdminUser & { last_seen_at?: string | null; last_ip?: string | null }
interface UserSession { id: string; device: string; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string; current: boolean }
/** Per-user toggle: null = default (global), true = on, false = off */
type Tri = null | boolean
interface FeatureRow { id: number; ai_enabled: Tri; api_enabled: Tri; features?: { ai?: boolean; api?: boolean } }
const triKey = (v: Tri) => (v === null ? 'default' : v ? 'on' : 'off')
const fromKey = (k: 'default' | 'on' | 'off'): Tri => (k === 'default' ? null : k === 'on')

function TriSwitch({ label, value, onChange }: { label: string; value: Tri; onChange: (v: Tri) => void }) {
  return (
    <Field label={label} group>
      <Segmented
        label={label}
        value={triKey(value)}
        onChange={(k) => onChange(fromKey(k))}
        options={[{ value: 'default', label: t('adminUsers.default') }, { value: 'on', label: t('adminUsers.on') }, { value: 'off', label: t('adminUsers.off') }]}
      />
    </Field>
  )
}

function UserDialog({ user, features, onClose, onDone }: { user?: AdminUserX; features?: FeatureRow; onClose: () => void; onDone: (link?: string) => void }) {
  const [ai, setAi] = useState<Tri>(features?.ai_enabled ?? null)
  const [apiOn, setApiOn] = useState<Tri>(features?.api_enabled ?? null)
  const [name, setName] = useState(user?.name ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [role, setRole] = useState<'user' | 'admin'>(user?.role ?? 'user')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      if (user) {
        await api('PUT', `/api/admin/users/${user.id}`, { name, email, role })
        await api('PUT', `/api/admin/users/${user.id}/features`, { ai_enabled: ai, api_enabled: apiOn })
        onDone()
      } else {
        const r = await api<{ full_url: string | null }>('POST', '/api/admin/users', { name, email, role, password: password || undefined })
        onDone(r.full_url ?? undefined)
      }
    } catch (err) {
      setError(errMsg(err))
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal title={user ? t('admin.users.dialogEdit') : t('admin.users.dialogCreate')} onClose={onClose} footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit">{user ? t('admin.save') : t('admin.users.create.submit')}</Button></>}>
        <Field label={t('admin.users.name')}><input className="input" required autoFocus={!isCoarse()} autoComplete="off" enterKeyHint="next" autoCapitalize="words" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('admin.users.email')}><input className="input" type="email" required autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint={user ? "done" : "next"} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('admin.users.role')} group>
          <Segmented label={t('admin.users.role')} value={role} onChange={setRole} options={[{ value: 'user', label: t('admin.users.roleUser') }, { value: 'admin', label: t('admin.users.roleAdmin') }]} />
        </Field>
        {!user && (
          <Field label={t('admin.users.passwordOptional')} hint={t('admin.users.passwordOptionalHint')}>
            <input className="input" type="password" minLength={8} autoComplete="new-password" enterKeyHint="done" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        {user && (
          <>
            <p className="label !mb-0">{t('adminUsers.features')}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TriSwitch label={t('adminUsers.ai')} value={ai} onChange={setAi} />
              <TriSwitch label={t('adminUsers.api')} value={apiOn} onChange={setApiOn} />
            </div>
            <p className="meta">{t('adminUsers.featuresHint')}</p>
          </>
        )}
        <FormError>{error}</FormError>
      </Modal>
    </form>
  )
}

/** Active sessions of a user with IP and device, each with sign-out */
function SessionsDialog({ user, onClose, onChanged }: { user: AdminUserX; onClose: () => void; onChanged: () => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [list, setList] = useState<UserSession[] | null>(null)
  const load = useCallback(async () => {
    try {
      setList(await api<UserSession[]>('GET', `/api/admin/users/${user.id}/sessions`))
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }, [user.id, toast])
  useEffect(() => { void load() }, [load])
  const revoke = async (s: UserSession) => {
    try {
      await api('DELETE', `/api/admin/users/${user.id}/sessions/${s.id}`)
      toast(t('adminUsers.sessionRevoked'), 'ok')
      await load()
      onChanged()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const revokeAll = async () => {
    if (!(await confirm({ title: t('adminUsers.sessionRevokeAllTitle'), text: t('adminUsers.sessionRevokeAllText', { name: user.name }), confirmLabel: t('adminUsers.sessionRevokeAll'), destructive: true }))) return
    try {
      await api('DELETE', `/api/admin/users/${user.id}/sessions`)
      toast(t('adminUsers.sessionRevoked'), 'ok')
      await load()
      onChanged()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  return (
    <Modal title={t('adminUsers.sessionsTitle', { name: user.name })} onClose={onClose} footer={<><Button variant="danger" icon={LogOut} disabled={!list || list.filter((s) => !s.current).length === 0} onClick={revokeAll}>{t('adminUsers.sessionRevokeAll')}</Button><span className="flex-1" /><Button variant="primary" onClick={onClose}>{t('common.done')}</Button></>}>
      {list && list.length === 0 && <p className="text-sm text-muted">{t('adminUsers.sessionsEmpty')}</p>}
      {!list && <p className="text-sm text-muted">{t('admin.loading')}</p>}
      <ul className="divide-y divide-line -my-2">
        {(list ?? []).map((s) => (
          <li key={s.id} className="py-3 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm break-words" title={s.user_agent ?? undefined}>{s.device}{s.current && <> <Badge tone="accent">{t('adminUsers.sessionCurrent')}</Badge></>}</div>
              <div className="meta font-mono text-xs break-all">{s.ip ?? '–'}</div>
              <div className="meta">{t('adminUsers.sessionSeen', { when: fmtDateTime(s.last_seen_at) })} · {t('adminUsers.sessionSince', { when: fmtDateTime(s.created_at) })}</div>
            </div>
            {!s.current && <Button size="sm" onClick={() => revoke(s)}>{t('adminUsers.sessionRevoke')}</Button>}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

function LinkDialog({ title, text, url, onClose }: { title: string; text: string; url: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} footer={<><span className="flex-1" /><Button variant="primary" onClick={onClose}>{t('common.done')}</Button></>}>
      <p className="text-sm text-muted">{text}</p>
      <CopyField label={t('admin.users.link')} value={url} />
    </Modal>
  )
}

/** Generate invite links (only visible until the page is left) */
function InvitesSection() {
  const toast = useToast()
  const [links, setLinks] = useState<string[]>([])
  const create = async () => {
    try {
      const r = await api<{ full_url: string }>('POST', '/api/admin/invites')
      setLinks((l) => [r.full_url, ...l])
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  return (
    <Section title={t('admin.users.invites')}>
      <Banner icon={Link2}>{t('admin.users.inviteInfo')}</Banner>
      <div><Button icon={Link2} onClick={create}>{t('admin.users.inviteCreate')}</Button></div>
      {links.length === 0 ? <EmptyState icon={Link2}>{t('admin.users.inviteEmpty')}</EmptyState> : links.map((u) => <Card key={u}><CopyField label={t('admin.users.inviteLink')} value={u} /></Card>)}
    </Section>
  )
}

/**
 * Admin › Users: accounts (create, edit, block, password reset, delete) and invitations.
 * SLOT for auth/AI/API frontend agents: per user "reset 2FA" (POST /api/admin/users/:id/reset-2fa) and the
 * default/on/off toggles for AI and API (users.ai_enabled / users.api_enabled) – in the edit dialog or as a row action.
 */
export function AdminUsers() {
  const { user: me } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()
  const [users, setUsers] = useState<AdminUserX[] | null>(null)
  const [feats, setFeats] = useState<Record<number, FeatureRow>>({})
  const [dlg, setDlg] = useState<{ edit?: AdminUserX } | null>(null)
  const [link, setLink] = useState<{ title: string; text: string; url: string } | null>(null)
  const [sess, setSess] = useState<AdminUserX | null>(null)
  const load = useCallback(async () => {
    try {
      const [list, f] = await Promise.all([api<AdminUserX[]>('GET', '/api/admin/users'), api<FeatureRow[]>('GET', '/api/admin/users/features')])
      setUsers(list)
      const tri = (v: unknown): Tri => (v === null || v === undefined ? null : !!v)
      setFeats(Object.fromEntries(f.map((r) => [r.id, { ...r, ai_enabled: tri(r.ai_enabled), api_enabled: tri(r.api_enabled) }])))
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }, [toast])
  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      await load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const toggleDisabled = (u: AdminUserX) => run(() => api('PUT', `/api/admin/users/${u.id}`, { disabled: !u.disabled }))
  const reset2fa = async (u: AdminUserX) => {
    if (!(await confirm({ title: t('adminUsers.reset2faTitle', { name: u.name }), text: t('adminUsers.reset2faText'), confirmLabel: t('adminUsers.reset2faConfirm'), destructive: true }))) return
    await run(async () => { await api('POST', `/api/admin/users/${u.id}/reset-2fa`); toast(t('adminUsers.reset2faDone'), 'ok') })
  }
  const reset = async (u: AdminUserX) => {
    try {
      const r = await api<{ full_url: string }>('POST', `/api/admin/users/${u.id}/reset-password`)
      setLink({ title: t('admin.users.resetTitle', { name: u.name }), text: t('admin.users.resetText'), url: r.full_url })
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const del = async (u: AdminUserX) => {
    if (!(await confirm({ title: t('admin.users.deleteTitle', { name: u.name }), text: t('admin.users.deleteText'), confirmLabel: t('admin.users.deleteConfirm'), destructive: true }))) return
    await run(() => api('DELETE', `/api/admin/users/${u.id}`))
  }

  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('admin.users.title')} sub={t('admin.users.sub')} actions={<Button variant="primary" icon={Plus} onClick={() => setDlg({})}>{t('admin.users.create')}</Button>} />
      <Section>
        <List empty={<EmptyState icon={UserRound}>{users ? t('admin.users.empty') : t('admin.loading')}</EmptyState>}>
          {(users ?? []).map((u) => (
            <Row
              key={u.id}
              lead={<UserAvatar userId={u.id} name={u.name} src={u.avatar_url ?? null} size={44} />}
              title={u.id === me?.id ? t('admin.users.you', { name: u.name }) : u.name}
              dim={u.disabled}
              extra={<span className="break-all">{u.email}</span>}
              meta={[[u.has_password && t('admin.users.password'), u.google_linked && t('admin.users.google')].filter(Boolean).join(' + ') || t('admin.users.noLogin'), u.last_seen_at ? t('adminUsers.lastActive', { when: fmtDateTime(u.last_seen_at) }) : t('admin.users.lastSeen', { when: u.last_login_at ? fmtDateTime(u.last_login_at) : t('common.never') }), u.last_ip ? t('adminUsers.lastIp', { ip: u.last_ip }) : null].filter(Boolean).join(' · ')}
              trailing={<>{u.role === 'admin' ? <Badge tone="accent" icon={ShieldCheck}>{t('admin.users.roleAdmin')}</Badge> : <Badge>{t('admin.users.roleUser')}</Badge>}{u.two_factor ? <Badge tone="ok" icon={ShieldCheck}>{t('adminUsers.twoFactorOn')}</Badge> : null}{u.disabled ? <Badge tone="bad">{t('admin.users.disabled')}</Badge> : null}{feats[u.id]?.ai_enabled === false ? <Badge>{t('adminUsers.aiOff')}</Badge> : null}{feats[u.id]?.api_enabled === false ? <Badge>{t('adminUsers.apiOff')}</Badge> : null}</>}
              actions={
                <RowActions actions={[
                  { icon: Pencil, label: t('admin.users.edit', { name: u.name }), onClick: () => setDlg({ edit: u }) },
                  { icon: MonitorSmartphone, label: t('adminUsers.sessions', { name: u.name }), onClick: () => setSess(u) },
                  { icon: u.disabled ? CircleCheck : Ban, label: u.disabled ? t('admin.users.activate', { name: u.name }) : t('admin.users.deactivate', { name: u.name }), onClick: () => void toggleDisabled(u) },
                  { icon: KeyRound, label: t('admin.users.resetPassword', { name: u.name }), onClick: () => void reset(u) },
                  u.two_factor && { icon: ShieldOff, label: t('adminUsers.reset2fa', { name: u.name }), onClick: () => void reset2fa(u) },
                  u.id !== me?.id && { icon: Trash2, danger: true, label: t('admin.users.delete', { name: u.name }), onClick: () => void del(u) },
                ]} />
              }
            />
          ))}
        </List>
      </Section>
      <InvitesSection />
      {dlg && (
        <UserDialog
          user={dlg.edit}
          features={dlg.edit ? feats[dlg.edit.id] : undefined}
          onClose={() => setDlg(null)}
          onDone={(url) => {
            setDlg(null)
            void load()
            if (url) setLink({ title: t('admin.users.createdTitle'), text: t('admin.users.createdText'), url })
          }}
        />
      )}
      {link && <LinkDialog {...link} onClose={() => setLink(null)} />}
      {sess && <SessionsDialog user={sess} onClose={() => setSess(null)} onChanged={() => void load()} />}
    </div>
  )
}
