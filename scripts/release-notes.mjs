#!/usr/bin/env node
// Writes the release notes for a version from CHANGELOG.md.
//   node scripts/release-notes.mjs <version> [--out release-notes.md] [--changelog CHANGELOG.md]
// Looks for the section "## [<version>]". For pre-releases (1.0.0-rc.1) the section of the main version (1.0.0)
// is used as a fallback. If no section is found, the script exits with code 1.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const version = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
if (!version) {
  console.error('Usage: node scripts/release-notes.mjs <version> [--out file] [--changelog file]')
  process.exit(2)
}
const file = path.resolve(opt('changelog') || path.join(root, 'CHANGELOG.md'))
if (!fs.existsSync(file)) {
  console.error(`release-notes: ${file} is missing`)
  process.exit(1)
}
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)

function section(v) {
  const head = lines.findIndex((l) => l.startsWith(`## [${v}]`))
  if (head < 0) return null
  let end = lines.findIndex((l, i) => i > head && /^## /.test(l))
  if (end < 0) end = lines.length
  const body = lines.slice(head + 1, end).join('\n').trim()
  return body || null
}

const base = version.replace(/[-+].*$/, '')
const prerelease = version.includes('-')
let body = section(version)
let from = version
if (!body && prerelease) {
  body = section(base)
  from = base
}
if (!body) {
  console.error(`release-notes: no section "## [${version}]"${prerelease ? ` (and none for ${base})` : ''} with content in ${path.basename(file)}`)
  process.exit(1)
}
const note = prerelease ? `> Pre-release ${version} - changes as per section ${from}.\n\n` : ''
const out = path.resolve(opt('out') || path.join(root, 'release-notes.md'))
fs.writeFileSync(out, `${note}${body}\n`)
console.log(`Release notes for ${version} written from section [${from}]: ${out}`)
