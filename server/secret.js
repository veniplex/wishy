// Server secret for encrypting data at rest (TOTP secrets, backup passphrase, tickets).
// Lives at DATA_DIR/secret.key (32 random bytes), generated on first start.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
const KEY_FILE = path.join(DATA_DIR, 'secret.key')

/** Encrypted data in the database that would be unusable without the existing key (TOTP secrets, recovery codes, sealed settings). */
function encryptedMaterial() {
  const found = []
  const file = path.join(DATA_DIR, 'wishlist.db')
  if (!fs.existsSync(file)) return found
  let ro
  try {
    ro = new DatabaseSync(file, { readOnly: true }) // own connection: independent of the module load order
  } catch {
    return found
  }
  const count = (sql) => {
    try {
      return Number(ro.prepare(sql).get().n)
    } catch {
      return 0 // table does not exist (yet)
    }
  }
  if (count('SELECT COUNT(*) AS n FROM user_totp')) found.push('Authenticator-Secrets (user_totp)')
  if (count('SELECT COUNT(*) AS n FROM user_recovery_codes')) found.push('recovery codes')
  if (count("SELECT COUNT(*) AS n FROM system_settings WHERE value LIKE '\"enc1:%'")) found.push('encrypted settings (system_settings)')
  try {
    ro.close()
  } catch {
    /* ignore */
  }
  return found
}

let cached
export function serverKey() {
  if (cached) return cached
  fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(KEY_FILE)) {
    // A new key makes existing encrypted data unreadable. Never do that silently.
    const found = encryptedMaterial()
    if (found.length && process.env.WISHY_ALLOW_NEW_SECRET_KEY !== '1') {
      throw new Error(
        `secret.key is missing in ${DATA_DIR}, but the database contains encrypted data: ${found.join(', ')}. ` +
          'Restore secret.key from the backup. Only if the data may be lost (2FA setups become invalid), ' +
          'start once with WISHY_ALLOW_NEW_SECRET_KEY=1. ' +
          `secret.key is missing from ${DATA_DIR} but the database holds encrypted data (${found.length} kinds). Restore secret.key from your backup; ` +
          'only start once with WISHY_ALLOW_NEW_SECRET_KEY=1 if that data may be lost (2FA setups become invalid).',
      )
    }
    fs.writeFileSync(KEY_FILE, randomBytes(32), { mode: 0o600 })
  }
  cached = fs.readFileSync(KEY_FILE)
  if (cached.length !== 32) throw new Error('secret.key is corrupted (expected 32 bytes)')
  return cached
}

/** Derived key per purpose, so the same key is never used for two things. */
export const subKey = (purpose) => Buffer.from(hkdfSync('sha256', serverKey(), Buffer.alloc(0), `wishy:${purpose}`, 32))

/** AES-256-GCM, Ausgabe base64url(iv | tag | ciphertext). */
export function seal(purpose, plaintext) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', subKey(purpose), iv)
  const body = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')
}

/** Counterpart to seal(); throws on tampering or wrong purpose. */
export function unseal(purpose, sealed) {
  const buf = Buffer.from(String(sealed), 'base64url')
  const d = createDecipheriv('aes-256-gcm', subKey(purpose), buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
}

/** HMAC signature (base64url) for short-lived tickets. */
export const sign = (purpose, data) => createHmac('sha256', subKey(purpose)).update(String(data)).digest('base64url')
