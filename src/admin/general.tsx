import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, errMsg } from '../api'
import { LOCALES, t, useT, type Locale, type TKey } from '../i18n'
import { Badge, Banner, Button, Card, Field, FormError, Section, Segmented } from '../ui'
import { SectionHead } from './shared'
import { useSettingsGroup, type GeneralSettings } from './use-settings'

interface Diagnostics {
  protocol: string
  secure: boolean
  host: string
  client_ip: string | null
  socket_ip: string | null
  proxy_trusted: boolean
  forwarded_headers: Record<string, string | null>
  forwarded_headers_seen: string[]
  base_url: { configured: string | null; effective: string }
  cookie: { secure: boolean; same_site: string }
  webauthn: { rp_id: string | null; origin: string | null }
  bypass_paths: string[]
  warnings: { code: string; severity: 'info' | 'warning' | 'error'; message: string }[]
}

const SEV_TONE = { info: 'info', warning: 'warn', error: 'bad' } as const

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="meta">{label}</dt>
      <dd className="font-medium break-words">{children}</dd>
    </div>
  )
}

/** Diagnostics "How Wishy sees this request" (GET /api/admin/diagnostics/proxy): detected values + warnings by severity */
function ProxyDiagnostics({ reloadKey }: { reloadKey: string }) {
  useT()
  const [d, setD] = useState<Diagnostics | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setD(await api<Diagnostics>('GET', '/api/admin/diagnostics/proxy'))
    } catch (e) {
      setError(errMsg(e) || t('adminGeneral.diag.failed'))
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => { void load() }, [load, reloadKey])

  const yn = (v: boolean) => (v ? t('adminGeneral.diag.yes') : t('adminGeneral.diag.no'))
  const warnText = (w: Diagnostics['warnings'][number]) => {
    const key = `adminGeneral.diag.w.${w.code}` as TKey
    const text = t(key, { configured: d?.base_url.configured ? new URL(d.base_url.configured).host : '', host: d?.host ?? '' })
    return text !== key ? text : w.message
  }
  const order = { error: 0, warning: 1, info: 2 } as const
  return (
    <Section title={t('adminGeneral.diag.title')} action={<Button size="sm" icon={RefreshCw} disabled={busy} onClick={load}>{t('adminGeneral.diag.refresh')}</Button>}>
      <Card className="space-y-5">
        <p className="text-sm text-muted">{t('adminGeneral.diag.text')}</p>
        <FormError>{error}</FormError>
        {d && (
          <>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
              <Item label={t('adminGeneral.diag.protocol')}>{d.protocol}</Item>
              <Item label={t('adminGeneral.diag.host')}>{d.host}</Item>
              <Item label={t('adminGeneral.diag.clientIp')}>{d.client_ip ?? '–'}</Item>
              <Item label={t('adminGeneral.diag.socketIp')}>{d.socket_ip ?? '–'}</Item>
              <Item label={t('adminGeneral.diag.trusted')}><Badge tone={d.proxy_trusted ? 'ok' : 'neutral'}>{yn(d.proxy_trusted)}</Badge></Item>
              <Item label={t('adminGeneral.diag.cookie')}><Badge tone={d.cookie.secure ? 'ok' : 'neutral'}>{yn(d.cookie.secure)}</Badge> <span className="meta">SameSite={d.cookie.same_site}</span></Item>
              <Item label={t('adminGeneral.diag.baseUrl')}>{d.base_url.effective}</Item>
              <Item label={t('adminGeneral.diag.rpId')}>{d.webauthn.rp_id ?? '–'}</Item>
              <Item label={t('adminGeneral.diag.headers')}>
                {d.forwarded_headers_seen.length ? d.forwarded_headers_seen.join(', ') : <span className="text-muted font-normal">{t('adminGeneral.diag.noHeaders')}</span>}
              </Item>
            </dl>
            <div className="space-y-2">
              <h3 className="h3">{t('adminGeneral.diag.warnings')}</h3>
              {d.warnings.length === 0
                ? <Banner tone="ok">{t('adminGeneral.diag.allGood')}</Banner>
                : [...d.warnings].sort((a, b) => order[a.severity] - order[b.severity]).map((w) => (
                  <Banner key={w.code} tone={SEV_TONE[w.severity] ?? 'info'}><strong className="font-medium">{t(`adminGeneral.diag.sev.${w.severity}`)}:</strong> {warnText(w)}</Banner>
                ))}
            </div>
            {d.bypass_paths.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="h3">{t('adminGeneral.diag.bypass')}</h3>
                <p className="text-sm font-mono text-muted break-words">{d.bypass_paths.join('  ·  ')}</p>
              </div>
            )}
          </>
        )}
      </Card>
    </Section>
  )
}

/**
 * Admin › General: app name, base URL, default language, reverse proxy (+ diagnostics), retention periods.
 * Fields locked via environment variable are read-only.
 */
export function AdminGeneral() {
  useT()
  const { cfg, error, saving, save, locked } = useSettingsGroup<GeneralSettings>('general')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [locale, setLocale] = useState<Locale>('de')
  const [trust, setTrust] = useState('')
  const [rAudit, setRAudit] = useState('')
  const [rAi, setRAi] = useState('')
  const [rSessions, setRSessions] = useState('')
  useEffect(() => {
    if (!cfg) return
    setName(cfg.app_name)
    setBaseUrl(cfg.base_url)
    setLocale(cfg.default_locale === 'en' ? 'en' : 'de')
    setTrust(cfg.trust_proxy)
    setRAudit(String(cfg.retention_audit_days))
    setRAi(String(cfg.retention_ai_usage_days))
    setRSessions(cfg.retention_sessions_days == null ? '' : String(cfg.retention_sessions_days))
  }, [cfg])

  const envNote = (k: string, name: string) => (locked(k) ? t('adminGeneral.envLocked', { name }) : undefined)
  const num = (s: string) => (s.trim() === '' ? null : Number(s))
  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('adminGeneral.title')} sub={t('adminGeneral.sub')} />
      {!cfg ? <FormError>{error || t('adminGeneral.loading')}</FormError> : (
        <>
          <form
            className="flex flex-col gap-8"
            onSubmit={(e) => {
              e.preventDefault()
              void save({
                app_name: name,
                ...(locked('base_url') ? {} : { base_url: baseUrl }),
                default_locale: locale,
                ...(locked('trust_proxy') ? {} : { trust_proxy: trust }),
                retention_audit_days: num(rAudit),
                retention_ai_usage_days: num(rAi),
                retention_sessions_days: num(rSessions),
              })
            }}
          >
            <Section title={t('adminGeneral.app.title')}>
              <Card className="space-y-4">
                <Field label={t('adminGeneral.app.name')}><input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
                <Field label={t('adminGeneral.app.baseUrl')} hint={envNote('base_url', 'BASE_URL') ?? t('adminGeneral.app.baseUrlHint')}>
                  <input className="input" type="url" placeholder="https://wishy.example.com" disabled={locked('base_url')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                </Field>
                <p className="meta -mt-2">{t('adminGeneral.app.effective', { url: cfg.effective_base_url })}</p>
                <Field label={t('adminGeneral.app.locale')} group hint={t('adminGeneral.app.localeHint')}>
                  <Segmented label={t('adminGeneral.app.locale')} value={locale} onChange={setLocale} options={LOCALES.filter((l) => cfg.locales.includes(l.value))} />
                </Field>
              </Card>
            </Section>

            <Section title={t('adminGeneral.proxy.title')}>
              <Card className="space-y-4">
                <Field label={t('adminGeneral.proxy.trust')} hint={envNote('trust_proxy', 'TRUST_PROXY') ?? t('adminGeneral.proxy.trustHint')}>
                  <input className="input sm:max-w-md" autoComplete="off" spellCheck={false} placeholder={t('adminGeneral.proxy.trustPlaceholder')} disabled={locked('trust_proxy')} value={trust} onChange={(e) => setTrust(e.target.value)} />
                </Field>
              </Card>
            </Section>

            <Section title={t('adminGeneral.retention.title')}>
              <Card className="space-y-4">
                <p className="text-sm text-muted">{t('adminGeneral.retention.text')}</p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t('adminGeneral.retention.audit')}><input className="input" type="number" min={0} max={36500} step={1} inputMode="numeric" value={rAudit} onChange={(e) => setRAudit(e.target.value)} /></Field>
                  <Field label={t('adminGeneral.retention.ai')} hint={t('adminGeneral.retention.aiHint')}><input className="input" type="number" min={0} max={36500} step={1} inputMode="numeric" value={rAi} onChange={(e) => setRAi(e.target.value)} /></Field>
                  <Field label={t('adminGeneral.retention.sessions')} hint={t('adminGeneral.retention.sessionsHint')}><input className="input" type="number" min={0} max={36500} step={1} inputMode="numeric" value={rSessions} onChange={(e) => setRSessions(e.target.value)} /></Field>
                </div>
              </Card>
            </Section>

            <FormError>{error}</FormError>
            <div><Button variant="primary" type="submit" disabled={saving}>{t('adminGeneral.save')}</Button></div>
          </form>

          <ProxyDiagnostics reloadKey={`${cfg.trust_proxy}|${cfg.base_url}`} />
        </>
      )}
    </div>
  )
}
