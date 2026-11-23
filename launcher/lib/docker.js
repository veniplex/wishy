// Minimal Docker Engine API client (node:http, no docker CLI) + helpers for the container's self-replacement.
// Target: DOCKER_HOST=unix:///path | tcp://host:port (e.g. socket proxy on an internal network); default: /var/run/docker.sock.
// TLS (tcp://...:2376 with certificates) is deliberately not supported - use a socket proxy for that.
import fs from 'node:fs'
import http from 'node:http'

const MIN_API = [1, 41]
// Image references go unencoded into the path (like the docker CLI), but only with allowed characters
const imgPath = (ref) => {
  if (!/^[A-Za-z0-9._:/@-]{1,300}$/.test(String(ref))) throw new DockerError('invalid_ref', 'Invalid image reference')
  return String(ref)
}
const MAX_API = '1.45'

export class DockerError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function dockerTarget(env = process.env) {
  const h = String(env.DOCKER_HOST || '').trim()
  if (!h) return fs.existsSync('/var/run/docker.sock') ? { socketPath: '/var/run/docker.sock', label: 'unix:///var/run/docker.sock' } : null
  if (h.startsWith('unix://')) return { socketPath: h.slice(7), label: h }
  if (h.startsWith('tcp://') || h.startsWith('http://')) {
    if (env.DOCKER_TLS_VERIFY || env.DOCKER_CERT_PATH) return { error: 'tls_unsupported', label: h }
    const u = new URL(h.replace(/^tcp:/, 'http:'))
    return { host: u.hostname, port: Number(u.port || 2375), label: h }
  }
  return { error: 'unsupported_docker_host', label: h }
}

const cmpVer = (a, b) => {
  const [x1, x2] = String(a).split('.').map(Number)
  const [y1, y2] = String(b).split('.').map(Number)
  return x1 - y1 || x2 - y2
}

export class Docker {
  constructor(target) {
    this.target = target
    this.prefix = ''
  }

  raw(method, p, { body, timeout = 30_000, headers = {}, onLine } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const opts = {
        method,
        path: this.prefix + p,
        headers: { Host: 'docker', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers },
        timeout,
      }
      if (this.target.socketPath) opts.socketPath = this.target.socketPath
      else Object.assign(opts, { host: this.target.host, port: this.target.port })
      const req = http.request(opts, (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (d) => {
          if (onLine) {
            buf += d
            let i
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).trim()
              buf = buf.slice(i + 1)
              if (line) onLine(line)
            }
          } else if (buf.length < 4 * 1024 * 1024) buf += d
        })
        res.on('end', () => {
          if (onLine && buf.trim()) onLine(buf.trim())
          let json = null
          if (!onLine) {
            try {
              json = buf ? JSON.parse(buf) : null
            } catch {
              json = null
            }
          }
          resolve({ status: res.statusCode, json, text: onLine ? '' : buf })
        })
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new DockerError('docker_timeout', `Docker API does not respond (${method} ${p})`)))
      req.on('error', (e) => reject(e instanceof DockerError ? e : new DockerError('docker_unreachable', `Docker API unreachable: ${e.code || e.message}`)))
      if (data) req.write(data)
      req.end()
    })
  }

  async call(method, p, opts = {}) {
    const r = await this.raw(method, p, opts)
    if (r.status >= 400) throw new DockerError(r.status === 404 ? 'not_found' : r.status === 403 ? 'forbidden' : 'docker_error', r.json?.message || `Docker-API: HTTP ${r.status} (${method} ${p.split('?')[0]})`, r.status)
    return r
  }

  /** Negotiate the version; afterwards all calls use /v<api>. */
  async connect() {
    const r = await this.call('GET', '/version', { timeout: 5000 })
    const api = r.json?.ApiVersion
    if (!api || cmpVer(api, MIN_API.join('.')) < 0) throw new DockerError('docker_api_too_old', `Docker API ${api || '?'} is too old (minimum ${MIN_API.join('.')})`)
    this.apiVersion = cmpVer(api, MAX_API) > 0 ? MAX_API : api
    this.prefix = `/v${this.apiVersion}`
    this.serverVersion = r.json.Version
    this.arch = r.json.Arch
    return { api_version: this.apiVersion, server_version: r.json.Version, os: r.json.Os, arch: r.json.Arch }
  }

  async inspectContainer(id) {
    try {
      return (await this.call('GET', `/containers/${encodeURIComponent(id)}/json`)).json
    } catch (e) {
      if (e.code === 'not_found') return null
      throw e
    }
  }
  async inspectImage(ref) {
    try {
      return (await this.call('GET', `/images/${imgPath(ref)}/json`)).json
    } catch (e) {
      if (e.code === 'not_found') return null
      throw e
    }
  }
  createContainer(name, body) {
    return this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body }).then((r) => r.json.Id)
  }
  startContainer(id) {
    return this.call('POST', `/containers/${encodeURIComponent(id)}/start`)
  }
  stopContainer(id, t = 30) {
    return this.call('POST', `/containers/${encodeURIComponent(id)}/stop?t=${t}`, { timeout: (t + 30) * 1000 })
  }
  renameContainer(id, name) {
    return this.call('POST', `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`)
  }
  removeContainer(id, { force = false } = {}) {
    return this.call('DELETE', `/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}&v=0`)
  }
  connectNetwork(net, container, endpoint) {
    return this.call('POST', `/networks/${encodeURIComponent(net)}/connect`, { body: { Container: container, EndpointConfig: endpoint } })
  }
  removeImage(id) {
    return this.call('DELETE', `/images/${imgPath(id)}`)
  }

  /** Pull an image ONLY by digest (repo@sha256:...). Errors in the progress stream are detected. */
  async pullByDigest(repository, digest, onProgress) {
    let err = null
    let reported = null
    const headers = process.env.DOCKER_REGISTRY_AUTH ? { 'X-Registry-Auth': process.env.DOCKER_REGISTRY_AUTH } : {}
    const r = await this.raw('POST', `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}`, {
      timeout: 30 * 60_000,
      headers,
      onLine: (line) => {
        try {
          const j = JSON.parse(line)
          if (j.error || j.errorDetail) err = j.error || j.errorDetail?.message
          else if (typeof j.status === 'string' && j.status.startsWith('Digest: ')) reported = j.status.slice(8).trim()
          else onProgress?.(j)
        } catch {
          /* ignore */
        }
      },
    })
    if (r.status >= 400 || err) throw new DockerError('pull_failed', `Image could not be pulled: ${err || `HTTP ${r.status}`}`, r.status)
    return { reported_digest: reported }
  }
}

/** Eigene Container-ID ermitteln (Env → mountinfo → cgroup → Hostname). */
export function selfContainerCandidates(env = process.env) {
  const out = []
  if (env.WISHY_CONTAINER_ID) out.push(env.WISHY_CONTAINER_ID)
  for (const f of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
    try {
      const t = fs.readFileSync(f, 'utf8')
      const m = /\/(?:docker\/containers|containers|docker)\/([0-9a-f]{64})/.exec(t) || /([0-9a-f]{64})/.exec(t)
      if (m) out.push(m[1])
    } catch {
      /* not Linux */
    }
  }
  if (env.HOSTNAME) out.push(env.HOSTNAME)
  return [...new Set(out)]
}

export async function findSelf(docker, env = process.env) {
  for (const c of selfContainerCandidates(env)) {
    const i = await docker.inspectContainer(c)
    if (i) return i
  }
  return null
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Builds, from a running container (inspect), the create request for the same container with a new image.
 * Values that were only image defaults (Env, Cmd, Entrypoint, Healthcheck, User, WorkingDir, Labels) are
 * omitted so the new image brings its own defaults; everything the operator set is kept.
 * Returns { name, body, connect: [{ network, endpoint }] }.
 */
export function buildCreatePayload(old, oldImage, newImageRef, extraLabels = {}) {
  const C = old.Config || {}
  const ic = oldImage?.Config || {}
  const imgEnv = new Set(ic.Env || [])
  const imgLabels = ic.Labels || {}
  const labels = {}
  for (const [k, v] of Object.entries(C.Labels || {})) {
    if (imgLabels[k] === v && !k.startsWith('com.docker.compose.')) continue
    labels[k] = v
  }
  Object.assign(labels, extraLabels)
  const keepIfSet = (k) => (same(C[k], ic[k]) ? undefined : C[k])
  const body = {
    Image: newImageRef,
    Env: (C.Env || []).filter((e) => !imgEnv.has(e)),
    Labels: labels,
    Cmd: keepIfSet('Cmd'),
    Entrypoint: keepIfSet('Entrypoint'),
    WorkingDir: keepIfSet('WorkingDir') || undefined,
    User: keepIfSet('User') || undefined,
    Healthcheck: keepIfSet('Healthcheck'),
    StopSignal: keepIfSet('StopSignal'),
    StopTimeout: C.StopTimeout,
    Hostname: C.Hostname && !String(old.Id).startsWith(C.Hostname) ? C.Hostname : undefined,
    Domainname: C.Domainname || undefined,
    ExposedPorts: C.ExposedPorts,
    Tty: C.Tty,
    OpenStdin: C.OpenStdin,
    StdinOnce: C.StdinOnce,
    HostConfig: { ...(old.HostConfig || {}) },
  }
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]
  // Explicitly carry over anonymous/named volumes that are not in Binds/Mounts (e.g. VOLUME /data without a mapping)
  const H = body.HostConfig
  const covered = new Set([...(H.Binds || []).map((b) => b.split(':')[1]), ...(H.Mounts || []).map((m) => m.Target)])
  const extraMounts = (old.Mounts || [])
    .filter((m) => m.Type === 'volume' && m.Name && !covered.has(m.Destination))
    .map((m) => ({ Type: 'volume', Source: m.Name, Target: m.Destination, ReadOnly: m.RW === false }))
  if (extraMounts.length) H.Mounts = [...(H.Mounts || []), ...extraMounts]
  // Networks: the primary one on create, connect further ones afterwards
  const nets = Object.entries(old.NetworkSettings?.Networks || {})
  const mode = String(H.NetworkMode || '')
  const connect = []
  if (nets.length && !['host', 'none'].includes(mode) && !mode.startsWith('container:')) {
    const ep = (e) => {
      const o = { Aliases: (e.Aliases || []).filter((a) => !String(old.Id).startsWith(a)) }
      if (e.IPAMConfig) o.IPAMConfig = e.IPAMConfig
      if (e.Links) o.Links = e.Links
      if (e.DriverOpts) o.DriverOpts = e.DriverOpts
      return o
    }
    const primary = nets.find(([n]) => n === mode) || nets[0]
    body.NetworkingConfig = { EndpointsConfig: { [primary[0]]: ep(primary[1]) } }
    for (const [n, e] of nets) if (n !== primary[0]) connect.push({ network: n, endpoint: ep(e) })
  }
  return { name: String(old.Name || '').replace(/^\//, ''), body, connect }
}

/** Compose membership from the labels. */
export function composeInfo(inspect) {
  const l = inspect?.Config?.Labels || {}
  return l['com.docker.compose.project'] ? { project: l['com.docker.compose.project'], service: l['com.docker.compose.service'] || null } : null
}
