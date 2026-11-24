// Person photos: upload/replace/remove (type + size limits), authenticated serving with the person's access rules (space members only,
// manage_persons for changes), file cleanup (replace, remove, delete person, merge, import), export without files, backup coverage,
// the additive migration of a 1.0.x database, and server-side emoji validation.
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA = path.join(os.tmpdir(), 'wl-photos-' + Date.now())
const PORT = Number(process.env.SMOKE_PORT) || 4133
const BASE = `http://127.0.0.1:${PORT}`
const AV = path.join(DATA, 'avatars')
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
  async raw(method, url, { body, headers = {}, form } = {}) {
    const h = { 'X-Requested-With': 'x', ...headers }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    if (this.space && !h['X-Space']) h['X-Space'] = String(this.space)
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    if (ck) h.Cookie = ck
    const res = await fetch(BASE + url, { method, headers: h, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' })
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      if (/Max-Age=0/i.test(c)) delete this.cookies[kv.slice(0, i)]; else this.cookies[kv.slice(0, i)] = kv.slice(i + 1)
    }
    return res
  }
  async req(method, url, body, headers) {
    const res = await this.raw(method, url, { body, headers })
    let data = null
    try { data = await res.json() } catch {}
    return { status: res.status, data }
  }
  get(u) { return this.req('GET', u) }
  post(u, b = {}) { return this.req('POST', u, b) }
  put(u, b = {}) { return this.req('PUT', u, b) }
  del(u) { return this.req('DELETE', u) }
  /** multipart upload like the UI does it */
  async upload(u, bytes, type = 'image/png', name = 'photo.png') {
    const form = new FormData()
    form.append('avatar', new Blob([bytes], { type }), name)
    const res = await this.raw('POST', u, { form })
    let data = null
    try { data = await res.json() } catch {}
    return { status: res.status, data }
  }
}

let pass = 0, failN = 0
const results = []
const t = (name, cond, extra) => {
  if (cond) pass++
  else { failN++; results.push('FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 400) : '')) }
}
const ok = (r) => r.status === 200
const rawDb = () => new DatabaseSync(path.join(DATA, 'wishlist.db'), { timeout: 5000 }) // the server writes at the same time
const files = () => (fs.existsSync(AV) ? fs.readdirSync(AV).sort() : [])

// Smallest valid PNG (1x1) plus padding variants to make files distinguishable
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const PNG2 = Buffer.concat([PNG, Buffer.from('second')])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)])

async function main() {
  const A = new Client(), B = new Client(), C = new Client()
  await start()
  let r = await A.post('/api/auth/setup', { name: 'Alice', email: 'alice@example.com', password: 'secret123' })
  t('setup', ok(r), r)
  const inv = async () => (await A.post('/api/admin/invites', {})).data.url.split('=')[1]
  r = await B.post('/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'secret456', invite: await inv() })
  t('register Bob', ok(r), r)
  r = await C.post('/api/auth/register', { name: 'Carol', email: 'carol@example.com', password: 'secret789', invite: await inv() })
  t('register Carol', ok(r), r)

  // ---- Alice's personal space ----
  r = await A.post('/api/persons', { name: 'Anna', emoji: '🎂' })
  const anna = r.data.persons.find((p) => p.name === 'Anna')
  t('new person has no photo', anna && anna.photo_url === null && anna.photo_file === undefined, anna)

  const bare = await fetch(BASE + `/api/person-photos/${anna.id}`)
  t('photo route needs a login (401)', bare.status === 401, bare.status)
  r = await A.get(`/api/person-photos/${anna.id}`)
  t('no photo yet -> 404', r.status === 404 && r.data.code === 'person_photo_not_found', r)

  r = await A.upload(`/api/persons/${anna.id}/photo`, PNG)
  t('upload PNG', ok(r) && /^\/api\/person-photos\/\d+\?v=[a-f0-9]{8}$/.test(r.data.photo_url), r)
  const url1 = r.data.photo_url
  t('one file stored', files().length === 1 && /^[a-f0-9]{32}\.png$/.test(files()[0]), files())
  let res = await A.raw('GET', url1)
  const buf = Buffer.from(await res.arrayBuffer())
  t('photo is served with the right type and cache headers', res.status === 200 && res.headers.get('content-type') === 'image/png'
    && /private/.test(res.headers.get('cache-control')) && res.headers.get('x-content-type-options') === 'nosniff' && buf.equals(PNG), { s: res.status, h: Object.fromEntries(res.headers) })
  r = await A.get('/api/state')
  const annaS = r.data.persons.find((p) => p.id === anna.id)
  t('state carries photo_url, never the file name', annaS.photo_url === url1 && annaS.photo_file === undefined && annaS.emoji === '🎂', annaS)

  // replace: the old file is removed, the URL changes (cache busting)
  const before = files()[0]
  r = await A.upload(`/api/persons/${anna.id}/photo`, JPG, 'image/jpeg', 'x.jpg')
  t('replace with JPEG', ok(r) && r.data.photo_url !== url1, r)
  t('old file removed on replace', files().length === 1 && files()[0] !== before && files()[0].endsWith('.jpg'), files())
  r = await A.upload(`/api/persons/${anna.id}/photo`, PNG2)
  t('replace with PNG again', ok(r), r)

  // ---- Validation ----
  const n = files().length
  r = await A.upload(`/api/persons/${anna.id}/photo`, Buffer.from('this is not an image at all'), 'image/png', 'x.png')
  t('not an image (magic bytes, not the Content-Type) -> 400', r.status === 400 && r.data.code === 'avatar_type', r)
  r = await A.upload(`/api/persons/${anna.id}/photo`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', 'x.svg')
  t('SVG rejected -> 400', r.status === 400 && r.data.code === 'avatar_type', r)
  r = await A.upload(`/api/persons/${anna.id}/photo`, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))
  t('more than 2 MB -> 413', r.status === 413 && r.data.code === 'avatar_too_large', r)
  r = await A.post(`/api/persons/${anna.id}/photo`, {})
  t('JSON without image -> 400', r.status === 400 && r.data.code === 'avatar_missing', r)
  r = await A.post(`/api/persons/${anna.id}/photo`, { data: `data:image/png;base64,${PNG.toString('base64')}` })
  t('base64 JSON upload works as well', ok(r), r)
  t('rejected uploads leave no files behind', files().length === n, files())
  r = await A.upload('/api/persons/99999/photo', PNG)
  t('unknown person -> 404', r.status === 404 && r.data.code === 'person_not_found', r)
  r = await A.upload('/api/persons/abc/photo', PNG)
  t('bad person id -> 404', r.status === 404, r)

  // ---- Access: another user in their own space ----
  r = await B.get(`/api/person-photos/${anna.id}`)
  t("another user cannot read the photo (404)", r.status === 404, r)
  r = await B.upload(`/api/persons/${anna.id}/photo`, PNG)
  t("another user cannot change the photo (404, person is not in their space)", r.status === 404 && r.data.code === 'person_not_found', r)
  r = await B.del(`/api/persons/${anna.id}/photo`)
  t("another user cannot remove the photo (404)", r.status === 404, r)
  t('photo untouched by the attempts', files().length === n)

  // ---- Shared space: members read, manage_persons decides who changes ----
  r = await A.post('/api/spaces', { name: 'Team' })
  const team = r.data.spaces.find((s) => s.name === 'Team')
  r = await A.post(`/api/spaces/${team.id}/invites`)
  r = await B.post(`/api/invites/${r.data.token}/accept`)
  A.space = team.id; B.space = team.id; C.space = team.id
  r = await A.post('/api/persons', { name: 'Team Tom' })
  const tom = r.data.persons.find((p) => p.name === 'Team Tom')
  r = await A.upload(`/api/persons/${tom.id}/photo`, PNG)
  t('owner uploads in the shared space', ok(r), r)
  r = await B.get(`/api/person-photos/${tom.id}`)
  t('member reads the photo (no X-Space needed for <img>)', ok(r) || r.status === 200, r.status)
  res = await B.raw('GET', `/api/person-photos/${tom.id}`, { headers: { 'X-Space': '999999' } })
  t('member reads the photo whatever the X-Space header says', res.status === 200, res.status)
  r = await C.get(`/api/person-photos/${tom.id}`)
  t('non-member cannot read it (404)', r.status === 404, r)
  r = await B.get('/api/state')
  t('member state has the photo_url', r.data.persons.find((p) => p.id === tom.id)?.photo_url?.startsWith(`/api/person-photos/${tom.id}?v=`), r.data.persons)
  r = await B.upload(`/api/persons/${tom.id}/photo`, PNG2)
  t('member may change it by default (manage_persons)', ok(r), r)
  r = await A.put(`/api/spaces/${team.id}/members/${(await B.get('/api/auth/me')).data.user.id}/permissions`, { permissions: { manage_persons: false } })
  t('owner revokes manage_persons', ok(r), r)
  r = await B.upload(`/api/persons/${tom.id}/photo`, PNG)
  t('without manage_persons: upload -> 403', r.status === 403 && r.data.code === 'permission_denied', r)
  r = await B.del(`/api/persons/${tom.id}/photo`)
  t('without manage_persons: remove -> 403', r.status === 403 && r.data.code === 'permission_denied', r)
  r = await B.get(`/api/person-photos/${tom.id}`)
  t('without manage_persons: reading still works', r.status === 200)

  // ---- Remove / delete / merge / import cleanup ----
  const f0 = files().length
  r = await A.del(`/api/persons/${tom.id}/photo`)
  t('remove photo', ok(r) && r.data.photo_url === null, r)
  t('file removed with the photo', files().length === f0 - 1, files())
  r = await A.get(`/api/person-photos/${tom.id}`)
  t('removed photo -> 404', r.status === 404)

  A.space = null
  r = await A.post('/api/persons', { name: 'Keep' })
  const keep = r.data.persons.find((p) => p.name === 'Keep')
  r = await A.post('/api/persons', { name: 'Drop' })
  const drop = r.data.persons.find((p) => p.name === 'Drop')
  await A.upload(`/api/persons/${drop.id}/photo`, PNG)
  const f1 = files().length
  r = await A.del(`/api/persons/${drop.id}`)
  t('delete person', ok(r), r)
  t('file removed with the person', files().length === f1 - 1, files())
  r = await A.get(`/api/person-photos/${drop.id}`)
  t('deleted person -> 404', r.status === 404)

  // export has no files / file names; import keeps persons without photo and cleans old files
  r = await A.get('/api/export')
  t('export does not contain photo data', ok(r) && r.data.persons.every((p) => p.photo_file === undefined && p.photo_url === undefined), r.data?.persons)
  const exported = r.data
  const withPhoto = files().length
  r = await A.post('/api/import', exported)
  t('import works', ok(r), r)
  t('import removes the photos of the replaced persons (the photos are not part of the file)', files().length < withPhoto, files())
  r = await A.get('/api/state')
  t('imported persons have no photo', r.data.persons.every((p) => p.photo_url === null))

  // ---- Backup includes the avatars directory (person photos live there) ----
  const anna2 = r.data.persons.find((p) => p.name === 'Anna')
  r = await A.upload(`/api/persons/${anna2.id}/photo`, PNG)
  t('upload after import', ok(r), r)
  r = await A.post('/api/admin/backups', { label: 'photos' })
  t('manual backup', ok(r), r)
  const counts = r.data?.backup?.counts ?? r.data?.backup?.manifest?.counts
  t('backup counts the photo file', counts && counts.avatars >= 1, r.data?.backup)

  // ---- Emoji validation ----
  r = await A.put(`/api/persons/${anna2.id}`, { emoji: '👨‍👩‍👧' })
  t('a ZWJ sequence counts as one emoji', ok(r), r)
  r = await A.put(`/api/persons/${anna2.id}`, { emoji: '❤️' })
  t('emoji with variation selector', ok(r), r)
  r = await A.put(`/api/persons/${anna2.id}`, { emoji: 'ab' })
  t('two characters -> 400 emoji_invalid', r.status === 400 && r.data.code === 'emoji_invalid', r)
  r = await A.put(`/api/persons/${anna2.id}`, { emoji: '😀😀' })
  t('two emoji -> 400 emoji_invalid', r.status === 400 && r.data.code === 'emoji_invalid', r)
  r = await A.put(`/api/persons/${anna2.id}`, { emoji: '<b>' })
  t('markup -> 400 emoji_invalid', r.status === 400 && r.data.code === 'emoji_invalid', r)
  r = await A.post('/api/persons', { name: 'Bad', emoji: 'toolongvalue' })
  t('create with an invalid emoji -> 400', r.status === 400 && r.data.code === 'emoji_invalid', r)
  r = await A.put(`/api/persons/${anna2.id}`, { emoji: '' })
  t('empty emoji clears it', ok(r) && r.data.persons.find((p) => p.id === anna2.id).emoji === null, r.data?.persons)
  // A legacy value (the old text field allowed up to 4 characters) must not block saving the person
  const d2 = rawDb()
  d2.prepare('UPDATE persons SET emoji=? WHERE id=?').run('ab', anna2.id)
  d2.close()
  r = await A.put(`/api/persons/${anna2.id}`, { emoji: 'ab', name: 'Anna renamed' })
  t('an unchanged legacy emoji stays accepted', ok(r), r)

  // ---- Migration: a 1.0.x database (schema version 1, no photo_file column) ----
  await stop()
  const d3 = rawDb()
  d3.exec('ALTER TABLE persons DROP COLUMN photo_file')
  d3.exec('PRAGMA user_version = 1')
  const colsBefore = d3.prepare('PRAGMA table_info(persons)').all().map((c) => c.name)
  d3.close()
  t('test setup: column removed', !colsBefore.includes('photo_file'))
  await start()
  const d4 = rawDb()
  const colsAfter = d4.prepare('PRAGMA table_info(persons)').all().map((c) => c.name)
  const ver = Number(d4.prepare('PRAGMA user_version').get().user_version)
  d4.close()
  t('migration adds persons.photo_file', colsAfter.includes('photo_file'), colsAfter)
  t('schema version is 2', ver >= 2, ver)
  r = await A.post('/api/auth/login', { email: 'alice@example.com', password: 'secret123' })
  r = await A.get('/api/state')
  t('persons survive the migration, without photo', ok(r) && r.data.persons.some((p) => p.name === 'Anna renamed' && p.photo_url === null), r.data?.persons)
  r = await A.upload(`/api/persons/${anna2.id}/photo`, PNG)
  t('photos work on the migrated database', ok(r), r)

  await stop()
}

main()
  .catch((e) => { failN++; results.push('CRASH ' + (e?.stack || e)) })
  .finally(() => {
    try { server?.kill() } catch {}
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
    for (const l of results) console.log(l)
    console.log(`person-photos: ${pass} passed, ${failN} failed`)
    process.exit(failN ? 1 : 0)
  })
