#!/usr/bin/env node
// Command line for operations and the launcher. Runs while the app is STOPPED (otherwise only 'create'/'verify'/'schema-info').
//   node server/wishy-cli.js pre-update --target <version> [--job id]  (launcher; env WISHY_KEEP_SESSION = session to keep)
//   node server/wishy-cli.js stage-restore <file> [--db-only]           (launcher rollback: the backup's sessions are kept)
//   node server/wishy-cli.js restore <file>                             (manual; all sessions are ended)
//   node server/wishy-cli.js create [--label x]                        (manual backup, encrypted as configured)
//   node server/wishy-cli.js verify <file>
//   node server/wishy-cli.js schema-info
// Output: the last line is JSON { ok, ... }. DATA_DIR as for the app.
// Passphrases for encrypted backups: BACKUP_PASSPHRASE, the backup's rollback key, stored setting.
import fs from 'node:fs'
import path from 'node:path'
import { createBackup, stageRestore, readBackup, pruneBackups, paths, isEncryptedFile, readRollbackKey, writeRollbackKey } from './backup-core.js'

const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
const APP_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const [cmd, ...rest] = process.argv.slice(2)
const opt = (name) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}
const flag = (name) => rest.includes(`--${name}`)
const VALUE_OPTS = new Set(['--target', '--job', '--label'])
const arg0 = rest.find((x, i) => !x.startsWith('--') && !(i > 0 && VALUE_OPTS.has(rest[i - 1])))
const out = (o) => console.log(JSON.stringify(o))
const resolveFile = (f) => {
  if (!f) throw new Error('File missing')
  const p = fs.existsSync(f) ? f : path.join(paths(DATA_DIR).backups, path.basename(f))
  if (!fs.existsSync(p)) throw new Error(`File not found: ${f}`)
  return path.resolve(p)
}

/** Read settings via config.js (opens the DB) – only when really needed. */
async function storedSettings() {
  const { getSys, getSecretSys } = await import('./config.js')
  return { encrypt: !!getSys('backup_encrypt'), passphrase: process.env.BACKUP_PASSPHRASE || getSecretSys('backup_passphrase') || null, keepPre: Number(getSys('backup_keep_pre_update') ?? 5) || 5 }
}

async function passphrasesFor(file) {
  const list = [process.env.BACKUP_PASSPHRASE, readRollbackKey(DATA_DIR, path.basename(file))].filter(Boolean)
  if (!list.length && isEncryptedFile(file)) {
    try {
      const s = await storedSettings()
      if (s.passphrase) list.push(s.passphrase)
    } catch {
      /* DB unreadable – then proceed without */
    }
  }
  return list
}

async function main() {
  switch (cmd) {
    case 'pre-update': {
      const { db } = await import('./db.js')
      const s = await storedSettings()
      const keep = process.env.WISHY_KEEP_SESSION || ''
      const n = db.prepare('DELETE FROM sessions WHERE id != ?').run(keep).changes
      const target = opt('target') || ''
      const pass = s.encrypt && s.passphrase ? s.passphrase : null
      const b = await createBackup({ dataDir: DATA_DIR, db, reason: 'pre-update', label: target ? `pre-${target.replace('+', '-')}` : '', appVersion: APP_VERSION, passphrase: pass })
      if (pass) writeRollbackKey(DATA_DIR, b.name, pass)
      db.close()
      pruneBackups(DATA_DIR, { keep_last: 0, keep_days: 0, keep_pre_update: s.keepPre })
      return out({ ok: true, file: path.join(paths(DATA_DIR).backups, b.name), encrypted: !!pass, sessions_revoked: n, schema_version: b.schema_version })
    }
    case 'stage-restore':
    case 'restore': {
      const file = resolveFile(arg0)
      const r = await stageRestore({
        dataDir: DATA_DIR,
        file,
        passphrases: await passphrasesFor(file),
        mode: cmd === 'restore' ? 'restore' : 'rollback',
        dbOnly: cmd === 'stage-restore' && flag('db-only'),
        actor: { via: 'system', label: cmd === 'restore' ? 'cli' : 'launcher' },
      })
      return out({ ok: true, staged: path.basename(file), db_only: cmd === 'stage-restore' && flag('db-only'), schema_version: r.schema_version })
    }
    case 'create': {
      const s = await storedSettings()
      const { db } = await import('./db.js')
      const b = await createBackup({ dataDir: DATA_DIR, db, reason: 'manual', label: opt('label') || 'cli', appVersion: APP_VERSION, passphrase: s.encrypt || process.env.BACKUP_PASSPHRASE ? s.passphrase : null })
      return out({ ok: true, file: path.join(paths(DATA_DIR).backups, b.name), encrypted: b.encrypted })
    }
    case 'verify': {
      const file = resolveFile(arg0)
      const r = await readBackup(file, { passphrases: await passphrasesFor(file) })
      return out({ ok: true, manifest: { ...r.manifest, files: Object.keys(r.manifest.files).length } })
    }
    case 'schema-info': {
      const { DatabaseSync } = await import('node:sqlite')
      const { fingerprintOf } = await import('./backup-core.js')
      const h = new DatabaseSync(paths(DATA_DIR).db)
      const uv = Number(h.prepare('PRAGMA user_version').get().user_version) || 0
      const fp = fingerprintOf(h)
      h.close()
      return out({ ok: true, schema_version: uv, fingerprint: fp, app_version: APP_VERSION })
    }
    default:
      console.error('Commands: pre-update | stage-restore <file> [--db-only] | restore <file> | create | verify <file> | schema-info')
      process.exit(2)
  }
}

main().catch((e) => {
  out({ ok: false, error: e.message, code: e.code })
  process.exit(1)
})
