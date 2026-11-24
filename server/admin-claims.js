// Admin > Reservations: who claimed which wish (current claims from `reservations`, released ones from the audit log), with IP and
// device, filters, CSV export, the admin actions "delete reservation" (single and several at once) and "delete guest", and the view of
// the guests of all lists (code, name, claims, first/last seen, IP, device).
//
// Surprise protection: an admin is often a list owner too. Claims on the requesting admin's OWN wishlists are hidden server-side
// (rows, counts, search hits, export) unless the admin deliberately reveals them with reveal_own=1 (confirmed in the UI; the reveal is
// logged). The "hidden" count is the total over all own-list claims and does not depend on any filter or search text, so filtering
// cannot be used to probe the hidden rows. See also audit.js (same rule for the audit log).
import { db, tx } from './db.js'
import { auditGuest } from './guests.js'
import { audit, csvRow, noteReveal, wantsReveal } from './audit.js'
import { describeUa, requireAdmin } from './session.js'
import { bad, notFound } from './util.js'

const ISO = (c) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${c})`

/** Common projection of active claims and released ones (audit entries) as one SQL source. */
function source() {
  return `(
    SELECT 'a' || r.id AS rid, 'active' AS state, strftime('%Y-%m-%dT%H:%M:%fZ', r.created_at) AS at,
      r.id AS reservation_id, r.wish_id AS wish_id, w.title AS wish_title, l.id AS list_id, l.title AS list_title,
      l.owner_user_id AS owner_id, ou.name AS owner_name, ou.email AS owner_email,
      r.user_id AS claimer_id, cu.name AS claimer_name, cu.email AS claimer_email, r.guest_name AS guest_name,
      r.ip AS ip, r.user_agent AS user_agent, NULL AS released_by, r.guest_id AS guest_id, g.code AS guest_code
    FROM reservations r
      LEFT JOIN wishlist_guests g ON g.id = r.guest_id
      JOIN wishes w ON w.id = r.wish_id
      JOIN wishlists l ON l.id = w.wishlist_id
      LEFT JOIN users ou ON ou.id = l.owner_user_id
      LEFT JOIN users cu ON cu.id = r.user_id
    UNION ALL
    SELECT 'l' || a.id, 'released', a.at,
      json_extract(a.details, '$.reservation_id'), CAST(a.target_id AS INTEGER), COALESCE(a.target_label, w.title),
      COALESCE(json_extract(a.details, '$.wishlist_id'), l.id), COALESCE(json_extract(a.details, '$.wishlist_title'), l.title),
      COALESCE(a.oid, l.owner_user_id), ou.name, ou.email,
      a.cid, cu.name, cu.email,
      CASE WHEN a.cid IS NULL THEN COALESCE(json_extract(a.details, '$.guest_name'), CASE WHEN a.action = 'wish.unreserve' THEN a.actor_label END) END,
      CASE WHEN a.by_other THEN NULL ELSE a.ip END, CASE WHEN a.by_other THEN NULL ELSE a.user_agent END,
      CASE WHEN a.by_other THEN COALESCE(ru.name, a.actor_label) END,
      CASE WHEN a.cid IS NULL THEN json_extract(a.details, '$.guest_id') END, CASE WHEN a.cid IS NULL THEN json_extract(a.details, '$.guest_code') END
    FROM (
      SELECT *, json_extract(details, '$.owner_user_id') AS oid,
        -- Released by somebody else (an admin, or the wish/list/account was deleted): the actor is not the claimer, nor is the IP theirs
        (action = 'admin.claim.release' OR json_extract(details, '$.reason') IS NOT NULL) AS by_other,
        CASE WHEN action = 'admin.claim.release' THEN json_extract(details, '$.claimed_by_user_id')
          WHEN json_extract(details, '$.reason') IS NOT NULL THEN json_extract(details, '$.reserved_by_user_id')
          ELSE actor_user_id END AS cid
      FROM audit_log WHERE action IN ('wish.unreserve', 'admin.claim.release') AND status = 'ok'
    ) a
      LEFT JOIN wishes w ON w.id = CAST(a.target_id AS INTEGER)
      LEFT JOIN wishlists l ON l.id = w.wishlist_id
      LEFT JOIN users ou ON ou.id = COALESCE(a.oid, l.owner_user_id)
      LEFT JOIN users cu ON cu.id = a.cid
      LEFT JOIN users ru ON ru.id = a.actor_user_id
  )`
}

const like = (s) => `%${String(s).slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`

function where(q, me, reveal) {
  const w = []
  const p = []
  const str = (k) => (typeof q[k] === 'string' && q[k].trim() ? q[k].trim() : null)
  if (!reveal) (w.push('COALESCE(owner_id, -1) != ?'), p.push(me))
  const state = str('state')
  if (state) {
    if (!['active', 'released'].includes(state)) throw Object.assign(bad('Invalid status'), { code: 'invalid_value' })
    w.push('state = ?')
    p.push(state)
  }
  const owner = str('owner_id')
  if (owner) (w.push('owner_id = ?'), p.push(Number(owner) || -1))
  const by = str('by')
  if (by) {
    if (!['user', 'guest'].includes(by)) throw Object.assign(bad('Invalid value'), { code: 'invalid_value' })
    w.push(by === 'user' ? 'claimer_id IS NOT NULL' : 'claimer_id IS NULL')
  }
  const ip = str('ip')
  if (ip) {
    const v = ip.slice(0, 64)
    if (v.endsWith('*')) (w.push("ip LIKE ? ESCAPE '\\'"), p.push(v.slice(0, -1).replace(/[%_\\]/g, '\\$&') + '%'))
    else (w.push('ip = ?'), p.push(v))
  }
  const guest = str('guest')
  if (guest) (w.push('guest_code = ?'), p.push(guest.slice(0, 20).toUpperCase()))
  const text = str('q')
  if (text) {
    const cols = ['wish_title', 'list_title', 'owner_name', 'owner_email', 'claimer_name', 'claimer_email', 'guest_name', 'guest_code', 'ip']
    w.push('(' + cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')')
    for (let i = 0; i < cols.length; i++) p.push(like(text))
  }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', p }
}

const person = (id, name, email) => (id != null || name || email ? { id: id ?? null, name: name ?? null, email: email ?? null } : null)
const shape = (r) => ({
  key: r.rid,
  state: r.state,
  at: r.at,
  reservation_id: r.reservation_id ?? null,
  wish_id: r.wish_id ?? null,
  wish_title: r.wish_title ?? null,
  list_id: r.list_id ?? null,
  list_title: r.list_title ?? null,
  owner: person(r.owner_id, r.owner_name, r.owner_email),
  claimed_by: person(r.claimer_id, r.claimer_name, r.claimer_email),
  guest: r.claimer_id == null,
  guest_name: r.claimer_id == null ? r.guest_name ?? null : null,
  guest_id: r.claimer_id == null ? r.guest_id ?? null : null,
  guest_code: r.claimer_id == null ? r.guest_code ?? null : null,
  ip: r.ip ?? null,
  user_agent: r.user_agent ?? null,
  device: r.user_agent ? describeUa(r.user_agent).device : null,
  released_by: r.released_by ?? null,
})

const ORDER = 'ORDER BY at DESC, rid DESC'

export function listClaims(q, me, reveal) {
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 25))
  const page = Math.max(1, Math.floor(Number(q.page)) || 1)
  const src = source()
  const f = where(q, me, reveal)
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${src} ${f.sql}`).get(...f.p).n
  const rows = db.prepare(`SELECT * FROM ${src} ${f.sql} ${ORDER} LIMIT ? OFFSET ?`).all(...f.p, limit, (page - 1) * limit)
  // Total of all claims on the admin's own lists, independent of filters and search text (no probing)
  const hidden = reveal ? 0 : db.prepare(`SELECT COUNT(*) AS n FROM ${src} WHERE owner_id = ?`).get(me).n
  return { items: rows.map(shape), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), hidden_own: hidden, reveal_own: reveal }
}

const COLS = ['at', 'state', 'wish', 'wish_id', 'list', 'list_owner', 'claimed_by', 'guest', 'guest_code', 'ip', 'device', 'released_by']

export function claimsRoutes(app) {
  const A = requireAdmin

  app.get('/api/admin/claims', A, (req, res) => {
    const reveal = wantsReveal(req.query)
    if (reveal) noteReveal(req, 'claims')
    res.json(listClaims(req.query, req.user.id, reveal))
  })

  app.get('/api/admin/claims/export', A, (req, res) => {
    const reveal = wantsReveal(req.query)
    audit(req, 'admin.claims.export', { details: { reveal_own: reveal, state: req.query.state || null, has_search: !!req.query.q } })
    const f = where(req.query, req.user.id, reveal)
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="wishy-claims-${stamp}.csv"`)
    res.write('﻿' + csvRow(COLS))
    const rows = db.prepare(`SELECT * FROM ${source()} ${f.sql} ${ORDER} LIMIT 50000`).all(...f.p).map(shape)
    for (const r of rows) {
      res.write(
        csvRow([
          r.at, r.state, r.wish_title, r.wish_id, r.list_title, r.owner ? r.owner.name || r.owner.email : '',
          r.guest ? r.guest_name : r.claimed_by ? r.claimed_by.name || r.claimed_by.email : '', r.guest ? 'yes' : 'no', r.guest_code, r.ip, r.device, r.released_by,
        ]),
      )
    }
    res.end()
  })

  const claimRow = (id) =>
    Number.isInteger(id)
      ? db
        .prepare(
          `SELECT r.*, g.code AS guest_code, w.title AS wish_title, l.id AS list_id, l.title AS list_title, l.owner_user_id AS owner_id
           FROM reservations r LEFT JOIN wishlist_guests g ON g.id=r.guest_id JOIN wishes w ON w.id=r.wish_id JOIN wishlists l ON l.id=w.wishlist_id WHERE r.id=?`,
        )
        .get(id)
      : null
  /** Deletes one claim and logs it (admin.claim.release). The caller checked that the admin may reach it. */
  const deleteClaim = (req, r, extra = {}) => {
    tx(() => {
      db.prepare('DELETE FROM reservations WHERE id=?').run(r.id)
      if (r.gift_id) db.prepare("DELETE FROM gifts WHERE id=? AND status='planned'").run(r.gift_id)
    })
    audit(req, 'admin.claim.release', {
      target: { type: 'wish', id: r.wish_id, label: r.wish_title },
      details: {
        wishlist_id: r.list_id,
        wishlist_title: r.list_title,
        owner_user_id: r.owner_id,
        reservation_id: r.id,
        ...(r.user_id ? { claimed_by_user_id: r.user_id } : { guest_name: r.guest_name, ...(r.guest_id ? { guest_id: r.guest_id, guest_code: r.guest_code } : {}) }),
        ...extra,
      },
    })
  }
  // A claim on the admin's own list is only reachable after the deliberate reveal (otherwise it does not exist for them)
  const reachable = (req, r, reveal) => !!r && (r.owner_id !== req.user.id || reveal)

  // Delete a current reservation (admin action, logged as admin.claim.release): the wish is free again and the person who reserved it
  // sees it as free. A planned gift that came with it is removed as well.
  app.post('/api/admin/claims/:id/release', A, (req, res) => {
    const reveal = wantsReveal(req.query) || wantsReveal(req.body)
    const r = claimRow(Number(req.params.id))
    if (!reachable(req, r, reveal)) throw notFound('Claim not found', 'claim_not_found')
    if (r.owner_id === req.user.id) noteReveal(req, 'claims')
    deleteClaim(req, r)
    res.json({ ok: true })
  })

  // Several at once. Claims that do not exist (any more) or that the admin may not reach count as "skipped", all alike.
  app.post('/api/admin/claims/delete', A, (req, res) => {
    const reveal = wantsReveal(req.query) || wantsReveal(req.body)
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))].slice(0, 200) : []
    if (!ids.length) throw Object.assign(bad('Nothing selected'), { code: 'invalid_value' })
    let deleted = 0
    for (const id of ids) {
      const r = claimRow(id)
      if (!reachable(req, r, reveal)) continue
      if (r.owner_id === req.user.id) noteReveal(req, 'claims')
      deleteClaim(req, r, { bulk: ids.length })
      deleted++
    }
    res.json({ ok: true, deleted, skipped: ids.length - deleted })
  })

  // ---- Guests of all lists
  const guestSource = () => `(
    SELECT g.id AS id, g.code AS code, g.name AS name, g.wishlist_id AS list_id, l.title AS list_title, l.owner_user_id AS owner_id,
      ou.name AS owner_name, ou.email AS owner_email, ${ISO('g.created_at')} AS created_at, ${ISO('g.last_seen_at')} AS last_seen_at,
      g.ip AS ip, g.user_agent AS user_agent, (SELECT COUNT(*) FROM reservations r WHERE r.guest_id = g.id) AS claims
    FROM wishlist_guests g JOIN wishlists l ON l.id = g.wishlist_id LEFT JOIN users ou ON ou.id = l.owner_user_id
  )`
  const guestWhere = (q, me, reveal) => {
    const w = []
    const p = []
    const str = (k) => (typeof q[k] === 'string' && q[k].trim() ? q[k].trim() : null)
    if (!reveal) (w.push('COALESCE(owner_id, -1) != ?'), p.push(me))
    if (str('active') === '1') w.push('claims > 0')
    const code = str('guest')
    if (code) (w.push('code = ?'), p.push(code.slice(0, 20).toUpperCase()))
    const ip = str('ip')
    if (ip) {
      const v = ip.slice(0, 64)
      if (v.endsWith('*')) (w.push("ip LIKE ? ESCAPE '\\'"), p.push(v.slice(0, -1).replace(/[%_\\]/g, '\\$&') + '%'))
      else (w.push('ip = ?'), p.push(v))
    }
    const text = str('q')
    if (text) {
      const cols = ['code', 'name', 'list_title', 'owner_name', 'owner_email', 'ip']
      w.push('(' + cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')')
      for (let i = 0; i < cols.length; i++) p.push(like(text))
    }
    return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', p }
  }
  app.get('/api/admin/guests', A, (req, res) => {
    const reveal = wantsReveal(req.query)
    if (reveal) noteReveal(req, 'claims')
    const q = req.query
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25))
    const page = Math.max(1, Math.floor(Number(q.page)) || 1)
    const f = guestWhere(q, req.user.id, reveal)
    const src = guestSource()
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${src} ${f.sql}`).get(...f.p).n
    const rows = db.prepare(`SELECT * FROM ${src} ${f.sql} ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?`).all(...f.p, limit, (page - 1) * limit)
    const hidden = reveal ? 0 : db.prepare(`SELECT COUNT(*) AS n FROM ${src} WHERE owner_id = ?`).get(req.user.id).n
    res.json({
      items: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, list_id: r.list_id, list_title: r.list_title,
        owner: person(r.owner_id, r.owner_name, r.owner_email), claims: r.claims, created_at: r.created_at, last_seen_at: r.last_seen_at,
        ip: r.ip ?? null, user_agent: r.user_agent ?? null, device: r.user_agent ? describeUa(r.user_agent).device : null,
      })),
      total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), hidden_own: hidden, reveal_own: reveal,
    })
  })

  // Delete a guest: all their active reservations go (each logged as admin.claim.release), the guest is gone and so is their personal
  // link (a browser that still holds the key simply starts as a new guest). The history of ended reservations is the audit log and
  // follows its retention; it is not rewritten here.
  app.delete('/api/admin/guests/:id', A, (req, res) => {
    const reveal = wantsReveal(req.query) || wantsReveal(req.body)
    const id = Number(req.params.id)
    const g = Number.isInteger(id)
      ? db.prepare('SELECT g.*, l.title AS list_title, l.owner_user_id AS owner_id FROM wishlist_guests g JOIN wishlists l ON l.id=g.wishlist_id WHERE g.id=?').get(id)
      : null
    if (!reachable(req, g, reveal)) throw notFound('Guest not found', 'guest_not_found')
    if (g.owner_id === req.user.id) noteReveal(req, 'claims')
    const claims = db.prepare('SELECT id FROM reservations WHERE guest_id=? ORDER BY id').all(g.id)
    for (const c of claims) {
      const r = claimRow(c.id)
      if (r) deleteClaim(req, r, { reason: 'guest_deleted' })
    }
    db.prepare('DELETE FROM wishlist_guests WHERE id=?').run(g.id)
    auditGuest(req, 'admin.guest.delete', { list: { id: g.wishlist_id, title: g.list_title, owner_user_id: g.owner_id }, guest: g, details: { claims_deleted: claims.length } })
    res.json({ ok: true, deleted: claims.length })
  })
}
