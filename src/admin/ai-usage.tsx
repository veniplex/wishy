import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Download } from 'lucide-react'
import { api, download, errMsg } from '../api'
import { ChartCard, Legend, StackedBars, compactNumber, makeBuckets, type ChartSeries } from '../charts'
import { fmtNumber, intlLocale, t, useT } from '../i18n'
import { Banner, Button, Card, DatePicker, FormError, Progress, Section, Segmented, Select, Stat, ToggleLink, useDesktopChrome, useToast } from '../ui'

interface Sum {
  requests: number
  errors: number
  ok_requests: number
  input_tokens: number
  output_tokens: number
  cost: number // in the tracking currency
  unpriced_requests: number
  error_rate: number
  avg_latency_ms: number | null
}
interface Cur { code: string }
type Summary = Sum & { currency: Cur }
interface TsRow extends Sum { bucket: string; key: string | number | null; label: string | null }
interface Timeseries { bucket: 'day' | 'week' | 'month'; group: Group; currency: Cur; buckets: string[]; keys: { key: string | number | null; label: string | null }[]; rows: TsRow[] }
interface UserRow extends Sum { user_id: number | null; name: string | null; email: string | null; month_requests: number; month_cost: number }
interface UsersRes { currency: Cur; limits: { monthly_user_limit: number | null; monthly_cost_cap: number | null }; users: UserRow[] }

type Group = 'none' | 'feature' | 'model' | 'user'
type Bucket = 'day' | 'week' | 'month'
type Preset = '7' | '30' | '90' | 'month' | '12m' | 'custom'

const iso = (d: Date) => d.toISOString().slice(0, 10)
const todayIso = () => iso(new Date())
function periodOf(p: Preset): { from: string; to: string } {
  const now = new Date()
  const to = iso(now)
  const back = (days: number) => iso(new Date(now.getTime() - (days - 1) * 86_400_000))
  if (p === '7') return { from: back(7), to }
  if (p === '30') return { from: back(30), to }
  if (p === '90') return { from: back(90), to }
  if (p === 'month') return { from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to }
  return { from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))), to }
}
const defaultBucket = (p: Preset): Bucket => (p === '12m' ? 'month' : p === '90' ? 'week' : 'day')

/** Cost: more decimal places for tiny amounts so it does not show "0.00" */
export function fmtCost(n: number | null | undefined, code: string): string {
  if (n == null) return '–'
  const digits = n === 0 ? 2 : n < 0.01 ? 4 : n < 1 ? 3 : 2
  try {
    return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: digits }).format(n)
  } catch {
    return `${fmtNumber(n, { maximumFractionDigits: digits })} ${code}`
  }
}
const pct = (r: number) => fmtNumber(r * 100, { maximumFractionDigits: r > 0 && r < 0.1 ? 1 : 0 }) + ' %'
const MAX_SERIES = 7

export function featureLabel(key: string): string {
  const k = `aiUsage.feature.${key}`
  const v = t(k as never)
  return v === k ? key : v
}

type SortKey = 'name' | 'requests' | 'tokens' | 'cost' | 'share'

/** Admin › AI › Usage: period, key figures, time series (requests, tokens, cost), per-user table, CSV export */
export function AiUsageAnalytics() {
  useT()
  const toast = useToast()
  const [preset, setPreset] = useState<Preset>('30')
  const [range, setRange] = useState(() => periodOf('30'))
  const [bucket, setBucket] = useState<Bucket>('day')
  const [group, setGroup] = useState<Group>('feature')
  const [sum, setSum] = useState<Summary | null>(null)
  const [ts, setTs] = useState<Timeseries | null>(null)
  const [users, setUsers] = useState<UsersRes | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'cost', dir: -1 })
  const seq = useRef(0)
  const desktop = useDesktopChrome()
  const [moreCharts, setMoreCharts] = useState(false)

  const choose = (p: Preset) => {
    setPreset(p)
    if (p !== 'custom') {
      setRange(periodOf(p))
      setBucket(defaultBucket(p))
    }
  }
  const valid = !!range.from && !!range.to && range.from <= range.to

  const load = useCallback(async () => {
    if (!valid) return
    const id = ++seq.current
    setBusy(true)
    setError('')
    const q = `from=${range.from}&to=${range.to}`
    try {
      const [s, tsr, u] = await Promise.all([
        api<Summary>('GET', `/api/admin/ai/usage/summary?${q}`),
        api<Timeseries>('GET', `/api/admin/ai/usage/timeseries?${q}&bucket=${bucket}&group=${group}`),
        api<UsersRes>('GET', `/api/admin/ai/usage/users?${q}`),
      ])
      if (id !== seq.current) return
      setSum(s)
      setTs(tsr)
      setUsers(u)
    } catch (e) {
      if (id === seq.current) setError(errMsg(e))
    } finally {
      if (id === seq.current) setBusy(false)
    }
  }, [range.from, range.to, bucket, group, valid])
  useEffect(() => { void load() }, [load])

  const cur = sum?.currency.code ?? 'USD'

  // Series: sorted by requests, at most 7 + "Other" (color follows the order, never cyclic)
  const { series, buckets, index } = useMemo(() => {
    if (!ts) return { series: [] as ChartSeries[], buckets: [], index: new Map<string, TsRow>() }
    const label = (k: { key: string | number | null; label: string | null }) =>
      ts.group === 'none' ? t('aiUsage.chart.total')
      : ts.group === 'feature' ? featureLabel(String(k.key))
      : ts.group === 'user' ? (k.label ?? t('aiUsage.unknownUser'))
      : (k.label ?? t('aiUsage.noModel'))
    const tot = new Map<string, number>()
    for (const r of ts.rows) tot.set(String(r.key), (tot.get(String(r.key)) ?? 0) + r.requests)
    const sorted = [...ts.keys].sort((a, b) => (tot.get(String(b.key)) ?? 0) - (tot.get(String(a.key)) ?? 0))
    const keep = sorted.length > MAX_SERIES + 1 ? sorted.slice(0, MAX_SERIES) : sorted
    const keepSet = new Set(keep.map((k) => String(k.key)))
    const ser: ChartSeries[] = keep.map((k) => ({ key: String(k.key), label: label(k) }))
    if (keep.length < sorted.length) ser.push({ key: '__other', label: t('aiUsage.chart.other'), other: true })
    const idx = new Map<string, TsRow>()
    for (const r of ts.rows) {
      const k = keepSet.has(String(r.key)) ? String(r.key) : '__other'
      const id = `${r.bucket}|${k}`
      const prev = idx.get(id)
      idx.set(id, prev ? { ...prev, requests: prev.requests + r.requests, input_tokens: prev.input_tokens + r.input_tokens, output_tokens: prev.output_tokens + r.output_tokens, cost: prev.cost + r.cost } : r)
    }
    return { series: ser, buckets: makeBuckets(ts.buckets, ts.bucket), index: idx }
  }, [ts])

  const val = (m: 'requests' | 'tokens' | 'cost') => (b: string, k: string) => {
    const r = index.get(`${b}|${k}`)
    if (!r) return 0
    return m === 'requests' ? r.requests : m === 'tokens' ? r.input_tokens + r.output_tokens : r.cost
  }
  const tableOf = (m: 'requests' | 'tokens' | 'cost', fmt: (n: number) => string) => ({
    columns: [t('aiUsage.chart.period'), ...series.map((s) => s.label)],
    rows: buckets.map((b) => ({ key: b.id, cells: [b.long, ...series.map((s) => fmt(val(m)(b.id, s.key)))] })),
  })
  const fReq = (n: number) => fmtNumber(n)
  const fCost = (n: number) => fmtCost(n, cur)

  const sortedUsers = useMemo(() => {
    if (!users) return []
    const totalCost = users.users.reduce((a, u) => a + u.cost, 0)
    const totalReq = users.users.reduce((a, u) => a + u.requests, 0)
    const rows = users.users.map((u) => ({ u, name: u.name ?? u.email ?? t('aiUsage.unknownUser'), tokens: u.input_tokens + u.output_tokens, share: totalCost > 0 ? u.cost / totalCost : totalReq > 0 ? u.requests / totalReq : 0 }))
    const get = (r: (typeof rows)[number]) => (sort.key === 'name' ? r.name.toLowerCase() : sort.key === 'requests' ? r.u.requests : sort.key === 'tokens' ? r.tokens : sort.key === 'cost' ? r.u.cost : r.share)
    return rows.sort((a, b) => {
      const x = get(a)
      const y = get(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [users, sort])

  const th = (key: SortKey, label: string, left = false) => {
    const on = sort.key === key
    return (
      <th scope="col" aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={`font-medium px-4 py-2.5 ${left ? 'text-left' : 'text-right'}`}>
        <button type="button" className={`inline-flex items-center gap-1 hover:text-ink ${on ? 'text-ink' : ''}`} onClick={() => setSort(on ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 })}>
          {label}{on && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
        </button>
      </th>
    )
  }

  const doExport = async () => {
    try {
      await download(`/api/admin/ai/usage/export.csv?from=${range.from}&to=${range.to}`, `wishy-ai-usage-${range.from}_${range.to}.csv`)
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }

  const tokenSeriesNote = t('aiUsage.chart.tokensNote')
  return (
    <Section title={t('aiUsage.title')}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Select aria-label={t('aiUsage.period')} value={preset} onChange={(e) => choose(e.target.value as Preset)} options={[
            { value: '7', label: t('aiUsage.period.7') }, { value: '30', label: t('aiUsage.period.30') }, { value: '90', label: t('aiUsage.period.90') },
            { value: 'month', label: t('aiUsage.period.month') }, { value: '12m', label: t('aiUsage.period.12m') }, { value: 'custom', label: t('aiUsage.period.custom') },
          ]} />
        </div>
        {preset === 'custom' && (
          <>
            <DatePicker inline aria-label={t('aiUsage.from')} value={range.from} max={range.to || todayIso()} required onChange={(v) => setRange({ ...range, from: v })} />
            <DatePicker inline aria-label={t('aiUsage.to')} value={range.to} min={range.from} max={todayIso()} required onChange={(v) => setRange({ ...range, to: v })} />
          </>
        )}
        <Segmented label={t('aiUsage.group')} value={group} onChange={setGroup} options={[
          { value: 'none', label: t('aiUsage.group.none') }, { value: 'feature', label: t('aiUsage.group.feature') },
          { value: 'model', label: t('aiUsage.group.model') }, { value: 'user', label: t('aiUsage.group.user') },
        ]} />
        <Segmented label={t('aiUsage.bucket')} value={bucket} onChange={setBucket} options={[
          { value: 'day', label: t('aiUsage.bucket.day') }, { value: 'week', label: t('aiUsage.bucket.week') }, { value: 'month', label: t('aiUsage.bucket.month') },
        ]} />
        <span className="flex-1" />
        <Button icon={Download} onClick={doExport} disabled={!valid}>{t('aiUsage.export')}</Button>
      </div>
      {!valid && <FormError>{t('aiUsage.invalidRange')}</FormError>}
      <FormError>{error}</FormError>

      <div className={`space-y-6 ${busy ? 'opacity-70 transition-opacity' : 'transition-opacity'}`} aria-busy={busy}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Stat label={t('aiUsage.stat.requests')} value={sum ? fmtNumber(sum.requests) : '–'} sub={sum ? t('aiUsage.stat.requestsOk', { count: sum.ok_requests }) : undefined} />
          <Stat label={t('aiUsage.stat.tokens')} value={sum ? fmtNumber(sum.input_tokens + sum.output_tokens) : '–'} sub={sum ? t('aiUsage.stat.tokensSplit', { input: compactNumber(sum.input_tokens), output: compactNumber(sum.output_tokens) }) : undefined} />
          <Stat label={t('aiUsage.stat.cost')} value={sum ? fmtCost(sum.cost, cur) : '–'} sub={sum && sum.unpriced_requests > 0 ? t('aiUsage.stat.unpriced', { count: sum.unpriced_requests }) : undefined} />
          <Stat label={t('aiUsage.stat.errorRate')} value={sum ? pct(sum.error_rate) : '–'} sub={sum ? t('aiUsage.stat.errors', { count: sum.errors }) : undefined} />
          <Stat label={t('aiUsage.stat.latency')} value={sum?.avg_latency_ms != null ? `${fmtNumber(sum.avg_latency_ms)} ms` : '–'} />
        </div>
        {sum && sum.unpriced_requests > 0 && <Banner tone="warn">{t('aiUsage.unpricedBanner', { count: sum.unpriced_requests })}</Banner>}

        <ChartCard title={t('aiUsage.chart.requests')} legend={<Legend series={series} />} table={tableOf('requests', fReq)}>
          <StackedBars title={t('aiUsage.chart.requests')} desc={t('aiUsage.chart.desc', { from: range.from, to: range.to })} buckets={buckets} series={series} value={val('requests')} fmt={fReq} axisFmt={compactNumber} busy={busy} />
        </ChartCard>
        {!desktop && <ToggleLink chevron on={moreCharts} onToggle={() => setMoreCharts(!moreCharts)} labelOn={t('aiUsage.chart.lessCharts')} labelOff={t('aiUsage.chart.moreCharts')} className="self-start" />}
        {(desktop || moreCharts) && <ChartCard title={t('aiUsage.chart.tokens')} sub={tokenSeriesNote} legend={<Legend series={series} />} table={tableOf('tokens', fReq)}>
          <StackedBars title={t('aiUsage.chart.tokens')} desc={t('aiUsage.chart.desc', { from: range.from, to: range.to })} buckets={buckets} series={series} value={val('tokens')} fmt={fReq} axisFmt={compactNumber} busy={busy} />
        </ChartCard>}
        <ChartCard title={t('aiUsage.chart.cost', { currency: cur })} legend={<Legend series={series} />} table={tableOf('cost', fCost)}>
          <StackedBars title={t('aiUsage.chart.cost', { currency: cur })} desc={t('aiUsage.chart.desc', { from: range.from, to: range.to })} buckets={buckets} series={series} value={val('cost')} fmt={fCost} axisFmt={(n) => fmtNumber(n, { maximumFractionDigits: n < 1 ? 3 : 2 })} busy={busy} />
        </ChartCard>

        <div className="space-y-2">
          <h3 className="h3">{t('aiUsage.users.title')}</h3>
          <div className="space-y-2 sm:hidden">
            {sortedUsers.map(({ u, name, tokens, share }) => {
              const lim = users?.limits.monthly_user_limit ?? null
              const cap = users?.limits.monthly_cost_cap ?? null
              return (
                <Card key={String(u.user_id)} pad="sm" className="space-y-2">
                  <div className="min-w-0"><div className="font-medium break-words">{name}</div>{u.email && u.name && <div className="meta break-all">{u.email}</div>}</div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm num">
                    <div><dt className="meta">{t('aiUsage.users.requests')}</dt><dd>{fmtNumber(u.requests)}</dd></div>
                    <div><dt className="meta">{t('aiUsage.users.cost')}</dt><dd>{fmtCost(u.cost, cur)}{u.unpriced_requests > 0 ? '*' : ''}</dd></div>
                    <div><dt className="meta">{t('aiUsage.users.tokens')}</dt><dd>{compactNumber(tokens)}</dd></div>
                    <div><dt className="meta">{t('aiUsage.users.share')}</dt><dd>{pct(share)}</dd></div>
                  </dl>
                  {lim != null && <div><div className="meta">{t('aiUsage.users.monthRequests', { used: u.month_requests, limit: lim })}</div><Progress value={u.month_requests} max={lim} /></div>}
                  {cap != null && <div><div className="meta">{t('aiUsage.users.monthCost', { used: fmtCost(u.month_cost, cur), limit: fmtCost(cap, cur) })}</div><Progress value={u.month_cost} max={cap} /></div>}
                </Card>
              )
            })}
            {!sortedUsers.length && <p className="meta text-center">{t('aiUsage.users.empty')}</p>}
          </div>
          <div className="card overflow-x-auto max-sm:hidden">
            <table className="w-full text-sm num">
              <thead>
                <tr className="meta border-b border-line">
                  {th('name', t('aiUsage.users.user'), true)}
                  {th('requests', t('aiUsage.users.requests'))}
                  {th('tokens', t('aiUsage.users.tokens'))}
                  {th('cost', t('aiUsage.users.cost'))}
                  {th('share', t('aiUsage.users.share'))}
                  <th scope="col" className="font-medium px-4 py-2.5 text-right">{t('aiUsage.users.limit')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sortedUsers.map(({ u, name, tokens, share }) => {
                  const lim = users?.limits.monthly_user_limit ?? null
                  const cap = users?.limits.monthly_cost_cap ?? null
                  return (
                    <tr key={String(u.user_id)}>
                      <td className="px-4 py-2.5 text-left"><div className="font-medium truncate max-w-56">{name}</div>{u.email && u.name && <div className="meta truncate max-w-56">{u.email}</div>}</td>
                      <td className="px-4 py-2.5 text-right">{fmtNumber(u.requests)}</td>
                      <td className="px-4 py-2.5 text-right">{compactNumber(tokens)}</td>
                      <td className="px-4 py-2.5 text-right">{u.unpriced_requests > 0 ? <span title={t('aiUsage.users.unpricedHint', { count: u.unpriced_requests })}>{fmtCost(u.cost, cur)}*</span> : fmtCost(u.cost, cur)}</td>
                      <td className="px-4 py-2.5 text-right">{pct(share)}</td>
                      <td className="px-4 py-2.5 text-right min-w-36">
                        {lim == null && cap == null ? <span className="text-muted">–</span> : (
                          <div className="space-y-1.5 ml-auto max-w-36">
                            {lim != null && <div><div className="meta">{t('aiUsage.users.monthRequests', { used: u.month_requests, limit: lim })}</div><Progress value={u.month_requests} max={lim} /></div>}
                            {cap != null && <div><div className="meta">{t('aiUsage.users.monthCost', { used: fmtCost(u.month_cost, cur), limit: fmtCost(cap, cur) })}</div><Progress value={u.month_cost} max={cap} /></div>}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {!sortedUsers.length && <tr><td colSpan={6} className="px-4 py-4 text-center text-muted">{t('aiUsage.users.empty')}</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="meta">{t('aiUsage.users.note')}</p>
        </div>
      </div>
    </Section>
  )
}
