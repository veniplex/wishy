import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA = path.join(os.tmpdir(), 'wl-acc-' + Date.now())
const PORT = Number(process.env.SMOKE_PORT) || 3975
const BASE = `http://127.0.0.1:${PORT}`
fs.mkdirSync(DATA, { recursive: true })

let server
function start() {
  return new Promise((resolve, reject) => {
    server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT) } })
    let out = ''
    server.stdout.on('data', (d) => { out += d; if (out.includes('is running')) resolve() })
    server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))
    server.on('exit', (c) => reject(new Error('server exit ' + c)))
  })
}
const stop = () => new Promise((r) => { server.removeAllListeners('exit'); server.on('exit', r); server.kill() })

class Client {
  constructor(name) { this.name = name; this.cookies = {}; this.space = null }
  async req(method, url, body, headers = {}) {
    const h = { ...headers }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    else if (method !== 'GET') h['X-Requested-With'] = 'x'
    if (this.space && !h['X-Space']) h['X-Space'] = String(this.space)
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    if (ck) h.Cookie = ck
    const res = await fetch(BASE + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' })
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      const k = kv.slice(0, i), v = kv.slice(i + 1)
      if (/Max-Age=0/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v
    }
    let data = null
    try { data = await res.json() } catch {}
    return { status: res.status, data, headers: res.headers }
  }
  get(u, h) { return this.req('GET', u, undefined, h) }
  post(u, b = {}, h) { return this.req('POST', u, b, h) }
  put(u, b = {}, h) { return this.req('PUT', u, b, h) }
  del(u, b, h) { return this.req('DELETE', u, b, h) }
}

let pass = 0, failN = 0
const results = []
function t(name, cond, extra) {
  if (cond) { pass++; results.push('PASS ' + name) } else { failN++; results.push('FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 300) : '')) }
}

async function main() {
  await start()
  const A = new Client('A'), B = new Client('B'), G = new Client('guest')

  // ---- Setup ----
  let r = await A.get('/api/auth/me')
  t('me -> setup:true', r.status === 200 && r.data.setup === true, r)
  r = await A.get('/api/state')
  t('state without login -> 401', r.status === 401 && r.data.code === 'auth', r)
  r = await fetch(BASE + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })
  t('CSRF: text/plain POST rejected', r.status === 403)
  r = await A.post('/api/auth/setup', { name: 'Alice', email: 'alice@example.com', password: 'secret123' })
  t('setup first admin', r.status === 200 && r.data.user.role === 'admin' && r.data.spaces.length === 1 && r.data.spaces[0].personal === true, r)
  t('session cookie httponly set', A.cookies.wl_session)
  r = await A.post('/api/auth/setup', { name: 'X', email: 'x@example.com', password: 'secret123' })
  t('second setup -> 403', r.status === 403, r)
  const st = (await A.get('/api/state')).data
  // Seed some data through the API
  const meP = st.persons.find((p) => p.is_me)
  t('setup: own linked person', meP && meP.name === 'Alice' && meP.linked_user_id === st.user_id, meP)
  r = await A.post('/api/persons', { name: 'Anna', birthday: '1990-03-04' })
  const seedAnna = r.data.persons.find((p) => p.name === 'Anna')
  r = await A.post('/api/persons', { name: 'Tom', relationship_group: 'work' })
  r = await A.post('/api/occasions', { name: 'Christmas', type: 'christmas', date: '2020-12-24', recurring: 1, person_ids: [seedAnna.id] })
  r = await A.post('/api/items', { person_id: seedAnna.id, title: 'Teapot' })
  r = await A.post('/api/gifts', { title: 'Scarf', status: 'delivered', payment_status: 'paid', payer_id: meP.id, recipient_ids: [seedAnna.id], givers: [{ person_id: meP.id }] })
  r = await A.put('/api/settings', { currency: 'USD', yearly_budget: 500 })
  const st2 = (await A.get('/api/state')).data
  t('seed: 3 persons, gift, item, occasion', st2.persons.length === 3 && st2.gifts.length === 1 && st2.items.length === 1 && st2.occasions.length >= 1, { p: st2.persons.length, g: st2.gifts.length, i: st2.items.length })
  t('seed: settings currency/yearly_budget', st2.settings.currency === 'USD' && st2.settings.yearly_budget === 500, st2.settings)
  t('ensureUpcoming: Anna birthday occasion', st2.occasions.some((o) => o.type === 'birthday'))
  t('ensureUpcoming: recurring christmas continued', st2.occasions.filter((o) => o.type === 'christmas').length >= 2)
  t('state has space_id/user_id', st.space_id > 0 && st.user_id > 0)

  // ---- Registration ----
  r = await B.get('/api/auth/providers')
  t('providers public', r.status === 200 && r.data.registration.mode === 'invite' && r.data.registration.enabled === true && r.data.google === false, r)
  r = await B.post('/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'secret456' })
  t('register without invite (invite mode) -> 403', r.status === 403, r)
  r = await B.post('/api/admin/invites', {})
  t('non-logged-in admin invite -> 401', r.status === 401)
  r = await A.post('/api/admin/invites', {})
  const inviteUrl = r.data.url
  t('admin invite url', r.status === 200 && inviteUrl.startsWith('/register?invite='), r)
  const invTok = inviteUrl.split('=')[1]
  r = await G.get(`/api/auth/invite/${invTok}`)
  t('invite info: generic user invite', r.status === 200 && r.data.valid === true && r.data.kind === 'user' && r.data.bound === false && !r.data.email, r.data)
  r = await G.get('/api/auth/invite/nonsense')
  t('invite info: invalid -> valid:false only', r.status === 200 && JSON.stringify(r.data) === '{"valid":false}', r.data)
  r = await B.post('/api/auth/register', { name: 'Bob', email: 'BOB@example.com', password: 'secret456', invite: invTok })
  t('register B with admin invite', r.status === 200 && r.data.user.role === 'user', r)
  r = await new Client('x').post('/api/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'secret456', invite: invTok })
  t('invite is one-time', r.status === 403, r)
  r = await new Client('x').post('/api/auth/login', { email: 'bob@example.com', password: 'wrong' })
  t('login wrong password -> 401', r.status === 401)

  // ---- Spaces ----
  r = await A.post('/api/spaces', { name: 'With Bob' })
  const shared = r.data.spaces.find((s) => s.name === 'With Bob')
  t('create space', r.status === 200 && shared && shared.role === 'owner' && shared.member_count === 1, r.data)
  r = await A.post(`/api/spaces/${shared.id}/invites`)
  const spInv = r.data
  t('space invite', r.status === 200 && spInv.url === `/invite/${spInv.token}`, r)
  r = await G.get(`/api/auth/invite/${spInv.token}`)
  t('invite info: space invite', r.data.valid === true && r.data.kind === 'space' && r.data.space_name === 'With Bob', r.data)
  r = await G.get(`/api/invites/${spInv.token}`)
  t('invite preview public', r.status === 200 && r.data.space_name === 'With Bob' && r.data.inviter_name === 'Alice', r)
  r = await B.post(`/api/spaces/${shared.id}/invites`)
  t('non-owner cannot invite', r.status === 403 || r.status === 404, r.status)
  r = await B.post(`/api/invites/${spInv.token}/accept`)
  t('B accepts invite', r.status === 200 && r.data.spaces.some((s) => s.id === shared.id && s.member_count === 2), r.data)
  A.space = shared.id; B.space = shared.id
  let sa = (await A.get('/api/state')).data
  let sb = (await B.get('/api/state')).data
  t('both see space; each has linked person', sa.space_id === shared.id && sa.persons.length === 2 && sb.persons.length === 2 && sa.persons.find((p) => p.is_me).name === 'Alice' && sb.persons.find((p) => p.is_me).name === 'Bob', { sa: sa.persons, sb: sb.persons })
  t('shared space starts without migrated data', sa.gifts.length === 0 && sa.items.length === 0)
  const aliceP = sa.persons.find((p) => p.is_me).id
  const bobP = sa.persons.find((p) => !p.is_me).id
  r = await A.post('/api/persons', { name: 'Grandma', birthday: '1950-06-01' })
  sb = r.status === 200 ? (await B.get('/api/state')).data : null
  t('A adds person, B sees it; birthday occasion generated in shared space', sb && sb.persons.some((p) => p.name === 'Grandma') && sb.occasions.some((o) => o.type === 'birthday'), r)
  const omaId = sb.persons.find((p) => p.name === 'Grandma').id

  // ---- Surprise protection ----
  r = await A.post('/api/gifts', { title: 'Secret gift for Bob', price: 50, recipient_ids: [bobP], givers: [{ person_id: aliceP }] })
  t('A creates gift for Bob', r.status === 200 && r.data.gifts.length === 1, r)
  const secretGift = r.data.gifts[0].id
  r = await A.post('/api/items', { person_id: bobP, kind: 'idea', title: 'Idea for Bob' })
  const secretItem = r.data.items.find((i) => i.title === 'Idea for Bob').id
  r = await A.post('/api/items', { person_id: bobP, mentioned: true, title: 'Wish noted by A' })
  const secretItem2 = r.data.items.find((i) => i.title === 'Wish noted by A').id
  sa = (await A.get('/api/state')).data
  sb = (await B.get('/api/state')).data
  t('A sees gift+items for Bob', sa.gifts.length === 1 && sa.items.length === 2)
  t('B state hides gift and items about Bob', sb.gifts.length === 0 && sb.items.length === 0, { g: sb.gifts, i: sb.items })
  t('B state JSON contains no secret strings', !JSON.stringify(sb).includes('Secret') && !JSON.stringify(sb).includes('Idea for Bob') && !JSON.stringify(sb).includes('noted by A'))
  r = await B.put(`/api/gifts/${secretGift}`, { title: 'x' })
  t('B PUT hidden gift -> 404', r.status === 404, r)
  r = await B.del(`/api/gifts/${secretGift}`)
  t('B DELETE hidden gift -> 404', r.status === 404, r)
  r = await B.put(`/api/items/${secretItem}`, { title: 'x' })
  t('B PUT hidden item -> 404', r.status === 404, r)
  r = await B.del(`/api/items/${secretItem2}`)
  t('B DELETE hidden item -> 404', r.status === 404, r)
  r = await B.post('/api/gifts', { title: 'For myself', recipient_ids: [bobP] })
  t('B cannot create gift for himself in shared space', r.status === 400, r)
  r = await B.post('/api/items', { title: 'Own wish', person_id: bobP })
  t('B cannot add item to own person in shared space', r.status === 400, r)
  r = await B.post('/api/gifts', { title: 'Mit hidden item', item_id: secretItem })
  t('B cannot reference hidden item', r.status === 404, r)
  r = await B.put(`/api/gifts/${secretGift}`, { recipient_ids: [omaId] })
  t('B cannot hijack hidden gift', r.status === 404, r)
  r = await B.post('/api/settle', { from_id: aliceP, to_id: omaId })
  t('settle works on own visible data (no crash)', r.status === 200)
  // gift for Grandma by B is visible to both
  r = await B.post('/api/gifts', { title: 'Grandma gift', recipient_ids: [omaId], givers: [{ person_id: bobP }] })
  sa = (await A.get('/api/state')).data
  t('gift for Grandma visible to A', sa.gifts.some((g) => g.title === 'Grandma gift'))
  r = await A.get('/api/export')
  t('export (A) includes gift for Bob', r.status === 200 && r.data.gifts.some((g) => g.title === 'Secret gift for Bob'))
  r = await B.get('/api/export')
  t('export (B) excludes hidden rows', r.status === 200 && !JSON.stringify(r.data).includes('Secret') && !JSON.stringify(r.data).includes('Idea for Bob'))

  r = await A.put(`/api/persons/${bobP}`, { notes: 'Likes blue', yearly_budget: 99 })
  const bs = (await B.get('/api/state')).data
  const bme = bs.persons.find((p) => p.is_me)
  t('B sees own person (is_me, notes/budget null)', bme && bme.id === bobP && bme.is_me === 1 && bme.notes === null && bme.yearly_budget === null, bme)
  r = await B.post('/api/gifts', { title: 'From Bob to Grandma', price: 30, payer_id: bobP, recipient_ids: [omaId], givers: [{ person_id: bobP }] })
  t('B creates gift as giver+payer', r.status === 200 && r.data.gifts.some((g) => g.title === 'From Bob to Grandma' && g.payer_id === bobP && g.givers[0].person_id === bobP), r.status)

  // ---- Wishlists v2 ----
  r = await A.get('/api/wishlists')
  t('Alice starts without wishlists', r.data.mine.length === 0, r.data)
  r = await A.post('/api/admin/users', { name: 'Zed', email: 'zed@example.com', password: 'zedpass123', role: 'user' })
  const Zc = new Client('Z2'); await Zc.post('/api/auth/login', { email: 'zed@example.com', password: 'zedpass123' })
  B.space = null
  r = await B.post('/api/wishlists', { title: 'Geburtstag', event_date: '2030-05-01' })
  const L1 = r.data
  t('create list', r.status === 200 && L1.token && L1.link_enabled === false && L1.url === `/w/${L1.token}` && L1.wish_count === 0, r.data)
  const L2 = (await B.post('/api/wishlists', { title: 'Christmas' })).data
  const L3 = (await B.post('/api/wishlists', { title: 'Geheim' })).data
  r = await B.post(`/api/wishlists/${L1.id}/wishes`, { title: 'Headphones', price: 100, priority: 3 })
  const kopf = r.data.wishes[0].id
  t('owner detail: plain wishes, is_owner', r.data.is_owner === true && !('reserved' in r.data.wishes[0]) && r.data.wishlist.token === L1.token)
  r = await B.post(`/api/wishlists/${L1.id}/wishes`, { title: 'Book', price: 20 })
  const buch = r.data.wishes.find((w) => w.title === 'Book').id
  r = await B.post(`/api/wishlists/${L2.id}/wishes`, { title: 'Socken' })
  const socken = r.data.wishes[0].id
  await B.post(`/api/wishlists/${L3.id}/wishes`, { title: 'Streng geheim' })
  r = await B.post(`/api/wishlists/${L1.id}/reorder`, { ids: [buch, kopf] })
  t('reorder', r.status === 200 && r.data.wishes[0].id === buch)
  r = await B.post(`/api/wishlists/${L1.id}/reorder`, { ids: [socken] })
  t('reorder with foreign wish -> 404', r.status === 404)
  // known users
  r = await B.get('/api/users/known')
  t('known users: Alice (shared space) yes, Zed no', r.status === 200 && r.data.some((u) => u.name === 'Alice') && !r.data.some((u) => u.email === 'zed@example.com'), r.data)
  r = await Zc.get('/api/users/known')
  t('known users: unrelated Zed sees nobody', r.status === 200 && r.data.length === 0, r.data)
  r = await B.post(`/api/wishlists/${L2.id}/access`, { email: 'nobody@example.com' })
  t('access unknown email -> 404 message', r.status === 404 && r.data.error === 'No user with this email - share the link instead.', r)
  r = await B.post(`/api/wishlists/${L2.id}/access`, { user_id: (await Zc.get('/api/auth/me')).data.user.id })
  t('access by user_id outside known -> 404', r.status === 404)
  // L1: link only, L2: direct with Alice
  r = await A.get(`/api/wishlists/${L1.id}`)
  t('no access yet -> 404', r.status === 404)
  r = await G.get(`/api/shared/${L1.token}`)
  t('guest: link disabled -> 404', r.status === 404)
  r = await B.post(`/api/wishlists/${L1.id}/share`, { link_enabled: true })
  t('enable link', r.status === 200 && r.data.link_enabled === true)
  r = await B.post(`/api/wishlists/${L2.id}/access`, { user_id: (await B.get('/api/users/known')).data.find((u) => u.name === 'Alice').id })
  t('share L2 directly with Alice', r.status === 200 && r.data.access.length === 1 && r.data.access[0].via === 'direct', r.data)
  r = await A.get('/api/wishlists')
  t('Alice shared: only L2 (L1 not followed)', r.data.shared.length === 1 && r.data.shared[0].id === L2.id && r.data.shared[0].is_new === true && r.data.shared[0].owner.name === 'Bob' && r.data.shared[0].via === 'direct', r.data.shared)
  r = await G.get(`/api/shared/${L1.token}`)
  t('guest views list by token', r.status === 200 && r.data.wishlist.title === 'Geburtstag' && r.data.wishes.length === 2 && r.data.owner.name === 'Bob' && r.data.is_owner === false && r.data.wishes.every((w) => w.reserved === false), r.data)
  r = await A.post(`/api/shared/${L1.token}/follow`)
  t('Alice follows L1 by link', r.status === 200 && r.data.following === true)
  r = await A.get('/api/wishlists')
  t('Alice sees both lists, both new', r.data.shared.length === 2 && r.data.shared.every((s) => s.is_new) && r.data.shared.find((s) => s.id === L1.id).via === 'link', r.data.shared)
  t('me.shared_unseen = 2', (await A.get('/api/auth/me')).data.shared_unseen === 2)
  r = await A.get(`/api/wishlists/${L2.id}`)
  t('detail for recipient (is_owner false, SharedWish fields)', r.status === 200 && r.data.is_owner === false && r.data.wishes[0].reserved === false && r.data.wishlist.owner.name === 'Bob', r.data)
  r = await A.get('/api/wishlists')
  t('seen_at updated: L2 no longer new, L1 still new', r.data.shared.find((s) => s.id === L2.id).is_new === false && r.data.shared.find((s) => s.id === L1.id).is_new === true)
  t('me.shared_unseen = 1', (await A.get('/api/auth/me')).data.shared_unseen === 1)
  await new Promise((rs) => setTimeout(rs, 30))
  await B.post(`/api/wishlists/${L2.id}/wishes`, { title: 'Tee' })
  r = await A.get('/api/wishlists')
  t('owner edit makes list new again', r.data.shared.find((s) => s.id === L2.id).is_new === true)
  await A.get(`/api/wishlists/${L2.id}`); await A.get(`/api/wishlists/${L1.id}`)
  t('both seen -> unseen 0', (await A.get('/api/auth/me')).data.shared_unseen === 0)

  // ---- Reservations ----
  A.space = shared.id
  r = await A.post(`/api/wishes/${kopf}/reserve`, { plan: true })
  t('A reserves + plans (detail shape)', r.status === 200 && r.data.is_owner === false && r.data.wishes.find((w) => w.id === kopf).reserved_by_me === true, r.data)
  sa = (await A.get('/api/state')).data
  const pg = sa.gifts.find((g) => g.title === 'Headphones')
  t('plan:true gift in current space, recipient = Bob person, giver = Alice', pg && pg.recipient_ids.includes(bobP) && pg.payer_id === aliceP && pg.givers[0].person_id === aliceP && pg.wish_id > 0, pg)
  r = await A.get(`/api/gifts/${pg.id}/events`)
  t('plan:true gift has created event', r.status === 200 && r.data.some((e) => e.type === 'created'), r.data)
  B.space = shared.id
  sb = (await B.get('/api/state')).data
  t('planned gift hidden from B', !sb.gifts.some((g) => g.title === 'Headphones') && !JSON.stringify(sb).includes('Headphones'))
  B.space = null
  r = await B.get(`/api/wishlists/${L1.id}`)
  t('owner detail: no reservation info', r.data.wishes.every((w) => !('reserved' in w) && !('reserved_by' in w)) && !JSON.stringify(r.data.wishes).includes('Alice'), r.data)
  r = await B.get(`/api/shared/${L1.token}`)
  t('owner public view: no reservation info', r.data.is_owner === true && !JSON.stringify(r.data).includes('Alice') && r.data.wishes.every((w) => !('reserved' in w)), r.data)
  r = await B.get('/api/wishlists')
  t('owner overview has no reservation data', !JSON.stringify(r.data.mine).includes('reserv'))
  r = await B.post(`/api/wishes/${buch}/reserve`, {})
  t('owner cannot reserve (access mode)', r.status === 403)
  r = await B.post(`/api/wishes/${buch}/reserve`, { token: L1.token })
  t('owner cannot reserve (token mode)', r.status === 403)
  r = await G.get(`/api/shared/${L1.token}`)
  t('guest sees reserved_by Alice', r.data.wishes.find((w) => w.id === kopf).reserved_by === 'Alice')
  r = await G.post(`/api/wishes/${kopf}/reserve`, { token: L1.token, guest_name: 'Guest' })
  t('already reserved -> 409', r.status === 409)
  r = await G.post(`/api/wishes/${buch}/reserve`, { token: L1.token })
  t('guest needs name', r.status === 400)
  r = await G.post(`/api/wishes/${buch}/reserve`, { guest_name: 'Gast Gerd' })
  t('guest without token -> 404', r.status === 404)
  r = await G.post(`/api/wishes/${buch}/reserve`, { token: L1.token, guest_name: 'Gast Gerd' })
  t('guest reserves via token (no cookies)', r.status === 200 && r.data.wishes.find((w) => w.id === buch).reserved_by === 'Gast Gerd' && r.data.logged_in === false && Object.keys(G.cookies).length === 0, r.data)
  r = await G.del(`/api/wishes/${kopf}/reserve`, { token: L1.token, guest_name: 'Guest' })
  t('guest cannot release others', r.status === 403)
  r = await G.del(`/api/wishes/${buch}/reserve`, { token: L1.token, guest_name: 'gast gerd' })
  t('guest releases own', r.status === 200 && r.data.wishes.find((w) => w.id === buch).reserved === false)
  r = await B.put(`/api/wishes/${socken}`, { status: 'received' })
  await A.get(`/api/wishlists/${L2.id}`)
  r = await A.post(`/api/wishes/${socken}/reserve`, {})
  t('received wish not reservable', r.status === 400, r)
  r = await A.del(`/api/wishes/${kopf}/reserve`, {})
  sa = (await A.get('/api/state')).data
  t('A releases -> planned gift removed', r.status === 200 && r.data.wishes.find((w) => w.id === kopf).reserved === false && !sa.gifts.some((g) => g.title === 'Headphones'), r.data)
  r = await Zc.post(`/api/wishes/${kopf}/reserve`, {})
  t('user without access/token cannot reserve', r.status === 404)
  r = await Zc.get(`/api/wishlists/${L1.id}`)
  t('unrelated user cannot read list', r.status === 404)

  // ---- Ideas with mentioned, linked_wishlists ----
  r = await A.post('/api/items', { person_id: omaId, title: 'Idea Grandma', mentioned: true })
  t('idea carries mentioned', r.data.items.find((i) => i.title === 'Idea Grandma').mentioned === 1 && r.data.items.every((i) => !('kind' in i)), r.data.items[0])
  sa = (await A.get('/api/state')).data
  const lw = sa.persons.find((p) => p.id === bobP).linked_wishlists
  t('linked_wishlists: shared ones only (L1 link, L2 direct), not L3', lw && lw.length === 2 && lw.some((l) => l.id === L1.id) && lw.some((l) => l.id === L2.id) && !lw.some((l) => l.id === L3.id) && !JSON.stringify(sa).includes('shared_wishes'), lw)
  B.space = shared.id
  sb = (await B.get('/api/state')).data
  t('B: Alice person linked_wishlists empty (no access); own person none', sb.persons.find((p) => p.linked_user_id && !p.is_me).linked_wishlists.length === 0 && !sb.persons.find((p) => p.is_me).linked_wishlists)
  B.space = null
  // Disable link: link access gone, direct access stays
  r = await B.post(`/api/wishlists/${L1.id}/share`, { link_enabled: false })
  t('link disabled', r.status === 200 && r.data.link_enabled === false && r.data.access.length === 0)
  r = await A.get(`/api/wishlists/${L1.id}`)
  t('link follower loses access', r.status === 404)
  r = await G.get(`/api/shared/${L1.token}`)
  t('guest loses access', r.status === 404)
  r = await A.get('/api/wishlists')
  t('direct access (L2) stays', r.data.shared.length === 1 && r.data.shared[0].id === L2.id)
  r = await B.post(`/api/wishlists/${L1.id}/share`, { link_enabled: true })
  r = await A.get(`/api/wishlists/${L1.id}`)
  t('re-enabling does not restore link access', r.status === 404)
  // Images
  fs.mkdirSync(path.join(DATA, 'images'), { recursive: true })
  const imgFile = 'a'.repeat(40) + '.png', imgOther = 'b'.repeat(40) + '.png'
  fs.writeFileSync(path.join(DATA, 'images', imgFile), 'x'); fs.writeFileSync(path.join(DATA, 'images', imgOther), 'x')
  await B.put(`/api/wishes/${buch}`, { image_url: '/api/images/' + imgFile })
  const anon = new Client('anon')
  r = await anon.get('/api/images/' + imgFile)
  t('public image of link-enabled wish -> 200', r.status === 200, r.status)
  r = await anon.get('/api/images/' + imgOther)
  t('unreferenced image -> 401', r.status === 401)
  await B.post(`/api/wishlists/${L1.id}/share`, { link_enabled: false })
  r = await anon.get('/api/images/' + imgFile)
  t('image of link-disabled list -> 401', r.status === 401)
  await B.post(`/api/wishlists/${L1.id}/share`, { link_enabled: true })
  await B.put(`/api/wishes/${buch}`, { status: 'removed' })
  r = await anon.get('/api/images/' + imgFile)
  t('image of removed wish -> 401', r.status === 401)
  await B.put(`/api/wishes/${buch}`, { status: 'open' })
  // Archive, remove, leave, delete, export
  r = await B.put(`/api/wishlists/${L2.id}`, { archived: true })
  t('archive', r.data.archived === true)
  r = await A.get(`/api/wishlists/${L2.id}`)
  t('archived hidden from recipient', r.status === 404)
  await B.put(`/api/wishlists/${L2.id}`, { archived: false })
  r = await A.get(`/api/wishlists/${L2.id}`)
  t('unarchived visible again', r.status === 200)
  r = await A.del(`/api/wishlists/${L2.id}/access/me`)
  t('recipient leaves list', r.status === 200 && (await A.get(`/api/wishlists/${L2.id}`)).status === 404)
  await B.post(`/api/wishlists/${L2.id}/access`, { email: 'alice@example.com' })
  r = await B.del(`/api/wishlists/${L2.id}/access/${sa.user_id}`)
  t('owner removes access', r.status === 200 && r.data.access.length === 0 && (await A.get(`/api/wishlists/${L2.id}`)).status === 404)
  r = await A.del(`/api/wishlists/${L2.id}`)
  t('non-owner cannot delete list', r.status === 404)
  r = await A.get(`/api/wishlists/${L2.id}/export`)
  t('non-owner cannot export list', r.status === 404)
  r = await B.get(`/api/wishlists/${L2.id}/export`)
  t('owner exports list', r.status === 200 && r.data.wishes.length === 2)
  r = await B.post(`/api/wishlists/${L1.id}/share`, { regenerate: true })
  t('regenerate token invalidates old link', r.data.token !== L1.token && (await G.get(`/api/shared/${L1.token}`)).status === 404 && (await G.get(`/api/shared/${r.data.token}`)).status === 200)
  r = await B.del(`/api/wishlists/${L3.id}`)
  t('owner deletes list', r.status === 200 && (await B.get('/api/wishlists')).data.mine.length === 2)
  A.space = shared.id; B.space = shared.id
  sa = (await A.get('/api/state')).data


  // ---- Admin ----
  r = await B.get('/api/admin/users')
  t('non-admin -> 403 admin users', r.status === 403)
  r = await B.get('/api/admin/backups')
  t('non-admin -> 403 backups', r.status === 403)
  r = await B.put('/api/admin/settings/auth', { registration_mode: 'open' })
  t('non-admin -> 403 settings', r.status === 403)
  r = await G.get('/api/admin/users')
  t('anonymous -> 401 admin', r.status === 401)
  r = await A.get('/api/admin/users')
  t('admin lists users', r.status === 200 && r.data.length >= 2 && r.data[0].space_count >= 1, r)
  const aliceId = sa.user_id
  r = await A.put(`/api/admin/users/${aliceId}`, { role: 'user' })
  t('cannot demote last admin', r.status === 400, r)
  r = await A.put(`/api/admin/users/${aliceId}`, { disabled: true })
  t('cannot disable last admin', r.status === 400, r)
  r = await A.del(`/api/admin/users/${aliceId}`)
  t('cannot delete self', r.status === 400)
  r = await A.post('/api/admin/users', { name: 'Cara', email: 'cara@example.com', role: 'user' })
  t('admin creates user without password -> invite link', r.status === 200 && r.data.url.startsWith('/register?invite='), r)
  const caraInv = r.data.url.split('=')[1]
  r = await G.get(`/api/auth/invite/${caraInv}`)
  t('invite info: bound user invite prefill', r.data.valid === true && r.data.bound === true && r.data.email === 'cara@example.com' && r.data.name === 'Cara', r.data)
  const C = new Client('C')
  r = await C.post('/api/auth/register', { password: 'carapass1', invite: caraInv })
  t('Cara sets password via invite link', r.status === 200 && r.data.user.email === 'cara@example.com', r)
  r = await A.post('/api/admin/users', { name: 'Dan', email: 'dan@example.com', role: 'admin', password: 'danpass123' })
  t('admin creates admin with password', r.status === 200 && r.data.url === null && r.data.user.role === 'admin', r)
  const danId = r.data.user.id
  r = await A.put(`/api/admin/users/${aliceId}`, { role: 'user' })
  t('can demote admin when another exists', r.status === 200 && r.data.role === 'user', r)
  r = await A.put(`/api/admin/users/${aliceId}`, { role: 'admin' })
  t('Alice (now non-admin) cannot re-promote self', r.status === 403, r)
  const D = new Client('D')
  r = await D.post('/api/auth/login', { email: 'dan@example.com', password: 'danpass123' })
  t('Dan login', r.status === 200)
  r = await D.put(`/api/admin/users/${aliceId}`, { role: 'admin' })
  t('Dan re-promotes Alice', r.status === 200 && r.data.role === 'admin')
  r = await A.post(`/api/admin/users/${danId}/reset-password`)
  const resetTok = r.data.url.split('=')[1]
  t('reset-password link', r.status === 200 && r.data.url.startsWith('/reset-password?token='))
  r = await new Client('r').post('/api/auth/reset', { token: resetTok, password: 'newdanpass1' })
  t('reset consumes token', r.status === 200)
  r = await new Client('r').post('/api/auth/reset', { token: resetTok, password: 'newdanpass2' })
  t('reset token one-time', r.status === 400)
  r = await D.get('/api/auth/me')
  t('reset killed old sessions', r.status === 401)
  r = await A.put('/api/admin/settings/general', { base_url: 'http://localhost:3995/' })
  r = await A.put('/api/admin/settings/auth', { registration_enabled: true, registration_mode: 'open', google_client_id: 'cid.apps.googleusercontent.com', google_client_secret: 'sec' })
  t('admin settings put', r.status === 200 && r.data.registration_mode === 'open' && r.data.google_client_secret_set === true && !JSON.stringify(r.data).includes('"sec"') && r.data.redirect_uri === 'http://localhost:3995/api/auth/google/callback', r)
  r = await G.get('/api/auth/providers')
  t('providers google true, open', r.data.google === true && r.data.registration.mode === 'open')
  r = await G.req('GET', '/api/auth/google/start')
  const loc = r.headers.get('location') || ''
  t('google start redirects w/ PKCE+nonce+state', r.status === 302 && loc.startsWith('https://accounts.google.com/o/oauth2/v2/auth?') && loc.includes('code_challenge_method=S256') && loc.includes('nonce=') && loc.includes('state=') && loc.includes('client_id=cid') && loc.includes('scope=openid+email+profile'), loc)
  r = await G.req('GET', '/api/auth/google/callback?code=x&state=bad')
  t('google callback bad state -> /login?error', r.status === 302 && (r.headers.get('location') || '').startsWith('/login?error='), r.headers.get('location'))
  r = await G.post('/api/auth/register', { name: 'Open Olli', email: 'olli@example.com', password: 'ollipass1' })
  t('open registration works', r.status === 200)
  r = await A.get('/api/admin/stats')
  t('admin stats', r.status === 200 && r.data.users >= 4 && r.data.db_size_bytes > 0, r)

  // ---- Cross-space IDs ----
  A.space = null
  const personalA = (await A.get('/api/state')).data
  const myPersonalMe = personalA.persons.find((p) => p.is_me).id
  r = await A.post('/api/gifts', { title: 'X', recipient_ids: [omaId] })
  t('cross-space recipient -> 404', r.status === 404, r)
  r = await A.post('/api/gifts', { title: 'X', givers: [{ person_id: omaId }] })
  t('cross-space giver -> 404', r.status === 404)
  r = await A.post('/api/gifts', { title: 'X', payer_id: omaId })
  t('cross-space payer -> 404', r.status === 404)
  r = await A.post('/api/occasions', { name: 'X', date: '2030-01-01', person_ids: [omaId] })
  t('cross-space occasion person_ids -> 404', r.status === 404)
  r = await A.post('/api/items', { title: 'X', person_id: omaId })
  t('cross-space item person -> 404', r.status === 404)
  r = await A.put(`/api/persons/${omaId}`, { name: 'Hacked' })
  t('cross-space person PUT -> 404', r.status === 404)
  r = await A.del(`/api/persons/${omaId}`)
  t('cross-space person DELETE -> 404', r.status === 404)
  const sharedOcc = sa.occasions[0].id
  r = await A.post('/api/gifts', { title: 'X', occasion_id: sharedOcc, recipient_ids: [myPersonalMe] })
  t('cross-space occasion_id -> 404', r.status === 404)
  r = await A.post('/api/gifts', { title: 'X', item_id: secretItem })
  t('cross-space item_id -> 404', r.status === 404)
  r = await A.put(`/api/gifts/${secretGift}`, { title: 'Hacked' })
  t('cross-space gift PUT (via personal header) -> 404', r.status === 404)
  r = await A.get('/api/state', { 'X-Space': String(shared.id + 999) })
  t('X-Space non-member falls back to personal', r.status === 200 && r.data.space_id === personalA.space_id)
  r = await C.get('/api/state', { 'X-Space': String(shared.id) })
  t('non-member X-Space gets own personal, not shared data', r.status === 200 && r.data.space_id !== shared.id && r.data.persons.length === 1)
  r = await C.get(`/api/spaces/${shared.id}/members`)
  t('non-member cannot list members', r.status === 404)

  // ---- Export/Import ----
  r = await A.get('/api/export')
  const exp = r.data
  r = await A.post('/api/import', exp)
  t('import own export (personal)', r.status === 200 && r.data.persons.length === 3 && r.data.gifts.length === 1 && r.data.persons.find((p) => p.is_me).name === 'Alice' && r.data.settings.currency === 'USD', r.data?.persons)
  r = await B.req('POST', '/api/import', exp, { 'X-Space': String(shared.id) })
  t('non-owner import -> 403', r.status === 403)
  r = await A.post('/api/demo')
  t('demo refused on non-empty space', r.status === 400)
  r = await C.post('/api/demo')
  t('demo into empty personal space', r.status === 200 && r.data.persons.length >= 5 && r.data.gifts.length === 5, r.status)

  // ---- v3: relationship, gift status, payment status, history ----
  A.space = null
  r = await A.get('/api/state')
  const ps = r.data
  const annaId = ps.persons.find((p) => p.name === 'Anna').id
  const tomId = ps.persons.find((p) => p.name === 'Tom').id
  const iAm = ps.persons.find((p) => p.is_me).id
  r = await A.put(`/api/persons/${annaId}`, { relationship: 'Partner', relationship_group: 'partner' })
  t('person relationship fields saved', r.status === 200 && r.data.persons.find((p) => p.id === annaId).relationship === 'Partner' && r.data.persons.find((p) => p.id === annaId).relationship_group === 'partner', r.status)
  r = await A.put(`/api/persons/${annaId}`, { relationship_group: 'unsinn' })
  t('invalid relationship_group -> 400', r.status === 400)
  const today = ps.today
  r = await A.post('/api/gifts', { title: 'Tickets', price: 90, status: 'ordered', payment_status: 'paid', payer_id: iAm, recipient_ids: [annaId], givers: [{ person_id: iAm }, { person_id: annaId }, { person_id: tomId }] })
  const g2 = r.data.gifts.find((g) => g.title === 'Tickets')
  t('create: ordered_at + paid_at auto-filled, 2 open shares of 30', g2.ordered_at === today && g2.paid_at === today && g2.payment_summary.open_count === 2 && g2.payment_summary.open_amount === 60 && g2.givers.find((x) => x.person_id === iAm).settled === 1, g2)
  r = await A.post(`/api/gifts/${g2.id}/status`, { status: 'nope' })
  t('invalid status -> 400', r.status === 400)
  r = await A.post(`/api/gifts/${g2.id}/status`, { status: 'shipped' })
  t('status -> shipped', r.status === 200 && r.data.gifts.find((g) => g.id === g2.id).status === 'shipped')
  r = await A.put(`/api/gifts/${g2.id}`, { carrier: 'DHL', tracking_number: 'ABC123', tracking_url: 'https://example.com/t', expected_at: '2030-01-02', order_number: 'N-1' })
  const g2b = r.data.gifts.find((g) => g.id === g2.id)
  t('PUT accepts tracking fields', g2b.carrier === 'DHL' && g2b.tracking_number === 'ABC123' && g2b.expected_at === '2030-01-02' && g2b.order_number === 'N-1', g2b)
  r = await A.post(`/api/gifts/${g2.id}/givers/${annaId}/settle`, { settled: true, method: 'Bar' })
  let gg = r.data.gifts.find((g) => g.id === g2.id)
  t('settle share: open 1 (30), settled_at/method', gg.payment_summary.open_count === 1 && gg.payment_summary.open_amount === 30 && gg.givers.find((x) => x.person_id === annaId).settled_at === today && gg.givers.find((x) => x.person_id === annaId).settle_method === 'Bar', gg)
  r = await A.post(`/api/gifts/${g2.id}/givers/${annaId}/settle`, { settled: false })
  gg = r.data.gifts.find((g) => g.id === g2.id)
  t('unsettle share', gg.payment_summary.open_count === 2 && gg.givers.find((x) => x.person_id === annaId).settled === 0 && gg.givers.find((x) => x.person_id === annaId).settled_at === null)
  r = await A.post(`/api/gifts/${g2.id}/givers/${omaId}/settle`, { settled: true })
  t('settle for non-giver -> 404', r.status === 404)
  r = await A.post(`/api/gifts/${g2.id}/payment`, { payment_status: 'unpaid' })
  gg = r.data.gifts.find((g) => g.id === g2.id)
  t('unpaid: nothing owed', gg.payment_status === 'unpaid' && gg.payment_summary.open_count === 0 && gg.paid_at === null, gg)
  r = await A.post('/api/gifts', { title: 'Ohne Zahler', price: 10, recipient_ids: [annaId] })
  const g3 = r.data.gifts.find((g) => g.title === 'Ohne Zahler')
  r = await A.post(`/api/gifts/${g3.id}/payment`, { payment_status: 'paid' })
  t('pay without payer -> 400', r.status === 400)
  r = await A.post(`/api/gifts/${g2.id}/payment`, { payment_status: 'paid', payer_id: iAm, payment_method: 'PayPal', paid_amount: 90 })
  gg = r.data.gifts.find((g) => g.id === g2.id)
  t('paid again: payer, method, 2 open', gg.payment_summary.open_count === 2 && gg.payment_method === 'PayPal' && gg.payment_summary.payer_id === iAm, gg)
  r = await A.post('/api/settle', { from_id: annaId, to_id: iAm, method: 'Bank transfer' })
  gg = r.data.gifts.find((g) => g.id === g2.id)
  t('bulk settle works, only Tom open', gg.payment_summary.open_count === 1 && gg.givers.find((x) => x.person_id === annaId).settle_method === 'Bank transfer')
  r = await A.post(`/api/gifts/${g2.id}/payment`, { payment_status: 'paid', payer_id: tomId })
  gg = r.data.gifts.find((g) => g.id === g2.id)
  t('payer who is a giver: own share never open', gg.payment_summary.payer_id === tomId && !gg.payment_summary.open_count !== undefined && gg.givers.find((x) => x.person_id === tomId).settled === 1)
  await A.put(`/api/gifts/${g2.id}`, { notes: 'Notiz' })
  r = await A.get(`/api/gifts/${g2.id}/events`)
  const types = r.data.map((e) => e.type)
  t('events endpoint: newest first, with user name', r.status === 200 && r.data[0].type === 'edited' && r.data[0].data.fields.includes('notes') && r.data[0].user_name === 'Alice' && types[types.length - 1] === 'created', r.data)
  t('events cover status/paid/unpaid/share_settled/share_unsettled', ['status', 'paid', 'unpaid', 'share_settled', 'share_unsettled'].every((x) => types.includes(x)), types)
  t('status event has from/to; share_settled has amount+method', r.data.some((e) => e.type === 'status' && e.data.from === 'ordered' && e.data.to === 'shipped') && r.data.some((e) => e.type === 'share_settled' && e.data.amount === 30 && e.data.method === 'Bar'), r.data)
  r = await A.get('/api/state')
  t('state has no events', !JSON.stringify(r.data).includes('gift_events') && !('events' in r.data.gifts[0]))
  r = await A.get(`/api/gifts/${secretGift}/events`)
  t('events of other space gift -> 404', r.status === 404)
  r = await A.req('GET', `/api/gifts/${secretGift}/events`, undefined, { 'X-Space': String(shared.id) })
  t('events visible to non-recipient in that space', r.status === 200 && r.data.some((e) => e.type === 'created'))
  r = await B.req('GET', `/api/gifts/${secretGift}/events`, undefined, { 'X-Space': String(shared.id) })
  t('events of hidden gift -> 404 for the recipient', r.status === 404)
  r = await new Client('anon3').get(`/api/gifts/${g2.id}/events`)
  t('events need login', r.status === 401)
  // Demo
  r = await C.get('/api/state')
  const cd = r.data
  const tee = cd.gifts.find((g) => g.title === 'Cast-iron teapot')
  const konz = cd.gifts.find((g) => g.title === 'Concert tickets')
  const kaff = cd.gifts.find((g) => g.title === 'Coffee grinder')
  t('demo: relationship fields', cd.persons.find((p) => p.name === 'Anna').relationship === 'Partner' && cd.persons.find((p) => p.name === 'Mum').relationship_group === 'family')
  t('demo: shipped with tracking', tee.status === 'shipped' && tee.tracking_number && tee.carrier === 'DHL' && tee.tracking_url && tee.expected_at, tee)
  t('demo: paid by me, two open shares', konz.payment_summary.paid && konz.payment_summary.open_count === 2 && konz.payment_summary.open_amount === 60, konz.payment_summary)
  t('demo: fully settled', kaff.payment_summary.paid && kaff.payment_summary.open_count === 0 && kaff.givers.find((x) => x.settled_at), kaff)
  r = await C.get(`/api/gifts/${tee.id}/events`)
  t('demo: events present', r.status === 200 && r.data.length >= 4)

  // ---- v4: space sharing, linking/merging persons, email auto-link ----
  const bobUid = (await B.get('/api/auth/me')).data.user.id
  const zedUid = (await Zc.get('/api/auth/me')).data.user.id
  const caraUid = (await C.get('/api/auth/me')).data.user.id
  A.space = null; B.space = null
  const teeW = (await B.get(`/api/wishlists/${L2.id}`)).data.wishes.find((w) => w.title === 'Tee').id
  r = await B.post(`/api/wishlists/${L2.id}/spaces`, { space_id: shared.id })
  t('share list with space', r.status === 200 && r.data.spaces.length === 1 && r.data.spaces[0].space_id === shared.id && r.data.spaces[0].name === 'With Bob' && r.data.spaces[0].member_count === 2, r.data)
  r = await A.get('/api/wishlists')
  const viaSp = r.data.shared.find((x) => x.id === L2.id)
  t('member sees it with via=space + space_name + is_new', viaSp && viaSp.via === 'space' && viaSp.space_name === 'With Bob' && viaSp.is_new === true, r.data.shared)
  t('shared_unseen counts it', (await A.get('/api/auth/me')).data.shared_unseen >= 1)
  r = await A.get(`/api/wishlists/${L2.id}`)
  t('detail marks seen', r.status === 200 && (await A.get('/api/wishlists')).data.shared.find((x) => x.id === L2.id).is_new === false)
  r = await Zc.get(`/api/wishlists/${L2.id}`)
  t('non-member has no access', r.status === 404)
  r = await A.post(`/api/wishes/${teeW}/reserve`, {})
  t('reserve via space access works', r.status === 200 && r.data.wishes.find((w) => w.id === teeW).reserved_by_me === true, r.status)
  r = await A.del(`/api/wishes/${teeW}/reserve`, {})
  t('release via space access', r.status === 200 && r.data.wishes.find((w) => w.id === teeW).reserved === false)
  r = await B.get(`/api/wishlists/${L2.id}`)
  t('owner sees no reservation fields', r.data.wishes.every((w) => !('reserved' in w)))
  A.space = shared.id
  sa = (await A.get('/api/state')).data
  t('linked_wishlists on owner person for members (via space)', (sa.persons.find((p) => p.linked_user_id === bobUid).linked_wishlists || []).some((l) => l.id === L2.id), sa.persons.find((p) => p.linked_user_id === bobUid))
  // members joining later
  r = await A.post(`/api/spaces/${shared.id}/invites`)
  const lateInv = r.data.token
  r = await Zc.post(`/api/invites/${lateInv}/accept`)
  t('Zed joins later', r.status === 200)
  r = await Zc.get('/api/wishlists')
  const zs = r.data.shared.find((x) => x.id === L2.id)
  t('late member gets access (new)', zs && zs.via === 'space' && zs.is_new === true, r.data.shared)
  t('late member shared_unseen = 1', (await Zc.get('/api/auth/me')).data.shared_unseen === 1)
  r = await Zc.del(`/api/spaces/${shared.id}/members/${zedUid}`)
  t('Zed leaves space', r.status === 200)
  r = await Zc.get(`/api/wishlists/${L2.id}`)
  t('leaving the space removes access', r.status === 404 && (await Zc.get('/api/wishlists')).data.shared.length === 0)
  // Precedence direct > space > link
  r = await B.post(`/api/wishlists/${L2.id}/access`, { user_id: (await B.get('/api/users/known')).data.find((u) => u.name === 'Alice').id })
  t('direct preferred over space', (await A.get('/api/wishlists')).data.shared.find((x) => x.id === L2.id).via === 'direct')
  r = await B.del(`/api/wishlists/${L2.id}/access/${sa.user_id}`)
  t('removing direct falls back to space', (await A.get('/api/wishlists')).data.shared.find((x) => x.id === L2.id)?.via === 'space')
  const otherSpace = (await A.post('/api/spaces', { name: 'Nur Alice' })).data.spaces.find((s) => s.name === 'Nur Alice')
  r = await B.post(`/api/wishlists/${L2.id}/spaces`, { space_id: otherSpace.id })
  t('owner cannot share with foreign space', r.status === 404)
  r = await B.post(`/api/wishlists/${L2.id}/spaces`, { space_id: (await B.get('/api/auth/me')).data.spaces.find((s) => s.personal).id })
  t('cannot share with personal space', r.status === 400)
  r = await A.post(`/api/wishlists/${L2.id}/spaces`, { space_id: shared.id })
  t('non-owner cannot manage space shares', r.status === 404)
  await B.post(`/api/wishlists/${L1.id}/spaces`, { space_id: shared.id })

  // Merge persons
  const mkp = async (b) => (await A.post('/api/persons', b)).data.persons.find((p) => p.name === b.name)
  const bobbyP = await mkp({ name: 'Bobby', birthday: '1990-06-01', notes: 'Likes blue', relationship: 'Brother', email: 'bobby@example.com' })
  t('person email exposed', bobbyP.email === 'bobby@example.com')
  r = await A.post('/api/persons', { name: 'Kaputt', email: 'kein-mail' })
  t('invalid person email -> 400', r.status === 400)
  r = await A.put(`/api/persons/${bobP}`, { emoji: '🎸', birthday: '1985-01-01' })
  sa = (await A.get('/api/state')).data
  const occB = (await A.post('/api/occasions', { name: 'Feier', date: '2031-01-01', person_ids: [bobbyP.id, bobP, omaId] })).data.occasions.find((o) => o.name === 'Feier')
  const gX = (await A.post('/api/gifts', { title: 'Secret for Bobby', price: 50, recipient_ids: [bobbyP.id], givers: [{ person_id: aliceP }], payer_id: aliceP })).data.gifts.find((g) => g.title === 'Secret for Bobby')
  await A.post('/api/items', { person_id: bobbyP.id, title: 'Idea for Bobby' })
  const gY = (await A.post('/api/gifts', { title: 'Grandma split', price: 100, status: 'delivered', payment_status: 'paid', payer_id: bobP, occasion_id: occB.id, recipient_ids: [omaId], givers: [{ person_id: bobP, amount: 10 }, { person_id: aliceP }] })).data.gifts.find((g) => g.title === 'Grandma split')
  const gZ = (await A.post('/api/gifts', { title: 'Beide Schenkende', price: 60, recipient_ids: [omaId], givers: [{ person_id: bobbyP.id, amount: 20 }, { person_id: bobP, amount: 5 }] })).data.gifts.find((g) => g.title === 'Beide Schenkende')
  sb = (await B.req('GET', '/api/state', undefined, { 'X-Space': String(shared.id) })).data
  t('before link: B sees gift/idea for Bobby (not yet him)', sb.gifts.some((g) => g.title === 'Secret for Bobby') && sb.items.some((i) => i.title === 'Idea for Bobby'))
  r = await A.post(`/api/persons/${omaId}/link`, { user_id: zedUid })
  t('link to unrelated user -> 404', r.status === 404, r.status)
  r = await A.post(`/api/persons/${bobbyP.id}/link`, { user_id: bobUid })
  const ms = r.data
  const bobby2 = ms.persons.find((p) => p.id === bobbyP.id)
  t('merge: kept manual person, linked, auto person gone', r.status === 200 && bobby2.linked_user_id === bobUid && bobby2.name === 'Bobby' && !ms.persons.some((p) => p.id === bobP) && ms.persons.filter((p) => p.linked_user_id === bobUid).length === 1, ms.persons)
  t('merge: kept notes/birthday, filled empty emoji', bobby2.notes === 'Likes blue' && bobby2.birthday === '1990-06-01' && bobby2.emoji === '🎸' && bobby2.relationship === 'Brother')
  const my = (n) => ms.gifts.find((g) => g.title === n)
  t('merge: payer + giver amount moved', my('Grandma split').payer_id === bobbyP.id && my('Grandma split').givers.some((g) => g.person_id === bobbyP.id && g.amount === 10) && !my('Grandma split').givers.some((g) => g.person_id === bobP), my('Grandma split'))
  t('merge: shares of both combined, no duplicates', my('Beide Schenkende').givers.length === 1 && my('Beide Schenkende').givers[0].amount === 25, my('Beide Schenkende').givers)
  t('merge: occasion persons without duplicates', ms.occasions.find((o) => o.name === 'Feier').person_ids.filter((x) => x === bobbyP.id).length === 1 && !ms.occasions.find((o) => o.name === 'Feier').person_ids.includes(bobP))
  t('merge: only one birthday occasion for Bobby', ms.occasions.filter((o) => o.type === 'birthday' && o.person_id === bobbyP.id && o.date >= ms.today).length === 1, ms.occasions.filter((o) => o.person_id === bobbyP.id))
  r = await A.get(`/api/gifts/${gZ.id}/events`)
  t('merge: gift events written', r.data.some((e) => e.type === 'edited' && e.data.reason === 'person_merge' && e.data.fields.includes('givers')), r.data)
  sb = (await B.req('GET', '/api/state', undefined, { 'X-Space': String(shared.id) })).data
  t('after link: surprise protection (gift+idea for Bobby hidden from Bob)', !JSON.stringify(sb).includes('Secret for Bobby') && !JSON.stringify(sb).includes('Idea for Bobby') && sb.persons.find((p) => p.is_me).id === bobbyP.id, sb.persons)
  r = await B.req('PUT', `/api/gifts/${gX.id}`, { title: 'x' }, { 'X-Space': String(shared.id) })
  t('after link: PUT on newly hidden gift -> 404', r.status === 404)
  t('after link: gift with Bob as GIVER stays visible', sb.gifts.some((g) => g.title === 'Grandma split'))
  r = await A.post(`/api/persons/${bobbyP.id}/unlink`)
  t('unlink of member person -> 400', r.status === 400)
  const em = await mkp({ name: 'Cara Mail', email: 'CARA@Example.com' })
  r = await A.post(`/api/spaces/${shared.id}/invites`)
  r = await C.post(`/api/invites/${r.data.token}/accept`)
  sa = (await A.get('/api/state')).data
  const caraPersons = sa.persons.filter((p) => p.linked_user_id === caraUid)
  t('email auto-link: unlinked person with same email is linked, no duplicate', r.status === 200 && caraPersons.length === 1 && caraPersons[0].id === em.id && caraPersons[0].name === 'Cara Mail' && sa.persons.filter((p) => /^cara$/i.test(p.name)).length === 0, sa.persons.map((p) => [p.name, p.linked_user_id]))
  // Members edit all persons
  r = await B.req('PUT', `/api/persons/${omaId}`, { notes: 'von Bob' }, { 'X-Space': String(shared.id) })
  t('every member edits all persons', r.status === 200 && r.data.persons.find((p) => p.id === omaId).notes === 'von Bob')
  A.space = null

  // ---- Spaces management ----
  r = await A.del(`/api/spaces/${(await A.get('/api/auth/me')).data.spaces.find((s) => s.personal).id}`)
  t('cannot delete personal space', r.status === 400)
  r = await B.del(`/api/spaces/${shared.id}/members/${aliceId}`)
  t('member cannot remove others', r.status === 403)
  r = await B.del(`/api/spaces/${shared.id}/members/${(await B.get('/api/auth/me')).data.user.id}`)
  t('member can leave', r.status === 200 && !r.data.spaces.some((s) => s.id === shared.id), r.data)
  t('owner leaving removes space shares of his lists', !(await A.get('/api/wishlists')).data.shared.some((x) => x.id === L1.id || x.id === L2.id) && (await B.get('/api/wishlists')).data.mine.every((l) => l.spaces.length === 0))
  A.space = shared.id
  sa = (await A.get('/api/state')).data
  t('after leave: person unlinked but kept, A still sees hidden data', sa.persons.some((p) => p.name === 'Bobby' && p.linked_user_id === null) && sa.gifts.some((g) => g.title === 'Secret gift for Bob'))
  r = await A.del(`/api/spaces/${shared.id}`)
  t('owner deletes shared space', r.status === 200 && !r.data.spaces.some((s) => s.id === shared.id))

  // ---- Account ----
  r = await B.put('/api/account', { new_password: 'newbob123', current_password: 'nope' })
  t('wrong current password rejected', r.status === 400)
  r = await B.put('/api/account', { new_password: 'newbob123', current_password: 'secret456', name: 'Bobby' })
  t('change password + name', r.status === 200 && r.data.user.name === 'Bobby')
  r = await B.del('/api/account/google')
  t('unlink google w/o link ok (has password)', r.status === 200)

  // ---- Images / preview require login ----
  r = await new Client('anon').get('/api/images/' + 'a'.repeat(40) + '.jpg')
  t('images require login', r.status === 401)
  r = await new Client('anon').post('/api/preview', { url: 'https://example.com' })
  t('preview requires login', r.status === 401)

  // ---- Backups (admin) ----
  r = await A.get('/api/admin/backups')
  t('backups status for admin', r.status === 200 && Array.isArray(r.data.backups), r.status)

  // ---- Logout ----
  const oldCookie = A.cookies.wl_session
  r = await A.post('/api/auth/logout')
  t('logout ok', r.status === 200)
  const Z = new Client('Z'); Z.cookies.wl_session = oldCookie
  r = await Z.get('/api/auth/me')
  t('logout invalidates session server-side', r.status === 401)

  // ---- Rate limit ----
  const L = new Client('L')
  let last
  for (let i = 0; i < 12; i++) last = await L.post('/api/auth/login', { email: 'ratelimit@example.com', password: 'x' + i })
  t('login rate limit -> 429', last.status === 429, last.status)

  // ---- Restart ----
  await stop()
  await start()
  r = await A.post('/api/auth/login', { email: 'alice@example.com', password: 'secret123' })
  t('restart: login still works', r.status === 200)
  A.space = null
  r = await A.get('/api/state')
  t('restart: data intact', r.status === 200 && r.data.persons.length >= 3)

  // Security headers (review): on frontend, API and images; image preview (data:/blob:) stays allowed
  r = await A.get('/api/state')
  const hv = (n) => r.headers.get(n) || ''
  t('security headers on API responses', hv('x-content-type-options') === 'nosniff' && hv('x-frame-options') === 'DENY' && hv('referrer-policy') === 'same-origin' && /frame-ancestors 'none'/.test(hv('content-security-policy')) && /img-src 'self' data: blob:/.test(hv('content-security-policy')))
  r = await A.get('/api/gibtsnicht')
  t('security headers on 404 JSON too', /default-src 'self'/.test(hv('content-security-policy')))
  r = await fetch(BASE + '/')
  t('security headers on the frontend', (r.headers.get('content-security-policy') || '').includes("script-src 'self'") && !(r.headers.get('strict-transport-security')), r.headers.get('content-security-policy'))
}

try {
  await main()
} catch (e) {
  results.push('CRASH ' + e.stack)
  failN++
} finally {
  try { await stop() } catch {}
  console.log(results.filter((x) => !x.startsWith('PASS')).join('\n'))
  console.log(`\n${pass} passed, ${failN} failed`)
  await new Promise((r) => setTimeout(r, 500))
  fs.rmSync(DATA, { recursive: true, force: true })
}
