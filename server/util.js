import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

export class HttpError extends Error {
  /** params: optional values for the translated error text in the client (`errors.code.<code>` with {name} placeholders) */
  constructor(status, message, code, params) {
    super(message)
    this.status = status
    this.code = code
    if (params) this.params = params
  }
}
export const bad = (m, code = 'bad_request', params) => new HttpError(400, m, code, params)
export const notFound = (m = 'Not found', code = 'not_found', params) => new HttpError(404, m, code, params)
export const forbidden = (m = 'No permission', code = 'forbidden', params) => new HttpError(403, m, code, params)
export const conflict = (m, code = 'conflict', params) => new HttpError(409, m, code, params)
export const unauthorized = (m = 'Please sign in', code = 'auth') => new HttpError(401, m, code)
export const tooMany = (m = 'Too many attempts. Please wait a few minutes.', code = 'too_many_attempts') => new HttpError(429, m, code)

export const newToken = () => randomBytes(32).toString('base64url')
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')

export const numId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : NaN
}
export const reqId = (v, msg = 'Not found', code = 'not_found') => {
  const n = numId(v)
  if (Number.isNaN(n)) throw notFound(msg, code)
  return n
}

export function requireFields(body, ...fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') throw bad(`Field "${f}" is missing`, 'field_missing', { field: f })
  }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function cleanEmail(v) {
  const e = String(v ?? '').trim()
  if (!EMAIL_RE.test(e) || e.length > 254) throw bad('Please enter a valid email address', 'email_invalid')
  return e
}
export function cleanName(v) {
  const n = String(v ?? '').trim()
  if (!n) throw bad('Please enter a name', 'name_required')
  return n.slice(0, 80)
}
export function cleanPassword(v) {
  const p = String(v ?? '')
  if (p.length < 8) throw bad('The password must be at least 8 characters long', 'password_too_short')
  if (p.length > 200) throw bad('The password is too long', 'password_too_long')
  return p
}

export function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      /* ignore */
    }
  }
  return out
}

/** Set by session.js: true if the base URL is https (even if the proxy is not trusted and req.secure therefore stays false). */
let secureHook = null
export const setSecureHook = (fn) => {
  secureHook = fn
}
export const isSecure = (req) => !!req.secure || !!secureHook?.(req)

export function setCookie(res, req, name, value, { maxAge, path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=${path}`
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`
  if (isSecure(req)) c += '; Secure'
  res.append('Set-Cookie', c)
}
export const clearCookie = (res, req, name, path = '/') => setCookie(res, req, name, '', { maxAge: 0, path })

/** Key for rate limits: IPv4 in full, IPv6 as /64 (an attacker with their own /64 would otherwise have unlimited addresses). */
export function ipKey(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '')
  if (s.includes(':')) return s.split(':').slice(0, 4).join(':')
  return s
}

/** Counts every hit (not only failures) per key within the time window; hit(key) returns true once the limit is exceeded. */
export function makeHitCounter(max, windowMs = 60_000) {
  const m = new Map()
  return {
    hit(key) {
      const now = Date.now()
      const e = m.get(key)
      if (!e || now > e.reset) {
        m.set(key, { n: 1, reset: now + windowMs })
        if (m.size > 20_000) for (const [k, v] of m) if (now > v.reset) m.delete(k)
        return false
      }
      e.n++
      return e.n > max
    },
    retryAfter(key) {
      const e = m.get(key)
      return e ? Math.max(1, Math.ceil((e.reset - Date.now()) / 1000)) : 1
    },
  }
}

/** Groups an IP coarsely (IPv4 /24, IPv6 /64) – for tickets bound to the user's network. */
export function ipClass(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '')
  if (s.includes('.')) return s.split('.').slice(0, 3).join('.')
  return s.split(':').slice(0, 4).join(':')
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
