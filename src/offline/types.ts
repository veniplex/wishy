/** Types of the offline engine (types only: the pure modules are also loaded by plain node in the tests). */
export type Kind = 'person' | 'occasion' | 'item' | 'gift' | 'list' | 'wish'
export type Action = 'create' | 'update' | 'delete' | 'exclude' | 'assign' | 'status' | 'payment' | 'settle' | 'reorder'

/** An offline-capable write route */
export interface Route {
  kind: Kind
  action: Action
  /** Id of the record (0 for creates until a temp id is given) */
  target: number
  /** Second id: person of exclude/settle, wishlist of a wish */
  sub: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>
/** Comparable values per unit (a unit = one field or an atomic group of fields) */
export type Values = Record<string, Row>

export interface FieldConflict { unit: string; mine: Row | null; theirs: Row }
export interface Conflict {
  /** changed = someone else edited the same field(s); gone = the record no longer exists */
  kind: 'changed' | 'gone'
  fields: FieldConflict[]
}

/** A queued change */
export interface Op extends Route {
  /** Order of the queue (key in IndexedDB) */
  seq: number
  /** Sent as X-Op-Id: the server runs an op only once */
  opId: string
  user: number
  /** Space of planning changes; null for wishlists (they belong to the user) */
  space: number | null
  method: string
  url: string
  body: Row | null
  /** Values before / after the change, only the units that differ (deletes: all units, `mine` empty) */
  base: Values
  mine: Values
  /** The record as the user saw it (wish counts, "create again") */
  record: Row | null
  /** Name/title for the list of pending changes */
  label: string
  at: string
  /** Requests that may have reached the server */
  attempts: number
  status: 'pending' | 'conflict' | 'failed'
  conflict?: Conflict
  error?: { code?: string; error?: string; params?: unknown }
}

/** The server's data a queued change is compared with */
export interface ServerData {
  state?: Row | null
  /** Detail view of the wishlist the change belongs to */
  detail?: Row | null
}
