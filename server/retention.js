// Retention: audit log, AI usage (with daily rollup before deletion), old sessions.
// Runs daily and at startup; manually via POST /api/admin/retention/run.
import { db } from './db.js'
import { getSys, setSys } from './config.js'
import { audit } from './audit.js'
import { requireAdmin } from './session.js'
import { rollupBefore } from './ai/usage.js'
import { bad } from './util.js'

const DAY = 86_400_000
const DEFAULTS = { retention_audit_days: 365, retention_ai_usage_days: 730, retention_sessions_days: 90 }
const KEYS = Object.keys(DEFAULTS)

export function getRetention() {
  const out = {}
  for (const k of KEYS) {
    const v = getSys(k)
    out[k] = v !== null && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : DEFAULTS[k]
  }
  return out
}

const dayBefore = (days, now) => new Date(now - days * DAY).toISOString().slice(0, 10)

/**
 * Runs the cleanup. 0 days = keep indefinitely.
 * @param {object} ctx Context for the audit entry (the admin's request or { via: 'system' })
 * @param {{ now?: number }} [opts]
 */
export function runRetention(ctx = { via: 'system' }, { now = Date.now() } = {}) {
  const cfg = getRetention()
  const res = { audit_deleted: 0, ai_rows_rolled_up: 0, ai_days_rolled_up: 0, sessions_deleted: 0, client_ops_deleted: 0 }
  try {
    if (cfg.retention_audit_days > 0) {
      const cutoff = new Date(now - cfg.retention_audit_days * DAY).toISOString()
      res.audit_deleted = Number(db.prepare('DELETE FROM audit_log WHERE at<?').run(cutoff).changes)
    }
    if (cfg.retention_ai_usage_days > 0) {
      const r = rollupBefore(dayBefore(cfg.retention_ai_usage_days, now))
      res.ai_rows_rolled_up = r.rows
      res.ai_days_rolled_up = r.days
    }
    if (cfg.retention_sessions_days > 0) {
      const cutoff = now - cfg.retention_sessions_days * DAY
      res.sessions_deleted = Number(db.prepare('DELETE FROM sessions WHERE expires_at<? OR created_at<?').run(cutoff, cutoff).changes)
    }
    // Idempotency records of offline writes (offline-ops.js) are only needed while a client may still repeat a request
    res.client_ops_deleted = Number(db.prepare('DELETE FROM client_ops WHERE created_at < ?').run(new Date(now - 90 * DAY).toISOString().slice(0, 19).replace('T', ' ')).changes)
    const at = new Date(now).toISOString()
    setSys('retention_last_run', { at, ...res, trigger: ctx?.via === 'system' ? 'auto' : 'manual' })
    audit(ctx, 'retention.cleanup', { details: { ...cfg, ...res }, target: { type: 'system' } })
    return { ok: true, at, ...res }
  } catch (e) {
    audit(ctx, 'retention.cleanup', { status: 'fail', details: { error: String(e?.message).slice(0, 200) } })
    throw e
  }
}

function overview() {
  const n = (sql) => db.prepare(sql).get()
  return {
    ...getRetention(),
    last_run: getSys('retention_last_run') ?? null,
    stats: {
      audit_rows: n('SELECT COUNT(*) AS n FROM audit_log').n,
      audit_oldest: n('SELECT MIN(at) AS v FROM audit_log').v,
      ai_usage_rows: n('SELECT COUNT(*) AS n FROM ai_usage').n,
      ai_usage_oldest: n('SELECT MIN(created_at) AS v FROM ai_usage').v,
      ai_usage_daily_rows: n('SELECT COUNT(*) AS n FROM ai_usage_daily').n,
      sessions: n('SELECT COUNT(*) AS n FROM sessions').n,
    },
  }
}

let timer
/** Schedules the daily cleanup; first run shortly after startup. */
export function startRetention() {
  if (timer) return
  const run = () => {
    try {
      runRetention({ via: 'system' })
    } catch (e) {
      console.error('[retention]', e?.message)
    }
  }
  setTimeout(run, 5_000).unref()
  timer = setInterval(run, DAY)
  timer.unref()
}

export function retentionRoutes(app) {
  app.get('/api/admin/retention', requireAdmin, (req, res) => res.json(overview()))

  app.put('/api/admin/retention', requireAdmin, (req, res) => {
    const b = req.body || {}
    const upd = {}
    for (const k of KEYS) {
      if (b[k] === undefined) continue
      const v = Number(b[k])
      if (b[k] === null || b[k] === '' || !Number.isInteger(v) || v < 0 || v > 36_500) {
        throw Object.assign(bad('Please enter a whole number between 0 and 36500 (0 = unlimited)'), { code: 'invalid_value' })
      }
      upd[k] = v
    }
    for (const [k, v] of Object.entries(upd)) setSys(k, v)
    res.json(overview())
  })

  app.post('/api/admin/retention/run', requireAdmin, (req, res) => {
    const r = runRetention(req)
    res.json({ ...r, ...overview() })
  })
}
