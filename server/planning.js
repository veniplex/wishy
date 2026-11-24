import { randomUUID } from 'node:crypto'
import {
  db, insert, update, tx, TABLES, norm, ensureUpcoming, setOccasionParticipants, setGiftLinks, nextBirthday, todayStr,
  userSettings, setUserSetting, logGiftEvent,
} from './db.js'
import { requireAuth } from './session.js'
import { noteCreated } from './ops-sink.js'
import { spaceCtx, addMemberPerson } from './spaces.js'
import { linkedWishlists, hasAccessToOwner, createWishlist, addWish } from './wishlists.js'
import { loadDemo } from './demo.js'
import { defaultName, userLocale } from './locale.js'
import { mergePersons, withPhotoUrl, cleanEmoji, spacePhotoFiles, removePhotoFiles } from './persons.js'
import { relationshipTypeRoutes, listRelationshipTypes, exportRelationshipTypes, importRelationshipTypes, checkRelationship, auditRelationshipType } from './relationship-types.js'
import { occasionTypeRoutes, listOccasionTypes, exportOccasionTypes, importOccasionTypes, checkOccasionType, cleanAudience, defaultAudience } from './occasion-types.js'
import { occasionParticipants } from './participants.js'
import { requirePermission } from './permissions.js'
import { HttpError, bad, notFound, forbidden, numId, reqId, requireFields, EMAIL_RE } from './util.js'

const all = (sql, ...p) => db.prepare(sql).all(...p)
const get = (sql, ...p) => db.prepare(sql).get(...p)

// ---------- Visibility (surprise protection) ----------
/** Raw data of the space, stripped of everything the user may not see. */
function visibleData(ctx) {
  const sid = ctx.spaceId
  const persons = all('SELECT * FROM persons WHERE space_id=?', sid)
  const occasions = all('SELECT * FROM occasions WHERE space_id=?', sid)
  // A left out mark on the viewer's own person stays secret (they simply look like a normal participant)
  const occasion_persons = all('SELECT op.* FROM occasion_persons op JOIN occasions o ON o.id=op.occasion_id WHERE o.space_id=?', sid).map((r) =>
    r.excluded && ctx.hidden.has(r.person_id) ? { ...r, excluded: 0 } : r,
  )
  const allItems = all('SELECT * FROM items WHERE space_id=?', sid)
  // The inbox (ideas without a person) is not affected by surprise protection
  const inbox = allItems.filter((i) => i.person_id === null)
  const items = allItems.filter((i) => i.person_id !== null && !ctx.hidden.has(i.person_id))
  const allRecipients = all('SELECT gr.* FROM gift_recipients gr JOIN gifts g ON g.id=gr.gift_id WHERE g.space_id=?', sid)
  const hiddenGifts = new Set(allRecipients.filter((r) => ctx.hidden.has(r.person_id)).map((r) => r.gift_id))
  const gifts = all('SELECT * FROM gifts WHERE space_id=?', sid).filter((g) => !hiddenGifts.has(g.id))
  const ok = new Set(gifts.map((g) => g.id))
  const gift_recipients = allRecipients.filter((r) => ok.has(r.gift_id))
  const gift_givers = all('SELECT gg.* FROM gift_givers gg JOIN gifts g ON g.id=gg.gift_id WHERE g.space_id=?', sid).filter((r) => ok.has(r.gift_id))
  return { persons, occasions, occasion_persons, items, inbox, gifts, gift_recipients, gift_givers }
}

const group = (rows, key) => {
  const m = new Map()
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], [])
    m.get(r[key]).push(r)
  }
  return m
}
const strip = ({ space_id, ...rest }) => rest

export function spaceSettings(spaceId) {
  const s = {}
  for (const r of all('SELECT key, value FROM settings WHERE space_id=?', spaceId)) {
    try {
      s[r.key] = JSON.parse(r.value)
    } catch {
      /* ignore */
    }
  }
  return s
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0)
/** Open = gift paid by a payer who is not the respective giver, and the share is not yet settled. */
export function paymentSummary(g, givers) {
  const paid = g.payment_status === 'paid'
  const base = g.paid_amount ?? g.price ?? 0
  const fixed = givers.filter((x) => x.amount != null)
  const free = givers.filter((x) => x.amount == null)
  const rest = Math.max(0, base - sum(fixed.map((x) => x.amount)))
  const share = (x) => (x.amount != null ? x.amount : free.length ? rest / free.length : 0)
  const open = paid && g.payer_id != null && g.status !== 'returned' ? givers.filter((x) => x.person_id !== g.payer_id && !x.settled) : []
  return { paid, payer_id: g.payer_id ?? null, open_amount: Math.round(sum(open.map(share)) * 100) / 100, open_count: open.length }
}

/** Money fields of a gift (cost, payment, shares) - hidden from members without `view_expenses`. */
export const GIFT_MONEY_FIELDS = ['price', 'payer_id', 'payment_status', 'paid_at', 'payment_method', 'paid_amount']

/** State for a member without `view_expenses`: no prices, payments, shares or budgets (the user's own yearly budget stays). */
function withoutExpenses(st) {
  const blank = Object.fromEntries(GIFT_MONEY_FIELDS.map((k) => [k, k === 'payment_status' ? 'unpaid' : null]))
  return {
    ...st,
    persons: st.persons.map((p) => ({ ...p, yearly_budget: null })),
    occasions: st.occasions.map((o) => ({ ...o, budget: null })),
    gifts: st.gifts.map((g) => ({
      ...g, ...blank, givers: g.givers.map((x) => ({ person_id: x.person_id, amount: null, settled: 0, settled_at: null, settle_method: null })),
      payment_summary: { paid: false, payer_id: null, open_amount: 0, open_count: 0 },
    })),
  }
}
/** Without `view_expenses` money fields of a write are ignored (the member never saw them, so they must not be overwritten). */
function dropMoney(ctx, body, extra = []) {
  if (ctx.permissions.view_expenses) return
  for (const k of [...GIFT_MONEY_FIELDS, ...extra]) delete body[k]
}
/** Without `view_expenses` the givers (who gives) can still be set, but their share amounts are kept as they are (never sent or changed). */
function keepShares(ctx, body, giftId) {
  if (ctx.permissions.view_expenses || !Array.isArray(body.givers)) return
  const old = new Map(giftId ? all('SELECT person_id, amount FROM gift_givers WHERE gift_id=?', giftId).map((r) => [r.person_id, r.amount]) : [])
  body.givers = body.givers.map((x) => ({ person_id: x.person_id, amount: old.get(Number(x.person_id)) ?? null }))
}

export function getState(ctx) {
  ensureUpcoming(ctx.spaceId)
  const d = visibleData(ctx)
  const op = group(d.occasion_persons, 'occasion_id')
  const gr = group(d.gift_recipients, 'gift_id')
  const gg = group(d.gift_givers, 'gift_id')
  const today = todayStr()
  const own = new Set(d.persons.filter((p) => p.linked_user_id === ctx.userId).map((p) => p.id))
  const giftPersons = new Map() // occasion id -> recipients of its gifts (past occasions keep them as participants)
  for (const g of d.gifts) {
    if (g.occasion_id === null) continue
    if (!giftPersons.has(g.occasion_id)) giftPersons.set(g.occasion_id, new Set())
    for (const r of gr.get(g.id) || []) giftPersons.get(g.occasion_id).add(r.person_id)
  }
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)
  const byCreated = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id)

  const persons = d.persons
    .map((p) => {
      const mine = p.linked_user_id === ctx.userId
      const out = { ...withPhotoUrl(strip(p)), is_me: mine ? 1 : 0 }
      delete out.relationship_group // unused column since schema 3
      // What others noted about me stays hidden
      if (ctx.hidden.has(p.id)) {
        out.notes = null
        out.yearly_budget = null
      }
      if (p.linked_user_id && !mine) out.linked_wishlists = linkedWishlists(p.linked_user_id, ctx.userId)
      return out
    })
    .sort((a, b) => b.is_me - a.is_me || a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }))

  const state = {
    today,
    space_id: ctx.spaceId,
    user_id: ctx.userId,
    permissions: ctx.permissions,
    persons,
    occasion_types: listOccasionTypes(ctx.spaceId),
    relationship_types: listRelationshipTypes(ctx.spaceId),
    // person_ids = effective participants, excluded_ids = left out persons (see participants.js)
    occasions: d.occasions.sort(byDate).map((o) => ({
      ...strip(o),
      ...occasionParticipants(o, { rows: op.get(o.id) || [], persons: d.persons, hidden: ctx.hidden, own, today, giftPersons: giftPersons.get(o.id) }),
    })),
    items: d.items.sort(byCreated).map(({ space_id, ...i }) => i),
    inbox_items: d.inbox.sort(byCreated).map(({ space_id, ...i }) => i),
    gifts: d.gifts.sort(byCreated).map((g) => {
      // The payer has always settled their own share
      const givers = (gg.get(g.id) || []).map((r) => ({
        person_id: r.person_id,
        amount: r.amount,
        settled: r.settled || (g.payer_id != null && r.person_id === g.payer_id) ? 1 : 0,
        settled_at: r.settled_at,
        settle_method: r.settle_method,
      }))
      return { ...strip(g), recipient_ids: (gr.get(g.id) || []).map((r) => r.person_id), givers, payment_summary: paymentSummary(g, givers) }
    }),
    settings: { currency: 'EUR', yearly_budget: null, ...spaceSettings(ctx.spaceId), ...{ yearly_budget: userSettings(ctx.userId).yearly_budget ?? null } },
  }
  return ctx.permissions.view_expenses ? state : withoutExpenses(state)
}

// ---------- Export / import (per space) ----------
export function exportSpace(ctx) {
  const d = visibleData(ctx)
  const meIds = new Set(d.persons.filter((p) => p.linked_user_id === ctx.userId).map((p) => p.id))
  const settings = Object.entries({ currency: 'EUR', ...spaceSettings(ctx.spaceId) }).map(([key, v]) => ({ key, value: JSON.stringify(v) }))
  const yb = userSettings(ctx.userId).yearly_budget
  if (yb != null) settings.push({ key: 'yearly_budget', value: JSON.stringify(yb) })
  return {
    app: 'wishlist',
    version: 1,
    exported_at: new Date().toISOString(),
    persons: d.persons.map(({ space_id, linked_user_id, photo_file, relationship_group, ...p }) => ({ ...p, is_me: meIds.has(p.id) ? 1 : 0 })),
    occasions: d.occasions.map(strip),
    occasion_persons: d.occasion_persons,
    occasion_types: exportOccasionTypes(ctx.spaceId),
    relationship_types: exportRelationshipTypes(ctx.spaceId),
    items: d.items.map(strip),
    gifts: d.gifts.map(strip),
    gift_recipients: d.gift_recipients,
    gift_givers: d.gift_givers,
    settings,
  }
}

export function importSpace(ctx, data) {
  if (data?.app !== 'wishlist') throw bad('Not a valid wishlist backup', 'backup_invalid')
  const arr = (k) => (Array.isArray(data[k]) ? data[k] : [])
  tx(() => {
    const sid = ctx.spaceId
    db.prepare('DELETE FROM gifts WHERE space_id=?').run(sid)
    db.prepare('DELETE FROM items WHERE space_id=?').run(sid)
    db.prepare('DELETE FROM occasions WHERE space_id=?').run(sid)
    removePhotoFiles(spacePhotoFiles(sid)) // photos are not part of the export file
    db.prepare('DELETE FROM persons WHERE space_id=?').run(sid)
    db.prepare('DELETE FROM settings WHERE space_id=?').run(sid)

    const pmap = new Map()
    const omap = new Map()
    const imap = new Map()
    const gmap = new Map()
    let myPerson = null
    for (const p of arr('persons')) {
      if (!p || typeof p.name !== 'string') continue
      const nid = insert('persons', { ...p, emoji: cleanEmoji(p.emoji, false), linked_user_id: undefined }, sid)
      pmap.set(p.id, nid)
      if (p.is_me && myPerson === null) myPerson = nid
    }
    // Members keep their linked person; the former "me" person belongs to the importing user
    const members = all('SELECT user_id FROM space_members WHERE space_id=?', sid)
    for (const m of members) {
      if (m.user_id === ctx.userId && myPerson !== null) db.prepare('UPDATE persons SET linked_user_id=? WHERE id=?').run(m.user_id, myPerson)
      else addMemberPerson(sid, m.user_id)
    }
    for (const o of arr('occasions')) {
      if (!o || !o.name || !o.date) continue
      omap.set(o.id, insert('occasions', { ...o, audience: o.audience === 'all' ? 'all' : 'selected', person_id: pmap.get(o.person_id) ?? null }, sid))
    }
    importOccasionTypes(sid, data.occasion_types) // after the occasions (unknown types get a custom row)
    importRelationshipTypes(sid, data.relationship_types) // after the persons (free text of older backups is converted to types)
    for (const r of arr('occasion_persons')) {
      const o = omap.get(r.occasion_id)
      const p = pmap.get(r.person_id)
      if (o && p) db.prepare('INSERT OR IGNORE INTO occasion_persons (occasion_id, person_id, excluded) VALUES (?,?,?)').run(o, p, r.excluded ? 1 : 0)
    }
    for (const i of arr('items')) {
      const p = pmap.get(i.person_id)
      if (!p || !i.title) continue
      imap.set(i.id, insert('items', { ...i, person_id: p, occasion_id: omap.get(i.occasion_id) ?? null }, sid))
    }
    for (const g of arr('gifts')) {
      if (!g || !g.title) continue
      gmap.set(
        g.id,
        insert('gifts', { ...g, wish_id: undefined, occasion_id: omap.get(g.occasion_id) ?? null, item_id: imap.get(g.item_id) ?? null, payer_id: pmap.get(g.payer_id) ?? null }, sid),
      )
    }
    for (const r of arr('gift_recipients')) {
      const g = gmap.get(r.gift_id)
      const p = pmap.get(r.person_id)
      if (g && p) db.prepare('INSERT OR IGNORE INTO gift_recipients VALUES (?,?)').run(g, p)
    }
    for (const r of arr('gift_givers')) {
      const g = gmap.get(r.gift_id)
      const p = pmap.get(r.person_id)
      if (g && p) db.prepare('INSERT OR IGNORE INTO gift_givers (gift_id,person_id,amount,settled,settled_at,settle_method) VALUES (?,?,?,?,?,?)').run(g, p, norm(r.amount), r.settled ? 1 : 0, r.settled_at ?? null, r.settle_method ?? null)
    }
    for (const s of arr('settings')) {
      let v
      try {
        v = JSON.parse(s.value)
      } catch {
        continue
      }
      if (s.key === 'yearly_budget') setUserSetting(ctx.userId, 'yearly_budget', v)
      else if (s.key === 'currency') db.prepare('INSERT INTO settings (space_id,key,value) VALUES (?,?,?)').run(sid, 'currency', JSON.stringify(v))
    }
  })
}

// ---------- Ownership checks (every id from the client) ----------
const ownedPerson = (ctx, id) => {
  const n = numId(id)
  const p = Number.isNaN(n) ? null : get('SELECT * FROM persons WHERE id=? AND space_id=?', n, ctx.spaceId)
  if (!p) throw notFound('Person not found', 'person_not_found')
  return p
}
const ownedOccasion = (ctx, id) => {
  const n = numId(id)
  const o = Number.isNaN(n) ? null : get('SELECT * FROM occasions WHERE id=? AND space_id=?', n, ctx.spaceId)
  if (!o) throw notFound('Occasion not found', 'occasion_not_found')
  return o
}
const ownedItem = (ctx, id) => {
  const n = numId(id)
  const i = Number.isNaN(n) ? null : get('SELECT * FROM items WHERE id=? AND space_id=?', n, ctx.spaceId)
  if (!i || (i.person_id !== null && ctx.hidden.has(i.person_id))) throw notFound('Entry not found', 'entry_not_found')
  return i
}
const ownedGift = (ctx, id) => {
  const n = numId(id)
  const g = Number.isNaN(n) ? null : get('SELECT * FROM gifts WHERE id=? AND space_id=?', n, ctx.spaceId)
  if (!g) throw notFound('Gift not found', 'gift_not_found')
  if (ctx.hidden.size) {
    const rec = all('SELECT person_id FROM gift_recipients WHERE gift_id=?', g.id)
    if (rec.some((r) => ctx.hidden.has(r.person_id))) throw notFound('Gift not found', 'gift_not_found')
  }
  return g
}
const idList = (v, label) => {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw bad(`${label} invalid`, 'ids_invalid')
  return [...new Set(v.map((x) => {
    const n = numId(x)
    if (Number.isNaN(n)) throw notFound('Person not found', 'person_not_found')
    return n
  }))]
}
/** person_ids / excluded_ids of an occasion body (undefined = not sent), every id checked against the space. */
function occasionPeople(ctx, body) {
  const personIds = idList(body.person_ids, 'Persons')
  const excludedIds = idList(body.excluded_ids, 'Persons')
  for (const pid of [...(personIds || []), ...(excludedIds || [])]) ownedPerson(ctx, pid)
  return { personIds, excludedIds }
}
const optId = (v) => (v === undefined ? undefined : v === null || v === '' ? null : v)

/** Checks the person <-> user link (space member or subscribed wishlist). */
function checkLink(ctx, person, value) {
  if (value === undefined) return
  const current = person?.linked_user_id ?? null
  const currentIsMember = current && get('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?', ctx.spaceId, current)
  if (value === null || value === '') {
    if (currentIsMember) throw bad('The person of a member cannot be unlinked', 'member_person_unlink')
    return
  }
  const uid = numId(value)
  if (Number.isNaN(uid)) throw bad('Invalid user', 'user_invalid')
  if (uid === current) return
  if (currentIsMember) throw bad('The person of a member cannot be reassigned', 'member_person_reassign')
  const isMember = get('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?', ctx.spaceId, uid)
  if (!isMember && !hasAccessToOwner(uid, ctx.userId) && !hasAccessToOwner(ctx.userId, uid)) throw notFound('User not found', 'user_not_found')
  if (isMember && get('SELECT 1 FROM persons WHERE space_id=? AND linked_user_id=? AND id IS NOT ?', ctx.spaceId, uid, person?.id ?? null)) {
    throw bad('This member already has a person in this space', 'member_has_person')
  }
}

/** Validates email and relationship (key of a relationship type; free text of older clients is matched to / creates a type). `current` = the person's present relationship. */
function cleanPersonFields(ctx, req, body, current) {
  if (body.email !== undefined) {
    const e = String(body.email ?? '').trim()
    if (e && (!EMAIL_RE.test(e) || e.length > 254)) throw bad('Please enter a valid email address', 'email_invalid')
    body.email = e || null
  }
  delete body.relationship_group // removed in 1.0.2; older clients may still send it
  if (body.relationship !== undefined) {
    body.relationship = checkRelationship(ctx.spaceId, body.relationship, current, (key, name) => {
      const was = req._audited // the person's own audit entry (middleware) must still be written
      auditRelationshipType(req, 'relationship_type.create', ctx.spaceId, get('SELECT * FROM relationship_types WHERE space_id=? AND key=?', ctx.spaceId, key), { source: 'person', name })
      req._audited = was
    })
  }
}

function syncBirthday(ctx, personId) {
  const p = get('SELECT * FROM persons WHERE id=? AND space_id=?', personId, ctx.spaceId)
  const today = todayStr()
  if (p.birthday && !p.archived) {
    db.prepare("UPDATE occasions SET date=? WHERE space_id=? AND type='birthday' AND person_id=? AND date>=?").run(
      nextBirthday(p.birthday, today), ctx.spaceId, personId, today,
    )
  } else {
    db.prepare(
      "DELETE FROM occasions WHERE space_id=? AND type='birthday' AND person_id=? AND date>=? AND id NOT IN (SELECT occasion_id FROM gifts WHERE occasion_id IS NOT NULL)",
    ).run(ctx.spaceId, personId, today)
  }
}

const isLeftOut = (occasionId, personId) =>
  !!get('SELECT 1 FROM occasion_persons WHERE occasion_id=? AND person_id=? AND excluded=1', occasionId, personId)
/** Newly assigning something to an occasion for a person who is left out of it is refused (existing gifts stay untouched). */
function checkNotLeftOut(occasionId, personIds) {
  if (occasionId && personIds.some((pid) => isLeftOut(occasionId, pid))) throw bad('This person is left out of the occasion', 'person_excluded')
}

function checkItemBody(ctx, body, { creating }) {
  if (body.person_id !== undefined || creating) {
    const p = ownedPerson(ctx, body.person_id)
    if (ctx.hidden.has(p.id)) throw new HttpError(400, 'There are no ideas for yourself - manage your wishes in your wishlists', 'self_idea')
    body.person_id = p.id
  }
  if (body.occasion_id !== undefined) {
    body.occasion_id = optId(body.occasion_id)
    if (body.occasion_id !== null) body.occasion_id = ownedOccasion(ctx, body.occasion_id).id
  }
}

/**
 * Creates an idea (also for the public API). Without a person it lands in the inbox (items.inbox = 1).
 * Checks person/occasion in the space and the surprise protection; returns the new id.
 */
export function createIdea(ctx, input) {
  requirePermission(ctx, 'manage_gifts')
  const body = { ...input }
  if (!String(body.title ?? '').trim()) throw new HttpError(400, 'Field "title" is missing', 'title_required')
  const noPerson = body.person_id === undefined || body.person_id === null || body.person_id === ''
  if (noPerson) delete body.person_id
  checkItemBody(ctx, body, { creating: !noPerson })
  return tx(() => {
    if (!noPerson) checkNotLeftOut(body.occasion_id, [body.person_id])
    const id = insert('items', body, ctx.spaceId)
    if (noPerson) db.prepare('UPDATE items SET person_id=NULL, inbox=1 WHERE id=?').run(id)
    return id
  })
}

function checkGiftBody(ctx, body) {
  delete body.wish_id
  for (const k of ['occasion_id', 'payer_id', 'item_id']) body[k] = optId(body[k])
  if (body.occasion_id) body.occasion_id = ownedOccasion(ctx, body.occasion_id).id
  if (body.payer_id) body.payer_id = ownedPerson(ctx, body.payer_id).id
  if (body.item_id) body.item_id = ownedItem(ctx, body.item_id).id
  if (body.recipient_ids !== undefined) {
    const ids = idList(body.recipient_ids, 'Recipients')
    for (const pid of ids) {
      ownedPerson(ctx, pid)
      if (ctx.hidden.has(pid)) throw bad('You cannot plan gifts for yourself here', 'self_gift')
    }
    body.recipient_ids = ids
  }
  if (body.givers !== undefined) {
    if (!Array.isArray(body.givers)) throw bad('Givers invalid', 'givers_invalid')
    body.givers = body.givers.map((g) => ({
      person_id: ownedPerson(ctx, g?.person_id).id,
      amount: g.amount === '' || g.amount == null ? null : Number(g.amount),
      settled: g.settled === undefined ? undefined : g.settled ? 1 : 0,
      settled_at: g.settled_at ? String(g.settled_at).slice(0, 32) : undefined,
      settle_method: g.settle_method ? String(g.settle_method).slice(0, 60) : undefined,
    }))
  }
  if (body.status !== undefined && !GIFT_STATUS.includes(body.status)) throw bad('Invalid status', 'invalid_status')
  if (body.payment_status !== undefined && !['unpaid', 'paid'].includes(body.payment_status)) throw bad('Invalid payment status', 'invalid_payment_status')
  for (const k of ['order_number', 'carrier', 'tracking_number', 'payment_method']) if (body[k] !== undefined) body[k] = str(body[k], 100)
  if (body.tracking_url !== undefined) body.tracking_url = str(body.tracking_url, 2000)
  for (const k of ['ordered_at', 'expected_at', 'delivered_at', 'given_at', 'paid_at']) if (body[k] !== undefined) body[k] = str(body[k], 32)
  if (body.paid_amount !== undefined) {
    if (body.paid_amount === null || body.paid_amount === '') body.paid_amount = null
    else {
      const n = Number(body.paid_amount)
      if (!Number.isFinite(n) || n < 0) throw bad('Invalid amount', 'invalid_amount')
      body.paid_amount = n
    }
  }
}

const GIFT_STATUS = ['planned', 'ordered', 'shipped', 'delivered', 'wrapped', 'given', 'returned']
const str = (v, max) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max))
const STATUS_DATE = { ordered: 'ordered_at', delivered: 'delivered_at', given: 'given_at' }

/** Automatically fills date fields matching the new status/payment status (only if empty). */
function autoDates(body, g = {}) {
  const today = todayStr()
  if (body.status !== undefined && body.status !== g.status) {
    const col = STATUS_DATE[body.status]
    if (col && !(body[col] ?? g[col])) body[col] = today
  }
  if (body.payment_status === 'paid' && !(body.paid_at ?? g.paid_at)) body.paid_at = today
  if (body.payment_status === 'unpaid' && body.paid_at === undefined) body.paid_at = null
}

const norm2 = (v) => (v === undefined || v === '' ? null : v)
function giverShare(giftId, personId) {
  const g = get('SELECT * FROM gifts WHERE id=?', giftId)
  const givers = all('SELECT * FROM gift_givers WHERE gift_id=?', giftId)
  const fixed = givers.filter((x) => x.amount != null)
  const free = givers.filter((x) => x.amount == null)
  const mine = givers.find((x) => x.person_id === personId)
  if (!mine) return null
  if (mine.amount != null) return mine.amount
  const rest = Math.max(0, (g.paid_amount ?? g.price ?? 0) - sum(fixed.map((x) => x.amount)))
  return free.length ? Math.round((rest / free.length) * 100) / 100 : 0
}
const giftSnapshot = (id) => ({
  recipients: all('SELECT person_id FROM gift_recipients WHERE gift_id=?', id).map((r) => r.person_id),
  givers: all('SELECT * FROM gift_givers WHERE gift_id=?', id),
})
/** Writes history events for the change from before (row) to body. */
function logGiftChanges(ctx, before, body, prev, { quiet = false, skip = [] } = {}) {
  const uid = ctx.userId
  const changed = TABLES.gifts.filter((c) => c !== 'wish_id' && !skip.includes(c) && body[c] !== undefined && String(norm2(body[c]) ?? '') !== String(before[c] ?? ''))
  if (changed.includes('status')) logGiftEvent(before.id, uid, 'status', { from: before.status, to: body.status })
  if (changed.includes('payment_status')) {
    if (body.payment_status === 'paid') {
      logGiftEvent(before.id, uid, 'paid', {
        by: body.payer_id ?? before.payer_id ?? null,
        amount: body.paid_amount ?? before.paid_amount ?? body.price ?? before.price ?? null,
        method: body.payment_method ?? before.payment_method ?? null,
      })
    } else logGiftEvent(before.id, uid, 'unpaid', {})
  }
  const fields = changed.filter((c) => c !== 'status' && c !== 'payment_status')
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))
  if (body.recipient_ids && !sameSet(body.recipient_ids, prev.recipients)) fields.push('recipient_ids')
  if (body.givers) {
    const ids = body.givers.map((g) => g.person_id)
    const amountChanged = body.givers.some((g) => {
      const o = prev.givers.find((x) => x.person_id === g.person_id)
      return String(g.amount ?? '') !== String(o?.amount ?? '')
    })
    if (!sameSet(ids, prev.givers.map((g) => g.person_id)) || amountChanged) fields.push('givers')
    for (const g of body.givers) {
      if (g.settled === undefined) continue
      const o = prev.givers.find((x) => x.person_id === g.person_id)
      if (!!g.settled !== !!o?.settled) {
        logGiftEvent(before.id, uid, g.settled ? 'share_settled' : 'share_unsettled', {
          person_id: g.person_id, amount: giverShare(before.id, g.person_id), method: g.settle_method ?? null,
        })
      }
    }
  }
  if (fields.length && !quiet) logGiftEvent(before.id, uid, 'edited', { fields })
}

const ensureCan = (cond, msg, code) => {
  if (!cond) throw forbidden(msg, code)
}

// ---------- Routes ----------
export function planningRoutes(app) {
  const wrap = (fn) => (req, res) => {
    const ctx = spaceCtx(req)
    req.body ??= {}
    fn(ctx, req, res)
    // Links may have changed (recompute surprise protection)
    res.json(getState(spaceCtx(req)))
  }
  const route = (method, path, fn) => app[method](path, requireAuth, wrap(fn))
  /** Like route(), but the member needs `permission` (403 permission_denied otherwise) */
  const guarded = (permission, method, path, fn) =>
    route(method, path, (ctx, req, res) => {
      requirePermission(ctx, permission)
      return fn(ctx, req, res)
    })

  app.get('/api/state', requireAuth, (req, res) => res.json(getState(spaceCtx(req))))

  occasionTypeRoutes(app, route, requireAuth, spaceCtx)
  relationshipTypeRoutes(app, route, requireAuth, spaceCtx)

  // ---- Persons ----
  guarded('manage_persons', 'post', '/api/persons', (ctx, req) => {
    requireFields(req.body, 'name')
    const body = { ...req.body }
    dropMoney(ctx, body, ['yearly_budget'])
    checkLink(ctx, null, body.linked_user_id)
    if (body.linked_user_id === '') body.linked_user_id = null
    cleanPersonFields(ctx, req, body, null)
    if (body.emoji !== undefined) body.emoji = cleanEmoji(body.emoji)
    tx(() => noteCreated(insert('persons', body, ctx.spaceId)))
  })
  guarded('manage_persons', 'put', '/api/persons/:id', (ctx, req) => {
    const p = ownedPerson(ctx, req.params.id)
    const body = { ...req.body }
    dropMoney(ctx, body, ['yearly_budget'])
    checkLink(ctx, p, body.linked_user_id)
    cleanPersonFields(ctx, req, body, p.relationship)
    if (body.emoji !== undefined && body.emoji !== p.emoji) body.emoji = cleanEmoji(body.emoji) // unchanged legacy values stay accepted
    if (body.linked_user_id === undefined) delete body.linked_user_id
    // Own person in a shared space: others' notes/budget stay hidden and unchangeable
    if (ctx.hidden.has(p.id)) {
      delete body.notes
      delete body.yearly_budget
    }
    tx(() => {
      update('persons', p.id, body)
      syncBirthday(ctx, p.id)
    })
  })
  // Link a person to an app user; the automatically created person of that user is merged in
  guarded('manage_persons', 'post', '/api/persons/:id/link', (ctx, req) => {
    const p = ownedPerson(ctx, req.params.id)
    const uid = numId(req.body.user_id)
    if (Number.isNaN(uid) || !get('SELECT 1 FROM users WHERE id=? AND disabled=0', uid)) throw notFound('User not found', 'user_not_found')
    const isMember = get('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?', ctx.spaceId, uid)
    if (!isMember && !hasAccessToOwner(uid, ctx.userId) && !hasAccessToOwner(ctx.userId, uid)) throw notFound('User not found', 'user_not_found')
    if (p.linked_user_id === uid) return
    if (p.linked_user_id && get('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?', ctx.spaceId, p.linked_user_id)) {
      throw bad('The person of a member cannot be reassigned', 'member_person_reassign')
    }
    tx(() => {
      const other = get('SELECT id FROM persons WHERE space_id=? AND linked_user_id=? AND id!=?', ctx.spaceId, uid, p.id)
      if (other) mergePersons(ctx.spaceId, p.id, other.id, ctx.userId)
      db.prepare('UPDATE persons SET linked_user_id=? WHERE id=?').run(uid, p.id)
    })
  })
  guarded('manage_persons', 'post', '/api/persons/:id/unlink', (ctx, req) => {
    const p = ownedPerson(ctx, req.params.id)
    if (!p.linked_user_id) return
    if (get('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?', ctx.spaceId, p.linked_user_id)) {
      throw bad('The person of a member cannot be unlinked', 'member_person_unlink')
    }
    db.prepare('UPDATE persons SET linked_user_id=NULL WHERE id=?').run(p.id)
  })
  guarded('manage_persons', 'delete', '/api/persons/:id', (ctx, req) => {
    const p = ownedPerson(ctx, req.params.id)
    if (p.linked_user_id && get('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?', ctx.spaceId, p.linked_user_id)) {
      throw bad('The person of a member cannot be deleted', 'member_person_delete')
    }
    db.prepare('DELETE FROM persons WHERE id=?').run(p.id)
    removePhotoFiles([p.photo_file])
  })

  // ---- Occasions ----
  guarded('manage_occasions', 'post', '/api/occasions', (ctx, req) => {
    requireFields(req.body, 'name', 'date')
    const body = { ...req.body, series_id: randomUUID() }
    dropMoney(ctx, body, ['budget'])
    body.person_id = optId(body.person_id)
    if (body.person_id) body.person_id = ownedPerson(ctx, body.person_id).id
    if (body.type !== undefined) body.type = checkOccasionType(ctx.spaceId, body.type)
    body.audience = cleanAudience(req.body.audience) ?? defaultAudience(ctx.spaceId, body.type ?? 'other')
    const people = occasionPeople(ctx, req.body)
    tx(() => {
      const oid = noteCreated(insert('occasions', body, ctx.spaceId))
      setOccasionParticipants(oid, body.audience, people, ctx.hidden)
    })
  })
  guarded('manage_occasions', 'put', '/api/occasions/:id', (ctx, req) => {
    const o = ownedOccasion(ctx, req.params.id)
    const body = { ...req.body, series_id: undefined }
    dropMoney(ctx, body, ['budget'])
    if (body.type !== undefined) body.type = checkOccasionType(ctx.spaceId, body.type, o.type)
    if (body.person_id !== undefined) {
      body.person_id = optId(body.person_id)
      if (body.person_id) body.person_id = ownedPerson(ctx, body.person_id).id
    }
    body.audience = cleanAudience(req.body.audience)
    const people = occasionPeople(ctx, req.body)
    // A birthday belongs to its person: no audience or participant list, only exclusions
    if (o.type === 'birthday') {
      body.audience = undefined
      people.personIds = undefined
    }
    tx(() => {
      update('occasions', o.id, body)
      if (body.audience !== undefined || people.personIds || people.excludedIds) setOccasionParticipants(o.id, body.audience ?? o.audience, people, ctx.hidden)
      if (req.body.recurring !== undefined) {
        // The recurrence applies to the whole series
        db.prepare(
          'UPDATE occasions SET recurring=? WHERE space_id=? AND series_id IS NOT NULL AND series_id=(SELECT series_id FROM occasions WHERE id=?)',
        ).run(req.body.recurring ? 1 : 0, ctx.spaceId, o.id)
      }
    })
  })
  // Leave a person out of an occasion (excluded=true) or include them again (false)
  guarded('manage_occasions', 'put', '/api/occasions/:id/persons/:personId', (ctx, req) => {
    const o = ownedOccasion(ctx, req.params.id)
    const p = ownedPerson(ctx, req.params.personId)
    if (typeof req.body.excluded !== 'boolean') throw bad('Field "excluded" must be true or false', 'excluded_invalid')
    if (ctx.hidden.has(p.id)) return // the viewer's own person is not theirs to change
    if (req.body.excluded) {
      db.prepare('INSERT INTO occasion_persons (occasion_id, person_id, excluded) VALUES (?,?,1) ON CONFLICT (occasion_id, person_id) DO UPDATE SET excluded=1').run(o.id, p.id)
    } else if (o.audience === 'all') {
      db.prepare('DELETE FROM occasion_persons WHERE occasion_id=? AND person_id=?').run(o.id, p.id)
    } else {
      db.prepare('INSERT INTO occasion_persons (occasion_id, person_id, excluded) VALUES (?,?,0) ON CONFLICT (occasion_id, person_id) DO UPDATE SET excluded=0').run(o.id, p.id)
    }
  })
  guarded('manage_occasions', 'delete', '/api/occasions/:id', (ctx, req) => {
    const o = ownedOccasion(ctx, req.params.id)
    tx(() => {
      // Deleting ends the recurrence, otherwise the date would be recreated immediately
      db.prepare(
        'UPDATE occasions SET recurring=0 WHERE space_id=? AND series_id IS NOT NULL AND series_id=(SELECT series_id FROM occasions WHERE id=?)',
      ).run(ctx.spaceId, o.id)
      db.prepare('DELETE FROM occasions WHERE id=?').run(o.id)
    })
  })

  // ---- Wishes & ideas ----
  guarded('manage_gifts', 'post', '/api/items', (ctx, req) => {
    requireFields(req.body, 'title')
    const body = { ...req.body }
    noteCreated(createIdea(ctx, body)) // without person_id: idea in the inbox
  })
  guarded('manage_gifts', 'put', '/api/items/:id', (ctx, req) => {
    const it = ownedItem(ctx, req.params.id)
    const body = { ...req.body }
    if (body.person_id === null || body.person_id === '') delete body.person_id // A person cannot be removed - the inbox exists only for new ideas
    checkItemBody(ctx, body, { creating: false })
    const person = body.person_id ?? it.person_id
    const occasion = body.occasion_id !== undefined ? body.occasion_id : it.occasion_id
    if (person !== null && (occasion !== it.occasion_id || person !== it.person_id)) checkNotLeftOut(occasion, [person])
    delete body.inbox
    tx(() => {
      update('items', it.id, body)
      if (it.person_id === null && body.person_id !== undefined) db.prepare('UPDATE items SET inbox=0 WHERE id=?').run(it.id)
    })
  })
  // Inbox: assign an idea to a person
  guarded('manage_gifts', 'post', '/api/items/:id/assign', (ctx, req) => {
    const it = ownedItem(ctx, req.params.id)
    if (it.person_id !== null) throw new HttpError(400, 'This idea is already assigned to a person', 'not_in_inbox')
    const p = ownedPerson(ctx, req.body.person_id)
    if (ctx.hidden.has(p.id)) throw new HttpError(400, 'There are no ideas for yourself - manage your wishes in your wishlists', 'self_idea')
    checkNotLeftOut(it.occasion_id, [p.id])
    db.prepare('UPDATE items SET person_id=?, inbox=0 WHERE id=?').run(p.id, it.id)
  })
  guarded('manage_gifts', 'delete', '/api/items/:id', (ctx, req) => {
    db.prepare('DELETE FROM items WHERE id=?').run(ownedItem(ctx, req.params.id).id)
  })

  // ---- Gifts ----
  guarded('manage_gifts', 'post', '/api/gifts', (ctx, req) => {
    requireFields(req.body, 'title')
    const body = { ...req.body }
    dropMoney(ctx, body)
    keepShares(ctx, body, null)
    checkGiftBody(ctx, body)
    // A gift made from an idea inherits the idea's person (unless recipients are sent) and occasion (unless one is sent)
    const idea = body.item_id ? get('SELECT person_id, occasion_id, image_url FROM items WHERE id=?', body.item_id) : null
    if (idea?.person_id && !body.recipient_ids?.length) body.recipient_ids = [idea.person_id]
    if (idea?.occasion_id && body.occasion_id === undefined) body.occasion_id = idea.occasion_id
    if (!body.recipient_ids?.length) throw bad('A gift needs at least one recipient', 'recipient_required')
    checkNotLeftOut(body.occasion_id, body.recipient_ids)
    tx(() => {
      if (idea?.image_url && !body.image_url) body.image_url = idea.image_url
      autoDates(body)
      const gid = noteCreated(insert('gifts', body, ctx.spaceId))
      setGiftLinks(gid, body)
      logGiftEvent(gid, ctx.userId, 'created', { title: body.title })
    })
  })
  guarded('manage_gifts', 'put', '/api/gifts/:id', (ctx, req) => {
    const g = ownedGift(ctx, req.params.id)
    const body = { ...req.body }
    dropMoney(ctx, body)
    keepShares(ctx, body, g.id)
    checkGiftBody(ctx, body)
    const before = giftSnapshot(g.id).recipients
    if (body.recipient_ids && !body.recipient_ids.length && before.length) throw bad('A gift needs at least one recipient', 'recipient_required')
    const occasion = body.occasion_id !== undefined ? body.occasion_id : g.occasion_id
    const recipients = body.recipient_ids ?? before
    if (occasion !== g.occasion_id) checkNotLeftOut(occasion, recipients)
    else checkNotLeftOut(occasion, recipients.filter((pid) => !before.includes(pid)))
    tx(() => {
      const given = Object.keys(body)
      autoDates(body, g)
      const prev = giftSnapshot(g.id)
      update('gifts', g.id, body)
      setGiftLinks(g.id, body)
      logGiftChanges(ctx, g, body, prev, { skip: Object.keys(body).filter((k) => !given.includes(k)) })
    })
  })
  guarded('manage_gifts', 'post', '/api/gifts/:id/status', (ctx, req) => {
    const g = ownedGift(ctx, req.params.id)
    const body = { status: req.body.status }
    if (!GIFT_STATUS.includes(body.status)) throw bad('Invalid status', 'invalid_status')
    tx(() => {
      autoDates(body, g)
      update('gifts', g.id, body)
      logGiftChanges(ctx, g, body, giftSnapshot(g.id), { quiet: true })
    })
  })
  guarded('manage_gifts', 'post', '/api/gifts/:id/payment', (ctx, req) => {
    requirePermission(ctx, 'view_expenses')
    const g = ownedGift(ctx, req.params.id)
    const b = req.body
    if (!['unpaid', 'paid'].includes(b.payment_status)) throw bad('Invalid payment status', 'invalid_payment_status')
    const body = { payment_status: b.payment_status }
    if (b.payer_id !== undefined) body.payer_id = b.payer_id === null || b.payer_id === '' ? null : ownedPerson(ctx, b.payer_id).id
    if (b.payment_status === 'paid') {
      if ((b.payer_id === undefined ? g.payer_id : body.payer_id) == null) throw bad('Please state who paid', 'payer_required')
      if (b.paid_at !== undefined) body.paid_at = str(b.paid_at, 32)
      if (b.payment_method !== undefined) body.payment_method = str(b.payment_method, 100)
      if (b.paid_amount !== undefined) {
        const n = b.paid_amount === null || b.paid_amount === '' ? null : Number(b.paid_amount)
        if (n !== null && (!Number.isFinite(n) || n < 0)) throw bad('Invalid amount', 'invalid_amount')
        body.paid_amount = n
      }
    } else {
      body.paid_amount = null
    }
    tx(() => {
      autoDates(body, g)
      update('gifts', g.id, body)
      logGiftChanges(ctx, g, body, giftSnapshot(g.id), { quiet: true })
    })
  })
  guarded('manage_gifts', 'post', '/api/gifts/:id/givers/:personId/settle', (ctx, req) => {
    requirePermission(ctx, 'view_expenses')
    const g = ownedGift(ctx, req.params.id)
    const pid = ownedPerson(ctx, req.params.personId).id
    const row = get('SELECT * FROM gift_givers WHERE gift_id=? AND person_id=?', g.id, pid)
    if (!row) throw notFound('Giver not found', 'giver_not_found')
    const settled = !!req.body.settled
    const method = str(req.body.method, 100)
    tx(() => {
      db.prepare('UPDATE gift_givers SET settled=?, settled_at=?, settle_method=? WHERE gift_id=? AND person_id=?').run(
        settled ? 1 : 0, settled ? todayStr() : null, settled ? method : null, g.id, pid,
      )
      if (!!row.settled !== settled) {
        logGiftEvent(g.id, ctx.userId, settled ? 'share_settled' : 'share_unsettled', {
          person_id: pid, amount: giverShare(g.id, pid), method: settled ? method : null,
        })
      }
    })
  })
  app.get('/api/gifts/:id/events', requireAuth, (req, res) => {
    const ctx = spaceCtx(req)
    const g = ownedGift(ctx, req.params.id)
    res.json(
      all(
        'SELECT e.id, e.type, e.data, e.created_at, e.user_id, u.name AS user_name FROM gift_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.gift_id=? ORDER BY e.id DESC',
        g.id,
      ).map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null })),
    )
  })
  guarded('manage_gifts', 'delete', '/api/gifts/:id', (ctx, req) => {
    db.prepare('DELETE FROM gifts WHERE id=?').run(ownedGift(ctx, req.params.id).id)
  })

  // Mark shares between two persons as settled
  guarded('manage_gifts', 'post', '/api/settle', (ctx, req) => {
    requirePermission(ctx, 'view_expenses')
    const from = ownedPerson(ctx, req.body.from_id).id
    const to = ownedPerson(ctx, req.body.to_id).id
    const hidden = [...ctx.hidden]
    const hiddenSql = hidden.length
      ? `AND g.id NOT IN (SELECT gift_id FROM gift_recipients WHERE person_id IN (${hidden.map(() => '?').join(',')}))`
      : ''
    // Only paid, not returned gifts of this payer, with the giver's share still open
    const rows = all(
      `SELECT gg.gift_id FROM gift_givers gg JOIN gifts g ON g.id=gg.gift_id
       WHERE gg.person_id=? AND gg.settled=0 AND g.space_id=? AND g.payer_id=? AND g.payment_status='paid'
         AND g.status NOT IN ('planned','returned') ${hiddenSql}`,
      from, ctx.spaceId, to, ...hidden,
    )
    const method = str(req.body.method, 100)
    for (const r of rows) {
      db.prepare('UPDATE gift_givers SET settled=1, settled_at=?, settle_method=? WHERE gift_id=? AND person_id=?').run(todayStr(), method, r.gift_id, from)
      logGiftEvent(r.gift_id, ctx.userId, 'share_settled', { person_id: from, amount: giverShare(r.gift_id, from), method })
    }
  })

  // ---- Settings, backup ----
  route('put', '/api/settings', (ctx, req) => {
    for (const [k, v] of Object.entries(req.body)) {
      if (k === 'yearly_budget') setUserSetting(ctx.userId, 'yearly_budget', v === '' ? null : v)
      else if (k === 'currency') {
        requirePermission(ctx, 'manage_space_settings')
        db.prepare('INSERT INTO settings (space_id,key,value) VALUES (?,?,?) ON CONFLICT(space_id,key) DO UPDATE SET value=excluded.value').run(
          ctx.spaceId, k, JSON.stringify(v ?? null),
        )
      }
    }
  })
  app.get('/api/export', requireAuth, (req, res) => {
    const ctx = spaceCtx(req)
    requirePermission(ctx, 'view_expenses') // the export contains all prices, payments and budgets
    res.setHeader('Content-Disposition', `attachment; filename="wunschliste-backup-${todayStr()}.json"`)
    res.json(exportSpace(ctx))
  })
  route('post', '/api/import', (ctx, req) => {
    ensureCan(ctx.role === 'owner', 'Only the owner can import data', 'import_owner_only')
    importSpace(ctx, req.body)
  })
  route('post', '/api/demo', (ctx) => {
    requirePermission(ctx, 'manage_space_settings')
    const others = get(
      'SELECT COUNT(*) AS n FROM persons WHERE space_id=? AND (linked_user_id IS NULL OR linked_user_id NOT IN (SELECT user_id FROM space_members WHERE space_id=?))',
      ctx.spaceId, ctx.spaceId,
    ).n
    if (others > 0) throw bad('This space is not empty', 'space_not_empty')
    const me = addMemberPerson(ctx.spaceId, ctx.userId)
    loadDemo(ctx.spaceId, me, userLocale(ctx.userId))
    if (!get('SELECT 1 FROM wishlists WHERE owner_user_id=?', ctx.userId)) {
      const lid = createWishlist(ctx.userId, { title: defaultName(userLocale(ctx.userId), 'wishlist') })
      addWish(lid, { title: userLocale(ctx.userId) === 'en' ? 'Mechanical keyboard' : 'Mechanische Tastatur', price: 150, priority: 3, url: 'https://example.com' })
      addWish(lid, { title: userLocale(ctx.userId) === 'en' ? 'Cookbook "Simple"' : 'Kochbuch "Simple"', price: 28, priority: 2 })
    }
  })

  void TABLES
}
