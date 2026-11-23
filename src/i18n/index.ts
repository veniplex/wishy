/**
 * i18n (de + en). See README.md in this folder.
 *
 *   t('nav.top.new')                              – text of a namespace (`<namespace>.<key>`), keys are type-checked
 *   t('common.rel.inDays', { count: 3 })          – plurals via `_one` / `_other` suffixes (Intl.PluralRules)
 *   const t = useT()                              – like t(), re-renders the component on locale change
 *   useLocale() / setLocale('en')                 – read / choose the current locale (remembered)
 *   fmtDate / fmtDateShort / fmtDateTime / fmtMoney / fmtNumber / fmtIntl / relative – locale-dependent formats
 *
 * Locale resolution: user setting (me.user.locale) → remembered choice (localStorage) → browser language →
 * admin default (providers.default_locale) → 'en'. A locale change updates <html lang>.
 */
import { useSyncExternalStore } from 'react'
import deCommon from './locales/de/common'
import deNav from './locales/de/nav'
import deSettings from './locales/de/settings'
import deAccount from './locales/de/account'
import deAdmin from './locales/de/admin'
import deAuth from './locales/de/auth'
import deSecurity from './locales/de/security'
import enSecurity from './locales/en/security'
import deAdminAuth from './locales/de/adminAuth'
import enAdminAuth from './locales/en/adminAuth'
import deAdminGeneral from './locales/de/adminGeneral'
import enAdminGeneral from './locales/en/adminGeneral'
import deAdminUsers from './locales/de/adminUsers'
import enAdminUsers from './locales/en/adminUsers'
import deErrors from './locales/de/errors'
import deControls from './locales/de/controls'
import deStart from './locales/de/start'
import enStart from './locales/en/start'
import deGive from './locales/de/give'
import enGive from './locales/en/give'
import deCalendar from './locales/de/calendar'
import enCalendar from './locales/en/calendar'
import deGifts from './locales/de/gifts'
import enGifts from './locales/en/gifts'
import deFinance from './locales/de/finance'
import enFinance from './locales/en/finance'
import deStatus from './locales/de/status'
import enStatus from './locales/en/status'
import deSpaces from './locales/de/spaces'
import deAi from './locales/de/ai'
import deWishlists from './locales/de/wishlists'
import deForms from './locales/de/forms'
import deAudit from './locales/de/audit'
import enAudit from './locales/en/audit'
import deApiKeys from './locales/de/apiKeys'
import enApiKeys from './locales/en/apiKeys'
import deApiDocs from './locales/de/apiDocs'
import enApiDocs from './locales/en/apiDocs'
import deAiPrompts from './locales/de/aiPrompts'
import enAiPrompts from './locales/en/aiPrompts'
import deAiUsage from './locales/de/aiUsage'
import enAiUsage from './locales/en/aiUsage'
import deInbox from './locales/de/inbox'
import enInbox from './locales/en/inbox'
import deAdminSystem from './locales/de/adminSystem'
import enAdminSystem from './locales/en/adminSystem'
import deBackup from './locales/de/backup'
import enBackup from './locales/en/backup'
import deUpdate from './locales/de/update'
import enUpdate from './locales/en/update'
import deMaintenance from './locales/de/maintenance'
import enMaintenance from './locales/en/maintenance'
import deOffline from './locales/de/offline'
import enOffline from './locales/en/offline'
import enCommon from './locales/en/common'
import enNav from './locales/en/nav'
import enSettings from './locales/en/settings'
import enAccount from './locales/en/account'
import enAdmin from './locales/en/admin'
import enAuth from './locales/en/auth'
import enErrors from './locales/en/errors'
import enControls from './locales/en/controls'
import enSpaces from './locales/en/spaces'
import enAi from './locales/en/ai'
import enWishlists from './locales/en/wishlists'
import enForms from './locales/en/forms'

export type Locale = 'de' | 'en'
export const LOCALES: { value: Locale; label: string }[] = [
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
]
const isLocale = (v: unknown): v is Locale => v === 'de' || v === 'en'

// ───────────── Catalog ─────────────
// New namespace: create de/<ns>.ts + en/<ns>.ts and add one line each here (de is the source of truth).
const de = { common: deCommon, nav: deNav, settings: deSettings, account: deAccount, admin: deAdmin, auth: deAuth, security: deSecurity, adminAuth: deAdminAuth, adminGeneral: deAdminGeneral, adminUsers: deAdminUsers, errors: deErrors, controls: deControls, start: deStart, give: deGive, calendar: deCalendar, gifts: deGifts, finance: deFinance, status: deStatus, spaces: deSpaces, ai: deAi, wishlists: deWishlists, forms: deForms, audit: deAudit, apiKeys: deApiKeys, apiDocs: deApiDocs, aiUsage: deAiUsage, aiPrompts: deAiPrompts, inbox: deInbox, adminSystem: deAdminSystem, backup: deBackup, update: deUpdate, maintenance: deMaintenance, offline: deOffline }
type Messages = typeof de
const en: { [N in keyof Messages]: Record<keyof Messages[N], string> } = { common: enCommon, nav: enNav, settings: enSettings, account: enAccount, admin: enAdmin, auth: enAuth, security: enSecurity, adminAuth: enAdminAuth, adminGeneral: enAdminGeneral, adminUsers: enAdminUsers, errors: enErrors, controls: enControls, start: enStart, give: enGive, calendar: enCalendar, gifts: enGifts, finance: enFinance, status: enStatus, spaces: enSpaces, ai: enAi, wishlists: enWishlists, forms: enForms, audit: enAudit, apiKeys: enApiKeys, apiDocs: enApiDocs, aiUsage: enAiUsage, aiPrompts: enAiPrompts, inbox: enInbox, adminSystem: enAdminSystem, backup: enBackup, update: enUpdate, maintenance: enMaintenance, offline: enOffline }
const CATALOG: Record<Locale, Record<string, Record<string, string>>> = { de, en }

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'
type BaseKey<K> = K extends `${infer B}_${PluralSuffix}` ? B : K
/** All valid keys `namespace.key` (plural variants appear as the base key) */
export type TKey = { [N in keyof Messages & string]: `${N}.${BaseKey<keyof Messages[N] & string>}` }[keyof Messages & string]
export type TParams = Record<string, string | number>

// ───────────── Locale ─────────────
const STORE_KEY = 'locale'
const src: { user: Locale | null; server: Locale | null } = { user: null, server: null }
const listeners = new Set<() => void>()
let rulesCache: Intl.PluralRules | null = null

const readStored = (): Locale | null => {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return isLocale(v) ? v : null
  } catch {
    return null
  }
}
const fromBrowser = (): Locale | null => {
  const langs = typeof navigator === 'undefined' ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language])
  for (const l of langs) {
    const code = String(l).slice(0, 2).toLowerCase()
    if (isLocale(code)) return code
  }
  return null
}
const resolve = (): Locale => src.user ?? readStored() ?? fromBrowser() ?? src.server ?? 'en'

let current: Locale = resolve()
const sync = () => {
  const next = resolve()
  if (typeof document !== 'undefined') document.documentElement.lang = next
  if (next === current) return
  current = next
  rulesCache = null
  listeners.forEach((l) => l())
}
if (typeof document !== 'undefined') document.documentElement.lang = current

export const getLocale = () => current
/** Own choice (appearance, login page): remembered in the browser and overrides browser and admin defaults */
export function setLocale(l: Locale) {
  try { localStorage.setItem(STORE_KEY, l) } catch { /* storage blocked */ }
  src.user = l
  sync()
}
/** Saved user setting from the server (me.user.locale); null = none */
export function setUserLocale(l: string | null | undefined) {
  src.user = isLocale(l) ? l : null
  sync()
}
/** Admin default (providers.default_locale) */
export function setServerLocale(l: string | null | undefined) {
  src.server = isLocale(l) ? l : null
  sync()
}
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
export const useLocale = (): Locale => useSyncExternalStore(subscribe, getLocale, getLocale)

// ───────────── Translating ─────────────
const rules = () => (rulesCache ??= new Intl.PluralRules(current))

function lookup(ns: string, key: string, count: number | undefined): string | undefined {
  for (const l of current === 'de' ? (['de'] as const) : ([current, 'de'] as const)) {
    const dict = CATALOG[l][ns]
    if (!dict) continue
    if (count !== undefined) {
      const forms = [count === 0 ? `${key}_zero` : '', `${key}_${rules().select(count)}`, `${key}_other`]
      const hit = forms.find((k) => k && dict[k] !== undefined)
      if (hit) return dict[hit]
    }
    if (dict[key] !== undefined) return dict[key]
  }
  return undefined
}

// The product name in the texts follows the "App name" setting (Admin › General): "Wishy" is replaced when translating.
let appName = 'Wishy'
export function setAppName(n: string | null | undefined) {
  appName = n?.trim() || 'Wishy'
}
const brand = (s: string) => (appName === 'Wishy' ? s : s.replace(/Wishy/g, () => appName))

export function t(key: TKey, params?: TParams): string {
  const dot = key.indexOf('.')
  const count = typeof params?.count === 'number' ? params.count : undefined
  const msg = lookup(key.slice(0, dot), key.slice(dot + 1), count)
  if (msg === undefined) return key
  if (!params) return brand(msg)
  return brand(msg).replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? (typeof params[k] === 'number' ? fmtNumber(params[k] as number) : String(params[k])) : m))
}
/** Like `t`, but the component re-renders on locale change */
export function useT() {
  useLocale()
  return t
}

// ───────────── Formats ─────────────
const INTL: Record<Locale, string> = { de: 'de-DE', en: 'en-GB' }
export const intlLocale = () => INTL[current]

const parseIso = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}
/** "3. März 2026" / "3 March 2026" (date `YYYY-MM-DD`) */
export const fmtDate = (s: string, withYear = true) =>
  parseIso(s).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}) })
/** "Di., 03.03.2026" */
export const fmtDateShort = (s: string) =>
  parseIso(s).toLocaleDateString(intlLocale(), { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
/** Timestamp from the server (`YYYY-MM-DD HH:MM:SS` in UTC or ISO) with time of day */
export const fmtDateTime = (s: string) =>
  new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
/** Any date format in the current locale */
export const fmtIntl = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString(intlLocale(), opts)
export const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString(intlLocale(), opts)

const moneyCache = new Map<string, Intl.NumberFormat>()
/** Amount with currency (at most 2, at least 0 decimal places); unknown currency → number + code */
export function fmtMoney(n: number | null | undefined, currency = 'EUR'): string {
  if (n == null) return '–'
  const k = `${current}|${currency}`
  let f = moneyCache.get(k)
  if (!f) {
    try {
      f = new Intl.NumberFormat(intlLocale(), { style: 'currency', currency, maximumFractionDigits: 2, minimumFractionDigits: 0 })
    } catch {
      return `${fmtNumber(n, { maximumFractionDigits: 2 })} (${currency})`
    }
    moneyCache.set(k, f)
  }
  return f.format(n)
}

/** Distance in days (negative = past) as text: "today", "tomorrow", "in 5 days", "in 3 months" */
export function relative(days: number): string {
  if (days === 0) return t('common.rel.today')
  if (days === 1) return t('common.rel.tomorrow')
  if (days === -1) return t('common.rel.yesterday')
  if (days < 0) return t('common.rel.daysAgo', { count: -days })
  if (days < 60) return t('common.rel.inDays', { count: days })
  if (days < 365) return t('common.rel.inMonths', { count: Math.round(days / 30.4) })
  return t('common.rel.inYears', { count: Math.round(days / 365) })
}

const monthCache = new Map<string, string[]>()
/** Month names (0 = January), `long` or `short` */
export function monthNames(style: 'long' | 'short'): string[] {
  const k = `${current}|${style}`
  let v = monthCache.get(k)
  if (!v) {
    const f = new Intl.DateTimeFormat(intlLocale(), { month: style })
    v = Array.from({ length: 12 }, (_, i) => f.format(new Date(2024, i, 1)))
    monthCache.set(k, v)
  }
  return v
}

/** Short weekday names, Monday first */
export const weekdaysShort = (): string[] => (current === 'de' ? ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'])
