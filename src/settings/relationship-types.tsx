import { useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useRelationshipTypes, useStore, type RelationshipTypeView } from '../store'
import { t, useT } from '../i18n'
import { Badge, Button, Card, Field, IconButton, List, Modal, Row, Section, Select, Thumb, useConfirm } from '../ui'

/** Create / rename dialog of a custom type (only the name) */
function TypeDialog({ type, onClose }: { type: RelationshipTypeView | null; onClose: () => void }) {
  const { call } = useStore()
  const [name, setName] = useState(type?.label ?? '')
  const [busy, setBusy] = useState(false)
  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    const body = { name: name.trim() }
    const ok = type ? await call('PUT', `/api/relationship-types/${type.id}`, body) : await call('POST', '/api/relationship-types', body)
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <form onSubmit={save}>
      <Modal
        title={type ? t('settings.space.rel.editTitle') : t('settings.space.rel.new')}
        onClose={onClose}
        footer={
          <>
            <span className="flex-1" />
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" type="submit" disabled={!name.trim() || busy}>{t('common.save')}</Button>
          </>
        }
      >
        <Field label={t('settings.space.rel.name')}>
          <input className="input" required autoFocus maxLength={60} placeholder={t('settings.space.rel.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Modal>
    </form>
  )
}

/** "Delete or merge": the type is in use – move its persons to another type first (or just hide it) */
function InUseDialog({ type, others, onClose }: { type: RelationshipTypeView; others: RelationshipTypeView[]; onClose: () => void }) {
  const { call } = useStore()
  const [target, setTarget] = useState((others.find((o) => o.key === 'other') ?? others[0])?.id ?? 0)
  const [busy, setBusy] = useState(false)
  const move = async () => {
    setBusy(true)
    const ok = await call('POST', `/api/relationship-types/${type.id}/merge`, { into_id: target })
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Modal
      compact
      title={t('settings.space.rel.inUse.title', { name: type.label })}
      onClose={onClose}
      footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button></>}
    >
      <p className="text-sm text-muted">{t('settings.space.rel.inUse.text', { count: type.usage })}</p>
      <Field label={t('settings.space.rel.inUse.target')}>
        <Select value={target} options={others.map((o) => ({ value: o.id, label: o.label }))} onChange={(e) => setTarget(Number(e.target.value))} />
      </Field>
      <Button variant="destructive" icon={Trash2} disabled={busy || !target} onClick={() => void move()}>{t('settings.space.rel.inUse.move')}</Button>
    </Modal>
  )
}

/**
 * Settings › Space: relationship types of this space (same logic as the occasion types). The built-in types are fixed: they can only
 * be hidden/shown; custom types can be renamed, hidden, merged and deleted (needs the `manage_persons` permission).
 */
export function RelationshipTypesSection() {
  const { s, call } = useStore()
  const types = useRelationshipTypes()
  const confirm = useConfirm()
  useT()
  const [edit, setEdit] = useState<RelationshipTypeView | 'new' | null>(null)
  const [inUse, setInUse] = useState<RelationshipTypeView | null>(null)
  const list = types.all
  const canManage = s.permissions.manage_persons

  const move = (i: number, dir: -1 | 1) => {
    const ids = list.map((x) => x.id)
    ;[ids[i], ids[i + dir]] = [ids[i + dir], ids[i]]
    void call('POST', '/api/relationship-types/reorder', { ids })
  }
  const remove = async (x: RelationshipTypeView) => {
    if (x.usage > 0) return setInUse(x)
    if (await confirm({ title: t('settings.space.rel.delete.title'), text: t('settings.space.rel.delete.text', { name: x.label }), confirmLabel: t('settings.space.rel.delete.confirm'), destructive: true })) {
      await call('DELETE', `/api/relationship-types/${x.id}`)
    }
  }

  return (
    <Section title={t('settings.space.rel.title')} action={canManage ? <Button size="sm" icon={Plus} onClick={() => setEdit('new')}>{t('settings.space.rel.new')}</Button> : undefined}>
      <Card className="space-y-3">
        <p className="text-sm text-muted">{t('settings.space.rel.sub')}{canManage ? ' ' + t('settings.space.rel.manageHint') : ''}</p>
        {!canManage && <p className="text-sm text-muted">{t('settings.space.rel.readOnly')}</p>}
        <List bare>
          {list.map((x, i) => (
            <Row
              key={x.id}
              dense
              dim={!!x.hidden}
              lead={<Thumb size={32} tone="accent" icon={Users} />}
              title={x.label}
              titleSuffix={<>
                {x.builtin_key && <Badge icon={Lock}>{t('settings.space.rel.default')}</Badge>}
                {x.hidden ? <Badge tone="warn">{t('settings.space.rel.hidden')}</Badge> : null}
              </>}
              meta={t('settings.space.rel.usage', { count: x.usage })}
              actions={canManage && (
                <>
                  <IconButton size="sm" icon={ArrowUp} label={t('settings.space.rel.up', { name: x.label })} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton size="sm" icon={ArrowDown} label={t('settings.space.rel.down', { name: x.label })} disabled={i === list.length - 1} onClick={() => move(i, 1)} />
                  {x.hidden
                    ? <IconButton size="sm" icon={Eye} label={t('settings.space.rel.show', { name: x.label })} onClick={() => void call('POST', `/api/relationship-types/${x.id}/show`)} />
                    : <IconButton size="sm" icon={EyeOff} label={t('settings.space.rel.hide', { name: x.label })} onClick={() => void call('POST', `/api/relationship-types/${x.id}/hide`)} />}
                  {!x.builtin_key && <IconButton size="sm" icon={Pencil} label={t('settings.space.rel.edit', { name: x.label })} onClick={() => setEdit(x)} />}
                  {!x.builtin_key && <IconButton size="sm" icon={Trash2} label={t('settings.space.rel.remove', { name: x.label })} onClick={() => void remove(x)} />}
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
