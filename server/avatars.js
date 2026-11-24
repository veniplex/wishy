// Profile pictures: own upload (users.avatar_file) or the sign-in provider's picture (users.idp_avatar_file).
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { db } from './db.js'
import { requireAuth } from './session.js'
import { audit } from './audit.js'
import { storeImage, IMAGES_DIR } from './preview.js'
import { notFound, reqId } from './util.js'
import { AVATARS_DIR, MAX_AVATAR, FILE_RE, MIME, sniffImage, removeImageFile as removeFile, saveImageBuffer as saveBuffer, readImageFromRequest } from './image-files.js'

export { AVATARS_DIR, MAX_AVATAR, sniffImage }

const effectiveFile = (u) => u.avatar_file || u.idp_avatar_file || null

export function avatarUrl(u) {
  const f = effectiveFile(u)
  return f ? `/api/avatars/${u.id}?v=${f.slice(0, 8)}` : null
}
export const idpPictureAvailable = (u) => !!u.idp_avatar_file

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
