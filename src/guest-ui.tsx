/** The guest's side of the public list page: personal link, own reservations, name, "forget on this device", takeover into an account. */
import { useEffect, useState } from 'react'
import { Link2, Pencil, Share2, Undo2, UserRoundX } from 'lucide-react'
import { errMsg, type PublicView, type SharedWish } from './api'
import { forgetGuestKey, personalLink, publicApi, saveGuestName, savedGuestName, sharedUrl, takeOver, takeoverInfo } from './guest'
import { t } from './i18n'
import { Banner, Button, Card, CopyField, Field, FormError, Modal, useConfirm, useToast } from './ui'

const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function'

/** Shows the personal link (right after the first reservation, or on demand). A guest the server does not know yet is asked for a name first. */
export function PersonalLinkDialog({ token, view, intro, onView, onClose }: { token: string; view: PublicView; intro?: boolean; onView: (v: PublicView) => void; onClose: () => void }) {
  const [name, setName] = useState(savedGuestName())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const guest = view.guest
  const link = guest ? personalLink(token) : ''
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const v = await publicApi<PublicView>('POST', sharedUrl(token, '/guest'), token, { guest_name: name.trim() })
      saveGuestName(name.trim())
      onView(v)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const share = async () => {
    try { await navigator.share({ title: view.wishlist.title, text: t('wishlists.guestId.shareText', { title: view.wishlist.title }), url: link }) } catch { /* cancelled */ }
  }
  return (
    <Modal
      compact
      title={intro ? t('wishlists.guestId.reservedTitle') : t('wishlists.guestId.dialogTitle')}
      onClose={onClose}
      footer={guest ? <><span className="flex-1" />{canShare() && <Button icon={Share2} onClick={share}>{t('wishlists.guestId.share')}</Button>}<Button onClick={onClose}>{intro ? t('wishlists.guestId.later') : t('common.done')}</Button></> : (
        <><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>{t('wishlists.guestId.create')}</Button></>
      )}
    >
      {intro && <p className="text-sm text-muted">{t('wishlists.guestId.afterClaim')}</p>}
      {guest ? (
        <>
          {!intro && <p className="text-sm text-muted">{t('wishlists.guestId.dialogText')}</p>}
          <CopyField primary label={t('wishlists.guestId.label')} value={link} />
          <p className="meta">{t('wishlists.guestId.lost')}</p>
          <p className="meta">{t('wishlists.guestId.code', { code: guest.code })}</p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">{t('wishlists.guestId.dialogText')}</p>
          <Field label={t('wishlists.guest.name')} hint={t('wishlists.guestId.nameFirst')}>
            <input className="input" autoFocus maxLength={60} autoComplete="given-name" enterKeyHint="done" autoCapitalize="words" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) void create() }} />
          </Field>
          <FormError>{error}</FormError>
        </>
      )}
    </Modal>
  )
}

function RenameDialog({ token, current, onView, onClose }: { token: string; current: string; onView: (v: PublicView) => void; onClose: () => void }) {
  const toast = useToast()
  const [name, setName] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ok = !!name.trim() && !busy
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      onView(await publicApi<PublicView>('PUT', sharedUrl(token, '/guest'), token, { guest_name: name.trim() }))
      saveGuestName(name.trim())
      toast(t('wishlists.guestId.renamed'), 'ok')
      onClose()
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <Modal compact title={t('wishlists.guestId.renameTitle')} onClose={onClose} footer={<><span className="flex-1" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" disabled={!ok}>{t('common.save')}</Button></>}>
        <Field label={t('wishlists.guest.name')} hint={t('wishlists.guestId.renameHint')}>
          <input className="input" required autoFocus maxLength={60} autoComplete="given-name" enterKeyHint="done" autoCapitalize="words" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <FormError>{error}</FormError>
      </Modal>
    </form>
  )
}

/** Card after the list's header: the personal link, who you are, your own reservations, forget on this device */
export function GuestCard({ token, view, mine, busy, onRelease, onView, onReload }: {
  token: string
  view: PublicView
  mine: SharedWish[]
  busy: number | null
  onRelease: (w: SharedWish) => void
  onView: (v: PublicView) => void
  onReload: () => void
}) {
  const confirm = useConfirm()
  const toast = useToast()
  const [dialog, setDialog] = useState<'link' | 'name' | null>(null)
  const guest = view.guest
  const forget = async () => {
    if (!(await confirm({ title: t('wishlists.guestId.forgetTitle'), text: t('wishlists.guestId.forgetText'), confirmLabel: t('wishlists.guestId.forgetConfirm'), destructive: true }))) return
    forgetGuestKey(token)
    toast(t('wishlists.guestId.forgotten'), 'ok')
    onReload()
  }
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <p className="font-semibold flex items-center gap-2"><Link2 size={16} className="shrink-0 text-accent" aria-hidden />{t('wishlists.guestId.title')}</p>
          <p className="meta mt-0.5">{t('wishlists.guestId.text')}</p>
        </div>
        <Button size="sm" icon={Link2} className="max-sm:w-full" onClick={() => setDialog('link')}>{t('wishlists.guestId.save')}</Button>
      </div>
      {guest && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="min-w-0 break-words">{t('wishlists.guestId.actingAs', { name: guest.name, code: guest.code })}</span>
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setDialog('name')}>{t('wishlists.guestId.rename')}</Button>
        </div>
      )}
      {mine.length > 0 && (
        <div>
          <p className="meta font-semibold uppercase tracking-wide mb-1">{t('wishlists.guestId.mine')}</p>
          <ul className="divide-y divide-line">
            {mine.map((w) => (
              <li key={w.id} className="flex items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm" title={w.title}>{w.title}</span>
                <Button size="sm" variant="ghost" icon={Undo2} disabled={busy === w.id} onClick={() => onRelease(w)}>{t('wishlists.release')}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {guest && <div><Button size="sm" variant="link" icon={UserRoundX} onClick={() => void forget()}>{t('wishlists.guestId.forget')}</Button></div>}
      {dialog === 'link' && <PersonalLinkDialog token={token} view={view} onView={onView} onClose={() => setDialog(null)} />}
      {dialog === 'name' && guest && <RenameDialog token={token} current={guest.name} onView={onView} onClose={() => setDialog(null)} />}
    </Card>
  )
}

/** A signed-in user who made reservations as a guest in this browser: offer to take them over into the account */
export function TakeoverBanner({ token, onView }: { token: string; onView: (v: PublicView) => void }) {
  const toast = useToast()
  const [info, setInfo] = useState<{ claims: number } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void takeoverInfo(token).then((i) => setInfo(i && i.claims > 0 ? i : null)).catch(() => {}) }, [token])
  if (!info) return null
  const go = async () => {
    setBusy(true)
    try {
      onView(await takeOver(token))
      toast(t('wishlists.guestId.takenOver'), 'ok')
      setInfo(null)
    } catch (e) {
      toast(errMsg(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Banner icon={Link2} action={<Button size="sm" disabled={busy} onClick={() => void go()}>{t('wishlists.guestId.takeOver')}</Button>}>
      {t('wishlists.guestId.takeoverText', { count: info.claims })}
    </Banner>
  )
}
