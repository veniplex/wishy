// Guests (no account) on shared lists: every browser is a guest identified by a key it generates (stored only as a hash, created on
// demand: with the first claim or when the personal link is saved, never by a visit), claims belong to that guest, rename / merge /
// regenerate / takeover into an account, 1.0/1.1 claims keep working by name, the owner never sees anything (not even with a guest's key),
// the per-list setting, rate limit and caps, the audit entries (guest id and code, never a key), the public page behind a fake sign-in
// proxy that lets through only BYPASS_PATHS (every request of the guest flow must pass), and the additive schema 4 migration from a
// schema-3 database incl. a second start and a development database.
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TMP = path.join(os.tmpdir(), 'wl-guest-' + Date.now())
const DATA = path.join(TMP, 'data')
const SITE = path.join(TMP, 'site') // the server runs here: its own tiny `dist`, so the public page route exists without a build
const PORT = Number(process.env.SMOKE_PORT) || 3611
const PROXY_PORT = PORT + 1
const BASE = `http://127.0.0.1:${PORT}`
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(path.join(SITE, 'dist', 'assets'), { recursive: true })
fs.mkdirSync(path.join(SITE, 'dist', 'icons'), { recursive: true })
fs.writeFileSync(path.join(SITE, 'dist', 'index.html'), '<!doctype html><html><head><title>Wishy</title><script src="/assets/theme-init.js"></script></head><body><div id="root"></div></body></html>')
fs.writeFileSync(path.join(SITE, 'dist', 'assets', 'theme-init.js'), '/* theme */')
fs.writeFileSync(path.join(SITE, 'dist', 'sw.js'), '/* sw */')
fs.writeFileSync(path.join(SITE, 'dist', 'icons', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')

let server
const start = () => new Promise((resolve, reject) => {
  server = spawn('node', [path.join(ROOT, 'server/index.js')], { cwd: SITE, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), PREVIEW_BROWSER: 'off', TRUST_PROXY: '1' } })
  let out = ''
  server.stdout.on('data', (d) => { out += d; if (out.includes('is running')) resolve() })
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))
  server.on('exit', (c) => reject(new Error('server exit ' + c)))
})
const stop = () => new Promise((r) => { server.removeAllListeners('exit'); server.on('exit', r); server.kill() })

/** `ip` goes out as X-Forwarded-For (the server trusts one proxy hop), so every group of tests has its own address and rate limit */
class Client {
  constructor(base = BASE, ip = '198.51.100.1') { this.base = base; this.ip = ip; this.cookies = {}; this.headers = {} }
  async raw(method, url, body, headers = {}) {
    const h = { 'X-Requested-With': 'x', 'X-Forwarded-For': this.ip, 'User-Agent': 'GuestTest/1.0', ...this.headers, ...headers }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    if (ck) h.Cookie = ck
    const res = await fetch(this.base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' }).catch((e) => { throw new Error(`${method} ${this.base}${url}: ${e.cause || e}`) })
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      if (/Max-Age=0/i.test(c)) delete this.cookies[kv.slice(0, i)]; else this.cookies[kv.slice(0, i)] = kv.slice(i + 1)
    }
    return res
  }
  async req(method, url, body, headers) {
    const res = await this.raw(method, url, body, headers)
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch {}
    return { status: res.status, data, text, headers: res.headers }
  }
  get(u, h) { return this.req('GET', u, undefined, h) }
  post(u, b = {}, h) { return this.req('POST', u, b, h) }
  put(u, b = {}, h) { return this.req('PUT', u, b, h) }
  del(u, b, h) { return this.req('DELETE', u, b, h) }
}

let pass = 0, failN = 0
const results = []
const t = (name, cond, extra) => {
  if (cond) pass++
  else { failN++; results.push('FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 400) : '')) }
}
const rawDb = () => new DatabaseSync(path.join(DATA, 'wishlist.db'), { timeout: 5000 }) // the server writes at the same time
const resvRows = () => { const d = rawDb(); try { return d.prepare('SELECT * FROM reservations ORDER BY id').all() } finally { d.close() } }
const auditRows = (action) => { const d = rawDb(); try { return d.prepare('SELECT * FROM audit_log WHERE action=? ORDER BY id').all(action) } finally { d.close() } }
const KEY = (h) => ({ 'X-Guest-Key': h })
const gk = () => randomBytes(16).toString('base64url') // what a browser generates: 128 bit, 22 characters
const ALL_KEYS = [] // every key this test ever sends: none of them may show up anywhere on the server side
const newKey = () => { const k = gk(); ALL_KEYS.push(k); return k }
const wishOf = (view, id) => view.wishes.find((w) => w.id === id)
const guestRows = () => { const d = rawDb(); try { return d.prepare('SELECT * FROM wishlist_guests ORDER BY id').all() } finally { d.close() } }
const dbText = () => ['wishlist.db', 'wishlist.db-wal'].map((f) => { try { return fs.readFileSync(path.join(DATA, f)).toString('latin1') } catch { return '' } }).join('\n')
const CODE_RE = /^G-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/
const sha = (k) => createHash('sha256').update(k).digest('hex')
/** Fields that must never reach anyone but an admin */
const LEAKS = /"ip"|user_agent|key_hash|198\.51\.100\.|GuestTest/

async function apiTests() {
  const O = new Client(BASE, '198.51.100.2') // owner (first user = admin)
  let r = await O.post('/api/auth/setup', { name: 'Olivia', email: 'olivia@example.com', password: 'secret123' })
  t('setup owner', r.status === 200, r)
  r = await O.post('/api/admin/invites', {})
  const inv = r.data.url.split('=')[1]
  const AL = new Client(BASE, '198.51.100.3') // signed-in user
  r = await AL.post('/api/auth/register', { name: 'Alice', email: 'alice@example.com', password: 'secret456', invite: inv })
  t('register Alice', r.status === 200, r)

  r = await O.post('/api/wishlists', { title: 'Birthday' })
  const L = r.data
  t('list view has guest_claims (default on)', L.guest_claims === true, L)
  await O.post(`/api/wishlists/${L.id}/share`, { link_enabled: true })
  const ids = []
  for (const title of ['Book', 'Headphones', 'Scarf', 'Tea']) ids.push((await O.post(`/api/wishlists/${L.id}/wishes`, { title })).data.wishes.at(-1).id)
  const [w1, w2, w3, w4] = ids
  const TOK = L.token
  const shared = (id, token = TOK) => `/api/shared/${token}/wishes/${id}/reserve`

  // ---- public answer
  const G = new Client(BASE, '198.51.100.10')
  r = await G.get(`/api/shared/${TOK}`)
  t('public view: app name + default locale + guest_claims, no-store', r.status === 200 && r.data.app?.name && typeof r.data.app.default_locale === 'string' && r.data.guest_claims === true && /no-store/.test(r.headers.get('cache-control') || ''), r.data)
  t('public view works without any session and sets no cookie', r.data.logged_in === false && Object.keys(G.cookies).length === 0)
  const keyA = newKey()
  t('a plain visit (with or without a key) creates no guest and answers guest:null', r.data.guest === null && (await G.get(`/api/shared/${TOK}`, KEY(keyA))).data.guest === null && guestRows().length === 0)

  // ---- guest claim with a key: the guest is created with the first claim
  r = await G.post(shared(w1), { guest_name: '  Gast   Gerd ' }, KEY(keyA))
  t('guest claims: name tidied, claim shown as mine, guest with code', r.status === 200 && wishOf(r.data, w1).reserved_by === 'Gast Gerd' && wishOf(r.data, w1).reserved_by_me === true && CODE_RE.test(r.data.guest?.code) && r.data.guest.name === 'Gast Gerd' && r.data.guest.claims === 1, r.data)
  const codeA = r.data.guest.code
  t('no cookie for guests, no secret handed out', Object.keys(G.cookies).length === 0 && !('guest_secret' in r.data))
  let row = resvRows().find((x) => x.wish_id === w1)
  let grow = guestRows()
  t('row: guest_id, ip + user agent stored; guest row: hash of the key only', grow.length === 1 && row.guest_id === grow[0].id && grow[0].key_hash === sha(keyA) && grow[0].code === codeA && grow[0].wishlist_id === L.id && grow[0].ip === '198.51.100.10' && grow[0].user_agent === 'GuestTest/1.0' && row.ip === '198.51.100.10' && row.user_id === null && row.guest_name === 'Gast Gerd', { row, grow })
  t('the key itself is stored nowhere (database + WAL)', !dbText().includes(keyA))
  r = await G.get(`/api/shared/${TOK}`, KEY(keyA))
  t('with the key: reserved_by_me, guest self-view, key is not echoed', wishOf(r.data, w1).reserved_by_me === true && r.data.guest?.code === codeA && r.data.guest.claims === 1 && !r.text.includes(keyA), r.data)
  r = await G.get(`/api/shared/${TOK}`)
  t('without the key: reserved, not mine, no guest', wishOf(r.data, w1).reserved === true && wishOf(r.data, w1).reserved_by_me === false && wishOf(r.data, w1).reserved_by === 'Gast Gerd' && r.data.guest === null)
  r = await G.get(`/api/shared/${TOK}`, { 'X-Guest-Name': encodeURIComponent('Gast Gerd') })
  t('same name without the key is not mine (claims of a guest)', wishOf(r.data, w1).reserved_by_me === false)
  r = await G.get(`/api/shared/${TOK}?guest_name=${encodeURIComponent('Gast Gerd')}`)
  t('same name in the query string (old clients) is not mine either', wishOf(r.data, w1).reserved_by_me === false)
  r = await G.get(`/api/shared/${TOK}`, KEY(newKey()))
  t('unknown (well-formed) key: not mine, guest null, nothing created', wishOf(r.data, w1).reserved_by_me === false && r.data.guest === null && guestRows().length === 1)
  for (const [label, bad] of [['too short', 'short'], ['no entropy', 'a'.repeat(30)], ['bad characters', 'x'.repeat(10) + '!'.repeat(20)], ['too long', gk() + 'A'.repeat(60)]]) {
    r = await G.get(`/api/shared/${TOK}`, KEY(bad))
    t(`malformed key (${label}) is ignored on a read`, r.status === 200 && wishOf(r.data, w1).reserved_by_me === false && r.data.guest === null)
    r = await G.post(shared(w3), { guest_name: 'Nope' }, KEY(bad))
    t(`malformed key (${label}) cannot claim: 400 guest_key_required`, r.status === 400 && r.data.code === 'guest_key_required', r.data)
  }
  r = await G.post(shared(w3), { guest_name: 'Nope' })
  t('no key at all cannot claim on the public route: 400 guest_key_required', r.status === 400 && r.data.code === 'guest_key_required' && !resvRows().some((x) => x.wish_id === w3) && guestRows().length === 1)

  // ---- someone with the same name or another key cannot release it
  const G2 = new Client(BASE, '198.51.100.11')
  r = await G2.del(shared(w1), { guest_name: 'Gast Gerd' }, { 'X-Guest-Name': encodeURIComponent('Gast Gerd') })
  t('same name cannot release a guest claim', r.status === 403 && r.data.code === 'reservation_not_yours', r)
  r = await G2.del(shared(w1), undefined, KEY(newKey()))
  t('wrong key cannot release', r.status === 403)
  r = await G2.del(shared(w1))
  t('no key cannot release', r.status === 403)
  r = await G2.del(`/api/wishes/${w1}/reserve`, { token: TOK, guest_name: 'Gast Gerd' })
  t('old route + name cannot release it either', r.status === 403)
  r = await G2.post(shared(w1), { guest_name: 'Other' }, KEY(newKey()))
  t('already reserved -> 409 wish_reserved', r.status === 409 && r.data.code === 'wish_reserved', r)
  t('claim still intact, no guest left behind by the failed claim', resvRows().some((x) => x.wish_id === w1) && guestRows().length === 1)

  // ---- second claim in the same browser reuses the guest; a second browser with the same key is the same guest
  r = await G.post(shared(w2), { guest_name: 'Ignored Name' }, KEY(keyA))
  t('second claim: same guest (code, name kept), both mine', r.status === 200 && r.data.guest.code === codeA && r.data.guest.name === 'Gast Gerd' && r.data.guest.claims === 2 && wishOf(r.data, w1).reserved_by_me && wishOf(r.data, w2).reserved_by_me && wishOf(r.data, w2).reserved_by === 'Gast Gerd', r.data)
  let rows = resvRows()
  t('both rows belong to one guest, one guest row', rows.find((x) => x.wish_id === w1).guest_id === rows.find((x) => x.wish_id === w2).guest_id && guestRows().length === 1)
  const G3 = new Client(BASE, '198.51.100.15') // "another device": other IP, same key
  r = await G3.get(`/api/shared/${TOK}`, KEY(keyA))
  t('another browser with the same key sees the same claims as its own', wishOf(r.data, w1).reserved_by_me && wishOf(r.data, w2).reserved_by_me && r.data.guest.code === codeA && r.data.guest.claims === 2, r.data)
  r = await G3.del(shared(w2), undefined, KEY(keyA))
  t('... and can release them', r.status === 200 && wishOf(r.data, w2).reserved === false && !resvRows().some((x) => x.wish_id === w2) && r.data.guest.claims === 1, r.data)

  // ---- name validation
  const V = new Client(BASE, '198.51.100.12')
  const vk = newKey()
  for (const [label, name, code] of [['empty', '', 'guest_name_required'], ['blank', '   ', 'guest_name_required'], ['missing', undefined, 'guest_name_required'], ['too long', 'x'.repeat(61), 'guest_name_invalid'], ['newline', 'Gast\nGerd', 'guest_name_invalid'], ['control char', 'Gast\u0007', 'guest_name_invalid'], ['direction override', 'Gast‮Gerd', 'guest_name_invalid'], ['zero width', 'Ga​st', 'guest_name_invalid']]) {
    r = await V.post(shared(w3), { guest_name: name }, KEY(vk))
    t(`name ${label} -> 400 ${code}`, r.status === 400 && r.data.code === code, r)
  }
  t('no claim and no guest from invalid names', !resvRows().some((x) => x.wish_id === w3) && guestRows().length === 1)
  r = await V.post(shared(w3), { guest_name: 'x'.repeat(60) }, KEY(vk))
  t('60 characters are fine', r.status === 200)
  await V.del(shared(w3), undefined, KEY(vk))
  const baseGuests = guestRows().length // keyA and V

  // ---- uniform 404 for wrong tokens
  const bad1 = await V.post(shared(w3, 'nope'), { guest_name: 'X' }, KEY(vk))
  const bad2 = await V.get('/api/shared/nope')
  const L2 = (await O.post('/api/wishlists', { title: 'Second' })).data // link never enabled
  const bad3 = await V.post(shared(w3, L2.token), { guest_name: 'X' }, KEY(vk))
  const bad4 = await V.del(shared(w3, 'nope'), undefined, KEY(keyA))
  const bad5 = await V.post('/api/shared/nope/guest', { guest_name: 'X' }, KEY(vk))
  const bad6 = await V.put('/api/shared/nope/guest', { guest_name: 'X' }, KEY(vk))
  t('wrong / unshared token: the same 404 everywhere (incl. the guest routes)', [bad1, bad2, bad3, bad4, bad5, bad6].every((x) => x.status === 404 && x.data.code === 'list_not_shared' && x.data.error === bad1.data.error), [bad1.data, bad2.data, bad3.data, bad4.data, bad5.data, bad6.data])
  await O.post(`/api/wishlists/${L2.id}/share`, { link_enabled: true })
  r = await V.post(shared(w3, L2.token), { guest_name: 'X' }, KEY(vk))
  t('right token, wish of another list -> 404', r.status === 404, r)
  await O.post(`/api/wishlists/${L2.id}/share`, { link_enabled: false })
  r = await V.post(`/api/wishes/${w3}/reserve`, { guest_name: 'X' })
  t('old route without token -> 404', r.status === 404)

  // ---- CSRF guard stays active (also for the guest routes)
  let res = await fetch(BASE + shared(w3), { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Forwarded-For': '198.51.100.13', ...KEY(vk) }, body: '{"guest_name":"X"}' })
  t('CSRF: text/plain POST rejected', res.status === 403)
  r = await V.post(shared(w3), { guest_name: 'X' }, { Origin: 'http://evil.example', ...KEY(vk) })
  t('CSRF: foreign Origin rejected', r.status === 403 && r.data.code === 'origin_mismatch', r)
  r = await V.post(`/api/shared/${TOK}/guest`, { guest_name: 'X' }, { Origin: 'http://evil.example', ...KEY(vk) })
  t('CSRF: foreign Origin rejected on POST /guest', r.status === 403 && r.data.code === 'origin_mismatch', r)
  res = await fetch(BASE + `/api/shared/${TOK}/guest`, { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'X-Forwarded-For': '198.51.100.13', ...KEY(keyA) }, body: '{"guest_name":"X"}' })
  t('CSRF: text/plain PUT /guest rejected', res.status === 403)
  t('CSRF: nothing was claimed or created', !resvRows().some((x) => x.wish_id === w3) && guestRows().length === baseGuests && guestRows().find((g) => g.code === codeA).name === 'Gast Gerd')

  // ---- legacy (1.0/1.1): old route, claims without a guest, identified by name
  const OLD = new Client(BASE, '198.51.100.14')
  r = await OLD.post(`/api/wishes/${w3}/reserve`, { token: TOK, guest_name: 'Old Olga' })
  t('old route: guest claim by name', r.status === 200 && wishOf(r.data, w3).reserved_by === 'Old Olga' && !('guest' in r.data && r.data.guest), r.data)
  row = resvRows().find((x) => x.wish_id === w3)
  t('old route: no guest created (guest_id null), ip kept', row.guest_id === null && row.ip === '198.51.100.14' && guestRows().length === baseGuests)
  r = await OLD.get(`/api/shared/${TOK}?guest_name=${encodeURIComponent('olga old')}`)
  t('legacy claim: not mine for another name', wishOf(r.data, w3).reserved_by_me === false)
  r = await OLD.get(`/api/shared/${TOK}?guest_name=${encodeURIComponent('old olga')}`)
  t('legacy claim: mine by name in the query (old clients)', wishOf(r.data, w3).reserved_by_me === true)
  r = await OLD.get(`/api/shared/${TOK}`, { 'X-Guest-Name': encodeURIComponent('OLD OLGA') })
  t('legacy claim: mine by name in a header (case-insensitive)', wishOf(r.data, w3).reserved_by_me === true)
  r = await OLD.del(shared(w3), undefined, { 'X-Guest-Name': encodeURIComponent('Somebody') })
  t('legacy claim: wrong name cannot release', r.status === 403)
  r = await OLD.del(shared(w3), undefined, { 'X-Guest-Name': encodeURIComponent('old olga') })
  t('legacy claim: release by name (new route)', r.status === 200 && wishOf(r.data, w3).reserved === false, r)
  r = await OLD.post(`/api/wishes/${w3}/reserve`, { token: TOK, guest_name: 'Old Olga' })
  r = await OLD.del(`/api/wishes/${w3}/reserve`, { token: TOK, guest_name: 'old olga' })
  t('legacy claim: release by name (old route)', r.status === 200 && wishOf(r.data, w3).reserved === false)
  // a row exactly like an older version wrote it
  { const d = rawDb(); d.prepare('INSERT INTO reservations (wish_id, user_id, guest_name) VALUES (?,NULL,?)').run(w4, 'Hand Made'); d.close() }
  r = await OLD.get(`/api/shared/${TOK}`, { 'X-Guest-Name': encodeURIComponent('hand made') })
  t('row without any new column value: mine by name', wishOf(r.data, w4).reserved_by_me === true)
  r = await OLD.del(shared(w4), undefined, { 'X-Guest-Name': encodeURIComponent('Hand Made') })
  t('row without any new column value: released by name', r.status === 200 && wishOf(r.data, w4).reserved === false)
  // a legacy name never reaches a claim of a guest, whatever header combination
  r = await OLD.del(shared(w1), undefined, { 'X-Guest-Name': encodeURIComponent('Gast Gerd'), ...KEY(newKey()) })
  t('a name together with a wrong key still cannot release a guest claim', r.status === 403)

  // ---- signed-in users keep working (new and old route), through the link and by access
  r = await AL.post(shared(w3), {})
  t('signed-in via the public page: claim as Alice, mine, no key needed, no guest field', r.status === 200 && wishOf(r.data, w3).reserved_by === 'Alice' && wishOf(r.data, w3).reserved_by_me === true && r.data.logged_in === true && !('guest' in r.data), r.data)
  row = resvRows().find((x) => x.wish_id === w3)
  t('user claim: user_id set, no guest, ip + agent stored', row.user_id && row.guest_id === null && row.ip === '198.51.100.3' && row.user_agent === 'GuestTest/1.0', row)
  r = await G.get(`/api/shared/${TOK}`, KEY(keyA))
  t('a guest sees Alice as the claimer, not as mine', wishOf(r.data, w3).reserved_by === 'Alice' && wishOf(r.data, w3).reserved_by_me === false)
  r = await G.del(shared(w3), undefined, KEY(keyA))
  t('guest cannot release a user claim', r.status === 403)
  r = await AL.del(shared(w3))
  t('Alice releases via the public page', r.status === 200 && wishOf(r.data, w3).reserved === false)
  r = await AL.post(`/api/wishes/${w3}/reserve`, { token: TOK })
  t('signed-in via old route + token body still works', r.status === 200 && wishOf(r.data, w3).reserved_by_me === true, r)
  r = await AL.del(`/api/wishes/${w3}/reserve`, { token: TOK })
  t('... and releases', r.status === 200 && wishOf(r.data, w3).reserved === false)
  await O.post(`/api/wishlists/${L.id}/access`, { email: 'alice@example.com' })
  r = await AL.post(`/api/wishes/${w3}/reserve`, {})
  t('by direct access (no token) still works', r.status === 200 && r.data.wishes.find((w) => w.id === w3).reserved_by_me === true, r)
  r = await AL.get(`/api/wishlists/${L.id}`)
  t('detail view of a user: mine, no ip/agent/hash', r.data.wishes.find((w) => w.id === w3).reserved_by_me === true && !LEAKS.test(r.text), r.text.slice(0, 300))
  await AL.del(`/api/wishes/${w3}/reserve`, {})
  r = await AL.get(`/api/shared/${TOK}`, KEY(keyA))
  t('a signed-in person is never a guest: a key is ignored (nothing of the guest shows as mine)', wishOf(r.data, w1).reserved_by_me === false && !('guest' in r.data))

  // ---- the owner never sees anything
  const keyH = newKey()
  const guestsBeforeH = guestRows().length
  await G.post(shared(w4), { guest_name: 'Hidden Gast' }, KEY(keyH))
  const codeH = guestRows().find((g) => g.name === 'Hidden Gast').code
  await AL.post(shared(w3), {})
  const ownerViews = {
    'GET /api/wishlists/:id': await O.get(`/api/wishlists/${L.id}`),
    'GET /api/wishlists': await O.get('/api/wishlists'),
    'GET /api/shared/:token (signed in as owner)': await O.get(`/api/shared/${TOK}`),
    'GET /api/shared/:token (owner + a guest key)': await O.get(`/api/shared/${TOK}`, { ...KEY(keyA), 'X-Guest-Name': encodeURIComponent('Hidden Gast') }),
    'GET /api/shared/:token (owner + the key of Hidden Gast)': await O.get(`/api/shared/${TOK}`, KEY(keyH)),
    'GET /api/wishlists/:id/export': await O.get(`/api/wishlists/${L.id}/export`),
    'GET /api/state': await O.get('/api/state'),
  }
  for (const [name, v] of Object.entries(ownerViews)) {
    t(`owner: ${name} shows no claim`, v.status === 200 && !/reserved|Hidden Gast|Gast Gerd|guest|claim|G-[A-Z0-9]{6}/i.test(v.text.replace(/"guest_claims":(true|false)/g, '').replace(/"alice@example.com"/g, '')) && !LEAKS.test(v.text), /reserved|Hidden Gast|Gast Gerd|guest|claim/i.exec(v.text.replace(/"guest_claims":(true|false)/g, ''))?.[0])
  }
  r = await O.post(shared(w1), {})
  t('owner cannot claim through the link', r.status === 403 && r.data.code === 'own_wish_reserve', r)
  r = await O.del(shared(w4), undefined, KEY(keyH))
  t('owner cannot release through the link either', r.status === 403)
  r = await O.post(`/api/wishes/${w1}/reserve`, { token: TOK, guest_name: 'Olivia' })
  t('owner cannot claim through the old route', r.status === 403)
  t('claims untouched by the owner', resvRows().filter((x) => x.wish_id === w4 || x.wish_id === w3).length === 2)
  // every guest endpoint answers a signed-in owner (and any signed-in person) the same way, whatever key is sent: nothing to learn from it
  const probe = async (client, who) => {
    const answers = []
    for (const k of [keyH, newKey(), null]) {
      const h = k ? KEY(k) : {}
      answers.push(
        await client.post(`/api/shared/${TOK}/guest`, { guest_name: 'Spy' }, h),
        await client.put(`/api/shared/${TOK}/guest`, { guest_name: 'Spy' }, h),
        await client.post(`/api/shared/${TOK}/guest/merge`, {}, { ...h, 'X-Guest-Merge-Key': keyA }),
      )
    }
    t(`${who}: POST/PUT /guest and merge answer 403 guest_not_available, identical for any key`, answers.every((a) => a.status === 403 && a.data.code === 'guest_not_available' && a.text === answers[0].text), answers.map((a) => a.text))
  }
  await probe(O, 'owner')
  await probe(AL, 'signed-in user')
  const ownerTake = [await O.get(`/api/shared/${TOK}/guest/takeover`, KEY(keyH)), await O.get(`/api/shared/${TOK}/guest/takeover`, KEY(newKey())), await O.get(`/api/shared/${TOK}/guest/takeover`), await O.post(`/api/shared/${TOK}/guest/takeover`, {}, KEY(keyH)), await O.post(`/api/shared/${TOK}/guest/takeover`, {}, KEY(newKey()))]
  t('owner: takeover (GET and POST) answers 403 guest_not_available for any key', ownerTake.every((a) => a.status === 403 && a.data.code === 'guest_not_available' && !/G-[A-Z0-9]{6}|Hidden/.test(a.text)), ownerTake.map((a) => a.text))
  r = await new Client(BASE, '198.51.100.16').get(`/api/shared/${TOK}/guest/takeover`, KEY(keyH))
  t('signed-out visitors cannot use the takeover route (401)', r.status === 401, r.status)
  t('the owner-admin still sees the guest only in admin views (code is not in any owner answer)', Object.values(ownerViews).every((v) => !v.text.includes(codeH)))

  // ---- no ip / agent / hash in anything non-admin
  const guestViews = [await G.get(`/api/shared/${TOK}`, KEY(keyA)), await AL.get('/api/wishlists'), await AL.get(`/api/shared/${TOK}`), await AL.get('/api/state'), await AL.get('/api/export')]
  t('ip, user agent and hash appear in no guest/user answer', guestViews.every((v) => v.status === 200 && !LEAKS.test(v.text)), guestViews.map((v) => LEAKS.exec(v.text)?.[0]))
  await G.del(shared(w4), undefined, KEY(keyH))
  await AL.del(shared(w3))

  // ---- per-list setting
  r = await O.post(`/api/wishlists/${L.id}/share`, { guest_claims: false })
  t('owner switches guest reservations off', r.status === 200 && r.data.guest_claims === false && r.data.link_enabled === true, r.data)
  r = await G.post(shared(w3), { guest_name: 'Gast Gerd' }, KEY(keyA))
  t('off: guest claim -> 403 guest_claims_disabled (new route)', r.status === 403 && r.data.code === 'guest_claims_disabled', r)
  r = await G.post(`/api/wishes/${w2}/reserve`, { token: TOK, guest_name: 'Gast Gerd' })
  t('off: ... and on the old route', r.status === 403 && r.data.code === 'guest_claims_disabled')
  const gOff = guestRows().length
  r = await G.post(`/api/shared/${TOK}/guest`, { guest_name: 'Brand New' }, KEY(newKey()))
  t('off: a NEW guest cannot be created by saving a personal link either', r.status === 403 && r.data.code === 'guest_claims_disabled' && guestRows().length === gOff, r)
  r = await G.post(`/api/shared/${TOK}/guest`, { guest_name: 'x' }, KEY(keyA))
  t('off: an existing guest can still open their personal link (idempotent)', r.status === 200 && r.data.guest.code === codeA, r)
  r = await G.get(`/api/shared/${TOK}`, KEY(keyA))
  t('off: the list is still visible, says so, and the guest still sees their claim', r.status === 200 && r.data.guest_claims === false && r.data.wishes.length === 4 && wishOf(r.data, w1).reserved_by_me === true && r.data.guest.claims === 1)
  r = await AL.post(shared(w2), {})
  t('off: signed-in users can still claim', r.status === 200 && wishOf(r.data, w2).reserved_by_me === true, r)
  r = await G.put(`/api/shared/${TOK}/guest`, { guest_name: 'Gerd Neu' }, KEY(keyA))
  t('off: an existing guest can still rename', r.status === 200 && r.data.guest.name === 'Gerd Neu')
  await G.put(`/api/shared/${TOK}/guest`, { guest_name: 'Gast Gerd' }, KEY(keyA))
  await AL.del(shared(w2))
  await O.post(`/api/wishlists/${L.id}/share`, { guest_claims: true })
  r = await AL.post(`/api/wishlists/${L.id}/share`, { guest_claims: false })
  t('only the owner can change the setting', r.status === 404)

  // ---- identity on demand: saving the personal link, name, rename, merge, regenerate, takeover
  const I = new Client(BASE, '198.51.100.50')
  const ik = newKey()
  const before = guestRows().length
  r = await I.post(`/api/shared/${TOK}/guest`, {}, KEY(ik))
  t('saving the link without a name -> 400 guest_name_required, nothing created', r.status === 400 && r.data.code === 'guest_name_required' && guestRows().length === before, r)
  r = await I.post(`/api/shared/${TOK}/guest`, { guest_name: 'Greta' })
  t('saving the link without a key -> 400 guest_key_required', r.status === 400 && r.data.code === 'guest_key_required')
  r = await I.post(`/api/shared/${TOK}/guest`, { guest_name: 'Greta' }, KEY(ik))
  const codeI = r.data.guest?.code
  t('saving the link creates the guest (code, name, 0 claims), key stored only as hash', r.status === 200 && CODE_RE.test(codeI) && r.data.guest.name === 'Greta' && r.data.guest.claims === 0 && guestRows().length === before + 1 && guestRows().at(-1).key_hash === sha(ik) && !dbText().includes(ik), r.data)
  r = await I.post(`/api/shared/${TOK}/guest`, { guest_name: 'Someone Else' }, KEY(ik))
  t('saving again is idempotent: same guest, same name', r.status === 200 && r.data.guest.code === codeI && r.data.guest.name === 'Greta' && guestRows().length === before + 1)
  const codes = new Set(guestRows().map((g) => g.code))
  t('codes are unique', codes.size === guestRows().length)
  r = await I.put(`/api/shared/${TOK}/guest`, { guest_name: 'Greta B' }, KEY(newKey()))
  t('rename with an unknown key -> 404 guest_not_found', r.status === 404 && r.data.code === 'guest_not_found')
  r = await I.put(`/api/shared/${TOK}/guest`, { guest_name: 'Bad\nName' }, KEY(ik))
  t('rename: invalid name -> 400', r.status === 400 && r.data.code === 'guest_name_invalid')
  r = await I.post(shared(w2), {}, KEY(ik))
  t('claim after saving the link: no name needed, claim under the guest name', r.status === 200 && wishOf(r.data, w2).reserved_by === 'Greta' && r.data.guest.claims === 1, r.data)
  r = await I.post(shared(w3), {}, KEY(ik))
  t('second claim of the same guest', r.status === 200 && r.data.guest.claims === 2)
  r = await I.put(`/api/shared/${TOK}/guest`, { guest_name: '  Greta   Berger ' }, KEY(ik))
  t('rename applies to all claims of the guest', r.status === 200 && r.data.guest.name === 'Greta Berger' && wishOf(r.data, w2).reserved_by === 'Greta Berger' && wishOf(r.data, w3).reserved_by === 'Greta Berger' && resvRows().filter((x) => x.guest_id === guestRows().find((g) => g.code === codeI).id).every((x) => x.guest_name === 'Greta Berger'), r.data)
  r = await G.get(`/api/shared/${TOK}`, KEY(keyA))
  t('rename is visible to other visitors', wishOf(r.data, w2).reserved_by === 'Greta Berger')
  // two guests with the same name are two guests (names do not identify)
  const N2 = new Client(BASE, '198.51.100.51')
  const nk = newKey()
  r = await N2.post(`/api/shared/${TOK}/guest`, { guest_name: 'Greta Berger' }, KEY(nk))
  const codeN = r.data.guest.code
  t('same name, other key: another guest', r.status === 200 && codeN !== codeI)
  r = await N2.del(shared(w2), undefined, KEY(nk))
  t('the namesake cannot release the claims of the other Greta', r.status === 403)

  // merge: two browsers that turn out to be one person
  const k1 = newKey(), k2 = newKey(), keyE = newKey()
  const mw = []
  for (const title of ['Merge 1', 'Merge 2', 'Merge 3']) mw.push((await O.post(`/api/wishlists/${L.id}/wishes`, { title })).data.wishes.at(-1).id)
  const [m1, m2, m3] = mw
  const M = new Client(BASE, '198.51.100.52')
  const MX = new Client(BASE, '198.51.100.53')
  const MA = await M.post(shared(m1), { guest_name: 'Max' }, KEY(k1))
  const MB = await M.post(`/api/wishes/${m3}/reserve`, { token: TOK, guest_name: 'Max' }) // a 1.1 claim by name: stays out of the merge
  r = await MX.post(shared(m2), { guest_name: 'Maxine' }, KEY(k2))
  t('setup for the merge: Max (1 claim + a legacy claim by name), Maxine (1 claim)', MA.status === 200 && MB.status === 200 && r.status === 200 && r.data.guest.name === 'Maxine' && r.data.guest.claims === 1, r.data)
  const LX = (await O.post('/api/wishlists', { title: 'Other list' })).data
  await O.post(`/api/wishlists/${LX.id}/share`, { link_enabled: true })
  r = await new Client(BASE, '198.51.100.54').post(`/api/shared/${LX.token}/guest`, { guest_name: 'Elsewhere' }, KEY(keyE))
  t('a guest of another list', r.status === 200)
  r = await new Client(BASE, '198.51.100.55').post(`/api/shared/${TOK}/guest`, { guest_name: 'Thief' }, KEY(keyE))
  t('the same key cannot become a second guest (409 guest_key_in_use), nothing created', r.status === 409 && r.data.code === 'guest_key_in_use' && !guestRows().some((g) => g.name === 'Thief'), r)
  r = await M.post(`/api/shared/${TOK}/guest/merge`, {}, { ...KEY(k1), 'X-Guest-Merge-Key': newKey() })
  t('merge with an unknown second key -> 404', r.status === 404 && r.data.code === 'guest_not_found')
  r = await M.post(`/api/shared/${TOK}/guest/merge`, {}, { ...KEY(k1) })
  t('merge without a second key -> 404', r.status === 404)
  r = await M.post(`/api/shared/${TOK}/guest/merge`, {}, { ...KEY(k1), 'X-Guest-Merge-Key': k1 })
  t('merge a guest with itself -> 400', r.status === 400 && r.data.code === 'guest_merge_same')
  r = await M.post(`/api/shared/${TOK}/guest/merge`, {}, { ...KEY(k1), 'X-Guest-Merge-Key': keyE })
  t('merge with the key of a guest of ANOTHER list: not found (key is per list), nothing moved', r.status === 404 && guestRows().some((g) => g.name === 'Elsewhere'))
  r = await M.post(`/api/shared/${TOK}/guest/merge`, {}, { ...KEY(newKey()), 'X-Guest-Merge-Key': k2 })
  t('merge into an unknown guest -> 404, Maxine untouched', r.status === 404 && (await MX.get(`/api/shared/${TOK}`, KEY(k2))).data.guest.claims === 1)
  r = await M.post(`/api/shared/${TOK}/guest/merge`, {}, { ...KEY(k1), 'X-Guest-Merge-Key': k2 })
  t('merge: both claims under the guest of the first key, with its name', r.status === 200 && r.data.guest.name === 'Max' && r.data.guest.claims === 2 && wishOf(r.data, m1).reserved_by_me && wishOf(r.data, m2).reserved_by_me && wishOf(r.data, m2).reserved_by === 'Max' && wishOf(r.data, m3).reserved_by_me === false, r.data)
  r = await MX.get(`/api/shared/${TOK}`, KEY(k2))
  t('the merged key is a plain unknown key now', r.data.guest === null && wishOf(r.data, m2).reserved_by_me === false)
  t('the merged guest row is gone, the other list is untouched', !guestRows().some((g) => g.name === 'Maxine') && guestRows().some((g) => g.name === 'Elsewhere'))
  await M.del(shared(m1), undefined, KEY(k1))
  await M.del(shared(m2), undefined, KEY(k1))
  await M.del(`/api/wishes/${m3}/reserve`, { token: TOK, guest_name: 'Max' })

  // regenerate: the old link dies, the key stays valid on the new link
  const rg = await O.post(`/api/wishlists/${L.id}/share`, { regenerate: true })
  const TOK2 = rg.data.token
  t('regenerate gives a new token', rg.status === 200 && TOK2 && TOK2 !== TOK, rg.data)
  r = await G.get(`/api/shared/${TOK}`, KEY(keyA))
  t('the old link (and with it the old personal link) is dead', r.status === 404 && r.data.code === 'list_not_shared')
  r = await G.get(`/api/shared/${TOK2}`, KEY(keyA))
  t('the same key on the new link: same guest, same claims', r.status === 200 && r.data.guest.code === codeA && wishOf(r.data, w1).reserved_by_me === true, r.data)
  r = await I.get(`/api/shared/${TOK2}`, KEY(ik))
  t('... for every guest of the list', r.data.guest?.code === codeI && r.data.guest.claims === 2)
  r = await G.del(`/api/shared/${TOK2}/wishes/${w1}/reserve`, undefined, KEY(keyA))
  t('and release works on the new link', r.status === 200 && wishOf(r.data, w1).reserved === false)

  // takeover into an account
  const keyT = newKey()
  r = await new Client(BASE, '198.51.100.56').post(`/api/shared/${TOK2}/wishes/${w1}/reserve`, { guest_name: 'Tilda' }, KEY(keyT))
  const codeT = r.data.guest.code
  const g0 = guestRows().length
  r = await AL.get(`/api/shared/${TOK2}/guest/takeover`, KEY(keyT))
  t('signed-in user: how many claims does this key hold', r.status === 200 && r.data.claims === 1 && r.data.name === 'Tilda', r)
  r = await AL.get(`/api/shared/${TOK2}/guest/takeover`, KEY(newKey()))
  t('... unknown key: 0 claims, no name', r.status === 200 && r.data.claims === 0 && r.data.name === null)
  r = await AL.get(`/api/shared/${TOK2}/guest/takeover`)
  t('... no key: 0 claims', r.status === 200 && r.data.claims === 0)
  r = await AL.post(`/api/shared/${TOK2}/guest/takeover`, {}, KEY(newKey()))
  t('takeover with an unknown key -> 404, nothing moved', r.status === 404 && guestRows().length === g0 && resvRows().find((x) => x.wish_id === w1).guest_id !== null)
  r = await AL.post(`/api/shared/${TOK2}/guest/takeover`, {}, KEY(keyT))
  t('takeover: the claim is Alice\'s now (user, no guest, no guest name), the guest is gone', r.status === 200 && wishOf(r.data, w1).reserved_by === 'Alice' && wishOf(r.data, w1).reserved_by_me === true && guestRows().length === g0 - 1 && !guestRows().some((g) => g.code === codeT), r.data)
  row = resvRows().find((x) => x.wish_id === w1)
  t('takeover row: user_id Alice, guest_id and guest_name null', row.user_id > 0 && row.guest_id === null && row.guest_name === null, row)
  r = await new Client(BASE, '198.51.100.56').get(`/api/shared/${TOK2}`, KEY(keyT))
  t('the key of the taken-over guest is unknown now and cannot release', r.data.guest === null && (await new Client(BASE, '198.51.100.56').del(`/api/shared/${TOK2}/wishes/${w1}/reserve`, undefined, KEY(keyT))).status === 403)
  await AL.del(`/api/shared/${TOK2}/wishes/${w1}/reserve`)

  // ---- last seen is refreshed at most every 10 minutes on a read with a valid key, never by a read without one
  { const d = rawDb(); d.prepare("UPDATE wishlist_guests SET last_seen_at=datetime('now','-20 minutes'), ip='203.0.113.9', user_agent='old-agent' WHERE code=?").run(codeI); d.close() }
  const seen = () => { const d = rawDb(); try { return d.prepare('SELECT * FROM wishlist_guests WHERE code=?').get(codeI) } finally { d.close() } }
  await new Client(BASE, '198.51.100.57').get(`/api/shared/${TOK2}`)
  t('a read without the key touches nothing', seen().ip === '203.0.113.9')
  await new Client(BASE, '198.51.100.57').get(`/api/shared/${TOK2}`, KEY(newKey()))
  t('a read with an unknown key touches nothing', seen().ip === '203.0.113.9')
  await new Client(BASE, '198.51.100.57').get(`/api/shared/${TOK2}`, KEY(ik))
  const s1 = seen()
  t('a read with the key refreshes last seen, ip and device', s1.ip === '198.51.100.57' && s1.user_agent === 'GuestTest/1.0' && s1.last_seen_at > "2000", s1)
  await new Client(BASE, '198.51.100.58').get(`/api/shared/${TOK2}`, KEY(ik))
  t('... but only once per 10 minutes', seen().ip === '198.51.100.57')

  // ---- cap on guests per list
  const CAPL = (await O.post('/api/wishlists', { title: 'Many guests' })).data
  await O.post(`/api/wishlists/${CAPL.id}/share`, { link_enabled: true })
  let created = 0
  for (let i = 0; i < 300; i++) {
    r = await new Client(BASE, `198.51.101.${1 + Math.floor(i / 25)}`).post(`/api/shared/${CAPL.token}/guest`, { guest_name: 'G' + i }, KEY(gk()))
    if (r.status === 200) created++
  }
  r = await new Client(BASE, '198.51.101.99').post(`/api/shared/${CAPL.token}/guest`, { guest_name: 'One too many' }, KEY(gk()))
  t('cap: 300 guests per list, the 301st -> 409 guest_limit', created === 300 && r.status === 409 && r.data.code === 'guest_limit', { created, r: r.data })

  // ---- rate limit per IP, cap per list
  const R = new Client(BASE, '198.51.100.99')
  let limited = null
  for (let i = 0; i < 40 && !limited; i++) {
    r = await R.del(shared(w1, TOK2), undefined, KEY(gk()))
    if (r.status === 429) limited = r
  }
  t('rate limit: 429 with Retry-After and a code after ~30 attempts from one IP', limited && limited.data.code === 'too_many_requests' && Number(limited.headers.get('retry-after')) > 0, limited?.data)
  r = await R.post(`/api/shared/${TOK2}/guest`, { guest_name: 'Limited' }, KEY(gk()))
  t('rate limit: saving a personal link and renaming share the limit', r.status === 429)
  const OK = new Client(BASE, '198.51.100.98')
  const okKey = newKey()
  r = await OK.post(shared(w1, TOK2), { guest_name: 'Other IP' }, KEY(okKey))
  t('rate limit: other IPs are not affected', r.status === 200)
  await OK.del(shared(w1, TOK2), undefined, KEY(okKey))
  r = await R.get(`/api/shared/${TOK2}`)
  t('rate limit: reading is not limited', r.status === 200)

  const C = (await O.post('/api/wishlists', { title: 'Cap' })).data
  await O.post(`/api/wishlists/${C.id}/share`, { link_enabled: true })
  const cw = []
  for (let i = 0; i < 101; i++) cw.push((await O.post(`/api/wishlists/${C.id}/wishes`, { title: 'W' + i })).data.wishes.at(-1).id)
  let allOk = true
  for (let i = 0; i < 100; i++) {
    r = await new Client(BASE, `198.51.100.${150 + Math.floor(i / 20)}`).post(`/api/shared/${C.token}/wishes/${cw[i]}/reserve`, { guest_name: 'G' + i }, KEY(gk()))
    if (r.status !== 200) { allOk = false; break }
  }
  t('cap: 100 guest claims on a list work', allOk, r.data)
  r = await new Client(BASE, '198.51.100.160').post(`/api/shared/${C.token}/wishes/${cw[100]}/reserve`, { guest_name: 'One too many' }, KEY(gk()))
  t('cap: the 101st -> 409 guest_limit, and no guest row was left behind', r.status === 409 && r.data.code === 'guest_limit' && guestRows().filter((g) => g.wishlist_id === C.id).length === 100, r)
  const ca = new Client(BASE, '198.51.100.161')
  await ca.post('/api/auth/login', { email: 'alice@example.com', password: 'secret456' })
  r = await ca.post(`/api/shared/${C.token}/wishes/${cw[100]}/reserve`, {})
  t('cap: signed-in users are not capped', r.status === 200)

  // ---- audit entries
  const rs = auditRows('wish.reserve'), us = auditRows('wish.unreserve')
  const dj = (x) => JSON.parse(x.details || '{}')
  const first = rs.find((x) => dj(x).guest_name === 'Gast Gerd' && dj(x).reservation_id === rows.find((q) => q.wish_id === w1).id)
  t('audit: wish.reserve for a guest (label = name, via_link, list, owner, reservation id, guest id + code)', first && first.actor_label === 'Gast Gerd' && first.target_type === 'wish' && Number(first.target_id) === w1 && first.target_label === 'Book' && dj(first).via_link === true && dj(first).wishlist_id === L.id && dj(first).wishlist_title === 'Birthday' && dj(first).owner_user_id === 1 && dj(first).guest_code === codeA && dj(first).guest_id > 0 && first.ip === '198.51.100.10', first)
  const alice = rs.find((x) => x.actor_label?.includes('alice') && dj(x).wishlist_id === L.id)
  t('audit: wish.reserve for a signed-in user (no guest_name, no guest code)', alice && !('guest_name' in dj(alice)) && !('guest_code' in dj(alice)) && dj(alice).reservation_id > 0 && alice.actor_user_id > 0, alice)
  const viaAccess = rs.find((x) => dj(x).via_link === false)
  t('audit: a claim by direct access is via_link:false', !!viaAccess, rs.map(dj))
  t('audit: releases are logged (guest with code, and user)', us.some((x) => dj(x).guest_name === 'Gast Gerd' && dj(x).guest_code === codeA) && us.some((x) => x.actor_label?.includes('alice')), us.map(dj))
  t('audit: exactly one entry per claim (no automatic duplicate)', rs.filter((x) => dj(x).reservation_id === dj(first).reservation_id).length === 1)
  const created1 = auditRows('guest.create')
  const cA = created1.find((x) => dj(x).guest_code === codeA)
  t('audit: guest.create (label = name, target guest, list, owner, code, ip)', cA && cA.actor_label === 'Gast Gerd' && cA.target_type === 'guest' && dj(cA).guest_name === 'Gast Gerd' && dj(cA).wishlist_id === L.id && dj(cA).owner_user_id === 1 && dj(cA).guest_id > 0 && cA.ip === '198.51.100.10' && cA.user_agent === 'GuestTest/1.0', cA)
  t('audit: one guest.create per guest (a failed claim logs none, saving twice logs one)', created1.filter((x) => dj(x).guest_code === codeI).length === 1 && created1.filter((x) => dj(x).guest_code === codeA).length === 1)
  const rn = auditRows('guest.rename').find((x) => dj(x).guest_code === codeI)
  t('audit: guest.rename (previous and new name, code)', rn && dj(rn).previous_name === 'Greta' && dj(rn).guest_name === 'Greta Berger' && rn.actor_label === 'Greta Berger', rn)
  const mg = auditRows('guest.merge')
  t('audit: guest.merge (into, merged code, claims moved)', mg.length === 1 && dj(mg[0]).claims_moved === 1 && dj(mg[0]).merged_guest_name === 'Maxine' && CODE_RE.test(dj(mg[0]).merged_guest_code) && dj(mg[0]).guest_name === 'Max', mg.map(dj))
  const tk = auditRows('guest.takeover')
  t('audit: guest.takeover (code, claims, actor = the user)', tk.length === 1 && dj(tk[0]).guest_code === codeT && dj(tk[0]).claims_taken === 1 && tk[0].actor_user_id > 0 && dj(tk[0]).owner_user_id === 1, tk.map(dj))
  const allAudit = (() => { const d = rawDb(); try { return d.prepare('SELECT * FROM audit_log').all() } finally { d.close() } })()
  t('audit: no key anywhere in the audit log, in no field', !allAudit.some((x) => ALL_KEYS.some((k) => JSON.stringify(x).includes(k))) && !allAudit.some((x) => /guest_?key/i.test(x.details || '')))
  t('no key anywhere in the database files', ALL_KEYS.every((k) => !dbText().includes(k)))
  const admin = await (async () => { const c = new Client(BASE, '198.51.100.2'); await c.post('/api/auth/login', { email: 'olivia@example.com', password: 'secret123' }); return c })()
  const surfaces = [await admin.get('/api/admin/audit/export?reveal_own=1&format=json'), await admin.get('/api/admin/audit/export?reveal_own=1'), await admin.get('/api/admin/claims/export?reveal_own=1'), await admin.get('/api/admin/claims?reveal_own=1&limit=100'), await admin.get('/api/admin/guests?reveal_own=1&limit=100'), await admin.get('/api/admin/audit?reveal_own=1&limit=200'), await AL.get('/api/state'), await AL.get('/api/export')]
  t('no key in any admin list or export, nor in state/export', surfaces.every((v) => v.status === 200 && ALL_KEYS.every((k) => !v.text.includes(k))), surfaces.map((v) => v.status))
  const oneGuest = await admin.get(`/api/admin/guests?reveal_own=1&guest=${codeA}`)
  t('the admin guest list shows codes (this is what the keys are replaced by)', oneGuest.data.items.length === 1 && oneGuest.data.items[0].name === 'Gast Gerd' && oneGuest.data.items[0].ip && oneGuest.data.items[0].claims >= 0 && surfaces[2].text.includes(codeA), oneGuest.data)

  // ---- implicit releases
  const D = (await O.post('/api/wishlists', { title: 'Delete me' })).data
  await O.post(`/api/wishlists/${D.id}/share`, { link_enabled: true })
  const dw = (await O.post(`/api/wishlists/${D.id}/wishes`, { title: 'Doomed' })).data.wishes[0].id
  const dw2 = (await O.post(`/api/wishlists/${D.id}/wishes`, { title: 'Doomed 2' })).data.wishes[1].id
  await new Client(BASE, '198.51.100.20').post(`/api/shared/${D.token}/wishes/${dw}/reserve`, { guest_name: 'Doomed Guest' }, KEY(gk()))
  await new Client(BASE, '198.51.100.21').post(`/api/shared/${D.token}/wishes/${dw2}/reserve`, { guest_name: 'Doomed Guest 2' }, KEY(gk()))
  const before2 = auditRows('wish.unreserve').length
  r = await O.del(`/api/wishes/${dw}`)
  t('owner deletes a claimed wish: the claim goes with it', r.status === 200 && !resvRows().some((x) => x.wish_id === dw))
  let imp = auditRows('wish.unreserve').slice(before2)
  t('audit: implicit wish.unreserve (reason wish_deleted, guest name + code, owner as actor)', imp.length === 1 && dj(imp[0]).reason === 'wish_deleted' && dj(imp[0]).guest_name === 'Doomed Guest' && CODE_RE.test(dj(imp[0]).guest_code) && imp[0].actor_user_id === 1 && imp[0].target_label === 'Doomed', imp)
  t('audit: the delete itself is still logged', auditRows('wish.delete').some((x) => Number(x.target_id) === dw))
  r = await O.del(`/api/wishlists/${D.id}`)
  imp = auditRows('wish.unreserve').slice(before2 + 1)
  t('owner deletes the list: remaining claim logged as released (wishlist_deleted)', r.status === 200 && imp.length === 1 && dj(imp[0]).reason === 'wishlist_deleted' && dj(imp[0]).guest_name === 'Doomed Guest 2', imp)
  t('... no claim rows are left and the guests of the list went with it', !resvRows().some((x) => x.wish_id === dw2) && !guestRows().some((g) => g.wishlist_id === D.id))
}

// ---------------------------------------------------------------------------------------------------------------------------------
/** A sign-in proxy in front of the app: only BYPASS_PATHS (as the server reports them) pass, the rest is answered in `mode` */
function fakeProxy(allow) {
  let mode = 'redirect'
  const ok = (p) => allow.some((b) => (b.endsWith('/*') ? p.startsWith(b.slice(0, -1)) : p === b))
  const seen = []
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0]
    seen.push({ method: req.method, path: p, url: req.url, passed: ok(p) })
    if (!ok(p)) {
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:9/login' }); return res.end() }
      if (mode === 'html200') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><body>Sign in at the proxy</body></html>') }
      res.writeHead(mode === '403' ? 403 : 401, { 'Content-Type': 'text/html' }); return res.end('<html><body>Denied</body></html>')
    }
    const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-for': '198.51.100.77' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
    up.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(up)
  })
  return new Promise((resolve) => srv.listen(PROXY_PORT, '127.0.0.1', () => resolve({ seen, setMode: (m) => { mode = m; seen.length = 0 }, close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections() }) })))
}

async function proxyTests() {
  const O = new Client(BASE, '198.51.100.2')
  await O.post('/api/auth/login', { email: 'olivia@example.com', password: 'secret123' })
  const dg = await O.get('/api/admin/diagnostics/proxy')
  const bypass = dg.data.bypass_paths
  // Existing proxy setups need no change: the documented list is what it was in 1.1.0
  t('the documented bypass list is unchanged', JSON.stringify(bypass) === JSON.stringify(['/w/*', '/api/shared/*', '/api/images/*', '/api/v1/*', '/api/auth/google/callback', '/healthz', '/assets/*']), bypass)
  const L = (await O.post('/api/wishlists', { title: 'Via proxy' })).data
  await O.post(`/api/wishlists/${L.id}/share`, { link_enabled: true })
  fs.mkdirSync(path.join(DATA, 'images'), { recursive: true })
  const img = 'c'.repeat(40) + '.png'
  fs.writeFileSync(path.join(DATA, 'images', img), 'x')
  const wid = (await O.post(`/api/wishlists/${L.id}/wishes`, { title: 'Photo wish', image_url: '/api/images/' + img })).data.wishes[0].id
  const px = await fakeProxy(bypass) // one instance (a stopped one would leave dead keep-alive connections behind)
  for (const mode of ['redirect', 'html200', '401', '403']) {
    px.setMode(mode)
    const P = new Client(`http://127.0.0.1:${PROXY_PORT}`, '198.51.100.30')
    const tag = (s) => `proxy ${mode}: ${s}`
    const key = newKey(), key2 = newKey()
    let r = await P.get(`/w/${L.token}`)
    t(tag('the page /w/:token reaches the app shell'), r.status === 200 && r.text.includes('id="root"'), r.status)
    r = await P.get(`/w/${L.token}#g=${key}`) // a personal link: the fragment stays in the browser
    t(tag('the personal link page loads like the normal one'), r.status === 200 && r.text.includes('id="root"'), r.status)
    r = await P.get('/assets/theme-init.js')
    t(tag('assets pass'), r.status === 200)
    r = await P.get(`/api/shared/${L.token}`, KEY(key))
    t(tag('the list loads (with app name and locale), the key is unknown yet'), r.status === 200 && r.data.wishes.length === 1 && r.data.app?.name && r.data.guest_claims === true && r.data.guest === null, r.status)
    r = await P.get('/api/images/' + img)
    t(tag('product images pass'), r.status === 200)
    r = await P.post(`/api/shared/${L.token}/wishes/${wid}/reserve`, { guest_name: 'Proxy Pia' }, KEY(key))
    t(tag('a guest can reserve'), r.status === 200 && wishOf(r.data, wid).reserved_by_me === true && r.data.guest?.name === 'Proxy Pia' && r.data.guest.claims === 1, r.status)
    r = await P.get(`/api/shared/${L.token}`, KEY(key))
    t(tag('after a reload the claim is still "mine"'), wishOf(r.data, wid).reserved_by_me === true && r.data.guest.claims === 1)
    r = await P.post(`/api/shared/${L.token}/guest`, { guest_name: 'x' }, KEY(key))
    t(tag('saving the personal link (POST /guest) passes'), r.status === 200 && r.data.guest.name === 'Proxy Pia')
    r = await P.put(`/api/shared/${L.token}/guest`, { guest_name: 'Pia P' }, KEY(key))
    t(tag('renaming (PUT /guest) passes'), r.status === 200 && r.data.guest.name === 'Pia P' && wishOf(r.data, wid).reserved_by === 'Pia P')
    r = await P.post(`/api/shared/${L.token}/guest`, { guest_name: 'Pia Two' }, KEY(key2))
    r = await P.post(`/api/shared/${L.token}/guest/merge`, {}, { ...KEY(key), 'X-Guest-Merge-Key': key2 })
    t(tag('merging (POST /guest/merge) passes'), r.status === 200 && r.data.guest.name === 'Pia P')
    r = await P.del(`/api/shared/${L.token}/wishes/${wid}/reserve`, undefined, KEY(key))
    t(tag('a guest can release'), r.status === 200 && wishOf(r.data, wid).reserved === false)
    // what the proxy is meant to hold back is held back (so the test proves something)
    r = await P.get('/api/auth/me')
    t(tag('/api/auth/me is not reachable (as configured)'), mode === 'redirect' ? r.status === 302 : mode === 'html200' ? r.status === 200 && r.data === null : r.status === Number(mode), r.status)
    t(tag('every request of the guest flow passed'), px.seen.filter((x) => x.path !== '/api/auth/me').every((x) => x.passed), px.seen.filter((x) => !x.passed))
    t(tag('no key in any URL the proxy saw (the personal link keeps it in the fragment, which is never sent)'), px.seen.every((x) => !x.url.includes(key) && !x.url.includes(key2) && !x.url.includes('#')), px.seen.map((x) => x.url))
  }
  await px.close()
}

// ---------------------------------------------------------------------------------------------------------------------------------
async function migrationTests() {
  await stop()
  // A database as 1.1.0 left it (schema 3): no guest columns or tables, guest claims written by name
  const d = rawDb()
  d.exec('PRAGMA foreign_keys=OFF')
  d.exec('ALTER TABLE wishlists DROP COLUMN guest_claims')
  d.exec('DROP TABLE reservations')
  d.exec('DROP TABLE wishlist_guests')
  d.exec("CREATE TABLE reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, wish_id INTEGER NOT NULL UNIQUE REFERENCES wishes(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, guest_name TEXT, gift_id INTEGER REFERENCES gifts(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))")
  d.exec('PRAGMA user_version = 3')
  const h0 = JSON.parse(d.prepare("SELECT value FROM system_settings WHERE key='schema_history'").get().value).filter((h) => h.version <= 3)
  d.prepare("UPDATE system_settings SET value=? WHERE key='schema_history'").run(JSON.stringify(h0))
  const list = d.prepare("SELECT id, share_token FROM wishlists WHERE title='Birthday'").get()
  const [wish, wish2] = d.prepare('SELECT id FROM wishes WHERE wishlist_id=? ORDER BY id LIMIT 2').all(list.id)
  d.prepare('INSERT INTO reservations (wish_id, user_id, guest_name) VALUES (?,NULL,?)').run(wish.id, 'Legacy Lena')
  d.close()
  await start()
  let d2 = rawDb()
  const cols = (tbl) => d2.prepare(`PRAGMA table_info(${tbl})`).all().map((c) => c.name)
  t('migration: schema version >= 4', Number(d2.prepare('PRAGMA user_version').get().user_version) >= 4)
  t('migration: new columns and the guests table exist', cols('wishlists').includes('guest_claims') && ['guest_id', 'ip', 'user_agent'].every((c) => cols('reservations').includes(c)) && ['code', 'name', 'key_hash', 'wishlist_id', 'last_seen_at', 'ip', 'user_agent'].every((c) => cols('wishlist_guests').includes(c)))
  t('migration: the claim kept its name and has no guest', JSON.stringify(d2.prepare('SELECT guest_name, guest_id FROM reservations').all()) === JSON.stringify([{ guest_name: 'Legacy Lena', guest_id: null }]))
  t('migration: existing lists allow guests (default on)', d2.prepare('SELECT COUNT(*) AS n FROM wishlists WHERE guest_claims=1').get().n === d2.prepare('SELECT COUNT(*) AS n FROM wishlists').get().n)
  const hist = JSON.parse(d2.prepare("SELECT value FROM system_settings WHERE key='schema_history'").get().value)
  t('migration: logged once', hist.filter((h) => h.version === 4).length === 1, hist)
  d2.close()
  const G = new Client(BASE, '198.51.100.40')
  let r = await G.get(`/api/shared/${list.share_token}`, { 'X-Guest-Name': encodeURIComponent('legacy lena') })
  t('migration: the legacy claim is shown and mine by name', r.status === 200 && wishOf(r.data, wish.id)?.reserved_by === 'Legacy Lena' && wishOf(r.data, wish.id)?.reserved_by_me === true && r.data.guest === null, r.data)
  r = await G.del(`/api/shared/${list.share_token}/wishes/${wish.id}/reserve`, undefined, { 'X-Guest-Name': encodeURIComponent('Someone Else') })
  t('migration: a legacy claim is not released by another name', r.status === 403)
  r = await G.del(`/api/shared/${list.share_token}/wishes/${wish.id}/reserve`, undefined, { 'X-Guest-Name': encodeURIComponent('Legacy Lena') })
  t('migration: ... but by its name', r.status === 200)
  const nk = newKey()
  r = await G.post(`/api/shared/${list.share_token}/wishes/${wish.id}/reserve`, { guest_name: 'New Nina' }, KEY(nk))
  t('migration: new claims create a guest with the key', r.status === 200 && CODE_RE.test(r.data.guest?.code) && r.data.guest.name === 'New Nina')
  await stop()
  await start() // second start: nothing to migrate, nothing breaks
  d2 = rawDb()
  const hist2 = JSON.parse(d2.prepare("SELECT value FROM system_settings WHERE key='schema_history'").get().value)
  t('second start: version not lowered, migration 4 not repeated', Number(d2.prepare('PRAGMA user_version').get().user_version) >= 4 && hist2.filter((h) => h.version === 4).length === 1, hist2)
  t('second start: the claim and its guest survived', d2.prepare('SELECT COUNT(*) AS n FROM reservations r JOIN wishlist_guests g ON g.id=r.guest_id WHERE r.guest_name=? AND g.name=?').get('New Nina', 'New Nina').n === 1)
  d2.close()
  r = await new Client(BASE, '198.51.100.41').get(`/api/shared/${list.share_token}`, KEY(nk))
  t('second start: lists are served and the key still means the same guest', r.status === 200 && r.data.guest?.name === 'New Nina' && r.data.guest.claims === 1)

  // A database from the 1.2.0 development builds: already at 4, with the old secret column and without guest_id
  await stop()
  d2 = rawDb()
  d2.exec('PRAGMA foreign_keys=OFF')
  d2.exec('DROP TABLE reservations')
  d2.exec('DROP TABLE wishlist_guests')
  d2.exec("CREATE TABLE reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, wish_id INTEGER NOT NULL UNIQUE REFERENCES wishes(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, guest_name TEXT, gift_id INTEGER REFERENCES gifts(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), guest_secret_hash TEXT, ip TEXT, user_agent TEXT)")
  d2.prepare('INSERT INTO reservations (wish_id, user_id, guest_name, guest_secret_hash) VALUES (?,NULL,?,?)').run(wish2.id, 'Dev Dora', 'x'.repeat(64))
  d2.close()
  await start()
  d2 = rawDb()
  t('dev database at 4: guest_id and the guests table are added, the row survives', cols('reservations').includes('guest_id') && cols('wishlist_guests').includes('key_hash') && d2.prepare('SELECT COUNT(*) AS n FROM reservations WHERE guest_name=?').get('Dev Dora').n === 1)
  d2.close()
  r = await new Client(BASE, '198.51.100.42').get(`/api/shared/${list.share_token}`, { 'X-Guest-Name': encodeURIComponent('dev dora') })
  t('dev database at 4: its claim is a name claim now', wishOf(r.data, wish2.id)?.reserved_by === 'Dev Dora' && wishOf(r.data, wish2.id)?.reserved_by_me === true)
}

try {
  await start()
  await apiTests()
  await proxyTests()
  await migrationTests()
} catch (e) {
  failN++
  results.push('ERROR ' + (e?.stack || e) + (e?.cause ? ' / ' + e.cause : ''))
} finally {
  try { await stop() } catch {}
  fs.rmSync(TMP, { recursive: true, force: true })
}
console.log(results.join('\n'))
console.log(`\n${pass} passed, ${failN} failed`)
process.exit(failN ? 1 : 0)
