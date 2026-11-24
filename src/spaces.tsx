import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ChevronDown, Check, LogOut, Pencil, Plus, Trash2, UserMinus, Users } from 'lucide-react'
import { api, errMsg, spaceLabel, type Me, type Member, type SpaceInfo } from './api'
import { useAuth } from './auth'
import { t } from './i18n'
import { UserAvatar } from './user-avatar'
import { Badge, Button, CopyField, Field, FormError, IconButton, List, Modal, Row, Section, Thumb, useConfirm, useToast } from './ui'

/** Name input dialog (new space / rename) */
function NameDialog({ title, initial, submitLabel, onSubmit, onClose }: { title: string; initial: string; submitLabel: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await onSubmit(name.trim())
    } catch (err) {
      setError(errMsg(err))
    }
  }
  return (
    <form onSubmit={submit}>
      <Modal compact title={title} onClose={onClose} footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" disabled={!name.trim()}>{submitLabel}</Button></>}>
        <Field label={t('spaces.name')} error={error}>
          <input className="input" required autoFocus maxLength={80} placeholder={t('spaces.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Modal>
    </form>
  )
}

/** Members, invite link, rename and delete of a shared space */
export function MembersDialog({ space, onClose }: { space: SpaceInfo; onClose: () => void }) {
  const { user, applyMe, switchSpace, spaces } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()
  const owner = space.role === 'owner'
  const [members, setMembers] = useState<Member[] | null>(null)
  const [invite, setInvite] = useState('')
  const [error, setError] = useState('')
  const [renaming, setRenaming] = useState(false)

  const load = useCallback(() => api<Member[]>('GET', `/api/spaces/${space.id}/members`).then(setMembers).catch((e) => setError(errMsg(e))), [space.id])
  useEffect(() => { void load() }, [load])

  const afterLeave = (me: Me) => {
    applyMe(me)
    if (!me.spaces.some((s) => s.id === space.id)) {
      switchSpace(me.spaces.find((s) => s.personal)?.id ?? me.spaces[0].id)
      onClose()
    }
  }
  const removeMember = async (m: Member) => {
    const self = m.user_id === user?.id
    const ok = await confirm({
      title: self ? t('spaces.leaveTitle', { space: spaceLabel(space) }) : t('spaces.removeTitle', { name: m.name }),
      text: self ? t('spaces.leaveText') : t('spaces.removeText', { name: m.name }),
      confirmLabel: self ? t('spaces.leave') : t('spaces.remove'),
      destructive: true,
    })
    if (!ok) return
    try {
      const me = await api<Me>('DELETE', `/api/spaces/${space.id}/members/${m.user_id}`)
      if (self) afterLeave(me)
      else { applyMe(me); void load() }
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const createInvite = async () => {
    try {
      const r = await api<{ full_url: string }>('POST', `/api/spaces/${space.id}/invites`)
      setInvite(r.full_url)
    } catch (e) {
      setError(errMsg(e))
    }
  }
  const del = async () => {
    const ok = await confirm({ title: t('spaces.deleteTitle', { space: spaceLabel(space) }), text: t('spaces.deleteText'), confirmLabel: t('spaces.delete'), destructive: true })
    if (!ok) return
    try {
      afterLeave(await api<Me>('DELETE', `/api/spaces/${space.id}`))
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const current = spaces.find((s) => s.id === space.id) ?? space

  return (
    <>
      <Modal
        title={t('spaces.membersTitle', { space: current.name })}
        onClose={onClose}
        footer={
          <>
            {owner && <Button variant="danger" icon={Trash2} iconOnlyOnMobile onClick={del}>{t('spaces.delete')}</Button>}
            <span className="flex-1" />
            <Button onClick={onClose}>{t('common.done')}</Button>
          </>
        }
      >
        <Section title={t('spaces.members')} action={owner && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRenaming(true)}>{t('spaces.rename')}</Button>}>
          <List empty={<p className="text-sm text-muted">{members ? t('spaces.noMembers') : t('common.loading')}</p>}>
            {(members ?? []).map((m) => {
              const self = m.user_id === user?.id
              return (
                <Row
                  key={m.user_id}
                  dense
                  lead={<UserAvatar userId={m.user_id} name={m.name} size={32} />}
                  title={self ? t('controls.picker.meSuffix', { name: m.name }) : m.name}
                  meta={m.email}
                  trailing={m.role === 'owner' ? <Badge tone="accent">{t('spaces.owner')}</Badge> : undefined}
                  actions={
                    self
                      ? <IconButton icon={LogOut} size="sm" variant="danger" label={t('spaces.leaveAction')} onClick={() => removeMember(m)} />
                      : owner && <IconButton icon={UserMinus} size="sm" variant="danger" label={t('spaces.removeTitle', { name: m.name })} onClick={() => removeMember(m)} />
                  }
                />
              )
            })}
          </List>
        </Section>
        {current.permissions.invite_members && !current.personal && (
          <Section title={t('spaces.invite')}>
            <p className="text-sm text-muted">{t('spaces.inviteText')}</p>
            {invite ? <CopyField label={t('spaces.inviteLink')} value={invite} /> : <Button icon={Plus} onClick={createInvite}>{t('spaces.inviteCreate')}</Button>}
          </Section>
        )}
        <FormError>{error}</FormError>
      </Modal>
      {renaming && (
        <NameDialog
          title={t('spaces.renameTitle')}
          initial={current.name}
          submitLabel={t('common.save')}
          onClose={() => setRenaming(false)}
          onSubmit={async (name) => { applyMe(await api<Me>('PUT', `/api/spaces/${space.id}`, { name })); setRenaming(false) }}
        />
      )}
    </>
  )
}

/** Space picker as a dialog (sidebar and mobile menu) */
export function SpaceDialog({ onClose }: { onClose: () => void }) {
  const { spaces, spaceId, switchSpace, applyMe } = useAuth()
  const [members, setMembers] = useState<SpaceInfo | null>(null)
  const [creating, setCreating] = useState(false)
  const pick = (id: number) => {
    if (id !== spaceId) switchSpace(id)
    onClose()
  }
  return (
    <>
      <Modal
        title={t('spaces.switchTitle')}
        onClose={onClose}
        footer={<Button icon={Plus} onClick={() => setCreating(true)}>{t('spaces.new')}</Button>}
      >
        <p className="text-sm text-muted">{t('spaces.switchText')}</p>
        <List>
          {spaces.map((s) => (
            <Row
              key={s.id}
              lead={<Thumb tone={s.id === spaceId ? 'accent' : 'neutral'} icon={s.id === spaceId ? Check : Users} />}
              title={spaceLabel(s)}
              onClick={() => pick(s.id)}
              meta={s.personal ? t('spaces.onlyYou') : t('spaces.memberCount', { count: s.member_count })}
              trailing={s.id === spaceId ? <Badge tone="accent">{t('spaces.active')}</Badge> : undefined}
              actions={!s.personal && <Button size="sm" variant="ghost" icon={Users} onClick={() => setMembers(s)}>{t('spaces.membersAction')}</Button>}
            />
          ))}
        </List>
      </Modal>
      {members && <MembersDialog space={members} onClose={() => setMembers(null)} />}
      {creating && (
        <NameDialog
          title={t('spaces.new')}
          initial=""
          submitLabel={t('spaces.create')}
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            const before = new Set(spaces.map((s) => s.id))
            const me = applyMe(await api<Me>('POST', '/api/spaces', { name }))
            const created = me.spaces.find((s) => !before.has(s.id))
            if (created) switchSpace(created.id)
            setCreating(false)
            onClose()
          }}
        />
      )}
    </>
  )
}

/** Trigger in the top bar: shows the current space */
export function SpaceButton() {
  const { space } = useAuth()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="pill max-w-[38vw] sm:max-w-[16rem] max-sm:px-3 max-sm:gap-1" onClick={() => setOpen(true)} title={t('spaces.switchTitle')} aria-haspopup="dialog" aria-label={t('spaces.switchAria', { space: space?.name ?? '' })}>
        <span className="truncate">{space ? spaceLabel(space) : t('spaces.fallbackName')}</span>
        <ChevronDown size={16} strokeWidth={2.2} className="shrink-0" />
      </button>
      {open && <SpaceDialog onClose={() => setOpen(false)} />}
    </>
  )
}
