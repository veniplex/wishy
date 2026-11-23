import { useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useOccasionTypes, useStore, type OccasionTypeView } from '../store'
import { OccasionTypeIcon } from '../components'
import { occasionIconByName } from '../occasion-icons'
import { IconGrid } from '../pickers'
import { fmtIntl, monthNames, t, useT } from '../i18n'
import { Badge, Button, Card, Checkbox, Field, IconButton, List, Modal, Row, Section, Segmented, Select, Thumb, useConfirm } from '../ui'
import type { Audience } from '../lib'

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const pad = (n: number) => String(n).padStart(2, '0')
const fmtMonthDay = (md: string) => {
  const [m, d] = md.split('-').map(Number)
  return fmtIntl(new Date(2000, m - 1, d), { day: 'numeric', month: 'short' })
}

/** Create / edit dialog of a custom type: name, icon, optional default date, optional "repeats every year" default */
function TypeDialog({ type, onClose }: { type: OccasionTypeView | null; onClose: () => void }) {
  const { call } = useStore()
  const [name, setName] = useState(type?.label ?? '')
  const [icon, setIcon] = useState(type?.icon ?? 'calendar')
  const [month, setMonth] = useState(type?.default_month_day?.slice(0, 2) ?? '')
  const [day, setDay] = useState(type?.default_month_day?.slice(3, 5) ?? '')
  const [recurring, setRecurring] = useState(type ? !!type.default_recurring : false)
  const [audience, setAudience] = useState<Audience>(type?.default_audience ?? 'selected')
  const [busy, setBusy] = useState(false)
  const months = monthNames('long')
  const maxDay = month ? DAYS_IN_MONTH[Number(month) - 1] : 31
  const mdValue = () => (month ? `${month}-${pad(Math.min(Number(day || 1), maxDay))}` : null)

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    const body = { name: name.trim(), icon, default_month_day: mdValue(), default_recurring: recurring, default_audience: audience }
    const ok = type ? await call('PUT', `/api/occasion-types/${type.id}`, body) : await call('POST', '/api/occasion-types', body)
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <form onSubmit={save}>
      <Modal
        title={type ? t('settings.space.types.editTitle') : t('settings.space.types.new')}
        onClose={onClose}
        footer={
          <>
            <span className="flex-1" />
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={!name.trim() || busy}>{t('common.save')}</Button>
          </>
        }
      >
        <Field label={t('settings.space.types.name')}>
          <input className="input" required maxLength={60} placeholder={t('settings.space.types.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('settings.space.types.icon')} group>
          <IconGrid value={icon} onChange={setIcon} label={t('settings.space.types.icon')} />
        </Field>
        <Field label={t('settings.space.types.date')} hint={t('settings.space.types.dateHint')} group>
          <div className="grid grid-cols-2 gap-2">
            <Select
              aria-label={t('settings.space.types.day')} value={day} placeholder={t('settings.space.types.day')} disabled={!month}
              options={Array.from({ length: maxDay }, (_, i) => ({ value: pad(i + 1), label: String(i + 1) }))}
              onChange={(e) => setDay(e.target.value)}
            />
            <Select
              aria-label={t('settings.space.types.month')} value={month} placeholder={t('settings.space.types.noDate')}
              options={[{ value: '', label: t('settings.space.types.noDate') }, ...months.map((m, i) => ({ value: pad(i + 1), label: m }))]}
              onChange={(e) => { setMonth(e.target.value); if (e.target.value && !day) setDay('01'); if (!e.target.value) setDay('') }}
            />
          </div>
        </Field>
        <Field label={t('settings.space.types.audience')} hint={t('settings.space.types.audienceHint')} group>
          <Segmented<Audience> label={t('settings.space.types.audience')} value={audience} onChange={setAudience} options={[{ value: 'all', label: t('settings.space.types.audience.all') }, { value: 'selected', label: t('settings.space.types.audience.selected') }]} />
        </Field>
        <Checkbox checked={recurring} onChange={setRecurring}>{t('settings.space.types.recurring')}</Checkbox>
      </Modal>
    </form>
  )
}

/** "Delete or merge": the type is in use – move its occasions to another type first (or just hide it) */
function InUseDialog({ type, others, onClose }: { type: OccasionTypeView; others: OccasionTypeView[]; onClose: () => void }) {
  const { call } = useStore()
  const [target, setTarget] = useState((others.find((o) => o.key === 'other') ?? others[0])?.id ?? 0)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true)
    const ok = await fn()
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Modal
      compact
      title={t('settings.space.types.inUse.title', { name: type.label })}
      onClose={onClose}
      footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button></>}
    >
      <p className="text-sm text-muted">{t('settings.space.types.inUse.text', { count: type.usage })}</p>
      <Field label={t('settings.space.types.inUse.target')}>
        <Select
          value={target}
          options={others.map((o) => ({ value: o.id, label: o.label, icon: <OccasionTypeIcon icon={o.icon} /> }))}
          onChange={(e) => setTarget(Number(e.target.value))}
        />
      </Field>
      <Button variant="destructive" icon={Trash2} disabled={busy || !target} onClick={() => void run(() => call('POST', `/api/occasion-types/${type.id}/merge`, { into_id: target }))}>{t('settings.space.types.inUse.move')}</Button>
    </Modal>
  )
}

/**
 * Settings › Space: occasion types of this space. The built-in types are fixed (name, icon, date): they can only be hidden/shown;
 * custom types of the space can be edited, hidden, merged and deleted (needs the `manage_occasions` permission).
 */
export function OccasionTypesSection() {
  const { s, call } = useStore()
  const types = useOccasionTypes()
  const confirm = useConfirm()
  useT()
  const [edit, setEdit] = useState<OccasionTypeView | 'new' | null>(null)
  const [inUse, setInUse] = useState<OccasionTypeView | null>(null)
  const list = types.all
  const canManage = s.permissions.manage_occasions
  const visibleCount = list.filter((x) => !x.hidden).length

  const move = (i: number, dir: -1 | 1) => {
    const ids = list.map((x) => x.id)
    ;[ids[i], ids[i + dir]] = [ids[i + dir], ids[i]]
    void call('POST', '/api/occasion-types/reorder', { ids })
  }
  const remove = async (x: OccasionTypeView) => {
    if (x.usage > 0) return setInUse(x)
    if (await confirm({ title: t('settings.space.types.delete.title'), text: t('settings.space.types.delete.text', { name: x.label }), confirmLabel: t('settings.space.types.delete.confirm'), destructive: true })) {
      await call('DELETE', `/api/occasion-types/${x.id}`)
    }
  }

  return (
    <Section title={t('settings.space.types.title')} action={canManage ? <Button size="sm" icon={Plus} onClick={() => setEdit('new')}>{t('settings.space.types.new')}</Button> : undefined}>
      <Card className="space-y-3">
        <p className="text-sm text-muted">{t('settings.space.types.sub')}</p>
        {!canManage && <p className="text-sm text-muted">{t('settings.space.types.readOnly')}</p>}
        <List bare>
          {list.map((x, i) => (
            <Row
              key={x.id}
              dense
              dim={!!x.hidden}
              lead={<Thumb size={32} tone="accent" icon={occasionIconByName(x.icon)} />}
              title={x.label}
              titleSuffix={<>
                {x.builtin_key && <Badge icon={Lock}>{t('settings.space.types.default')}</Badge>}
                {x.hidden ? <Badge tone="warn">{t('settings.space.types.hidden')}</Badge> : null}
              </>}
              meta={[
                x.default_month_day ? fmtMonthDay(x.default_month_day) : null,
                x.default_recurring ? t('settings.space.types.yearly') : null,
                x.key === 'birthday' ? null : t(x.default_audience === 'all' ? 'settings.space.types.audience.all' : 'settings.space.types.audience.selected'),
                t('settings.space.types.usage', { count: x.usage }),
              ].filter(Boolean).join(' · ')}
              actions={canManage && (
                <>
                  <IconButton size="sm" icon={ArrowUp} label={t('settings.space.types.up', { name: x.label })} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton size="sm" icon={ArrowDown} label={t('settings.space.types.down', { name: x.label })} disabled={i === list.length - 1} onClick={() => move(i, 1)} />
                  {x.hidden
                    ? <IconButton size="sm" icon={Eye} label={t('settings.space.types.show', { name: x.label })} onClick={() => void call('POST', `/api/occasion-types/${x.id}/show`)} />
                    : <IconButton size="sm" icon={EyeOff} label={t('settings.space.types.hide', { name: x.label })} disabled={visibleCount <= 1} onClick={() => void call('POST', `/api/occasion-types/${x.id}/hide`)} />}
                  {!x.builtin_key && <IconButton size="sm" icon={Pencil} label={t('settings.space.types.edit', { name: x.label })} onClick={() => setEdit(x)} />}
                  {!x.builtin_key && <IconButton size="sm" icon={Trash2} label={t('settings.space.types.remove', { name: x.label })} disabled={!x.hidden && visibleCount <= 1} onClick={() => void remove(x)} />}
                </>
              )}
            />
          ))}
        </List>
      </Card>
      {edit && <TypeDialog type={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {inUse && <InUseDialog type={inUse} others={list.filter((o) => o.id !== inUse.id && !o.hidden)} onClose={() => setInUse(null)} />}
    </Section>
  )
}
