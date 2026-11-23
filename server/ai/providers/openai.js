// OpenAI and OpenAI-compatible servers (Ollama, LM Studio, Mistral …) via the official openai SDK (Chat Completions).
// openai: response_format json_schema (strict). openai_compatible: json_schema, falls back to json_object on 400/422
// (the schema is then added to the system prompt); validation always happens server-side.
import { AiError, genericSdkError, refusalError, truncatedError } from '../errors.js'
import { providerSchema } from '../schema.js'

const toPart = (p) =>
  p.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:${p.media_type};base64,${p.data}` } }
    : { type: 'text', text: p.text }

export async function generate({ config, system, userContent, schema, schemaName = 'result', maxTokens }) {
  const { default: OpenAI } = await import('openai')
  const compat = config.provider === 'openai_compatible'
  const client = new OpenAI({
    apiKey: config.apiKey || 'not-needed', // local servers often need no key
    ...(compat ? { baseURL: config.baseUrl } : {}),
    timeout: compat ? 180_000 : 120_000,
    maxRetries: 1,
  })
  const strictSchema = providerSchema(schema)
  const messages = (sys, withFormat) => [
    { role: 'system', content: withFormat ? sys : `${sys}\n\nAnswer exclusively with a JSON object that matches this JSON schema:\n${JSON.stringify(strictSchema)}` },
    { role: 'user', content: userContent.map(toPart) },
  ]
  // Reasoning models count thinking tokens → generous limit; older servers only know max_tokens
  const limit = compat ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens * 2 }

  const call = (format, withFormat) =>
    client.chat.completions.create({ model: config.model, messages: messages(system, withFormat), response_format: format, ...limit })

  let res
  try {
    try {
      res = await call({ type: 'json_schema', json_schema: { name: schemaName, schema: strictSchema, strict: true } }, true)
    } catch (e) {
      if (!compat || ![400, 422].includes(e?.status)) throw e
      res = await call({ type: 'json_object' }, false)
    }
  } catch (e) {
    throw genericSdkError(e, config.apiKey)
  }

  const choice = res.choices?.[0]
  if (!choice) throw new AiError('Empty response from the AI provider', { code: 'empty' })
  if (choice.message?.refusal) throw refusalError()
  if (choice.finish_reason === 'length') throw truncatedError()
  if (choice.finish_reason === 'content_filter') throw refusalError()
  return {
    text: choice.message?.content ?? '',
    usage: { input: res.usage?.prompt_tokens || 0, output: res.usage?.completion_tokens || 0 },
  }
}
