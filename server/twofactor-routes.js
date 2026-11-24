// Routes for two-factor sign-in, 2FA management and re-confirmation (re-auth).
import QRCode from 'qrcode'
import { db } from './db.js'
import { getSys } from './config.js'
import { requireAuth, createSession, markFresh, isFresh, destroyUserSessions } from './session.js'
import { meOf } from './spaces.js'
import { audit } from './audit.js'
import { assertCurrentPassword } from './password.js'
import {
  twoFactorStatus, has2fa, hasTotp, passkeyCount, recoveryLeft, newTotpSecret, sealSecret, openSecret, otpauthUri, matchTotp,
  base32Decode, checkUserTotp, generateRecoveryCodes, useRecoveryCode, pruneRecoveryIfNoMethod, mustSetup2fa,
  assertNotLocked, noteCodeFail, noteCodeOk, makeTicket, readTicket, ticketAttempt, burnTicket,
} from './twofactor.js'
import { registrationOptions, verifyRegistration, authenticationOptions, verifyAssertion } from './webauthn.js'
import { HttpError, bad, conflict, forbidden, notFound, parseCookies, setCookie, clearCookie } from './util.js'

const MAX_PASSKEYS = 10

export function twoFactorMethods(userId) {
  const m = []
  if (hasTotp(userId)) m.push('totp')
  if (passkeyCount(userId) > 0) m.push('webauthn')
  if (m.length) m.push('recovery')
  return m
}

/**
 * Signs the user in or requests the second factor.
 * Returns { session: true } (session is created) or { ticket, methods }.
 */
export function beginLogin(req, res, user, via = 'password') {
  if (has2fa(user.id)) {
    return { session: false, ticket: makeTicket(req, user.id, via), methods: twoFactorMethods(user.id) }
  }
  createSession(req, res, user.id)
  return { session: true }
}

/** Response after a successful sign-in or 2FA prompt (JSON variant for password login). */
export function respondLogin(req, res, user, via = 'password') {
  const r = beginLogin(req, res, user, via)
  if (!r.session) return res.json({ two_factor: { methods: r.methods, ticket: r.ticket } })
  res.json(meOf(user.id))
}

const isTotpShape = (c) => /^\d{6}$/.test(String(c ?? '').replace(/\s+/g, ''))

/** Verifies a TOTP or recovery code (for confirmations in the account). */
export function assertSecondFactorCode(req, user, code) {
  assertNotLocked(user.id)
  const ok = isTotpShape(code) ? checkUserTotp(user.id, code) : useRecoveryCode(user.id, code)
  if (!ok) {
    noteCodeFail(user.id)
    audit(req, 'auth.2fa.verify_fail', { target: { type: 'user', id: user.id }, status: 'fail', details: { context: 'confirm' } })
    throw bad('The code is invalid', 'code_invalid')
  }
  noteCodeOk(user.id)
}

/** Requires a password, 2FA code or passkey (user verification) in the request body; records the confirmation in the session (10 minutes). */
async function confirmIdentity(req) {
  const b = req.body || {}
  const u = req.user
  if (b.current_password !== undefined && b.current_password !== '') {
    await assertCurrentPassword(u, b.current_password)
    markFresh(req)
    return true
  }
  if (b.passkey) {
    // Re-confirmation with a passkey: challenge from POST /api/account/reauth/passkey-options, bound to this session
    if (!req.sessionId || !passkeyCount(u.id)) throw bad('No security key is registered for this account', 'webauthn_not_available')
    assertNotLocked(u.id)
    try {
      await verifyAssertion(req, u.id, `reauth:${req.sessionId}`, b.passkey, { requireUV: true })
    } catch (e) {
      noteCodeFail(u.id)
      audit(req, 'auth.2fa.verify_fail', { target: { type: 'user', id: u.id }, status: 'fail', details: { context: 'confirm', method: 'webauthn' } })
      throw e
    }
    noteCodeOk(u.id)
    markFresh(req)
    return true
  }
  if (b.code) {
    if (!has2fa(u.id)) throw bad('Two-factor is not enabled', 'two_factor_not_enabled')
    assertSecondFactorCode(req, u, b.code)
    markFresh(req)
    return true
  }
  return false
}

/**
 * Requires fresh confirmation for sensitive actions: password/2FA code in the request body or a session confirmed in the
 * last 10 minutes (sign-in, POST /api/account/reauth, Google re-confirmation). Otherwise 403 `reauth_required`;
 * the client then opens the shared confirmation dialog and repeats the request.
 */
export async function requireConfirm(req) {
  if (await confirmIdentity(req)) return
  if (isFresh(req)) return
  throw forbidden('Please confirm it is you first', 'reauth_required')
}

/** After changes to the second factors: end all other sessions (a stolen session should keep nothing). */
function revokeOthers(req) {
  destroyUserSessions(req.user.id, req.sessionId)
}

// Short-lived HttpOnly cookie for the 2FA ticket after Google sign-in (instead of the ticket in the URL)
export const TFA_COOKIE = 'wl_2fa'
export const TFA_COOKIE_PATH = '/api/auth'
export const setTicketCookie = (res, req, ticket) => setCookie(res, req, TFA_COOKIE, ticket, { maxAge: 300, path: TFA_COOKIE_PATH })

const statusPayload = (userId) => {
  const s = twoFactorStatus(userId)
  return {
    ...s,
    passkey_list: db
      .prepare('SELECT id, name, created_at, last_used_at, device_type, backed_up, passwordless FROM user_webauthn WHERE user_id=? ORDER BY created_at')
      .all(userId)
      .map((p) => ({ ...p, backed_up: !!p.backed_up, passwordless: p.passwordless === null ? null : !!p.passwordless })), // null = unknown (older passkey)
    policy: getSys('two_factor_policy') === 'required' ? 'required' : 'optional',
    must_setup: mustSetup2fa(userId),
  }
}

const ALLOWED_WHILE_SETUP = /^\/api\/(auth\/|account\/2fa|account\/reauth|avatars\/)/

/** Enforces 2FA setup when the policy is "required" and the user has no method yet. */
export function twoFactorGate(req, res, next) {
  if (!req.user || ALLOWED_WHILE_SETUP.test(req.originalUrl)) return next()
  // Admins must be able to revoke the policy in case they would lock themselves out
  if (req.user.role === 'admin' && req.originalUrl.startsWith('/api/admin/settings')) return next()
  if (mustSetup2fa(req.user.id)) {
    return next(new HttpError(403, 'Please set up two-factor authentication first', 'two_factor_setup_required'))
  }
  next()
}

export function twoFactorRoutes(app) {
  // ---------- Sign-in: second step ----------
  app.post('/api/auth/2fa/webauthn-options', async (req, res) => {
    const t = readTicket(req, req.body?.ticket)
    assertNotLocked(t.userId)
    if (!passkeyCount(t.userId)) throw bad('No security key is registered for this account', 'webauthn_not_available')
    res.json(await authenticationOptions(req, t.userId, t.tid))
  })

  app.post('/api/auth/2fa/verify', async (req, res) => {
    const b = req.body || {}
    const t = readTicket(req, b.ticket)
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(t.userId)
    if (!user || user.disabled) throw bad('The sign-in has expired. Please sign in again.', 'ticket_invalid')
    assertNotLocked(user.id)
    ticketAttempt(t)
    const method = String(b.method ?? '')
    let ok = false
    let usedRecovery = false
    try {
      if (method === 'totp') ok = isTotpShape(b.code) && checkUserTotp(user.id, b.code)
      else if (method === 'recovery') ok = !!b.code && useRecoveryCode(user.id, b.code)
      else if (method === 'webauthn') ok = !!(await verifyAssertion(req, user.id, t.tid, b.assertion ?? b.response))
      else throw bad('Unknown method', 'two_factor_method')
      usedRecovery = method === 'recovery' && ok
    } catch (e) {
      if (e.code === 'two_factor_method') throw e
      ok = false
    }
    if (!ok) {
      noteCodeFail(user.id)
      audit(req, 'auth.2fa.verify_fail', { target: { type: 'user', id: user.id, label: user.email }, status: 'fail', details: { method } })
      throw new HttpError(401, 'The code is invalid', 'two_factor_invalid')
    }
    burnTicket(t)
    noteCodeOk(user.id)
    createSession(req, res, user.id)
    audit(req, 'auth.login', { target: { type: 'user', id: user.id, label: user.email }, details: { via: t.via, two_factor: method } })
    res.json({ ...meOf(user.id), ...(usedRecovery ? { recovery_left: recoveryLeft(user.id) } : {}) })
  })

  // Pick up the ticket from the cookie (after Google sign-in); the cookie is consumed in the process
  app.post('/api/auth/2fa/pending', (req, res) => {
    const raw = parseCookies(req.headers.cookie)[TFA_COOKIE]
    clearCookie(res, req, TFA_COOKIE, TFA_COOKIE_PATH)
    const t = readTicket(req, raw)
    res.json({ two_factor: { methods: twoFactorMethods(t.userId), ticket: raw } })
  })

  // ---------- Re-Auth ----------
  app.post('/api/account/reauth', requireAuth, async (req, res) => {
    // Without a password/code in the body the client only asks: "Am I still confirmed?" (10-minute window)
    if (!(await confirmIdentity(req)) && !isFresh(req)) throw bad('Please enter your password or a code', 'reauth_required')
    res.json({ ok: true })
  })

  app.post('/api/account/reauth/passkey-options', requireAuth, async (req, res) => {
    if (!passkeyCount(req.user.id)) throw bad('No security key is registered for this account', 'webauthn_not_available')
    assertNotLocked(req.user.id)
    res.json(await authenticationOptions(req, req.user.id, `reauth:${req.sessionId}`, { requireUV: true }))
  })

  // ---------- 2FA-Verwaltung ----------
  app.get('/api/account/2fa', requireAuth, (req, res) => res.json(statusPayload(req.user.id)))

  app.post('/api/account/2fa/totp/setup', requireAuth, async (req, res) => {
    const u = req.user
    if (hasTotp(u.id)) throw conflict('The authenticator app is already set up', 'totp_already_enabled')
    await requireConfirm(req)
    const secret = newTotpSecret()
    db.prepare(
      'INSERT INTO user_totp (user_id, secret_enc, confirmed, last_step) VALUES (?,?,0,0) ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc, confirmed=0, last_step=0',
    ).run(u.id, sealSecret(secret))
    const uri = otpauthUri(String(getSys('app_name') || 'Wishy'), u.email, secret)
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 })
    res.json({ secret, otpauth_uri: uri, qr_data_url: qr })
  })

  app.post('/api/account/2fa/totp/confirm', requireAuth, async (req, res) => {
    const u = req.user
    const row = db.prepare('SELECT * FROM user_totp WHERE user_id=? AND confirmed=0').get(u.id)
    if (!row) throw bad('Please restart the setup', 'totp_not_started')
    if (!isFresh(req)) throw forbidden('Please confirm it is you first', 'reauth_required')
    assertNotLocked(u.id)
    const step = matchTotp(base32Decode(openSecret(row.secret_enc)), req.body?.code, 0)
    if (step === null) {
      noteCodeFail(u.id)
      audit(req, 'auth.2fa.verify_fail', { target: { type: 'user', id: u.id }, status: 'fail', details: { context: 'totp_setup' } })
      throw bad('The code is invalid', 'code_invalid')
    }
    noteCodeOk(u.id)
    db.prepare('UPDATE user_totp SET confirmed=1, last_step=? WHERE user_id=?').run(step, u.id)
    const fresh = db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id=?').get(u.id).n === 0
    const recovery_codes = fresh ? generateRecoveryCodes(u.id) : undefined
    revokeOthers(req)
    audit(req, 'auth.2fa.totp.enable', { target: { type: 'user', id: u.id, label: u.email } })
    res.json({ ...statusPayload(u.id), ...(recovery_codes ? { recovery_codes } : {}) })
  })

  app.post('/api/account/2fa/totp/disable', requireAuth, async (req, res) => {
    const u = req.user
    if (!hasTotp(u.id)) throw bad('The authenticator app is not set up', 'totp_not_enabled')
    await requireConfirm(req)
    db.prepare('DELETE FROM user_totp WHERE user_id=?').run(u.id)
    pruneRecoveryIfNoMethod(u.id)
    revokeOthers(req)
    audit(req, 'auth.2fa.totp.disable', { target: { type: 'user', id: u.id, label: u.email } })
    res.json(statusPayload(u.id))
  })

  app.post('/api/account/2fa/webauthn/register-options', requireAuth, async (req, res) => {
    if (passkeyCount(req.user.id) >= MAX_PASSKEYS) throw bad('You have already reached the maximum number of security keys', 'passkey_limit')
    await requireConfirm(req)
    res.json(await registrationOptions(req, req.user, { secondFactorOnly: !!req.body?.second_factor_only }))
  })

  app.post('/api/account/2fa/webauthn/register', requireAuth, async (req, res) => {
    const u = req.user
    const b = req.body || {}
    if (passkeyCount(u.id) >= MAX_PASSKEYS) throw bad('You have already reached the maximum number of security keys', 'passkey_limit')
    await requireConfirm(req)
    const name = String(b.name ?? '').trim().slice(0, 60) || 'Security key'
    const c = await verifyRegistration(req, u, b.response ?? b.credential)
    if (db.prepare('SELECT 1 FROM user_webauthn WHERE id=?').get(c.id)) throw conflict('This security key is already registered', 'passkey_exists')
    db.prepare(
      'INSERT INTO user_webauthn (id, user_id, name, public_key, counter, transports, device_type, backed_up, passwordless) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(c.id, u.id, name, c.publicKey, c.counter, c.transports, c.device_type, c.backed_up, c.passwordless)
    const fresh = db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id=?').get(u.id).n === 0
    const recovery_codes = fresh ? generateRecoveryCodes(u.id) : undefined
    revokeOthers(req)
    audit(req, 'auth.2fa.passkey.add', { target: { type: 'user', id: u.id, label: u.email }, details: { name, passwordless: !!c.passwordless } })
    res.json({ ...statusPayload(u.id), ...(recovery_codes ? { recovery_codes } : {}) })
  })

  const renamePasskey = (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 60)
    if (!name) throw bad('Please enter a name', 'name_required')
    const r = db.prepare('UPDATE user_webauthn SET name=? WHERE id=? AND user_id=?').run(name, String(req.params.id), req.user.id)
    if (!Number(r.changes)) throw notFound('Security key not found', 'passkey_not_found')
    res.json(statusPayload(req.user.id))
  }
  app.put('/api/account/2fa/webauthn/:id', requireAuth, renamePasskey)
  app.patch('/api/account/2fa/webauthn/:id', requireAuth, renamePasskey)

  app.delete('/api/account/2fa/webauthn/:id', requireAuth, async (req, res) => {
    const u = req.user
    const id = String(req.params.id)
    if (!db.prepare('SELECT 1 FROM user_webauthn WHERE id=? AND user_id=?').get(id, u.id)) throw notFound('Security key not found', 'passkey_not_found')
    await requireConfirm(req)
    db.prepare('DELETE FROM user_webauthn WHERE id=? AND user_id=?').run(id, u.id)
    pruneRecoveryIfNoMethod(u.id)
    revokeOthers(req)
    audit(req, 'auth.2fa.passkey.remove', { target: { type: 'user', id: u.id, label: u.email } })
    res.json(statusPayload(u.id))
  })

  app.post('/api/account/2fa/recovery/regenerate', requireAuth, async (req, res) => {
    const u = req.user
    if (!has2fa(u.id)) throw bad('Two-factor is not enabled', 'two_factor_not_enabled')
    await requireConfirm(req)
    const recovery_codes = generateRecoveryCodes(u.id)
    revokeOthers(req)
    audit(req, 'auth.2fa.recovery.regenerate', { target: { type: 'user', id: u.id, label: u.email } })
    res.json({ ...statusPayload(u.id), recovery_codes })
  })
}
