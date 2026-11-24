// Admin > Users: last activity / last IP per user and the active sessions of a user (IP, device) with sign-out.
// Only from the sessions table (never derived from claim entries, so this cannot reveal anything about surprises).
import { db } from './db.js'
import { audit } from './audit.js'
import { describeUa, requireAdmin, sid16 } from './session.js'
import { HttpError, notFound, reqId } from './util.js'

/** Map user id -> { last_seen_at (ISO), last_ip } of the most recently active, unexpired session. */
export function lastActivityByUser() {
  const out = new Map()
  const rows = db
    .prepare('SELECT user_id, ip, COALESCE(last_seen_at, created_at) AS seen FROM sessions WHERE expires_at>? ORDER BY COALESCE(last_seen_at, created_at) DESC')
    .all(Date.now())
  for (const r of rows) if (!out.has(r.user_id)) out.set(r.user_id, { last_seen_at: new Date(r.seen).toISOString(), last_ip: r.ip || null })
  return out
}

export function userActivityRoutes(app) {
  const A = requireAdmin
  const sessionsOf = (uid) => db.prepare('SELECT * FROM sessions WHERE user_id=? AND expires_at>? ORDER BY COALESCE(last_seen_at, created_at) DESC').all(uid, Date.now())
  const userOr404 = (req) => {
    const id = reqId(req.params.id, 'User not found', 'user_not_found')
    const u = db.prepare('SELECT id, email FROM users WHERE id=?').get(id)
    if (!u) throw notFound('User not found', 'user_not_found')
    return u
  }

  app.get('/api/admin/users/:id/sessions', A, (req, res) => {
    const u = userOr404(req)
    res.json(
      sessionsOf(u.id).map((s) => ({
        id: sid16(s.id),
        ...describeUa(s.user_agent),
        user_agent: s.user_agent || null,
        ip: s.ip || null,
        created_at: new Date(s.created_at).toISOString(),
        last_seen_at: new Date(s.last_seen_at || s.created_at).toISOString(),
        current: s.id === req.sessionId,
      })),
    )
  })

  app.delete('/api/admin/users/:id/sessions/:sid', A, (req, res) => {
    const u = userOr404(req)
    const s = sessionsOf(u.id).find((x) => sid16(x.id) === String(req.params.sid))
    if (!s) throw notFound('Session not found', 'session_not_found')
    if (s.id === req.sessionId) throw new HttpError(400, 'Please end the current session via "Sign out"', 'session_current')
    db.prepare('DELETE FROM sessions WHERE id=?').run(s.id)
    audit(req, 'admin.user.session.revoke', { target: { type: 'user', id: u.id, label: u.email }, details: { session: sid16(s.id) } })
    res.json({ ok: true })
  })

  app.delete('/api/admin/users/:id/sessions', A, (req, res) => {
    const u = userOr404(req)
    const r = db.prepare('DELETE FROM sessions WHERE user_id=? AND id!=?').run(u.id, req.sessionId || '')
    audit(req, 'admin.user.sessions.revoke_all', { target: { type: 'user', id: u.id, label: u.email }, details: { count: Number(r.changes) } })
    res.json({ ok: true, revoked: Number(r.changes) })
  })
}
