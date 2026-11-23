import { ensureOccasionTypesForSpace } from './occasion-types.js'
import { db, tx, insert, ACCESS_OK_SQL, syncSpaceAccessForUser, syncSpaceAccessForList } from './db.js'
import { baseUrl } from './config.js'
import { requireAuth } from './session.js'
import { userPublicFull } from './userview.js'
import { bad, notFound, forbidden, newToken, numId, reqId } from './util.js'
import { PERMISSIONS, cleanPermissions, requirePermission, resolvePermissions } from './permissions.js'
import { audit } from './audit.js'

const DAY = 86_400_000

// ---------- Helpers ----------
export function memberSpaces(userId) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.personal, m.role, m.permissions,
              (SELECT COUNT(*) FROM space_members x WHERE x.space_id=s.id) AS member_count
       FROM space_members m JOIN spaces s ON s.id=m.space_id
       WHERE m.user_id=? ORDER BY s.personal DESC, s.name COLLATE NOCASE`,
    )
    .all(userId)
    .map(({ permissions, ...s }) => ({ ...s, personal: !!s.personal, permissions: resolvePermissions(s.role, permissions) }))
}

export function userPublic(u) {
  return userPublicFull(u)
}

export function meOf(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId)
  const shared_unseen = db
    .prepare(
      `SELECT COUNT(*) AS n FROM wishlist_access a
       JOIN wishlists w ON w.id=a.wishlist_id
       JOIN users o ON o.id=w.owner_user_id AND o.disabled=0
       WHERE a.user_id=? AND w.archived=0 AND ${ACCESS_OK_SQL} AND (a.seen_at IS NULL OR w.updated_at > a.seen_at)`,
    )
    .get(userId).n
  return { user: userPublic(u), spaces: memberSpaces(userId), shared_unseen }
}

export const personalSpaceId = (userId) =>
  db
    .prepare('SELECT s.id FROM spaces s JOIN space_members m ON m.space_id=s.id WHERE m.user_id=? AND s.personal=1 ORDER BY s.id LIMIT 1')
    .get(userId)?.id ?? null

/** Effective permissions of a user in a space (null when not a member = nothing allowed). */
export function memberPermissions(spaceId, userId) {
  const m = db.prepare('SELECT role, permissions FROM space_members WHERE space_id=? AND user_id=?').get(spaceId, userId)
  return m ? resolvePermissions(m.role, m.permissions) : null
}

export const isMember = (spaceId, userId) =>
  !!db.prepare('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?').get(spaceId, userId)

/** Every member has a linked person in every space. */
export function addMemberPerson(spaceId, userId) {
  const has = db.prepare('SELECT id FROM persons WHERE space_id=? AND linked_user_id=?').get(spaceId, userId)
  if (has) return has.id
  const u = db.prepare('SELECT name, email FROM users WHERE id=?').get(userId)
  // An unlinked person with the same email address is adopted instead of creating a new one
  const byMail = u.email
    ? db
        .prepare('SELECT id FROM persons WHERE space_id=? AND linked_user_id IS NULL AND lower(email)=lower(?) ORDER BY id LIMIT 1')
        .get(spaceId, u.email)
    : null
  if (byMail) {
    db.prepare('UPDATE persons SET linked_user_id=? WHERE id=?').run(userId, byMail.id)
    return byMail.id
  }
  return insert('persons', { name: u.name, email: u.email, linked_user_id: userId }, spaceId)
}

export function joinSpace(spaceId, userId, role = 'member') {
  tx(() => {
    // New members start with the space's default permissions
    const defaults = db.prepare('SELECT default_permissions FROM spaces WHERE id=?').get(spaceId)?.default_permissions ?? '{}'
    db.prepare('INSERT OR IGNORE INTO space_members (space_id,user_id,role,permissions) VALUES (?,?,?,?)').run(spaceId, userId, role, defaults)
    addMemberPerson(spaceId, userId)
    syncSpaceAccessForUser(userId)
  })
}

export function createSpace(name, userId, { personal = false } = {}) {
  return tx(() => {
    const id = Number(
      db.prepare('INSERT INTO spaces (name, personal, created_by) VALUES (?,?,?)').run(name, personal ? 1 : 0, userId).lastInsertRowid,
    )
    db.prepare("INSERT INTO space_members (space_id,user_id,role) VALUES (?,?,'owner')").run(id, userId)
    ensureOccasionTypesForSpace(id) // default occasion types
    addMemberPerson(id, userId)
    return id
  })
}

export function deleteSpaceData(spaceId) {
  tx(() => {
    const members = db.prepare('SELECT user_id FROM space_members WHERE space_id=?').all(spaceId)
    db.prepare('DELETE FROM gifts WHERE space_id=?').run(spaceId)
    db.prepare('DELETE FROM items WHERE space_id=?').run(spaceId)
    db.prepare('DELETE FROM occasions WHERE space_id=?').run(spaceId)
    db.prepare('DELETE FROM persons WHERE space_id=?').run(spaceId)
    db.prepare('DELETE FROM settings WHERE space_id=?').run(spaceId)
    db.prepare('DELETE FROM spaces WHERE id=?').run(spaceId)
    for (const m of members) syncSpaceAccessForUser(m.user_id)
  })
}

/** Removes a member; orphaned spaces are deleted and a missing owner is replaced. */
export function removeMember(spaceId, userId) {
  tx(() => {
    db.prepare('DELETE FROM space_members WHERE space_id=? AND user_id=?').run(spaceId, userId)
    db.prepare('UPDATE persons SET linked_user_id=NULL WHERE space_id=? AND linked_user_id=?').run(spaceId, userId)
    // Whoever leaves the space loses access to lists shared through it; their own lists are no longer shared with the space
    const mine = db.prepare('SELECT w.id FROM wishlist_space_access s JOIN wishlists w ON w.id=s.wishlist_id WHERE s.space_id=? AND w.owner_user_id=?').all(spaceId, userId)
    db.prepare('DELETE FROM wishlist_space_access WHERE space_id=? AND wishlist_id IN (SELECT id FROM wishlists WHERE owner_user_id=?)').run(spaceId, userId)
    for (const l of mine) syncSpaceAccessForList(l.id)
    syncSpaceAccessForUser(userId)
    const left = db.prepare('SELECT user_id, role FROM space_members WHERE space_id=? ORDER BY joined_at, user_id').all(spaceId)
    if (!left.length) return deleteSpaceData(spaceId)
    if (!left.some((m) => m.role === 'owner')) {
      db.prepare("UPDATE space_members SET role='owner' WHERE space_id=? AND user_id=?").run(spaceId, left[0].user_id)
    }
  })
}

/** Current space from the X-Space header (fallback: personal space), including the visibility context. */
export function spaceCtx(req) {
  const userId = req.user.id
  let row = null
  const h = req.get('X-Space')
  if (h) {
    const sid = numId(h)
    if (!Number.isNaN(sid)) {
      row = db
        .prepare('SELECT s.id, s.name, s.personal, m.role, m.permissions FROM spaces s JOIN space_members m ON m.space_id=s.id WHERE s.id=? AND m.user_id=?')
        .get(sid, userId)
    }
  }
  if (!row) {
    row = db
      .prepare('SELECT s.id, s.name, s.personal, m.role, m.permissions FROM spaces s JOIN space_members m ON m.space_id=s.id WHERE m.user_id=? AND s.personal=1 ORDER BY s.id LIMIT 1')
      .get(userId)
  }
  if (!row) throw notFound('No space found', 'space_not_found')
  const personal = !!row.personal
  // Surprise protection: persons linked to the user (only relevant in shared spaces)
  const hidden = new Set(
    personal ? [] : db.prepare('SELECT id FROM persons WHERE space_id=? AND linked_user_id=?').all(row.id, userId).map((p) => p.id),
  )
  return { userId, spaceId: row.id, name: row.name, personal, role: row.role, permissions: resolvePermissions(row.role, row.permissions), hidden }
}

export function acceptSpaceInvite(token, userId) {
  const inv = db.prepare('SELECT * FROM space_invites WHERE token=?').get(token)
  if (!inv || inv.expires_at < Date.now() || inv.uses_left <= 0) throw notFound('The invitation is invalid or has expired', 'invite_invalid')
  if (isMember(inv.space_id, userId)) return inv.space_id
  tx(() => {
    joinSpace(inv.space_id, userId)
    db.prepare('UPDATE space_invites SET uses_left=uses_left-1 WHERE token=?').run(token)
  })
  return inv.space_id
}

const loadSpace = (req) => {
  const sid = reqId(req.params.id, 'Space not found', 'space_not_found')
  const row = db
    .prepare('SELECT s.*, m.role, m.permissions FROM spaces s JOIN space_members m ON m.space_id=s.id WHERE s.id=? AND m.user_id=?')
    .get(sid, req.user.id)
  if (!row) throw notFound('Space not found', 'space_not_found')
  return row
}

const changedOnly = (a, b) => Object.fromEntries(PERMISSIONS.filter((k) => a[k] !== b[k]).map((k) => [k, b[k]]))

/** Owner of a shared (non-personal) space: permissions can only be managed there. */
const loadOwnedSharedSpace = (req) => {
  const s = loadSpace(req)
  if (s.role !== 'owner') throw forbidden('Only the owner can manage permissions', 'space_owner_permissions')
  if (s.personal) throw bad('The personal space has no other members', 'personal_space_permissions')
  return s
}

/** Members of the space; the effective permissions are included for the owner only. */
const membersOf = (s) =>
  db
    .prepare('SELECT u.id AS user_id, u.name, u.email, m.role, m.permissions FROM space_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=? ORDER BY m.role DESC, u.name COLLATE NOCASE')
    .all(s.id)
    .map(({ permissions, ...m }) => (s.role === 'owner' ? { ...m, permissions: resolvePermissions(m.role, permissions) } : m))

// ---------- Routes ----------
export function spaceRoutes(app) {
  app.post('/api/spaces', requireAuth, (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 80)
    if (!name) throw bad('Please enter a name', 'name_required')
    const count = db.prepare("SELECT COUNT(*) AS n FROM space_members m JOIN spaces s ON s.id=m.space_id WHERE m.user_id=? AND s.personal=0").get(req.user.id).n
    if (count >= 50) throw bad('You already have a very large number of spaces', 'too_many_spaces')
    createSpace(name, req.user.id)
    res.json(meOf(req.user.id))
  })

  app.put('/api/spaces/:id', requireAuth, (req, res) => {
    const s = loadSpace(req)
    if (s.role !== 'owner') throw forbidden('Only the owner can rename the space', 'space_owner_rename')
    const name = String(req.body?.name ?? '').trim().slice(0, 80)
    if (!name) throw bad('Please enter a name', 'name_required')
    db.prepare('UPDATE spaces SET name=? WHERE id=?').run(name, s.id)
    res.json(meOf(req.user.id))
  })

  app.delete('/api/spaces/:id', requireAuth, (req, res) => {
    const s = loadSpace(req)
    if (s.role !== 'owner') throw forbidden('Only the owner can delete the space', 'space_owner_delete')
    if (s.personal) throw bad('The personal space cannot be deleted', 'personal_space_delete')
    deleteSpaceData(s.id)
    res.json(meOf(req.user.id))
  })

  app.get('/api/spaces/:id/members', requireAuth, (req, res) => {
    res.json(membersOf(loadSpace(req)))
  })

  // ---- Member permissions (owner only) ----
  app.put('/api/spaces/:id/members/:userId/permissions', requireAuth, (req, res) => {
    const s = loadOwnedSharedSpace(req)
    const uid = reqId(req.params.userId, 'Member not found', 'member_not_found')
    const m = db.prepare('SELECT role, permissions FROM space_members WHERE space_id=? AND user_id=?').get(s.id, uid)
    if (!m) throw notFound('Member not found', 'member_not_found')
    if (m.role === 'owner') throw bad('The permissions of the owner cannot be restricted', 'owner_permissions_fixed')
    const patch = cleanPermissions(req.body?.permissions)
    const before = resolvePermissions(m.role, m.permissions)
    const next = { ...before, ...patch }
    db.prepare('UPDATE space_members SET permissions=? WHERE space_id=? AND user_id=?').run(JSON.stringify(next), s.id, uid)
    const changes = changedOnly(before, next)
    if (Object.keys(changes).length) audit(req, 'space.member.permissions', { target: { type: 'space', id: s.id, label: s.name }, spaceId: s.id, details: { member_id: uid, changes } })
    res.json(membersOf(s))
  })

  app.get('/api/spaces/:id/default-permissions', requireAuth, (req, res) => {
    const s = loadOwnedSharedSpace(req)
    res.json({ permissions: resolvePermissions('member', s.default_permissions) })
  })
  app.put('/api/spaces/:id/default-permissions', requireAuth, (req, res) => {
    const s = loadOwnedSharedSpace(req)
    const before = resolvePermissions('member', s.default_permissions)
    const next = { ...before, ...cleanPermissions(req.body?.permissions) }
    db.prepare('UPDATE spaces SET default_permissions=? WHERE id=?').run(JSON.stringify(next), s.id)
    const changes = changedOnly(before, next)
    if (Object.keys(changes).length) audit(req, 'space.default_permissions', { target: { type: 'space', id: s.id, label: s.name }, spaceId: s.id, details: { changes } })
    res.json({ permissions: next })
  })

  app.delete('/api/spaces/:id/members/:userId', requireAuth, (req, res) => {
    const s = loadSpace(req)
    const uid = reqId(req.params.userId, 'Member not found', 'member_not_found')
    if (s.personal) throw bad('Nobody can be removed from the personal space', 'personal_space_remove')
    if (uid !== req.user.id && s.role !== 'owner') throw forbidden('Only the owner can remove members', 'space_owner_remove')
    if (!isMember(s.id, uid)) throw notFound('Member not found', 'member_not_found')
    removeMember(s.id, uid)
    res.json(meOf(req.user.id))
  })

  app.post('/api/spaces/:id/invites', requireAuth, (req, res) => {
    const s = loadSpace(req)
    if (s.personal) throw bad('Nobody can be invited to the personal space', 'personal_space_invite')
    requirePermission({ permissions: resolvePermissions(s.role, s.permissions) }, 'invite_members')
    const token = newToken()
    db.prepare('INSERT INTO space_invites (token, space_id, created_by, expires_at, uses_left) VALUES (?,?,?,?,10)').run(
      token, s.id, req.user.id, Date.now() + 14 * DAY,
    )
    const url = `/invite/${token}`
    res.json({ token, url, full_url: baseUrl(req) + url })
  })

  // Public: invitation preview
  app.get('/api/invites/:token', (req, res) => {
    const inv = db
      .prepare(
        'SELECT s.name AS space_name, u.name AS inviter_name, i.expires_at, i.uses_left FROM space_invites i JOIN spaces s ON s.id=i.space_id LEFT JOIN users u ON u.id=i.created_by WHERE i.token=?',
      )
      .get(String(req.params.token))
    if (!inv || inv.expires_at < Date.now() || inv.uses_left <= 0) throw notFound('The invitation is invalid or has expired', 'invite_invalid')
    res.json({ space_name: inv.space_name, inviter_name: inv.inviter_name })
  })

  app.post('/api/invites/:token/accept', requireAuth, (req, res) => {
    try {
      acceptSpaceInvite(String(req.params.token), req.user.id)
    } catch (e) {
      throw notFound(e.message, e.code || 'not_found')
    }
    res.json(meOf(req.user.id))
  })
}
