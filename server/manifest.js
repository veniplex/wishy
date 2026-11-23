// Web app manifest (installable PWA). Public, built per request so the name follows the app_name setting.
import { getSys, defaultLocale } from './config.js'

const SHORTCUTS = {
  en: { wishlists: 'Wishlists', gifting: 'Gifting', calendar: 'Calendar' },
  de: { wishlists: 'Wunschlisten', gifting: 'Schenken', calendar: 'Kalender' },
}
const LIGHT_BG = '#fbf6f0' // light theme background (src/index.css)

export function manifestFor(locale = defaultLocale()) {
  const name = String(getSys('app_name') || 'Wishy')
  const s = SHORTCUTS[locale] ?? SHORTCUTS.en
  const icon = (file, sizes, type, purpose) => ({ src: `/icons/${file}`, sizes, type, purpose })
  return {
    id: '/',
    name,
    short_name: name.slice(0, 12),
    description: 'Wishlists, gift ideas and shared gift planning',
    lang: locale,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: LIGHT_BG,
    theme_color: LIGHT_BG,
    categories: ['lifestyle', 'shopping', 'productivity'],
    icons: [
      icon('icon-192.png', '192x192', 'image/png', 'any'),
      icon('icon-512.png', '512x512', 'image/png', 'any'),
      icon('icon-maskable-512.png', '512x512', 'image/png', 'maskable'),
      icon('icon.svg', 'any', 'image/svg+xml', 'any'),
    ],
    shortcuts: [
      { name: s.wishlists, url: '/wishlists', icons: [icon('icon-192.png', '192x192', 'image/png')] },
      { name: s.gifting, url: '/gifting', icons: [icon('icon-192.png', '192x192', 'image/png')] },
      { name: s.calendar, url: '/calendar', icons: [icon('icon-192.png', '192x192', 'image/png')] },
    ],
  }
}

export function manifestRoutes(app) {
  app.get('/manifest.webmanifest', (req, res) => {
    res.set({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.send(JSON.stringify(manifestFor()))
  })
}
