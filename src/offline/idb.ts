/** IndexedDB of the offline engine. Without IndexedDB (blocked, private mode) `available()` is false and the app works online only. */

const NAME = 'wishy-offline'
/** cache: { k: '<user>|<key>', user, data, at } · outbox: queued changes (key `seq`) · ids: { temp, user, real, at } · meta: { k, v } */
const STORES = ['cache', 'outbox', 'ids', 'meta'] as const
export type StoreName = (typeof STORES)[number]

let opening: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  return (opening ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(NAME, 1)
      r.onupgradeneeded = () => {
        const db = r.result
        db.createObjectStore('cache', { keyPath: 'k' }).createIndex('user', 'user')
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }).createIndex('user', 'user')
        db.createObjectStore('ids', { keyPath: 'temp' }).createIndex('user', 'user')
        db.createObjectStore('meta', { keyPath: 'k' })
      }
      r.onsuccess = () => {
        const db = r.result
        // Another tab deletes or upgrades the database / the browser closed it: open again on the next use
        db.onversionchange = () => { db.close(); opening = null }
        db.onclose = () => { opening = null }
        resolve(db)
      }
      r.onerror = () => resolve(null)
      r.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  }))
}
export const available = async () => (await open()) !== null

/** Promise of an IndexedDB request */
export const req = <T,>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error)
})

/**
 * Runs `fn` in one transaction and resolves after the transaction is complete (written). `fn` may only await requests of this transaction.
 * Rejects if IndexedDB is unavailable or the write fails (e.g. no space left).
 */
export async function tx<T>(names: StoreName[], mode: IDBTransactionMode, fn: (s: Record<StoreName, IDBObjectStore>) => Promise<T> | T): Promise<T> {
  const db = await open()
  if (!db) throw new Error('IndexedDB unavailable')
  const t = db.transaction(names, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction failed'))
  })
  done.catch(() => {}) // reported below
  const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)])) as Record<StoreName, IDBObjectStore>
  let result: T
  try {
    result = await fn(stores)
  } catch (e) {
    try { t.abort() } catch { /* already finished */ }
    throw e
  }
  await done
  return result
}

export const byUser = <T,>(store: IDBObjectStore, user: number): Promise<T[]> => req(store.index('user').getAll(user)) as Promise<T[]>
export async function deleteByUser(store: IDBObjectStore, user: number) {
  for (const key of await req(store.index('user').getAllKeys(user))) store.delete(key)
}

export const getMeta = <T,>(k: string): Promise<T | undefined> => tx(['meta'], 'readonly', async (s) => ((await req(s.meta.get(k))) as { v: T } | undefined)?.v)
export const setMeta = (k: string, v: unknown): Promise<void> => tx(['meta'], 'readwrite', (s) => { if (v === undefined || v === null) s.meta.delete(k); else s.meta.put({ k, v }) })
