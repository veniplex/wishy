// Guests of a shared wishlist (people without an account).
//
// Every browser that opens a list generates a guest KEY (>= 128 bit, crypto.getRandomValues) and keeps it per list. The server learns
// it only when it is needed: with the first claim, or when the guest saves/uses the personal link (a POST); a plain GET (link previews,
// bots) never creates anything. Only sha256(key) is stored; the key travels in the X-Guest-Key header (never in a URL, query or body)
// and lives in the personal link's URL FRAGMENT (`/w/<token>#g=<key>`), which browsers never send to any server. The public `code`
// (G-7F3KQ2) identifies a guest in admin views and logs without being a credential.
import { createHash, randomInt } from 'node:crypto'
import { db, tx } from './db.js'
import { audit } from './audit.js'
import { bad, conflict, safeEqual } from './util.js'

const get = (sql, ...p) => db.prepare(sql).get(...p)
const all = (sql, ...p) => db.prepare(sql).all(...p)

export const GUEST_ROW_CAP = 300 // guests per list
export const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/ // 22 base64url characters = 132 bit
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O, 1/I/L
const BAD_NAME = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/
const SEEN_EVERY = '-10 minutes' // last_seen_at / ip of a guest are refreshed at most this often on a plain GET

export const keyHash = (k) => createHash('sha256').update(String(k)).digest('hex')
/** Shape and a minimum of variety (rejects "aaaa..." and the like); real keys have ~18 distinct characters of 22 */
export const validKey = (k) => typeof k === 'string' && KEY_RE.test(k) && new Set(k).size >= 10
const headerKey = (req, name) => {
  const k = String(req.get?.(name) ?? '')
  return validKey(k) ? k : null
}
/** The guest key of a request (header only) */
export const sentKey = (req) => headerKey(req, 'x-guest-key')
/** The second key of a merge (the guest whose claims move over) */
export const sentMergeKey = (req) => headerKey(req, 'x-guest-merge-key')

const cleanIp = (ip) => (ip ? String(ip).replace(/^::ffff:/, '').slice(0, 64) : null)
const agentOf = (req) => {
  const ua = req.headers?.['user-agent']
  return ua ? String(ua).slice(0, 400) : null
}

/** A guest's display name: trimmed, one line, 1-60 characters, no control or direction characters. */
export function guestName(raw) {
  const n = String(raw ?? '').trim().replace(/ {2,}/g, ' ')
  if (!n) throw bad('Please enter your name', 'guest_name_required')
  if (n.length > 60 || BAD_NAME.test(n)) throw bad('This name is not allowed', 'guest_name_invalid')
  return n
}

const newCode = () => {
  for (let i = 0; i < 20; i++) {
    let c = 'G-'
    for (let j = 0; j < 6; j++) c += CODE_CHARS[randomInt(CODE_CHARS.length)]
    if (!get('SELECT 1 FROM wishlist_guests WHERE code=?', c)) return c
  }
  throw new Error('No free guest code')
}

/** The guest of this list that holds `key`, or null */
export const findGuest = (list, key) => (key ? get('SELECT * FROM wishlist_guests WHERE key_hash=? AND wishlist_id=?', keyHash(key), list.id) ?? null : null)

export const guestCount = (guestId) => get('SELECT COUNT(*) AS n FROM reservations WHERE guest_id=?', guestId).n

/** What the guest may know about themselves: code, name, number of active claims (never anything about others) */
export const guestSelf = (g) => (g ? { code: g.code, name: g.name, claims: guestCount(g.id) } : null)

/** Audit entry about a guest; carries list, owner and guest code so the admin views can search it and hide it from the list owner. */
export function auditGuest(req, action, { list, guest, details = {}, label }) {
  audit(req, action, {
    target: { type: 'guest', id: guest.id, label: guest.name },
    ...(label !== undefined ? { label } : {}),
    details: {
      wishlist_id: list.id,
      wishlist_title: list.title,
      owner_user_id: list.owner_user_id,
      guest_id: guest.id,
      guest_code: guest.code,
      guest_name: guest.name,
      ...details,
    },
  })
}

/** Creates the guest for `key` on this list (a caller checked guest_claims and the pace). Throws when the list has too many guests. */
export function createGuest(req, list, key, rawName) {
  const name = guestName(rawName)
  let g
  tx(() => {
    if (get('SELECT COUNT(*) AS n FROM wishlist_guests WHERE wishlist_id=?', list.id).n >= GUEST_ROW_CAP) {
      throw conflict('Too many guests on this list. Please sign in.', 'guest_limit')
    }
    // A key belongs to one guest of one list; browsers generate a fresh key per list, so a second use is a bug or an attack
    if (get('SELECT 1 FROM wishlist_guests WHERE key_hash=?', keyHash(key))) throw conflict('This guest key is already in use', 'guest_key_in_use')
    const id = Number(
      db
        .prepare('INSERT INTO wishlist_guests (wishlist_id, code, name, key_hash, ip, user_agent) VALUES (?,?,?,?,?,?)')
        .run(list.id, newCode(), name, keyHash(key), cleanIp(req.ip), agentOf(req)).lastInsertRowid,
    )
    g = get('SELECT * FROM wishlist_guests WHERE id=?', id)
  })
  auditGuest(req, 'guest.create', { list, guest: g, label: g.name })
  return g
}

/** A plain visit of a known guest: last_seen_at / ip / device at most every 10 minutes */
export function touchGuest(req, g) {
  db.prepare(`UPDATE wishlist_guests SET last_seen_at=datetime('now'), ip=?, user_agent=? WHERE id=? AND last_seen_at < datetime('now', '${SEEN_EVERY}')`).run(
    cleanIp(req.ip),
    agentOf(req),
    g.id,
  )
}

/** The guest changes their name; it applies to all their claims on the list. */
export function renameGuest(req, list, g, rawName) {
  const name = guestName(rawName)
  if (name === g.name) return g
  tx(() => {
    db.prepare('UPDATE wishlist_guests SET name=? WHERE id=?').run(name, g.id)
    db.prepare('UPDATE reservations SET guest_name=? WHERE guest_id=?').run(name, g.id)
  })
  auditGuest(req, 'guest.rename', { list, guest: { ...g, name }, details: { previous_name: g.name }, label: name })
  return { ...g, name }
}

/** Moves all claims of `from` to `into` (same list) and removes `from`. */
export function mergeGuests(req, list, into, from) {
  if (into.id === from.id || into.wishlist_id !== from.wishlist_id) throw bad('These are the same guest', 'guest_merge_same')
  let moved = 0
  tx(() => {
    moved = Number(db.prepare('UPDATE reservations SET guest_id=?, guest_name=? WHERE guest_id=?').run(into.id, into.name, from.id).changes)
    db.prepare('DELETE FROM wishlist_guests WHERE id=?').run(from.id)
  })
  auditGuest(req, 'guest.merge', { list, guest: into, details: { merged_guest_id: from.id, merged_guest_code: from.code, merged_guest_name: from.name, claims_moved: moved }, label: into.name })
  return moved
}

/** A signed-in user takes over the claims of a guest (the key proves they are the guest). The guest is removed. */
export function takeOverGuest(req, list, g) {
  const rows = all('SELECT id FROM reservations WHERE guest_id=?', g.id)
  tx(() => {
    db.prepare('UPDATE reservations SET user_id=?, guest_name=NULL, guest_id=NULL WHERE guest_id=?').run(req.user.id, g.id)
    db.prepare('DELETE FROM wishlist_guests WHERE id=?').run(g.id)
  })
  auditGuest(req, 'guest.takeover', { list, guest: g, details: { claims_taken: rows.length, user_id: req.user.id } })
  return rows.length
}

/** Does this key of the request belong to the guest row? (constant time, for places that already hold the row) */
export const keyMatches = (g, key) => !!g && !!key && safeEqual(keyHash(key), g.key_hash)
