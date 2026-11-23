import dns from 'node:dns/promises'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as cheerio from 'cheerio'
import { renderPage } from './browser.js'

const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
export const IMAGES_DIR = path.join(DATA_DIR, 'images')
fs.mkdirSync(IMAGES_DIR, { recursive: true })

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAX_HTML = 3 * 1024 * 1024
const MAX_IMAGE = 5 * 1024 * 1024
const MAX_HOPS = 5
const TIMEOUT = 10_000

const fail = (msg, code) => Object.assign(new Error(msg), { userFacing: true, code })
const fatal = (msg, code) => Object.assign(fail(msg, code), { fatal: true }) // a browser fallback makes no sense

// ---------- SSRF protection ----------
function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224
  )
}
function isPrivateV6(ip) {
  const l = ip.toLowerCase().split('%')[0]
  if (l === '::' || l === '::1') return true
  const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateV4(mapped[1])
  const mappedHex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const n = (parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16)
    return isPrivateV4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'))
  }
  const first = parseInt(l.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}
const isPrivateIp = (ip) => (net.isIPv4(ip) ? isPrivateV4(ip) : net.isIPv6(ip) ? isPrivateV6(ip) : true)

async function assertPublic(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fatal('Invalid link', 'link_invalid')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw fatal('This link is not allowed', 'link_not_allowed')
  let addrs
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
  } catch {
    throw fatal('Page could not be found', 'page_not_found')
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw fatal('This link is not allowed', 'link_not_allowed')
}

/** fetch with manual redirect handling and SSRF check at every hop. */
async function safeFetch(startUrl, headers) {
  let url = new URL(startUrl)
  const signal = AbortSignal.timeout(TIMEOUT)
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertPublic(url)
    const res = await fetch(url, { headers, redirect: 'manual', signal })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {})
      try {
        url = new URL(res.headers.get('location'), url)
      } catch {
        throw fail('Invalid link', 'link_invalid')
      }
      continue
    }
    return { res, url }
  }
  throw fatal('Zu viele Weiterleitungen', 'too_many_redirects')
}

async function readLimited(res, max) {
  const chunks = []
  let size = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      if (max === MAX_IMAGE) {
        await reader.cancel().catch(() => {})
        return null // image too large
      }
      chunks.push(value.subarray(0, value.length - (size - max)))
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function decodeHtml(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1]
  if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1]
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf)
  } catch {
    return buf.toString('utf8')
  }
}

// ---------- Normalise values ----------
export function parsePrice(v) {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  const m = String(v).match(/\d[\d.,\s'’ ]*/)
  if (!m) return null
  let s = m[0].replace(/[\s'’ ]/g, '').replace(/[.,]+$/, '')
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ','
    const thou = dec === '.' ? ',' : '.'
    s = s.split(thou).join('').replace(dec, '.')
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ','
    const parts = s.split(sep)
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0] !== '0')) s = parts.join('')
    else s = parts.join('.')
  }
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function parseCurrency(v) {
  if (!v) return null
  const s = String(v).trim()
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase()
  if (s.includes('€')) return 'EUR'
  if (s.includes('£')) return 'GBP'
  if (s.includes('$')) return 'USD'
  const code = s.match(/\b(EUR|USD|GBP|CHF)\b/i)
  return code ? code[1].toUpperCase() : null
}

const clean = (v) => {
  if (v == null) return null
  let s = String(v)
  if (/&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(s)) s = cheerio.load(`<i>${s}</i>`).text() // e.g. &quot; in JSON-LD
  s = s.replace(/\s+/g, ' ').trim()
  return s || null
}

function textOf(v) {
  if (v == null) return null
  if (typeof v === 'string' || typeof v === 'number') return clean(v)
  if (Array.isArray(v)) return textOf(v[0])
  if (typeof v === 'object') return clean(v.name ?? null)
  return null
}

function imageOf(v) {
  if (!v) return null
  if (typeof v === 'string') return v.trim() || null
  if (Array.isArray(v)) return imageOf(v[0])
  if (typeof v === 'object') return imageOf(v.url ?? v.contentUrl ?? v['@id'])
  return null
}

// ---------- JSON-LD ----------
function collectNodes(data, out = []) {
  if (Array.isArray(data)) data.forEach((d) => collectNodes(d, out))
  else if (data && typeof data === 'object') {
    out.push(data)
    if (data['@graph']) collectNodes(data['@graph'], out)
  }
  return out
}
const isType = (n, t) => [].concat(n['@type'] ?? []).some((x) => String(x).replace(/^.*[/#]/, '') === t)

function offerInfo(offers) {
  const list = collectNodes(offers).flatMap((o) => (o.offers ? collectNodes(o.offers) : [o]))
  for (const o of list) {
    const price = parsePrice(o.price ?? o.lowPrice ?? o.priceSpecification?.price)
    const currency = parseCurrency(o.priceCurrency ?? o.priceSpecification?.priceCurrency)
    if (price != null || currency) return { price, currency }
  }
  return { price: null, currency: null }
}

function fromJsonLd($) {
  let product = null
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return
    let data
    try {
      data = JSON.parse($(el).contents().text().trim())
    } catch {
      return
    }
    product = collectNodes(data).find((n) => isType(n, 'Product') || isType(n, 'ProductGroup')) || null
  })
  if (!product) return {}
  let { price, currency } = offerInfo(product.offers)
  if (price == null && product.hasVariant) ({ price, currency } = offerInfo(collectNodes(product.hasVariant).map((v) => v.offers).filter(Boolean)))
  return {
    title: textOf(product.name),
    description: textOf(product.description),
    image: imageOf(product.image),
    price,
    currency,
    brand: textOf(product.brand),
  }
}

// ---------- Meta ----------
function fromMeta($) {
  const meta = (...keys) => {
    for (const k of keys) {
      const v = clean(
        $(`meta[property="${k}"]`).attr('content') ??
          $(`meta[name="${k}"]`).attr('content') ??
          $(`meta[itemprop="${k}"]`).attr('content'),
      )
      if (v) return v
    }
    return null
  }
  const itemprop = (name) => {
    const el = $(`[itemprop="${name}"]`).first()
    return clean(el.attr('content') ?? el.text())
  }
  return {
    title: meta('og:title', 'twitter:title') || clean($('title').first().text()),
    description: meta('og:description', 'twitter:description', 'description'),
    image: meta('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
    site: meta('og:site_name', 'application-name'),
    price: parsePrice(
      meta('product:price:amount', 'og:price:amount', 'twitter:data1') ?? itemprop('price'),
    ),
    currency: parseCurrency(
      meta('product:price:currency', 'og:price:currency') ?? itemprop('priceCurrency'),
    ),
  }
}

/** Removes an appended " – site name" (also " — ", " - ", " | ", " : ") from the title. */
export function stripSiteSuffix(title, site, hostname) {
  if (!title) return title
  const m = /^(.*\S)\s+(?:[–—|:-])\s+([^–—|:]+?)\s*$/.exec(title)
  if (!m || m[1].trim().length < 3) return title
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const suffix = norm(m[2])
  if (suffix.length < 2) return title
  const labels = String(hostname ?? '').toLowerCase().replace(/^www\./, '').split('.').slice(0, -1).filter((l) => l.length >= 3).map(norm)
  const cands = [norm(site), norm(hostname?.replace(/^www\./, '')), ...labels].filter((c) => c.length >= 2)
  const hit = cands.some((c) => c === suffix || (suffix.length >= 3 && (c.includes(suffix) || suffix.includes(c))))
  return hit ? m[1].trim() : title
}

// Shop-specific selectors for pages without usable JSON-LD/OpenGraph (last-resort source only).
function fromSite($, hostname) {
  if (/(^|\.)amazon\.[a-z.]+$/.test(hostname)) {
    const img = $('#landingImage, #imgBlkFront').first()
    let image = img.attr('data-old-hires') || null
    if (!image) {
      try {
        image = Object.keys(JSON.parse(img.attr('data-a-dynamic-image') || '{}'))[0] || null
      } catch {}
    }
    const priceText = $('#corePrice_feature_div .a-offscreen, .priceToPay .a-offscreen, .a-price .a-offscreen').first().text()
    return {
      title: clean($('#productTitle').first().text()),
      image: image || img.attr('src') || null,
      price: parsePrice(priceText),
      currency: parseCurrency(priceText),
    }
  }
  return {}
}

export async function extract(html, finalUrl) {
  const $ = cheerio.load(html)
  const ld = fromJsonLd($)
  const m = fromMeta($)
  const site = fromSite($, finalUrl.hostname)
  if (site.title) m.title = site.title // more specific than <title>
  m.image = m.image ?? site.image ?? null
  m.price = m.price ?? site.price ?? null
  m.currency = m.currency ?? site.currency ?? null
  const pick = (a, b) => a ?? b ?? null
  let image = pick(ld.image, m.image)
  if (image) {
    try {
      image = new URL(image, finalUrl).href
    } catch {
      image = null
    }
  }
  const price = pick(ld.price, m.price)
  let description = pick(ld.description, m.description)
  if (description && description.length > 500) description = description.slice(0, 499).trimEnd() + '…'
  return {
    url: finalUrl.href,
    title: stripSiteSuffix(pick(ld.title, m.title), m.site, finalUrl.hostname),
    description,
    image,
    price,
    // currency only if a price is present
    currency: price != null ? pick(ld.currency, m.currency) : null,
    shop: m.site || finalUrl.hostname.replace(/^www\./, ''),
  }
}

// ---------- Store image ----------
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' }

export async function storeImage(imageUrl, referer) {
  try {
    const hash = createHash('sha1').update(imageUrl).digest('hex')
    const existing = fs.readdirSync(IMAGES_DIR).find((f) => f.startsWith(hash + '.'))
    if (existing) return `/api/images/${existing}`
    const { res } = await safeFetch(imageUrl, { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', Referer: referer })
    if (!res.ok) return null
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const ext = EXT[type]
    if (!ext) return null
    const len = Number(res.headers.get('content-length'))
    if (len > MAX_IMAGE) return null
    const buf = await readLimited(res, MAX_IMAGE)
    if (!buf || !buf.length) return null
    const file = `${hash}.${ext}`
    fs.writeFileSync(path.join(IMAGES_DIR, file), buf)
    return `/api/images/${file}`
  } catch {
    return null
  }
}

// ---------- Detect challenge/block pages ----------
const CHALLENGE_RE = new RegExp(
  [
    'just a moment', 'attention required', 'access denied', 'access to this page has been denied',
    'pardon our interruption', 'are you a (?:human|robot)', 'verify you are (?:a )?human', 'robot check',
    'captcha', 'unusual traffic', 'bot detection', 'checking your browser', 'security check',
    // German phrases (intentional: detects challenge pages served in German)
    'zugriff verweigert', 'zugriff auf diese seite', 'kein roboter', 'sind sie ein roboter',
    'bot-erkennung', 'sicherheitsüberprüfung', 'ungewöhnlicher datenverkehr', 'anfrage blockiert',
  ].join('|'),
  'i',
)

/** Heuristic: title or (short) visible text of a challenge/captcha/access-denied page. */
export function looksLikeChallenge(html) {
  const $ = cheerio.load(html)
  const title = clean($('title').first().text()) || ''
  if (CHALLENGE_RE.test(title)) return true
  $('script,style,noscript').remove()
  const text = clean($('body').text()) || ''
  return text.length < 2500 && CHALLENGE_RE.test(text)
}

const score = (d) => (d.title ? 2 : 0) + (d.image ? 1 : 0) + (d.price != null ? 1 : 0) + (d.description ? 0.5 : 0)
const usable = (d) => !!d.title && (!!d.image || d.price != null)

/** Shared pipeline: retrieval (fetch → headless browser) + extraction. Returns { data, html, finalUrl } or throws. */
async function gather(rawUrl) {
  let start
  try {
    let s = String(rawUrl ?? '').trim()
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s
    start = new URL(s)
  } catch {
    throw fail('Invalid link', 'link_invalid')
  }
  if (start.protocol !== 'http:' && start.protocol !== 'https:') throw fail('Invalid link', 'link_invalid')

  // 1) fast retrieval without a browser
  let data = null
  let html = null
  let plainError = null
  try {
    ;({ data, html } = await plainPreview(start))
  } catch (e) {
    if (e.fatal || (e.userFacing && e.notWebpage)) throw e
    plainError = e.userFacing ? e : fail('Page could not be loaded', 'page_load_failed')
  }

  // 2) Fallback: render the page in the headless browser and run the same extraction
  let blocked = !!data?.blocked || !!plainError?.blocked
  if (!data || !usable(data)) {
    const r = await renderPage(start, assertPublic)
    if (r && /^https?:$/.test(r.url.protocol)) {
      if ([401, 403, 429, 503].includes(r.status) || looksLikeChallenge(r.html)) blocked = true
      else if (r.status >= 400) { /* normal error page, e.g. 404 */ }
      else {
        const rd = await extract(r.html, r.url)
        if (!data || score(rd) > score(data)) {
          data = rd
          html = r.html
        }
      }
    }
  }

  if (!data || (!data.title && data.image == null && data.price == null)) {
    if (blocked) throw fail('Der Shop blockiert automatische Abrufe – bitte Daten manuell eintragen.', 'shop_blocked')
    throw plainError ?? fail('No product data was found on the page', 'no_product_data')
  }
  return { data, html, finalUrl: new URL(data.url) }
}

export async function preview(rawUrl) {
  const { data } = await gather(rawUrl)
  const { blocked: _b, image, ...rest } = data
  const image_url = image ? await storeImage(image, rest.url) : null
  return { ...rest, image_url }
}

// ---------- For the AI features: cleaned visible text + image candidates ----------
const AI_TEXT_MAX = 12_000
const AI_LD_MAX = 4_000
const IMG_SKIP_RE = /(sprite|logo|icon|favicon|pixel|spacer|blank|placeholder|tracking|badge|flag|payment|avatar)/i

/** Reduces a JSON-LD node to compact JSON (long texts truncated). */
function compactJson(node) {
  const s = JSON.stringify(node, (k, v) => (typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + '…' : v))
  return s.length > AI_LD_MAX ? s.slice(0, AI_LD_MAX) + '…' : s
}

/**
 * Analyses HTML for the language model: visible text (without scripts/navigation), JSON-LD product data,
 * relevant meta tags and image candidates (absolute http(s) URLs, at most 12).
 */
export function pageForModel(html, finalUrl) {
  const $ = cheerio.load(html)

  // JSON-LD (product/offer nodes)
  const jsonld = []
  const ldImages = []
  $('script[type="application/ld+json"]').each((_, el) => {
    let data
    try {
      data = JSON.parse($(el).contents().text().trim())
    } catch {
      return
    }
    for (const n of collectNodes(data)) {
      if (isType(n, 'Product') || isType(n, 'ProductGroup') || isType(n, 'Offer')) {
        if (jsonld.length < 3) jsonld.push(compactJson(n))
        for (const i of [].concat(n.image ?? [])) {
          const u = imageOf(i)
          if (u) ldImages.push(u)
        }
      }
    }
  })

  // Meta
  const meta = []
  const metaImages = []
  $('meta').each((_, el) => {
    const key = $(el).attr('property') || $(el).attr('name') || $(el).attr('itemprop')
    const val = clean($(el).attr('content'))
    if (!key || !val || !/^(og:|twitter:|product:|description$|price|brand|sku|gtin|availability|itemprop)/i.test(key)) return
    if (/image/i.test(key)) metaImages.push(val)
    else if (meta.length < 40) meta.push(`${key}: ${val.length > 300 ? val.slice(0, 300) + '…' : val}`)
  })
  const linkImg = $('link[rel="image_src"]').attr('href')

  // Image candidates
  const seen = new Set()
  const images = []
  const addImage = (u) => {
    if (!u || images.length >= 12) return
    try {
      const a = new URL(String(u).trim(), finalUrl)
      if (!/^https?:$/.test(a.protocol) || /\.svg$/i.test(a.pathname) || IMG_SKIP_RE.test(a.pathname)) return
      if (seen.has(a.href)) return
      seen.add(a.href)
      images.push(a.href)
    } catch {
      /* ignore */
    }
  }
  ldImages.forEach(addImage)
  metaImages.forEach(addImage)
  addImage(linkImg)
  $('img').each((_, el) => {
    const w = Number($(el).attr('width'))
    const h = Number($(el).attr('height'))
    if ((w && w < 120) || (h && h < 120)) return
    const srcset = $(el).attr('srcset') || $(el).attr('data-srcset')
    const biggest = srcset ? srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop() : null
    addImage($(el).attr('data-old-hires') || $(el).attr('data-zoom-image') || biggest || $(el).attr('data-src') || $(el).attr('src'))
  })

  // Visible text
  $('script,style,noscript,svg,iframe,template,canvas,select,option,input,button,nav,footer,[hidden],[aria-hidden="true"]').remove()
  const mainEl = $('main, [role="main"], #main, #content').filter((_, el) => $(el).text().length >= 400).first()
  const root = mainEl.length ? mainEl : $('body')
  root.find('p,div,li,ul,ol,tr,table,section,article,h1,h2,h3,h4,h5,h6,br,dt,dd,dl,header').each((_, el) => {
    $(el).append('\n')
  })
  let last = null
  const lines = []
  for (const raw of root.text().split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').trim()
    if (!l || l === last) continue
    last = l
    lines.push(l)
  }
  let text = ''
  for (const l of lines) {
    if (text.length + l.length + 1 > AI_TEXT_MAX) break
    text += (text ? '\n' : '') + l
  }
  return { text, jsonld, meta, images, title: clean($('title').first().text()) }
}

/** Loads a product page (same SSRF rules/pipeline as preview) and returns structured data + text for the AI. */
export async function pageForAi(rawUrl) {
  const { data, html, finalUrl } = await gather(rawUrl)
  const { blocked: _b, image, ...structured } = data
  const page = html ? pageForModel(html, finalUrl) : { text: '', jsonld: [], meta: [], images: [] }
  if (image && !page.images.includes(image) && page.images.length < 12) page.images.unshift(image)
  return { structured: { ...structured, image: image ?? null }, page, finalUrl }
}

/** Retrieval via fetch + extraction. Returns { data, html }; throws on HTTP 4xx/5xx (error pages are not analysed). */
async function plainPreview(start) {
  let res, finalUrl
  try {
    ;({ res, url: finalUrl } = await safeFetch(start, {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9',
    }))
  } catch (e) {
    if (e.userFacing) throw e
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw fail('Timed out while loading the page', 'page_timeout')
    throw fail('Page could not be loaded', 'page_load_failed')
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw Object.assign(fail(`Page could not be loaded (status ${res.status})`, 'page_load_failed'), { blocked: res.status === 403 || res.status === 429 })
  }
  const type = res.headers.get('content-type') || ''
  if (type && !/html|xml|text\/plain/i.test(type)) {
    await res.body?.cancel().catch(() => {})
    throw Object.assign(fail('The link does not point to a web page', 'not_webpage'), { notWebpage: true })
  }
  let buf
  try {
    buf = await readLimited(res, MAX_HTML)
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw fail('Timed out while loading the page', 'page_timeout')
    throw fail('Page could not be loaded', 'page_load_failed')
  }
  const html = decodeHtml(buf, type)
  if (looksLikeChallenge(html)) return { data: { blocked: true, title: null, image: null, price: null, url: finalUrl.href }, html: null }
  return { data: await extract(html, finalUrl), html }
}

export const IMAGE_FILE_RE = /^[a-f0-9]{40}\.(jpg|png|gif|webp|avif)$/
