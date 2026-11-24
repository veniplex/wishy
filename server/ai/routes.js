import { requireAuth, requireAdmin } from '../session.js'
import { spaceCtx } from '../spaces.js'
import { HttpError, bad } from '../util.js'
import { userLocale } from '../locale.js'
import { AiError, redact } from './errors.js'
import { getAiConfig, isUsable, missingConfig, missingCode, adminView, saveAdminSettings, PROVIDERS, LINK_MODES } from './settings.js'
import { preview } from '../preview.js'
import { startUsage, finishUsage, monthlyCount, usageReport, monthKey } from './usage.js'
import { gate, assertLimit, tracked } from './guard.js'
import { effectiveFeatures } from '../features.js'
import { promptRoutes } from './prompt-routes.js'
import { fetchPage, extractLink, extractText, extractImage, suggestContext, suggest, ping } from './features.js'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_TEXT = 20_000
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/** Validate base64 (optionally with data: URL prefix); determine the type from the file header bytes. */
function checkImage(body) {
  let data = typeof body.image_base64 === 'string' ? body.image_base64.trim() : ''
  const m = /^data:([\w/+.-]+);base64,/i.exec(data)
  if (m) data = data.slice(m[0].length)
  if (!data) throw bad('Please choose an image', 'image_required')
  if (data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw new HttpError(413, 'The image is too large (at most 5 MB)', 'image_too_large')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw bad('Invalid image data', 'image_invalid')
  const buf = Buffer.from(data, 'base64')
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'The image is too large (at most 5 MB)', 'image_too_large')
  const declared = String(body.media_type || '').toLowerCase()
  if (!IMAGE_TYPES.includes(declared)) throw bad('Only JPEG, PNG, WebP and GIF are supported', 'image_type')
  const h = buf.subarray(0, 12)
  const detected =
    h[0] === 0xff && h[1] === 0xd8 ? 'image/jpeg'
    : h.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png'
    : h.subarray(0, 3).toString('latin1') === 'GIF' ? 'image/gif'
    : h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp'
    : null
  if (!detected) throw bad('This is not a valid image (JPEG, PNG, WebP or GIF)', 'image_not_valid')
  return { mediaType: detected, data }
}

export function aiRoutes(app) {
  promptRoutes(app, { checkImage })

  // ---- Admin ----
  app.get('/api/admin/ai', requireAdmin, (req, res) => res.json({ ...adminView(), requests_this_month: monthlyCount() }))

  app.put('/api/admin/ai', requireAdmin, (req, res) => {
    saveAdminSettings(req.body || {})
    res.json({ ...adminView(), requests_this_month: monthlyCount() })
  })

  app.post('/api/admin/ai/test', requireAdmin, async (req, res) => {
    // Optionally test unsaved values from the form (the key is not saved)
    const b = req.body || {}
    const base = getAiConfig()
    const cfg = { ...base, enabled: true }
    const norm = (u) => (typeof u === 'string' && u.trim() ? u.trim().replace(/\/+$/, '') : null)
    // Test target = provider + base URL. If it differs from the stored one, the stored key (also from the environment)
    // must not be sent along – otherwise it could be sent to a foreign server. Then the key must be part of the same request.
    let retarget = false
    if (typeof b.ai_provider === 'string' && PROVIDERS[b.ai_provider]) {
      if (b.ai_provider !== base.provider) retarget = true
      cfg.provider = b.ai_provider
      cfg.model = PROVIDERS[b.ai_provider].default_model
    }
    if (typeof b.ai_model === 'string' && b.ai_model.trim()) cfg.model = b.ai_model.trim()
    if (typeof b.ai_base_url === 'string' && b.ai_base_url.trim()) {
      if (norm(b.ai_base_url) !== norm(base.baseUrl)) retarget = true
      cfg.baseUrl = norm(b.ai_base_url)
    }
    const ownKey = typeof b.ai_api_key === 'string' && b.ai_api_key.trim() ? b.ai_api_key.trim() : null
    if (ownKey) cfg.apiKey = ownKey
    else if (retarget) cfg.apiKey = null
    if (retarget && !ownKey && cfg.provider !== 'mock' && cfg.provider !== 'openai_compatible') {
      return res.json({ ok: false, latency_ms: 0, model: cfg.model || null, error: 'Provider or base URL differ from the stored values – please enter the API key again', error_code: 'key_required_retarget' })
    }
    const missing = missingConfig(cfg)
    if (missing) return res.json({ ok: false, latency_ms: 0, model: cfg.model || null, error: missing, error_code: missingCode(cfg) })

    const id = startUsage({ userId: req.user.id, feature: 'test', provider: cfg.provider, model: cfg.model })
    const meter = { input: 0, output: 0 }
    const t0 = Date.now()
    try {
      await ping(cfg, meter)
      finishUsage(id, { ...meter, ok: true })
      res.json({ ok: true, latency_ms: Date.now() - t0, model: cfg.model })
    } catch (e) {
      const msg = e instanceof AiError ? e.message : 'Unexpected error'
      if (!(e instanceof AiError)) console.error('[ai]', redact(e?.stack || e?.message, cfg.apiKey))
      finishUsage(id, { ...meter, ok: false, error: msg })
      res.json({ ok: false, latency_ms: Date.now() - t0, model: cfg.model, error: msg, error_code: e instanceof AiError ? e.code : 'unexpected' })
    }
  })

  app.get('/api/admin/ai/usage', requireAdmin, (req, res) => {
    const month = req.query.month ? String(req.query.month) : monthKey()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('Invalid month (YYYY-MM)', 'invalid_month')
    res.json({ ...usageReport(month), limit: getAiConfig().limit })
  })

  // ---- For all signed-in users ----
  app.get('/api/ai/status', requireAuth, (req, res) => {
    const cfg = getAiConfig()
    const global = isUsable(cfg)
    const mine = effectiveFeatures(req.user).ai
    const on = global && mine
    res.json({
      enabled: on,
      global_enabled: global, // set up and enabled by the admin
      user_enabled: mine, // not switched off for this account (besides the global switch)
      provider: global ? cfg.provider : null, // kind only, never keys or URLs
      link_mode: cfg.linkMode, // admin default for link imports: 'builtin' | 'ai'
      features: Object.fromEntries(Object.entries(cfg.features).map(([k, v]) => [k, on && v])),
      provider_label: PROVIDERS[cfg.provider]?.label ?? null,
    })
  })

  app.post('/api/ai/extract-link', requireAuth, async (req, res) => {
    const url = req.body?.url
    if (typeof url !== 'string' || !url.trim()) throw bad('Please provide a link', 'url_required')
    // mode: 'ai' | 'builtin'; omitted = admin default. Built-in never calls the AI. If AI was wanted but is not
    // available (off, feature off, user off, limit reached), the built-in parser answers and `fallback` says why.
    const m = req.body?.mode
    if (m !== undefined && m !== null && !LINK_MODES.includes(m)) throw bad('Invalid mode (ai or builtin)', 'invalid_mode')
    const want = m ?? getAiConfig().linkMode
    let fallback = null
    let cfg = null
    if (want === 'ai') {
      try {
        cfg = gate('link_import', req.user)
        assertLimit(cfg, req.user.id)
      } catch (e) {
        if (!(e instanceof HttpError) || !['ai_disabled', 'ai_feature_disabled', 'ai_disabled_for_user', 'ai_limit_reached'].includes(e.code)) throw e
        fallback = e.code
      }
    }
    if (cfg) {
      const src = await fetchPage(url) // same SSRF rules and error messages as /api/preview
      const r = await tracked({ userId: req.user.id, via: 'ui' }, 'link_import', cfg, (meter) => extractLink(src, meter, userLocale(req.user.id)))
      return res.json({ ...r, via: 'ai' })
    }
    try {
      res.json({ ...(await preview(url)), via: 'builtin', ...(fallback ? { fallback } : {}) })
    } catch (e) {
      throw e.userFacing ? e : bad('Page could not be loaded', 'page_load_failed')
    }
  })

  app.post('/api/ai/extract-text', requireAuth, async (req, res) => {
    const cfg = gate('text_import', req.user)
    const { text, target } = req.body || {}
    if (typeof text !== 'string' || !text.trim()) throw bad('Please paste some text', 'text_required')
    if (text.length > MAX_TEXT) throw bad(`The text is too long (at most ${MAX_TEXT.toLocaleString('en-US')} characters)`, 'text_too_long', { max: MAX_TEXT })
    if (!['wishes', 'ideas'].includes(target)) throw bad('Invalid target (wishes or ideas)', 'invalid_target')
    res.json(await tracked({ userId: req.user.id, via: 'ui' }, 'text_import', cfg, (meter) => extractText(text, target, meter, userLocale(req.user.id))))
  })

  app.post('/api/ai/extract-image', requireAuth, async (req, res) => {
    const cfg = gate('image_import', req.user)
    const img = checkImage(req.body || {})
    res.json(await tracked({ userId: req.user.id, via: 'ui' }, 'image_import', cfg, (meter) => extractImage(img.mediaType, img.data, meter, userLocale(req.user.id))))
  })

  app.post('/api/ai/suggest', requireAuth, async (req, res) => {
    const cfg = gate('suggestions', req.user)
    const ctx = spaceCtx(req)
    const { facts, budget, occasionType } = suggestContext(ctx, req.user.id, req.body || {})
    res.json(await tracked({ userId: req.user.id, via: 'ui' }, 'suggestions', cfg, (meter) => suggest(facts, meter, userLocale(req.user.id), { budget, occasionType })))
  })
}
