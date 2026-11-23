import { useCallback, useEffect, useState } from 'react'
import { Laptop, Smartphone } from 'lucide-react'
import { api, errMsg, isOffline } from '../../api'
import { useReachable } from '../../offline/hooks'
import { NeedsConnection } from '../../offline/ui'
import { fmtDateTime, t, useT } from '../../i18n'
import { Badge, Button, Card, EmptyState, Section, useConfirm, useToast } from '../../ui'

interface SessionInfo {
  id: string
  browser: string
  os: string
  device: string
  ip: string | null
  created_at: string
  last_seen_at: string
  current: boolean
}

/** Account › Sessions: devices, IP, last active; sign out individually or all others (GET /api/account/sessions). */
export function SessionsSection() {
  useT()
  const confirm = useConfirm()
  const toast = useToast()
  const [list, setList] = useState<SessionInfo[] | null>(null)
  const reachable = useReachable()
  const load = useCallback(() => api<SessionInfo[]>('GET', '/api/account/sessions').then(setList).catch((e) => { if (!isOffline(e)) toast(errMsg(e), 'bad') }), [toast])
  useEffect(() => { if (reachable) void load() }, [load, reachable])

  const revoke = async (s: SessionInfo) => {
    try {
      await api('DELETE', `/api/account/sessions/${encodeURIComponent(s.id)}`)
      toast(t('account.sessions.revoked'), 'ok')
      await load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const revokeOthers = async () => {
    if (!(await confirm({ title: t('account.sessions.revokeOthersTitle'), text: t('account.sessions.revokeOthersText'), confirmLabel: t('account.sessions.revokeOthers'), destructive: true }))) return
    try {
      await api('POST', '/api/account/sessions/revoke-others')
      toast(t('account.sessions.revokedOthers'), 'ok')
      await load()
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const others = (list ?? []).filter((s) => !s.current).length
  return (
    <Section
      title={t('account.sessions.title')}
      action={others > 0 ? <Button size="sm" onClick={revokeOthers}>{t('account.sessions.revokeOthers')}</Button> : undefined}
    >
      <p className="text-sm text-muted -mt-2">{t('account.sessions.sub')}</p>
      {!reachable && !list && <NeedsConnection />}
      {list && list.length === 0 && <EmptyState icon={Laptop}>{t('account.sessions.empty')}</EmptyState>}
      {(list ?? []).map((s) => {
        const mobile = /Android|iOS/.test(s.os)
        const Icon = mobile ? Smartphone : Laptop
        const device = s.device === 'Unknown' || s.device === 'Unbekannt' ? t('account.sessions.unknown') : s.device
        return (
          <Card key={s.id} pad="sm" className="flex flex-wrap items-center gap-3">
            <span className="grid place-items-center size-10 rounded-2xl bg-hover text-muted shrink-0"><Icon size={20} strokeWidth={1.75} /></span>
            <div className="flex-1 min-w-0 basis-52">
              <div className="font-medium flex flex-wrap items-center gap-2">{device} {s.current && <Badge tone="ok">{t('account.sessions.current')}</Badge>}</div>
              <p className="meta mt-0.5">{[s.ip, t('account.sessions.lastSeen', { when: fmtDateTime(s.last_seen_at) }), t('account.sessions.signedIn', { when: fmtDateTime(s.created_at) })].filter(Boolean).join(' · ')}</p>
            </div>
            {!s.current && <Button size="sm" aria-label={t('account.sessions.revokeAria', { device })} onClick={() => revoke(s)}>{t('account.sessions.revoke')}</Button>}
          </Card>
        )
      })}
    </Section>
  )
}
