// Occasion types per space: definition of the built-in types (single source of truth), validation and routes.
// Table: occasion_types (created in db.js). occasions.type stores the type's `key`.
//  - Built-in types: key = builtin_key = id from DEFAULT_OCCASION_TYPES, name NULL. They are FIXED: label (client i18n), icon, default
//    date and recurring flag come from the definition below and cannot be changed, deleted or merged away. A space can only hide/show
//    one (hidden = not offered for new/edited occasions; existing occasions display normally) and reorder it.
//  - Every type has a default audience (who takes part in new occasions of the type: 'all' or 'selected', see participants.js); built-ins
//    define it below, custom types edit it (default 'selected').
//  - 'birthday' is never offered for manually created occasions (birthdays come from the persons, 400 birthday_from_person).
//  - Custom types: key 'custom_<random>', name required; name, icon, optional default date, optional recurring default and the default audience are editable;
//    deletable (409 while in use -> merge), mergeable, hideable.
//  - At least one pickable type (everything but 'birthday') of a space stays visible.
import { randomBytes } from 'node:crypto'
import { db, tx, norm } from './db.js'
import { audit } from './audit.js'
import { bad, conflict, notFound, numId } from './util.js'
import { requirePermission } from './permissions.js'

const all = (sql, ...p) => db.prepare(sql).all(...p)
const get = (sql, ...p) => db.prepare(sql).get(...p)

/** Default types of every new space (order = initial sort). `audience` = default audience of new occasions. `label` is the display name for server-side texts (API, AI). */
export const DEFAULT_OCCASION_TYPES = [
  { key: 'birthday', icon: 'cake', md: null, recurring: 1, audience: 'selected', label: { de: 'Geburtstag', en: 'Birthday' } },
  { key: 'christmas', icon: 'tree-pine', md: '12-24', recurring: 1, audience: 'all', label: { de: 'Weihnachten', en: 'Christmas' } },
  { key: 'st_nicholas', icon: 'gift', md: '12-06', recurring: 1, audience: 'all', label: { de: 'Nikolaus', en: 'St Nicholas Day' } },
  { key: 'easter', icon: 'egg', md: null, recurring: 1, audience: 'all', label: { de: 'Ostern', en: 'Easter' } },
  { key: 'valentine', icon: 'heart', md: '02-14', recurring: 1, audience: 'selected', label: { de: 'Valentinstag', en: "Valentine's Day" } },
  { key: 'anniversary', icon: 'heart-handshake', md: null, recurring: 1, audience: 'selected', label: { de: 'Jahrestag', en: 'Anniversary' } },
  { key: 'parentsday', icon: 'flower', md: null, recurring: 1, audience: 'selected', label: { de: 'Mutter-/Vatertag', en: "Mother's/Father's Day" } },
  { key: 'wedding', icon: 'gem', md: null, recurring: 0, audience: 'selected', label: { de: 'Hochzeit', en: 'Wedding' } },
  { key: 'baby', icon: 'baby', md: null, recurring: 0, audience: 'selected', label: { de: 'Geburt', en: 'New baby' } },
  { key: 'housewarming', icon: 'home', md: null, recurring: 0, audience: 'selected', label: { de: 'Einzug', en: 'Housewarming' } },
  { key: 'other', icon: 'gift', md: null, recurring: 0, audience: 'selected', label: { de: 'Sonstiges', en: 'Other' } },
]
const BUILTIN = new Map(DEFAULT_OCCASION_TYPES.map((d) => [d.key, d]))

/** Allowed icons (lucide names, kebab-case). The client maps every name to a component (src/occasion-icons.ts, kept in sync by scripts/tests/occasion-types.mjs). */
export const OCCASION_ICONS = [
  'cake', 'tree-pine', 'gift', 'egg', 'heart', 'heart-handshake', 'gem', 'baby', 'home', 'flower',
  'graduation-cap', 'briefcase', 'plane', 'party-popper', 'star', 'sun', 'snowflake', 'music', 'trophy', 'calendar',
  'wine', 'utensils', 'car', 'camera', 'book-open', 'sparkles', 'ghost', 'leaf', 'shirt', 'palmtree',
]
const NAME_MAX = 60

/** Display name for server-side texts: custom name, otherwise the built-in label in the given language. */
/** Default audience for new occasions of a type key ('selected' for unknown keys). */
export const defaultAudience = (spaceId, key) => get('SELECT default_audience FROM occasion_types WHERE space_id=? AND key=?', spaceId, key)?.default_audience ?? 'selected'

export const typeDisplayName = (row, locale = 'en') => {
  if (row?.name) return row.name
  const d = BUILTIN.get(row?.builtin_key ?? row?.key)
  return d ? (d.label[locale] ?? d.label.en) : String(row?.key ?? '')
}

// ---------- Seeding ----------
const AUDIENCES = ['all', 'selected']
const insertRow = (sid, r, sort) =>
  db
    .prepare('INSERT INTO occasion_types (space_id,key,builtin_key,name,icon,default_month_day,default_recurring,default_audience,sort) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sid, r.key, r.builtin_key ?? null, r.name ?? null, r.icon, r.md ?? null, r.recurring ? 1 : 0, r.audience ?? 'selected', sort)

const nextSort = (sid) => (get('SELECT COALESCE(MAX(sort),-1)+1 AS n FROM occasion_types WHERE space_id=?', sid).n)
const visibleCount = (sid) => get("SELECT COUNT(*) AS n FROM occasion_types WHERE space_id=? AND hidden=0 AND key!='birthday'", sid).n

/**
 * Idempotent: makes sure a space has every built-in type (a new space gets them in the default order), creates a custom type for
 * every occasions.type value of the space that has no type row (so nothing is orphaned) and keeps at least one type visible.
 */
export function ensureOccasionTypesForSpace(sid) {
  tx(() => {
    for (const d of DEFAULT_OCCASION_TYPES) {
      if (!get('SELECT 1 FROM occasion_types WHERE space_id=? AND key=?', sid, d.key)) insertRow(sid, { ...d, builtin_key: d.key }, nextSort(sid))
    }
    for (const o of all('SELECT DISTINCT type FROM occasions WHERE space_id=? AND type NOT IN (SELECT key FROM occasion_types WHERE space_id=?)', sid, sid)) {
      const key = String(o.type ?? '')
      insertRow(sid, { key, name: key.trim().slice(0, NAME_MAX) || '?', icon: 'calendar', recurring: 0 }, nextSort(sid))
    }
    if (!visibleCount(sid)) db.prepare("UPDATE occasion_types SET hidden=0 WHERE space_id=? AND key='other'").run(sid)
  })
}

// ---------- Reading ----------
/** Built-in rows are always shown with their fixed definition (the stored columns of these rows are never edited). */
const rowOut = (r) => {
  const d = BUILTIN.get(r.builtin_key)
  return d ? { ...r, name: null, icon: d.icon, default_month_day: d.md, default_recurring: d.recurring, default_audience: d.audience } : r
}

/** All types of the space (hidden ones included, flagged) with the number of occasions using each. */
export function listOccasionTypes(spaceId) {
  return all(
    `SELECT t.id, t.key, t.builtin_key, t.name, t.icon, t.default_month_day, t.default_recurring, t.default_audience, t.sort, t.hidden,
            (SELECT COUNT(*) FROM occasions o WHERE o.space_id=t.space_id AND o.type=t.key) AS usage
     FROM occasion_types t WHERE t.space_id=? ORDER BY t.sort, t.id`,
    spaceId,
  ).map(rowOut)
}

/**
 * Validates occasions.type for a create/update. Returns the key to store.
 * `current`: the occasion's present type (a hidden type is still accepted when unchanged).
 */
export function checkOccasionType(spaceId, type, current) {
  if (typeof type !== 'string' || !type) throw bad('Invalid occasion type', 'occasion_type_invalid')
  if (type === 'birthday' && current !== 'birthday') throw bad('Birthdays come from the persons - set a birthday on the person', 'birthday_from_person')
  const row = get('SELECT hidden FROM occasion_types WHERE space_id=? AND key=?', spaceId, type)
  if (!row || (row.hidden && type !== current)) throw bad('Invalid occasion type', 'occasion_type_invalid')
  return type
}

// ---------- Validation of input ----------
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
function cleanMonthDay(v) {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const m = /^(\d{2})-(\d{2})$/.exec(String(v))
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) < 1 || Number(m[2]) > DAYS[Number(m[1]) - 1]) throw bad('Invalid date (MM-DD)', 'occasion_type_date_invalid')
  return `${m[1]}-${m[2]}`
}
function cleanIcon(v) {
  if (v === undefined) return undefined
  if (!OCCASION_ICONS.includes(v)) throw bad('Invalid icon', 'occasion_type_icon_invalid')
  return v
}
export function cleanAudience(v) {
  if (v === undefined) return undefined
  if (!AUDIENCES.includes(v)) throw bad('Invalid audience', 'audience_invalid')
  return v
}
const cleanName = (v) => String(v ?? '').trim().slice(0, NAME_MAX)

const ownedType = (spaceId, id) => {
  const n = numId(id)
  const r = Number.isNaN(n) ? null : get('SELECT * FROM occasion_types WHERE id=? AND space_id=?', n, spaceId)
  if (!r) throw notFound('Occasion type not found', 'occasion_type_not_found')
  return r
}
/** Built-in types are fixed: only hide/show and reorder are allowed. */
const customOnly = (r) => {
  if (r.builtin_key) throw bad('Default occasion types cannot be changed, deleted or merged - they can only be hidden', 'occasion_type_builtin')
  return r
}
const usageOf = (r) => get('SELECT COUNT(*) AS n FROM occasions WHERE space_id=? AND type=?', r.space_id, r.key).n
const label = (r) => r.name || r.key
const auditType = (req, action, spaceId, r, details) =>
  audit(req, action, { target: { type: 'occasion_type', id: r.id, label: label(r) }, spaceId, details })

// ---------- Routes ----------
/** `route(method, path, (ctx, req) => …)` answers with the new state of the space (see planning.js). Changes need `manage_occasions`. */
export function occasionTypeRoutes(app, route, requireAuth, spaceCtx) {
  app.get('/api/occasion-types', requireAuth, (req, res) => {
    res.json({ types: listOccasionTypes(spaceCtx(req).spaceId), icons: OCCASION_ICONS })
  })
  const mutate = (method, path, fn) =>
    route(method, path, (ctx, req) => {
      requirePermission(ctx, 'manage_occasions')
      return fn(ctx, req)
    })

  mutate('post', '/api/occasion-types', (ctx, req) => {
    const b = req.body
    const name = cleanName(b.name)
    if (!name) throw bad('Please enter a name', 'name_required')
    const icon = cleanIcon(b.icon ?? 'calendar')
    const md = cleanMonthDay(b.default_month_day) ?? null
    const audience = cleanAudience(b.default_audience) ?? 'selected'
    let created
    tx(() => {
      const key = `custom_${randomBytes(5).toString('hex')}`
      const res = insertRow(ctx.spaceId, { key, name, icon, md, recurring: b.default_recurring ? 1 : 0, audience }, nextSort(ctx.spaceId))
      created = get('SELECT * FROM occasion_types WHERE id=?', Number(res.lastInsertRowid))
    })
    auditType(req, 'occasion_type.create', ctx.spaceId, created)
  })

  mutate('post', '/api/occasion-types/reorder', (ctx, req) => {
    const ids = req.body.ids
    if (!Array.isArray(ids)) throw bad('Invalid list', 'ids_invalid')
    const own = new Set(all('SELECT id FROM occasion_types WHERE space_id=?', ctx.spaceId).map((r) => r.id))
    const order = [...new Set(ids.map(numId))]
    if (order.some((i) => !own.has(i))) throw notFound('Occasion type not found', 'occasion_type_not_found')
    tx(() => {
      const rest = all('SELECT id FROM occasion_types WHERE space_id=? ORDER BY sort, id', ctx.spaceId).map((r) => r.id).filter((i) => !order.includes(i))
      ;[...order, ...rest].forEach((id, i) => db.prepare('UPDATE occasion_types SET sort=? WHERE id=?').run(i, id))
    })
  })

  // Custom types only: name, icon, optional default date, optional "repeats yearly" default, default audience
  mutate('put', '/api/occasion-types/:id', (ctx, req) => {
    const r = customOnly(ownedType(ctx.spaceId, req.params.id))
    const b = req.body
    const sets = {}
    if (b.name !== undefined) {
      const name = cleanName(b.name)
      if (!name) throw bad('Please enter a name', 'name_required')
      sets.name = name
    }
    const icon = cleanIcon(b.icon)
    if (icon !== undefined) sets.icon = icon
    const md = cleanMonthDay(b.default_month_day)
    if (md !== undefined) sets.default_month_day = md
    if (b.default_recurring !== undefined) sets.default_recurring = b.default_recurring ? 1 : 0
    const audience = cleanAudience(b.default_audience)
    if (audience !== undefined) sets.default_audience = audience
    const cols = Object.keys(sets)
    if (cols.length) {
      db.prepare(`UPDATE occasion_types SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...cols.map((c) => norm(sets[c])), r.id)
    }
    auditType(req, 'occasion_type.update', ctx.spaceId, get('SELECT * FROM occasion_types WHERE id=?', r.id), { fields: cols })
  })

  // Hide / show (the only change allowed for built-in types)
  const setHidden = (flag) => (ctx, req) => {
    const r = ownedType(ctx.spaceId, req.params.id)
    if (flag && !r.hidden && r.key !== 'birthday' && visibleCount(ctx.spaceId) <= 1) throw bad('At least one occasion type must stay visible', 'occasion_type_last_visible')
    db.prepare("UPDATE occasion_types SET hidden=?, updated_at=datetime('now') WHERE id=?").run(flag ? 1 : 0, r.id)
    auditType(req, 'occasion_type.update', ctx.spaceId, r, { hidden: flag })
  }
  mutate('post', '/api/occasion-types/:id/hide', setHidden(true))
  mutate('post', '/api/occasion-types/:id/show', setHidden(false))

  mutate('delete', '/api/occasion-types/:id', (ctx, req) => {
    const r = customOnly(ownedType(ctx.spaceId, req.params.id))
    const n = usageOf(r)
    if (n) throw conflict('This occasion type is still in use', 'occasion_type_in_use', { count: n })
    if (!r.hidden && visibleCount(ctx.spaceId) <= 1) throw bad('At least one occasion type must stay visible', 'occasion_type_last_visible')
    db.prepare('DELETE FROM occasion_types WHERE id=?').run(r.id)
    auditType(req, 'occasion_type.delete', ctx.spaceId, r)
  })

  // Moves all occasions to another type and deletes this one (atomic)
  mutate('post', '/api/occasion-types/:id/merge', (ctx, req) => {
    const r = customOnly(ownedType(ctx.spaceId, req.params.id))
    const into = ownedType(ctx.spaceId, req.body.into_id)
    if (into.id === r.id || into.hidden) throw bad('Invalid target type', 'occasion_type_merge_target')
    let moved = 0
    tx(() => {
      moved = Number(db.prepare('UPDATE occasions SET type=? WHERE space_id=? AND type=?').run(into.key, ctx.spaceId, r.key).changes)
      db.prepare('DELETE FROM occasion_types WHERE id=?').run(r.id)
    })
    auditType(req, 'occasion_type.merge', ctx.spaceId, r, { into_id: into.id, into: label(into), moved })
  })
}

// ---------- Space export / import ----------
export const exportOccasionTypes = (spaceId) => listOccasionTypes(spaceId).map(({ usage, ...t }) => t)

/** Replaces the space's types by the given rows (without rows -> defaults). Always ends consistent (see ensure…). */
export function importOccasionTypes(spaceId, rows) {
  tx(() => {
    db.prepare('DELETE FROM occasion_types WHERE space_id=?').run(spaceId)
    const seen = new Set()
    let sort = 0
    for (const t of Array.isArray(rows) ? rows : []) {
      if (!t || typeof t.key !== 'string' || !t.key || seen.has(t.key)) continue
      seen.add(t.key)
      const d = t.builtin_key === t.key ? BUILTIN.get(t.key) : null
      if (d) {
        insertRow(spaceId, { ...d, builtin_key: d.key }, sort++)
      } else {
        const name = cleanName(t.name)
        if (!name || BUILTIN.has(t.key)) continue
        let md = null
        try {
          md = cleanMonthDay(t.default_month_day) ?? null
        } catch {
          /* ignore an invalid date */
        }
        insertRow(spaceId, { key: t.key, name, icon: OCCASION_ICONS.includes(t.icon) ? t.icon : 'calendar', md, recurring: t.default_recurring ? 1 : 0, audience: t.default_audience === 'all' ? 'all' : 'selected' }, sort++)
      }
      if (t.hidden) db.prepare('UPDATE occasion_types SET hidden=1 WHERE space_id=? AND key=?').run(spaceId, t.key)
    }
    ensureOccasionTypesForSpace(spaceId)
  })
}
