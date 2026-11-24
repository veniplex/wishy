// Relationship types per space (same logic as the occasion types): seeding, fixed built-ins (hide/show only), custom types, permission
// (manage_persons), in-use/merge/delete, reorder, isolation between spaces, person validation (key, hidden, free text of older clients,
// the removed relationship_group), export/import (also a 1.0.x backup with free text), API v1 output, audit, and the schema 3
// migration of a database with free-text relationships and groups (idempotent, two spaces, built-in name matching).
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA = path.join(os.tmpdir(), 'wl-reltypes-' + Date.now())
const PORT = Number(process.env.SMOKE_PORT) || 4134
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
  async req(method, url, body) {
    const h = { 'X-Requested-With': 'x' }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    if (this.space) h['X-Space'] = String(this.space)
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
const ok = (r) => r.status === 200
const code = (r, status, c) => r.status === status && r.data?.code === c
const rawDb = () => new DatabaseSync(path.join(DATA, 'wishlist.db'), { timeout: 5000 }) // the server writes at the same time
const BUILTIN_KEYS = ['parent', 'child', 'sibling', 'partner', 'grandparent', 'grandchild', 'aunt_uncle', 'cousin', 'in_law', 'friend', 'colleague', 'neighbour', 'acquaintance', 'other']

async function main() {
  const A = new Client(), B = new Client()
  await start()
  let r = await A.post('/api/auth/setup', { name: 'Alice', email: 'alice@example.com', password: 'secret123' })
  t('setup', ok(r), r)
  const x = await A.post('/api/admin/invites', {})
  r = await B.post('/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'secret456', invite: x.data.url.split('=')[1] })
  t('register Bob', ok(r), r)

  // ---- Seeding: every new space has the built-in types in the default order, none hidden ----
  let st = (await A.get('/api/state')).data
  t('personal space has the built-in relationship types in order', JSON.stringify(st.relationship_types.map((x) => x.key)) === JSON.stringify(BUILTIN_KEYS), st.relationship_types.map((x) => x.key))
  t('built-ins have no name and are not hidden', st.relationship_types.every((x) => x.builtin_key === x.key && x.name === null && !x.hidden && x.usage === 0), st.relationship_types[0])
  r = await A.get('/api/relationship-types')
  t('GET /api/relationship-types', ok(r) && r.data.types.length === BUILTIN_KEYS.length, r.data)
  r = await A.post('/api/spaces', { name: 'Team' })
  const team = r.data.spaces.find((s) => s.name === 'Team')
  A.space = team.id
  st = (await A.get('/api/state')).data
  t('a new shared space is seeded as well', st.relationship_types.length === BUILTIN_KEYS.length, st.relationship_types.length)

  // ---- Custom types ----
  r = await A.post('/api/relationship-types', { name: '  Godchild  ' })
  const god = r.data.relationship_types.find((x) => x.name === 'Godchild')
  t('create custom type (name trimmed, key custom_*)', ok(r) && god && /^custom_[a-f0-9]{10}$/.test(god.key) && god.builtin_key === null && r.data.persons, r.data)
  r = await A.post('/api/relationship-types', { name: '' })
  t('empty name -> 400 name_required', code(r, 400, 'name_required'), r.data)
  r = await A.post('/api/relationship-types', { name: 'godchild' })
  t('duplicate name (case-insensitive) -> 409', code(r, 409, 'relationship_type_exists'), r.data)
  r = await A.post('/api/relationship-types', { name: 'friend' })
  t('a built-in name counts as taken -> 409', code(r, 409, 'relationship_type_exists'), r.data)
  r = await A.post('/api/relationship-types', { name: 'Freund/in' })
  t('the German built-in name counts as taken too', code(r, 409, 'relationship_type_exists'), r.data)
  r = await A.put(`/api/relationship-types/${god.id}`, { name: 'Goddaughter' })
  t('rename a custom type', ok(r) && r.data.relationship_types.some((x) => x.id === god.id && x.name === 'Goddaughter'), r.data)
  const friend = st.relationship_types.find((x) => x.key === 'friend')
  r = await A.put(`/api/relationship-types/${friend.id}`, { name: 'Buddy' })
  t('built-in types cannot be renamed', code(r, 400, 'relationship_type_builtin'), r.data)
  r = await A.del(`/api/relationship-types/${friend.id}`)
  t('built-in types cannot be deleted', code(r, 400, 'relationship_type_builtin'), r.data)
  r = await A.post(`/api/relationship-types/${friend.id}/merge`, { into_id: god.id })
  t('built-in types cannot be merged away', code(r, 400, 'relationship_type_builtin'), r.data)
  r = await A.put('/api/relationship-types/99999', { name: 'x' })
  t('unknown type -> 404', code(r, 404, 'relationship_type_not_found'), r.data)

  // ---- Persons: key, empty, hidden, free text of older clients, removed relationship_group ----
  r = await A.post('/api/persons', { name: 'Anna', relationship: 'friend', relationship_group: 'friends' })
  const anna = r.data.persons.find((p) => p.name === 'Anna')
  t('create a person with a type key; relationship_group is ignored and not returned', ok(r) && anna.relationship === 'friend' && !('relationship_group' in anna), anna)
  r = await A.put(`/api/persons/${anna.id}`, { relationship: '' })
  t('empty relationship clears it', ok(r) && r.data.persons.find((p) => p.id === anna.id).relationship === null, r.data.persons)
  r = await A.put(`/api/persons/${anna.id}`, { relationship: 'Freundin' })
  t('free text equal to a built-in name/alias maps to the built-in (de alias)', ok(r) && r.data.persons.find((p) => p.id === anna.id).relationship === 'friend', r.data.persons.find((p) => p.id === anna.id))
  r = await A.put(`/api/persons/${anna.id}`, { relationship: 'COLLEAGUE' })
  t('free text is matched case-insensitively', r.data.persons.find((p) => p.id === anna.id).relationship === 'colleague')
  const before = (await A.get('/api/state')).data.relationship_types.length
  r = await A.put(`/api/persons/${anna.id}`, { relationship: 'Goddaughter' })
  t('free text equal to a custom name maps to it without a new type', r.data.persons.find((p) => p.id === anna.id).relationship === god.key && r.data.relationship_types.length === before)
  r = await A.put(`/api/persons/${anna.id}`, { relationship: 'Dance partner' })
  const dance = r.data.relationship_types.find((x) => x.name === 'Dance partner')
  t('unknown free text creates a custom type and links the person (older clients)', dance && r.data.persons.find((p) => p.id === anna.id).relationship === dance.key, r.data.relationship_types.map((x) => x.name))
  r = await A.put(`/api/persons/${anna.id}`, { relationship: 123 })
  t('non-string relationship -> 400', code(r, 400, 'relationship_invalid'), r.data)
  r = await A.put(`/api/persons/${anna.id}`, { relationship: 'friend' })
  t('type usage is counted', r.data.relationship_types.find((x) => x.key === 'friend').usage === 1)

  // ---- Hide / show ----
  r = await A.post(`/api/relationship-types/${friend.id}/hide`)
  t('hide a built-in type', ok(r) && r.data.relationship_types.find((x) => x.key === 'friend').hidden === 1, r.data)
  r = await A.put(`/api/persons/${anna.id}`, { name: 'Anna B', relationship: 'friend' })
  t('a hidden type stays valid for persons that already have it', ok(r), r.data)
  r = await A.post('/api/persons', { name: 'Ben', relationship: 'friend' })
  t('a hidden type cannot be assigned to someone else -> 400', code(r, 400, 'relationship_invalid'), r.data)
  r = await A.post(`/api/relationship-types/${friend.id}/show`)
  t('show again', ok(r) && !r.data.relationship_types.find((x) => x.key === 'friend').hidden)
  r = await A.get('/api/state')
  for (const ty of r.data.relationship_types.filter((x) => x.key !== 'other')) await A.post(`/api/relationship-types/${ty.id}/hide`)
  st = (await A.get('/api/state')).data
  t('every type can be hidden (the relationship is optional)', st.relationship_types.filter((x) => x.key !== 'other').every((x) => x.hidden))
  for (const ty of st.relationship_types) await A.post(`/api/relationship-types/${ty.id}/show`)

  // ---- In use: delete -> 409, merge moves the persons ----
  await A.put('/api/persons/' + anna.id, { relationship: dance.key })
  r = await A.del(`/api/relationship-types/${dance.id}`)
  t('delete while in use -> 409 with the count', code(r, 409, 'relationship_type_in_use') && (r.data.params?.count ?? r.data.count) === 1, r.data)
  r = await A.post(`/api/relationship-types/${dance.id}/merge`, { into_id: dance.id })
  t('merge into itself -> 400', code(r, 400, 'relationship_type_merge_target'), r.data)
  r = await A.post(`/api/relationship-types/${dance.id}/merge`, { into_id: friend.id })
  t('merge moves the persons and deletes the type', ok(r) && !r.data.relationship_types.some((x) => x.id === dance.id) && r.data.persons.find((p) => p.id === anna.id).relationship === 'friend', r.data)
  r = await A.del(`/api/relationship-types/${god.id}`)
  t('delete an unused custom type', ok(r) && !r.data.relationship_types.some((x) => x.id === god.id))

  // ---- Reorder ----
  st = (await A.get('/api/state')).data
  const ids = st.relationship_types.map((x) => x.id)
  r = await A.post('/api/relationship-types/reorder', { ids: [ids[3], ids[0]] })
  t('reorder: given ids first, the rest keeps its order', ok(r) && JSON.stringify(r.data.relationship_types.slice(0, 4).map((x) => x.id)) === JSON.stringify([ids[3], ids[0], ids[1], ids[2]]), r.data.relationship_types.map((x) => x.id))
  r = await A.post('/api/relationship-types/reorder', { ids: [99999] })
  t('reorder with a foreign id -> 404', r.status === 404)
  r = await A.post('/api/relationship-types/reorder', { ids: 'x' })
  t('reorder with garbage -> 400', code(r, 400, 'ids_invalid'))

  // ---- Isolation and permission ----
  r = await B.get('/api/state')
  t("another user's space is not affected (no custom types)", r.data.relationship_types.length === BUILTIN_KEYS.length)
  r = await A.post(`/api/spaces/${team.id}/invites`)
  r = await B.post(`/api/invites/${r.data.token}/accept`)
  B.space = team.id
  r = await B.post('/api/relationship-types', { name: 'Member type' })
  t('a member has manage_persons by default and may create types', ok(r), r.data)
  const memberTy = r.data.relationship_types.find((x) => x.name === 'Member type')
  const bobId = (await B.get('/api/state')).data.user_id
  r = await A.put(`/api/spaces/${team.id}/members/${bobId}/permissions`, { permissions: { manage_persons: false } })
  t('owner removes manage_persons', ok(r), r.data)
  for (const [m, p, b] of [['post', '/api/relationship-types', { name: 'No' }], ['put', `/api/relationship-types/${memberTy.id}`, { name: 'No' }], ['post', `/api/relationship-types/${memberTy.id}/hide`, {}],
    ['post', '/api/relationship-types/reorder', { ids: [] }], ['delete', `/api/relationship-types/${memberTy.id}`], ['post', `/api/relationship-types/${memberTy.id}/merge`, { into_id: 1 }]]) {
    r = await B.req(m.toUpperCase(), p, b)
    t(`without manage_persons: ${m.toUpperCase()} ${p} -> 403`, r.status === 403 && r.data.code === 'permission_denied' && r.data.params?.permission === 'manage_persons', r.data)
  }
  r = await B.get('/api/relationship-types')
  t('reading the types stays allowed', ok(r))
  r = await A.put(`/api/spaces/${team.id}/members/${bobId}/permissions`, { permissions: { manage_persons: true } })
  A.space = null

  // ---- Export / import ----
  A.space = null
  await A.post('/api/relationship-types', { name: 'Hidden custom' })
  let ex = (await A.get('/api/export')).data
  const hc = ex.relationship_types.find((x) => x.name === 'Hidden custom')
  await A.post('/api/persons', { name: 'Cora', relationship: hc.key })
  await A.post(`/api/relationship-types/${hc.id}/hide`)
  await A.post(`/api/relationship-types/${(await A.get('/api/state')).data.relationship_types.find((x) => x.key === 'cousin').id}/hide`)
  ex = (await A.get('/api/export')).data
  t('export carries relationship_types and no usage/group', ex.relationship_types.length === BUILTIN_KEYS.length + 1 && ex.relationship_types.every((x) => x.usage === undefined) && ex.persons.every((p) => !('relationship_group' in p)), ex.relationship_types.length)
  r = await A.post('/api/import', ex)
  t('import of a current export', ok(r), r.data)
  st = (await A.get('/api/state')).data
  t('import restores types (custom, hidden flags, order) and the links', st.relationship_types.find((x) => x.key === hc.key)?.hidden === 1 && st.relationship_types.find((x) => x.key === 'cousin').hidden === 1
    && st.persons.find((p) => p.name === 'Cora').relationship === hc.key && JSON.stringify(st.relationship_types.map((x) => x.key)) === JSON.stringify(ex.relationship_types.map((x) => x.key)), st.relationship_types.map((x) => [x.key, x.hidden]))
  // A 1.0.x backup: free text, relationship_group, no relationship_types
  const legacy = { app: 'wishlist', version: 1, persons: [
    { id: 1, name: 'Mama', relationship: 'Mutter', relationship_group: 'family' }, { id: 2, name: 'Papa', relationship: 'mutter', relationship_group: 'family' },
    { id: 3, name: 'Fritz', relationship: 'Freund', relationship_group: 'friends' }, { id: 4, name: 'Zed', relationship: '  ', relationship_group: 'other' }, { id: 5, name: 'Yan', relationship: null } ],
  occasions: [], items: [], gifts: [] }
  r = await A.post('/api/import', legacy)
  t('import of a 1.0.x backup', ok(r), r.data)
  st = (await A.get('/api/state')).data
  const rel = (n) => st.persons.find((p) => p.name === n).relationship
  const mutter = st.relationship_types.find((x) => x.name?.toLowerCase() === 'mutter')
  t('legacy import: built-in defaults seeded, nothing hidden', st.relationship_types.filter((x) => x.builtin_key).length === BUILTIN_KEYS.length && !st.relationship_types.some((x) => x.hidden), st.relationship_types.map((x) => x.key))
  t('legacy import: free text becomes types (same text case-insensitively = one type, built-in names map to the built-in)', rel('Mama') === rel('Papa') && mutter && rel('Mama') === mutter.key && rel('Fritz') === 'friend' && rel('Zed') === null && rel('Yan') === null, st.persons.map((p) => [p.name, p.relationship]))

  // ---- API v1 ----
  r = await A.post('/api/account/api-keys', { name: 'k', scopes: ['read'] })
  const KEY = r.data.secret
  const v1 = await fetch(BASE + '/api/v1/persons', { headers: { Authorization: `Bearer ${KEY}` } })
  const people = await v1.json()
  const fritz = people.find?.((p) => p.name === 'Fritz')
  t('v1 persons: relationship = display name, relationship_type = key, no relationship_group', v1.status === 200 && ['Friend', 'Freund/in'].includes(fritz?.relationship) && fritz.relationship_type === 'friend' && !('relationship_group' in fritz) && people.find((p) => p.name === 'Yan').relationship === null, people)
  const spec = await (await fetch(BASE + '/api/v1/openapi.json')).json().catch(() => null)
  const props = spec?.components?.schemas?.Person?.properties
  t('OpenAPI Person: relationship_type, no relationship_group', props && props.relationship_type && !props.relationship_group, props && Object.keys(props))

  // ---- Audit ----
  {
    const d = rawDb()
    const rows = d.prepare("SELECT action, details FROM audit_log WHERE action LIKE 'relationship_type.%' ORDER BY id").all()
    d.close()
    const acts = rows.map((x) => x.action)
    t('audit entries for create/update/delete/merge', ['relationship_type.create', 'relationship_type.update', 'relationship_type.delete', 'relationship_type.merge'].every((a) => acts.includes(a)), acts)
    t('audit: a type created from free text on a person is logged with its source', rows.some((x) => x.action === 'relationship_type.create' && JSON.parse(x.details || '{}').source === 'person'))
  }

  // ---- Migration: schema 2 database with free-text relationships and groups, two spaces ----
  await stop()
  const d = rawDb()
  const aliceSpace = d.prepare("SELECT s.id FROM spaces s JOIN space_members m ON m.space_id=s.id JOIN users u ON u.id=m.user_id WHERE u.email='alice@example.com' AND s.personal=1").get().id
  const bobSp = d.prepare("SELECT s.id FROM spaces s JOIN space_members m ON m.space_id=s.id JOIN users u ON u.id=m.user_id WHERE u.email='bob@example.com' AND s.personal=1").get().id
  t('test setup: two personal spaces', aliceSpace && bobSp && aliceSpace !== bobSp, { aliceSpace, bobSp })
  // Back to the 1.0.x shape: no table, free text and groups in persons
  d.exec('DELETE FROM persons WHERE space_id IN (' + aliceSpace + ',' + bobSp + ') AND linked_user_id IS NULL')
  d.exec('DROP TABLE relationship_types')
  const ins = d.prepare('INSERT INTO persons (name, relationship, relationship_group, space_id) VALUES (?,?,?,?)')
  const rows0 = [
    ['P1', 'Partnerin', 'partner'], ['P2', 'partner', 'partner'], ['P3', ' PARTNER ', 'family'], ['P4', 'Mutter', 'family'], ['P5', 'mutter', 'family'], ['P6', 'MUTTER ', null],
    ['P7', 'Oma', 'family'], ['P8', 'Friend', 'friends'], ['P9', 'Kollege', 'work'], ['P10', '', 'other'], ['P11', '   ', null], ['P12', null, 'work'], ['P13', 'Cousin', 'family'],
    ['P14', 'other', 'other'], ['P15', 'Best friend', 'friends'],
  ]
  for (const [n, rel2, g] of rows0) ins.run(n, rel2, g, aliceSpace)
  ins.run('Q1', 'Oma', 'family', bobSp)
  ins.run('Q2', 'Friend', null, bobSp)
  d.exec('PRAGMA user_version = 2')
  d.close()
  await start()
  const snapshot = () => {
    const x = rawDb()
    const types = x.prepare('SELECT space_id, key, builtin_key, name, sort, hidden FROM relationship_types ORDER BY space_id, sort, id').all()
    const ps = x.prepare('SELECT name, relationship, relationship_group FROM persons WHERE name LIKE \'P%\' OR name LIKE \'Q%\' ORDER BY name').all()
    const ver = Number(x.prepare('PRAGMA user_version').get().user_version)
    const hist = x.prepare("SELECT value FROM system_settings WHERE key='schema_history'").get()
    x.close()
    return { types, ps, ver, hist: JSON.parse(hist?.value || '[]') }
  }
  const s1 = snapshot()
  const typeOf = (sp, key) => s1.types.find((x) => x.space_id === sp && x.key === key)
  const relOf = (n) => s1.ps.find((p) => p.name === n).relationship
  const custom = (sp) => s1.types.filter((x) => x.space_id === sp && !x.builtin_key)
  t('migration: schema version is 3 and recorded in the history', s1.ver >= 3 && s1.hist.some((h) => h.version === 3 && h.name === 'relationship-types'), { v: s1.ver, hist: s1.hist })
  t('migration: both spaces got every built-in type', [aliceSpace, bobSp].every((sp) => BUILTIN_KEYS.every((k) => typeOf(sp, k)?.builtin_key === k && typeOf(sp, k).name === null)))
  t('migration: built-in names/aliases map to the built-in (Partnerin, partner, " PARTNER ", Friend, Kollege, Cousin, other)',
    ['P1', 'P2', 'P3'].every((n) => relOf(n) === 'partner') && relOf('P8') === 'friend' && relOf('P9') === 'colleague' && relOf('P13') === 'cousin' && relOf('P14') === 'other', s1.ps)
  t('migration: the same custom text (any case/spacing) becomes ONE custom type', relOf('P4') === relOf('P5') && relOf('P5') === relOf('P6') && /^custom_/.test(relOf('P4')) && typeOf(aliceSpace, relOf('P4')).name === 'Mutter', s1.ps.slice(3, 6))
  t('migration: other free text becomes its own custom types in the right space', typeOf(aliceSpace, relOf('P7'))?.name === 'Oma' && typeOf(aliceSpace, relOf('P15'))?.name === 'Best friend' && typeOf(bobSp, relOf('Q1'))?.name === 'Oma', s1.ps)
  t('migration: custom types exist per space (no sharing between spaces)', custom(aliceSpace).map((x) => x.name).sort().join() === 'Best friend,Mutter,Oma' && custom(bobSp).map((x) => x.name).join() === 'Oma' && !s1.types.some((x) => x.space_id === bobSp && x.key === relOf('P7')), { a: custom(aliceSpace), b: custom(bobSp) })
  t('migration: empty/blank/NULL relationships become NULL', ['P10', 'P11', 'P12'].every((n) => relOf(n) === null), s1.ps.slice(9, 12))
  t('migration: Bob\'s Friend maps to the built-in of his space', relOf('Q2') === 'friend')
  t('migration: relationship_group is left untouched in the database (column kept, no longer used)', s1.ps.find((p) => p.name === 'P1').relationship_group === 'partner')
  t('migration: no person points to a missing type', (() => { const x = rawDb(); const n = x.prepare('SELECT COUNT(*) AS n FROM persons p WHERE p.relationship IS NOT NULL AND NOT EXISTS (SELECT 1 FROM relationship_types t WHERE t.space_id=p.space_id AND t.key=p.relationship)').get().n; x.close(); return n === 0 })())
  // Second run: force the step again by lowering the version; nothing may change
  await stop()
  const d3 = rawDb(); d3.exec('PRAGMA user_version = 2'); d3.close()
  await start()
  const s2 = snapshot()
  t('migration is idempotent (types and links identical after a second run)', JSON.stringify(s2.types) === JSON.stringify(s1.types) && JSON.stringify(s2.ps) === JSON.stringify(s1.ps) && s2.ver >= 3, { a: s1.types.length, b: s2.types.length })
  // A schema 1 database goes through both steps
  await stop()
  const d4 = rawDb()
  for (const [n, rel2] of rows0) d4.prepare('UPDATE persons SET relationship=? WHERE name=?').run(rel2, n) // back to free text (the old database had no keys)
  d4.prepare("UPDATE persons SET relationship='Oma' WHERE name='Q1'").run()
  d4.exec('ALTER TABLE persons DROP COLUMN photo_file'); d4.exec('DROP TABLE relationship_types'); d4.exec('PRAGMA user_version = 1'); d4.close()
  await start()
  const s3 = snapshot()
  const d5 = rawDb(); const cols = d5.prepare('PRAGMA table_info(persons)').all().map((c) => c.name); d5.close()
  t('migration from schema 1 runs every step', s3.ver >= 3 && cols.includes('photo_file') && s3.types.length > 0, { v: s3.ver, cols })
  r = await A.post('/api/auth/login', { email: 'alice@example.com', password: 'secret123' })
  st = (await A.get('/api/state')).data
  const oma = st.persons.find((p) => p.name === 'P7')
  t('the migrated space works: state shows type and persons', st.relationship_types.some((x) => x.key === oma?.relationship && x.name === 'Oma') && st.relationship_types.find((x) => x.key === 'partner').usage === 3, st.relationship_types.map((x) => [x.key, x.usage]))
  r = await A.put(`/api/persons/${oma.id}`, { relationship: 'grandparent' })
  t('and a migrated person can be edited', ok(r) && r.data.persons.find((p) => p.id === oma.id).relationship === 'grandparent')

  await stop()
}

main()
  .catch((e) => { failN++; results.push('CRASH ' + (e?.stack || e)) })
  .finally(() => {
    try { server?.kill() } catch {}
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
    for (const l of results) console.log(l)
    console.log(`relationship-types: ${pass} passed, ${failN} failed`)
    process.exit(failN ? 1 : 0)
  })
