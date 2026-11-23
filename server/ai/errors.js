// Shared error class and mapping of provider errors to readable messages.
export class AiError extends Error {
  constructor(message, { code = 'provider', retryable = false } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = code
    this.retryable = retryable
  }
}

/** Removes API keys (exact and typical formats) from error texts. */
export function redact(text, apiKey) {
  let s = String(text ?? '')
  if (apiKey && apiKey.length >= 6) s = s.split(apiKey).join('***')
  return s.replace(/\b(sk|key|AIza)[-_A-Za-z0-9]{8,}/g, '***').replace(/\s+/g, ' ').trim()
}

/** HTTP status of a provider error → readable message (without secrets). */
export function statusError(status, detail, apiKey) {
  const d = redact(detail, apiKey).slice(0, 200)
  switch (status) {
    case 400:
    case 422:
      return new AiError(`Invalid request to the AI provider${d ? ` (${d})` : ''}`, { code: 'bad_request' })
    case 401:
      return new AiError('The API key was rejected by the AI provider', { code: 'auth' })
    case 402:
      return new AiError('The AI provider reports a billing problem', { code: 'billing' })
    case 403:
      return new AiError('Access denied – the key or model is not enabled', { code: 'forbidden' })
    case 404:
      return new AiError('Model or endpoint not found – please check the model ID and base URL', { code: 'not_found' })
    case 413:
      return new AiError('The request is too large for the AI provider', { code: 'too_large' })
    case 429:
      return new AiError('The AI provider rejected the request due to rate limiting or an exhausted quota', { code: 'rate_limit', retryable: true })
    default:
      if (status >= 500) return new AiError('The AI provider is currently unreachable or overloaded', { code: 'server', retryable: true })
      return new AiError(`The AI provider responded with status ${status}`, { code: 'provider' })
  }
}

export const timeoutError = () => new AiError('The AI request timed out', { code: 'timeout', retryable: true })
export const connectionError = () => new AiError('No connection to the AI provider', { code: 'connection', retryable: true })
export const refusalError = () => new AiError('The AI refused the request', { code: 'refusal' })
export const truncatedError = () => new AiError('The AI response was truncated', { code: 'truncated' })

/** Some SDKs deliver the error message as JSON text → use only the message field. */
function plainMessage(m) {
  try {
    const j = JSON.parse(m)
    return j?.error?.message || j?.message || m
  } catch {
    return m
  }
}

/** For SDKs that put a `status` field on errors (OpenAI, Google). */
export function genericSdkError(e, apiKey) {
  if (e instanceof AiError) return e
  if (/API_KEY_INVALID|API key not valid/i.test(e?.message || '')) return statusError(401, '', apiKey)
  if (e?.name === 'APIConnectionTimeoutError' || e?.name === 'TimeoutError' || e?.name === 'AbortError') return timeoutError()
  if (typeof e?.status === 'number') return statusError(e.status, plainMessage(e.message), apiKey)
  if (e?.name === 'APIConnectionError' || e?.cause || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(e?.message || '')) return connectionError()
  return new AiError(`Unexpected error: ${redact(e?.message, apiKey).slice(0, 160)}`, { code: 'unknown' })
}
