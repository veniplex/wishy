import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, ImageUp, Lightbulb, Search, Sparkles } from 'lucide-react'
import { api, errMsg, type AiItem, type AiStatus, type AiSuggestion, type MyWishlist, type WishlistsOverview } from './api'
import { useStore } from './store'
import { useAuth } from './auth'
import { parseNum, daysUntil } from './lib'
import { Badge, Button, Checkbox, Field, FilePicker, FormError, Modal, Money, PillTabs, Select, useToast } from './ui'
import { PersonSelect, WishlistSelect } from './pickers'
import { isCoarse } from './controls'
import { getLocale, t } from './i18n'

// ───────────────────────────── Status ─────────────────────────────

const OFF: AiStatus = { enabled: false, features: { link_import: false, text_import: false, image_import: false, suggestions: false }, provider_label: null }
let cached: AiStatus | null = null
let pending: Promise<AiStatus> | null = null
const listeners = new Set<(s: AiStatus) => void>()

/** Reload status (e.g. after saving the AI settings) */
export function resetAiStatus() {
  cached = null
  pending = null
  void loadStatus()
}
function loadStatus() {
  pending ??= api<AiStatus>('GET', '/api/ai/status').then((s) => {
    cached = s
    listeners.forEach((l) => l(s))
    return s
  }).catch(() => {
    pending = null // asked again by the next component
    return OFF
  })
  return pending
}

/** Is AI enabled, and which features are released? (only then does the app show AI entry points) */
function useRawAiStatus() {
  const [s, setS] = useState<AiStatus>(cached ?? OFF)
  useEffect(() => {
    listeners.add(setS)
    if (cached) setS(cached)
    else void loadStatus()
    return () => void listeners.delete(setS)
  }, [])
  return s
}

/** Is AI available for this user? Same as the global status, but off if the server blocks AI for the user (me.user.features.ai === false). Overview of all toggles: `useFeatures()`. */
export function useAiStatus() {
  const s = useRawAiStatus()
  const { user } = useAuth()
  return user?.features.ai === false ? OFF : s
}

// ───────────────────────────── Link import mode ─────────────────────────────

export type LinkMode = 'builtin' | 'ai'
const LM_KEY = 'wishy.linkMode'
let storedMode: LinkMode | null = (() => {
  try {
    const v = localStorage.getItem(LM_KEY)
    return v === 'ai' || v === 'builtin' ? v : null
  } catch {
    return null
  }
})()
let fellBack = false
const modeListeners = new Set<() => void>()
const fireMode = () => modeListeners.forEach((l) => l())

/** Tell the picker that the last link was read by the built-in parser because the AI was not available */
export function setLinkFallback(v: boolean) {
  if (fellBack === v) return
  fellBack = v
  fireMode()
}

/** How links are read: the user's last choice (kept in this browser), else the admin default. Without AI for link import only 'builtin'. */
export function useLinkMode() {
  const ai = useAiStatus()
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    modeListeners.add(l)
    return () => void modeListeners.delete(l)
  }, [])
  const available = ai.enabled && ai.features.link_import
  const mode: LinkMode = available ? storedMode ?? ai.link_mode ?? 'ai' : 'builtin'
  const set = (m: LinkMode) => {
    storedMode = m
    fellBack = false
    try { localStorage.setItem(LM_KEY, m) } catch { /* private mode: the choice just isn't remembered */ }
    fireMode()
  }
  return { available, mode, set, fellBack }
}

/** Choice per link import: built-in parser or AI (only offered when AI can read links) */
export function LinkModePicker() {
  const { available, mode, set, fellBack } = useLinkMode()
  if (!available) return null
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="meta">{t('ai.linkMode.label')}</span>
        <PillTabs label={t('ai.linkMode.label')} value={mode} onChange={set} items={[{ value: 'builtin', label: t('ai.linkMode.builtin') }, { value: 'ai', label: <span className="inline-flex items-center gap-1"><Sparkles size={13} />{t('ai.linkMode.ai')}</span> }]} />
      </div>
      {mode === 'ai' && <p className="meta">{t('ai.linkMode.aiHint')}</p>}
      {fellBack && <p className="meta text-warn">{t('ai.linkMode.fallback')}</p>}
    </div>
  )
}

/** Consistent "AI" badge with a tooltip; `feature` adds what is sent to the provider. Put it on everything that triggers or uses AI. */
export const AiBadge = ({ feature }: { feature?: AiFeatureKey }) => {
  const hint = feature ? `${t('ai.badgeHint')} ${t(`ai.sent.${feature}` as const)}` : t('ai.badgeHint')
  return <span title={hint} className="inline-flex shrink-0"><Badge tone="accent" icon={Sparkles}>{t('ai.badge')}</Badge></span>
}

export type AiFeatureKey = 'link_import' | 'text_import' | 'image_import' | 'suggestions'

/** Short, plain note at the place where an AI request is started: what is sent to the provider */
export const AiNotice = ({ feature }: { feature: AiFeatureKey }) => (
  <p className="meta flex items-start gap-2"><AiBadge feature={feature} /><span>{t(`ai.sent.${feature}` as const)}</span></p>
)

/** Small "AI" marker for values filled in or cleaned up by the AI */
export const AiMark = ({ children }: { children?: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 text-xs text-muted"><Badge tone="accent" icon={Sparkles}>{t('ai.badge')}</Badge>{children}</span>
)

// ───────────────────────────── Prepare image ─────────────────────────────

/** Downscaled to at most 1600 px and <= ~4.5 MB (JPEG) */
async function prepareImage(file: Blob) {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    throw new Error(t('ai.image.unreadable'))
  }
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bmp.width * scale))
  canvas.height = Math.max(1, Math.round(bmp.height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  let q = 0.9
  let url = canvas.toDataURL('image/jpeg', q)
  while (url.length * 0.75 > 4.5e6 && q > 0.4) {
    q -= 0.1
    url = canvas.toDataURL('image/jpeg', q)
  }
  if (url.length * 0.75 > 5e6) throw new Error(t('ai.image.tooLarge'))
  return { base64: url.slice(url.indexOf(',') + 1), media_type: 'image/jpeg', preview: url }
}

// ───────────────────────────── Import dialog ─────────────────────────────

export interface ImportInit { target?: 'wishes' | 'ideas'; personId?: number; listId?: number }
interface Draft { key: number; on: boolean; title: string; notes: string; price: string; url: string; currency: string | null; personId: number; mentioned: boolean }

/** "Import with AI": text or image → review and edit suggestions → accept */
export function ImportDialog({ init, onClose, onDone }: { init?: ImportInit; onClose: () => void; onDone?: (r: { target: 'wishes' | 'ideas'; listId?: number }) => void }) {
  const ai = useAiStatus()
  const { s, activePersons, reload } = useStore()
  const toast = useToast()
  const appCur = s.settings.currency || 'EUR'
  const [target, setTarget] = useState<'wishes' | 'ideas'>(init?.target ?? 'wishes')
  const [tab, setTab] = useState<'text' | 'image'>('text')
  const [text, setText] = useState('')
  const [img, setImg] = useState<{ base64: string; media_type: string; preview: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [lists, setLists] = useState<MyWishlist[]>([])
  const [listId, setListId] = useState(init?.listId ?? 0)
  const others = activePersons.filter((p) => !p.is_me)

  const textOk = ai.features.text_import
  const imageOk = ai.features.image_import
  useEffect(() => {
    if (!textOk && imageOk) setTab('image')
  }, [textOk, imageOk])
  useEffect(() => {
    api<WishlistsOverview>('GET', '/api/wishlists').then((o) => {
      const mine = o.mine.filter((l) => !l.archived)
      setLists(mine)
      setListId((cur) => cur || mine[0]?.id || 0)
    }).catch(() => {})
  }, [])

  const setImage = useCallback(async (blob: Blob | null | undefined) => {
    if (!blob) return
    setError('')
    try {
      setImg(await prepareImage(blob))
    } catch (e) {
      setImg(null)
      setError(errMsg(e))
    }
  }, [])
  // Paste image from the clipboard (screenshot)
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'))
      if (f && imageOk) { setTab('image'); void setImage(f) }
    }
    window.addEventListener('paste', h)
    return () => window.removeEventListener('paste', h)
  }, [imageOk, setImage])

  const match = (name?: string | null) => {
    if (!name) return 0
    const n = name.trim().toLowerCase()
    return others.find((p) => p.name.toLowerCase() === n)?.id ?? others.find((p) => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()))?.id ?? 0
  }
  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const r = tab === 'text'
        ? await api<{ items: AiItem[] }>('POST', '/api/ai/extract-text', { text, target })
        : await api<{ items: AiItem[] }>('POST', '/api/ai/extract-image', { image_base64: img!.base64, media_type: img!.media_type })
      if (!r.items.length) return setError(t('ai.import.noItems'))
      setDrafts(r.items.map((it, i) => ({
        key: i,
        on: true,
        title: it.title,
        notes: it.notes ?? '',
        price: it.price != null ? (getLocale() === 'de' ? String(it.price).replace('.', ',') : String(it.price)) : '',
        url: it.url ?? '',
        currency: it.currency,
        personId: match(it.person_name) || init?.personId || 0,
        mentioned: !!it.mentioned,
      })))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const upd = (key: number, patch: Partial<Draft>) => setDrafts((d) => d && d.map((x) => (x.key === key ? { ...x, ...patch } : x)))

  const take = async () => {
    const picked = (drafts ?? []).filter((d) => d.on && d.title.trim())
    if (!picked.length) return setError(t('ai.import.pickOne'))
    if (target === 'ideas' && picked.some((d) => !d.personId)) return setError(t('ai.import.needPerson'))
    if (target === 'wishes' && !listId) return setError(t('ai.import.needList'))
    setBusy(true)
    setError('')
    let ok = 0
    try {
      for (const d of picked) {
        const price = parseNum(d.price)
        const currency = d.currency && d.currency !== appCur ? d.currency : null
        if (target === 'wishes') await api('POST', `/api/wishlists/${listId}/wishes`, { title: d.title.trim(), notes: d.notes || null, price, currency, url: d.url || null })
        else await api('POST', '/api/items', { title: d.title.trim(), notes: d.notes || null, price, currency, url: d.url || null, person_id: d.personId, mentioned: d.mentioned ? 1 : 0 })
        ok++
      }
    } catch (e) {
      setError(ok ? t('ai.import.partialError', { count: ok, error: errMsg(e) }) : errMsg(e))
      setBusy(false)
      if (ok) { void reload(); setDrafts((d) => d && d.filter((x) => !(x.on && picked.slice(0, ok).some((p) => p.key === x.key)))) }
      return
    }
    setBusy(false)
    if (target === 'ideas') void reload()
    toast(t('ai.import.taken', { count: ok }), 'ok')
    onDone?.({ target, listId: target === 'wishes' ? listId : undefined })
    onClose()
  }

  const tabs = [...(textOk ? [{ value: 'text' as const, label: t('ai.import.tabText') }] : []), ...(imageOk ? [{ value: 'image' as const, label: t('ai.import.tabImage') }] : [])]
  const canRun = tab === 'text' ? !!text.trim() : !!img
  const count = drafts?.filter((d) => d.on).length ?? 0

  return (
    <Modal
      title={t('ai.import.title')}
      onClose={onClose}
      footer={
        drafts ? (
          <>
            <Button variant="ghost" icon={ArrowLeft} iconOnlyOnMobile aria-label={t('ai.import.back')} onClick={() => { setDrafts(null); setError('') }} disabled={busy}>{t('ai.import.back')}</Button>
            <span className="flex-1" />
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" icon={Check} onClick={take} disabled={busy || !count}>{busy ? t('ai.import.saving') : t('ai.import.takeCount', { count })}</Button>
          </>
        ) : (
          <>
            <span className="flex-1" />
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" icon={Sparkles} onClick={run} disabled={busy || !canRun}>{busy ? t('ai.import.reading') : t('ai.import.read')}</Button>
          </>
        )
      }
    >
      {!drafts ? (
        <>
          <Field label={t('ai.import.whatTarget')} group>
            <PillTabs label={t('ai.import.target')} value={target} onChange={setTarget} items={[{ value: 'wishes', label: t('ai.import.targetWishes') }, { value: 'ideas', label: t('ai.import.targetIdeas') }]} />
          </Field>
          {tabs.length > 1 && <PillTabs label={t('ai.import.source')} value={tab} onChange={setTab} items={tabs} />}
          <AiNotice feature={tab === 'text' ? 'text_import' : 'image_import'} />
          {tab === 'text' ? (
            <Field label={t('ai.import.text')} hint={t('ai.import.textHint')}>
              <textarea className="input min-h-48" rows={8} autoFocus={!isCoarse()} placeholder={t('ai.import.textPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          ) : (
            <div className="space-y-2">
              <FilePicker accept="image/jpeg,image/png,image/webp,image/gif" label={t('ai.import.pickImage')} ariaLabel={t('ai.import.pickImage')} onFile={(f) => void setImage(f)}>
                {img ? <img src={img.preview} alt={t('ai.import.imageAlt')} className="mx-auto max-h-48 rounded-xl" /> : (
                  <span className="flex flex-col items-center gap-2 text-muted">
                    <ImageUp size={30} />
                    <span className="text-sm">{t('ai.import.imageDrop')}</span>
                  </span>
                )}
              </FilePicker>
              <p className="meta">{t('ai.import.imageHint')}</p>
            </div>
          )}
        </>
      ) : (
        <>
          {target === 'wishes' ? (
            <Field label={t('ai.import.whichList')}>
              <WishlistSelect label={t('ai.import.list')} lists={lists} value={listId} onChange={setListId} onCreated={(l) => setLists((old) => [...old, l])} placeholder={t('ai.import.noList')} />
            </Field>
          ) : null}
          <p className="text-sm text-muted">{t('ai.import.review')}</p>
          <div className="space-y-3">
            {drafts.map((d) => (
              <div key={d.key} className={`rounded-2xl bg-hover p-3.5 space-y-2.5 ${d.on ? '' : 'opacity-60'}`}>
                <Checkbox checked={d.on} onChange={(v) => upd(d.key, { on: v })}><span className="font-semibold">{t('ai.import.take')}</span></Checkbox>
                <input className="input" aria-label={t('ai.import.fieldTitle')} value={d.title} onChange={(e) => upd(d.key, { title: e.target.value })} />
                <div className="grid grid-cols-2 gap-2">
                  <input className="input" aria-label={t('ai.import.fieldPrice')} inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder={t('ai.import.fieldPrice')} value={d.price} onChange={(e) => upd(d.key, { price: e.target.value })} />
                  <input className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label={t('ai.import.fieldLink')} placeholder={t('ai.import.fieldLink')} value={d.url} onChange={(e) => upd(d.key, { url: e.target.value })} />
                </div>
                <input className="input" aria-label={t('ai.import.fieldNotes')} placeholder={t('ai.import.fieldNotes')} value={d.notes} onChange={(e) => upd(d.key, { notes: e.target.value })} />
                {target === 'ideas' && (
                  <div className="flex flex-wrap items-center gap-3">
                    <PersonSelect className="flex-1 min-w-40" label={t('ai.import.forWhom')} placeholder={t('ai.import.pickPerson')} persons={others} value={d.personId} onChange={(id) => upd(d.key, { personId: id })} />
                    <Checkbox checked={d.mentioned} onChange={(v) => upd(d.key, { mentioned: v })}>{t('ai.import.mentioned')}</Checkbox>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <FormError>{error}</FormError>
    </Modal>
  )
}

/** Trigger button for the import – only visible if AI and an import feature are enabled */
export function AiImportButton({ init, onDone, label }: { init?: ImportInit; onDone?: (r: { target: 'wishes' | 'ideas'; listId?: number }) => void; label?: string }) {
  const ai = useAiStatus()
  const [open, setOpen] = useState(false)
  if (!ai.enabled || !(ai.features.text_import || ai.features.image_import)) return null
  return (
    <>
      <Button icon={Sparkles} title={`${t('ai.badgeHint')} ${[ai.features.text_import && t('ai.sent.text_import'), ai.features.image_import && t('ai.sent.image_import')].filter(Boolean).join(' ')}`} onClick={() => setOpen(true)}>{label ?? t('ai.import.title')}</Button>
      {open && <ImportDialog init={init} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  )
}

// ───────────────────────────── Suggest ideas ─────────────────────────────

function SuggestDialog({ personId, personName, onClose }: { personId: number; personName: string; onClose: () => void }) {
  const { s, call } = useStore()
  const toast = useToast()
  const occasions = s.occasions.filter((o) => o.date >= s.today && o.person_ids.includes(personId))
  const [occ, setOcc] = useState(0)
  const [budget, setBudget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [list, setList] = useState<AiSuggestion[] | null>(null)
  const [taken, setTaken] = useState<Set<number>>(new Set())
  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const b = parseNum(budget)
      const r = await api<{ suggestions: AiSuggestion[] }>('POST', '/api/ai/suggest', { person_id: personId, occasion_id: occ || undefined, budget: b ?? undefined })
      setList(r.suggestions)
      setTaken(new Set())
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const take = async (i: number, sg: AiSuggestion) => {
    if (await call('POST', '/api/items', { title: sg.title, person_id: personId, price: sg.price_estimate, notes: sg.reason })) {
      setTaken((prev) => new Set(prev).add(i))
      toast(t('ai.suggest.toast'), 'ok')
    }
  }
  return (
    <Modal
      title={t('ai.suggest.title', { name: personName })}
      onClose={onClose}
      footer={<><span className="flex-1" /><Button onClick={onClose}>{t('controls.ui.close')}</Button><Button variant="primary" icon={Sparkles} onClick={run} disabled={busy}>{busy ? t('ai.suggest.thinking') : list ? t('ai.suggest.again') : t('ai.suggest.get')}</Button></>}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label={t('ai.suggest.occasion')}>
          <Select value={occ} onChange={(e) => setOcc(Number(e.target.value))}>
            <option value={0}>{t('controls.picker.noOccasion')}</option>
            {occasions.map((o) => <option key={o.id} value={o.id}>{t('ai.suggest.occasionDays', { name: o.name, count: daysUntil(o.date, s.today) })}</option>)}
          </Select>
        </Field>
        <Field label={t('ai.suggest.budget')}><input className="input" inputMode="decimal" autoComplete="off" enterKeyHint="done" value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
      </div>
      <p className="meta flex items-start gap-2"><AiBadge feature="suggestions" /><span>{t('ai.suggest.privacy', { name: personName })}</span></p>
      <FormError>{error}</FormError>
      {list && (
        <div className="grid gap-3">
          {list.map((sg, i) => (
            <article key={i} className="card p-4 space-y-2 bg-hover shadow-none">
              <div className="flex items-start justify-between gap-3">
                <div className="font-semibold leading-snug">{sg.title}</div>
                {sg.price_estimate != null && <span className="display-num text-lg shrink-0">{t('ai.suggest.approx')} <Money n={sg.price_estimate} /></span>}
              </div>
              <p className="text-sm text-muted">{sg.reason}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" icon={taken.has(i) ? Check : Lightbulb} disabled={taken.has(i)} onClick={() => take(i, sg)}>{taken.has(i) ? t('ai.suggest.taken') : t('ai.suggest.take')}</Button>
                <Button size="sm" icon={Search} href={`https://www.google.com/search?q=${encodeURIComponent(sg.search_query)}`}>{t('controls.search')}</Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </Modal>
  )
}

/** "Suggest ideas" on the person page (only with the AI feature enabled; never for yourself) */
export function SuggestButton({ personId, personName }: { personId: number; personName: string }) {
  const ai = useAiStatus()
  const [open, setOpen] = useState(false)
  if (!ai.enabled || !ai.features.suggestions) return null
  return (
    <>
      <Button icon={Sparkles} title={`${t('ai.badgeHint')} ${t('ai.sent.suggestions')}`} onClick={() => setOpen(true)}>{t('ai.suggest.button')}</Button>
      {open && <SuggestDialog personId={personId} personName={personName} onClose={() => setOpen(false)} />}
    </>
  )
}

