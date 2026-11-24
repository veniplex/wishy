/**
 * Which fields a queued change touches and whether it may still be sent. Pure: no DOM, React or i18n.
 *
 * A change stores only the units (fields or atomic groups) that differ from the record the user saw, with the values before (`base`) and
 * after (`mine`). Per unit, against the server's current record: server == base -> send, server == mine -> nothing to do, else conflict.
 */
import type { Conflict, FieldConflict, Kind, Op, Route, Row, ServerData, Values } from './types.ts'

/** Fields that only make sense together */
const GROUPS: Record<string, string[]> = {
  participants: ['audience', 'person_ids', 'excluded_ids'],
  payment: ['payment_status', 'payer_id', 'paid_at', 'payment_method', 'paid_amount'],
}
const keysOf = (unit: string) => GROUPS[unit] ?? [unit]
function unitOf(kind: Kind, key: string) {
  if (kind === 'occasion' && GROUPS.participants.includes(key)) return 'participants'
  if (kind === 'gift' && GROUPS.payment.includes(key)) return 'payment'
  return key
}

/** Everything a user can change on a record (deleting one that was changed meanwhile is a conflict) */
const UNITS: Record<Kind, string[]> = {
  person: ['name', 'birthday', 'emoji', 'color', 'notes', 'yearly_budget', 'archived', 'relationship', 'email'],
  occasion: ['name', 'type', 'date', 'recurring', 'budget', 'notes', 'participants'],
  item: ['person_id', 'mentioned', 'title', 'notes', 'url', 'price', 'priority', 'status', 'occasion_id', 'source', 'image_url', 'currency'],
  gift: ['title', 'notes', 'url', 'shop', 'occasion_id', 'item_id', 'price', 'status', 'date', 'image_url', 'order_number', 'carrier', 'tracking_number', 'tracking_url',
    'expected_at', 'recipient_ids', 'givers', 'payment'],
  list: ['title', 'description', 'event_date', 'archived', 'wish_count'],
  wish: ['title', 'notes', 'url', 'price', 'currency', 'image_url', 'priority', 'status'],
}

const idSet = (v: unknown) => [...new Set(Array.isArray(v) ? (v as number[]) : [])].sort((a, b) => a - b)

function normKey(key: string, v: unknown): unknown {
  if (key === 'person_ids' || key === 'excluded_ids' || key === 'recipient_ids') return idSet(v)
  if (key === 'givers') {
    return (Array.isArray(v) ? (v as Row[]) : [])
      .map((g) => ({ person_id: g.person_id, amount: g.amount === '' || g.amount == null ? null : Number(g.amount) }))
      .sort((a, b) => a.person_id - b.person_id)
  }
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') return v.trim() || null
  return v ?? null
}

/** Normalized value of a unit. `sub`: the person of exclude/settle */
function valueOf(unit: string, r: Row, sub: number): Row {
  if (unit === 'excluded') return { excluded: (r.excluded_ids ?? []).includes(sub) ? 1 : 0 }
  if (unit === 'settled') {
    const g = (r.givers ?? []).find((x: Row) => x.person_id === sub)
    return { settled: g ? (g.settled ? 1 : 0) : null }
  }
  const out: Row = Object.fromEntries(keysOf(unit).map((k) => [k, normKey(k, r[k])]))
  // With "everyone" the participants are derived, not chosen; a left out person is none
  if (unit === 'participants') out.person_ids = out.audience === 'all' ? [] : out.person_ids.filter((id: number) => !out.excluded_ids.includes(id))
  return out
}
/** Ids inside stored values may have been replaced since, so lists are sorted again before comparing */
const renorm = (v: Row): Row => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normKey(k, x)]))
const same = (a: Row, b: Row) => JSON.stringify(renorm(a)) === JSON.stringify(renorm(b))

export function findRecord(op: Pick<Route, 'kind' | 'target'>, data: ServerData): Row | null {
  const by = (rows: Row[] | undefined) => rows?.find((r) => r.id === op.target) ?? null
  const s = data.state
  switch (op.kind) {
    case 'person': return by(s?.persons)
    case 'occasion': return by(s?.occasions)
    case 'item': return by(s?.items) ?? by(s?.inbox_items)
    case 'gift': return by(s?.gifts)
    case 'list': return data.detail?.wishlist?.id === op.target ? data.detail.wishlist : null
    case 'wish': return by(data.detail?.wishes)
  }
}

/** Unit and new value of an action that is not a plain field update */
function actionUnit(route: Route, body: Row): { unit: string; now: Row } | null {
  switch (route.action) {
    case 'status': return { unit: 'status', now: { status: body.status } }
    case 'exclude': return { unit: 'excluded', now: { excluded: body.excluded ? 1 : 0 } }
    case 'settle': return { unit: 'settled', now: { settled: body.settled ? 1 : 0 } }
    case 'assign': return { unit: 'person_id', now: { person_id: body.person_id } }
    default: return null
  }
}

/** `base`/`mine` of a change and the body reduced to what differs. Empty `base` on an update/action = the change is a no-op. */
export function diff(route: Route, body: Row | null, record: Row): { base: Values; mine: Values; body: Row | null } {
  const base: Values = {}
  const mine: Values = {}
  const b = body ?? {}
  if (route.action === 'create' || route.action === 'reorder') return { base, mine, body }
  if (route.action === 'delete') {
    for (const u of UNITS[route.kind]) base[u] = valueOf(u, record, 0)
    return { base, mine, body }
  }
  const note = (unit: string, before: Row, now: Row) => {
    if (same(before, now)) return false
    base[unit] = before
    mine[unit] = now
    return true
  }
  const special = actionUnit(route, b)
  if (special) {
    note(special.unit, valueOf(special.unit, record, route.sub), special.now)
    return { base, mine, body }
  }
  const unpaid = route.action === 'payment' && b.payment_status !== 'paid' ? { paid_amount: null, paid_at: null } : {}
  const after = { ...record, ...b, ...unpaid }
  const out: Row = {}
  for (const unit of new Set(Object.keys(b).map((k) => unitOf(route.kind, k)))) {
    if (note(unit, valueOf(unit, record, 0), valueOf(unit, after, 0))) for (const k of keysOf(unit)) if (b[k] !== undefined) out[k] = b[k]
  }
  return { base, mine, body: out }
}

/** The body with only the given units (an atomic action keeps its whole body) */
function bodyFor(op: Op, units: string[]): Row | null {
  if (op.action !== 'update') return op.body
  const keep = new Set(units.flatMap(keysOf))
  return Object.fromEntries(Object.entries(op.body ?? {}).filter(([k]) => keep.has(k)))
}

export type Verdict = { do: 'send'; body: Row | null } | { do: 'done' } | { do: 'conflict'; conflict: Conflict }

/** May the change be sent against the server's current data? (`op` has its temp ids resolved) */
export function decide(op: Op, data: ServerData): Verdict {
  if (op.action === 'create') return { do: 'send', body: op.body }
  if (op.action === 'reorder') {
    // The order is the user's own: wishes that are gone are dropped, new ones stay behind the sorted ones
    const now: number[] = (data.detail?.wishes ?? []).map((w: Row) => w.id)
    const wanted = ((op.body?.ids ?? []) as number[]).filter((id) => now.includes(id))
    const order = [...wanted, ...now.filter((id) => !wanted.includes(id))]
    return order.some((id, i) => id !== now[i]) ? { do: 'send', body: { ids: order } } : { do: 'done' }
  }
  const record = findRecord(op, data)
  if (!record) return op.action === 'delete' ? { do: 'done' } : { do: 'conflict', conflict: { kind: 'gone', fields: [] } }
  const send: string[] = []
  const fields: FieldConflict[] = []
  for (const [unit, base] of Object.entries(op.base)) {
    const theirs = valueOf(unit, record, op.sub)
    const mine = op.mine[unit] ?? null
    if (same(theirs, base)) send.push(unit)
    else if (!mine || !same(theirs, mine)) fields.push({ unit, mine, theirs })
  }
  if (fields.length) return { do: 'conflict', conflict: { kind: 'changed', fields } }
  if (op.action === 'delete') return { do: 'send', body: op.body }
  return send.length ? { do: 'send', body: bodyFor(op, send) } : { do: 'done' }
}

// ───────────── Resolving ─────────────

const open = (op: Op, fields: FieldConflict[]): Op =>
  fields.length ? { ...op, conflict: { kind: 'changed', fields } } : { ...op, status: 'pending', conflict: undefined }

/** "Keep mine" (`unit` null: all fields): the server's value becomes the new base, so the change is sent – as a new operation, `opId`. */
export function keepMine(op: Op, unit: string | null, opId: string): Op {
  const fields = op.conflict?.fields ?? []
  const chosen = fields.filter((f) => unit === null || f.unit === unit)
  return open({ ...op, opId, base: { ...op.base, ...Object.fromEntries(chosen.map((f) => [f.unit, f.theirs])) } }, fields.filter((f) => !chosen.includes(f)))
}

/** "Keep theirs": the field is dropped from the change; null = nothing is left of it. */
export function keepTheirs(op: Op, unit: string, opId: string): Op | null {
  const base = Object.fromEntries(Object.entries(op.base).filter(([u]) => u !== unit))
  const mine = Object.fromEntries(Object.entries(op.mine).filter(([u]) => u !== unit))
  if (op.action !== 'update' || !Object.keys(base).length) return null
  return open({ ...op, opId, base, mine, body: bodyFor(op, Object.keys(base)) }, (op.conflict?.fields ?? []).filter((f) => f.unit !== unit))
}

/**
 * After `sent` was accepted: a later change of the same record that builds on it takes over the server's view of the fields `sent` touched
 * (trimmed texts, dates set automatically …), so it does not conflict with the user's own earlier change.
 */
export function rebase(op: Op, sent: Op, record: Row): Op {
  const touched = (unit: string) => sent.action === 'create' || unit in sent.mine || (sent.action === 'payment' && unit === 'settled')
  const base = { ...op.base }
  for (const unit of Object.keys(base)) if (touched(unit)) base[unit] = valueOf(unit, record, op.sub)
  return { ...op, base }
}

/** Body that creates the record again as the user last saw it, including this change; null where that makes no sense. */
export function recreateBody(op: Op): Row | null {
  if (!op.record || op.action === 'create' || op.action === 'delete' || op.action === 'reorder') return null
  if (op.kind === 'occasion' && op.record.type === 'birthday') return null
  const change = op.action === 'exclude' || op.action === 'settle' ? {} : op.body
  const r: Row = { ...op.record, ...change }
  const keys = UNITS[op.kind].flatMap(keysOf).filter((k) => k !== 'wish_count')
  const body: Row = Object.fromEntries(keys.filter((k) => r[k] !== undefined && r[k] !== null).map((k) => [k, r[k]]))
  if (Array.isArray(body.givers)) body.givers = body.givers.map((g: Row) => ({ person_id: g.person_id, amount: g.amount }))
  if (op.kind === 'occasion' && body.audience === 'all') delete body.person_ids
  return body
}
