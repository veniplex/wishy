import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CircleAlert, CircleArrowUp, CircleCheck, ExternalLink, KeyRound, RefreshCw, TriangleAlert, Download, Container } from 'lucide-react'
import { ApiError, api, errMsg } from '../api'
import { fmtDate, fmtDateTime, t, useT, type TKey } from '../i18n'
import { Badge, Banner, Button, Card, DataTable, Field, FormError, Modal, Section, Segmented, Stat, Switch, useToast } from '../ui'
import { useUpdateAvailability } from '../update-banner'
import { CodeBlock, MarkdownLite, ProgressBar, StepList, type JobStep } from '../update-parts'
import { SectionHead } from './shared'

// ───────────── Types (GET /api/admin/update/status) ─────────────
interface Change { from: string | null; to: string | null }
interface Changes { app: Change | null; node: Change | null; launcher: Change | null; chromium: Change | null; os: Change | null; os_packages: { updated: number; added: number; removed: number; examples: string[] } | null }
interface Release {
  version: string; name: string; notes: string; published_at: string | null; prerelease: boolean; html_url: string | null
  installable_app: boolean; installable_image: boolean; image_digest: string | null
  components: { node: boolean; os_packages: boolean; chromium: boolean; launcher: boolean }
  changes: Changes | null
}
interface DockerInfo { available: boolean; reason: string | null; api_version: string | null; self: { id?: string; image?: string } | null; compose: { project: string; service: string | null } | null }
interface UpdateResult { ok: boolean; code?: string; reason?: string; version?: string; rolled_back?: boolean; rollback_error?: string; db_restored?: boolean; finished_at?: string }
interface UpdateStatus {
  current_version: string
  supervised: boolean
  mode: 'image' | 'app' | 'none'
  app_only: boolean
  docker: DockerInfo
  image_version: string | null
  target: { version: string; mode: 'image' | 'app'; image_digest: string | null } | null
  launcher: { version?: number | string; key_configured: boolean } | null
  launcher_error: string | null
  configured: boolean
  repo: string
  repo_env_locked: boolean
  channel: 'stable' | 'prerelease'
  auto_check: 'daily' | 'off'
  token_set: boolean
  token_env_locked: boolean
  latest: Release | null
  available: boolean
  releases: Release[]
  last_check: { at: string; ok: boolean; error_code: string | null; error: string | null } | null
  state: 'disabled' | 'idle' | 'available' | 'available_manual' | 'updating' | 'restoring' | 'failed' | 'image_update_required'
  job: { id: string; kind: string; mode?: 'image' | 'app'; version: string; step: string | null; progress: number | null; steps: JobStep[] } | null
  last_result: UpdateResult | null
  can_update: boolean
  instructions: { docker: string; manual: string }
}

const codeText = (prefix: 'update.code' | 'update.check.error', code: string | null | undefined, fallback?: string | null) => {
  if (code) {
    const key = `${prefix}.${code}` as TKey
    const text = t(key)
    if (text !== key) return text
  }
  return fallback || ''
}

// ───────────── State views ─────────────

/** "What changes" table: current → new per component (changed ones only); in app mode only the app is affected */
function ComponentsTable({ r, mode }: { r: Release; mode: UpdateStatus['mode'] }) {
  const c = r.changes
  if (!c) return <p className="meta">{t('update.comp.unknown')}</p>
  const appOnly = mode === 'app'
  const skipped = <span className="meta">{t('update.comp.skipped')}</span>
  const arrow = (x: Change) => <span className="num">{x.from ?? '–'} → {x.to ?? '–'}</span>
  const rows: { key: string; cells: ReactNode[] }[] = []
  const row = (key: string, label: string, ch: Change | null, base: boolean) => { if (ch) rows.push({ key, cells: [label, base && appOnly ? skipped : arrow(ch)] }) }
  row('app', t('update.comp.app'), c.app, false)
  row('node', t('update.comp.node'), c.node, true)
  row('chromium', t('update.comp.chromium'), c.chromium, true)
  row('launcher', t('update.comp.launcher'), c.launcher, true)
  row('os', t('update.comp.os'), c.os, true)
  if (c.os_packages) {
    const n = c.os_packages.updated + c.os_packages.added + c.os_packages.removed
    rows.push({ key: 'pkgs', cells: [t('update.comp.osPackages'), appOnly ? skipped : <span title={c.os_packages.examples.join(', ')}>{t('update.comp.osPackagesValue', { count: n })}</span>] })
  }
  return (
    <div className="space-y-1.5">
      <h5 className="text-sm font-semibold">{t('update.comp.title')}</h5>
      {rows.length ? <DataTable columns={[t('update.comp.col.component'), t('update.comp.col.change')]} rows={rows} /> : <p className="meta">{t('update.comp.unchanged')}</p>}
    </div>
  )
}

function ReleaseNotes({ r, mode }: { r: Release; mode: UpdateStatus['mode'] }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold">v{r.version}</h4>
        {r.prerelease && <Badge tone="warn">{t('update.view.prerelease')}</Badge>}
        {r.published_at && <span className="meta">{fmtDate(r.published_at.slice(0, 10))}</span>}
        {r.html_url && /^https:\/\//.test(r.html_url) && (
          <a href={r.html_url} target="_blank" rel="noopener noreferrer" className="meta inline-flex items-center gap-1 hover:text-accent underline underline-offset-2">{t('update.view.openRelease')}<ExternalLink size={12} /></a>
        )}
      </div>
      <ComponentsTable r={r} mode={mode} />
      {r.notes.trim() ? <MarkdownLite source={r.notes} /> : <p className="text-sm text-muted">{t('update.view.notesEmpty')}</p>}
    </div>
  )
}

function InstallDialog({ version, mode, onClose, onConfirm }: { version: string; mode: 'image' | 'app'; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await onConfirm()
    } catch (err) {
      setError(codeText('update.code', err instanceof ApiError ? err.code : null, errMsg(err)))
      setBusy(false)
    }
  }
  return (
    <form onSubmit={run}>
      <Modal
        title={t('update.install.title', { version })}
        onClose={busy ? () => {} : onClose}
        footer={<><span className="flex-1" /><Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button><Button variant="primary" type="submit" disabled={busy}>{t('update.install.confirm')}</Button></>}
      >
        <Banner tone={mode === 'image' ? 'info' : 'warn'} icon={mode === 'image' ? Container : TriangleAlert}>
          <div className="font-semibold">{t('update.install.mode', { mode: mode === 'image' ? t('update.mode.image.title') : t('update.mode.app.title') })}</div>
          <div>{mode === 'image' ? t('update.mode.image.text') : t('update.mode.app.text')}</div>
        </Banner>
        <p className="text-sm">{t('update.install.intro')}</p>
        <ol className="list-decimal pl-5 space-y-1.5 text-sm text-muted">
          {mode === 'image' && <li>{t('update.install.imageStep1')}</li>}
          <li>{t('update.install.step2b')}</li>
          <li>{mode === 'image' ? t('update.install.imageStep3') : t('update.install.appStep3')}</li>
          <li>{mode === 'image' ? t('update.install.imageStep4') : t('update.install.step4')}</li>
        </ol>
        <FormError>{error}</FormError>
      </Modal>
    </form>
  )
}

function KeyHelp() {
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2"><KeyRound size={18} className="text-muted" /><h3 className="h3">{t('update.key.title')}</h3></div>
      <p className="text-sm text-muted">{t('update.key.text')}</p>
      <ol className="list-decimal pl-5 space-y-1.5 text-sm text-muted">
        <li>{t('update.key.step1')}</li>
        <li>{t('update.key.step2')}</li>
        <li>{t('update.key.step3')}</li>
      </ol>
    </Card>
  )
}

function ManualHelp({ s }: { s: UpdateStatus }) {
  return (
    <Card className="space-y-3">
      <h3 className="h3">{t('update.manual.title')}</h3>
      <p className="text-sm text-muted">{t('update.manual.text')}</p>
      <div className="space-y-1.5"><div className="meta">{t('update.manual.docker')}</div><CodeBlock>{s.instructions.docker}</CodeBlock></div>
      <ol className="list-decimal pl-5 space-y-2 text-sm text-muted">
        <li>{t('update.manual.step1')}</li>
        <li className="space-y-1.5">{t('update.manual.step2')}<div className="mt-1.5"><CodeBlock>npm ci && npm run build</CodeBlock></div></li>
        <li>{t('update.manual.step3')}</li>
      </ol>
    </Card>
  )
}

function ImageHelp({ s }: { s: UpdateStatus }) {
  return (
    <Card className="space-y-3">
      <h3 className="h3">{t('update.image.title')}</h3>
      <p className="text-sm text-muted">{t('update.image.text', { version: s.last_result?.version ?? s.latest?.version ?? '' })}</p>
      <CodeBlock>{s.instructions.docker}</CodeBlock>
      <p className="text-sm text-muted">{t('update.image.after')}</p>
    </Card>
  )
}

const COMPOSE_PROXY = `  wishy:
    environment:
      DOCKER_HOST: tcp://docker-proxy:2375
    networks: [default, docker-api]
    depends_on: [docker-proxy]
  docker-proxy:                  # only allow the required calls, see docker-compose.yml
    image: wollomatic/socket-proxy:1.14.0
    user: "65534:999"            # 999 = GID of /var/run/docker.sock
    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]
    networks: [docker-api]
networks:
  docker-api: { internal: true }`
const COMPOSE_SOCKET = `  wishy:
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    group_add: ["999"]            # GID of /var/run/docker.sock`

function DockerCard({ s }: { s: UpdateStatus }) {
  const d = s.docker
  const reasonKey = `update.docker.reason.${d.reason}` as TKey
  const reason = d.reason ? (t(reasonKey) !== reasonKey ? t(reasonKey) : t('update.docker.reason.other', { reason: d.reason })) : ''
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Container size={18} className="text-muted" />
        <h3 className="h3">{t('update.docker.title')}</h3>
        {d.available ? <Badge tone="ok" icon={CircleCheck}>{t('update.docker.available')}</Badge> : <Badge tone="warn" icon={TriangleAlert}>{t('update.docker.unavailable')}</Badge>}
      </div>
      <p className="text-sm text-muted">{t('update.docker.intro')}</p>
      {d.available ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3 text-sm">
          <div><dt className="meta">{t('update.docker.api')}</dt><dd className="font-medium">{d.api_version ?? '–'}</dd></div>
          <div className="min-w-0"><dt className="meta">{t('update.docker.container')}</dt><dd className="font-medium break-all">{d.self?.id ?? '–'}</dd></div>
          <div><dt className="meta">{t('update.docker.compose')}</dt><dd className="font-medium">{d.compose ? `${d.compose.project}${d.compose.service ? ` / ${d.compose.service}` : ''}` : '–'}</dd></div>
        </dl>
      ) : (
        reason && <Banner tone="warn" icon={TriangleAlert}>{reason}</Banner>
      )}
      <Banner tone="warn" icon={TriangleAlert}>{t('update.docker.risk')}</Banner>
      {!d.available && (
        <details className="group border-t border-line pt-4" open>
          <summary className="cursor-pointer text-sm font-medium select-none">{t('update.docker.variants')}</summary>
          <div className="space-y-5 mt-4">
            <div className="space-y-1.5"><h4 className="font-semibold text-sm">{t('update.docker.variantB')}</h4><p className="text-sm text-muted">{t('update.docker.variantBText')}</p><CodeBlock>{COMPOSE_PROXY}</CodeBlock></div>
            <div className="space-y-1.5"><h4 className="font-semibold text-sm">{t('update.docker.variantA')}</h4><p className="text-sm text-muted">{t('update.docker.variantAText')}</p><CodeBlock>{COMPOSE_SOCKET}</CodeBlock></div>
            <p className="text-sm text-muted">{t('update.docker.after')}</p>
          </div>
        </details>
      )}
    </Card>
  )
}

function RecoveryHint() {
  return (
    <div className="space-y-1.5 rounded-xl bg-hover border border-line px-3.5 py-3 text-sm">
      <div className="font-semibold">{t('update.failed.recoveryTitle')}</div>
      <p className="text-muted">{t('update.failed.recovery')}</p>
      <CodeBlock>{t('update.failed.recoveryCmd')}</CodeBlock>
    </div>
  )
}

function FailedView({ s, log }: { s: UpdateStatus; log: string[] }) {
  const r = s.last_result!
  const reason = codeText('update.code', r.code, r.reason)
  return (
    <div className="space-y-3">
      <Banner tone="bad" icon={CircleAlert}>
        <div className="font-semibold">{t('update.failed.title', { version: r.version ?? '' })}</div>
        <div>{t('update.failed.reason', { reason })}</div>
        {r.reason && r.reason !== reason && <div className="text-xs opacity-80 mt-0.5 break-words">{r.reason}</div>}
        {r.code === 'rollback_failed' && <div className="mt-1">{t('update.failed.rollbackFailed')}</div>}
        <div className="mt-1">{r.rolled_back ? t('update.failed.rolledBack') : r.rollback_error ? t('update.failed.noRollback') : t('update.failed.unchanged')}{r.db_restored ? ` ${t('update.failed.dbRestored')}` : ''}</div>
      </Banner>
      {(r.code === 'rollback_failed' || r.code === 'schema_newer' || r.code === 'launcher_interrupted' || r.code === 'crash_loop' || r.rollback_error) && <RecoveryHint />}
      {log.length > 0 && <LogBox title={t('update.failed.log')} lines={log} />}
    </div>
  )
}

function LogBox({ title, lines }: { title: string; lines: string[] }) {
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }) }, [lines])
  return (
    <div className="space-y-1.5">
      <h3 className="h3">{title}</h3>
      <pre ref={box} tabIndex={0} className="max-h-56 overflow-auto rounded-xl bg-hover border border-line px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{lines.join('\n')}</pre>
    </div>
  )
}

function RunningView({ s, log }: { s: UpdateStatus; log: string[] }) {
  const job = s.job!
  const restore = s.state === 'restoring'
  return (
    <Card className="space-y-5">
      <div>
        <h3 className="h2 text-xl">{restore ? t('update.running.restoreTitle') : t('update.running.title', { version: `v${job.version}` })}</h3>
        <p className="text-sm text-muted mt-1">{job.mode === 'image' ? t('update.running.imageSub') : t('update.running.sub')}</p>
      </div>
      <div className="space-y-1.5">
        <ProgressBar value={job.progress} label={t('update.running.title', { version: job.version })} />
        {typeof job.progress === 'number' && <p className="meta num">{t('update.running.progress', { percent: Math.round(job.progress * 100) })}</p>}
      </div>
      <StepList steps={job.steps} />
      {log.length > 0 && <LogBox title={t('update.running.log')} lines={log} />}
    </Card>
  )
}

// ───────────── Settings ─────────────
function SettingsCard({ s, onSaved }: { s: UpdateStatus; onSaved: () => void }) {
  const toast = useToast()
  const [repo, setRepo] = useState(s.repo)
  const [channel, setChannel] = useState(s.channel)
  const [auto, setAuto] = useState(s.auto_check === 'daily')
  const [token, setToken] = useState('')
  const [editToken, setEditToken] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const typing = !s.token_env_locked && (!s.token_set || editToken)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('PUT', '/api/admin/update/settings', {
        ...(s.repo_env_locked ? {} : { repo: repo.trim() }),
        channel,
        auto_check: auto ? 'daily' : 'off',
        ...(typing && token.trim() ? { token: token.trim() } : {}),
      })
      toast(t('update.settings.saved'), 'ok')
      setToken('')
      setEditToken(false)
      onSaved()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  const clearToken = async () => {
    try {
      await api('PUT', '/api/admin/update/settings', { token: null })
      toast(t('update.settings.saved'), 'ok')
      onSaved()
    } catch (err) {
      setError(errMsg(err))
    }
  }
  return (
    <form onSubmit={save}>
      <Card className="space-y-5">
        <Field label={t('update.settings.repo')} hint={s.repo_env_locked ? t('update.settings.repoEnv') : t('update.settings.repoHint')}>
          <input className="input" placeholder="veniplex/wishy" autoComplete="off" spellCheck={false} disabled={s.repo_env_locked} value={repo} onChange={(e) => setRepo(e.target.value)} />
        </Field>
        <Field label={t('update.settings.channel')} group>
          <Segmented
            label={t('update.settings.channel')}
            value={channel}
            onChange={setChannel}
            options={[{ value: 'stable', label: t('update.settings.channel.stable') }, { value: 'prerelease', label: t('update.settings.channel.prerelease') }]}
          />
        </Field>
        <Switch checked={auto} onChange={setAuto}>
          <span className="font-medium">{t('update.settings.autoCheck')}</span>
          <span className="block meta mt-0.5">{t('update.settings.autoCheckHint')}</span>
        </Switch>
        <div className="space-y-2">
          {s.token_env_locked ? (
            <><div className="label !mb-0">{t('update.settings.token')}</div><p className="text-sm text-muted">{t('update.settings.tokenEnv')}</p></>
          ) : typing ? (
            <Field label={t('update.settings.token')} hint={t('update.settings.tokenHint')}>
              <input className="input" type="password" autoComplete="off" placeholder={t('update.settings.tokenPlaceholder')} value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
          ) : (
            <>
              <div className="label !mb-0">{t('update.settings.token')}</div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="ok" icon={CircleCheck}>{t('update.settings.tokenSet')}</Badge>
                <Button size="sm" onClick={() => setEditToken(true)}>{t('update.settings.tokenReplace')}</Button>
                <Button size="sm" variant="danger" onClick={clearToken}>{t('update.settings.tokenClear')}</Button>
              </div>
            </>
          )}
        </div>
        <FormError>{error}</FormError>
        <div><Button variant="primary" type="submit" disabled={busy}>{t('update.settings.save')}</Button></div>
      </Card>
    </form>
  )
}

// ───────────── Page ─────────────
/** Admin › Updates: version, check, release notes, installation (launcher only), progress, failure view, settings */
export function AdminUpdates() {
  useT()
  const toast = useToast()
  const { apply } = useUpdateAvailability()
  const [s, setS] = useState<UpdateStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    try {
      const st = await api<UpdateStatus>('GET', '/api/admin/update/status')
      if (!alive.current) return
      setS(st)
      setLoadError('')
      apply(st)
    } catch (e) {
      // While the app restarts it is briefly unreachable - keep the last known state
      if (alive.current) setLoadError(errMsg(e))
    }
  }, [apply])
  useEffect(() => { void load() }, [load])

  const running = s?.state === 'updating' || s?.state === 'restoring'
  const wasRunning = useRef(false)
  useEffect(() => {
    // After a successful update, reload the page so the new UI is loaded
    if (running) wasRunning.current = true
    else if (wasRunning.current && s?.last_result?.ok) window.location.reload()
    else if (wasRunning.current) wasRunning.current = false
  }, [running, s?.last_result])
  const failed = s?.state === 'failed'
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => { void load() }, 1500)
    return () => clearInterval(id)
  }, [running, load])
  useEffect(() => {
    if (!running && !failed) { setLog([]); return }
    let stop = false
    const tail = async () => {
      try {
        const r = await api<{ lines: string[] }>('GET', `/api/admin/update/log?lines=${running ? 25 : 40}`)
        if (!stop && alive.current) setLog(r.lines)
      } catch { /* app is restarting */ }
    }
    void tail()
    if (!running) return
    const id = setInterval(tail, 2500)
    return () => { stop = true; clearInterval(id) }
  }, [running, failed])

  const check = async () => {
    setChecking(true)
    try {
      const st = await api<UpdateStatus>('POST', '/api/admin/update/check')
      setS(st)
      apply(st)
      if (st.last_check?.ok) toast(st.available && st.latest ? t('update.check.found', { version: st.latest.version }) : t('update.check.upToDate'), 'ok')
    } catch (e) {
      toast(errMsg(e), 'bad')
    } finally {
      setChecking(false)
    }
  }
  const install = async (version: string, mode: 'image' | 'app') => {
    await api('POST', '/api/admin/update/start', { version, mode })
    setConfirm(null)
    toast(t('update.install.started'), 'ok')
    await load()
  }

  if (!s) {
    return (
      <div className="flex flex-col gap-8">
        <SectionHead title={t('update.title')} sub={t('update.sub')} />
        {loadError ? <Banner tone="bad" icon={CircleAlert}>{loadError}</Banner> : <div className="card p-5 text-muted text-sm">{t('common.loading')}</div>}
      </div>
    )
  }

  const latest = s.latest
  const rel = s.releases.find((r) => r.version === s.target?.version) ?? s.releases[0] ?? null
  const others = s.releases.filter((r) => r.version !== rel?.version)
  const lc = s.last_check
  const checkProblem = lc && !lc.ok ? codeText('update.check.error', lc.error_code, lc.error) : ''
  const okResult = s.last_result?.ok && s.last_result.version === s.current_version ? s.last_result : null
  const showAvailable = (s.state === 'available' || s.state === 'available_manual' || s.state === 'failed' || s.state === 'image_update_required') && rel
  const instMode: 'image' | 'app' | null = s.mode === 'none' ? null : s.mode
  const relInstallable = !!rel && (instMode === 'image' ? rel.installable_image : instMode === 'app' ? rel.installable_app : false)
  const canInstall = !!instMode && s.can_update && relInstallable && (s.state === 'available' || s.state === 'failed')
  const keyMissing = s.supervised && !!s.launcher && !s.launcher.key_configured
  const imageDiffers = !!s.image_version && s.image_version !== s.current_version

  return (
    <div className="flex flex-col gap-8">
      <SectionHead
        title={t('update.title')}
        sub={t('update.sub')}
        actions={<Button icon={RefreshCw} onClick={check} disabled={checking || running || !s.configured}>{checking ? t('update.check.running') : t('update.check.now')}</Button>}
      />

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
        <Stat
          label={t('update.version.current')}
          value={`v${s.current_version}`}
          sub={okResult ? t('update.lastOk', { version: okResult.version ?? '', when: okResult.finished_at ? fmtDateTime(okResult.finished_at) : '' }) : imageDiffers ? t('update.version.image', { version: s.image_version ?? '' }) : undefined}
        />
        <Stat
          label={t('update.version.latest')}
          value={latest ? `v${latest.version}` : t('update.version.none')}
          sub={lc ? t('update.check.last', { when: fmtDateTime(lc.at) }) : t('update.check.never')}
        />
      </div>
      {checkProblem && <Banner tone="warn" icon={TriangleAlert}>{checkProblem}</Banner>}
      {loadError && running && <Banner tone="info" icon={RefreshCw}>{t('update.running.blip')}</Banner>}

      {s.state === 'disabled' && (
        <Card className="space-y-2 text-center py-8">
          <span className="mx-auto grid place-items-center size-10 rounded-full bg-hover text-muted"><CircleArrowUp size={18} /></span>
          <h3 className="h3">{t('update.view.disabled.title')}</h3>
          <p className="text-sm text-muted max-w-xl mx-auto text-balance">{t('update.view.disabled.text')}</p>
        </Card>
      )}

      {s.state === 'idle' && (
        <Banner tone="ok" icon={CircleCheck}>
          <strong className="font-semibold">{t('update.view.idle.title')}.</strong> {t('update.view.idle.text', { channel: t(`update.settings.channel.${s.channel}` as TKey) })}
        </Banner>
      )}

      {running && s.job && <RunningView s={s} log={log} />}
      {failed && s.last_result && <FailedView s={s} log={log} />}
      {s.state === 'image_update_required' && <ImageHelp s={s} />}

      {showAvailable && rel && (
        <Section title={t('update.view.available.title', { version: `v${rel.version}` })}>
          {instMode && (
            <Banner tone={instMode === 'image' ? 'info' : 'warn'} icon={instMode === 'image' ? Container : TriangleAlert}>
              <div className="font-semibold">{instMode === 'image' ? t('update.mode.image.title') : t('update.mode.app.title')}</div>
              <div>{instMode === 'image' ? t('update.mode.image.text') : t('update.mode.app.text')}</div>
              {instMode === 'app' && <div className="mt-1">{t('update.mode.app.enable')}</div>}
            </Banner>
          )}
          <Card className="space-y-5">
            <ReleaseNotes r={rel} mode={s.mode} />
            {others.length > 0 && (
              <details className="border-t border-line pt-4 group">
                <summary className="cursor-pointer text-sm font-medium select-none">{t('update.view.moreReleases')} ({others.length})</summary>
                <div className="space-y-6 mt-4">{others.map((r) => <ReleaseNotes key={r.version} r={r} mode={s.mode} />)}</div>
              </details>
            )}
            {instMode && !relInstallable && s.state !== 'image_update_required' && <Banner tone="warn" icon={TriangleAlert}>{instMode === 'app' && rel.installable_image ? t('update.view.needsImage') : t('update.view.notInstallable')}</Banner>}
            {s.supervised && s.launcher_error && <Banner tone="warn" icon={TriangleAlert}>{t('update.view.launcherDown')}</Banner>}
            {s.state !== 'image_update_required' && instMode && (
              <div><Button variant="primary" icon={Download} disabled={!canInstall} onClick={() => setConfirm(rel.version)}>{failed ? t('update.failed.retry') : t('update.install.action')}</Button></div>
            )}
          </Card>
          {s.state === 'available' && keyMissing && <KeyHelp />}
          {s.state === 'available_manual' && <ManualHelp s={s} />}
        </Section>
      )}

      {s.supervised && !running && (
        <DockerCard s={s} />
      )}

      <Section title={t('update.settings.title')}>
        <SettingsCard key={`${s.repo}|${s.channel}|${s.auto_check}|${s.token_set}`} s={s} onSaved={() => void load()} />
      </Section>

      {confirm && instMode && <InstallDialog version={confirm} mode={instMode} onClose={() => setConfirm(null)} onConfirm={() => install(confirm, instMode)} />}
    </div>
  )
}
