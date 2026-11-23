/** Person page (`/gifting/:id`): the main place to plan gifts – one block per upcoming occasion, then everything without an occasion. */
import { useState } from 'react'
import { CalendarHeart, Heart, Lightbulb, Link2, Lock, Pencil, Users } from 'lucide-react'
import { Navigate, useParams } from 'react-router-dom'
import { useLinkOptions, useOccasionTypes, useStore } from './store'
import { t } from './i18n'
import { RELATION_GROUPS, costFor, countdown, daysUntil, fmtDate, giftDateOf, giftYear, groupOf, isLive, nextBirthday, sum, type Occasion, type Person } from './lib'
import { Avatar, Button, Crumbs, EmptyState, IconButton, List, Money, Page, PillTabs, Section, Thumb, ToggleLink, tintOf } from './ui'
import { GiftRow, IdeaCard, ItemRow, occasionIconByName, rich } from './components'
import { LinkedLists } from './wishlists'
import { AiImportButton, SuggestButton } from './ai'
import { LeaveMenu, PlanBadge, PlanBlock, PlanButtons, useLeaveOut } from './plan-parts'

type Tab = 'plan' | 'lists' | 'history'

/** What the person has in an occasion: all gifts and the ideas still being worked on */
function useOccasionStuff(p: Person) {
  const { s, itemState } = useStore()
  return (o: Occasion) => ({
    gifts: s.gifts.filter((g) => g.occasion_id === o.id && g.recipient_ids.includes(p.id)),
    ideas: s.items.filter((i) => i.person_id === p.id && i.occasion_id === o.id && isLive(itemState(i))).sort((a, b) => b.priority - a.priority),
  })
}

/** Occasions by date: upcoming ones the person takes part in or has something in, upcoming ones they are left out of, and past ones with unfinished business */
function usePersonOccasions(p: Person) {
  const { s } = useStore()
  const stuff = useOccasionStuff(p)
  const upcoming = s.occasions.filter((o) => o.date >= s.today)
  const unfinished = (o: Occasion) => stuff(o).gifts.some((g) => g.status !== 'given' && g.status !== 'returned') || stuff(o).ideas.length > 0
  return {
    active: upcoming.filter((o) => !o.excluded_ids.includes(p.id) && (o.person_ids.includes(p.id) || stuff(o).gifts.length > 0 || stuff(o).ideas.length > 0)),
    leftOut: upcoming.filter((o) => o.excluded_ids.includes(p.id)),
    past: s.occasions.filter((o) => o.date < s.today && unfinished(o)).reverse(),
  }
}

function OccasionBlock({ o, p }: { o: Occasion; p: Person }) {
  const { s, occasionTitle } = useStore()
  const types = useOccasionTypes()
  const { can, leave } = useLeaveOut()
  const { gifts, ideas } = useOccasionStuff(p)(o)
  return (
    <PlanBlock
      lead={<Thumb tone="accent" icon={occasionIconByName(types.of(o.type).icon)} />}
      title={occasionTitle(o, false)}
      to={`/calendar/${o.id}`}
      meta={`${fmtDate(o.date, false)} · ${countdown(daysUntil(o.date, s.today))}`}
      status={<PlanBadge gifts={gifts} />}
      menu={can && <LeaveMenu label={t('calendar.plan.leaveHere', { name: p.name })} onLeave={() => void leave(o, p.id)} />}
      footer={<PlanButtons personId={p.id} occasionId={o.id} />}
    >
      {gifts.map((g) => <GiftRow key={g.id} g={g} hideOccasion detail except={p.id} />)}
      {ideas.map((i) => <ItemRow key={i.id} i={i} hideOccasion />)}
    </PlanBlock>
  )
}

/** Muted, collapsed line "Left out of 2 occasions"; expanded: each occasion with what the person has there, and "Include again" */
function LeftOutLine({ p, occasions }: { p: Person; occasions: Occasion[] }) {
  const { occasionTitle } = useStore()
  const types = useOccasionTypes()
  const { can, include } = useLeaveOut()
  const stuff = useOccasionStuff(p)
  const [open, setOpen] = useState(false)
  if (!occasions.length) return null
  const label = t('give.detail.leftOut', { count: occasions.length })
  return (
    <div className="space-y-3">
      <ToggleLink chevron className="text-muted" on={open} onToggle={() => setOpen(!open)} labelOn={label} labelOff={label} />
      {open && (
        <div className="flex flex-col gap-4">
          {occasions.map((o) => {
            const { gifts, ideas } = stuff(o)
            return (
              <PlanBlock
                key={o.id}
                dim
                lead={<Thumb tone="accent" icon={occasionIconByName(types.of(o.type).icon)} />}
                title={occasionTitle(o, false)}
                to={`/calendar/${o.id}`}
                meta={fmtDate(o.date, false)}
                menu={can && <Button size="sm" onClick={() => void include(o, p.id)}>{t('calendar.plan.include')}</Button>}
              >
                {gifts.map((g) => <GiftRow key={g.id} g={g} hideOccasion detail except={p.id} />)}
                {ideas.map((i) => <ItemRow key={i.id} i={i} hideOccasion />)}
              </PlanBlock>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PlanTab({ p }: { p: Person }) {
  const { s, itemState } = useStore()
  const { active, leftOut, past } = usePersonOccasions(p)
  const stuff = useOccasionStuff(p)
  const [showDone, setShowDone] = useState(false)
  // Only gifts and ideas that really have no occasion belong under "Without an occasion"
  const mine = s.items.filter((i) => i.person_id === p.id)
  const live = mine.filter((i) => !i.occasion_id && isLive(itemState(i))).sort((a, b) => b.priority - a.priority)
  const finished = mine.filter((i) => !isLive(itemState(i)))
  const ideas = showDone ? [...live, ...finished] : live
  const loose = s.gifts
    .filter((g) => g.recipient_ids.includes(p.id) && !g.occasion_id && g.status !== 'given' && g.status !== 'returned')
    .sort((a, b) => giftDateOf(s, a).localeCompare(giftDateOf(s, b)))
  const buttons = s.permissions.manage_gifts ? <PlanButtons personId={p.id} /> : null
  const ai = (
    <>
      {p.linked_user_id !== s.user_id && <SuggestButton personId={p.id} personName={p.name} />}
      <AiImportButton init={{ target: 'ideas', personId: p.id }} label={t('give.detail.aiImport')} />
    </>
  )
  const pastRows = past.flatMap((o) => {
    const { gifts, ideas: pastIdeas } = stuff(o)
    return [
      ...gifts.filter((g) => g.status !== 'given' && g.status !== 'returned').map((g) => <GiftRow key={`g${g.id}`} g={g} detail except={p.id} />),
      ...pastIdeas.map((i) => <ItemRow key={`i${i.id}`} i={i} />),
    ]
  })
  return (
    <div className="flex flex-col gap-8">
      {p.linked_user_id ? <p className="meta flex items-center gap-2 -mb-4"><Lock size={15} />{t('give.detail.surprise', { name: p.name })}</p> : null}
      {active.length > 0 && <div className="flex flex-col gap-4">{active.map((o) => <OccasionBlock key={o.id} o={o} p={p} />)}</div>}

      {!loose.length && !ideas.length ? (
        <div className="card px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex-[1_1_16rem] min-w-0">
            <div className="h3">{t('give.detail.noOccasion')}</div>
            <p className="text-sm text-muted mt-0.5">{t('give.detail.ideasEmpty')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">{buttons}{ai}</div>
        </div>
      ) : (
        <Section title={t('give.detail.noOccasion')} action={<div className="flex flex-wrap justify-end gap-2">{ai}</div>}>
          {loose.length > 0 && <List>{loose.map((g) => <GiftRow key={g.id} g={g} except={p.id} />)}</List>}
          {ideas.length > 0 && <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))]">{ideas.map((i) => <IdeaCard key={i.id} i={i} />)}</div>}
          {buttons && <div className="flex flex-wrap gap-2">{buttons}</div>}
        </Section>
      )}
      {finished.length > 0 && <div className="-mt-4"><ToggleLink on={showDone} onToggle={() => setShowDone(!showDone)} labelOn={t('give.detail.doneHide')} labelOff={t('give.detail.doneShow', { count: finished.length })} /></div>}

      {pastRows.length > 0 && (
        <Section title={t('give.detail.pastOccasions')}>
          <List>{pastRows}</List>
        </Section>
      )}

      <LeftOutLine p={p} occasions={leftOut} />
    </div>
  )
}

function HistoryTab({ p }: { p: Person }) {
  const { s, me } = useStore()
  const gifts = s.gifts.filter((g) => g.recipient_ids.includes(p.id)).sort((a, b) => giftDateOf(s, b).localeCompare(giftDateOf(s, a)))
  const years = [...new Set(gifts.map((g) => giftYear(s, g)))]
  return (
    <>
      <h2 className="h2 text-2xl mb-4">{t('give.detail.history')}</h2>
      {!gifts.length && <EmptyState icon={Lightbulb}>{t('give.detail.historyEmpty')}</EmptyState>}
      <div className="space-y-6">
        {years.map((y) => {
          const list = gifts.filter((g) => giftYear(s, g) === y)
          const share = sum(list.map((g) => costFor(g, me?.id ?? null) / g.recipient_ids.length))
          return (
            <div key={y} className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="h3 text-lg">{y}</h3>
                <span className="meta num">{y === s.today.slice(0, 4) && p.yearly_budget ? rich('give.detail.yourShareOf', { amount: <Money n={share} />, budget: <Money n={p.yearly_budget} /> }) : rich('give.detail.yourShare', { amount: <Money n={share} /> })}</span>
              </div>
              <List>{list.map((g) => <GiftRow key={g.id} g={g} except={p.id} />)}</List>
            </div>
          )
        })}
      </div>
    </>
  )
}

export function PersonDetail() {
  const { personId } = useParams()
  const { s, person, open, itemState } = useStore()
  const links = useLinkOptions()
  const [tab, setTab] = useState<Tab>('plan')
  const p = person(Number(personId))
  if (p && p.id !== Number(personId)) return <Navigate to={`/gifting/${p.id}`} replace /> // created offline, synced meanwhile
  if (!p) return <Page><EmptyState icon={Users} action={<Button size="sm" to="/gifting">{t('give.detail.back')}</Button>}>{t('give.detail.notFound')}</EmptyState></Page>
  if (p.is_me) return <Page><EmptyState icon={Heart} action={<Button size="sm" to="/wishlists">{t('give.detail.toLists')}</Button>}>{t('give.detail.isMe')}</EmptyState></Page>
  const openCount = s.items.filter((i) => i.person_id === p.id && itemState(i) === 'open').length
  const giftCount = s.gifts.filter((g) => g.recipient_ids.includes(p.id)).length
  const bday = p.birthday ? nextBirthday(p.birthday, s.today) : null
  const wishlists = p.linked_wishlists ?? []
  const linkedName = p.linked_user_id
    ? links?.members.find((m) => m.user_id === p.linked_user_id)?.name ?? links?.followed.find((f) => f.owner.id === p.linked_user_id)?.owner.name ?? p.name
    : null
  const tabs = [
    { value: 'plan' as const, label: t('give.detail.tab.plan') },
    ...(wishlists.length ? [{ value: 'lists' as const, label: t('give.detail.tab.lists') }] : []),
    { value: 'history' as const, label: t('give.detail.tab.history') },
  ]
  const current = tabs.some((x) => x.value === tab) ? tab : 'plan'
  const pill = 'px-3.5 py-1.5 rounded-full bg-card/70 text-sm font-medium'

  return (
    <Page>
      <Crumbs back={{ to: '/gifting', label: t('nav.main.give') }} current={p.name} />
      <section className="relative rounded-[28px] p-5 md:p-8 flex flex-wrap items-center gap-6" style={{ background: tintOf(p.id) }}>
        <Avatar p={p} size={96} ring="var(--accent)" />
        <div className="flex-1 basis-72 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="h1">{p.name}</h1>
            {p.relationship && <span className="text-lg">{p.relationship}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 mt-3 text-[15px]">
            {bday
              ? <span className="inline-flex items-center gap-2"><CalendarHeart size={18} />{t(bday.age ? 'give.detail.birthdayAge' : 'give.detail.birthday', { date: fmtDate(bday.date, false), countdown: countdown(daysUntil(bday.date, s.today)), age: bday.age ?? 0 })}</span>
              : s.permissions.manage_persons && <Button size="sm" icon={CalendarHeart} onClick={() => open({ type: 'person', initial: p, focus: 'birthday' })}>{t('give.detail.addBirthday')}</Button>}
            {linkedName && <span className="inline-flex items-center gap-2"><Link2 size={18} />{t('give.detail.linked', { name: linkedName })}</span>}
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            <span className={pill}>{RELATION_GROUPS.find((g) => g.id === groupOf(p))?.label}</span>
            <span className={pill}>{t('give.persons.openIdeas', { count: openCount })}</span>
            {p.yearly_budget ? <span className={pill}>{rich('give.detail.budget', { amount: <Money n={p.yearly_budget} /> })}</span> : null}
            {giftCount > 0 && <span className={pill}>{t('give.detail.giftsCount', { count: giftCount })}</span>}
          </div>
          {p.notes && <p className="text-sm mt-3 whitespace-pre-wrap">{p.notes}</p>}
        </div>
        {s.permissions.manage_persons && <IconButton icon={Pencil} label={t('give.detail.edit')} className="icon-btn-surface absolute top-4 right-4 md:static md:self-start" onClick={() => open({ type: 'person', initial: p })} />}
      </section>

      <PillTabs label={t('give.detail.tabsLabel', { name: p.name })} value={current} onChange={setTab} items={tabs} />

      <div>
        {current === 'plan' && <PlanTab p={p} />}
        {current === 'lists' && <LinkedLists personName={p.name} lists={wishlists} />}
        {current === 'history' && <HistoryTab p={p} />}
      </div>
    </Page>
  )
}
