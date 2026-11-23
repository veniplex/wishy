/**
 * Offline engine: session, data cache and queue ("outbox"). `request()` is what api() calls for everything.
 *
 *  - GETs of the planning data and wishlists are cached per user (IndexedDB) and served from there while the server is unreachable.
 *  - Offline-capable writes (routes.ts) that do not reach the server are queued; the caller gets the response computed by the overlay.
 *  - Every state/list a page sees is overlaid with the queue, fresh or cached.
 *
 * Sending the queue is sync.ts. Other tabs are informed via BroadcastChannel.
 */
import { available, byUser, deleteByUser, getMeta, req, setMeta, tx } from './idb'
import { isReachable, onReachable, rawSend, send, setGate, type Reply } from './net'
import { applyToDetail, applyToOverview, applyToState, localDate } from './overlay'
import { diff, findRecord } from './conflicts'
import { append, resolveOp } from './queue'
import { isListKind, parseWrite, resolveIds, resolveUrl, tempRefs } from './routes'
import type { Op, Route, Row } from './types'

const READ_TIMEOUT = 8_000
const WRITE_TIMEOUT = 20_000

// ───────────── Session, snapshot for the UI, messages between tabs ─────────────

let user: number | null = null
let usable = false
let ids: ReadonlyMap<number, number> = new Map()
let ops: Op[] = []
let syncing = false
let lastSync: string | null = null
let booting: Promise<void> | null = null

export interface Snapshot {
  reachable: boolean
  /** IndexedDB works and someone is signed in */
  active: boolean
  ops: Op[]
  syncing: boolean
  /** Last time the local data was brought up to date with the server (ISO) */
  lastSync: string | null
  /** Changes when temp ids were mapped to real ones */
  ids: ReadonlyMap<number, number>
}
const snap = (): Snapshot => ({ reachable: isReachable(), active: usable && user !== null, ops, syncing, lastSync, ids })
let snapshot = snap()
const watchers = new Set<() => void>()
export const subscribe = (fn: () => void) => {
  watchers.add(fn)
  return () => { watchers.delete(fn) }
}
export const getSnapshot = () => snapshot
function notify() {
  snapshot = snap()
  watchers.forEach((fn) => fn())
}
onReachable(notify)

export const currentUser = () => user
export const setSyncing = (v: boolean) => { syncing = v; notify() }
export function setLastSync(at: string) {
  lastSync = at
  notify()
  void cachePut('lastSync', at)
}

/** The real id of a row created offline (temp ids are negative); other ids are returned unchanged. */
export const realId = <T extends number | null | undefined>(id: T): T => (typeof id === 'number' ? ((ids.get(id) ?? id) as T) : id)
export const realIds = <T,>(v: T): T => resolveIds(v, ids)

type Message = { t: 'outbox' } | { t: 'data' } | { t: 'user'; id: number | null }
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('wishy-offline')
export const broadcast = (m: Message) => channel?.postMessage(m)
if (channel) {
  channel.onmessage = (e: MessageEvent<Message>) => {
    const m = e.data
    // Signed out, or someone else signed in, in another tab: this tab must not keep working with the old account
    if (m.t === 'user') { if (user !== null && m.id !== user) location.reload() }
    else void readOps().then(emitData)
  }
}

const dataListeners = new Set<() => void>()
/** Pages reload their data: after a sync, when the connection is back, when another tab changed something */
export const onData = (fn: () => void) => {
  dataListeners.add(fn)
  return () => { dataListeners.delete(fn) }
}
export const emitData = () => dataListeners.forEach((fn) => fn())

let queuedHook: () => void = () => {}
/** A change was queued (or an attention item resolved): time to sync */
export const onQueued = (fn: () => void) => { queuedHook = fn }
let sessionHook: () => void = () => {}
export const onSession = (fn: () => void) => { sessionHook = fn }

/** Loads who was signed in on this device last (needed to start without a connection) */
export function boot(): Promise<void> {
  return (booting ??= (async () => {
    usable = await available()
    if (!usable) return
    try {
      user = (await getMeta<number>('user')) ?? null
      logoutPending = !!(await getMeta<boolean>('logoutPending'))
      lastSync = await cacheGet<string>('lastSync')
      await readOps()
    } catch {
      usable = false
    }
    notify()
  })())
}

/** A response with the signed-in user (GET /me, sign-in, account changes) */
export function setSession(me: Row) {
  const id: number = me.user.id
  const before = user
  user = id
  if (!usable) return
  void (async () => {
    if (before !== id) {
      // Another account: the data of the previous one goes, its queue stays stored (and is only used for that account again)
      await wipeCache(id)
      await setMeta('user', id)
      lastSync = null
      broadcast({ t: 'user', id })
    }
    await cachePut('me', me, id)
    await globalThis.caches?.open(IMAGES)
    await readOps()
    sessionHook()
  })().catch(() => {})
}

/** The session is over (401): cached data is deleted, queued changes are kept for the same user. */
export function sessionLost() {
  if (user === null) return
  user = null
  ops = []
  notify()
  if (!usable) return
  void wipeCache(null).then(() => setMeta('user', null)).catch(() => {})
}

let logoutPending = false
export const hasPendingLogout = () => logoutPending
const logoutDone = (r: Reply) => r.status !== 0 && r.status !== 429 && r.status < 500

/** Sign out: without a connection the sign-out is sent on the next contact, before anything else. Local data and queue are deleted. */
export async function signOut() {
  const u = user
  const r = await send('POST', '/api/auth/logout', undefined, { timeout: isReachable() ? READ_TIMEOUT : 3000 })
  user = null
  ops = []
  ids = new Map()
  notify()
  logoutPending = !logoutDone(r)
  if (!usable) return
  await setMeta('logoutPending', logoutPending || null)
  await setMeta('user', null)
  await wipeCache(null)
  if (u !== null) await wipeQueue(u)
  broadcast({ t: 'user', id: null })
}

let flushing: Promise<Reply | undefined> | null = null
setGate(async () => {
  await boot()
  if (!logoutPending) return undefined
  return (flushing ??= (async () => {
    // Another tab may have done it already (a new session must not be ended)
    const open = !usable || (await getMeta<boolean>('logoutPending').catch(() => true))
    const r = open ? await rawSend('POST', '/api/auth/logout', undefined, { timeout: WRITE_TIMEOUT }) : null
    if (r && !logoutDone(r)) return r
    logoutPending = false
    if (usable) await setMeta('logoutPending', null).catch(() => {})
    return undefined
  })().finally(() => { flushing = null }))
})

// ───────────── Cache ─────────────

/** Product images and profile pictures (filled by the service worker, only while this cache exists) */
export const IMAGES = 'wishy-images'

/** Key of a cacheable GET, null for everything else */
function cacheKey(url: string, space: number | null): string | null {
  const path = url.split('?')[0]
  if (path === '/api/auth/me') return 'me'
  if (path === '/api/state') return space === null ? null : `state:${space}`
  if (/^\/api\/(auth\/providers|wishlists(\/-?\d+)?|spaces\/\d+\/members|gifts\/-?\d+\/events|users\/known|ai\/status)$/.test(path)) return path
  return null
}
/** The public provider info belongs to nobody */
const ownerOf = (key: string) => (key === '/api/auth/providers' ? 0 : user)
/** Counts own writes per key, so an older GET that arrives later does not replace newer data */
const stamps = new Map<string, number>()

export async function cacheGet<T = Row>(key: string): Promise<T | null> {
  const u = ownerOf(key)
  if (!usable || u === null) return null
  return tx(['cache'], 'readonly', async (s) => ((await req(s.cache.get(`${u}|${key}`))) as { data: T } | undefined)?.data ?? null).catch(() => null)
}
/** `owner`: the user the data was requested for (nothing is stored if someone else is signed in by now) */
export async function cachePut(key: string, data: unknown, owner: number | null = user): Promise<void> {
  const u = ownerOf(key)
  if (!usable || u === null || (u !== 0 && u !== owner)) return
  await tx(['cache'], 'readwrite', (s) => { s.cache.put({ k: `${u}|${key}`, user: u, data, at: new Date().toISOString() }) }).catch(() => {})
}
const cacheDelete = async (key: string) => {
  if (usable && user !== null) await tx(['cache'], 'readwrite', (s) => { s.cache.delete(`${user}|${key}`) }).catch(() => {})
}
/** Deletes the cached data of everyone except `keep`, and the images */
async function wipeCache(keep: number | null) {
  await tx(['cache'], 'readwrite', async (s) => {
    for (const key of (await req(s.cache.getAllKeys())) as string[]) {
      const owner = Number(key.split('|')[0])
      if (owner !== 0 && owner !== keep) s.cache.delete(key)
    }
  })
  await globalThis.caches?.delete(IMAGES)
}
const wipeQueue = (u: number) => tx(['outbox', 'ids'], 'readwrite', async (s) => {
  await deleteByUser(s.outbox, u)
  await deleteByUser(s.ids, u)
})
/** "Remove offline data from this device": cache, images and queue of the signed-in user */
export async function clearDevice() {
  if (user === null) return
  await wipeCache(null)
  await wipeQueue(user)
  lastSync = null
  await readOps()
  broadcast({ t: 'outbox' })
  emitData()
}

const isState = (d: unknown): d is Row => !!d && typeof d === 'object' && 'space_id' in d && 'persons' in d && 'occasions' in d
const isDetail = (d: unknown): d is Row => !!d && typeof d === 'object' && 'wishlist' in d && 'wishes' in d && 'is_owner' in d && !('logged_in' in d)

/** Keeps the cache up to date with the response of a write */
export async function remember(owner: number | null, route: Route | null, data: unknown) {
  const put = (key: string, d: unknown) => {
    stamps.set(key, (stamps.get(key) ?? 0) + 1)
    return cachePut(key, d, owner)
  }
  if (isState(data)) return put(`state:${data.space_id}`, data)
  if (isDetail(data)) await put(`/api/wishlists/${data.wishlist.id}`, data)
  if (!route || !isListKind(route.kind) || owner !== user) return
  const overview = await cacheGet('/api/wishlists')
  if (!overview) return
  const list: Row | null = isDetail(data) ? data.wishlist : (data as Row)?.id ? (data as Row) : null
  const gone = route.kind === 'list' && route.action === 'delete'
  const id = gone ? route.target : list?.id
  const known = overview.mine.some((l: Row) => l.id === id)
  const mine = gone ? overview.mine.filter((l: Row) => l.id !== id) : known ? overview.mine.map((l: Row) => (l.id === id ? list ?? l : l)) : list ? [...overview.mine, list] : overview.mine
  await put('/api/wishlists', { ...overview, mine })
  if (gone) await cacheDelete(`/api/wishlists/${id}`)
  else if (route.kind === 'list' && list) {
    const detail = await cacheGet(`/api/wishlists/${id}`)
    await put(`/api/wishlists/${id}`, detail ? { ...detail, wishlist: list } : { wishlist: list, wishes: [], is_owner: true })
  }
}

// ───────────── Views (cache + queue) ─────────────

export async function readOps(): Promise<Op[]> {
  const u = user
  if (!usable || u === null) return []
  const [rows, maps] = await tx(['outbox', 'ids'], 'readonly', async (s) => [await byUser<Op>(s.outbox, u), await byUser<{ temp: number; real: number }>(s.ids, u)] as const)
  if (u !== user) return []
  if (maps.length !== ids.size || maps.some((m) => ids.get(m.temp) !== m.real)) ids = new Map(maps.map((m) => [m.temp, m.real]))
  ops = rows.map((o) => resolveOp(o, ids))
  notify()
  return ops
}

const overlayState = (s: Row, list: Op[]) => list.reduce(applyToState, s)
const overlayDetail = (d: Row | null, list: Op[], id: number) => list.reduce<Row | null>((acc, op) => applyToDetail(acc, op, id), d)

/** A response with the queue applied; `stale` = it comes from the cache */
async function present(key: string | null, data: unknown, stale: boolean): Promise<unknown> {
  const base = stale && isState(data) ? { ...data, today: localDate() } : data
  const list = await readOps().catch(() => ops)
  if (!list.length) return base
  if (isState(base)) return overlayState(base, list)
  if (key === '/api/wishlists') return list.reduce(applyToOverview, base as Row)
  if (isDetail(base)) return overlayDetail(base, list, base.wishlist.id)
  return base
}

/** The planning state as the user sees it, from the cache (conflict dialog) */
export async function cachedState(space: number): Promise<Row | null> {
  const s = await cacheGet(`state:${space}`)
  return s ? ((await present(null, s, false)) as Row) : null
}

// ───────────── Requests ─────────────

const ok = (data: unknown, createdId: number | null = null): Reply => ({ status: 200, statusText: '', data: data as Row, createdId })
const UNREACHABLE: Reply = { status: 0, statusText: '', data: {}, createdId: null }
/** Errors found before anything is sent (texts in errors.code.*) */
const refuse = (status: number, code: string, params?: Row): Reply => ({ status, statusText: '', data: { code, params }, createdId: null })

export async function request(method: string, rawUrl: string, rawBody: unknown, space: number | null): Promise<Reply> {
  await boot()
  const url = resolveUrl(rawUrl, ids)
  const body = resolveIds(rawBody, ids)
  if (method === 'GET') return read(url, space)
  const route = user !== null ? parseWrite(method, url) : null
  if (route) return write(route, method, url, body as Row | undefined, isListKind(route.kind) ? null : space)
  if (tempRefs(url, body).size) return refuse(409, 'offline_row')
  const owner = user
  const reply = await send(method, url, body, { space })
  if (reply.status === 200 && (isState(reply.data) || isDetail(reply.data))) {
    await remember(owner, null, reply.data)
    return { ...reply, data: (await present(null, reply.data, false)) as Row }
  }
  return reply
}

async function read(url: string, space: number | null): Promise<Reply> {
  const key = cacheKey(url, space)
  if (tempRefs(url, null).size) return readTemp(url)
  if (key === null || !usable) return send('GET', url, undefined, { space })
  const owner = user
  const cached = await cacheGet<unknown>(key)
  if (cached !== null && !isReachable()) return ok(await present(key, cached, true))
  const stamp = stamps.get(key)
  const reply = await send('GET', url, undefined, { space, timeout: cached !== null ? READ_TIMEOUT : undefined })
  if (!reply.status && cached !== null && (user === owner || ownerOf(key) === 0)) return ok(await present(key, cached, true))
  if (reply.status !== 200 || user !== owner) return reply
  if (key === 'me') return reply // the sign-in state takes it over (setSession)
  let data: unknown = reply.data
  const actual = isState(data) ? `state:${data.space_id}` : key // the server may have fallen back to the personal space
  if (stamps.get(key) === stamp) await cachePut(actual, data, owner)
  else data = (await cacheGet<unknown>(actual)) ?? data
  return ok(await present(key, data, false))
}

/** Rows that exist only in the queue */
async function readTemp(url: string): Promise<Reply> {
  const list = /^\/api\/wishlists\/(-\d+)$/.exec(url)
  if (list) {
    const detail = overlayDetail(null, await readOps(), Number(list[1]))
    return detail ? ok(detail) : refuse(404, 'wishlist_not_found')
  }
  if (/^\/api\/gifts\/-\d+\/events$/.test(url)) return ok([])
  return refuse(404, 'not_found')
}

// Writes run one after the other, so their order in the queue is the order of the user's actions
let writing: Promise<unknown> = Promise.resolve()
function write(...args: Parameters<typeof writeNow>): Promise<Reply> {
  const run = writing.then(() => writeNow(...args))
  writing = run.catch(() => {})
  return run
}

/** crypto.randomUUID needs a secure context, the app also runs over plain HTTP */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

async function writeNow(route: Route, method: string, url: string, body: Row | undefined, space: number | null): Promise<Reply> {
  const u = user
  const opId = uuid()
  if (!usable) return send(method, url, body, { space, opId })
  const waiting = await readOps()
  if (u === null || u !== user) return UNREACHABLE
  // A row that was created offline but whose change was discarded
  if ([...tempRefs(url, body)].some((id) => !waiting.some((o) => o.action === 'create' && o.target === id))) return refuse(404, 'not_found')
  let attempts = 0
  if (!waiting.length && isReachable()) {
    const reply = await send(method, url, body, { space, opId, timeout: WRITE_TIMEOUT })
    if (reply.status) {
      if (reply.status === 200) await remember(u, route, reply.data)
      return reply
    }
    attempts = 1 // it may have arrived: the same operation id is queued
  }
  if (u !== user) return UNREACHABLE
  try {
    return await enqueue(route, { u, opId, method, url, body, space, attempts })
  } catch {
    return UNREACHABLE // could not be stored: never report success
  }
}

const PERMISSION: Partial<Record<Route['kind'], string>> = { person: 'manage_persons', occasion: 'manage_occasions', item: 'manage_gifts', gift: 'manage_gifts' }
/** Without `view_expenses` the server ignores money fields */
const MONEY = ['price', 'payer_id', 'payment_status', 'paid_at', 'payment_method', 'paid_amount', 'yearly_budget', 'budget']

/** The wishlist a wish belongs to */
async function listOfWish(wish: number, waiting: Op[]): Promise<number | null> {
  const created = waiting.find((o) => o.kind === 'wish' && o.action === 'create' && o.target === wish)
  if (created) return created.sub
  const overview = await cacheGet('/api/wishlists')
  for (const l of overview?.mine ?? []) {
    const d = await cacheGet(`/api/wishlists/${l.id}`)
    if (d?.wishes.some((w: Row) => w.id === wish)) return l.id
  }
  return null
}

/** Own list for a response: the detail view, or at least the list itself when its wishes were never loaded */
async function detailBase(id: number): Promise<Row | null> {
  const d = await cacheGet(`/api/wishlists/${id}`)
  if (d) return d
  const l = (await cacheGet('/api/wishlists'))?.mine.find((x: Row) => x.id === id)
  return l ? { wishlist: l, wishes: [], is_owner: true } : null
}

interface WriteInput { u: number; opId: string; method: string; url: string; body: Row | undefined; space: number | null; attempts: number }

async function enqueue(input: Route, w: WriteInput): Promise<Reply> {
  const route = { ...input }
  let waiting = await readOps()
  let body: Row | null = w.body ? { ...w.body } : null
  let base: Row | null = null
  let data: { state?: Row | null; detail?: Row | null } = {}
  if (isListKind(route.kind)) {
    if (route.kind === 'wish' && route.action !== 'create') {
      const list = await listOfWish(route.target, waiting)
      if (list === null) return UNREACHABLE
      route.sub = list
    }
    const listId = route.kind === 'wish' ? route.sub : route.target
    base = listId ? await detailBase(listId) : null
    data = { detail: listId ? overlayDetail(base, waiting, listId) : null }
    if (route.kind === 'wish' && !data.detail) return UNREACHABLE
  } else {
    base = w.space === null ? null : await cacheGet(`state:${w.space}`)
    if (!base) return UNREACHABLE
    base = { ...base, today: localDate() }
    data = { state: overlayState(base, waiting) }
    const need = PERMISSION[route.kind]!
    const perms = data.state!.permissions
    if (!perms[need]) return refuse(403, 'permission_denied', { permission: need })
    if (!perms.view_expenses) {
      if (route.action === 'payment' || route.action === 'settle') return refuse(403, 'permission_denied', { permission: 'view_expenses' })
      if (body) for (const k of MONEY) if (route.kind !== 'item') delete body[k]
    }
  }

  const response = async () => {
    const list = await readOps()
    if (data.state) return overlayState(base!, list)
    if (route.kind === 'wish' || route.action === 'reorder') return overlayDetail(base, list, route.kind === 'wish' ? route.sub : route.target)
    return route.action === 'delete' ? { ok: true } : overlayDetail(base, list, route.target)!.wishlist
  }

  const record = route.action === 'create' ? null : findRecord(route, data)
  if (!record && route.action !== 'create') return refuse(404, 'not_found')
  const d = diff(route, body, record ?? {})
  body = d.body
  const noop = !['create', 'delete', 'reorder'].includes(route.action) && !Object.keys(d.base).length
  if (noop) return ok(await response())

  if (user !== w.u) return UNREACHABLE // signed out meanwhile
  await tx(['outbox', 'meta'], 'readwrite', async (s) => {
    if (route.action === 'create') {
      // Temp ids count down and are never used twice, also across tabs
      route.target = Math.min(((await req(s.meta.get('temp'))) as { v: number } | undefined)?.v ?? -1000, -1000) - 1
      s.meta.put({ k: 'temp', v: route.target })
    }
    // Another tab may have queued or sent something meanwhile
    waiting = (await byUser<Op>(s.outbox, w.u)).map((o) => resolveOp(o, ids))
    const op: Omit<Op, 'seq'> = {
      ...route, ...d, body, opId: w.opId, user: w.u, space: w.space, method: w.method, url: w.url, record,
      label: String(body?.name ?? body?.title ?? record?.name ?? record?.title ?? ''), at: new Date().toISOString(), attempts: w.attempts, status: 'pending',
    }
    const plan = append(waiting, op as Op)
    plan.remove.forEach((o) => s.outbox.delete(o.seq))
    if (plan.replace) s.outbox.put(plan.replace)
    if (plan.add) s.outbox.add(op)
  })
  void navigator.storage?.persist?.().catch(() => {})
  const result = await response()
  broadcast({ t: 'outbox' })
  queuedHook()
  return ok(result, route.action === 'create' ? route.target : null)
}

/** Changes a queued op (`null` = remove it) in one transaction; returns false if it is gone meanwhile. */
export async function updateOp(seq: number, fn: (op: Op) => Op | null): Promise<boolean> {
  const done = await tx(['outbox'], 'readwrite', async (s) => {
    const row = (await req(s.outbox.get(seq))) as Op | undefined
    if (!row || row.user !== user) return false
    const next = fn(resolveOp(row, ids))
    if (next) s.outbox.put({ ...next, seq })
    else s.outbox.delete(seq)
    return true
  })
  await readOps()
  return done
}
