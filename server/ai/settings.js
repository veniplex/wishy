import { getSys, setSys, getSecretSys, setSecretSys } from '../config.js'
import { bad } from '../util.js'
import { tx } from '../db.js'
import { getPrices, validatePrices, trackingCurrency } from './prices.js'
import { convertCurrency, hasConvertibleData } from './usage.js'

export const MOCK = process.env.AI_TEST_MOCK === '1' // for automated tests only

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', default_model: 'claude-opus-5-5', model_hint: null },
  openai: { label: 'OpenAI', default_model: null, model_hint: 'Model ID from your OpenAI account that supports images and structured output' },
  google: { label: 'Google (Gemini)', default_model: null, model_hint: 'Gemini model ID from Google AI Studio' },
  openai_compatible: {
    label: 'OpenAI-compatible (Ollama, LM Studio, Mistral …)',
    default_model: null,
    model_hint: 'Model name of the server, e.g. as shown in Ollama or LM Studio',
    needs_base_url: true,
  },
  ...(MOCK ? { mock: { label: 'Mock (Test)', default_model: 'mock', model_hint: null } } : {}),
}
// The API key is stored encrypted in the database (shared helper getSecretSys/setSecretSys from config.js).

export const FEATURES = ['link_import', 'text_import', 'image_import', 'suggestions']
export const DEFAULT_PROVIDER = 'anthropic'
/** How a link import reads a page: the app's own parser (Open Graph, JSON-LD, meta tags) or the AI. Admin default; the user can choose per import. */
export const LINK_MODES = ['builtin', 'ai']
export const DEFAULT_LINK_MODE = 'ai' // as before: with AI configured, links are read by it

const ENV = { ai_provider: 'AI_PROVIDER', ai_api_key: 'AI_API_KEY', ai_model: 'AI_MODEL', ai_base_url: 'AI_BASE_URL' }
const envVal = (k) => {
  const v = process.env[ENV[k]]
  if (!v || !v.trim()) return null
  if (k === 'ai_provider' && !PROVIDERS[v.trim()]) return null
  return v.trim()
}
export const aiEnvLocked = () => Object.keys(ENV).filter((k) => envVal(k))

const posInt = (v) => (v !== null && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null)
const posNum = (v) => (v !== null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null)
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function getAiConfig() {
  const provider = envVal('ai_provider') || (PROVIDERS[getSys('ai_provider')] ? getSys('ai_provider') : DEFAULT_PROVIDER)
  const stored = getSys('ai_features')
  const features = Object.fromEntries(FEATURES.map((f) => [f, stored && typeof stored === 'object' ? stored[f] !== false : true]))
  const rawLimit = getSys('ai_monthly_request_limit')
  const limit = Number(rawLimit)
  return {
    enabled: getSys('ai_enabled') === true,
    provider,
    model: envVal('ai_model') || str(getSys('ai_model')) || PROVIDERS[provider].default_model,
    apiKey: envVal('ai_api_key') || str(getSecretSys('ai_api_key')),
    baseUrl: envVal('ai_base_url') || str(getSys('ai_base_url')),
    features,
    limit: rawLimit !== null && Number.isInteger(limit) && limit >= 0 ? limit : null,
    userLimit: posInt(getSys('ai_monthly_user_limit')),
    costCap: posNum(getSys('ai_monthly_cost_cap')),
    linkMode: LINK_MODES.includes(getSys('ai_link_mode')) ? getSys('ai_link_mode') : DEFAULT_LINK_MODE,
  }
}

/** Missing settings as a message, null if complete. */
export function missingConfig(c) {
  if (c.provider === 'mock') return null
  if (!c.model) return 'Please provide a model ID'
  if (c.provider === 'openai_compatible') return c.baseUrl ? null : 'Please provide the base URL of the server'
  return c.apiKey ? null : 'Please provide an API key'
}
export const missingCode = (c) => (c.provider === 'mock' ? null : !c.model ? 'missing_model' : c.provider === 'openai_compatible' ? (c.baseUrl ? null : 'missing_base_url') : c.apiKey ? null : 'missing_api_key')
export const isUsable = (c) => c.enabled && !missingConfig(c)

export function adminView() {
  const c = getAiConfig()
  return {
    ai_enabled: c.enabled,
    ai_provider: c.provider,
    ai_model: c.model || '',
    ai_api_key_set: !!c.apiKey, // the key itself is never returned
    ai_base_url: c.baseUrl || '',
    ai_features: c.features,
    ai_link_mode: c.linkMode, // default for link imports: 'builtin' | 'ai'
    ai_monthly_request_limit: c.limit,
    ai_monthly_user_limit: c.userLimit,
    ai_monthly_cost_cap: c.costCap, // per user and month, in the tracking currency
    ai_cost_currency: trackingCurrency().code, // prices, costs and the cap are in it
    ai_convert_needed: hasConvertibleData(), // costs, cap or prices exist: a currency change needs a one-time exchange rate
    ai_prices: getPrices(), // { model: { input_per_mtok, output_per_mtok, cache_read_per_mtok?, cache_write_per_mtok? } } per 1M tokens in ai_cost_currency
    env_locked: aiEnvLocked(),
    configured: !missingConfig(c),
    missing: missingConfig(c),
    missing_code: missingCode(c),
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p })),
  }
}

export function saveAdminSettings(b) {
  const locked = new Set(aiEnvLocked())
  const put = (k, v) => {
    if (!locked.has(k)) setSys(k, v)
  }
  const has = (k) => b[k] !== undefined && !locked.has(k)

  // Validate inputs before anything is saved
  let provider
  if (has('ai_provider')) {
    provider = String(b.ai_provider)
    if (!PROVIDERS[provider]) throw bad('Unknown AI provider', 'ai_provider_unknown')
  }
  let model
  if (has('ai_model')) {
    model = b.ai_model === null ? null : String(b.ai_model).trim()
    if (model && (model.length > 120 || /\s/.test(model))) throw bad('Invalid model ID', 'ai_model_invalid')
  }
  let baseUrl
  if (has('ai_base_url')) {
    baseUrl = b.ai_base_url === null ? null : String(b.ai_base_url).trim().replace(/\/+$/, '')
    if (baseUrl) {
      let u
      try {
        u = new URL(baseUrl)
      } catch {
        throw bad('The base URL must start with http:// or https://', 'base_url_invalid')
      }
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw bad('The base URL must start with http:// or https://', 'base_url_invalid')
    }
  }
  let limit
  if (b.ai_monthly_request_limit !== undefined) {
    const v = b.ai_monthly_request_limit
    if (v === null || v === '') limit = null
    else {
      limit = Number(v)
      if (!Number.isInteger(limit) || limit < 0 || limit > 100_000_000) throw bad('The monthly limit must be a whole number ≥ 0 (empty = unlimited)', 'ai_limit_invalid')
    }
  }
  const optNum = (k, label, { int = false, max = 1e9 } = {}) => {
    if (b[k] === undefined) return undefined
    if (b[k] === null || b[k] === '') return null
    const n = Number(b[k])
    if (!Number.isFinite(n) || n < 0 || n > max || (int && !Number.isInteger(n))) throw Object.assign(bad(label), { code: 'invalid_value' })
    return n
  }
  const userLimit = optNum('ai_monthly_user_limit', 'The user limit must be a whole number ≥ 0 (empty = unlimited)', { int: true })
  const costCap = optNum('ai_monthly_cost_cap', 'The cost cap must be a number ≥ 0 (empty = unlimited)')
  let costRate
  if (b.ai_cost_rate !== undefined) {
    costRate = b.ai_cost_rate === null || b.ai_cost_rate === '' ? null : Number(b.ai_cost_rate)
    if (costRate !== null && (!Number.isFinite(costRate) || costRate <= 0 || costRate > 1e6)) throw Object.assign(bad('Invalid exchange rate'), { code: 'invalid_value' })
  }
  let costCurrency
  if (b.ai_cost_currency !== undefined) {
    costCurrency = b.ai_cost_currency === null || b.ai_cost_currency === '' ? null : String(b.ai_cost_currency).trim().toUpperCase()
    if (costCurrency !== null && !/^[A-Z]{3,5}$/.test(costCurrency)) throw Object.assign(bad('Invalid currency'), { code: 'invalid_value' })
  }
  // A different currency needs a one-time rate (1 old = ? new) if there is anything to convert (costs, cap or prices); it is not stored
  const curNow = trackingCurrency()
  const nextCode = costCurrency ? costCurrency : curNow.code
  const switching = costCurrency !== undefined && nextCode !== curNow.code
  if (switching && hasConvertibleData() && costRate == null) {
    throw bad('Please enter an exchange rate for the new currency', 'cost_rate_required', { currency: nextCode, from: curNow.code })
  }
  const prices = b.ai_prices !== undefined ? validatePrices(b.ai_prices) : undefined
  let features
  if (b.ai_features !== undefined) {
    if (!b.ai_features || typeof b.ai_features !== 'object' || Array.isArray(b.ai_features)) throw bad('Invalid feature selection', 'ai_features_invalid')
    features = { ...getAiConfig().features }
    for (const f of FEATURES) if (b.ai_features[f] !== undefined) features[f] = !!b.ai_features[f]
  }
  if (b.ai_link_mode !== undefined && !LINK_MODES.includes(b.ai_link_mode)) throw bad('Invalid link import default (built-in or ai)', 'ai_link_mode_invalid')
  if (b.ai_enabled !== undefined && typeof b.ai_enabled !== 'boolean') throw bad('Invalid value for "AI enabled"', 'invalid_value')
  let apiKey
  if (b.ai_api_key === null) apiKey = null
  else if (typeof b.ai_api_key === 'string' && b.ai_api_key.trim()) {
    apiKey = b.ai_api_key.trim()
    if (apiKey.length > 500 || /\s/.test(apiKey)) throw bad('Invalid API key', 'invalid_api_key')
  }

  // Check the effective configuration after saving (enabling only with complete settings)
  const cur = getAiConfig()
  const nextProvider = provider ?? cur.provider
  const next = {
    ...cur,
    enabled: b.ai_enabled ?? cur.enabled,
    provider: nextProvider,
    apiKey: apiKey === undefined || locked.has('ai_api_key') ? cur.apiKey : apiKey,
    baseUrl: has('ai_base_url') ? baseUrl : cur.baseUrl,
  }
  const explicitModel = has('ai_model') ? model : envVal('ai_model') || str(getSys('ai_model'))
  next.model = explicitModel || PROVIDERS[nextProvider].default_model
  if (next.enabled) {
    const m = missingConfig(next)
    if (m) throw bad(`AI cannot be enabled yet: ${m}`, 'ai_not_configured', { reasonCode: missingCode(next), detail: m })
  }

  tx(() => {
    if (b.ai_enabled !== undefined) setSys('ai_enabled', b.ai_enabled)
    if (provider !== undefined) put('ai_provider', provider)
    if (has('ai_model')) put('ai_model', model || null)
    if (apiKey !== undefined && !locked.has('ai_api_key')) setSecretSys('ai_api_key', apiKey)
    if (has('ai_base_url')) put('ai_base_url', baseUrl || null)
    if (features) setSys('ai_features', features)
    if (b.ai_link_mode !== undefined) setSys('ai_link_mode', b.ai_link_mode)
    if (b.ai_monthly_request_limit !== undefined) setSys('ai_monthly_request_limit', limit)
    if (userLimit !== undefined) setSys('ai_monthly_user_limit', userLimit)
    if (costCap !== undefined) setSys('ai_monthly_cost_cap', costCap)
    if (switching) {
      // Converts costs, cap and prices; a cap or price table sent in this request is already in the new currency
      setSys('ai_cost_currency', nextCode)
      convertCurrency(nextCode, costRate ?? 1, { cap: costCap === undefined, prices: prices === undefined })
    } else if (costCurrency !== undefined) setSys('ai_cost_currency', costCurrency)
    if (prices !== undefined) setSys('ai_prices', prices)
  })
}
