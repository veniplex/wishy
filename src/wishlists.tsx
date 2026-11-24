import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowDown, ArrowUp, ArrowUpDown, Bell, BellOff, Check, ExternalLink, EyeOff, Gift as GiftIcon, Heart, House, Link2, LogOut, Lock, LogIn, Pencil, Plus, RotateCcw, Share2, Star, Trash2, Undo2, Users } from 'lucide-react'
import { ApiError, api, errMsg, spaceLabel, type KnownUser, type ListView, type MyWishlist, type PublicView, type SharedSummary, type SharedWish, type Wish, type WishlistsOverview } from './api'
import { rememberNext, useAuth } from './auth'
import { mergeIntoLink, onLinkResult, publicApi, saveGuestName, savedGuestName, sharedUrl, takeLinkResult, takePublicView } from './guest'
import { GuestCard, PersonalLinkDialog, TakeoverBanner } from './guest-ui'
import { realId } from './offline/engine'
import { useIds, useOnData } from './offline/hooks'
import { useStore } from './store'
import { fmtDate, type State } from './lib'
import { AiImportButton } from './ai'
import { ListForm, WishForm } from './forms'
import { WishDetail } from './detail-dialog'
import { linkInfo } from './detail-model'
import { listTabs } from './nav'
import { LanguageMenu } from './i18n/switch'
import { t } from './i18n'
import { UserAvatar } from './user-avatar'
import { Badge, Banner, Brand, Button, CopyField, EmptyState, Field, FormError, IconButton, List, Modal, Money, Page, PageHeader, PageSkeleton, Row, Section, Segmented, Select, Stars, Switch, Thumb, TintAvatar, ToggleLink, tintOf, useConfirm, useToast } from './ui'

const count = (n: number) => t('wishlists.wishCount', { count: n })
const isShared = (w: Wish | SharedWish): w is SharedWish => 'reserved' in w

// ───────────────────────────── Reserving ─────────────────────────────

function GuestNameDialog({ item, busy, onSubmit, onCancel }: { item: Wish; busy: boolean; onSubmit: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(savedGuestName())
  const ok = !!name.trim() && !busy
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ok) void onSubmit(name.trim()) }}>
      <Modal compact title={t('wishlists.reserve')} onClose={onCancel} footer={<><span className="flex-1" /><Button onClick={onCancel}>{t('common.cancel')}</Button><Button variant="primary" type="submit" disabled={!ok}>{t('wishlists.reserve')}</Button></>}>
        <p className="text-sm text-muted">{t('wishlists.guest.text', { title: item.title })}</p>
        <Field label={t('wishlists.guest.name')} hint={t('wishlists.guest.hint')}>
          <input className="input" required autoFocus={!name} maxLength={60} autoComplete="given-name" enterKeyHint="done" autoCapitalize="words" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <p className="meta flex gap-2"><EyeOff size={14} className="shrink-0 mt-0.5" /><span>{t('wishlists.guest.privacy')}</span></p>
        <p className="meta">{t('wishlists.guest.haveAccount')} <a href="/login" className="underline underline-offset-2 text-accent">{t('wishlists.guest.signIn')}</a></p>
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

const STALE = ['wish_reserved', 'wish_unavailable', 'wish_not_found', 'guest_claims_disabled', 'guest_limit', 'reservation_not_yours']

/**
 * Reserve/release; `onView` receives the returned view. `token` only on the public page: there everything goes through
 * /api/shared/:token/..., for guests with their key (see guest.ts). `guestKnown`: the server knows this browser as a guest (no name is asked, the
 * name of the guest is used); `onFirstClaim` runs after a guest's first reservation (the personal link is offered). `loggedIn`: a session this app knows. `sessionOnServer`: the
 * server knows a session although the app could not load it (/api/auth/me blocked): no name is asked, the account is used.
 */
function useReserve<V>({ token, loggedIn, sessionOnServer, guestKnown, onView, onPlanned, onRefresh, onFirstClaim }: { token?: string; loggedIn: boolean; sessionOnServer?: boolean; guestKnown?: boolean; onView: (v: V) => void; onPlanned?: (item: Wish, space?: number) => void; onRefresh?: () => void; onFirstClaim?: () => void }) {
  const toast = useToast()
  const { spaces } = useAuth()
  const [busy, setBusy] = useState<number | null>(null)
  const [ask, setAsk] = useState<{ kind: 'guest' | 'space'; item: Wish } | null>(null)
  const guest = !loggedIn && !sessionOnServer

  const call = (method: 'POST' | 'DELETE', item: Wish, body: { guest_name?: string; plan?: boolean }, space?: number) => {
    if (token && !loggedIn) return publicApi<V>(method, sharedUrl(token, `/wishes/${item.id}/reserve`), token, body)
    if (token) return api<V>(method, sharedUrl(token, `/wishes/${item.id}/reserve`), body, { space })
    return api<V>(method, `/api/wishes/${item.id}/reserve`, body, { space })
  }

  const run = async (item: Wish, method: 'POST' | 'DELETE', body: { guest_name?: string; plan?: boolean }, space?: number) => {
    setBusy(item.id)
    try {
      onView(await call(method, item, body, space))
      if (body.plan) onPlanned?.(item, space)
      else if (guest && method === 'POST' && !guestKnown) onFirstClaim?.()
      else if (guest) toast(t(method === 'POST' ? 'wishlists.guest.done' : 'wishlists.guest.released'), 'ok')
      return true
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined
      // Somebody was faster, or the list changed: say so and show the current state
      if (code === 'wish_reserved') toast(t('wishlists.guest.taken'), 'info')
      else if (guest && method === 'DELETE' && code === 'reservation_not_yours') toast(t('wishlists.guest.notYours'), 'bad')
      else toast(errMsg(e), 'bad')
      if (code && STALE.includes(code)) {
        onRefresh?.()
        return true // the dialog can close: the list behind it is current again
      }
      return false
    } finally {
      setBusy(null)
    }
  }

  return {
    busy,
    reserve: (item: Wish, plan = false) => {
      if (guest && token && !guestKnown) return void setAsk({ kind: 'guest', item })
      if (plan && spaces.length > 1) return void setAsk({ kind: 'space', item })
      return run(item, 'POST', { plan })
    },
    release: (item: Wish) => run(item, 'DELETE', {}),
    dialog: ask && (ask.kind === 'guest' ? (
      <GuestNameDialog
        item={ask.item}
        busy={busy === ask.item.id}
        onCancel={() => setAsk(null)}
        onSubmit={async (name) => {
          saveGuestName(name)
          if (await run(ask.item, 'POST', { guest_name: name })) setAsk(null)
        }}
      />
    ) : (
      <SpaceChoice item={ask.item} onCancel={() => setAsk(null)} onPick={async (sid) => { if (await run(ask.item, 'POST', { plan: true }, sid)) setAsk(null) }} />
    )),
  }
}

const WishLink = ({ w }: { w: Wish }) => w.url
  ? <a href={w.url} target="_blank" rel="noreferrer" className="hit pointer-coarse:!p-[0.95rem] pointer-coarse:!-m-[0.95rem] text-muted hover:text-accent" title={t('wishlists.openLink')} aria-label={t('wishlists.openLinkTo', { title: w.title })}><ExternalLink size={14} /></a>
  : null

type Reserver = ReturnType<typeof useReserve<never>>

/** Read-only detail of a wish for viewers: everything the row cuts off (full title and notes, image, link) and the claim actions */
function SharedWishDetail({ w, viewer, canReserve, res, onClose }: { w: Wish | SharedWish; viewer: 'user' | 'guest'; canReserve: boolean; res: Reserver; onClose: () => void }) {
  const reserved = isShared(w) && w.reserved
  const mine = isShared(w) && w.reserved_by_me
  const received = w.status === 'received'
  const link = linkInfo(w.url)
  const busy = res.busy === w.id
  const status = received
    ? <Badge tone="ok" icon={Check}>{t('wishlists.received')}</Badge>
    : reserved ? <Badge tone={mine ? 'ok' : 'warn'} icon={Lock}>{mine ? t('wishlists.reservedByYou') : isShared(w) && w.reserved_by ? t('wishlists.reservedBy', { name: w.reserved_by }) : t('wishlists.reserved')}</Badge> : null
  return (
    <Modal
      title={w.title}
      onClose={onClose}
      footer={!received && (reserved ? (
        mine ? <><span className="flex-1" /><Button icon={Undo2} disabled={busy} onClick={() => void res.release(w)}>{t('wishlists.release')}</Button></> : null
      ) : (
        <>
          {canReserve && <Button variant="primary" icon={Check} className="flex-1 sm:flex-none" data-autofocus disabled={busy} onClick={() => void res.reserve(w)}>{t('wishlists.reserve')}</Button>}
          {viewer === 'user' && <Button icon={GiftIcon} className="flex-1 sm:flex-none" disabled={busy} onClick={() => void res.reserve(w, true)}>{t('wishlists.reservePlan')}</Button>}
        </>
      ))}
    >
      {w.title.length > 30 && <p className="font-semibold break-words">{w.title}</p>}
      {(status || w.price != null || w.priority >= 3) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {w.price != null && <Money n={w.price} currency={w.currency} strong />}
          <Stars n={w.priority} />
          {status}
        </div>
      )}
      {w.image_url && <div className="media h-44 rounded-2xl overflow-hidden grid place-items-center" style={{ background: tintOf(w.id) }}><img src={w.image_url} alt="" className="size-full object-contain" /></div>}
      {w.notes && <p className="whitespace-pre-wrap break-words text-sm">{w.notes}</p>}
      {link && (
        <a href={link.href} target="_blank" rel="noreferrer" className="hit inline-flex items-center gap-1.5 max-w-full text-sm text-accent underline underline-offset-2" aria-label={t('wishlists.openLinkTo', { title: w.title })}>
          <span className="truncate">{link.host}</span><ExternalLink size={14} className="shrink-0" aria-hidden />
        </a>
      )}
    </Modal>
  )
}

/** Wishes for viewers (users with access or guests): reserve, release, plan */
function SharedWishRows({ wishes, viewer, token, canReserve = true, sessionOnServer, guestKnown, onFirstClaim, res: given, onView, onRefresh, onPlanned, empty }: {
  wishes: (Wish | SharedWish)[]
  viewer: 'user' | 'guest'
  token?: string
  /** false: guests may not reserve on this list (the owner turned it off) */
  canReserve?: boolean
  sessionOnServer?: boolean
  guestKnown?: boolean
  onFirstClaim?: () => void
  /** The page may own the reserver (the guest card releases through it too) */
  res?: Reserver
  onView: (v: never) => void
  onRefresh?: () => void
  onPlanned?: (item: Wish, space?: number) => void
  empty: ReactNode
}) {
  const own = useReserve<never>({ token, loggedIn: viewer === 'user', sessionOnServer, guestKnown, onView, onPlanned, onRefresh, onFirstClaim })
  const res = given ?? own
  const [open, setOpen] = useState<number | null>(null)
  const shown = wishes.filter((w) => w.status !== 'removed')
  const detail = open != null ? shown.find((w) => w.id === open) : undefined
  const mineCount = shown.filter((w) => isShared(w) && w.reserved_by_me && w.status !== 'received').length
  return (
    <>
      {mineCount > 0 && <p className="meta flex items-center gap-1.5 text-ok font-medium"><Check size={14} className="shrink-0" aria-hidden />{t('wishlists.mineCount', { count: mineCount })}</p>}
      <List empty={empty}>
        {shown.map((w) => {
          const reserved = isShared(w) && w.reserved
          const mine = isShared(w) && w.reserved_by_me
          const received = w.status === 'received'
          return (
            <Row
              key={w.id}
              lead={<Thumb src={w.image_url} icon={Heart} />}
              title={w.title}
              onClick={() => setOpen(w.id)}
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
                    {canReserve && <Button size="sm" icon={Check} className="@max-[34rem]:flex-1" disabled={res.busy === w.id} onClick={() => res.reserve(w)}>{t('wishlists.reserve')}</Button>}
                    {/* Narrow rows: planning is one tap further, in the detail dialog */}
                    {viewer === 'user' && <Button size="sm" variant="accent" icon={GiftIcon} className="@max-[34rem]:hidden" disabled={res.busy === w.id} title={t('wishlists.reservePlanTitle')} onClick={() => res.reserve(w, true)}>{t('wishlists.reservePlan')}</Button>}
                  </>
                )
              )}
            />
          )
        })}
      </List>
      {detail && <SharedWishDetail w={detail} viewer={viewer} canReserve={canReserve} res={res} onClose={() => setOpen(null)} />}
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
              <div className="rounded-2xl bg-hover px-4 py-3">
                <Switch checked={l.guest_claims === undefined ? true : !!l.guest_claims} onChange={(v) => void act('POST', `/api/wishlists/${l.id}/share`, { guest_claims: v })}>
                  <span className="font-semibold">{t('wishlists.share.guests')}</span>
                  <span className="block meta mt-0.5">{t('wishlists.share.guestsHint')}</span>
                </Switch>
              </div>
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
    <div className="flex gap-1.5 h-28 max-sm:hidden">
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
    <Link to={to} className={`card p-3 pb-5 flex flex-col gap-3.5 min-w-0 hover:brightness-[0.98] transition max-sm:flex-row max-sm:items-start max-sm:gap-3 max-sm:p-3.5 ${dim ? 'opacity-70' : ''}`}>
      <Cover id={id} />
      {/* Phones: a tinted icon tile instead of the 112 px cover strip */}
      <span className="sm:hidden size-12 rounded-2xl grid place-items-center shrink-0 text-ink" style={{ background: tintOf(id) }} aria-hidden><Heart size={22} strokeWidth={1.75} /></span>
      <div className="px-2 max-sm:px-0 flex flex-col gap-2.5 flex-1 min-w-0">
        <div>
          <div className="font-display font-semibold text-[22px] max-sm:text-lg leading-tight break-words">{title}</div>
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
          <button type="button" onClick={() => setCreating(true)} className="min-h-16 sm:min-h-32 md:min-h-60 rounded-[22px] md:rounded-[26px] border-2 border-dashed border-line p-3 md:p-5 flex max-sm:flex-row flex-col items-center justify-center gap-3 text-muted text-center cursor-pointer hover:border-accent transition-colors">
            <span className="size-10 sm:size-14 rounded-full bg-card text-accent shadow-sm grid place-items-center"><Plus size={26} strokeWidth={2.4} /></span>
            <span className="font-display font-semibold text-lg sm:text-xl text-ink">{t('wishlists.new')}</span>
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
  /** Reorder mode: arrows per row only while sorting, otherwise a row has just the "received" action */
  const [sorting, setSorting] = useState(false)
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
            <Button variant="primary" icon={Plus} onClick={() => setWishForm({})}>{t('wishlists.addWish')}</Button>
            {mine.id > 0 && <Button icon={Share2} iconOnlyOnMobile onClick={() => setSharing(true)}>{t('wishlists.share.action')}</Button>}
            <IconButton icon={Pencil} label={t('wishlists.edit')} onClick={() => setEditing(true)} />
            {mine.id > 0 && <AiImportButton init={{ target: 'wishes', listId: mine.id }} onDone={() => void load()} label={t('wishlists.aiImport')} />}
          </>
        }
      />
      <Section title={wishes.length ? count(wishes.length) : undefined} action={wishes.length > 1 ? <Button size="sm" variant={sorting ? 'primary' : 'ghost'} icon={sorting ? Check : ArrowUpDown} onClick={() => setSorting(!sorting)}>{sorting ? t('common.done') : t('wishlists.sort')}</Button> : undefined}>
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
              actions={sorting ? (
                <>
                  <IconButton icon={ArrowUp} size="sm" label={t('wishlists.up')} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon={ArrowDown} size="sm" label={t('wishlists.down')} disabled={i === wishes.length - 1} onClick={() => move(i, 1)} />
                </>
              ) : w.status === 'received'
                ? <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setStatus(w, 'open')}>{t('wishlists.reopen')}</Button>
                : <Button size="sm" variant="ghost" icon={Check} onClick={() => setStatus(w, 'received')}>{t('wishlists.markReceived')}</Button>}
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
  // After the sign-in the visitor comes back to this list
  useEffect(() => { rememberNext(location.pathname) }, [])
  return (
    <div className="min-h-dvh">
      <div className="max-w-[1120px] mx-auto px-4 md:px-10 pt-4 flex items-center justify-between gap-3">
        <Brand name={appName} />
        {/* A real page load (not a router link): a sign-in proxy in front of the app can only show its login for those */}
        <div className="flex items-center gap-2"><LanguageMenu /><Button size="sm" variant="ghost" icon={LogIn} href="/login">{t('auth.login.title')}</Button></div>
      </div>
      {children}
    </div>
  )
}

/** /w/:token – a list shared via link (with or without sign-in). Needs nothing but /api/shared/:token/... from the server. */
export function PublicWishlistBody() {
  const { token = '' } = useParams()
  const { status } = useAuth()
  const toast = useToast()
  const [view, setView] = useState<PublicView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [afterClaim, setAfterClaim] = useState(false)
  const confirm = useConfirm()
  const planned = usePlanned(view?.owner.name ?? t('wishlists.thePerson'))

  const load = useCallback(
    () => publicApi<PublicView>('GET', sharedUrl(token), token).then((v) => { setView(v); setError(null) }).catch((e) => setError(errMsg(e))),
    [token],
  )
  useEffect(() => {
    const early = takePublicView(token) // the app has just asked for it
    if (early) { setView(early); setError(null) } else void load()
  }, [token, status, load])

  const guestNow = !!view && status !== 'ready' && !view.logged_in
  const res = useReserve<never>({ token, loggedIn: status === 'ready', sessionOnServer: !!view && status !== 'ready' && view.logged_in, guestKnown: !!view?.guest, onView: (v) => setView(v as PublicView), onPlanned: planned, onRefresh: () => void load(), onFirstClaim: () => setAfterClaim(true) })

  // A personal link was opened (on this page or pasted into the address bar): say what happened, ask when claims would collide
  useEffect(() => {
    const handle = async () => {
      const r = takeLinkResult()
      if (!r) return
      if (r.kind === 'invalid') toast(t('wishlists.guestId.invalid'), 'bad')
      else if (r.kind === 'adopted') { toast(t('wishlists.guestId.adopted'), 'ok'); void load() }
      else if (await confirm({ title: t('wishlists.guestId.conflictTitle'), text: t('wishlists.guestId.conflictText', { storedName: r.storedName, mine: r.storedClaims, linkName: r.linkName, theirs: r.linkClaims }), confirmLabel: t('wishlists.guestId.conflictConfirm'), cancelLabel: t('common.cancel') })) {
        try { await mergeIntoLink(r); toast(t('wishlists.guestId.merged'), 'ok') } catch (e) { toast(errMsg(e), 'bad') }
        void load()
      }
    }
    void handle()
    return onLinkResult(() => void handle())
  }, [load, toast, confirm])

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
  // The server knows a session that the app could not load (a sign-in proxy blocks /api/auth/me): reserving uses that account
  const sessionOnServer = viewer === 'guest' && view.logged_in
  const guestsOff = view.guest_claims === false && viewer === 'guest' && !sessionOnServer
  const toggleFollow = async () => {
    setBusy(true)
    try {
      setView(await api<PublicView>(view.following ? 'DELETE' : 'POST', sharedUrl(token, '/follow')))
      toast(view.following ? t('wishlists.unfollowed') : t('wishlists.followed', { tab: t('nav.tabs.lists.shared') }), 'ok')
    } catch (e) {
      toast(errMsg(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  const w = view.wishlist
  const mine = view.wishes.filter((x): x is SharedWish => isShared(x) && x.reserved_by_me && x.status !== 'received')
  return (
    <Page>
      <PageHeader
        back={status === 'ready' ? { to: '/wishlists/shared', label: t('nav.tabs.lists.shared') } : undefined}
        title={w.title}
        sub={[t('wishlists.by', { name: view.owner.name }), w.event_date && fmtDate(w.event_date), w.description].filter(Boolean).join(' · ')}
        actions={viewer === 'user' && <Button icon={view.following ? BellOff : Bell} disabled={busy} onClick={toggleFollow}>{view.following ? t('wishlists.unfollow') : t('wishlists.follow')}</Button>}
      />
      {viewer === 'guest' && !sessionOnServer && (
        <Banner icon={guestsOff ? Lock : Heart} tone={guestsOff ? 'warn' : 'info'}>
          {guestsOff ? t('wishlists.guest.disabled') : t('wishlists.guestBanner', { name: view.owner.name })}
        </Banner>
      )}
      {viewer === 'user' && !view.is_owner && <TakeoverBanner token={token} onView={(v) => setView(v)} />}
      {guestNow && !sessionOnServer && (!guestsOff || mine.length > 0) && (
        <GuestCard token={token} view={view} mine={mine} busy={res.busy} onRelease={(w) => void res.release(w)} onView={setView} onReload={() => void load()} />
      )}
      <Section>
        <SharedWishRows
          wishes={view.wishes}
          viewer={viewer}
          token={token}
          canReserve={!guestsOff}
          sessionOnServer={sessionOnServer}
          res={res}
          onView={(v) => setView(v as PublicView)}
          onRefresh={() => void load()}
          onPlanned={planned}
          empty={<EmptyState icon={Heart}>{t('wishlists.noOpenWishes', { name: view.owner.name })}</EmptyState>}
        />
      </Section>
      {afterClaim && <PersonalLinkDialog intro token={token} view={view} onView={setView} onClose={() => setAfterClaim(false)} />}
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

