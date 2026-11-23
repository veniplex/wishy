// Optional headless browser (puppeteer-core) for pages that build their content with JavaScript.
// Honest browsing: standard Chrome fingerprint, no disguise, no bypassing of bot protection.
// If no browser is available or startup fails, renderPage() simply returns null (the fallback is skipped).
import fs from 'node:fs'

const NAV_TIMEOUT = 20_000
const IDLE_WAIT = 4_000
const MAX_PAGES = 2
const IDLE_CLOSE_MS = 2 * 60_000
const MAX_HTML = 3 * 1024 * 1024
const BLOCKED_TYPES = new Set(['media', 'font', 'image', 'websocket', 'eventsource', 'manifest'])

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
  ],
}

export function findBrowser() {
  const env = process.env.CHROME_PATH
  if (env && fs.existsSync(env)) return env
  return (CANDIDATES[process.platform] ?? CANDIDATES.linux).find((p) => fs.existsSync(p)) ?? null
}

let disabled = process.env.PREVIEW_BROWSER === 'off'
let browserPromise = null
let browser = null
let active = 0
let idleTimer = null
const waiters = []
let signalsBound = false

const warnOnce = (() => {
  let done = false
  return (msg) => {
    if (done) return
    done = true
    console.warn(`[preview] ${msg}`)
  }
})()

export const browserAvailable = () => !disabled && !!findBrowser()

async function launch() {
  const executablePath = findBrowser()
  if (!executablePath) {
    disabled = true
    warnOnce('No Chrome/Chromium found (set CHROME_PATH) – the browser fallback of the link preview is off.')
    return null
  }
  try {
    const { default: puppeteer } = await import('puppeteer-core')
    const args = ['--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--mute-audio', '--disable-extensions']
    // Only in the container (the Dockerfile sets the flag): Chromium's sandbox needs user namespaces there,
    // which are not available in standard containers. The container itself is the isolation.
    if (process.env.PREVIEW_BROWSER_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox')
    const b = await puppeteer.launch({
      executablePath,
      headless: true,
      args,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    })
    b.on('disconnected', () => {
      if (browser === b) {
        browser = null
        browserPromise = null
      }
    })
    browser = b
    bindSignals()
    return b
  } catch (e) {
    disabled = true
    warnOnce(`Browser start failed (${e.message?.split('\n')[0]}) – the browser fallback of the link preview is off.`)
    return null
  }
}

function getBrowser() {
  if (!browserPromise) browserPromise = launch()
  return browserPromise
}

export async function closeBrowser() {
  clearTimeout(idleTimer)
  const p = browserPromise
  browserPromise = null
  browser = null
  const b = await p?.catch(() => null)
  if (b) await b.close().catch(() => b.process()?.kill('SIGKILL'))
}

function bindSignals() {
  if (signalsBound) return
  signalsBound = true
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await closeBrowser()
      // A custom handler suppresses the default behaviour – exit if nobody else is responsible.
      if (process.listenerCount(sig) <= 1) process.exit(0)
    })
  }
  process.on('exit', () => {
    try {
      browser?.process()?.kill('SIGKILL')
    } catch {}
  })
}

async function acquire() {
  if (active >= MAX_PAGES) await new Promise((r) => waiters.push(r))
  else active++
  clearTimeout(idleTimer)
}

function release() {
  const next = waiters.shift()
  if (next) return next() // slot is handed over directly
  active--
  if (active === 0) {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => closeBrowser(), IDLE_CLOSE_MS)
    idleTimer.unref?.()
  }
}

/**
 * Loads url in the headless browser and returns { html, url, status } or null.
 * checkUrl(URL) must throw for disallowed (private/internal) targets.
 */
export async function renderPage(startUrl, checkUrl) {
  if (disabled) return null
  await acquire()
  let context = null
  try {
    const b = await getBrowser()
    if (!b) return null
    context = await b.createBrowserContext()
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(NAV_TIMEOUT)
    page.on('dialog', (d) => d.dismiss().catch(() => {}))
    page.on('popup', (p) => p.close().catch(() => {}))
    const cdp = await page.createCDPSession()
    await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {})

    // Cache host decisions per page load (subresources often repeat hosts).
    const verdicts = new Map()
    const hostAllowed = (u) => {
      const key = u.protocol + '//' + u.host
      if (!verdicts.has(key)) {
        verdicts.set(
          key,
          checkUrl(u).then(
            () => true,
            () => false,
          ),
        )
      }
      return verdicts.get(key)
    }
    await page.setRequestInterception(true)
    page.on('request', async (req) => {
      try {
        if (req.isInterceptResolutionHandled()) return
        const rt = req.resourceType()
        if (BLOCKED_TYPES.has(rt)) return await req.abort('blockedbyclient')
        let u
        try {
          u = new URL(req.url())
        } catch {
          return await req.abort('blockedbyclient')
        }
        if (u.protocol === 'data:' || u.protocol === 'blob:') return await req.continue()
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return await req.abort('blockedbyclient')
        if (!(await hostAllowed(u))) return await req.abort('blockedbyclient')
        await req.continue()
      } catch {
        /* page already closed */
      }
    })

    const resp = await page.goto(startUrl.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    const type = resp?.headers()['content-type'] || ''
    if (type && !/html|xml/i.test(type)) return null
    await page.waitForNetworkIdle({ idleTime: 500, timeout: IDLE_WAIT }).catch(() => {})
    let html = await page.content()
    if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML)
    return { html, url: new URL(page.url()), status: resp?.status() ?? 200 }
  } catch {
    return null
  } finally {
    await context?.close().catch(() => {})
    release()
  }
}
