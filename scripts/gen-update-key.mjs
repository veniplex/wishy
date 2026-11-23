#!/usr/bin/env node
// Generates the Ed25519 key pair for signed Wishy updates.
//   node scripts/gen-update-key.mjs                -> writes launcher/update-key.pub, prints the private key ONCE
//   node scripts/gen-update-key.mjs --out <pub> --private-out <file> [--force]   (e.g. for tests)
// Store the private key (Base64 line) as the GitHub secret WISHY_UPDATE_KEY and nowhere else.
import fs from 'node:fs'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const out = path.resolve(opt('out') || path.join(root, 'launcher', 'update-key.pub'))
const privOut = opt('private-out')
if (fs.existsSync(out) && !args.includes('--force')) {
  console.error(`${out} already exists. Overwrite with --force (old images will then reject new updates!).`)
  process.exit(1)
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, pubPem)
if (privOut) {
  fs.writeFileSync(path.resolve(privOut), privPem, { mode: 0o600 })
  console.log(`Public key:  ${out}\nPrivate key: ${path.resolve(privOut)}`)
} else {
  console.log(`Public key written: ${out} (commit this file)\n`)
  console.log('PRIVATE KEY - store it now as the GitHub secret "WISHY_UPDATE_KEY" (Settings > Secrets and variables > Actions).')
  console.log('It will not be shown again. Anyone who holds it can sign updates for all installations.\n')
  console.log(privB64)
  console.log('\n(The same key as PEM, in case you want to back it up offline:)\n')
  console.log(privPem)
}
