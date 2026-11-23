// Member permissions per space. The owner always has all of them; members carry a stored set (JSON in
// space_members.permissions) that starts as a copy of the space's default (spaces.default_permissions) when they join.
import { bad, forbidden } from './util.js'

/** Permission keys with the default every member gets (= what a member could do before permissions existed). */
export const PERMISSION_DEFAULTS = {
  /** Create invite links for the space (owner-only before permissions existed, hence off by default) */
  invite_members: false,
  /** Share own wishlists with the whole space */
  share_wishlists: true,
  /** Create, edit, link and delete persons */
  manage_persons: true,
  /** Create, edit and delete occasions and the occasion types of the space */
  manage_occasions: true,
  /** Gift ideas, gifts, payments and settlements */
  manage_gifts: true,
  /** See and export prices, payments, shares and budgets (expenses overview) */
  view_expenses: true,
  /** Space settings (currency), demo data */
  manage_space_settings: true,
}
export const PERMISSIONS = Object.keys(PERMISSION_DEFAULTS)
const ALL_ON = Object.fromEntries(PERMISSIONS.map((k) => [k, true]))

const parse = (json) => {
  try {
    const o = JSON.parse(json || '{}')
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

/** Effective permissions of a member (stored JSON merged over the defaults); the owner has everything. */
export function resolvePermissions(role, json) {
  if (role === 'owner') return { ...ALL_ON }
  const stored = parse(json)
  return Object.fromEntries(PERMISSIONS.map((k) => [k, typeof stored[k] === 'boolean' ? stored[k] : PERMISSION_DEFAULTS[k]]))
}

/** Validates a (partial) permission object from a request; unknown keys or non-boolean values -> 400. */
export function cleanPermissions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Invalid permissions', 'permissions_invalid')
  const out = {}
  for (const [k, v] of Object.entries(input)) {
    if (!PERMISSIONS.includes(k) || typeof v !== 'boolean') throw bad('Invalid permissions', 'permissions_invalid')
    out[k] = v
  }
  return out
}

/** 403 permission_denied (with the permission as parameter) unless ctx (from spaceCtx) holds the permission. */
export function requirePermission(ctx, permission) {
  if (!ctx.permissions?.[permission]) throw forbidden('You do not have permission for this', 'permission_denied', { permission })
}
