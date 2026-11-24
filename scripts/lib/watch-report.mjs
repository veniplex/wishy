#!/usr/bin/env node
// Builds the issue text for the weekly security watcher (.github/workflows/watch.yml).
//   node scripts/lib/watch-report.mjs --trivy trivy.json --audit audit.json --components components.json
//        [--last last.release.json] [--base-tag node:26-alpine] [--pinned-digest sha256:...] [--latest-digest sha256:...]
//        [--ref v1.0.0] [--out report.md]
// Inputs:
//   trivy.json       Trivy JSON report of the freshly built image (HIGH/CRITICAL, unfixed findings already filtered)
//   audit.json       output of `npm audit --omit=dev --json`
//   components.json  component list of the freshly built image (/app/components.json)
//   last.release.json  release metadata of the latest stable release (its `components` are the comparison baseline)
// Writes the Markdown body to --out and, when GITHUB_OUTPUT is set, `findings=true|false`.
// Always exits 0 (a report is data, not a failure); exits 1 only for unusable arguments.
import fs from 'node:fs'

const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const readJson = (file) => {
  if (!file || !fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
if (!opt('components') || !opt('out')) {
  console.error('Usage: node scripts/lib/watch-report.mjs --trivy f --audit f --components f [--last f] [--base-tag t] [--pinned-digest d] [--latest-digest d] [--ref r] --out report.md')
  process.exit(1)
}

const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1 }
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const table = (head, rows) => `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n')}\n`
const LIMIT = 40

// --- 1. Image vulnerabilities (Trivy): fixable HIGH/CRITICAL ---------------------------------------------------------
const imageRows = []
const seen = new Set()
for (const res of readJson(opt('trivy'))?.Results || []) {
  for (const v of res.Vulnerabilities || []) {
    if (!v.FixedVersion || !(v.Severity in SEVERITY_RANK)) continue
    const key = `${v.PkgName}|${v.InstalledVersion}|${v.VulnerabilityID}`
    if (seen.has(key)) continue
    seen.add(key)
    imageRows.push({ pkg: v.PkgName, from: v.InstalledVersion, to: v.FixedVersion, severity: v.Severity, id: v.VulnerabilityID })
  }
}
imageRows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.pkg.localeCompare(b.pkg))

// --- 2. npm audit (production dependencies): HIGH/CRITICAL with an available fix -----------------------------------
const npmRows = []
for (const [name, v] of Object.entries(readJson(opt('audit'))?.vulnerabilities || {})) {
  const severity = String(v.severity || '').toUpperCase()
  if (!(severity in SEVERITY_RANK) || !v.fixAvailable) continue
  const advisory = (v.via || []).find((x) => typeof x === 'object')
  const fix = typeof v.fixAvailable === 'object' ? `${v.fixAvailable.name}@${v.fixAvailable.version}` : 'update available'
  npmRows.push({ pkg: name, from: v.range || '', to: fix, severity, id: advisory?.url?.split('/').pop() || advisory?.title || '' })
}
npmRows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.pkg.localeCompare(b.pkg))

// --- 3. Newer components than in the latest release / newer base image digest --------------------------------------
const now = readJson(opt('components')) || {}
const last = readJson(opt('last'))?.components || null
const componentRows = []
if (last) {
  const cmp = (label, a, b) => {
    if (a && b && a !== b) componentRows.push([label, a, b])
  }
  cmp('Node.js', last.node, now.node)
  cmp('Chromium', last.chromium, now.chromium)
  cmp('Alpine', last.os, now.os)
}
const pinned = opt('pinned-digest')
const latest = opt('latest-digest')
const baseDigestNewer = Boolean(pinned && latest && pinned !== latest)

const findings = imageRows.length > 0 || npmRows.length > 0 || componentRows.length > 0 || baseDigestNewer

// --- Markdown ---------------------------------------------------------------------------------------------------------
let md = ''
if (findings) {
  md += `The weekly security watcher found updates for the container image built from \`${opt('ref') || 'main'}\`.\n\n`
  if (imageRows.length) {
    md += `### Fixable vulnerabilities in the image (HIGH/CRITICAL)\n\n`
    md += table(['Package', 'Installed → fixed', 'Severity', 'CVE'], imageRows.slice(0, LIMIT).map((r) => [r.pkg, `${r.from} → ${r.to}`, r.severity, r.id]))
    if (imageRows.length > LIMIT) md += `\n_${imageRows.length - LIMIT} more not shown._\n`
    md += '\n'
  }
  if (npmRows.length) {
    md += `### Fixable vulnerabilities in npm production dependencies (HIGH/CRITICAL)\n\n`
    md += table(['Package', 'Vulnerable range → fix', 'Severity', 'Advisory'], npmRows.slice(0, LIMIT).map((r) => [r.pkg, `${r.from} → ${r.to}`, r.severity, r.id]))
    md += '\n'
  }
  if (componentRows.length) {
    md += `### Newer base components than in the latest release\n\n`
    md += table(['Component', 'Latest release', 'Now available'], componentRows)
    md += '\n'
  }
  if (baseDigestNewer) {
    md += `### Newer base image digest\n\n`
    md += `\`${opt('base-tag') || 'node'}\` now points to \`${latest}\`; the Dockerfile pins \`${pinned}\`.\n\n`
  }
  md += `### Recommendation\n\n`
  md += `Merge the open Dependabot pull requests (base image digest, npm packages) once CI is green, then cut a new release (see "Keeping the base image current" in docs/RELEASING.md). `
  md += `Installations pick the new image up through Admin › Updates or \`docker compose pull\`.\n\n`
  md += `_This issue is maintained by the \`Security watcher\` workflow and closes automatically when a later run finds nothing._\n`
}
fs.writeFileSync(opt('out'), md)
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${findings}\n`)
console.log(`watch-report: ${imageRows.length} image, ${npmRows.length} npm, ${componentRows.length} component finding(s), base digest ${baseDigestNewer ? 'newer' : 'current'} -> findings=${findings}`)
