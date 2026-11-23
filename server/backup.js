// Backups: HTTP API (admin), settings, schedule + retention, restore flow.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { db } from './db.js'
import { getSys, setSys, getSecretSys, setSecretSys } from './config.js'
import { requireAdmin } from './session.js'
import { audit } from './audit.js'
import { HttpError } from './util.js'
import { schemaVersion } from './schema.js'
import {
  BACKUP_RE, BackupError, paths, createBackup, listBackups, backupFile, deleteBackup, pruneBackups, readBackup, updateSidecar,
  stageRestore, commitPendingRestore, writeRollbackKey, pendingRestore, cancelPendingRestore, isEncryptedFile, readEncHeader,
} from './backup-core.js'
import {
  DATA_DIR, APP_VERSION, supervised, launcherCall, setMaintenance, clearMaintenance, maintenanceState, sessionKeepInfo, lastRestoreResult,
} from './maintenance.js'

const P = paths(DATA_DIR)
const DAY = 86_400_000

// ---------------------------------------------------------------- Settings

const DEF = { backup_schedule: 'off', backup_hour: 3, backup_weekday: 0, backup_keep_last: 14, backup_keep_days: 90, backup_keep_pre_update: 5, backup_encrypt: false, backup_max_upload_mb: 2048 }
const sys = (k) => {
  const v = getSys(k)
  return v === null || v === undefined ? DEF[k] : v
}

export function backupPassphrase() {
  if (process.env.BACKUP_PASSPHRASE) return process.env.BACKUP_PASSPHRASE
  try {
    return getSecretSys('backup_passphrase') || null
  } catch {
    return null
  }
}

/** Safety copy before restore/import: encrypted if encryption is enabled (+ rollback key). */
async function safetyBackup(reason, label = '') {
  const pass = sys('backup_encrypt') ? backupPassphrase() : null
  const b = await createBackup({ dataDir: DATA_DIR, db, reason, label, appVersion: APP_VERSION, passphrase: pass })
  if (pass) writeRollbackKey(DATA_DIR, b.name, pass)
  return b
}

function retention() {
  return { keep_last: Number(sys('backup_keep_last')), keep_days: Number(sys('backup_keep_days')), keep_pre_update: Number(sys('backup_keep_pre_update')) }
}

/** Latest due slot <= now (server local time, configurable via TZ in the container). */
function lastSlot(now = new Date()) {
  const sched = sys('backup_schedule')
  if (sched === 'off') return null
  const d = new Date(now)
  d.setMinutes(0, 0, 0)
  d.setHours(Number(sys('backup_hour')))
  if (sched === 'weekly') {
    const diff = (d.getDay() - Number(sys('backup_weekday')) + 7) % 7
    d.setDate(d.getDate() - diff)
    if (d > now) d.setDate(d.getDate() - 7)
  } else if (d > now) d.setDate(d.getDate() - 1)
  return d.getTime()
}
function nextRun(now = new Date()) {
  const sched = sys('backup_schedule')
  const last = lastSlot(now)
  if (last === null) return null
  const done = Number(getSys('backup_last_slot') || 0)
  if (last > done) return new Date(Math.max(now.getTime(), last)).toISOString()
  return new Date(last + (sched === 'weekly' ? 7 : 1) * DAY).toISOString()
}

function settingsOut() {
  return {
    schedule: sys('backup_schedule'),
    hour: Number(sys('backup_hour')),
    weekday: Number(sys('backup_weekday')),
    keep_last: Number(sys('backup_keep_last')),
    keep_days: Number(sys('backup_keep_days')),
    keep_pre_update: Number(sys('backup_keep_pre_update')),
    encrypt: !!sys('backup_encrypt'),
    passphrase_set: !!backupPassphrase(),
    passphrase_env: !!process.env.BACKUP_PASSPHRASE,
    max_upload_mb: Number(sys('backup_max_upload_mb')),
    next_run_at: nextRun(),
    last_run: getSys('backup_last_run') || null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

const intIn = (v, min, max, code, msg) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, msg, code)
  return n
}

// ---------------------------------------------------------------- Core flows

let busy = null // 'create' | 'restore' | 'upload'
function lock(kind) {
  if (busy) throw new HttpError(409, 'A backup operation is already running', 'backup_busy')
  busy = kind
  return () => (busy = null)
}

const toHttp = (e) => (e?.backupError ? new HttpError(e.status || 400, e.message, e.code) : e)

/** Creates a backup according to the settings. reason: manual | scheduled | pre-restore ... */
export async function makeBackup({ reason = 'manual', label = '', encrypt } = {}) {
  const wantEnc = encrypt ?? !!sys('backup_encrypt')
  const pass = wantEnc ? backupPassphrase() : null
  if (wantEnc && !pass) throw new HttpError(400, 'Encryption is enabled but no passphrase is set', 'passphrase_required')
  const b = await createBackup({ dataDir: DATA_DIR, db, reason, label, appVersion: APP_VERSION, passphrase: pass })
  const pruned = pruneBackups(DATA_DIR, retention())
  audit({ via: 'system' }, 'backup.created', { target: { type: 'backup', label: b.name }, details: { reason, encrypted: b.encrypted, size: b.size, pruned: pruned.length } })
  return b
}

async function scheduledTick() {
  try {
    const slot = lastSlot()
    if (slot === null || busy || maintenanceState() || pendingRestore(DATA_DIR)) return
    if (slot <= Number(getSys('backup_last_slot') || 0)) return
    setSys('backup_last_slot', slot)
    const unlock = lock('create')
    try {
      const b = await makeBackup({ reason: 'scheduled' })
      setSys('backup_last_run', { at: new Date().toISOString(), ok: true, name: b.name })
    } catch (e) {
      setSys('backup_last_run', { at: new Date().toISOString(), ok: false, error: e.message, code: e.code || null })
      audit({ via: 'system' }, 'backup.scheduled_failed', { status: 'fail', details: { error: e.message, code: e.code } })
      console.error('[backup] Scheduled backup failed:', e.message)
    } finally {
      unlock()
    }
  } catch (e) {
    console.error('[backup]', e)
  }
}

const itemOf = (name) => listBackups(DATA_DIR).find((b) => b.name === name) || null

function statusOut() {
  const pend = pendingRestore(DATA_DIR)
  return {
    backups: listBackups(DATA_DIR).map(({ mtime, ...b }) => ({ ...b, mtime: new Date(mtime).toISOString() })),
    settings: settingsOut(),
    busy,
    supervised,
    restore_pending: pend ? { source: pend.source, created_at: pend.created_at, backup_created_at: pend.backup_created_at, restart: supervised ? 'automatic' : 'manual' } : null,
    last_restore: lastRestoreResult(),
    schema_version: schemaVersion(),
    app_version: APP_VERSION,
  }
}

/**
 * Restore flow: verify + unpack to restore-pending (schema check), pre-restore backup,
 * write marker, enable maintenance, restart (launcher) or hint at a manual restart.
 */
async function requestRestore(req, file, passphrase) {
  if (maintenanceState()) throw new HttpError(409, 'Maintenance mode is already active', 'maintenance_active')
  const keep = sessionKeepInfo(req)
  const staged = await stageRestore({
    dataDir: DATA_DIR,
    file,
    passphrases: [passphrase, backupPassphrase()],
    maxSchema: schemaVersion(),
    keepSession: keep,
    actor: { id: req.user.id, label: req.user.email },
    commit: false,
  })
  let pre
  try {
    pre = await safetyBackup('pre-restore')
  } catch (e) {
    cancelPendingRestore(DATA_DIR)
    throw new HttpError(500, `Backup before the restore failed: ${e.message}`, 'pre_restore_backup_failed')
  }
  pruneBackups(DATA_DIR, retention())
  const carry = db.prepare('SELECT key, value FROM system_settings').all().filter((r) => /^(backup|update)_/.test(r.key))
  commitPendingRestore(DATA_DIR, { ...staged.marker, carry_settings: carry, pre_restore_backup: path.join(P.backups, pre.name) })
  setMaintenance(supervised ? 'restoring' : 'restart_required', { req, message: supervised ? '' : 'Restart required to apply the backup' })
  audit(req, 'backup.restore_requested', { target: { type: 'backup', label: path.basename(file) }, details: { pre_restore_backup: pre.name, backup_created_at: staged.manifest.created_at, schema_version: staged.schema_version } })
  return { pre, preFile: path.join(P.backups, pre.name), manifest: staged.manifest }
}

function triggerRestart(res, preFile) {
  if (!supervised) return
  res.on('finish', () => {
    setTimeout(async () => {
      try {
        const r = await launcherCall('POST', '/restart', { reason: 'restore', rollback_backup: path.basename(preFile) })
        if (r.status !== 202) throw new Error(r.json?.error || `HTTP ${r.status}`)
      } catch (e) {
        console.error('[backup] Launcher restart failed, exiting with restart code:', e.message)
        process.exit(75)
      }
    }, 100)
  })
}

// ---------------------------------------------------------------- Routes

export function backupRoutes(app) {
  const A = requireAdmin

  app.get('/api/admin/backups', A, (req, res) => res.json(statusOut()))

  app.post('/api/admin/backups', A, async (req, res) => {
    const unlock = lock('create')
    try {
      const b = await makeBackup({ reason: 'manual', label: req.body?.label || '' })
      audit(req, 'backup.create', { target: { type: 'backup', label: b.name }, details: { encrypted: b.encrypted } })
      res.json({ backup: itemOf(b.name) })
    } catch (e) {
      throw toHttp(e)
    } finally {
      unlock()
    }
  })

  app.get('/api/admin/backups/settings', A, (req, res) => res.json(settingsOut()))
  app.put('/api/admin/backups/settings', A, (req, res) => {
    const b = req.body || {}
    const changed = []
    const put = (k, v) => {
      if (sys(k) !== v) changed.push(k.replace(/^backup_/, ''))
      setSys(k, v)
    }
    if (b.schedule !== undefined) {
      if (!['off', 'daily', 'weekly'].includes(b.schedule)) throw new HttpError(400, 'Invalid schedule', 'invalid_schedule')
      put('backup_schedule', b.schedule)
    }
    if (b.hour !== undefined) put('backup_hour', intIn(b.hour, 0, 23, 'invalid_hour', 'Invalid hour'))
    if (b.weekday !== undefined) put('backup_weekday', intIn(b.weekday, 0, 6, 'invalid_weekday', 'Invalid weekday'))
    if (b.keep_last !== undefined) put('backup_keep_last', intIn(b.keep_last, 0, 10_000, 'invalid_retention', 'Invalid count'))
    if (b.keep_days !== undefined) put('backup_keep_days', intIn(b.keep_days, 0, 36_500, 'invalid_retention', 'Invalid number of days'))
    if (b.keep_pre_update !== undefined) put('backup_keep_pre_update', intIn(b.keep_pre_update, 1, 1000, 'invalid_retention', 'Invalid count'))
    if (b.max_upload_mb !== undefined) put('backup_max_upload_mb', intIn(b.max_upload_mb, 1, 1024 * 1024, 'invalid_upload_limit', 'Invalid size'))
    if (b.passphrase === null) {
      if (getSys('backup_passphrase')) changed.push('passphrase_cleared')
      setSecretSys('backup_passphrase', null)
    } else if (typeof b.passphrase === 'string' && b.passphrase.length) {
      if (b.passphrase.length < 10) throw new HttpError(400, 'The passphrase must be at least 10 characters long', 'passphrase_too_short')
      if (b.passphrase.length > 1024) throw new HttpError(400, 'The passphrase is too long', 'passphrase_too_long')
      setSecretSys('backup_passphrase', b.passphrase)
      changed.push('passphrase_set')
    }
    if (b.encrypt !== undefined) put('backup_encrypt', !!b.encrypt)
    if (sys('backup_encrypt') && !backupPassphrase()) {
      setSys('backup_encrypt', false)
      throw new HttpError(400, 'A passphrase must be set for encrypted backups', 'passphrase_required')
    }
    // Do not trigger an immediate catch-up run when the schedule changes
    if (changed.some((k) => ['schedule', 'hour', 'weekday'].includes(k))) setSys('backup_last_slot', lastSlot() ?? 0)
    if (changed.length) audit(req, 'backup.settings', { details: { changed } })
    res.json(settingsOut())
  })

  app.delete('/api/admin/backups/restore-pending', A, (req, res) => {
    if (!pendingRestore(DATA_DIR)) throw new HttpError(404, 'No restore pending', 'no_restore_pending')
    cancelPendingRestore(DATA_DIR)
    clearMaintenance()
    audit(req, 'backup.restore_cancelled', {})
    res.json({ ok: true })
  })

  app.post('/api/admin/backups/upload', A, async (req, res) => {
    const unlock = lock('upload')
    const max = Number(sys('backup_max_upload_mb')) * 1024 * 1024
    const declared = Number(req.headers['content-length'] || 0)
    const tmp = path.join(P.backups, `.upload-${randomBytes(6).toString('hex')}`)
    try {
      if (declared > max) throw new HttpError(413, 'The file is too large', 'upload_too_large')
      fs.mkdirSync(P.backups, { recursive: true })
      let n = 0
      await pipeline(
        req,
        async function* (src) {
          for await (const c of src) {
            n += c.length
            if (n > max) throw new HttpError(413, 'The file is too large', 'upload_too_large')
            yield c
          }
        },
        fs.createWriteStream(tmp, { mode: 0o600 }),
      )
      if (n < 32) throw new HttpError(400, 'Empty or invalid file', 'backup_invalid')
      const encrypted = isEncryptedFile(tmp)
      let side = { uploaded: true, encrypted, verified_ok: null, verified_at: null }
      try {
        const r = await readBackup(tmp, { passphrases: [req.headers['x-backup-passphrase'], backupPassphrase()] })
        const m = r.manifest
        side = { ...side, created_at: m.created_at, app_version: m.app_version, schema_version: m.schema_version, reason: m.reason, label: m.label, counts: m.counts, verified_ok: true, verified_at: new Date().toISOString() }
      } catch (e) {
        if (!(encrypted && ['passphrase_required', 'passphrase_wrong'].includes(e.code))) throw toHttp(e)
        const { hdr } = readEncHeader(tmp) // structure verified, content only with passphrase
        side = { ...side, ...(hdr.meta || {}) }
      }
      // File name: keep if valid, otherwise generate; extension matches the encryption
      let name = String(req.headers['x-filename'] || '').split(/[/\\]/).pop().replace(/\.enc$/, '').replace(/\.wbk$/, '')
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(name)) name = `wishy-backup-upload-${new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}`
      const ext = encrypted ? '.wbk.enc' : '.wbk'
      let final = `${name}${ext}`
      for (let i = 2; fs.existsSync(path.join(P.backups, final)); i++) final = `${name}-${i}${ext}`
      if (!BACKUP_RE.test(final)) throw new HttpError(400, 'Invalid file name', 'invalid_name')
      fs.renameSync(tmp, path.join(P.backups, final))
      updateSidecar(DATA_DIR, final, { name: final, ...side, reason: side.reason || 'uploaded' })
      audit(req, 'backup.upload', { target: { type: 'backup', label: final }, details: { size: n, encrypted, verified: side.verified_ok } })
      res.json({ backup: itemOf(final), verified: side.verified_ok, passphrase_needed: encrypted && side.verified_ok !== true })
    } finally {
      fs.rmSync(tmp, { force: true })
      unlock()
    }
  })

  app.get('/api/admin/backups/:name/download', A, async (req, res) => {
    let f
    try {
      f = backupFile(DATA_DIR, req.params.name)
    } catch (e) {
      throw toHttp(e)
    }
    const st = fs.statSync(f)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', st.size)
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`)
    res.setHeader('Cache-Control', 'no-store')
    audit(req, 'backup.download', { target: { type: 'backup', label: req.params.name } })
    await pipeline(fs.createReadStream(f), res)
  })

  app.post('/api/admin/backups/:name/verify', A, async (req, res) => {
    let f
    try {
      f = backupFile(DATA_DIR, req.params.name)
      const pass = req.body?.passphrase ? [String(req.body.passphrase)] : [backupPassphrase()]
      const r = await readBackup(f, { passphrases: pass })
      updateSidecar(DATA_DIR, req.params.name, { verified_ok: true, verified_at: new Date().toISOString(), created_at: r.manifest.created_at, app_version: r.manifest.app_version, schema_version: r.manifest.schema_version, reason: itemOf(req.params.name)?.reason === 'uploaded' ? 'uploaded' : r.manifest.reason, counts: r.manifest.counts, encrypted: r.encrypted })
      const m = r.manifest
      res.json({ ok: true, backup: itemOf(req.params.name), manifest: { app_version: m.app_version, schema_version: m.schema_version, created_at: m.created_at, reason: m.reason, counts: m.counts, encrypted: m.encrypted, restorable: m.schema_version <= schemaVersion() } })
    } catch (e) {
      if (f && e.code === 'backup_corrupt') updateSidecar(DATA_DIR, req.params.name, { verified_ok: false, verified_at: new Date().toISOString() })
      throw toHttp(e)
    }
  })

  app.delete('/api/admin/backups/:name', A, (req, res) => {
    try {
      deleteBackup(DATA_DIR, req.params.name)
    } catch (e) {
      throw toHttp(e)
    }
    audit(req, 'backup.delete', { target: { type: 'backup', label: req.params.name } })
    res.json({ ok: true })
  })

  app.post('/api/admin/backups/:name/restore', A, async (req, res) => {
    const unlock = lock('restore')
    try {
      const f = backupFile(DATA_DIR, req.params.name)
      const r = await requestRestore(req, f, req.body?.passphrase ? String(req.body.passphrase) : null)
      triggerRestart(res, r.preFile)
      res.json({
        ok: true,
        restart: supervised ? 'automatic' : 'manual',
        pre_restore_backup: r.pre.name,
        message: supervised ? 'The backup is being applied, Wishy is restarting.' : 'The backup is prepared and will be applied the next time Wishy restarts.',
      })
    } catch (e) {
      throw toHttp(e)
    } finally {
      unlock()
    }
  })

  // Schedule
  setInterval(scheduledTick, Number(process.env.WISHY_BACKUP_TICK_MS || 60_000)).unref()
}
