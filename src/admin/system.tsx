import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, RefreshCw } from 'lucide-react'
import { api, errMsg, type AdminStats } from '../api'
import { fmtNumber, intlLocale, t, useT } from '../i18n'
import { Badge, Button, Card, Section, Stat, Stats, useToast } from '../ui'
import { SectionHead } from './shared'

export const fmtSize = (n: number) => (n > 1048576 ? `${fmtNumber(n / 1048576, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB` : `${fmtNumber(Math.max(1, Math.round(n / 1024)))} KB`)

interface Health { ok: boolean; version: string | null; ms: number | null }
const probe = async (path: string): Promise<Health> => {
  const t0 = performance.now()
  try {
    const res = await fetch(path, { cache: 'no-store' })
    const j = await res.json().catch(() => ({}))
    return { ok: res.ok, version: typeof j.version === 'string' ? j.version : null, ms: Math.round(performance.now() - t0) }
  } catch {
    return { ok: false, version: null, ms: null }
  }
}

function HealthRow({ label, h }: { label: string; h: Health | null }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0"><code className="font-mono text-sm">{label}</code></div>
      <div className="flex items-center gap-2 shrink-0">
        {h?.ms != null && <span className="meta num">{h.ms} ms</span>}
        {h == null ? <Badge>…</Badge> : h.ok ? <Badge tone="ok" icon={CircleCheck}>{t('adminSystem.health.ok')}</Badge> : <Badge tone="bad" icon={CircleAlert}>{t('adminSystem.health.fail')}</Badge>}
      </div>
    </div>
  )
}

/** Admin › System: version, key figures, health (/healthz, /readyz) */
export function AdminSystem() {
  useT()
  const toast = useToast()
  const [stats, setStats] = useState<(AdminStats & { version?: string }) | null>(null)
  const [live, setLive] = useState<Health | null>(null)
  const [ready, setReady] = useState<Health | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const load = useCallback(async () => {
    setLive(null)
    setReady(null)
    api<AdminStats & { version?: string }>('GET', '/api/admin/stats').then(setStats).catch((e) => toast(errMsg(e), 'bad'))
    const [l, r] = await Promise.all([probe('/healthz'), probe('/readyz')])
    setLive(l)
    setReady(r)
    setCheckedAt(new Date())
  }, [toast])
  useEffect(() => { void load() }, [load])
  const version = stats?.version ?? live?.version ?? ready?.version ?? null

  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t('admin.system.title')} sub={t('admin.system.sub')} actions={<Button icon={RefreshCw} onClick={() => void load()}>{t('adminSystem.refresh')}</Button>} />
      <Section title={t('adminSystem.version')}>
        <Card className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl display-num num">{version ? `v${version}` : '–'}</span>
          <span className="meta">{t('adminSystem.versionHint')}</span>
        </Card>
      </Section>
      <Section title={t('admin.system.stats')}>
        <Stats>
          <Stat label={t('admin.system.users')} value={stats?.users ?? '–'} />
          <Stat label={t('admin.system.spaces')} value={stats?.spaces ?? '–'} />
          <Stat label={t('admin.system.items')} value={stats?.items ?? '–'} />
          <Stat label={t('admin.system.gifts')} value={stats?.gifts ?? '–'} />
        </Stats>
        <p className="meta">{t('admin.system.dbSize', { size: stats ? fmtSize(stats.db_size_bytes) : '–' })}</p>
      </Section>
      <Section title={t('adminSystem.health.title')}>
        <Card className="divide-y divide-line !py-1">
          <HealthRow label="/healthz" h={live} />
          <HealthRow label="/readyz" h={ready} />
        </Card>
        <p className="meta">{t('adminSystem.health.hint')}{checkedAt ? ` ${t('adminSystem.health.checked', { time: checkedAt.toLocaleTimeString(intlLocale()) })}` : ''}</p>
      </Section>
    </div>
  )
}
