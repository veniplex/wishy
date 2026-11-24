// Browser check of passwordless passkey sign-in with Chrome's CDP virtual authenticator (ctap2, internal, resident key, UV).
// Not part of test:smoke (needs Chrome). Run: node scripts/tests/passkey-browser.mjs
//   CHROME=<path to chrome.exe>  PORT=<port>  PASSKEY_CWD=<folder with a built dist/> (default: the project, i.e. its dist/)
// WebAuthn rejects IP addresses as rpId, so the page is opened as http://localhost:<port> (a secure context) in a throwaway profile.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.PORT) || 3642
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CWD = process.env.PASSKEY_CWD || ROOT
const BASE = `http://localhost:${PORT}`
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-pkb-data-'))
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-pkb-prof-'))
const PW = 'Passw0rd-long-' + Math.random().toString(36).slice(2, 8)

let pass = 0, failc = 0
const t = (name, cond, info) => { if (cond) pass++; else { failc++; console.log('FAIL:', name, info !== undefined ? JSON.stringify(info)?.slice(0, 300) : '') } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn('node', [path.join(ROOT, 'server/index.js')], { cwd: CWD, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT) } })
await new Promise((resolve, reject) => {
  let out = ''
  server.stdout.on('data', (d) => { out += d; if (out.includes('running')) resolve() })
  server.on('exit', (c) => reject(new Error('server exit ' + c)))
})
const api = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
await api('/api/auth/setup', { name: 'Admin', email: 'admin@example.com', password: PW })

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: PROFILE, args: ['--no-sandbox', '--lang=en-US'] })
const page = await browser.newPage()
const problems = []
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()) })
const cdp = await page.createCDPSession()
await cdp.send('WebAuthn.enable')
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
})

const setLocale = async (l) => { await page.evaluateOnNewDocument((x) => { try { localStorage.setItem('locale', x) } catch {} }, l) }
const clickText = async (re) => {
  const ok = await page.evaluate((src) => {
    const rx = new RegExp(src, 'i')
    const b = [...document.querySelectorAll('button,a')].find((e) => rx.test(e.textContent || '') && !e.disabled)
    if (b) { b.click(); return true }
    return false
  }, re.source)
  return ok
}
const clearSession = async () => {
  try { await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'x' } })) } catch { /* no page yet */ }
  const cs = await page.cookies(BASE)
  if (cs.length) await page.deleteCookie(...cs)
}
const L = {
  de: { button: /Mit Passkey anmelden/, setup: /Passkey einrichten/, next: /^Weiter$/, saved: /Ich habe die Codes gespeichert/ },
  en: { button: /Sign in with a passkey/, setup: /Set up a passkey/, next: /^Continue$/, saved: /I have saved these codes/ },
}

// ---- 1. Register a passkey through the UI (English, desktop) ----
await page.setViewport({ width: 1280, height: 800 })
await setLocale('en')
await page.goto(BASE + '/login', { waitUntil: 'networkidle0' })
await page.type('input[type=email]', 'admin@example.com')
await page.type('input[type=password]', PW)
await clickText(/^Sign in$/)
await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 10000 })
await page.goto(BASE + '/settings/account', { waitUntil: 'networkidle0' })
t('settings offers "Set up a passkey" prominently', await clickText(L.en.setup))
await page.waitForSelector('input[maxlength="60"]')
t('add dialog offers the second-factor-only option', (await page.evaluate(() => document.body.innerText)).includes('Use only as a second factor'))
await clickText(L.en.next)
await page.waitForFunction(() => document.body.innerText.includes('I have saved these codes'), { timeout: 10000 })
await clickText(L.en.saved)
await sleep(300)
const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
t('virtual authenticator holds one resident credential with user handle', creds.credentials.length === 1 && creds.credentials[0].isResidentCredential === true && !!creds.credentials[0].userHandle, creds.credentials.map((c) => ({ rk: c.isResidentCredential })))
await sleep(300)
t('settings list marks the passkey as usable without a password', (await page.evaluate(() => document.body.innerText)).includes('works without a password'))
await clearSession()

// ---- 2. Sign in with the passkey: viewports x languages x (conditional UI | button only) ----
const viewports = { desktop: { width: 1280, height: 800 }, phone: { width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } }
for (const lang of ['de', 'en']) {
  for (const [vname, vp] of Object.entries(viewports)) {
    for (const conditional of [true, false]) {
      const label = `${lang}/${vname}/${conditional ? 'conditional-UI' : 'no-conditional-UI'}`
      problems.length = 0
      await clearSession()
      await page.setViewport(vp)
      await setLocale(lang)
      if (!conditional) await page.evaluateOnNewDocument(() => { if (window.PublicKeyCredential) window.PublicKeyCredential.isConditionalMediationAvailable = async () => false })
      await page.goto(BASE + '/login', { waitUntil: 'networkidle0' })
      await sleep(600)
      if (!new URL(page.url()).pathname.startsWith('/login')) {
        // Chrome's virtual authenticator answers the pending conditional (autofill) request by itself: that IS the passwordless sign-in
        const me0 = await page.evaluate(() => fetch('/api/auth/me').then((r) => r.json()))
        t(`${label}: conditional UI signed in without any click`, conditional && me0?.user?.email === 'admin@example.com', { path: page.url(), conditional })
        t(`${label}: no unhandled errors / AbortError in the console`, problems.filter((p) => !/Failed to load resource|favicon|manifest/i.test(p)).length === 0, problems)
        continue
      }
      const info = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /passkey/i.test(x.textContent || ''))
        const r = b?.getBoundingClientRect()
        const em = document.querySelector('input[type=email]')
        return { has: !!b, h: r ? Math.round(r.height) : 0, w: r ? Math.round(r.width) : 0, ac: em?.getAttribute('autocomplete'), overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }
      })
      t(`${label}: passkey button present, >= 44 px tall, no horizontal scroll`, info.has && info.h >= 44 && !info.overflow, { ...info, url: page.url(), text: await page.evaluate(() => document.body.innerText.slice(0, 150)) })
      t(`${label}: e-mail field announces webauthn autofill`, info.ac === 'username webauthn', info)
      const pending = await page.evaluate(() => typeof window.PublicKeyCredential === 'function')
      t(`${label}: WebAuthn available in this context`, pending)
      // Use the button (aborts a pending conditional ceremony first)
      t(`${label}: click the button`, await clickText(L[lang].button))
      let ok = true
      try { await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 10000 }) } catch { ok = false }
      t(`${label}: signed in with the passkey alone`, ok, await page.evaluate(() => ({ path: location.pathname, text: document.body.innerText.slice(0, 200) })))
      const me = await page.evaluate(() => fetch('/api/auth/me').then((r) => r.json()))
      t(`${label}: session belongs to the passkey owner`, me?.user?.email === 'admin@example.com', me)
      const real = problems.filter((p) => !/Failed to load resource|favicon|manifest/i.test(p))
      t(`${label}: no unhandled errors / AbortError in the console`, real.length === 0, real)
    }
  }
}

// ---- 3. Unmount/abort hygiene: leave the page with a pending ceremony, come back, use password path ----
problems.length = 0
await clearSession()
await page.setViewport(viewports.desktop)
await setLocale('en')
await page.goto(BASE + '/login', { waitUntil: 'networkidle0' })
await sleep(300)
await clickText(/Register|invitation/i) // SPA navigation away (no-op if registration is closed)
await page.goto(BASE + '/login', { waitUntil: 'networkidle0' })
await page.type('input[type=email]', 'admin@example.com')
await page.type('input[type=password]', 'wrong-password-1')
await clickText(/^Sign in$/)
await sleep(800)
const txt = await page.evaluate(() => document.body.innerText)
t('password path still works and shows its own error (passkey ceremony aborted before submit)', /Incorrect email or password/i.test(txt), txt.slice(0, 200))
t('no console errors after abort / retry', problems.filter((p) => !/Failed to load resource|401/i.test(p)).length === 0, problems)
// Cancelled passkey dialog: remove the credential from the authenticator -> unknown passkey is explained, not a crash
await cdp.send('WebAuthn.clearCredentials', { authenticatorId })
await page.reload({ waitUntil: 'networkidle0' })
await clickText(L.en.button)
await sleep(1500)
const txt2 = await page.evaluate(() => document.body.innerText)
t('no usable passkey -> readable message instead of an error page', /cancelled|did not work|expired/i.test(txt2) || /Sign in with a passkey/.test(txt2), txt2.slice(0, 200))

await browser.close()
server.kill()
for (const d of [DATA, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* locked profile files */ } }
console.log(`\n${pass} passed, ${failc} failed`)
process.exit(failc ? 1 : 0)
