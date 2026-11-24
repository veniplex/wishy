import { useState } from 'react'
import { Upload } from 'lucide-react'
import { ApiError, api, errMsg, errorText, getSpaceId } from './api'
import { useReachable } from './offline/hooks'
import { t } from './i18n'
import { useStore } from './store'
import { Avatar, Button, FilePicker, FormError, useToast } from './ui'
import type { Person } from './lib'

const MAX_BYTES = 2 * 1024 * 1024
const TYPES = ['image/jpeg', 'image/png', 'image/webp']

/** Upload an image as multipart (POST /api/persons/:id/photo); the JSON helper `api()` cannot send files. */
async function uploadPhoto(id: number, file: File): Promise<string | null> {
  const fd = new FormData()
  fd.append('avatar', file)
  let res: Response
  try {
    res = await fetch(`/api/persons/${id}/photo`, { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'wishlist', ...(getSpaceId() != null ? { 'X-Space': String(getSpaceId()) } : {}) }, body: fd })
  } catch {
    throw new ApiError(t('errors.network'), 0)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(errorText(data?.code, data?.error, data?.params) || res.statusText, res.status, data?.code)
  return data.photo_url ?? null
}

/**
 * Photo of a person in the person form. Changes are saved at once (separate endpoint, not with the form's "Save"), and need a
 * connection; a new person has to be saved first. The photo replaces the emoji everywhere the avatar is shown.
 */
export function PersonPhotoField({ person, id }: { person: Partial<Person>; id: number | null }) {
  const { reload } = useStore()
  const toast = useToast()
  const online = useReachable()
  const [url, setUrl] = useState<string | null>(person.photo_url ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const canEdit = !!id && id > 0 && online
  const run = async (fn: () => Promise<string | null>, ok: string) => {
    setBusy(true)
    setError('')
    try {
      setUrl(await fn())
      await reload()
      toast(ok, 'ok')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const pick = (f: File) => {
    setError('')
    if (!TYPES.includes(f.type)) return setError(t('forms.person.photoRejected'))
    if (f.size > MAX_BYTES) return setError(t('forms.person.photoTooBig'))
    void run(() => uploadPhoto(id!, f), t('forms.person.photoSaved'))
  }
  const remove = () => run(async () => { await api('DELETE', `/api/persons/${id}/photo`); return null }, t('forms.person.photoRemoved'))
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Avatar p={{ ...(person as Person), id: id ?? 0, name: person.name ?? '', photo_url: url }} size={64} />
      <div className="min-w-0 flex-1 basis-52 space-y-2">
        <div className="flex flex-wrap gap-2">
          <FilePicker variant="button" icon={Upload} buttonClass="btn btn-sm" accept={TYPES.join(',')} label={url ? t('forms.person.photoChange') : t('forms.person.photoUpload')} disabled={!canEdit || busy} onFile={pick} />
          {url && <Button size="sm" variant="danger" disabled={!canEdit || busy} onClick={remove}>{t('forms.person.photoRemove')}</Button>}
        </div>
        <p className="meta">{!id || id < 0 ? t('forms.person.photoSaveFirst') : !online ? t('forms.person.photoOffline') : t('forms.person.photoHint')}</p>
        <FormError>{error}</FormError>
      </div>
    </div>
  )
}
