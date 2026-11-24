// Offline sync, server side: idempotent writes (X-Op-Id) for every offline-capable route family, X-Created-Id, the space fallback guard
// (space_gone), isolation of op ids between users, surprise protection for repeated responses, retention of old ops, the web app
// manifest, caching headers (service worker, hashed assets, theme-init.js), CSP worker/manifest directives and 404s for missing build files.
// The server runs with its own fake `dist` as working directory, so the project's real dist/ is not used.
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TMP = path.join(os.tmpdir(), 'wl-offline-' + Date.now())
const DATA = path.join(TMP, 'data')
const CWD = path.join(TMP, 'cwd')
const PORT = Number(process.env.SMOKE_PORT) || 4134
const BASE = `http://127.0.0.1:${PORT}`
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(path.join(CWD, 'dist', 'assets'), { recursive: true })
fs.cpSync(path.join(ROOT, 'public', 'icons'), path.join(CWD, 'dist', 'icons'), { recursive: true })
fs.writeFileSync(path.join(CWD, 'dist', 'index.html'), '<!doctype html><html><head><title>Wishy</title></head><body><div id="root"></div></body></html>')
fs.writeFileSync(path.join(CWD, 'dist', 'sw.js'), '// service worker')
fs.writeFileSync(path.join(CWD, 'dist', 'assets', 'index-AbCd1234.js'), 'console.log(1)')
fs.writeFileSync(path.join(CWD, 'dist', 'assets', 'inter-latin-wght-normal-Zy9xW8vU.woff2'), 'font')
fs.writeFileSync(path.join(CWD, 'dist', 'assets', 'theme-init.js'), '// theme')

let server
const start = () => new Promise((resolve, reject) => {
  server = spawn('node', [path.join(ROOT, 'server', 'index.js')], { cwd: CWD, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), PREVIEW_BROWSER: 'off' } })
  let out = ''
  server.stdout.on('data', (d) => { out += d; if (out.includes('is running')) resolve() })
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))
  server.on('exit', (c) => reject(new Error('server exit ' + c)))
})
const stop = () => new Promise((r) => { server.removeAllListeners('exit'); server.on('exit', r); server.kill() })

class Client {
  constructor() { this.cookies = {}; this.space = null }
  async req(method, url, body, headers = {}) {
    const h = { ...headers }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    else if (method !== 'GET') h['X-Requested-With'] = 'x'
    if (this.space && !h['X-Space'] && h['X-Space'] !== null) h['X-Space'] = String(this.space)
    if (h['X-Space'] === null) delete h['X-Space']
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    if (ck) h.Cookie = ck
    const res = await fetch(BASE + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' })
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      if (/Max-Age=0/i.test(c)) delete this.cookies[kv.slice(0, i)]; else this.cookies[kv.slice(0, i)] = kv.slice(i + 1)
    }
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch {}
    return { status: res.status, data, text, headers: res.headers, created: res.headers.get('x-created-id') }
  }
  get(u, h) { return this.req('GET', u, undefined, h) }
  post(u, b = {}, h) { return this.req('POST', u, b, h) }
  put(u, b = {}, h) { return this.req('PUT', u, b, h) }
  del(u, h) { return this.req('DELETE', u, undefined, h) }
}

let pass = 0, failN = 0
const results = []
const t = (name, cond, extra) => {
  if (cond) pass++
  else { failN++; results.push('FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 400) : '')) }
}
const ok = (r) => r.status === 200
const op = () => ({ 'X-Op-Id': randomUUID() })
const rawDb = () => new DatabaseSync(path.join(DATA, 'wishlist.db'), { timeout: 5000 }) // the server writes at the same time
const count = (sql, ...p) => { const d = rawDb(); try { return d.prepare(sql).get(...p).n } finally { d.close() } }
const opRows = () => count('SELECT COUNT(*) AS n FROM client_ops')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const A = new Client(), B = new Client(), C = new Client()
  await start()
  let r = await A.post('/api/auth/setup', { name: 'Alice', email: 'alice@example.com', password: 'secret123' })
  t('setup', ok(r), r.data)
  const inv = async () => (await A.post('/api/admin/invites', {})).data.url.split('=')[1]
  r = await B.post('/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'secret456', invite: await inv() })
  t('register Bob', ok(r), r.data)
  r = await C.post('/api/auth/register', { name: 'Carol', email: 'carol@example.com', password: 'secret789', invite: await inv() })
  t('register Carol', ok(r), r.data)

  r = await A.post('/api/spaces', { name: 'Team' })
  const team = r.data.spaces.find((s) => s.name === 'Team')
  r = await A.post(`/api/spaces/${team.id}/invites`)
  r = await B.post(`/api/invites/${r.data.token}/accept`)
  t('Bob joined the team space', ok(r), r.data)
  A.space = team.id; B.space = team.id
  const aliceTeamState = async () => (await A.get('/api/state')).data
  const bobState = async () => (await B.get('/api/state')).data

  // ---------- X-Created-Id without an op id ----------
  r = await A.post('/api/persons', { name: 'Anna' })
  const anna = r.data.persons.find((p) => p.name === 'Anna')
  t('create without op id: X-Created-Id is the new row', r.created === String(anna.id), [r.created, anna.id])
  r = await A.put(`/api/persons/${anna.id}`, { name: 'Anna' })
  t('X-Created-Id only on creates', ok(r) && r.created === null)
  r = await A.post('/api/persons', {})
  t('failed create: no X-Created-Id', r.status === 400 && r.created === null)
  t('no op id: nothing recorded', opRows() === 0)

  // ---------- persons ----------
  let o = op()
  r = await A.post('/api/persons', { name: 'Bea', birthday: '1990-04-02' }, o)
  const bea = r.data.persons.find((p) => p.name === 'Bea')
  t('persons: create with op id', ok(r) && r.created === String(bea.id))
  const personsBefore = (await aliceTeamState()).persons.length
  r = await A.post('/api/persons', { name: 'Bea', birthday: '1990-04-02' }, o)
  t('persons: repeat -> 200, same created id, no second row', ok(r) && r.created === String(bea.id) && r.data.persons.length === personsBefore && r.data.persons.filter((p) => p.name === 'Bea').length === 1, r.data?.persons?.length)
  r = await A.put(`/api/persons/${bea.id}`, { name: 'Beatrice' })
  r = await A.post('/api/persons', { name: 'Bea', birthday: '1990-04-02' }, o)
  t('persons: repeat after a later edit returns the current state', ok(r) && r.data.persons.find((p) => p.id === bea.id)?.name === 'Beatrice' && r.created === String(bea.id))
  r = await A.post('/api/persons', { name: 'Bea', birthday: '1990-04-02' }, { 'X-Op-Id': o['X-Op-Id'].toUpperCase() })
  t('persons: op ids are case-insensitive', ok(r) && r.created === String(bea.id) && r.data.persons.length === personsBefore)
  o = op()
  r = await A.put(`/api/persons/${bea.id}`, { name: 'Bea first' }, o)
  t('persons: PUT with op id', ok(r) && r.data.persons.find((p) => p.id === bea.id).name === 'Bea first')
  await A.put(`/api/persons/${bea.id}`, { name: 'Bea second' })
  r = await A.put(`/api/persons/${bea.id}`, { name: 'Bea first' }, o)
  t('persons: PUT repeat does not apply again', ok(r) && r.data.persons.find((p) => p.id === bea.id).name === 'Bea second')
  o = op()
  r = await A.post('/api/persons', { name: 'Temp' }, o)
  const temp = r.data.persons.find((p) => p.name === 'Temp')
  o = op()
  r = await A.del(`/api/persons/${temp.id}`, o)
  t('persons: DELETE with op id', ok(r) && !r.data.persons.some((p) => p.id === temp.id))
  r = await A.del(`/api/persons/${temp.id}`, o)
  t('persons: DELETE repeat -> 200 (not 404)', ok(r) && !r.data.persons.some((p) => p.id === temp.id))
  r = await A.del(`/api/persons/${temp.id}`)
  t('persons: DELETE of a gone row without op id -> 404', r.status === 404)

  // ---------- failed ops are not recorded ----------
  o = op()
  let n0 = opRows()
  r = await A.post('/api/persons', {}, o)
  t('failed op: 400 and nothing recorded', r.status === 400 && opRows() === n0 && r.created === null, r.data)
  r = await A.post('/api/persons', { name: 'After failure' }, o)
  t('failed op: the same id can be used for a corrected request', ok(r) && r.created !== null && opRows() === n0 + 1)
  r = await A.post('/api/gifts', { title: 'No recipient' }, op())
  t('failed op (gift without recipient): rolled back', r.status === 400 && r.data.code === 'recipient_required' && !(await aliceTeamState()).gifts.some((g) => g.title === 'No recipient'))

  // ---------- reuse / malformed ----------
  o = op()
  r = await A.post('/api/persons', { name: 'Reuse' }, o)
  const reuse = r.data.persons.find((p) => p.name === 'Reuse')
  r = await A.put(`/api/persons/${reuse.id}`, { name: 'x' }, o)
  t('op id reused for another method -> 422 op_id_reused', r.status === 422 && r.data.code === 'op_id_reused', r.data)
  r = await A.post('/api/occasions', { name: 'Reuse', date: '2031-01-01' }, o)
  t('op id reused for another path -> 422 op_id_reused', r.status === 422 && r.data.code === 'op_id_reused')
  t('reuse did not create anything', !(await aliceTeamState()).occasions.some((x) => x.name === 'Reuse'))
  r = await A.post('/api/persons', { name: 'Bad op' }, { 'X-Op-Id': 'not-a-uuid' })
  t('malformed op id -> 400 op_id_invalid', r.status === 400 && r.data.code === 'op_id_invalid' && !(await aliceTeamState()).persons.some((p) => p.name === 'Bad op'))
  r = await A.put('/api/settings', { currency: 'CHF' }, { 'X-Op-Id': 'not-a-uuid' })
  n0 = opRows()
  t('other routes ignore a malformed op id', ok(r))
  o = op()
  await A.put('/api/settings', { currency: 'EUR' }, o)
  await A.put('/api/settings', { currency: 'EUR' }, o)
  t('other routes: op id is not recorded', opRows() === n0)
  r = await A.post('/api/ai/status', {}, { 'X-Op-Id': 'garbage' })
  t('non-offline POST with garbage op id is not touched by the op logic', r.data?.code !== 'op_id_invalid')

  // ---------- isolation between users ----------
  o = op()
  r = await A.post('/api/persons', { name: 'Alice op' }, o)
  const aliceOpPerson = r.created
  r = await B.post('/api/persons', { name: 'Bob with Alice op id' }, o)
  const bobsPerson = r.data.persons.find((p) => p.name === 'Bob with Alice op id')
  t('another user\'s op id is unknown to me: the handler runs and creates my own row', ok(r) && bobsPerson && r.created === String(bobsPerson.id) && r.created !== aliceOpPerson)
  r = await B.post('/api/persons', { name: 'Bob with Alice op id' }, o)
  t('...and is recorded for me (repeat dedups)', ok(r) && r.created === String(bobsPerson.id) && r.data.persons.filter((p) => p.name === 'Bob with Alice op id').length === 1)
  r = await A.get('/api/state')
  t('Alice\'s row is untouched by Bob\'s use of her op id', r.data.persons.filter((p) => p.name === 'Alice op').length === 1 && !r.data.persons.some((p) => p.name === 'Bob with Alice op id' && p.id === Number(aliceOpPerson)))
  // A Bob op id replayed by Alice does not return Bob's data
  const bobOp = op()
  r = await B.post('/api/persons', { name: 'Bob only' }, bobOp)
  const bobOnly = r.created
  r = await A.post('/api/persons', { name: 'Alice replays' }, bobOp)
  t('Alice using a Bob op id creates her own row and gets no info about Bob\'s', ok(r) && r.created !== bobOnly && r.data.persons.some((p) => p.name === 'Alice replays'))
  t('op rows are per user', count('SELECT COUNT(*) AS n FROM client_ops WHERE op_id=?', bobOp['X-Op-Id']) === 2)

  // ---------- occasions ----------
  o = op()
  r = await A.post('/api/occasions', { name: 'Party', type: 'other', date: '2032-05-05', person_ids: [anna.id, bea.id], audience: 'selected' }, o)
  const party = r.data.occasions.find((x) => x.name === 'Party')
  t('occasions: create with op id', ok(r) && r.created === String(party.id))
  r = await A.post('/api/occasions', { name: 'Party', type: 'other', date: '2032-05-05', person_ids: [anna.id, bea.id], audience: 'selected' }, o)
  t('occasions: repeat -> one row, same created id', ok(r) && r.created === String(party.id) && r.data.occasions.filter((x) => x.name === 'Party').length === 1)
  o = op()
  r = await A.put(`/api/occasions/${party.id}`, { name: 'Party 1' }, o)
  await A.put(`/api/occasions/${party.id}`, { name: 'Party 2' })
  r = await A.put(`/api/occasions/${party.id}`, { name: 'Party 1' }, o)
  t('occasions: PUT repeat returns the current state', ok(r) && r.data.occasions.find((x) => x.id === party.id).name === 'Party 2')
  o = op()
  r = await A.put(`/api/occasions/${party.id}/persons/${anna.id}`, { excluded: true }, o)
  t('occasions: exclude person with op id', ok(r) && r.data.occasions.find((x) => x.id === party.id).excluded_ids.includes(anna.id), r.data?.occasions?.find((x) => x.id === party.id))
  await A.put(`/api/occasions/${party.id}/persons/${anna.id}`, { excluded: false })
  r = await A.put(`/api/occasions/${party.id}/persons/${anna.id}`, { excluded: true }, o)
  t('occasions: exclude repeat does not apply again', ok(r) && !r.data.occasions.find((x) => x.id === party.id).excluded_ids.includes(anna.id))
  o = op()
  r = await A.post('/api/occasions', { name: 'Gone soon', type: 'other', date: '2032-06-06' }, o)
  const gone = r.created
  const od = op()
  await A.del(`/api/occasions/${gone}`, od)
  r = await A.del(`/api/occasions/${gone}`, od)
  t('occasions: DELETE repeat -> 200', ok(r) && !r.data.occasions.some((x) => x.id === Number(gone)))

  // ---------- items (ideas) ----------
  o = op()
  r = await A.post('/api/items', { title: 'Book', person_id: anna.id }, o)
  const book = r.data.items.find((i) => i.title === 'Book')
  t('items: create with op id', ok(r) && r.created === String(book.id))
  r = await A.post('/api/items', { title: 'Book', person_id: anna.id }, o)
  t('items: repeat -> one row, same created id', ok(r) && r.created === String(book.id) && r.data.items.filter((i) => i.title === 'Book').length === 1)
  r = await A.post('/api/items', { title: 'Inbox idea' }, op())
  const inbox = r.data.inbox_items.find((i) => i.title === 'Inbox idea')
  t('items: idea without a person lands in the inbox, created id sent', ok(r) && r.created === String(inbox.id))
  o = op()
  r = await A.post(`/api/items/${inbox.id}/assign`, { person_id: bea.id }, o)
  t('items: assign with op id', ok(r) && r.data.items.find((i) => i.id === inbox.id)?.person_id === bea.id)
  r = await A.post(`/api/items/${inbox.id}/assign`, { person_id: bea.id }, o)
  t('items: assign repeat -> 200 (a plain repeat would be not_in_inbox)', ok(r))
  r = await A.post(`/api/items/${inbox.id}/assign`, { person_id: bea.id })
  t('items: assign without op id twice -> 400 not_in_inbox', r.status === 400 && r.data.code === 'not_in_inbox')
  o = op()
  await A.put(`/api/items/${book.id}`, { title: 'Book 1' }, o)
  await A.put(`/api/items/${book.id}`, { title: 'Book 2' })
  r = await A.put(`/api/items/${book.id}`, { title: 'Book 1' }, o)
  t('items: PUT repeat returns the current state', ok(r) && r.data.items.find((i) => i.id === book.id).title === 'Book 2')
  o = op()
  await A.del(`/api/items/${inbox.id}`, o)
  r = await A.del(`/api/items/${inbox.id}`, o)
  t('items: DELETE repeat -> 200', ok(r) && !r.data.items.some((i) => i.id === inbox.id))

  // ---------- gifts ----------
  o = op()
  const giftBody = { title: 'Scarf', price: 25, recipient_ids: [anna.id], occasion_id: party.id, givers: [{ person_id: bea.id, amount: 25 }] }
  r = await A.post('/api/gifts', giftBody, o)
  const scarf = r.data.gifts.find((g) => g.title === 'Scarf')
  t('gifts: create with op id', ok(r) && r.created === String(scarf.id))
  r = await A.post('/api/gifts', giftBody, o)
  t('gifts: repeat -> one row, same created id', ok(r) && r.created === String(scarf.id) && r.data.gifts.filter((g) => g.title === 'Scarf').length === 1)
  t('gifts: only one "created" event', count('SELECT COUNT(*) AS n FROM gift_events WHERE gift_id=?', scarf.id) === 1)
  o = op()
  await A.put(`/api/gifts/${scarf.id}`, { title: 'Scarf v1' }, o)
  await A.put(`/api/gifts/${scarf.id}`, { title: 'Scarf v2' })
  r = await A.put(`/api/gifts/${scarf.id}`, { title: 'Scarf v1' }, o)
  t('gifts: PUT repeat returns the current state', ok(r) && r.data.gifts.find((g) => g.id === scarf.id).title === 'Scarf v2')
  o = op()
  r = await A.post(`/api/gifts/${scarf.id}/status`, { status: 'ordered' }, o)
  t('gifts: status with op id', ok(r) && r.data.gifts.find((g) => g.id === scarf.id).status === 'ordered')
  await A.post(`/api/gifts/${scarf.id}/status`, { status: 'delivered' })
  r = await A.post(`/api/gifts/${scarf.id}/status`, { status: 'ordered' }, o)
  const evBefore = count('SELECT COUNT(*) AS n FROM gift_events WHERE gift_id=?', scarf.id)
  t('gifts: status repeat does not apply again', ok(r) && r.data.gifts.find((g) => g.id === scarf.id).status === 'delivered')
  o = op()
  r = await A.post(`/api/gifts/${scarf.id}/payment`, { payment_status: 'paid', payer_id: anna.id, paid_amount: 25 }, o)
  t('gifts: payment with op id', ok(r) && r.data.gifts.find((g) => g.id === scarf.id).payment_status === 'paid', r.data)
  await A.post(`/api/gifts/${scarf.id}/payment`, { payment_status: 'unpaid' })
  r = await A.post(`/api/gifts/${scarf.id}/payment`, { payment_status: 'paid', payer_id: anna.id, paid_amount: 25 }, o)
  t('gifts: payment repeat does not apply again', ok(r) && r.data.gifts.find((g) => g.id === scarf.id).payment_status === 'unpaid')
  await A.post(`/api/gifts/${scarf.id}/payment`, { payment_status: 'paid', payer_id: anna.id, paid_amount: 25 })
  o = op()
  r = await A.post(`/api/gifts/${scarf.id}/givers/${bea.id}/settle`, { settled: true, method: 'cash' }, o)
  const settledOf = (st) => st.gifts.find((g) => g.id === scarf.id).givers.find((x) => x.person_id === bea.id)?.settled
  t('gifts: settle with op id', ok(r) && settledOf(r.data) === 1, r.data?.gifts?.find((g) => g.id === scarf.id)?.givers)
  await A.post(`/api/gifts/${scarf.id}/givers/${bea.id}/settle`, { settled: false })
  r = await A.post(`/api/gifts/${scarf.id}/givers/${bea.id}/settle`, { settled: true, method: 'cash' }, o)
  t('gifts: settle repeat does not apply again', ok(r) && settledOf(r.data) === 0)
  const evAfter = count('SELECT COUNT(*) AS n FROM gift_events WHERE gift_id=?', scarf.id)
  t('gifts: repeats wrote no further events', evAfter >= evBefore && count("SELECT COUNT(*) AS n FROM gift_events WHERE gift_id=? AND type='share_settled'", scarf.id) === 1)
  o = op()
  await A.del(`/api/gifts/${scarf.id}`, o)
  r = await A.del(`/api/gifts/${scarf.id}`, o)
  t('gifts: DELETE repeat -> 200', ok(r) && !r.data.gifts.some((g) => g.id === scarf.id))

  // ---------- wishlists, wishes ----------
  o = op()
  r = await A.post('/api/wishlists', { title: 'Birthday' }, o)
  const list = r.data
  t('wishlists: create with op id (view + created id)', ok(r) && list.title === 'Birthday' && r.created === String(list.id))
  r = await A.post('/api/wishlists', { title: 'Birthday' }, o)
  t('wishlists: repeat -> same list, same created id', ok(r) && r.data.id === list.id && r.created === String(list.id))
  t('wishlists: exactly one list', (await A.get('/api/wishlists')).data.mine.filter((l) => l.title === 'Birthday').length === 1)
  o = op()
  await A.put(`/api/wishlists/${list.id}`, { title: 'Birthday 1' }, o)
  await A.put(`/api/wishlists/${list.id}`, { title: 'Birthday 2' })
  r = await A.put(`/api/wishlists/${list.id}`, { title: 'Birthday 1' }, o)
  t('wishlists: PUT repeat returns the current list', ok(r) && r.data.title === 'Birthday 2')
  o = op()
  r = await A.post(`/api/wishlists/${list.id}/wishes`, { title: 'Headphones', price: 99 }, o)
  const wish = r.data.wishes.find((w) => w.title === 'Headphones')
  t('wishes: create with op id (detail view + created id)', ok(r) && r.created === String(wish.id) && r.data.is_owner === true)
  r = await A.post(`/api/wishlists/${list.id}/wishes`, { title: 'Headphones', price: 99 }, o)
  t('wishes: repeat -> one wish, same created id', ok(r) && r.created === String(wish.id) && r.data.wishes.filter((w) => w.title === 'Headphones').length === 1)
  const o2 = op()
  r = await A.post(`/api/wishlists/${list.id}/wishes`, { title: 'Book' }, o2)
  const wish2 = r.data.wishes.find((w) => w.title === 'Book')
  o = op()
  await A.put(`/api/wishes/${wish.id}`, { title: 'Headphones 1' }, o)
  await A.put(`/api/wishes/${wish.id}`, { title: 'Headphones 2' })
  r = await A.put(`/api/wishes/${wish.id}`, { title: 'Headphones 1' }, o)
  t('wishes: PUT repeat returns the current list', ok(r) && r.data.wishes.find((w) => w.id === wish.id).title === 'Headphones 2')
  o = op()
  r = await A.post(`/api/wishlists/${list.id}/reorder`, { ids: [wish2.id, wish.id] }, o)
  t('wishes: reorder with op id', ok(r) && r.data.wishes[0].id === wish2.id)
  await A.post(`/api/wishlists/${list.id}/reorder`, { ids: [wish.id, wish2.id] })
  r = await A.post(`/api/wishlists/${list.id}/reorder`, { ids: [wish2.id, wish.id] }, o)
  t('wishes: reorder repeat does not apply again', ok(r) && r.data.wishes[0].id === wish.id)
  o = op()
  r = await A.del(`/api/wishes/${wish2.id}`, o)
  t('wishes: DELETE with op id', ok(r) && !r.data.wishes.some((w) => w.id === wish2.id))
  r = await A.del(`/api/wishes/${wish2.id}`, o)
  t('wishes: DELETE repeat -> 200 with the list view', ok(r) && r.data.wishlist?.id === list.id && !r.data.wishes.some((w) => w.id === wish2.id), r.data)
  // another user cannot read the list through a repeat of their own op id on someone else's ids
  r = await B.put(`/api/wishes/${wish.id}`, { title: 'Hack' }, op())
  t('wishes: another user\'s PUT with a fresh op id -> 404, nothing recorded for the failure', r.status === 404)
  const stolen = op()
  await B.post('/api/wishlists', { title: 'Bob list' }, stolen)
  r = await B.del(`/api/wishes/${wish.id}`, stolen)
  t('wishes: repeat/reuse of an op id on another path -> 422, wish untouched', r.status === 422 && (await A.get(`/api/wishlists/${list.id}`)).data.wishes.some((w) => w.id === wish.id))
  o = op()
  r = await A.del(`/api/wishlists/${list.id}`, o)
  t('wishlists: DELETE with op id', ok(r) && r.data.ok === true)
  r = await A.del(`/api/wishlists/${list.id}`, o)
  t('wishlists: DELETE repeat -> 200 {ok}', ok(r) && r.data.ok === true)
  r = await A.post('/api/wishlists', { title: 'Birthday' }, o)
  t('wishlists: reusing the delete op id for a create -> 422', r.status === 422 && r.data.code === 'op_id_reused')

  // ---------- permissions ----------
  await A.put(`/api/spaces/${team.id}/members/${(await B.get('/api/auth/me')).data.user.id}/permissions`, { permissions: { manage_persons: false } })
  o = op()
  n0 = opRows()
  r = await B.post('/api/persons', { name: 'Denied' }, o)
  t('permission error: 403 permission_denied, not recorded', r.status === 403 && r.data.code === 'permission_denied' && opRows() === n0 && r.created === null, r.data)
  await A.put(`/api/spaces/${team.id}/members/${(await B.get('/api/auth/me')).data.user.id}/permissions`, { permissions: { manage_persons: true } })
  r = await B.post('/api/persons', { name: 'Denied' }, o)
  t('after the permission is granted the same op id works', ok(r) && r.created !== null)

  // ---------- space_gone ----------
  r = await C.post('/api/persons', { name: 'Carol in foreign space' }, { ...op(), 'X-Space': String(team.id) })
  t('non-member + X-Op-Id + X-Space -> 403 space_gone', r.status === 403 && r.data.code === 'space_gone', r.data)
  t('space_gone: nothing landed in the personal space', !(await C.get('/api/state', { 'X-Space': null })).data.persons.some((p) => p.name === 'Carol in foreign space'))
  r = await C.post('/api/persons', { name: 'Carol in foreign space' }, { 'X-Space': String(team.id) })
  t('without X-Op-Id the old fallback to the personal space stays', ok(r))
  r = await C.post('/api/persons', { name: 'Carol garbage space' }, { ...op(), 'X-Space': '99999' })
  t('deleted/unknown space + X-Op-Id -> 403 space_gone', r.status === 403 && r.data.code === 'space_gone')
  r = await C.post('/api/persons', { name: 'Carol personal' }, op())
  t('X-Op-Id without X-Space still uses the personal space', ok(r) && r.data.persons.some((p) => p.name === 'Carol personal'))

  // ---------- surprise protection ----------
  // Bob's own person in the team space: gifts for it are hidden from Bob, also in repeated responses
  const bobMe = (await bobState()).persons.find((p) => p.is_me)
  o = op()
  r = await B.post('/api/persons', { name: 'Bobs friend' }, o)
  r = await A.post('/api/gifts', { title: 'Surprise for Bob', recipient_ids: [bobMe.id] }, op())
  const surprise = r.data.gifts.find((g) => g.title === 'Surprise for Bob')
  t('surprise: Alice sees the gift for Bob', !!surprise)
  t('surprise: Bob\'s normal state hides it', !(await bobState()).gifts.some((g) => g.title === 'Surprise for Bob'))
  r = await B.post('/api/persons', { name: 'Bobs friend' }, o)
  t('surprise: Bob\'s repeated response hides the gift as well', ok(r) && !r.data.gifts.some((g) => g.title === 'Surprise for Bob') && !JSON.stringify(r.data).includes('Surprise for Bob'))
  // Bob cannot reach the hidden gift through an op id either
  r = await B.put(`/api/gifts/${surprise.id}`, { title: 'Spoiled' }, op())
  t('surprise: Bob cannot change the hidden gift (404)', r.status === 404 && (await A.get('/api/state')).data.gifts.find((g) => g.id === surprise.id)?.title === 'Surprise for Bob')
  const aliceOp = op()
  await A.post('/api/gifts', { title: 'Another surprise', recipient_ids: [bobMe.id] }, aliceOp)
  r = await B.post('/api/gifts', { title: 'Reuse attempt', recipient_ids: [(await bobState()).persons.find((p) => p.name === 'Bobs friend').id] }, aliceOp)
  t('surprise: Bob replaying Alice\'s op id gets no data of hers', ok(r) && !JSON.stringify(r.data).includes('Another surprise') && !JSON.stringify(r.data).includes('Surprise for Bob'))

  // ---------- audit: a repeat is not logged twice ----------
  await A.put('/api/admin/audit/settings', { audit_level: 'all' })
  o = op()
  await A.post('/api/persons', { name: 'Audited' }, o)
  await sleep(150)
  const auditN = () => count('SELECT COUNT(*) AS n FROM audit_log')
  const a0 = auditN()
  r = await A.post('/api/persons', { name: 'Audited' }, o)
  await sleep(150)
  t('audit: a repeat writes no audit entry', ok(r) && auditN() === a0, [a0, auditN()])
  await A.post('/api/persons', { name: 'Audited 2' }, op())
  await sleep(150)
  t('audit: a first execution is still logged', auditN() > a0, [a0, auditN()])

  // ---------- retention ----------
  {
    const d = rawDb()
    const uid = d.prepare('SELECT id FROM users WHERE email=?').get('alice@example.com').id
    d.prepare("INSERT INTO client_ops (user_id, op_id, method, path, created_at) VALUES (?,?,?,?,datetime('now','-100 days'))").run(uid, randomUUID(), 'POST', '/api/persons')
    d.prepare("INSERT INTO client_ops (user_id, op_id, method, path, created_at) VALUES (?,?,?,?,datetime('now','-80 days'))").run(uid, randomUUID(), 'POST', '/api/persons')
    d.close()
    const before = opRows()
    r = await A.post('/api/admin/retention/run', {})
    t('retention: old ops (> 90 days) are deleted, newer stay', ok(r) && r.data.client_ops_deleted === 1 && opRows() === before - 1, r.data)
  }

  // ---------- user deletion cascades ----------
  {
    const d = rawDb()
    const cid = d.prepare('SELECT id FROM users WHERE email=?').get('carol@example.com').id
    const nC = d.prepare('SELECT COUNT(*) AS n FROM client_ops WHERE user_id=?').get(cid).n
    d.prepare('DELETE FROM users WHERE id=?').run(cid)
    const after = d.prepare('SELECT COUNT(*) AS n FROM client_ops WHERE user_id=?').get(cid).n
    d.close()
    t('client_ops rows follow the user (ON DELETE CASCADE)', nC > 0 && after === 0, [nC, after])
  }

  // ---------- manifest ----------
  r = await fetch(BASE + '/manifest.webmanifest')
  const mf = await r.json()
  t('manifest: public, 200, manifest+json, no-cache', r.status === 200 && /^application\/manifest\+json/.test(r.headers.get('content-type')) && r.headers.get('cache-control') === 'no-cache', [r.status, r.headers.get('content-type')])
  t('manifest: identity and display', mf.name === 'Wishy' && mf.short_name === 'Wishy' && mf.id === '/' && mf.start_url === '/' && mf.scope === '/' && mf.display === 'standalone', mf)
  t('manifest: colors from the light theme', mf.background_color === '#fbf6f0' && mf.theme_color === '#fbf6f0')
  t('manifest: icons 192, 512 and maskable 512', mf.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png') && mf.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any') && mf.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'))
  t('manifest: every icon file exists in public/ and is served', (await Promise.all(mf.icons.map(async (i) => fs.existsSync(path.join(ROOT, 'public', i.src)) && (await fetch(BASE + i.src)).status === 200))).every(Boolean))
  t('manifest: shortcuts point to real client routes', JSON.stringify(mf.shortcuts.map((s) => s.url)) === JSON.stringify(['/wishlists', '/gifting', '/calendar']) && mf.categories.length > 0)
  await A.put('/api/admin/settings/general', { app_name: 'Our wishes' })
  mf.name = (await (await fetch(BASE + '/manifest.webmanifest')).json()).name
  t('manifest: name follows the app_name setting', mf.name === 'Our wishes')
  const shell = await (await fetch(BASE + '/')).text()
  t('shell: title carries the app name', shell.includes('<title>Our wishes</title>'))
  await A.put('/api/admin/settings/general', { app_name: 'Wishy' })
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  t('index.html: manifest, icons, apple and mobile-web-app tags', ['rel="manifest" href="/manifest.webmanifest"', 'rel="apple-touch-icon" href="/icons/apple-touch-icon.png"', 'rel="icon" href="/icons/icon.svg"', 'mobile-web-app-capable', 'apple-mobile-web-app-capable'].every((s) => idx.includes(s)) && !idx.includes('5b5bd6'))
  t('icons: the PNGs have the documented sizes', [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]].every(([f, s]) => {
    const b = fs.readFileSync(path.join(ROOT, 'public', 'icons', f))
    return b.readUInt32BE(16) === s && b.readUInt32BE(20) === s
  }))

  // ---------- headers ----------
  const hdr = async (p) => { const x = await fetch(BASE + p); await x.arrayBuffer(); return x }
  r = await hdr('/')
  const csp = r.headers.get('content-security-policy')
  t('CSP: explicit worker-src and manifest-src', csp.includes("worker-src 'self'") && csp.includes("manifest-src 'self'"), csp)
  t('shell: no-cache', r.headers.get('cache-control') === 'no-cache' && /text\/html/.test(r.headers.get('content-type')))
  r = await hdr('/sw.js')
  t('sw.js: served, no-cache', r.status === 200 && r.headers.get('cache-control') === 'no-cache')
  r = await hdr('/assets/index-AbCd1234.js')
  t('hashed asset: immutable for a year', r.status === 200 && r.headers.get('cache-control') === 'public, max-age=31536000, immutable', r.headers.get('cache-control'))
  r = await hdr('/assets/inter-latin-wght-normal-Zy9xW8vU.woff2')
  t('hashed font: immutable', r.headers.get('cache-control') === 'public, max-age=31536000, immutable')
  r = await hdr('/assets/theme-init.js')
  t('theme-init.js (stable name): not immutable', r.status === 200 && !/immutable/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'))
  r = await hdr('/assets/missing-AbCd1234.js')
  t('missing /assets file -> 404, not the SPA html', r.status === 404 && !/html/.test(r.headers.get('content-type')))
  r = await hdr('/assets/nested/missing.css')
  t('missing nested /assets file -> 404', r.status === 404)
  r = await hdr('/icons/none.png')
  t('missing /icons file -> 404', r.status === 404)
  fs.rmSync(path.join(CWD, 'dist', 'sw.js'))
  r = await hdr('/sw.js')
  t('missing /sw.js -> 404, not the SPA html', r.status === 404 && !/html/.test(r.headers.get('content-type')))
  r = await hdr('/wishlists/12')
  t('client routes still get the shell', r.status === 200 && /text\/html/.test(r.headers.get('content-type')))
  r = await hdr('/api/nothing')
  t('unknown API route stays JSON 404', r.status === 404 && /json/.test(r.headers.get('content-type')))

  // ---------- durability: ops survive a restart ----------
  o = op()
  r = await A.post('/api/persons', { name: 'Durable' }, o)
  const durable = r.created
  await stop(); await start()
  const A2 = new Client()
  await A2.post('/api/auth/login', { email: 'alice@example.com', password: 'secret123' })
  A2.space = team.id
  r = await A2.post('/api/persons', { name: 'Durable' }, o)
  t('op records persist across a restart', ok(r) && r.created === durable && r.data.persons.filter((p) => p.name === 'Durable').length === 1)
}

try {
  await main()
} catch (e) {
  results.push('CRASH ' + e.stack); failN++
} finally {
  try { await stop() } catch {}
  console.log(results.join('\n'))
  console.log(`offline-sync: ${pass} passed, ${failN} failed`)
  await new Promise((r) => setTimeout(r, 500))
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(failN ? 1 : 0)
}
