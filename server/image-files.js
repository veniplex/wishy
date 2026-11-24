// Shared image storage for profile pictures (users) and person photos: files live in DATA_DIR/avatars (random names, so they are
// part of every backup/restore, which copies that directory), the type is decided by the magic bytes, 2 MB at most.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { DATA_DIR } from './secret.js'
import { bad, HttpError } from './util.js'

export const AVATARS_DIR = path.join(DATA_DIR, 'avatars')
fs.mkdirSync(AVATARS_DIR, { recursive: true })
export const MAX_AVATAR = 2 * 1024 * 1024
export const FILE_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/
export const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

/** File type from the magic bytes (not from the Content-Type). */
export function sniffImage(buf) {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}


export function removeImageFile(name) {
  if (name && FILE_RE.test(name)) fs.rmSync(path.join(AVATARS_DIR, name), { force: true })
}

export function saveImageBuffer(buf) {
  const ext = sniffImage(buf)
  if (!ext) throw bad('Please choose an image in JPEG, PNG or WebP format', 'avatar_type')
  if (buf.length > MAX_AVATAR) throw new HttpError(413, 'The image is too large (maximum 2 MB)', 'avatar_too_large')
  const name = `${randomBytes(16).toString('hex')}.${ext}`
  fs.writeFileSync(path.join(AVATARS_DIR, name), buf)
  return name
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

export async function readImageFromRequest(req) {
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
