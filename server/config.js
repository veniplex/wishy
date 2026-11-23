import { randomBytes } from 'node:crypto'
import { db } from './db.js'
import { seal, unseal } from './secret.js'

// Environment variables take precedence over the settings stored in the database
const ENV = {
  google_client_id: 'GOOGLE_CLIENT_ID',
  google_client_secret: 'GOOGLE_CLIENT_SECRET',
  base_url: 'BASE_URL',
  trust_proxy: 'TRUST_PROXY',
}
const DEFAULTS = {
  app_name: 'Wishy',
  default_locale: 'en',
  two_factor_policy: 'optional',
  trust_proxy: '',
}

export const LOCALES = ['de', 'en']

export const envLocked = () => {
  const keys = Object.keys(ENV).filter((k) => process.env[ENV[k]])
  return keys
}

export function getSys(key) {
  if (ENV[key] && process.env[ENV[key]]) return process.env[ENV[key]]
  const r = db.prepare('SELECT value FROM system_settings WHERE key=?').get(key)
  if (r) {
    try {
      const v = JSON.parse(r.value)
      if (v !== null && v !== '') return v
    } catch {
      /* ignore */
    }
  }
  return DEFAULTS[key] ?? null
}

/** Value from the database only (without environment variable and without default). */
export function getStored(key) {
  const r = db.prepare('SELECT value FROM system_settings WHERE key=?').get(key)
  if (!r) return null
  try {
    const v = JSON.parse(r.value)
    return v === '' ? null : v
  } catch {
    return null
  }
}

export function setSys(key, value) {
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM system_settings WHERE key=?').run(key)
  } else {
    db.prepare('INSERT INTO system_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
      key, JSON.stringify(value),
    )
  }
}

// ---------- Secret settings (encrypted at rest) ----------
// Values such as the Google client secret are stored as "enc1:<seal(...)>" in system_settings (AES-256-GCM with the key from secret.key,
// purpose per setting). Environment variables still take precedence and stay unchanged.
const SEALED = 'enc1:'
const sealedPurpose = (key) => `setting:${key}`

/**
 * Reads a secret setting: environment variable (if provided for the key) before database; decrypts transparently.
 * Returns null if nothing is set; also null for values that cannot be decrypted (wrong key).
 */
export function getSecretSys(key) {
  if (ENV[key] && process.env[ENV[key]]) return process.env[ENV[key]]
  const v = getStored(key)
  if (typeof v !== 'string' || !v) return null
  if (v.startsWith(SEALED)) {
    try {
      return unseal(sealedPurpose(key), v.slice(SEALED.length))
    } catch {
      console.error(`Secret setting "${key}" cannot be decrypted (does secret.key not match the database?)`)
      return null
    }
  }
  return null
}

/** Stores a secret setting encrypted; null/empty deletes it. */
export function setSecretSys(key, value) {
  if (value === null || value === undefined || value === '') setSys(key, null)
  else setSys(key, SEALED + seal(sealedPurpose(key), String(value)))
}

// ---------- Registration ----------
/** { enabled, mode }: registration on/off and 'open' | 'invite' (default: enabled, invite-only). */
export function registrationSettings() {
  const en = getStored('registration_enabled')
  const mode = getStored('registration_mode')
  return {
    enabled: typeof en === 'boolean' ? en : true,
    mode: mode === 'open' || mode === 'invite' ? mode : 'invite',
  }
}

// ---------- Google ----------
export const googleCredentialsSet = () => !!(getSys('google_client_id') && getSecretSys('google_client_secret'))
/** Switch google_enabled; without an explicit setting: on as soon as client ID and secret are present. */
export function googleEnabled() {
  if (!googleCredentialsSet()) return false
  return getStored('google_enabled') !== false
}

// ---------- Language ----------
export const defaultLocale = () => {
  const v = getSys('default_locale')
  return LOCALES.includes(v) ? v : 'en'
}

export const twoFactorPolicy = () => (getSys('two_factor_policy') === 'required' ? 'required' : 'optional')

// ---------- Base URL ----------
/** Configured base URL; otherwise from the request (forwarding headers only count with a trusted proxy). */
export function baseUrl(req) {
  const configured = getSys('base_url')
  const raw = configured || `${req.protocol}://${req.host || req.get('host')}`
  return String(raw).replace(/\/+$/, '')
}

let secret
export function sessionSecret() {
  if (secret) return secret
  let s = getSecretSys('session_secret')
  if (!s) {
    s = randomBytes(32).toString('base64url')
    setSecretSys('session_secret', s)
  }
  secret = s
  return s
}
