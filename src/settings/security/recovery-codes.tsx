import { useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import { useAuth } from '../../auth'
import { useUserX } from '../../account-types'
import { t, useT } from '../../i18n'
import { Button, Checkbox, Modal } from '../../ui'

/** Recovery codes - visible only once. Can only be closed after the "saved" confirmation. */
export function RecoveryCodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  useT()
  const { appName } = useAuth()
  const user = useUserX()
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = codes.join('\n')
  const copy = async () => {
    try { await navigator.clipboard.writeText(text) } catch { /* Zwischenablage gesperrt */ }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  const download = () => {
    const body = `${t('security.recovery.fileHead', { app: appName, email: user?.email ?? '' })}\n\n${text}\n`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    a.download = t('security.recovery.fileName')
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }
  return (
    <Modal
      title={t('security.recovery.dialogTitle')}
      onClose={() => { if (saved) onClose() }}
      footer={<><span className="flex-1" /><Button variant="primary" disabled={!saved} onClick={onClose}>{t('common.done')}</Button></>}
    >
      <p className="text-sm text-muted">{t('security.recovery.dialogText')}</p>
      <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label={t('security.recovery.title')}>
        {codes.map((c) => <li key={c} className="rounded-xl border border-line bg-soft px-3 py-2 text-center tracking-wider select-all">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button icon={copied ? Check : Copy} onClick={copy}>{copied ? t('security.recovery.copied') : t('security.recovery.copy')}</Button>
        <Button icon={Download} onClick={download}>{t('security.recovery.download')}</Button>
      </div>
      <Checkbox checked={saved} onChange={setSaved}>{t('security.recovery.saved')}</Checkbox>
    </Modal>
  )
}
