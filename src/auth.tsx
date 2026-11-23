import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { WifiOff } from 'lucide-react'
import { ApiError, api, errMsg, getSpaceId, setSpaceId, setUnauthorizedHandler, type Me, type Providers, type SpaceInfo, type User } from './api'
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
  const [sharedUnseen, setSharedUnseen] = useState(0)
  // Latest list for callers that switch right after applyMe (state is not updated yet)
  const spacesRef = useRef<SpaceInfo[]>([])

  const pick = useCallback((list: SpaceInfo[], wanted: number | null) => {
    const id = list.find((s) => s.id === wanted)?.id ?? list.find((s) => s.personal)?.id ?? list[0]?.id ?? null
    setSpaceId(id)
    setSpace(id)
  }, [])

  const applyMe = useCallback((me: Me) => {
    setUser(me.user)
    setSharedUnseen(me.shared_unseen ?? 0)
    setSpaces(me.spaces)
    spacesRef.current = me.spaces
    pick(me.spaces, getSpaceId())
    setStatus('ready')
    return me
  }, [pick])

  const refresh = useCallback(async () => {
    try {
      const [me, prov] = await Promise.all([
        api<Me | { setup: true }>('GET', '/api/auth/me').catch((e) => {
          if (e instanceof ApiError && e.status === 401) return null
          throw e
        }),
        api<Providers>('GET', '/api/auth/providers').catch(() => null),
      ])
      setProviders(prov)
      if (me === null) { setUser(null); setStatus('anon') }
      else if ('setup' in me) { setUser(null); setStatus('setup') }
      else applyMe(me)
    } catch (e) {
      setBootError(errMsg(e))
      setStatus('error')
    }
  }, [applyMe])

  useEffect(() => { void refresh() }, [refresh])

  // 401 on any call: back to login, remember the target
  useEffect(() => {
    setUnauthorizedHandler(() => {
      rememberNext(location.pathname + location.search)
      setUser(null)
      setStatus((s) => (s === 'ready' ? 'anon' : s))
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const appName = providers?.app_name || 'Wishy'
  setAppName(appName) // before the texts are rendered (idempotent)
  useEffect(() => { document.title = appName }, [appName])
  // Locale: user setting (if the server provides it) and admin default
  useEffect(() => { setServerLocale(providers?.default_locale) }, [providers?.default_locale])
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
      try { await api('POST', '/api/auth/logout') } catch { /* session is gone anyway */ }
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
