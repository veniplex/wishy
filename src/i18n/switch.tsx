import { Languages } from 'lucide-react'
import { api, type Me } from '../api'
import { useAuth } from '../auth'
import { Menu, MenuItem, Segmented } from '../ui'
import { LOCALES, setLocale, t, useLocale, type Locale } from './index'

/** Choose the language: remember it locally and, when signed in, save it to the account (the server ignores the field until it knows it). */
export function useChangeLocale() {
  const { status, applyMe } = useAuth()
  return async (l: Locale) => {
    setLocale(l)
    if (status !== 'ready') return
    try {
      applyMe(await api<Me>('PUT', '/api/account', { locale: l }))
    } catch { /* stays saved locally */ }
  }
}

/** Settings › Appearance */
export function LanguageSegmented() {
  const locale = useLocale()
  const change = useChangeLocale()
  return <Segmented label={t('settings.appearance.language.field')} value={locale} onChange={(l) => void change(l)} options={LOCALES} />
}

/** Small language switcher for the sign-in and public pages */
export function LanguageMenu() {
  const locale = useLocale()
  const change = useChangeLocale()
  return (
    <Menu width={180} trigger={(p) => (
      <button type="button" {...p} className="pill !min-h-9 pointer-coarse:!min-h-11 !px-3 uppercase" aria-label={t('auth.language.aria')} title={t('auth.language.aria')}>
        <Languages size={16} aria-hidden /> {locale}
      </button>
    )}>
      {(close) => LOCALES.map((l) => <MenuItem key={l.value} label={l.label} selected={l.value === locale} onClick={() => { close(); void change(l.value) }} />)}
    </Menu>
  )
}
