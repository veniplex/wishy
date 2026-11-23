import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Info, Wrench, X } from 'lucide-react'
import { useAuth } from './auth'
import { t, useT, type TKey } from './i18n'
import { Banner, Brand, Button, IconButton } from './ui'
import { StepList, ProgressBar, type JobStep } from './update-parts'
import {
  endMaintenanceView, getMaintenance, rememberMaintenanceNotice, reportMaintenance, subscribeMaintenance, takeMaintenanceNotice, type MaintenanceInfo,
} from './maintenance-state'

const POLL_MS = 1500

const getJson = async (url: string) => {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', 'X-Requested-With': 'wishlist' } })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

/**
 * Full-screen maintenance display. Polls `/api/maintenance` (errors while the app restarts are tolerated) and reloads the page
 * once maintenance is over or the version changed. The acting administrator (session stays alive) also sees
 * the update steps or, for "restart required", the instructions including cancel.
 */
function MaintenanceScreen({ initial }: { initial: MaintenanceInfo | null }) {
  useT()
  const [info, setInfo] = useState<MaintenanceInfo>(initial ?? {})
  const [steps, setSteps] = useState<JobStep[] | null>(null)
  const [jobProgress, setJobProgress] = useState<number | null>(null)
  const [pendingSource, setPendingSource] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [long, setLong] = useState(false)
  const offlineSince = useRef<number | null>(null)
  const [cancelling, setCancelling] = useState(false)
  // The display only appears after a 503 "maintenance": once maintenance is over, the page reloads in any case
  const seen = useRef(true)
  const startVersion = useRef(initial?.version ?? null)
  const last = useRef<MaintenanceInfo>(info)
  const tick = useRef(0)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const finish = (d: MaintenanceInfo | null) => {
      const versionChanged = !!(startVersion.current && d?.version && d.version !== startVersion.current)
      if (!seen.current && !versionChanged) return endMaintenanceView()
      const s = last.current.state
      if (s === 'updating' || versionChanged) rememberMaintenanceNotice('updated')
      else rememberMaintenanceNotice('restored')
      window.location.reload()
    }
    const markOffline = (v: boolean) => {
      setOffline(v)
      if (!v) { offlineSince.current = null; setLong(false) }
      else { offlineSince.current ??= Date.now(); setLong(Date.now() - offlineSince.current > 180_000) }
    }
    const run = async () => {
      tick.current++
      try {
        const { data } = await getJson('/api/maintenance')
        if (!alive) return
        if (data && typeof data === 'object' && 'maintenance' in data) {
          markOffline(false)
          if (data.maintenance === false) return finish(data)
          seen.current = true
          last.current = data
          setInfo(data)
          startVersion.current ??= data.version ?? null
        } else {
          seen.current = true
          markOffline(true)
        }
      } catch {
        if (!alive) return
        seen.current = true
        markOffline(true)
      }
      // Only reachable by the acting administrator (otherwise 401/503, silently ignored)
      if (tick.current % 2 === 1) {
        try {
          const st = await getJson('/api/admin/update/status')
          if (alive && st.status === 200 && st.data?.job) {
            setSteps(st.data.job.steps ?? null)
            setJobProgress(typeof st.data.job.progress === 'number' ? st.data.job.progress : null)
          } else if (alive) setSteps(null)
        } catch { /* ignore */ }
      }
      if (last.current.state === 'restart_required' && tick.current % 2 === 0) {
        try {
          const b = await getJson('/api/admin/backups')
          if (alive) setPendingSource(b.status === 200 && b.data?.restore_pending ? String(b.data.restore_pending.source ?? '') : null)
        } catch { /* ignore */ }
      }
      if (alive) timer = setTimeout(run, POLL_MS)
    }
    void run()
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  const state = info.state && /^\w+$/.test(info.state) ? info.state : 'maintenance'
  const titleKey = `maintenance.title.${state}` as TKey
  const title = t(titleKey) !== titleKey ? t(titleKey) : t('maintenance.title.maintenance')
  const restart = state === 'restart_required'
  const progress = steps?.length ? jobProgress : typeof info.progress === 'number' ? info.progress : null

  const cancel = async () => {
    setCancelling(true)
    try {
      await fetch('/api/admin/backups/restore-pending', { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': 'wishlist' } })
    } catch { /* the next poll shows the state */ }
    setCancelling(false)
  }

  return (
    <div className="fixed inset-0 z-[200] bg-bg overflow-y-auto" role="alertdialog" aria-modal="true" aria-labelledby="maint-title">
      <div className="min-h-full grid place-items-center px-4 py-10">
        <div className="w-full max-w-md space-y-6">
          <Brand name="Wishy" center large />
          <div className="card p-6 space-y-5 text-center" role="status" aria-live="polite">
            <span className="mx-auto grid place-items-center size-12 rounded-full bg-soft text-accent"><Wrench size={22} strokeWidth={1.75} /></span>
            <div>
              <h1 id="maint-title" className="h2 text-2xl text-balance">{restart && pendingSource ? t('maintenance.restart.title') : title}</h1>
              <p className="text-muted mt-1.5 text-sm">
                {restart ? (pendingSource ? t('maintenance.restart.admin', { source: pendingSource }) : t('maintenance.restart.others')) : state === 'failed' ? t('maintenance.subFailed') : (info.message || t('maintenance.sub'))}
              </p>
            </div>
            {!restart && (
              <div className="space-y-2">
                <ProgressBar value={progress} label={title} />
                <p className="meta">
                  {offline ? t('maintenance.reconnecting') : info.target_version ? t('maintenance.target', { version: info.target_version }) : t('maintenance.waiting')}
                </p>
                {offline && <p className="text-sm text-muted">{t('maintenance.swap')}</p>}
                {offline && long && <p className="text-sm text-warn">{t('maintenance.longer')}</p>}
              </div>
            )}
            {steps && steps.length > 0 && <div className="text-left border-t border-line pt-4"><StepList steps={steps} /></div>}
            {restart && pendingSource && (
              <Button variant="danger" disabled={cancelling} onClick={cancel}>{t('maintenance.restart.cancel')}</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Mounts the maintenance display (once in App.tsx, outside the sign-in). Checks `/api/maintenance` once on startup;
 * after that any API call returning 503 { code: 'maintenance' } suffices (see api.ts).
 */
export function MaintenanceHost() {
  const snap = useSyncExternalStore(subscribeMaintenance, getMaintenance)
  useEffect(() => {
    let alive = true
    getJson('/api/maintenance').then(({ data }) => { if (alive && data?.maintenance === true) reportMaintenance(data) }).catch(() => {})
    return () => { alive = false }
  }, [])
  return snap.active ? <MaintenanceScreen initial={snap.info} /> : null
}

/** Notice after maintenance: signed-out users land on the sign-in page and learn why */
export function MaintenanceNotice() {
  useT()
  const { status } = useAuth()
  const [kind, setKind] = useState<'updated' | 'restored' | null>(null)
  const [closed, setClosed] = useState(false)
  useEffect(() => { const k = takeMaintenanceNotice(); if (k) setKind(k) }, [])
  if (!kind || closed || status !== 'anon') return null
  return (
    <div className="fixed top-4 inset-x-4 z-40 mx-auto max-w-md">
      <Banner tone="info" icon={Info} action={<IconButton icon={X} size="sm" label={t('controls.ui.close')} onClick={() => setClosed(true)} />}>
        {kind === 'updated' ? t('maintenance.updatedNotice') : t('maintenance.restoredNotice')}
      </Banner>
    </div>
  )
}
