import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { bad, tooMany } from './util.js'

const scryptAsync = promisify(scrypt)
const N = 16384
const R = 8
const P = 1

export async function hashPassword(pw) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(pw, salt, 64, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, hash] = parts
  const expected = Buffer.from(hash, 'base64')
  try {
    const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) })
    return got.length === expected.length && timingSafeEqual(got, expected)
  } catch {
    return false
  }
}
// For a constant response time with unknown email addresses
export const DUMMY_HASH = await hashPassword('dummy-password-for-timing')

// ---------- Failed-attempt counter (per key, 15-minute window) ----------
export function makeLimiter(max, windowMs = 15 * 60_000) {
  const m = new Map()
  return {
    limited(key) {
      const e = m.get(key)
      if (!e) return false
      if (Date.now() > e.reset) {
        m.delete(key)
        return false
      }
      return e.n >= max
    },
    fail(key) {
      const e = m.get(key)
      if (!e || Date.now() > e.reset) m.set(key, { n: 1, reset: Date.now() + windowMs })
      else e.n++
    },
    clear(key) {
      m.delete(key)
    },
    sweep() {
      const now = Date.now()
      for (const [k, v] of m) if (now > v.reset) m.delete(k)
    },
  }
}

const pwFails = makeLimiter(10)
setInterval(() => pwFails.sweep(), 3_600_000).unref()

/** Verifies the current password of a signed-in user (with a counter against guessing). Throws on failure. */
export async function assertCurrentPassword(user, password) {
  if (!user.password_hash) throw bad('Set a password first', 'password_required')
  const key = `u${user.id}`
  if (pwFails.limited(key)) throw tooMany()
  if (!(await verifyPassword(String(password ?? ''), user.password_hash))) {
    pwFails.fail(key)
    throw bad('The current password is incorrect', 'password_invalid')
  }
  pwFails.clear(key)
}
