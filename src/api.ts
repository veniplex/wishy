/** Lean API client: cookie session, `X-Space` header, uniform errors. */
import { t, type TKey, type TParams } from './i18n'
import { reportMaintenance } from './maintenance-state'
import type { SpacePermissions } from './lib'

export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const SPACE_KEY = 'space'
let currentSpace: number | null = null
try {
  const v = Number(localStorage.getItem(SPACE_KEY))
  currentSpace = Number.isInteger(v) && v > 0 ? v : null
} catch { /* storage blocked */ }

export const getSpaceId = () => currentSpace
export function setSpaceId(id: number | null) {
  currentSpace = id
  try {
    if (id == null) localStorage.removeItem(SPACE_KEY)
    else localStorage.setItem(SPACE_KEY, String(id))
  } catch { /* storage blocked */ }
}

let onUnauthorized: (() => void) | null = null
export const setUnauthorizedHandler = (fn: (() => void) | null) => { onUnauthorized = fn }

const headers = (json: boolean): Record<string, string> => ({
  'X-Requested-With': 'wishlist',
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  ...(currentSpace != null ? { 'X-Space': String(currentSpace) } : {}),
})

/**
 * Error text: `errors.code.<code>` in the current locale (a known code always wins), otherwise the server's text.
 * `params` (from the server) fill the {placeholders}; `reasonCode` becomes {reason} via `errors.reason.<code>` (otherwise `detail`).
 */
export function errorText(code: unknown, serverMsg: unknown, rawParams?: unknown): string | undefined {
  if (typeof code === 'string' && /^\w+$/.test(code)) {
    const params: TParams = {}
    if (rawParams && typeof rawParams === 'object') {
      for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') params[k] = v
      }
      const rc = params.reasonCode
      if (typeof rc === 'string' && /^\w+$/.test(rc)) {
        const rk = `errors.reason.${rc}` as TKey
        const r = t(rk)
        params.reason = r !== rk ? r : String(params.detail ?? '')
      }
    }
    // permission_denied: {permission} becomes the localized name of the permission
    if (typeof params.permission === 'string' && /^w+$/.test(params.permission)) {
      const pk = `settings.space.perms.${params.permission}` as TKey
      const name = t(pk)
      params.permission = name !== pk ? name : params.permission
    }
    const key = `errors.code.${code}` as TKey
    const msg = t(key, params)
    if (msg !== key) return msg
  }
  return typeof serverMsg === 'string' && serverMsg ? serverMsg : undefined
}

/** JSON call. Throws ApiError (English message from the server); on 401 with code "auth" the login handler is triggered. */
export async function api<T = unknown>(method: string, url: string, body?: unknown, opts?: { space?: number }): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { ...headers(body !== undefined), ...(opts?.space != null ? { 'X-Space': String(opts.space) } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(t('errors.network'), 0)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && data?.code === 'auth') onUnauthorized?.()
    if (res.status === 503 && data?.code === 'maintenance') reportMaintenance(data.maintenance)
    throw new ApiError(errorText(data?.code, data?.error, data?.params) || res.statusText || t('errors.unknown'), res.status, data?.code)
  }
  return data as T
}

/** Load a file (e.g. export of the current space) with the `X-Space` header and save it as a download. */
export async function download(url: string, filename: string) {
  const res = await fetch(url, { credentials: 'same-origin', headers: headers(false) })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(errorText(data?.code, data?.error, data?.params) || t('errors.downloadFailed'), res.status, data?.code)
  }
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ───────────── Types ─────────────
export interface TwoFactorSummary { enabled: boolean; totp: boolean; passkeys: number; recovery_left: number }
export interface Identity { provider: string; linked: boolean; email: string | null; picture_available: boolean }
export interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'user'
  has_password: boolean
  google_linked: boolean
  /** Saved locale ('de' | 'en'), null = follow the installation default */
  locale: string | null
  /** Effective feature flags (global + user) */
  features: { ai: boolean; api: boolean }
  /** Profile picture URL (own or from the provider), otherwise null */
  avatar_url?: string | null
  two_factor?: TwoFactorSummary
  /** "Required" policy: set up two-factor first */
  must_setup_2fa?: boolean
  identities?: Identity[]
}
/** Display name of a space: the default name of the personal space ("Privat"/"Private") follows the locale */
export const spaceLabel = (s: { name: string; personal?: boolean }): string => (s.personal && (s.name === 'Privat' || s.name === 'Private') ? t('spaces.personalName') : s.name)
export interface SpaceInfo {
  id: number
  name: string
  personal: boolean
  role: 'owner' | 'member'
  member_count: number
  /** Effective permissions of the current user in this space */
  permissions: SpacePermissions
}
export interface Me { user: User; spaces: SpaceInfo[]; shared_unseen?: number }
export interface Providers {
  google: boolean
  registration: { enabled: boolean; mode: 'open' | 'invite' }
  app_name: string
  /** Default locale of the installation */
  default_locale?: string
}
/** Registration mode from the public provider info */
export const registrationMode = (p: Providers | null | undefined): 'open' | 'invite' | 'closed' | undefined => {
  const r = p?.registration
  return r === undefined ? undefined : r.enabled ? r.mode : 'closed'
}
/** `permissions` is only sent to the owner */
export interface Member { user_id: number; name: string; email: string; role: 'owner' | 'member'; permissions?: SpacePermissions }
export interface Wish {
  id: number
  title: string
  notes: string | null
  url: string | null
  price: number | null
  currency: string | null
  image_url: string | null
  priority: number
  status: 'open' | 'received' | 'removed'
  created_at: string
}
export interface SharedWish extends Wish {
  reserved: boolean
  reserved_by: string | null
  reserved_by_me: boolean
}
export interface MyWishlist {
  id: number
  title: string
  description: string | null
  event_date: string | null
  archived: boolean | number
  link_enabled: boolean | number
  token: string
  url: string
  full_url: string
  wish_count: number
  open_count: number
  access: { user_id: number; name: string; via: 'direct' | 'link' }[]
  /** Spaces the list is shared with (all members, including future ones) */
  spaces: { space_id: number; name: string; member_count: number }[]
  updated_at: string
}
export interface SharedSummary {
  id: number
  title: string
  description: string | null
  event_date: string | null
  owner: { id: number; name: string }
  wish_count: number
  open_count: number
  via: 'direct' | 'link' | 'space'
  /** Name of the space through which the list is visible (via = space) */
  space_name?: string | null
  is_new: boolean
  updated_at: string
}
export interface WishlistsOverview { mine: MyWishlist[]; shared: SharedSummary[] }
/** GET /api/wishlists/:id – owner or user with access */
export interface ListView {
  wishlist: MyWishlist | SharedSummary
  wishes: (Wish | SharedWish)[]
  is_owner: boolean
}
/** GET /api/shared/:token – public */
export interface PublicView {
  wishlist: { id: number; title: string; description: string | null; event_date: string | null }
  owner: { id: number; name: string }
  is_owner: boolean
  logged_in: boolean
  following: boolean
  wishes: (Wish | SharedWish)[]
}
export interface KnownUser { id: number; name: string; email: string }
export interface AdminUser {
  id: number
  name: string
  email: string
  role: 'admin' | 'user'
  disabled: boolean
  has_password: boolean
  google_linked: boolean
  created_at: string
  last_login_at: string | null
  space_count: number
  avatar_url?: string | null
  two_factor?: boolean
}
export interface AdminStats { users: number; spaces: number; items: number; gifts: number; db_size_bytes: number }

/** AI reason (`errors.reason.<code>`) in the current locale, otherwise the server's text */
export function aiReason(code: string | null | undefined, fallback: string): string {
  if (!code || !/^\w+$/.test(code)) return fallback
  const key = `errors.reason.${code}` as TKey
  const msg = t(key)
  return msg !== key ? msg : fallback
}

/** Message for `?error=` codes of the Google sign-in (in the current locale) */
export const loginError = (code: string | null) => {
  if (!code) return null
  const key = `errors.login.${code}` as TKey
  const msg = /^\w+$/.test(code) ? t(key) : key
  return msg !== key ? msg : t('errors.login.fallback')
}

// ───────────── AI ─────────────
export interface AiStatus {
  enabled: boolean
  features: { link_import: boolean; text_import: boolean; image_import: boolean; suggestions: boolean }
  provider_label: string | null
}
export interface AiProvider { id: string; label: string; default_model: string | null; model_hint: string | null; needs_base_url?: boolean }
export interface AiAdmin {
  ai_enabled: boolean
  ai_provider: string
  ai_model: string
  ai_api_key_set: boolean
  ai_base_url: string
  ai_features: AiStatus['features']
  ai_monthly_request_limit: number | null
  env_locked: string[]
  configured: boolean
  missing: string | null
  missing_code?: string | null
  providers: AiProvider[]
  requests_this_month: number
}
export interface AiUsageRow { requests: number; ok_requests: number; input_tokens: number; output_tokens: number }
export interface AiUsage {
  month: string
  total: AiUsageRow
  counted: number
  limit: number | null
  by_feature: (AiUsageRow & { feature: string })[]
  by_user: (AiUsageRow & { user_id: number | null; name: string | null })[]
  recent_errors: { created_at: string; feature: string; model: string | null; error: string }[]
}
/** Suggestion from text/image import */
export interface AiItem {
  title: string
  notes: string | null
  price: number | null
  currency: string | null
  url: string | null
  person_name?: string | null
  mentioned?: boolean
}
export interface AiSuggestion { title: string; reason: string; price_estimate: number | null; search_query: string }
