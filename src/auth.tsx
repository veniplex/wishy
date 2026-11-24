import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { WifiOff } from 'lucide-react'
import { ApiError, api, errMsg, getSpaceId, setSpaceId, setUnauthorizedHandler, type Me, type Providers, type PublicView, type SpaceInfo, type User } from './api'
import { setSession, signOut } from './offline/engine'
import { registerServiceWorker } from './offline/sw-register'
import { applyLinkKey, handOverPublicView, publicApi, publicToken, sharedUrl } from './guest'
import { onReconnect } from './offline/sync'
import { Button, EmptyState, Page, PageSkeleton } from './ui'
import { setAppName, setServerLocale, setUserLocale, t } from './i18n'

type Status = 'loading' | 'setup' | 'anon' | 'ready' | 'error'

interface Auth {
  status: Status
  user: User | null
  spaces: SpaceInfo[]
  /** Current space (always one from the list once signed in) */
  space: SpaceInfo | undefined
  spaceId: number | null
  providers: Providers | null
  appName: string
  /** Number of wishlists newly shared with you */
  sharedUnseen: number
  /** Apply a response in /me format (login, account, spaces …) */
  applyMe: (me: Me) => Me
  switchSpace: (id: number) => void
  logout: () => Promise<void>
  /** Re-check against /api/auth/me (e.g. after setup) */
  refresh: () => Promise<void>
}

const Ctx = createContext<Auth>(null as never)
export const useAuth = () => useContext(Ctx)

const NEXT_KEY = 'wl_next'
export const rememberNext = (path: string) => {
  try { sessionStorage.setItem(NEXT_KEY, path) } catch { /* storage blocked */ }
}
export const peekNext = () => {
  try {
    const v = sessionStorage.getItem(NEXT_KEY)
    return v && v.startsWith('/') && !v.startsWith('//') && !/^\/(login|register|setup|reset-password|invite)/.test(v) ? v : '/'
  } catch {
    return '/'
  }
}
export const takeNext = () => {
  const v = peekNext()
  try { sessionStorage.removeItem(NEXT_KEY) } catch { /* storage blocked */ }
  return v
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [bootError, setBootError] = useState('')
  const [user, setUser] = useState<User | null>(null)
  const [spaces, setSpaces] = useState<SpaceInfo[]>([])
  const [spaceId, setSpace] = useState<number | null>(getSpaceId())
  const [providers, setProviders] = useState<Providers | null>(null)
  /** App name and default language from a public list's answer (the page works without /api/auth/providers) */
  const [publicApp, setPublicApp] = useState<{ name: string; locale: string } | null>(null)
  const [sharedUnseen, setSharedUnseen] = useState(0)
  // Latest list for callers that switch right after applyMe (state is not updated yet)
  const spacesRef = useRef<SpaceInfo[]>([])

  const pick = useCallback((list: SpaceInfo[], wanted: number | null) => {
    const id = list.find((s) => s.id === wanted)?.id ?? list.find((s) => s.personal)?.id ?? list[0]?.id ?? null
    setSpaceId(id)
    setSpace(id)
  }, [])

  const userRef = useRef<User | null>(null)
  userRef.current = user
  const applyMe = useCallback((me: Me) => {
    setSession(me)
    registerServiceWorker({ force: true }) // a public list page installs nothing for guests (see sw-register.ts)
    // The session of this browser now belongs to someone else (signed in in another tab): start over with their data
    if (userRef.current && userRef.current.id !== me.user.id) location.reload()
    setUser(me.user)
    setSharedUnseen(me.shared_unseen ?? 0)
    setSpaces(me.spaces)
    spacesRef.current = me.spaces
    pick(me.spaces, getSpaceId())
    setStatus('ready')
    return me
  }, [pick])

  const refresh = useCallback(async () => {
    // A public list page (/w/:token) works with the paths a sign-in proxy lets through (/api/shared/*) and never waits for the rest:
    // the list says whether this browser has a session; only then is /api/auth/me asked, and if that fails the visitor stays a guest.
    const token = publicToken()
    if (token) {
      try {
        await applyLinkKey(token) // a personal link (#g=<key>): take the key over before the list is asked for
        const view = await publicApi<PublicView>('GET', sharedUrl(token), token)
        handOverPublicView(token, view)
        if (view.app) setPublicApp({ name: view.app.name, locale: view.app.default_locale })
        if (!view.logged_in) { setUser(null); setStatus('anon'); return }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) { setUser(null); setStatus('anon'); return } // the page shows "no longer shared"
      }
    }
    try {
      const [me, prov] = await Promise.all([
        api<Me | { setup: true }>('GET', '/api/auth/me').catch((e) => {
          if (e instanceof ApiError && e.status === 401) return null
          throw e
        }),
        api<Providers>('GET', '/api/auth/providers').catch(() => null),
      ])
      if (prov) setProviders(prov)
      if (me === null) { setUser(null); setStatus('anon') }
      else if ('setup' in me) { setUser(null); setStatus('setup') }
      else applyMe(me)
    } catch (e) {
      if (token) { setStatus((s) => (s === 'ready' ? s : 'anon')); return } // a public page is never blocked by this
      setBootError(errMsg(e))
      setStatus((s) => (s === 'ready' ? s : 'error')) // a running app goes on with what it has
    }
  }, [applyMe])

  useEffect(() => { void refresh() }, [refresh])
  // Connection is back: is the session still valid?
  useEffect(() => onReconnect(() => void refresh()), [refresh])

  // 401 on any call: back to login, remember the target
  useEffect(() => {
    setUnauthorizedHandler(() => {
      rememberNext(location.pathname + location.search)
      setUser(null)
      setStatus((s) => (s === 'ready' ? 'anon' : s))
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const appName = providers?.app_name || publicApp?.name || 'Wishy'
  setAppName(appName) // before the texts are rendered (idempotent)
  useEffect(() => { document.title = appName }, [appName])
  // Locale: user setting (if the server provides it) and admin default
  useEffect(() => { setServerLocale(providers?.default_locale ?? publicApp?.locale) }, [providers?.default_locale, publicApp?.locale])
  useEffect(() => { setUserLocale(user?.locale) }, [user?.locale])

  const value = useMemo<Auth>(() => ({
    status,
    user,
    spaces,
    space: spaces.find((s) => s.id === spaceId),
    spaceId,
    providers,
    appName,
    sharedUnseen,
    applyMe,
    switchSpace: (id) => pick(spacesRef.current, id),
    logout: async () => {
      await signOut().catch(() => {}) // local data is deleted; without a connection the server is told on the next contact
      setUser(null)
      setSpaces([])
      setStatus('anon')
    },
    refresh,
  }), [status, user, spaces, spaceId, providers, appName, sharedUnseen, applyMe, pick, refresh])

  if (status === 'loading') return <PageSkeleton />
  if (status === 'error') {
    return (
      <Page>
        <EmptyState icon={WifiOff} action={<Button onClick={() => { setStatus('loading'); void refresh() }}>{t('common.retry')}</Button>}>
          {t('errors.unreachable', { detail: bootError })}
        </EmptyState>
      </Page>
    )
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Protects routes: without a session, redirects to setup or login (target is remembered). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const loc = useLocation()
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'anon') {
    rememberNext(loc.pathname + loc.search)
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}
