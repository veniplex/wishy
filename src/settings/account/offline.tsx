import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { errMsg } from '../../api'
import { fmtDateTime, fmtNumber, t, useT } from '../../i18n'
import { clearDevice } from '../../offline/engine'
import { useOffline } from '../../offline/hooks'
import { isInstalled, isIos, useInstall } from '../../offline/install'
import { SyncDialog } from '../../offline/ui'
import { Button, Card, Section, useConfirm, useToast } from '../../ui'

/** Account › Offline & app: install, last sync, storage, remove the local data */
export function OfflineSection() {
  useT()
  const { active, ops, lastSync } = useOffline()
  const install = useInstall()
  const confirm = useConfirm()
  const toast = useToast()
  const [used, setUsed] = useState<number | null>(null)
  const [details, setDetails] = useState(false)
  useEffect(() => {
    let alive = true
    navigator.storage?.estimate?.().then((e) => { if (alive && e.usage != null) setUsed(e.usage) }).catch(() => {})
    return () => { alive = false }
  }, [lastSync, ops])

  const remove = async () => {
    const pending = ops.length ? `${t('offline.card.removePending', { count: ops.length })} ` : ''
    if (!(await confirm({ title: t('offline.card.removeTitle'), text: pending + t('offline.card.removeText'), confirmLabel: t('offline.card.removeConfirm'), destructive: true }))) return
    try {
      await clearDevice()
      toast(t('offline.card.removed'), 'ok')
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const fact = (label: string, value: string) => (
    <div className="min-w-0">
      <div className="meta font-semibold">{label}</div>
      <div className="text-sm mt-0.5">{value}</div>
    </div>
  )
  return (
    <Section title={t('offline.card.title')}>
      <Card className="space-y-4">
        <p className="text-sm text-muted">{active ? t('offline.card.text') : t('offline.card.unavailable')}</p>
        {!window.isSecureContext && <p className="text-sm text-warn">{t('offline.card.insecure')}</p>}
        {active && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {fact(t('offline.card.lastSync'), lastSync ? fmtDateTime(lastSync) : t('common.never'))}
            {used !== null && fact(t('offline.card.storage'), `${fmtNumber(used / 1_048_576, { maximumFractionDigits: 1 })} MB`)}
            {ops.length > 0 && fact(t('offline.card.waiting'), fmtNumber(ops.length))}
          </div>
        )}
        {isInstalled() ? <p className="meta">{t('offline.card.installed')}</p> : isIos() ? <p className="meta">{t('offline.card.ios')}</p> : null}
        <div className="flex flex-wrap gap-2 empty:hidden">
          {install && <Button variant="primary" icon={Download} onClick={() => void install()}>{t('offline.card.install')}</Button>}
          {active && ops.length > 0 && <Button onClick={() => setDetails(true)}>{t('offline.card.details')}</Button>}
          {active && <Button variant="danger" onClick={() => void remove()}>{t('offline.card.remove')}</Button>}
        </div>
      </Card>
      {details && <SyncDialog onClose={() => setDetails(false)} />}
    </Section>
  )
}
