// Relationship types per space: definition of the built-in types (single source of truth), seeding, lookup and the conversion of
// legacy free text. Deliberately depends on db.js only (schema.js runs the migration from here, see schema version 3).
// Routes, export/import and audit entries live in relationship-types.js.
// Table: relationship_types (created in db.js). persons.relationship stores the type's `key` (like occasions.type does).
//  - Built-in types: key = builtin_key = key from DEFAULT_RELATIONSHIP_TYPES, name NULL. They are FIXED: the label comes from the
//    client i18n (`label` below for server-side texts) and they cannot be renamed, deleted or merged away. A space can only
//    hide/show one (hidden = not offered for new/edited persons; persons that have it display normally) and reorder it.
//  - Custom types: key 'custom_<random>', name required; renamable, deletable (409 while in use -> merge), mergeable, hideable.
//  - Unlike occasion types there is no "at least one visible" rule: the relationship of a person is optional.
import { randomBytes } from 'node:crypto'
import { db, tx } from './db.js'

const all = (sql, ...p) => db.prepare(sql).all(...p)
const get = (sql, ...p) => db.prepare(sql).get(...p)

/** Default types of every new space (order = initial sort). `aliases`: further names that count as this type when free text is converted. */
export const DEFAULT_RELATIONSHIP_TYPES = [
  { key: 'parent', label: { de: 'Elternteil', en: 'Parent' } },
  { key: 'child', label: { de: 'Kind', en: 'Child' } },
  { key: 'sibling', label: { de: 'Geschwister', en: 'Sibling' } },
  { key: 'partner', label: { de: 'Partner/in', en: 'Partner' }, aliases: ['Partner', 'Partnerin'] },
  { key: 'grandparent', label: { de: 'Großeltern', en: 'Grandparent' } },
  { key: 'grandchild', label: { de: 'Enkelkind', en: 'Grandchild' } },
  { key: 'aunt_uncle', label: { de: 'Tante/Onkel', en: 'Aunt/Uncle' } },
  { key: 'cousin', label: { de: 'Cousin/Cousine', en: 'Cousin' }, aliases: ['Cousin', 'Cousine'] },
  { key: 'in_law', label: { de: 'Schwiegerfamilie', en: 'In-law' }, aliases: ['In-laws'] },
  { key: 'friend', label: { de: 'Freund/in', en: 'Friend' }, aliases: ['Freund', 'Freundin'] },
  { key: 'colleague', label: { de: 'Kollege/Kollegin', en: 'Colleague' }, aliases: ['Kollege', 'Kollegin'] },
  { key: 'neighbour', label: { de: 'Nachbar/in', en: 'Neighbour' }, aliases: ['Nachbar', 'Nachbarin', 'Neighbor'] },
  { key: 'acquaintance', label: { de: 'Bekannte/r', en: 'Acquaintance' }, aliases: ['Bekannter', 'Bekannte'] },
  { key: 'other', label: { de: 'Sonstige', en: 'Other' } },
]
export const BUILTIN = new Map(DEFAULT_RELATIONSHIP_TYPES.map((d) => [d.key, d]))
export const NAME_MAX = 60

/** Display name for server-side texts: custom name, otherwise the built-in label in the given language. */
export const relationshipDisplayName = (row, locale = 'en') => {
  if (row?.name) return row.name
  const d = BUILTIN.get(row?.builtin_key ?? row?.key)
  return d ? (d.label[locale] ?? d.label.en) : String(row?.key ?? '')
}

const insertRow = (sid, r, sort) =>
  db.prepare('INSERT INTO relationship_types (space_id,key,builtin_key,name,sort) VALUES (?,?,?,?,?)').run(sid, r.key, r.builtin_key ?? null, r.name ?? null, sort)
export const nextSort = (sid) => get('SELECT COALESCE(MAX(sort),-1)+1 AS n FROM relationship_types WHERE space_id=?', sid).n
export const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
export const newCustomKey = () => `custom_${randomBytes(5).toString('hex')}`

/** Creates a custom type (returns its key). */
export const createCustomType = (sid, name) => {
  const key = newCustomKey()
  insertRow(sid, { key, name }, nextSort(sid))
  return key
}

/**
 * Maps free text to the key of a type of the space: an existing key, a custom name or a built-in name/alias (case-insensitive).
 * Without a match a custom type is created (`create`) or null is returned. Returns { key, created } (key null = empty text).
 */
export function resolveRelationship(sid, input, { create = true } = {}) {
  const text = cleanName(input)
  if (!text) return { key: null, created: false }
  const lower = text.toLowerCase()
  const rows = all('SELECT key, builtin_key, name FROM relationship_types WHERE space_id=?', sid)
  const byKey = rows.find((r) => r.key === text)
  if (byKey) return { key: byKey.key, created: false }
  const byName = rows.find((r) => r.name && r.name.toLowerCase() === lower)
  if (byName) return { key: byName.key, created: false }
  for (const r of rows) {
    const d = BUILTIN.get(r.builtin_key)
    if (d && [d.label.de, d.label.en, ...(d.aliases ?? [])].some((n) => n.toLowerCase() === lower)) return { key: r.key, created: false }
  }
  return create ? { key: createCustomType(sid, text), created: true } : { key: null, created: false }
}

/**
 * Idempotent: makes sure a space has every built-in type (a new space gets them in the default order) and converts legacy free text
 * in persons.relationship (every value that is not the key of a type of the space) to the matching built-in/custom type; blank values
 * become NULL. This is also the body of the schema 3 migration.
 */
export function ensureRelationshipTypesForSpace(sid) {
  tx(() => {
    for (const d of DEFAULT_RELATIONSHIP_TYPES) {
      if (!get('SELECT 1 FROM relationship_types WHERE space_id=? AND key=?', sid, d.key)) insertRow(sid, { key: d.key, builtin_key: d.key }, nextSort(sid))
    }
    const stale = all(
      'SELECT DISTINCT relationship FROM persons WHERE space_id=? AND relationship IS NOT NULL AND relationship NOT IN (SELECT key FROM relationship_types WHERE space_id=?)',
      sid, sid,
    )
    for (const { relationship } of stale) {
      const { key } = resolveRelationship(sid, relationship)
      db.prepare('UPDATE persons SET relationship=? WHERE space_id=? AND relationship=?').run(key, sid, relationship)
    }
  })
}

/** Schema 3: every space gets its types and its persons are linked (see schema.js). */
export function migrateRelationshipTypes() {
  for (const s of all('SELECT id FROM spaces ORDER BY id')) ensureRelationshipTypesForSpace(s.id)
  // Persons without a space cannot be shown anywhere; nothing to convert for them
}

/** All types of the space (hidden ones included, flagged) with the number of persons using each. */
export function listRelationshipTypes(spaceId) {
  return all(
    `SELECT t.id, t.key, t.builtin_key, t.name, t.sort, t.hidden,
            (SELECT COUNT(*) FROM persons p WHERE p.space_id=t.space_id AND p.relationship=t.key) AS usage
     FROM relationship_types t WHERE t.space_id=? ORDER BY t.sort, t.id`,
    spaceId,
  )
}
