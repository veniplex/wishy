/** Occasion page (`/calendar/:id`): grouped by person – one block per participant, "Other gifts", and the persons left out. */
import { useState } from 'react'
import { CalendarHeart, Lightbulb, MessageCircle, Pencil, Plus, Users } from 'lucide-react'
import { Navigate, useParams } from 'react-router-dom'
import { useRelationshipTypes, useStore } from './store'
import { t } from './i18n'
import { countdown, daysUntil, fmtDate, type Occasion } from './lib'
import { Avatar, Badge, Button, Card, Chip, EmptyState, IconButton, List, Money, Page, PageHeader, Progress, Section, Stat, Stats, ToggleLink } from './ui'
import { GiftRow, giftFromIdea, rich, useOccasionStats } from './components'
import { LeaveMenu, PlanBadge, PlanBlock, PlanButtons, useLeaveOut } from './plan-parts'

export function OccasionDetail() {
  const { occasionId: id } = useParams()
  const { occasion } = useStore()
  const o = occasion(Number(id))
  if (o && o.id !== Number(id)) return <Navigate to={`/calendar/${o.id}`} replace /> // created offline, synced meanwhile
  if (!o) return <Page><EmptyState icon={CalendarHeart} action={<Button size="sm" to="/calendar">{t('calendar.backToList')}</Button>}>{t('calendar.notFound')}</EmptyState></Page>
  return <OccasionView key={o.id} oid={o.id} />
}

/** One participant: their gifts in this occasion, idea suggestions and the plan buttons */
function PersonBlock({ o, pid }: { o: Occasion; pid: number }) {
  const { s, person, open, itemState } = useStore()
  const { can, leave } = useLeaveOut()
  const relTypes = useRelationshipTypes()
  const p = person(pid)!
  const gifts = s.gifts.filter((g) => g.occasion_id === o.id && g.recipient_ids.includes(pid))
  // Ideas meant for this occasion first, then the other open ones of the person
  const suggestions = s.items
    .filter((i) => i.person_id === pid && itemState(i) === 'open' && (!i.occasion_id || i.occasion_id === o.id))
    .sort((a, b) => Number(b.occasion_id === o.id) - Number(a.occasion_id === o.id) || b.priority - a.priority)
    .slice(0, 3)
  return (
    <PlanBlock
      lead={<Avatar p={p} size={44} />}
      title={p.name}
      to={`/gifting/${pid}`}
      meta={relTypes.labelOf(p.relationship) || undefined}
      status={<PlanBadge gifts={gifts} />}
      menu={can && <LeaveMenu label={t('calendar.plan.leave', { name: p.name })} onLeave={() => void leave(o, pid)} />}
      footer={<PlanButtons personId={pid} occasionId={o.id} />}
    >
      {gifts.map((g) => <GiftRow key={g.id} g={g} hideOccasion detail except={pid} />)}
      {suggestions.length > 0 && s.permissions.manage_gifts && (
        <div className="px-5 py-3 flex flex-wrap gap-1.5">
          {suggestions.map((i) => (
            <Chip key={i.id} className="max-w-full" title={t('give.item.planTitle')} onClick={() => open({ type: 'gift', initial: { ...giftFromIdea(i), occasion_id: o.id } })}>
              {i.mentioned ? <MessageCircle size={12} className="shrink-0" /> : <Lightbulb size={12} className="shrink-0" />}
              <span className="truncate">{i.title}</span>
              {i.price != null && <Money n={i.price} currency={i.currency} tone="muted" className="shrink-0" />}
            </Chip>
          ))}
        </div>
      )}
    </PlanBlock>
  )
}

function LeftOut({ o, ids }: { o: Occasion; ids: number[] }) {
  const { s, person } = useStore()
  const { can, include } = useLeaveOut()
  const [open, setOpen] = useState(false)
  if (!ids.length) return null
  const label = t('calendar.plan.leftOut', { count: ids.length })
  return (
    <div className="space-y-3">
      <ToggleLink chevron className="text-muted" on={open} onToggle={() => setOpen(!open)} labelOn={label} labelOff={label} />
      {open && (
        <div className="flex flex-col gap-4">
          {ids.map((pid) => (
            <PlanBlock
              key={pid}
              dim
              lead={<Avatar p={person(pid)} size={44} />}
              title={person(pid)?.name}
              to={`/gifting/${pid}`}
              status={<Badge>{t('calendar.plan.leftOutBadge')}</Badge>}
              menu={can && <Button size="sm" onClick={() => void include(o, pid)}>{t('calendar.plan.include')}</Button>}
            >
              {s.gifts.filter((g) => g.occasion_id === o.id && g.recipient_ids.includes(pid)).map((g) => <GiftRow key={g.id} g={g} hideOccasion detail except={pid} />)}
            </PlanBlock>
          ))}
        </div>
      )}
    </div>
  )
}

function OccasionView({ oid }: { oid: number }) {
  const { s, occasion, occasionTitle, open, person } = useStore()
  const o = occasion(oid)!
  const st = useOccasionStats(o)
  const days = daysUntil(o.date, s.today)
  const leftOut = o.excluded_ids.filter((id) => person(id))
  // Gifts of persons who are neither taking part nor left out (or of nobody)
  const known = new Set([...st.people, ...leftOut])
  const other = st.gifts.filter((g) => !g.recipient_ids.some((id) => known.has(id)))
  const birthday = o.type === 'birthday'
  return (
    <Page>
      <PageHeader
        back={{ to: '/calendar', label: t('calendar.title') }}
        title={occasionTitle(o)}
        sub={<>{fmtDate(o.date)} · {countdown(days)}{o.recurring || birthday ? ` · ${t('calendar.yearly')}` : ''}{!birthday && ` · ${t(o.audience === 'all' ? 'calendar.audience.all' : 'calendar.audience.selected')}`}</>}
        actions={
          <>
            {s.permissions.manage_occasions && <IconButton icon={Pencil} label={t('calendar.edit')} onClick={() => open({ type: 'occasion', initial: o })} />}
            {s.permissions.manage_gifts && <Button variant="primary" icon={Plus} onClick={() => open({ type: 'gift', initial: { occasion_id: o.id } })}>{t('calendar.planGift')}</Button>}
          </>
        }
      />
      {o.notes && <Card><div className="label">{t('calendar.notes')}</div><p className="text-sm whitespace-pre-wrap">{o.notes}</p></Card>}

      <Stats>
        <Stat label={t('calendar.stat.mine')} value={<Money n={st.mine} />} sub={o.budget ? rich('calendar.stat.ofBudget', { amount: <Money n={o.budget} /> }) : t('calendar.stat.noBudget')}>
          <Progress value={st.mine} max={o.budget} />
        </Stat>
        <Stat label={t('calendar.stat.covered')} value={`${st.people.length - st.missing.length} / ${st.people.length}`} sub={t('calendar.stat.coveredSub')} />
      </Stats>

      <Section title={t('calendar.who.title')}>
        {st.people.length ? (
          <div className="flex flex-col gap-4">{st.people.map((pid) => <PersonBlock key={pid} o={o} pid={pid} />)}</div>
        ) : (
          <EmptyState icon={Users}>{t('calendar.who.empty')}</EmptyState>
        )}
      </Section>

      {other.length > 0 && (
        <Section title={t('calendar.other.title')}>
          <p className="meta -mt-1">{t('calendar.other.hint')}</p>
          <List>{other.map((g) => <GiftRow key={g.id} g={g} hideOccasion detail />)}</List>
        </Section>
      )}

      <LeftOut o={o} ids={leftOut} />
    </Page>
  )
}
