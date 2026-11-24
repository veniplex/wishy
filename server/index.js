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
import { personPhotoRoutes } from './person-photos.js'
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
import { offlineOps } from './offline-ops.js'
import { manifestRoutes } from './manifest.js'

const app = express()
app.disable('x-powered-by')
app.use(launcherHopHeaders) // in the Docker image: normalise the launcher hop before any use of req.ip/req.protocol

// Behind a reverse proxy: setting TRUST_PROXY / trust_proxy (environment takes precedence), see proxy.js
applyTrustProxy(app)
app.use(securityHeaders) // Security headers for EVERYTHING (API, frontend, images), see headers.js
healthRoutes(app)
maintenanceRoutes(app) // GET /api/maintenance (public)
manifestRoutes(app) // GET /manifest.webmanifest (public)
app.use(maintenanceGate) // Maintenance mode BEFORE all routes (also /api/v1): 503 except for the acting admin's session

app.use('/api/v1', apiV1Router) // public API: own key authentication, without cookies/CSRF
app.use('/api', csrfGuard)
// Session BEFORE the body parser: large bodies are only allowed for signed-in users and only on a few routes.
// Default limit 200 KB (enough for any normal JSON request); exceptions (without login always 200 KB):
//   POST /api/import 20 MB (space import) ·
//   POST /api/ai/extract-image 8 MB (base64 image, max. 5 MB raw data) · POST /api/account/avatar and POST /api/persons/:id/photo 6 MB (base64, max. 2 MB raw data).
// The backup upload (/api/admin/backups/upload) is a raw stream and not affected.
const smallJson = express.json({ limit: '200kb' })
const BIG_BODIES = [
  { re: /^\/api\/import$/, limit: '20mb', json: express.json({ limit: '20mb' }) },
  { re: /^\/api\/ai\/extract-image$/, limit: '8mb', json: express.json({ limit: '8mb' }) },
  { re: /^\/api\/account\/avatar$/, limit: '6mb', json: express.json({ limit: '6mb' }) },
  { re: /^\/api\/persons\/\d+\/photo$/, limit: '6mb', json: express.json({ limit: '6mb' }) },
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
}, auditMiddleware, twoFactorGate, offlineOps)

startup()

authRoutes(app)
googleRoutes(app)
twoFactorRoutes(app)
sessionRoutes(app)
avatarRoutes(app)
personPhotoRoutes(app)
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
  // Hashed build files (/assets/<name>-<hash>.<ext>) never change: cache them for a year. The stable names (theme-init.js, public icons)
  // and the service worker (/sw.js, must be re-checked on every start) are revalidated.
  const HASHED_ASSET = /^\/assets\/.+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/
  // Precompressed build files (<file>.br / <file>.gz, written by the build): chosen by Accept-Encoding. Without them (dev, old builds),
  // for Range requests and for other files the normal static handler answers below.
  const COMPRESSIBLE = /\.(?:js|mjs|css|svg|json|html|txt|webmanifest)$/
  const precompressed = new Map() // file -> { br?: stat, gz?: stat } (stat of the compressed files; builds are static)
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.headers.range || !COMPRESSIBLE.test(req.path)) return next()
    let rel
    try { rel = decodeURIComponent(req.path) } catch { return next() }
    const file = path.resolve(dist, '.' + rel)
    if (!file.startsWith(dist + path.sep)) return next()
    res.vary('Accept-Encoding')
    const accepted = String(req.headers['accept-encoding'] || '').split(',').filter((x) => !/;\s*q=0(\.0*)?\s*$/.test(x)).map((x) => x.split(';')[0].trim().toLowerCase())
    const enc = accepted.includes('br') ? 'br' : accepted.includes('gzip') ? 'gz' : null
    if (!enc) return next()
    let info = precompressed.get(file)
    if (!info) {
      info = {}
      for (const e of ['br', 'gz']) {
        try { const st = fs.statSync(`${file}.${e}`); if (st.isFile()) info[e] = st } catch { /* none */ }
      }
      if (info.br || info.gz) precompressed.set(file, info)
    }
    const use = info[enc] ? enc : null
    if (!use) return next()
    const st = info[use]
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-${use}"`
    res.set({ 'Content-Encoding': use === 'br' ? 'br' : 'gzip', ETag: etag, 'Content-Length': String(st.size), 'Last-Modified': st.mtime.toUTCString() })
    const rel2 = '/' + path.relative(dist, file).split(path.sep).join('/')
    const cache = rel2 === '/sw.js' ? 'no-cache' : HASHED_ASSET.test(rel2) ? 'public, max-age=31536000, immutable' : null
    if (cache) res.setHeader('Cache-Control', cache)
    if (req.fresh) return res.status(304).end()
    res.type(path.extname(file)) // Content-Type of the original (the file read below has .br/.gz)
    res.removeHeader('Content-Length')
    res.sendFile(`${file}.${use}`, {
      etag: false, lastModified: false,
      cacheControl: false,
    }, (err) => { if (err && !res.headersSent) next() })
  })
  app.use(
    express.static(dist, {
      index: false,
      setHeaders(res, file) {
        const rel = '/' + path.relative(dist, file).split(path.sep).join('/')
        if (rel === '/sw.js') res.setHeader('Cache-Control', 'no-cache')
        else if (HASHED_ASSET.test(rel)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      },
    }),
  )
  // A missing build file is a 404, not the app shell (a stale /assets/x.js must not be answered with HTML; same for the service worker)
  app.get(/^\/(?:(?:assets|icons)\/.*|sw\.js)$/, (req, res) => res.status(404).type('text/plain').send('Not found'))
  // SPA fallback: catch-all (everything except /api/) serves index.html so every client route reaches the router.
  // index.html gets the name from the settings in <title> (otherwise the default name flashes before the script starts).
  const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    try {
      const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace(/<title>[^<]*<\/title>/, `<title>${escHtml(getSys('app_name') || 'Wishy')}</title>`).replace('name="apple-mobile-web-app-title" content="Wishy"', `name="apple-mobile-web-app-title" content="${escHtml(getSys('app_name') || 'Wishy')}"`)
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
