// Two-factor core: TOTP (RFC 6238), recovery codes, tickets, status queries. Routen: twofactor-routes.js
import { createHmac, randomBytes } from 'node:crypto'
import { db, tx } from './db.js'
import { seal, unseal, sign } from './secret.js'
import { twoFactorPolicy } from './config.js'
import { makeLimiter } from './password.js'
import { bad, tooMany, ipClass, safeEqual } from './util.js'

// ---------- TOTP ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32Encode(buf) {
  let bits = 0
  let val = 0
  let out = ''
  for (const b of buf) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31]
  return out
}
export function base32Decode(str) {
  let bits = 0
  let val = 0
  const out = []
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = (val << 5) | B32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

const STEP = 30
/** HOTP (RFC 4226) with SHA-1; digits places. */
export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(msg).digest()
  const o = h[h.length - 1] & 0xf
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}
export const totpStep = (timeMs = Date.now()) => Math.floor(timeMs / 1000 / STEP)
export const totpCode = (key, timeMs = Date.now(), digits = 6) => hotp(key, totpStep(timeMs), digits)

/** Returns the matching time step (±1) or null. Steps <= lastStep count as already used (replay protection). */
export function matchTotp(key, code, lastStep = 0, timeMs = Date.now()) {
  const c = String(code ?? '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(c)) return null
  const now = totpStep(timeMs)
  let hit = null
  for (const d of [-1, 0, 1]) {
    const step = now + d
    if (safeEqual(hotp(key, step), c) && step > lastStep && (hit === null || step > hit)) hit = step
  }
  return hit
}

export const newTotpSecret = () => base32Encode(randomBytes(20))
export const sealSecret = (b32) => seal('totp', b32)
export const openSecret = (enc) => unseal('totp', enc)

export function otpauthUri(issuer, account, secret) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`
}

/** Verifies a TOTP code of the user (confirmed secret) and records the step atomically. */
export function checkUserTotp(userId, code) {
  const row = db.prepare('SELECT * FROM user_totp WHERE user_id=? AND confirmed=1').get(userId)
  if (!row) return false
  const step = matchTotp(Buffer.from(base32Decode(openSecret(row.secret_enc))), code, Number(row.last_step))
  if (step === null) return false
  const r = db.prepare('UPDATE user_totp SET last_step=? WHERE user_id=? AND last_step<?').run(step, userId, step)
  return Number(r.changes) === 1
}

// ---------- Recovery codes ----------
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const hashCode = (c) => sign('recovery', String(c).toLowerCase().replace(/[^a-z0-9]/g, ''))

export function generateRecoveryCodes(userId) {
  const codes = []
  for (let i = 0; i < 10; i++) {
    const bytes = randomBytes(10)
    let s = ''
    for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length]
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`)
  }
  tx(() => {
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id=?').run(userId)
  const ins = db.prepare('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?,?)')
  for (const c of codes) ins.run(userId, hashCode(c))
  })
  return codes
}
export const recoveryLeft = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id=? AND used_at IS NULL').get(userId).n

export function useRecoveryCode(userId, code) {
  const r = db
    .prepare("UPDATE user_recovery_codes SET used_at=datetime('now') WHERE user_id=? AND code_hash=? AND used_at IS NULL")
    .run(userId, hashCode(code))
  return Number(r.changes) === 1
}

// ---------- Status ----------
export const hasTotp = (userId) => !!db.prepare('SELECT 1 FROM user_totp WHERE user_id=? AND confirmed=1').get(userId)
export const passkeyCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM user_webauthn WHERE user_id=?').get(userId).n
export const has2fa = (userId) => hasTotp(userId) || passkeyCount(userId) > 0

export function twoFactorStatus(userId) {
  const totp = hasTotp(userId)
  const passkeys = passkeyCount(userId)
  const enabled = totp || passkeys > 0
  return { enabled, totp, passkeys, recovery_left: enabled ? recoveryLeft(userId) : 0 }
}

export const mustSetup2fa = (userId) => twoFactorPolicy() === 'required' && !has2fa(userId)

export function resetTwoFactor(userId) {
  db.prepare('DELETE FROM user_totp WHERE user_id=?').run(userId)
  db.prepare('DELETE FROM user_webauthn WHERE user_id=?').run(userId)
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id=?').run(userId)
}

/** If no method is left after a change, the recovery codes are discarded. */
export function pruneRecoveryIfNoMethod(userId) {
  if (!has2fa(userId)) db.prepare('DELETE FROM user_recovery_codes WHERE user_id=?').run(userId)
}

// ---------- Failed attempts ----------
const userFails = makeLimiter(10) // per user, 15 minutes
const ticketFails = new Map() // Ticket-ID -> Versuche
const MAX_TICKET_TRIES = 5
setInterval(() => {
  userFails.sweep()
  const now = Date.now()
  for (const [k, v] of ticketFails) if (v.exp < now) ticketFails.delete(k)
  for (const [k, exp] of usedTickets) if (exp < now) usedTickets.delete(k)
}, 600_000).unref()

export const assertNotLocked = (userId) => {
  if (userFails.limited(`u${userId}`)) throw tooMany('Too many wrong codes. Please wait a few minutes.', 'two_factor_locked')
}
export const noteCodeFail = (userId) => userFails.fail(`u${userId}`)
export const noteCodeOk = (userId) => userFails.clear(`u${userId}`)

// ---------- Tickets (between password/Google login and 2nd factor) ----------
const TICKET_TTL = 5 * 60_000
const usedTickets = new Map()
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function makeTicket(req, userId, via = 'password') {
  const body = b64({ u: userId, t: randomBytes(9).toString('base64url'), ip: ipClass(req.ip), via, exp: Date.now() + TICKET_TTL })
  return `${body}.${sign('2fa-ticket', body)}`
}

/** Checks signature, expiry, network binding and single use. Returns { userId, tid, via } or throws. */
export function readTicket(req, ticket) {
  const invalid = () => bad('The sign-in has expired. Please sign in again.', 'ticket_invalid')
  const [body, mac] = String(ticket || '').split('.')
  if (!body || !mac || !safeEqual(mac, sign('2fa-ticket', body))) throw invalid()
  let p
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString())
  } catch {
    throw invalid()
  }
  if (!p || p.exp < Date.now() || p.ip !== ipClass(req.ip) || usedTickets.has(p.t)) throw invalid()
  return { userId: p.u, tid: p.t, via: p.via, exp: p.exp }
}
/** Counts an attempt against the ticket; after 5 failed attempts it is used up. */
export function ticketAttempt(t) {
  const e = ticketFails.get(t.tid) || { n: 0, exp: t.exp }
  if (e.n >= MAX_TICKET_TRIES) throw tooMany('Too many attempts. Please sign in again.', 'ticket_locked')
  e.n++
  ticketFails.set(t.tid, e)
}
export const burnTicket = (t) => usedTickets.set(t.tid, t.exp)
