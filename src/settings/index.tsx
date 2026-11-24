import { Navigate, Outlet, Route } from 'react-router-dom'
import { useFeatures } from '../features'
import { t, useT } from '../i18n'
import { useReachable } from '../offline/hooks'
import { NeedsConnection } from '../offline/ui'
import { Page, PageHeader, SectionLayout, type SectionNavItem } from '../ui'
import { KeyRound, Palette, Sparkles, User, Users } from 'lucide-react'
import { AiTab } from './ai-tab'
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
  const items: SectionNavItem[] = [
    { to: '/settings/account', label: t('settings.tabs.account'), icon: User },
    { to: '/settings/appearance', label: t('settings.tabs.appearance'), icon: Palette },
    { to: '/settings/space', label: t('settings.tabs.space'), icon: Users },
    { to: '/settings/ai', label: t('settings.tabs.ai'), icon: Sparkles },
    ...(f.api ? [{ to: '/settings/api-keys', label: t('settings.tabs.api'), icon: KeyRound }] : []),
  ]
  return (
    <Page>
      <PageHeader title={t('settings.title')} />
      <SectionLayout label={t('settings.tabs.label')} items={items}><Outlet /></SectionLayout>
    </Page>
  )
}

function ApiRoute() {
  const f = useFeatures()
  const reachable = useReachable()
  if (!f.api) return <Navigate to="/settings/account" replace />
  return reachable ? <ApiKeysTab /> : <NeedsConnection />
}

/** Routes under /settings (mounted in AppRoutes) */
export const settingsRoutes = (
  <Route path="/settings" element={<SettingsLayout />}>
    <Route index element={<Navigate to="/settings/account" replace />} />
    <Route path="account" element={<AccountTab />} />
    <Route path="appearance" element={<AppearanceTab />} />
    <Route path="space" element={<SpaceTab />} />
    <Route path="ai" element={<AiTab />} />
    <Route path="api-keys" element={<ApiRoute />} />
    <Route path="*" element={<Navigate to="/settings/account" replace />} />
  </Route>
)
