import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useOccasionTypes, useStore } from './store'
import { fmtDate, fmtIntl, intlLocale, t, useT } from './i18n'
import { dateInYear, isLeftOutBirthday, parseDate, type Occasion } from './lib'
import { Button, IconButton, List, Row, Thumb } from './ui'
import { Popover } from './controls'
import { OccasionRow, OccasionTypeIcon, occasionIconByName, useOccasionStats } from './components'

const MAX_CHIPS = 3

/** Occasion on the grid; `projected` = future/past repetition of a yearly occasion or birthday (no row of its own) */
type CalOcc = Occasion & { projected?: boolean }

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** First day of the week for the current locale (1 = Monday … 7 = Sunday); Monday when unknown */
function firstWeekday(): number {
  try {
    const loc = new Intl.Locale(intlLocale()) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
    return (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay ?? 1
  } catch { return 1 }
}

function useNarrow() {
  const q = '(max-width: 639px)'
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const h = () => setNarrow(m.matches)
    m.addEventListener('change', h)
    return () => m.removeEventListener('change', h)
  }, [])
  return narrow
}

/** Gift planning state of an occasion, same logic as the list row: warn = something missing, ok = all done */
function useStatus(o: Occasion): 'warn' | 'ok' | null {
  const { s } = useStore()
  const st = useOccasionStats(o)
  if (o.date < s.today) return null
  if (st.missing.length || st.open) return 'warn'
  return st.gifts.length ? 'ok' : null
}
const STATUS_DOT = { warn: 'bg-warn', ok: 'bg-ok' } as const

function Chip({ o }: { o: CalOcc }) {
  const { s, occasionTitle } = useStore()
  const types = useOccasionTypes()
  const realStatus = useStatus(o)
  const status = o.projected ? null : realStatus
  const title = occasionTitle(o, false)
  return (
    <Link
      to={`/calendar/${o.id}`}
      title={title}
      className={`relative z-10 flex items-center gap-1 min-w-0 rounded-md px-1.5 py-0.5 text-xs font-medium leading-tight text-ink hover:brightness-95 ${o.type === 'birthday' ? 'bg-info-soft' : 'bg-soft'} ${o.date < s.today || isLeftOutBirthday(o) ? 'opacity-60' : ''}`}
    >
      <OccasionTypeIcon icon={types.of(o.type).icon} size={12} className="shrink-0" />
      <span className="truncate">{title}</span>
      {status && <span className={`ml-auto size-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden />}
    </Link>
  )
}

function MoreButton({ date, items, hidden }: { date: string; items: CalOcc[]; hidden: number }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const types = useOccasionTypes()
  const { occasionTitle } = useStore()
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('calendar.view.moreAria', { count: hidden, date: fmtIntl(parseDate(date), { day: 'numeric', month: 'long' }) })}
        className="relative z-10 self-start rounded-md px-1.5 py-0.5 text-xs font-semibold text-muted hover:text-accent hover:bg-hover cursor-pointer"
      >
        {t('calendar.view.more', { count: hidden })}
      </button>
      {open && (
        <Popover anchor={ref} onClose={() => { setOpen(false); ref.current?.focus() }} width={260} sheet title={fmtIntl(parseDate(date), { weekday: 'long', day: 'numeric', month: 'long' })}>
          <ul className="p-1.5 flex flex-col gap-0.5 overflow-y-auto">
            {items.map((o) => (
              <li key={o.id}>
                <Link to={`/calendar/${o.id}`} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium hover:bg-hover">
                  <OccasionTypeIcon icon={types.of(o.type).icon} size={16} className="shrink-0 text-accent" />
                  <span className="truncate">{occasionTitle(o, false)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Popover>
      )}
    </>
  )
}

/** Row for a projected occurrence: no gift stats, links to the occasion it repeats */
function ProjectedRow({ o }: { o: CalOcc }) {
  const { occasionTitle } = useStore()
  const types = useOccasionTypes()
  return (
    <Row to={`/calendar/${o.id}`} lead={<Thumb tone="accent" icon={occasionIconByName(types.of(o.type).icon)} />} title={occasionTitle(o, false)} meta={fmtDate(o.date, false)} />
  )
}

/** Month grid with occasions; `onAdd(date)` opens the new-occasion dialog */
function MonthGrid({ month, byDate, today, onAdd }: { month: string; byDate: Map<string, CalOcc[]>; today: string; onAdd?: (date: string) => void }) {
  const narrow = useNarrow()
  const [selected, setSelected] = useState<string | null>(null)
  const first = parseDate(`${month}-01`)
  const wk = firstWeekday() % 7 // 0 = Sunday … 6 = Saturday
  const lead = (first.getDay() - wk + 7) % 7
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const weeks = Math.ceil((lead + days) / 7)
  const cells = Array.from({ length: weeks * 7 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - lead + i))
  // 2024-01-07 is a Sunday
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 7 + ((wk + i) % 7)))
  const monthNo = first.getMonth()
  // Selection only counts inside the displayed month; on mobile default to today / the 1st
  const sel = selected && selected.startsWith(month) ? selected : today.startsWith(month) ? today : `${month}-01`
  const selItems = byDate.get(sel) ?? []

  return (
    <div>
      <div className="card overflow-hidden">
        <div className="grid grid-cols-7 border-b border-line bg-hover">
          {weekdays.map((d, i) => (
            <div key={i} className="px-1 sm:px-2 py-2 text-center sm:text-left text-xs font-semibold uppercase tracking-wide text-muted">
              <span className="sm:hidden" aria-hidden>{fmtIntl(d, { weekday: 'narrow' })}</span>
              <span className="max-sm:sr-only">{fmtIntl(d, { weekday: 'short' })}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7" role="grid">
          {cells.map((d, i) => {
            const key = ymd(d)
            const inMonth = d.getMonth() === monthNo
            const isToday = key === today
            const items = byDate.get(key) ?? []
            const long = fmtIntl(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
            const border = `${i % 7 !== 6 ? 'border-r' : ''} ${i < cells.length - 7 ? 'border-b' : ''} border-line`
            const num = (
              <span className={`inline-grid place-items-center min-w-6 h-6 px-1 rounded-full text-sm font-semibold ${isToday ? 'bg-accent text-accent-ink' : inMonth ? 'text-ink' : 'text-muted'}`}>{d.getDate()}</span>
            )
            if (narrow) {
              const isSel = key === sel
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  aria-selected={isSel}
                  aria-label={items.length ? t('calendar.view.dayAria', { date: long, count: items.length }) : long}
                  onClick={() => setSelected(key)}
                  className={`${border} min-h-14 flex flex-col items-center gap-1 pt-1.5 pb-1 cursor-pointer ${inMonth ? '' : 'opacity-45'} ${isSel ? 'bg-soft' : 'hover:bg-hover'}`}
                >
                  {num}
                  <span className="flex flex-wrap justify-center gap-0.5 px-1 h-3" aria-hidden>
                    {items.slice(0, 3).map((o) => <span key={o.id} className={`size-1.5 rounded-full ${o.type === 'birthday' ? 'bg-info' : 'bg-accent'} ${isLeftOutBirthday(o) ? 'opacity-40' : ''}`} />)}
                  </span>
                </button>
              )
            }
            return (
              <div key={key} role="gridcell" className={`${border} relative min-h-28 p-1.5 flex flex-col gap-1 min-w-0 ${inMonth ? '' : 'bg-hover/60'} ${inMonth ? '' : 'opacity-60'}`}>
                {onAdd && <button
                  type="button"
                  onClick={() => onAdd(key)}
                  aria-label={t('calendar.view.addOn', { date: long })}
                  className="absolute inset-0 cursor-pointer hover:bg-hover/70 focus-visible:z-20"
                />}
                <div className="relative pointer-events-none flex">{num}</div>
                {items.slice(0, items.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS).map((o) => <Chip key={o.id} o={o} />)}
                {items.length > MAX_CHIPS && <MoreButton date={key} items={items} hidden={items.length - (MAX_CHIPS - 1)} />}
              </div>
            )
          })}
        </div>
      </div>

      {narrow && (
        <section className="mt-4" aria-live="polite" aria-label={t('calendar.view.dayListAria')}>
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="font-display font-semibold text-lg">{fmtIntl(parseDate(sel), { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
            {onAdd && <Button size="sm" icon={Plus} onClick={() => onAdd(sel)}>{t('calendar.view.add')}</Button>}
          </div>
          {selItems.length
            ? <List>{selItems.map((o) => o.projected ? <ProjectedRow key={`${o.id}-${o.date}`} o={o} /> : <OccasionRow key={o.id} o={o} />)}</List>
            : <p className="text-sm text-muted">{t('calendar.view.dayEmpty')}</p>}
        </section>
      )}
    </div>
  )
}

/** Month view of the calendar: the same occasions as the list, placed on their dates */
export function CalendarMonth() {
  useT()
  const { s, open } = useStore()
  const [params, setParams] = useSearchParams()
  const q = params.get('month')
  const month = q && MONTH_RE.test(q) ? q : s.today.slice(0, 7)
  const { person } = useStore()
  const byDate = useMemo(() => {
    const m = new Map<string, CalOcc[]>()
    const add = (o: CalOcc) => { const k = o.date.slice(0, 10); m.set(k, [...(m.get(k) ?? []), o]) }
    for (const o of s.occasions) add(o)
    // Project yearly occasions / birthdays into the years the grid shows (month ± 1 week covers two years at most)
    const y = Number(month.slice(0, 4))
    const years = [y - (month.endsWith('-01') ? 1 : 0), y, y + (month.endsWith('-12') ? 1 : 0)].filter((v, i, a) => a.indexOf(v) === i)
    const groups = new Map<string, Occasion[]>()
    for (const o of s.occasions) {
      const key = o.type === 'birthday' && o.person_id != null ? `b${o.person_id}` : o.recurring ? `s${o.series_id ?? o.id}` : null
      if (key) groups.set(key, [...(groups.get(key) ?? []), o])
    }
    for (const [key, rows] of groups) {
      const rep = rows.reduce((a, b) => (b.date > a.date ? b : a))
      let start = rows.reduce((a, b) => (b.date < a ? b.date : a), rep.date).slice(0, 10)
      if (key[0] === 'b') { const bd = person(rep.person_id!)?.birthday; if (bd && bd < start) start = bd.slice(0, 10) }
      const md = rep.date.slice(5, 10)
      const real = new Set(rows.map((r) => r.date.slice(0, 10)))
      const realYears = new Set(rows.map((r) => r.date.slice(0, 4)))
      for (const yr of years) {
        const d = dateInYear(yr, md)
        // A real row in that year (e.g. the current Christmas) always wins; no projection before the start
        if (real.has(d) || realYears.has(String(yr)) || d <= start) continue
        add({ ...rep, date: d, projected: true })
      }
    }
    return m
  }, [s.occasions, month, person])
  const go = (delta: number) => {
    const d = parseDate(`${month}-01`)
    const n = new Date(d.getFullYear(), d.getMonth() + delta, 1)
    setParams((p) => { const x = new URLSearchParams(p); x.set('month', `${n.getFullYear()}-${pad(n.getMonth() + 1)}`); return x }, { replace: true })
  }
  const goToday = () => setParams((p) => { const x = new URLSearchParams(p); x.delete('month'); return x }, { replace: true })
  const title = fmtIntl(parseDate(`${month}-01`), { month: 'long', year: 'numeric' })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="h2 text-[22px] mr-auto" aria-live="polite">{title}</h2>
        <Button size="sm" onClick={goToday} disabled={month === s.today.slice(0, 7)}>{t('calendar.view.today')}</Button>
        <IconButton icon={ChevronLeft} label={t('calendar.view.prev')} onClick={() => go(-1)} />
        <IconButton icon={ChevronRight} label={t('calendar.view.next')} onClick={() => go(1)} />
      </div>
      <MonthGrid month={month} byDate={byDate} today={s.today} onAdd={s.permissions.manage_occasions ? (date) => open({ type: 'occasion', initial: { date } }) : undefined} />
    </div>
  )
}
