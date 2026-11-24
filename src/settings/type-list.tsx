import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { t } from '../i18n'
import { ToggleLink, useDesktopChrome } from '../ui'

/**
 * Frame of the type lists in Settings › Space (occasion types, relationship types). Desktop: the full card as before. Phones: the long lists
 * stay behind one summary row (so members and permissions come first) and open on tap; per-row actions are limited to
 * hide/edit/delete, up/down arrows only appear in the "change order" mode (`reorder`).
 */
export function TypeListShell({ summary, canReorder, children }: {
  summary: string
  canReorder: boolean
  children: (o: { reorder: boolean; compact: boolean; head: ReactNode }) => ReactNode
}) {
  const desktop = useDesktopChrome()
  const [open, setOpen] = useState(false)
  const [reorder, setReorder] = useState(false)
  if (desktop) return <>{children({ reorder: true, compact: false, head: null })}</>
  if (!open) {
    return (
      <button type="button" className="card w-full min-h-14 px-4 py-3 flex items-center gap-3 text-left" aria-expanded={false} onClick={() => setOpen(true)}>
        <span className="flex-1 min-w-0 text-sm text-muted">{summary}</span>
        <span className="text-sm font-medium text-accent">{t('settings.space.list.open')}</span>
        <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
      </button>
    )
  }
  const head = (
    <div className="flex items-center justify-between gap-3">
      <ToggleLink chevron on onToggle={() => { setOpen(false); setReorder(false) }} labelOn={t('settings.space.list.close')} labelOff={t('settings.space.list.open')} />
      {canReorder && <ToggleLink on={reorder} onToggle={() => setReorder(!reorder)} labelOn={t('settings.space.list.reorderDone')} labelOff={t('settings.space.list.reorder')} />}
    </div>
  )
  return <>{children({ reorder, compact: true, head })}</>
}

