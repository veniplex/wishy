// Update check against GitHub releases + hand-over to the launcher.
// Modes: 'image' (Docker API reachable -> the whole image incl. Node/Alpine/Chromium/launcher is swapped),
//        'app' (app code + npm packages only; the base stays), 'none' (no launcher: check + instructions only).
import fs from 'node:fs'
import { getSys, setSys, getSecretSys, setSecretSys } from './config.js'
import { requireAdmin } from './session.js'
import { audit } from './audit.js'
import { HttpError } from './util.js'
import { compareSemver, parseSemver, artifactName, metaName } from '../launcher/lib/release.js'
import { fetchText } from '../launcher/lib/fetch.js'
import { diffComponents } from '../launcher/lib/components.js'
import { APP_VERSION, UPDATE_LOG, supervised, launcherCall } from './maintenance.js'

const API_BASE = (process.env.UPDATE_API_BASE || 'https://api.github.com').replace(/\/+$/, '')
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const DAY = 86_400_000

export const INSTRUCTIONS = {
  docker: 'docker compose pull && docker compose up -d',
  docker_socket: 'To update the whole image (Node, system packages, Chromium), give Wishy access to the Docker API - see docs/operations.md, section "Image updates".',
  manual: 'Download the new version (git pull or unpack the release), then: npm ci && npm run build && restart Wishy.',
}

// ---------------------------------------------------------------- Settings

// Default repository for the update check; can be overridden via UPDATE_REPO or Admin > Updates (e.g. for forks).
const DEFAULT_REPO = 'veniplex/wishy'
const repo = () => String(process.env.UPDATE_REPO || getSys('update_repo') || DEFAULT_REPO).trim()
const channel = () => (getSys('update_channel') === 'prerelease' ? 'prerelease' : 'stable')
const autoCheck = () => (getSys('update_check') === 'off' ? 'off' : 'daily')
function token() {
  if (process.env.UPDATE_TOKEN) return process.env.UPDATE_TOKEN
  try {
    return getSecretSys('update_token') || null
  } catch {
    return null
  }
}
const cache = () => getSys('update_cache') || {}

function settingsOut() {
  return { repo: repo(), repo_env_locked: !!process.env.UPDATE_REPO, channel: channel(), auto_check: autoCheck(), token_set: !!token(), token_env_locked: !!process.env.UPDATE_TOKEN }
}

// ---------------------------------------------------------------- Check

function parseRelease(r) {
  if (!r || r.draft) return null
  const v = parseSemver(r.tag_name)
  if (!v) return null
  const version = v.version
  const find = (n) => (r.assets || []).find((a) => a.name === n)
  const art = artifactName(version)
  const meta = metaName(version)
  const a = { tarball: find(art), sha256: find(`${art}.sha256`), sig: find(`${art}.sig`), release_json: find(meta), release_json_sig: find(`${meta}.sig`) }
  const assets = {}
  for (const [k, x] of Object.entries(a)) if (x?.browser_download_url) assets[k] = { url: x.browser_download_url, size: x.size || 0 }
  return {
    version,
    tag: r.tag_name,
    name: String(r.name || r.tag_name).slice(0, 200),
    notes: String(r.body || '').slice(0, 20_000),
    published_at: r.published_at || r.created_at || null,
    prerelease: !!r.prerelease || v.pre.length > 0,
    html_url: r.html_url || null,
    assets,
    installable_app: !!(assets.tarball && assets.sha256 && assets.sig),
    has_signed_meta: !!(assets.release_json && assets.release_json_sig),
  }
}

/** Release metadata (for display; the launcher verifies the signature itself before every action). */
async function loadMeta(rel) {
  if (!rel.assets.release_json?.url) return null
  try {
    const m = JSON.parse(await fetchText(rel.assets.release_json.url, { maxBytes: 512 * 1024, timeout: 15_000 }))
    return {
      image: m.image && typeof m.image.digest === 'string' ? { repository: String(m.image.repository), digest: m.image.digest } : null,
      components: m.components && typeof m.components === 'object' ? m.components : null,
      min_launcher: Number(m.min_launcher || 1),
      node: Number(m.node || 0) || null,
    }
  } catch {
    return null
  }
}

let checking = null
export function checkForUpdates({ force = false } = {}) {
  if (!checking) checking = doCheck(force).finally(() => (checking = null))
  return checking
}

async function doCheck(force) {
  const r = repo()
  const c = cache()
  const now = Date.now()
  if (!r) return c
  if (!REPO_RE.test(r)) {
    setSys('update_cache', { ...c, checked_at: new Date().toISOString(), ok: false, error_code: 'invalid_repo', error: 'Invalid repository (expected owner/name)' })
    return cache()
  }
  if (c.backoff_until && now < Date.parse(c.backoff_until)) {
    if (!force) return c
    throw new HttpError(429, 'GitHub rate limit reached - please try again later', 'rate_limited')
  }
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Wishy-Updater', 'X-GitHub-Api-Version': '2022-11-28' }
  if (c.etag && c.repo === r) headers['If-None-Match'] = c.etag
  const t = token()
  if (t) headers.Authorization = `Bearer ${t}`
  const base = { repo: r, checked_at: new Date().toISOString() }
  let res
  try {
    res = await fetch(`${API_BASE}/repos/${r}/releases?per_page=30`, { headers, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    setSys('update_cache', { ...c, ...base, ok: false, error_code: 'check_failed', error: `Could not connect to GitHub (${e.cause?.code || e.message})` })
    return cache()
  }
  if (res.status === 304) {
    setSys('update_cache', { ...c, ...base, ok: true, error_code: null, error: null, backoff_until: null })
    return cache()
  }
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000
    const retry = Number(res.headers.get('retry-after') || 0) * 1000
    const until = new Date(Math.max(reset, now + retry, now + 15 * 60_000)).toISOString()
    setSys('update_cache', { ...c, ...base, ok: false, error_code: 'rate_limited', error: 'GitHub rate limit reached', backoff_until: until })
    return cache()
  }
  if (res.status === 404) {
    setSys('update_cache', { ...base, ok: false, error_code: 'repo_not_found', error: 'Repository not found (or private)', releases: [] })
    return cache()
  }
  if (!res.ok) {
    setSys('update_cache', { ...c, ...base, ok: false, error_code: 'check_failed', error: `GitHub responded with HTTP ${res.status}` })
    return cache()
  }
  let list
  try {
    list = await res.json()
  } catch {
    list = null
  }
  if (!Array.isArray(list)) {
    setSys('update_cache', { ...c, ...base, ok: false, error_code: 'check_failed', error: 'Unexpected response from GitHub' })
    return cache()
  }
  const releases = list.map(parseRelease).filter(Boolean).sort((a, b) => compareSemver(b.version, a.version)).slice(0, 30)
  // Load metadata of the newest candidates (image digest, component list for "what changes")
  const old = new Map((c.releases || []).map((x) => [x.version, x.meta]))
  for (const rel of releases.slice(0, 6)) rel.meta = old.get(rel.version) || (await loadMeta(rel))
  setSys('update_cache', { ...base, ok: true, error_code: null, error: null, etag: res.headers.get('etag') || null, releases, backoff_until: null })
  return cache()
}

// ---------------------------------------------------------------- Status

async function launcherStatus(refresh = false) {
  if (!supervised) return { launcher: null, error: null }
  try {
    const r = await launcherCall('GET', `/status${refresh ? '?docker=refresh' : ''}`, undefined, refresh ? 15_000 : 3000)
    return { launcher: r.status === 200 ? r.json : null, error: r.status === 200 ? null : 'launcher_error' }
  } catch {
    return { launcher: null, error: 'launcher_unreachable' }
  }
}

function releaseView(x, ctx) {
  const comp = x.meta?.components || null
  const changes = ctx.components && comp ? diffComponents(ctx.components, comp) : null
  return {
    version: x.version,
    name: x.name,
    notes: x.notes,
    published_at: x.published_at,
    prerelease: x.prerelease,
    html_url: x.html_url,
    installable_app: x.installable_app && compareSemver(x.version, APP_VERSION) > 0,
    installable_image: !!(x.meta?.image && x.has_signed_meta),
    image_digest: x.meta?.image?.digest || null,
    components: {
      node: !!changes?.node,
      os_packages: !!changes?.os_packages,
      chromium: !!changes?.chromium,
      launcher: !!changes?.launcher,
    },
    changes,
  }
}

export async function updateStatus({ refresh = false } = {}) {
  const c = cache()
  const r = repo()
  const { launcher, error } = await launcherStatus(refresh)
  const docker = launcher?.docker || { available: false, reason: supervised ? 'launcher_unreachable' : 'not_supervised' }
  const mode = !supervised ? 'none' : docker.available ? 'image' : 'app'
  const ctx = { components: launcher?.components || null }
  const eligible = (c.repo === r ? c.releases || [] : []).filter((x) => channel() === 'prerelease' || !x.prerelease)
  const newer = eligible.filter((x) => compareSemver(x.version, APP_VERSION) > 0)
  const views = newer.map((x) => releaseView(x, ctx))
  const installableNow = views.filter((v) => (mode === 'image' ? v.installable_image : mode === 'app' ? v.installable_app : false))
  const job = launcher?.job || null
  const lr = launcher?.last_result || null
  let state
  if (!r) state = 'disabled'
  else if (job) state = job.kind === 'restore' ? 'restoring' : 'updating'
  else if (lr && !lr.ok && lr.code === 'image_update_required' && newer.some((x) => x.version === lr.version)) state = 'image_update_required'
  else if (lr && !lr.ok && lr.version && newer.some((x) => x.version === lr.version)) state = 'failed'
  else if (mode === 'none' && newer.length) state = 'available_manual'
  else if (installableNow.length) state = 'available'
  else if (newer.length) state = 'image_update_required' // installable only via image (e.g. no app archive, or it needs a newer Node/launcher), but no Docker access
  else state = 'idle'
  const latest = eligible[0] ? releaseView(eligible[0], ctx) : null
  const steps = job?.steps || []
  const done = steps.filter((s) => s.status === 'done').length
  return {
    current_version: APP_VERSION,
    image_version: launcher?.baseline_version || null,
    supervised,
    mode,
    app_only: mode === 'app', // UI: "app only - base not updated"
    docker: {
      available: !!docker.available,
      reason: docker.reason || null,
      api_version: docker.api_version || null,
      self: docker.self ? { id: docker.self.id?.slice(0, 12), image: docker.self.image, digest: docker.self.digest } : null,
      compose: docker.compose || null,
    },
    components: ctx.components ? { app: ctx.components.app, node: ctx.components.node, chromium: ctx.components.chromium, os: ctx.components.os, launcher: ctx.components.launcher, os_package_count: Object.keys(ctx.components.os_packages || {}).length } : null,
    launcher: launcher
      ? { version: launcher.launcher_version, node: launcher.node, baseline_version: launcher.baseline_version, active_source: launcher.active?.source || null, previous_version: launcher.previous?.version || null, key_configured: !!launcher.key_configured }
      : null,
    launcher_error: error,
    configured: !!r,
    ...settingsOut(),
    latest,
    available: installableNow.length > 0,
    target: installableNow[0] ? { version: installableNow[0].version, mode, image_digest: mode === 'image' ? installableNow[0].image_digest : null } : null,
    releases: views.slice(0, 10),
    last_check: c.checked_at ? { at: c.checked_at, ok: !!c.ok, error_code: c.error_code || null, error: c.error || null } : null,
    next_check_at: r && autoCheck() === 'daily' ? new Date((Date.parse(c.checked_at || 0) || 0) + DAY).toISOString() : null,
    backoff_until: c.backoff_until || null,
    state,
    job: job ? { id: job.id, kind: job.kind, mode: job.mode, version: job.version, from_version: job.from_version, started_at: job.started_at, step: launcher.step, image_digest: job.image ? job.image.split('@')[1] : null, progress: steps.length ? done / steps.length : null, steps } : null,
    last_result: lr,
    can_update: supervised && !!launcher?.key_configured && !job && installableNow.length > 0,
    instructions: INSTRUCTIONS,
  }
}

function tailLog(lines) {
  try {
    const st = fs.statSync(UPDATE_LOG)
    const len = Math.min(st.size, 256 * 1024)
    const fd = fs.openSync(UPDATE_LOG, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- Routes

export function updateRoutes(app) {
  const A = requireAdmin

  app.get('/api/admin/update/status', A, async (req, res) => res.json(await updateStatus({ refresh: req.query.refresh === '1' })))

  app.post('/api/admin/update/check', A, async (req, res) => {
    if (!repo()) throw new HttpError(400, 'No repository configured', 'no_repo')
    await checkForUpdates({ force: true })
    res.json(await updateStatus({ refresh: true }))
  })

  app.get('/api/admin/update/log', A, (req, res) => {
    const n = Math.min(2000, Math.max(1, Number(req.query.lines) || 200))
    res.json({ lines: tailLog(n) })
  })

  app.get('/api/admin/update/settings', A, (req, res) => res.json(settingsOut()))
  app.put('/api/admin/update/settings', A, (req, res) => {
    const b = req.body || {}
    const changed = []
    if (b.repo !== undefined && !process.env.UPDATE_REPO) {
      const v = String(b.repo || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '')
      if (v && !REPO_RE.test(v)) throw new HttpError(400, 'Please specify the repository as owner/name', 'invalid_repo')
      if (v !== repo()) changed.push('repo')
      setSys('update_repo', v || null)
    }
    if (b.channel !== undefined) {
      if (!['stable', 'prerelease'].includes(b.channel)) throw new HttpError(400, 'Invalid channel', 'invalid_channel')
      if (b.channel !== channel()) changed.push('channel')
      setSys('update_channel', b.channel)
    }
    if (b.auto_check !== undefined) {
      if (!['daily', 'off'].includes(b.auto_check)) throw new HttpError(400, 'Invalid value', 'invalid_auto_check')
      if (b.auto_check !== autoCheck()) changed.push('auto_check')
      setSys('update_check', b.auto_check)
    }
    if (b.token === null) {
      setSecretSys('update_token', null)
      changed.push('token_cleared')
    } else if (typeof b.token === 'string' && b.token.trim()) {
      setSecretSys('update_token', b.token.trim())
      changed.push('token_set')
    }
    if (changed.length) audit(req, 'update.settings', { details: { changed } })
    res.json(settingsOut())
  })

  app.post('/api/admin/update/start', A, async (req, res) => {
    if (!supervised) throw new HttpError(409, 'Automatic updates are only possible in the Docker image (with launcher)', 'not_supervised')
    const version = String(req.body?.version || '')
    const st = await updateStatus({ refresh: true })
    const rel = st.releases.find((x) => x.version === version)
    const raw = (cache().releases || []).find((x) => x.version === version)
    if (!rel || !raw) throw new HttpError(404, 'This version is unknown or not newer - please check for updates first', 'release_not_found')
    const mode = req.body?.mode === 'app' ? 'app' : req.body?.mode === 'image' ? 'image' : st.mode
    if (mode === 'image' && !st.docker.available) throw new HttpError(409, 'No access to the Docker API - only an app update is possible', 'docker_unavailable')
    if (mode === 'image' && !rel.installable_image) throw new HttpError(409, 'This release does not contain a signed image', 'no_image')
    if (mode === 'app' && !rel.installable_app) {
      throw new HttpError(409, rel.installable_image ? 'This release can only be installed as an image update' : 'The release is missing files (archive, checksum, signature)', rel.installable_image ? 'image_update_required' : 'artifact_missing')
    }
    if (!st.launcher) throw new HttpError(503, 'Launcher unreachable', 'launcher_unreachable')
    if (!st.launcher.key_configured) throw new HttpError(409, 'No update key is configured in the image', 'no_update_key')
    if (st.job) throw new HttpError(409, 'An operation is already running', 'busy')
    const body = { version, mode, assets: raw.assets, keep_session: req.sessionRowId ?? req.sessionId, actor: { id: req.user.id, label: req.user.email } }
    const pre = await launcherCall('POST', '/preflight', body, 60_000)
    if (pre.status !== 200) throw new HttpError(502, pre.json?.error || 'Preflight check failed', 'preflight_failed')
    if (!pre.json.ok) {
      const p = pre.json.problems.find((x) => x.code === 'image_update_required') || pre.json.problems[0]
      audit(req, 'update.preflight_failed', { status: 'fail', details: { version, mode, code: p.code } })
      return res.status(409).json({ error: p.code === 'image_update_required' ? 'This update requires a newer Docker image' : p.message || 'Update not possible', code: p.code, problems: pre.json.problems, instructions: INSTRUCTIONS })
    }
    const r = await launcherCall('POST', '/update', body, 10_000)
    if (r.status !== 202) throw new HttpError(409, r.json?.error || 'Update could not be started', r.json?.code || 'update_start_failed')
    audit(req, 'update.start', { details: { version, mode, from: APP_VERSION } })
    res.status(202).json({ ok: true, job: r.json.job, version, mode })
  })

  // Daily check
  const tick = async () => {
    try {
      const c = cache()
      if (!repo() || autoCheck() === 'off') return
      if (c.checked_at && Date.now() - Date.parse(c.checked_at) < DAY && c.repo === repo()) return
      await checkForUpdates()
    } catch (e) {
      console.error('[update] Check failed:', e.message)
    }
  }
  setTimeout(tick, 30_000).unref()
  setInterval(tick, 3_600_000).unref()
}
