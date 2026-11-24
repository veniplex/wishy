import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA = path.join(os.tmpdir(), 'wy-auth-' + Date.now())
const PORT = Number(process.env.SMOKE_PORT) || 3976
const BASE = `http://127.0.0.1:${PORT}`
fs.mkdirSync(DATA, { recursive: true })

let server
function start(env = {}, nodeArgs = []) {
  return new Promise((resolve, reject) => {
    server = spawn('node', [...nodeArgs, 'server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), ...env } })
    let out = ''
    server.stdout.on('data', (d) => { out += d; if (out.includes('running')) resolve() })
    server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))
    server.on('exit', (c) => reject(new Error('server exit ' + c)))
  })
}
const stop = () => new Promise((r) => { server.removeAllListeners('exit'); server.on('exit', r); server.kill() })

let pass = 0, failc = 0
const t = (name, cond, info) => {
  if (cond) pass++
  else { failc++; console.log('FAIL:', name, info !== undefined ? JSON.stringify(info)?.slice(0, 400) : '') }
}

class Client {
  constructor(name) { this.name = name; this.cookies = {}; this.ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' }
  async raw(method, url, { body, headers = {}, rawBody, ct } = {}) {
    const h = { 'User-Agent': this.ua, ...headers }
    if (rawBody !== undefined) { if (ct) h['Content-Type'] = ct; if (!h['X-Requested-With']) h['X-Requested-With'] = 'x' }
    else if (body !== undefined) h['Content-Type'] = 'application/json'
    else if (method !== 'GET') h['X-Requested-With'] = 'x'
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    if (ck) h.Cookie = ck
    const res = await fetch(BASE + url, { method, headers: h, body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' })
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [kv] = sc.split(';'); const i = kv.indexOf('=')
      const k = kv.slice(0, i), v = kv.slice(i + 1)
      if (/Max-Age=0/i.test(sc) || v === '') delete this.cookies[k]; else this.cookies[k] = v
    }
    let data = null
    const text = await res.text()
    try { data = JSON.parse(text) } catch { data = text }
    return { status: res.status, data, headers: res.headers, setCookie: res.headers.getSetCookie?.() || [] }
  }
  get(u, o) { return this.raw('GET', u, o) }
  post(u, body, o = {}) { return this.raw('POST', u, { body, ...o }) }
  put(u, body, o = {}) { return this.raw('PUT', u, { body, ...o }) }
  del(u, body, o = {}) { return this.raw('DELETE', u, { body, ...o }) }
}

// ---- RFC 6238 helpers (independent of the server) ----
const hotp = (key, counter, digits = 6, alg = 'sha1') => {
  const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(counter))
  const h = createHmac(alg, key).update(m).digest(); const o = h[h.length - 1] & 15
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}
const totpAt = (key, ms, digits = 6) => hotp(key, Math.floor(ms / 30000), digits)
const b32dec = (s) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = []; for (const c of s.toUpperCase()) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8 } } return Buffer.from(out) }

// RFC 6238 Appendix B (SHA-1, 8 digits)
const rfcKey = Buffer.from('12345678901234567890')
for (const [time, exp] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
  t(`RFC6238 vector t=${time}`, totpAt(rfcKey, time * 1000, 8) === exp, totpAt(rfcKey, time * 1000, 8))
}

t('RFC4226 vector', ['755224', '287082', '359152'].every((e, i) => hotp(rfcKey, i) === e))

// Server implementation against the same vectors (separate data dir so nothing collides)
process.env.DATA_DIR = DATA + '-mod'
const tf = await import('file:///' + ROOT + '/server/twofactor.js')
for (const [time, exp] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [20000000000, '65353130']]) {
  t(`server hotp RFC6238 t=${time}`, tf.totpCode(rfcKey, time * 1000, 8) === exp, tf.totpCode(rfcKey, time * 1000, 8))
}
t('server base32 roundtrip', tf.base32Decode(tf.base32Encode(rfcKey)).equals(rfcKey))
{
  const now = 1_700_000_000_000
  const st = tf.totpStep(now)
  t('matchTotp current', tf.matchTotp(rfcKey, tf.totpCode(rfcKey, now), 0, now) === st)
  t('matchTotp -1 step', tf.matchTotp(rfcKey, tf.totpCode(rfcKey, now - 30000), 0, now) === st - 1)
  t('matchTotp +1 step', tf.matchTotp(rfcKey, tf.totpCode(rfcKey, now + 30000), 0, now) === st + 1)
  t('matchTotp -2 step rejected', tf.matchTotp(rfcKey, tf.totpCode(rfcKey, now - 60000), 0, now) === null)
  t('matchTotp replay rejected', tf.matchTotp(rfcKey, tf.totpCode(rfcKey, now), st, now) === null)
}

await start()
const PW = 'Passw0rd-long'
const mk = () => new Client('c')

// ---- Setup ----
const A = mk()
let r = await A.post('/api/auth/setup', { name: 'Admin', email: 'admin@example.com', password: PW })
t('setup ok', r.status === 200 && r.data.user.role === 'admin', r)
const me = r.data.user
t('me payload fields', 'avatar_url' in me && me.avatar_url === null && 'locale' in me && me.two_factor?.enabled === false && me.two_factor.passkeys === 0 && me.two_factor.recovery_left === 0 && me.features && me.must_setup_2fa === false && Array.isArray(me.identities) && me.identities[0].provider === 'google', me)
r = await A.get('/api/auth/me')
t('auth/me same shape', r.data.user.two_factor && r.data.user.identities, r.data)

// ---- Health ----
r = await mk().get('/healthz')
t('healthz', r.status === 200 && r.data.status === 'ok' && typeof r.data.version === 'string', r)
r = await mk().get('/readyz')
t('readyz', r.status === 200 && r.data.status === 'ready', r)

// ---- Providers ----
r = await mk().get('/api/auth/providers')
t('providers shape', r.data.app_name === 'Wishy' && r.data.registration.enabled === true && r.data.registration.mode === 'invite' && r.data.google === false && r.data.default_locale === 'en' && r.data.locales.join() === 'de,en', r.data)

const raw = new DatabaseSync(path.join(DATA, 'wishlist.db')); raw.exec('PRAGMA busy_timeout=5000')

// ---- Registration settings ----
r = await A.put('/api/admin/settings/auth', { registration_enabled: false })
t('registration disabled via settings', r.status === 200 && r.data.registration_enabled === false, r.data)
r = await mk().post('/api/auth/register', { name: 'X', email: 'x@example.com', password: PW })
t('registration disabled -> 403 code', r.status === 403 && r.data.code === 'registration_disabled', r)
r = await A.put('/api/admin/settings/auth', { registration_enabled: true, registration_mode: 'invite' })
t('auth PUT invite', r.status === 200 && r.data.registration_enabled && r.data.registration_mode === 'invite', r.data)
r = await mk().post('/api/auth/register', { name: 'X', email: 'x@example.com', password: PW })
t('invite mode w/o token -> 403', r.status === 403 && r.data.code === 'registration_invite_only', r)
r = await A.post('/api/admin/invites', {})
const inv = r.data.url.split('invite=')[1]
const B = mk()
r = await B.post('/api/auth/register', { name: 'Bea', email: 'bea@example.com', password: PW, invite: inv })
t('invite mode with token ok', r.status === 200, r)
await A.put('/api/admin/settings/auth', { registration_mode: 'open' })
r = await mk().get('/api/auth/providers')
t('providers open', r.data.registration.mode === 'open' && r.data.registration.enabled, r.data)
const C = mk()
r = await C.post('/api/auth/register', { name: 'Cy', email: 'cy@example.com', password: PW })
t('open registration ok', r.status === 200, r)
r = await A.put('/api/admin/settings/auth', { registration_mode: 'bogus' })
t('invalid mode -> 400 code', r.status === 400 && r.data.code === 'registration_invalid', r)

// ---- Google switch ----
r = await A.put('/api/admin/settings/auth', { google_client_id: 'cid.apps.googleusercontent.com', google_client_secret: 'sec', google_enabled: true })
t('google creds set', r.data.google_enabled === true && r.data.google_client_secret_set === true && !JSON.stringify(r.data).includes('"sec"') && r.data.redirect_uri.endsWith('/api/auth/google/callback'), r.data)
r = await mk().get('/api/auth/providers')
t('providers google true', r.data.google === true)
r = await mk().get('/api/auth/google/start')
t('google start 302 when on', r.status === 302 && r.headers.get('location').startsWith('https://accounts.google.com/'), r.status)
r = await A.put('/api/admin/settings/auth', { google_enabled: false })
t('google off', r.data.google_enabled === false && r.data.google_credentials_set === true, r.data)
r = await mk().get('/api/auth/providers')
t('providers google false when off', r.data.google === false)
r = await mk().get('/api/auth/google/start')
t('google start 404 when off', r.status === 404 && r.data.code === 'google_disabled', r)
r = await mk().get('/api/auth/google/callback?code=x&state=y')
t('google callback 404 when off', r.status === 404 && r.data.code === 'google_disabled', r)
await A.put('/api/admin/settings/auth', { google_enabled: true })
r = await A.get('/api/admin/settings/auth')
t('settings/auth GET shape', ['registration_enabled', 'registration_mode', 'google_enabled', 'google_client_id', 'google_client_secret_set', 'redirect_uri', 'two_factor_policy', 'env_locked'].every((k) => k in r.data), r.data)
r = await C.get('/api/admin/settings/auth')
t('non-admin settings/auth 403', r.status === 403 && r.data.code === 'admin_only', r)

// ---- Linking Google: fresh confirmation ----
r = await B.get('/api/auth/google/start?link=1')
t('link start fresh session -> google', r.status === 302 && r.headers.get('location').startsWith('https://accounts.google.com/'), r.headers.get('location'))
raw.prepare('UPDATE sessions SET reauth_at=? WHERE user_id=2').run(Date.now() - 3600_000)
r = await B.get('/api/auth/google/start?link=1')
t('link start stale -> reauth_required', r.status === 302 && r.headers.get('location').includes('error=reauth_required'), r.headers.get('location'))
r = await B.post('/api/account/reauth', { current_password: 'wrong' })
t('reauth wrong password', r.status === 400 && r.data.code === 'password_invalid', r)
r = await B.post('/api/account/reauth', { current_password: PW })
t('reauth ok', r.status === 200)
r = await B.get('/api/auth/google/start?link=1')
t('link start after reauth', r.status === 302 && r.headers.get('location').startsWith('https://accounts.google.com/'))
r = await mk().get('/api/auth/google/start?link=1')
t('link start anonymous -> /login', r.status === 302 && r.headers.get('location') === '/login')
r = await B.del('/api/account/identities/google')
t('unlink without link fine', r.status === 200)

// ---- Changing email ----
r = await B.put('/api/account', { email: 'bea2@example.com' })
t('email change w/o password', r.status === 400 && r.data.code === 'password_invalid', r)
r = await B.put('/api/account', { email: 'bea2@example.com', current_password: 'wrong' })
t('email change wrong password', r.status === 400 && r.data.code === 'password_invalid', r)
r = await B.put('/api/account', { name: 'Beatrix' })
t('name change needs no password', r.status === 200 && r.data.user.name === 'Beatrix', r)
r = await B.put('/api/account', { email: 'cy@example.com', current_password: PW })
t('email taken -> 409', r.status === 409 && r.data.code === 'email_taken', r)
r = await B.put('/api/account', { email: 'bea2@example.com', current_password: PW })
t('email change right password', r.status === 200 && r.data.user.email === 'bea2@example.com', r)
r = await B.put('/api/account', { email: 'bea2@example.com' })
t('same email no password needed', r.status === 200)
// Account without a password
raw.prepare("INSERT INTO users (email,name,password_hash,google_sub,role) VALUES ('g@example.com','Goo',NULL,'sub-goo','user')").run()
const gid = raw.prepare("SELECT id FROM users WHERE email='g@example.com'").get().id
raw.prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('sess-goo-test', gid, Date.now(), Date.now() + 1e9)
const G = mk(); G.cookies.wl_session = 'sess-goo-test'
r = await G.put('/api/account', { email: 'g2@example.com', current_password: 'x' })
t('passwordless email change -> password_required', r.status === 400 && r.data.code === 'password_required', r)
r = await G.del('/api/account/google')
t('passwordless unlink -> password_required', r.status === 400 && r.data.code === 'password_required', r)

// ---- Language ----
r = await B.put('/api/account', { locale: 'en' })
t('locale en', r.status === 200 && r.data.user.locale === 'en', r)
r = await B.put('/api/account', { locale: 'fr' })
t('locale invalid', r.status === 400 && r.data.code === 'locale_invalid', r)
r = await A.put('/api/admin/settings/general', { default_locale: 'de' })
t('default_locale de', r.data.default_locale === 'de')
r = await mk().get('/api/auth/providers')
t('providers default_locale de', r.data.default_locale === 'de')
await A.put('/api/admin/settings/general', { default_locale: 'en' })

// ---- Avatare ----
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
r = await B.get('/api/avatars/2')
t('avatar none -> 404', r.status === 404 && r.data.code === 'avatar_not_found', r)
r = await mk().get('/api/avatars/2')
t('avatar needs login', r.status === 401)
r = await B.post('/api/account/avatar', { data: 'data:image/png;base64,' + PNG.toString('base64') })
t('avatar upload json', r.status === 200 && /^\/api\/avatars\/2\?v=/.test(r.data.avatar_url), r)
let av = await B.get('/api/avatars/2')
t('avatar served', av.status === 200 && av.headers.get('content-type') === 'image/png' && !!av.headers.get('etag'), [av.status, av.headers.get('content-type'), av.headers.get('etag')])
const etag = av.headers.get('etag')
const nm = await new Promise((res) => http.get(BASE + '/api/avatars/2', { headers: { Cookie: `wl_session=${B.cookies.wl_session}`, 'If-None-Match': etag } }, (rs) => { rs.resume(); res({ status: rs.statusCode, headers: rs.headers }) }))
t('avatar 304 with etag', nm.status === 304, [nm.status, etag])
r = await B.get('/api/auth/me')
t('me has avatar_url', /avatars\/2/.test(r.data.user.avatar_url))
r = await B.post('/api/account/avatar', { data: Buffer.from('not an image at all, just text').toString('base64') })
t('avatar wrong type', r.status === 400 && r.data.code === 'avatar_type', r)
r = await B.post('/api/account/avatar', { data: Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]).toString('base64') })
t('avatar too large (json)', r.status === 413 && r.data.code === 'avatar_too_large', r)
// multipart
const bnd = '----wy' + randomBytes(6).toString('hex')
const mp = (buf, name = 'a.png', ctype = 'image/png') => Buffer.concat([Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="avatar"; filename="${name}"\r\nContent-Type: ${ctype}\r\n\r\n`), buf, Buffer.from(`\r\n--${bnd}--\r\n`)])
r = await B.raw('POST', '/api/account/avatar', { rawBody: mp(PNG), ct: `multipart/form-data; boundary=${bnd}` })
t('avatar upload multipart', r.status === 200 && r.data.avatar_url, r)
r = await B.raw('POST', '/api/account/avatar', { rawBody: mp(Buffer.concat([PNG, Buffer.alloc(2.5 * 1024 * 1024)])), ct: `multipart/form-data; boundary=${bnd}` })
t('avatar too large (multipart)', r.status === 413, r)
r = await B.raw('POST', '/api/account/avatar', { rawBody: mp(Buffer.from('GIF89a......................')), ct: `multipart/form-data; boundary=${bnd}` })
t('avatar gif rejected', r.status === 400 && r.data.code === 'avatar_type', r)
const files = fs.readdirSync(path.join(DATA, 'avatars'))
t('only one avatar file kept', files.length === 1, files)
r = await B.del('/api/account/avatar')
t('avatar delete', r.status === 200 && r.data.avatar_url === null, r)
t('avatar file removed', fs.readdirSync(path.join(DATA, 'avatars')).length === 0)
r = await B.get('/api/avatars/2')
t('avatar 404 after delete', r.status === 404)
// IdP picture as fallback
fs.writeFileSync(path.join(DATA, 'avatars', 'a'.repeat(32) + '.png'), PNG)
raw.prepare("UPDATE users SET idp_avatar_file=? WHERE id=2").run('a'.repeat(32) + '.png')
r = await B.get('/api/avatars/2')
t('idp avatar fallback served', r.status === 200)
r = await B.get('/api/auth/me')
t('me identities picture_available', r.data.user.identities[0].picture_available === true && !!r.data.user.avatar_url, r.data.user)
raw.prepare("UPDATE users SET idp_avatar_file=NULL WHERE id=2").run()

// ---- Sessions ----
const B2 = mk(); B2.ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1'
r = await B2.post('/api/auth/login', { email: 'bea2@example.com', password: PW })
t('second login', r.status === 200)
r = await B.get('/api/account/sessions')
t('sessions list', r.status === 200 && r.data.length === 2 && r.data.filter((s) => s.current).length === 1 && r.data.every((s) => s.id.length === 16 && s.ip && s.device), r.data)
t('sessions show device', r.data.some((s) => /Chrome on Windows/.test(s.device)) && r.data.some((s) => /Safari on iOS/.test(s.device)), r.data.map((s) => s.device))
const other = r.data.find((s) => !s.current)
r = await B.del('/api/account/sessions/' + r.data.find((s) => s.current).id)
t('cannot revoke current via list', r.status === 400 && r.data.code === 'session_current', r)
r = await B.del('/api/account/sessions/' + other.id)
t('revoke other', r.status === 200)
r = await B2.get('/api/auth/me')
t('revoked session logged out', r.status === 401)
r = await B.del('/api/account/sessions/doesnotexist')
t('revoke unknown -> 404', r.status === 404 && r.data.code === 'session_not_found')
// Password change ends other sessions
await B2.post('/api/auth/login', { email: 'bea2@example.com', password: PW })
r = await B.put('/api/account', { new_password: 'N3w-Password-xx' })
t('password change w/o current -> error', r.status === 400 && r.data.code === 'password_invalid', r)
r = await B.put('/api/account', { new_password: 'N3w-Password-xx', current_password: PW })
t('password change ok', r.status === 200)
r = await B2.get('/api/auth/me')
t('password change revokes others', r.status === 401)
r = await B.get('/api/auth/me')
t('own session survives', r.status === 200)
const PW_B = 'N3w-Password-xx'
const B3 = mk()
await B3.post('/api/auth/login', { email: 'bea2@example.com', password: PW_B })
r = await B.post('/api/account/sessions/revoke-others', {})
t('revoke-others', r.status === 200 && r.data.revoked === 1, r.data)
r = await B3.get('/api/auth/me')
t('revoke-others effect', r.status === 401)

// ---- Login error codes ----
r = await mk().post('/api/auth/login', { email: 'bea2@example.com', password: 'nope' })
t('login wrong -> invalid_credentials', r.status === 401 && r.data.code === 'invalid_credentials', r)

// ---- TOTP ----
const D = mk()
await A.post('/api/admin/users', { name: 'Dora', email: 'dora@example.com', password: PW })
const doraId = raw.prepare("SELECT id FROM users WHERE email='dora@example.com'").get().id
r = await D.post('/api/auth/login', { email: 'dora@example.com', password: PW })
t('dora login', r.status === 200)
r = await D.get('/api/account/2fa')
t('2fa status initial', r.data.enabled === false && r.data.totp === false && r.data.recovery_left === 0 && r.data.policy === 'optional', r.data)
r = await D.post('/api/account/2fa/totp/confirm', { code: '123456' })
t('confirm before setup', r.status === 400 && r.data.code === 'totp_not_started', r)
r = await D.post('/api/account/2fa/totp/setup', {})
t('totp setup', r.status === 200 && /^[A-Z2-7]{32}$/.test(r.data.secret) && r.data.otpauth_uri.startsWith('otpauth://totp/Wishy:dora%40example.com?secret=') && r.data.qr_data_url.startsWith('data:image/png;base64,'), r.data && { ...r.data, qr_data_url: '…' })
const secretKey = b32dec(r.data.secret)
const dbSecret = raw.prepare('SELECT secret_enc FROM user_totp WHERE user_id=?').get(doraId).secret_enc
t('secret stored encrypted', !dbSecret.includes(r.data.secret) && dbSecret.length > 40, dbSecret)
r = await D.post('/api/account/2fa/totp/confirm', { code: '000000' })
t('confirm wrong code', r.status === 400 && r.data.code === 'code_invalid', r)
const nowMs = Date.now()
r = await D.post('/api/account/2fa/totp/confirm', { code: totpAt(secretKey, nowMs) })
t('confirm right code + recovery codes', r.status === 200 && r.data.enabled && r.data.totp && r.data.recovery_codes?.length === 10 && r.data.recovery_left === 10 && /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(r.data.recovery_codes[0]), r.data)
const recovery = r.data.recovery_codes
t('recovery hashed at rest', !JSON.stringify(raw.prepare('SELECT code_hash FROM user_recovery_codes').all()).includes(recovery[0].replace('-', '')))
r = await D.post('/api/account/2fa/totp/setup', {})
t('setup again -> already enabled', r.status === 409 && r.data.code === 'totp_already_enabled', r)
r = await D.get('/api/auth/me')
t('me two_factor', r.data.user.two_factor.enabled && r.data.user.two_factor.totp && r.data.user.two_factor.recovery_left === 10, r.data.user.two_factor)

// Two-step login
const D2 = mk()
r = await D2.post('/api/auth/login', { email: 'dora@example.com', password: PW })
t('login -> two_factor ticket, no session', r.status === 200 && r.data.two_factor?.ticket && r.data.two_factor.methods.join() === 'totp,recovery' && !D2.cookies.wl_session, r)
let ticket = r.data.two_factor.ticket
r = await D2.get('/api/auth/me')
t('no session before 2fa', r.status === 401)
r = await D2.post('/api/auth/2fa/verify', { ticket, method: 'totp', code: '000000' })
t('verify wrong code', r.status === 401 && r.data.code === 'two_factor_invalid', r)
r = await D2.post('/api/auth/2fa/verify', { ticket, method: 'totp', code: totpAt(secretKey, nowMs) })
t('replay of the confirm-step code rejected', r.status === 401 && r.data.code === 'two_factor_invalid', r)
const nextCode = totpAt(secretKey, nowMs + 30000)
r = await D2.post('/api/auth/2fa/verify', { ticket, method: 'totp', code: nextCode })
t('verify next-step code ok -> session', r.status === 200 && r.data.user.email === 'dora@example.com' && !!D2.cookies.wl_session, r)
r = await D2.post('/api/auth/2fa/verify', { ticket, method: 'totp', code: nextCode })
t('ticket single-use', r.status === 400 && r.data.code === 'ticket_invalid', r)
// Replay with a new ticket
const D3 = mk()
r = await D3.post('/api/auth/login', { email: 'dora@example.com', password: PW })
r = await D3.post('/api/auth/2fa/verify', { ticket: r.data.two_factor.ticket, method: 'totp', code: nextCode })
t('replay of used code with new ticket rejected', r.status === 401, r)
// Tampered ticket
r = await D3.post('/api/auth/2fa/verify', { ticket: 'abc.def', method: 'totp', code: '123456' })
t('bad ticket', r.status === 400 && r.data.code === 'ticket_invalid')
// Ticket limit 5
const D4 = mk()
r = await D4.post('/api/auth/login', { email: 'dora@example.com', password: PW })
ticket = r.data.two_factor.ticket
let last
for (let i = 0; i < 5; i++) last = await D4.post('/api/auth/2fa/verify', { ticket, method: 'totp', code: '111111' })
t('5 wrong -> still 401', last.status === 401)
last = await D4.post('/api/auth/2fa/verify', { ticket, method: 'totp', code: nextCode })
t('6th attempt on ticket -> locked', last.status === 429 && last.data.code === 'ticket_locked', last)
// Recovery code: single-use
const D5 = mk()
r = await D5.post('/api/auth/login', { email: 'dora@example.com', password: PW })
r = await D5.post('/api/auth/2fa/verify', { ticket: r.data.two_factor.ticket, method: 'recovery', code: recovery[0] })
t('recovery code login', r.status === 200 && r.data.recovery_left === 9, r)
const D6 = mk()
r = await D6.post('/api/auth/login', { email: 'dora@example.com', password: PW })
r = await D6.post('/api/auth/2fa/verify', { ticket: r.data.two_factor.ticket, method: 'recovery', code: recovery[0] })
t('recovery code single-use', r.status === 401 && r.data.code === 'two_factor_invalid', r)
r = await D6.post('/api/auth/login', { email: 'dora@example.com', password: PW })
r = await D6.post('/api/auth/2fa/verify', { ticket: r.data.two_factor.ticket, method: 'recovery', code: recovery[1].toUpperCase().replace('-', ' ') })
t('recovery code normalised (case/sep)', r.status === 200, r)
// Per-user lockout after many failed attempts
await A.post('/api/admin/users', { name: 'Fay', email: 'fay@example.com', password: PW })
const F = mk(); await F.post('/api/auth/login', { email: 'fay@example.com', password: PW })
r = await F.post('/api/account/2fa/totp/setup', {})
await F.post('/api/account/2fa/totp/confirm', { code: totpAt(b32dec(r.data.secret), Date.now()) })
let locked = null
for (let i = 0; i < 14 && locked === null; i++) {
  const X = mk()
  const l = await X.post('/api/auth/login', { email: 'fay@example.com', password: PW })
  const v = await X.post('/api/auth/2fa/verify', { ticket: l.data.two_factor?.ticket, method: 'totp', code: '222222' })
  if (v.status === 429 && v.data.code === 'two_factor_locked') locked = i
}
t('per-user lockout after repeated 2FA failures', locked !== null && locked <= 11, locked)
// Regenerate / disable require password/code (Dora is locked now -> use the password)
raw.prepare('UPDATE sessions SET reauth_at=1 WHERE user_id=?').run(doraId) // confirmation window expired
r = await D.post('/api/account/2fa/recovery/regenerate', {})
t('regenerate needs confirmation', r.status === 403 && r.data.code === 'reauth_required', r)
r = await D.post('/api/account/2fa/recovery/regenerate', { current_password: 'wrong' })
t('regenerate wrong password', r.status === 400 && r.data.code === 'password_invalid', r)
r = await D.post('/api/account/2fa/recovery/regenerate', { current_password: PW })
t('regenerate ok', r.status === 200 && r.data.recovery_codes.length === 10 && r.data.recovery_left === 10, r.data)
const newRec = r.data.recovery_codes
const old = recovery[2]
t('old recovery codes invalid after regenerate', raw.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id=?').get(doraId).n === 10 && !newRec.includes(old))
raw.prepare('UPDATE sessions SET reauth_at=1 WHERE user_id=?').run(doraId)
r = await D.post('/api/account/2fa/totp/disable', {})
t('disable needs confirmation', r.status === 403 && r.data.code === 'reauth_required', r)
await D.post('/api/account/reauth', { current_password: PW })

// ---- WebAuthn (options; the full ceremony is not possible headless) ----
r = await D.post('/api/account/2fa/webauthn/register-options', {})
const o = r.data
t('webauthn register-options well-formed', r.status === 200 && typeof o.challenge === 'string' && o.challenge.length >= 16 && o.rp?.id === '127.0.0.1' && o.rp?.name === 'Wishy' && o.user?.name === 'dora@example.com' && typeof o.user.id === 'string' && Array.isArray(o.pubKeyCredParams) && o.pubKeyCredParams.length >= 2 && o.authenticatorSelection?.userVerification === 'required' && o.authenticatorSelection?.residentKey === 'required' && Array.isArray(o.excludeCredentials) && o.attestation === 'none', o)
r = await D.post('/api/account/2fa/webauthn/register', { name: 'Key', response: { id: 'x', rawId: 'x', type: 'public-key', response: {}, clientExtensionResults: {} } })
t('webauthn register with garbage -> 400 code', r.status === 400 && ['webauthn_failed', 'webauthn_challenge_expired'].includes(r.data.code), r)
// Fake credential so that sign-in options are generated
raw.prepare(`INSERT INTO user_webauthn (id,user_id,name,public_key,counter,transports) VALUES ('AAECAwQFBgc',${doraId},'Fake',?,0,'["usb"]')`).run(Buffer.from('fakekey'))
const W = mk()
r = await W.post('/api/auth/login', { email: 'dora@example.com', password: PW })
t('methods include webauthn', r.data.two_factor?.methods.join() === 'totp,webauthn,recovery', r.data)
const wt = r.data.two_factor?.ticket
r = await W.post('/api/auth/2fa/webauthn-options', { ticket: wt })
t('webauthn auth-options well-formed', r.status === 200 && r.data.rpId === '127.0.0.1' && typeof r.data.challenge === 'string' && r.data.allowCredentials?.length === 1 && r.data.allowCredentials[0].id === 'AAECAwQFBgc' && r.data.userVerification === 'preferred', r)
r = await W.post('/api/auth/2fa/verify', { ticket: wt, method: 'webauthn', assertion: { id: 'AAECAwQFBgc', rawId: 'AAECAwQFBgc', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' }, clientExtensionResults: {} } })
t('webauthn bogus assertion rejected', r.status === 401 && r.data.code === 'two_factor_invalid', r)
r = await D.put('/api/account/2fa/webauthn/AAECAwQFBgc', { name: 'My key' })
t('passkey rename', r.status === 200 && r.data.passkey_list[0].name === 'My key' && r.data.passkeys === 1, r.data)
raw.prepare('UPDATE sessions SET reauth_at=1 WHERE user_id=?').run(doraId)
r = await D.del('/api/account/2fa/webauthn/AAECAwQFBgc', {})
t('passkey delete needs confirmation', r.status === 403 && r.data.code === 'reauth_required', r)
r = await D.del('/api/account/2fa/webauthn/AAECAwQFBgc', { current_password: PW })
t('passkey delete with password', r.status === 200 && r.data.passkeys === 0, r.data)

// ---- Policy 'required' + admin reset ----
const E = mk()
await A.post('/api/admin/users', { name: 'Eli', email: 'eli@example.com', password: PW })
const eliId = raw.prepare("SELECT id FROM users WHERE email='eli@example.com'").get().id
await E.post('/api/auth/login', { email: 'eli@example.com', password: PW })
r = await A.put('/api/admin/settings/auth', { two_factor_policy: 'required' })
t('policy required', r.data.two_factor_policy === 'required')
r = await E.get('/api/auth/me')
t('must_setup_2fa true', r.status === 200 && r.data.user.must_setup_2fa === true, r.data.user)
r = await E.get('/api/spaces')
t('app blocked until setup', r.status === 403 && r.data.code === 'two_factor_setup_required', r)
r = await E.get('/api/account/2fa')
t('2fa endpoints allowed during setup', r.status === 200 && r.data.must_setup === true)
r = await A.get('/api/admin/settings/auth')
t('admin w/o 2fa can still reach settings to revert', r.status === 200)
r = await A.get('/api/admin/users')
t('admin blocked from other admin pages until 2fa', r.status === 403 && r.data.code === 'two_factor_setup_required', r)
r = await A.post('/api/account/2fa/totp/setup', {})
await A.post('/api/account/2fa/totp/confirm', { code: totpAt(b32dec(r.data.secret), Date.now()) })
r = await E.post('/api/account/2fa/totp/setup', {})
const ek = b32dec(r.data.secret)
r = await E.post('/api/account/2fa/totp/confirm', { code: totpAt(ek, Date.now()) })
t('eli enables totp', r.status === 200 && r.data.must_setup === false, r.data)
r = await E.get('/api/spaces')
t('gate lifted after setup', r.status !== 403)
// Admin-Reset
r = await A.post(`/api/admin/users/${eliId}/reset-2fa`, {})
t('admin reset-2fa', r.status === 200 && r.data.two_factor === false, r.data)
r = await E.get('/api/auth/me')
t('reset-2fa revokes sessions', r.status === 401)
t('reset-2fa cleans tables', raw.prepare('SELECT COUNT(*) AS n FROM user_totp WHERE user_id=?').get(eliId).n === 0 && raw.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id=?').get(eliId).n === 0)
r = await C.post(`/api/admin/users/${eliId}/reset-2fa`, {})
t('reset-2fa non-admin 403', r.status === 403)
r = await A.post('/api/admin/users/999/reset-2fa', {})
t('reset-2fa unknown 404 code', r.status === 404 && r.data.code === 'user_not_found')
r = await A.get('/api/admin/users')
t('admin users list has two_factor/avatar_url', r.data.every((u) => 'two_factor' in u && 'avatar_url' in u), r.data[0])
await A.put('/api/admin/settings/auth', { two_factor_policy: 'optional' })
r = await A.post('/api/admin/users/1/reset-2fa', {})
t('admin resets own 2fa', r.status === 200 && r.data.two_factor === false)

// ---- Trust proxy / origin / diagnostics ----
const P = mk()
const XF = { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'wishy.example.org' }
r = await P.post('/api/auth/login', { email: 'cy@example.com', password: PW }, { headers: XF })
t('trust off: cookie not Secure', r.status === 200 && r.setCookie.length && r.setCookie.every((c) => !/Secure/i.test(c)), r.setCookie)
r = await P.get('/api/account/sessions')
t('trust off: ip is socket ip', /127\.0\.0\.1|::1/.test(r.data[0].ip), r.data[0].ip)
r = await A.get('/api/admin/diagnostics/proxy', { headers: XF })
const dg = r.data
t('diagnostics shape', r.status === 200 && dg.protocol === 'http' && dg.proxy_trusted === false && dg.trust_proxy.enabled === false && dg.forwarded_headers['x-forwarded-for'] === '203.0.113.9' && dg.base_url.effective && Array.isArray(dg.warnings) && Array.isArray(dg.bypass_paths) && dg.webauthn.rp_id, dg)
t('diagnostics warns about untrusted X-Forwarded-Proto', dg.warnings.some((w) => w.code === 'forwarded_proto_untrusted'), dg.warnings)
r = await C.get('/api/admin/diagnostics/proxy')
t('diagnostics admin only', r.status === 403)
r = await A.put('/api/admin/settings/general', { trust_proxy: 'foo' })
t('trust_proxy invalid -> 400', r.status === 400 && r.data.code === 'trust_proxy_invalid', r)
r = await A.put('/api/admin/settings/general', { trust_proxy: '1' })
t('trust_proxy=1 set', r.status === 200 && r.data.trust_proxy === '1', r.data)
const P2 = mk()
r = await P2.post('/api/auth/login', { email: 'cy@example.com', password: PW }, { headers: XF })
t('trust on: cookie Secure', r.status === 200 && r.setCookie.some((c) => /wl_session=.*Secure/i.test(c)), r.setCookie)
r = await P2.get('/api/account/sessions', { headers: XF })
t('trust on: ip from X-Forwarded-For', r.data.some((s) => s.ip === '203.0.113.9' && s.current), r.data.map((s) => s.ip))
r = await A.get('/api/admin/diagnostics/proxy', { headers: XF })
t('diagnostics trusted', r.data.proxy_trusted === true && r.data.protocol === 'https' && r.data.client_ip === '203.0.113.9' && r.data.host === 'wishy.example.org' && r.data.cookie.secure === true && r.data.trust_proxy.source === 'setting', r.data)
r = await A.put('/api/admin/settings/general', { trust_proxy: 'loopback, linklocal, uniquelocal' })
t('trust_proxy named list ok', r.status === 200 && r.data.trust_proxy === 'loopback, linklocal, uniquelocal', r.data)
r = await mk().get('/healthz', { headers: XF })
t('healthz reachable via proxy headers', r.status === 200)
r = await A.put('/api/admin/settings/general', { trust_proxy: 'off' })
t('trust_proxy off', r.data.trust_proxy === '', r.data)

// Origin check
r = await B.post('/api/auth/logout', {}, { headers: { Origin: 'http://evil.example' } })
t('origin mismatch -> 403', r.status === 403 && r.data.code === 'origin_mismatch', r)
r = await B.post('/api/account/sessions/revoke-others', {}, { headers: { Origin: BASE } })
t('origin same host ok', r.status === 200, r)
r = await B.post('/api/account/sessions/revoke-others', {}, { headers: { Referer: 'http://evil.example/x' } })
t('referer mismatch -> 403 (no Origin)', r.status === 403, r)
r = await A.put('/api/admin/settings/general', { base_url: 'https://wishy.example.com/' })
t('base_url set (trailing slash trimmed)', r.data.base_url === 'https://wishy.example.com' && r.data.effective_base_url === 'https://wishy.example.com', r.data)
r = await B.post('/api/account/sessions/revoke-others', {}, { headers: { Origin: 'https://wishy.example.com' } })
t('origin = base_url ok', r.status === 200, r)
r = await B.post('/api/account/sessions/revoke-others', {}, { headers: { Origin: 'https://wishy.example.com.evil.io' } })
t('origin lookalike rejected', r.status === 403)
r = await mk().raw('POST', '/api/v1/capture', { rawBody: 'hello', ct: 'text/plain', headers: { Authorization: 'Bearer wishy_abcdefgh_xxxxxxxx', Origin: 'http://evil.example' } })
t('API-key request skips csrf/origin (404/401 from later layer, not 403 csrf)', r.status !== 403 || (r.data?.code !== 'csrf' && r.data?.code !== 'origin_mismatch'), r)
{ const cr = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'a=b' }); const cd = await cr.json(); t('csrf text/plain without header still blocked', cr.status === 403 && cd.code === 'csrf', cd) }
r = await A.get('/api/admin/diagnostics/proxy')
t('diagnostics warns about base_url host mismatch', r.data.warnings.some((w) => w.code === 'base_url_host_mismatch'), r.data.warnings)
await A.put('/api/admin/settings/general', { base_url: '' })

// General
r = await A.put('/api/admin/settings/general', { app_name: 'My wishes', retention_audit_days: 90 })
t('general put', r.data.app_name === 'My wishes' && r.data.retention_audit_days === 90, r.data)
r = await A.put('/api/admin/settings/general', { retention_audit_days: -1 })
t('retention invalid', r.status === 400 && r.data.code === 'retention_invalid')
r = await A.put('/api/admin/settings/general', { app_name: '' })
t('app_name reset -> Wishy', r.data.app_name === 'Wishy', r.data)
r = await A.get('/api/auth/me'); t('features present', r.data.user.features && 'ai' in r.data.user.features && 'api' in r.data.user.features)

// Unknown API / error codes
r = await A.get('/api/doesnotexist')
t('unknown api has code', r.status === 404 && r.data.code === 'not_found', r)

raw.close()
await stop()

// ---- Second run: environment variables lock settings ----
await start({ TRUST_PROXY: '1', BASE_URL: 'https://env.example.net' })
const A2 = mk()
r = await A2.post('/api/auth/login', { email: 'admin@example.com', password: PW })
r = await A2.get('/api/admin/settings/general')
t('env locked keys', r.data.env_locked.includes('trust_proxy') && r.data.env_locked.includes('base_url') && r.data.trust_proxy === '1' && r.data.base_url === 'https://env.example.net', r.data)
r = await A2.put('/api/admin/settings/general', { trust_proxy: 'off', base_url: 'http://x.test' })
t('env locked keys ignore PUT', r.data.trust_proxy === '1' && r.data.base_url === 'https://env.example.net', r.data)
r = await A2.get('/api/admin/diagnostics/proxy', { headers: { 'X-Forwarded-For': '198.51.100.7' } })
t('env diagnostics', r.data.trust_proxy.source === 'env' && r.data.trust_proxy.locked && r.data.proxy_trusted && r.data.client_ip === '198.51.100.7', r.data)
await stop()


// =====================================================================================================================
// Security fixes (review): headers/CSP, cookies, Google pre-hijack, re-auth, 2FA ticket cookie, audit flood, rate limiting,
// body sizes, bound invites, secret.key protection, encrypted settings
// =====================================================================================================================
console.log('# Security fixes')
const MOCK = ['--import', new URL('./mock-google.mjs', import.meta.url).href]
const dbRaw = () => { const d = new DatabaseSync(path.join(DATA, 'wishlist.db')); d.exec('PRAGMA busy_timeout=5000'); return d }
const loginAs = async (c, email) => { const x = await c.post('/api/auth/login', { email, password: PW }); return x }
const staleAll = (d, where = '') => d.prepare(`UPDATE sessions SET reauth_at=1 ${where}`).run()

// ---- Run 1: https base URL (proxy NOT trusted), Google mock ----
await start({ BASE_URL: 'https://wishy.test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' }, MOCK)
{
  const raw = dbRaw()
  const H = mk()
  r = await H.get('/')
  const csp = r.headers.get('content-security-policy') || ''
  t('H1 CSP on index', csp.includes("default-src 'self'") && csp.includes("script-src 'self'") && !/script-src[^;]*unsafe-inline/.test(csp) && csp.includes("frame-ancestors 'none'") && csp.includes("img-src 'self' data: blob:") && csp.includes("object-src 'none'") && csp.includes("base-uri 'self'"), csp)
  t('H1 index.html has no inline script (theme script is external)', !/<script>/.test(r.data) && r.data.includes('/assets/theme-init.js'))
  t('H1 xfo/nosniff/referrer/permissions', r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('referrer-policy') === 'same-origin' && /camera=\(\)/.test(r.headers.get('permissions-policy') || ''))
  t('H1 HSTS when base_url is https', /^max-age=\d+$/.test(r.headers.get('strict-transport-security') || ''), r.headers.get('strict-transport-security'))
  r = await H.get('/assets/theme-init.js')
  t('H1 theme-init.js served from /assets', r.status === 200 && /localStorage/.test(r.data), r.status)
  r = await H.get('/api/auth/providers')
  t('H1 security headers also on API responses', (r.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'") && r.headers.get('x-content-type-options') === 'nosniff')
  r = await H.get('/w/doesnotexist')
  t('H1 public page route carries CSP', (r.headers.get('content-security-policy') || '').includes("script-src 'self'"))

  // ---- Cookies: __Host- + Secure with an https base URL, even without a trusted proxy ----
  const A1 = mk()
  r = await loginAs(A1, 'admin@example.com')
  const sc = r.setCookie.find((c) => c.startsWith('__Host-wl_session='))
  t('C1 __Host- cookie with Secure, Path=/, no Domain', !!sc && /;\s*Secure/.test(sc) && /Path=\//.test(sc) && !/Domain=/i.test(sc) && /HttpOnly/.test(sc), r.setCookie)
  r = await A1.get('/api/auth/me')
  t('C1 __Host- session works', r.status === 200)
  const sid = A1.cookies['__Host-wl_session']
  const L = mk(); L.cookies.wl_session = sid
  r = await L.get('/api/auth/me')
  t('C1 plain cookie name is read too (sessions from plain-http access)', r.status === 200)
  r = await A1.post('/api/auth/logout', {})
  t('C1 logout clears both cookie names', r.setCookie.some((c) => c.startsWith('wl_session=;') || c.startsWith('wl_session=')) && r.setCookie.some((c) => c.startsWith('__Host-wl_session=')), r.setCookie)

  // ---- Google: mock login ----
  async function gLogin(c, claims, path = '/api/auth/google/start') {
    const s = await c.get(path)
    const loc = s.headers.get('location') || ''
    if (!loc.startsWith('https://accounts.google.com')) return { start: s }
    const q = new URL(loc).searchParams
    const code = Buffer.from(JSON.stringify({ email_verified: true, name: 'G User', ...claims, nonce: q.get('nonce') })).toString('base64url')
    const cb = await c.get(`/api/auth/google/callback?state=${q.get('state')}&code=${code}`)
    return { start: s, cb, loc: cb.headers.get('location') || '' }
  }
  const ADM = mk(); await loginAs(ADM, 'admin@example.com')
  r = await ADM.put('/api/admin/settings/auth', { registration_enabled: true, registration_mode: 'open' })

  // Finding 2: Pre-Hijack
  await ADM.post('/api/admin/users', { name: 'Vic', email: 'vic@example.com', password: PW }) // created by the "attacker" with their own password
  let g = await gLogin(mk(), { sub: 'sub-vic', email: 'vic@example.com' })
  t('F2 existing account with password is NOT auto-linked', /error=account_exists/.test(g.loc) && !g.cb.setCookie.some((c) => /wl_session=[^;]+/.test(c) && !/Max-Age=0/.test(c)), [g.loc, g.cb?.setCookie])
  t('F2 google_sub stays NULL', raw.prepare("SELECT google_sub FROM users WHERE email='vic@example.com'").get().google_sub === null)
  await ADM.post('/api/admin/users', { name: 'Old', email: 'old@example.com' })
  raw.prepare("UPDATE users SET google_sub='sub-old' WHERE email='old@example.com'").run()
  g = await gLogin(mk(), { sub: 'sub-new', email: 'old@example.com' })
  t('F2 existing google_sub is never overwritten', /error=account_exists/.test(g.loc) && raw.prepare("SELECT google_sub FROM users WHERE email='old@example.com'").get().google_sub === 'sub-old', g.loc)
  r = await ADM.post('/api/admin/users', { name: 'Una', email: 'una@example.com' }) // without a password: setup link
  const unaId = r.data.user.id
  g = await gLogin(mk(), { sub: 'sub-una', email: 'una@example.com' })
  t('F2 password-less admin-created account IS linked (legit path)', g.loc === '/' && raw.prepare("SELECT google_sub FROM users WHERE email='una@example.com'").get().google_sub === 'sub-una', g.loc)
  t('F2 claiming the account retires its setup link', raw.prepare('SELECT COUNT(*) AS n FROM user_invites WHERE user_id=?').get(unaId).n === 0)

  // Finding 3: first password -> fresh confirmation; Google re-confirmation
  const G = mk()
  g = await gLogin(G, { sub: 'sub-gina', email: 'gina@example.com', name: 'Gina' })
  t('F3 google signup (open registration) logs in', g.loc === '/', g.loc)
  const ginaId = raw.prepare("SELECT id FROM users WHERE email='gina@example.com'").get().id
  staleAll(raw, `WHERE user_id=${ginaId}`)
  r = await G.put('/api/account', { new_password: PW })
  t('F3 first password on stale session -> 403 reauth_required', r.status === 403 && r.data.code === 'reauth_required', r)
  g = await gLogin(G, { sub: 'sub-evil', email: 'evil@example.com' }, '/api/auth/google/start?reauth=1')
  t('F3 reauth with a different google account is refused', /error=google_wrong_account/.test(g.loc), g.loc)
  r = await G.put('/api/account', { new_password: PW })
  t('F3 ... and the session stays stale', r.status === 403, r)
  g = await gLogin(G, { sub: 'sub-gina', email: 'gina@example.com' }, '/api/auth/google/start?reauth=1')
  t('F3 reauth with the linked google account -> fresh', /reauthed=1/.test(g.loc), g.loc)
  r = await G.put('/api/account', { new_password: PW })
  t('F3 first password allowed in the fresh window', r.status === 200 && r.data.user.has_password === true, r)
  t('F3 reauth fresh-ask `{}` ok', (await G.post('/api/account/reauth', {})).status === 200)
  staleAll(raw, `WHERE user_id=${ginaId}`)
  r = await G.post('/api/account/reauth', {})
  t('F3 reauth `{}` when stale -> reauth_required', r.status === 400 && r.data.code === 'reauth_required', r)
  r = await G.del('/api/account/identities/google', {})
  t('F3 IdP unlink needs fresh confirmation', r.status === 403 && r.data.code === 'reauth_required', r)
  r = await G.del('/api/account/identities/google', { current_password: PW })
  t('F3 IdP unlink with password ok', r.status === 200 && !r.data.user.google_linked, r.data)

  // Low: 2FA ticket not in the URL but in an HttpOnly cookie
  const T1 = mk()
  await ADM.post('/api/admin/users', { name: 'Tfa', email: 'tfa@example.com' })
  g = await gLogin(T1, { sub: 'sub-tfa', email: 'tfa@example.com' })
  r = await T1.post('/api/account/2fa/totp/setup', {})
  const tkey = b32dec(r.data.secret)
  r = await T1.post('/api/account/2fa/totp/confirm', { code: totpAt(tkey, Date.now()) })
  t('L enable totp for google user (fresh after login)', r.status === 200 && r.data.recovery_codes?.length === 10, r)
  await T1.post('/api/auth/logout', {})
  const T2 = mk()
  g = await gLogin(T2, { sub: 'sub-tfa', email: 'tfa@example.com' })
  const tc = g.cb.setCookie.find((c) => c.startsWith('wl_2fa=') || c.startsWith('__Host-wl_2fa='))
  t('L 2FA redirect carries no ticket in the URL', g.loc === '/login?2fa=1', g.loc)
  t('L ticket travels in a short-lived HttpOnly cookie', !!tc && /HttpOnly/.test(tc) && /Max-Age=300/.test(tc), g.cb.setCookie)
  r = await T2.post('/api/auth/2fa/pending', {})
  t('L pending returns ticket + methods', r.status === 200 && r.data.two_factor?.ticket && r.data.two_factor.methods.includes('totp'), r)
  const tick = r.data.two_factor?.ticket
  t('L pending clears the cookie', r.setCookie.some((c) => /^wl_2fa=;|^wl_2fa=\s*;/.test(c) || /wl_2fa=;/.test(c)), r.setCookie)
  r = await T2.post('/api/auth/2fa/pending', {})
  t('L pending without cookie -> ticket_invalid', r.status === 400 && r.data.code === 'ticket_invalid', r)
  r = await T2.post('/api/auth/2fa/verify', { ticket: tick, method: 'totp', code: totpAt(tkey, Date.now() + 30000) })
  t('L verify with the ticket from the cookie logs in', r.status === 200 && r.data.user?.email === 'tfa@example.com', r)

  // ---- Re-auth for sensitive account actions (password account) ----
  r = await ADM.post('/api/admin/users', { name: 'Rea', email: 'rea@example.com', password: PW })
  const R1 = mk(), R2 = mk()
  await loginAs(R1, 'rea@example.com'); await loginAs(R2, 'rea@example.com')
  const reaId = raw.prepare("SELECT id FROM users WHERE email='rea@example.com'").get().id
  t('R fresh right after login: totp setup allowed', (await R1.post('/api/account/2fa/totp/setup', {})).status === 200)
  staleAll(raw, `WHERE user_id=${reaId}`)
  r = await R1.post('/api/account/2fa/totp/setup', {})
  t('R totp setup stale -> 403 reauth_required', r.status === 403 && r.data.code === 'reauth_required', r)
  r = await R1.post('/api/account/reauth', { current_password: 'wrong-wrong' })
  t('R reauth wrong password', r.status === 400 && r.data.code === 'password_invalid', r)
  r = await R1.post('/api/account/reauth', { current_password: PW })
  t('R reauth with password ok', r.status === 200)
  r = await R1.post('/api/account/2fa/totp/setup', {})
  const rkey = b32dec(r.data.secret)
  t('R after reauth: setup ok (10 min window)', r.status === 200)
  staleAll(raw, `WHERE user_id=${reaId}`)
  r = await R1.post('/api/account/2fa/totp/confirm', { code: totpAt(rkey, Date.now()) })
  t('R totp confirm stale -> 403 reauth_required', r.status === 403 && r.data.code === 'reauth_required', r)
  await R1.post('/api/account/reauth', { current_password: PW })
  r = await R1.post('/api/account/2fa/totp/confirm', { code: totpAt(rkey, Date.now()) })
  t('R totp confirm ok after reauth', r.status === 200 && r.data.recovery_codes?.length === 10, r)
  const reaCodes = r.data.recovery_codes
  t('R enabling 2FA revokes the OTHER sessions', (await R2.get('/api/auth/me')).status === 401)
  t('R ... but keeps the current one', (await R1.get('/api/auth/me')).status === 200)
  staleAll(raw, `WHERE user_id=${reaId}`)
  r = await R1.post('/api/account/2fa/webauthn/register-options', {})
  t('R passkey register-options stale -> 403 reauth_required', r.status === 403 && r.data.code === 'reauth_required', r)
  r = await R1.post('/api/account/2fa/webauthn/register', { name: 'k', response: {} })
  t('R passkey register stale -> 403 reauth_required', r.status === 403 && r.data.code === 'reauth_required', r)
  r = await R1.post('/api/account/reauth', { code: reaCodes[0] })
  t('R reauth with a recovery code', r.status === 200, r)
  r = await R1.post('/api/account/2fa/webauthn/register-options', {})
  t('R passkey options ok when fresh', r.status === 200 && typeof r.data.challenge === 'string')
  // regenerate / disable revoke other sessions; a fresh window needs no re-entry
  const R3 = mk()
  let lr = await loginAs(R3, 'rea@example.com')
  lr = await R3.post('/api/auth/2fa/verify', { ticket: lr.data.two_factor.ticket, method: 'recovery', code: reaCodes[1] })
  t('R second device signs in with a recovery code', lr.status === 200, lr)
  r = await R1.post('/api/account/2fa/recovery/regenerate', {})
  t('R regenerate within the fresh window needs no re-entry', r.status === 200 && r.data.recovery_codes?.length === 10, r)
  t('R regenerating codes revokes other sessions', (await R3.get('/api/auth/me')).status === 401)
  const R4 = mk()
  lr = await loginAs(R4, 'rea@example.com')
  lr = await R4.post('/api/auth/2fa/verify', { ticket: lr.data.two_factor.ticket, method: 'recovery', code: r.data.recovery_codes[0] })
  r = await R1.post('/api/account/2fa/totp/disable', {})
  t('R disabling 2FA ok in fresh window', r.status === 200 && r.data.totp === false, r)
  t('R disabling 2FA revokes other sessions', (await R4.get('/api/auth/me')).status === 401)

  // ---- Finding 7: a bound invite must not overwrite an existing password/2FA/Google ----
  const pwHash = raw.prepare("SELECT password_hash FROM users WHERE email='admin@example.com'").get().password_hash
  const tokOf = (rr) => rr.data.url.split('invite=')[1]
  r = await ADM.post('/api/admin/users', { name: 'B1', email: 'b1@example.com' }); const tB1 = tokOf(r)
  raw.prepare("UPDATE users SET password_hash=? WHERE email='b1@example.com'").run(pwHash)
  r = await mk().post('/api/auth/register', { name: 'B1', email: 'b1@example.com', password: 'Attacker-pass-1', invite: tB1 })
  t('F7 bound invite refused when the user already has a password', r.status === 400 && r.data.code === 'invite_invalid', r)
  t('F7 ... password unchanged', raw.prepare("SELECT password_hash FROM users WHERE email='b1@example.com'").get().password_hash === pwHash)
  r = await mk().get(`/api/auth/invite/${tB1}`)
  t('F7 invite check reports invalid', r.data.valid === false, r.data)
  r = await ADM.post('/api/admin/users', { name: 'B2', email: 'b2@example.com' }); const tB2 = tokOf(r)
  const b2 = raw.prepare("SELECT id FROM users WHERE email='b2@example.com'").get().id
  raw.prepare("INSERT INTO user_totp (user_id, secret_enc, confirmed, last_step) VALUES (?,?,1,0)").run(b2, 'x')
  r = await mk().post('/api/auth/register', { name: 'B2', email: 'b2@example.com', password: 'Attacker-pass-1', invite: tB2 })
  t('F7 bound invite refused when the user has 2FA', r.status === 400 && r.data.code === 'invite_invalid', r)
  raw.prepare('DELETE FROM user_totp WHERE user_id=?').run(b2)
  r = await ADM.post('/api/admin/users', { name: 'B3', email: 'b3@example.com' }); const tB3 = tokOf(r)
  r = await mk().post('/api/auth/register', { name: 'B3', email: 'b3@example.com', password: PW, invite: tB3 })
  t('F7 pristine bound invite still works', r.status === 200 && r.data.user?.email === 'b3@example.com', r)

  // ---- Finding 6: body sizes ----
  const big = (n) => JSON.stringify({ email: 'x@example.com', password: 'y'.repeat(n) })
  r = await mk().raw('POST', '/api/auth/login', { rawBody: big(300_000), ct: 'application/json' })
  t('F6 unauthenticated 300 KB body -> 413', r.status === 413 && r.data.code === 'payload_too_large', r)
  await ADM.post('/api/admin/users', { name: 'Bob2', email: 'bob2@example.com', password: PW })
  const AD = mk(); await loginAs(AD, 'admin@example.com')
  r = await AD.raw('POST', '/api/persons', { rawBody: JSON.stringify({ name: 'x', notes: 'y'.repeat(300_000) }), ct: 'application/json' })
  t('F6 authenticated normal route: 300 KB -> 413', r.status === 413, r.status)
  r = await AD.raw('POST', '/api/import', { rawBody: JSON.stringify({ pad: 'y'.repeat(1_000_000) }), ct: 'application/json' })
  t('F6 /api/import accepts large bodies for logged-in users', r.status !== 413, [r.status, r.data])
  r = await mk().raw('POST', '/api/import', { rawBody: JSON.stringify({ pad: 'y'.repeat(300_000) }), ct: 'application/json' })
  t('F6 /api/import without login: only 200 KB', r.status === 413, r.status)
  r = await AD.raw('POST', '/api/ai/extract-image', { rawBody: JSON.stringify({ image_base64: 'A'.repeat(1_000_000), media_type: 'image/png' }), ct: 'application/json' })
  t('F6 image import accepts MB-sized bodies', r.status !== 413, [r.status, r.data?.code])
  r = await mk().raw('POST', '/api/v1/capture', { rawBody: JSON.stringify({ text: 'z'.repeat(500_000) }), ct: 'application/json', headers: { Authorization: 'Bearer nope' } })
  t('F6 API v1: bad key + big body -> 401 (not parsed)', r.status === 401, r.status)

  raw.close()
}
await stop()

// ---- Run 2: proxy trusted (XFF), rate limiting by real client IP, audit flood ----
await start({ TRUST_PROXY: '1' })
{
  const raw = dbRaw()
  const ip = (n) => ({ 'X-Forwarded-For': `198.51.100.${n}` })
  const attempt = (c, n, email, pw = 'nope-nope-nope') => c.post('/api/auth/login', { email, password: pw }, { headers: ip(n) })

  // Finding 5: spraying across many email addresses from one IP
  let last
  for (let i = 0; i < 40; i++) last = await attempt(mk(), 10, `spray${i}@example.com`)
  t('F5 40 failures across different emails from one IP are all plain 401', last.status === 401, last.status)
  r = await attempt(mk(), 10, 'admin@example.com', PW)
  t('F5 per-IP limit blocks even a correct login (429 + Retry-After)', r.status === 429 && r.data.code === 'too_many_attempts' && Number(r.headers.get('retry-after')) > 0, [r.status, r.headers.get('retry-after')])
  r = await attempt(mk(), 11, 'admin@example.com', PW)
  t('F5 limits key on the REAL client IP (another IP is unaffected)', r.status === 200, r.status)

  // Account backoff instead of hard locking
  const BE = mk(); r = await attempt(BE, 50, 'bob2@example.com', PW)
  t('F5 victim has a session from a known IP', r.status === 200, r.status)
  for (const n of [21, 22, 23]) for (let i = 0; i < 8; i++) await attempt(mk(), n, 'bob2@example.com')
  r = await attempt(mk(), 29, 'bob2@example.com', PW)
  t('F5 per-account backoff slows unknown IPs (24 failures from other IPs)', r.status === 429 && Number(r.headers.get('retry-after')) > 0, [r.status, r.headers.get('retry-after')])
  r = await attempt(mk(), 50, 'bob2@example.com', PW)
  t('F5 ... but the account is NOT hard-locked: the victim from a known IP still gets in', r.status === 200, [r.status, r.data])

  // All unauthenticated POSTs: 60 per minute and IP
  let n429 = 0, firstBlocked = -1
  for (let i = 0; i < 65; i++) {
    const x = await mk().post('/api/auth/2fa/verify', { ticket: 'x', method: 'totp', code: '1' }, { headers: ip(70) })
    if (x.status === 429) { n429++; if (firstBlocked < 0) firstBlocked = i }
  }
  t('F6 unauthenticated POSTs limited per IP (60/min)', n429 >= 4 && firstBlocked === 60, [n429, firstBlocked])
  r = await mk().post('/api/auth/2fa/verify', { ticket: 'x', method: 'totp', code: '1' }, { headers: ip(71) })
  t('F6 ... other IP not affected', r.status !== 429, r.status)

  // Finding 4: audit flood
  const AU = mk(); await attempt(AU, 90, 'admin@example.com', PW)
  const cnt = (sql, ...p) => raw.prepare(sql).get(...p).n
  const before = cnt("SELECT COUNT(*) AS n FROM audit_log WHERE action='auth.login' AND status='fail'")
  for (let i = 0; i < 30; i++) await attempt(mk(), 91, `flood${i}@example.com`)
  const added = cnt("SELECT COUNT(*) AS n FROM audit_log WHERE action='auth.login' AND status='fail'") - before
  t('F4 anonymous failures from one IP are aggregated (max 5 per minute)', added <= 6 && added >= 1, added)
  for (let i = 0; i < 30; i++) await mk().get(`/api/zzz-flood-${i}`, { headers: ip(92) })
  for (let i = 0; i < 10; i++) await mk().post(`/api/zzz-flood-post-${i}`, {}, { headers: ip(92) })
  t('F4 unknown routes (404) are not audited', cnt("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE '%zzz-flood%'") === 0)
  await mk().post('/api/wishlists', { title: 'x' }, { headers: ip(93) })
  t('F4 anonymous 401 on protected routes is not audited', cnt("SELECT COUNT(*) AS n FROM audit_log WHERE action='api.post./api/wishlists' OR action='wishlist.create'") === 0)
  const long = 'a'.repeat(5000)
  await mk().post('/api/auth/login', { email: long + '@example.com', password: 'x' }, { headers: ip(94) })
  t('F4 attacker-controlled strings are capped in the log', cnt('SELECT COUNT(*) AS n FROM audit_log WHERE length(actor_label)>300 OR length(details)>4100 OR length(action)>120') === 0)
  raw.close()
}
await stop()

// ---- Run 3: secret.key protection and encrypted settings ----
{
  const keyFile = path.join(DATA, 'secret.key')
  const raw = dbRaw()
  const hasTotp = raw.prepare('SELECT COUNT(*) AS n FROM user_totp').get().n + raw.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes').get().n
  t('S precondition: database holds encrypted 2FA material', hasTotp > 0, hasTotp)
  raw.close()
  fs.renameSync(keyFile, keyFile + '.bak')
  const failure = await new Promise((resolve) => {
    const p = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT) } })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.stdout.on('data', (d) => { if (String(d).includes('running')) { p.kill(); resolve({ code: 0, err }) } })
    p.on('exit', (code) => resolve({ code, err }))
  })
  t('S missing secret.key + encrypted data -> startup fails loudly', failure.code !== 0 && /secret\.key is missing/.test(failure.err) && /WISHY_ALLOW_NEW_SECRET_KEY/.test(failure.err), failure)
  t('S ... and no new key was silently generated', !fs.existsSync(keyFile))
  fs.renameSync(keyFile + '.bak', keyFile)

  const raw2 = dbRaw()
  await start()
  const val = (k) => raw2.prepare('SELECT value FROM system_settings WHERE key=?').get(k)?.value
  const AD = mk(); await loginAs(AD, 'admin@example.com')
  r = await AD.put('/api/admin/settings/auth', { google_client_id: 'cid', google_client_secret: 'brand-new-secret-123' })
  t('S new secret is stored sealed', r.status === 200 && /^"enc1:/.test(val('google_client_secret')) && !val('google_client_secret').includes('brand-new'), val('google_client_secret'))
  r = await AD.get('/api/admin/settings/auth')
  t('S sealed secret counts as configured', r.data.google_client_secret_set === true && r.data.google_credentials_set === true && !JSON.stringify(r.data).includes('brand-new'), r.data)
  raw2.close()
  await stop()
}

// ---- Run 4: passwordless sign-in with passkeys (software authenticator, real WebAuthn ceremony without a browser) ----
await start({ TRUST_PROXY: '1' })
{
  const { SoftAuthenticator, b64u: b64 } = await import('./webauthn-soft.mjs')
  const raw = dbRaw()
  const ORIGIN = BASE
  let ipn = 0
  const nextIp = () => ({ 'X-Forwarded-For': `203.0.113.${++ipn}` })
  const cnt = (sql, ...a) => raw.prepare(sql).get(...a).n
  const AD = mk(); await loginAs(AD, 'admin@example.com')
  await AD.put('/api/admin/settings/auth', { two_factor_policy: 'optional' })
  r = await AD.post('/api/admin/users', { name: 'Pia', email: 'pia@example.com', password: PW })
  t('PK admin creates a user', r.status === 200 || r.status === 201, r)
  const piaId = raw.prepare("SELECT id FROM users WHERE email='pia@example.com'").get().id
  const handle = `wishy-user-${piaId}`

  // --- Registration: discoverable credential + user verification are required
  const P = mk(); await loginAs(P, 'pia@example.com')
  r = await P.post('/api/account/2fa/webauthn/register-options', {})
  const ro = r.data
  t('PK register options demand resident key + UV', r.status === 200 && ro.authenticatorSelection?.residentKey === 'required' && ro.authenticatorSelection?.requireResidentKey === true && ro.authenticatorSelection?.userVerification === 'required' && ro.extensions?.credProps === true, ro.authenticatorSelection)
  const dev = new SoftAuthenticator()
  r = await P.post('/api/account/2fa/webauthn/register', { name: 'Soft', response: dev.attest(ro, { origin: ORIGIN, uv: false }) })
  t('PK registration without user verification is rejected', r.status === 400 && r.data.code === 'webauthn_failed', r)
  r = await P.post('/api/account/2fa/webauthn/register-options', {})
  r = await P.post('/api/account/2fa/webauthn/register', { name: 'Soft', response: dev.attest(r.data, { origin: 'https://evil.example' }) })
  t('PK registration with wrong origin is rejected', r.status === 400 && r.data.code === 'webauthn_failed', r)
  r = await P.post('/api/account/2fa/webauthn/register-options', {})
  r = await P.post('/api/account/2fa/webauthn/register', { name: 'Soft', response: dev.attest(r.data, { origin: ORIGIN, rpId: 'evil.example' }) })
  t('PK registration with wrong rpIdHash is rejected', r.status === 400 && r.data.code === 'webauthn_failed', r)
  r = await P.post('/api/account/2fa/webauthn/register-options', {})
  r = await P.post('/api/account/2fa/webauthn/register', { name: 'Soft', response: dev.attest(r.data, { origin: ORIGIN, rk: false }) })
  t('PK credProps rk=false is rejected as not discoverable', r.status === 400 && r.data.code === 'webauthn_not_discoverable', r)
  r = await P.post('/api/account/2fa/webauthn/register-options', {})
  const regOpts = r.data
  r = await P.post('/api/account/2fa/webauthn/register', { name: 'Soft', response: dev.attest(regOpts, { origin: ORIGIN }) })
  t('PK registration ok, flagged passwordless, recovery codes issued', r.status === 200 && r.data.passkeys === 1 && r.data.passkey_list[0].passwordless === true && r.data.recovery_codes?.length === 10, r.data)
  r = await P.post('/api/account/2fa/webauthn/register', { name: 'Soft', response: dev.attest(regOpts, { origin: ORIGIN }) })
  t('PK registration challenge is single use', r.status === 400 && r.data.code === 'webauthn_challenge_expired', r)

  // --- Options: well-formed, no enumeration, bound to the browser by a Strict cookie
  const X = mk()
  r = await X.post('/api/auth/passkey/options', {}, { headers: nextIp() })
  const o1 = r.data
  const ck = r.setCookie.find((c) => c.startsWith('wl_pk='))
  t('PK options well-formed (no allowCredentials, UV required, rpId)', r.status === 200 && typeof o1.challenge === 'string' && o1.challenge.length >= 32 && o1.rpId === '127.0.0.1' && o1.userVerification === 'required' && !(o1.allowCredentials?.length) && o1.timeout > 0, o1)
  t('PK challenge cookie is HttpOnly, SameSite=Strict, scoped, short-lived', !!ck && /HttpOnly/i.test(ck) && /SameSite=Strict/i.test(ck) && /Path=\/api\/auth\/passkey/i.test(ck) && /Max-Age=300/i.test(ck), ck)
  r = await mk().post('/api/auth/passkey/options', { email: 'pia@example.com' }, { headers: nextIp() })
  t('PK options carry nothing account specific (input ignored)', r.status === 200 && Object.keys(r.data).sort().join() === Object.keys(o1).sort().join() && !JSON.stringify(r.data).includes(dev.id) && !r.data.allowCredentials?.length, r.data)
  const ckVal = decodeURIComponent(ck.split(';')[0].split('=')[1])

  // --- Happy path: sign in with the passkey alone (no password, no second factor)
  const ipOk = nextIp()
  r = await X.post('/api/auth/passkey/verify', { response: dev.assert(o1, { origin: ORIGIN, userHandle: handle }) }, { headers: ipOk })
  t('PK passwordless login ok (session, no 2FA step)', r.status === 200 && r.data.user?.email === 'pia@example.com' && !r.data.two_factor && !!X.cookies.wl_session, r)
  t('PK challenge cookie is cleared after use', !X.cookies.wl_pk)
  r = await X.get('/api/auth/me')
  t('PK session works', r.status === 200 && r.data.user.email === 'pia@example.com')
  const sess = raw.prepare('SELECT reauth_at, ip FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(piaId)
  t('PK login counts as fresh (reauth_at) and records the IP', Date.now() - sess.reauth_at < 60_000 && sess.ip === ipOk['X-Forwarded-For'], sess)
  const okRow = raw.prepare("SELECT * FROM audit_log WHERE action='auth.login' AND status='ok' AND details LIKE '%passkey%' ORDER BY id DESC LIMIT 1").get()
  t('PK success is audited with method passkey and IP', okRow && JSON.parse(okRow.details).method === 'passkey' && okRow.ip === ipOk['X-Forwarded-For'] && okRow.actor_user_id === piaId, okRow)
  const pkRow = raw.prepare('SELECT counter, last_used_at FROM user_webauthn WHERE id=?').get(dev.id)
  t('PK counter and last use stored', pkRow.counter === dev.counter && !!pkRow.last_used_at, pkRow)

  // --- Replay and binding
  r = await mk().post('/api/auth/passkey/verify', { response: dev.assert(o1, { origin: ORIGIN, userHandle: handle, counter: false }) }, { headers: { ...nextIp(), Cookie: `wl_pk=${ckVal}` } })
  t('PK replay of a used challenge is rejected', r.status === 400 && r.data.code === 'passkey_expired', r)
  r = await mk().post('/api/auth/passkey/verify', { response: dev.assert(o1, { origin: ORIGIN, userHandle: handle }) }, { headers: nextIp() })
  t('PK verify without the cookie is rejected', r.status === 400 && r.data.code === 'passkey_expired', r)
  const Y = mk()
  r = await Y.post('/api/auth/passkey/options', {}, { headers: nextIp() })
  const oY = r.data
  const cookieY = Y.cookies.wl_pk
  r = await mk().post('/api/auth/passkey/verify', { response: dev.assert(oY, { origin: ORIGIN, userHandle: handle }) }, { headers: { ...nextIp(), Cookie: 'wl_pk=bogus' } })
  t('PK a different challenge id does not work', r.status === 400 && r.data.code === 'passkey_expired', r)
  // the first failed attempt consumed nothing of Y's challenge; Y can still sign in
  Y.cookies.wl_pk = cookieY
  r = await Y.post('/api/auth/passkey/verify', { response: dev.assert(oY, { origin: ORIGIN, userHandle: handle }) }, { headers: nextIp() })
  t('PK second browser signs in with its own challenge', r.status === 200 && r.data.user?.email === 'pia@example.com', r)

  // --- Uniform failure for every kind of defect (each from its own IP so that the limiter stays out of the way)
  const attemptWith = async (mod, { ip = nextIp(), c = mk() } = {}) => {
    const x = await c.post('/api/auth/passkey/options', {}, { headers: ip })
    const resp = typeof mod === 'function' ? mod(x.data) : mod
    return c.post('/api/auth/passkey/verify', { response: resp }, { headers: ip })
  }
  const failures = {
    'missing user verification': (o) => dev.assert(o, { origin: ORIGIN, userHandle: handle, uv: false }),
    'wrong user handle': (o) => dev.assert(o, { origin: ORIGIN, userHandle: 'wishy-user-' + (piaId + 1) }),
    'no user handle': (o) => dev.assert(o, { origin: ORIGIN }),
    'wrong origin': (o) => dev.assert(o, { origin: 'https://evil.example', userHandle: handle }),
    'wrong rpIdHash': (o) => dev.assert(o, { origin: ORIGIN, userHandle: handle, rpId: 'evil.example' }),
    'wrong challenge': (o) => dev.assert(o, { origin: ORIGIN, userHandle: handle, challenge: b64(Buffer.alloc(32, 7)) }),
    'counter regression (cloned authenticator)': (o) => dev.assert(o, { origin: ORIGIN, userHandle: handle, counter: 1 }),
    'unknown credential': (o) => dev.assert(o, { origin: ORIGIN, userHandle: handle, id: b64(Buffer.alloc(32, 9)) }),
    'garbage': () => ({ id: 'x', rawId: 'x', type: 'public-key', response: {}, clientExtensionResults: {} }),
    'not an object': () => 'nope',
  }
  const bodies = new Set()
  for (const [name, mod] of Object.entries(failures)) {
    r = await attemptWith(mod)
    bodies.add(JSON.stringify(r.data))
    t(`PK ${name} -> uniform passkey_login_failed`, r.status === 400 && r.data.code === 'passkey_login_failed', r)
  }
  t('PK all failure answers are byte-identical', bodies.size === 1, [...bodies])
  const fails = cnt("SELECT COUNT(*) AS n FROM audit_log WHERE action='auth.login' AND status='fail' AND details LIKE '%passkey%'")
  t('PK failures are audited with method passkey and IP', fails >= Object.keys(failures).length && cnt("SELECT COUNT(*) AS n FROM audit_log WHERE action='auth.login' AND status='fail' AND details LIKE '%passkey%' AND ip LIKE '203.0.113.%'") >= 9, fails)
  r = await attemptWith((o) => dev.assert(o, { origin: ORIGIN, userHandle: handle }))
  t('PK a failed attempt does not burn the credential (valid login still works)', r.status === 200 && r.data.user?.email === 'pia@example.com', r)

  // timing: failure answers are padded (no oracle on unknown credential vs. bad signature)
  const timeOf = async (mod) => { const c = mk(); const ip = nextIp(); const x = await c.post('/api/auth/passkey/options', {}, { headers: ip }); const s = Date.now(); await c.post('/api/auth/passkey/verify', { response: mod(x.data) }, { headers: ip }); return Date.now() - s }
  const tUnknown = await timeOf(failures['unknown credential'])
  const tBadSig = await timeOf(failures['wrong origin'])
  t('PK failure timing is padded and similar', tUnknown >= 250 && tBadSig >= 250 && Math.abs(tUnknown - tBadSig) < 150, { tUnknown, tBadSig })

  // --- Password sign-in is unchanged: still needs the second factor, the passkey (UV not required there) counts
  const PW2 = mk()
  r = await PW2.post('/api/auth/login', { email: 'pia@example.com', password: PW }, { headers: nextIp() })
  t('PK password login still demands the second factor', !!r.data.two_factor?.ticket && r.data.two_factor.methods.includes('webauthn'), r.data)

  // --- Re-authentication with the passkey
  raw.prepare('UPDATE sessions SET reauth_at=1 WHERE user_id=?').run(piaId)
  r = await X.post('/api/account/reauth', {})
  t('PK reauth is required when the session is stale', r.status === 400 || r.status === 403, r.status)
  r = await X.post('/api/account/reauth/passkey-options', {})
  const rao = r.data
  t('PK reauth options demand UV and list this user’s credentials', r.status === 200 && rao.userVerification === 'required' && rao.allowCredentials?.length === 1 && rao.allowCredentials[0].id === dev.id, rao)
  r = await X.post('/api/account/reauth', { passkey: dev.assert(rao, { origin: ORIGIN, userHandle: handle, uv: false }) })
  t('PK reauth without UV is rejected', r.status >= 400, r)
  r = await X.post('/api/account/reauth/passkey-options', {})
  const rao2 = r.data
  const goodReauth = dev.assert(rao2, { origin: ORIGIN, userHandle: handle })
  r = await X.post('/api/account/reauth', { passkey: goodReauth })
  t('PK reauth with passkey ok', r.status === 200 && r.data.ok === true, r)
  t('PK reauth marks the session fresh', Date.now() - raw.prepare('SELECT reauth_at FROM sessions WHERE id=?').get(X.cookies.wl_session)?.reauth_at < 60_000)
  r = await X.post('/api/account/reauth', { passkey: goodReauth })
  t('PK reauth challenge is single use', r.status === 400, r)
  // a password-only user (no passkey) cannot use the passkey route
  r = await AD.post('/api/account/reauth/passkey-options', {})
  t('PK reauth options for a user without passkeys -> 400', r.status === 400 && r.data.code === 'webauthn_not_available', r)

  // --- Second-factor-only security key: allowed for 2FA, never for passwordless sign-in
  r = await X.post('/api/account/reauth', { current_password: PW })
  r = await X.post('/api/account/2fa/webauthn/register-options', { second_factor_only: true })
  const so = r.data
  t('PK second-factor-only options relax resident key and UV', r.status === 200 && so.authenticatorSelection?.residentKey === 'discouraged' && so.authenticatorSelection?.userVerification === 'discouraged', so.authenticatorSelection)
  const key2 = new SoftAuthenticator()
  r = await X.post('/api/account/2fa/webauthn/register', { name: 'Old key', response: key2.attest(so, { origin: ORIGIN, uv: false, rk: false }) })
  t('PK second-factor-only key registers without UV', r.status === 200 && r.data.passkeys === 2 && r.data.passkey_list.find((p) => p.name === 'Old key').passwordless === false, r.data)
  r = await attemptWith((o) => key2.assert(o, { origin: ORIGIN, userHandle: handle }))
  t('PK second-factor-only key cannot sign in passwordless (uniform failure)', r.status === 400 && r.data.code === 'passkey_login_failed', r)
  const W = mk()
  const ipW = nextIp()
  r = await W.post('/api/auth/login', { email: 'pia@example.com', password: PW }, { headers: ipW })
  const tk = r.data.two_factor.ticket
  r = await W.post('/api/auth/2fa/webauthn-options', { ticket: tk }, { headers: ipW })
  r = await W.post('/api/auth/2fa/verify', { ticket: tk, method: 'webauthn', assertion: key2.assert(r.data, { origin: ORIGIN, uv: false }) }, { headers: ipW })
  t('PK second-factor-only key still works as second factor after the password', r.status === 200 && r.data.user?.email === 'pia@example.com', r)

  // --- Legacy rows (passwordless NULL) keep working
  raw.prepare('UPDATE user_webauthn SET passwordless=NULL WHERE id=?').run(dev.id)
  r = await attemptWith((o) => dev.assert(o, { origin: ORIGIN, userHandle: handle }))
  t('PK legacy passkey (unknown flag) works and is upgraded after UV login', r.status === 200 && raw.prepare('SELECT passwordless FROM user_webauthn WHERE id=?').get(dev.id).passwordless === 1, r)

  // --- Disabled user: same answer as every other failure
  raw.prepare('UPDATE users SET disabled=1 WHERE id=?').run(piaId)
  r = await attemptWith((o) => dev.assert(o, { origin: ORIGIN, userHandle: handle }))
  t('PK disabled user -> uniform failure', r.status === 400 && r.data.code === 'passkey_login_failed' && !r.data.message?.toLowerCase().includes('disabled'), r)
  raw.prepare('UPDATE users SET disabled=0 WHERE id=?').run(piaId)

  // --- Rate limit: failures per IP are counted (10 per IP+passkey, then 429), options of other IPs stay unaffected
  const ipRl = { 'X-Forwarded-For': '198.51.100.200' }
  let rl
  for (let i = 0; i < 11; i++) rl = await attemptWith(() => ({ id: 'x', rawId: 'x', type: 'public-key', response: {}, clientExtensionResults: {} }), { ip: ipRl })
  t('PK 10 failures from one IP lock passkey verify (429)', rl.status === 429 && rl.data.code === 'too_many_attempts' && !!rl.headers.get('retry-after'), rl)
  r = await attemptWith((o) => dev.assert(o, { origin: ORIGIN, userHandle: handle }), { ip: ipRl })
  t('PK the locked IP cannot sign in even with a valid passkey', r.status === 429, r.status)
  r = await attemptWith((o) => dev.assert(o, { origin: ORIGIN, userHandle: handle }))
  t('PK another IP is unaffected', r.status === 200, r.status)
  r = await mk().get('/api/auth/me')
  t('PK anonymous /me still 401', r.status === 401)

  // --- CSRF guard stays active
  r = await mk().raw('POST', '/api/auth/passkey/verify', { rawBody: '{}', ct: 'text/plain', headers: { Origin: 'https://evil.example' } })
  t('PK csrf guard rejects foreign origin', r.status === 403, r)
  r = await mk().post('/api/auth/passkey/options', {}, { headers: { Origin: 'https://evil.example' } })
  t('PK csrf guard rejects options from a foreign origin', r.status === 403 && r.data.code === 'origin_mismatch', r)

  // --- Removing the last passkey does not lock anyone out: the password (+ remaining factor) keeps working
  r = await X.get('/api/account/2fa')
  for (const p of r.data.passkey_list) { const d = await X.del('/api/account/2fa/webauthn/' + p.id, { current_password: PW }); t('PK remove passkey ' + p.name, d.status === 200, d) }
  const Q2 = mk()
  r = await Q2.post('/api/auth/login', { email: 'pia@example.com', password: PW }, { headers: nextIp() })
  t('PK after removing all passkeys the password alone signs in again (no 2FA left)', r.status === 200 && r.data.user?.email === 'pia@example.com' && !r.data.two_factor, r)
  raw.close()
}
await stop()

for (const d of [DATA, DATA + '-mod']) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${pass} passed, ${failc} failed`)
process.exit(failc ? 1 : 0)
