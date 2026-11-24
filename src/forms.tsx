import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Heart, Lightbulb, Loader2, Plus, Trash2, X } from 'lucide-react'
import { AiMark, ImportDialog, LinkModePicker, setLinkFallback, useLinkMode } from './ai'
import { ApiError, api, errMsg, isOffline, type MyWishlist, type Wish, type WishlistsOverview } from './api'
import { realId } from './offline/engine'
import { useReachable, useRealState } from './offline/hooks'
import { useLinkOptions, useOccasionTypes, useRelationshipTypes, useStore } from './store'
import { fmtDateTime, getLocale, t, type TKey } from './i18n'
import { PAYMENT_METHODS, STATUS_STEPS, fmtDate, joinNames, parseNum, shares, statusIndex, statusInfo, type Audience, type Gift, type Giver, type Item, type Occasion, type Person } from './lib'
import { shareState } from './split'
import { Badge, Button, Checkbox, DatePicker, Field, FormError, List, Modal, Money, NameForm, Row, Segmented, Select, SuggestInput, Thumb, ToggleLink, useConfirm, useToast } from './ui'
import { OccasionSelect, OccasionTypeSelect, PersonPicker, PersonSelect, defaultDate } from './pickers'
import { EmojiPicker } from './emoji-picker'
import { PersonPhotoField } from './person-photo'
import { isCoarse } from './controls'
import { GiftDetail, ItemDetail } from './detail-dialog'

/** Responsive two/three column field grid: one column on phones, `min-w-0` children so long values cannot overflow. */
export function FormGrid({ children, cols = 2, className = "" }: { children: ReactNode; cols?: 2 | 3; className?: string }) {
  return <div className={`grid grid-cols-1 gap-3 ${cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"} [&>*]:min-w-0 ${className}`.trim()}>{children}</div>
}

function useForm<T extends object>(init: T) {
  const [f, setF] = useRealState(init)
  const set = <K extends keyof T>(k: K, v: T[K]) => setF((old) => ({ ...old, [k]: v }))
  return [f, set, setF] as const
}

/** `more` = rarely used fields behind "More options"; `moreOpen` = start expanded */
function FormModal({ title, onSubmit, onDelete, children, more, moreOpen = false, onClose }: { title: string; onSubmit: () => void; onDelete?: () => void; children: ReactNode; more?: ReactNode; moreOpen?: boolean; onClose?: () => void }) {
  const store = useStore()
  const close = onClose ?? store.close
  const confirm = useConfirm()
  const [open, setOpen] = useState(moreOpen)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit()
  }
  const askDelete = async () => {
    if (await confirm({ title: t('forms.delete.title'), text: t('forms.delete.text'), confirmLabel: t('forms.delete.confirm'), destructive: true })) onDelete?.()
  }
  return (
    <form onSubmit={submit}>
      <Modal
        title={title}
        onClose={close}
        footer={
          <>
            {onDelete && (
              <Button variant="danger" icon={Trash2} iconOnlyOnMobile onClick={askDelete}>{t('forms.delete.confirm')}</Button>
            )}
            <span className="flex-1" />
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit">{t('common.save')}</Button>
          </>
        }
      >
        {children}
        {more && (
          <div>
            <ToggleLink chevron on={open} onToggle={() => setOpen(!open)} labelOn={t('forms.fewerOptions')} labelOff={t('forms.moreOptions')} />
            {open && <div className="space-y-4 mt-4">{more}</div>}
          </div>
        )}
      </Modal>
    </form>
  )
}

export const str = (v: number | null | undefined) => (v == null ? '' : getLocale() === 'de' ? String(v).replace('.', ',') : String(v))
/** Text present but not a number */
export const bad = (v: string) => v.trim() !== '' && parseNum(v) == null

// ---------- Link preview ----------
interface Preview {
  url: string
  title: string | null
  description: string | null
  image_url: string | null
  price: number | null
  currency: string | null
  shop: string | null
}

/** Fetches title, image and price for a link (deliberately without `call`, which would replace the app state). */
export function useLinkPreview(onResult: (p: Preview) => void) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pv, setPv] = useState<Preview | null>(null)
  const [aiUsed, setAiUsed] = useState(false)
  const lm = useLinkMode()
  const useAi = lm.available && lm.mode === 'ai'
  const last = useRef('')
  const lastUrl = useRef('')
  const seq = useRef(0)
  const cb = useRef(onResult)
  cb.current = onResult
  const up = useReachable()
  const reachable = useRef(up)
  reachable.current = up
  const run = async (raw: string) => {
    const url = raw.trim()
    if (!url || url + (useAi ? '|ai' : '|builtin') === last.current || !reachable.current) return // offline: the link is kept, only the preview is skipped
    last.current = url + (useAi ? '|ai' : '|builtin') // a changed mode reads the same link again
    lastUrl.current = url
    const mine = ++seq.current
    setLoading(true)
    setError('')
    try {
      let data: Preview | null = null
      let viaAi = false
      let fell = false
      if (useAi) {
        // AI cleans up title, description and image; on errors (e.g. limit, provider) fall back to the built-in parser
        try {
          const r = await api<Preview & { via?: string; fallback?: string }>('POST', '/api/ai/extract-link', { url, mode: 'ai' })
          data = r
          viaAi = r.via !== 'builtin'
          fell = !viaAi
        } catch (e) {
          if (mine !== seq.current) return
          if (e instanceof ApiError && e.status === 400) throw e
          fell = true
        }
      }
      setLinkFallback(fell)
      if (!data) {
        data = await api<Preview>('POST', '/api/preview', { url })
      }
      if (mine !== seq.current) return
      setAiUsed(viaAi)
      setPv(data)
      cb.current(data!)
    } catch (e) {
      if (mine !== seq.current) return
      setPv(null)
      if (isOffline(e)) last.current = ''
      else setError(e instanceof Error ? e.message : t('forms.preview.failed'))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }
  // Switching between built-in and AI reads the link that was last imported again
  const firstMode = useRef(true)
  useEffect(() => {
    if (firstMode.current) { firstMode.current = false; return }
    if (lastUrl.current) void run(lastUrl.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useAi])
  /** Event handlers for the link field: on paste and on blur */
  const bind = {
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      const el = e.currentTarget
      setTimeout(() => run(el.value), 0)
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
      run(e.currentTarget.value)
    },
  }
  return { loading, error, pv, run, bind, ai: aiUsed }
}

export function LinkStatus({ loading, error, ai }: { loading: boolean; error: string; ai?: boolean }) {
  return (
    <>
      {loading ? <span className="flex items-center gap-1.5 meta mt-1.5"><Loader2 size={13} className="animate-spin" /> {t('common.loading')}</span>
        : error ? <FormError>{error}</FormError>
        : null}
      {!loading && !error && ai && <div className="mt-1.5"><AiMark>{t('forms.preview.aiCleaned')}</AiMark></div>}
      <LinkModePicker />
    </>
  )
}

export function PreviewCard({ image, title, shop, price, onRemoveImage }: { image: string | null; title: string | null; shop: string | null; price: string; onRemoveImage: () => void }) {
  if (!image && !title) return null
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-hover p-2 mt-2">
      {image && (
        <div className="media relative shrink-0">
          <img src={image} alt="" className="size-16 rounded-md object-cover bg-card" />
          <button type="button" aria-label={t('forms.preview.removeImage')} title={t('forms.preview.removeImage')} className="absolute -top-1.5 -right-1.5 grid place-items-center size-6 rounded-full bg-ink text-bg cursor-pointer" onClick={onRemoveImage}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="min-w-0 text-sm">
        {title && <div className="font-medium line-clamp-2">{title}</div>}
        <div className="meta truncate">{[shop, price].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  )
}

// ---------- Person ----------
export function PersonForm({ initial, focus }: { initial?: Partial<Person>; focus?: 'birthday' }) {
  const { call, close, s } = useStore()
  const links = useLinkOptions()
  const relTypes = useRelationshipTypes()
  const confirm = useConfirm()
  const [pickUser, setPickUser] = useState(0)
  const [f, set] = useForm({
    email: initial?.email ?? '',
    name: initial?.name ?? '',
    emoji: initial?.emoji ?? '',
    relationship: initial?.relationship ?? '',
    birthday: initial?.birthday ?? '',
    yearly_budget: str(initial?.yearly_budget),
    notes: initial?.notes ?? '',
    archived: !!initial?.archived,
  })
  const isMe = !!initial?.is_me
  const id = realId(initial?.id)
  // Opened to add the birthday: the dialog starts there (after the dialog's own initial focus)
  useEffect(() => { if (focus === 'birthday') document.getElementById('person-birthday')?.focus() }, [focus])
  const save = async () => {
    if (bad(f.yearly_budget)) return
    const body: Record<string, unknown> = { ...f, yearly_budget: parseNum(f.yearly_budget) }
    if (await call(id ? 'PUT' : 'POST', id ? `/api/persons/${id}` : '/api/persons', body)) close()
  }
  // Link to app users: members of the space and users with whom wishlists are shared
  const linkedMember = links?.members.find((m) => m.user_id === initial?.linked_user_id)
  const linkedUserName = initial?.linked_user_id ? linkedMember?.name ?? links?.followed.find((x) => x.owner.id === initial.linked_user_id)?.owner.name ?? t('wishlists.share.tabUsers') : null
  const taken = new Set(s.persons.filter((p) => p.id !== id && p.linked_user_id && !links?.members.some((m) => m.user_id === p.linked_user_id)).map((p) => p.linked_user_id))
  const memberOptions = (links?.members ?? []).filter((m) => m.user_id !== s.user_id && !taken.has(m.user_id))
  const followedOptions = (links?.followed ?? []).filter((x) => x.owner.id !== s.user_id && !taken.has(x.owner.id) && !memberOptions.some((m) => m.user_id === x.owner.id))
  const linkOptions = [
    ...memberOptions.map((m) => ({ value: m.user_id, label: m.name, group: t('forms.person.groupMembers'), meta: m.email })),
    ...followedOptions.map((x) => ({ value: x.owner.id, label: x.owner.name, group: t('forms.person.groupFollowed') })),
  ]
  const doLink = async () => {
    if (!id || !pickUser) return
    const target = linkOptions.find((o) => o.value === pickUser)
    const auto = s.persons.find((p) => p.id !== id && p.linked_user_id === pickUser)
    if (auto && !(await confirm({
      title: t('forms.person.linkTitle', { name: target?.label ?? t('forms.person.userFallback') }),
      text: t('forms.person.linkText', { auto: auto.name, name: f.name || initial?.name || '' }),
      confirmLabel: t('forms.person.linkConfirm'),
    }))) return
    if (await call('POST', `/api/persons/${id}/link`, { user_id: pickUser })) close()
  }
  const doUnlink = async () => {
    if (!id) return
    if (!(await confirm({ title: t('forms.person.unlinkTitle'), text: t('forms.person.unlinkText', { name: f.name || initial?.name || '' }), confirmLabel: t('forms.person.unlinkTitle'), destructive: true }))) return
    if (await call('POST', `/api/persons/${id}/unlink`)) close()
  }
  const moreOpen = !!(f.yearly_budget || f.archived || initial?.linked_user_id)
  return (
    <FormModal
      title={id ? t('forms.person.edit') : t('forms.person.new')}
      onSubmit={save}
      onDelete={id ? async () => (await call('DELETE', `/api/persons/${id}`)) && close() : undefined}
      moreOpen={moreOpen}
      more={
        <>
          {!isMe && (
            <Field label={t('forms.person.yearlyBudget')} error={bad(f.yearly_budget) && t('forms.numErr')}>
              <input className={`input ${bad(f.yearly_budget) ? 'input-invalid' : ''}`} inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder={t('forms.person.budgetPlaceholder')} value={f.yearly_budget} onChange={(e) => set('yearly_budget', e.target.value)} />
            </Field>
          )}
          {id && id > 0 && !isMe && (linkedMember ? (
            <Field label={t('forms.person.linkedWith')} hint={t('forms.person.memberHint')}>
              <input className="input" readOnly value={linkedMember.name} />
            </Field>
          ) : initial?.linked_user_id ? (
            <Field label={t('forms.person.linkedWith')} group hint={t('forms.person.linkedHint')}>
              <div className="flex items-center gap-2">
                <input className="input flex-1 min-w-0" readOnly aria-label={t('forms.person.linkedWith')} value={linkedUserName ?? ''} />
                <Button onClick={doUnlink}>{t('forms.person.unlink')}</Button>
              </div>
            </Field>
          ) : linkOptions.length > 0 && (
            <Field label={t('forms.person.linkUser')} group hint={t('forms.person.linkUserHint')}>
              <div className="flex items-center gap-2">
                <Select className="flex-1 min-w-0" aria-label={t('forms.person.user')} placeholder={t('forms.person.notLinked')} options={linkOptions} value={pickUser || ''} onChange={(e) => setPickUser(Number(e.target.value))} />
                <Button disabled={!pickUser} onClick={doLink}>{t('forms.person.link')}</Button>
              </div>
            </Field>
          ))}
          {id && !isMe && (
            <div className="text-sm"><Checkbox checked={f.archived} onChange={(v) => set('archived', v)}>{t('forms.person.archived')}</Checkbox></div>
          )}
        </>
      }
    >
      <Field label={t('forms.person.photo')} group><PersonPhotoField person={{ ...initial, name: f.name || initial?.name, emoji: f.emoji }} id={id ?? null} /></Field>
      <Field label={t('forms.person.emoji')} group hint={t('forms.person.emojiHint')}><EmojiPicker value={f.emoji} onChange={(e) => set('emoji', e)} label={t('forms.person.emoji')} /></Field>
      <Field label={t('forms.name')}><input className="input" required autoComplete="off" autoCapitalize="words" enterKeyHint="next" autoFocus={focus !== 'birthday'} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label={t('forms.person.birthday')} hint={t('forms.person.birthdayHint')}><DatePicker id="person-birthday" aria-label={t('forms.person.birthday')} value={f.birthday} max={s.today} onChange={(v) => set('birthday', v)} /></Field>
      {!isMe && !initial?.linked_user_id && (
        <Field label={t('forms.person.email')} hint={t('forms.person.emailHint')}>
          <input className="input" type="email" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" placeholder={t('wishlists.share.emailPlaceholder')} value={f.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
      )}
      <Field label={t('forms.person.relationship')} hint={s.permissions.manage_persons ? t('forms.person.relationshipHint') : undefined}>
        <Select
          aria-label={t('forms.person.relationship')}
          value={f.relationship}
          options={[{ value: '', label: t('forms.person.relationshipNone') }, ...relTypes.all.filter((x) => !x.hidden || x.key === initial?.relationship).map((x) => ({ value: x.key, label: x.hidden ? t('settings.space.rel.hiddenName', { name: x.label }) : x.label }))]}
          onChange={(e) => set('relationship', e.target.value)}
        />
      </Field>
      <Field label={t('forms.notes')}>
        <textarea className="input min-h-28" placeholder={t('forms.person.notesPlaceholder')} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </FormModal>
  )
}

// ---------- Occasion ----------
export function OccasionForm({ initial }: { initial?: Partial<Occasion> }) {
  const { call, close, s, activePersons, person } = useStore()
  const types = useOccasionTypes()
  const id = realId(initial?.id)
  const isBirthday = initial?.type === 'birthday'
  // New occasion: Christmas when the space still has it, otherwise the first selectable type
  const first = types.active.find((x) => x.key === 'christmas') ?? types.active.find((x) => x.key !== 'birthday') ?? types.of('other')
  const [f, set, setF] = useForm({
    type: initial?.type ?? first.key,
    name: initial?.name ?? first.label,
    date: initial?.date ?? defaultDate(first.default_month_day, s.today),
    recurring: id ? !!initial?.recurring : !!first.default_recurring,
    budget: str(initial?.budget),
    notes: initial?.notes ?? '',
    audience: (initial?.audience ?? first.default_audience) as Audience,
    person_ids: initial?.person_ids ?? [],
    excluded_ids: initial?.excluded_ids ?? [],
  })
  // The type suggests who takes part until the user chooses
  const [audienceSet, setAudienceSet] = useState(!!id)
  const changeType = (type: string) => {
    const ty = types.of(type)
    setF((old) => ({
      ...old,
      type,
      name: !old.name || types.all.some((x) => x.label === old.name) ? (type === 'other' ? '' : ty.label) : old.name,
      // When editing, date and recurrence stay untouched
      date: !id && ty.default_month_day ? defaultDate(ty.default_month_day, s.today) : old.date,
      recurring: id ? old.recurring : !!ty.default_recurring,
      audience: audienceSet ? old.audience : ty.default_audience,
    }))
  }
  const birthdayPerson = isBirthday ? person(initial?.person_id) : undefined
  const save = async () => {
    if (bad(f.budget)) return
    const budget = parseNum(f.budget)
    const body = isBirthday
      ? { budget, notes: f.notes, excluded_ids: f.excluded_ids }
      : {
          type: f.type, name: f.name, date: f.date, recurring: f.recurring, budget, notes: f.notes, audience: f.audience,
          // Someone who is picked as a participant is no longer left out
          excluded_ids: f.audience === 'selected' ? f.excluded_ids.filter((x) => !f.person_ids.includes(x)) : f.excluded_ids,
          ...(f.audience === 'selected' ? { person_ids: f.person_ids } : {}),
        }
    if (await call(id ? 'PUT' : 'POST', id ? `/api/occasions/${id}` : '/api/occasions', body)) close()
  }
  const moreOpen = !!(f.budget || f.notes || (id && !isBirthday && !f.recurring))
  return (
    <FormModal
      title={id ? t('forms.occasion.edit') : t('forms.occasion.new')}
      onSubmit={save}
      onDelete={id && !(isBirthday && initial!.date! >= s.today) ? async () => (await call('DELETE', `/api/occasions/${id}`)) && close() : undefined}
      moreOpen={moreOpen}
      more={
        <>
          {!isBirthday && (
            <Checkbox checked={f.recurring} onChange={(v) => set('recurring', v)}>{t('forms.occasion.recurring')}</Checkbox>
          )}
          <Field label={t('forms.budget')} error={bad(f.budget) && t('forms.numErr')}>
            <input className={`input ${bad(f.budget) ? 'input-invalid' : ''}`} inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder={t('forms.occasion.budgetPlaceholder')} value={f.budget} onChange={(e) => set('budget', e.target.value)} />
          </Field>
          <Field label={t('forms.notes')}><textarea className="input min-h-28" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        </>
      }
    >
      {isBirthday ? (
        <>
          <p className="text-sm text-muted">{t('forms.occasion.birthdayInfo')}</p>
          {birthdayPerson && !birthdayPerson.is_me && (
            <Checkbox checked={f.excluded_ids.includes(birthdayPerson.id)} onChange={(v) => set('excluded_ids', v ? [birthdayPerson.id] : [])}>{t('forms.occasion.birthdayLeaveOut')}</Checkbox>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('forms.occasion.type')}>
              <OccasionTypeSelect value={f.type} onChange={changeType} label={t('forms.occasion.type')} />
            </Field>
            <Field label={t('forms.date')}><DatePicker aria-label={t('forms.date')} required value={f.date} onChange={(v) => set('date', v)} /></Field>
          </div>
          {!id && <p className="meta -mt-1">{t('forms.occasion.birthdayHint')}</p>}
          <Field label={t('forms.name')}><input className="input" required placeholder={t('controls.picker.occNamePlaceholder')} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label={t('forms.occasion.who')} group>
            <Segmented<Audience> label={t('forms.occasion.who')} value={f.audience} onChange={(v) => { setAudienceSet(true); set('audience', v) }} options={[{ value: 'all', label: t('forms.occasion.audience.all') }, { value: 'selected', label: t('forms.occasion.audience.selected') }]} />
          </Field>
          {f.audience === 'all' ? (
            <Field label={t('forms.occasion.leaveOut')} group hint={t('forms.occasion.leaveOutHint')}>
              <PersonPicker label={t('forms.occasion.leaveOut')} create={false} placeholder={t('forms.occasion.leaveOutNone')} persons={activePersons.filter((p) => !p.is_me)} value={f.excluded_ids} onChange={(v) => set('excluded_ids', v)} />
            </Field>
          ) : (
            <Field label={t('forms.occasion.persons')} group>
              <PersonPicker label={t('forms.occasion.persons')} persons={activePersons} value={f.person_ids} onChange={(v) => set('person_ids', v)} />
            </Field>
          )}
        </>
      )}
    </FormModal>
  )
}

// ---------- Wish / idea ----------
export function ItemForm({ initial }: { initial?: Partial<Item> }) {
  const { call, close, activePersons, s, money, occasion } = useStore()
  const appCur = s.settings.currency || 'EUR'
  const id = realId(initial?.id)
  const [tried, setTried] = useState(false)
  const edited = useRef(new Set<string>())
  const [f, set, setF] = useForm({
    person_id: initial?.person_id ?? 0,
    occasion_id: initial?.occasion_id ?? 0,
    mentioned: !!initial?.mentioned,
    title: initial?.title ?? '',
    price: str(initial?.price),
    url: initial?.url ?? '',
    priority: initial?.priority ?? 2,
    source: initial?.source ?? '', // preserved unchanged even though the field is no longer shown
    notes: initial?.notes ?? '',
    status: initial?.status ?? ('open' as Item['status']),
    image_url: initial?.image_url ?? '',
    currency: initial?.currency ?? '',
  })
  const touch = (k: 'title' | 'price' | 'currency' | 'notes') => edited.current.add(k)
  const link = useLinkPreview((p) => {
    const can = (k: string, cur: string) => !edited.current.has(k) || !cur
    setF((old) => ({
      ...old,
      title: p.title && can('title', old.title) ? p.title : old.title,
      price: p.price != null && can('price', old.price) ? str(p.price) : old.price,
      currency: p.price != null && p.currency && can('currency', old.currency) ? p.currency : old.currency,
      notes: p.description && can('notes', old.notes) ? p.description : old.notes,
      image_url: p.image_url ?? old.image_url,
      url: /^[a-z][a-z0-9+.-]*:/i.test(old.url.trim()) ? old.url : 'https://' + old.url.trim(),
    }))
  })
  useEffect(() => {
    if (initial?.url && !initial.id && !initial.title) link.run(initial.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Person first: without one the dialog starts there (after the dialog's own initial focus)
  useEffect(() => { if (!initial?.person_id) document.getElementById('item-person')?.focus() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Occasions the person takes part in (a current one stays selectable)
  const personOccasions = s.occasions.filter((o) => o.id === f.occasion_id || (o.date >= s.today && o.person_ids.includes(f.person_id)))
  const pickPerson = (pid: number) => setF((old) => ({ ...old, person_id: pid, occasion_id: occasion(old.occasion_id)?.person_ids.includes(pid) ? old.occasion_id : 0 }))
  const save = async () => {
    setTried(true)
    if ((!f.person_id && id) || bad(f.price)) return
    const body = { ...f, occasion_id: f.occasion_id || null, ...(f.person_id ? {} : { person_id: undefined }), mentioned: f.mentioned ? 1 : 0, price: parseNum(f.price), image_url: f.image_url || null, currency: f.currency && f.currency !== appCur ? f.currency : null }
    if (await call(id ? 'PUT' : 'POST', id ? `/api/items/${id}` : '/api/items', body)) close()
  }
  const moreOpen = !!(f.notes || f.priority !== 2 || f.status !== 'open')
  return (
    <FormModal
      title={id ? t('forms.item.edit') : t('forms.item.new')}
      onSubmit={save}
      onDelete={id ? async () => (await call('DELETE', `/api/items/${id}`)) && close() : undefined}
      moreOpen={moreOpen}
      more={
        <>
          <Field label={t('forms.item.fit')} group>
            <Segmented label={t('forms.item.fit')} value={f.priority} onChange={(v) => set('priority', v)} options={[1, 2, 3].map((n) => ({ value: n, label: '★'.repeat(n) }))} />
          </Field>
          <Field label={t('forms.notes')}><textarea className="input min-h-28" placeholder={t('forms.item.notesPlaceholder')} value={f.notes} onChange={(e) => { touch('notes'); set('notes', e.target.value) }} /></Field>
          {id && (
            <Field label={t('forms.status')} group hint={t('forms.item.statusHint')}>
              <Segmented label={t('forms.status')} value={f.status} onChange={(v) => set('status', v)} options={[{ value: 'open' as Item['status'], label: t('forms.open') }, { value: 'done' as Item['status'], label: t('forms.item.done') }, { value: 'discarded' as Item['status'], label: t('forms.item.discarded') }]} />
            </Field>
          )}
        </>
      }
    >
      <Field label={t('forms.forWhom')} error={tried && !f.person_id && !!id && t('forms.item.needPerson')} hint={id ? undefined : t('inbox.laterHint')}>
        <PersonSelect id="item-person" label={t('forms.forWhom')} none={id ? undefined : t('inbox.later')} persons={activePersons.filter((p) => !p.is_me)} value={f.person_id} invalid={tried && !f.person_id && !!id} onChange={pickPerson} />
      </Field>
      {f.person_id !== 0 && (
        <Field label={t('forms.item.occasion')}>
          <OccasionSelect label={t('forms.item.occasion')} occasions={personOccasions} value={f.occasion_id} onChange={(oid) => set('occasion_id', oid)} personIds={[f.person_id]} />
        </Field>
      )}
      <Field label={t('forms.item.what')}><input className="input" required autoComplete="off" autoCapitalize="sentences" enterKeyHint="next" autoFocus={!!initial?.person_id && !isCoarse()} placeholder={t('forms.titlePlaceholder')} value={f.title} onChange={(e) => { touch('title'); set('title', e.target.value) }} /></Field>
      <Field label={t('forms.link')}>
        <input className="input" type="text" inputMode="url" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" placeholder={t('forms.linkPlaceholder')} value={f.url} onChange={(e) => set('url', e.target.value)} {...link.bind} />
        <LinkStatus loading={link.loading} error={link.error} ai={link.ai} />
        <PreviewCard
          image={f.image_url || null}
          title={link.pv?.title ?? null}
          shop={link.pv?.shop ?? null}
          price={parseNum(f.price) != null ? money(parseNum(f.price), f.currency || appCur) : ''}
          onRemoveImage={() => set('image_url', '')}
        />
      </Field>
      <Checkbox checked={f.mentioned} onChange={(v) => set('mentioned', v)}>{t('forms.item.mentioned')}</Checkbox>
      <Field label={t('forms.priceApprox')} group error={bad(f.price) && t('forms.numErr')}>
        <div className="flex gap-2">
          <input className={`input flex-1 ${bad(f.price) ? 'input-invalid' : ''}`} aria-label={t('forms.price')} inputMode="decimal" autoComplete="off" enterKeyHint="done" value={f.price} onChange={(e) => { touch('price'); set('price', e.target.value) }} />
          <Select className="w-28 shrink-0" aria-label={t('forms.currency')} value={f.currency || appCur} onChange={(e) => { touch('currency'); set('currency', e.target.value) }}>
            {[...new Set([appCur, 'EUR', 'USD', 'GBP', 'CHF', f.currency].filter(Boolean))].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
      </Field>
    </FormModal>
  )
}

// ---------- Gift: status, payment, shares, history ----------
/** Progress as a compact stepper (6 steps) plus the special case "Returned" */
function StatusStepper({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const idx = statusIndex(value)
  const returned = value === 'returned'
  return (
    <div className="space-y-2">
      <ol className="grid grid-cols-3 sm:grid-cols-6 gap-x-1.5 gap-y-1" aria-label={t('forms.status')}>
        {STATUS_STEPS.map((st, i) => (
          <li key={st.id} className="min-w-0">
            <button type="button" onClick={() => onChange(st.id)} aria-current={i === idx && !returned ? 'step' : undefined} className="w-full flex flex-col gap-1.5 text-left cursor-pointer py-1.5 pointer-coarse:min-h-11">
              <span className={`h-2 rounded-full ${!returned && i <= idx ? 'bg-accent' : 'bg-track'}`} />
              <span className={`text-xs break-words hyphens-auto leading-tight ${i === idx && !returned ? 'font-semibold text-ink' : 'text-muted'}`}>{st.label}</span>
            </button>
          </li>
        ))}
      </ol>
      <Checkbox checked={returned} onChange={(v) => onChange(v ? 'returned' : 'planned')}>{t('forms.gift.returned')}</Checkbox>
    </div>
  )
}

/** "Paid?": payment status, who paid, when, how, amount - saved via /payment */
function PaymentSection({ gift, payers }: { gift: Gift; payers: Person[] }) {
  const { call, s } = useStore()
  const [paid, setPaid] = useState(gift.payment_status === 'paid')
  const [{ payer_id: payer }, setPayer] = useRealState({ payer_id: gift.payer_id ?? 0 })
  const [at, setAt] = useState(gift.paid_at ?? s.today)
  const [method, setMethod] = useState(gift.payment_method ?? '')
  const [amount, setAmount] = useState(str(gift.paid_amount))
  const [error, setError] = useState('')
  const save = async () => {
    setError('')
    if (paid && !payer) return setError(t('forms.pay.needPayer'))
    if (bad(amount)) return setError(t('forms.pay.badAmount'))
    await call('POST', `/api/gifts/${gift.id}/payment`, paid ? { payment_status: 'paid', payer_id: payer, paid_at: at || null, payment_method: method || null, paid_amount: parseNum(amount) } : { payment_status: 'unpaid' })
  }
  const dirty = paid !== (gift.payment_status === 'paid') || (paid && (payer !== (gift.payer_id ?? 0) || at !== (gift.paid_at ?? '') || method !== (gift.payment_method ?? '') || parseNum(amount) !== (gift.paid_amount ?? null)))
  return (
    <div className="space-y-3 rounded-2xl bg-hover p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="h3">{t('forms.pay.title')}</h3>
        <Segmented label={t('forms.pay.status')} value={paid ? 'paid' : 'unpaid'} onChange={(v) => setPaid(v === 'paid')} options={[{ value: 'unpaid', label: t('forms.pay.unpaid') }, { value: 'paid', label: t('forms.pay.paid') }]} />
      </div>
      {paid && (
        <FormGrid>
          <Field label={t('forms.pay.who')}>
            <Select value={payer} onChange={(e) => setPayer({ payer_id: Number(e.target.value) })}>
              <option value={0}>{t('controls.picker.pleaseChoose')}</option>
              {payers.map((p) => <option key={p.id} value={p.id}>{p.is_me ? t('controls.picker.meSuffix', { name: p.name }) : p.name}</option>)}
            </Select>
          </Field>
          <Field label={t('forms.pay.when')}><DatePicker aria-label={t('forms.pay.paidOn')} value={at} onChange={setAt} /></Field>
          <Field label={t('forms.pay.how')}>
            <SuggestInput aria-label={t('forms.pay.method')} suggestions={PAYMENT_METHODS} placeholder={t('forms.pay.methodPlaceholder')} value={method} onChange={setMethod} />
          </Field>
          <Field label={t('forms.pay.amount')} hint={t('forms.pay.amountHint')}>
            <input className="input" inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder={gift.price != null ? str(gift.price) : t('forms.moneyPlaceholder')} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </FormGrid>
      )}
      <FormError>{error}</FormError>
      {dirty && <Button size="sm" variant="primary" onClick={save}>{t('forms.pay.save')}</Button>}
    </div>
  )
}

/** Shares per person: "share received" with date and method - via /givers/:id/settle */
function SharesSection({ gift }: { gift: Gift }) {
  const { call, person, money } = useStore()
  const [method, setMethod] = useState('')
  if (gift.givers.length < 2) return null
  const sh = shares(gift)
  const canSettle = gift.payment_status === 'paid' && !!gift.payer_id && gift.status !== 'returned'
  return (
    <div className="space-y-3 rounded-2xl bg-hover p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="h3">{t('forms.shares.title')}</h3>
        {gift.payment_summary && canSettle && (
          <Badge tone={gift.payment_summary.open_count ? 'warn' : 'ok'}>{gift.payment_summary.open_count ? t('forms.shares.openSummary', { count: gift.payment_summary.open_count, amount: money(gift.payment_summary.open_amount) }) : t('forms.shares.allSettled')}</Badge>
        )}
      </div>
      {!canSettle && <p className="meta">{t('forms.shares.hint')}</p>}
      {canSettle && (
        <Field label={t('forms.shares.via')} className="sm:max-w-xs">
          <SuggestInput aria-label={t('forms.shares.method')} suggestions={PAYMENT_METHODS} placeholder={t('forms.shares.methodPlaceholder')} value={method} onChange={setMethod} />
        </Field>
      )}
      <div className="space-y-2">
        {gift.givers.map((x) => {
          const p = person(x.person_id)
          const isPayer = x.person_id === gift.payer_id
          const state = shareState(gift, x.person_id, x.settled)
          return (
            <div key={x.person_id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              <span className="flex-1 basis-32 min-w-0 truncate font-medium">{p?.is_me ? t('forms.shares.you') : p?.name}</span>
              <Money n={sh.get(x.person_id) ?? 0} strong />
              {state === 'paid' && <Badge tone="accent">{t('forms.shares.hasPaid')}</Badge>}
              {state === 'open' && <Badge tone="warn">{t('forms.open').toLowerCase()}</Badge>}
              {state === 'settled' && <Badge tone="ok" icon={Check}>{x.settled_at ? t('forms.shares.receivedOn', { date: fmtDate(x.settled_at) }) : t('forms.shares.received')}{x.settle_method ? ` · ${x.settle_method}` : ''}</Badge>}
              {canSettle && !isPayer && (x.settled
                ? <Button size="sm" variant="ghost" onClick={() => call('POST', `/api/gifts/${gift.id}/givers/${x.person_id}/settle`, { settled: false })}>{t('forms.shares.undo')}</Button>
                : <Button size="sm" onClick={() => call('POST', `/api/gifts/${gift.id}/givers/${x.person_id}/settle`, { settled: true, method: method || null })}>{t('forms.shares.receive')}</Button>)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface GiftEvent { id: number; type: string; data: Record<string, unknown> | null; created_at: string; user_name: string | null }
/** Field name in the history ("Changed: ..."); unknown fields appear unchanged */
const fieldLabel = (f: string) => {
  const k = `forms.field.${f}` as TKey
  const m = t(k)
  return m === k ? f : m
}

/** History from /api/gifts/:id/events; reloads when the gift changes */
function GiftTimeline({ gift }: { gift: Gift }) {
  const { person, money } = useStore()
  const [events, setEvents] = useState<GiftEvent[] | null>(null)
  const stamp = `${gift.status}|${gift.payment_status}|${gift.givers.map((g) => g.settled).join('')}|${gift.price}`
  useEffect(() => { api<GiftEvent[]>('GET', `/api/gifts/${gift.id}/events`).then(setEvents).catch(() => setEvents([])) }, [gift.id, stamp])
  const nameOf = (id: unknown) => (typeof id === 'number' ? person(id)?.name : undefined) ?? t('forms.tl.someone')
  const text = (e: GiftEvent) => {
    const d = e.data ?? {}
    switch (e.type) {
      case 'created': return t('forms.tl.created')
      case 'status': return t('forms.tl.status', { from: statusInfo(String(d.from)).label, to: statusInfo(String(d.to)).label })
      case 'paid': return `${t('forms.tl.paid', { name: nameOf(d.by) })}${d.amount != null ? ` · ${money(Number(d.amount))}` : ''}${d.method ? ` · ${d.method}` : ''}`
      case 'unpaid': return t('forms.tl.unpaid')
      case 'share_settled': return `${d.amount != null ? t('forms.tl.shareSettledAmount', { name: nameOf(d.person_id), amount: money(Number(d.amount)) }) : t('forms.tl.shareSettled', { name: nameOf(d.person_id) })}${d.method ? ` · ${d.method}` : ''}`
      case 'share_unsettled': return t('forms.tl.shareUnsettled', { name: nameOf(d.person_id) })
      case 'edited': return t('forms.tl.edited', { fields: ((d.fields as string[]) ?? []).map(fieldLabel).join(', ') })
      default: return e.type
    }
  }
  const when = (s: string) => fmtDateTime(s)
  return (
    <div className="space-y-2">
      <h3 className="h3">{t('forms.tl.title')}</h3>
      {!events ? <p className="meta">{t('common.loading')}</p> : !events.length ? <p className="meta">{t('forms.tl.empty')}</p> : (
        <ol className="space-y-2 border-l-2 border-line pl-4">
          {events.map((e) => (
            <li key={e.id} className="relative text-sm">
              <span className="absolute -left-[1.4rem] top-1.5 size-2.5 rounded-full bg-accent" aria-hidden />
              <div>{text(e)}</div>
              <div className="meta">{[e.user_name, when(e.created_at)].filter(Boolean).join(' · ')}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function GiftForm({ initial }: { initial?: Partial<Gift> }) {
  const { call, close, s, person, occasion, occasionTitle, me, money } = useStore()
  const appCur = s.settings.currency || 'EUR'
  const id = realId(initial?.id)
  // For existing gifts, status, payment and shares come live from the state (own endpoints)
  const live = (id ? s.gifts.find((g) => g.id === id) : undefined) ?? (initial as Gift | undefined)
  // Recipients first: without any the dialog starts there (after the dialog's own initial focus)
  useEffect(() => { if (!initial?.recipient_ids?.length) document.getElementById('gift-recipients')?.focus() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const edited = useRef(new Set<string>())
  const [curHint, setCurHint] = useState('')
  const [tried, setTried] = useState(false)
  // Recipients left out of an occasion (those an existing gift already has there stay valid)
  const leftOutOf = (oid: number | null | undefined, ids: number[]) => {
    const o = oid ? occasion(oid) : undefined
    return o ? ids.filter((pid) => o.excluded_ids.includes(pid) && !(id && oid === initial?.occasion_id && initial?.recipient_ids?.includes(pid))) : []
  }
  const occResetHint = (oid: number | null | undefined, out: number[]) => {
    const o = oid ? occasion(oid) : undefined
    return o && out.length ? t('forms.gift.occReset', { occasion: occasionTitle(o), names: joinNames(out.map((pid) => person(pid)?.name ?? '')) }) : ''
  }
  // A new gift can be prefilled (e.g. from an idea) with an occasion its recipient has been left out of since
  const [startOut] = useState(() => leftOutOf(initial?.occasion_id, initial?.recipient_ids ?? []))
  const [occHint, setOccHint] = useState(() => occResetHint(initial?.occasion_id, startOut))
  const [f, set, setF] = useForm({
    order_number: initial?.order_number ?? '',
    carrier: initial?.carrier ?? '',
    tracking_number: initial?.tracking_number ?? '',
    tracking_url: initial?.tracking_url ?? '',
    expected_at: initial?.expected_at ?? '',
    image_url: initial?.image_url ?? '',
    title: initial?.title ?? '',
    occasion_id: startOut.length ? 0 : initial?.occasion_id ?? 0,
    recipient_ids: initial?.recipient_ids ?? [],
    price: str(initial?.price),
    status: initial?.status ?? 'planned',
    shop: initial?.shop ?? '',
    url: initial?.url ?? '',
    notes: initial?.notes ?? '',
    date: initial?.date ?? '',
    item_id: initial?.item_id ?? null,
  })
  const link = useLinkPreview((p) => {
    const can = (k: string, cur: string) => !edited.current.has(k) || !cur
    const foreign = p.price != null && !!p.currency && p.currency !== appCur
    setCurHint(foreign ? t('forms.gift.foreignPrice', { currency: p.currency ?? '' }) : '')
    setF((old) => ({
      ...old,
      title: p.title && can('title', old.title) ? p.title : old.title,
      price: p.price != null && !foreign && can('price', old.price) ? str(p.price) : old.price,
      image_url: p.image_url ?? old.image_url,
      url: /^[a-z][a-z0-9+.-]*:/i.test(old.url.trim()) ? old.url : 'https://' + old.url.trim(),
    }))
  })
  const [givers, setGivers] = useRealState<{ person_id: number; amount: string }[]>(
    (initial?.givers ?? (me ? [{ person_id: me.id, amount: null, settled: 0 } as Giver] : [])).map((g) => ({ person_id: g.person_id, amount: str(g.amount) })),
  )
  const [split, setSplit] = useState(givers.length > 1 || givers.some((g) => g.person_id !== me?.id))
  const multi = givers.length > 1
  const price = parseNum(f.price)
  const calc = shares({ price, givers: givers.map((g) => ({ person_id: g.person_id, amount: parseNum(g.amount), settled: 0 })) })
  const fixedSum = givers.reduce((a, g) => a + (parseNum(g.amount) ?? 0), 0)
  const mismatch = multi && price != null && (fixedSum > price + 0.005 || (givers.every((g) => g.amount !== '') && Math.abs(fixedSum - price) > 0.005))
  const badNum = bad(f.price) || (multi && givers.some((g) => bad(g.amount)))

  const occasions = [...s.occasions.filter((o) => o.date >= s.today), ...s.occasions.filter((o) => o.date < s.today).reverse()]
  const pickOccasion = (oid: number) => {
    const o = occasion(oid)
    setOccHint('')
    setF((old) => ({
      ...old,
      occasion_id: oid,
      recipient_ids: !old.recipient_ids.length && o?.person_ids.length === 1 && !person(o.person_ids[0])?.is_me ? o.person_ids : old.recipient_ids,
    }))
  }
  // A chosen occasion the new recipients are left out of is dropped, with a hint
  const setRecipients = (ids: number[]) => {
    const out = leftOutOf(f.occasion_id, ids)
    setF((old) => ({ ...old, recipient_ids: ids, occasion_id: out.length ? 0 : old.occasion_id }))
    setOccHint(occResetHint(f.occasion_id, out))
    setGivers((old) => old.filter((g) => !ids.includes(g.person_id)))
  }
  const toggleGivers = (ids: number[]) =>
    setGivers((old) => ids.map((pid) => old.find((g) => g.person_id === pid) ?? { person_id: pid, amount: '' }))
  const setGiver = (pid: number, patch: Partial<{ amount: string }>) =>
    setGivers((old) => old.map((g) => (g.person_id === pid ? { ...g, ...patch } : g)))

  const save = async () => {
    setTried(true)
    if (badNum || mismatch || !f.recipient_ids.length) return
    // Existing gifts: status/payment/refund go through their own endpoints, only master data here
    const { status, ...rest } = f
    const body = {
      ...rest,
      ...(id ? {} : { status }),
      order_number: f.order_number || null,
      carrier: f.carrier || null,
      tracking_number: f.tracking_number || null,
      tracking_url: f.tracking_url || null,
      expected_at: f.expected_at || null,
      image_url: f.image_url || null,
      price,
      occasion_id: f.occasion_id || null,
      givers: givers.map((g) => ({ person_id: g.person_id, amount: multi ? parseNum(g.amount) : null })),
    }
    if (await call(id ? 'PUT' : 'POST', id ? `/api/gifts/${id}` : '/api/gifts', body)) close()
  }
  // Archived persons attached to this gift remain selectable
  const selectable = s.persons.filter((p) => !p.archived || f.recipient_ids.includes(p.id) || givers.some((g) => g.person_id === p.id))
  const single = givers.length === 1 ? person(givers[0].person_id) : undefined
  const moreOpen = !!(f.shop || f.url || f.notes || (!f.occasion_id && f.date))

  return (
    <FormModal
      title={id ? t('forms.gift.edit') : t('forms.gift.new')}
      onSubmit={save}
      onDelete={id ? async () => (await call('DELETE', `/api/gifts/${id}`)) && close() : undefined}
      moreOpen={moreOpen}
      more={
        <>
          <Field label={t('forms.gift.shop')}><input className="input" value={f.shop} onChange={(e) => set('shop', e.target.value)} /></Field>
          <Field label={t('forms.link')}>
            <input className="input" type="text" inputMode="url" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={t('forms.linkPlaceholder')} value={f.url} onChange={(e) => set('url', e.target.value)} {...link.bind} />
            <LinkStatus loading={link.loading} error={link.error} ai={link.ai} />
            <PreviewCard image={f.image_url || null} title={link.pv?.title ?? null} shop={link.pv?.shop ?? null} price="" onRemoveImage={() => set('image_url', '')} />
          </Field>
          <Field label={t('forms.notes')}><textarea className="input min-h-28" placeholder={t('forms.gift.notesPlaceholder')} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          {!f.occasion_id && <Field label={t('forms.date')}><DatePicker aria-label={t('forms.date')} value={f.date} onChange={(v) => set('date', v)} /></Field>}
        </>
      }
    >
      <Field label={t('forms.forWhom')} group error={tried && !f.recipient_ids.length && t('forms.gift.needRecipient')}>
        <PersonPicker id="gift-recipients" label={t('forms.forWhom')} persons={selectable.filter((p) => !p.is_me)} value={f.recipient_ids} onChange={setRecipients} />
      </Field>
      <Field label={t('forms.gift.occasion')} hint={occHint || undefined}>
        <OccasionSelect label={t('forms.gift.occasion')} occasions={occasions} value={f.occasion_id} onChange={pickOccasion} personIds={f.recipient_ids} />
      </Field>
      <Field label={t('forms.gift.what')}><input className="input" required autoComplete="off" autoCapitalize="sentences" enterKeyHint="next" autoFocus={!!initial?.recipient_ids?.length && !isCoarse()} value={f.title} onChange={(e) => { edited.current.add('title'); set('title', e.target.value) }} /></Field>
      <Field label={t('forms.status')} group>
        <StatusStepper value={id && live ? live.status : f.status} onChange={(v) => (id ? void call('POST', `/api/gifts/${id}/status`, { status: v }) : set('status', v))} />
      </Field>
      <Field label={t('forms.gift.totalPrice')} hint={curHint || undefined} error={bad(f.price) && t('forms.numErr')}>
        <input className={`input ${bad(f.price) ? 'input-invalid' : ''}`} inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder={t('forms.moneyPlaceholder')} value={f.price} onChange={(e) => { edited.current.add('price'); setCurHint(''); set('price', e.target.value) }} />
      </Field>

      {!split ? (
        <div className="flex items-center justify-between gap-3 text-sm text-muted">
          <span>{!single || single.is_me ? t('forms.gift.fromYou') : single.name}</span>
          <Button variant="link" onClick={() => setSplit(true)}>{t('forms.gift.together')}</Button>
        </div>
      ) : (
        <>
          <Field label={t('forms.gift.fromWhom')} group>
            <PersonPicker label={t('forms.gift.fromWhom')} persons={selectable.filter((p) => !f.recipient_ids.includes(p.id))} value={givers.map((g) => g.person_id)} onChange={toggleGivers} />
          </Field>
          {multi && s.permissions.view_expenses && (
            <Field label={t('forms.gift.split')} group className="space-y-1.5">
              {givers.map((g) => (
                <div key={g.person_id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">{person(g.person_id)?.name}</span>
                  <input className={`input !w-28 text-right ${bad(g.amount) ? 'input-invalid' : ''}`} aria-label={t('forms.gift.shareOf', { name: person(g.person_id)?.name ?? '' })} inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder={price != null ? money(calc.get(g.person_id)) : t('forms.gift.share')} value={g.amount} onChange={(e) => setGiver(g.person_id, { amount: e.target.value })} />
                </div>
              ))}
              <FormError>{givers.some((g) => bad(g.amount)) ? t('forms.gift.badShares') : null}</FormError>
              <FormError>{mismatch ? t('forms.gift.mismatch', { sum: money(fixedSum), price: money(price) }) : null}</FormError>
            </Field>
          )}
        </>
      )}
      {id && live && statusIndex(live.status) >= 1 && live.status !== 'returned' && (
        <div className="space-y-3 rounded-2xl bg-hover p-4">
          <h3 className="h3">{t('forms.gift.shipping')}</h3>
          <FormGrid>
            <Field label={t('forms.gift.orderNumber')}><input className="input" value={f.order_number} onChange={(e) => set('order_number', e.target.value)} /></Field>
            <Field label={t('forms.gift.carrier')}><SuggestInput aria-label={t('forms.gift.carrier')} suggestions={['DHL', 'DPD', 'Hermes', 'UPS', 'GLS', 'Amazon Logistics']} placeholder={t('forms.gift.carrierPlaceholder')} value={f.carrier} onChange={(v) => set('carrier', v)} /></Field>
            <Field label={t('forms.gift.trackingNumber')}><input className="input" value={f.tracking_number} onChange={(e) => set('tracking_number', e.target.value)} /></Field>
            <Field label={t('forms.gift.expected')}><DatePicker aria-label={t('forms.gift.expected')} value={f.expected_at} onChange={(v) => set('expected_at', v)} /></Field>
          </FormGrid>
          <Field label={t('forms.gift.trackingLink')}><input className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://…" value={f.tracking_url} onChange={(e) => set('tracking_url', e.target.value)} /></Field>
          <p className="meta">{t('forms.gift.saveHint')}</p>
        </div>
      )}
      {id && live ? (
        <>
          <PaymentSection key={`${live.id}-${live.payment_status}-${live.payer_id}`} gift={live} payers={selectable.filter((p) => !f.recipient_ids.includes(p.id))} />
          <SharesSection gift={live} />
          <GiftTimeline gift={live} />
        </>
      ) : (
        <p className="meta">{t('forms.gift.afterCreate')}</p>
      )}
    </FormModal>
  )
}

// ---------- Wish (the user's wishlist) ----------
export function WishForm({ listId, initial, onClose, onSaved }: { listId: number; initial?: Partial<Wish>; onClose: () => void; onSaved: () => void }) {
  const { s, money } = useStore()
  const toast = useToast()
  const appCur = s.settings.currency || 'EUR'
  const id = realId(initial?.id)
  const edited = useRef(new Set<string>())
  const [tried, setTried] = useState(false)
  const [f, set, setF] = useForm({
    title: initial?.title ?? '',
    url: initial?.url ?? '',
    price: str(initial?.price),
    currency: initial?.currency ?? '',
    priority: initial?.priority ?? 2,
    notes: initial?.notes ?? '',
    image_url: initial?.image_url ?? '',
    status: initial?.status ?? ('open' as Wish['status']),
  })
  const touch = (k: 'title' | 'price' | 'currency' | 'notes') => edited.current.add(k)
  const link = useLinkPreview((p) => {
    const can = (k: string, cur: string) => !edited.current.has(k) || !cur
    setF((old) => ({
      ...old,
      title: p.title && can('title', old.title) ? p.title : old.title,
      price: p.price != null && can('price', old.price) ? str(p.price) : old.price,
      currency: p.price != null && p.currency && can('currency', old.currency) ? p.currency : old.currency,
      notes: p.description && can('notes', old.notes) ? p.description : old.notes,
      image_url: p.image_url ?? old.image_url,
      url: /^[a-z][a-z0-9+.-]*:/i.test(old.url.trim()) ? old.url : 'https://' + old.url.trim(),
    }))
  })
  useEffect(() => {
    if (initial?.url && !initial.id && !initial.title) link.run(initial.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const save = async () => {
    setTried(true)
    if (!f.title.trim() || bad(f.price)) return
    const body = { ...f, price: parseNum(f.price), image_url: f.image_url || null, currency: f.currency && f.currency !== appCur ? f.currency : null }
    try {
      await api(id ? 'PUT' : 'POST', id ? `/api/wishes/${id}` : `/api/wishlists/${listId}/wishes`, body)
      onSaved()
      onClose()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const del = async () => {
    try {
      await api('DELETE', `/api/wishes/${id}`)
      onSaved()
      onClose()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  return (
    <FormModal
      title={id ? t('forms.wish.edit') : t('wishlists.addWish')}
      onClose={onClose}
      onSubmit={save}
      onDelete={id ? del : undefined}
      moreOpen={!!(f.notes || f.priority !== 2 || f.status !== 'open')}
      more={
        <>
          <Field label={t('forms.wish.priority')} group>
            <Segmented label={t('forms.wish.priority')} value={f.priority} onChange={(v) => set('priority', v)} options={[1, 2, 3].map((n) => ({ value: n, label: '★'.repeat(n) }))} />
          </Field>
          <Field label={t('forms.notes')}><textarea className="input min-h-28" placeholder={t('forms.wish.notesPlaceholder')} value={f.notes} onChange={(e) => { touch('notes'); set('notes', e.target.value) }} /></Field>
          {id && (
            <Field label={t('forms.status')} group hint={t('forms.wish.statusHint')}>
              <Segmented label={t('forms.status')} value={f.status} onChange={(v) => set('status', v)} options={[{ value: 'open' as Wish['status'], label: t('forms.open') }, { value: 'received' as Wish['status'], label: t('forms.wish.received') }]} />
            </Field>
          )}
        </>
      }
    >
      <Field label={t('forms.wish.what')} error={tried && !f.title.trim() && t('forms.wish.needTitle')}>
        <input className="input" required autoComplete="off" autoCapitalize="sentences" enterKeyHint="next" autoFocus={!isCoarse()} placeholder={t('forms.titlePlaceholder')} value={f.title} onChange={(e) => { touch('title'); set('title', e.target.value) }} />
      </Field>
      <Field label={t('forms.link')}>
        <input className="input" type="text" inputMode="url" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" placeholder={t('forms.linkPlaceholder')} value={f.url} onChange={(e) => set('url', e.target.value)} {...link.bind} />
        <LinkStatus loading={link.loading} error={link.error} ai={link.ai} />
        <PreviewCard image={f.image_url || null} title={link.pv?.title ?? null} shop={link.pv?.shop ?? null} price={parseNum(f.price) != null ? money(parseNum(f.price), f.currency || appCur) : ''} onRemoveImage={() => set('image_url', '')} />
      </Field>
      <Field label={t('forms.priceApprox')} group error={bad(f.price) && t('forms.numErr')}>
        <div className="flex gap-2">
          <input className={`input flex-1 ${bad(f.price) ? 'input-invalid' : ''}`} aria-label={t('forms.price')} inputMode="decimal" autoComplete="off" enterKeyHint="done" value={f.price} onChange={(e) => { touch('price'); set('price', e.target.value) }} />
          <Select className="w-28 shrink-0" aria-label={t('forms.currency')} value={f.currency || appCur} onChange={(e) => { touch('currency'); set('currency', e.target.value) }}>
            {[...new Set([appCur, 'EUR', 'USD', 'GBP', 'CHF', f.currency].filter(Boolean))].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
      </Field>
    </FormModal>
  )
}

// ---------- Wishlist ----------
export function ListForm({ initial, onClose, onSaved }: { initial?: MyWishlist; onClose: () => void; onSaved: (l: MyWishlist | null) => void }) {
  const toast = useToast()
  const id = realId(initial?.id)
  const [f, set] = useForm({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    event_date: initial?.event_date ?? '',
    archived: !!initial?.archived,
  })
  const save = async () => {
    try {
      const body = { title: f.title.trim(), description: f.description.trim() || null, event_date: f.event_date || null, ...(id ? { archived: f.archived } : {}) }
      onSaved(await api<MyWishlist>(id ? 'PUT' : 'POST', id ? `/api/wishlists/${id}` : '/api/wishlists', body))
      onClose()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const del = async () => {
    try {
      await api('DELETE', `/api/wishlists/${id}`)
      onSaved(null)
      onClose()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  return (
    <FormModal title={id ? t('forms.list.edit') : t('wishlists.new')} onClose={onClose} onSubmit={save} onDelete={id ? del : undefined}>
      <Field label={t('forms.list.title')}><input className="input" required autoFocus maxLength={120} placeholder={t('forms.list.titlePlaceholder')} value={f.title} onChange={(e) => set('title', e.target.value)} /></Field>
      <Field label={t('forms.list.eventDate')}><DatePicker aria-label={t('forms.list.eventDateAria')} value={f.event_date} onChange={(v) => set('event_date', v)} /></Field>
      <Field label={t('forms.list.description')}><textarea className="input min-h-28" placeholder={t('forms.list.descriptionPlaceholder')} value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
      {id && <Checkbox checked={f.archived} onChange={(v) => set('archived', v)}>{t('forms.list.archived')}</Checkbox>}
    </FormModal>
  )
}

// ---------- "Add" menu ----------
export function AddMenu({ start = 'menu' }: { start?: 'menu' | 'lists' }) {
  const { close, open } = useStore()
  const nav = useNavigate()
  const [lists, setLists] = useState<MyWishlist[] | null>(null)
  const [step, setStep] = useState<'menu' | 'lists'>(start)
  const [target, setTarget] = useState<MyWishlist | null>(null)
  const [newList, setNewList] = useState(false)
  const toast = useToast()
  const createList = async (title: string) => {
    try {
      setTarget(await api<MyWishlist>('POST', '/api/wishlists', { title }))
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const loadLists = () => api<WishlistsOverview>('GET', '/api/wishlists').then((o) => setLists(o.mine.filter((l) => !l.archived))).catch(() => setLists([]))
  useEffect(() => { if (start === 'lists') void loadLists() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const pickWish = () => {
    setStep('lists')
    if (!lists) void loadLists()
  }
  if (target) return <WishForm listId={target.id} onClose={close} onSaved={() => nav(`/wishlists/${target.id}`)} />
  return (
    <Modal compact title={step === 'menu' ? t('forms.add.title') : t('ai.import.whichList')} onClose={close}>
      {step === 'menu' ? (
        <List>
          <Row lead={<Thumb icon={Lightbulb} />} title={t('forms.item.new')} meta={t('forms.add.ideaMeta')} onClick={() => open({ type: 'item' })} />
          <Row lead={<Thumb icon={Heart} />} title={t('wishlists.addWish')} meta={t('forms.add.wishMeta')} onClick={pickWish} />
        </List>
      ) : (
        <List empty={<p className="text-sm text-muted">{lists ? t('forms.add.noLists') : t('common.loading')}</p>}>
          {(lists ?? []).map((l) => <Row key={l.id} dense lead={<Thumb size={32} icon={Heart} />} title={l.title} meta={t('wishlists.wishCount', { count: l.wish_count })} onClick={() => setTarget(l)} />)}
        </List>
      )}
      {step === 'lists' && lists && (
        newList
          ? <NameForm placeholder={t('forms.add.newListTitle')} submitLabel={t('forms.add.createContinue')} onSubmit={createList} onCancel={() => setNewList(false)} />
          : <List><Row dense lead={<Thumb size={32} icon={Plus} tone="accent" />} title={`+ ${t('wishlists.new')}`} onClick={() => setNewList(true)} /></List>
      )}
    </Modal>
  )
}

export function DialogHost() {
  const { dialog, close } = useStore()
  if (!dialog) return null
  if (dialog.type === 'add') return <AddMenu key="add" />
  if (dialog.type === 'wish') return <AddMenu key="wish" start="lists" />
  if (dialog.type === 'ai-import') return <ImportDialog key="ai" init={dialog.init} onClose={close} />
  if (dialog.type === 'item-detail') return <ItemDetail key={`item-detail-${dialog.initial.id}`} initial={dialog.initial} />
  if (dialog.type === 'gift-detail') return <GiftDetail key={`gift-detail-${dialog.initial.id}`} initial={dialog.initial} />
  const key = `${dialog.type}-${dialog.initial?.id ?? 'new'}`
  if (dialog.type === 'person') return <PersonForm key={key} initial={dialog.initial} focus={dialog.focus} />
  if (dialog.type === 'occasion') return <OccasionForm key={key} initial={dialog.initial} />
  if (dialog.type === 'item') return <ItemForm key={key} initial={dialog.initial} />
  return <GiftForm key={key} initial={dialog.initial} />
}
