import { useCallback, useEffect, useState } from 'react'
import { api, errMsg } from '../api'
import { useAuth } from '../auth'
import { t } from '../i18n'
import { useToast } from '../ui'

export interface GeneralSettings {
  app_name: string
  base_url: string
  default_locale: string
  locales: string[]
  trust_proxy: string
  effective_base_url: string
  retention_audit_days: number
  retention_ai_usage_days: number
  retention_sessions_days: number | null
  retention_ip_days: number
  env_locked: string[]
}
export interface AuthSettings {
  registration_enabled: boolean
  registration_mode: 'open' | 'invite'
  google_enabled: boolean
  google_credentials_set: boolean
  google_client_id: string
  google_client_secret_set: boolean
  redirect_uri: string
  two_factor_policy: 'optional' | 'required'
  env_locked: string[]
}

/**
 * Load an admin settings group and save it partially (`GET/PUT /api/admin/settings/<group>`).
 * After saving, the public configuration (providers, name) is reloaded so the sign-in page and header follow.
 */
export function useSettingsGroup<T extends { env_locked: string[] }>(group: 'general' | 'auth') {
  const { refresh } = useAuth()
  const toast = useToast()
  const [cfg, setCfg] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { api<T>('GET', `/api/admin/settings/${group}`).then(setCfg).catch((e) => setError(errMsg(e))) }, [group])
  const save = useCallback(async (body: object) => {
    setError('')
    setSaving(true)
    try {
      setCfg(await api<T>('PUT', `/api/admin/settings/${group}`, body))
      toast(t(group === 'auth' ? 'adminAuth.saved' : 'adminGeneral.saved'), 'ok')
      void refresh()
      return true
    } catch (e) {
      setError(errMsg(e))
      return false
    } finally {
      setSaving(false)
    }
  }, [group, refresh, toast])
  const locked = (k: string) => !!cfg?.env_locked.includes(k)
  return { cfg, error, saving, save, locked }
}
