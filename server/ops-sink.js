// Carries the ids an offline-capable write creates from the route handler to offline-ops.js (X-Created-Id header, client_ops row).
// The handlers are synchronous, so one module-level slot that the middleware sets around `next()` is enough.
let current = null

/** Runs fn with `sink` active; the slot is always cleared afterwards. */
export function withSink(sink, fn) {
  current = sink
  try {
    return fn()
  } finally {
    current = null
  }
}

/** The id of the row a create route made (the first call wins; calls outside an offline-capable request do nothing). */
export function noteCreated(id) {
  if (current && current.created == null && Number.isInteger(id)) current.created = id
  return id
}

/** An id the repeat response of a DELETE needs later (the wishlist of a deleted wish). */
export function noteRef(id) {
  if (current && Number.isInteger(id)) current.ref = id
  return id
}
