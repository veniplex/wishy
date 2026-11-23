// Audit log: audit() for requests and system events, automatic middleware (routes -> action),
// admin API (list, filter, cursor, export). Secrets (passwords, tokens, keys) never end up in the log.
import { db } from './db.js'
import { getSys, setSys } from './config.js'
import { COOKIE, HOST_COOKIE, requireAdmin } from './session.js'
import { bad } from './util.js'

export const AUDIT_LEVELS = ['security', 'all']
export const auditLevel = () => (AUDIT_LEVELS.includes(getSys('audit_level')) ? getSys('audit_level') : 'security')

// ---------- Sanitizing the details ----------
const SECRET_KEY = /(pass(word|phrase)?|secret|token|api_?key|key_?hash|authorization|cookie|otp|recovery|assertion|credential|ticket|private|^code$|^signature$)/i
const SECRET_VALUE = /\bwishy_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}\b/g
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function clean(v, depth = 0) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return clip(v.replace(SECRET_VALUE, '[entfernt]'), 300)
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (depth >= 3) return null
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => clean(x, depth + 1))
  if (typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v).slice(0, 40)) {
      if (SECRET_KEY.test(k)) continue
      out[k] = clean(x, depth + 1)
    }
    return out
  }
  return null
}
export function safeDetails(details) {
  if (!details || typeof details !== 'object') return null
  const c = clean(details)
  if (!c || !Object.keys(c).length) return null
  let s = JSON.stringify(c)
  if (s.length > 4000) s = JSON.stringify({ truncated: true })
  return s
}

// ---------- Kontext ----------
const isReq = (c) => c && typeof c === 'object' && (typeof c.get === 'function' || (c.headers && typeof c.headers === 'object'))
const cleanIp = (ip) => (ip ? String(ip).replace(/^::ffff:/, '').slice(0, 64) : null)
const userLabel = (id) => {
  const u = id ? db.prepare('SELECT email, name FROM users WHERE id=?').get(id) : null
  return u ? u.email || u.name : null
}

function sessionUser(res) {
  try {
    const sc = [].concat(res.getHeader('set-cookie') || [])
    for (const c of sc) {
      const m = new RegExp(`^(?:${HOST_COOKIE}|${COOKIE})=([^;]*)`).exec(String(c))
      if (!m || !m[1]) continue
      const s = db.prepare('SELECT user_id FROM sessions WHERE id=?').get(decodeURIComponent(m[1]))
      if (s) return s.user_id
    }
  } catch {
    /* ignore */
  }
  return null
}

const AUTH_ACTOR = /^(auth\.(login|register|setup|2fa)|account\.password\.reset)/

// ---------- Protection against log flooding by anonymous failed attempts ----------
// Failed operations without a user (wrong login, key guessing …) can be triggered by anyone any number of times. Per IP and action
// at most ANON_BURST entries per ANON_WINDOW are written (the next entry carries the number of suppressed
// repeats in details.suppressed); across all IPs at most ANON_GLOBAL_MAX entries per minute (IP rotation).
const ANON_WINDOW = 60_000
const ANON_BURST = 5
const ANON_GLOBAL_MAX = 120
const anonSeen = new Map() // "ip|action" -> { start, n, suppressed }
let anonGlobal = { start: 0, n: 0 }
/** true = write (possibly with the counter of suppressed repeats), false = suppress. */
function anonAllow(ip, action) {
  const now = Date.now()
  if (now - anonGlobal.start >= ANON_WINDOW) anonGlobal = { start: now, n: 0 }
  if (anonGlobal.n >= ANON_GLOBAL_MAX) return { write: false }
  const k = `${ip || '?'}|${action}`
  let e = anonSeen.get(k)
  if (!e || now - e.start >= ANON_WINDOW) {
    const prev = e?.suppressed || 0
    e = { start: now, n: 0, suppressed: 0 }
    if (anonSeen.size > 5000) for (const [kk, v] of anonSeen) if (now - v.start >= ANON_WINDOW) anonSeen.delete(kk)
    anonSeen.set(k, e)
    e.carry = prev
  }
  if (e.n >= ANON_BURST) {
    e.suppressed++
    return { write: false }
  }
  e.n++
  anonGlobal.n++
  const carry = e.carry || 0
  e.carry = 0
  return { write: true, suppressed: carry }
}

const insertStmt = db.prepare(
  `INSERT INTO audit_log (at, actor_user_id, actor_label, via, ip, user_agent, action, target_type, target_id, target_label, space_id, status, details)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
)

/**
 * Writes an audit entry. Never throws.
 * @param {import('express').Request | { userId?: number, via?: 'session'|'api_key'|'system'|'anonymous', ip?: string, label?: string, userAgent?: string }} ctx
 * @param {string} action
 * @param {{ target?: { type: string, id?: string|number, label?: string }, details?: object, status?: 'ok'|'fail', spaceId?: number, userId?: number, label?: string }} [info]
 */
export function audit(ctx, action, info = {}) {
  try {
    let userId = info.userId ?? null
    let via
    let ip = null
    let ua = null
    let label = info.label ?? null
    if (isReq(ctx)) {
      ctx._audited = true
      userId ??= ctx.user?.id ?? null
      // Sign-in events: the user only becomes known through the operation (target of the entry)
      if (!userId && info.status !== 'fail' && info.target?.type === 'user' && AUTH_ACTOR.test(action)) userId = Number(info.target.id) || null
      via = ctx.apiKey ? 'api_key' : userId ? 'session' : 'anonymous'
      ip = cleanIp(ctx.ip)
      ua = ctx.headers?.['user-agent'] ?? null
    } else {
      userId ??= ctx?.userId ?? null
      via = ctx?.via || (userId ? 'session' : 'system')
      ip = cleanIp(ctx?.ip)
      ua = ctx?.userAgent ?? null
      label ??= ctx?.label ?? null
    }
    let details = info.details
    if (!userId && via !== 'system' && info.status === 'fail') {
      const a = anonAllow(ip, String(action))
      if (!a.write) return
      if (a.suppressed) details = { ...(details || {}), suppressed: a.suppressed }
    }
    if (via === 'system') label ??= 'System'
    label ??= userLabel(userId) ?? (typeof info.details?.email === 'string' ? info.details.email.slice(0, 254) : null) ?? info.target?.label ?? null
    const t = info.target
    insertStmt.run(
      new Date().toISOString(),
      userId,
      label ? clip(String(label), 254) : null,
      via,
      ip,
      ua ? clip(String(ua), 300) : null,
      clip(String(action), 120),
      t?.type ? clip(String(t.type), 60) : null,
      t?.id !== undefined && t?.id !== null ? clip(String(t.id), 120) : null,
      t?.label ? clip(String(t.label), 200) : null,
      Number.isInteger(info.spaceId) ? info.spaceId : null,
      info.status === 'fail' ? 'fail' : 'ok',
      safeDetails(details),
    )
  } catch (e) {
    console.error('[audit]', e?.message)
  }
}

// ---------- Route -> action ----------
const SEC = 'security'
const ALL = 'all'
const rules = []
/** pattern: ":name" = one segment, "*" = rest. t = [type, param name | (body, params, req) => id]. */
function R(method, pattern, action, lvl, opts = {}) {
  const names = []
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg === '*') return '.*'
      if (seg.startsWith(':')) {
        names.push(seg.slice(1))
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  rules.push({ method, re: new RegExp(`^${src}$`), names, action, lvl, ...opts })
}
const S = (m, p, a, o) => R(m, p, a, SEC, o)
const A = (m, p, a, o) => R(m, p, a, ALL, o)

const keys = (b, allowed) => Object.keys(b && typeof b === 'object' ? b : {}).filter((k) => !allowed || allowed.includes(k)).slice(0, 30)
const pickVals = (b, list) => Object.fromEntries(list.filter((k) => b?.[k] !== undefined && typeof b[k] !== 'object').map((k) => [k, b[k]]))
const email = (req) => (typeof req.body?.email === 'string' ? { email: req.body.email.slice(0, 254) } : {})

// --- Sign-in
S('POST', '/api/auth/setup', 'auth.setup', { details: email })
S('POST', '/api/auth/register', 'auth.register', { details: email })
S('POST', '/api/auth/login', 'auth.login', { details: email })
S('POST', '/api/auth/logout', 'auth.logout')
S('POST', '/api/auth/reset', 'auth.password.reset')
S('POST', '/api/auth/2fa/verify', 'auth.2fa.verify', { details: (req) => pickVals(req.body, ['method']) })
S('GET', '/api/auth/google/callback', 'auth.login.google', { redirectOk: true })
// --- Account
S('PUT', '/api/account', (req) => (req.body?.new_password ? 'account.password.change' : req.body?.email !== undefined ? 'account.email.change' : 'account.update'), {
  details: (req) => ({ fields: keys(req.body, ['name', 'email', 'locale', 'new_password']).map((k) => (k === 'new_password' ? 'password' : k)) }),
})
S('DELETE', '/api/account/google', 'account.google.unlink')
S('POST', '/api/account/2fa/totp/setup', 'account.2fa.totp.setup')
S('POST', '/api/account/2fa/totp/confirm', 'account.2fa.totp.enable')
S('POST', '/api/account/2fa/totp/disable', 'account.2fa.totp.disable')
S('POST', '/api/account/2fa/webauthn/register', 'account.2fa.passkey.add')
S('PUT', '/api/account/2fa/webauthn/:id', 'account.2fa.passkey.rename', { t: ['passkey', 'id'] })
S('DELETE', '/api/account/2fa/webauthn/:id', 'account.2fa.passkey.remove', { t: ['passkey', 'id'] })
S('POST', '/api/account/2fa/recovery/regenerate', 'account.2fa.recovery.regenerate')
S('DELETE', '/api/account/sessions/:id', 'account.session.revoke', { t: ['session', null] })
S('POST', '/api/account/sessions/*', 'account.sessions.revoke_others')
S('DELETE', '/api/account/sessions', 'account.sessions.revoke_others')
S('POST', '/api/account/api-keys', 'api_key.create')
S('DELETE', '/api/account/api-keys/:id', 'api_key.revoke', { t: ['api_key', 'id'] })
A('POST', '/api/account/avatar', 'account.avatar.set')
A('DELETE', '/api/account/avatar', 'account.avatar.remove')
// --- Admin
S('POST', '/api/admin/users', 'admin.user.create', { t: ['user', (b) => b?.user?.id], details: (req) => pickVals(req.body, ['role']) })
S('PUT', '/api/admin/users/:id', 'admin.user.update', { t: ['user', 'id'], details: (req) => ({ changed_keys: keys(req.body), ...pickVals(req.body, ['role', 'disabled']) }) })
S('DELETE', '/api/admin/users/:id', 'admin.user.delete', { t: ['user', 'id'] })
S('POST', '/api/admin/users/:id/reset-password', 'admin.user.reset_password', { t: ['user', 'id'] })
S('POST', '/api/admin/users/:id/reset-2fa', 'admin.user.reset_2fa', { t: ['user', 'id'] })
S('PUT', '/api/admin/users/:id/features', 'admin.user.features', { t: ['user', 'id'], details: (req) => pickVals(req.body, ['ai_enabled', 'api_enabled']) })
S('POST', '/api/admin/invites', 'admin.invite.create')
S('PUT', '/api/admin/ai', 'admin.ai.settings', { details: (req) => ({ changed_keys: keys(req.body), ...pickVals(req.body, ['ai_enabled', 'ai_provider', 'ai_model']) }) })
S('POST', '/api/admin/ai/test', 'admin.ai.test')
S('GET', '/api/admin/ai/usage/export.csv', 'admin.ai.usage.export', { details: (req) => pickVals(req.query, ['from', 'to']) })
S('PUT', '/api/admin/api-keys/settings', 'admin.api.settings', { details: (req) => pickVals(req.body, ['api_enabled']) })
S('DELETE', '/api/admin/api-keys/:id', 'admin.api_key.revoke', { t: ['api_key', 'id'] })
S('PUT', '/api/admin/audit/settings', 'admin.audit.settings', { details: (req) => pickVals(req.body, ['audit_level']) })
S('GET', '/api/admin/audit/export', 'audit.export', { details: (req) => pickVals(req.query, ['format', 'from', 'to', 'user_id', 'action', 'status', 'via', 'q']) })
S('PUT', '/api/admin/retention', 'admin.retention.settings', { details: (req) => pickVals(req.body, ['retention_audit_days', 'retention_ai_usage_days', 'retention_sessions_days']) })
S('POST', '/api/admin/retention/run', 'retention.run')
S('POST', '/api/admin/backups', 'backup.create')
S('POST', '/api/admin/backups/upload', 'backup.upload')
S('POST', '/api/admin/backups/:id/restore', 'backup.restore', { t: ['backup', 'id'] })
S('POST', '/api/admin/backups/:id/verify', 'backup.verify', { t: ['backup', 'id'] })
S('GET', '/api/admin/backups/:id/download', 'backup.download', { t: ['backup', 'id'] })
S('DELETE', '/api/admin/backups/:id', 'backup.delete', { t: ['backup', 'id'] })
S('PUT', '/api/admin/backups/settings', 'admin.backup.settings', { details: (req) => ({ changed_keys: keys(req.body) }) })
S('POST', '/api/admin/update/:step', (req, p) => `update.${p.step}`)
S('PUT', '/api/admin/update/settings', 'admin.update.settings', { details: (req) => ({ changed_keys: keys(req.body) }) })
// --- Bereiche, Teilen, Daten
S('POST', '/api/spaces', 'space.create')
S('PUT', '/api/spaces/:id', 'space.rename', { t: ['space', 'id'] })
S('DELETE', '/api/spaces/:id', 'space.delete', { t: ['space', 'id'] })
S('DELETE', '/api/spaces/:id/members/:userId', 'space.member.remove', { t: ['space', 'id'], details: (req, b, p) => ({ member_id: Number(p.userId) || null, self: Number(p.userId) === req.user?.id }) })
S('POST', '/api/spaces/:id/invites', 'space.invite.create', { t: ['space', 'id'] })
S('POST', '/api/invites/:token/accept', 'space.invite.accept')
S('POST', '/api/wishlists/:id/share', 'wishlist.share', { t: ['wishlist', 'id'], details: (req) => pickVals(req.body, ['link_enabled', 'regenerate']) })
S('POST', '/api/wishlists/:id/access', 'wishlist.access.add', { t: ['wishlist', 'id'], details: (req) => pickVals(req.body, ['user_id', 'email']) })
S('DELETE', '/api/wishlists/:id/access/me', 'wishlist.access.leave', { t: ['wishlist', 'id'] })
S('DELETE', '/api/wishlists/:id/access/:userId', 'wishlist.access.remove', { t: ['wishlist', 'id'], details: (req, b, p) => ({ user_id: Number(p.userId) || null }) })
S('POST', '/api/wishlists/:id/spaces', 'wishlist.space.add', { t: ['wishlist', 'id'], details: (req) => pickVals(req.body, ['space_id']) })
S('DELETE', '/api/wishlists/:id/spaces/:spaceId', 'wishlist.space.remove', { t: ['wishlist', 'id'], details: (req, b, p) => ({ space_id: Number(p.spaceId) || null }) })
S('POST', '/api/shared/:token/follow', 'wishlist.follow')
S('DELETE', '/api/shared/:token/follow', 'wishlist.unfollow')
S('GET', '/api/export', 'data.export')
S('POST', '/api/import', 'data.import')
S('GET', '/api/wishlists/:id/export', 'data.export.wishlist', { t: ['wishlist', 'id'] })
// Everything else under these prefixes is security-relevant (as yet unknown routes of other modules)
S('*', '/api/admin/*', null)
S('*', '/api/auth/*', null)
S('*', '/api/account/*', null)

// --- Planning & content (level "all" only, without content)
A('POST', '/api/persons', 'person.create')
A('PUT', '/api/persons/:id', 'person.update', { t: ['person', 'id'], details: (req) => ({ fields: keys(req.body) }) })
A('DELETE', '/api/persons/:id', 'person.delete', { t: ['person', 'id'] })
A('POST', '/api/persons/:id/link', 'person.link', { t: ['person', 'id'] })
A('POST', '/api/persons/:id/unlink', 'person.unlink', { t: ['person', 'id'] })
A('POST', '/api/occasions', 'occasion.create')
A('PUT', '/api/occasions/:id', 'occasion.update', { t: ['occasion', 'id'] })
A('PUT', '/api/occasions/:id/persons/:personId', 'occasion.update', { t: ['occasion', 'id'], details: (req) => ({ person_id: Number(req.params.personId) || null, ...pickVals(req.body, ['excluded']) }) })
A('DELETE', '/api/occasions/:id', 'occasion.delete', { t: ['occasion', 'id'] })
A('POST', '/api/items', 'item.create')
A('PUT', '/api/items/:id', 'item.update', { t: ['item', 'id'], details: (req) => ({ fields: keys(req.body) }) })
A('POST', '/api/items/:id/assign', 'item.assign', { t: ['item', 'id'], details: (req) => pickVals(req.body, ['person_id']) })
A('DELETE', '/api/items/:id', 'item.delete', { t: ['item', 'id'] })
A('POST', '/api/gifts', 'gift.create')
A('PUT', '/api/gifts/:id', 'gift.update', { t: ['gift', 'id'], details: (req) => ({ fields: keys(req.body) }) })
A('POST', '/api/gifts/:id/status', 'gift.status', { t: ['gift', 'id'], details: (req) => pickVals(req.body, ['status']) })
A('POST', '/api/gifts/:id/payment', 'gift.payment', { t: ['gift', 'id'], details: (req) => pickVals(req.body, ['payment_status']) })
A('POST', '/api/gifts/:id/givers/:personId/settle', 'gift.settle', { t: ['gift', 'id'] })
A('DELETE', '/api/gifts/:id', 'gift.delete', { t: ['gift', 'id'] })
A('POST', '/api/settle', 'settle.bulk')
A('PUT', '/api/settings', 'settings.update', { details: (req) => ({ changed_keys: keys(req.body) }) })
A('POST', '/api/demo', 'demo.load')
A('POST', '/api/wishlists', 'wishlist.create')
A('PUT', '/api/wishlists/:id', 'wishlist.update', { t: ['wishlist', 'id'], details: (req) => ({ fields: keys(req.body) }) })
A('DELETE', '/api/wishlists/:id', 'wishlist.delete', { t: ['wishlist', 'id'] })
A('POST', '/api/wishlists/:id/wishes', 'wish.create', { t: ['wishlist', 'id'] })
A('POST', '/api/wishlists/:id/reorder', 'wishlist.reorder', { t: ['wishlist', 'id'] })
A('PUT', '/api/wishes/:id', 'wish.update', { t: ['wish', 'id'] })
A('DELETE', '/api/wishes/:id', 'wish.delete', { t: ['wish', 'id'] })
A('POST', '/api/wishes/:id/reserve', 'wish.reserve', { t: ['wish', 'id'] })
A('DELETE', '/api/wishes/:id/reserve', 'wish.unreserve', { t: ['wish', 'id'] })
A('POST', '/api/ai/:feature', (req, p) => `ai.${p.feature}`)
// --- Public API v1 (key calls)
A('POST', '/api/v1/capture', 'api.capture', { details: (req, b) => ({ created: b?.created?.length ?? 0, inbox: b?.inbox ?? 0 }) })
A('POST', '/api/v1/ideas', 'api.idea.create')
A('POST', '/api/v1/wishlists/:id/wishes', 'api.wish.create', { t: ['wishlist', 'id'] })

function matchRule(method, pathname) {
  for (const r of rules) {
    if (r.method !== '*' && r.method !== method) continue
    const m = r.re.exec(pathname)
    if (m) return { r, params: Object.fromEntries(r.names.map((n, i) => [n, safeDecode(m[i + 1])])) }
  }
  return null
}
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function genericAction(req, pathname) {
  const pattern = req.route?.path ? String(req.route.path) : pathname.replace(/\/\d+(?=\/|$)/g, '/:id')
  return `api.${req.method.toLowerCase()}.${pattern}`
}

function numericSpace(req) {
  if (req.auditSpaceId) return req.auditSpaceId
  const h = Number(req.get?.('X-Space'))
  if (!Number.isInteger(h) || h <= 0 || !req.user) return null
  return db.prepare('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?').get(h, req.user.id) ? h : null
}

/** Express middleware: automatically logs mutating /api requests (and selected reading ones). */
export function auditMiddleware(req, res, next) {
  const pathname = String(req.originalUrl || req.url || '').split('?')[0]
  const mutating = MUTATING.has(req.method)
  let hit = matchRule(req.method, pathname)
  if (hit && !hit.r.action && !mutating) hit = null // catch-all rules only apply to mutating calls
  if (!hit && !mutating) return next()
  let body
  if (hit && (hit.r.t || hit.r.details)) {
    const orig = res.json.bind(res)
    res.json = (b) => {
      body = b
      return orig(b)
    }
  }
  res.on('finish', () => {
    try {
      if (req._audited) return
      const level = auditLevel()
      const fail = res.statusCode >= 400
      let rule = hit?.r
      let action = rule?.action
      if (rule && typeof action === 'function') action = action(req, hit.params)
      let lvl = rule?.lvl
      if (!rule || !action) {
        // Unknown mutating route: only at level "all" (security-relevant prefixes always)
        action = genericAction(req, pathname)
        lvl = rule ? SEC : ALL
      }
      if (lvl === ALL && level !== 'all') return
      // Unknown paths (404) and unauthenticated access to protected routes (401) are noise, not an event
      if (res.statusCode === 404) return
      if (!req.user && !req.apiKey && res.statusCode === 401 && !String(action).startsWith('auth.')) return
      // Generic api.* entries only for signed-in users (the action would otherwise contain an attacker-controlled path)
      if (!rule?.action && !req.user && !req.apiKey) return

      let userId = req.user?.id ?? null
      let status = fail ? 'fail' : 'ok'
      if (!userId && (!fail || rule?.redirectOk)) userId = sessionUser(res)
      if (rule?.redirectOk) status = userId ? 'ok' : 'fail'
      const via = req.apiKey ? 'api_key' : userId ? 'session' : 'anonymous'
      const details = {}
      let target
      if (rule?.details) Object.assign(details, rule.details(req, body, hit.params) || {})
      if (rule?.t) {
        const [type, src] = rule.t
        const id = typeof src === 'function' ? src(body, hit.params, req) : src ? hit.params[src] : null
        target = { type, ...(id !== null && id !== undefined ? { id } : {}) }
      }
      if (status === 'fail') {
        details.http_status = res.statusCode
        if (body && typeof body.code === 'string') details.error_code = body.code
      }
      const extra = req.auditInfo
      if (extra) {
        if (extra.target) target = extra.target
        if (extra.details) Object.assign(details, extra.details)
        if (extra.status) status = extra.status
      }
      // Failed sign-in: attempted email as the label (no password)
      audit(
        { userId, via, ip: req.ip, userAgent: req.headers?.['user-agent'] },
        action,
        { target, details, status, spaceId: numericSpace(req) ?? undefined },
      )
      // Values resolved from the request context (not from the ctx object above) such as the label are retained via userId
    } catch (e) {
      console.error('[audit]', e?.message)
    }
  })
  next()
}

// ---------- Abfragen ----------
const dayStart = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s)
const dayEnd = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999Z` : s)

function buildWhere(q) {
  const w = []
  const p = []
  const str = (k) => (typeof q[k] === 'string' && q[k].trim() ? q[k].trim() : null)
  const from = str('from')
  const to = str('to')
  if (from) {
    if (Number.isNaN(Date.parse(dayStart(from)))) throw Object.assign(bad('Invalid date (from)'), { code: 'invalid_date' })
    w.push('at>=?')
    p.push(new Date(dayStart(from)).toISOString())
  }
  if (to) {
    if (Number.isNaN(Date.parse(dayEnd(to)))) throw Object.assign(bad('Invalid date (to)'), { code: 'invalid_date' })
    w.push('at<=?')
    p.push(new Date(dayEnd(to)).toISOString())
  }
  const uid = str('user_id')
  if (uid) {
    w.push('actor_user_id=?')
    p.push(Number(uid) || -1)
  }
  const action = str('action')
  if (action) {
    const parts = action.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20)
    w.push(
      '(' + parts.map((x) => (x.endsWith('*') || x.endsWith('.') ? "action LIKE ? ESCAPE '\\'" : 'action=?')).join(' OR ') + ')',
    )
    for (const x of parts) p.push(x.endsWith('*') || x.endsWith('.') ? x.replace(/\*$/, '').replace(/[%_\\]/g, '\\$&') + '%' : x)
  }
  const status = str('status')
  if (status) {
    if (!['ok', 'fail'].includes(status)) throw Object.assign(bad('Invalid status'), { code: 'invalid_value' })
    w.push('status=?')
    p.push(status)
  }
  const via = str('via')
  if (via) {
    if (!['session', 'api_key', 'system', 'anonymous'].includes(via)) throw Object.assign(bad('Invalid access'), { code: 'invalid_value' })
    w.push('via=?')
    p.push(via)
  }
  for (const k of ['target_type', 'target_id']) if (str(k)) (w.push(`${k}=?`), p.push(str(k)))
  if (str('space_id')) (w.push('space_id=?'), p.push(Number(str('space_id')) || -1))
  const text = str('q')
  if (text) {
    const like = `%${text.slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`
    w.push(
      "(actor_label LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target_label LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')",
    )
    p.push(like, like, like, like, like, like)
  }
  return { w, p }
}

const view = (r) => ({ ...r, details: r.details ? safeParse(r.details) : null })
const safeParse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function listAudit(q) {
  const { w, p } = buildWhere(q)
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))
  const cursor = Number(q.cursor)
  if (q.cursor && Number.isInteger(cursor) && cursor > 0) (w.push('id<?'), p.push(cursor))
  const rows = db
    .prepare(`SELECT * FROM audit_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...p, limit + 1)
  const more = rows.length > limit
  const items = rows.slice(0, limit).map(view)
  return { items, next_cursor: more ? items[items.length - 1].id : null, limit }
}

const csvCell = (v) => {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s // Formelinjektion in Tabellenkalkulationen verhindern
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const csvRow = (cells) => cells.map(csvCell).join(',') + '\r\n'

const COLS = ['id', 'at', 'actor_user_id', 'actor_label', 'via', 'ip', 'user_agent', 'action', 'target_type', 'target_id', 'target_label', 'space_id', 'status', 'details']

export function auditRoutes(app) {
  const A_ = requireAdmin

  app.get('/api/admin/audit', A_, (req, res) => res.json(listAudit(req.query)))

  app.get('/api/admin/audit/actions', A_, (req, res) => {
    res.json(db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((r) => r.action))
  })

  app.get('/api/admin/audit/settings', A_, (req, res) => {
    res.json({ audit_level: auditLevel(), levels: AUDIT_LEVELS, total: db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n })
  })
  app.put('/api/admin/audit/settings', A_, (req, res) => {
    const lvl = req.body?.audit_level
    if (!AUDIT_LEVELS.includes(lvl)) throw Object.assign(bad('Invalid log level'), { code: 'invalid_value' })
    setSys('audit_level', lvl)
    res.json({ audit_level: auditLevel(), levels: AUDIT_LEVELS, total: db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n })
  })

  app.get('/api/admin/audit/export', A_, (req, res) => {
    const format = req.query.format === 'json' ? 'json' : 'csv'
    const { w, p } = buildWhere(req.query)
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="wishy-audit-${stamp}.${format}"`)
    const stmt = db.prepare(`SELECT * FROM audit_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''}${w.length ? ' AND' : ' WHERE'} id<? ORDER BY id DESC LIMIT 1000`)
    let cursor = Number.MAX_SAFE_INTEGER
    let first = true
    let total = 0
    if (format === 'csv') res.write('﻿' + csvRow(COLS))
    else res.write('[')
    while (total < 100_000) {
      const rows = stmt.all(...p, cursor)
      if (!rows.length) break
      for (const r of rows) {
        if (format === 'csv') res.write(csvRow(COLS.map((c) => r[c])))
        else {
          res.write((first ? '\n' : ',\n') + JSON.stringify(view(r)))
          first = false
        }
      }
      total += rows.length
      cursor = rows[rows.length - 1].id
    }
    res.end(format === 'json' ? '\n]\n' : '')
  })
}
