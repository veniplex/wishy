// Schema versioning via PRAGMA user_version.
//
// db.js creates the complete schema in its final form on a fresh database; the baseline is version 1 and there are no
// migration steps yet. The version stored in the database lets us
//  - refuse to run (maintenance page) / refuse to restore a backup when the database is NEWER than this code knows, and
//  - tell whether an update has migrated the database (rollback of the update then restores the pre-update backup).
//
// How to add a migration in the future:
//  1. Change the final schema in db.js (CREATE TABLE ...) so fresh databases get the new shape directly.
//  2. Below, add an idempotent step that upgrades an existing database, guarded by `schemaVersion() < n`, run it inside
//     tx(...), and call bumpSchema(n, 'short-name') afterwards, using the next free number from the list.
//  3. Register the number here.
//
// Assigned numbers:
//   1  initial schema (baseline)
import { createHash } from 'node:crypto'
import { db } from './db.js'

export const schemaVersion = (handle = db) => Number(handle.prepare('PRAGMA user_version').get().user_version) || 0

/** Raises the schema version to at least n (idempotent) and logs the step. */
let known = 0
/** Highest schema version THIS code knows (maximum of all bumpSchema calls since startup). */
export const knownSchemaVersion = () => known

export function bumpSchema(n, name) {
  n = Math.floor(Number(n))
  if (!(n > 0) || n > 1_000_000) throw new Error(`Invalid schema version: ${n}`)
  known = Math.max(known, n)
  if (schemaVersion() >= n) return false
  db.exec(`PRAGMA user_version = ${n}`)
  try {
    const r = db.prepare("SELECT value FROM system_settings WHERE key='schema_history'").get()
    const hist = r ? JSON.parse(r.value) : []
    hist.push({ version: n, name: String(name || '').slice(0, 80), at: new Date().toISOString() })
    db.prepare("INSERT INTO system_settings (key,value) VALUES ('schema_history',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      JSON.stringify(hist.slice(-100)),
    )
  } catch {
    /* the history is informational only */
  }
  return true
}

/** Fingerprint of the schema definition (tables, columns, indexes), independent of user_version. */
export function schemaFingerprint(handle = db) {
  const rows = handle
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)
}

bumpSchema(1, 'initial')
