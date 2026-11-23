/**
 * Sends the queue. One tab at a time (Web Lock, or a lease in IndexedDB without a secure context), op by op in order, each one checked
 * against fresh data of the server first. Nothing is dropped: an op leaves the queue when the server has it (or already had the same
 * values), everything else stays and is retried or waits for the user.
 */
import { byUser, getMeta, req, setMeta, tx } from './idb'
import { isReachable, onReachable, probe, send, type Reply } from './net'
import { decide, findRecord, keepMine, keepTheirs, rebase, recreateBody } from './conflicts'
import { dependents, nextOp, recordKey, resolveOp } from './queue'
import { isListKind } from './routes'
import {
  boot, broadcast, currentUser, emitData, getSnapshot, hasPendingLogout, onQueued, onSession, readOps, remember, setSyncing, updateOp, uuid,
} from './engine'
import { prefetch } from './prefetch'
import type { Op, Row, ServerData } from './types'

const TIMEOUT = 20_000
const LEASE = 45_000
const tabId = uuid()

/** Runs `fn` in at most one tab; with the lease (no Web Locks) a tab that does not get it simply tries again later. */
async function exclusive(fn: () => Promise<void>) {
  if (navigator.locks) return navigator.locks.request('wishy-sync', fn)
  const mine = await tx(['meta'], 'readwrite', async (s) => {
    const l = ((await req(s.meta.get('lease'))) as { v: { tab: string; until: number } } | undefined)?.v
    if (l && l.tab !== tabId && l.until > Date.now()) return false
    s.meta.put({ k: 'lease', v: { tab: tabId, until: Date.now() + LEASE } })
    return true
  })
  if (!mine) return
  const renew = setInterval(() => void setMeta('lease', { tab: tabId, until: Date.now() + LEASE }).catch(() => {}), LEASE / 3)
  try {
    await fn()
  } finally {
    clearInterval(renew)
    if ((await getMeta<{ tab: string }>('lease').catch(() => undefined))?.tab === tabId) await setMeta('lease', null).catch(() => {})
  }
}

let running: Promise<void> | null = null
let again = false
export function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await exclusive(sendQueue)
    } while (again)
  })().catch(() => {}).finally(() => {
    running = null
    schedule()
  })
  return running
}

const listOf = (op: Op) => (op.kind === 'wish' ? op.sub : op.target)

async function sendQueue() {
  const user = currentUser()
  if (user === null || !nextOp(await readOps())) return
  if (!isReachable() && !(await probe())) return
  setSyncing(true)
  const states = new Map<number, Row>()
  const details = new Map<number, Row | null>()
  let spaces: Row[] = []
  let verified = 0
  let changed = false
  try {
    for (;;) {
      const op = nextOp(await readOps())
      if (!op || currentUser() !== user || op.user !== user) return
      // The session must (still) be the one of the user who made the change
      if (Date.now() - verified > 2000) {
        const me = await send('GET', '/api/auth/me', undefined, { timeout: TIMEOUT })
        if (me.status !== 200 || me.data.user?.id !== user || me.data.user.must_setup_2fa) return
        spaces = me.data.spaces
        verified = Date.now()
      }
      const data = await load(op)
      if (data === 'stop') return
      changed = true
      if (data === 'space_gone') {
        await fail(op, { code: 'space_gone' })
        continue
      }
      const verdict = decide(op, data)
      if (verdict.do === 'done') await updateOp(op.seq, () => null)
      else if (verdict.do === 'conflict') await updateOp(op.seq, (o) => ({ ...o, status: 'conflict', conflict: verdict.conflict, error: undefined }))
      else if (!(await transmit(op, verdict.body))) return
    }
  } finally {
    setSyncing(false)
    if (changed) {
      emitData()
      broadcast({ t: 'data' })
      if (currentUser() === user) void prefetch(true)
    }
  }

  /** Fresh data of the server an op is compared with */
  async function load(op: Op): Promise<ServerData | 'stop' | 'space_gone'> {
    if (isListKind(op.kind)) {
      const id = listOf(op)
      if (op.kind === 'list' && op.action === 'create') return {}
      if (!details.has(id)) {
        const r = await send('GET', `/api/wishlists/${id}`, undefined, { timeout: TIMEOUT })
        if (r.status !== 200 && r.status !== 404) return 'stop'
        details.set(id, r.status === 200 && r.data.is_owner ? r.data : null)
      }
      return { detail: details.get(id) }
    }
    const space = op.space!
    if (!spaces.some((s) => s.id === space)) return 'space_gone'
    if (!states.has(space)) {
      const r = await send('GET', '/api/state', undefined, { space, timeout: TIMEOUT })
      if (r.status !== 200) return 'stop'
      if (r.data.space_id !== space) return 'space_gone'
      states.set(space, r.data)
    }
    return { state: states.get(space) }
  }

  /** Sends one op; false = stop the sync (connection, session or server trouble: everything stays in the queue) */
  async function transmit(op: Op, body: Row | null): Promise<boolean> {
    // Marked before it is sent, in the same transaction as an edit that may have been merged into it meanwhile
    let current: Op | null = null
    await updateOp(op.seq, (o) => (current = { ...o, attempts: o.attempts + 1 }))
    const now = current as Op | null
    if (!now) return true
    const r = await send(op.method, op.url, (op.action === 'create' ? now.body : body) ?? undefined, { space: op.space, opId: op.opId, timeout: TIMEOUT })
    if (r.status === 200) return accepted(op, r)
    // Not an answer of the app itself (proxy), an expired session, overload or maintenance: try again later
    if (r.status === 0 || r.status === 401 || r.status === 429 || r.status >= 500 || (!r.data?.code && !r.data?.error)) return false
    if (r.status === 404 && op.action !== 'create') {
      await updateOp(op.seq, (o) => ({ ...o, status: 'conflict', conflict: { kind: 'gone', fields: [] } }))
    } else await fail(op, r.data)
    return true
  }

  async function accepted(op: Op, r: Reply): Promise<boolean> {
    if (op.action === 'create' && !r.createdId) return false // repeated later: the answer contains the id then
    const real = op.action === 'create' ? r.createdId! : op.target
    const isList = isListKind(op.kind)
    if (!isList) {
      states.set(op.space!, r.data)
      if (r.data.user_id === user) verified = Date.now()
    } else if (op.kind === 'list' && op.action !== 'reorder') {
      if (op.action === 'delete') details.set(real, null)
      else details.set(real, { wishes: [], is_owner: true, ...details.get(real), wishlist: r.data })
    } else details.set(op.kind === 'wish' ? op.sub : real, r.data)

    const record = findRecord({ kind: op.kind, target: real }, isList ? { detail: details.get(op.kind === 'wish' ? op.sub : real) } : { state: r.data })
    await tx(['outbox', 'ids'], 'readwrite', async (s) => {
      s.outbox.delete(op.seq)
      const map = new Map(op.action === 'create' ? [[op.target, real]] : [])
      if (op.action === 'create') s.ids.put({ temp: op.target, user, real, at: Date.now() })
      for (const raw of await byUser<Op>(s.outbox, user!)) {
        const o = resolveOp(raw, map)
        if (o.seq !== op.seq && record && o.status === 'pending' && recordKey(o) === recordKey({ kind: op.kind, target: real })) s.outbox.put(rebase(o, op, record))
      }
    })
    await readOps()
    await remember(user, { ...op, target: real }, r.data)
    return true
  }
}

const fail = (op: Op, error: Op['error']) => updateOp(op.seq, (o) => ({ ...o, status: 'failed', error: { code: error?.code, error: error?.error, params: error?.params } }))

// ───────────── Decisions of the user (sync dialog) ─────────────

const resolved = async () => {
  await readOps()
  broadcast({ t: 'data' })
  emitData()
  void syncNow()
}
/** `unit`: one field; null = the whole change */
export async function chooseMine(op: Op, unit: string | null) {
  await updateOp(op.seq, (o) => keepMine(o, unit, uuid()))
  await resolved()
}
export async function chooseTheirs(op: Op, unit: string) {
  await updateOp(op.seq, (o) => keepTheirs(o, unit, uuid()))
  await resolved()
}
export async function retry(op: Op) {
  await updateOp(op.seq, (o) => ({ ...o, status: 'pending', error: undefined }))
  await resolved()
}
/** Changes that go with `op` when it is discarded */
export const discardCount = (op: Op) => dependents(getSnapshot().ops, op).length
export async function discard(op: Op) {
  const list = [op, ...dependents(await readOps(), op)]
  await tx(['outbox'], 'readwrite', (s) => list.forEach((o) => s.outbox.delete(o.seq)))
  await resolved()
}
export const canRecreate = (op: Op) => op.conflict?.kind === 'gone' && recreateBody(op) !== null

const CREATE_URL = { person: '/api/persons', occasion: '/api/occasions', item: '/api/items', gift: '/api/gifts', list: '/api/wishlists' }
/** The record was deleted meanwhile: the change becomes a new record, later changes of the old one follow it. */
export async function recreate(op: Op) {
  const body = recreateBody(op)
  if (!body) return
  await tx(['outbox', 'meta'], 'readwrite', async (s) => {
    const temp = Math.min(((await req(s.meta.get('temp'))) as { v: number } | undefined)?.v ?? -1000, -1000) - 1
    s.meta.put({ k: 'temp', v: temp })
    const url = op.kind === 'wish' ? `/api/wishlists/${op.sub}/wishes` : CREATE_URL[op.kind]
    s.outbox.put({ ...op, action: 'create', method: 'POST', url, body, target: temp, sub: op.kind === 'wish' ? op.sub : 0, base: {}, mine: {}, record: null, opId: uuid(), attempts: 0, status: 'pending', conflict: undefined })
    const moved = (u: string) => u.replace(new RegExp(`/${op.target}(?=/|$)`), `/${temp}`)
    for (const raw of await byUser<Op>(s.outbox, op.user)) {
      const o = resolveOp(raw, getSnapshot().ids)
      if (o.seq === op.seq) continue
      if (o.kind === op.kind && o.target === op.target) s.outbox.put({ ...o, target: temp, url: moved(o.url) })
      else if (op.kind === 'list' && o.kind === 'wish' && o.sub === op.target) s.outbox.put({ ...o, sub: temp, url: o.action === 'create' ? moved(o.url) : o.url })
    }
  })
  await resolved()
}

// ───────────── Triggers ─────────────

const MIN = 5_000
const MAX = 60_000
let delay = MIN
let timer: ReturnType<typeof setTimeout> | undefined
/** A check is scheduled */
let waiting = false

/** Something to wait for: the connection, or changes that could not be sent yet */
const busy = () => hasPendingLogout() || (currentUser() !== null && (!isReachable() || nextOp(getSnapshot().ops) !== null))
function schedule() {
  if (busy() && waiting) return
  clearTimeout(timer)
  waiting = busy()
  if (!waiting) {
    // Only a connection that lasts resets the pace (behind some proxies /healthz answers although the app cannot be reached)
    timer = setTimeout(() => { delay = MIN }, 30_000)
    return
  }
  timer = setTimeout(() => {
    waiting = false
    void tick()
  }, delay)
  delay = Math.min(delay * 2, MAX)
}
async function tick() {
  if (!isReachable()) await probe() // back: see onReachable below
  if (!isReachable()) return schedule()
  if (hasPendingLogout()) reconnectHook() // any request sends the sign-out first
  await syncNow() // schedules the next check
}
/** Check now (connection event, tab in front again, "Sync now") */
export async function kick() {
  if (!busy()) return
  clearTimeout(timer)
  waiting = false
  delay = MIN
  await tick()
}

let reconnectHook: () => void = () => {}
/** The connection is back: check the session */
export const onReconnect = (fn: () => void) => {
  reconnectHook = fn
  return () => { if (reconnectHook === fn) reconnectHook = () => {} }
}

let started = false
export function startSync() {
  if (started) return
  started = true
  onReachable((up) => {
    if (!up) return schedule()
    void syncNow().then(() => {
      reconnectHook()
      emitData()
      void prefetch()
    })
  })
  onQueued(() => void syncNow())
  onSession(() => {
    void syncNow()
    setTimeout(() => void prefetch(), 3000)
  })
  window.addEventListener('online', () => void kick())
  window.addEventListener('offline', () => void probe())
  window.addEventListener('focus', () => void kick())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void kick() })
  void boot().then(schedule)
}
