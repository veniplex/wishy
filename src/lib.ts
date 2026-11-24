import { relative, t, type TKey } from './i18n'

export interface Person {
  id: number
  name: string
  /** Computed by the server: is this person linked to the signed-in user? */
  is_me: number
  linked_user_id: number | null
  /** Key of a relationship type of the space (see RelationshipType; null = none) */
  relationship?: string | null
  /** Optional: if the person joins a space with this email, they are linked automatically */
  email?: string | null
  /** Wishlists of the linked user that are visible to you */
  linked_wishlists?: { id: number; title: string; wish_count: number; open_count: number }[]
  birthday: string | null
  emoji: string | null
  /** Cache-busted URL of the person's photo (takes precedence over the emoji), null without a photo */
  photo_url?: string | null
  color: string | null
  notes: string | null
  yearly_budget: number | null
  archived: number
}
/** Member permissions of a space; the owner always has all (server/permissions.js) */
export const PERMISSION_KEYS = ['invite_members', 'share_wishlists', 'manage_persons', 'manage_occasions', 'manage_gifts', 'view_expenses', 'manage_space_settings'] as const
export type PermissionKey = (typeof PERMISSION_KEYS)[number]
export type SpacePermissions = Record<PermissionKey, boolean>
/** Occasion type of a space (managed in Settings > Space; seeded by the server, see server/occasion-types.js) */
export interface OccasionType {
  id: number
  /** Stored in occasions.type */
  key: string
  /** Set for the built-in (fixed) types: label, icon and default date come from the code/i18n and cannot be changed, only hidden */
  builtin_key: string | null
  /** Name of a custom type (null for built-ins) */
  name: string | null
  /** Name of a lucide icon from the server's allow-list */
  icon: string
  /** 'MM-DD' */
  default_month_day: string | null
  default_recurring: number
  sort: number
  /** Not offered for new/edited occasions (existing ones still display) */
  hidden: number
  /** Number of occasions of the space using this type */
  usage: number
  /** Who takes part in a new occasion of this type by default */
  default_audience: Audience
}
/** 'all' = every active person takes part (except the left out ones), 'selected' = only the listed persons */
export type Audience = 'all' | 'selected'
export interface Occasion {
  id: number
  name: string
  type: string
  date: string
  recurring: number
  series_id: string | null
  person_id: number | null
  budget: number | null
  notes: string | null
  audience: Audience
  /** Effective participants (left out persons and your own person for 'all' already removed) */
  person_ids: number[]
  /** Persons left out of this occasion */
  excluded_ids: number[]
}
export interface Item {
  id: number
  person_id: number
  /** Occasion the idea is meant for (optional) */
  occasion_id: number | null
  /** The person wished for or mentioned it themselves */
  mentioned: number
  title: string
  notes: string | null
  url: string | null
  price: number | null
  priority: number
  status: 'open' | 'done' | 'discarded'
  source: string | null
  /** Product image (stored locally, e.g. /api/images/abc.jpg) */
  image_url: string | null
  /** Currency of the price, null = app currency */
  currency: string | null
  created_at: string
}
export interface Giver {
  person_id: number
  amount: number | null
  settled: number
  settled_at?: string | null
  settle_method?: string | null
}
export interface Gift {
  id: number
  title: string
  notes: string | null
  url: string | null
  shop: string | null
  /** Product image, usually taken over from the wish */
  image_url: string | null
  occasion_id: number | null
  item_id: number | null
  /** Wish of a shared wishlist the gift originated from */
  wish_id?: number | null
  price: number | null
  status: string
  payer_id: number | null
  date: string | null
  created_at: string
  recipient_ids: number[]
  givers: Giver[]
  /** Order & shipping */
  ordered_at?: string | null
  order_number?: string | null
  carrier?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
  expected_at?: string | null
  delivered_at?: string | null
  given_at?: string | null
  /** Payment of the gift as a whole */
  payment_status?: 'unpaid' | 'paid'
  paid_at?: string | null
  payment_method?: string | null
  paid_amount?: number | null
  payment_summary?: { paid: boolean; payer_id: number | null; open_amount: number; open_count: number }
}
/** Relationship type of a space (managed in Settings > Space; seeded by the server, see server/relationship-core.js) */
export interface RelationshipType {
  id: number
  /** Stored in persons.relationship */
  key: string
  /** Set for the built-in (fixed) types: the label comes from the i18n, they can only be hidden */
  builtin_key: string | null
  /** Name of a custom type (null for built-ins) */
  name: string | null
  sort: number
  /** Not offered for new/edited persons (persons that have it still display it) */
  hidden: number
  /** Number of persons of the space using this type */
  usage: number
}
export interface State {
  today: string
  space_id: number
  user_id: number
  /** Effective permissions of the current user in this space (see server/permissions.js) */
  permissions: SpacePermissions
  persons: Person[]
  occasions: Occasion[]
  occasion_types: OccasionType[]
  relationship_types: RelationshipType[]
  items: Item[]
  gifts: Gift[]
  settings: { currency: string; yearly_budget: number | null }
}

export type StatusTone = 'neutral' | 'info' | 'warn' | 'accent' | 'ok' | 'bad'
/** Label is resolved only on read (language can change at runtime) */
const lazyLabel = <T extends object>(o: T, key: TKey): T & { readonly label: string } => Object.defineProperty(o, 'label', { get: () => t(key), enumerable: true }) as T & { readonly label: string }
/** List rebuilt on every access (labels follow the language) */
const lazyList = <T,>(build: () => T[]): T[] => new Proxy([] as T[], {
  get: (_, k) => { const a = build(); const v = Reflect.get(a, k); return typeof v === 'function' ? v.bind(a) : v },
  has: (_, k) => Reflect.has(build(), k),
})
const status = (id: string, tone: StatusTone) => lazyLabel({ id, tone }, `status.gift.${id}` as TKey)
/** Flow of a gift (in order), followed by the special case "Returned" */
export const GIFT_STATUS: { id: string; label: string; tone: StatusTone }[] = [
  status('planned', 'neutral'),
  status('ordered', 'info'),
  status('shipped', 'info'),
  status('delivered', 'warn'),
  status('wrapped', 'accent'),
  status('given', 'ok'),
  status('returned', 'bad'),
]
/** The six steps of the flow (without "Returned") */
export const STATUS_STEPS = GIFT_STATUS.slice(0, 6)
export const statusInfo = (id: string) => GIFT_STATUS.find((s) => s.id === id) ?? GIFT_STATUS[0]
export const statusIndex = (id: string) => STATUS_STEPS.findIndex((s) => s.id === id)
/** Money counts as spent once ordered – planned and returned gifts do not count */
export const isCommitted = (status: string) => status !== 'planned' && status !== 'returned'
/** Open shares of a paid gift (payer has advanced the money, givers have not reimbursed yet) */
export const openShares = (g: Gift) => g.payment_summary ?? { paid: false, payer_id: g.payer_id, open_amount: 0, open_count: 0 }
/** Payment methods as suggestions (free text, stored as entered) */
export const paymentMethods = (): string[] => (['paypal', 'card', 'transfer', 'cash', 'debit'] as const).map((k) => t(`finance.method.${k}` as TKey))
export const PAYMENT_METHODS: string[] = lazyList(paymentMethods)

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

export function parseDate(s: string) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}
export { fmtDate, fmtDateShort } from './i18n'
/** Date of month-day `md` ('MM-DD') in `year`; Feb 29 falls back to Feb 28 in non-leap years */
export function dateInYear(year: number, md: string): string {
  const [m, d] = md.split('-').map(Number)
  const last = new Date(year, m, 0).getDate()
  return `${year}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}
/** Next occurrence of a birthday (today counts) and the age the person turns then */
export function nextBirthday(birthday: string, today: string): { date: string; age: number | null } {
  const y = Number(today.slice(0, 4))
  let date = dateInYear(y, birthday.slice(5, 10))
  if (date < today) date = dateInYear(y + 1, birthday.slice(5, 10))
  const age = Number(date.slice(0, 4)) - Number(birthday.slice(0, 4))
  return { date, age: age > 0 && age < 130 ? age : null }
}
/** A birthday whose person is left out: nothing to plan, shown dimmed */
export const isLeftOutBirthday = (o: Pick<Occasion, 'type' | 'person_id' | 'excluded_ids'>) => o.type === 'birthday' && o.person_id != null && o.excluded_ids.includes(o.person_id)

export const daysUntil = (date: string, today: string) =>
  Math.round((parseDate(date).getTime() - parseDate(today).getTime()) / 86400000)
/** "today", "tomorrow", "in 5 days" … (language-dependent, see i18n `relative`) */
export const countdown = relative

export function parseNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** Share per giver: fixed amounts first, the rest is distributed evenly. */
export function shares(g: Pick<Gift, 'price' | 'givers'> & { paid_amount?: number | null }): Map<number, number> {
  const m = new Map<number, number>()
  const fixed = g.givers.filter((x) => x.amount != null)
  const open = g.givers.filter((x) => x.amount == null)
  const rest = Math.max(0, (g.paid_amount ?? g.price ?? 0) - sum(fixed.map((x) => x.amount!)))
  for (const x of fixed) m.set(x.person_id, x.amount!)
  for (const x of open) m.set(x.person_id, rest / open.length)
  return m
}
/** Cost of a gift from one person's point of view (null = all together). */
export const costFor = (g: Gift, personId: number | null) =>
  personId == null ? (g.price ?? 0) : (shares(g).get(personId) ?? 0)

export const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`

const PALETTE = ['#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#6366f1', '#84cc16']
export const personColor = (p: Person) => p.color || PALETTE[Math.abs(p.id) % PALETTE.length]

/** Date a gift counts for: its occasion, else its own date, else when it was created */
type Dated = { occasions: { id: number; date: string }[] }
export const giftDateOf = (s: Dated, g: Gift) => s.occasions.find((o) => o.id === g.occasion_id)?.date ?? g.date ?? g.created_at
export const giftYear = (s: Dated, g: Gift) => giftDateOf(s, g).slice(0, 4)
/** Idea or wish that is still being worked on */
export const isLive = (state: string) => state === 'open' || state === 'planned'
