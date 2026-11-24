// Pure parts of the offline client (src/offline: routes, overlay, conflicts, queue): which writes can be queued, rewriting of temp ids,
// what a page shows while changes are queued, which changes may be sent against newer data, order and dependencies of the queue.
// No server, no browser; node loads the TypeScript modules directly (type stripping).
import { parseWrite, resolveIds, resolveUrl, tempRefs } from '../../src/offline/routes.ts'
import { applyToDetail, applyToOverview, applyToState, localDate } from '../../src/offline/overlay.ts'
import { decide, diff, findRecord, keepMine, keepTheirs, rebase, recreateBody } from '../../src/offline/conflicts.ts'
import { append, dependents, nextOp, refsOf, resolveOp } from '../../src/offline/queue.ts'

let pass = 0
let failN = 0
const t = (name, cond, extra) => {
  if (cond) return void pass++
  failN++
  console.log('FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 600) : ''))
}
const eq = (name, a, b) => t(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b })

// ---------- Fixtures ----------
const TODAY = '2026-06-15'
const person = (id, name, more = {}) => ({ id, name, is_me: 0, linked_user_id: null, birthday: null, emoji: null, color: null, notes: null, yearly_budget: null, archived: 0, relationship: null, email: null, ...more })
const occasion = (id, name, date, more = {}) => ({ id, name, type: 'other', date, recurring: 0, series_id: null, person_id: null, budget: null, notes: null, audience: 'selected', person_ids: [], excluded_ids: [], ...more })
const item = (id, title, more = {}) => ({ id, person_id: null, occasion_id: null, mentioned: 0, title, notes: null, url: null, price: null, priority: 2, status: 'open', source: null, image_url: null, currency: null, inbox: 0, created_at: '2026-01-01 10:00:00', ...more })
const gift = (id, title, more = {}) => ({
  id, title, notes: null, url: null, shop: null, occasion_id: null, item_id: null, wish_id: null, price: null, status: 'planned', payer_id: null, date: null, image_url: null, ordered_at: null, order_number: null, carrier: null,
  tracking_number: null, tracking_url: null, expected_at: null, delivered_at: null, given_at: null, payment_status: 'unpaid', paid_at: null, payment_method: null, paid_amount: null, created_at: '2026-01-01 10:00:00', recipient_ids: [], givers: [], ...more,
})
const state = (more = {}) => ({
  today: TODAY, space_id: 5, user_id: 1, permissions: {}, settings: { currency: 'EUR', yearly_budget: null },
  persons: [person(1, 'Me', { is_me: 1, linked_user_id: 1 }), person(2, 'Anna'), person(3, 'Ben')],
  occasion_types: [{ key: 'christmas', default_audience: 'all' }, { key: 'other', default_audience: 'selected' }],
  occasions: [occasion(10, 'Christmas', '2026-12-24', { type: 'christmas', audience: 'all', person_ids: [2, 3], series_id: 's1', recurring: 1 })],
  items: [item(20, 'Book', { person_id: 2, occasion_id: 10, image_url: '/api/images/a.jpg' })],
  inbox_items: [item(21, 'Later', { inbox: 1 })],
  gifts: [gift(30, 'Bike', { recipient_ids: [2], givers: [{ person_id: 1, amount: null, settled: 0 }, { person_id: 3, amount: null, settled: 0 }], price: 100, item_id: 20 })],
  ...more,
})
const overview = () => ({ mine: [{ id: 7, title: 'Wishes', description: null, event_date: null, archived: false, wish_count: 2, open_count: 2, access: [], spaces: [] }], shared: [] })
const wish = (id, title, more = {}) => ({ id, title, notes: null, url: null, price: null, currency: null, image_url: null, priority: 2, status: 'open', created_at: 'x', ...more })
const detail = () => ({ wishlist: overview().mine[0], wishes: [wish(40, 'Lamp'), wish(41, 'Chair')], is_owner: true })

let seq = 0
/** A queued op built like the engine does it */
function op(method, url, body, data = {}, more = {}) {
  const route = parseWrite(method, url)
  if (more.target !== undefined) route.target = more.target
  if (more.sub !== undefined) route.sub = more.sub
  const list = route.kind === 'list' || route.kind === 'wish'
  const record = route.action === 'create' ? null : findRecord(route, data)
  const d = diff(route, body ?? null, record ?? {})
  return { ...route, ...d, seq: ++seq, opId: 'op' + seq, user: 1, space: list ? null : 5, method, url, record, label: '', at: '2026-06-15T10:00:00.000Z', attempts: 0, status: 'pending', ...more }
}

// ---------- Routes ----------
{
  eq('route person create', parseWrite('POST', '/api/persons'), { kind: 'person', action: 'create', target: 0, sub: 0 })
  eq('route gift status', parseWrite('POST', '/api/gifts/-5/status'), { kind: 'gift', action: 'status', target: -5, sub: 0 })
  eq('route settle', parseWrite('POST', '/api/gifts/5/givers/-9/settle'), { kind: 'gift', action: 'settle', target: 5, sub: -9 })
  eq('route exclude', parseWrite('PUT', '/api/occasions/5/persons/9'), { kind: 'occasion', action: 'exclude', target: 5, sub: 9 })
  eq('route new wish', parseWrite('POST', '/api/wishlists/-3/wishes'), { kind: 'wish', action: 'create', target: 0, sub: -3 })
  eq('route reorder', parseWrite('POST', '/api/wishlists/3/reorder'), { kind: 'list', action: 'reorder', target: 3, sub: 0 })
  const online = [['POST', '/api/wishlists/3/share'], ['POST', '/api/wishes/3/reserve'], ['DELETE', '/api/wishlists/3/access/me'], ['POST', '/api/persons/3/link'], ['POST', '/api/settle'], ['PUT', '/api/settings'],
    ['POST', '/api/wishes'], ['POST', '/api/persons/3'], ['PUT', '/api/persons'], ['POST', '/api/occasion-types'], ['POST', '/api/relationship-types'], ['POST', '/api/ai/suggest'], ['PUT', '/api/account'], ['POST', '/api/gifts/5/givers/9/other']]
  for (const [m, u] of online) t(`online only: ${m} ${u}`, parseWrite(m, u) === null)
}

// ---------- Temp ids ----------
{
  const map = new Map([[-1001, 50], [-1002, 60]])
  const body = { person_id: -1001, recipient_ids: [-1001, 4], givers: [{ person_id: -1002, amount: 3 }], occasion_id: -1003, title: 'x', price: -1001 }
  eq('rewrite body', resolveIds(body, map), { person_id: 50, recipient_ids: [50, 4], givers: [{ person_id: 60, amount: 3 }], occasion_id: -1003, title: 'x', price: -1001 })
  eq('all id fields', resolveIds({ person_ids: [-1001], excluded_ids: [-1002], ids: [-1001], payer_id: -1001, item_id: -1002, from_id: -1001, to_id: -1002 }, map), { person_ids: [50], excluded_ids: [60], ids: [50], payer_id: 50, item_id: 60, from_id: 50, to_id: 60 })
  const same = { person_id: 4, list: [{ person_id: 3 }] }
  t('untouched object is the same', resolveIds(same, map) === same)
  eq('rewrite path', resolveUrl('/api/gifts/-1001/givers/-1002/settle', map), '/api/gifts/50/givers/60/settle')
  eq('unknown temp id stays', resolveUrl('/api/gifts/-1003', map), '/api/gifts/-1003')
  eq('refs', [...tempRefs('/api/gifts/-1001/status', body)].sort(), [-1001, -1002, -1003].sort())
  t('a negative number elsewhere is no id', !tempRefs('/api/x', { price: -5 }).size)
}

// ---------- Overlay: planning state ----------
{
  const s = state()
  const frozen = JSON.stringify(s)
  const p = op('POST', '/api/persons', { name: 'Carl', emoji: '', archived: false }, {}, { target: -1001 })
  let v = applyToState(s, p)
  t('new person', v.persons.some((x) => x.id === -1001 && x.name === 'Carl' && x.emoji === null && x.archived === 0))
  eq('new person joins an occasion for everyone', v.occasions[0].person_ids, [2, 3, -1001])
  eq('sorted: me first', v.persons.map((x) => x.name), ['Me', 'Anna', 'Ben', 'Carl'])
  t('input untouched', JSON.stringify(s) === frozen)
  t('other space untouched', applyToState(state({ space_id: 6 }), p).persons.length === 3)

  v = applyToState(v, op('POST', '/api/items', { title: 'Socks', person_id: -1001, occasion_id: 10 }, {}, { target: -1002 }))
  t('idea of a new person', v.items.some((x) => x.id === -1002 && x.person_id === -1001 && x.priority === 2 && x.status === 'open'))
  v = applyToState(v, op('POST', '/api/gifts', { title: 'Socks', item_id: -1002, recipient_ids: [], givers: [{ person_id: 1, amount: '' }] }, {}, { target: -1003 }))
  const g = v.gifts.find((x) => x.id === -1003)
  eq('gift inherits person and occasion of the idea', [g.recipient_ids, g.occasion_id, g.status], [[-1001], 10, 'planned'])
  eq('gift givers', g.givers[0], { person_id: 1, amount: null, settled: 0, settled_at: null, settle_method: null })
  v = applyToState(v, op('POST', '/api/gifts/-1003/status', { status: 'ordered' }, { state: v }))
  eq('status sets its date', [v.gifts.find((x) => x.id === -1003).status, v.gifts.find((x) => x.id === -1003).ordered_at], ['ordered', TODAY])
  v = applyToState(v, op('DELETE', '/api/persons/-1001', undefined, { state: v }))
  t('deleting a person: ideas go, gifts stay without them', !v.items.some((x) => x.id === -1002) && v.gifts.find((x) => x.id === -1003).recipient_ids.length === 0 && !v.occasions[0].person_ids.includes(-1001))

  v = applyToState(s, op('PUT', '/api/occasions/10/persons/2', { excluded: true }, { state: s }))
  eq('leave out', [v.occasions[0].person_ids, v.occasions[0].excluded_ids], [[3], [2]])
  v = applyToState(v, op('PUT', '/api/occasions/10/persons/2', { excluded: false }, { state: v }))
  eq('include again', [v.occasions[0].person_ids, v.occasions[0].excluded_ids], [[2, 3], []])
  v = applyToState(s, op('PUT', '/api/occasions/10', { audience: 'selected', person_ids: [2, 3], excluded_ids: [3], name: 'Xmas' }, { state: s }))
  eq('left out wins over selected', [v.occasions[0].audience, v.occasions[0].person_ids, v.occasions[0].name], ['selected', [2], 'Xmas'])
  v = applyToState(s, op('POST', '/api/occasions', { name: 'C', type: 'christmas', date: '2027-12-24', recurring: true }, {}, { target: -1004 }))
  eq('type default audience', [v.occasions[1].audience, v.occasions[1].person_ids, v.occasions[1].recurring], ['all', [2, 3], 1])
  v = applyToState(s, op('DELETE', '/api/occasions/10', undefined, { state: s }))
  t('deleting an occasion detaches ideas', v.occasions.length === 0 && v.items[0].occasion_id === null)

  v = applyToState(s, op('POST', '/api/items/21/assign', { person_id: 3 }, { state: s }))
  t('assign from inbox', v.inbox_items.length === 0 && v.items.some((x) => x.id === 21 && x.person_id === 3))
  v = applyToState(s, op('POST', '/api/items', { title: 'Inbox idea' }, {}, { target: -1005 }))
  t('idea without person lands in the inbox', v.inbox_items.some((x) => x.id === -1005) && v.items.length === 1)
  v = applyToState(s, op('DELETE', '/api/items/20', undefined, { state: s }))
  t('deleting an idea detaches the gift', v.items.length === 0 && v.gifts[0].item_id === null)

  v = applyToState(s, op('POST', '/api/gifts/30/payment', { payment_status: 'paid', payer_id: 1, paid_at: null }, { state: s }))
  eq('payment: open share of the other giver', v.gifts[0].payment_summary, { paid: true, payer_id: 1, open_amount: 50, open_count: 1 })
  t('payer is settled, date set', v.gifts[0].givers[0].settled === 1 && v.gifts[0].paid_at === TODAY)
  v = applyToState(v, op('POST', '/api/gifts/30/givers/3/settle', { settled: true, method: 'Cash' }, { state: v }))
  eq('settle', [v.gifts[0].payment_summary.open_count, v.gifts[0].givers[1].settle_method], [0, 'Cash'])
  v = applyToState(v, op('POST', '/api/gifts/30/payment', { payment_status: 'unpaid' }, { state: v }))
  eq('unpaid', [v.gifts[0].payment_status, v.gifts[0].paid_at, v.gifts[0].paid_amount], ['unpaid', null, null])

  const b = state({ persons: [person(1, 'Me', { is_me: 1 }), person(2, 'Anna', { birthday: '1990-03-01' })], occasions: [occasion(11, 'Birthday', '2027-03-01', { type: 'birthday', person_id: 2, person_ids: [2] })] })
  eq('birthday moves', applyToState(b, op('PUT', '/api/persons/2', { birthday: '1990-08-01' }, { state: b })).occasions[0].date, '2026-08-01')
  eq('birthday removed', applyToState(b, op('PUT', '/api/persons/2', { birthday: '' }, { state: b })).occasions.length, 0)
  t('local date', /^\d{4}-\d\d-\d\d$/.test(localDate()) && localDate(new Date(2026, 0, 5)) === '2026-01-05')
}

// ---------- Overlay: wishlists ----------
{
  let o = applyToOverview(overview(), op('POST', '/api/wishlists', { title: 'New' }, {}, { target: -2001 }))
  t('new list', o.mine.length === 2 && o.mine[1].id === -2001 && o.mine[1].wish_count === 0 && o.mine[1].token === '')
  const add = op('POST', '/api/wishlists/7/wishes', { title: 'Cup', notes: '' }, {}, { target: -2002 })
  o = applyToOverview(overview(), add)
  eq('counts', [o.mine[0].wish_count, o.mine[0].open_count], [3, 3])
  let d = applyToDetail(detail(), add, 7)
  t('new wish', d.wishes.length === 3 && d.wishes[2].id === -2002 && d.wishes[2].notes === null && d.wishlist.wish_count === 3)
  const got = op('PUT', '/api/wishes/40', { status: 'received' }, { detail: detail() }, { sub: 7 })
  d = applyToDetail(detail(), got, 7)
  eq('received', [d.wishes[0].status, d.wishlist.open_count, d.wishlist.wish_count], ['received', 1, 2])
  eq('received in overview', applyToOverview(overview(), got).mine[0].open_count, 1)
  d = applyToDetail(detail(), op('POST', '/api/wishlists/7/reorder', { ids: [41, 40] }, {}), 7)
  eq('reorder', d.wishes.map((w) => w.id), [41, 40])
  t('other list untouched', applyToDetail(detail(), add, 8).wishes.length === 2)
  t('deleted list', applyToDetail(detail(), op('DELETE', '/api/wishlists/7', undefined, { detail: detail() }), 7) === null)
  d = applyToDetail(null, op('POST', '/api/wishlists', { title: 'New' }, {}, { target: -2001 }), -2001)
  d = applyToDetail(d, op('POST', '/api/wishlists/-2001/wishes', { title: 'Cup' }, {}, { target: -2002 }), -2001)
  t('list that exists only in the queue', d.wishlist.title === 'New' && d.wishes[0].title === 'Cup' && d.is_owner)
}

// ---------- Diff ----------
{
  const s = state()
  const form = { name: 'Anna', emoji: '', relationship: '', birthday: '', yearly_budget: null, notes: 'Likes tea', archived: false, email: '' }
  const o = op('PUT', '/api/persons/2', form, { state: s })
  eq('only the changed field', [o.body, o.base, o.mine], [{ notes: 'Likes tea' }, { notes: { notes: null } }, { notes: { notes: 'Likes tea' } }])
  eq('no change', Object.keys(op('PUT', '/api/persons/2', { ...form, notes: '' }, { state: s }).base), [])
  const occ = op('PUT', '/api/occasions/10', { name: 'Christmas', audience: 'all', excluded_ids: [2], person_ids: undefined, date: '2026-12-24' }, { state: s })
  eq('participants are one unit', [Object.keys(occ.base), occ.body], [['participants'], { audience: 'all', excluded_ids: [2] }])
  const g = op('PUT', '/api/gifts/30', { title: 'Bike', recipient_ids: [2], givers: [{ person_id: 3, amount: null }, { person_id: 1, amount: null }], price: 100 }, { state: s })
  eq('order of givers does not matter', Object.keys(g.base), [])
  eq('no-op status', Object.keys(op('POST', '/api/gifts/30/status', { status: 'planned' }, { state: s }).base), [])
}

// ---------- Conflicts ----------
{
  const s = state()
  const put = (body) => op('PUT', '/api/persons/2', body, { state: s })
  const server = (more) => ({ state: state({ persons: [person(1, 'Me', { is_me: 1 }), person(2, 'Anna', more)] }) })
  const o = put({ name: 'Anne', notes: 'Tea' })
  eq('unchanged on the server: send', decide(o, server({})), { do: 'send', body: { name: 'Anne', notes: 'Tea' } })
  eq('another field changed: merge', decide(o, server({ email: 'a@example.com' })), { do: 'send', body: { name: 'Anne', notes: 'Tea' } })
  eq('same value there already: only the rest', decide(o, server({ name: 'Anne' })), { do: 'send', body: { notes: 'Tea' } })
  eq('everything there already (lost response)', decide(o, server({ name: 'Anne', notes: 'Tea' })), { do: 'done' })
  const c = decide(o, server({ notes: 'Coffee' }))
  eq('same field changed: conflict', c, { do: 'conflict', conflict: { kind: 'changed', fields: [{ unit: 'notes', mine: { notes: 'Tea' }, theirs: { notes: 'Coffee' } }] } })
  eq('record deleted meanwhile', decide(o, { state: state({ persons: [] }) }), { do: 'conflict', conflict: { kind: 'gone', fields: [] } })

  const bad = { ...o, status: 'conflict', conflict: c.conflict }
  const mine = keepMine(bad, 'notes', 'new-id')
  t('keep mine: pending with a new op id', mine.status === 'pending' && mine.opId === 'new-id' && !mine.conflict)
  eq('keep mine is sent', decide(mine, server({ notes: 'Coffee' })), { do: 'send', body: { name: 'Anne', notes: 'Tea' } })
  eq('changed again after the decision: asked again', decide(mine, server({ notes: 'Juice' })).do, 'conflict')
  const theirs = keepTheirs(bad, 'notes', 'new-id')
  eq('keep theirs: the other field is still sent', decide(theirs, server({ notes: 'Coffee' })), { do: 'send', body: { name: 'Anne' } })
  t('keep theirs: nothing left', keepTheirs({ ...put({ notes: 'Tea' }), status: 'conflict', conflict: c.conflict }, 'notes', 'x') === null)
  const two = put({ name: 'Anne', notes: 'Tea' })
  two.status = 'conflict'
  two.conflict = decide(two, server({ name: 'Anni', notes: 'Coffee' })).conflict
  const half = keepMine(two, 'name', 'x')
  t('two fields: one decision leaves the other open', half.status === 'conflict' && half.conflict.fields.length === 1)
  t('two fields: second decision', keepTheirs(half, 'notes', 'y').status === 'pending')

  const del = op('DELETE', '/api/persons/2', undefined, { state: s })
  eq('delete unchanged', decide(del, server({})).do, 'send')
  eq('delete of something already gone', decide(del, { state: state({ persons: [] }) }), { do: 'done' })
  const dc = decide(del, server({ notes: 'Coffee' }))
  eq('delete of something changed: conflict', [dc.do, dc.conflict.fields[0].unit, dc.conflict.fields[0].mine], ['conflict', 'notes', null])
  eq('delete anyway', decide(keepMine({ ...del, status: 'conflict', conflict: dc.conflict }, null, 'x'), server({ notes: 'Coffee' })).do, 'send')

  const st = op('POST', '/api/gifts/30/status', { status: 'ordered' }, { state: s })
  const gifts = (more) => ({ state: state({ gifts: [gift(30, 'Bike', { recipient_ids: [2], ...more })] }) })
  eq('status: send', decide(st, gifts({})).do, 'send')
  eq('status: done', decide(st, gifts({ status: 'ordered' })).do, 'done')
  eq('status: conflict', decide(st, gifts({ status: 'given' })).do, 'conflict')
  const pay = op('POST', '/api/gifts/30/payment', { payment_status: 'paid', payer_id: 1, paid_at: TODAY, payment_method: null, paid_amount: null }, { state: s })
  eq('payment: send whole body', decide(pay, gifts({})).body, { payment_status: 'paid', payer_id: 1, paid_at: TODAY, payment_method: null, paid_amount: null })
  eq('payment: conflict', decide(pay, gifts({ payment_status: 'paid', payer_id: 3, paid_at: TODAY })).do, 'conflict')
  const set = op('POST', '/api/gifts/30/givers/3/settle', { settled: true }, { state: s })
  const givers = (settled) => gifts({ givers: [{ person_id: 3, amount: null, settled }] })
  eq('settle', [decide(set, givers(0)).do, decide(set, givers(1)).do, decide(set, gifts({})).do], ['send', 'done', 'conflict'])
  const exc = op('PUT', '/api/occasions/10/persons/2', { excluded: true }, { state: s })
  eq('exclude', [decide(exc, { state: s }).do, decide(exc, { state: state({ occasions: [occasion(10, 'C', '2026-12-24', { audience: 'all', excluded_ids: [2] })] }) }).do], ['send', 'done'])
  const asg = op('POST', '/api/items/21/assign', { person_id: 3 }, { state: s })
  eq('assign', [decide(asg, { state: s }).do, decide(asg, { state: state({ inbox_items: [], items: [item(21, 'Later', { person_id: 3 })] }) }).do, decide(asg, { state: state({ inbox_items: [], items: [item(21, 'Later', { person_id: 2 })] }) }).do], ['send', 'done', 'conflict'])
  const ord = op('POST', '/api/wishlists/7/reorder', { ids: [41, 40] }, { detail: detail() })
  const wishes = (...w) => ({ detail: { ...detail(), wishes: w } })
  eq('reorder keeps new wishes behind and drops missing ones', decide(ord, wishes(wish(40, 'a'), wish(42, 'c'), wish(41, 'b'))), { do: 'send', body: { ids: [41, 40, 42] } })
  eq('reorder already done', decide(ord, wishes(wish(41, 'b'), wish(40, 'a'))), { do: 'done' })
  const lst = op('DELETE', '/api/wishlists/7', undefined, { detail: detail() })
  eq('list that got a new wish: ask before deleting', decide(lst, { detail: { ...detail(), wishlist: { ...overview().mine[0], wish_count: 3 } } }).do, 'conflict')

  const trimmed = put({ name: ' Anne ' })
  const later = { ...put({ notes: 'x' }), base: { name: { name: 'wrong' }, notes: { notes: null } } }
  eq('later change builds on the accepted one', rebase(later, trimmed, person(2, 'Anne', { notes: 'other' })).base, { name: { name: 'Anne' }, notes: { notes: null } })

  const again = recreateBody(op('PUT', '/api/persons/2', { notes: 'Tea' }, { state: s }))
  eq('create again', again, { name: 'Anna', notes: 'Tea', archived: 0 })
  t('a deleted record is not created again by its deletion', recreateBody(del) === null)
}

// ---------- Queue ----------
{
  const create = op('POST', '/api/persons', { name: 'Carl' }, {}, { target: -1001 })
  const idea = op('POST', '/api/items', { title: 'Socks', person_id: -1001 }, {}, { target: -1002 })
  const present = op('POST', '/api/gifts', { title: 'Socks', item_id: -1002, recipient_ids: [-1001] }, {}, { target: -1003 })
  const other = op('PUT', '/api/persons/2', { notes: 'x' }, { state: state() })
  const queue = [create, idea, present, other]
  t('in order', nextOp(queue) === create)
  eq('refs of a create do not include itself', [...refsOf(idea)], [-1001])
  t('a refused create holds back what needs it, the rest goes on', nextOp([{ ...create, status: 'failed' }, idea, present, other]) === other)
  t('a conflict holds back later changes of the same record', nextOp([{ ...other, status: 'conflict' }, op('PUT', '/api/persons/2', { name: 'y' }, { state: state() })]) === null)
  eq('what goes with a discarded create', dependents(queue, create).map((o) => o.target), [-1002, -1003])
  eq('discarding a change takes nothing along', dependents(queue, other), [])

  const full = applyToState(applyToState(state(), create), idea)
  const edit = op('PUT', '/api/items/-1002', { title: 'Warm socks' }, { state: full })
  eq('an edit of an unsent row becomes part of its create', append(queue, edit).replace?.body, { title: 'Warm socks', person_id: -1001 })
  t('not if the create may have reached the server', append([create, { ...idea, attempts: 1 }], edit).add === edit)
  const toNew = op('PUT', '/api/items/-1002', { person_id: -1009 }, { state: full })
  t('not if it uses a row created later', append(queue, toNew).add === toNew)
  const delIdea = op('DELETE', '/api/items/-1002', undefined, { state: full })
  t('a row used by another change is really created and deleted', append(queue, delIdea).add === delIdea)
  eq('deleting an unsent row removes its changes', append([create, idea, edit], delIdea), { add: null, replace: null, remove: [idea, edit] })
  t('deleting a row that may exist is sent', append([create, { ...idea, attempts: 1 }], delIdea).add === delIdea)
  t('deleting a refused row removes it', append([create, { ...idea, attempts: 1, status: 'failed' }], delIdea).remove.length === 1)

  const map = new Map([[-1001, 50], [-1002, 60]])
  const r = resolveOp(present, map)
  eq('resolved op', [r.target, r.body.item_id, r.body.recipient_ids], [-1003, 60, [50]])
  const s = resolveOp(edit, map)
  eq('resolved edit', [s.target, s.url], [60, '/api/items/60'])
  const rec = { ...op('PUT', '/api/gifts/30', { recipient_ids: [2, -1001] }, { state: state() }) }
  const srv = { state: state({ gifts: [gift(30, 'Bike', { recipient_ids: [50, 2], givers: [] })] }) }
  eq('values with resolved ids compare as sets', decide(resolveOp(rec, map), srv).do, 'done')
}

console.log(`offline-client: ${pass} passed, ${failN} failed`)
process.exit(failN ? 1 : 0)
