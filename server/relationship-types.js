// Relationship types per space: validation, routes, export/import and audit entries (mirrors occasion-types.js; the definition of
// the built-in types, seeding and the free text conversion are in relationship-core.js). Changes need the `manage_persons` permission
// (the one that also covers persons; the owner always has it).
import { db, tx, norm } from './db.js'
import { audit } from './audit.js'
import { bad, conflict, notFound, numId } from './util.js'
import { requirePermission } from './permissions.js'
import {
  BUILTIN, cleanName, createCustomType, ensureRelationshipTypesForSpace, listRelationshipTypes, resolveRelationship,
} from './relationship-core.js'

export { DEFAULT_RELATIONSHIP_TYPES, relationshipDisplayName, ensureRelationshipTypesForSpace, listRelationshipTypes } from './relationship-core.js'

const all = (sql, ...p) => db.prepare(sql).all(...p)
const get = (sql, ...p) => db.prepare(sql).get(...p)

/**
 * Validates persons.relationship of a create/update and returns the key to store (null = none).
 * A key of the space is stored as is (a hidden type only when unchanged = `current`); anything else counts as free text (API clients,
 * queued offline changes of an older version): it is matched to a type by name, otherwise a custom type is created. The callers
 * hold `manage_persons`, which is also the permission to manage the types. `onCreate(key, name)` is told about an automatically created type.
 */
export function checkRelationship(spaceId, value, current, onCreate) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw bad('Invalid relationship', 'relationship_invalid')
  const row = get('SELECT hidden FROM relationship_types WHERE space_id=? AND key=?', spaceId, value)
  if (row) {
    if (row.hidden && value !== current) throw bad('This relationship type is hidden', 'relationship_invalid')
    return value
  }
  const { key, created } = resolveRelationship(spaceId, value, { create: true })
  if (created) onCreate?.(key, cleanName(value))
  return key
}

const ownedType = (spaceId, id) => {
  const n = numId(id)
  const r = Number.isNaN(n) ? null : get('SELECT * FROM relationship_types WHERE id=? AND space_id=?', n, spaceId)
  if (!r) throw notFound('Relationship type not found', 'relationship_type_not_found')
  return r
}
/** Built-in types are fixed: only hide/show and reorder are allowed. */
const customOnly = (r) => {
  if (r.builtin_key) throw bad('Default relationship types cannot be changed, deleted or merged - they can only be hidden', 'relationship_type_builtin')
  return r
}
const usageOf = (r) => get('SELECT COUNT(*) AS n FROM persons WHERE space_id=? AND relationship=?', r.space_id, r.key).n
const label = (r) => r.name || r.key
export const auditRelationshipType = (req, action, spaceId, r, details) =>
  audit(req, action, { target: { type: 'relationship_type', id: r.id, label: label(r) }, spaceId, details })

/** A name must be unique within the space (case-insensitive, also against the built-in names) so that the types stay distinguishable. */
function checkNameFree(spaceId, name, exceptId) {
  const lower = name.toLowerCase()
  for (const r of all('SELECT id, builtin_key, name FROM relationship_types WHERE space_id=?', spaceId)) {
    if (r.id === exceptId) continue
    const d = BUILTIN.get(r.builtin_key)
    const names = r.name ? [r.name] : d ? [d.label.de, d.label.en] : []
    if (names.some((n) => n.toLowerCase() === lower)) throw conflict('A relationship type with this name already exists', 'relationship_type_exists')
  }
}

// ---------- Routes ----------
/** `route(method, path, (ctx, req) => …)` answers with the new state of the space (see planning.js). */
export function relationshipTypeRoutes(app, route, requireAuth, spaceCtx) {
  app.get('/api/relationship-types', requireAuth, (req, res) => {
    res.json({ types: listRelationshipTypes(spaceCtx(req).spaceId) })
  })
  const mutate = (method, path, fn) =>
    route(method, path, (ctx, req) => {
      requirePermission(ctx, 'manage_persons')
      return fn(ctx, req)
    })

  mutate('post', '/api/relationship-types', (ctx, req) => {
    const name = cleanName(req.body.name)
    if (!name) throw bad('Please enter a name', 'name_required')
    checkNameFree(ctx.spaceId, name)
    let created
    tx(() => {
      const key = createCustomType(ctx.spaceId, name)
      created = get('SELECT * FROM relationship_types WHERE space_id=? AND key=?', ctx.spaceId, key)
    })
    auditRelationshipType(req, 'relationship_type.create', ctx.spaceId, created)
  })

  mutate('post', '/api/relationship-types/reorder', (ctx, req) => {
    const ids = req.body.ids
    if (!Array.isArray(ids)) throw bad('Invalid list', 'ids_invalid')
    const own = new Set(all('SELECT id FROM relationship_types WHERE space_id=?', ctx.spaceId).map((r) => r.id))
    const order = [...new Set(ids.map(numId))]
    if (order.some((i) => !own.has(i))) throw notFound('Relationship type not found', 'relationship_type_not_found')
    tx(() => {
      const rest = all('SELECT id FROM relationship_types WHERE space_id=? ORDER BY sort, id', ctx.spaceId).map((r) => r.id).filter((i) => !order.includes(i))
      ;[...order, ...rest].forEach((id, i) => db.prepare('UPDATE relationship_types SET sort=? WHERE id=?').run(i, id))
    })
  })

  // Custom types only: the name
  mutate('put', '/api/relationship-types/:id', (ctx, req) => {
    const r = customOnly(ownedType(ctx.spaceId, req.params.id))
    const sets = {}
    if (req.body.name !== undefined) {
      const name = cleanName(req.body.name)
      if (!name) throw bad('Please enter a name', 'name_required')
      checkNameFree(ctx.spaceId, name, r.id)
      sets.name = name
    }
    const cols = Object.keys(sets)
    if (cols.length) {
      db.prepare(`UPDATE relationship_types SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`).run(...cols.map((c) => norm(sets[c])), r.id)
    }
    auditRelationshipType(req, 'relationship_type.update', ctx.spaceId, get('SELECT * FROM relationship_types WHERE id=?', r.id), { fields: cols })
  })

  // Hide / show (the only change allowed for built-in types)
  const setHidden = (flag) => (ctx, req) => {
    const r = ownedType(ctx.spaceId, req.params.id)
    db.prepare("UPDATE relationship_types SET hidden=?, updated_at=datetime('now') WHERE id=?").run(flag ? 1 : 0, r.id)
    auditRelationshipType(req, 'relationship_type.update', ctx.spaceId, r, { hidden: flag })
  }
  mutate('post', '/api/relationship-types/:id/hide', setHidden(true))
  mutate('post', '/api/relationship-types/:id/show', setHidden(false))

  mutate('delete', '/api/relationship-types/:id', (ctx, req) => {
    const r = customOnly(ownedType(ctx.spaceId, req.params.id))
    const n = usageOf(r)
    if (n) throw conflict('This relationship type is still in use', 'relationship_type_in_use', { count: n })
    db.prepare('DELETE FROM relationship_types WHERE id=?').run(r.id)
    auditRelationshipType(req, 'relationship_type.delete', ctx.spaceId, r)
  })

  // Moves all persons to another type and deletes this one (atomic)
  mutate('post', '/api/relationship-types/:id/merge', (ctx, req) => {
    const r = customOnly(ownedType(ctx.spaceId, req.params.id))
    const into = ownedType(ctx.spaceId, req.body.into_id)
    if (into.id === r.id || into.hidden) throw bad('Invalid target type', 'relationship_type_merge_target')
    let moved = 0
    tx(() => {
      moved = Number(db.prepare('UPDATE persons SET relationship=? WHERE space_id=? AND relationship=?').run(into.key, ctx.spaceId, r.key).changes)
      db.prepare('DELETE FROM relationship_types WHERE id=?').run(r.id)
    })
    auditRelationshipType(req, 'relationship_type.merge', ctx.spaceId, r, { into_id: into.id, into: label(into), moved })
  })
}

// ---------- Space export / import ----------
export const exportRelationshipTypes = (spaceId) => listRelationshipTypes(spaceId).map(({ usage, ...t }) => t)

/**
 * Replaces the space's types by the given rows (without rows -> defaults) and converts the free text of persons that were imported
 * without matching type (backups of 1.0.x) - always ends consistent, see ensureRelationshipTypesForSpace.
 */
export function importRelationshipTypes(spaceId, rows) {
  tx(() => {
    db.prepare('DELETE FROM relationship_types WHERE space_id=?').run(spaceId)
    const seen = new Set()
    let sort = 0
    const put = (t, key, builtin) =>
      db.prepare('INSERT INTO relationship_types (space_id,key,builtin_key,name,sort) VALUES (?,?,?,?,?)').run(spaceId, key, builtin ? key : null, builtin ? null : t.name, sort++)
    for (const t of Array.isArray(rows) ? rows : []) {
      if (!t || typeof t.key !== 'string' || !t.key || seen.has(t.key)) continue
      if (t.builtin_key === t.key && BUILTIN.has(t.key)) put(t, t.key, true)
      else {
        const name = cleanName(t.name)
        if (!name || BUILTIN.has(t.key)) continue
        put({ name }, t.key, false)
      }
      seen.add(t.key)
      if (t.hidden) db.prepare('UPDATE relationship_types SET hidden=1 WHERE space_id=? AND key=?').run(spaceId, t.key)
    }
    ensureRelationshipTypesForSpace(spaceId)
  })
}
