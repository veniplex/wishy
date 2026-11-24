// Price table (setting ai_prices) and cost calculation. Prices are entered and stored per 1M tokens in the cost currency
// (setting ai_cost_currency); costs are recorded in that same currency, so no conversion happens per request.
import { getSys } from '../config.js'
import { bad } from '../util.js'

/** Indicative defaults in USD; only seeded for a fresh install whose cost currency is USD (other currencies start with an empty table). */
export const DEFAULT_PRICES = {
  'claude-opus-5-5': { input_per_mtok: 4, output_per_mtok: 20 },
  'claude-sonnet-5-5': { input_per_mtok: 2, output_per_mtok: 10 },
  'claude-haiku-5-5': { input_per_mtok: 0.1, output_per_mtok: 0.5 },
  'claude-fable-5-2': { input_per_mtok: 8, output_per_mtok: 40 },
}

const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000

/** Stored prices (valid entries only). */
export function getPrices() {
  const stored = getSys('ai_prices')
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  const out = {}
  for (const [m, p] of Object.entries(stored)) {
    if (p && num(p.input_per_mtok) && num(p.output_per_mtok)) {
      out[m] = { input_per_mtok: p.input_per_mtok, output_per_mtok: p.output_per_mtok }
      for (const k of ['cache_read_per_mtok', 'cache_write_per_mtok']) if (num(p[k])) out[m][k] = p[k]
    }
  }
  return out
}

/** Validates and normalises a price table supplied by the admin. */
export function validatePrices(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Object.assign(bad('Invalid price table'), { code: 'invalid_prices' })
  const out = {}
  for (const [model, p] of Object.entries(v)) {
    const id = model.trim()
    if (!id || id.length > 120 || /\s/.test(id)) throw Object.assign(bad(`Invalid model ID: ${model.slice(0, 40)}`), { code: 'invalid_prices' })
    if (!p || !num(Number(p.input_per_mtok)) || !num(Number(p.output_per_mtok))) {
      throw Object.assign(bad(`Invalid price for ${id}`), { code: 'invalid_prices' })
    }
    out[id] = { input_per_mtok: Number(p.input_per_mtok), output_per_mtok: Number(p.output_per_mtok) }
    for (const k of ['cache_read_per_mtok', 'cache_write_per_mtok']) {
      if (p[k] !== undefined && p[k] !== null && p[k] !== '') {
        if (!num(Number(p[k]))) throw Object.assign(bad(`Invalid price for ${id}`), { code: 'invalid_prices' })
        out[id][k] = Number(p[k])
      }
    }
  }
  if (Object.keys(out).length > 200) throw Object.assign(bad('Too many entries'), { code: 'invalid_prices' })
  return out
}

/** Exact match, otherwise longest prefix (e.g. "claude-sonnet-5-5-20260101"). */
export function priceFor(model, prices = getPrices()) {
  if (!model) return null
  if (prices[model]) return prices[model]
  let best = null
  for (const k of Object.keys(prices)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k
  return best ? prices[best] : null
}

/** Tracking currency: prices, costs and the cost cap are in it (default USD, as in 1.0.0). */
export function trackingCurrency() {
  return { code: String(getSys('ai_cost_currency') || 'USD').toUpperCase() }
}

/** Cost in the tracking currency (prices are already in it) and the price snapshot used; cost is null if no price is configured. */
export function computeCost(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }, prices, cur = trackingCurrency()) {
  const p = priceFor(model, prices)
  if (!p) return { cost: null, snapshot: null }
  const cr = p.cache_read_per_mtok ?? p.input_per_mtok * 0.1
  const cw = p.cache_write_per_mtok ?? p.input_per_mtok * 1.25
  const cost = (input * p.input_per_mtok + output * p.output_per_mtok + cacheRead * cr + cacheWrite * cw) / 1_000_000
  return {
    cost,
    snapshot: { input_per_mtok: p.input_per_mtok, output_per_mtok: p.output_per_mtok, cache_read_per_mtok: cr, cache_write_per_mtok: cw, currency: cur.code },
  }
}

/** Multiplies every price of a table by a factor (currency conversion), rounded to 6 decimals. */
export function scalePrices(prices, factor) {
  const r = (v) => Math.round(v * factor * 1e6) / 1e6
  const out = {}
  for (const [m, p] of Object.entries(prices)) {
    out[m] = {}
    for (const [k, v] of Object.entries(p)) out[m][k] = typeof v === 'number' ? r(v) : v
  }
  return out
}
