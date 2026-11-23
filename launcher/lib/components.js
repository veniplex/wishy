// Component inventory of the base ("SBOM light"): app, Node, launcher, Chromium version and Alpine packages.
// Written as /app/components.json at image build time and carried into the release metadata, so that
// the UI can show what an update changes ("Node 24.16 -> 24.17, 12 system packages updated").
//   node launcher/lib/components.js --app <dir> --out <datei>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LAUNCHER_VERSION } from './release.js'

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim()
  } catch {
    return null
  }
}

export function collectComponents({ appDir, env = process.env } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const apk = run('apk', ['info', '-v'])
  const os_packages = {}
  if (apk) {
    for (const line of apk.split('\n')) {
      const m = /^(.+)-([^-]+-r\d+)$/.exec(line.trim())
      if (m) os_packages[m[1]] = m[2]
    }
  }
  const chromePath = env.CHROME_PATH || '/usr/bin/chromium'
  const chromium = fs.existsSync(chromePath) ? (run(chromePath, ['--version']) || '').replace(/^[^\d]*/, '') || null : null
  let osRelease = null
  try {
    osRelease = /VERSION_ID=(.+)/.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1]?.replace(/"/g, '') || null
  } catch {
    /* not Linux */
  }
  return {
    app: pkg.version,
    node: process.versions.node,
    launcher: LAUNCHER_VERSION,
    chromium,
    os: osRelease ? `alpine ${osRelease}` : null,
    base_image: env.WISHY_BASE_IMAGE || null,
    os_packages,
    built_at: new Date().toISOString(),
  }
}

/** Differences between two inventories (without timestamps). */
export function diffComponents(a, b) {
  if (!a || !b) return null
  const ch = (k) => (a[k] !== b[k] ? { from: a[k] ?? null, to: b[k] ?? null } : null)
  const pa = a.os_packages || {}
  const pb = b.os_packages || {}
  const updated = Object.keys(pb).filter((k) => k in pa && pa[k] !== pb[k])
  const added = Object.keys(pb).filter((k) => !(k in pa))
  const removed = Object.keys(pa).filter((k) => !(k in pb))
  const os = updated.length + added.length + removed.length
  return {
    app: ch('app'),
    node: ch('node'),
    launcher: ch('launcher'),
    chromium: ch('chromium'),
    os: ch('os'),
    os_packages: os ? { updated: updated.length, added: added.length, removed: removed.length, examples: updated.slice(0, 8).map((k) => `${k} ${pa[k]} → ${pb[k]}`) } : null,
  }
}

/** Same content (for "only publish if something changed")? */
export const sameComponents = (a, b) => {
  const d = diffComponents(a, b)
  return !!d && !d.node && !d.chromium && !d.os && !d.os_packages && !d.launcher && !d.app
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = (n) => {
    const i = args.indexOf(`--${n}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const c = collectComponents({ appDir: path.resolve(opt('app') || '.') })
  const json = JSON.stringify(c, null, 2) + '\n'
  if (opt('out')) fs.writeFileSync(opt('out'), json)
  else process.stdout.write(json)
}
