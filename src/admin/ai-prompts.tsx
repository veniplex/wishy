import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, FlaskConical, ImageUp, RotateCcw, Save, Undo2 } from 'lucide-react'
import { api, errMsg } from '../api'
import { PersonSelect } from '../pickers'
import { useStore } from '../store'
import { fmtDateTime, fmtMoney, getLocale, t, useT, type Locale, type TKey } from '../i18n'
import { Badge, Banner, Button, Card, Chip, Field, FilePicker, FormError, Modal, Segmented, ToggleLink, useConfirm, useToast } from '../ui'

/**
 * Admin › AI › Prompts: one customizable instruction block per AI feature. The fixed frame (safety rules, output format,
 * language) is always added by the server and is only shown read-only here.
 */
interface Placeholder { name: string; description_key: string; example: string }
interface PromptFeature {
  key: string
  label_key: string
  description_key: string
  placeholders: Placeholder[]
  default: string
  default_version: number
  custom: string | null
  outdated: boolean
  updated_at: string | null
  updated_by_name: string | null
  frame_preview: { header: string; footer: string }
  max_length: number
}
type Sample = Record<string, unknown>

const PH_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
const norm = (s: string) => s.replace(/\r\n?/g, '\n').trim()
const unknownIn = (text: string, known: Placeholder[]) => {
  const ok = new Set(known.map((p) => p.name))
  return [...new Set([...text.matchAll(PH_RE)].map((m) => m[1]).filter((n) => !ok.has(n)))]
}
const tk = (k: string) => t(k as TKey)
const MONO = 'font-mono text-xs leading-relaxed whitespace-pre-wrap break-words'

/** Unsaved changes: intercept leaving the page and clicks on internal links (BrowserRouter has no blocker). */
function useUnsavedGuard(dirty: boolean) {
  const navigate = useNavigate()
  const confirm = useConfirm()
  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.target === '_blank' || a.origin !== location.origin || a.hasAttribute('download')) return
      if (a.pathname + a.search === location.pathname + location.search) return
      e.preventDefault()
      e.stopPropagation()
      void confirm({ title: t('aiPrompts.unsaved.title'), text: t('aiPrompts.unsaved.text'), confirmLabel: t('aiPrompts.unsaved.leave'), cancelLabel: t('aiPrompts.unsaved.stay'), destructive: true }).then((yes) => {
        if (yes) navigate(a.pathname + a.search + a.hash)
      })
    }
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [dirty, confirm, navigate])
}

export function AdminAiPrompts({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  useT()
  const [features, setFeatures] = useState<PromptFeature[] | null>(null)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const anyDirty = Object.values(dirty).some(Boolean)
  useUnsavedGuard(anyDirty)
  useEffect(() => { onDirtyChange?.(anyDirty) }, [anyDirty, onDirtyChange])
  useEffect(() => {
    api<{ features: PromptFeature[] }>('GET', '/api/admin/ai/prompts').then((r) => setFeatures(r.features)).catch((e) => setError(errMsg(e)))
  }, [])

  if (!features) return <FormError>{error || t('aiPrompts.loading')}</FormError>
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="h3">{t('aiPrompts.title')}</h3>
        <p className="text-muted mt-1.5">{t('aiPrompts.sub')}</p>
      </div>
      <Banner>{t('aiPrompts.intro')}</Banner>
      {anyDirty && <Banner tone="warn">{t('aiPrompts.unsaved.banner')}</Banner>}
      {features.map((f) => (
        <PromptCard key={f.key} f={f} onSaved={(n) => setFeatures((all) => all && all.map((x) => (x.key === n.key ? n : x)))} onDirty={(d) => setDirty((m) => (m[f.key] === d ? m : { ...m, [f.key]: d }))} />
      ))}
    </div>
  )
}

function PromptCard({ f, onSaved, onDirty }: { f: PromptFeature; onSaved: (n: PromptFeature) => void; onDirty: (d: boolean) => void }) {
  useT()
  const toast = useToast()
  const confirm = useConfirm()
  const saved = f.custom ?? f.default
  const [text, setText] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showFrame, setShowFrame] = useState(false)
  const [showDefault, setShowDefault] = useState(false)
  const [dialog, setDialog] = useState<'preview' | 'test' | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setText(f.custom ?? f.default) }, [f.custom, f.default])

  const dirty = norm(text) !== norm(saved)
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])
  const name = tk(f.label_key)
  const unknown = useMemo(() => unknownIn(text, f.placeholders), [text, f.placeholders])
  const tooLong = text.length > f.max_length
  const empty = !text.trim()
  const status = dirty ? 'unsaved' : f.custom == null ? 'default' : f.outdated ? 'outdated' : 'custom'

  const insert = (tok: string) => {
    const el = ta.current
    const a = el?.selectionStart ?? text.length
    const b = el?.selectionEnd ?? text.length
    setText(text.slice(0, a) + tok + text.slice(b))
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + tok.length, a + tok.length) })
  }
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      onSaved(await api<PromptFeature>('PUT', `/api/admin/ai/prompts/${f.key}`, { instructions: text }))
      toast(t('aiPrompts.saved'), 'ok')
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }
  const reset = async () => {
    if (!(await confirm({ title: t('aiPrompts.reset.title'), text: t('aiPrompts.reset.text', { name }), confirmLabel: t('aiPrompts.reset.confirm'), destructive: true }))) return
    setBusy(true)
    setError('')
    try {
      onSaved(await api<PromptFeature>('DELETE', `/api/admin/ai/prompts/${f.key}`))
      toast(t('aiPrompts.resetDone'), 'ok')
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }
  const meta = f.custom != null && f.updated_at
    ? f.updated_by_name ? t('aiPrompts.editor.meta', { when: fmtDateTime(f.updated_at), who: f.updated_by_name }) : t('aiPrompts.editor.metaNoWho', { when: fmtDateTime(f.updated_at) })
    : null

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <h4 className="font-semibold text-ink">{name}</h4>
          <p className="meta mt-0.5">{tk(f.description_key)}</p>
        </div>
        <Badge tone={status === 'custom' ? 'accent' : status === 'outdated' ? 'warn' : status === 'unsaved' ? 'info' : 'neutral'}>{t(`aiPrompts.status.${status}` as const)}</Badge>
      </div>

      {f.outdated && !dirty && (
        <Banner tone="warn" action={<Button size="sm" onClick={() => setShowDefault(true)}>{t('aiPrompts.default.show')}</Button>}>{t('aiPrompts.outdated.text')}</Banner>
      )}

      <div>
        <span className="label">{t('aiPrompts.ph.label')}</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('aiPrompts.ph.title')}>
          {f.placeholders.map((p) => (
            <Chip key={p.name} title={t('aiPrompts.ph.tooltip', { description: tk(p.description_key), example: p.example })} onClick={() => insert(`{{${p.name}}}`)}><span className="font-mono">{`{{${p.name}}}`}</span></Chip>
          ))}
        </div>
        <p className="meta mt-1.5">{t('aiPrompts.ph.hint')}</p>
      </div>

      <Field label={t('aiPrompts.editor.label', { name })}>
        <textarea
          ref={ta}
          className={`input ${MONO} ${tooLong ? 'input-invalid' : ''}`}
          rows={Math.min(22, Math.max(8, text.split('\n').length + 1))}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 meta">
        <span className={tooLong ? 'text-bad font-semibold' : undefined}>{t('aiPrompts.editor.chars', { count: text.length, max: f.max_length })}</span>
        {meta && <span>{meta}</span>}
      </div>

      {unknown.length > 0 && <Banner tone="warn">{t(unknown.length === 1 ? 'aiPrompts.warn.unknownOne' : 'aiPrompts.warn.unknown', { names: unknown.map((n) => `{{${n}}}`).join(', ') })}</Banner>}

      <div className="space-y-2">
        <ToggleLink chevron on={showFrame} onToggle={() => setShowFrame(!showFrame)} labelOn={t('aiPrompts.frame.hide')} labelOff={t('aiPrompts.frame.show')} />
        {showFrame && (
          <div className="space-y-3">
            <p className="meta">{t('aiPrompts.frame.hint')}</p>
            <div>
              <span className="label">{t('aiPrompts.frame.header')}</span>
              <pre className={`rounded-2xl bg-hover px-3 py-2.5 text-muted ${MONO}`}>{f.frame_preview.header}</pre>
            </div>
            <div>
              <span className="label">{t('aiPrompts.frame.footer')}</span>
              <pre className={`rounded-2xl bg-hover px-3 py-2.5 text-muted ${MONO}`}>{f.frame_preview.footer}</pre>
            </div>
          </div>
        )}
        <div>
          <ToggleLink chevron on={showDefault} onToggle={() => setShowDefault(!showDefault)} labelOn={t('aiPrompts.default.hide')} labelOff={t('aiPrompts.default.show')} />
        </div>
        {showDefault && (
          <div className="space-y-2">
            <pre className={`rounded-2xl bg-hover px-3 py-2.5 text-muted ${MONO}`}>{f.default}</pre>
            <Button size="sm" icon={Undo2} onClick={() => setText(f.default)}>{t('aiPrompts.default.use')}</Button>
          </div>
        )}
      </div>

      <FormError>{error}</FormError>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={Save} disabled={busy || !dirty || tooLong || empty} onClick={() => void save()}>{busy ? t('aiPrompts.action.saving') : t('aiPrompts.action.save')}</Button>
        {dirty && <Button variant="ghost" onClick={() => setText(saved)}>{t('aiPrompts.action.discard')}</Button>}
        <Button icon={Eye} disabled={tooLong || empty} onClick={() => setDialog('preview')}>{t('aiPrompts.action.preview')}</Button>
        <Button icon={FlaskConical} disabled={tooLong || empty} onClick={() => setDialog('test')}>{t('aiPrompts.action.test')}</Button>
        {f.custom != null && <Button variant="danger" icon={RotateCcw} disabled={busy} onClick={() => void reset()}>{t('aiPrompts.action.reset')}</Button>}
      </div>

      {dialog === 'preview' && <PreviewDialog f={f} name={name} text={text} onClose={() => setDialog(null)} />}
      {dialog === 'test' && <TestDialog f={f} name={name} text={text} onClose={() => setDialog(null)} />}
    </Card>
  )
}

function PreviewDialog({ f, name, text, onClose }: { f: PromptFeature; name: string; text: string; onClose: () => void }) {
  useT()
  const [locale, setLocale] = useState<Locale>(getLocale())
  const [system, setSystem] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setSystem(null)
    setError('')
    api<{ system: string }>('POST', `/api/admin/ai/prompts/${f.key}/preview`, { instructions: text, sample: { locale } })
      .then((r) => live && setSystem(r.system))
      .catch((e) => live && setError(errMsg(e)))
    return () => { live = false }
  }, [f.key, text, locale])
  return (
    <Modal title={t('aiPrompts.preview.title', { name })} onClose={onClose} footer={<Button onClick={onClose}>{t('aiPrompts.action.close')}</Button>}>
      <div className="space-y-4">
        <p className="meta">{t('aiPrompts.preview.hint')}</p>
        <Field label={t('aiPrompts.preview.lang')} group>
          <Segmented label={t('aiPrompts.preview.lang')} value={locale} onChange={setLocale} options={[{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'English' }]} />
        </Field>
        <FormError>{error}</FormError>
        {!system && !error && <p className="meta">{t('aiPrompts.preview.loading')}</p>}
        {system && (
          <>
            <pre className={`rounded-2xl bg-hover px-3 py-2.5 text-ink max-h-[55vh] overflow-auto ${MONO}`} tabIndex={0}>{system}</pre>
            <p className="meta">{t('aiPrompts.preview.chars', { count: system.length })}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

interface TestResponse { result: Record<string, unknown>; usage: { input: number; output: number }; latency_ms: number; model: string | null }

function TestDialog({ f, name, text, onClose }: { f: PromptFeature; name: string; text: string; onClose: () => void }) {
  useT()
  const { activePersons } = useStore()
  const persons = activePersons.filter((p) => !p.is_me)
  const [sampleText, setSampleText] = useState('')
  const [target, setTarget] = useState<'wishes' | 'ideas'>('wishes')
  const [url, setUrl] = useState('')
  const [image, setImage] = useState<{ name: string; data: string; type: string } | null>(null)
  const [personId, setPersonId] = useState(0)
  const [budget, setBudget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [res, setRes] = useState<TestResponse | null>(null)

  const sample = (): Sample | null => {
    if (f.key === 'text_import') return sampleText.trim() ? { text: sampleText, target } : null
    if (f.key === 'link_import') return url.trim() ? { url: url.trim() } : null
    if (f.key === 'image_import') return image ? { image_base64: image.data, media_type: image.type } : null
    return personId ? { person_id: personId, ...(budget.trim() ? { budget: Number(budget.replace(',', '.')) } : {}) } : null
  }
  const pickImage = (file: File) => {
    setError('')
    if (file.size > 2 * 1024 * 1024) { setError(t('aiPrompts.test.imageTooBig')); return }
    const rd = new FileReader()
    rd.onload = () => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(String(rd.result))
      if (m) setImage({ name: file.name, type: m[1], data: m[2] })
      else setError(t('aiPrompts.test.imageUnreadable'))
    }
    rd.onerror = () => setError(t('aiPrompts.test.imageUnreadable'))
    rd.readAsDataURL(file)
  }
  const run = async () => {
    const s = sample()
    if (!s) { setError(t('aiPrompts.test.needInput')); return }
    setBusy(true)
    setError('')
    setRes(null)
    try {
      setRes(await api<TestResponse>('POST', `/api/admin/ai/prompts/${f.key}/test`, { instructions: text, sample: s }))
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <Modal title={t('aiPrompts.test.title', { name })} onClose={onClose} footer={<><Button onClick={onClose}>{t('aiPrompts.action.close')}</Button><Button variant="primary" icon={FlaskConical} disabled={busy} onClick={() => void run()}>{busy ? t('aiPrompts.test.running') : t('aiPrompts.test.run')}</Button></>}>
      <div className="space-y-4">
        <p className="meta">{t('aiPrompts.test.hint')}</p>
        {f.key === 'text_import' && (
          <>
            <Field label={t('aiPrompts.test.text')}>
              <textarea className="input" rows={5} maxLength={20000} placeholder={t('aiPrompts.test.textPlaceholder')} value={sampleText} onChange={(e) => setSampleText(e.target.value)} />
            </Field>
            <Field label={t('aiPrompts.test.target')} group>
              <Segmented label={t('aiPrompts.test.target')} value={target} onChange={setTarget} options={[{ value: 'wishes', label: t('aiPrompts.test.target.wishes') }, { value: 'ideas', label: t('aiPrompts.test.target.ideas') }]} />
            </Field>
          </>
        )}
        {f.key === 'link_import' && (
          <Field label={t('aiPrompts.test.url')}>
            <input className="input" type="url" inputMode="url" autoComplete="off" placeholder={t('aiPrompts.test.urlPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        )}
        {f.key === 'image_import' && (
          <Field label={t('aiPrompts.test.image')} group>
            <div className="flex flex-wrap items-center gap-3">
              <FilePicker variant="button" icon={ImageUp} accept="image/jpeg,image/png,image/webp,image/gif" label={image ? t('aiPrompts.test.imageChange') : t('aiPrompts.test.imagePick')} onFile={pickImage} />
              {image && <span className="meta break-all">{image.name}</span>}
            </div>
          </Field>
        )}
        {f.key === 'suggestions' && (
          <>
            {persons.length === 0 ? <p className="meta">{t('aiPrompts.test.personNone')}</p> : (
              <PersonSelect create={false} label={t('aiPrompts.test.person')} placeholder={t('aiPrompts.test.personPick')} persons={persons} value={personId} onChange={setPersonId} />
            )}
            <Field label={t('aiPrompts.test.budget')}>
              <input className="input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </Field>
          </>
        )}
        <FormError>{error}</FormError>
        {res && <ResultView feature={f.key} res={res} />}
      </div>
    </Modal>
  )
}

const num = (v: unknown) => (typeof v === 'number' ? v : null)
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

function Entry({ rows }: { rows: [string, string | null][] }) {
  const shown = rows.filter(([, v]) => v != null && v !== '')
  const [first, ...rest] = shown
  return (
    <li className="rounded-2xl border border-line p-3 space-y-1">
      {first && <div className="font-semibold text-ink break-words">{first[1]}</div>}
      {rest.map(([k, v]) => (
        <div key={k} className="text-sm grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2">
          <span className="text-muted">{k}</span>
          <span className="break-words">{v}</span>
        </div>
      ))}
    </li>
  )
}

function ResultView({ feature, res }: { feature: string; res: TestResponse }) {
  const r = res.result
  const price = (p: unknown, c: unknown) => (num(p) != null ? fmtMoney(num(p) as number, str(c) ?? 'EUR') : null)
  let body
  if (Array.isArray(r.items)) {
    const items = r.items as Record<string, unknown>[]
    body = items.length === 0 ? <p className="meta">{t('aiPrompts.test.empty')}</p> : (
      <ul className="space-y-2">
        {items.map((it, i) => (
          <Entry key={i} rows={[
            [t('aiPrompts.res.title'), str(it.title)], [t('aiPrompts.res.notes'), str(it.notes)], [t('aiPrompts.res.price'), price(it.price, it.currency)], [t('aiPrompts.res.url'), str(it.url)],
            ...(feature === 'text_import' ? ([[t('aiPrompts.res.person'), str(it.person_name)], [t('aiPrompts.res.mentioned'), it.mentioned === true ? t('aiPrompts.res.yes') : null]] as [string, string | null][]) : []),
          ]} />
        ))}
      </ul>
    )
  } else if (Array.isArray(r.suggestions)) {
    body = (
      <ul className="space-y-2">
        {(r.suggestions as Record<string, unknown>[]).map((s, i) => (
          <Entry key={i} rows={[[t('aiPrompts.res.title'), str(s.title)], [t('aiPrompts.res.reason'), str(s.reason)], [t('aiPrompts.res.estimate'), price(s.price_estimate, 'EUR')], [t('aiPrompts.res.query'), str(s.search_query)]]} />
        ))}
      </ul>
    )
  } else {
    body = (
      <ul>
        <Entry rows={[
          [t('aiPrompts.res.title'), str(r.title)], [t('aiPrompts.res.description'), str(r.description)], [t('aiPrompts.res.price'), price(r.price, r.currency)], [t('aiPrompts.res.shop'), str(r.shop)],
          [t('aiPrompts.res.brand'), str(r.brand)], [t('aiPrompts.res.variant'), str(r.variant)], [t('aiPrompts.res.url'), str(r.url)], [t('aiPrompts.res.image'), str(r.image_url)],
        ]} />
      </ul>
    )
  }
  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label !mb-0">{t('aiPrompts.test.result')}</span>
        <Badge tone="ok">{t('aiPrompts.test.usage', { input: res.usage.input, output: res.usage.output, ms: res.latency_ms, model: res.model ?? '–' })}</Badge>
      </div>
      {body}
    </div>
  )
}
