import { useCallback, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { t } from './i18n'

/** "system" follows the operating system (prefers-color-scheme), "light"/"dark" force the theme. */
export type ThemeMode = 'system' | 'light' | 'dark'

/** Options with labels in the current language */
export const themeModes = (): { value: ThemeMode; label: string }[] => [
  { value: 'system', label: t('common.theme.system') },
  { value: 'light', label: t('common.theme.light') },
  { value: 'dark', label: t('common.theme.dark') },
]

const KEY = 'theme'
const listeners = new Set<(m: ThemeMode) => void>()

const valid = (v: unknown): v is ThemeMode => v === 'system' || v === 'light' || v === 'dark'

export function getTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    if (valid(v)) return v
  } catch { /* storage blocked */ }
  return 'system'
}

/** Sets data-theme on <html>; for "system" the attribute is removed and the CSS media query applies. */
export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.querySelector('meta[name="theme-color"][data-dynamic]')?.setAttribute('content', dark ? '#1b1715' : '#fbf6f0')
}

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
const resolvedDark = (mode: ThemeMode) => mode === 'dark' || (mode === 'system' && prefersDark())

/** Center of the most recently used button – origin of the circle on theme switch */
let origin: { x: number; y: number } | null = null
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest?.('button,a,[role="radio"],[role="menuitem"],[role="menuitemradio"],label')
    if (el) {
      const r = el.getBoundingClientRect()
      origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    } else origin = { x: e.clientX, y: e.clientY }
  }, true)
}

function commit(mode: ThemeMode) {
  try { localStorage.setItem(KEY, mode) } catch { /* storage blocked */ }
  applyTheme(mode)
  listeners.forEach((l) => l(mode))
}

/**
 * Stores and applies the theme (the inline script in index.html sets it before first paint). If the resolved color scheme changes,
 * the new one grows as a circle from the center of the clicked button across the page (View Transitions, ~450 ms); otherwise – when
 * unsupported, `prefers-reduced-motion` or an identical result (e.g. System → Light on a light system) – instantly.
 */
export function setTheme(mode: ThemeMode) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } }
  const root = document.documentElement
  const wasDark = root.getAttribute('data-theme') ? root.getAttribute('data-theme') === 'dark' : prefersDark()
  if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches || wasDark === resolvedDark(mode)) return commit(mode)
  const x = origin?.x ?? window.innerWidth / 2
  const y = origin?.y ?? window.innerHeight / 2
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
  root.classList.add('theme-switching')
  const t = doc.startViewTransition(() => flushSync(() => commit(mode)))
  t.ready
    .then(() => root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 450, easing: 'ease-out', pseudoElement: '::view-transition-new(root)' },
    ))
    .catch(() => {})
  t.finished.catch(() => {}).finally(() => root.classList.remove('theme-switching'))
}

/** `[mode, setMode, next]` – `next()` cycles System → Light → Dark. */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(getTheme)
  useEffect(() => {
    listeners.add(setMode)
    return () => void listeners.delete(setMode)
  }, [])
  // For "System", keep the browser color value (theme-color) in sync
  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const h = () => applyTheme('system')
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [mode])
  const next = useCallback(() => setTheme(mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system'), [mode])
  return [mode, setTheme, next] as const
}
