#!/usr/bin/env node
// End-to-end tests for backups/restore, launcher app updates and image updates (fake Docker API) –
// without a Docker daemon and without network.
//   node scripts/test-update-e2e.mjs [--tmp <empty directory>] [--keep] [--only backup|update|image|browser]
// Prerequisites: `npm ci` and `npm run build` (dist/ must exist).
// Ports are chosen freely (parallel runs do not interfere); each run uses its own temp directory.
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { tarStream, extractTar } from '../launcher/lib/tar.js'
import { signRelease, artifactName, metaName, sha256Buf } from '../launcher/lib/release.js'
import { readBackup, createBackup, pruneBackups, stageRestore, applyPendingRestore } from '../server/backup-core.js'
import { createFakeDocker } from './lib/fake-docker.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const ONLY = opt('only')
if (opt('tmp') && fs.existsSync(opt('tmp')) && fs.readdirSync(opt('tmp')).length) {
  console.error(`--tmp ${opt('tmp')} is not empty (is a test already running there?) – please pass an empty directory`)
  process.exit(2)
}
const TMP = path.resolve(opt('tmp') || fs.mkdtempSync(path.join(os.tmpdir(), 'wishy-e2e-')))
fs.mkdirSync(TMP, { recursive: true })
const REL = path.join(TMP, 'releases')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (b) => createHash('sha256').update(b).digest('hex')
const results = []
const procs = new Set()
const cleanups = []

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}
const [PUB, APP, FAKE, DOCK] = [await freePort(), await freePort(), await freePort(), await freePort()]

// Overall time limit: never hang forever
const WATCHDOG = setTimeout(() => {
  console.error('\nABORT: overall time limit (45 min) exceeded')
  for (const p of procs) p.kill('SIGKILL')
  process.exit(3)
}, 45 * 60_000)
WATCHDOG.unref()

function assert(c, m) {
  if (!c) throw new Error(m)
}
async function check(name, fn) {
  const t = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`)
  } catch (e) {
    results.push({ name, ok: false, error: e.message })
    console.log(`  FAIL  ${name}: ${e.message}`)
  }
}
async function waitFor(fn, timeout, label) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(250)
  }
  throw new Error(`Timeout (${Math.round(timeout / 1000)} s): ${label}${last ? ` (${last.message})` : ''}`)
}

class Client {
  constructor(base) {
    this.base = base
    this.cookie = ''
  }
  async req(method, p, body, headers = {}) {
    const h = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    let b
    if (body instanceof Uint8Array) b = body
    else if (body !== undefined) {
      h['content-type'] = 'application/json'
      b = JSON.stringify(body)
    }
    const res = await fetch(this.base + p, { method, headers: h, body: b, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
    for (const c of res.headers.getSetCookie?.() || []) {
      const m = /^wl_session=([^;]*)/.exec(c)
      if (m) this.cookie = m[1] ? `wl_session=${m[1]}` : ''
    }
    const buf = Buffer.from(await res.arrayBuffer())
    let json = null
    try {
      json = JSON.parse(buf.toString('utf8'))
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, buf, text: buf.toString('utf8'), headers: res.headers }
  }
  get = (p, h) => this.req('GET', p, undefined, h)
  post = (p, b, h) => this.req('POST', p, b ?? {}, h)
  put = (p, b) => this.req('PUT', p, b)
  del = (p) => this.req('DELETE', p, {})
}

const baseEnv = () => {
  const e = { ...process.env }
  for (const k of ['PORT', 'APP_PORT', 'HOST', 'DATA_DIR', 'TRUST_PROXY', 'BASE_URL', 'UPDATE_REPO', 'BACKUP_PASSPHRASE', 'UPDATE_PUBLIC_KEY', 'BASELINE_DIR', 'DOCKER_HOST', 'WISHY_CONTAINER_ID']) delete e[k]
  return { ...e, PREVIEW_BROWSER: 'off', NODE_ENV: 'production' }
}

function startProc(name, script, env, cwd, argv = []) {
  const p = spawn(process.execPath, [script, ...argv], { cwd, env: { ...baseEnv(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const log = fs.createWriteStream(path.join(TMP, `${name}.log`), { flags: 'a' })
  p.stdout.pipe(log)
  p.stderr.pipe(log)
  p.logFile = path.join(TMP, `${name}.log`)
  procs.add(p)
  p.on('exit', () => procs.delete(p))
  return p
}
async function stopProc(p, graceful = false) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return
  const done = new Promise((r) => p.once('exit', r))
  if (graceful) p.stdin.write('stop\n')
  else p.kill()
  const t = setTimeout(() => p.kill('SIGKILL'), 20_000)
  await done
  clearTimeout(t)
  await sleep(500)
}

/** Child process with a time limit and a clear error message (instead of a silent hang while building releases). */
function runStep(label, argv, timeout = 10 * 60_000) {
  return new Promise((resolve, reject) => {
    const logFile = path.join(TMP, `step-${label.replace(/\W+/g, '_')}.log`)
    const out = fs.createWriteStream(logFile)
    const p = spawn(process.execPath, argv, { cwd: root, env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    procs.add(p)
    p.stdout.pipe(out)
    p.stderr.pipe(out)
    const t = setTimeout(() => {
      p.kill('SIGKILL')
      reject(new Error(`${label}: time limit ${Math.round(timeout / 1000)} s exceeded (log: ${logFile})`))
    }, timeout)
    p.on('exit', (code) => {
      clearTimeout(t)
      procs.delete(p)
      if (code === 0) resolve()
      else reject(new Error(`${label}: Exit ${code}: ${fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-800) : ''}`))
    })
  })
}

const peekDb = (dataDir, fn) => {
  const h = new DatabaseSync(path.join(dataDir, 'wishlist.db'))
  try {
    return fn(h)
  } finally {
    h.close()
  }
}
const personNames = async (c) => ((await c.get('/api/state')).json?.persons || []).map((p) => p.name)

async function setupUsers(base) {
  const admin = new Client(base)
  let r = await admin.post('/api/auth/setup', { name: 'Admin', email: 'admin@example.test', password: 'admin-pass-123' })
  assert(r.status === 200, `Setup failed: ${r.status} ${r.text}`)
  r = await admin.post('/api/admin/users', { name: 'Berta', email: 'berta@example.test', password: 'berta-pass-123' })
  assert(r.status === 200, `Create user: ${r.status} ${r.text}`)
  const user = new Client(base)
  r = await user.post('/api/auth/login', { email: 'berta@example.test', password: 'berta-pass-123' })
  assert(r.status === 200, `Login Berta: ${r.status} ${r.text}`)
  return { admin, user }
}

/** Build a backup by hand (for tampered test cases). */
async function craftBackup(file, members, { manifestExtra = {} } = {}) {
  const files = {}
  for (const [n, b] of Object.entries(members)) files[n] = { size: b.length, sha256: sha(b) }
  const manifest = { format: 'wishy-backup', format_version: 1, app: 'wishy', app_version: '1.0.0', schema_version: 1, created_at: new Date().toISOString(), reason: 'manual', encrypted: false, files, ...manifestExtra }
  async function* entries() {
    for (const [n, b] of Object.entries(members)) yield { name: n, type: 'file', size: b.length, body: b }
    yield { name: 'manifest.json', type: 'file', body: Buffer.from(JSON.stringify(manifest)) }
  }
  await pipeline(Readable.from(tarStream(entries())), createGzip(), fs.createWriteStream(file))
}

// =====================================================================================================
// Part 1: Backups without launcher
// =====================================================================================================
async function backupTests() {
  console.log('\n== Backups & restore (no launcher, app directly on port %d) ==', APP)
  const DATA = path.join(TMP, 'bdata')
  fs.mkdirSync(path.join(DATA, 'images'), { recursive: true })
  fs.mkdirSync(path.join(DATA, 'avatars'), { recursive: true })
  const env = { PORT: String(APP), HOST: '127.0.0.1', DATA_DIR: DATA, WISHY_BACKUP_TICK_MS: '1000', WISHY_RESTORE_CLEANUP_MS: '1500' }
  let app = startProc('app-backup', path.join(root, 'server', 'index.js'), env, root)
  const base = `http://127.0.0.1:${APP}`
  const restartApp = async () => {
    await stopProc(app)
    app = startProc('app-backup', path.join(root, 'server', 'index.js'), env, root)
    await waitFor(async () => (await fetch(`${base}/healthz`)).ok, 30_000, 'restart')
  }
  await waitFor(async () => (await fetch(`${base}/healthz`)).ok, 30_000, 'app start')
  const { admin, user } = await setupUsers(base)
  const img = randomBytes(5000)
  const avatarOrig = randomBytes(3000)
  fs.writeFileSync(path.join(DATA, 'images', 'aaaaaaaaaaaaaaaa.png'), img)
  fs.writeFileSync(path.join(DATA, 'avatars', 'u1.png'), avatarOrig)
  await admin.post('/api/persons', { name: 'P1' })
  let plain, enc
  const PASS = 'correct horse battery staple'
  const upload = (buf, name, extra = {}) => admin.req('POST', '/api/admin/backups/upload', new Uint8Array(buf), { 'content-type': 'application/octet-stream', 'x-requested-with': 'fetch', 'x-filename': name, ...extra })

  await check('Backup: create unencrypted', async () => {
    const r = await admin.post('/api/admin/backups', { label: 'plain' })
    assert(r.status === 200, `${r.status} ${r.text}`)
    plain = r.json.backup
    assert(plain.name.endsWith('.wbk') && !plain.encrypted && plain.verified === true, JSON.stringify(plain))
    assert(plain.counts.images === 1 && plain.counts.avatars === 1, 'images/avatars missing from manifest')
  })
  await check('Backup: create encrypted (passphrase stored sealed)', async () => {
    let r = await admin.put('/api/admin/backups/settings', { passphrase: PASS, encrypt: true })
    assert(r.status === 200 && r.json.passphrase_set && r.json.encrypt, `${r.status} ${r.text}`)
    assert(!r.text.includes(PASS), 'passphrase returned in plain text')
    r = await admin.post('/api/admin/backups', { label: 'enc' })
    assert(r.status === 200, `${r.status} ${r.text}`)
    enc = r.json.backup
    assert(enc.name.endsWith('.wbk.enc') && enc.encrypted && enc.verified === true, JSON.stringify(enc))
    const raw = fs.readFileSync(path.join(DATA, 'backups', enc.name))
    assert(raw.subarray(0, 8).toString() === 'WISHYENC', 'magic missing')
    assert(!raw.includes(Buffer.from('SQLite format')), 'plaintext DB in encrypted file')
    const row = peekDb(DATA, (h) => h.prepare("SELECT value FROM system_settings WHERE key='backup_passphrase'").get())
    assert(row && !row.value.includes('horse'), 'passphrase not stored encrypted')
  })
  await check('Backup: verify (both ok)', async () => {
    for (const b of [plain, enc]) {
      const r = await admin.post(`/api/admin/backups/${b.name}/verify`, {})
      assert(r.status === 200 && r.json.ok, `${b.name}: ${r.status} ${r.text}`)
    }
  })
  await check('Backup: tampered byte → verification fails (unencrypted + encrypted)', async () => {
    for (const [b, n] of [[plain, 'tampered.wbk'], [enc, 'tampered.wbk.enc']]) {
      const buf = fs.readFileSync(path.join(DATA, 'backups', b.name))
      buf[Math.floor(buf.length / 2)] ^= 0x01
      fs.writeFileSync(path.join(DATA, 'backups', n), buf)
      const r = await admin.post(`/api/admin/backups/${n}/verify`, {})
      assert(r.status === 400 && r.json.code === 'backup_corrupt', `${n}: ${r.status} ${r.text}`)
      await admin.del(`/api/admin/backups/${n}`)
    }
  })
  await check('Backup: wrong passphrase → passphrase_wrong', async () => {
    const r = await admin.post(`/api/admin/backups/${enc.name}/verify`, { passphrase: 'wrong wrong wrong' })
    assert(r.status === 422 && r.json.code === 'passphrase_wrong', `${r.status} ${r.text}`)
  })
  await check('Backup: scrypt parameters from the header are ignored (no memory bomb)', async () => {
    const raw = fs.readFileSync(path.join(DATA, 'backups', enc.name))
    const len = raw.readUInt32BE(8)
    const hdr = JSON.parse(raw.subarray(12, 12 + len).toString())
    hdr.N = 2 ** 20
    hdr.r = 16
    const j = Buffer.from(JSON.stringify(hdr))
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(j.length)
    const t = Date.now()
    const r = await upload(Buffer.concat([raw.subarray(0, 8), lenBuf, j, raw.subarray(12 + len)]), 'bomb.wbk.enc', { 'x-backup-passphrase': PASS })
    assert(r.status === 400 && r.json.code === 'backup_invalid', `${r.status} ${r.text}`)
    assert(Date.now() - t < 10_000, 'too slow – scrypt with foreign parameters?')
  })
  await check('Backup: download + upload (verified), garbage upload rejected', async () => {
    const d = await admin.get(`/api/admin/backups/${enc.name}/download`)
    assert(d.status === 200 && d.buf.length === enc.size, `Download ${d.status} ${d.buf.length}`)
    let r = await upload(d.buf, 'my-upload.wbk.enc')
    assert(r.status === 200 && r.json.verified === true && r.json.backup.name === 'my-upload.wbk.enc', `${r.status} ${r.text}`)
    r = await upload(randomBytes(4096), 'garbage.wbk')
    assert(r.status === 400, `Garbage accepted: ${r.status} ${r.text}`)
    assert(!fs.readdirSync(path.join(DATA, 'backups')).some((n) => n.startsWith('garbage')), 'garbage file left in the folder')
    await admin.del('/api/admin/backups/my-upload.wbk.enc')
  })
  const x = path.join(TMP, 'plain-extract')
  await readBackup(path.join(DATA, 'backups', plain.name), { extractTo: x })
  await check('Backup: secret.key in an UNENCRYPTED backup is rejected', async () => {
    const f = path.join(TMP, 'with-key.wbk')
    await craftBackup(f, { 'wishlist.db': fs.readFileSync(path.join(x, 'wishlist.db')), 'secret.key': randomBytes(32) })
    const r = await upload(fs.readFileSync(f), 'with-key.wbk')
    assert(r.status === 400 && r.json.code === 'backup_invalid', `${r.status} ${r.text}`)
  })
  await check('Restore: backup with SQL trigger is rejected', async () => {
    const t = path.join(TMP, 'trigger-extract')
    fs.cpSync(x, t, { recursive: true })
    peekDb(t, (h) => h.exec("CREATE TRIGGER evil AFTER INSERT ON sessions BEGIN UPDATE users SET role='admin'; END"))
    const b = await createBackup({ dataDir: t, reason: 'manual', label: 'trigger', appVersion: '1.0.0' })
    fs.copyFileSync(path.join(t, 'backups', b.name), path.join(DATA, 'backups', b.name))
    const r = await admin.post(`/api/admin/backups/${b.name}/restore`, {})
    assert(r.status === 400 && r.json.code === 'backup_invalid' && /trigger/i.test(r.json.error), `${r.status} ${r.text}`)
    assert(!fs.existsSync(path.join(DATA, 'restore-pending')), 'restore-pending created')
    await admin.del(`/api/admin/backups/${b.name}`)
  })
  await check('Restore: round trip (data, images, avatars back; pre-restore encrypted; sessions; admin loads app UI)', async () => {
    await admin.post('/api/persons', { name: 'P2' })
    fs.rmSync(path.join(DATA, 'images', 'aaaaaaaaaaaaaaaa.png'))
    fs.writeFileSync(path.join(DATA, 'avatars', 'u1.png'), randomBytes(10))
    assert((await personNames(admin)).includes('P2'), 'P2 not created')
    let r = await admin.post(`/api/admin/backups/${plain.name}/restore`, {})
    assert(r.status === 200 && r.json.restart === 'manual' && r.json.pre_restore_backup, `${r.status} ${r.text}`)
    assert(r.json.pre_restore_backup.endsWith('.wbk.enc'), 'pre-restore backup unencrypted despite active encryption')
    assert(fs.existsSync(path.join(DATA, 'launcher', 'keys', `${r.json.pre_restore_backup}.key`)), 'rollback key missing')
    r = await admin.get('/api/state')
    assert(r.status === 503 && r.json.code === 'maintenance', `maintenance not enforced: ${r.status}`)
    r = await user.get('/api/auth/me')
    assert(r.status === 503, `other users not locked out: ${r.status}`)
    r = await admin.get('/api/admin/backups')
    assert(r.status === 200 && r.json.restore_pending, 'admin status unreachable during maintenance')
    r = await new Client(base).get('/api/maintenance')
    assert(r.json.maintenance === true && r.json.state === 'restart_required', JSON.stringify(r.json))
    const page = await new Client(base).get('/', { accept: 'text/html' })
    assert(page.status === 503 && page.text.includes('Wishy'), 'maintenance page missing')
    assert(/script-src 'sha256-/.test(page.headers.get('content-security-policy') || ''), 'maintenance page without hash CSP')
    const shell = await admin.get('/', { accept: 'text/html' })
    assert(shell.status === 200 && !shell.text.includes('Wishy – Maintenance'), `admin does not get the app UI: ${shell.status}`)
    await restartApp()
    r = await new Client(base).get('/api/maintenance')
    assert(r.json.maintenance === false, 'maintenance still active after restore')
    const names = await personNames(admin)
    assert(names.includes('P1') && !names.includes('P2'), `data not restored: ${names}`)
    assert(fs.readFileSync(path.join(DATA, 'images', 'aaaaaaaaaaaaaaaa.png')).equals(img), 'image not restored')
    assert(fs.readFileSync(path.join(DATA, 'avatars', 'u1.png')).equals(avatarOrig), 'avatar not restored')
    assert((await user.get('/api/auth/me')).status === 401, 'other session not logged out')
    r = await admin.get('/api/admin/backups')
    assert(r.json.backups.some((b) => b.reason === 'pre-restore'), 'pre-restore backup missing')
    assert(r.json.last_restore?.ok === true, `last_restore: ${JSON.stringify(r.json.last_restore)}`)
    await waitFor(() => !fs.readdirSync(DATA).some((n) => n.startsWith('restore-old-')), 10_000, 'cleanup of the old state')
  })
  await check('Restore: encrypted backup with stored passphrase', async () => {
    let r = await admin.post(`/api/admin/backups/${enc.name}/restore`, {})
    assert(r.status === 200, `${r.status} ${r.text}`)
    await restartApp()
    r = await admin.get('/api/admin/backups')
    assert(r.status === 200 && r.json.last_restore?.ok && r.json.last_restore.source === enc.name, JSON.stringify(r.json.last_restore))
  })
  await check('Restore: backup from a newer schema is rejected', async () => {
    const n = path.join(TMP, 'newer-extract')
    fs.cpSync(x, n, { recursive: true })
    peekDb(n, (h) => h.exec('PRAGMA user_version = 999'))
    const b = await createBackup({ dataDir: n, reason: 'manual', label: 'newer', appVersion: '9.9.9' })
    fs.copyFileSync(path.join(n, 'backups', b.name), path.join(DATA, 'backups', b.name))
    const r = await admin.post(`/api/admin/backups/${b.name}/restore`, {})
    assert(r.status === 409 && r.json.code === 'backup_schema_newer', `${r.status} ${r.text}`)
    assert(!fs.existsSync(path.join(DATA, 'restore-pending')), 'restore-pending created')
    assert((await new Client(base).get('/api/maintenance')).json.maintenance === false, 'maintenance active')
    await admin.del(`/api/admin/backups/${b.name}`)
  })
  await check('Restore: crash mid-swap → resumed on next start (journal)', async () => {
    const d = path.join(TMP, 'resume')
    fs.cpSync(x, d, { recursive: true })
    const b = await createBackup({ dataDir: d, reason: 'manual', label: 'resume', appVersion: '1.0.0' })
    fs.writeFileSync(path.join(d, 'images', 'new-after-backup.png'), 'x')
    peekDb(d, (h) => h.exec("INSERT INTO system_settings (key,value) VALUES ('after_backup','1')"))
    await stageRestore({ dataDir: d, file: path.join(d, 'backups', b.name), mode: 'rollback' })
    // Recreate the state "crashed after the first step": journal + images already swapped
    const pend = path.join(d, 'restore-pending')
    const J = { started_at: new Date().toISOString(), old_dir: path.join(d, 'restore-old-crash'), items: ['images', 'avatars'] }
    fs.writeFileSync(path.join(pend, 'journal.json'), JSON.stringify(J))
    fs.mkdirSync(J.old_dir)
    fs.renameSync(path.join(d, 'images'), path.join(J.old_dir, 'images'))
    fs.renameSync(path.join(pend, 'images'), path.join(d, 'images'))
    const r = applyPendingRestore(d, () => {})
    assert(r?.ok, `Resume failed: ${JSON.stringify(r)}`)
    assert(!fs.existsSync(path.join(d, 'images', 'new-after-backup.png')), 'images not swapped')
    assert(!fs.existsSync(pend), 'restore-pending not cleaned up')
    const v = peekDb(d, (h) => h.prepare("SELECT 1 FROM system_settings WHERE key='after_backup'").get())
    assert(!v, 'database not swapped')
  })
  await check('Retention: keep_last and keep_days (backdated files)', async () => {
    let r = await admin.put('/api/admin/backups/settings', { encrypt: false, keep_last: 2, keep_days: 0 })
    assert(r.status === 200, r.text)
    for (let i = 0; i < 3; i++) await admin.post('/api/admin/backups', { label: `r${i}` })
    r = await admin.get('/api/admin/backups')
    const regular = r.json.backups.filter((b) => !['pre-update', 'pre-restore'].includes(b.reason))
    assert(regular.length === 2, `expected 2 regular, found ${regular.length}`)
    assert(r.json.backups.some((b) => b.reason === 'pre-restore'), 'pre-restore wrongly deleted')
    await admin.put('/api/admin/backups/settings', { keep_last: 0, keep_days: 30 })
    const old = regular[1].name
    const t = new Date(Date.now() - 40 * 86_400_000)
    fs.utimesSync(path.join(DATA, 'backups', old), t, t)
    await admin.post('/api/admin/backups', { label: 'after-backdating' })
    r = await admin.get('/api/admin/backups')
    assert(!r.json.backups.some((b) => b.name === old), 'backdated backup not deleted')
    const pd = path.join(TMP, 'prune-test')
    fs.mkdirSync(path.join(pd, 'backups'), { recursive: true })
    for (const n of ['a.wbk', 'b.wbk']) {
      fs.writeFileSync(path.join(pd, 'backups', n), 'x')
      fs.writeFileSync(path.join(pd, 'backups', `${n}.meta.json`), JSON.stringify({ reason: 'manual' }))
      const tt = new Date(Date.now() - (n === 'a.wbk' ? 100 : 200) * 86_400_000)
      fs.utimesSync(path.join(pd, 'backups', n), tt, tt)
    }
    const del = pruneBackups(pd, { keep_last: 0, keep_days: 30, keep_pre_update: 5 })
    assert(del.length === 1 && del[0] === 'b.wbk' && fs.existsSync(path.join(pd, 'backups', 'a.wbk')), `Newest deleted? ${del}`)
  })
  await check('Schedule: scheduled backup is triggered', async () => {
    let r = await admin.put('/api/admin/backups/settings', { schedule: 'daily', hour: new Date().getHours(), keep_last: 50, keep_days: 0 })
    assert(r.status === 200 && r.json.next_run_at, r.text)
    await sleep(2500)
    r = await admin.get('/api/admin/backups')
    assert(!r.json.backups.some((b) => b.reason === 'scheduled'), 'immediate catch-up run after settings change')
    peekDb(DATA, (h) => h.prepare("UPDATE system_settings SET value='0' WHERE key='backup_last_slot'").run())
    await waitFor(async () => (await admin.get('/api/admin/backups')).json.backups.some((b) => b.reason === 'scheduled'), 15_000, 'scheduled backup')
    r = await admin.get('/api/admin/backups/settings')
    assert(r.json.last_run?.ok === true, JSON.stringify(r.json.last_run))
    await admin.put('/api/admin/backups/settings', { schedule: 'off' })
  })
  await check('Orphaned upload/temp files are cleaned up', async () => {
    const o = path.join(DATA, 'backups', '.upload-deadbeef')
    fs.writeFileSync(o, 'x')
    const t = new Date(Date.now() - 2 * 3_600_000)
    fs.utimesSync(o, t, t)
    await restartApp()
    assert(!fs.existsSync(o), 'orphan not removed')
  })
  await check('Without launcher: update status reports mode=none, start refused', async () => {
    let r = await admin.get('/api/admin/update/status')
    assert(r.status === 200 && r.json.supervised === false && r.json.mode === 'none' && r.json.state === 'idle', r.text)
    r = await admin.post('/api/admin/update/start', { version: '9.9.9' })
    assert(r.status === 409 && r.json.code === 'not_supervised', r.text)
  })
  await check('Schema guard: older app on a newer DB refuses to start (exit 78)', async () => {
    await stopProc(app)
    peekDb(DATA, (h) => h.exec('PRAGMA user_version = 50'))
    app = startProc('app-backup', path.join(root, 'server', 'index.js'), env, root)
    const code = await new Promise((r) => app.once('exit', r))
    assert(code === 78, `exit code ${code}`)
    peekDb(DATA, (h) => h.exec('PRAGMA user_version = 1'))
  })
  await stopProc(app)
}

// =====================================================================================================
// Helpers for releases + fake GitHub
// =====================================================================================================
function writeRaw(name, body) {
  const h = Buffer.alloc(512)
  h.write(name, 0)
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.fill(0x20, 148, 156)
  h.write('0', 156)
  h.write('ustar\0', 257)
  h.write('00', 263)
  let s = 0
  for (const b of h) s += b
  h.write(s.toString(8).padStart(6, '0') + '\0 ', 148)
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

function listDir(dir) {
  const out = []
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        out.push({ name: r, type: 'dir' })
        walk(path.join(d, e.name), r)
      } else out.push({ name: r, type: 'file', file: path.join(d, e.name) })
    }
  }
  walk(dir, '')
  return out
}

const writeMetaFile = (meta, key, signed = true) => {
  const name = metaName(meta.version)
  const text = JSON.stringify(meta, null, 2)
  fs.writeFileSync(path.join(REL, name), text)
  if (signed) fs.writeFileSync(path.join(REL, `${name}.sig`), signRelease(key, name, sha256Buf(Buffer.from(text))))
  return signed ? [name, `${name}.sig`] : [name]
}

/** Pack a variant of a release from a staging directory (with replacements) and sign it. */
async function packVariant({ version, stage, overrides = {}, minLauncher, key, metaKey = key, badSha = false, evil = false, meta = 'signed', metaOverride = {}, tarball = true }) {
  const rel = JSON.parse(fs.readFileSync(path.join(stage, 'release.json'), 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'))
  rel.version = version
  pkg.version = version
  if (minLauncher) rel.min_launcher = minLauncher
  const out = []
  const name = artifactName(version)
  if (tarball) {
    const ov = { ...overrides, 'release.json': JSON.stringify(rel, null, 2), 'package.json': JSON.stringify(pkg, null, 2) }
    const files = listDir(stage)
    async function* entries() {
      for (const f of files) {
        if (f.type === 'dir') yield f
        else {
          let body = fs.readFileSync(f.file)
          if (ov[f.name] !== undefined) body = Buffer.from(typeof ov[f.name] === 'function' ? ov[f.name](body.toString('utf8')) : ov[f.name])
          yield { name: f.name, type: 'file', size: body.length, body }
        }
      }
    }
    async function* all() {
      if (evil) yield writeRaw('../evil.txt', Buffer.from('pwned'))
      yield* tarStream(entries())
    }
    const file = path.join(REL, name)
    await pipeline(Readable.from(all()), createGzip({ level: 1 }), fs.createWriteStream(file))
    const digest = sha(fs.readFileSync(file))
    fs.writeFileSync(`${file}.sha256`, `${badSha ? sha('other') : digest}  ${name}\n`)
    fs.writeFileSync(`${file}.sig`, signRelease(key, name, digest))
    out.push(name, `${name}.sha256`, `${name}.sig`)
  }
  if (meta !== 'none') out.push(...writeMetaFile({ ...rel, ...metaOverride }, metaKey, meta === 'signed'))
  return { version, files: out }
}

function startFakeGitHub(port) {
  let published = []
  const hits = { list: 0, notModified: 0 }
  const gh = (v) => ({
    tag_name: `v${v.version}`,
    name: `Wishy ${v.version}`,
    body: `Changes in ${v.version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-11-22T00:00:00Z',
    html_url: `https://example.test/releases/v${v.version}`,
    assets: v.files.map((f) => ({ name: f, size: fs.statSync(path.join(REL, f)).size, browser_download_url: `http://127.0.0.1:${port}/dl/${f}` })),
  })
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/repos/test/wishy/releases') {
      hits.list++
      const body = JSON.stringify(published.map(gh))
      const etag = `"${sha(body).slice(0, 16)}"`
      if (req.headers['if-none-match'] === etag) {
        hits.notModified++
        res.writeHead(304, { etag })
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json', etag })
      return res.end(body)
    }
    const f = path.join(REL, path.basename(u.pathname))
    if (u.pathname.startsWith('/dl/') && fs.existsSync(f)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(f).size })
      return fs.createReadStream(f).pipe(res)
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, hits, set: (list) => (published = list) })))
}

let keys
let other
let keyFile
let pubPem
let stageA
async function prepareReleases() {
  if (stageA) return
  fs.mkdirSync(REL, { recursive: true })
  keys = generateKeyPairSync('ed25519')
  other = generateKeyPairSync('ed25519')
  keyFile = path.join(TMP, 'test-update.key')
  fs.writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  pubPem = keys.publicKey.export({ type: 'spki', format: 'pem' })
  stageA = path.join(TMP, 'stageA')
  const stageB = path.join(TMP, 'stageB')
  const br = path.join(root, 'scripts', 'build-release.mjs')
  console.log('  … building releases A (1.0.0) and B (1.0.1) with build-release.mjs')
  await runStep('stage A', [br, '--version', '1.0.0', '--stage-only', stageA])
  await runStep('pack A', [br, '--from-staging', stageA, '--out', REL, '--key', keyFile])
  await runStep('stage B', [br, '--version', '1.0.1', '--stage-only', stageB])
  await runStep('pack B', [br, '--from-staging', stageB, '--out', REL, '--key', keyFile])
  fs.rmSync(stageB, { recursive: true, force: true })
}

const relFiles = (v) => [artifactName(v), `${artifactName(v)}.sha256`, `${artifactName(v)}.sig`, metaName(v), `${metaName(v)}.sig`]
const INJECT = 'const app = express()\n'
const migrateOverride = {
  'server/index.js': (s) => {
    assert(s.includes(INJECT), 'injection point in server/index.js missing')
    return s.replace(INJECT, `${INJECT}db.exec("CREATE TABLE IF NOT EXISTS migrated_marker (x)"); (await import('./schema.js')).bumpSchema(99, 'test-migration'); app.get('/healthz', (q, r) => r.status(500).json({ status: 'broken' }))\n`)
  },
}

// =====================================================================================================
// Part 2: Launcher + app updates
// =====================================================================================================
async function updateTests() {
  console.log('\n== Launcher & app updates (launcher %d → app %d, fake GitHub %d) ==', PUB, APP, FAKE)
  await prepareReleases()
  console.log('  … building failure variants')
  const K = keys.privateKey
  const relB = { version: '1.0.1', files: relFiles('1.0.1') }
  const V = {
    badsig: await packVariant({ version: '1.0.2', stage: stageA, key: other.privateKey, metaKey: K }),
    badsha: await packVariant({ version: '1.0.3', stage: stageA, key: K, badSha: true }),
    evil: await packVariant({ version: '1.0.4', stage: stageA, key: K, evil: true }),
    crash: await packVariant({ version: '1.0.5', stage: stageA, key: K, overrides: { 'server/index.js': (s) => `process.stderr.write('intentional crash\\n'); process.exit(3)\n${s}` } }),
    migrate: await packVariant({ version: '1.0.6', stage: stageA, key: K, overrides: migrateOverride }),
    oldLauncher: await packVariant({ version: '1.0.7', stage: stageA, key: K, minLauncher: 999 }),
    oldLauncherNoMeta: await packVariant({ version: '1.0.8', stage: stageA, key: K, minLauncher: 999, meta: 'none' }),
    unsignedMeta: await packVariant({ version: '1.0.11', stage: stageA, key: K, meta: 'unsigned', metaOverride: { min_launcher: 999 } }),
    newerBaseline: await packVariant({ version: '1.0.20', stage: stageA, key: K }),
  }
  const fake = await startFakeGitHub(FAKE)
  const DATA = path.join(TMP, 'udata')
  const baselineA = path.join(TMP, 'baselineA')
  await extractTar(fs.createReadStream(path.join(REL, artifactName('1.0.0'))), baselineA)
  const lenv = { PORT: String(PUB), APP_PORT: String(APP), HOST: '127.0.0.1', DATA_DIR: DATA, UPDATE_PUBLIC_KEY: pubPem, UPDATE_API_BASE: `http://127.0.0.1:${FAKE}`, WISHY_UPDATE_ALLOW_LOOPBACK: '1', WISHY_HEALTH_TIMEOUT_MS: '20000', WISHY_LAUNCHER_STDIN_CONTROL: '1' }
  const base = `http://127.0.0.1:${PUB}`
  const health = async () => {
    const r = await fetch(`${base}/healthz`).catch(() => null)
    return r?.ok ? (await r.json()).version : null
  }
  const lstatus = async () => (await fetch(`${base}/__launcher/status`)).json()
  let launcher = startProc('launcher', path.join(baselineA, 'launcher', 'index.js'), lenv, baselineA)
  cleanups.push(() => stopProc(launcher, true))
  let admin, user
  try {
    await check('Launcher starts baseline 1.0.0 behind the proxy (client IP, emergency view with CSP)', async () => {
      await waitFor(async () => (await health()) === '1.0.0', 40_000, 'healthz 1.0.0')
      ;({ admin, user } = await setupUsers(base))
      await admin.post('/api/persons', { name: 'Before' })
      let r = await admin.get('/api/admin/update/status')
      assert(r.json.supervised === true && r.json.mode === 'app' && r.json.app_only === true && r.json.launcher?.key_configured === true, r.text)
      assert(r.json.docker.available === false && r.json.docker.reason === 'no_socket', JSON.stringify(r.json.docker))
      const st = await lstatus()
      assert(st.state === 'idle' && st.version === '1.0.0', JSON.stringify(st))
      assert((await fetch(`${base}/__internal/x`)).status === 404, '/__internal reachable')
      r = await admin.get('/api/admin/diagnostics/proxy', { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https' })
      assert(r.status === 200 && r.json.client_ip === '127.0.0.1', `client IP spoofed/wrong: ${r.json?.client_ip}`)
      const rec = await fetch(`${base}/__launcher/recovery`)
      assert(rec.status === 200 && /default-src 'none'/.test(rec.headers.get('content-security-policy') || ''), 'emergency view without CSP')
      const bad = await fetch(`${base}/__launcher/recovery`, { method: 'POST', body: 'token=wrong&action=view', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
      assert(bad.status === 403, `wrong token accepted: ${bad.status}`)
    })
    await check('Update check against fake GitHub (semver, ETag/304)', async () => {
      let r = await admin.put('/api/admin/update/settings', { repo: 'test/wishy' })
      assert(r.status === 200, r.text)
      fake.set([relB])
      r = await admin.post('/api/admin/update/check')
      assert(r.status === 200 && r.json.available && r.json.latest.version === '1.0.1' && r.json.state === 'available' && r.json.target?.mode === 'app', r.text)
      assert(r.json.latest.notes.includes('1.0.1'), 'release notes missing')
      await admin.post('/api/admin/update/check')
      assert(fake.hits.notModified >= 1, 'no If-None-Match/304')
    })
    await check('Update 1.0.0 → 1.0.1 (maintenance page with CSP, sessions, pre-update backup, reload)', async () => {
      const seen = { page: false, csp: false, maintApi: false, steps: null }
      let r = await admin.post('/api/admin/update/start', { version: '1.0.1' })
      assert(r.status === 202 && r.json.mode === 'app', `${r.status} ${r.text}`)
      for (let i = 0; i < 600; i++) {
        const p = await new Client(base).get('/', { accept: 'text/html' }).catch(() => null)
        if (p?.status === 503 && p.text.includes('Wishy – Maintenance')) {
          seen.page = true
          seen.csp ||= /script-src 'sha256-/.test(p.headers.get('content-security-policy') || '')
        }
        const m = await new Client(base).get('/api/maintenance').catch(() => null)
        if (m?.json?.maintenance === true && m.json.state === 'updating') seen.maintApi = true
        const s = await admin.get('/api/admin/update/status').catch(() => null)
        if (s?.json?.job?.steps) seen.steps = s.json.job.steps
        const st = await lstatus()
        if (!st.busy && st.app_up && st.version === '1.0.1') break
        await sleep(200)
      }
      assert((await health()) === '1.0.1', 'healthz does not report 1.0.1')
      assert(seen.page && seen.csp, `maintenance page (CSP) not served: ${JSON.stringify(seen)}`)
      assert(seen.maintApi, '/api/maintenance did not report maintenance')
      assert(seen.steps?.some((s) => s.id === 'download'), 'progress steps missing from status')
      assert((await admin.get('/api/auth/me')).status === 200, 'admin session lost')
      assert((await user.get('/api/auth/me')).status === 401, 'other session not logged out')
      r = await admin.get('/api/admin/backups')
      assert(r.json.backups.some((b) => b.reason === 'pre-update' && b.verified), 'pre-update backup missing')
      r = await admin.get('/api/admin/update/status')
      assert(r.json.current_version === '1.0.1' && r.json.last_result?.ok === true && r.json.state === 'idle', r.text)
      r = await new Client(base).get('/api/maintenance')
      assert(r.json.maintenance === false && r.json.version === '1.0.1', 'reload signal (version) missing')
      assert((await personNames(admin)).includes('Before'), 'data lost')
      const cur = JSON.parse(fs.readFileSync(path.join(DATA, 'app', 'current.json'), 'utf8'))
      assert(cur.version === '1.0.1' && cur.previous?.version === '1.0.0' && cur.pre_update_backup, JSON.stringify(cur))
      assert(fs.existsSync(path.join(DATA, 'app', 'releases', '1.0.1.tar.gz.sig')), 'provenance proof (archive + signature) missing')
      assert(/Update to 1\.0\.1 succeeded/.test(fs.readFileSync(path.join(DATA, 'update.log'), 'utf8')), 'update.log without success entry')
      r = await admin.get('/api/admin/update/log?lines=50')
      assert(r.json.lines.length > 5, 'log endpoint empty')
    })
    // From here on encrypted backups: pre-update backups must be encrypted and still restorable
    await admin.put('/api/admin/backups/settings', { passphrase: 'rollback passphrase 123', encrypt: true })

    const failCase = async (name, v, expect, extra) =>
      check(name, async () => {
        fake.set([relB, v])
        await admin.post('/api/admin/update/check')
        const before = Date.now()
        const r = await admin.post('/api/admin/update/start', { version: v.version })
        let result
        if (r.status === 409) result = { code: r.json.code, preflight: true }
        else {
          assert(r.status === 202, `${r.status} ${r.text}`)
          result = await waitFor(async () => {
            const s = await admin.get('/api/admin/update/status')
            const lr = s.json?.last_result
            return s.status === 200 && !s.json.job && lr && lr.version === v.version && Date.parse(lr.finished_at) >= before - 1000 ? lr : null
          }, 150_000, 'end of update job')
        }
        assert(result.code === expect, `expected ${expect}, got ${JSON.stringify(result)}`)
        assert((await health()) === '1.0.1', 'no longer running 1.0.1')
        assert((await admin.get('/api/auth/me')).status === 200, 'admin session lost')
        assert(!fs.existsSync(path.join(DATA, 'app', 'releases', v.version)), 'faulty release not removed')
        if (!result.preflight) {
          const st = await admin.get('/api/admin/update/status')
          assert(['failed', 'image_update_required'].includes(st.json.state), `state ${st.json.state}`)
        }
        if (extra) await extra(result)
      })

    await failCase('Failure case: invalid archive signature', V.badsig, 'signature_invalid')
    await failCase('Failure case: wrong SHA-256', V.badsha, 'sha256_mismatch')
    await failCase('Failure case: tar with ../ path', V.evil, 'release_invalid', async () => {
      for (const p of [path.join(DATA, 'app', 'evil.txt'), path.join(DATA, 'evil.txt'), path.join(DATA, 'app', 'releases', 'evil.txt')]) assert(!fs.existsSync(p), `${p} was written`)
    })
    await failCase('Failure case: release crashes on start → rollback (DB from encrypted pre-update backup)', V.crash, 'start_failed', async (lr) => {
      assert(lr.rolled_back === true && lr.db_restored === true, JSON.stringify(lr))
      const r = await admin.get('/api/admin/backups')
      assert(r.json.backups.some((b) => b.reason === 'pre-update' && b.encrypted), 'pre-update backup not encrypted')
    })
    await admin.post('/api/persons', { name: 'BeforeMigration' })
    await failCase('Failure case: migration ran, health check fails → DB from pre-update backup', V.migrate, 'health_timeout', async (lr) => {
      assert(lr.rolled_back && lr.db_restored, JSON.stringify(lr))
      const info = peekDb(DATA, (h) => ({ uv: h.prepare('PRAGMA user_version').get().user_version, marker: !!h.prepare("SELECT 1 FROM sqlite_master WHERE name='migrated_marker'").get() }))
      assert(info.uv < 99 && !info.marker, `DB not rolled back: ${JSON.stringify(info)}`)
      assert((await personNames(admin)).includes('BeforeMigration'), 'data from before the update lost')
    })
    await failCase('Failure case: launcher too old (signed release.json) → image_update_required (preflight)', V.oldLauncher, 'image_update_required')
    await failCase('Failure case: launcher too old (archive only) → image_update_required', V.oldLauncherNoMeta, 'image_update_required', async () => {
      const s = await admin.get('/api/admin/update/status')
      assert(s.json.state === 'image_update_required' && s.json.instructions.docker.includes('docker compose pull'), s.json.state)
    })
    await check('Unsigned release.json (bogus min_launcher) does not block – hint only', async () => {
      fake.set([V.unsignedMeta])
      await admin.post('/api/admin/update/check')
      const r = await admin.post('/api/admin/update/start', { version: '1.0.11' })
      assert(r.status === 202, `${r.status} ${r.text}`)
      await waitFor(async () => {
        const st = await lstatus()
        return !st.busy && st.app_up && st.version === '1.0.11'
      }, 150_000, 'update to 1.0.11')
    })
    await check('Audit: launcher events picked up from queue', async () => {
      await waitFor(() => !fs.existsSync(path.join(DATA, 'launcher', 'audit-queue.jsonl')), 40_000, 'audit queue emptied')
    })
    await check('Crash loop: activated release keeps crashing → fall back to previous', async () => {
      await stopProc(launcher, true)
      const relDir = path.join(DATA, 'app', 'releases')
      const prev = JSON.parse(fs.readFileSync(path.join(DATA, 'app', 'current.json'), 'utf8'))
      // properly installed (with signed archive as provenance proof)
      await extractTar(fs.createReadStream(path.join(REL, artifactName('1.0.5'))), path.join(relDir, '1.0.5'))
      for (const sfx of ['', '.sig', '.sha256']) fs.copyFileSync(path.join(REL, artifactName('1.0.5') + sfx), path.join(relDir, `1.0.5.tar.gz${sfx}`))
      fs.writeFileSync(path.join(DATA, 'app', 'current.json'), JSON.stringify({ version: '1.0.5', path: path.join(relDir, '1.0.5'), activated_at: new Date().toISOString(), previous: { version: prev.version, path: prev.path }, proven: true }))
      launcher = startProc('launcher', path.join(baselineA, 'launcher', 'index.js'), lenv, baselineA)
      await waitFor(async () => { const st = await lstatus(); return st.app_up && st.version === prev.version }, 90_000, `fall back to ${prev.version}`)
      assert(/Crash loop in 1\.0\.5/.test(fs.readFileSync(path.join(DATA, 'update.log'), 'utf8')), 'crash loop not logged')
      const cur = JSON.parse(fs.readFileSync(path.join(DATA, 'app', 'current.json'), 'utf8'))
      assert(cur.version === prev.version, `current.json shows ${cur.version}`)
      const s = await admin.get('/api/admin/update/status')
      assert(s.json.last_result?.code === 'crash_loop', JSON.stringify(s.json.last_result))
    })
    await check('Tampered installed release is not started (provenance proof)', async () => {
      await stopProc(launcher, true)
      const cur = JSON.parse(fs.readFileSync(path.join(DATA, 'app', 'current.json'), 'utf8'))
      const evil = path.join(cur.path, 'server', 'node_modules', 'express', 'index.js')
      fs.mkdirSync(path.dirname(evil), { recursive: true })
      fs.writeFileSync(evil, 'module.exports = () => { throw new Error("pwned") }')
      launcher = startProc('launcher', path.join(baselineA, 'launcher', 'index.js'), lenv, baselineA)
      await waitFor(async () => (await lstatus()).app_up && (await lstatus()).version === '1.0.0', 60_000, 'start of the baseline instead of the tampered release')
      assert(/Foreign file in the release/.test(fs.readFileSync(path.join(DATA, 'update.log'), 'utf8')), 'tampering not logged')
      fs.rmSync(path.join(cur.path, 'server', 'node_modules'), { recursive: true, force: true })
    })
    await check('Baseline (image) newer than activated release wins', async () => {
      await stopProc(launcher, true)
      const b20 = path.join(TMP, 'baseline20')
      await extractTar(fs.createReadStream(path.join(REL, artifactName('1.0.20'))), b20)
      launcher = startProc('launcher', path.join(b20, 'launcher', 'index.js'), lenv, b20)
      await waitFor(async () => (await health()) === '1.0.20', 40_000, 'start of baseline 1.0.20')
      const s = await admin.get('/api/admin/update/status')
      assert(s.json.launcher?.active_source === 'baseline' && s.json.current_version === '1.0.20', s.text)
    })
    await check('Restore under the launcher: automatic restart, data back, admin stays logged in', async () => {
      let r = await admin.post('/api/admin/backups', { label: 'before-test' })
      assert(r.status === 200, r.text)
      const name = r.json.backup.name
      await admin.post('/api/persons', { name: 'AfterBackup' })
      r = await admin.post(`/api/admin/backups/${name}/restore`, {})
      assert(r.status === 200 && r.json.restart === 'automatic', r.text)
      await sleep(1000)
      await waitFor(async () => {
        const st = await lstatus()
        const m = await new Client(base).get('/api/maintenance')
        return !st.busy && st.app_up && m.json?.maintenance === false
      }, 60_000, 'end of restore')
      const names = await personNames(admin)
      assert(!names.includes('AfterBackup') && names.includes('Before'), `${names}`)
      r = await admin.get('/api/admin/backups')
      assert(r.status === 200 && r.json.last_restore?.ok && r.json.last_restore.source === name, JSON.stringify(r.json.last_restore))
    })
  } finally {
    await stopProc(launcher, true)
    fake.server.close()
  }
}

// =====================================================================================================
// Part 3: Image updates via the (fake) Docker Engine API
// =====================================================================================================
async function imageTests() {
  console.log('\n== Image updates with fake Docker API (Docker %d, container port %d) ==', DOCK, PUB)
  await prepareReleases()
  const K = keys.privateKey
  const IDATA = path.join(TMP, 'idata')
  fs.mkdirSync(IDATA, { recursive: true })
  const REPO = 'ghcr.io/test/wishy'
  const comps = (app, node, chromium, extra = {}) => ({ app, node, launcher: 2, chromium, os: 'alpine 3.22', os_packages: { musl: '1.2.5-r10', openssl: '3.5.1-r0', chromium: `${chromium}-r0`, ...extra }, built_at: new Date().toISOString() })
  async function makeImage(version, { overrides, components, nodeVersion }) {
    const v = await packVariant({ version, stage: stageA, key: K, overrides, meta: 'none' })
    const dir = path.join(TMP, `img-${version}`)
    await extractTar(fs.createReadStream(path.join(REL, artifactName(version))), dir)
    fs.writeFileSync(path.join(dir, 'components.json'), JSON.stringify(components))
    for (const f of v.files) fs.rmSync(path.join(REL, f), { force: true })
    return {
      dir,
      config: {
        Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=production', 'PORT=3000', 'DATA_DIR=/data', `NODE_VERSION=${nodeVersion}`],
        Labels: { 'org.opencontainers.image.version': version },
        Healthcheck: { Test: ['CMD', 'node', '-e', 'image-default'], Interval: 30e9 },
        User: 'node',
        Cmd: null,
      },
    }
  }
  console.log('  … building images (base 1.0.0, patch releases 1.0.10/1.0.11 with a new base, broken 1.0.12)')
  const cA = comps('1.0.0', '24.16.0', '131.0.1')
  const imgA = await makeImage('1.0.0', { components: cA, nodeVersion: '24.16.0' })
  const imgB = await makeImage('1.0.10', { components: comps('1.0.10', '24.99.0', '132.0.0', { openssl: '3.5.2-r0' }), nodeVersion: '24.99.0' })
  const imgC = await makeImage('1.0.12', { overrides: migrateOverride, components: comps('1.0.12', '24.99.1', '132.0.0'), nodeVersion: '24.99.1' })
  const imgD = await makeImage('1.0.11', { components: comps('1.0.11', '24.99.2', '132.0.1'), nodeVersion: '24.99.2' })
  const fd = createFakeDocker({ logDir: TMP, baseEnv: baseEnv() })
  await new Promise((r) => fd.server.listen(DOCK, '127.0.0.1', r))
  cleanups.push(async () => {
    await fd.stopAll()
    fd.server.close()
  })
  const A = fd.addRegistryImage({ repo: REPO, ...imgA, local: true })
  const B = fd.addRegistryImage({ repo: REPO, ...imgB })
  const C = fd.addRegistryImage({ repo: REPO, ...imgC })
  const D = fd.addRegistryImage({ repo: REPO, ...imgD })
  const metaRel = (version, img, components, key = K) => ({ version, files: writeMetaFile({ version, node: 24, min_launcher: 2, built_at: new Date().toISOString(), image: { repository: REPO, digest: img.digest }, components }, key) })
  const relB = metaRel('1.0.10', B, JSON.parse(fs.readFileSync(path.join(imgB.dir, 'components.json'), 'utf8')))
  const relC = metaRel('1.0.12', C, JSON.parse(fs.readFileSync(path.join(imgC.dir, 'components.json'), 'utf8')))
  const relD = metaRel('1.0.11', D, JSON.parse(fs.readFileSync(path.join(imgD.dir, 'components.json'), 'utf8')))
  const relBad = metaRel('1.0.13', B, null, other.privateKey)
  const fake = await startFakeGitHub(FAKE)
  const base = `http://127.0.0.1:${PUB}`
  const health = async () => {
    const r = await fetch(`${base}/healthz`).catch(() => null)
    return r?.ok ? (await r.json()).version : null
  }
  const lstatus = async () => (await fetch(`${base}/__launcher/status`).catch(() => null))?.json().catch(() => null)
  const body0 = {
    Image: A.ref,
    Env: [`PORT=${PUB}`, `APP_PORT=${APP}`, 'HOST=127.0.0.1', `DATA_DIR=${IDATA}`, `DOCKER_HOST=tcp://127.0.0.1:${DOCK}`, `UPDATE_PUBLIC_KEY=${pubPem}`, `UPDATE_API_BASE=http://127.0.0.1:${FAKE}`, 'WISHY_UPDATE_ALLOW_LOOPBACK=1', 'WISHY_HEALTH_TIMEOUT_MS=20000', 'WISHY_SWAP_TIMEOUT_MS=30000', 'PREVIEW_BROWSER=off', 'TZ=Europe/Berlin'],
    Labels: { 'com.docker.compose.project': 'wishy', 'com.docker.compose.service': 'wishy', 'com.docker.compose.container-number': '1', 'traefik.enable': 'true' },
    Healthcheck: { Test: ['CMD', 'true'], Interval: 10e9 },
    HostConfig: { Binds: [`${IDATA}:${IDATA}`], PortBindings: { '3000/tcp': [{ HostPort: String(PUB) }] }, RestartPolicy: { Name: 'unless-stopped' }, GroupAdd: ['999'], CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], NetworkMode: 'wishy_default' },
    NetworkingConfig: { EndpointsConfig: { wishy_default: { Aliases: ['wishy'] } } },
  }
  await fd.run('wishy', body0, [{ network: 'wishy_docker-api', endpoint: { Aliases: ['wishy'] } }])
  const wishyContainer = () => [...fd.containers.values()].find((c) => c.Name === '/wishy')
  const helpers = () => [...fd.containers.values()].filter((c) => c.Config.Labels?.['wishy.role'] === 'updater')
  let admin, user
  const runImageUpdate = async (version, { expectOk, timeout = 240_000 }) => {
    fake.set([relB, relC, relD, relBad].filter((r) => r.version === version))
    await admin.post('/api/admin/update/check')
    const before = Date.now()
    const r = await admin.post('/api/admin/update/start', { version })
    if (r.status === 409) return { code: r.json.code, preflight: true }
    assert(r.status === 202 && r.json.mode === 'image', `${r.status} ${r.text}`)
    const seen = { blip: false, maint: false }
    const lr = await waitFor(async () => {
      const m = await fetch(`${base}/api/maintenance`).then((x) => x.json()).catch(() => null)
      if (!m) seen.blip = true
      else if (m.maintenance) seen.maint = true
      const s = await lstatus()
      if (!s || s.busy || !s.app_up) return null
      const res = JSON.parse(fs.readFileSync(path.join(IDATA, 'launcher', 'last-result.json'), 'utf8'))
      if (!(res.version === version && Date.parse(res.finished_at) >= before - 1000 && helpers().length === 0)) return null
      return m && m.maintenance === false ? res : null
    }, timeout, `end of image update to ${version}`)
    if (expectOk) assert(lr.ok, JSON.stringify(lr))
    return { ...lr, seen }
  }
  try {
    await check('Image mode detected (Docker API, container, compose, inventory)', async () => {
      await waitFor(async () => (await health()) === '1.0.0', 60_000, 'container wishy (1.0.0) healthy')
      ;({ admin, user } = await setupUsers(base))
      await admin.post('/api/persons', { name: 'BeforeImage' })
      await admin.put('/api/admin/update/settings', { repo: 'test/wishy' })
      fake.set([relB])
      const r = await admin.post('/api/admin/update/check')
      assert(r.json.mode === 'image' && r.json.docker.available && r.json.docker.compose?.project === 'wishy', JSON.stringify(r.json.docker))
      assert(r.json.state === 'available' && r.json.target?.mode === 'image' && r.json.target.image_digest === B.digest, `${r.json.state} ${JSON.stringify(r.json.target)}`)
      const rel = r.json.releases[0]
      assert(rel.components.node && rel.components.chromium && rel.components.os_packages, JSON.stringify(rel.components))
      assert(rel.changes.node.from === '24.16.0' && rel.changes.node.to === '24.99.0', JSON.stringify(rel.changes))
    })
    await check('Image update: pull fails → no swap', async () => {
      fd.inject.pull = true
      const lr = await runImageUpdate('1.0.10', {})
      fd.inject.pull = false
      assert(lr.code === 'pull_failed' && (await health()) === '1.0.0', JSON.stringify(lr))
    })
    await check('Image update: digest mismatch → rejected, image removed', async () => {
      fd.inject.wrongDigest = true
      const lr = await runImageUpdate('1.0.10', {})
      fd.inject.wrongDigest = false
      assert(lr.code === 'digest_mismatch' && (await health()) === '1.0.0', JSON.stringify(lr))
      assert(![...fd.images.values()].some((i) => i.RepoDigests.some((d) => d.endsWith('0'.repeat(64)))), 'wrong image not removed')
    })
    await check('Image update: invalid metadata signature → rejected', async () => {
      const lr = await runImageUpdate('1.0.13', {})
      assert(lr.preflight && lr.code === 'signature_invalid', JSON.stringify(lr))
    })
    await admin.put('/api/admin/backups/settings', { passphrase: 'image rollback pass 1', encrypt: true })
    await check('Image update: new container never healthy → rollback to old container + DB from pre-update backup', async () => {
      const oldId = wishyContainer().Id
      const lr = await runImageUpdate('1.0.12', { timeout: 300_000 })
      assert(!lr.ok && lr.code === 'health_timeout' && lr.rolled_back && lr.db_restored, JSON.stringify(lr))
      assert(wishyContainer()?.Id === oldId && wishyContainer().State.Running, 'old container is not running again under its name')
      assert(fd.containers.size === 2 - 1, `remaining containers: ${[...fd.containers.values()].map((c) => c.Name)}`)
      const info = peekDb(IDATA, (h) => ({ uv: h.prepare('PRAGMA user_version').get().user_version, marker: !!h.prepare("SELECT 1 FROM sqlite_master WHERE name='migrated_marker'").get() }))
      assert(info.uv < 99 && !info.marker, `DB not rolled back: ${JSON.stringify(info)}`)
      assert((await personNames(admin)).includes('BeforeImage'), 'data lost')
      assert((await admin.get('/api/auth/me')).status === 200, 'admin session lost')
    })
    await check('Image update 1.0.0 → 1.0.10 (patch release with a new base): swap with identical configuration', async () => {
      const oldId = wishyContainer().Id
      const nCreates = fd.creates.length
      const lr = await runImageUpdate('1.0.10', { expectOk: true })
      const c = wishyContainer()
      assert(c && c.Id !== oldId && c.Image === fd.images.get(c.Image).Id && fd.images.get(c.Image).RepoDigests.includes(B.ref), 'new container is not running the new image')
      assert(!fd.containers.has(oldId), 'old container not removed')
      assert((await lstatus()).version === '1.0.10' && (await health()) === '1.0.10', 'wrong version')
      assert(lr.seen.maint || lr.seen.blip, 'neither maintenance nor connection drop observed')
      // Config fidelity: create request of the new container vs. the original request
      const created = fd.creates.slice(nCreates).find((x) => x.name === 'wishy')?.body
      assert(created, 'no create request for the new container')
      assert(created.Image === B.ref, `Image ${created.Image}`)
      for (const e of body0.Env) assert(created.Env.includes(e), `env missing: ${e.split('=')[0]}`)
      assert(!created.Env.some((e) => e.startsWith('NODE_VERSION=')), 'image default NODE_VERSION of the old image carried over')
      for (const [k, v] of Object.entries(body0.Labels)) assert(created.Labels[k] === v, `label missing: ${k}`)
      assert(!('org.opencontainers.image.version' in created.Labels), 'image label of the old image carried over')
      for (const k of Object.keys(body0.HostConfig)) assert(JSON.stringify(created.HostConfig[k]) === JSON.stringify(body0.HostConfig[k]), `HostConfig.${k} differs`)
      assert(JSON.stringify(created.Healthcheck) === JSON.stringify(body0.Healthcheck), 'healthcheck override lost')
      assert(JSON.stringify(created.NetworkingConfig.EndpointsConfig.wishy_default.Aliases) === '["wishy"]', 'network aliases lost')
      assert(c.NetworkSettings.Networks['wishy_docker-api'], 'second network not connected')
      assert(c.Config.Env.includes('NODE_VERSION=24.99.0'), 'new container does not have the env defaults of the new image')
      assert((await admin.get('/api/auth/me')).status === 200, 'admin session lost')
      assert((await user.get('/api/auth/me')).status === 401, 'other session not logged out')
      const s = await admin.get('/api/admin/update/status')
      assert(s.json.last_result?.ok && s.json.last_result.mode === 'image' && s.json.image_version === '1.0.10' && s.json.components?.node === '24.99.0', JSON.stringify(s.json.last_result))
      assert((await admin.get('/api/admin/backups')).json.backups.some((b) => b.reason === 'pre-update'), 'pre-update backup missing')
    })
    await check('Image update: helper crashes mid-swap → resumes from the journal after restart', async () => {
      fd.inject.killHelperAfterCreate = true
      const lr = await runImageUpdate('1.0.11', { expectOk: true })
      assert((await lstatus()).version === '1.0.11', 'wrong version')
      const log = fs.readFileSync(path.join(IDATA, 'update.log'), 'utf8')
      assert((log.match(/Helper takes over job/g) || []).length >= 2, 'helper was not restarted/resumed')
      assert(!fd.inject.killHelperAfterCreate && lr.ok, 'injection not triggered')
      assert([...fd.containers.values()].filter((c) => c.Name.startsWith('/wishy')).length === 1, 'leftover containers')
    })
    await check('Docker API unreachable → app mode only; a release with only an image requires an image update', async () => {
      await fd.stopAll()
      fd.containers.clear()
      const L = startProc('launcher-nodocker', path.join(imgA.dir, 'launcher', 'index.js'), { PORT: String(PUB), APP_PORT: String(APP), HOST: '127.0.0.1', DATA_DIR: path.join(TMP, 'ndata'), DOCKER_HOST: 'tcp://127.0.0.1:9', UPDATE_PUBLIC_KEY: pubPem, UPDATE_API_BASE: `http://127.0.0.1:${FAKE}`, WISHY_UPDATE_ALLOW_LOOPBACK: '1', WISHY_LAUNCHER_STDIN_CONTROL: '1' }, imgA.dir)
      try {
        await waitFor(async () => (await health()) === '1.0.0', 60_000, 'launcher without Docker')
        const { admin: a2 } = await setupUsers(base)
        await a2.put('/api/admin/update/settings', { repo: 'test/wishy' })
        fake.set([relB])
        const r = await a2.post('/api/admin/update/check')
        assert(r.json.mode === 'app' && r.json.docker.available === false && r.json.docker.reason === 'docker_unreachable', JSON.stringify(r.json.docker))
        assert(r.json.state === 'image_update_required' && r.json.releases[0].installable_image && !r.json.releases[0].installable_app, `${r.json.state}`)
        const s = await a2.post('/api/admin/update/start', { version: '1.0.10', mode: 'image' })
        assert(s.status === 409 && s.json.code === 'docker_unavailable', s.text)
      } finally {
        await stopProc(L, true)
      }
    })
  } finally {
    fake.server.close()
  }
}

// =====================================================================================================
// Part 4 (only with --only browser): launcher + fake GitHub for manual browser tests. Starts baseline 1.0.0 behind the launcher,
// publishes 1.0.1 in fake GitHub, creates an admin (email/password from BROWSER_ADMIN_EMAIL/BROWSER_ADMIN_PASSWORD) and
// waits until the file <tmp>/stop exists. Usage: node scripts/test-update-e2e.mjs --only browser --tmp <empty directory>
// =====================================================================================================
async function browserHarness() {
  await prepareReleases()
  const fake = await startFakeGitHub(FAKE)
  const DATA = path.join(TMP, 'udata')
  const baselineA = path.join(TMP, 'baselineA')
  await extractTar(fs.createReadStream(path.join(REL, artifactName('1.0.0'))), baselineA)
  const lenv = { PORT: String(PUB), APP_PORT: String(APP), HOST: '127.0.0.1', DATA_DIR: DATA, UPDATE_PUBLIC_KEY: pubPem, UPDATE_API_BASE: `http://127.0.0.1:${FAKE}`, WISHY_UPDATE_ALLOW_LOOPBACK: '1', WISHY_HEALTH_TIMEOUT_MS: '20000', WISHY_LAUNCHER_STDIN_CONTROL: '1' }
  const base = `http://127.0.0.1:${PUB}`
  const launcher = startProc('launcher', path.join(baselineA, 'launcher', 'index.js'), lenv, baselineA)
  cleanups.push(() => stopProc(launcher, true))
  await waitFor(async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok, 40_000, 'healthz')
  const admin = new Client(base)
  const email = process.env.BROWSER_ADMIN_EMAIL || 'admin@example.test'
  const pw = process.env.BROWSER_ADMIN_PASSWORD || randomBytes(12).toString('base64url')
  let r = await admin.post('/api/auth/setup', { name: 'Admin', email, password: pw })
  assert(r.status === 200, `Setup: ${r.status} ${r.text}`)
  r = await admin.put('/api/admin/update/settings', { repo: 'test/wishy' })
  assert(r.status === 200, r.text)
  fake.set([{ version: '1.0.1', files: relFiles('1.0.1') }])
  await admin.post('/api/admin/update/check')
  console.log(`BROWSER_READY ${base} (admin ${email})
To finish, create the file: ${path.join(TMP, 'stop')}`)
  while (!fs.existsSync(path.join(TMP, 'stop'))) await sleep(500)
  fake.server.close()
}

// =====================================================================================================
try {
  console.log(`Test directory: ${TMP}  (ports ${PUB}/${APP}/${FAKE}/${DOCK})`)
  if (!ONLY || ONLY === 'backup') await backupTests()
  if (!ONLY || ONLY === 'update') await updateTests()
  if (!ONLY || ONLY === 'image') await imageTests()
  if (ONLY === 'browser') await browserHarness()
} catch (e) {
  results.push({ name: 'Test run', ok: false, error: e.stack || e.message })
  console.error(e)
} finally {
  for (const c of cleanups.reverse()) await c().catch(() => {})
  for (const p of procs) await stopProc(p, false).catch(() => {})
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  for (const f of failed) console.log(`  FAIL ${f.name}: ${f.error}`)
  if (!args.includes('--keep')) {
    for (let i = 0; i < 5; i++) {
      await sleep(1000 * (i + 1))
      try {
        fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
        break
      } catch (e) {
        if (i === 4) console.warn(`Note: test directory could not be fully deleted (${e.code}): ${TMP}`)
      }
    }
  }
  process.exit(failed.length ? 1 : 0)
}
