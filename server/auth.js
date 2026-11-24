import { db, tx, cleanup } from './db.js'
import { defaultName } from './locale.js'
import { registrationSettings, googleEnabled, getSys, defaultLocale, LOCALES } from './config.js'
import { serverKey } from './secret.js'
import { createSession, destroySession, destroyUserSessions, requireAuth } from './session.js'
import { createSpace, meOf, acceptSpaceInvite } from './spaces.js'
import { hashPassword, verifyPassword, DUMMY_HASH, makeLimiter, assertCurrentPassword } from './password.js'
import { respondLogin, requireConfirm } from './twofactor-routes.js'
import { passkeyLoginOptions, verifyPasskeyLogin } from './webauthn.js'
import { clearIdpAvatar } from './avatars.js'
import { has2fa } from './twofactor.js'
import { audit } from './audit.js'
import {
  HttpError, bad, conflict, forbidden, sha256, cleanEmail, cleanName, cleanPassword, tooMany, unauthorized, ipKey, makeHitCounter,
} from './util.js'

export { hashPassword, verifyPassword }

// ---------- Rate limiting (sign-in & co.) ----------
// Final values (all per client IP; behind a trusted proxy this is the real IP, IPv6 rounded to /64):
//  - Password login, failed attempts per IP + email:  10 per 15 min  -> 429 (soft lock for this combination only)
//  - Password login, failed attempts per IP in total:    40 per 15 min  -> 429 (password spraying across many email addresses)
//  - Failed attempts per account (all IPs):  from the 21st failed attempt/h a delay of 2 s, 4 s, 8 s … (at most 15 min) grows –
//    it does NOT apply to IPs the account has already signed in from (existing session). No hard lock,
//    so nobody can lock the victim out with foreign failed attempts.
//  - Passkey sign-in (POST /api/auth/passkey/verify): failures count in the same two IP limiters (ip|"passkey" and IP in total)
//  - All unauthenticated POSTs (login, register, reset, setup, 2fa/*, passkey/*): 60 per minute and IP (hits, not only failures)
//  - Register/reset/setup (scrypt, CPU-expensive) additionally: 12 per minute and IP
const loginFails = makeLimiter(10) // ip|email
const loginFailsIp = makeLimiter(40) // IP only
const ACCT_FREE = 20
const ACCT_WINDOW = 3_600_000
const acctFails = new Map() // email -> { n, reset, until }
const anonPosts = makeHitCounter(60)
const heavyPosts = makeHitCounter(12)
const failKey = (req, email) => `${ipKey(req.ip)}|${String(email).toLowerCase().slice(0, 254)}`
const acctKey = (email) => String(email).toLowerCase().slice(0, 254)
const retry429 = (res, secs, msg) => {
  res.setHeader('Retry-After', String(secs))
  return tooMany(msg || 'Too many sign-in attempts. Please wait a few minutes.', 'too_many_attempts')
}
function acctWait(email, req) {
  const e = acctFails.get(acctKey(email))
  if (!e || Date.now() > e.reset || !(e.until > Date.now())) return 0
  // From an IP the account already had a session with: do not slow down
  const u = db.prepare('SELECT id FROM users WHERE email=?').get(email)
  if (u && db.prepare('SELECT 1 FROM sessions WHERE user_id=? AND ip=? LIMIT 1').get(u.id, String(req.ip || '').slice(0, 64))) return 0
  return Math.ceil((e.until - Date.now()) / 1000)
}
function acctNoteFail(email) {
  const k = acctKey(email)
  const now = Date.now()
  let e = acctFails.get(k)
  if (!e || now > e.reset) e = { n: 0, reset: now + ACCT_WINDOW, until: 0 }
  e.n++
  if (e.n > ACCT_FREE) e.until = now + Math.min(2 ** (e.n - ACCT_FREE) * 1000, 15 * 60_000)
  acctFails.set(k, e)
  if (acctFails.size > 10_000) for (const [kk, v] of acctFails) if (now > v.reset) acctFails.delete(kk)
}

// ---------- Create user ----------
export const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n

/** Creates a user + personal space (localized name). */
export function createUser({ name, email, passwordHash = null, googleSub = null, googleEmail = null, role = 'user', locale = null }) {
  return tx(() => {
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw conflict('This email address is already registered', 'email_taken')
    const uid = Number(
      db
        .prepare('INSERT INTO users (email, name, password_hash, google_sub, google_email, role, locale) VALUES (?,?,?,?,?,?,?)')
        .run(email, name, passwordHash, googleSub, googleEmail, role, LOCALES.includes(locale) ? locale : null).lastInsertRowid,
    )
    createSpace(defaultName(LOCALES.includes(locale) ? locale : defaultLocale(), 'personalSpace'), uid, { personal: true })
    return db.prepare('SELECT * FROM users WHERE id=?').get(uid)
  })
}

export function startup() {
  serverKey() // fail early and loudly if secret.key is missing but encrypted data exists
  cleanup()
  setInterval(() => {
    try {
      cleanup()
      loginFails.sweep()
      loginFailsIp.sweep()
    } catch (e) {
      console.error(e)
    }
  }, 3_600_000).unref()
}

const login = (req, res, userId) => {
  createSession(req, res, userId)
  res.json(meOf(userId))
}

function findUserInvite(token) {
  if (!token) return null
  const r = db.prepare('SELECT * FROM user_invites WHERE token_hash=?').get(sha256(token))
  return r && r.expires_at > Date.now() && r.uses_left > 0 ? r : null
}
function findSpaceInvite(token) {
  if (!token) return null
  const r = db.prepare('SELECT * FROM space_invites WHERE token=?').get(token)
  return r && r.expires_at > Date.now() && r.uses_left > 0 ? r : null
}

/** Checks whether a new user (e.g. via Google) may register. Returns a redemption object. */
export function registrationGate(inviteToken) {
  const reg = registrationSettings()
  const token = inviteToken ? String(inviteToken) : ''
  const spaceInv = findSpaceInvite(token)
  const userInv = findUserInvite(token)
  const generic = userInv && !userInv.user_id ? userInv : null
  const allowed = reg.enabled && (reg.mode === 'open' || (reg.mode === 'invite' && (spaceInv || generic)))
  return { allowed: !!allowed, token, spaceInv, generic }
}

export function redeemInvite(gate, userId) {
  if (gate.spaceInv) {
    try {
      acceptSpaceInvite(gate.token, userId)
    } catch {
      /* invite has been used up in the meantime - registration stays valid */
    }
  }
  if (gate.generic) db.prepare('UPDATE user_invites SET uses_left=uses_left-1 WHERE token_hash=?').run(gate.generic.token_hash)
}

// ---------- Routen ----------
export function authRoutes(app) {
  // Rate limiting of all unauthenticated POSTs (see numbers above)
  const ANON = /^\/api\/auth\/(login|register|reset|setup|passkey[/][a-z]+|2fa\/[a-z-]+)$/
  const HEAVY = /^\/api\/auth\/(register|reset|setup)$/
  app.use('/api/auth', (req, res, next) => {
    if (req.method !== 'POST') return next()
    const p = req.originalUrl.split('?')[0]
    if (!ANON.test(p)) return next()
    const ip = ipKey(req.ip)
    if (anonPosts.hit(ip) || (HEAVY.test(p) && heavyPosts.hit(ip))) return next(retry429(res, anonPosts.retryAfter(ip), 'Too many requests. Please wait a moment.'))
    next()
  })

  app.get('/api/auth/providers', (req, res) => {
    res.json({
      app_name: getSys('app_name'),
      registration: registrationSettings(),
      google: googleEnabled(),
      default_locale: defaultLocale(),
      locales: LOCALES,
    })
  })

  // Public: check invite (for the registration form)
  app.get('/api/auth/invite/:token', (req, res) => {
    const token = String(req.params.token || '')
    const ui = findUserInvite(token)
    if (ui) {
      const u = ui.user_id ? db.prepare('SELECT name, email, password_hash FROM users WHERE id=?').get(ui.user_id) : null
      if (ui.user_id && (!u || u.password_hash)) return res.json({ valid: false })
      return res.json({
        valid: true,
        kind: 'user',
        bound: !!ui.user_id,
        ...(u ? { name: u.name, email: u.email } : {}),
      })
    }
    const si = findSpaceInvite(token)
    if (si) {
      const sp = db.prepare('SELECT name FROM spaces WHERE id=?').get(si.space_id)
      return res.json({ valid: true, kind: 'space', bound: false, space_name: sp?.name })
    }
    res.json({ valid: false })
  })

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) {
      if (userCount() === 0) return res.json({ setup: true })
      throw unauthorized()
    }
    res.json(meOf(req.user.id))
  })

  app.post('/api/auth/setup', async (req, res) => {
    if (userCount() > 0) throw forbidden('Setup is already complete', 'setup_done')
    const b = req.body || {}
    const name = cleanName(b.name)
    const email = cleanEmail(b.email)
    const password = cleanPassword(b.password)
    const passwordHash = await hashPassword(password)
    if (userCount() > 0) throw forbidden('Setup is already complete', 'setup_done')
    const u = createUser({ name, email, passwordHash, role: 'admin', locale: b.locale })
    audit(req, 'auth.setup', { target: { type: 'user', id: u.id, label: email } })
    login(req, res, u.id)
  })

  app.post('/api/auth/register', async (req, res) => {
    if (userCount() === 0) throw bad('Please set up the app first', 'setup_required')
    const b = req.body || {}
    const token = b.invite ? String(b.invite) : ''

    // Account created by an admin: the link sets the password
    const bound = findUserInvite(token)
    if (bound?.user_id) {
      const password = cleanPassword(b.password)
      const hash = await hashPassword(password)
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(bound.user_id)
      // An invite may only set up an account without credentials - never overwrite an existing password/2FA/Google
      if (!u || u.disabled || u.password_hash || u.google_sub || has2fa(u.id)) throw bad('The invite is invalid or has expired', 'invite_invalid')
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, u.id)
      db.prepare('DELETE FROM user_invites WHERE token_hash=?').run(bound.token_hash)
      audit(req, 'auth.register', { target: { type: 'user', id: u.id, label: u.email }, details: { via: 'admin_invite' } })
      return login(req, res, u.id)
    }

    const gate = registrationGate(token)
    if (!gate.allowed) {
      const reg = registrationSettings()
      throw !reg.enabled
        ? forbidden('Registration is disabled', 'registration_disabled')
        : forbidden('Registration is by invitation only', 'registration_invite_only')
    }
    const name = cleanName(b.name)
    const email = cleanEmail(b.email)
    const hash = await hashPassword(cleanPassword(b.password))
    const u = createUser({ name, email, passwordHash: hash, locale: b.locale })
    redeemInvite(gate, u.id)
    audit(req, 'auth.register', { target: { type: 'user', id: u.id, label: email }, details: { via: gate.token ? 'invite' : 'open' } })
    login(req, res, u.id)
  })

  app.post('/api/auth/login', async (req, res) => {
    const b = req.body || {}
    const email = String(b.email ?? '').trim()
    const password = String(b.password ?? '')
    const key = failKey(req, email)
    const ipk = ipKey(req.ip)
    if (loginFails.limited(key) || loginFailsIp.limited(ipk)) {
      audit(req, 'auth.login', { status: 'fail', details: { email, reason: 'rate_limited' } })
      throw retry429(res, 60)
    }
    const wait = email ? acctWait(email, req) : 0
    if (wait) {
      audit(req, 'auth.login', { status: 'fail', details: { email, reason: 'account_backoff' } })
      throw retry429(res, wait)
    }
    const u = email ? db.prepare('SELECT * FROM users WHERE email=?').get(email) : null
    const ok = await verifyPassword(password, u?.password_hash || DUMMY_HASH)
    if (!u || !u.password_hash || !ok) {
      loginFails.fail(key)
      loginFailsIp.fail(ipk)
      if (email) acctNoteFail(email)
      audit(req, 'auth.login', { status: 'fail', details: { email, reason: 'invalid_credentials' } })
      throw new HttpError(401, 'Incorrect email or password', 'invalid_credentials')
    }
    if (u.disabled) {
      audit(req, 'auth.login', { status: 'fail', target: { type: 'user', id: u.id, label: u.email }, details: { reason: 'disabled' } })
      throw forbidden('This account is disabled', 'account_disabled')
    }
    loginFails.clear(key)
    acctFails.delete(acctKey(email))
    // With an active second factor, step 2 follows (POST /api/auth/2fa/verify); the login is logged there
    if (!has2fa(u.id)) audit(req, 'auth.login', { target: { type: 'user', id: u.id, label: u.email } })
    respondLogin(req, res, u, 'password')
  })

  // ---------- Passwordless sign-in with a passkey (discoverable credential, user verification required) ----------
  // A passkey with user verification is possession + biometrics/PIN and therefore replaces password AND second factor; no 2FA step follows.
  // Every failure answers identically (passkey_login_failed), takes at least ~300 ms and is counted by the brute-force limiters.
  app.post('/api/auth/passkey/options', async (req, res) => {
    if (loginFailsIp.limited(ipKey(req.ip))) throw retry429(res, 60)
    res.json(await passkeyLoginOptions(req, res))
  })

  app.post('/api/auth/passkey/verify', async (req, res) => {
    const started = Date.now()
    const ipk = ipKey(req.ip)
    const key = failKey(req, 'passkey')
    if (loginFails.limited(key) || loginFailsIp.limited(ipk)) {
      audit(req, 'auth.login', { status: 'fail', details: { method: 'passkey', reason: 'rate_limited' } })
      throw retry429(res, 60)
    }
    let u
    try {
      u = await verifyPasskeyLogin(req, res, req.body?.response)
    } catch (e) {
      if (e.code !== 'passkey_login_failed') throw e
      loginFails.fail(key)
      loginFailsIp.fail(ipk)
      audit(req, 'auth.login', { status: 'fail', ...(e.userId ? { target: { type: 'user', id: e.userId } } : {}), details: { method: 'passkey', reason: 'passkey_failed' } })
      await new Promise((r) => setTimeout(r, Math.max(0, 300 - (Date.now() - started))))
      throw e
    }
    loginFails.clear(key)
    audit(req, 'auth.login', { target: { type: 'user', id: u.id, label: u.email }, details: { method: 'passkey' } })
    login(req, res, u.id)
  })

  app.post('/api/auth/logout', (req, res) => {
    if (req.user) audit(req, 'auth.logout', { target: { type: 'user', id: req.user.id, label: req.user.email } })
    destroySession(req, res)
    res.json({ ok: true })
  })

  // Passwort per Einmal-Link setzen (Admin-Reset)
  app.post('/api/auth/reset', async (req, res) => {
    const token = String(req.body?.token ?? '')
    const password = cleanPassword(req.body?.password)
    const hash = await hashPassword(password)
    const r = token ? db.prepare('SELECT * FROM password_resets WHERE token_hash=?').get(sha256(token)) : null
    if (!r || r.expires_at < Date.now()) throw bad('The link is invalid or has expired', 'reset_invalid')
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.user_id)
    if (!u || u.disabled) throw bad('The link is invalid or has expired', 'reset_invalid')
    tx(() => {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, u.id)
      db.prepare('DELETE FROM password_resets WHERE user_id=?').run(u.id)
      destroyUserSessions(u.id)
    })
    audit(req, 'account.password.reset', { target: { type: 'user', id: u.id, label: u.email } })
    respondLogin(req, res, u, 'password')
  })

  app.put('/api/account', requireAuth, async (req, res) => {
    const b = req.body || {}
    const u = req.user
    const upd = {}
    const changed = []
    if (b.name !== undefined) upd.name = cleanName(b.name)
    if (b.locale !== undefined) {
      if (b.locale !== null && b.locale !== '' && !LOCALES.includes(b.locale)) throw bad('Invalid language', 'locale_invalid')
      upd.locale = b.locale || null
    }
    if (b.email !== undefined) {
      const email = cleanEmail(b.email)
      if (email.toLowerCase() !== String(u.email).toLowerCase()) {
        if (!u.password_hash) throw bad('Set a password first to change the email address', 'password_required')
        await assertCurrentPassword(u, b.current_password)
        const other = db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(email, u.id)
        if (other) throw conflict('This email address is already taken', 'email_taken')
        upd.email = email
        changed.push('email')
      }
    }
    let newHash
    if (b.new_password !== undefined && b.new_password !== '') {
      const np = cleanPassword(b.new_password)
      // First password of an account without a password (e.g. Google only): only with fresh confirmation - right after signing in
      // (10 minutes), after re-confirming with Google or with a 2FA code. A stolen session is not enough.
      if (u.password_hash) await assertCurrentPassword(u, b.current_password)
      else await requireConfirm(req)
      newHash = await hashPassword(np)
      upd.password_hash = newHash
      changed.push('password')
    }
    tx(() => {
      const cols = Object.keys(upd)
      if (cols.length) db.prepare(`UPDATE users SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => upd[c]), u.id)
      if (upd.name) {
        // Linked people keep the account name
        db.prepare('UPDATE persons SET name=? WHERE linked_user_id=? AND name=?').run(upd.name, u.id, u.name)
      }
      if (newHash) destroyUserSessions(u.id, req.sessionId)
    })
    if (changed.includes('email')) audit(req, 'account.email.change', { target: { type: 'user', id: u.id, label: upd.email } })
    if (changed.includes('password')) audit(req, 'account.password.change', { target: { type: 'user', id: u.id, label: u.email } })
    res.json(meOf(u.id))
  })

  // Disconnect sign-in provider (only with a password set)
  const unlink = async (req, res) => {
    if (!req.user.password_hash) throw bad('Set a password first before disconnecting Google', 'password_required')
    await requireConfirm(req)
    db.prepare('UPDATE users SET google_sub=NULL, google_email=NULL WHERE id=?').run(req.user.id)
    clearIdpAvatar(req.user.id)
    audit(req, 'account.identity.unlink', { target: { type: 'user', id: req.user.id, label: req.user.email }, details: { provider: 'google' } })
    res.json(meOf(req.user.id))
  }
  app.delete('/api/account/google', requireAuth, unlink)
  app.delete('/api/account/identities/google', requireAuth, unlink)
}
