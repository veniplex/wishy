import { useCallback, useEffect, useState } from 'react'
import { api, errMsg, spaceLabel, type Member } from '../api'
import { useAuth } from '../auth'
import { PERMISSION_KEYS, type PermissionKey, type SpacePermissions } from '../lib'
import { t, useT, type TKey } from '../i18n'
import { useOnData } from '../offline/hooks'
import { Switch } from '../controls'
import { UserAvatar } from '../user-avatar'
import { Badge, Card, FormError, List, Row, Section, useToast } from '../ui'

/** One switch per permission (title + what it allows) */
function PermissionSwitches({ value, onChange, disabled }: { value: SpacePermissions; onChange: (key: PermissionKey, on: boolean) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {PERMISSION_KEYS.map((k) => (
        <Switch key={k} checked={!!value[k]} disabled={disabled} onChange={(on) => onChange(k, on)}>
          <span className="block font-medium">{t(`settings.space.perms.${k}` as TKey)}</span>
          <span className="block text-xs text-muted">{t(`settings.space.perms.${k}.hint` as TKey)}</span>
        </Switch>
      ))}
    </div>
  )
}

/**
 * Settings › Space › Members and permissions (owner of a shared space only): what each member may do, plus the permissions
 * that newly joining members start with. The owner always has all permissions and cannot be restricted.
 */
export function SpacePermissionsSection() {
  useT()
  const { space, user } = useAuth()
  const toast = useToast()
  const sid = space?.id
  const [members, setMembers] = useState<Member[] | null>(null)
  const [defaults, setDefaults] = useState<SpacePermissions | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (sid == null) return
    try {
      const [m, d] = await Promise.all([
        api<Member[]>('GET', `/api/spaces/${sid}/members`),
        api<{ permissions: SpacePermissions }>('GET', `/api/spaces/${sid}/default-permissions`),
      ])
      setMembers(m)
      setDefaults(d.permissions)
      setError('')
    } catch (e) {
      setError(errMsg(e))
    }
  }, [sid])
  useEffect(() => { setMembers(null); setOpen(null); void load() }, [load])
  useOnData(load)

  const setMember = async (m: Member, key: PermissionKey, on: boolean) => {
    try {
      setMembers(await api<Member[]>('PUT', `/api/spaces/${sid}/members/${m.user_id}/permissions`, { permissions: { [key]: on } }))
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }
  const setDefault = async (key: PermissionKey, on: boolean) => {
    try {
      setDefaults((await api<{ permissions: SpacePermissions }>('PUT', `/api/spaces/${sid}/default-permissions`, { permissions: { [key]: on } })).permissions)
    } catch (e) {
      toast(errMsg(e), 'bad')
    }
  }

  if (!space || space.personal || space.role !== 'owner') return null
  const others = (members ?? []).filter((m) => m.role !== 'owner')
  const given = (m: Member) => PERMISSION_KEYS.filter((k) => m.permissions?.[k]).length

  return (
    <>
      <Section title={t('settings.space.perms.title', { space: spaceLabel(space) })}>
        <Card className="space-y-3">
          <p className="text-sm text-muted">{t('settings.space.perms.sub')}</p>
          <List empty={<p className="text-sm text-muted">{members ? t('settings.space.perms.noMembers') : t('common.loading')}</p>}>
            {others.map((m) => (
              <Row
                key={m.user_id}
                dense
                lead={<UserAvatar userId={m.user_id} name={m.name} size={32} />}
                title={m.user_id === user?.id ? t('controls.picker.meSuffix', { name: m.name }) : m.name}
                meta={m.email}
                expanded={open === m.user_id}
                onClick={() => setOpen(open === m.user_id ? null : m.user_id)}
                trailing={<Badge tone={given(m) === PERMISSION_KEYS.length ? 'ok' : 'neutral'}>{t('settings.space.perms.count', { count: given(m), total: PERMISSION_KEYS.length })}</Badge>}
                below={open === m.user_id && m.permissions ? <div className="pt-1 pb-2"><PermissionSwitches value={m.permissions} onChange={(k, on) => void setMember(m, k, on)} /></div> : undefined}
              />
            ))}
          </List>
          <p className="text-xs text-muted">{t('settings.space.perms.ownerNote')}</p>
        </Card>
      </Section>
      <Section title={t('settings.space.perms.defaultsTitle')}>
        <Card className="space-y-3">
          <p className="text-sm text-muted">{t('settings.space.perms.defaultsSub')}</p>
          {defaults ? <PermissionSwitches value={defaults} onChange={(k, on) => void setDefault(k, on)} /> : <p className="text-sm text-muted">{t('common.loading')}</p>}
        </Card>
        <FormError>{error}</FormError>
      </Section>
    </>
  )
}
