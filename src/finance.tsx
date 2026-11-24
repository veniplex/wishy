import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { Check, ChevronDown, Gift as GiftIcon } from 'lucide-react'
import { useOccasionTypes, useStore } from './store'
import { rich } from './components'
import { occasionIconByName } from './occasion-icons'
import { costFor, isCommitted, shares, sum, type Gift } from './lib'
import { Avatar, Badge, Button, Card, DataTable, DatePicker, List, Money, Page, PageHeader, Progress, Row, Section, Segmented, Select, Stat, Stats, Thumb, Toolbar, TwoCol, useConfirm } from './ui'
import { Navigate } from 'react-router-dom'
import { giveTabs } from './nav'
import { t, useT, type TKey } from './i18n'
import { CostSplit } from './split'
import { ScrollFade } from './charts'

/** Phones (< 640 px): the period table shows two columns, the breakdown moves under the period */
const PHONE = '(max-width: 639px)'
function usePhone() {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(PHONE); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) },
    () => window.matchMedia(PHONE).matches,
    () => false,
  )
}

interface BarRow { key: string; lead: ReactNode; label: string; spent: number; planned: number; budget?: number | null; to?: string }

/** Spending per occasion/person as rows with a stacked progress bar (filled = spent, striped = planned, tick = budget). */
function Bars({ rows, empty }: { rows: BarRow[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.spent + r.planned, r.budget ?? 0)))
  return (
    <List empty={<Card><p className="text-sm text-muted text-center">{empty}</p></Card>}>
      {rows.map((r) => {
        const total = r.spent + r.planned
        const over = r.budget != null && total > r.budget
        return (
          <Row
            key={r.key}
            dense
            to={r.to}
            lead={r.lead}
            title={r.label}
            trailing={
              <>
                <Money n={total} strong tone={over ? 'bad' : undefined} />
                {r.budget != null && <span className="meta num">{rich('common.ofAmount', { amount: <Money n={r.budget} /> })}</span>}
                {over && <Badge tone="bad">{t('finance.bars.over')}</Badge>}
              </>
            }
            extra={<Progress value={r.spent} planned={r.planned} max={max} marker={r.budget} tone={over ? 'bad' : 'accent'} className="mt-1.5" />}
          />
        )
      })}
    </List>
  )
}

type Gran = 'month' | 'quarter' | 'year'
type RangeId = 'thisYear' | 'last12' | 'lastYear' | 'all' | 'custom'
interface Period { gran: Gran; range: RangeId; from: string; to: string }
interface Bucket { key: string; label: string; spent: number; planned: number; count: number }

/** Labels are resolved lazily on read (the language can change) */
const RANGES = (['thisYear', 'last12', 'lastYear', 'all', 'custom'] as RangeId[]).map((id) => ({ id, get label() { return t(`finance.range.${id}` as TKey) } }))
const GRANS = (['month', 'quarter', 'year'] as Gran[]).map((id) => ({ id, get label() { return t(`finance.gran.${id}` as TKey) } }))
const monthShort = () => t('finance.months').split(',')
const PERIOD_KEY = 'finance-period'
const pad = (n: number) => String(n).padStart(2, '0')
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate()

function loadPeriod(): Period {
  const def: Period = { gran: 'month', range: 'thisYear', from: '', to: '' }
  try {
    const p = JSON.parse(localStorage.getItem(PERIOD_KEY) ?? 'null')
    if (p && GRANS.some((x) => x.id === p.gran) && RANGES.some((x) => x.id === p.range)) return { ...def, ...p }
  } catch { /* ignore */ }
  return def
}

/** Period [from, to] as ISO dates (inclusive) */
function rangeOf(p: Period, today: string, dates: string[]): [string, string] {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7))
  switch (p.range) {
    case 'thisYear': return [`${y}-01-01`, `${y}-12-31`]
    case 'lastYear': return [`${y - 1}-01-01`, `${y - 1}-12-31`]
    case 'last12': { const d = new Date(y, m - 12, 1); return [`${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`, `${y}-${pad(m)}-${pad(lastDay(y, m))}`] }
    case 'all': { const s = [...dates].sort(); return [s[0] ?? today, s.length && s[s.length - 1] > today ? s[s.length - 1] : today] }
    default: {
      const f = p.from || today, t = p.to || today
      return f <= t ? [f, t] : [t, f]
    }
  }
}

function makeBuckets(from: string, to: string, gran: Gran): Bucket[] {
  const out: Bucket[] = []
  const seen = new Set<string>()
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7))
  const ey = Number(to.slice(0, 4)), em = Number(to.slice(5, 7))
  while ((y < ey || (y === ey && m <= em)) && out.length < 600) {
    const q = Math.ceil(m / 3)
    const key = gran === 'month' ? `${y}-${pad(m)}` : gran === 'quarter' ? `${y}-Q${q}` : String(y)
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ key, label: gran === 'month' ? `${monthShort()[m - 1]} ${String(y).slice(2)}` : gran === 'quarter' ? `Q${q} ${y}` : String(y), spent: 0, planned: 0, count: 0 })
    }
    if (++m > 12) { m = 1; y++ }
  }
  return out
}
const bucketKey = (d: string, gran: Gran) =>
  gran === 'month' ? d.slice(0, 7) : gran === 'quarter' ? `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}` : d.slice(0, 4)

/** Open debts (paid gifts only), mutual debts netted */
function netDebts(list: Gift[]) {
  const debts = new Map<string, { from: number; to: number; amount: number; gifts: Gift[] }>()
  for (const g of list) {
    if (g.payment_status !== 'paid' || !g.payer_id || g.status === 'returned') continue
    const sh = shares(g)
    for (const x of g.givers) {
      if (x.person_id === g.payer_id || x.settled) continue
      const amount = sh.get(x.person_id) ?? 0
      if (amount <= 0) continue
      const key = `${x.person_id}>${g.payer_id}`
      const d = debts.get(key) ?? { from: x.person_id, to: g.payer_id, amount: 0, gifts: [] }
      d.amount += amount
      d.gifts.push(g)
      debts.set(key, d)
    }
  }
  return [...debts.values()].flatMap((d) => {
    const back = debts.get(`${d.to}>${d.from}`)
    if (!back) return [d]
    if (back.amount > d.amount || (back.amount === d.amount && d.from > d.to)) return []
    return [{ ...d, amount: d.amount - back.amount, gifts: [...d.gifts, ...back.gifts] }]
  }).filter((d) => d.amount > 0.005)
}


function Chart({ buckets }: { buckets: Bucket[] }) {
  const { money } = useStore()
  useT()
  const [sel, setSel] = useState<string | null>(null)
  const max = Math.max(1, ...buckets.map((b) => b.spent + b.planned))
  const H = 140
  const cur = buckets.find((b) => b.key === sel)
  const short = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
  return (
    <Card>
      <ScrollFade scrollToEnd endKey={buckets.length}>
        <div className="flex items-end gap-1" style={{ minWidth: buckets.length * 48 }} onMouseLeave={() => setSel(null)}>
          {buckets.map((b) => {
            const total = b.spent + b.planned
            return (
              <button
                type="button" key={b.key} onMouseEnter={() => setSel(b.key)} onClick={() => setSel(sel === b.key ? null : b.key)}
                className={`flex-1 min-w-11 flex flex-col items-center justify-end gap-1 rounded-md py-1 ${sel === b.key ? 'bg-soft' : ''}`}
                aria-label={t('finance.chart.aria', { label: b.label, spent: money(b.spent), planned: money(b.planned) })}
              >
                <span className="text-xs leading-4 num text-muted h-4">{total > 0 ? short(total) : ''}</span>
                <span className="flex flex-col justify-end items-stretch w-full max-w-7 border-b border-ctl" style={{ height: H }}>
                  <span className="progress-planned text-accent rounded-t-sm" style={{ height: (b.planned / max) * H }} />
                  <span className={`bg-accent ${b.planned > 0 ? '' : 'rounded-t-sm'}`} style={{ height: (b.spent / max) * H }} />
                </span>
                <span className="text-xs leading-4 text-muted whitespace-nowrap">{b.label}</span>
              </button>
            )
          })}
        </div>
      </ScrollFade>
      <div className="meta mt-2 min-h-4 tabular-nums">
        {cur
          ? <><span className="font-medium text-ink">{cur.label}</span>: {t('finance.chart.detail', { spent: money(cur.spent), planned: money(cur.planned), count: cur.count })}</>
          : t('finance.chart.hint')}
      </div>
    </Card>
  )
}

/** Expenses overview; without the `view_expenses` permission the server sends no money data, so the page is not offered */
export function Finance() {
  const { s } = useStore()
  return s.permissions.view_expenses ? <FinanceView /> : <Navigate to="/gifting" replace />
}

function FinanceView() {
  const { s, me, person, money, giftDate, occasionTitle, call } = useStore()
  const occTypes = useOccasionTypes()
  const phone = usePhone()
  const confirm = useConfirm()
  useT()
  const [period, setPeriodRaw] = useState<Period>(loadPeriod)
  const setPeriod = (p: Partial<Period>) => {
    const n = { ...period, ...p }
    setPeriodRaw(n)
    try { localStorage.setItem(PERIOD_KEY, JSON.stringify(n)) } catch { /* ignore */ }
  }
  const [view, setView] = useState<number | null>(me?.id ?? null)
  const [openPerson, setOpenPerson] = useState<number | null>(null)
  const givers = s.persons.filter((p) => s.gifts.some((g) => g.givers.some((x) => x.person_id === p.id)) || p.is_me)

  const [from, to] = rangeOf(period, s.today, s.gifts.map((g) => giftDate(g).slice(0, 10)))
  const inRange = (g: Gift) => { const d = giftDate(g).slice(0, 10); return d >= from && d <= to }
  const rangeGifts = s.gifts.filter(inRange).filter((g) => g.status !== 'returned')
  const gifts = rangeGifts.filter((g) => costFor(g, view) > 0)
  const split = (list: Gift[], weight: (g: Gift) => number = () => 1) => ({
    spent: sum(list.filter((g) => isCommitted(g.status)).map((g) => costFor(g, view) * weight(g))),
    planned: sum(list.filter((g) => g.status === 'planned').map((g) => costFor(g, view) * weight(g))),
  })
  const total = split(gifts)
  const isMe = view != null && view === me?.id
  const singleYear = from.slice(0, 4) === to.slice(0, 4) && from.slice(5) === '01-01' && to.slice(5) === '12-31'
  const yearBudget = isMe && singleYear ? s.settings.yearly_budget : null
  const rangeLabel = singleYear ? t('finance.stat.sumYear', { year: from.slice(0, 4) }) : t('finance.stat.sumPeriod')

  const buckets = makeBuckets(from, to, period.gran)
  for (const g of gifts) {
    const b = buckets.find((x) => x.key === bucketKey(giftDate(g), period.gran))
    if (!b) continue
    b.count++
    if (isCommitted(g.status)) b.spent += costFor(g, view)
    else b.planned += costFor(g, view)
  }

  const byOccasion: BarRow[] = s.occasions
    .filter((o) => gifts.some((g) => g.occasion_id === o.id))
    .map((o) => ({ key: `o${o.id}`, lead: <Thumb size={32} tone="accent" icon={occasionIconByName(occTypes.of(o.type).icon)} />, label: occasionTitle(o, false), to: `/calendar/${o.id}`, budget: isMe && singleYear ? o.budget : null, ...split(gifts.filter((g) => g.occasion_id === o.id)) }))
  const loose = gifts.filter((g) => !g.occasion_id)
  if (loose.length) byOccasion.push({ key: 'none', lead: <Thumb size={32} icon={GiftIcon} />, label: t('finance.bars.noOccasion'), ...split(loose) })

  const byPerson: BarRow[] = s.persons
    .filter((p) => gifts.some((g) => g.recipient_ids.includes(p.id)))
    .map((p) => ({
      key: `p${p.id}`,
      lead: <Avatar p={p} size={32} />,
      label: p.name,
      to: `/gifting/${p.id}`,
      budget: isMe && singleYear ? p.yearly_budget : null,
      ...split(gifts.filter((g) => g.recipient_ids.includes(p.id)), (g) => 1 / g.recipient_ids.length),
    }))
    .sort((a, b) => b.spent + b.planned - (a.spent + a.planned))

  // Settlement: who owes whom (across years, already paid gifts only)
  const netted = netDebts(s.gifts)
  const name = (id: number, dative = false) => (person(id)?.is_me ? (dative ? t('finance.you.dative') : t('common.you')) : (person(id)?.name ?? '?'))
  const settle = async (d: { from: number; to: number; amount: number }) => {
    const ok = await confirm({ title: t('finance.settle.confirmTitle'), text: t('finance.settle.confirmText', { amount: money(d.amount), a: name(d.from, true), b: name(d.to, true) }), confirmLabel: t('finance.settle.button') })
    if (ok && (await call('POST', '/api/settle', { from_id: d.from, to_id: d.to }))) await call('POST', '/api/settle', { from_id: d.to, to_id: d.from })
  }

  // Who pays how much: shared gifts (>= 2 givers) in the period
  const sharedGifts = rangeGifts.filter((g) => g.givers.length >= 2)
  const payers = s.persons
    .map((p) => {
      const mine = sharedGifts.filter((g) => g.givers.some((x) => x.person_id === p.id))
      return {
        p, gifts: mine,
        share: sum(mine.map((g) => costFor(g, p.id))),
        laidOut: sum(mine.filter((g) => g.payer_id === p.id && g.payment_status === 'paid').map((g) => g.paid_amount ?? g.price ?? 0)),
        balance: sum(netted.filter((d) => d.to === p.id).map((d) => d.amount)) - sum(netted.filter((d) => d.from === p.id).map((d) => d.amount)),
      }
    })
    .filter((x) => x.gifts.length)
    .sort((a, b) => b.share - a.share)

  return (
    <Page>
      <PageHeader title={t('finance.title')} sub={t('finance.sub')} tabs={giveTabs()} />
      <Section>
        <Toolbar>
          <Select inline className="max-sm:basis-full" value={view ?? 0} onChange={(e) => setView(Number(e.target.value) || null)} aria-label={t('finance.view.aria')}>
            {givers.map((p) => <option key={p.id} value={p.id}>{p.is_me ? t('finance.view.mine') : t('finance.view.of', { name: p.name })}</option>)}
            <option value={0}>{t('finance.view.all')}</option>
          </Select>
          <Select
            inline className="max-sm:basis-full" value={period.range} aria-label={t('finance.range.aria')}
            onChange={(e) => setPeriod({ range: e.target.value as RangeId, ...(e.target.value === 'custom' && !period.from ? { from: `${s.today.slice(0, 4)}-01-01`, to: s.today } : {}) })}
          >
            {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
          <Segmented className="max-sm:w-full" label={t('finance.gran.aria')} value={period.gran} onChange={(gran) => setPeriod({ gran })} options={GRANS.map((x) => ({ value: x.id, label: x.label }))} />
        </Toolbar>
        {period.range === 'custom' && (
          <Toolbar>
            <DatePicker inline aria-label={t('finance.custom.from')} value={period.from} max={period.to || undefined} onChange={(v) => setPeriod({ from: v })} />
            <span className="meta">{t('finance.custom.until')}</span>
            <DatePicker inline aria-label={t('finance.custom.to')} value={period.to} min={period.from || undefined} onChange={(v) => setPeriod({ to: v })} />
          </Toolbar>
        )}
        <Stats>
          <Stat label={t('finance.stat.spent')} value={<Money n={total.spent} />} sub={t('finance.stat.spentSub')} />
          <Stat label={rangeLabel} value={<Money n={total.spent + total.planned} />} sub={yearBudget ? rich('finance.stat.ofBudget', { amount: <Money n={yearBudget} /> }) : rich('finance.stat.planned', { planned: <Money n={total.planned} /> }, { count: gifts.length })}>
            <Progress value={total.spent} planned={total.planned} max={yearBudget} />
          </Stat>
        </Stats>
      </Section>

      <Section title={t('finance.byPeriod.title')}>
        <Chart buckets={buckets} />
        {phone ? (
          <DataTable
            columns={[t('finance.col.period'), t('finance.col.sum')]}
            rows={[...buckets].reverse().filter((b) => b.count > 0).map((b) => ({
              key: b.key,
              cells: [<div className="max-w-[9rem]"><div className="font-medium">{b.label}</div><div className="meta">{t('finance.col.spent')} <Money n={b.spent} /> · {t('finance.col.planned')} <Money n={b.planned} /> · {b.count}</div></div>, <Money n={b.spent + b.planned} strong />],
            }))}
            empty={t('finance.byPeriod.empty')}
            foot={[<div className="max-w-[9rem]"><div>{t('finance.total')}</div><div className="meta font-normal">{t('finance.col.spent')} <Money n={total.spent} /> · {t('finance.col.planned')} <Money n={total.planned} /> · {gifts.length}</div></div>, <Money n={total.spent + total.planned} />]}
          />
        ) : (
          <DataTable
            columns={[t('finance.col.period'), t('finance.col.spent'), t('finance.col.planned'), t('finance.col.sum'), t('finance.col.count')]}
            rows={[...buckets].reverse().filter((b) => b.count > 0).map((b) => ({
              key: b.key,
              cells: [b.label, <Money n={b.spent} />, <Money n={b.planned} tone="muted" />, <Money n={b.spent + b.planned} strong />, b.count],
            }))}
            empty={t('finance.byPeriod.empty')}
            foot={[t('finance.total'), <Money n={total.spent} />, <Money n={total.planned} />, <Money n={total.spent + total.planned} />, gifts.length]}
          />
        )}
      </Section>

      <Section title={t('finance.settle.title')}>
        <List empty={<Card><p className="text-sm text-muted text-center">{t('finance.settle.empty')}</p></Card>}>
          {netted.map((d) => (
            <Row
              key={`${d.from}-${d.to}`}
              lead={<Avatar p={person(d.from)} size={44} />}
              title={person(d.from)?.is_me ? t('finance.debt.youOwe', { name: name(d.to) }) : person(d.to)?.is_me ? t('finance.debt.owesYou', { name: name(d.from) }) : t('finance.debt.owes', { from: name(d.from), to: name(d.to) })}
              meta={d.gifts.map((g) => g.title).join(' · ')}
              trailing={<Money n={d.amount} strong />}
              actions={<Button size="sm" icon={Check} onClick={() => settle(d)}>{t('finance.settle.button')}</Button>}
            />
          ))}
        </List>
      </Section>

      <Section title={t('finance.payers.title')}>
        <List empty={<Card><p className="text-sm text-muted text-center">{t('finance.payers.empty')}</p></Card>}>
          {payers.map((x) => {
            const open = openPerson === x.p.id
            const bal = x.p.is_me
              ? x.balance > 0.005 ? t('finance.payers.youGet', { amount: money(x.balance) }) : x.balance < -0.005 ? t('finance.payers.youOwe', { amount: money(-x.balance) }) : ''
              : x.balance > 0.005 ? t('finance.payers.gets', { amount: money(x.balance) }) : x.balance < -0.005 ? t('finance.payers.owes', { amount: money(-x.balance) }) : ''
            return (
              <Row
                key={x.p.id}
                lead={<Avatar p={x.p} size={44} />}
                title={x.p.is_me ? t('common.you') : x.p.name}
                titleSuffix={<ChevronDown size={16} className={`text-muted transition-transform ${open ? 'rotate-180' : ''}`} />}
                onClick={() => setOpenPerson(open ? null : x.p.id)}
                expanded={open}
                meta={[
                  t('finance.payers.gifts', { count: x.gifts.length }),
                  x.laidOut > 0 && t('finance.payers.laidOut', { amount: money(x.laidOut) }),
                  bal ? t('finance.payers.balance', { balance: bal }) : t('finance.payers.balanced'),
                ].filter(Boolean).join(' · ')}
                trailing={<Money n={x.share} strong />}
                below={open && (
                  <div className="space-y-3 pb-1">
                    {x.gifts.map((g) => (
                      <div key={g.id} className="space-y-1.5">
                        <div className="flex justify-between gap-2 text-sm font-medium"><span className="truncate">{g.title}</span><Money n={g.price ?? 0} tone="muted" /></div>
                        <CostSplit g={g} />
                      </div>
                    ))}
                  </div>
                )}
              />
            )
          })}
        </List>
      </Section>

      <TwoCol>
        <Section title={t('finance.byOccasion.title')}><Bars rows={byOccasion} empty={t('finance.bars.empty')} /></Section>
        <Section title={t('finance.byPerson.title')}><Bars rows={byPerson} empty={t('finance.bars.empty')} /></Section>
      </TwoCol>
      <p className="meta -mt-4">{t('finance.legend')}</p>
    </Page>
  )
}
