// WebAuthn (passkeys / security keys) as a second factor - API of @simplewebauthn/server v14.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { randomBytes } from 'node:crypto'
import { db } from './db.js'
import { baseUrl, getSys } from './config.js'
import { bad } from './util.js'

/** rpID and origin come from the base URL (works behind a reverse proxy). */
export function rpInfo(req) {
  const u = new URL(baseUrl(req))
  return { rpID: u.hostname, origin: u.origin, rpName: String(getSys('app_name') || 'Wishy') }
}

// Short-lived challenges (single process): key -> { challenge, exp }
const challenges = new Map()
const TTL = 5 * 60_000
export function putChallenge(key, challenge) {
  const now = Date.now()
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k)
  challenges.set(key, { challenge, exp: now + TTL })
}
export function takeChallenge(key) {
  const c = challenges.get(key)
  challenges.delete(key)
  return c && c.exp > Date.now() ? c.challenge : null
}

const credRows = (userId) => db.prepare('SELECT * FROM user_webauthn WHERE user_id=?').all(userId)
const parseTransports = (s) => {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export async function registrationOptions(req, user) {
  const { rpID, rpName } = rpInfo(req)
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(`wishy-user-${user.id}`),
    attestationType: 'none',
    excludeCredentials: credRows(user.id).map((c) => ({ id: c.id, transports: parseTransports(c.transports) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  })
  putChallenge(`reg:${user.id}`, options.challenge)
  return options
}

/** Verifies the registration response and returns the fields to store (or throws). */
export async function verifyRegistration(req, user, response) {
  const expectedChallenge = takeChallenge(`reg:${user.id}`)
  if (!expectedChallenge) throw bad('The request has expired. Please try again.', 'webauthn_challenge_expired')
  const { rpID, origin } = rpInfo(req)
  let v
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    })
  } catch (e) {
    throw bad('The security key could not be registered', 'webauthn_failed')
  }
  if (!v.verified || !v.registrationInfo) throw bad('The security key could not be registered', 'webauthn_failed')
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports || response?.response?.transports || []),
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp ? 1 : 0,
  }
}

/** Options for sign-in; key identifies the challenge (e.g. the ticket id). */
export async function authenticationOptions(req, userId, key) {
  const { rpID } = rpInfo(req)
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: credRows(userId).map((c) => ({ id: c.id, transports: parseTransports(c.transports) })),
  })
  putChallenge(`auth:${key}`, options.challenge)
  return options
}

/** Verifies an assertion; returns the credential id or throws. */
export async function verifyAssertion(req, userId, key, response) {
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
      requireUserVerification: false,
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

export const newTicketId = () => randomBytes(9).toString('base64url')
