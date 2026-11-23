import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = process.env.DATA_DIR || path.resolve('data')
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'wishlist.db'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

// ---- Schema (final form; created on a fresh database) ----
// Future schema changes: see the "how to add a migration" note in schema.js.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  google_email TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  disabled INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  locale TEXT,
  avatar_file TEXT,
  idp_avatar_file TEXT,
  ai_enabled INTEGER,
  api_enabled INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT,
  last_seen_at INTEGER,
  reauth_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  personal INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  -- JSON: permissions given to members who join (see permissions.js); {} = the defaults
  default_permissions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS space_members (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  -- JSON permission overrides of a member (the owner always has all, see permissions.js)
  permissions TEXT NOT NULL DEFAULT '{}',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_id, user_id)
);
CREATE TABLE IF NOT EXISTS space_invites (
  token TEXT PRIMARY KEY,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  created_by INTEGER,
  expires_at INTEGER NOT NULL,
  uses_left INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS user_invites (
  token_hash TEXT PRIMARY KEY,
  created_by INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  uses_left INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  space_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (space_id, key)
);

CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  birthday TEXT,
  emoji TEXT,
  color TEXT,
  notes TEXT,
  yearly_budget REAL,
  archived INTEGER NOT NULL DEFAULT 0,
  relationship TEXT,
  relationship_group TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  space_id INTEGER,
  linked_user_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_persons_space ON persons(space_id);
CREATE INDEX IF NOT EXISTS idx_persons_linked ON persons(linked_user_id);
CREATE TABLE IF NOT EXISTS occasions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  date TEXT NOT NULL,
  recurring INTEGER NOT NULL DEFAULT 0,
  series_id TEXT,
  person_id INTEGER REFERENCES persons(id) ON DELETE CASCADE,
  budget REAL,
  notes TEXT,
  -- 'all': every active person of the space takes part (except excluded ones; persons added later join automatically);
  -- 'selected': only the persons listed in occasion_persons (see participants.js)
  audience TEXT NOT NULL DEFAULT 'selected' CHECK (audience IN ('all','selected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  space_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_occasions_space ON occasions(space_id);
-- Occasion types per space (seeded and managed in occasion-types.js); occasions.type holds the key.
-- Built-in rows (builtin_key set) have no name: label, icon, default date and flag come from the code/i18n; only sort and hidden are per space.
CREATE TABLE IF NOT EXISTS occasion_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  builtin_key TEXT,
  name TEXT,
  icon TEXT NOT NULL DEFAULT 'calendar',
  default_month_day TEXT,
  default_recurring INTEGER NOT NULL DEFAULT 0,
  default_audience TEXT NOT NULL DEFAULT 'selected' CHECK (default_audience IN ('all','selected')),
  sort INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (space_id, key),
  CHECK (builtin_key IS NULL OR name IS NULL)
);
CREATE TABLE IF NOT EXISTS occasion_persons (
  occasion_id INTEGER NOT NULL REFERENCES occasions(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  -- 1 = "not considered for this occasion" (both audiences); the person does not appear in the planning
  excluded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (occasion_id, person_id)
);
-- Gift ideas; person_id is NULL for ideas in the inbox (inbox = 1)
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER REFERENCES persons(id) ON DELETE CASCADE,
  inbox INTEGER NOT NULL DEFAULT 0,
  mentioned INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  notes TEXT,
  url TEXT,
  price REAL,
  currency TEXT,
  image_url TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'open',
  occasion_id INTEGER REFERENCES occasions(id) ON DELETE SET NULL,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  space_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_space ON items(space_id);
CREATE TABLE IF NOT EXISTS wishlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  event_date TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  share_token TEXT UNIQUE,
  link_enabled INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wishlist_id INTEGER NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  url TEXT,
  price REAL,
  currency TEXT,
  image_url TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'open',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wishlist_access (
  wishlist_id INTEGER NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via TEXT NOT NULL DEFAULT 'direct',
  added_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT,
  PRIMARY KEY (wishlist_id, user_id)
);
CREATE TABLE IF NOT EXISTS wishlist_space_access (
  wishlist_id INTEGER NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  added_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wishlist_id, space_id)
);
CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT,
  url TEXT,
  shop TEXT,
  image_url TEXT,
  occasion_id INTEGER REFERENCES occasions(id) ON DELETE SET NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  wish_id INTEGER REFERENCES wishes(id) ON DELETE SET NULL,
  price REAL,
  status TEXT NOT NULL DEFAULT 'planned',
  payer_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
  date TEXT,
  ordered_at TEXT,
  order_number TEXT,
  carrier TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  expected_at TEXT,
  delivered_at TEXT,
  given_at TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  paid_at TEXT,
  payment_method TEXT,
  paid_amount REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  space_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gifts_space ON gifts(space_id);
CREATE TABLE IF NOT EXISTS gift_recipients (
  gift_id INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  PRIMARY KEY (gift_id, person_id)
);
CREATE TABLE IF NOT EXISTS gift_givers (
  gift_id INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  amount REAL,
  settled INTEGER NOT NULL DEFAULT 0,
  settled_at TEXT,
  settle_method TEXT,
  PRIMARY KEY (gift_id, person_id)
);
CREATE TABLE IF NOT EXISTS gift_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gift_id INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  user_id INTEGER,
  type TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gift_events_gift ON gift_events(gift_id);
-- Idempotency log of offline-capable writes (X-Op-Id, see offline-ops.js): a repeated request is answered without running the handler again.
-- created_id: row created by the op (X-Created-Id); ref_id: wishlist of a deleted wish (to rebuild the list view). Pruned by retention.js.
CREATE TABLE IF NOT EXISTS client_ops (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  op_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  created_id INTEGER,
  ref_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, op_id)
);
CREATE INDEX IF NOT EXISTS idx_client_ops_created ON client_ops(created_at);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wish_id INTEGER NOT NULL UNIQUE REFERENCES wishes(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  guest_name TEXT,
  gift_id INTEGER REFERENCES gifts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Two-factor authentication (core in twofactor.js)
CREATE TABLE IF NOT EXISTS user_totp (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  last_step INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_webauthn (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_webauthn_user ON user_webauthn(user_id);
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_recovery_user ON user_recovery_codes(user_id);

-- API keys (apikeys.js)
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '["read","write"]',
  space_id INTEGER,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  last_used_ip TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- Audit log (audit.js)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_user_id INTEGER,
  actor_label TEXT,
  via TEXT NOT NULL DEFAULT 'anonymous',
  ip TEXT,
  user_agent TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_label TEXT,
  space_id INTEGER,
  status TEXT NOT NULL DEFAULT 'ok',
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, id);

-- AI usage (ai/usage.js); the daily rollup is kept after old single rows are deleted (user_id 0 = unknown/deleted)
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  feature TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  error_code TEXT,
  cost REAL,
  price_snapshot TEXT,
  via TEXT NOT NULL DEFAULT 'ui',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  feature TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  unpriced INTEGER NOT NULL DEFAULT 0,
  latency_ms_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, feature, provider, model)
);
`)

export const TABLES = {
  persons: ['name', 'birthday', 'emoji', 'color', 'notes', 'yearly_budget', 'archived', 'linked_user_id', 'relationship', 'relationship_group', 'email'],
  occasions: ['name', 'type', 'date', 'recurring', 'series_id', 'person_id', 'budget', 'notes', 'audience'],
  items: ['person_id', 'mentioned', 'title', 'notes', 'url', 'price', 'priority', 'status', 'occasion_id', 'source', 'image_url', 'currency'],
  gifts: ['title', 'notes', 'url', 'shop', 'occasion_id', 'item_id', 'price', 'status', 'payer_id', 'date', 'image_url', 'wish_id',
    'ordered_at', 'order_number', 'carrier', 'tracking_number', 'tracking_url', 'expected_at', 'delivered_at', 'given_at',
    'payment_status', 'paid_at', 'payment_method', 'paid_amount'],
}

export const norm = (v) => (v === undefined || v === '' ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)

export function insert(table, body, spaceId) {
  const cols = TABLES[table].filter((c) => body[c] !== undefined)
  const names = [...cols, 'space_id']
  const sql = `INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`
  const res = db.prepare(sql).run(...cols.map((c) => norm(body[c])), spaceId)
  return Number(res.lastInsertRowid)
}

export function update(table, id, body) {
  const cols = TABLES[table].filter((c) => body[c] !== undefined)
  if (!cols.length) return
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`
  db.prepare(sql).run(...cols.map((c) => norm(body[c])), id)
}

// Re-entrant transaction (inner calls run inside the outer one)
let txDepth = 0
export function tx(fn) {
  if (txDepth > 0) return fn()
  db.exec('BEGIN')
  txDepth++
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  } finally {
    txDepth--
  }
}

export function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Date `MM-DD` in a year; Feb 29 falls back to Feb 28 in non-leap years. */
export function dateInYear(year, md) {
  return `${year}-${md === '02-29' && !isLeap(year) ? '02-28' : md}`
}

export function nextBirthday(birthday, today = todayStr()) {
  const md = birthday.slice(5)
  const year = Number(today.slice(0, 4))
  const thisYear = dateInYear(year, md)
  return thisYear >= today ? thisYear : dateInYear(year + 1, md)
}

/** Ensures birthdays and recurring occasions in a space always have an upcoming date. */
export function ensureUpcoming(spaceId) {
  const today = todayStr()
  tx(() => {
    const persons = db
      .prepare('SELECT id, birthday FROM persons WHERE space_id=? AND birthday IS NOT NULL AND archived=0')
      .all(spaceId)
    // Title in the language of the space owner (the client shows birthdays localized anyway)
    const ownerLocale = db.prepare("SELECT u.locale FROM space_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=? ORDER BY m.role='owner' DESC, m.user_id LIMIT 1").get(spaceId)?.locale
    for (const p of persons) {
      const exists = db
        .prepare("SELECT id FROM occasions WHERE space_id=? AND type='birthday' AND person_id=? AND date>=?")
        .get(spaceId, p.id, today)
      if (!exists) {
        const id = insert(
          'occasions',
          { name: ownerLocale === 'de' ? 'Geburtstag' : 'Birthday', type: 'birthday', date: nextBirthday(p.birthday, today), person_id: p.id },
          spaceId,
        )
        // A person who was left out of the last birthday stays left out of the next one
        const prev = db
          .prepare(
            `SELECT op.excluded FROM occasions o JOIN occasion_persons op ON op.occasion_id=o.id AND op.person_id=?
             WHERE o.space_id=? AND o.type='birthday' AND o.person_id=? AND o.id!=? ORDER BY o.date DESC LIMIT 1`,
          )
          .get(p.id, spaceId, p.id, id)
        db.prepare('INSERT INTO occasion_persons (occasion_id, person_id, excluded) VALUES (?,?,?)').run(id, p.id, prev?.excluded ?? 0)
      }
    }
    const series = db
      .prepare(
        "SELECT series_id, MAX(date) AS last FROM occasions WHERE space_id=? AND recurring=1 AND type!='birthday' AND series_id IS NOT NULL GROUP BY series_id",
      )
      .all(spaceId)
    for (const s of series) {
      if (s.last >= today) continue
      const src = db.prepare('SELECT * FROM occasions WHERE space_id=? AND series_id=? AND date=?').get(spaceId, s.series_id, s.last)
      // A Feb 29 series falls back to Feb 28 in non-leap years and returns to Feb 29 afterwards
      let md = s.last.slice(5)
      if (md === '02-28' && db.prepare("SELECT 1 FROM occasions WHERE space_id=? AND series_id=? AND substr(date,6)='02-29'").get(spaceId, s.series_id)) md = '02-29'
      let year = Number(s.last.slice(0, 4))
      let date = s.last
      while (date < today) date = dateInYear(++year, md)
      const id = insert('occasions', { ...src, date }, spaceId)
      db.prepare('INSERT INTO occasion_persons (occasion_id, person_id, excluded) SELECT ?, person_id, excluded FROM occasion_persons WHERE occasion_id=?').run(id, src.id)
    }
  })
}

/**
 * Writes the participation rows of an occasion. `personIds` = explicit participants (rows with excluded=0, meaningful for audience
 * 'selected'), `excludedIds` = left out persons; undefined keeps the current state of that part. Rows of persons in `hidden`
 * (surprise protection: the writer cannot see them) are never dropped or altered; a hidden person can only be added as participant.
 * An excluded person wins over a selected one.
 */
export function setOccasionParticipants(id, audience, { personIds, excludedIds } = {}, hidden = new Set()) {
  const cur = new Map(db.prepare('SELECT person_id, excluded FROM occasion_persons WHERE occasion_id=?').all(id).map((r) => [r.person_id, r.excluded]))
  const sel = personIds ?? [...cur].filter(([, e]) => !e).map(([p]) => p)
  const exc = new Set(excludedIds ?? [...cur].filter(([, e]) => e).map(([p]) => p))
  const next = new Map()
  for (const [p, e] of cur) if (hidden.has(p)) next.set(p, e)
  if (audience === 'selected') for (const p of sel) if (!next.has(p) && !exc.has(p)) next.set(p, 0)
  for (const p of exc) if (!next.has(p) && !hidden.has(p)) next.set(p, 1)
  db.prepare('DELETE FROM occasion_persons WHERE occasion_id=?').run(id)
  for (const [p, e] of next) db.prepare('INSERT INTO occasion_persons (occasion_id, person_id, excluded) VALUES (?,?,?)').run(id, p, e)
}

export function setGiftLinks(id, body) {
  if (body.recipient_ids) {
    db.prepare('DELETE FROM gift_recipients WHERE gift_id=?').run(id)
    for (const pid of new Set(body.recipient_ids)) db.prepare('INSERT INTO gift_recipients VALUES (?,?)').run(id, pid)
  }
  if (body.givers) {
    const old = new Map(db.prepare('SELECT * FROM gift_givers WHERE gift_id=?').all(id).map((r) => [r.person_id, r]))
    db.prepare('DELETE FROM gift_givers WHERE gift_id=?').run(id)
    const seen = new Set()
    for (const g of body.givers) {
      if (seen.has(g.person_id)) continue
      seen.add(g.person_id)
      const o = old.get(g.person_id)
      const settled = g.settled === undefined ? (o?.settled ?? 0) : g.settled ? 1 : 0
      const at = settled ? (g.settled_at ?? o?.settled_at ?? todayStr()) : null
      const method = settled ? (g.settle_method ?? o?.settle_method ?? null) : null
      db.prepare('INSERT INTO gift_givers (gift_id,person_id,amount,settled,settled_at,settle_method) VALUES (?,?,?,?,?,?)').run(
        id, g.person_id, norm(g.amount), settled, at, method,
      )
    }
  }
}

// ---- Helpers for user settings (independent of system settings) ----
export function userSettings(userId) {
  const r = db.prepare('SELECT settings FROM users WHERE id=?').get(userId)
  try {
    return JSON.parse(r?.settings || '{}') || {}
  } catch {
    return {}
  }
}
export function setUserSetting(userId, key, value) {
  const s = userSettings(userId)
  s[key] = value ?? null
  db.prepare('UPDATE users SET settings=? WHERE id=?').run(JSON.stringify(s), userId)
}

// Clean up expired sessions/invitations
export function cleanup() {
  const now = Date.now()
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now)
  db.prepare('DELETE FROM space_invites WHERE expires_at<?').run(now)
  db.prepare('DELETE FROM user_invites WHERE expires_at<?').run(now)
  db.prepare('DELETE FROM password_resets WHERE expires_at<?').run(now)
}

// ---- Access via spaces ----
/** SQL condition (aliases a = wishlist_access, w = wishlists): the access row is valid. */
export const ACCESS_OK_SQL = `(a.via='direct' OR (a.via='link' AND w.link_enabled=1) OR (a.via='space' AND EXISTS (
  SELECT 1 FROM wishlist_space_access s JOIN space_members m ON m.space_id=s.space_id WHERE s.wishlist_id=w.id AND m.user_id=a.user_id)))`

/** Syncs a list's access rows (via 'space') with the members of the shared spaces. */
export function syncSpaceAccessForList(listId) {
  const l = db.prepare('SELECT owner_user_id FROM wishlists WHERE id=?').get(listId)
  if (!l) return
  tx(() => {
    db.prepare(
      `INSERT OR IGNORE INTO wishlist_access (wishlist_id,user_id,via,added_by)
       SELECT DISTINCT s.wishlist_id, m.user_id, 'space', s.added_by FROM wishlist_space_access s
       JOIN space_members m ON m.space_id=s.space_id WHERE s.wishlist_id=? AND m.user_id!=?`,
    ).run(listId, l.owner_user_id)
    db.prepare(
      `DELETE FROM wishlist_access WHERE wishlist_id=? AND via='space' AND NOT EXISTS (
         SELECT 1 FROM wishlist_space_access s JOIN space_members m ON m.space_id=s.space_id
         WHERE s.wishlist_id=wishlist_access.wishlist_id AND m.user_id=wishlist_access.user_id)`,
    ).run(listId)
  })
}
/** The same from a user's point of view (after joining/leaving). */
export function syncSpaceAccessForUser(userId) {
  tx(() => {
    db.prepare(
      `INSERT OR IGNORE INTO wishlist_access (wishlist_id,user_id,via,added_by)
       SELECT DISTINCT s.wishlist_id, ?, 'space', s.added_by FROM wishlist_space_access s
       JOIN space_members m ON m.space_id=s.space_id AND m.user_id=?
       JOIN wishlists w ON w.id=s.wishlist_id WHERE w.owner_user_id!=?`,
    ).run(userId, userId, userId)
    db.prepare(
      `DELETE FROM wishlist_access WHERE user_id=? AND via='space' AND NOT EXISTS (
         SELECT 1 FROM wishlist_space_access s JOIN space_members m ON m.space_id=s.space_id
         WHERE s.wishlist_id=wishlist_access.wishlist_id AND m.user_id=wishlist_access.user_id)`,
    ).run(userId)
  })
}

// ---- Gift history ----
export function logGiftEvent(giftId, userId, type, data) {
  db.prepare('INSERT INTO gift_events (gift_id, user_id, type, data) VALUES (?,?,?,?)').run(
    giftId, userId ?? null, type, data === undefined ? null : JSON.stringify(data),
  )
}

export const RELATIONSHIP_GROUPS = ['partner', 'family', 'friends', 'work', 'other']
