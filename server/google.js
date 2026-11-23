import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { db } from './db.js'
import { getSys, getSecretSys, baseUrl, sessionSecret, googleEnabled } from './config.js'
import { isFresh, markFresh } from './session.js'
import { createUser, registrationGate, redeemInvite } from './auth.js'
import { beginLogin, setTicketCookie } from './twofactor-routes.js'
import { has2fa } from './twofactor.js'
import { fetchIdpAvatar } from './avatars.js'
import { audit } from './audit.js'
import { parseCookies, setCookie, clearCookie } from './util.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const OAUTH_COOKIE = 'wl_oauth'
const COOKIE_PATH = '/api/auth/google'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (data) => createHmac('sha256', sessionSecret()).update(data).digest('base64url')
function seal(payload) {
  const body = b64(payload)
  return `${body}.${sign(body)}`
}
function unseal(value) {
  const [body, mac] = String(value || '').split('.')
  if (!body || !mac) return null
  const a = Buffer.from(mac)
  const b = Buffer.from(sign(body))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString())
    return p.exp > Date.now() ? p : null
  } catch {
    return null
  }
}

const redirectUri = (req) => `${baseUrl(req)}/api/auth/google/callback`
const SETTINGS_URL = '/settings/account'
const fail = (res, req, code, link = false) => {
  clearCookie(res, req, OAUTH_COOKIE, COOKIE_PATH)
  res.redirect(`${link ? SETTINGS_URL : '/login'}?error=${code}`)
}
const disabled = (res) => res.status(404).json({ error: 'Sign-in with Google is not enabled', code: 'google_disabled' })

export function googleRoutes(app) {
  app.get('/api/auth/google/start', (req, res) => {
    if (!googleEnabled()) return disabled(res)
    const wantsLink = !!req.query.link
    // Re-confirmation via Google (for accounts without password/2FA): only marks the existing session as "fresh" again
    const wantsReauth = !wantsLink && !!req.query.reauth
    if ((wantsLink || wantsReauth) && !req.user) return res.redirect('/login')
    if (wantsLink && !isFresh(req)) return res.redirect(`${SETTINGS_URL}?error=reauth_required`)
    const state = randomBytes(24).toString('base64url')
    const nonce = randomBytes(24).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const link = wantsLink ? req.user.id : null
    const reauth = wantsReauth ? req.user.id : null
    setCookie(
      res, req, OAUTH_COOKIE,
      seal({ state, nonce, verifier, invite: req.query.invite ? String(req.query.invite).slice(0, 200) : null, link, reauth, exp: Date.now() + 10 * 60_000 }),
      { maxAge: 600, path: COOKIE_PATH },
    )
    const q = new URLSearchParams({
      client_id: getSys('google_client_id'),
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })
    res.redirect(`${AUTH_URL}?${q}`)
  })

  app.get('/api/auth/google/callback', async (req, res) => {
    try {
      if (!googleEnabled()) return disabled(res)
      const saved = unseal(parseCookies(req.headers.cookie)[OAUTH_COOKIE])
      const isLink = !!saved?.link || !!saved?.reauth
      if (req.query.error) return fail(res, req, 'google_cancelled', isLink)
      if (!saved || !req.query.state || req.query.state !== saved.state || !req.query.code) return fail(res, req, 'google_error', isLink)

      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: getSys('google_client_id'),
          client_secret: getSecretSys('google_client_secret'),
          redirect_uri: redirectUri(req),
          grant_type: 'authorization_code',
          code_verifier: saved.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const tokens = await tokenRes.json().catch(() => ({}))
      if (!tokenRes.ok || !tokens.id_token) return fail(res, req, 'google_error', isLink)

      const { payload } = await jwtVerify(tokens.id_token, JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: getSys('google_client_id'),
      })
      if (payload.nonce !== saved.nonce) return fail(res, req, 'google_error', isLink)
      if (!payload.email || payload.email_verified !== true) return fail(res, req, 'email_not_verified', isLink)
      const sub = String(payload.sub)
      const email = String(payload.email)
      const name = String(payload.name || email.split('@')[0]).slice(0, 80)

      // Re-confirmation: the same Google account as the linked one, otherwise do nothing
      if (saved.reauth) {
        clearCookie(res, req, OAUTH_COOKIE, COOKIE_PATH)
        if (!req.user || req.user.id !== saved.reauth) return fail(res, req, 'session_expired', true)
        if (!req.user.google_sub || req.user.google_sub !== sub) {
          audit(req, 'account.reauth', { status: 'fail', target: { type: 'user', id: req.user.id, label: req.user.email }, details: { via: 'google', reason: 'sub_mismatch' } })
          return fail(res, req, 'google_wrong_account', true)
        }
        markFresh(req)
        audit(req, 'account.reauth', { target: { type: 'user', id: req.user.id, label: req.user.email }, details: { via: 'google' } })
        return res.redirect(`${SETTINGS_URL}?reauthed=1`)
      }

      // Account linking from the settings (requires the user session and fresh confirmation)
      if (saved.link) {
        if (!req.user || req.user.id !== saved.link) return fail(res, req, 'session_expired', true)
        const taken = db.prepare('SELECT id FROM users WHERE google_sub=? AND id!=?').get(sub, saved.link)
        if (taken) return fail(res, req, 'google_already_linked', true)
        db.prepare('UPDATE users SET google_sub=?, google_email=? WHERE id=?').run(sub, email, saved.link)
        audit(req, 'account.identity.link', { target: { type: 'user', id: saved.link, label: req.user.email }, details: { provider: 'google' } })
        if (payload.picture) void fetchIdpAvatar(saved.link, payload.picture)
        clearCookie(res, req, OAUTH_COOKIE, COOKIE_PATH)
        return res.redirect(`${SETTINGS_URL}?linked=google`)
      }

      let user = db.prepare('SELECT * FROM users WHERE google_sub=?').get(sub)
      if (!user) {
        const byEmail = db.prepare('SELECT * FROM users WHERE email=?').get(email)
        if (byEmail) {
          // Link automatically ONLY if the account has no credentials at all yet (created/invited by an admin, no password,
          // no Google, no 2FA). Otherwise someone could create an account with a foreign email and their own password beforehand and
          // piggyback on the victim's later Google login ("pre-hijack"). An existing google_sub is never overwritten.
          if (byEmail.password_hash || byEmail.google_sub || has2fa(byEmail.id)) {
            audit(req, 'auth.login', { status: 'fail', target: { type: 'user', id: byEmail.id, label: byEmail.email }, details: { email, via: 'google', reason: 'account_exists_not_linked' } })
            return fail(res, req, 'account_exists')
          }
          db.prepare('UPDATE users SET google_sub=?, google_email=? WHERE id=?').run(sub, email, byEmail.id)
          db.prepare('DELETE FROM user_invites WHERE user_id=?').run(byEmail.id) // account is claimed: setup link expires
          user = { ...byEmail, google_sub: sub, google_email: email }
        }
      }
      if (!user) {
        const gate = registrationGate(saved.invite)
        if (!gate.allowed) {
          audit(req, 'auth.login', { status: 'fail', details: { email, via: 'google', reason: 'registration_closed' } })
          return fail(res, req, 'registration_closed')
        }
        user = createUser({ name, email, googleSub: sub, googleEmail: email })
        redeemInvite(gate, user.id)
      }
      if (user.disabled) return fail(res, req, 'account_disabled')
      if (user.google_email !== email) db.prepare('UPDATE users SET google_email=? WHERE id=?').run(email, user.id)
      if (payload.picture) void fetchIdpAvatar(user.id, payload.picture)
      clearCookie(res, req, OAUTH_COOKIE, COOKIE_PATH)
      const r = beginLogin(req, res, user, 'google')
      if (!r.session) {
        // Ticket not in the URL (history, referer, logs) but in a short-lived HttpOnly cookie; the page fetches it via POST /api/auth/2fa/pending
        setTicketCookie(res, req, r.ticket)
        return res.redirect('/login?2fa=1')
      }
      audit(req, 'auth.login', { target: { type: 'user', id: user.id, label: user.email }, details: { via: 'google' } })
      res.redirect('/')
    } catch (e) {
      console.error('Google-Login fehlgeschlagen:', e?.message || e)
      fail(res, req, 'google_error')
    }
  })
}
