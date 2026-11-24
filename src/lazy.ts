import { createElement, lazy, type ComponentType, type ReactNode } from 'react'
import { Routes, UNSAFE_RouteContext } from 'react-router-dom'

const KEY = 'wishy.chunk-reload'

/** Reloads the page once (per 30 s) after a chunk failed to load, e.g. because an update replaced the hashed files. */
export function reloadOnceForChunkError(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0)
    if (Date.now() - last < 30_000) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return false
  }
  window.location.reload()
  return true
}

/** React.lazy for a route/dialog chunk; a failed load reloads the page once instead of breaking. */
export function lazyRoute<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((e) => {
      if (reloadOnceForChunkError()) return new Promise<never>(() => {}) // page is reloading
      throw e
    }),
  )
}

/**
 * Routes with absolute paths ("/admin/users") inside a lazily loaded `path="/admin/*"` element: the route context is reset so they
 * match against the full URL instead of the part after the parent's base.
 */
export function RootRoutes({ children }: { children: ReactNode }) {
  return createElement(UNSAFE_RouteContext.Provider, { value: { outlet: null, matches: [], isDataRoute: false } }, createElement(Routes, null, children))
}
