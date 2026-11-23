import { createHash } from 'node:crypto'
import { db } from './db.js'
import { baseUrl } from './config.js'
import { audit } from './audit.js'
import { HttpError, newToken, parseCookies, setCookie, clearCookie, setSecureHook, isSecure, forbidden, notFound, unauthorized } from './util.js'

// Cookie name: under https (req.secure or https base URL) `__Host-wl_session` (Secure, Path=/, no Domain - not overridable
// by subdomains); otherwise `wl_session`. Both are read so existing sessions stay valid.
export const COOKIE = 'wl_session'
export const HOST_COOKIE = '__Host-wl_session'
setSecureHook((req) => {
  try {
    return baseUrl(req).toLowerCase().startsWith('https:')
  } catch {
    return false
  }
})
export const sessionCookieName = (req) => (isSecure(req) ? HOST_COOKIE : COOKIE)
export function readSessionCookie(req) {
  const c = parseCookies(req.headers.cookie)
  return c[HOST_COOKIE] || c[COOKIE] || ''
}
const DAY = 86_400_000
const LIFETIME = 30 * DAY
export const FRESH_WINDOW = 10 * 60_000

export function createSession(req, res, userId) {
  const id = newToken()
  const now = Date.now()
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip, last_seen_at, reauth_at) VALUES (?,?,?,?,?,?,?,?)').run(
    id, userId, now, now + LIFETIME, String(req.headers['user-agent'] || '').slice(0, 300), String(req.ip || '').slice(0, 64), now, now,
  )
  db.prepare("UPDATE users SET last_login_at=datetime('now') WHERE id=?").run(userId)
  setCookie(res, req, sessionCookieName(req), id, { maxAge: LIFETIME / 1000 })
  if (isSecure(req)) clearCookie(res, req, COOKIE) // replace the old cookie
  return id
}

export function destroySession(req, res) {
  if (req.sessionId) db.prepare('DELETE FROM sessions WHERE id=?').run(req.sessionId)
  clearSessionCookie(req, res)
}

export function clearSessionCookie(req, res) {
  clearCookie(res, req, COOKIE)
  if (isSecure(req)) clearCookie(res, req, HOST_COOKIE)
}

export const destroyUserSessions = (userId, exceptId) =>
  db.prepare('DELETE FROM sessions WHERE user_id=? AND id!=?').run(userId, exceptId || '')

/** Record the password/2FA confirmation of the current session. */
export function markFresh(req) {
  if (req.sessionId) db.prepare('UPDATE sessions SET reauth_at=? WHERE id=?').run(Date.now(), req.sessionId)
}
export function isFresh(req) {
  if (!req.sessionId) return false
  const r = db.prepare('SELECT reauth_at FROM sessions WHERE id=?').get(req.sessionId)
  return !!r?.reauth_at && Date.now() - r.reauth_at < FRESH_WINDOW
}

/** Loads the session (if present); sets req.user. Extends the session on a sliding basis. */
export function sessionMiddleware(req, res, next) {
  const sid = readSessionCookie(req)
  if (sid && sid.length < 100) {
    const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid)
    if (s && s.expires_at > Date.now()) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id)
      if (u && !u.disabled) {
        req.user = u
        req.sessionId = sid
        const now = Date.now()
        const exp = now + LIFETIME
        if (exp - s.expires_at > 12 * 3_600_000) {
          db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(exp, sid)
          setCookie(res, req, sessionCookieName(req), sid, { maxAge: LIFETIME / 1000 })
        }
        if (!s.last_seen_at || now - s.last_seen_at > 5 * 60_000) {
          db.prepare('UPDATE sessions SET last_seen_at=?, ip=? WHERE id=?').run(now, String(req.ip || '').slice(0, 64), sid)
        }
      }
    }
  }
  next()
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized())
  next()
}

export function requireAdmin(req, res, next) {
  if (!req.user) return next(unauthorized())
  if (req.user.role !== 'admin') return next(forbidden('Administrators only', 'admin_only'))
  next()
}

// ---------- CSRF ----------
const hasApiKeyHeader = (req) => !!req.headers['x-api-key'] || /^Bearer\s+wishy_/i.test(String(req.headers.authorization || ''))
const hasSessionCookie = (req) => !!readSessionCookie(req)

function hostOf(v) {
  try {
    return new URL(v).host.toLowerCase()
  } catch {
    return null
  }
}

/** Allowed hosts for Origin/Referer: base URL, request host (the forwarded one behind a trusted proxy) and ALLOWED_ORIGINS. */
export function allowedHosts(req) {
  const set = new Set()
  const b = hostOf(baseUrl(req))
  if (b) set.add(b)
  if (req.host) set.add(String(req.host).toLowerCase())
  const h = req.get('host')
  if (h) set.add(h.toLowerCase())
  for (const o of String(process.env.ALLOWED_ORIGINS || '').split(',')) {
    const x = hostOf(o.trim())
    if (x) set.add(x)
  }
  return set
}

/**
 * CSRF: SameSite=Lax + JSON-Content-Type or X-Requested-With on mutating API calls,
 * plus Origin/Referer check against the base URL. API key requests (without cookie) are exempt.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (hasApiKeyHeader(req) && !hasSessionCookie(req)) return next()
  if (req.originalUrl.startsWith('/api/v1/') && !hasSessionCookie(req)) return next()
  const ct = String(req.headers['content-type'] || '')
  if (!(ct.includes('application/json') || req.headers['x-requested-with'])) return next(new HttpError(403, 'Invalid request', 'csrf'))
  const src = req.headers.origin !== undefined ? req.headers.origin : req.headers.referer
  if (src !== undefined) {
    const h = hostOf(src)
    if (!h || !allowedHosts(req).has(h)) return next(new HttpError(403, 'Invalid request (origin not allowed)', 'origin_mismatch'))
  }
  next()
}

// ---------- Sitzungsliste ----------
const sid16 = (id) => createHash('sha256').update(id).digest('hex').slice(0, 16)

function describeUa(ua) {
  const s = String(ua || '')
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl|node|undici|python/i.test(s) ? 'API client' : 'Unknown'
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : ''
  return { browser, os, device: os ? `${browser} on ${os}` : browser }
}

export function sessionRoutes(app) {
  const list = (req) =>
    db
      .prepare('SELECT * FROM sessions WHERE user_id=? AND expires_at>? ORDER BY COALESCE(last_seen_at, created_at) DESC')
      .all(req.user.id, Date.now())

  app.get('/api/account/sessions', requireAuth, (req, res) => {
    res.json(
      list(req).map((s) => ({
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

  app.delete('/api/account/sessions/:id', requireAuth, (req, res) => {
    const target = list(req).find((s) => sid16(s.id) === String(req.params.id))
    if (!target) throw notFound('Session not found', 'session_not_found')
    if (target.id === req.sessionId) throw new HttpError(400, 'Please end the current session via "Sign out"', 'session_current')
    db.prepare('DELETE FROM sessions WHERE id=?').run(target.id)
    audit(req, 'auth.session.revoke', { target: { type: 'session', id: sid16(target.id) } })
    res.json({ ok: true })
  })

  app.post('/api/account/sessions/revoke-others', requireAuth, (req, res) => {
    const r = destroyUserSessions(req.user.id, req.sessionId)
    audit(req, 'auth.session.revoke_others', { details: { count: Number(r.changes) } })
    res.json({ ok: true, revoked: Number(r.changes) })
  })
}
