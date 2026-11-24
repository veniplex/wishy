import { db, tx, insert, setGiftLinks, logGiftEvent, ACCESS_OK_SQL, syncSpaceAccessForList } from './db.js'
import { baseUrl, getSys, defaultLocale } from './config.js'
import { requireAuth } from './session.js'
import { spaceCtx, memberPermissions } from './spaces.js'
import { requirePermission } from './permissions.js'
import { audit } from './audit.js'
import { HttpError, bad, notFound, forbidden, conflict, newToken, reqId, numId, cleanEmail, makeHitCounter, ipKey } from './util.js'
import { noteCreated, noteRef } from './ops-sink.js'
import { createGuest, findGuest, guestName, guestSelf, mergeGuests, renameGuest, sentKey, sentMergeKey, takeOverGuest, touchGuest } from './guests.js'

export { guestName }

const iso = () => new Date().toISOString()
const get = (sql, ...p) => db.prepare(sql).get(...p)
const all = (sql, ...p) => db.prepare(sql).all(...p)
const bump = (id) => db.prepare('UPDATE wishlists SET updated_at=? WHERE id=?').run(iso(), id)

// ---------- Guest claims ----------
const GUEST_CAP = 100 // guest claims per list (guests per list: GUEST_ROW_CAP in guests.js)
const guestHits = makeHitCounter(30) // claims and releases of guests per IP and minute
const cleanIp = (ip) => (ip ? String(ip).replace(/^::ffff:/, '').slice(0, 64) : null)

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
    guest_claims: !!l.guest_claims,
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
  // Guests: the guest a claim belongs to (the one whose key the request carries) or, for claims of 1.0/1.1 without a guest, their name
  const guest = viewer.guestName ? String(viewer.guestName).trim().toLowerCase() : null
  const guestOwns = (r) =>
    !r.user_id && (r.guest_id ? viewer.guestId != null && viewer.guestId === r.guest_id : !!guest && r.guest_name?.toLowerCase() === guest)
  return rows
    .filter((w) => w.status !== 'removed')
    .map((w) => {
      const r = resv.get(w.id)
      return {
        ...plainWish(w),
        reserved: !!r,
        reserved_by: r ? (r.user_id ? r.user_name : r.guest_name) : null,
        reserved_by_me: !!r && ((viewer.userId != null && r.user_id === viewer.userId) || guestOwns(r)),
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

/**
 * What a guest tells us about themselves: the guest key (header only, never the URL) and, for claims of 1.0/1.1, the name. Signed-in
 * people are never guests: for them a key is ignored (the list owner, in particular, learns nothing through it).
 */
function guestViewer(req, list) {
  if (req.user) return {}
  const g = findGuest(list, sentKey(req))
  let name = ''
  try { name = decodeURIComponent(String(req.get?.('x-guest-name') ?? '')) } catch { /* not decodable: ignored */ }
  name ||= String(req.query?.guest_name ?? req.body?.guest_name ?? '') // cached clients of older versions
  return { guest: g, guestId: g?.id ?? null, guestName: name.slice(0, 120) || null }
}

function publicView(req, list, viewer = {}) {
  const uid = req.user?.id ?? null
  const owner = get('SELECT id, name FROM users WHERE id=?', list.owner_user_id)
  const isOwner = uid === list.owner_user_id
  const gv = guestViewer(req, list)
  if (gv.guest) touchGuest(req, gv.guest)
  let wishes = wishesView(list, { userId: uid, ...gv, ...viewer })
  if (isOwner) wishes = wishes.filter((w) => w.status !== 'removed')
  return {
    wishlist: { id: list.id, title: list.title, description: list.description, event_date: list.event_date },
    owner: { id: owner.id, name: owner.name },
    // Everything the public page needs besides the list, so it works when only the shared paths pass a sign-in proxy
    app: { name: getSys('app_name') || 'Wishy', default_locale: defaultLocale() },
    guest_claims: !!list.guest_claims,
    // The guest this browser is (code, name, number of claims); null = not known to the server (yet). Absent for signed-in people.
    ...(uid == null ? { guest: guestSelf(gv.guest) } : {}),
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
/**
 * The wish a claim is about and how the caller reaches it: with the list's share token (`tokenIn`, or the token of an older client in
 * the body/query) or as a user with access. Wrong, switched-off or archived tokens are one and the same 404.
 */
function resolveWish(req, wishId, body, tokenIn) {
  const w = get('SELECT * FROM wishes WHERE id=?', reqId(wishId, 'Wish not found', 'wish_not_found'))
  const token = tokenIn ?? body.token ?? req.query?.token
  let list = null
  let mode
  if (token) {
    list = listByToken(token)
    if (!w || w.wishlist_id !== list.id) throw notFound('This wishlist is no longer shared', 'list_not_shared')
    mode = 'token'
  } else {
    if (!w) throw notFound('Wish not found', 'wish_not_found')
    list = loadList(w.wishlist_id)
    if (!req.user || !viaFor(list, req.user.id)) throw notFound('Wish not found', 'wish_not_found')
    mode = 'access'
  }
  const user = req.user
  if (user && user.id === list.owner_user_id) throw forbidden('You cannot reserve your own wishes', 'own_wish_reserve')
  if (w.status === 'removed') throw notFound('Wish not found', 'wish_not_found')
  return { wish: w, list, mode, user }
}
const respond = (req, res, r) => {
  res.setHeader('Cache-Control', 'no-store')
  return r.mode === 'token' ? publicView(req, r.list) : detailView(req, r.list)
}

/** Guests (no account) claim and release at a limited pace per IP address */
function guestPace(req, res) {
  const ip = ipKey(req.ip)
  if (!guestHits.hit(ip)) return
  res.setHeader('Retry-After', String(guestHits.retryAfter(ip)))
  throw new HttpError(429, 'Too many requests. Please wait a moment.', 'too_many_requests')
}

/**
 * Audit entry of a claim or release. Explicit (marks the request as audited, written at every log level); the claimer's IP and
 * user agent are stored on the reservation itself.
 */
function auditClaim(req, action, { wish, list, resv, guest, viaLink }) {
  audit(req, action, {
    target: { type: 'wish', id: wish.id, label: wish.title },
    ...(guest ? { label: resv.guest_name } : {}),
    details: {
      wishlist_id: list.id,
      wishlist_title: list.title,
      owner_user_id: list.owner_user_id,
      ...(guest ? { guest_name: resv.guest_name } : {}),
      ...(guest && resv.guest_id ? { guest_id: resv.guest_id, guest_code: resv.guest_code } : {}),
      reservation_id: resv.id,
      via_link: viaLink,
    },
  })
}

/**
 * Claims that disappear because the owner removes the wish or the list. Call before deleting; the returned function writes the entries
 * afterwards. Logged with the owner as the actor and without marking the request as audited (the delete itself is logged as usual).
 */
export function implicitReleases(req, reason, wishIds) {
  if (!wishIds.length) return () => {}
  const rows = all(
    `SELECT r.id, r.wish_id, r.user_id, r.guest_name, r.guest_id, g.code AS guest_code, w.title, l.id AS list_id, l.title AS list_title, l.owner_user_id
     FROM reservations r LEFT JOIN wishlist_guests g ON g.id=r.guest_id JOIN wishes w ON w.id=r.wish_id JOIN wishlists l ON l.id=w.wishlist_id WHERE r.wish_id IN (${wishIds.map(() => '?').join(',')})`,
    ...wishIds,
  )
  return () => {
    for (const r of rows) {
      audit({ userId: req.user.id, via: 'session', ip: req.ip, userAgent: req.headers?.['user-agent'] }, 'wish.unreserve', {
        target: { type: 'wish', id: r.wish_id, label: r.title },
        details: {
          wishlist_id: r.list_id,
          wishlist_title: r.list_title,
          owner_user_id: r.owner_user_id,
          ...(r.user_id ? { reserved_by_user_id: r.user_id } : { guest_name: r.guest_name, ...(r.guest_id ? { guest_id: r.guest_id, guest_code: r.guest_code } : {}) }),
          reservation_id: r.id,
          via_link: !r.user_id,
          reason,
        },
      })
    }
  }
}

/** Ids of the wishes whose claims disappear when a user is deleted: claims the user holds and claims on the user's own lists. */
export const wishIdsOfUserClaims = (userId) =>
  all(
    'SELECT DISTINCT r.wish_id AS id FROM reservations r JOIN wishes w ON w.id=r.wish_id JOIN wishlists l ON l.id=w.wishlist_id WHERE r.user_id=? OR l.owner_user_id=?',
    userId,
    userId,
  ).map((x) => x.id)

const safeDecode = (v) => {
  try {
    return decodeURIComponent(String(v))
  } catch {
    return ''
  }
}
/** POST of both reserve routes. `tokenIn` is set on /api/shared/:token/..., where guests are identified by their key; the old route knows guests by name only (1.0/1.1 clients). */
function claim(req, res, wishId, tokenIn) {
  const body = req.body || {}
  const r = resolveWish(req, wishId, body, tokenIn)
  const { wish, list, user } = r
  if (!user) {
    guestPace(req, res)
    if (!list.guest_claims) throw forbidden('Guests cannot reserve on this list. Please sign in.', 'guest_claims_disabled')
  }
  if (wish.status !== 'open') throw bad('This wish is no longer available', 'wish_unavailable')
  if (body.plan && !user) throw bad('You must be signed in to plan it', 'login_required_plan')
  // A guest on the public page is identified by the key of their browser; the guest row is created with the first claim (the name is
  // asked for then, a known guest keeps their name: renaming is a separate act that applies to all their claims)
  let key = null
  let known = null
  if (!user && tokenIn) {
    key = sentKey(req)
    if (!key) throw bad('Your browser did not send a guest key. Please reload the page.', 'guest_key_required')
    known = findGuest(list, key)
  }
  const name = user ? null : known ? known.name : guestName(body.guest_name)
  let resv
  tx(() => {
    if (get('SELECT 1 FROM reservations WHERE wish_id=?', wish.id)) throw conflict('This wish is already reserved', 'wish_reserved')
    if (
      !user &&
      get('SELECT COUNT(*) AS n FROM reservations WHERE user_id IS NULL AND wish_id IN (SELECT id FROM wishes WHERE wishlist_id=?)', list.id).n >= GUEST_CAP
    ) {
      throw conflict('Too many reservations by guests on this list. Please sign in.', 'guest_limit')
    }
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
    const guestRow = key ? known ?? createGuest(req, list, key, name) : null
    const ua = req.headers?.['user-agent']
    const id = Number(
      db
        .prepare('INSERT INTO reservations (wish_id, user_id, guest_name, gift_id, guest_id, ip, user_agent) VALUES (?,?,?,?,?,?,?)')
        .run(wish.id, user ? user.id : null, name, giftId, guestRow?.id ?? null, cleanIp(req.ip), ua ? String(ua).slice(0, 400) : null).lastInsertRowid,
    )
    resv = { id, guest_name: name, guest_id: guestRow?.id ?? null, guest_code: guestRow?.code ?? null }
  })
  auditClaim(req, 'wish.reserve', { wish, list, resv, guest: !user, viaLink: r.mode === 'token' })
  res.json(respond(req, res, r))
}

/** DELETE of both reserve routes */
function release(req, res, wishId, tokenIn) {
  const body = req.body || {}
  const r = resolveWish(req, wishId, body, tokenIn)
  if (!r.user) guestPace(req, res)
  const resv = get('SELECT r.*, g.code AS guest_code FROM reservations r LEFT JOIN wishlist_guests g ON g.id=r.guest_id WHERE r.wish_id=?', r.wish.id)
  if (resv) {
    let allowed = false
    if (r.user && resv.user_id === r.user.id) allowed = true
    else if (!r.user && !resv.user_id && resv.guest_name) {
      if (resv.guest_id) {
        // The claim belongs to a guest: only the one whose key this is (a name never decides)
        const g = r.mode === 'token' ? findGuest(r.list, sentKey(req)) : null
        allowed = !!g && g.id === resv.guest_id
      } else {
        // A claim of 1.0/1.1 has no guest: the name decides, as before
        const g = String(req.get('x-guest-name') ? safeDecode(req.get('x-guest-name')) : (body.guest_name ?? req.query?.guest_name ?? '')).trim().toLowerCase()
        allowed = !!g && g === resv.guest_name.toLowerCase()
      }
    }
    if (!allowed) throw forbidden('Only the person who reserved it can cancel the reservation', 'reservation_not_yours')
    tx(() => {
      db.prepare('DELETE FROM reservations WHERE id=?').run(resv.id)
      if (resv.gift_id) db.prepare("DELETE FROM gifts WHERE id=? AND status='planned'").run(resv.gift_id)
    })
    auditClaim(req, 'wish.unreserve', { wish: r.wish, list: r.list, resv, guest: !r.user, viaLink: r.mode === 'token' })
  }
  res.json(respond(req, res, r))
}

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
    const released = implicitReleases(req, 'wishlist_deleted', all('SELECT id FROM wishes WHERE wishlist_id=?', l.id).map((w) => w.id))
    tx(() => {
      db.prepare('UPDATE gifts SET wish_id=NULL WHERE wish_id IN (SELECT id FROM wishes WHERE wishlist_id=?)').run(l.id)
      db.prepare('DELETE FROM wishlists WHERE id=?').run(l.id)
    })
    released()
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
    const released = implicitReleases(req, 'wish_deleted', [w.id])
    tx(() => {
      db.prepare('DELETE FROM wishes WHERE id=?').run(w.id)
      bump(w.wishlist_id)
    })
    released()
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
      if (b.guest_claims !== undefined) db.prepare('UPDATE wishlists SET guest_claims=? WHERE id=?').run(b.guest_claims ? 1 : 0, l.id)
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
  app.get('/api/shared/:token', (req, res) => {
    const view = publicView(req, listByToken(req.params.token))
    res.setHeader('Cache-Control', 'no-store') // depends on the guest's secret and on the session
    res.json(view)
  })

  // ---- Guest identity (everything under /api/shared/:token/, the key only in the X-Guest-Key header) ----
  // Signed-in people are not guests: these routes answer them all the same, whatever key they send (the owner learns nothing).
  const guestList = (req) => {
    const l = listByToken(req.params.token)
    if (req.user) throw forbidden('This is only for guests', 'guest_not_available')
    return l
  }
  const guestOut = (req, res, list) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(publicView(req, list))
  }
  // The browser saves its personal link: the guest is created now (a plain visit never creates one)
  app.post('/api/shared/:token/guest', (req, res) => {
    const list = guestList(req)
    guestPace(req, res)
    const key = sentKey(req)
    if (!key) throw bad('Your browser did not send a guest key. Please reload the page.', 'guest_key_required')
    if (!findGuest(list, key)) {
      if (!list.guest_claims) throw forbidden('Guests cannot reserve on this list. Please sign in.', 'guest_claims_disabled')
      createGuest(req, list, key, req.body?.guest_name)
    }
    guestOut(req, res, list)
  })
  app.put('/api/shared/:token/guest', (req, res) => {
    const list = guestList(req)
    guestPace(req, res)
    const g = findGuest(list, sentKey(req))
    if (!g) throw notFound('Guest not found', 'guest_not_found')
    renameGuest(req, list, g, req.body?.guest_name)
    guestOut(req, res, list)
  })
  // Two keys prove two guests of this list are the same person: the claims of the second move to the first
  app.post('/api/shared/:token/guest/merge', (req, res) => {
    const list = guestList(req)
    guestPace(req, res)
    const into = findGuest(list, sentKey(req))
    const from = findGuest(list, sentMergeKey(req))
    if (!into || !from) throw notFound('Guest not found', 'guest_not_found')
    mergeGuests(req, list, into, from)
    guestOut(req, res, list)
  })
  // A signed-in user takes over the claims they made as a guest (the key proves it)
  const takeoverList = (req) => {
    const l = listByToken(req.params.token)
    if (l.owner_user_id === req.user.id) throw forbidden('This is only for guests', 'guest_not_available')
    return l
  }
  app.get('/api/shared/:token/guest/takeover', requireAuth, (req, res) => {
    const list = takeoverList(req)
    const g = findGuest(list, sentKey(req))
    res.setHeader('Cache-Control', 'no-store')
    res.json({ claims: g ? guestSelf(g).claims : 0, name: g ? g.name : null })
  })
  app.post('/api/shared/:token/guest/takeover', requireAuth, (req, res) => {
    const list = takeoverList(req)
    guestPace(req, res)
    const g = findGuest(list, sentKey(req))
    if (!g) throw notFound('Guest not found', 'guest_not_found')
    takeOverGuest(req, list, g)
    guestOut(req, res, list)
  })

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
  // Old routes (the token travels in the body): for signed-in users and for clients that are still cached.
  app.post('/api/wishes/:id/reserve', (req, res) => claim(req, res, req.params.id))
  app.delete('/api/wishes/:id/reserve', (req, res) => release(req, res, req.params.id))
  // Guests and signed-in people on the public page: everything under /api/shared/:token/, the one path a sign-in proxy has to let through
  app.post('/api/shared/:token/wishes/:id/reserve', (req, res) => claim(req, res, req.params.id, listByToken(req.params.token).share_token))
  app.delete('/api/shared/:token/wishes/:id/reserve', (req, res) => release(req, res, req.params.id, listByToken(req.params.token).share_token))
}
