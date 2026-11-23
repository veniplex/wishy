// For automated tests only (AI_TEST_MOCK=1): returns prepared JSON responses without network.
import fs from 'node:fs'
import { AiError } from '../errors.js'

export async function generate({ system, userContent, schemaName }) {
  const all = userContent.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
  const hasImage = userContent.some((p) => p.type === 'image')
  if (process.env.AI_MOCK_LOG) fs.appendFileSync(process.env.AI_MOCK_LOG, JSON.stringify({ schemaName, system, text: all, hasImage }) + '\n')
  const usage = { input: 100 + all.length / 10, output: 50 }
  if (all.includes('MOCK_FAIL')) throw new AiError('Simulated provider error', { code: 'provider' })
  if (all.includes('MOCK_INVALID_ONCE') && !all.includes('Note: Your previous')) {
    return { text: '{"nope":', usage }
  }
  if (all.includes('MOCK_INVALID_ALWAYS')) return { text: '{"items": "not an array"}', usage }
  let obj
  switch (schemaName) {
    case 'ping':
      obj = { ok: true }
      break
    case 'link_extract': {
      const m = /Image candidates:\n([\s\S]*?)\n\n/.exec(all)
      obj = {
        title: 'Mock product title',
        description: 'Short description of the product.',
        price: 1.11,
        currency: 'EUR',
        shop: 'Mock-Shop',
        brand: 'MockBrand',
        variant: 'Black',
        image_index: m && m[1].trim() ? 0 : null,
      }
      break
    }
    case 'item_extract': {
      const ideas = /Target: ideas/.test(all)
      const url = /https?:\/\/[^\s)"'<>]+/.exec(all)?.[0] ?? null
      obj = {
        items: [
          { title: hasImage ? 'Product from image' : 'Mock wish', notes: 'Note', price: 19.99, currency: 'EUR', url, person_name: ideas ? 'Anna' : null, mentioned: ideas ? true : null },
          { title: 'Second entry', notes: null, price: null, currency: null, url: 'https://evil.example/not-in-text', person_name: null, mentioned: null },
        ],
      }
      break
    }
    case 'gift_suggestions':
      obj = {
        suggestions: Array.from({ length: 6 }, (_, i) => ({
          title: `Idea ${i + 1}`,
          reason: 'Fits well because …',
          price_estimate: 20 + i * 5,
          search_query: `idea ${i + 1}`,
        })),
      }
      break
    default:
      obj = {}
  }
  return { text: JSON.stringify(obj), usage }
}
