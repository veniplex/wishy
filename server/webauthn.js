// WebAuthn (passkeys / security keys): passwordless sign-in (discoverable credentials) and second factor - API of @simplewebauthn/server v14.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { randomBytes } from 'node:crypto'
import { db } from './db.js'
import { baseUrl, getSys } from './config.js'
import { bad, setCookie, clearCookie, parseCookies } from './util.js'

/** rpID and origin come from the base URL (works behind a reverse proxy). */
export function rpInfo(req) {
  const u = new URL(baseUrl(req))
  return { rpID: u.hostname, origin: u.origin, rpName: String(getSys('app_name') || 'Wishy') }
}

// Short-lived challenges (single process): key -> { challenge, exp, meta }. Capped so that anonymous option requests cannot fill memory.
const challenges = new Map()
const TTL = 5 * 60_000
const MAX_CHALLENGES = 5000
export function putChallenge(key, challenge, meta) {
  const now = Date.now()
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k)
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value) // oldest first (insertion order)
  challenges.set(key, { challenge, exp: now + TTL, meta })
}
/** Single use: returns the entry { challenge, meta } (or null) and deletes it. */
export function takeChallengeEntry(key) {
  const c = challenges.get(key)
  challenges.delete(key)
  return c && c.exp > Date.now() ? c : null
}
export const takeChallenge = (key) => takeChallengeEntry(key)?.challenge ?? null

const credRows = (userId) => db.prepare('SELECT * FROM user_webauthn WHERE user_id=?').all(userId)
const parseTransports = (s) => {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/**
 * Registration options. Default: a passkey = discoverable credential with user verification (usable for sign-in without a password).
 * `secondFactorOnly`: for older roaming security keys without resident-key support; such a key only counts as a second factor.
 */
export async function registrationOptions(req, user, { secondFactorOnly = false } = {}) {
  const { rpID, rpName } = rpInfo(req)
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(`wishy-user-${user.id}`),
    attestationType: 'none',
    excludeCredentials: credRows(user.id).map((c) => ({ id: c.id, transports: parseTransports(c.transports) })),
    authenticatorSelection: secondFactorOnly
      ? { residentKey: 'discouraged', userVerification: 'discouraged' }
      : { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    extensions: { credProps: true },
  })
  putChallenge(`reg:${user.id}`, options.challenge, { secondFactorOnly })
  return options
}

/** Verifies the registration response and returns the fields to store (or throws). */
export async function verifyRegistration(req, user, response) {
  const entry = takeChallengeEntry(`reg:${user.id}`)
  if (!entry) throw bad('The request has expired. Please try again.', 'webauthn_challenge_expired')
  const expectedChallenge = entry.challenge
  const secondFactorOnly = !!entry.meta?.secondFactorOnly
  const { rpID, origin } = rpInfo(req)
  let v
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: !secondFactorOnly,
    })
  } catch (e) {
    throw bad('The security key could not be registered', 'webauthn_failed')
  }
  if (!v.verified || !v.registrationInfo) throw bad('The security key could not be registered', 'webauthn_failed')
  // The browser reports whether a discoverable credential was really created (credProps); false = unusable for passwordless sign-in
  if (!secondFactorOnly && response?.clientExtensionResults?.credProps?.rk === false) throw bad('This security key cannot be used as a passkey', 'webauthn_not_discoverable')
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports || response?.response?.transports || []),
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp ? 1 : 0,
    passwordless: secondFactorOnly ? 0 : 1,
  }
}

/** Options for the second factor or a re-confirmation; key identifies the challenge (ticket id / session + purpose). */
export async function authenticationOptions(req, userId, key, { requireUV = false } = {}) {
  const { rpID } = rpInfo(req)
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: requireUV ? 'required' : 'preferred',
    allowCredentials: credRows(userId).map((c) => ({ id: c.id, transports: parseTransports(c.transports) })),
  })
  putChallenge(`auth:${key}`, options.challenge)
  return options
}

/** Verifies an assertion of an account (second factor / re-confirmation); returns the credential id or throws. */
export async function verifyAssertion(req, userId, key, response, { requireUV = false } = {}) {
  const expectedChallenge = takeChallenge(`auth:${key}`)
  if (!expectedChallenge) throw bad('The request has expired. Please try again.', 'webauthn_challenge_expired')
  const row = db.prepare('SELECT * FROM user_webauthn WHERE id=? AND user_id=?').get(String(response?.id ?? ''), userId)
  if (!row) throw bad('This security key does not belong to your account', 'webauthn_unknown_credential')
  const { rpID, origin } = rpInfo(req)
  let v
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: requireUV,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: parseTransports(row.transports) },
    })
  } catch {
    throw bad('Confirmation with the security key failed', 'webauthn_failed')
  }
  if (!v.verified) throw bad('Confirmation with the security key failed', 'webauthn_failed')
  db.prepare('UPDATE user_webauthn SET counter=?, last_used_at=? WHERE id=?').run(
    v.authenticationInfo.newCounter, new Date().toISOString(), row.id,
  )
  return row.id
}

// ---------- Passwordless sign-in (discoverable credentials) ----------
export const PASSKEY_COOKIE = 'wl_pk'
export const PASSKEY_COOKIE_PATH = '/api/auth/passkey'

/** Options without allowCredentials (no user input, no enumeration); the challenge id is bound to the browser by a SameSite=Strict cookie. */
export async function passkeyLoginOptions(req, res) {
  const { rpID } = rpInfo(req)
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' })
  const cid = randomBytes(18).toString('base64url')
  putChallenge(`login:${cid}`, options.challenge)
  setCookie(res, req, PASSKEY_COOKIE, cid, { maxAge: TTL / 1000, path: PASSKEY_COOKIE_PATH, sameSite: 'Strict' })
  return options
}

/**
 * Verifies a passwordless assertion and returns the user; every failure throws the same error (`passkey_login_failed`; the thrown
 * error carries `userId` only for the audit log, never for the client). Checks: single-use challenge bound to the cookie, credential
 * known, userHandle matches the credential owner, passkey not marked "second factor only", user not disabled, user verification,
 * origin/rpID, signature and counter (a regression = cloned authenticator, rejected by the library).
 */
export async function verifyPasskeyLogin(req, res, response) {
  const fail = (userId = null) => Object.assign(bad('Sign-in with the passkey failed', 'passkey_login_failed'), { userId })
  const cid = parseCookies(req.headers.cookie)[PASSKEY_COOKIE]
  clearCookie(res, req, PASSKEY_COOKIE, PASSKEY_COOKIE_PATH)
  const entry = cid ? takeChallengeEntry(`login:${cid}`) : null
  if (!entry) throw Object.assign(bad('The request has expired. Please try again.', 'passkey_expired'), { reason: 'expired' })
  const id = response?.id
  if (typeof id !== 'string' || id.length > 1400 || !response.response || typeof response.response !== 'object') throw fail()
  const row = db.prepare('SELECT * FROM user_webauthn WHERE id=?').get(id)
  const handle = typeof response.response.userHandle === 'string' ? response.response.userHandle : ''
  const handleOk = !!row && !!handle && Buffer.from(handle, 'base64url').toString('utf8') === `wishy-user-${row.user_id}`
  const user = handleOk ? db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id) : null
  if (!row || !user || user.disabled || row.passwordless === 0) throw fail(user?.id)
  const { rpID, origin } = rpInfo(req)
  let v
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: parseTransports(row.transports) },
    })
  } catch {
    throw fail(user.id)
  }
  if (!v.verified) throw fail(user.id)
  db.prepare('UPDATE user_webauthn SET counter=?, last_used_at=?, passwordless=COALESCE(passwordless, 1) WHERE id=?').run(
    v.authenticationInfo.newCounter, new Date().toISOString(), row.id,
  )
  return user
}

export const newTicketId = () => randomBytes(9).toString('base64url')
