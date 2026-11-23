// Provider-neutral interface: generateJson({ system, userContent, schema, effort }) → { data, usage }
import { AiError } from './errors.js'
import { validate, parseJsonText } from './schema.js'
import { getAiConfig } from './settings.js'

const IMPL = {
  anthropic: () => import('./providers/anthropic.js'),
  openai: () => import('./providers/openai.js'),
  google: () => import('./providers/google.js'),
  openai_compatible: () => import('./providers/openai-compatible.js'),
  mock: () => import('./providers/mock.js'),
}

/**
 * userContent: [{type:'text', text} | {type:'image', media_type, data(base64)}]
 * schema: JSON schema of the result (root: object). effort: 'low' | 'medium' (only effective for Anthropic).
 * meter (optional): { input, output } is continuously incremented by the tokens used (also on errors).
 */
export async function generateJson({ system, userContent, schema, schemaName = 'result', effort = 'low', maxTokens = 4000, config = getAiConfig(), meter }) {
  const load = IMPL[config.provider]
  if (!load) throw new AiError('Unknown AI provider', { code: 'config' })
  const { generate } = await load()
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const add = (u) => {
    for (const k of Object.keys(total)) {
      total[k] += u?.[k] || 0
      if (meter) meter[k] = (meter[k] || 0) + (u?.[k] || 0)
    }
  }

  let content = userContent
  let lastProblem = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, usage } = await generate({ config, system, userContent: content, schema, schemaName, effort, maxTokens })
    add(usage)
    try {
      const parsed = parseJsonText(text)
      const v = validate(parsed, schema)
      if (v.ok) return { data: v.value, usage: total }
      lastProblem = v.errors.slice(0, 5).join('; ')
    } catch (e) {
      lastProblem = e.message
    }
    // A second attempt with a hint about the error
    content = [
      ...userContent,
      { type: 'text', text: `Note: Your previous answer was invalid (${lastProblem}). Answer again with valid JSON matching the schema only.` },
    ]
  }
  throw new AiError('The AI response had an invalid format', { code: 'invalid_output' })
}
