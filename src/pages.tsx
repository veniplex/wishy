import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarHeart, Gift as GiftIcon, Lightbulb, Plus, UserRound, Users } from 'lucide-react'
import { useStore } from './store'
import { useAuth } from './auth'
import { fmtIntl, t } from './i18n'
import { NewShared } from './wishlists'
import { GIFT_STATUS, RELATION_GROUPS, costFor, countdown, daysUntil, fmtDate, fmtDateShort, giftDateOf, giftYear, groupOf, isCommitted, isLeftOutBirthday, isLive, joinNames, nextBirthday, parseDate, statusInfo, sum, type Occasion, type Person } from './lib'
import { Avatar, Badge, Button, EmptyState, List, Money, Page, PageHeader, PillTabs, Progress, Row, Section, SearchField, Segmented, Select, Thumb, ToggleLink, Toolbar } from './ui'
import { PersonSelect } from './pickers'
import { GiftRow, ItemRow, OccasionRow, rich, useOccasionStats } from './components'
import { CalendarMonth } from './calendar-view'
import { AiImportButton } from './ai'
import { giveTabs } from './nav'
import { GroupHeading, groupByPerson, plannedGifts } from './plan-parts'
import { InboxNotice, InboxSection, useInboxCount } from './inbox'

// ---------------- Home ----------------
/** "Up next" card: an occasion with countdown, coverage status and budget */
function OccasionCard({ o }: { o: Occasion }) {
  const { s, occasionTitle, person } = useStore()
  const st = useOccasionStats(o)
  const days = daysUntil(o.date, s.today)
  const covered = st.people.length - st.missing.length
  const chip: { tone: 'accent' | 'warn' | 'ok' | 'neutral'; text: string } = !st.people.length
    ? { tone: 'neutral', text: st.gifts.length ? t('start.occ.chip.planned') : t('start.occ.chip.noPeople') }
    : covered === 0 ? { tone: 'accent', text: t('start.occ.chip.missing') }
    : st.missing.length ? { tone: 'warn', text: t('start.occ.chip.covered', { covered, total: st.people.length }) }
    : { tone: 'ok', text: t('start.occ.chip.planned') }
  const missingNames = st.missing.map((id) => person(id)?.name).filter(Boolean) as string[]
  const status = st.missing.length
    ? t('start.occ.status.missing', { names: joinNames(missingNames) })
    : st.open ? t('start.occ.status.open', { count: st.open }) : st.gifts.length ? t('start.occ.status.done') : ''
  const pct = o.budget ? Math.min(100, (st.mine / o.budget) * 100) : 0
  return (
    <Link to={`/calendar/${o.id}`} className="card p-6 flex flex-col gap-4 min-w-0 hover:brightness-[0.98] transition">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-[1_1_8rem]">
          <div className="font-display font-semibold text-xl leading-tight">{occasionTitle(o, false)}</div>
          <div className="meta text-sm mt-0.5">{fmtDateShort(o.date)}</div>
        </div>
        <Badge tone={chip.tone}>{chip.text}</Badge>
      </div>
      <div className="display-num text-4xl leading-none">{countdown(days)}</div>
      <div className="flex items-center gap-3">
        <div className="flex gap-2 flex-wrap">
          {st.people.slice(0, 5).map((id) => <Avatar key={id} p={person(id)} size={32} ring={st.missing.includes(id) ? 'var(--accent)' : 'var(--ok)'} />)}
        </div>
        <div className="text-sm text-muted leading-snug min-w-0">{status}</div>
      </div>
      <div className="mt-auto">
        <div className="meta mb-1.5">{o.budget ? rich('start.occ.budget', { mine: <Money n={st.mine} />, budget: <Money n={o.budget} /> }) : t('start.occ.noBudget')}</div>
        <div className="progress"><div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} /></div>
      </div>
    </Link>
  )
}

export function Dashboard() {
  const { s, me, open, person, call } = useStore()
  const fresh = s.persons.every((p) => p.is_me) && !s.occasions.length && !s.gifts.length && !s.items.length
  if (fresh) {
    return (
      <Page>
        <div className="max-w-sm mx-auto mt-[6vh] text-center">
          <span className="inline-grid place-items-center size-14 rounded-[20px] bg-accent text-accent-ink mb-5"><GiftIcon size={26} strokeWidth={2} /></span>
          <h1 className="h1">{me ? t('start.welcome.title', { name: me.name }) : t('start.welcome.titleAnon')}</h1>
          <p className="text-muted mt-3 mb-6 text-base">{t('start.welcome.text')}</p>
          <Button variant="primary" icon={Plus} onClick={() => open({ type: 'person' })}>{t('start.welcome.create')}</Button>
          <div><Button variant="ghost" size="sm" className="mt-4" onClick={() => call('POST', '/api/demo')}>{t('start.welcome.demo')}</Button></div>
        </div>
        <div className="mt-6"><NewShared /></div>
      </Page>
    )
  }
  const year = s.today.slice(0, 4)
  const upcoming = s.occasions.filter((o) => o.date >= s.today && !isLeftOutBirthday(o))
  const next = upcoming.slice(0, 3)
  const spent = sum(s.gifts.filter((g) => giftYear(s, g) === year && isCommitted(g.status)).map((g) => costFor(g, me?.id ?? null)))
  const budget = s.settings.yearly_budget
  const today = parseDate(s.today)
  const dateText = t('common.dateToday', { weekday: fmtIntl(today, { weekday: 'long' }), date: fmtIntl(today, { day: 'numeric', month: 'long' }) })
  // First person with an upcoming occasion who has nothing planned yet
  const gap = upcoming.filter((o) => daysUntil(o.date, s.today) <= 60).flatMap((o) => {
    const covered = new Set(s.gifts.filter((g) => g.occasion_id === o.id && g.status !== 'returned').flatMap((g) => g.recipient_ids))
    return o.person_ids.filter((id) => !covered.has(id) && person(id) && !person(id)!.is_me).map((id) => ({ o, p: person(id)! }))
  })[0]
  // Open payments: still to pay / shares to collect
  const toPay = s.gifts.filter((g) => g.payment_status !== 'paid' && isCommitted(g.status) && g.status !== 'given')
  const toCollect = s.gifts.filter((g) => g.payment_status === 'paid' && g.payer_id === me?.id && (g.payment_summary?.open_count ?? 0) > 0)
  const people = s.persons
    .filter((p) => !p.is_me && !p.archived)
    .map((p) => ({ p, bday: s.occasions.find((o) => o.type === 'birthday' && o.person_id === p.id && o.date >= s.today && !isLeftOutBirthday(o)) }))
    .sort((a, b) => (a.bday?.date ?? '9').localeCompare(b.bday?.date ?? '9'))
    .slice(0, 8)

  return (
    <Page>
      <InboxNotice />
      <section>
        <h1 className="h1">{t('start.hello')}</h1>
        <p className="text-muted mt-3 text-lg max-w-2xl">
          {t('start.intro.today', { date: dateText })} {gap ? t('start.intro.gap', { name: gap.p.name, count: daysUntil(gap.o.date, s.today) }) : t('start.intro.calm')}
        </p>
      </section>

      <Section eyebrow={t('nav.main.give')} title={t('start.next.title')} action={<Button variant="link" className="!text-sm" to="/calendar">{t('start.next.toCalendar')}</Button>}>
        {next.length ? (
          <div className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,290px),1fr))]">{next.map((o) => <OccasionCard key={o.id} o={o} />)}</div>
        ) : (
          <EmptyState icon={CalendarHeart}>{t('start.next.empty')}</EmptyState>
        )}
      </Section>

      {(toPay.length > 0 || toCollect.length > 0) && (
        <Section eyebrow={t('nav.main.give')} title={t('start.todo.title')}>
          <List>
            {toCollect.map((g) => (
              <Row key={`c${g.id}`} lead={<Thumb icon={GiftIcon} />} title={t('start.todo.collect', { title: g.title })} meta={t('start.todo.sharesOpen', { count: g.payment_summary!.open_count })} trailing={<Money n={g.payment_summary!.open_amount} strong />} actions={<Button size="sm" variant="accent" onClick={() => open({ type: 'gift', initial: g })}>{t('start.todo.openShares')}</Button>} />
            ))}
            {toPay.map((g) => (
              <Row key={`p${g.id}`} lead={<Thumb icon={GiftIcon} />} title={t('start.todo.pay', { title: g.title })} meta={t('status.label', { status: statusInfo(g.status).label })} trailing={<Money n={g.price} strong />} actions={<Button size="sm" variant="accent" onClick={() => open({ type: 'gift', initial: g })}>{t('start.todo.recordPayment')}</Button>} />
            ))}
          </List>
        </Section>
      )}

      <section className="card p-5 md:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <h2 className="h2 text-[22px]">{t('start.who.title')}</h2>
          <Button variant="link" className="!text-sm" to="/gifting">{t('start.who.all')}</Button>
        </div>
        <div className="flex gap-2 overflow-x-auto no-scrollbar pt-4 pb-1 -mx-2 px-2">
          {people.map(({ p, bday }) => {
            const days = bday ? daysUntil(bday.date, s.today) : null
            return (
              <Link key={p.id} to={`/gifting/${p.id}`} className="shrink-0 w-24 flex flex-col items-center gap-2 text-center">
                <Avatar p={p} size={64} ring={days != null && days <= 30 ? 'var(--accent)' : days != null && days <= 60 ? 'var(--warn)' : 'var(--line)'} />
                <span className="leading-tight"><span className="block font-semibold truncate max-w-24">{p.name}</span><span className="block text-xs text-muted">{days != null ? countdown(days) : (p.relationship ?? '')}</span></span>
              </Link>
            )
          })}
          {s.permissions.manage_persons && <button type="button" onClick={() => open({ type: 'person' })} className="shrink-0 w-24 flex flex-col items-center gap-2 text-center text-muted cursor-pointer">
            <span className="size-16 rounded-full border-2 border-dashed border-muted grid place-items-center"><Plus size={24} /></span>
            <span className="text-sm font-semibold">{t('start.who.add')}</span>
          </button>}
        </div>
      </section>

      <div className="flex flex-wrap gap-5">
        <NewShared className="flex-[1_1_320px]" />
        <Section className="flex-[1_1_320px]" eyebrow={t('nav.main.give')} title={t('start.budget.title')}>
          <div className="card p-5 flex flex-col gap-3">
            <div className="flex flex-wrap justify-between items-baseline gap-x-3">
              <span className="font-semibold">{t('start.budget.spent', { year })}</span>
              <span className="text-muted"><b className="display-num text-ink text-2xl"><Money n={spent} /></b>{budget ? <> {rich('start.budget.of', { amount: <Money n={budget} /> })}</> : null}</span>
            </div>
            {budget ? <Progress value={spent} max={budget} /> : <p className="text-sm text-muted">{t('start.budget.hint')}</p>}
          </div>
        </Section>
      </div>
    </Page>
  )
}

// ---------------- Calendar ----------------
const monthKey = (d: string) => d.slice(0, 7)
const monthLabel = (k: string) => fmtIntl(parseDate(`${k}-01`), { month: 'long', year: 'numeric' })

const VIEW_KEY = 'wishy.calendarView'
type CalView = 'month' | 'list'
const readView = (): CalView => {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'month' } catch { return 'month' }
}

export function Occasions() {
  const { s, open } = useStore()
  const [showPast, setShowPast] = useState(false)
  const [view, setViewState] = useState<CalView>(readView)
  const setView = (v: CalView) => {
    setViewState(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* ignore */ }
  }
  const upcoming = s.occasions.filter((o) => o.date >= s.today)
  const past = s.occasions.filter((o) => o.date < s.today).reverse()
  const agenda = (list: Occasion[]) => [...new Set(list.map((o) => monthKey(o.date)))].map((k) => (
    <Section key={k} title={monthLabel(k)}>
      <List>{list.filter((o) => monthKey(o.date) === k).map((o) => <OccasionRow key={o.id} o={o} />)}</List>
    </Section>
  ))
  return (
    <Page>
      <PageHeader
        title={t('calendar.title')}
        sub={t('calendar.sub')}
        actions={s.permissions.manage_occasions ? <Button variant="primary" icon={Plus} onClick={() => open({ type: 'occasion' })}>{t('calendar.create')}</Button> : undefined}
      />
      <div className="max-w-60"><PillTabs<CalView> label={t('calendar.view.label')} value={view} onChange={setView} items={[{ value: 'month', label: t('calendar.view.month') }, { value: 'list', label: t('calendar.view.list') }]} /></div>
      {view === 'month' ? <CalendarMonth /> : <>
        {upcoming.length ? agenda(upcoming) : <EmptyState icon={CalendarHeart}>{t('calendar.empty')}</EmptyState>}
        {past.length > 0 && <ToggleLink on={showPast} onToggle={() => setShowPast(!showPast)} labelOn={t('calendar.past.hide')} labelOff={t('calendar.past.show', { count: past.length })} />}
        {showPast && agenda(past)}
      </>}
    </Page>
  )
}

// ---------------- Gifting: Who for ----------------
export function Persons() {
  const { s, open, me, itemState, occasionTitle } = useStore()
  const { space } = useAuth()
  const [showArchived, setShowArchived] = useState(false)
  const year = s.today.slice(0, 4)
  const list = s.persons.filter((p) => !p.is_me && (showArchived || !p.archived))
  const groups = RELATION_GROUPS.filter((g) => list.some((p) => groupOf(p) === g.id))
  const hasArchived = s.persons.some((p) => p.archived)
  const card = (p: Person) => {
    const openItems = s.items.filter((i) => i.person_id === p.id && itemState(i) === 'open').length
    const spent = sum(s.gifts.filter((g) => g.recipient_ids.includes(p.id) && giftYear(s, g) === year).map((g) => costFor(g, me?.id ?? null) / g.recipient_ids.length))
    const bday = p.birthday ? nextBirthday(p.birthday, s.today) : null
    const days = bday ? daysUntil(bday.date, s.today) : null
    // Next occasion the person takes part in, and what is planned for them there
    const next = s.occasions.find((o) => o.date >= s.today && o.person_ids.includes(p.id))
    const planned = next ? plannedGifts(s.gifts.filter((g) => g.occasion_id === next.id && g.recipient_ids.includes(p.id))).length : 0
    return (
      <div key={p.id} className={`card relative p-5 flex flex-col gap-4 min-w-0 hover:brightness-[0.98] transition ${p.archived ? 'opacity-70' : ''}`}>
        <div className="flex items-center gap-4 min-w-0">
          <Avatar p={p} size={64} ring={days != null && days <= 30 ? 'var(--accent)' : undefined} />
          <div className="min-w-0">
            <Link to={`/gifting/${p.id}`} className="row-stretch font-display font-semibold text-xl leading-tight truncate block">{p.name}</Link>
            <div className="text-sm text-muted truncate">{p.relationship || (p.archived ? t('give.persons.archived') : ' ')}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {bday ? <Badge tone={days! <= 30 ? 'accent' : 'neutral'}>{fmtDate(bday.date, false)} · {countdown(days!)}</Badge>
            : s.permissions.manage_persons && !p.archived && <Button variant="link" className="row-above !text-xs" onClick={() => open({ type: 'person', initial: p, focus: 'birthday' })}>{t('give.persons.addBirthday')}</Button>}
          <Badge tone={openItems ? 'info' : 'neutral'}>{t('give.persons.openIdeas', { count: openItems })}</Badge>
          {p.linked_user_id ? <Badge tone="info" icon={UserRound}>{t('give.persons.appUser')}</Badge> : null}
        </div>
        {next && <div className={`text-sm ${planned ? 'text-muted' : 'text-warn'}`}>{planned ? t('give.persons.nextPlanned', { occasion: occasionTitle(next, false), count: planned }) : t('give.persons.nextNothing', { occasion: occasionTitle(next, false) })}</div>}
        {(spent > 0 || !!p.yearly_budget) && (
          <div>
            <div className="meta mb-1.5">{p.yearly_budget ? rich('give.persons.spentInOf', { spent: <Money n={spent} />, budget: <Money n={p.yearly_budget} /> }, { year }) : rich('give.persons.spentIn', { spent: <Money n={spent} /> }, { year })}</div>
            <Progress value={spent} max={p.yearly_budget} />
          </div>
        )}
      </div>
    )
  }
  return (
    <Page>
      <PageHeader
        title={t('nav.main.give')}
        sub={space && !space.personal ? t('give.persons.subSpace', { space: space.name }) : t('give.persons.sub')}
        tabs={giveTabs(s.permissions.view_expenses)}
        actions={s.permissions.manage_persons ? <Button variant="primary" icon={Plus} onClick={() => open({ type: 'person' })}>{t('give.persons.create')}</Button> : undefined}
      />
      {groups.map((g) => (
        <Section key={g.id} title={g.label}>
          <div className="grid gap-5 grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))]">{list.filter((p) => groupOf(p) === g.id).map(card)}</div>
        </Section>
      ))}
      {!list.length && <EmptyState icon={Users} action={<Button size="sm" icon={Plus} onClick={() => open({ type: 'person' })}>{t('give.persons.create')}</Button>}>{t('give.persons.empty')}</EmptyState>}
      {hasArchived && <ToggleLink on={showArchived} onToggle={() => setShowArchived(!showArchived)} labelOn={t('give.persons.hideArchived')} labelOff={t('give.persons.showArchived')} />}
    </Page>
  )
}

// ---------------- All gifts ----------------
const GIFT_VIEW_KEY = 'wishy.giftsView'
type GiftView = 'person' | 'date'
const readGiftView = (): GiftView => {
  try { return localStorage.getItem(GIFT_VIEW_KEY) === 'date' ? 'date' : 'person' } catch { return 'person' }
}

export function Gifts() {
  const { s, open, money, activePersons, person } = useStore()
  const [view, setViewState] = useState<GiftView>(readGiftView)
  const setView = (v: GiftView) => {
    setViewState(v)
    try { localStorage.setItem(GIFT_VIEW_KEY, v) } catch { /* ignore */ }
  }
  const [q, setQ] = useState('')
  const [range, setRange] = useState('upcoming')
  const [pid, setPid] = useState(0)
  const [status, setStatus] = useState('')
  const [pay, setPay] = useState('')
  const years = [...new Set(s.gifts.map((g) => giftYear(s, g)))].sort().reverse()
  const list = s.gifts
    .filter((g) => {
      const d = giftDateOf(s, g)
      if (range === 'upcoming' && !((g.status !== 'given' && g.status !== 'returned') || d >= s.today)) return false
      if (status && statusInfo(g.status).id !== status) return false
      if (pay === 'unpaid' && (g.payment_status === 'paid' || g.status === 'returned')) return false
      if (pay === 'paid' && g.payment_status !== 'paid') return false
      if (pay === 'open' && !(g.payment_summary && g.payment_summary.open_count > 0)) return false
      if (/^\d{4}$/.test(range) && d.slice(0, 4) !== range) return false
      if (pid && !g.recipient_ids.includes(pid) && !g.givers.some((x) => x.person_id === pid)) return false
      if (q && !`${g.title} ${g.shop ?? ''} ${g.notes ?? ''} ${g.recipient_ids.map((id) => person(id)?.name).join(' ')}`.toLowerCase().includes(q.toLowerCase())) return false
      return true
    })
    .sort((a, b) => (range === 'upcoming' ? giftDateOf(s, a).localeCompare(giftDateOf(s, b)) : giftDateOf(s, b).localeCompare(giftDateOf(s, a))))
  return (
    <Page>
      <PageHeader
        title={t('gifts.title')}
        sub={t('gifts.sub', { count: list.length, total: money(sum(list.map((g) => g.price ?? 0))) })}
        tabs={giveTabs(s.permissions.view_expenses)}
        actions={s.permissions.manage_gifts ? <Button variant="primary" icon={Plus} onClick={() => open({ type: 'gift' })}>{t('gifts.plan')}</Button> : undefined}
      />
      <Section>
        <Toolbar>
          <SearchField className="flex-1 min-w-48 max-sm:basis-full" aria-label={t('gifts.searchAria')} placeholder={t('gifts.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
          <Select inline className="max-sm:flex-1" aria-label={t('gifts.range.aria')} value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="upcoming">{t('gifts.range.upcoming')}</option>
            <option value="all">{t('gifts.range.all')}</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
          <PersonSelect inline create={false} className="max-sm:flex-1" label={t('give.person')} none={t('give.allPersons')} persons={activePersons} value={pid} onChange={setPid} />
          <Select inline className="max-sm:flex-1" aria-label={t('gifts.status.aria')} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('gifts.status.all')}</option>
            {GIFT_STATUS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
          <Select inline className="max-sm:flex-1" aria-label={t('gifts.pay.aria')} value={pay} onChange={(e) => setPay(e.target.value)}>
            <option value="">{t('gifts.pay.all')}</option>
            <option value="unpaid">{t('gifts.pay.unpaid')}</option>
            <option value="open">{t('gifts.pay.open')}</option>
            <option value="paid">{t('gifts.pay.paid')}</option>
          </Select>
          <Segmented<GiftView> label={t('gifts.view.label')} value={view} onChange={setView} options={[{ value: 'person', label: t('gifts.view.person') }, { value: 'date', label: t('gifts.view.date') }]} />
        </Toolbar>
        {view === 'person' && list.length > 0 ? (
          <div className="space-y-8 pt-2">
            {groupByPerson(list, (g) => g.recipient_ids, person).map((gr) => (
              <div key={gr.key}>
                <GroupHeading group={gr} count={gr.items.length} />
                <List>{gr.items.map((g) => <GiftRow key={g.id} g={g} detail except={gr.person?.id} />)}</List>
              </div>
            ))}
          </div>
        ) : (
          <List empty={<EmptyState icon={GiftIcon}>{t('gifts.empty')}</EmptyState>}>
            {list.map((g) => <GiftRow key={g.id} g={g} detail />)}
          </List>
        )}
      </Section>
    </Page>
  )
}

// ---------------- Wishes & ideas ----------------
export function Ideas() {
  const { s, open, activePersons, call, itemState, person } = useStore()
  const [pid, setPid] = useState(0)
  const [showDone, setShowDone] = useState(false)
  const [quick, setQuick] = useState('')
  const inboxN = useInboxCount()
  const tabs = giveTabs(s.permissions.view_expenses).map((tb) => (tb.to === '/gifting/ideas' && inboxN > 0 ? { ...tb, label: <span className="inline-flex items-center gap-2">{tb.label}<Badge tone="accent">{inboxN}</Badge></span> } : tb))
  const others = activePersons.filter((p) => !p.is_me)
  const list = s.items.filter((i) => {
    if (person(i.person_id)?.is_me) return false
    if (pid && i.person_id !== pid) return false
    if (!showDone && !isLive(itemState(i))) return false
    return true
  })
  const quickAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = quick.trim()
    if (!text) return
    if (/^https?:\/\//i.test(text)) {
      open({ type: 'item', initial: { url: text, person_id: pid || undefined } })
      return setQuick('')
    }
    if (!pid) {
      open({ type: 'item', initial: { title: text } })
      return setQuick('')
    }
    if (await call('POST', '/api/items', { title: text, person_id: pid })) setQuick('')
  }
  return (
    <Page>
      <PageHeader
        title={t('nav.tabs.give.ideas')}
        sub={t('give.ideas.sub')}
        tabs={tabs}
        actions={s.permissions.manage_gifts ? <><AiImportButton init={{ target: 'ideas', personId: pid || undefined }} label={t('give.detail.aiImport')} /><Button variant="primary" icon={Plus} onClick={() => open({ type: 'item', initial: { person_id: pid || undefined } })}>{t('give.detail.newIdea')}</Button></> : undefined}
      />
      <InboxSection />
      <Section>
        <Toolbar>
          <PersonSelect inline create={false} className="max-sm:flex-1" label={t('give.person')} none={t('give.allPersons')} persons={others} value={pid} onChange={setPid} />
        </Toolbar>
        {s.permissions.manage_gifts && <form onSubmit={quickAdd}>
          <SearchField icon={Plus} aria-label={t('give.ideas.quickAria')} placeholder={pid ? t('give.ideas.quickPhFor', { name: person(pid)?.name ?? '' }) : t('give.ideas.quickPh')} value={quick} onChange={(e) => setQuick(e.target.value)} />
        </form>}
        {!pid && list.length > 0 ? (
          <div className="space-y-8 pt-2">
            {groupByPerson(list, (i) => [i.person_id], person).map((gr) => (
              <div key={gr.key}>
                <GroupHeading group={gr} count={gr.items.length} />
                <List>{gr.items.map((i) => <ItemRow key={i.id} i={i} />)}</List>
              </div>
            ))}
          </div>
        ) : (
          <List empty={<EmptyState icon={Lightbulb}>{t('give.ideas.empty')}</EmptyState>}>
            {list.map((i) => <ItemRow key={i.id} i={i} />)}
          </List>
        )}
        <ToggleLink on={showDone} onToggle={() => setShowDone(!showDone)} labelOn={t('give.detail.doneHide')} labelOff={t('give.detail.doneShowAll')} />
      </Section>
    </Page>
  )
}
