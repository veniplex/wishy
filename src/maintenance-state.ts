/**
 * "Maintenance" state (dependency-free so api.ts can report it). The full-screen display lives in maintenance.tsx.
 * `reportMaintenance` is called as soon as any API call returns 503 { code: 'maintenance' }.
 */
export interface MaintenanceInfo {
  state?: string
  message?: string
  step?: string | null
  progress?: number | null
  version?: string | null
  target_version?: string | null
}
export interface MaintenanceSnapshot { active: boolean; info: MaintenanceInfo | null }

let snap: MaintenanceSnapshot = { active: false, info: null }
const listeners = new Set<() => void>()

export const subscribeMaintenance = (fn: () => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export const getMaintenance = () => snap

export function reportMaintenance(info?: MaintenanceInfo | null) {
  // Only report again on change (many parallel calls hit 503 at the same time)
  if (snap.active && !info) return
  snap = { active: true, info: info ?? snap.info }
  listeners.forEach((fn) => fn())
}
export function endMaintenanceView() {
  if (!snap.active) return
  snap = { active: false, info: null }
  listeners.forEach((fn) => fn())
}

/** Marker across page reloads: after maintenance (update/restore), signed-out users get a notice */
const NOTICE_KEY = 'wishy_maintenance_notice'
export const rememberMaintenanceNotice = (kind: 'updated' | 'restored') => {
  try { sessionStorage.setItem(NOTICE_KEY, kind) } catch { /* storage blocked */ }
}
export const takeMaintenanceNotice = (): 'updated' | 'restored' | null => {
  try {
    const v = sessionStorage.getItem(NOTICE_KEY)
    sessionStorage.removeItem(NOTICE_KEY)
    return v === 'updated' || v === 'restored' ? v : null
  } catch {
    return null
  }
}
