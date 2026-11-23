// MUST be the first import in server/index.js: applies a prepared restore BEFORE db.js
// opens the database (files can only be swapped safely while unopened – especially on Windows).
import fs from 'node:fs'
import path from 'node:path'
import { applyPendingRestore } from './backup-core.js'

const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
fs.mkdirSync(DATA_DIR, { recursive: true })
try {
  applyPendingRestore(DATA_DIR)
} catch (e) {
  console.error('[restore] Pending restore could not be applied:', e)
}
