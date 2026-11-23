// Person-centred planning: occasion audience (all/selected) and effective participants, leaving persons out of an occasion (carried to the
// next occurrence / next birthday), surprise protection of exclusions, person_excluded, gifts need a recipient (recipient_required),
// idea -> gift inheritance, birthdays come from persons (birthday_from_person, Feb 29), type default audience, export/import, merge,
// permissions, API v1 output.
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA = path.join(os.tmpdir(), 'wl-pplan-' + Date.now())
const UNIT_DATA = path.join(os.tmpdir(), 'wl-pplan-unit-' + Date.now())
const PORT = Number(process.env.SMOKE_PORT) || 4133
const BASE = `http://127.0.0.1:${PORT}`
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(UNIT_DATA, { recursive: true })

let server
const start = () => new Promise((resolve, reject) => {
  server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), PREVIEW_BROWSER: 'off' } })
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
    if (this.space && !h['X-Space']) h['X-Space'] = String(this.space)
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    if (ck) h.Cookie = ck
    const res = await fetch(BASE + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' })
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      if (/Max-Age=0/i.test(c)) delete this.cookies[kv.slice(0, i)]; else this.cookies[kv.slice(0, i)] = kv.slice(i + 1)
    }
    let data = null
    try { data = await res.json() } catch {}
    return { status: res.status, data }
  }
  get(u) { return this.req('GET', u) }
  post(u, b = {}) { return this.req('POST', u, b) }
  put(u, b = {}) { return this.req('PUT', u, b) }
  del(u) { return this.req('DELETE', u) }
}

let pass = 0, failN = 0
const results = []
const t = (name, cond, extra) => {
  if (cond) pass++
  else { failN++; results.push('FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 500) : '')) }
}
const rawDb = () => new DatabaseSync(path.join(DATA, 'wishlist.db'))
const same = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y))
const code = (r, status, c) => r.status === status && r.data?.code === c
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

async function main() {
  // ---- Unit checks of the date helpers (own database, the server's is not involved) ----
  process.env.DATA_DIR = UNIT_DATA
  const { nextBirthday, dateInYear } = await import('../../server/db.js')
  t('Feb 29: non-leap year falls back to Feb 28', dateInYear(2027, '02-29') === '2027-02-28' && dateInYear(2028, '02-29') === '2028-02-29' && dateInYear(2100, '02-29') === '2100-02-28')
  t('nextBirthday Feb 29: before the day in a non-leap year -> Feb 28', nextBirthday('2000-02-29', '2025-01-10') === '2025-02-28')
  t('nextBirthday Feb 29: on Feb 28 of a non-leap year -> today', nextBirthday('2000-02-29', '2025-02-28') === '2025-02-28')
  t('nextBirthday Feb 29: after it -> next year Feb 28', nextBirthday('2000-02-29', '2025-03-01') === '2026-02-28')
  t('nextBirthday Feb 29: returns to Feb 29 in a leap year', nextBirthday('2000-02-29', '2027-03-01') === '2028-02-29' && nextBirthday('2000-02-29', '2028-01-10') === '2028-02-29' && nextBirthday('2000-02-29', '2028-02-29') === '2028-02-29')
  t('nextBirthday: other dates unchanged', nextBirthday('1990-06-01', '2025-06-02') === '2026-06-01' && nextBirthday('1990-06-01', '2025-06-01') === '2025-06-01')

  const A = new Client(), B = new Client()
  await start()
  let r = await A.post('/api/auth/setup', { name: 'Alice', email: 'alice@example.com', password: 'secret123' })
  t('setup', r.status === 200, r)
  r = await A.post('/api/admin/invites', {})
  r = await B.post('/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'secret456', invite: r.data.url.split('=')[1] })
  t('register Bob', r.status === 200, r)
  const bobUid = r.data.user.id
  r = await A.post('/api/spaces', { name: 'Shared' })
  const shared = r.data.spaces.find((s) => s.name === 'Shared')
  const personalA = r.data.spaces.find((s) => s.personal).id
  r = await A.post(`/api/spaces/${shared.id}/invites`)
  r = await B.post(`/api/invites/${r.data.token}/accept`)
  t('Bob joins the shared space', r.status === 200, r)

  const mk = async (c, b) => (await c.post('/api/persons', b)).data.persons.find((p) => p.name === b.name)
  const state = async (c = A) => (await c.get('/api/state')).data
  const occ = (st, id) => st.occasions.find((o) => o.id === id)
  const occByName = (st, name) => st.occasions.find((o) => o.name === name)
  const mkOcc = async (c, b) => {
    const x = await c.post('/api/occasions', b)
    return { r: x, o: x.data?.occasions?.find((o) => o.name === b.name && o.date === b.date) }
  }

  // ================= Personal space: audience & participants =================
  A.space = personalA
  let st = await state()
  const meP = st.persons.find((p) => p.is_me)
  const anna = await mk(A, { name: 'Anna' })
  const ben = await mk(A, { name: 'Ben' })
  const cara = await mk(A, { name: 'Cara' })

  t('built-in default audiences: christmas/st_nicholas/easter all, the personal ones selected',
    ['christmas', 'st_nicholas', 'easter'].every((k) => st.occasion_types.find((x) => x.key === k).default_audience === 'all')
    && ['birthday', 'valentine', 'anniversary', 'parentsday', 'wedding', 'baby', 'housewarming', 'other'].every((k) => st.occasion_types.find((x) => x.key === k).default_audience === 'selected'),
    st.occasion_types.map((x) => [x.key, x.default_audience]))

  let { r: rx, o: xmas } = await mkOcc(A, { name: 'Xmas', type: 'christmas', date: '2099-12-24', recurring: 1 })
  t('POST without audience takes the type default (christmas -> all)', rx.status === 200 && xmas.audience === 'all', xmas)
  t('audience all: every active person, not the own person', same(xmas.person_ids, [anna.id, ben.id, cara.id]) && !xmas.person_ids.includes(meP.id) && xmas.excluded_ids.length === 0, xmas)
  let party
  ;({ r: rx, o: party } = await mkOcc(A, { name: 'Party', type: 'other', date: '2099-05-01', person_ids: [anna.id] }))
  t('type other defaults to selected: only the listed persons', party.audience === 'selected' && same(party.person_ids, [anna.id]), party)
  let o2
  ;({ o: o2 } = await mkOcc(A, { name: 'XmasSel', type: 'christmas', date: '2099-12-23', audience: 'selected', person_ids: [ben.id] }))
  t('explicit audience selected overrides the type default', o2.audience === 'selected' && same(o2.person_ids, [ben.id]), o2)
  let o3
  ;({ o: o3 } = await mkOcc(A, { name: 'PartyAll', type: 'other', date: '2099-06-01', audience: 'all', person_ids: [anna.id] }))
  t('audience all ignores person_ids', o3.audience === 'all' && same(o3.person_ids, [anna.id, ben.id, cara.id]), o3)
  r = await A.post('/api/occasions', { name: 'Bad', date: '2099-01-01', audience: 'everyone' })
  t('invalid audience -> 400 audience_invalid', code(r, 400, 'audience_invalid'), r.data)

  const dora = await mk(A, { name: 'Dora' })
  st = await state()
  t('a person added later joins audience all automatically', occ(st, xmas.id).person_ids.includes(dora.id) && occ(st, o3.id).person_ids.includes(dora.id), occ(st, xmas.id).person_ids)
  t('a person added later does not join audience selected', !occ(st, party.id).person_ids.includes(dora.id) && !occ(st, o2.id).person_ids.includes(dora.id))
  r = await A.put(`/api/persons/${dora.id}`, { archived: 1 })
  st = r.data
  t('archived persons do not take part in audience all', !occ(st, xmas.id).person_ids.includes(dora.id))
  await A.put(`/api/persons/${dora.id}`, { archived: 0 })

  // Past occasions: only persons who existed then or have a gift in it
  ;({ o: rx } = await mkOcc(A, { name: 'Past Xmas', type: 'christmas', date: '2020-12-24' }))
  const past = rx
  st = await state()
  t('past occasion (audience all): persons created today are not participants', occ(st, past.id).audience === 'all' && occ(st, past.id).person_ids.length === 0, occ(st, past.id))
  r = await A.post('/api/gifts', { title: 'Old scarf', occasion_id: past.id, recipient_ids: [anna.id], status: 'given' })
  t('past occasion: a person with a gift in it is a participant', same(occ(r.data, past.id).person_ids, [anna.id]), occ(r.data, past.id).person_ids)
  {
    const d = rawDb()
    d.prepare("UPDATE persons SET created_at='2019-05-05 10:00:00' WHERE id=?").run(ben.id)
    d.close()
  }
  st = await state()
  t('past occasion: a person created before the date is a participant', same(occ(st, past.id).person_ids, [anna.id, ben.id]), occ(st, past.id).person_ids)
  t('upcoming occasion: the creation date does not matter', occ(st, xmas.id).person_ids.includes(cara.id))

  // ---- Exclusion set / clear ----
  r = await A.put(`/api/occasions/${xmas.id}/persons/${cara.id}`, { excluded: true })
  t('leave a person out (audience all)', r.status === 200 && !occ(r.data, xmas.id).person_ids.includes(cara.id) && same(occ(r.data, xmas.id).excluded_ids, [cara.id]), occ(r.data, xmas.id))
  r = await A.put(`/api/occasions/${xmas.id}/persons/${cara.id}`, { excluded: false })
  t('include again (audience all)', r.status === 200 && occ(r.data, xmas.id).person_ids.includes(cara.id) && occ(r.data, xmas.id).excluded_ids.length === 0, occ(r.data, xmas.id))
  {
    const d = rawDb()
    t('include again on audience all deletes the row', d.prepare('SELECT COUNT(*) AS n FROM occasion_persons WHERE occasion_id=? AND person_id=?').get(xmas.id, cara.id).n === 0)
    d.close()
  }
  r = await A.put(`/api/occasions/${party.id}/persons/${anna.id}`, { excluded: true })
  t('leave a person out (audience selected)', occ(r.data, party.id).person_ids.length === 0 && same(occ(r.data, party.id).excluded_ids, [anna.id]), occ(r.data, party.id))
  r = await A.put(`/api/occasions/${party.id}/persons/${anna.id}`, { excluded: false })
  t('include again (selected): becomes a normal participant', same(occ(r.data, party.id).person_ids, [anna.id]) && occ(r.data, party.id).excluded_ids.length === 0, occ(r.data, party.id))
  r = await A.put(`/api/occasions/${party.id}/persons/${ben.id}`, { excluded: true })
  t('selected: a person without a row can be left out', same(occ(r.data, party.id).excluded_ids, [ben.id]) && same(occ(r.data, party.id).person_ids, [anna.id]))
  r = await A.put(`/api/occasions/${party.id}/persons/${ben.id}`, { excluded: false })
  t('selected: clearing a mark makes the person a participant', same(occ(r.data, party.id).person_ids, [anna.id, ben.id]) && occ(r.data, party.id).excluded_ids.length === 0, occ(r.data, party.id))
  r = await A.put(`/api/occasions/${party.id}/persons/${ben.id}`, { excluded: 'yes' })
  t('excluded must be a boolean -> 400 excluded_invalid', code(r, 400, 'excluded_invalid'), r.data)
  r = await A.put(`/api/occasions/${party.id}/persons/99999`, { excluded: true })
  t('unknown person -> 404', code(r, 404, 'person_not_found'), r.data)
  r = await A.put(`/api/occasions/99999/persons/${ben.id}`, { excluded: true })
  t('unknown occasion -> 404', code(r, 404, 'occasion_not_found'), r.data)
  r = await A.put(`/api/occasions/${xmas.id}`, { excluded_ids: [ben.id, cara.id] })
  t('PUT occasion excluded_ids replaces the set', same(occ(r.data, xmas.id).excluded_ids, [ben.id, cara.id]) && !occ(r.data, xmas.id).person_ids.includes(ben.id), occ(r.data, xmas.id))
  r = await A.put(`/api/occasions/${xmas.id}`, { name: 'Xmas' })
  t('PUT without excluded_ids keeps the exclusions', same(occ(r.data, xmas.id).excluded_ids, [ben.id, cara.id]))
  r = await A.put(`/api/occasions/${xmas.id}`, { excluded_ids: [] })
  t('PUT excluded_ids [] clears them', occ(r.data, xmas.id).excluded_ids.length === 0 && occ(r.data, xmas.id).person_ids.includes(ben.id))
  r = await A.put(`/api/occasions/${xmas.id}`, { audience: 'selected', person_ids: [anna.id], excluded_ids: [cara.id] })
  t('switch to selected with participants and exclusion', occ(r.data, xmas.id).audience === 'selected' && same(occ(r.data, xmas.id).person_ids, [anna.id]) && same(occ(r.data, xmas.id).excluded_ids, [cara.id]), occ(r.data, xmas.id))
  r = await A.put(`/api/occasions/${xmas.id}`, { audience: 'all' })
  t('switch back to all: everyone but the left out', same(occ(r.data, xmas.id).person_ids, [anna.id, ben.id, dora.id]) && same(occ(r.data, xmas.id).excluded_ids, [cara.id]), occ(r.data, xmas.id))
  await A.put(`/api/occasions/${xmas.id}/persons/${cara.id}`, { excluded: false })

  // ---- Exclusion does not touch gifts; person_excluded ----
  r = await A.post('/api/gifts', { title: 'Cara book', occasion_id: xmas.id, recipient_ids: [cara.id], price: 20 })
  const caraGift = r.data.gifts.find((g) => g.title === 'Cara book')
  t('gift for a participant', r.status === 200 && caraGift.occasion_id === xmas.id)
  r = await A.put(`/api/occasions/${xmas.id}/persons/${cara.id}`, { excluded: true })
  t('excluding keeps the gifts of the person', r.data.gifts.some((g) => g.id === caraGift.id && g.occasion_id === xmas.id))
  r = await A.post('/api/gifts', { title: 'Cara second', occasion_id: xmas.id, recipient_ids: [cara.id] })
  t('new gift for a left out person -> 400 person_excluded', code(r, 400, 'person_excluded'), r.data)
  r = await A.put(`/api/gifts/${caraGift.id}`, { title: 'Cara book (edited)', price: 25 })
  t('editing other fields of an existing gift keeps working', r.status === 200 && r.data.gifts.find((g) => g.id === caraGift.id).title === 'Cara book (edited)', r.data)
  r = await A.put(`/api/gifts/${caraGift.id}`, { occasion_id: xmas.id })
  t('re-sending the same occasion is no change', r.status === 200)
  r = await A.post('/api/gifts', { title: 'Anna gift', occasion_id: xmas.id, recipient_ids: [anna.id] })
  const annaGift = r.data.gifts.find((g) => g.title === 'Anna gift')
  t('gift for another participant is fine', r.status === 200 && annaGift)
  r = await A.put(`/api/gifts/${annaGift.id}`, { recipient_ids: [anna.id, cara.id] })
  t('adding a left out recipient -> 400 person_excluded', code(r, 400, 'person_excluded'), r.data)
  r = await A.put(`/api/gifts/${caraGift.id}`, { recipient_ids: [cara.id, ben.id] })
  t('adding another recipient to a gift whose recipient is already left out is fine', r.status === 200, r.data)
  r = await A.put(`/api/gifts/${caraGift.id}`, { occasion_id: party.id })
  t('moving a gift to an occasion works while the person is not left out there', r.status === 200)
  await A.put(`/api/occasions/${party.id}/persons/${cara.id}`, { excluded: true })
  r = await A.put(`/api/gifts/${caraGift.id}`, { occasion_id: party.id })
  t('re-sending the occasion where the recipient is left out is no change', r.status === 200, r.data)
  r = await A.put(`/api/gifts/${annaGift.id}`, { occasion_id: party.id, recipient_ids: [anna.id] })
  t('moving a gift of a participant is fine', r.status === 200)
  r = await A.put(`/api/gifts/${annaGift.id}`, { recipient_ids: [cara.id] })
  t('moving a gift to a left out recipient -> 400 person_excluded', code(r, 400, 'person_excluded'), r.data)
  r = await A.post('/api/items', { title: 'Cara idea', person_id: cara.id, occasion_id: xmas.id })
  t('new idea bound to an occasion the person is left out of -> 400 person_excluded', code(r, 400, 'person_excluded'), r.data)
  r = await A.post('/api/items', { title: 'Cara idea free', person_id: cara.id })
  const caraIdea = r.data.items.find((i) => i.title === 'Cara idea free')
  r = await A.put(`/api/items/${caraIdea.id}`, { occasion_id: xmas.id })
  t('binding an idea to an occasion the person is left out of -> 400 person_excluded', code(r, 400, 'person_excluded'), r.data)
  r = await A.put(`/api/items/${caraIdea.id}`, { title: 'Cara idea renamed' })
  t('editing other fields of an idea keeps working', r.status === 200)
  r = await A.post('/api/items', { title: 'Inbox idea', occasion_id: xmas.id })
  const inboxIdea = r.data.inbox_items.find((i) => i.title === 'Inbox idea')
  r = await A.post(`/api/items/${inboxIdea.id}/assign`, { person_id: cara.id })
  t('assigning an inbox idea of an occasion to a left out person -> 400 person_excluded', code(r, 400, 'person_excluded'), r.data)
  r = await A.post(`/api/items/${inboxIdea.id}/assign`, { person_id: anna.id })
  t('assigning it to a participant works', r.status === 200)

  // ---- Gifts need a person ----
  r = await A.post('/api/gifts', { title: 'Nobody' })
  t('gift without recipients -> 400 recipient_required', code(r, 400, 'recipient_required'), r.data)
  r = await A.post('/api/gifts', { title: 'Nobody', recipient_ids: [] })
  t('gift with empty recipients -> 400 recipient_required', code(r, 400, 'recipient_required'), r.data)
  r = await A.put(`/api/gifts/${annaGift.id}`, { recipient_ids: [] })
  t('emptying the recipients of a gift -> 400 recipient_required', code(r, 400, 'recipient_required'), r.data)
  r = await A.put(`/api/gifts/${annaGift.id}`, { recipient_ids: [anna.id, ben.id] })
  t('changing recipients to other persons is fine', r.status === 200 && same(r.data.gifts.find((g) => g.id === annaGift.id).recipient_ids, [anna.id, ben.id]))
  r = await A.post('/api/gifts', { title: 'Idea-less inbox', item_id: inboxIdea.id, recipient_ids: [ben.id] })
  t('explicit recipients work', r.status === 200)
  {
    const d = rawDb()
    d.prepare('DELETE FROM gift_recipients WHERE gift_id=?').run(annaGift.id)
    d.close()
  }
  r = await A.put(`/api/gifts/${annaGift.id}`, { title: 'Anna gift (no one)' })
  t('a legacy gift without recipients can still be edited', r.status === 200)
  r = await A.put(`/api/gifts/${annaGift.id}`, { recipient_ids: [] })
  t('... and an empty list on it is no change', r.status === 200)
  await A.put(`/api/gifts/${annaGift.id}`, { recipient_ids: [anna.id] })

  // ---- Idea -> gift inheritance ----
  r = await A.post('/api/items', { title: 'Idea in Xmas', person_id: anna.id, occasion_id: xmas.id })
  const ideaX = r.data.items.find((i) => i.title === 'Idea in Xmas')
  r = await A.post('/api/gifts', { title: 'From idea', item_id: ideaX.id })
  let g = r.data?.gifts?.find((x) => x.title === 'From idea')
  t('gift from an idea inherits person and occasion', r.status === 200 && same(g.recipient_ids, [anna.id]) && g.occasion_id === xmas.id, g)
  r = await A.post('/api/gifts', { title: 'From idea explicit', item_id: ideaX.id, recipient_ids: [ben.id], occasion_id: party.id })
  g = r.data.gifts.find((x) => x.title === 'From idea explicit')
  t('explicit recipients and occasion win over the idea', same(g.recipient_ids, [ben.id]) && g.occasion_id === party.id, g)
  r = await A.post('/api/gifts', { title: 'From idea no occasion', item_id: ideaX.id, occasion_id: null })
  g = r.data.gifts.find((x) => x.title === 'From idea no occasion')
  t('an explicit null occasion is respected', same(g.recipient_ids, [anna.id]) && g.occasion_id === null, g)
  r = await A.post('/api/items', { title: 'Idea plain', person_id: ben.id })
  const ideaP = r.data.items.find((i) => i.title === 'Idea plain')
  r = await A.post('/api/gifts', { title: 'From plain idea', item_id: ideaP.id })
  g = r.data.gifts.find((x) => x.title === 'From plain idea')
  t('an idea without occasion gives a gift without occasion', same(g.recipient_ids, [ben.id]) && g.occasion_id === null && g.item_id === ideaP.id, g)
  r = await A.post('/api/items', { title: 'Inbox only' })
  const ideaI = r.data.inbox_items.find((i) => i.title === 'Inbox only')
  r = await A.post('/api/gifts', { title: 'From inbox idea', item_id: ideaI.id })
  t('an inbox idea has no person to inherit -> recipient_required', code(r, 400, 'recipient_required'), r.data)
  r = await A.post('/api/gifts', { title: 'From excluded idea', item_id: caraIdea.id })
  g = r.data.gifts?.find((x) => x.title === 'From excluded idea')
  t('an idea without occasion for a left out person still makes a gift', r.status === 200 && same(g.recipient_ids, [cara.id]) && g.occasion_id === null, r.data)

  // ================= Next occurrence / next birthday carry the exclusions =================
  ;({ o: rx } = await mkOcc(A, { name: 'Series all', type: 'christmas', date: '2020-12-24', recurring: 1, excluded_ids: [cara.id] }))
  const sAll = rx
  ;({ o: rx } = await mkOcc(A, { name: 'Series sel', type: 'other', date: '2020-03-03', recurring: 1, audience: 'selected', person_ids: [anna.id], excluded_ids: [ben.id] }))
  const sSel = rx
  st = await state()
  const nextOf = (o) => st.occasions.find((x) => x.series_id === o.series_id && x.date >= st.today)
  const nAll = nextOf(sAll), nSel = nextOf(sSel)
  t('next occurrence of a series is created', nAll && nAll.id !== sAll.id && nSel && nSel.id !== sSel.id, [nAll, nSel])
  t('next occurrence copies audience all and the exclusions', nAll.audience === 'all' && same(nAll.excluded_ids, [cara.id]) && !nAll.person_ids.includes(cara.id) && nAll.person_ids.includes(anna.id), nAll)
  t('next occurrence copies audience selected, participants and exclusions', nSel.audience === 'selected' && same(nSel.person_ids, [anna.id]) && same(nSel.excluded_ids, [ben.id]), nSel)

  // Birthdays
  r = await A.put(`/api/persons/${anna.id}`, { birthday: '1990-07-07' })
  st = r.data
  const bd = () => st.occasions.filter((o) => o.type === 'birthday' && o.person_id === anna.id && o.date >= st.today)
  t('a person with a birthday gets a yearly birthday occasion', bd().length === 1 && bd()[0].audience === 'selected' && same(bd()[0].person_ids, [anna.id]), bd())
  const bd1 = bd()[0]
  r = await A.put(`/api/occasions/${bd1.id}/persons/${anna.id}`, { excluded: true })
  t('leaving the birthday person out of their birthday', occ(r.data, bd1.id).person_ids.length === 0 && same(occ(r.data, bd1.id).excluded_ids, [anna.id]), occ(r.data, bd1.id))
  {
    const d = rawDb()
    d.prepare("UPDATE occasions SET date='2000-07-07' WHERE id=?").run(bd1.id)
    d.close()
  }
  st = await state()
  const bd2 = bd()[0]
  t('the next birthday carries the exclusion', bd2 && bd2.id !== bd1.id && same(bd2.excluded_ids, [anna.id]) && bd2.person_ids.length === 0, bd2)
  r = await A.put(`/api/occasions/${bd2.id}/persons/${anna.id}`, { excluded: false })
  t('including the birthday person again', same(occ(r.data, bd2.id).person_ids, [anna.id]) && occ(r.data, bd2.id).excluded_ids.length === 0)
  r = await A.put(`/api/occasions/${bd2.id}`, { audience: 'all', person_ids: [ben.id], name: 'Birthday' })
  t('a birthday keeps its audience and participant (only exclusions are editable)', occ(r.data, bd2.id).audience === 'selected' && same(occ(r.data, bd2.id).person_ids, [anna.id]), occ(r.data, bd2.id))
  r = await A.put(`/api/occasions/${bd2.id}`, { type: 'birthday', name: 'Geburtstag' })
  t('an existing birthday keeps its type on edit', r.status === 200 && occ(r.data, bd2.id).type === 'birthday', r.data)

  // birthday_from_person
  r = await A.post('/api/occasions', { name: 'Manual birthday', type: 'birthday', date: '2099-01-01' })
  t('POST with type birthday -> 400 birthday_from_person', code(r, 400, 'birthday_from_person'), r.data)
  r = await A.put(`/api/occasions/${party.id}`, { type: 'birthday' })
  t('PUT changing an occasion to type birthday -> 400 birthday_from_person', code(r, 400, 'birthday_from_person'), r.data)
  r = await A.get('/api/occasion-types')
  t('birthday stays in the type list', r.data.types.some((x) => x.key === 'birthday'))

  // ---- Feb 29 through the API ----
  r = await A.put(`/api/persons/${ben.id}`, { birthday: '2000-02-29' })
  st = r.data
  const bf = st.occasions.find((o) => o.type === 'birthday' && o.person_id === ben.id && o.date >= st.today)
  const fy = Number(bf.date.slice(0, 4))
  t('Feb 29 birthday: valid date (Feb 28 in non-leap years, Feb 29 in leap years)', validDate(bf.date) && bf.date.slice(5) === (leap(fy) ? '02-29' : '02-28'), bf.date)
  r = await A.put(`/api/persons/${ben.id}`, { birthday: '2000-02-29', notes: 'x' })
  t('Feb 29 birthday: stays valid after another save', validDate(r.data.occasions.find((o) => o.id === bf.id).date))
  ;({ o: rx } = await mkOcc(A, { name: 'Leap series', type: 'other', date: '2020-02-29', recurring: 1 }))
  const leapS = rx
  {
    const d = rawDb()
    d.prepare('INSERT INTO occasions (name,type,date,recurring,series_id,audience,space_id) VALUES (?,?,?,?,?,?,?)').run('Leap series', 'other', '2023-02-28', 1, leapS.series_id, 'selected', personalA)
    d.close()
  }
  st = await state()
  const ln = st.occasions.filter((o) => o.series_id === leapS.series_id && o.date >= st.today)
  const ly = Number(ln[0]?.date.slice(0, 4))
  t('Feb 29 series: next date valid and back on Feb 29 in leap years', ln.length === 1 && validDate(ln[0].date) && ln[0].date.slice(5) === (leap(ly) ? '02-29' : '02-28'), ln)

  // ================= Types: default audience =================
  r = await A.post('/api/occasion-types', { name: 'Team lunch', icon: 'utensils' })
  let cust = r.data.occasion_types.find((x) => x.name === 'Team lunch')
  t('custom type: default audience selected', cust.default_audience === 'selected', cust)
  r = await A.put(`/api/occasion-types/${cust.id}`, { default_audience: 'all' })
  cust = r.data.occasion_types.find((x) => x.id === cust.id)
  t('custom type: default audience editable', cust.default_audience === 'all', cust)
  r = await A.put(`/api/occasion-types/${cust.id}`, { default_audience: 'nobody' })
  t('custom type: invalid default audience -> 400', code(r, 400, 'audience_invalid'), r.data)
  r = await A.post('/api/occasion-types', { name: 'Open house', default_audience: 'all' })
  t('custom type created with a default audience', r.data.occasion_types.find((x) => x.name === 'Open house').default_audience === 'all')
  ;({ o: rx } = await mkOcc(A, { name: 'Lunch', type: cust.key, date: '2099-09-09' }))
  t('a new occasion takes the custom type default', rx.audience === 'all', rx)
  const chr = st.occasion_types.find((x) => x.key === 'christmas')
  r = await A.put(`/api/occasion-types/${chr.id}`, { default_audience: 'selected' })
  t('built-in types are fixed (default audience not editable)', code(r, 400, 'occasion_type_builtin'), r.data)

  // At least one pickable visible type (birthday does not count)
  r = await A.post('/api/spaces', { name: 'Types' })
  const typesSpace = r.data.spaces.find((s) => s.name === 'Types').id
  A.space = typesSpace
  st = await state()
  for (const ty of st.occasion_types.filter((x) => x.key !== 'other' && x.key !== 'birthday')) await A.post(`/api/occasion-types/${ty.id}/hide`)
  const otherT = (await state()).occasion_types.find((x) => x.key === 'other')
  const bdayT = (await state()).occasion_types.find((x) => x.key === 'birthday')
  r = await A.post(`/api/occasion-types/${otherT.id}/hide`)
  t('the last pickable type cannot be hidden even while birthday is visible', code(r, 400, 'occasion_type_last_visible'), r.data)
  r = await A.post(`/api/occasion-types/${bdayT.id}/hide`)
  t('birthday can be hidden (it is not pickable anyway)', r.status === 200 && r.data.occasion_types.find((x) => x.key === 'birthday').hidden === 1, r.status)
  r = await A.post(`/api/occasion-types/${bdayT.id}/show`)
  A.space = personalA

  // ================= Export / import round trip =================
  st = await state()
  const snap = (s) => {
    const nm = new Map(s.persons.map((p) => [p.id, p.name]))
    return s.occasions
      .filter((o) => o.type !== 'birthday' && o.date >= s.today) // (past audience-all occasions depend on the persons' creation dates, which an import resets)
      .map((o) => JSON.stringify([o.name, o.date, o.audience, o.person_ids.map((i) => nm.get(i)).sort(), o.excluded_ids.map((i) => nm.get(i)).sort()]))
      .sort()
  }
  const before = snap(st)
  const exp = (await A.get('/api/export')).data
  t('export carries audience and the excluded flag', exp.occasions.every((o) => o.audience === 'all' || o.audience === 'selected') && exp.occasion_persons.some((x) => x.excluded === 1) && exp.occasion_persons.some((x) => x.excluded === 0), exp.occasion_persons.slice(0, 4))
  t('export carries the default audience of the types', exp.occasion_types.every((x) => x.default_audience === 'all' || x.default_audience === 'selected') && exp.occasion_types.find((x) => x.key === 'christmas').default_audience === 'all')
  r = await A.post('/api/import', exp)
  t('import', r.status === 200, r)
  const after = snap(await state())
  t('round trip keeps audience, participants and exclusions', JSON.stringify(before) === JSON.stringify(after) && before.length > 5, { before: before.slice(0, 3), after: after.slice(0, 3) })
  {
    const bad = JSON.parse(JSON.stringify(exp))
    bad.occasions[0].audience = 'evil'
    r = await A.post('/api/import', bad)
    t('import sanitizes an unknown audience', r.status === 200 && (await state()).occasions.every((o) => o.audience === 'all' || o.audience === 'selected'))
    await A.post('/api/import', exp)
  }

  // ================= Shared space: surprise protection, merge, permissions, API v1 =================
  A.space = shared.id
  B.space = shared.id
  st = await state(A)
  const aliceP = st.persons.find((p) => p.is_me)
  const bobP = st.persons.find((p) => p.linked_user_id === bobUid)
  const tom = await mk(A, { name: 'Tom' })
  const oma = await mk(A, { name: 'Oma' })
  ;({ o: rx } = await mkOcc(A, { name: 'Shared Xmas', type: 'christmas', date: '2099-12-24' }))
  const sx = rx
  t('shared space: Alice sees Bob as participant, not herself', sx.person_ids.includes(bobP.id) && !sx.person_ids.includes(aliceP.id) && sx.person_ids.includes(tom.id), sx)
  t('shared space: Bob does not see his own person as participant', !occ(await state(B), sx.id).person_ids.includes(bobP.id) && occ(await state(B), sx.id).person_ids.includes(aliceP.id))

  r = await A.put(`/api/occasions/${sx.id}/persons/${bobP.id}`, { excluded: true })
  t('Alice leaves Bob out of Christmas', same(occ(r.data, sx.id).excluded_ids, [bobP.id]), occ(r.data, sx.id))
  let sb = occ(await state(B), sx.id)
  t('surprise: Bob does not see himself in excluded_ids', !sb.excluded_ids.includes(bobP.id) && sb.excluded_ids.length === 0, sb)
  r = await B.put(`/api/occasions/${sx.id}`, { excluded_ids: [tom.id] })
  t('Bob can leave someone else out', r.status === 200 && same(occ(r.data, sx.id).excluded_ids, [tom.id]), occ(r.data, sx.id))
  t('surprise: Bob\'s write does not drop Bob\'s own exclusion', same(occ(await state(A), sx.id).excluded_ids, [bobP.id, tom.id]), occ(await state(A), sx.id).excluded_ids)
  r = await B.put(`/api/occasions/${sx.id}`, { excluded_ids: [] })
  t('surprise: clearing the list as Bob keeps his own exclusion', same(occ(await state(A), sx.id).excluded_ids, [bobP.id]), occ(await state(A), sx.id).excluded_ids)
  r = await B.put(`/api/occasions/${sx.id}`, { excluded_ids: [bobP.id, oma.id] })
  t('surprise: Bob cannot set exclusions for himself', same(occ(await state(A), sx.id).excluded_ids, [bobP.id, oma.id]), occ(await state(A), sx.id).excluded_ids)
  await B.put(`/api/occasions/${sx.id}/persons/${bobP.id}`, { excluded: false })
  t('surprise: Bob cannot clear his own exclusion via the person route', occ(await state(A), sx.id).excluded_ids.includes(bobP.id))
  await B.put(`/api/occasions/${sx.id}`, { audience: 'selected', person_ids: [tom.id] })
  r = await A.put(`/api/occasions/${sx.id}`, { audience: 'all' })
  t('surprise: Bob switching the audience keeps his exclusion row', occ(r.data, sx.id).excluded_ids.includes(bobP.id), occ(r.data, sx.id))
  // Selected occasion: Bob's own row is preserved when he rewrites the participants
  ;({ o: rx } = await mkOcc(A, { name: 'Shared Party', type: 'other', date: '2099-08-08', person_ids: [bobP.id, tom.id], excluded_ids: [oma.id] }))
  const sp = rx
  r = await B.put(`/api/occasions/${sp.id}`, { person_ids: [aliceP.id] })
  t('surprise: Bob rewriting participants keeps his own row', same(occ(r.data, sp.id).person_ids, [aliceP.id, bobP.id]) || same(occ(await state(A), sp.id).person_ids, [aliceP.id, bobP.id]), occ(await state(A), sp.id))
  t('...and the left out Oma', occ(await state(A), sp.id).excluded_ids.includes(oma.id))
  // Bob cannot learn about a hidden exclusion in a selected occasion
  await A.put(`/api/occasions/${sp.id}/persons/${bobP.id}`, { excluded: true })
  sb = occ(await state(B), sp.id)
  t('surprise (selected): Bob sees neither an exclusion nor a change of his own person', !sb.excluded_ids.includes(bobP.id) && sb.person_ids.includes(bobP.id), sb)
  r = await B.get('/api/export')
  t('surprise: the export of Bob does not reveal his exclusion', r.status === 200 && !r.data.occasion_persons.some((x) => x.excluded === 1 && x.person_id === bobP.id), r.status)

  // Merge: a manual person is linked to Bob, his automatic person is merged in
  const carol = await mk(A, { name: 'Bobby' })
  const mkO = async (name, body) => (await mkOcc(A, { name, type: 'other', date: '2099-10-10', ...body })).o
  const m1 = await mkO('M1', { audience: 'selected', person_ids: [bobP.id], excluded_ids: [carol.id] })
  const m2 = await mkO('M2', { audience: 'selected', person_ids: [carol.id], excluded_ids: [bobP.id] })
  const m3 = await mkO('M3', { audience: 'selected', excluded_ids: [carol.id, bobP.id] })
  const m4 = await mkO('M4', { audience: 'all', excluded_ids: [bobP.id] })
  r = await A.post(`/api/persons/${carol.id}/link`, { user_id: bobUid })
  t('merge (link) succeeds', r.status === 200 && !r.data.persons.some((p) => p.id === bobP.id), r.status)
  t('merge: a normal participation wins over an exclusion (selected, both ways)', r.data.occasions && same(occ(r.data, m1.id).person_ids, [carol.id]) && occ(r.data, m1.id).excluded_ids.length === 0 && same(occ(r.data, m2.id).person_ids, [carol.id]) && occ(r.data, m2.id).excluded_ids.length === 0, [occ(r.data, m1.id), occ(r.data, m2.id)])
  t('merge: both left out stays left out', same(occ(r.data, m3.id).excluded_ids, [carol.id]) && occ(r.data, m3.id).person_ids.length === 0, occ(r.data, m3.id))
  t('merge: an exclusion of the dropped person carries over (audience all)', same(occ(r.data, m4.id).excluded_ids, [carol.id]), occ(r.data, m4.id))

  // API v1
  r = await A.post('/api/account/api-keys', { name: 'k', scopes: ['read'] })
  const KEY = r.data.secret
  const v1 = async (url) => { const x = await fetch(BASE + '/api/v1' + url, { headers: { Authorization: `Bearer ${KEY}` } }); return { status: x.status, data: await x.json() } }
  r = await v1(`/occasions?space=${shared.id}`)
  const v1x = r.data.find?.((o) => o.id === sx.id)
  t('API v1 occasions: audience, effective person_ids, excluded_ids', r.status === 200 && v1x?.audience === 'all' && v1x.excluded_ids.includes(carol.id) && !v1x.person_ids.includes(carol.id) && v1x.person_ids.includes(tom.id), v1x)
  const spec = await (await fetch(BASE + '/api/v1/openapi.json')).json().catch(() => null)
  t('OpenAPI: Occasion has audience and excluded_ids', !!spec?.components?.schemas?.Occasion?.properties?.audience && !!spec.components.schemas.Occasion.properties.excluded_ids, Object.keys(spec?.components?.schemas?.Occasion?.properties ?? {}))

  // Permissions
  r = await A.put(`/api/spaces/${shared.id}/members/${bobUid}/permissions`, { permissions: { manage_occasions: false } })
  t('revoke manage_occasions from Bob', r.status === 200, r)
  r = await B.put(`/api/occasions/${sx.id}/persons/${tom.id}`, { excluded: true })
  t('leaving a person out needs manage_occasions', r.status === 403 && r.data?.code === 'permission_denied' && r.data?.params?.permission === 'manage_occasions', r.data)
  r = await B.put(`/api/occasions/${sx.id}`, { audience: 'selected' })
  t('changing the audience needs manage_occasions', r.status === 403 && r.data?.code === 'permission_denied', r.data)
  r = await B.post('/api/occasions', { name: 'Nope', date: '2099-01-01' })
  t('creating an occasion needs manage_occasions', r.status === 403 && r.data?.code === 'permission_denied', r.data)
  await A.put(`/api/spaces/${shared.id}/members/${bobUid}/permissions`, { permissions: { manage_occasions: true, manage_gifts: false } })
  r = await B.post('/api/gifts', { title: 'Nope', recipient_ids: [tom.id] })
  t('creating a gift needs manage_gifts (checked before recipient_required)', r.status === 403 && r.data?.params?.permission === 'manage_gifts', r.data)
  await A.put(`/api/spaces/${shared.id}/members/${bobUid}/permissions`, { permissions: { manage_gifts: true } })

  // ================= Demo data =================
  r = await A.post('/api/spaces', { name: 'Demo' })
  const demo = r.data.spaces.find((s) => s.name === 'Demo')
  A.space = demo.id
  r = await A.post('/api/demo')
  const dx = r.data.occasions.find((o) => o.type === 'christmas' && o.date >= r.data.today)
  const lena = r.data.persons.find((p) => p.name === 'Lena')
  t('demo: Christmas is open to everyone with one person left out', dx.audience === 'all' && same(dx.excluded_ids, [lena.id]) && !dx.person_ids.includes(lena.id) && dx.person_ids.length >= 4, dx)
  t('demo: an idea is bound to an occasion', r.data.items.some((i) => i.occasion_id === dx.id), r.data.items.map((i) => i.occasion_id))
}

try {
  await main()
} catch (e) {
  results.push('CRASH ' + e.stack); failN++
} finally {
  try { await stop() } catch {}
  console.log(results.join('\n'))
  console.log(`person-planning: ${pass} passed, ${failN} failed`)
  await new Promise((r) => setTimeout(r, 500))
  fs.rmSync(DATA, { recursive: true, force: true })
  try { fs.rmSync(UNIT_DATA, { recursive: true, force: true }) } catch {}
  process.exit(failN ? 1 : 0)
}
