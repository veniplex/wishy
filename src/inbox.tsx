import { ExternalLink, Inbox, Trash2 } from 'lucide-react'
import { fmtDateTime, t, useT } from './i18n'
import type { Item } from './lib'
import { PersonSelect } from './pickers'
import { useStore } from './store'
import { Badge, Banner, Button, IconButton, List, Row, Section, useConfirm } from './ui'

/** Ideas without a person (planning state: `inbox_items`). The server only returns them if it knows the inbox feature. */
export function useInboxItems(): Item[] {
  const { s } = useStore()
  return (s as unknown as { inbox_items?: Item[] }).inbox_items ?? []
}
/** Number of ideas in the inbox (for badge and home page) */
export const useInboxCount = () => useInboxItems().length

function InboxRow({ i }: { i: Item }) {
  useT()
  const { activePersons, call } = useStore()
  const confirm = useConfirm()
  const assign = (personId: number) => { if (personId) void call('POST', `/api/items/${i.id}/assign`, { person_id: personId }) }
  const remove = async () => {
    if (await confirm({ title: t('inbox.delete.title'), text: t('inbox.delete.text', { title: i.title }), confirmLabel: t('inbox.delete.confirm'), destructive: true })) void call('DELETE', `/api/items/${i.id}`)
  }
  const host = (() => { try { return i.url ? new URL(i.url).hostname.replace(/^www\./, '') : null } catch { return null } })()
  const meta = [i.notes?.split('\n')[0], host, fmtDateTime(i.created_at)].filter(Boolean).join(' · ')
  return (
    <Row
      dense
      title={i.title}
      titleSuffix={i.url ? <a href={i.url} target="_blank" rel="noopener noreferrer" aria-label={t('inbox.openLink')} className="hit pointer-coarse:!p-[0.95rem] pointer-coarse:!-m-[0.95rem] text-muted hover:text-accent"><ExternalLink size={14} /></a> : undefined}
      meta={meta}
      actions={
        <>
          <div className="w-52 max-w-full">
            <PersonSelect persons={activePersons.filter((p) => !p.is_me)} value={0} onChange={assign} placeholder={t('inbox.assign')} label={t('inbox.assignAria', { title: i.title })} />
          </div>
          <IconButton icon={Trash2} label={t('inbox.delete.label', { title: i.title })} onClick={() => void remove()} />
        </>
      }
    />
  )
}

/**
 * Inbox: ideas without a person (e.g. captured via shortcut/API). Assign via the person picker (incl. "+ New person").
 * Renders nothing while the inbox is empty. Intended for Gifting › Ideas (above the list).
 */
export function InboxSection() {
  useT()
  const items = useInboxItems()
  if (!items.length) return null
  return (
    <Section title={<span className="inline-flex items-center gap-2">{t('inbox.title')} <Badge tone="info">{items.length}</Badge></span>}>
      <p className="meta -mt-1">{t('inbox.sub')}</p>
      <List>{items.map((i) => <InboxRow key={i.id} i={i} />)}</List>
    </Section>
  )
}

/** Notice for the home page: "Inbox: assign n ideas" (only when n > 0) */
export function InboxNotice() {
  useT()
  const n = useInboxCount()
  if (!n) return null
  return (
    <Banner icon={Inbox} action={<Button size="sm" to="/gifting/ideas">{t('inbox.notice.action')}</Button>}>
      {t('inbox.notice.text', { count: n })}
    </Banner>
  )
}
