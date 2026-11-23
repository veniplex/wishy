// Google Gemini via @google/genai. Structured output: responseMimeType application/json + responseJsonSchema.
import { AiError, genericSdkError, refusalError, truncatedError } from '../errors.js'
import { providerSchema } from '../schema.js'

export async function generate({ config, system, userContent, schema, maxTokens }) {
  const { GoogleGenAI } = await import('@google/genai')
  const ai = new GoogleGenAI({ apiKey: config.apiKey, httpOptions: { timeout: 120_000 } })
  const parts = userContent.map((p) => (p.type === 'image' ? { inlineData: { mimeType: p.media_type, data: p.data } } : { text: p.text }))

  let res
  try {
    res = await ai.models.generateContent({
      model: config.model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseJsonSchema: providerSchema(schema),
        maxOutputTokens: maxTokens * 2, // thinking tokens count too
      },
    })
  } catch (e) {
    throw genericSdkError(e, config.apiKey)
  }

  if (res.promptFeedback?.blockReason) throw refusalError()
  const cand = res.candidates?.[0]
  const reason = cand?.finishReason
  if (reason === 'MAX_TOKENS') throw truncatedError()
  if (reason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(reason)) throw refusalError()
  const text = (cand?.content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('')
  if (!text) throw new AiError('Empty response from the AI provider', { code: 'empty' })
  const u = res.usageMetadata || {}
  return { text, usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } }
}
