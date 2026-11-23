// Reverse proxy support: trust proxy, health endpoints, diagnostics.
import fs from 'node:fs'
import net from 'node:net'
import { db } from './db.js'
import { getSys, getStored, envLocked, baseUrl } from './config.js'
import { requireAdmin, sessionCookieName } from './session.js'
import { bad } from './util.js'
import { launcherTrust } from './launcher-hop.js'
import { forwardedUntrustedSeenAt } from './headers.js'

let appRef = null

export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal'])

/** Value of the setting (environment before database) as text; '' = off. */
export function trustProxyRaw() {
  const v = getSys('trust_proxy')
  return v === null || v === undefined || v === false ? '' : String(v).trim()
}

/** Normalises/validates an input. Throws on invalid values. */
export function normalizeTrustProxy(input) {
  const v = String(input ?? '').trim()
  if (!v || /^(off|false|0|no)$/i.test(v)) return ''
  if (/^true$/i.test(v)) return 'true'
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    if (n < 1 || n > 32) throw bad('The number of proxy hops must be between 1 and 32', 'trust_proxy_invalid')
    return String(n)
  }
  const parts = v.split(/[\s,]+/).filter(Boolean)
  for (const p of parts) {
    const [ip, mask] = p.split('/')
    const okIp = net.isIP(ip) !== 0
    const okMask = mask === undefined || (/^\d+$/.test(mask) && Number(mask) <= (net.isIPv6(ip) ? 128 : 32))
    if (!NAMED.has(p) && !(okIp && okMask)) throw bad(`Invalid entry for trusted proxies: ${p}`, 'trust_proxy_invalid')
  }
  return parts.join(', ')
}

function toExpress(raw) {
  if (!raw) return false
  if (raw === 'true') return true
  if (/^\d+$/.test(raw)) return Number(raw)
  return raw
}

/** Sets Express' "trust proxy" according to the setting (at startup and after changes). */
export function applyTrustProxy(app) {
  if (app) appRef = app
  let raw = ''
  try {
    raw = normalizeTrustProxy(trustProxyRaw())
  } catch {
    raw = ''
    console.error('TRUST_PROXY is invalid – proxy headers are not trusted')
  }
  appRef?.set('trust proxy', toExpress(launcherTrust(raw))) // + launcher hop in the Docker image, see launcher-hop.js
}

export function trustProxySource() {
  if (process.env.TRUST_PROXY) return 'env'
  return getStored('trust_proxy') ? 'setting' : 'default'
}

export function healthRoutes(app) {
  app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ status: 'ok', version: VERSION })
  })
  app.get('/readyz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      db.prepare('SELECT 1 AS ok').get()
      res.json({ status: 'ready', version: VERSION })
    } catch {
      res.status(503).json({ status: 'unavailable', version: VERSION })
    }
  })
}

// Paths that must be publicly reachable behind a proxy with its own sign-in
export const BYPASS_PATHS = ['/w/*', '/api/shared/*', '/api/images/*', '/api/v1/*', '/api/auth/google/callback', '/healthz', '/assets/*']

const hdr = (req, n) => {
  const v = req.headers[n]
  return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v)
}

export function proxyDiagnostics(req) {
  const socketIp = req.socket.remoteAddress || null
  const trustFn = req.app.get('trust proxy fn')
  const trusted = !!trustFn && trustFn(socketIp, 0)
  const forwarded = {
    'x-forwarded-for': hdr(req, 'x-forwarded-for'),
    'x-forwarded-proto': hdr(req, 'x-forwarded-proto'),
    'x-forwarded-host': hdr(req, 'x-forwarded-host'),
    'x-forwarded-port': hdr(req, 'x-forwarded-port'),
    forwarded: hdr(req, 'forwarded'),
    'x-real-ip': hdr(req, 'x-real-ip'),
  }
  const seen = Object.entries(forwarded).filter(([, v]) => v !== null).map(([k]) => k)
  const configured = getSys('base_url') || null
  const effective = baseUrl(req)
  const raw = trustProxyRaw()
  const secure = !!req.secure
  const hostSeen = String(req.host || req.get('host') || '')
  const warnings = []
  const warn = (code, severity, message) => warnings.push({ code, severity, message })

  if (!trusted && seen.length) {
    if (forwarded['x-forwarded-proto']) warn('forwarded_proto_untrusted', 'warning', 'X-Forwarded-Proto is present but the proxy is not trusted: connections are treated as unencrypted and cookies do not get "Secure".')
    if (forwarded['x-forwarded-for']) warn('forwarded_for_untrusted', 'warning', 'X-Forwarded-For is present but the proxy is not trusted: the proxy address is used as the client IP.')
    if (forwarded['x-forwarded-host']) warn('forwarded_host_untrusted', 'info', 'X-Forwarded-Host is present but the proxy is not trusted.')
  }
  // Even if THIS request carried no headers: someone sent them recently without the proxy being trusted
  if (!trusted && !seen.length && Date.now() - forwardedUntrustedSeenAt() < 3_600_000 && forwardedUntrustedSeenAt() > 0) warn('forwarded_untrusted_recent', 'warning', 'In the last hour requests with X-Forwarded-* headers arrived, but the proxy is not trusted: all users appear with the proxy IP, the rate limit applies to everyone together and cookies do not get "Secure". Set TRUST_PROXY.')
  if (trusted && !seen.length) warn('trusted_without_headers', 'info', 'Proxy trust mode is active, but this request contained no X-Forwarded headers (direct access?).')
  if (raw === 'true') warn('trust_all', 'warning', '"true" trusts all proxies in the chain: X-Forwarded-For can be forged. Better specify the number of hops or a subnet.')
  if (!configured && trusted) warn('base_url_missing', 'info', 'No base URL set: links are built from the forwarding headers. Recommended: set a base URL.')
  if (configured) {
    let cu = null
    try {
      cu = new URL(configured)
    } catch {
      /* ignore */
    }
    if (cu && cu.host.toLowerCase() !== hostSeen.toLowerCase()) warn('base_url_host_mismatch', 'warning', `The base URL (${cu.host}) differs from the observed host (${hostSeen}). Check whether the proxy forwards the Host header.`)
    if (cu && cu.protocol === 'https:' && !secure) warn('cookie_not_secure', 'warning', 'The base URL is https, but this request arrived as http: cookies do not get "Secure". Check proxy trust and X-Forwarded-Proto.')
    if (cu && cu.protocol === 'http:' && secure) warn('base_url_http', 'info', 'The base URL is http, but the request came in over https. Change the base URL to https.')
    if (cu && cu.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(cu.hostname)) warn('insecure_origin', 'warning', 'Passkeys (WebAuthn) do not work without HTTPS.')
  }
  if (!secure && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(req.hostname))) warn('not_https', 'info', 'This connection is not recognisable as HTTPS.')

  let rpID = null
  let origin = null
  try {
    const u = new URL(effective)
    rpID = u.hostname
    origin = u.origin
  } catch {
    /* ignore */
  }
  return {
    protocol: req.protocol,
    secure,
    host: hostSeen,
    client_ip: req.ip || null,
    socket_ip: socketIp,
    proxy_trusted: trusted,
    trust_proxy: { value: raw, enabled: raw !== '', source: trustProxySource(), locked: envLocked().includes('trust_proxy') },
    forwarded_headers: forwarded,
    forwarded_headers_seen: seen,
    base_url: { configured, effective, locked: envLocked().includes('base_url'), matches_request: !configured || (() => { try { return new URL(configured).host.toLowerCase() === hostSeen.toLowerCase() } catch { return false } })() },
    cookie: { name: sessionCookieName(req), secure: secure || sessionCookieName(req).startsWith('__Host-'), same_site: 'Lax' },
    webauthn: { rp_id: rpID, origin },
    bypass_paths: BYPASS_PATHS,
    warnings,
  }
}

export function proxyRoutes(app) {
  app.get('/api/admin/diagnostics/proxy', requireAdmin, (req, res) => res.json(proxyDiagnostics(req)))
}
