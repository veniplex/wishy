// Under the launcher (Docker image) this is an additional proxy hop on 127.0.0.1.
// The admin's proxy setting (TRUST_PROXY or UI) describes the proxies IN FRONT of the container;
// here it is extended by exactly this one hop. The launcher appends the peer address to X-Forwarded-For,
// passes through X-Forwarded-Proto/-Host of an outer proxy and additionally reports what it saw itself
// (X-Wishy-Peer-*). If the admin trusts NO outer proxy, launcherHopHeaders replaces the X-Forwarded-*
// with these values – client headers then cannot spoof anything.
export const underLauncher = process.env.WISHY_LAUNCHER_HOP === '1'
let outerTrust = ''

/** Normalised setting ('' | 'true' | '<n>' | list) → value for Express' "trust proxy". */
export function launcherTrust(raw) {
  outerTrust = raw || ''
  if (!underLauncher) return raw
  if (!raw) return 'loopback'
  if (raw === 'true') return 'true'
  if (/^\d+$/.test(raw)) return String(Number(raw) + 1)
  return `loopback, ${raw}`
}

const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'

export function launcherHopHeaders(req, res, next) {
  if (!underLauncher) return next()
  const fromLauncher = isLoopback(req.socket.remoteAddress)
  const peer = req.headers['x-wishy-peer-ip']
  if (fromLauncher && peer && !outerTrust) {
    req.headers['x-forwarded-for'] = String(peer)
    req.headers['x-forwarded-proto'] = String(req.headers['x-wishy-peer-proto'] || 'http')
    req.headers['x-forwarded-host'] = String(req.headers['x-wishy-peer-host'] || req.headers.host || '')
  }
  for (const k of ['x-wishy-peer-ip', 'x-wishy-peer-proto', 'x-wishy-peer-host']) delete req.headers[k]
  next()
}
