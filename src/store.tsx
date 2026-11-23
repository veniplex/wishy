import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { WifiOff } from 'lucide-react'
import { type Gift, type Item, type Occasion, type OccasionType, type Person, type PermissionKey, type State } from './lib'
import { api, errMsg, errorText, type Member, type WishlistsOverview } from './api'
import { useAuth } from './auth'
import { fmtMoney, t, useLocale, useT, type TKey } from './i18n'
import { Button, EmptyState, Page, PageSkeleton, useToast } from './ui'

export type Dialog =
  /** `focus`: field to focus when the dialog opens */
  | { type: 'person'; initial?: Partial<Person>; focus?: 'birthday' }
  | { type: 'occasion'; initial?: Partial<Occasion> }
  | { type: 'item'; initial?: Partial<Item> }
  | { type: 'gift'; initial?: Partial<Gift> }
  /** "Add" menu: capture idea / add wish */
  | { type: 'add' }
  /** Add a wish (choose a list) */
  | { type: 'wish' }
  /** "Import with AI" */
  | { type: 'ai-import'; init?: { target?: 'wishes' | 'ideas'; personId?: number; listId?: number } }

/** Permission needed to open an editing dialog (the server enforces the same rules) */
const DIALOG_PERMISSION: Partial<Record<Dialog['type'], PermissionKey>> = { person: 'manage_persons', occasion: 'manage_occasions', item: 'manage_gifts', gift: 'manage_gifts' }

interface Store {
  s: State
  me: Person | undefined
  person: (id: number | null | undefined) => Person | undefined
  occasion: (id: number | null | undefined) => Occasion | undefined
  occasionTitle: (o: Occasion, withYear?: boolean) => string
  giftDate: (g: Gift) => string
  itemState: (i: Item) => 'open' | 'planned' | 'done' | 'discarded'
  activePersons: Person[]
  /** Mutation whose response is the new state of the space; shows errors as a toast */
  call: (method: string, url: string, body?: unknown) => Promise<boolean>
  /** Call with an arbitrary response (null on error, which is shown as a toast) */
  request: <T = unknown>(method: string, url: string, body?: unknown) => Promise<T | null>
  /** Reload the state (after calls that do not return the state) */
  reload: () => Promise<void>
  /** Creates directly from a picker and returns the new ID (null on error, which is shown as a toast) */
  createPerson: (name: string) => Promise<number | null>
  createOccasion: (body: Record<string, unknown>) => Promise<number | null>
  /** Creates an occasion type of the space and returns its key (null on error, which is shown as a toast) */
  createOccasionType: (body: Record<string, unknown>) => Promise<string | null>
  /** Latest raw occasion type by key – also right after a creation, before React has re-rendered */
  freshOccasionType: (key: string) => OccasionType | undefined
  /** Personal space: own wishes are maintained here */
  isPersonal: boolean
  /** Format an amount; without `currency` in the app currency */
  money: (n: number | null | undefined, currency?: string | null) => string
  dialog: Dialog | null
  open: (d: Dialog) => void
  close: () => void
  hidden: number[]
  setHidden: (ids: number[]) => void
  hiddenCount: number
}

const Ctx = createContext<Store>(null as never)
export const useStore = () => useContext(Ctx)

export function StoreProvider({ children }: { children: ReactNode }) {
  useT()
  const { spaceId, space, switchSpace } = useAuth()
  const toast = useToast()
  const [raw, setRaw] = useState<State | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [hidden, setHiddenState] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('hiddenPersons') || '[]')
    } catch {
      return []
    }
  })

  const request = useCallback(async <T,>(method: string, url: string, body?: unknown) => {
    try {
      return await api<T>(method, url, body)
    } catch (e) {
      toast(errMsg(e), 'bad')
      return null
    }
  }, [toast])

  const call = useCallback(async (method: string, url: string, body?: unknown) => {
    const data = await request<State>(method, url, body)
    if (!data) return false
    setRaw(data)
    return true
  }, [request])

  const rawRef = useRef<State | null>(null)
  rawRef.current = raw
  const createType = useCallback(async (body: Record<string, unknown>) => {
    const before = new Set((rawRef.current?.occasion_types ?? []).map((x) => x.id))
    const data = await request<State>('POST', '/api/occasion-types', body)
    if (!data) return null
    rawRef.current = data
    setRaw(data)
    return data.occasion_types.find((x) => !before.has(x.id))?.key ?? null
  }, [request])
  const create = useCallback(async (kind: 'persons' | 'occasions', body: Record<string, unknown>) => {
    const before = new Set((rawRef.current?.[kind] ?? []).map((x) => x.id))
    const data = await request<State>('POST', `/api/${kind}`, body)
    if (!data) return null
    setRaw(data)
    const added = data[kind].filter((x) => !before.has(x.id)).map((x) => x.id)
    return added.length ? Math.max(...added) : null
  }, [request])

  const load = useCallback(async () => {
    try {
      setRaw(await api<State>('GET', '/api/state'))
      setLoadError(null)
    } catch (e) {
      setLoadError(errMsg(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // The server fell back to the personal space (space deleted / no longer a member)
  useEffect(() => {
    if (raw && raw.space_id !== spaceId) switchSpace(raw.space_id)
  }, [raw, spaceId, switchSpace])

  const store = useMemo<Store | null>(() => {
    if (!raw) return null
    // Privacy (formerly "surprise protection"): hide everything intended for hidden people
    const hide = new Set(hidden)
    const gifts = raw.gifts.filter((g) => !g.recipient_ids.some((id) => hide.has(id)))
    const items = raw.items.filter((i) => !hide.has(i.person_id))
    const occasions = raw.occasions.map((o) => ({ ...o, person_ids: o.person_ids.filter((id) => !hide.has(id)), excluded_ids: o.excluded_ids.filter((id) => !hide.has(id)) }))
    const s = { ...raw, occasions, gifts, items }
    const pMap = new Map(s.persons.map((p) => [p.id, p]))
    const oMap = new Map(s.occasions.map((o) => [o.id, o]))
    const giftsByItem = new Map<number, Gift[]>()
    for (const g of gifts) if (g.item_id) giftsByItem.set(g.item_id, [...(giftsByItem.get(g.item_id) ?? []), g])
    const currency = s.settings.currency || 'EUR'
    return {
      s,
      me: s.persons.find((p) => p.is_me),
      person: (id) => (id == null ? undefined : pMap.get(id)),
      occasion: (id) => (id == null ? undefined : oMap.get(id)),
      occasionTitle: (o, withYear = true) => {
        const bp = o.type === 'birthday' ? pMap.get(o.person_id ?? -1) : undefined
        const base = bp ? (bp.is_me ? t('calendar.birthdayOwn') : t('calendar.birthdayOf', { name: bp.name })) : o.type === 'birthday' && o.name === 'Geburtstag' ? occasionTypeLabel(s.occasion_types.find((x) => x.key === 'birthday'), 'birthday') : o.name
        return withYear ? `${base} ${o.date.slice(0, 4)}` : base
      },
      giftDate: (g) => oMap.get(g.occasion_id ?? -1)?.date ?? g.date ?? g.created_at.slice(0, 10),
      itemState: (i) => {
        if (i.status !== 'open') return i.status
        const linked = giftsByItem.get(i.id)?.filter((g) => g.status !== 'returned')
        if (!linked?.length) return 'open'
        return linked.some((g) => g.status === 'given') ? 'done' : 'planned'
      },
      activePersons: s.persons.filter((p) => !p.archived),
      call,
      request,
      reload: load,
      createPerson: (name) => create('persons', { name }),
      createOccasion: (body) => create('occasions', body),
      createOccasionType: createType,
      freshOccasionType: (key) => rawRef.current?.occasion_types.find((x) => x.key === key),
      isPersonal: !!space?.personal,
      money: (n, cur) => fmtMoney(n, cur || currency),
      dialog,
      open: (d) => {
        const need = DIALOG_PERMISSION[d.type]
        if (need && !raw.permissions[need]) return toast(errorText('permission_denied', undefined, { permission: need }) ?? '', 'bad')
        setDialog(d)
      },
      close: () => setDialog(null),
      hidden,
      setHidden: (ids) => {
        localStorage.setItem('hiddenPersons', JSON.stringify(ids))
        setHiddenState(ids)
      },
      hiddenCount: raw.gifts.length - gifts.length + raw.items.length - items.length,
    }
  }, [raw, hidden, dialog, call, request, load, create, createType, space?.personal, toast])

  if (!store) {
    if (loadError) {
      return (
        <Page>
          <EmptyState icon={WifiOff} action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}>{t('start.loadFailed', { error: loadError })}</EmptyState>
        </Page>
      )
    }
    return <PageSkeleton />
  }
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

/** Members of the current space and owners of followed wishlists – possible links for a person. */
export function useLinkOptions() {
  const { spaceId } = useAuth()
  const [data, setData] = useState<{ members: Member[]; followed: { owner: { id: number; name: string } }[] } | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all([
      api<Member[]>('GET', `/api/spaces/${spaceId}/members`).catch(() => [] as Member[]),
      api<WishlistsOverview>('GET', '/api/wishlists').then((o) => [...new Map(o.shared.map((x) => [x.owner.id, { owner: x.owner }])).values()]).catch(() => []),
    ]).then(([members, followed]) => alive && setData({ members, followed }))
    return () => { alive = false }
  }, [spaceId])
  return data
}


/** Display name of an occasion type: the name of a custom type, otherwise the localized label of the built-in type. */
export function occasionTypeLabel(ty: Pick<OccasionType, 'name' | 'builtin_key'> | undefined, fallbackKey: string): string {
  if (ty?.name) return ty.name
  const bk = ty?.builtin_key ?? (ty ? null : fallbackKey)
  if (bk) {
    const key = `calendar.type.${bk}` as TKey
    const label = t(key)
    if (label !== key) return label
  }
  return fallbackKey
}

export interface OccasionTypeView extends OccasionType {
  label: string
}
/** All occasion types of the current space (hidden ones included, flagged) with their display names. */
export function useOccasionTypes() {
  const { s, freshOccasionType } = useStore()
  const lang = useLocale()
  return useMemo(() => {
    const all: OccasionTypeView[] = s.occasion_types.map((x) => ({ ...x, label: occasionTypeLabel(x, x.key) }))
    const byKey = new Map(all.map((x) => [x.key, x]))
    /** Unknown keys (should not happen) fall back to the raw key with the neutral icon */
    const of = (key: string): OccasionTypeView => {
      const known = byKey.get(key)
      if (known) return known
      const fresh = freshOccasionType(key)
      if (fresh) return { ...fresh, label: occasionTypeLabel(fresh, fresh.key) }
      return { id: 0, key, builtin_key: null, name: null, icon: 'calendar', default_month_day: null, default_recurring: 0, sort: 0, hidden: 0, usage: 0, default_audience: 'selected', label: key }
    }
    return { all, active: all.filter((x) => !x.hidden), of }
  }, [s.occasion_types, lang, freshOccasionType])
}
