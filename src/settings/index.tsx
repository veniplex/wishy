import { Navigate, Outlet, Route } from 'react-router-dom'
import { useFeatures } from '../features'
import { t, useT } from '../i18n'
import { Page, PageHeader, type TabItem } from '../ui'
import { AccountTab } from './account-tab'
import { AppearanceTab } from './appearance-tab'
import { SpaceTab } from './space-tab'
import { ApiKeysTab } from './api-tab'

/**
 * Settings (/settings): Account · Appearance · Space · API keys (only with the `api` feature).
 * Frame for all tabs; each tab lives in its own file (account-tab, appearance-tab, space-tab, api-tab).
 */
export function SettingsLayout() {
  useT()
  const f = useFeatures()
  const tabs: TabItem[] = [
    { to: '/settings/account', label: t('settings.tabs.account') },
    { to: '/settings/appearance', label: t('settings.tabs.appearance') },
    { to: '/settings/space', label: t('settings.tabs.space') },
    ...(f.api ? [{ to: '/settings/api-keys', label: t('settings.tabs.api') }] : []),
  ]
  return (
    <Page>
      <PageHeader title={t('settings.title')} tabs={tabs} />
      <Outlet />
    </Page>
  )
}

function ApiRoute() {
  const f = useFeatures()
  return f.api ? <ApiKeysTab /> : <Navigate to="/settings/account" replace />
}

/** Routes under /settings (mounted in AppRoutes) */
export const settingsRoutes = (
  <Route path="/settings" element={<SettingsLayout />}>
    <Route index element={<Navigate to="/settings/account" replace />} />
    <Route path="account" element={<AccountTab />} />
    <Route path="appearance" element={<AppearanceTab />} />
    <Route path="space" element={<SpaceTab />} />
    <Route path="api-keys" element={<ApiRoute />} />
    <Route path="*" element={<Navigate to="/settings/account" replace />} />
  </Route>
)
