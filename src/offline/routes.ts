/** Offline-capable routes and the rewriting of temporary (negative) ids. Pure: no DOM, React or i18n. */
import type { Action, Kind, Route, Row } from './types.ts'

const KIND: Record<string, Kind> = { persons: 'person', occasions: 'occasion', items: 'item', gifts: 'gift', wishlists: 'list', wishes: 'wish' }
/** Sub routes `/<id>/<rest>` */
const SUB: { kind: Kind; method: string; re: RegExp; action: Action }[] = [
  { kind: 'occasion', method: 'PUT', re: /^persons\/(-?\d+)$/, action: 'exclude' },
  { kind: 'item', method: 'POST', re: /^assign$/, action: 'assign' },
  { kind: 'gift', method: 'POST', re: /^status$/, action: 'status' },
  { kind: 'gift', method: 'POST', re: /^payment$/, action: 'payment' },
  { kind: 'gift', method: 'POST', re: /^givers\/(-?\d+)\/settle$/, action: 'settle' },
  { kind: 'list', method: 'POST', re: /^wishes$/, action: 'create' },
  { kind: 'list', method: 'POST', re: /^reorder$/, action: 'reorder' },
]

/** The offline-capable route of a write, null for everything that needs a connection */
export function parseWrite(method: string, url: string): Route | null {
  const m = /^\/api\/(persons|occasions|items|gifts|wishlists|wishes)(?:\/(-?\d+)(?:\/(.+))?)?$/.exec(url)
  if (!m) return null
  const kind = KIND[m[1]]
  const id = m[2] === undefined ? 0 : Number(m[2])
  if (m[3] !== undefined) {
    for (const s of SUB) {
      if (s.kind !== kind || s.method !== method) continue
      const r = s.re.exec(m[3])
      if (!r) continue
      // A new wish is a create of kind "wish" in list `sub`
      if (kind === 'list' && s.action === 'create') return { kind: 'wish', action: 'create', target: 0, sub: id }
      return { kind, action: s.action, target: id, sub: r[1] === undefined ? 0 : Number(r[1]) }
    }
    return null
  }
  if (m[2] === undefined) return method === 'POST' && kind !== 'wish' ? { kind, action: 'create', target: 0, sub: 0 } : null
  if (method === 'PUT') return { kind, action: 'update', target: id, sub: 0 }
  if (method === 'DELETE') return { kind, action: 'delete', target: id, sub: 0 }
  return null
}

/** Wishlist changes belong to the user, everything else to a space */
export const isListKind = (k: Kind) => k === 'list' || k === 'wish'

// ───────────── Temporary ids ─────────────
export type IdMap = ReadonlyMap<number, number>

const ID_KEYS = new Set(['person_id', 'occasion_id', 'item_id', 'payer_id', 'from_id', 'to_id'])
const ID_ARRAYS = new Set(['person_ids', 'excluded_ids', 'recipient_ids', 'ids'])

/** Replaces known temp ids in all id fields of a body/record; returns the same object if nothing changed. */
export function resolveIds<T>(value: T, map: IdMap): T {
  if (!map.size || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((x) => {
      const y = resolveIds(x, map)
      if (y !== x) changed = true
      return y
    })
    return changed ? (out as T) : value
  }
  let out: Row | null = null
  for (const [k, v] of Object.entries(value as Row)) {
    let next = v
    if (ID_KEYS.has(k)) next = typeof v === 'number' ? (map.get(v) ?? v) : v
    else if (ID_ARRAYS.has(k) && Array.isArray(v)) next = v.some((x) => map.has(x)) ? v.map((x) => map.get(x) ?? x) : v
    else next = resolveIds(v, map)
    if (next !== v) (out ??= { ...(value as Row) })[k] = next
  }
  return (out ?? value) as T
}

const TEMP_IN_PATH = /\/(-\d+)(?=\/|\?|$)/g
export const resolveUrl = (url: string, map: IdMap) => url.replace(TEMP_IN_PATH, (m, id) => (map.has(Number(id)) ? `/${map.get(Number(id))}` : m))

/** Temp ids used by a request (path and body) */
export function tempRefs(url: string, body: unknown): Set<number> {
  const out = new Set<number>()
  for (const m of url.matchAll(TEMP_IN_PATH)) out.add(Number(m[1]))
  const add = (v: unknown) => { if (typeof v === 'number' && v < 0) out.add(v) }
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v === null || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v as Row)) {
      if (ID_KEYS.has(k)) add(x)
      else if (ID_ARRAYS.has(k) && Array.isArray(x)) x.forEach(add)
      else walk(x)
    }
  }
  walk(body)
  return out
}
