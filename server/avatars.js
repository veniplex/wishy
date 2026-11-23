// Profile pictures: own upload (users.avatar_file) or the sign-in provider's picture (users.idp_avatar_file).
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { db } from './db.js'
import { DATA_DIR } from './secret.js'
import { requireAuth } from './session.js'
import { audit } from './audit.js'
import { storeImage, IMAGES_DIR } from './preview.js'
import { bad, notFound, reqId, HttpError } from './util.js'

export const AVATARS_DIR = path.join(DATA_DIR, 'avatars')
fs.mkdirSync(AVATARS_DIR, { recursive: true })
export const MAX_AVATAR = 2 * 1024 * 1024
const FILE_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

/** File type from the magic bytes (not from the Content-Type). */
export function sniffImage(buf) {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

const effectiveFile = (u) => u.avatar_file || u.idp_avatar_file || null

export function avatarUrl(u) {
  const f = effectiveFile(u)
  return f ? `/api/avatars/${u.id}?v=${f.slice(0, 8)}` : null
}
export const idpPictureAvailable = (u) => !!u.idp_avatar_file

function removeFile(name) {
  if (name && FILE_RE.test(name)) fs.rmSync(path.join(AVATARS_DIR, name), { force: true })
}

function saveBuffer(buf) {
  const ext = sniffImage(buf)
  if (!ext) throw bad('Please choose an image in JPEG, PNG or WebP format', 'avatar_type')
  if (buf.length > MAX_AVATAR) throw new HttpError(413, 'The image is too large (maximum 2 MB)', 'avatar_too_large')
  const name = `${randomBytes(16).toString('hex')}.${ext}`
  fs.writeFileSync(path.join(AVATARS_DIR, name), buf)
  return name
}

/** Downloads the sign-in provider's picture (HTTPS only, SSRF-safe via preview.js, 2 MB at most). Errors are swallowed. */
export async function fetchIdpAvatar(userId, pictureUrl) {
  try {
    const u = new URL(String(pictureUrl))
    if (u.protocol !== 'https:') return
    const hash = createHash('sha1').update(u.href).digest('hex')
    const preexisting = fs.readdirSync(IMAGES_DIR).some((f) => f.startsWith(hash + '.'))
    const url = await storeImage(u.href, u.origin)
    if (!url) return
    const file = path.join(IMAGES_DIR, path.basename(url))
    const buf = fs.readFileSync(file)
    if (!preexisting) fs.rmSync(file, { force: true })
    if (buf.length > MAX_AVATAR || !sniffImage(buf)) return
    const name = saveBuffer(buf)
    const old = db.prepare('SELECT idp_avatar_file FROM users WHERE id=?').get(userId)
    db.prepare('UPDATE users SET idp_avatar_file=? WHERE id=?').run(name, userId)
    removeFile(old?.idp_avatar_file)
  } catch {
    /* The profile picture is optional */
  }
}

export function clearIdpAvatar(userId) {
  const old = db.prepare('SELECT idp_avatar_file FROM users WHERE id=?').get(userId)
  db.prepare('UPDATE users SET idp_avatar_file=NULL WHERE id=?').run(userId)
  removeFile(old?.idp_avatar_file)
}

/** Deletes all avatar files of a user (when the account is deleted). */
export function removeUserAvatars(userId) {
  const u = db.prepare('SELECT avatar_file, idp_avatar_file FROM users WHERE id=?').get(userId)
  removeFile(u?.avatar_file)
  removeFile(u?.idp_avatar_file)
}

// ---------- Reading input: multipart/form-data or JSON with Base64 ----------
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (c) => {
      size += c.length
      if (over) return // discard the remaining data so the response can still get through
      if (size > max) {
        over = true
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    req.on('end', () => (over ? reject(new HttpError(413, 'The image is too large (maximum 2 MB)', 'avatar_too_large')) : resolve(Buffer.concat(chunks))))
    req.on('error', reject)
  })
}

function parseMultipartFile(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) throw bad('Invalid request', 'bad_request')
  const delim = Buffer.from('--' + (m[1] || m[2]).trim())
  let pos = body.indexOf(delim)
  while (pos >= 0) {
    const start = pos + delim.length
    if (body.subarray(start, start + 2).toString() === '--') break
    const headEnd = body.indexOf('\r\n\r\n', start)
    if (headEnd < 0) break
    const head = body.subarray(start, headEnd).toString('latin1')
    const next = body.indexOf(delim, headEnd + 4)
    if (next < 0) break
    if (/filename=/i.test(head) || /name="(avatar|file|image)"/i.test(head)) {
      return body.subarray(headEnd + 4, next - 2) // before the trailing CRLF
    }
    pos = next
  }
  throw bad('No image was submitted', 'avatar_missing')
}

async function readImageFromRequest(req) {
  const ct = String(req.headers['content-type'] || '')
  if (ct.includes('multipart/form-data')) {
    const raw = await readRaw(req, MAX_AVATAR + 64 * 1024)
    return parseMultipartFile(raw, ct)
  }
  const b = req.body || {}
  const data = String(b.data ?? b.image ?? b.base64 ?? '')
  if (!data) throw bad('No image was submitted', 'avatar_missing')
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(data)
  const b64 = m ? m[2] : data
  if (b64.length > Math.ceil((MAX_AVATAR * 4) / 3) + 8) throw new HttpError(413, 'The image is too large (maximum 2 MB)', 'avatar_too_large')
  return Buffer.from(b64, 'base64')
}

export function avatarRoutes(app) {
  app.post('/api/account/avatar', requireAuth, async (req, res) => {
    const buf = await readImageFromRequest(req)
    const name = saveBuffer(buf)
    const old = db.prepare('SELECT avatar_file FROM users WHERE id=?').get(req.user.id)
    db.prepare('UPDATE users SET avatar_file=? WHERE id=?').run(name, req.user.id)
    removeFile(old?.avatar_file)
    audit(req, 'account.avatar.set', { target: { type: 'user', id: req.user.id } })
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
    res.json({ avatar_url: avatarUrl(u) })
  })

  app.delete('/api/account/avatar', requireAuth, (req, res) => {
    const old = db.prepare('SELECT avatar_file FROM users WHERE id=?').get(req.user.id)
    db.prepare('UPDATE users SET avatar_file=NULL WHERE id=?').run(req.user.id)
    removeFile(old?.avatar_file)
    audit(req, 'account.avatar.remove', { target: { type: 'user', id: req.user.id } })
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
    res.json({ avatar_url: avatarUrl(u) })
  })

  app.get('/api/avatars/:userId', requireAuth, (req, res, next) => {
    const id = reqId(req.params.userId)
    const u = db.prepare('SELECT avatar_file, idp_avatar_file FROM users WHERE id=?').get(id)
    const f = u && effectiveFile(u)
    if (!f || !FILE_RE.test(f)) return next(notFound('No profile picture', 'avatar_not_found'))
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('Content-Type', MIME[f.split('.')[1]])
    res.sendFile(f, { root: AVATARS_DIR, etag: true, lastModified: false, cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'No profile picture', code: 'avatar_not_found' })
    })
  })
}
