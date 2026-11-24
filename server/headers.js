// Security headers for all responses (frontend, API, images, public page /w/:token).
import { createHash } from 'node:crypto'
import { baseUrl } from './config.js'

// Content-Security-Policy. The built frontend loads everything from its own origin (fonts are bundled, no third-party hosts):
//  - script-src 'self': no inline script (the theme script lives at /assets/theme-init.js, see public/assets/)
//  - style-src 'unsafe-inline': React/charts set style attributes; scripts are unaffected
//  - img-src data: blob: : image preview (file picker), QR code (data: URL)
//  - connect-src 'self': own API only; frame-ancestors 'none' + X-Frame-Options: no embedding (clickjacking)
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'", // the service worker (/sw.js)
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()'
const HSTS = 'max-age=15552000' // 180 days, without includeSubDomains/preload (the operator decides about their subdomains)

const hashOf = (t) => `'sha256-${createHash('sha256').update(t).digest('base64')}'`

/**
 * The standalone maintenance page (launcher/lib/maintenance-page.js, served by maintenance.js with 503) brings inline <style> and
 * <script> with it. Instead of loosening the policy for that, exactly this response gets a policy with the SHA-256 hashes of these two
 * blocks (the content is fixed per state; foreign inline code stays blocked).
 */
function maintenancePolicy(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => hashOf(m[1]))
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => hashOf(m[1]))
  return `default-src 'none'; script-src ${scripts.join(' ') || "'none'"}; style-src ${styles.join(' ') || "'none'"}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
}

let warnedForwarded = false
let forwardedUntrustedAt = 0
/** Time (ms) of the last request with X-Forwarded-* headers behind an untrusted proxy (for diagnostics, even if the admin accesses directly). */
export const forwardedUntrustedSeenAt = () => forwardedUntrustedAt

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP)
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', PERMISSIONS)
  const send = res.send.bind(res)
  res.send = (body) => {
    if (res.statusCode === 503 && typeof body === 'string' && body.includes('<main class="card" role="status"')) res.setHeader('Content-Security-Policy', maintenancePolicy(body))
    return send(body)
  }
  try {
    if (req.secure || baseUrl(req).toLowerCase().startsWith('https:')) res.setHeader('Strict-Transport-Security', HSTS)
  } catch {
    /* configuration unreadable: continue without HSTS */
  }
  // One-time warning in the log: forwarding headers arrive but the proxy is not trusted (wrong client IP, cookies without Secure …)
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto']) {
    const trustFn = req.app.get('trust proxy fn')
    if (!(trustFn && trustFn(req.socket.remoteAddress, 0))) {
      forwardedUntrustedAt = Date.now()
      if (!warnedForwarded) {
        warnedForwarded = true
        console.warn(
          '[proxy] Forwarding headers (X-Forwarded-*) detected, but TRUST_PROXY is not set: all users appear with the IP of the proxy ' +
            '(rate limiting then applies to everyone together). Check Settings › Operation › Diagnostics or TRUST_PROXY.',
        )
      }
    }
  }
  next()
}
