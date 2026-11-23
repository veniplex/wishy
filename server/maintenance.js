// Maintenance mode, launcher control channel (app side), schema guard and post-start tasks after restore/update.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { db } from './db.js'
import { schemaVersion, knownSchemaVersion } from './schema.js'
import { audit } from './audit.js'
import { HttpError, parseCookies } from './util.js'
import { COOKIE } from './session.js'
import { paths, readJson, writeJsonAtomic, cleanupRestoreOld, pruneBackupOrphans } from './backup-core.js'
import { maintenancePage, maintenanceHeaders, pickLang } from '../launcher/lib/maintenance-page.js'

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
const P = paths(DATA_DIR)
export const APP_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const UPDATE_LOG = path.join(DATA_DIR, 'update.log')
const hash = (s) => createHash('sha256').update(String(s)).digest('hex')

// ---------------------------------------------------------------- Launcher (control channel, loopback + token only)

const CONTROL_URL = process.env.WISHY_CONTROL_URL || ''
// Token from a 0600 file in the launcher folder (not from the environment, so it does not show up in
// /proc/<pid>/environ and is not inherited by Chromium). The file is deleted after reading; the launcher rewrites it before every start.
function readControlToken() {
  const f = process.env.WISHY_CONTROL_TOKEN_FILE
  if (!f) return ''
  try {
    const t = JSON.parse(fs.readFileSync(f, 'utf8')).token || ''
    fs.rmSync(f, { force: true })
    return t
  } catch {
    return ''
  }
}
const CONTROL_TOKEN = readControlToken()
export const supervised = process.env.WISHY_SUPERVISED === '1' && /^http:\/\/127\.0\.0\.1:\d+$/.test(CONTROL_URL) && !!CONTROL_TOKEN
delete process.env.WISHY_CONTROL_TOKEN_FILE

export async function launcherCall(method, p, body, timeout = 10_000) {
  if (!supervised) throw new HttpError(409, 'Wishy is running without a launcher', 'not_supervised')
  try {
    const res = await fetch(CONTROL_URL + p, {
      method,
      headers: { authorization: `Bearer ${CONTROL_TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
    return { status: res.status, json: await res.json().catch(() => ({})) }
  } catch (e) {
    throw new HttpError(503, `Launcher unreachable (${e.message})`, 'launcher_unreachable')
  }
}

/** Session row of the current request (for "admin stays signed in"). */
export function sessionKeepInfo(req) {
  const id = req.sessionRowId ?? req.sessionId
  if (!id) return null
  const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(id)
  return row ? { row, user_id: req.user.id } : null
}

// ---------------------------------------------------------------- Maintenance state (file, so it survives restarts)

// One stat() per request: the end of maintenance is visible immediately, content is re-read only on change
let cache = { at: 0, mtime: -1, val: null }
export function maintenanceState() {
  let mtime = -1
  try {
    mtime = fs.statSync(P.maint).mtimeMs
  } catch {
    mtime = -1
  }
  if (mtime !== cache.mtime || cache.at === 0) cache = { at: Date.now(), mtime, val: mtime < 0 ? null : readJson(P.maint) }
  return cache.val?.on ? cache.val : null
}
export function setMaintenance(state, { message = '', req = null } = {}) {
  writeJsonAtomic(P.maint, { on: true, state, message, by: 'app', session_hash: req?.sessionId ? hash(req.sessionId) : null, user_id: req?.user?.id ?? null, since: new Date().toISOString() })
  cache.at = 0
}
export function clearMaintenance() {
  const m = readJson(P.maint)
  if (m && m.by !== 'launcher') fs.rmSync(P.maint, { force: true })
  cache.at = 0
}

const publicInfo = (m) => ({ maintenance: true, state: m.state || 'maintenance', message: m.message || '', since: m.since || null, version: APP_VERSION, supervised })

// Allowed during maintenance for the acting admin's session (API), plus the app UI itself
const ADMIN_ALLOW = [
  ['GET', /^\/api\/admin\/update\/(status|log)$/],
  ['GET', /^\/api\/admin\/backups$/],
  ['DELETE', /^\/api\/admin\/backups\/restore-pending$/],
  ['GET', /^\/api\/auth\/me$/],
]

/**
 * Maintenance gate. Runs BEFORE all other routes (also before /api/v1 with API keys), so the acting admin
 * is recognised directly by the session cookie (its hash was stored when maintenance was activated).
 */
export function maintenanceGate(req, res, next) {
  const m = maintenanceState()
  if (!m) return next()
  const p = req.path
  if (p === '/api/maintenance' || p === '/healthz' || p === '/readyz') return next()
  const sid = parseCookies(req.headers.cookie)[COOKIE]
  const acting = !!(m.session_hash && sid && sid.length < 200 && hash(sid) === m.session_hash)
  const isApi = p.startsWith('/api/')
  if (acting && (isApi ? ADMIN_ALLOW.some(([meth, re]) => meth === req.method && re.test(p)) : req.method === 'GET' || req.method === 'HEAD')) return next()
  res.setHeader('Retry-After', '5')
  res.setHeader('Cache-Control', 'no-store')
  if (isApi) return res.status(503).json({ error: 'Wishy is currently under maintenance. Please try again shortly.', code: 'maintenance', maintenance: publicInfo(m) })
  if ((req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/assets/') && req.accepts('html')) {
    res.set(maintenanceHeaders())
    return res.status(503).type('html').send(maintenancePage({ state: m.state, lang: pickLang(req.headers['accept-language']) }))
  }
  if (p.startsWith('/assets/') && (req.method === 'GET' || req.method === 'HEAD')) return next()
  res.status(503).type('text').send('maintenance')
}

/** Public (no sign-in). /healthz and /readyz are served by proxy.js (healthRoutes). */
export function maintenanceRoutes(app) {
  app.get('/api/maintenance', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const m = maintenanceState()
    res.json(m ? publicInfo(m) : { maintenance: false, state: 'idle', message: '', version: APP_VERSION, supervised })
  })
}

// ---------------------------------------------------------------- Post-start tasks

/** Take over audit events from the launcher (it has no DB access). */
export function drainLauncherAudit() {
  const q = path.join(DATA_DIR, 'launcher', 'audit-queue.jsonl')
  if (!fs.existsSync(q)) return
  const work = `${q}.${process.pid}.processing`
  try {
    fs.renameSync(q, work)
  } catch {
    return
  }
  for (const line of fs.readFileSync(work, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      audit({ via: 'system' }, String(e.action).slice(0, 80), { status: e.status === 'fail' ? 'fail' : 'ok', details: { ...e.details, launcher_at: e.at }, target: e.target })
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(work, { force: true })
}

export function lastRestoreResult() {
  const r = readJson(P.result)
  if (!r) return null
  const { old_dir, ...rest } = r
  void old_dir
  return rest
}

export function maintenanceStartup() {
  // Schema guard: an older app version must not use a database from a NEWER schema.
  // The launcher recognises exit code 78 (no restart attempt, emergency view).
  const dbv = schemaVersion()
  const known = knownSchemaVersion()
  if (dbv > known) {
    console.error(`[schema] The database has schema version ${dbv}, this Wishy version only knows up to ${known}. Startup aborted - start a newer version or restore a matching backup (docs/operations.md).`)
    try {
      db.close()
    } catch {
      /* ignore */
    }
    process.exit(78)
  }
  pruneBackupOrphans(DATA_DIR)
  // Log the result of a restore applied at startup
  const r = readJson(P.result)
  if (r && !r.audited) {
    audit({ via: 'system' }, r.ok ? 'backup.restore' : 'backup.restore_failed', {
      status: r.ok ? 'ok' : 'fail',
      target: { type: 'backup', label: r.source },
      details: { mode: r.mode, error: r.error, schema_version: r.schema_version, backup_created_at: r.backup_created_at, actor: r.actor?.label || r.actor?.id || null },
    })
    writeJsonAtomic(P.result, { ...r, audited: true })
  }
  // Remove the maintenance marker of an app instance that is no longer running (e.g. aborted restore without pending data)
  const m = readJson(P.maint)
  if (m && m.by === 'app' && !fs.existsSync(P.marker)) clearMaintenance()
  // Clean up the old data state after a successful start
  setTimeout(() => {
    try {
      cleanupRestoreOld(DATA_DIR)
    } catch (e) {
      console.error(e)
    }
  }, Number(process.env.WISHY_RESTORE_CLEANUP_MS || 60_000)).unref()
  drainLauncherAudit()
  setInterval(() => {
    try {
      drainLauncherAudit()
      pruneBackupOrphans(DATA_DIR)
    } catch {
      /* ignore */
    }
  }, 30_000).unref()
}

// Shut down cleanly (the launcher sends SIGTERM): close the DB so the WAL is written back
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  try {
    db.close()
  } catch {
    /* ignore */
  }
  process.exit(0)
}
process.once('SIGTERM', shutdown)
if (supervised) {
  process.once('SIGINT', shutdown)
  // If the launcher dies (e.g. killed hard on Windows), the app exits instead of blocking the port
  const parent = process.ppid
  setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch {
      shutdown()
    }
  }, 2000).unref()
}
