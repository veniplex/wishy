import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { Popover } from './controls'
import { t, useLocale, type TKey } from './i18n'
import { SearchField } from './ui'

type Data = typeof import('./emoji-data')
/** The data set is a separate chunk: it is only fetched the first time a picker opens. */
let loaded: Promise<Data> | null = null
const loadData = () => (loaded ??= import('./emoji-data').catch((e) => { loaded = null; throw e }))

const CAT_KEYS = { smileys: 'controls.emoji.cat.smileys', people: 'controls.emoji.cat.people', animals: 'controls.emoji.cat.animals', food: 'controls.emoji.cat.food', activities: 'controls.emoji.cat.activities', travel: 'controls.emoji.cat.travel', objects: 'controls.emoji.cat.objects', symbols: 'controls.emoji.cat.symbols' } as const

function EmojiButton({ e, label, onPick, tab }: { e: string; label: string; onPick: (e: string) => void; tab?: boolean }) {
  return (
    <button type="button" data-emoji tabIndex={tab ? 0 : -1} title={label} aria-label={label} className="grid size-10 place-items-center rounded-xl text-[1.6rem] leading-none hover:bg-hover focus-visible:bg-hover" onClick={() => onPick(e)}>
      {e}
    </button>
  )
}

function Panel({ onPick, value }: { onPick: (e: string) => void; value: string }) {
  const lang = useLocale()
  const [data, setData] = useState<Data | null>(null)
  const [failed, setFailed] = useState(false)
  const [q, setQ] = useState('')
  const grid = useRef<HTMLDivElement>(null)
  useEffect(() => { let on = true; loadData().then((d) => on && setData(d), () => on && setFailed(true)); return () => { on = false } }, [])
  const results = useMemo(() => (data && q.trim() ? data.searchEmoji(q, lang) : null), [data, q, lang])
  const name = (it: { name: { en: string; de: string } }) => (lang === 'de' ? it.name.de : it.name.en)

  const buttons = () => Array.from(grid.current?.querySelectorAll<HTMLButtonElement>('[data-emoji]') ?? [])
  // Arrow keys move through the grid (only the first button is in the tab order: Tab goes search -> grid -> out)
  const onGridKey = (ev: KeyboardEvent) => {
    const all = buttons()
    const i = all.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    const cols = getComputedStyle(all[i].parentElement!).gridTemplateColumns.split(' ').length || 1
    const delta = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols } as Record<string, number>)[ev.key]
    if (delta === undefined) return
    ev.preventDefault()
    const next = all[i + delta]
    if (next) next.focus()
    else if (ev.key === 'ArrowUp') document.getElementById('emoji-search')?.focus()
  }
  const section = (title: string, items: { e: string; name: { en: string; de: string } }[], key: string, first = false) => (
    <section key={key} aria-label={title}>
      <h3 className="meta !text-xs font-semibold px-1 pb-1 pt-2 sticky top-0 bg-card">{title}</h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))]">
        {items.map((it, i) => <EmojiButton key={it.e} e={it.e} label={name(it)} onPick={onPick} tab={first && i === 0} />)}
      </div>
    </section>
  )
  return (
    <div className="flex flex-col min-h-0">
      <div className="px-3 pb-2 shrink-0">
        <SearchField
          id="emoji-search" autoFocus type="search" autoComplete="off" enterKeyHint="search"
          placeholder={t('controls.emoji.searchPlaceholder')} aria-label={t('controls.emoji.search')}
          value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); const first = results?.[0]; if (first) onPick(first.e) }
            else if (e.key === 'ArrowDown') { e.preventDefault(); buttons()[0]?.focus() }
          }}
        />
      </div>
      <div ref={grid} className="overflow-y-auto overscroll-contain px-2 pb-3 min-h-[12rem] max-h-[min(20rem,50dvh)]" onKeyDown={onGridKey}>
        {failed ? <p className="meta p-3">{t('controls.emoji.empty')}</p>
          : !data ? <p className="meta p-3" role="status">{t('controls.emoji.loading')}</p>
          : results ? (results.length ? section(t('controls.emoji.results'), results, 'results', true) : <p className="meta p-3" role="status">{t('controls.emoji.empty')}</p>)
          : data.CATEGORIES.map((c, i) => section(t(CAT_KEYS[c.id as keyof typeof CAT_KEYS] as TKey), c.items, c.id, i === 0))}
      </div>
      <span className="sr-only" aria-live="polite">{results ? `${results.length}` : value}</span>
    </div>
  )
}

/**
 * Chooses a single emoji: a button showing the current emoji (or a placeholder) opens a popover (bottom sheet on phones) with a search
 * field and categories; "remove" clears it. The emoji data is loaded on first use.
 */
export function EmojiPicker({ value, onChange, disabled, placeholder = '🙂', label = t('controls.emoji.choose'), id }: {
  value: string
  onChange: (emoji: string) => void
  disabled?: boolean
  placeholder?: string
  label?: string
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pick = (e: string) => { onChange(e); setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  return (
    <div ref={wrap} className="flex items-center gap-2">
      <button
        ref={trigger} id={id} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-label={value ? `${label}: ${value}` : label}
        className={`input !w-14 !px-0 text-center text-2xl leading-none ${value ? '' : 'opacity-40'} ${open ? 'border-accent ring-[3px] ring-accent/25' : ''}`}
        onClick={() => setOpen(!open)}
        onMouseEnter={() => { void loadData().catch(() => {}) }}
      >
        {value || placeholder}
      </button>
      {value && !disabled && (
        <button type="button" className="icon-btn icon-btn-sm" aria-label={t('controls.emoji.remove')} title={t('controls.emoji.remove')} onClick={() => onChange('')}><X size={16} /></button>
      )}
      {open && (
        <Popover anchor={wrap} width={340} sheet title={t('controls.emoji.title')} maxH={440} onClose={(r) => { setOpen(false); if (r !== 'outside') trigger.current?.focus({ preventScroll: true }) }}>
          <Panel onPick={pick} value={value} />
        </Popover>
      )}
    </div>
  )
}
