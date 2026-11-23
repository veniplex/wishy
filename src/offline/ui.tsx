/** Offline status in the header, sync dialog, sign-out with pending changes, "needs a connection" state. */
import { useEffect, useState, type ReactNode } from 'react'
import { CircleAlert, CloudOff, CloudUpload, RefreshCw, WifiOff, type LucideIcon } from 'lucide-react'
import { errorText, spaceLabel } from '../api'
import { useAuth } from '../auth'
import { fmtDate, fmtDateTime, fmtMoney, t, useT, type TKey } from '../i18n'
import { RELATION_GROUPS, joinNames, statusInfo, type OccasionType } from '../lib'
import { occasionTypeLabel } from '../store'
import { Badge, Banner, Button, EmptyState, List, Modal, Row, Section, useConfirm } from '../ui'
import { cachedState } from './engine'
import { useOffline } from './hooks'
import { canRecreate, chooseMine, chooseTheirs, discard, discardCount, kick, recreate, retry, syncNow } from './sync'
import type { FieldConflict, Op, Row as Data } from './types'

/** For areas that only work online (admin, API keys …) */
export const NeedsConnection = () => <EmptyState icon={WifiOff}>{t('offline.needsConnection')}</EmptyState>

// ───────────── Status ─────────────

function useStatus(): { icon: LucideIcon; text: string; spin?: boolean; warn?: boolean } | null {
  const { active, reachable, ops, syncing } = useOffline()
  if (!active) return null
  const attention = ops.filter((o) => o.status !== 'pending').length
  const waiting = ops.length - attention
  if (attention) return { icon: CircleAlert, text: t('offline.status.attention', { count: attention }), warn: true }
  if (!reachable) return { icon: CloudOff, text: waiting ? t('offline.status.offlineWaiting', { waiting: t('offline.status.waiting', { count: waiting }) }) : t('offline.status.offline') }
  if (syncing && waiting) return { icon: RefreshCw, text: t('offline.status.syncing'), spin: true }
  if (waiting) return { icon: CloudUpload, text: t('offline.status.waiting', { count: waiting }) }
  return null
}

/** Pill in the header, only when there is something to say; opens the sync dialog. */
export function OfflineStatus() {
  useT()
  const st = useStatus()
  const [open, setOpen] = useState(false)
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">{st?.text}</span>
      {st && (
        <button type="button" className={`pill sm:ml-auto max-sm:w-full max-sm:justify-center max-sm:min-h-10 max-sm:order-last ${st.warn ? '!bg-warn-soft !text-warn' : ''}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <st.icon size={16} strokeWidth={2.2} className={`shrink-0 ${st.spin ? 'animate-spin' : ''}`} />
          <span className="truncate">{st.text}</span>
        </button>
      )}
      {open && <SyncDialog onClose={() => setOpen(false)} />}
    </>
  )
}

// ───────────── Sync dialog ─────────────

const opTitle = (op: Op) => t(`offline.op.${op.kind}.${op.action}` as TKey, { name: op.label })
const fieldLabel = (unit: string) => t(`offline.field.${unit}` as TKey)

const DATES = new Set(['birthday', 'date', 'event_date', 'expected_at'])
const FLAGS = new Set(['archived', 'recurring', 'mentioned', 'excluded', 'settled'])
const MONEY = new Set(['price', 'budget', 'yearly_budget'])

/** A value in plain language; `s`: planning state of the op's space for names */
function valueText(op: Op, unit: string, value: Data, s: Data | null): string {
  const empty = t('offline.conflict.empty')
  const currency = s?.settings?.currency || 'EUR'
  const person = (id: number) => s?.persons.find((p: Data) => p.id === id)?.name ?? t('offline.conflict.unknown')
  const people = (ids: number[]) => (ids.length ? joinNames(ids.map(person)) : empty)
  if (unit === 'participants') {
    const names = value.audience === 'all' ? t('offline.conflict.everyone') : people(value.person_ids)
    return value.excluded_ids.length ? t('offline.conflict.without', { names, excluded: people(value.excluded_ids) }) : names
  }
  if (unit === 'payment') {
    if (value.payment_status !== 'paid') return t('forms.pay.unpaid')
    return [t('forms.pay.paid'), value.payer_id && person(value.payer_id), value.paid_amount != null && fmtMoney(value.paid_amount, currency), value.payment_method, value.paid_at && fmtDate(value.paid_at)].filter(Boolean).join(' · ')
  }
  const v = value[unit]
  if (unit === 'recipient_ids') return people(v)
  if (unit === 'givers') return v.length ? v.map((g: Data) => `${person(g.person_id)}${g.amount != null ? ` (${fmtMoney(g.amount, currency)})` : ''}`).join(', ') : empty
  if (FLAGS.has(unit)) return v ? t('offline.conflict.yes') : t('offline.conflict.no')
  if (v === null || v === undefined || v === '') return empty
  if (unit === 'person_id') return person(v)
  if (unit === 'occasion_id') return s?.occasions.find((o: Data) => o.id === v)?.name ?? t('offline.conflict.unknown')
  if (unit === 'item_id') return s?.items.find((i: Data) => i.id === v)?.title ?? t('offline.conflict.unknown')
  if (unit === 'type') return occasionTypeLabel((s?.occasion_types as OccasionType[] | undefined)?.find((x) => x.key === v), v)
  if (unit === 'relationship_group') return RELATION_GROUPS.find((g) => g.id === v)?.label ?? v
  if (unit === 'status') {
    if (op.kind === 'gift') return statusInfo(v).label
    return t(v === 'open' ? 'forms.open' : v === 'received' ? 'forms.wish.received' : v === 'done' ? 'forms.item.done' : 'forms.item.discarded')
  }
  if (unit === 'priority') return '★'.repeat(v)
  if (DATES.has(unit)) return fmtDate(v)
  if (MONEY.has(unit)) return fmtMoney(v, currency)
  return String(v)
}

/** The planning state an op belongs to (names of persons and occasions) */
function useOpState(op: Op) {
  const [s, setS] = useState<Data | null>(null)
  useEffect(() => {
    let alive = true
    if (op.space !== null) void cachedState(op.space).then((v) => { if (alive) setS(v) })
    return () => { alive = false }
  }, [op.space, op])
  return s
}

function FieldChoice({ op, f, s, busy, run }: { op: Op; f: FieldConflict; s: Data | null; busy: boolean; run: (fn: () => Promise<void>) => void }) {
  const label = fieldLabel(f.unit)
  const value = (title: string, v: Data) => (
    <div className="min-w-0 flex-1 basis-40 rounded-2xl bg-hover px-3.5 py-2.5">
      <div className="meta font-semibold">{title}</div>
      <div className="text-sm break-words whitespace-pre-wrap">{valueText(op, f.unit, v, s)}</div>
    </div>
  )
  return (
    <div role="group" aria-label={label} className="space-y-2">
      <div className="text-sm font-semibold">{label}</div>
      <div className="flex flex-wrap gap-2">
        {f.mine && value(t('offline.conflict.mine'), f.mine)}
        {value(t('offline.conflict.theirs'), f.theirs)}
      </div>
      {f.mine && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => chooseMine(op, f.unit))}>{t('offline.conflict.keepMine')}</Button>
          <Button size="sm" disabled={busy} onClick={() => run(() => chooseTheirs(op, f.unit))}>{t('offline.conflict.keepTheirs')}</Button>
        </div>
      )}
    </div>
  )
}

/** A change the user has to decide on: conflict or rejected by the server */
function AttentionItem({ op, meta }: { op: Op; meta: string }) {
  const s = useOpState(op)
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<void>) => {
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }
  const drop = () => run(async () => {
    const more = discardCount(op)
    const text = more ? t('offline.discard.textMore', { count: more }) : t('offline.discard.text')
    if (await confirm({ title: t('offline.discard.title'), text, confirmLabel: t('offline.discard'), destructive: true })) await discard(op)
  })
  const deleting = op.action === 'delete'
  const gone = op.conflict?.kind === 'gone'
  const reason = op.status === 'failed'
    ? errorText(op.error?.code, op.error?.error, op.error?.params) ?? t('errors.unknown')
    : gone ? t('offline.conflict.gone') : deleting ? t('offline.conflict.deleteChanged') : t('offline.conflict.changed')
  return (
    <div className="rounded-2xl border border-line p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium break-words">{opTitle(op)}</div>
          <div className="meta mt-0.5">{meta}</div>
        </div>
        <Badge tone={op.status === 'failed' ? 'bad' : 'warn'}>{t(`offline.state.${op.status}` as TKey)}</Badge>
      </div>
      <p className="text-sm">{reason}</p>
      {op.status === 'conflict' && op.conflict?.fields.map((f) => <FieldChoice key={f.unit} op={op} f={f} s={s} busy={busy} run={run} />)}
      <div className="flex flex-wrap gap-2 empty:hidden">
        {op.status === 'failed' && <Button size="sm" disabled={busy} onClick={() => run(() => retry(op))}>{t('common.retry')}</Button>}
        {op.status === 'conflict' && deleting && !gone && <Button size="sm" variant="destructive" disabled={busy} onClick={() => run(() => chooseMine(op, null))}>{t('offline.conflict.deleteAnyway')}</Button>}
        {op.status === 'conflict' && deleting && !gone && <Button size="sm" disabled={busy} onClick={() => run(() => discard(op))}>{t('offline.conflict.dontDelete')}</Button>}
        {op.status === 'conflict' && canRecreate(op) && <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => recreate(op))}>{t('offline.conflict.recreate')}</Button>}
        {(op.status === 'failed' || gone) && <Button size="sm" variant="danger" disabled={busy} onClick={drop}>{t('offline.discard')}</Button>}
      </div>
    </div>
  )
}

export function SyncDialog({ onClose }: { onClose: () => void }) {
  useT()
  const { reachable, ops, syncing, lastSync } = useOffline()
  const { spaces } = useAuth()
  const [busy, setBusy] = useState(false)
  const attention = ops.filter((o) => o.status !== 'pending')
  const pending = ops.filter((o) => o.status === 'pending')
  const meta = (op: Op) => {
    const space = spaces.length > 1 ? spaces.find((x) => x.id === op.space) : undefined
    return [space && spaceLabel(space), fmtDateTime(op.at)].filter(Boolean).join(' · ')
  }
  const now = () => {
    setBusy(true)
    void kick().then(syncNow).finally(() => setBusy(false))
  }
  const section = (title: string, children: ReactNode) => <Section title={<span className="text-lg">{title}</span>}>{children}</Section>
  return (
    <Modal
      title={t('offline.dialog.title')}
      onClose={onClose}
      footer={
        <>
          <span className="meta flex-1 min-w-0">{lastSync && t('offline.dialog.lastSync', { when: fmtDateTime(lastSync) })}</span>
          {(!reachable || pending.length > 0) && <Button icon={RefreshCw} disabled={busy || syncing} onClick={now}>{t('offline.dialog.syncNow')}</Button>}
        </>
      }
    >
      {!reachable && <Banner icon={CloudOff}>{t('offline.dialog.offline')}</Banner>}
      {reachable && !ops.length && <p className="text-sm text-muted">{t('offline.dialog.allSent')}</p>}
      {attention.length > 0 && section(t('offline.dialog.attention'), attention.map((op) => <AttentionItem key={op.seq} op={op} meta={meta(op)} />))}
      {pending.length > 0 && section(t('offline.dialog.pending'), (
        <List>{pending.map((op) => <Row key={op.seq} dense title={opTitle(op)} meta={meta(op)} trailing={<Badge>{t('offline.state.pending')}</Badge>} />)}</List>
      ))}
    </Modal>
  )
}

// ───────────── Signing out ─────────────

/** Asks before signing out with changes that were not sent yet */
export function LogoutDialog({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  const { ops, reachable } = useOffline()
  const [busy, setBusy] = useState(false)
  const sync = () => {
    setBusy(true)
    void kick().then(syncNow).finally(() => setBusy(false))
  }
  return (
    <Modal
      compact
      title={t('offline.logout.title')}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Button data-autofocus="" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="destructive" onClick={onConfirm}>{ops.length ? t('offline.logout.confirm') : t('nav.avatar.logout')}</Button>
        </>
      }
    >
      <p className="text-sm text-muted" role="status">{ops.length ? t('offline.logout.text', { count: ops.length }) : t('offline.dialog.allSent')}</p>
      {reachable && ops.length > 0 && <Button size="sm" icon={RefreshCw} disabled={busy} onClick={sync}>{t('offline.dialog.syncNow')}</Button>}
    </Modal>
  )
}
