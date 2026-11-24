// Shared safeguards for AI requests (UI and public API): enablement, limits, logging.
import { HttpError, forbidden } from '../util.js'
import { effectiveFeatures } from '../features.js'
import { AiError, redact } from './errors.js'
import { getAiConfig, isUsable } from './settings.js'
import { startUsage, finishUsage, monthlyCount, userMonth } from './usage.js'

const MAX_PARALLEL_PER_USER = 2
const inflight = new Map()

const err = (status, message, code) => new HttpError(status, message, code)

/** AI globally active, feature enabled and not switched off for the user? Otherwise 403. */
export function gate(feature, user) {
  const cfg = getAiConfig()
  if (!isUsable(cfg)) throw err(403, 'AI is not enabled', 'ai_disabled')
  if (!cfg.features[feature]) throw err(403, 'This AI feature is not enabled', 'ai_feature_disabled')
  if (user && !effectiveFeatures(user).ai) throw err(403, 'AI is not enabled for your account', 'ai_disabled_for_user')
  return cfg
}

/** Global monthly limit, user limit and cost cap (per user) – otherwise 429 ai_limit_reached. Costs and cap are both in the tracking currency. */
export function assertLimit(cfg, userId) {
  if (cfg.limit !== null && monthlyCount() >= cfg.limit) throw err(429, 'The monthly AI limit has been reached', 'ai_limit_reached')
  if (userId != null && (cfg.userLimit !== null || cfg.costCap !== null)) {
    const m = userMonth(userId)
    if (cfg.userLimit !== null && m.requests >= cfg.userLimit) throw err(429, 'Your monthly AI limit has been reached', 'ai_limit_reached')
    if (cfg.costCap !== null && m.cost >= cfg.costCap) throw err(429, 'Your monthly AI cost cap has been reached', 'ai_limit_reached')
  }
}

/**
 * Runs an AI request with limit, concurrency cap, usage log (incl. cost) and error mapping.
 * @param {{ userId: number, via?: 'ui'|'api' }} actor
 */
export async function tracked(actor, feature, cfg, fn) {
  const uid = actor.userId
  assertLimit(cfg, uid)
  if ((inflight.get(uid) || 0) >= MAX_PARALLEL_PER_USER) throw err(429, 'An AI request is already running – please wait a moment', 'ai_busy')
  inflight.set(uid, (inflight.get(uid) || 0) + 1)
  const id = startUsage({ userId: uid, feature, provider: cfg.provider, model: cfg.model, via: actor.via })
  const meter = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  try {
    const r = await fn(meter)
    finishUsage(id, { ...meter, ok: true })
    return r
  } catch (e) {
    if (e instanceof HttpError) {
      finishUsage(id, { ...meter, ok: false, error: e.message, errorCode: e.code })
      throw e
    }
    const msg = e instanceof AiError ? e.message : 'Unexpected error'
    if (!(e instanceof AiError)) console.error('[ai]', redact(e?.stack || e?.message, cfg.apiKey))
    finishUsage(id, { ...meter, ok: false, error: msg, errorCode: e instanceof AiError ? e.code : 'unexpected' })
    throw new HttpError(502, `AI request failed: ${msg}`, 'ai_failed', { reasonCode: e instanceof AiError ? e.code : 'unexpected', detail: msg })
  } finally {
    const n = (inflight.get(uid) || 1) - 1
    if (n) inflight.set(uid, n)
    else inflight.delete(uid)
  }
}

export { forbidden }
