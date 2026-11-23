// API keys: creation (plaintext only once), verification, management by users and admins.
import { randomInt } from 'node:crypto'
import { db } from './db.js'
import { getSys, setSys } from './config.js'
import { requireAuth, requireAdmin } from './session.js'
import { effectiveFeatures, apiGloballyEnabled } from './features.js'
import { memberSpaces } from './spaces.js'
import { requireConfirm } from './twofactor-routes.js'
import { HttpError, sha256, reqId } from './util.js'

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const rand62 = (n) => Array.from({ length: n }, () => B62[randomInt(62)]).join('')
export const KEY_RE = /^wishy_([A-Za-z0-9]{8})_([A-Za-z0-9]{32,64})$/
export const SCOPES = ['read', 'write']
const MAX_ACTIVE_KEYS = 25

const err = (status, message, code) => new HttpError(status, message, code)
const nowIso = () => new Date().toISOString()

export function keyStatus(k) {
  if (k.revoked_at) return 'revoked'
  if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) return 'expired'
  return 'active'
}

/** Public view of a key (never hash or plaintext). */
export function keyView(k) {
  let scopes = []
  try {
    scopes = JSON.parse(k.scopes)
  } catch {
    /* ignore */
  }
  const space = k.space_id ? db.prepare('SELECT name FROM spaces WHERE id=?').get(k.space_id) : null
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    masked: `wishy_${k.prefix}_••••••••`,
    scopes,
    space_id: k.space_id ?? null,
    space_name: space?.name ?? null,
    created_at: k.created_at,
    last_used_at: k.last_used_at,
    last_used_ip: k.last_used_ip,
    expires_at: k.expires_at,
    revoked_at: k.revoked_at,
    status: keyStatus(k),
  }
}

function cleanScopes(v) {
  const list = v === undefined ? ['read', 'write'] : v
  if (!Array.isArray(list) || !list.length || !list.every((s) => SCOPES.includes(s))) throw err(400, 'Invalid permissions (read, write)', 'invalid_scopes')
  return [...new Set(list)]
}
function cleanExpiry(b) {
  if (b.expires_at !== undefined && b.expires_at !== null && b.expires_at !== '') {
    const t = Date.parse(String(b.expires_at))
    if (Number.isNaN(t) || t <= Date.now()) throw err(400, 'The expiry date must be in the future', 'invalid_expiry')
    return new Date(t).toISOString()
  }
  if (b.expires_in_days !== undefined && b.expires_in_days !== null && b.expires_in_days !== '') {
    const d = Number(b.expires_in_days)
    if (!Number.isFinite(d) || d <= 0 || d > 3650) throw err(400, 'Invalid validity period', 'invalid_expiry')
    return new Date(Date.now() + d * 86_400_000).toISOString()
  }
  return null
}

export function createKey(user, b) {
  const name = String(b.name ?? '').trim().slice(0, 80)
  if (!name) throw err(400, 'Please give the key a name', 'name_required')
  const scopes = cleanScopes(b.scopes)
  let spaceId = null
  if (b.space_id !== undefined && b.space_id !== null && b.space_id !== '') {
    spaceId = Number(b.space_id)
    if (!memberSpaces(user.id).some((s) => s.id === spaceId)) throw err(404, 'Space not found', 'space_not_found')
  }
  const expires = cleanExpiry(b)
  const active = db.prepare('SELECT * FROM api_keys WHERE user_id=? AND revoked_at IS NULL').all(user.id).filter((k) => keyStatus(k) === 'active').length
  if (active >= MAX_ACTIVE_KEYS) throw err(400, 'You already have very many active keys', 'too_many_keys')
  const prefix = rand62(8)
  const secret = `wishy_${prefix}_${rand62(40)}`
  const id = Number(
    db
      .prepare('INSERT INTO api_keys (user_id,name,prefix,key_hash,scopes,space_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(user.id, name, prefix, sha256(secret), JSON.stringify(scopes), spaceId, nowIso(), expires).lastInsertRowid,
  )
  return { key: keyView(db.prepare('SELECT * FROM api_keys WHERE id=?').get(id)), secret }
}

/**
 * Verifies a plaintext key. Throws HttpError 401 (uniform for unknown/invalid - no inference possible;
 * revoked/expired only after proven possession of the key).
 */
export function lookupKey(token) {
  const m = KEY_RE.exec(String(token ?? ''))
  // Do the same amount of work even for an obviously wrong format
  const hash = sha256(m ? token : 'wishy_00000000_' + 'x'.repeat(40))
  const k = m ? db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(hash) : null
  if (!k) throw err(401, 'Invalid API key', 'invalid_api_key')
  if (k.revoked_at) throw err(401, 'This API key has been revoked', 'api_key_revoked')
  if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) throw err(401, 'This API key has expired', 'api_key_expired')
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(k.user_id)
  if (!user || user.disabled) throw err(401, 'Invalid API key', 'invalid_api_key')
  return { key: k, user }
}

/** Record last use; returns true if this is the first use of the day (UTC). */
export function touchKey(k, ip) {
  const today = nowIso().slice(0, 10)
  const first = !k.last_used_at || k.last_used_at.slice(0, 10) !== today
  const stale = !k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 30_000 || k.last_used_ip !== ip
  if (stale) {
    const at = nowIso()
    db.prepare('UPDATE api_keys SET last_used_at=?, last_used_ip=? WHERE id=?').run(at, ip ?? null, k.id)
    k.last_used_at = at
    k.last_used_ip = ip ?? null
  }
  return first
}

export function revokeKey(id) {
  db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(nowIso(), id)
}

export function apiKeyRoutes(app) {
  // ---- Own keys (session only, never with an API key) ----
  const own = [requireAuth, (req, res, next) => (req.apiKey ? next(err(403, 'Keys can only be managed in the app', 'session_required')) : next())]

  app.get('/api/account/api-keys', ...own, (req, res) => {
    const f = effectiveFeatures(req.user)
    res.json({
      enabled: f.api,
      keys: db.prepare('SELECT * FROM api_keys WHERE user_id=? ORDER BY id DESC').all(req.user.id).map(keyView),
    })
  })

  app.post('/api/account/api-keys', ...own, async (req, res) => {
    if (!effectiveFeatures(req.user).api) throw err(403, 'The API is not enabled for your account', 'api_disabled')
    // A key is permanent access: only after fresh confirmation (password/2FA code or 10-minute window).
    // With two_factor_policy=required, twoFactorGate blocks this route while the user has not set up 2FA yet.
    await requireConfirm(req)
    const { key, secret } = createKey(req.user, req.body || {})
    req.auditInfo = {
      target: { type: 'api_key', id: key.id, label: key.name },
      details: { prefix: key.prefix, scopes: key.scopes, space_id: key.space_id, expires_at: key.expires_at },
    }
    res.json({ key, secret }) // the only time the plaintext is returned
  })

  app.delete('/api/account/api-keys/:id', ...own, (req, res) => {
    const id = reqId(req.params.id, 'Key not found', 'api_key_not_found')
    const k = db.prepare('SELECT * FROM api_keys WHERE id=? AND user_id=?').get(id, req.user.id)
    if (!k) throw err(404, 'Key not found', 'api_key_not_found')
    revokeKey(id)
    req.auditInfo = { target: { type: 'api_key', id, label: k.name }, details: { prefix: k.prefix } }
    res.json(keyView(db.prepare('SELECT * FROM api_keys WHERE id=?').get(id)))
  })

  // ---- Admin ----
  app.get('/api/admin/api-keys', requireAdmin, (req, res) => {
    const where = req.query.user_id ? 'WHERE k.user_id=?' : ''
    const rows = db
      .prepare(`SELECT k.*, u.name AS user_name, u.email AS user_email FROM api_keys k JOIN users u ON u.id=k.user_id ${where} ORDER BY k.id DESC`)
      .all(...(req.query.user_id ? [Number(req.query.user_id) || -1] : []))
    res.json({
      api_enabled: apiGloballyEnabled(),
      keys: rows.map((r) => ({ ...keyView(r), user_id: r.user_id, user_name: r.user_name, user_email: r.user_email })),
    })
  })

  app.get('/api/admin/api-keys/settings', requireAdmin, (req, res) => res.json({ api_enabled: apiGloballyEnabled() }))
  app.put('/api/admin/api-keys/settings', requireAdmin, (req, res) => {
    if (typeof req.body?.api_enabled !== 'boolean') throw err(400, 'Invalid value for "API enabled"', 'invalid_value')
    setSys('api_enabled', req.body.api_enabled)
    res.json({ api_enabled: apiGloballyEnabled() })
  })

  app.delete('/api/admin/api-keys/:id', requireAdmin, (req, res) => {
    const id = reqId(req.params.id, 'Key not found', 'api_key_not_found')
    const k = db.prepare('SELECT * FROM api_keys WHERE id=?').get(id)
    if (!k) throw err(404, 'Key not found', 'api_key_not_found')
    revokeKey(id)
    req.auditInfo = { target: { type: 'api_key', id, label: k.name }, details: { prefix: k.prefix, owner_id: k.user_id } }
    res.json(keyView(db.prepare('SELECT * FROM api_keys WHERE id=?').get(id)))
  })

  void getSys
}
