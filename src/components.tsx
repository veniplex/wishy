import { Fragment, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ExternalLink, Gift as GiftIcon, Heart, Lightbulb, MessageCircle, RotateCcw } from 'lucide-react'
import { occasionIconByName } from './occasion-icons'
import { useOccasionTypes, useStore } from './store'
import { t, useT, type TKey, type TParams } from './i18n'
import { GIFT_STATUS, costFor, countdown, daysUntil, fmtDate, isCommitted, isLeftOutBirthday, joinNames, statusInfo, sum, type Gift, type Item, type Occasion } from './lib'
import { Badge, Button, IconButton, Menu, MenuItem, Money, Progress, Row, RowLink, Stars, Thumb } from './ui'
import { CostSplit } from './split'

/** Re-exported for the calendar views */
export { occasionIconByName }

/** Translated text with building blocks (e.g. amounts as <Money/>): `{name}` in the text is replaced by parts.name */
export function rich(key: TKey, parts: Record<string, ReactNode>, params: TParams = {}): ReactNode {
  const ph = Object.fromEntries(Object.keys(parts).map((k) => [k, `{${k}}`]))
  return t(key, { ...params, ...ph }).split(/(\{\w+\})/).map((seg, i) => {
    const m = /^\{(\w+)\}$/.exec(seg)
    return m && m[1] in parts ? <Fragment key={i}>{parts[m[1]]}</Fragment> : seg
  })
}

/** Icon of an occasion type (unknown names fall back to a calendar) */
export function OccasionTypeIcon({ icon, size = 16, className }: { icon: string | null | undefined; size?: number; className?: string }) {
  const Icon = occasionIconByName(icon)
  return <Icon size={size} className={className} aria-hidden />
}

/** Status as a badge button; opens a popover menu with all statuses. */
export function StatusBadge({ g }: { g: Gift }) {
  const { s, call } = useStore()
  useT()
  const st = statusInfo(g.status)
  if (!s.permissions.manage_gifts) return <Badge tone={st.tone}>{st.label}</Badge>
  return (
    <span className="row-above relative inline-flex">
      <Menu
        width={224}
        trigger={(p) => (
          <button type="button" {...p} aria-label={t('status.aria', { title: g.title, status: st.label })} className="relative rounded-full cursor-pointer before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-['']">
            <Badge tone={st.tone}>{st.label}<ChevronDown size={12} /></Badge>
          </button>
        )}
      >
        {(close) => GIFT_STATUS.map((x) => <MenuItem key={x.id} label={x.label} selected={x.id === g.status} onClick={() => { close(); if (x.id !== g.status) void call('POST', `/api/gifts/${g.id}/status`, { status: x.id }) }} />)}
      </Menu>
    </span>
  )
}

/** Payment status of a gift: paid / open shares / unpaid (returned gifts show nothing) */
export function PaymentBadge({ g }: { g: Gift }) {
  const { money } = useStore()
  useT()
  if (g.status === 'returned') return null
  const ps = g.payment_summary
  if (g.payment_status !== 'paid') return <Badge tone="neutral">{t('status.pay.unpaid')}</Badge>
  if (ps && ps.open_count > 0) return <Badge tone="warn">{t('status.pay.open', { count: ps.open_count, amount: money(ps.open_amount) })}</Badge>
  return <Badge tone="ok" icon={Check}>{t('status.pay.paid')}</Badge>
}

const ExternalIcon = ({ url }: { url: string }) => (
  <a href={url} target="_blank" rel="noreferrer" className="hit text-muted hover:text-accent" title={t('gifts.openLink')} aria-label={t('gifts.openLink')}><ExternalLink size={14} /></a>
)

/** Gift form prefilled from an idea: person and occasion of the idea */
export const giftFromIdea = (i: Item): Partial<Gift> => ({ title: i.title, price: i.price, url: i.url, image_url: i.image_url, item_id: i.id, recipient_ids: [i.person_id], occasion_id: i.occasion_id ?? undefined })

/** `except`: the person whose block the row sits in – the recipients line then only names the others ("also for …") */
export function GiftRow({ g, hideOccasion, detail, except }: { g: Gift; hideOccasion?: boolean; detail?: boolean; except?: number }) {
  const { s, person, occasion, occasionTitle, open } = useStore()
  useT()
  const [expanded, setExpanded] = useState(false)
  const o = occasion(g.occasion_id)
  const recipients = g.recipient_ids.filter((id) => id !== except).map(person).filter(Boolean)
  const shared = g.givers.length > 1 && s.permissions.view_expenses
  const extra = [g.shop, g.notes].filter(Boolean).join(' · ')
  const expandable = !!detail && (shared || !!extra)
  return (
    <Row
      lead={<Thumb src={g.image_url} icon={GiftIcon} />}
      title={g.title}
      onClick={() => open({ type: 'gift', initial: g })}
      titleSuffix={
        <>
          {g.url && <ExternalIcon url={g.url} />}
          {expandable && <IconButton icon={ChevronDown} size="sm" label={expanded ? t('gifts.details.hide') : t('gifts.details.show')} aria-expanded={expanded} className={expanded ? '[&>svg]:rotate-180' : ''} onClick={() => setExpanded(!expanded)} />}
        </>
      }
      meta={
        <>
          {recipients.length ? t(except != null ? 'gifts.alsoFor' : 'gifts.for', { names: joinNames(recipients.map((p) => p!.name)) }) : except == null ? t('gifts.noRecipient') : null}
          {!hideOccasion && o && <>{(recipients.length > 0 || except == null) && ' · '}<RowLink to={`/calendar/${o.id}`}>{occasionTitle(o)}</RowLink></>}
        </>
      }
      extra={shared && <CostSplit g={g} compact />}
      trailing={<><Money n={g.price} strong /><StatusBadge g={g} /><PaymentBadge g={g} /></>}
      below={expandable && expanded && (
        <div className="space-y-2 meta pb-1">
          {extra && <div>{extra}</div>}
          {shared && <CostSplit g={g} />}
        </div>
      )}
    />
  )
}

/** "Plan" and "Done" actions of a wish or idea */
export function ItemActions({ i }: { i: Item }) {
  const { s, person, open, call, itemState } = useStore()
  useT()
  const p = person(i.person_id)
  if (!s.permissions.manage_gifts) return null
  return (
    <>
      {itemState(i) === 'open' && !p?.is_me && (
        <Button
          size="sm"
          variant="accent"
          icon={GiftIcon}
          title={t('give.item.planTitle')}
          onClick={() => open({ type: 'gift', initial: giftFromIdea(i) })}
        >
          {t('give.item.plan')}
        </Button>
      )}
      {i.status === 'open' ? (
        <Button size="sm" variant="ghost" icon={Check} onClick={() => call('PUT', `/api/items/${i.id}`, { status: 'done' })}>{t('give.item.done')}</Button>
      ) : (
        <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => call('PUT', `/api/items/${i.id}`, { status: 'open' })}>{t('give.item.reopen')}</Button>
      )}
    </>
  )
}

const isInactive = (state: string) => state === 'done' || state === 'discarded'
const PlannedBadge = () => <Badge tone={statusInfo('planned').tone}>{t('status.item.planned')}</Badge>

export function ItemRow({ i, showPerson, hideOccasion }: { i: Item; showPerson?: boolean; hideOccasion?: boolean }) {
  const { person, occasion, occasionTitle, open, itemState } = useStore()
  useT()
  const p = person(i.person_id)
  const o = hideOccasion ? undefined : occasion(i.occasion_id)
  const state = itemState(i)
  const sub = [showPerson && p?.name, o && occasionTitle(o, false), i.source || i.notes].filter(Boolean).join(' · ')
  return (
    <Row
      lead={<Thumb src={i.image_url} icon={i.mentioned ? MessageCircle : Lightbulb} />}
      title={i.title}
      onClick={() => open({ type: 'item', initial: i })}
      dim={isInactive(state)}
      strike={state === 'discarded'}
      titleSuffix={<><Stars n={i.priority} />{!!i.mentioned && <Badge tone="info">{t('give.item.mentioned')}</Badge>}{i.url && <ExternalIcon url={i.url} />}</>}
      meta={sub}
      trailing={(i.price != null || state === 'planned') && <>{i.price != null && <Money n={i.price} currency={i.currency} strong />}{state === 'planned' && <PlannedBadge />}</>}
      actions={<ItemActions i={i} />}
    />
  )
}

/** Idea as a tile (person page): image or icon, title, price, actions */
export function IdeaCard({ i }: { i: Item }) {
  const { s, open, itemState, call } = useStore()
  useT()
  const state = itemState(i)
  const inactive = isInactive(state)
  return (
    <article className={`card p-3 pb-4 flex flex-col gap-3 min-w-0 ${inactive ? 'opacity-70' : ''}`}>
      <button type="button" className="media h-28 rounded-2xl overflow-hidden grid place-items-center cursor-pointer text-muted" style={{ background: `var(--t${(i.id % 5) + 1})` }} onClick={() => open({ type: 'item', initial: i })} aria-label={t('give.item.editAria', { title: i.title })}>
        {i.image_url ? <img src={i.image_url} alt="" loading="lazy" className="size-full object-cover" /> : (i.mentioned ? <MessageCircle size={38} strokeWidth={1.5} className="text-ink" /> : <Lightbulb size={38} strokeWidth={1.5} className="text-ink" />)}
      </button>
      <div className="px-1.5 flex flex-col gap-2 flex-1">
        <div className="flex items-start gap-1.5">
          <button type="button" className={`font-semibold text-left leading-snug break-words hover:text-accent cursor-pointer flex-1 ${state === 'discarded' ? 'line-through' : ''}`} onClick={() => open({ type: 'item', initial: i })}>{i.title}</button>
          <Stars n={i.priority} />
          {i.url && <ExternalIcon url={i.url} />}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!!i.mentioned && <Badge tone="accent" icon={Heart}>{t('give.item.mentionedSelf')}</Badge>}
          {state === 'planned' && <PlannedBadge />}
        </div>
        <div className="flex items-center justify-between gap-2 mt-auto pt-1">
          {i.price != null ? <Money n={i.price} currency={i.currency} strong className="display-num text-xl" /> : <span />}
          {s.permissions.manage_gifts && <div className="flex items-center gap-1">
            {state === 'open' && <Button size="sm" onClick={() => open({ type: 'gift', initial: giftFromIdea(i) })}>{t('give.item.plan')}</Button>}
            {i.status === 'open'
              ? <IconButton icon={Check} size="sm" label={t('give.item.done')} onClick={() => call('PUT', `/api/items/${i.id}`, { status: 'done' })} />
              : <IconButton icon={RotateCcw} size="sm" label={t('give.item.reopen')} onClick={() => call('PUT', `/api/items/${i.id}`, { status: 'open' })} />}
          </div>}
        </div>
      </div>
    </article>
  )
}

/** Key figures of an occasion from your point of view */
export function useOccasionStats(o: Occasion) {
  const { s, me, person } = useStore()
  const gifts = s.gifts.filter((g) => g.occasion_id === o.id)
  const covered = new Set(gifts.filter((g) => g.status !== 'returned').flatMap((g) => g.recipient_ids))
  const people = o.person_ids.filter((id) => !person(id)?.is_me)
  const missing = people.filter((id) => !covered.has(id))
  const mine = sum(gifts.map((g) => costFor(g, me?.id ?? null)))
  const mineSpent = sum(gifts.filter((g) => isCommitted(g.status)).map((g) => costFor(g, me?.id ?? null)))
  const total = sum(gifts.map((g) => g.price ?? 0))
  const open = gifts.filter((g) => g.status === 'planned').length
  return { gifts, people, missing, mine, mineSpent, total, open }
}

export function OccasionRow({ o }: { o: Occasion }) {
  const { s, occasionTitle } = useStore()
  useT()
  const types = useOccasionTypes()
  const st = useOccasionStats(o)
  const days = daysUntil(o.date, s.today)
  const past = days < 0
  const leftOut = isLeftOutBirthday(o)
  let status: { text: string; cls: string } | null = null
  if (!past && !leftOut) {
    if (st.missing.length) status = { text: t('calendar.row.noGift', { count: st.missing.length }), cls: 'text-warn' }
    else if (st.open) status = { text: t('calendar.row.toBuy', { count: st.open }), cls: 'text-warn' }
    else if (st.gifts.length) status = { text: t('calendar.row.allDone'), cls: 'text-ok' }
  }
  return (
    <Row
      to={`/calendar/${o.id}`}
      dim={past || leftOut}
      lead={<Thumb tone="accent" icon={occasionIconByName(types.of(o.type).icon)} />}
      title={occasionTitle(o)}
      meta={<>{fmtDate(o.date, false)} · {countdown(days)}{leftOut && <> · {t('calendar.row.leftOut')}</>}{status && <> · <span className={status.cls}>{status.text}</span></>}</>}
      trailing={(st.gifts.length > 0 || !!o.budget) && (
        <>
          <Money n={st.mine} strong />
          {o.budget ? <span className="meta num">{rich('common.ofAmount', { amount: <Money n={o.budget} /> })}</span> : null}
          <Progress value={st.mine} max={o.budget} className="w-full" />
        </>
      )}
    />
  )
}
