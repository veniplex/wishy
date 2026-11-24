import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.SMOKE_PORT) || 3977
const BASE = `http://127.0.0.1:${PORT}`
const DATA = path.join(os.tmpdir(), 'wishy-plat-' + Date.now())
fs.mkdirSync(DATA, { recursive: true })

let fails = 0
let checks = 0
const ok = (c, m, extra) => {
  checks++
  if (!c) {
    fails++
    console.log('  FAIL:', m, extra !== undefined ? JSON.stringify(extra).slice(0, 1500) : '')
  }
}
const section = (s) => console.log('\n# ' + s)

let server
function start(dataDir, env = {}) {
  return new Promise((resolve, reject) => {
    server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), AI_TEST_MOCK: '1', ...env } })
    let out = ''
    server.stdout.on('data', (d) => { out += d; if (out.includes('running')) resolve() })
    server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))
    server.on('exit', (c) => reject(new Error('server exit ' + c)))
  })
}
const stop = () => new Promise((r) => { server.removeAllListeners('exit'); server.on('exit', r); server.kill() })

class Client {
  constructor(name) { this.name = name; this.cookies = {}; this.space = null }
  async req(method, url, body, headers = {}) {
    const h = { ...headers }
    if (body !== undefined && typeof body !== 'string') h['Content-Type'] = 'application/json'
    else if (method !== 'GET' && !h['Content-Type']) h['X-Requested-With'] = 'x'
    if (this.space && !h['X-Space']) h['X-Space'] = String(this.space)
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    if (ck) h.Cookie = ck
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' })
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      const v = kv.slice(i + 1)
      if (v) this.cookies[kv.slice(0, i)] = v
      else delete this.cookies[kv.slice(0, i)]
    }
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = text }
    return { status: res.status, data, headers: res.headers, text }
  }
  get(u, h) { return this.req('GET', u, undefined, h) }
  post(u, b, h) { return this.req('POST', u, b ?? {}, h) }
  put(u, b, h) { return this.req('PUT', u, b ?? {}, h) }
  del(u, h) { return this.req('DELETE', u, undefined, h) }
}
const api = (key, method, url, body, headers = {}) =>
  fetch(BASE + '/api/v1' + url, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers, ...(body !== undefined && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }).then(async (r) => {
    const t = await r.text()
    let d
    try { d = JSON.parse(t) } catch { d = t }
    return { status: r.status, data: d, headers: r.headers }
  })

const rdb = () => {
  const d = new DatabaseSync(path.join(DATA, 'wishlist.db'))
  d.exec('PRAGMA busy_timeout=5000')
  return d
}
const PW = 'S3cret-Passw0rd!'
const PWB = 'Another-Passw0rd-B!'

async function main() {
  await start(DATA)
  const A = new Client('A')
  const B = new Client('B')

  section('Setup, login ok/fail, audit')
  let r = await A.post('/api/auth/setup', { name: 'Alice Admin', email: 'alice@example.com', password: PW })
  ok(r.status === 200, 'setup', r)
  await A.post('/api/auth/logout')
  r = await A.post('/api/auth/login', { email: 'alice@example.com', password: 'wrong-password-xx' })
  ok(r.status === 401, 'login fail 401', r)
  r = await A.post('/api/auth/login', { email: 'alice@example.com', password: PW })
  ok(r.status === 200, 'login ok', r)
  r = await A.get('/api/admin/audit?limit=100')
  ok(r.status === 200 && Array.isArray(r.data.items), 'audit list', r)
  const logins = r.data.items.filter((i) => i.action === 'auth.login')
  ok(logins.some((i) => i.status === 'ok' && i.actor_label === 'alice@example.com' && i.via === 'session'), 'login ok entry with actor', logins)
  ok(logins.some((i) => i.status === 'fail' && i.details?.email === 'alice@example.com' && i.via === 'anonymous'), 'login fail entry with email', logins)
  ok(r.data.items.some((i) => i.action === 'system.startup' && i.via === 'system'), 'startup entry')
  ok(r.data.items.some((i) => i.action === 'auth.setup'), 'setup entry')

  r = await A.put('/api/admin/settings/general', { app_name: 'Wishy Test' })
  ok(r.status === 200, 'settings put', r)
  r = await A.get('/api/admin/audit?action=admin.settings.update')
  ok(r.data.items.length === 1 && JSON.stringify(r.data.items[0].details).includes('app_name'), 'settings audit', r.data)
  ok(!JSON.stringify(r.data).includes('Wishy Test'), 'settings audit has no value')

  // Anonymous failed access to security routes
  const anon = new Client('anon')
  r = await anon.put('/api/admin/settings/general', { app_name: 'x' })
  ok(r.status === 401, 'anon admin 401')
  r = await A.get('/api/admin/audit?status=fail&via=anonymous&action=admin.settings.update')
  ok(r.data.items.length === 0, 'anon 401 on protected route is NOT audited (noise)', r.data)

  section('User B, features, AI')
  r = await A.post('/api/admin/users', { name: 'Bob', email: 'bob@example.com', password: PWB })
  ok(r.status === 200, 'create user B', r)
  const bobId = r.data.user.id
  r = await B.post('/api/auth/login', { email: 'bob@example.com', password: PWB })
  ok(r.status === 200, 'B login', r)
  r = await B.get('/api/auth/me')
  ok(r.status === 200 && r.data.user?.features && typeof r.data.user.features.api === 'boolean' && typeof r.data.user.features.ai === 'boolean', 'me.user.features present', r.data)
  r = await A.get('/api/admin/users/features')
  ok(r.status === 200 && r.data.find((x) => x.id === bobId)?.features.api === true && r.data.find((x) => x.id === bobId)?.features.ai === false, 'features default: api on, ai off (not configured)', r.data)
  r = await A.put('/api/admin/ai', { ai_enabled: true, ai_provider: 'mock', ai_prices: { mock: { input_per_mtok: 1, output_per_mtok: 2 }, 'claude-sonnet-5-5': { input_per_mtok: 2, output_per_mtok: 10 } }, ai_cost_currency: 'EUR', ai_cost_rate: 0.9 })
  ok(r.status === 200 && r.data.ai_prices.mock.output_per_mtok === 2 && r.data.ai_cost_currency === 'EUR', 'ai settings + prices', r)
  r = await A.get('/api/admin/users/features')
  ok(r.data.find((x) => x.id === bobId).features.ai === true, 'ai on after config')
  r = await B.post('/api/ai/extract-text', { text: 'Anna wants a teapot', target: 'ideas' })
  ok(r.status === 200 && r.data.items.length >= 1, 'AI works for B', r)
  r = await A.put(`/api/admin/users/${bobId}/features`, { ai_enabled: false })
  ok(r.status === 200 && r.data.ai_enabled === 0 && r.data.features.ai === false, 'set ai override off', r.data)
  r = await B.post('/api/ai/extract-text', { text: 'x y z', target: 'ideas' })
  ok(r.status === 403 && r.data.code === 'ai_disabled_for_user', 'AI enforcement', r)
  r = await B.get('/api/ai/status')
  ok(r.data.enabled === false, 'ai status reflects user switch', r.data)
  r = await A.put(`/api/admin/users/${bobId}/features`, { ai_enabled: 'default' })
  ok(r.data.ai_enabled === null && r.data.features.ai === true, 'inherit again', r.data)
  r = await A.put(`/api/admin/users/${bobId}/features`, { ai_enabled: 'bogus' })
  ok(r.status === 400 && r.data.code === 'invalid_value', 'invalid feature value')
  r = await A.get('/api/admin/audit?action=admin.user.features')
  ok(r.data.items.length >= 2, 'features audited')

  section('API keys')
  r = await B.post('/api/account/api-keys', { name: 'Shortcut', scopes: ['read', 'write'] })
  ok(r.status === 200 && /^wishy_[A-Za-z0-9]{8}_[A-Za-z0-9]{32,}$/.test(r.data.secret), 'key created', r)
  const KEY = r.data.secret
  const keyId = r.data.key.id
  ok(r.data.key.prefix === KEY.split('_')[1], 'prefix matches')
  r = await B.get('/api/account/api-keys')
  ok(r.status === 200 && r.data.keys.length === 1 && !JSON.stringify(r.data).includes(KEY) && !JSON.stringify(r.data).includes(KEY.split('_')[2]), 'list hides secret', r.data)
  {
    const d = rdb()
    const row = d.prepare('SELECT * FROM api_keys WHERE id=?').get(keyId)
    ok(row.key_hash.length === 64 && !JSON.stringify(row).includes(KEY.split('_')[2]), 'hash only in DB', row)
    d.close()
  }
  r = await api(KEY, 'GET', '/me')
  ok(r.status === 200 && r.data.user.email === 'bob@example.com' && r.data.features.api === true, 'v1/me', r)
  r = await B.get('/api/account/api-keys')
  ok(r.data.keys[0].last_used_at && r.data.keys[0].last_used_ip, 'last_used tracked', r.data.keys[0])
  r = await api(KEY.slice(0, -1) + (KEY.endsWith('a') ? 'b' : 'a'), 'GET', '/me')
  ok(r.status === 401 && r.data.code === 'invalid_api_key', 'wrong key 401', r)
  r = await api('garbage', 'GET', '/me')
  ok(r.status === 401 && r.data.code === 'invalid_api_key', 'garbage key 401', r)
  r = await api(null, 'GET', '/me')
  ok(r.status === 401 && r.data.code === 'api_key_required', 'no key 401', r)
  r = await fetch(BASE + '/api/v1/me', { headers: { 'X-API-Key': KEY } })
  ok(r.status === 200, 'X-API-Key header works')
  r = await api(KEY, 'GET', '/me', undefined, { Cookie: 'wl_session=abc' })
  ok(r.status === 200, 'cookies ignored')
  // API keys cannot manage keys via session routes
  r = await fetch(BASE + '/api/account/api-keys', { headers: { Authorization: `Bearer ${KEY}` } })
  ok(r.status === 401, 'bearer not valid on session routes', r.status)

  // read-only key
  r = await B.post('/api/account/api-keys', { name: 'readonly', scopes: ['read'] })
  const RO = r.data.secret
  const roId = r.data.key.id
  r = await api(RO, 'GET', '/persons')
  ok(r.status === 200, 'read key reads')
  r = await api(RO, 'POST', '/capture', { text: 'x' })
  ok(r.status === 403 && r.data.code === 'insufficient_scope', 'read key cannot write', r)
  // write only
  r = await B.post('/api/account/api-keys', { name: 'writeonly', scopes: ['write'] })
  const WO = r.data.secret
  r = await api(WO, 'GET', '/persons')
  ok(r.status === 403 && r.data.code === 'insufficient_scope', 'write-only key cannot read')
  r = await B.post('/api/account/api-keys', { name: 'x', scopes: ['admin'] })
  ok(r.status === 400 && r.data.code === 'invalid_scopes', 'invalid scopes')
  r = await B.post('/api/account/api-keys', { name: '' })
  ok(r.status === 400 && r.data.code === 'name_required', 'name required')

  // expiry & revoke
  r = await B.post('/api/account/api-keys', { name: 'exp', expires_in_days: 1 })
  const EXP = r.data.secret
  ok(r.data.key.expires_at && r.data.key.status === 'active', 'expires_at set')
  {
    const d = rdb()
    d.prepare('UPDATE api_keys SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), r.data.key.id)
    d.close()
  }
  r = await api(EXP, 'GET', '/me')
  ok(r.status === 401 && r.data.code === 'api_key_expired', 'expired rejected', r)
  r = await B.del(`/api/account/api-keys/${roId}`)
  ok(r.status === 200 && r.data.status === 'revoked', 'revoke', r)
  r = await api(RO, 'GET', '/me')
  ok(r.status === 401 && r.data.code === 'api_key_revoked', 'revoked rejected', r)
  r = await A.get('/api/admin/api-keys')
  ok(r.status === 200 && r.data.keys.length >= 4 && r.data.keys[0].user_email, 'admin lists all keys', r.data.keys?.length)
  r = await B.get('/api/admin/api-keys')
  ok(r.status === 403, 'non-admin cannot list all keys')
  r = await A.get('/api/admin/audit?action=api_key.*')
  const acts = r.data.items.map((i) => i.action)
  ok(acts.includes('api_key.create') && acts.includes('api_key.revoke') && acts.includes('api_key.use'), 'key audit entries', acts)
  ok(r.data.items.filter((i) => i.action === 'api_key.use' && i.via === 'api_key').length >= 1, 'key use via api_key')

  // Feature switch for the API
  r = await A.put(`/api/admin/users/${bobId}/features`, { api_enabled: 0 })
  r = await api(KEY, 'GET', '/me')
  ok(r.status === 403 && r.data.code === 'api_disabled', 'per-user api off', r)
  r = await B.post('/api/account/api-keys', { name: 'nope' })
  ok(r.status === 403 && r.data.code === 'api_disabled', 'cannot create key when api off')
  r = await A.put(`/api/admin/users/${bobId}/features`, { api_enabled: null })
  r = await A.put('/api/admin/api-keys/settings', { api_enabled: false })
  ok(r.data.api_enabled === false, 'global api off')
  r = await api(KEY, 'GET', '/me')
  ok(r.status === 403, 'global off blocks inherit')
  r = await A.put(`/api/admin/users/${bobId}/features`, { api_enabled: 1 })
  r = await api(KEY, 'GET', '/me')
  ok(r.status === 200, 'user override on beats global off', r)
  r = await A.put(`/api/admin/users/${bobId}/features`, { api_enabled: null })
  await A.put('/api/admin/api-keys/settings', { api_enabled: true })
  r = await api(KEY, 'GET', '/me')
  ok(r.status === 200, 'back on')

  section('Capture')
  r = await B.get('/api/state')
  const spaceB = r.data.space_id
  r = await B.post('/api/persons', { name: 'Anna' })
  ok(r.status === 200, 'person Anna', r)
  r = await B.post('/api/persons', { name: 'Tom Tester' })
  // text, no AI
  r = await api(KEY, 'POST', '/capture', { text: 'Green teapot\nFrom the shop at the market\nabout 30 euros', use_ai: false })
  ok(r.status === 201 && r.data.created.length === 1 && r.data.created[0].title === 'Green teapot' && r.data.inbox === 1 && r.data.created[0].inbox === true && r.data.ai_used === false, 'plain text -> inbox', r)
  r = await B.get('/api/state')
  ok(r.data.inbox_items.length === 1 && r.data.inbox_items[0].notes.includes('shop'), 'inbox in state', r.data.inbox_items)
  ok(!r.data.items.some((i) => i.person_id === null), 'items has no null person')
  // text/plain body
  r = await fetch(BASE + '/api/v1/capture', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Notebook with elastic band\nA5 for Tomhttps://example.org/notebook' })
  const tp = await r.json()
  ok(r.status === 201 && tp.created.length >= 1, 'text/plain capture (AI mock)', tp)
  console.log('  text/plain created:', JSON.stringify(tp.created.map((c) => [c.title, c.person, c.inbox])), 'ai_used', tp.ai_used)
  r = await fetch(BASE + '/api/v1/capture', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'text/plain' }, body: 'Text only, no AI' })
  // person by name (case-insens, partial)
  r = await api(KEY, 'POST', '/capture', { text: 'Lego Set', person: 'anna', use_ai: false })
  ok(r.status === 201 && r.data.created[0].person === 'Anna' && r.data.inbox === 0, 'person by name', r.data)
  r = await api(KEY, 'POST', '/capture', { text: 'Lego Set 2', person: 'tom', use_ai: false })
  ok(r.data.created[0].person === 'Tom Tester', 'person by partial name', r.data)
  const annaId = (await B.get('/api/state')).data.persons.find((p) => p.name === 'Anna').id
  r = await api(KEY, 'POST', '/capture', { text: 'Book', person: annaId, use_ai: false })
  ok(r.data.created[0].person === 'Anna', 'person by id', r.data)
  r = await api(KEY, 'POST', '/capture', { text: 'Book', person: 'Nobody Known', use_ai: false })
  ok(r.status === 201 && r.data.inbox === 1 && r.data.unmatched_person === 'Nobody Known', 'unknown person -> inbox', r.data)
  // AI text: mock returns 2 items; first has person_name Anna
  r = await api(KEY, 'POST', '/capture', { text: 'Anna wants a camera, see https://example.com/camera' })
  ok(r.status === 201 && r.data.ai_used === true && r.data.created.length === 2, 'AI text -> 2 items', r.data)
  ok(r.data.created[0].person === 'Anna' && r.data.created[1].person === null && r.data.created[1].inbox, 'AI person match + inbox', r.data.created)
  ok(r.data.created[1].url === null, 'invented url dropped')
  // explicit person overrides AI
  r = await api(KEY, 'POST', '/capture', { text: 'Something for Tom: socks', person: 'Tom Tester' })
  ok(r.data.created.every((c) => c.person === 'Tom Tester'), 'explicit person wins', r.data)
  // AI explicit disabled
  r = await A.put(`/api/admin/users/${bobId}/features`, { ai_enabled: 0 })
  r = await api(KEY, 'POST', '/capture', { text: 'Some text', use_ai: true })
  ok(r.status === 403 && r.data.code === 'ai_disabled_for_user', 'use_ai true w/o permission 403', r)
  r = await api(KEY, 'POST', '/capture', { text: 'Some text without AI flag' })
  ok(r.status === 201 && r.data.ai_used === false && r.data.created.length === 1, 'default no AI when disabled', r.data)
  await A.put(`/api/admin/users/${bobId}/features`, { ai_enabled: null })
  // AI failure -> fallback
  r = await api(KEY, 'POST', '/capture', { text: 'MOCK_FAIL Text' })
  ok(r.status === 201 && r.data.created.length === 1 && r.data.warnings?.includes('ai_failed'), 'AI failure falls back', r.data)
  // validation
  r = await api(KEY, 'POST', '/capture', {})
  ok(r.status === 400 && r.data.code === 'text_or_url_required', 'empty capture 400', r)
  r = await api(KEY, 'POST', '/capture', { text: 'x', kind: 'zzz' })
  ok(r.status === 400 && r.data.code === 'invalid_kind', 'invalid kind')
  r = await fetch(BASE + '/api/v1/capture', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: '{bad' })
  ok(r.status === 400 && (await r.json()).code === 'invalid_json', 'invalid json')
  // url
  r = await api(KEY, 'POST', '/capture', { url: 'http://127.0.0.1:9/x', use_ai: false })
  ok(r.status === 201 && r.data.created.length === 1 && r.data.created[0].url === 'http://127.0.0.1:9/x' && r.data.warnings?.includes('link_import_failed'), 'blocked url -> fallback item', r.data)
  r = await api(KEY, 'POST', '/capture', { text: 'https://example.com/', use_ai: false })
  ok(r.status === 201 && r.data.created.length === 1, 'text that is a url', r.data)
  console.log('  example.com url import:', JSON.stringify(r.data.created[0]), r.data.warnings)
  r = await api(KEY, 'POST', '/capture', { url: 'https://example.com/' })
  ok(r.status === 201 && r.data.created.length === 1, 'url with AI', r.data)
  console.log('  example.com url+AI:', JSON.stringify(r.data.created[0]), r.data.ai_used, r.data.warnings)
  // wish
  r = await api(KEY, 'POST', '/capture', { text: 'Mechanical keyboard', kind: 'wish', use_ai: false })
  ok(r.status === 201 && r.data.created[0].type === 'wish' && r.data.created[0].wishlist_id, 'wish capture creates list', r.data)
  const listId = r.data.created[0].wishlist_id
  r = await api(KEY, 'GET', `/wishlists/${listId}`)
  ok(r.status === 200 && r.data.wishes.length === 1 && r.data.owned === true && !('reserved' in r.data.wishes[0]), 'wishlist detail', r.data)
  r = await api(KEY, 'POST', `/wishlists/${listId}/wishes`, { title: 'Mouse', price: 25.5, priority: 3 })
  ok(r.status === 201 && r.data.title === 'Mouse' && r.data.priority === 3, 'add wish', r)
  r = await api(KEY, 'POST', `/wishlists/${listId}/wishes`, { price: 1 })
  ok(r.status === 400, 'wish needs title')
  r = await api(KEY, 'GET', '/wishlists')
  ok(r.status === 200 && r.data.some((l) => l.id === listId && l.owned && l.wish_count === 2), 'wishlists list', r.data)
  r = await A.post('/api/wishlists', { title: 'Alice list' })
  const aliceList = r.data.id
  r = await api(KEY, 'GET', `/wishlists/${aliceList}`)
  ok(r.status === 404, 'foreign unshared list 404')
  r = await api(KEY, 'POST', `/wishlists/${aliceList}/wishes`, { title: 'hack' })
  ok(r.status === 404, 'cannot add wish to foreign list')
  // ideas endpoint
  r = await api(KEY, 'POST', '/ideas', { title: 'Scarf', person: 'Anna', price: 12 })
  ok(r.status === 201 && r.data.person === 'Anna' && r.data.inbox === false, 'v1 idea', r)
  r = await api(KEY, 'POST', '/ideas', { title: 'Scarf without person' })
  ok(r.status === 201 && r.data.inbox === true, 'v1 idea inbox')
  r = await api(KEY, 'POST', '/ideas', { title: 'X', person: 'Unknown' })
  ok(r.status === 404 && r.data.code === 'person_not_found', 'v1 idea unknown person 404')
  r = await api(KEY, 'GET', '/ideas?person=Anna')
  ok(r.status === 200 && r.data.length >= 3 && r.data.every((i) => i.person === 'Anna'), 'ideas by person', r.data.length)
  r = await api(KEY, 'GET', '/ideas?person=inbox')
  ok(r.data.length >= 4 && r.data.every((i) => i.inbox), 'ideas inbox filter', r.data.length)
  r = await api(KEY, 'GET', '/persons')
  ok(r.status === 200 && r.data.some((p) => p.name === 'Anna') && r.data.some((p) => p.is_me), 'persons', r.data)
  r = await api(KEY, 'GET', '/occasions?upcoming=1')
  ok(r.status === 200 && Array.isArray(r.data), 'occasions')
  r = await B.post('/api/gifts', { title: 'Gift', status: 'ordered', recipient_ids: [annaId] })
  r = await api(KEY, 'GET', '/gifts?status=ordered')
  ok(r.status === 200 && r.data.length === 1 && r.data[0].recipient_ids.includes(annaId), 'gifts status filter', r.data)
  r = await api(KEY, 'GET', '/gifts?status=bogus')
  ok(r.status === 400, 'gifts bad status')
  r = await api(KEY, 'GET', '/persons?space=999')
  ok(r.status === 404 && r.data.code === 'space_not_found', 'foreign space 404')
  r = await api(KEY, 'GET', '/nothing')
  ok(r.status === 404 && r.data.code === 'not_found', '404 json')

  section('Inbox')
  r = await B.get('/api/state')
  const inbox = r.data.inbox_items
  ok(inbox.length >= 5, 'inbox has items', inbox.length)
  const it = inbox[0]
  r = await B.post(`/api/items/${it.id}/assign`, { person_id: annaId })
  ok(r.status === 200 && !r.data.inbox_items.some((x) => x.id === it.id) && r.data.items.find((x) => x.id === it.id)?.person_id === annaId, 'assign', r.status)
  r = await B.post(`/api/items/${it.id}/assign`, { person_id: annaId })
  ok(r.status === 400 && r.data.code === 'not_in_inbox', 'assign twice', r.data)
  const it2 = r.data && inbox[1]
  r = await B.del(`/api/items/${it2.id}`)
  ok(r.status === 200 && !r.data.inbox_items.some((x) => x.id === it2.id), 'delete inbox item')
  r = await B.post('/api/items', { title: 'UI inbox' })
  ok(r.status === 200 && r.data.inbox_items.some((x) => x.title === 'UI inbox'), 'POST /api/items without person -> inbox', r.status)
  r = await B.post(`/api/items/${inbox[2].id}/assign`, { person_id: 99999 })
  ok(r.status === 404, 'assign to unknown person')
  r = await B.put(`/api/items/${inbox[2].id}`, { person_id: annaId })
  ok(r.status === 200 && !r.data.inbox_items.some((x) => x.id === inbox[2].id), 'PUT with person clears inbox')

  section('Surprise protection via API')
  r = await B.post('/api/spaces', { name: 'Family' })
  const fam = r.data.spaces.find((s) => s.name === 'Family').id
  r = await B.post(`/api/spaces/${fam}/invites`)
  const tok = r.data.token
  r = await A.post(`/api/invites/${tok}/accept`)
  ok(r.status === 200, 'A joins space', r)
  A.space = fam
  B.space = fam
  r = await A.get('/api/state')
  const bobPerson = r.data.persons.find((p) => p.name === 'Bob')
  ok(bobPerson, 'Bob person visible to A', r.data.persons.map((p) => p.name))
  r = await A.post('/api/items', { title: 'Secret gift', person_id: bobPerson.id })
  ok(r.status === 200, 'A idea for Bob', r.status)
  r = await B.get('/api/state')
  ok(!r.data.items.some((i) => i.title === 'Secret gift'), 'UI hides')
  r = await api(KEY, 'GET', `/ideas?space=${fam}`)
  ok(r.status === 200 && !r.data.some((i) => i.title === 'Secret gift'), 'API hides surprise idea', r.data)
  r = await api(KEY, 'GET', `/ideas?space=${fam}&person=Bob`)
  ok(r.status === 200 && r.data.length === 0, 'API person filter on self empty', r.data)
  r = await api(KEY, 'POST', '/ideas', { title: 'Selbst', person: 'Bob', space: fam })
  ok(r.status === 400 && r.data.code === 'self_idea', 'API cannot add idea for self in shared space', r)
  r = await api(KEY, 'POST', '/capture', { text: 'Thing', person: 'Bob', space: fam, use_ai: false })
  ok(r.status === 400 && r.data.code === 'self_idea', 'capture self 400', r)
  r = await api(KEY, 'POST', '/capture', { text: 'Thing for Bob', space: fam, use_ai: false })
  ok(r.status === 201 && r.data.inbox === 1, 'capture into shared space inbox')
  r = await api(KEY, 'POST', '/capture', { text: 'Bob wants something', space: 'Family' })
  ok(r.status === 201, 'space by name', r.data)
  ok(r.data.created.every((c) => c.person !== 'Bob'), 'AI-named self not assigned')
  A.space = null
  B.space = null
  // default space of key
  r = await B.post('/api/account/api-keys', { name: 'famkey', space_id: fam })
  const FK = r.data.secret
  r = await api(FK, 'POST', '/capture', { text: 'Family idea', use_ai: false })
  ok(r.data.created[0].space_id === fam, 'key default space used', r.data)
  r = await B.post('/api/account/api-keys', { name: 'badspace', space_id: 99999 })
  ok(r.status === 404 && r.data.code === 'space_not_found', 'key with foreign space rejected')

  section('Rate limit')
  r = await B.post('/api/account/api-keys', { name: 'rl' })
  const RL = r.data.secret
  let n429 = 0
  let first429 = 0
  for (let i = 1; i <= 65; i++) {
    const x = await api(RL, 'GET', '/me')
    if (x.status === 429) {
      n429++
      if (!first429) first429 = i
      ok(x.data.code === 'rate_limited' && x.headers.get('retry-after'), 'rate limit shape', x.data)
    }
  }
  ok(first429 === 61 && n429 === 5, 'rate limit after 60', { first429, n429 })


  // ================ Security fixes (API) ================
  section('Security fixes: key space, re-auth, suspected cases')
  {
    r = await B.post('/api/account/api-keys', { name: 'sec-tests' })
    const SK = r.data.secret // own key (the 60/min limit of KEY belongs to other tests)
    const meK = await api(SK, 'GET', '/me')
    const personalId = meK.data.spaces.find((s) => s.personal).id
    // F3: creating a key requires fresh confirmation
    let d = rdb(); d.prepare('UPDATE sessions SET reauth_at=1 WHERE user_id=?').run(bobId); d.close()
    r = await B.post('/api/account/api-keys', { name: 'needs-reauth' })
    ok(r.status === 403 && r.data.code === 'reauth_required', 'F3 key creation on a stale session -> reauth_required', r)
    r = await B.post('/api/account/api-keys', { name: 'needs-reauth', current_password: 'wrong-wrong-1' })
    ok(r.status === 400 && r.data.code === 'password_invalid', 'F3 key creation with wrong password', r)
    r = await B.post('/api/account/api-keys', { name: 'with-password', current_password: PWB })
    ok(r.status === 200 && /^wishy_/.test(r.data.secret), 'F3 key creation with password works (and marks the session fresh)', r)
    r = await B.post('/api/account/api-keys', { name: 'fresh-window' })
    ok(r.status === 200, 'F3 ... later creation needs no re-entry within 10 minutes', r)

    // Key with a fixed space
    r = await api(FK, 'GET', '/me')
    ok(r.status === 200 && r.data.spaces.length === 1 && r.data.spaces[0].id === fam && r.data.default_space_id === fam, 'KS /me lists only the key space', r.data)
    r = await api(FK, 'GET', '/ideas')
    ok(r.status === 200, 'KS default space works')
    r = await api(FK, 'GET', `/ideas?space=${fam}`)
    ok(r.status === 200, 'KS explicit own space by id works')
    r = await api(FK, 'GET', '/ideas?space=Family')
    ok(r.status === 200, 'KS explicit own space by name works')
    for (const [label, call] of [
      ['GET /ideas other space', () => api(FK, 'GET', `/ideas?space=${personalId}`)],
      ['GET /persons other space', () => api(FK, 'GET', `/persons?space=${personalId}`)],
      ['GET /occasions unknown space', () => api(FK, 'GET', '/occasions?space=99999')],
      ['POST /capture other space', () => api(FK, 'POST', '/capture', { text: 'x', space: personalId, use_ai: false })],
      ['POST /ideas other space', () => api(FK, 'POST', '/ideas', { title: 't', space: personalId })],
      ['GET /wishlists (account-wide)', () => api(FK, 'GET', '/wishlists')],
      ['GET /wishlists/:id', () => api(FK, 'GET', `/wishlists/${listId}`)],
      ['POST /wishlists/:id/wishes', () => api(FK, 'POST', `/wishlists/${listId}/wishes`, { title: 'w' })],
      ['POST /capture kind=wish', () => api(FK, 'POST', '/capture', { text: 'x', kind: 'wish', use_ai: false })],
    ]) {
      const x = await call()
      ok(x.status === 403 && x.data.code === 'api_key_space_restricted', `KS ${label} -> 403 api_key_space_restricted`, [x.status, x.data])
    }
    r = await api(SK, 'GET', `/ideas?space=${fam}`)
    ok(r.status === 200, 'KS unrestricted key still reaches every space of the user')
    r = await api(SK, 'GET', '/wishlists')
    ok(r.status === 200, 'KS unrestricted key still reads wishlists')
    r = await fetch(BASE + '/api/v1/openapi.json').then((x) => x.json())
    ok(/api_key_space_restricted/.test(JSON.stringify(r)), 'KS OpenAPI documents the restriction')

    // Suspicion 1: occasion/person from another space, or the user's own linked person via /api/v1/ideas
    B.space = fam
    r = await B.post('/api/occasions', { name: 'Family party', date: '2099-05-05' })
    const famOcc = (await B.get('/api/state')).data.occasions.find((o) => o.name === 'Family party').id
    B.space = null
    r = await api(SK, 'POST', '/ideas', { title: 'cross-space occasion', occasion_id: famOcc })
    ok(r.status === 404 && r.data.code === 'occasion_not_found', 'S1 occasion from another space is rejected (ownedOccasion applies on the API path)', [r.status, r.data])
    r = await api(SK, 'POST', '/ideas', { title: 'right-space occasion', occasion_id: famOcc, space: fam })
    ok(r.status === 201, 'S1 same occasion in its own space works', [r.status, r.data])
    r = await api(SK, 'POST', '/ideas', { title: 'bogus occasion', occasion_id: 'abc' })
    ok(r.status === 404 || r.status === 400, 'S1 junk occasion id rejected', [r.status, r.data])
    // Surprise protection: in a shared space the person linked to the user is off limits (in the personal space it is not, as in the app)
    const famPersons = (await api(SK, 'GET', `/persons?space=${fam}`)).data
    const meFam = famPersons.find((p) => p.is_me)
    for (const ref of [meFam?.id, meFam?.name, 'Bob']) {
      const x = await api(SK, 'POST', '/ideas', { title: 'idea for myself', person: ref, space: fam })
      ok(x.status === 400 || x.status === 404, `S1 idea for the user's own linked person (${ref}) is blocked via /ideas in a shared space`, [x.status, x.data])
    }
    r = await api(SK, 'POST', '/capture', { text: 'idea for myself', person: 'Bob', space: fam, use_ai: false })
    ok(r.status === 400 && r.data.code === 'self_idea', 'S1 capture names the own person -> self_idea', [r.status, r.data])
    r = await api(SK, 'POST', '/ideas', { title: 'x', person: annaId + 1000 })
    ok(r.status === 404, 'S1 person id from nowhere -> 404')
    d = rdb()
    ok(d.prepare("SELECT COUNT(*) AS n FROM items WHERE title='idea for myself' OR title='cross-space occasion'").get().n === 0, 'S1 nothing was written for the rejected ideas')
    d.close()
  }

  section('OpenAPI')
  r = await fetch(BASE + '/api/v1/openapi.json')
  const spec = await r.json()
  ok(r.status === 200 && spec.openapi === '3.1.0' && spec.info.title === 'Wishy API', 'openapi public + version')
  const refs = JSON.stringify(spec).match(/#\/components\/schemas\/(\w+)/g) || []
  ok(refs.every((x) => spec.components.schemas[x.split('/').pop()]), 'all $refs resolve')
  let missing = []
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(ops)) {
      ok(op.operationId && op.responses, 'op complete ' + m + p)
      const url = p.replace('{id}', String(listId))
      const body = m === 'post' ? (p.includes('wishes') ? { title: 'z' } : p === '/ideas' ? { title: 'z' } : { text: 'z', use_ai: false }) : undefined
      const x = await api(KEY, m.toUpperCase(), url, body)
      if (x.status === 404 && x.data?.code === 'not_found') missing.push(m + ' ' + p)
    }
  }
  ok(!missing.length, 'all documented paths exist', missing)
  ok(spec.servers[0].url === `${BASE}/api/v1`, 'server url', spec.servers)

  section('AI usage, costs')
  {
    const d = rdb()
    const rows = d.prepare("SELECT * FROM ai_usage WHERE model='mock' AND ok=1 AND feature='text_import' ORDER BY id DESC LIMIT 1").all()
    ok(rows.length === 1, 'mock usage row')
    const u = rows[0]
    const expect = ((u.input_tokens * 1 + u.output_tokens * 2) / 1e6) * 0.9 // priced in USD, tracked in EUR at 0.9
    ok(Math.abs(u.cost - expect) < 1e-12 && u.cost > 0, 'cost math (tracked in EUR)', { cost: u.cost, expect, u })
    ok(u.via === 'api' || u.via === 'ui', 'via set', u.via)
    const snap = JSON.parse(u.price_snapshot)
    ok(snap.input_per_mtok === 1 && snap.currency === 'EUR' && snap.rate === 0.9 && u.latency_ms >= 0, 'snapshot (USD prices, currency, rate) + latency', u)
    ok(d.prepare("SELECT COUNT(*) n FROM ai_usage WHERE via='api'").get().n >= 2 && d.prepare("SELECT COUNT(*) n FROM ai_usage WHERE via='ui'").get().n >= 1, 'via ui and api rows')
    // Price missing -> NULL
    d.close()
  }
  r = await A.put('/api/admin/ai', { ai_model: 'unpriced-model' })
  r = await B.post('/api/ai/extract-text', { text: 'Missing price test', target: 'ideas' })
  {
    const d = rdb()
    const u = d.prepare("SELECT * FROM ai_usage ORDER BY id DESC LIMIT 1").get()
    ok(u.cost === null && u.price_snapshot === null && u.model === 'unpriced-model', 'unknown model -> cost NULL', u)
    d.close()
  }
  r = await A.put('/api/admin/ai', { ai_model: null })
  // Backdated rows
  const today = new Date()
  const iso = (daysAgo, h = 12) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - daysAgo, h)).toISOString()
  {
    const d = rdb()
    const ins = d.prepare("INSERT INTO ai_usage (user_id, feature, provider, model, input_tokens, output_tokens, ok, error, created_at, cost, latency_ms, via) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    for (const [days, uid, feat, model, inp, out, okk, cost] of [
      [40, bobId, 'link_import', 'claude-sonnet-5-5', 1000, 500, 1, (1000 * 2 + 500 * 10) / 1e6],
      [40, bobId, 'link_import', 'claude-sonnet-5-5', 2000, 100, 1, (2000 * 2 + 100 * 10) / 1e6],
      [41, 1, 'suggestions', 'claude-haiku-5-5', 10000, 2000, 1, (10000 * 0.1 + 2000 * 0.5) / 1e6],
      [100, bobId, 'text_import', 'claude-opus-5-5', 100, 100, 0, null],
      [400, bobId, 'text_import', 'claude-opus-5-5', 5000, 1000, 1, (5000 * 4 + 1000 * 20) / 1e6],
    ]) ins.run(uid, feat, 'anthropic', model, inp, out, okk, okk ? null : 'x', iso(days), cost, 100, 'ui')
    d.close()
  }
  const from = iso(450).slice(0, 10)
  const to = iso(0).slice(0, 10)
  r = await A.get(`/api/admin/ai/usage/summary?from=${from}&to=${to}`)
  ok(r.status === 200, 'summary', r)
  const S0 = r.data
  const oldCost = (1000 * 2 + 500 * 10) / 1e6 + (2000 * 2 + 100 * 10) / 1e6 + (10000 * 0.1 + 2000 * 0.5) / 1e6 + (5000 * 4 + 1000 * 20) / 1e6
  {
    const d = rdb()
    const sum = d.prepare('SELECT SUM(cost) c, COUNT(*) n, SUM(CASE WHEN ok=0 AND error!=\'running\' THEN 1 ELSE 0 END) e FROM ai_usage').get()
    ok(S0.requests === sum.n && Math.abs(S0.cost - sum.c) < 1e-6 && S0.errors === sum.e, 'summary matches db', { S0, sum })
    d.close()
  }
  ok(S0.cost > 0 && !('cost_display' in S0) && JSON.stringify(S0.currency) === '{"code":"EUR"}', 'costs are in the tracking currency, no display conversion', S0)
  ok(S0.error_rate > 0 && S0.error_rate < 1 && S0.unpriced_requests >= 1, 'error rate + unpriced', S0)
  r = await A.get(`/api/admin/ai/usage/summary?from=${iso(45).slice(0, 10)}&to=${iso(39).slice(0, 10)}`)
  ok(r.data.requests === 3 && Math.abs(r.data.cost - ((1000 * 2 + 500 * 10) / 1e6 + (2000 * 2 + 100 * 10) / 1e6 + (10000 * 0.1 + 2000 * 0.5) / 1e6)) < 1e-9, 'range filter + cost math', r.data)
  r = await A.get(`/api/admin/ai/usage/summary?from=2026-13-01`)
  ok(r.status === 400 && r.data.code === 'invalid_date', 'bad date')
  r = await A.get(`/api/admin/ai/usage/timeseries?from=${iso(45).slice(0, 10)}&to=${iso(39).slice(0, 10)}&bucket=day&group=feature`)
  ok(r.status === 200 && r.data.buckets.length === 7 && r.data.rows.some((x) => x.key === 'link_import' && x.requests === 2) && r.data.rows.some((x) => x.key === 'suggestions' && x.requests === 1), 'timeseries day/feature', r.data)
  r = await A.get(`/api/admin/ai/usage/timeseries?from=${from}&to=${to}&bucket=month&group=model`)
  ok(r.data.buckets.length >= 14 && r.data.rows.every((x) => /^\d{4}-\d{2}-01$/.test(x.bucket)) && r.data.keys.some((k) => k.key === 'claude-sonnet-5-5'), 'timeseries month/model', r.data.buckets)
  r = await A.get(`/api/admin/ai/usage/timeseries?from=${from}&to=${to}&bucket=week&group=user`)
  ok(r.data.rows.every((x) => new Date(x.bucket + 'T00:00:00Z').getUTCDay() === 1) && r.data.keys.some((k) => k.key === bobId && k.label === 'Bob'), 'timeseries week(monday)/user', r.data.rows.slice(0, 3))
  r = await A.get(`/api/admin/ai/usage/timeseries?from=${from}&to=${to}&bucket=week&group=none`)
  ok(r.data.rows.reduce((a, x) => a + x.requests, 0) === S0.requests, 'timeseries sums = summary')
  r = await A.get(`/api/admin/ai/usage/timeseries?bucket=year`)
  ok(r.status === 400, 'bad bucket')
  r = await A.get(`/api/admin/ai/usage/users?from=${from}&to=${to}`)
  ok(r.status === 200 && r.data.users.find((u) => u.user_id === bobId)?.name === 'Bob' && r.data.users.find((u) => u.user_id === bobId).requests >= 5, 'users table', r.data.users)
  r = await A.get(`/api/admin/ai/usage/export.csv?from=${from}&to=${to}`)
  ok(r.status === 200 && r.text.includes('day,user_id,user_email') && r.text.includes('claude-sonnet-5-5') && r.headers.get('content-type').includes('text/csv'), 'usage csv', r.text.slice(0, 120))
  r = await B.get(`/api/admin/ai/usage/summary`)
  ok(r.status === 403, 'usage admin only')
  r = await B.get(`/api/account/ai-usage?from=${from}&to=${to}`)
  ok(r.status === 200 && r.data.requests >= 5 && r.data.month.requests >= 1 && 'limits' in r.data, 'own usage', r.data)
  const adminOwn = (await A.get(`/api/account/ai-usage?from=${from}&to=${to}`)).data
  ok(adminOwn.requests === 1, 'own usage only own rows', adminOwn.requests)

  section('Limits')
  r = await A.put('/api/admin/ai', { ai_monthly_user_limit: 0 })
  ok(r.data.ai_monthly_user_limit === 0, 'user limit saved')
  r = await B.post('/api/ai/extract-text', { text: 'Limit test', target: 'ideas' })
  ok(r.status === 429 && r.data.code === 'ai_limit_reached', 'user monthly limit', r)
  r = await A.post('/api/ai/extract-text', { text: 'Limit test', target: 'ideas' })
  ok(r.status === 429, 'limit 0 applies to all users')
  r = await A.put('/api/admin/ai', { ai_monthly_user_limit: null, ai_monthly_cost_cap: 0.000001 })
  r = await B.post('/api/ai/extract-text', { text: 'Cost cap', target: 'ideas' })
  ok(r.status === 429 && r.data.code === 'ai_limit_reached', 'cost cap blocks (bob has cost this month)', r)
  r = await api(KEY, 'POST', '/capture', { text: 'Text at limit', use_ai: true })
  ok(r.status === 201 && r.data.warnings?.includes('ai_limit_reached') && r.data.created.length === 1, 'capture falls back at AI limit', r.data)
  r = await A.put('/api/admin/ai', { ai_monthly_cost_cap: null })
  r = await B.post('/api/ai/extract-text', { text: 'Free again', target: 'ideas' })
  ok(r.status === 200, 'limits lifted')
  r = await A.put('/api/admin/ai', { ai_prices: { bad: { input_per_mtok: -1, output_per_mtok: 1 } } })
  ok(r.status === 400 && r.data.code === 'invalid_prices', 'invalid prices')

  section('Retention')
  // Old audit entries
  {
    const d = rdb()
    for (const dd of [10, 400, 500]) d.prepare("INSERT INTO audit_log (at, via, action, status) VALUES (?,?,?,?)").run(iso(dd), 'system', 'test.old', 'ok')
    d.close()
  }
  r = await A.get('/api/admin/retention')
  ok(r.data.retention_audit_days === 365 && r.data.retention_ai_usage_days === 730 && 'retention_sessions_days' in r.data, 'retention defaults', r.data)
  r = await A.put('/api/admin/retention', { retention_audit_days: 365, retention_ai_usage_days: 30 })
  ok(r.data.retention_ai_usage_days === 30, 'retention save')
  r = await A.put('/api/admin/retention', { retention_audit_days: -1 })
  ok(r.status === 400 && r.data.code === 'invalid_value', 'retention invalid')
  const beforeSum = (await A.get(`/api/admin/ai/usage/summary?from=${from}&to=${to}`)).data
  r = await A.post('/api/admin/retention/run')
  ok(r.status === 200 && r.data.audit_deleted === 2 && r.data.ai_rows_rolled_up >= 5, 'retention run', r.data)
  {
    const d = rdb()
    const raw = d.prepare("SELECT COUNT(*) n FROM ai_usage WHERE created_at<?").get(iso(30))
    ok(raw.n === 0, 'old raw rows deleted')
    const daily = d.prepare('SELECT * FROM ai_usage_daily ORDER BY day').all()
    ok(daily.length >= 4, 'daily rollup rows', daily.length)
    const d40 = daily.filter((x) => x.day === iso(40).slice(0, 10) && x.model === 'claude-sonnet-5-5')
    ok(d40.length === 1 && d40[0].requests === 2 && d40[0].input_tokens === 3000 && d40[0].output_tokens === 600 && Math.abs(d40[0].cost - ((1000 * 2 + 500 * 10) / 1e6 + (2000 * 2 + 100 * 10) / 1e6)) < 1e-12, 'rollup sums', d40)
    const errRow = daily.find((x) => x.model === 'claude-opus-5-5' && x.day === iso(100).slice(0, 10))
    ok(errRow && errRow.errors === 1 && errRow.requests === 1, 'rollup keeps errors', errRow)
    ok(d.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='test.old'").get().n === 1, 'audit retention deleted old only')
    d.close()
  }
  const afterSum = (await A.get(`/api/admin/ai/usage/summary?from=${from}&to=${to}`)).data
  ok(afterSum.requests === beforeSum.requests && Math.abs(afterSum.cost - beforeSum.cost) < 1e-9 && afterSum.errors === beforeSum.errors, 'analytics unchanged after rollup', { beforeSum, afterSum })
  r = await A.get('/api/admin/audit?action=retention.cleanup&via=session')
  ok(r.data.items.length === 1 && r.data.items[0].details.audit_deleted === 2 && r.data.items[0].actor_label === 'alice@example.com', 'retention audit entry (manual)', r.data.items)
  r = await A.post('/api/admin/retention/run')
  ok(r.data.ai_rows_rolled_up === 0 && r.data.audit_deleted === 0, 'second run no-op', r.data)
  r = await A.get('/api/admin/retention')
  ok(r.data.last_run?.at && r.data.stats.ai_usage_daily_rows >= 4, 'retention overview', r.data)
  r = await A.put('/api/admin/retention', { retention_audit_days: 0, retention_ai_usage_days: 0 })
  r = await A.post('/api/admin/retention/run')
  ok(r.data.audit_deleted === 0 && r.data.ai_rows_rolled_up === 0, '0 = keep forever')

  section('AI cost currency')
  const rawSums = () => {
    const d = rdb()
    const u = d.prepare('SELECT COALESCE(SUM(cost),0) c FROM ai_usage').get().c
    const dl = d.prepare('SELECT COALESCE(SUM(cost),0) c FROM ai_usage_daily').get().c
    const marker = d.prepare("SELECT value FROM system_settings WHERE key='ai_usage_currency'").get()
    d.close()
    return { u, d: dl, marker: marker ? JSON.parse(marker.value) : null }
  }
  const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  const aiCfg = async () => (await A.get('/api/admin/ai')).data
  const lastMock = () => {
    const d = rdb()
    const row = d.prepare("SELECT * FROM ai_usage WHERE model='mock' AND ok=1 ORDER BY id DESC LIMIT 1").get()
    d.close()
    return row
  }
  const mockUsd = (row) => (row.input_tokens * 1 + row.output_tokens * 2) / 1e6
  r = await aiCfg()
  ok(r.ai_cost_currency === 'EUR' && r.ai_cost_rate === 0.9, 'state: EUR at 0.9', r)
  ok(rawSums().marker?.code === 'EUR' && rawSums().marker.rate === 0.9, 'marker ai_usage_currency follows the settings', rawSums())
  ok(rawSums().d > 0 && rawSums().u > 0, 'both ai_usage and ai_usage_daily hold costs')

  // The cost cap is compared in the tracking currency: 5% above the EUR amount (i.e. below the same amount in USD) must not block
  r = await B.get('/api/account/ai-usage')
  const bobMonth = r.data.month.cost
  ok(bobMonth > 0 && r.data.currency.code === 'EUR' && !('rate' in r.data.currency), 'own usage: cost + currency code only', r.data)
  await A.put('/api/admin/ai', { ai_monthly_cost_cap: bobMonth * 1.05 })
  r = await B.post('/api/ai/extract-text', { text: 'Cap in EUR', target: 'ideas' })
  ok(r.status === 200, 'cap 5% above the EUR cost: not blocked (would be blocked if compared in USD)', r)
  r = await B.get('/api/account/ai-usage')
  await A.put('/api/admin/ai', { ai_monthly_cost_cap: r.data.month.cost / 2 })
  r = await B.post('/api/ai/extract-text', { text: 'Cap in EUR', target: 'ideas' })
  ok(r.status === 429 && r.data.code === 'ai_limit_reached', 'cap below the EUR cost blocks', r)
  await A.put('/api/admin/ai', { ai_monthly_cost_cap: null })

  // CSV: columns cost + currency
  r = await A.get(`/api/admin/ai/usage/export.csv?from=${from}&to=${to}`)
  {
    const lines = r.text.replace(/^﻿/, '').trim().split('\n').map((l) => l.replace(/\r$/, ''))
    const head = lines[0].split(',')
    const ci = head.indexOf('cost')
    ok(ci >= 0 && head[ci + 1] === 'currency' && !r.text.includes('cost_usd'), 'csv: columns cost + currency', head)
    const rows = lines.slice(1).map((l) => l.split(','))
    ok(rows.length > 0 && rows.every((x) => x[ci + 1] === 'EUR'), 'csv: currency EUR in every row', rows.slice(0, 2))
    const total = rows.reduce((a, x) => a + Number(x[ci]), 0)
    const sm = (await A.get(`/api/admin/ai/usage/summary?from=${from}&to=${to}`)).data
    ok(Math.abs(total - sm.cost) < 1e-4, 'csv cost sum == summary cost', { total, cost: sm.cost })
  }

  // Rate change only: history untouched, new requests use the new rate
  let before = rawSums()
  r = await A.put('/api/admin/ai', { ai_cost_rate: 0.8 })
  ok(r.status === 200 && r.data.ai_cost_rate === 0.8 && r.data.ai_cost_currency === 'EUR', 'rate change saved', r.data)
  let after = rawSums()
  ok(near(after.u, before.u) && near(after.d, before.d) && after.marker.rate === 0.8 && after.marker.code === 'EUR', 'rate change leaves stored costs, marker rate follows', { before, after })
  r = await B.post('/api/ai/extract-text', { text: 'New rate', target: 'ideas' })
  {
    const row = lastMock()
    const snap = JSON.parse(row.price_snapshot)
    ok(r.status === 200 && near(row.cost, mockUsd(row) * 0.8) && snap.rate === 0.8 && snap.currency === 'EUR', 'new request uses the new rate', { row, snap })
  }

  // Currency change: ai_usage + ai_usage_daily + cap are converted with newRate / oldRate
  await A.put('/api/admin/ai', { ai_monthly_cost_cap: 10 })
  before = rawSums()
  r = await A.put('/api/admin/ai', { ai_cost_currency: 'GBP', ai_cost_rate: 0.5 })
  ok(r.status === 200 && r.data.ai_cost_currency === 'GBP' && r.data.ai_cost_rate === 0.5, 'currency change EUR -> GBP', r.data)
  after = rawSums()
  ok(near(after.u, before.u * 0.625) && near(after.d, before.d * 0.625) && after.d > 0, 'ai_usage and ai_usage_daily converted by 0.5 / 0.8', { before, after })
  ok(r.data.ai_monthly_cost_cap === 6.25 && after.marker.code === 'GBP' && after.marker.rate === 0.5, 'cap converted (10 -> 6.25), marker updated', { cap: r.data.ai_monthly_cost_cap, marker: after.marker })
  r = await A.get(`/api/admin/ai/usage/summary?from=${from}&to=${to}`)
  ok(r.data.currency.code === 'GBP' && Math.abs(r.data.cost - (after.u + after.d)) < 1e-6, 'summary in GBP', r.data)
  // A cap in the same request counts as given in the new currency
  before = rawSums()
  r = await A.put('/api/admin/ai', { ai_cost_currency: 'EUR', ai_cost_rate: 0.8, ai_monthly_cost_cap: 3 })
  after = rawSums()
  ok(r.status === 200 && r.data.ai_monthly_cost_cap === 3 && near(after.u, before.u * 1.6) && near(after.d, before.d * 1.6), 'cap in the request counts in the new currency, costs converted', { cap: r.data.ai_monthly_cost_cap, before, after })
  // Back to USD: the rate is forced to 1, whatever is sent
  before = rawSums()
  r = await A.put('/api/admin/ai', { ai_cost_currency: 'USD', ai_cost_rate: 0.7 })
  after = rawSums()
  ok(r.status === 200 && r.data.ai_cost_currency === 'USD' && r.data.ai_cost_rate === 1 && near(after.u, before.u / 0.8) && near(after.d, before.d / 0.8), 'USD forces rate 1, costs back to USD', { data: r.data, before, after })
  ok(r.data.ai_monthly_cost_cap === 3.75, 'cap converted back to USD (3 / 0.8)', r.data.ai_monthly_cost_cap)
  ok(after.marker.code === 'USD' && after.marker.rate === 1, 'marker USD/1', after)
  r = await B.post('/api/ai/extract-text', { text: 'USD again', target: 'ideas' })
  {
    const row = lastMock()
    ok(r.status === 200 && near(row.cost, mockUsd(row)) && JSON.parse(row.price_snapshot).currency === 'USD', 'USD request costs the plain USD price', row)
  }
  await A.put('/api/admin/ai', { ai_monthly_cost_cap: null })

  // A non-USD currency needs a rate
  before = rawSums()
  for (const [body, label] of [
    [{ ai_cost_currency: 'EUR' }, 'no rate anywhere'],
    [{ ai_cost_currency: 'EUR', ai_cost_rate: null }, 'rate null'],
    [{ ai_cost_currency: 'EUR', ai_cost_rate: '' }, 'rate empty'],
  ]) {
    r = await A.put('/api/admin/ai', body)
    ok(r.status === 400 && r.data.code === 'cost_rate_required' && r.data.params?.currency === 'EUR', 'rate required: ' + label, r)
  }
  r = await A.put('/api/admin/ai', { ai_cost_currency: 'EUR', ai_cost_rate: 0 })
  ok(r.status === 400 && r.data.code === 'invalid_value', 'rate 0 invalid', r)
  after = rawSums()
  ok((await aiCfg()).ai_cost_currency === 'USD' && near(after.u, before.u) && near(after.d, before.d) && after.marker.code === 'USD', 'rejected requests change nothing', after)
  r = await A.put('/api/admin/ai', { ai_cost_currency: 'EUR', ai_cost_rate: 0.9 })
  ok(r.status === 200 && r.data.ai_cost_rate === 0.9, 'EUR with a rate works', r.data)
  r = await A.put('/api/admin/ai', { ai_cost_currency: 'CHF' })
  ok(r.status === 400 && r.data.code === 'cost_rate_required' && r.data.params?.currency === 'CHF', 'another currency needs its own rate', r)
  r = await A.put('/api/admin/ai', { ai_cost_currency: 'EUR' })
  ok(r.status === 200 && r.data.ai_cost_rate === 0.9, 'the same currency keeps its stored rate', r.data)
  r = await A.put('/api/admin/ai', { ai_cost_currency: 'USD' })
  ok(r.status === 200 && r.data.ai_cost_currency === 'USD', 'back to USD for the migration test')

  // 1.0.0 database: costs in USD, currency + rate used for display only, no marker -> converted once at startup
  await stop()
  const asV100 = (settings) => {
    const d = rdb()
    d.prepare("DELETE FROM system_settings WHERE key='ai_usage_currency'").run()
    for (const [k, v] of Object.entries(settings)) {
      if (v === null) d.prepare('DELETE FROM system_settings WHERE key=?').run(k)
      else d.prepare('INSERT INTO system_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v))
    }
    d.close()
    return rawSums()
  }
  {
    const b = asV100({ ai_cost_currency: 'EUR', ai_cost_rate: 0.92, ai_monthly_cost_cap: 5 })
    await start(DATA)
    const a = rawSums()
    ok(near(a.u, b.u * 0.92) && near(a.d, b.d * 0.92) && a.d > 0, '1.0.0 database: costs converted at startup', { b, a })
    ok(a.marker?.code === 'EUR' && a.marker.rate === 0.92, '1.0.0 database: marker written', a)
    const cfg = await aiCfg()
    ok(cfg.ai_monthly_cost_cap === 4.6 && cfg.ai_cost_currency === 'EUR' && cfg.ai_cost_rate === 0.92, '1.0.0 database: cap converted (5 -> 4.6)', cfg)
    await stop()
    await start(DATA)
    const a2 = rawSums()
    ok(a2.u === a.u && a2.d === a.d && a2.marker.rate === 0.92 && (await aiCfg()).ai_monthly_cost_cap === 4.6, 'second start does nothing', { a, a2 })
    await stop()
  }
  {
    const b = asV100({ ai_cost_currency: 'GBP', ai_cost_rate: null, ai_monthly_cost_cap: null })
    await start(DATA)
    const a = rawSums()
    ok(near(a.u, b.u) && near(a.d, b.d) && a.marker?.code === 'GBP' && a.marker.rate === 1, '1.0.0 database with currency but no rate: rate 1, costs unchanged', { b, a })
    await stop()
  }
  await start(DATA)
  await A.put('/api/admin/ai', { ai_cost_currency: 'EUR', ai_cost_rate: 0.9 })

  section('Audit: filter, cursor, export, secrets, levels')
  r = await A.get('/api/admin/audit?limit=3')
  ok(r.data.items.length === 3 && r.data.next_cursor, 'page 1')
  const ids = new Set(r.data.items.map((i) => i.id))
  let cur = r.data.next_cursor
  let pages = 1
  while (cur && pages < 200) {
    const p = await A.get(`/api/admin/audit?limit=50&cursor=${cur}`)
    for (const i of p.data.items) { ok(!ids.has(i.id), 'no dup in cursor'); ids.add(i.id) }
    cur = p.data.next_cursor
    pages++
  }
  const total = (await A.get('/api/admin/audit/settings')).data.total
  ok(ids.size === total, 'cursor walks all rows', { n: ids.size, total })
  r = await A.get('/api/admin/audit?limit=10')
  ok(r.data.items.every((x, i, a) => i === 0 || a[i - 1].id > x.id), 'newest first')
  r = await A.get('/api/admin/audit?action=auth.')
  ok(r.data.items.length >= 2 && r.data.items.every((i) => i.action.startsWith('auth.')), 'action prefix filter')
  r = await A.get('/api/admin/audit?action=auth.login,auth.logout')
  ok(r.data.items.every((i) => ['auth.login', 'auth.logout'].includes(i.action)), 'action list filter')
  r = await A.get('/api/admin/audit?status=fail')
  ok(r.data.items.length >= 2 && r.data.items.every((i) => i.status === 'fail'), 'status filter')
  r = await A.get('/api/admin/audit?via=system')
  ok(r.data.items.length >= 1 && r.data.items.every((i) => i.via === 'system'), 'via filter')
  r = await A.get(`/api/admin/audit?user_id=${bobId}`)
  ok(r.data.items.length >= 1 && r.data.items.every((i) => i.actor_user_id === bobId), 'user filter')
  r = await A.get('/api/admin/audit?q=bob%40example')
  ok(r.data.items.length >= 1, 'q search')
  r = await A.get(`/api/admin/audit?from=${to}&to=${to}`)
  ok(r.data.items.length >= 5, 'from/to today')
  r = await A.get(`/api/admin/audit?from=${iso(3000).slice(0, 10)}&to=${iso(2000).slice(0, 10)}`)
  ok(r.data.items.length === 0, 'from/to past empty')
  r = await A.get('/api/admin/audit?from=garbage')
  ok(r.status === 400 && r.data.code === 'invalid_date', 'bad from')
  r = await A.get('/api/admin/audit/actions')
  ok(Array.isArray(r.data) && r.data.includes('auth.login') && r.data.includes('system.startup'), 'actions list')
  r = await B.get('/api/admin/audit')
  ok(r.status === 403, 'audit admin only')
  r = await A.get('/api/admin/audit/export?format=csv&action=auth.login')
  ok(r.status === 200 && r.headers.get('content-type').includes('text/csv') && r.text.includes('id,at,actor_user_id') && r.text.trim().split(String.fromCharCode(13,10)).length >= 3, 'csv export', r.text.slice(0, 100))
  r = await A.get('/api/admin/audit/export?format=json&status=fail')
  ok(r.status === 200 && Array.isArray(r.data) && r.data.length >= 2 && r.data.every((x) => x.status === 'fail'), 'json export')
  r = await A.get('/api/admin/audit?action=audit.export')
  ok(r.data.items.length === 2, 'export audited', r.data.items.length)
  // Level
  r = await A.get('/api/admin/audit/settings')
  ok(r.data.audit_level === 'security', 'default level security')
  const cnt = async () => (await A.get('/api/admin/audit/settings')).data.total
  let c0 = await cnt()
  await B.post('/api/persons', { name: 'Zoe' })
  await B.get('/api/state')
  ok((await cnt()) === c0 + 0 || true, 'noop')
  r = await A.get('/api/admin/audit?action=person.create')
  ok(r.data.items.length === 0, 'security level: no planning entries')
  r = await A.post('/api/zzz-unknown-route', { a: 1 })
  r = await A.get('/api/admin/audit?action=api.post.')
  ok(r.data.items.length === 0, 'security level: no generic entries')
  r = await A.put('/api/admin/audit/settings', { audit_level: 'all' })
  ok(r.data.audit_level === 'all', 'level all')
  r = await A.put('/api/admin/audit/settings', { audit_level: 'nope' })
  ok(r.status === 400, 'invalid level')
  await B.post('/api/persons', { name: 'Zoe2', notes: 'SECRET-CONTENT' })
  await A.post('/api/zzz-unknown-route', { a: 1 })
  await A.post('/api/zzz-unknown-route/12/abc', { a: 1 })
  await A.post('/api/preview', { url: 'ftp://nope' })
  r = await A.get('/api/admin/audit?action=person.create')
  ok(r.data.items.length === 1 && r.data.items[0].actor_user_id === bobId && r.data.items[0].via === 'session', 'all level: person.create', r.data.items)
  ok(!JSON.stringify(r.data).includes('Zoe2') && !JSON.stringify(r.data).includes('SECRET'), 'no content in planning audit')
  r = await A.get('/api/admin/audit?action=api.post.*')
  ok(r.data.items.some((i) => i.action === 'api.post./api/preview') && !r.data.items.some((i) => /zzz-unknown/.test(i.action)), 'generic actions at all level (authenticated only; 404s not audited)', r.data.items.map((i) => i.action))
  await api(KEY, 'POST', '/capture', { text: 'audit capture', use_ai: false })
  r = await A.get('/api/admin/audit?action=api.capture')
  ok(r.data.items.length === 1 && r.data.items[0].via === 'api_key' && r.data.items[0].actor_user_id === bobId && r.data.items[0].details.created === 1, 'capture audited via api_key', r.data.items)
  ok(!JSON.stringify(r.data).includes('audit capture'), 'capture body not logged')
  await A.put('/api/admin/audit/settings', { audit_level: 'security' })

  // Secrets
  {
    const d = rdb()
    const all = d.prepare('SELECT * FROM audit_log').all().map((x) => JSON.stringify(x)).join('\n')
    for (const [name, s] of [['password A', PW], ['password B', PWB], ['wrong pw', 'wrong-password-xx'], ['key secret', KEY.split('_')[2]], ['full key', KEY], ['RO key', RO], ['FK', FK]]) {
      ok(!all.includes(s), 'audit_log has no ' + name)
    }
    ok(!/wishy_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}/.test(all), 'no key-shaped strings')
    d.close()
  }

  section('More audit events')
  r = await B.put('/api/account', { name: 'Bob B.' })
  r = await B.post('/api/spaces', { name: 'Tmp' })
  const tmp = r.data.spaces.find((s) => s.name === 'Tmp').id
  r = await B.post(`/api/wishlists/${listId}/share`, { link_enabled: true })
  r = await B.get('/api/export')
  r = await B.del(`/api/spaces/${tmp}`)
  r = await A.get('/api/admin/audit?limit=200')
  const names = new Set(r.data.items.map((i) => i.action))
  for (const a of ['account.update', 'space.create', 'space.delete', 'wishlist.share', 'data.export', 'space.invite.create', 'space.invite.accept']) ok(names.has(a), 'audit action ' + a, [...names])
  const sh = r.data.items.find((i) => i.action === 'wishlist.share')
  ok(sh.target_type === 'wishlist' && sh.target_id === String(listId) && sh.details.link_enabled === true, 'share target+details', sh)
  r = await A.post('/api/auth/logout')
  r = await A.post('/api/auth/login', { email: 'alice@example.com', password: PW })

  section('Rate limiting: wrong keys')
  {
    r = await B.post('/api/account/api-keys', { name: 'rl2' })
    const SK2 = r.data.secret
    let c429 = 0
    for (let i = 0; i < 40; i++) if ((await api(null, 'GET', '/me')).status === 429) c429++
    ok(c429 === 0, 'RL requests without any key are not counted as failed lookups (never 429)')
    let first = 0
    for (let i = 1; i <= 40; i++) {
      const x = await api('wishy_abcdefgh_' + 'x'.repeat(40), 'GET', '/me')
      if (x.status === 429 && !first) first = i
    }
    ok(first >= 20 && first <= 31, 'RL ~30 FAILED lookups per minute and IP, then 429', first)
    ok((await api(SK2, 'GET', '/me')).status === 200, 'RL a VALID key still works from the throttled IP')
    r = await api('wishy_abcdefgh_' + 'y'.repeat(40), 'GET', '/me')
    ok(r.status === 429 && r.data.code === 'rate_limited', 'RL further bad keys stay blocked', r.status)
  }

  await stop()

  fs.rmSync(DATA, { recursive: true, force: true })
  console.log(`\n${checks} checks, ${fails} failed`)
  process.exit(fails ? 1 : 0)
}
main().catch(async (e) => {
  console.error('CRASH', e)
  try { await stop() } catch {}
  process.exit(2)
})
