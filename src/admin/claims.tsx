import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, HandHeart, Search, Trash2, UserRoundX } from 'lucide-react'
import { api, download, errMsg, type AdminUser } from '../api'
import { fmtDateTime, t, useT } from '../i18n'
import { Badge, Button, Card, Checkbox, EmptyState, Field, FormError, IconButton, Section, Segmented, SearchField, Select, ToggleLink, useConfirm, useDesktopChrome, useToast } from '../ui'
import { HiddenOwnBanner, IpButton, ProxyIpWarning, SectionHead } from './shared'

interface Person { id: number | null; name: string | null; email: string | null }
interface Claim {
  key: string
  state: 'active' | 'released'
  at: string
  reservation_id: number | null
  wish_id: number | null
  wish_title: string | null
  list_title: string | null
  owner: Person | null
  claimed_by: Person | null
  guest: boolean
  guest_name: string | null
  guest_code: string | null
  ip: string | null
  device: string | null
  user_agent: string | null
  released_by: string | null
}
interface Page { items: Claim[]; total: number; page: number; pages: number; hidden_own: number }
interface GuestRow {
  id: number
  code: string
  name: string
  list_id: number
  list_title: string
  owner: Person | null
  claims: number
  created_at: string
  last_seen_at: string
  ip: string | null
  device: string | null
  user_agent: string | null
}
interface GuestPage { items: GuestRow[]; total: number; page: number; pages: number; hidden_own: number }
interface Filters { owner: string; by: '' | 'user' | 'guest'; state: '' | 'active' | 'released'; ip: string; guest: string; q: string }
const EMPTY: Filters = { owner: '', by: '', state: '', ip: '', guest: '', q: '' }
const LIMIT = 25

const query = (f: Filters, reveal: boolean) => {
  const p = new URLSearchParams()
  if (f.owner) p.set('owner_id', f.owner)
  if (f.by) p.set('by', f.by)
  if (f.state) p.set('state', f.state)
  if (f.ip.trim()) p.set('ip', f.ip.trim())
  if (f.guest.trim()) p.set('guest', f.guest.trim())
  if (f.q.trim()) p.set('q', f.q.trim())
  if (reveal) p.set('reveal_own', '1')
  return p
}
const nameOf = (p: Person | null) => p?.name || p?.email || null

/** The guest ID of a claim; a click filters to this guest */
function CodeButton({ code, onPick }: { code: string; onPick: (code: string) => void }) {
  return (
    <button type="button" onClick={() => onPick(code)} title={t('audit.claims.byGuest', { code })} className="font-mono text-xs text-muted hover:text-ink hover:underline underline-offset-2 rounded px-1 -mx-1 pointer-coarse:min-h-11 pointer-coarse:inline-flex pointer-coarse:items-center">
      {code}
    </button>
  )
}

function ClaimRow({ c, selecting, selected, onSelect, onIp, onGuest, onRelease }: { c: Claim; selecting: boolean; selected: boolean; onSelect: (v: boolean) => void; onIp: (ip: string) => void; onGuest: (code: string) => void; onRelease: (c: Claim) => void }) {
  const who = c.guest ? (c.guest_name ?? t('audit.claims.unknown')) : (nameOf(c.claimed_by) ?? t('audit.claims.unknown'))
  const owner = nameOf(c.owner)
  const desktop = useDesktopChrome()
  const removable = c.state === 'active' && c.reservation_id != null
  return (
    <div className="px-4 py-3 flex flex-wrap items-start gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-64 flex items-start gap-3">
      {selecting && <Checkbox checked={selected} disabled={!removable} onChange={onSelect}><span className="sr-only">{t('audit.claims.selectRow', { wish: c.wish_title ?? '' })}</span></Checkbox>}
      <div className="min-w-0 flex-1">
        <div className="font-medium break-words" title={c.wish_title ?? undefined}>{c.wish_title ?? t('audit.claims.deletedWish')}</div>
        <div className="meta break-words">{[c.list_title, owner ? t('audit.claims.ownerOf', { name: owner }) : null].filter(Boolean).join(' · ')}</div>
        <div className="mt-1 text-sm flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span className="break-words max-w-full" title={c.claimed_by?.email ?? undefined}>{t('audit.claims.claimedBy', { name: who })}</span>
          {c.guest && <Badge tone="accent">{t('audit.claims.guest')}</Badge>}
          {c.guest && c.guest_code && <CodeButton code={c.guest_code} onPick={onGuest} />}
        </div>
        {c.released_by && <div className="meta">{t('audit.claims.releasedByAdmin', { name: c.released_by })}</div>}
      </div>
      </div>
      <div className="min-w-0 basis-52 grow-0 shrink flex flex-col gap-0.5 sm:items-end sm:text-right">
        <span className="meta num">{fmtDateTime(c.at)}</span>
        <IpButton ip={c.ip} onPick={onIp} />
        {c.device && <span className="meta truncate max-w-full" title={c.user_agent ?? undefined}>{c.device}</span>}
      </div>
      <div className="flex items-center gap-2 ml-auto sm:ml-0">
        <Badge tone={c.state === 'active' ? 'ok' : 'neutral'}>{c.state === 'active' ? t('audit.claims.state.active') : t('audit.claims.state.released')}</Badge>
        {removable && !selecting && (desktop
          ? <IconButton icon={Trash2} size="sm" variant="danger" label={t('audit.claims.release')} onClick={() => onRelease(c)} />
          : <Button size="sm" variant="danger" icon={Trash2} onClick={() => onRelease(c)}>{t('audit.claims.release')}</Button>)}
      </div>
    </div>
  )
}

/** Debounced filter state shared by both lists */
function useFilters<F extends { q: string; ip: string }>(empty: F, initial?: Partial<F>) {
  const [f, setF] = useState<F>({ ...empty, ...initial })
  const [applied, setApplied] = useState<F>({ ...empty, ...initial })
  const [page, setPage] = useState(1)
  useEffect(() => {
    const h = window.setTimeout(() => { setApplied(f); setPage(1) }, f.q === applied.q && f.ip === applied.ip ? 0 : 350)
    return () => window.clearTimeout(h)
  }, [f, applied.q, applied.ip])
  const set = (patch: Partial<F>) => { setF((x) => ({ ...x, ...patch })); setApplied((x) => ({ ...x, ...patch })); setPage(1) }
  const reset = () => { setF(empty); setApplied(empty); setPage(1) }
  return { f, setF, applied, page, setPage, set, reset, filtered: JSON.stringify(applied) !== JSON.stringify(empty) }
}

interface ViewProps { reveal: boolean; setReveal: (v: boolean) => void; viewSwitch: ReactNode }

/** Reservations: current and released claims with IP/device, filters, pagination, CSV export, delete (single and several) */
function ClaimsView({ reveal, setReveal, viewSwitch, preset }: ViewProps & { preset?: Partial<Filters> }) {
  useT()
  const toast = useToast()
  const confirm = useConfirm()
  const { f, setF, applied, page, setPage, set, reset, filtered } = useFilters<Filters>(EMPTY, preset)
  const [data, setData] = useState<Page | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const seq = useRef(0)
  const desktop = useDesktopChrome()
  const [showFilters, setShowFilters] = useState(!!preset?.guest)

  useEffect(() => { api<AdminUser[]>('GET', '/api/admin/users').then(setUsers).catch(() => {}) }, [])

  const load = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    setError('')
    const p = query(applied, reveal)
    p.set('page', String(page))
    p.set('limit', String(LIMIT))
    try {
      const r = await api<Page>('GET', `/api/admin/claims?${p}`)
      if (id === seq.current) { setData(r); setPicked(new Set()) }
    } catch (e) {
      if (id === seq.current) setError(errMsg(e))
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [applied, reveal, page])
  useEffect(() => { void load() }, [load])

  const doExport = async () => {
    try {
      await download(`/api/admin/claims/export?${query(applied, reveal)}`, `wishy-claims-${new Date().toISOString().slice(0, 10)}.csv`)
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const release = async (c: Claim) => {
    if (!(await confirm({ title: t('audit.claims.release.title'), text: t('audit.claims.release.text', { wish: c.wish_title ?? '' }), confirmLabel: t('audit.claims.release.confirm'), destructive: true }))) return
    try {
      await api('POST', `/api/admin/claims/${c.reservation_id}/release${reveal ? '?reveal_own=1' : ''}`)
      toast(t('audit.claims.release.done'), 'ok')
      void load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const items = data?.items ?? []
  const removable = items.filter((c) => c.state === 'active' && c.reservation_id != null)
  const bulkDelete = async () => {
    if (!picked.size) return
    if (!(await confirm({ title: t('audit.claims.bulk.title', { count: picked.size }), text: t('audit.claims.bulk.text'), confirmLabel: t('audit.claims.release.confirm'), destructive: true }))) return
    try {
      const r = await api<{ deleted: number }>('POST', `/api/admin/claims/delete${reveal ? '?reveal_own=1' : ''}`, { ids: [...picked] })
      toast(t('audit.claims.bulk.done', { count: r.deleted }), 'ok')
      setSelecting(false)
      void load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const activeFilters = (['owner', 'by', 'state', 'ip', 'guest'] as const).filter((k) => applied[k] !== '').length
  const searchField = (
    <Field label={t('audit.claims.filter.search')} className="lg:col-span-2">
      <SearchField icon={Search} type="search" enterKeyHint="search" autoComplete="off" placeholder={t('audit.claims.filter.searchPlaceholder')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
    </Field>
  )

  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('audit.claims.title')} sub={t('audit.claims.sub')} actions={<Button icon={Download} onClick={doExport}>{t('audit.claims.export')}</Button>} />
      <Section>
        {viewSwitch}
        <ProxyIpWarning />
        <HiddenOwnBanner hidden={data?.hidden_own ?? 0} revealed={reveal} onReveal={() => { setReveal(true); setPage(1) }} onHide={() => { setReveal(false); setPage(1) }} />
        <Card className="space-y-4">
          {!desktop && searchField}
          {!desktop && <ToggleLink chevron on={showFilters} onToggle={() => setShowFilters(!showFilters)} labelOn={t('audit.filter.hide')} labelOff={activeFilters ? t('audit.filter.showActive', { count: activeFilters }) : t('audit.filter.show')} className="self-start" />}
          {(desktop || showFilters) && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('audit.claims.filter.owner')}>
              <Select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} searchable options={[{ value: '', label: t('audit.claims.filter.allOwners') }, ...users.map((u) => ({ value: u.id, label: u.name, meta: u.email }))]} />
            </Field>
            <Field label={t('audit.claims.filter.by')} group>
              <Segmented label={t('audit.claims.filter.by')} value={f.by} onChange={(v) => setF({ ...f, by: v })} options={[{ value: '', label: t('audit.filter.any') }, { value: 'user', label: t('audit.claims.by.user') }, { value: 'guest', label: t('audit.claims.by.guest') }]} />
            </Field>
            <Field label={t('audit.claims.filter.state')} group>
              <Segmented label={t('audit.claims.filter.state')} value={f.state} onChange={(v) => setF({ ...f, state: v })} options={[{ value: '', label: t('audit.filter.any') }, { value: 'active', label: t('audit.claims.state.active') }, { value: 'released', label: t('audit.claims.state.released') }]} />
            </Field>
            <Field label={t('audit.filter.ip')}>
              <input className="input font-mono text-sm" type="text" enterKeyHint="search" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={t('audit.filter.ipPlaceholder')} value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} />
            </Field>
            <Field label={t('audit.claims.filter.guest')}>
              <input className="input font-mono text-sm" type="text" enterKeyHint="search" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder={t('audit.claims.filter.guestPlaceholder')} value={f.guest} onChange={(e) => setF({ ...f, guest: e.target.value })} />
            </Field>
            {desktop && searchField}
          </div>}
          {filtered && <div><Button variant="link" onClick={reset}>{t('audit.filter.reset')}</Button></div>}
        </Card>

        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {!selecting ? (
              removable.length > 0 && <Button size="sm" onClick={() => setSelecting(true)}>{t('audit.claims.select')}</Button>
            ) : (
              <>
                <span className="meta font-medium">{t('audit.claims.selected', { count: picked.size })}</span>
                <Button size="sm" onClick={() => setPicked(new Set(removable.map((c) => c.reservation_id as number)))}>{t('audit.claims.selectAll')}</Button>
                <Button size="sm" variant="danger" icon={Trash2} disabled={!picked.size} onClick={() => void bulkDelete()}>{t('audit.claims.bulk')}</Button>
                <Button size="sm" variant="ghost" onClick={() => { setSelecting(false); setPicked(new Set()) }}>{t('common.cancel')}</Button>
              </>
            )}
          </div>
        )}
        <FormError>{error}</FormError>
        {items.length === 0 && !loading && !error ? (
          <EmptyState icon={HandHeart}>{filtered ? t('audit.claims.emptyFiltered') : t('audit.claims.empty')}</EmptyState>
        ) : (
          <div className={`card divide-y divide-line overflow-hidden transition-opacity ${loading && items.length ? 'opacity-70' : ''}`} aria-busy={loading}>
            {items.map((c) => (
              <ClaimRow
                key={c.key}
                c={c}
                selecting={selecting}
                selected={c.reservation_id != null && picked.has(c.reservation_id)}
                onSelect={(v) => setPicked((s) => { const n = new Set(s); if (c.reservation_id != null) (v ? n.add(c.reservation_id) : n.delete(c.reservation_id)); return n })}
                onIp={(ip) => set({ ip })}
                onGuest={(guest) => set({ guest })}
                onRelease={release}
              />
            ))}
            {loading && !items.length && <div className="px-4 py-6 text-center text-muted text-sm">{t('admin.loading')}</div>}
          </div>
        )}
        {data && data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="meta">{t('audit.claims.page', { page: data.page, pages: data.pages, total: data.total })}</span>
            <div className="flex gap-2">
              <Button disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>{t('audit.claims.prev')}</Button>
              <Button disabled={loading || page >= data.pages} onClick={() => setPage(page + 1)}>{t('audit.claims.next')}</Button>
            </div>
          </div>
        )}
        <p className="meta">{t('audit.claims.historyNote')}</p>
      </Section>
    </div>
  )
}

interface GuestFilters { ip: string; guest: string; active: boolean; q: string }
const GUEST_EMPTY: GuestFilters = { ip: '', guest: '', active: false, q: '' }

/** Guests of all lists: who they are, how many active reservations, first/last seen, IP and device; delete a guest */
function GuestsView({ reveal, setReveal, viewSwitch, onShowClaims }: ViewProps & { onShowClaims: (code: string) => void }) {
  useT()
  const toast = useToast()
  const confirm = useConfirm()
  const { f, setF, applied, page, setPage, set, reset, filtered } = useFilters<GuestFilters>(GUEST_EMPTY)
  const [data, setData] = useState<GuestPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    setError('')
    const p = new URLSearchParams({ page: String(page), limit: String(LIMIT) })
    if (applied.q.trim()) p.set('q', applied.q.trim())
    if (applied.ip.trim()) p.set('ip', applied.ip.trim())
    if (applied.guest.trim()) p.set('guest', applied.guest.trim())
    if (applied.active) p.set('active', '1')
    if (reveal) p.set('reveal_own', '1')
    try {
      const r = await api<GuestPage>('GET', `/api/admin/guests?${p}`)
      if (id === seq.current) setData(r)
    } catch (e) {
      if (id === seq.current) setError(errMsg(e))
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [applied, reveal, page])
  useEffect(() => { void load() }, [load])

  const remove = async (g: GuestRow) => {
    if (!(await confirm({ title: t('audit.guests.delete.title'), text: t('audit.guests.delete.text', { name: g.name, code: g.code }), confirmLabel: t('audit.guests.delete.confirm'), destructive: true }))) return
    try {
      await api('DELETE', `/api/admin/guests/${g.id}${reveal ? '?reveal_own=1' : ''}`)
      toast(t('audit.guests.delete.done'), 'ok')
      void load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const items = data?.items ?? []
  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('audit.claims.view.guests')} sub={t('audit.guests.sub')} />
      <Section>
        {viewSwitch}
        <ProxyIpWarning />
        <HiddenOwnBanner hidden={data?.hidden_own ?? 0} revealed={reveal} onReveal={() => { setReveal(true); setPage(1) }} onHide={() => { setReveal(false); setPage(1) }} />
        <Card className="space-y-4">
          <Field label={t('audit.claims.filter.search')}>
            <SearchField icon={Search} type="search" enterKeyHint="search" autoComplete="off" placeholder={t('audit.guests.searchPlaceholder')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          </Field>
          <Checkbox checked={f.active} onChange={(v) => set({ active: v })}>{t('audit.guests.onlyActive')}</Checkbox>
          {(f.guest || f.ip) && <p className="meta">{[f.guest && t('audit.claims.guestId', { code: f.guest }), f.ip].filter(Boolean).join(' · ')}</p>}
          {filtered && <div><Button variant="link" onClick={reset}>{t('audit.filter.reset')}</Button></div>}
        </Card>
        <FormError>{error}</FormError>
        {items.length === 0 && !loading && !error ? (
          <EmptyState icon={HandHeart}>{filtered ? t('audit.guests.emptyFiltered') : t('audit.guests.empty')}</EmptyState>
        ) : (
          <div className={`card divide-y divide-line overflow-hidden transition-opacity ${loading && items.length ? 'opacity-70' : ''}`} aria-busy={loading}>
            {items.map((g) => (
              <div key={g.id} className="px-4 py-3 flex flex-wrap items-start gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="font-medium break-words flex flex-wrap items-center gap-x-2">{g.name}<span className="font-mono text-xs text-muted">{g.code}</span></div>
                  <div className="meta break-words">{[g.list_title, nameOf(g.owner) ? t('audit.claims.ownerOf', { name: nameOf(g.owner) ?? '' }) : null].filter(Boolean).join(' · ')}</div>
                  <div className="mt-1 text-sm flex flex-wrap items-center gap-2">
                    <Badge tone={g.claims ? 'ok' : 'neutral'}>{t('audit.guests.claims', { count: g.claims })}</Badge>
                    {g.claims > 0 && <Button size="sm" variant="link" onClick={() => onShowClaims(g.code)}>{t('audit.guests.showClaims')}</Button>}
                  </div>
                </div>
                <div className="min-w-0 basis-52 grow-0 shrink flex flex-col gap-0.5 sm:items-end sm:text-right">
                  <span className="meta num">{t('audit.guests.firstSeen', { date: fmtDateTime(g.created_at) })}</span>
                  <span className="meta num">{t('audit.guests.lastSeen', { date: fmtDateTime(g.last_seen_at) })}</span>
                  <IpButton ip={g.ip} onPick={(ip) => set({ ip })} />
                  {g.device && <span className="meta truncate max-w-full" title={g.user_agent ?? undefined}>{g.device}</span>}
                </div>
                <div className="ml-auto sm:ml-0">
                  <Button size="sm" variant="danger" icon={UserRoundX} onClick={() => void remove(g)}>{t('audit.guests.delete')}</Button>
                </div>
              </div>
            ))}
            {loading && !items.length && <div className="px-4 py-6 text-center text-muted text-sm">{t('admin.loading')}</div>}
          </div>
        )}
        {data && data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="meta">{t('audit.claims.page', { page: data.page, pages: data.pages, total: data.total })}</span>
            <div className="flex gap-2">
              <Button disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>{t('audit.claims.prev')}</Button>
              <Button disabled={loading || page >= data.pages} onClick={() => setPage(page + 1)}>{t('audit.claims.next')}</Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}

/** Admin › Reservations: the reservations and, in a second view, the guests behind them */
export function AdminClaims() {
  useT()
  const [view, setView] = useState<'claims' | 'guests'>('claims')
  const [reveal, setReveal] = useState(false) // deliberate reveal of claims on the admin's own lists (not persisted)
  const [preset, setPreset] = useState<{ guest: string; n: number } | null>(null)
  const viewSwitch = (
    <Segmented label={t('audit.claims.view')} value={view} onChange={setView} options={[{ value: 'claims', label: t('audit.claims.view.claims') }, { value: 'guests', label: t('audit.claims.view.guests') }]} />
  )
  return view === 'guests'
    ? <GuestsView reveal={reveal} setReveal={setReveal} viewSwitch={viewSwitch} onShowClaims={(guest) => { setPreset({ guest, n: Date.now() }); setView('claims') }} />
    : <ClaimsView key={preset?.n ?? 0} reveal={reveal} setReveal={setReveal} viewSwitch={viewSwitch} preset={preset ? { guest: preset.guest } : undefined} />
}
