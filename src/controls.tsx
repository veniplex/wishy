/**
 * Input primitives in the A2 look (no native browser UI): Popover · Select · MultiSelect · SuggestInput · DatePicker ·
 * Checkbox · Switch · FilePicker. Re-exported by ui.tsx – keep importing from './ui'.
 *
 * Popover:     Portal in <body>, flips upwards, bottom sheet on narrow screens; Escape/outside click closes only the topmost one.
 * Select:      Single selection (combobox/listbox, keyboard, search from 9 options, groups, icons, "+ New" right in the list)
 * MultiSelect: Multi-selection, same list; selection appears as pills in the trigger
 */
import {
  Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type DragEvent, type KeyboardEvent as RKeyboardEvent, type ReactElement, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { fmtIntl, getLocale, monthNames, t, weekdaysShort } from './i18n'
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Plus, Search, X, type LucideIcon } from 'lucide-react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

// ───────────────────────────── Popover ─────────────────────────────

const popStack: symbol[] = []
const narrowNow = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches

export type CloseReason = 'escape' | 'outside' | 'pick'

interface Pos { up: boolean; left: number; width: number; top: number; bottom: number; maxHeight: number }

/**
 * Floating surface at the `anchor`. `sheet` = bottom sheet with scrim on smartphones. Escape and outside click close it
 * (`onClose(reason)`) – only the topmost one for nested popovers. Focus is managed by the caller.
 */
export function Popover({ anchor, onClose, children, matchWidth, width = 288, align = 'start', sheet, title, className, maxH = 380, menu, popRef }: {
  anchor: RefObject<HTMLElement | null>
  onClose: (reason: CloseReason) => void
  children: ReactNode
  matchWidth?: boolean
  width?: number
  align?: 'start' | 'end'
  sheet?: boolean
  title?: string
  className?: string
  maxH?: number
  menu?: boolean
  popRef?: RefObject<HTMLDivElement | null>
}) {
  const inner = useRef<HTMLDivElement>(null)
  const ref = popRef ?? inner
  const [pos, setPos] = useState<Pos | null>(null)
  const [narrow, setNarrow] = useState(narrowNow)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const asSheet = !!sheet && narrow

  const place = useCallback(() => {
    const a = anchor.current, el = ref.current
    if (!a || !el) return
    const r = a.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    const margin = 8, gap = 6
    const w = Math.min(vw - margin * 2, matchWidth ? Math.max(r.width, 200) : width)
    el.style.maxHeight = 'none'
    const natural = Math.min(el.offsetHeight, maxH)
    const below = vh - r.bottom - gap - margin
    const above = r.top - gap - margin
    const up = below < natural && above > below
    let left = align === 'end' ? r.right - w : r.left
    left = Math.max(margin, Math.min(left, vw - w - margin))
    setPos({ up, left, width: w, top: r.bottom + gap, bottom: vh - r.top + gap, maxHeight: Math.max(140, Math.min(maxH, up ? above : below)) })
  }, [anchor, ref, matchWidth, width, align, maxH])

  useLayoutEffect(() => {
    if (asSheet) return
    place()
    const h = (e: Event) => { if (e.type === 'scroll' && ref.current?.contains(e.target as Node)) return; place() }
    window.addEventListener('resize', h)
    window.addEventListener('scroll', h, true)
    return () => { window.removeEventListener('resize', h); window.removeEventListener('scroll', h, true) }
  }, [place, asSheet, ref])

  useEffect(() => {
    const h = () => setNarrow(narrowNow())
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [])

  useEffect(() => {
    const id = Symbol('pop')
    popStack.push(id)
    const top = () => popStack[popStack.length - 1] === id
    const down = (e: PointerEvent) => {
      if (!top()) return
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      closeRef.current('outside')
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !top()) return
      e.stopPropagation() // closes only the popover, not the dialog behind it
      closeRef.current('escape')
    }
    document.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      popStack.splice(popStack.indexOf(id), 1)
    }
  }, [anchor, ref])

  if (asSheet) {
    return createPortal(
      <>
        <div className="pop-scrim" aria-hidden />
        <div className="fixed inset-x-0 bottom-0 z-[71]">
          <div ref={ref} className={cx('pop-sheet mx-auto max-w-lg', className)}>
            <div className="mx-auto mt-2.5 mb-1 h-1 w-10 rounded-full bg-line shrink-0" aria-hidden />
            {title && <div className="px-5 pt-1 pb-2 font-display font-semibold shrink-0">{title}</div>}
            {children}
          </div>
        </div>
      </>,
      document.body,
    )
  }
  const aw = anchor.current ? Math.min(window.innerWidth - 16, matchWidth ? Math.max(anchor.current.offsetWidth, 200) : width) : width
  return createPortal(
    <div
      ref={ref}
      data-up={pos?.up ? 'true' : 'false'}
      className={cx(menu ? 'menu' : 'pop', 'z-[70]', className)}
      style={pos
        ? { position: 'fixed', left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...(pos.up ? { bottom: pos.bottom } : { top: pos.top }) }
        : { position: 'fixed', left: 0, top: 0, width: aw, opacity: 0, pointerEvents: 'none', animation: 'none' }}
    >
      {children}
    </div>,
    document.body,
  )
}

// ───────────────────────────── Options ─────────────────────────────

export interface SelectOption {
  value: string | number
  label: string
  /** Icon, emoji or avatar before the label */
  icon?: ReactNode
  /** Second, muted detail on the right */
  meta?: ReactNode
  disabled?: boolean
  group?: string
  /** Additional search terms */
  keywords?: string
}

/** Allows `<option>`/`<optgroup>` as children (like the native select) */
function optionsFromChildren(children: ReactNode, group?: string, out: SelectOption[] = []): SelectOption[] {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return
    const el = c as ReactElement<{ value?: string | number; children?: ReactNode; label?: string; disabled?: boolean }>
    if (el.type === Fragment) optionsFromChildren(el.props.children, group, out)
    else if (el.type === 'optgroup') optionsFromChildren(el.props.children, el.props.label, out)
    else if (el.type === 'option') {
      const label = textOf(el.props.children)
      out.push({ value: el.props.value ?? label, label, disabled: el.props.disabled, group })
    }
  })
  return out
}
const textOf = (n: ReactNode): string => (Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : '')

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export interface CreateConfig {
  /** e.g. "New person" – appears as "+ New person" and "+ New person "text"" */
  label: string
  /** Creates the entry and returns its value (null = error, already reported) */
  onCreate: (name: string) => Promise<string | number | null>
  /** Custom form instead of the name field (e.g. occasion with date) */
  form?: (p: { text: string; done: (v: string | number | null) => void; cancel: () => void }) => ReactNode
  /** Placeholder in the name field */
  placeholder?: string
}

type Row = { kind: 'opt'; opt: SelectOption; idx: number } | { kind: 'create'; text: string; idx: number }

/** List (+ search + "Create new") inside a popover. Owns all keyboard handling. */
function ListPanel({ idBase, options, selected, multiple, onPick, searchable, create, onCreated, onDone, label, focusRef }: {
  idBase: string
  options: SelectOption[]
  selected: Set<string>
  multiple: boolean
  onPick: (o: SelectOption) => void
  searchable: boolean
  create?: CreateConfig
  onCreated: (v: string | number) => void
  onDone: (reason: CloseReason | 'tab') => void
  label?: string
  focusRef?: RefObject<HTMLElement | null>
}) {
  const [query, setQuery] = useState('')
  const [view, setView] = useState<{ text: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const buf = useRef({ s: '', t: 0 })

  const filtered = useMemo(() => {
    const q = norm(query.trim())
    return q ? options.filter((o) => norm(`${o.label} ${o.keywords ?? ''}`).includes(q)) : options
  }, [options, query])
  const rows = useMemo<Row[]>(() => {
    const r: Row[] = filtered.map((opt, idx) => ({ kind: 'opt', opt, idx }))
    if (create) {
      const t = query.trim()
      if (t && !options.some((o) => norm(o.label) === norm(t))) r.push({ kind: 'create', text: t, idx: r.length })
      r.push({ kind: 'create', text: '', idx: r.length })
    }
    return r
  }, [filtered, create, query, options])

  const enabled = (i: number) => rows[i] && !(rows[i].kind === 'opt' && (rows[i] as { opt: SelectOption }).opt.disabled)
  const firstSel = () => rows.findIndex((r) => r.kind === 'opt' && selected.has(String(r.opt.value)) && !r.opt.disabled)
  const [active, setActive] = useState(() => Math.max(0, firstSel()))
  // Jump to the first match when searching
  useEffect(() => { setActive(query ? rows.findIndex((_, i) => enabled(i)) : Math.max(0, firstSel())) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [query])

  useEffect(() => { document.getElementById(`${idBase}-o${active}`)?.scrollIntoView({ block: 'nearest' }) }, [active, idBase, view])
  useEffect(() => { (searchable ? searchRef.current : listRef.current)?.focus({ preventScroll: true }) }, [searchable, view])

  const move = (from: number, d: number) => {
    for (let i = from + d; i >= 0 && i < rows.length; i += d) if (enabled(i)) return i
    return from
  }
  const startCreate = async (text: string) => {
    if (create?.form || !text) return setView({ text })
    const v = await create!.onCreate(text)
    if (v != null) { setQuery(''); onCreated(v) }
  }
  const pickRow = (r: Row) => (r.kind === 'create' ? void startCreate(r.text) : onPick(r.opt))

  const onKey = (e: RKeyboardEvent) => {
    const isInput = e.target === searchRef.current
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => (enabled(a) ? move(a, 1) : move(-1, 1))); break
      case 'ArrowUp': e.preventDefault(); setActive((a) => (enabled(a) ? move(a, -1) : move(rows.length, -1))); break
      case 'Home': if (!isInput) { e.preventDefault(); setActive(move(-1, 1)) } break
      case 'End': if (!isInput) { e.preventDefault(); setActive(move(rows.length, -1)) } break
      case 'PageDown': e.preventDefault(); setActive(move(Math.min(rows.length - 1, active + 6) + 1, -1)); break
      case 'PageUp': e.preventDefault(); setActive(move(Math.max(0, active - 6) - 1, 1)); break
      case 'Enter': e.preventDefault(); if (rows[active] && enabled(active)) pickRow(rows[active]); break
      case ' ':
        if (!isInput) { e.preventDefault(); if (rows[active] && enabled(active)) pickRow(rows[active]) }
        break
      case 'Tab': onDone('tab'); break
      default:
        // Typing without a search field: jump to the matching entry
        if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now()
          buf.current = { s: (now - buf.current.t > 600 ? '' : buf.current.s) + e.key.toLowerCase(), t: now }
          const i = rows.findIndex((r, ix) => enabled(ix) && r.kind === 'opt' && norm(r.opt.label).startsWith(norm(buf.current.s)))
          if (i >= 0) setActive(i)
        }
    }
  }

  if (view && create) {
    const done = (v: string | number | null) => { if (v != null) onCreated(v); else setView(null) }
    return (
      <div className="p-3 space-y-3 overflow-y-auto">
        <div className="flex items-center gap-1.5">
          <button type="button" className="icon-btn icon-btn-sm -ml-1" aria-label={t('controls.backToList')} onClick={() => setView(null)}><ChevronLeft size={17} /></button>
          <div className="font-display font-semibold">{create.label}</div>
        </div>
        {create.form
          ? create.form({ text: view.text, done, cancel: () => setView(null) })
          : <NameForm initial={view.text} placeholder={create.placeholder ?? t('controls.name')} submitLabel={t('controls.create')} onSubmit={async (n) => done(await create.onCreate(n))} onCancel={() => setView(null)} />}
      </div>
    )
  }

  // Build groups
  const out: ReactNode[] = []
  let group: string | undefined
  let chunk: ReactNode[] = []
  let gi = 0
  const flush = () => {
    if (!chunk.length) return
    out.push(group
      ? <div key={`g${gi}`} role="group" aria-labelledby={`${idBase}-g${gi}`}><div id={`${idBase}-g${gi}`} className="opt-group">{group}</div>{chunk}</div>
      : <Fragment key={`g${gi}`}>{chunk}</Fragment>)
    chunk = []
    gi++
  }
  rows.forEach((r) => {
    const g = r.kind === 'opt' ? r.opt.group : undefined
    if (g !== group) { flush(); group = g }
    const on = r.kind === 'opt' && selected.has(String(r.opt.value))
    chunk.push(
      <div
        key={r.kind === 'opt' ? `o${r.opt.value}` : `c${r.text}`}
        id={`${idBase}-o${r.idx}`}
        role="option"
        aria-selected={r.kind === 'opt' ? on : false}
        aria-disabled={r.kind === 'opt' && r.opt.disabled ? true : undefined}
        className={cx('opt', r.kind === 'create' && 'opt-create', r.idx === active && 'opt-active')}
        onMouseDown={(e) => e.preventDefault()}
        onPointerMove={() => enabled(r.idx) && active !== r.idx && setActive(r.idx)}
        onClick={() => enabled(r.idx) && pickRow(r)}
      >
        {r.kind === 'create' ? (
          <>
            <Plus size={16} className="shrink-0" />
            <span className="flex-1 min-w-0 truncate">{r.text ? t('controls.createNamed', { label: create!.label, text: r.text }) : create!.label}</span>
          </>
        ) : (
          <>
            {r.opt.icon != null && <span className="shrink-0 inline-flex items-center justify-center min-w-5">{r.opt.icon}</span>}
            <span className="flex-1 min-w-0 truncate">{r.opt.label}</span>
            {r.opt.meta != null && <span className="meta shrink-0">{r.opt.meta}</span>}
            {on && <Check size={16} className="shrink-0 text-accent" aria-hidden />}
          </>
        )}
      </div>,
    )
  })
  flush()

  const activeId = rows[active] ? `${idBase}-o${active}` : undefined
  return (
    <>
      {searchable && (
        <div className="relative px-2.5 pt-2.5 pb-1 shrink-0">
          <Search size={15} className="absolute left-5 top-1/2 -translate-y-1/2 text-muted pointer-events-none mt-[1px]" aria-hidden />
          <input
            ref={searchRef}
            role="combobox"
            aria-expanded
            aria-controls={idBase}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={label ? t('controls.searchIn', { label }) : t('controls.search')}
            autoComplete="off"
            className="input !pl-9 !h-10"
            placeholder={create ? t('controls.searchOrNew') : t('controls.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
      )}
      <div
        ref={(el) => { listRef.current = el; if (focusRef) (focusRef as { current: HTMLElement | null }).current = el }}
        id={idBase}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
        aria-activedescendant={searchable ? undefined : activeId}
        tabIndex={searchable ? -1 : 0}
        className="overflow-y-auto overscroll-contain p-1.5 outline-none flex-1 min-h-0"
        onKeyDown={searchable ? undefined : onKey}
      >
        {out}
        {!rows.length && <div className="px-3 py-3 text-sm text-muted">{t('controls.noMatches')}</div>}
        {rows.length > 0 && !rows.some((r) => r.kind === 'opt') && !create && <div className="px-3 py-3 text-sm text-muted">{t('controls.noMatches')}</div>}
      </div>
    </>
  )
}

/** Name field for "+ New" (no <form>, so the dialog underneath is not submitted along with it) */
export function NameForm({ initial = '', placeholder, submitLabel, onSubmit, onCancel }: { initial?: string; placeholder: string; submitLabel: string; onSubmit: (name: string) => Promise<void> | void; onCancel: () => void }) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try { await onSubmit(name.trim()) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-3">
      <input
        className="input" autoFocus aria-label={placeholder} placeholder={placeholder} value={name} maxLength={120}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void go() } }}
      />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!name.trim() || busy} onClick={() => void go()}>{submitLabel}</button>
      </div>
    </div>
  )
}

// ───────────────────────────── Select / MultiSelect ─────────────────────────────

interface BaseProps {
  options?: SelectOption[]
  children?: ReactNode
  placeholder?: string
  inline?: boolean
  className?: string
  invalid?: boolean
  disabled?: boolean
  id?: string
  'aria-label'?: string
  /** Force/forbid the search field (default: from 9 options) */
  searchable?: boolean
  create?: CreateConfig
}

function useCombo(opts: SelectOption[], searchableProp: boolean | undefined, create: CreateConfig | undefined) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const wrap = useRef<HTMLSpanElement>(null)
  const uid = useId().replace(/:/g, '')
  const searchable = searchableProp ?? (opts.length > 8 || !!create)
  const close = (reason?: CloseReason | 'tab') => {
    setOpen(false)
    if (reason !== 'outside') trigger.current?.focus({ preventScroll: true })
  }
  const onTriggerKey = (e: RKeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); setOpen(true) }
  }
  return { open, setOpen, trigger, wrap, uid, searchable, close, onTriggerKey }
}

export type SelectChange = { target: { value: string } }

/**
 * Single selection. Options via `options` (with icon/meta/group) or, like the native select, as `<option>`/`<optgroup>` children.
 * `onChange` receives `{ target: { value } }` (value as string). `create` shows "+ New …" in the list.
 */
export function Select({ value, onChange, options, children, placeholder = t('controls.choose'), inline, className, invalid, disabled, id, searchable: sp, create, ...aria }: BaseProps & { value: string | number | null | undefined; onChange?: (e: SelectChange) => void }) {
  const opts = useMemo(() => options ?? optionsFromChildren(children), [options, children])
  const c = useCombo(opts, sp, create)
  const cur = opts.find((o) => String(o.value) === String(value ?? ''))
  const set = (v: string | number) => { onChange?.({ target: { value: String(v) } }); c.close('pick') }
  return (
    <span ref={c.wrap} className={cx('relative', inline ? 'inline-block' : 'block', className)}>
      <button
        ref={c.trigger} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={c.open} aria-controls={c.open ? c.uid : undefined}
        aria-label={aria['aria-label']} aria-invalid={invalid || undefined} disabled={disabled} data-empty={!cur || undefined}
        className={cx('input select-trigger', invalid && 'input-invalid')}
        onClick={() => c.setOpen(!c.open)} onKeyDown={c.onTriggerKey}
      >
        <span className="flex items-center gap-2 min-w-0 flex-1">
          {cur?.icon != null && <span className="shrink-0 inline-flex">{cur.icon}</span>}
          <span className="truncate">{cur ? cur.label : placeholder}</span>
        </span>
        <ChevronDown size={16} className={cx('shrink-0 text-muted transition-transform', c.open && 'rotate-180')} aria-hidden />
      </button>
      {c.open && (
        <Popover anchor={c.wrap} matchWidth sheet title={aria['aria-label']} onClose={c.close}>
          <ListPanel
            idBase={c.uid} options={opts} selected={new Set(value == null ? [] : [String(value)])} multiple={false} searchable={c.searchable}
            label={aria['aria-label']} create={create} onPick={(o) => set(o.value)} onCreated={set} onDone={c.close}
          />
        </Popover>
      )}
    </span>
  )
}

/** Multi-selection: pills in the trigger, the list stays open while choosing. */
export function MultiSelect({ value, onChange, options, children, placeholder = t('controls.choose'), className, invalid, disabled, id, searchable: sp, create, ...aria }: BaseProps & { value: (string | number)[]; onChange: (v: (string | number)[]) => void }) {
  const opts = useMemo(() => options ?? optionsFromChildren(children), [options, children])
  const c = useCombo(opts, sp, create)
  const sel = new Set(value.map(String))
  const chosen = value.map((v) => opts.find((o) => String(o.value) === String(v))).filter(Boolean) as SelectOption[]
  const toggle = (v: string | number) => onChange(sel.has(String(v)) ? value.filter((x) => String(x) !== String(v)) : [...value, v])
  return (
    <span ref={c.wrap} className={cx('relative block', className)}>
      <button
        ref={c.trigger} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={c.open} aria-controls={c.open ? c.uid : undefined}
        aria-label={aria['aria-label']} aria-invalid={invalid || undefined} disabled={disabled} data-empty={!chosen.length || undefined}
        className={cx('input select-trigger select-trigger-multi', invalid && 'input-invalid')}
        onClick={() => c.setOpen(!c.open)} onKeyDown={c.onTriggerKey}
      >
        <span className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
          {chosen.length ? chosen.map((o) => (
            <span key={String(o.value)} className="sel-chip">
              {o.icon != null && <span className="shrink-0 inline-flex">{o.icon}</span>}
              <span className="truncate">{o.label}</span>
            </span>
          )) : <span>{placeholder}</span>}
        </span>
        <ChevronDown size={16} className={cx('shrink-0 text-muted transition-transform', c.open && 'rotate-180')} aria-hidden />
      </button>
      {c.open && (
        <Popover anchor={c.wrap} matchWidth sheet title={aria['aria-label']} onClose={c.close}>
          <ListPanel
            idBase={c.uid} options={opts} selected={sel} multiple searchable={c.searchable} label={aria['aria-label']} create={create}
            onPick={(o) => toggle(o.value)} onCreated={(v) => { if (!sel.has(String(v))) onChange([...value, v]) }} onDone={c.close}
          />
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-line shrink-0">
            <span className="meta">{chosen.length ? t('controls.chosenCount', { count: chosen.length }) : t('controls.nothingChosen')}</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => c.close('pick')}>{t('common.done')}</button>
          </div>
        </Popover>
      )}
    </span>
  )
}

/** Free text with suggestions (replaces <datalist>): input stays free, the list is only an offer. */
export function SuggestInput({ value, onChange, suggestions, placeholder, className, id, ...aria }: {
  value: string
  onChange: (v: string) => void
  suggestions: string[]
  placeholder?: string
  className?: string
  id?: string
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const wrap = useRef<HTMLSpanElement>(null)
  const uid = useId().replace(/:/g, '')
  const q = norm(value.trim())
  const list = suggestions.filter((s) => !q || norm(s) === q || norm(s).includes(q))
  const shown = open && list.length > 0
  const pick = (s: string) => { onChange(s); setOpen(false); setActive(-1) }
  useEffect(() => { if (active >= 0) document.getElementById(`${uid}-o${active}`)?.scrollIntoView({ block: 'nearest' }) }, [active, uid])
  const onKey = (e: RKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(list.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter' && shown && active >= 0) { e.preventDefault(); pick(list[active]) }
    else if (e.key === 'Escape' && shown) { setOpen(false) }
  }
  return (
    <span ref={wrap} className={cx('relative block', className)}>
      <input
        id={id} className="input" role="combobox" aria-autocomplete="list" aria-expanded={shown} aria-controls={shown ? uid : undefined}
        aria-activedescendant={shown && active >= 0 ? `${uid}-o${active}` : undefined} aria-label={aria['aria-label']} autoComplete="off"
        placeholder={placeholder} value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1) }}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={onKey}
      />
      {shown && (
        <Popover anchor={wrap} matchWidth onClose={() => setOpen(false)} maxH={260}>
          <div id={uid} role="listbox" className="overflow-y-auto overscroll-contain p-1.5">
            {list.map((s, i) => (
              <div
                key={s} id={`${uid}-o${i}`} role="option" aria-selected={s === value}
                className={cx('opt', i === active && 'opt-active')}
                onMouseDown={(e) => e.preventDefault()} onPointerMove={() => setActive(i)} onClick={() => pick(s)}
              >
                <span className="flex-1 truncate">{s}</span>
                {s === value && <Check size={16} className="text-accent shrink-0" aria-hidden />}
              </div>
            ))}
          </div>
        </Popover>
      )}
    </span>
  )
}

// ───────────────────────────── DatePicker ─────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
const mk = (y: number, m: number, d: number) => { const t = new Date(y, m, d); return `${String(t.getFullYear()).padStart(4, '0')}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` }
const splitIso = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null }
const todayIso = () => { const t = new Date(); return mk(t.getFullYear(), t.getMonth(), t.getDate()) }
const addDays = (s: string, n: number) => { const p = splitIso(s)!; return mk(p.y, p.m, p.d + n) }
const addMonths = (s: string, n: number) => {
  const p = splitIso(s)!
  const last = new Date(p.y, p.m + n + 1, 0).getDate()
  return mk(p.y, p.m + n, Math.min(p.d, last))
}
const display = (s: string) => { const p = splitIso(s); return p ? [pad(p.d), pad(p.m + 1), p.y].join(getLocale() === 'de' ? '.' : '/') : '' }
/** "24.12.2026", "24.12.26", "24122026", "2026-12-24" */
function parseInput(t: string): string | null {
  const x = t.trim()
  if (!x) return ''
  let y: number, m: number, d: number
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(x)
  if (r) { y = +r[1]; m = +r[2]; d = +r[3] } else if ((r = /^(\d{1,2})[./\s-](\d{1,2})[./\s-](\d{2}|\d{4})$/.exec(x))) { d = +r[1]; m = +r[2]; y = +r[3]; if (r[3].length === 2) { y += 2000; if (y > new Date().getFullYear() + 10) y -= 100 } } else if ((r = /^(\d{2})(\d{2})(\d{4})$/.exec(x))) { d = +r[1]; m = +r[2]; y = +r[3] } else return null
  const t2 = new Date(y, m - 1, d)
  return t2.getFullYear() === y && t2.getMonth() === m - 1 && t2.getDate() === d ? mk(y, m - 1, d) : null
}
const longDate = (s: string) => { const p = splitIso(s)!; return fmtIntl(new Date(p.y, p.m, p.d), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) }

function Calendar({ value, min, max, onPick, onClear, clearable }: { value: string; min?: string; max?: string; onPick: (iso: string) => void; onClear: () => void; clearable: boolean }) {
  const MONTHS = monthNames('long')
  const MONTHS_SHORT = monthNames('short')
  const WEEKDAYS = weekdaysShort()
  const today = todayIso()
  const clamp = (s: string) => (min && s < min ? min : max && s > max ? max : s)
  const [cursor, setCursor] = useState(() => clamp(splitIso(value) ? value : today))
  const [view, setView] = useState<'days' | 'months' | 'years'>('days')
  const [yearBase, setYearBase] = useState(() => splitIso(cursor)!.y - 4)
  const root = useRef<HTMLDivElement>(null)
  const p = splitIso(cursor)!
  const off = (s: string) => (min != null && s < min) || (max != null && s > max)

  useEffect(() => { root.current?.querySelector<HTMLElement>('[data-focus="true"]')?.focus({ preventScroll: true }) }, [cursor, view])

  // Grid: 6 weeks, Monday first
  const first = new Date(p.y, p.m, 1)
  const lead = (first.getDay() + 6) % 7
  const days = Array.from({ length: 42 }, (_, i) => mk(p.y, p.m, 1 - lead + i))

  const onDayKey = (e: RKeyboardEvent) => {
    const map: Record<string, () => string> = {
      ArrowLeft: () => addDays(cursor, -1), ArrowRight: () => addDays(cursor, 1), ArrowUp: () => addDays(cursor, -7), ArrowDown: () => addDays(cursor, 7),
      Home: () => addDays(cursor, -((new Date(p.y, p.m, p.d).getDay() + 6) % 7)), End: () => addDays(cursor, 6 - ((new Date(p.y, p.m, p.d).getDay() + 6) % 7)),
      PageUp: () => addMonths(cursor, e.shiftKey ? -12 : -1), PageDown: () => addMonths(cursor, e.shiftKey ? 12 : 1),
    }
    const f = map[e.key]
    if (f) { e.preventDefault(); setCursor(clamp(f())) }
  }
  const onGridKey = (e: RKeyboardEvent, cols: number) => {
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key]
    if (!d) return
    e.preventDefault()
    const cells = [...(root.current?.querySelectorAll<HTMLElement>('[data-cell]') ?? [])]
    const i = cells.indexOf(document.activeElement as HTMLElement)
    cells[Math.max(0, Math.min(cells.length - 1, i + d))]?.focus()
  }

  const navBtn = 'icon-btn icon-btn-sm'
  return (
    <div ref={root} className="p-3 w-full" role="dialog" aria-label={t('controls.chooseDate')}>
      <div className="flex items-center justify-between gap-1 mb-2">
        <button type="button" className={navBtn} aria-label={view === 'days' ? t('controls.prevMonth') : view === 'years' ? t('controls.prevYears') : t('controls.prevYear')} onClick={() => (view === 'days' ? setCursor(addMonths(cursor, -1)) : view === 'years' ? setYearBase(yearBase - 12) : setCursor(addMonths(cursor, -12)))}><ChevronLeft size={17} /></button>
        <button type="button" className="rounded-full px-3 h-9 font-display font-semibold hover:bg-hover cursor-pointer" aria-live="polite" onClick={() => { setYearBase(p.y - 4); setView(view === 'days' ? 'months' : view === 'months' ? 'years' : 'days') }}>
          {view === 'days' ? `${MONTHS[p.m]} ${p.y}` : view === 'months' ? String(p.y) : `${yearBase} – ${yearBase + 11}`}
        </button>
        <button type="button" className={navBtn} aria-label={view === 'days' ? t('controls.nextMonth') : view === 'years' ? t('controls.nextYears') : t('controls.nextYear')} onClick={() => (view === 'days' ? setCursor(addMonths(cursor, 1)) : view === 'years' ? setYearBase(yearBase + 12) : setCursor(addMonths(cursor, 12)))}><ChevronRight size={17} /></button>
      </div>

      <div className="min-h-[16.75rem] max-sm:min-h-[18.5rem]">
      {view === 'days' && (
        <div role="grid" aria-label={`${MONTHS[p.m]} ${p.y}`} onKeyDown={onDayKey}>
          <div role="row" className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map((w) => <div key={w} role="columnheader" className="meta text-center font-semibold py-1">{w}</div>)}
          </div>
          {Array.from({ length: 6 }, (_, wk) => (
            <div key={wk} role="row" className="grid grid-cols-7">
              {days.slice(wk * 7, wk * 7 + 7).map((s) => {
                const dp = splitIso(s)!
                const inMonth = dp.m === p.m
                const sel = s === value
                const isToday = s === today
                const dis = off(s)
                return (
                  <div key={s} role="gridcell" aria-selected={sel} className="grid place-items-center">
                    <button
                      type="button" disabled={dis} data-focus={s === cursor || undefined} tabIndex={s === cursor ? 0 : -1} aria-label={longDate(s)} aria-current={isToday ? 'date' : undefined}
                      onClick={() => onPick(s)}
                      className={cx(
                        'size-10 max-sm:size-11 rounded-full text-sm grid place-items-center tabular-nums cursor-pointer transition-colors disabled:opacity-35 disabled:cursor-not-allowed',
                        sel ? 'bg-accent text-accent-ink font-semibold shadow-accent' : isToday ? 'ring-2 ring-inset ring-accent text-accent font-semibold hover:bg-soft' : inMonth ? 'text-ink hover:bg-hover' : 'text-muted hover:bg-hover',
                      )}
                    >{dp.d}</button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {view === 'months' && (
        <div className="grid grid-cols-3 gap-1.5" onKeyDown={(e) => onGridKey(e, 3)}>
          {MONTHS_SHORT.map((m, i) => (
            <button key={m} type="button" data-cell data-focus={i === p.m || undefined} aria-label={`${MONTHS[i]} ${p.y}`} aria-pressed={i === p.m}
              className={cx('h-11 rounded-2xl text-sm font-medium cursor-pointer transition-colors', i === p.m ? 'bg-soft text-accent font-semibold' : 'hover:bg-hover')}
              onClick={() => { setCursor(clamp(mk(p.y, i, Math.min(p.d, new Date(p.y, i + 1, 0).getDate())))); setView('days') }}>{m.replace('.', '')}</button>
          ))}
        </div>
      )}

      {view === 'years' && (
        <div className="grid grid-cols-3 gap-1.5" onKeyDown={(e) => onGridKey(e, 3)}>
          {Array.from({ length: 12 }, (_, i) => yearBase + i).map((y) => (
            <button key={y} type="button" data-cell data-focus={y === p.y || undefined} aria-pressed={y === p.y}
              className={cx('h-11 rounded-2xl text-sm font-medium tabular-nums cursor-pointer transition-colors', y === p.y ? 'bg-soft text-accent font-semibold' : y === +today.slice(0, 4) ? 'text-accent hover:bg-hover' : 'hover:bg-hover')}
              onClick={() => { setCursor(clamp(mk(y, p.m, Math.min(p.d, new Date(y, p.m + 1, 0).getDate())))); setView('months') }}>{y}</button>
          ))}
        </div>
      )}

      </div>

      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-line">
        <button type="button" className="btn btn-sm btn-accent" disabled={off(today)} onClick={() => onPick(today)}>{t('controls.today')}</button>
        {clearable && <button type="button" className="btn btn-sm btn-ghost" disabled={!value} onClick={onClear}>{t('controls.clear')}</button>}
      </div>
    </div>
  )
}

/**
 * Date field: type as DD.MM.YYYY or pick in the calendar (Monday first, today highlighted). Value and `onChange` are ISO strings
 * (`YYYY-MM-DD`, empty = no date). Arrow keys in the grid, PageUp/PageDown month, Escape closes.
 */
export function DatePicker({ value, onChange, min, max, required, clearable, invalid, disabled, inline, className, id, placeholder = t('controls.datePlaceholder'), ...aria }: {
  value: string
  onChange: (iso: string) => void
  min?: string
  max?: string
  required?: boolean
  /** Clear button (default: on, except when `required`) */
  clearable?: boolean
  invalid?: boolean
  disabled?: boolean
  /** Fixed, narrow width (toolbar) */
  inline?: boolean
  className?: string
  id?: string
  placeholder?: string
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(display(value))
  const [editing, setEditing] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const canClear = clearable ?? !required
  useEffect(() => { if (!editing) setText(display(value)) }, [value, editing])
  const inRange = (s: string) => !(min && s < min) && !(max && s > max)
  const commit = (): boolean => {
    const r = parseInput(text)
    if (r === null || (r !== '' && !inRange(r))) { setText(display(value)); return false }
    if (r !== value) onChange(r)
    setText(display(r))
    return r !== value
  }
  const pick = (s: string) => { onChange(s); setText(display(s)); setOpen(false); input.current?.focus({ preventScroll: true }) }
  return (
    <div
      ref={wrap}
      className={cx('input flex items-center gap-1 !pr-1.5 focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/25', open && 'border-accent ring-[3px] ring-accent/25', invalid && 'input-invalid', inline ? 'inline-flex !w-auto' : '', disabled && 'opacity-60', className)}
    >
      <input
        ref={input} id={id} type="text" inputMode="numeric" autoComplete="off" required={required} disabled={disabled} placeholder={placeholder} aria-label={aria['aria-label']}
        aria-haspopup="dialog" aria-expanded={open} aria-invalid={invalid || undefined}
        className={cx('flex-1 min-w-0 h-full bg-transparent outline-none tabular-nums', inline ? 'w-28' : '')}
        value={text}
        onFocus={() => setEditing(true)}
        onBlur={() => { setEditing(false); commit() }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true) }
          else if (e.key === 'Enter' && parseInput(text) !== value && !(parseInput(text) === null)) { e.preventDefault(); commit() }
          else if (e.key === 'Enter' && parseInput(text) === null) { e.preventDefault(); setText(display(value)) }
        }}
      />
      {canClear && value && !disabled && (
        <button type="button" className="icon-btn icon-btn-sm !size-8" aria-label={t('controls.clearDate')} onClick={() => { onChange(''); setText(''); input.current?.focus() }}><X size={15} /></button>
      )}
      <button type="button" className="icon-btn icon-btn-sm !size-8" disabled={disabled} aria-label={open ? t('controls.closeCalendar') : t('controls.openCalendar')} aria-expanded={open} onClick={() => setOpen(!open)}><CalendarDays size={16} /></button>
      {open && (
        <Popover anchor={wrap} width={308} sheet title={t('controls.chooseDate')} onClose={(r) => { setOpen(false); if (r !== 'outside') input.current?.focus({ preventScroll: true }) }}>
          <Calendar value={value} min={min} max={max} clearable={canClear} onPick={pick} onClear={() => pick('')} />
        </Popover>
      )}
    </div>
  )
}

// ───────────────────────────── Checkbox / Switch / File ─────────────────────────────

/** Custom checkbox (real <input> underneath, so keyboard and forms work as usual). */
export function Checkbox({ checked, onChange, children, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={cx('flex items-start gap-2.5 text-sm min-h-6 select-none', disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer', className)}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className="mt-px size-5 max-sm:size-[22px] shrink-0 rounded-md border-[1.5px] border-ctl bg-card grid place-items-center text-transparent transition-colors
          peer-checked:bg-accent peer-checked:border-accent peer-checked:text-accent-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
      >
        <Check size={14} strokeWidth={3} />
      </span>
      {children != null && <span className="min-w-0 pt-px">{children}</span>}
    </label>
  )
}

/** Switch for on/off settings (role="switch"). Label on the left, switch on the right. */
export function Switch({ checked, onChange, children, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={cx('flex items-center gap-3 text-sm min-h-8 select-none', disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer', className)}>
      {children != null && <span className="flex-1 min-w-0">{children}</span>}
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} aria-checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className="relative h-7 w-12 shrink-0 rounded-full bg-track border border-ctl transition-colors peer-checked:bg-accent peer-checked:border-accent
          peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent
          after:content-[''] after:absolute after:top-1/2 after:left-[3px] after:size-5 after:-translate-y-1/2 after:rounded-full after:bg-ctl after:transition-all
          peer-checked:after:left-[calc(100%-23px)] peer-checked:after:bg-accent-ink"
      />
    </label>
  )
}

/**
 * File picker in the app look: `zone` = drop area (click, keyboard or drag & drop; `children` replaces the default content, e.g. a preview),
 * `button` = regular button. The real <input type="file"> stays invisible.
 */
export function FilePicker({ accept, onFile, label, hint, icon: Icon, variant = 'zone', buttonClass = 'btn', disabled, children, ariaLabel }: {
  accept?: string
  onFile: (f: File) => void
  label: string
  hint?: string
  icon?: LucideIcon
  variant?: 'zone' | 'button'
  buttonClass?: string
  disabled?: boolean
  children?: ReactNode
  ariaLabel?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const take = (f: File | undefined) => { if (f) onFile(f) }
  const hidden = (
    <input ref={input} type="file" accept={accept} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }} />
  )
  if (variant === 'button') {
    return (
      <>
        <button type="button" className={buttonClass} disabled={disabled} onClick={() => input.current?.click()}>{Icon && <Icon size={16} className="shrink-0" />}{label}</button>
        {hidden}
      </>
    )
  }
  const over = (e: DragEvent) => { e.preventDefault(); setDrag(true) }
  return (
    <>
      <button
        type="button" disabled={disabled} aria-label={ariaLabel ?? label}
        className={cx('w-full rounded-2xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors disabled:opacity-60', drag ? 'border-accent bg-soft' : 'border-ctl hover:bg-hover')}
        onClick={() => input.current?.click()} onDragOver={over} onDragEnter={over} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files?.[0]) }}
      >
        {children ?? (
          <span className="flex flex-col items-center gap-2 text-muted">
            {Icon && <Icon size={30} />}
            <span className="text-sm">{label}</span>
            {hint && <span className="meta">{hint}</span>}
          </span>
        )}
      </button>
      {hidden}
    </>
  )
}
