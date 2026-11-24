import fs from 'node:fs'
import path from 'node:path'
import { db, tx } from './db.js'
import {
  getSys, setSys, getSecretSys, setSecretSys, envLocked, baseUrl, registrationSettings, googleEnabled, googleCredentialsSet, defaultLocale, twoFactorPolicy, LOCALES,
} from './config.js'
import { requireAdmin, createSession, destroyUserSessions, clearSessionCookie } from './session.js'
import { hashPassword, createUser } from './auth.js'
import { audit } from './audit.js'
import { claimsRoutes } from './admin-claims.js'
import { lastActivityByUser, userActivityRoutes } from './admin-activity.js'
import { avatarUrl, removeUserAvatars } from './avatars.js'
import { twoFactorStatus, resetTwoFactor } from './twofactor.js'
import { normalizeTrustProxy, applyTrustProxy, trustProxyRaw } from './proxy.js'
import { deleteSpaceData, removeMember } from './spaces.js'
import { implicitReleases, wishIdsOfUserClaims } from './wishlists.js'
import { bad, notFound, conflict, newToken, sha256, reqId, cleanEmail, cleanName, cleanPassword } from './util.js'

const DAY = 86_400_000
const isSecretKey = (k) => /secret|api_key|password|token|_key$/i.test(k)

const listRow = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  disabled: !!u.disabled,
  has_password: !!u.password_hash,
  google_linked: !!u.google_sub,
  avatar_url: avatarUrl(u),
  locale: u.locale || null,
  two_factor: twoFactorStatus(u.id).enabled,
  created_at: u.created_at,
  last_login_at: u.last_login_at,
  space_count: u.space_count ?? 0,
  last_seen_at: u.last_seen_at ?? null,
  last_ip: u.last_ip ?? null,
})
const userRow = (id) =>
  db
    .prepare('SELECT u.*, (SELECT COUNT(*) FROM space_members m WHERE m.user_id=u.id) AS space_count FROM users u WHERE u.id=?')
    .get(id)

const otherActiveAdmins = (excludeId) =>
  db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0 AND id!=?").get(excludeId).n

function deleteUser(req, uid) {
  // The claims of this user and on this user's lists disappear with the cascade: collect them while the data still exists
  const released = implicitReleases(req, 'user_deleted', wishIdsOfUserClaims(uid))
  tx(() => {
    for (const s of db.prepare('SELECT s.id, s.personal FROM space_members m JOIN spaces s ON s.id=m.space_id WHERE m.user_id=?').all(uid)) {
      if (s.personal) deleteSpaceData(s.id)
      else removeMember(s.id, uid)
    }
    db.prepare('UPDATE persons SET linked_user_id=NULL WHERE linked_user_id=?').run(uid)
    removeUserAvatars(uid)
    db.prepare('DELETE FROM users WHERE id=?').run(uid)
  })
  released()
}

export function adminRoutes(app) {
  const A = requireAdmin
  claimsRoutes(app)
  userActivityRoutes(app)

  app.get('/api/admin/users', A, (req, res) => {
    const act = lastActivityByUser()
    res.json(
      db
        .prepare('SELECT u.*, (SELECT COUNT(*) FROM space_members m WHERE m.user_id=u.id) AS space_count FROM users u ORDER BY u.name COLLATE NOCASE')
        .all()
        .map((u) => listRow({ ...u, ...(act.get(u.id) ?? {}) })),
    )
  })

  app.post('/api/admin/users', A, async (req, res) => {
    const b = req.body || {}
    const name = cleanName(b.name)
    const email = cleanEmail(b.email)
    const role = b.role === 'admin' ? 'admin' : 'user'
    const hash = b.password ? await hashPassword(cleanPassword(b.password)) : null
    const u = createUser({ name, email, passwordHash: hash, role })
    let url = null
    if (!hash) {
      const token = newToken()
      db.prepare('INSERT INTO user_invites (token_hash, created_by, user_id, expires_at, uses_left) VALUES (?,?,?,?,1)').run(
        sha256(token), req.user.id, u.id, Date.now() + 7 * DAY,
      )
      url = `/register?invite=${token}`
    }
    audit(req, 'admin.user.create', { target: { type: 'user', id: u.id, label: email }, details: { role } })
    res.json({ user: listRow(userRow(u.id)), url, full_url: url ? baseUrl(req) + url : null })
  })

  app.put('/api/admin/users/:id', A, (req, res) => {
    const id = reqId(req.params.id, 'User not found', 'user_not_found')
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id)
    if (!u) throw notFound('User not found', 'user_not_found')
    const b = req.body || {}
    const upd = {}
    if (b.name !== undefined) upd.name = cleanName(b.name)
    if (b.email !== undefined) {
      const email = cleanEmail(b.email)
      if (db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(email, id)) throw conflict('This email address is already taken', 'email_taken')
      upd.email = email
    }
    if (b.role !== undefined) {
      if (!['admin', 'user'].includes(b.role)) throw bad('Invalid role', 'role_invalid')
      upd.role = b.role
    }
    if (b.disabled !== undefined) upd.disabled = b.disabled ? 1 : 0
    const losesAdmin = u.role === 'admin' && !u.disabled && ((upd.role && upd.role !== 'admin') || upd.disabled === 1)
    if (losesAdmin && otherActiveAdmins(id) === 0) throw bad('The last administrator cannot be demoted or disabled', 'last_admin')
    tx(() => {
      const cols = Object.keys(upd)
      if (cols.length) db.prepare(`UPDATE users SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => upd[c]), id)
      if (upd.name) db.prepare('UPDATE persons SET name=? WHERE linked_user_id=? AND name=?').run(upd.name, id, u.name)
      if (upd.disabled === 1) destroyUserSessions(id)
    })
    audit(req, 'admin.user.update', { target: { type: 'user', id, label: u.email }, details: { keys: Object.keys(upd) } })
    res.json(listRow(userRow(id)))
  })

  app.post('/api/admin/users/:id/reset-password', A, (req, res) => {
    const id = reqId(req.params.id, 'User not found', 'user_not_found')
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) throw notFound('User not found', 'user_not_found')
    const token = newToken()
    tx(() => {
      db.prepare('DELETE FROM password_resets WHERE user_id=?').run(id)
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(token), id, Date.now() + DAY)
    })
    audit(req, 'admin.user.reset_password', { target: { type: 'user', id } })
    const url = `/reset-password?token=${token}`
    res.json({ url, full_url: baseUrl(req) + url })
  })

  app.delete('/api/admin/users/:id', A, (req, res) => {
    const id = reqId(req.params.id, 'User not found', 'user_not_found')
    if (id === req.user.id) throw bad('You cannot delete your own account', 'cannot_delete_self')
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id)
    if (!u) throw notFound('User not found', 'user_not_found')
    if (u.role === 'admin' && !u.disabled && otherActiveAdmins(id) === 0) throw bad('The last administrator cannot be deleted', 'last_admin')
    deleteUser(req, id)
    audit(req, 'admin.user.delete', { target: { type: 'user', id, label: u.email } })
    res.json({ ok: true })
  })

  app.post('/api/admin/users/:id/reset-2fa', A, (req, res) => {
    const id = reqId(req.params.id, 'User not found', 'user_not_found')
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id)
    if (!u) throw notFound('User not found', 'user_not_found')
    tx(() => {
      resetTwoFactor(id)
      destroyUserSessions(id, id === req.user.id ? req.sessionId : '')
    })
    audit(req, 'admin.user.reset_2fa', { target: { type: 'user', id, label: u.email } })
    res.json(listRow(userRow(id)))
  })

  app.post('/api/admin/invites', A, (req, res) => {
    const token = newToken()
    db.prepare('INSERT INTO user_invites (token_hash, created_by, user_id, expires_at, uses_left) VALUES (?,?,NULL,?,1)').run(
      sha256(token), req.user.id, Date.now() + 7 * DAY,
    )
    const url = `/register?invite=${token}`
    audit(req, 'admin.invite.create', { details: {} })
    res.json({ url, full_url: baseUrl(req) + url })
  })

  // ---------- Settings: general / sign-in ----------
  const putter = () => {
    const locked = new Set(envLocked())
    const changed = []
    return {
      changed,
      locked,
      put(k, v) {
        if (locked.has(k)) return
        setSys(k, v)
        changed.push(k)
      },
    }
  }
  const retentionVal = (v, name) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n > 36500) throw bad(`Invalid value for ${name}`, 'retention_invalid')
    return n
  }

  function applyGeneral(b, w) {
    if (b.app_name !== undefined) w.put('app_name', String(b.app_name).trim().slice(0, 60) || null)
    if (b.base_url !== undefined) {
      const v = String(b.base_url).trim().replace(/\/+$/, '')
      if (v && !/^https?:\/\/[^\s/]+/i.test(v)) throw bad('The base URL must start with http:// or https://', 'base_url_invalid')
      w.put('base_url', v || null)
    }
    if (b.default_locale !== undefined) {
      if (!LOCALES.includes(b.default_locale)) throw bad('Invalid language', 'locale_invalid')
      w.put('default_locale', b.default_locale)
    }
    if (b.trust_proxy !== undefined && !w.locked.has('trust_proxy')) {
      w.put('trust_proxy', normalizeTrustProxy(b.trust_proxy) || null)
      applyTrustProxy()
    }
    for (const k of ['retention_audit_days', 'retention_ai_usage_days', 'retention_sessions_days', 'retention_ip_days']) {
      if (b[k] !== undefined) w.put(k, b[k] === null || b[k] === '' ? null : retentionVal(b[k], k))
    }
  }

  function applyAuth(b, w) {
    if (b.registration_enabled !== undefined) w.put('registration_enabled', !!b.registration_enabled)
    if (b.registration_mode !== undefined) {
      if (!['open', 'invite'].includes(b.registration_mode)) throw bad('Invalid registration mode', 'registration_invalid')
      w.put('registration_mode', b.registration_mode)
    }
    if (b.google_enabled !== undefined) w.put('google_enabled', !!b.google_enabled)
    if (b.google_client_id !== undefined) w.put('google_client_id', String(b.google_client_id).trim() || null)
    // Store the client secret encrypted (secret.key); the environment variable still takes precedence
    if (!w.locked.has('google_client_secret')) {
      if (b.google_client_secret === null) setSecretSys('google_client_secret', null)
      else if (typeof b.google_client_secret === 'string' && b.google_client_secret.trim()) setSecretSys('google_client_secret', b.google_client_secret.trim())
      if (b.google_client_secret === null || typeof b.google_client_secret === 'string') w.changed.push('google_client_secret')
    }
    if (b.two_factor_policy !== undefined) {
      if (!['optional', 'required'].includes(b.two_factor_policy)) throw bad('Invalid 2FA policy', 'two_factor_policy_invalid')
      w.put('two_factor_policy', b.two_factor_policy)
    }
  }

  const generalOut = (req) => {
    const raw = trustProxyRaw()
    return {
      app_name: getSys('app_name'),
      base_url: getSys('base_url') || '',
      default_locale: defaultLocale(),
      locales: LOCALES,
      trust_proxy: raw,
      effective_base_url: baseUrl(req),
      retention_audit_days: getSys('retention_audit_days') ?? 365,
      retention_ai_usage_days: getSys('retention_ai_usage_days') ?? 730,
      retention_sessions_days: getSys('retention_sessions_days') ?? null,
      retention_ip_days: getSys('retention_ip_days') ?? 90,
      env_locked: envLocked(),
    }
  }
  const authOut = (req) => {
    const reg = registrationSettings()
    return {
      registration_enabled: reg.enabled,
      registration_mode: reg.mode,
      google_enabled: googleEnabled(),
      google_credentials_set: googleCredentialsSet(),
      google_client_id: getSys('google_client_id') || '',
      google_client_secret_set: !!getSecretSys('google_client_secret'),
      redirect_uri: `${baseUrl(req)}/api/auth/google/callback`,
      two_factor_policy: twoFactorPolicy(),
      env_locked: envLocked(),
    }
  }
  const settingsAudit = (req, group, changed) => {
    if (changed.length) audit(req, 'admin.settings.update', { details: { group, keys: changed } })
  }

  app.get('/api/admin/settings/general', A, (req, res) => res.json(generalOut(req)))
  app.put('/api/admin/settings/general', A, (req, res) => {
    const w = putter()
    applyGeneral(req.body || {}, w)
    settingsAudit(req, 'general', w.changed)
    res.json(generalOut(req))
  })
  app.get('/api/admin/settings/auth', A, (req, res) => res.json(authOut(req)))
  app.put('/api/admin/settings/auth', A, (req, res) => {
    const w = putter()
    applyAuth(req.body || {}, w)
    settingsAudit(req, 'auth', w.changed)
    res.json(authOut(req))
  })

  app.get('/api/admin/stats', A, (req, res) => {
    const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
    let size = 0
    try {
      const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
      for (const f of ['wishlist.db', 'wishlist.db-wal']) {
        try {
          size += fs.statSync(path.join(DATA_DIR, f)).size
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    res.json({ users: n('users'), spaces: n('spaces'), items: n('items'), gifts: n('gifts'), db_size_bytes: size })
  })
}
