// Feature switches: global (setting) and per user (columns users.ai_enabled / users.api_enabled).
// NULL = inherit the default, 0 = off, 1 = on.
import { db } from './db.js'
import { getSys } from './config.js'
import { getAiConfig, isUsable } from './ai/settings.js'
import { requireAdmin } from './session.js'
import { bad, notFound, reqId } from './util.js'

/** Global switch for the public API (default: on). */
export const apiGloballyEnabled = () => getSys('api_enabled') !== false

/**
 * Effective feature switches of a user.
 * - ai: AI must be usable globally (enabled + configured); a user value of 0 turns it off for that user.
 * - api: a user value of 1/0 overrides the global `api_enabled` setting, NULL inherits it.
 * @param {{ id: number, ai_enabled?: number|null, api_enabled?: number|null }} user
 * @returns {{ ai: boolean, api: boolean }}
 */
export function effectiveFeatures(user) {
  let u = user
  if (u && u.id != null && (u.ai_enabled === undefined || u.api_enabled === undefined)) {
    u = db.prepare('SELECT id, ai_enabled, api_enabled FROM users WHERE id=?').get(u.id) ?? u
  }
  const aiGlobal = isUsable(getAiConfig())
  const ai = aiGlobal && u?.ai_enabled !== 0
  const api = u?.api_enabled === 1 || u?.api_enabled === 0 ? u.api_enabled === 1 : apiGloballyEnabled()
  return { ai, api }
}

/** Value from the form: null/'default'/'inherit' -> NULL, true/1/'on' -> 1, false/0/'off' -> 0. */
function tri(v, label) {
  if (v === null || v === 'default' || v === 'inherit') return null
  if (v === true || v === 1 || v === 'on') return 1
  if (v === false || v === 0 || v === 'off') return 0
  throw Object.assign(bad(`Invalid value for ${label}`), { code: 'invalid_value' })
}

const row = (u) => ({ id: u.id, ai_enabled: u.ai_enabled ?? null, api_enabled: u.api_enabled ?? null, features: effectiveFeatures(u) })

export function featureRoutes(app) {
  // All users with their switches (for the user list in the admin area)
  app.get('/api/admin/users/features', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT id, ai_enabled, api_enabled FROM users ORDER BY id').all().map(row))
  })

  app.put('/api/admin/users/:id/features', requireAdmin, (req, res) => {
    const id = reqId(req.params.id, 'User not found', 'user_not_found')
    const u = db.prepare('SELECT id, ai_enabled, api_enabled FROM users WHERE id=?').get(id)
    if (!u) throw notFound('User not found', 'user_not_found')
    const b = req.body || {}
    if (b.ai_enabled !== undefined) u.ai_enabled = tri(b.ai_enabled, 'AI')
    if (b.api_enabled !== undefined) u.api_enabled = tri(b.api_enabled, 'API')
    db.prepare('UPDATE users SET ai_enabled=?, api_enabled=? WHERE id=?').run(u.ai_enabled, u.api_enabled, id)
    req.auditInfo = { target: { type: 'user', id }, details: { ai_enabled: u.ai_enabled, api_enabled: u.api_enabled } }
    res.json(row(u))
  })
}
