let requested = false
/**
 * Service worker (only in the built app and in a secure context; without it everything works, but the app cannot be opened offline).
 * A public list page (/w/...) installs nothing for its visitors: they usually have no account, and behind a sign-in proxy neither /sw.js
 * nor the app shell would be reachable for them. It is registered once a session exists (`force`, see AuthProvider) or on the next
 * visit of any other page.
 */
export function registerServiceWorker({ force = false } = {}) {
  if (requested || !import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return
  if (!force && location.pathname.startsWith('/w/')) return
  requested = true
  const register = () => void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {})
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
