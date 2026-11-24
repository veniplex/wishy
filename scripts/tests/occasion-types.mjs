// Occasion types per space: seeding (new spaces), fixed built-ins (only hide/show + reorder), editable custom types (optional date/recurring),
// hide/show with the at-least-one-visible rule, delete/merge, reorder, isolation between spaces, validation of occasions.type,
// API v1 output, export/import, frontend icon map == server icon allow-list.
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA = path.join(os.tmpdir(), 'wl-otypes-' + Date.now())
const PORT = Number(process.env.SMOKE_PORT) || 4131
const BASE = `http://127.0.0.1:${PORT}`
fs.mkdirSync(DATA, { recursive: true })

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
  else { failN++; results.push('FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 400) : '')) }
}

const DEFAULT_KEYS = ['birthday', 'christmas', 'st_nicholas', 'easter', 'valentine', 'anniversary', 'parentsday', 'wedding', 'baby', 'housewarming', 'other']
const OT = (st, key) => st.occasion_types.find((x) => x.key === key)
const rawDb = () => new DatabaseSync(path.join(DATA, 'wishlist.db'), { timeout: 5000 }) // the server writes at the same time

async function main() {
  const A = new Client(), B = new Client()
  await start()
  let r = await A.post('/api/auth/setup', { name: 'Alice', email: 'alice@example.com', password: 'secret123' })
  t('setup', r.status === 200, r)
  r = await A.post('/api/admin/invites', {})
  const invTok = r.data.url.split('=')[1]
  r = await B.post('/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'secret456', invite: invTok })
  t('register Bob', r.status === 200, r)
  r = await A.post('/api/spaces', { name: 'Shared' })
  const shared = r.data.spaces.find((s) => s.name === 'Shared')
  const personalA = r.data.spaces.find((s) => s.personal).id
  r = await A.post(`/api/spaces/${shared.id}/invites`)
  r = await B.post(`/api/invites/${r.data.token}/accept`)
  t('Bob joins the shared space', r.status === 200, r)
  const bPersonal = r.data.spaces.find((s) => s.personal).id

  // ---- Seeding for new spaces ----
  A.space = personalA
  let st = (await A.get('/api/state')).data
  t('new personal space is seeded with the 11 defaults in order', JSON.stringify(st.occasion_types.map((x) => x.key)) === JSON.stringify(DEFAULT_KEYS), st.occasion_types.map((x) => x.key))
  t('built-ins: key=builtin_key, name null, icons/dates/recurring as defined', st.occasion_types.every((x) => x.builtin_key === x.key && x.name === null && x.hidden === 0 && !('protected' in x) && !('archived' in x))
    && OT(st, 'birthday').icon === 'cake' && OT(st, 'christmas').default_month_day === '12-24' && OT(st, 'st_nicholas').default_month_day === '12-06' && OT(st, 'valentine').default_month_day === '02-14'
    && OT(st, 'christmas').default_recurring === 1 && OT(st, 'wedding').default_recurring === 0 && OT(st, 'other').default_recurring === 0 && OT(st, 'housewarming').icon === 'home', st.occasion_types)
  r = await A.get('/api/occasion-types')
  t('GET /api/occasion-types: types + icon allow-list', r.status === 200 && r.data.types.length === 11 && r.data.icons.includes('party-popper') && r.data.icons.includes('cake'), r.data)
  A.space = shared.id
  st = (await A.get('/api/state')).data
  t('created space is seeded too', st.occasion_types.length === 11)
  r = await new Client().get('/api/occasion-types')
  t('GET without login -> 401', r.status === 401)

  // ---- Restart keeps the seeded types (no duplicates) ----
  A.space = personalA
  r = await A.post('/api/occasions', { name: 'Xmas', type: 'christmas', date: '2031-12-24' })
  t('occasion with built-in type', r.status === 200)
  const countAll = () => { const d = rawDb(); const n = d.prepare('SELECT COUNT(*) AS n FROM occasion_types').get().n; d.close(); return n }
  const n1 = countAll()
  await stop(); await start()
  t('restart does not change the seeded types', countAll() === n1, [n1, countAll()])
  await A.post('/api/auth/login', { email: 'alice@example.com', password: 'secret123' })
  await B.post('/api/auth/login', { email: 'bob@example.com', password: 'secret456' })
  A.space = personalA; B.space = shared.id

  // ---- Built-in types are fixed: only hide/show (and reorder) ----
  A.space = shared.id
  st = (await A.get('/api/state')).data
  const xmas = OT(st, 'christmas')
  for (const body of [{ name: 'Weihnachtsfest' }, { icon: 'snowflake' }, { default_month_day: '12-25' }, { default_recurring: false }, {}]) {
    r = await A.put(`/api/occasion-types/${xmas.id}`, body)
    t(`built-in cannot be edited: ${JSON.stringify(body)}`, r.status === 400 && r.data.code === 'occasion_type_builtin', r.data)
  }
  st = (await A.get('/api/state')).data
  t('built-in unchanged after refused edits', OT(st, 'christmas').name === null && OT(st, 'christmas').icon === 'tree-pine' && OT(st, 'christmas').default_month_day === '12-24' && OT(st, 'christmas').default_recurring === 1)
  {
    // Even a tampered row is shown with its fixed definition
    const d = rawDb()
    d.prepare("UPDATE occasion_types SET icon='star', default_month_day='01-01', default_recurring=0 WHERE space_id=? AND key='christmas'").run(shared.id)
    d.close()
    st = (await A.get('/api/state')).data
    t('built-in output always uses the fixed definition', OT(st, 'christmas').icon === 'tree-pine' && OT(st, 'christmas').default_month_day === '12-24' && OT(st, 'christmas').default_recurring === 1)
  }
  const bday = OT(st, 'birthday'), other = OT(st, 'other')
  for (const [n, x] of [['birthday', bday], ['other', other], ['christmas', xmas]]) {
    r = await A.del(`/api/occasion-types/${x.id}`)
    t(`${n}: delete refused`, r.status === 400 && r.data.code === 'occasion_type_builtin', r.data)
    r = await A.post(`/api/occasion-types/${x.id}/merge`, { into_id: OT(st, 'easter').id })
    t(`${n}: merge-away refused`, r.status === 400 && r.data.code === 'occasion_type_builtin', r.data)
  }
  {
    const d = rawDb()
    let blocked = false
    try { d.prepare("UPDATE occasion_types SET name='x' WHERE space_id=? AND key='easter'").run(shared.id) } catch { blocked = true }
    d.close()
    t('DB constraint: a built-in row cannot carry a name', blocked)
  }

  // ---- Custom types ----
  r = await A.post('/api/occasion-types', {})
  t('custom: name required', r.status === 400 && r.data.code === 'name_required', r.data)
  r = await A.post('/api/occasion-types', { name: 'Garden party', icon: 'party-popper', default_month_day: '07-15', default_recurring: true })
  const gp = r.data.occasion_types.find((x) => x.name === 'Garden party')
  t('custom: created with custom_ key, no builtin_key, last in order', r.status === 200 && /^custom_[0-9a-f]{10}$/.test(gp?.key) && gp.builtin_key === null && gp.default_recurring === 1 && gp.default_month_day === '07-15' && r.data.occasion_types.at(-1).id === gp.id, gp)
  r = await B.post('/api/occasion-types', { name: 'Plain' })
  const plain = r.data.occasion_types.find((x) => x.name === 'Plain')
  t('custom: date and recurring are optional (no date, not recurring)', r.status === 200 && plain.default_month_day === null && plain.default_recurring === 0 && plain.icon === 'calendar', plain)
  r = await B.post('/api/occasion-types', { name: 'Bad icon', icon: 'nope' })
  t('custom: invalid icon rejected', r.status === 400 && r.data.code === 'occasion_type_icon_invalid')
  r = await A.put(`/api/occasion-types/${gp.id}`, { name: '' })
  t('custom: cannot be renamed to an empty name', r.status === 400 && r.data.code === 'name_required')
  r = await A.put(`/api/occasion-types/${gp.id}`, { name: 'Summer party', icon: 'sun', default_month_day: '08-01', default_recurring: false })
  {
    const x = r.data.occasion_types.find((y) => y.id === gp.id)
    t('custom: edit name, icon, date, recurring', r.status === 200 && x.name === 'Summer party' && x.icon === 'sun' && x.default_month_day === '08-01' && x.default_recurring === 0, x)
  }
  r = await A.put(`/api/occasion-types/${gp.id}`, { icon: 'rm-rf' })
  t('custom: icon outside the allow-list rejected', r.status === 400 && r.data.code === 'occasion_type_icon_invalid', r.data)
  r = await A.put(`/api/occasion-types/${gp.id}`, { default_month_day: '13-40' })
  t('custom: invalid default date rejected', r.status === 400 && r.data.code === 'occasion_type_date_invalid', r.data)
  r = await A.put(`/api/occasion-types/${gp.id}`, { default_month_day: '02-30' })
  t('custom: 02-30 rejected', r.status === 400)
  r = await A.put(`/api/occasion-types/${gp.id}`, { name: 'Garden party', icon: 'party-popper', default_month_day: null })
  t('custom: clear the default date again', r.status === 200 && r.data.occasion_types.find((x) => x.id === gp.id).default_month_day === null)

  // ---- Validation of occasions.type ----
  r = await A.post('/api/occasions', { name: 'Party', type: gp.key, date: '2032-07-15' })
  t('occasion with the custom type accepted', r.status === 200 && r.data.occasions.some((o) => o.name === 'Party' && o.type === gp.key))
  const party = r.data.occasions.find((o) => o.name === 'Party')
  r = await A.post('/api/occasions', { name: 'Bogus', type: 'does_not_exist', date: '2032-07-15' })
  t('unknown type rejected', r.status === 400 && r.data.code === 'occasion_type_invalid', r.data)
  r = await A.put(`/api/occasions/${party.id}`, { type: 'does_not_exist' })
  t('update to unknown type rejected', r.status === 400 && r.data.code === 'occasion_type_invalid')

  // ---- Hide / show ----
  r = await A.post(`/api/occasion-types/${gp.id}/hide`)
  t('hide custom: flagged, still listed', r.status === 200 && r.data.occasion_types.find((x) => x.id === gp.id)?.hidden === 1)
  r = await A.post('/api/occasions', { name: 'Late', type: gp.key, date: '2032-08-01' })
  t('hide: cannot be used for a new occasion', r.status === 400 && r.data.code === 'occasion_type_invalid')
  r = await A.put(`/api/occasions/${party.id}`, { type: gp.key, name: 'Party 2' })
  t('hide: existing occasion keeps/accepts its hidden type on update', r.status === 200 && r.data.occasions.find((o) => o.id === party.id).name === 'Party 2')
  r = await A.put(`/api/occasions/${party.id}`, { type: 'easter' })
  r = await A.put(`/api/occasions/${party.id}`, { type: gp.key })
  t('hide: cannot switch an occasion back to a hidden type', r.status === 400)
  r = await A.post(`/api/occasion-types/${gp.id}/show`)
  t('show', r.status === 200 && r.data.occasion_types.find((x) => x.id === gp.id)?.hidden === 0)
  r = await A.put(`/api/occasions/${party.id}`, { type: gp.key })
  await A.post('/api/occasions', { name: 'Xmas shared', type: 'christmas', date: '2031-12-24' })
  r = await A.post(`/api/occasion-types/${xmas.id}/hide`)
  t('hide built-in works; existing occasions of it still listed', r.status === 200 && OT(r.data, 'christmas').hidden === 1 && r.data.occasions.some((o) => o.type === 'christmas'), OT(r.data, 'christmas'))
  r = await A.post('/api/occasions', { name: 'Xmas 2', type: 'christmas', date: '2032-12-24' })
  t('hidden built-in not accepted for new occasions', r.status === 400 && r.data.code === 'occasion_type_invalid')
  r = await A.post(`/api/occasion-types/${xmas.id}/show`)
  t('show built-in', r.status === 200 && OT(r.data, 'christmas').hidden === 0)
  r = await A.post('/api/occasion-types/999999/hide')
  t('hide unknown -> 404', r.status === 404)
  {
    // at least one type stays visible: hide everything in the personal space except one
    A.space = personalA
    const all = (await A.get('/api/state')).data.occasion_types
    let last = null
    for (const x of all) {
      r = await A.post(`/api/occasion-types/${x.id}/hide`)
      if (r.status !== 200) { last = { x, r }; break }
    }
    t('last visible type cannot be hidden', last && last.r.status === 400 && last.r.data.code === 'occasion_type_last_visible' && last.x.id === all.at(-1).id, last && last.r.data)
    t('exactly one type stays visible', (await A.get('/api/state')).data.occasion_types.filter((x) => !x.hidden).length === 1)
    for (const x of all) await A.post(`/api/occasion-types/${x.id}/show`)
    A.space = shared.id
  }

  // ---- Delete / merge ----
  r = await A.del(`/api/occasion-types/${gp.id}`)
  t('delete in use -> 409 occasion_type_in_use', r.status === 409 && r.data.code === 'occasion_type_in_use' && r.data.params?.count === 1, r.data)
  r = await A.post('/api/occasion-types', { name: 'Unused' })
  const unused = r.data.occasion_types.find((x) => x.name === 'Unused')
  r = await A.del(`/api/occasion-types/${unused.id}`)
  t('delete unused works', r.status === 200 && !r.data.occasion_types.some((x) => x.id === unused.id))
  r = await A.post(`/api/occasion-types/${gp.id}/merge`, { into_id: gp.id })
  t('merge into itself rejected', r.status === 400 && r.data.code === 'occasion_type_merge_target')
  r = await A.post(`/api/occasion-types/${gp.id}/merge`, { into_id: 999999 })
  t('merge into unknown type -> 404', r.status === 404 && r.data.code === 'occasion_type_not_found')
  r = await A.post(`/api/occasion-types/${gp.id}/merge`, { into_id: OT(st, 'anniversary').id })
  t('merge moves occasions to the target and deletes the source', r.status === 200 && !r.data.occasion_types.some((x) => x.id === gp.id) && r.data.occasions.find((o) => o.id === party.id).type === 'anniversary' && OT(r.data, 'anniversary').usage >= 1, r.data.occasions.find((o) => o.id === party.id))
  {
    const d = rawDb()
    const rows = d.prepare("SELECT action, target_label, details FROM audit_log WHERE action LIKE 'occasion_type.%' ORDER BY id").all()
    d.close()
    const acts = rows.map((x) => x.action)
    t('audit entries for create/update/delete/merge', ['occasion_type.create', 'occasion_type.update', 'occasion_type.delete', 'occasion_type.merge'].every((a) => acts.includes(a)), acts)
    t('audit merge carries counts, no free text beyond names', JSON.parse(rows.find((x) => x.action === 'occasion_type.merge').details).moved === 1 && !JSON.stringify(rows).includes('secret123'))
  }

  // ---- Reorder ----
  st = (await A.get('/api/state')).data
  const ids = st.occasion_types.map((x) => x.id)
  const rev = [...ids].reverse()
  r = await A.post('/api/occasion-types/reorder', { ids: rev })
  t('reorder applies the new order', r.status === 200 && JSON.stringify(r.data.occasion_types.map((x) => x.id)) === JSON.stringify(rev))
  r = await A.post('/api/occasion-types/reorder', { ids: [ids[0], 999999] })
  t('reorder with a foreign/unknown id rejected', r.status === 404)
  r = await A.post('/api/occasion-types/reorder', { ids: [ids[3]] })
  t('partial reorder puts the listed ids first', r.status === 200 && r.data.occasion_types[0].id === ids[3] && r.data.occasion_types.length === ids.length)

  // ---- Isolation ----
  const bSt = (await new Client().get('/api/state')).status
  t('state still needs login', bSt === 401)
  const pst = await (async () => { const c = new Client(); await c.post('/api/auth/login', { email: 'bob@example.com', password: 'secret456' }); c.space = bPersonal; return c })()
  let bs = (await pst.get('/api/state')).data
  t("Bob's personal space has its own defaults, untouched by changes in the shared space", OT(bs, 'birthday').name === null && bs.occasion_types.length === 11 && bs.occasion_types.every((x) => !x.hidden))
  r = await pst.put(`/api/occasion-types/${bday.id}`, { name: 'Hacked' })
  t("cannot edit another space's type (id of the shared space, header of own space)", r.status === 404 && r.data.code === 'occasion_type_not_found', r)
  r = await pst.del(`/api/occasion-types/${OT(st, 'easter').id}`)
  t("cannot delete another space's type", r.status === 404)
  r = await pst.post(`/api/occasion-types/${OT(st, 'easter').id}/merge`, { into_id: OT(bs, 'other').id })
  t("cannot merge another space's type", r.status === 404)
  r = await pst.post('/api/occasions', { name: 'Foreign type', type: 'custom_nothere', date: '2032-01-01' })
  t('type keys are validated per space', r.status === 400)
  r = await new Client().put(`/api/occasion-types/${bday.id}`, { name: 'x' })
  t('unauthenticated edit -> 401', r.status === 401)

  // ---- API v1 ----
  A.space = shared.id
  r = await A.post('/api/account/api-keys', { name: 'k', scopes: ['read'] })
  const KEY = r.data.secret
  const v1 = async (url) => { const x = await fetch(BASE + '/api/v1' + url, { headers: { Authorization: `Bearer ${KEY}` } }); return { status: x.status, data: await x.json() } }
  r = await A.post('/api/occasion-types', { name: 'Osterfest' })
  const fest = r.data.occasion_types.find((x) => x.name === 'Osterfest')
  r = await A.post('/api/occasions', { name: 'Egg hunt', type: fest.key, date: '2032-04-01' })
  r = await A.post('/api/occasions', { name: 'Xmas eve', type: 'christmas', date: '2032-12-24' })
  const o1 = await v1(`/occasions?space=${shared.id}`)
  const egg = o1.data.find?.((o) => o.name === 'Egg hunt')
  const xm = o1.data.find?.((o) => o.name === 'Xmas eve')
  t('v1 occasions: key + display name (custom type)', o1.status === 200 && egg?.type === fest.key && egg.type_name === 'Osterfest', o1.data)
  t('v1 occasions: built-in resolves to its localized label', xm?.type === 'christmas' && ['Christmas', 'Weihnachten'].includes(xm.type_name), xm)
  const spec = await (await fetch(BASE + '/api/v1/openapi.json')).json().catch(() => null)
  t('OpenAPI documents type_name', !spec || JSON.stringify(spec).includes('type_name'))

  // ---- Export / import round trip ----
  A.space = shared.id
  r = await A.post('/api/occasion-types', { name: 'Round trip', icon: 'trophy', default_month_day: '05-05', default_recurring: true })
  const rt = r.data.occasion_types.find((x) => x.name === 'Round trip')
  await A.post('/api/occasions', { name: 'RT occasion', type: rt.key, date: '2033-05-05' })
  await A.post(`/api/occasion-types/${OT(st, 'easter').id}/hide`)
  const exp = (await A.get('/api/export')).data
  t('export includes occasion_types', Array.isArray(exp.occasion_types) && exp.occasion_types.some((x) => x.key === rt.key && x.name === 'Round trip') && exp.occasion_types.every((x) => !('space_id' in x)), exp.occasion_types?.slice(0, 2))
  r = await A.post('/api/import', exp)
  t('import ok', r.status === 200, r.data)
  st = (await A.get('/api/state')).data
  t('round trip keeps custom type, hidden flag, order and usage', OT(st, rt.key)?.name === 'Round trip' && OT(st, rt.key).icon === 'trophy' && OT(st, rt.key).default_month_day === '05-05' && OT(st, 'easter').hidden === 1 && OT(st, 'easter').name === null && OT(st, rt.key).usage === 1
    && JSON.stringify(st.occasion_types.map((x) => x.key)) === JSON.stringify(exp.occasion_types.map((x) => x.key)), st.occasion_types.map((x) => x.key))
  // Export without the types table: defaults are seeded; unknown stored types are adopted
  const old = { ...exp }
  delete old.occasion_types
  r = await A.post('/api/import', old)
  st = (await A.get('/api/state')).data
  t('import without the types table seeds the defaults and adopts used custom types', r.status === 200 && DEFAULT_KEYS.every((k) => OT(st, k) && OT(st, k).name === null && OT(st, k).hidden === 0) && OT(st, rt.key)?.name === rt.key && OT(st, rt.key).usage === 1, st.occasion_types.map((x) => [x.key, x.name]))
  r = await A.post('/api/import', { ...exp, occasion_types: [{ key: 'weird', name: 'Weird', icon: 'bad-icon', default_month_day: '99-99', default_recurring: 1 }] })
  st = (await A.get('/api/state')).data
  t('import sanitizes icon/date and restores all built-ins', OT(st, 'weird')?.icon === 'calendar' && OT(st, 'weird').default_month_day === null && DEFAULT_KEYS.every((k) => OT(st, k)), st.occasion_types.map((x) => x.key))
  r = await A.post('/api/import', { ...exp, occasion_types: [{ key: 'christmas', builtin_key: 'christmas', name: 'Hacked', icon: 'star', default_month_day: '01-01', default_recurring: 0, hidden: 1 }, { key: 'easter', name: 'Fake builtin' }] })
  st = (await A.get('/api/state')).data
  t('import: built-ins keep their fixed definition (name/icon ignored), hidden is kept, fake built-in rejected', OT(st, 'christmas').name === null && OT(st, 'christmas').icon === 'tree-pine' && OT(st, 'christmas').hidden === 1 && OT(st, 'easter').builtin_key === 'easter' && OT(st, 'easter').name === null, [OT(st, 'christmas'), OT(st, 'easter')])

  // ---- Frontend icon map covers exactly the server allow-list ----
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/occasion-icons.ts'), 'utf8')
    const start = src.indexOf('OCCASION_ICON_MAP: ')
    const body = src.slice(start, src.indexOf('\n}', start))
    const names = [...body.matchAll(/(?:^|[\s,{])(?:'([\w-]+)'|([a-z]\w*))\s*:\s*[A-Z]\w*/g)].map((m) => m[1] ?? m[2])
    const OCCASION_ICONS = (await A.get('/api/occasion-types')).data.icons
    t('src/occasion-icons.ts maps exactly the names of OCCASION_ICONS', names.length === OCCASION_ICONS.length && OCCASION_ICONS.every((n) => names.includes(n)) && new Set(names).size === names.length, { names, OCCASION_ICONS })
  }

  // ---- Demo data ----
  r = await A.post('/api/spaces', { name: 'Demo' })
  const demo = r.data.spaces.find((s) => s.name === 'Demo')
  A.space = demo.id
  r = await A.post('/api/demo')
  t('demo loads with defaults + a custom type', r.status === 200 && DEFAULT_KEYS.every((k) => OT(r.data, k)) && r.data.occasion_types.some((x) => !x.builtin_key), r.status)

  // ---- Space deletion removes its types ----
  r = await A.del(`/api/spaces/${demo.id}`)
  {
    const d = rawDb()
    t('deleting a space removes its occasion types', d.prepare('SELECT COUNT(*) AS n FROM occasion_types WHERE space_id=?').get(demo.id).n === 0)
    d.close()
  }
}

try {
  await main()
} catch (e) {
  results.push('CRASH ' + e.stack); failN++
} finally {
  try { await stop() } catch {}
  console.log(results.join('\n'))
  console.log(`occasion-types: ${pass} passed, ${failN} failed`)
  await new Promise((r) => setTimeout(r, 500))
  fs.rmSync(DATA, { recursive: true, force: true })
  process.exit(failN ? 1 : 0)
}
