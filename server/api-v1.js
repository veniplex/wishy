// Public API v1 (Authorization: Bearer <key> or X-API-Key). No cookies, no CSRF protection needed.
// Business rules (surprise protection, space checks, AI limits, link import) come from the existing modules.
import express from 'express'
import { db } from './db.js'
import { baseUrl } from './config.js'
import { audit, auditMiddleware } from './audit.js'
import { lookupKey, touchKey } from './apikeys.js'
import { effectiveFeatures } from './features.js'
import { memberSpaces, spaceCtx } from './spaces.js'
import { getState, createIdea } from './planning.js'
import { createWishlist, addWish, wishData, wishesView, viaFor, counts, loadList, plainWish } from './wishlists.js'
import { preview } from './preview.js'
import { HttpError, sha256, ipKey } from './util.js'
import { defaultName, userLocale } from './locale.js'
import { typeDisplayName } from './occasion-types.js'
import { getAiConfig, isUsable } from './ai/settings.js'
import { fetchPage, extractLink, extractText } from './ai/features.js'
import { gate, tracked } from './ai/guard.js'
import { openapiDocument } from './api-v1-openapi.js'

const err = (status, message, code) => new HttpError(status, message, code)
const all = (sql, ...p) => db.prepare(sql).all(...p)
const get = (sql, ...p) => db.prepare(sql).get(...p)

// ---------- Ratenbegrenzung ----------
export const RATE_LIMIT = 60 // requests per minute and key
const windows = new Map()
function rateLimit(keyId, res) {
  const now = Date.now()
  let w = windows.get(keyId)
  if (!w || now - w.start >= 60_000) {
    w = { start: now, n: 0 }
    windows.set(keyId, w)
  }
  w.n++
  const reset = Math.ceil((w.start + 60_000 - now) / 1000)
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT))
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT - w.n)))
  res.setHeader('X-RateLimit-Reset', String(reset))
  if (w.n > RATE_LIMIT) {
    res.setHeader('Retry-After', String(reset))
    throw err(429, 'Too many requests - please wait a moment', 'rate_limited')
  }
}
// Failed attempts per IP (against key guessing): 30 FAILED key checks per minute and IP (IPv6 /64) -> 429.
// Only failures of the key check are counted (unknown/revoked/expired), not missing headers and not
// successful requests. A valid key always works - even from an IP that is currently throttled (the key
// is 40 random characters, guessing is hopeless; so nobody can lock out legitimate clients with failed attempts from the same IP).
const badAuth = new Map()
const BAD_AUTH_MAX = 30
function badAuthLimited(ip) {
  const e = badAuth.get(ip)
  return !!e && Date.now() - e.start < 60_000 && e.n >= BAD_AUTH_MAX
}
function badAuthRecord(ip, req, code, key) {
  const now = Date.now()
  const e = badAuth.get(ip)
  if (!e || now - e.start >= 60_000) {
    badAuth.set(ip, { start: now, n: 1, logged: false })
    if (badAuth.size > 5000) for (const [k, v] of badAuth) if (now - v.start >= 60_000) badAuth.delete(k)
  } else e.n++
  const cur = badAuth.get(ip)
  if (!cur.logged) {
    cur.logged = true // at most one audit entry per IP and minute
    audit({ via: 'anonymous', ip: req.ip, userAgent: req.headers['user-agent'] }, 'api.auth.fail', {
      status: 'fail',
      details: { reason: code, ...(key ? { prefix: key.prefix } : {}) },
    })
  }
}

function tokenOf(req) {
  const h = req.headers.authorization
  if (typeof h === 'string') {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h)
    if (m) return m[1]
  }
  const x = req.headers['x-api-key']
  return typeof x === 'string' && x.trim() ? x.trim() : null
}

function authenticate(req, res, next) {
  try {
    const ip = ipKey(req.ip)
    const token = tokenOf(req)
    if (!token) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="wishy"')
      throw err(401, 'API key missing (Authorization: Bearer …)', 'api_key_required')
    }
    let found
    try {
      found = lookupKey(token)
    } catch (e) {
      if (e instanceof HttpError) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="wishy"')
        const k = e.code === 'invalid_api_key' ? null : get('SELECT prefix FROM api_keys WHERE key_hash=?', hashOf(token))
        const limited = badAuthLimited(ip)
        badAuthRecord(ip, req, e.code, k)
        if (limited) throw err(429, 'Too many failed sign-ins', 'rate_limited')
      }
      throw e
    }
    const { key, user } = found
    if (!effectiveFeatures(user).api) throw err(403, 'The API is not enabled for your account', 'api_disabled')
    rateLimit(key.id, res)
    let scopes = []
    try {
      scopes = JSON.parse(key.scopes)
    } catch {
      /* ignore */
    }
    const need = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write'
    if (!scopes.includes(need)) throw new HttpError(403, `The key lacks the "${need}" permission`, 'insufficient_scope', { scope: need })
    const first = touchKey(key, req.ip)
    req.user = user
    req.apiKey = { ...key, scopes }
    if (first) audit({ userId: user.id, via: 'api_key', ip: req.ip, userAgent: req.headers['user-agent'] }, 'api_key.use', { target: { type: 'api_key', id: key.id, label: key.name }, details: { prefix: key.prefix } })
    next()
  } catch (e) {
    next(e)
  }
}
const hashOf = (t) => sha256(t)

// ---------- Hilfen ----------
const clip = (v, n) => {
  const s = String(v ?? '').trim()
  return s ? s.slice(0, n) : null
}
const isId = (v) => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v.trim()))

/** Space from request parameter (id or name), otherwise the key's default space, otherwise the personal space. */
function resolveSpace(req, requested) {
  const spaces = memberSpaces(req.user.id)
  let s
  const restricted = req.apiKey.space_id
  if (restricted && requested !== undefined && requested !== null && requested !== '') {
    // Key with a fixed space: only that space (id or name), anything else -> 403 (without revealing whether it exists)
    const own = spaces.find((x) => x.id === restricted)
    const same = own && (isId(requested) ? own.id === Number(requested) : own.name.toLowerCase() === String(requested).trim().toLowerCase())
    if (!same) throw err(403, 'This key is restricted to a different space', 'api_key_space_restricted')
  }
  if (requested !== undefined && requested !== null && requested !== '') {
    s = isId(requested) ? spaces.find((x) => x.id === Number(requested)) : spaces.find((x) => x.name.toLowerCase() === String(requested).trim().toLowerCase())
    if (!s) throw err(404, 'Space not found', 'space_not_found')
  } else if (req.apiKey.space_id) {
    s = spaces.find((x) => x.id === req.apiKey.space_id)
    if (!s) throw err(403, "This key's default space is no longer accessible", 'space_forbidden')
  } else {
    s = spaces.find((x) => x.personal) ?? spaces[0]
    if (!s) throw err(404, 'No space found', 'space_not_found')
  }
  req.auditSpaceId = s.id
  return s
}
/** Planning context as in the UI (including surprise protection) for the space. */
const ctxFor = (req, space) => spaceCtx({ user: req.user, get: () => String(space.id) })

function findPerson(state, ref) {
  if (ref === undefined || ref === null || ref === '') return null
  const list = state.persons
  if (isId(ref)) return list.find((p) => p.id === Number(ref)) ?? null
  const q = String(ref).trim().toLowerCase()
  if (!q) return null
  const exact = list.filter((p) => p.name.toLowerCase() === q)
  if (exact.length) return exact.find((p) => !p.archived) ?? exact[0]
  for (const test of [(n) => n.startsWith(q), (n) => n.includes(q)]) {
    const m = list.filter((p) => test(p.name.toLowerCase()))
    if (m.length === 1) return m[0]
  }
  return null
}

const ideaView = (i, personsById) => ({
  id: i.id,
  title: i.title,
  notes: i.notes,
  url: i.url,
  price: i.price,
  currency: i.currency,
  image_url: i.image_url,
  priority: i.priority,
  status: i.status,
  mentioned: !!i.mentioned,
  person_id: i.person_id,
  person: i.person_id ? (personsById.get(i.person_id)?.name ?? null) : null,
  occasion_id: i.occasion_id,
  inbox: i.person_id === null,
  created_at: i.created_at,
})
const personsMap = (state) => new Map(state.persons.map((p) => [p.id, p]))

function listFor(req, id) {
  const list = loadList(id)
  if (!list || !viaFor(list, req.user.id)) throw err(404, 'Wishlist not found', 'wishlist_not_found')
  return list
}
function resolveOwnList(userId, ref) {
  const own = all('SELECT * FROM wishlists WHERE owner_user_id=? AND archived=0 ORDER BY sort, id', userId)
  if (ref !== undefined && ref !== null && ref !== '') {
    const l = isId(ref) ? own.find((x) => x.id === Number(ref)) : own.find((x) => x.title.toLowerCase() === String(ref).trim().toLowerCase())
    if (!l) throw err(404, 'Wishlist not found', 'wishlist_not_found')
    return l
  }
  if (own[0]) return own[0]
  return loadList(createWishlist(userId, { title: defaultName(userLocale(userId), 'wishlist') }))
}

// ---------- Capture ----------
const MAX_TEXT = 20_000
const URL_ONLY = /^https?:\/\/\S+$/i
const FIRST_URL = /https?:\/\/[^\s<>"')\]]+/i

function plainItem(text, extraUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const first = lines.find(Boolean) ?? text
  const rest = lines.slice(lines.indexOf(first) + 1).join('\n').trim()
  return {
    title: clip(first, 200),
    notes: clip(rest || (first.length > 200 ? text : ''), 4000),
    url: extraUrl ?? clip(FIRST_URL.exec(text)?.[0], 2000),
  }
}
function hostTitle(url) {
  try {
    const u = new URL(url)
    return (u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '')).slice(0, 200)
  } catch {
    return String(url).slice(0, 200)
  }
}

async function capture(req) {
  const raw = typeof req.body === 'string' ? { text: req.body } : req.body && typeof req.body === 'object' ? req.body : {}
  let text = typeof raw.text === 'string' ? raw.text.trim() : raw.text != null ? String(raw.text).trim() : ''
  let url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (text.length > MAX_TEXT) throw new HttpError(400, `The text is too long (at most ${MAX_TEXT} characters)`, 'text_too_long', { max: MAX_TEXT })
  if (url.length > 2000) throw err(400, 'The link is too long', 'url_too_long')
  if (!url && URL_ONLY.test(text)) {
    url = text
    text = ''
  }
  if (url && !/^https?:\/\//i.test(url)) throw err(400, 'The link must start with http:// or https://', 'invalid_url')
  if (!url && !text) throw err(400, 'Please provide "text" or "url"', 'text_or_url_required')
  const kind = raw.kind === undefined || raw.kind === null || raw.kind === '' ? 'idea' : raw.kind
  if (!['idea', 'wish'].includes(kind)) throw err(400, 'Invalid kind (idea or wish)', 'invalid_kind')

  // AI: automatic when unspecified if allowed for the user; explicit true without permission -> 403
  const aiAllowed = isUsable(getAiConfig()) && effectiveFeatures(req.user).ai
  if (raw.use_ai === true && !aiAllowed) gate('text_import', req.user)
  const useAi = raw.use_ai === false ? false : aiAllowed
  const warnings = []
  const actor = { userId: req.user.id, via: 'api' }

  // Ziel
  const wish = kind === 'wish'
  if (wish) accountWide(req)
  const space = wish ? null : resolveSpace(req, raw.space)
  const ctx = wish ? null : ctxFor(req, space)
  const state = wish ? null : getState(ctx)
  const list = wish ? resolveOwnList(req.user.id, raw.wishlist) : null
  let explicit = null
  if (!wish && raw.person !== undefined && raw.person !== null && raw.person !== '') {
    explicit = findPerson(state, raw.person)
    if (explicit && ctx.hidden.has(explicit.id)) throw err(400, 'There are no ideas for yourself', 'self_idea')
  }
  const unmatched = !wish && raw.person && !explicit ? String(raw.person).slice(0, 80) : null

  // Determine entries
  let items = [] // { title, notes, url, price, currency, image_url, person_name?, mentioned? }
  let aiUsed = false
  if (url) {
    let done = false
    if (useAi) {
      try {
        const cfg = gate('link_import', req.user)
        const src = await fetchPage(url)
        const r = await tracked(actor, 'link_import', cfg, (meter) => extractLink(src, meter, userLocale(req.user.id)))
        items = [{ title: r.title || hostTitle(r.url), notes: r.description, url: r.url, price: r.price, currency: r.currency, image_url: r.image_url }]
        aiUsed = done = true
      } catch (e) {
        warnings.push(e?.code || 'ai_failed')
      }
    }
    if (!done) {
      try {
        const r = await preview(url)
        items = [{ title: r.title || hostTitle(r.url || url), notes: null, url: r.url || url, price: r.price ?? null, currency: r.currency ?? null, image_url: r.image_url ?? null }]
      } catch {
        warnings.push('link_import_failed')
        items = [{ title: hostTitle(url), notes: text || null, url }]
      }
    }
  } else {
    let done = false
    if (useAi) {
      try {
        const cfg = gate('text_import', req.user)
        const r = await tracked(actor, 'text_import', cfg, (meter) => extractText(text, wish ? 'wishes' : 'ideas', meter, userLocale(req.user.id)))
        if (r.items.length) {
          items = r.items
          aiUsed = done = true
        } else warnings.push('ai_no_items')
      } catch (e) {
        warnings.push(e?.code || 'ai_failed')
      }
    }
    if (!done) items = [plainItem(text, null)]
  }

  // Anlegen
  const created = []
  let inbox = 0
  for (const it of items.slice(0, 20)) {
    const title = clip(it.title, 300)
    if (!title) continue
    if (wish) {
      const id = addWish(list.id, {
        title: title.slice(0, 300), notes: it.notes ?? null, url: it.url ?? null, price: it.price ?? null,
        currency: it.currency ?? null, image_url: it.image_url ?? null,
      })
      created.push({ type: 'wish', id, title, person: null, person_id: null, url: it.url ?? null, wishlist: list.title, wishlist_id: list.id, inbox: false })
      continue
    }
    let person = explicit
    if (!person && it.person_name) {
      const p = findPerson(state, it.person_name)
      if (p && !ctx.hidden.has(p.id)) person = p
    }
    const id = createIdea(ctx, {
      title, notes: it.notes ?? null, url: it.url ?? null, price: it.price ?? null, currency: it.currency ?? null,
      image_url: it.image_url ?? null, mentioned: it.mentioned ? 1 : 0, source: 'capture', person_id: person?.id ?? null,
    })
    if (!person) inbox++
    created.push({ type: 'idea', id, title, person: person?.name ?? null, person_id: person?.id ?? null, url: it.url ?? null, inbox: !person, space_id: space.id })
  }
  return { created, inbox, ai_used: aiUsed, ...(unmatched ? { unmatched_person: unmatched } : {}), ...(warnings.length ? { warnings } : {}) }
}

/** Wishlists belong to the account, not to a space: keys with a fixed space may not read or change them. */
const accountWide = (req) => {
  if (req.apiKey.space_id) throw err(403, 'This key is restricted to a space and may not use wishlists', 'api_key_space_restricted')
}

// ---------- Router ----------
export const apiV1Router = express.Router()
const r = apiV1Router
r.get('/openapi.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.json(openapiDocument(baseUrl(req), RATE_LIMIT))
})

r.use(authenticate)
// Read only AFTER the key check: unauthenticated requests cost no parser effort. At most 256 KB (capture text: 20,000 characters).
r.use(express.json({ limit: '256kb', strict: false }))
r.use(express.text({ type: 'text/*', limit: '256kb' }))
r.use(express.urlencoded({ extended: false, limit: '256kb' }))
r.use(auditMiddleware)

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res)
  } catch (e) {
    next(e)
  }
}

r.get('/me', wrap((req, res) => {
  const k = req.apiKey
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
    spaces: memberSpaces(req.user.id).filter((s) => !k.space_id || s.id === k.space_id),
    default_space_id: k.space_id ?? memberSpaces(req.user.id).find((s) => s.personal)?.id ?? null,
    features: effectiveFeatures(req.user),
    key: { id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, space_id: k.space_id, expires_at: k.expires_at },
  })
}))

r.post('/capture', wrap(async (req, res) => {
  const out = await capture(req)
  res.status(201).json(out)
}))

r.get('/persons', wrap((req, res) => {
  const s = resolveSpace(req, req.query.space)
  const st = getState(ctxFor(req, s))
  res.json(st.persons.map((p) => ({ id: p.id, name: p.name, birthday: p.birthday, relationship: p.relationship, relationship_group: p.relationship_group, archived: !!p.archived, is_me: !!p.is_me })))
}))

r.get('/ideas', wrap((req, res) => {
  const s = resolveSpace(req, req.query.space)
  const st = getState(ctxFor(req, s))
  const pm = personsMap(st)
  let rows = [...st.items, ...st.inbox_items]
  const q = req.query.person
  if (typeof q === 'string' && q) {
    if (q === 'inbox') rows = st.inbox_items
    else {
      const p = findPerson(st, q)
      if (!p) throw err(404, 'Person not found', 'person_not_found')
      rows = st.items.filter((i) => i.person_id === p.id)
    }
  }
  res.json(rows.map((i) => ideaView(i, pm)))
}))

r.post('/ideas', wrap((req, res) => {
  const b = typeof req.body === 'object' && req.body ? req.body : {}
  const s = resolveSpace(req, b.space)
  const ctx = ctxFor(req, s)
  const st = getState(ctx)
  let personId = null
  if (b.person !== undefined && b.person !== null && b.person !== '') {
    const p = findPerson(st, b.person)
    if (!p) throw err(404, 'Person not found', 'person_not_found')
    personId = p.id
  }
  const price = b.price === undefined || b.price === null || b.price === '' ? null : Number(b.price)
  if (price !== null && (!Number.isFinite(price) || price < 0)) throw err(400, 'Invalid price', 'invalid_price')
  const id = createIdea(ctx, {
    title: clip(b.title, 300) ?? '', notes: clip(b.notes, 4000), url: clip(b.url, 2000), price, currency: clip(b.currency, 8),
    occasion_id: b.occasion_id ?? undefined, mentioned: b.mentioned ? 1 : 0, source: 'api', person_id: personId,
  })
  const st2 = getState(ctx)
  const i = [...st2.items, ...st2.inbox_items].find((x) => x.id === id)
  res.status(201).json(ideaView(i, personsMap(st2)))
}))

r.get('/wishlists', wrap((req, res) => {
  accountWide(req)
  const uid = req.user.id
  const mine = all('SELECT * FROM wishlists WHERE owner_user_id=? ORDER BY archived, sort, id', uid).map((l) => ({
    id: l.id, title: l.title, description: l.description, event_date: l.event_date, archived: !!l.archived, owned: true, owner: null, ...counts(l.id),
  }))
  const shared = all(
    `SELECT w.*, o.name AS owner_name FROM wishlist_access a JOIN wishlists w ON w.id=a.wishlist_id JOIN users o ON o.id=w.owner_user_id AND o.disabled=0
     WHERE a.user_id=? AND w.archived=0 ORDER BY o.name COLLATE NOCASE, w.sort, w.id`,
    uid,
  )
    .filter((l) => viaFor(l, uid))
    .map((l) => ({ id: l.id, title: l.title, description: l.description, event_date: l.event_date, archived: false, owned: false, owner: l.owner_name, ...counts(l.id) }))
  res.json([...mine, ...shared])
}))

r.get('/wishlists/:id', wrap((req, res) => {
  accountWide(req)
  const list = listFor(req, Number(req.params.id) || -1)
  const owned = list.owner_user_id === req.user.id
  const owner = get('SELECT name FROM users WHERE id=?', list.owner_user_id)
  res.json({
    id: list.id, title: list.title, description: list.description, event_date: list.event_date, owned, owner: owned ? null : owner?.name ?? null,
    // Reservations are only visible to non-owners (as in the UI)
    wishes: wishesView(list, { userId: req.user.id }),
  })
}))

r.post('/wishlists/:id/wishes', wrap((req, res) => {
  accountWide(req)
  const list = loadList(Number(req.params.id) || -1)
  if (!list || list.owner_user_id !== req.user.id) throw err(404, 'Wishlist not found', 'wishlist_not_found')
  let data
  try {
    data = wishData(typeof req.body === 'object' && req.body ? req.body : {}, false)
  } catch (e) {
    throw err(400, e.message, 'invalid_wish')
  }
  const id = addWish(list.id, data)
  res.status(201).json(plainWish(get('SELECT * FROM wishes WHERE id=?', id)))
}))

r.get('/occasions', wrap((req, res) => {
  const s = resolveSpace(req, req.query.space)
  const st = getState(ctxFor(req, s))
  const up = req.query.upcoming === '1' || req.query.upcoming === 'true'
  const locale = userLocale(req.user.id)
  const types = new Map(st.occasion_types.map((t) => [t.key, t]))
  res.json(
    st.occasions
      .filter((o) => !up || o.date >= st.today)
      .map((o) => ({
        id: o.id, name: o.name, type: o.type, type_name: types.has(o.type) ? typeDisplayName(types.get(o.type), locale) : o.type,
        date: o.date, recurring: !!o.recurring, audience: o.audience, person_ids: o.person_ids, excluded_ids: o.excluded_ids, budget: o.budget,
      })),
  )
}))

const GIFT_STATUS = ['planned', 'ordered', 'shipped', 'delivered', 'wrapped', 'given', 'returned']
r.get('/gifts', wrap((req, res) => {
  const s = resolveSpace(req, req.query.space)
  const st = getState(ctxFor(req, s))
  const status = req.query.status
  if (status !== undefined && !GIFT_STATUS.includes(String(status))) throw err(400, 'Invalid status', 'invalid_status')
  res.json(
    st.gifts
      .filter((g) => !status || g.status === status)
      .map((g) => ({
        id: g.id, title: g.title, status: g.status, price: g.price, url: g.url, shop: g.shop, occasion_id: g.occasion_id, date: g.date,
        recipient_ids: g.recipient_ids, payment_status: g.payment_status, tracking_url: g.tracking_url, expected_at: g.expected_at,
      })),
  )
}))

// Errors in JSON format with code
r.use((req, res) => res.status(404).json({ error: 'Nicht gefunden', code: 'not_found' }))
r.use((e, req, res, next) => {
  if (res.headersSent) return next(e)
  if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code || 'error', ...(e.params ? { params: e.params } : {}) })
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON', code: 'invalid_json' })
  if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large', code: 'payload_too_large' })
  console.error('[api-v1]', e)
  res.status(500).json({ error: 'Internal error', code: 'internal_error' })
})
