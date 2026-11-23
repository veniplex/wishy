import { useEffect, useRef, type ReactNode } from 'react'
import { Navigate, NavLink, Outlet, Route, useLocation } from 'react-router-dom'
import { DatabaseBackup, KeyRound, LogIn, RefreshCw, ScrollText, Server, Settings2, Sparkles, Users, type LucideIcon } from 'lucide-react'
import { t, useT, type TKey } from '../i18n'
import { Page, PageHeader } from '../ui'
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

/** Frame: header + section navigation (a list on the left from tablet up, a scrollable pill bar on phones) + content */
export function AdminLayout() {
  useT()
  const nav = useRef<HTMLElement>(null)
  const { pathname } = useLocation()
  const { version: updateVersion } = useUpdateAvailability()
  const reachable = useReachable()
  // Phone: keep the active section visible in the scrollable bar
  useEffect(() => { nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' }) }, [pathname])
  return (
    <AdminOnly>
      <Page>
        <PageHeader title={t('admin.title')} sub={t('admin.sub')} />
        <div className="empty:hidden mb-5"><UpdateBanner /></div>
        <div className="grid gap-6 md:gap-10 md:grid-cols-[13rem_minmax(0,1fr)] items-start">
          <nav ref={nav} aria-label={t('admin.nav.label')} className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible -mx-4 px-4 md:mx-0 md:px-0 pb-1 md:pb-0 md:sticky md:top-4 [scrollbar-width:none]">
            {SECTIONS.map((s) => (
              <NavLink key={s.path} to={`/admin/${s.path}`} className={({ isActive }) => `nav-link shrink-0 ${isActive ? 'nav-link-on' : ''}`}>
                <s.icon size={18} strokeWidth={2} className="shrink-0" /> {t(s.label)}
                {s.path === 'updates' && updateVersion && <span className="size-2 rounded-full bg-accent shrink-0" role="img" aria-label={t('update.menu.dot')} />}
              </NavLink>
            ))}
          </nav>
          <div className="min-w-0">{reachable ? <Outlet /> : <NeedsConnection />}</div>
        </div>
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
