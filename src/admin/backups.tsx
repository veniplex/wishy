import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Archive, Check, CircleAlert, Download, Lock, ShieldCheck, TriangleAlert, Trash2, Upload, RotateCcw, DatabaseBackup } from 'lucide-react'
import { ApiError, api, errMsg } from '../api'
import { useAuth } from '../auth'
import { fmtDateTime, fmtNumber, t, useT, type TKey } from '../i18n'
import { reportMaintenance } from '../maintenance-state'
import { Badge, Banner, Button, Card, Field, FilePicker, FormError, List, Modal, Row, Section, Segmented, Select, Stat, Switch, TwoCol, useConfirm, useToast, type BadgeTone } from '../ui'
import { ProgressBar } from '../update-parts'
import { RowActions, SectionHead } from './shared'
import { isCoarse } from '../controls'
import { fmtSize } from './system'

// ───────────── Types ─────────────
interface BackupItem {
  name: string
  size: number
  created_at: string
  reason: string
  label: string | null
  version: string | null
  schema_version: number | null
  encrypted: boolean
  verified: boolean | null
  uploaded?: boolean
}
interface BackupSettings {
  schedule: 'off' | 'daily' | 'weekly'
  hour: number
  weekday: number
  keep_last: number
  keep_days: number
  keep_pre_update: number
  encrypt: boolean
  passphrase_set: boolean
  passphrase_env?: boolean
  max_upload_mb: number
  next_run_at: string | null
  last_run: { at: string; ok: boolean; name?: string; error?: string } | null
  timezone?: string
}
interface BackupStatus {
  backups: BackupItem[]
  settings: BackupSettings
  busy: string | null
  supervised: boolean
  restore_pending: { source: string; created_at?: string; restart?: 'automatic' | 'manual' } | null
  last_restore: { ok: boolean; source?: string; error?: string } | null
}

/** Error text for a server code in the current language, otherwise the server's own text */
function bErr(e: unknown) {
  if (e instanceof ApiError && e.code) {
    const key = `backup.err.${e.code}` as TKey
    const msg = t(key)
    if (msg !== key) return msg
  }
  return errMsg(e)
}
const needsPassphrase = (e: unknown) => e instanceof ApiError && (e.code === 'passphrase_required' || e.code === 'passphrase_wrong')

const REASON_TONE: Record<string, BadgeTone> = { manual: 'neutral', scheduled: 'info', 'pre-update': 'accent', 'pre-restore': 'warn', uploaded: 'neutral' }
const reasonLabel = (r: string) => {
  const key = `backup.reason.${r}` as TKey
  const text = t(key)
  return text !== key ? text : t('backup.reason.unknown')
}

// ───────────── Passphrase dialog (verify) ─────────────
function PassphraseDialog({ title, text, action, onSubmit, onClose }: { title: string; text: string; action: string; onSubmit: (pass: string) => Promise<void>; onClose: () => void }) {
  const [pass, setPass] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSubmit(pass)
    } catch (err) {
      setError(bErr(err))
      setBusy(false)
    }
  }
  return (
    <form onSubmit={run}>
      <Modal compact title={title} onClose={onClose} footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" disabled={busy || !pass}>{action}</Button></>}>
        <p className="text-sm text-muted">{text}</p>
        <Field label={t('backup.restore.passphrase')} error={error}>
          <input className="input" type="password" autoComplete="off" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
      </Modal>
    </form>
  )
}

// ───────────── Restore ─────────────
function RestoreDialog({ backup, supervised, onClose, onDone }: { backup: BackupItem; supervised: boolean; onClose: () => void; onDone: (restart: 'automatic' | 'manual') => void }) {
  const { appName } = useAuth()
  const word = appName || 'Wishy'
  const [typed, setTyped] = useState('')
  const [pass, setPass] = useState('')
  const [askPass, setAskPass] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await api<{ restart: 'automatic' | 'manual' }>('POST', `/api/admin/backups/${encodeURIComponent(backup.name)}/restore`, pass ? { passphrase: pass } : {})
      onDone(r.restart)
    } catch (err) {
      if (needsPassphrase(err)) setAskPass(true)
      setError(bErr(err))
      setBusy(false)
    }
  }
  const steps: string[] = [t('backup.restore.step1'), t('backup.restore.step2'), t('backup.restore.step3'), supervised ? t('backup.restore.step4') : t('backup.restore.step4manual')]
  return (
    <form onSubmit={run}>
      <Modal
        title={t('backup.restore.title')}
        onClose={busy ? () => {} : onClose}
        footer={<><span className="flex-1" /><Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button variant="destructive" type="submit" disabled={busy || typed.trim().toLowerCase() !== word.toLowerCase() || (askPass && !pass)}>{busy ? t('backup.restore.working') : t('backup.restore.action')}</Button></>}
      >
        <p className="text-sm">{t('backup.restore.intro', { name: backup.name, date: fmtDateTime(backup.created_at) })}</p>
        <Banner tone="bad" icon={TriangleAlert}>{t('backup.restore.warn')}</Banner>
        <div className="space-y-1.5">
          <h3 className="h3">{t('backup.restore.what')}</h3>
          <ol className="list-decimal pl-5 space-y-1 text-sm text-muted">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </div>
        {askPass && (
          <Field label={t('backup.restore.passphrase')} hint={askPass ? t('backup.restore.passphraseNeeded') : undefined}>
            <input className="input" type="password" autoComplete="off" enterKeyHint="done" value={pass} onChange={(e) => setPass(e.target.value)} />
          </Field>
        )}
        <Field label={t('backup.restore.confirm', { word })}>
          <input className="input" autoComplete="off" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        <FormError>{error}</FormError>
      </Modal>
    </form>
  )
}

// ───────────── Upload ─────────────
function uploadBackup(file: File, passphrase: string, onProgress: (v: number) => void) {
  return new Promise<{ backup: BackupItem; verified: boolean | null; passphrase_needed: boolean }>((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', '/api/admin/backups/upload')
    try {
      x.setRequestHeader('X-Requested-With', 'wishlist')
      x.setRequestHeader('Content-Type', 'application/octet-stream')
      x.setRequestHeader('X-Filename', file.name.replace(/[^A-Za-z0-9._-]/g, '_'))
      if (passphrase) x.setRequestHeader('X-Backup-Passphrase', passphrase)
    } catch {
      return reject(new ApiError(t('backup.upload.failed'), 0))
    }
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    x.onload = () => {
      let d: { error?: string; code?: string; maintenance?: never } & Record<string, never> = {} as never
      try { d = JSON.parse(x.responseText) } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300) return resolve(d as never)
      if (x.status === 503 && d.code === 'maintenance') reportMaintenance(d.maintenance)
      reject(new ApiError(d.error || t('backup.upload.failed'), x.status, d.code))
    }
    x.onerror = () => reject(new ApiError(t('errors.network'), 0))
    x.send(file)
  })
}

function UploadCard({ maxMb, onUploaded }: { maxMb: number; onUploaded: () => void }) {
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [pass, setPass] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const pick = (f: File) => {
    setError(f.size > maxMb * 1024 * 1024 ? t('backup.upload.tooBig', { max: fmtNumber(maxMb) }) : '')
    setFile(f)
  }
  const run = async () => {
    if (!file) return
    setError('')
    setProgress(0)
    try {
      const r = await uploadBackup(file, pass, setProgress)
      toast(r.passphrase_needed ? t('backup.upload.doneUnverified') : t('backup.upload.done'), r.passphrase_needed ? 'info' : 'ok')
      setFile(null)
      setPass('')
      onUploaded()
    } catch (e) {
      setError(bErr(e))
    } finally {
      setProgress(null)
    }
  }
  const encrypted = !!file && /\.enc$/i.test(file.name)
  return (
    <Card className="space-y-4">
      <h3 className="h3">{t('backup.upload.title')}</h3>
      {!file ? (
        <FilePicker accept=".wbk,.enc,.wbk.enc" icon={Upload} label={isCoarse() ? t('backup.upload.choose') : t('backup.upload.drop')} hint={t('backup.upload.hint', { max: fmtNumber(maxMb) })} onFile={pick} />
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-xl bg-hover px-3.5 py-2.5 text-sm">
            <Archive size={18} className="text-muted shrink-0" />
            <div className="min-w-0 flex-1"><div className="font-medium truncate">{file.name}</div><div className="meta">{fmtSize(file.size)}</div></div>
            <Button size="sm" variant="ghost" disabled={progress !== null} onClick={() => { setFile(null); setError('') }}>{t('common.cancel')}</Button>
          </div>
          {encrypted && (
            <Field label={t('backup.upload.passphrase')} hint={t('backup.upload.passphraseHint')}>
              <input className="input" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
            </Field>
          )}
          {progress !== null && (
            <div className="space-y-1.5">
              <ProgressBar value={progress} label={t('backup.upload.title')} />
              <p className="meta num">{t('backup.upload.running', { percent: Math.round(progress * 100) })}</p>
            </div>
          )}
          <Button variant="primary" icon={Upload} disabled={progress !== null || !!error && file.size > maxMb * 1024 * 1024} onClick={run}>{t('backup.upload.start')}</Button>
        </>
      )}
      <FormError>{error}</FormError>
    </Card>
  )
}

// ───────────── Settings ─────────────
const num = (v: string) => (v.trim() === '' ? NaN : Number(v))

function SettingsCard({ s, onSaved }: { s: BackupSettings; onSaved: (s: BackupSettings) => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [schedule, setSchedule] = useState(s.schedule)
  const [hour, setHour] = useState(String(s.hour))
  const [weekday, setWeekday] = useState(String(s.weekday))
  const [keepLast, setKeepLast] = useState(String(s.keep_last))
  const [keepDays, setKeepDays] = useState(String(s.keep_days))
  const [keepPre, setKeepPre] = useState(String(s.keep_pre_update))
  const [maxMb, setMaxMb] = useState(String(s.max_upload_mb))
  const [encrypt, setEncrypt] = useState(s.encrypt)
  const [editPass, setEditPass] = useState(false)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const typing = !s.passphrase_env && (!s.passphrase_set || editPass)

  const put = async (body: object) => {
    setBusy(true)
    setError('')
    try {
      const r = await api<BackupSettings>('PUT', '/api/admin/backups/settings', body)
      onSaved(r)
      toast(t('backup.settings.saved'), 'ok')
      return r
    } catch (e) {
      setError(bErr(e))
      return null
    } finally {
      setBusy(false)
    }
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    const hasNew = typing && pass.length > 0
    if (hasNew && pass.length < 10) return setError(t('backup.settings.passphraseShort'))
    if (hasNew && pass !== pass2) return setError(t('backup.settings.passphraseMismatch'))
    if (encrypt && !s.passphrase_set && !hasNew) return setError(t('backup.settings.passphraseNeeded'))
    const body = {
      schedule,
      hour: num(hour),
      weekday: num(weekday),
      keep_last: num(keepLast),
      keep_days: num(keepDays),
      keep_pre_update: num(keepPre),
      max_upload_mb: num(maxMb),
      encrypt,
      ...(hasNew ? { passphrase: pass } : {}),
    }
    const r = await put(body)
    if (r) { setPass(''); setPass2(''); setEditPass(false); setEncrypt(r.encrypt) }
  }
  const clearPass = async () => {
    if (!(await confirm({ title: t('backup.settings.passphraseClearConfirm'), text: t('backup.settings.passphraseClearText'), confirmLabel: t('backup.settings.passphraseClear'), destructive: true }))) return
    const r = await put({ passphrase: null, encrypt: false })
    if (r) { setEncrypt(false); setEditPass(false) }
  }
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: t(`backup.settings.wd.${d}` as TKey) }))
  const numInput = (value: string, set: (v: string) => void, min = 0) => <input className="input" type="number" inputMode="numeric" enterKeyHint="done" min={min} step={1} value={value} onChange={(e) => set(e.target.value)} />

  return (
    <form onSubmit={save}>
      <Card className="space-y-6">
        <Field label={t('backup.settings.schedule')} group>
          <Segmented
            label={t('backup.settings.schedule')}
            value={schedule}
            onChange={setSchedule}
            options={[{ value: 'off', label: t('backup.settings.schedule.off') }, { value: 'daily', label: t('backup.settings.schedule.daily') }, { value: 'weekly', label: t('backup.settings.schedule.weekly') }]}
          />
        </Field>
        {schedule !== 'off' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {schedule === 'weekly' && (
              <Field label={t('backup.settings.weekday')} group>
                <Select value={weekday} onChange={(e) => setWeekday(e.target.value)} options={weekdays} aria-label={t('backup.settings.weekday')} />
              </Field>
            )}
            <Field label={t('backup.settings.hour')} hint={s.timezone ? t('backup.settings.hourHint', { tz: s.timezone }) : undefined} group>
              <Select value={hour} onChange={(e) => setHour(e.target.value)} options={hours} aria-label={t('backup.settings.hour')} />
            </Field>
          </div>
        )}

        <div className="space-y-3 border-t border-line pt-5">
          <h3 className="h3">{t('backup.settings.retention')}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t('backup.settings.keepLast')} hint={t('backup.settings.keepLastHint')}>{numInput(keepLast, setKeepLast)}</Field>
            <Field label={t('backup.settings.keepDays')} hint={t('backup.settings.keepDaysHint')}>{numInput(keepDays, setKeepDays)}</Field>
            <Field label={t('backup.settings.keepPre')} hint={t('backup.settings.keepPreHint')}>{numInput(keepPre, setKeepPre, 1)}</Field>
          </div>
          <p className="meta">{t('backup.settings.keepNote')}</p>
        </div>

        <div className="space-y-4 border-t border-line pt-5">
          <Switch checked={encrypt} onChange={setEncrypt}>
            <span className="font-medium">{t('backup.settings.encrypt')}</span>
            <span className="block meta mt-0.5">{t('backup.settings.encryptHint')}</span>
          </Switch>
          <div className="space-y-3">
            <div className="label !mb-0">{t('backup.settings.passphrase')}</div>
            {s.passphrase_env ? (
              <p className="text-sm text-muted">{t('backup.settings.passphraseEnv')}</p>
            ) : typing ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('backup.settings.passphraseNew')}><input className="input" type="password" autoComplete="new-password" enterKeyHint="next" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
                <Field label={t('backup.settings.passphraseRepeat')}><input className="input" type="password" autoComplete="new-password" enterKeyHint="done" value={pass2} onChange={(e) => setPass2(e.target.value)} /></Field>
                {s.passphrase_set && <div><Button size="sm" variant="ghost" onClick={() => { setEditPass(false); setPass(''); setPass2('') }}>{t('common.cancel')}</Button></div>}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="ok" icon={Check}>{t('backup.settings.passphraseSet')}</Badge>
                <Button size="sm" onClick={() => setEditPass(true)}>{t('backup.settings.passphraseChange')}</Button>
                <Button size="sm" variant="danger" onClick={clearPass} disabled={busy}>{t('backup.settings.passphraseClear')}</Button>
              </div>
            )}
            {!s.passphrase_env && !s.passphrase_set && !typing && <p className="text-sm text-muted">{t('backup.settings.passphraseNone')}</p>}
          </div>
          <Banner tone="warn" icon={TriangleAlert}><strong className="font-semibold">{t('backup.settings.warnTitle')}:</strong> {t('backup.settings.warn')}</Banner>
        </div>

        <div className="border-t border-line pt-5 max-w-xs">
          <Field label={t('backup.settings.maxUpload')}>{numInput(maxMb, setMaxMb, 1)}</Field>
        </div>

        <FormError>{error}</FormError>
        <div><Button variant="primary" type="submit" disabled={busy}>{t('backup.settings.save')}</Button></div>
      </Card>
    </form>
  )
}

// ───────────── Page ─────────────
/** Admin › Backups: status, create/upload, list with verify/restore/delete, schedule + retention + encryption */
export function AdminBackups() {
  useT()
  const toast = useToast()
  const confirm = useConfirm()
  const [data, setData] = useState<BackupStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [restore, setRestore] = useState<BackupItem | null>(null)
  const [verifyPass, setVerifyPass] = useState<BackupItem | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    try {
      const d = await api<BackupStatus>('GET', '/api/admin/backups')
      if (alive.current) { setData(d); setLoadError('') }
    } catch (e) {
      if (alive.current) setLoadError(bErr(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])
  const busyRemote = !!data?.busy
  useEffect(() => {
    if (!busyRemote) return
    const id = setInterval(() => { void load() }, 3000)
    return () => clearInterval(id)
  }, [busyRemote, load])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setCreating(true)
    try {
      await api('POST', '/api/admin/backups', { label: label.trim() })
      toast(t('backup.create.done'), 'ok')
      setLabel('')
      await load()
    } catch (err) {
      toast(bErr(err), 'bad')
    } finally {
      setCreating(false)
    }
  }
  const verify = async (b: BackupItem, passphrase?: string) => {
    setWorking(b.name)
    try {
      await api('POST', `/api/admin/backups/${encodeURIComponent(b.name)}/verify`, passphrase ? { passphrase } : {})
      toast(t('backup.verify.ok'), 'ok')
      await load()
    } catch (err) {
      if (needsPassphrase(err) && !passphrase) setVerifyPass(b)
      else if (passphrase) throw err
      else toast(bErr(err), 'bad')
      await load()
    } finally {
      setWorking(null)
    }
  }
  const remove = async (b: BackupItem) => {
    if (!(await confirm({ title: t('backup.delete.title'), text: t('backup.delete.text', { name: b.name }), confirmLabel: t('backup.action.delete'), destructive: true }))) return
    try {
      await api('DELETE', `/api/admin/backups/${encodeURIComponent(b.name)}`)
      toast(t('backup.delete.done'), 'ok')
      await load()
    } catch (err) {
      toast(bErr(err), 'bad')
    }
  }
  const cancelPending = async () => {
    try {
      await api('DELETE', '/api/admin/backups/restore-pending')
      toast(t('backup.pending.cancelled'), 'ok')
      await load()
    } catch (err) {
      toast(bErr(err), 'bad')
    }
  }
  const onRestored = (restart: 'automatic' | 'manual') => {
    setRestore(null)
    if (restart === 'automatic') reportMaintenance({ state: 'restoring' })
    else toast(t('backup.restore.manualDone'), 'info')
    void load()
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-8">
        <SectionHead title={t('backup.title')} sub={t('backup.sub')} />
        {loadError ? <Banner tone="bad" icon={CircleAlert}>{loadError}</Banner> : <div className="card p-5 text-muted text-sm">{t('common.loading')}</div>}
      </div>
    )
  }
  const { backups, settings, restore_pending: pending, last_restore: lastRestore } = data
  const total = backups.reduce((n, b) => n + b.size, 0)
  const lastRun = settings.last_run

  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('backup.title')} sub={t('backup.sub')} />

      {pending && (
        <Banner tone="warn" icon={TriangleAlert} action={<Button size="sm" onClick={cancelPending}>{t('backup.pending.cancel')}</Button>}>
          <strong className="font-semibold">{t('backup.pending.title')}.</strong> {t('backup.pending.text', { source: pending.source })}
        </Banner>
      )}
      {!pending && lastRestore && (lastRestore.ok
        ? <Banner tone="ok" icon={Check}>{t('backup.lastRestore.ok', { source: lastRestore.source ?? '' })}</Banner>
        : <Banner tone="bad" icon={CircleAlert}>{t('backup.lastRestore.failed', { error: lastRestore.error ?? '' })}</Banner>)}

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
        <Stat label={t('backup.status.next')} value={settings.schedule === 'off' || !settings.next_run_at ? t('backup.status.nextOff') : <span className="text-2xl">{fmtDateTime(settings.next_run_at)}</span>} />
        <Stat
          label={t('backup.status.last')}
          value={lastRun ? <span className="text-2xl">{fmtDateTime(lastRun.at)}</span> : t('backup.status.lastNone')}
          sub={lastRun ? (lastRun.ok ? undefined : <Badge tone="bad" icon={CircleAlert}>{t('backup.status.lastFailed')}</Badge>) : undefined}
        />
        <Stat label={t('backup.status.storage')} value={fmtSize(total)} sub={t('backup.status.storageSub', { count: backups.length })} />
      </div>

      <div className="max-md:order-2"><TwoCol>
        <form onSubmit={create}>
          <Card className="space-y-4">
            <h3 className="h3">{t('backup.create.title')}</h3>
            <Field label={t('backup.create.label')}>
              <input className="input" maxLength={40} autoComplete="off" enterKeyHint="done" autoCapitalize="sentences" placeholder={t('backup.create.labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <p className="meta">{settings.encrypt ? t('backup.create.encrypted') : t('backup.create.plain')}</p>
            <Button variant="primary" type="submit" icon={DatabaseBackup} disabled={creating || busyRemote}>{creating ? t('backup.create.running') : t('backup.create.action')}</Button>
          </Card>
        </form>
        <UploadCard maxMb={settings.max_upload_mb} onUploaded={() => void load()} />
      </TwoCol></div>

      <Section title={t('backup.list.title')} className="max-md:order-1">
        {busyRemote && <p className="meta">{t('backup.list.busy')}</p>}
        <List empty={<div className="card p-6 text-sm text-muted text-center">{t('backup.list.empty')}</div>}>
          {backups.map((b) => (
            <Row
              key={b.name}
              lead={<span className="grid place-items-center size-11 rounded-full bg-hover text-muted">{b.encrypted ? <Lock size={18} /> : <Archive size={18} />}</span>}
              title={`${fmtDateTime(b.created_at)}${b.label ? ` · ${b.label}` : ''}`}
              titleSuffix={<><Badge tone={REASON_TONE[b.reason] ?? 'neutral'}>{reasonLabel(b.reason)}</Badge>{b.uploaded && b.reason !== 'uploaded' && <Badge>{reasonLabel('uploaded')}</Badge>}</>}
              meta={[b.version ? t('backup.item.version', { version: b.version }) : null, fmtSize(b.size)].filter(Boolean).join(' · ')}
              extra={
                <>
                <span className="block break-all">{b.name}</span>
                <span className="flex flex-wrap items-center gap-1.5 mt-1">
                  {b.encrypted && <Badge icon={Lock}>{t('backup.item.encrypted')}</Badge>}
                  {b.verified === true && <Badge tone="ok" icon={ShieldCheck}>{t('backup.item.verified')}</Badge>}
                  {b.verified === false && <Badge tone="bad" icon={CircleAlert}>{t('backup.item.corrupt')}</Badge>}
                  {b.verified === null && <Badge>{t('backup.item.notVerified')}</Badge>}
                </span>
                </>
              }
              actions={
                <RowActions actions={[
                  { icon: Download, label: `${t('backup.action.download')}: ${b.name}`, onClick: () => { const a = document.createElement('a'); a.href = `/api/admin/backups/${encodeURIComponent(b.name)}/download`; a.download = b.name; a.click() } },
                  { icon: ShieldCheck, label: `${t('backup.action.verify')}: ${b.name}`, disabled: working === b.name, onClick: () => void verify(b) },
                  { icon: RotateCcw, label: `${t('backup.action.restore')}: ${b.name}`, disabled: !!pending, onClick: () => setRestore(b) },
                  { icon: Trash2, danger: true, label: `${t('backup.action.delete')}: ${b.name}`, onClick: () => void remove(b) },
                ]} />
              }
            />
          ))}
        </List>
      </Section>

      <Section title={t('backup.settings.title')} className="max-md:order-3">
        <SettingsCard key={JSON.stringify([settings.passphrase_set, settings.encrypt])} s={settings} onSaved={(s) => { setData((d) => (d ? { ...d, settings: s } : d)); void load() }} />
      </Section>

      {restore && <RestoreDialog backup={restore} supervised={data.supervised} onClose={() => setRestore(null)} onDone={onRestored} />}
      {verifyPass && (
        <PassphraseDialog
          title={t('backup.verify.title')}
          text={t('backup.verify.text')}
          action={t('backup.verify.run')}
          onClose={() => setVerifyPass(null)}
          onSubmit={async (p) => { await verify(verifyPass, p); setVerifyPass(null) }}
        />
      )}
    </div>
  )
}
