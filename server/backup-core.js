// Core of the backups (.wbk / .wbk.enc) - deliberately WITHOUT importing db.js, so it
//  - can run before the database is opened (apply a pending restore at startup, preboot.js),
//  - can be used by the launcher via server/wishy-cli.js while the app is stopped.
//
// Format: gzip-compressed tar with wishlist.db (consistent snapshot via VACUUM INTO), images/, avatars/,
// secret.key (only in encrypted backups) and manifest.json as the LAST entry (contains the SHA-256
// and size of every entry). Encrypted: plaintext header (magic, scrypt parameters, salt, nonce prefix,
// key check value, non-critical metadata) + chunked AES-256-GCM (64 KiB per chunk, counter nonce,
// header hash + counter + end marker as AAD -> tampering, reordering and truncation are detected).
import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { tarStream, TarParser, TarError, targetPath } from '../launcher/lib/tar.js'
import { seal, unseal } from './secret.js'

const scrypt = promisify(scryptCb)

export const BACKUP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.wbk(\.enc)?$/
export const FORMAT = 'wishy-backup'
export const FORMAT_VERSION = 1
export const SAFETY_REASONS = ['pre-update', 'pre-restore']

export class BackupError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
    this.backupError = true
  }
}

export function paths(dataDir) {
  return {
    dataDir,
    backups: path.join(dataDir, 'backups'),
    db: path.join(dataDir, 'wishlist.db'),
    images: path.join(dataDir, 'images'),
    avatars: path.join(dataDir, 'avatars'),
    secret: path.join(dataDir, 'secret.key'),
    pending: path.join(dataDir, 'restore-pending'),
    marker: path.join(dataDir, 'restore-pending', 'ready.json'),
    result: path.join(dataDir, 'restore-result.json'),
    maint: path.join(dataDir, 'maintenance.json'),
  }
}

export const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
export function writeJsonAtomic(f, data) {
  const tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  fs.writeSync(fd, JSON.stringify(data, null, 2))
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  renameRetry(tmp, f)
  fsyncDir(path.dirname(f))
}
export function fsyncDir(d) {
  try {
    const fd = fs.openSync(d, 'r')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
  } catch {
    /* Windows: directories cannot be fsynced */
  }
}
export function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return Infinity
  }
}
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })

/** rename with retries (Windows: virus scanners/indexers briefly hold files). */
export function renameRetry(a, b) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(a, b)
    } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1))
    }
  }
}

/** Fingerprint of the schema definition (same as server/schema.js). */
export function fingerprintOf(handle) {
  const rows = handle.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------- Encryption

const MAGIC = Buffer.from('WISHYENC')
const CHUNK = 64 * 1024
const FINAL = 0x80000000
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 }
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const sha = (b) => createHash('sha256').update(b).digest()
const keyCheck = (key) => createHmac('sha256', key).update('wishy-backup-key-check').digest('hex').slice(0, 32)

async function deriveKey(passphrase, salt, { N, r, p }) {
  // Only our exact parameters: the header is not authenticated yet -> no memory bomb via N/r/p
  if (N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p) throw new BackupError('backup_invalid', 'Unsupported encryption parameters')
  return scrypt(String(passphrase).normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 })
}

export async function makeEncHeader(passphrase, meta) {
  const salt = randomBytes(16)
  const nonce = randomBytes(8)
  const key = await deriveKey(passphrase, salt, SCRYPT_PARAMS)
  const hdr = { v: 1, alg: 'AES-256-GCM', kdf: 'scrypt', ...SCRYPT_PARAMS, salt: salt.toString('base64'), nonce: nonce.toString('base64'), chunk: CHUNK, check: keyCheck(key), meta }
  const json = Buffer.from(JSON.stringify(hdr), 'utf8')
  return { key, nonce, headerBytes: Buffer.concat([MAGIC, u32(json.length), json]) }
}

class EncryptStream extends Transform {
  constructor({ key, nonce, headerBytes }) {
    super()
    Object.assign(this, { key, nonce, headerBytes, hh: sha(headerBytes), counter: 0, pending: Buffer.alloc(0), started: false })
  }
  start() {
    if (!this.started) {
      this.push(this.headerBytes)
      this.started = true
    }
  }
  seal(pt, final) {
    const iv = Buffer.concat([this.nonce, u32(this.counter)])
    const aad = Buffer.concat([this.hh, u32(this.counter), Buffer.from([final ? 1 : 0])])
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    c.setAAD(aad)
    const ct = Buffer.concat([c.update(pt), c.final()])
    this.push(u32(pt.length | (final ? FINAL : 0)))
    this.push(ct)
    this.push(c.getAuthTag())
    this.counter++
  }
  _transform(chunk, _enc, cb) {
    this.start()
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    while (this.pending.length > CHUNK) {
      this.seal(this.pending.subarray(0, CHUNK), false)
      this.pending = this.pending.subarray(CHUNK)
    }
    cb()
  }
  _flush(cb) {
    this.start()
    this.seal(this.pending, true)
    cb()
  }
}

class DecryptStream extends Transform {
  constructor({ key, nonce, headerBytes }) {
    super()
    Object.assign(this, { key, nonce, hh: sha(headerBytes), counter: 0, buf: Buffer.alloc(0), done: false })
  }
  _transform(chunk, _enc, cb) {
    if (this.done) return cb(new BackupError('backup_corrupt', 'Data after the end of the encrypted backup'))
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    try {
      while (this.buf.length >= 4) {
        const raw = this.buf.readUInt32BE(0)
        const final = (raw & FINAL) !== 0
        const len = raw & ~FINAL
        if (len > CHUNK) throw new BackupError('backup_corrupt', 'Corrupted encrypted backup')
        if (this.buf.length < 4 + len + 16) break
        const ct = this.buf.subarray(4, 4 + len)
        const tag = this.buf.subarray(4 + len, 4 + len + 16)
        const iv = Buffer.concat([this.nonce, u32(this.counter)])
        const d = createDecipheriv('aes-256-gcm', this.key, iv)
        d.setAAD(Buffer.concat([this.hh, u32(this.counter), Buffer.from([final ? 1 : 0])]))
        d.setAuthTag(tag)
        let pt
        try {
          pt = Buffer.concat([d.update(ct), d.final()])
        } catch {
          throw new BackupError('backup_corrupt', 'The backup is corrupted or has been modified')
        }
        this.counter++
        this.buf = this.buf.subarray(4 + len + 16)
        if (pt.length) this.push(pt)
        if (final) {
          this.done = true
          if (this.buf.length) throw new BackupError('backup_corrupt', 'Data after the end of the encrypted backup')
          break
        }
      }
      cb()
    } catch (e) {
      cb(e)
    }
  }
  _flush(cb) {
    if (!this.done) return cb(new BackupError('backup_corrupt', 'The encrypted backup is incomplete'))
    cb()
  }
}

export function isEncryptedFile(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(8)
    const n = fs.readSync(fd, b, 0, 8, 0)
    return n === 8 && b.equals(MAGIC)
  } finally {
    fs.closeSync(fd)
  }
}

/** Reads the plaintext header of an encrypted backup. */
export function readEncHeader(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const pre = Buffer.alloc(12)
    if (fs.readSync(fd, pre, 0, 12, 0) !== 12 || !pre.subarray(0, 8).equals(MAGIC)) throw new BackupError('backup_invalid', 'Not an encrypted Wishy backup')
    const len = pre.readUInt32BE(8)
    if (len < 2 || len > 64 * 1024) throw new BackupError('backup_corrupt', 'Corrupted header')
    const json = Buffer.alloc(len)
    if (fs.readSync(fd, json, 0, len, 12) !== len) throw new BackupError('backup_corrupt', 'Corrupted header')
    let hdr
    try {
      hdr = JSON.parse(json.toString('utf8'))
    } catch {
      throw new BackupError('backup_corrupt', 'Corrupted header')
    }
    if (hdr.v !== 1 || hdr.alg !== 'AES-256-GCM' || hdr.kdf !== 'scrypt') throw new BackupError('backup_invalid', 'Unknown encryption format')
    return { hdr, headerBytes: Buffer.concat([pre, json]), offset: 12 + len }
  } finally {
    fs.closeSync(fd)
  }
}

/** Returns the stages up to the gzip stream (decrypted if necessary). passphrases: list of candidates. */
async function openArchive(file, passphrases) {
  if (!isEncryptedFile(file)) return { stages: [fs.createReadStream(file)], encrypted: false, meta: null }
  const { hdr, headerBytes, offset } = readEncHeader(file)
  const cands = (passphrases || []).filter((p) => typeof p === 'string' && p.length)
  if (!cands.length) throw new BackupError('passphrase_required', 'This backup is encrypted - please provide the passphrase', 422)
  const salt = Buffer.from(hdr.salt, 'base64')
  for (const p of cands) {
    const key = await deriveKey(p, salt, hdr)
    const a = Buffer.from(keyCheck(key))
    const b = Buffer.from(String(hdr.check))
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { stages: [fs.createReadStream(file, { start: offset }), new DecryptStream({ key, nonce: Buffer.from(hdr.nonce, 'base64'), headerBytes })], encrypted: true, meta: hdr.meta || null }
    }
  }
  throw new BackupError('passphrase_wrong', 'The passphrase is wrong', 422)
}

// ---------------------------------------------------------------- Read / verify

const MEMBER_RE = /^(wishlist\.db|secret\.key|(images|avatars)\/[^/]+)$/

/**
 * Reads a backup completely, verifies all hashes against the manifest and optionally extracts to extractTo.
 * Throws BackupError (backup_corrupt | backup_invalid | passphrase_required | passphrase_wrong).
 */
export async function readBackup(file, { passphrases = [], extractTo = null, only = null } = {}) {
  const { stages, encrypted, meta } = await openArchive(file, passphrases)
  const hashes = new Map()
  let manifestBuf = null
  let openFd = null
  if (extractTo) {
    fs.mkdirSync(extractTo, { recursive: true })
    if (fs.readdirSync(extractTo).length) throw new BackupError('backup_invalid', 'Target directory not empty', 500)
  }
  // Never write more than there is room for while extracting (gzip bomb in an uploaded file)
  const room = extractTo ? Math.max(0, freeBytes(extractTo) - 100 * 1024 * 1024) : Infinity
  const want = (name) => extractTo && (!only || only.has(name))
  const parser = new TarParser({
    maxEntries: 500_000,
    maxTotal: Math.min(64 * 1024 ** 3, room),
    maxEntrySize: 32 * 1024 ** 3,
    onEntry(e) {
      if (manifestBuf !== null) throw new BackupError('backup_corrupt', 'Entries after the manifest')
      if (e.type === 'dir') {
        if (!['images', 'avatars'].includes(e.name)) throw new BackupError('backup_invalid', `Unexpected entry: ${e.name}`)
        if (want(e.name)) fs.mkdirSync(targetPath(extractTo, e.name), { recursive: true })
        return null
      }
      if (e.name === 'manifest.json') {
        if (e.size > 16 * 1024 * 1024) throw new BackupError('backup_corrupt', 'Manifest too large')
        const parts = []
        return { write: (b) => parts.push(Buffer.from(b)), end: () => (manifestBuf = Buffer.concat(parts)) }
      }
      if (!MEMBER_RE.test(e.name)) throw new BackupError('backup_invalid', `Unexpected entry: ${e.name}`)
      if (e.name === 'secret.key' && !encrypted) throw new BackupError('backup_invalid', 'secret.key is only allowed in encrypted backups')
      const h = createHash('sha256')
      let fd = null
      if (want(e.name)) {
        const p = targetPath(extractTo, e.name)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fd = openFd = fs.openSync(p, 'wx', 0o600)
      }
      return {
        write(b) {
          h.update(b)
          if (fd !== null) fs.writeSync(fd, b)
        },
        end() {
          if (fd !== null) fs.closeSync(fd)
          openFd = null
          hashes.set(e.name, { sha256: h.digest('hex'), size: e.size })
        },
      }
    },
  })
  try {
    await pipeline(...stages, createGunzip(), async (src) => {
      for await (const c of src) parser.push(c)
    })
    parser.finish()
  } catch (e) {
    if (openFd !== null) fs.closeSync(openFd)
    if (e.backupError) throw e
    if (e instanceof TarError && e.code === 'tar_unsafe_path') throw new BackupError('backup_invalid', e.message)
    if (e instanceof TarError && e.code === 'tar_too_large' && extractTo) throw new BackupError('insufficient_disk', 'Not enough disk space to unpack the backup', 507)
    throw new BackupError('backup_corrupt', `The backup is corrupted (${e.code || e.message})`)
  }
  if (!manifestBuf) throw new BackupError('backup_corrupt', 'Manifest missing - backup incomplete')
  let manifest
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'))
  } catch {
    throw new BackupError('backup_corrupt', 'Manifest is corrupted')
  }
  if (manifest?.format !== FORMAT) throw new BackupError('backup_invalid', 'Not a Wishy backup')
  if (!(manifest.format_version <= FORMAT_VERSION)) throw new BackupError('backup_format_newer', 'The backup comes from a newer Wishy version', 409)
  const files = manifest.files || {}
  if (!files['wishlist.db']) throw new BackupError('backup_corrupt', 'Database missing in the backup')
  for (const [name, f] of Object.entries(files)) {
    const got = hashes.get(name)
    if (!got || got.sha256 !== f.sha256 || got.size !== f.size) throw new BackupError('backup_corrupt', `Checksum mismatch: ${name}`)
  }
  for (const name of hashes.keys()) if (!files[name]) throw new BackupError('backup_corrupt', `Not in the manifest: ${name}`)
  if (!!manifest.encrypted !== encrypted) throw new BackupError('backup_corrupt', 'Encryption flag does not match')
  return { manifest, encrypted, meta }
}

// ---------------------------------------------------------------- Create

const countTables = ['users', 'spaces', 'persons', 'wishlists', 'wishes', 'items', 'gifts']

function* walkFiles(dir, prefix) {
  let list
  try {
    list = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of list) {
    if (e.isFile() && !e.name.startsWith('.') && !/[/\\:]/.test(e.name)) yield { file: path.join(dir, e.name), name: `${prefix}/${e.name}` }
  }
}

const stampOf = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
export const cleanLabel = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/**
 * Creates a backup. db: open DatabaseSync connection of the app (otherwise the file is opened).
 * passphrase: null/'' -> unencrypted.
 */
export async function createBackup({ dataDir, db = null, reason = 'manual', label = '', appVersion = '0.0.0', passphrase = null, verify = true }) {
  const P = paths(dataDir)
  fs.mkdirSync(P.backups, { recursive: true })
  const enc = !!passphrase
  const created = new Date()
  const lbl = cleanLabel(label)
  const base = `wishy-backup-${stampOf(created)}-${appVersion}${lbl ? '-' + lbl : ''}`
  let name = `${base}.wbk${enc ? '.enc' : ''}`
  for (let i = 2; fs.existsSync(path.join(P.backups, name)); i++) name = `${base}-${i}.wbk${enc ? '.enc' : ''}`
  const tmpDir = path.join(P.backups, `.tmp-${randomBytes(6).toString('hex')}`)
  const tmpFile = path.join(P.backups, `.${name}.part`)
  fs.mkdirSync(tmpDir)
  try {
    const snap = path.join(tmpDir, 'wishlist.db')
    const handle = db || new DatabaseSync(P.db)
    try {
      handle.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`)
    } finally {
      if (!db) handle.close()
    }
    const s = new DatabaseSync(snap)
    let schemaVersion, fingerprint
    const counts = {}
    try {
      schemaVersion = Number(s.prepare('PRAGMA user_version').get().user_version) || 0
      fingerprint = fingerprintOf(s)
      for (const t of countTables) {
        try {
          counts[t] = s.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
        } catch {
          /* table missing */
        }
      }
    } finally {
      s.close()
    }
    const files = {}
    counts.images = 0
    counts.avatars = 0
    async function* hashing(src, n) {
      const h = createHash('sha256')
      let size = 0
      for await (const c of src) {
        h.update(c)
        size += c.length
        yield c
      }
      files[n] = { size, sha256: h.digest('hex') }
    }
    const bufEntry = (n, buf) => {
      files[n] = { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
      return { name: n, type: 'file', size: buf.length, body: buf }
    }
    const manifestBase = { format: FORMAT, format_version: FORMAT_VERSION, app: 'wishy', app_version: appVersion, schema_version: schemaVersion, schema_fingerprint: fingerprint, created_at: created.toISOString(), reason, label: lbl || null, encrypted: enc }
    async function* entries() {
      yield { name: 'wishlist.db', type: 'file', size: fs.statSync(snap).size, body: hashing(fs.createReadStream(snap), 'wishlist.db') }
      for (const [dir, prefix] of [[P.images, 'images'], [P.avatars, 'avatars']]) {
        yield { name: prefix, type: 'dir' }
        for (const f of walkFiles(dir, prefix)) {
          let buf
          try {
            buf = fs.readFileSync(f.file)
          } catch (e) {
            if (e.code === 'ENOENT') continue // deleted during the backup
            throw e
          }
          counts[prefix]++
          yield bufEntry(f.name, buf)
        }
      }
      if (enc && fs.existsSync(P.secret)) yield bufEntry('secret.key', fs.readFileSync(P.secret))
      yield { name: 'manifest.json', type: 'file', body: Buffer.from(JSON.stringify({ ...manifestBase, counts, files }, null, 1)) }
    }
    const meta = { created_at: manifestBase.created_at, app_version: appVersion, schema_version: schemaVersion, reason, label: lbl || null }
    const stages = [Readable.from(tarStream(entries())), createGzip({ level: 6 })]
    if (enc) stages.push(new EncryptStream(await makeEncHeader(passphrase, meta)))
    await pipeline(...stages, fs.createWriteStream(tmpFile, { mode: 0o600 }))
    const fd = fs.openSync(tmpFile, 'r+')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    const final = path.join(P.backups, name)
    renameRetry(tmpFile, final)
    const side = { name, ...meta, encrypted: enc, counts, schema_fingerprint: fingerprint, size: fs.statSync(final).size, verified_ok: null, verified_at: null }
    writeJsonAtomic(`${final}.meta.json`, side)
    if (verify) {
      await readBackup(final, { passphrases: enc ? [passphrase] : [] })
      side.verified_ok = true
      side.verified_at = new Date().toISOString()
      writeJsonAtomic(`${final}.meta.json`, side)
    }
    return side
  } catch (e) {
    rmrf(tmpFile)
    throw e
  } finally {
    rmrf(tmpDir)
  }
}

// ---------------------------------------------------------------- List / clean up

export function backupFile(dataDir, name) {
  if (!BACKUP_RE.test(String(name || ''))) throw new BackupError('backup_not_found', 'Backup not found', 404)
  const f = path.join(paths(dataDir).backups, name)
  if (!fs.existsSync(f)) throw new BackupError('backup_not_found', 'Backup not found', 404)
  return f
}

export function listBackups(dataDir) {
  const dir = paths(dataDir).backups
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => BACKUP_RE.test(n))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const f = path.join(dir, name)
    let st
    try {
      st = fs.statSync(f)
    } catch {
      continue
    }
    let side = readJson(`${f}.meta.json`)
    if (!side) {
      side = { reason: 'unknown', created_at: st.mtime.toISOString(), encrypted: false }
      try {
        if (isEncryptedFile(f)) {
          const { hdr } = readEncHeader(f)
          side = { ...side, ...(hdr.meta || {}), encrypted: true }
        }
      } catch {
        /* unreadable */
      }
    }
    out.push({
      name,
      size: st.size,
      created_at: side.created_at,
      reason: side.reason || 'unknown',
      label: side.label || null,
      version: side.app_version || null,
      schema_version: side.schema_version ?? null,
      encrypted: !!side.encrypted,
      verified: side.verified_ok === true ? true : side.verified_ok === false ? false : null,
      verified_at: side.verified_at || null,
      counts: side.counts || null,
      uploaded: !!side.uploaded,
      mtime: st.mtimeMs,
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export function updateSidecar(dataDir, name, patch) {
  const f = path.join(paths(dataDir).backups, name)
  const side = readJson(`${f}.meta.json`) || { name }
  writeJsonAtomic(`${f}.meta.json`, { ...side, ...patch })
}

export function deleteBackup(dataDir, name) {
  const f = backupFile(dataDir, name)
  rmrf(f)
  rmrf(`${f}.meta.json`)
  rmrf(rollbackKeyPath(dataDir, name))
}

// ---------------------------------------------------------------- Keys for rollbacks
// Encrypted pre-update/pre-restore backups must be restorable even if the (new) database no longer
// provides the passphrase: one passphrase per backup, sealed with secret.key, under launcher/keys.
export const rollbackKeyPath = (dataDir, name) => path.join(dataDir, 'launcher', 'keys', `${path.basename(name)}.key`)
export function writeRollbackKey(dataDir, name, passphrase) {
  const f = rollbackKeyPath(dataDir, name)
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })
  fs.writeFileSync(f, seal('rollback-key', passphrase), { mode: 0o600 })
}
export function readRollbackKey(dataDir, name) {
  try {
    return unseal('rollback-key', fs.readFileSync(rollbackKeyPath(dataDir, name), 'utf8'))
  } catch {
    return null
  }
}

/** Remove leftovers of aborted operations (older than 1 h) in the backup folder. */
export function pruneBackupOrphans(dataDir, maxAgeMs = 3_600_000) {
  const dir = paths(dataDir).backups
  let n = 0
  try {
    for (const e of fs.readdirSync(dir)) {
      if (!/^\.(upload-|tmp-)|^\..*\.part$/.test(e)) continue
      const p = path.join(dir, e)
      if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) {
        rmrf(p)
        n++
      }
    }
  } catch {
    /* folder missing */
  }
  return n
}

/**
 * Retention: regular backups (manual/scheduled/uploaded) - keep the newest keep_last AND none
 * older than keep_days (0 = unlimited); pre-update and pre-restore are handled separately per keep_pre_update.
 * The newest backup overall is never deleted. Age = modification time of the file.
 */
export function pruneBackups(dataDir, { keep_last = 14, keep_days = 90, keep_pre_update = 5 } = {}, now = Date.now()) {
  const all = listBackups(dataDir)
  if (!all.length) return []
  const newest = all[0].name
  const del = []
  const regular = all.filter((b) => !SAFETY_REASONS.includes(b.reason))
  regular.forEach((b, i) => {
    if ((keep_last > 0 && i >= keep_last) || (keep_days > 0 && now - b.mtime > keep_days * 86_400_000)) del.push(b.name)
  })
  for (const r of SAFETY_REASONS) {
    all
      .filter((b) => b.reason === r)
      .forEach((b, i) => {
        if (keep_pre_update > 0 && i >= keep_pre_update) del.push(b.name)
      })
  }
  const done = []
  for (const n of del) {
    if (n === newest) continue
    try {
      deleteBackup(dataDir, n)
      done.push(n)
    } catch {
      /* ignore */
    }
  }
  return done
}

/// ---------------------------------------------------------------- Restore

/**
 * Unpacks + verifies a backup into DATA_DIR/restore-pending; the ready.json marker is written last
 * (commit=false: the caller writes it later with commitPendingRestore). It is applied at the next start
 * BEFORE the database is opened (applyPendingRestore).
 * maxSchema: highest schema version the running app knows (null = do not check, e.g. rollback).
 * keepSession: { row, user_id } - session of the acting admin; mode 'rollback' leaves sessions unchanged.
 * dbOnly: swap only the database (rollback after an update - images stay, saves space and time).
 */
export async function stageRestore({ dataDir, file, passphrases = [], maxSchema = null, keepSession = null, mode = 'restore', actor = null, preRestoreBackup = null, commit = true, dbOnly = false }) {
  const P = paths(dataDir)
  const tmp = path.join(dataDir, `restore-pending.tmp-${randomBytes(4).toString('hex')}`)
  try {
    const { manifest } = await readBackup(file, { passphrases, extractTo: tmp, only: dbOnly ? new Set(['wishlist.db']) : null })
    const h = new DatabaseSync(path.join(tmp, 'wishlist.db'))
    let uv
    try {
      const qc = Object.values(h.prepare('PRAGMA quick_check').get() || {})[0]
      if (qc !== 'ok') throw new BackupError('backup_corrupt', `Database in the backup is corrupted (${qc})`)
      uv = Number(h.prepare('PRAGMA user_version').get().user_version) || 0
      if (maxSchema !== null && uv > maxSchema) {
        throw new BackupError('backup_schema_newer', `The backup comes from a newer database schema (${uv} > ${maxSchema}). Please update Wishy first.`, 409)
      }
      // Wishy creates no triggers/views - in an (uploaded) backup they would be an attack vector
      const odd = h.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view')").all()
      if (odd.length) throw new BackupError('backup_invalid', `The backup contains unexpected database objects (${odd.map((o) => `${o.type} ${o.name}`).join(', ')})`)
      if (mode !== 'rollback') {
        const admin = h.prepare("SELECT 1 FROM users WHERE role='admin' AND disabled=0 LIMIT 1").get()
        if (!admin) throw new BackupError('backup_no_admin', 'The backup contains no active administrator')
      }
    } finally {
      h.close()
    }
    for (const f of ['wishlist.db-wal', 'wishlist.db-shm']) rmrf(path.join(tmp, f))
    if (!dbOnly) for (const d of ['images', 'avatars']) fs.mkdirSync(path.join(tmp, d), { recursive: true })
    rmrf(P.pending)
    renameRetry(tmp, P.pending)
    fsyncDir(dataDir)
    const markerData = {
      created_at: new Date().toISOString(),
      source: path.basename(file),
      mode,
      db_only: dbOnly,
      schema_version: uv,
      app_version: manifest.app_version,
      backup_created_at: manifest.created_at,
      keep_session: keepSession,
      actor,
      pre_restore_backup: preRestoreBackup,
    }
    if (commit) commitPendingRestore(dataDir, markerData)
    return { manifest, schema_version: uv, marker: markerData }
  } catch (e) {
    rmrf(tmp)
    throw e
  }
}

/** Writes the marker - only then is the restore considered ready. */
export function commitPendingRestore(dataDir, markerData) {
  writeJsonAtomic(paths(dataDir).marker, markerData)
}

export const pendingRestore = (dataDir) => readJson(paths(dataDir).marker)

export function cancelPendingRestore(dataDir) {
  rmrf(paths(dataDir).pending)
}

const DB_FILES = ['wishlist.db', 'wishlist.db-wal', 'wishlist.db-shm', 'wishlist.db-journal']

/**
 * Applies a prepared restore (synchronous, BEFORE the database is opened). Every step is
 * repeatable: a journal (restore-pending/journal.json) records the inventory and the aside location; whatever
 * is already swapped (no longer in restore-pending) is skipped. The database (incl. -wal/-shm of the old state)
 * is swapped LAST. On an error (not a crash) everything is swapped back.
 */
export function applyPendingRestore(dataDir, log = (m) => console.log(`[restore] ${m}`)) {
  const P = paths(dataDir)
  const jf = path.join(P.pending, 'journal.json')
  if (!fs.existsSync(P.marker)) {
    if (fs.existsSync(P.pending)) rmrf(P.pending) // incomplete preparation (marker missing)
    for (const n of fs.readdirSync(dataDir)) if (n.startsWith('restore-pending.tmp-')) rmrf(path.join(dataDir, n))
    return null
  }
  const marker = readJson(P.marker) || {}
  let J = readJson(jf)
  if (!J) {
    const items = marker.db_only ? [] : ['images', 'avatars', ...(fs.existsSync(path.join(P.pending, 'secret.key')) ? ['secret.key'] : [])]
    J = { started_at: new Date().toISOString(), old_dir: path.join(dataDir, `restore-old-${stampOf(new Date())}`), items }
    writeJsonAtomic(jf, J)
  } else log('Resuming interrupted restore ...')
  const live = (n) => path.join(dataDir, n)
  const staged = (n) => path.join(P.pending, n)
  const aside = (n) => path.join(J.old_dir, n)
  const ex = (p) => fs.existsSync(p)
  log(`Applying backup ${marker.source || '?'} ...`)
  try {
    if (!ex(staged('wishlist.db')) && !ex(aside('wishlist.db'))) throw new Error('Database missing in the prepared restore')
    fs.mkdirSync(J.old_dir, { recursive: true })
    for (const n of J.items) {
      if (!ex(staged(n))) continue // already swapped
      if (ex(live(n))) {
        if (!ex(aside(n))) renameRetry(live(n), aside(n))
        else rmrf(live(n))
      }
      renameRetry(staged(n), live(n))
    }
    if (ex(staged('wishlist.db'))) {
      for (const f of DB_FILES) {
        if (!ex(live(f))) continue
        if (!ex(aside(f))) renameRetry(live(f), aside(f))
        else rmrf(live(f))
      }
      renameRetry(staged('wishlist.db'), live('wishlist.db'))
    }
    fsyncDir(dataDir)
    // Sessions: sign out everyone except the acting admin (if present in the backup); idempotent
    let relogin = false
    const h = new DatabaseSync(P.db)
    try {
      h.exec('PRAGMA journal_mode = WAL')
      if (marker.mode !== 'rollback') {
        h.exec('DELETE FROM sessions')
        const ks = marker.keep_session
        if (ks?.row && ks.user_id) {
          const u = h.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND disabled=0").get(ks.user_id)
          if (u) {
            const cols = h.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name).filter((c) => ks.row[c] !== undefined)
            h.prepare(`INSERT OR REPLACE INTO sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => ks.row[c]))
          } else relogin = true
        }
        // Operational settings of the instance (backups/updates) are not part of the data: keep them
        for (const r of Array.isArray(marker.carry_settings) ? marker.carry_settings : []) {
          if (/^(backup|update)_[a-z_]+$/.test(r.key)) h.prepare('INSERT OR REPLACE INTO system_settings (key,value) VALUES (?,?)').run(r.key, r.value)
        }
      }
    } finally {
      h.close()
    }
    const result = { ok: true, at: new Date().toISOString(), source: marker.source, mode: marker.mode || 'restore', db_only: !!marker.db_only, schema_version: marker.schema_version, app_version: marker.app_version, backup_created_at: marker.backup_created_at, pre_restore_backup: marker.pre_restore_backup || null, actor: marker.actor || null, relogin, old_dir: J.old_dir, audited: false }
    writeJsonAtomic(P.result, result)
    rmrf(P.pending)
    fsyncDir(dataDir)
    const m = readJson(P.maint)
    if (m && m.by !== 'launcher') rmrf(P.maint)
    log(`Backup ${marker.source || ''} applied`)
    return result
  } catch (e) {
    log(`Restore failed, restoring previous state: ${e.message}`)
    for (const n of ['wishlist.db', ...[...J.items].reverse()]) {
      try {
        if (!ex(staged(n)) && ex(live(n)) && ex(aside(n))) {
          if (n === 'wishlist.db') for (const f of DB_FILES.slice(1)) rmrf(live(f))
          renameRetry(live(n), staged(n))
        }
        const group = n === 'wishlist.db' ? DB_FILES : [n]
        for (const f of group) if (ex(aside(f)) && !ex(live(f))) renameRetry(aside(f), live(f))
      } catch (re) {
        log(`Swapping back failed (${n}): ${re.message}`)
      }
    }
    try {
      renameRetry(P.marker, path.join(P.pending, 'ready.failed.json'))
      rmrf(jf)
    } catch {
      /* ignore */
    }
    const result = { ok: false, at: new Date().toISOString(), source: marker.source, mode: marker.mode || 'restore', error: e.message, actor: marker.actor || null, audited: false }
    writeJsonAtomic(P.result, result)
    const m = readJson(P.maint)
    if (m && m.by !== 'launcher') rmrf(P.maint)
    return result
  }
}

/** Removes the old data state that was set aside, after a successful start. */
export function cleanupRestoreOld(dataDir) {
  const P = paths(dataDir)
  const r = readJson(P.result)
  if (r?.ok && r.old_dir && fs.existsSync(r.old_dir) && path.dirname(path.resolve(r.old_dir)) === path.resolve(dataDir)) {
    rmrf(r.old_dir)
    writeJsonAtomic(P.result, { ...r, old_dir: null })
  }
}
