#!/usr/bin/env node
// Signs release files in a directory (CI signing job OR offline on a trusted machine).
//   node scripts/sign-release.mjs <dir> [--key <private-key.pem>] [--verify-with launcher/update-key.pub]
// The key can alternatively be passed via the env var WISHY_UPDATE_KEY (Base64 PKCS8 or PEM). Signs:
//   wishy-<v>.tar.gz        -> .tar.gz.sig (and checks/writes .tar.gz.sha256)
//   wishy-<v>.release.json  -> .release.json.sig (metadata incl. image digest - the basis for image updates)
import fs from 'node:fs'
import path from 'node:path'
import { loadPrivateKey, loadPublicKey, signRelease, verifyRelease, sha256File, sha256Buf, parseSha256File } from '../launcher/lib/release.js'

const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const dir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
if (!dir) {
  console.error('Usage: node scripts/sign-release.mjs <dir> [--key file] [--verify-with pub]')
  process.exit(2)
}
const keyText = opt('key') ? fs.readFileSync(opt('key'), 'utf8') : process.env.WISHY_UPDATE_KEY
if (!keyText) {
  console.error('No private key (--key or WISHY_UPDATE_KEY)')
  process.exit(1)
}
const key = loadPrivateKey(keyText)
const pub = opt('verify-with') ? loadPublicKey(fs.readFileSync(opt('verify-with'), 'utf8')) : null
let n = 0
for (const name of fs.readdirSync(dir).sort()) {
  const file = path.join(dir, name)
  let sha
  if (/^wishy-[0-9A-Za-z.-]+\.tar\.gz$/.test(name)) {
    sha = await sha256File(file)
    const shaFile = `${file}.sha256`
    if (fs.existsSync(shaFile) && parseSha256File(fs.readFileSync(shaFile, 'utf8')) !== sha) throw new Error(`${name}: .sha256 does not match`)
    fs.writeFileSync(shaFile, `${sha}  ${name}\n`)
  } else if (/^wishy-[0-9A-Za-z.-]+\.release\.json$/.test(name)) {
    sha = sha256Buf(fs.readFileSync(file))
  } else continue
  const sig = signRelease(key, name, sha)
  if (pub && !verifyRelease(pub, name, sha, sig)) throw new Error(`Private key does not match ${opt('verify-with')}`)
  fs.writeFileSync(`${file}.sig`, sig + '\n')
  console.log(`signed: ${name}`)
  n++
}
if (!n) {
  console.error('No release files found')
  process.exit(1)
}
