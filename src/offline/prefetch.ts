/** Loads everything the user can see in the background, so all of it (not only visited pages) is available offline. */
import { byUser, req, tx } from './idb'
import { isReachable } from './net'
import { IMAGES, cacheGet, cachePut, currentUser, request, setLastSync } from './engine'
import type { Row } from './types'

const EVERY = 15 * 60_000
const MAX_IMAGES = 250
/** Open pages and bookmarks may still use a temp id for a while */
const KEEP_IDS = 30 * 86_400_000

let running = false
/** At most every 15 minutes, `force` (after a sync) at once */
export async function prefetch(force = false) {
  const user = currentUser()
  if (user === null || running || !isReachable()) return
  running = true
  try {
    const last = (await cacheGet<number>('prefetch')) ?? 0
    if (!force && Date.now() - last < EVERY) return
    await load(user)
  } catch { /* storage trouble: the pages load their own data */ } finally {
    running = false
  }
}

async function load(user: number) {
  const me = await cacheGet('me')
  if (!me) return
  const images = new Set<string>()
  const collect = (rows: Row[]) => rows.forEach((r) => { if (typeof r.image_url === 'string' && r.image_url.startsWith('/api/images/')) images.add(r.image_url) })
  const get = async (url: string, space: number | null = null): Promise<Row | null> => {
    if (currentUser() !== user || !isReachable()) throw new Error('stopped')
    const r = await request('GET', url, undefined, space)
    return r.status === 200 ? r.data : null
  }
  const keep = new Set(['me', 'lastSync', '/api/wishlists', '/api/users/known', '/api/ai/status'])
  for (const sp of me.spaces as Row[]) {
    keep.add(`state:${sp.id}`).add(`/api/spaces/${sp.id}/members`)
    const s = await get('/api/state', sp.id)
    if (s) {
      collect(s.items); collect(s.inbox_items ?? []); collect(s.gifts)
      s.persons.forEach((p: Row) => { if (p.linked_user_id) images.add(`/api/avatars/${p.linked_user_id}`) })
    }
    await get(`/api/spaces/${sp.id}/members`)
  }
  if (me.user.avatar_url) images.add(me.user.avatar_url)
  const overview = await get('/api/wishlists')
  for (const l of [...(overview?.mine ?? []), ...(overview?.shared ?? [])] as Row[]) {
    if (l.id < 0) continue
    keep.add(`/api/wishlists/${l.id}`)
    const d = await get(`/api/wishlists/${l.id}?prefetch=1`) // does not count as "seen"
    if (d) collect(d.wishes)
  }
  await get('/api/users/known')
  await get('/api/ai/status')
  await get('/api/auth/providers')
  if (overview) await prune(user, keep)
  await cachePut('prefetch', Date.now(), user)
  if (currentUser() === user) setLastSync(new Date().toISOString())
  void loadImages([...images].slice(0, MAX_IMAGES))
}

/** Lists and spaces the user no longer has access to must not stay on the device; old temp ids are only needed by queued changes. */
const prune = (user: number, keep: Set<string>) => tx(['cache', 'outbox', 'ids'], 'readwrite', async (s) => {
  if (!(await byUser(s.outbox, user)).length) {
    for (const m of await byUser<{ temp: number; at: number }>(s.ids, user)) if (m.at < Date.now() - KEEP_IDS) s.ids.delete(m.temp)
  }
  for (const k of (await req(s.cache.getAllKeys())) as string[]) {
    if (!k.startsWith(`${user}|`)) continue
    const key = k.slice(`${user}|`.length)
    if (!keep.has(key) && !key.startsWith('/api/gifts/')) s.cache.delete(k)
  }
})

/** Lets the service worker fetch and cache the images */
async function loadImages(urls: string[]) {
  if (!navigator.serviceWorker?.controller) return
  try {
    const cache = await caches.open(IMAGES)
    for (const url of urls) {
      if (!isReachable() || currentUser() === null) return
      if (!(await cache.match(url))) await fetch(url)
    }
  } catch { /* convenience only */ }
}
