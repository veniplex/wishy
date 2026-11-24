import { db, tx } from '../db.js'
import { getSys, setSys } from '../config.js'
import { computeCost, DEFAULT_PRICES, getPrices, scalePrices, trackingCurrency } from './prices.js'

/*
 * Currency model (since 1.0.2): the price table, the recorded costs and the cost cap are all in the cost currency (ai_cost_currency).
 * Markers: ai_usage_currency {code} = currency of ai_usage.cost / ai_usage_daily.cost / the cap (missing = USD, a 1.0.0 database);
 * ai_prices_currency = currency code of ai_prices (missing = USD prices from 1.0.0/1.0.1).
 * ai_cost_rate (1.0.0/1.0.1: "1 USD = ? currency") is only read once by the startup migration.
 */

const moneyRound = (v) => Math.round(v * 100) / 100

/** Currency the stored costs are in (setting ai_usage_currency); missing = USD, i.e. a 1.0.0 database. */
const recordedCurrency = () => {
  const v = getSys('ai_usage_currency')
  return v && typeof v.code === 'string' ? v.code : 'USD'
}

/** True if there is anything a currency change would have to convert (costs, cap or prices). */
export function hasConvertibleData() {
  const rows = db.prepare('SELECT (SELECT COUNT(*) FROM ai_usage WHERE cost IS NOT NULL) + (SELECT COUNT(*) FROM ai_usage_daily) AS n').get().n
  const cap = getSys('ai_monthly_cost_cap')
  return rows > 0 || typeof cap === 'number' || Object.keys(getPrices()).length > 0
}

/**
 * Converts recorded costs, the cost cap and the price table to a new currency with a one-time rate (1 old = rate new) and moves the markers.
 * Everything is in `from` before and in `to` after; idempotent for from === to.
 * @param {{ cap?: boolean, prices?: boolean }} opts false when the value was just given explicitly in the new currency
 */
export function convertCurrency(to, rate, { cap = true, prices = true } = {}) {
  tx(() => {
    const from = recordedCurrency()
    if (from !== to) {
      db.prepare('UPDATE ai_usage SET cost=cost*? WHERE cost IS NOT NULL').run(rate)
      db.prepare('UPDATE ai_usage_daily SET cost=cost*?').run(rate)
      const c = getSys('ai_monthly_cost_cap')
      if (cap && typeof c === 'number') setSys('ai_monthly_cost_cap', moneyRound(c * rate))
      setSys('ai_usage_currency', { code: to })
    }
    if (String(getSys('ai_prices_currency') || 'USD') !== to) {
      if (prices) setSys('ai_prices', scalePrices(getPrices(), rate))
      setSys('ai_prices_currency', to)
    }
    setSys('ai_cost_rate', null) // legacy setting, no longer used
  })
}

/**
 * Startup, idempotent: brings a 1.0.0 / 1.0.1 database to the currency model above.
 * 1.0.0: costs in USD (no marker), 1.0.1: costs in the cost currency (marker). In both, prices are USD and ai_cost_rate (1 USD = ?) belongs
 * to ai_cost_currency. A fresh install gets the default prices (USD only; other currencies start with an empty table).
 */
export function migrateCurrency() {
  tx(() => {
    const code = trackingCurrency().code
    const r = Number(getSys('ai_cost_rate'))
    const rate = code !== 'USD' && Number.isFinite(r) && r > 0 ? r : 1
    if (getSys('ai_usage_currency') === null) {
      if (rate !== 1) {
        db.prepare('UPDATE ai_usage SET cost=cost*? WHERE cost IS NOT NULL').run(rate)
        db.prepare('UPDATE ai_usage_daily SET cost=cost*?').run(rate)
        const cap = getSys('ai_monthly_cost_cap')
        if (typeof cap === 'number') setSys('ai_monthly_cost_cap', moneyRound(cap * rate))
      }
      setSys('ai_usage_currency', { code })
    }
    if (getSys('ai_prices_currency') === null) {
      const stored = getSys('ai_prices')
      if (stored === null) setSys('ai_prices', code === 'USD' ? DEFAULT_PRICES : {})
      else if (rate !== 1 && typeof stored === 'object' && !Array.isArray(stored)) setSys('ai_prices', scalePrices(stored, rate))
      setSys('ai_prices_currency', code)
    }
  })
}
migrateCurrency()

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
