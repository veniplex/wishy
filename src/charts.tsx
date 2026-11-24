import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { fmtIntl, fmtNumber, t } from './i18n'
import { DataTable } from './ui'

/**
 * Charts without a library: stacked columns as SVG (sized via ResizeObserver, text stays sharp), legend, tooltip on
 * hover/focus/tap, table view as an alternative. Colors: validated categorical palette (fixed order, never cyclic),
 * with separate steps for light and dark; labels use the app text tokens, never the series color.
 */

const CSS = `
.viz {
  --viz-1:#2a78d6; --viz-2:#eb6834; --viz-3:#1baf7a; --viz-4:#eda100; --viz-5:#e87ba4; --viz-6:#008300; --viz-7:#6250d6; --viz-other:#8c7c70;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .viz {
    --viz-1:#3987e5; --viz-2:#d95926; --viz-3:#199e70; --viz-4:#c98500; --viz-5:#d55181; --viz-6:#0ca30c; --viz-7:#9085e9; --viz-other:#9a8c82;
  }
}
:root[data-theme='dark'] .viz {
  --viz-1:#3987e5; --viz-2:#d95926; --viz-3:#199e70; --viz-4:#c98500; --viz-5:#d55181; --viz-6:#0ca30c; --viz-7:#9085e9; --viz-other:#9a8c82;
}
.viz-col:focus-visible { outline: none; }
.viz-col:focus-visible .viz-hit { stroke: var(--ink); stroke-width: 2; }
.viz-bar { transition: opacity .12s; }
.viz-busy { opacity: .55; transition: opacity .15s; }
`
if (typeof document !== 'undefined' && !document.getElementById('viz-css')) {
  const el = document.createElement('style')
  el.id = 'viz-css'
  el.textContent = CSS
  document.head.appendChild(el)
}

export const seriesColor = (i: number, other = false) => `var(${other ? '--viz-other' : `--viz-${(i % 7) + 1}`})`

export interface Bucket { id: string; label: string; long: string }
export interface ChartSeries { key: string; label: string; other?: boolean }

/** Bucket IDs (YYYY-MM-DD) → axis and tooltip label */
export function makeBuckets(ids: string[], bucket: 'day' | 'week' | 'month'): Bucket[] {
  return ids.map((id) => {
    const d = new Date(`${id}T12:00:00`)
    if (bucket === 'month') return { id, label: fmtIntl(d, { month: 'short', year: '2-digit' }), long: fmtIntl(d, { month: 'long', year: 'numeric' }) }
    const short = fmtIntl(d, { day: 'numeric', month: 'short' })
    const long = fmtIntl(d, { day: 'numeric', month: 'long', year: 'numeric' })
    return { id, label: short, long: bucket === 'week' ? t('aiUsage.chart.weekOf', { date: long }) : long }
  })
}

function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let i = 0; i < 12; i++) {
    const v = +(i * step).toPrecision(10)
    out.push(v)
    if (v >= max) break
  }
  return out.length > 1 ? out : [0, step]
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(220, Math.floor(el.clientWidth))))
    ro.observe(el)
    setW(Math.max(220, Math.floor(el.clientWidth)))
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

const topRounded = (x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

export function Legend({ series }: { series: ChartSeries[] }) {
  if (series.length < 2) return null
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted" aria-label={t('aiUsage.chart.legend')}>
      {series.map((s, i) => (
        <li key={s.key} className="inline-flex items-center gap-1.5 min-w-0">
          <span aria-hidden className="inline-block size-2.5 rounded-[3px] shrink-0" style={{ background: seriesColor(i, s.other) }} />
          <span className="truncate max-w-48">{s.label}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Stacked columns. `value(bucketId, seriesKey)` returns the value; `fmt` formats axis/tooltip.
 * With a single series a plain column is drawn (no legend box).
 */
export function StackedBars({ title, desc, buckets, series, value, fmt, axisFmt, busy, height = 220, valueLabel }: {
  title: string
  desc: string
  buckets: Bucket[]
  series: ChartSeries[]
  value: (bucketId: string, seriesKey: string) => number
  fmt: (n: number) => string
  axisFmt?: (n: number) => string
  busy?: boolean
  height?: number
  /** Tooltip header for the total */
  valueLabel?: string
}) {
  const [wrap, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const afmt = axisFmt ?? fmt
  const data = useMemo(() => buckets.map((b) => {
    const parts = series.map((s) => value(b.id, s.key))
    return { b, parts, total: parts.reduce((a, c) => a + c, 0) }
  }), [buckets, series, value])
  const maxV = Math.max(0, ...data.map((d) => d.total))
  const ticks = niceTicks(maxV)
  const top = ticks[ticks.length - 1] || 1
  // Equal labels (e.g. 0.002 0.002 0.001): fall back to as many decimals as the tick step needs
  const tickLabels = ticks.map(afmt)
  const labels = new Set(tickLabels).size === tickLabels.length ? tickLabels : (() => {
    const step = ticks[1] - ticks[0]
    let d = 0
    while (d < 8 && Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-9) d++
    return ticks.map((v) => fmtNumber(v, { minimumFractionDigits: d, maximumFractionDigits: d }))
  })()
  const left = Math.max(...labels.map((l) => l.length)) * 7.2 + 14
  const m = { t: 8, r: 8, b: 26, l: left }
  const iw = width - m.l - m.r
  const ih = height - m.t - m.b
  const n = Math.max(1, data.length)
  const band = iw / n
  const bw = Math.max(2, Math.min(band - Math.min(2, band * 0.3), 34))
  const y = (v: number) => m.t + ih - (v / top) * ih
  const step = Math.max(1, Math.ceil(64 / band))
  const empty = maxV === 0
  const hd = hover != null ? data[hover] : null
  const tipX = hover != null ? m.l + band * (hover + 0.5) : 0
  const flip = tipX > width * 0.55

  return (
    <div className="viz relative" ref={wrap}>
      <svg width={width} height={height} role="group" aria-label={title} className={`block select-none ${busy ? 'viz-busy' : ''}`} onPointerLeave={() => setHover(null)}>
        <title>{title}</title>
        <desc>{desc}</desc>
        {ticks.map((v, ti) => (
          <g key={v}>
            <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} opacity={v === 0 ? 1 : 0.6} />
            <text x={m.l - 8} y={y(v)} textAnchor="end" dominantBaseline="central" fontSize={12} fill="var(--muted)" className="num">{labels[ti]}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = m.l + band * (i + 0.5)
          let acc = 0
          const segs = d.parts.map((p, si) => {
            const y0 = y(acc)
            acc += p
            const y1 = y(acc)
            return { si, p, y1, h: y0 - y1 }
          }).filter((s) => s.p > 0)
          const lastIdx = segs.length - 1
          return (
            <g key={d.b.id} className="viz-col" tabIndex={0} role="img" aria-label={`${d.b.long}: ${fmt(d.total)}`} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
              {i % step === 0 && <text x={cx} y={height - 8} textAnchor="middle" fontSize={12} fill="var(--muted)">{d.b.label}</text>}
              {segs.map((s, k) => {
                const gap = k > 0 && s.h > 3 ? 2 : 0
                const hh = Math.max(1, s.h - gap)
                const fill = seriesColor(s.si, series[s.si]?.other)
                const opacity = hover != null && hover !== i ? 0.45 : 1
                return k === lastIdx
                  ? <path key={s.si} className="viz-bar" d={topRounded(cx - bw / 2, s.y1, bw, hh, 4)} fill={fill} opacity={opacity} />
                  : <rect key={s.si} className="viz-bar" x={cx - bw / 2} y={s.y1} width={bw} height={hh} fill={fill} opacity={opacity} />
              })}
              <rect className="viz-hit" x={m.l + band * i} y={m.t} width={band} height={ih} fill="transparent" stroke="none" onPointerEnter={() => setHover(i)} onPointerMove={() => setHover(i)} onPointerDown={() => setHover(i)} />
            </g>
          )
        })}
        {empty && <text x={m.l + iw / 2} y={m.t + ih / 2} textAnchor="middle" fontSize={13} fill="var(--muted)">{t('aiUsage.chart.empty')}</text>}
      </svg>
      {hd && !empty && (
        <div role="status" className="pointer-events-none absolute z-10 min-w-40 max-w-64 rounded-xl border border-line bg-card px-3 py-2 text-xs shadow-[var(--sh-pop)]" style={{ top: 4, [flip ? 'right' : 'left']: flip ? width - tipX + 10 : tipX + 10 } as CSSProperties}>
          <div className="font-semibold text-ink mb-1">{hd.b.long}</div>
          {series.length > 1 && series.map((s, si) => hd.parts[si] > 0 && (
            <div key={s.key} className="flex items-center gap-2 py-0.5">
              <span aria-hidden className="inline-block h-0.5 w-3 rounded shrink-0" style={{ background: seriesColor(si, s.other) }} />
              <span className="flex-1 min-w-0 truncate text-muted">{s.label}</span>
              <span className="num font-semibold text-ink">{fmt(hd.parts[si])}</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 pt-0.5 border-t border-line mt-1">
            <span className="text-muted">{valueLabel ?? t('aiUsage.chart.total')}</span>
            <span className="num font-semibold text-ink">{fmt(hd.total)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export { ScrollFade } from './ui'

/** Chart card: title, legend, chart, collapsible table */
export function ChartCard({ title, sub, legend, children, table }: { title: string; sub?: string; legend?: ReactNode; children: ReactNode; table?: { columns: string[]; rows: { key: string; cells: ReactNode[] }[] } }) {
  return (
    <section className="viz card p-4 sm:p-5 space-y-3" aria-label={title}>
      <div>
        <h3 className="h3">{title}</h3>
        {sub && <p className="meta mt-0.5">{sub}</p>}
      </div>
      {legend}
      {children}
      {table && (
        <details className="group">
          <summary className="meta cursor-pointer select-none hover:text-ink w-fit">{t('aiUsage.chart.showTable')}</summary>
          <div className="mt-2 max-h-72 overflow-y-auto"><DataTable columns={table.columns} rows={table.rows} /></div>
        </details>
      )}
    </section>
  )
}

export const compactNumber = (n: number) => fmtNumber(n, { notation: 'compact', maximumFractionDigits: 1 })
