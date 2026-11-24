/*
 * Service worker (template; the build fills in VERSION and FILES, see vite.config.ts). Only static files and images: the planning data is
 * cached by the app itself (src/offline), API answers are never touched.
 */
const VERSION = '__VERSION__'
const FILES = __FILES__

const APP = `wishy-app-${VERSION}`
/** Exists only while someone is signed in (created and deleted by the app) */
const IMAGES = 'wishy-images'
const MAX_IMAGES = 300
const NAVIGATION_TIMEOUT = 4000
const THEME = '/assets/theme-init.js'

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(APP)
    const shell = await fetch('/', { cache: 'reload', credentials: 'same-origin' })
    // Not the page of a sign-in proxy or a maintenance page
    if (!shell.ok || shell.redirected || !(await shell.clone().text()).includes('id="root"')) throw new Error('no app shell')
    await cache.put('/', shell)
    await cache.addAll(FILES)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // The files of the previous version stay: pages that are still open may load them
    const old = (await caches.keys()).filter((k) => k.startsWith('wishy-app-') && k !== APP)
    await Promise.all(old.slice(0, -1).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

/** From the current version, otherwise from the previous one */
const cached = async (key) => (await (await caches.open(APP)).match(key)) ?? caches.match(key)

/** Network first; the cached app only if there is no answer (or a proxy says the server is not there) */
async function navigate(request) {
  const shell = await cached('/')
  if (!shell) return fetch(request)
  const late = new Promise((resolve) => setTimeout(() => resolve(null), NAVIGATION_TIMEOUT))
  const res = await Promise.race([fetch(request).catch(() => null), late])
  return res && res.status !== 502 && res.status !== 504 ? res : shell
}

async function asset(request, event) {
  const hit = await cached(request)
  if (new URL(request.url).pathname === THEME) {
    const fresh = fetch(request).then(async (res) => {
      // Only the real script: never a page of a sign-in proxy that answers in its place
      if (res.ok && !res.redirected && /javascript/i.test(res.headers.get('content-type') || '')) await (await caches.open(APP)).put(request, res.clone())
      return res
    })
    if (!hit) return fresh
    event.waitUntil(fresh.catch(() => {}))
    return hit
  }
  return hit ?? fetch(request)
}

/** Product images never change, profile pictures may: those are refreshed in the background. Only while signed in. */
async function image(request, event) {
  if (!(await caches.has(IMAGES))) return fetch(request)
  const cache = await caches.open(IMAGES)
  const hit = await cache.match(request)
  const load = async () => {
    const res = await fetch(request)
    if (res.status === 200 && !res.redirected && (await caches.has(IMAGES))) {
      await cache.put(request, res.clone())
      const keys = await cache.keys()
      await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_IMAGES)).map((k) => cache.delete(k)))
    }
    return res
  }
  if (!hit) return load()
  if (new URL(request.url).pathname.startsWith('/api/avatars/')) event.waitUntil(load().catch(() => {}))
  return hit
}

self.addEventListener('fetch', (e) => {
  const { request } = e
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  const p = url.pathname
  if (/^\/api\/(images|avatars|person-photos)\//.test(p)) return e.respondWith(image(request, e))
  if (p.startsWith('/api/') || p === '/healthz' || p === '/readyz' || p.startsWith('/__')) return
  if (p.startsWith('/assets/') || p.startsWith('/icons/')) return e.respondWith(asset(request, e))
  if (request.mode === 'navigate') return e.respondWith(navigate(request))
})
