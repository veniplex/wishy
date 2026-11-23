// Admin API for the customisable AI prompts (administrators only).
import { requireAdmin } from '../session.js'
import { spaceCtx } from '../spaces.js'
import { bad } from '../util.js'
import { audit } from '../audit.js'
import { LOCALES } from '../config.js'
import { userLocale } from '../locale.js'
import { getAiConfig, missingConfig, missingCode, FEATURES } from './settings.js'
import { tracked } from './guard.js'
import { fetchPage, extractLink, extractText, extractImage, suggestContext, suggest } from './features.js'
import {
  assertFeature, buildSystem, featureView, getCustom, resetCustom, saveCustom, validateInstructions, DEFAULTS,
} from './prompts.js'

const MAX_TEXT = 20_000
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/** Requested instructions from the body: missing/null = stored or default instructions. */
function instructionsOf(feature, body) {
  if (body.instructions === undefined || body.instructions === null) return { text: undefined, warnings: [] }
  return validateInstructions(feature, body.instructions)
}

export function promptRoutes(app, { checkImage }) {
  app.get('/api/admin/ai/prompts', requireAdmin, (req, res) => {
    const locale = userLocale(req.user.id)
    res.json({ features: FEATURES.map((f) => featureView(f, locale)) })
  })

  app.put('/api/admin/ai/prompts/:feature', requireAdmin, (req, res) => {
    const feature = assertFeature(req.params.feature)
    const { text, warnings } = validateInstructions(feature, obj(req.body).instructions)
    if (text === DEFAULTS[feature].text) resetCustom(feature) // identical to the default: not marked as customised
    else saveCustom(feature, text, req.user.id)
    audit(req, 'admin.ai.prompt.update', { target: { type: 'ai_prompt', id: feature }, details: { length: text.length } })
    res.json({ ...featureView(feature, userLocale(req.user.id)), warnings })
  })

  app.delete('/api/admin/ai/prompts/:feature', requireAdmin, (req, res) => {
    const feature = assertFeature(req.params.feature)
    resetCustom(feature)
    audit(req, 'admin.ai.prompt.reset', { target: { type: 'ai_prompt', id: feature }, details: { length: 0 } })
    res.json(featureView(feature, userLocale(req.user.id)))
  })

  // Preview: complete system prompt for a sample context, no model call
  app.post('/api/admin/ai/prompts/:feature/preview', requireAdmin, (req, res) => {
    const feature = assertFeature(req.params.feature)
    const b = obj(req.body)
    const { text, warnings } = instructionsOf(feature, b)
    const s = obj(b.sample)
    const locale = LOCALES.includes(s.locale) ? s.locale : userLocale(req.user.id)
    const budget = s.budget === undefined || s.budget === null || s.budget === '' ? 50 : Number(s.budget)
    if (!Number.isFinite(budget) || budget < 0 || budget > 1e7) throw bad('Invalid budget', 'invalid_budget')
    const occasionType = typeof s.occasion_type === 'string' ? s.occasion_type : 'birthday'
    res.json({
      system: buildSystem(feature, locale, { budget, occasionType }, text),
      custom: text !== undefined || !!getCustom(feature),
      warnings,
    })
  })

  // Test: run once with (unsaved) instructions on sample input – counts like a normal call
  app.post('/api/admin/ai/prompts/:feature/test', requireAdmin, async (req, res) => {
    const feature = assertFeature(req.params.feature)
    const b = obj(req.body)
    const { text: instructions, warnings } = instructionsOf(feature, b)
    const sample = obj(b.sample)
    const cfg = { ...getAiConfig(), enabled: true } // Testing is allowed before enabling; the provider settings must be complete though
    const missing = missingConfig(cfg)
    if (missing) throw bad(`AI is not set up yet: ${missing}`, 'ai_not_configured', { reasonCode: missingCode(cfg), detail: missing })
    const locale = LOCALES.includes(sample.locale) ? sample.locale : userLocale(req.user.id)
    const uid = req.user.id

    let run
    if (feature === 'link_import') {
      const src = await fetchPage(sample.url) // same SSRF rules as the regular link import
      run = (meter) => extractLink(src, meter, locale, { instructions })
    } else if (feature === 'text_import') {
      if (typeof sample.text !== 'string' || !sample.text.trim()) throw bad('Please paste a sample text', 'text_required')
      if (sample.text.length > MAX_TEXT) throw bad(`The text is too long (at most ${MAX_TEXT} characters)`, 'text_too_long', { max: MAX_TEXT })
      const target = sample.target === 'ideas' ? 'ideas' : 'wishes'
      run = (meter) => extractText(sample.text, target, meter, locale, { instructions })
    } else if (feature === 'image_import') {
      const img = checkImage(sample)
      run = (meter) => extractImage(img.mediaType, img.data, meter, locale, { instructions })
    } else {
      const c = suggestContext(spaceCtx(req), uid, sample)
      run = (meter) => suggest(c.facts, meter, locale, { instructions, budget: c.budget, occasionType: c.occasionType })
    }

    const t0 = Date.now()
    let used
    const result = await tracked({ userId: uid, via: 'ui' }, `test:${feature}`, cfg, async (meter) => {
      used = meter
      return run(meter)
    })
    res.json({
      result,
      usage: { input: Math.round(used.input), output: Math.round(used.output), cache_read: Math.round(used.cacheRead), cache_write: Math.round(used.cacheWrite) },
      latency_ms: Date.now() - t0,
      model: cfg.model,
      warnings,
    })
  })
}
