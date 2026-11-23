import { db, tx, insert, setGiftLinks, logGiftEvent, ACCESS_OK_SQL, syncSpaceAccessForList } from './db.js'
import { baseUrl } from './config.js'
import { requireAuth } from './session.js'
import { spaceCtx, memberPermissions } from './spaces.js'
import { requirePermission } from './permissions.js'
import { bad, notFound, forbidden, conflict, newToken, reqId, numId, cleanEmail } from './util.js'
import { noteCreated, noteRef } from './ops-sink.js'

const iso = () => new Date().toISOString()
const get = (sql, ...p) => db.prepare(sql).get(...p)
const all = (sql, ...p) => db.prepare(sql).all(...p)
const bump = (id) => db.prepare('UPDATE wishlists SET updated_at=? WHERE id=?').run(iso(), id)

// ---------- Helpers ----------
export const counts = (id) =>
  get(
    "SELECT COUNT(CASE WHEN status!='removed' THEN 1 END) AS wish_count, COUNT(CASE WHEN status='open' THEN 1 END) AS open_count FROM wishes WHERE wishlist_id=?",
    id,
  )

/** The user's kind of access to a list: 'owner' | 'direct' | 'space' | 'link' | null */
export function viaFor(list, userId) {
  if (!userId) return null
  if (list.owner_user_id === userId) return 'owner'
  if (list.archived) return null
  const a = get('SELECT via FROM wishlist_access WHERE wishlist_id=? AND user_id=?', list.id, userId)
  if (!a) return null
  if (a.via === 'direct') return 'direct'
  if (a.via === 'space' || a.via === 'link') {
    if (spaceNameFor(list.id, userId)) return 'space'
    if (a.via === 'link' && list.link_enabled) return 'link'
  }
  return null
}
const spaceNameFor = (listId, userId) =>
  get(
    'SELECT sp.name FROM wishlist_space_access s JOIN space_members m ON m.space_id=s.space_id AND m.user_id=? JOIN spaces sp ON sp.id=s.space_id WHERE s.wishlist_id=? ORDER BY sp.name LIMIT 1',
    userId, listId,
  )?.name ?? null

export const loadList = (id) => get('SELECT * FROM wishlists WHERE id=?', id)

function myListView(req, l) {
  const url = `/w/${l.share_token}`
  return {
    id: l.id,
    title: l.title,
    description: l.description,
    event_date: l.event_date,
    archived: !!l.archived,
    link_enabled: !!l.link_enabled,
    token: l.share_token,
    url,
    full_url: baseUrl(req) + url,
    ...counts(l.id),
    access: all(
      "SELECT a.user_id, u.name, a.via FROM wishlist_access a JOIN users u ON u.id=a.user_id WHERE a.wishlist_id=? AND a.via!='space' ORDER BY u.name COLLATE NOCASE",
      l.id,
    ),
    spaces: all(
      'SELECT s.space_id, sp.name, (SELECT COUNT(*) FROM space_members m WHERE m.space_id=s.space_id) AS member_count FROM wishlist_space_access s JOIN spaces sp ON sp.id=s.space_id WHERE s.wishlist_id=? ORDER BY sp.name COLLATE NOCASE',
      l.id,
    ),
    updated_at: l.updated_at,
  }
}

function summaryView(l, userId) {
  const a = get('SELECT via, seen_at FROM wishlist_access WHERE wishlist_id=? AND user_id=?', l.id, userId)
  const o = get('SELECT id, name FROM users WHERE id=?', l.owner_user_id)
  const spaceName = a?.via === 'direct' ? null : spaceNameFor(l.id, userId)
  return {
    id: l.id,
    title: l.title,
    description: l.description,
    event_date: l.event_date,
    owner: { id: o.id, name: o.name },
    ...counts(l.id),
    via: spaceName ? 'space' : (a?.via ?? null),
    space_name: spaceName,
    is_new: !!a && (!a.seen_at || l.updated_at > a.seen_at),
    updated_at: l.updated_at,
  }
}

export const WISH_COLS = ['id', 'title', 'notes', 'url', 'price', 'currency', 'image_url', 'priority', 'status', 'created_at']
export const plainWish = (w) => Object.fromEntries(WISH_COLS.map((c) => [c, w[c]]))

/** Wishes from a viewer's point of view; NEVER with reservation info for the owner. */
export function wishesView(list, viewer) {
  const rows = all('SELECT * FROM wishes WHERE wishlist_id=? ORDER BY sort, id', list.id)
  if (viewer.userId != null && viewer.userId === list.owner_user_id) return rows.map(plainWish)
  const resv = new Map()
  for (const r of all(
    'SELECT r.*, u.name AS user_name FROM reservations r LEFT JOIN users u ON u.id=r.user_id WHERE r.wish_id IN (SELECT id FROM wishes WHERE wishlist_id=?)',
    list.id,
  )) {
    resv.set(r.wish_id, r)
  }
  const guest = viewer.guestName ? String(viewer.guestName).trim().toLowerCase() : null
  return rows
    .filter((w) => w.status !== 'removed')
    .map((w) => {
      const r = resv.get(w.id)
      return {
        ...plainWish(w),
        reserved: !!r,
        reserved_by: r ? (r.user_id ? r.user_name : r.guest_name) : null,
        reserved_by_me: !!r && ((viewer.userId != null && r.user_id === viewer.userId) || (!r.user_id && !!guest && r.guest_name?.toLowerCase() === guest)),
      }
    })
}

function detailView(req, list, { touch = false } = {}) {
  const uid = req.user.id
  if (list.owner_user_id === uid) {
    return { wishlist: myListView(req, list), wishes: wishesView(list, { userId: uid }), is_owner: true }
  }
  if (touch) db.prepare('UPDATE wishlist_access SET seen_at=? WHERE wishlist_id=? AND user_id=?').run(iso(), list.id, uid)
  const body = { wishlist: summaryView(list, uid), wishes: wishesView(list, { userId: uid }), is_owner: false }
  return body
}

function publicView(req, list) {
  const uid = req.user?.id ?? null
  const owner = get('SELECT id, name FROM users WHERE id=?', list.owner_user_id)
  const isOwner = uid === list.owner_user_id
  const guestName = req.query?.guest_name ? String(req.query.guest_name) : req.body?.guest_name
  let wishes = wishesView(list, { userId: uid, guestName })
  if (isOwner) wishes = wishes.filter((w) => w.status !== 'removed')
  return {
    wishlist: { id: list.id, title: list.title, description: list.description, event_date: list.event_date },
    owner: { id: owner.id, name: owner.name },
    is_owner: isOwner,
    logged_in: uid != null,
    following: uid != null && !!get('SELECT 1 FROM wishlist_access WHERE wishlist_id=? AND user_id=?', list.id, uid),
    wishes,
  }
}

function listByToken(token) {
  const l = get(
    'SELECT w.* FROM wishlists w JOIN users u ON u.id=w.owner_user_id AND u.disabled=0 WHERE w.share_token=? AND w.link_enabled=1 AND w.archived=0',
    String(token),
  )
  if (!l) throw notFound('This wishlist is no longer shared', 'list_not_shared')
  return l
}

function ownedList(req, id) {
  const l = loadList(reqId(id, 'Wishlist not found', 'wishlist_not_found'))
  if (!l || l.owner_user_id !== req.user.id) throw notFound('Wishlist not found', 'wishlist_not_found')
  return l
}
function ownedWish(req, id) {
  const w = get('SELECT w.*, l.owner_user_id FROM wishes w JOIN wishlists l ON l.id=w.wishlist_id WHERE w.id=?', reqId(id, 'Wish not found', 'wish_not_found'))
  if (!w || w.owner_user_id !== req.user.id) throw notFound('Wish not found', 'wish_not_found')
  return w
}

/** Current response of an offline-capable route for a repeated op (see offline-ops.js); 404 when the target is gone or not the user's. */
export function replayView(req, kind, id) {
  if (kind === 'list') return myListView(req, ownedList(req, id))
  if (kind === 'detail') return detailView(req, ownedList(req, id))
  if (kind === 'wish') return detailView(req, loadList(ownedWish(req, id).wishlist_id))
  throw new Error(`unknown view ${kind}`)
}

export function createWishlist(userId, { title, description, event_date } = {}) {
  const t = String(title ?? '').trim().slice(0, 120)
  if (!t) throw bad('Please enter a title', 'title_required')
  const now = iso()
  const sort = (get('SELECT COALESCE(MAX(sort),-1)+1 AS n FROM wishlists WHERE owner_user_id=?', userId).n)
  return Number(
    db
      .prepare('INSERT INTO wishlists (owner_user_id,title,description,event_date,share_token,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(userId, t, description ? String(description).slice(0, 1000) : null, event_date || null, newToken(), sort, now, now).lastInsertRowid,
  )
}

export function addWish(listId, data) {
  const now = iso()
  const sort = get('SELECT COALESCE(MAX(sort),-1)+1 AS n FROM wishes WHERE wishlist_id=?', listId).n
  const id = Number(
    db
      .prepare(
        'INSERT INTO wishes (wishlist_id,title,notes,url,price,currency,image_url,priority,status,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(listId, data.title, data.notes ?? null, data.url ?? null, data.price ?? null, data.currency ?? null, data.image_url ?? null, data.priority ?? 2, data.status ?? 'open', sort, now, now).lastInsertRowid,
  )
  bump(listId)
  return id
}

const str = (v, max) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max))
export function wishData(b, partial) {
  const out = {}
  if (!partial || b.title !== undefined) {
    const t = String(b.title ?? '').trim()
    if (!t) throw bad('Please enter a title', 'title_required')
    out.title = t.slice(0, 300)
  }
  if (b.notes !== undefined) out.notes = str(b.notes, 4000)
  if (b.url !== undefined) out.url = str(b.url, 2000)
  if (b.currency !== undefined) out.currency = str(b.currency, 8)
  if (b.image_url !== undefined) out.image_url = str(b.image_url, 2000)
  if (b.price !== undefined) {
    if (b.price === null || b.price === '') out.price = null
    else {
      const n = Number(b.price)
      if (!Number.isFinite(n) || n < 0) throw bad('Invalid price', 'invalid_price')
      out.price = n
    }
  }
  if (b.priority !== undefined) out.priority = Math.min(3, Math.max(1, Math.round(Number(b.priority)) || 2))
  if (b.status !== undefined) {
    if (!['open', 'received', 'removed'].includes(b.status)) throw bad('Invalid status', 'invalid_status')
    out.status = b.status
  }
  return out
}
function updateRow(table, id, data, extra = {}) {
  const d = { ...data, ...extra }
  const cols = Object.keys(d)
  if (cols.length) db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => d[c]), id)
}

/** App users the current user may pick - never all users. */
function knownUsers(me) {
  return all(
    `SELECT u.id, u.name, u.email FROM users u WHERE u.disabled=0 AND u.id!=? AND (
       u.id IN (SELECT m2.user_id FROM space_members m1 JOIN space_members m2 ON m1.space_id=m2.space_id WHERE m1.user_id=?)
       OR u.id IN (SELECT w.owner_user_id FROM wishlist_access a JOIN wishlists w ON w.id=a.wishlist_id WHERE a.user_id=?)
       OR u.id IN (SELECT a.user_id FROM wishlist_access a JOIN wishlists w ON w.id=a.wishlist_id WHERE w.owner_user_id=?)
     ) ORDER BY u.name COLLATE NOCASE`,
    me, me, me, me,
  )
}

// ---------- For persons in the state ----------
const visibleListsOf = (ownerId, viewerId) =>
  all(
    `SELECT w.* FROM wishlists w JOIN wishlist_access a ON a.wishlist_id=w.id AND a.user_id=?
     WHERE w.owner_user_id=? AND w.archived=0 AND ${ACCESS_OK_SQL} ORDER BY w.sort, w.id`,
    viewerId, ownerId,
  )
export const linkedWishlists = (ownerId, viewerId) =>
  visibleListsOf(ownerId, viewerId).map((l) => ({ id: l.id, title: l.title, ...counts(l.id) }))
export const hasAccessToOwner = (ownerId, viewerId) => visibleListsOf(ownerId, viewerId).length > 0

// ---------- Reservation resolution ----------
function resolveWish(req, wishId, body) {
  const w = get('SELECT * FROM wishes WHERE id=?', reqId(wishId, 'Wish not found', 'wish_not_found'))
  if (!w) throw notFound('Wish not found', 'wish_not_found')
  const list = loadList(w.wishlist_id)
  const user = req.user
  if (user && user.id === list.owner_user_id) throw forbidden('You cannot reserve your own wishes', 'own_wish_reserve')
  const token = body.token ?? req.query?.token
  let mode
  if (token) {
    if (String(token) !== list.share_token || !list.link_enabled || list.archived) throw notFound('This wishlist is no longer shared', 'list_not_shared')
    mode = 'token'
  } else {
    if (!user || !viaFor(list, user.id)) throw notFound('Wish not found', 'wish_not_found')
    mode = 'access'
  }
  if (w.status === 'removed') throw notFound('Wish not found', 'wish_not_found')
  return { wish: w, list, mode, user }
}
const respond = (req, r) => (r.mode === 'token' ? publicView(req, r.list) : detailView(req, r.list))

// ---------- Routes ----------
export function wishlistRoutes(app) {
  app.get('/api/wishlists', requireAuth, (req, res) => {
    const uid = req.user.id
    const mine = all('SELECT * FROM wishlists WHERE owner_user_id=? ORDER BY archived, sort, id', uid).map((l) => myListView(req, l))
    const shared = all(
      `SELECT w.* FROM wishlist_access a JOIN wishlists w ON w.id=a.wishlist_id
       JOIN users o ON o.id=w.owner_user_id AND o.disabled=0
       WHERE a.user_id=? AND w.archived=0 AND ${ACCESS_OK_SQL}
       ORDER BY o.name COLLATE NOCASE, w.sort, w.id`,
      uid,
    ).map((l) => summaryView(l, uid))
    res.json({ mine, shared })
  })

  app.post('/api/wishlists', requireAuth, (req, res) => {
    const id = noteCreated(createWishlist(req.user.id, req.body))
    res.json(myListView(req, loadList(id)))
  })

  app.get('/api/users/known', requireAuth, (req, res) => res.json(knownUsers(req.user.id)))

  app.get('/api/wishlists/:id', requireAuth, (req, res) => {
    const list = loadList(reqId(req.params.id, 'Wishlist not found', 'wishlist_not_found'))
    if (!list || !viaFor(list, req.user.id)) throw notFound('Wishlist not found', 'wishlist_not_found')
    res.json(detailView(req, list, { touch: req.query.prefetch === undefined })) // the client's background copy for offline use does not count as "seen"
  })

  app.put('/api/wishlists/:id', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    const b = req.body || {}
    const d = {}
    if (b.title !== undefined) {
      const t = String(b.title).trim()
      if (!t) throw bad('Please enter a title', 'title_required')
      d.title = t.slice(0, 120)
    }
    if (b.description !== undefined) d.description = str(b.description, 1000)
    if (b.event_date !== undefined) d.event_date = b.event_date || null
    if (b.archived !== undefined) d.archived = b.archived ? 1 : 0
    if (b.sort !== undefined && Number.isFinite(Number(b.sort))) d.sort = Number(b.sort)
    updateRow('wishlists', l.id, d, { updated_at: iso() })
    res.json(myListView(req, loadList(l.id)))
  })

  app.delete('/api/wishlists/:id', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    tx(() => {
      db.prepare('UPDATE gifts SET wish_id=NULL WHERE wish_id IN (SELECT id FROM wishes WHERE wishlist_id=?)').run(l.id)
      db.prepare('DELETE FROM wishlists WHERE id=?').run(l.id)
    })
    res.json({ ok: true })
  })

  app.get('/api/wishlists/:id/export', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    res.setHeader('Content-Disposition', 'attachment; filename="wishlist-list.json"')
    res.json({
      app: 'wishlist-list',
      version: 1,
      exported_at: iso(),
      wishlist: { title: l.title, description: l.description, event_date: l.event_date },
      wishes: all('SELECT * FROM wishes WHERE wishlist_id=? ORDER BY sort, id', l.id).map(plainWish),
    })
  })

  // ---- Wishes ----
  app.post('/api/wishlists/:id/wishes', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    noteCreated(addWish(l.id, wishData(req.body || {}, false)))
    res.json(detailView(req, loadList(l.id)))
  })
  app.put('/api/wishes/:id', requireAuth, (req, res) => {
    const w = ownedWish(req, req.params.id)
    tx(() => {
      updateRow('wishes', w.id, wishData(req.body || {}, true), { updated_at: iso() })
      bump(w.wishlist_id)
    })
    res.json(detailView(req, loadList(w.wishlist_id)))
  })
  app.delete('/api/wishes/:id', requireAuth, (req, res) => {
    const w = ownedWish(req, req.params.id)
    noteRef(w.wishlist_id)
    tx(() => {
      db.prepare('DELETE FROM wishes WHERE id=?').run(w.id)
      bump(w.wishlist_id)
    })
    res.json(detailView(req, loadList(w.wishlist_id)))
  })
  app.post('/api/wishlists/:id/reorder', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    const ids = req.body?.ids
    if (!Array.isArray(ids)) throw bad('Invalid order', 'order_invalid')
    tx(() => {
      ids.forEach((raw, i) => {
        const wid = numId(raw)
        if (Number.isNaN(wid) || !get('SELECT 1 FROM wishes WHERE id=? AND wishlist_id=?', wid, l.id)) throw notFound('Wish not found', 'wish_not_found')
        db.prepare('UPDATE wishes SET sort=? WHERE id=?').run(i, wid)
      })
      bump(l.id)
    })
    res.json(detailView(req, loadList(l.id)))
  })

  // ---- Sharing (owner) ----
  app.post('/api/wishlists/:id/share', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    const b = req.body || {}
    tx(() => {
      if (b.link_enabled !== undefined) db.prepare('UPDATE wishlists SET link_enabled=? WHERE id=?').run(b.link_enabled ? 1 : 0, l.id)
      if (b.regenerate) db.prepare('UPDATE wishlists SET share_token=? WHERE id=?').run(newToken(), l.id)
      // Without a valid link, link followers lose access; direct shares stay
      const now = loadList(l.id)
      if (!now.link_enabled || b.regenerate) db.prepare("DELETE FROM wishlist_access WHERE wishlist_id=? AND via='link'").run(l.id)
      syncSpaceAccessForList(l.id)
    })
    res.json(myListView(req, loadList(l.id)))
  })

  app.post('/api/wishlists/:id/access', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    const b = req.body || {}
    let target
    if (b.user_id !== undefined && b.user_id !== null && b.user_id !== '') {
      const uid = numId(b.user_id)
      target = knownUsers(req.user.id).find((u) => u.id === uid)
      if (!target) throw notFound('User not found', 'user_not_found')
    } else {
      const email = cleanEmail(b.email)
      target = get('SELECT id FROM users WHERE email=? AND disabled=0', email)
      if (!target) throw notFound('No user with this email - share the link instead.', 'user_email_not_found')
    }
    if (target.id === req.user.id) throw bad('That is your own account', 'own_account')
    tx(() => {
      db.prepare("INSERT INTO wishlist_access (wishlist_id,user_id,via,added_by) VALUES (?,?,'direct',?) ON CONFLICT(wishlist_id,user_id) DO UPDATE SET via='direct'").run(
        l.id, target.id, req.user.id,
      )
    })
    res.json(myListView(req, loadList(l.id)))
  })
  // ---- Share with a whole space ----
  app.post('/api/wishlists/:id/spaces', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    const sid = numId(req.body?.space_id)
    const sp = Number.isNaN(sid)
      ? null
      : get('SELECT s.* FROM spaces s JOIN space_members m ON m.space_id=s.id AND m.user_id=? WHERE s.id=?', req.user.id, sid)
    if (!sp) throw notFound('Space not found', 'space_not_found')
    if (sp.personal) throw bad('Cannot share with the personal space', 'personal_space_share')
    requirePermission({ permissions: memberPermissions(sp.id, req.user.id) }, 'share_wishlists')
    tx(() => {
      db.prepare('INSERT OR IGNORE INTO wishlist_space_access (wishlist_id,space_id,added_by) VALUES (?,?,?)').run(l.id, sp.id, req.user.id)
      syncSpaceAccessForList(l.id)
    })
    res.json(myListView(req, loadList(l.id)))
  })
  app.delete('/api/wishlists/:id/spaces/:spaceId', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    const sid = reqId(req.params.spaceId, 'Space not found', 'space_not_found')
    tx(() => {
      db.prepare('DELETE FROM wishlist_space_access WHERE wishlist_id=? AND space_id=?').run(l.id, sid)
      syncSpaceAccessForList(l.id)
    })
    res.json(myListView(req, loadList(l.id)))
  })

  // "me" must be registered before ":userId"
  app.delete('/api/wishlists/:id/access/me', requireAuth, (req, res) => {
    const id = reqId(req.params.id, 'Wishlist not found', 'wishlist_not_found')
    db.prepare('DELETE FROM wishlist_access WHERE wishlist_id=? AND user_id=?').run(id, req.user.id)
    res.json({ ok: true })
  })
  app.delete('/api/wishlists/:id/access/:userId', requireAuth, (req, res) => {
    const l = ownedList(req, req.params.id)
    db.prepare('DELETE FROM wishlist_access WHERE wishlist_id=? AND user_id=?').run(l.id, reqId(req.params.userId, 'User not found', 'user_not_found'))
    syncSpaceAccessForList(l.id)
    res.json(myListView(req, loadList(l.id)))
  })

  // ---- Public link ----
  app.get('/api/shared/:token', (req, res) => res.json(publicView(req, listByToken(req.params.token))))

  app.post('/api/shared/:token/follow', requireAuth, (req, res) => {
    const l = listByToken(req.params.token)
    if (l.owner_user_id === req.user.id) throw bad('That is your own wishlist', 'own_wishlist')
    db.prepare("INSERT OR IGNORE INTO wishlist_access (wishlist_id,user_id,via,added_by) VALUES (?,?,'link',NULL)").run(l.id, req.user.id)
    res.json(publicView(req, l))
  })
  app.delete('/api/shared/:token/follow', requireAuth, (req, res) => {
    const l = listByToken(req.params.token)
    db.prepare("DELETE FROM wishlist_access WHERE wishlist_id=? AND user_id=? AND via='link'").run(l.id, req.user.id)
    res.json(publicView(req, l))
  })

  // ---- Reservations ----
  app.post('/api/wishes/:id/reserve', (req, res) => {
    const body = req.body || {}
    const r = resolveWish(req, req.params.id, body)
    const { wish, list, user } = r
    if (wish.status !== 'open') throw bad('This wish is no longer available', 'wish_unavailable')
    const guest = String(body.guest_name ?? '').trim().slice(0, 60)
    if (!user && !guest) throw bad('Please enter your name', 'guest_name_required')
    if (body.plan && !user) throw bad('You must be signed in to plan it', 'login_required_plan')
    tx(() => {
      if (get('SELECT 1 FROM reservations WHERE wish_id=?', wish.id)) throw conflict('This wish is already reserved', 'wish_reserved')
      let giftId = null
      if (body.plan) {
        const ctx = spaceCtx(req)
        const owner = get('SELECT id FROM persons WHERE space_id=? AND linked_user_id=? LIMIT 1', ctx.spaceId, list.owner_user_id)
        const me = get('SELECT id FROM persons WHERE space_id=? AND linked_user_id=? LIMIT 1', ctx.spaceId, user.id)
        giftId = insert(
          'gifts',
          { title: wish.title, url: wish.url, price: wish.price, image_url: wish.image_url, status: 'planned', payer_id: me?.id, wish_id: wish.id },
          ctx.spaceId,
        )
        logGiftEvent(giftId, user.id, 'created', { title: wish.title })
        setGiftLinks(giftId, { recipient_ids: owner ? [owner.id] : [], givers: me ? [{ person_id: me.id }] : [] })
      }
      db.prepare('INSERT INTO reservations (wish_id, user_id, guest_name, gift_id) VALUES (?,?,?,?)').run(
        wish.id, user ? user.id : null, user ? null : guest, giftId,
      )
    })
    res.json(respond(req, r))
  })

  app.delete('/api/wishes/:id/reserve', (req, res) => {
    const body = req.body || {}
    const r = resolveWish(req, req.params.id, body)
    const resv = get('SELECT * FROM reservations WHERE wish_id=?', r.wish.id)
    if (resv) {
      let allowed = false
      if (r.user && resv.user_id === r.user.id) allowed = true
      else if (!r.user && !resv.user_id && resv.guest_name) {
        const g = String(body.guest_name ?? req.query?.guest_name ?? '').trim().toLowerCase()
        allowed = !!g && g === resv.guest_name.toLowerCase()
      }
      if (!allowed) throw forbidden('Only the person who reserved it can cancel the reservation', 'reservation_not_yours')
      tx(() => {
        db.prepare('DELETE FROM reservations WHERE id=?').run(resv.id)
        if (resv.gift_id) db.prepare("DELETE FROM gifts WHERE id=? AND status='planned'").run(resv.gift_id)
      })
    }
    res.json(respond(req, r))
  })
}
