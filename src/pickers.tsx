/**
 * Pickers for people, occasions and wishlists – with "+ New …" right in the list (no dialog switch, the parent dialog
 * keeps its state). Built on Select/MultiSelect from controls.tsx.
 */
import { useState } from 'react'
import { t } from './i18n'
import { api, errMsg, type MyWishlist } from './api'
import { fmtDate, type Occasion, type Person } from './lib'
import { useOccasionTypes, useStore } from './store'
import { OccasionTypeIcon } from './components'
import { OCCASION_ICON_MAP } from './occasion-icons'
import { Avatar, Chip, DatePicker, Field, MultiSelect, Select, useToast, type CreateConfig, type SelectChange, type SelectOption } from './ui'

const personOption = (p: Person): SelectOption => ({ value: p.id, label: p.is_me ? t('controls.picker.meSuffix', { name: p.name }) : p.name, icon: <Avatar p={p} size={20} />, keywords: p.relationship ?? '' })

/** Creating a person from within the list */
export function usePersonCreate(): CreateConfig {
  const { createPerson } = useStore()
  return { label: t('controls.picker.newPerson'), placeholder: t('controls.picker.newPersonPlaceholder'), onCreate: createPerson }
}

/** Multi-selection of people (recipients, givers, occasion participants) with "+ New person". `create={false}` turns that off. */
export function PersonPicker({ persons, value, onChange, create = true, placeholder, label, id }: {
  persons: Person[]
  value: number[]
  onChange: (ids: number[]) => void
  create?: boolean
  placeholder?: string
  label?: string
  id?: string
}) {
  const cfg = usePersonCreate()
  return (
    <MultiSelect
      id={id}
      aria-label={label ?? t('controls.picker.persons')}
      placeholder={persons.length || create ? placeholder ?? t('controls.picker.choosePersons') : t('controls.picker.noPersons')}
      options={persons.map(personOption)}
      value={value}
      onChange={(v) => onChange(v.map(Number))}
      create={create ? cfg : undefined}
    />
  )
}

/** Single selection of a person. `value` 0 = none. */
export function PersonSelect({ persons, value, onChange, placeholder, none, create = true, invalid, inline, className, label, id }: {
  persons: Person[]
  value: number
  onChange: (id: number) => void
  placeholder?: string
  /** Entry for "none" (e.g. "All people"); otherwise just the placeholder */
  none?: string
  create?: boolean
  invalid?: boolean
  inline?: boolean
  className?: string
  label?: string
  id?: string
}) {
  const cfg = usePersonCreate()
  const options: SelectOption[] = [...(none ? [{ value: 0, label: none }] : []), ...persons.map(personOption)]
  return (
    <Select
      id={id} aria-label={label ?? t('controls.picker.person')} placeholder={placeholder ?? t('controls.picker.pleaseChoose')} options={options} value={value || (none ? 0 : '')} invalid={invalid} inline={inline} className={className}
      onChange={(e: SelectChange) => onChange(Number(e.target.value))} create={create ? cfg : undefined}
    />
  )
}

/** Next occurrence of a 'MM-DD' date (today when there is none) */
export const defaultDate = (md: string | null | undefined, today: string) => {
  if (!md) return today
  const y = Number(today.slice(0, 4))
  return `${y}-${md}` >= today ? `${y}-${md}` : `${y + 1}-${md}`
}

/** Grid of selectable icons (the allow-list is OCCASION_ICON_MAP, kept identical to the server's by a test) */
export function IconGrid({ value, onChange, label }: { value: string; onChange: (icon: string) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {Object.keys(OCCASION_ICON_MAP).map((name) => (
        <Chip key={name} on={value === name} title={name} onClick={() => onChange(name)} className="!px-2.5">
          <OccasionTypeIcon icon={name} size={18} />
          <span className="sr-only">{name}</span>
        </Chip>
      ))}
    </div>
  )
}

/** Small form: name + icon – creates an occasion type of the space directly */
function OccasionTypeQuickForm({ text, done, cancel }: { text: string; done: (key: string | null) => void; cancel: () => void }) {
  const { createOccasionType } = useStore()
  const [name, setName] = useState(text)
  const [icon, setIcon] = useState('calendar')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    const key = await createOccasionType({ name: name.trim(), icon })
    setBusy(false)
    done(key)
  }
  return (
    <div className="space-y-3" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void go() } }}>
      <Field label={t('settings.space.types.name')}><input className="input" autoFocus placeholder={t('settings.space.types.namePlaceholder')} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('settings.space.types.icon')} group><IconGrid value={icon} onChange={setIcon} label={t('settings.space.types.icon')} /></Field>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-sm" onClick={cancel}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!name.trim() || busy} onClick={() => void go()}>{t('controls.picker.occTypeCreate')}</button>
      </div>
    </div>
  )
}

/**
 * Choose the type of an occasion: the space's types (icon + name, hidden ones left out unless currently selected, birthday only
 * when it is the current value) with "+ New occasion type".
 */
export function OccasionTypeSelect({ value, onChange, label, className }: { value: string; onChange: (key: string) => void; label?: string; className?: string }) {
  const types = useOccasionTypes()
  const cfg: CreateConfig = {
    label: t('controls.picker.newOccasionType'),
    onCreate: async () => null,
    form: ({ text, done, cancel }) => <OccasionTypeQuickForm text={text} done={done} cancel={cancel} />,
  }
  const options: SelectOption[] = types.all
    .filter((x) => x.key === value || (!x.hidden && x.key !== 'birthday'))
    .map((x) => ({ value: x.key, label: x.hidden ? t('settings.space.types.hiddenName', { name: x.label }) : x.label, icon: <OccasionTypeIcon icon={x.icon} /> }))
  if (!options.some((o) => o.value === value)) options.push({ value, label: types.of(value).label, icon: <OccasionTypeIcon icon="calendar" /> })
  return <Select aria-label={label ?? t('controls.picker.occType')} value={value} options={options} className={className} create={cfg} onChange={(e) => onChange(e.target.value)} />
}

/** Small form: name, type, date – creates the occasion directly */
function OccasionQuickForm({ text, personIds, done, cancel }: { text: string; personIds: number[]; done: (id: number | null) => void; cancel: () => void }) {
  const { s, createOccasion } = useStore()
  const types = useOccasionTypes()
  const guess = types.active.find((o) => o.label.toLowerCase() === text.trim().toLowerCase() && o.key !== 'birthday')
  const [type, setType] = useState(guess?.key ?? 'other')
  const [name, setName] = useState(text)
  const [date, setDate] = useState(defaultDate(types.of(type).default_month_day, s.today))
  const [busy, setBusy] = useState(false)
  const changeType = (key: string) => {
    const ty = types.of(key)
    setName((old) => (!old.trim() || types.all.some((x) => x.label === old) ? (key === 'other' ? '' : ty.label) : old))
    if (ty.default_month_day) setDate(defaultDate(ty.default_month_day, s.today))
    setType(key)
  }
  const go = async () => {
    if (!name.trim() || !date || busy) return
    setBusy(true)
    const id = await createOccasion({ type, name: name.trim(), date, recurring: !!types.of(type).default_recurring, person_ids: personIds })
    setBusy(false)
    done(id)
  }
  return (
    <div className="space-y-3" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text' && !(e.target as HTMLInputElement).inputMode) { e.preventDefault(); void go() } }}>
      <Field label={t('controls.picker.occName')}><input className="input" autoFocus placeholder={t('controls.picker.occNamePlaceholder')} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('controls.picker.occType')}>
          <OccasionTypeSelect value={type} onChange={changeType} />
        </Field>
        <Field label={t('controls.picker.occDate')}><DatePicker aria-label={t('controls.picker.occDate')} value={date} onChange={setDate} required /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-sm" onClick={cancel}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!name.trim() || !date || busy} onClick={() => void go()}>{t('controls.picker.occCreate')}</button>
      </div>
    </div>
  )
}

/**
 * Choose an occasion (0 = none) with "+ New occasion"; `personIds` (the chosen recipients) are passed to the new occasion, occasions they are
 * left out of are not offered (the current value stays) and the occasions they take part in come first.
 */
export function OccasionSelect({ occasions, value, onChange, none, personIds = [], className, label }: {
  occasions: Occasion[]
  value: number
  onChange: (id: number) => void
  none?: string
  personIds?: number[]
  className?: string
  label?: string
}) {
  const { s, occasionTitle } = useStore()
  const types = useOccasionTypes()
  const cfg: CreateConfig = {
    label: t('controls.picker.newOccasion'),
    onCreate: async () => null,
    form: ({ text, done, cancel }) => <OccasionQuickForm text={text} personIds={personIds} done={done} cancel={cancel} />,
  }
  const offered = occasions.filter((o) => o.id === value || !personIds.some((id) => o.excluded_ids.includes(id)))
  const fits = (o: Occasion) => o.date >= s.today && personIds.some((id) => o.person_ids.includes(id))
  const split = personIds.length > 0 && offered.some(fits) && offered.some((o) => !fits(o))
  const ordered = split ? [...offered.filter(fits), ...offered.filter((o) => !fits(o))] : offered
  const options: SelectOption[] = [
    { value: 0, label: none ?? t('controls.picker.noOccasion') },
    ...ordered.map((o) => ({ value: o.id, label: occasionTitle(o), icon: <OccasionTypeIcon icon={types.of(o.type).icon} />, meta: fmtDate(o.date, false), group: split ? (fits(o) ? t('controls.picker.occFits') : t('controls.picker.occMore')) : undefined })),
  ]
  return <Select aria-label={label ?? t('controls.picker.occasion')} value={value} options={options} className={className} create={cfg} onChange={(e) => onChange(Number(e.target.value))} />
}

/** Choose a wishlist with "+ New wishlist". `onCreated` receives the new list (e.g. to refresh the lists in the parent dialog). */
export function WishlistSelect({ lists, value, onChange, onCreated, placeholder, className, label }: {
  lists: MyWishlist[]
  value: number
  onChange: (id: number) => void
  onCreated?: (l: MyWishlist) => void
  placeholder?: string
  className?: string
  label?: string
}) {
  const toast = useToast()
  const cfg: CreateConfig = {
    label: t('controls.picker.newWishlist'),
    placeholder: t('controls.picker.newWishlistPlaceholder'),
    onCreate: async (title) => {
      try {
        const l = await api<MyWishlist>('POST', '/api/wishlists', { title })
        onCreated?.(l)
        return l.id
      } catch (e) {
        toast(errMsg(e), 'bad')
        return null
      }
    },
  }
  return (
    <Select
      aria-label={label ?? t('controls.picker.wishlist')} placeholder={placeholder ?? t('controls.picker.pleaseChoose')} value={value || ''} className={className} create={cfg}
      options={lists.map((l) => ({ value: l.id, label: l.title, meta: `${l.wish_count}` }))}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}
