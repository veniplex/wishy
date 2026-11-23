/** Service worker (only in the built app and in a secure context; without it everything works, but the app cannot be opened offline) */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return
  const register = () => void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {})
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
