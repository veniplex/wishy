import { Fragment, useState, type ReactNode } from 'react'
import { Check, CircleAlert, CircleCheck, Circle, Copy, LoaderCircle } from 'lucide-react'
import { t, useT, type TKey } from './i18n'

export interface JobStep { id: string; status: 'pending' | 'running' | 'done' | 'failed' }

const stepLabel = (id: string) => {
  const key = `update.step.${id}` as TKey
  const text = t(key)
  return text !== key ? text : id
}

/** Step list of an update/restore (launcher job) with state icon and text status for screen readers */
export function StepList({ steps }: { steps: JobStep[] }) {
  useT()
  return (
    <ol className="space-y-2.5">
      {steps.map((s) => (
        <li key={s.id} className="flex items-center gap-3 text-sm" aria-current={s.status === 'running' ? 'step' : undefined}>
          {s.status === 'done' && <CircleCheck size={18} className="text-ok shrink-0" aria-hidden />}
          {s.status === 'running' && <LoaderCircle size={18} className="text-accent shrink-0 motion-safe:animate-spin" aria-hidden />}
          {s.status === 'failed' && <CircleAlert size={18} className="text-bad shrink-0" aria-hidden />}
          {s.status === 'pending' && <Circle size={18} className="text-ctl shrink-0" aria-hidden />}
          <span className={s.status === 'pending' ? 'text-muted' : s.status === 'running' ? 'font-semibold' : ''}>{stepLabel(s.id)}</span>
          <span className="sr-only">{t(`update.step.status.${s.status}` as TKey)}</span>
        </li>
      ))}
    </ol>
  )
}

/** Progress bar: without a value (`null`) as a calmly pulsing bar */
export function ProgressBar({ value, label }: { value: number | null | undefined; label?: string }) {
  const known = typeof value === 'number'
  const pct = known ? Math.max(3, Math.min(100, Math.round(value * 100))) : 100
  return (
    <div className="h-2.5 rounded-full bg-track overflow-hidden" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(value * 100) : undefined}>
      <div className={`h-full rounded-full bg-accent transition-[width] duration-500 ${known ? '' : 'opacity-60 motion-safe:animate-pulse'}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Command/code on one line with a copy button */
export function CodeBlock({ children, copy }: { children: string; copy?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex items-start gap-2 rounded-xl bg-hover border border-line px-3 py-2">
      <code className="font-mono text-[13px] break-all flex-1 min-w-0 whitespace-pre-wrap">{children}</code>
      {copy !== false && (
        <button
          type="button"
          className="icon-btn icon-btn-sm shrink-0"
          aria-label={t('controls.ui.copy')}
          title={t('controls.ui.copy')}
          onClick={() => { void navigator.clipboard?.writeText(children).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }).catch(() => {}) }}
        >
          {done ? <Check size={15} /> : <Copy size={15} />}
        </button>
      )}
    </div>
  )
}

// ───────────── Markdown-light (text only, never HTML) ─────────────

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i} className="font-mono text-[0.9em] bg-hover rounded px-1">{part.slice(1, -1)}</code>
    const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part)
    if (m) return <a key={i} href={m[2]} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">{m[1]}</a>
    return <Fragment key={i}>{part}</Fragment>
  })
}

/**
 * Release notes as plain Markdown (headings, lists, paragraphs, **bold**, `code`, [link](https://…)).
 * Everything is rendered as React text (no dangerouslySetInnerHTML); HTML characters in the text stay text.
 */
export function MarkdownLite({ source }: { source: string }) {
  const blocks: ReactNode[] = []
  let list: string[] = []
  let para: string[] = []
  const flushList = () => {
    if (list.length) blocks.push(<ul key={`u${blocks.length}`} className="list-disc pl-5 space-y-1">{list.map((x, i) => <li key={i}>{inline(x)}</li>)}</ul>)
    list = []
  }
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(' '))}</p>)
    para = []
  }
  for (const raw of source.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    const li = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (h) { flushList(); flushPara(); blocks.push(<h4 key={`h${blocks.length}`} className="font-semibold text-ink pt-1">{inline(h[1])}</h4>) }
    else if (li) { flushPara(); list.push(li[1]) }
    else if (!line.trim()) { flushList(); flushPara() }
    else { flushList(); para.push(line.trim()) }
  }
  flushList()
  flushPara()
  return <div className="space-y-2.5 text-sm text-ink break-words">{blocks}</div>
}
