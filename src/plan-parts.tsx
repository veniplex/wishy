/**
 * Building blocks shared by the person page (per-occasion blocks) and the occasion page (per-person blocks):
 * a block card, its plan buttons, the "leave out" actions and grouping of lists by person.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { EyeOff, Lightbulb, MoreHorizontal, Plus, Users } from 'lucide-react'
import { useStore } from './store'
import { t } from './i18n'
import type { Gift, Occasion, Person } from './lib'
import { Avatar, Badge, Button, IconButton, Menu, MenuItem, useConfirm } from './ui'

/** Gifts that still count as planned for a person (returned ones do not) */
export const plannedGifts = (gifts: Gift[]) => gifts.filter((g) => g.status !== 'returned')

/** "Nothing planned yet" / "2 gifts" */
export function PlanBadge({ gifts }: { gifts: Gift[] }) {
  const n = plannedGifts(gifts).length
  return n ? <Badge tone="ok">{t('calendar.plan.gifts', { count: n })}</Badge> : <Badge tone="warn">{t('calendar.plan.nothing')}</Badge>
}

/** Card with a header (lead, title, meta, status, menu), an optional list body and an optional footer */
export function PlanBlock({ lead, title, to, meta, status, menu, dim, children, footer }: {
  lead: ReactNode
  title: ReactNode
  to?: string
  meta?: ReactNode
  status?: ReactNode
  menu?: ReactNode
  dim?: boolean
  children?: ReactNode
  footer?: ReactNode
}) {
  const tcls = 'font-display font-semibold text-lg leading-tight block max-sm:line-clamp-2 sm:truncate'
  const hasBody = Array.isArray(children) ? children.flat().some(Boolean) : !!children
  return (
    <section className="card overflow-hidden">
      <header className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 ${dim ? 'opacity-75' : ''}`}>
        <div className="shrink-0">{lead}</div>
        <div className="min-w-0 flex-[1_1_9rem]">
          {to ? <Link to={to} className={`${tcls} hover:text-accent`}>{title}</Link> : <div className={tcls}>{title}</div>}
          {meta && <div className="meta mt-0.5 truncate">{meta}</div>}
        </div>
        {(status || menu) && <div className="flex items-center gap-2 max-sm:basis-full max-sm:justify-between max-sm:pl-14 sm:ml-auto">{status}{menu}</div>}
      </header>
      {hasBody && <div className="list-bare border-t border-line">{children}</div>}
      {footer && <div className="px-5 py-3 border-t border-line flex flex-wrap items-center gap-2">{footer}</div>}
    </section>
  )
}

/** "Plan gift" / "Add idea" for a person in an occasion (both prefilled); nothing without permission */
export function PlanButtons({ personId, occasionId }: { personId: number; occasionId?: number }) {
  const { s, open } = useStore()
  if (!s.permissions.manage_gifts) return null
  return (
    <>
      <Button size="sm" icon={Plus} onClick={() => open({ type: 'gift', initial: { recipient_ids: [personId], occasion_id: occasionId } })}>{t('calendar.planGift')}</Button>
      <Button size="sm" icon={Lightbulb} onClick={() => open({ type: 'item', initial: { person_id: personId, occasion_id: occasionId } })}>{t('give.detail.newIdea')}</Button>
    </>
  )
}

/** Leave a person out of an occasion (confirm when gifts exist: they stay) or include them again */
export function useLeaveOut() {
  const { s, call, person } = useStore()
  const confirm = useConfirm()
  const put = (o: Occasion, pid: number, excluded: boolean) => call('PUT', `/api/occasions/${o.id}/persons/${pid}`, { excluded })
  return {
    can: s.permissions.manage_occasions,
    leave: async (o: Occasion, pid: number) => {
      const count = plannedGifts(s.gifts.filter((g) => g.occasion_id === o.id && g.recipient_ids.includes(pid))).length
      if (count && !(await confirm({ title: t('calendar.plan.leave.title'), text: t('calendar.plan.leave.text', { name: person(pid)?.name ?? '', count }), confirmLabel: t('calendar.plan.leave.confirm') }))) return
      await put(o, pid, true)
    },
    include: (o: Occasion, pid: number) => put(o, pid, false),
  }
}

/** Overflow menu of a block with the single "leave out" action */
export function LeaveMenu({ label, onLeave }: { label: string; onLeave: () => void }) {
  return (
    <Menu width={256} trigger={(p) => <IconButton icon={MoreHorizontal} label={t('calendar.plan.more')} {...p} />}>
      {(close) => <MenuItem icon={EyeOff} tint={4} label={label} onClick={() => { close(); onLeave() }} />}
    </Menu>
  )
}

export type PersonGroup<T> = { key: string; kind: 'person' | 'several' | 'none'; person?: Person; items: T[] }
/** Groups entries by person (alphabetical); entries for several persons and entries without a person follow as groups of their own */
export function groupByPerson<T>(list: T[], idsOf: (x: T) => number[], person: (id: number) => Person | undefined): PersonGroup<T>[] {
  const byPerson = new Map<number, T[]>()
  const several: T[] = []
  const none: T[] = []
  for (const x of list) {
    const ids = idsOf(x).filter((id) => person(id))
    if (ids.length > 1) several.push(x)
    else if (!ids.length) none.push(x)
    else byPerson.set(ids[0], [...(byPerson.get(ids[0]) ?? []), x])
  }
  const groups: PersonGroup<T>[] = [...byPerson]
    .map(([id, items]) => ({ key: `p${id}`, kind: 'person' as const, person: person(id), items }))
    .sort((a, b) => a.person!.name.localeCompare(b.person!.name, undefined, { sensitivity: 'base' }))
  if (several.length) groups.push({ key: 'several', kind: 'several', items: several })
  if (none.length) groups.push({ key: 'none', kind: 'none', items: none })
  return groups
}

/** Heading of a group: avatar + name linking to the person page (or a plain title for the special groups) */
export function GroupHeading({ group, count }: { group: PersonGroup<unknown>; count?: number }) {
  const p = group.person
  return (
    <div className="flex items-center gap-3 mb-3 min-w-0 min-h-8">
      {p ? <Avatar p={p} size={32} /> : <span className="size-8 rounded-full bg-hover text-muted grid place-items-center shrink-0"><Users size={16} aria-hidden /></span>}
      <h2 className="h3 text-lg min-w-0 truncate">
        {p ? <Link to={`/gifting/${p.id}`} className="hover:text-accent">{p.name}</Link> : group.kind === 'several' ? t('calendar.plan.group.several') : t('calendar.plan.group.none')}
      </h2>
      {count != null && <span className="meta">{count}</span>}
    </div>
  )
}
