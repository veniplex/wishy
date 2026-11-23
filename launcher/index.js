#!/usr/bin/env node
// Wishy launcher: main process in the container (behind tini). Responsibilities:
//  - Reverse proxy from the public port to the app child process (127.0.0.1:APP_PORT)
//  - Supervision (restart with backoff, crash loop -> fallback, schema guard: exit 78 = DB too new)
//  - Maintenance page + /__launcher/status + emergency view (/__launcher/recovery, token in the container log)
//  - Updates: (a) app update from a signed archive, (b) image update via the Docker API (container swap through
//    a short-lived helper container from the NEW image: `node /app/launcher/index.js --self-replace <job>`)
//  - Local, token-protected control channel (127.0.0.1 only) for the app
// No npm dependencies. Always runs from the image (/app/launcher).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { extractTar, TarParser } from './lib/tar.js'
import {
  LAUNCHER_VERSION, compareSemver, validVersion, artifactName, loadPublicKey, verifyRelease, sha256File, parseSha256File,
  readReleaseInfo, compatProblems, verifyReleaseMeta, imageRef, metaName,
} from './lib/release.js'
import { fetchText, downloadFile } from './lib/fetch.js'
import { Docker, dockerTarget, findSelf, buildCreatePayload, composeInfo } from './lib/docker.js'
import { maintenancePage, maintenanceHeaders, staticPageCsp, pickLang } from './lib/maintenance-page.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const env = process.env
const HELPER_JOB = process.argv[2] === '--self-replace' ? process.argv[3] : null
const BASELINE_DIR = path.resolve(env.BASELINE_DIR || path.join(HERE, '..'))
const DATA_DIR = path.resolve(env.DATA_DIR || '/data')
const PUBLIC_PORT = Number(env.PORT || 3000)
const PUBLIC_HOST = env.HOST || '0.0.0.0'
const APP_PORT = Number(env.APP_PORT || PUBLIC_PORT + 1)
const HEALTH_TIMEOUT = Number(env.WISHY_HEALTH_TIMEOUT_MS || 90_000)
const SWAP_TIMEOUT = Number(env.WISHY_SWAP_TIMEOUT_MS || HEALTH_TIMEOUT + 60_000)
const PROVEN_MS = Number(env.WISHY_PROVEN_MS || 10 * 60_000)
const MAX_ARTIFACT = Number(env.WISHY_MAX_ARTIFACT_MB || 512) * 1024 * 1024
const APP_DIR = path.join(DATA_DIR, 'app')
const RELEASES = path.join(APP_DIR, 'releases')
const CURRENT = path.join(APP_DIR, 'current.json')
const DOWNLOADS = path.join(APP_DIR, 'downloads')
const LDIR = path.join(DATA_DIR, 'launcher')
const JOB_FILE = path.join(LDIR, 'job.json')
const RESULT_FILE = path.join(LDIR, 'last-result.json')
const AUDIT_QUEUE = path.join(LDIR, 'audit-queue.jsonl')
const TOKEN_FILE = path.join(LDIR, 'control.token')
const UPDATE_LOG = path.join(DATA_DIR, 'update.log')
const MAINT_FILE = path.join(DATA_DIR, 'maintenance.json')
const BACKUPS = path.join(DATA_DIR, 'backups')
const NODE_MAJOR = Number(process.versions.node.split('.')[0])
const EXIT_RESTART = 75 // child exits with this = "please restart"
const EXIT_SCHEMA_NEWER = 78 // child refuses to start: the database comes from a newer schema
const BACKUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.wbk(\.enc)?$/

for (const d of [DATA_DIR, APP_DIR, RELEASES, DOWNLOADS, LDIR]) fs.mkdirSync(d, { recursive: true })
try {
  fs.chmodSync(LDIR, 0o700)
} catch {
  /* Windows */
}

// ---------------------------------------------------------------- Helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
function fsyncPath(p) {
  try {
    const fd = fs.openSync(p, 'r')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
  } catch {
    /* directories cannot be fsynced on Windows */
  }
}
function writeJsonAtomic(f, data) {
  const tmp = `${f}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  fs.writeSync(fd, JSON.stringify(data, null, 2))
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  fs.renameSync(tmp, f)
  fsyncPath(path.dirname(f))
}
const rm = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (e) {
    log(`Could not delete ${p}: ${e.message}`)
  }
}
const within = (root, p) => {
  const r = path.resolve(root)
  const x = path.resolve(p)
  return x === r || x.startsWith(r + path.sep)
}

function log(msg) {
  const line = `${new Date().toISOString()} ${HELPER_JOB ? '[helper] ' : ''}${msg}`
  console.log(`[launcher] ${msg}`)
  try {
    if (fs.existsSync(UPDATE_LOG) && fs.statSync(UPDATE_LOG).size > 2 * 1024 * 1024) fs.renameSync(UPDATE_LOG, `${UPDATE_LOG}.1`)
    fs.appendFileSync(UPDATE_LOG, line + '\n')
  } catch {
    /* ignore */
  }
}

/** The app takes over audit events into its audit log on the next start/tick (the launcher has no DB). */
function auditQueue(action, { status = 'ok', details = {}, target } = {}) {
  try {
    fs.appendFileSync(AUDIT_QUEUE, JSON.stringify({ at: new Date().toISOString(), action, status, details, target }) + '\n')
  } catch {
    /* ignore */
  }
}

class JobError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

let publicKey = null
let keyError = null
try {
  const text = env.UPDATE_PUBLIC_KEY || (fs.existsSync(path.join(HERE, 'update-key.pub')) ? fs.readFileSync(path.join(HERE, 'update-key.pub'), 'utf8') : '')
  publicKey = loadPublicKey(text)
  if (publicKey && publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key')
} catch (e) {
  publicKey = null
  keyError = e.message
}

const CONTROL_TOKEN = randomBytes(32).toString('base64url')
const RECOVERY_TOKEN = randomBytes(18).toString('base64url')
const BOOT_ID = randomBytes(6).toString('hex')

// ---------------------------------------------------------------- State

const S = {
  state: 'starting', // starting | idle | updating | restoring | failed
  message: '',
  step: null,
  progress: null,
  target_version: null,
  maintenance: false,
  appUp: false,
  active: null, // { version, dir, source }
  job: null,
  selfId: env.WISHY_CONTAINER_ID || 'local',
  docker: { available: false, reason: 'not_checked' },
}

const lastResult = () => readJson(RESULT_FILE)
function setResult(r) {
  try {
    writeJsonAtomic(RESULT_FILE, { ...r, finished_at: new Date().toISOString() })
  } catch {
    /* ignore */
  }
}

function setMaintenance(on, state) {
  S.maintenance = on
  try {
    if (on) writeJsonAtomic(MAINT_FILE, { on: true, state, by: 'launcher', since: new Date().toISOString() })
    else {
      const m = readJson(MAINT_FILE)
      if (m && m.by === 'launcher') fs.rmSync(MAINT_FILE, { force: true })
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- Docker (optional)

let docker = null
let dockerCheckedAt = 0
async function refreshDocker(force = false) {
  if (!force && Date.now() - dockerCheckedAt < 60_000) return S.docker
  dockerCheckedAt = Date.now()
  if (env.WISHY_IMAGE_UPDATES === 'off') return (S.docker = { available: false, reason: 'disabled' })
  const t = dockerTarget(env)
  if (!t) return (S.docker = { available: false, reason: 'no_socket' })
  if (t.error) return (S.docker = { available: false, reason: t.error, endpoint: t.label })
  try {
    const d = new Docker(t)
    const v = await d.connect()
    const self = await findSelf(d, env)
    if (!self) return (S.docker = { available: false, reason: 'self_not_found', api_version: v.api_version, endpoint: t.label })
    const img = await d.inspectImage(self.Image).catch(() => null)
    docker = d
    S.selfId = self.Id
    S.docker = {
      available: true,
      reason: null,
      endpoint: t.label,
      api_version: v.api_version,
      server_version: v.server_version,
      arch: v.arch,
      self: { id: self.Id, name: String(self.Name || '').replace(/^\//, ''), image: self.Config?.Image || null, image_id: self.Image, digest: img?.RepoDigests?.[0]?.split('@')[1] || null, repo_digests: img?.RepoDigests || [] },
      compose: composeInfo(self),
    }
  } catch (e) {
    S.docker = { available: false, reason: e.code === 'forbidden' ? 'docker_forbidden' : e.code || 'docker_unreachable', message: e.message, endpoint: t.label }
  }
  return S.docker
}

// ---------------------------------------------------------------- Releases + provenance

/** A release installed by the launcher must match its signed archive again on EVERY start. */
const verifiedCache = new Map()
async function verifyInstalled(dir) {
  const version = path.basename(dir)
  const tar = `${dir}.tar.gz`
  if (!publicKey || !fs.existsSync(tar) || !fs.existsSync(`${tar}.sig`)) return 'No signed archive available for the release'
  const st = fs.statSync(tar)
  const key = `${dir}:${st.mtimeMs}:${st.size}`
  if (verifiedCache.get(dir) === key) return null
  const sha = await sha256File(tar)
  if (!verifyRelease(publicKey, artifactName(version), sha, fs.readFileSync(`${tar}.sig`, 'utf8'))) return 'Signature of the installed archive invalid'
  const expected = new Set()
  let mismatch = null
  const parser = new TarParser({
    maxEntries: 200_000,
    maxTotal: 2 * 1024 ** 3,
    maxEntrySize: 512 * 1024 ** 2,
    onEntry(e) {
      expected.add(e.name)
      if (e.type === 'dir') return null
      const h = createHash('sha256')
      return {
        write: (b) => h.update(b),
        end: () => {
          const p = path.join(dir, ...e.name.split('/'))
          let disk = null
          try {
            disk = createHash('sha256').update(fs.readFileSync(p)).digest('hex')
          } catch {
            /* missing */
          }
          if (disk !== h.digest('hex')) mismatch ||= e.name
        },
      }
    },
  })
  try {
    await pipeline(fs.createReadStream(tar), createGunzip(), async (src) => {
      for await (const c of src) parser.push(c)
    })
    parser.finish()
  } catch (e) {
    return `Archive unreadable: ${e.message}`
  }
  if (mismatch) return `File modified: ${mismatch}`
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (!expected.has(r)) return r
      if (ent.isDirectory()) {
        const x = walk(path.join(d, ent.name), r)
        if (x) return x
      }
    }
    return null
  }
  const extra = walk(dir, '')
  if (extra) return `Foreign file in the release: ${extra}`
  verifiedCache.set(dir, key)
  return null
}

async function loadRelease(p, v) {
  if (!p || !within(RELEASES, p) || path.dirname(path.resolve(p)) !== path.resolve(RELEASES)) return null
  const info = readReleaseInfo(path.resolve(p))
  if (!info || info.version !== v || compatProblems(info).length) return null
  const err = await verifyInstalled(path.resolve(p))
  if (err) {
    log(`Release ${v} will not be started: ${err}`)
    return null
  }
  return { ...info, source: 'release' }
}

async function currentInfo() {
  const cur = readJson(CURRENT)
  if (!cur?.version || !cur.path) return { cur: null, rel: null, prev: null }
  return { cur, rel: await loadRelease(cur.path, cur.version), prev: cur.previous?.path ? await loadRelease(cur.previous.path, cur.previous.version) : null }
}

function baselineInfo() {
  const b = readReleaseInfo(BASELINE_DIR)
  return b && !compatProblems(b).length ? { ...b, source: 'baseline' } : null
}

/** Newest valid one of {activated release, baseline}; the baseline wins on a tie. */
async function chooseRelease(exclude = null) {
  const { rel, prev } = await currentInfo()
  const base = baselineInfo()
  const list = [base, rel, exclude ? prev : null].filter((x) => x && (!exclude || path.resolve(x.dir) !== path.resolve(exclude.dir)))
  list.sort((a, b) => compareSemver(b.version, a.version) || (a.source === 'baseline' ? -1 : 1))
  return list[0] || null
}

function writeCurrent(rel, previous, extra = {}) {
  writeJsonAtomic(CURRENT, {
    version: rel.version,
    path: rel.dir,
    activated_at: new Date().toISOString(),
    previous: previous && previous.source === 'release' ? { version: previous.version, path: previous.dir } : previous ? { version: previous.version, path: null, source: 'baseline' } : null,
    proven: false,
    ...extra,
  })
}

async function pruneReleases() {
  const cur = readJson(CURRENT)
  const keep = new Set([cur?.path, cur?.previous?.path, S.active?.dir].filter(Boolean).map((p) => path.resolve(p)))
  for (const name of fs.readdirSync(RELEASES)) {
    const p = path.resolve(RELEASES, name)
    const base = p.replace(/\.tar\.gz(\.sig|\.sha256)?$/, '')
    if (!keep.has(base)) {
      log(`Removing old release item ${name}`)
      rm(p)
    }
  }
}

/** Remove leftovers of aborted operations (only without a running job). */
function pruneOrphans() {
  for (const n of fs.readdirSync(RELEASES)) if (n.startsWith('.tmp-')) rm(path.join(RELEASES, n))
  for (const n of fs.readdirSync(DOWNLOADS)) rm(path.join(DOWNLOADS, n))
}

// ---------------------------------------------------------------- Child process

let child = null
let wantRunning = false
let crashes = []
let restartTimer = null
let provenTimer = null
const stderrTail = []

function startChild(rel) {
  clearTimeout(restartTimer)
  wantRunning = true
  S.active = rel
  S.appUp = false
  writeJsonAtomic(TOKEN_FILE, { token: CONTROL_TOKEN, boot: BOOT_ID })
  const childEnv = {
    ...env,
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    DATA_DIR,
    WISHY_SUPERVISED: '1',
    WISHY_LAUNCHER_HOP: '1',
    WISHY_LAUNCHER_VERSION: String(LAUNCHER_VERSION),
    WISHY_RELEASE_SOURCE: rel.source,
    WISHY_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
    WISHY_CONTROL_TOKEN_FILE: TOKEN_FILE,
  }
  for (const k of ['UPDATE_PUBLIC_KEY', 'APP_PORT', 'WISHY_CONTROL_TOKEN', 'DOCKER_HOST', 'DOCKER_REGISTRY_AUTH']) delete childEnv[k]
  log(`Starting Wishy ${rel.version} (${rel.source}) from ${rel.dir}`)
  const c = spawn(process.execPath, [path.join(rel.dir, 'server', 'index.js')], { cwd: rel.dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  child = c
  c.stdout.on('data', (d) => process.stdout.write(d))
  c.stderr.on('data', (d) => {
    process.stderr.write(d)
    stderrTail.push(...String(d).split('\n').filter(Boolean))
    if (stderrTail.length > 40) stderrTail.splice(0, stderrTail.length - 40)
  })
  c.on('exit', (code, signal) => onChildExit(c, code, signal))
  c.on('error', (e) => log(`Child process error: ${e.message}`))
  writeStatus()
  return c
}

const lastError = () => stderrTail.slice(-5).join(' | ').slice(0, 600)

async function onChildExit(c, code, signal) {
  if (child !== c) return
  child = null
  S.appUp = false
  clearTimeout(provenTimer)
  c.emit('stopped', code)
  writeStatus()
  if (!wantRunning || S.job) return
  if (code === EXIT_RESTART) {
    log('App requested a restart')
    return startChild(S.active)
  }
  if (code === EXIT_SCHEMA_NEWER) {
    wantRunning = false
    S.state = 'failed'
    S.message = 'schema_newer'
    log(`Wishy ${S.active?.version} refuses to start: the database comes from a newer schema. Emergency view: /__launcher/recovery`)
    setResult({ ok: false, code: 'schema_newer', version: S.active?.version, reason: 'Database is newer than this version - start a newer image or restore the pre-update backup' })
    return
  }
  const now = Date.now()
  crashes = crashes.filter((t) => now - t < 120_000)
  crashes.push(now)
  log(`App exited (code ${code ?? '-'}, signal ${signal ?? '-'}), ${crashes.length} crashes in 2 min`)
  if (crashes.length >= 5) {
    crashes = []
    const fallback = S.active?.source === 'release' ? await chooseRelease(S.active) : null
    if (fallback) {
      const cur = readJson(CURRENT) || {}
      const result = { ok: false, code: 'crash_loop', version: S.active.version, fallback_version: fallback.version, reason: lastError(), db_restored: false }
      log(`Crash loop in ${S.active.version} - falling back to ${fallback.version} (${fallback.source})`)
      // Never proven (just activated) and a backup from exactly the fallback version exists -> roll the DB back
      if (!cur.proven && cur.pre_update_backup && fs.existsSync(cur.pre_update_backup) && cur.previous?.version === fallback.version) {
        try {
          await runCli(fallback.dir, ['stage-restore', cur.pre_update_backup, '--db-only'])
          result.db_restored = true
        } catch (e) {
          log(`Database could not be rolled back: ${e.message}`)
        }
      }
      auditQueue('update.crash_loop_fallback', { status: 'fail', details: result })
      setResult(result)
      if (fallback.source === 'release') writeCurrent(fallback, null, { proven: true })
      else fs.rmSync(CURRENT, { force: true })
      return startChild(fallback)
    }
    S.state = 'failed'
    S.message = 'crash_loop'
  }
  const delay = Math.min(60_000, 1000 * 2 ** Math.min(6, crashes.length - 1))
  restartTimer = setTimeout(() => wantRunning && !child && startChild(S.active), delay)
}

async function stopChild(timeout = 15_000) {
  wantRunning = false
  clearTimeout(restartTimer)
  const c = child
  if (!c) return
  S.appUp = false
  const done = new Promise((r) => c.once('stopped', r))
  c.kill('SIGTERM')
  const t = setTimeout(() => c.kill('SIGKILL'), timeout)
  await done
  clearTimeout(t)
  await sleep(300) // Windows: let file handles be released
}

function getJson(p, timeout = 3000) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: APP_PORT, path: p, timeout, headers: { accept: 'application/json' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body.length < 65536 ? (body += d) : null))
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(body)
        } catch {
          /* ignore */
        }
        resolve({ status: res.statusCode, json })
      })
    })
    r.on('error', () => resolve({ status: 0, json: null }))
    r.on('timeout', () => r.destroy())
  })
}

/** Waits for /healthz (+ app version) and /readyz. Aborts if the child exits. */
async function waitHealthy(timeout, expectVersion) {
  const c = child
  const end = Date.now() + timeout
  let exitCode
  let exited = false
  c?.once('stopped', (code) => {
    exited = true
    exitCode = code
  })
  while (Date.now() < end) {
    if (!c || exited || child !== c) {
      if (exitCode === EXIT_SCHEMA_NEWER) throw new JobError('schema_newer', 'App refuses to start: database from a newer schema')
      throw new JobError('start_failed', `App crashed during startup: ${lastError() || 'no output'}`)
    }
    const h = await getJson('/healthz')
    if (h.status === 200 && h.json?.status === 'ok') {
      if (expectVersion && h.json.version !== expectVersion) throw new JobError('version_mismatch', `App reports version ${h.json.version}, expected ${expectVersion}`)
      const r = await getJson('/readyz')
      if (r.status === 200) {
        await sleep(2000)
        if (child !== c || exited) throw new JobError('start_failed', `App crashed shortly after startup: ${lastError()}`)
        return h.json
      }
    }
    await sleep(500)
  }
  throw new JobError('health_timeout', `App did not become healthy within ${Math.round(timeout / 1000)} s`)
}

function markUp() {
  S.appUp = true
  if (!S.job && (S.state !== 'failed' || ['crash_loop', 'not_healthy'].includes(S.message))) {
    S.state = 'idle'
    S.message = ''
  }
  setTimeout(() => (crashes = []), 120_000).unref()
  clearTimeout(provenTimer)
  // If an activated release runs stably for long enough, it counts as proven (no more automatic DB rollback)
  provenTimer = setTimeout(() => {
    const cur = readJson(CURRENT)
    if (S.appUp && cur && !cur.proven && S.active?.source === 'release' && path.resolve(cur.path) === path.resolve(S.active.dir)) {
      writeJsonAtomic(CURRENT, { ...cur, proven: true })
    }
  }, PROVEN_MS)
  provenTimer.unref?.()
  writeStatus()
}

// Background: mark the app as ready after a (re)start
if (!HELPER_JOB) {
  setInterval(async () => {
    if (S.job || !child || S.appUp) return
    const c = child
    const h = await getJson('/healthz', 1500)
    if (child === c && !S.job && h.status === 200 && h.json?.status === 'ok') markUp()
  }, 1000).unref()
}

/** State file for the helper container (it only sees the shared volume). */
function writeStatus() {
  if (HELPER_JOB) return
  try {
    writeJsonAtomic(path.join(LDIR, `status-${S.selfId}.json`), {
      container_id: S.selfId,
      boot: BOOT_ID,
      pid: process.pid,
      app_up: S.appUp,
      version: S.active?.version ?? null,
      state: S.state,
      at: new Date().toISOString(),
    })
  } catch {
    /* ignore */
  }
}
if (!HELPER_JOB) setInterval(writeStatus, 2000).unref()

// ---------------------------------------------------------------- App CLI (backup / restore preparation)

function runCli(dir, args, extraEnv = {}, timeout = 30 * 60_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(dir, 'server', 'wishy-cli.js'), ...args], {
      cwd: dir,
      env: { ...env, DATA_DIR, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    const t = setTimeout(() => p.kill('SIGKILL'), timeout)
    p.on('error', (e) => reject(e))
    p.on('exit', (code) => {
      clearTimeout(t)
      const last = out.trim().split('\n').pop()
      let json = null
      try {
        json = JSON.parse(last)
      } catch {
        /* ignore */
      }
      if (code === 0 && json?.ok) resolve(json)
      else reject(new Error(json?.error || err.trim().split('\n').slice(-3).join(' | ') || `wishy-cli code ${code}`))
    })
  })
}

// ---------------------------------------------------------------- Jobs

const APP_STEPS = ['preflight', 'download', 'verify', 'extract', 'stop', 'backup', 'start', 'health', 'activate']
const IMAGE_STEPS = ['preflight', 'metadata', 'pull', 'stop', 'backup', 'handover', 'swap', 'start', 'health', 'activate']

function newJob(kind, version, steps) {
  const job = { id: randomBytes(6).toString('hex'), kind, version, from_version: S.active?.version, started_at: new Date().toISOString(), steps: steps.map((id) => ({ id, status: 'pending' })), phase: null }
  S.job = job
  S.target_version = version
  return job
}

function persistJob(extra = {}) {
  const j = S.job
  if (!j) return
  Object.assign(j, extra)
  const { steps, ...rest } = j
  writeJsonAtomic(JOB_FILE, { ...rest, steps })
}

async function step(id, fn) {
  const j = S.job
  let s = j.steps.find((x) => x.id === id)
  if (!s) j.steps.push((s = { id, status: 'pending' }))
  s.status = 'running'
  s.started_at = new Date().toISOString()
  S.step = id
  j.phase = id
  const idx = j.steps.indexOf(s)
  S.progress = idx / j.steps.length
  persistJob()
  log(`[${j.kind} ${j.version ?? ''}] Step ${id} ...`)
  try {
    const r = await fn(s)
    s.status = 'done'
    s.finished_at = new Date().toISOString()
    S.progress = (idx + 1) / j.steps.length
    persistJob()
    log(`[${j.kind} ${j.version ?? ''}] Step ${id} ok${s.detail ? ` (${s.detail})` : ''}`)
    auditQueue(`${j.kind === 'restore' ? 'restore' : 'update'}.step`, { details: { job: j.id, kind: j.kind, step: id, version: j.version, detail: s.detail } })
    return r
  } catch (e) {
    s.status = 'failed'
    s.finished_at = new Date().toISOString()
    s.detail = e.message
    persistJob()
    log(`[${j.kind} ${j.version ?? ''}] Step ${id} FAILED: ${e.code || ''} ${e.message}`)
    auditQueue(`${j.kind === 'restore' ? 'restore' : 'update'}.step`, { status: 'fail', details: { job: j.id, kind: j.kind, step: id, version: j.version, code: e.code, error: e.message } })
    throw e
  }
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return Infinity
  }
}
function pathSize(p) {
  try {
    const st = fs.statSync(p)
    if (!st.isDirectory()) return st.size
    let n = 0
    for (const e of fs.readdirSync(p)) n += pathSize(path.join(p, e))
    return n
  } catch {
    return 0
  }
}
const dataSize = () => ['wishlist.db', 'wishlist.db-wal', 'images', 'avatars'].reduce((n, f) => n + pathSize(path.join(DATA_DIR, f)), 0)

/** Load signed release metadata (if present). Unsigned metadata only counts as a hint. */
async function loadMeta(req) {
  const a = req.assets || {}
  if (!a.release_json?.url) return { meta: null, signed: false }
  const text = await fetchText(a.release_json.url, { maxBytes: 512 * 1024 })
  if (!a.release_json_sig?.url) {
    try {
      return { meta: JSON.parse(text), signed: false }
    } catch {
      return { meta: null, signed: false }
    }
  }
  const sig = await fetchText(a.release_json_sig.url, { maxBytes: 4096 })
  return { meta: verifyReleaseMeta(publicKey, req.version, text, sig), signed: true }
}

/** Preflight check (can also be called on its own via the control channel). */
async function preflight(req) {
  const problems = []
  const warnings = []
  const mode = req.mode === 'image' ? 'image' : 'app'
  if (!publicKey) problems.push({ code: 'no_update_key', message: keyError || 'No public update key in the image' })
  if (!validVersion(req.version)) problems.push({ code: 'invalid_version' })
  let meta = null
  try {
    const m = await loadMeta(req)
    meta = m.signed ? m.meta : null
    if (m.meta && !m.signed) warnings.push({ code: 'meta_unsigned', message: 'release.json without signature - used as a hint only' })
  } catch (e) {
    problems.push({ code: e.code || 'metadata_failed', message: e.message })
  }
  const need = dataSize() * 2 + 200 * 1024 * 1024 + (mode === 'app' ? (Number(req.assets?.tarball?.size) || 100 * 1024 * 1024) * 4 : 0)
  const free = freeBytes(DATA_DIR)
  if (free < need) problems.push({ code: 'insufficient_disk', message: `Not enough free disk space (${Math.round(free / 1e6)} MB, need ~${Math.round(need / 1e6)} MB for backup + rollback)` })
  if (mode === 'app') {
    if (S.active && validVersion(req.version) && compareSemver(req.version, S.active.version) <= 0) problems.push({ code: 'not_newer', message: `${req.version} is not newer than the running ${S.active.version}` })
    if (!req.assets?.tarball?.url || !req.assets?.sha256?.url || !req.assets?.sig?.url) problems.push({ code: 'artifact_missing', message: 'Release contains no app archive (tar.gz, .sha256, .sig)' })
    if (Number(req.assets?.tarball?.size || 0) > MAX_ARTIFACT) problems.push({ code: 'artifact_too_large' })
    if (meta) for (const p of compatProblems({ min_launcher: Number(meta.min_launcher || 1), node: Number(meta.node || 0) })) problems.push({ ...p, code: 'image_update_required', reason: p.code })
  } else {
    const d = await refreshDocker(true)
    if (!d.available) problems.push({ code: 'docker_unavailable', message: `No access to the Docker API (${d.reason})` })
    if (!meta) problems.push({ code: 'metadata_missing', message: 'Signed release metadata (release.json + .sig) is missing' })
    else if (!meta.image) problems.push({ code: 'no_image', message: 'This release contains no image' })
    else if (d.self?.repo_digests?.includes(imageRef(meta.image))) problems.push({ code: 'not_newer', message: 'This image is already running' })
    const base = baselineInfo()
    if (base && validVersion(req.version) && compareSemver(req.version, base.version) <= 0) problems.push({ code: 'not_newer', message: `${req.version} is not newer than the running image ${base.version}` })
    if (S.active && validVersion(req.version) && compareSemver(req.version, S.active.version) < 0) problems.push({ code: 'app_downgrade', message: 'The image contains an older app than the running one' })
  }
  return { problems, warnings, meta }
}

// ----- App update (archive)

async function runUpdate(req) {
  const job = newJob('update', req.version, APP_STEPS)
  job.mode = 'app'
  const old = S.active
  job.from = old ? { version: old.version, dir: old.dir, source: old.source } : null
  S.state = 'updating'
  S.message = ''
  auditQueue('update.start', { details: { mode: 'app', version: req.version, from: old?.version, actor: req.actor || null } })
  const dlDir = path.join(DOWNLOADS, req.version.replace('+', '-'))
  const name = artifactName(req.version)
  const tarFile = path.join(dlDir, name)
  let extracted = null
  let installed = null
  let childStopped = false
  let switched = false
  try {
    let verifiedSha = null
    await step('preflight', async () => {
      const { problems } = await preflight(req)
      if (problems.length) {
        const p = problems.find((x) => x.code === 'image_update_required') || problems[0]
        throw new JobError(p.code, p.message || p.code, { problems })
      }
    })
    await step('download', async (s) => {
      rm(dlDir)
      fs.mkdirSync(dlDir, { recursive: true })
      fs.writeFileSync(`${tarFile}.sha256`, await fetchText(req.assets.sha256.url, { maxBytes: 4096 }))
      fs.writeFileSync(`${tarFile}.sig`, await fetchText(req.assets.sig.url, { maxBytes: 4096 }))
      const r = await downloadFile(req.assets.tarball.url, tarFile, {
        maxBytes: MAX_ARTIFACT,
        onProgress: (got, total) => {
          s.detail = total ? `${Math.round((got / total) * 100)} %` : `${Math.round(got / 1e6)} MB`
          if (total) S.progress = (1 + got / total) / job.steps.length
        },
      })
      s.detail = `${Math.round(r.bytes / 1e5) / 10} MB`
    })
    await step('verify', async () => {
      const expected = parseSha256File(fs.readFileSync(`${tarFile}.sha256`, 'utf8'))
      const actual = await sha256File(tarFile)
      if (!expected || expected !== actual) throw new JobError('sha256_mismatch', 'Checksum (SHA-256) mismatch')
      if (!verifyRelease(publicKey, name, actual, fs.readFileSync(`${tarFile}.sig`, 'utf8'))) throw new JobError('signature_invalid', 'Signature invalid - update will not be installed')
      verifiedSha = actual
    })
    await step('extract', async () => {
      extracted = path.join(RELEASES, `.tmp-${req.version.replace('+', '-')}-${randomBytes(4).toString('hex')}`)
      const h = createHash('sha256')
      const tee = new Transform({
        transform(c, _e, cb) {
          h.update(c)
          cb(null, c)
        },
      })
      try {
        await extractTar(fs.createReadStream(tarFile).pipe(tee), extracted, { maxTotal: 2 * 1024 ** 3, maxEntries: 200_000, maxEntrySize: 512 * 1024 ** 2 })
      } catch (e) {
        throw new JobError('release_invalid', `Archive rejected: ${e.message}`, { tar_code: e.code })
      }
      if (h.digest('hex') !== verifiedSha) throw new JobError('sha256_mismatch', 'Archive changed between verification and unpacking')
      const info = readReleaseInfo(extracted)
      if (!info || info.version !== req.version || !fs.existsSync(path.join(extracted, 'release.json'))) throw new JobError('release_invalid', 'release.json is missing or does not match the version')
      if (!fs.existsSync(path.join(extracted, 'server', 'wishy-cli.js'))) throw new JobError('release_invalid', 'Release is incomplete')
      const problems = compatProblems(info)
      if (problems.length) throw new JobError('image_update_required', 'This update requires a newer Docker image', { problems })
      const final = path.join(RELEASES, req.version)
      if (old && path.resolve(old.dir) === path.resolve(final)) throw new JobError('release_invalid', 'Version is already running')
      for (const p of [final, `${final}.tar.gz`, `${final}.tar.gz.sig`, `${final}.tar.gz.sha256`]) rm(p)
      fs.renameSync(extracted, final)
      extracted = null
      // Keep the signed archive as proof of provenance (checked on every start)
      fs.renameSync(tarFile, `${final}.tar.gz`)
      fs.renameSync(`${tarFile}.sig`, `${final}.tar.gz.sig`)
      fs.renameSync(`${tarFile}.sha256`, `${final}.tar.gz.sha256`)
      verifiedCache.delete(final)
      installed = { ...info, dir: final, source: 'release' }
      if (await verifyInstalled(final)) throw new JobError('release_invalid', 'Installed release does not match the archive')
    })
    setMaintenance(true, 'updating')
    await step('stop', async () => {
      await stopChild()
      childStopped = true
    })
    await step('backup', async (s) => {
      if (!old) return (s.detail = 'skipped')
      const r = await runCli(old.dir, ['pre-update', '--target', req.version, '--job', job.id], req.keep_session ? { WISHY_KEEP_SESSION: req.keep_session } : {})
      job.backup_file = r.file
      s.detail = path.basename(r.file)
      persistJob()
    })
    switched = true
    persistJob({ switched: true })
    await step('start', async () => {
      crashes = []
      startChild(installed)
    })
    await step('health', async (s) => {
      const h = await waitHealthy(HEALTH_TIMEOUT, installed.version)
      s.detail = `version ${h.version}`
    })
    await step('activate', async () => {
      writeCurrent(installed, old, { pre_update_backup: job.backup_file || null })
      S.active = installed
      markUp()
      await pruneReleases()
      rm(dlDir)
    })
    setResult({ ok: true, mode: 'app', version: req.version, from_version: old?.version, job: job.id })
    auditQueue('update.success', { details: { mode: 'app', version: req.version, from: old?.version } })
    log(`Update to ${req.version} succeeded`)
  } catch (e) {
    const result = { ok: false, mode: 'app', version: req.version, from_version: old?.version, job: job.id, code: e.code || 'update_failed', reason: e.message, rolled_back: false, db_restored: false }
    if (e.problems) result.problems = e.problems
    if (switched) await rollbackApp(job, old, result)
    else if (childStopped && old) {
      startChild(old)
      await waitHealthy(HEALTH_TIMEOUT).then(markUp).catch(() => {})
      result.rolled_back = true
    }
    if (installed && (!S.active || path.resolve(S.active.dir) !== path.resolve(installed.dir))) for (const p of [installed.dir, `${installed.dir}.tar.gz`, `${installed.dir}.tar.gz.sig`, `${installed.dir}.tar.gz.sha256`]) rm(p)
    if (extracted) rm(extracted)
    rm(dlDir)
    setResult(result)
    auditQueue('update.failed', { status: 'fail', details: { mode: 'app', version: req.version, code: result.code, reason: result.reason, rolled_back: result.rolled_back, db_restored: result.db_restored } })
    log(`Update to ${req.version} failed: ${result.code} - ${result.reason}`)
  } finally {
    endJob()
  }
}

/**
 * Rollback after switching: stop the new version, restore the DB from the pre-update backup (database only - images
 * stay, saves space), start the old version. If the restore fails, NO old version is started on the
 * migrated DB (state failed, emergency view).
 */
async function rollbackApp(job, old, result) {
  try {
    await step('rollback', async (s) => {
      await stopChild()
      if (job.backup_file) {
        await runCli(old.dir, ['stage-restore', job.backup_file, '--db-only'])
        result.db_restored = true
      }
      persistJob({ db_restored: result.db_restored })
      startChild(old)
      await waitHealthy(HEALTH_TIMEOUT)
      markUp()
      result.rolled_back = true
      s.detail = `back to ${old.version}${result.db_restored ? ', database restored' : ''}`
    })
  } catch (re) {
    result.rollback_error = re.message
    result.code = 'rollback_failed'
    log(`Rollback failed: ${re.message} - app stays stopped, emergency view /__launcher/recovery`)
    await stopChild()
    wantRunning = false
  }
}

function endJob() {
  S.job = null
  S.step = null
  S.progress = null
  S.target_version = null
  setMaintenance(false)
  rm(JOB_FILE)
  S.state = child ? (S.appUp ? 'idle' : 'starting') : 'failed'
  if (!child) S.message ||= 'rollback_failed'
  writeStatus()
}

// ----- Image update (Docker): this process prepares, the helper container swaps

async function runImageUpdate(req) {
  const job = newJob('image', req.version, IMAGE_STEPS)
  job.mode = 'image'
  const old = S.active
  job.from = old ? { version: old.version, dir: old.dir, source: old.source } : null
  S.state = 'updating'
  auditQueue('update.start', { details: { mode: 'image', version: req.version, from: old?.version, actor: req.actor || null } })
  let childStopped = false
  let handedOver = false
  try {
    let meta
    await step('preflight', async () => {
      const r = await preflight({ ...req, mode: 'image' })
      if (r.problems.length) throw new JobError(r.problems[0].code, r.problems[0].message || r.problems[0].code, { problems: r.problems })
      meta = r.meta
    })
    await step('metadata', async (s) => {
      s.detail = `${meta.image.repository}@${meta.image.digest.slice(0, 19)}…`
      job.image = { ...meta.image, ref: imageRef(meta.image) }
    })
    await step('pull', async (s) => {
      const pulled = await docker.pullByDigest(meta.image.repository, meta.image.digest, (p) => {
        if (p.status && p.progressDetail?.total) s.detail = `${p.status} ${Math.round((p.progressDetail.current / p.progressDetail.total) * 100)} %`
      })
      const img = await docker.inspectImage(job.image.ref)
      if (!img || !(img.RepoDigests || []).includes(job.image.ref) || (pulled.reported_digest && pulled.reported_digest !== meta.image.digest)) {
        const wrong = img || (pulled.reported_digest ? await docker.inspectImage(`${meta.image.repository}@${pulled.reported_digest}`).catch(() => null) : null)
        if (wrong) await docker.removeImage(wrong.Id).catch(() => {})
        throw new JobError('digest_mismatch', 'Pulled image does not match the signed digest')
      }
      job.image.id = img.Id
      s.detail = img.Id.slice(0, 19)
    })
    const self = await docker.inspectContainer(S.docker.self.id)
    if (!self) throw new JobError('docker_unavailable', 'Own container can no longer be found')
    job.old = { id: self.Id, name: String(self.Name).replace(/^\//, ''), image_id: self.Image }
    setMaintenance(true, 'updating')
    await step('stop', async () => {
      await stopChild()
      childStopped = true
    })
    await step('backup', async (s) => {
      const r = await runCli(old.dir, ['pre-update', '--target', req.version, '--job', job.id], req.keep_session ? { WISHY_KEEP_SESSION: req.keep_session } : {})
      job.backup_file = r.file
      s.detail = path.basename(r.file)
    })
    await step('handover', async (s) => {
      const helperName = `${job.old.name}-updater-${job.id}`
      const H = self.HostConfig || {}
      const nets = Object.keys(self.NetworkSettings?.Networks || {})
      const body = {
        Image: job.image.ref,
        Cmd: ['--self-replace', job.id],
        Env: (self.Config?.Env || []).filter((e) => !/^(PORT|HOSTNAME)=/.test(e)).concat([`WISHY_PARENT_CONTAINER=${job.old.id}`]),
        Labels: { 'wishy.role': 'updater', 'wishy.update.job': job.id },
        User: self.Config?.User || undefined,
        HostConfig: {
          Binds: H.Binds,
          Mounts: H.Mounts,
          NetworkMode: H.NetworkMode,
          GroupAdd: H.GroupAdd,
          SecurityOpt: H.SecurityOpt,
          CapDrop: H.CapDrop,
          CapAdd: H.CapAdd,
          ExtraHosts: H.ExtraHosts,
          // No AutoRemove: if the helper crashes, Docker restarts it and it resumes from the journal; at the end it deletes itself
          RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
        },
      }
      if (nets.length && !['host', 'none'].includes(String(H.NetworkMode)) && !String(H.NetworkMode || '').startsWith('container:')) {
        const primary = nets.includes(H.NetworkMode) ? H.NetworkMode : nets[0]
        body.NetworkingConfig = { EndpointsConfig: { [primary]: {} } }
      }
      job.phase = 'handover'
      job.handover = true
      persistJob()
      const id = await docker.createContainer(helperName, body)
      job.helper_id = id
      persistJob()
      // All other networks of the old container (e.g. internal network to the socket proxy)
      for (const n of nets) if (!body.NetworkingConfig?.EndpointsConfig?.[n] && !['host', 'none'].includes(String(H.NetworkMode))) await docker.connectNetwork(n, id, {})
      await docker.startContainer(id)
      handedOver = true
      s.detail = helperName
    })
    S.step = 'swap'
    log(`Handing over to the helper container - this container will be stopped shortly`)
    // We stay in maintenance mode until the helper stops us. No endJob(): the journal now belongs to the helper.
  } catch (e) {
    const result = { ok: false, mode: 'image', version: req.version, from_version: old?.version, job: job.id, code: e.code || 'update_failed', reason: e.message, rolled_back: false, db_restored: false }
    if (e.problems) result.problems = e.problems
    if (job.helper_id && !handedOver) await docker.removeContainer(job.helper_id, { force: true }).catch(() => {})
    if (childStopped && old) {
      startChild(old)
      await waitHealthy(HEALTH_TIMEOUT).then(markUp).catch(() => {})
      result.rolled_back = true
    }
    setResult(result)
    auditQueue('update.failed', { status: 'fail', details: { mode: 'image', version: req.version, code: result.code, reason: result.reason } })
    log(`Image update to ${req.version} failed: ${result.code} - ${result.reason}`)
    endJob()
  }
}

// ----- Restore restart

async function runRestoreRestart({ rollback_backup }) {
  const job = newJob('restore', null, ['stop', 'restore', 'health'])
  job.from = S.active ? { version: S.active.version, dir: S.active.dir, source: S.active.source } : null
  S.state = 'restoring'
  setMaintenance(true, 'restoring')
  const rel = S.active
  try {
    await step('stop', () => stopChild())
    await step('restore', async () => {
      crashes = []
      startChild(rel)
    })
    await step('health', async () => {
      await waitHealthy(HEALTH_TIMEOUT)
      markUp()
    })
    setResult({ ok: true, kind: 'restore', job: job.id })
  } catch (e) {
    const result = { ok: false, kind: 'restore', job: job.id, code: 'restore_failed', reason: e.message, rolled_back: false }
    try {
      if (rollback_backup) {
        await step('rollback', async () => {
          await stopChild()
          await runCli(rel.dir, ['stage-restore', rollback_backup])
          startChild(rel)
          await waitHealthy(HEALTH_TIMEOUT)
          markUp()
          result.rolled_back = true
        })
      }
    } catch (re) {
      result.rollback_error = re.message
      await stopChild()
    }
    setResult(result)
    auditQueue('backup.restore_failed', { status: 'fail', details: result })
  } finally {
    endJob()
  }
}

// ----- Resume after crash/restart

const trustedCodeDir = async (dir) => {
  if (!dir) return null
  if (path.resolve(dir) === BASELINE_DIR) return BASELINE_DIR
  if (path.dirname(path.resolve(dir)) === path.resolve(RELEASES) && !(await verifyInstalled(path.resolve(dir)))) return path.resolve(dir)
  return null
}

async function recoverJob() {
  const j = readJson(JOB_FILE)
  if (!j) return
  log(`Interrupted job found (${j.kind} ${j.version ?? ''}, phase ${j.phase})`)
  if (j.kind === 'image' && j.handover) return recoverImageJob(j)
  const result = { ok: false, mode: j.mode, version: j.version, from_version: j.from?.version, job: j.id, code: 'launcher_interrupted', reason: `Launcher was interrupted in phase "${j.phase}"`, rolled_back: true, db_restored: !!j.db_restored }
  const fromDir = await trustedCodeDir(j.from?.dir)
  // If the new version (or a rollback) has already touched the DB -> restore the backup (idempotent)
  if (j.kind === 'update' && (j.switched || ['start', 'health', 'activate', 'rollback'].includes(j.phase))) {
    const cur = readJson(CURRENT)
    if (j.phase === 'activate' && cur?.version === j.version) {
      Object.assign(result, { ok: true, code: undefined, reason: undefined, rolled_back: false })
    } else {
      if (cur?.version === j.version) fs.rmSync(CURRENT, { force: true })
      if (!j.db_restored && j.backup_file && fs.existsSync(j.backup_file) && fromDir) {
        try {
          await runCli(fromDir, ['stage-restore', j.backup_file, '--db-only'])
          result.db_restored = true
        } catch (e) {
          result.rollback_error = e.message
          result.code = 'rollback_failed'
        }
      } else if (!j.db_restored) {
        result.code = 'rollback_failed'
        result.rollback_error = 'No usable pre-update backup'
      }
    }
  }
  setResult(result)
  auditQueue('update.recovered', { status: result.ok ? 'ok' : 'fail', details: result })
  rm(JOB_FILE)
  const m = readJson(MAINT_FILE)
  if (m?.by === 'launcher') fs.rmSync(MAINT_FILE, { force: true })
  if (result.code === 'rollback_failed') {
    S.state = 'failed'
    S.message = 'rollback_failed'
    return 'hold'
  }
}

/** Image job: the helper is in control. Here only the role of the old container during rollback (DB back). */
async function recoverImageJob(j) {
  await refreshDocker(true)
  const me = S.selfId
  const sideFile = path.join(LDIR, `job-${j.id}-old.json`)
  if (me === j.old?.id && (j.needs_db_restore || String(j.phase).startsWith('rb_')) && !readJson(sideFile)?.db_restored) {
    const fromDir = await trustedCodeDir(j.from?.dir)
    S.target_version = j.version
    let side = { db_restored: false }
    if (j.backup_file && fromDir && j.needs_db_restore) {
      try {
        await runCli(fromDir, ['stage-restore', j.backup_file, '--db-only'])
        side = { db_restored: true }
      } catch (e) {
        side = { db_restored: false, error: e.message }
      }
    }
    writeJsonAtomic(sideFile, { ...side, at: new Date().toISOString() })
    log(`Image update rollback: old container starts again${side.db_restored ? ' (database from pre-update backup)' : ''}`)
  }
  // Orphaned job (helper vanished, older than 2 h): clean up
  if (Date.now() - Date.parse(j.started_at || 0) > 2 * 3_600_000 && docker && j.helper_id && !(await docker.inspectContainer(j.helper_id).catch(() => null))) {
    log('Removed orphaned image job')
    rm(JOB_FILE)
  }
}

// ---------------------------------------------------------------- Helper mode (runs in the NEW image)

async function runHelper(jobId) {
  const t = dockerTarget(env)
  if (!t || t.error) throw new Error('Helper without Docker access')
  docker = new Docker(t)
  await docker.connect()
  const j = readJson(JOB_FILE)
  if (!j || j.id !== jobId) {
    log(`Helper: job ${jobId} no longer exists - exiting`)
    return selfRemove()
  }
  const persist = (extra = {}) => {
    Object.assign(j, extra)
    writeJsonAtomic(JOB_FILE, j)
  }
  const mark = (id, status, detail) => {
    let s = j.steps.find((x) => x.id === id)
    if (!s) j.steps.push((s = { id }))
    Object.assign(s, { status, detail, [status === 'running' ? 'started_at' : 'finished_at']: new Date().toISOString() })
    persist()
  }
  const waitStatus = async (cid, timeout, expectVersion, since = Date.now()) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const st = readJson(path.join(LDIR, `status-${cid}.json`))
      const c = await docker.inspectContainer(cid)
      if (!c || (!c.State?.Running && c.State?.Status !== 'restarting')) {
        if (c?.State?.Status === 'exited') throw new JobError('start_failed', `Container exited (exit ${c.State.ExitCode})`)
      }
      if (st?.app_up && (!expectVersion || st.version === expectVersion) && Date.parse(st.at) > Math.max(since, Date.now() - 10_000)) return st
      await sleep(1000)
    }
    throw new JobError('health_timeout', `Container ${cid.slice(0, 12)} did not become healthy within ${Math.round(timeout / 1000)} s`)
  }
  const name = j.old.name
  const oldName = `${name}-old-${j.id}`
  const result = { ok: false, mode: 'image', version: j.version, from_version: j.from?.version, job: j.id, image: j.image?.ref, rolled_back: false, db_restored: false }
  log(`Helper takes over job ${j.id} (phase ${j.phase})`)
  const forward = !String(j.phase).startsWith('rb_') && j.phase !== 'done'
  if (forward) {
    try {
      if (['handover', 'swap'].includes(j.phase)) {
        persist({ phase: 'swap' })
        mark('swap', 'running')
        const o = await docker.inspectContainer(j.old.id)
        if (!o) throw new JobError('swap_failed', 'Old container not found')
        if (o.State?.Running) await docker.stopContainer(j.old.id, 30)
        if (String(o.Name).replace(/^\//, '') !== oldName) await docker.renameContainer(j.old.id, oldName)
        mark('swap', 'done', `old container -> ${oldName}`)
        persist({ phase: 'create' })
      }
      if (j.phase === 'create') {
        mark('start', 'running')
        let nid = j.new_id && (await docker.inspectContainer(j.new_id)) ? j.new_id : null
        if (!nid) {
          const o = await docker.inspectContainer(j.old.id)
          const oi = await docker.inspectImage(j.old.image_id).catch(() => null)
          const { body, connect } = buildCreatePayload(o, oi, j.image.ref, { 'wishy.update.job': j.id })
          // If an earlier helper run already created the container (name taken), reuse it
          const existing = await docker.inspectContainer(name)
          if (existing && existing.Id !== j.old.id && existing.Config?.Labels?.['wishy.update.job'] === j.id) nid = existing.Id
          else {
            nid = await docker.createContainer(name, body)
            persist({ new_id: nid })
            for (const c of connect) await docker.connectNetwork(c.network, nid, c.endpoint)
          }
          persist({ new_id: nid })
        }
        persist({ phase: 'start_new' })
      }
      if (j.phase === 'start_new') {
        const n = await docker.inspectContainer(j.new_id)
        if (!n?.State?.Running) await docker.startContainer(j.new_id)
        mark('start', 'done')
        persist({ phase: 'health', new_started: true })
      }
      if (j.phase === 'health') {
        mark('health', 'running')
        const st = await waitStatus(j.new_id, SWAP_TIMEOUT, j.version)
        mark('health', 'done', `version ${st.version}`)
        persist({ phase: 'activate' })
      }
      if (j.phase === 'activate') {
        mark('activate', 'running')
        await docker.removeContainer(j.old.id, { force: true }).catch((e) => log(`Old container not removed: ${e.message}`))
        if (j.old.image_id && j.old.image_id !== j.image.id) await docker.removeImage(j.old.image_id).catch(() => {})
        mark('activate', 'done')
        persist({ phase: 'done' })
        Object.assign(result, { ok: true })
        setResult(result)
        auditQueue('update.success', { details: { mode: 'image', version: j.version, from: j.from?.version, image: j.image.ref } })
        log(`Image update to ${j.version} succeeded`)
      }
    } catch (e) {
      log(`Helper: swap failed: ${e.code || ''} ${e.message} - rolling back`)
      persist({ phase: 'rb_remove_new', error: { code: e.code || 'swap_failed', message: e.message }, needs_db_restore: !!j.new_started })
    }
  }
  if (String(j.phase).startsWith('rb_')) {
    Object.assign(result, { code: j.error?.code || 'update_failed', reason: j.error?.message })
    try {
      if (j.phase === 'rb_remove_new') {
        mark('rollback', 'running')
        if (j.new_id) await docker.removeContainer(j.new_id, { force: true }).catch(() => {})
        else {
          const ex = await docker.inspectContainer(name)
          if (ex && ex.Id !== j.old.id && ex.Config?.Labels?.['wishy.update.job'] === j.id) await docker.removeContainer(ex.Id, { force: true })
        }
        persist({ phase: 'rb_start_old' })
      }
      if (j.phase === 'rb_start_old') {
        const o = await docker.inspectContainer(j.old.id)
        if (!o) throw new Error('Old container no longer exists')
        if (String(o.Name).replace(/^\//, '') !== name) await docker.renameContainer(j.old.id, name)
        if (!o.State?.Running) await docker.startContainer(j.old.id)
        persist({ phase: 'rb_wait_old' })
      }
      if (j.phase === 'rb_wait_old') {
        await waitStatus(j.old.id, SWAP_TIMEOUT * 2)
        const side = readJson(path.join(LDIR, `job-${j.id}-old.json`)) || {}
        Object.assign(result, { rolled_back: true, db_restored: !!side.db_restored })
        mark('rollback', 'done', `old container is running again${side.db_restored ? ', database restored' : ''}`)
        persist({ phase: 'done' })
      }
    } catch (re) {
      result.rollback_error = re.message
      result.code = 'rollback_failed'
      log(`Helper: rollback failed: ${re.message}`)
      persist({ phase: 'done' })
    }
    setResult(result)
    auditQueue('update.failed', { status: 'fail', details: { mode: 'image', version: j.version, code: result.code, reason: result.reason, rolled_back: result.rolled_back, db_restored: result.db_restored } })
  }
  if (j.phase === 'done') {
    rm(JOB_FILE)
    rm(path.join(LDIR, `job-${j.id}-old.json`))
    const m = readJson(MAINT_FILE)
    if (m?.by === 'launcher') fs.rmSync(MAINT_FILE, { force: true })
  }
  return selfRemove()
}

async function selfRemove() {
  const me = env.HOSTNAME && (await docker.inspectContainer(env.HOSTNAME).catch(() => null))
  const id = me?.Config?.Labels?.['wishy.role'] === 'updater' ? me.Id : null
  log('Helper exits')
  if (id) await docker.removeContainer(id, { force: true }).catch(() => {})
  process.exit(0)
}

// ---------------------------------------------------------------- Status

function jobView(j) {
  if (!j) return null
  return { id: j.id, kind: j.kind, mode: j.mode || (j.kind === 'image' ? 'image' : j.kind === 'update' ? 'app' : null), version: j.version, from_version: j.from_version || j.from?.version, started_at: j.started_at, phase: j.phase, image: j.image?.ref || null, steps: j.steps || [] }
}
function journalJob() {
  const j = readJson(JOB_FILE)
  return j && j.kind === 'image' && j.handover && j.phase !== 'done' ? j : null
}

function publicStatus() {
  const jj = S.job ? null : journalJob()
  return {
    state: jj ? 'updating' : S.state,
    step: S.step || (jj ? jj.phase : null),
    progress: S.progress === null ? null : Math.round(S.progress * 100) / 100,
    message: S.message,
    version: S.active?.version ?? null,
    target_version: S.target_version || jj?.version || null,
    app_up: S.appUp,
    busy: !!S.job || !!jj,
  }
}

function fullStatus() {
  const cur = readJson(CURRENT)
  const base = baselineInfo()
  return {
    ...publicStatus(),
    launcher_version: LAUNCHER_VERSION,
    node: process.versions.node,
    node_major: NODE_MAJOR,
    active: S.active ? { version: S.active.version, source: S.active.source } : null,
    baseline_version: base?.version ?? null,
    components: base?.components ?? null,
    previous: cur?.previous ? { version: cur.previous.version } : null,
    key_configured: !!publicKey,
    key_error: publicKey ? null : keyError || 'missing',
    docker: S.docker,
    job: jobView(S.job || journalJob()),
    last_result: lastResult(),
    health_timeout_ms: HEALTH_TIMEOUT,
  }
}

// ---------------------------------------------------------------- Control channel (loopback only, token)

function tokenOk(req) {
  const h = String(req.headers.authorization || '')
  const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '')
  const want = Buffer.from(CONTROL_TOKEN)
  return got.length === want.length && timingSafeEqual(got, want)
}
const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'

function sendJson(res, status, data, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
  res.end(JSON.stringify(data))
}

function readBody(req, max = 64 * 1024, raw = false) {
  return new Promise((resolve, reject) => {
    let n = 0
    const parts = []
    req.on('data', (d) => {
      n += d.length
      if (n > max) {
        reject(new Error('too large'))
        req.destroy()
      } else parts.push(d)
    })
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8')
      if (raw) return resolve(text)
      try {
        resolve(n ? JSON.parse(text) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

const control = http.createServer(async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !tokenOk(req)) return sendJson(res, 401, { error: 'unauthorized', code: 'unauthorized' })
  const url = new URL(req.url, 'http://x')
  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      if (url.searchParams.get('docker') === 'refresh') await refreshDocker(true)
      else refreshDocker().catch(() => {})
      return sendJson(res, 200, fullStatus())
    }
    if (req.method === 'POST' && url.pathname === '/preflight') {
      const body = await readBody(req)
      const { problems, warnings } = await preflight(body)
      return sendJson(res, 200, { ok: !problems.length, problems, warnings })
    }
    if (req.method === 'POST' && url.pathname === '/update') {
      const body = await readBody(req)
      if (S.job || journalJob()) return sendJson(res, 409, { error: 'An operation is already running', code: 'busy' })
      if (!S.appUp) return sendJson(res, 409, { error: 'App is not running stably', code: 'app_not_ready' })
      if (!validVersion(body.version)) return sendJson(res, 400, { error: 'Invalid version', code: 'invalid_version' })
      if (body.mode === 'image') runImageUpdate(body)
      else runUpdate(body)
      return sendJson(res, 202, { ok: true, job: S.job.id, mode: body.mode === 'image' ? 'image' : 'app' })
    }
    if (req.method === 'POST' && url.pathname === '/restart') {
      const body = await readBody(req)
      if (S.job) return sendJson(res, 409, { error: 'An operation is already running', code: 'busy' })
      if (body.reason === 'restore') {
        let rb = null
        if (body.rollback_backup) {
          const n = path.basename(String(body.rollback_backup))
          if (!BACKUP_NAME_RE.test(n) || !fs.existsSync(path.join(BACKUPS, n))) return sendJson(res, 400, { error: 'Invalid backup', code: 'invalid_backup' })
          rb = path.join(BACKUPS, n)
        }
        setTimeout(() => runRestoreRestart({ rollback_backup: rb }), 200)
        return sendJson(res, 202, { ok: true })
      }
      setTimeout(async () => {
        await stopChild()
        startChild(S.active)
      }, 200)
      return sendJson(res, 202, { ok: true })
    }
    sendJson(res, 404, { error: 'not found', code: 'not_found' })
  } catch (e) {
    sendJson(res, 400, { error: e.message, code: 'bad_request' })
  }
})

// ---------------------------------------------------------------- Emergency view (bilingual de/en via Accept-Language, English fallback)

const RT = {
  en: {
    title: 'Wishy – Emergency',
    h1: 'Wishy – Emergency view',
    status: 'Status',
    running: 'running',
    baseline: 'Baseline',
    last: 'Last result',
    restart: 'Restart (best available version)',
    prev: (v) => `Start previous version (${v})`,
    restorePre: (n) => `Restore latest pre-update backup (${n})`,
    token: 'Recovery token (printed in the container log):',
    show: 'Show',
    msg: {
      tooMany: 'Too many failed attempts - please wait 10 minutes.',
      badToken: 'Incorrect token.',
      busy: 'An operation is currently running.',
      restarted: 'Restart triggered.',
      startingPrev: 'Starting the previous version.',
      restoring: (n) => `Restoring backup ${n}.`,
      failed: (m) => `Failed: ${m}`,
    },
  },
  de: {
    title: 'Wishy – Notfall',
    h1: 'Wishy – Notfall-Ansicht',
    status: 'Status',
    running: 'läuft',
    baseline: 'Baseline',
    last: 'Letztes Ergebnis',
    restart: 'Neu starten (beste verfügbare Version)',
    prev: (v) => `Vorherige Version starten (${v})`,
    restorePre: (n) => `Letzte pre-update-Sicherung einspielen (${n})`,
    token: 'Wiederherstellungs-Token (steht im Container-Log):',
    show: 'Anzeigen',
    msg: {
      tooMany: 'Zu viele Fehlversuche – bitte 10 Minuten warten.',
      badToken: 'Token falsch.',
      busy: 'Es läuft gerade ein Vorgang.',
      restarted: 'Neustart ausgelöst.',
      startingPrev: 'Vorherige Version wird gestartet.',
      restoring: (n) => `Sicherung ${n} wird eingespielt.`,
      failed: (m) => `Fehlgeschlagen: ${m}`,
    },
  },
}
// note = { key, arg } -> localized text
const say = (lang, note) => {
  if (!note) return ''
  const v = RT[lang].msg[note.key]
  return typeof v === 'function' ? v(note.arg) : v
}

const recoveryFails = []
const RECOVERY_STYLE = 'body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px}pre{background:#f4efe9;padding:12px;overflow:auto;font-size:12px}button{margin:4px 0;padding:6px 12px}'
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
function newestBackup(reason) {
  try {
    return fs
      .readdirSync(BACKUPS)
      .filter((n) => BACKUP_NAME_RE.test(n) && readJson(path.join(BACKUPS, `${n}.meta.json`))?.reason === reason)
      .map((n) => ({ n, t: fs.statSync(path.join(BACKUPS, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.n
  } catch {
    return null
  }
}
function recoveryPage(authed, msg = '', lang = 'en') {
  const t = RT[lang] || RT.en
  const st = fullStatus()
  let logTail = ''
  try {
    logTail = fs.readFileSync(UPDATE_LOG, 'utf8').split('\n').slice(-40).join('\n')
  } catch {
    /* ignore */
  }
  const pre = newestBackup('pre-update')
  const form = (action, label) => `<form method="post"><input type="hidden" name="token" value="__T__"><input type="hidden" name="action" value="${action}"><button>${label}</button></form>`
  const body = authed
    ? `<p>${t.status}: <b>${esc(st.state)}</b> ${esc(st.message)} · ${t.running}: ${esc(st.version)} (${esc(st.active?.source)}) · ${t.baseline} ${esc(st.baseline_version)}</p>
<p>${t.last}: <code>${esc(JSON.stringify(st.last_result))}</code></p>
${form('restart', t.restart)}${st.previous ? form('start_previous', t.prev(esc(st.previous.version))) : ''}${pre ? form('restore_pre_update', t.restorePre(esc(pre))) : ''}
<h2>update.log</h2><pre>${esc(logTail)}</pre>`
    : `<form method="post"><label>${t.token}<br><input name="token" type="password" autocomplete="off" size="40"></label> <input type="hidden" name="action" value="view"><button>${t.show}</button></form>`
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${t.title}</title>
<style>${RECOVERY_STYLE}</style>
<h1>${t.h1}</h1>${msg ? `<p><b>${esc(msg)}</b></p>` : ''}${body}`
}

async function handleRecovery(req, res) {
  const now = Date.now()
  const lang = pickLang(req.headers['accept-language'])
  while (recoveryFails.length && now - recoveryFails[0] > 600_000) recoveryFails.shift()
  const html = (s, t) => {
    res.writeHead(s, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': staticPageCsp(RECOVERY_STYLE) })
    res.end(t)
  }
  if (req.method === 'GET') return html(200, recoveryPage(false, '', lang))
  if (req.method !== 'POST') return html(405, 'method not allowed')
  if (recoveryFails.length >= 10) return html(429, recoveryPage(false, say(lang, { key: 'tooMany' }), lang))
  const form = new URLSearchParams(await readBody(req, 4096, true).catch(() => ''))
  const got = Buffer.from(form.get('token') || '')
  const want = Buffer.from(RECOVERY_TOKEN)
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    recoveryFails.push(now)
    return html(403, recoveryPage(false, say(lang, { key: 'badToken' }), lang))
  }
  if (S.job) return html(409, recoveryPage(true, say(lang, { key: 'busy' }), lang).replaceAll('__T__', esc(RECOVERY_TOKEN)))
  const action = form.get('action')
  let note = null
  try {
    if (action === 'restart') {
      await stopChild()
      startChild((await chooseRelease()) || S.active)
      note = { key: 'restarted' }
    } else if (action === 'start_previous') {
      const { prev, cur } = await currentInfo()
      await stopChild()
      if (prev) writeCurrent(prev, null, { proven: true })
      else if (cur?.previous) fs.rmSync(CURRENT, { force: true })
      startChild((await chooseRelease()) || S.active)
      note = { key: 'startingPrev' }
    } else if (action === 'restore_pre_update') {
      const pre = newestBackup('pre-update')
      if (!pre) throw new Error('No pre-update backup available')
      await stopChild()
      const rel = (await chooseRelease()) || S.active
      await runCli(rel.dir, ['stage-restore', path.join(BACKUPS, pre)])
      startChild(rel)
      note = { key: 'restoring', arg: pre }
    }
    if (action !== 'view') auditQueue('launcher.recovery', { details: { action, msg: say('en', note) } })
  } catch (e) {
    note = { key: 'failed', arg: e.message }
  }
  if (action !== 'view') S.state = 'starting'
  return html(200, recoveryPage(true, say(lang, note), lang).replaceAll('__T__', esc(RECOVERY_TOKEN)))
}

// ---------------------------------------------------------------- Public reverse proxy

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 })
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization'])

function serveMaintenance(req, res) {
  const u = req.url.split('?')[0]
  const st = publicStatus()
  const state = st.busy ? st.state : S.state === 'failed' ? 'failed' : 'starting'
  const info = { maintenance: true, state, step: st.step, progress: st.progress, message: st.message, version: st.version, target_version: st.target_version }
  if (u === '/api/maintenance') return sendJson(res, 200, info)
  if (u === '/healthz' || u === '/readyz') return sendJson(res, 503, { status: 'maintenance', version: S.active?.version ?? null })
  if (u.startsWith('/api/')) return sendJson(res, 503, { error: 'Wishy is currently under maintenance. Please try again shortly.', code: 'maintenance', maintenance: info }, { 'retry-after': '5' })
  if ((req.method === 'GET' || req.method === 'HEAD') && /text\/html|\*\/\*/.test(String(req.headers.accept || '*/*'))) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', ...maintenanceHeaders() })
    return res.end(req.method === 'HEAD' ? undefined : maintenancePage({ state, lang: pickLang(req.headers['accept-language']) }))
  }
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' })
  res.end('maintenance')
}

/**
 * Header policy: X-Forwarded-For is extended with the peer address, X-Forwarded-Proto/-Host are only set
 * if missing. Additionally X-Wishy-Peer-* (always overwritten): the app decides based on ITS OWN
 * proxy setting (environment or UI) whether it trusts the outer headers (server/launcher-hop.js).
 */
function proxy(req, res) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('x-wishy-')) headers[k] = v
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${peer}` : peer
  headers['x-forwarded-proto'] ||= 'http'
  headers['x-forwarded-host'] ||= req.headers.host || ''
  headers['x-wishy-peer-ip'] = peer
  headers['x-wishy-peer-proto'] = 'http'
  headers['x-wishy-peer-host'] = req.headers.host || ''
  const up = http.request({ host: '127.0.0.1', port: APP_PORT, method: req.method, path: req.url, headers, agent, timeout: 15 * 60_000 }, (ur) => {
    const out = []
    for (let i = 0; i < ur.rawHeaders.length; i += 2) {
      if (!HOP.has(ur.rawHeaders[i].toLowerCase())) out.push(ur.rawHeaders[i], ur.rawHeaders[i + 1])
    }
    res.writeHead(ur.statusCode, ur.statusMessage, out)
    ur.pipe(res)
    ur.on('error', () => res.destroy())
  })
  up.on('timeout', () => up.destroy(new Error('upstream timeout')))
  up.on('error', () => {
    if (!res.headersSent) serveMaintenance(req, res)
    else res.destroy()
  })
  res.on('close', () => {
    if (!res.writableFinished) up.destroy()
  })
  req.pipe(up)
}

const server = http.createServer((req, res) => {
  const u = req.url || ''
  if (!u.startsWith('/')) return sendJson(res, 400, { error: 'Invalid request', code: 'bad_request' })
  if (u === '/__launcher/status' || u.startsWith('/__launcher/status?')) return sendJson(res, 200, publicStatus())
  if (u === '/__launcher/recovery') return handleRecovery(req, res)
  if (u.startsWith('/__launcher') || u.startsWith('/__internal') || u.startsWith('//')) return sendJson(res, 404, { error: 'Not found', code: 'not_found' })
  if (!S.appUp || S.maintenance || !child) return serveMaintenance(req, res)
  proxy(req, res)
})
server.headersTimeout = 30_000
server.requestTimeout = 0 // large backup uploads; against slow clients: idle timeout + connection limit
server.timeout = 120_000
server.keepAliveTimeout = 10_000
server.maxConnections = Number(env.WISHY_MAX_CONNECTIONS || 2000)

// ---------------------------------------------------------------- Start

let controlPort = 0
async function main() {
  await new Promise((r) => control.listen(Number(env.WISHY_CONTROL_PORT || 0), '127.0.0.1', r))
  controlPort = control.address().port
  log(`Launcher v${LAUNCHER_VERSION} (Node ${process.versions.node}) starting; data: ${DATA_DIR}; baseline: ${BASELINE_DIR}`)
  console.log(`[launcher] Recovery token for /__launcher/recovery: ${RECOVERY_TOKEN}`)
  if (!publicKey) log(`Note: no update key (${keyError || 'launcher/update-key.pub missing'}) - updates are disabled`)
  await refreshDocker(true)
  log(S.docker.available ? `Docker API available (${S.docker.api_version}), container ${S.docker.self.name} - image updates possible` : `No Docker API (${S.docker.reason}) - app updates only`)
  const hold = await recoverJob()
  if (!readJson(JOB_FILE)) pruneOrphans()
  await new Promise((r) => server.listen(PUBLIC_PORT, PUBLIC_HOST, r))
  log(`Public on http://${PUBLIC_HOST}:${PUBLIC_PORT}, app internally on 127.0.0.1:${APP_PORT}`)
  if (hold === 'hold') {
    log('App will NOT be started (rollback incomplete) - emergency view /__launcher/recovery')
    return writeStatus()
  }
  const rel = await chooseRelease()
  if (!rel) {
    log('ERROR: No startable release found (baseline damaged?)')
    S.state = 'failed'
    S.message = 'no_release'
  } else {
    const cur = readJson(CURRENT)
    if (cur && rel.source === 'baseline') log(`Baseline ${rel.version} is newer than or equal to the activated release ${cur.version} (or the latter is invalid) - using the baseline`)
    startChild(rel)
  }
}

let shuttingDown = false
async function shutdown(sig) {
  if (shuttingDown) return
  shuttingDown = true
  log(`${sig} received - shutting down`)
  server.close()
  control.close()
  await stopChild(10_000)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
// Windows has no deliverable SIGTERM: for tests/development, "stop" via stdin
if (env.WISHY_LAUNCHER_STDIN_CONTROL === '1') {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => /stop/.test(d) && shutdown('stdin'))
}

if (HELPER_JOB) {
  runHelper(HELPER_JOB).catch((e) => {
    log(`Helper aborted: ${e.stack || e.message}`)
    process.exit(1) // restart policy on-failure restarts the helper -> it resumes from the journal
  })
} else {
  main().catch((e) => {
    log(`Launcher start failed: ${e.stack || e.message}`)
    process.exit(1)
  })
}
