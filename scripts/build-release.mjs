#!/usr/bin/env node
// Builds a release artifact (used by CI and for local tests).
//
//   node scripts/build-release.mjs [--version 1.2.3] [--out release] [--build]
//        [--key <pem-file>]  local/tests only: sign right away (CI signs separately with scripts/sign-release.mjs)
//        [--stage-only <dir>]   only stage the files (Docker build, tests)
//        [--from-staging <dir>] pack an already staged directory
//        [--meta-only]                  only write wishy-<v>.release.json (adds the image digest to the metadata
//                                       after the image push)
//        [--image ghcr.io/veniplex/wishy --image-digest sha256:…] [--components components.json]
//        [--min-launcher n] [--allow-native]
//
// Output in --out: wishy-<v>.tar.gz, .tar.gz.sha256, wishy-<v>.release.json (+ .sig with a key)
// Version: plain semver, default is the version from package.json.
// Contents: dist/, server/, launcher/, package.json, package-lock.json, LICENSE, release.json and the PRODUCTION
// dependencies according to package-lock.json (copied from the local node_modules - run `npm ci` first).
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { tarStream } from '../launcher/lib/tar.js'
import { LAUNCHER_VERSION, artifactName, metaName, loadPrivateKey, signRelease, validVersion, parseSemver, sha256Buf } from '../launcher/lib/release.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = (n) => args.includes(`--${n}`)
const die = (m) => {
  console.error(`build-release: ${m}`)
  process.exit(1)
}

function stage(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = parseSemver(opt('version') || pkg.version)?.version
  if (!validVersion(version)) die(`invalid version ${opt('version')}`)
  if (flag('build')) {
    const r = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
    if (r.status !== 0) die('npm run build failed')
  }
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) die('dist/ is missing - run `npm run build` first (or pass --build)')
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const d of ['dist', 'server', 'launcher']) fs.cpSync(path.join(root, d), path.join(dir, d), { recursive: true, dereference: false })
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE')) // every copy must come with the license text
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(dir, 'package-lock.json'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2) + '\n')

  // Production dependencies from the lockfile
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  let copied = 0
  const scripts = []
  for (const [key, meta] of Object.entries(lock.packages || {})) {
    if (!key.startsWith('node_modules/') || meta.dev || meta.link) continue
    const src = path.join(root, ...key.split('/'))
    if (!fs.existsSync(src)) {
      if (meta.optional || meta.devOptional) continue
      die(`${key} is missing in node_modules - run \`npm ci\` first`)
    }
    if (meta.hasInstallScript) scripts.push(key)
    fs.cpSync(src, path.join(dir, ...key.split('/')), {
      recursive: true,
      dereference: false,
      filter: (s) => {
        const rel = path.relative(src, s)
        return !rel.split(path.sep).includes('node_modules') && !rel.split(path.sep).includes('.bin')
      },
    })
    copied++
  }
  // No native modules allowed (the image has no compiler, releases run on several architectures)
  const native = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isSymbolicLink()) die(`Symlink not allowed in a release: ${path.relative(dir, p)}`)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.node') || e.name === 'binding.gyp') native.push(path.relative(dir, p))
    }
  }
  walk(path.join(dir, 'node_modules'))
  if (native.length && !flag('allow-native')) die(`native modules found (not allowed):\n  ${native.join('\n  ')}`)
  if (scripts.length) console.warn(`Note: packages with install scripts (NOT executed in the release): ${scripts.join(', ')}`)
  const nodeMajor = Number(String(pkg.engines?.node || '').match(/\d+/)?.[0] || process.versions.node.split('.')[0])
  const release = {
    version,
    built_at: process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : new Date().toISOString(),
    node: nodeMajor,
    min_launcher: Number(opt('min-launcher') || LAUNCHER_VERSION),
  }
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release, null, 2) + '\n')
  console.log(`Staged: ${dir} (version ${version}, ${copied} packages)`)
  return release
}

function listFiles(dir) {
  const out = []
  const walk = (d, rel) => {
    const ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of ents) {
      const p = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) die(`Symlink not allowed: ${r}`)
      if (e.isDirectory()) {
        out.push({ name: r, type: 'dir' })
        walk(p, r)
      } else if (e.isFile()) out.push({ name: r, type: 'file', file: p })
    }
  }
  walk(dir, '')
  return out
}

async function pack(dir, outDir) {
  const rel = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  if (rel.version !== pkg.version) die('release.json and package.json have different versions')
  fs.mkdirSync(outDir, { recursive: true })
  const name = artifactName(rel.version)
  const file = path.join(outDir, name)
  const mtime = Date.parse(rel.built_at) || Date.now()
  const files = listFiles(dir)
  async function* entries() {
    for (const f of files) {
      if (f.type === 'dir') yield { name: f.name, type: 'dir', mtime }
      else {
        const st = fs.statSync(f.file)
        yield { name: f.name, type: 'file', size: st.size, mtime, mode: st.mode & 0o111 ? 0o755 : 0o644, body: st.size < 4 * 1024 * 1024 ? fs.readFileSync(f.file) : fs.createReadStream(f.file) }
      }
    }
  }
  await pipeline(Readable.from(tarStream(entries())), createGzip({ level: 6 }), fs.createWriteStream(file))
  const h = createHash('sha256')
  for await (const c of fs.createReadStream(file)) h.update(c)
  const sha = h.digest('hex')
  fs.writeFileSync(`${file}.sha256`, `${sha}  ${name}\n`)
  writeMeta(rel, outDir, { app_artifact: { name, sha256: sha, size: fs.statSync(file).size } })
  const key = signingKey()
  if (key) fs.writeFileSync(`${file}.sig`, signRelease(key, name, sha) + '\n')
  console.log(`Artifact: ${file} (${Math.round(fs.statSync(file).size / 1e5) / 10} MB, sha256 ${sha.slice(0, 12)}…)`)
  return { file, sha }
}

function signingKey() {
  const keyText = opt('key') ? fs.readFileSync(opt('key'), 'utf8') : null
  return keyText ? loadPrivateKey(keyText) : null
}

/** Signable release metadata: version, compatibility, optionally image (repository + digest) and the component list. */
function writeMeta(rel, outDir, extra = {}) {
  const meta = { ...rel, ...extra }
  if (opt('image') || opt('image-digest')) {
    if (!/^sha256:[0-9a-f]{64}$/.test(String(opt('image-digest')))) die('--image-digest must be sha256:<64 hex>')
    meta.image = { repository: String(opt('image')).toLowerCase(), digest: opt('image-digest') }
  }
  if (opt('components')) meta.components = JSON.parse(fs.readFileSync(opt('components'), 'utf8'))
  fs.mkdirSync(outDir, { recursive: true })
  const name = metaName(rel.version)
  const text = JSON.stringify(meta, null, 2) + '\n'
  fs.writeFileSync(path.join(outDir, name), text)
  const key = signingKey()
  if (key) fs.writeFileSync(path.join(outDir, `${name}.sig`), signRelease(key, name, sha256Buf(Buffer.from(text))) + '\n')
  console.log(`Metadata: ${path.join(outDir, name)}${meta.image ? ` (Image ${meta.image.repository}@${meta.image.digest.slice(0, 19)}…)` : ''}`)
}

const outDir = path.resolve(opt('out') || path.join(root, 'release'))
if (flag('meta-only')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = parseSemver(opt('version') || pkg.version)?.version
  if (!validVersion(version)) die('invalid version')
  const prev = fs.existsSync(path.join(outDir, metaName(version))) ? JSON.parse(fs.readFileSync(path.join(outDir, metaName(version)), 'utf8')) : {}
  const nodeMajor = Number(String(pkg.engines?.node || '').match(/\d+/)?.[0] || process.versions.node.split('.')[0])
  writeMeta({ version, built_at: prev.built_at || new Date().toISOString(), node: prev.node || nodeMajor, min_launcher: prev.min_launcher || Number(opt('min-launcher') || LAUNCHER_VERSION) }, outDir, prev.app_artifact ? { app_artifact: prev.app_artifact } : {})
} else if (opt('stage-only')) stage(path.resolve(opt('stage-only')))
else if (opt('from-staging')) await pack(path.resolve(opt('from-staging')), outDir)
else {
  const tmp = path.join(outDir, `.staging-${process.pid}`)
  stage(tmp)
  try {
    await pack(tmp, outDir)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
