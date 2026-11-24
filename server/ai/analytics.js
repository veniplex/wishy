// AI usage: reports (admin) and own usage. Data basis = single rows (ai_usage) + rolled-up days (ai_usage_daily).
import { db } from '../db.js'
import { requireAdmin, requireAuth } from '../session.js'
import { csvRow } from '../audit.js'
import { bad } from '../util.js'
import { getAiConfig } from './settings.js'
import { trackingCurrency } from './prices.js'
import { monthKey, userMonth } from './usage.js'

const DAY = 86_400_000
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
const invalid = (m) => Object.assign(bad(m), { code: 'invalid_date' })

/** from/to (YYYY-MM-DD, inclusive); default: the last 30 days. */
function range(q) {
  const today = new Date().toISOString().slice(0, 10)
  const to = typeof q.to === 'string' && q.to ? q.to : today
  const from = typeof q.from === 'string' && q.from ? q.from : new Date(Date.parse(to) - 29 * DAY).toISOString().slice(0, 10)
  if (!isDay(from) || !isDay(to)) throw invalid('Invalid date (YYYY-MM-DD)')
  if (from > to) throw invalid('The start date is after the end date')
  if (Date.parse(to) - Date.parse(from) > 3660 * DAY) throw invalid('The date range is too large')
  return { from, to }
}

// Unified view: one row per request or per rolled-up day/user/feature/model
const UNIFIED = `(
  SELECT substr(created_at,1,10) AS day, COALESCE(user_id,0) AS user_id, feature, COALESCE(provider,'') AS provider, COALESCE(model,'') AS model,
         1 AS requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, COALESCE(cost,0) AS cost,
         CASE WHEN ok=0 AND error!='running' THEN 1 ELSE 0 END AS errors, CASE WHEN cost IS NULL AND ok=1 THEN 1 ELSE 0 END AS unpriced, COALESCE(latency_ms,0) AS latency_ms_sum
  FROM ai_usage
  UNION ALL
  SELECT day, user_id, feature, provider, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, errors, unpriced, latency_ms_sum
  FROM ai_usage_daily
)`
const SUMS = `COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(errors),0) AS errors, COALESCE(SUM(input_tokens),0) AS input_tokens,
  COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(unpriced),0) AS unpriced_requests,
  COALESCE(SUM(latency_ms_sum),0) AS latency_sum`

const finish = (r) => {
  const { latency_sum, ...rest } = r
  return {
    ...rest,
    ok_requests: r.requests - r.errors,
    error_rate: r.requests ? r.errors / r.requests : 0,
    avg_latency_ms: r.requests ? Math.round(latency_sum / r.requests) : null,
    cost: Math.round(r.cost * 1e6) / 1e6, // tracking currency
  }
}

export function summary(from, to, userId) {
  const cur = trackingCurrency()
  const r = db
    .prepare(`SELECT ${SUMS} FROM ${UNIFIED} WHERE day>=? AND day<=? ${userId != null ? 'AND user_id=?' : ''}`)
    .get(from, to, ...(userId != null ? [userId] : []))
  return { from, to, currency: { code: cur.code }, ...finish(r) }
}

const BUCKET_SQL = {
  day: 'day',
  week: "date(day,'-6 days','weekday 1')", // Monday of the week
  month: "substr(day,1,7)||'-01'",
}
function bucketStarts(from, to, bucket) {
  const out = []
  const start = (d) => {
    const dt = new Date(`${d}T00:00:00Z`)
    if (bucket === 'month') return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1))
    if (bucket === 'week') return new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * DAY)
    return dt
  }
  for (let d = start(from); d.toISOString().slice(0, 10) <= to; ) {
    out.push(d.toISOString().slice(0, 10))
    d = bucket === 'month' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) : new Date(d.getTime() + (bucket === 'week' ? 7 : 1) * DAY)
    if (out.length > 5000) break
  }
  return out
}

export function timeseries(from, to, bucket, group) {
  if (!BUCKET_SQL[bucket]) throw Object.assign(bad('Invalid bucket type (day, week, month)'), { code: 'invalid_value' })
  if (!['user', 'feature', 'model', 'none'].includes(group)) throw Object.assign(bad('Invalid grouping (user, feature, model, none)'), { code: 'invalid_value' })
  const cur = trackingCurrency()
  const keyCol = { user: 'user_id', feature: 'feature', model: 'model', none: "''" }[group]
  const rows = db
    .prepare(
      `SELECT ${BUCKET_SQL[bucket]} AS bucket, ${keyCol} AS key, ${SUMS} FROM ${UNIFIED} WHERE day>=? AND day<=? GROUP BY 1,2 ORDER BY 1,2`,
    )
    .all(from, to)
  const names = new Map()
  if (group === 'user') {
    for (const u of db.prepare('SELECT id, name, email FROM users').all()) names.set(u.id, u.name)
  }
  const out = rows.map((r) => ({
    bucket: r.bucket,
    key: group === 'none' ? null : group === 'user' ? (r.key === 0 ? null : r.key) : r.key,
    label: group === 'none' ? null : group === 'user' ? (names.get(r.key) ?? (r.key === 0 ? null : `#${r.key}`)) : r.key || null,
    ...finish(r),
  }))
  const keys = [...new Map(out.map((r) => [r.key, { key: r.key, label: r.label }])).values()]
  return { from, to, bucket, group, currency: { code: cur.code }, buckets: bucketStarts(from, to, bucket), keys, rows: out }
}

export function perUser(from, to) {
  const cur = trackingCurrency()
  const month = monthKey()
  const cfg = getAiConfig()
  const rows = db
    .prepare(
      `SELECT t.user_id, u.name, u.email, ${SUMS}
       FROM ${UNIFIED} t LEFT JOIN users u ON u.id=t.user_id WHERE t.day>=? AND t.day<=? GROUP BY t.user_id ORDER BY cost DESC, requests DESC`,
    )
    .all(from, to)
  return {
    from,
    to,
    currency: { code: cur.code },
    limits: { monthly_user_limit: cfg.userLimit, monthly_cost_cap: cfg.costCap },
    users: rows.map((r) => {
      const m = userMonth(r.user_id, month)
      return {
        user_id: r.user_id || null,
        name: r.name ?? null,
        email: r.email ?? null,
        ...finish(r),
        month_requests: m.requests,
        month_cost: Math.round(m.cost * 1e6) / 1e6,
      }
    }),
  }
}

export function analyticsRoutes(app) {
  app.get('/api/admin/ai/usage/summary', requireAdmin, (req, res) => {
    const { from, to } = range(req.query)
    res.json(summary(from, to))
  })
  app.get('/api/admin/ai/usage/timeseries', requireAdmin, (req, res) => {
    const { from, to } = range(req.query)
    res.json(timeseries(from, to, String(req.query.bucket || 'day'), String(req.query.group || 'none')))
  })
  app.get('/api/admin/ai/usage/users', requireAdmin, (req, res) => {
    const { from, to } = range(req.query)
    res.json(perUser(from, to))
  })
  app.get('/api/admin/ai/usage/export.csv', requireAdmin, (req, res) => {
    const { from, to } = range(req.query)
    const cur = trackingCurrency()
    const rows = db
      .prepare(
        `SELECT t.day, t.user_id, u.email, t.feature, t.provider, t.model, ${SUMS}
         FROM ${UNIFIED} t LEFT JOIN users u ON u.id=t.user_id WHERE t.day>=? AND t.day<=?
         GROUP BY t.day, t.user_id, t.feature, t.provider, t.model ORDER BY t.day, t.user_id`,
      )
      .all(from, to)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="wishy-ai-usage-${from}_${to}.csv"`)
    res.write(
      '﻿' + csvRow(['day', 'user_id', 'user_email', 'feature', 'provider', 'model', 'requests', 'errors', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost', 'currency', 'unpriced_requests']),
    )
    for (const r of rows) {
      res.write(csvRow([r.day, r.user_id || '', r.email, r.feature, r.provider, r.model, r.requests, r.errors, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.cost, cur.code, r.unpriced_requests]))
    }
    res.end()
  })

  // Own usage (every signed-in user)
  app.get('/api/account/ai-usage', requireAuth, (req, res) => {
    const { from, to } = range(req.query)
    const cfg = getAiConfig()
    const m = userMonth(req.user.id)
    res.json({
      ...summary(from, to, req.user.id),
      month: { month: monthKey(), requests: m.requests, cost: Math.round(m.cost * 1e6) / 1e6 },
      limits: { monthly_user_limit: cfg.userLimit, monthly_cost_cap: cfg.costCap, monthly_request_limit: cfg.limit },
    })
  })
}
