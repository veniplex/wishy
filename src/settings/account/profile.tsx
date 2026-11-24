import { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { ApiError, api, errMsg, errorText, getSpaceId, type Me } from '../../api'
import { useUserX } from '../../account-types'
import { useAuth } from '../../auth'
import { t, useT } from '../../i18n'
import { Button, Card, FilePicker, Field, FormError, Section, useDesktopChrome, useToast } from '../../ui'
import { UserAvatar } from '../../user-avatar'
import { useSave } from './use-save'

const MAX_BYTES = 2 * 1024 * 1024
const TYPES = ['image/jpeg', 'image/png', 'image/webp']

/** Upload an image as multipart (POST /api/account/avatar); the JSON helper `api()` cannot send files. */
async function uploadAvatar(file: File) {
  const fd = new FormData()
  fd.append('avatar', file)
  let res: Response
  try {
    res = await fetch('/api/account/avatar', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'wishlist', ...(getSpaceId() != null ? { 'X-Space': String(getSpaceId()) } : {}) }, body: fd })
  } catch {
    throw new ApiError(t('errors.network'), 0)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(errorText(data?.code, data?.error, data?.params) || res.statusText, res.status, data?.code)
}

/** Account › Profile: name and profile picture (square display; shows the IdP picture as long as no custom one is set). */
export function ProfileSection() {
  useT()
  const { user, applyMe, refresh } = useAuth()
  const ux = useUserX()
  const toast = useToast()
  const desktop = useDesktopChrome()
  const [name, setName] = useState(user?.name ?? '')
  const { busy, error, submit } = useSave(async () => { applyMe(await api<Me>('PUT', '/api/account', { name })) })

  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [avBusy, setAvBusy] = useState(false)
  const [avError, setAvError] = useState('')
  useEffect(() => {
    if (!file) { setPreview(null); return }
    const u = URL.createObjectURL(file)
    setPreview(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  const pick = (f: File) => {
    setAvError('')
    if (!TYPES.includes(f.type)) return setAvError(t('account.profile.avatarRejected'))
    if (f.size > MAX_BYTES) return setAvError(t('account.profile.avatarTooBig'))
    setFile(f)
  }
  const save = async () => {
    if (!file) return
    setAvBusy(true)
    setAvError('')
    try {
      await uploadAvatar(file)
      await refresh()
      setFile(null)
      toast(t('account.profile.avatarSaved'), 'ok')
    } catch (e) {
      setAvError(errMsg(e))
    } finally {
      setAvBusy(false)
    }
  }
  const remove = async () => {
    setAvBusy(true)
    setAvError('')
    try {
      await api('DELETE', '/api/account/avatar')
      await refresh()
      toast(t('account.profile.avatarRemoved'), 'ok')
    } catch (e) {
      setAvError(errMsg(e))
    } finally {
      setAvBusy(false)
    }
  }
  const idp = ux?.identities?.find((i) => i.linked && i.picture_available)
  const shown = preview ?? ux?.avatar_url ?? null

  return (
    <Section title={t('account.profile.title')}>
      <Card className="space-y-5">
        <div className="flex flex-wrap items-center gap-4 md:gap-5">
          <div className="relative">
            <UserAvatar userId={user?.id ?? 0} name={user?.name ?? ''} src={shown} size={desktop ? 96 : 64} />
            {preview && <span className="absolute inset-0 rounded-full ring-2 ring-accent" aria-hidden />}
          </div>
          <div className="min-w-0 flex-1 basis-60 space-y-2">
            <div className="label">{t('account.profile.avatar')}</div>
            <div className="flex flex-wrap gap-2">
              {file ? (
                <>
                  <Button variant="primary" disabled={avBusy} onClick={save}>{t('common.save')}</Button>
                  <Button disabled={avBusy} onClick={() => setFile(null)}>{t('common.cancel')}</Button>
                </>
              ) : (
                <>
                  <FilePicker variant="button" icon={Upload} accept={TYPES.join(',')} label={ux?.avatar_url ? t('account.profile.avatarChange') : t('account.profile.avatarUpload')} disabled={avBusy} onFile={pick} />
                  {ux?.avatar_url && <Button variant="danger" disabled={avBusy} onClick={remove}>{t('account.profile.avatarRemove')}</Button>}
                </>
              )}
            </div>
            <p className="meta">{idp ? `${t('account.profile.avatarFromGoogle')} ` : ''}{t('account.profile.avatarHint')}</p>
            <FormError>{avError}</FormError>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4 border-t border-line pt-5">
          <Field label={t('account.profile.name')}><input className="input sm:max-w-sm" required autoComplete="name" enterKeyHint="done" autoCapitalize="words" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <FormError>{error}</FormError>
          <Button variant="primary" type="submit" disabled={busy || name.trim() === user?.name}>{t('common.save')}</Button>
        </form>
      </Card>
    </Section>
  )
}
