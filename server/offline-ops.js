// Idempotent offline-capable writes. A client that works offline queues its changes and sends them later with a header
// `X-Op-Id: <uuid>`; when a response got lost it sends the same op again. The first time the handler runs and the op is recorded in
// the SAME transaction as the write (client_ops); a repeat is answered with the current response of the route without running the
// handler again. Ids are scoped by user: another user's op id is an unrelated, unknown op. Only successful writes are recorded.
// Sessions only (the public API /api/v1 has its own router and never reaches this). Without the header the routes behave as before,
// except that creates also report the new row in the `X-Created-Id` response header.
import { db, tx } from './db.js'
import { HttpError } from './util.js'
import { withSink } from './ops-sink.js'
import { getState } from './planning.js'
import { spaceCtx } from './spaces.js'
import { replayView } from './wishlists.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** view: how the current response of the route is rebuilt for a repeat. creates: the route makes a new row (X-Created-Id). */
const ROUTES = [
  ['POST', '/api/persons', 'state', true],
  ['PUT', '/api/persons/:id', 'state'],
  ['DELETE', '/api/persons/:id', 'state'],
  ['POST', '/api/occasions', 'state', true],
  ['PUT', '/api/occasions/:id', 'state'],
  ['DELETE', '/api/occasions/:id', 'state'],
  ['PUT', '/api/occasions/:id/persons/:personId', 'state'],
  ['POST', '/api/items', 'state', true],
  ['PUT', '/api/items/:id', 'state'],
  ['DELETE', '/api/items/:id', 'state'],
  ['POST', '/api/items/:id/assign', 'state'],
  ['POST', '/api/gifts', 'state', true],
  ['PUT', '/api/gifts/:id', 'state'],
  ['DELETE', '/api/gifts/:id', 'state'],
  ['POST', '/api/gifts/:id/status', 'state'],
  ['POST', '/api/gifts/:id/payment', 'state'],
  ['POST', '/api/gifts/:id/givers/:personId/settle', 'state'],
  ['POST', '/api/wishlists', 'list-created', true],
  ['PUT', '/api/wishlists/:id', 'list'],
  ['DELETE', '/api/wishlists/:id', 'ok'],
  ['POST', '/api/wishlists/:id/wishes', 'detail', true],
  ['POST', '/api/wishlists/:id/reorder', 'detail'],
  ['PUT', '/api/wishes/:id', 'wish'],
  ['DELETE', '/api/wishes/:id', 'wish-deleted'],
].map(([method, pattern, view, creates = false]) => ({
  method,
  view,
  creates,
  // Express matches case-insensitively and ignores a trailing slash; so does this
  re: new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}/?$`, 'i'),
}))

/** Path as stored for the "same op, same route" comparison: no query, no trailing slash, lower case. */
const normPath = (req) => String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '').toLowerCase()

function repeatBody(req, row, route, params) {
  switch (route.view) {
    case 'state':
      return getState(spaceCtx(req)) // built for the requesting user with the normal context: surprise protection applies
    case 'list-created':
      return replayView(req, 'list', row.created_id)
    case 'list':
      return replayView(req, 'list', params[0])
    case 'ok':
      return { ok: true }
    case 'detail':
      return replayView(req, 'detail', params[0])
    case 'wish':
      return replayView(req, 'wish', params[0])
    case 'wish-deleted':
      return replayView(req, 'detail', row.ref_id)
    default:
      throw new Error(`unknown view ${route.view}`)
  }
}

const ABORT = Symbol('rollback')

export function offlineOps(req, res, next) {
  if (!req.user || (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE')) return next()
  const path = normPath(req)
  let route = null
  let params = []
  for (const r of ROUTES) {
    if (r.method !== req.method) continue
    const m = r.re.exec(path)
    if (m) {
      route = r
      params = m.slice(1).map((p) => {
        try {
          return decodeURIComponent(p)
        } catch {
          return p
        }
      })
      break
    }
  }
  if (!route) return next()

  const rawOp = req.get('X-Op-Id')
  if (rawOp !== undefined && !UUID_RE.test(rawOp)) return next(new HttpError(400, 'Invalid operation id', 'op_id_invalid'))
  const opId = rawOp?.toLowerCase() ?? null
  const userId = req.user.id

  if (opId) {
    const known = db.prepare('SELECT method, path, created_id, ref_id FROM client_ops WHERE user_id=? AND op_id=?').get(userId, opId)
    if (known) {
      if (known.method !== req.method || known.path !== path) return next(new HttpError(422, 'This operation id was used for another request', 'op_id_reused'))
      req._audited = true // a repeat is not logged a second time
      try {
        const body = repeatBody(req, known, route, params)
        if (route.creates && known.created_id != null) res.setHeader('X-Created-Id', String(known.created_id))
        return res.json(body)
      } catch (e) {
        return next(e)
      }
    }
  }

  const sink = { created: null, ref: null }
  const realSend = res.send
  const sendWithHeader = (body) => {
    if (route.creates && sink.created != null && res.statusCode < 400 && !res.headersSent) res.setHeader('X-Created-Id', String(sink.created))
    return realSend.call(res, body)
  }

  if (!opId) {
    res.send = sendWithHeader
    return withSink(sink, next)
  }

  // With an op id the response is held until the write and the op record are committed together (or both rolled back)
  let held = null
  res.send = (body) => {
    held = { body }
    return res
  }
  let failure = null
  try {
    tx(() => {
      withSink(sink, next)
      if (!held) throw ABORT // the handler did not answer synchronously: nothing to record
      if (res.statusCode >= 400) throw ABORT // a failed write leaves nothing behind and is not recorded
      db.prepare('INSERT INTO client_ops (user_id, op_id, method, path, created_id, ref_id) VALUES (?,?,?,?,?,?)').run(
        userId, opId, req.method, path, route.creates ? sink.created : null, sink.ref,
      )
    })
  } catch (e) {
    if (e !== ABORT) failure = e
  }
  res.send = sendWithHeader
  if (failure) {
    held = null
    return next(failure)
  }
  if (held) sendWithHeader(held.body)
}
