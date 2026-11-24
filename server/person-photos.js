// Person photos: an optional picture per person (persons.photo_file). Files are stored like profile pictures (image-files.js, DATA_DIR/avatars),
// so backups and restores cover them. The photo is served to every member of the person's space (the same people who see the person).
import { db } from './db.js'
import { requireAuth } from './session.js'
import { audit } from './audit.js'
import { spaceCtx } from './spaces.js'
import { requirePermission } from './permissions.js'
import { withPhotoUrl } from './persons.js'
import { AVATARS_DIR, FILE_RE, MIME, readImageFromRequest, removeImageFile, saveImageBuffer } from './image-files.js'
import { notFound, reqId } from './util.js'

const NOT_FOUND = ['No photo', 'person_photo_not_found']

export function personPhotoRoutes(app) {
  /** The person must belong to the current space and the member must be allowed to manage persons. */
  const editable = (req) => {
    const ctx = spaceCtx(req)
    requirePermission(ctx, 'manage_persons')
    const id = reqId(req.params.id, 'Person not found', 'person_not_found')
    const p = db.prepare('SELECT * FROM persons WHERE id=? AND space_id=?').get(id, ctx.spaceId)
    if (!p) throw notFound('Person not found', 'person_not_found')
    return p
  }
  const view = (id) => ({ photo_url: withPhotoUrl(db.prepare('SELECT * FROM persons WHERE id=?').get(id)).photo_url })

  app.post('/api/persons/:id/photo', requireAuth, async (req, res) => {
    const p = editable(req)
    const name = saveImageBuffer(await readImageFromRequest(req))
    db.prepare('UPDATE persons SET photo_file=? WHERE id=?').run(name, p.id)
    removeImageFile(p.photo_file)
    audit(req, 'person.photo.set', { target: { type: 'person', id: p.id }, spaceId: p.space_id })
    res.json(view(p.id))
  })

  app.delete('/api/persons/:id/photo', requireAuth, (req, res) => {
    const p = editable(req)
    db.prepare('UPDATE persons SET photo_file=NULL WHERE id=?').run(p.id)
    removeImageFile(p.photo_file)
    audit(req, 'person.photo.remove', { target: { type: 'person', id: p.id }, spaceId: p.space_id })
    res.json(view(p.id))
  })

  // <img> requests carry no X-Space header: access is decided by membership in the space the person belongs to
  app.get('/api/person-photos/:id', requireAuth, (req, res, next) => {
    const id = reqId(req.params.id, 'Person not found', 'person_not_found')
    const p = db
      .prepare('SELECT p.photo_file FROM persons p JOIN space_members m ON m.space_id=p.space_id AND m.user_id=? WHERE p.id=?')
      .get(req.user.id, id)
    const f = p?.photo_file
    if (!f || !FILE_RE.test(f)) return next(notFound(...NOT_FOUND))
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('Content-Type', MIME[f.split('.')[1]])
    res.sendFile(f, { root: AVATARS_DIR, etag: true, lastModified: false, cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: NOT_FOUND[0], code: NOT_FOUND[1] })
    })
  })
}
