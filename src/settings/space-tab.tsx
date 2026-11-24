import { useRef, useState } from 'react'
import { Check, Download, Upload } from 'lucide-react'
import { useStore } from '../store'
import { useAuth } from '../auth'
import { download, errMsg, spaceLabel } from '../api'
import { parseNum } from '../lib'
import { t } from '../i18n'
import { OccasionTypesSection } from './occasion-types'
import { RelationshipTypesSection } from './relationship-types'
import { SpacePermissionsSection } from './permissions'
import { Badge, Button, Card, Field, FilePicker, Section, Select, useConfirm, useToast } from '../ui'

/** Settings › Space: currency, annual budget, occasion types, members' permissions (owner), export/import of the current space */
export function SpaceTab() {
  const { s, call } = useStore()
  const { space } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()
  const [budget, setBudget] = useState(s.settings.yearly_budget == null ? '' : String(s.settings.yearly_budget))
  const [saved, setSaved] = useState(false)
  const timer = useRef<number>(0)
  const save = async (body: object) => {
    if (await call('PUT', '/api/settings', body)) {
      setSaved(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setSaved(false), 2000)
    }
  }
  const importFile = async (f: File | undefined) => {
    if (!f) return
    const spaceName = space ? spaceLabel(space) : t('settings.space.backup.fallbackSpace')
    const ok = await confirm({
      title: t('settings.space.backup.confirmTitle', { space: spaceName }),
      text: t('settings.space.backup.confirmText', { members: space && space.member_count > 1 ? t('settings.space.backup.confirmMembers', { count: space.member_count }) : '' }),
      confirmLabel: t('settings.space.backup.confirmAction'),
      destructive: true,
    })
    if (ok) {
      try {
        await call('POST', '/api/import', JSON.parse(await f.text()))
      } catch {
        await confirm({ title: t('settings.space.backup.failedTitle'), text: t('settings.space.backup.failedText'), cancelLabel: null })
      }
    }
  }
  return (
    <>
      <Section title={t('settings.space.budget.title')} action={saved ? <Badge tone="ok" icon={Check}>{t('common.saved')}</Badge> : undefined}>
        <Card className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={t('settings.space.budget.yearly')} hint={t('settings.space.budget.yearlyHint')}>
            <input className="input" inputMode="decimal" autoComplete="off" enterKeyHint="done" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={() => save({ yearly_budget: parseNum(budget) })} />
          </Field>
          <Field label={t('settings.space.budget.currency')}>
            <Select value={s.settings.currency} disabled={!s.permissions.manage_space_settings} onChange={(e) => save({ currency: e.target.value })}>
              {['EUR', 'CHF', 'USD', 'GBP'].map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
        </Card>
      </Section>
      <SpacePermissionsSection />
      <OccasionTypesSection />
      <RelationshipTypesSection />
      <Section title={t('settings.space.backup.title', { space: space ? spaceLabel(space) : '' })}>
        <Card className="space-y-3">
          <p className="text-sm text-muted">
            {t('settings.space.backup.text', { space: space ? spaceLabel(space) : '' })} <strong className="text-ink font-medium">{t('settings.space.backup.textStrong')}</strong>
            {space?.role === 'owner' ? '' : t('settings.space.backup.textOwnerOnly')}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button icon={Download} disabled={!s.permissions.view_expenses} onClick={() => download('/api/export', `wishy-${(space?.name ?? 'space').replace(/[^\w-]+/g, '_')}-${s.today}.json`).catch((e) => toast(errMsg(e), 'bad'))}>{t('settings.space.backup.export')}</Button>
            <FilePicker variant="button" icon={Upload} label={t('settings.space.backup.import')} accept="application/json,.json" onFile={(f) => importFile(f)} />
          </div>
        </Card>
      </Section>
    </>
  )
}
