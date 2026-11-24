import { type ReactNode } from 'react'
import { Navigate, Outlet, Route } from 'react-router-dom'
import { DatabaseBackup, KeyRound, LogIn, RefreshCw, ScrollText, Server, Settings2, Sparkles, Users, type LucideIcon } from 'lucide-react'
import { t, useT, type TKey } from '../i18n'
import { Page, PageHeader, SectionLayout } from '../ui'
import { UpdateBanner, useUpdateAvailability } from '../update-banner'
import { useReachable } from '../offline/hooks'
import { NeedsConnection } from '../offline/ui'
import { AdminOnly } from './shared'
import { AdminGeneral } from './general'
import { AdminLogin } from './login'
import { AdminUsers } from './users'
import { AdminAi } from './ai'
import { AdminApi } from './api'
import { AdminAudit } from './audit'
import { AdminBackups } from './backups'
import { AdminUpdates } from './updates'
import { AdminSystem } from './system'

/** Sections of the admin area (order = navigation). New section: add it here + route below + file in src/admin/. */
const SECTIONS: { path: string; label: TKey; icon: LucideIcon; element: ReactNode }[] = [
  { path: 'general', label: 'admin.nav.general', icon: Settings2, element: <AdminGeneral /> },
  { path: 'sign-in', label: 'admin.nav.login', icon: LogIn, element: <AdminLogin /> },
  { path: 'users', label: 'admin.nav.users', icon: Users, element: <AdminUsers /> },
  { path: 'ai', label: 'admin.nav.ai', icon: Sparkles, element: <AdminAi /> },
  { path: 'api', label: 'admin.nav.api', icon: KeyRound, element: <AdminApi /> },
  { path: 'audit', label: 'admin.nav.audit', icon: ScrollText, element: <AdminAudit /> },
  { path: 'backups', label: 'admin.nav.backups', icon: DatabaseBackup, element: <AdminBackups /> },
  { path: 'updates', label: 'admin.nav.updates', icon: RefreshCw, element: <AdminUpdates /> },
  { path: 'system', label: 'admin.nav.system', icon: Server, element: <AdminSystem /> },
]

/** Frame: header + section navigation (shared SectionLayout) + content */
export function AdminLayout() {
  useT()
  const { version: updateVersion } = useUpdateAvailability()
  const reachable = useReachable()
  const items = SECTIONS.map((s) => ({
    to: `/admin/${s.path}`, label: t(s.label), icon: s.icon,
    badge: s.path === 'updates' && updateVersion ? <span className="size-2 rounded-full bg-accent shrink-0" role="img" aria-label={t('update.menu.dot')} /> : undefined,
  }))
  return (
    <AdminOnly>
      <Page>
        <PageHeader title={t('admin.title')} sub={t('admin.sub')} />
        <div className="empty:hidden mb-5"><UpdateBanner /></div>
        <SectionLayout label={t('admin.nav.label')} items={items}>{reachable ? <Outlet /> : <NeedsConnection />}</SectionLayout>
      </Page>
    </AdminOnly>
  )
}

/** Routes under /admin (mounted in AppRoutes) */
export const adminRoutes = (
  <Route path="/admin" element={<AdminLayout />}>
    <Route index element={<Navigate to="/admin/general" replace />} />
    {SECTIONS.map((s) => <Route key={s.path} path={s.path} element={s.element} />)}
    <Route path="*" element={<Navigate to="/admin/general" replace />} />
  </Route>
)
