/**
 * UI primitives of the app. All pages and forms are built exclusively from these (plus tokens from index.css).
 *
 * Page:        Page · PageHeader (back = breadcrumbs, tabs, actions) · Section · TwoCol · Stats/Stat · Toolbar · PillTabs
 * Menus:       Menu/MenuItem (popover for "+ New", account ...)
 * Content:     List + Row · Card · EmptyState · Badge · Money · Progress · DataTable · Avatar · Thumb · Banner
 * Inputs:      Button · IconButton · Segmented (≤ 4 options) · Select (more) · Chip · PersonPicker · SearchField
 *              Field · Checkbox · FormError · ToggleLink
 *              CopyField (link/value read-only + copy)
 * Overlays:    Modal · ConfirmProvider/useConfirm (instead of confirm()/alert()) · ConfirmDialog · ToastProvider/useToast
 * Loading:     Skeleton · PageSkeleton
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode,
} from 'react'
import { Link, NavLink, Navigate, useLocation } from 'react-router-dom'
import { Popover, isCoarse } from './controls'
import { useBackLayer } from './back-layer'
import { Check, ChevronRight as Crumb, CircleAlert, CircleCheck, ChevronDown, ChevronLeft, ChevronRight, Copy, Gift as GiftIcon, Search, X, type LucideIcon } from 'lucide-react'
import { type Person } from './lib'
import { UserPictureOverlay } from './user-avatar'
import { useStore } from './store'
import { fmtMoney, t, useT } from './i18n'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

// ───────────────────────────── Buttons ─────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger' | 'destructive' | 'link'
type ButtonProps = {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  /** Icon to the left of the label */
  icon?: LucideIcon
  /** Render as a router link */
  to?: string
  /** Render as <a> (download, external links) */
  href?: string
  download?: boolean
  /** Show only the icon on phones (label stays for screen readers) */
  iconOnlyOnMobile?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { className?: string }

/** Standard button. `primary` at most once per view (the main action in the PageHeader). */
export function Button({ variant = 'secondary', size = 'md', icon: Icon, to, href, download, iconOnlyOnMobile, className, children, type = 'button', ...rest }: ButtonProps) {
  const cls = cx(
    'btn',
    variant !== 'secondary' && `btn-${variant}`,
    size === 'sm' && 'btn-sm',
    iconOnlyOnMobile && 'max-sm:w-11 max-sm:px-0',
    className,
  )
  const inner = (
    <>
      {Icon && <Icon size={size === 'sm' ? 14 : 16} className="shrink-0" />}
      {iconOnlyOnMobile ? <span className="max-sm:sr-only">{children}</span> : children}
    </>
  )
  if (to) return <Link to={to} className={cls}>{inner}</Link>
  if (href) return <a href={href} download={download} className={cls}>{inner}</a>
  return <button type={type} className={cls} {...rest}>{inner}</button>
}

/** Square icon button; `label` is required (aria-label + tooltip). */
export function IconButton({ icon: Icon, label, size = 'md', variant = 'default', to, className, type = 'button', ...rest }: {
  icon: LucideIcon
  label: string
  size?: 'md' | 'sm'
  variant?: 'default' | 'danger'
  to?: string
  className?: string
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  const cls = cx('icon-btn', size === 'sm' && 'icon-btn-sm', variant === 'danger' && 'icon-btn-danger', className)
  const icon = <Icon size={size === 'sm' ? 15 : 17} />
  if (to) return <Link to={to} className={cls} aria-label={label} title={label}>{icon}</Link>
  return <button type={type} className={cls} aria-label={label} title={label} {...rest}>{icon}</button>
}

/** Toggle link ("Show completed" / "Hide completed", "More options"). */
export function ToggleLink({ on, onToggle, labelOn, labelOff, chevron, className }: {
  on: boolean
  onToggle: () => void
  labelOn: string
  labelOff: string
  /** Shows an expand chevron */
  chevron?: boolean
  className?: string
}) {
  const Chev = on ? ChevronDown : ChevronRight
  return (
    <button type="button" className={cx('link-quiet', className)} aria-expanded={chevron ? on : undefined} onClick={onToggle}>
      {chevron && <Chev size={15} />}
      {on ? labelOn : labelOff}
    </button>
  )
}

// ───────────────────────────── Small building blocks ─────────────────────────────

export type BadgeTone = 'neutral' | 'info' | 'warn' | 'ok' | 'bad' | 'accent'
/** Small status label; colors come from the status tokens. */
export function Badge({ tone = 'neutral', icon: Icon, children, className }: { tone?: BadgeTone; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <span className={cx('badge', `badge-${tone}`, className)}>
      {Icon && <Icon size={12} className="shrink-0" />}
      {children}
    </span>
  )
}

/** Amount in the app currency (or `currency`), tabular figures. Right-aligned when the container dictates it (Row trailing, table cell). */
export function Money({ n, currency, strong, tone, className }: { n: number | null | undefined; currency?: string | null; strong?: boolean; tone?: 'muted' | 'bad'; className?: string }) {
  // Also works on public pages without a store (shared wishlist): then in the given currency or EUR
  const money = useStore()?.money ?? ((v: number | null | undefined, cur?: string | null) => fmtMoney(v, cur || 'EUR'))
  return <span className={cx('num', strong && 'font-medium', tone === 'muted' && 'text-muted', tone === 'bad' && 'text-bad', className)}>{money(n, currency)}</span>
}

/** Only top matches are marked - everything else stays quiet */
export const Stars = ({ n }: { n: number }) => (n >= 3 ? <span className="text-warn text-xs shrink-0" title={t('controls.ui.topRated')} aria-label={t('controls.ui.topRated')}>★</span> : null)

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase()

/** Soft per-person tint (token --t1...--t5), stable per person */
export const tintOf = (id: number) => `var(--t${(Math.abs(id) % 5) + 1})`

/** Round photo laid over the (always present) circle of the avatar; if loading fails, the circle with emoji/initials stays visible. */
function PersonPhoto({ src }: { src: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (failed === src) return null
  return <img src={src} alt="" loading="lazy" draggable={false} className="absolute inset-0 size-full object-cover rounded-full" onError={() => setFailed(src)} />
}

/** Photo, else emoji, else initials in a tinted circle. Sizes: 20 (inline), 32 (dense), 44 (default), 64/96 (header). `ring` = colored border. */
export function Avatar({ p, size = 32, ring }: { p: Person | undefined; size?: 20 | 32 | 44 | 64 | 96; ring?: string }) {
  if (!p) return null
  return (
    <span
      className="relative inline-grid place-items-center rounded-full shrink-0 font-display font-bold leading-none text-ink"
      style={{
        width: size,
        height: size,
        fontSize: size * (p.emoji ? 0.5 : 0.36),
        background: p.color ? `color-mix(in srgb, ${p.color} 30%, var(--card))` : tintOf(p.id),
        boxShadow: ring ? `0 0 0 ${size >= 64 ? 3 : 2}px var(--card), 0 0 0 ${size >= 64 ? 5 : 4}px ${ring}` : undefined,
      }}
      title={p.name}
    >
      {p.emoji || initials(p.name)}
      {p.photo_url ? <PersonPhoto src={p.photo_url} /> : p.linked_user_id ? <UserPictureOverlay userId={p.linked_user_id} /> : null}
    </span>
  )
}

/** Product image as a thumbnail, an icon tile without an image (`tone="accent"` for occasions). Sizes: 32 / 44. */
export function Thumb({ src, icon: Icon = GiftIcon, size = 44, tone = 'neutral' }: { src?: string | null; icon?: LucideIcon; size?: 32 | 44; tone?: 'neutral' | 'accent' }) {
  return (
    <span
      className={cx('media inline-grid place-items-center shrink-0 overflow-hidden rounded-2xl', tone === 'accent' ? 'bg-soft text-accent' : 'bg-hover text-muted')}
      style={{ width: size, height: size }}
    >
      {src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" /> : <Icon size={Math.round(size * 0.42)} strokeWidth={1.75} />}
    </span>
  )
}

const FILL = { accent: 'bg-accent text-accent', warn: 'bg-warn text-warn', bad: 'bg-bad text-bad' } as const
/**
 * Progress bar: filled = spent (`value`), striped = planned (`planned`), `marker` = budget line on the `max` scale.
 * Without `tone` it automatically turns warn (> 85 %) or bad (> 100 %). The track has a 3:1 outline.
 */
export function Progress({ value, max, planned = 0, marker, tone, className }: {
  value: number
  max: number | null | undefined
  planned?: number
  marker?: number | null
  tone?: keyof typeof FILL
  className?: string
}) {
  if (!max) return null
  const pct = (v: number) => Math.max(0, Math.min(100, (v / max) * 100))
  const total = value + planned
  const tn = tone ?? (total > max ? 'bad' : total / max > 0.85 ? 'warn' : 'accent')
  const a = pct(value)
  return (
    <div className={cx('progress', className)} role="progressbar" aria-valuenow={Math.round(pct(total))} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full', FILL[tn].split(' ')[0])} style={{ width: `${a}%` }} />
      {planned > 0 && <div className={cx('h-full progress-planned', FILL[tn].split(' ')[1])} style={{ width: `${Math.min(pct(planned), 100 - a)}%` }} />}
      {marker != null && <div className="absolute top-0 bottom-0 w-0.5 bg-ink" style={{ left: `${pct(marker)}%` }} title={t('controls.ui.budget')} />}
    </div>
  )
}

/** Notice bar. `flush` = borderless across the full width (top of the layout). */
export function Banner({ tone = 'info', icon: Icon, action, flush, children }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; icon?: LucideIcon; action?: ReactNode; flush?: boolean; children: ReactNode }) {
  const t = { info: 'bg-info-soft text-info border-info/30', warn: 'bg-warn-soft text-warn border-warn/30', bad: 'bg-bad-soft text-bad border-bad/30', ok: 'bg-ok-soft text-ok border-ok/30' }[tone]
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('flex flex-wrap items-center gap-x-2 gap-y-2 text-sm px-5 py-3 border', t, flush ? 'border-x-0 border-t-0' : 'rounded-2xl')}>
      {Icon && <Icon size={15} className="shrink-0" />}
      <div className="flex-1 basis-48 min-w-0">{children}</div>
      {action}
    </div>
  )
}

/** Error text below a field or form. */
export function FormError({ children, className }: { children?: ReactNode; className?: string }) {
  if (!children) return null
  return <p role="alert" className={cx('text-xs text-bad mt-1.5', className)}>{children}</p>
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />
}

/** Placeholder for the first data fetch: header + list. */
export function PageSkeleton() {
  return (
    <Page>
      <div role="status" aria-label={t('common.loading')} className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="grid grid-cols-2 gap-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <div className="list">{[0, 1, 2, 3].map((i) => <div key={i} className="row"><Skeleton className="size-11" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-1/3" /></div></div>)}</div>
      </div>
    </Page>
  )
}

/**
 * Horizontally scrollable area with soft fade edges on the sides that have more content (mask, no layout shift).
 * `scrollToEnd`: opens scrolled to the end (e.g. the newest month); applied again when `endKey` changes.
 */
export function ScrollFade({ children, className = '', scrollToEnd = false, endKey }: { children: ReactNode; className?: string; scrollToEnd?: boolean; endKey?: unknown }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ l: false, r: false })
  const update = () => {
    const el = ref.current
    if (!el) return
    const l = el.scrollLeft > 2
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    setEdge((e) => (e.l === l && e.r === r ? e : { l, r }))
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (scrollToEnd) el.scrollLeft = el.scrollWidth
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [scrollToEnd, endKey])
  const mask = edge.l || edge.r
    ? `linear-gradient(to right, ${edge.l ? 'transparent 0, #000 28px' : '#000 0'}, ${edge.r ? '#000 calc(100% - 28px), transparent 100%' : '#000 100%'})`
    : undefined
  return (
    <div ref={ref} className={`overflow-x-auto ${className}`} style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined} onScroll={update}>
      {children}
    </div>
  )
}


/** Desktop chrome (side menu, top navigation): width >= 768 px AND height >= 520 px, same as the Tailwind `md` variant (src/index.css) */
const DESKTOP_QUERY = '(min-width: 48rem) and (min-height: 32.5rem)'
export function useDesktopChrome() {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(DESKTOP_QUERY); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  )
}

/** Visual viewport (iOS keyboard) as CSS variables --vvh/--vvt, only while at least one overlay uses them */
let vvUsers = 0
function trackViewport() {
  const vv = window.visualViewport
  const root = document.documentElement
  const set = () => {
    root.style.setProperty('--vvh', `${vv ? vv.height : window.innerHeight}px`)
    root.style.setProperty('--vvt', `${vv ? vv.offsetTop : 0}px`)
  }
  if (!vvUsers++) { vv?.addEventListener('resize', set); vv?.addEventListener('scroll', set); window.addEventListener('resize', set) }
  set()
  return () => {
    if (--vvUsers) return
    vv?.removeEventListener('resize', set); vv?.removeEventListener('scroll', set); window.removeEventListener('resize', set)
    root.style.removeProperty('--vvh'); root.style.removeProperty('--vvt')
  }
}

// ───────────────────────────── Layout ─────────────────────────────

/** A page: uniform width/padding, 32 px spacing between blocks, space at the bottom for the tab bar + quick action. */
/** The ONE page frame: all pages of the app (including settings, admin) use the same content width. The only exception is centered cards (CenteredCard) without navigation. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div className={'mx-auto w-full flex flex-col gap-6 md:gap-8 px-4 pt-3 md:px-10 md:pt-8 pb-[var(--page-pb)] md:pb-16 max-w-[1120px]'}>
      {children}
    </div>
  )
}

export interface TabItem { to: string; label: ReactNode; end?: boolean }

/** Tabs within a section as a pill bar (use only via PageHeader `tabs`). */
function TabNav({ items }: { items: TabItem[] }) {
  return (
    <nav aria-label={t('controls.ui.sectionAria')} className="tabs">
      {items.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cx('tab', isActive && 'tab-on')}>{t.label}</NavLink>
      ))}
    </nav>
  )
}

/** Tabs with state (no routing), same look as TabNav. */
export function PillTabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="tabs">
      {items.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} className={cx('tab', t.value === value && 'tab-on')} onClick={() => onChange(t.value)}>{t.label}</button>
      ))}
    </div>
  )
}

export interface SectionNavItem { to: string; label: ReactNode; icon?: LucideIcon; badge?: ReactNode }

/**
 * Section navigation between DIFFERENT pages (settings, admin). Desktop (md): list on the left. Phones: list-then-detail:
 * at the index URL a list of all sections (icon + label), inside a section a back link "‹ `rootLabel`" and the content.
 * All URLs stay the same. The index route must use <SectionIndex>. Content goes in `children`.
 */
export function SectionLayout({ label, rootLabel, items, children }: { label: string; rootLabel?: string; items: SectionNavItem[]; children: ReactNode }) {
  const { pathname } = useLocation()
  const inSection = items.some((s) => pathname === s.to || pathname.startsWith(`${s.to}/`))
  const root = items[0]?.to.replace(/\/[^/]+$/, '') || '/'
  return (
    <div className="grid gap-4 md:gap-10 md:grid-cols-[13rem_minmax(0,1fr)] items-start">
      <nav aria-label={label} className={cx('flex-col gap-1 md:flex md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:overflow-y-auto', inSection ? 'hidden' : 'flex')}>
        {items.map((s) => (
          <NavLink key={s.to} to={s.to} className={({ isActive }) => cx('nav-link shrink-0 max-md:bg-card max-md:shadow-sm max-md:min-h-14', isActive && 'nav-link-on')}>
            {s.icon && <s.icon size={18} strokeWidth={2} className="shrink-0" />} <span className="flex-1 min-w-0">{s.label}</span>
            {s.badge}
            <ChevronRight size={16} className="md:hidden shrink-0 text-muted" aria-hidden />
          </NavLink>
        ))}
      </nav>
      <div className={cx('min-w-0', !inSection && 'max-md:hidden')}>
        {inSection && (
          <Link to={root} className="md:hidden inline-flex items-center gap-0.5 min-h-11 -mt-2 mb-2 text-sm font-medium text-muted hover:text-accent">
            <ChevronLeft size={18} className="-ml-1" aria-hidden />{rootLabel ?? label}
          </Link>
        )}
        {children}
      </div>
    </div>
  )
}

/** Index route of a section area: redirects to the first section on desktop; on phones it stays and shows the section list */
export function SectionIndex({ to }: { to: string }) {
  return useDesktopChrome() ? <Navigate to={to} replace /> : null
}

/** Breadcrumbs "Gifting › Anna"; on phones only "‹ Gifting" (the page title below already names the current page) */
export function Crumbs({ back, current }: { back: { to: string; label: string }; current: string }) {
  return (
    <nav aria-label={t('controls.ui.breadcrumbAria')} className="flex items-center gap-0.5 text-sm min-w-0">
      <Link to={back.to} className="inline-flex items-center gap-0.5 min-h-9 pointer-coarse:min-h-11 max-w-full text-muted hover:text-accent font-medium">
        <ChevronLeft size={18} className="sm:hidden shrink-0 -ml-1" aria-hidden />
        <span className="truncate">{back.label}</span>
      </Link>
      <Crumb size={16} className="text-muted max-sm:hidden shrink-0" aria-hidden />
      <span aria-current="page" className="font-semibold px-1.5 truncate max-w-[60vw] max-sm:hidden">{current}</span>
    </nav>
  )
}

/** Avatar for users without a person (list owners): initials in a tinted circle */
export function TintAvatar({ name, id, size = 56 }: { name: string; id: number; size?: number }) {
  return (
    <span className="relative inline-grid place-items-center rounded-full shrink-0 font-display font-bold leading-none text-ink" style={{ width: size, height: size, fontSize: size * 0.36, background: tintOf(id) }} title={name}>
      {initials(name)}
      <UserPictureOverlay userId={id} />
    </span>
  )
}

/**
 * Page header: optional breadcrumbs ("Gifting › Anna"), large title (+ `lead`, e.g. avatar), subtitle, actions on the right
 * (exactly one `primary`) and section tabs. Each tab gets its own title.
 */
export function PageHeader({ title, sub, actions, back, tabs, lead }: {
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
  back?: { to: string; label: string }
  tabs?: TabItem[]
  lead?: ReactNode
}) {
  return (
    <header className="-mb-1 md:-mb-2 space-y-3 md:space-y-5">
      {back && <Crumbs back={back} current={typeof title === 'string' ? title : '…'} />}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-4 min-w-0 flex-1 basis-60">
          {lead}
          <div className="min-w-0">
            <h1 className="h1 text-balance break-words max-sm:line-clamp-3">{title}</h1>
            {sub && <p className="text-muted mt-1 md:mt-2 text-sm md:text-base">{sub}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs && <TabNav items={tabs} />}
    </header>
  )
}

/** Section: title (+ action on the right), then content. Rhythm: title → content 12 px; content blocks 12 px; section → section 32 px (via Page/TwoCol). */
export function Section({ title, eyebrow, action, children, className }: { title?: ReactNode; eyebrow?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('min-w-0', className)}>
      {(title || action) && (
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 mb-3 md:mb-4 min-h-8">
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h2 className="h2 text-xl md:text-2xl">{title}</h2>
          </div>
          {action}
        </div>
      )}
      <div className="space-y-3">{children}</div>
    </section>
  )
}

/** Two equal-width columns from `lg` (exactly one column ratio in the app). */
export function TwoCol({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8 items-start">{children}</div>
}

/** Grid for key figures. */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>
}

/** Key-figure tile; `children` e.g. a Progress. */
export function Stat({ label, value, sub, children }: { label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <Card>
      <div className="meta font-semibold">{label}</div>
      <div className="text-3xl display-num num mt-1 truncate">{value}</div>
      {sub && <div className="meta mt-0.5">{sub}</div>}
      {children && <div className="mt-2.5">{children}</div>}
    </Card>
  )
}

/** Card with uniform padding (`sm` only for small tiles in grids). */
export function Card({ children, pad = 'md', className }: { children: ReactNode; pad?: 'md' | 'sm' | 'none'; className?: string }) {
  return <div className={cx('card', pad === 'md' && 'p-4 md:p-5', pad === 'sm' && 'p-3.5 md:p-4', className)}>{children}</div>
}

/** Bar above a list: search, filters (Segmented/Select/Chips). */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

// ───────────────────────────── Lists ─────────────────────────────

/** One card with dividers instead of many single cards. Without entries `empty` is shown (see EmptyState). `bare` = without frame (inside cards). */
export function List({ children, empty, bare }: { children?: ReactNode[] | ReactNode; empty?: ReactNode; bare?: boolean }) {
  const has = Array.isArray(children) ? children.flat().some(Boolean) : !!children
  if (!has) return <>{empty ?? null}</>
  return <div className={bare ? 'list-bare' : 'list'}>{children}</div>
}

/** Empty state with icon, text and optional action (its own card). */
export function EmptyState({ icon: Icon = GiftIcon, children, action }: { icon?: LucideIcon; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="card py-8 md:py-10 px-5 md:px-6 text-center flex flex-col items-center gap-3">
      <span className="grid place-items-center size-10 rounded-full bg-hover text-muted"><Icon size={18} strokeWidth={1.75} /></span>
      <p className="text-sm text-muted max-w-sm text-balance">{children}</p>
      {action}
    </div>
  )
}

/** Link inside a Row meta line (sits above the row click area). */
export function RowLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="row-above hit hover:text-accent">{children}</Link>
}

/**
 * List row: `lead` (avatar/thumb/icon, 44 px; 32 px with `dense`) · title + `meta` · `trailing` (amount/badge, right-aligned)
 * · `actions` (always visible; on phones in a second line) · `below` (expanded details).
 * `to` or `onClick` make the whole row clickable (the title is the real link/button).
 */
export function Row({ lead, title, titleSuffix, meta, extra, trailing, actions, below, to, onClick, dim, strike, dense, expanded }: {
  lead?: ReactNode
  title: ReactNode
  /** Inline after the title (stars, link icon) */
  titleSuffix?: ReactNode
  /** Second line, truncated to one line */
  meta?: ReactNode
  /** Further line without truncation (e.g. cost split) */
  extra?: ReactNode
  trailing?: ReactNode
  actions?: ReactNode
  below?: ReactNode
  to?: string
  onClick?: () => void
  /** Done/past: dimmed (text contrast stays ≥ 4.5:1) */
  dim?: boolean
  strike?: boolean
  dense?: boolean
  /** For expandable rows (aria-expanded) */
  expanded?: boolean
}) {
  const interactive = !!(to || onClick)
  // Narrow rows (phone, half column; container query on .row): the title gets the full width (2-3 lines), suffix/meta wrap
  // instead of squeezing the title, trailing and actions go on their own lines below the text.
  const tcls = cx('font-medium text-left block max-w-full @max-[34rem]:line-clamp-3 @min-[34rem]:truncate', dim && 'text-muted', strike && 'line-through', interactive && 'row-stretch hover:text-accent cursor-pointer')
  const titleEl = to
    ? <Link to={to} className={tcls}>{title}</Link>
    : onClick
      ? <button type="button" className={tcls} onClick={onClick} aria-expanded={expanded}>{title}</button>
      : <div className={tcls}>{title}</div>
  const indent = lead ? (dense ? 'pl-11' : 'pl-14') : ''
  const narrowIndent = lead ? (dense ? '@max-[34rem]:pl-11' : '@max-[34rem]:pl-14') : ''
  return (
    <div className={cx('row', dense && 'row-dense', interactive && 'row-interactive')}>
      {lead && <div className={cx('shrink-0', dim && 'opacity-60')}>{lead}</div>}
      <div className="min-w-[9ch] flex-1">
        <div className="flex items-center gap-x-2 gap-y-0.5 min-w-0 @max-[34rem]:flex-wrap">
          <div className="min-w-0 max-w-full @max-[34rem]:min-w-[9ch]">{titleEl}</div>
          {titleSuffix && <span className="row-above shrink-0 flex flex-wrap items-center gap-2 max-w-full">{titleSuffix}</span>}
        </div>
        {meta && <div className="meta @min-[34rem]:truncate @max-[34rem]:line-clamp-2 mt-0.5">{meta}</div>}
        {extra && <div className="meta mt-0.5">{extra}</div>}
      </div>
      {trailing && <div className={cx('shrink-0 min-w-24 flex flex-col items-end gap-1 text-right text-sm', '@max-[34rem]:basis-full @max-[34rem]:min-w-0 @max-[34rem]:shrink @max-[34rem]:flex-row @max-[34rem]:flex-wrap @max-[34rem]:items-center @max-[34rem]:justify-between @max-[34rem]:gap-x-3 @max-[34rem]:text-left', narrowIndent)}>{trailing}</div>}
      {actions && <div className="row-above flex items-center gap-1 shrink-0 @max-[34rem]:basis-full @max-[34rem]:shrink @max-[34rem]:flex-wrap @max-[34rem]:gap-2">{actions}</div>}
      {below && <div className={cx('row-above basis-full', indent)}>{below}</div>}
    </div>
  )
}

/** Table for numeric overviews: first column left, the rest right-aligned; `foot` = totals row. */
export function DataTable({ columns, rows, foot, empty }: {
  columns: string[]
  rows: { key: string; cells: ReactNode[] }[]
  foot?: ReactNode[]
  empty?: ReactNode
}) {
  const align = (i: number) => (i === 0 ? 'text-left' : 'text-right')
  return (
    <ScrollFade className="card">
      <table className="w-full text-sm num">
        <thead>
          <tr className="meta border-b border-line">
            {columns.map((c, i) => <th key={c} scope="col" className={cx('font-medium px-4 py-2.5', align(i))}>{c}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.key}>{r.cells.map((c, i) => <td key={i} className={cx('px-4 py-2.5', align(i))}>{c}</td>)}</tr>
          ))}
          {!rows.length && <tr><td colSpan={columns.length} className="px-4 py-4 text-center text-muted">{empty ?? t('controls.ui.noData')}</td></tr>}
        </tbody>
        {foot && (
          <tfoot>
            <tr className="font-semibold border-t border-line">{foot.map((c, i) => <td key={i} className={cx('px-4 py-2.5', align(i))}>{c}</td>)}</tr>
          </tfoot>
        )}
      </table>
    </ScrollFade>
  )
}

// ───────────────────────────── Inputs ─────────────────────────────

/** Labeled field. `group` = div instead of label (for chip/segmented groups). `error` shows a FormError. */
export function Field({ label, hint, error, children, className = '', group }: { label: string; hint?: string; error?: ReactNode; children: ReactNode; className?: string; group?: boolean }) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag className={cx('block', className)} {...(group ? { role: 'group', 'aria-label': label } : {})}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block meta mt-1.5">{hint}</span>}
      <FormError>{error}</FormError>
    </Tag>
  )
}

/** Text input with an icon on the left (search, quick capture). */
export function SearchField({ icon: Icon = Search, className, ...rest }: { icon?: LucideIcon } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className={cx('relative block', className)}>
      <Icon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
      <input type="search" enterKeyHint="search" autoComplete="off" {...rest} className="input !pl-9" />
    </span>
  )
}

/** Single choice for at most 4 short options; otherwise Select. */
export function Segmented<T extends string | number>({ value, onChange, options, label, className }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; icon?: LucideIcon }[]
  label: string
  className?: string
}) {
  const move = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const n = options[(i + d + options.length) % options.length]
    onChange(n.value)
    ;(e.currentTarget.parentElement?.children[(i + d + options.length) % options.length] as HTMLElement | undefined)?.focus()
  }
  return (
    <div role="radiogroup" aria-label={label} className={cx('seg', className)}>
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button key={String(o.value)} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={cx('seg-item', on && 'seg-item-on')} onClick={() => onChange(o.value)} onKeyDown={(e) => move(e, i)}>
            {o.icon && <o.icon size={14} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Toggleable filter/selection chip (multi-select). */
export function Chip({ on, onClick, children, className, title }: { on?: boolean; onClick?: () => void; children: ReactNode; className?: string; title?: string }) {
  return (
    <button type="button" className={cx('chip', on && 'chip-on', className)} aria-pressed={on} title={title} onClick={onClick}>
      {children}
    </button>
  )
}

// ───────────────────────────── Overlays ─────────────────────────────

const modalStack: symbol[] = []
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Dialog. Phones: bottom sheet with the height of its content (up to the visible height, scrolls inside beyond that); from `sm`
 * centered. Escape and hardware/browser Back close only the topmost dialog, Tab stays inside the dialog, focus is restored, the page
 * behind does not scroll (also on iOS), safe areas are respected and the size follows the on-screen keyboard (visualViewport).
 * `compact` = small, centered notice dialog. Autofocus: `[data-autofocus]`, otherwise the first editable field - not on touch devices.
 */
export function Modal({ title, onClose, children, footer, compact }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useBackLayer(() => closeRef.current())
  useEffect(() => {
    const id = Symbol('modal')
    modalStack.push(id)
    const el = ref.current!
    const prev = document.activeElement as HTMLElement | null
    if (!el.contains(document.activeElement)) {
      const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? (isCoarse() ? null : el.querySelector<HTMLElement>('input:not([readonly]):not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea:not([readonly]),select'))
      ;(target ?? el).focus({ preventScroll: true })
    }
    const root = document.documentElement
    const wasLocked = root.classList.contains('scroll-locked')
    const prevOverflow = document.body.style.overflow
    root.classList.add('scroll-locked')
    document.body.style.overflow = 'hidden'
    const untrack = trackViewport()
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return
      if (e.key === 'Escape') return closeRef.current()
      if (e.key !== 'Tab') return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null)
      if (!items.length) return e.preventDefault()
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      modalStack.splice(modalStack.indexOf(id), 1)
      untrack()
      if (!modalStack.length) {
        if (!wasLocked) root.classList.remove('scroll-locked')
        document.body.style.overflow = prevOverflow
      }
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true })
    }
  }, [])
  return (
    <div
      className={cx('fixed inset-x-0 z-50 bg-scrim backdrop-blur-[2px] flex justify-center overscroll-contain touch-none pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]', compact ? 'items-center p-4' : 'items-end sm:items-center sm:p-6')}
      style={{ top: 'var(--vvt, 0px)', height: 'var(--vvh, 100dvh)' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('bg-card shadow-pop w-full flex flex-col outline-none', compact
          ? 'sm:max-w-sm max-h-full rounded-[28px]'
          : 'sm:max-w-xl max-h-[calc(100%-env(safe-area-inset-top))] sm:max-h-[min(100%,820px)] rounded-t-[28px] sm:rounded-[28px]')}
      >
        <div className="flex items-start justify-between gap-3 pl-5 pr-3 py-2 min-h-14 shrink-0 border-b border-line">
          <h2 className="h2 line-clamp-2 break-words self-center py-1">{title}</h2>
          <IconButton icon={X} label={t('controls.ui.close')} className="shrink-0 mt-0.5" onClick={onClose} />
        </div>
        <div className="p-5 space-y-4 overflow-y-auto overscroll-contain touch-pan-y flex-1 min-h-0">{children}</div>
        {footer && <div className="flex flex-nowrap items-center gap-2 px-5 py-3 shrink-0 border-t border-line sm:rounded-b-[28px] pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  )
}

export interface ConfirmOptions {
  title: string
  text?: ReactNode
  confirmLabel?: string
  /** `null` = plain notice dialog with a single button (replacement for alert) */
  cancelLabel?: string | null
  destructive?: boolean
}

/** Confirmation dialog (controlled). Usually used via `useConfirm()`. */
export function ConfirmDialog({ title, text, confirmLabel, cancelLabel, destructive, onConfirm, onCancel }: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const t = useT()
  return (
    <Modal
      compact
      title={title}
      onClose={onCancel}
      footer={
        <>
          <span className="flex-1" />
          {cancelLabel !== null && <Button data-autofocus={destructive ? '' : undefined} onClick={onCancel}>{cancelLabel ?? t('common.cancel')}</Button>}
          <Button variant={destructive ? 'destructive' : 'primary'} data-autofocus={destructive ? undefined : ''} onClick={onConfirm}>{confirmLabel ?? t('controls.ui.ok')}</Button>
        </>
      }
    >
      {text && <p className="text-sm text-muted">{text}</p>}
    </Modal>
  )
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>
const ConfirmCtx = createContext<ConfirmFn>(() => Promise.resolve(false))

/** `const confirm = useConfirm(); if (await confirm({ title: '…', destructive: true })) ...` - replaces window.confirm/alert. */
export const useConfirm = () => useContext(ConfirmCtx)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ o: ConfirmOptions; done: (v: boolean) => void } | null>(null)
  const ask = useCallback<ConfirmFn>((o) => new Promise((resolve) => setReq({ o, done: resolve })), [])
  const finish = (v: boolean) => {
    req?.done(v)
    setReq(null)
  }
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {req && <ConfirmDialog {...req.o} onConfirm={() => finish(true)} onCancel={() => finish(false)} />}
    </ConfirmCtx.Provider>
  )
}

// ───────────────────────────── Toast & copy field ─────────────────────────────

type ToastTone = 'ok' | 'bad' | 'info'
type ToastFn = (message: string, tone?: ToastTone) => void
const ToastCtx = createContext<ToastFn>(() => {})

/** `const toast = useToast(); toast('Saved', 'ok')` - transient feedback (errors: `toast(msg, 'bad')`). */
export const useToast = () => useContext(ToastCtx)

const TOAST_ICON = { ok: CircleCheck, bad: CircleAlert, info: CircleCheck } as const
const TOAST_TONE = { ok: 'text-ok', bad: 'text-bad', info: 'text-info' } as const

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const [toasts, setToasts] = useState<{ id: number; message: string; tone: ToastTone }[]>([])
  const seq = useRef(0)
  const dismiss = useCallback((id: number) => setToasts((l) => l.filter((x) => x.id !== id)), [])
  const toast = useCallback<ToastFn>((message, tone = 'info') => {
    const id = ++seq.current
    setToasts((l) => [...l.slice(-2), { id, message, tone }])
    window.setTimeout(() => dismiss(id), tone === 'bad' ? 7000 : 3500)
  }, [dismiss])
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="fixed z-[60] left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-6 flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map((item) => {
          const Icon = TOAST_ICON[item.tone]
          return (
            <div key={item.id} role={item.tone === 'bad' ? 'alert' : 'status'} className="pointer-events-auto pop !overflow-visible flex flex-row items-start gap-2.5 px-4 py-3 text-sm max-w-md">
              <Icon size={16} className={cx('shrink-0 mt-0.5', TOAST_TONE[item.tone])} />
              <span className="min-w-0 break-words">{item.message}</span>
              <IconButton icon={X} size="sm" label={t('controls.ui.close')} className="-my-1.5 -mr-2.5" onClick={() => dismiss(item.id)} />
            </div>
          )
        })}
      </div>
    </ToastCtx.Provider>
  )
}

/** Read-only field (link, redirect URI ...) with a copy button. */
export function CopyField({ value, label, hint, primary }: { value: string; label: string; hint?: string; primary?: boolean }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      ref.current?.select()
      document.execCommand('copy')
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Field label={label} hint={hint} group>
      <div className="flex flex-wrap gap-2">
        <input ref={ref} readOnly aria-label={label} className="input flex-1 min-w-0 max-sm:basis-full" value={value} onFocus={(e) => e.currentTarget.select()} />
        <Button icon={copied ? Check : Copy} variant={primary ? 'primary' : undefined} className="max-sm:w-full" onClick={copy}>{copied ? t('controls.ui.copied') : t('controls.ui.copy')}</Button>
      </div>
    </Field>
  )
}

/** Centered card for sign-in, invitation and other pages without navigation. `brand` = app name in the header. */
export function CenteredCard({ brand, title, sub, children, footer }: { brand: string; title: string; sub?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="min-h-dvh grid place-items-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <Brand name={brand} center large />
        <div className="card p-6 space-y-5">
          <div>
            <h1 className="h1 text-balance">{title}</h1>
            {sub && <p className="text-muted mt-1 text-sm">{sub}</p>}
          </div>
          {children}
        </div>
        {footer && <div className="text-center text-sm text-muted space-y-1">{footer}</div>}
      </div>
    </div>
  )
}

/** Logo tile with app name (top bar, sign-in, public pages). */
export function Brand({ name, center, large }: { name: string; center?: boolean; large?: boolean }) {
  return (
    <div className={cx('flex items-center gap-2.5 min-w-0', center && 'justify-center')}>
      <span className={cx('grid place-items-center shrink-0 rounded-[14px] bg-accent text-accent-ink', 'size-9 sm:size-10')}><GiftIcon size={22} strokeWidth={2} /></span>
      <span className={cx('font-display font-bold tracking-[-0.01em] truncate', large ? 'text-xl' : 'text-xl max-sm:hidden')}>{name}</span>
    </div>
  )
}

/** Popover menu (same surface as selection lists): arrow keys/Home/End, Escape and outside click close it, focus returns to the trigger. */
export function Menu({ trigger, children, align = 'right', width = 288 }: {
  trigger: (p: { onClick: () => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus) anchor.current?.querySelector<HTMLElement>('button,a')?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (!open) return
    if (isCoarse()) return // touch: no focus ring on the first entry
    const raf = requestAnimationFrame(() => pop.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(raf)
  }, [open])
  const onKey = (e: KeyboardEvent) => {
    const items = [...(pop.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus() }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else if (e.key === 'Tab') close(false)
  }
  return (
    <div ref={anchor} className="relative">
      {trigger({ onClick: () => setOpen(!open), 'aria-haspopup': 'menu', 'aria-expanded': open })}
      {open && (
        <Popover anchor={anchor} menu sheet popRef={pop} width={width} align={align === 'right' ? 'end' : 'start'} maxH={560} onClose={(r) => close(r !== 'outside')}>
          <div role="menu" className="flex flex-col gap-0.5 [.pop-sheet_&]:p-2 [.pop-sheet_&]:overflow-y-auto" onKeyDown={onKey}>{children(() => close(false))}</div>
        </Popover>
      )}
    </div>
  )
}

/** Menu entry: link (`to`) or action; `tint` colors the icon circle (--t1...--t5); `selected` marks the current value. */
export function MenuItem({ icon: Icon, label, to, onClick, tint = 1, danger, hint, selected }: { icon?: LucideIcon; label: string; to?: string; onClick?: () => void; tint?: number; danger?: boolean; hint?: string; selected?: boolean }) {
  const inner = (
    <>
      {Icon && <span className="size-8 rounded-full grid place-items-center shrink-0" style={{ background: `var(--t${tint})` }}><Icon size={17} strokeWidth={2} /></span>}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="meta">{hint}</span>}
      {selected && <Check size={16} className="text-accent shrink-0" aria-hidden />}
    </>
  )
  const cls = cx('menu-item', danger && 'text-bad', selected && 'font-semibold')
  if (to) return <Link role="menuitem" to={to} className={cls} onClick={onClick}>{inner}</Link>
  return <button type="button" role={selected !== undefined ? 'menuitemradio' : 'menuitem'} aria-checked={selected} className={cls} onClick={onClick}>{inner}</button>
}

export * from './controls'
