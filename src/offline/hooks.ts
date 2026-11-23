import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react'
import { getSnapshot, onData, realIds, subscribe } from './engine'

/** Connection, queue and sync state */
export const useOffline = () => useSyncExternalStore(subscribe, getSnapshot)
export const useReachable = () => useSyncExternalStore(subscribe, () => getSnapshot().reachable)
/** Changes (and re-renders) when temp ids were mapped to real ones */
export const useIds = () => useSyncExternalStore(subscribe, () => getSnapshot().ids)

/** Reload the data of a page after a sync, when the connection is back or when another tab changed something */
export function useOnData(load: () => unknown) {
  const ref = useRef(load)
  ref.current = load
  useEffect(() => onData(() => void ref.current()), [])
}

/** `useState` for form values: temp ids in it become real ones once the row was synced (open forms keep their input). */
export function useRealState<T>(init: T | (() => T)) {
  const [raw, setRaw] = useState(init)
  const ids = useIds()
  const value = useMemo(() => realIds(raw), [raw, ids])
  const set = useCallback((v: SetStateAction<T>) => setRaw((old) => (typeof v === 'function' ? (v as (old: T) => T)(realIds(old)) : v)), [])
  return [value, set] as const
}
