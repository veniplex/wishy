import { db, tx, logGiftEvent } from './db.js'
import { removeImageFile } from './image-files.js'
import { bad } from './util.js'

const all = (sql, ...p) => db.prepare(sql).all(...p)
const get = (sql, ...p) => db.prepare(sql).get(...p)
const blank = (v) => v === null || v === undefined || v === ''

// A normal participation wins over an exclusion when two rows meet
const KEEP_PARTICIPATION = 'ON CONFLICT (occasion_id, person_id) DO UPDATE SET excluded=MIN(occasion_persons.excluded, excluded.excluded)'
const copyOccasionRows = (fromOccasion, toOccasion) =>
  db.prepare(`INSERT INTO occasion_persons (occasion_id, person_id, excluded) SELECT ?, person_id, excluded FROM occasion_persons WHERE occasion_id=? ${KEEP_PARTICIPATION}`).run(toOccasion, fromOccasion)
const copyPersonRows = (fromPerson, toPerson) =>
  db.prepare(`INSERT INTO occasion_persons (occasion_id, person_id, excluded) SELECT occasion_id, ?, excluded FROM occasion_persons WHERE person_id=? ${KEEP_PARTICIPATION}`).run(toPerson, fromPerson)

// ---------- Person photos (files in DATA_DIR/avatars, see person-photos.js) ----------
/** Public view of a person row: no file name, only the cache-busted URL of the photo. */
export function withPhotoUrl({ photo_file, ...p }) {
  return { ...p, photo_url: photo_file ? `/api/person-photos/${p.id}?v=${photo_file.slice(0, 8)}` : null }
}
/** File names of the photos in a space (collect BEFORE deleting the persons, remove the files afterwards). */
export const spacePhotoFiles = (spaceId) => all('SELECT photo_file FROM persons WHERE space_id=? AND photo_file IS NOT NULL', spaceId).map((r) => r.photo_file)
export const removePhotoFiles = (names) => names.forEach(removeImageFile)

// ---------- Emoji ----------
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
/** One emoji (a single grapheme, ZWJ sequences included). Returns the trimmed value, or null when `strict` is off and it is invalid. */
export function cleanEmoji(v, strict = true) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!s) return null
  const n = segmenter ? [...segmenter.segment(s)].length : [...s].length
  if (n > 1 || s.length > 32 || /[\p{Cc}<>]/u.test(s)) {
    if (strict) throw bad('Please choose a single emoji', 'emoji_invalid')
    return null
  }
  return s
}

const FILL = ['birthday', 'emoji', 'photo_file', 'color', 'notes', 'yearly_budget', 'relationship', 'email']

/**
 * Merges person dropId into keepId (same space): all references move to keepId,
 * the kept person's name/notes stay, and empty fields are filled from the other person.
 */
export function mergePersons(spaceId, keepId, dropId, userId) {
  if (keepId === dropId) return
  tx(() => {
    const keep = get('SELECT * FROM persons WHERE id=? AND space_id=?', keepId, spaceId)
    const drop = get('SELECT * FROM persons WHERE id=? AND space_id=?', dropId, spaceId)
    if (!keep || !drop) throw new Error('Person not found')
    const touched = new Map() // giftId -> Set(fields)
    const touch = (gid, f) => {
      if (!touched.has(gid)) touched.set(gid, new Set())
      touched.get(gid).add(f)
    }

    // Fill empty fields
    const upd = {}
    for (const c of FILL) if (blank(keep[c]) && !blank(drop[c])) upd[c] = drop[c]
    if (Object.keys(upd).length) {
      db.prepare(`UPDATE persons SET ${Object.keys(upd).map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...Object.values(upd), keepId)
    }

    // The photo of the dropped person moves along if the kept one has none; otherwise its file is deleted
    if (!blank(keep.photo_file) && !blank(drop.photo_file)) removeImageFile(drop.photo_file)

    // Ideas
    db.prepare('UPDATE items SET person_id=? WHERE person_id=?').run(keepId, dropId)

    // Occasions: merge duplicate birthdays, keep the rest
    for (const o of all("SELECT * FROM occasions WHERE type='birthday' AND person_id=?", dropId)) {
      const k = get("SELECT id FROM occasions WHERE type='birthday' AND person_id=? AND date=? AND space_id=?", keepId, o.date, spaceId)
      if (k) {
        for (const g of all('SELECT id FROM gifts WHERE occasion_id=?', o.id)) touch(g.id, 'occasion_id')
        db.prepare('UPDATE gifts SET occasion_id=? WHERE occasion_id=?').run(k.id, o.id)
        db.prepare('UPDATE items SET occasion_id=? WHERE occasion_id=?').run(k.id, o.id)
        copyOccasionRows(o.id, k.id)
        db.prepare('DELETE FROM occasions WHERE id=?').run(o.id)
      } else {
        // If the kept person has a birthday, a differing unplanned date of the other person is redundant
        const used = get('SELECT 1 FROM gifts WHERE occasion_id=? UNION SELECT 1 FROM items WHERE occasion_id=?', o.id, o.id)
        const keepBday = blank(keep.birthday) ? upd.birthday : keep.birthday
        if (!used && !blank(keepBday)) db.prepare('DELETE FROM occasions WHERE id=?').run(o.id)
      }
    }
    db.prepare('UPDATE occasions SET person_id=? WHERE person_id=?').run(keepId, dropId)
    copyPersonRows(dropId, keepId)
    db.prepare('DELETE FROM occasion_persons WHERE person_id=?').run(dropId)

    // Gifts: recipients, payer, givers
    for (const r of all('SELECT gift_id FROM gift_recipients WHERE person_id=?', dropId)) touch(r.gift_id, 'recipient_ids')
    db.prepare('INSERT OR IGNORE INTO gift_recipients SELECT gift_id, ? FROM gift_recipients WHERE person_id=?').run(keepId, dropId)
    db.prepare('DELETE FROM gift_recipients WHERE person_id=?').run(dropId)

    for (const g of all('SELECT id FROM gifts WHERE payer_id=?', dropId)) touch(g.id, 'payer_id')
    db.prepare('UPDATE gifts SET payer_id=? WHERE payer_id=?').run(keepId, dropId)

    for (const d of all('SELECT * FROM gift_givers WHERE person_id=?', dropId)) {
      touch(d.gift_id, 'givers')
      const k = get('SELECT * FROM gift_givers WHERE gift_id=? AND person_id=?', d.gift_id, keepId)
      if (!k) {
        db.prepare('UPDATE gift_givers SET person_id=? WHERE gift_id=? AND person_id=?').run(keepId, d.gift_id, dropId)
        continue
      }
      // Both were givers of the same gift: add the amounts, "settled" only if both are settled
      const amount = k.amount != null && d.amount != null ? k.amount + d.amount : (k.amount ?? d.amount ?? null)
      const settled = k.settled && d.settled ? 1 : 0
      db.prepare('UPDATE gift_givers SET amount=?, settled=?, settled_at=?, settle_method=? WHERE gift_id=? AND person_id=?').run(
        amount, settled, settled ? k.settled_at ?? d.settled_at : null, settled ? k.settle_method ?? d.settle_method : null, d.gift_id, keepId,
      )
      db.prepare('DELETE FROM gift_givers WHERE gift_id=? AND person_id=?').run(d.gift_id, dropId)
    }

    db.prepare('DELETE FROM persons WHERE id=?').run(dropId)
    for (const [gid, fields] of touched) {
      if (get('SELECT 1 FROM gifts WHERE id=?', gid)) logGiftEvent(gid, userId, 'edited', { fields: [...fields], reason: 'person_merge' })
    }
  })
}
