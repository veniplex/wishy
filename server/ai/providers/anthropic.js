// Anthropic via the official SDK. Structured output via output_config.format (JSON schema) –
// no forced tool call, no prefill, no sampling parameters, thinking not disabled.
import { AiError, statusError, timeoutError, connectionError, refusalError, truncatedError } from '../errors.js'
import { providerSchema } from '../schema.js'

export const DEFAULT_MODEL = 'claude-opus-5-5'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
// output_config.effort gibt es ab Opus 4.5 / den 5er-Modellen; bei anderen Modellen weglassen
const SUPPORTS_EFFORT = /^claude-(opus-(4-[5-9]|[5-9])|sonnet-[5-9]|haiku-[5-9]|fable|mythos)/

const toBlock = (p) =>
  p.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: p.media_type, data: p.data } }
    : { type: 'text', text: p.text }

function mapError(Anthropic, e, apiKey) {
  if (e instanceof AiError) return e
  if (e instanceof Anthropic.APIConnectionTimeoutError) return timeoutError()
  if (e instanceof Anthropic.APIConnectionError) return connectionError()
  if (e instanceof Anthropic.AuthenticationError) return statusError(401, e.message, apiKey)
  if (e instanceof Anthropic.PermissionDeniedError) return statusError(403, e.message, apiKey)
  if (e instanceof Anthropic.NotFoundError) return statusError(404, e.message, apiKey)
  if (e instanceof Anthropic.RateLimitError) return statusError(429, e.message, apiKey)
  if (e instanceof Anthropic.BadRequestError) return statusError(400, e.message, apiKey)
  if (e instanceof Anthropic.InternalServerError) return statusError(e.status ?? 500, e.message, apiKey)
  if (e instanceof Anthropic.APIError) return statusError(e.status ?? 0, e.message, apiKey)
  return new AiError('Unexpected error during the AI request', { code: 'unknown' })
}

export async function generate({ config, system, userContent, schema, effort, maxTokens }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: config.apiKey, timeout: 120_000, maxRetries: 2 })
  const model = config.model || DEFAULT_MODEL
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent.map(toBlock) }],
    output_config: {
      ...(effort && SUPPORTS_EFFORT.test(model) ? { effort } : {}),
      format: { type: 'json_schema', schema: providerSchema(schema) },
    },
  }

  let res
  try {
    // Server-side refusal fallback (documented only for claude-opus-5-5; can be combined with output_config)
    res =
      model === DEFAULT_MODEL
        ? await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
        : await client.messages.create(params)
  } catch (e) {
    throw mapError(Anthropic, e, config.apiKey)
  }

  // check stop_reason first
  if (res.stop_reason === 'refusal') throw refusalError()
  if (res.stop_reason === 'max_tokens') throw truncatedError()
  if (res.stop_reason !== 'end_turn' && res.stop_reason !== 'stop_sequence') {
    throw new AiError(`Unexpected end of the AI response (${res.stop_reason})`, { code: 'unexpected_stop' })
  }

  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  // With fallback, usage.iterations is the source of truth per attempt
  const its = (res.usage?.iterations || []).filter((i) => Number.isFinite(i?.input_tokens))
  const sum = (k) => its.reduce((n, i) => n + (i[k] || 0), 0)
  const usage = its.length
    ? { input: sum('input_tokens'), output: sum('output_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens') }
    : {
        input: res.usage?.input_tokens || 0,
        output: res.usage?.output_tokens || 0,
        cacheRead: res.usage?.cache_read_input_tokens || 0,
        cacheWrite: res.usage?.cache_creation_input_tokens || 0,
      }
  return { text, usage }
}
