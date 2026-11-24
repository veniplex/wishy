import { db, tx } from '../db.js'
import { getSys, setSys } from '../config.js'
import { computeCost, getPrices, seedPrices, trackingCurrency } from './prices.js'

seedPrices()

/** Currency the stored costs are in (setting ai_usage_currency); missing = USD, i.e. a 1.0.0 database. */
function recordedCurrency() {
  const v = getSys('ai_usage_currency')
  return v && typeof v.code === 'string' && Number(v.rate) > 0 ? { code: v.code, rate: Number(v.rate) } : { code: 'USD', rate: 1 }
}

/**
 * Brings the stored costs in line with the tracking currency (invariant: ai_usage.cost, ai_usage_daily.cost and the cost cap are in it).
 * A different currency converts all costs and the cap with newRate / oldRate; the same currency with a new rate only moves the marker
 * (history stays as recorded). Runs at startup (1.0.0 databases, restored backups) and after saving the settings; idempotent.
 * @param {{ convertCap?: boolean }} opts convertCap=false when the cap was just set explicitly in the new currency
 */
export function reconcileCurrency({ convertCap = true } = {}) {
  tx(() => {
    const from = recordedCurrency()
    const to = trackingCurrency()
    if (from.code === to.code && from.rate === to.rate) return
    if (from.code !== to.code) {
      const factor = to.rate / from.rate
      db.prepare('UPDATE ai_usage SET cost=cost*? WHERE cost IS NOT NULL').run(factor)
      db.prepare('UPDATE ai_usage_daily SET cost=cost*?').run(factor)
      const cap = getSys('ai_monthly_cost_cap')
      if (convertCap && typeof cap === 'number') setSys('ai_monthly_cost_cap', Math.round(cap * factor * 100) / 100)
    }
    setSys('ai_usage_currency', to)
  })
}
reconcileCurrency()

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7)

/** Requests of the month for the limit (connection tests do not count); incl. already rolled-up days. */
export const monthlyCount = (month = monthKey()) =>
  db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE substr(created_at,1,7)=? AND feature!='test'").get(month).n +
  db.prepare("SELECT COALESCE(SUM(requests),0) AS n FROM ai_usage_daily WHERE substr(day,1,7)=? AND feature!='test'").get(month).n

/** Requests and cost (tracking currency) of a user in the month (without connection tests). */
export function userMonth(userId, month = monthKey()) {
  const a = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost),0) AS c FROM ai_usage WHERE user_id=? AND substr(created_at,1,7)=? AND feature!='test'")
    .get(userId, month)
  const b = db
    .prepare("SELECT COALESCE(SUM(requests),0) AS n, COALESCE(SUM(cost),0) AS c FROM ai_usage_daily WHERE user_id=? AND substr(day,1,7)=? AND feature!='test'")
    .get(userId, month)
  return { requests: a.n + b.n, cost: a.c + b.c }
}

/** Creates the entry at start (so it counts against the limit immediately); completed after the response. */
export function startUsage({ userId, feature, provider, model, via = 'ui' }) {
  return Number(
    db
      .prepare("INSERT INTO ai_usage (user_id, feature, provider, model, ok, error, created_at, via) VALUES (?,?,?,?,0,'running',?,?)")
      .run(userId ?? null, feature, provider, model, new Date().toISOString(), via === 'api' ? 'api' : 'ui').lastInsertRowid,
  )
}

export function finishUsage(id, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, ok, error = null, errorCode = null }) {
  const row = db.prepare('SELECT model, created_at FROM ai_usage WHERE id=?').get(id)
  if (!row) return
  const t = { input: Math.round(input), output: Math.round(output), cacheRead: Math.round(cacheRead), cacheWrite: Math.round(cacheWrite) }
  const { cost, snapshot } = computeCost(row.model, t, getPrices(), trackingCurrency())
  db.prepare(
    `UPDATE ai_usage SET input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=?, ok=?, error=?, error_code=?,
       latency_ms=?, cost=?, price_snapshot=? WHERE id=?`,
  ).run(
    t.input, t.output, t.cacheRead, t.cacheWrite, ok ? 1 : 0, error ? String(error).slice(0, 300) : null,
    errorCode ? String(errorCode).slice(0, 60) : null, Math.max(0, Date.now() - Date.parse(row.created_at)),
    cost, snapshot ? JSON.stringify(snapshot) : null, id,
  )
}

/**
 * Rolls up all single rows before the day `cutoffDay` (YYYY-MM-DD, exclusive) into ai_usage_daily and deletes them.
 * @returns {{ rows: number, days: number }}
 */
export function rollupBefore(cutoffDay) {
  return tx(() => {
    const cutoff = `${cutoffDay}T00:00:00.000Z`
    const groups = db
      .prepare(
        `SELECT substr(created_at,1,10) AS day, COALESCE(user_id,0) AS user_id, feature, COALESCE(provider,'') AS provider, COALESCE(model,'') AS model,
                COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
                COALESCE(SUM(cost),0) AS cost, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS errors,
                SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpriced, COALESCE(SUM(latency_ms),0) AS latency_ms_sum
         FROM ai_usage WHERE created_at<? GROUP BY 1,2,3,4,5`,
      )
      .all(cutoff)
    const up = db.prepare(
      `INSERT INTO ai_usage_daily (day,user_id,feature,provider,model,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,errors,unpriced,latency_ms_sum)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(day,user_id,feature,provider,model) DO UPDATE SET
         requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
         cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
         cost=cost+excluded.cost, errors=errors+excluded.errors, unpriced=unpriced+excluded.unpriced, latency_ms_sum=latency_ms_sum+excluded.latency_ms_sum`,
    )
    for (const g of groups) {
      up.run(g.day, g.user_id, g.feature, g.provider, g.model, g.requests, g.input_tokens, g.output_tokens, g.cache_read_tokens, g.cache_write_tokens, g.cost, g.errors, g.unpriced, g.latency_ms_sum)
    }
    const del = db.prepare('DELETE FROM ai_usage WHERE created_at<?').run(cutoff)
    return { rows: Number(del.changes), days: new Set(groups.map((g) => g.day)).size }
  })
}

export function usageReport(month = monthKey()) {
  const sums =
    'COUNT(*) AS requests, COALESCE(SUM(ok),0) AS ok_requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost),0) AS cost'
  return {
    month,
    total: db.prepare(`SELECT ${sums} FROM ai_usage WHERE substr(created_at,1,7)=?`).get(month),
    counted: monthlyCount(month),
    by_feature: db.prepare(`SELECT feature, ${sums} FROM ai_usage WHERE substr(created_at,1,7)=? GROUP BY feature ORDER BY requests DESC`).all(month),
    by_user: db
      .prepare(
        `SELECT a.user_id, u.name, COUNT(*) AS requests, COALESCE(SUM(a.ok),0) AS ok_requests,
                COALESCE(SUM(a.input_tokens),0) AS input_tokens, COALESCE(SUM(a.output_tokens),0) AS output_tokens, COALESCE(SUM(a.cost),0) AS cost
         FROM ai_usage a LEFT JOIN users u ON u.id=a.user_id WHERE substr(a.created_at,1,7)=? GROUP BY a.user_id ORDER BY requests DESC`,
      )
      .all(month),
    recent_errors: db
      .prepare("SELECT created_at, feature, model, error FROM ai_usage WHERE substr(created_at,1,7)=? AND ok=0 AND error IS NOT NULL AND error NOT IN ('running') ORDER BY id DESC LIMIT 10")
      .all(month),
  }
}
