// Member permissions per space: effective permissions in me/state, defaults, every permission denied (403 permission_denied) and
// allowed (OK) on its endpoints, default permissions for new members, owner cannot be restricted, expenses redaction, public API v1, audit.
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA = path.join(os.tmpdir(), 'wl-perms-' + Date.now())
const PORT = Number(process.env.SMOKE_PORT) || 4132
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
const denied = (r, perm) => r.status === 403 && r.data?.code === 'permission_denied' && r.data?.params?.permission === perm
const ok = (r) => r.status === 200
const rawDb = () => new DatabaseSync(path.join(DATA, 'wishlist.db'), { timeout: 5000 }) // the server writes at the same time

const KEYS = ['invite_members', 'share_wishlists', 'manage_persons', 'manage_occasions', 'manage_gifts', 'view_expenses', 'manage_space_settings']
const DEFAULTS = { invite_members: false, share_wishlists: true, manage_persons: true, manage_occasions: true, manage_gifts: true, view_expenses: true, manage_space_settings: true }

async function main() {
  const A = new Client(), B = new Client(), C = new Client()
  await start()
  let r = await A.post('/api/auth/setup', { name: 'Alice', email: 'alice@example.com', password: 'secret123' })
  t('setup', ok(r), r)
  const inv = async (name, email) => {
    const x = await A.post('/api/admin/invites', {})
    return x.data.url.split('=')[1]
  }
  r = await B.post('/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'secret456', invite: await inv() })
  t('register Bob', ok(r), r)
  r = await C.post('/api/auth/register', { name: 'Carol', email: 'carol@example.com', password: 'secret789', invite: await inv() })
  t('register Carol', ok(r), r)

  r = await A.post('/api/spaces', { name: 'Team' })
  const team = r.data.spaces.find((s) => s.name === 'Team')
  const aliceId = r.data.user.id
  const alicePersonal = r.data.spaces.find((s) => s.personal).id
  t('owner has every permission in me.spaces', KEYS.every((k) => team.permissions?.[k] === true), team)
  r = await A.post(`/api/spaces/${team.id}/invites`)
  t('owner can invite', ok(r))
  r = await B.post(`/api/invites/${r.data.token}/accept`)
  const bobId = r.data.user.id
  const bobTeam = r.data.spaces.find((s) => s.id === team.id)
  const bobPersonal = r.data.spaces.find((s) => s.personal)
  t('new member gets the default permissions in me.spaces', JSON.stringify(bobTeam.permissions) === JSON.stringify(DEFAULTS), bobTeam.permissions)
  t('own personal space: all permissions', KEYS.every((k) => bobPersonal.permissions[k] === true))
  A.space = team.id; B.space = team.id; C.space = team.id

  let st = (await B.get('/api/state')).data
  const ownerState = (await A.get('/api/state')).data
  const meB = st.persons.find((p) => p.is_me)
  t('state carries the effective permissions (member)', JSON.stringify(st.permissions) === JSON.stringify(DEFAULTS), st.permissions)
  t('state carries the effective permissions (owner)', KEYS.every((k) => (ownerState.permissions[k]) === true), ownerState.permissions)

  // ---- Members endpoint ----
  r = await A.get(`/api/spaces/${team.id}/members`)
  const bobRow = r.data.find((m) => m.user_id === bobId)
  t('owner sees every member\'s permissions', r.data.every((m) => m.permissions) && JSON.stringify(bobRow.permissions) === JSON.stringify(DEFAULTS) && KEYS.every((k) => r.data.find((m) => m.role === 'owner').permissions[k]))
  r = await B.get(`/api/spaces/${team.id}/members`)
  t('a member does not get the permissions of others', ok(r) && r.data.every((m) => m.permissions === undefined))

  // ---- Defaults for members: everything a member could do before stays allowed (invite was owner-only) ----
  r = await B.post('/api/persons', { name: 'Anna' })
  const anna = r.data.persons?.find((p) => p.name === 'Anna')
  t('default: member may create persons', ok(r) && anna, r.data)
  r = await B.post('/api/occasions', { name: 'Party', type: 'other', date: '2032-05-05' })
  const party = r.data.occasions?.find((o) => o.name === 'Party')
  t('default: member may create occasions', ok(r) && party)
  r = await B.post('/api/items', { title: 'Book', person_id: anna.id })
  const book = r.data.items?.find((i) => i.title === 'Book')
  t('default: member may create ideas', ok(r) && book)
  r = await B.post('/api/gifts', { title: 'Scarf', price: 25, recipient_ids: [anna.id], occasion_id: party.id })
  const scarf = r.data.gifts?.find((g) => g.title === 'Scarf')
  t('default: member may create gifts', ok(r) && scarf?.price === 25)
  r = await B.post('/api/occasion-types', { name: 'Picnic' })
  t('default: member may create occasion types', ok(r))
  r = await B.put('/api/settings', { currency: 'CHF' })
  t('default: member may change the currency', ok(r) && r.data.settings.currency === 'CHF')
  r = await B.post(`/api/spaces/${team.id}/invites`)
  t('default: member may NOT invite (owner-only before) -> 403', denied(r, 'invite_members'), r.data)
  r = await B.put(`/api/spaces/${team.id}`, { name: 'Hijacked' })
  t('rename stays owner-only', r.status === 403 && r.data.code === 'space_owner_rename')

  // ---- Permission management is owner-only and validated ----
  const putPerm = (c, uid, permissions, sid = team.id) => c.put(`/api/spaces/${sid}/members/${uid}/permissions`, { permissions })
  r = await putPerm(B, bobId, { manage_gifts: true })
  t('member cannot change permissions (not even their own)', r.status === 403 && r.data.code === 'space_owner_permissions', r.data)
  r = await putPerm(A, aliceId, { manage_gifts: false })
  t('owner cannot be restricted', r.status === 400 && r.data.code === 'owner_permissions_fixed', r.data)
  st = (await A.get('/api/state')).data
  t('owner state unchanged', KEYS.every((k) => st.permissions[k] === true), st.permissions)
  r = await putPerm(A, bobId, { bogus: true })
  t('unknown permission key rejected', r.status === 400 && r.data.code === 'permissions_invalid')
  r = await putPerm(A, bobId, { manage_gifts: 'no' })
  t('non-boolean value rejected', r.status === 400 && r.data.code === 'permissions_invalid')
  r = await A.put(`/api/spaces/${team.id}/members/${bobId}/permissions`, {})
  t('missing permissions object rejected', r.status === 400 && r.data.code === 'permissions_invalid')
  r = await putPerm(A, 999999, { manage_gifts: false })
  t('unknown member -> 404', r.status === 404 && r.data.code === 'member_not_found')
  r = await putPerm(A, aliceId, { manage_gifts: false }, alicePersonal)
  t('personal space: no permission management', r.status === 400 && r.data.code === 'personal_space_permissions', r.data)
  r = await putPerm(C, bobId, { manage_gifts: false })
  t('non-member cannot change permissions (404)', r.status === 404 && r.data.code === 'space_not_found', r.data)
  r = await putPerm(A, bobId, {})
  t('empty patch changes nothing', ok(r) && JSON.stringify(r.data.find((m) => m.user_id === bobId).permissions) === JSON.stringify(DEFAULTS))

  // ---- manage_persons ----
  r = await putPerm(A, bobId, { manage_persons: false })
  t('owner revokes manage_persons', ok(r) && r.data.find((m) => m.user_id === bobId).permissions.manage_persons === false, r.data)
  t('partial update keeps the other permissions', KEYS.filter((k) => k !== 'manage_persons').every((k) => r.data.find((m) => m.user_id === bobId).permissions[k] === DEFAULTS[k]))
  st = (await B.get('/api/state')).data
  t('state of the member reflects the change', st.permissions.manage_persons === false && st.permissions.manage_gifts === true)
  t('me.spaces reflects the change', (await B.get('/api/auth/me')).data.spaces.find((s) => s.id === team.id)?.permissions.manage_persons === false)
  r = await B.post('/api/persons', { name: 'Nope' }); t('manage_persons: create denied', denied(r, 'manage_persons'), r.data)
  r = await B.put(`/api/persons/${anna.id}`, { name: 'Annabelle' }); t('manage_persons: edit denied', denied(r, 'manage_persons'))
  r = await B.post(`/api/persons/${anna.id}/link`, { user_id: aliceId }); t('manage_persons: link denied', denied(r, 'manage_persons'))
  r = await B.post(`/api/persons/${anna.id}/unlink`); t('manage_persons: unlink denied', denied(r, 'manage_persons'))
  r = await B.del(`/api/persons/${anna.id}`); t('manage_persons: delete denied', denied(r, 'manage_persons'))
  r = await B.get('/api/state'); t('manage_persons: reading stays allowed', ok(r) && r.data.persons.some((p) => p.id === anna.id))
  r = await B.post('/api/items', { title: 'Still fine', person_id: anna.id }); t('manage_persons: other areas unaffected', ok(r))
  r = await A.put(`/api/persons/${anna.id}`, { name: 'Anna' }); t('owner unaffected', ok(r))
  await putPerm(A, bobId, { manage_persons: true })
  r = await B.put(`/api/persons/${anna.id}`, { relationship: 'Friend' }); t('manage_persons: allowed again', ok(r))

  // ---- manage_occasions (occasions + occasion types) ----
  await putPerm(A, bobId, { manage_occasions: false })
  r = await B.post('/api/occasions', { name: 'X', type: 'other', date: '2032-01-01' }); t('manage_occasions: create denied', denied(r, 'manage_occasions'))
  r = await B.put(`/api/occasions/${party.id}`, { name: 'Y' }); t('manage_occasions: edit denied', denied(r, 'manage_occasions'))
  r = await B.del(`/api/occasions/${party.id}`); t('manage_occasions: delete denied', denied(r, 'manage_occasions'))
  r = await B.post('/api/occasion-types', { name: 'Nope' }); t('manage_occasions: create occasion type denied', denied(r, 'manage_occasions'))
  const types = (await A.get('/api/state')).data.occasion_types
  const picnic = types.find((x) => x.name === 'Picnic')
  r = await B.put(`/api/occasion-types/${picnic.id}`, { name: 'Z' }); t('manage_occasions: edit occasion type denied', denied(r, 'manage_occasions'))
  r = await B.post(`/api/occasion-types/${picnic.id}/hide`); t('manage_occasions: hide occasion type denied', denied(r, 'manage_occasions'))
  r = await B.post(`/api/occasion-types/${types[0].id}/show`); t('manage_occasions: show occasion type denied', denied(r, 'manage_occasions'))
  r = await B.post('/api/occasion-types/reorder', { ids: [types[1].id] }); t('manage_occasions: reorder denied', denied(r, 'manage_occasions'))
  r = await B.del(`/api/occasion-types/${picnic.id}`); t('manage_occasions: delete occasion type denied', denied(r, 'manage_occasions'))
  r = await B.post(`/api/occasion-types/${picnic.id}/merge`, { into_id: types[0].id }); t('manage_occasions: merge occasion type denied', denied(r, 'manage_occasions'))
  r = await B.get('/api/occasion-types'); t('manage_occasions: listing types allowed', ok(r))
  r = await B.post('/api/gifts', { title: 'Gift w/o occasions perm', recipient_ids: [anna.id] }); t('manage_occasions: gifts unaffected', ok(r))
  r = await A.put(`/api/occasions/${party.id}`, { name: 'Party' }); t('owner may still edit occasions', ok(r))
  await putPerm(A, bobId, { manage_occasions: true })
  r = await B.put(`/api/occasions/${party.id}`, { name: 'Party 2' }); t('manage_occasions: allowed again', ok(r))
  r = await B.post('/api/occasion-types', { name: 'Allowed again' }); t('manage_occasions: occasion type allowed again', ok(r))

  // ---- manage_gifts (ideas, gifts, payments) ----
  await putPerm(A, bobId, { manage_gifts: false })
  r = await B.post('/api/items', { title: 'Nope' }); t('manage_gifts: create idea denied', denied(r, 'manage_gifts'))
  r = await B.put(`/api/items/${book.id}`, { title: 'Nope' }); t('manage_gifts: edit idea denied', denied(r, 'manage_gifts'))
  r = await B.post(`/api/items/${book.id}/assign`, { person_id: anna.id }); t('manage_gifts: assign idea denied', denied(r, 'manage_gifts'))
  r = await B.del(`/api/items/${book.id}`); t('manage_gifts: delete idea denied', denied(r, 'manage_gifts'))
  r = await B.post('/api/gifts', { title: 'Nope', recipient_ids: [anna.id] }); t('manage_gifts: create gift denied', denied(r, 'manage_gifts'))
  r = await B.put(`/api/gifts/${scarf.id}`, { title: 'Nope' }); t('manage_gifts: edit gift denied', denied(r, 'manage_gifts'))
  r = await B.post(`/api/gifts/${scarf.id}/status`, { status: 'ordered' }); t('manage_gifts: gift status denied', denied(r, 'manage_gifts'))
  r = await B.post(`/api/gifts/${scarf.id}/payment`, { payment_status: 'paid', payer_id: anna.id }); t('manage_gifts: payment denied', denied(r, 'manage_gifts'))
  r = await B.post(`/api/gifts/${scarf.id}/givers/${anna.id}/settle`, { settled: true }); t('manage_gifts: settle share denied', denied(r, 'manage_gifts'))
  r = await B.post('/api/settle', { from_id: anna.id, to_id: anna.id }); t('manage_gifts: settle denied', denied(r, 'manage_gifts'))
  r = await B.del(`/api/gifts/${scarf.id}`); t('manage_gifts: delete gift denied', denied(r, 'manage_gifts'))
  r = await B.get(`/api/gifts/${scarf.id}/events`); t('manage_gifts: gift history readable', ok(r))
  r = await B.get('/api/state'); t('manage_gifts: state readable', ok(r) && r.data.gifts.some((g) => g.id === scarf.id))
  r = await A.post('/api/gifts', { title: 'Owner gift', recipient_ids: [anna.id] }); t('owner unaffected by manage_gifts', ok(r))
  await putPerm(A, bobId, { manage_gifts: true })
  r = await B.post(`/api/gifts/${scarf.id}/status`, { status: 'ordered' }); t('manage_gifts: allowed again', ok(r))

  // ---- view_expenses ----
  r = await B.post(`/api/gifts/${scarf.id}/payment`, { payment_status: 'paid', payer_id: anna.id, paid_amount: 25 })
  t('with view_expenses: payments work', ok(r) && r.data.gifts.find((g) => g.id === scarf.id).payment_status === 'paid')
  r = await B.put(`/api/occasions/${party.id}`, { budget: 120 })
  r = await B.put(`/api/persons/${anna.id}`, { yearly_budget: 300 })
  await putPerm(A, bobId, { view_expenses: false })
  st = (await B.get('/api/state')).data
  const sg = st.gifts.find((g) => g.id === scarf.id)
  t('view_expenses off: no prices/payments/budgets in the state', sg.price === null && sg.paid_amount === null && sg.payer_id === null && sg.payment_status === 'unpaid' && sg.givers.every((x) => x.amount === null)
    && sg.payment_summary.open_amount === 0 && st.occasions.find((o) => o.id === party.id).budget === null && st.persons.find((p) => p.id === anna.id).yearly_budget === null, sg)
  t('view_expenses off: gifts themselves stay visible', sg.title === 'Scarf' && sg.status === 'ordered' && sg.recipient_ids.includes(anna.id))
  r = await B.get('/api/export'); t('view_expenses off: export denied', denied(r, 'view_expenses'), r.data)
  r = await B.post(`/api/gifts/${scarf.id}/payment`, { payment_status: 'unpaid' }); t('view_expenses off: payment endpoint denied', denied(r, 'view_expenses'))
  r = await B.post(`/api/gifts/${scarf.id}/givers/${anna.id}/settle`, { settled: true }); t('view_expenses off: settle share denied', denied(r, 'view_expenses'))
  r = await B.post('/api/settle', { from_id: anna.id, to_id: anna.id }); t('view_expenses off: settle denied', denied(r, 'view_expenses'))
  r = await B.put(`/api/gifts/${scarf.id}`, { title: 'Scarf (blue)', price: 1, payer_id: null, payment_status: 'unpaid', paid_amount: 1 })
  t('view_expenses off: gift edit is allowed but money fields are ignored', ok(r))
  {
    // Givers stay editable without view_expenses; their share amounts are neither sent nor changed
    await A.put(`/api/gifts/${scarf.id}`, { givers: [{ person_id: anna.id, amount: 10 }, { person_id: meB.id, amount: 15 }] })
    const gv = (await A.get('/api/state')).data.gifts.find((g) => g.id === scarf.id).givers
    t('owner sets two givers with amounts', gv.length === 2 && gv.find((x) => x.person_id === anna.id).amount === 10, gv)
    r = await B.put(`/api/gifts/${scarf.id}`, { givers: [{ person_id: anna.id, amount: 999 }] })
    const g1 = r.data.gifts.find((g) => g.id === scarf.id)
    t('view_expenses off: member can change the givers (who gives)', ok(r) && g1.givers.length === 1 && g1.givers[0].person_id === anna.id && g1.givers[0].amount === null, g1.givers)
    r = await B.put(`/api/gifts/${scarf.id}`, { givers: [{ person_id: anna.id }, { person_id: meB.id }] })
    const og1 = (await A.get('/api/state')).data.gifts.find((g) => g.id === scarf.id).givers
    t('view_expenses off: existing share amounts are preserved, new givers get none, sent amounts ignored', ok(r) && og1.find((x) => x.person_id === anna.id).amount === 10 && og1.find((x) => x.person_id === meB.id).amount === null, og1)
    r = await B.post('/api/gifts', { title: 'Shared gift', recipient_ids: [anna.id], givers: [{ person_id: meB.id, amount: 50 }] })
    const ng = r.data.gifts.find((g) => g.title === 'Shared gift')
    t('view_expenses off: new gift accepts givers without amounts', ok(r) && ng.givers.length === 1 && ng.givers[0].person_id === meB.id, ng)
    await A.put(`/api/gifts/${scarf.id}`, { givers: [] })
  }
  r = await B.put(`/api/occasions/${party.id}`, { budget: 1 })
  r = await B.put(`/api/persons/${anna.id}`, { yearly_budget: 1 })
  r = await B.post('/api/gifts', { title: 'Costly', price: 999, recipient_ids: [anna.id] })
  t('view_expenses off: new gift without money fields', ok(r))
  st = (await A.get('/api/state')).data
  const og = st.gifts.find((g) => g.id === scarf.id)
  t('owner still sees (unchanged) money after the member edited the gift', og.title === 'Scarf (blue)' && og.price === 25 && og.paid_amount === 25 && og.payment_status === 'paid' && og.payer_id === anna.id, og)
  t('owner sees unchanged budgets', st.occasions.find((o) => o.id === party.id).budget === 120 && st.persons.find((p) => p.id === anna.id).yearly_budget === 300)
  t('new gift of a restricted member has no price', st.gifts.find((g) => g.title === 'Costly').price === null)
  r = await A.get('/api/export'); t('owner can export', ok(r))
  await putPerm(A, bobId, { view_expenses: true })
  st = (await B.get('/api/state')).data
  t('view_expenses on again: money visible', st.gifts.find((g) => g.id === scarf.id).price === 25)

  // ---- manage_space_settings ----
  await putPerm(A, bobId, { manage_space_settings: false })
  r = await B.put('/api/settings', { currency: 'USD' }); t('manage_space_settings: currency denied', denied(r, 'manage_space_settings'))
  r = await B.put('/api/settings', { yearly_budget: 500 }); t('manage_space_settings: the personal yearly budget stays editable', ok(r) && r.data.settings.yearly_budget === 500)
  r = await B.post('/api/demo'); t('manage_space_settings: demo data denied', denied(r, 'manage_space_settings'))
  r = await A.put('/api/settings', { currency: 'USD' }); t('owner may change the currency', ok(r) && r.data.settings.currency === 'USD')
  await putPerm(A, bobId, { manage_space_settings: true })
  r = await B.put('/api/settings', { currency: 'EUR' }); t('manage_space_settings: allowed again', ok(r))

  // ---- invite_members ----
  r = await putPerm(A, bobId, { invite_members: true })
  r = await B.post(`/api/spaces/${team.id}/invites`)
  t('invite_members: granted -> member can invite', ok(r) && r.data.token, r.data)
  const bobInvite = r.data.token
  r = await C.post(`/api/invites/${bobInvite}/accept`)
  t('invite by a member is usable (Carol joins)', ok(r))
  const carolId = r.data.user.id
  await putPerm(A, bobId, { invite_members: false })
  r = await B.post(`/api/spaces/${team.id}/invites`); t('invite_members: revoked -> denied', denied(r, 'invite_members'))
  r = await B.post(`/api/spaces/${alicePersonal}/invites`)
  t('personal space: nobody can be invited (not a member there -> 404)', r.status === 404)

  // ---- share_wishlists ----
  r = await B.post('/api/wishlists', { title: 'Bob wishes' })
  const listId = (r.data.mine ?? [r.data]).find?.((l) => l.title === 'Bob wishes')?.id ?? r.data.id
  t('Bob creates a wishlist', ok(r) && listId, r.data)
  await putPerm(A, bobId, { share_wishlists: false })
  r = await B.post(`/api/wishlists/${listId}/spaces`, { space_id: team.id }); t('share_wishlists: share with the space denied', denied(r, 'share_wishlists'), r.data)
  r = await B.post(`/api/wishlists/${listId}/share`, { link_enabled: true }); t('share_wishlists: link sharing is not part of it', ok(r))
  await putPerm(A, bobId, { share_wishlists: true })
  r = await B.post(`/api/wishlists/${listId}/spaces`, { space_id: team.id }); t('share_wishlists: allowed again', ok(r))
  await putPerm(A, bobId, { share_wishlists: false })
  r = await B.del(`/api/wishlists/${listId}/spaces/${team.id}`); t('share_wishlists: revoked members can still withdraw their share', ok(r))
  await putPerm(A, bobId, { share_wishlists: true })

  // ---- Default permissions for new members ----
  r = await B.get(`/api/spaces/${team.id}/default-permissions`); t('defaults: member cannot read (owner only)', r.status === 403 && r.data.code === 'space_owner_permissions')
  r = await B.put(`/api/spaces/${team.id}/default-permissions`, { permissions: { manage_gifts: false } }); t('defaults: member cannot change', r.status === 403)
  r = await A.get(`/api/spaces/${team.id}/default-permissions`)
  t('defaults: owner reads the current defaults', ok(r) && JSON.stringify(r.data.permissions) === JSON.stringify(DEFAULTS), r.data)
  r = await A.put(`/api/spaces/${team.id}/default-permissions`, { permissions: { manage_gifts: false, view_expenses: false, invite_members: true } })
  t('defaults: owner changes the defaults', ok(r) && r.data.permissions.manage_gifts === false && r.data.permissions.view_expenses === false && r.data.permissions.invite_members === true && r.data.permissions.manage_persons === true, r.data)
  r = await A.put(`/api/spaces/${team.id}/default-permissions`, { permissions: { nope: true } }); t('defaults: invalid key rejected', r.status === 400 && r.data.code === 'permissions_invalid')
  r = await A.put(`/api/spaces/${alicePersonal}/default-permissions`, { permissions: { manage_gifts: false } }); t('defaults: personal space refused', r.status === 400 && r.data.code === 'personal_space_permissions')
  const D = new Client()
  r = await D.post('/api/auth/register', { name: 'Dave', email: 'dave@example.com', password: 'secret000', invite: await inv() })
  t('register Dave', ok(r), r)
  const x = await A.post(`/api/spaces/${team.id}/invites`)
  r = await D.post(`/api/invites/${x.data.token}/accept`)
  const daveTeam = r.data.spaces.find((s) => s.id === team.id)
  t('new member starts with the new defaults', daveTeam.permissions.manage_gifts === false && daveTeam.permissions.view_expenses === false && daveTeam.permissions.invite_members === true && daveTeam.permissions.manage_persons === true, daveTeam.permissions)
  r = await A.get(`/api/spaces/${team.id}/members`)
  t('existing members are not changed by new defaults', JSON.stringify(r.data.find((m) => m.user_id === carolId).permissions) === JSON.stringify(DEFAULTS) && r.data.find((m) => m.user_id === bobId).permissions.manage_gifts === true, r.data.map((m) => [m.name, m.permissions]))
  D.space = team.id
  r = await D.post('/api/items', { title: 'Dave idea' }); t('defaults apply: new member is denied manage_gifts', denied(r, 'manage_gifts'))
  r = await D.get('/api/state'); t('defaults apply: new member sees no expenses', ok(r) && r.data.gifts.every((g) => g.price === null))

  // ---- Owner leaves: successor becomes owner with every permission ----
  r = await A.del(`/api/spaces/${team.id}/members/${aliceId}`)
  t('owner leaves the space', ok(r))
  const succ = (await B.get('/api/auth/me')).data.spaces.find((s) => s.id === team.id)
  t('the member who becomes owner gets every permission', succ.role === 'owner' ? KEYS.every((k) => succ.permissions[k]) : true, succ)

  // ---- API v1 ----
  r = await B.post('/api/account/api-keys', { name: 'k', scopes: ['read', 'write'] })
  const KEY = r.data.secret
  const v1 = async (method, url, body) => {
    const x = await fetch(BASE + '/api/v1' + url, { method, headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: x.status, data: await x.json().catch(() => null) }
  }
  // Bob is the owner now; use Carol (a plain member with the default permissions) for the permission checks
  const C2 = new Client()
  await C2.post('/api/auth/login', { email: 'carol@example.com', password: 'secret789' })
  C2.space = team.id
  r = await C2.post('/api/account/api-keys', { name: 'ck', scopes: ['read', 'write'] })
  const CKEY = r.data.secret
  const cv1 = async (method, url, body) => {
    const x = await fetch(BASE + '/api/v1' + url, { method, headers: { Authorization: `Bearer ${CKEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: x.status, data: await x.json().catch(() => null) }
  }
  r = await cv1('POST', '/ideas', { title: 'API idea', space: team.id })
  t('API v1: member with manage_gifts may add ideas', r.status === 201, r.data)
  r = await cv1('POST', '/capture', { text: 'Captured idea', use_ai: false, space: team.id })
  t('API v1: capture works with manage_gifts', r.status === 201, r.data)
  r = await B.put(`/api/spaces/${team.id}/members/${carolId}/permissions`, { permissions: { manage_gifts: false, view_expenses: false } })
  t('new owner (Bob) manages permissions', ok(r) && r.data.find((m) => m.user_id === carolId).permissions.manage_gifts === false, r.data)
  r = await cv1('GET', '/me')
  {
    const sp = r.data?.spaces?.find((x) => x.id === team.id)
    t('API v1: /me returns spaces[].permissions (effective, same shape)', r.status === 200 && sp && sp.permissions.manage_gifts === false && sp.permissions.view_expenses === false && sp.permissions.manage_persons === true && KEYS.every((k) => typeof sp.permissions[k] === 'boolean'), r.data)
  }
  r = await cv1('POST', '/ideas', { title: 'Nope', space: team.id })
  t('API v1: POST /ideas denied without manage_gifts', r.status === 403 && r.data.code === 'permission_denied' && r.data.params?.permission === 'manage_gifts', r.data)
  r = await cv1('POST', '/capture', { text: 'Nope too', use_ai: false, space: team.id })
  t('API v1: POST /capture (ideas) denied without manage_gifts', r.status === 403 && r.data.code === 'permission_denied', r.data)
  r = await cv1('GET', `/gifts?space=${team.id}`)
  t('API v1: gifts readable, but no prices without view_expenses', r.status === 200 && r.data.length > 0 && r.data.every((g) => g.price === null), r.data)
  r = await cv1('GET', `/occasions?space=${team.id}`)
  t('API v1: occasion budgets hidden without view_expenses', r.status === 200 && r.data.every((o) => o.budget === null), r.data)
  r = await v1('GET', `/gifts?space=${team.id}`)
  t('API v1: the owner sees prices', r.status === 200 && r.data.some((g) => g.price === 25), r.data)
  r = await v1('POST', '/ideas', { title: 'Owner API idea', space: team.id })
  t('API v1: the owner may add ideas', r.status === 201)

  // ---- Audit ----
  {
    const d = rawDb()
    const rows = d.prepare("SELECT action, space_id, details FROM audit_log WHERE action IN ('space.member.permissions','space.default_permissions') ORDER BY id").all()
    d.close()
    const mem = rows.filter((x) => x.action === 'space.member.permissions')
    const def = rows.filter((x) => x.action === 'space.default_permissions')
    t('audit: member permission changes logged (with member id and changes)', mem.length >= 10 && mem.every((x) => x.space_id === team.id) && JSON.parse(mem[0].details).member_id === bobId && JSON.parse(mem[0].details).changes.manage_persons === false, mem[0])
    t('audit: default permission change logged', def.length === 1 && JSON.parse(def[0].details).changes.manage_gifts === false, def)
  }

  // ---- Persistence across a restart ----
  await stop(); await start()
  await C2.post('/api/auth/login', { email: 'carol@example.com', password: 'secret789' })
  C2.space = team.id
  st = (await C2.get('/api/state')).data
  t('permissions persist across a restart', st.permissions.manage_gifts === false && st.permissions.view_expenses === false && st.permissions.manage_persons === true, st.permissions)
}


try {
  await main()
} catch (e) {
  results.push('CRASH ' + e.stack); failN++
} finally {
  try { await stop() } catch {}
  console.log(results.join('\n'))
  console.log(`space-permissions: ${pass} passed, ${failN} failed`)
  await new Promise((r) => setTimeout(r, 500))
  fs.rmSync(DATA, { recursive: true, force: true })
  process.exit(failN ? 1 : 0)
}
