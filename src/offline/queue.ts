/** Rules of the queue: order, dependencies, collapsing changes of rows that were never sent. Pure: no DOM, React or i18n. */
import { resolveIds, resolveUrl, tempRefs, type IdMap } from './routes.ts'
import type { Op } from './types.ts'

export const recordKey = (op: Pick<Op, 'kind' | 'target'>) => `${op.kind}:${op.target}`

/** Temp ids of queued rows this op needs */
export function refsOf(op: Op): Set<number> {
  const refs = tempRefs(op.url, op.body)
  if (op.sub < 0) refs.add(op.sub)
  if (op.action !== 'create' && op.target < 0) refs.add(op.target)
  return refs
}

/** Replaces temp ids that were mapped to real ones in every part of an op */
export function resolveOp(op: Op, map: IdMap): Op {
  if (!map.size) return op
  const id = (n: number) => map.get(n) ?? n
  return {
    ...op,
    target: op.action === 'create' ? op.target : id(op.target),
    sub: id(op.sub),
    url: resolveUrl(op.url, map),
    body: resolveIds(op.body, map),
    base: resolveIds(op.base, map),
    mine: resolveIds(op.mine, map),
    record: resolveIds(op.record, map),
  }
}

/** The next op to send: in order; an op waits for an unresolved earlier one of the same record and for rows that could not be created. */
export function nextOp(ops: Op[]): Op | null {
  const stuck = new Set<string>()
  const missing = new Set<number>()
  for (const op of ops) {
    if (op.status === 'pending' && !stuck.has(recordKey(op)) && ![...refsOf(op)].some((r) => missing.has(r))) return op
    stuck.add(recordKey(op))
    if (op.action === 'create') missing.add(op.target)
  }
  return null
}

/** The row of this create certainly does not exist (a refused op leaves nothing behind on the server) */
const neverMade = (op: Op) => op.status === 'failed' || op.attempts === 0

export interface Append { add: Op | null; replace: Op | null; remove: Op[] }
/** How a new op enters the queue */
export function append(ops: Op[], op: Op): Append {
  const plain: Append = { add: op, replace: null, remove: [] }
  if (op.target >= 0 || op.action === 'create') return plain
  const create = ops.find((o) => o.action === 'create' && o.target === op.target)
  if (!create || !neverMade(create)) return plain
  const own = ops.filter((o) => o !== create && recordKey(o) === recordKey(op))
  if (op.action === 'delete') {
    // Nothing else uses the row: it simply never existed
    const used = ops.some((o) => o !== create && !own.includes(o) && refsOf(o).has(op.target))
    return used ? plain : { add: null, replace: null, remove: [create, ...own] }
  }
  // An edit right after the create becomes part of it (if it only uses rows created earlier; the create route of lists knows no "archived")
  const earlier = [...tempRefs('', op.body)].every((id) => id > create.target)
  if (op.action !== 'update' || own.length || !earlier || op.body?.archived) return plain
  return { add: null, replace: { ...create, body: { ...create.body, ...op.body }, label: op.label || create.label, status: 'pending', error: undefined }, remove: [] }
}

/** Ops that cannot be sent without `op` (they use a row it would have created), in order */
export function dependents(ops: Op[], op: Op): Op[] {
  if (op.action !== 'create') return []
  const gone = new Set([op.target])
  const out: Op[] = []
  for (const o of ops) {
    if (o.seq === op.seq || ![...refsOf(o)].some((r) => gone.has(r))) continue
    out.push(o)
    if (o.action === 'create') gone.add(o.target)
  }
  return out
}
