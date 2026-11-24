/**
 * Read-only detail views (dialogs) of an idea, a planned gift and a wish: opened by a click on a row, with the actions of the row
 * and "Edit", which opens the form. Changes go through the same calls as the forms (queued offline, see src/offline).
 */
import type { ReactNode } from 'react'
import { ExternalLink, Gift as GiftIcon, Heart, Lightbulb, Pencil, Trash2 } from 'lucide-react'
import { useStore } from './store'
import { fmtDate, fmtDateTime, t, useT } from './i18n'
import { statusInfo, type Gift, type Item } from './lib'
import type { Wish } from './api'
import { Badge, Button, Modal, Money, tintOf, useConfirm } from './ui'
import { ItemActions, KindBadge, PaymentBadge, StatusBadge } from './components'
import { CostSplit } from './split'
import { linkInfo } from './detail-model'
import { realId } from './offline/engine'

/** The dialog title is cut off after one line: long titles are repeated in full */
const FullTitle = ({ title }: { title: string }) => (title.length > 30 ? <p className="font-semibold break-words">{title}</p> : null)

/** One labelled fact; nothing when there is no value */
function Fact({ label, children }: { label: string; children?: ReactNode }) {
  if (children == null || children === false || children === '') return null
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-4 py-2.5 border-t border-line first:border-t-0">
      <dt className="meta">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function LinkFact({ url, title }: { url: string | null | undefined; title: string }) {
  const l = linkInfo(url)
  if (!l) return url ? <span>{url}</span> : null
  return (
    <a href={l.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-accent underline underline-offset-2 max-w-full" aria-label={t('give.detail.openLink', { title })}>
      <span className="truncate">{l.host}</span>
      <ExternalLink size={14} className="shrink-0" aria-hidden />
    </a>
  )
}

function Hero({ src, icon: Icon, id }: { src: string | null | undefined; icon: typeof Lightbulb; id: number }) {
  return (
    <div className="media h-44 rounded-2xl overflow-hidden grid place-items-center text-ink" style={{ background: tintOf(id) }}>
      {src ? <img src={src} alt="" className="size-full object-contain" /> : <Icon size={44} strokeWidth={1.5} aria-hidden />}
    </div>
  )
}

const names = (ids: number[], person: (id: number) => { name: string } | undefined) => ids.map((id) => person(id)?.name).filter(Boolean).join(', ')

/** Detail of an idea (an entry of the planning page that is not decided yet) */
export function ItemDetail({ initial }: { initial: Partial<Item> }) {
  const { s, open, close, call, person, occasion, occasionTitle, itemState } = useStore()
  useT()
  const confirm = useConfirm()
  const id = realId(initial.id) ?? 0
  const i = (s.items.find((x) => x.id === initial.id) ?? initial) as Item
  const state = itemState(i)
  const o = occasion(i.occasion_id)
  const can = s.permissions.manage_gifts
  const planned = s.gifts.filter((g) => g.item_id === i.id)
  const del = async () => {
    if (!(await confirm({ title: t('forms.delete.title'), text: t('forms.delete.text'), confirmLabel: t('forms.delete.confirm'), destructive: true }))) return
    if (await call('DELETE', `/api/items/${id}`)) close()
  }
  return (
    <Modal
      title={i.title}
      onClose={close}
      footer={
        <>
          {can && id > 0 && <Button variant="danger" icon={Trash2} iconOnlyOnMobile onClick={() => void del()}>{t('forms.delete.confirm')}</Button>}
          <span className="flex-1" />
          {can && <Button variant="primary" icon={Pencil} data-autofocus onClick={() => open({ type: 'item', initial: i })}>{t('give.detail.editEntry')}</Button>}
        </>
      }
    >
      <FullTitle title={i.title} />
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind="idea" />
        <span className="meta">{t('give.kind.ideaHint')}</span>
        {state === 'planned' && <Badge tone={statusInfo('planned').tone}>{t('status.item.planned')}</Badge>}
        {state === 'done' && <Badge tone="ok">{t('forms.item.done')}</Badge>}
        {state === 'discarded' && <Badge tone="neutral">{t('forms.item.discarded')}</Badge>}
        {!!i.mentioned && <Badge tone="info">{t('give.item.mentioned')}</Badge>}
      </div>
      {i.image_url && <Hero src={i.image_url} icon={Lightbulb} id={i.id} />}
      <dl>
        <Fact label={t('forms.forWhom')}>{person(i.person_id)?.name}</Fact>
        <Fact label={t('give.detail.occasion')}>{o && `${occasionTitle(o, false)} · ${fmtDate(o.date, false)}`}</Fact>
        <Fact label={t('forms.price')}>{i.price != null && <Money n={i.price} currency={i.currency} strong />}</Fact>
        <Fact label={t('forms.item.fit')}><span className="inline-flex items-center gap-1.5">{'★'.repeat(i.priority)}<span className="sr-only">{t('give.detail.stars', { count: i.priority })}</span></span></Fact>
        <Fact label={t('forms.link')}>{i.url && <LinkFact url={i.url} title={i.title} />}</Fact>
        <Fact label={t('forms.notes')}>{i.notes && <span className="whitespace-pre-wrap">{i.notes}</span>}</Fact>
        <Fact label={t('forms.gift.shop')}>{i.source}</Fact>
        <Fact label={t('give.detail.created')}>{i.created_at && fmtDateTime(i.created_at)}</Fact>
        <Fact label={t('give.kind.gift')}>{planned.length > 0 && planned.map((g) => g.title).join(', ')}</Fact>
      </dl>
      {can && id > 0 && <div className="flex flex-wrap gap-2"><ItemActions i={i} /></div>}
    </Modal>
  )
}

/** Detail of a planned gift (decided: status, payment, shares) */
export function GiftDetail({ initial }: { initial: Partial<Gift> }) {
  const { s, open, close, call, person, occasion, occasionTitle } = useStore()
  useT()
  const confirm = useConfirm()
  const id = realId(initial.id) ?? 0
  const g = (s.gifts.find((x) => x.id === initial.id) ?? initial) as Gift
  const o = occasion(g.occasion_id)
  const can = s.permissions.manage_gifts
  const idea = g.item_id ? s.items.find((x) => x.id === g.item_id) : undefined
  const shared = (g.givers?.length ?? 0) > 1 && s.permissions.view_expenses
  const del = async () => {
    if (!(await confirm({ title: t('forms.delete.title'), text: t('forms.delete.text'), confirmLabel: t('forms.delete.confirm'), destructive: true }))) return
    if (await call('DELETE', `/api/gifts/${id}`)) close()
  }
  const day = (v: string | null | undefined) => (v ? fmtDate(v.slice(0, 10)) : null)
  return (
    <Modal
      title={g.title}
      onClose={close}
      footer={
        <>
          {can && id > 0 && <Button variant="danger" icon={Trash2} iconOnlyOnMobile onClick={() => void del()}>{t('forms.delete.confirm')}</Button>}
          <span className="flex-1" />
          {can && <Button variant="primary" icon={Pencil} data-autofocus onClick={() => open({ type: 'gift', initial: g })}>{t('give.detail.editEntry')}</Button>}
        </>
      }
    >
      <FullTitle title={g.title} />
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind="gift" />
        <StatusBadge g={g} />
        <PaymentBadge g={g} />
      </div>
      {g.image_url && <Hero src={g.image_url} icon={GiftIcon} id={g.id} />}
      <dl>
        <Fact label={t('forms.forWhom')}>{names(g.recipient_ids ?? [], person)}</Fact>
        <Fact label={t('give.detail.occasion')}>{o && `${occasionTitle(o, false)} · ${fmtDate(o.date, false)}`}</Fact>
        <Fact label={t('forms.date')}>{!o && g.date && fmtDate(g.date)}</Fact>
        <Fact label={t('forms.gift.totalPrice')}>{g.price != null && <Money n={g.price} strong />}</Fact>
        <Fact label={t('forms.gift.fromWhom')}>{shared ? <CostSplit g={g} /> : g.givers?.length ? names(g.givers.map((x) => x.person_id), person) : null}</Fact>
        <Fact label={t('forms.gift.shop')}>{g.shop}</Fact>
        <Fact label={t('forms.link')}>{g.url && <LinkFact url={g.url} title={g.title} />}</Fact>
        <Fact label={t('forms.notes')}>{g.notes && <span className="whitespace-pre-wrap">{g.notes}</span>}</Fact>
        <Fact label={t('forms.gift.orderNumber')}>{g.order_number}</Fact>
        <Fact label={t('forms.gift.carrier')}>{g.carrier}</Fact>
        <Fact label={t('forms.gift.trackingNumber')}>{g.tracking_number}</Fact>
        <Fact label={t('forms.gift.trackingLink')}>{g.tracking_url && <LinkFact url={g.tracking_url} title={g.title} />}</Fact>
        <Fact label={t('give.detail.ordered')}>{day(g.ordered_at)}</Fact>
        <Fact label={t('forms.gift.expected')}>{day(g.expected_at)}</Fact>
        <Fact label={t('give.detail.delivered')}>{day(g.delivered_at)}</Fact>
        <Fact label={t('give.detail.given')}>{day(g.given_at)}</Fact>
        <Fact label={t('give.detail.paymentMethod')}>{g.payment_method}</Fact>
        <Fact label={t('give.kind.idea')}>{idea ? t('give.detail.fromIdea', { title: idea.title }) : null}</Fact>
        <Fact label={t('give.detail.created')}>{g.created_at && fmtDateTime(g.created_at)}</Fact>
      </dl>
    </Modal>
  )
}

/** Detail of a wish on one's own wish list; the actions are those of the list row */
export function WishDetail({ w, canEdit, onClose, onEdit, onToggle, onDelete }: {
  w: Wish
  canEdit: boolean
  onClose: () => void
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  useT()
  return (
    <Modal
      title={w.title}
      onClose={onClose}
      footer={
        <>
          {canEdit && <Button variant="danger" icon={Trash2} iconOnlyOnMobile onClick={onDelete}>{t('forms.delete.confirm')}</Button>}
          <span className="flex-1" />
          {canEdit && <Button onClick={onToggle}>{w.status === 'received' ? t('wishlists.reopen') : t('wishlists.markReceived')}</Button>}
          {canEdit && <Button variant="primary" icon={Pencil} data-autofocus onClick={onEdit}>{t('give.detail.editEntry')}</Button>}
        </>
      }
    >
      <FullTitle title={w.title} />
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind="wish" />
        {w.status === 'received' && <Badge tone="ok">{t('wishlists.received')}</Badge>}
      </div>
      {w.image_url && <Hero src={w.image_url} icon={Heart} id={w.id} />}
      <dl>
        <Fact label={t('forms.price')}>{w.price != null && <Money n={w.price} currency={w.currency} strong />}</Fact>
        <Fact label={t('forms.wish.priority')}><span className="inline-flex items-center gap-1.5">{'★'.repeat(w.priority)}<span className="sr-only">{t('give.detail.stars', { count: w.priority })}</span></span></Fact>
        <Fact label={t('forms.link')}>{w.url && <LinkFact url={w.url} title={w.title} />}</Fact>
        <Fact label={t('forms.notes')}>{w.notes && <span className="whitespace-pre-wrap">{w.notes}</span>}</Fact>
        <Fact label={t('give.detail.created')}>{w.created_at && fmtDateTime(w.created_at)}</Fact>
      </dl>
    </Modal>
  )
}
