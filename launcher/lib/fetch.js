// Safe downloading for updates: https only, to allowed hosts (every redirect is re-checked),
// size limit while streaming (never buffer whole responses), timeouts.
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'

const DEFAULT_HOSTS = ['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'codeload.github.com']
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export class FetchError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function allowedHosts(env = process.env) {
  return new Set([...DEFAULT_HOSTS, ...String(env.UPDATE_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)])
}

/** Throws if the address is not allowed. Loopback (http) only with WISHY_UPDATE_ALLOW_LOOPBACK=1 (tests). */
export function checkUrl(u, env = process.env) {
  let url
  try {
    url = new URL(u)
  } catch {
    throw new FetchError('download_failed', 'Invalid download address')
  }
  if (url.username || url.password) throw new FetchError('download_failed', 'Credentials in the URL are not allowed')
  const host = url.hostname.toLowerCase()
  if (LOOPBACK.has(host) || LOOPBACK.has(`[${host}]`)) {
    if (env.WISHY_UPDATE_ALLOW_LOOPBACK === '1' && (url.protocol === 'http:' || url.protocol === 'https:')) return url
    throw new FetchError('download_failed', 'Downloading from local addresses is not allowed')
  }
  if (url.protocol !== 'https:') throw new FetchError('download_failed', `Only https allowed (${url.origin})`)
  if (!allowedHosts(env).has(host)) throw new FetchError('download_failed', `Host not allowed: ${host} (UPDATE_ALLOWED_HOSTS)`)
  return url
}

/** fetch with manual redirects (max. 5), every hop checked. */
async function guardedFetch(u, { timeout, headers = {}, env }) {
  let url = checkUrl(u, env)
  for (let i = 0; i < 6; i++) {
    let res
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'Wishy-Launcher', ...headers } })
    } catch (e) {
      throw new FetchError('download_failed', `Download fehlgeschlagen: ${e.cause?.code || e.message}`)
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (!loc) throw new FetchError('download_failed', 'Redirect without a target')
      url = checkUrl(new URL(loc, url).toString(), env)
      continue
    }
    if (!res.ok || !res.body) throw new FetchError('download_failed', `Download fehlgeschlagen (HTTP ${res.status})`)
    return res
  }
  throw new FetchError('download_failed', 'Too many redirects')
}

async function* capped(body, maxBytes, onProgress, total) {
  let n = 0
  for await (const c of Readable.fromWeb(body)) {
    n += c.length
    if (n > maxBytes) throw new FetchError('artifact_too_large', 'Response/file is too large')
    onProgress?.(n, total)
    yield c
  }
}

/** Small response as text (streamed with a limit). */
export async function fetchText(u, { maxBytes = 256 * 1024, timeout = 30_000, env = process.env } = {}) {
  const res = await guardedFetch(u, { timeout, env })
  const len = Number(res.headers.get('content-length') || 0)
  if (len > maxBytes) throw new FetchError('artifact_too_large', 'Response is too large')
  const parts = []
  for await (const c of capped(res.body, maxBytes)) parts.push(c)
  return Buffer.concat(parts).toString('utf8')
}

/** Download a file; returns { bytes, sha256 } (hash computed while writing). */
export async function downloadFile(u, dest, { maxBytes, timeout = 20 * 60_000, onProgress, env = process.env } = {}) {
  const res = await guardedFetch(u, { timeout, env, headers: { Accept: 'application/octet-stream' } })
  const len = Number(res.headers.get('content-length') || 0)
  if (len > maxBytes) throw new FetchError('artifact_too_large', 'Update file is too large')
  const h = createHash('sha256')
  let bytes = 0
  await pipeline(
    capped(res.body, maxBytes, onProgress, len),
    async function* (src) {
      for await (const c of src) {
        h.update(c)
        bytes += c.length
        yield c
      }
    },
    fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
  )
  return { bytes, sha256: h.digest('hex') }
}
