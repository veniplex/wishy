/**
 * Overlay: what the server's data will look like once the queued changes are sent (same rules as server/planning.js and
 * server/wishlists.js, as far as the user can see them). Pure: no DOM, React or i18n; the input is never modified.
 *
 * Birthdays: editing a birthday moves the upcoming birthday occasion and removing it drops the occasion; the occasion for a new
 * birthday is created by the server, so it only appears after the sync.
 */
import type { Op, Row } from './types.ts'

const pad = (n: number) => String(n).padStart(2, '0')
/** Local date `YYYY-MM-DD` */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** Timestamp as the server stores it (`YYYY-MM-DD HH:MM:SS`, UTC) */
const serverTime = (iso: string) => iso.slice(0, 19).replace('T', ' ')

const norm = (v: unknown) => (v === undefined || v === '' ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
const pick = (body: Row, keys: string[]): Row => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, norm(body[k])]))
const without = (ids: number[], id: number) => ids.filter((x) => x !== id)
const patch = (rows: Row[], id: number, fn: (r: Row) => Row) => rows.map((r) => (r.id === id ? fn(r) : r))

const COLS = {
  person: ['name', 'birthday', 'emoji', 'color', 'notes', 'yearly_budget', 'archived', 'linked_user_id', 'relationship', 'relationship_group', 'email'],
  occasion: ['name', 'type', 'date', 'recurring', 'person_id', 'budget', 'notes', 'audience'],
  item: ['person_id', 'mentioned', 'title', 'notes', 'url', 'price', 'priority', 'status', 'occasion_id', 'source', 'image_url', 'currency'],
  gift: ['title', 'notes', 'url', 'shop', 'occasion_id', 'item_id', 'price', 'status', 'payer_id', 'date', 'image_url', 'ordered_at', 'order_number', 'carrier',
    'tracking_number', 'tracking_url', 'expected_at', 'delivered_at', 'given_at', 'payment_status', 'paid_at', 'payment_method', 'paid_amount'],
  wish: ['title', 'notes', 'url', 'price', 'currency', 'image_url', 'priority', 'status'],
  list: ['title', 'description', 'event_date'],
}
const blank = (kind: keyof typeof COLS): Row => Object.fromEntries(COLS[kind].map((c) => [c, null]))

function nextBirthday(birthday: string, today: string) {
  const md = birthday.slice(5)
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const inYear = (y: number) => `${y}-${md === '02-29' && !leap(y) ? '02-28' : md}`
  const y = Number(today.slice(0, 4))
  return inYear(y) >= today ? inYear(y) : inYear(y + 1)
}

// ───────────── Planning state ─────────────

/** Effective participants of upcoming occasions for everyone (a new person joins, an archived or left out one does not take part) */
function participants(s: Row): Row {
  const active: number[] = s.persons.filter((p: Row) => !p.archived && !p.is_me).map((p: Row) => p.id)
  return {
    ...s,
    occasions: s.occasions.map((o: Row) => (o.audience === 'all' && o.date >= s.today ? { ...o, person_ids: active.filter((id) => !o.excluded_ids.includes(id)) } : o)),
  }
}

function sorted(s: Row): Row {
  const byCreated = (a: Row, b: Row) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : Math.abs(b.id) - Math.abs(a.id))
  return {
    ...s,
    persons: [...s.persons].sort((a: Row, b: Row) => b.is_me - a.is_me || a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })),
    occasions: [...s.occasions].sort((a: Row, b: Row) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Math.abs(a.id) - Math.abs(b.id))),
    items: [...s.items].sort(byCreated),
    inbox_items: [...s.inbox_items].sort(byCreated),
    gifts: [...s.gifts].sort(byCreated),
  }
}

/** Open shares of a paid gift (see paymentSummary in server/planning.js) */
function paymentSummary(g: Row) {
  const paid = g.payment_status === 'paid'
  const fixed = g.givers.filter((x: Row) => x.amount != null)
  const free = g.givers.length - fixed.length
  const rest = Math.max(0, (g.paid_amount ?? g.price ?? 0) - fixed.reduce((a: number, x: Row) => a + x.amount, 0))
  const open = paid && g.payer_id != null && g.status !== 'returned' ? g.givers.filter((x: Row) => x.person_id !== g.payer_id && !x.settled) : []
  const amount = open.reduce((a: number, x: Row) => a + (x.amount ?? (free ? rest / free : 0)), 0)
  return { paid, payer_id: g.payer_id ?? null, open_amount: Math.round(amount * 100) / 100, open_count: open.length }
}

const STATUS_DATE: Record<string, string> = { ordered: 'ordered_at', delivered: 'delivered_at', given: 'given_at' }
/** Date fields the server fills in for a new status / payment status */
function autoDates(body: Row, before: Row, today: string): Row {
  const out = { ...body }
  if (out.status !== undefined && out.status !== before.status) {
    const col = STATUS_DATE[out.status]
    if (col && !(out[col] ?? before[col])) out[col] = today
  }
  if (out.payment_status === 'paid' && !(out.paid_at ?? before.paid_at)) out.paid_at = today
  if (out.payment_status === 'unpaid' && out.paid_at === undefined) out.paid_at = null
  return out
}

function gift(before: Row, body: Row, today: string): Row {
  const b = autoDates(body, before, today)
  const g: Row = { ...before, ...pick(b, COLS.gift) }
  if (Array.isArray(b.recipient_ids)) g.recipient_ids = [...new Set(b.recipient_ids)]
  if (Array.isArray(b.givers)) {
    g.givers = b.givers.map((x: Row) => {
      const o = before.givers.find((y: Row) => y.person_id === x.person_id)
      return { person_id: x.person_id, amount: norm(x.amount), settled: o?.settled ?? 0, settled_at: o?.settled_at ?? null, settle_method: o?.settle_method ?? null }
    })
  }
  // The payer has always settled their own share
  g.givers = g.givers.map((x: Row) => (g.payer_id != null && x.person_id === g.payer_id && !x.settled ? { ...x, settled: 1 } : x))
  g.payment_summary = paymentSummary(g)
  return g
}

function occasion(before: Row, body: Row): Row {
  const birthday = before.type === 'birthday' // only budget, notes and exclusions can be changed
  const o: Row = { ...before, ...pick(body, birthday ? ['budget', 'notes'] : COLS.occasion) }
  const excluded: number[] = body.excluded_ids ?? before.excluded_ids
  const chosen: number[] = birthday ? before.person_ids : body.person_ids ?? (before.audience === 'selected' ? before.person_ids : [])
  o.excluded_ids = excluded
  if (birthday || o.audience === 'selected') o.person_ids = chosen.filter((id) => !excluded.includes(id))
  return o
}

export function applyToState(state: Row, op: Op): Row {
  if (op.space !== state.space_id) return state
  const s: Row = { ...state, inbox_items: state.inbox_items ?? [] }
  const { target: id, sub } = op
  const b: Row = op.body ?? {}
  const created_at = serverTime(op.at)
  switch (`${op.kind}.${op.action}`) {
    case 'person.create':
      s.persons = [...s.persons, { id, ...blank('person'), archived: 0, is_me: 0, ...pick(b, COLS.person) }]
      break
    case 'person.update': {
      s.persons = patch(s.persons, id, (p) => ({ ...p, ...pick(b, COLS.person) }))
      const p = s.persons.find((x: Row) => x.id === id)
      if (p && (b.birthday !== undefined || b.archived !== undefined)) {
        const upcoming = (o: Row) => o.type === 'birthday' && o.person_id === id && o.date >= s.today
        s.occasions = p.birthday && !p.archived
          ? s.occasions.map((o: Row) => (upcoming(o) ? { ...o, date: nextBirthday(p.birthday, s.today) } : o))
          : s.occasions.filter((o: Row) => !upcoming(o) || s.gifts.some((g: Row) => g.occasion_id === o.id))
      }
      break
    }
    case 'person.delete':
      s.persons = s.persons.filter((p: Row) => p.id !== id)
      s.items = s.items.filter((i: Row) => i.person_id !== id)
      s.occasions = s.occasions
        .filter((o: Row) => o.person_id !== id)
        .map((o: Row) => ({ ...o, person_ids: without(o.person_ids, id), excluded_ids: without(o.excluded_ids, id) }))
      s.gifts = s.gifts.map((g: Row) => {
        const next: Row = { ...g, recipient_ids: without(g.recipient_ids, id), givers: g.givers.filter((x: Row) => x.person_id !== id), payer_id: g.payer_id === id ? null : g.payer_id }
        next.payment_summary = paymentSummary(next)
        return next
      })
      break
    case 'occasion.create': {
      const type = b.type ?? 'other'
      const audience = b.audience ?? s.occasion_types.find((x: Row) => x.key === type)?.default_audience ?? 'selected'
      s.occasions = [...s.occasions, occasion({ id, ...blank('occasion'), recurring: 0, series_id: null, person_ids: [], excluded_ids: [] }, { ...b, type, audience })]
      break
    }
    case 'occasion.update': {
      const series = s.occasions.find((o: Row) => o.id === id)?.series_id
      s.occasions = patch(s.occasions, id, (o) => occasion(o, b))
      if (b.recurring !== undefined && series) s.occasions = s.occasions.map((o: Row) => (o.series_id === series ? { ...o, recurring: b.recurring ? 1 : 0 } : o))
      break
    }
    case 'occasion.exclude':
      s.occasions = patch(s.occasions, id, (o) => {
        const excluded_ids = b.excluded ? [...without(o.excluded_ids, sub), sub] : without(o.excluded_ids, sub)
        const person_ids = b.excluded ? without(o.person_ids, sub) : o.person_ids.includes(sub) ? o.person_ids : [...o.person_ids, sub]
        return { ...o, excluded_ids, person_ids }
      })
      break
    case 'occasion.delete': {
      const series = s.occasions.find((o: Row) => o.id === id)?.series_id
      s.occasions = s.occasions.filter((o: Row) => o.id !== id).map((o: Row) => (series && o.series_id === series ? { ...o, recurring: 0 } : o))
      s.items = s.items.map((i: Row) => (i.occasion_id === id ? { ...i, occasion_id: null } : i))
      s.gifts = s.gifts.map((g: Row) => (g.occasion_id === id ? { ...g, occasion_id: null } : g))
      break
    }
    case 'item.create': {
      const row: Row = { id, ...blank('item'), mentioned: 0, priority: 2, status: 'open', created_at, ...pick(b, COLS.item) }
      if (row.person_id == null) s.inbox_items = [...s.inbox_items, { ...row, inbox: 1 }]
      else s.items = [...s.items, { ...row, inbox: 0 }]
      break
    }
    case 'item.update':
    case 'item.assign': {
      const change = pick(b, op.action === 'assign' ? ['person_id'] : COLS.item)
      if (change.person_id === null) delete change.person_id // a person cannot be removed from an idea
      const inbox = s.inbox_items.find((i: Row) => i.id === id)
      if (inbox && change.person_id !== undefined) {
        s.inbox_items = s.inbox_items.filter((i: Row) => i.id !== id)
        s.items = [...s.items, { ...inbox, ...change, inbox: 0 }]
      } else {
        s.items = patch(s.items, id, (i) => ({ ...i, ...change }))
        s.inbox_items = patch(s.inbox_items, id, (i) => ({ ...i, ...change }))
      }
      break
    }
    case 'item.delete':
      s.items = s.items.filter((i: Row) => i.id !== id)
      s.inbox_items = s.inbox_items.filter((i: Row) => i.id !== id)
      s.gifts = s.gifts.map((g: Row) => (g.item_id === id ? { ...g, item_id: null } : g))
      break
    case 'gift.create': {
      // A gift made from an idea inherits person, occasion and image of the idea
      const idea = b.item_id ? [...s.items, ...s.inbox_items].find((i: Row) => i.id === b.item_id) : null
      const body: Row = { ...b, status: b.status ?? 'planned' }
      if (idea?.person_id && !body.recipient_ids?.length) body.recipient_ids = [idea.person_id]
      if (idea?.occasion_id && body.occasion_id === undefined) body.occasion_id = idea.occasion_id
      if (idea?.image_url && !body.image_url) body.image_url = idea.image_url
      s.gifts = [...s.gifts, gift({ id, ...blank('gift'), payment_status: 'unpaid', wish_id: null, created_at, recipient_ids: [], givers: [] }, body, s.today)]
      break
    }
    case 'gift.update':
      s.gifts = patch(s.gifts, id, (g) => gift(g, b, s.today))
      break
    case 'gift.status':
      s.gifts = patch(s.gifts, id, (g) => gift(g, { status: b.status }, s.today))
      break
    case 'gift.payment': {
      const body: Row = b.payment_status === 'paid' ? b : { payment_status: 'unpaid', paid_amount: null, ...pick(b, ['payer_id']) }
      s.gifts = patch(s.gifts, id, (g) => gift(g, body, s.today))
      break
    }
    case 'gift.settle':
      s.gifts = patch(s.gifts, id, (g) => {
        const share = { settled: b.settled ? 1 : 0, settled_at: b.settled ? s.today : null, settle_method: b.settled ? norm(b.method) : null }
        const next: Row = { ...g, givers: g.givers.map((x: Row) => (x.person_id === sub ? { ...x, ...share } : x)) }
        next.payment_summary = paymentSummary(next)
        return next
      })
      break
    case 'gift.delete':
      s.gifts = s.gifts.filter((g: Row) => g.id !== id)
      break
    default:
      return state
  }
  return sorted(participants(s))
}

// ───────────── Wishlists ─────────────

/** A list that exists only in the queue */
const newList = (op: Op): Row => ({
  id: op.target, ...blank('list'), ...pick(op.body ?? {}, COLS.list), archived: false, link_enabled: false, token: '', url: '', full_url: '',
  wish_count: 0, open_count: 0, access: [], spaces: [], updated_at: op.at,
})
const editList = (l: Row, op: Op): Row => {
  const b = op.body ?? {}
  return { ...l, ...pick(b, COLS.list), ...(b.archived !== undefined ? { archived: !!b.archived } : {}), updated_at: op.at }
}
const counted = (status: unknown) => (status && status !== 'removed' ? 1 : 0)
const isOpen = (status: unknown) => (status === 'open' ? 1 : 0)

/** `{ mine, shared }` of GET /api/wishlists */
export function applyToOverview(o: Row, op: Op): Row {
  if (op.kind === 'list') {
    if (op.action === 'create') return { ...o, mine: [...o.mine, newList(op)] }
    if (op.action === 'update') return { ...o, mine: patch(o.mine, op.target, (l) => editList(l, op)) }
    if (op.action === 'delete') return { ...o, mine: o.mine.filter((l: Row) => l.id !== op.target) }
    return o
  }
  if (op.kind !== 'wish') return o
  const before = op.action === 'create' ? null : op.record?.status
  const after = op.action === 'delete' ? null : op.body?.status ?? before ?? 'open'
  return {
    ...o,
    mine: patch(o.mine, op.sub, (l) => ({
      ...l, wish_count: l.wish_count + counted(after) - counted(before), open_count: l.open_count + isOpen(after) - isOpen(before), updated_at: op.at,
    })),
  }
}

/** Detail view of one own list; null = not there (deleted, or not created by this op) */
export function applyToDetail(d: Row | null, op: Op, listId: number): Row | null {
  if (op.kind === 'list') {
    if (op.target !== listId) return d
    if (op.action === 'create') return { wishlist: newList(op), wishes: [], is_owner: true }
    if (!d || op.action === 'delete') return null
    if (op.action === 'update') return { ...d, wishlist: editList(d.wishlist, op) }
    if (op.action === 'reorder') {
      const rank = new Map<number, number>((op.body?.ids ?? []).map((id: number, i: number) => [id, i]))
      const at = (w: Row) => rank.get(w.id) ?? rank.size
      return { ...d, wishes: [...d.wishes].sort((x: Row, y: Row) => at(x) - at(y)) }
    }
    return d
  }
  if (!d || op.kind !== 'wish' || op.sub !== listId) return d
  let wishes: Row[] = d.wishes
  if (op.action === 'create') wishes = [...wishes, { id: op.target, ...blank('wish'), priority: 2, status: 'open', created_at: op.at, ...pick(op.body ?? {}, COLS.wish) }]
  else if (op.action === 'update') wishes = patch(wishes, op.target, (w) => ({ ...w, ...pick(op.body ?? {}, COLS.wish) }))
  else wishes = wishes.filter((w) => w.id !== op.target)
  const wish_count = wishes.filter((w) => w.status !== 'removed').length
  const open_count = wishes.filter((w) => w.status === 'open').length
  return { ...d, wishes, wishlist: { ...d.wishlist, wish_count, open_count, updated_at: op.at } }
}
