// Fake Docker Engine API for tests without a Docker daemon (TCP instead of a Unix socket).
// Models containers/images (state, names, labels, networks, on-failure restart policy), pull by digest
// (progress stream incl. error lines) and "starts" containers as real processes:
//   node <image.dir>/launcher/index.js <Cmd...>  with env from image + container, HOSTNAME/WISHY_CONTAINER_ID = container ID.
// Fault injection: inject.pull (pull fails), inject.wrongDigest (image with a different digest),
// inject.killHelperAfterCreate (helper is killed hard right after the new container is created → restart policy).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'

export function createFakeDocker({ logDir, baseEnv = {} } = {}) {
  const registry = new Map() // "repo@digest" → { repo, digest, dir, config }
  const images = new Map() // id → { Id, RepoDigests, RepoTags, Config, dir }
  const containers = new Map() // id → container
  const creates = [] // recorded create requests (for config-fidelity checks)
  const calls = []
  const inject = { pull: false, wrongDigest: false, killHelperAfterCreate: false }

  const newId = () => randomBytes(32).toString('hex')
  const findContainer = (ref) => {
    if (!ref) return null
    const r = decodeURIComponent(ref)
    for (const c of containers.values()) if (c.Id === r || (r.length >= 12 && c.Id.startsWith(r)) || c.Name === `/${r}`) return c
    return null
  }
  const findImage = (ref) => {
    for (const i of images.values()) if (i.Id === ref || i.RepoDigests.includes(ref) || i.RepoTags.includes(ref) || (ref.length >= 12 && i.Id.replace('sha256:', '').startsWith(ref.replace('sha256:', '')))) return i
    return null
  }
  const envMap = (list) => new Map((list || []).map((e) => [e.split('=')[0], e]))

  /** Provide an image in the "registry" (repo@digest) – optionally already present locally. */
  function addRegistryImage({ repo, dir, config = {}, local = false }) {
    const digest = `sha256:${createHash('sha256').update(dir + JSON.stringify(config)).digest('hex')}`
    registry.set(`${repo}@${digest}`, { repo, digest, dir, config })
    if (local) materialize(repo, digest, dir, config, digest)
    return { repo, digest, ref: `${repo}@${digest}` }
  }
  function materialize(repo, digest, dir, config, reportDigest) {
    const id = `sha256:${createHash('sha256').update(`img:${digest}`).digest('hex')}`
    const img = { Id: id, RepoDigests: [`${repo}@${reportDigest}`], RepoTags: [], Config: { Env: [], Labels: {}, ...config }, dir }
    images.set(id, img)
    return img
  }

  function spawnContainer(c) {
    const img = images.get(c.Image)
    const env = { ...baseEnv }
    for (const e of c.Config.Env || []) {
      const i = e.indexOf('=')
      const k = e.slice(0, i)
      if (k !== 'PATH') env[k] = e.slice(i + 1)
    }
    Object.assign(env, { HOSTNAME: c.Id.slice(0, 12), WISHY_CONTAINER_ID: c.Id, WISHY_LAUNCHER_STDIN_CONTROL: '1' })
    const args = [path.join(img.dir, 'launcher', 'index.js'), ...(c.Config.Cmd || [])]
    const p = spawn(process.execPath, args, { cwd: img.dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const log = fs.createWriteStream(path.join(logDir, `container-${c.Name.replace(/^\//, '')}-${c.Id.slice(0, 8)}.log`), { flags: 'a' })
    p.stdout.pipe(log)
    p.stderr.pipe(log)
    c.proc = p
    c.State = { Status: 'running', Running: true, Restarting: false, ExitCode: 0, Pid: p.pid, StartedAt: new Date().toISOString() }
    p.on('exit', (code, sig) => {
      if (c.proc !== p) return
      c.proc = null
      const exitCode = code ?? (sig ? 137 : 0)
      c.State = { Status: 'exited', Running: false, Restarting: false, ExitCode: exitCode, FinishedAt: new Date().toISOString() }
      const rp = c.HostConfig?.RestartPolicy || {}
      if (!c.stopping && !c.removed && rp.Name === 'on-failure' && exitCode !== 0 && c.RestartCount < (rp.MaximumRetryCount || Infinity)) {
        c.RestartCount++
        c.State.Status = 'restarting'
        setTimeout(() => !c.removed && !c.proc && spawnContainer(c), 500)
      }
    })
  }

  async function stop(c, t = 10) {
    if (!c.proc) return false
    c.stopping = true
    const p = c.proc
    const done = new Promise((r) => p.once('exit', r))
    try {
      p.stdin.write('stop\n')
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => p.kill('SIGKILL'), t * 1000)
    await done
    clearTimeout(timer)
    c.stopping = false
    await new Promise((r) => setTimeout(r, 300))
    return true
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const readBody = (req) =>
    new Promise((r) => {
      let d = ''
      req.on('data', (c) => (d += c))
      req.on('end', () => {
        try {
          r(d ? JSON.parse(d) : {})
        } catch {
          r({})
        }
      })
    })

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname.replace(/^\/v1\.\d+/, '')
    calls.push(`${req.method} ${p}`)
    try {
      if (req.method === 'GET' && p === '/version') return send(res, 200, { ApiVersion: '1.45', Version: '27.0.0-fake', Os: 'linux', Arch: 'amd64', MinAPIVersion: '1.24' })
      let m
      if ((m = /^\/containers\/([^/]+)\/json$/.exec(p)) && req.method === 'GET') {
        const c = findContainer(m[1])
        if (!c) return send(res, 404, { message: 'No such container' })
        const { proc, stopping, removed, ...view } = c
        void proc
        void stopping
        void removed
        return send(res, 200, view)
      }
      if (p === '/containers/create' && req.method === 'POST') {
        const body = await readBody(req)
        const name = u.searchParams.get('name') || `c${Date.now()}`
        if (findContainer(name)) return send(res, 409, { message: `Conflict. The container name "/${name}" is already in use` })
        const img = findImage(body.Image)
        if (!img) return send(res, 404, { message: `No such image: ${body.Image}` })
        creates.push({ name, body: JSON.parse(JSON.stringify(body)) })
        const id = newId()
        const env = envMap(img.Config.Env)
        for (const e of body.Env || []) env.set(e.split('=')[0], e)
        const hc = body.HostConfig || {}
        const nets = {}
        for (const [n, ep] of Object.entries(body.NetworkingConfig?.EndpointsConfig || {})) nets[n] = { ...ep, NetworkID: `net-${n}` }
        if (!Object.keys(nets).length && !['host', 'none'].includes(hc.NetworkMode)) nets[hc.NetworkMode || 'bridge'] = { Aliases: null, NetworkID: 'net-bridge' }
        const mounts = [
          ...(hc.Binds || []).map((b) => ({ Type: 'bind', Source: b.split(':')[0], Destination: b.split(':')[1], RW: !/:ro$/.test(b) })),
          ...(hc.Mounts || []).map((x) => ({ Type: x.Type, Name: x.Type === 'volume' ? x.Source : undefined, Source: x.Source, Destination: x.Target, RW: !x.ReadOnly })),
        ]
        const c = {
          Id: id,
          Name: `/${name}`,
          Image: img.Id,
          Created: new Date().toISOString(),
          Config: {
            Hostname: id.slice(0, 12),
            Image: body.Image,
            Env: [...env.values()],
            Cmd: body.Cmd ?? img.Config.Cmd ?? null,
            Entrypoint: body.Entrypoint ?? img.Config.Entrypoint ?? null,
            Labels: { ...(img.Config.Labels || {}), ...(body.Labels || {}) },
            Healthcheck: body.Healthcheck ?? img.Config.Healthcheck,
            User: body.User ?? img.Config.User ?? '',
            WorkingDir: body.WorkingDir ?? img.Config.WorkingDir ?? '',
            ExposedPorts: body.ExposedPorts ?? img.Config.ExposedPorts,
          },
          HostConfig: { NetworkMode: 'bridge', ...hc },
          NetworkSettings: { Networks: nets },
          Mounts: mounts,
          State: { Status: 'created', Running: false, ExitCode: 0 },
          RestartCount: 0,
        }
        containers.set(id, c)
        send(res, 201, { Id: id, Warnings: [] })
        if (inject.killHelperAfterCreate && body.Labels?.['wishy.update.job'] && !body.Labels?.['wishy.role']) {
          inject.killHelperAfterCreate = false
          setTimeout(() => {
            for (const h of containers.values()) if (h.Config.Labels?.['wishy.role'] === 'updater' && h.proc) h.proc.kill('SIGKILL')
          }, 50)
        }
        return
      }
      if ((m = /^\/containers\/([^/]+)\/start$/.exec(p)) && req.method === 'POST') {
        const c = findContainer(m[1])
        if (!c) return send(res, 404, { message: 'No such container' })
        if (c.proc) return send(res, 304)
        spawnContainer(c)
        return send(res, 204)
      }
      if ((m = /^\/containers\/([^/]+)\/stop$/.exec(p)) && req.method === 'POST') {
        const c = findContainer(m[1])
        if (!c) return send(res, 404, { message: 'No such container' })
        const did = await stop(c, Number(u.searchParams.get('t') || 10))
        return send(res, did ? 204 : 304)
      }
      if ((m = /^\/containers\/([^/]+)\/rename$/.exec(p)) && req.method === 'POST') {
        const c = findContainer(m[1])
        if (!c) return send(res, 404, { message: 'No such container' })
        const name = u.searchParams.get('name')
        const other = findContainer(name)
        if (other && other !== c) return send(res, 409, { message: 'name in use' })
        c.Name = `/${name}`
        return send(res, 204)
      }
      if ((m = /^\/containers\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
        const c = findContainer(m[1])
        if (!c) return send(res, 404, { message: 'No such container' })
        if (c.proc && u.searchParams.get('force') !== '1') return send(res, 409, { message: 'container is running' })
        c.removed = true
        containers.delete(c.Id)
        send(res, 204)
        if (c.proc) setTimeout(() => c.proc?.kill('SIGKILL'), 100)
        return
      }
      if ((m = /^\/networks\/([^/]+)\/connect$/.exec(p)) && req.method === 'POST') {
        const body = await readBody(req)
        const c = findContainer(body.Container)
        if (!c) return send(res, 404, { message: 'No such container' })
        c.NetworkSettings.Networks[decodeURIComponent(m[1])] = { ...(body.EndpointConfig || {}), NetworkID: `net-${m[1]}` }
        return send(res, 200)
      }
      if (p === '/images/create' && req.method === 'POST') {
        const repo = u.searchParams.get('fromImage')
        const digest = u.searchParams.get('tag')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write(JSON.stringify({ status: `Pulling from ${repo}`, id: digest }) + '\n')
        const entry = registry.get(`${repo}@${digest}`)
        if (inject.pull || !entry) {
          res.end(JSON.stringify({ errorDetail: { message: inject.pull ? 'injected pull failure' : 'manifest unknown' }, error: inject.pull ? 'injected pull failure' : 'manifest unknown' }) + '\n')
          return
        }
        res.write(JSON.stringify({ status: 'Downloading', progressDetail: { current: 50, total: 100 }, id: 'layer' }) + '\n')
        const report = inject.wrongDigest ? `sha256:${'0'.repeat(64)}` : digest
        materialize(repo, inject.wrongDigest ? report : digest, entry.dir, entry.config, report)
        res.end(JSON.stringify({ status: `Digest: ${report}` }) + '\n')
        return
      }
      if ((m = /^\/images\/(.+)\/json$/.exec(p)) && req.method === 'GET') {
        const img = findImage(decodeURIComponent(m[1]))
        return img ? send(res, 200, { Id: img.Id, RepoDigests: img.RepoDigests, RepoTags: img.RepoTags, Config: img.Config }) : send(res, 404, { message: 'No such image' })
      }
      if ((m = /^\/images\/(.+)$/.exec(p)) && req.method === 'DELETE') {
        const img = findImage(decodeURIComponent(m[1]))
        if (!img) return send(res, 404, { message: 'No such image' })
        if ([...containers.values()].some((c) => c.Image === img.Id)) return send(res, 409, { message: 'image is being used' })
        images.delete(img.Id)
        return send(res, 200, [{ Deleted: img.Id }])
      }
      send(res, 404, { message: `fake: not implemented ${req.method} ${p}` })
    } catch (e) {
      send(res, 500, { message: e.message })
    }
  })

  return {
    server,
    inject,
    creates,
    calls,
    containers,
    images,
    addRegistryImage,
    findContainer,
    /** Create + start a container directly (like `docker compose up`). */
    async run(name, body, connect = []) {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/v1.45/containers/create?name=${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const { Id } = await r.json()
      for (const n of connect) await fetch(`http://127.0.0.1:${server.address().port}/v1.45/networks/${n.network}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Container: Id, EndpointConfig: n.endpoint }) })
      await fetch(`http://127.0.0.1:${server.address().port}/v1.45/containers/${Id}/start`, { method: 'POST' })
      return Id
    },
    async stopAll() {
      for (const c of containers.values()) {
        c.removed = true
        if (c.proc) await stop(c, 15)
      }
    },
  }
}
