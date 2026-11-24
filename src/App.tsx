import { Fragment, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom'
import { EyeOff } from 'lucide-react'
import { StoreProvider, useStore } from './store'
import { AuthProvider, RequireAuth, useAuth } from './auth'
import { DialogHost } from './forms'
import { Dashboard, Gifts, Ideas, Occasions, Persons } from './pages'
import { lazyRoute } from './lazy'
import { BottomTabs, TopBar } from './nav'
import { InvitePage, Login, PasswordReset, Register, Setup } from './auth-pages'
import { MyLists, PublicShell, PublicWishlistBody, SharedWithMe, WishlistDetail } from './wishlists'
import { Banner, Button, ConfirmProvider, PageSkeleton, ToastProvider } from './ui'
import { ForcedTwoFactorSetup } from './auth-2fa'
import { joinNames } from './lib'
import { MaintenanceHost, MaintenanceNotice } from './maintenance'
import { UpdateAvailabilityProvider } from './update-banner'
import { t, useLocale, useT } from './i18n'

const OccasionDetail = lazyRoute(() => import('./occasion-view').then((m) => ({ default: m.OccasionDetail })))
const PersonDetail = lazyRoute(() => import('./person-planning').then((m) => ({ default: m.PersonDetail })))
const Finance = lazyRoute(() => import('./finance').then((m) => ({ default: m.Finance })))
const SettingsRoutes = lazyRoute(() => import('./settings').then((m) => ({ default: m.SettingsRoutes })))
const AdminRoutes = lazyRoute(() => import('./admin').then((m) => ({ default: m.AdminRoutes })))

/** After a route change (not Back/Forward): scroll to the top and move focus to the page title, so keyboard and screen reader users start at the new page */
function RouteFocus() {
  const { pathname } = useLocation()
  const type = useNavigationType()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (type === 'POP') return
    window.scrollTo(0, 0)
    const timer = window.setTimeout(() => {
      const active = document.activeElement
      if (document.querySelector('[role="dialog"]') || (active && active !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return
      const h = document.querySelector<HTMLElement>('main h1')
      if (!h) return
      h.tabIndex = -1
      h.style.outline = 'none'
      h.focus({ preventScroll: true })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [pathname, type])
  return null
}

function Layout({ children }: { children: ReactNode }) {
  useT()
  const { hidden, setHidden, person, hiddenCount } = useStore()
  return (
    <div className="min-h-dvh">
      <RouteFocus />
      <TopBar />
      <main>
        {hidden.length > 0 && (
          <div className="mx-auto max-w-[1120px] px-4 md:px-10 mt-4">
            <Banner
              tone="warn"
              icon={EyeOff}
              action={<Button variant="link" className="!text-inherit underline underline-offset-2 shrink-0" onClick={() => setHidden([])}>{t('nav.privacy.lift')}</Button>}
            >
              {t('nav.privacy.banner', { names: joinNames(hidden.map((id) => person(id)?.name ?? '?')), count: hiddenCount })}
            </Banner>
          </div>
        )}
        {children}
      </main>
      <BottomTabs />
      <DialogHost />
    </div>
  )
}

/** App frame with the state of the current space; switching space reloads everything (key). */
function Shell({ children }: { children: ReactNode }) {
  const { spaceId } = useAuth()
  return <StoreProvider key={spaceId}><Layout>{children}</Layout></StoreProvider>
}

function AppRoutes() {
  return (
    <Suspense fallback={<PageSkeleton />}>
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/wishlists" element={<MyLists />} />
      <Route path="/wishlists/shared" element={<SharedWithMe />} />
      <Route path="/wishlists/:id" element={<WishlistDetail />} />
      <Route path="/gifting" element={<Persons />} />
      <Route path="/gifting/ideas" element={<Ideas />} />
      <Route path="/gifting/gifts" element={<Gifts />} />
      <Route path="/gifting/expenses" element={<Finance />} />
      <Route path="/gifting/:personId" element={<PersonDetail />} />
      <Route path="/calendar" element={<Occasions />} />
      <Route path="/calendar/:occasionId" element={<OccasionDetail />} />
      <Route path="/settings/*" element={<SettingsRoutes />} />
      <Route path="/admin/*" element={<AdminRoutes />} />
      <Route path="*" element={<Dashboard />} />
    </Routes>
    </Suspense>
  )
}

/** /w/:token: inside the app when signed in, otherwise in the plain public shell */
function SharedRoute() {
  const { status } = useAuth()
  return status === 'ready'
    ? <Shell><PublicWishlistBody /></Shell>
    : <PublicShell><PublicWishlistBody /></PublicShell>
}

/** Language change: rebuild the tree so all `t()` calls (even outside components using useT) pick up the new text */
function LocaleBoundary({ children }: { children: ReactNode }) {
  const locale = useLocale()
  const { appName } = useAuth() // the product name in texts follows the app name (see setAppName in i18n)
  return <Fragment key={`${locale}|${appName}`}>{children}</Fragment>
}

/** "Two-factor required" policy: until a method is active, only the setup screen is shown */
function TwoFactorGate({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return user?.must_setup_2fa ? <ForcedTwoFactorSetup /> : <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <ConfirmProvider>
        <ToastProvider>
          <MaintenanceHost />
          <AuthProvider>
            <LocaleBoundary>
            <UpdateAvailabilityProvider>
            <MaintenanceNotice />
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="/reset-password" element={<PasswordReset />} />
              <Route path="/invite/:token" element={<InvitePage />} />
              <Route path="/w/:token" element={<SharedRoute />} />
              <Route path="*" element={<RequireAuth><TwoFactorGate><Shell><AppRoutes /></Shell></TwoFactorGate></RequireAuth>} />
            </Routes>
            </UpdateAvailabilityProvider>
            </LocaleBoundary>
          </AuthProvider>
        </ToastProvider>
      </ConfirmProvider>
    </BrowserRouter>
  )
}
