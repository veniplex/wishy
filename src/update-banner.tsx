import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { CircleArrowUp, X } from 'lucide-react'
import { api } from './api'
import { useAuth } from './auth'
import { t } from './i18n'
import { Banner, Button, IconButton } from './ui'

/** Only what the notices need (subset of GET /api/admin/update/status) */
export interface UpdateHint {
  available: boolean
  latest: { version: string } | null
  target?: { version: string } | null
  releases?: { version: string }[]
}

interface Availability {
  /** Latest available version – administrators only, otherwise null */
  version: string | null
  dismissed: boolean
  dismiss: () => void
  /** Adopt the result of a status query (e.g. after "Check now") */
  apply: (s: UpdateHint) => void
}

const Ctx = createContext<Availability>({ version: null, dismissed: true, dismiss: () => {}, apply: () => {} })
export const useUpdateAvailability = () => useContext(Ctx)

const DISMISS_KEY = 'updateDismissed'
const readDismissed = () => { try { return localStorage.getItem(DISMISS_KEY) } catch { return null } }

/** Polls the update status every 20 minutes (administrators only); the query is cheap and uses the server cache */
export function UpdateAvailabilityProvider({ children }: { children: ReactNode }) {
  const { user, status } = useAuth()
  const admin = status === 'ready' && user?.role === 'admin'
  const [version, setVersion] = useState<string | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(readDismissed)

  const apply = useCallback((s: UpdateHint) => {
    const v = s.available ? (s.target?.version ?? s.releases?.[0]?.version ?? s.latest?.version ?? null) : null
    setVersion(v)
  }, [])
  useEffect(() => {
    if (!admin) { setVersion(null); return }
    let alive = true
    const load = () => api<UpdateHint>('GET', '/api/admin/update/status').then((s) => { if (alive) apply(s) }).catch(() => {})
    void load()
    const id = setInterval(load, 20 * 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [admin, apply])

  const value = useMemo<Availability>(() => ({
    version,
    dismissed: !!version && dismissedVersion === version,
    dismiss: () => {
      if (!version) return
      try { localStorage.setItem(DISMISS_KEY, version) } catch { /* storage blocked */ }
      setDismissedVersion(version)
    },
    apply,
  }), [version, dismissedVersion, apply])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Notice bar on the admin pages (dismissible per version; redundant on the update page itself) */
export function UpdateBanner() {
  const { version, dismissed, dismiss } = useUpdateAvailability()
  const { pathname } = useLocation()
  if (!version || dismissed || pathname.startsWith('/admin/updates')) return null
  return (
    <Banner
      tone="info"
      icon={CircleArrowUp}
      action={
        <span className="flex items-center gap-1 shrink-0">
          <Button size="sm" to="/admin/updates">{t('update.banner.details')}</Button>
          <IconButton icon={X} size="sm" label={t('update.banner.dismiss')} onClick={dismiss} />
        </span>
      }
    >
      {t('update.banner.text', { version })}
    </Banner>
  )
}
