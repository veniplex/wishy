import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Download, Eraser, Search } from 'lucide-react'
import { api, download, errMsg, type AdminUser } from '../api'
import { fmtDateTime, t, useT, type TKey } from '../i18n'
import { Badge, Button, Card, DatePicker, EmptyState, Field, FormError, Section, Segmented, SearchField, Select, useConfirm, useToast } from '../ui'
import { SectionHead } from './shared'

interface AuditItem {
  id: number
  at: string
  actor_user_id: number | null
  actor_label: string | null
  via: 'session' | 'api_key' | 'system' | 'anonymous'
  ip: string | null
  user_agent: string | null
  action: string
  target_type: string | null
  target_id: string | null
  target_label: string | null
  space_id: number | null
  status: 'ok' | 'fail'
  details: Record<string, unknown> | null
}
interface Retention {
  retention_audit_days: number
  last_run: { at: string; audit_deleted: number; ai_rows_rolled_up: number; sessions_deleted: number; trigger: 'auto' | 'manual' } | null
  stats: { audit_rows: number; audit_oldest: string | null }
}
interface Filters { from: string; to: string; user: string; action: string; status: string; via: string; q: string }
const EMPTY: Filters = { from: '', to: '', user: '', action: '', status: '', via: '', q: '' }
const PAGE = 50

const lookup = (key: string): string | null => {
  const v = t(key as TKey)
  return v === key ? null : v
}
/** Readable name of an action; unknown actions are left unchanged */
export const actionLabel = (action: string) => lookup(`audit.action.${action}`) ?? action
const groupOf = (action: string) => action.split('.')[0]
const groupLabel = (g: string) => lookup(`audit.group.${g}`) ?? g
const viaLabel = (v: string) => lookup(`audit.via.${v}`) ?? v

const query = (f: Filters) => {
  const p = new URLSearchParams()
  if (f.from) p.set('from', f.from)
  if (f.to) p.set('to', f.to)
  if (f.user) p.set('user_id', f.user)
  if (f.action) p.set('action', f.action)
  if (f.status) p.set('status', f.status)
  if (f.via) p.set('via', f.via)
  if (f.q.trim()) p.set('q', f.q.trim())
  return p
}

function Detail({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="meta">{k}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </>
  )
}

function Entry({ e, open, onToggle }: { e: AuditItem; open: boolean; onToggle: () => void }) {
  const actor = e.actor_label ?? (e.via === 'system' ? t('audit.via.system') : t('audit.anonymous'))
  const target = [e.target_label, e.target_type && e.target_id ? `${e.target_type} #${e.target_id}` : (e.target_type ?? null)].filter(Boolean).join(' · ')
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={onToggle} className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-hover focus-visible:bg-hover">
        <div className="min-w-0 flex-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,1fr)]">
          <span className="meta num sm:pt-0.5">{fmtDateTime(e.at)}</span>
          <span className="min-w-0">
            <span className="font-medium block truncate" title={actionLabel(e.action)}>{actionLabel(e.action)}</span>
            {actionLabel(e.action) !== e.action && <span className="meta block truncate font-mono text-xs">{e.action}</span>}
          </span>
          <span className="min-w-0 text-sm">
            <span className="block truncate">{actor}</span>
            {target && <span className="meta block truncate">{target}</span>}
          </span>
        </div>
        <span className="shrink-0 flex items-center justify-end gap-2 pt-0.5 sm:w-52">
          {e.status === 'fail' && <Badge tone="bad">{t('audit.status.fail')}</Badge>}
          <Badge>{viaLabel(e.via)}</Badge>
          <ChevronDown size={16} className={`text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 bg-hover/40">
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <Detail k={t('audit.detail.action')}><span className="font-mono text-xs">{e.action}</span></Detail>
            <Detail k={t('audit.detail.status')}>{e.status === 'ok' ? t('audit.status.ok') : t('audit.status.fail')}</Detail>
            <Detail k={t('audit.detail.actor')}>{actor}{e.actor_user_id != null && <span className="meta"> (#{e.actor_user_id})</span>}</Detail>
            <Detail k={t('audit.detail.via')}>{viaLabel(e.via)}</Detail>
            {(e.target_type || e.target_id || e.target_label) && (
              <Detail k={t('audit.detail.target')}>{[e.target_type, e.target_id ? `#${e.target_id}` : null, e.target_label].filter(Boolean).join(' · ')}</Detail>
            )}
            {e.space_id != null && <Detail k={t('audit.detail.space')}>#{e.space_id}</Detail>}
            <Detail k={t('audit.detail.ip')}>{e.ip ?? '–'}</Detail>
            <Detail k={t('audit.detail.userAgent')}><span className="text-muted">{e.user_agent ?? '–'}</span></Detail>
            <Detail k={t('audit.detail.id')}>#{e.id}</Detail>
          </dl>
          <div className="mt-3">
            <div className="meta mb-1">{t('audit.detail.details')}</div>
            {e.details
              ? <pre className="text-xs font-mono bg-card border border-line rounded-xl p-3 overflow-x-auto max-h-72">{JSON.stringify(e.details, null, 2)}</pre>
              : <p className="meta">{t('audit.detail.noDetails')}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

/** Admin › Audit log: log level, retention, filters, list with details (cursor), export */
export function AdminAudit() {
  useT()
  const toast = useToast()
  const confirm = useConfirm()
  const [f, setF] = useState<Filters>(EMPTY)
  const [applied, setApplied] = useState<Filters>(EMPTY)
  const [items, setItems] = useState<AuditItem[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [actions, setActions] = useState<string[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [level, setLevel] = useState<'security' | 'all'>('security')
  const [total, setTotal] = useState<number | null>(null)
  const [ret, setRet] = useState<Retention | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const seq = useRef(0)

  // Free text with a short debounce, all other filters apply immediately
  useEffect(() => {
    const h = window.setTimeout(() => setApplied(f), f.q === applied.q ? 0 : 350)
    return () => window.clearTimeout(h)
  }, [f, applied.q])

  const fetchPage = useCallback(async (flt: Filters, cursor: number | null) => {
    const id = ++seq.current
    setLoading(true)
    setError('')
    const p = query(flt)
    p.set('limit', String(PAGE))
    if (cursor) p.set('cursor', String(cursor))
    try {
      const r = await api<{ items: AuditItem[]; next_cursor: number | null }>('GET', `/api/admin/audit?${p}`)
      if (id !== seq.current) return
      setItems((prev) => (cursor ? [...prev, ...r.items] : r.items))
      setNext(r.next_cursor)
    } catch (e) {
      if (id === seq.current) setError(errMsg(e))
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [])
  useEffect(() => { setOpen(null); void fetchPage(applied, null) }, [applied, fetchPage])

  const loadMeta = useCallback(() => {
    api<string[]>('GET', '/api/admin/audit/actions').then(setActions).catch(() => {})
    api<{ audit_level: 'security' | 'all'; total: number }>('GET', '/api/admin/audit/settings').then((s) => { setLevel(s.audit_level); setTotal(s.total) }).catch(() => {})
    api<Retention>('GET', '/api/admin/retention').then(setRet).catch(() => {})
  }, [])
  useEffect(() => {
    loadMeta()
    api<AdminUser[]>('GET', '/api/admin/users').then(setUsers).catch(() => {})
  }, [loadMeta])

  const actionOptions = useMemo(() => {
    const groups = [...new Set(actions.map(groupOf))].sort((a, b) => groupLabel(a).localeCompare(groupLabel(b)))
    const out: { value: string; label: string; group?: string; meta?: string }[] = [{ value: '', label: t('audit.filter.allActions') }]
    for (const g of groups) {
      out.push({ value: `${g}.*`, label: t('audit.filter.wholeGroup', { group: groupLabel(g) }), group: groupLabel(g) })
      for (const a of actions.filter((x) => groupOf(x) === g)) out.push({ value: a, label: actionLabel(a), group: groupLabel(g), meta: actionLabel(a) !== a ? a : undefined })
    }
    return out
  }, [actions])

  const setLvl = async (v: 'security' | 'all') => {
    const prev = level
    setLevel(v)
    try {
      await api('PUT', '/api/admin/audit/settings', { audit_level: v })
      toast(t('admin.saved'), 'ok')
    } catch (e) {
      setLevel(prev)
      toast(errMsg(e), 'bad')
    }
  }
  const doExport = async (format: 'csv' | 'json') => {
    const p = query(applied)
    p.set('format', format)
    try {
      await download(`/api/admin/audit/export?${p}`, `wishy-audit-${new Date().toISOString().slice(0, 10)}.${format}`)
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const cleanup = async () => {
    if (!(await confirm({ title: t('audit.retention.confirmTitle'), text: t('audit.retention.confirmText'), confirmLabel: t('audit.retention.run') }))) return
    setCleaning(true)
    try {
      const r = await api<Retention & { audit_deleted: number; ai_rows_rolled_up: number; sessions_deleted: number }>('POST', '/api/admin/retention/run')
      setRet(r)
      toast(t('audit.retention.done', { audit: r.audit_deleted, ai: r.ai_rows_rolled_up, sessions: r.sessions_deleted }), 'ok')
      loadMeta()
      void fetchPage(applied, null)
    } catch (e) {
      toast(errMsg(e), 'bad')
    } finally {
      setCleaning(false)
    }
  }

  const filtered = JSON.stringify(applied) !== JSON.stringify(EMPTY)
  const last = ret?.last_run

  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('admin.nav.audit')} sub={t('audit.sub')} actions={
        <>
          <Button icon={Download} onClick={() => doExport('csv')}>{t('audit.export.csv')}</Button>
          <Button icon={Download} onClick={() => doExport('json')}>{t('audit.export.json')}</Button>
        </>
      } />

      <Section title={t('audit.settings.title')}>
        <Card className="space-y-5">
          <Field label={t('audit.level.label')} group hint={level === 'all' ? t('audit.level.allHint') : t('audit.level.securityHint')}>
            <Segmented label={t('audit.level.label')} value={level} onChange={setLvl} options={[{ value: 'security', label: t('audit.level.security') }, { value: 'all', label: t('audit.level.all') }]} />
          </Field>
          <div className="border-t border-line pt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1 basis-64">
              <div className="font-semibold text-sm">{t('audit.retention.title')}</div>
              <p className="meta mt-0.5">
                {ret ? (ret.retention_audit_days > 0 ? t('audit.retention.keep', { days: ret.retention_audit_days }) : t('audit.retention.keepForever')) : '…'}
                {total != null && ` · ${t('audit.retention.entries', { count: total })}`}
              </p>
              <p className="meta mt-0.5">
                {last
                  ? t('audit.retention.last', { when: fmtDateTime(last.at), how: last.trigger === 'auto' ? t('audit.retention.auto') : t('audit.retention.manual'), audit: last.audit_deleted })
                  : t('audit.retention.never')}
              </p>
            </div>
            <Button icon={Eraser} onClick={cleanup} disabled={cleaning}>{cleaning ? t('audit.retention.running') : t('audit.retention.run')}</Button>
          </div>
        </Card>
      </Section>

      <Section title={t('audit.entries')}>
        <Card className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('audit.filter.from')}><DatePicker value={f.from} max={f.to || undefined} onChange={(v) => setF({ ...f, from: v })} /></Field>
            <Field label={t('audit.filter.to')}><DatePicker value={f.to} min={f.from || undefined} onChange={(v) => setF({ ...f, to: v })} /></Field>
            <Field label={t('audit.filter.user')}>
              <Select value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} options={[{ value: '', label: t('audit.filter.allUsers') }, ...users.map((u) => ({ value: u.id, label: u.name, meta: u.email }))]} />
            </Field>
            <Field label={t('audit.filter.action')}>
              <Select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} options={actionOptions} searchable />
            </Field>
            <Field label={t('audit.filter.status')} group>
              <Segmented label={t('audit.filter.status')} value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[{ value: '', label: t('audit.filter.any') }, { value: 'ok', label: t('audit.filter.ok') }, { value: 'fail', label: t('audit.filter.fail') }]} />
            </Field>
            <Field label={t('audit.filter.via')}>
              <Select value={f.via} onChange={(e) => setF({ ...f, via: e.target.value })} options={[{ value: '', label: t('audit.filter.any') }, ...(['session', 'api_key', 'system', 'anonymous'] as const).map((v) => ({ value: v, label: viaLabel(v) }))]} />
            </Field>
            <Field label={t('audit.filter.search')} className="sm:col-span-2">
              <SearchField icon={Search} type="search" placeholder={t('audit.filter.searchPlaceholder')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
            </Field>
          </div>
          {filtered && <div><Button variant="link" onClick={() => { setF(EMPTY); setApplied(EMPTY) }}>{t('audit.filter.reset')}</Button></div>}
        </Card>

        <FormError>{error}</FormError>
        {items.length === 0 && !loading && !error ? (
          <EmptyState icon={Search}>{filtered ? t('audit.emptyFiltered') : t('audit.empty')}</EmptyState>
        ) : (
          <div className={`card divide-y divide-line overflow-hidden transition-opacity ${loading && items.length ? 'opacity-70' : ''}`} aria-busy={loading}>
            {items.map((e) => <Entry key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />)}
            {loading && !items.length && <div className="px-4 py-6 text-center text-muted text-sm">{t('admin.loading')}</div>}
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="meta">{t('audit.shown', { count: items.length })}</span>
          {next != null && <Button onClick={() => void fetchPage(applied, next)} disabled={loading}>{t('audit.loadMore')}</Button>}
        </div>
      </Section>
    </div>
  )
}
