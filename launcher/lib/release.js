// Shared release helpers: compare versions, verify signatures, read release metadata.
// Used by launcher/, server/update.js and scripts/.
//
// Versions: plain semver (package.json), optionally with a prerelease, e.g. 1.4.2 or 1.5.0-rc.1.
// No build metadata. Base image / Node updates ship as normal releases.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, createPublicKey, verify as edVerify, sign as edSign, createPrivateKey } from 'node:crypto'

/** Protocol version of the launcher. Only increase if new releases need a newer launcher. */
export const LAUNCHER_VERSION = 2

// ---------------------------------------------------------------- Versionen

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v ?? '').trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [], version: `${m[1]}.${m[2]}.${m[3]}${m[4] ? '-' + m[4] : ''}` }
}

/** semver precedence. <0 if a<b. Invalid versions sort lower than valid ones. */
export function compareSemver(a, b) {
  const x = typeof a === 'string' ? parseSemver(a) : a
  const y = typeof b === 'string' ? parseSemver(b) : b
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k]
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) {
      if (+p !== +q) return +p - +q
    } else if (pn !== qn) return pn ? -1 : 1
    else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

export const validVersion = (v) => !!parseSemver(v) && /^[0-9A-Za-z.-]{1,64}$/.test(String(v))

// ---------------------------------------------------------------- Artefakte & Signaturen

export const artifactName = (version) => `wishy-${version}.tar.gz`
export const metaName = (version) => `wishy-${version}.release.json`

/**
 * Ed25519 signs a message with domain separation, file name (contains the version) and SHA-256.
 * This allows streaming verification, and an old, correctly signed archive cannot pass as another version.
 * Applies to the app archive (wishy-<v>.tar.gz.sig) and to the release metadata (wishy-<v>.release.json.sig).
 */
export const signatureMessage = (fileName, sha256hex) => Buffer.from(`wishy-release-v1\n${fileName}\n${sha256hex.toLowerCase()}\n`, 'utf8')

export function loadPublicKey(text) {
  const t = String(text ?? '').trim()
  if (!t) return null
  if (t.includes('BEGIN PUBLIC KEY')) return createPublicKey(t)
  return createPublicKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'spki' })
}

export function loadPrivateKey(text) {
  const t = String(text ?? '').trim()
  if (t.includes('BEGIN PRIVATE KEY')) return createPrivateKey(t)
  return createPrivateKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'pkcs8' })
}

export const signRelease = (privateKey, fileName, sha256hex) => edSign(null, signatureMessage(fileName, sha256hex), privateKey).toString('base64')

export function verifyRelease(publicKey, fileName, sha256hex, sigText) {
  if (!publicKey) return false
  let sig
  try {
    sig = Buffer.from(String(sigText).trim(), 'base64')
  } catch {
    return false
  }
  if (sig.length !== 64) return false
  try {
    return edVerify(null, signatureMessage(fileName, sha256hex), publicKey, sig)
  } catch {
    return false
  }
}

export const sha256Buf = (b) => createHash('sha256').update(b).digest('hex')

export async function sha256File(file) {
  const h = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) h.update(chunk)
  return h.digest('hex')
}

/** First 64-character hex string from a .sha256 file. */
export function parseSha256File(text) {
  const m = /\b([0-9a-fA-F]{64})\b/.exec(String(text))
  return m ? m[1].toLowerCase() : null
}

const IMAGE_REPO_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

/**
 * Verifies signed release metadata (JSON text + signature) and returns the parsed object.
 * Throws on an invalid signature or implausible content.
 */
export function verifyReleaseMeta(publicKey, version, text, sigText) {
  const name = metaName(version)
  if (!verifyRelease(publicKey, name, sha256Buf(Buffer.from(text, 'utf8')), sigText)) {
    const e = new Error('Release metadata signature invalid')
    e.code = 'signature_invalid'
    throw e
  }
  const meta = JSON.parse(text)
  if (meta.version !== version) throw Object.assign(new Error('Release metadata does not match the version'), { code: 'release_invalid' })
  if (meta.image) {
    if (!IMAGE_REPO_RE.test(String(meta.image.repository || '')) || !DIGEST_RE.test(String(meta.image.digest || ''))) {
      throw Object.assign(new Error('Invalid image reference in the release metadata'), { code: 'release_invalid' })
    }
  }
  return meta
}

export const imageRef = (img) => `${img.repository}@${img.digest}`

/** release.json + components.json of a release directory (or the baseline). */
export function readReleaseInfo(dir) {
  let pkg = null
  let rel = null
  let comp = null
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  try {
    rel = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'))
  } catch {
    rel = null
  }
  try {
    comp = JSON.parse(fs.readFileSync(path.join(dir, 'components.json'), 'utf8'))
  } catch {
    comp = null
  }
  const version = rel?.version || pkg?.version
  if (!validVersion(version)) return null
  if (pkg?.version && version !== pkg.version) return null
  if (!fs.existsSync(path.join(dir, 'server', 'index.js'))) return null
  return {
    version,
    node: Number(rel?.node || 0) || null,
    min_launcher: Number(rel?.min_launcher || 1),
    built_at: rel?.built_at ?? null,
    components: comp,
    dir,
  }
}

/** Checks whether this launcher/Node version can run the release. */
export function compatProblems(info, { launcherVersion = LAUNCHER_VERSION, nodeMajor = Number(process.versions.node.split('.')[0]) } = {}) {
  const problems = []
  if (info.min_launcher && info.min_launcher > launcherVersion) problems.push({ code: 'launcher_too_old', need: info.min_launcher, have: launcherVersion })
  if (info.node && info.node > nodeMajor) problems.push({ code: 'node_too_old', need: info.node, have: nodeMajor })
  return problems
}
