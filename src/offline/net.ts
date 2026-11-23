/** The raw request and whether the server is reachable. "Unreachable" = no answer from our server; `navigator.onLine` is only a hint. */
import type { Row } from './types.ts'

export interface Reply {
  /** 0 = the server was not reached (the request may have arrived nevertheless) */
  status: number
  statusText: string
  data: Row
  /** `X-Created-Id`: id of the row a create made */
  createdId: number | null
}
export interface SendOptions { space?: number | null; opId?: string; timeout?: number }

let reachable = typeof navigator === 'undefined' || navigator.onLine !== false
const listeners = new Set<(reachable: boolean) => void>()
export const isReachable = () => reachable
export const onReachable = (fn: (reachable: boolean) => void) => { listeners.add(fn) }
export function setReachable(v: boolean) {
  if (v === reachable) return
  reachable = v
  listeners.forEach((fn) => fn(v))
}

let replyHook: (r: Reply) => void = () => {}
/** Called with every answer of the server (maintenance display, expired session) */
export const setReplyHook = (fn: (r: Reply) => void) => { replyHook = fn }

/** Runs before every request; a reply instead of `undefined` is returned for it (an outstanding sign-out comes before anything else). */
let gate: () => Promise<Reply | undefined> = async () => undefined
export const setGate = (fn: typeof gate) => { gate = fn }

const UNREACHABLE: Reply = { status: 0, statusText: '', data: {}, createdId: null }
/**
 * Our server answers every /api request with JSON. Anything else is something in between: a captive portal (200 + a page), a reverse
 * proxy without the server behind it (404, 502, 503, 504, 52x).
 */
const isForeign = (status: number) => status < 400 || status === 404 || status >= 500

/** One request, no side effects except the reachability */
export async function rawSend(method: string, url: string, body?: unknown, opts: SendOptions = {}): Promise<Reply> {
  const abort = opts.timeout ? new AbortController() : null
  const timer = abort ? setTimeout(() => abort.abort(), opts.timeout) : 0
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'wishlist',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.space != null ? { 'X-Space': String(opts.space) } : {}),
        ...(opts.opId ? { 'X-Op-Id': opts.opId } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: abort?.signal,
    })
    // A connection that breaks while the answer arrives counts as unreachable as well
    const text = await res.text()
    let data: Row = {}
    let json = true
    try { data = JSON.parse(text) } catch { json = false }
    if (!json && isForeign(res.status)) {
      setReachable(false)
      return UNREACHABLE
    }
    setReachable(true)
    return { status: res.status, statusText: res.statusText, data, createdId: Number(res.headers.get('X-Created-Id')) || null }
  } catch {
    setReachable(false)
    return UNREACHABLE
  } finally {
    clearTimeout(timer)
  }
}

export async function send(method: string, url: string, body?: unknown, opts?: SendOptions): Promise<Reply> {
  const blocked = await gate()
  const reply = blocked ?? (await rawSend(method, url, body, opts))
  if (reply.status) replyHook(reply)
  return reply
}

/** Is the server there? (asks `/healthz`, which also answers during maintenance) */
export async function probe(): Promise<boolean> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 5000)
  try {
    const res = await fetch('/healthz', { cache: 'no-store', signal: abort.signal })
    const data = await res.json()
    setReachable(typeof data?.status === 'string')
  } catch {
    setReachable(false)
  } finally {
    clearTimeout(timer)
  }
  return reachable
}
