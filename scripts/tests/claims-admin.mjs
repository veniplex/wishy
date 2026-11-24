// Admin > Reservations and IP logging: claims list/export/release for admins, surprise protection for admins who own the list
// (hidden in the claims list, audit list/search/filters/counts/export; reveal is explicit and audited), 403 for non-admins, default audit
// level, IP (and device) on a sample of activities of every module, offline-replay without double entries, IP anonymisation (retention),
// CSV formula injection, flood protection for successful anonymous actions, per-user sessions, and (guest identities) guest codes in the
// claims list / filter / export, the guest view, masking of guests and of the new audit actions for the owner-admin, deleting reservations
// (several at once, planned gifts, own lists) and guests, retention of guest IPs.
// Written against the contract: claims/releases are audited as wish.reserve / wish.unreserve with target {wish, id, label} and details
// {wishlist_id, wishlist_title, owner_user_id, guest_name?, reservation_id}; the checks also pass with the plain route fallback entries.
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.SMOKE_PORT) || 3621
const BASE = `http://127.0.0.1:${PORT}`
const DATA = path.join(os.tmpdir(), 'wishy-claims-' + Date.now())
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
const start = (env = {}) => new Promise((resolve, reject) => {
  server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), PREVIEW_BROWSER: 'off', TRUST_PROXY: '1', ...env } })
  let out = ''
  server.stdout.on('data', (d) => { out += d; if (out.includes('running')) resolve() })
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))
  server.on('exit', (c) => reject(new Error('server exit ' + c)))
})
const stop = () => new Promise((r) => { server.removeAllListeners('exit'); server.on('exit', r); server.kill() })

/** A client with its own IP (sent as X-Forwarded-For; the server trusts one proxy hop in this test). */
class Client {
  constructor(ip, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36') { this.ip = ip; this.ua = ua; this.cookies = {} }
  async req(method, url, body, headers = {}) {
    const h = { 'X-Forwarded-For': this.ip, 'User-Agent': this.ua, ...headers }
    if (body !== undefined && typeof body !== 'string') h['Content-Type'] = 'application/json'
    else if (method !== 'GET' && !h['Content-Type']) h['X-Requested-With'] = 'x'
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

const rdb = () => {
  const d = new DatabaseSync(path.join(DATA, 'wishlist.db'))
  d.exec('PRAGMA busy_timeout=5000')
  return d
}
const PW = 'S3cret-Passw0rd!'
const IP = { A: '198.51.100.1', B: '198.51.100.2', C: '198.51.100.11', D: '198.51.100.4', HANNA: '198.51.100.21', VERA: '198.51.100.22', C2: '198.51.100.12' }

async function main() {
  await start()
  const A = new Client(IP.A)
  const B = new Client(IP.B)
  const C = new Client(IP.C, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1.15')
  const D = new Client(IP.D)
  const HANNA = new Client(IP.HANNA)
  const VERA = new Client(IP.VERA)

  section('Setup and default audit level')
  let r = await A.post('/api/auth/setup', { name: 'Alice Admin', email: 'alice@example.com', password: PW })
  ok(r.status === 200, 'setup', r)
  const aliceId = r.data.user?.id ?? (await A.get('/api/auth/me')).data.user.id
  r = await A.get('/api/admin/audit/settings')
  ok(r.data.audit_level === 'all' && r.data.audit_level_stored === false, 'default level is "all" when never chosen', r.data)
  const mk = async (name, email, role = 'user') => (await A.post('/api/admin/users', { name, email, password: PW, role })).data.user.id
  const bobId = await mk('Bob', 'bob@example.com')
  const carlId = await mk('Carl', 'carl@example.com')
  const dianaId = await mk('Diana', 'diana@example.com', 'admin')
  for (const [c, e] of [[B, 'bob@example.com'], [C, 'carl@example.com'], [D, 'diana@example.com']]) ok((await c.post('/api/auth/login', { email: e, password: PW })).status === 200, 'login ' + e)

  section('Lists and claims (A = admin AND list owner, B = owner, C = signed-in claimer, guests)')
  const mkList = async (client, title, wishes) => {
    const l = (await client.post('/api/wishlists', { title })).data
    await client.post(`/api/wishlists/${l.id}/share`, { link_enabled: true })
    const ids = []
    for (const w of wishes) ids.push((await client.post(`/api/wishlists/${l.id}/wishes`, { title: w })).data.wishes.find((x) => x.title === w).id)
    return { ...l, ids }
  }
  const LA = await mkList(A, 'Alice list', ['Secret telescope', 'Secret scarf', 'Secret mug'])
  const LB = await mkList(B, 'Bob list', ['=HYPERLINK("http://evil.example","x")', 'Bob book', 'Bob lamp', 'Bob globe'])
  const [a1, a2, a3] = LA.ids
  const [b1, b2, b3, b4] = LB.ids
  ok((await C.post(`/api/wishes/${a1}/reserve`, { token: LA.token })).status === 200, 'C claims a1 on the admin list')
  ok((await HANNA.post(`/api/wishes/${a2}/reserve`, { token: LA.token, guest_name: 'Hidden Hanna' })).status === 200, 'guest Hanna claims a2 on the admin list')
  ok((await HANNA.del(`/api/wishes/${a2}/reserve`, {})).status !== 500, 'Hanna releases (or not allowed without body) - no crash')
  r = await HANNA.req('DELETE', `/api/wishes/${a2}/reserve`, { token: LA.token, guest_name: 'Hidden Hanna' })
  ok(r.status === 200, 'Hanna releases a2', r)
  ok((await C.post(`/api/wishes/${a3}/reserve`, { token: LA.token, plan: true })).status === 200, 'C claims a3 with plan (creates a gift)')
  ok((await C.post(`/api/wishes/${b1}/reserve`, { token: LB.token })).status === 200, 'C claims b1 (formula-like title) on Bob list')
  ok((await VERA.post(`/api/wishes/${b2}/reserve`, { token: LB.token, guest_name: '=cmd|Vera' })).status === 200, 'guest Vera claims b2 (formula-like name)')
  const gift = (await C.get('/api/state')).data.gifts?.find((g) => g.title === 'Secret mug')
  if (gift) ok((await C.put(`/api/gifts/${gift.id}`, { title: 'Secret mug (blue)' })).status === 200, 'C edits the planned gift')

  section('Non-admins get 403')
  for (const [m, u] of [['GET', '/api/admin/claims'], ['GET', '/api/admin/claims/export'], ['POST', `/api/admin/claims/1/release`], ['GET', `/api/admin/users/${carlId}/sessions`], ['GET', '/api/admin/audit']]) {
    r = await B.req(m, u, m === 'POST' ? {} : undefined)
    ok(r.status === 403, `${m} ${u} -> 403 for a normal user`, r.status)
  }
  r = await new Client('203.0.113.99').get('/api/admin/claims')
  ok(r.status === 401, 'anonymous -> 401')

  section('Reservations: other admin sees everything incl. IP, device, guest flag')
  r = await D.get('/api/admin/claims?limit=100')
  ok(r.status === 200 && r.data.hidden_own === 0, 'Diana owns nothing: nothing hidden', r.data)
  const rowsD = r.data.items
  const rowA1 = rowsD.find((x) => x.wish_title === 'Secret telescope')
  ok(rowA1 && rowA1.state === 'active' && rowA1.claimed_by?.name === 'Carl' && rowA1.guest === false && rowA1.owner?.name === 'Alice Admin' && rowA1.list_title === 'Alice list', 'active claim of a user shown', rowA1)
  ok(rowA1 && (rowA1.ip === null || rowA1.ip === IP.C) && (rowA1.device === null || /iOS/.test(rowA1.device)), 'IP/device of the claim (when schema 4 columns are filled)', rowA1)
  const rowHanna = rowsD.find((x) => x.guest_name === 'Hidden Hanna')
  ok(rowHanna && rowHanna.guest === true && rowHanna.state === 'released' && rowHanna.claimed_by === null, 'released guest claim from the audit log, flagged as guest', rowHanna)
  ok(rowsD.some((x) => x.guest && x.guest_name === '=cmd|Vera' && x.state === 'active'), 'active guest claim')
  r = await D.get('/api/admin/claims?state=active&by=guest')
  ok(r.data.items.length === 1 && r.data.items[0].guest_name === '=cmd|Vera', 'filter active + guest', r.data)
  r = await D.get(`/api/admin/claims?owner_id=${bobId}`)
  ok(r.data.items.length === 2 && r.data.items.every((x) => x.owner.id === bobId), 'filter by list owner', r.data)
  r = await D.get('/api/admin/claims?q=Hanna')
  ok(r.data.items.length === 1, 'text search', r.data)
  r = await D.get('/api/admin/claims?limit=2&page=2')
  ok(r.data.items.length >= 1 && r.data.page === 2 && r.data.pages >= 2, 'pagination', r.data)

  section('Surprise protection: Alice (admin AND owner of list A) does not see claims on her own list')
  r = await A.get('/api/admin/claims?limit=100')
  ok(r.status === 200 && r.data.items.length === 2 && r.data.items.every((x) => x.owner.id === bobId), 'claims list shows only Bob list', r.data.items.map((x) => x.wish_title))
  ok(!r.text.includes('telescope') && !r.text.includes('Hanna') && !r.text.includes('Alice list') && !r.text.includes('Secret'), 'no trace of own-list claims in the response', r.text.slice(0, 300))
  const hiddenOwn = r.data.hidden_own
  ok(hiddenOwn >= 2, 'a hidden count is reported', hiddenOwn)
  for (const qs of ['q=Hanna', 'q=telescope', `ip=${IP.HANNA}`, `ip=${IP.C}`, 'q=Carl', 'by=guest', 'state=released', 'state=active']) {
    const x = await A.get(`/api/admin/claims?${qs}`)
    ok(x.data.hidden_own === hiddenOwn, `hidden count does not depend on filter/search (${qs})`, x.data.hidden_own)
    ok(!x.text.includes('telescope') && !x.text.includes('Hanna') && !x.text.includes('Alice list'), `no own-list row for ${qs}`, x.text.slice(0, 200))
  }
  r = await A.get('/api/admin/claims?q=Hanna')
  ok(r.data.items.length === 0 && r.data.total === 0, 'search for a hidden guest name finds nothing (no oracle)', r.data)
  r = await A.get('/api/admin/claims?q=Carl')
  ok(r.data.items.every((x) => x.owner.id === bobId), 'search for the claimer only finds Bob list claims', r.data.items.map((x) => x.list_title))

  // Audit log: same rule
  r = await A.get('/api/admin/audit?limit=200')
  ok(r.status === 200 && r.data.hidden_own >= 2, 'audit reports hidden own entries', r.data.hidden_own)
  const auditOwn = (x) => x.items.some((e) => ['wish.reserve', 'wish.unreserve', 'admin.claim.release'].includes(e.action) && [a1, a2, a3].map(String).includes(String(e.target_id)))
  ok(!auditOwn(r.data), 'no claim entry on own wishes in the audit list')
  ok(r.data.items.some((e) => e.action === 'wish.reserve' && String(e.target_id) === String(b1)), 'claim entry on Bob list is visible')
  ok(!JSON.stringify(r.data.items.filter((e) => e.action.startsWith('gift.'))).includes('Secret'), 'no gift entry of the claim-planned gift')
  ok(!r.data.items.some((e) => e.action.startsWith('gift.') && e.details?.owner_user_id === aliceId), 'gift entries tied to own list claims are hidden')
  const hiddenAudit = r.data.hidden_own
  for (const qs of ['q=Hanna', 'q=telescope', `ip=${IP.HANNA}`, `ip=${IP.C}`, 'action=wish.reserve', 'action=wish.*', 'action=gift.*', `user_id=${carlId}`, 'via=anonymous', 'q=Alice%20list']) {
    const x = await A.get(`/api/admin/audit?${qs}`)
    ok(x.status === 200 && x.data.hidden_own === hiddenAudit, `audit hidden count independent of ${qs}`, x.data.hidden_own)
    ok(!auditOwn(x.data) && !x.text.includes('Hidden Hanna') && !x.text.includes('Secret telescope') && !x.text.includes('Secret scarf'), `audit: no own-list claim entry for ${qs}`, x.text.slice(0, 300))
  }
  r = await A.get(`/api/admin/audit?ip=${IP.HANNA}`)
  ok(r.data.items.length === 0, 'IP filter of a hidden claim returns nothing (no oracle)', r.data.items.map((e) => e.action))
  r = await A.get('/api/admin/audit/settings')
  const totalHidden = r.data.total
  const totalAll = (await D.get('/api/admin/audit/settings')).data.total
  ok(totalHidden < totalAll && r.data.hidden_own >= 2, 'total count excludes hidden entries', { totalHidden, totalAll })
  r = await A.get('/api/admin/audit/export?format=csv&action=wish.*')
  ok(r.status === 200 && !r.text.includes('telescope') && !r.text.includes('Hanna') && !r.text.includes(IP.HANNA), 'csv export without hidden entries', r.text.slice(0, 400))
  r = await A.get('/api/admin/audit/export?format=json')
  ok(r.status === 200 && !r.text.includes('Hidden Hanna') && !r.text.includes('Secret telescope') && !r.text.includes(IP.HANNA), 'json export without hidden entries')
  r = await A.get('/api/admin/audit/actions')
  ok(Array.isArray(r.data), 'actions list')

  section('Reveal is explicit and audited')
  r = await A.get('/api/admin/claims?reveal_own=1&limit=100')
  ok(r.status === 200 && r.data.hidden_own === 0 && r.data.items.some((x) => x.wish_title === 'Secret telescope') && r.data.items.some((x) => x.guest_name === 'Hidden Hanna'), 'reveal shows own-list claims', r.data.items.length)
  r = await D.get('/api/admin/audit?action=audit.reveal_own')
  ok(r.data.items.length >= 1 && r.data.items[0].actor_label === 'alice@example.com' && r.data.items[0].ip === IP.A, 'reveal was audited with actor and IP', r.data.items[0])
  r = await A.get('/api/admin/audit?reveal_own=1&limit=200')
  ok(auditOwn(r.data) && r.data.hidden_own === 0, 'audit reveal shows own entries')
  r = await A.get('/api/admin/audit/export?format=csv&reveal_own=1&action=wish.*')
  ok(r.text.includes('Hidden Hanna') || r.text.includes(IP.HANNA) || r.text.includes('Secret telescope') || r.text.includes('wish.reserve'), 'export with reveal contains own entries')
  // release: own list needs the reveal, else 404 like a missing claim
  const own = (await A.get('/api/admin/claims?reveal_own=1&state=active&limit=100')).data.items.find((x) => x.wish_title === 'Secret telescope')
  r = await A.post(`/api/admin/claims/${own.reservation_id}/release`, {})
  ok(r.status === 404, 'release on an own list without reveal -> 404', r.status)
  r = await A.post(`/api/admin/claims/${own.reservation_id}/release?reveal_own=1`, {})
  ok(r.status === 200, 'release on an own list after reveal', r)
  r = await D.get('/api/admin/audit?action=admin.claim.release')
  ok(r.data.items.length === 1 && r.data.items[0].details?.owner_user_id === aliceId && r.data.items[0].target_label === 'Secret telescope', 'admin release audited with list/owner', r.data.items)
  r = await A.get('/api/admin/audit?action=admin.claim.release')
  ok(r.data.items.length === 0, 'the release entry on Alice list is hidden from Alice again')

  section('Release (admin action) on someone else list')
  const bRow = (await D.get('/api/admin/claims?state=active&owner_id=' + bobId)).data.items.find((x) => x.wish_id === b1)
  r = await D.post(`/api/admin/claims/${bRow.reservation_id}/release`, {})
  ok(r.status === 200, 'Diana releases C claim on Bob list', r)
  r = await C.get(`/api/shared/${LB.token}`)
  ok(r.data.wishes.find((w) => w.id === b1).reserved === false, 'wish is free again')
  r = await D.get('/api/admin/claims?q=HYPERLINK')
  ok(r.data.items.length === 1 && r.data.items[0].state === 'released' && r.data.items[0].released_by === 'Diana', 'history shows who released it', r.data.items)
  r = await D.post('/api/admin/claims/999999/release', {})
  ok(r.status === 404, 'unknown claim -> 404')
  r = await D.get('/api/admin/audit?action=admin.claim.release')
  ok(r.data.items.some((e) => e.actor_label === 'diana@example.com' && e.ip === IP.D), 'release audited with admin IP')
  // Claims that end because the owner deletes the wish: the owner is who released it, never the claimer, and the owner's IP is not the claimer's
  ok((await C.post(`/api/wishes/${b4}/reserve`, { token: LB.token })).status === 200, 'C claims b4')
  ok((await B.req('DELETE', `/api/wishes/${b4}`)).status === 200, 'Bob deletes the wish b4')
  r = await D.get('/api/admin/claims?state=released&q=globe')
  ok(r.data.items.length === 1 && r.data.items[0].claimed_by?.id === carlId && !r.data.items[0].guest && r.data.items[0].released_by === 'Bob' && r.data.items[0].ip === null, 'implicit release: claimer and releaser are told apart', r.data.items)
  // An edit of a gift planned from a claim names the list owner, so that it can be hidden from them
  if (gift) {
    r = await D.get('/api/admin/audit?action=gift.update&limit=100')
    ok(r.data.items.some((e) => String(e.target_id) === String(gift.id) && e.details?.owner_user_id === aliceId), 'gift entry of a claimed wish carries the list owner', r.data.items)
    r = await A.get('/api/admin/audit?action=gift.update&limit=100')
    ok(!r.data.items.some((e) => String(e.target_id) === String(gift.id)), 'gift entry of a claim on the own list is hidden from the owner-admin', r.data.items)
  }
  // Bob (non-admin owner) never gets claim info
  r = await B.get(`/api/wishlists/${LB.id}`)
  ok(!JSON.stringify(r.data).includes('Vera') && !JSON.stringify(r.data).includes(IP.VERA), 'owner view has no claim/IP info')

  section('CSV export of claims: formula injection and completeness')
  r = await D.get('/api/admin/claims/export')
  ok(r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.includes("'=HYPERLINK") && r.text.includes("'=cmd|Vera"), 'formula-like cells are neutralised', r.text.slice(0, 600))
  ok(!/(^|,|\n)=/.test(r.text.replace(/^﻿/, '')), 'no cell starts with =')
  r = await A.get('/api/admin/claims/export')
  ok(!r.text.includes('telescope') && !r.text.includes('Hanna') && !r.text.includes('Alice list'), 'claims export is masked for the owner-admin')
  r = await D.get('/api/admin/audit/export?format=csv&action=wish.*')
  ok(!/(^|,|\n)=cmd/.test(r.text) && !/(^|,|\n)=HYPERLINK/.test(r.text), 'audit export: no raw formula cell')

  section('IP and device on user activities of every module (default level "all")')
  const last = async (action, who = D) => (await who.get(`/api/admin/audit?action=${encodeURIComponent(action)}&limit=5&reveal_own=1`)).data.items[0]
  const expectIp = async (action, ip, label = action) => {
    const e = await last(action)
    ok(e && e.ip === ip && typeof e.user_agent === 'string' && e.user_agent.length > 5, `${label}: IP ${ip} and user agent logged`, e && { ip: e.ip, ua: e.user_agent, action: e.action })
    return e
  }
  r = await B.post('/api/auth/login', { email: 'bob@example.com', password: PW })
  await expectIp('auth.login', IP.B)
  r = await B.post('/api/wishlists', { title: 'Another list' })
  await expectIp('wishlist.create', IP.B)
  await B.post(`/api/wishlists/${r.data.id}/wishes`, { title: 'A wish' })
  await expectIp('wish.create', IP.B)
  await B.put('/api/account', { name: 'Bobby' })
  await expectIp('account.update', IP.B)
  await B.post('/api/persons', { name: 'Grandma' })
  await expectIp('person.create', IP.B)
  r = await B.post('/api/items', { title: 'Idea one' })
  ok(r.status === 200, 'item create', r.status)
  await expectIp('item.create', IP.B)
  await B.post('/api/spaces', { name: 'Team' })
  await expectIp('space.create', IP.B)
  r = await B.post('/api/occasion-types', { name: 'Housewarming' })
  await expectIp('occasion_type.create', IP.B)
  const ot = (await B.get('/api/occasion-types')).data.types.map((x) => x.id)
  await B.post('/api/occasion-types/reorder', { ids: ot.reverse() })
  const reorder = await expectIp('occasion_type.reorder', IP.B)
  ok(reorder && reorder.action === 'occasion_type.reorder', 'reorder has a proper action name (not api.post…)')
  await B.post('/api/relationship-types', { name: 'Pen pal' })
  await expectIp('relationship_type.create', IP.B)
  r = await B.post('/api/account/api-keys', { name: 'k1', scopes: ['read', 'write'] })
  const key = r.data.secret
  await expectIp('api_key.create', IP.B)
  if (key) {
    r = await fetch(BASE + '/api/v1/ideas', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.77', 'User-Agent': 'curl/8.0' }, body: JSON.stringify({ title: 'From API' }) })
    ok(r.status === 200 || r.status === 201, 'API v1 idea', r.status)
    const e = await last('api.idea.create')
    ok(e && e.ip === '198.51.100.77' && e.via === 'api_key', 'API v1 call logged with the caller IP', e)
    const u = await last('api_key.use')
    ok(u && u.ip === '198.51.100.77', 'api_key.use with IP', u)
    r = await fetch(BASE + '/api/v1/ideas', { method: 'POST', headers: { Authorization: 'Bearer wishy_bogus_0123456789abcdef0123', 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.78' }, body: '{}' })
    const f = await last('api.auth.fail')
    ok(f && f.ip === '198.51.100.78', 'failed API auth logged with IP', f)
  }
  r = await anonLogin('198.51.100.88')
  const lf = await last('auth.login')
  ok(lf && lf.status === 'fail' && lf.ip === '198.51.100.88', 'failed login logged with IP', lf)
  r = await B.get('/api/export')
  await expectIp('data.export', IP.B)
  r = await A.put('/api/admin/audit/settings', { audit_level: 'all' })
  await expectIp('admin.audit.settings', IP.A)
  // claims at every level: with level "security" claims and releases are still logged
  r = await A.put('/api/admin/audit/settings', { audit_level: 'security' })
  ok(r.data.audit_level === 'security' && r.data.audit_level_stored === true, 'explicit choice is stored and kept', r.data)
  const persons = async () => (await D.get('/api/admin/audit?action=person.create&limit=200')).data.items.length
  const p0 = await persons()
  await B.post('/api/persons', { name: 'Not logged at security level' })
  ok((await persons()) === p0, 'content activity is skipped at level security')
  const before = (await D.get('/api/admin/audit?action=wish.reserve&limit=100')).data.items.length
  ok((await C.post(`/api/wishes/${b3}/reserve`, { token: LB.token })).status === 200, 'claim at level security')
  const afterE = (await D.get('/api/admin/audit?action=wish.reserve&limit=100')).data.items
  ok(afterE.length === before + 1 && afterE[0].ip === IP.C && String(afterE[0].target_id) === String(b3), 'claim logged at level "security" with IP', afterE[0])
  r = await A.put('/api/admin/audit/settings', { audit_level: 'all' })

  section('Offline replay: one entry, the writing request IP')
  const opId = '3f0e7b64-0000-4000-8000-000000000001'
  const E1 = new Client('198.51.100.31')
  await E1.post('/api/auth/login', { email: 'bob@example.com', password: PW })
  r = await E1.post('/api/persons', { name: 'Queued person' }, { 'X-Op-Id': opId })
  ok(r.status === 200, 'queued write', r.status)
  E1.ip = '198.51.100.32'
  r = await E1.post('/api/persons', { name: 'Queued person' }, { 'X-Op-Id': opId })
  ok(r.status === 200, 'replay answered', r.status)
  const q = (await D.get('/api/admin/audit?action=person.create&limit=20')).data.items.filter((e) => e.actor_label === 'bob@example.com' && e.ip.startsWith('198.51.100.3'))
  ok(q.length === 1 && q[0].ip === '198.51.100.31' && q[0].details?.offline_op === true, 'exactly one entry for the op, flagged as offline write', q)

  section('Flood protection also covers successful anonymous actions (guest claims)')
  const many = await mkList(B, 'Many wishes', Array.from({ length: 36 }, (_, i) => 'Flood ' + i))
  const FL = new Client('198.51.100.99')
  let okc = 0
  for (const id of many.ids) if ((await FL.post(`/api/wishes/${id}/reserve`, { token: many.token, guest_name: 'Flooder' })).status === 200) okc++
  const logged = (await D.get('/api/admin/audit?action=wish.reserve&status=ok&ip=198.51.100.99&limit=100')).data.items.length
  ok(okc >= 30 && logged >= 1 && logged <= 30, `anonymous claims are capped per IP and minute (${okc} claims, ${logged} entries)`, { okc, logged })

  section('Sessions per user and last activity')
  r = await D.get('/api/admin/users')
  const carl = r.data.find((u) => u.id === carlId)
  ok(carl.last_ip === IP.C && carl.last_seen_at, 'users list carries last activity and IP', carl)
  r = await D.get(`/api/admin/users/${carlId}/sessions`)
  ok(r.status === 200 && r.data.length >= 1 && r.data[0].ip === IP.C && /iOS/.test(r.data[0].device) && typeof r.data[0].id === 'string' && r.data[0].id.length === 16, 'sessions with IP/device', r.data)
  ok(!JSON.stringify(r.data).includes(Object.values(C.cookies)[0] || 'xx'), 'session ids are not the cookie tokens')
  r = await D.del(`/api/admin/users/${carlId}/sessions/${r.data[0].id}`)
  ok(r.status === 200, 'revoke one session', r)
  r = await C.get('/api/auth/me')
  ok(r.status === 401 || !r.data.user, 'revoked session is signed out', r.status)
  r = await D.get('/api/admin/audit?action=admin.user.session.revoke')
  ok(r.data.items.length === 1 && r.data.items[0].ip === IP.D, 'revocation audited')
  r = await D.get(`/api/admin/users/99999/sessions`)
  ok(r.status === 404, 'unknown user -> 404')

  section('Retention: IP anonymisation')
  r = await D.get('/api/admin/retention')
  ok(r.data.retention_ip_days === 90, 'default 90 days', r.data.retention_ip_days)
  r = await D.put('/api/admin/retention', { retention_ip_days: -1 })
  ok(r.status === 400, 'invalid value rejected')
  const db = rdb()
  const old = new Date(Date.now() - 100 * 86_400_000)
  db.prepare("UPDATE audit_log SET at=? WHERE action='wish.reserve' AND target_id=?").run(old.toISOString(), String(b3))
  const resv = db.prepare('SELECT id FROM reservations WHERE wish_id=?').get(b3)
  db.prepare('UPDATE reservations SET created_at=? WHERE id=?').run(old.toISOString().slice(0, 19).replace('T', ' '), resv.id)
  const hasCols = db.prepare('PRAGMA table_info(reservations)').all().some((c) => c.name === 'ip')
  if (hasCols) db.prepare("UPDATE reservations SET ip='198.51.100.250', user_agent='UA-old' WHERE id=?").run(resv.id)
  r = await D.put('/api/admin/retention', { retention_ip_days: 0 })
  r = await D.post('/api/admin/retention/run', {})
  ok(r.data.ip_anonymised === 0, '0 = keep IPs', r.data)
  ok(db.prepare("SELECT ip FROM audit_log WHERE action='wish.reserve' AND target_id=?").get(String(b3)).ip === IP.C, 'IP kept with 0')
  r = await D.put('/api/admin/retention', { retention_ip_days: 90 })
  r = await D.post('/api/admin/retention/run', {})
  ok(r.status === 200 && r.data.ip_anonymised >= 1, 'run anonymises', r.data)
  const oldRow = db.prepare("SELECT ip, user_agent, action FROM audit_log WHERE action='wish.reserve' AND target_id=?").get(String(b3))
  ok(oldRow && oldRow.ip === null && oldRow.user_agent === null, 'old audit entry kept, IP and user agent removed', oldRow)
  const newRow = db.prepare("SELECT ip FROM audit_log WHERE action='auth.login' AND ip IS NOT NULL ORDER BY id DESC LIMIT 1").get()
  ok(newRow && newRow.ip, 'recent entries keep their IP')
  if (hasCols) {
    const rr = db.prepare('SELECT ip, user_agent FROM reservations WHERE id=?').get(resv.id)
    ok(rr.ip === null && rr.user_agent === null, 'reservation IP and user agent anonymised too', rr)
    ok(db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE id=?').get(resv.id).n === 1, 'reservation itself kept')
  }
  r = await D.get('/api/admin/claims?limit=100')
  ok(r.status === 200 && r.data.items.some((x) => x.wish_id === b3 && x.ip === null), 'claims view shows the anonymised row without IP')
  db.close()

  section('IP never reaches non-admin surfaces')
  for (const c of [B, C]) {
    const s = JSON.stringify([(await c.get('/api/state')).data, (await c.get('/api/export')).data, (await c.get('/api/wishlists')).data])
    ok(!s.includes(IP.C) && !s.includes(IP.HANNA) && !s.includes(IP.VERA) && !s.includes('"user_agent"'), 'state/export/wishlists carry no IP or user agent')
  }
  r = await new Client('203.0.113.50').get(`/api/shared/${LB.token}`)
  ok(!JSON.stringify(r.data).includes('198.51.100.') && !JSON.stringify(r.data).includes('user_agent'), 'public list view carries no IP')

  section('Guests: identity, codes, filters, guest view')
  const wishOf2 = (v, id) => v.wishes.find((w) => w.id === id)
  const gkey = () => Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64url')
  const GK = (k) => ({ 'X-Guest-Key': k })
  const mkWishes = async (client, list, titles) => { const ids = []; for (const w of titles) ids.push((await client.post(`/api/wishlists/${list.id}/wishes`, { title: w })).data.wishes.find((x) => x.title === w).id); return ids }
  const LG = await mkList(B, 'Guest list', ['G one', 'G two', 'G three', 'G four', 'G five'])
  const LGA = await mkList(A, 'Alice guest list', ['AG one', 'AG two'])
  const [g1, g2, g3, g4, g5] = LG.ids
  const [ag1, ag2] = LGA.ids
  const k1 = gkey(), k2 = gkey(), k3 = gkey()
  const GU1 = new Client('198.51.100.61', 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36')
  const GU2 = new Client('198.51.100.62')
  const GU3 = new Client('198.51.100.63')
  r = await GU1.post(`/api/shared/${LG.token}/wishes/${g1}/reserve`, { guest_name: 'Gustav' }, GK(k1))
  const code1 = r.data.guest.code
  await GU1.post(`/api/shared/${LG.token}/wishes/${g2}/reserve`, {}, GK(k1))
  r = await GU2.post(`/api/shared/${LG.token}/wishes/${g3}/reserve`, { guest_name: 'Gustav' }, GK(k2))
  const code2 = r.data.guest.code
  ok(code1 !== code2 && /^G-[A-Z0-9]{6}$/.test(code1) && /^G-[A-Z0-9]{6}$/.test(code2), 'two guests with the same name have two codes', [code1, code2])
  r = await GU3.post(`/api/shared/${LGA.token}/wishes/${ag1}/reserve`, { guest_name: 'Secret Guest' }, GK(k3))
  const code3 = r.data.guest.code
  r = await D.get('/api/admin/claims?limit=100')
  const rowG1 = r.data.items.find((x) => x.wish_title === 'G one')
  ok(rowG1 && rowG1.guest === true && rowG1.guest_code === code1 && rowG1.guest_name === 'Gustav' && rowG1.state === 'active', 'claims list carries the guest code', rowG1)
  r = await D.get(`/api/admin/claims?guest=${code1}`)
  ok(r.data.items.length === 2 && r.data.items.every((x) => x.guest_code === code1), 'filter by guest code', r.data.items.length)
  r = await D.get(`/api/admin/claims?guest=${code1.toLowerCase()}`)
  ok(r.data.items.length === 2, 'the code filter ignores case')
  r = await D.get(`/api/admin/claims?q=${code2}`)
  ok(r.data.items.length === 1 && r.data.items[0].wish_title === 'G three', 'free-text search finds the code', r.data.items)
  r = await D.get('/api/admin/claims/export')
  ok(r.text.split('\r\n')[0].includes('guest_code') && r.text.includes(code1), 'CSV has a guest_code column', r.text.split('\r\n')[0])
  r = await D.get('/api/admin/guests?limit=100')
  const gu1 = r.data.items.find((x) => x.code === code1)
  ok(r.status === 200 && gu1 && gu1.name === 'Gustav' && gu1.claims === 2 && gu1.ip === '198.51.100.61' && /Android/i.test(gu1.device || '') && gu1.list_title === 'Guest list' && /^Bob/.test(gu1.owner?.name || '') && gu1.created_at && gu1.last_seen_at, 'guest view: name, code, list, owner, claims, IP, device', gu1)
  ok(!r.text.includes(k1) && !r.text.includes('key_hash'), 'guest view carries no key and no hash')
  r = await D.get('/api/admin/guests?active=1&q=gustav')
  ok(r.data.items.length === 2 && r.data.items.every((x) => x.claims > 0), 'guest view: search by name, only with active claims', r.data.items.length)
  r = await D.get(`/api/admin/guests?guest=${code2}`)
  ok(r.data.items.length === 1 && r.data.items[0].code === code2, 'guest view: filter by code')
  r = await D.get('/api/admin/guests?ip=198.51.100.6*')
  ok(r.data.items.length >= 2, 'guest view: IP prefix filter')
  for (const u of ['/api/admin/guests', `/api/admin/guests/1`]) {
    r = await B.req(u.endsWith('1') ? 'DELETE' : 'GET', u)
    ok(r.status === 403, `${u} -> 403 for a normal user`, r.status)
  }
  r = await B.post('/api/admin/claims/delete', { ids: [1] })
  ok(r.status === 403, 'bulk delete -> 403 for a normal user')

  section('Guests: masking for the admin who owns the list (new data, new actions)')
  r = await A.get('/api/admin/guests?limit=100')
  ok(r.status === 200 && !r.data.items.some((x) => x.code === code3) && r.data.hidden_own >= 1 && r.data.items.some((x) => x.code === code1), 'owner-admin: own guests hidden, others shown, hidden count', { hidden: r.data.hidden_own })
  const hiddenOwnG = r.data.hidden_own
  for (const [what, u] of [['guest filter', `/api/admin/guests?guest=${code3}`], ['guest search', `/api/admin/guests?q=${code3}`], ['name search', '/api/admin/guests?q=Secret%20Guest'], ['claims filter', `/api/admin/claims?guest=${code3}`], ['claims search', `/api/admin/claims?q=${code3}`]]) {
    r = await A.get(u)
    ok(r.status === 200 && r.data.items.length === 0 && r.data.total === 0, `owner-admin: ${what} cannot find own guest`, r.data)
  }
  r = await A.get(`/api/admin/guests?q=${code3}`)
  ok(r.data.hidden_own === hiddenOwnG, 'the hidden count does not depend on filters (no probing)')
  r = await A.get(`/api/admin/audit?q=${code3}&limit=200`)
  ok(r.data.items.length === 0, 'owner-admin: audit search for the own guest code finds nothing', r.data.items.length)
  r = await A.get('/api/admin/audit?action=guest.*&limit=200')
  ok(!r.data.items.some((e) => e.details?.guest_code === code3) && r.data.items.some((e) => e.details?.guest_code === code1), 'owner-admin: guest.* entries of own lists are hidden, others shown')
  r = await A.get('/api/admin/audit/export?format=json')
  ok(!r.text.includes(code3) && r.text.includes(code1), 'owner-admin: audit export hides entries about own guests')
  r = await A.get('/api/admin/claims/export')
  ok(!r.text.includes(code3) && !r.text.includes('Secret Guest'), 'owner-admin: claims export hides own guests')
  r = await A.get('/api/admin/audit?limit=5')
  ok(r.data.hidden_own >= 3, 'owner-admin: guest.create / wish.reserve of the own list count as hidden', r.data.hidden_own)
  r = await A.get(`/api/admin/guests?reveal_own=1&guest=${code3}`)
  ok(r.data.items.length === 1 && r.data.items[0].name === 'Secret Guest' && r.data.hidden_own === 0, 'after the reveal the own guest shows', r.data)
  r = await A.get(`/api/admin/audit?reveal_own=1&q=${code3}&limit=200`)
  ok(r.data.items.some((e) => e.action === 'guest.create') && r.data.items.some((e) => e.action === 'wish.reserve'), 'after the reveal the entries show', r.data.items.map((e) => e.action))
  r = await D.get('/api/admin/audit?action=audit.reveal_own')
  ok(r.data.items.length >= 1, 'the reveal itself is audited')

  section('Delete reservations: several at once, planned gifts, own lists')
  await C.post('/api/auth/login', { email: 'carl@example.com', password: PW })
  r = await C.post(`/api/shared/${LG.token}/wishes/${g4}/reserve`, { plan: true })
  ok(r.status === 200, 'C reserves g4 and plans it', r.data)
  const dbq = rdb()
  const giftOf = (wid) => dbq.prepare("SELECT id FROM gifts WHERE wish_id=?").get(wid)
  ok(!!giftOf(g4), 'a gift was planned')
  r = await GU2.post(`/api/shared/${LG.token}/wishes/${g5}/reserve`, {}, GK(k2))
  r = await D.get(`/api/admin/claims?state=active&owner_id=${bobId}&limit=100`)
  const act = (title) => r.data.items.find((x) => x.wish_title === title)
  const ids3 = [act('G one'), act('G four'), act('G five')].map((x) => x?.reservation_id)
  ok(ids3.every((x) => Number.isInteger(x)), 'three active claims found', ids3)
  r = await D.post('/api/admin/claims/delete', { ids: [] })
  ok(r.status === 400, 'nothing selected -> 400')
  r = await D.post('/api/admin/claims/delete', { ids: 'x' })
  ok(r.status === 400, 'ids must be a list -> 400')
  const aliceClaim = (await D.get('/api/admin/claims?state=active&q=AG%20one&limit=10')).data.items[0]
  ok(aliceClaim && aliceClaim.wish_title === 'AG one', 'Diana can see the claim on Alice\'s list')
  r = await D.post('/api/admin/claims/delete', { ids: [...ids3, 987654, aliceClaim.reservation_id] })
  ok(r.status === 200 && r.data.deleted === 4 && r.data.skipped === 1, 'bulk delete: 4 deleted (incl. Alice\'s list, Diana owns no list), 1 unknown skipped', r.data)
  r = await GU1.get(`/api/shared/${LG.token}`, GK(k1))
  ok(wishOf2(r.data, g1).reserved === false && r.data.guest.claims === 1, 'the guest sees the deleted reservation as free, the other one is intact', r.data.guest)
  r = await C.get(`/api/shared/${LG.token}`)
  ok(wishOf2(r.data, g4).reserved === false && !giftOf(g4), 'the planned gift went with its reservation and the wish is free')
  const relAudit = (await D.get('/api/admin/audit?action=admin.claim.release&limit=50')).data.items
  ok(relAudit.filter((e) => e.details?.bulk === 5).length === 4 && relAudit.some((e) => e.details?.guest_code === code1 && e.details?.guest_name === 'Gustav' && e.actor_label === 'diana@example.com'), 'each deletion is audited with the guest code', relAudit.map((e) => e.details))
  r = await D.get(`/api/admin/claims?guest=${code1}&state=released`)
  ok(r.data.items.some((x) => x.wish_title === 'G one' && x.released_by === 'Diana' && x.guest_code === code1), 'history keeps the guest code of an ended reservation', r.data.items)
  // an admin who owns lists: their own claims only after the reveal; unknown and hidden ones are skipped alike
  r = await GU3.post(`/api/shared/${LGA.token}/wishes/${ag2}/reserve`, {}, GK(k3))
  const ownIds = (await A.get('/api/admin/claims?reveal_own=1&state=active&limit=100')).data.items.filter((x) => x.list_title === 'Alice guest list').map((x) => x.reservation_id)
  ok(ownIds.length >= 1, 'Alice (owner-admin) has own claims after a reveal', ownIds)
  r = await A.post('/api/admin/claims/delete', { ids: ownIds })
  ok(r.status === 200 && r.data.deleted === 0 && r.data.skipped === ownIds.length, 'own-list claims are skipped without the reveal (same answer as for unknown ids)', r.data)
  r = await A.post(`/api/admin/claims/${ownIds[0]}/release`, {})
  ok(r.status === 404, 'single delete of an own-list claim without reveal -> 404')
  r = await A.post('/api/admin/claims/delete?reveal_own=1', { ids: ownIds })
  ok(r.status === 200 && r.data.deleted === ownIds.length, 'with the reveal they are deleted', r.data)

  section('Delete a guest')
  r = await D.get(`/api/admin/guests?guest=${code2}`)
  const gid2 = r.data.items[0].id
  ok(r.data.items[0].claims === 2 || r.data.items[0].claims === 1, 'Gustav 2 still has a claim', r.data.items[0])
  r = await D.del(`/api/admin/guests/${gid2}`)
  ok(r.status === 200 && r.data.deleted >= 1, 'Diana deletes the guest with its active claims', r.data)
  r = await GU2.get(`/api/shared/${LG.token}`, GK(k2))
  ok(r.data.guest === null && wishOf2(r.data, g3).reserved === false, 'the personal link is dead (unknown key), the wish is free', r.data.guest)
  r = await GU2.post(`/api/shared/${LG.token}/wishes/${g3}/reserve`, { guest_name: 'Gustav' }, GK(k2))
  ok(r.status === 200 && r.data.guest.code !== code2, 'the same browser starts over as a new guest with the same key', r.data.guest)
  r = await D.del(`/api/admin/guests/${gid2}`)
  ok(r.status === 404, 'deleting it again -> 404')
  r = await D.get('/api/admin/audit?action=admin.guest.delete')
  ok(r.data.items.length === 1 && r.data.items[0].details.guest_code === code2 && r.data.items[0].details.claims_deleted >= 1 && r.data.items[0].actor_label === 'diana@example.com' && r.data.items[0].target_type === 'guest', 'audit: admin.guest.delete with code and number of claims', r.data.items)
  r = await D.get(`/api/admin/claims?guest=${code2}&state=released`)
  ok(r.data.items.length >= 1 && r.data.items.every((x) => x.released_by === 'Diana'), 'the ended reservations stay in the history (audit log), not deleted')
  const gA = (await A.get(`/api/admin/guests?reveal_own=1&guest=${code3}`)).data.items[0]
  r = await A.del(`/api/admin/guests/${gA.id}`)
  ok(r.status === 404 && (await A.get(`/api/admin/guests?reveal_own=1&guest=${code3}`)).data.items.length === 1, 'owner-admin: deleting an own-list guest without reveal -> 404, nothing happens')
  r = await A.del(`/api/admin/guests/${gA.id}?reveal_own=1`)
  ok(r.status === 200, 'with the reveal it works')
  r = await GU3.get(`/api/shared/${LGA.token}`, GK(k3))
  ok(r.data.guest === null, 'deleted guest: key unknown')
  r = await D.del('/api/admin/guests/abc')
  ok(r.status === 404, 'bad id -> 404')

  section('Retention also blanks the IP and device of guests')
  const old2 = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  const live = (await D.get(`/api/admin/guests?guest=${(await D.get(`/api/admin/guests?q=Gustav&limit=10`)).data.items[0].code}`)).data.items[0]
  dbq.prepare("UPDATE wishlist_guests SET last_seen_at=?, ip='198.51.100.250', user_agent='UA-old' WHERE code=?").run(old2, code1)
  r = await D.post('/api/admin/retention/run', {})
  ok(r.status === 200, 'retention run')
  const gOld = dbq.prepare('SELECT ip, user_agent, name FROM wishlist_guests WHERE code=?').get(code1)
  ok(gOld && gOld.ip === null && gOld.user_agent === null && gOld.name === 'Gustav', 'old guest: IP and device removed, the guest stays', gOld)
  ok(dbq.prepare('SELECT ip FROM wishlist_guests WHERE code=?').get(live.code).ip !== null, 'recent guest keeps its IP')
  r = await D.get(`/api/admin/guests?guest=${code1}`)
  ok(r.data.items[0].ip === null && r.data.items[0].device === null, 'the guest view shows none')
  dbq.close()

  await stop()
  fs.rmSync(DATA, { recursive: true, force: true })
  console.log(`\n${checks - fails}/${checks} checks passed`)
  process.exit(fails ? 1 : 0)

  async function anonLogin(ip) {
    return new Client(ip).post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password-xx' })
  }
}
main().catch(async (e) => {
  console.error(e)
  try { await stop() } catch { /* ignore */ }
  process.exit(1)
})
