/** "Install app": the browser's prompt is kept until the user asks for it in the settings. */
import { useSyncExternalStore } from 'react'

interface InstallPrompt extends Event { prompt: () => Promise<unknown> }

let prompt: InstallPrompt | null = null
const listeners = new Set<() => void>()
const set = (p: InstallPrompt | null) => {
  prompt = p
  listeners.forEach((fn) => fn())
}

export const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
/** Safari on iPhone/iPad has no prompt: Share > Add to Home Screen */
export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    set(e as InstallPrompt)
  })
  const persist = () => void navigator.storage?.persist?.().catch(() => {})
  window.addEventListener('appinstalled', () => {
    set(null)
    persist()
  })
  if (isInstalled()) persist()
}

/** Function that shows the install prompt, null if the browser does not offer it (now) */
export function useInstall(): (() => Promise<void>) | null {
  const p = useSyncExternalStore((fn) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, () => prompt)
  return p && (async () => {
    await p.prompt()
    set(null)
  })
}
