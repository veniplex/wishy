import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, Bell, BellOff, Check, ExternalLink, Gift as GiftIcon, Heart, House, Link2, LogOut, Lock, LogIn, Pencil, Plus, RotateCcw, Share2, Star, Trash2, Undo2, Users } from 'lucide-react'
import { api, errMsg, spaceLabel, type KnownUser, type ListView, type MyWishlist, type PublicView, type SharedSummary, type SharedWish, type Wish, type WishlistsOverview } from './api'
import { rememberNext, useAuth } from './auth'
import { realId } from './offline/engine'
import { useIds, useOnData } from './offline/hooks'
import { useStore } from './store'
import { fmtDate, type State } from './lib'
import { AiImportButton } from './ai'
import { ListForm, WishForm } from './forms'
import { WishDetail } from './detail-dialog'
import { listTabs } from './nav'
import { LanguageMenu } from './i18n/switch'
import { t } from './i18n'
import { UserAvatar } from './user-avatar'
import { Badge, Banner, Brand, Button, CopyField, EmptyState, Field, FormError, IconButton, List, Modal, Money, Page, PageHeader, PageSkeleton, Row, Section, Segmented, Select, Stars, Switch, Thumb, TintAvatar, ToggleLink, tintOf, useConfirm, useToast } from './ui'

const GUEST_KEY = 'guestName'
const savedGuest = () => {
  try { return localStorage.getItem(GUEST_KEY) ?? '' } catch { return '' }
}
const count = (n: number) => t('wishlists.wishCount', { count: n })
const isShared = (w: Wish | SharedWish): w is SharedWish => 'reserved' in w

// ───────────────────────────── Reserving ─────────────────────────────

function GuestNameDialog({ item, onSubmit, onCancel }: { item: Wish; onSubmit: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(savedGuest())
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void onSubmit(name.trim()) }}>
      <Modal compact title={t('wishlists.reserve')} onClose={onCancel} footer={<><span className="flex-1" /><Button onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" type="submit" disabled={!name.trim()}>{t('wishlists.reserve')}</Button></>}>
        <p className="text-sm text-muted">{t('wishlists.guest.text', { title: item.title })}</p>
        <Field label={t('wishlists.guest.name')} hint={t('wishlists.guest.hint')}>
          <input className="input" required autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Modal>
    </form>
  )
}

/** Choose the space in which the gift is planned */
function SpaceChoice({ item, onPick, onCancel }: { item: Wish; onPick: (spaceId: number) => void; onCancel: () => void }) {
  const { spaces, spaceId } = useAuth()
  const [id, setId] = useState(spaceId ?? spaces[0]?.id ?? 0)
  return (
    <Modal compact title={t('wishlists.plan.title')} onClose={onCancel} footer={<><span className="flex-1" /><Button onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => onPick(id)}>{t('wishlists.reservePlan')}</Button></>}>
      <p className="text-sm text-muted">{t('wishlists.plan.text', { title: item.title })}</p>
      <Field label={t('wishlists.plan.space')}>
        <Select value={id} onChange={(e) => setId(Number(e.target.value))}>
          {spaces.map((s) => <option key={s.id} value={s.id}>{spaceLabel(s)}</option>)}
        </Select>
      </Field>
    </Modal>
  )
}

/** Reserve/release; `onView` receives the returned view. `token` only on the public page. */
function useReserve<V>({ token, loggedIn, onView, onPlanned }: { token?: string; loggedIn: boolean; onView: (v: V) => void; onPlanned?: (item: Wish, space?: number) => void }) {
  const toast = useToast()
  const { spaces } = useAuth()
  const [busy, setBusy] = useState<number | null>(null)
  const [ask, setAsk] = useState<{ kind: 'guest' | 'space'; item: Wish } | null>(null)

  const run = async (item: Wish, method: 'POST' | 'DELETE', body: { guest_name?: string; plan?: boolean }, space?: number) => {
    setBusy(item.id)
    try {
      onView(await api<V>(method, `/api/wishes/${item.id}/reserve`, { token, ...body }, { space }))
      if (body.plan) onPlanned?.(item, space)
      return true
    } catch (e) {
      toast(errMsg(e), 'bad')
      return false
    } finally {
      setBusy(null)
    }
  }

  return {
    busy,
    reserve: (item: Wish, plan = false) => {
      if (!loggedIn) return void setAsk({ kind: 'guest', item })
      if (plan && spaces.length > 1) return void setAsk({ kind: 'space', item })
      return run(item, 'POST', { plan })
    },
    release: (item: Wish) => run(item, 'DELETE', loggedIn ? {} : { guest_name: savedGuest() }),
    dialog: ask && (ask.kind === 'guest' ? (
      <GuestNameDialog
        item={ask.item}
        onCancel={() => setAsk(null)}
        onSubmit={async (name) => {
          try { localStorage.setItem(GUEST_KEY, name) } catch { /* storage blocked */ }
          if (await run(ask.item, 'POST', { guest_name: name })) setAsk(null)
        }}
      />
    ) : (
      <SpaceChoice item={ask.item} onCancel={() => setAsk(null)} onPick={async (sid) => { if (await run(ask.item, 'POST', { plan: true }, sid)) setAsk(null) }} />
    )),
  }
}

const WishLink = ({ w }: { w: Wish }) => w.url
  ? <a href={w.url} target="_blank" rel="noreferrer" className="hit text-muted hover:text-accent" title={t('wishlists.openLink')} aria-label={t('wishlists.openLinkTo', { title: w.title })}><ExternalLink size={14} /></a>
  : null

/** Wishes for viewers (users with access or guests): reserve, release, plan */
function SharedWishRows({ wishes, viewer, token, onView, onPlanned, empty }: {
  wishes: (Wish | SharedWish)[]
  viewer: 'user' | 'guest'
  token?: string
  onView: (v: never) => void
  onPlanned?: (item: Wish, space?: number) => void
  empty: ReactNode
}) {
  const res = useReserve<never>({ token, loggedIn: viewer === 'user', onView, onPlanned })
  return (
    <>
      <List empty={empty}>
        {wishes.filter((w) => w.status !== 'removed').map((w) => {
          const reserved = isShared(w) && w.reserved
          const mine = isShared(w) && w.reserved_by_me
          const received = w.status === 'received'
          return (
            <Row
              key={w.id}
              lead={<Thumb src={w.image_url} icon={Heart} />}
              title={w.title}
              titleSuffix={<><Stars n={w.priority} /><WishLink w={w} /></>}
              meta={w.notes}
              dim={received || (reserved && !mine)}
              trailing={
                <>
                  {w.price != null && <Money n={w.price} currency={w.currency} strong />}
                  {received && <Badge tone="ok" icon={Check}>{t('wishlists.received')}</Badge>}
                  {!received && reserved && <Badge tone={mine ? 'ok' : 'warn'} icon={Lock}>{mine ? t('wishlists.reservedByYou') : isShared(w) && w.reserved_by ? t('wishlists.reservedBy', { name: w.reserved_by }) : t('wishlists.reserved')}</Badge>}
                </>
              }
              actions={!received && (
                reserved ? (
                  mine && <Button size="sm" variant="ghost" icon={Undo2} disabled={res.busy === w.id} onClick={() => res.release(w)}>{t('wishlists.release')}</Button>
                ) : (
                  <>
                    <Button size="sm" icon={Check} disabled={res.busy === w.id} onClick={() => res.reserve(w)}>{t('wishlists.reserve')}</Button>
                    {viewer === 'user' && <Button size="sm" variant="accent" icon={GiftIcon} disabled={res.busy === w.id} title={t('wishlists.reservePlanTitle')} onClick={() => res.reserve(w, true)}>{t('wishlists.reservePlan')}</Button>}
                  </>
                )
              )}
            />
          )
        })}
      </List>
      {res.dialog}
    </>
  )
}

/** After "Reserve & plan": reload state; if the gift has no recipient, point that out and offer to open it */
function usePlanned(ownerName: string) {
  const store = useStore()
  const confirm = useConfirm()
  const toast = useToast()
  const { spaceId } = useAuth()
  return async (item: Wish, space?: number) => {
    const sp = space ?? spaceId ?? undefined
    await store?.reload()
    try {
      const st = await api<State>('GET', '/api/state', undefined, { space: sp })
      const g = st.gifts.find((x) => x.wish_id === item.id)
      if (g && !g.recipient_ids.length) {
        if (store && sp === spaceId && (await confirm({ title: t('wishlists.planned.title'), text: t('wishlists.planned.text', { name: ownerName }), confirmLabel: t('wishlists.planned.open'), cancelLabel: t('wishlists.planned.later') }))) store.open({ type: 'gift', initial: g })
        else if (!store || sp !== spaceId) toast(t('wishlists.planned.noRecipient'), 'info')
        return
      }
    } catch { /* convenience only */ }
    toast(t('wishlists.planned.done'), 'ok')
  }
}

// ───────────────────────────── Sharing ─────────────────────────────

export function ShareDialog({ list, onClose, onChange }: { list: MyWishlist; onClose: () => void; onChange: (l: MyWishlist) => void }) {
  const confirm = useConfirm()
  const [l, setL] = useState(list)
  const { spaces } = useAuth()
  const shareable = spaces.filter((x) => !x.personal)
  const [tab, setTab] = useState<'link' | 'users' | 'spaces'>('link')
  const [known, setKnown] = useState<KnownUser[]>([])
  const [pick, setPick] = useState(0)
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { api<KnownUser[]>('GET', '/api/users/known').then(setKnown).catch(() => {}) }, [])

  const act = async (method: string, url: string, body?: unknown) => {
    setError('')
    try {
      const next = await api<MyWishlist>(method, url, body)
      setL(next)
      onChange(next)
      return true
    } catch (e) {
      setError(errMsg(e))
      return false
    }
  }
  const regenerate = async () => {
    if (!(await confirm({ title: t('wishlists.share.regenTitle'), text: t('wishlists.share.regenText'), confirmLabel: t('wishlists.share.regen'), destructive: true }))) return
    await act('POST', `/api/wishlists/${l.id}/share`, { regenerate: true })
  }
  const available = known.filter((u) => !l.access.some((a) => a.user_id === u.id))
  return (
    <Modal title={t('wishlists.share.title', { title: l.title })} onClose={onClose} footer={<><span className="flex-1" /><Button variant="primary" onClick={onClose}>{t('common.done')}</Button></>}>
      <Segmented label={t('wishlists.share.with')} value={tab} onChange={setTab} options={[{ value: 'link', label: t('wishlists.share.tabLink'), icon: Link2 }, { value: 'users', label: `${t('wishlists.share.tabUsers')}${l.access.length ? ` (${l.access.length})` : ''}`, icon: Users }, ...(shareable.length ? [{ value: 'spaces' as const, label: `${t('wishlists.share.tabSpace')}${l.spaces?.length ? ` (${l.spaces.length})` : ''}`, icon: House }] : [])]} />
      {tab === 'link' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('wishlists.share.linkText')} <strong className="text-ink font-medium">{t('wishlists.share.linkTextStrong')}</strong></p>
          <Field label={t('wishlists.share.linkAccess')} group>
            <Segmented label={t('wishlists.share.linkAccess')} value={l.link_enabled ? 'on' : 'off'} onChange={(v) => act('POST', `/api/wishlists/${l.id}/share`, { link_enabled: v === 'on' })} options={[{ value: 'off', label: t('wishlists.share.off') }, { value: 'on', label: t('wishlists.linkActive') }]} />
          </Field>
          {l.link_enabled ? (
            <>
              <CopyField label={t('wishlists.share.linkLabel')} value={l.full_url} />
              <Button size="sm" variant="danger" icon={RotateCcw} onClick={regenerate}>{t('wishlists.share.regen')}</Button>
            </>
          ) : (
            <p className="meta">{t('wishlists.share.linkOff')}</p>
          )}
        </div>
      ) : tab === 'spaces' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('wishlists.share.spaceText', { tab: t('nav.tabs.lists.shared') })}</p>
          <div className="space-y-2">
            {shareable.map((sp) => {
              const on = !!l.spaces?.some((x) => x.space_id === sp.id)
              return (
                <div key={sp.id} className="rounded-2xl bg-hover px-4 py-3">
                  <Switch checked={on} disabled={!on && !sp.permissions.share_wishlists} onChange={(v) => void (v ? act('POST', `/api/wishlists/${l.id}/spaces`, { space_id: sp.id }) : act('DELETE', `/api/wishlists/${l.id}/spaces/${sp.id}`))}>
                    <span className="font-semibold">{t('wishlists.share.withSpace', { space: sp.name })}</span>
                    <span className="block meta mt-0.5">{!on && !sp.permissions.share_wishlists ? t('wishlists.share.noPermission') : t('wishlists.share.allMembers', { count: sp.member_count })}</span>
                  </Switch>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('wishlists.share.usersText', { tab: t('nav.tabs.lists.shared') })}</p>
          {available.length > 0 && (
            <form className="flex gap-2 items-end" onSubmit={async (e) => { e.preventDefault(); if (pick && (await act('POST', `/api/wishlists/${l.id}/access`, { user_id: pick }))) setPick(0) }}>
              <Field label={t('wishlists.share.pickUser')} className="flex-1 min-w-0">
                <Select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
                  <option value={0}>{t('controls.picker.pleaseChoose')}</option>
                  {available.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                </Select>
              </Field>
              <Button type="submit" disabled={!pick}>{t('wishlists.share.action')}</Button>
            </form>
          )}
          <form className="flex gap-2 items-end" onSubmit={async (e) => { e.preventDefault(); if (await act('POST', `/api/wishlists/${l.id}/access`, { email })) setEmail('') }}>
            <Field label={t('wishlists.share.byEmail')} className="flex-1 min-w-0"><input className="input" type="email" required placeholder={t('wishlists.share.emailPlaceholder')} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Button type="submit">{t('wishlists.share.action')}</Button>
          </form>
          <List>
            {l.access.map((a) => (
              <Row key={a.user_id} dense lead={<UserAvatar userId={a.user_id} name={a.name} size={32} />} title={a.name} trailing={<Badge tone={a.via === 'direct' ? 'accent' : 'neutral'}>{a.via === 'direct' ? t('wishlists.share.direct') : t('wishlists.share.viaLink')}</Badge>} actions={<IconButton icon={Trash2} size="sm" variant="danger" label={t('wishlists.share.removeUser', { name: a.name })} onClick={() => act('DELETE', `/api/wishlists/${l.id}/access/${a.user_id}`)} />} />
            ))}
          </List>
        </div>
      )}
      <FormError>{error}</FormError>
    </Modal>
  )
}

// ───────────────────────────── My lists ─────────────────────────────

/** Header of a list card: three tinted tiles */
function Cover({ id }: { id: number }) {
  const icons = [Heart, GiftIcon, Star]
  return (
    <div className="flex gap-1.5 h-28">
      {icons.map((Icon, k) => (
        <div key={k} className="flex-1 min-w-0 rounded-2xl grid place-items-center text-ink" style={{ background: tintOf(Math.abs(id) + k * 2) }}>
          <Icon size={30} strokeWidth={1.5} />
        </div>
      ))}
    </div>
  )
}

function ListCard({ to, id, title, meta, chips, dim }: { to: string; id: number; title: string; meta: ReactNode; chips: ReactNode; dim?: boolean }) {
  return (
    <Link to={to} className={`card p-3 pb-5 flex flex-col gap-3.5 min-w-0 hover:brightness-[0.98] transition ${dim ? 'opacity-70' : ''}`}>
      <Cover id={id} />
      <div className="px-2 flex flex-col gap-2.5 flex-1">
        <div>
          <div className="font-display font-semibold text-[22px] leading-tight break-words">{title}</div>
          <div className="text-sm text-muted">{meta}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">{chips}</div>
      </div>
    </Link>
  )
}

export function MyLists() {
  const { sharedUnseen } = useAuth()
  const nav = useNavigate()
  const [data, setData] = useState<WishlistsOverview | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const load = useCallback(() => api<WishlistsOverview>('GET', '/api/wishlists').then((o) => { setData(o); setError('') }).catch((e) => setError(errMsg(e))), [])
  useEffect(() => { void load() }, [load])
  useOnData(load)
  const card = (l: MyWishlist) => (
    <ListCard
      key={l.id}
      to={`/wishlists/${l.id}`}
      id={l.id}
      dim={!!l.archived}
      title={l.title}
      meta={[l.event_date && fmtDate(l.event_date), count(l.wish_count)].filter(Boolean).join(' · ')}
      chips={
        <>
          {l.archived ? <Badge>{t('wishlists.archived')}</Badge> : null}
          {l.link_enabled ? <Badge tone="info" icon={Link2}>{t('wishlists.linkActive')}</Badge> : null}
          {l.access.length > 0 ? <Badge icon={Users}>{t('wishlists.personCount', { count: l.access.length })}</Badge> : null}
          {l.spaces?.map((sp) => <Badge key={sp.space_id} tone="accent" icon={House}>{sp.name}</Badge>)}
          {!l.link_enabled && !l.access.length && !l.spaces?.length && !l.archived ? <Badge icon={Lock}>{t('wishlists.onlyYou')}</Badge> : null}
        </>
      }
    />
  )
  const active = data?.mine.filter((l) => !l.archived) ?? []
  const archived = data?.mine.filter((l) => l.archived) ?? []
  return (
    <Page>
      <PageHeader title={t('nav.main.lists')} sub={t('wishlists.sub')} tabs={listTabs(sharedUnseen)} />
      {error && <FormError>{error}</FormError>}
      {!data && !error ? <PageSkeleton /> : (
        <section className="grid gap-4 md:gap-5 grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))]">
          {active.map(card)}
          <button type="button" onClick={() => setCreating(true)} className="min-h-32 md:min-h-60 rounded-[22px] md:rounded-[26px] border-2 border-dashed border-line p-4 md:p-5 flex flex-col items-center justify-center gap-3 text-muted text-center cursor-pointer hover:border-accent transition-colors">
            <span className="size-14 rounded-full bg-card text-accent shadow-sm grid place-items-center"><Plus size={26} strokeWidth={2.4} /></span>
            <span className="font-display font-semibold text-xl text-ink">{t('wishlists.new')}</span>
          </button>
        </section>
      )}
      {archived.length > 0 && <ToggleLink on={showArchived} onToggle={() => setShowArchived(!showArchived)} labelOn={t('wishlists.hideArchived')} labelOff={t('wishlists.showArchived', { count: archived.length })} />}
      {showArchived && <section className="grid gap-4 md:gap-5 grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))]">{archived.map(card)}</section>}
      {creating && <ListForm onClose={() => setCreating(false)} onSaved={(l) => l && nav(`/wishlists/${l.id}`)} />}
    </Page>
  )
}

// ───────────────────────────── Shared with me ─────────────────────────────

const sharedCard = (l: SharedSummary, withOwner = false) => (
  <ListCard
    key={l.id}
    to={`/wishlists/${l.id}`}
    id={l.id}
    title={l.title}
    meta={[withOwner && l.owner.name, l.event_date && fmtDate(l.event_date), count(l.wish_count)].filter(Boolean).join(' · ')}
    chips={<>{l.is_new ? <Badge tone="accent">{t('wishlists.newBadge')}</Badge> : <Badge>{t('wishlists.openCount', { count: l.open_count })}</Badge>}{l.via === 'space' && l.space_name ? <Badge icon={House}>{t('wishlists.viaSpace', { space: l.space_name })}</Badge> : null}</>}
  />
)

export function SharedWithMe() {
  const { sharedUnseen } = useAuth()
  const [data, setData] = useState<WishlistsOverview | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => api<WishlistsOverview>('GET', '/api/wishlists').then((o) => { setData(o); setError('') }).catch((e) => setError(errMsg(e))), [])
  useEffect(() => { void load() }, [load])
  useOnData(load)
  const owners = [...new Map((data?.shared ?? []).map((l) => [l.owner.id, l.owner])).values()]
  return (
    <Page>
      <PageHeader title={t('nav.main.lists')} sub={t('wishlists.sub')} tabs={listTabs(sharedUnseen)} />
      {error && <FormError>{error}</FormError>}
      {!data && !error ? <PageSkeleton /> : !owners.length ? (
        <EmptyState icon={Heart}>{t('wishlists.sharedEmpty')}</EmptyState>
      ) : owners.map((o) => (
        <Section key={o.id} title={o.name}>
          <div className="grid gap-4 md:gap-5 grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))]">{data!.shared.filter((l) => l.owner.id === o.id).map((l) => sharedCard(l))}</div>
        </Section>
      ))}
    </Page>
  )
}

/** Home: newly shared lists */
export function NewShared({ className }: { className?: string }) {
  const { sharedUnseen } = useAuth()
  const [lists, setLists] = useState<SharedSummary[]>([])
  useEffect(() => {
    if (sharedUnseen > 0) api<WishlistsOverview>('GET', '/api/wishlists').then((o) => setLists(o.shared.filter((l) => l.is_new))).catch(() => {})
  }, [sharedUnseen])
  if (!sharedUnseen || !lists.length) return null
  return (
    <Section className={className} eyebrow={t('nav.main.lists')} title={t('wishlists.newShared')}>
      <div className="flex flex-col gap-4">
        {lists.slice(0, 3).map((l) => (
          <div key={l.id} className="card p-5 flex flex-wrap items-center gap-4">
            <TintAvatar name={l.owner.name} id={l.owner.id} size={56} />
            <div className="flex-1 basis-40 min-w-0">
              <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-lg">{l.title}</span><Badge tone="accent">{t('wishlists.newBadge')}</Badge></div>
              <div className="text-sm text-muted">{t('wishlists.listOf', { name: l.owner.name })}</div>
            </div>
            <Button to={`/wishlists/${l.id}`}>{t('wishlists.view')}</Button>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ───────────────────────────── Detail page ─────────────────────────────

/** /wishlists/:id – own list (edit) or shared list (reserve) */
export function WishlistDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const confirm = useConfirm()
  const toast = useToast()
  const { refresh } = useAuth()
  const [view, setView] = useState<ListView | null>(null)
  const [error, setError] = useState('')
  const [wishForm, setWishForm] = useState<{ initial?: Partial<Wish> } | null>(null)
  /** Id of the wish whose read-only detail dialog is open */
  const [wishDetail, setWishDetail] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const planned = usePlanned((view?.wishlist as SharedSummary | undefined)?.owner?.name ?? t('wishlists.thePerson'))

  const load = useCallback(() => api<ListView>('GET', `/api/wishlists/${id}`).then((v) => { setView(v); setError('') }).catch((e) => setError(errMsg(e))), [id])
  useEffect(() => {
    setView(null)
    void load().then(() => refresh())
  }, [load, refresh])
  useOnData(load)
  // A list created offline got its real id
  useIds()
  const real = realId(Number(id))
  if (real !== Number(id)) return <Navigate to={`/wishlists/${real}`} replace />

  if (error) return <Page><EmptyState icon={Lock} action={<Button size="sm" to="/wishlists">{t('wishlists.toLists')}</Button>}>{error}</EmptyState></Page>
  if (!view) return <PageSkeleton />
  const l = view.wishlist
  const wishes = view.wishes.filter((w) => w.status !== 'removed')

  if (!view.is_owner) {
    const s = l as SharedSummary
    const leave = async () => {
      if (!(await confirm({ title: t('wishlists.leave.title'), text: t('wishlists.leave.text', { title: s.title, tab: t('nav.tabs.lists.shared'), owner: s.owner.name }), confirmLabel: t('wishlists.leave.confirm'), destructive: true }))) return
      try {
        await api('DELETE', `/api/wishlists/${s.id}/access/me`)
        await refresh()
        nav('/wishlists/shared', { replace: true })
      } catch (e) {
        toast(errMsg(e), 'bad')
      }
    }
    return (
      <Page>
        <PageHeader
          back={{ to: '/wishlists/shared', label: t('nav.tabs.lists.shared') }}
          title={s.title}
          sub={[t('wishlists.by', { name: s.owner.name }), s.event_date && fmtDate(s.event_date), s.description].filter(Boolean).join(' · ')}
          actions={<Button icon={LogOut} onClick={leave}>{t('wishlists.leave.action')}</Button>}
        />
        <Section>
          <SharedWishRows
            wishes={wishes}
            viewer="user"
            onView={(v) => setView(v as ListView)}
            onPlanned={planned}
            empty={<EmptyState icon={Heart}>{t('wishlists.noOpenWishes', { name: s.owner.name })}</EmptyState>}
          />
        </Section>
      </Page>
    )
  }

  const mine = l as MyWishlist
  const move = async (i: number, dir: -1 | 1) => {
    const next = [...wishes]
    ;[next[i], next[i + dir]] = [next[i + dir], next[i]]
    setView({ ...view, wishes: next })
    try {
      await api('POST', `/api/wishlists/${mine.id}/reorder`, { ids: next.map((w) => w.id) })
    } catch (e) {
      toast(errMsg(e), 'bad')
      void load()
    }
  }
  const setStatus = async (w: Wish, status: Wish['status']) => {
    try {
      await api('PUT', `/api/wishes/${w.id}`, { status })
      void load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const remove = async (w: Wish) => {
    if (!(await confirm({ title: t('wishlists.removeTitle', { title: w.title }), text: t('wishlists.removeText'), confirmLabel: t('spaces.remove'), destructive: true }))) return
    try {
      await api('DELETE', `/api/wishes/${w.id}`)
      void load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  return (
    <Page>
      <PageHeader
        back={{ to: '/wishlists', label: t('nav.main.lists') }}
        title={mine.title}
        sub={
          <>
            {[mine.event_date && fmtDate(mine.event_date), mine.description].filter(Boolean).join(' · ')}{' '}
            {mine.archived ? <Badge>{t('wishlists.archived')}</Badge> : null}{' '}
            {mine.link_enabled ? <Badge tone="info" icon={Link2}>{t('wishlists.linkActive')}</Badge> : null}{' '}
            {mine.access.length > 0 && <Badge icon={Users}>{t('wishlists.personCount', { count: mine.access.length })}</Badge>}
          </>
        }
        actions={
          <>
            <IconButton icon={Pencil} label={t('wishlists.edit')} onClick={() => setEditing(true)} />
            {mine.id > 0 && <AiImportButton init={{ target: 'wishes', listId: mine.id }} onDone={() => void load()} label={t('wishlists.aiImport')} />}
            {mine.id > 0 && <Button icon={Share2} onClick={() => setSharing(true)}>{t('wishlists.share.action')}</Button>}
            <Button variant="primary" icon={Plus} onClick={() => setWishForm({})}>{t('wishlists.addWish')}</Button>
          </>
        }
      />
      <Section>
        <List empty={<EmptyState icon={Heart} action={<Button size="sm" icon={Plus} onClick={() => setWishForm({})}>{t('wishlists.addWish')}</Button>}>{t('wishlists.empty')}</EmptyState>}>
          {wishes.map((w, i) => (
            <Row
              key={w.id}
              lead={<Thumb src={w.image_url} icon={Heart} />}
              title={w.title}
              onClick={() => setWishDetail(w.id)}
              dim={w.status === 'received'}
              titleSuffix={<><Stars n={w.priority} /><WishLink w={w} /></>}
              meta={w.notes}
              trailing={<>{w.price != null && <Money n={w.price} currency={w.currency} strong />}{w.status === 'received' && <Badge tone="ok" icon={Check}>{t('wishlists.received')}</Badge>}</>}
              actions={
                <>
                  <IconButton icon={ArrowUp} size="sm" label={t('wishlists.up')} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon={ArrowDown} size="sm" label={t('wishlists.down')} disabled={i === wishes.length - 1} onClick={() => move(i, 1)} />
                  {w.status === 'received'
                    ? <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setStatus(w, 'open')}>{t('wishlists.reopen')}</Button>
                    : <Button size="sm" variant="ghost" icon={Check} onClick={() => setStatus(w, 'received')}>{t('wishlists.markReceived')}</Button>}
                  <IconButton icon={Trash2} size="sm" variant="danger" label={t('wishlists.removeTitle', { title: w.title })} onClick={() => remove(w)} />
                </>
              }
            />
          ))}
        </List>
      </Section>
      {wishDetail != null && wishes.find((w) => w.id === wishDetail) && (() => {
        const w = wishes.find((x) => x.id === wishDetail)!
        return <WishDetail w={w} canEdit onClose={() => setWishDetail(null)} onEdit={() => { setWishDetail(null); setWishForm({ initial: w }) }} onToggle={() => void setStatus(w, w.status === 'received' ? 'open' : 'received')} onDelete={() => void remove(w)} />
      })()}
      {wishForm && <WishForm listId={mine.id} initial={wishForm.initial} onClose={() => setWishForm(null)} onSaved={() => void load()} />}
      {editing && <ListForm initial={mine} onClose={() => setEditing(false)} onSaved={(n) => (n ? void load() : nav('/wishlists', { replace: true }))} />}
      {sharing && <ShareDialog list={mine} onClose={() => setSharing(false)} onChange={(n) => setView((v) => v && { ...v, wishlist: n })} />}
    </Page>
  )
}

// ───────────────────────────── Public view ─────────────────────────────

export function PublicShell({ children }: { children: ReactNode }) {
  const { appName } = useAuth()
  return (
    <div className="min-h-screen">
      <div className="max-w-[1120px] mx-auto px-4 md:px-10 pt-4 flex items-center justify-between gap-3">
        <Brand name={appName} />
        <div className="flex items-center gap-2"><LanguageMenu /><Button size="sm" variant="ghost" icon={LogIn} to="/login">{t('auth.login.title')}</Button></div>
      </div>
      {children}
    </div>
  )
}

/** /w/:token – a list shared via link (with or without sign-in) */
export function PublicWishlistBody() {
  const { token = '' } = useParams()
  const { status } = useAuth()
  const toast = useToast()
  const [view, setView] = useState<PublicView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const guest = status === 'ready' ? '' : savedGuest()
  const planned = usePlanned(view?.owner.name ?? t('wishlists.thePerson'))

  useEffect(() => {
    api<PublicView>('GET', `/api/shared/${encodeURIComponent(token)}${guest ? `?guest_name=${encodeURIComponent(guest)}` : ''}`)
      .then((v) => { setView(v); setError(null) })
      .catch((e) => setError(errMsg(e)))
  }, [token, guest, status])

  if (error) {
    return (
      <Page>
        <EmptyState icon={Lock} action={status === 'ready' ? <Button size="sm" to="/wishlists/shared">{t('wishlists.toShared', { tab: t('nav.tabs.lists.shared') })}</Button> : undefined}>{error}</EmptyState>
      </Page>
    )
  }
  if (!view) return <PageSkeleton />
  if (view.is_owner && status === 'ready') return <Navigate to={`/wishlists/${view.wishlist.id}`} replace />

  const viewer = status === 'ready' ? 'user' : 'guest'
  const toggleFollow = async () => {
    setBusy(true)
    try {
      setView(await api<PublicView>(view.following ? 'DELETE' : 'POST', `/api/shared/${encodeURIComponent(token)}/follow`))
      toast(view.following ? t('wishlists.unfollowed') : t('wishlists.followed', { tab: t('nav.tabs.lists.shared') }), 'ok')
    } catch (e) {
      toast(errMsg(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  const w = view.wishlist
  return (
    <Page>
      <PageHeader
        back={status === 'ready' ? { to: '/wishlists/shared', label: t('nav.tabs.lists.shared') } : undefined}
        title={w.title}
        sub={[t('wishlists.by', { name: view.owner.name }), w.event_date && fmtDate(w.event_date), w.description].filter(Boolean).join(' · ')}
        actions={viewer === 'user' && <Button icon={view.following ? BellOff : Bell} disabled={busy} onClick={toggleFollow}>{view.following ? t('wishlists.unfollow') : t('wishlists.follow')}</Button>}
      />
      {viewer === 'guest' && (
        <Banner icon={Heart} action={<Link to="/login" className="underline underline-offset-2 shrink-0" onClick={() => rememberNext(`/w/${token}`)}>{t('auth.login.title')}</Link>}>
          {t('wishlists.guestBanner')}
        </Banner>
      )}
      <Section>
        <SharedWishRows
          wishes={view.wishes}
          viewer={viewer}
          token={token}
          onView={(v) => setView(v as PublicView)}
          onPlanned={planned}
          empty={<EmptyState icon={Heart}>{t('wishlists.noOpenWishes', { name: view.owner.name })}</EmptyState>}
        />
      </Section>
    </Page>
  )
}

/** Wishlists of a linked person (PersonDetail) */
export function LinkedLists({ personName, lists }: { personName: string; lists: { id: number; title: string; wish_count: number; open_count: number }[] }) {
  return (
    <Section title={t('wishlists.listsOf', { name: personName })}>
      <List>
        {lists.map((l) => <Row key={l.id} to={`/wishlists/${l.id}`} lead={<Thumb icon={Heart} />} title={l.title} meta={`${count(l.wish_count)} · ${t('wishlists.openCount', { count: l.open_count })}`} />)}
      </List>
    </Section>
  )
}

