import './preboot.js' // MUST stay the first import: applies a prepared restore before the DB is opened
import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { db } from './db.js'
import { sessionMiddleware, csrfGuard, requireAuth, sessionRoutes } from './session.js'
import { authRoutes, startup } from './auth.js'
import { googleRoutes } from './google.js'
import { twoFactorRoutes, twoFactorGate } from './twofactor-routes.js'
import { avatarRoutes } from './avatars.js'
import { applyTrustProxy, healthRoutes, proxyRoutes } from './proxy.js'
import { securityHeaders } from './headers.js'
import { getSys } from './config.js'
import { spaceRoutes } from './spaces.js'
import { planningRoutes } from './planning.js'
import { wishlistRoutes } from './wishlists.js'
import { adminRoutes } from './admin.js'
import { aiRoutes } from './ai/routes.js'
import { apiV1Router, auditMiddleware, platformRoutes, platformStartup } from './platform.js'
import { HttpError } from './util.js'
import { preview, IMAGES_DIR, IMAGE_FILE_RE } from './preview.js'
import { maintenanceGate, maintenanceRoutes, maintenanceStartup } from './maintenance.js'
import { launcherHopHeaders } from './launcher-hop.js'
import { backupRoutes } from './backup.js'
import { updateRoutes } from './update.js'

const app = express()
app.disable('x-powered-by')
app.use(launcherHopHeaders) // in the Docker image: normalise the launcher hop before any use of req.ip/req.protocol

// Behind a reverse proxy: setting TRUST_PROXY / trust_proxy (environment takes precedence), see proxy.js
applyTrustProxy(app)
app.use(securityHeaders) // Security headers for EVERYTHING (API, frontend, images), see headers.js
healthRoutes(app)
maintenanceRoutes(app) // GET /api/maintenance (public)
app.use(maintenanceGate) // Maintenance mode BEFORE all routes (also /api/v1): 503 except for the acting admin's session

app.use('/api/v1', apiV1Router) // public API: own key authentication, without cookies/CSRF
app.use('/api', csrfGuard)
// Session BEFORE the body parser: large bodies are only allowed for signed-in users and only on a few routes.
// Default limit 200 KB (enough for any normal JSON request); exceptions (without login always 200 KB):
//   POST /api/import 20 MB (space import) ·
//   POST /api/ai/extract-image 8 MB (base64 image, max. 5 MB raw data) · POST /api/account/avatar 6 MB (base64, max. 2 MB raw data).
// The backup upload (/api/admin/backups/upload) is a raw stream and not affected.
const smallJson = express.json({ limit: '200kb' })
const BIG_BODIES = [
  { re: /^\/api\/import$/, limit: '20mb', json: express.json({ limit: '20mb' }) },
  { re: /^\/api\/ai\/extract-image$/, limit: '8mb', json: express.json({ limit: '8mb' }) },
  { re: /^\/api\/account\/avatar$/, limit: '6mb', json: express.json({ limit: '6mb' }) },
]
const jsonBody = (req, res, next) => {
  if (req.method !== 'POST' || !req.user) return smallJson(req, res, next)
  const p = req.originalUrl.split('?')[0]
  const big = BIG_BODIES.find((b) => b.re.test(p))
  return (big ? big.json : smallJson)(req, res, next)
}
app.use('/api', sessionMiddleware, jsonBody, (req, res, next) => {
  req.body ??= {}
  next()
}, auditMiddleware, twoFactorGate)

startup()

authRoutes(app)
googleRoutes(app)
twoFactorRoutes(app)
sessionRoutes(app)
avatarRoutes(app)
proxyRoutes(app)
spaceRoutes(app)
wishlistRoutes(app)
adminRoutes(app)
aiRoutes(app)
planningRoutes(app)
platformRoutes(app)
platformStartup()
backupRoutes(app)
updateRoutes(app)
maintenanceStartup()

// ---- Link preview & images (login required) ----
app.post('/api/preview', requireAuth, async (req, res, next) => {
  try {
    res.json(await preview(req.body?.url))
  } catch (e) {
    next(e.userFacing ? e : Object.assign(new Error('Page could not be loaded'), { code: 'page_load_failed' }))
  }
})
app.get('/api/images/:file', (req, res, next) => {
  if (!IMAGE_FILE_RE.test(req.params.file)) return res.status(404).end()
  // Without login only images of open wishes of a currently shared wishlist (public page /w/:token)
  if (!req.user) {
    const pub = db
      .prepare(
        `SELECT 1 FROM wishes w JOIN wishlists l ON l.id=w.wishlist_id
         WHERE w.image_url=? AND w.status!='removed' AND l.link_enabled=1 AND l.archived=0 LIMIT 1`,
      )
      .get(`/api/images/${req.params.file}`)
    if (!pub) return next(new HttpError(401, 'Please sign in', 'auth'))
    res.setHeader('Cache-Control', 'private, max-age=3600')
  } else {
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.sendFile(req.params.file, { root: IMAGES_DIR, immutable: true }, (err) => {
    if (err && !res.headersSent) res.status(404).end()
  })
})

// Unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }))

// ---- Frontend (production build) ----
const dist = path.resolve('dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false }))
  // SPA fallback: catch-all (everything except /api/) serves index.html so every client route reaches the router.
  // index.html gets the name from the settings in <title> (otherwise the default name flashes before the script starts).
  const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    try {
      const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace(/<title>[^<]*<\/title>/, `<title>${escHtml(getSys('app_name') || 'Wishy')}</title>`)
      res.type('html').set('Cache-Control', 'no-cache').send(html)
    } catch (e) {
      next(e)
    }
  })
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The file is too large', code: 'payload_too_large' })
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request', code: 'bad_request' })
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.params ? { params: err.params } : {}) })
  }
  console.error(err)
  res.status(400).json({ error: err.message || 'Unknown error', ...(typeof err.code === 'string' && /^[a-z][a-z0-9_]*$/.test(err.code) ? { code: err.code } : {}) })
})

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '127.0.0.1'
app.listen(port, host, () => console.log(`Wishy is running on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`))
