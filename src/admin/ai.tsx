import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Plus, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { aiReason, api, errMsg, type AiAdmin } from '../api'
import { resetAiStatus } from '../ai'
import { t, useT } from '../i18n'
import { Badge, Banner, Button, Card, Field, FormError, IconButton, PillTabs, Section, Segmented, Select, Switch, useToast } from '../ui'
import { SectionHead } from './shared'
import { AiUsageAnalytics } from './ai-usage'
import { AdminAiPrompts } from './ai-prompts'

/**
 * Admin › AI: provider, features, limits, prices, currency and usage analytics (ai-usage.tsx).
 * Prices, costs and the cost cap are all in the cost currency (ai_cost_currency); changing it with existing data asks for a one-time rate.
 */
const AI_ENV: Record<string, string> = { ai_provider: 'AI_PROVIDER', ai_model: 'AI_MODEL', ai_api_key: 'AI_API_KEY', ai_base_url: 'AI_BASE_URL' }
const FEATURES = ['link_import', 'text_import', 'image_import', 'suggestions'] as const

type Prices = Record<string, { input_per_mtok: number; output_per_mtok: number }>
interface AiCfg extends AiAdmin {
  ai_monthly_user_limit: number | null
  ai_monthly_cost_cap: number | null
  ai_cost_currency: string
  ai_convert_needed: boolean
  ai_prices: Prices
}
interface PriceRow { id: string; input: string; output: string }

const toRows = (p: Prices): PriceRow[] => Object.entries(p).map(([id, v]) => ({ id, input: String(v.input_per_mtok), output: String(v.output_per_mtok) }))
const num = (s: string) => Number(s.trim().replace(',', '.'))
const optNum = (s: string) => (s.trim() === '' ? null : num(s))
/** Exact match or longest prefix – same as on the server */
const hasPrice = (model: string, rows: PriceRow[]) => !!model && rows.some((r) => r.id && (model === r.id || model.startsWith(r.id)))

export function AdminAi() {
  useT()
  const toast = useToast()
  const [cfg, setCfg] = useState<AiCfg | null>(null)
  const [f, setF] = useState({ enabled: false, provider: 'anthropic', model: '', key: '', baseUrl: '', features: { link_import: true, text_import: true, image_import: true, suggestions: true }, linkMode: 'ai' as 'ai' | 'builtin', limit: '', userLimit: '', costCap: '', currency: 'USD', rate: '' })
  const [prices, setPrices] = useState<PriceRow[]>([])
  const [error, setError] = useState('')
  const [test, setTest] = useState<{ ok: boolean; latency_ms: number; model: string | null; error?: string; error_code?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [usageKey, setUsageKey] = useState(0) // remount the usage analytics after a save (the cost currency may have changed)
  const [tab, setTab] = useState<'settings' | 'prompts'>('settings')
  const [promptsSeen, setPromptsSeen] = useState(false) // prompts stay mounted after the first open so drafts are not lost when switching tabs
  const switchTab = (v: 'settings' | 'prompts') => { setTab(v); if (v === 'prompts') setPromptsSeen(true) }

  const apply = (c: AiCfg) => {
    setCfg(c)
    setF({
      enabled: c.ai_enabled, provider: c.ai_provider, model: c.ai_model, key: '', baseUrl: c.ai_base_url, features: c.ai_features, linkMode: c.ai_link_mode ?? 'ai',
      limit: c.ai_monthly_request_limit == null ? '' : String(c.ai_monthly_request_limit),
      userLimit: c.ai_monthly_user_limit == null ? '' : String(c.ai_monthly_user_limit),
      costCap: c.ai_monthly_cost_cap == null ? '' : String(c.ai_monthly_cost_cap),
      currency: c.ai_cost_currency || 'USD', rate: '',
    })
    setPrices(toRows(c.ai_prices ?? {}))
  }
  useEffect(() => { api<AiCfg>('GET', '/api/admin/ai').then(apply).catch((e) => setError(errMsg(e))) }, [])

  const locked = (k: string) => !!cfg?.env_locked.includes(k)
  const prov = cfg?.providers.find((p) => p.id === f.provider)
  const envHint = (k: string) => (locked(k) ? t('admin.envLocked', { name: AI_ENV[k] }) : undefined)
  const activeModel = f.model.trim() || prov?.default_model || ''
  const costCurrency = f.currency.trim() || 'USD'
  const switching = !!cfg && costCurrency !== cfg.ai_cost_currency
  const needsRate = switching && cfg.ai_convert_needed // one-time rate to convert recorded costs, the cap and the prices

  const save = async (extra: object = {}) => {
    setError('')
    try {
      // Changing the currency converts the stored cap on the server – unless the admin typed a new cap, which counts in the new currency
      const keepCap = switching && f.costCap === (cfg.ai_monthly_cost_cap == null ? '' : String(cfg.ai_monthly_cost_cap))
      // Prices that were not touched are converted by the server together with the currency; edited ones count in the new currency
      const keepPrices = switching && JSON.stringify(prices) === JSON.stringify(toRows(cfg.ai_prices ?? {}))
      const pr: Prices = {}
      for (const r of prices) {
        if (!r.id.trim() && !r.input.trim() && !r.output.trim()) continue
        pr[r.id.trim()] = { input_per_mtok: num(r.input), output_per_mtok: num(r.output) }
      }
      apply(await api<AiCfg>('PUT', '/api/admin/ai', {
        ai_enabled: f.enabled,
        ai_provider: f.provider,
        ai_model: f.model.trim() || null,
        ai_base_url: f.baseUrl.trim() || null,
        ai_features: f.features,
        ai_link_mode: f.linkMode,
        ai_monthly_request_limit: optNum(f.limit),
        ai_monthly_user_limit: optNum(f.userLimit),
        ...(keepCap ? {} : { ai_monthly_cost_cap: optNum(f.costCap) }),
        ai_cost_currency: costCurrency,
        ...(needsRate ? { ai_cost_rate: optNum(f.rate) } : {}),
        ...(keepPrices ? {} : { ai_prices: pr }),
        ...(f.key.trim() ? { ai_api_key: f.key.trim() } : {}),
        ...extra,
      }))
      toast(t('admin.saved'), 'ok')
      resetAiStatus()
      setUsageKey((k) => k + 1)
    } catch (e) {
      setError(errMsg(e))
    }
  }
  const runTest = async () => {
    setTesting(true)
    setTest(null)
    try {
      setTest(await api('POST', '/api/admin/ai/test', { ai_provider: f.provider, ai_model: f.model.trim() || undefined, ai_base_url: f.baseUrl.trim() || undefined, ...(f.key.trim() ? { ai_api_key: f.key.trim() } : {}) }))
    } catch (e) {
      setTest({ ok: false, latency_ms: 0, model: null, error: errMsg(e) })
    } finally {
      setTesting(false)
    }
  }
  const changeProvider = (id: string) => {
    const p = cfg?.providers.find((x) => x.id === id)
    setF({ ...f, provider: id, model: locked('ai_model') ? f.model : (p?.default_model ?? '') })
    setTest(null)
  }
  const setRow = (i: number, patch: Partial<PriceRow>) => setPrices(prices.map((r, k) => (k === i ? { ...r, ...patch } : r)))

  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('admin.ai.title')} sub={t('admin.ai.sub')} />
      <PillTabs label={t('aiPrompts.tabs')} value={tab} onChange={switchTab} items={[{ value: 'settings', label: t('aiPrompts.tab.settings') }, { value: 'prompts', label: t('aiPrompts.tab.prompts') }]} />
      <div className={tab === 'settings' ? 'flex flex-col gap-8' : 'hidden'}>
      {!cfg ? <FormError>{error || t('admin.loading')}</FormError> : (
        <form className="flex flex-col gap-8" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <Banner icon={ShieldCheck}>{t('aiUsage.admin.privacy')}</Banner>

          <Section title={t('aiUsage.admin.provider')}>
            <Card className="space-y-4">
              <Field label={t('aiUsage.admin.enabled')} group>
                <Segmented label={t('aiUsage.admin.enabled')} value={f.enabled ? 'on' : 'off'} onChange={(v) => setF({ ...f, enabled: v === 'on' })} options={[{ value: 'off', label: t('aiUsage.admin.off') }, { value: 'on', label: t('aiUsage.admin.on') }]} />
              </Field>
              {cfg.missing && <p className="meta">{t('aiUsage.admin.missing', { what: aiReason(cfg.missing_code, cfg.missing) })}</p>}
              <Field label={t('aiUsage.admin.providerLabel')} hint={envHint('ai_provider')}>
                <Select value={f.provider} disabled={locked('ai_provider')} onChange={(e) => changeProvider(e.target.value)}>
                  {cfg.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </Select>
              </Field>
              <Field label={t('aiUsage.admin.model')} hint={envHint('ai_model') ?? (prov?.default_model ? t('aiUsage.admin.modelDefault', { model: prov.default_model }) : (prov?.model_hint ?? t('aiUsage.admin.modelEnter')))}>
                <input className="input" autoComplete="off" placeholder={prov?.default_model ?? t('aiUsage.admin.modelEnter')} disabled={locked('ai_model')} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
              </Field>
              {prov?.needs_base_url && (
                <Field label={t('aiUsage.admin.baseUrl')} hint={envHint('ai_base_url') ?? t('aiUsage.admin.baseUrlHint')}>
                  <input className="input" type="url" placeholder="http://localhost:11434/v1" disabled={locked('ai_base_url')} value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
                </Field>
              )}
              <Field label={t('aiUsage.admin.apiKey')} hint={envHint('ai_api_key') ?? t('aiUsage.admin.apiKeyHint')}>
                <div className="flex gap-2 items-center">
                  <input className="input flex-1 min-w-0" type="password" autoComplete="new-password" placeholder={cfg.ai_api_key_set ? t('aiUsage.admin.apiKeyReplace') : t('aiUsage.admin.apiKeyEnter')} disabled={locked('ai_api_key')} value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
                  {cfg.ai_api_key_set && <Badge tone="ok">{t('aiUsage.admin.apiKeySet')}</Badge>}
                  {cfg.ai_api_key_set && !locked('ai_api_key') && <Button variant="danger" onClick={() => void save({ ai_api_key: null })}>{t('aiUsage.admin.remove')}</Button>}
                </div>
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button icon={Zap} onClick={runTest} disabled={testing}>{testing ? t('aiUsage.admin.testing') : t('aiUsage.admin.test')}</Button>
                {test && (test.ok
                  ? <Badge tone="ok" icon={CircleCheck}>{t('aiUsage.admin.testOk', { ms: test.latency_ms, model: test.model ?? '' })}</Badge>
                  : <Badge tone="bad" icon={CircleAlert}>{test.error ? aiReason(test.error_code, test.error) : t('aiUsage.admin.testFail')}</Badge>)}
              </div>
            </Card>
          </Section>

          <Section title={t('aiUsage.admin.featuresLimits')}>
            <Card className="space-y-4">
              <div className="space-y-3">
                {FEATURES.map((k) => (
                  <div key={k}>
                    <Switch checked={f.features[k]} onChange={(v) => setF({ ...f, features: { ...f.features, [k]: v } })}><span className="font-semibold">{t(`aiUsage.feature.${k}` as const)}</span></Switch>
                    <p className="meta mt-0.5 pr-14">{t(`aiUsage.featureHint.${k}` as const)}</p>
                  </div>
                ))}
              </div>
              <Field label={t('ai.admin.linkMode')} hint={t('ai.admin.linkModeHint')} group>
                <Segmented label={t('ai.admin.linkMode')} value={f.linkMode} onChange={(v) => setF({ ...f, linkMode: v })} options={[{ value: 'builtin', label: t('ai.admin.linkMode.builtin') }, { value: 'ai', label: t('ai.admin.linkMode.ai') }]} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t('aiUsage.admin.limit')} hint={t('aiUsage.admin.limitHint', { count: cfg.requests_this_month })}>
                  <input className="input" inputMode="numeric" placeholder={t('aiUsage.admin.unlimited')} value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />
                </Field>
                <Field label={t('aiUsage.admin.userLimit')} hint={t('aiUsage.admin.userLimitHint')}>
                  <input className="input" inputMode="numeric" placeholder={t('aiUsage.admin.unlimited')} value={f.userLimit} onChange={(e) => setF({ ...f, userLimit: e.target.value })} />
                </Field>
                <Field label={t('aiUsage.admin.costCap', { currency: costCurrency })} hint={t('aiUsage.admin.costCapHint')}>
                  <input className="input" inputMode="decimal" placeholder={t('aiUsage.admin.unlimited')} value={f.costCap} onChange={(e) => setF({ ...f, costCap: e.target.value })} />
                </Field>
              </div>
            </Card>
          </Section>

          <Section title={t('aiUsage.prices.title')}>
            <Card className="space-y-4">
              <p className="meta">{t('aiUsage.prices.hint')}</p>
              {activeModel && !hasPrice(activeModel, prices) && (
                <Banner tone="warn" action={<Button size="sm" onClick={() => setPrices([...prices, { id: activeModel, input: '', output: '' }])}>{t('aiUsage.prices.addFor', { model: activeModel })}</Button>}>
                  {t('aiUsage.prices.missing', { model: activeModel })}
                </Banner>
              )}
              <div className="space-y-2">
                <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_7rem_7rem_2.5rem] gap-2 meta font-semibold px-0.5">
                  <span>{t('aiUsage.prices.model')}</span><span>{t('aiUsage.prices.input', { currency: cfg.ai_cost_currency })}</span><span>{t('aiUsage.prices.output', { currency: cfg.ai_cost_currency })}</span><span />
                </div>
                {prices.map((r, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem] sm:grid-cols-[minmax(0,1fr)_7rem_7rem_2.5rem] gap-2 items-end">
                    <input className="input col-span-3 sm:col-span-1" aria-label={t('aiUsage.prices.model')} placeholder="model-id" autoComplete="off" value={r.id} onChange={(e) => setRow(i, { id: e.target.value })} />
                    <label className="grid gap-1 min-w-0">
                      <span className="meta sm:hidden">{t('aiUsage.prices.input', { currency: cfg.ai_cost_currency })}</span>
                      <input className="input" inputMode="decimal" aria-label={t('aiUsage.prices.input', { currency: cfg.ai_cost_currency })} placeholder={t('aiUsage.prices.input', { currency: cfg.ai_cost_currency })} value={r.input} onChange={(e) => setRow(i, { input: e.target.value })} />
                    </label>
                    <label className="grid gap-1 min-w-0">
                      <span className="meta sm:hidden">{t('aiUsage.prices.output', { currency: cfg.ai_cost_currency })}</span>
                      <input className="input" inputMode="decimal" aria-label={t('aiUsage.prices.output', { currency: cfg.ai_cost_currency })} placeholder={t('aiUsage.prices.output', { currency: cfg.ai_cost_currency })} value={r.output} onChange={(e) => setRow(i, { output: e.target.value })} />
                    </label>
                    <IconButton icon={Trash2} label={t('aiUsage.prices.remove', { model: r.id || '…' })} onClick={() => setPrices(prices.filter((_, k) => k !== i))} />
                  </div>
                ))}
                {!prices.length && <p className="meta">{t('aiUsage.prices.empty')}</p>}
              </div>
              <Button icon={Plus} onClick={() => setPrices([...prices, { id: '', input: '', output: '' }])}>{t('aiUsage.prices.add')}</Button>
              <div className="grid gap-4 sm:grid-cols-2 pt-2 border-t border-line">
                <Field label={t('aiUsage.prices.currency')} hint={t('aiUsage.prices.currencyHint')}>
                  <input className="input" maxLength={5} autoComplete="off" value={f.currency} onChange={(e) => { const currency = e.target.value.toUpperCase(); setF({ ...f, currency, rate: '' }) }} />
                </Field>
                {needsRate && (
                  <Field label={t('aiUsage.prices.rate', { from: cfg.ai_cost_currency, currency: costCurrency })} hint={t('aiUsage.prices.rateHint')}>
                    <input className="input" inputMode="decimal" required value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
                  </Field>
                )}
              </div>
            </Card>
          </Section>

          <FormError>{error}</FormError>
          <div><Button variant="primary" type="submit">{t('admin.save')}</Button></div>
        </form>
      )}

      <AiUsageAnalytics key={usageKey} />
      </div>
      {promptsSeen && <div className={tab === 'prompts' ? '' : 'hidden'}><AdminAiPrompts /></div>}
    </div>
  )
}
